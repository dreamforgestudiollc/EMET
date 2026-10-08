/**
 * MongoOAuthProvider — a minimal single-user OAuth 2.1 authorization-server
 * provider for the EMET remote MCP endpoint, implementing the MCP SDK's
 * OAuthServerProvider interface. State (clients / codes / tokens) is stored in
 * the SAME database as memory (collections: <prefix>oauth_clients,
 * <prefix>oauth_codes, <prefix>oauth_tokens), so it survives restarts/redeploys.
 *
 * Client identification — TWO mechanisms, one deprecated (2026-09-07):
 *
 *   CIMD  — Client ID Metadata Documents. The client_id IS an https URL; the
 *           server fetches the JSON document at that URL, checks that the
 *           document names the same URL as its own client_id, and uses its
 *           redirect_uris. No registration call, no per-connection client rows
 *           piling up, and the binding between id and document is the URL
 *           itself. This is the mechanism the MCP 2026-07-28 specification
 *           keeps.
 *   DCR   — Dynamic Client Registration (RFC 7591). Deprecated by the same
 *           specification with a twelve-month window (to ~2027-07). Kept mounted
 *           so hosts that have not moved yet keep working; removal is a separate,
 *           dated decision, not a side effect of adding CIMD.
 *
 * A client that advertises BOTH `client_id_metadata_document_supported: true`
 * and "none" in `token_endpoint_auth_methods_supported` will be offered CIMD
 * by Claude's connector client; see withCimdMetadata(). EMET_CIMD=0 turns the
 * advertisement off without a redeploy — the rollback is a variable flip.
 *
 * Security model: PKCE (S256) is enforced by the SDK handlers. The
 * user-consent step is gated by a single shared passphrase
 * (EMET_OAUTH_PASSPHRASE) that only the user knows - even someone who finds
 * the URL cannot authorize a device without it. Access tokens are opaque,
 * random, short-lived, and validated against Mongo on every /mcp call. Refresh
 * tokens ROTATE on use (OAuth 2.1 requirement for public clients, which both
 * CIMD and DCR clients are) with a short grace window so a client that lost the
 * response to its refresh is not locked out.
 */
import crypto from 'crypto';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { COLLECTION_PREFIX } from './database.js';
import { setting } from './env.js';
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { scopesNotGranted } from './scopes.js';

const CODE_TTL_MS = 5 * 60 * 1000;              // authorization codes: 5 minutes
const ACCESS_TTL_S = 60 * 60;                   // access tokens: 1 hour
const REFRESH_TTL_S = 60 * 60 * 24 * 60;        // refresh tokens: 60 days
const REFRESH_ROTATION_GRACE_S = 60;            // a rotated refresh token stays usable this long
/** The marker on codes and tokens minted from an invite (R6). */
export const INVITE_GRANT = 'invite';
// EMET Member Access tokens carry their own marker, so refresh can check the member flag, not the guest one.
export const MEMBER_GRANT = 'member';
const DOOR_GRANTS = new Set([INVITE_GRANT, MEMBER_GRANT]);

/** How long a fetched Client ID Metadata Document is trusted before refetching. */
export const CIMD_TTL_MS = 60 * 60 * 1000;      // 1 hour
const CIMD_FETCH_TIMEOUT_MS = 5000;
const CIMD_MAX_BYTES = 64 * 1024;
/** CIMD document fetches per host per minute. A metadata URL is not a general HTTP client. */
export const CIMD_FETCH_PER_MIN = 60;
const CIMD_FETCH_GLOBAL_PER_MIN = 120;
const cimdFetchTimes = [];
const cimdHostTimes = new Map();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const randTok = (n = 32) => b64url(crypto.randomBytes(n));

/**
 * Tokens are stored as their SHA-256 digest, never in clear (security audit
 * finding H2, 2026-09-19): a reader of the database must not hold a live
 * bearer. The digest is what is looked up; the token itself exists only in
 * the response that issued it and in the client that holds it.
 *
 * Rows written before this change carry the clear token. They are honoured
 * ONCE: a lookup that misses by digest tries the clear value, and a hit is
 * rewritten as its digest on the spot. No device re-authorizes.
 */
export const tokenDigest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    try { crypto.timingSafeEqual(ab, Buffer.alloc(ab.length)); } catch { /* noop */ }
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// CIMD — pure parts, exported so they can be tested without a network.
// ---------------------------------------------------------------------------

/**
 * Is this client_id a reference to a Client ID Metadata Document?
 * Only an https URL with a real path qualifies: no fragment, no userinfo, no
 * plain-http. Anything else is an opaque (DCR) id and is looked up, not fetched.
 */
export function isCimdClientId(clientId) {
  if (typeof clientId !== 'string' || !/^https:\/\//i.test(clientId)) return false;
  let u;
  try { u = new URL(clientId); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.hash) return false;
  if (u.username || u.password) return false;
  if (!u.pathname || u.pathname === '/') return false;
  return true;
}

/**
 * Validate a fetched metadata document against the URL it came from.
 * The one check that carries the whole security argument: the document's
 * client_id MUST equal the URL. A document hosted at claude.ai that claims to
 * be some other client is not a client at all.
 * Returns a sanitised client record; never lets a client_secret through.
 */
export function validateCimdDocument(doc, url) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('CIMD document must be a JSON object');
  }
  if (doc.client_id !== url) {
    throw new Error(`CIMD document client_id does not match its URL (expected ${url})`);
  }
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || !doc.redirect_uris.every(r => typeof r === 'string' && r.length > 0)) {
    throw new Error('CIMD document must carry a non-empty redirect_uris array of strings');
  }
  const method = doc.token_endpoint_auth_method === undefined ? 'none' : doc.token_endpoint_auth_method;
  if (method !== 'none') {
    throw new Error(`CIMD clients are public; token_endpoint_auth_method must be "none" (got ${method})`);
  }
  const { client_secret, client_secret_expires_at, ...rest } = doc;
  return {
    ...rest,
    client_id: url,
    redirect_uris: [...doc.redirect_uris],
    token_endpoint_auth_method: 'none'
  };
}

/**
 * Decorate authorization-server metadata so a client can choose CIMD.
 * Claude selects CIMD only when BOTH signals are present; either missing and it
 * falls back to DCR. DCR's registration_endpoint is left exactly as it was.
 */
/**
 * Addresses the CIMD fetcher must not connect to, matched by parsed bits.
 * IPv4 and IPv6 are separate lists: an IPv4-mapped subnet also matches every
 * native IPv4 address, so a public IPv4 address is checked only against the
 * IPv4 list.
 */
const cimdBlock4 = new net.BlockList();
const cimdBlock6 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],       // unspecified
  ['10.0.0.0', 8],      // private
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local, including metadata 169.254.169.254
  ['172.16.0.0', 12],   // private
  ['192.168.0.0', 16],  // private
  ['224.0.0.0', 4],     // multicast
]) cimdBlock4.addSubnet(addr, prefix, 'ipv4');
// Metadata addresses that do not sit inside the ranges above.
cimdBlock4.addAddress('100.100.100.200', 'ipv4'); // Alibaba
cimdBlock4.addAddress('168.63.129.16', 'ipv4');   // Azure host
for (const [addr, prefix] of [
  ['::', 128],          // unspecified
  ['::1', 128],         // loopback
  ['fc00::', 7],        // unique-local, including fd00:ec2::254
  ['fe80::', 10],       // link-local: fe80:: through febf::
  ['ff00::', 8],        // multicast
  ['::', 96],           // IPv4-compatible
  ['::ffff:0:0', 96],   // IPv4-mapped
  ['64:ff9b::', 96],    // NAT64
]) cimdBlock6.addSubnet(addr, prefix, 'ipv6');

/**
 * True for an address the CIMD fetcher must not connect to. A hostname is
 * not an address and returns false; the resolver result is checked later.
 */
export function isBlockedCimdAddress(address) {
  if (typeof address !== 'string' || !address.trim()) return true;
  let ip = address.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const family = net.isIP(ip);
  if (family === 4) return cimdBlock4.check(ip, 'ipv4');
  if (family === 6) return cimdBlock6.check(ip, 'ipv6');
  return false;
}

function takeCimdFetchSlot(host) {
  const now = Date.now();
  const windowStart = now - 60_000;
  while (cimdFetchTimes.length && cimdFetchTimes[0] <= windowStart) cimdFetchTimes.shift();
  const hostHits = (cimdHostTimes.get(host) || []).filter((t) => t > windowStart);
  if (cimdFetchTimes.length >= CIMD_FETCH_GLOBAL_PER_MIN || hostHits.length >= CIMD_FETCH_PER_MIN) return false;
  cimdFetchTimes.push(now);
  hostHits.push(now);
  cimdHostTimes.set(host, hostHits);
  return true;
}

/**
 * Resolve the CIMD URL before any connection. Refuses a literal or resolved
 * loopback, private, link-local, or metadata address. `lookup` is injectable.
 */
export async function assertCimdTargetPublic(url, lookup) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw new Error('CIMD host is not a public address');
  }
  if (isBlockedCimdAddress(host)) throw new Error('CIMD host is not a public address');
  const fn = lookup || dnsPromises.lookup;
  const found = await fn(host, { all: true, verbatim: true });
  const list = Array.isArray(found) ? found : (found ? [found] : []);
  if (!list.length) throw new Error('CIMD host did not resolve');
  const checked = [];
  for (const item of list) {
    const address = typeof item === 'string' ? item : item && item.address;
    if (isBlockedCimdAddress(address)) throw new Error('CIMD host resolves to a blocked address');
    const family = (item && item.family === 6) || String(address).includes(':') ? 6 : 4;
    checked.push({ address, family });
  }
  return checked;
}

/**
 * DNS lookup that always returns the address already checked. A later answer
 * for the same name is never used, so a rebinding cannot move the connection
 * onto a private, loopback, link-local, or metadata address.
 */
export function cimdPinnedLookup(address, family) {
  const fam = family === 6 ? 6 : 4;
  return function lookup(_hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options && options.all) callback(null, [{ address, family: fam }]);
    else callback(null, address, fam);
  };
}

function destroyQuiet(socket) {
  if (!socket || socket.destroyed) return;
  socket.removeAllListeners('error');
  socket.on('error', () => {});
  socket.destroy();
}

function cimdResult(status, chunks) {
  if (status >= 300 && status < 400) {
    return Promise.reject(new Error(`redirect refused (${status})`));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text
  };
}

/**
 * GET a CIMD document over TLS, connected only through `init.lookup`.
 * `redirect: 'error'` is required: a 3xx is a failure and is not followed.
 *
 * The real client connects with `net.connect` first and attaches an error
 * handler before TLS starts. Wrapping an unreachable IPv6 address in TLS
 * throws on the socket (`setServername` / `ENETUNREACH`) where `req.on('error')`
 * never runs, and that throw crashes the process. A test double still uses
 * `httpsImpl.request` and does not dial.
 */
export function pinnedHttpsGet(url, init, httpsImpl = https) {
  if (!init || init.redirect !== 'error') {
    return Promise.reject(new Error('CIMD fetch does not follow redirects'));
  }
  if (typeof init.lookup !== 'function') {
    return Promise.reject(new Error('CIMD fetch has no pinned address'));
  }
  const u = new URL(url);
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  if (!httpsImpl || httpsImpl.request !== https.request) {
    return pinnedHttpsGetInjected(u, hostname, init, httpsImpl);
  }
  return pinnedHttpsGetConnected(u, hostname, init);
}

function pinnedHttpsGetInjected(u, hostname, init, httpsImpl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const req = httpsImpl.request({
      protocol: 'https:',
      hostname,
      servername: hostname,
      port: u.port || 443,
      method: 'GET',
      path: `${u.pathname}${u.search}`,
      headers: { ...(init.headers || {}), host: u.host },
      lookup: init.lookup,
      timeout: CIMD_FETCH_TIMEOUT_MS
    }, (res) => {
      const status = res.statusCode || 0;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', fail);
      res.on('end', () => {
        if (settled) return;
        settled = true;
        Promise.resolve(cimdResult(status, chunks)).then(resolve, reject);
      });
    });
    const onSocket = (socket) => {
      if (!socket || typeof socket.on !== 'function') return;
      socket.on('error', (err) => {
        destroyQuiet(socket);
        fail(err);
      });
    };
    req.on('socket', onSocket);
    req.on('error', fail);
    req.on('timeout', () => req.destroy(new Error('CIMD fetch timed out')));
    if (init.signal) {
      const abort = () => req.destroy(new Error('CIMD fetch aborted'));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    }
    req.end();
  });
}

function pinnedHttpsGetConnected(u, hostname, init) {
  const port = Number(u.port || 443);
  return new Promise((resolve, reject) => {
    let settled = false;
    let raw = null;
    let secure = null;
    let req = null;
    const timer = setTimeout(() => fail(new Error('CIMD fetch timed out')), CIMD_FETCH_TIMEOUT_MS);
    const onAbort = () => fail(new Error('CIMD fetch aborted'));
    if (init.signal) {
      if (init.signal.aborted) {
        clearTimeout(timer);
        reject(new Error('CIMD fetch aborted'));
        return;
      }
      init.signal.addEventListener('abort', onAbort, { once: true });
    }
    function cleanup() {
      clearTimeout(timer);
      if (init.signal) init.signal.removeEventListener('abort', onAbort);
      if (req) {
        req.removeAllListeners('error');
        req.on('error', () => {});
        req.destroy();
        req = null;
      }
      destroyQuiet(secure);
      destroyQuiet(raw);
      secure = null;
      raw = null;
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
    function succeed(status, chunks) {
      if (settled) return;
      settled = true;
      cleanup();
      Promise.resolve(cimdResult(status, chunks)).then(resolve, reject);
    }
    try {
      raw = net.connect({ host: hostname, port, lookup: init.lookup });
    } catch (err) {
      fail(err);
      return;
    }
    raw.on('error', fail);
    raw.on('connect', () => {
      if (settled) return;
      // init.ca is only for a test server. Production does not pass it, so the
      // default trust store still checks the certificate.
      secure = tls.connect({
        socket: raw,
        servername: hostname,
        ...(init.ca ? { ca: init.ca } : {})
      });
      secure.on('error', fail);
      secure.on('secureConnect', () => {
        if (settled) return;
        req = http.request({
          createConnection: () => secure,
          method: 'GET',
          host: hostname,
          path: `${u.pathname}${u.search}`,
          headers: { ...(init.headers || {}), host: u.host }
        }, (res) => {
          const status = res.statusCode || 0;
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('error', fail);
          res.on('end', () => succeed(status, chunks));
        });
        req.on('error', fail);
        req.end();
      });
    });
  });
}

export function withCimdMetadata(metadata, enabled) {
  const out = { ...(metadata || {}) };
  const methods = Array.isArray(out.token_endpoint_auth_methods_supported) ? [...out.token_endpoint_auth_methods_supported] : [];
  if (!methods.includes('none')) methods.push('none');
  out.token_endpoint_auth_methods_supported = methods;
  out.client_id_metadata_document_supported = enabled === true;
  return out;
}

// ---------------------------------------------------------------------------

export class MongoOAuthProvider {
  /**
   * @param {() => import('mongodb').Db} getDb  returns the connected Mongo Db (dbManager.db)
   * @param {{ passphrase?: string, issuerUrl?: string, fetch?: Function, cimd?: boolean }} opts
   *   fetch — injectable for tests. Production leaves it unset and connects
   *           with pinnedHttpsGet to the address already checked.
   *   cimd  — whether URL client_ids are resolved by fetching. Defaults to
   *           EMET_CIMD !== '0' (on unless explicitly disabled).
   */
  constructor(getDb, opts = {}) {
    this._getDb = getDb;
    this.prefix = COLLECTION_PREFIX;
    this.passphrase = opts.passphrase || setting('OAUTH_PASSPHRASE') || '';
    this.issuerUrl = opts.issuerUrl || process.env.PUBLIC_URL || '';
    // A caller-supplied fetch is the test double. It does not dial the network.
    // Production passes neither and connects with pinnedHttpsGet, which uses
    // only the address assertCimdTargetPublic already accepted.
    this._fetch = opts.fetch || null;
    this._https = opts.https || https;
    this._lookup = opts.lookup !== undefined
      ? opts.lookup
      : (opts.fetch ? async () => [{ address: '1.1.1.1', family: 4 }] : dnsPromises.lookup);
    this.cimdEnabled = opts.cimd !== undefined ? Boolean(opts.cimd) : (setting('CIMD') !== '0');
    this._resolveSubject = opts.resolveSubject || null;
    // Whether invites are frozen (invites.js INVITES_FROZEN, read at module
    // load like the rest of the invite gate). A function so suites can pin it.
    this._invitesFrozen = typeof opts.invitesFrozen === 'function' ? opts.invitesFrozen : null;
    // The same for EMET Member Access (invites.js MEMBER_ACCESS_FROZEN).
    this._memberAccessFrozen = typeof opts.memberAccessFrozen === 'function' ? opts.memberAccessFrozen : null;
    this.clientsStore = {
      getClient: (id) => this._getClient(id),
      registerClient: (client) => this._registerClient(client),
    };
  }

  col(name) { return this._getDb().collection(`${this.prefix}oauth_${name}`); }

  /** Find a token row by digest, falling back once to a pre-H2 clear row and migrating it. */
  async _findToken(token, kind, extra = {}) {
    const tokens = this.col('tokens');
    const digest = tokenDigest(token);
    const byDigest = await tokens.findOne({ token: digest, kind, ...extra });
    if (byDigest) return byDigest;
    const clear = await tokens.findOne({ token, kind, ...extra });
    // A row that is ALREADY a digest must never match here: otherwise the
    // stored digest itself would work as a bearer, which is the exact thing
    // hashing exists to prevent. Caught by the test, not by the author.
    if (!clear || clear.hashed === true) return null;
    await tokens.updateOne({ _id: clear._id }, { $set: { token: digest, hashed: true } });
    console.error('[emet][oauth] migrated a clear-text', kind, 'token row to its digest');
    return { ...clear, token: digest, hashed: true };
  }

  async _getClient(clientId) {
    if (isCimdClientId(clientId)) {
      if (!this.cimdEnabled) return undefined;
      return this._getCimdClient(clientId);
    }
    const doc = await this.col('clients').findOne({ client_id: clientId });
    if (!doc) return undefined;
    const { _id, ...rest } = doc;
    return rest;
  }

  /**
   * Resolve a CIMD client: serve from cache inside the TTL, otherwise fetch,
   * validate, and cache. A fetch failure falls back to a stale cached copy if
   * one exists (the client is still who it was an hour ago); with no cache it
   * yields undefined, which the SDK reports as an invalid client. A document
   * that fails validation is never cached.
   */
  async _getCimdClient(url) {
    const clients = this.col('clients');
    const cached = await clients.findOne({ client_id: url, cimd: true });
    const fresh = cached && typeof cached.fetched_at === 'number' && (Date.now() - cached.fetched_at) < CIMD_TTL_MS;
    if (fresh) { const { _id, ...rest } = cached; return rest; }

    let doc;
    try {
      doc = await this._fetchCimdDocument(url);
    } catch (e) {
      console.error('[emet][oauth] CIMD fetch failed', url, e.message);
      if (cached) { const { _id, ...rest } = cached; return rest; }
      return undefined;
    }

    let client;
    try {
      client = validateCimdDocument(doc, url);
    } catch (e) {
      console.error('[emet][oauth] CIMD document rejected', url, e.message);
      return undefined;
    }

    const record = { ...client, cimd: true, fetched_at: Date.now() };
    await clients.updateOne({ client_id: url }, { $set: record }, { upsert: true });
    // The success line completes the picture the two failure lines above
    // started: a fetched-and-cached document is the CIMD path proving itself.
    console.error('[emet][oauth] CIMD document fetched and cached', url, cached ? '(refresh)' : '(first registration)');
    return record;
  }

  async _fetchCimdDocument(url) {
    const host = new URL(url).hostname;
    if (!takeCimdFetchSlot(host)) throw new Error('CIMD fetch rate limit');
    const checked = await assertCimdTargetPublic(url, this._lookup);
    const chosen = checked[0];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CIMD_FETCH_TIMEOUT_MS);
    const init = {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
      lookup: cimdPinnedLookup(chosen.address, chosen.family)
    };
    try {
      const res = this._fetch
        ? await this._fetch(url, init)
        : await pinnedHttpsGet(url, init, this._https);
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
      const text = await res.text();
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > CIMD_MAX_BYTES) {
        throw new Error(`document exceeds ${CIMD_MAX_BYTES} bytes`);
      }
      try { return JSON.parse(text); }
      catch { throw new Error('document is not valid JSON'); }
    } finally {
      clearTimeout(timer);
    }
  }

  async _registerClient(client) {
    const client_id = randTok(16);
    const now = Math.floor(Date.now() / 1000);
    const full = { ...client, client_id, client_id_issued_at: now };
    await this.col('clients').insertOne({ ...full });
    return full;
  }

  checkPassphrase(input) {
    if (!this.passphrase) return false;
    return timingSafeEqualStr(input, this.passphrase);
  }

  /**
   * SDK GET /authorize -> renders a passphrase-gated consent page that POSTs
   * to /oauth/approve (mounted by http-remote.js). We do NOT mint the code here;
   * the passphrase check happens on approve.
   */
  async authorize(client, params, res) {
    const fields = {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      state: params.state || '',
      scopes: (params.scopes || []).join(' '),
      resource: params.resource ? params.resource.href : '',
    };
    const hidden = Object.entries(fields)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
      .join('\n');
    // The MCP authorization spec requires the consent screen to show the
    // redirect target clearly, with a warning when it is a loopback address
    // (any local process can bind a port and claim to be the client).
    let redirectHost = '';
    let loopback = false;
    try { const u = new URL(params.redirectUri); redirectHost = u.host; loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); } catch { /* shown blank */ }
    const clientLabel = client.client_name ? `${escapeHtml(client.client_name)}` : escapeHtml(client.client_id);
    const scopeList = (params.scopes || []).map((s) => escapeHtml(s)).filter(Boolean);
    const scopeLine = scopeList.length ? scopeList.join(', ') : '(none requested)';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Cache-Control', 'no-store');
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EMET &middot; EMET</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#12141a;color:#e8e6e0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}form{background:#1b1e26;padding:30px 26px;border-radius:14px;max-width:340px;width:88%;box-shadow:0 10px 44px #0009}h1{font-size:17px;margin:0 0 6px}p{font-size:13px;line-height:1.5;color:#9aa0ab;margin:0 0 18px}input[type=password]{width:100%;box-sizing:border-box;padding:12px;border-radius:9px;border:1px solid #333;background:#0e1014;color:#fff;font-size:15px}button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:9px;background:#3a6ea5;color:#fff;font-size:15px;font-weight:600;cursor:pointer}small{display:block;margin-top:14px;color:#5c626d;font-size:11px}.warn{color:#d9a441}</style></head>
<body><form method="POST" action="/oauth/approve">${hidden}
<h1>Connect to EMET</h1>
<p>Authorize <b>${clientLabel}</b> to reach this EMET memory store. After approval you will be sent to <code>${escapeHtml(redirectHost)}</code>.${loopback ? ' <span class="warn">That is a local address on this device; only approve if you started this connection yourself.</span>' : ''} This approval grants: <b>${scopeLine}</b>. Owner: enter the passphrase and the host source tag. Guest: enter the invite code you were given.</p>
<input type="text" name="source" autocomplete="off" placeholder="Source tag (owner)" style="margin-bottom:10px;width:100%;box-sizing:border-box;padding:12px;border-radius:9px;border:1px solid #333;background:#0e1014;color:#fff;font-size:15px">
<input type="password" name="passphrase" autofocus autocomplete="current-password" placeholder="Passphrase (owner)">
<input type="text" name="invite_code" autocomplete="off" placeholder="Invite code (guest)" style="margin-top:10px;width:100%;box-sizing:border-box;padding:12px;border-radius:9px;border:1px solid #333;background:#0e1014;color:#fff;font-size:15px">
<button type="submit">Authorize this device</button>
<small>The well is deep. Only you hold the passphrase.</small>
</form></body></html>`);
  }

  /** Called by /oauth/approve AFTER a successful passphrase check. */
  async createAuthorizationCode({ client_id, redirect_uri, code_challenge, scopes, resource, subject, issued_via, source_tag }) {
    const code = randTok(24);
    await this.col('codes').insertOne({
      code: tokenDigest(code), hashed: true, client_id, redirect_uri, code_challenge,
      scopes: scopes || [], resource: resource || null,
      subject: subject || null,
      source_tag: source_tag || null,
      ...(DOOR_GRANTS.has(issued_via) ? { issued_via } : {}),
      expiresAtMs: Date.now() + CODE_TTL_MS, used: false, createdAt: new Date(),
    });
    return code;
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const doc = await this.col('codes').findOne({ code: tokenDigest(authorizationCode), client_id: client.client_id });
    if (!doc) throw new InvalidGrantError('this authorization code is not recognised - start the connection again');
    return doc.code_challenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    const codes = this.col('codes');
    const digest = tokenDigest(authorizationCode);
    const existing = await codes.findOne({ code: digest, client_id: client.client_id });
    if (!existing) throw new InvalidGrantError('this authorization code is not recognised - start the connection again');
    if (existing.expiresAtMs < Date.now()) throw new InvalidGrantError('this authorization code has expired - start the connection again');
    if (redirectUri && existing.redirect_uri && redirectUri !== existing.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the one this code was issued for');
    const claimed = await codes.findOneAndUpdate(
      { code: digest, client_id: client.client_id, used: false },
      { $set: { used: true } }
    );
    const doc = claimed && Object.prototype.hasOwnProperty.call(claimed, 'value') ? claimed.value : claimed;
    if (!doc) throw new InvalidGrantError('this authorization code has already been used - start the connection again');
    return this._issueTokens(client.client_id, doc.scopes || [], doc.resource || (resource ? resource.href : null), doc.subject || null, doc.issued_via || null, null, doc.source_tag || null);
  }

  /**
   * Refresh with ROTATION: every refresh issues a new refresh token and marks
   * the presented one rotated. Inside REFRESH_ROTATION_GRACE_S the old token is
   * still honoured (the client may not have received the response); after that
   * it is refused with invalid_grant - the RFC 6749 code Claude's client expects
   * so it re-authorizes instead of retrying forever.
   */
  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const tokens = this.col('tokens');
    const rt = await this._findToken(refreshToken, 'refresh', { client_id: client.client_id });
    // Every refusal here is an OAuth error the SDK maps to 400 invalid_grant
    // (RFC 6749 section 5.2). A plain Error became a 500 server_error, which
    // told the client the server was broken instead of "sign in again".
    if (!rt) throw new InvalidGrantError('this refresh token is not recognised (it may have been revoked, or issued to another client) - reconnect to sign in again');
    const nowS = Math.floor(Date.now() / 1000);
    if (rt.expiresAt && rt.expiresAt < nowS) throw new InvalidGrantError('this refresh token has expired - reconnect to sign in again');
    // A token issued before source tags were stored must not mint another
    // token with an empty tag. The client signs in again; the new consent
    // binds a registered tag. Expiry is reported first, so an expired
    // legacy token still says it has expired.
    if (!rt.source_tag) {
      throw new InvalidGrantError('this login has no source tag bound. Sign in again so the new consent binds a registered tag.');
    }
    if (typeof rt.rotated_at === 'number') {
      const withinGrace = (nowS - rt.rotated_at) <= REFRESH_ROTATION_GRACE_S && rt.grace_replacement;
      if (withinGrace) return { ...rt.grace_replacement };
      await this._revokeFamily(rt);
      throw new InvalidGrantError('this refresh token has already been replaced by a newer one - reconnect to sign in again');
    }
    // R6: a token minted from an invite stops refreshing while invites are
    // frozen, so a re-freeze ends it within one access-token lifetime instead
    // of letting rotation renew it for ever. Passphrase tokens are untouched.
    // Each door is checked against its own flag: a member token stops when EMET Member Access is off
    // (even with guest access on), and keeps refreshing when only EMET_MEMBER_ACCESS=1; a guest token
    // likewise against EMET_INVITES.
    const door = await this._tokenDoor(rt);
    if (door === 'member' && await this._memberAccessIsFrozen()) {
      throw new InvalidGrantError('this login came from EMET Member Access, and member access is off on this install - it can no longer be refreshed');
    }
    if (door === 'guest' && await this._invitesAreFrozen()) {
      throw new InvalidGrantError('this login came from an invite, and invites are off on this install - it can no longer be refreshed');
    }
    // Defect 1: a refresh keeps or narrows the scopes granted, never widens
    // them (RFC 6749 section 6: a requested scope not originally granted is
    // invalid_scope). No scope requested keeps the stored scopes.
    const requested = (scopes || []).filter((s) => typeof s === 'string' && s.trim() !== '');
    const granted = rt.scopes || [];
    const wider = scopesNotGranted(granted, requested);
    if (wider.length) {
      throw new InvalidScopeError(`a refresh cannot widen scope: ${wider.join(', ')} was not granted (granted: ${granted.join(', ')})`);
    }
    const useScopes = requested.length ? requested : granted;
    const family = rt.family || randTok(16);
    const out = await this._issueTokens(client.client_id, useScopes, rt.resource || (resource ? resource.href : null), rt.subject || null, rt.issued_via || null, family, rt.source_tag || null);
    const claim = await tokens.findOneAndUpdate(
      { _id: rt._id, rotated_at: { $exists: false } },
      { $set: { rotated_at: nowS, replaced_by: tokenDigest(out.refresh_token), grace_replacement: out, family } }
    );
    const won = claim && (Object.prototype.hasOwnProperty.call(claim, 'value') ? claim.value : claim);
    if (!won) {
      await tokens.deleteOne({ token: tokenDigest(out.access_token), kind: 'access' });
      await tokens.deleteOne({ token: tokenDigest(out.refresh_token), kind: 'refresh' });
      const fresh = await tokens.findOne({ _id: rt._id });
      if (fresh && fresh.grace_replacement && typeof fresh.rotated_at === 'number' && (nowS - fresh.rotated_at) <= REFRESH_ROTATION_GRACE_S) {
        return { ...fresh.grace_replacement };
      }
      await this._revokeFamily(fresh || rt);
      throw new InvalidGrantError('this refresh token has already been replaced by a newer one - reconnect to sign in again');
    }
    return out;
  }

  /** A reused refresh token outside the grace window ends every token in its family. */
  async _revokeFamily(rt) {
    const tokens = this.col('tokens');
    if (rt && rt.family) {
      await tokens.deleteMany({ family: rt.family });
      return;
    }
    if (rt && rt._id) await tokens.deleteOne({ _id: rt._id });
  }

  /**
   * Whether a stored token came from an invite. New tokens carry
   * issued_via: 'invite' from the code the invite approval minted, and keep it
   * through every refresh. Tokens issued before that field existed are judged
   * by their subject: a person whose role is 'member' was created only by an
   * invite redemption (invites.js), while a passphrase token's subject is the
   * owner person (or the legacy 'owner'), so passphrase tokens never match.
   */
  async _isInviteToken(rt) {
    return (await this._tokenDoor(rt)) !== null;
  }

  /**
   * Which door a stored token came through: 'member' (EMET Member Access, issued_via 'member'),
   * 'guest' (EMET Guest Access, issued_via 'invite'), or null (passphrase). A legacy token with no
   * issued_via is judged by its subject's person row: role 'member' with door 'member' is a member,
   * any other role 'member' is a guest (every such row before the member door was a guest).
   */
  async _tokenDoor(rt) {
    if (rt.issued_via === MEMBER_GRANT) return 'member';
    if (rt.issued_via === INVITE_GRANT) return 'guest';
    if (rt.issued_via !== undefined && rt.issued_via !== null) return null;
    if (!rt.subject || rt.subject === 'owner') return null;
    const person = await this._getDb().collection('persons').findOne({ person_id: rt.subject });
    if (!person || person.role !== 'member') return null;
    return person.door === 'member' ? 'member' : 'guest';
  }

  async _memberAccessIsFrozen() {
    if (this._memberAccessFrozen) return Boolean(await this._memberAccessFrozen());
    const { MEMBER_ACCESS_FROZEN } = await import('./invites.js');
    return MEMBER_ACCESS_FROZEN;
  }

  async _invitesAreFrozen() {
    if (this._invitesFrozen) return Boolean(await this._invitesFrozen());
    const { INVITES_FROZEN } = await import('./invites.js');
    return INVITES_FROZEN;
  }

  async _subject() {
    if (typeof this._resolveSubject === 'function') {
      try { return (await this._resolveSubject()) || 'owner'; }
      catch { return 'owner'; }
    }
    try {
      const { resolveTokenSubject } = await import('./persons.js');
      return await resolveTokenSubject(this._getDb());
    } catch {
      return 'owner';
    }
  }

  async _issueTokens(clientId, scopes, resource, subjectOverride = null, issuedVia = null, family = null, sourceTag = null) {
    const now = Math.floor(Date.now() / 1000);
    const subject = subjectOverride || await this._subject();
    const fam = family || randTok(16);
    // Only a door grant (guest 'invite' or 'member') is marked; passphrase rows keep today's shape.
    const via = DOOR_GRANTS.has(issuedVia) ? { issued_via: issuedVia } : {};
    const access = randTok(32);
    await this.col('tokens').insertOne({
      token: tokenDigest(access), hashed: true, kind: 'access', client_id: clientId, scopes, resource: resource || null,
      subject, ...via, family: fam, source_tag: sourceTag || null, expiresAt: now + ACCESS_TTL_S, createdAt: new Date(),
    });
    const refresh = randTok(32);
    await this.col('tokens').insertOne({
      token: tokenDigest(refresh), hashed: true, kind: 'refresh', client_id: clientId, scopes, resource: resource || null,
      subject, ...via, family: fam, source_tag: sourceTag || null, expiresAt: now + REFRESH_TTL_S, createdAt: new Date(),
    });
    const out = { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh };
    if (scopes && scopes.length) out.scope = scopes.join(' ');
    return out;
  }

  async verifyAccessToken(token) {
    // InvalidTokenError is what the SDK bearer middleware answers with 401 and a
    // WWW-Authenticate header, so the client refreshes or re-authorizes. A plain
    // Error here became a 500 server_error for every expired or revoked login.
    // No double quotes in these messages: they are copied into that header.
    const doc = await this._findToken(token, 'access');
    if (!doc) throw new InvalidTokenError('this access token is not recognised (it may have been revoked or replaced) - sign in again');
    if (doc.expiresAt && doc.expiresAt * 1000 < Date.now()) throw new InvalidTokenError('this access token has expired - refresh it or sign in again');
    return {
      token,
      clientId: doc.client_id,
      scopes: doc.scopes || [],
      expiresAt: doc.expiresAt,
      extra: { subject: doc.subject || 'owner', sourceTag: doc.source_tag || null },
    };
  }

  async revokeToken(client, request) {
    const tokens = this.col('tokens');
    const r = await tokens.deleteOne({ token: tokenDigest(request.token), client_id: client.client_id });
    if (r.deletedCount) return;
    const clear = await tokens.findOne({ token: request.token, client_id: client.client_id }); // a pre-H2 clear row
    if (clear && clear.hashed !== true) await tokens.deleteOne({ _id: clear._id });
  }
}
