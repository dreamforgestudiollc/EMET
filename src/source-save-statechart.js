/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Unregistered-source saves. A registered source is stored.
 * An unregistered source is stored with a warning before the cutoff and
 * refused on that date. A legacy pre-attribution row is a read: it stays.
 * Served on /statechart. The same picture is docs/source-save-statechart.md.
 * The cutoff clock is America/New_York. This file does not read the clock.
 */

export const SOURCE_SAVE_CODE = 'EMET-MEM-035';

export const SOURCE_SAVE_MERMAID = `stateDiagram-v2
  [*] --> Registered: tag in EMET_SOURCE_TAGS or an approved tag
  Registered --> Stored: save_to_layer or a document write
  [*] --> UnregisteredBefore: tag not registered, before the cutoff
  UnregisteredBefore --> StoredWarned: save kept, warning names the cutoff
  [*] --> UnregisteredAfter: tag not registered, on or after the cutoff
  UnregisteredAfter --> Refused: EMET-MEM-035, nothing written
  [*] --> LegacyRead: pre-attribution row
  LegacyRead --> Readable: read returns the row`;

export const SOURCE_SAVE_STEPS = Object.freeze([
  'Registered is an exact member of the same list emet_transcript_append uses: EMET_SOURCE_TAGS, plus a tag approved in emet/CLIENT_APPROVALS.md once that record is loaded. A sub-key stamps its own tag. An owner-door write stamps the tag bound at approval. Those tags are this state when they are on that list.',
  'No registry configured is open. Any tag is stored and this warning is not added. That is the same rule as a transcript write.',
  'A save with no source tag is absent. It stays source_missing, or the server default when EMET_SOURCE_TAG is set. This cutoff does not refuse it. A default that is not on the list is unregistered.',
  'UnregisteredBefore stores the save and the receipt warning names the cutoff date and America/New_York. The layer row still carries source_unregistered. Nothing is deleted.',
  'UnregisteredAfter throws EMET-MEM-035 before the insert, the archive, or the stage row. The message says nothing was written. The registry is not listed.',
  'The cutoff is the civil date EMET_SOURCE_SAVE_CUTOFF in America/New_York. Unset, blank, or a value that is not YYYY-MM-DD stays 2026-12-15. On that date the phase is on or after. The process time zone is not the cutoff clock. A clock that cannot be formatted stays before, so the save is not refused.',
  'LegacyRead is a row already stored, including a row with no source from before attribution. query, read_doc, and recall return it. The save gate does not run on a read and does not rewrite the row.',
  'A document write that already refuses an unregistered source with EMET-DOC-020 still refuses it. The cutoff does not open that door. A new drop, and a bot folder the registry check still allows, use this gate.'
]);

export const SOURCE_SAVE_MEMBERSHIPS = Object.freeze(['registered', 'open', 'absent', 'unregistered', 'legacy']);
export const SOURCE_SAVE_PHASES = Object.freeze(['before', 'on_or_after']);

/**
 * One cell of the save-path table. `legacy` is a read. The phase is ignored
 * for every membership except unregistered.
 */
export function sourceSaveOutcome({ membership, phase }) {
  if (membership === 'legacy') {
    return { outcome: 'legacy_readable', stored: false, warned: false, refused: false, code: null };
  }
  if (membership !== 'unregistered') {
    return { outcome: 'stored', stored: true, warned: false, refused: false, code: null };
  }
  if (phase === 'before') {
    return { outcome: 'stored_warn', stored: true, warned: true, refused: false, code: null };
  }
  return { outcome: 'refused', stored: false, warned: false, refused: true, code: SOURCE_SAVE_CODE };
}

/** Every membership and phase. Ten rows. */
export function sourceSaveRows() {
  const rows = [];
  for (const membership of SOURCE_SAVE_MEMBERSHIPS) {
    for (const phase of SOURCE_SAVE_PHASES) {
      rows.push({ membership, phase, ...sourceSaveOutcome({ membership, phase }) });
    }
  }
  return rows;
}
