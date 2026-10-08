# TEMPLATE — BOT ROSTER

**Template control:** id `templates/ROSTER.md` · revision: the store's version governs · status: DRAFT, not in force · approved: pending — the user asked for it 2026-10-01; IN FORCE only once the user approves this text and the decision record is filed · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `bots/ROSTER.md` — the one list of the bots that write to this install: each bot's source tag, name, role, host, machine, record, tool profile and owner, and the hub that is not a bot. It is a controlled document, revised under control (each revision archived), and kept by the hub. It is the user's register; the server's switch is `EMET_RECORD_DOCS`, and §3 records that the two agree.
**Failure it prevents:** a bot tag the server did not treat as a bot because its handoff id was never listed in `EMET_RECORD_DOCS`, found only when a live check's refusal came from the wrong rule (a live check of per-bot close records, 2026-10-01: a bot's test write refused by the records rule, not the bot rule); and the hub's own tag at risk of being listed with the bots, which would make the server refuse the hub's writes to the user's handoff and board (found on review of that check, 2026-10-01; `docs/DEPLOY.md`). Until this list existed, which tags were bots lived only in a deploy variable nobody could read back from inside a session.
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **One bot, one tag, one row.** The tag has the form `<prefix>-<bot name>`, lower case, letters, digits and hyphens, no `/` (`docs/BOTS.md` §2). A tag is never shared or reused; a retired bot's row stays, marked RETIRED.
2. **The hub is not a bot.** It is listed in §2 only. Its tag never appears in `EMET_RECORD_DOCS`, because a listed tag can no longer write the user's handoff and board.
3. **§3 is read back, not remembered.** It quotes the bot entries of `EMET_RECORD_DOCS` and `EMET_SOURCE_TAGS` as read from the deployment, with the date and deployment id. A row whose handoff id is missing there is not yet a bot, whatever this list says.
4. **Tool profiles are named, not enforced.** The server has no profile mechanism; the profile column records what the bot's host is configured to offer, and is marked provisional until the user adopts the profiles.
5. **Personal details stay in the store.** This template ships generic; an install's filled roster can name machines and people, so it is never copied into a public repository.

---

## §0 RECORD CONTROL
- Template: `templates/ROSTER.md` rev __ · Roster revision: the store's version governs
- Owner (the user): __ · Kept by (the hub): __ · Last updated: __ (local) · Session id: __ · Source tag: __
- **What changed in this revision, one line:** __

## §1 BOTS
| Tag | Name | Role | Host | Machine | Handoff doc | Tool profile | Owner | Status | Registered (SOURCE_TAGS · RECORD_DOCS) |
|---|---|---|---|---|---|---|---|---|---|
| __ | __ | __ | __ | __ | `bots/__/HANDOFF.md` | __ | __ | __ (ACTIVE · PILOT · PLANNED · RETIRED) | __ · __ |

## §2 HUB — host-level, never a bot
| Tag | Name | Host | Machine | Records it writes | Listed in RECORD_DOCS |
|---|---|---|---|---|---|
| __ | __ | __ | __ | `HANDOFF.md`, `STATE.md` | No — never |

## §3 CONFIGURATION READ-BACK
- Read (local): __ · Deployment: __ · Read by: __
- `EMET_RECORD_DOCS` bot entries: __
- `EMET_SOURCE_TAGS` bot and hub entries: __
- **Agreement:** every ACTIVE or PILOT row in §1 has its handoff id in `EMET_RECORD_DOCS` and its tag in `EMET_SOURCE_TAGS`; no hub tag is in `EMET_RECORD_DOCS` — __ (Y, or the rows that disagree)

## §4 CHANGE LOG
| Date (local) | Change (added · retired · role · profile) | User's words, verbatim | Decision record |
|---|---|---|---|
