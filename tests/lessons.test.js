/**
 * EMET - lessons that became checks (2026-09-27).
 *
 * Three rules moved from advice to server checks at the owner's word, after the
 * Hanako "Loops and Graphs" reading: the machine line on the first transcript
 * append, a cap of three blocked closes, and repeated corrections named at
 * startup. Each is a pure function here so the rule is assertable without a
 * database.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import {
  NO_SHELL_PHRASE, knownMachinesFromInstallNotes, machineLineCheck,
  CLOSE_CAP, applyCloseCap, scopeFor, escalateSpeak,
  LESSON_REPEAT_THRESHOLD, pendingLessons, checkLessonFields
} from '../src/lessons-to-checks.js';
import { saveMemory } from '../src/tools.js';


const INSTALL = `# INSTALL

## §2 SESSION START CHECKS

| Name | Model | What it is |
|---|---|---|
| DESKTOP-A | MS-0000 | Desktop, office |
| LAPTOP-B | Example Laptop | Laptop, travel |

- Never take the machine from PROCESSOR_ARCHITECTURE.

| Host | Recognize by | Source tag |
|---|---|---|
| Claude Code CLI | Terminal | cli |
`;

testGroup('Build 1 - known machines from the install notes', () => {
  test('reads the Name column of the machine table only', () =>
    assert.deepStrictEqual(knownMachinesFromInstallNotes(INSTALL), ['DESKTOP-A', 'LAPTOP-B']));
  test('a document with no machine table yields []', () =>
    assert.deepStrictEqual(knownMachinesFromInstallNotes('# notes\n\nno tables here'), []));
  test('null content yields []', () => assert.deepStrictEqual(knownMachinesFromInstallNotes(null), []));
});

testGroup('Build 1 - the first-append check', () => {
  const names = ['DESKTOP-A', 'LAPTOP-B'];
  test('measured line with a known name and a clock passes', () => {
    const r = machineLineCheck('[machine check: "Sunday, September 27, 2026 3:29:32 PM / DESKTOP-A / MS-0000"]\n\nTruth stands.', names);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.enforced, true); assert.strictEqual(r.matched, 'DESKTOP-A');
  });
  test('ISO date counts as a clock', () =>
    assert.strictEqual(machineLineCheck('LAPTOP-B 2026-09-27 15:29', names).ok, true));
  test('the no-shell phrase passes on its own, any case', () =>
    assert.strictEqual(machineLineCheck('Truth stands. NO LOCAL SHELL mcp this session.', names).ok, true));
  test('a known name without a clock is refused and names the clock', () => {
    const r = machineLineCheck('Running on DESKTOP-A.', names);
    assert.strictEqual(r.ok, false);
    assert.ok(r.missing.some((m) => /date or time/.test(m)));
  });
  test('a clock without a known name is refused and names the machines', () => {
    const r = machineLineCheck('It is 2026-09-27 15:29 on my laptop.', names);
    assert.strictEqual(r.ok, false);
    assert.ok(r.missing.some((m) => m.includes('DESKTOP-A')));
  });
  test('an unrelated opening is refused with the phrase to use', () => {
    const r = machineLineCheck('Truth stands. Memory connected.', names);
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes(NO_SHELL_PHRASE));
  });
  test('with no known names the check is not enforced and passes', () => {
    const r = machineLineCheck('Truth stands.', []);
    assert.strictEqual(r.ok, true); assert.strictEqual(r.enforced, false);
  });
});

testGroup('Build 2 - blocked-close cap', () => {
  test('cap is three', () => assert.strictEqual(CLOSE_CAP, 3));
  test('first blocked close stays blocked, count 1', () =>
    assert.deepStrictEqual(applyCloseCap('blocked', 0), { state: 'blocked', blocked_count: 1, escalated: false }));
  test('second blocked close stays blocked, count 2', () =>
    assert.deepStrictEqual(applyCloseCap('blocked', 1), { state: 'blocked', blocked_count: 2, escalated: false }));
  test('third blocked close escalates', () =>
    assert.deepStrictEqual(applyCloseCap('blocked', 2), { state: 'escalate', blocked_count: 3, escalated: true }));
  test('a fourth blocked close stays escalated and does not count past the cap', () =>
    assert.deepStrictEqual(applyCloseCap('blocked', 3), { state: 'escalate', blocked_count: 3, escalated: true }));
  test('a complete close is never refused, even after the cap', () =>
    assert.deepStrictEqual(applyCloseCap('complete', 3), { state: 'complete', blocked_count: 3, escalated: false }));
  test('incomplete passes through untouched', () =>
    assert.deepStrictEqual(applyCloseCap('incomplete', 1), { state: 'incomplete', blocked_count: 1, escalated: false }));
  test('the counter does not reset on a changed receipt (only a new session resets it)', () => {
    // Two blocked, then a "different" receipt that is still blocked: still counts up.
    const a = applyCloseCap('blocked', 0); const b = applyCloseCap('blocked', a.blocked_count);
    const c = applyCloseCap('blocked', b.blocked_count);
    assert.strictEqual(c.state, 'escalate');
  });
});

testGroup('Build 2 - scope lines', () => {
  test('transcript problems scope to this session\'s transcript', () =>
    assert.ok(scopeFor('transcript parts: receipt lists [a], store holds [a, b]').includes('query_transcripts')));
  test('handoff problems scope to one whole write of HANDOFF.md', () =>
    assert.ok(scopeFor('handoff was not the last write').includes('HANDOFF.md')));
  test('board problems scope to the board', () =>
    assert.ok(scopeFor('board STATE.md was not updated this session').includes('board')));
  test('episodic problems scope to one episodic write', () =>
    assert.ok(scopeFor('episodic entry 590 was not found').includes('episodic')));
  test('a missing receipt scopes to supplying it, not rewriting', () =>
    assert.ok(scopeFor('receipt missing: board_version').includes('do not rewrite')));
  test('escalate speech names the cap and lists what is missing', () => {
    const s = escalateSpeak(['a', 'b']);
    assert.ok(s[0].includes(String(CLOSE_CAP)));
    assert.ok(s.includes('- a') && s.includes('- b'));
  });
});

const T = 1790000000;
const meta = (id, tags, extra = {}) => ({ id, content: `lesson ${id}`, timestamp: T + id, metadata: { tags, ...extra } });
const keyed = (id, lesson, extra = {}) => meta(id, ['meta'], { lesson, ...extra });

testGroup('Build 3 - pending lessons (explicit key is authoritative)', () => {
  test('threshold is three', () => assert.strictEqual(LESSON_REPEAT_THRESHOLD, 3));
  test('three entries with the same metadata.lesson key form one pending lesson', () => {
    const r = pendingLessons([keyed(1, 'codes-not-plain-words'), keyed(2, 'codes-not-plain-words'), keyed(3, 'Codes-Not-Plain-Words ')]);
    assert.strictEqual(r.pending.length, 1);
    assert.strictEqual(r.pending[0].lesson_key, 'codes-not-plain-words');
    assert.strictEqual(r.pending[0].count, 3);
    assert.deepStrictEqual(r.pending[0].ids, [1, 2, 3]);
  });
  test('two keyed entries are below the threshold', () =>
    assert.strictEqual(pendingLessons([keyed(1, 'x'), keyed(2, 'x')]).pending.length, 0));
  test('a key relocated under metadata.custom still counts', () => {
    const r = pendingLessons([keyed(1, 'x'), keyed(2, 'x'), meta(3, ['meta'], { custom: { lesson: 'x' } })]);
    assert.strictEqual(r.pending.length, 1);
  });
  test('a disposition on any live member settles the lesson', () => {
    const r = pendingLessons([
      keyed(1, 'x'), keyed(2, 'x'), keyed(3, 'x'),
      keyed(4, 'x', { lesson_disposition: { kind: 'check', ref: 'emet_transcript_append first-append check' } })
    ]);
    assert.strictEqual(r.pending.length, 0);
    assert.strictEqual(r.dispositioned_count, 1);
  });
  test('a disposition relocated under metadata.custom still counts', () => {
    const r = pendingLessons([keyed(1, 'x'), keyed(2, 'x'), keyed(3, 'x', { custom: { lesson_disposition: { kind: 'uncheckable' } } })]);
    assert.strictEqual(r.pending.length, 0);
  });
  test('an unknown disposition kind does not settle anything', () => {
    const r = pendingLessons([keyed(1, 'x'), keyed(2, 'x'), keyed(3, 'x', { lesson_disposition: { kind: 'done' } })]);
    assert.strictEqual(r.pending.length, 1);
  });
  test('superseded members are not counted', () => {
    const r = pendingLessons([keyed(1, 'x'), keyed(2, 'x'), { ...keyed(3, 'x'), superseded_by: 9 }]);
    assert.strictEqual(r.pending.length, 0);
  });
  test('the latest member supplies the lesson text', () => {
    const r = pendingLessons([keyed(1, 'x'), keyed(2, 'x'), keyed(3, 'x')]);
    assert.strictEqual(r.pending[0].lesson, 'lesson 3');
  });
  test('empty input is a clean no-pending result with a receipt', () => {
    const r = pendingLessons([]);
    assert.deepStrictEqual(r.pending, []);
    assert.ok(r.instructions.startsWith('No keyed correction'));
    assert.strictEqual(r.receipt.route, 'explicit-key');
    assert.strictEqual(r.receipt.state.live_meta_rows, 0);
  });
  test('the receipt reports rule version and what it saw', () => {
    const r = pendingLessons([keyed(1, 'x'), keyed(2, 'y'), meta(3, ['a', 'b'])]);
    assert.strictEqual(r.receipt.rule_version, 'lessons@3');
    assert.deepStrictEqual(r.receipt.state, { live_meta_rows: 3, keyed_rows: 2, keys: 2 });
  });
});

testGroup('Build 3 - the shadow detector is gone (a decision record)', () => {
  const fam = [meta(1, ['codes', 'plain-words', 'startup']), meta(2, ['codes', 'plain-words', 'board']), meta(3, ['codes', 'plain-words'])];
  test('tag-sharing entries without a key are not a lesson', () => assert.strictEqual(pendingLessons(fam).pending.length, 0));
  test('there is no shadow block in the output', () => assert.strictEqual('shadow' in pendingLessons(fam), false));
  test('the receipt names one route and no shadow route', () => {
    const r = pendingLessons(fam);
    assert.strictEqual(r.receipt.route, 'explicit-key');
    assert.strictEqual('shadow_route' in r.receipt, false);
  });
  test('the served instructions no longer mention shadow', () => {
    assert.ok(!/shadow/i.test(pendingLessons([]).instructions));
    assert.ok(!/shadow/i.test(pendingLessons([keyed(1, 'abc'), keyed(2, 'abc'), keyed(3, 'abc')]).instructions));
  });
});

testGroup('Lesson fields are checked at the door - pure check', () => {
  test('no lesson fields is fine on any layer', () => {
    assert.strictEqual(checkLessonFields('semantic', { tags: ['x'] }), null);
    assert.strictEqual(checkLessonFields('meta', {}), null);
    assert.strictEqual(checkLessonFields('meta', undefined), null);
  });
  test('a slug key on meta is accepted', () => assert.strictEqual(checkLessonFields('meta', { lesson: 'codes-not-plain-words' }), null));
  test('a key under metadata.custom is checked the same way', () => {
    assert.strictEqual(checkLessonFields('meta', { custom: { lesson: 'machine-check-skipped' } }), null);
    assert.ok(checkLessonFields('meta', { custom: { lesson: 'Bad Key' } }));
  });
  test('capitals and spaces are refused, with the slug they meant', () => {
    const r = checkLessonFields('meta', { lesson: 'Codes Not Plain Words' });
    assert.ok(r && /not a lesson key/.test(r) && /"codes-not-plain-words"/.test(r), r);
  });
  test('surrounding whitespace is refused, not trimmed', () => assert.ok(checkLessonFields('meta', { lesson: ' abc ' })));
  test('underscores, double hyphens and edge hyphens are refused', () => {
    for (const k of ['a_b_c', 'abc--def', '-abc', 'abc-']) assert.ok(checkLessonFields('meta', { lesson: k }), k);
  });
  test('too short and too long are refused', () => {
    assert.ok(checkLessonFields('meta', { lesson: 'ab' }));
    assert.ok(checkLessonFields('meta', { lesson: 'a'.repeat(65) }));
    assert.strictEqual(checkLessonFields('meta', { lesson: 'a'.repeat(64) }), null);
  });
  test('a non-string key is refused', () => {
    assert.ok(/string slug/.test(checkLessonFields('meta', { lesson: 42 })));
    assert.ok(checkLessonFields('meta', { lesson: ['a'] }));
  });
  test('a key on any layer but meta is refused, naming meta', () => {
    for (const layer of ['semantic', 'procedural', 'episodic', 'working', 'identity', null]) {
      const r = checkLessonFields(layer, { lesson: 'abc' });
      assert.ok(r && /meta layer/.test(r), `${layer}: ${r}`);
    }
  });
  test('two different keys in one write are refused', () =>
    assert.ok(/disagree/.test(checkLessonFields('meta', { lesson: 'abc', custom: { lesson: 'xyz' } }))));
  test('the same key in both places is accepted', () =>
    assert.strictEqual(checkLessonFields('meta', { lesson: 'abc', custom: { lesson: 'abc' } }), null));
});

testGroup('Lesson dispositions are checked at the door - pure check', () => {
  test('a check disposition with a ref is accepted', () =>
    assert.strictEqual(checkLessonFields('meta', { lesson: 'abc', lesson_disposition: { kind: 'check', ref: 'first-append machine check' } }), null));
  test('a document disposition with a ref is accepted', () =>
    assert.strictEqual(checkLessonFields('meta', { lesson: 'abc', lesson_disposition: { kind: 'document', ref: 'bootstrap/USER.md delivery' } }), null));
  test('an uncheckable disposition needs no ref', () =>
    assert.strictEqual(checkLessonFields('meta', { lesson: 'abc', lesson_disposition: { kind: 'uncheckable' } }), null));
  test('an unknown kind is refused, naming the three kinds', () => {
    const r = checkLessonFields('meta', { lesson: 'abc', lesson_disposition: { kind: 'done' } });
    assert.ok(r && /check, document, uncheckable/.test(r), r);
  });
  test('check and document without a ref are refused', () => {
    assert.ok(/ref/.test(checkLessonFields('meta', { lesson: 'abc', lesson_disposition: { kind: 'check' } })));
    assert.ok(/ref/.test(checkLessonFields('meta', { lesson: 'abc', lesson_disposition: { kind: 'document', ref: '  ' } })));
  });
  test('a disposition that is not an object is refused', () => {
    assert.ok(checkLessonFields('meta', { lesson: 'abc', lesson_disposition: 'check' }));
    assert.ok(checkLessonFields('meta', { lesson: 'abc', lesson_disposition: [] }));
  });
  test('a disposition with no key is refused - it would settle nothing', () =>
    assert.ok(/settle nothing/.test(checkLessonFields('meta', { lesson_disposition: { kind: 'uncheckable' } }))));
  test('a disposition under metadata.custom is checked too', () =>
    assert.ok(checkLessonFields('meta', { lesson: 'abc', custom: { lesson_disposition: { kind: 'nope' } } })));
});

// The door itself: saveMemory against a fake store (the receipt suite's shape).
function fakeDb() {
  const writes = []; const rows = {}; let lastId = 100;
  return {
    writes,
    async getConnection() { return { async getAsync(_sql, params) { return rows[params[0]] || null; } }; },
    async insertMemory(layer, doc) { const id = ++lastId; writes.push({ layer, doc, id }); rows[id] = { ...doc, id }; return id; },
    async readMemory(_layer, id) { return rows[id] || null; }
  };
}

testGroup('Lesson fields are checked at the door - saveMemory', () => {
  test('a malformed key is refused and nothing is written', async () => {
    const db = fakeDb();
    await assert.rejects(() => saveMemory(db, 'correction: codes again', 'meta', { lesson: 'Codes Again', source: 'test' }),
      (e) => /not a lesson key/.test(e.message) && /Nothing was written/.test(e.message) && e.field === 'metadata.lesson');
    assert.strictEqual(db.writes.length, 0);
  });
  test('a key on the semantic layer is refused and nothing is written', async () => {
    const db = fakeDb();
    await assert.rejects(() => saveMemory(db, 'a fact', 'semantic', { lesson: 'abc', source: 'test' }), /meta layer/);
    assert.strictEqual(db.writes.length, 0);
  });
  test('a key with no layer is refused (it would land in the fallback, uncounted)', async () => {
    const db = fakeDb();
    await assert.rejects(() => saveMemory(db, 'a correction', null, { lesson: 'abc', source: 'test' }), /meta layer/);
    assert.strictEqual(db.writes.length, 0);
  });
  test('a sound keyed correction on meta is written, and the reader counts it', async () => {
    const db = fakeDb();
    const r = await saveMemory(db, 'correction: said codes, not plain words', 'meta', { lesson: 'codes-not-plain-words', source: 'test', tags: ['meta'] });
    assert.ok(r && r.success !== false, JSON.stringify(r).slice(0, 300));
    assert.strictEqual(db.writes.length, 1);
    const stored = db.writes[0].doc;
    const md = typeof stored.metadata === 'string' ? JSON.parse(stored.metadata) : stored.metadata;
    const row = { id: db.writes[0].id, content: stored.content, timestamp: 1, metadata: md };
    const p = pendingLessons([row, { ...row, id: 2 }, { ...row, id: 3 }]);
    assert.strictEqual(p.pending.length, 1);
    assert.strictEqual(p.pending[0].lesson_key, 'codes-not-plain-words');
  });
  test('an ordinary write with no lesson fields is untouched', async () => {
    const db = fakeDb();
    await saveMemory(db, 'a plain fact', 'semantic', { source: 'test', derived_from: { entries: [1] } });
    assert.strictEqual(db.writes.length, 1);
  });
});

summary('Lessons To Checks Test Summary');
