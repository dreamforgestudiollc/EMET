/**
 * Sub-key session renewal, grace, the sweep, and reclaim.
 * A stranded session is not EMET-AUTH-039.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, testGroup, summary } from './harness.js';
import { withEnv, makeStore } from './memstore.js';
import { createMemoryStore } from '../src/subkey-store.js';
import { UNWRAPPED_NOTICE, RENEW_MESSAGE, preflightHttpCode } from '../src/subkey-lifecycle.js';
import { auditSubkeySessions, SUBKEY_SESSION_MERMAID } from '../src/subkey-session-statechart.js';

console.log('\n=== sub-key session renewal ===');

const CLIENT = 'client-fixture-one';
const PEPPER = 'pepper-pepper-pepper-pepper-pepper-32b';
const REG = ['hub-bot', 'reviewer-bot', 'field-bot', 'notebook'];
const ON = {
  EMET_SUBKEYS: '1',
  EMET_SUBKEY_PEPPER: PEPPER,
  EMET_SOURCE_TAGS: REG.join(','),
  EMET_SUBKEY_FAIL_MAX: '5',
  EMET_SUBKEY_GRACE_MINUTES: '10',
  EMET_SUBKEY_TTL_DAYS: '30',
  EMET_SUBKEY_RENEWAL_MINUTES: '60',
  EMET_SUBKEY_HANDLE_GRACE_MINUTES: '60'
};
const NOW = new Date('2026-10-15T16:00:00Z');
const STRANDED_IDS = [
  '2026-01-02_sample-a',
  '2026-01-03_sample-b',
  '2026-01-04_sample-c',
  '2026-01-05_sample-d',
  '2026-01-06_sample-e',
  '2026-01-07_sample-f'
];

function fakeDb() {
  return { collection() { return { find() { return { limit() { return { toArray: async () => [] }; }, toArray: async () => [] }; } }; } };
}
function memDeps() {
  return {
    store: { content: null, version: null, writes: 0 },
    readDoc: async () => { throw new Error('Document not found: emet/CLIENT_APPROVALS.md'); },
    writeDoc: async () => ({ version: 1 }),
    subkeys: createMemoryStore(),
    wrapUps: []
  };
}
const ownerHost = () => ({ personId: 'owner', ownerId: 'owner', clientId: 'owner-host', transport: 'http', authenticated: true, sourceTag: 'notebook', sourceBasis: 'login', scopes: [] });
const actorFor = (extra = {}) => ({ personId: 'owner', ownerId: 'owner', clientId: CLIENT, transport: 'http', authenticated: true, sourceTag: 'hub-bot', sourceBasis: 'login', scopes: [], ...extra });

async function fresh() {
  const att = await import('../src/attribution.js');
  const sk = await import('../src/subkeys.js');
  att._resetForTests();
  sk._resetForTests();
  return { att, sk };
}
function world(over = {}) {
  const deps = over.deps || memDeps();
  const c = { db: fakeDb(), prefix: 'emet_', ownerId: 'owner', deps, registry: REG, now: NOW, layerCollections: [], ...over, deps };
  return { deps, c };
}
async function issue(deps, sk, { tag = 'reviewer-bot', client_kind, bot = actorFor(), now = NOW } = {}) {
  const req = await sk.requestSubkey(deps, bot, { tag, client_kind }, REG, now);
  const decided = await sk.decideSubkeyIfPending(deps, ownerHost(), 'owner', { tag, decision: 'approve', ...(client_kind ? { client_kind } : {}) }, now);
  const claimed = await sk.claimSubkey(deps, bot, { key_id: req.key_id, nonce: req.nonce }, now);
  return { req, decided, claimed, tag };
}
async function openKey(att, sk, c, deps, claimed, { slug = 'reviewer', bot = actorFor(), now = NOW, handle } = {}) {
  const base = att.sessionOpenBase({ slug }, now);
  await att.preflight({ ...c, now }, bot, { slug, subkey: claimed.subkey, ...(handle ? { session_handle: handle } : {}) }, 'emet_session_open');
  const next = await sk.commitLiveSession(deps, bot, base, now);
  return { base, handle: next, opener: bot };
}
async function load(deps, sk) { return sk.loadSubkeyRecords(deps); }

testGroup('renewal', () => {
  test('a call inside the last hour asks for a new open and does not mint a handle', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    const opened = (await load(deps, sk)).sessions.find((s) => s.session_id === base);
    const later = new Date(new Date(opened.expires_at).getTime() - 30 * 60 * 1000);
    const bot = actorFor();
    await att.preflight({ ...c, now: later }, bot, { session_id: base, session_handle: handle }, 'write_doc');
    assert.equal(bot.subkeySession, true);
    assert.match(bot.subkeyRenewal.message, new RegExp(RENEW_MESSAGE.replace(/[.]/g, '\\.')));
    const snap = await load(deps, sk);
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].state, 'renewal_offered');
    assert.equal(snap.keys[claimed.key_id].live_session_id, opened.open_id);
  }));

  test('renewal inside the window closes the old session into the new one', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const first = await openKey(att, sk, c, deps, claimed);
    const opened = (await load(deps, sk)).sessions.find((s) => s.session_id === first.base);
    const later = new Date(new Date(opened.expires_at).getTime() - 30 * 60 * 1000);
    const bot = actorFor();
    const slug = 'reviewer-renewed';
    await att.preflight({ ...c, now: later }, bot, { slug, subkey: claimed.subkey, session_handle: first.handle }, 'emet_session_open');
    const handle = await sk.commitLiveSession(deps, bot, att.sessionOpenBase({ slug }, later), later);
    assert.match(handle, /^emh_/);
    assert.notEqual(handle, first.handle);
    const notice = sk.takeOpenNotice(bot);
    assert.equal(notice.action, 'continued');
    assert.equal(notice.previous_session_id, first.base);
    const snap = await load(deps, sk);
    const live = snap.sessions.filter((s) => s.state === 'live');
    assert.equal(live.length, 1);
    const old = snap.sessions.find((s) => s.open_id === opened.open_id);
    assert.equal(old.state, 'closed');
    assert.equal(old.end_reason, 'renewed');
    assert.equal(old.retained, true);
    assert.equal(old.deleted, false);
    assert.equal(old.next_open_id, live[0].open_id);
    assert.equal(live[0].prev_open_id, old.open_id);
    assert.equal(snap.keys[claimed.key_id].live_session_id, live[0].open_id);
    assert.ok(snap.history.some((ev) => ev.event === 'session_renewed'));
  }));

  test('a renewal inside the grace window needs the key and the handle', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const first = await openKey(att, sk, c, deps, claimed);
    await deps.subkeys.mutate((data) => {
      const s = data.sessions.find((row) => row.session_id === first.base);
      s.expires_at = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
      return true;
    });
    const before = (await load(deps, sk)).sessions.length;
    await assert.rejects(
      () => att.preflight(c, actorFor(), { session_id: first.base, session_handle: first.handle }, 'write_doc'),
      (err) => {
        assert.equal(err.attributionRefusal, undefined);
        assert.equal(preflightHttpCode(err), 'EMET-SESS-014');
        assert.notEqual(preflightHttpCode(err), 'EMET-AUTH-039');
        return true;
      }
    );
    assert.equal((await load(deps, sk)).sessions.length, before);
    assert.equal((await load(deps, sk)).sessions.filter((s) => s.state === 'live').length, 1);
    const bot = actorFor();
    await att.preflight(c, bot, { slug: 'reviewer-grace', subkey: claimed.subkey, session_handle: first.handle }, 'emet_session_open');
    const handle = await sk.commitLiveSession(deps, bot, att.sessionOpenBase({ slug: 'reviewer-grace' }, NOW), NOW);
    assert.match(handle, /^emh_/);
    const snap = await load(deps, sk);
    assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 1);
    const old = snap.sessions.find((s) => s.session_id === first.base);
    assert.equal(old.state, 'closed');
    assert.equal(old.next_session_id, att.sessionOpenBase({ slug: 'reviewer-grace' }, NOW));
    assert.equal(snap.history.some((ev) => ev.event === 'handle_expired'), false);
  }));
});

testGroup('backstop and reclaim', () => {
  test('past the grace window the sweep records auto_closed and keeps the rows', async () => withEnv(ON, async () => {
    const { sk } = await fresh();
    const { deps } = world();
    const { claimed } = await issue(deps, sk);
    await deps.subkeys.mutate((data) => {
      data.keys[claimed.key_id].live_session_id = 'stranded-0';
      STRANDED_IDS.forEach((session_id, i) => {
        data.sessions.push({
          open_id: `stranded-${i}`, session_id, key_id: claimed.key_id, tag: 'reviewer-bot',
          state: i < 3 ? 'ended' : 'expired',
          expires_at: '2026-11-01T00:00:00.000Z', opened_at: '2026-11-01T00:00:00.000Z',
          retained: true
        });
      });
      return true;
    });
    const n = await sk.sweepStrandedSessions(deps, new Date('2026-11-21T16:00:00Z'));
    assert.equal(n, STRANDED_IDS.length);
    const snap = await load(deps, sk);
    for (const id of STRANDED_IDS) {
      const row = snap.sessions.find((s) => s.session_id === id);
      assert.equal(row.state, 'auto_closed', id);
      assert.equal(row.deleted, false, id);
      assert.equal(row.retained, true, id);
    }
    assert.equal(snap.keys[claimed.key_id].live_session_id, null);
    assert.equal(snap.history.filter((ev) => ev.event === 'session_auto_closed').length, STRANDED_IDS.length);
  }));

  test('the same key reclaims a stranded session and does not close another key', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const reviewer = await issue(deps, sk, { tag: 'reviewer-bot' });
    const other = await issue(deps, sk, { tag: 'field-bot', bot: actorFor({ clientId: 'other', sourceTag: 'field-bot' }) });
    const first = await openKey(att, sk, c, deps, reviewer.claimed);
    const kept = await openKey(att, sk, c, deps, other.claimed, { slug: 'field', bot: actorFor({ clientId: 'other', sourceTag: 'field-bot' }) });
    await deps.subkeys.mutate((data) => {
      const s = data.sessions.find((row) => row.session_id === first.base);
      s.expires_at = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
      s.state = 'expired';
      data.keys[reviewer.claimed.key_id].live_session_id = null;
      return true;
    });
    const again = await openKey(att, sk, c, deps, reviewer.claimed, { slug: 'reviewer-again' });
    assert.match(again.handle, /^emh_/);
    const snap = await load(deps, sk);
    assert.equal(snap.sessions.find((s) => s.session_id === first.base).state, 'closed');
    assert.equal(snap.sessions.find((s) => s.session_id === kept.base).state, 'live');
    assert.equal(snap.sessions.filter((s) => s.key_id === reviewer.claimed.key_id && s.state === 'live').length, 1);
  }));

  test('the owner carry-forward closes a stranded session and the key stays active', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base } = await openKey(att, sk, c, deps, claimed);
    await deps.subkeys.mutate((data) => {
      const s = data.sessions.find((row) => row.session_id === base);
      s.state = 'ended';
      data.keys[claimed.key_id].live_session_id = null;
      return true;
    });
    const ended = await sk.endSubkeySession(deps, ownerHost(), 'owner', { key_id: claimed.key_id, reason: 'stranded' }, NOW);
    assert.equal(ended.carried_forward, true);
    assert.equal(ended.state, 'closed');
    const row = (await load(deps, sk)).sessions.find((s) => s.session_id === base);
    assert.equal(row.state, 'closed');
    assert.equal(row.retained, true);
    assert.equal((await load(deps, sk)).keys[claimed.key_id].status, 'active');
    const again = await openKey(att, sk, c, deps, claimed, { slug: 'after-owner' });
    assert.match(again.handle, /^emh_/);
  }));

  test('a second open on a live bot key is still a collision', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    await openKey(att, sk, c, deps, claimed);
    await assert.rejects(
      () => att.preflight(c, actorFor(), { slug: 'reviewer-2', subkey: claimed.subkey }, 'emet_session_open'),
      /live session/
    );
    const snap = await load(deps, sk);
    assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 1);
    assert.ok(snap.history.some((ev) => ev.event === 'collision'));
  }));
});

testGroup('chat wrap-up', () => {
  test('a chat key with no wrap-up is marked unwrapped and can still open', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk, { client_kind: 'chat' });
    assert.equal((await load(deps, sk)).keys[claimed.key_id].client_kind, 'chat');
    const first = await openKey(att, sk, c, deps, claimed, { slug: 'chat' });
    const bot = actorFor();
    await att.preflight(c, bot, { slug: 'chat-next', subkey: claimed.subkey }, 'emet_session_open');
    const handle = await sk.commitLiveSession(deps, bot, att.sessionOpenBase({ slug: 'chat-next' }, NOW), NOW);
    const notice = sk.takeOpenNotice(bot);
    assert.equal(notice.wrap_up_notice, UNWRAPPED_NOTICE);
    assert.match(notice.message, /previous chat was not wrapped up/);
    const snap = await load(deps, sk);
    assert.equal(snap.sessions.find((s) => s.session_id === first.base).state, 'unwrapped');
    assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 1);
    assert.match(handle, /^emh_/);
    const view = sk.subkeysView(snap, ownerHost(), 'owner', NOW);
    const flags = view.keys.find((k) => k.key_id === claimed.key_id).collision_flags;
    assert.equal(flags.length, 1);
    assert.ok(snap.history.some((ev) => ev.event === 'collision'));
  }));

  test('a wrap-up record closes the old chat into the new one', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk, { client_kind: 'chat' });
    const first = await openKey(att, sk, c, deps, claimed, { slug: 'chat' });
    deps.wrapUps.push({ tag: 'reviewer-bot', at: NOW.toISOString() });
    const bot = actorFor();
    await att.preflight(c, bot, { slug: 'chat-wrapped', subkey: claimed.subkey }, 'emet_session_open');
    await sk.commitLiveSession(deps, bot, att.sessionOpenBase({ slug: 'chat-wrapped' }, NOW), NOW);
    const notice = sk.takeOpenNotice(bot);
    assert.equal(notice, null);
    const snap = await load(deps, sk);
    const old = snap.sessions.find((s) => s.session_id === first.base);
    assert.equal(old.state, 'closed');
    assert.equal(old.end_reason, 'reclaimed');
    assert.equal(snap.sessions.filter((s) => s.state === 'live').length, 1);
  }));

  test('an expired chat handle with no wrap-up tells the user and does not refuse status', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk, { client_kind: 'chat' });
    const first = await openKey(att, sk, c, deps, claimed, { slug: 'chat' });
    await deps.subkeys.mutate((data) => {
      const s = data.sessions.find((row) => row.session_id === first.base);
      s.expires_at = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString();
      return true;
    });
    const before = JSON.stringify(await load(deps, sk));
    const reader = actorFor();
    await att.preflight(c, reader, { session_id: first.base, session_handle: first.handle }, 'emet_status');
    assert.equal(reader.subkeyRenewal.wrap_up_notice, UNWRAPPED_NOTICE);
    assert.equal(JSON.stringify(await load(deps, sk)), before);
    await assert.rejects(
      () => att.preflight(c, actorFor(), { session_id: first.base, session_handle: first.handle }, 'write_doc'),
      (err) => preflightHttpCode(err) === 'EMET-SESS-014' && err.message.includes(UNWRAPPED_NOTICE)
    );
  }));
});

testGroup('transcript close', () => {
  test('the sweep closes open transcript sessions whose sub-key link is ended or absent', async () => withEnv(ON, async () => {
    const { sk } = await fresh();
    const { deps } = world();
    const { claimed } = await issue(deps, sk);
    const store = makeStore();
    const dbManager = { ensureClient: async () => store };
    await deps.subkeys.mutate((data) => {
      data.keys[claimed.key_id].live_session_id = null;
      STRANDED_IDS.forEach((session_id, i) => {
        data.sessions.push({
          open_id: `real-${i}`, session_id, key_id: claimed.key_id, tag: 'reviewer-bot',
          state: i % 2 === 0 ? 'ended' : 'expired',
          expires_at: '2026-11-01T00:00:00.000Z', opened_at: '2026-11-01T00:00:00.000Z',
          retained: true
        });
      });
      return true;
    });
    for (const id of STRANDED_IDS) {
      await store.collection('emet_sessions').insertOne({ _id: id, opened: true, opened_at: new Date('2026-11-17T15:00:00Z') });
    }
    await store.collection('emet_sessions').insertOne({ _id: '2026-11-21_still-live', opened: true, opened_at: NOW });
    const n = await sk.sweepStrandedSessions({ ...deps, dbManager }, new Date('2026-11-21T16:00:00Z'));
    assert.ok(n >= STRANDED_IDS.length);
    for (const id of STRANDED_IDS) {
      const row = store.row(id);
      assert.equal(row.closed, true, id);
      assert.equal(row.closed_by, 'server-sweep', id);
      assert.equal(row.retained, true, id);
      assert.equal(row.deleted, false, id);
      assert.equal(row.close_history.length, 1, id);
      assert.match(row.close_history[0].note, /transcript stays/);
      assert.equal(store.sessions().some((item) => item._id === id), true, id);
    }
    assert.equal(store.row('2026-11-21_still-live').closed, undefined);
  }));

  test('a same-key reclaim closes the transcript and keeps it', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const first = await openKey(att, sk, c, deps, claimed);
    const store = makeStore();
    deps.dbManager = { ensureClient: async () => store };
    await store.collection('emet_sessions').insertOne({ _id: first.base, opened: true, opened_at: NOW });
    await deps.subkeys.mutate((data) => {
      const s = data.sessions.find((row) => row.session_id === first.base);
      s.state = 'expired';
      s.expires_at = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
      data.keys[claimed.key_id].live_session_id = null;
      return true;
    });
    await openKey(att, sk, c, deps, claimed, { slug: 'reviewer-reclaim' });
    const row = store.row(first.base);
    assert.equal(row.closed, true);
    assert.equal(row.closed_by, `reclaim by key ${claimed.key_id}`);
    assert.equal(row.retained, true);
    assert.equal(row.deleted, false);
    assert.equal(row.close_history[0].closed_by, row.closed_by);
  }));
});

testGroup('credential', () => {
  test('client_kind is stored at approval, not from the request or a later call', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const bot = actorFor();
    const req = await sk.requestSubkey(deps, bot, { tag: 'reviewer-bot', client_kind: 'chat' }, REG, NOW);
    let row = (await load(deps, sk)).keys[req.key_id];
    assert.equal(row.client_kind, undefined);
    assert.equal(row.requested_client_kind, 'chat');
    await sk.decideSubkeyIfPending(deps, ownerHost(), 'owner', { tag: 'reviewer-bot', decision: 'approve' }, NOW);
    row = (await load(deps, sk)).keys[req.key_id];
    assert.equal(row.client_kind, 'bot');
    const claimed = await sk.claimSubkey(deps, bot, { key_id: req.key_id, nonce: req.nonce }, NOW);
    await openKey(att, sk, c, deps, claimed);
    await assert.rejects(
      () => att.preflight(c, actorFor(), { slug: 'pretend-chat', subkey: claimed.subkey, client_kind: 'chat' }, 'emet_session_open'),
      /live session/
    );
  }));

  test('the owner sets the kind on an approved key and the history keeps the previous kind', async () => withEnv(ON, async () => {
    const { sk } = await fresh();
    const { deps } = world();
    const { claimed } = await issue(deps, sk);
    assert.equal((await load(deps, sk)).keys[claimed.key_id].client_kind, 'bot');
    await assert.rejects(
      () => sk.setSubkeyClientKind(deps, actorFor({ personId: 'guest', sourceTag: 'reviewer-bot' }), 'owner', { key_id: claimed.key_id, client_kind: 'chat' }, NOW),
      /owner/
    );
    const set = await sk.setSubkeyClientKind(deps, ownerHost(), 'owner', { key_id: claimed.key_id, client_kind: 'chat' }, NOW);
    assert.equal(set.client_kind, 'chat');
    assert.equal(set.previous, 'bot');
    const row = (await load(deps, sk)).keys[claimed.key_id];
    assert.equal(row.client_kind, 'chat');
    assert.equal(row.status, 'active');
    assert.ok(row.history.some((ev) => ev.event === 'client_kind' && ev.client_kind === 'chat' && ev.previous === 'bot'));
    const again = await sk.setSubkeyClientKind(deps, ownerHost(), 'owner', { key_id: claimed.key_id, client_kind: 'chat' }, NOW);
    assert.equal(again.unchanged, true);
  }));

  test('a bad client_kind on approval changes nothing', async () => withEnv(ON, async () => {
    const { sk } = await fresh();
    const { deps } = world();
    const req = await sk.requestSubkey(deps, actorFor(), { tag: 'reviewer-bot' }, REG, NOW);
    await assert.rejects(
      () => sk.decideSubkeyIfPending(deps, ownerHost(), 'owner', { tag: 'reviewer-bot', decision: 'approve', client_kind: 'phone' }, NOW),
      /client_kind/
    );
    assert.equal((await load(deps, sk)).keys[req.key_id].status, 'pending');
  }));

  test('a status read of a stranded bot session is not refused and writes no handle_expired', async () => withEnv(ON, async () => {
    const { att, sk } = await fresh();
    const { deps, c } = world();
    const { claimed } = await issue(deps, sk);
    const { base, handle } = await openKey(att, sk, c, deps, claimed);
    await deps.subkeys.mutate((data) => {
      const s = data.sessions.find((row) => row.session_id === base);
      s.expires_at = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString();
      return true;
    });
    await att.preflight(c, actorFor(), { session_id: base, session_handle: handle }, 'emet_status');
    const snap = await load(deps, sk);
    assert.equal(snap.history.some((ev) => ev.event === 'handle_expired'), false);
    assert.equal(snap.sessions.find((s) => s.session_id === base).state, 'live');
    await assert.rejects(
      () => att.preflight(c, actorFor(), { session_id: 'not-a-session', session_handle: handle }, 'write_doc'),
      (err) => err.attributionRefusal === true && preflightHttpCode(err) === 'EMET-AUTH-039'
    );
  }));
});

testGroup('statechart', () => {
  test('every non-closed session can close, and a foreign credential does not', () => {
    const audit = auditSubkeySessions();
    assert.ok(audit.count > 1, String(audit.count));
    assert.equal(audit.problems.length, 0, JSON.stringify(audit.problems.slice(0, 2)));
    assert.equal(audit.stranded.length, 0);
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
    const doc = fs.readFileSync(path.join(root, 'docs', 'subkey-session-statechart.md'), 'utf8');
    const fenced = /```mermaid\n([\s\S]*?)\n```/.exec(doc);
    assert.ok(fenced);
    assert.equal(fenced[1], SUBKEY_SESSION_MERMAID);
  });
});

summary('Sub-key renewal');
