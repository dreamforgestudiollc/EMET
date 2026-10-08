/**
 * EMET - read-predicate tests.
 *
 * These exist because a default was flipped on 2026-09-13 (a superseded parent
 * now surfaces, marked) and the full suite passed unchanged - which meant the
 * OLD default had never been covered either. A default nothing asserts is a
 * default that can be reversed by accident.
 *
 * Pure functions over objects: no database, no clock beyond the one passed in.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { expiryFilter, notSupersededFilter, livenessFilter, withLiveness } from '../src/database.js';


const json = (o) => JSON.stringify(o);
const hasSupersessionClause = (f) => json(f).includes('superseded_by');
const hasExpiryClause = (f) => json(f).includes('valid_until');

testGroup('Expiry and supersession are separate ideas', () => {
  test('expiryFilter carries no supersession clause', () => {
    assert.ok(hasExpiryClause(expiryFilter()), 'expiry clause missing');
    assert.ok(!hasSupersessionClause(expiryFilter()), 'expiry filter must not mention superseded_by');
  });

  test('notSupersededFilter carries no expiry clause', () => {
    assert.deepStrictEqual(notSupersededFilter(), { superseded_by: null });
    assert.ok(!hasExpiryClause(notSupersededFilter()), 'supersession filter must not mention valid_until');
  });

  test('livenessFilter still carries both, for callers that want only live entries', () => {
    const f = livenessFilter();
    assert.ok(hasSupersessionClause(f) && hasExpiryClause(f), json(f));
  });
});

testGroup('withLiveness - the regression this fixes', () => {
  test('THE BUG: asking for superseded entries used to drop the expiry filter too', () => {
    const f = withLiveness(null, true);
    assert.ok(hasExpiryClause(f),
      `include_superseded must not resurrect EXPIRED entries; got ${json(f)}`);
  });

  test('include_superseded: true returns expiry only - the parent surfaces', () => {
    const f = withLiveness(null, true);
    assert.ok(!hasSupersessionClause(f), `superseded entries must not be excluded; got ${json(f)}`);
  });

  test('include_superseded: false still excludes superseded AND expired', () => {
    const f = withLiveness(null, false);
    assert.ok(hasSupersessionClause(f) && hasExpiryClause(f), json(f));
  });

  test('a caller filter survives alongside the predicate, both ways', () => {
    for (const inc of [true, false]) {
      const f = withLiveness({ layer: 'semantic' }, inc);
      assert.ok(json(f).includes('semantic'), `caller filter lost when includeSuperseded=${inc}: ${json(f)}`);
      assert.ok(hasExpiryClause(f), `expiry lost when includeSuperseded=${inc}: ${json(f)}`);
    }
  });

  test('an existing $or in the caller filter is not clobbered', () => {
    const caller = { $or: [{ a: 1 }, { b: 2 }] };
    const f = withLiveness(caller, false);
    assert.ok(Array.isArray(f.$and), `expected $and wrapping, got ${json(f)}`);
    assert.ok(json(f).includes('"a":1') && json(f).includes('"b":2'), json(f));
  });
});

summary('Read Predicate Test Summary');
