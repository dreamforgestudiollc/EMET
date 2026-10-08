import { test, summary } from './harness.js';
import assert from 'assert';
import { scopesAllow, scopeForTool, guestScopesOrNull } from '../src/scopes.js';
import { TOOL_ANNOTATIONS } from '../src/annotations.js';

console.log('\n=== scopes ===');
test('empty scopes allow everything (owner)', () => {
  assert.strictEqual(scopesAllow([], 'save_to_layer'), true);
  assert.strictEqual(scopesAllow([], 'read_doc'), true);
});
test('read token cannot write', () => {
  assert.strictEqual(scopesAllow(['emet.read'], 'save_to_layer'), false);
  assert.strictEqual(scopesAllow(['emet.read'], 'read_doc'), true);
});
test('write token cannot skip needing write for save', () => {
  assert.strictEqual(scopesAllow(['emet.write'], 'save_to_layer'), true);
});
test('star allows all', () => assert.strictEqual(scopesAllow(['*'], 'write_doc'), true));
test('initialize is a read: a read-only token must be able to start', () => assert.strictEqual(scopeForTool('emet_initialize'), 'emet.read'));
test('a read-only token can initialize and cannot open a session', () => {
  assert.strictEqual(scopesAllow(['emet.read'], 'emet_initialize'), true);
  assert.strictEqual(scopesAllow(['emet.read'], 'emet_session_open'), false);
});
test('a status probe needs write; a status read does not', () => {
  assert.strictEqual(scopeForTool('emet_status'), 'emet.read');
  assert.strictEqual(scopeForTool('emet_status', { probe: true }), 'emet.write');
});
test('an empty HTTP token is not the owner', () => {
  assert.strictEqual(scopesAllow([], 'read_doc', { http: true, authenticated: true }), false);
  assert.strictEqual(scopesAllow([], 'read_doc'), true);
});
// 2026-09-27 (code audit 1.2, 1.3): scope derives from the annotation table.
test('every tool needs read iff its annotation is read-only (one override: verify_connection)', () => {
  for (const [name, a] of Object.entries(TOOL_ANNOTATIONS)) {
    const readAnyway = name === 'emet_status' || name === 'emet_initialize';
    const expected = readAnyway ? 'emet.read' : (a.readOnlyHint ? 'emet.read' : 'emet.write');
    assert.strictEqual(scopeForTool(name), expected, name);
  }
});
test('session_close needs write - it records blocked attempts', () => assert.strictEqual(scopeForTool('emet_session_close'), 'emet.write'));
test('an unknown tool needs write, never read', () => assert.strictEqual(scopeForTool('no_such_tool'), 'emet.write'));
// Security audit 2026-09-29: an invite with no usable scopes must not become owner access.
test('guest scopes: empty, missing or unknown-only -> refused (null)', () => {
  assert.strictEqual(guestScopesOrNull([]), null);
  assert.strictEqual(guestScopesOrNull(undefined), null);
  assert.strictEqual(guestScopesOrNull('emet.read'), null);
  assert.strictEqual(guestScopesOrNull(['*']), null);
  assert.strictEqual(guestScopesOrNull(['emet', 'admin']), null);
});
test('guest scopes: real scopes kept, unknown dropped, duplicates collapsed', () => {
  assert.deepStrictEqual(guestScopesOrNull(['emet.read']), ['emet.read']);
  assert.deepStrictEqual(guestScopesOrNull(['emet.read', '*', 'emet.read', 'emet.write']), ['emet.read', 'emet.write']);
});
test('a guest read scope never passes a write tool', () =>
  assert.strictEqual(scopesAllow(guestScopesOrNull(['emet.read', '*']), 'save_to_layer'), false));
test('the approve route refuses an invite without scopes (wiring present)', async () => {
  const fs = await import('fs');
  const src = fs.readFileSync(new URL('../src/http-remote.js', import.meta.url), 'utf8');
  assert.ok(/guestScopesOrNull\(redeemed\.scopes\)/.test(src) && /invite_without_scopes/.test(src));
});
summary('Scopes Test Summary');
