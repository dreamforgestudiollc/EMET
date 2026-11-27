# EMET 0.3.8

EMET is an MCP server for document control (ISO 9001 7.5.3 / ISO 13485 4.2.5): persistent shared memory for AI agents, bot teams, and chats. Version 0.3.8. EMET holds no certification and claims no conformity. The stored document shapes are not frozen. Pin a version if you depend on them. Stored rows are not rewritten. No new setting is required. This revision is not published from this file. See [CHANGELOG.md](CHANGELOG.md).

## What 0.3.8 changes

The admin password opens the chooser, grants, break-glass, and settings. Set it at `/owner/admin-password` with the connect passphrase, an owner Authorize token, or an owner session. Without one of those, create returns 401 and writes nothing. If the password is already set, the server returns 409 and writes nothing. An unset connect passphrase does not mint recovery codes. The connect passphrase stays on the connect page.

A bot, a member, or a guest can sign in with its sub-key and the source tag on that key. A refused key sign-in is `EMET-AUTH-046`. `EMET-AUTH-045` stays the refusal for the previous bound-door spelling.

`read_doc` reports whether the stored body matches its digest. `restore_doc` refuses the revision already in force (`EMET-DOC-089`) and writes nothing. The owner can approve one shorter revision of a named document with `condense_approved` and a reason, or a writer approval that names that document. The default refusal is `EMET-DOC-025`. A missing reason, or an approval for another document, is `EMET-DOC-090`. The prior revision stays.

EMET Console is a separate app that talks to `/console/api`. An unregistered source is refused on and after 2026-12-15. A skipped reload after a chat summary warns when continuity currency is on.

## Already shipping, and still current

These are not new in 0.3.8, and a first-time install still uses them: the owner door at `/owner/chooser`, source tags, staged writes (`write_doc_begin`, `write_doc_append`, `write_doc_commit`, `write_doc_abort`), the machine-line gate on the first transcript append (`EMET-MEM-018`), `carry_forward` on close when a later session already advanced HANDOFF or STATE, per-tag handoffs (`EMET_TAG_HANDOFFS`), and continuity currency (`EMET_CONTINUITY_CURRENCY`). The last two stay off unless the owner turns them on.
