import { test, testGroup, summary } from './harness.js';
import * as mongoConnect from '../src/mongo-connect.js';
import assert from 'assert';
import { fullStartup } from './graph-session.js';
import { sessionBaseId, partId, partNumber, baseFromPart, nextExchangeIndex, shouldStartNewPart } from '../src/transcript-session.js';

console.log('\n=== transcript-session ===');
test('part ids roll', () => {
  assert.strictEqual(partId('2026-09-26_grok', 2), '2026-09-26_grok_verbatim_part2');
  assert.strictEqual(partNumber('2026-09-26_grok_verbatim_part3'), 3);
  assert.strictEqual(baseFromPart('2026-09-26_grok_verbatim_part3'), '2026-09-26_grok');
});
test('next index continues', () => {
  assert.strictEqual(nextExchangeIndex([]), 1);
  assert.strictEqual(nextExchangeIndex([{ exchange_index: 4 }]), 5);
});
test('new part after 8', () => {
  assert.strictEqual(shouldStartNewPart(7), false);
  assert.strictEqual(shouldStartNewPart(8), true);
});
test('base id slugs', () => {
  assert.match(sessionBaseId(new Date('2026-09-26T16:00:00Z'), 'Grok Init'), /^2026-09-26_grok-init$/);
});
// ---------------------------------------------------------------------------
// Session ids (2026-10-01).
// Two failures observed on 2026-09-30 (two incident records):
//  (a) emet_session_open handed back a CLOSED session's id, and the next
//      append landed in the closed session as its exchange 9;
//  (b) the id's date came from UTC, so an evening session in the user's zone
//      (America/New_York) carried the next day's date.
// ---------------------------------------------------------------------------

// An in-memory store: the session graph's `<prefix>sessions` rows (a Map, as
// before), the `transcripts` collection, and a fake MongoClient over the same
// data, installed through mongo-connect's test seam so a tool that connects for
// itself (emet_transcript_append, revise_transcript) runs end to end with no
// database. Filters support plain equality, $in and $ne - all the code uses.
function matches(doc, q = {}) {
  return Object.entries(q).every(([k, v]) => {
    const d = doc[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v && !v.$in.some((x) => x === d || (x == null && d == null))) return false;
      if ('$ne' in v && d === v.$ne) return false;
      return true;
    }
    return d === v;
  });
}
function applyUpdate(doc, u) {
  Object.assign(doc, u.$set || {});
  for (const k of Object.keys(u.$unset || {})) delete doc[k];
  for (const [k, v] of Object.entries(u.$push || {})) doc[k] = [...(doc[k] || []), v];
  for (const [k, v] of Object.entries(u.$inc || {})) doc[k] = (doc[k] || 0) + v;
}
function fakeSessions(closed = [], { failRead = false, transcripts = [], failPosition = false, failTranscriptRead = false, failTranscriptWrite = false } = {}) {
  const rows = new Map(closed.map((id) => [id, { _id: id, opened: true, closed: true }]));
  const writes = []; // every sessions updateOne, by id - so "the closed session was not touched" can fail
  let seq = 0;
  const sessions = {
    async findOne(q) { if (failRead) throw new Error('store down'); const r = rows.get(q._id); return r && matches(r, q) ? r : null; },
    async updateOne(q, u, opts = {}) {
      writes.push(q._id);
      let r = rows.get(q._id);
      if (r && !matches(r, q)) return { matchedCount: 0, modifiedCount: 0 };
      if (!r) { if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0 }; r = { _id: q._id, ...(u.$setOnInsert || {}) }; }
      applyUpdate(r, u); rows.set(q._id, r);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async insertOne() { return { insertedId: 'x' }; }
  };
  const tcol = {
    async findOne(q) { if (failTranscriptRead) throw new Error('transcripts down'); const d = transcripts.find((x) => matches(x, q)); return d ? { ...d } : null; }, // a copy, as the driver returns
    async insertOne(doc) { if (failTranscriptWrite) throw new Error('write failed'); const _id = doc._id ?? `t${++seq}`; transcripts.push({ ...doc, _id }); return { insertedId: _id }; },
    async updateOne(q, u) { if (failTranscriptWrite) throw new Error('write failed'); const d = transcripts.find((x) => matches(x, q)); if (!d) return { matchedCount: 0, modifiedCount: 0 }; applyUpdate(d, u); return { matchedCount: 1, modifiedCount: 1 }; },
    async countDocuments() { return transcripts.length; }
  };
  const other = { async findOne() { return null; }, async insertOne() { return { insertedId: 'x' }; }, async updateOne() { return { matchedCount: 0, modifiedCount: 0 }; } };
  const labs = []; // graph_lab rows, so a test can read what the lab recorded
  const lab = { ...other, async insertOne(doc) { labs.push(doc); return { insertedId: 'x' }; } };
  const route = (name) => (name === 'transcripts' ? tcol : /sessions$/.test(name) ? sessions : /graph_lab$/.test(name) ? lab : other);
  const baseOf = (sid) => String(sid).replace(/_verbatim_part\d+$/, '');
  const partNo = (sid) => { const m = /_verbatim_part(\d+)$/.exec(sid); return m ? Number(m[1]) : 0; };
  const db = {
    rows, writes, transcripts, labs,
    async ensureClient() { return { collection: route }; },
    // As database.js: every live document grouped under the base the way the
    // close check groups them (^base(_.*)?$); last_part is the highest part the
    // server mints (<base> or <base>_verbatim_partN).
    async transcriptPosition(sid) {
      if (failPosition) throw new Error('position down');
      const base = baseOf(sid);
      const live = transcripts.filter((d) => (d.session_id === base || d.session_id.startsWith(`${base}_`)) && !d.superseded_by);
      const minted = live.map((d) => d.session_id).filter((id) => id === base || new RegExp(`^${base}_verbatim_part\\d+$`).test(id));
      const last_part = minted.length ? minted.reduce((a, b) => (partNo(b) > partNo(a) ? b : a)) : null;
      return { base, present: live.length > 0, highest: live.reduce((m, d) => Math.max(m, ...(d.exchanges || []).map((e) => Number(e.exchange_index))), 0), last_part };
    }
  };
  db.Client = class { async connect() {} db() { return { collection: route }; } async close() {} };
  return db;
}
/** Runs fn with the fake MongoClient installed (the seam), and removes it after. */
async function withStore(db, fn) {
  if (typeof mongoConnect.useTestClient === 'function') mongoConnect.useTestClient(db.Client);
  try { return await fn(); } finally { if (typeof mongoConnect.useTestClient === 'function') mongoConnect.useTestClient(null); }
}
async function withEnv(name, value, fn) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return await fn(); } finally { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; }
}
// graphAfter and labRecord are not awaited. Poll until the row they write is visible.
async function until(pred, label) {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((res) => setImmediate(res));
  }
}
// A fixed clock: 9:30 PM in New York on 9/30 is 01:30 UTC on 10/1.
const EVENING = new Date('2026-10-01T01:30:00Z');
const minutesAfter = (t, m) => new Date(t.getTime() + m * 60000);
const dataOf = (r) => JSON.parse(r.content[0].text).data;

testGroup('session ids: the date is the local day (failure b, an incident record)', () => {
  test('9:30 PM in New York on 9/30 (01:30 UTC on 10/1) is dated 2026-09-30 by default', () => {
    assert.strictEqual(sessionBaseId(new Date('2026-10-01T01:30:00Z'), 'grok-init'), '2026-09-30_grok-init');
  });
  test('winter time too: 11:30 PM EST on 11/30 (04:30 UTC on 12/1) is dated 2026-11-30', () => {
    assert.strictEqual(sessionBaseId(new Date('2026-12-01T04:30:00Z'), 'x'), '2026-11-30_x');
  });
  test('the zone is a setting: EMET_TIMEZONE=UTC dates the same instant 2026-10-01', () => {
    const saved = process.env.EMET_TIMEZONE;
    process.env.EMET_TIMEZONE = 'UTC';
    try {
      assert.strictEqual(sessionBaseId(new Date('2026-10-01T01:30:00Z'), 'grok-init'), '2026-10-01_grok-init');
    } finally { if (saved === undefined) delete process.env.EMET_TIMEZONE; else process.env.EMET_TIMEZONE = saved; }
  });
  test('an unknown zone falls back to America/New_York and says so', async () => {
    const { sessionTimeZone } = await import('../src/transcript-session.js');
    assert.strictEqual(typeof sessionTimeZone, 'function', 'sessionTimeZone is not exported');
    const tz = sessionTimeZone('Mars/Olympus_Mons');
    assert.strictEqual(tz.zone, 'America/New_York');
    assert.ok(/Mars\/Olympus_Mons/.test(tz.note || ''), tz.note);
    assert.strictEqual(sessionTimeZone(undefined).zone, 'America/New_York');
    assert.strictEqual(sessionTimeZone(undefined).note, null);
  });
  test('end to end: emet_session_open at 9:30 PM New York time on 9/30 opens 2026-09-30_<slug> (clock injected)', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const r = await sessionOpen({ slug: 'grok-init' }, null, fakeSessions(), EVENING);
    assert.strictEqual(r.base, '2026-09-30_grok-init');
    assert.strictEqual(r.session_id, '2026-09-30_grok-init_verbatim_part1');
  });
  test('emet_session_open reports the zone it dated the id in', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const r = await sessionOpen({ slug: 'tz-check' }, null, fakeSessions());
    assert.strictEqual(r.time_zone, 'America/New_York');
  });
});

testGroup('session ids: a closed id is never reused (failure a, an incident record)', () => {
  test('a slug whose id is already CLOSED opens as <id>-2, and the response says why', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const { baseOf } = await import('../src/session-graph.js');
    const first = await sessionOpen({ slug: 'project-host-init' }, null, fakeSessions(), EVENING);
    const db = fakeSessions([first.base]);
    const r = await sessionOpen({ slug: 'project-host-init' }, null, db, EVENING);
    assert.strictEqual(r.base, `${first.base}-2`);
    assert.strictEqual(r.session_id, `${first.base}-2_verbatim_part1`);
    assert.ok(r.suffix_applied, 'no suffix_applied block');
    assert.strictEqual(r.suffix_applied.requested, first.base);
    assert.ok(/closed/i.test(r.notice) && r.notice.includes(first.base) && r.notice.includes(r.base), r.notice);
    // The id handed out must not belong to the closed session (fails if the closed id comes back).
    assert.notStrictEqual(baseOf(r.session_id), first.base, 'the closed session id was handed out');
  });
  test('-2 closed as well: the next free number, -3', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const first = await sessionOpen({ slug: 'again' }, null, fakeSessions(), EVENING);
    const r = await sessionOpen({ slug: 'again' }, null, fakeSessions([first.base, `${first.base}-2`]), EVENING);
    assert.strictEqual(r.base, `${first.base}-3`);
    assert.deepStrictEqual(r.suffix_applied.closed, [first.base, `${first.base}-2`]);
  });
  test('an id that is open but not closed is returned unchanged, with no suffix (resume still works)', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const first = await sessionOpen({ slug: 'resume' }, null, fakeSessions(), EVENING);
    const db = fakeSessions();
    db.rows.set(first.base, { _id: first.base, opened: true });
    const r = await sessionOpen({ slug: 'resume' }, null, db, EVENING);
    assert.strictEqual(r.base, first.base);
    assert.strictEqual(r.suffix_applied, undefined);
  });
  test('if the session state cannot be read, no session is opened (an unchecked id could be a closed one)', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const db = fakeSessions();
    db.ensureClient = async () => { throw new Error('store down'); };
    await assert.rejects(() => sessionOpen({ slug: 'down' }, null, db, EVENING),
      (e) => /could not check/.test(e.message) && /no session was opened/.test(e.message) && /store down/.test(e.message));
  });
  test('through the door (dispatchTool): the closed id is not handed out, the closed row is not touched, the new id is recorded as opened', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    const { sessionOpen } = await import('../src/tools.js');
    const first = await sessionOpen({ slug: 'door' }, null, fakeSessions(), EVENING);
    const db = fakeSessions([first.base]);
    const before = JSON.stringify(db.rows.get(first.base));
    const r = await dispatchTool('emet_session_open', { slug: 'door', load_id: await fullStartup() }, { dbManager: db, logger: null, now: EVENING });
    const text = JSON.stringify(r);
    assert.ok(!r.isError, text.slice(0, 300));
    assert.ok(text.includes(`${first.base}-2_verbatim_part1`), text.slice(0, 300));
    await until(() => db.rows.get(`${first.base}-2`)?.opened === true, 'suffixed session opened');
    assert.strictEqual(db.rows.get(`${first.base}-2`)?.opened, true);
    // Fails if anything writes to the closed session's row (the old code re-marked it opened).
    assert.deepStrictEqual(db.writes.filter((id) => id === first.base), [], 'the closed session row was written to');
    assert.strictEqual(JSON.stringify(db.rows.get(first.base)), before, 'the closed session row changed');
  });
});

testGroup('session ids: a suffix never collides with a real slug ending in -N (review nit 2)', () => {
  test('fix is closed and a real slug fix-2 is open: slug fix opens fix-3, not fix-2', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const day = '2026-09-30';
    const db = fakeSessions([`${day}_fix`]);
    db.rows.set(`${day}_fix-2`, { _id: `${day}_fix-2`, opened: true }); // opened from slug "fix-2"
    const r = await sessionOpen({ slug: 'fix' }, null, db, EVENING);
    assert.strictEqual(r.base, `${day}_fix-3`);
    assert.ok(r.notice.includes(`${day}_fix-2 is in use by a session under another slug`), r.notice);
  });
  test('fix-2 was minted as the suffix of fix: a real slug fix-2 does not join it', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const day = '2026-09-30';
    const db = fakeSessions([`${day}_fix`]);
    db.rows.set(`${day}_fix-2`, { _id: `${day}_fix-2`, opened: true, suffix_of: `${day}_fix` });
    const r = await sessionOpen({ slug: 'fix-2' }, null, db, EVENING);
    assert.strictEqual(r.base, `${day}_fix-2-2`);
  });
  test('the suffix minted for this slug is resumed (reconnect after a close-and-reopen)', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const day = '2026-09-30';
    const db = fakeSessions([`${day}_fix`]);
    db.rows.set(`${day}_fix-2`, { _id: `${day}_fix-2`, opened: true, suffix_of: `${day}_fix` });
    const r = await sessionOpen({ slug: 'fix' }, null, db, EVENING);
    assert.strictEqual(r.base, `${day}_fix-2`);
  });
  test('a suffixed open records what it is the suffix of', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    const { sessionOpen } = await import('../src/tools.js');
    const first = await sessionOpen({ slug: 'mark' }, null, fakeSessions(), EVENING);
    const db = fakeSessions([first.base]);
    await dispatchTool('emet_session_open', { slug: 'mark', load_id: await fullStartup() }, { dbManager: db, logger: null, now: EVENING });
    await until(() => db.rows.get(`${first.base}-2`)?.suffix_of === first.base, 'suffix_of recorded');
    assert.strictEqual(db.rows.get(`${first.base}-2`)?.suffix_of, first.base);
  });
});

testGroup('transcript writes into a closed session (review fix 1; the owner 2026-10-01: one closing exchange, corrections allowed)', () => {
  const CLOSED = '2026-09-30_project-host-init';
  const P1 = `${CLOSED}_verbatim_part1`;
  const CLOSED_AT = EVENING;
  const msg = { user_message: 'u', assistant_message: 'a', source: 'test' };
  const ex = (n, text = `turn ${n}`) => ({ exchange_index: n, user_message: `${text} (user)`, assistant_message: `${text} (assistant)`, timestamp: new Date('2026-10-01T01:00:00Z') });
  // A closed session whose part 1 holds exchanges 1-3, closed (recorded) at CLOSED_AT.
  const closedWorld = (opts = {}, rowExtra = { closed_at: CLOSED_AT }) => {
    const db = fakeSessions([CLOSED], { transcripts: [{ _id: 'p1', session_id: P1, exchange_count: 3, exchanges: [ex(1), ex(2), ex(3)] }], ...opts });
    Object.assign(db.rows.get(CLOSED), rowExtra);
    return db;
  };
  const call = (db, tool, args, now) => withStore(db, async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    return dispatchTool(tool, args, { dbManager: db, logger: null, now });
  });
  const text = (r) => JSON.stringify(r);
  const lockedRefusal = (r) => r.isError && /closed and locked/.test(text(r)) && /nothing was written/.test(text(r)) &&
    /Nothing in it was lost or changed/.test(text(r)) && /next session you open the usual way/.test(text(r)) && !/Open a new session/.test(text(r));
  const p1Count = (db) => db.transcripts.find((d) => d._id === 'p1').exchanges.length;

  // --- the one closing exchange ---------------------------------------------------
  test('grace: one append within 5 minutes of the recorded close is accepted as the closing exchange, numbered highest+1, and the reply says the session is now locked', async () => {
    const db = closedWorld();
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 2));
    assert.ok(!r.isError, text(r).slice(0, 400));
    const d = dataOf(r);
    assert.strictEqual(d.exchange_index, 4);
    assert.strictEqual(d.closing_exchange.accepted, true);
    assert.strictEqual(d.closing_exchange.locked, true);
    assert.ok(/Accepted as the closing exchange \(exchange 4\)/.test(d.closing_exchange.notice) && /now locked/.test(d.closing_exchange.notice), d.closing_exchange.notice);
    assert.strictEqual(p1Count(db), 4);
    assert.strictEqual(db.rows.get(CLOSED).grace_used, true);
    assert.strictEqual(db.rows.get(CLOSED).grace_index, 4);
  });
  test('grace: a second append inside the window is refused, and nothing is written', async () => {
    const db = closedWorld();
    await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 2));
    const r = await call(db, 'emet_transcript_append', { session_id: P1, exchange_index: 5, ...msg }, minutesAfter(CLOSED_AT, 3));
    assert.ok(lockedRefusal(r) && /closing exchange has already been saved/.test(text(r)), text(r).slice(0, 400));
    const r2 = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 3));
    assert.ok(lockedRefusal(r2), text(r2).slice(0, 400));
    assert.strictEqual(p1Count(db), 4);
  });
  test('grace: a retry of the same closing exchange (same number) succeeds as already saved, not as a second write', async () => {
    const db = closedWorld();
    await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 2));
    const r = await call(db, 'emet_transcript_append', { session_id: P1, exchange_index: 4, ...msg }, minutesAfter(CLOSED_AT, 2.5));
    assert.ok(!r.isError, text(r).slice(0, 400));
    const d = dataOf(r);
    assert.strictEqual(d.already_present, true);
    assert.strictEqual(d.closing_exchange.already_saved, true);
    assert.strictEqual(p1Count(db), 4);
  });
  test('grace: an append after the window (6 minutes, clock injected) is refused, and nothing is written', async () => {
    const db = closedWorld();
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 6));
    assert.ok(lockedRefusal(r) && /5-minute window/.test(text(r)), text(r).slice(0, 400));
    assert.strictEqual(p1Count(db), 3);
    assert.ok(!db.rows.get(CLOSED).grace_used);
  });
  test('grace: the window is a setting (EMET_CLOSE_GRACE_MINUTES=10 accepts at 6 minutes; 0 turns it off)', async () => {
    const r10 = await withEnv('EMET_CLOSE_GRACE_MINUTES', '10', () => call(closedWorld(), 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 6)));
    assert.ok(!r10.isError && dataOf(r10).closing_exchange.accepted, text(r10).slice(0, 400));
    const r0 = await withEnv('EMET_CLOSE_GRACE_MINUTES', '0', () => call(closedWorld(), 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 1)));
    assert.ok(lockedRefusal(r0), text(r0).slice(0, 400));
  });
  test('grace: only exchange highest+1 can be the closing exchange', async () => {
    const db = closedWorld();
    const r = await call(db, 'emet_transcript_append', { session_id: P1, exchange_index: 9, ...msg }, minutesAfter(CLOSED_AT, 1));
    assert.ok(lockedRefusal(r) && /only exchange 4/.test(text(r)), text(r).slice(0, 400));
    assert.strictEqual(p1Count(db), 3);
  });
  test('grace: the window runs from the RECORDED close time - no closed_at recorded, no window', async () => {
    const db = closedWorld({}, {});
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 1));
    assert.ok(lockedRefusal(r), text(r).slice(0, 400));
  });
  test('grace: a claimed closing exchange whose write fails is given back, so the window is not spent', async () => {
    const db = closedWorld({ failTranscriptWrite: true });
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 1));
    assert.ok(r.isError && /write failed/.test(text(r)), text(r).slice(0, 400));
    assert.ok(!db.rows.get(CLOSED).grace_used, 'the failed write spent the window');
  });
  test('grace: if the transcript position cannot be read, the append is refused (fail-safe)', async () => {
    const db = closedWorld({ failPosition: true });
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 1));
    assert.ok(r.isError && /session graph unavailable|could not read the transcript position/.test(text(r)) && /nothing was written/i.test(text(r)), text(r).slice(0, 400));
    assert.strictEqual(p1Count(db), 3);
  });
  test('grace: the monorail agrees - the closing exchange passes, a second append does not', async () => {
    const { evaluate } = await import('../src/session-graph.js');
    const state = { opened: true, closed: true, closed_at: CLOSED_AT };
    assert.strictEqual(evaluate('emet_transcript_append', { session_id: P1, exchange_index: 4 }, state, 3, minutesAfter(CLOSED_AT, 2)).verdict, 'ok');
    assert.strictEqual(evaluate('emet_transcript_append', { session_id: P1, exchange_index: 5 }, { ...state, grace_used: true, grace_index: 4 }, 4, minutesAfter(CLOSED_AT, 3)).gate, 'closed');
    assert.strictEqual(evaluate('emet_transcript_append', { session_id: P1, exchange_index: 4 }, state, 3, minutesAfter(CLOSED_AT, 6)).gate, 'closed');
  });

  // --- corrections ------------------------------------------------------------------
  test('corrections: revise_transcript on a closed session is allowed - the part is superseded, the original kept', async () => {
    const db = closedWorld();
    const r = await call(db, 'revise_transcript', { session_id: P1, exchanges: [ex(1), ex(2, 'corrected'), ex(3)], reason: 'exchange 2 was mispaired', source: 'test' }, minutesAfter(CLOSED_AT, 60));
    assert.ok(!r.isError, text(r).slice(0, 400));
    const d = dataOf(r);
    assert.strictEqual(d.verified, true);
    assert.strictEqual(d.parent_retained, true);
    assert.strictEqual(d.exchange_count, 3);
    assert.strictEqual(db.transcripts.length, 2);
  });
  test('corrections: a revision of a closed session cannot add an exchange (count would grow)', async () => {
    const db = closedWorld();
    const r = await call(db, 'revise_transcript', { session_id: P1, exchanges: [ex(1), ex(2), ex(3), ex(4)], reason: 'adding a missing turn', source: 'test' }, minutesAfter(CLOSED_AT, 60));
    assert.ok(r.isError && /never add new ones/.test(text(r)) && /Nothing was written/.test(text(r)), text(r).slice(0, 400));
    assert.strictEqual(db.transcripts.length, 1);
  });
  test('corrections: a revision of a closed session cannot swap in an exchange number the part does not hold', async () => {
    const db = closedWorld();
    const r = await call(db, 'revise_transcript', { session_id: P1, exchanges: [ex(1), ex(2), ex(9)], reason: 'renumbering a turn', source: 'test' }, minutesAfter(CLOSED_AT, 60));
    assert.ok(r.isError && /exchange 9 is not in that part/.test(text(r)), text(r).slice(0, 400));
    assert.strictEqual(db.transcripts.length, 1);
  });
  test('corrections: if the part to be revised cannot be read, the revision is refused (fail-safe)', async () => {
    const db = closedWorld({ failTranscriptRead: true });
    const r = await call(db, 'revise_transcript', { session_id: P1, exchanges: [ex(1)], reason: 'exchange 1 was mispaired', source: 'test' }, minutesAfter(CLOSED_AT, 60));
    assert.ok(r.isError && /could not read the transcript part/.test(text(r)), text(r).slice(0, 400));
  });

  // --- the refusals that still hold ---------------------------------------------------
  test('emet_transcript_append into a closed session is refused (no window) and the closed session is not touched', async () => {
    const db = fakeSessions([CLOSED]);
    const before = JSON.stringify(db.rows.get(CLOSED));
    const r = await call(db, 'emet_transcript_append', { session_id: P1, exchange_index: 9, ...msg }, EVENING);
    assert.ok(lockedRefusal(r), text(r).slice(0, 400));
    await until(() => db.labs.some((x) => x.tool === 'emet_transcript_append' && x.gate === 'closed'), 'closed refusal recorded');
    assert.strictEqual(JSON.stringify(db.rows.get(CLOSED)), before);
  });
  test('a later part id of the closed session is refused too', async () => {
    const r = await call(fakeSessions([CLOSED]), 'emet_transcript_append', { session_id: `${CLOSED}_verbatim_part2`, ...msg }, EVENING);
    assert.ok(lockedRefusal(r), text(r).slice(0, 400));
  });
  test('save_transcript into a closed session is refused, even inside the window', async () => {
    const db = closedWorld();
    const r = await call(db, 'save_transcript', { session_id: CLOSED, session_start: 1790000000, exchanges: [ex(1)], source: 'test' }, minutesAfter(CLOSED_AT, 1));
    assert.ok(lockedRefusal(r) && /whole-transcript save/.test(text(r)), text(r).slice(0, 400));
    assert.strictEqual(db.transcripts.length, 1);
  });
  test('if the session state cannot be read, the append is refused and nothing is written', async () => {
    const db = fakeSessions([], { failRead: true });
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, EVENING);
    assert.ok(r.isError && /session graph unavailable/.test(text(r)) && /nothing was written/i.test(text(r)), text(r).slice(0, 400));
    assert.strictEqual(db.transcripts.length, 0);
  });
  test('EMET_SESSION_GRAPH=off is no longer read: a sessions-store outage still refuses the append, and the refusal says to send it again', async () => {
    const db = fakeSessions([], { failRead: true, transcripts: [{ _id: 'p1', session_id: P1, exchange_count: 3, exchanges: [ex(1), ex(2), ex(3)] }] });
    const r = await withEnv('EMET_SESSION_GRAPH', 'off', () => call(db, 'emet_transcript_append', { session_id: P1, ...msg }, EVENING));
    assert.ok(r.isError && /nothing was written/i.test(text(r)) && /session graph unavailable/.test(text(r)), text(r).slice(0, 400));
    assert.strictEqual(db.transcripts[0].exchanges.length, 3);
  });
  test('an append into an open session succeeds (the closed check does not get in its way)', async () => {
    const db = fakeSessions([], { transcripts: [{ _id: 'p1', session_id: P1, exchange_count: 3, exchanges: [ex(1), ex(2), ex(3)] }] });
    db.rows.set(CLOSED, { _id: CLOSED, opened: true });
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, EVENING);
    assert.ok(!r.isError, text(r).slice(0, 400));
    const d = dataOf(r);
    assert.strictEqual(d.exchange_index, 4);
    assert.strictEqual(d.exchange_count, 4);
    assert.strictEqual(d.closing_exchange, undefined);
    assert.strictEqual(p1Count(db), 4);
  });
  test('the monorail backstop still refuses a late append with no window', async () => {
    const { evaluate } = await import('../src/session-graph.js');
    const d = evaluate('emet_transcript_append', { session_id: P1, exchange_index: 10 }, { opened: true, closed: true }, 9);
    assert.strictEqual(d.verdict, 'refuse');
    assert.strictEqual(d.gate, 'closed');
  });
});

testGroup('closed sessions: a retry or an odd id can write nothing (second-reader review 3 and review gate on an earlier draft)', () => {
  const CLOSED = '2026-09-30_project-host-init';
  const P1 = `${CLOSED}_verbatim_part1`;
  const CLOSED_AT = EVENING;
  const msg = { user_message: 'u', assistant_message: 'a', source: 'test' };
  const ex = (n, t = `turn ${n}`) => ({ exchange_index: n, user_message: `${t} (user)`, assistant_message: `${t} (assistant)`, timestamp: new Date('2026-10-01T01:00:00Z') });
  const closedWorld = (docs = [{ _id: 'p1', session_id: P1, exchange_count: 3, exchanges: [ex(1), ex(2), ex(3)] }], rowExtra = { closed_at: CLOSED_AT }) => {
    const db = fakeSessions([CLOSED], { transcripts: docs });
    Object.assign(db.rows.get(CLOSED), rowExtra);
    return db;
  };
  const call = (db, tool, args, now) => withStore(db, async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    return dispatchTool(tool, args, { dbManager: db, logger: null, now });
  });
  const text = (r) => JSON.stringify(r);
  // Every live exchange number, per document, so "nothing was written" can fail.
  const snapshot = (db) => JSON.stringify(db.transcripts.map((d) => [d.session_id, !!d.superseded_by, (d.exchanges || []).map((e) => [e.exchange_index, e.user_message])]));
  const liveIdx = (db) => db.transcripts.filter((d) => !d.superseded_by).flatMap((d) => d.exchanges.map((e) => e.exchange_index));
  // A closed session whose closing exchange 4 was saved at +1 minute.
  const afterClosing = async () => {
    const db = closedWorld();
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 1));
    assert.ok(!r.isError && dataOf(r).closing_exchange.accepted, text(r).slice(0, 300));
    return db;
  };
  const retried = (r) => !r.isError && dataOf(r).closing_exchange && dataOf(r).closing_exchange.already_saved === true && dataOf(r).written === false;

  // --- the blocker: three ways a "retry" wrote into a locked session ----------------
  test('retry, exchange number sent as text ("4"): answered as already saved, and NOTHING is written - in the window and 10 hours later', async () => {
    const db = await afterClosing();
    const before = snapshot(db);
    for (const m of [2, 600]) {
      const r = await call(db, 'emet_transcript_append', { session_id: P1, exchange_index: '4', user_message: 'injected', assistant_message: 'injected', source: 'test' }, minutesAfter(CLOSED_AT, m));
      assert.strictEqual(snapshot(db), before, `a text "4" retry at +${m} min wrote into the closed session`);
      assert.ok(retried(r), text(r).slice(0, 400));
    }
    assert.deepStrictEqual(liveIdx(db), [1, 2, 3, 4]);
  });
  test('retry of exchange 4 sent to a different part id (part 5): nothing is written, no new part appears', async () => {
    const db = await afterClosing();
    const before = snapshot(db);
    const r = await call(db, 'emet_transcript_append', { session_id: `${CLOSED}_verbatim_part5`, exchange_index: 4, ...msg }, minutesAfter(CLOSED_AT, 120));
    assert.strictEqual(snapshot(db), before, 'the retry created or changed a part');
    assert.ok(retried(r), text(r).slice(0, 400));
    assert.strictEqual(db.transcripts.length, 1);
  });
  test('retry of exchange 4 sent to the base id: nothing is written, no new document appears', async () => {
    const db = await afterClosing();
    const before = snapshot(db);
    const r = await call(db, 'emet_transcript_append', { session_id: CLOSED, exchange_index: 4, ...msg }, minutesAfter(CLOSED_AT, 120));
    assert.strictEqual(snapshot(db), before, 'the retry created a document under the base id');
    assert.ok(retried(r), text(r).slice(0, 400));
    assert.strictEqual(db.transcripts.length, 1);
  });

  // --- the exchange number is checked once, in dispatch -----------------------------
  test('exchange_index that is not a whole number >= 1 is refused cleanly before anything runs ("4.5", 4.5, 0, -1, "abc", true)', async () => {
    for (const bad of ['4.5', 4.5, 0, -1, 'abc', true]) {
      const db = fakeSessions([], { transcripts: [{ _id: 'p1', session_id: P1, exchange_count: 3, exchanges: [ex(1), ex(2), ex(3)] }] });
      db.rows.set(CLOSED, { _id: CLOSED, opened: true });
      const r = await call(db, 'emet_transcript_append', { session_id: P1, exchange_index: bad, ...msg }, EVENING);
      assert.ok(r.isError && /exchange_index must be a whole number/.test(text(r)) && /Nothing was written/.test(text(r)), `${JSON.stringify(bad)}: ${text(r).slice(0, 300)}`);
      assert.deepStrictEqual(liveIdx(db), [1, 2, 3]);
    }
  });
  test('a text exchange number on an OPEN session is stored as a number ("4" -> 4)', async () => {
    const db = fakeSessions([], { transcripts: [{ _id: 'p1', session_id: P1, exchange_count: 3, exchanges: [ex(1), ex(2), ex(3)] }] });
    db.rows.set(CLOSED, { _id: CLOSED, opened: true });
    const r = await call(db, 'emet_transcript_append', { session_id: P1, exchange_index: '4', ...msg }, EVENING);
    assert.ok(!r.isError, text(r).slice(0, 300));
    assert.deepStrictEqual(liveIdx(db), [1, 2, 3, 4]);
    assert.strictEqual(typeof db.transcripts[0].exchanges[3].exchange_index, 'number');
  });

  // --- pinned to the last live part --------------------------------------------------
  test('pinned: a closing exchange sent to the base id or another part id is written into the last live part', async () => {
    for (const sid of [CLOSED, `${CLOSED}_verbatim_part5`]) {
      const db = closedWorld();
      const r = await call(db, 'emet_transcript_append', { session_id: sid, ...msg }, minutesAfter(CLOSED_AT, 1));
      assert.ok(!r.isError && dataOf(r).closing_exchange.accepted, `${sid}: ${text(r).slice(0, 300)}`);
      assert.strictEqual(db.transcripts.length, 1, `${sid}: a new document was created`);
      assert.deepStrictEqual(liveIdx(db), [1, 2, 3, 4]);
      assert.strictEqual(dataOf(r).session_id, P1);
    }
  });
  test('part-1 id after rollover: the closing exchange goes to a NEW part 3, never into the full part 2; a part-1 retry writes nothing', async () => {
    const P2 = `${CLOSED}_verbatim_part2`;
    const db = closedWorld([
      { _id: 'p1', session_id: P1, exchange_count: 8, exchanges: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ex(n)) },
      { _id: 'p2', session_id: P2, exchange_count: 8, exchanges: [9, 10, 11, 12, 13, 14, 15, 16].map((n) => ex(n)) }
    ]);
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 1));
    assert.ok(!r.isError && dataOf(r).closing_exchange.accepted, text(r).slice(0, 300));
    assert.strictEqual(dataOf(r).exchange_index, 17);
    assert.strictEqual(db.transcripts.find((d) => d._id === 'p2').exchanges.length, 8, 'the full part 2 took a ninth exchange');
    assert.strictEqual(db.transcripts.find((d) => d._id === 'p1').exchanges.length, 8, 'part 1 changed');
    assert.deepStrictEqual(db.transcripts.find((d) => d.session_id === `${CLOSED}_verbatim_part3`)?.exchanges.map((e) => e.exchange_index), [17]);
    const before = snapshot(db);
    const r2 = await call(db, 'emet_transcript_append', { session_id: P1, exchange_index: 17, ...msg }, minutesAfter(CLOSED_AT, 30));
    assert.strictEqual(snapshot(db), before, 'a part-1 retry wrote');
    assert.ok(retried(r2), text(r2).slice(0, 300));
  });

  // --- id shape: grouped as the close check groups it --------------------------------
  test('id shape: <base>_extra is part of the closed session (as the close check counts it) - refused after the window, nothing created', async () => {
    const db = closedWorld();
    const before = snapshot(db);
    const r = await call(db, 'emet_transcript_append', { session_id: `${CLOSED}_extra`, ...msg }, minutesAfter(CLOSED_AT, 60));
    assert.ok(r.isError && /closed and locked/.test(text(r)) && /nothing was written/.test(text(r)), text(r).slice(0, 300));
    assert.strictEqual(snapshot(db), before, 'a document was written under <base>_extra');
    const r2 = await call(db, 'save_transcript', { session_id: `${CLOSED}_extra`, session_start: 1790000000, exchanges: [ex(1)], source: 'test' }, minutesAfter(CLOSED_AT, 60));
    assert.ok(r2.isError && /closed and locked/.test(text(r2)), text(r2).slice(0, 300));
    assert.strictEqual(snapshot(db), before);
  });
  test('id shape: a closing exchange sent to <base>_extra inside the window is written into the last live part, not under <base>_extra', async () => {
    const db = closedWorld();
    const r = await call(db, 'emet_transcript_append', { session_id: `${CLOSED}_extra`, ...msg }, minutesAfter(CLOSED_AT, 1));
    assert.ok(!r.isError && dataOf(r).closing_exchange.accepted, text(r).slice(0, 300));
    assert.strictEqual(db.transcripts.length, 1);
    assert.deepStrictEqual(liveIdx(db), [1, 2, 3, 4]);
  });
  test('id shape: grouping helpers match the close check (^base(_.*)?$)', async () => {
    const { candidateBases, groupedUnder, isMintedPartOf } = await import('../src/session-graph.js');
    assert.deepStrictEqual(candidateBases(`${CLOSED}_x_y`), [`${CLOSED}_x_y`, `${CLOSED}_x`, CLOSED, '2026-09-30']);
    assert.ok(groupedUnder(`${CLOSED}_extra`, CLOSED) && groupedUnder(CLOSED, CLOSED) && !groupedUnder(`${CLOSED}-2`, CLOSED));
    assert.ok(isMintedPartOf(P1, CLOSED) && isMintedPartOf(CLOSED, CLOSED) && !isMintedPartOf(`${CLOSED}_extra`, CLOSED) && !isMintedPartOf(`${CLOSED}_verbatim_partx`, CLOSED));
  });

  // --- corrections keep the same set; revise then retry -----------------------------
  test('corrections on a closed session keep exactly the same exchange numbers: drop, duplicate, or a missing number are refused', async () => {
    for (const [label, exs] of [['drop', [ex(1), ex(2)]], ['duplicate', [ex(1), ex(1), ex(2)]], ['no numbers', [{ user_message: 'x', assistant_message: 'y' }, { user_message: 'x', assistant_message: 'y' }, { user_message: 'x', assistant_message: 'y' }]], ['text number', [ex(1), ex(2), { ...ex(3), exchange_index: 'three' }]]]) {
      const db = closedWorld();
      const r = await call(db, 'revise_transcript', { session_id: P1, exchanges: exs, reason: 'probe correction reason', source: 'test' }, minutesAfter(CLOSED_AT, 60));
      assert.ok(r.isError && /must carry exactly those numbers/.test(text(r)) && /Nothing was written/.test(text(r)), `${label}: ${text(r).slice(0, 300)}`);
      assert.strictEqual(db.transcripts.length, 1, `${label}: a revision was written`);
    }
  });
  test('corrections on a closed session: numbers sent as text are stored as numbers, in exchange order (a reorder of the same set is allowed)', async () => {
    const db = closedWorld();
    const r = await call(db, 'revise_transcript', { session_id: P1, exchanges: [{ ...ex(3), exchange_index: '3' }, { ...ex(1), exchange_index: '1' }, { ...ex(2, 'fixed'), exchange_index: '2' }], reason: 'exchange 2 was mispaired', source: 'test' }, minutesAfter(CLOSED_AT, 60));
    assert.ok(!r.isError, text(r).slice(0, 300));
    const live = db.transcripts.find((d) => !d.superseded_by);
    assert.deepStrictEqual(live.exchanges.map((e) => e.exchange_index), [1, 2, 3]);
    assert.ok(live.exchanges.every((e) => typeof e.exchange_index === 'number'));
  });
  test('revise then retry: a revision cannot drop the closing exchange, and a retry after a correction re-adds nothing', async () => {
    const db = await afterClosing();
    const drop = await call(db, 'revise_transcript', { session_id: P1, exchanges: [ex(1), ex(2), ex(3)], reason: 'dropping the closing exchange', source: 'test' }, minutesAfter(CLOSED_AT, 3));
    assert.ok(drop.isError && /exchange 4 is missing/.test(text(drop)), text(drop).slice(0, 300));
    const fix = await call(db, 'revise_transcript', { session_id: P1, exchanges: [ex(1), ex(2), ex(3), ex(4, 'corrected')], reason: 'closing exchange text corrected', source: 'test' }, minutesAfter(CLOSED_AT, 3));
    assert.ok(!fix.isError, text(fix).slice(0, 300));
    const before = snapshot(db);
    const r = await call(db, 'emet_transcript_append', { session_id: P1, exchange_index: 4, ...msg }, minutesAfter(CLOSED_AT, 4));
    assert.strictEqual(snapshot(db), before, 'the retry wrote after the correction');
    assert.ok(retried(r), text(r).slice(0, 300));
    // Even where a part already lacks the closing exchange (e.g. a revision made on an earlier draft), a retry writes nothing.
    const db2 = await afterClosing();
    db2.transcripts[0].exchanges = db2.transcripts[0].exchanges.filter((e) => e.exchange_index !== 4);
    const before2 = snapshot(db2);
    const r2 = await call(db2, 'emet_transcript_append', { session_id: P1, exchange_index: 4, ...msg }, minutesAfter(CLOSED_AT, 4));
    assert.strictEqual(snapshot(db2), before2, 'a retry re-added a dropped exchange');
    assert.ok(retried(r2), text(r2).slice(0, 300));
  });

  // --- boundaries ---------------------------------------------------------------------
  test('the 5:00 boundary: accepted at exactly 5:00 after the recorded close, refused 1 ms later', async () => {
    const at = await call(closedWorld(), 'emet_transcript_append', { session_id: P1, ...msg }, new Date(CLOSED_AT.getTime() + 5 * 60000));
    assert.ok(!at.isError && dataOf(at).closing_exchange.accepted, text(at).slice(0, 300));
    const db = closedWorld();
    const late = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, new Date(CLOSED_AT.getTime() + 5 * 60000 + 1));
    assert.ok(late.isError && /5-minute window/.test(text(late)), text(late).slice(0, 300));
    assert.deepStrictEqual(liveIdx(db), [1, 2, 3]);
  });
  test('exact midnight in New York: 00:00:00.000 ET is the new day, 1 ms before is the old day (ids and session_open)', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const midnight = new Date('2026-10-01T04:00:00.000Z'); // 00:00 EDT on 10/1
    const before = new Date(midnight.getTime() - 1);
    assert.strictEqual(sessionBaseId(midnight, 'm'), '2026-10-01_m');
    assert.strictEqual(sessionBaseId(before, 'm'), '2026-09-30_m');
    assert.strictEqual((await sessionOpen({ slug: 'm' }, null, fakeSessions(), midnight)).base, '2026-10-01_m');
    assert.strictEqual((await sessionOpen({ slug: 'm' }, null, fakeSessions(), before)).base, '2026-09-30_m');
  });

  // --- a real cycle, through the door -------------------------------------------------
  test('a real close-and-reopen cycle through dispatchTool: open, append, close recorded, one closing exchange, locked, reopen as -2', async () => {
    const { dispatchTool } = await import('../src/dispatch.js');
    const sg = await import('../src/session-graph.js');
    const db = fakeSessions();
    const T = new Date(); // the wall clock: the close is recorded at the real time, as in production
    const go = (tool, args, now = new Date()) => withStore(db, () => dispatchTool(tool, args, { dbManager: db, logger: null, now }));
    const opened = await go('emet_session_open', { slug: 'cycle', load_id: await fullStartup() }, T);
    const sid = dataOf(opened).session_id; const base = dataOf(opened).base;
    await until(() => db.rows.get(base)?.opened === true, 'cycle session opened');
    const beforeAppend = db.writes.length;
    const a1 = await go('emet_transcript_append', { session_id: sid, user_message: 'hi', assistant_message: 'no local shell MCP. hello', source: 'test' });
    assert.ok(!a1.isError, text(a1).slice(0, 300));
    const a2 = await go('emet_transcript_append', { session_id: sid, user_message: 'bye', assistant_message: 'closing', source: 'test' });
    assert.ok(!a2.isError, text(a2).slice(0, 300));
    // An append does not record a session step, so it cannot open a board-editing session.
    assert.strictEqual(db.writes.length, beforeAppend, 'an append does not record a session step');
    // The close: the same step dispatch records after emet_session_close returns complete (awaited there).
    await sg.graphAfter('emet_session_close', { session_id: sid }, { state: 'complete' }, db, null);
    assert.strictEqual(db.rows.get(base).closed, true);
    const closing = await go('emet_transcript_append', { session_id: sid, user_message: 'thanks', assistant_message: 'closed', source: 'test' });
    assert.ok(!closing.isError && dataOf(closing).closing_exchange.accepted && dataOf(closing).exchange_index === 3, text(closing).slice(0, 300));
    assert.ok(!/open a new session/i.test(dataOf(closing).session_graph.next) && /do not open a session just for it/.test(dataOf(closing).session_graph.next), dataOf(closing).session_graph.next);
    const late = await go('emet_transcript_append', { session_id: sid, user_message: 'one more', assistant_message: 'x', source: 'test' });
    assert.ok(late.isError && /closed and locked/.test(text(late)), text(late).slice(0, 300));
    const reopened = await go('emet_session_open', { slug: 'cycle', load_id: await fullStartup() }, T);
    assert.strictEqual(dataOf(reopened).base, `${base}-2`);
    assert.ok(/already closed/.test(dataOf(reopened).notice), dataOf(reopened).notice);
    const b1 = await go('emet_transcript_append', { session_id: dataOf(reopened).session_id, user_message: 'hi again', assistant_message: 'no local shell MCP. hello', source: 'test' });
    assert.ok(!b1.isError && dataOf(b1).exchange_index === 1, text(b1).slice(0, 300));
    assert.deepStrictEqual(db.transcripts.find((d) => d.session_id === sid).exchanges.map((e) => e.exchange_index), [1, 2, 3]);
  });

  // --- the second reader's nits 1, 4, 7 -------------------------------------------------------------
  test('monorail wording: the closed gate and next step say "closed and locked" and never "open a new session"', async () => {
    const { evaluate, nextStep } = await import('../src/session-graph.js');
    const next = nextStep({ opened: true, closed: true }, 4);
    assert.ok(/closed and locked/.test(next) && /opened the usual way/.test(next) && !/open a new session/i.test(next), next);
    const d = evaluate('patch_doc', { session_id: P1, doc_id: 'STATE.md' }, { opened: true, closed: true }, 4);
    assert.ok(/closed and locked/.test(d.reason) && /nothing was written/.test(d.reason) && /next session you open the usual way/.test(d.reason) && !/open a new session/i.test(d.reason), d.reason);
    const enforced = await call(closedWorld(), 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 60));
    assert.ok(enforced.isError && !/open a new session/i.test(text(enforced)), text(enforced).slice(0, 300));
  });
  test('EMET_CLOSE_GRACE_MINUTES is checked: negative or non-numeric falls back to 5 with a note, over 60 is capped at 60, and the guard logs it once', async () => {
    const { closeGraceSetting, closeGraceMinutes } = await import('../src/session-graph.js');
    for (const v of ['-1', 'abc', 'NaN', 'Infinity']) {
      const s = closeGraceSetting(v);
      assert.strictEqual(s.minutes, 5, v); assert.ok(/default 5 is used/.test(s.note || ''), `${v}: ${s.note}`);
    }
    for (const v of ['61', '1e9']) {
      const s = closeGraceSetting(v);
      assert.strictEqual(s.minutes, 60, v); assert.ok(/cap/.test(s.note || ''), `${v}: ${s.note}`);
    }
    assert.deepStrictEqual(closeGraceSetting(' 7 '), { minutes: 7, note: null });
    assert.deepStrictEqual(closeGraceSetting('0'), { minutes: 0, note: null });
    assert.deepStrictEqual(closeGraceSetting('60'), { minutes: 60, note: null });
    assert.strictEqual(closeGraceMinutes(undefined), 5);
    const warned = [];
    const logger = { warn: (m) => warned.push(m), info() {}, error() {} };
    const db = closedWorld();
    const r = await withEnv('EMET_CLOSE_GRACE_MINUTES', '-3', () => withStore(db, async () => {
      const { dispatchTool } = await import('../src/dispatch.js');
      await dispatchTool('emet_transcript_append', { session_id: P1, ...msg }, { dbManager: db, logger, now: minutesAfter(CLOSED_AT, 6) });
      return dispatchTool('emet_transcript_append', { session_id: P1, ...msg }, { dbManager: db, logger, now: minutesAfter(CLOSED_AT, 6) });
    }));
    assert.ok(r.isError && /5-minute window/.test(text(r)), text(r).slice(0, 300));
    assert.strictEqual(warned.filter((m) => /EMET_CLOSE_GRACE_MINUTES="-3"/.test(m)).length, 1, JSON.stringify(warned));
  });
  test('when the closed-session guard refuses, the lab row says refuse, gate closed', async () => {
    const db = closedWorld();
    const r = await call(db, 'emet_transcript_append', { session_id: P1, ...msg }, minutesAfter(CLOSED_AT, 60));
    assert.ok(r.isError, text(r).slice(0, 300));
    await until(() => db.labs.some((x) => x.tool === 'emet_transcript_append' && x.gate === 'closed'), 'lab row for the closed gate');
    const row = db.labs.find((x) => x.tool === 'emet_transcript_append');
    assert.ok(row, 'no lab row');
    assert.strictEqual(row.mode, 'enforce');
    assert.strictEqual(row.verdict, 'refuse');
    assert.strictEqual(row.gate, 'closed');
  });
  test('the close step records the injected clock as closed_at (so the window runs from the recorded close)', async () => {
    const sg = await import('../src/session-graph.js');
    const db = fakeSessions();
    await sg.graphAfter('emet_session_close', { session_id: P1 }, { state: 'complete' }, db, null, CLOSED_AT);
    assert.strictEqual(db.rows.get(CLOSED).closed, true);
    assert.strictEqual(new Date(db.rows.get(CLOSED).closed_at).getTime(), CLOSED_AT.getTime());
  });
});

testGroup('session_open with no off switch; EMET_ names first', () => {
  test('EMET_SESSION_GRAPH=off is no longer read: emet_session_open still checks the session store, fails safe on an outage, and says to call again', async () => {
    const { sessionOpen } = await import('../src/tools.js');
    const { dispatchTool } = await import('../src/dispatch.js');
    const db = fakeSessions();
    let reads = 0;
    db.ensureClient = async () => { reads++; throw new Error('store down'); };
    await assert.rejects(() => withEnv('EMET_SESSION_GRAPH', 'off', () => sessionOpen({ slug: 'offline' }, null, db, EVENING)),
      (e) => /no session was opened/.test(e.message) && /Call emet_session_open again/.test(e.message));
    assert.ok(reads > 0, 'the session store was not read');
    const loadId = await fullStartup();
    const d = await withEnv('EMET_SESSION_GRAPH', 'off', () => dispatchTool('emet_session_open', { slug: 'offline', load_id: loadId }, { dbManager: db, logger: null, now: EVENING }));
    assert.ok(d.isError && /no session was opened/.test(JSON.stringify(d)), JSON.stringify(d).slice(0, 300));
  });
  test('EMET_CLOSE_GRACE_MINUTES and EMET_TIMEZONE: the legacy CASCADE_ name still resolves, and EMET_ wins when both are set', async () => {
    const { closeGraceMinutes, closeGraceSetting } = await import('../src/session-graph.js');
    const { sessionTimeZone } = await import('../src/transcript-session.js');
    await withEnv('EMET_CLOSE_GRACE_MINUTES', undefined, () => withEnv('CASCADE_CLOSE_GRACE_MINUTES', '9', async () => {
      assert.strictEqual(closeGraceMinutes(), 9);
      const note = closeGraceSetting('-1').note || ''; // a bad legacy value is named as the legacy name
      assert.ok(/^CASCADE_CLOSE_GRACE_MINUTES \(deprecated; use EMET_CLOSE_GRACE_MINUTES\)=/.test(note), note);
      await withEnv('EMET_CLOSE_GRACE_MINUTES', '3', () => assert.strictEqual(closeGraceMinutes(), 3));
    }));
    await withEnv('EMET_TIMEZONE', undefined, () => withEnv('CASCADE_TIMEZONE', 'UTC', async () => {
      assert.strictEqual(sessionTimeZone().zone, 'UTC');
      await withEnv('EMET_TIMEZONE', 'America/Chicago', () => assert.strictEqual(sessionTimeZone().zone, 'America/Chicago'));
    }));
    assert.strictEqual(closeGraceMinutes(), 5);
  });
});

summary('Transcript Session Test Summary');
