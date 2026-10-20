# EMET — Next Steps and Proposed Features

Status as of 2026-10-11 (last full report: [status/2026-09-29-state-of-the-system.md](status/2026-09-29-state-of-the-system.md)). This is a working roadmap, not a commitment: items move when the owner rules on them. Nothing here is built unless it says so.

## Where things stand

- **Live:** 30 tools (11 read-only); `EMET_SUBKEYS=1` adds four sub-key tools. Layer writes and reads native to MongoDB; server-side checks on session start and close (machine line on the first transcript append, blocked-close cap with scope, pending lessons at startup); receipts required at close; the handoff is a record, superseded and never amended.
- **The aleph** verifies every write by reading it back before any receipt, and every later read by its digests, signature and place in its layer's hash chain. `emet_gaps` walks the whole chain for any host.
- **Guardrails & Monorails** ([docs/GUARDRAILS-AND-MONORAILS.md](GUARDRAILS-AND-MONORAILS.md)): the server checks the order of a session's writes. Enforce only since 0.2.1 (deployed 2026-10-03; report mode 2026-09-29 to 2026-10-03): every skipped step is refused with the way to pass, and every check is stored as a timestamped lab result.
- **The database** login runs under the least-privilege role `emetRecordKeeper`: it can insert and update, never remove the record.
- **Startup load:** since 0.2.1, `emet_initialize` is served in pages of at most 18,000 bytes as received (on a live-sized store, five pages totalling about 68 KB as received, or about 64 KB whole), so a host that cuts long results short still reads all of it; `page: "all"` returns it whole on a host with no size limit.
- **GEM standard:** drafted 2026-10-11, revision Draft. The socket seats bundled prompt GEMs. Neurendipity is installed at `gems/neurendipity` and off unless `EMET_ACTIVE_GEMS` names it. The text is in [`gem-library/`](../gem-library/README.md). Canonical home: private repository [EMET-GEMs](https://github.com/dreamforgestudiollc/EMET-GEMs).

## Next steps, in order

1. **Monorail: enforce only** (decided and deployed 2026-10-03, release 0.2.1). Every skipped step is refused and the refusal says how to pass; there is no report mode or off switch. Every host and scheduled routine must now read its startup, open a session with its `load_id`, and pass the `session_id` on its writes.
2. **Admission test on the proposed items.** Every proposed feature below answers the four questions of charter commitment 6 before it is built (2026-09-30 read: the compiled-pages pilot passes; the lint pass needs a named measure; hybrid search, graph links and confidence scores do not pass yet).
3. **Initialize payload trim.** Character document trim; measure the payload again.
4. ~~**Register or retire the `cloud-scheduled-intake` source tag.**~~ Retired 2026-10-02 (Alex, procedural ref 405 item 7): it is a legacy tag; the weekly intake now runs under `intake-bot`, with no `session_id` on its writes; under enforce-only those writes are refused (`no_session`) until it opens a session with its startup's `load_id` (item 1). The existing rows keep counting as ambiguous in `emet_gaps` rather than being re-attributed, and the count stops growing as long as nothing new is written under the old tag. The prefix `cloud-scheduled-<task>` does not count as registered. Only an exact tag in `EMET_SOURCE_TAGS` is accepted, and a refusal does not publish the list.
5. **Monorail switches.** Small logic at each junction where a session's flow must fork, routing it to the right guardrail space: tripped only by its condition, like a transistor; no hosted model, no API; each designed from the function it serves and the flow of information and tasking through it ([GUARDRAILS-AND-MONORAILS.md](GUARDRAILS-AND-MONORAILS.md), decided 2026-09-29). A switch that picks a GEM waits for its own proposal. It is not one of the socket phases below.
6. **The socket.** Phased plan under GEM socket, below. The standard is drafted. The socket, Neurendipity, and RUNED execution are in the tree. A RUNED GEM stays off unless the install names it. Activation beyond `EMET_ACTIVE_GEMS` is not.

## Done since the last revision (2026-09-28)

- SQL translator stage 2: read path native to MongoDB; the translator and the `event` mirror column removed (commit-017c7f3).
- Test-tree pass: one shared harness; dated suites named by subject (commit-7980e20).
- Open questions answered 2026-09-29: the lessons `shadow` block dropped, the lesson key checked at the door; a coverage number published as an input to review; the character document consolidated quarterly (first pass done, SOUL.md v7).
- Chain verification: one MongoDB connection path with a DNS fallback (6491586), then the chain walk moved into `emet_gaps` so no host needs the repo or a shell (commit-43a5ef6).
- Security audit, first pass: two findings fixed; nothing open (commit-c2aa70d).
- Least-privilege Atlas role, scripted and documented for new users (commit-26134e7).
- Provenance stamped from the transcript; semantic and procedural writes with no source refused (commit-4f6aba8).
- Guardrails & Monorails and lab results (commit-e7b4ebe through commit-20c39d3).
- Charter revised 2026-09-29 (the aleph, the monorail, the database boundary, the per-exchange transcript; commit-d98356e) and again 2026-09-30 (the admission test in commitment 6; procedural ref 404).

## Proposed features and functions

- **GEM socket (phased).** GEM means Golem Expertise Module. A RUNED directive (Registered Utility Node Executable Directive) is a declared, registered tool built into a GEM. The 2026-09-08 expansions (Guided Engagement Module, Registered Utility Node Extension) are superseded. The standard, schema, authoring guide, conformance checks, and GEP-0001 are in [`gem-library/`](../gem-library/README.md), which moves to EMET-GEMs after this revision is approved.
  - PR 2 (in the tree): `src/socket.js` and `gem-check` for a bundled prompt GEM (schema, spec revision, hashes, sizes, path safety, floor-negation lint, secret scan, no code), plus a conformance test. A refused GEM does not stop initialize.
  - PR 3 (in the tree): `gems/neurendipity`. `reading_people`, the neurodivergent lines, the wellbeing corpus lines, the matching reassertion lines, and the guide (the old id aliases for one release). Default off. Set `EMET_ACTIVE_GEMS=neurendipity` to turn it on. Core floor keeps persistence, general epistemic honesty, the epistemic corpus lines, and the honesty protections. `emet_floor` takes a `gem` argument. The available list shows Neurendipity installed and off unless that setting names it.
  - PR 4 (proposed): each GEM's byte cost in `emet_status` (`gems`: installed and active counts, active floor bytes, headroom, the enforced caps, and per-GEM id, version, kind, bytes and refusal reason; read-only, no floor text). Caps, priority, consent when `overrides` is non-empty, and the available list in the startup text are already enforced. `EMET_ACTIVE_GEMS` is how an install asks for a GEM.
  - PR 5 (in the tree): RUNED registration through dispatch, static analysis, and `gems/fieldnote`, bundled and off by default. No GEM from outside the release loads. GEP-0003 supersedes the GEP-0002 sandbox: the sandbox is removed, and the socket serves each RUNE and does not run it.
  - Later, each by its own GEP: the creator keyring and signature checks, the public submission repository and its CI gate, accepting a library GEM onto the load list, and a monorail switch that picks a GEM.
- **Claim-status grading.** Extend provenance so every recorded claim carries a status: established, deduced, proposed, still owed, or rejected — and rejected routes stay on the record with the reason they failed. (Idea taken from a physics research corpus that grades its own claims this way.)
- **Index-first retrieval.** Score candidates against a one-line-per-item index before opening anything, open only the best match, follow one link at most — finding is logic, not a model call. EMET already has the shape (handoff and board as router, document list as index); the work is keeping the startup router small.
- **Composite retrieval scoring.** Live as of this revision: recall ranks by how many query words match, then by importance. Current entries come first in every order, including time order. Time order is `order: 'latest'`, or a standalone latest, newest, or most recent together with other words. That phrase only reorders rows that already match. Nothing fades or is down-weighted for age. A superseded or expired entry stays in the result, marked with its end date and what replaced it. `history: true` reads the ended entries when current ones fill the limit. A recall or layer query ranks matching rows in the store (current before ended, then keyword hits and importance, or time when you asked for the latest) and then keeps a bounded window (at least 200 rows, or 20 times the page), not the whole layer. A blank sort value comes first when ascending and last when descending.
- **Export, import, restore-and-compare.** Not built; listed in the README's known gaps.
- **Organizational use.** Many private EMETs and a document gateway between them. Nothing built before a named customer.
- **Shared hive memory for AI bots.** Closed as a separate item on 2026-10-11. Folded into the GEM socket work above. A bot that shares one EMET still needs its own source tag and scope. That question stays with the socket.
- **Compiled topic pages, pilot (proposed 2026-09-30).** After the LLM-wiki pattern: a document prefix of topic pages compiled from semantic entries. Every claim cites its entry or transcript span; a compiled page never cites another compiled page as evidence; pages are derived, never the source of truth; one compiler role builds pages, others write entries only. No database change. The document store already versions, hashes, signs and checks form. Pilot page: the hive-memory idea. The hive-memory feature is closed as its own item (2026-10-11) and folded into the socket. If this pilot is built, it needs a different page. Nothing added beyond what the pilot needs.
- **Lint pass over the semantic layer (proposed 2026-09-30).** A scheduled sweep for contradictions between entries, outdated claims a newer entry supersedes, entries that should link and don't, and subjects mentioned often with no compiled page. Findings are reported, never applied automatically; corrections go through supersession. Built after the pilot page, and only once it names its measure. Design inputs from the LLM Wiki v2 review (typed links, multi-agent sync rules, drift invariants, confidence only on top of provenance) are each weighed against commitment 6 before adoption. Its idea of letting entries fade from what surfaces is not taken: nothing in EMET fades.
- **Advisory judge for team traffic (parked).** A fast external decision model (TypeSafe's Jev was evaluated) could sort traffic and interactions when many people and hosts share one EMET. Never in the write path — no model decides what EMET stores. Not for single-user installs.
- **Local open-weight model as a host.** A read-only trial of EMET under a locally run model, once the host machine's GPU and RAM are on record.
- **Stranger install.** A clean-machine install by someone who has never seen EMET, to find first-run friction.
- **Remove Dynamic Client Registration** by 2027-06-01, as MCP moves to client ID metadata documents.
- **Public landing page (parked)** until a public publish path exists.

## Design commitments these must keep

- No model in the write path: EMET stores what the assistant deliberately chose to write.
- Controls, not reminders — a rule that matters is checked by the server.
- Over-engineering is a defect, and the check comes before the build: nothing is built until it names the failure it fixes, what it replaces, how we will know it worked, and what holds it once it works (charter commitment 6). DMADV while EMET is in design; DMAIC once stable.
- Correct the record by superseding, never by editing.
