// OAuth 2.1 for MCP clients (v1.12.1): "Add custom connector" in Claude (desktop, claude.ai, phone) with only the URL
// https://<editor>/mcp — the client discovers this server (RFC 9728 / RFC 8414), registers itself (RFC 7591), sends the
// user here to sign in and allow it (authorization code + PKCE S256), and gets a token for that user's account.
// A token sees only the projects of the user who allowed it, exactly like a personal AI token.
//
// Stored in <data>/oauth.json (mode 600): the registered clients and, for tokens, only their SHA-256 hash.
// Authorization codes and the pending "allow?" pages live in memory for 10 minutes.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const ACCESS_PREFIX = 'najja_oat_';
export const REFRESH_PREFIX = 'najja_ort_';
const ACCESS_TTL = 8 * 3600_000;
const REFRESH_TTL = 90 * 86400_000;
const CODE_TTL = 10 * 60_000;
const MAX_CLIENTS = 2000;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const oauthError = (status, error, description) => Object.assign(new Error(description || error), { status, oauth: error });

/**
 * Where a client may send the user back to: https anywhere; http only on this computer (loopback, e.g. a CLI's
 * local callback); an app's own scheme (cursor://…, com.example.app:/…) but never javascript:, data:, file: and the like.
 */
export function redirectAllowed(uri) {
  let u;
  try { u = new URL(String(uri)); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && !['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ftp', 'ws', 'wss'].includes(scheme);
}

/** A short name for where the user goes back to, for the "allow?" page. */
export function redirectLabel(uri) {
  try {
    const u = new URL(uri);
    if (/(^|\.)claude\.(ai|com)$/.test(u.hostname)) return 'Claude';
    if (u.protocol === 'http:') return 'aplikasi di komputer ini';
    return u.protocol === 'https:' ? u.hostname : `aplikasi ${u.protocol.slice(0, -1)}`;
  } catch { return 'aplikasi'; }
}

const s256 = (verifier) => crypto.createHash('sha256').update(String(verifier)).digest('base64url');

export function createOAuth(dataDir, { now = () => Date.now() } = {}) {
  const FILE = path.join(dataDir, 'oauth.json');
  let cache = null;
  let writing = Promise.resolve();
  const codes = new Map(); // code → { userId, clientId, redirectUri, challenge, scope, resource, exp }
  const pending = new Map(); // nonce → the request a user is asked to allow

  async function load() {
    if (cache) return cache;
    try { cache = JSON.parse(await fsp.readFile(FILE, 'utf8')); } catch { cache = {}; }
    cache.clients ||= [];
    cache.tokens ||= [];
    return cache;
  }
  /** Change the stored state in turn (no lost writes), dropping expired tokens. */
  function save(change) {
    const run = writing.then(async () => {
      const d = await load();
      const out = change(d);
      const t = now();
      d.tokens = d.tokens.filter((x) => x.exp > t);
      await fsp.mkdir(dataDir, { recursive: true });
      const tmp = `${FILE}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(d), { mode: 0o600 });
      await fsp.rename(tmp, FILE);
      return out;
    });
    writing = run.catch(() => {});
    return run;
  }
  const sweep = (map) => { const t = now(); for (const [k, v] of map) if (v.exp <= t) map.delete(k); };

  async function client(id) {
    return (await load()).clients.find((c) => c.id === id) || null;
  }

  /** RFC 7591 dynamic registration: a public client (PKCE, no secret). */
  async function register(body = {}) {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10) throw oauthError(400, 'invalid_redirect_uri', 'redirect_uris: 1 sampai 10 alamat');
    for (const u of uris) if (u.length > 2000 || !redirectAllowed(u)) throw oauthError(400, 'invalid_redirect_uri', `redirect_uri tidak diizinkan: ${u.slice(0, 100)}`);
    const grants = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token'];
    if (grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) throw oauthError(400, 'invalid_client_metadata', 'grant_types: authorization_code, refresh_token');
    const c = {
      id: `nc_${rand(16)}`,
      name: String(body.client_name || 'Aplikasi AI').replace(/[\u0000-\u001f]/g, '').slice(0, 80),
      redirectUris: uris,
      createdAt: now(),
    };
    await save((d) => {
      d.clients.push(c);
      // (the oldest clients that never got a token go first when there are too many)
      if (d.clients.length > MAX_CLIENTS) {
        const used = new Set(d.tokens.map((t) => t.clientId));
        const idle = d.clients.filter((x) => !used.has(x.id)).sort((a, b) => a.createdAt - b.createdAt);
        const drop = new Set(idle.slice(0, d.clients.length - MAX_CLIENTS).map((x) => x.id));
        d.clients = d.clients.filter((x) => !drop.has(x.id));
      }
    });
    return {
      client_id: c.id, client_id_issued_at: Math.floor(c.createdAt / 1000), client_name: c.name, redirect_uris: c.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    };
  }

  /**
   * Check an authorization request (the query of GET /oauth/authorize). Throws { redirect: false } errors when the
   * client or its address is wrong (shown on the page, never sent to an unchecked address), else returns the request.
   */
  async function checkAuthorize(q) {
    const c = await client(q.get('client_id'));
    if (!c) throw Object.assign(oauthError(400, 'invalid_client', 'Aplikasi ini tidak dikenal. Hubungkan ulang dari aplikasinya.'), { redirect: false });
    const redirectUri = q.get('redirect_uri') || (c.redirectUris.length === 1 ? c.redirectUris[0] : '');
    if (!c.redirectUris.includes(redirectUri)) throw Object.assign(oauthError(400, 'invalid_request', 'Alamat kembali aplikasi tidak cocok.'), { redirect: false });
    const req = { client: c, redirectUri, state: q.get('state') || '', scope: q.get('scope') || '', resource: q.get('resource') || '' };
    if (q.get('response_type') !== 'code') throw Object.assign(oauthError(400, 'unsupported_response_type', 'response_type harus code'), { req });
    const challenge = q.get('code_challenge') || '';
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || (q.get('code_challenge_method') || 'plain') !== 'S256') {
      throw Object.assign(oauthError(400, 'invalid_request', 'PKCE S256 wajib (code_challenge)'), { req });
    }
    return { ...req, challenge };
  }

  /** The "allow?" page's request, kept until the user answers (the nonce goes in the form). */
  function holdRequest(userId, req) {
    sweep(pending);
    const nonce = rand(24);
    pending.set(nonce, { ...req, userId, exp: now() + CODE_TTL });
    return nonce;
  }
  function takeRequest(nonce, userId) {
    sweep(pending);
    const p = pending.get(String(nonce || ''));
    if (!p || p.userId !== userId) return null;
    pending.delete(nonce);
    return p;
  }
  /** The user allowed it: a one-time code for the client. */
  function issueCode(p) {
    sweep(codes);
    const code = rand(32);
    codes.set(code, { userId: p.userId, clientId: p.client.id, redirectUri: p.redirectUri, challenge: p.challenge, scope: p.scope, resource: p.resource, exp: now() + CODE_TTL });
    return code;
  }

  async function issueTokens(userId, clientId, scope) {
    const access = ACCESS_PREFIX + rand(32);
    const refresh = REFRESH_PREFIX + rand(32);
    const t = now();
    await save((d) => {
      d.tokens.push({ hash: hash(access), kind: 'access', userId, clientId, scope, createdAt: t, exp: t + ACCESS_TTL });
      d.tokens.push({ hash: hash(refresh), kind: 'refresh', userId, clientId, scope, createdAt: t, exp: t + REFRESH_TTL });
    });
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL / 1000), refresh_token: refresh, ...(scope ? { scope } : {}) };
  }

  /** POST /oauth/token: authorization_code (with the PKCE verifier) or refresh_token (rotated). */
  async function token(form) {
    const grant = form.get('grant_type');
    const clientId = form.get('client_id');
    if (grant === 'authorization_code') {
      sweep(codes);
      const code = form.get('code') || '';
      const c = codes.get(code);
      if (!c) throw oauthError(400, 'invalid_grant', 'Kode tidak berlaku (kedaluwarsa atau sudah dipakai)');
      codes.delete(code); // (one use, even when the rest is wrong)
      if (clientId && clientId !== c.clientId) throw oauthError(400, 'invalid_grant', 'Kode ini milik aplikasi lain');
      if ((form.get('redirect_uri') || c.redirectUri) !== c.redirectUri) throw oauthError(400, 'invalid_grant', 'redirect_uri tidak cocok');
      const verifier = form.get('code_verifier') || '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== c.challenge) throw oauthError(400, 'invalid_grant', 'code_verifier salah');
      if (!(await client(c.clientId))) throw oauthError(400, 'invalid_client', 'Aplikasi sudah tidak terdaftar');
      return issueTokens(c.userId, c.clientId, c.scope);
    }
    if (grant === 'refresh_token') {
      const h = hash(form.get('refresh_token') || '');
      const d = await load();
      const r = d.tokens.find((x) => x.kind === 'refresh' && x.hash === h && x.exp > now());
      if (!r || (clientId && clientId !== r.clientId)) throw oauthError(400, 'invalid_grant', 'Refresh token tidak berlaku');
      await save((dd) => { dd.tokens = dd.tokens.filter((x) => x.hash !== h); });
      return issueTokens(r.userId, r.clientId, r.scope);
    }
    throw oauthError(400, 'unsupported_grant_type', 'grant_type: authorization_code atau refresh_token');
  }

  /** The user an access token belongs to (id and client), or null. Marks when it was last used (hourly). */
  async function userByAccessToken(t) {
    if (!String(t || '').startsWith(ACCESS_PREFIX)) return null;
    const h = hash(t);
    const d = await load();
    const x = d.tokens.find((y) => y.kind === 'access' && y.hash === h);
    if (!x || x.exp <= now()) return null;
    if (!x.lastUsedAt || now() - x.lastUsedAt > 3600_000) save(() => { x.lastUsedAt = now(); }).catch(() => {});
    return { userId: x.userId, clientId: x.clientId };
  }

  /** RFC 7009: forget a token (access or refresh). Always "ok" (no hint whether it existed). */
  async function revokeToken(t) {
    const h = hash(t || '');
    await save((d) => { d.tokens = d.tokens.filter((x) => x.hash !== h); });
  }

  /** The apps a user allowed, with when they were allowed and last used. */
  async function grants(userId) {
    const d = await load();
    const by = new Map();
    for (const x of d.tokens) {
      if (x.userId !== userId || x.exp <= now()) continue;
      const g = by.get(x.clientId) || { clientId: x.clientId, createdAt: x.createdAt, lastUsedAt: null };
      g.createdAt = Math.min(g.createdAt, x.createdAt);
      if (x.lastUsedAt) g.lastUsedAt = Math.max(g.lastUsedAt || 0, x.lastUsedAt);
      by.set(x.clientId, g);
    }
    return [...by.values()].map((g) => {
      const c = d.clients.find((y) => y.id === g.clientId);
      return { ...g, name: c?.name || 'Aplikasi AI', to: c ? redirectLabel(c.redirectUris[0]) : '' };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }
  /** Disconnect an app (clientId) or every app of a user (after a password change). */
  async function revokeUser(userId, clientId = null) {
    let n = 0;
    await save((d) => {
      const before = d.tokens.length;
      d.tokens = d.tokens.filter((x) => !(x.userId === userId && (!clientId || x.clientId === clientId)));
      n = before - d.tokens.length;
    });
    for (const [k, v] of codes) if (v.userId === userId && (!clientId || v.clientId === clientId)) codes.delete(k);
    return n;
  }

  return { register, checkAuthorize, holdRequest, takeRequest, issueCode, token, userByAccessToken, revokeToken, grants, revokeUser, client };
}

/** The discovery documents (base: https://editor.example.com). */
export function protectedResourceMetadata(base) {
  return { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], resource_name: 'Najja Editor', scopes_supported: ['mcp'] };
}
export function authorizationServerMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  };
}
