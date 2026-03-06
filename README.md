<p align="center">
  <img src="assets/header.svg" alt="Braimory" width="400">
</p>

# Braimory

Self-hosted semantic memory for AI assistants via MCP (Model Context Protocol).

Store, search, and manage persistent thoughts with vector embeddings — fully local, zero cloud dependencies.

## What it does

- **Semantic search** across stored thoughts using cosine similarity
- **Automatic embeddings** via local Ollama (nomic-embed-text)
- **LLM metadata extraction** — auto-tags, categorizes, and summarizes thoughts
- **Encryption at rest** — optional AES-256-GCM for all stored content
- **OAuth 2.1 + PKCE** — browser-based auth for Claude Desktop and similar clients
- **API key auth** — simple header-based auth for Claude Code and CLI tools
- **Dual transport** — stdio (local pipe) and Streamable HTTP (network access)
- **Auto re-embed** — recovers embeddings after Ollama downtime

## Compatible clients

Any MCP-compatible client works:
- Claude Code
- Claude Desktop
- Cursor
- Windsurf
- Continue
- Any app speaking MCP over stdio or HTTP

## Prerequisites

- Docker and Docker Compose
- [Ollama](https://ollama.com) running locally with an embedding model pulled

## Quick start

```bash
# 1. Clone and enter the directory
git clone https://github.com/biofers/braimory.git
cd braimory

# 2. Pull the required Ollama models
ollama pull nomic-embed-text   # embeddings (vector search)
ollama pull llama3.2           # metadata extraction (auto-tags, summaries)

# 3. Create your .env
cp .env.example .env
# Edit .env — at minimum set BRAIMORY_DB_PASSWORD and MCP_ACCESS_KEY

# 4. Build and start
docker compose up -d --build

# 5. Verify
curl http://localhost:3100/health
# Should return: {"status":"ok","db":"connected","ollama":"connected"}
```

## Connection scenarios

Braimory supports two auth methods depending on the client:

| Client | Auth method | Needs public URL? | Needs HTTPS? |
|--------|-------------|-------------------|--------------|
| Claude Code / Cursor / CLI tools | API key (`x-brain-key` header) | No | No |
| Claude Desktop / browser-based | OAuth 2.1 + PKCE (login page) | **Yes** | **Yes** |

### Scenario A: Claude Code — same machine

The simplest setup. Braimory runs on the same machine as Claude Code.

**`.env` requires:** `BRAIMORY_DB_PASSWORD`, `MCP_ACCESS_KEY`

```bash
claude mcp add -t http -s user \
  -H "x-brain-key: YOUR_MCP_ACCESS_KEY" \
  braimory http://localhost:3100/mcp
```

### Scenario B: Claude Code — from another machine on LAN

Braimory runs on a server (e.g. `192.168.1.50`), Claude Code runs on your workstation. Both on the same network.

**`.env` requires:** same as Scenario A

```bash
claude mcp add -t http -s user \
  -H "x-brain-key: YOUR_MCP_ACCESS_KEY" \
  braimory http://192.168.1.50:3100/mcp
```

> No HTTPS needed — Claude Code connects directly from your machine.

### Scenario C: Claude Desktop / claude.ai — requires public HTTPS

This is the most powerful setup. Once configured, Braimory appears under your claude.ai account and is available across the **entire Claude ecosystem** — Claude Desktop, claude.ai web, Claude mobile, and Claude Code CLI. You'll see it listed as a `claude.ai` MCP server, accessible from any device where you're logged into Claude.

Claude Desktop does NOT connect directly from your machine — **Anthropic's servers** connect to your MCP endpoint. This means it must be publicly reachable over HTTPS. Plain HTTP or `localhost` will not work.

**Step 1: Expose your server with HTTPS** using one of:
- **Reverse proxy with SSL** (Nginx Proxy Manager, Caddy, Traefik) — point a domain to your server and terminate TLS
- **[Tailscale Funnel](https://tailscale.com/kb/1223/funnel)** — `tailscale funnel 3100` (provides HTTPS automatically)
- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)** — `cloudflared tunnel` (HTTPS via Cloudflare)

**Step 2: Configure `.env`:**
```bash
OAUTH_USERNAME=your_username
OAUTH_PASSWORD=a_strong_password
OAUTH_ISSUER_URL=https://brain.example.com   # your public HTTPS URL
TRUST_PROXY=true                              # if behind a reverse proxy
```

**Step 3: Add the MCP server in Claude Desktop:**

Open Claude Desktop → Settings → MCP Servers → Add → paste your URL:
```
https://brain.example.com/mcp
```

> Alternatively, you can edit `claude_desktop_config.json` manually, but the file location varies by OS and Claude Desktop may not pick up manual changes reliably. Using the UI is recommended.
>
> ```json
> {
>   "mcpServers": {
>     "braimory": {
>       "url": "https://brain.example.com/mcp"
>     }
>   }
> }
> ```

On first use, Claude Desktop will open your browser to the Braimory login page. This page IS the OAuth authorization flow — enter the `OAUTH_USERNAME` and `OAUTH_PASSWORD` from your `.env`. After login, a JWT token is issued and Claude uses it automatically for all future requests.

> **Do I still need `MCP_ACCESS_KEY`?** Yes — even with OAuth-only usage. It serves as the JWT signing secret. Without it (or with one shorter than 64 hex chars), the secret is randomly generated and **all OAuth tokens break on every container restart**. It also protects your public endpoint from unauthorized access outside OAuth.

> **Can I use A/B and C together?** Yes — both auth methods work simultaneously on the same server. Claude Code sends the API key header, Claude Desktop sends OAuth tokens. A common setup is both: Claude Code for CLI work + Claude Desktop for the full ecosystem.

> **Security trade-off**: Scenario C requires exposing a port to the public internet. Braimory includes OAuth 2.1 + PKCE, brute-force protection, constant-time credential checks, and optional encryption at rest — but no publicly exposed service is ever 100% secure. You are opening a door to your network. Evaluate whether the convenience of the full Claude ecosystem is worth the added attack surface for your setup. Scenarios A/B avoid this entirely by staying local.

### Scenario D: Stdio — local pipe (no HTTP)

Runs Braimory as a child process with no HTTP server — the MCP client communicates directly via stdin/stdout. Most users won't need this — Scenarios A/B/C cover typical setups. Stdio is mainly useful for:

- **Development and debugging** — test code changes without rebuilding the Docker image
- **Environments without Docker** — run the Node.js process directly when Docker isn't available or desired

Requires building the TypeScript manually and managing environment variables yourself.

```bash
cd mcp-server && npm install && npm run build && cd ..
claude mcp add -t stdio braimory -- node /path/to/mcp-server/dist/index.js --transport stdio
```

Set `DATABASE_URL` and optionally `OLLAMA_URL` as environment variables. No auth needed — stdio trusts the local pipe.

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_thoughts` | Semantic search by meaning (cosine similarity) |
| `browse_recent` | Chronological browsing with time/source filters |
| `capture_thought` | Store a new thought with auto-embedding and metadata |
| `update_thought` | Update content or tags (re-embeds automatically) |
| `delete_thought` | Permanently delete by UUID |
| `stats_overview` | Database statistics: counts, tags, sources, coverage |
| `import_memory_graph` | Import from MCP memory plugin knowledge graph |

## Configuration

All configuration is via environment variables in `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `BRAIMORY_DB_PASSWORD` | Yes | PostgreSQL password |
| `MCP_ACCESS_KEY` | Recommended | API key for MCP access (exactly 64 hex chars). If empty, all endpoints are open. Also used to derive the OAuth JWT secret — without it, tokens invalidate on restart |
| `ENCRYPTION_KEY` | No | AES-256 key for encryption at rest (exactly 64 hex chars). Any other length silently disables encryption |
| `OAUTH_USERNAME` | No | Username for OAuth login (both username and password must be set together) |
| `OAUTH_PASSWORD` | No | Password for OAuth login (both username and password must be set together) |
| `OLLAMA_URL` | No | Ollama API URL (default: `http://host.docker.internal:11434`) |
| `EMBEDDING_MODEL` | No | Ollama embedding model (default: `nomic-embed-text`) |
| `EMBEDDING_DIMENSIONS` | No | Embedding vector size (default: `768`) |
| `LLM_MODEL` | No | Ollama model for metadata extraction (default: `llama3.2`) |
| `MCP_HTTP_PORT` | No | HTTP server port (default: `3100`) |
| `DB_PORT` | No | Exposed PostgreSQL port (default: `5433`, commented out — uncomment in `docker-compose.yml` to enable) |
| `DB_POOL_SIZE` | No | PostgreSQL connection pool size (default: `10`) |
| `TRUST_PROXY` | No | Trust `X-Forwarded-For` for IP detection (default: `false`) |
| `OAUTH_ISSUER_URL` | No | Public URL for OAuth metadata discovery |

## Architecture

```
┌─────────────────┐     MCP (HTTP/stdio)     ┌──────────────────┐
│  Claude Code /   │ ◄─────────────────────► │  braimory-mcp    │
│  Claude Desktop  │                          │  (Node.js)       │
│  Cursor / etc.   │                          └───────┬──────────┘
└─────────────────┘                                   │
                                                      ├──► PostgreSQL + pgvector
                                                      └──► Ollama (embeddings + LLM)
```

## Security

- **API key auth** (Scenarios A/B): Claude Code sends `x-brain-key` header with every request — checked against `MCP_ACCESS_KEY`
- **OAuth 2.1 + PKCE** (Scenario C): Claude Desktop can't send custom headers, so it uses OAuth. The login page you see IS the OAuth authorization step — after login, a JWT token is issued and used automatically. Includes brute-force protection (per-IP rate limiting, global lockout after 50 failed attempts)
- **Encryption at rest**: Optional AES-256-GCM with per-field IV
- **Constant-time comparisons**: All credential checks use timing-safe operations
- **No cloud dependencies**: Everything runs locally
- **Redirect URI validation**: OAuth auto-registration only allows `localhost` and `claude.ai` redirects
- **Input size limits**: 50KB max per thought, 1MB max request body
- **Session limits**: Max 100 concurrent sessions, idle sessions purged after 30 minutes
- **Reverse proxy**: Set `TRUST_PROXY=true` only if behind a reverse proxy — this affects IP detection for rate limiting, never bypasses authentication

## Changing models

The default models work well for most use cases, but you can swap them.

### How to find a model's embedding dimensions

Every embedding model produces vectors of a fixed size. You need this number for `EMBEDDING_DIMENSIONS`. Three ways to find it:

**1. Check the model page on [ollama.com/library](https://ollama.com/library)** — search for the model, the description or tags will mention the dimension count.

**2. Ask Ollama directly** — after pulling the model, run:
```bash
ollama show nomic-embed-text
# Look for "embedding_length" in the parameters output
```

**3. Generate a test embedding and count** — quick and definitive:
```bash
curl -s http://localhost:11434/api/embed \
  -d '{"model":"nomic-embed-text","input":"test"}' | python3 -c "import sys,json; print(len(json.load(sys.stdin)['embeddings'][0]))"
# Output: 768
```

### Common embedding models

| Model | Dimensions | Size | Notes |
|-------|-----------|------|-------|
| `nomic-embed-text` (default) | 768 | ~274MB | Good balance of quality and speed |
| `all-minilm` | 384 | ~45MB | Smallest and fastest, lower quality |
| `mxbai-embed-large` | 1024 | ~670MB | Higher quality, slower |
| `snowflake-arctic-embed` | 1024 | ~670MB | Strong multilingual support |

### LLM models for metadata extraction

The `LLM_MODEL` is used to auto-tag and summarize thoughts. Any Ollama chat model works:

| Model | Size | Notes |
|-------|------|-------|
| `llama3.2` (default) | ~2GB | Fast, good quality |
| `mistral` | ~4GB | Strong reasoning |
| `phi3` | ~2.3GB | Compact, good for low-RAM systems |
| `gemma2` | ~5GB | Google's model, strong general quality |

### Switching the LLM model

Changing the LLM is simpler than the embedding model — no database changes needed:

```bash
# 1. Pull the new model
ollama pull mistral

# 2. Update .env
LLM_MODEL=mistral

# 3. Rebuild
docker compose down && docker compose up -d --build
```

New thoughts will use the new model for tagging and summarization. Existing thoughts keep their original metadata.

### Switching the embedding model

```bash
# 1. Pull the new model
ollama pull mxbai-embed-large

# 2. Check its dimensions
ollama show mxbai-embed-large   # look for embedding_length → 1024

# 3. Update .env
EMBEDDING_MODEL=mxbai-embed-large
EMBEDDING_DIMENSIONS=1024

# 4. Update init-db.sql — change VECTOR(768) to VECTOR(1024)
#    This only affects new databases. See step 6 for existing data.

# 5. Rebuild
docker compose down && docker compose up -d --build

# 6. Handle existing data (pick one):
#    Option A: Start fresh (easiest)
docker compose down -v   # WARNING: deletes all data
docker compose up -d --build

#    Option B: Keep data, re-embed (manual SQL)
docker exec -it braimory-db psql -U braimory -d braimory -c "
  ALTER TABLE thoughts DROP COLUMN embedding;
  ALTER TABLE thoughts ADD COLUMN embedding vector(1024);
"
#    Then restart — the re-embed job will regenerate all embeddings automatically
```

> **Important**: `EMBEDDING_DIMENSIONS` in `.env`, `VECTOR(...)` in `init-db.sql`, and the actual model output must all match. A mismatch will cause insert errors.

## Encryption

When `ENCRYPTION_KEY` is set:
- All thought content is encrypted with AES-256-GCM before storage
- Metadata summaries are also encrypted
- Embeddings remain unencrypted (required for vector search)
- Existing unencrypted thoughts are auto-migrated on startup

Generate a key: `openssl rand -hex 32`

## License

MIT
