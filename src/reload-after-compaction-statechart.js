/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Reload-after-compaction statechart. A session works from a fresh
 * initialize. A compaction marker or a long gap without that initialize, a
 * write against a stale HANDOFF or STATE version, and a close with no
 * transcript append are warnings. The check does not rewrite HANDOFF or
 * STATE, does not delete, and does not block. Served on /statechart. The
 * same picture is docs/reload-after-compaction-statechart.md.
 */

export const RELOAD_AFTER_COMPACTION_MERMAID = `stateDiagram-v2
  [*] --> CheckOff
  CheckOff --> CheckOff: continuity flag stays off
  CheckOff --> Working: initialize with the flag on
  Working --> Working: append inside the gap window
  Working --> Compacted: host declares compaction
  Working --> Gap: last append is older than the gap
  Working --> StaleDocs: live HANDOFF or STATE is newer than the initialize
  Working --> NoTranscript: close with no transcript append
  Working --> Unreadable: the check could not be read
  Compacted --> Reloaded: fresh complete initialize
  Compacted --> ReloadDue: no fresh complete initialize
  Gap --> Reloaded: fresh complete initialize
  Gap --> ReloadDue: no fresh complete initialize
  Reloaded --> Working: work from HANDOFF and STATE
  ReloadDue --> Working: the warning does not block
  StaleDocs --> Working: the warning does not block
  NoTranscript --> Working: the warning does not block
  Unreadable --> Working: the next call reads again
  Reloaded --> Compacted: host declares compaction again`;

export const RELOAD_AFTER_COMPACTION_STEPS = Object.freeze([
  'The continuity flag starts off. Initialize still carries the reload rule. It shows no reload warning.',
  'With the flag on, initialize records the HANDOFF and STATE versions it served. That call is the reload. It does not write those documents.',
  'A host declares compaction with compacted: true, or after_compaction: true. A complete initialize served within the fresh window covers it. The session continues from HANDOFF and STATE.',
  'A compaction with no fresh complete initialize returns a warning. The call is not blocked.',
  'A session whose last transcript activity is older than the gap, and which did not pass a fresh initialize, returns a warning. The call is not blocked.',
  'A write whose initialize saw an older HANDOFF or STATE version returns a warning. The server does not rewrite either document.',
  'A close with no transcript append returns a warning and lists it under warnings. The close state stays what the receipts decide. The transcript is not deleted.',
  'A check that could not be read shows unreadable and does not warn. Asking for the phase-2 block still does not block.'
]);

const PHASES = new Set([
  'CheckOff', 'Working', 'Compacted', 'Gap', 'ReloadDue', 'Reloaded',
  'StaleDocs', 'NoTranscript', 'Unreadable'
]);
const WARN = new Set(['ReloadDue', 'StaleDocs', 'NoTranscript']);

function blank(state, extra = {}) {
  return {
    phase: state.phase,
    flag: state.flag,
    warning: false,
    handoffMutated: false,
    stateMutated: false,
    deleted: false,
    blocked: false,
    ...extra,
    handoffMutated: false,
    stateMutated: false,
    deleted: false,
    blocked: false
  };
}

/**
 * One step of the diagram. An event that cannot happen in this phase returns
 * null. Records stay unchanged and the call stays unblocked on every step.
 */
export function reloadAfterCompactionStep(state, event) {
  if (!state || !PHASES.has(state.phase)) return null;
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === 'flag_off') {
    if (state.flag !== 'off' || state.phase !== 'CheckOff') return null;
    return blank(state, { phase: 'CheckOff' });
  }
  if (event.type === 'enable') {
    if (state.flag !== 'off' || state.phase !== 'CheckOff') return null;
    return blank(state, { phase: 'Working', flag: 'warn' });
  }
  if (state.flag !== 'warn') return null;
  if (event.type === 'append') {
    if (state.phase !== 'Working') return null;
    return blank(state, { phase: 'Working' });
  }
  if (event.type === 'declare_compaction') {
    if (state.phase !== 'Working' && state.phase !== 'Reloaded') return null;
    return blank(state, { phase: 'Compacted' });
  }
  if (event.type === 'gap') {
    if (state.phase !== 'Working') return null;
    return blank(state, { phase: 'Gap' });
  }
  if (event.type === 'stale') {
    if (state.phase !== 'Working') return null;
    return blank(state, { phase: 'StaleDocs', warning: true });
  }
  if (event.type === 'close_empty') {
    if (state.phase !== 'Working') return null;
    return blank(state, { phase: 'NoTranscript', warning: true });
  }
  if (event.type === 'unreadable') {
    if (state.phase !== 'Working') return null;
    return blank(state, { phase: 'Unreadable' });
  }
  if (event.type === 'fresh_initialize') {
    if (state.phase !== 'Compacted' && state.phase !== 'Gap') return null;
    return blank(state, { phase: 'Reloaded' });
  }
  if (event.type === 'no_fresh') {
    if (state.phase !== 'Compacted' && state.phase !== 'Gap') return null;
    return blank(state, { phase: 'ReloadDue', warning: true });
  }
  if (event.type === 'continue') {
    if (state.phase !== 'Reloaded' && !WARN.has(state.phase) && state.phase !== 'Unreadable') return null;
    return blank(state, { phase: 'Working' });
  }
  return null;
}

/** A rewrite, a delete, or a block breaks the invariant. */
export function reloadAfterCompactionInvariant(state) {
  if (!state) return false;
  if (state.handoffMutated !== false || state.stateMutated !== false) return false;
  if (state.deleted !== false || state.blocked !== false) return false;
  if (!PHASES.has(state.phase)) return false;
  if (state.flag === 'off' && (state.phase !== 'CheckOff' || state.warning !== false)) return false;
  if (state.warning === true && !WARN.has(state.phase)) return false;
  if (state.warning !== true && WARN.has(state.phase)) return false;
  if (state.phase === 'Unreadable' && state.warning !== false) return false;
  if (state.phase === 'Reloaded' && state.warning !== false) return false;
  return true;
}
