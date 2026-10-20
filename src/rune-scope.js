/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 * Licensed under the MIT License - see LICENSE
 *
 * Scope helpers kept with the socket. A client RUNE declares empty reads
 * and writes. Prefix matching is on whole path segments: doc:foo matches
 * doc:foo and doc:foo/bar, and does not match doc:foobar.
 */

const LAYERS = new Set(['identity', 'semantic', 'episodic', 'procedural', 'meta', 'working']);

export function scopePermits(allow, scope) {
  if (!Array.isArray(allow) || typeof scope !== 'string' || scope.length === 0) return false;
  for (const entry of allow) {
    if (typeof entry !== 'string') continue;
    if (entry === scope) return true;
    if (entry.startsWith('doc:') && scope.startsWith(entry + '/')) return true;
  }
  return false;
}

export function layerOf(scope) {
  return LAYERS.has(scope) ? scope : null;
}

export function docIdOf(scope) {
  if (typeof scope !== 'string' || !scope.startsWith('doc:')) return null;
  const id = scope.slice(4);
  if (!id || id.includes('..')) return null;
  return id;
}

/** The four hints are required. A missing one refuses the directive. */
export function hintsComplete(annotations) {
  if (!annotations || typeof annotations !== 'object') return false;
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    if (typeof annotations[key] !== 'boolean') return false;
  }
  if (annotations.destructiveHint !== false || annotations.openWorldHint !== false) return false;
  return true;
}
