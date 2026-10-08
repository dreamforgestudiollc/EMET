/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Operating disciplines - the nine lines emet_initialize serves as
 * `operating_discipline`, ordered by how often they bite.
 *
 * Each exists because its absence caused a real, traced loss of information in
 * production use. The reasoning behind each line lives in docs/DISCIPLINES.md
 * (moved there 2026-09-27, code audit finding 3.13: the long form sat beside
 * the short form in this file and was never served - a rule stated twice).
 */

export const DISCIPLINE_SUMMARY = Object.freeze([
  'Search memory before answering anything that may have prior context.',
  'Read back every write before reporting it saved; verify a fact before acting on it.',
  'Store transcripts verbatim - never summarise them. Split large ones instead.',
  'Correct the record by superseding, never by editing or deleting. Events are immutable.',
  'Tag every write with a distinct source per host.',
  'Record findings without inventing causes; mark inference as inference.',
  'Save decisions and their reasoning when they happen, not at the end.',
  'Name the layer on every write; an unlabelled entry lands in working, flagged.',
  'Write a handoff before any interruption.'
]);
