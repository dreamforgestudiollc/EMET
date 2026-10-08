/**
 * EMET - emet_gaps tests (work list E4).
 *
 * The classifier is pure and that is the part tested here: each gap class
 * fires on the row shape that defines it and on nothing else. A gap counter
 * that over-counts becomes noise nobody reads; one that under-counts is the
 * silent failure the tool exists to end. The store-walking parts are exercised
 * by the deploy canary, not here.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { classifyRow, tagFamilies, GAP_CLASSES, classifyPointer } from '../src/gaps.js';
import { digest, digestMetadata } from '../src/aleph.js';


const NOW = 1_800_000_000;
const content = 'a stored entry';
// A row the door would write today with everything present: no gaps at all.
function cleanRow(extraMd = {}, extraRow = {}) {
  const metadata = { source: 'cli', assertion_origin: 'user', routing: { method: 'explicit' }, tags: ['a'], ...extraMd };
  return {
    id: 1, content, sha256: digest(content), metadata, metadata_sha256: digestMetadata(metadata),
    is_live: true, superseded_by: null, valid_until: null,
    source_session_id: '2026-09-07_x', source_exchange_start: 1, source_exchange_end: 1, derived_from_ids: null,
    ...extraRow
  };
}
const opts = { registry: ['cli', 'cloud-host'], nowSec: NOW };

testGroup('A clean row has no gaps', () => {
  test('semantic, fully attributed, attested, pointed, explicit routing', () => {
    assert.deepStrictEqual(classifyRow('semantic', cleanRow(), opts), []);
  });
  test('every gap class has a description', () => {
    for (const [k, v] of Object.entries(GAP_CLASSES)) assert.ok(typeof v === 'string' && v.length > 20, k);
  });
});

testGroup('unsourced_assertions / unattributed_inferences', () => {
  test('semantic with no pointer is unsourced; with assistant origin it is also an unattributed inference', () => {
    const r = cleanRow({ assertion_origin: 'assistant' }, { source_session_id: null, derived_from_ids: null });
    const g = classifyRow('semantic', r, opts);
    assert.ok(g.includes('unsourced_assertions') && g.includes('unattributed_inferences'));
  });
  test('semantic with no pointer and a USER origin is unsourced but not an inference', () => {
    const g = classifyRow('semantic', cleanRow({ assertion_origin: 'user' }, { source_session_id: null }), opts);
    assert.ok(g.includes('unsourced_assertions') && !g.includes('unattributed_inferences'));
  });
  test('missing assertion_origin counts as unknown -> inference', () => {
    const md = { source: 'cli', routing: { method: 'explicit' } };
    const r = { ...cleanRow(), metadata: md, metadata_sha256: digestMetadata(md), source_session_id: null };
    assert.ok(classifyRow('procedural', r, opts).includes('unattributed_inferences'));
  });
  test('a consolidated-from pointer is a pointer', () => {
    const g = classifyRow('semantic', cleanRow({ assertion_origin: 'assistant' }, { source_session_id: null, derived_from_ids: [3, 4] }), opts);
    assert.ok(!g.includes('unsourced_assertions'));
  });
  test('episodic and working with no pointer are not counted here (policy is not required)', () => {
    assert.ok(!classifyRow('episodic', cleanRow({}, { source_session_id: null }), opts).includes('unsourced_assertions'));
    assert.ok(!classifyRow('working', cleanRow({}, { source_session_id: null }), opts).includes('unsourced_assertions'));
  });
});

testGroup('ambiguous_attribution', () => {
  test('defaulted, missing, or unregistered source', () => {
    assert.ok(classifyRow('working', cleanRow({ source_defaulted: true }), opts).includes('ambiguous_attribution'));
    assert.ok(classifyRow('working', cleanRow({ source: null }), opts).includes('ambiguous_attribution'));
    assert.ok(classifyRow('working', cleanRow({ source: 'stranger' }), opts).includes('ambiguous_attribution'));
  });
  test('a registered, chosen source is not ambiguous; with no registry any string passes', () => {
    assert.ok(!classifyRow('working', cleanRow({ source: 'cloud-host' }), opts).includes('ambiguous_attribution'));
    assert.ok(!classifyRow('working', cleanRow({ source: 'stranger' }), { ...opts, registry: [] }).includes('ambiguous_attribution'));
  });
});

testGroup('uncertain_routing', () => {
  test('keyword or analyzer routing is uncertain; explicit is not; no routing field (old rows) is not counted', () => {
    assert.ok(classifyRow('working', cleanRow({ routing: { method: 'keyword' } }), opts).includes('uncertain_routing'));
    assert.ok(classifyRow('working', cleanRow({ routing: { method: 'analyzer' } }), opts).includes('uncertain_routing'));
    assert.ok(!classifyRow('working', cleanRow({ routing: { method: 'explicit' } }), opts).includes('uncertain_routing'));
    const md = { source: 'cli', assertion_origin: 'user' };
    assert.ok(!classifyRow('working', { ...cleanRow(), metadata: md, metadata_sha256: digestMetadata(md) }, opts).includes('uncertain_routing'));
  });
});

testGroup('unattestable / digest_mismatch', () => {
  test('no sha256 column -> unattestable, not a mismatch', () => {
    const r = cleanRow(); delete r.sha256; delete r.metadata_sha256;
    const g = classifyRow('working', r, opts);
    assert.ok(g.includes('unattestable') && !g.includes('digest_mismatch'));
  });
  test('content column disagreeing -> digest_mismatch', () => {
    assert.ok(classifyRow('working', cleanRow({}, { sha256: 'deadbeef' }), opts).includes('digest_mismatch'));
  });
  test('metadata column disagreeing -> digest_mismatch', () => {
    assert.ok(classifyRow('working', cleanRow({}, { metadata_sha256: 'deadbeef' }), opts).includes('digest_mismatch'));
  });
});

testGroup('expired_but_live', () => {
  test('past valid_until and still live', () => {
    assert.ok(classifyRow('working', cleanRow({}, { valid_until: NOW - 10 }), opts).includes('expired_but_live'));
  });
  test('past valid_until but superseded is not counted; future valid_until is not counted', () => {
    assert.ok(!classifyRow('working', cleanRow({}, { valid_until: NOW - 10, is_live: false, superseded_by: 9 }), opts).includes('expired_but_live'));
    assert.ok(!classifyRow('working', cleanRow({}, { valid_until: NOW + 10 }), opts).includes('expired_but_live'));
  });
  test('reads valid_until from metadata when the column is absent', () => {
    const r = cleanRow({ valid_until: NOW - 10 }); delete r.valid_until;
    assert.ok(classifyRow('working', r, opts).includes('expired_but_live'));
  });
});

testGroup('redacted_spans', () => {
  test('a row stored with masked spans is counted; zero or absent is not', () => {
    assert.ok(classifyRow('working', cleanRow({ redacted_spans: 2 }), opts).includes('redacted_spans'));
    assert.ok(!classifyRow('working', cleanRow({ redacted_spans: 0 }), opts).includes('redacted_spans'));
  });
});

testGroup('tagFamilies - consolidation candidates by tag overlap', () => {
  const row = (id, tags) => ({ id, metadata: { tags } });
  test('three rows sharing three tags form one family', () => {
    const fams = tagFamilies([row(1, ['a', 'b', 'c', 'x']), row(2, ['a', 'b', 'c']), row(3, ['c', 'b', 'a', 'y']), row(4, ['q', 'r', 's'])]);
    assert.deepStrictEqual(fams, [[1, 2, 3]]);
  });
  test('two rows are not a family; sharing only two tags does not link', () => {
    assert.deepStrictEqual(tagFamilies([row(1, ['a', 'b', 'c']), row(2, ['a', 'b', 'c'])]), []);
    assert.deepStrictEqual(tagFamilies([row(1, ['a', 'b', 'x']), row(2, ['a', 'b', 'y']), row(3, ['a', 'b', 'z'])]), []);
  });
  test('families are transitive (1~2, 2~3 links 1 and 3)', () => {
    const fams = tagFamilies([row(1, ['a', 'b', 'c']), row(2, ['a', 'b', 'c', 'd', 'e']), row(3, ['c', 'd', 'e'])]);
    assert.deepStrictEqual(fams, [[1, 2, 3]]);
  });
  test('rows with fewer than three tags never join', () => {
    assert.deepStrictEqual(tagFamilies([row(1, ['a', 'b']), row(2, ['a', 'b']), row(3, ['a', 'b'])]), []);
  });
  test('a family larger than maxFamily is a topic, not a candidate, and is not reported', () => {
      const big = Array.from({ length: 9 }, (_, i) => row(i + 1, ['a', 'b', 'c']));
      assert.deepStrictEqual(tagFamilies(big), []);
      assert.deepStrictEqual(tagFamilies(big, { maxFamily: 9 }), [[1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  });
  test('legacy string metadata is parsed', () => {
    const fams = tagFamilies([{ id: 1, metadata: JSON.stringify({ tags: ['a', 'b', 'c'] }) }, row(2, ['a', 'b', 'c']), row(3, ['a', 'b', 'c'])]);
    assert.deepStrictEqual(fams, [[1, 2, 3]]);
  });
});

testGroup('classifyRow never throws', () => {
  test('null, string, and empty rows', () => {
    assert.deepStrictEqual(classifyRow('working', null, opts), []);
    assert.deepStrictEqual(classifyRow('working', 'x', opts), []);
    const g = classifyRow('semantic', {}, opts);
    assert.ok(Array.isArray(g));
  });
});

// --- classifyPointer -------------------------------------------------------
// An open session has no transcript yet, because a transcript is written at
// close. Counting that as a disagreement made the count climb through a working
// session and drop at wrap-up - noise in the one class meant to be read.

const HOUR = 3600;
const CLOSED_THROUGH = 1_789_000_000;              // newest moment any transcript covers
const WINDOW = { session_start: new Date((CLOSED_THROUGH - 2 * HOUR) * 1000), session_end: new Date(CLOSED_THROUGH * 1000) };
const at = (t) => ({ source_session_id: '2026-09-12_some-session', timestamp: t });

testGroup('classifyPointer - an open session is not a disagreement', () => {
  test('no transcript, entry NEWER than the newest one: pending, not a disagreement', () => {
    const v = classifyPointer(at(CLOSED_THROUGH + HOUR), null, CLOSED_THROUGH);
    assert.strictEqual(v.kind, 'pending');
    assert.match(v.finding, /has not been written yet/);
  });

  test('THE CHECK STILL BITES: no transcript, entry OLDER than the newest one, so later sessions closed and this one was never saved', () => {
    const v = classifyPointer(at(CLOSED_THROUGH - 5 * HOUR), null, CLOSED_THROUGH);
    assert.strictEqual(v.kind, 'disagrees');
    assert.match(v.finding, /never written/);
  });

  test('an empty transcript store makes every absence pending - a new install has closed nothing', () => {
    assert.strictEqual(classifyPointer(at(CLOSED_THROUGH - 99 * HOUR), null, null).kind, 'pending');
  });

  test('an entry with no usable timestamp is pending, never accused', () => {
    assert.strictEqual(classifyPointer({ source_session_id: 's' }, null, CLOSED_THROUGH).kind, 'pending');
  });

  test('a pointer inside its session window agrees', () => {
    assert.strictEqual(classifyPointer(at(CLOSED_THROUGH - HOUR), WINDOW, CLOSED_THROUGH).kind, 'agrees');
  });

  test('a pointer far outside its session window still disagrees, and says so', () => {
    const v = classifyPointer(at(CLOSED_THROUGH + 48 * HOUR), WINDOW, CLOSED_THROUGH);
    assert.strictEqual(v.kind, 'disagrees');
    assert.match(v.finding, /outside the session/);
  });

  test('an entry with no pointer is not a finding of any kind', () => {
    assert.strictEqual(classifyPointer({ timestamp: CLOSED_THROUGH }, null, CLOSED_THROUGH).kind, 'agrees');
    assert.strictEqual(classifyPointer(null, null, CLOSED_THROUGH).kind, 'agrees');
  });

  test('both classes are declared, and pending says it is not a defect', () => {
    assert.ok(GAP_CLASSES.pointers_pending_transcript, 'class not declared');
    assert.match(GAP_CLASSES.pointers_pending_transcript, /[Nn]ot a defect/);
    assert.ok(GAP_CLASSES.pointer_disagreements);
  });
});

summary('Gaps Test Summary');
