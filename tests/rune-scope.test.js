/**
 * Scope prefix matching, kept after the sandbox runner was removed.
 * doc:foo matches doc:foo and doc:foo/bar, and does not match doc:foobar.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';

const { scopePermits, hintsComplete, layerOf, docIdOf } = await import('../src/rune-scope.js');

testGroup('scope prefixes', () => {
  test('doc:foo matches its children and not doc:foobar', () => {
    assert.strictEqual(scopePermits(['doc:foo'], 'doc:foo'), true);
    assert.strictEqual(scopePermits(['doc:foo'], 'doc:foo/bar'), true);
    assert.strictEqual(scopePermits(['doc:foo'], 'doc:foobar'), false);
    assert.strictEqual(scopePermits(['working'], 'working'), true);
    assert.strictEqual(scopePermits(['working'], 'semantic'), false);
    assert.strictEqual(scopePermits([], 'working'), false);
  });

  test('a missing hint is incomplete, and destructive or open-world is refused', () => {
    assert.strictEqual(hintsComplete(null), false);
    assert.strictEqual(hintsComplete({ readOnlyHint: true, destructiveHint: false, idempotentHint: true }), false);
    assert.strictEqual(hintsComplete({
      readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: false
    }), false);
    assert.strictEqual(hintsComplete({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
    }), false);
    assert.strictEqual(hintsComplete({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false
    }), true);
  });

  test('a layer name and a doc id come apart', () => {
    assert.strictEqual(layerOf('working'), 'working');
    assert.strictEqual(layerOf('doc:foo'), null);
    assert.strictEqual(docIdOf('doc:foo/bar'), 'foo/bar');
    assert.strictEqual(docIdOf('doc:../secret'), null);
    assert.strictEqual(docIdOf('working'), null);
  });
});

await summary('RUNE SCOPE');
