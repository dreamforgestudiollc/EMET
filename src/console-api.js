/**
 * EMET Console HTTP API. Thin routes in front of dispatch.js.
 *
 * Off unless EMET_CONSOLE_ORIGINS lists the caller's exact origin.
 * Every memory and document call goes through dispatchTool. This file
 * does not read or write a memory layer or a document collection itself.
 * A key-door token is refused on every owner route with EMET-AUTH-046.
 */

import express from 'express';
import { actorStore } from './persons.js';
import { ApproveThrottle } from './approve-throttle.js';
import { EMET_VERSION } from './version.js';
import { registeredSourceTags } from './setup.js';
import {
  CONSOLE_SCOPE, CONSOLE_SOURCE_TAG, CONSOLE_API_VERSION, CONSOLE_NOTE_LAYERS,
  consoleApiEnabled, originAllowed, consoleAudience, consoleNow,
  findRefreshByDevice
} from './console-session.js';
import { deleteConsoleDevice, deleteConsoleForKey, deleteOwnerConsoleSessions, endConsoleFamily, refreshConsoleSession } from './oauth-provider.js';
import { adminPasswordVersion } from './admin-password.js';

export const CONSOLE_OWNER_PATHS = Object.freeze([
  '/dashboard',
  '/areas',
  '/docs',
  '/search',
  '/episodic',
  '/transcripts',
  '/notes'
]);

const MCP_SCOPES = new Set(['emet.read', 'emet.write', 'emet', '*']);
const silentLog = { info() {}, warn() {}, error() {}, debug() {}, audit() {}, log() {} };

function ownerRoute(path) {
  return CONSOLE_OWNER_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function sendJson(req, res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (res.locals.consoleCors) {
    res.setHeader('Access-Control-Allow-Origin', res.locals.consoleOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }
  res.status(status).json(body);
}

function safeMessage(message) {
  const text = typeof message === 'string' ? message : 'Refused.';
  if (/mongodb(\+srv)?:\/\//i.test(text) || text.includes('EMET_') || text.length > 500) {
    return 'The console could not complete that. Nothing was written.';
  }
  return text;
}

function unwrap(result) {
  let body = null;
  try {
    body = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  } catch {
    body = null;
  }
  if (!body || result.isError || body.success === false) {
    const err = body && body.error ? body.error : {};
    const code = typeof err.emet_code === 'string' ? err.emet_code : 'EMET-INT-001';
    const status = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
    return { ok: false, status, code, message: safeMessage(err.message) };
  }
  return { ok: true, data: body.data !== undefined ? body.data : body };
}

async function callDispatch(deps, auth, name, args, scopes) {
  const actor = {
    personId: (auth.extra && auth.extra.subject) || 'owner',
    ownerId: (auth.extra && auth.extra.subject) || 'owner',
    clientId: auth.clientId || 'emet-console',
    scopes,
    transport: 'http',
    authenticated: true,
    sourceTag: CONSOLE_SOURCE_TAG,
    sourceBasis: 'login',
    grantId: (auth.extra && auth.extra.grantId) || null,
    door: 'owner',
    keyId: null
  };
  const ctx = { dbManager: deps.dbManager, logger: silentLog, AuditOperation: deps.AuditOperation || {} };
  const result = await actorStore.run(actor, () => deps.dispatchTool(name, args, ctx));
  return unwrap(result);
}

function limitOf(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function firstSection(text) {
  const parts = String(text || '').split(/\n(?=## )/);
  return (parts[0] || '').trim().slice(0, 4000);
}

function stateLine(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const patch = lines.find((line) => line.startsWith('- ') || line.startsWith('* ')) || lines[0] || '';
  return patch.slice(0, 500);
}

function countOf(data) {
  if (Array.isArray(data)) return data.length;
  if (data && Array.isArray(data.memories)) return data.memories.length;
  if (data && Array.isArray(data.results)) return data.results.length;
  if (data && Array.isArray(data.entries)) return data.entries.length;
  if (data && Number.isInteger(data.count)) return data.count;
  return 0;
}

async function requireConsole(req, res, deps) {
  const header = String(req.get('authorization') || '');
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    deps.throttle.recordFailure(req.ip);
    sendJson(req, res, 401, { error: 'invalid_token', emet_code: 'EMET-AUTH-024', message: 'Sign in to the console. Nothing was served.' });
    return null;
  }
  let auth;
  try { auth = await deps.provider.verifyAccessToken(match[1]); }
  catch {
    deps.throttle.recordFailure(req.ip);
    sendJson(req, res, 401, { error: 'invalid_token', emet_code: 'EMET-AUTH-024', message: 'This console login is not recognised. Nothing was served.' });
    return null;
  }
  const scopes = Array.isArray(auth.scopes) ? auth.scopes : [];
  const consoleToken = scopes.length === 1 && scopes[0] === CONSOLE_SCOPE && auth.extra && auth.extra.console === true;
  const mcp = scopes.some((scope) => MCP_SCOPES.has(scope));
  if (!consoleToken || mcp) {
    deps.throttle.recordFailure(req.ip);
    sendJson(req, res, 401, { error: 'invalid_token', emet_code: 'EMET-AUTH-024', message: 'This login cannot call the console. Nothing was served.' });
    return null;
  }
  const audience = consoleAudience(deps.publicUrl);
  if (auth.extra.resource !== audience) {
    deps.throttle.recordFailure(req.ip);
    sendJson(req, res, 401, { error: 'invalid_token', emet_code: 'EMET-AUTH-024', message: 'This login is for a different server. Nothing was served.' });
    return null;
  }
  return auth;
}

function refuseKey(req, res, deps) {
  sendJson(req, res, 403, {
    error: 'invalid_token',
    emet_code: 'EMET-AUTH-046',
    message: 'A key sign-in cannot open the console. Nothing was served.'
  });
}

async function ownerAuth(req, res, deps) {
  const auth = await requireConsole(req, res, deps);
  if (!auth) return null;
  const door = auth.extra && auth.extra.door;
  if (door !== 'owner') {
    refuseKey(req, res, deps);
    return null;
  }
  const db = deps.db();
  const version = await adminPasswordVersion(db);
  if (auth.extra.adminPasswordVersion !== version) {
    await deleteOwnerConsoleSessions(db, deps.provider.prefix);
    deps.throttle.recordFailure(req.ip);
    sendJson(req, res, 401, { error: 'invalid_token', emet_code: 'EMET-AUTH-024', message: 'The admin password changed. Sign in again. Nothing was served.' });
    return null;
  }
  return auth;
}

function docPath(req) {
  const full = String(req.originalUrl || req.url || '').split('?')[0];
  const marker = '/console/api/docs/';
  const at = full.indexOf(marker);
  if (at < 0) return '';
  try { return decodeURIComponent(full.slice(at + marker.length)); }
  catch { return full.slice(at + marker.length); }
}

export function mountConsole(app, deps) {
  const throttle = deps.throttle || new ApproveThrottle();
  const bound = { ...deps, throttle };
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!consoleApiEnabled()) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const origin = req.get('origin');
    if (originAllowed(origin)) {
      res.locals.consoleCors = true;
      res.locals.consoleOrigin = origin;
    }
    if (req.method === 'OPTIONS') {
      if (!res.locals.consoleCors) {
        res.status(404).end();
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', res.locals.consoleOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Vary', 'Origin');
      res.status(204).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'method_not_allowed', message: 'Documents and notes use the methods the console lists. Nothing was written.' });
      return;
    }
    const gate = throttle.check(req.ip);
    if (!gate.allowed) {
      res.setHeader('Retry-After', String(gate.retryAfterS));
      sendJson(req, res, 429, { error: 'rate_limited', message: 'Too many attempts. Try again later.' });
      return;
    }
    next();
  });

  router.use(express.json({ limit: '64kb' }));

  router.get('/meta', async (_req, res) => {
    let name = 'EMET';
    try {
      const db = bound.db();
      const person = db ? await db.collection('persons').findOne({ role: 'owner' }) : null;
      if (person && typeof person.display_name === 'string' && person.display_name.trim()) {
        name = person.display_name.trim().slice(0, 80);
      }
    } catch { /* the name stays EMET */ }
    sendJson(_req, res, 200, {
      name,
      version: EMET_VERSION,
      console_api: CONSOLE_API_VERSION,
      features: {
        phase: 1,
        add_note: true,
        remember_device: true,
        security_settings: false
      }
    });
  });

  router.get('/session', async (req, res) => {
    const auth = await requireConsole(req, res, bound);
    if (!auth) return;
    const db = bound.db();
    const deviceId = auth.extra.deviceId || null;
    const row = deviceId ? await findRefreshByDevice(db, bound.provider.prefix, deviceId) : null;
    sendJson(req, res, 200, {
      door: auth.extra.door || null,
      remember: Boolean(row),
      device_id: row ? row.device_id : null,
      nonce: row ? row.nonce : null,
      step_up: null,
      expires_at: auth.expiresAt || null
    });
  });

  router.post('/session/refresh', async (req, res) => {
    const db = bound.db();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await refreshConsoleSession(db, bound.provider.prefix, body, async (row) => {
      if (row.door === 'owner') {
        const version = await adminPasswordVersion(db);
        if (row.admin_password_version !== version) {
          const err = new Error('password changed');
          throw err;
        }
        return;
      }
      if (row.door === 'key' || row.door === 'secondary') {
        if (!row.key_id) {
          const err = new Error('no key');
          throw err;
        }
        const { assertKeyConsentLive } = await import('./subkeys.js');
        const { approvalsDeps } = await import('./tools.js');
        await assertKeyConsentLive({
          ...approvalsDeps,
          endConsents: (keyId) => deleteConsoleForKey(db, bound.provider.prefix, keyId)
        }, {
          keyId: row.key_id,
          tag: row.source_tag,
          registry: registeredSourceTags(),
          now: new Date(consoleNow())
        });
        return;
      }
      const err = new Error('door');
      throw err;
    });
    if (!result.ok) {
      throttle.recordFailure(req.ip);
      sendJson(req, res, 401, { error: 'invalid_grant' });
      return;
    }
    const issued = await bound.provider.issueConsoleAccess({
      clientId: result.client_id,
      subject: result.subject,
      door: result.door,
      sourceTag: result.door === 'owner' ? CONSOLE_SOURCE_TAG : result.source_tag,
      keyId: result.key_id,
      adminPasswordVersion: result.admin_password_version,
      deviceId: result.device_id,
      family: result.family,
      resource: consoleAudience(bound.publicUrl)
    });
    throttle.recordSuccess(req.ip);
    sendJson(req, res, 200, {
      access_token: issued.access_token,
      token_type: 'bearer',
      expires_in: issued.expires_in,
      refresh_token: result.refresh_token,
      nonce: result.nonce,
      device_id: result.device_id,
      step_up: null
    });
  });

  router.post('/session/end', async (req, res) => {
    const auth = await requireConsole(req, res, bound);
    if (!auth) return;
    await endConsoleFamily(bound.db(), bound.provider.prefix, {
      family: auth.extra.grantId,
      deviceId: auth.extra.deviceId || null
    });
    if (auth.extra.deviceId) {
      await deleteConsoleDevice(bound.db(), auth.extra.deviceId, bound.provider.prefix);
    }
    throttle.recordSuccess(req.ip);
    sendJson(req, res, 200, { ended: true });
  });

  router.get('/dashboard', async (req, res) => {
    const auth = await ownerAuth(req, res, bound);
    if (!auth) return;
    const areas = await callDispatch(bound, auth, 'emet_pages', {}, ['emet.read']);
    const state = await callDispatch(bound, auth, 'read_doc', { doc_id: 'STATE.md', offset: 0 }, ['emet.read']);
    const handoff = await callDispatch(bound, auth, 'read_doc', { doc_id: 'HANDOFF.md', offset: 0 }, ['emet.read']);
    const recent = await callDispatch(bound, auth, 'query_layer', { layer: 'episodic', options: { limit: 50 } }, ['emet.read']);
    sendJson(req, res, 200, {
      as_of: new Date(consoleNow()).toISOString(),
      areas: areas.ok ? areas.data : null,
      state_line: state.ok ? stateLine(state.data && state.data.content) : null,
      handoff: handoff.ok ? firstSection(handoff.data && handoff.data.content) : null,
      recent_episodic: recent.ok ? countOf(recent.data) : null
    });
  });

  router.get('/areas/:slug', async (req, res) => {
    const auth = await ownerAuth(req, res, bound);
    if (!auth) return;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug || '')) {
      sendJson(req, res, 400, { error: 'bad_request', message: 'That area name is not valid. Nothing was served.' });
      return;
    }
    const page = await callDispatch(bound, auth, 'emet_page', { area: req.params.slug }, ['emet.read']);
    if (!page.ok) {
      sendJson(req, res, page.status, { error: 'refused', emet_code: page.code, message: page.message });
      return;
    }
    sendJson(req, res, 200, page.data);
  });

  router.get('/docs', async (req, res) => {
    const auth = await ownerAuth(req, res, bound);
    if (!auth) return;
    const listed = await callDispatch(bound, auth, 'list_docs', { prefix: req.query.prefix || null, include_retired: true }, ['emet.read']);
    if (!listed.ok) {
      sendJson(req, res, listed.status, { error: 'refused', emet_code: listed.code, message: listed.message });
      return;
    }
    const docs = listed.data && Array.isArray(listed.data.documents) ? listed.data.documents : [];
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = limitOf(req.query.limit, 50, 50);
    sendJson(req, res, 200, {
      ...listed.data,
      documents: docs.slice(offset, offset + limit),
      offset,
      limit
    });
  });

  router.use('/docs', async (req, res, next) => {
    if (req.method !== 'GET' || req.path === '/docs' || req.path === '/docs/') return next();
    const auth = await ownerAuth(req, res, bound);
    if (!auth) return;
    let id = docPath(req);
    let history = false;
    if (id.endsWith('/history')) {
      history = true;
      id = id.slice(0, -'/history'.length);
    }
    if (!id) {
      sendJson(req, res, 400, { error: 'bad_request', message: 'Name the document. Nothing was served.' });
      return;
    }
    const offset = Number(req.query.offset) || 0;
    const tool = history ? 'read_doc_history' : 'read_doc';
    const args = history
      ? { doc_id: id, version: req.query.version ?? null, offset, limit: req.query.limit, after_version: req.query.after_version, expected_sha256: req.query.expected_sha256 }
      : { doc_id: id, offset, limit: req.query.limit, expected_version: req.query.expected_version, expected_sha256: req.query.expected_sha256 };
    const read = await callDispatch(bound, auth, tool, args, ['emet.read']);
    if (!read.ok) {
      sendJson(req, res, read.status, { error: 'refused', emet_code: read.code, message: read.message });
      return;
    }
    sendJson(req, res, 200, read.data);
  });

  router.get('/search', async (req, res) => {
    const auth = await ownerAuth(req, res, bound);
    if (!auth) return;
    const mode = req.query.mode === 'semantic' ? 'semantic' : (req.query.mode === 'keyword' || !req.query.mode ? 'keyword' : null);
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (!mode || !query.trim()) {
      sendJson(req, res, 400, { error: 'bad_request', emet_code: 'EMET-VAL-005', message: 'Say what to search for. Nothing was served.' });
      return;
    }
    const limit = limitOf(req.query.limit, 20, 50);
    const layer = typeof req.query.layer === 'string' && req.query.layer ? req.query.layer : null;
    const tool = mode === 'semantic' ? 'semantic_recall' : 'recall';
    const args = mode === 'semantic'
      ? { query, layer, limit, history: true }
      : { query, layer, limit, history: true, order: 'latest' };
    const found = await callDispatch(bound, auth, tool, args, ['emet.read']);
    if (!found.ok) {
      sendJson(req, res, found.status, { error: 'refused', emet_code: found.code, message: found.message });
      return;
    }
    sendJson(req, res, 200, { mode, data: found.data });
  });

  router.get('/episodic/recent', async (req, res) => {
    const auth = await ownerAuth(req, res, bound);
    if (!auth) return;
    const limit = limitOf(req.query.limit, 20, 50);
    const recent = await callDispatch(bound, auth, 'query_layer', { layer: 'episodic', options: { limit } }, ['emet.read']);
    if (!recent.ok) {
      sendJson(req, res, recent.status, { error: 'refused', emet_code: recent.code, message: recent.message });
      return;
    }
    sendJson(req, res, 200, recent.data);
  });

  router.get('/transcripts/:session_id', async (req, res) => {
    const auth = await ownerAuth(req, res, bound);
    if (!auth) return;
    const start = Number(req.query.timestamp_start);
    const end = Number(req.query.timestamp_end);
    const args = {
      session_id: req.params.session_id,
      timestamp_start: Number.isFinite(start) ? start : 0,
      timestamp_end: Number.isFinite(end) ? end : Math.floor(consoleNow() / 1000) + 60,
      limit: limitOf(req.query.limit, 50, 50),
      offset: Number(req.query.offset) || 0,
      page_bytes: req.query.page_bytes,
      exchange_offset: req.query.exchange_offset,
      expected_sha256: req.query.expected_sha256
    };
    const page = await callDispatch(bound, auth, 'query_transcripts', args, ['emet.read']);
    if (!page.ok) {
      sendJson(req, res, page.status, { error: 'refused', emet_code: page.code, message: page.message });
      return;
    }
    sendJson(req, res, 200, page.data);
  });

  router.post('/notes', async (req, res) => {
    const auth = await ownerAuth(req, res, bound);
    if (!auth) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const layer = typeof body.layer === 'string' ? body.layer : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (!CONSOLE_NOTE_LAYERS.includes(layer)) {
      sendJson(req, res, 400, { error: 'bad_request', emet_code: 'EMET-MEM-001', message: 'A note can be episodic, semantic, or working. Nothing was written.' });
      return;
    }
    if (!content.trim()) {
      sendJson(req, res, 400, { error: 'bad_request', emet_code: 'EMET-VAL-001', message: 'The note is empty. Nothing was written.' });
      return;
    }
    if (!registeredSourceTags().includes(CONSOLE_SOURCE_TAG)) {
      sendJson(req, res, 403, {
        error: 'refused',
        emet_code: 'EMET-DOC-020',
        message: 'The emet-console tag is not registered on this server. Nothing was written.'
      });
      return;
    }
    let tags;
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.length > 8 || body.tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9-]{1,40}$/.test(tag))) {
        sendJson(req, res, 400, { error: 'bad_request', message: 'Tags are short words. Nothing was written.' });
        return;
      }
      tags = body.tags;
    }
    const started = await callDispatch(bound, auth, 'emet_initialize', { page: 'all' }, ['emet.read']);
    if (!started.ok) {
      sendJson(req, res, started.status, { error: 'refused', emet_code: started.code, message: started.message });
      return;
    }
    const loadId = started.data && started.data.startup_page && started.data.startup_page.load_id;
    if (!loadId) {
      sendJson(req, res, 400, { error: 'refused', message: 'The console could not open a session for this note. Nothing was written.' });
      return;
    }
    const opened = await callDispatch(bound, auth, 'emet_session_open', { slug: 'emet-console', load_id: loadId, source: CONSOLE_SOURCE_TAG }, ['emet.write']);
    if (!opened.ok) {
      sendJson(req, res, opened.status, { error: 'refused', emet_code: opened.code, message: opened.message });
      return;
    }
    const sessionId = opened.data && opened.data.session_id;
    const saved = await callDispatch(bound, auth, 'save_to_layer', {
      content,
      layer,
      session_id: sessionId,
      metadata: {
        source: CONSOLE_SOURCE_TAG,
        app_version: String(CONSOLE_API_VERSION),
        ...(tags ? { tags } : {})
      }
    }, ['emet.write']);
    if (!saved.ok) {
      sendJson(req, res, saved.status, { error: 'refused', emet_code: saved.code, message: saved.message });
      return;
    }
    const base = opened.data && opened.data.base;
    const appended = await callDispatch(bound, auth, 'emet_transcript_append', {
      session_id: sessionId,
      user_message: 'Add note',
      assistant_message: 'no local shell MCP. Note saved.',
      source: CONSOLE_SOURCE_TAG
    }, ['emet.write']);
    if (!appended.ok) {
      sendJson(req, res, appended.status, { error: 'refused', emet_code: appended.code, message: appended.message });
      return;
    }
    const closed = await callDispatch(bound, auth, 'emet_session_close', {
      session_id: sessionId,
      source: CONSOLE_SOURCE_TAG,
      receipts: {
        working_docs: [],
        episodic_id: saved.data && saved.data.id,
        transcript_session_id: base,
        transcript_parts: [sessionId],
        transcript_exchanges: 1
      }
    }, ['emet.write']);
    if (!closed.ok || !closed.data || closed.data.state !== 'complete') {
      const why = closed.ok ? 'The console note was saved, and the session did not close.' : closed.message;
      sendJson(req, res, closed.ok ? 500 : closed.status, { error: 'refused', message: why, missing: closed.data && closed.data.missing });
      return;
    }
    throttle.recordSuccess(req.ip);
    sendJson(req, res, 200, { receipt: saved.data });
  });

  router.use((req, res) => {
    if (!ownerRoute(req.path)) {
      sendJson(req, res, 404, { error: 'not_found' });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(req, res, 405, { error: 'method_not_allowed', message: 'That console route is read-only. Nothing was written.' });
      return;
    }
    sendJson(req, res, 404, { error: 'not_found' });
  });

  router.use((err, req, res, _next) => {
    if (res.headersSent) return;
    const tooBig = err && (err.type === 'entity.too.large' || err.status === 413);
    sendJson(req, res, tooBig ? 413 : 400, {
      error: tooBig ? 'payload_too_large' : 'bad_request',
      message: tooBig ? 'That is larger than the console accepts. Nothing was written.' : 'The request body is not valid. Nothing was written.'
    });
  });

  app.use('/console/api', router);
}

export function consoleTokenOnMcp(auth) {
  const scopes = auth && Array.isArray(auth.scopes) ? auth.scopes : [];
  return scopes.includes(CONSOLE_SCOPE) || Boolean(auth && auth.extra && auth.extra.console);
}
