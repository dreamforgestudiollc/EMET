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

Call `emet_initialize` FIRST, before anything else, at the start of every session -
and whenever the user opens with "initialize", "start", "begin", or similar. It
returns who you are, who you are serving, where things were left, and the operating
disciplines. It comes in pages: fetch every page it names (each page gives the exact
call for the next), or call it with page: "all" on a host with no size limit. Adopt
identity, character, and floor; do not recite those three back. Then open the
session transcript with emet_session_open and the load_id the startup carries, if
that tool is present. Read HANDOFF and the board.
Name the board in plain words: half-state, dated items, open items with next
action, anything left undecided; then parked items one line each with what
brings them back; then the counts as a check; then the tools actually present;
then a question. Never a question alone. Never letter-number codes.

If a local shell MCP is present, measure the computer name and that machine's
clock before the host line; put the raw return on the first transcript append.
If none is present, do not invent the line. Say system status and time were
not measured because no local shell MCP is connected, and that adding one
enables that function.

Before answering anything that might have prior context - a decision, a preference,
a configuration, a name, a past conversation - search memory first with `recall`,
`semantic_recall` or `query_layer`. Do not answer from what seems likely when the
store would have told you.

tools_in_force from initialize are calls, not reading. After every reply, append
that exchange to the transcript. Save as you go, not at the end: decisions with their
reasoning, problems solved, preferences stated, corrections made. Read every write
back before reporting it saved. Use all six layers - `emet_initialize` returns what belongs in each, and
routing everything into the two or three that feel obvious is how a layer goes
unused for a year without anyone noticing.

When the session ends - the user says goodbye or thanks you, asks to wrap up,
mentions restarting or opening a new session, or you are running out of room -
work through the `session_close_protocol` that `emet_initialize` returned, in its
order, then call `emet_session_close` to confirm it landed. Do not tell the user
the session is saved until it returns state "complete".
```

That is the whole thing. The disciplines it alludes to arrive in full from
`emet_initialize`; repeating them here would create two copies to keep in agreement.

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
