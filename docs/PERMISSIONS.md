# Permissions and approvals

How to decide what EMET may do without being asked each time, and how to set it.

---

## Where the boundary can live

There are three places, and it is worth being clear about which is which:

- **The host** decides *what gets called* and *what data goes into the call*. Approval prompts,
  allow-lists and "always allow" settings all live here.
- **The server** decides *what it will do when asked*. Refusing an operation, versioning a write,
  archiving before replacing, checking the order of a session's writes (the monorail) - all here.
- **The database** decides *what the server's own login may do*. EMET's login runs under the
  least-privilege role `emetRecordKeeper` ([SETUP.md](SETUP.md), `src/atlas-role.js`): it can
  insert and update, and it has no permission to remove anything from the record. Error-log
  rotation may delete from `error_log` only, so the role includes `REMOVE@<db>.error_log`
  (10,000 entries or 90 days, daily summaries kept). That action is not granted on a memory,
  a controlled document, or a transcript. So "nothing is deleted" holds for the record even
  against a bug in the server, not only against a model's choice.

No layer can widen another. In particular, **a server cannot grant itself permission**. Nothing in
this repository can stop your host from asking you to approve every call, and nothing in it should
be able to.

What a server *can* do is describe itself accurately enough that a host has something to reason
with. That is what tool annotations are.

---

## What EMET declares

Every tool carries MCP annotations, declared in one table in `src/annotations.js`:

| Hint | Meaning |
|---|---|
| `readOnlyHint` | The tool does not modify anything. |
| `destructiveHint` | It may replace or remove existing data. |
| `idempotentHint` | Calling it again with the same arguments changes nothing further. |
| `openWorldHint` | It reaches systems outside this server's own store. |

Of the 38 tools (`EMET_SUBKEYS=1` adds the five sub-key tools below, for 43; with the flag off they are not registered):

- **15 are read-only.** `emet_gaps`, `emet_page`, `emet_pages`, `emet_page_lint`, `emet_error_report`, `emet_floor`, `recall`, `semantic_recall`,
  `corpus_recall`, `query_layer`, `query_transcripts`, `read_doc`, `read_doc_history`, `list_docs`,
  `validate_doc`. These cannot change the store under any arguments. `emet_page`, `emet_pages`, and `emet_page_lint` are owner-only views: they compute a topic page and never write it back. `emet_error_report` is owner-only and reads the operational error log. It sends nothing.
- **13 are additive writes.** `emet_initialize` (it provisions a missing board), `save_to_layer`, `revise_memory`, `save_transcript`,
  `revise_transcript`, `emet_session_open`, `emet_transcript_append`, `emet_session_close` (it
  records blocked attempts), `rename_doc`, `accept_nonconformance`, `write_doc_begin`, `write_doc_append`, `write_doc_abort`. They add; they do not remove or replace. A staged begin or append changes only the server's own stage, not the current document.
  `emet_session_open` still needs the `emet.write` scope, because it stamps the drop list a board edit trusts.
  `emet_initialize` stays a read.
- **8 can replace what is already there, or hand out access.** `write_doc`, `write_doc_commit`, `patch_doc`, `restore_doc`, `emet_setup_complete`,
  `emet_invite_create`, `emet_member_access_create`, `emet_client_approve` (it admits or refuses a new client).
  Prior versions of a document are archived to the history
  collection first, but the visible content a person may be relying on is replaced. A code that grants access
  is marked the same way: it is not a harmless add.
- **1 marks a document obsolete.** `retire_doc`. Neither a removal nor a replacement: the
  document keeps its id and its full content, `read_doc` still returns it, and `list_docs`
  keeps it after the current documents, marked with the date it was retired and what replaced
  it. Idempotent — retiring an already-retired document reports
  the existing mark rather than making a second one.
- **1 reads, and on request writes a probe and removes it.** `emet_status`. Deliberately not
  declared read-only: with `probe: true` it writes, and a health check that only reads cannot
  detect a broken write path. A read-scoped token may call it without `probe`. With `probe: true` it needs
  `emet.write`. The probe deletes only that document. It does not drop the collection.

With `EMET_SUBKEYS=1` the host also receives five tools: `emet_subkey_request`, `emet_subkey_claim`, and `emet_subkey_end_session` (additive), `emet_subkey_set_kind` (it sets an approved key's `client_kind` to `bot` or `chat`; idempotent), and `emet_subkey_revoke` (it retires a key's authority; the record stays). Write tools gain `session_handle`. `emet_session_open` and `emet_session_close` gain `subkey`. With the flag off those names and fields are absent. First-use setup turns the flag on only when the owner says yes and the server reads `.env`. A hosted server refuses that yes. A single client stays on the flag-off list. The owner approves a new writer, and a bot's own key, on `/owner/chooser`. An AI does not grant a writer. In a session opened with a sub-key, every later write passes the `session_handle` that `emet_session_open` returned once. A missing or different handle is refused, and nothing is written. The handle is not a receipt. See [SUBKEYS.md](SUBKEYS.md).

**`openWorldHint` is false on every tool.** The tools talk to this server's configured database
and nothing else: no filesystem and no shell. The sign-in server fetches a client's metadata
document, and only from a public address it has already checked. That is the main reason a memory
server can reasonably be given standing permission when other servers should not.

`src/annotations.js` is the complete statement of what EMET does to a store. It is short on
purpose: anyone deciding how much to approve should be able to read it in one screen and check it
against the code.

---

## Choosing a posture

The question worth asking is not "how much do I trust this server" but **"what does a wrong call
actually cost, and can I get back what it took?"**

- **Reads cost nothing and cannot be wrong destructively.** Approving them individually spends
  attention on the calls that carry no risk, and a session is mostly reads. Standing approval for
  the read-only group is the change that removes most of the friction.
- **Additive writes are recoverable by construction.** Layer entries are superseded rather than
  edited, so a bad entry is visible and correctable but never overwrites what it corrects.
- **Replacing writes are recoverable but not free.** The prior version is archived, so nothing is
  destroyed; you may still want to see these, particularly early on, because a wrong `write_doc`
  is silently a *different document* rather than an error.

A reasonable default for most users: **standing approval for reads, per-call or standing for
additive writes according to taste, and eyes on the replacing writes, including setup and the two access doors.**

**Do not carry this posture across to other servers.** It rests on `openWorldHint` being false and
on every write being versioned. A filesystem or shell server has neither property: there, a single
wrong call can do something no archive brings back, and per-call approval is the actual safety
mechanism rather than an inconvenience.

---

## Setting it

Approval settings are host-side. The exact wording differs between hosts and changes over time,
so look for the per-tool or per-connector permission settings in whichever host you have connected
EMET to, and grant standing approval to the tools you have decided on.

---

## Who a save is attributed to

Every write is stamped with the source tag of the client that made it. Transcript appends already refuse a tag that is not an exact member of `EMET_SOURCE_TAGS` (and of the approved tags in `emet/CLIENT_APPROVALS.md`, once that record is loaded). `save_to_layer`, `revise_memory`, and the document writes that still stored an unregistered tag use that same membership test.

Until `2026-12-15` in `America/New_York`, an unregistered save is kept. The receipt names that cutoff. On that date, and after it, the save is refused with `EMET-MEM-035` and nothing is written. `EMET_SOURCE_SAVE_CUTOFF` moves the date. Unset, blank, or a value that is not `YYYY-MM-DD` stays `2026-12-15`. The shape check does not test that the month and day are a real date. `CASCADE_SOURCE_SAVE_CUTOFF` is the fallback.

A sub-key write stamps the tag bound to that key. An owner-door write stamps the tag bound when the owner signed in. Those tags are registered when they are on the list above, so those writes stay. A save with no source tag is not this refusal: it stays `source_missing`, or takes `EMET_SOURCE_TAG` when a single-host default is set. A default that is not on the list is unregistered.

With no `EMET_SOURCE_TAGS` configured, any tag is still accepted. A document write that already refuses an unregistered source (`EMET-DOC-020`) still refuses it. The cutoff does not open that door. Transcript appends stay an immediate refusal (`EMET-TOOL-004`).

Rows already stored stay readable, including a legacy row written before source tags were required. A refusal does not delete or rewrite them. The picture is [source-save-statechart.md](source-save-statechart.md) and `GET /statechart`.

## When the prompting suddenly increases

**A host's remembered approvals are tied to the tool list it has cached.** When a server adds or
renames tools, the host is looking at a list it has not seen before, and previously granted
approvals may no longer match. Reconnecting the server to refresh its tool list is normal after an
upgrade; being asked to approve things you had already approved is the usual symptom, and it
settles once the new list is approved.

If prompting stays heavy after that, the thing to check is whether the annotations are actually
reaching the host: `emet_initialize` and any tool listing should show them. A host that receives no
annotations has no way to distinguish `read_doc` from `write_doc`, and the correct behaviour for
such a host is to ask about both.
