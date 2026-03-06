// OAuth 2.1 + PKCE for Claude Desktop remote MCP

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, json, urlencoded } from 'express';
import type { Request, Response } from 'express';

// --- Config ---
const OAUTH_USERNAME = process.env.OAUTH_USERNAME || '';
const OAUTH_PASSWORD = process.env.OAUTH_PASSWORD || '';
const JWT_SECRET = (() => {
  const hex = process.env.MCP_ACCESS_KEY || '';
  return hex.length === 64 ? Buffer.from(hex, 'hex') : randomBytes(32);
})();
const ACCESS_TOKEN_TTL = 3600;        // 1h
const REFRESH_TOKEN_TTL = 30 * 86400; // 30d
const AUTH_CODE_TTL = 300;            // 5min

// --- Base64url ---
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlEncode(str: string): string {
  return b64url(Buffer.from(str, 'utf8'));
}
function b64urlDecode(str: string): string {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// --- JWT HMAC-SHA256 ---
function signJwt(payload: Record<string, unknown>): string {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = b64url(createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest());
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body));
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- PKCE S256 ---
function verifyPkce(verifier: string, challenge: string): boolean {
  return b64url(createHash('sha256').update(verifier).digest()) === challenge;
}

// --- Constant-time string comparison (safe for unequal lengths) ---
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// --- HTML escape ---
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- In-memory stores ---
interface OAuthClient { name: string; redirect_uris: string[]; created_at: number }
interface AuthCode { client_id: string; redirect_uri: string; code_challenge: string; expires_at: number }
interface RefreshEntry { client_id: string; expires_at: number }

const clients = new Map<string, OAuthClient>();
const authCodes = new Map<string, AuthCode>();
const refreshTokens = new Map<string, RefreshEntry>();

// --- Brute force protection ---
const RATE_WINDOW = 15 * 60_000;       // 15 min
const MAX_ATTEMPTS_PER_IP = 5;         // per window
const IP_BLOCK_DURATION = 60 * 60_000; // 1h ban
const GLOBAL_MAX_FAILS = 50;           // total fails before lockout
const GLOBAL_LOCKOUT_DURATION = 15 * 60_000; // 15 min lockout
const MAX_REGISTRATIONS_PER_IP_HOUR = 5;

const failedAttempts = new Map<string, { count: number; windowStart: number }>();
const blockedIps = new Map<string, number>(); // ip -> unblock timestamp
let globalFailCount = 0;
let globalFailWindowStart = Date.now();
let globalLockoutUntil = 0;
const registrationCounts = new Map<string, { count: number; windowStart: number }>();

let trustProxy = false;
export function setTrustProxy(value: boolean): void { trustProxy = value; }

function getClientIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded : undefined)?.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.ip || 'unknown';
}

function isBlocked(ip: string): string | null {
  // Global lockout
  if (Date.now() < globalLockoutUntil) return 'Service temporarily locked due to excessive failed attempts';
  // Per-IP block
  if (blockedIps.has(ip) && Date.now() < blockedIps.get(ip)!) return 'Too many failed attempts — try again later';
  // Per-IP rate limit
  const record = failedAttempts.get(ip);
  if (record && Date.now() - record.windowStart < RATE_WINDOW && record.count >= MAX_ATTEMPTS_PER_IP) {
    blockedIps.set(ip, Date.now() + IP_BLOCK_DURATION);
    console.log(`OAuth: BLOCKED IP ${ip} for 1h (${record.count} failed attempts)`);
    return 'Too many failed attempts — try again later';
  }
  return null;
}

function recordFailure(ip: string): void {
  // Per-IP
  const record = failedAttempts.get(ip);
  if (!record || Date.now() - record.windowStart > RATE_WINDOW) {
    failedAttempts.set(ip, { count: 1, windowStart: Date.now() });
  } else {
    record.count++;
  }
  // Global
  if (Date.now() - globalFailWindowStart > RATE_WINDOW) {
    globalFailCount = 0;
    globalFailWindowStart = Date.now();
  }
  globalFailCount++;
  if (globalFailCount >= GLOBAL_MAX_FAILS) {
    globalLockoutUntil = Date.now() + GLOBAL_LOCKOUT_DURATION;
    console.log(`OAuth: GLOBAL LOCKOUT for 15min (${globalFailCount} total failures)`);
  }
  console.log(`OAuth: failed login from ${ip} (attempt ${failedAttempts.get(ip)!.count}, global ${globalFailCount})`);
}

// Cleanup expired entries hourly (exported for shutdown tracking)
export const oauthCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCodes) if (v.expires_at < now) authCodes.delete(k);
  for (const [k, v] of refreshTokens) if (v.expires_at < now) refreshTokens.delete(k);
  for (const [k, v] of blockedIps) if (v < now) blockedIps.delete(k);
  for (const [k, v] of failedAttempts) if (now - v.windowStart > RATE_WINDOW) failedAttempts.delete(k);
  for (const [k, v] of registrationCounts) if (now - v.windowStart > 3_600_000) registrationCounts.delete(k);
  // Evict clients older than 24h with no active refresh tokens
  const clientTTL = 24 * 3_600_000;
  const activeClients = new Set([...refreshTokens.values()].map(r => r.client_id));
  for (const [k, v] of clients) {
    if (now - v.created_at > clientTTL && !activeClients.has(k)) clients.delete(k);
  }
}, 3_600_000);

// --- Exported: verify Bearer token ---
export function verifyBearerToken(authHeader: string, expectedIssuer?: string): boolean {
  if (!authHeader.startsWith('Bearer ')) return false;
  const payload = verifyJwt(authHeader.slice(7));
  if (!payload) return false;
  if (expectedIssuer && payload.iss !== expectedIssuer) return false;
  if (payload.scope !== 'mcp') return false;
  return true;
}

// --- Router factory ---
export function createOAuthRouter(issuerUrl: string): Router {
  const router = Router();

  // CORS — restricted to known OAuth clients
  const ALLOWED_ORIGINS = ['https://claude.ai', 'http://localhost', 'http://127.0.0.1'];
  router.use((req: Request, res: Response, next: () => void) => {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    next();
  });
  router.options('/{*path}', (_req: Request, res: Response) => { res.sendStatus(204); });

  // RFC 9728 — Protected Resource Metadata
  router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: issuerUrl,
      authorization_servers: [issuerUrl],
      bearer_methods_supported: ['header'],
    });
  });

  // RFC 8414 — Authorization Server Metadata
  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
      issuer: issuerUrl,
      authorization_endpoint: `${issuerUrl}/authorize`,
      token_endpoint: `${issuerUrl}/token`,
      registration_endpoint: `${issuerUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp'],
    });
  });

  // Allowed redirect URI patterns for auto-registration (prevent open redirect)
  const ALLOWED_REDIRECT_PATTERNS = [
    /^https:\/\/claude\.ai\//,
    /^http:\/\/localhost(:\d+)?\//,
    /^http:\/\/127\.0\.0\.1(:\d+)?\//,
  ];

  function isRedirectAllowed(uri: string): boolean {
    return ALLOWED_REDIRECT_PATTERNS.some(p => p.test(uri));
  }

  const MAX_REDIRECT_URIS = 5;
  const MAX_CLIENTS = 200;

  // Auto-register unknown client_ids (Claude Desktop skips DCR)
  function ensureClient(clientId: string, redirectUri?: string): void {
    if (!clients.has(clientId)) {
      if (clients.size >= MAX_CLIENTS) {
        // Evict oldest client
        let oldestKey: string | undefined;
        let oldestTime = Infinity;
        for (const [k, v] of clients) {
          if (v.created_at < oldestTime) { oldestTime = v.created_at; oldestKey = k; }
        }
        if (oldestKey) clients.delete(oldestKey);
      }
      const uri = redirectUri && isRedirectAllowed(redirectUri) ? redirectUri : 'https://claude.ai/api/mcp/auth_callback';
      clients.set(clientId, { name: clientId, redirect_uris: [uri], created_at: Date.now() });
      console.log(`OAuth: auto-registered client "${clientId}"`);
    } else if (redirectUri && isRedirectAllowed(redirectUri)) {
      const client = clients.get(clientId)!;
      if (!client.redirect_uris.includes(redirectUri) && client.redirect_uris.length < MAX_REDIRECT_URIS) {
        client.redirect_uris.push(redirectUri);
      }
    }
  }

  // Dynamic Client Registration (RFC 7591) — rate limited per IP
  router.post(['/register', '/oauth/register'], json(), (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const reg = registrationCounts.get(ip);
    if (reg && Date.now() - reg.windowStart < 3_600_000) {
      if (++reg.count > MAX_REGISTRATIONS_PER_IP_HOUR) {
        console.log(`OAuth: DCR rate limit hit from ${ip}`);
        res.status(429).json({ error: 'too_many_requests', error_description: 'Registration rate limit exceeded' });
        return;
      }
    } else {
      registrationCounts.set(ip, { count: 1, windowStart: Date.now() });
    }
    const { redirect_uris, client_name } = req.body || {};
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uris required' });
      return;
    }
    const validUris = redirect_uris.filter((u: string) => typeof u === 'string' && isRedirectAllowed(u));
    if (validUris.length === 0) {
      res.status(400).json({ error: 'invalid_request', error_description: 'No allowed redirect_uris (only localhost and claude.ai permitted)' });
      return;
    }
    const clientId = randomBytes(16).toString('hex');
    clients.set(clientId, { name: client_name || 'unknown', redirect_uris: validUris, created_at: Date.now() });
    console.log(`OAuth: registered client "${client_name || 'unknown'}" -> ${clientId}`);
    res.status(201).json({
      client_id: clientId,
      client_name: client_name || 'unknown',
      redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // Authorize GET — login form
  router.get(['/authorize', '/oauth/authorize'], (req: Request, res: Response) => {
    const blocked = isBlocked(getClientIp(req));
    if (blocked) { res.status(429).json({ error: 'too_many_requests', error_description: blocked }); return; }
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query as Record<string, string>;
    if (!client_id) { res.status(400).json({ error: 'invalid_client' }); return; }
    ensureClient(client_id, redirect_uri);
    if (!code_challenge) {
      res.status(400).json({ error: 'invalid_request', error_description: 'PKCE required (code_challenge missing)' });
      return;
    }
    if (code_challenge_method && code_challenge_method !== 'S256') {
      res.status(400).json({ error: 'invalid_request', error_description: 'S256 required' });
      return;
    }
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Braimory</title><style>
body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
form{background:#1e293b;padding:2rem;border-radius:12px;width:320px;box-shadow:0 4px 24px rgba(0,0,0,.4)}
h2{margin:0 0 1.5rem;text-align:center;font-size:1.25rem}
label{display:block;margin-bottom:.25rem;font-size:.875rem;color:#94a3b8}
input{width:100%;padding:.5rem;margin-bottom:1rem;border:1px solid #334155;border-radius:6px;background:#0f172a;color:#e2e8f0;font-size:1rem;box-sizing:border-box}
button{width:100%;padding:.625rem;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:1rem;cursor:pointer}
button:hover{background:#2563eb}
.brain{text-align:center;font-size:2rem;margin-bottom:.5rem}
</style></head><body>
<form method="POST" action="/authorize">
<div class="brain">\u{1F9E0}</div><h2>Braimory</h2>
<input type="hidden" name="client_id" value="${esc(client_id || '')}">
<input type="hidden" name="redirect_uri" value="${esc(redirect_uri || '')}">
<input type="hidden" name="state" value="${esc(state || '')}">
<input type="hidden" name="code_challenge" value="${esc(code_challenge || '')}">
<label for="username">Username</label>
<input type="text" id="username" name="username" required autofocus>
<label for="password">Password</label>
<input type="password" id="password" name="password" required>
<button type="submit">Authorize</button>
</form></body></html>`);
  });

  // Authorize POST — validate credentials, issue auth code, redirect
  router.post(['/authorize', '/oauth/authorize'], urlencoded({ extended: false }), (req: Request, res: Response) => {
    const ip = getClientIp(req);

    // Brute force check BEFORE anything else
    const blocked = isBlocked(ip);
    if (blocked) {
      res.status(429).type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Blocked</title><style>
body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.box{background:#1e293b;padding:2rem;border-radius:12px;text-align:center}
.err{color:#f87171;margin-bottom:1rem}
</style></head><body><div class="box"><div class="err">${esc(blocked)}</div></div></body></html>`);
      return;
    }

    const { client_id, redirect_uri, state, code_challenge, username, password } = req.body || {};
    if (!client_id) { res.status(400).json({ error: 'invalid_client' }); return; }
    if (!code_challenge) {
      res.status(400).json({ error: 'invalid_request', error_description: 'PKCE required (code_challenge missing)' });
      return;
    }
    ensureClient(client_id, redirect_uri);
    const client = clients.get(client_id)!;

    const finalRedirect = (redirect_uri && client.redirect_uris.includes(redirect_uri))
      ? redirect_uri : client.redirect_uris[0];

    if (!OAUTH_USERNAME || !OAUTH_PASSWORD) {
      res.status(500).json({ error: 'server_error', error_description: 'OAuth credentials not configured' });
      return;
    }

    if (!safeEqual(username || '', OAUTH_USERNAME) || !safeEqual(password || '', OAUTH_PASSWORD)) {
      recordFailure(ip);
      res.status(403).type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Error</title><style>
body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.box{background:#1e293b;padding:2rem;border-radius:12px;text-align:center}
.err{color:#f87171;margin-bottom:1rem}
</style></head><body><div class="box"><div class="err">Invalid credentials</div>
<a href="javascript:history.back()" style="color:#3b82f6">Try again</a></div></body></html>`);
      return;
    }

    const code = randomBytes(32).toString('hex');
    authCodes.set(code, {
      client_id,
      redirect_uri: finalRedirect,
      code_challenge: code_challenge,
      expires_at: Date.now() + AUTH_CODE_TTL * 1000,
    });

    const url = new URL(finalRedirect);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    console.log(`OAuth: auth code issued for client ${client_id}`);
    res.redirect(302, url.toString());
  });

  // Token endpoint
  router.post(['/token', '/oauth/token'], urlencoded({ extended: false }), json(), (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier, refresh_token } = req.body || {};

    if (grant_type === 'authorization_code') {
      const entry = authCodes.get(code);
      if (!entry) { res.status(400).json({ error: 'invalid_grant' }); return; }
      authCodes.delete(code); // one-time use

      if (entry.expires_at < Date.now()) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'expired' });
        return;
      }
      if (entry.client_id !== client_id) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'client mismatch' });
        return;
      }
      if (redirect_uri && entry.redirect_uri !== redirect_uri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      }
      if (!code_verifier || !entry.code_challenge || !verifyPkce(code_verifier, entry.code_challenge)) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const accessToken = signJwt({ sub: OAUTH_USERNAME, iss: issuerUrl, iat: now, exp: now + ACCESS_TOKEN_TTL, scope: 'mcp', client_id });
      const refresh = randomBytes(32).toString('hex');
      refreshTokens.set(refresh, { client_id, expires_at: Date.now() + REFRESH_TOKEN_TTL * 1000 });

      console.log(`OAuth: tokens issued for client ${client_id}`);
      res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL, refresh_token: refresh, scope: 'mcp' });
      return;
    }

    if (grant_type === 'refresh_token') {
      const stored = refreshTokens.get(refresh_token);
      if (!stored || stored.expires_at < Date.now()) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'invalid or expired refresh token' });
        return;
      }
      if (client_id && stored.client_id !== client_id) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
        return;
      }
      refreshTokens.delete(refresh_token); // rotate

      const now = Math.floor(Date.now() / 1000);
      const accessToken = signJwt({ sub: OAUTH_USERNAME, iss: issuerUrl, iat: now, exp: now + ACCESS_TOKEN_TTL, scope: 'mcp', client_id: stored.client_id });
      const newRefresh = randomBytes(32).toString('hex');
      refreshTokens.set(newRefresh, { client_id: stored.client_id, expires_at: Date.now() + REFRESH_TOKEN_TTL * 1000 });

      console.log(`OAuth: tokens refreshed for client ${stored.client_id}`);
      res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL, refresh_token: newRefresh, scope: 'mcp' });
      return;
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // Debug: log unmatched OAuth-related requests
  router.all(['/token', '/oauth/token', '/authorize', '/oauth/authorize', '/register', '/oauth/register'], (req: Request, res: Response) => {
    console.log(`OAuth: unmatched ${req.method} ${req.path}`);
    res.status(405).json({ error: 'method_not_allowed' });
  });

  return router;
}
