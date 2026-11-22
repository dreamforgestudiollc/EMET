/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Continuity-currency (tip-lag) statechart. Warn, current, documented
 * no-op, no handoff, unreadable, or fallback-only. The gate does not rewrite
 * HANDOFF or STATE and does not block. This is not the wiki page-currency
 * diagram. Served on /statechart. The same picture is
 * docs/continuity-currency-statechart.md. The model is
 * verification/continuity-currency/ContinuityCurrency.tla. It does not
 * enumerate episodic ids.
 */

export const CONTINUITY_CURRENCY_MERMAID = `stateDiagram-v2
  [*] --> GateOff
  GateOff --> GateOff: warn flag stays off
  GateOff --> Comparing: warn flag on
  Comparing --> Current: handoff cites the live material tip
  Comparing --> DocumentedNoOp: documented no-op, no newer material tip
  Comparing --> Current: newer episodic is scratch or diagnosis only
  Comparing --> Current: version number alone
  Comparing --> Warning: material tip is newer
  Comparing --> FallbackOnly: only a fallback tip is newer
  Comparing --> NoHandoff: no handoff to compare
  Comparing --> Unreadable: the comparison could not be read
  Warning --> BlockHeld: block asked, still does not block
  FallbackOnly --> FallbackHeld: block asked, still does not block
  Warning --> Comparing: the next initialize compares again
  Current --> Comparing: the next initialize compares again
  DocumentedNoOp --> Comparing: the next initialize compares again
  BlockHeld --> Comparing: the next initialize compares again
  FallbackOnly --> Comparing: the next initialize compares again
  FallbackHeld --> Comparing: the next initialize compares again
  NoHandoff --> Comparing: the next initialize compares again
  Unreadable --> Comparing: the next initialize compares again`;

export const CONTINUITY_CURRENCY_STEPS = Object.freeze([
  'The warn flag starts off. Initialize serves HANDOFF as it does today and shows no continuity-currency warning.',
  'With the warn flag on, initialize compares the served HANDOFF to the live material episodic tip. The comparison does not write.',
  'A handoff that cites the live material tip is current. A newer scratch or diagnosis-only episodic does not warn. A version number alone does not warn.',
  'A documented no-op has no newer material tip. The handoff version may stay where it is. That is not a warning.',
  'When the material tip is newer, initialize returns a warning with the lag. The call is not blocked.',
  'A fallback-only tip is a warning and is not block-eligible. Asking for the phase-2 block still does not block.',
  'No handoff, or a comparison that could not be read, shows that status and does not warn. Nothing is written.',
  'Asking for the phase-2 block leaves the warning in place and still does not block. HANDOFF and STATE stay untouched. The host rewrites HANDOFF whole.'
]);

const PHASES = new Set([
  'GateOff', 'Comparing', 'Current', 'DocumentedNoOp', 'Warning', 'BlockHeld',
  'NoHandoff', 'Unreadable', 'FallbackOnly', 'FallbackHeld'
]);
const COMPARE_AGAIN = new Set([
  'Current', 'DocumentedNoOp', 'Warning', 'BlockHeld',
  'NoHandoff', 'Unreadable', 'FallbackOnly', 'FallbackHeld'
]);

function blank(state, extra = {}) {
  return {
    phase: state.phase,
    flag: state.flag,
    newer: state.newer,
    claim: state.claim,
    blockEligible: false,
    handoffMutated: false,
    blocked: false,
    warning: false,
    ...extra,
    handoffMutated: false,
    blocked: false
  };
}

/**
 * One step of the diagram. An event that cannot happen in this phase returns
 * null. `handoffMutated` and `blocked` stay false on every step.
 */
export function continuityCurrencyStep(state, event) {
  if (!state || !PHASES.has(state.phase)) return null;
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === 'flag_off') {
    if (state.flag !== 'off' || state.phase !== 'GateOff') return null;
    return blank(state, { phase: 'GateOff', warning: false });
  }
  if (event.type === 'enable') {
    if (state.flag !== 'off' || state.phase !== 'GateOff') return null;
    return blank(state, { phase: 'Comparing', flag: 'warn', warning: false });
  }
  if (event.type === 'cite_tip' || event.type === 'scratch' || event.type === 'version_only' || event.type === 'no_op' || event.type === 'material_lag' || event.type === 'fallback_only' || event.type === 'no_handoff' || event.type === 'unreadable') {
    if (state.flag !== 'warn' || state.phase !== 'Comparing') return null;
    if (event.type === 'cite_tip') return blank(state, { phase: 'Current', newer: 'none', claim: 'at_tip' });
    if (event.type === 'scratch') return blank(state, { phase: 'Current', newer: 'scratch', claim: 'at_tip' });
    if (event.type === 'version_only') return blank(state, { phase: 'Current', newer: 'material', claim: 'version_only' });
    if (event.type === 'no_op') return blank(state, { phase: 'DocumentedNoOp', newer: 'none', claim: 'at_tip' });
    if (event.type === 'no_handoff') return blank(state, { phase: 'NoHandoff', newer: 'none', claim: 'at_tip' });
    if (event.type === 'unreadable') return blank(state, { phase: 'Unreadable', newer: 'none', claim: 'at_tip' });
    if (event.type === 'fallback_only') {
      return blank(state, { phase: 'FallbackOnly', newer: 'fallback', claim: 'behind', warning: true, blockEligible: false });
    }
    return blank(state, { phase: 'Warning', newer: 'material', claim: 'behind', warning: true, blockEligible: true });
  }
  if (event.type === 'ask_block') {
    if (state.phase === 'Warning') {
      return blank(state, { phase: 'BlockHeld', newer: 'material', claim: 'behind', warning: true, blockEligible: true });
    }
    if (state.phase === 'FallbackOnly') {
      return blank(state, { phase: 'FallbackHeld', newer: 'fallback', claim: 'behind', warning: true, blockEligible: false });
    }
    return null;
  }
  if (event.type === 'initialize_again') {
    if (state.flag !== 'warn' || !COMPARE_AGAIN.has(state.phase)) return null;
    return blank(state, { phase: 'Comparing', warning: false, blockEligible: false });
  }
  return null;
}

/** The rules the diagram states. A rewrite or a block breaks the invariant. */
export function continuityCurrencyInvariant(state) {
  if (!state || state.handoffMutated !== false) return false;
  if (state.blocked !== false) return false;
  if (state.flag === 'off' && (state.phase !== 'GateOff' || state.warning !== false)) return false;
  if (state.warning === true) {
    const material = (state.phase === 'Warning' || state.phase === 'BlockHeld')
      && state.newer === 'material' && state.claim === 'behind' && state.blockEligible === true;
    const fallback = (state.phase === 'FallbackOnly' || state.phase === 'FallbackHeld')
      && state.newer === 'fallback' && state.claim === 'behind' && state.blockEligible !== true;
    if (!material && !fallback) return false;
  }
  if (state.phase === 'DocumentedNoOp' && state.warning !== false) return false;
  if (state.phase === 'NoHandoff' && state.warning !== false) return false;
  if (state.phase === 'Unreadable' && state.warning !== false) return false;
  if (state.newer === 'scratch' && state.warning !== false) return false;
  if (state.newer === 'fallback' && (state.blocked !== false || state.blockEligible === true)) return false;
  if (state.claim === 'version_only' && state.warning !== false) return false;
  if ((state.phase === 'Warning' || state.phase === 'BlockHeld' || state.phase === 'FallbackOnly' || state.phase === 'FallbackHeld') && state.blocked !== false) return false;
  return true;
}
