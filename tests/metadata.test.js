/**
 * EMET - metadata shape tests (2026-09-05).
 *
 * No database. parseMetadata is the one place that knows the field has had two
 * shapes; if it is wrong, every reader is wrong. isMetadataPath decides what the
 * SQL dialect will pass to Mongo as a field path, so its rejections matter at
 * least as much as its acceptances.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { parseMetadata, isLegacyMetadataString, isMetadataPath } from '../src/metadata.js';


testGroup('parseMetadata - both stored shapes read identically', () => {
  const obj = { source: 'cli', tags: ['a', 'b'], custom: { supersedes: 7 } };
  test('an object is returned as-is (same reference)', () => assert.strictEqual(parseMetadata(obj), obj));
  test('the legacy JSON string parses to a deep-equal object', () => assert.deepStrictEqual(parseMetadata(JSON.stringify(obj)), obj));
  test('nested custom fields survive the string form', () => assert.strictEqual(parseMetadata(JSON.stringify(obj)).custom.supersedes, 7));
});

testGroup('parseMetadata - never throws, never returns a non-object', () => {
  test('null -> {}', () => assert.deepStrictEqual(parseMetadata(null), {}));
  test('undefined -> {}', () => assert.deepStrictEqual(parseMetadata(undefined), {}));
  test('unparseable string -> {}', () => assert.deepStrictEqual(parseMetadata('{not json'), {}));
  test('empty string -> {}', () => assert.deepStrictEqual(parseMetadata(''), {}));
  test('a JSON string encoding an array -> {}', () => assert.deepStrictEqual(parseMetadata('[1,2]'), {}));
  test('a JSON string encoding a number -> {}', () => assert.deepStrictEqual(parseMetadata('42'), {}));
  test('an array value -> {}', () => assert.deepStrictEqual(parseMetadata([1]), {}));
  test('a number value -> {}', () => assert.deepStrictEqual(parseMetadata(3), {}));
});

testGroup('isLegacyMetadataString', () => {
  test('true for a string', () => assert.strictEqual(isLegacyMetadataString('{}'), true));
  test('false for an object', () => assert.strictEqual(isLegacyMetadataString({}), false));
  test('false for null', () => assert.strictEqual(isLegacyMetadataString(null), false));
});

testGroup('isMetadataPath - what the SQL dialect may hand to Mongo as a field path', () => {
  test('accepts metadata.source', () => assert.strictEqual(isMetadataPath('metadata.source'), true));
  test('accepts a nested path', () => assert.strictEqual(isMetadataPath('metadata.custom.supersedes'), true));
  test('rejects bare metadata (that is a top-level column, handled by the whitelist)', () => assert.strictEqual(isMetadataPath('metadata'), false));
  test('rejects a $ operator segment', () => assert.strictEqual(isMetadataPath('metadata.$where'), false));
  test('rejects a segment starting with a digit', () => assert.strictEqual(isMetadataPath('metadata.1abc'), false));
  test('rejects a trailing dot', () => assert.strictEqual(isMetadataPath('metadata.source.'), false));
  test('rejects an empty segment', () => assert.strictEqual(isMetadataPath('metadata..source'), false));
  test('rejects other top-level roots', () => assert.strictEqual(isMetadataPath('content.x'), false));
  test('rejects spaces and brackets', () => { assert.strictEqual(isMetadataPath('metadata.a b'), false); assert.strictEqual(isMetadataPath('metadata.a[0]'), false); });
  test('rejects non-strings', () => assert.strictEqual(isMetadataPath(null), false));
});

summary('Metadata Shape Test Summary');
