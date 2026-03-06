import pg from 'pg';
import { encrypt, decrypt, isEncryptionEnabled } from './crypto.js';

const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIMENSIONS || '768', 10);
if (!Number.isFinite(EMBEDDING_DIM) || EMBEDDING_DIM < 1) {
  throw new Error(`Invalid EMBEDDING_DIMENSIONS: "${process.env.EMBEDDING_DIMENSIONS}" — must be a positive integer`);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  connectionTimeoutMillis: 5_000,
});
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});
pool.on('connect', (client) => {
  client.query('SET statement_timeout = 30000');
});

// Types
interface Thought {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  source: string;
  tags: string[];
  similarity?: number;
  created_at: string;
  updated_at?: string;
}

interface Stats {
  total_thoughts: number;
  with_embeddings: number;
  without_embeddings: number;
  earliest: string | null;
  latest: string | null;
  top_tags: { tag: string; count: number }[];
  sources: { source: string; count: number }[];
}

// --- Encryption helpers ---

function encryptContent(content: string, metadata: Record<string, unknown>): { encContent: string; encIv: string; encMeta: Record<string, unknown> } {
  if (!isEncryptionEnabled()) {
    return { encContent: content, encIv: '', encMeta: metadata };
  }
  const { ciphertext, iv } = encrypt(content);
  // Also encrypt metadata.summary if present
  const encMeta = { ...metadata };
  if (encMeta.summary && typeof encMeta.summary === 'string') {
    const sumEnc = encrypt(encMeta.summary);
    encMeta.summary = sumEnc.ciphertext;
    encMeta.summary_iv = sumEnc.iv;
  }
  return { encContent: ciphertext, encIv: iv, encMeta };
}

function decryptRow(row: Record<string, unknown>): Record<string, unknown> {
  if (!isEncryptionEnabled() || !row.content_iv) return row;
  const out = { ...row };
  try {
    out.content = decrypt(row.content as string, row.content_iv as string);
    // Decrypt metadata.summary if encrypted
    const meta = row.metadata ? { ...(row.metadata as Record<string, unknown>) } : {};
    if (meta.summary_iv && typeof meta.summary === 'string') {
      meta.summary = decrypt(meta.summary, meta.summary_iv as string);
      delete meta.summary_iv;
    }
    out.metadata = meta;
  } catch (e) {
    console.error(`Failed to decrypt thought ${row.id}:`, e);
    out.content = '[decryption failed]';
  }
  return out;
}

function decryptRows(rows: Record<string, unknown>[]): Thought[] {
  return rows.map(r => decryptRow(r)) as unknown as Thought[];
}

// Semantic search — direct query to get content_iv for decryption
export async function searchThoughts(
  embedding: number[],
  threshold: number = 0.3,
  limit: number = 10
): Promise<Thought[]> {
  const vectorStr = `[${embedding.join(',')}]`;
  const { rows } = await pool.query(
    `SELECT t.id, t.content, t.content_iv, t.metadata, t.source, t.tags,
            (1 - (t.embedding <=> $1::vector(${EMBEDDING_DIM})))::float AS similarity,
            t.created_at
     FROM thoughts t
     WHERE t.embedding IS NOT NULL
       AND 1 - (t.embedding <=> $1::vector(${EMBEDDING_DIM})) > $2
     ORDER BY t.embedding <=> $1::vector(${EMBEDDING_DIM})
     LIMIT $3`,
    [vectorStr, threshold, limit]
  );
  return decryptRows(rows);
}

// Browse recent thoughts with optional filters
export async function browseRecent(
  limit: number = 20,
  days?: number,
  source?: string
): Promise<Thought[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (days) {
    conditions.push(`created_at >= NOW() - make_interval(days => $${idx})`);
    params.push(days);
    idx++;
  }
  if (source) {
    conditions.push(`source = $${idx}`);
    params.push(source);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, content, content_iv, metadata, source, tags, created_at, updated_at
     FROM thoughts ${where}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    params
  );
  return decryptRows(rows);
}

// Insert a new thought
export async function captureThought(
  content: string,
  embedding: number[] | null,
  metadata: Record<string, unknown>,
  tags: string[],
  source: string
): Promise<Thought> {
  const { encContent, encIv, encMeta } = encryptContent(content, metadata);
  const vectorStr = embedding ? `[${embedding.join(',')}]` : null;
  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, content_iv, embedding, metadata, tags, source)
     VALUES ($1, $2, $3::vector(${EMBEDDING_DIM}), $4, $5, $6)
     RETURNING id, content, content_iv, metadata, source, tags, created_at, updated_at`,
    [encContent, encIv || null, vectorStr, JSON.stringify(encMeta), tags, source]
  );
  return decryptRows(rows)[0];
}

// Update an existing thought
export async function updateThought(
  id: string,
  content?: string,
  tags?: string[],
  embedding?: number[] | null
): Promise<Thought | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (content !== undefined) {
    const { encContent, encIv, encMeta } = encryptContent(content, { summary: content.slice(0, 100) });
    sets.push(`content = $${idx}`);
    params.push(encContent);
    idx++;
    sets.push(`content_iv = $${idx}`);
    params.push(encIv || null);
    idx++;
    const metaMerge: Record<string, unknown> = { summary: encMeta.summary };
    if (encMeta.summary_iv) metaMerge.summary_iv = encMeta.summary_iv;
    sets.push(`metadata = metadata || $${idx}::jsonb`);
    params.push(JSON.stringify(metaMerge));
    idx++;
  }
  if (tags !== undefined) {
    sets.push(`tags = $${idx}`);
    params.push(tags);
    idx++;
  }
  if (embedding !== undefined) {
    const vectorStr = embedding ? `[${embedding.join(',')}]` : null;
    sets.push(`embedding = $${idx}::vector(${EMBEDDING_DIM})`);
    params.push(vectorStr);
    idx++;
  }

  if (sets.length === 0) return null;

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE thoughts SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING id, content, content_iv, metadata, source, tags, created_at, updated_at`,
    params
  );
  if (rows.length === 0) return null;
  return decryptRows(rows)[0];
}

// Delete a thought by ID
export async function deleteThought(id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM thoughts WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

// Get database stats
export async function getStats(): Promise<Stats> {
  const [counts, topTags, sources] = await Promise.all([
    pool.query(`SELECT
      COUNT(*)::int AS total_thoughts,
      COUNT(embedding)::int AS with_embeddings,
      (COUNT(*) - COUNT(embedding))::int AS without_embeddings,
      MIN(created_at)::text AS earliest,
      MAX(created_at)::text AS latest
    FROM thoughts`),
    pool.query(`SELECT unnest(tags) AS tag, COUNT(*)::int AS count
      FROM thoughts GROUP BY tag ORDER BY count DESC LIMIT 10`),
    pool.query(`SELECT source, COUNT(*)::int AS count
      FROM thoughts GROUP BY source ORDER BY count DESC`),
  ]);
  return {
    ...counts.rows[0],
    top_tags: topTags.rows,
    sources: sources.rows,
  };
}

// Get thoughts missing embeddings (for re-embed job)
export async function getPendingEmbeddings(limit: number = 50): Promise<{ id: string; content: string }[]> {
  const { rows } = await pool.query(
    'SELECT id, content, content_iv FROM thoughts WHERE embedding IS NULL ORDER BY created_at ASC LIMIT $1',
    [limit]
  );
  // Decrypt content so embed() gets plaintext
  return rows.map((r: Record<string, unknown>) => {
    const dec = decryptRow(r);
    return { id: dec.id as string, content: dec.content as string };
  });
}

// Update just the embedding of a thought
export async function updateEmbedding(id: string, embedding: number[]): Promise<void> {
  const vectorStr = `[${embedding.join(',')}]`;
  await pool.query(`UPDATE thoughts SET embedding = $1::vector(${EMBEDDING_DIM}) WHERE id = $2`, [vectorStr, id]);
}

// Check DB connectivity (dedicated short-lived connection, avoids pool exhaustion)
export async function pingDb(): Promise<boolean> {
  let client: pg.Client | undefined;
  try {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3_000 });
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    client?.end().catch(() => {});
  }
}

// Graceful pool shutdown
export async function closePool(): Promise<void> {
  await pool.end();
}

// --- Migration helpers (used by index.ts on startup) ---

export async function ensureContentIvColumn(): Promise<void> {
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'thoughts' AND column_name = 'content_iv'
      ) THEN
        ALTER TABLE thoughts ADD COLUMN content_iv TEXT;
      END IF;
    END $$;
  `);
}

export async function getUnencryptedThoughts(): Promise<{ id: string; content: string; metadata: Record<string, unknown> }[]> {
  const { rows } = await pool.query(
    'SELECT id, content, metadata FROM thoughts WHERE content_iv IS NULL'
  );
  return rows;
}

export async function encryptExistingThought(id: string, encContent: string, encIv: string, encMeta: string): Promise<void> {
  await pool.query(
    'UPDATE thoughts SET content = $1, content_iv = $2, metadata = $3::jsonb WHERE id = $4',
    [encContent, encIv, encMeta, id]
  );
}

