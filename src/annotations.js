/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Tool annotations.
 *
 * MCP lets a server declare, per tool, what kind of operation it is. Hosts use
 * these hints to decide what to approve automatically and what to put in front
 * of a person. A server that declares nothing is treated as if every call might
 * do anything, so hosts that ask before acting ask before EVERY call - including
 * the reads that make up most of a session.
 *
 * These are hints, not enforcement. A host is free to ignore them, and a host
 * that trusts them is trusting the server author. They are declared here, in one
 * table rather than scattered through the tool definitions, because the honest
 * version of this file is also its documentation: this is the complete statement
 * of what EMET does to a store, and anyone deciding how much to auto-approve
 * should be able to read it in one screen.
 *
 * The four hints, as the specification defines them:
 *   readOnlyHint    - the tool does not modify anything.
 *   destructiveHint - the tool may replace or remove existing data (only
 *                     meaningful when readOnlyHint is false).
 *   idempotentHint  - calling it again with the same arguments changes nothing
 *                     further.
 *   openWorldHint   - the tool reaches systems outside this server's own store.
 *
 * openWorldHint is false everywhere. The tools talk to this server's own
 * database and nothing else: no filesystem and no shell. The sign-in server
 * fetches a client's metadata document, and only from a public address it has
 * already checked. That is worth stating explicitly, because it is the main
 * reason a memory server can be given standing permission when a shell server
 * should not.
 *
 * WHY SO FEW TOOLS ARE MARKED DESTRUCTIVE: EMET's write model is additive by
 * design. Layer entries are superseded rather than edited (supersede_never_mutate),
 * and every document write archives the previous version to the history
 * collection before replacing it. The replacing writes carry the flag, and so
 * do the two doors that hand a new person access to the store: a recoverable
 * overwrite is still an overwrite, and a code that grants access is not a
 * harmless add.
 *
 * NOTHING IN THIS TABLE DELETES ANYTHING, and that is a design guarantee rather
 * than an accident of the current tool set. Layer entries are superseded,
 * documents are retired, transcripts are revised - every correction adds a
 * record and marks the prior one obsolete. A host can read this table as the
 * complete statement that EMET does not remove data.
 */

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const REPLACE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export const TOOL_ANNOTATIONS = Object.freeze({
  // --- Reads. Nothing in this group can change the store. -------------------
  emet_initialize:        { title: 'Start session', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  recall:                 { title: 'Search memory', ...READ },
  semantic_recall:        { title: 'Search memory by meaning', ...READ },
  corpus_recall:          { title: 'Search reference corpus', ...READ },
  query_layer:            { title: 'Query a memory layer', ...READ },
  query_transcripts:      { title: 'Read transcripts', ...READ },
  read_doc:               { title: 'Read a document', ...READ },
  read_doc_history:       { title: 'Read a retained document revision', ...READ },
  list_docs:              { title: 'List documents', ...READ },
  emet_gaps:              { title: 'Count the record\'s gaps', ...READ },
  emet_floor:             { title: 'Read the floor', ...READ },
  // Checks a document against its template and writes nothing - not even the
  // verdict. The write path stores that; this is the same check, borrowed.
  validate_doc:           { title: 'Check a document against its template', ...READ },

  // --- Additive writes. These add; they do not remove or replace. -----------
  // Was READ until 2026-09-27: "it does not write anything itself". Since the
  // blocked-close cap: it records each blocked attempt in
  // close_attempts, so a read-only hint would be untrue (code audit, 1.3).
  emet_session_close:     { title: 'Check session is saved', ...ADD },
  emet_invite_create:     { title: 'EMET Guest Access', ...REPLACE },
  emet_member_access_create: { title: 'EMET Member Access', ...REPLACE },
  save_to_layer:          { title: 'Save to a memory layer', ...ADD },
  revise_memory:          { title: 'Supersede a memory', ...ADD },
  save_transcript:        { title: 'Save a transcript', ...ADD },
  emet_session_open:      { title: 'Open transcript session', ...ADD },
  emet_transcript_append: { title: 'Append one transcript exchange', ...ADD },
  revise_transcript:      { title: 'Supersede a transcript part', ...ADD },

  // --- Replacing writes. Prior versions are archived, but the visible
  //     content of an existing document is replaced. -------------------------
  write_doc:              { title: 'Write a document', ...REPLACE },
  patch_doc:              { title: 'Edit a document', ...REPLACE },
  emet_setup_complete:    { title: 'Complete setup', ...REPLACE },

  // --- Obsolescence marks. NOT removals: this server has no delete verb for
  //     any store. The document keeps its id and its full content and read_doc
  //     still returns it, and list_docs keeps it after the current documents,
  //     marked with the date and what replaced it. Additive
  //     for the same reason revise_memory is - it marks, it does not destroy -
  //     and idempotent, because retiring an already-retired document reports
  //     the existing mark rather than making a second one. -------------------
  retire_doc:             { title: 'Mark a document obsolete', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  rename_doc:             { title: 'Reissue a document under a new id', ...ADD },
  restore_doc:            { title: 'Write a retained revision back', ...REPLACE },
  // Additive for the same reason retire_doc is: the nonconformance marker is
  // kept and the acceptance is written beside it. Nothing is cleared, so
  // accepting twice records the second reason rather than undoing anything.
  accept_nonconformance:  { title: 'Accept a nonconformance in writing', ...ADD },

  // --- The one diagnostic. Reads by default; with probe: true it writes a
  //     probe document and removes it again, so it is not declared read-only -
  //     a health check that only reads cannot detect a broken write path.
  //     Replaced emet_setup_status, get_status and emet_verify_connection on
  //     2026-09-27 (the owner: consolidate overlapping tools). -----------------------
  emet_status:            { title: 'Store status and write-path probe', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});

/**
 * Attach annotations to a list of tool definitions.
 *
 * Throws on any tool with no entry in the table. A tool that reaches a host
 * unannotated is silently treated as maximally dangerous, so the failure needs
 * to happen here, at build time, rather than as unexplained approval prompts
 * months later.
 */
export function annotate(tools) {
  const missing = tools.filter((tool) => !TOOL_ANNOTATIONS[tool.name]).map((tool) => tool.name);
  if (missing.length > 0) {
    throw new Error(
      `Tools declared with no annotation entry: ${missing.join(', ')}. ` +
      `Add them to TOOL_ANNOTATIONS in src/annotations.js.`
    );
  }
  return tools.map((tool) => ({ ...tool, annotations: TOOL_ANNOTATIONS[tool.name] }));
}

export default { TOOL_ANNOTATIONS, annotate };
