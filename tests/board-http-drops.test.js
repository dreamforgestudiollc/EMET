/**
 * Live 0.2.3 board guard: patch_doc on STATE.md over the remote HTTP connector
 * was refused with "unhandled drops could not be loaded" even though startup
 * page 1 listed unhandled_drops: [] and retired drops, and emet_session_open
 * returned drops_seen: [].
 *
 * The sequence is the live one: every initialize page, then session_open,
 * then transcript append, then patch_doc on the board. A second session
 * fails the drop-list read on purpose; that board edit must stay refused.
 */
import assert from 'node:assert/strict';
import { test, summary } from './harness.js';
import { makeStore } from './memstore.js';

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/emet-http-drops';
process.env.EMET_SOURCE_TAG = 'grok-project';
process.env.EMET_SOURCE_TAGS = 'grok-project';
process.env.EMET_RESTORE_TAGS = 'grok-project';
process.env.EMET_DROP_LIST_TIMEOUT_MS = '50';
process.env.EMET_REQUEST_LOG = '0';
process.env.LOG_LEVEL = 'error';

const REASON = 'empty unhandled list is a loaded list';
const HOST = 'grok-project';
const storeOpts = { failUnhandledDropRead: false };
const db = makeStore(storeOpts);
const shared = { http: null, loadId: null };

function parseRpc(body) {
  const chunks = [];
  if (body.includes('data:')) {
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith('data:')) chunks.push(line.slice(5).trim());
    }
  } else {
    chunks.push(body);
  }
  let msg = null;
  for (const chunk of chunks) {
    if (!chunk) continue;
    try { msg = JSON.parse(chunk); } catch { /* a non-JSON SSE line is not the result */ }
  }
  if (!msg) throw new Error(`unreadable HTTP body: ${body.slice(0, 400)}`);
  if (msg.error) return { success: false, error: msg.error };
  const result = msg.result || {};
  const text = result.content && result.content[0] && result.content[0].text;
  if (typeof text !== 'string') return { success: result.isError !== true, raw: result };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { success: false, error: { message: text } }; }
  if (parsed && parsed.success === false) return parsed;
  if (result.isError) return { success: false, ...parsed };
  return parsed;
}

async function rpc(name, args) {
  const res = await fetch(`http://127.0.0.1:${shared.http.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } })
  });
  const body = await res.text();
  assert.strictEqual(res.status, 200, body.slice(0, 400));
  return parseRpc(body);
}

async function waitFor(pred, ms = 400) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = pred();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

function installAuth(app) {
  for (const layer of app.router.stack) {
    const route = layer.route;
    if (!route || route.path !== '/mcp' || !route.methods.post) continue;
    for (const step of route.stack) {
      if (Function.prototype.toString.call(step.handle).includes('verifyAccessToken')) {
        step.handle = (req, _res, next) => {
          req.auth = {
            token: 'test',
            clientId: 'http-board-client',
            scopes: ['emet.read', 'emet.write'],
            extra: { sourceTag: HOST }
          };
          next();
        };
        return;
      }
    }
  }
  throw new Error('the /mcp bearer check was not found on the HTTP app');
}

async function boot() {
  if (shared.http) return shared.http;
  const { useTestClient } = await import('../src/mongo-connect.js');
  useTestClient(db.Client);
  const { writeDoc } = await import('../src/tools.js');
  const { provisionBoardText } = await import('../src/setup.js');
  db.col('documents').docs.push(
    { doc_id: 'bootstrap/IDENTITY.md', content: '# Identity\nTest\n', version: 1, updated_at: new Date() },
    { doc_id: 'bootstrap/USER.md', content: '# User\nTest\n', version: 1, updated_at: new Date() }
  );
  const retiredAt = '2026-10-04T16:00:00.000Z';
  for (let n = 1; n <= 4; n++) {
    db.col('documents').docs.push({
      doc_id: `drops/retired-${n}.md`,
      content: `retired drop ${n}\n`,
      version: 1,
      retired: true,
      retired_at: retiredAt,
      retired_reason: 'board guard merged, 0.2.2 released 2026-10-04',
      updated_at: new Date(retiredAt)
    });
  }
  await writeDoc('STATE.md', provisionBoardText(), HOST, null, null, { provision: true });

  const express = (await import('express')).default;
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
  await import('../src/http-remote.js');
  const app = await listening;
  installAuth(app);
  express.application.listen = origListen;
  shared.http = { port: httpServer.address().port, httpServer, saved, origListen };
  return shared.http;
}

async function shutdown() {
  const { useTestClient } = await import('../src/mongo-connect.js');
  useTestClient(null);
  const http = shared.http;
  if (!http) return;
  if (http.saved.PORT === undefined) delete process.env.PORT; else process.env.PORT = http.saved.PORT;
  if (http.saved.HOST === undefined) delete process.env.HOST; else process.env.HOST = http.saved.HOST;
  if (http.httpServer) {
    if (typeof http.httpServer.closeAllConnections === 'function') http.httpServer.closeAllConnections();
    await new Promise((resolve) => http.httpServer.close(() => resolve()));
  }
  shared.http = null;
}

test('HTTP startup with an empty unhandled list and retired drops can patch and restore the board', async () => {
  await boot();
  const pages = [];
  let args = {};
  do {
    const page = await rpc('emet_initialize', args);
    assert.strictEqual(page.success, true, JSON.stringify(page).slice(0, 500));
    pages.push(page.data);
    const next = page.data && page.data.startup_page && page.data.startup_page.next;
    args = next ? JSON.parse(String(next).replace(/^emet_initialize /, '')) : null;
  } while (args);
  const first = pages[0];
  assert.ok(pages.length >= 1);
  assert.strictEqual(pages[pages.length - 1].startup_page.next, null);
  assert.deepStrictEqual(first.unhandled_drops, []);
  assert.strictEqual(first.unhandled_drops_more, 0);
  assert.strictEqual(first.retired_drops.length, 4);
  assert.ok(first.retired_drops.every((d) => d.retired === true));
  shared.loadId = first.startup_page.load_id;
  assert.ok(shared.loadId);

  const opened = await rpc('emet_session_open', { slug: 'board-empty-drops', load_id: shared.loadId });
  assert.strictEqual(opened.success, true, JSON.stringify(opened).slice(0, 600));
  const data = opened.data;
  assert.deepStrictEqual(data.drops_seen, []);
  assert.notStrictEqual(data.drops_unverified, true);
  assert.strictEqual(data.startup_pages.complete, true);
  assert.strictEqual(data.session_graph.verdict, 'ok');
  const sessionId = data.session_id;
  const base = String(sessionId).replace(/_verbatim_part\d+$/, '');
  const recorded = await waitFor(() => {
    const row = db.row(base);
    return row && row.opened ? row : null;
  });
  assert.ok(recorded, 'session open was not recorded');

  const appended = await rpc('emet_transcript_append', {
    session_id: sessionId,
    exchange_index: 1,
    user_message: 'Edit the board.',
    assistant_message: 'I will patch STATE.md.',
    source: HOST
  });
  assert.strictEqual(appended.success, true, JSON.stringify(appended).slice(0, 500));
  assert.strictEqual(appended.data.session_graph.verdict, 'ok');

  const listed = await waitFor(() => {
    const row = db.row(base);
    return row && Array.isArray(row.drops_seen) ? row : null;
  });
  const version = db.doc('STATE.md').version;
  const patched = await rpc('patch_doc', {
    doc_id: 'STATE.md',
    old_str: 'Verified at setup.',
    new_str: 'Checked at setup.',
    expected_version: version,
    session_id: sessionId,
    source: HOST,
    reason: REASON
  });
  assert.ok(listed, `empty drop list was not stored; patch: ${JSON.stringify(patched).slice(0, 600)}`);
  assert.deepStrictEqual(listed.drops_seen, []);
  assert.strictEqual(patched.success, true, JSON.stringify(patched).slice(0, 600));
  assert.match(db.doc('STATE.md').content, /Checked at setup\./);

  const restored = await rpc('restore_doc', {
    doc_id: 'STATE.md',
    version: 1,
    session_id: sessionId,
    source: HOST,
    reason: REASON
  });
  assert.strictEqual(restored.success, true, JSON.stringify(restored).slice(0, 600));
  assert.strictEqual(restored.data.restored_from_version, 1);
  assert.match(db.doc('STATE.md').content, /Verified at setup\./);
  assert.doesNotMatch(db.doc('STATE.md').content, /Checked at setup\./);

  const handoff = await rpc('write_doc', {
    doc_id: 'HANDOFF.md',
    content: '# Handoff\n\nLeft for later.\n',
    session_id: sessionId,
    source: HOST,
    reason: REASON
  });
  const handoffText = JSON.stringify(handoff);
  assert.match(handoffText, /handoff is written last/);
  assert.doesNotMatch(handoffText, /could not be loaded/);

  const closed = await rpc('emet_session_close', { session_id: sessionId, source: HOST });
  const closedText = JSON.stringify(closed);
  assert.strictEqual(closed.success, true, closedText.slice(0, 500));
  assert.doesNotMatch(closedText, /could not be loaded/);
  assert.ok(closed.data && closed.data.state, closedText.slice(0, 400));
});

test('a drop list that failed to load still refuses a board patch and restore over HTTP', async () => {
  try {
    await boot();
    assert.ok(shared.loadId, 'the empty-list startup did not run');
    // A retained revision has to exist, or restore stops on the digest check
    // before the drop guard. This prep session already has a verified list.
    const { patchDoc } = await import('../src/tools.js');
    db.col('emet_sessions').docs.push({ _id: 'prep-board', opened: true, drops_seen: [] });
    await patchDoc('STATE.md', 'Verified at setup.', 'Checked at setup.', HOST, null, null, { reason: REASON, session_id: 'prep-board' });
    storeOpts.failUnhandledDropRead = true;
    let opened;
    try {
      opened = await rpc('emet_session_open', { slug: 'board-drop-load-failed', load_id: shared.loadId });
    } finally {
      storeOpts.failUnhandledDropRead = false;
    }
    assert.strictEqual(opened.success, true, JSON.stringify(opened).slice(0, 600));
    assert.strictEqual(opened.data.drops_unverified, true);
    assert.strictEqual(opened.data.drops_seen, null);
    const sessionId = opened.data.session_id;
    const base = String(sessionId).replace(/_verbatim_part\d+$/, '');
    const stuck = await waitFor(() => {
      const row = db.row(base);
      return row && row.drops_unverified === true ? row : null;
    });
    assert.ok(stuck, 'the failed drop load was not recorded');
    assert.ok(!Array.isArray(stuck.drops_seen));

    const appended = await rpc('emet_transcript_append', {
      session_id: sessionId,
      exchange_index: 1,
      user_message: 'The drop list failed.',
      assistant_message: 'The board stays closed.',
      source: HOST
    });
    assert.strictEqual(appended.success, true, JSON.stringify(appended).slice(0, 400));

    const version = db.doc('STATE.md').version;
    const patched = await rpc('patch_doc', {
      doc_id: 'STATE.md',
      old_str: 'Checked at setup.',
      new_str: 'Noted at setup.',
      expected_version: version,
      session_id: sessionId,
      source: HOST,
      reason: REASON
    });
    assert.strictEqual(patched.success, false);
    assert.match(JSON.stringify(patched), /unhandled drops could not be loaded/);
    assert.match(db.doc('STATE.md').content, /Checked at setup\./);
    assert.doesNotMatch(db.doc('STATE.md').content, /Noted at setup\./);

    const restored = await rpc('restore_doc', {
      doc_id: 'STATE.md',
      version: 1,
      session_id: sessionId,
      source: HOST,
      reason: REASON
    });
    assert.strictEqual(restored.success, false);
    assert.match(JSON.stringify(restored), /unhandled drops could not be loaded/);

    const again = await rpc('emet_session_open', { slug: 'board-drop-load-failed', load_id: shared.loadId });
    assert.strictEqual(again.success, true, JSON.stringify(again).slice(0, 500));
    assert.deepStrictEqual(again.data.drops_seen, []);
    assert.notStrictEqual(again.data.drops_unverified, true);
    const cleared = await waitFor(() => {
      const row = db.row(base);
      return row && Array.isArray(row.drops_seen) && row.drops_unverified !== true ? row : null;
    });
    const recovered = await rpc('patch_doc', {
      doc_id: 'STATE.md',
      old_str: 'Checked at setup.',
      new_str: 'Noted at setup.',
      expected_version: version,
      session_id: again.data.session_id,
      source: HOST,
      reason: REASON
    });
    assert.ok(cleared, `a later verified empty list was not stored; patch: ${JSON.stringify(recovered).slice(0, 500)}`);
    assert.deepStrictEqual(cleared.drops_seen, []);
    assert.strictEqual(recovered.success, true, JSON.stringify(recovered).slice(0, 500));
  } finally {
    await shutdown();
  }
});

summary('BOARD HTTP DROPS TEST SUMMARY');
