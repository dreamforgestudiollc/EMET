# Wiring EMET into your assistant

Connecting the server gives your assistant the *ability* to remember. It does not make it
*use* that ability. An assistant with memory tools and no instruction about them will answer
from what it can infer, save nothing, and leave you to notice.

This is the layer that closes that gap, and it is deliberately small.

---

## Why it is short

A memory system usually arrives with a long standing prompt — identity, protocol, rules,
startup sequence — pasted into every project and re-pasted whenever it changes.

EMET moves almost all of that into the server. `emet_initialize` returns the assistant's
identity, the user profile, recent context, and the operating disciplines, **on every call, on
every host.** So the block you paste does not need to contain any of it. It only needs to say:
call that first, and mean it.

The practical consequence: when you change who your assistant is, you change it once with
`write_doc` and every host picks it up on the next session. Nothing to re-paste anywhere.

---

## The block

Paste this into your project's custom instructions, system prompt, or equivalent.

```
## Memory

You have persistent memory through EMET.

Call `emet_initialize` first, before anything else, at the start of every session, and whenever the user opens with "initialize", "start", "begin", or similar. It returns who you are, who you are serving, where things were left, and the operating disciplines.

Fetch every startup page it names. Each page gives the call for the next page. On a host that reads a long result whole, call it with page "all" instead. Keep `startup_page.load_id`.

Call `emet_session_open` with that `load_id`. An open with no `load_id`, with a page still unfetched, or with a `load_id` this process does not have, is refused. Nothing is opened.

Adopt identity, character, and floor. Do not recite those three back. Read HANDOFF and the board. Name the board in plain words: half-state, dated items, open items with the next action, and anything left undecided. Then name parked items, one line each, with what brings them back. Then the counts as a check. Then the tools actually present. Then a question. Never a question alone. Never letter-number codes.

If a local shell MCP is present, measure the computer name and that machine's clock before the host line. Put the raw return on the first transcript append. If none is present, do not invent the line. Say that system status and time were not measured because no local shell MCP is connected, and that adding one enables that function.

The first successful `emet_transcript_append` must carry that measured line, or the words `no local shell MCP`. The check is on the append that opens the transcript, or that becomes the lowest stored index, whatever `exchange_index` it uses. A refused exchange 1 does not let a higher index start the transcript. Nothing is written until the line is present.

Before answering anything that might have prior context, search memory first with `recall`, `semantic_recall`, or `query_layer`. Do not answer from what seems likely when the store would have told you.

`tools_in_force` from initialize are calls, not reading. After every reply, append that one exchange with `emet_transcript_append`. Pass `session_id` and `exchange` on every write. Follow `session_graph.next`. A governed write with no open session is refused, and nothing is written.

Save as you go, not at the end. Save decisions with their reasoning, problems solved, preferences stated, and corrections made. Read every write back before you report it saved. Use all six layers. `emet_initialize` returns what belongs in each. Routing everything into the two or three that feel obvious is how a layer goes unused for a year without anyone noticing.

When the session ends, the user says goodbye or thanks you, asks to wrap up, mentions restarting or opening a new session, or you are running out of room. Work through the `session_close_protocol` that `emet_initialize` returned, in its order, then call `emet_session_close`. Do not tell the user the session is saved until it returns state "complete".
```

## What a skipped step costs

The monorail is enforce only. `EMET_SESSION_GRAPH` is not read. There is no report mode and no off switch. A refusal happens before the tool runs, when the gate is on the session graph. Nothing is written. The reply says how to pass. The gates are in [GUARDRAILS-AND-MONORAILS.md](GUARDRAILS-AND-MONORAILS.md).

- Skip `emet_initialize`. You have no `load_id`. `emet_session_open` is refused.
- Skip a startup page. `emet_session_open` is refused. The gate is `startup_pages`.
- Skip `emet_session_open`. A governed write is refused. The gate is `no_session` or `not_open`.
- Skip an exchange. The next index is refused until that exchange is appended. The gate is `turn_skipped`.
- Open the transcript without the measured machine line, or without the words `no local shell MCP`. `emet_transcript_append` is refused with `EMET-MEM-018`. A higher `exchange_index` does not get past that check. A refused exchange 1 leaves the transcript empty, so the next index is still the first successful append. `save_transcript` does not run this check. Use `emet_transcript_append` when the host can append one exchange at a time.
- Write the handoff before the board, the episodic record, and the transcript. The write is refused. The gate is `handoff_early`.
- Call `emet_session_close` before those steps land. The result is not `complete`. Do not tell the user the session is saved. The next session cannot see work that was never written. `emet_gaps` counts the holes that did land.

A host that skips the track can still talk. The store does not keep the work. One project is one instance. See [SECURITY-AT-SCALE.md](SECURITY-AT-SCALE.md).

That is the whole thing. The disciplines it alludes to arrive in full from
`emet_initialize`; repeating them here would create two copies to keep in agreement.

When more than one bot shares the owner login, the owner approves a new writer and each bot's own key on `/owner/chooser`. An AI does not grant a writer. A bot that can keep a key file presents that key at `emet_session_open`. The open returns `session_handle` once. Every later write in that session passes `session_handle`. A write that omits it, or sends a different one, is refused, and nothing is written. The handle is not a receipt. With sub-keys off, the field is absent. See [SUBKEYS.md](SUBKEYS.md) and [BOTS.md](BOTS.md) §4.

---

## Hosts differ, and EMET degrades gracefully

**Hosts with an instructions field** — a claude.ai Project, a `CLAUDE.md`, a system prompt,
a custom GPT. Paste the block. This is the strongest integration: the assistant reaches for
memory unprompted, on the first turn, without being told.

**Hosts with projects but no instructions field** — some vendors offer a project or workspace
that groups conversations without letting you set standing instructions. **It still works.**
The tool descriptions do the work: `emet_initialize` is described as "START HERE," and a
capable model calls it when you open with "initialize." You are relying on the model reading
its tools rather than on a standing instruction, which is slightly less reliable and entirely
usable.

**Plain chat with the connector enabled** — same as above. Say "initialize" and the session
comes up with your identity and context. No project, no instructions, nothing to configure.

**What actually degrades** without an instructions field is the *unprompted* behaviour: the
assistant is less likely to search before answering, or to save a decision you did not ask it
to save. If you find that happening, the instruction block is the fix — and on a host that has
no field for it, pasting it as your first message of a session works as a fallback.

---

## Adding your own layer

Everything above is the minimum. Some people want more: a house style, project-specific
priorities, a checklist to run at session start.

Keep that separate from the memory instruction, and prefer putting it **in the store** rather
than in the paste. A document written with `write_doc` is read by every host and changed in
one place; text pasted into three different projects is three copies that will disagree within
a month.

The identity and user documents created by the setup interview
(`bootstrap/IDENTITY.md`, `bootstrap/USER.md`) are ordinary documents. Edit them with
`write_doc`, and every host sees the change on its next `emet_initialize`. That is the
intended place for "who this assistant is" to live.

**Your hosts and machines go in `bootstrap/INSTALL.md`** (or whatever `EMET_INSTALL_DOC`
names). The server cannot see which host or computer a session is running on, so it serves
this document whole at startup as `install_notes` and tells the assistant to run the checks
it names, in its order, before listing your items. Put in it what only you know: how to tell
your hosts apart, which machine is which and how to check, the session-id form you want, the
source tag each host should write under, and any tool quirks worth knowing before the first
call. Without it the assistant still mints a session id and picks a source tag from
`EMET_SOURCE_TAGS` - it just cannot check what it has not been told about.

Delivery preferences - how short, how plain, what to leave out - belong in
`bootstrap/USER.md`, not in a host's own memory feature. A preference kept by one vendor's
memory does not travel to the next host; the user document does.
