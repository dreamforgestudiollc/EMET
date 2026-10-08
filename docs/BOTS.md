# Running bots alongside your assistant

**Document control:** id `docs/BOTS.md` · tier 3, work instruction and reference (`templates/INDEX.md` hierarchy) · revision: the repository's history governs · status: DRAFT, for the user's review · owner: EMET (base) · forms it points to: `templates/ROSTER.md`, `templates/BOTHANDOFF.md` (both DRAFT) · rules it points to: `docs/DEPLOY.md` (bot records), `docs/GUARDRAILS-AND-MONORAILS.md` (bot sessions)
**Failure it prevents:** a bot set up by hand that the server did not treat as a bot, because its handoff id was never listed, found only when a live check's refusal came from the wrong rule (a live check of per-bot close records, 2026-10-01); and a bot close that could not finish because the bot never saved a session record with its session id, or saved one and never appended the exchange it was stamped with.

This is the reference for adding a bot — a separate agent with its own job, such as a reviewer, a tester or a scheduled intake run — to an EMET install that already serves you and your assistant. It states how a bot is registered and how a bot session runs. The rules themselves live in server code and in the documents named above; this page points to them and restates none of them as new rules.

---

## 1. What changes when you add a bot

- **Your records stay yours.** `HANDOFF.md` and `STATE.md` hold only the conversation between you and your hub (§3). A bot keeps its own handoff, `bots/<tag>/HANDOFF.md`, and never writes yours: the server refuses it (§5) — **but only for tags listed in `EMET_RECORD_DOCS`.** An unlisted or misspelled tag is treated as a host. When `EMET_SOURCE_TAGS` is set, the main records and everything under `bots/` refuse any tag not registered there, a missing source included; a registered tag that is not listed as a bot can still write the main records and any bot's folder (a known gap). A listed bot also cannot write another bot's folder or `bots/ROSTER.md`. With `EMET_SOURCE_TAGS` unset, these guards are off. Register a bot (§4) before its first write.
- **A bot closes against its own record.** Its close checks its own handoff and seven receipts, and counts only revisions written under its own tag (`src/session.js` `BOT_RECEIPT_FIELDS`; `docs/GUARDRAILS-AND-MONORAILS.md`).
- **Nothing about your own sessions changes.** Host sessions keep their eight receipts and their verdict.

## 2. Naming the tag

- One bot, one source tag, used on every write the bot makes: `source` on documents and transcripts, `metadata.source` on layer entries.
- Form: `<prefix>-<bot name>`, lower case, letters, digits and hyphens, for example `bot-reviewer` or `bot-tester`. A prefix that names the platform the bots run on lets a reader tell bots from hosts at a glance. **No `/`**: a tag containing one is never a bot tag (`src/session-graph.js` `isBotTag`).
- A tag is never shared between bots and never reused after a bot is retired. The record has to be able to say who wrote what.

## 3. The hub is not a bot

If one agent talks to you on behalf of the others — relays their reports up and your decisions down — it is the **hub**. The hub writes your `HANDOFF.md` and `STATE.md` under host rules. **Its tag is registered as a host and is never listed in `EMET_RECORD_DOCS`**: a listed tag can no longer write the main records (`docs/DEPLOY.md`). The roster records the hub in its own section for exactly this reason. **The hub's tag must be in `EMET_SOURCE_TAGS`:** with a registry set, an unregistered tag is refused the main records and any write under `bots/`.

## 4. Registering a bot

Do these in order. Each step names what to read back. Steps 2 and 3 are **one change**: set `EMET_SOURCE_TAGS` and `EMET_RECORD_DOCS` together, in one deployment. A tag registered as a source but not yet listed as a bot is treated as a host in between.

1. **Roster row.** Add the bot to `bots/ROSTER.md`, filled from `templates/ROSTER.md`: tag, name, role, host, machine, handoff doc, tool profile, owner, status. The hub keeps the roster. Read back: `read_doc bots/ROSTER.md`.
2. **Register the tag as a source.** Append the tag to `EMET_SOURCE_TAGS` (comma list) on the deployment. Without it, the bot's transcript appends are refused (`src/dispatch.js` `requireRegisteredSource`). The operator reads the variable back from the deployment (a bot cannot read deployment settings from a session).
3. **Make the tag a bot tag.** Append `bots/<tag>/HANDOFF.md` to `EMET_RECORD_DOCS` (comma list). This one id is the only switch: nothing else — not the tag's prefix, not `EMET_SOURCE_TAGS`, not the roster — tells the server a tag is a bot (`src/session-graph.js` `isBotTag`; `docs/DEPLOY.md`).
   - **Setting the variable replaces its value.** Keep every entry already there and append.
   - The id must match exactly: the tag's exact case, no leading `./`. A typo silently leaves the tag on host rules.
   - If your install still uses the legacy `CASCADE_RECORD_DOCS`, edit that one, or move its entries into `EMET_RECORD_DOCS`: once the `EMET_` name is set, the `CASCADE_` one is ignored.
   - The ids are a deploy setting rather than code defaults on purpose: they name your bots, which differ per install, and removing one id puts that tag back on host rules without a release.
   - Changing a variable redeploys the service. Note the new deployment id.
4. **Fill §3 of the roster** with the bot entries of both variables as read back, the date and the deployment id.
5. **Verify with one refused write — only once `HANDOFF.md` exists** (`list_docs HANDOFF.md` shows a version). On a new install with no handoff yet, skip this step until there is one: if the tag is not configured — the very case this step catches — the write would *create* the user's handoff. Then, under the bot's tag, `write_doc HANDOFF.md` with no `supersedes`. Expected reply: "HANDOFF.md is a main record and `<tag>` is a bot tag ... Nothing was written." If the reply says instead that HANDOFF.md "is a record and vN is in force", the tag is not a bot tag yet: check the id in step 3. If it says `<tag>` "is not a registered source tag", the tag is unregistered (step 2) and not yet a bot tag (step 3).

**Templates.** A bot's handoff is filled from `templates/BOTHANDOFF.md`. Do not map bot handoffs to `templates/HANDOFF.md`: that template asks for a board a bot does not keep, so every bot close would be marked nonconforming. While `templates/BOTHANDOFF.md` is DRAFT it is not mapped; once it is IN FORCE, map each bot with `bots/<tag>/HANDOFF.md=templates/BOTHANDOFF.md` in `EMET_TEMPLATE_MAP` (additive; append to any existing entries). Conformance marks a record and never rejects a write.

## 5. What a bot may never write

Under a tag listed in `EMET_RECORD_DOCS` (a bot tag), `write_doc`, `patch_doc`, `retire_doc`, `rename_doc` (from or onto) and `accept_nonconformance` refuse the main handoff and board, in every session-graph mode, and nothing is written (`src/tools.js` `refuseBotMainRecord`). A close whose session revised either is `incomplete`, and a receipt that names either is `blocked`. Anything the user must see goes to the hub, which carries it into the user's records.

A bot tag is also refused any write under `bots/` outside `bots/<tag>/`: other bots' records and `bots/ROSTER.md` are the hub's. When `EMET_SOURCE_TAGS` is set, the main handoff and board, and anything under `bots/`, refuse any source not registered there, a missing source included (a listed bot keeps writing and patching its own `bots/<tag>/` either way). Since startup stage 1, `retire_doc` and `rename_doc` are refused to a bot tag for every document, its own `bots/<tag>/` folder included (retiring and renaming are the owner's and the hub's), and `emet_setup_complete` is refused to a bot tag. Before either guard, the same five tools refuse a look-alike doc id: a leading `/`, a `.` or `..` segment, or `bots/` in the wrong case (`Bots/`); also a control or invisible formatting character anywhere (zero-width space, BOM, direction overrides), leading or trailing whitespace on the id or any segment, a backslash, the same `/`, `.`/`..` and `bots/` shapes after Unicode NFKC folding (full-width dots and slashes, `‥`, full-width letters; the first segment must be the ASCII `bots`), and a case or Unicode variant of a main-record id (`handoff.md`, ` HANDOFF.md`). Doc ids are flat strings, never resolved as paths or URL-decoded; there is no confusables table. One exception, for cleaning up ids written before these checks: `retire_doc`, and `rename_doc` from such an id onto a clean one, are let through for a tag listed in `EMET_SOURCE_TAGS` that is not a bot tag (never for a bot, an unlisted or missing tag, or with no registry set).

**These refusals cover listed tags only.** An unlisted or misspelled tag is treated as a host by the bot refusals. With `EMET_SOURCE_TAGS` set, the registry guard still refuses it the main records and `bots/`; a registered tag that is not listed as a bot is a host for both guards and can still write the main records (the handoff, given the version in force) and any bot's folder (a known gap). **With `EMET_SOURCE_TAGS` unset, neither guard applies; both are opt-in:** any caller can write the main records and every bot folder. Keep the roster's §3 read-back current and register every bot before it writes.

## 6. The bot session loop

One session per run, opened and closed by the bot itself.

1. `emet_initialize {}` and fetch every page it names (each page gives the exact call for the next); `{"page": "all"}` only on a host known to read long results whole, since the server counts a whole serve as fetched even if the host's connector cut it short. Keep `startup_page.load_id`. A read: nothing is written.
2. `emet_session_open` — a slug that names the bot and the job, and `load_id` from step 1. Keep the returned `session_id` and the start time (`session_start`). An open without `load_id`, before every page is fetched, or more than 60 minutes after the startup's last page (or after a server restart) is refused, and the refusal says what to call instead; nothing is written.
3. `emet_transcript_append` — exchange 1, `source: <tag>`.
4. `save_to_layer` — the session record on the episodic layer, with **`session_id`** and **`metadata.source: <tag>`**. The server stamps `derived_from` with the exchange *in progress*: the highest stored exchange plus one (`src/tools.js`, the A5 provenance stamp). Read it back.
5. `emet_transcript_append` — exchange 2, the one the save was stamped with. **Do not skip this:** without it the close reports that a layer entry cites an exchange that was never saved, and the close is `incomplete`.
6. `write_doc bots/<tag>/HANDOFF.md` — filled from `templates/BOTHANDOFF.md`, `source: <tag>`, written last. Revision 1 is written plain. **Every later revision is supersede-only:** pass `supersedes` set to the revision in force; `patch_doc` is refused on it, because it is a record.
7. `emet_session_close` — with `session_id`, `session_start` and the seven receipts: `working_docs` (`[]` if none), `episodic_id`, `transcript_session_id`, `transcript_parts`, `transcript_exchanges` (the highest exchange — 2 in the loop above), `handoff_doc` (`bots/<tag>/HANDOFF.md`), `handoff_version`. Expect `state: "complete"`, `closed_recorded: true`, and `checked.session_records` with `kind: "bot"` and the tag.

A bot with more exchanges appends after every reply as usual; the rule that matters is that the last append comes after the last layer save and before the handoff.

**Name every write attempt.** The user's approval of a bot's writes names each write call it covers, one per line: the tool, the document id or layer, and what it writes (for the loop above: `emet_session_open` with its `load_id`; `emet_transcript_append` exchange 1; `save_to_layer` episodic; `emet_transcript_append` exchange 2; `write_doc bots/<tag>/HANDOFF.md`; `emet_session_close`), including any deliberate negative test. The hub relays that list verbatim in the bot's brief, and the bot's report lists every write it attempted, from the raw replies. The second reader checks each attempted write against the approved list: a write not on it, a retry, or a write after the close is a finding. Reads (`emet_initialize` included) and dry runs (`validate_doc`) need no listing. This is what lets the second reader confirm that nothing was written beyond what the user approved.

## 7. Corrections

Nothing is edited in place and nothing is deleted.

- **The bot's handoff:** the next revision corrects it, with `supersedes`, and names the correction in its §4.
- **Episodic entries** are events and are never revised: a correction is a later entry that says what it corrects.
- **Semantic and procedural entries:** `revise_memory` writes a new entry that supersedes the old one; both stay readable.
- **Transcripts:** `revise_transcript` writes a corrected part that points at the one it replaces.
- **The roster:** a new revision with a §4 change-log row; a retired bot's row stays, marked RETIRED, and its handoff id is removed from `EMET_RECORD_DOCS` only when it will never write again.

## 8. Tool profiles

The server has no tool-profile mechanism: every connection sees every tool, and the refusals in §5 key on the tag, not on what a host offers. A roster's profile column records how the bot's host is configured. Profile names proposed for adoption are provisional until the user adopts them.
