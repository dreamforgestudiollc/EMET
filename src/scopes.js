/**
 * Tool scopes. Advertised as emet.read and emet.write.
 * Empty list = owner / full access (today's tokens).
 * A guest token will carry only the scopes it was granted.
 *
 * The scope is DERIVED from the tool's annotation (2026-09-27, code audit 1.2):
 * a tool whose readOnlyHint is true needs emet.read, every other tool needs
 * emet.write. Until then two hand-kept sets lived here beside the annotation
 * table and the tool list - a third place a tool name had to be added, with no
 * guard when it was not (an unlisted tool silently fell to emet.write).
 */

import { TOOL_ANNOTATIONS } from './annotations.js';

// A tool whose scope deliberately differs from its annotation.
// emet_status without probe is a read, so a guest can see that the store is up.
// emet_status with probe: true writes a document, so scopeForTool returns
// emet.write for that call. emet_session_open stamps the drop list a board
// edit trusts, so it requires emet.write even though a quick read of the
// annotation table is not the whole story — the override list no longer
// grants it to a read token.
const SCOPE_OVERRIDES = Object.freeze({
  emet_status: 'emet.read',
  emet_initialize: 'emet.read'
});

export function scopeForTool(name, args = null) {
  // Opening a session stamps the drop list the board guard trusts, and the
  // status probe writes. Both need emet.write. A status call without probe
  // stays a read.
  if (name === 'emet_session_open') return 'emet.write';
  if (name === 'emet_status' && args && args.probe === true) return 'emet.write';
  if (SCOPE_OVERRIDES[name]) return SCOPE_OVERRIDES[name];
  const a = TOOL_ANNOTATIONS[name];
  if (a && a.readOnlyHint === true) return 'emet.read';
  return 'emet.write';
}

export function scopesAllow(scopes, name, opts = {}) {
  // A presented HTTP token with no scopes is not the owner. Stdio (no token)
  // and a passphrase token that carries emet / * still are.
  if (opts.http === true && opts.authenticated === true && (!Array.isArray(scopes) || scopes.length === 0)) return false;
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  if (scopes.includes('*') || scopes.includes('emet')) return true;
  const need = scopeForTool(name, opts.args || null);
  return scopes.includes(need);
}

/**
 * Security audit 2026-09-29: an empty scope list means OWNER / full access
 * (scopesAllow above), which is right for a passphrase login and wrong for a
 * guest. An invite that carries no usable scopes must not mint a token, or a
 * guest would silently become the owner. Returns the invite's scopes when at
 * least one is a real scope, else null (the caller refuses the login).
 * Invites are frozen today (invites.js); this holds the line for when they are not.
 */
export const KNOWN_SCOPES = Object.freeze(['emet.read', 'emet.write']);
export function guestScopesOrNull(scopes) {
  if (!Array.isArray(scopes)) return null;
  const kept = [...new Set(scopes.filter((s) => KNOWN_SCOPES.includes(s)))];
  return kept.length ? kept : null;
}

/**
 * Refresh may only keep or narrow what was granted (multi-user report v2,
 * defect 1, 2026-10-01). Until then a refresh grant replaced the stored scopes
 * with whatever the client asked for, so a read-only invite token - or any
 * restricted token - could refresh to `emet` or `*` and hold full access.
 *
 * Both sides are expanded before comparing, so an alias can never widen:
 *   - granted [] or containing `emet` / `*` is FULL (what scopesAllow honours):
 *     every request is within it - a passphrase token keeps refreshing exactly
 *     as before, with whatever scope its host sends;
 *   - otherwise a requested `emet` or `*` stands for every known scope
 *     (KNOWN_SCOPES - all scopeForTool can ask for), and each requested scope
 *     must already be granted. Any other requested string must be granted
 *     verbatim.
 * Returns the scopes that are not covered (empty = the request is within).
 */
export const FULL_SCOPE_ALIASES = Object.freeze(['emet', '*']);
export function isFullScopeList(scopes) {
  return !Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => FULL_SCOPE_ALIASES.includes(s));
}
export function scopesNotGranted(granted, requested) {
  if (isFullScopeList(granted)) return [];
  const have = new Set(granted);
  const wider = [];
  for (const r of requested || []) {
    const needs = FULL_SCOPE_ALIASES.includes(r) ? KNOWN_SCOPES : [r];
    if (!needs.every((n) => have.has(n))) wider.push(r);
  }
  return [...new Set(wider)];
}

export function deniedMessage(name, scopes, args = null) {
  return `This login is not allowed to call ${name}. Granted: ${(scopes || []).join(', ') || '(none)'}. Needs ${scopeForTool(name, args)}.`;
}
