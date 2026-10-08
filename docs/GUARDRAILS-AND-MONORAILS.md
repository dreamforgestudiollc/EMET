# Guardrails & Monorails

*An EMET architectural practice: how the memory function keeps an AI's work consistent and its record whole, without leaving it to the model to choose.*

## The idea

An AI working with persistent memory does two kinds of work:

- **Judgment work:** reading a person, weighing a decision, writing a reply, deciding what is worth saving.
- **Process work:** opening the session, appending each exchange to the transcript, writing the board before the handoff, closing in order.

Judgment work needs room to move. Process work needs to happen the same way every time, whether or not the model remembers or feels like it. EMET treats these two differently, and the name for that is **Guardrails & Monorails**.

- **Guardrails** bound a field. Inside them the AI moves freely and does its processing. The guardrails keep that processing honest and in character. In EMET, these are the floor, the character and user documents, and the served instructions (`operating_discipline`, `tools_in_force`, `session_close_protocol`).
- **The monorail** carries the AI from one field to the next without asking it to decide. In EMET, this is the **session graph** (`src/session-graph.js`), the state-driven track a session runs on, checked by the server on every write.

In the words of the owner, who named the practice (2026-09-29):

> "Guardrails give a field of movement and execution to allow an AI to do processes, where rails guide the AI through a process flow without it processing, to bring it to another space where it expands into a processing space with guardrails."

### Why a monorail

The practice was first called Guardrails & Rails. It was renamed Guardrails & Monorails the same night, as the more accurate picture of what guidelines and graphs do together.

A monorail car straddles its beam: it can't derail, and it can't leave the track.

The board is a guardrail with no write door. The server provisions it. After that the only change is an edit with a reason, and a change that leaves any document under half the size it had when this session first touched it is refused. A monorail does have switches, but they belong to the track. A section of the beam moves, and the system throws it, not the car. The car runs from station to station, and its doors open only when it's stopped at a station.

- **The stations** are the processing spaces: a workshop, a kitchen, a study. The AI steps out at each one and works freely inside the guardrails.
- **The beam** is the protocol order: open, work, record, board, handoff, close.
- **The switches** sit at junctions on the beam. Each one routes the AI to one of several guardrail spaces, where it works in a bounded way. The track throws the switch; the AI rides it.
- **The doors** are the server's checks. A station's door opens only when every stop before it has been made.

The same thing can be pictured as a building, with **hallways and rooms**. The rooms are where work happens, and the hallways carry you to the next room without any decisions along the way.

It resembles Chutes & Ladders only on the surface, as a board with fixed paths between squares. In that game the paths are chance. In EMET they are set by the state of the session, and they never move the AI backward as a penalty. A door that stays shut says exactly which stop is owed and how to make it.

## Why a monorail, and why in the server

Guidelines alone depend on the model choosing to follow them. A model under a long context, a cut-off payload or a lost turn will sometimes not follow them. The record then has a hole that nobody sees. EMET's standing rule is that integrity is a property of the store, not an option a model can decline (see *The door* in the README). The monorail applies that same rule to the session's order of work.

The monorail lives in the **EMET MCP server**, not in any host. There's no Claude Code hook, no CLI step and no model-specific tool. Any AI, on any desktop or phone, that can call EMET's tools rides the same track, because the check is made where the write lands.

## How the monorail works

Every governed write (`save_to_layer`, `revise_memory`, `write_doc`, `patch_doc`, `retire_doc`, `rename_doc`, `accept_nonconformance`, `emet_transcript_append`, `save_transcript`, `revise_transcript`, `emet_session_close`) names its session, either as `session_id` or as the session in `derived_from` (for `emet_session_close`, `receipts.transcript_session_id` when `session_id` is omitted, the same session the close checks), and carries `exchange`. Before the write runs, the server reads the session's state from `<prefix>sessions` (opened, board, episodic, handoff, closed) and the transcript's highest appended exchange. It then decides whether the door opens.

**Writes outside the graph, on purpose.** Four tools write without a session and are not governed: `emet_setup_complete` (records the first-time interview as the bootstrap documents and the owner; it runs before the store has an identity, and a host mid-setup must never be refused for lacking a session it may not have opened yet, though it can open one with its setup `load_id`); `emet_invite_create` and `emet_member_access_create` (the owner's access codes, kept in their own collections, not the record); and `emet_status` with `probe: true` (writes one probe document, reads it back and removes it to prove the write path). `emet_session_open` has its own gate (`startup_pages`). Every other write tool is governed.

| Gate | The door stays shut when | What the refusal says to do |
|---|---|---|
| `no_session` | a governed write names no session at all | open one with `emet_session_open` (with the `load_id` from your startup pages), or use the `session_id` already opened, then resubmit the same write with it |
| `not_open` | the write names a session that was never opened | open it with `emet_session_open` (with the `load_id`), then resubmit the same write with the `session_id` it returns |
| `turn_skipped` | exchange *n* is declared but *n−1* was never appended | append the named exchange with `emet_transcript_append` (this `session_id`, that `exchange_index`), then resubmit the same call |
| `handoff_early` | `HANDOFF.md` is written before the board, the episodic record and the transcript | write each missing step with its tool (the board with `write_doc` or `patch_doc`, the episodic record with `save_to_layer` layer `episodic`, the transcript with `emet_transcript_append`), then the handoff again |
| `startup_pages` | `emet_session_open` is called without a `load_id`; with a `load_id` this server has no record of (made up, not served by this process, expired 60 minutes after its last page, or from before a restart), since its pages cannot be checked; or while pages of that load were never fetched (never checked against another host's load) | pass `load_id` from your startup (`startup_page.load_id`, carried by every `emet_initialize` result: each page, `page: "all"`, a one-result startup and a store not set up yet); for a load with no record, call `emet_initialize {}`, fetch every page and open with the `load_id` it returns; for missing pages, the call comes first: the exact `emet_initialize {"page": N, "load_id": ...}` for the first missing page, the missing pages once as ranges (`2-40`), then open again with that `load_id` |
| `closed` | a write arrives after a complete close - except the one closing exchange inside the grace window, and a transcript correction | nothing in this session: the work belongs in the next session opened the usual way (never one opened just for it) |

Every refusal is made before the tool runs, so nothing is written, and its reply carries the pass instruction above (each fits inside the 500-character error-message cap). The same holds for the source-tag refusals on transcript writes, which lead with `pass "source"`: a missing or unregistered tag is told to pass a registered tag, and the refusal does not list the registered tags. Only an exact member of `EMET_SOURCE_TAGS` counts. A `cloud-scheduled-` prefix does not. Any id or tag the caller sent is echoed at most 64 characters, so no refusal is cut before its instruction.

Every governed result carries a `session_graph` block: `{mode, verdict, gate, reason, next}`. `next` is the stop after this one, taken from the state, so the AI never has to work out where it is. After a successful call, the server records the stop. A governed write that names a session fails closed when the graph cannot be read: nothing is written, and the reply says the session graph is unavailable. A write that names no session is refused by the `no_session` gate before the graph is read. (The closed-session checks on the transcript doors and `emet_session_open` fail safe instead, below.)

**A closed session takes no new exchanges, except its closing exchange** (2026-10-01, the owner's decision). In the closing turn the assistant writes the handoff, gets `complete`, and only then replies, so the append of that last exchange always arrives after the close. A closed session therefore takes exactly **one** more `emet_transcript_append`: numbered highest+1, within `EMET_CLOSE_GRACE_MINUTES` (default 5; `0` turns the window off) of the recorded close time. The reply's `closing_exchange` says it was accepted and that the session is now locked. The closing exchange is written into the session's last live part, whatever session id the append names. A retry of that same exchange number is answered as already saved by the check itself; the append tool is not called, so a retry writes nothing, at any time. Ids are grouped the way the close check groups them (`<base>`, `<base>_verbatim_partN`, and any other `<base>_...` id all belong to `<base>`), and `exchange_index` is checked once (a whole number of 1 or more, or its text) before the monorail, the check and the tool read it. After that one append, or once the window passes, appends are refused with a reply that says the session is closed and locked, nothing was written, and the exchange belongs in the next session opened the usual way. `save_transcript` into a closed session is refused. `revise_transcript` is **allowed** (a correction supersedes and deletes nothing), but on a closed session a revision may only correct the exchanges its part already holds, never add new ones, and must carry exactly the same exchange numbers (none dropped or repeated; numbers sent as text are stored as numbers), so the closed session's exchanges cannot grow, shrink or be renumbered. These checks always run before the tool and fail safe: if the session's state, its transcript position or the part to be revised can't be read, nothing is written and the reply says to send the same call again. They decide every transcript write into a closed session (the graph defers to them), and their refusals are logged in the lab as `refuse`, gate `closed`. `EMET_CLOSE_GRACE_MINUTES` is capped at 60; a negative or non-numeric value (hex such as `0x10` included) is logged and the default 5 is used.

**The close is recorded before its reply, when the write succeeds.** When `emet_session_close` returns `complete`, the server writes the closed flag and its time (`closed_at`) to `<prefix>sessions` and only then replies, with `closed_recorded: true`. If that write fails it is retried once; if it fails again the reply says `closed_recorded: false`, with a warning in `closed_record_warning`, `warnings` and `instructions`: the session is not locked until a later close records it.

**Bot sessions close against their own records** (per-bot close records, 2026-10-01, the owner's decisions). Each bot runs in its own session, and the main `HANDOFF.md` and `STATE.md` hold only the owner's hub conversation. A tag is a bot tag when `bots/<tag>/HANDOFF.md` is listed in `EMET_RECORD_DOCS`; the session's tag is the source tag on its transcript. For a bot tag's write of its own `bots/<tag>/HANDOFF.md`, the `handoff_early` gate and the "handoff written" step work as they do for the main handoff, without the board condition (a bot keeps no board unless it lists one as a working document), and they refuse like every other gate. The gate keys on the write's `source`; a write with no `source` takes the host path. The bot's close itself checks `bots/<tag>/HANDOFF.md` and seven receipts (no board; `handoff_doc` names the bot's handoff), counts only that tag's own revisions in the window, is `blocked` if a receipt names the main handoff or board, and `incomplete` if the bot's tag revised either. `write_doc`, `patch_doc`, `retire_doc`, `rename_doc` and `accept_nonconformance` refuse the main handoff and board under a bot tag, and nothing is written. The same five tools also refuse a bot tag any write under `bots/` outside its own `bots/<tag>/` (other bots' records and `bots/ROSTER.md`), and when `EMET_SOURCE_TAGS` is set they refuse the main handoff and board to any `source` not listed in it, and refuse any write under `bots/` by anything other than a listed bot unless its tag is listed, a missing `source` and `cloud-scheduled-*` included. A registered tag that is not listed as a bot can still write the main records and any bot's folder (a known gap, F-2). Since startup stage 1, `retire_doc` and `rename_doc` are refused to a bot tag for every document, its own `bots/<tag>/` folder included (retiring and renaming are the owner's and the hub's), and `emet_setup_complete` is refused to a bot tag. Before either guard, the same five tools refuse a look-alike doc id: a leading `/`, a `.` or `..` segment, or `bots/` in the wrong case (`Bots/`); also a control or invisible formatting character anywhere (zero-width space, BOM, direction overrides), leading or trailing whitespace on the id or any segment, a backslash, the same `/`, `.`/`..` and `bots/` shapes after Unicode NFKC folding (full-width dots and slashes, `‥`, full-width letters; the first segment must be the ASCII `bots`), and a case or Unicode variant of a main-record id (`handoff.md`, ` HANDOFF.md`). Doc ids are flat strings, never resolved as paths or URL-decoded; there is no confusables table. One exception, for cleaning up ids written before these checks: `retire_doc`, and `rename_doc` from such an id onto a clean one, are let through for a tag listed in `EMET_SOURCE_TAGS` that is not a bot tag (never for a bot, an unlisted or missing tag, or with no registry set). With no registry set, both guards are opt-in and nothing changes. A session has one tag: if its transcript parts carry more than one and any is a bot tag, the close is `incomplete`. Host closes keep their eight receipts and their verdict; revisions by other tags that the full rule would not count are listed in `attribution_warnings`.

### Mode: enforce only

Since 2026-10-03 the monorail runs in enforce only. There is no report mode and no off switch; `EMET_SESSION_GRAPH` is no longer read. Every skipped step is refused before the tool runs, the reply says how to pass, and the refusal is logged in the lab. Lab rows with verdict `would_refuse` are from report mode, before that date.

### Switches: small logic at each junction

*Design stated by the owner, 2026-09-29. Not built yet: the live monorail is one straight line with the four gates above.*

The architecture needs flexibility of flow: at some points a session should go one way or another, into a different guardrail space, depending on what is happening. That choice must not cost heavy processing, and it must not be left to the model. So each junction gets a **switch**: a small, purpose-built logic unit inside EMET.

- **Like a transistor (an IGBT).** A switch conducts only when its gate condition is met, and it is tripped by that condition, nothing else. The condition is read from what EMET already holds: the session's state, the call being made, and what the record says. The branch it selects is where the session goes next.
- **Small and local.** A switch is a few lines of logic in the server's code. No hosted model, no outside API, no model call. It gives the same answer for the same inputs, every time, so it can be tested like any other gate. This is the role a fast external decision model (such as JEV) plays in other designs, done here by the track itself.
- **Designed per junction.** Each switch's design follows the function it serves and how information and tasking flow through that junction. There is no general-purpose router: a junction gets a switch only when a real fork exists, and the switch knows only what that fork needs (commitment 6: over-engineering is a defect).
- **Bounded on every branch.** Each branch leads to a guardrail space, for example a GEM once the socket exists, or a work instruction for a kind of task. The four gates still apply on every branch, so a switch can change where the session works, never whether its steps are recorded.
- **Recorded.** Each time a switch trips, the lab results record which way it went and why, so its conditions can be checked against real sessions before anything depends on them.

### Lab results

Every check the monorail makes (ok, refuse, unknown; `would_refuse` and `late` in rows from report mode) is written the moment it happens as one timestamped row in `<prefix>graph_lab`. Each row records the time, session, host (source tag), tool, the exchange the call declared, the transcript's highest appended exchange at that moment, the mode, the verdict, the gate and the reason. Rows are only ever added, never changed or removed. A failed lab write is logged and never slows or blocks the call.

`emet_gaps` serves the summary as `graph_lab`: the total number of checks, first and last timestamps, the number of sessions, counts by verdict, gate and host, and the flagged rows (anything not ok) newest first. Because it's a tool call, any AI on any device can pull the lab results.

**Startup pages fetched late** (2026-10-03). In enforce only an open with a page missing is refused, so no session opens without its pages and no `late` row is written through the server's door. The summary still pairs `late` rows with a `would_refuse` open (a page fetched late is not still missing, and an open whose every missing page came late is not flagged), for any such rows written in report mode; an open refused stays flagged.

**One process only** (2026-10-03). The record of which startup pages were fetched, which the `startup_pages` gate reads and the late pairing uses, is held in the memory of the one server process that served them. Pages served by another instance are not on it, so this gate assumes EMET runs as a single process; with several instances it could refuse an open whose pages were fetched from another instance. A restart, or 60 minutes without a page of that load being served (its own lifetime; the cache of startup payloads still keeps them 10 minutes), clears it, and a load with no record is refused with the way back (a fresh `emet_initialize {}`), so after a restart or a long pause before the open every host fetches its startup again, once. Pages are never taken as checked when they were not.

**How to read them:** each flagged row is either a real skipped step that was refused (the monorail working) or a gate that is wrong (fix the gate).

## The honest limit

The server sees tool calls, never the reply text. It can confirm that exchange 8 was appended before exchange 9 was declared. It can't confirm that exchange 8 holds what was actually said, or that a reply was given without a call at all. Turn coverage is only as strong as the exchange numbers hosts report. The guardrails (character, floor, disciplines) carry what the monorail can't reach, and `emet_gaps` counts whatever holes remain.

## Where it lives

- `src/session-graph.js`: the gates (`evaluate`), the next stop (`nextStep`), the recorded stops (`recordStep`) and the thin store layer (`graphBefore`, `graphAfter`).
- `src/dispatch.js`: the checkpoint before every governed tool and the `session_graph` block on every result.
- `src/tools.js`: `session_id` and `exchange` added to every governed schema from the graph's own tool list.
- `src/setup.js`: `tools_in_force` and the short instructions tell every host to pass both fields and follow `session_graph.next`.
- `tests/session-graph.test.js`: the gates, the next stop, and the fail-closed door when a named session cannot be read.
