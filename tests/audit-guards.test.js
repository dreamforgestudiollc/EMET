/**
 * Guards a mutation pass left alive because nothing asserted them.
 * Each check below fails if that guard is removed or its boundary is widened.
 * src/tools.js lookalikeDocIdReason line that rejects a raw "." / ".." segment
 * is redundant with the same check after NFKC; it is not pinned here.
 */

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://in-memory.test/emet';
process.env.LOG_LEVEL = 'error';
process.env.EMET_INVITES = '1';
process.env.EMET_MEMBER_ACCESS = '1';
for (const k of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS', 'EMET_SIGNING_KEY']) delete process.env[k];

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'url';
import { makeStore, withStore, memDb, layerHonouringDb } from './memstore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = await import('../src/tools.js');
const { EmetDatabase, COLLECTION_PREFIX } = await import('../src/database.js');
const { dispatchTool } = await import('../src/dispatch.js');
const { actorStore } = await import('../src/persons.js');
const { findGaps } = await import('../src/gaps.js');
const { createInvite, createMemberAccess, redeemInvite } = await import('../src/invites.js');
const { MongoOAuthProvider, tokenDigest } = await import('../src/oauth-provider.js');
const { ApproveThrottle } = await import('../src/approve-throttle.js');
const { registerSecret } = await import('../src/redact.js');
const { slugPersonId } = await import('../src/persons.js');
const { resolveImportance } = await import('../src/layers.js');

const DAY = 86400000;

function memoryRow(id, content, extra = {}) {
  return {
    id, content, context: '', timestamp: id, importance: 0.5,
    metadata: {}, is_live: true, ...extra
  };
}

testGroup('document and layer write guards', () => {
  test('writeDoc refuses 2,000,001 characters and accepts 2,000,000', async () => {
    await assert.rejects(
      () => tools.writeDoc('drops/too-big.md', 'x'.repeat(2_000_001), 'audit'),
      (e) => /exceeds 2MB/.test(e.message)
    );
    const store = makeStore();
    await withStore(store, async () => {
      const written = await tools.writeDoc('drops/at-cap.md', 'x'.repeat(2_000_000), 'audit');
      assert.strictEqual(written.doc_id, 'drops/at-cap.md');
      assert.strictEqual(written.size, 2_000_000);
    });
  });

  test('a record revision must name the version in force', async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const first = await tools.writeDoc('HANDOFF.md', '# Handoff\nfirst revision of the record\n', 'audit');
      assert.strictEqual(first.version, 1);
      await assert.rejects(
        () => tools.writeDoc('HANDOFF.md', '# Handoff\nsecond revision of the record\n', 'audit'),
        (e) => /must name what it supersedes/.test(e.message) && /supersedes: 1/.test(e.message)
      );
      await assert.rejects(
        () => tools.writeDoc('HANDOFF.md', '# Handoff\nsecond revision of the record\n', 'audit', null, null, {
          supersedes: 99, reason: 'names a version that is not in force'
        }),
        (e) => /v99/.test(e.message) && /in force/.test(e.message)
      );
      assert.strictEqual(store.doc('HANDOFF.md').version, 1);
    });
  });

  test('retireDoc refuses the board by name', async () => {
    await assert.rejects(
      () => tools.retireDoc('STATE.md', 'the board is not a drop to retire', 'audit'),
      (e) => /the board is never retired/.test(e.message)
    );
  });

  test('recall uses at most the first 20 keywords', async () => {
    const words = Array.from({ length: 21 }, (_, i) => `kw${String(i + 1).padStart(2, '0')}`);
    const store = makeStore();
    const db = new EmetDatabase(null);
    await withStore(store, async () => {
      await db.ensureClient();
      const col = store.collection(`${COLLECTION_PREFIX}working`);
      col.docs.push(memoryRow(20, words[19]));
      col.docs.push(memoryRow(21, words[20]));
      const found = await tools.recallMemories(db, words.join(' '), 'working', 10);
      const ids = found.map((m) => m.id).sort((a, b) => a - b);
      assert.deepStrictEqual(ids, [20]);
    });
  });

  test('query_layer by a superseded id also returns the live end of the chain', async () => {
    const store = makeStore();
    const db = new EmetDatabase(null);
    await withStore(store, async () => {
      await db.ensureClient();
      const col = store.collection(`${COLLECTION_PREFIX}semantic`);
      col.docs.push(memoryRow(1, 'the superseded wording', { superseded_by: 2, is_live: false, metadata: { superseded_by: 2 } }));
      col.docs.push(memoryRow(2, 'the live wording'));
      const found = await tools.queryLayer(db, 'semantic', { filters: { id: 1 } });
      const live = found.find((m) => m.id === 2);
      assert.ok(live, `live end missing: ${found.map((m) => m.id).join(',')}`);
      assert.deepStrictEqual(live.resolved_via, { requested_id: 1, chain: [1, 2] });
      assert.ok(found.some((m) => m.id === 1 && m.is_superseded === true));
    });
  });

  test('the global cap is 300 per minute, before any one tool cap', () => {
    const limiter = new tools.RateLimiter(null);
    try {
      for (let i = 0; i < 100; i++) limiter.recordRequest('recall');
      for (let i = 0; i < 100; i++) limiter.recordRequest('semantic_recall');
      for (let i = 0; i < 99; i++) limiter.recordRequest('query_layer');
      assert.strictEqual(limiter.checkLimit('emet_status').allowed, true);
      limiter.recordRequest('emet_status');
      const denied = limiter.checkLimit('save_to_layer');
      assert.strictEqual(denied.allowed, false);
      assert.match(denied.reason, /Global rate limit exceeded: 300\/300/);
    } finally { limiter.stop(); }
  });

  test('the 121st recall in a minute is denied by the recall cap', () => {
    const limiter = new tools.RateLimiter(null);
    try {
      for (let i = 0; i < 119; i++) limiter.recordRequest('recall');
      assert.strictEqual(limiter.checkLimit('recall').allowed, true);
      limiter.recordRequest('recall');
      const denied = limiter.checkLimit('recall');
      assert.strictEqual(denied.allowed, false);
      assert.match(denied.reason, /Tool 'recall' rate limit exceeded: 120\/120/);
    } finally { limiter.stop(); }
  });

  test('semantic recall asks for at least 200 candidates, and more when the limit needs it', async () => {
    const store = makeStore();
    const seen = [];
    await withStore(store, async () => {
      const col = store.collection(`${COLLECTION_PREFIX}semantic`);
      const orig = col.aggregate;
      col.aggregate = (pipeline) => { seen.push(pipeline); return orig.call(col, pipeline); };
      await tools.semanticRecall('boundary term', 'semantic', 1);
      await tools.semanticRecall('boundary term', 'semantic', 15);
    });
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0][0].$vectorSearch.numCandidates, 200);
    assert.strictEqual(seen[0][0].$vectorSearch.limit, 1);
    assert.strictEqual(seen[1][0].$vectorSearch.numCandidates, 300);
    assert.strictEqual(seen[1][0].$vectorSearch.limit, 15);
  });

  test('episodic revision is refused', async () => {
    await assert.rejects(
      () => tools.reviseMemory(null, 'episodic', 1, 'a later telling of the event', {}),
      (e) => /Episodic revision is prohibited/.test(e.message)
    );
  });

  test('revising an already-superseded parent is refused', async () => {
    const db = layerHonouringDb();
    db.byLayer.semantic = {
      7: { id: 7, content: 'prior fact', metadata: { superseded_by: 9 }, superseded_by: 9, is_live: false }
    };
    await assert.rejects(
      () => tools.reviseMemory(db, 'semantic', 7, 'a revision of the archived fact', { source: 'audit' }),
      (e) => /already superseded by 9/.test(e.message)
    );
    assert.deepStrictEqual(db.writes, []);
  });
});

testGroup('dispatch, gaps, invites, oauth, and small bounds', () => {
  test('dispatchTool refuses save_to_layer when the login only has emet.read', async () => {
    const res = await actorStore.run(
      { personId: 'guest', clientId: 'audit', scopes: ['emet.read'] },
      () => dispatchTool('save_to_layer', { content: 'should not be written', layer: 'working', metadata: { source: 'audit' } }, { dbManager: null, logger: null })
    );
    assert.strictEqual(res.isError, true);
    const text = res.content[0].text;
    assert.match(text, /This login is not allowed to call save_to_layer/);
    assert.match(text, /Needs emet\.write/);
  });

  test('gap id lists are clamped to 500 and at least 1', async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const col = store.collection(`${COLLECTION_PREFIX}semantic`);
      for (let id = 1; id <= 520; id++) {
        col.docs.push({
          id, content: 'unsourced fact', timestamp: id, is_live: true,
          metadata: { source: 'audit', assertion_origin: 'user' }
        });
      }
      const wide = await findGaps({ layer: 'semantic', limit: 1000 });
      assert.strictEqual(wide.scope.id_limit_per_class, 500);
      assert.strictEqual(wide.classes.unsourced_assertions.ids.length, 500);
      assert.strictEqual(wide.classes.unsourced_assertions.count, 520);
      const narrow = await findGaps({ layer: 'semantic', limit: -3 });
      assert.strictEqual(narrow.scope.id_limit_per_class, 1);
      assert.strictEqual(narrow.classes.unsourced_assertions.ids.length, 1);
      assert.strictEqual(narrow.classes.unsourced_assertions.count, 520);
    });
  });

  test('guest and member codes last at least one day', async () => {
    const db = memDb();
    const before = Date.now();
    const guest = await createInvite(db, { display_name: 'Guest', days: -5 });
    const member = await createMemberAccess(db, { display_name: 'Member', days: 0.2 });
    const after = Date.now();
    for (const row of [guest, member]) {
      const span = row.expires_at.getTime();
      assert.ok(span >= before + DAY - 50 && span <= after + DAY + 50, `${row.door} expires ${span}`);
    }
  });

  test('a used code is used, and an expired code is expired', async () => {
    const db = memDb();
    const minted = await createInvite(db, { display_name: 'Once', days: 2 });
    const first = await redeemInvite(db, minted.code);
    assert.strictEqual(first.ok, true);
    const again = await redeemInvite(db, minted.code);
    assert.deepStrictEqual({ ok: again.ok, reason: again.reason }, { ok: false, reason: 'used' });

    const expired = await createInvite(db, { display_name: 'Old', days: 1 });
    const row = db.collection('invites').rows.find((r) => r.digest && r.display_name === 'Old');
    row.expires_at = new Date(Date.now() - 1000);
    const late = await redeemInvite(db, expired.code);
    assert.deepStrictEqual({ ok: late.ok, reason: late.reason }, { ok: false, reason: 'expired' });
  });

  test('an authorization code with time left is accepted, and one expired a millisecond ago is not', async () => {
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example' });
    const codes = db.collection(`${provider.prefix}oauth_codes`);
    const now = 1_700_000_000_000;
    const client = { client_id: 'c1' };
    const redirect = 'https://app.example/cb';
    const live = 'live-code';
    const expiredCode = 'expired-code';
    // The store keeps the digest, never the code. The expiry boundary is unchanged:
    // one millisecond of life is accepted, and one millisecond past is refused.
    await codes.insertOne({ code: tokenDigest(live), hashed: true, client_id: 'c1', redirect_uri: redirect, code_challenge: 'x', scopes: ['emet.read'], expiresAtMs: now + 1, used: false });
    await codes.insertOne({ code: tokenDigest(expiredCode), hashed: true, client_id: 'c1', redirect_uri: redirect, code_challenge: 'x', scopes: ['emet.read'], expiresAtMs: now - 1, used: false });
    assert.ok(!codes.rows.some((r) => r.code === live || r.code === expiredCode));
    const real = Date.now;
    Date.now = () => now;
    try {
      const ok = await provider.exchangeAuthorizationCode(client, live, 'verifier', redirect, null);
      assert.ok(ok.access_token);
      await assert.rejects(
        () => provider.exchangeAuthorizationCode(client, expiredCode, 'verifier', redirect, null),
        (e) => /expired/.test(e.message)
      );
    } finally { Date.now = real; }
  });

  test('a redirect_uri that does not match the code is rejected', async () => {
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example' });
    const code = await provider.createAuthorizationCode({ client_id: 'c1', redirect_uri: 'https://app.example/cb', code_challenge: 'x', scopes: ['emet.read'] });
    await assert.rejects(
      () => provider.exchangeAuthorizationCode({ client_id: 'c1' }, code, 'verifier', 'https://other.example/cb', null),
      (e) => /redirect_uri does not match/.test(e.message)
    );
  });

  test('a refresh rotated 59 seconds ago is still honored, and one rotated 61 seconds ago is not', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'oauth-provider.js'), 'utf8');
    assert.match(src, /const REFRESH_ROTATION_GRACE_S = 60;/);
    const db = memDb();
    const provider = new MongoOAuthProvider(() => db, { passphrase: 'p', issuerUrl: 'https://emet.example' });
    const client = { client_id: 'c1' };
    const issued = await provider._issueTokens('c1', ['emet.read'], null, null, null, null, 'laptop');
    const now = 1_700_000_060_000;
    const real = Date.now;
    Date.now = () => now;
    try {
      await provider.exchangeRefreshToken(client, issued.refresh_token, [], null);
      const row = db.collection(`${provider.prefix}oauth_tokens`).rows.find((r) => r.kind === 'refresh' && r.rotated_at);
      const nowS = Math.floor(now / 1000);
      row.rotated_at = nowS - 59;
      // Inside the window the reuse must not be refused. It may return the
      // replacement already issued rather than minting a new pair.
      await assert.doesNotReject(() => provider.exchangeRefreshToken(client, issued.refresh_token, [], null));
      row.rotated_at = nowS - 61;
      await assert.rejects(
        () => provider.exchangeRefreshToken(client, issued.refresh_token, [], null),
        (e) => /already been replaced/.test(e.message)
      );
    } finally { Date.now = real; }
  });

  test('the 10,001st tracked address drops the oldest', () => {
    const throttle = new ApproveThrottle({ now: () => 1_000 });
    for (let i = 0; i < 10000; i++) throttle.recordFailure(`ip-${i}`);
    assert.strictEqual(throttle.failures.size, 10000);
    assert.ok(throttle.failures.has('ip-0'));
    throttle.recordFailure('ip-10000');
    assert.strictEqual(throttle.failures.size, 10000);
    assert.strictEqual(throttle.failures.has('ip-0'), false);
    assert.ok(throttle.failures.has('ip-1'));
    assert.ok(throttle.failures.has('ip-10000'));
  });

  test('registerSecret ignores a literal shorter than 6 characters', () => {
    assert.strictEqual(registerSecret('abcd'), false);
    assert.strictEqual(registerSecret('abcde'), false);
    assert.strictEqual(registerSecret('abcdef'), true);
  });

  test('slugPersonId keeps at most 40 characters', () => {
    assert.strictEqual(slugPersonId('a'.repeat(80)).length, 40);
    assert.strictEqual(slugPersonId('a'.repeat(80)), 'a'.repeat(40));
  });

  test('procedural importance 0.59 is the low degree', () => {
    assert.strictEqual(resolveImportance('procedural', 0.59).degree, 'low');
  });
});

function frame(obj) {
  return Buffer.from(`${JSON.stringify(obj)}\n`);
}

function takeMessages(buf) {
  const messages = [];
  let rest = buf;
  for (;;) {
    const nl = rest.indexOf(0x0a);
    if (nl < 0) break;
    const line = rest.slice(0, nl).toString('utf8').replace(/\r$/, '').trim();
    rest = rest.slice(nl + 1);
    if (line) messages.push(JSON.parse(line));
  }
  return { messages, rest };
}

testGroup('the stdio and HTTP entry points enforce the rate limit', () => {
  test('stdio refuses the 121st recall', async () => {
    const child = spawn(process.execPath, ['--import', path.join(ROOT, 'tests', 'audit-stdio-preload.mjs'), path.join(ROOT, 'src', 'index.js')], {
      cwd: ROOT,
      env: { ...process.env, MONGODB_URI: 'mongodb://in-memory.test/emet', LOG_LEVEL: 'error', EMET_REQUEST_LOG: '0' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let buf = Buffer.alloc(0);
    let stderr = '';
    const waiters = new Map();
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const taken = takeMessages(buf);
      buf = taken.rest;
      for (const msg of taken.messages) {
        if (msg.id !== undefined && waiters.has(msg.id)) {
          waiters.get(msg.id)(msg);
          waiters.delete(msg.id);
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const ask = (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stdio ${method} id ${id} timed out\n${stderr.slice(-800)}`)), 20000);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
    });
    try {
      const init = await ask(1, 'initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'audit', version: '0' }
      });
      assert.ok(init.result, JSON.stringify(init).slice(0, 400));
      child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      const call = (n) => ask(n + 1, 'tools/call', { name: 'recall', arguments: { query: 'stdio-rate', layer: 'working' } });
      for (let n = 1; n < 120; n++) await call(n);
      const ok = await call(120);
      assert.ok(!JSON.stringify(ok).includes('rate limit exceeded'), JSON.stringify(ok).slice(0, 400));
      const denied = await call(121);
      assert.match(JSON.stringify(denied), /Tool 'recall' rate limit exceeded: 120\/120/);
    } finally {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  test('HTTP refuses the 121st recall', async () => {
    const net = await import('node:net');
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port: p } = srv.address();
        srv.close((err) => (err ? reject(err) : resolve(p)));
      });
    });
    const saved = { PORT: process.env.PORT, HOST: process.env.HOST };
    process.env.PORT = String(port);
    process.env.HOST = '127.0.0.1';
    const express = (await import('express')).default;
    const { useTestClient } = await import('../src/mongo-connect.js');
    const store = makeStore();
    useTestClient(store.Client);
    let httpServer = null;
    const origListen = express.application.listen;
    const listening = new Promise((resolve, reject) => {
      express.application.listen = function (...args) {
        httpServer = origListen.apply(this, args);
        httpServer.once('listening', () => resolve(this));
        httpServer.once('error', reject);
        return httpServer;
      };
    });
    try {
      await import('../src/http-remote.js');
      const app = await listening;
      for (const layer of app.router.stack) {
        const route = layer.route;
        if (!route || route.path !== '/mcp' || !route.methods.post) continue;
        for (const step of route.stack) {
          if (Function.prototype.toString.call(step.handle).includes('verifyAccessToken')) {
            step.handle = (_req, _res, next) => next();
          }
        }
      }
      const post = async (id) => {
        const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0', id, method: 'tools/call',
            params: { name: 'recall', arguments: { query: 'http-rate', layer: 'working' } }
          })
        });
        const body = await res.text();
        assert.strictEqual(res.status, 200, body.slice(0, 400));
        return body;
      };
      for (let i = 1; i < 120; i++) await post(i);
      const ok = await post(120);
      assert.ok(!ok.includes('rate limit exceeded'), ok.slice(0, 400));
      const denied = await post(121);
      assert.match(denied, /Tool 'recall' rate limit exceeded: 120\/120/);
    } finally {
      express.application.listen = origListen;
      useTestClient(null);
      if (saved.PORT === undefined) delete process.env.PORT; else process.env.PORT = saved.PORT;
      if (saved.HOST === undefined) delete process.env.HOST; else process.env.HOST = saved.HOST;
      if (httpServer) {
        if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
        await new Promise((resolve) => httpServer.close(() => resolve()));
      }
    }
  });
});

summary('AUDIT GUARDS TEST SUMMARY');
