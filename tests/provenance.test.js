/**
 * EMET - provenance tests.
 *
 * The pointer and the timestamp window are two links of different kinds, and the
 * thing that keeps them from being ambiguity is precedence. That rule is what
 * these assert: pointer wins when present, timestamp is the fallback, never the
 * other way round and never a blend of the two.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import {
  validateProvenance, provenanceColumns, resolveProvenance, crossCheckProvenance, FALLBACK_WINDOW_SECONDS
} from '../src/provenance.js';
import { ValidationError } from '../src/validation.js';






testGroup('validateProvenance accepts the two honest shapes', () => {
  test('a transcript span', () => {
    const r = validateProvenance({ session_id: '2026-09-03_x', exchange_start: 4, exchange_end: 9 });
    assert.strictEqual(r.session_id, '2026-09-03_x');
    assert.strictEqual(r.exchange_start, 4);
    assert.strictEqual(r.exchange_end, 9);
  });
  test('a single exchange - end defaults to start', () => {
    assert.strictEqual(validateProvenance({ session_id: 's', exchange_start: 3 }).exchange_end, 3);
  });
  test('a session with no range at all', () => {
    const r = validateProvenance({ session_id: 's' });
    assert.strictEqual(r.exchange_start, null);
  });
  test('a consolidation of other entries', () => {
    assert.deepStrictEqual(validateProvenance({ entries: [12, 44] }).entries, [12, 44]);
  });
  test('null means no provenance, not an error', () => {
    assert.strictEqual(validateProvenance(null), null);
    assert.strictEqual(validateProvenance(undefined), null);
  });
});

testGroup('validateProvenance refuses what would become a false citation', () => {
  test('both shapes at once is rejected - an entry has one origin', () => {
    assert.throws(() => validateProvenance({ session_id: 's', entries: [1] }), ValidationError);
  });
  test('an empty object is rejected rather than stored as a meaningless pointer', () => {
    assert.throws(() => validateProvenance({}), ValidationError);
  });
  test('an empty entries list is rejected', () => {
    assert.throws(() => validateProvenance({ entries: [] }), ValidationError);
  });
  test('non-integer entry ids are rejected', () => {
    assert.throws(() => validateProvenance({ entries: [1, 'two'] }), ValidationError);
  });
  test('a reversed exchange range is rejected', () => {
    assert.throws(() => validateProvenance({ session_id: 's', exchange_start: 9, exchange_end: 4 }), ValidationError);
  });
  test('an array is not an object', () => {
    assert.throws(() => validateProvenance([1, 2]), ValidationError);
  });
});

testGroup('provenanceColumns writes explicit nulls', () => {
  test('no provenance still produces every column', () => {
    const c = provenanceColumns(null);
    assert.deepStrictEqual(Object.keys(c).sort(),
      ['derived_from_ids', 'source_exchange_end', 'source_exchange_start', 'source_session_id']);
    assert.strictEqual(c.source_session_id, null);
  });
  test('a span fills the session columns and leaves entries null', () => {
    const c = provenanceColumns({ session_id: 's', exchange_start: 1, exchange_end: 2 });
    assert.strictEqual(c.source_session_id, 's');
    assert.strictEqual(c.derived_from_ids, null);
  });
  test('a consolidation fills entries and leaves the session columns null', () => {
    const c = provenanceColumns({ entries: [7] });
    assert.deepStrictEqual(c.derived_from_ids, [7]);
    assert.strictEqual(c.source_session_id, null);
  });
});

testGroup('resolveProvenance - precedence is what stops the two links conflicting', () => {
  test('a pointer is used when present', () => {
    const r = resolveProvenance({ source_session_id: 's', source_exchange_start: 2, source_exchange_end: 5, timestamp: 1000 });
    assert.strictEqual(r.method, 'pointer');
    assert.strictEqual(r.exact, true);
  });
  test('the pointer wins even though a timestamp is also present', () => {
    const r = resolveProvenance({ source_session_id: 's', timestamp: 1000 });
    assert.strictEqual(r.method, 'pointer');
    assert.strictEqual(r.timestamp_start, undefined);
  });
  test('a consolidation resolves to its source entries', () => {
    const r = resolveProvenance({ derived_from_ids: [3, 4], timestamp: 1000 });
    assert.strictEqual(r.method, 'entries');
    assert.deepStrictEqual(r.entries, [3, 4]);
  });
  test('an entry with no pointer falls back to a timestamp window', () => {
    const r = resolveProvenance({ timestamp: 10000 });
    assert.strictEqual(r.method, 'timestamp');
    assert.strictEqual(r.exact, false);
    assert.strictEqual(FALLBACK_WINDOW_SECONDS, 3600);
    assert.strictEqual(r.timestamp_start, 6400);
    assert.strictEqual(r.timestamp_end, 13600);
  });
  test('the fallback warns that it is approximate', () => {
    assert(/approximate/i.test(resolveProvenance({ timestamp: 1 }).how));
  });
  test('the fallback warns that an empty result is not proof', () => {
    assert(/not proof/i.test(resolveProvenance({ timestamp: 1 }).how));
  });
  test('an entry with neither says the claim is unsourced rather than guessing', () => {
    const r = resolveProvenance({ id: 1 });
    assert.strictEqual(r.method, 'none');
    assert(/unsourced/i.test(r.how));
  });
});

testGroup('crossCheckProvenance - the reason to keep both', () => {
  const HOUR = 3600;
  test('agrees when the entry sits inside the session it points at', () => {
    const r = crossCheckProvenance(
      { source_session_id: 's', timestamp: 1000 * HOUR },
      { session_start: 999 * HOUR, session_end: 1001 * HOUR });
    assert.strictEqual(r.agrees, true);
  });
  test('agrees when the entry sits just outside, within tolerance', () => {
    const r = crossCheckProvenance(
      { source_session_id: 's', timestamp: 1002 * HOUR },
      { session_start: 999 * HOUR, session_end: 1001 * HOUR });
    assert.strictEqual(r.agrees, true);
  });
  test('disagrees when the entry is nowhere near the session it names', () => {
    const r = crossCheckProvenance(
      { source_session_id: 's', timestamp: 2000 * HOUR },
      { session_start: 999 * HOUR, session_end: 1001 * HOUR });
    assert.strictEqual(r.agrees, false);
    assert(/disagree/i.test(r.finding));
  });
  test('reports a pointer naming a session that does not exist', () => {
    const r = crossCheckProvenance({ source_session_id: 'ghost', timestamp: 1 }, null);
    assert.strictEqual(r.agrees, false);
    assert(/does not exist/i.test(r.finding));
  });
  test('says nothing about an entry with no pointer', () => {
    assert.strictEqual(crossCheckProvenance({ timestamp: 1 }, {}).checked, false);
  });
  test('never throws and never blocks - a suspicious pointer is a finding', () => {
    assert.doesNotThrow(() => crossCheckProvenance({ source_session_id: 's', timestamp: 1 }, { session_start: 'nonsense' }));
  });
});

summary('PROVENANCE TEST SUMMARY');
