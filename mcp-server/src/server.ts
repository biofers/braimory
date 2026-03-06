import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { embed } from './embeddings.js';
import { extractMetadata } from './metadata.js';
import * as db from './db.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'braimory',
    version: '1.0.0',
  });

  // --- search_thoughts ---
  server.registerTool(
    'search_thoughts',
    {
      description: 'Semantic search across all stored thoughts by meaning. Returns the most similar thoughts ranked by cosine similarity.',
      inputSchema: z.object({
        query: z.string().describe('Natural language search query'),
        threshold: z.number().min(0).max(1).default(0.3).describe('Minimum similarity threshold (0-1)'),
        limit: z.number().int().min(1).max(50).default(10).describe('Max results to return'),
      }),
    },
    async ({ query, threshold, limit }) => {
      const embedding = await embed(query);
      if (!embedding) {
        return { content: [{ type: 'text' as const, text: 'Ollama unavailable — cannot perform semantic search. Try browse_recent instead.' }] };
      }
      const results = await db.searchThoughts(embedding, threshold, limit);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching thoughts found.' }] };
      }
      const text = results.map((r, i) =>
        `${i + 1}. [${(r.similarity! * 100).toFixed(1)}%] ${r.content}\n   ID: ${r.id} | Tags: ${r.tags.join(', ') || 'none'} | ${r.created_at}`
      ).join('\n\n');
      return { content: [{ type: 'text' as const, text: `Found ${results.length} thoughts:\n\n${text}` }] };
    }
  );

  // --- browse_recent ---
  server.registerTool(
    'browse_recent',
    {
      description: 'Browse recent thoughts chronologically, with optional filters by time range or source.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
        days: z.number().int().min(1).optional().describe('Only thoughts from last N days'),
        source: z.string().optional().describe('Filter by source (e.g. "mcp", "import")'),
      }),
    },
    async ({ limit, days, source }) => {
      const results = await db.browseRecent(limit, days, source);
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No thoughts found.' }] };
      }
      const text = results.map((r, i) =>
        `${i + 1}. ${r.content}\n   ID: ${r.id} | Tags: ${r.tags.join(', ') || 'none'} | Source: ${r.source} | ${r.created_at}`
      ).join('\n\n');
      return { content: [{ type: 'text' as const, text: `${results.length} recent thoughts:\n\n${text}` }] };
    }
  );

  // --- capture_thought ---
  server.registerTool(
    'capture_thought',
    {
      description: 'Store a new thought with automatic embedding and metadata extraction. Use this to remember facts, decisions, preferences, ideas, or any information worth keeping.',
      inputSchema: z.object({
        content: z.string().max(50_000).describe('The thought content to store (max 50KB)'),
        tags: z.array(z.string()).default([]).describe('Optional tags for categorization'),
        source: z.string().default('mcp').describe('Source identifier'),
      }),
    },
    async ({ content, tags, source }) => {
      // Extract metadata and embedding in parallel
      const [meta, embedding] = await Promise.all([
        extractMetadata(content),
        embed(content),
      ]);

      // Merge extracted topics into tags
      const allTags = [...new Set([...tags, ...meta.topics])];

      const thought = await db.captureThought(
        content,
        embedding,
        { people: meta.people, dates: meta.dates, type: meta.type, summary: meta.summary },
        allTags,
        source
      );

      const warnings: string[] = [];
      if (!embedding) warnings.push('Ollama unavailable — stored without embedding (will re-embed later).');

      return {
        content: [{
          type: 'text' as const,
          text: `Captured thought ${thought.id}\nTags: ${allTags.join(', ') || 'none'}\nType: ${meta.type}\nSummary: ${meta.summary}${warnings.length ? '\n\nWarnings:\n' + warnings.join('\n') : ''}`,
        }],
      };
    }
  );

  // --- stats_overview ---
  server.registerTool(
    'stats_overview',
    {
      description: 'Get statistics about the thought database: counts, date range, top tags, sources, and embedding coverage.',
      inputSchema: z.object({}),
    },
    async () => {
      const stats = await db.getStats();
      const text = [
        `Total thoughts: ${stats.total_thoughts}`,
        `With embeddings: ${stats.with_embeddings}`,
        `Without embeddings: ${stats.without_embeddings}`,
        `Date range: ${stats.earliest || 'n/a'} → ${stats.latest || 'n/a'}`,
        `\nTop tags:`,
        ...stats.top_tags.map(t => `  ${t.tag}: ${t.count}`),
        `\nSources:`,
        ...stats.sources.map(s => `  ${s.source}: ${s.count}`),
      ].join('\n');
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  // --- delete_thought ---
  server.registerTool(
    'delete_thought',
    {
      description: 'Permanently delete a thought by its UUID.',
      inputSchema: z.object({
        id: z.string().uuid().describe('UUID of the thought to delete'),
      }),
    },
    async ({ id }) => {
      const deleted = await db.deleteThought(id);
      return {
        content: [{
          type: 'text' as const,
          text: deleted ? `Deleted thought ${id}.` : `Thought ${id} not found.`,
        }],
      };
    }
  );

  // --- update_thought ---
  server.registerTool(
    'update_thought',
    {
      description: 'Update an existing thought. If content changes, the embedding is regenerated automatically.',
      inputSchema: z.object({
        id: z.string().uuid().describe('UUID of the thought to update'),
        content: z.string().max(50_000).optional().describe('New content (triggers re-embedding)'),
        tags: z.array(z.string()).optional().describe('Replace tags'),
      }),
    },
    async ({ id, content, tags }) => {
      let newEmbedding: number[] | null | undefined;
      if (content !== undefined) {
        newEmbedding = await embed(content);
      }

      const updated = await db.updateThought(id, content, tags, content !== undefined ? newEmbedding : undefined);
      if (!updated) {
        return { content: [{ type: 'text' as const, text: `Thought ${id} not found.` }] };
      }

      const warnings: string[] = [];
      if (content && !newEmbedding) warnings.push('Ollama unavailable — embedding cleared (will re-embed later).');

      return {
        content: [{
          type: 'text' as const,
          text: `Updated thought ${updated.id}.\nContent: ${updated.content.slice(0, 100)}...\nTags: ${updated.tags.join(', ') || 'none'}${warnings.length ? '\n\nWarnings:\n' + warnings.join('\n') : ''}`,
        }],
      };
    }
  );

  // --- import_memory_graph ---
  server.registerTool(
    'import_memory_graph',
    {
      description: 'Import entities and relations from the MCP memory plugin knowledge graph into Braimory thoughts. Handles deduplication via semantic similarity.',
      inputSchema: z.object({
        entities: z.array(z.object({
          name: z.string(),
          entityType: z.string(),
          observations: z.array(z.string()),
        })).max(500).describe('Entities from memory plugin read_graph (max 500)'),
        relations: z.array(z.object({
          from: z.string(),
          to: z.string(),
          relationType: z.string(),
        })).max(2000).describe('Relations from memory plugin read_graph (max 2000)'),
        source_device: z.string().describe('Device name (e.g. "laptop", "server")'),
        imported_at: z.string().describe('ISO timestamp of the export moment'),
      }),
    },
    async ({ entities, relations, source_device, imported_at }) => {
      const source = `import:memory:${source_device}`;
      let created = 0;
      let merged = 0;
      let failed = 0;

      // Build relation lookup: entity name → relations
      const relMap = new Map<string, { to: string; type: string }[]>();
      for (const r of relations) {
        if (!relMap.has(r.from)) relMap.set(r.from, []);
        relMap.get(r.from)!.push({ to: r.to, type: r.relationType });
      }

      for (const entity of entities) {
        try {
          // Build content text
          const entityRels = relMap.get(entity.name) || [];
          const lines = [
            `[${entity.entityType}: ${entity.name}]`,
            ...entity.observations.map(o => `- ${o}`),
          ];
          if (entityRels.length > 0) {
            lines.push(`Relations: ${entityRels.map(r => `${r.type} → ${r.to}`).join(', ')}`);
          }
          const content = lines.join('\n');

          // Generate embedding for dedup check
          const embedding = await embed(content);

          // Check for duplicates (similarity > 0.85)
          if (embedding) {
            const existing = await db.searchThoughts(embedding, 0.85, 1);
            if (existing.length > 0) {
              // Merge: append new observations that aren't already present
              const match = existing[0];
              const existingLines = new Set(match.content.split('\n'));
              const newObs = entity.observations.filter(o => !existingLines.has(`- ${o}`));

              if (newObs.length > 0) {
                // Append new observations before Relations line
                const matchLines = match.content.split('\n');
                const relIdx = matchLines.findIndex(l => l.startsWith('Relations:'));
                const insertAt = relIdx >= 0 ? relIdx : matchLines.length;
                matchLines.splice(insertAt, 0, ...newObs.map(o => `- ${o}`));
                const updatedContent = matchLines.join('\n');

                const newEmbed = await embed(updatedContent);
                await db.updateThought(match.id, updatedContent, undefined, newEmbed);
              }
              merged++;
              continue;
            }
          }

          // Build tags from entityType + name + observation keywords
          const tags = [
            entity.entityType.toLowerCase(),
            entity.name.toLowerCase(),
          ];

          // Build metadata
          const meta: Record<string, unknown> = {
            type: 'reference',
            original_entity: { name: entity.name, entityType: entity.entityType },
            original_relations: entityRels,
            imported_from: source_device,
            imported_at,
            summary: `${entity.entityType} ${entity.name}: ${entity.observations.slice(0, 3).join('; ')}`,
          };

          await db.captureThought(content, embedding, meta, tags, source);
          created++;
        } catch (e) {
          console.error(`Failed to import entity ${entity.name}:`, e);
          failed++;
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Import complete from ${source_device}:\n- Created: ${created}\n- Merged: ${merged}\n- Failed: ${failed}\n- Total entities: ${entities.length}\n- Total relations: ${relations.length}`,
        }],
      };
    }
  );

  return server;
}
