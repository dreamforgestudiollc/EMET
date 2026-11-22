/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Per-tag handoff statechart. Served on /statechart.
 * The picture is docs/per-tag-handoff-statechart.md.
 * The reference model is verification/per-tag-handoff/PerTagHandoff.tla
 * (958,557 states). The pictures are the split models under
 * verification/per-tag-handoff/split/.
 */

export const PER_TAG_HANDOFF_MERMAID = `stateDiagram-v2
  state "Legend" as legend {
    lg0: refused
    lg1: session
    lg2: rest
  }
  class lg0 pink
  class lg1 blue
  class lg2 teal
  s0: No handoffs yet
  s1: In session, merged view read
  s2: Write refused, nothing written
  s3: Handoffs at rest
  s4: In session, board moved since read
  s5: In session, row conflict waiting for the hub
  s6: At rest, row conflict waiting for the hub
  [*] --> s0
  s0 --> s1: an AI starts and reads the view
  s1 --> s2: an AI tries to write another AI's handoff or an AI tries to patch a row it did not open
  s1 --> s3: a write AI writes its own handoff last
  s1 --> s4: a write AI opens a board row
  s2 --> s1: an AI starts and reads the view or a write AI opens a board row or a write AI writes its own handoff last
  s2 --> s3: a write AI writes its own handoff last
  s3 --> s1: an AI starts and reads the view
  s2 --> s4: a write AI opens a board row or a write AI writes its own handoff last or an AI starts and reads the view
  s4 --> s2: an AI tries to patch a row it did not open or an AI tries to write another AI's handoff or a write on a moved board is refused
  s4 --> s1: a write AI writes its own handoff last
  s4 --> s5: a write AI writes its own handoff last
  s1 --> s5: a write AI writes its own handoff last
  s2 --> s5: a write AI writes its own handoff last or an AI starts and reads the view
  s4 --> s3: a write AI writes its own handoff last
  s4 --> s6: a write AI writes its own handoff last
  s1 --> s6: a write AI writes its own handoff last
  s5 --> s2: an AI tries to write another AI's handoff or an AI tries to patch a row it did not open
  s5 --> s6: a write AI writes its own handoff last
  s2 --> s6: a write AI writes its own handoff last
  s6 --> s5: an AI starts and reads the view
  class s0 teal
  class s1 blue
  class s2 pink
  class s3 teal
  class s4 blue
  class s5 blue
  class s6 teal
`;

export const PER_TAG_TIME_MERMAID = `stateDiagram-v2
  state "Legend" as legend {
    lg0: session
    lg1: rest
  }
  class lg0 blue
  class lg1 teal
  s0: No handoff yet
  s1: In session, merged view read
  s2: In session, work shown in progress
  s3: Handoff at rest
  s4: In session, open work marked stale
  s5: Handoff at rest, line aging
  s6: In session, reading an aging line
  [*] --> s0
  s0 --> s1: an AI starts, reads the view, and stamps it
  s1 --> s2: a write AI saves work in an open session
  s1 --> s3: a write AI writes its own handoff last or a read-only AI leaves, writing nothing
  s1 --> s0: a read-only AI leaves, writing nothing
  s1 --> s4: a write AI saves work in an open session
  s2 --> s4: time passes (24 hours open, 7 days aging)
  s2 --> s3: a write AI writes its own handoff last
  s3 --> s1: an AI starts, reads the view, and stamps it
  s3 --> s5: time passes (24 hours open, 7 days aging)
  s2 --> s1: a write AI writes its own handoff last
  s4 --> s3: a write AI writes its own handoff last
  s5 --> s6: an AI starts, reads the view, and stamps it
  s4 --> s1: a write AI writes its own handoff last
  s6 --> s2: a write AI saves work in an open session
  s1 --> s6: an AI starts, reads the view, and stamps it
  s6 --> s5: a read-only AI leaves, writing nothing
  s1 --> s5: a read-only AI leaves, writing nothing
  s6 --> s4: a write AI saves work in an open session
  s6 --> s1: a read-only AI leaves, writing nothing
  class s0 teal
  class s1 blue
  class s2 blue
  class s3 teal
  class s4 blue
  class s5 teal
  class s6 blue
`;

export const PER_TAG_HANDOFF_STEPS = Object.freeze([
  'A session reads the shared handoff view. The stamp includes the time it was read, the person, each handoff version, and the board version.',
  'Rows already on the board belong to the hub tag. Another tag patching one of those rows is refused.',
  'A new row belongs to the credential that adds it. That tag can patch it. A bot tag can patch its own rows and still cannot write the hub handoff.',
  'The hub changes another tag\'s row only when the view has marked that row in conflict, and the write names the stamp, including the time it was read. With no mark the hub is refused.',
  'Each write tag writes its own handoff last. A write of another tag\'s handoff, or of the hub handoff by anyone else, is refused.',
  'A read-only tag receives the view and writes nothing.',
  'An open session with material work is an in-progress line. It is not a pointer and it is not a lag. After 24 hours the line is marked stale-open. The gate stays warn-only.',
  'A handoff line older than 7 days, by the revision\'s updated_at, is aging. The same stamp rebuilds that class because it carries the time it was read. A stamp of versions alone does not.'
]);

const PLACES = new Set([
  'reading', 'opened', 'ownRow', 'foreignRefused', 'conflict', 'resolved',
  'hubRefused', 'ownHandoff', 'foreignHandoff', 'readOnly',
  'inProgress', 'staleOpen', 'agingLine', 'done'
]);

export function perTagInitial() {
  return {
    place: 'reading',
    conflict: false,
    stale: false,
    aging: false,
    stampAsOf: true,
    handoffBy: 'none',
    rowOwner: 'hub',
    refused: false,
    blocked: false,
    person: 'owner'
  };
}

function same(state, extra) {
  return { ...state, ...extra, person: 'owner', blocked: false };
}

/**
 * One step of the chart. An event that cannot happen returns null.
 * blocked stays false. The person stays the owner.
 */
export function perTagHandoffStep(state, event) {
  if (!state || !PLACES.has(state.place)) return null;
  if (!event || typeof event.type !== 'string') return null;
  const type = event.type;
  if (type === 'start') {
    if (state.place !== 'reading') return null;
    return same(state, { stampAsOf: true });
  }
  if (type === 'open_row') {
    if (state.place !== 'reading' || state.rowOwner !== 'hub') return null;
    return same(state, { place: 'opened', rowOwner: 'writer', refused: false });
  }
  if (type === 'patch_own') {
    if (state.place !== 'opened' || state.rowOwner !== 'writer') return null;
    return same(state, { place: 'ownRow', refused: false });
  }
  if (type === 'foreign_row') {
    if (state.place !== 'reading' || state.rowOwner !== 'hub') return null;
    return same(state, { place: 'foreignRefused', refused: true });
  }
  if (type === 'mark_conflict') {
    if (state.place !== 'opened') return null;
    return same(state, { place: 'conflict', conflict: true });
  }
  if (type === 'resolve') {
    if (state.place !== 'conflict' || state.conflict !== true || state.stampAsOf !== true) return null;
    return same(state, { place: 'resolved', refused: false });
  }
  if (type === 'resolve_unmarked') {
    if (state.place !== 'opened' || state.conflict !== false || state.rowOwner !== 'writer') return null;
    return same(state, { place: 'hubRefused', refused: true });
  }
  if (type === 'wrap_own') {
    if (!['reading', 'ownRow', 'resolved', 'inProgress'].includes(state.place)) return null;
    return same(state, { place: 'ownHandoff', handoffBy: 'writer', refused: false });
  }
  if (type === 'foreign_handoff') {
    if (state.place !== 'reading') return null;
    return same(state, { place: 'foreignHandoff', refused: true, handoffBy: 'none' });
  }
  if (type === 'leave_readonly') {
    if (state.place !== 'reading') return null;
    return same(state, { place: 'readOnly', refused: false });
  }
  if (type === 'show_progress') {
    if (state.place !== 'reading') return null;
    return same(state, { place: 'inProgress', stale: false });
  }
  if (type === 'tick_open') {
    if (state.place !== 'inProgress') return null;
    return same(state, { place: 'staleOpen', stale: true });
  }
  if (type === 'tick_age') {
    if (!['reading', 'ownHandoff'].includes(state.place) || state.stampAsOf !== true) return null;
    return same(state, { place: 'agingLine', aging: true });
  }
  if (type === 'done') {
    if (!['ownRow', 'foreignRefused', 'resolved', 'hubRefused', 'ownHandoff', 'foreignHandoff', 'readOnly', 'staleOpen', 'agingLine', 'done'].includes(state.place)) return null;
    return same(state, { place: 'done' });
  }
  return null;
}

/** The chart rules. A block, a lost opener, or a stamp with no as_of breaks one. */
export function perTagInvariant(state) {
  if (!state) return false;
  if (state.blocked !== false) return false;
  if (state.person !== 'owner') return false;
  if (state.handoffBy !== 'none' && state.handoffBy !== 'writer') return false;
  if (state.place === 'resolved' && state.conflict !== true) return false;
  if (state.place === 'hubRefused' && (state.conflict !== false || state.rowOwner !== 'writer')) return false;
  if (state.place === 'foreignRefused' && state.rowOwner !== 'hub') return false;
  if (state.place === 'readOnly' && (state.handoffBy !== 'none' || state.rowOwner !== 'hub')) return false;
  if ((state.place === 'inProgress' || state.place === 'staleOpen') && state.handoffBy !== 'none') return false;
  if (state.stale === true && state.place !== 'staleOpen' && state.place !== 'done') return false;
  if (state.stampAsOf !== true) return false;
  return true;
}

/**
 * The four-step counter-check. Versions without as_of do not rebuild the view
 * once the line has aged. The real stamp carries as_of, so the same inputs rebuild.
 */
export function stampCounterSteps(build) {
  const asOf = '2026-11-03T00:00:00.000Z';
  const later = '2026-11-11T00:00:00.000Z';
  const board = { doc_id: 'STATE.md', version: 1, content: boardText() };
  const input = {
    doc_id: 'HANDOFF/writer.md',
    tag: 'writer',
    version: 1,
    updated_at: '2026-11-03T00:00:00.000Z',
    content: handoffText('B-001', 'open', 'wait')
  };
  const first = build({ inputs: [input], board, as_of: asOf, person: 'owner' });
  const again = build({ inputs: [input], board, as_of: asOf, person: 'owner' });
  const aged = build({ inputs: [input], board, as_of: later, person: 'owner' });
  const versionsOnly = { inputs: ['HANDOFF/writer.md@v1'], board: 'STATE.md@v1' };
  return { first, again, aged, versionsOnly };
}

export function boardText() {
  return [
    '## §1 HALF-STATE',
    '| Id | State | Next action |',
    '| --- | --- | --- |',
    '| B-001 | open | wait |',
    '## §3 OPEN BOARD',
    '| Id | Status | Next action |',
    '| --- | --- | --- |'
  ].join('\n');
}

export function handoffText(row, state, next) {
  return [
    '## §1 OVERALL PICTURE',
    '| Row | State | Next step |',
    '| --- | --- | --- |',
    `| ${row} | ${state} | ${next} |`,
    'Close verification: episodic 1'
  ].join('\n');
}
