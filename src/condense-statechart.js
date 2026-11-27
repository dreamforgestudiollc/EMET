/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Owner-approved condense. Served on /statechart. The same picture is
 * docs/condense-approval-statechart.md. The model is
 * verification/condense-approval/CondenseApproval.tla.
 */

export const CONDENSE_MERMAID = `stateDiagram-v2
  state "Legend" as legend {
    lg0: start
    lg1: refused
    lg2: waiting
    lg3: kept
  }
  class lg0 blue
  class lg1 orange
  class lg2 yellow
  class lg3 teal
  s0: Full document
  s1: Approved and written
  s2: Pending approval
  s3: Refused
  [*] --> s0
  s0 --> s1: a named approval writes the short revision, no access code and no client door or the owner writes the short revision
  s0 --> s2: the approval names another document or the reason is missing or the owner has not approved it
  s0 --> s3: you send a shorter document or a bot asks, with no owner approval
  class s0 blue
  class s1 teal
  class s2 yellow
  class s3 orange`;

export const CONDENSE_STEPS = Object.freeze([
  'A write that leaves the document under half the size this session first saw is refused. EMET-DOC-025. Nothing is written. That is the default.',
  'A bot tag, including the hub and any hubbot-* tag, that passes condense_approved on the owner password is still refused. EMET-DOC-025. The owner password is not that approval.',
  'condense_approved true with no reason, or with an approval the owner has not granted, or with an approval that names another document, writes nothing. EMET-DOC-090. The document stays as it was. A writer approval condenses only the document it names.',
  'The owner door, or a writer approval the owner has granted for this caller and this document, writes the short revision. The prior revision stays in documents_history, byte for byte. The revision stores the reason, the approver, and both sizes and digests. The episodic note is written only after that revision is read back.'
]);
