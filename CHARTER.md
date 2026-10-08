# EMET ARCHITECTURE CHARTER

**Record control:** id `CHARTER.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-11 · a decision record · revised with the user's approval 2026-09-15 (the consolidated revision, a decision record) · revised at the user's word 2026-09-23 (parked items named at startup; §3 commitment 8, §6 item 3; a decision record) · revised with the user's approval 2026-09-27 (pending lessons named at startup; blocked-close cap and scope at close; §6 items 3 and close; a recorded lesson) · revised with the user's approval 2026-09-29 (the aleph named as the integrity verifier; Guardrails & Monorails, with switches; the database boundary; the per-exchange transcript; the user as final authority; §1, §3 commitments 1, 2 and 9, §4, §6, §8, §10; a decision record) · revised with the user's approval 2026-09-30 (the admission test: four questions before anything is built, DMADV while in design, DMAIC once stable; §3 commitment 6; a decision record) · Tier 1 · owner: the user · decision record: the owner's
**Written:** 2026-09-10, session `2026-09-10_morning-mobile-init`, source `mobile`
⚠ **Public document once the repository is public.** The disclosure line (a decision record) must be drawn before publication. This document states structure and intent only — no implementation specifics.
⚠ **§1 is in the user's words (2026-09-11); attorney review pending** (claim language is on that agenda).

---

## §1 PURPOSE AND INTENDED USE — the user's words, 2026-09-11 (procedural entry of that date) · attorney review pending

**EMET is a persistent contextual memory MCP server that gives an AI assistant a consistent, user-tailored identity, with the option of plug-in customization of interaction style and function.** It gives the assistant a durable, verifiable record that survives across sessions, devices and host applications — who the assistant is, who it serves, what has happened, what has been decided, and where the work stands — so each session continues from the last instead of starting over.

**It is designed with the understanding that it may be used in support of processes and environments operating under ISO quality-management standards such as ISO 9001 and ISO 13485.** Its records are attributable, versioned, never deleted and integrity-checked, and its documents are controlled: every templated write is checked against the template in force, a write that fails that check is marked and kept as the current revision, and a later revision or an acceptance clears the mark. EMET itself holds no certification and claims no conformity. An organization that uses it within its quality management system remains responsible for that system, including validating EMET for its intended use there (ISO 13485 §4.1.6).

**A record that is never deleted or edited must also be accurate** (the user, 2026-09-29: *"It is integral for the ISO data that is never deleted or edited to be accurate"*). Permanence without accuracy only preserves an error. So every write is verified as recorded accurately before it is confirmed, and every later read is checked against what was recorded — the aleph (§4).

**The same expectation governs how EMET is built.** Its code — JavaScript on Node.js today, and any language it is implemented in later — and its development processes are held to it: every change is version-controlled, tested by an automated suite, released deliberately, and verified live with a real call before it is called done, and the history of what changed is kept. That evidence is what an organization's own validation can draw on.

**It is designed first for neurodivergent users** (ADHD, autism, AuDHD), for whom lost context and re-explaining carry a higher cost. It works for anyone.

**Intended user:** one user working with an AI assistant through hosts that support the Model Context Protocol.

**Not intended:** EMET is not a medical device. It does not diagnose, treat or monitor any condition and is not a substitute for clinical care. It does not control what an assistant says; it records what is written to it.

## §2 SCOPE

**In scope:** the record — memory layers, verbatim transcripts, controlled documents, the rules for writing, reading and correcting them, and the standing definition of the assistant.
**Out of scope:** the model's behaviour, the host application, and the conversation itself. **EMET sees what is written to it, not what is said.** No control in EMET can stop an assistant telling a user something false; what EMET can do is make the record honest, attributable and checkable.

## §3 DESIGN COMMITMENTS

1. **Verification over assertion.** Every write is read back by the aleph and verified before a receipt is returned, and every later read is checked against what was recorded. A claim of completion needs evidence.
2. **Nothing is deleted.** Entries are superseded, documents are revised or retired, events are never rewritten. Prior versions are retained. **This holds below the server too:** the database login EMET runs under has no permission to remove the record, so a fault in the server cannot delete it either.
3. **Provenance is part of the memory.** Every write names the host that produced it, and assertions point to their source.
4. **State a rule once.** Rules held in code are pointed to, never copied into documents.
5. **Controls, not reminders.** Where a rule matters, a mechanism enforces it; an instruction to be careful is not a control.
6. **Over-engineering is a defect — the check comes before the build.** Anything may be considered; nothing is built until it answers four questions. **What failure does it fix, and where is it in the record?** An observed failure, not an anticipated one. **What does it replace or retire?** An addition that replaces nothing clears a higher bar. **How will we know it worked?** One measure, checked in a pilot. **What holds it once it works?** A control, not a reminder (commitment 5). What cannot answer all four stays a seed. Additions are gated before they ship, not trimmed after (the user, 2026-09-30: *"I dont want us to become an oreborous eating its tail with proposed additions to then reduce afterwards"*). **The method follows the product's stage** (the user, 2026-09-30: *"The variant works for now, dmaic for once stable"*): while EMET is still being designed, work runs DMADV — Define, Measure, Analyze, Design, Verify. Once it is stable, work runs DMAIC — Define, Measure, Analyze, Improve, Control.
7. **No implied conformity.** EMET puts recognised quality-management practice into operation. It claims no certification.
8. **Out of sight is out of mind.** For users with time blindness or object impermanence, an item not named does not exist. At every session start the server lists the half-finished, dated, open, undecided, and parked rows it can read (`named_items` on `emet_initialize`), and the session says those names. A section that is not a table is marked unread, and an empty list is not a reason to skip the document. A count is the assistant's check, never a substitute for the names. **Parked items are named too, in a list of their own** — what the user deliberately set aside drops out of mind as fast as what they forgot, so parked means out of the way, never out of sight; each is named with what brings it back, and nothing is asked of it (the user, 2026-09-23: *"for ND it's out of sight out of mind"*). Naming the user's own items is external working memory, not unrequested instruction. This commitment is part of the floor.
9. **Guardrails & Monorails.** Judgment and process are kept apart (the user, 2026-09-29). **Guardrails** — the floor, the character, the served instructions — bound a field in which the assistant uses its judgment freely. **The monorail** — the session's order of work — carries it from one field to the next on a track the server checks, which it cannot leave. Where the flow must fork, a **switch** at the junction routes it to the guardrail space that fits: a small logic unit in EMET, tripped only by its condition, like a transistor, with no hosted model and no outside service (the user, 2026-09-29). The track throws the switch; the assistant does not choose whether to follow the protocol or which branch to take. Each switch is designed for its junction, from the function it serves and the flow of information and tasking through it. This is commitment 5 applied to the order of a session.

## §4 ARCHITECTURE — components and their roles

| Component | Role | Where its rules live |
|---|---|---|
| **The floor** | How the assistant engages the user, regardless of configuration. Cannot be edited by setup or by the user. The guardrails' base. | Server code |
| **Bootstrap documents** | The assistant's standing definition: identity, character, the user, available tools. Without them the assistant is a hollow golem — it functions, but only as a transcriber. | Document store, built at the first-run interview |
| **SHEM** | The name the user inscribes — who the assistant is, held in the identity document. In the golem lore the inscription and the Name are separate: EMET is the truth written on the substance; the SHEM is what animates it. EMET supplies the substance and the record; the user supplies the SHEM. Its spoken form is the user's identity phrase (§6). | Identity document, written at the first-run interview |
| **Tier 1 — memory layers** | Curated meaning, in six layers: identity, semantic, episodic, procedural, meta, working. Queried first. | Layer charter, server code |
| **Tier 2 — verbatim transcripts** | The word-for-word record of each session, appended one exchange at a time as the session runs. **Independent of Tier 1 by design** — the independence is what makes it a second line of inquiry. Tier 1 entries point into it by session and span; timestamp is the fallback bridge. | Server code |
| **Document store** | Controlled documents: the board, handoffs, threads, seeds, working papers, bootstrap, this charter. Versioned; every prior revision archived. | Template standard (`templates/STANDARD.md`) |
| **The write path** | The single entry for every write. Masks secrets, attributes the source, marks what the writer left out, digests content and metadata, and hands the write to the aleph before returning a receipt. Refuses a semantic or procedural entry with no source (2026-09-29): a durable claim must point to where it was said. Validates every templated document against the template in force and marks nonconformance for audit and review (live 2026-09-11). | Server code |
| **The aleph** | **Verifies memory integrity.** At the write: that it was recorded accurately — every write is read back and compared before any receipt, and a store that does not hold what was sent is reported as that, never as an ordinary failure. At every later read: that it is still what was recorded — each entry's digests, signature and place in its layer's hash chain are checked, and the whole chain can be walked by any host. Named for the first letter of *emet*: erase it and *met*, dead, remains — a memory that answers without verification. | Server code |
| **The monorail (session graph)** | Checks the order of each session's writes on every host, with no host hook: a session is opened before it is written to, no exchange is skipped, the handoff comes last, nothing is written after a complete close. Each write is told the next stop. Where a flow forks, a switch owned by the track, never the assistant, picks the branch to a guardrail space (designed 2026-09-29; not yet built). Every check is stored with its time as a lab result. Enforce only since 2026-10-03: a skipped step is refused, and there is no report mode or off switch. | Server code |
| **The database boundary** | The login EMET runs under may add and update, never remove the record (2026-09-29). Commitment 2 is enforced by the database as well as by the server. | Database role, defined once in server code |
| **The read path** | Returns entries with their integrity status, verified by the aleph. A superseded entry surfaces marked, naming what replaced it and the date it ended (decided 2026-09-13); a lookup by any id in a supersession chain also returns the live end of the chain, so a cross-reference keeps resolving after every later revision (2026-09-15). An expired entry surfaces the same way, marked with its end date. Current entries come first in every order, including time order. Retired documents stay in the document list and the startup scan, after the current documents, marked with the date and what replaced them. Recall ranks by relevance and importance. Time order is `order: 'latest'`, or a standalone latest, newest, or most recent together with other words. Retained document revisions are readable in full. | Server code |
| **Supplementary corpus** | Optional reference material loaded by the user, separate from memory. | Server code |
| **Extension socket** | **Planned, not built.** Where a GEM (Guided Engagement Module) seats; a RUNE (Registered Utility Node Extension) is a tool etched into a GEM. All GEMs are built to a standard. **Precedence (decided 2026-09-11):** a GEM the user adds takes precedence over the floor's modifiable defaults — voice, pace, how much is explained — and any conflict is resolved with the user when the GEM is added. **No GEM reaches the floor's protections:** it may add depth that complements them, never remove or weaken them. No GEM, whatever its authorship or intent, may compromise the user — and that is enforced by the socket, not left to a GEM author's good faith (commitment 5). | To be written |

## §5 HIERARCHY

**Document hierarchy — four tiers.** Register: `templates/INDEX.md`.
1. **Charter** — this document.
2. **Procedures** — how a session runs; the floor and layer charter in code.
3. **Work instructions and reference** — how to do a specific thing.
4. **Forms and records** — templates, and the documents filled from them.

**Order of authority when sources disagree:**
1. **The user's current word** — on everything the floor leaves to the user.
2. **The floor** — on what is owed to the user regardless of configuration.
3. **The current controlled document** (board, thread) — on where things stand.
4. **Tier 1 entries** — on what happened and what it meant.
5. **Tier 2 transcripts** — on exactly what was said.
A disagreement between sources is recorded, not silently resolved.

## §6 FLOW

**Session start — reads:** initialize → open the session → read the board and the handoff → scan seed triggers.
**Session start — what the user sees, in this order:**
1. **EMET's line:** *"Truth stands. Memory connected."* — or, if the server did not answer, *"MET — the aleph is missing. Memory not connected."* (EMET's line claims truth and connection, never life; the user's name does the animating.)
2. **The user's identity phrase**, if one is set — the SHEM spoken, confirming the assistant's identity loaded.
3. **The named items** — every half-state row, every dated item in the next seven days, every open item the user owns with its next action, and anything left undecided last session; drawn from the board, the user's calendar and any active schedule. **Then, under its own heading, every parked item** — one line each with what brings it back; named, never pressed (commitment 8). **Then, under its own heading, every pending lesson** — a correction the record holds three or more times with no disposition; one line each, named, never pressed. A lesson is settled by a check in code, a rule landed in a controlled document, or a written ruling that it cannot be checked; the server computes the list (`lessons_pending`, 2026-09-27) so the next conversion of advice into a control (commitment 5) is a standing decision, not a count.
4. **The board's counts as the check, never in place of the names.**
5. **What is actually available in this session**, confirmed before any capability is claimed.
6. Then any question. **Never open with a question alone.**
**During work:** append each exchange to the transcript after every reply, as it happens · every write names its session and exchange, and is told the next stop · search the record before answering anything with prior context · write decisions when they are made, with the user's words · write with provenance · verify each write by its receipt.
**Session close — this is the one place the order is stated:** update working documents → session record in memory → board → verbatim transcript, confirmed complete (it was appended as the session ran) → **handoff last, in one write** → confirm every artifact landed. The handoff is last because its close verification attests to the other artifacts; written earlier, it attests to things that do not yet exist and needs a patch afterwards. If a session ends mid-close, the prior handoff stands and the board and session record already carry the session. **A close that fails its check is returned with a scope per missing item — what may be touched to clear it and nothing else — and the third blocked close on one session escalates: the assistant stops, hands the user the list, and waits for their word. The counter resets only with a new session (rule in code, 2026-09-27).** **The server checks this order on every write (the monorail, §4):** a skipped step is refused. Enforce only since 2026-10-03; there is no report mode.
**Correction:** a layer entry is superseded by a revision that stands alone · a document is revised or retired · an event is never rewritten; a later entry corrects the reading of it.

## §7 DOCUMENT CONTROL

Governed by `templates/STANDARD.md`. Base templates must be followed and may be expanded, never loosened. Every templated write is validated; a nonconforming write is **marked for audit and review**, never silently accepted and never discarded.

## §8 ROLES

- **User** — owns the intended use, makes decisions, sets standards for how the assistant works. **The final authority** (the user, 2026-09-29: *"AI assistants are subordinate to the user. While it is a collaborative relationship without a sycophantic role by the AI, the user is the final authority"*).
- **Assistant** — executes, verifies, records. Recommends and disagrees plainly; never records its recommendation as the user's decision.
- **Host** — the application running the assistant. Every host writes under its own source tag.
- **EMET** — the record, and the enforcement of whatever code can enforce.

## §9 CHANGE CONTROL

This charter changes by revision, with the user's approval. Rules held in code change by release: committed, deployed, and verified live with a real call — **a pushed fix is not a live fix.**

**This charter is locked the same way as the base templates** (`templates/STANDARD.md` §9a, L1 — decided 2026-09-11). It ships with the release and the server reads it from there; any copy in an install's store is for reading, not authority, and a store copy that differs from the shipped copy is marked nonconforming. `emet_initialize` points to it in every state, **including a new store before the first-run interview**, so the floor, this charter and the startup instructions are present before any SHEM is placed.

## §10 LIMITS, STATED PLAINLY

- Retrieval is not guaranteed complete, and an assistant's behaviour is not reproducible run to run. **EMET's record is deterministic and verifiable even where the assistant is not** — that is the claim, and its limit.
- EMET is derived from the CASCADE memory server (MIT licence); attribution is maintained in the repository.

**Where an AI assistant can be controlled at all, and which of those places EMET is** (the user's assessment, 2026-09-14; placed here at his direction 2026-09-15 so the charter is one complete record). Three places:

1. *Training.* The model's maker sets what the model tends to do. Out of reach of any user, host or server.
2. *The host.* The application running the assistant. Some hosts expose deterministic hooks — before a tool call, after an output — that can block an action regardless of what the model intended. Where a host offers them, that is real enforcement, and it belongs to the host. Many chat hosts expose none. **EMET depends on none of them** (the user, 2026-09-29): it must run the same for any assistant, on any device, with no model- or host-specific tool.
3. *EMET — the write boundary.* EMET sees exactly one thing: the calls the assistant makes to EMET's own tools. It never sees the user's message and never sees the assistant's reply (§2). **Within that boundary it checks each call and, since 2026-09-29, the order of the calls** (the monorail) — so a skipped exchange or an early handoff is caught on every host, without a hook. This does not widen what EMET sees.

**Why "delivered at session start" is not "enforced".** The floor and the character document reach the assistant through `emet_initialize` and are then context — text the model reads before generating. Instructions in context shape a probabilistic generation; there is no point in the process where a rule is checked and passed or failed. An assistant that drifts from the floor has not weighed it and decided to step over it; it has generated a reply in which the floor did not carry enough weight. This decides which fixes work: restating a rule more forcefully adds no check, and a reminder is not a control (commitment 5). **Drift is not a decision to violate.**

**What EMET enforces** is everything that passes through the write path, deterministically (§4): the receipt, and the aleph's verification behind it that the record holds exactly what was written; the source tag, the provenance pointer and origin on assertions; template validation on documents; supersession in place of deletion, held by the database as well as the server; masking of secrets; and the order of a session's writes. The forms of drift that reach the record are therefore caught at the door — a task row opened without the user's words behind it, an assistant's reading written into the field that holds the user's quote, an assertion with no origin, a turn left out of the transcript.

**What EMET does not enforce.** It cannot stop an assistant saying something unfounded to the user; nothing at the memory layer can. It cannot stop an assistant proposing work the user did not ask for, unless the proposal is written to the record, where it can be marked. It cannot verify that a stored assertion is true, only that it is attributed and sourced, and that the record holds it exactly as it was written. It filters writes, not responses.

**What this means for a user.** The controls that catch conversational drift are the user's own questions, a host's hooks where they exist, and — for a high-stakes session — a second assistant asked to check the first. EMET's contribution is that when drift happens, the next session can see it, attribute it and correct the record without erasing the evidence. That is the whole of its jurisdiction, and it is the part that survives a change of model, host or vendor.
