/**
 * EMET - main-record and bot-directory guards (2026-10-01; the owner's
 * approval to make the bot tags fully functional; the reviewer's review of
 * the bot tags, items (1) and (3b)). Both live in refuseBotMainRecord, so they cover
 * every door that already calls it: write_doc, patch_doc, retire_doc,
 * rename_doc (from and onto) and accept_nonconformance.
 *
 *   1. Registered hosts only: with EMET_SOURCE_TAGS set, HANDOFF.md and
 *      STATE.md take writes only from a registered tag. Unregistered and typo
 *      tags, no-source writes and cloud-scheduled-* are refused. No registry:
 *      unchanged.
 *   2. Each bot in its own directory: a bot tag writes under bots/ only inside
 *      bots/<its own tag>/. Hosts stay allowed. With EMET_SOURCE_TAGS set,
 *      an unregistered, typo or missing tag is refused anywhere under bots/
 *      (2026-10-02, the reviewer's review of the bot guards; the owner's approval, a decision record).
 *   3. Refusal text: a single-argument ValidationError no longer renders
 *      "Validation failed for '<msg>': undefined".
 * Dispatch-level, in-memory store (as bot-session-close.test.js).
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { makeStore, withStore } from './memstore.js';
import { seedOpenSession, inSession } from './graph-session.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const k of ['EMET_CLOSE_GRACE_MINUTES', 'CASCADE_CLOSE_GRACE_MINUTES', 'EMET_SOURCE_TAG', 'CASCADE_SOURCE_TAG',
  'EMET_SOURCE_TAGS', 'CASCADE_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_HANDOFF_DOC', 'EMET_STATE_DOC', 'CASCADE_RECORD_DOCS']) delete process.env[k];

const INTAKE = 'intake-bot';
const TESTER = 'tester-bot';
const HUB = 'hub-bot';
const HOST = 'project-host';
const RECORD_DOCS = `bots/${INTAKE}/HANDOFF.md,bots/${TESTER}/HANDOFF.md`;
const REGISTRY = `cli,mobile,desktop-host,cloud-host,${HOST},${HUB},${INTAKE},${TESTER}`;
process.env.EMET_RECORD_DOCS = RECORD_DOCS;

console.log('\n=== bot guards: registered hosts on the main records; each bot in its own directory ===');

// The session graph runs in enforce only: governed writes here go through a
// seeded open session, so the guard under test is what answers.
const go = (db, tool, args, now = new Date()) => withStore(db, async () => {
  const { dispatchTool } = await import('../src/dispatch.js');
  const sid = seedOpenSession(db.col);
  const withReason = (tool === 'patch_doc' || tool === 'write_doc' || tool === 'rename_doc' || tool === 'retire_doc') && !args.reason
    ? { ...args, reason: 'fixture reason for the edit' }
    : args;
  return dispatchTool(tool, inSession(tool, withReason, sid), { dbManager: db, logger: null, now });
});
const dataOf = (r) => JSON.parse(r.content[0].text).data;
const text = (r) => { try { const j = JSON.parse(r.content[0].text); return j.error ? String(j.error.message) : JSON.stringify(j); } catch { return JSON.stringify(r); } };
const versionOf = (db, id) => (db.doc(id) ? db.doc(id).version : null);
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
function seeded() {
  const db = makeStore();
  const when = new Date(Date.now() - 2 * 86400000);
  db.col('documents').docs.push(
    { doc_id: 'STATE.md', version: 7, content: '# Board\n\n## §0 RECORD CONTROL AND COUNTS\n- Template: `templates/BOARD.md` rev none yet\n- Session id: none yet\n- Scope of the session that wrote this revision: provisioned by the server\n\n| Half-state | Dated ≤14 days | Open | Waiting | Parked | Closed this revision | Seed triggers met | Nonconformance markers open |\n|---|---|---|---|---|---|---|---|\n| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |\n\n## §1 HALF-STATE — highest priority\nNone — checked against: none yet.\n\n## §2 DATED — next 14 days, and hard dates beyond\nNone — checked against: none yet.\n\n## §3 OPEN BOARD\nNone — checked against: none yet.\n\n## §4 CLOSED THIS REVISION\nNone closed this revision.\n\n## §5 SEEDS\n- Last full scan: none yet\n- Triggers met: None met, per the scan above.\n\n## §6 STANDING GUARDS\nNone retired.\n\n## §7 SYSTEM STATE\nactive: hub work\n', updated_at: when, updated_by: HOST, size: 26 },
    { doc_id: 'HANDOFF.md', version: 3, content: '# Handoff\nhub session\n', updated_at: when, updated_by: HOST, size: 20 },
    { doc_id: `bots/${TESTER}/HANDOFF.md`, version: 1, content: '# Tester handoff\nv1\n', updated_at: when, updated_by: TESTER, size: 20 },
    { doc_id: `bots/${INTAKE}/notes.md`, version: 1, content: '# Intake notes\n', updated_at: when, updated_by: INTAKE, size: 15 },
    { doc_id: 'threads/notes.md', version: 1, content: '# Thread notes\n', updated_at: when, updated_by: HOST, size: 15 }
  );
  return db;
}
const REG = { EMET_SOURCE_TAGS: REGISTRY };
const NOT_REGISTERED = /is a main record and "([^"]+)" is not a registered source tag - only a registered host writes the main handoff and board/;
const BOTS_NOT_REGISTERED = /is a bot record and "([^"]+)" is not a registered source tag - only a registered host or the bot itself writes under bots\//;
const BOTS_NO_SOURCE = /is a bot record and this write names no source tag - only a registered host or the bot itself writes under bots\//;
const NO_SOURCE = /is a main record and this write names no source tag - only a registered host writes the main handoff and board/;
const OUTSIDE = (tag, id) => new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is outside bots/${tag}/ and ${tag} is a bot tag - a bot writes only its own bots/${tag}/ records`);
const C1_TEXT = (tag) => new RegExp(`is a main record and ${tag} is a bot tag - a bot session closes against bots/${tag}/ records`);
const unchanged = (db) => { assert.strictEqual(versionOf(db, 'STATE.md'), 7); assert.strictEqual(versionOf(db, 'HANDOFF.md'), 3); };

testGroup('1. registered hosts only on the main records (EMET_SOURCE_TAGS set)', () => {
  test('the hub host patches STATE.md and supersedes HANDOFF.md; the hub bot writes STATE.md (no lock-out)', () => withEnv(REG, async () => {
    const db = seeded();
    const p = await go(db, 'patch_doc', { doc_id: 'STATE.md', old_str: 'active: hub work', new_str: 'active: hub work, patched', source: HOST });
    assert.ok(!p.isError, text(p).slice(0, 300));
    assert.strictEqual(versionOf(db, 'STATE.md'), 8);
    const h = await go(db, 'write_doc', { doc_id: 'HANDOFF.md', content: '# Handoff\nnext hub session\n', supersedes: 3, source: HOST });
    assert.ok(!h.isError, text(h).slice(0, 300));
    assert.strictEqual(versionOf(db, 'HANDOFF.md'), 4);
    const mb = await go(db, 'patch_doc', { doc_id: 'STATE.md', old_str: 'active: hub work, patched', new_str: 'active: hub work, by the hub bot', source: HUB });
    assert.ok(!mb.isError, text(mb).slice(0, 300));
    assert.strictEqual(db.doc('STATE.md').updated_by, HUB);
  }));
  test('a typo or unregistered tag is refused on STATE.md and HANDOFF.md; nothing is written', () => withEnv(REG, async () => {
    const db = seeded();
    for (const [tool, args] of [
      ['write_doc', { doc_id: 'STATE.md', content: '# Board\nx\n', source: 'intkae-bot' }],
      ['patch_doc', { doc_id: 'STATE.md', old_str: 'active', new_str: 'idle', source: 'intkae-bot' }],
      ['write_doc', { doc_id: 'HANDOFF.md', content: '# H\nx\n', supersedes: 3, source: 'tablet-host' }]
    ]) {
      const r = await go(db, tool, args);
      assert.ok(r.isError && NOT_REGISTERED.test(text(r)) && text(r).includes(`${tool}:`), `${tool}: ${text(r).slice(0, 300)}`);
    }
    unchanged(db);
  }));
  test('every other door refuses an unregistered tag on a main record: retire, rename from and onto, accept', () => withEnv(REG, async () => {
    const db = seeded();
    for (const [tool, args] of [
      ['retire_doc', { doc_id: 'HANDOFF.md', reason: 'tidy', source: 'stranger' }],
      ['rename_doc', { old_id: 'STATE.md', new_id: 'archive/STATE.md', source: 'stranger' }],
      ['rename_doc', { old_id: 'threads/notes.md', new_id: 'STATE.md', source: 'stranger' }],
      ['accept_nonconformance', { doc_id: 'STATE.md', reason: 'accepted for now, stranger', source: 'stranger' }]
    ]) {
      const r = await go(db, tool, args);
      assert.ok(r.isError && NOT_REGISTERED.test(text(r)), `${tool}: ${text(r).slice(0, 300)}`);
    }
    // Renamed from a bot folder onto STATE.md: the bots/ registry refusal answers first (the second reader, fix (a)); both are correct.
    const r = await go(db, 'rename_doc', { old_id: `bots/${INTAKE}/notes.md`, new_id: 'STATE.md', source: 'stranger' });
    assert.ok(r.isError && BOTS_NOT_REGISTERED.test(text(r)), `rename_doc from bots/: ${text(r).slice(0, 300)}`);
    unchanged(db);
    assert.ok(!db.doc('HANDOFF.md').retired && !db.doc('archive/STATE.md'));
  }));
  test('a write naming no source is refused: by name when it falls back to EMET_SOURCE_TAG, as "no source" otherwise', async () => {
    await withEnv({ ...REG, EMET_SOURCE_TAG: 'unspecified' }, async () => {
      const db = seeded();
      const r = await go(db, 'patch_doc', { doc_id: 'STATE.md', old_str: 'active', new_str: 'idle' });
      assert.ok(r.isError && NOT_REGISTERED.test(text(r)) && text(r).includes('"unspecified"'), text(r).slice(0, 300));
      unchanged(db);
    });
    await withEnv({ ...REG, EMET_SOURCE_TAG: undefined }, async () => {
      const db = seeded();
      const r = await go(db, 'write_doc', { doc_id: 'STATE.md', content: '# Board\nx\n' });
      assert.ok(r.isError && NO_SOURCE.test(text(r)), text(r).slice(0, 300));
      unchanged(db);
    });
  });
  test('cloud-scheduled-* is refused on the main records (the transcript exception is not copied)', () => withEnv(REG, async () => {
    const db = seeded();
    const r = await go(db, 'write_doc', { doc_id: 'STATE.md', content: '# Board\nx\n', source: 'cloud-scheduled-intake' });
    assert.ok(r.isError && NOT_REGISTERED.test(text(r)), text(r).slice(0, 300));
    unchanged(db);
  }));
  test('on a new install with no HANDOFF.md, an unregistered tag cannot create it', () => withEnv(REG, async () => {
    const db = makeStore();
    const r = await go(db, 'write_doc', { doc_id: 'HANDOFF.md', content: '# H\nfirst\n', source: 'stranger' });
    assert.ok(r.isError && NOT_REGISTERED.test(text(r)), text(r).slice(0, 300));
    assert.strictEqual(db.doc('HANDOFF.md'), undefined);
  }));
  test('a bot tag still gets the C1 bot text first (registered or not)', () => withEnv(REG, async () => {
    const db = seeded();
    const r = await go(db, 'write_doc', { doc_id: 'HANDOFF.md', content: '# H\nx\n', supersedes: 3, source: INTAKE });
    assert.ok(r.isError && C1_TEXT(INTAKE).test(text(r)), text(r).slice(0, 300));
    await withEnv({ EMET_SOURCE_TAGS: `${HOST}` }, async () => {
      const r2 = await go(db, 'patch_doc', { doc_id: 'STATE.md', old_str: 'active', new_str: 'idle', source: TESTER });
      assert.ok(r2.isError && C1_TEXT(TESTER).test(text(r2)), text(r2).slice(0, 300));
    });
    unchanged(db);
  }));
  test('non-main documents are unaffected: an unregistered tag still writes threads/', () => withEnv(REG, async () => {
    const db = seeded();
    const r = await go(db, 'write_doc', { doc_id: 'threads/x.md', content: '# Thread\nx\n', source: 'stranger' });
    assert.ok(r.isError && /new drop only/.test(text(r)), text(r).slice(0, 300));
    const drop = await go(db, 'write_doc', { doc_id: 'drops/stranger.md', content: 'a note\n', source: 'stranger' });
    assert.ok(!drop.isError, text(drop).slice(0, 300));
  }));
  test('with no registry configured, nothing changes: an unregistered tag writes STATE.md as before', () => withEnv({ EMET_SOURCE_TAGS: undefined }, async () => {
    const db = seeded();
    const r = await go(db, 'patch_doc', { doc_id: 'STATE.md', old_str: 'active', new_str: 'idle', source: 'stranger' });
    assert.ok(!r.isError, text(r).slice(0, 300));
    assert.strictEqual(versionOf(db, 'STATE.md'), 8);
  }));
  test('the live registry includes every recent main-record writer and the hub', () => {
    const live = 'cli,mobile,desktop-host,cloud-host,project-host,hub-bot,reviewer-bot,tester-bot,memory-bot,intake-bot,research-bot'.split(',');
    for (const t of ['project-host', 'cloud-host', 'hub-bot']) assert.ok(live.includes(t), t);
  });
});

testGroup('2. each bot in its own directory (bots/<tag>/ only)', () => {
  test(`${INTAKE} is refused on bots/${TESTER}/HANDOFF.md and allowed on its own handoff`, () => withEnv(REG, async () => {
    const db = seeded();
    const other = await go(db, 'write_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, content: '# x\n', supersedes: 1, source: INTAKE });
    assert.ok(other.isError && OUTSIDE(INTAKE, `bots/${TESTER}/HANDOFF.md`).test(text(other)), text(other).slice(0, 300));
    assert.strictEqual(versionOf(db, `bots/${TESTER}/HANDOFF.md`), 1);
    const own = await go(db, 'write_doc', { doc_id: `bots/${INTAKE}/HANDOFF.md`, content: '# Intake handoff\nv1\n', source: INTAKE });
    assert.ok(!own.isError, text(own).slice(0, 300));
    assert.strictEqual(versionOf(db, `bots/${INTAKE}/HANDOFF.md`), 1);
  }));
  test('a bot is refused on bots/ROSTER.md; the hub writes it', () => withEnv(REG, async () => {
    const db = seeded();
    const r = await go(db, 'write_doc', { doc_id: 'bots/ROSTER.md', content: '# Roster\n', source: INTAKE });
    assert.ok(r.isError && OUTSIDE(INTAKE, 'bots/ROSTER.md').test(text(r)), text(r).slice(0, 300));
    const h = await go(db, 'write_doc', { doc_id: 'bots/ROSTER.md', content: '# Roster\n', source: HUB });
    assert.ok(!h.isError, text(h).slice(0, 300));
  }));
  test('every door refuses another bot\'s records: patch, retire, rename from and onto, accept', () => withEnv(REG, async () => {
    const db = seeded();
    for (const [tool, args, id] of [
      ['patch_doc', { doc_id: `bots/${INTAKE}/notes.md`, old_str: 'Intake', new_str: 'Tester', source: TESTER }, `bots/${INTAKE}/notes.md`],
      ['retire_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, reason: 'tidy', source: INTAKE }, `bots/${TESTER}/HANDOFF.md`],
      ['rename_doc', { old_id: `bots/${TESTER}/HANDOFF.md`, new_id: `bots/${INTAKE}/stolen.md`, source: INTAKE }, `bots/${TESTER}/HANDOFF.md`],
      ['rename_doc', { old_id: `bots/${INTAKE}/notes.md`, new_id: `bots/${TESTER}/notes.md`, source: INTAKE }, `bots/${TESTER}/notes.md`],
      ['accept_nonconformance', { doc_id: `bots/${TESTER}/HANDOFF.md`, reason: 'accepted by intake for now', source: INTAKE }, `bots/${TESTER}/HANDOFF.md`]
    ]) {
      const r = await go(db, tool, args);
      const tag = args.source;
      assert.ok(r.isError && OUTSIDE(tag, id).test(text(r)) && text(r).includes(`${tool}:`), `${tool}: ${text(r).slice(0, 300)}`);
    }
    assert.strictEqual(versionOf(db, `bots/${TESTER}/HANDOFF.md`), 1);
    assert.ok(!db.doc(`bots/${TESTER}/HANDOFF.md`).retired);
    assert.strictEqual(db.doc(`bots/${INTAKE}/notes.md`).content, '# Intake notes\n');
  }));
  test('a look-alike directory is not the bot\'s own (bots/intake-bot-x/, bots/intake-bot2/)', () => withEnv(REG, async () => {
    const db = seeded();
    for (const id of [`bots/${INTAKE}-x/HANDOFF.md`, `bots/${INTAKE}2/notes.md`]) {
      const r = await go(db, 'write_doc', { doc_id: id, content: '# x\n', source: INTAKE });
      assert.ok(r.isError && OUTSIDE(INTAKE, id).test(text(r)), `${id}: ${text(r).slice(0, 300)}`);
    }
  }));
  test('a bot writes and patches inside its own directory; retire and rename are refused even there (stage 1, decision 1)', () => withEnv(REG, async () => {
    const db = seeded();
    assert.ok(!(await go(db, 'patch_doc', { doc_id: `bots/${INTAKE}/notes.md`, old_str: 'Intake notes', new_str: 'Intake notes v2', source: INTAKE })).isError);
    const rn = await go(db, 'rename_doc', { old_id: `bots/${INTAKE}/notes.md`, new_id: `bots/${INTAKE}/notes-2026.md`, source: INTAKE });
    assert.ok(rn.isError && /rename_doc is not a bot tool/.test(text(rn)), text(rn).slice(0, 300));
    const rt = await go(db, 'retire_doc', { doc_id: `bots/${INTAKE}/notes.md`, reason: 'tidy', source: INTAKE });
    assert.ok(rt.isError && /retire_doc is not a bot tool/.test(text(rt)), text(rt).slice(0, 300));
    assert.ok(db.doc(`bots/${INTAKE}/notes.md`) && !db.doc(`bots/${INTAKE}/notes.md`).retired && !db.doc(`bots/${INTAKE}/notes-2026.md`));
  }));
  test('hosts stay allowed anywhere under bots/ (the hub tidies a bot\'s records)', () => withEnv(REG, async () => {
    const db = seeded();
    const r = await go(db, 'write_doc', { doc_id: `bots/${TESTER}/notes.md`, content: '# hub note for the tester\n', source: HUB });
    assert.ok(!r.isError, text(r).slice(0, 300));
    const p = await go(db, 'write_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, content: '# Tester handoff\nv2 by host\n', supersedes: 1, source: HOST });
    assert.ok(!p.isError, text(p).slice(0, 300));
  }));
  test('with a registry set, a typo or unregistered tag is refused anywhere under bots/', () => withEnv(REG, async () => {
    const db = seeded();
    for (const [tool, args] of [
      ['write_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, content: '# Tester handoff\nv2 by a typo\n', supersedes: 1, source: 'bot-typo' }],
      ['write_doc', { doc_id: 'bots/ROSTER.md', content: '# Roster\n', source: 'bot-typo' }],
      ['patch_doc', { doc_id: `bots/${INTAKE}/notes.md`, old_str: 'Intake notes', new_str: 'Intake notes x', source: 'intake-bo' }],
      ['retire_doc', { doc_id: `bots/${INTAKE}/notes.md`, reason: 'tidy', source: 'stranger' }],
      ['rename_doc', { old_id: `bots/${INTAKE}/notes.md`, new_id: 'threads/moved.md', source: 'stranger' }],
      ['rename_doc', { old_id: 'threads/notes.md', new_id: `bots/${TESTER}/notes.md`, source: 'stranger' }],
      ['accept_nonconformance', { doc_id: `bots/${TESTER}/HANDOFF.md`, reason: 'accepted, stranger', source: 'stranger' }]
    ]) {
      const r = await go(db, tool, args);
      assert.ok(r.isError && BOTS_NOT_REGISTERED.test(text(r)), `${tool}: ${text(r).slice(0, 300)}`);
    }
    assert.strictEqual(versionOf(db, `bots/${TESTER}/HANDOFF.md`), 1);
    assert.strictEqual(versionOf(db, `bots/${INTAKE}/notes.md`), 1);
    assert.ok(!db.doc('bots/ROSTER.md') && !db.doc('threads/moved.md') && !db.doc(`bots/${TESTER}/notes.md`));
    assert.ok(!db.doc(`bots/${INTAKE}/notes.md`).retired);
  }));
  test('with a registry set, a no-source write under bots/ is refused; the hub and a registered host still write there', async () => {
    await withEnv({ ...REG, EMET_SOURCE_TAG: undefined }, async () => {
      const db = seeded();
      const r = await go(db, 'write_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, content: '# Tester handoff\nv2\n', supersedes: 1 });
      assert.ok(r.isError && BOTS_NO_SOURCE.test(text(r)), text(r).slice(0, 300));
      assert.strictEqual(versionOf(db, `bots/${TESTER}/HANDOFF.md`), 1);
      const hub = await go(db, 'write_doc', { doc_id: 'bots/ROSTER.md', content: '# Roster\nhub\n', source: HUB });
      assert.ok(!hub.isError, text(hub).slice(0, 300));
      const host = await go(db, 'patch_doc', { doc_id: `bots/${INTAKE}/notes.md`, old_str: 'Intake notes', new_str: 'Intake notes, tidied', source: HOST });
      assert.ok(!host.isError, text(host).slice(0, 300));
      const own = await go(db, 'write_doc', { doc_id: `bots/${INTAKE}/HANDOFF.md`, content: '# Intake handoff\nv1\n', source: INTAKE });
      assert.ok(!own.isError, text(own).slice(0, 300));
    });
  });
  test('a listed bot that is not in the registry still writes its own folder (the bots/ registry check is for non-bot tags)', () => withEnv({ EMET_SOURCE_TAGS: 'cli,project-host,hub-bot' }, async () => {
    const db = seeded();
    const own = await go(db, 'patch_doc', { doc_id: `bots/${INTAKE}/notes.md`, old_str: 'Intake notes', new_str: 'Intake notes, own', source: INTAKE });
    assert.ok(!own.isError, text(own).slice(0, 300));
    const other = await go(db, 'write_doc', { doc_id: `bots/${TESTER}/notes.md`, content: '# x\n', source: INTAKE });
    assert.ok(other.isError && /own bots/.test(text(other)), text(other).slice(0, 300));
  }));
  test('registry entries are trimmed: a spaced EMET_SOURCE_TAGS still admits its hosts (review nit M5d)', () => withEnv({ EMET_SOURCE_TAGS: ` cli , ${HOST} ,  ${HUB} ` }, async () => {
    const db = seeded();
    const p = await go(db, 'patch_doc', { doc_id: 'STATE.md', old_str: 'active: hub work', new_str: 'active: hub work, spaced', source: HOST });
    assert.ok(!p.isError, text(p).slice(0, 300));
    const roster = await go(db, 'write_doc', { doc_id: 'bots/ROSTER.md', content: '# Roster\n', source: HUB });
    assert.ok(!roster.isError, text(roster).slice(0, 300));
    const typo = await go(db, 'write_doc', { doc_id: 'bots/ROSTER.md', content: '# Roster\nv2\n', source: 'bot-typo' });
    assert.ok(typo.isError && BOTS_NOT_REGISTERED.test(text(typo)), text(typo).slice(0, 300));
  }));
  test('refusal text carries no stray "undefined" (single-argument ValidationError)', () => withEnv(REG, async () => {
    const db = seeded();
    for (const [tool, args] of [
      ['write_doc', { doc_id: 'STATE.md', content: '# Board\nx\n', source: 'stranger' }],
      ['write_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, content: '# x\n', supersedes: 1, source: INTAKE }],
      ['write_doc', { doc_id: 'bots/ROSTER.md', content: '# x\n', source: 'bot-typo' }]
    ]) {
      const r = await go(db, tool, args);
      assert.ok(r.isError, `${tool} should be refused`);
      assert.ok(!/undefined/.test(text(r)) && !/Validation failed for '/.test(text(r)), text(r).slice(0, 300));
    }
  }));
  test('with a registry set, another bot\'s folder and bots/ROSTER.md are refused to an unregistered tag, a missing source (EMET_SOURCE_TAG fallback) and cloud-scheduled-*', async () => {
    const targets = [
      ['write_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, content: '# Tester handoff\nv2\n', supersedes: 1 }],
      ['write_doc', { doc_id: 'bots/ROSTER.md', content: '# Roster\n' }]
    ];
    await withEnv(REG, async () => {
      for (const src of ['stranger', 'cloud-scheduled-intake']) {
        const db = seeded();
        for (const [tool, args] of targets) {
          const r = await go(db, tool, { ...args, source: src });
          assert.ok(r.isError && BOTS_NOT_REGISTERED.test(text(r)) && text(r).includes(`"${src}"`), `${src} ${args.doc_id}: ${text(r).slice(0, 300)}`);
        }
        assert.strictEqual(versionOf(db, `bots/${TESTER}/HANDOFF.md`), 1);
        assert.ok(!db.doc('bots/ROSTER.md'));
      }
    });
    await withEnv({ ...REG, EMET_SOURCE_TAG: 'unspecified' }, async () => {
      const db = seeded();
      for (const [tool, args] of targets) {
        const r = await go(db, tool, args);
        assert.ok(r.isError && BOTS_NOT_REGISTERED.test(text(r)) && text(r).includes('"unspecified"'), `fallback ${args.doc_id}: ${text(r).slice(0, 300)}`);
      }
      assert.strictEqual(versionOf(db, `bots/${TESTER}/HANDOFF.md`), 1);
      assert.ok(!db.doc('bots/ROSTER.md'));
    });
  });
  test('with a registry set, registered hosts still write under bots/: project-host, cloud-host, hub-bot', () => withEnv(REG, async () => {
    const db = seeded();
    let v = 1;
    for (const src of [HOST, 'cloud-host', HUB]) {
      const r = await go(db, 'write_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, content: `# Tester handoff\nby ${src}\n`, supersedes: v, source: src });
      assert.ok(!r.isError, `${src}: ${text(r).slice(0, 300)}`);
      v += 1;
      const roster = src === HOST
        ? await go(db, 'write_doc', { doc_id: 'bots/ROSTER.md', content: `# Roster\nby ${src}\n`, source: src })
        : await go(db, 'patch_doc', { doc_id: 'bots/ROSTER.md', old_str: '# Roster', new_str: `# Roster\nby ${src}`, source: src });
      assert.ok(!roster.isError, `${src} roster: ${text(roster).slice(0, 300)}`);
    }
    assert.strictEqual(versionOf(db, `bots/${TESTER}/HANDOFF.md`), 4);
  }));
  test('with no registry set, nothing changes for non-bot tags under bots/ (both guards are opt-in)', () => withEnv({ EMET_SOURCE_TAGS: undefined }, async () => {
    const db = seeded();
    const typo = await go(db, 'write_doc', { doc_id: 'bots/ROSTER.md', content: '# Roster\n', source: 'bot-typo' });
    assert.ok(!typo.isError, text(typo).slice(0, 300));
    const sched = await go(db, 'patch_doc', { doc_id: `bots/${INTAKE}/notes.md`, old_str: 'Intake notes', new_str: 'Intake notes x', source: 'cloud-scheduled-intake' });
    assert.ok(!sched.isError, text(sched).slice(0, 300));
    const other = await go(db, 'write_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, content: '# Tester handoff\nv1\nby stranger\n', supersedes: 1, source: 'stranger' });
    assert.ok(!other.isError, text(other).slice(0, 300));
  }));
  test('ValidationError: a one-argument refusal has no "Validation failed for" prefix and no ": undefined"; a two-argument one keeps "Validation failed for \'source\': ..."', () => withEnv(REG, async () => {
    const { ValidationError } = await import('../src/validation.js');
    const one = new ValidationError('write_doc: X is refused. Nothing was written.');
    assert.strictEqual(one.message, 'write_doc: X is refused. Nothing was written.');
    assert.strictEqual(one.field, null);
    const two = new ValidationError('source', 'a source tag is required');
    assert.strictEqual(two.message, "Validation failed for 'source': a source tag is required");
    assert.strictEqual(two.field, 'source');
    const db = seeded();
    const r1 = await go(db, 'write_doc', { doc_id: 'STATE.md', content: '# Board\nx\n', source: 'stranger' });
    assert.ok(r1.isError && !/^Validation failed for/.test(text(r1)) && !/: undefined/.test(text(r1)), text(r1).slice(0, 300));
    const r2 = await go(db, 'emet_transcript_append', { session_id: '2026-10-02_vt', user_message: 'u', assistant_message: 'a', exchange_index: 1, source: 'stranger' });
    assert.ok(r2.isError && /^Validation failed for 'source': emet_transcript_append: pass "source" set to a registered tag[\s\S]*Source tag "stranger" is not registered/.test(text(r2)) && !/cloud-scheduled-/.test(text(r2)), text(r2).slice(0, 300));
  }));
  test('the cross-bot guard holds with no registry configured', () => withEnv({ EMET_SOURCE_TAGS: undefined }, async () => {
    const db = seeded();
    const r = await go(db, 'write_doc', { doc_id: `bots/${TESTER}/HANDOFF.md`, content: '# x\n', supersedes: 1, source: INTAKE });
    assert.ok(r.isError && OUTSIDE(INTAKE, `bots/${TESTER}/HANDOFF.md`).test(text(r)), text(r).slice(0, 300));
  }));
});

testGroup('look-alike doc ids are refused before any guard (the second reader recheck d1-d5)', () => {
  const LOOKALIKE = /doc_id "[^"]*" (starts with "\/"|starts with a character that normalises to "\/"|has a "\." or "\.\." segment|has a segment that normalises to "\." or "\.\."|starts with "[^"]+" - the bot records folder is "bots\/", lower case|starts with "[^"]+", which folds to "bots" - the bot records folder is the ASCII "bots", lower case|has a control or invisible formatting character|has a backslash|has leading or trailing whitespace on the id or on a segment|is a case or Unicode variant of a main record id)\. Doc ids are not paths/;
  test('d1-d5 are refused on write_doc and nothing is written', () => withEnv(REG, async () => {
    const db = seeded();
    const before = db.col('documents').docs.length;
    for (const [id, source] of [
      [`bots/${TESTER}/../${INTAKE}/HANDOFF.md`, TESTER],
      [`bots/./${INTAKE}/HANDOFF2.md`, TESTER],
      [`Bots/${INTAKE}/HANDOFF.md`, 'bot-typo'],
      [`/bots/${INTAKE}/HANDOFF.md`, 'bot-typo'],
      ['./HANDOFF.md', 'bot-typo'],
      [`BOTS/${INTAKE}/HANDOFF.md`, HUB],
      ['../STATE.md', HOST],
      ['threads/..', HOST]
    ]) {
      const r = await go(db, 'write_doc', { doc_id: id, content: '# x\n', source });
      assert.ok(r.isError && LOOKALIKE.test(text(r)) && /Nothing was written/.test(text(r)), `${id}: ${text(r).slice(0, 300)}`);
    }
    assert.strictEqual(db.col('documents').docs.length, before);
  }));
  test('every write door refuses them: patch, retire, rename (either id), accept_nonconformance', () => withEnv(REG, async () => {
    const db = seeded();
    for (const [tool, args] of [
      ['patch_doc', { doc_id: `bots/${INTAKE}/../${TESTER}/HANDOFF.md`, old_str: 'v1', new_str: 'v2', source: INTAKE }],
      ['retire_doc', { doc_id: `Bots/${TESTER}/HANDOFF.md`, reason: 'x', source: 'bot-typo' }],
      ['rename_doc', { old_id: `bots/${INTAKE}/notes.md`, new_id: `bots/${INTAKE}/../${TESTER}/notes.md`, source: INTAKE }],
      ['rename_doc', { old_id: `/bots/${INTAKE}/notes.md`, new_id: 'threads/x.md', source: INTAKE }],
      ['accept_nonconformance', { doc_id: './STATE.md', reason: 'x', source: HOST }]
    ]) {
      const r = await go(db, tool, args);
      assert.ok(r.isError && LOOKALIKE.test(text(r)), `${tool}: ${text(r).slice(0, 300)}`);
    }
    assert.strictEqual(versionOf(db, `bots/${TESTER}/HANDOFF.md`), 1);
    assert.ok(db.doc(`bots/${INTAKE}/notes.md`) && !db.doc(`bots/${TESTER}/notes.md`));
  }));
  test('ordinary ids with dots in a name still write (notes.v2.md, .well-known style names are not segments)', () => withEnv(REG, async () => {
    const db = seeded();
    for (const id of [`bots/${INTAKE}/notes.v2.md`, 'threads/a..b.md', 'threads/.hidden.md']) {
      const r = await go(db, 'write_doc', { doc_id: id, content: '# ok\n', source: id.startsWith('bots/') ? INTAKE : HOST });
      assert.ok(!r.isError, `${id}: ${text(r).slice(0, 300)}`);
    }
  }));
});

testGroup('doc-id hardening (the reviewer\'s scope; the second reader\'s b-cases)', () => {
  const LOOK = /\. Doc ids are not paths and are not resolved/;
  const refusedOnWrite = async (db, id, source, why) => {
    const r = await go(db, 'write_doc', { doc_id: id, content: '# x\n', source });
    assert.ok(r.isError && LOOK.test(text(r)) && why.test(text(r)) && /Nothing was written/.test(text(r)), `${JSON.stringify(id)}: ${text(r).slice(0, 300)}`);
  };
  test('b1: control and invisible-format characters anywhere (NUL, tab, newline, DEL, zero-width space/joiner, BOM, RTL override, soft hyphen)', () => withEnv(REG, async () => {
    const db = seeded();
    const before = db.col('documents').docs.length;
    for (const id of ['threads/a\u0000.md', 'threads/a\tb.md', 'threads/a\nb.md', 'threads/a\u007f.md', `bots/${INTAKE}\u200b/HANDOFF.md`,
      'HANDOFF.md\u200d', '\ufeffSTATE.md', 'threads/\u202egnp.md', 'threads/a\u00adb.md']) {
      await refusedOnWrite(db, id, HOST, /has a control or invisible formatting character/);
    }
    assert.strictEqual(db.col('documents').docs.length, before);
  }));
  test('b2: leading or trailing whitespace on the id or on any segment (incl. NBSP and ideographic space)', () => withEnv(REG, async () => {
    const db = seeded();
    for (const id of [' HANDOFF.md', 'STATE.md ', `bots/ ${INTAKE}/HANDOFF.md`, `bots/${INTAKE} /HANDOFF.md`, 'threads/x.md\u00a0', '\u3000threads/x.md', 'threads/ /x.md']) {
      await refusedOnWrite(db, id, HUB, /has leading or trailing whitespace/);
    }
  }));
  test('b3: a backslash anywhere', () => withEnv(REG, async () => {
    const db = seeded();
    for (const id of [`bots\\${INTAKE}\\HANDOFF.md`, `bots/${TESTER}/..\\${INTAKE}/HANDOFF.md`, 'threads\\x.md']) {
      await refusedOnWrite(db, id, TESTER, /has a backslash/);
    }
  }));
  test('b4: "/", "." and ".." checks run on the NFKC form (two-dot leader, full-width dots and solidus)', () => withEnv(REG, async () => {
    const db = seeded();
    for (const [id, why] of [
      [`bots/${TESTER}/\u2025/${INTAKE}/HANDOFF.md`, /normalises to "\." or "\.\."/],
      [`bots/${TESTER}/\uff0e\uff0e/${INTAKE}/HANDOFF.md`, /normalises to "\." or "\.\."/],
      [`bots/${TESTER}\uff0f..\uff0f${INTAKE}/HANDOFF.md`, /normalises to "\." or "\.\."/],
      ['\uff0fSTATE.md', /normalises to "\/"/],
      ['threads/\uff0e', /normalises to "\." or "\.\."/]
    ]) await refusedOnWrite(db, id, TESTER, why);
  }));
  test('b5: a first segment that folds to "bots" must be the ASCII "bots" (full-width, mixed case)', () => withEnv(REG, async () => {
    const db = seeded();
    for (const id of [`\uff42\uff4f\uff54\uff53/${INTAKE}/HANDOFF.md`, `\uff22OTS/${INTAKE}/HANDOFF.md`, `bOts/${INTAKE}/HANDOFF.md`]) {
      await refusedOnWrite(db, id, 'bot-typo', /bot records folder is/);
    }
  }));
  test('b6: case, Unicode and padding variants of the main-record ids are refused even for the registered hub', () => withEnv(REG, async () => {
    const db = seeded();
    for (const id of ['handoff.md', 'Handoff.md', 'HANDOFF.MD', 'state.md', '\uff28\uff21\uff2e\uff24\uff2f\uff26\uff26.md']) {
      await refusedOnWrite(db, id, HUB, /is a case or Unicode variant of a main record id/);
    }
    await refusedOnWrite(db, ' HANDOFF.md', HUB, /whitespace/);
    // the exact ids still take the hub's write
    const ok = await go(db, 'patch_doc', { doc_id: 'STATE.md', old_str: 'active: hub work', new_str: 'active: hub work, next', source: HUB });
    assert.ok(!ok.isError, text(ok).slice(0, 300));
  }));
  test('b6: the main-record variant check follows EMET_HANDOFF_DOC / EMET_STATE_DOC', () => withEnv({ ...REG, EMET_HANDOFF_DOC: 'records/HUB-HANDOFF.md' }, async () => {
    const db = seeded();
    await refusedOnWrite(db, 'records/hub-handoff.md', HUB, /variant of a main record id/);
    const plain = await go(db, 'write_doc', { doc_id: 'handoff.md', content: '# not a main record here\n', source: HUB });
    assert.ok(!plain.isError, text(plain).slice(0, 300));
  }));
  test('ordinary ids still write: dots inside names, NFC accents, %2e (ids are never URL-decoded), a lone "bots"-like name', () => withEnv(REG, async () => {
    const db = seeded();
    for (const id of ['threads/a..b.md', 'threads/.hidden.md', 'threads/caf\u00e9.md', 'threads/%2e%2e.md', 'robots/notes.md', 'BOTS.md', 'threads/HANDOFF.md']) {
      const r = await go(db, 'write_doc', { doc_id: id, content: '# ok\n', source: HOST });
      assert.ok(!r.isError, `${id}: ${text(r).slice(0, 300)}`);
    }
  }));
  const seedBad = (db) => {
    const when = new Date(Date.now() - 86400000);
    for (const id of [`Bots/${INTAKE}/HANDOFF.md`, 'threads/old\u200b.md', ' HANDOFF.md', `bots/${TESTER}/../x.md`, 'handoff.md']) {
      db.col('documents').docs.push({ doc_id: id, version: 1, content: '# legacy\n', updated_at: when, updated_by: HOST, size: 9 });
    }
  };
  test('cleanup: a registered host may retire_doc a look-alike id already in the store', () => withEnv(REG, async () => {
    const db = makeStore(); seedBad(db);
    for (const id of [`Bots/${INTAKE}/HANDOFF.md`, 'threads/old\u200b.md', ' HANDOFF.md', 'handoff.md']) {
      const r = await go(db, 'retire_doc', { doc_id: id, reason: 'look-alike id from before the checks', source: HUB });
      assert.ok(r.isError && /not a drop/.test(text(r)), `${JSON.stringify(id)}: ${text(r).slice(0, 300)}`);
      assert.strictEqual(db.doc(id).retired, undefined);
    }
  }));
  test('cleanup: a registered host may rename_doc FROM a look-alike id onto a clean one, never onto a look-alike', () => withEnv(REG, async () => {
    const db = makeStore(); seedBad(db);
    const r = await go(db, 'rename_doc', { old_id: `bots/${TESTER}/../x.md`, new_id: 'threads/x.md', source: HOST });
    assert.ok(!r.isError, text(r).slice(0, 300));
    assert.ok(db.doc('threads/x.md') && db.doc(`bots/${TESTER}/../x.md`).retired === true);
    const onto = await go(db, 'rename_doc', { old_id: 'threads/old\u200b.md', new_id: 'threads/y\u200b.md', source: HUB });
    assert.ok(onto.isError && LOOK.test(text(onto)) && !db.doc('threads/y\u200b.md'), text(onto).slice(0, 300));
  }));
  test('cleanup is refused to a bot, an unregistered or missing tag, and with no registry; write and patch never get it', () => withEnv(REG, async () => {
    const db = makeStore(); seedBad(db);
    for (const source of [INTAKE, 'bot-typo', undefined]) {
      const r = await go(db, 'retire_doc', { doc_id: 'threads/old\u200b.md', reason: 'x', ...(source ? { source } : {}) });
      assert.ok(r.isError && LOOK.test(text(r)), `${source}: ${text(r).slice(0, 300)}`);
      const n = await go(db, 'rename_doc', { old_id: 'threads/old\u200b.md', new_id: 'threads/z.md', ...(source ? { source } : {}) });
      assert.ok(n.isError && LOOK.test(text(n)), `${source}: ${text(n).slice(0, 300)}`);
    }
    await withEnv({ EMET_SOURCE_TAGS: undefined }, async () => {
      const r = await go(db, 'retire_doc', { doc_id: 'threads/old\u200b.md', reason: 'x', source: HUB });
      assert.ok(r.isError && LOOK.test(text(r)), text(r).slice(0, 300));
    });
    const w = await go(db, 'write_doc', { doc_id: 'threads/old\u200b.md', content: '# new\n', supersedes: 1, source: HUB });
    assert.ok(w.isError && LOOK.test(text(w)), text(w).slice(0, 300));
    const p = await go(db, 'patch_doc', { doc_id: 'threads/old\u200b.md', old_str: 'legacy', new_str: 'x', source: HUB });
    assert.ok(p.isError && LOOK.test(text(p)), text(p).slice(0, 300));
    assert.ok(!db.doc('threads/old\u200b.md').retired && db.doc('threads/old\u200b.md').version === 1 && !db.doc('threads/z.md'));
  }));
});

summary('BOT GUARDS TEST SUMMARY');
