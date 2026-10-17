/**
 * Delegated client sub-keys (EMET-0001). The fourteen tests in §10, plus the
 * extras from the accepted proposal: emh_/emn_ prefixes, end-session without
 * burning the key, pepper version, the strict-off residual wording, and
 * session_handle staying out of receipts, logs and session_graph.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test, testGroup, summary } from './harness.js';
import { withEnv, withStore, makeStore } from './memstore.js';
import { createMemoryStore } from '../src/subkey-store.js';

console.log('\n=== delegated client sub-keys ===');

const CLIENT = '8xm-7ILLKEDFc3-QRxqlgw';
const PEPPER = 'pepper-pepper-pepper-pepper-pepper-32b';
const PREV = 'previous-pepper-previous-pepper-32b!';
const REG = ['hub-bot', 'intake-bot', 'grok-project', 'cowork-cloud'];
const ON = {
  EMET_SUBKEYS: '1',
  EMET_SUBKEY_PEPPER: PEPPER,
  EMET_SOURCE_TAGS: REG.join(','),
  EMET_SUBKEY_FAIL_MAX: '5',
  EMET_SUBKEY_GRACE_MINUTES: '10',
  EMET_SUBKEY_TTL_DAYS: '30',
  EMET_STRICT_LOGIN_TAG: undefined,
  EMET_COS_TAG: undefined,
  EMET_RECORD_DOCS: 'bots/hub-bot/HANDOFF.md,bots/intake-bot/HANDOFF.md,bots/grok-project/HANDOFF.md',
  EMET_SUBKEY_PEPPER_VERSION: undefined,
  EMET_SUBKEY_PEPPER_PREV: undefined,
  EMET_SUBKEY_PEPPER_PREV_VERSION: undefined
};
const NOW = new Date('2026-10-15T16:00:00Z');

function fakeDb({ tokens = [] } = {}) {
  const data = { oauth_tokens: tokens };
  const matchV = (val, cond) => cond instanceof RegExp ? typeof val === 'string' && cond.test(val) : val === cond;
  const get = (row, k) => k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), row);
  const mk = (rows) => ({
    find(q) {
      const out = rows.filter((r) => Object.entries(q || {}).every(([k, v]) => matchV(get(r, k), v)));
      return { limit() { return { toArray: async () => out }; }, toArray: async () => out };
    }
  });
  return { collection(name) { const key = name.replace(/^emet_/, ''); return mk(data[key] || []); } };
}
function memDeps(initial = null) {
  const store = { content: initial, version: initial === null ? null : 1, writes: 0 };
  return {
    store,
    readDoc: async () => {
      if (store.content === null) throw new Error('Document not found: emet/CLIENT_APPROVALS.md');
      return { content: store.content, version: store.version };
    },
    writeDoc: async (_id, c, expected) => {
      if ((expected ?? null) !== (store.version ?? null)) { const e = new Error('conflict'); e.versionConflict = true; throw e; }
      store.content = c; store.version = (store.version || 0) + 1; store.writes++;
      return { version: store.version };
    },
    subkeys: createMemoryStore()
  };
}
async function records(deps, sk) { return sk.loadSubkeyRecords(deps); }
const ownerHost = (extra = {}) => ({ personId: 'alex', ownerId: 'alex', clientId: 'claude-host', transport: 'http', authenticated: true, sourceTag: 'cowork-cloud', sourceBasis: 'login', scopes: [], ...extra });
const actorFor = (extra = {}) => ({ personId: 'alex', ownerId: 'alex', clientId: CLIENT, transport: 'http', authenticated: true, sourceTag: 'hub-bot', sourceBasis: 'login', scopes: [], ...extra });
async function fresh() {
  const att = await import('../src/attribution.js');
  const sk = await import('../src/subkeys.js');
  att._resetForTests();
  sk._resetForTests();
  return { att, sk };
}
function world(over = {}) {
  const deps = over.deps || memDeps();
  const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW, ...over, deps };
  return { deps, c };
}

async function issue(deps, sk, { tag = 'intake-bot', bot = actorFor(), owner = ownerHost(), now = NOW } = {}) {
  const req = await sk.requestSubkey(deps, bot, { tag }, REG, now);
  const decided = await sk.decideSubkeyIfPending(deps, owner, 'alex', { tag, decision: 'approve' }, now);
  const claimed = await sk.claimSubkey(deps, bot, { key_id: req.key_id, nonce: req.nonce }, now);
  return { req, decided, claimed, bot, tag };
}
async function openKey(att, sk, c, deps, claimed, { slug = 'intake', bot = actorFor(), now = NOW, source } = {}) {
  const base = att.sessionOpenBase({ slug }, now);
  const opener = bot;
  await att.preflight(c, opener, { slug, subkey: claimed.subkey, ...(source ? { source } : {}) }, 'emet_session_open');
  const handle = await sk.commitLiveSession(deps, opener, base, now);
  return { base, handle, opener };
}

testGroup('1. a mismatched source on a sub-key session is refused', () => {
  test('source b on a session bound to tag a writes nothing and the stamp stays a', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    const writer = actorFor();
    await assert.rejects(
      () => att.preflight(c, writer, { session_id: base, session_handle: handle, source: 'hub-bot' }, 'write_doc'),
      /bound to "intake-bot"/
    );
    const quiet = actorFor();
    await att.preflight(c, quiet, { session_id: base, session_handle: handle }, 'write_doc');
    const { actorStore } = await import('../src/persons.js');
    const { resolvedSourceTag } = await import('../src/tools.js');
    const stamp = actorStore.run(quiet, () => resolvedSourceTag(null));
    assert.equal(stamp.tag, 'intake-bot');
    assert.equal(stamp.from, 'subkey');
    const snap = await sk.loadSubkeyRecords(deps);
    assert.ok(snap.sessions.some((s) => s.session_id === base && s.state === 'live'));
    assert.equal(deps.store.writes, 0);
  }));
});

testGroup('2. no source is stamped with the key tag', () => {
  test('read_doc_history shows the tag and key_id, never the key or the handle', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    const writer = actorFor();
    await att.preflight(c, writer, { session_id: base, session_handle: handle }, 'write_doc');
    const store = makeStore();
    await withStore(store, async () => {
      const { actorStore } = await import('../src/persons.js');
      const { writeDoc, readDocHistory } = await import('../src/tools.js');
      const { sourceOf } = await import('../src/dispatch.js');
      await actorStore.run(writer, async () => {
        const tag = sourceOf({ session_id: base });
        assert.equal(tag, 'intake-bot');
        await writeDoc('notes/subkey-stamp.md', '# Stamp\n', tag, null, null, { session_id: base });
      });
      const hist = await readDocHistory('notes/subkey-stamp.md', 1);
      assert.equal(hist.updated_by, 'intake-bot');
      assert.ok(claimed.key_id);
      assert.equal(hist.key_id, claimed.key_id);
      const body = JSON.stringify(hist);
      assert.equal(body.includes(claimed.subkey), false);
      assert.equal(body.includes(handle), false);
      assert.equal(body.includes('emh_'), false);
      assert.equal(body.includes('emk_'), false);
    });
  }));
});

testGroup('3. a sub-key session write needs its handle', () => {
  test('missing handle and a wrong handle are refused', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: base }, 'write_doc'), /session_handle/);
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: base, session_handle: 'emh_' + 'a'.repeat(43) }, 'write_doc'), /does not match/);
    await att.preflight(c, actorFor(), { session_id: base, session_handle: handle }, 'save_to_layer');
  }));
});

testGroup('4. claim needs the nonce, once', () => {
  test('key_id alone, a wrong nonce, and a second claim are refused; a wrong nonce does not spend it', async () => withEnv(ON, async () => {
    const { sk } = await fresh();
    const { deps } = world();
    const bot = actorFor();
    const req = await sk.requestSubkey(deps, bot, { tag: 'intake-bot' }, REG, NOW);
    await sk.decideSubkeyIfPending(deps, ownerHost(), 'alex', { tag: 'intake-bot', decision: 'approve' }, NOW);
    await assert.rejects(() => sk.claimSubkey(deps, bot, { key_id: req.key_id }, NOW), /nonce/);
    await assert.rejects(() => sk.claimSubkey(deps, bot, { key_id: req.key_id, nonce: 'emn_' + 'b'.repeat(43) }, NOW), /does not match/);
    const claimed = await sk.claimSubkey(deps, bot, { key_id: req.key_id, nonce: req.nonce }, NOW);
    assert.match(claimed.subkey, /^emk_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    await assert.rejects(() => sk.claimSubkey(deps, bot, { key_id: req.key_id, nonce: req.nonce }, NOW), /already used|does not match/);
    const stored = JSON.stringify(await records(deps, sk));
    assert.equal(String(deps.store.content || '').includes(req.nonce), false);
    assert.equal(String(deps.store.content || '').includes(claimed.subkey), false);
    assert.equal(stored.includes(req.nonce), false);
    assert.equal(stored.includes(claimed.subkey), false);
  }));
});

testGroup('5. approval is another OAuth client', () => {
  test('the same client_id or grant is refused; another client succeeds', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps } = world();
    const bot = actorFor({ grantId: 'grant-shared' });
    await sk.requestSubkey(deps, bot, { tag: 'intake-bot' }, REG, NOW);
    await assert.rejects(
      () => att.clientApprove(deps, ownerHost({ clientId: CLIENT }), 'alex', { tag: 'intake-bot', decision: 'approve' }, REG, NOW),
      /may not decide it/
    );
    await assert.rejects(
      () => att.clientApprove(deps, ownerHost({ grantId: 'grant-shared' }), 'alex', { tag: 'intake-bot', decision: 'approve' }, REG, NOW),
      /may not decide it/
    );
    const ok = await att.clientApprove(deps, ownerHost(), 'alex', { tag: 'intake-bot', decision: 'approve' }, REG, NOW);
    assert.equal(ok.kind, 'subkey');
    assert.equal(ok.decision, 'approve');
  }));
});

testGroup('6. one live session per key', () => {
  test('a second open is refused and flagged, even from the same client and grant', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const bot = actorFor({ grantId: 'g1' });
    const { claimed } = await issue(deps, sk, { bot });
    const { base } = await openKey(att, sk, c, deps, claimed, { bot: actorFor({ grantId: 'g1' }) });
    const again = actorFor({ grantId: 'g1' });
    await assert.rejects(
      () => att.preflight(c, again, { slug: 'intake-2', subkey: claimed.subkey }, 'emet_session_open'),
      /already has a live session/
    );
    const snap = await records(deps, sk);
    const row = snap.keys[claimed.key_id];
    assert.ok(row.collisions.length >= 1);
    assert.equal(row.collisions[0].client_id, CLIENT);
    const live = snap.sessions.find((s) => s.open_id === row.live_session_id);
    assert.equal(live.session_id, base);
    assert.equal(live.state, 'live');
    assert.equal(row.status, 'active');
  }));
});

testGroup('7. revoked and expired keys', () => {
  test('open is refused, the next write after revoke is refused, earlier writes stay', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    const writer = actorFor();
    await att.preflight(c, writer, { session_id: base, session_handle: handle }, 'write_doc');
    const store = makeStore();
    let before;
    await withStore(store, async () => {
      const { actorStore } = await import('../src/persons.js');
      const { writeDoc, readDoc } = await import('../src/tools.js');
      const { sourceOf } = await import('../src/dispatch.js');
      await actorStore.run(writer, async () => {
        await writeDoc('notes/subkey-keep.md', '# Keep\n', sourceOf({}), null, null, { session_id: base });
      });
      before = await readDoc('notes/subkey-keep.md');
    });
    await sk.revokeSubkey(deps, ownerHost(), 'alex', { key_id: claimed.key_id, reason: 'test revoke' }, NOW);
    await assert.rejects(
      () => att.preflight(c, actorFor(), { session_id: base, session_handle: handle }, 'write_doc'),
      /sub-key revoked; open a new session with a current key/
    );
    await assert.rejects(
      () => att.preflight({ ...c, now: new Date('2026-12-01T00:00:00Z') }, actorFor(), { slug: 'later', subkey: claimed.subkey }, 'emet_session_open'),
      /revoked|expired|does not match/
    );
    await withStore(store, async () => {
      const { readDoc } = await import('../src/tools.js');
      const after = await readDoc('notes/subkey-keep.md');
      assert.equal(after.content, before.content);
      assert.equal(after.updated_by, 'intake-bot');
      assert.equal(after.sha256, before.sha256);
    });
    const row = (await records(deps, sk)).keys[claimed.key_id];
    assert.equal(row.status, 'revoked');
    assert.ok(Array.isArray(row.history) && row.history.length > 1);
  }));
  test('an expired key is refused at session open and the record is kept', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const later = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    await assert.rejects(
      () => att.preflight({ ...c, now: later }, actorFor(), { slug: 'late', subkey: claimed.subkey }, 'emet_session_open'),
      /expired/
    );
    assert.equal((await records(deps, sk)).keys[claimed.key_id].status, 'expired');
  }));
});

testGroup('8. rotation grace', () => {
  test('the old key works only inside the grace window', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const first = await issue(deps, sk);
    const bot = actorFor();
    const req = await sk.requestSubkey(deps, bot, { tag: 'intake-bot' }, REG, NOW);
    assert.equal(req.replaces, first.claimed.key_id);
    await sk.decideSubkeyIfPending(deps, ownerHost(), 'alex', { tag: 'intake-bot', decision: 'approve' }, NOW);
    await sk.claimSubkey(deps, bot, { key_id: req.key_id, nonce: req.nonce }, NOW);
    const inside = new Date(NOW.getTime() + 60 * 1000);
    await att.preflight({ ...c, now: inside }, actorFor(), { slug: 'grace', subkey: first.claimed.subkey }, 'emet_session_open');
    const outside = new Date(NOW.getTime() + 11 * 60 * 1000);
    await assert.rejects(
      () => att.preflight({ ...c, now: outside }, actorFor(), { slug: 'after', subkey: first.claimed.subkey }, 'emet_session_open'),
      /revoked|expired|does not match/
    );
  }));
});

testGroup('9. lookup and a missing pepper', () => {
  test('lookup is by key_id and the compare is constant-time; a missing pepper fails closed', async () => withEnv(ON, async () => {
    const { sk } = await fresh();
    const { deps } = world();
    const { claimed } = await issue(deps, sk);
    const parts = sk.splitKeyToken(claimed.subkey);
    assert.equal(parts.key_id, claimed.key_id);
    const peppers = sk.pepperState();
    const row = (await records(deps, sk)).keys[parts.key_id];
    assert.equal(sk.verifyMac(row.secret_hmac, parts.secret, peppers), true);
    assert.equal(sk.verifyMac(row.secret_hmac, 'not-the-secret-not-the-secret-not-32', peppers), false);
    const orig = crypto.timingSafeEqual;
    let calls = 0;
    crypto.timingSafeEqual = function () { calls++; return orig.apply(this, arguments); };
    try { sk.macEqual(row.secret_hmac.mac, row.secret_hmac.mac); }
    finally { crypto.timingSafeEqual = orig; }
    assert.ok(calls >= 1);
    await assert.rejects(() => sk.claimSubkey(deps, actorFor(), { key_id: 'f'.repeat(32), nonce: 'emn_' + 'c'.repeat(43) }, NOW), /does not match/);
  }));
  test('every sub-key tool fails closed without a pepper', async () => withEnv({ ...ON, EMET_SUBKEY_PEPPER: undefined }, async () => {
    const { sk } = await fresh();
    const deps = memDeps();
    const bot = actorFor();
    await assert.rejects(() => sk.requestSubkey(deps, bot, { tag: 'intake-bot' }, REG, NOW), /EMET_SUBKEY_PEPPER/);
    await assert.rejects(() => sk.claimSubkey(deps, bot, { key_id: 'a'.repeat(32), nonce: 'emn_' + 'd'.repeat(43) }, NOW), /EMET_SUBKEY_PEPPER/);
    await assert.rejects(() => sk.revokeSubkey(deps, ownerHost(), 'alex', { tag: 'intake-bot' }, NOW), /EMET_SUBKEY_PEPPER/);
    await assert.rejects(() => sk.endSubkeySession(deps, ownerHost(), 'alex', { tag: 'intake-bot' }, NOW), /EMET_SUBKEY_PEPPER/);
  }));
});

testGroup('10. redaction and no handle echo', () => {
  test('emk_, emh_ and emn_ are masked; a bare key_id is not', async () => withEnv(ON, async () => {
    const { redactText } = await import('../src/redact.js');
    const key = 'emk_' + 'ab'.repeat(16) + '_' + 'A'.repeat(43);
    const handle = 'emh_' + 'B'.repeat(43);
    const nonce = 'emn_' + 'C'.repeat(43);
    const id = 'ab'.repeat(16);
    const masked = redactText(`log ${key} handle ${handle} nonce ${nonce} id ${id}`);
    assert.equal(masked.includes(key), false);
    assert.equal(masked.includes(handle), false);
    assert.equal(masked.includes(nonce), false);
    assert.equal(masked.includes(id), true);
    const { StructuredLogger } = await import('../src/logger.js');
    const lines = [];
    const orig = console.error;
    console.error = (line) => lines.push(String(line));
    try { new StructuredLogger({ minLevel: 'debug' }).info('saw ' + key + ' ' + handle); }
    finally { console.error = orig; }
    assert.ok(lines.length >= 1);
    assert.equal(lines.join('\n').includes(key), false);
    assert.equal(lines.join('\n').includes(handle), false);
  }));
  test('session_handle is absent from lab rows, the session graph, receipts and request logs', async () => withEnv(ON, async () => {
    const { sk } = await fresh();
    const { labRow, graphBlock, recordStep } = await import('../src/session-graph.js');
    const { requestLogEntry, formatRequestLog } = await import('../src/request-log.js');
    const handle = 'emh_' + 'D'.repeat(43);
    const key = 'emk_' + 'cd'.repeat(16) + '_' + 'E'.repeat(43);
    const graph = { mode: 'enforce', base: '2026-10-15_intake', decision: { verdict: 'ok', gate: null, reason: null, next: 'append' } };
    const lab = labRow('write_doc', { doc_id: 'notes/x.md', session_id: '2026-10-15_intake', session_handle: handle, subkey: key, source: 'intake-bot' }, graph);
    assert.equal(JSON.stringify(lab).includes(handle), false);
    assert.equal(JSON.stringify(lab).includes(key), false);
    assert.equal(JSON.stringify(graphBlock(graph)).includes(handle), false);
    const step = recordStep('emet_session_open', { subkey: key }, { session_handle: handle, base: '2026-10-15_intake' });
    assert.equal(JSON.stringify(step).includes(handle), false);
    const entry = requestLogEntry({
      method: 'POST', path: '/mcp', statusCode: 200, ms: 3,
      body: { method: 'tools/call', params: { name: 'write_doc', arguments: { session_handle: handle, subkey: key, doc_id: 'notes/x.md' } } }
    });
    assert.deepEqual(entry.params, ['doc_id', 'session_handle', 'subkey']);
    assert.equal(JSON.stringify(entry).includes(handle), false);
    assert.equal(JSON.stringify(entry).includes(key), false);
    const echoed = formatRequestLog({ ...entry, reason: handle });
    assert.equal(echoed.includes(handle), false);
  }));
});

testGroup('11. failed-present throttle', () => {
  test('N failures per key_id and per client_id block the next present; a success clears the client', async () => withEnv({ ...ON, EMET_SUBKEY_FAIL_MAX: '2' }, async () => {
    const { sk } = await fresh();
    const { deps } = world();
    const bot = actorFor();
    const other = actorFor({ clientId: 'other-client' });
    const a = await sk.requestSubkey(deps, bot, { tag: 'intake-bot' }, REG, NOW);
    await sk.decideSubkeyIfPending(deps, ownerHost(), 'alex', { tag: 'intake-bot', decision: 'approve' }, NOW);
    const wrong = 'emn_' + 'e'.repeat(43);
    await assert.rejects(() => sk.claimSubkey(deps, bot, { key_id: a.key_id, nonce: wrong }, NOW), /does not match/);
    const got = await sk.claimSubkey(deps, bot, { key_id: a.key_id, nonce: a.nonce }, NOW);
    assert.match(got.subkey, /^emk_/);
    const b = await sk.requestSubkey(deps, bot, { tag: 'grok-project' }, REG, NOW);
    await sk.decideSubkeyIfPending(deps, ownerHost(), 'alex', { tag: 'grok-project', decision: 'approve' }, NOW);
    await assert.rejects(() => sk.claimSubkey(deps, bot, { key_id: b.key_id, nonce: wrong }, NOW), /does not match/);
    await assert.rejects(() => sk.claimSubkey(deps, bot, { key_id: b.key_id, nonce: wrong }, NOW), /does not match/);
    await assert.rejects(() => sk.claimSubkey(deps, bot, { key_id: b.key_id, nonce: wrong }, NOW), /too many failed/);
    const still = await sk.claimSubkey(deps, bot, { key_id: b.key_id, nonce: b.nonce }, NOW);
    assert.match(still.subkey, /^emk_/);
    await assert.rejects(() => sk.claimSubkey(deps, other, { key_id: b.key_id, nonce: wrong }, NOW), /does not match|too many failed|already used/);
    // The other client has its own bucket, so a fresh key still claims.
    const c = await sk.requestSubkey(deps, other, { tag: 'cowork-cloud' }, REG, NOW);
    await sk.decideSubkeyIfPending(deps, ownerHost(), 'alex', { tag: 'cowork-cloud', decision: 'approve' }, NOW);
    const claimed = await sk.claimSubkey(deps, other, { key_id: c.key_id, nonce: c.nonce }, NOW);
    assert.equal(claimed.tag, 'cowork-cloud');
  }));
});

testGroup('12. strict mode and declared_attribution', () => {
  test('strict on: a declared tag passes only with a valid handle for that tag', async () => withEnv({ ...ON, EMET_STRICT_LOGIN_TAG: '1' }, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    await assert.rejects(
      () => att.preflight(c, actorFor(), { source: 'intake-bot', session_id: 'strict-free' }, 'write_doc'),
      /bound to "hub-bot"/
    );
    const { base, handle } = await openKey(att, sk, c, deps, claimed, { source: 'intake-bot' });
    const writer = actorFor();
    await att.preflight(c, writer, { session_id: base, session_handle: handle, source: 'intake-bot' }, 'write_doc');
    assert.equal(writer.sourceBasis, 'subkey');
    assert.equal(writer.effectiveTag, 'intake-bot');
  }));
  test('strict off: a registered declared tag is declared_attribution, not ambiguous', async () => withEnv(ON, async () => {
    const { classifyRow } = await import('../src/gaps.js');
    const { digest, digestMetadata } = await import('../src/aleph.js');
    const content = 'a stored entry';
    const metadata = { source: 'cowork-cloud', source_basis: 'declared', assertion_origin: 'user', routing: { method: 'explicit' }, tags: ['a'] };
    const row = {
      id: 1, content, sha256: digest(content), metadata, metadata_sha256: digestMetadata(metadata),
      is_live: true, superseded_by: null, valid_until: null,
      source_session_id: '2026-10-15_x', source_exchange_start: 1, source_exchange_end: 1
    };
    const gaps = classifyRow('working', row, { registry: ['cowork-cloud'], nowSec: 1_800_000_000 });
    assert.ok(gaps.includes('declared_attribution'));
    assert.equal(gaps.includes('ambiguous_attribution'), false);
    const { att } = await fresh();
    const a = actorFor();
    await att.preflight(world().c, a, { source: 'intake-bot', session_id: 'v2-still' }, 'save_to_layer');
    assert.equal(a.sourceBasis, 'declared');
    assert.equal(a.effectiveTag, 'intake-bot');
  }));
});

testGroup('13. who may use a sub-key', () => {
  test('a sub-key session cannot call owner-only tools', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk, { tag: 'grok-project' });
    const { base, handle } = await openKey(att, sk, c, deps, claimed, { slug: 'proj' });
    for (const tool of ['emet_client_approve', 'emet_subkey_request', 'emet_subkey_revoke', 'emet_invite_create', 'emet_member_access_create', 'emet_setup_complete']) {
      await assert.rejects(
        () => att.preflight(c, ownerHost(), { session_id: base, session_handle: handle, tag: 'grok-project', decision: 'approve' }, tool),
        /cannot call this tool/
      );
    }
    await assert.rejects(
      () => att.preflight(c, ownerHost(), { session_id: base, session_handle: 'emh_' + 'a'.repeat(43), tag: 'grok-project', decision: 'approve' }, 'emet_client_approve'),
      /does not match/
    );
  }));
  test('invite and member logins cannot request, claim or present', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const guest = { personId: 'guest', ownerId: 'alex', clientId: 'guest-1', transport: 'http', authenticated: true, sourceTag: 'cowork-cloud', sourceBasis: 'login' };
    await assert.rejects(() => sk.requestSubkey(deps, guest, { tag: 'intake-bot' }, REG, NOW), /Invite and Member/);
    await assert.rejects(() => sk.claimSubkey(deps, guest, { key_id: 'a'.repeat(32), nonce: 'emn_' + 'f'.repeat(43) }, NOW), /Invite and Member/);
    const { claimed } = await issue(deps, sk);
    await assert.rejects(
      () => att.preflight(c, guest, { slug: 'nope', subkey: claimed.subkey }, 'emet_session_open'),
      /Invite and Member/
    );
  }));
  test('stdio ignores a presented sub-key and the sub-key tools refuse', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const stdio = { transport: 'stdio', personId: 'alex' };
    const out = await att.preflight(c, stdio, { subkey: claimed.subkey, source: 'intake-bot' }, 'write_doc');
    assert.equal(out, stdio);
    assert.equal(stdio.subkeySession, undefined);
    await assert.rejects(() => sk.requestSubkey(deps, stdio, { tag: 'intake-bot' }, REG, NOW), /authenticated HTTP/);
  }));
});

testGroup('14. the key list is owner and COS only', () => {
  test('owner and COS see keys with no secrets; a bot and a guest see nothing', async () => withEnv({ ...ON, EMET_COS_TAG: 'hub-cos', EMET_RECORD_DOCS: 'bots/hub-cos/HANDOFF.md,bots/hub-bot/HANDOFF.md' }, async () => {
    const { sk } = await fresh();
    const { deps } = world();
    const { claimed } = await issue(deps, sk);
    const data = await records(deps, sk);
    const owner = sk.subkeysView(data, ownerHost(), 'alex', NOW);
    const cos = sk.subkeysView(data, { personId: 'alex', ownerId: 'alex', clientId: 'cos-client', transport: 'http', authenticated: true, sourceTag: 'hub-cos', sourceBasis: 'login' }, 'alex', NOW);
    const bot = sk.subkeysView(data, actorFor(), 'alex', NOW);
    const guest = sk.subkeysView(data, { personId: 'guest', ownerId: 'alex', clientId: 'g', transport: 'http', authenticated: true, sourceTag: 'cowork-cloud', sourceBasis: 'login' }, 'alex', NOW);
    assert.equal(owner.keys.length, 1);
    assert.equal(cos.keys.length, 1);
    assert.equal(owner.keys[0].key_id, claimed.key_id);
    assert.equal(owner.keys[0].tag, 'intake-bot');
    assert.ok('last_used' in owner.keys[0]);
    assert.ok(Array.isArray(owner.keys[0].collision_flags));
    const listed = JSON.stringify(owner);
    assert.equal(listed.includes(claimed.subkey), false);
    assert.equal(listed.includes('hmac'), false);
    assert.equal(listed.includes('emk_'), false);
    assert.equal(bot, null);
    assert.equal(guest, null);
  }));
});

testGroup('extras', () => {
  test('end session frees the key without revoking it', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    await assert.rejects(() => sk.endSubkeySession(deps, actorFor(), 'alex', { key_id: claimed.key_id }, NOW), /only the owner's own login/);
    const ended = await sk.endSubkeySession(deps, ownerHost(), 'alex', { key_id: claimed.key_id, reason: 'stuck' }, NOW);
    assert.equal(ended.ended, true);
    assert.equal(ended.status, 'active');
    await assert.rejects(
      () => att.preflight(c, actorFor(), { session_id: base, session_handle: handle }, 'write_doc'),
      /ended/
    );
    const again = await openKey(att, sk, c, deps, claimed, { slug: 'intake-again' });
    assert.match(again.handle, /^emh_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(again.handle, handle);
  }));
  test('a seal from the previous pepper still verifies; new seals use the current version', async () => withEnv({ ...ON, EMET_SUBKEY_PEPPER_VERSION: '1' }, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    await withEnv({ ...ON, EMET_SUBKEY_PEPPER: PREV, EMET_SUBKEY_PEPPER_VERSION: '2', EMET_SUBKEY_PEPPER_PREV: PEPPER, EMET_SUBKEY_PEPPER_PREV_VERSION: '1' }, async () => {
      await att.preflight(c, actorFor(), { slug: 'rotated-pepper', subkey: claimed.subkey }, 'emet_session_open');
      const bot = actorFor();
      const req = await sk.requestSubkey(deps, bot, { tag: 'grok-project' }, REG, NOW);
      const row = (await records(deps, sk)).keys[req.key_id];
      assert.equal(row.nonce_hmac.pepper_version, 2);
      await withEnv({ ...ON, EMET_SUBKEY_PEPPER: PREV, EMET_SUBKEY_PEPPER_VERSION: '2', EMET_SUBKEY_PEPPER_PREV: undefined }, async () => {
        await assert.rejects(
          () => att.preflight({ ...c, now: NOW }, actorFor(), { slug: 'no-prev', subkey: claimed.subkey }, 'emet_session_open'),
          /does not match/
        );
      });
    });
  }));
  test('session open returns the handle once and does not log it', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const store = makeStore();
    await withStore(store, async () => {
      const { approvalsDeps, sessionOpen } = await import('../src/tools.js');
      const { actorStore } = await import('../src/persons.js');
      const bot = actorFor();
      const { claimed } = await issue(approvalsDeps, sk, { bot });
      const opener = actorFor();
      await att.preflight({ db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps: approvalsDeps, registry: REG, now: NOW }, opener, { slug: 'intake', subkey: claimed.subkey }, 'emet_session_open');
      const lines = [];
      const orig = console.error;
      console.error = (line) => lines.push(String(line));
      let opened;
      try {
        opened = await actorStore.run(opener, () => sessionOpen({ slug: 'intake' }, { info() {}, warn() {} }, store, NOW));
      } finally { console.error = orig; }
      assert.match(opened.session_handle, /^emh_[A-Za-z0-9_-]{43}$/);
      const rest = { ...opened };
      delete rest.session_handle;
      assert.equal(JSON.stringify(rest).includes(opened.session_handle), false);
      assert.equal(JSON.stringify(rest).includes(claimed.subkey), false);
      assert.equal(lines.join('\n').includes(opened.session_handle), false);
    });
  }));
  test('flag off ignores a sub-key argument and does not drop stored sub-key records', async () => withEnv({ ...ON, EMET_SUBKEYS: undefined }, async () => {
    const { att, sk } = await fresh();
    const a = actorFor();
    await att.preflight(world().c, a, { source: 'intake-bot', subkey: 'emk_' + 'ab'.repeat(16) + '_' + 'Z'.repeat(43), session_id: 'flag-off' }, 'save_to_layer');
    assert.equal(a.sourceBasis, 'declared');
    assert.equal(a.subkeySession, undefined);
    assert.equal(sk.subkeysView({ subkeys: { a: { tag: 't', key_id: 'a', status: 'active' } } }, ownerHost(), 'alex', NOW), null);
    const initial = att.renderApprovals({
      approved: {}, pending: { 'grok-project': { client_id: 'someone-else', first_seen: NOW.toISOString() } },
      denied: {}, clients: {}
    });
    const deps = memDeps(initial);
    deps.subkeys = (await import('../src/subkey-store.js')).createMemoryStore();
    await deps.subkeys.mutate((data) => {
      data.keys = { abc: { key_id: 'abc', tag: 'intake-bot', status: 'active', history: [{ event: 'claim', at: NOW.toISOString() }] } };
      data.sessions = [{ open_id: 's1', session_id: 's1', key_id: 'abc', state: 'live' }];
      return true;
    });
    await att.clientApprove(deps, ownerHost(), 'alex', { tag: 'grok-project', decision: 'approve' }, REG, NOW);
    const parsed = att.parseApprovals(deps.store.content);
    assert.equal(parsed.subkeys, undefined);
    assert.equal(parsed.approved['grok-project'] != null, true);
    const kept = await deps.subkeys.snapshot();
    assert.equal(kept.keys.abc.status, 'active');
    assert.equal(kept.sessions[0].state, 'live');
  }));
  test('a complete close releases the live session and the record stays', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    const bare = await sk.releaseClosedSession(deps, base, NOW);
    assert.equal(bare, null);
    const released = await sk.releaseClosedSession(deps, base, NOW, { handle, subkey: claimed.subkey });
    assert.equal(released.session_id, base);
    await assert.rejects(
      () => att.preflight(c, actorFor(), { session_id: base, session_handle: handle }, 'write_doc'),
      /closed/
    );
    const data = await records(deps, sk);
    assert.equal(data.sessions.find((s) => s.session_id === base).state, 'closed');
    assert.equal(data.keys[claimed.key_id].status, 'active');
    assert.equal(data.keys[claimed.key_id].live_session_id, null);
  }));
  test('the accepted proposal records Alex\'s decisions and the strict-off residual', () => {
    const text = fs.readFileSync(new URL('../docs/proposals/EMET-0001-delegated-client-sub-keys.md', import.meta.url), 'utf8');
    assert.match(text, /Accepted 2026-10-15 by Alex/);
    assert.match(text, /still possible, counted in `declared_attribution`/);
    assert.match(text, /kept as a history event/);
    assert.match(text, /status and last_used change in place/);
    assert.match(text, /Keys expire after 30 days/);
    assert.match(text, /No separate OAuth client/);
    assert.match(text, /local secret/);
    assert.match(text, /ISO 9001:2015 clause 7\.5\.3 and ISO 13485:2016 clause 4\.2\.5/);
    assert.match(text, /Charter and floor/);
  });
  test('flag off omits the tools, schema fields, and declared_attribution; flag on registers them', async () => {
    const { hostTools } = await import('../src/tools.js');
    const { GAP_CLASSES, classifyRow } = await import('../src/gaps.js');
    const { digest, digestMetadata } = await import('../src/aleph.js');
    const content = 'a stored entry';
    const metadata = { source: 'cowork-cloud', source_basis: 'declared', assertion_origin: 'user', routing: { method: 'explicit' }, tags: ['a'] };
    const row = {
      id: 1, content, sha256: digest(content), metadata, metadata_sha256: digestMetadata(metadata),
      is_live: true, superseded_by: null, valid_until: null
    };
    const names = ['emet_subkey_request', 'emet_subkey_claim', 'emet_subkey_revoke', 'emet_subkey_end_session'];
    await withEnv({ EMET_SUBKEYS: undefined, EMET_SUBKEY_PEPPER: PEPPER }, async () => {
      const { sk } = await fresh();
      const tools = hostTools();
      for (const name of names) assert.equal(tools.some((t) => t.name === name), false, name);
      assert.equal(tools.find((t) => t.name === 'emet_session_open').inputSchema.properties.subkey, undefined);
      assert.equal(tools.find((t) => t.name === 'write_doc').inputSchema.properties.session_handle, undefined);
      assert.equal(tools.find((t) => t.name === 'emet_initialize').inputSchema.properties.session_handle, undefined);
      assert.deepEqual(Object.keys(tools.find((t) => t.name === 'emet_initialize').inputSchema.properties), ['recent_limit', 'page', 'load_id', 'source']);
      assert.equal(Object.keys(GAP_CLASSES).includes('declared_attribution'), false);
      assert.equal(classifyRow('working', row, { registry: ['cowork-cloud'], nowSec: 1_800_000_000 }).includes('declared_attribution'), false);
      await assert.rejects(() => sk.requestSubkey(memDeps(), actorFor(), { tag: 'intake-bot' }, REG, NOW), /EMET_SUBKEYS is not 1/);
    });
    await withEnv(ON, async () => {
      const tools = hostTools();
      for (const name of names) assert.ok(tools.some((t) => t.name === name), name);
      assert.equal(typeof tools.find((t) => t.name === 'emet_session_open').inputSchema.properties.subkey.type, 'string');
      assert.equal(typeof tools.find((t) => t.name === 'write_doc').inputSchema.properties.session_handle.type, 'string');
      assert.equal(Object.keys(GAP_CLASSES).includes('declared_attribution'), true);
      assert.ok(classifyRow('working', row, { registry: ['cowork-cloud'], nowSec: 1_800_000_000 }).includes('declared_attribution'));
    });
  });
});

testGroup('the reviewer review regressions', () => {
  test('a correct handle is not locked out; only a later failure is throttled, per session and per client', async () => withEnv({ ...ON, EMET_SUBKEY_FAIL_MAX: '2' }, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    const wrong = 'emh_' + 'a'.repeat(43);
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: base, session_handle: wrong }, 'write_doc'), /does not match/);
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: base, session_handle: wrong }, 'write_doc'), /does not match/);
    await att.preflight(c, actorFor(), { session_id: base, session_handle: handle }, 'write_doc');
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: base, session_handle: wrong }, 'write_doc'), /does not match/);
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: base, session_handle: wrong }, 'write_doc'), /does not match/);
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: base, session_handle: wrong }, 'write_doc'), /too many failed/);
    const other = actorFor({ clientId: 'other-client' });
    await att.preflight(c, other, { session_id: base, session_handle: handle }, 'write_doc');
    await assert.rejects(() => att.preflight(c, other, { session_id: base, session_handle: wrong }, 'write_doc'), /does not match/);
    await assert.rejects(() => att.preflight(c, other, { session_id: base, session_handle: wrong }, 'write_doc'), /does not match/);
    await assert.rejects(() => att.preflight(c, actorFor(), { session_id: base, session_handle: wrong }, 'write_doc'), /too many failed/);
    await att.preflight(c, other, { session_id: base, session_handle: handle }, 'write_doc');
  }));
  test('close releases a sub-key session only with its own key and handle, and only for the receipt session', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const intake = await issue(deps, sk, { tag: 'intake-bot' });
    const hub = await issue(deps, sk, { tag: 'hub-bot', bot: actorFor({ clientId: 'hub-client', sourceTag: 'hub-bot' }) });
    const a = await openKey(att, sk, c, deps, intake.claimed, { slug: 'intake' });
    const b = await openKey(att, sk, c, deps, hub.claimed, { slug: 'hub', bot: actorFor({ clientId: 'hub-client', sourceTag: 'hub-bot' }) });
    assert.equal(sk.sessionIdForClose({ session_id: b.base, receipts: { transcript_session_id: a.base } }).mismatch, true);
    assert.equal(sk.sessionIdForClose({ receipts: JSON.stringify({ transcript_session_id: a.base }) }).base, a.base);
    assert.equal(await sk.releaseClosedSession(deps, b.base, NOW, { handle: a.handle, subkey: intake.claimed.subkey }), null);
    assert.equal(await sk.releaseClosedSession(deps, b.base, NOW), null);
    const snap = await records(deps, sk);
    assert.equal(snap.sessions.filter((s) => s.session_id === b.base && s.state === 'live').length, 1);
    const released = await sk.releaseClosedSession(deps, a.base, NOW, { handle: a.handle, subkey: intake.claimed.subkey });
    assert.equal(released.session_id, a.base);
    assert.equal((await records(deps, sk)).sessions.filter((s) => s.session_id === b.base && s.state === 'live').length, 1);
  }));
  test('sub-key records are not in the approvals document; history is owner and COS only; last_used does not rewrite approvals', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    assert.equal(deps.store.content, null);
    const beforeWrites = deps.store.writes;
    const beforeTouches = deps.subkeys.touches();
    await att.preflight(c, actorFor(), { session_id: base, session_handle: handle }, 'write_doc');
    assert.equal(deps.store.writes, beforeWrites);
    assert.ok(deps.subkeys.touches() > beforeTouches);
    const snap = await records(deps, sk);
    assert.equal(JSON.stringify(snap).includes('hmac') , true);
    const ownerHist = await sk.readSubkeyHistory(deps, ownerHost(), 'alex');
    const botHist = await sk.readSubkeyHistory(deps, actorFor(), 'alex');
    const guestHist = await sk.readSubkeyHistory(deps, { personId: 'guest', ownerId: 'alex', clientId: 'g', transport: 'http', authenticated: true, sourceTag: 'cowork-cloud', sourceBasis: 'login' }, 'alex');
    assert.ok(ownerHist.length >= 1);
    assert.equal(JSON.stringify(ownerHist).includes('hmac'), false);
    assert.equal(botHist, null);
    assert.equal(guestHist, null);
  }));
  test('reopening keeps the earlier session record', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const first = await openKey(att, sk, c, deps, claimed, { slug: 'intake' });
    await sk.endSubkeySession(deps, ownerHost(), 'alex', { key_id: claimed.key_id }, NOW);
    const second = await openKey(att, sk, c, deps, claimed, { slug: 'intake' });
    const snap = await records(deps, sk);
    const opens = snap.sessions.filter((s) => s.session_id === first.base);
    assert.equal(opens.length, 2);
    assert.equal(opens.filter((s) => s.state === 'ended').length, 1);
    assert.equal(opens.filter((s) => s.state === 'live').length, 1);
    assert.notEqual(opens[0].open_id, opens[1].open_id);
    assert.notEqual(second.handle, first.handle);
  }));
  test('a pending replacement is obvious in the key list', async () => withEnv(ON, async () => {
    const { sk } = await fresh();
    const { deps } = world();
    const first = await issue(deps, sk);
    const bot = actorFor();
    const req = await sk.requestSubkey(deps, bot, { tag: 'intake-bot' }, REG, NOW);
    const view = sk.subkeysView(await records(deps, sk), ownerHost(), 'alex', NOW);
    const pending = view.keys.find((k) => k.key_id === req.key_id);
    assert.equal(pending.replaces_existing_key, true);
    assert.equal(pending.replaces, first.claimed.key_id);
    assert.match(pending.approval_note, /Replaces the existing key/);
    assert.equal(view.replacements_pending.length, 1);
    const botView = sk.subkeysView(await records(deps, sk), actorFor(), 'alex', NOW);
    assert.equal(botView, null);
  }));
  test('flag off does not open the sub-key store on a write', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base } = await openKey(att, sk, c, deps, claimed);
    let reads = 0;
    const snap = deps.subkeys.snapshot.bind(deps.subkeys);
    const mut = deps.subkeys.mutate.bind(deps.subkeys);
    deps.subkeys.snapshot = async (...a) => { reads++; return snap(...a); };
    deps.subkeys.mutate = async (...a) => { reads++; return mut(...a); };
    await withEnv({ ...ON, EMET_SUBKEYS: undefined }, async () => {
      const writer = actorFor();
      await att.preflight(c, writer, { session_id: base, source: 'intake-bot' }, 'write_doc');
      assert.equal(writer.sourceBasis, 'declared');
      assert.equal(writer.subkeySession, undefined);
      assert.equal(reads, 0);
    });
  }));
  test('a sub-key store failure refuses the write', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    deps.subkeys.mutate = async () => { throw new Error('subkey store down'); };
    deps.subkeys.snapshot = async () => { throw new Error('subkey store down'); };
    const writer = actorFor();
    await assert.rejects(
      () => att.preflight(c, writer, { session_id: base, session_handle: handle }, 'write_doc'),
      /subkey store down/
    );
    assert.equal(writer.subkeySession, undefined);
  }));
  test('close release checks the handle and the key, not only their shape', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    const wrongHandle = `emh_${'a'.repeat(43)}`;
    const wrongKey = `emk_${claimed.key_id}_${'b'.repeat(43)}`;
    assert.equal(await sk.releaseClosedSession(deps, base, NOW, { handle: wrongHandle, subkey: claimed.subkey }), null);
    assert.equal(await sk.releaseClosedSession(deps, base, NOW, { handle, subkey: wrongKey }), null);
    const snap = await records(deps, sk);
    assert.equal(snap.sessions.filter((s) => s.session_id === base && s.state === 'live').length, 1);
    const released = await sk.releaseClosedSession(deps, base, NOW, { handle, subkey: claimed.subkey });
    assert.equal(released.session_id, base);
  }));
  test('a transcript row in a sub-key session carries key_id', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    const writer = actorFor();
    await att.preflight(c, writer, { session_id: base, session_handle: handle }, 'emet_transcript_append');
    const store = makeStore();
    await withStore(store, async () => {
      const { actorStore } = await import('../src/persons.js');
      const { transcriptAppend } = await import('../src/tools.js');
      await actorStore.run(writer, () => transcriptAppend({
        session_id: base, session_start: 1, user_message: 'hi', assistant_message: 'hello', exchange_index: 1, channel: 'intake-bot'
      }, null));
    });
    const row = store.transcripts()[0].exchanges[0];
    assert.equal(row.key_id, claimed.key_id);
    assert.equal(row.source_basis, 'subkey');
    assert.equal(JSON.stringify(row).includes(handle), false);
    assert.equal(JSON.stringify(row).includes(claimed.subkey), false);
  }));
});

function mongoDeps() {
  return {
    readDoc: async () => { throw new Error('Document not found: emet/CLIENT_APPROVALS.md'); },
    writeDoc: async () => { throw new Error('approvals are not the sub-key store'); }
  };
}

testGroup('sub-key store races (in-memory Mongo client)', () => {
  test('two concurrent opens leave one live session', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const openOne = async (slug) => {
        const bot = actorFor();
        const base = att.sessionOpenBase({ slug }, NOW);
        await att.preflight(c, bot, { slug, subkey: claimed.subkey }, 'emet_session_open');
        return sk.commitLiveSession(deps, bot, base, NOW);
      };
      const [a, b] = await Promise.allSettled([openOne('intake-a'), openOne('intake-b')]);
      const ok = [a, b].filter((r) => r.status === 'fulfilled' && r.value);
      const denied = [a, b].filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 1);
      assert.equal(denied.length, 1);
      assert.match(String(denied[0].reason && denied[0].reason.message), /live session/);
      const snap = await sk.loadSubkeyRecords(deps);
      assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 1);
    });
  }));

  test('a revoke that races an open is not overwritten', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const bot = actorFor();
      const base = att.sessionOpenBase({ slug: 'intake-race' }, NOW);
      await att.preflight(c, bot, { slug: 'intake-race', subkey: claimed.subkey }, 'emet_session_open');
      await Promise.allSettled([
        sk.revokeSubkey(deps, ownerHost(), 'alex', { key_id: claimed.key_id, reason: 'race' }, NOW),
        sk.commitLiveSession(deps, bot, base, NOW)
      ]);
      const snap = await sk.loadSubkeyRecords(deps);
      assert.equal(snap.keys[claimed.key_id].status, 'revoked');
      assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 0);
      assert.equal(snap.keys[claimed.key_id].live_session_id || null, null);
    });
  }));

  test('two claims of one nonce leave one active key', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { sk } = await fresh();
      const deps = mongoDeps();
      const req = await sk.requestSubkey(deps, actorFor(), { tag: 'intake-bot' }, REG, NOW);
      await sk.decideSubkeyIfPending(deps, ownerHost(), 'alex', { tag: 'intake-bot', decision: 'approve' }, NOW);
      const [a, b] = await Promise.allSettled([
        sk.claimSubkey(deps, actorFor(), { key_id: req.key_id, nonce: req.nonce }, NOW),
        sk.claimSubkey(deps, actorFor(), { key_id: req.key_id, nonce: req.nonce }, NOW)
      ]);
      const ok = [a, b].filter((r) => r.status === 'fulfilled');
      assert.equal(ok.length, 1);
      assert.equal([a, b].filter((r) => r.status === 'rejected').length, 1);
      const snap = await sk.loadSubkeyRecords(deps);
      const row = snap.keys[req.key_id];
      assert.equal(row.status, 'active');
      assert.equal(row.nonce_spent, true);
      const secret = sk.splitKeyToken(ok[0].value.subkey).secret;
      assert.equal(sk.verifyMac(row.secret_hmac, secret, sk.pepperState()), true);
    });
  }));

  test('a new open does not write the earlier session record', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const first = await openKey(att, sk, c, deps, claimed, { slug: 'intake' });
      await sk.endSubkeySession(deps, ownerHost(), 'alex', { key_id: claimed.key_id }, NOW);
      const ended = (await sk.loadSubkeyRecords(deps)).sessions.find((s) => s.session_id === first.base && s.state === 'ended');
      const endedId = `open:${ended.open_id}`;
      const hmac = ended.handle_hmac;
      const col = store.collection('emet_subkeys');
      const written = [];
      const upd = col.updateOne.bind(col);
      const rep = col.replaceOne.bind(col);
      const ins = col.insertOne.bind(col);
      col.updateOne = async (q, u, o) => { written.push(q && q._id); return upd(q, u, o); };
      col.replaceOne = async (q, d, o) => { written.push(q && q._id); return rep(q, d, o); };
      col.insertOne = async (doc) => { written.push(doc && doc._id); return ins(doc); };
      const second = await openKey(att, sk, c, deps, claimed, { slug: 'intake' });
      assert.equal(written.includes(endedId), false);
      const still = col.docs.find((d) => d._id === endedId);
      assert.equal(still.state, 'ended');
      assert.equal(JSON.stringify(still.handle_hmac), JSON.stringify(hmac));
      const snap = await sk.loadSubkeyRecords(deps);
      const opens = snap.sessions.filter((s) => s.session_id === first.base);
      assert.equal(opens.length, 2);
      assert.notEqual(second.handle, first.handle);
    });
  }));

  test('history ids are unique and a duplicate-key error is not dropped', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { sk } = await fresh();
      const deps = mongoDeps();
      await issue(deps, sk);
      const hist = store.collection('emet_subkeys_history');
      const ids = hist.docs.map((d) => d._id);
      assert.ok(ids.length >= 3);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids.some((id) => /^h:[0-9a-f]{32}:\d+:/.test(id)), false);
      const real = hist.insertOne.bind(hist);
      hist.insertOne = async () => {
        const e = new Error('E11000 duplicate key');
        e.code = 11000;
        throw e;
      };
      await assert.rejects(
        () => sk.requestSubkey(deps, actorFor(), { tag: 'grok-project' }, REG, NOW),
        /E11000|sub-key store failed/
      );
      hist.insertOne = real;
    });
  }));

  test('an empty source registry refuses every sub-key tag', async () => withEnv({ ...ON, EMET_SOURCE_TAGS: '' }, async () => {
    const { sk } = await fresh();
    await assert.rejects(
      () => sk.requestSubkey(memDeps(), actorFor(), { tag: 'intake-bot' }, [], NOW),
      /exact member of EMET_SOURCE_TAGS/
    );
    await assert.rejects(
      () => sk.requestSubkey(memDeps(), actorFor(), { tag: 'intake-bot' }, undefined, NOW),
      /exact member of EMET_SOURCE_TAGS/
    );
  }));

  test('sub-keys fail closed when there is no store', async () => withEnv(ON, async () => {
    const { sk } = await fresh();
    await assert.rejects(
      () => sk.requestSubkey({}, actorFor(), { tag: 'intake-bot' }, REG, NOW),
      /sub-key store is unavailable/
    );
  }));

  test('the fail window is a documented setting', () => {
    const text = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    assert.match(text, /EMET_SUBKEY_FAIL_WINDOW_MS/);
  });

  test('sub-key operations share one Mongo client', async () => withEnv(ON, async () => {
    const store = makeStore();
    let opened = 0;
    const Orig = store.Client;
    store.Client = class extends Orig { constructor() { opened++; super(); } };
    await withStore(store, async () => {
      const { sk } = await fresh();
      await issue(mongoDeps(), sk);
      assert.equal(opened, 1);
    });
  }));

  test('a pending replacement can sit beside the active key', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { sk } = await fresh();
      const deps = mongoDeps();
      await issue(deps, sk);
      const req = await sk.requestSubkey(deps, actorFor(), { tag: 'intake-bot' }, REG, NOW);
      const rows = Object.values((await sk.loadSubkeyRecords(deps)).keys).filter((k) => k.tag === 'intake-bot');
      assert.equal(rows.filter((k) => k.status === 'active').length, 1);
      assert.equal(rows.filter((k) => k.status === 'pending' && k.key_id === req.key_id).length, 1);
    });
  }));

  test('two concurrent requests for one tag leave one pending row', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { sk } = await fresh();
      const deps = mongoDeps();
      const col = store.collection('emet_subkeys');
      holdFirstWrites(col, 2);
      const [a, b] = await Promise.allSettled([
        sk.requestSubkey(deps, actorFor(), { tag: 'intake-bot' }, REG, NOW),
        sk.requestSubkey(deps, actorFor(), { tag: 'intake-bot' }, REG, NOW)
      ]);
      const ok = [a, b].filter((r) => r.status === 'fulfilled');
      const denied = [a, b].filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 1);
      assert.equal(denied.length, 1);
      assert.match(String(denied[0].reason && denied[0].reason.message), /already awaiting approval/);
      const snap = await sk.loadSubkeyRecords(deps);
      assert.equal(Object.values(snap.keys).filter((k) => k.tag === 'intake-bot' && k.status === 'pending').length, 1);
    });
  }));

  test('without the revision compare-and-set, a taken pointer does not flip live', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const col = store.collection('emet_subkeys');
      const upd = col.updateOne.bind(col);
      let armed = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      col.updateOne = async (q, u, o) => {
        const filter = q && typeof q === 'object' ? { ...q } : q;
        if (filter && Object.prototype.hasOwnProperty.call(filter, 'rev')) delete filter.rev;
        return upd(filter, u, o);
      };
      const ins = col.insertOne.bind(col);
      col.insertOne = async (doc) => {
        armed += 1;
        if (armed >= 2) release();
        await gate;
        return ins(doc);
      };
      const openOne = async (slug) => {
        const bot = actorFor();
        const base = att.sessionOpenBase({ slug }, NOW);
        await att.preflight(c, bot, { slug, subkey: claimed.subkey }, 'emet_session_open');
        return sk.commitLiveSession(deps, bot, base, NOW);
      };
      const [a, b] = await Promise.allSettled([openOne('intake-a'), openOne('intake-b')]);
      assert.equal([a, b].filter((r) => r.status === 'fulfilled' && r.value).length, 1);
      assert.equal([a, b].filter((r) => r.status === 'rejected').length, 1);
      const snap = await sk.loadSubkeyRecords(deps);
      assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 1);
      assert.equal(snap.history.filter((ev) => ev.event === 'session_open').length, 1);
    });
  }));

  test('flag off makes no emet_subkeys call on write_doc', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const { base } = await openKey(att, sk, c, deps, claimed);
      const db = new store.Client().db();
      const orig = db.collection.bind(db);
      const seen = [];
      db.collection = (name) => { seen.push(name); return orig(name); };
      await withEnv({ ...ON, EMET_SUBKEYS: undefined }, async () => {
        const writer = actorFor();
        await att.preflight(c, writer, { session_id: base, source: 'intake-bot' }, 'write_doc');
        assert.equal(writer.sourceBasis, 'declared');
        assert.equal(writer.subkeySession, undefined);
      });
      assert.deepEqual(seen.filter((name) => name === 'emet_subkeys' || name === 'emet_subkeys_history'), []);
    });
  }));

  test('startup ends live sub-key sessions once and does not create a missing collection', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const { base } = await openKey(att, sk, c, deps, claimed);
      const openId = (await sk.loadSubkeyRecords(deps)).sessions.find((s) => s.session_id === base).open_id;
      const db = new store.Client().db();
      const col = db.collection('emet_subkeys');
      let built = 0;
      const ci = col.createIndex.bind(col);
      col.createIndex = async (...args) => { built++; return ci(...args); };
      assert.equal(await sk.sweepFlagOffSessions(), 0);
      assert.equal((await sk.loadSubkeyRecords(deps)).sessions.find((s) => s.open_id === openId).state, 'live');
      const mongoConnect = await import('../src/mongo-connect.js');
      mongoConnect.useTestClient(store.Client);
      await withEnv({ ...ON, EMET_SUBKEYS: undefined }, async () => {
        const logs = [];
        const ended = await sk.sweepFlagOffSessions((msg) => logs.push(msg));
        assert.equal(ended, 1);
        assert.match(logs.join('\n'), /ended 1 live session/);
        const snap = await sk.loadSubkeyRecords(deps);
        const row = snap.sessions.find((s) => s.open_id === openId);
        assert.equal(row.state, 'ended');
        assert.equal(row.end_reason, 'flag_off');
        assert.equal(snap.keys[claimed.key_id].live_session_id || null, null);
        assert.equal(snap.history.filter((ev) => ev.reason === 'flag_off' && ev.open_id === openId).length, 1);
        assert.equal(await sk.sweepFlagOffSessions((msg) => logs.push(msg)), 0);
        assert.equal((await sk.loadSubkeyRecords(deps)).history.filter((ev) => ev.reason === 'flag_off').length, 1);
        assert.equal(built, 0);
        const orig = db.collection.bind(db);
        const seen = [];
        db.collection = (name) => { seen.push(name); return orig(name); };
        await assert.rejects(
          () => att.preflight(c, actorFor(), { session_id: base, source: 'intake-bot' }, 'write_doc'),
          /EMET_SUBKEYS is off/
        );
        const other = actorFor();
        await att.preflight(c, other, { session_id: 'not-the-live-one', source: 'intake-bot' }, 'write_doc');
        assert.equal(other.sourceBasis, 'declared');
        assert.deepEqual(seen.filter((name) => name === 'emet_subkeys' || name === 'emet_subkeys_history'), []);
      });
    });
    const empty = makeStore();
    await withStore(empty, async () => {
      const { sk } = await fresh();
      const db = new empty.Client().db();
      const orig = db.collection.bind(db);
      const seen = [];
      db.collection = (name) => { seen.push(name); return orig(name); };
      await withEnv({ ...ON, EMET_SUBKEYS: undefined }, async () => {
        const logs = [];
        assert.equal(await sk.sweepFlagOffSessions((msg) => logs.push(msg)), 0);
        assert.deepEqual(logs, []);
        assert.deepEqual(seen, []);
        assert.equal(empty.cols.has('emet_subkeys'), false);
        db.listCollections = () => ({ toArray: async () => { throw new Error('list down'); } });
        assert.equal(await sk.sweepFlagOffSessions((msg) => logs.push(msg)), null);
        assert.match(logs.join('\n'), /list down/);
      });
    });
  }));

  test('the pending index is built once, and only while the flag is on', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { sk } = await fresh();
      const deps = mongoDeps();
      const db = new store.Client().db();
      const orig = db.collection.bind(db);
      let built = 0;
      db.collection = (name) => {
        const col = orig(name);
        if (name === 'emet_subkeys' && !col._counted) {
          col._counted = true;
          const ci = col.createIndex.bind(col);
          col.createIndex = async (...args) => { built++; return ci(...args); };
        }
        return col;
      };
      await issue(deps, sk);
      assert.equal(built, 1);
      await sk.requestSubkey(deps, actorFor(), { tag: 'grok-project' }, REG, NOW);
      assert.equal(built, 1);
    });
  }));

  test('revoke clears a dangling pointer', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { sk } = await fresh();
      const deps = mongoDeps();
      const { claimed } = await issue(deps, sk);
      const key = store.collection('emet_subkeys').docs.find((d) => d.key_id === claimed.key_id);
      key.live_session_id = 'gone';
      delete key.live_set_at;
      const result = await sk.revokeSubkey(deps, ownerHost(), 'alex', { key_id: claimed.key_id, reason: 'dangling' }, NOW);
      assert.equal(result.status, 'revoked');
      const snap = await sk.loadSubkeyRecords(deps);
      assert.equal(snap.keys[claimed.key_id].live_session_id || null, null);
      assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 0);
      assert.ok(snap.history.some((ev) => ev.event === 'session_lost' && ev.open_id === 'gone'));
    });
  }));

  test('a stale opening row can be reopened after a crash', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const col = store.collection('emet_subkeys');
      const key = col.docs.find((d) => d.key_id === claimed.key_id);
      const at = new Date(NOW.getTime() - 10000).toISOString();
      key.live_session_id = 'crashopen';
      key.live_set_at = at;
      col.docs.push({
        _id: 'open:crashopen', kind: 'session', open_id: 'crashopen', session_id: 'old-base',
        key_id: claimed.key_id, state: 'opening', opened_at: at, rev: 1
      });
      const bot = actorFor();
      const base = att.sessionOpenBase({ slug: 'intake-again' }, NOW);
      await att.preflight(c, bot, { slug: 'intake-again', subkey: claimed.subkey }, 'emet_session_open');
      const handle = await sk.commitLiveSession(deps, bot, base, NOW);
      assert.ok(handle);
      const snap = await sk.loadSubkeyRecords(deps);
      assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 1);
      assert.equal(snap.sessions.find((s) => s.open_id === 'crashopen').state, 'ended');
      assert.ok(snap.history.some((ev) => ev.event === 'session_lost' && ev.open_id === 'crashopen'));
      assert.notEqual(snap.keys[claimed.key_id].live_session_id, 'crashopen');
    });
  }));

  test('a fresh opening pointer blocks another open', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const col = store.collection('emet_subkeys');
      const key = col.docs.find((d) => d.key_id === claimed.key_id);
      const at = NOW.toISOString();
      key.live_session_id = 'inflight';
      key.live_set_at = at;
      col.docs.push({
        _id: 'open:inflight', kind: 'session', open_id: 'inflight', session_id: 'old-base',
        key_id: claimed.key_id, state: 'opening', opened_at: at, rev: 1
      });
      const bot = actorFor();
      await assert.rejects(
        () => att.preflight(c, bot, { slug: 'intake-inflight', subkey: claimed.subkey }, 'emet_session_open'),
        /live session/
      );
    });
  }));

  test('an expired live session does not hide a later ended open', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const base = 'sess-expired-order';
    await deps.subkeys.mutate((data) => {
      data.sessions.push({ open_id: 'e1', session_id: base, key_id: claimed.key_id, state: 'live', expires_at: '2020-01-01T00:00:00.000Z', opened_at: '2020-01-01T00:00:00.000Z' });
      data.sessions.push({ open_id: 'e2', session_id: base, key_id: claimed.key_id, state: 'ended', expires_at: '2026-10-16T00:00:00.000Z', opened_at: NOW.toISOString() });
      return true;
    });
    await assert.rejects(
      () => att.preflight(c, actorFor(), { session_id: base, session_handle: `emh_${'a'.repeat(43)}` }, 'write_doc'),
      /was ended/
    );
  }));

  test('close does not release an expired handle', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    await deps.subkeys.mutate((data) => {
      const s = data.sessions.find((row) => row.session_id === base && row.state === 'live');
      s.expires_at = '2020-01-01T00:00:00.000Z';
      return true;
    });
    assert.equal(await sk.releaseClosedSession(deps, base, NOW, { handle, subkey: claimed.subkey }), null);
    assert.equal((await records(deps, sk)).sessions.find((s) => s.session_id === base).state, 'live');
  }));

  test('the flag-off sweep writes the history event before the status change', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const { base } = await openKey(att, sk, c, deps, claimed);
      const col = store.collection('emet_subkeys');
      const hist = store.collection('emet_subkeys_history');
      const order = [];
      const upd = col.updateOne.bind(col);
      const hins = hist.insertOne.bind(hist);
      hist.insertOne = async (doc) => { order.push('event'); return hins(doc); };
      col.updateOne = async (q, u, o) => {
        if (u && u.$set && u.$set.state === 'ended') {
          order.push('status');
          throw new Error('status down');
        }
        return upd(q, u, o);
      };
      await withEnv({ ...ON, EMET_SUBKEYS: undefined }, async () => {
        const logs = [];
        assert.equal(await sk.sweepFlagOffSessions((msg) => logs.push(msg)), null);
        assert.match(logs.join('\n'), /status down/);
      });
      assert.deepEqual(order.slice(0, 2), ['event', 'status']);
      assert.equal(hist.docs.filter((d) => d.reason === 'flag_off').length, 1);
      assert.equal(col.docs.find((d) => d.kind === 'session' && d.session_id === base).state, 'live');
      col.updateOne = upd;
      await withEnv({ ...ON, EMET_SUBKEYS: undefined }, async () => {
        assert.equal(await sk.sweepFlagOffSessions(() => {}), 1);
      });
      assert.equal(hist.docs.filter((d) => d.reason === 'flag_off').length, 1);
      assert.equal(col.docs.find((d) => d.kind === 'session' && d.session_id === base).state, 'ended');
    });
  }));

  test('flag off refuses an emh_ handle and a seen sub-key session with no store call', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const { base } = await openKey(att, sk, c, deps, claimed);
      att.rememberSubkeySession(base);
      const db = new store.Client().db();
      const orig = db.collection.bind(db);
      const seen = [];
      db.collection = (name) => { seen.push(name); return orig(name); };
      await withEnv({ ...ON, EMET_SUBKEYS: undefined }, async () => {
        await assert.rejects(
          () => att.preflight(c, actorFor(), { session_id: 'x', session_handle: `emh_${'a'.repeat(43)}`, source: 'intake-bot' }, 'write_doc'),
          /session handle was presented/
        );
        await assert.rejects(
          () => att.preflight(c, actorFor(), { session_id: base, source: 'intake-bot' }, 'write_doc'),
          /is a sub-key session/
        );
        const other = actorFor();
        await att.preflight(c, other, { session_id: 'ordinary-session', source: 'intake-bot' }, 'write_doc');
        assert.equal(other.sourceBasis, 'declared');
      });
      assert.deepEqual(seen.filter((name) => name === 'emet_subkeys' || name === 'emet_subkeys_history'), []);
    });
  }));

  test('a missing pointer is in flight inside 5s and stale at 5s', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const key = store.collection('emet_subkeys').docs.find((d) => d.key_id === claimed.key_id);
      key.live_session_id = 'gone';
      key.live_set_at = NOW.toISOString();
      const present = (now) => att.preflight(
        { ...c, now }, actorFor(), { slug: 'intake-window', subkey: claimed.subkey }, 'emet_session_open'
      );
      await assert.rejects(() => present(NOW), /live session/);
      await assert.rejects(() => present(new Date(NOW.getTime() + 4999)), /live session/);
      const bot = actorFor();
      const at = new Date(NOW.getTime() + 5000);
      await att.preflight({ ...c, now: at }, bot, { slug: 'intake-window', subkey: claimed.subkey }, 'emet_session_open');
      const handle = await sk.commitLiveSession(deps, bot, att.sessionOpenBase({ slug: 'intake-window' }, at), at);
      assert.ok(handle);
      const snap = await sk.loadSubkeyRecords(deps);
      assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 1);
      assert.ok(snap.history.some((ev) => ev.event === 'session_lost' && ev.open_id === 'gone'));
    });
  }));

  test('a stalled open cannot write after the pointer moves', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const { base, handle } = await openKey(att, sk, c, deps, claimed);
      const openA = (await sk.loadSubkeyRecords(deps)).sessions.find((s) => s.session_id === base);
      const col = store.collection('emet_subkeys');
      const key = col.docs.find((d) => d.key_id === claimed.key_id);
      col.docs.push({
        _id: 'open:bee', kind: 'session', open_id: 'bee', session_id: 'bee-base',
        key_id: claimed.key_id, state: 'live', tag: 'intake-bot',
        expires_at: '2026-10-16T00:00:00.000Z', opened_at: NOW.toISOString(), rev: 1
      });
      key.live_session_id = 'bee';
      await sk.endSubkeySession(deps, ownerHost(), 'alex', { key_id: claimed.key_id, reason: 'stall' }, NOW);
      const after = await sk.loadSubkeyRecords(deps);
      assert.equal(after.sessions.find((s) => s.open_id === openA.open_id).state, 'live');
      await assert.rejects(
        () => att.preflight(c, actorFor(), { session_id: base, session_handle: handle }, 'write_doc'),
        /no longer the live session/
      );
    });
  }));

  test('a flip does not go live after the pointer moves', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const col = store.collection('emet_subkeys');
      const upd = col.updateOne.bind(col);
      col.updateOne = async (q, u, o) => {
        const res = await upd(q, u, o);
        if (q && q._id === `key:${claimed.key_id}` && u && u.$set && u.$set.live_session_id) {
          const key = col.docs.find((d) => d._id === q._id);
          key.live_session_id = 'taken';
        }
        return res;
      };
      const bot = actorFor();
      await att.preflight(c, bot, { slug: 'intake-stall', subkey: claimed.subkey }, 'emet_session_open');
      await assert.rejects(
        () => sk.commitLiveSession(deps, bot, att.sessionOpenBase({ slug: 'intake-stall' }, NOW), NOW),
        /Nothing was written/
      );
      const snap = await sk.loadSubkeyRecords(deps);
      assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 0);
      assert.equal(snap.history.filter((ev) => ev.event === 'session_open').length, 0);
    });
  }));

  test('a failed flip does not record the open twice', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { att, sk } = await fresh();
      const deps = mongoDeps();
      const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'alex', deps, registry: REG, now: NOW };
      const { claimed } = await issue(deps, sk);
      const col = store.collection('emet_subkeys');
      const upd = col.updateOne.bind(col);
      let flips = 0;
      col.updateOne = async (q, u, o) => {
        if (u && u.$set && u.$set.state === 'live') {
          flips += 1;
          if (flips === 1) return { matchedCount: 0, modifiedCount: 0 };
        }
        return upd(q, u, o);
      };
      const bot = actorFor();
      await att.preflight(c, bot, { slug: 'intake-retry', subkey: claimed.subkey }, 'emet_session_open');
      const handle = await sk.commitLiveSession(deps, bot, att.sessionOpenBase({ slug: 'intake-retry' }, NOW), NOW);
      assert.ok(handle);
      const snap = await sk.loadSubkeyRecords(deps);
      assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 1);
      assert.equal(snap.history.filter((ev) => ev.event === 'session_open').length, 1);
    });
  }));

  test('sub-key imports in tools and setup stay behind the flag, and listen is not behind the sweep', () => {
    const tools = fs.readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
    const openFn = tools.slice(tools.indexOf('async function subkeyHandleForOpen'));
    assert.match(openFn.slice(0, 240), /SUBKEYS'\) !== '1'/);
    const setup = fs.readFileSync(new URL('../src/setup.js', import.meta.url), 'utf8');
    const at = setup.indexOf("import('./subkeys.js')");
    assert.match(setup.slice(at - 180, at), /setting\('SUBKEYS'\) === '1'/);
    const http = fs.readFileSync(new URL('../src/http-remote.js', import.meta.url), 'utf8');
    assert.ok(http.indexOf('app.listen') < http.indexOf('startFlagOffSweep'));
  });

  test('a failed revert does not say nothing was written', async () => withEnv(ON, async () => {
    const store = makeStore();
    await withStore(store, async () => {
      const { sk } = await fresh();
      const deps = mongoDeps();
      await issue(deps, sk);
      const req = await sk.requestSubkey(deps, actorFor(), { tag: 'intake-bot' }, REG, NOW);
      await sk.decideSubkeyIfPending(deps, ownerHost(), 'alex', { tag: 'intake-bot', decision: 'approve' }, NOW);
      const col = store.collection('emet_subkeys');
      let updates = 0;
      const upd = col.updateOne.bind(col);
      col.updateOne = async (...args) => {
        updates += 1;
        if (updates === 2) return { matchedCount: 0, modifiedCount: 0 };
        return upd(...args);
      };
      col.replaceOne = async () => ({ matchedCount: 0, modifiedCount: 0 });
      await assert.rejects(
        () => sk.claimSubkey(deps, actorFor(), { key_id: req.key_id, nonce: req.nonce }, NOW),
        (err) => {
          assert.match(err.message, /partial update persisted/);
          assert.equal(/Nothing was written/.test(err.message), false);
          return true;
        }
      );
    });
  }));
});

/** Hold the first n key-collection writes so both callers snapshot before either writes. */
function holdFirstWrites(col, n) {
  let armed = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const wait = async () => {
    armed += 1;
    if (armed >= n) release();
    await gate;
  };
  const upd = col.updateOne.bind(col);
  const ins = col.insertOne.bind(col);
  col.updateOne = async (...args) => { await wait(); return upd(...args); };
  col.insertOne = async (...args) => { await wait(); return ins(...args); };
}

summary('delegated client sub-keys');
