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
  insert and update, and it has no permission to remove anything from the record. So "nothing is
  deleted" holds even against a bug in the server, not only against a model's choice.

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

Of the 29 tools:

- **11 are read-only.** `emet_gaps`, `emet_floor`, `recall`, `semantic_recall`,
  `corpus_recall`, `query_layer`, `query_transcripts`, `read_doc`, `read_doc_history`, `list_docs`,
  `validate_doc`. These cannot change the store under any arguments.
- **10 are additive writes.** `emet_initialize` (it provisions a missing board), `save_to_layer`, `revise_memory`, `save_transcript`,
  `revise_transcript`, `emet_session_open`, `emet_transcript_append`, `emet_session_close` (it
  records blocked attempts), `rename_doc`, `accept_nonconformance`. They add; they do not remove or replace.
  `emet_session_open` still needs the `emet.write` scope, because it stamps the drop list a board edit trusts.
  `emet_initialize` stays a read.
- **6 can replace what is already there, or hand out access.** `write_doc`, `patch_doc`, `restore_doc`, `emet_setup_complete`,
  `emet_invite_create`, `emet_member_access_create`. Prior versions of a document are archived to the history
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
