/**
 * EMET Console phase 1. Behavior of /console/api, the owner door, and remember-this-phone.
 * In-memory store. No network. No production secrets.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';

const CONNECT = 'connect-passphrase-value';
const ADMIN = 'admin-password-value';
const PEPPER = 'console-pepper-console-pepper-32bytes';
const REDIRECT = 'https://console.example/callback';
const ORIGIN = 'https://console.example';
const PUBLIC = 'http://127.0.0.1:8849';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.EMET_UNDER_TEST = '1';
process.env.EMET_HTTP_LISTEN = '0';
process.env.EMET_OAUTH_PASSPHRASE = CONNECT;
process.env.EMET_REQUEST_LOG = '0';
process.env.LOG_LEVEL = 'error';
process.env.PUBLIC_URL = PUBLIC;
process.env.EMET_CONSOLE_ORIGINS = '';
process.env.EMET_SOURCE_TAGS = 'emet-console,note-bot,project-host,hub-bot';
process.env.EMET_SUBKEYS = '1';
process.env.EMET_SUBKEY_PEPPER = PEPPER;
delete process.env.EMET_ADMIN_PEPPER;

const { makeStore, withStore } = await import('./memstore.js');
const { createAdminPassword, rotateAdminPassword, adminPasswordVersion } = await import('../src/admin-password.js');
const { MongoOAuthProvider } = await import('../src/oauth-provider.js');
const { setConsoleClockForTests, consoleNow } = await import('../src/console-session.js');
const { deleteConsoleDevice } = await import('../src/oauth-provider.js');
const { CONSOLE_MERMAID } = await import('../src/console-statechart.js');
const { requestLogger, requestLogEntry, formatRequestLog } = await import('../src/request-log.js');
const { hostTools } = await import('../src/tools.js');
const remote = await import('../src/http-remote.js');

const server = await new Promise((resolve) => {
  const listening = remote.app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;
const audience = `${PUBLIC}/console/api`;

const TOOL_NAMES = Object.freeze([
  'emet_initialize', 'emet_status', 'emet_setup_complete', 'corpus_recall', 'recall', 'query_layer',
  'save_to_layer', 'revise_memory', 'revise_transcript', 'query_transcripts', 'save_transcript',
  'emet_session_open', 'emet_transcript_append', 'read_doc', 'read_doc_history', 'write_doc',
  'write_doc_begin', 'write_doc_append', 'write_doc_commit', 'write_doc_abort', 'list_docs',
  'retire_doc', 'rename_doc', 'restore_doc', 'validate_doc', 'accept_nonconformance', 'patch_doc',
  'semantic_recall', 'emet_page', 'emet_pages', 'emet_error_report', 'emet_page_lint', 'emet_gaps',
  'emet_floor', 'emet_client_approve', 'emet_invite_create', 'emet_member_access_create', 'emet_session_close'
]);

const OWNER_ROUTES = Object.freeze([
  ['GET', '/console/api/dashboard'],
  ['GET', '/console/api/areas/notes'],
  ['GET', '/console/api/docs'],
  ['GET', '/console/api/docs/STATE.md'],
  ['GET', '/console/api/docs/HANDOFF.md'],
  ['GET', '/console/api/docs/STATE.md/history'],
  ['GET', '/console/api/search?mode=keyword&q=hello'],
  ['GET', '/console/api/episodic/recent'],
  ['GET', '/console/api/transcripts/2026-11-24_example'],
  ['POST', '/console/api/notes']
]);

let ipN = 10;
function nextIp() {
  ipN += 1;
  return `203.0.113.${ipN}`;
}

function device() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pub = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  return {
    privateKey,
    encoded: Buffer.from(JSON.stringify(pub)).toString('base64url'),
    sign(nonce, timestamp) {
      return crypto.sign('sha256', Buffer.from(`${nonce}.${timestamp}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    }
  };
}

async function prepare(db) {
  remote.dbManager.db = db;
  const created = await createAdminPassword(db, ADMIN, ADMIN);
  assert.equal(created.ok, true);
  await db.collection('emet_oauth_clients').insertOne({
    client_id: 'console-test', client_name: 'Console', redirect_uris: [REDIRECT]
  });
  return db;
}

async function postApprove(db, fields, ip = nextIp()) {
  remote.dbManager.db = db;
  const body = new URLSearchParams({
    client_id: 'console-test',
    redirect_uri: REDIRECT,
    code_challenge: 'challenge',
    resource: audience
  });
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return withStore(db, async () => {
    const res = await fetch(`${base}/oauth/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
      body: body.toString()
    });
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  });
}

function codeFrom(location) {
  return new URL(location).searchParams.get('code');
}

async function exchange(db, location) {
  const provider = new MongoOAuthProvider(() => db, { passphrase: CONNECT, issuerUrl: PUBLIC });
  return provider.exchangeAuthorizationCode({ client_id: 'console-test' }, codeFrom(location), null, REDIRECT, null);
}

async function ownerLogin(db, extra = {}) {
  const posted = await postApprove(db, { scopes: 'emet.console', password: ADMIN, ...extra });
  assert.equal(posted.status, 302, posted.text.slice(0, 300));
  const issued = await exchange(db, posted.location);
  return issued;
}

async function api(pathname, { method = 'GET', token, origin, body, ip = nextIp() } = {}) {
  const headers = { 'x-forwarded-for': ip };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin !== undefined) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const names = [...res.headers.keys()];
  return { status: res.status, text, headers: res.headers, names, json: text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null };
}

function corsNames(names) {
  return names.filter((name) => name.toLowerCase().startsWith('access-control-'));
}

console.log('\n=== EMET Console ===');

testGroup('1. the console API is off until an origin is listed', () => {
  test('unset and empty origins answer 404 with no CORS headers', async () => {
    const paths = ['/console/api/meta', '/console/api/dashboard', '/console/api/notes', '/console/api/session/refresh'];
    for (const value of [undefined, '', '   ', ' , ']) {
      if (value === undefined) delete process.env.EMET_CONSOLE_ORIGINS;
      else process.env.EMET_CONSOLE_ORIGINS = value;
      for (const pathname of paths) {
        const method = pathname.endsWith('notes') || pathname.endsWith('refresh') ? 'POST' : 'GET';
        const res = await api(pathname, { method, origin: ORIGIN, body: method === 'POST' ? {} : undefined });
        assert.equal(res.status, 404, `${value} ${pathname} ${res.text}`);
        assert.deepEqual(corsNames(res.names), []);
        assert.equal(res.text.includes('*'), false);
      }
    }
  });
});

testGroup('2. CORS is the exact origin and nothing else', () => {
  test('a listed origin is echoed, and near-misses get no allow header', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const ok = await api('/console/api/meta', { origin: ORIGIN });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(ok.headers.get('access-control-allow-credentials'), null);
    assert.equal(String(ok.headers.get('vary')).includes('Origin'), true);
    assert.equal(ok.text.includes('*'), false);
    const pre = await api('/console/api/meta', { method: 'OPTIONS', origin: ORIGIN });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(pre.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
    assert.equal(pre.headers.get('access-control-max-age'), '600');
    assert.equal(pre.headers.get('access-control-allow-credentials'), null);
    const dot = await api('/console/api/meta', { origin: ORIGIN });
    assert.equal(dot.status, 200);
    assert.equal(dot.headers.get('access-control-allow-origin'), ORIGIN);
    const health = await fetch(`${base}/health`, { headers: { origin: ORIGIN } });
    assert.equal(health.headers.get('access-control-allow-origin'), null);
    const misses = [
      'https://console.example.evil',
      'https://evilconsole.example',
      'https://console.example:444',
      'http://console.example',
      'https://console.example/',
      'null',
      'https://console.exampl',
      ORIGIN + '.other'
    ];
    for (const origin of misses) {
      const res = await api('/console/api/meta', { origin });
      assert.deepEqual(corsNames(res.names), [], origin);
      assert.equal(res.text.includes('*'), false);
    }
  });
});

testGroup('3. a key-door token cannot open an owner route', () => {
  test('every owner route is EMET-AUTH-046 and notes write nothing', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const { approvalsDeps } = await import('../src/tools.js');
    const { createMemoryStore } = await import('../src/subkey-store.js');
    const { requestSubkey, decideSubkeyIfPending, claimSubkey } = await import('../src/subkeys.js');
    const memory = createMemoryStore();
    approvalsDeps.subkeys = memory;
    const owner = {
      personId: 'owner', ownerId: 'owner', clientId: 'owner-host', transport: 'http',
      authenticated: true, sourceTag: 'project-host', sourceBasis: 'login', door: 'owner', scopes: ['emet']
    };
    const bot = { ...owner, clientId: 'note-client', sourceTag: 'hub-bot' };
    const now = new Date('2026-11-24T16:00:00.000Z');
    const registry = process.env.EMET_SOURCE_TAGS.split(',');
    const req = await requestSubkey({ subkeys: memory }, bot, { tag: 'note-bot' }, registry, now);
    await decideSubkeyIfPending({ subkeys: memory }, owner, 'owner', { tag: 'note-bot', decision: 'approve' }, now);
    const claimed = await claimSubkey({ subkeys: memory }, bot, { key_id: req.key_id, nonce: req.nonce }, now);
    const posted = await postApprove(db, { scopes: 'emet.console', subkey: claimed.subkey, source: 'note-bot' });
    assert.equal(posted.status, 302, posted.text.slice(0, 400));
    const issued = await exchange(db, posted.location);
    assert.equal(issued.scope, 'emet.console');
    const before = await db.collection('emet_episodic').countDocuments({});
    for (const [method, pathname] of OWNER_ROUTES) {
      const res = await api(pathname, {
        method,
        token: issued.access_token,
        origin: ORIGIN,
        body: method === 'POST' ? { layer: 'episodic', content: 'a key must not write this' } : undefined
      });
      assert.equal(res.status, 403, pathname);
      assert.equal(res.json && res.json.emet_code, 'EMET-AUTH-046', pathname);
      assert.equal(JSON.stringify(res.json).includes('a key must not write'), false);
      assert.equal(res.json.areas, undefined);
      assert.equal(res.json.receipt, undefined);
    }
    assert.equal(await db.collection('emet_episodic').countDocuments({}), before);
  });
});

testGroup('4. tokens stay on their own door and their own server', () => {
  test('an MCP token is refused on the console, and a console token is refused on /mcp', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const mcpPosted = await postApprove(db, { scopes: 'emet.read emet.write', passphrase: CONNECT });
    assert.equal(mcpPosted.status, 302, mcpPosted.text.slice(0, 300));
    const mcp = await exchange(db, mcpPosted.location);
    const refused = await api('/console/api/dashboard', { token: mcp.access_token, origin: ORIGIN });
    assert.equal(refused.status, 401);
    assert.notEqual(refused.json && refused.json.emet_code, 'EMET-AUTH-046');
    const owner = await ownerLogin(db);
    const mcpCall = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.access_token}`, 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    const mcpText = await mcpCall.text();
    assert.equal(mcpCall.status, 401, mcpText.slice(0, 300));
    assert.equal(mcpText.includes('tools'), false);
  });

  test('a token minted by server A is refused by server B', async () => {
    const password = 'server-admin-password';
    function start(env) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(ROOT, 'tests/console-instance.mjs')], {
          cwd: ROOT,
          env: {
            ...process.env,
            ...env,
            EMET_HTTP_LISTEN: '0',
            EMET_REQUEST_LOG: '0',
            EMET_TEST_ADMIN_PASSWORD: password,
            EMET_CONSOLE_ORIGINS: ORIGIN,
            EMET_SOURCE_TAGS: 'emet-console'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`instance did not listen\n${err}`));
        }, 20000);
        child.stdout.on('data', (buf) => {
          out += buf.toString();
          const line = out.trim().split('\n').find((item) => /^\d+$/.test(item));
          if (line) {
            clearTimeout(timer);
            resolve({ port: Number(line), child });
          }
        });
        child.stderr.on('data', (buf) => { err += buf.toString(); });
        child.on('exit', (code) => {
          if (!out.trim()) reject(new Error(`instance exited ${code}\n${err}`));
        });
      });
    }
    const verifier = 'b'.repeat(64);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const a = await start({
      PUBLIC_URL: 'http://127.0.0.1:19001',
      EMET_OAUTH_PASSPHRASE: 'connect-server-a-value',
      EMET_COLLECTION_PREFIX: 'a_'
    });
    const b = await start({
      PUBLIC_URL: 'http://127.0.0.1:19002',
      EMET_OAUTH_PASSPHRASE: 'connect-server-b-value',
      EMET_COLLECTION_PREFIX: 'b_'
    });
    try {
      const posted = await fetch(`http://127.0.0.1:${a.port}/oauth/approve`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'console-test',
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          scopes: 'emet.console',
          password,
          resource: 'http://127.0.0.1:19001/console/api'
        }).toString()
      });
      assert.equal(posted.status, 302, await posted.text());
      const code = new URL(posted.headers.get('location')).searchParams.get('code');
      const tokenRes = await fetch(`http://127.0.0.1:${a.port}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: 'console-test',
          code_verifier: verifier,
          code_challenge_method: 'S256'
        }).toString()
      });
      const tokenBody = await tokenRes.json();
      assert.equal(typeof tokenBody.access_token, 'string');
      const foreign = await fetch(`http://127.0.0.1:${b.port}/console/api/dashboard`, {
        headers: { authorization: `Bearer ${tokenBody.access_token}`, origin: ORIGIN }
      });
      const foreignText = await foreign.text();
      assert.equal(foreign.status, 401, foreignText.slice(0, 200));
      assert.equal(foreignText.includes(tokenBody.access_token), false);
    } finally {
      a.child.kill();
      b.child.kill();
    }
  });
});

testGroup('5. the console owner door is the admin password', () => {
  test('the connect passphrase is refused and the admin password is accepted', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const page = await fetch(`${base}/authorize?client_id=console-test&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=challenge&code_challenge_method=S256&response_type=code&scope=emet.console&state=s`);
    const html = await page.text();
    assert.match(html, /name="password"/);
    assert.match(html, /Admin password/);
    assert.match(html, /Remember this phone/);
    assert.equal(/checked/.test(html), false);
    assert.equal(/name="passphrase"/.test(html), false);
    const wrong = await postApprove(db, { scopes: 'emet.console', passphrase: CONNECT });
    assert.equal(wrong.status, 401);
    assert.match(wrong.text, /connect passphrase does not open the console/);
    assert.equal(wrong.text.includes(CONNECT), false);
    assert.equal(wrong.text.includes(ADMIN), false);
    const right = await ownerLogin(db);
    assert.equal(right.scope, 'emet.console');
    assert.equal(right.expires_in, 900);
    assert.equal(right.refresh_token, undefined);
    assert.equal(right.step_up, null);
  });
});

testGroup('6. rotating the admin password ends owner console sessions', () => {
  test('the next call and the next refresh both fail', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const phone = device();
    const issued = await ownerLogin(db, { remember: '1', device_key: phone.encoded });
    assert.equal(typeof issued.refresh_token, 'string');
    const seen = await api('/console/api/meta', { token: issued.access_token, origin: ORIGIN });
    assert.equal(seen.status, 200);
    const dash = await api('/console/api/dashboard', { token: issued.access_token, origin: ORIGIN });
    assert.notEqual(dash.status, 401);
    const rotated = await rotateAdminPassword(db, ADMIN, 'admin-password-value-2', 'admin-password-value-2');
    assert.equal(rotated.ok, true);
    const again = await api('/console/api/dashboard', { token: issued.access_token, origin: ORIGIN });
    assert.equal(again.status, 401);
    const stamped = consoleNow();
    const refreshed = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: issued.refresh_token, nonce: issued.nonce, timestamp: stamped, signature: phone.sign(issued.nonce, stamped) }
    });
    assert.equal(refreshed.status, 401);
    assert.equal(refreshed.text.includes(issued.refresh_token), false);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
  });
});

testGroup('7. revoking a key deletes its console token and refresh row', () => {
  test('the next refresh fails', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const { approvalsDeps } = await import('../src/tools.js');
    const { createMemoryStore } = await import('../src/subkey-store.js');
    const { requestSubkey, decideSubkeyIfPending, claimSubkey, revokeSubkey } = await import('../src/subkeys.js');
    const { revokeTokensForKey } = await import('../src/oauth-provider.js');
    const memory = createMemoryStore();
    approvalsDeps.subkeys = memory;
    const owner = {
      personId: 'owner', ownerId: 'owner', clientId: 'owner-host', transport: 'http',
      authenticated: true, sourceTag: 'project-host', sourceBasis: 'login', door: 'owner', scopes: ['emet']
    };
    const bot = { ...owner, clientId: 'note-client', sourceTag: 'hub-bot' };
    const now = new Date('2026-11-24T16:00:00.000Z');
    const registry = process.env.EMET_SOURCE_TAGS.split(',');
    const deps = { subkeys: memory, endConsents: (keyId) => revokeTokensForKey(db, 'emet_', keyId) };
    const req = await requestSubkey(deps, bot, { tag: 'note-bot' }, registry, now);
    await decideSubkeyIfPending(deps, owner, 'owner', { tag: 'note-bot', decision: 'approve' }, now);
    const claimed = await claimSubkey(deps, bot, { key_id: req.key_id, nonce: req.nonce }, now);
    const phone = device();
    const posted = await postApprove(db, {
      scopes: 'emet.console', subkey: claimed.subkey, source: 'note-bot', remember: '1', device_key: phone.encoded
    });
    assert.equal(posted.status, 302, posted.text.slice(0, 400));
    const issued = await exchange(db, posted.location);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 1);
    await revokeSubkey(deps, owner, 'owner', { key_id: req.key_id, reason: 'test' }, now);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
    const stamped = consoleNow();
    const refreshed = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: issued.refresh_token, nonce: issued.nonce, timestamp: stamped, signature: phone.sign(issued.nonce, stamped) }
    });
    assert.equal(refreshed.status, 401);
    const still = await api('/console/api/dashboard', { token: issued.access_token, origin: ORIGIN });
    assert.notEqual(still.status, 200);
  });

  test('a key refresh re-checks the key without endConsents (S-2)', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const { approvalsDeps } = await import('../src/tools.js');
    const { createMemoryStore } = await import('../src/subkey-store.js');
    const { requestSubkey, decideSubkeyIfPending, claimSubkey } = await import('../src/subkeys.js');
    const memory = createMemoryStore();
    approvalsDeps.subkeys = memory;
    const owner = {
      personId: 'owner', ownerId: 'owner', clientId: 'owner-host', transport: 'http',
      authenticated: true, sourceTag: 'project-host', sourceBasis: 'login', door: 'owner', scopes: ['emet']
    };
    const bot = { ...owner, clientId: 'note-client', sourceTag: 'hub-bot' };
    const now = new Date('2026-11-24T16:00:00.000Z');
    const registry = process.env.EMET_SOURCE_TAGS.split(',');
    const deps = { subkeys: memory };
    const req = await requestSubkey(deps, bot, { tag: 'note-bot' }, registry, now);
    await decideSubkeyIfPending(deps, owner, 'owner', { tag: 'note-bot', decision: 'approve' }, now);
    const claimed = await claimSubkey(deps, bot, { key_id: req.key_id, nonce: req.nonce }, now);
    const phone = device();
    const posted = await postApprove(db, {
      scopes: 'emet.console', subkey: claimed.subkey, source: 'note-bot', remember: '1', device_key: phone.encoded
    });
    assert.equal(posted.status, 302, posted.text.slice(0, 400));
    const issued = await exchange(db, posted.location);
    await memory.mutate((data) => {
      const row = data.keys[req.key_id];
      row.status = 'revoked';
      return true;
    });
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 1);
    const stamped = consoleNow();
    const refreshed = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: issued.refresh_token, nonce: issued.nonce, timestamp: stamped, signature: phone.sign(issued.nonce, stamped) }
    });
    assert.equal(refreshed.status, 401);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
  });
});

testGroup('8. S-2 a key-door refresh row with no key id', () => {
  test('the refresh is refused and the row is deleted', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const phone = device();
    const jwk = JSON.parse(Buffer.from(phone.encoded, 'base64url').toString('utf8'));
    const refresh = 's2-refresh-token-value';
    const nonce = 's2-nonce-value';
    const { tokenDigest } = await import('../src/console-session.js');
    await db.collection('emet_console_refresh').insertOne({
      device_id: 's2-device',
      door: 'key',
      key_id: null,
      device_public_key: jwk,
      token_hash: tokenDigest(refresh),
      previous_hash: null,
      nonce,
      created_at: consoleNow(),
      last_used_at: consoleNow(),
      idle_expires_at: consoleNow() + 86400000,
      absolute_expires_at: consoleNow() + 86400000,
      step_up: null
    });
    const stamped = consoleNow();
    const res = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: refresh, nonce, timestamp: stamped, signature: phone.sign(nonce, stamped) }
    });
    assert.equal(res.status, 401);
    assert.equal(res.text.includes(refresh), false);
    assert.equal(res.json && res.json.access_token, undefined);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
  });

  test('a refresh row for any other door is refused and deleted', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const phone = device();
    const jwk = JSON.parse(Buffer.from(phone.encoded, 'base64url').toString('utf8'));
    const refresh = 'other-door-refresh-token';
    const nonce = 'other-door-nonce';
    const { tokenDigest } = await import('../src/console-session.js');
    await db.collection('emet_console_refresh').insertOne({
      device_id: 'other-door',
      door: 'guest',
      key_id: null,
      device_public_key: jwk,
      token_hash: tokenDigest(refresh),
      previous_hash: null,
      nonce,
      created_at: consoleNow(),
      last_used_at: consoleNow(),
      idle_expires_at: consoleNow() + 86400000,
      absolute_expires_at: consoleNow() + 86400000,
      step_up: null
    });
    const stamped = consoleNow();
    const res = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: refresh, nonce, timestamp: stamped, signature: phone.sign(nonce, stamped) }
    });
    assert.equal(res.status, 401);
    assert.equal(res.json && res.json.access_token, undefined);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
  });
});

testGroup('9. remember this phone', () => {
  test('no tick means no row, and refresh re-checks, rotates, and never sets step-up', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const plain = await ownerLogin(db);
    assert.equal(plain.refresh_token, undefined);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
    const phone = device();
    const issued = await ownerLogin(db, { remember: '1', device_key: phone.encoded });
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 1);
    const bad = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: issued.refresh_token, nonce: issued.nonce, timestamp: consoleNow(), signature: 'not-a-signature' }
    });
    assert.equal(bad.status, 401);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);

    const again = await ownerLogin(db, { remember: '1', device_key: phone.encoded });
    const firstStamp = consoleNow();
    const rotated = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: again.refresh_token, nonce: again.nonce, timestamp: firstStamp, signature: phone.sign(again.nonce, firstStamp) }
    });
    assert.equal(rotated.status, 200, rotated.text.slice(0, 300));
    assert.equal(rotated.json.step_up, null);
    assert.notEqual(rotated.json.refresh_token, again.refresh_token);
    const accessRow = await db.collection('emet_oauth_tokens').findOne({ token: (await import('../src/oauth-provider.js')).tokenDigest(rotated.json.access_token) });
    assert.equal(accessRow.step_up, null);
    assert.equal(accessRow.console, true);
    const reuseStamp = consoleNow();
    const reuse = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: again.refresh_token, nonce: rotated.json.nonce, timestamp: reuseStamp, signature: phone.sign(rotated.json.nonce, reuseStamp) }
    });
    assert.equal(reuse.status, 401);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);

    const live = await ownerLogin(db, { remember: '1', device_key: phone.encoded });
    const ended = await api('/console/api/session/end', { method: 'POST', token: live.access_token, origin: ORIGIN, body: {} });
    assert.equal(ended.status, 200);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
    const afterEnd = await api('/console/api/dashboard', { token: live.access_token, origin: ORIGIN });
    assert.equal(afterEnd.status, 401);

    const lasting = await ownerLogin(db, { remember: '1', device_key: phone.encoded });
    const start = consoleNow();
    setConsoleClockForTests(() => start + (14 * 24 * 60 * 60 * 1000) + 1000);
    const idleStamp = consoleNow();
    const idle = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: lasting.refresh_token, nonce: lasting.nonce, timestamp: idleStamp, signature: phone.sign(lasting.nonce, idleStamp) }
    });
    assert.equal(idle.status, 401);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
    setConsoleClockForTests(null);

    const absolute = await ownerLogin(db, { remember: '1', device_key: phone.encoded });
    const born = consoleNow();
    setConsoleClockForTests(() => born + (30 * 24 * 60 * 60 * 1000) + 1000);
    const absStamp = consoleNow();
    const aged = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: absolute.refresh_token, nonce: absolute.nonce, timestamp: absStamp, signature: phone.sign(absolute.nonce, absStamp) }
    });
    assert.equal(aged.status, 401);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
    setConsoleClockForTests(null);

    const isolated = await ownerLogin(db, { remember: '1', device_key: phone.encoded });
    await db.collection('owner_credentials').updateOne({ _id: 'admin' }, { $set: { version: (await adminPasswordVersion(db)) + 1 } });
    const isoStamp = consoleNow();
    const iso = await api('/console/api/session/refresh', {
      method: 'POST',
      origin: ORIGIN,
      body: { refresh_token: isolated.refresh_token, nonce: isolated.nonce, timestamp: isoStamp, signature: phone.sign(isolated.nonce, isoStamp) }
    });
    assert.equal(iso.status, 401);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
    assert.equal(iso.json.step_up, undefined);
  });
});

testGroup('10. responses and request logs carry no secrets', () => {
  test('passwords, hashes, keys, refresh tokens, the pepper, and env values stay out', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const phone = device();
    const issued = await ownerLogin(db, { remember: '1', device_key: phone.encoded });
    const credential = await db.collection('owner_credentials').findOne({ _id: 'admin' });
    const row = await db.collection('emet_console_refresh').findOne({});
    const secrets = [ADMIN, CONNECT, PEPPER, issued.refresh_token, issued.access_token, credential.hash, credential.salt, row.token_hash, phone.encoded];
    const paths = [
      ['GET', '/console/api/meta'],
      ['GET', '/console/api/session'],
      ['GET', '/console/api/dashboard'],
      ['GET', '/console/api/areas/notes'],
      ['GET', '/console/api/docs'],
      ['GET', '/console/api/docs/STATE.md'],
      ['GET', '/console/api/search?mode=keyword&q=hello'],
      ['GET', '/console/api/episodic/recent'],
      ['GET', '/console/api/transcripts/2026-11-24_example'],
      ['POST', '/console/api/notes']
    ];
    for (const [method, pathname] of paths) {
      const res = await api(pathname, {
        method,
        token: issued.access_token,
        origin: ORIGIN,
        body: method === 'POST' ? { layer: 'episodic', content: 'a plain note' } : undefined
      });
      for (const secret of secrets) {
        if (!secret) continue;
        assert.equal(res.text.includes(secret), false, `${pathname} leaked`);
      }
      assert.equal(/EMET_[A-Z0-9_]+?=/.test(res.text), false, pathname);
    }
    const bad = await postApprove(db, { scopes: 'emet.console', password: CONNECT });
    assert.equal(bad.text.includes(CONNECT), false);
    assert.equal(bad.text.includes(ADMIN), false);
    const lines = [];
    const logger = requestLogger({ enabled: true, write: (line) => lines.push(line) });
    const fakeRes = { statusCode: 401, locals: { reason: 'bad_admin_password' }, getHeader() { return null; }, on(event, fn) { if (event === 'finish') fn(); } };
    logger({
      method: 'POST',
      originalUrl: '/console/api/session/refresh',
      url: '/console/api/session/refresh',
      ip: '203.0.113.9',
      query: { device_key: phone.encoded },
      body: { refresh_token: issued.refresh_token, password: ADMIN, passphrase: CONNECT, signature: 'sig' }
    }, fakeRes, () => {});
    const joined = lines.join('\n');
    for (const secret of secrets) {
      if (secret) assert.equal(joined.includes(secret), false);
    }
    const entry = formatRequestLog(requestLogEntry({
      method: 'POST', path: '/oauth/approve', statusCode: 401, ms: 3, ip: '203.0.113.9',
      body: { password: ADMIN, passphrase: CONNECT, device_key: phone.encoded, refresh_token: issued.refresh_token },
      query: {}
    }));
    for (const secret of secrets) {
      if (secret) assert.equal(entry.includes(secret), false);
    }
  });
});

testGroup('11. a note is a dispatch write tagged emet-console', () => {
  test('the receipt is a read-back, other layers are refused, and an unregistered tag writes nothing', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    process.env.EMET_SOURCE_TAGS = 'emet-console,note-bot';
    const db = await prepare(makeStore());
    const issued = await ownerLogin(db);
    const badLayer = await api('/console/api/notes', {
      method: 'POST', token: issued.access_token, origin: ORIGIN,
      body: { layer: 'procedural', content: 'no' }
    });
    assert.equal(badLayer.status, 400);
    assert.equal(badLayer.json.emet_code, 'EMET-MEM-001');
    assert.equal(await db.collection('emet_procedural').countDocuments({}), 0);
    const { useTestClient } = await import('../src/mongo-connect.js');
    useTestClient(db.Client);
    let saved;
    try {
      saved = await api('/console/api/notes', {
        method: 'POST', token: issued.access_token, origin: ORIGIN,
        body: { layer: 'episodic', content: 'the owner asked for a console note', tags: ['console'] }
      });
    } finally {
      useTestClient(null);
    }
    assert.equal(saved.status, 200, saved.text.slice(0, 800));
    assert.equal(saved.json.receipt.source, 'emet-console');
    assert.equal(typeof saved.json.receipt.sha256, 'string');
    assert.equal(saved.json.receipt.verified, true);
    assert.notEqual(saved.json.receipt.source, 'owner');
    assert.notEqual(saved.json.receipt.source, 'unspecified');
    const row = await db.collection('emet_episodic').findOne({});
    assert.equal(row.metadata.source, 'emet-console');
    assert.notEqual(row.metadata.source, 'owner');
    const sessions = await db.collection('emet_sessions').find({}).toArray();
    assert.ok(sessions.length > 0);
    assert.ok(sessions.every((item) => item.closed === true), JSON.stringify(sessions.map((item) => ({ id: item._id, closed: item.closed }))));
    const parts = await db.collection('transcripts').find({}).toArray();
    assert.ok(parts.some((part) => part.session_id && String(part.session_id).startsWith(String(sessions[0]._id))));
    const { classifyPointer } = await import('../src/gaps.js');
    const window = {
      session_start: parts[0].session_start,
      session_end: parts[0].session_end || parts[0].timestamp
    };
    const verdict = classifyPointer({ source_session_id: row.source_session_id, timestamp: row.timestamp }, window, null);
    assert.equal(verdict.kind, 'agrees');
    const count = await db.collection('emet_episodic').countDocuments({});
    process.env.EMET_SOURCE_TAGS = 'note-bot';
    const refused = await api('/console/api/notes', {
      method: 'POST', token: issued.access_token, origin: ORIGIN,
      body: { layer: 'semantic', content: 'this must not land' }
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.emet_code, 'EMET-DOC-020');
    assert.equal(await db.collection('emet_semantic').countDocuments({}), 0);
    assert.equal(await db.collection('emet_episodic').countDocuments({}), count);
    process.env.EMET_SOURCE_TAGS = 'emet-console,note-bot';
  });
});

testGroup('12. STATE.md and HANDOFF.md are read-only', () => {
  test('document routes accept GET only and a note does not patch those documents', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    process.env.EMET_SOURCE_TAGS = 'emet-console';
    const db = await prepare(makeStore());
    await db.collection('documents').insertOne({ doc_id: 'STATE.md', content: 'state line', version: 1, sha256: 'abc' });
    await db.collection('documents').insertOne({ doc_id: 'HANDOFF.md', content: 'handoff top', version: 1, sha256: 'def' });
    const issued = await ownerLogin(db);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await api('/console/api/docs/STATE.md', { method, token: issued.access_token, origin: ORIGIN, body: { content: 'changed' } });
      assert.equal(res.status, 405, method);
      assert.match(res.text, /Nothing was written/);
    }
    const handoff = await api('/console/api/docs/HANDOFF.md', { method: 'POST', token: issued.access_token, origin: ORIGIN, body: { content: 'changed' } });
    assert.equal(handoff.status, 405);
    const state = await db.collection('documents').findOne({ doc_id: 'STATE.md' });
    const hand = await db.collection('documents').findOne({ doc_id: 'HANDOFF.md' });
    assert.equal(state.content, 'state line');
    assert.equal(hand.content, 'handoff top');
  });
});

testGroup('13. the MCP tool list is unchanged', () => {
  test('names and count stay the pinned list', async () => {
    const previous = process.env.EMET_SUBKEYS;
    process.env.EMET_SUBKEYS = '0';
    const names = hostTools().map((tool) => tool.name);
    process.env.EMET_SUBKEYS = previous;
    assert.deepEqual(names, [...TOOL_NAMES]);
    assert.equal(names.length, 38);
    assert.equal(names.includes('emet.console'), false);
  });
});

testGroup('the statechart is on /statechart', () => {
  test('the console doors are listed', async () => {
    const { statechartBody } = await import('../src/access-statechart.js');
    const html = statechartBody();
    assert.match(html, /EMET Console/);
    assert.match(html, /EMET-AUTH-046/);
    assert.match(html, /SignedOut --&gt; OwnerSession/);
    const doc = await import('node:fs');
    const fenced = /```mermaid\n([\s\S]*?)\n```/.exec(doc.readFileSync(path.join(ROOT, 'docs/console-statechart.md'), 'utf8'));
    assert.equal(fenced[1], CONSOLE_MERMAID);
    const res = await fetch(`${base}/statechart`);
    const page = await res.text();
    assert.match(page, /EMET Console/);
  });
});

testGroup('break-glass and device delete', () => {
  test('break-glass deletes console rows, and deleteConsoleDevice removes one phone', async () => {
    process.env.EMET_CONSOLE_ORIGINS = ORIGIN;
    const db = await prepare(makeStore());
    const phone = device();
    const issued = await ownerLogin(db, { remember: '1', device_key: phone.encoded });
    const removed = await deleteConsoleDevice(db, issued.device_id);
    assert.ok(removed > 0);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
    const other = device();
    await ownerLogin(db, { remember: '1', device_key: other.encoded });
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 1);
    const login = await fetch(`${base}/owner/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': nextIp() },
      body: new URLSearchParams({ password: ADMIN, next: '/owner/break-glass' }).toString()
    });
    assert.equal(login.status, 303, await login.text());
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const cleared = await fetch(`${base}/owner/break-glass`, { headers: { cookie, 'x-forwarded-for': nextIp() } });
    assert.equal(cleared.status, 200);
    assert.equal(await db.collection('emet_console_refresh').countDocuments({}), 0);
  });
});

await summary('EMET CONSOLE');
server.close();
