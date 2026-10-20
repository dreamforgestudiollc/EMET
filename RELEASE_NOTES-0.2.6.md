# EMET 0.2.6

EMET is an MCP memory server: persistent shared memory for AI agents, bot teams, and chats. Version 0.2.6. The stored document shapes are not frozen. Pin a version if you depend on them.

The npm package on the registry is still 0.2.4 until this version is published. The repository tag for this version is v0.2.6.

EMET holds no certification and claims no conformity. The document-control wording is unchanged: ISO 9001 7.5.3 / ISO 13485 4.2.5.

## Record

Nothing is deleted, on any store, by design. A memory entry is superseded by a new revision. A document is revised or retired, and retired means obsolete, not gone. Prior versions stay, and a retained revision can be read back and checked against its stored digest. Templates are controlled documents. A write that fails its template check is kept and marked, not discarded.

Every write is read back and compared before it is reported as saved.

## Attribution and approvals

Every write is attributed to the client that made it. A declared source tag does not gain rights beyond the login it is bound to. A new client is read-limited until it is approved. The approval is recorded. On a fresh store, the first solo client is approved as the owner's primary. Pending clients are reported to the owner, or to the chief-of-staff tag when that is set.

## GEM socket

Add-on behavior ships as GEMs (Golem Expertise Modules). A GEM ranks below the core floor and below the user's current word. It cannot remove a protected floor line. Neurendipity and Lean Six Sigma are work-in-progress examples and stay off unless the install turns one on. Neurendipity is support material, not counseling or treatment. Fieldnote is a developer case-study of a runed GEM. It is not a user-facing GEM, and it is off by default.

## Client-side GEM execution

A GEM may declare a tool. EMET does not run that computation. EMET verifies the record, not the computation. The client runs the tool. What gets written back is checked the same way as any other write: attributed, read back, and kept.

## Released flag

A GEM is seated only when its released flag is the boolean true. Any other value is refused. A missing flag is refused except for a legacy manifest the release pins by id, version, and file digests. The check runs on startup. A GEM that fails the check is listed and does not stop the server.

## Bot-team backup

Optional, and off unless the first-run interview records yes. Yes is the recommended choice. The recipe and the recovery template ship with the release. EMET does not copy prompts or settings itself. Secret values are never stored.

## Floor lines in this version

`goal_check`: before multi-step work, on an ambiguous request, or when the conversation turns, state the person's goal and the problem under it in one sentence, marked as your read, and confirm.

`no_rapport_mirroring`: no echoing, flattery, or agreement used to build rapport or seem attuned. Agreement is earned by substance.

## Install

MongoDB, stdio, and remote HTTP with OAuth are unchanged. Set `EMET_SOURCE_TAGS` before more than one host or bot writes. With it unset, any caller can write under any tag.
