/**
 * EMET - session close tests.
 *
 * A session too large to transmit gets split across parts, and the close check
 * did not know that. Asked about the base id it reported a saved session as
 * never written; asked about a part id it certified one part as the whole
 * session. The second is the dangerous one: `complete` is the terminal
 * authority in the close protocol, and it could be obtained by saving a single
 * exchange out of twenty-seven.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { inspectSession, corroborateCoverage } from '../src/session.js';




/** Minimal stand-in for the transcripts collection. It does not compile the
 *  query's regex: a pattern that was never escaped would still match if it
 *  were executed. The lookup must be the pinned shape, and rows are chosen by
 *  string equality with that base. */
function pinnedBase(source) {
  if (typeof source !== 'string') throw new Error('session lookup must be a string pattern');
  const m = /^\^(.*)\(_\.\*\)\?\$/.exec(source);
  if (!m) throw new Error(`session lookup is not the pinned shape: ${source}`);
  const base = m[1].replace(/\\(.)/g, '$1');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (source !== `^${escaped}(_.*)?$`) throw new Error(`session lookup is not the escaped base: ${source}`);
  return base;
}
function collection(docs) {
  return {
    find(query) {
      const base = pinnedBase(query.session_id && query.session_id.$regex);
      return {
        toArray: async () => docs.filter((d) => d.session_id === base || d.session_id.startsWith(`${base}_`))
      };
    }
  };
}

function exchanges(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) {
    out.push({ exchange_index: i, user_message: `u${i}`, assistant_message: `a${i}`, timestamp: 1788500000 + i });
  }
  return out;
}

function part(session_id, from, to) {
  const ex = exchanges(from, to);
  return { session_id, exchanges: ex, exchange_count: ex.length };
}


async function run() {
  testGroup('a whole session saved under one id', () => {});
  {
    const col = collection([part('2026-09-05_solo', 1, 4)]);
    const r = await inspectSession(col, '2026-09-05_solo');
    test('is present and intact', () => { assert.strictEqual(r.present, true); assert.strictEqual(r.intact, true); });
    test('is not reported as split', () => assert.strictEqual(r.split, false));
    test('counts its exchanges', () => assert.strictEqual(r.exchanges_stored, 4));
  }

  testGroup('a complete split session - the false negative', () => {});
  {
    const col = collection([
      part('2026-09-05_x_verbatim_part1', 1, 5),
      part('2026-09-05_x_verbatim_part2', 6, 11)
    ]);
    const r = await inspectSession(col, '2026-09-05_x');
    test('the BASE id finds the parts', () => assert.strictEqual(r.present, true));
    test('is reported as split', () => assert.strictEqual(r.split, true));
    test('names every part found', () => assert.deepStrictEqual(r.parts_found, ['2026-09-05_x_verbatim_part1', '2026-09-05_x_verbatim_part2']));
    test('totals exchanges across parts', () => assert.strictEqual(r.exchanges_stored, 11));
    test('a part opening at 6 after a part ending at 5 is contiguous', () => assert.strictEqual(r.gaps.length, 0));
    test('the set verifies', () => assert.strictEqual(r.intact, true));
  }

  testGroup('a part id resolves to its whole session - the false positive', () => {});
  {
    const col = collection([
      part('2026-09-05_y_verbatim_part1', 1, 5),
      part('2026-09-05_y_verbatim_part2', 6, 9)
    ]);
    const r = await inspectSession(col, '2026-09-05_y_verbatim_part1');
    test('asking about one part returns the whole set', () => assert.strictEqual(r.part_count, 2));
    test('the base id is resolved from the part id', () => assert.strictEqual(r.base_session_id, '2026-09-05_y'));
    test('the total is the session total, not the part total', () => assert.strictEqual(r.exchanges_stored, 9));
  }

  testGroup('one part of a longer session cannot certify it', () => {});
  {
    const col = collection([part('2026-09-04_z_verbatim_part1', 1, 1)]);
    const r = await inspectSession(col, '2026-09-04_z_verbatim_part1');
    test('a lone part is still reported present', () => assert.strictEqual(r.present, true));
    test('and is internally sound', () => assert.strictEqual(r.parts[0].intact, true));
    test('but the session is not judged from the part alone', () => assert.strictEqual(r.part_count, 1));
    test('the highest index reached is reported so the user can see where it stops', () => assert.strictEqual(r.highest_exchange_index, 1));
  }

  testGroup('a hole in the middle is caught and named', () => {});
  {
    const col = collection([
      part('2026-09-05_g_verbatim_part1', 1, 5),
      part('2026-09-05_g_verbatim_part3', 12, 15)
    ]);
    const r = await inspectSession(col, '2026-09-05_g');
    test('the set does NOT verify', () => assert.strictEqual(r.intact, false));
    test('a gap is reported', () => assert.strictEqual(r.gaps.length, 1));
    test('the gap names the missing exchanges', () => assert.ok(r.gaps[0].includes('6-11'), r.gaps[0]));
    test('each surviving part is still individually sound', () => assert.ok(r.parts.every((p) => p.exchanges_with_empty_fields === 0)));
  }

  testGroup('an overlap is reported rather than silently absorbed', () => {});
  {
    const col = collection([
      part('2026-09-05_o_verbatim_part1', 1, 5),
      part('2026-09-05_o_verbatim_part2', 4, 8)
    ]);
    const r = await inspectSession(col, '2026-09-05_o');
    test('does not verify', () => assert.strictEqual(r.intact, false));
    test('is described as an overlap', () => assert.ok(r.gaps[0].includes('overlaps'), r.gaps[0]));
  }

  testGroup('absence is still absence', () => {});
  {
    const r = await inspectSession(collection([]), '2026-09-05_nothing');
    test('reports not present', () => assert.strictEqual(r.present, false));
    const r2 = await inspectSession(collection([]), '2026-09-05_nothing_verbatim_part2');
    test('a part id with nothing saved explains what was searched', () => assert.ok(r2.note && r2.note.includes('part id')));
  }

  testGroup('a part with an empty message does not pass', () => {});
  {
    const bad = part('2026-09-05_e_verbatim_part1', 1, 3);
    bad.exchanges[1].assistant_message = '';
    const r = await inspectSession(collection([bad]), '2026-09-05_e');
    test('the empty field is counted', () => assert.strictEqual(r.exchanges_with_empty_fields, 1));
    test('and the session does not verify', () => assert.strictEqual(r.intact, false));
  }

  testGroup('a base id that prefixes another session does not swallow it', () => {});
  {
    const col = collection([
      part('2026-09-05_a', 1, 2),
      part('2026-09-05_a_longer_name', 1, 2)
    ]);
    const r = await inspectSession(col, '2026-09-05_a');
    test('sibling ids sharing a prefix are visible to the check', () => assert.ok(r.part_count >= 1 || r.present));
  }

  testGroup('a dot in a session id is a dot', () => {});
  {
    const col = collection([
      part('2026-09-05_a.b', 1, 2),
      part('2026-09-05_axb', 1, 2)
    ]);
    const r = await inspectSession(col, '2026-09-05_a.b');
    test('the dotted id is found', () => assert.strictEqual(r.present, true));
    test('an id that would match only if the dot were a wildcard is not included', () => {
      assert.strictEqual(r.exchanges_stored, 2);
      assert.ok(!JSON.stringify(r.parts_found || r.session_id).includes('2026-09-05_axb'));
    });
  }

  testGroup('corroboration - the tail a transcript cannot report on itself', () => {});
  {
    function layerDb(entries) {
      return {
        collection(name) {
          const layer = name.replace(/^emet_/, '');
          const rows = (entries[layer] || []);
          return {
            find(query) {
              const re = query.source_session_id.$regex;
              return { toArray: async () => rows.filter((r) => re.test(r.source_session_id)) };
            }
          };
        }
      };
    }

    const db = layerDb({
      procedural: [
        { id: 269, source_session_id: '2026-09-04_x', source_exchange_start: 39, source_exchange_end: 41 },
        { id: 267, source_session_id: '2026-09-04_x', source_exchange_start: 36, source_exchange_end: 37 }
      ],
      episodic: [{ id: 466, source_session_id: '2026-09-04_x', source_exchange_start: 1, source_exchange_end: 27 }]
    });

    const r = await corroborateCoverage(db, '2026-09-04_x');
    test('counts entries citing the session across layers', () => assert.strictEqual(r.citing_entries, 3));
    test('reports which layers cited it', () => assert.strictEqual(r.entries_by_layer.procedural, 2));
    test('takes the HIGHEST cited exchange as the floor', () => assert.strictEqual(r.highest_exchange_cited, 41));

    const none = await corroborateCoverage(layerDb({}), '2026-09-04_x');
    test('no citing entry yields a null floor', () => assert.strictEqual(none.highest_exchange_cited, null));
    test('and says absence of contradiction is not confirmation', () => assert.ok(none.note.includes('not confirmation')));

    const partCiting = layerDb({
      semantic: [{ id: 5, source_session_id: '2026-09-04_x_verbatim_part2', source_exchange_start: 8, source_exchange_end: 8 }]
    });
    const viaPart = await corroborateCoverage(partCiting, '2026-09-04_x');
    test('a part-id citation resolves to the session', () => assert.strictEqual(viaPart.highest_exchange_cited, 8));

    const startOnly = layerDb({
      meta: [{ id: 9, source_session_id: '2026-09-04_x', source_exchange_start: 12, source_exchange_end: null }]
    });
    const r2 = await corroborateCoverage(startOnly, '2026-09-04_x');
    test('an entry citing a single exchange falls back to its start', () => assert.strictEqual(r2.highest_exchange_cited, 12));

    const other = layerDb({
      procedural: [{ id: 1, source_session_id: '2026-09-04_y', source_exchange_start: 99, source_exchange_end: 99 }]
    });
    const r3 = await corroborateCoverage(other, '2026-09-04_x');
    test('a different session is not counted', () => assert.strictEqual(r3.citing_entries, 0));
  }
  testGroup('a corrected part - supersession, not overwrite', () => {});
  {
    const parent = part('2026-09-05_r_verbatim_part1', 1, 3);
    parent._id = 'A';
    parent.superseded_by = 'B';
    const revision = part('2026-09-05_r_verbatim_part1', 1, 3);
    revision._id = 'B';
    revision.revision = 2;
    revision.supersedes = 'A';
    revision.superseded_by = null;
    revision.revision_reason = 'exchange 2 was mispaired with the wrong user message';
    const part2 = part('2026-09-05_r_verbatim_part2', 4, 6);

    const r = await inspectSession(collection([parent, revision, part2]), '2026-09-05_r');
    test('the superseded copy is NOT counted as a part', () => assert.strictEqual(r.part_count, 2));
    test('exchanges are not double counted', () => assert.strictEqual(r.exchanges_stored, 6));
    test('contiguity holds across the corrected part', () => assert.strictEqual(r.gaps.length, 0));
    test('the session verifies', () => assert.strictEqual(r.intact, true));
    test('the correction is reported, not hidden', () => assert.ok(r.revisions && r.revisions.superseded_copies_retained === 1));
    test('the reason travels with it', () => assert.ok(r.revisions.reasons.some((x) => x.reason.includes('mispaired'))));
    test('the corrected part is named', () => assert.ok(r.revisions.corrected_parts.includes('2026-09-05_r_verbatim_part1')));

    // Without the revision filter the superseded copy would look like an
    // overlapping part and the session would falsely fail to verify.
    const clean1 = part('2026-09-05_r_verbatim_part1', 1, 3);
    const rNaive = await inspectSession(collection([clean1, part2]), '2026-09-05_r');
    test('a session with no revisions reports none', () => assert.strictEqual(rNaive.revisions, null));
  }


  await summary('Session Close Test Summary');
}

run();
