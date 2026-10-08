/**
 * Importance buckets (the owner 2026-09-26): the word differentiates;
 * the float is the midpoint unless a degree is named.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import {
  IMPORTANCE_BUCKETS, IMPORTANCE_DEGREES, bucketForLayer, resolveImportance, bandFor
} from '../src/layers.js';
import { validateFilters, RECOGNISED_FILTER_KEYS } from '../src/validation.js';


testGroup('Vocabulary', () => {
  test('five buckets cover all six layers', () => {
    const covered = Object.values(IMPORTANCE_BUCKETS).flatMap(s => s.layers).sort();
    assert.deepStrictEqual(covered, ['episodic', 'identity', 'meta', 'procedural', 'semantic', 'working']);
  });
  test('layer default bucket names', () => {
    assert.strictEqual(bucketForLayer('identity'), 'constitutive');
    assert.strictEqual(bucketForLayer('semantic'), 'durable');
    assert.strictEqual(bucketForLayer('meta'), 'durable');
    assert.strictEqual(bucketForLayer('procedural'), 'binding');
    assert.strictEqual(bucketForLayer('episodic'), 'event');
    assert.strictEqual(bucketForLayer('working'), 'scratch');
  });
  test('degrees are low mid high', () => {
    assert.deepStrictEqual([...IMPORTANCE_DEGREES], ['low', 'mid', 'high']);
  });
});

testGroup('resolveImportance', () => {
  test('omitted importance defaults to layer midpoint and layer bucket', () => {
    const r = resolveImportance('procedural', undefined);
    assert.strictEqual(r.bucket, 'binding');
    assert.strictEqual(r.degree, 'mid');
    assert.strictEqual(r.defaulted, true);
    assert.strictEqual(r.importance, bandFor('procedural').midpoint);
  });
  test('bucket word stores the midpoint', () => {
    const r = resolveImportance('semantic', 'durable');
    assert.strictEqual(r.bucket, 'durable');
    assert.strictEqual(r.degree, 'mid');
    assert.strictEqual(r.importance, 0.75);
    assert.strictEqual(r.defaulted, false);
  });
  test('bucket:high uses the top of the range', () => {
    const r = resolveImportance('semantic', 'durable:high');
    assert.strictEqual(r.degree, 'high');
    assert.strictEqual(r.importance, 0.9);
  });
  test('bucket:low uses the bottom of the range', () => {
    const r = resolveImportance('working', 'scratch:low');
    assert.strictEqual(r.importance, 0.3);
  });
  test('a number is kept and tagged with bucket plus inferred degree', () => {
    const r = resolveImportance('procedural', 0.8);
    assert.strictEqual(r.importance, 0.8);
    assert.strictEqual(r.bucket, 'binding');
    assert.strictEqual(r.degree, 'high');
    assert.strictEqual(r.numeric_given, true);
  });
  test('unknown bucket throws', () => {
    assert.throws(() => resolveImportance('semantic', 'urgent'), /Unknown importance bucket/);
  });
});

testGroup('query filter', () => {
  test('importance_bucket is a recognised filter key', () => {
    assert(RECOGNISED_FILTER_KEYS.includes('importance_bucket'));
  });
  test('durable maps onto 0.6–0.9 so older rows still match', () => {
    const f = validateFilters({ importance_bucket: 'durable' });
    assert.strictEqual(f.importance_min, 0.6);
    assert.strictEqual(f.importance_max, 0.9);
    assert.strictEqual(f.importance_bucket, 'durable');
  });
  test('unknown bucket is rejected', () => {
    assert.throws(() => validateFilters({ importance_bucket: 'urgent' }), /Unknown bucket/);
  });
});

summary('Importance buckets 2026-09-26');
