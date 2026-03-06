import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import type { Request, Response } from 'express';
import { createServer } from './server.js';
import { embed, isOllamaHealthy } from './embeddings.js';
import { encrypt, isEncryptionEnabled } from './crypto.js';
import { createOAuthRouter, verifyBearerToken, setTrustProxy, safeEqual, oauthCleanupInterval } from './oauth.js';
import * as db from './db.js';

const PORT = parseInt(process.env.MCP_HTTP_PORT || '3100', 10);
const ACCESS_KEY = process.env.MCP_ACCESS_KEY || '';
const ISSUER_URL = process.env.OAUTH_ISSUER_URL || `http://localhost:${PORT}`;

// Graceful shutdown — drain connections before exit
import type { Server } from 'node:http';
let httpServer: Server | null = null;
const intervalIds: NodeJS.Timeout[] = [];
function setupShutdown(): void {
  const shutdown = () => {
    console.log('Shutting down gracefully...');
    for (const id of intervalIds) clearInterval(id);
    db.closePool().catch(() => {});
    if (httpServer) {
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 5000); // force after 5s
    } else {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
setupShutdown();

// --- DB migration: add content_iv column + encrypt existing rows ---
async function runMigrations(): Promise<void> {
  await db.ensureContentIvColumn();
  console.log('Migration: content_iv column ensured.');

  if (!isEncryptionEnabled()) {
    console.log('Migration: ENCRYPTION_KEY not set, skipping encryption of existing rows.');
    return;
  }

  const unencrypted = await db.getUnencryptedThoughts();
  if (unencrypted.length === 0) return;

  console.log(`Migration: encrypting ${unencrypted.length} existing thoughts...`);
  for (const row of unencrypted) {
    const { ciphertext, iv } = encrypt(row.content);
    // Also encrypt metadata.summary
    const meta = { ...row.metadata };
    if (meta.summary && typeof meta.summary === 'string') {
      const sumEnc = encrypt(meta.summary);
      meta.summary = sumEnc.ciphertext;
      meta.summary_iv = sumEnc.iv;
    }
    await db.encryptExistingThought(row.id, ciphertext, iv, JSON.stringify(meta));
  }
  console.log(`Migration: encrypted ${unencrypted.length} thoughts.`);
}

// --- Re-embed thoughts missing embeddings ---
async function reEmbed(): Promise<void> {
  const pending = await db.getPendingEmbeddings(50);
  if (pending.length === 0) return;
  console.log(`Re-embedding ${pending.length} thoughts...`);
  let ok = 0;
  for (const t of pending) {
    const vec = await embed(t.content);
    if (vec) {
      await db.updateEmbedding(t.id, vec);
      ok++;
    }
  }
  console.log(`Re-embedded ${ok}/${pending.length} thoughts.`);
}

// --- Transport selection ---
const transport = process.argv.includes('--transport') && process.argv[process.argv.indexOf('--transport') + 1];

// Run migrations before anything else
await runMigrations();

if (transport === 'stdio') {
  // stdio mode: single server instance, direct pipe
  const server = createServer();
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error('Braimory MCP running on stdio');

  // Re-embed on startup
  if (await isOllamaHealthy()) await reEmbed();
} else {
  // HTTP mode (default)
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const TRUST_PROXY = (process.env.TRUST_PROXY || '').toLowerCase() === 'true';

  // Configure proxy trust for OAuth rate limiting
  setTrustProxy(TRUST_PROXY);

  // Mount OAuth router before MCP routes
  app.use(createOAuthRouter(ISSUER_URL));
  intervalIds.push(oauthCleanupInterval);

  function checkAuth(req: Request): boolean {
    if (!ACCESS_KEY) return true;
    // Path 1: x-brain-key header (Claude Code, CLI tools)
    const headerKey = req.headers['x-brain-key'];
    if (typeof headerKey === 'string' && safeEqual(headerKey, ACCESS_KEY)) return true;
    // Path 2: Bearer token (Claude Desktop OAuth)
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && verifyBearerToken(authHeader, ISSUER_URL)) return true;
    return false;
  }

  function sendUnauthorized(res: Response): void {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${ISSUER_URL}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ error: 'Unauthorized' });
  }

  // Health endpoint (no auth)
  app.get('/health', async (_req, res) => {
    const [dbOk, ollamaOk] = await Promise.all([db.pingDb(), isOllamaHealthy()]);
    const status = dbOk ? 'ok' : 'degraded';
    res.status(dbOk ? 200 : 503).json({
      status,
      db: dbOk ? 'connected' : 'unreachable',
      ollama: ollamaOk ? 'connected' : 'unreachable',
    });
  });

  // Session storage for stateful MCP (with TTL tracking)
  const sessions: Record<string, StreamableHTTPServerTransport> = {};
  const sessionLastSeen: Record<string, number> = {};
  const SESSION_TTL = 30 * 60_000; // 30 min inactivity
  const MAX_SESSIONS = 100;

  // Purge stale sessions every 5 minutes
  intervalIds.push(setInterval(() => {
    const now = Date.now();
    for (const sid of Object.keys(sessionLastSeen)) {
      if (now - sessionLastSeen[sid] > SESSION_TTL) {
        try { sessions[sid]?.close?.(); } catch { /* ignore */ }
        delete sessions[sid];
        delete sessionLastSeen[sid];
      }
    }
  }, 5 * 60_000));

  // POST /mcp — handle MCP requests
  app.post('/mcp', async (req: Request, res: Response) => {
    if (!checkAuth(req)) {
      sendUnauthorized(res);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Existing session
    if (sessionId && sessions[sessionId]) {
      sessionLastSeen[sessionId] = Date.now();
      await sessions[sessionId].handleRequest(req, res, req.body);
      return;
    }

    // New session (must be initialize)
    if (!sessionId && isInitializeRequest(req.body)) {
      if (Object.keys(sessions).length >= MAX_SESSIONS) {
        res.status(503).json({ error: 'Too many active sessions — try again later' });
        return;
      }
      const sessionTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions[sid] = sessionTransport;
          sessionLastSeen[sid] = Date.now();
        },
      });

      sessionTransport.onclose = () => {
        if (sessionTransport.sessionId) {
          delete sessions[sessionTransport.sessionId];
          delete sessionLastSeen[sessionTransport.sessionId];
        }
      };

      const server = createServer();
      await server.connect(sessionTransport);
      await sessionTransport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ error: 'Bad request — send initialize first or include mcp-session-id header' });
  });

  // GET /mcp — SSE stream
  app.get('/mcp', async (req: Request, res: Response) => {
    if (!checkAuth(req)) {
      sendUnauthorized(res);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string;
    if (!sessionId || !sessions[sessionId]) {
      res.status(400).json({ error: 'Invalid or missing session' });
      return;
    }
    await sessions[sessionId].handleRequest(req, res);
  });

  // DELETE /mcp — terminate session
  app.delete('/mcp', async (req: Request, res: Response) => {
    if (!checkAuth(req)) {
      sendUnauthorized(res);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string;
    if (sessionId && sessions[sessionId]) {
      await sessions[sessionId].handleRequest(req, res);
    } else {
      res.status(400).json({ error: 'Invalid session' });
    }
  });

  httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Braimory MCP listening on http://0.0.0.0:${PORT}`);
  });
  httpServer.timeout = 120_000; // 2 min request timeout

  // Re-embed on startup + periodically (every 10 min)
  let reEmbedRunning = false;
  async function safeReEmbed(): Promise<void> {
    if (reEmbedRunning) return;
    reEmbedRunning = true;
    try {
      if (await isOllamaHealthy()) await reEmbed();
    } catch (e) {
      console.error('Re-embed cycle failed:', e);
    } finally {
      reEmbedRunning = false;
    }
  }
  await safeReEmbed();
  intervalIds.push(setInterval(safeReEmbed, 10 * 60_000));
}
