# EMET

**Enduring Memory & Epistemic Tiers** — a multi-agent, multi-access memory server for the
Model Context Protocol.

**Website:** <https://dreamforgestudiollc.github.io/EMET/>

EMET stores agent memory in MongoDB (Atlas or self-hosted) across six layers, keeps a separate word-for-word
transcript tier, and verifies every write by reading it back. It runs as a local stdio server
and as a remote HTTP server from the same source, so it works as a bridge: AI models on several
hosts — desktop, CLI, browser, phone, another vendor's agent — read and write one shared
memory, and the work, checks, and decisions one leaves behind are there for the next. That
includes Grok Bot teams and single-session Grok chats connected to the same server: what the
bots save is there for a fresh Grok chat to find once it initializes, and the reverse. To
connect a single-session chat (a Grok project, or any chat host that takes a remote MCP
connector and supports its OAuth sign-in), add your deployed server's URL,
`https://<your-host>/mcp`, as a remote MCP connector there and complete the sign-in with the
passphrase you set (`EMET_OAUTH_PASSPHRASE`; see
[Connecting clients](docs/DEPLOY.md#connecting-clients)). A connector that only takes a fixed
header or key will not work. Then put the instruction block from
[docs/BOOTSTRAP.md](docs/BOOTSTRAP.md) in the project instructions: the chat reaches for that
memory most reliably, unprompted from the first turn, with the block there, or, as a fallback
where there is no such field, with it pasted as the first message. The
store has one owner. Other people can join only if you turn on the optional doors: Guest is
read-only, and Member is read and write. Both stay off until you turn them on.

> **Status: 0.x. The stored document shapes are not frozen yet.** Breaking changes to the
> schema may land before 1.0. Pin a version if you depend on it.

> **Set `EMET_SOURCE_TAGS` before you let more than one host or bot write.** The source-tag
> guards (unregistered tags refused on the main records, and on another bot's `bots/` folder)
> are **off unless `EMET_SOURCE_TAGS` is set**. With it unset, any caller can write under any
> tag. See `.env.example` and [docs/DEPLOY.md](docs/DEPLOY.md).

---

## Two ways in

A session that has not initialized can read everything and can write only a new drop (`drops/<date>-<slug>.md`): its items, wrap-up and handoff. A session with a registered source and the full startup has full access. Every initialized session sees unhandled drops first. A board edit is refused only for a drop that was listed at that session's boot. New drops are capped at 20 per New York day, in one bucket: the whole local process on stdio, one shared visitor bucket for HTTP with no signed-in client, the source tag bound at approval when there is one, or that OAuth client otherwise. A source the caller types does not move the bucket. Drops are never deleted.

## Editing working state

The server provisions a blank board at setup. No session can write the board. It is edited with `patch_doc` and a reason; an added row names its origin. Once any working document exists, it is edited, not rewritten. A change that leaves a document under half the size it had when this session first touched it, or under half of its largest size in the last 24 hours, is refused. `retire_doc` refuses a working document. `rename_doc` issues a new id and marks the old id retired; the text stays readable and stays in the list. `restore_doc` is the one whole-document recovery, for an owner-listed tag, and only a stored conforming revision whose digest matches.

## The name

**EMET** is אמת — Hebrew for *truth*. It is also an acronym for what the server does:
**Enduring Memory & Epistemic Tiers.**

The choice is not decoration. In the golem legend the word *emet* is inscribed to animate the
body, and erasing its first letter leaves מת — *met*, **dead**. One character is the whole
difference.

That is why **the verification layer is called `aleph`.** Every write in EMET is read back and
compared before it is reported as saved. That read-back is the aleph: a memory system without
it still returns answers, still looks healthy, and is quietly a corpse — confidently serving
things it never actually stored. Aleph is also the *first* letter, which matches the order the
protocol insists on: verify before retrying, verify the premise before applying the remedy,
read back before trusting.

The same image explains what setup is for. A golem is inert until the word is written on it;
a fresh model instance is unformed until the record is written into it. `emet_initialize` is
that inscription — it hands the model an identity, the person it serves, where things stood,
and the disciplines it is bound by. Nothing mystical is claimed here. It is a literal
description of what the first tool call does.

Both halves of the acronym are load-bearing.

**Enduring** is not a modest claim, and it is not a feature competing with other memory
products. It is measured against what a language model is by default: an etch-a-sketch. Every
session starts from nothing, and ends by forgetting everything. You explain yourself again,
re-establish what you are working on again, re-derive decisions you already made. **Enduring
names the difference between an assistant that knows you and one meeting you for the first
time, again.** That is the character of the thing, not a marketing adjective attached to it.

**Epistemic Tiers** is how that endurance stays trustworthy. Tier 1 holds curated claims;
tier 2 holds the verbatim record that justifies them — justified belief and its evidence, kept
structurally separate so neither can quietly overwrite the other. Memory that persists but
cannot be checked is just confident noise that survives longer.

---

## One memory, every device

This is the part worth understanding before anything else.

Most MCP memory servers run as a local process: your desktop launches it over stdio, and the
memory lives wherever that process can reach. That works until you pick up your phone.

EMET ships **two entry points over one source tree**:

| | | |
|---|---|---|
| `src/index.js` | stdio | desktop and CLI, launched by the client |
| `src/http-remote.js` | streamable HTTP + OAuth | phone, tablet, browser, another vendor's agent |

**They are not two projects.** Both call the same `dispatchTool` in `dispatch.js`, which calls
`tools.js` and `database.js`. `src/index.js` also imports `validation.js`. `src/http-remote.js`
does not import `validation.js` or `content_analyzer.js`; `tools.js` imports the analyser. The
transport is the only thing that differs. There is no fork to keep in sync, no second copy
drifting out of date, no "mobile version" lagging the real one. A fix lands once and both
transports have it.

Deploy the HTTP entry point to any host that can run a container — the `Dockerfile` is
included, and [docs/DEPLOY.md](docs/DEPLOY.md) walks through Railway and Fly — and every device
you own reaches **the same store**. Write a decision from your laptop, ask about it from your
phone an hour later, and it is simply there. Add a third host and it joins the same memory
rather than starting its own.

The remote endpoint is OAuth-protected: a device is authorized once with a passphrase you set,
and the token persists across restarts and redeploys. Leave `EMET_SOURCE_TAG` unset on a
server several hosts share. Over HTTP, document, transcript, and memory writes use the source
tag bound at approval. A local stdio host still passes an exact tag from `EMET_SOURCE_TAGS`
as `source` on its writes (see `.env.example`). Every entry records which machine produced
it — with several hosts writing to one store, provenance stops being optional bookkeeping and becomes the thing that lets you trust
what you read.

Running cost for a single user is a small MongoDB cluster plus a hobby-tier container
host. Both have free tiers adequate to start.

---

## Best practices

**Split the work by what each host does best.** A single-session chat (for example, a Grok
project chat, connected as described at the top) only works when you send it a message. It can't watch EMET, and bots can't
message it. So when a bot team needs the chat's help:

1. The bots leave a task in EMET with everything needed to do it, in a document whose id they
   give you.
2. You send the chat one line that names that document, for example: "Initialize EMET, read
   threads/open-tasks.md, do the task, and save the result to EMET."
3. The chat saves its draft to EMET.
4. The bots check it.

Good fits for the chat: long drafting and review done in one sitting. Good fits for the bots:
work in the repository, on the server, on a schedule, or in accounts. If the chat runs on a
separate plan, its work draws on that plan's allowance, not the bots'.

**Fetch every startup page, then open the session with that startup's `load_id`.** Call
`emet_initialize {}` first and fetch every page it names; ask for `{"page": "all"}` only on a
host known to read long results whole. Pass the `load_id` from those pages to
`emet_session_open`. An open with no `load_id`, with a page missing, or with a `load_id` the
server has no record of (one from before a restart, or 60 minutes past its last page) is
refused, and the reply says what to call. The page check runs on your own startup, and a
skipped page is refused before anything is written. See [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)
and [docs/BOTS.md](docs/BOTS.md).

**Set the source-tag list before more than one host or bot writes.** The guards that refuse
an unregistered tag are off unless `EMET_SOURCE_TAGS` is set; with it unset, a stdio caller can
write under any tag. Over HTTP the tag is the one bound when that host was approved. Add each
host's tag to the list before that host's setup interview. With several hosts writing one store,
the tag is what lets you trust who wrote what. See [docs/SETUP.md](docs/SETUP.md).

**Put the instruction block in the project's instructions.** Connecting the server gives the
assistant the ability to remember; it does not make it use that ability. A host with an
instructions field is the strongest integration: paste the block from
[docs/BOOTSTRAP.md](docs/BOOTSTRAP.md) there. Where there is no such field, paste it as the
first message of a session. With the block in place, the assistant reaches for memory most
reliably from the first turn, instead of answering from what it can infer and saving nothing.

**Approve reads standing, and keep an eye on the three writes that replace a document.** Reads
cost nothing and cannot be wrong destructively, so a reasonable default for most users is
standing approval for reads. Additive writes are recoverable, because a correction supersedes what it corrects rather than
overwriting it. The three replacing writes archive the prior version, but a wrong one is
silently a different document rather than an error. Do not carry this posture to a filesystem
or shell server. See [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

**Reconnect each host after an upgrade that changes the tool list.** Hosts cache the tool
list: after a deploy that adds or renames tools, each host keeps offering the old set until
you reconnect the connector there. New tools stay invisible until the host sees the new list,
and the host may ask again for approvals you had already given. See
[docs/DEPLOY.md](docs/DEPLOY.md).

**Register a bot before its first write, and set both lists in one change.** One bot, one tag.
In the same deployment, add the tag to `EMET_SOURCE_TAGS` and append `bots/<tag>/HANDOFF.md`
to `EMET_RECORD_DOCS`. A registered tag that is not listed as a bot can still write the main
records. The hub's tag is registered as a host and is never listed as a bot. See
[docs/BOTS.md](docs/BOTS.md).

**Prove the write path before you trust a new deploy.** Run `emet_status` with `probe: true`.
It writes a test document, reads the same value back and removes it; a read alone cannot show
a broken write path. A role missing a permission fails there, loudly, instead of in the middle
of a session. Then save something from one device and recall it from another. See
[docs/SETUP.md](docs/SETUP.md).

**Keep house style in the store, not pasted into every project.** A document written with
`write_doc` is read by every host and changed in one place; text pasted into three projects is
three copies that will disagree. Delivery preferences belong in `bootstrap/USER.md`, not in one
vendor's own memory, which does not travel to the next host. See
[docs/BOOTSTRAP.md](docs/BOOTSTRAP.md).

---

## Attribution

EMET is a derivative of **CASCADE Enterprise RAM** by Jason Glass / C.I.P.S. LLC, published
at `github.com/For-Sunny/cascade-memory-enterprise`, used and redistributed under the MIT
license the project adopted at commit `acdb5c8c99cdfc29fb44db2cd828d7752be744db` (v2.2.2,
2026-02-19). Both copyright lines are retained in `LICENSE`.

*Link unavailable:* as of 2026-10-03 that repository no longer resolves (GitHub answers 404),
and no moved copy, public mirror or archive of it was found. The address and commit are kept
here as the record of where this code came from.

**How much is upstream, measured rather than estimated.** Line-level comparison of this tree
against upstream v2.2.2 at the commit named above.

**Method**, stated so it can be reproduced: exact, case-sensitive comparison of non-blank
lines; an upstream line counts as retained if the same line is present in this tree's file.
"How much of upstream survives here" and "how much of this file is upstream's" are different
questions with different answers, so both are given. **`scripts/measure-upstream.mjs`
regenerates this table** against a clone of the commit above (while the upstream repository is unavailable, that needs a copy kept from before) — run it after any change to
`src/`, because a figure nobody can cheaply re-derive is a figure that goes quietly stale.

| File | Lines here | Upstream lines retained | of upstream | of this file |
|---|---:|---|---:|---:|
| `src/content_analyzer.js` | 450 | not recomputed | — | — |
| `src/validation.js` | 1163 | not recomputed | — | — |
| `src/index.js` | 390 | not recomputed | — | — |
| `src/tools.js` | 4273 | not recomputed | — | — |
| `src/database.js` | 811 | not recomputed | — | — |
| `src/http-remote.js` | 269 | — | — | no upstream counterpart |
| `src/oauth-provider.js` | 702 | — | — | no upstream counterpart |
| `src/named-items.js` | 206 | — | — | no upstream counterpart |
| `src/security-headers.js` | 26 | — | — | no upstream counterpart |
| `src/layers.js`, `floor.js`, `aleph.js`, `session.js`, `setup.js`, `gaps.js`, `provenance.js`, `redact.js`, `annotations.js`, `request-log.js`, `disciplines.js`, `metadata.js`, `env.js` | 4803 | — | — | no upstream counterpart |

**Lines here** were counted on 2026-10-07 (every line, including blanks, with one trailing empty line dropped). The retained percentages were not recomputed: the upstream repository no longer resolves, and no local copy of that upstream commit was available. The last measurement, against an earlier tree, was content analyser 361 of 394 (91.6% of upstream, 93.5% of that file), validation 765 of 798 (95.9%, 78.2%), index 541 of 631 (85.7%, 74.0%), tools 798 of 1007 (79.2%, 33.2%), and database 353 of 651 (54.2%, 40.2%). Other files under `src/` also have no upstream counterpart and are not in this table.

Upstream's `server/decay.js` and `server/healthcheck.js` have no counterpart here and are not
carried at all. Of the five files that do have one, the content analyser and the validation
layer are substantially Jason's work, and most of his `tools.js` and `index.js` survives here
as well — the routing patterns, the validators, and the error classes are his. What changed is
described below; what did not change is his.

**What diverged from upstream**

- **Storage:** SQLite on a RAM disk → MongoDB. Upstream's `ram_disk_manager` and
  `server/decay.js` temporal-decay engine are not carried forward, and the SQLite/RAM code
  paths have been removed rather than left dormant.
- **Transport:** stdio only → stdio *and* streamable HTTP with OAuth, from one source tree.
- **Tools:** 7 → 29. Three are carried from upstream (`recall`, `query_layer`,
  `save_to_layer`); `remember`, `get_stats`, `get_echo_stats` and `get_status` are dropped as
  duplicates or folded into `emet_status`. Twenty-six have no upstream equivalent — the document store (`read_doc`/
  `read_doc_history`/`write_doc`/`list_docs`/`patch_doc`/`retire_doc`/`rename_doc`/`restore_doc`/
  `validate_doc`/`accept_nonconformance`), the transcript tier (`save_transcript`/
  `revise_transcript`/`query_transcripts` — which also reads the pre-2026-07 exchange archive),
  `semantic_recall`, `revise_memory`, `corpus_recall`, `emet_gaps`, `emet_floor`, the setup and
  session family (`emet_initialize`, `emet_status`, `emet_setup_complete`, `emet_session_open`,
  `emet_transcript_append`, `emet_session_close`), and the two access doors
  (`emet_invite_create`, `emet_member_access_create`).
- **The write path:** upstream validates and inserts. Here every layer write,
  transcript write and document write passes through one door that scrubs secrets, decides the
  source tag, fills missing accountability fields with visible markers, digests content and
  metadata into their own columns, reads the row back, and returns one receipt shape. A test
  fails the build on any second door. See *The door* below.
- **Metadata vocabulary:** upstream's whitelist relocated any field it did not know under
  `custom`. EMET's own fields — `supersedes`, `superseded_by`, `superseded_at`, `corrects`,
  `corrected_by`, `valid_until`, `valid_from`, `routing`, `assertion_origin`, and the marker booleans — are first-class, and
  anything that is still relocated is named in the receipt.
- **Charter as data:** `layers.js` carries, beside each layer's prose, its numeric importance
  band, whether it may be revised, whether provenance is required, its aliases and its expected
  share, and the write path reads those rather than hardcoding them.

No claim is made that layered memory, entry supersession, or a split curated/verbatim store
originate here. Comparable ideas ship in other projects. EMET's aim is that the substrate is
not something you have to think about.

---

## Install

**Never deployed anything? Let your AI do it: [docs/GUIDED-SETUP.md](docs/GUIDED-SETUP.md).**
You sign in to two services when asked and paste one URL; the assistant installs, configures,
deploys and verifies the rest. It needs a shell — Claude Code and Cowork have one; Claude
Desktop gets one from an MCP server such as Desktop Commander (one command, in the guide).

**Full walkthrough: [docs/SETUP.md](docs/SETUP.md)** — Atlas, both transports, and the
first-run interview. **Deploying remotely: [docs/DEPLOY.md](docs/DEPLOY.md)**.
**Making your assistant actually use it: [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)**.
**Running bots alongside your assistant** — registering their tags, their own handoffs, the
session loop: [docs/BOTS.md](docs/BOTS.md).

Short version:

```
npm install
cp .env.example .env      # fill in MONGODB_URI and MONGODB_DB
npm start                 # then waits for an MCP client on stdin; Ctrl-C to stop
```

Requires Node 20+ and a MongoDB connection: Atlas, or a local MongoDB 6+ for a one-machine
trial (only `semantic_recall` needs Atlas). `.env` is gitignored — never commit it. List each
host's source tag in `EMET_SOURCE_TAGS` before its first write (see the note at the top).

**Local (stdio)** — as an MCP server entry:

```json
{ "mcpServers": { "emet": { "command": "node", "args": ["/path/to/emet/src/index.js"] } } }
```

**Remote (HTTP)** — `npm run start:http`, or deploy the included `Dockerfile` to any container
host. Set `PORT`, `PUBLIC_URL` (the OAuth issuer — it must match the deployed URL exactly) and
`EMET_OAUTH_PASSPHRASE`. Then add `https://<your-host>/mcp` as a custom connector in each
client. See [docs/DEPLOY.md](docs/DEPLOY.md).

Give every host its own source tag. Over HTTP, document, transcript, and memory writes use the
tag bound at approval; the caller does not pass `source` on those writes. A local stdio host
still passes an exact registered tag as `source`. `EMET_SOURCE_TAGS` registers the tags. Leave
**`EMET_SOURCE_TAG`** unset on a server several hosts share, since a default tag makes every
host look the same; set it only where one host uses the server (a local stdio entry, for
example). Every write records the host that produced it; a shared default tag is ambiguity
rather than attribution.

### First run

Say **"initialize"**. That is the whole interface.

`emet_initialize` is the front door and the only thing anyone needs to know about. On a new
store it returns a short interview — what the assistant should be called, how it should carry
itself, your name, what you are using this for — which your assistant runs conversationally,
then records with `emet_setup_complete`, which also creates the owner person. On an established store the same call returns the
assistant's identity, your profile, and where things were left, so the session opens already
knowing you. A read-scoped `emet_initialize` writes nothing; a write-scoped one may provision a missing board. First-time setup is the owner's:
`emet_setup_complete` is refused under a bot tag, and on a store that is already set up it is
refused unless `reissue: true` is passed on the owner's explicit word.

Requiring a setup command would have been backwards: the one time you need it is the first
session, before you have read anything. So the branch happens inside the tool, and you never
have to know which case you were in.

Connecting the server gives your assistant the ability to remember; it does not make it use
that ability unprompted. [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md) has a short block to paste
into your project instructions, and explains what still works on hosts that have no
instructions field at all.

Two behaviours worth knowing. Setup **refuses to finish on partial answers** rather than
inventing an identity for itself. And if the store cannot be reached, initialize says so
plainly instead of proceeding as though memory were available — fabricated continuity is
worse than an honest gap.

### Every session after that: how to start, how to end

Memory is only as good as the two moments at the edges of a conversation. Nothing your
assistant learned survives unless it was written to the store, and the moment to write it
arrives without warning — a closed tab, a context limit, a phone call. So every session has
one word at the start and one at the end.

**Start: say "initialize".** Your assistant calls `emet_initialize`, which returns who it is,
who you are, where things were left and the operating disciplines, and picks up from there.
Before it asks you anything, it names your items from the handoff and state documents: anything
left half-finished, what is dated in the next seven days, each open item you own with its next
action, and whatever was left undecided. An item not named at the start of a session is easy
to lose, so a count or a bare "where do you want to start?" is not treated as a startup.
Do this in every new conversation, on every device — the first message, before the question
you actually came to ask. A session that skips it is a session that answers from guesswork
and saves nothing.

**End: say "wrap up"** (or goodbye, or that you are opening a new session). Your assistant
then writes four things — the handoff, the state document, an episodic entry for the session,
and the **verbatim transcript** — and calls `emet_session_close`, which checks that each one
actually landed and returns `state: "complete"`. **Wait for that word before you close the
window.** If it comes back anything else, something did not save, and the assistant will say
which.

Why both, every time: the layers are curated meaning and the transcript is the word-for-word
record; the next session reads the first and can reach into the second by timestamp. Close
without the ritual and the next session inherits a hole — it cannot see what happened, only
that something did, and `emet_gaps` will count it. Start without it and the assistant is a
stranger with your tools. The instruction block in [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)
makes both of these automatic on hosts that take standing instructions; on hosts that do not,
the two words are what you supply.

---

## Design notes

### The six layers

Memory is split by *what kind of thing* an entry is, not by topic. Each entry carries an
importance score and optional temporal validity.

| Layer | Holds | Importance | Written |
|---|---|---|---|
| **identity** | Who the assistant is and who it serves. Durable self-definition and the user's standing requirements. | 0.9 – 1.0 | Rarely, by design |
| **semantic** | Facts that stay true regardless of when they were learned. People, systems, definitions, established conclusions. | 0.6 – 0.9 | When a durable fact is established or corrected |
| **episodic** | What happened, and when. Session records, problems solved, progress through long work. | 0.4 – 0.7 | At session close and at milestones |
| **procedural** | How something is done, and decisions that govern future action — *with the reasoning*. | 0.5 – 0.8 | When a decision constrains later work |
| **meta** | Everything visible only from **outside** the exchange: how the memory system behaves, and how the assistant behaves toward the user. | 0.6 – 0.9 | On retrieval failures and wins, protocol drift, and corrections to how the user is worked with |
| **working** | Short-lived context, in-flight state, notes for whoever picks the work up. | 0.3 – 0.6 | When parking state between sessions |

The distinction that does most of the work: **episodic, semantic and procedural are about the
world** — what happened, what is true, how something is done. **Meta is about the system** —
looking back at the exchange from outside it. Material belonging in meta feels like nothing else
fits it, which is precisely why it gets discarded when meta has no definition.

### Every layer works from the first install

Creating six collections is not the same as having six layers. A layer with no stated charter has
no answer to *"does this belong here?"*, so nothing routes to it — and an empty collection throws
no error and fails no test, so it can stay empty indefinitely without anyone noticing.

In the deployment this design came from, **the meta layer sat nearly unused for about a year**.
The collection existed from day one and the tools accepted writes to it; it was simply never the
obvious place to put anything. When it was finally given a definition it filled immediately —
which is the proof that the material had been there all along and was being thrown away.

Two things in this repo exist because of that:

- **`src/layers.js` ships the charter for all six layers in code**, and `emet_initialize` returns
  it — on a brand-new store as well as an established one. Same reasoning as the operating
  disciplines: documentation is read by people, and this has to reach the model at the start of
  every session. What belongs, what does *not* belong, when to write, when to read, and what the
  layer's absence looks like.
- **`assessLayerHealth()` reports a layer that has gone dark.** A store cannot know what *should*
  have been written, but it can see that one layer took almost nothing while the others filled,
  and say so in the first payload of the next session. Run against the real history above, it
  flags meta at 10 entries / 1.8% of the store — and goes quiet once the layer is in genuine use.
  It reports; it never blocks, and it stays silent on a store too new to have a pattern.


**Two tiers, deliberately independent.** Layer entries are curated meaning; a separate transcript
store holds the word-for-word conversation. When a layer entry is relevant but thin, the
transcript holds the depth that was compressed out of it. Summarising at transcript-write time
collapses the two tiers into one and destroys the second line of inquiry — so the transcript path
stores exactly what it is given. If a payload will not transmit, split it across parts; do not
compress it.

**How tier 1 reaches tier 2 — two links, one precedence rule.**

An entry records the transcript span it came from: `session_id` plus a range of exchange indices,
written at save time as `derived_from`. Entries consolidated from other entries carry
`{entries: [id, ...]}` instead, because an entry with no transcript origin must be able to say so
rather than carry a nearest-timestamp guess dressed as a citation. Both are stored as top-level
indexed columns rather than inside the metadata subdocument, so the reverse question — every
entry drawn from this transcript — is entirely a query.

Every entry also has a timestamp, so a window around it can always be searched. The two are not
redundant copies: the pointer is exact but conditional, the timestamp universal but approximate —
it depends on choosing the window, degrades when sessions overlap, and when it is wrong it returns
the *neighbouring* span rather than failing.

**Precedence is what keeps them from conflicting: the pointer wins whenever present, the
timestamp is the fallback when it is null.** Never averaged, never combined, and the timestamp is
never preferred merely because it returned something. `resolveProvenance()` applies the rule so no
caller has to decide it.

**Keeping both buys something neither gives alone — they can check each other.** If an entry's
pointer names a session whose span sits nowhere near that entry's own timestamp, something is
wrong: a mis-written pointer, a field copied from another entry, an entry attributed to the wrong
session. `crossCheckProvenance()` reports the disagreement. Two independently derived answers that
can disagree is redundancy in the engineering sense; one link that can only be trusted is not.

**The reverse direction — *what did we take from this session?* — is not a second structure.**
`source_session_id` is indexed, so it is the same data read the other way. A stored reverse index
would be a mirror of data that already exists, and mirrors are how forks are born.

**Entries written before pointers existed keep a null pointer and resolve by timestamp, and that
remains correct for them — superseded, not wrong.** They are not backfilled: the only way to
invent a pointer for them is to infer it from the timestamp, which is exactly the weaker method
the pointer replaces. Old records are not rewritten to look like new ones. Note also that an empty
timestamp-window search is not proof that nothing was recorded — a period may hold no transcript
at all.

**Supersession, not mutation.** `revise_memory` writes a *new* entry carrying `supersedes` and
marks the parent with `superseded_by` and `superseded_at`. Nothing is edited or deleted, and the
parent is not hidden. Recall ranks by how many of the query's words match, then by importance.
Current entries come first in every order, including time order. The store applies that same order before it keeps the window, so a stronger match is not dropped for a lower importance or an older time. A word matches as written, so `$gt` is that text, and capital and lower case match, including `École` and `école`. `İ` matches only itself. Full-width letters fold only with their full-width counterparts. `ẞ` and `ß` fold together. The store and the page use that same match. Time order is what you get
from `order: 'latest'`. A standalone "latest", "newest", or "most recent", together with other
words, reorders those matches and does not change which rows match. A hyphenated word such as
`latest-budget`, "not the latest", and a bare "latest" are ordinary keywords.
A superseded or expired entry stays in the same result, marked
with its end date and the id of what replaced it. Pass `history: true` when current matches fill
the limit and you still need the ended ones. Episodic entries
are immutable — events do not get revised.

**Corrections, not supersession, for partial fixes.** When a later entry corrects only part of an
earlier one (one item of an episode, say), superseding puts an end date on the whole parent,
including the parts that still stand. The parent stays readable, marked ended. Instead the new entry carries `metadata.corrects: <parent id>` (same layer; a missing
parent is refused before anything is written), and the parent is marked: its `corrected_by` list
gains the new id, its content, digest and liveness are untouched, and its metadata digest is
re-attested in the same write. Reads return `corrected_by`, so a reader of the parent sees that a
correction exists. `corrected_by` is a door marker; a caller cannot set it. Entries corrected
before this existed (e.g. an incident record correcting an earlier one) carry no link; the fix is a new correction
entry naming the earlier entry in corrects, not an edit or a backfill.

**Verified writes - `src/aleph.js`.** Every write is read back and compared before it is
reported as saved. Document writes archive the prior version, then confirm both the sha256 and
the version; layer writes confirm the stored content at the id that was allocated. The id is
checked by content rather than existence on purpose: ids come from a counters collection, and a
counter read from the wrong collection restarts at 1 and silently overwrites real entries -
which looks exactly like a successful save.

A verification failure raises `AlephError`, deliberately distinct from a database error. A
database error means the store could not be reached and the write probably did not happen. An
`AlephError` means the call **succeeded** and the store does not contain what it should. That is
the more serious of the two and the one that must never be retried blindly, so it is never
flattened into "the save failed".

The aleph answers two questions, at two moments. **At the write: was it recorded accurately?**
The read-back above, before any receipt. **At every later read: is it still what was
recorded?** Each row carries its content and metadata digests, an HMAC signature over both
(when `EMET_SIGNING_KEY` is set; the key stays on the service), and a link in its layer's hash chain (each entry's chain
digest covers its own content digest and its predecessor's). Every read recomputes the digests
and reports `integrity`; `emet_gaps` walks the whole chain for any host and counts a row altered
after writing (`broken_chain`) or removed from mid-chain (`chain_discontinuities`). Expected
count for both: zero.

### The door

Truth integrity, accountability and validation are meant to be a guaranteed property of the
store, not an option a model can decline to use. A file a model can be told about is a file it
can ignore. So the guarantee comes from a property, not a module: **exactly one way to write
each store, with the checks inside it.** `saveMemory` for the six layers, `writeDoc` for
documents (`patch_doc` delegates to it), `saveTranscript`
and `reviseTranscript` for the verbatim tier. `tests/write-path.test.js` scans `src/` for every
MongoDB write verb and fails the build on any that sits outside those functions — it found and
removed a second document door in `setup.js`.

Inside the door, in order:

- **Secrets are masked before anything is stored or hashed** (`src/redact.js`): the literal
  values of secret-bearing environment variables, credentials inside URIs, bearer tokens, JWTs,
  and `key: value` pairs whose key names a secret become `*****`. The mask is visible on
  purpose, the receipt's `redacted` reports the number of spans **this write changed** (text
  already carrying the mask is left alone and not counted, so a read-modify-write of a document
  reports zero for the masks it already held), and the same scrubber wraps every rendered log line.
- **The source tag is decided here**, not by the caller over HTTP. Document, transcript, and
  memory writes use the tag bound at approval. On stdio it is the caller's exact registered
  tag, else the environment default marked `source_defaulted: true`, else `null` marked
  `source_missing: true`.
- **Every missing accountability field becomes a visible marker** rather than an absence —
  `provenance_missing`, `assertion_origin_missing`, `importance_defaulted`, `source_unregistered`
  — because absence cannot be queried and "missing" can. A missing field is flagged, not
  refused, with one exception (2026-09-29): a **semantic or procedural** entry with no source
  is refused, because a durable claim that cannot point to where it was said is exactly what
  the record exists to prevent. The door stamps the source from the session's transcript
  position when the caller names its session. Importance defaults to the layer's charter midpoint;
  a value outside the band is kept and warned about. The door never infers an assertion's origin.
- **The routing decision is kept** in `metadata.routing` — whether the layer was chosen by the
  caller or fell back, and what both routers thought — so routing can be measured later instead
  of remembered. **An unlabelled write is never placed by a router:** it lands in `working`,
  flagged `routing.method: 'fallback'`, with a receipt warning. Naming the layer is the norm.
- **Content and metadata are digested into their own columns** (`sha256`, `metadata_sha256`,
  the latter over canonical JSON), read back and compared before the write is reported. Every
  read path — `recall`, `query_layer`, `semantic_recall` — recomputes both on the way out and
  attaches `integrity` and `metadata_integrity`: `true`, `false` (the row is returned and
  flagged, never dropped), or `'unattested'` for rows written before the column existed.
  Supersession and the correction mark are the only sanctioned mutations of stored metadata, and
  both re-attest the parent.
- **One receipt shape on both transports:** `layer, id, timestamp, verified, sha256,
  digest_stored, metadata_sha256, metadata_digest_stored, redacted, provenance, source,
  assertion_origin, importance, routing, warnings[]` plus whichever markers apply.

And the record's honesty about its own holes is a query: **`emet_gaps`** counts, with the ids
behind each count, unsourced assertions, unattributed inferences, ambiguous attribution by tag
and by session, self-routed writes, unattested rows, digest mismatches, pointer disagreements
against the transcript store, broken supersession, broken correction links, expired-but-live rows, consolidation
candidates, and redacted spans by source. It identifies and never fills — where a source is
knowable the fix is `revise_memory` with a real pointer; where it is not, the gap stands as a
fact and the count stops growing from that date. `emet_initialize` carries the counts beside
`layer_health`.

What can be guaranteed this way: every write attested, attributed, scrubbed, and every absence
visible. What cannot be guaranteed without inviting fabrication: every write complete. The
store does not promise the latter.

### Guardrails & Monorails

The door guards each write. **Guardrails & Monorails** guards the order of a session's writes.
**Guardrails** (the floor, the character, the served instructions) bound a field where the AI
moves freely and does its judgment work. **The monorail** (the session graph,
`src/session-graph.js`) carries it from one field to the next without asking it to choose:
open, work, record, board, handoff, close. The car can't derail or leave the beam. Where the
flow must fork, a **switch** at the junction (a small logic unit in EMET's code, tripped only by
its condition, like a transistor; no hosted model, no API) routes the session to the right
guardrail space. The track throws the switch, never the AI. The stations are where the
processing happens, and each station's door opens only when every stop before it has been made.
Switches are designed, not yet built. The server checks the track
on every governed write, so it is the same for any AI on any device. No host hook is needed.
Every skipped step is refused, and the refusal says how to pass. The full practice, the gates and the honest limit
are in [`docs/GUARDRAILS-AND-MONORAILS.md`](docs/GUARDRAILS-AND-MONORAILS.md).

---

## Tools

Twenty-nine tools. `recall` · `semantic_recall` · `query_layer` · `save_to_layer` · `revise_memory` ·
`read_doc` · `read_doc_history` · `write_doc` · `list_docs` · `patch_doc` ·
`retire_doc` · `rename_doc` · `restore_doc` · `save_transcript` · `revise_transcript` · `query_transcripts` ·
`corpus_recall` · `emet_gaps` · `emet_floor` · `validate_doc` · `accept_nonconformance` ·
`emet_initialize` · `emet_status` · `emet_setup_complete` · `emet_session_open` ·
`emet_transcript_append` · `emet_session_close` · `emet_invite_create` · `emet_member_access_create`

**Retained revisions** — every document write archives the prior copy; `read_doc_history` lists
what is retained for a document and returns any retained revision in full, re-hashed against its
stored digest. Retention that nothing could read back was a promise without a witness.

**One reader for the second tier** — `query_transcripts` reads the live transcript store and the
legacy exchange archive (rows written by earlier hosts, before the transcript store existed)
together, in one session shape, each result naming the collection it came from. Nothing is
migrated between them.

**Document control** — `validate_doc` checks a controlled document against the template that
governs it, and the same check runs inside the write path on every document write, where no
caller can skip it. A record that fails is **marked, never rejected**: it lands, carries a
nonconformance marker naming what failed, and stays counted at session start until it is
corrected by a later revision or dispositioned with `accept_nonconformance`. The checks are form
and continuity — sections present, in order and filled; no placeholder left unfilled; every item
on the previous revision still present or carrying a disposition. Whether an answer is *true* is
not something a machine can check, and this one does not pretend to.

**Session start** — `emet_initialize` (start here): fetch every page it names, or pass `page: "all"`
on a host with no size limit; then `emet_session_open` with that startup's `load_id`. Session ids are
dated in the local time zone (`EMET_TIMEZONE`, default `America/New_York`); a closed session is
never reopened, so a slug whose id is already closed opens as `<id>-2`, `-3`, and the result says so.
After a complete close a session takes exactly one more append, its closing exchange, within
`EMET_CLOSE_GRACE_MINUTES` (default 5, at most 60) of the close, written into the session's last
part, and is then locked; a retry of it writes nothing. Corrections with `revise_transcript` stay
allowed but must keep exactly the same exchange numbers.

**During the session** — `emet_transcript_append` after every reply, one exchange at a time.
Every write tool also takes `session_id` and `exchange`, and returns `session_graph.next`, the
next stop on the monorail ([Guardrails & Monorails](docs/GUARDRAILS-AND-MONORAILS.md)).

**Session end** — `emet_session_close`. Checks whether the session's work actually reached the
store — transcript saved and intact, continuity documents updated, an episodic entry written —
and reports exactly what is missing. It does **not** write the artifacts: only the model holds the
session's content, and a tool that generated a plausible-looking summary would be manufacturing
the false continuity the disciplines exist to prevent. `emet_initialize` returns the same protocol
at session *start*, which is the only moment early enough to matter.

**Setup internals and diagnostics** — `emet_status` (environment, layers, health; `probe: true` writes and reads back a probe) · `emet_setup_complete`

### Approvals

Every tool declares MCP annotations — `readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint` — in one table in `src/annotations.js`, which is also the complete statement of
what EMET does to a store. **11 of the 29 tools cannot modify anything**; four can replace the
visible content of a document; `openWorldHint` is false everywhere. The tools reach this
server's own database and nothing else: no filesystem and no shell. The sign-in server fetches
a client's metadata document, and only from a public address it has already checked.

A server that declares nothing is treated as if every call might do anything, so a host that asks
before acting asks before *every* call, including the reads that make up most of a session. These
hints let a host stop asking about reads without being told to trust writes. They are hints, not
enforcement: what is actually auto-approved is a host-side setting. See
[docs/PERMISSIONS.md](docs/PERMISSIONS.md).

---

## Tests

```
npm test
```

1,852 checks across 64 suites (the PASS lines `npm test` prints, counted 2026-10-07). No framework, no database, no
credentials — each suite is a plain node script on one shared harness (`tests/harness.js`), and
the runner discovers every `*.test.js`, so `npm test` runs on a fresh clone. Per-suite counts
are not kept here because they go stale; `npm test` prints them.

`validation.test.js` and `content_analyzer.test.js` began as **upstream's own
suites**, ported unchanged apart from the import path; every one of upstream's assertions still
stands, and the additions cover EMET's metadata vocabulary and the shared layer list. They are
the original author's assertions about the original author's code, and they are kept passing.

The rest cover this tree. Some are fixtures rather than unit tests — they read the source and
fail on a class of drift: `write-path.test.js` allows no MongoDB write outside the
sanctioned doors, requires each door to scrub before it hashes, and requires that **nothing in
the tree removes from a layer, document or transcript collection**; `dispatch.test.js`
requires the declared tool list and both transports' dispatch switches to be the same set, and
that a list response can carry a caller-facing warning; `annotations.test.js` requires
every tool to declare its approval hints; `atlas-role.test.js` requires the database role to
grant no remove on the record. The others test behaviour — among them `aleph.test.js`
(read-back, digests, signatures, the chain walk), `session-graph.test.js` (the monorail's
gates and lab results), `receipt.test.js`, `provenance-stamp.test.js`, `session.test.js`,
`gaps.test.js` and `redact.test.js`. Their failure
cases matter more than their success cases — a verifier that passes something it should have
caught converts an undetected problem into a confident assurance. `layers.test.js` asserts
against the store shape that produced the year-long dormant layer, so the check is tested
against the failure it was written for rather than a hypothetical one.

Upstream's `index.test.js`, `decay.test.js` and `integration.test.js` are **not** carried: they
target the SQLite backend and the temporal decay engine, neither of which exists here. Running
them would produce failures that say nothing about this code.

### Benchmarks

EMET's implementation language was evaluated rather than assumed. The same specification was
implemented in **JavaScript, Python, Go and Rust**, deployed identically, and run against live
Atlas — with a digest equivalence check proving all four did the same work before any timing
was read. **JavaScript won**, on serial in-process cost, on throughput under concurrency, and on
standards provenance as the only candidate carrying an international language standard
(ECMA-262 and ISO/IEC 16262).

The exercise's most useful output was not a language choice but a function to optimise: the
write-path scrubber was paying nearly full cost on documents containing no secrets, and fixing
that saved roughly thirty times what the best available language change could have.

Method, full results, and an explicit account of what was *not* measured:
[docs/BENCHMARKS.md](docs/BENCHMARKS.md). `scripts/redact-bench.mjs` measures the scrubber
alone — run it before and after any change to `src/redact.js`.

---

## Known gaps

Honest list, because the point of this project is that it behaves predictably. What is planned
next is in [docs/ROADMAP.md](docs/ROADMAP.md).

- Rows written before 2026-09-05 carry no content digest and rows written before 2026-09-07
  carry no metadata digest; reads report them as `'unattested'`, and they are not backfilled —
  a digest computed today would attest to today's copy, not to the write. `emet_gaps` counts
  the boundary.
- Entries written before provenance existed keep a null pointer and resolve by timestamp
  window; `emet_gaps` counts them as unsourced. They are not backfilled, for the reason given
  under *Provenance*.
- Two content routers are carried from upstream (a substring keyword router and a content
  analyser). Measured against a 1,175-row corpus both agree with the stored layer well under
  half the time (41% and 36%), so neither places entries: an unlabelled write lands in
  `working`, flagged, with both opinions recorded in `routing` (`keyword_layer`,
  `analyzer_layer`). Retuning them into something fit to route is possible with those
  numbers as the baseline; it is not scheduled.
- `consolidation_candidates` in `emet_gaps` is tag overlap, not semantic similarity.
- The monorail (session graph) refuses every skipped step (enforce only since 2026-10-03; there
  is no report mode or off switch). Its turn coverage is only as strong as the exchange numbers hosts report, and it never sees
  the reply text. See [Guardrails & Monorails](docs/GUARDRAILS-AND-MONORAILS.md).
- The scheduled weekly intake writes without opening a session, so the session-order check
  refuses those writes (gate `no_session`) until the routine opens a session with its startup's
  `load_id` and passes the `session_id`. Its old source tag, `cloud-scheduled-intake`, was retired on
  2026-10-02. A `cloud-scheduled-` prefix is not a registered tag, and those writes are refused.
  The weekly intake runs under `intake-bot`. `emet_gaps` keeps counting the rows already written
  under the old tag as ambiguous attribution instead of rewriting history.
- `save_transcript`'s description does not state that it stores content verbatim; the
  implementation does.
- No export / import / restore-and-compare yet.
- The document store is not prefixed, so one database holds one instance's identity. Run
  separate databases rather than separate prefixes if you want separate memories.
- Dynamic Client Registration is still served beside Client ID Metadata Documents; the MCP
  specification's deprecation window closes around 2027-07. It is scheduled to come off on
  2027-06-01.

---

## License

Authorship of the commit history, including a correction recorded as an addition
rather than a rewrite: `docs/AUTHORSHIP.md`.

MIT. See `LICENSE` — both the original C.I.P.S. LLC notice and the Dreamforge Studio LLC notice
must travel with any copy.
