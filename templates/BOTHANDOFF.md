# TEMPLATE — BOT HANDOFF

**Template control:** id `templates/BOTHANDOFF.md` · revision: the store's version governs · status: DRAFT, not in force · approved: pending — the user asked for it 2026-10-01; IN FORCE only once the user approves this text and the decision record is filed · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `bots/<source tag>/HANDOFF.md` — one bot's own session narrative, written last at each of that bot's closes. Listed in `EMET_RECORD_DOCS`, so it is a record: revision 1 is written plain, every later revision is written whole with `supersedes` set to the revision in force. The hub's `HANDOFF.md` is never filled from this template, and a bot never writes `HANDOFF.md` or `STATE.md` (the server refuses it, `docs/BOTS.md` §5).
**Failure it prevents:** a bot that can reach a complete close only by writing a new revision of the user's own `HANDOFF.md` and revising the user's board, so the user's next session opens on the bot's narrative (found 2026-10-01); scheduled bot runs citing sessions that were never opened, leaving permanent holes in the record (`emet_gaps` pointer disagreements, incident records); and a bot handoff checked against the hub's template, which demands a board the bot does not keep, so every bot close would add a nonconformance marker to the backlog (found on review of a live check, 2026-10-01).
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **This is the bot's record, not the user's.** It holds what this bot did in this session. Anything the user must see or decide goes to the hub (§3), and the hub carries it into the user's own records. Nothing here restates the user's board.
2. **Write this last, in one write, after the final transcript append.** The session loop is `docs/BOTS.md` §6: read the startup (`emet_initialize {}` and every page it names; `{"page": "all"}` only on a host known to read long results whole), open with its `load_id`, append, save the session record with `session_id`, append again, then this handoff, then `emet_session_close`. §5 cites evidence that already exists.
3. **Every statement is scoped to this session and this bot.** A claim about the whole system belongs to the hub, not here.
4. **Corrections supersede.** A wrong statement in an earlier revision is corrected by the next revision (and named in §4), never by rewriting the earlier one.

---

## §0 RECORD CONTROL
- Template: `templates/BOTHANDOFF.md` rev __ · Handoff revision: v__ · Supersedes: v__ (or "none — first revision")
- Session id: __ · Source tag: __ · Bot: __ (roster row in `bots/ROSTER.md`)
- Host / interface: __ · Machine: __ · Written (local): __
- **Scope of this session, one line:** __

## §1 START HERE
- **The bot's next first action:** one concrete action — or *"Wait for the hub's next brief."*
- **Left open for the hub:** questions, drafts or findings sent up and not yet answered, one line each — or *"None — checked against this session's messages to the hub."*
- **Why this session stopped:** __ (finished · hub ended it · interrupted · out of room)

## §2 DONE THIS SESSION
| What | Evidence (commit, document revision, record id, receipt) |
|---|---|

Or: *"Nothing completed this session."*

## §3 HANDED TO THE HUB
| Item (finding, question, draft, verdict) | Sent (local time) | Hub's reply or decision relayed, with the user's words where given |
|---|---|---|

Or: *"Nothing handed up this session."* The bot records the user's decisions only as relayed by the hub. The bot's own recommendations are not decisions.

## §4 ERRORS AND CORRECTIONS THIS SESSION
| Error (including any statement in an earlier revision this one corrects) | Caught by | Correction or guard |
|---|---|---|

Or: *"None identified this session."*

## §5 CLOSE VERIFICATION
| Artifact | Done | Evidence |
|---|---|---|
| Working documents this session changed | Y / N-A (reason) | document + revision, or `working_docs: []` |
| Session record in memory, written with `session_id` | Y / N | episodic id + verified receipt |
| Verbatim transcript, including the append after the save | Y / N | session id + parts + highest exchange |
| Main records untouched | Y / N (what changed, and the error row in §4) | `HANDOFF.md` and `STATE.md` revisions, before and after |
| This handoff | Y | this revision — written last, one write, `supersedes` named after revision 1 |

Rows are in close order (`docs/BOTS.md` §6).
