# TEMPLATE — HANDOFF

**Template control:** id `templates/HANDOFF.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-11 · a decision record · owner: EMET (base) · built to `templates/STANDARD.md` · decision record: the owner's
**Fills:** `HANDOFF.md` — the session narrative, written at every close. Replaced at each close; the prior revision is archived automatically.
**Failure it prevents:** a handoff's "nothing pending", true for one session, relayed at the next startup as true for the whole board (reference install, September 2026); a handoff written from memory rather than from the documents, carrying stale priorities (reference install, April 2026); a handoff whose first action was "open by asking the user", so the next startup put nothing in the user's sight (reference install, 2026-09-10).
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **This document holds what happened. The board holds where things stand.** Nothing that belongs on the board is restated here — refer to board rows by id.
2. **Write this last, in one write. The close order is `CHARTER.md` §6 and is stated only there.** When this is written the board, the session record and the transcript already exist, so §6 cites evidence rather than promising it. §2 is the difference between the board's previous revision and its new one. *Prevents:* a handoff that attests to saves not yet made and then needs a patch that inflates its revision (reference install, 2026-09-10).
3. **Every statement in §3–§5 is scoped to this session.** A claim about the whole board belongs on the board, not here.

---

## §0 RECORD CONTROL
- Template: `templates/HANDOFF.md` rev __ · Handoff revision: v__ · Supersedes: v__
- Session id: __ · Source tag: __ · Interface / machine: __ · Written (local): __
- Board revision written with this handoff: v__
- **Scope of this session, one line:** __

## §1 START HERE
- **Half-state rows on the board:** ids, or *"None — per board v__ §1."*
- **The next session's first action:** one concrete action — or *"Name the startup list (board §0), then ask the user."* **Never "open by asking" alone:** a handoff does not send the next session into a question with nothing in the user's sight.
- **Left undecided this session:** drafts, proposals or questions put to the user and not yet answered, one line each — or *"None."* The next session names these in its startup list.
- **Why this session stopped:** __ (finished · user ended it · interrupted · out of room)

## §2 BOARD CHANGES THIS SESSION
- Added: ids · or *"None."*
- Changed: id · what changed · or *"None."*
- Closed: ids (dispositions are on the board, §4) · or *"None."*

## §3 DONE THIS SESSION
| What | Evidence (commit, document revision, record id, receipt) |
|---|---|

Or: *"Nothing completed this session."*

## §4 DECISIONS THIS SESSION
| Decision | User's words, verbatim | Recorded as |
|---|---|---|

Or: *"No decisions this session."* Only decisions the user made. The assistant's recommendations are not decisions until the user says so.

## §5 ERRORS THIS SESSION
| Error | Caught by | Correction or guard |
|---|---|---|

Or: *"None identified this session."*

## §6 CLOSE VERIFICATION
| Artifact | Done | Evidence |
|---|---|---|
| Working documents for anything this session changed | Y / N / N-A (reason) | document + revision |
| Session record in memory | Y / N | record id + verified receipt |
| Board | Y | revision |
| Seed scan (board §5) | Y / NOT COMPLETED (reason) | date |
| Verbatim transcript | Y / N | session id + read-back count |
| This handoff | Y | this revision — written last, one write |

Rows are in close order (`CHARTER.md` §6).
