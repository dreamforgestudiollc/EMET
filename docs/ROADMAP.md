# EMET — Next Steps and Proposed Features

Status as of 2026-11-11. This is a working roadmap, not a commitment. Nothing here is built unless it says so. Items move only when the owner rules on them. Each unbuilt item still has to answer the four questions in charter commitment 6 before any code is written.

EMET stays **one shared server** with verified per-client attribution. One collaborative project is one instance: one database, one deploy, one owner connect secret. There is no fork to keep in sync, and core memory work is not a GEM. Live chat stays out of EMET. The focus is document control (ISO 9001 7.5.3 / ISO 13485 4.2.5). EMET holds no certification and claims no conformity.

## Where things stand

- **Live:** the public site and the npm package `@dreamforgestudiollc/emet` are published. Version 0.3.6 is this repository. 38 tools (15 read-only); `EMET_SUBKEYS=1` adds four sub-key tools. Topic pages shipped in 0.3.0: `emet_page`, `emet_pages`, and `emet_page_lint`. Layer writes and reads are native to MongoDB. Server-side checks run on session start and close. Receipts are required at close. The handoff is a record, superseded and never amended.
- **The extension socket is built.** It is `src/socket.js`. Its note is [gem/README.md](gem/README.md). The standard in this repository is Draft, in [`gem-library/`](../gem-library/README.md). Neurendipity and the other bundled GEMs stay off unless the install names them. A RUNED GEM stays off unless the install names it. The socket serves each RUNE and does not run it. Client-side execution shipped with the socket. A public repository for outside GEM submissions does not exist yet. Its name is not chosen.
- **The aleph** verifies every write by reading it back before any receipt, and every later read by its digests, signature, and place in its layer's hash chain. `emet_gaps` walks the whole chain for any host.
- **Guardrails and monorails** ([GUARDRAILS-AND-MONORAILS.md](GUARDRAILS-AND-MONORAILS.md)): the server checks the order of a session's writes. Enforce only since 0.2.1: every skipped step is refused with the way to pass, and every check is stored as a timestamped lab result. There is no report mode and no off switch.
- **The database** login runs under the least-privilege role `emetRecordKeeper`: it can insert and update, and it cannot remove the record.
- **Startup load:** `emet_initialize` is served in pages of at most 18,000 bytes as received, so a host that cuts long results short still reads all of it. `page: "all"` returns it whole on a host with no size limit.
- **Attribution that already ships:** source tags, an owner door (`/owner/chooser`, `/owner/break-glass`), and member and guest access codes bound to source tags. See [SECURITY-AT-SCALE.md](SECURITY-AT-SCALE.md).
- **Composite retrieval scoring is live.** Recall ranks by how many query words match, then by importance. Current entries come first in every order, including time order. Nothing fades or is down-weighted for age.
- **Public landing page and npm package (live).** The site in `site/` is published to GitHub Pages, and `@dreamforgestudiollc/emet` is on npm. The 0.3.5 package on npm was published before the wording cleanup in 0.3.6.

`emet_page_lint` shipped in 0.3.0 and flags a topic page. It does not edit.

## Upcoming work

Nothing in this section is a commitment to a date or a design freeze. A status label means:

- **Proposed** — design conversation only. Not approved to build. No prototype.
- **Planned** — the direction is decided, and the public release does not contain it yet.
- **Later phase** — accepted as future work on this same server, and not scheduled as the next change.

### Collaboration workplace

- **Workshop Village MCP (Proposed, not built).** A Workshop Village MCP server for bot-team collaboration: a shared workplace where a user's bot teams can be present in the same space, hand work off, and meet on a schedule. It may be built onto EMET, or as a separate MCP server that works with EMET. That choice is not decided. Either way, EMET stays one shared memory server with verified per-client attribution. Workshop Village does not fork EMET, does not replace EMET with a generic memory server, and does not turn core EMET memory work into a GEM. Live collaboration stays in the Village. Durable decisions, records, and "save to memory" writes stay in EMET. Scope, as currently proposed: bot teams, not a wake path for a lone chat instance on another host. The proposed workplace is a real spatial environment (a game-engine core, engine not chosen), rooms where every bot present can hear the speaker, doors and a doorbell when there is no avatar presence, Available / Do Not Disturb, spaces that scale to the people and bots in them, and scheduled meetings. If a complete physics environment is needed later, the engine should be able to support it; it is not assumed to be always on. Bots should experience workplace time. If the Village is ever sold, engine licensing must be compatible with that. A robust open-source engine is preferred when it meets the bar. No engine brand is selected. No prototype, public URL, or connector is approved.
- **Drawers (Proposed, not built).** Shared project drawers: places to save project files and documents so bot teams can share them, hand them off, and submit them, because users will not have access to each other's workstation files, and may not have a company network drive. A drawer is a shared handoff and submission store, not a personal disk. Optionally, an organization may designate its shared network drive as the storage backend, to reduce database usage. Access control per drawer, and attribution with credential-backed source tags consistent with EMET's per-client attribution, are open design questions and are not decided. Not approved to build.
- **Shared hive memory, closed as its own item.** An earlier idea of a separate shared hive memory for bots is closed. It is not part of the GEM socket. Bot-team collaboration of that kind is the Workshop Village item above, still Proposed. A bot that shares one EMET still needs its own source tag and scope.

### Attribution, handoffs, and who can write

- **Per-source-tag handoffs (Planned, not in this public release).** A later public release may add per-AI handoffs keyed to credential-backed source tags. Each writing AI writes only its own handoff (`HANDOFF/<tag>`). The hub keeps the shared `HANDOFF.md` and resolves conflicts. A shared view is computed on read, not stored as a second record. Read-only AIs would use the shared view. Today the public server keeps one shared `HANDOFF.md` and, for bots, `bots/<tag>/HANDOFF.md`. A private build has the later handoff shape behind a flag. That flag is not part of public 0.3.6, and this release does not ship the tools, documents, or settings for it.
- **Fuller multi-person support on one server (Later phase, not built).** EMET already supports one shared instance with per-client attribution, an owner door, and member and guest access codes bound to source tags. Richer multi-person use of that same server, beyond those doors, is a later phase. The supported model remains one collaborative project, one instance. Many separate EMET instances, or a gateway between them, is a different idea and is not built. See [SECURITY-AT-SCALE.md](SECURITY-AT-SCALE.md).
- **Source-tag onboarding and further socket extensions (Planned).** Source tags, the owner door, and the bound-host door already ship. Stronger hardening of source-tag onboarding and client attribution is still to be done. The extension socket is built. Additional per-door extensions on that socket are Planned and are not built. A switch that picks a GEM is one of those later pieces. It is not built.

### Document control

- **Continuity-currency enforcement (Planned, not built).** `emet_initialize` does not yet refuse to run when `HANDOFF.md` or `STATE.md` is stale because a newer record exists. That gate is Planned. Session close can already cite a later continuity record through `carry_forward` (shipped in 0.3.3). That close path is not this initialize gate.
- **Topic pages with currency and lock levels (Planned).** Topic pages shipped in 0.3.0 as views computed on each request: `emet_page`, `emet_pages`, and `emet_page_lint`. A page is not a stored record. Area selectors can name a staleness window, and lint can flag a stale line. Wiki-style currency and lock levels for controlled documents are not built. Stored compiled pages are not built. If a compiled-page pilot is ever written, it needs its own page subject. It does not revive the closed hive-memory item.
- **Lint sweep of the semantic layer (Proposed).** The scheduled sweep for contradictions, outdated claims, missing links, and subjects with no page is still proposed. Findings would be reported, never applied automatically. Nothing in EMET fades.

### Operations

- **Backup, restore verification, and a clone-instance recipe (Planned).** The clone-instance recipe is already documented in [SECURITY-AT-SCALE.md](SECURITY-AT-SCALE.md): a new project is a new database, a new deploy, and a new passphrase. It does not add a tenant to an existing database. Bot-team backup, when the first-run interview records yes, is a written recipe the assistant follows. EMET does not copy prompts or settings itself. A backup and restore verification runbook, and export / import / restore-and-compare, are not built. They are listed in the README known gaps. An instance control plane that only provisions an isolated instance is not built. Charter commitment 6 is not answered for that tool.

### Records and reads

- **Transcript and history queries, and read-tool input validation (Planned).** `query_transcripts` already reads by time range or session id. `read_doc` already accepts an expected version and an expected digest. Further query improvements and stricter validation of read-tool inputs are Planned and are not a finished change in this release.
- **Claim-status grading (Proposed).** Extend provenance so every recorded claim carries a status: established, deduced, proposed, still owed, or rejected. Rejected routes stay on the record with the reason they failed.
- **Index-first retrieval (Proposed).** Score candidates against a one-line-per-item index before opening anything, open only the best match, and follow one link at most.

### Still proposed, and not built

- **Monorail switches.** Small logic at each junction where a session's flow must fork, tripped only by its condition. Designed, not built. No hosted model and no API. A switch that picks a GEM is the later GEM item below.
- **Organizational use.** Many private EMETs and a document gateway between them. Nothing built before a named customer.
- **Advisory judge for team traffic (parked).** A fast external decision model could sort traffic when many people and hosts share one EMET. It would never sit in the write path. Not for single-user installs.
- **Local open-weight model as a host.** A read-only trial under a locally run model, once the host machine's capacity is on record.
- **Stranger install.** A clean-machine install by someone who has never seen EMET, to find first-run friction.
- **Remove Dynamic Client Registration** by 2027-06-01, as MCP moves to client ID metadata documents.
- **Later GEM work, not built.** Creator keyring and signature checks, a public GEM submission repository, accepting a library GEM onto the load list, and a monorail switch that picks a GEM. Each waits on its own proposal. The socket itself is built and is not in this list.

### How to follow progress and give feedback

This file is the public list. It changes in the repository when an item moves. Discussion belongs in [GitHub issues](https://github.com/dreamforgestudiollc/EMET/issues). Open an issue before a pull request for anything beyond a typo. Say which roadmap item you mean, and do not send passphrases, tokens, connection strings, or memory content.

## Design commitments these must keep

- No model in the write path: EMET stores what the assistant deliberately chose to write.
- Controls, not reminders. A rule that matters is checked by the server.
- Over-engineering is a defect, and the check comes before the build: nothing is built until it names the failure it fixes, what it replaces, how we will know it worked, and what holds it once it works (charter commitment 6). DMADV while EMET is in design; DMAIC once stable.
- Correct the record by superseding, never by editing.
