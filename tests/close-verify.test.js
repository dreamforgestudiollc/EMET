/**
 * EMET - close verify that blocks skipped wrap steps (2026-09-26).
 *
 * The owner's requirement (decision records): the wrap steps HAVE TO BE
 * FOLLOWED whichever model hosts, and a skipped step blocks the close. The
 * four-item verify is working documents, episodic session record, board and
 * verbatim transcript read back from MongoDB; the handoff is written last.
 * Receipts are required from the first deploy; an uncorroborated transcript
 * blocks rather than passing.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { checkReceipts, buildSpeak, RECEIPT_FIELDS, parseReceipts } from '../src/session.js';


const T0 = Date.parse('2026-09-26T22:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();

function observed(overrides = {}) {
  return {
    documents: [
      { doc_id: 'HANDOFF.md', exists: true, version: 181, updated_at: at(30), updated_this_session: true },
      { doc_id: 'STATE.md', exists: true, version: 356, updated_at: at(20), updated_this_session: true },
      { doc_id: 'staging/close.md', exists: true, version: 3, updated_at: at(10), updated_this_session: true }
    ],
    episodic: { id: 90, timestamp_ms: T0 + 25 * 60000 },
    transcript: {
      present: true, split: true, intact: true,
      base_session_id: '2026-09-26_host-init',
      parts_found: ['2026-09-26_host-init_verbatim_part1', '2026-09-26_host-init_verbatim_part2'],
      highest_exchange_index: 11
    },
    handoff_doc: 'HANDOFF.md',
    ...overrides
  };
}

function receipts(overrides = {}) {
  return {
    working_docs: ['staging/close.md'],
    episodic_id: 90,
    board_doc: 'STATE.md',
    board_version: 356,
    transcript_session_id: '2026-09-26_host-init',
    transcript_parts: ['2026-09-26_host-init_verbatim_part1', '2026-09-26_host-init_verbatim_part2'],
    transcript_exchanges: 11,
    handoff_version: 181,
    ...overrides
  };
}

testGroup('receipts that match the store', () => {
  const r = checkReceipts(receipts(), observed());
  test('pass with no problems', () => { assert.strictEqual(r.supplied, true); assert.deepStrictEqual(r.problems, []); });
  test('[] is an acceptable working_docs receipt', () =>
    assert.deepStrictEqual(checkReceipts(receipts({ working_docs: [] }), observed()).problems, []));
  test('a part id as transcript_session_id resolves to its base', () =>
    assert.deepStrictEqual(checkReceipts(receipts({ transcript_session_id: '2026-09-26_host-init_verbatim_part2' }), observed()).problems, []));
});

testGroup('omitted receipts block', () => {
  const none = checkReceipts(undefined, observed());
  test('no receipts object is reported as not supplied', () => {
    assert.strictEqual(none.supplied, false);
    assert.ok(none.problems[0].startsWith('receipts not supplied'));
  });
  for (const field of Object.keys(RECEIPT_FIELDS)) {
    test(`a missing ${field} receipt is named`, () => {
      const rc = receipts(); delete rc[field];
      assert.ok(checkReceipts(rc, observed()).problems.some((p) => p.includes(`receipt missing: ${field}`)));
    });
  }
});

testGroup('each of the four items is checked against the store', () => {
  test('working document not updated this session', () => {
    const obs = observed();
    obs.documents[2] = { ...obs.documents[2], updated_this_session: false };
    assert.ok(checkReceipts(receipts(), obs).problems.some((p) => p.includes('staging/close.md was not updated')));
  });
  test('working document that does not exist', () =>
    assert.ok(checkReceipts(receipts({ working_docs: ['threads/nope.md'] }), observed()).problems.some((p) => p.includes('does not exist'))));
  test('episodic record not found in this session', () =>
    assert.ok(checkReceipts(receipts(), observed({ episodic: null })).problems.some((p) => p.includes('episodic entry 90'))));
  test('board version mismatch', () =>
    assert.ok(checkReceipts(receipts({ board_version: 355 }), observed()).problems.some((p) => p.includes('receipt says v355, store holds v356'))));
  test('transcript part list that was not read back', () =>
    assert.ok(checkReceipts(receipts({ transcript_parts: ['2026-09-26_host-init_verbatim_part1'] }), observed()).problems.some((p) => p.startsWith('transcript parts'))));
  test('transcript exchange count mismatch', () =>
    assert.ok(checkReceipts(receipts({ transcript_exchanges: 9 }), observed()).problems.some((p) => p.includes('receipt says 9, store holds 11'))));
  test('transcript receipt for another session', () =>
    assert.ok(checkReceipts(receipts({ transcript_session_id: '2026-09-26_grok-init' }), observed()).problems.some((p) => p.includes('session checked is'))));
});

testGroup('the handoff is written last', () => {
  test('handoff version mismatch', () =>
    assert.ok(checkReceipts(receipts({ handoff_version: 180 }), observed()).problems.some((p) => p.startsWith('handoff: receipt says v180'))));
  test('board written after the handoff blocks', () => {
    const obs = observed();
    obs.documents[1] = { ...obs.documents[1], updated_at: at(40) };
    assert.ok(checkReceipts(receipts(), obs).problems.some((p) => p.includes('handoff was not the last write') && p.includes('STATE.md')));
  });
  test('episodic record written after the handoff blocks', () =>
    assert.ok(checkReceipts(receipts(), observed({ episodic: { id: 90, timestamp_ms: T0 + 45 * 60000 } })).problems.some((p) => p.includes('episodic 90'))));
});

testGroup('speak lines', () => {
  const lines = buildSpeak({ state: 'complete', documents: observed().documents, receipts: receipts(),
    episodic: observed().episodic, transcript: observed().transcript, handoff_doc: 'HANDOFF.md', board_doc: 'STATE.md' });
  test('six lines, in protocol order', () => {
    assert.strictEqual(lines.length, 6);
    ['Working documents', 'Session record', 'Board', 'Transcript', 'Handoff', 'Close state'].forEach((k, i) => assert.ok(lines[i].startsWith(k), lines[i]));
  });
  test('transcript line names the parts, count, intact and the MongoDB collection', () => {
    assert.ok(lines[3].includes('_verbatim_part1') && lines[3].includes('11 exchanges') && lines[3].includes('intact yes') && lines[3].includes('collection transcripts'));
  });
  test('close state is the last line', () => assert.strictEqual(lines[5], 'Close state: complete'));
  test('without receipts the lines say so rather than inventing', () => {
    const bare = buildSpeak({ state: 'blocked', documents: [], receipts: null, episodic: null, transcript: { present: false }, handoff_doc: 'HANDOFF.md', board_doc: null });
    assert.ok(bare[0].includes('no receipt') && bare[1].includes('not found') && bare[3].includes('not found in MongoDB'));
  });
});

// Found live at the first close under the new rule: the host sent receipts and
// the server read none. Receipts may arrive as an object or as JSON text.
testGroup('receipts as object or JSON text', () => {
  test('an object passes through', () => assert.deepStrictEqual(parseReceipts({ episodic_id: 1 }), { episodic_id: 1 }));
  test('JSON text is parsed', () => assert.deepStrictEqual(parseReceipts('{"episodic_id": 588}'), { episodic_id: 588 }));
  test('text that is not JSON is not supplied', () => assert.strictEqual(parseReceipts('{not json'), null));
  test('an array is not receipts', () => assert.strictEqual(parseReceipts([1, 2]), null));
  test('absent is not supplied', () => assert.strictEqual(parseReceipts(undefined), null));
});

summary('Close Verify Test Summary');
