/**
 * EMET - the consolidated revision of 2026-09-15, tested at the seams.
 *
 * Four pieces landed in one release on the user's word ("Consolidate the
 * revision into one"): the archive reader folded into query_transcripts, a
 * lookup by any id in a supersession chain resolving to the live entry, a
 * dated baseline for the gap counter, and a reader for retained document
 * revisions. Each is tested where it is pure; the store-walking parts are
 * exercised by real calls after deploy, and the dispatch test keeps the
 * new tool and the five removed ones honest on both transports.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { groupArchivedExchanges, resolveSupersessionChain, TOOLS, queryTranscripts } from '../src/tools.js';
import { parseBaseline } from '../src/gaps.js';
import { TOOL_ANNOTATIONS } from '../src/annotations.js';

// ---------------------------------------------------------------------------
testGroup('The archive is read in the live store\'s session shape', () => {
  const t = (s) => new Date(s);
  const rows = [
    { session_id: 'app_2026-01-09_e', exchange_index: 1, channel: 'claude_app', conversation_name: 'Coveralls', conversation_uuid: 'e', session_start: t('2026-01-09T18:07:11Z'), timestamp: t('2026-01-09T18:09:34Z'), user_message: 'u2', assistant_message: 'a2' },
    { session_id: 'app_2026-01-09_e', exchange_index: 0, channel: 'claude_app', conversation_name: 'Coveralls', conversation_uuid: 'e', session_start: t('2026-01-09T18:07:11Z'), timestamp: t('2026-01-09T18:07:26Z'), user_message: 'u1', assistant_message: 'a1' },
    // The CLI-era shape: session_start a month before the row timestamps.
    { session_id: 'cli_2026-06-20_1', exchange_index: 0, channel: 'cli', session_start: t('2026-05-20T11:39:35Z'), timestamp: t('2026-06-20T04:08:47Z'), user_message: 'initialize', assistant_message: 'Reading.' },
    { session_id: 'cli_2026-06-20_1', exchange_index: 1, channel: 'cli', session_start: t('2026-05-20T11:39:35Z'), timestamp: t('2026-06-20T04:08:47Z'), user_message: 'initialize', assistant_message: 'Running.' }
  ];
  const sessions = groupArchivedExchanges(rows);

  test('one session per session_id, ordered by session_start', () => {
    assert.deepStrictEqual(sessions.map(s => s.session_id), ['app_2026-01-09_e', 'cli_2026-06-20_1']);
  });
  test('every archive session says where it came from', () => {
    assert.ok(sessions.every(s => s.source === 'exchanges'));
  });
  test('exchanges are ordered by their stored index and the index is NOT renumbered', () => {
    assert.deepStrictEqual(sessions[0].exchanges.map(e => e.exchange_index), [0, 1]);
    assert.strictEqual(sessions[0].exchanges[0].user_message, 'u1');
  });
  test('exchange_count and session_end come from the rows', () => {
    assert.strictEqual(sessions[0].exchange_count, 2);
    assert.strictEqual(sessions[0].session_end.toISOString(), '2026-01-09T18:09:34.000Z');
  });
  test('the conversation name and channel travel with the session', () => {
    assert.strictEqual(sessions[0].conversation_name, 'Coveralls');
    assert.strictEqual(sessions[1].channel, 'cli');
    assert.strictEqual(sessions[1].conversation_name, null);
  });
  test('a row with no session_id still lands somewhere visible rather than being dropped', () => {
    const s = groupArchivedExchanges([{ channel: 'telegram', timestamp: t('2025-07-01T00:00:00Z'), user_message: 'x', assistant_message: 'y' }]);
    assert.strictEqual(s.length, 1);
    assert.ok(s[0].session_id.startsWith('unkeyed_'));
  });
});

// ---------------------------------------------------------------------------
await testGroup('A lookup by any id in a supersession chain reaches the live entry', async () => {
  // A fake shim: id -> row, with superseded_by as the store writes it.
  const rows = {
    334: { id: 334, event: 'old', metadata: { superseded_by: 339 }, superseded_by: 339 },
    339: { id: 339, event: 'live', metadata: {}, superseded_by: null },
    10: { id: 10, event: 'a', metadata: {}, superseded_by: 11 },
    11: { id: 11, event: 'b', metadata: {}, superseded_by: 10 },
    20: { id: 20, event: 'orphan', metadata: {}, superseded_by: 999 }
  };
  const db = async (id) => rows[id];

  await test('a superseded entry resolves to the live end, with the ids walked', async () => {
    const r = await resolveSupersessionChain(db, rows[334]);
    assert.strictEqual(r.live.id, 339);
    assert.deepStrictEqual(r.ids, [334, 339]);
  });
  await test('a live entry resolves to itself', async () => {
    const r = await resolveSupersessionChain(db, rows[339]);
    assert.strictEqual(r.live.id, 339);
    assert.deepStrictEqual(r.ids, [339]);
  });
  await test('a cycle terminates and is reported, not spun on', async () => {
    const r = await resolveSupersessionChain(db, rows[10]);
    assert.strictEqual(r.live, null);
    assert.strictEqual(r.cycle, true);
  });
  await test('a pointer to a missing id stops and names it (the broken_supersession gap)', async () => {
    const r = await resolveSupersessionChain(db, rows[20]);
    assert.strictEqual(r.live, null);
    assert.strictEqual(r.missing, 999);
  });
});

// ---------------------------------------------------------------------------
testGroup('The gap baseline is read from EMET_GAP_BASELINE and nothing else', () => {
  test('unset means no baseline - the block is absent, never defaulted', () => {
    assert.strictEqual(parseBaseline(undefined), null);
    assert.strictEqual(parseBaseline(''), null);
    assert.strictEqual(parseBaseline('   '), null);
  });
  test('an ISO date parses to Unix seconds', () => {
    assert.strictEqual(parseBaseline('2026-09-07'), Math.floor(Date.parse('2026-09-07') / 1000));
  });
  test('Unix seconds pass through', () => {
    assert.strictEqual(parseBaseline('1789000000'), 1789000000);
  });
  test('garbage is null, not a crash and not epoch zero', () => {
    assert.strictEqual(parseBaseline('last tuesday'), null);
  });
});

// ---------------------------------------------------------------------------
testGroup('The tool list after the removal', () => {
  const names = TOOLS.map(t => t.name);
  test('the five deprecated tools are gone', () => {
    for (const n of ['remember', 'get_stats', 'emet_setup_begin', 'insert_doc_section', 'query_exchanges'])
      assert.ok(!names.includes(n), `${n} is still declared`);
  });
  test('the retained-revision reader is declared', () => {
    assert.ok(names.includes('read_doc_history'));
  });
  // Was a literal count (27) that broke on every tool added since (code audit
  // 2026-09-27, 4.1). The structural claim is what mattered: the five above
  // are gone, and every declared tool has an annotation and vice versa.
  test('the declared list and the annotation table are the same set', () => {
    const annotated = Object.keys(TOOL_ANNOTATIONS).sort();
    assert.deepStrictEqual([...names].sort(), annotated);
  });
  test('query_transcripts says it reads the archive too', () => {
    const qt = TOOLS.find(t => t.name === 'query_transcripts');
    assert.ok(/archive/.test(qt.description));
  });
});

// ---------------------------------------------------------------------------
import { checkRecord, parseTemplate } from '../src/conformance.js';
testGroup('The board id column is found by its header, so it can sit last', () => {
  const tpl = parseTemplate(`# TEMPLATE - BOARD
**Template control:** id \`templates/BOARD.md\` · status: IN FORCE
## §0 RECORD CONTROL AND COUNTS
- Template: __
## §1 HALF-STATE
| What | Id |
|---|---|
## §2 DATED
| Date | Item | Id |
|---|---|---|
## §3 OPEN BOARD
| Item | Status | Id |
|---|---|---|
## §4 CLOSED THIS REVISION
| Item | Disposition | Id |
|---|---|---|
`, { doc_id: 'templates/BOARD.md' });
  const prev = `# BOARD
## §0 RECORD CONTROL AND COUNTS
- Template: \`templates/BOARD.md\` rev 11
## §1 HALF-STATE
None.
## §2 DATED
| Date | Item | Id |
|---|---|---|
| 9/16 | Lodge | B-078 |
## §3 OPEN BOARD
| Item | Status | Id |
|---|---|---|
| the coherence review | OPEN | B-076 |
| the rename | OPEN | B-074 |
## §4 CLOSED THIS REVISION
None closed this revision.
`;
  test('an id in the last column is read as a row id', () => {
    const next = prev.replace('| the rename | OPEN | B-074 |\n', '');
    const r = checkRecord(next, tpl, { previous: prev, doc_id: 'STATE.md' });
    assert.ok(r.failures.some(f => /B-074/.test(f)), `expected B-074 reported as leaving undispositioned; got ${JSON.stringify(r.failures)}`);
  });
  test('a row dispositioned in §4 with the id last is not reported dropped', () => {
    const next = prev.replace('| the rename | OPEN | B-074 |\n', '')
      .replace('None closed this revision.', '| Item | Disposition | Id |\n|---|---|---|\n| the rename | DONE | B-074 |');
    const r = checkRecord(next, tpl, { previous: prev, doc_id: 'STATE.md' });
    assert.ok(!r.failures.some(f => /B-074/.test(f)), JSON.stringify(r.failures));
  });
  test('an id mentioned only in another row\'s prose is still not a row', () => {
    const next = prev.replace('| the rename | OPEN | B-074 |\n', '').replace('| the coherence review | OPEN | B-076 |', '| the coherence review (see B-074) | OPEN | B-076 |')
      .replace('None closed this revision.', '| Item | Disposition | Id |\n|---|---|---|\n| the rename | DONE | B-074 |');
    const r = checkRecord(next, tpl, { previous: prev, doc_id: 'STATE.md' });
    assert.ok(!r.failures.some(f => /B-074/.test(f)), JSON.stringify(r.failures));
  });
});

// ---------------------------------------------------------------------------
import { validateDocument } from '../src/conformance.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
testGroup('The charter L1 lock actually fires', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shipped = fs.readFileSync(path.join(root, 'CHARTER.md'), 'utf8');
  test('a store copy identical to the shipped charter conforms with no "no shipped copy" warning', () => {
    const r = validateDocument('CHARTER.md', shipped, null);
    assert.strictEqual(r.verdict, 'conforms', JSON.stringify(r));
    assert.ok(!r.warnings.some(w => /no shipped copy/.test(w)), JSON.stringify(r.warnings));
  });
  test('THE LOCK BITES: a store copy that differs from the shipped charter is marked', () => {
    const r = validateDocument('CHARTER.md', shipped.replace('## §10 LIMITS, STATED PLAINLY', '## §10 LIMITS'), null);
    assert.strictEqual(r.verdict, 'nonconforming');
    assert.ok(r.failures.some(f => /shipped copy governs \(L1\)/.test(f)), JSON.stringify(r.failures));
  });
});

// Security audit 2026-09-29: query_transcripts took session_id unchecked, so an
// object was a MongoDB operator rather than an id. Refused before any database call.
testGroup('query_transcripts refuses a non-string session_id', () => {
  for (const bad of [{ $ne: null }, { $regex: '.*' }, 42, ['a']]) {
    test(`refuses ${JSON.stringify(bad)}`, async () => {
      await assert.rejects(() => queryTranscripts(1, 2, bad, 10), /session_id/);
    });
  }
});

summary('Consolidated Revision 2026-09 Test Summary');
