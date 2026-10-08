# TEMPLATE — BOARD

**Template control:** id `templates/BOARD.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-11 · a decision record · owner: EMET (base) · built to `templates/STANDARD.md` · decision record: the owner's
**Fills:** `STATE.md` — the structured open board. **Replaced in full at every session close; never appended.** The prior revision is archived automatically.
**Failure it prevents:** a position document that grew by appended addenda until superseded lines sat above current ones; open items that left the record with no one deciding they should (the reference install lost two job-application actions this way in September 2026); a startup that restated this board's counts instead of naming its items, and a dated section migrated rather than rebuilt that missed three calendar items on its first live revision (reference install, 2026-09-10).
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **Every row has a stable id** (`B-001`, `B-002` …) assigned once and never reused. Ids are how the next revision, the handoff, and the validator refer to a row - and nothing else: **the id is the LAST column of every table and is never used to name an item to the user.** An item is named in plain words; the id is the handle the record keeps. *Prevents:* a startup list delivered as codes that mean nothing to the person reading it (reference install, 2026-09-15: *"it just looks like a bunch of progressing numbers with a letter prefix"*). The validator finds the id column by its header, so its position is the template's choice.
2. **Rows change status, not membership.** An open row is copied into the next revision unchanged unless something about it changed.
3. **A row leaves the open sections only through §4 CLOSED THIS REVISION**, with a disposition and evidence. It appears there once; the following revision may drop it, because the archived revision holds it.
4. **The counts in §0 are derived from the rows.** A count that does not match the rows is a nonconformance.
5. **A dated row whose date has passed without a recorded outcome moves to §3 as `OPEN`, next action "confirm outcome with the user." It is never closed as `DONE` without evidence.** *Prevents:* a passed date closed on an assumed outcome — the reassuring confabulation (reference install: support-structure confabulation; live instance 2026-09-11, an episode publish date resting on a shoot no one had recorded).

---

## §0 RECORD CONTROL AND COUNTS
- Template: `templates/BOARD.md` rev __ · Board revision: v__ · Supersedes: v__
- Session id: __ · Source tag: __ · Written (local): __
- Scope of the session that wrote this revision: __

| Half-state | Dated ≤14 days | Open | Waiting | Parked | Closed this revision | Seed triggers met | Nonconformance markers open |
|---|---|---|---|---|---|---|---|
| __ | __ | __ | __ | __ | __ | __ | __ |

**At startup the receiving session NAMES the items first** — in the place `CHARTER.md` §6 sets for them (after EMET's line and the user's identity phrase; the charter holds the full order) — every §1 row, every §2 row within seven days, every §3 `OPEN` row the user owns with its next action, and the handoff's *left undecided* lines; **then, under its own heading, every §3 `PARKED` row, one line each with its *resumes when* — named, never pressed** (charter §3 commitment 8, changed 2026-09-23: parked rows were excluded until then, and for a neurodivergent user excluded is forgotten) — **then restates these counts as the check. A count never replaces the names:** for a user with time blindness or object impermanence, an item not named at startup does not exist (charter §3, commitment 8).

## §1 HALF-STATE — highest priority
Anything left partly changed that becomes riskier if the next session does not know about it: a configuration edited but untested, a change shipped but unverified, a restart pending, a file partly written.

| What | State it was left in | Next action | Contingency — if X, do Y; do not do Z | How to undo | Id |
|---|---|---|---|---|---|

Or: *"None — checked against: __."*

## §2 DATED — next 14 days, and hard dates beyond
| Date | Item | Owner | Id |
|---|---|---|---|

Hard dates beyond 14 days: __ · Or: *"None — checked against: __."*

**Rebuilt at every close from the user's calendar and any active schedule — never copied forward from the prior revision.** Name the sources checked: *"Checked against: calendar __ to __ · schedule __."* A source that could not be read is written `NOT CHECKED — <reason>`.

## §3 OPEN BOARD
| Item | Owner (user / assistant / external) | Status | Next action | Opened | Last changed | Id |
|---|---|---|---|---|---|---|

**Status is one of:** `OPEN` · `WAITING` (on someone external — name them) · `PARKED` (user's decision — not raised as work and nothing asked of it, but named in the startup list's parked section; record the date, the user's words, and **resumes when:** the condition that brings it back, or "user raises it").

## §4 CLOSED THIS REVISION
| Item | Disposition | Evidence | Id |
|---|---|---|---|

**Disposition is one of:** `DONE` · `DROPPED BY USER` · `MOVED TO SEED <id>` · `SUPERSEDED BY <row id>`. **Evidence** is a record id, document revision, or the user's words with the date.
Or: *"None closed this revision."*

## §5 SEEDS
- Last full scan: __ (date, interface) · or `NOT SCANNED THIS CLOSE — <reason>`
- Triggers met: seed · trigger · surfaced to the user (Y/N) — or *"None met, per the scan above."*
- Dated triggers within 14 days: seed · date — or *"None."*

## §6 STANDING GUARDS
| Guard | Source (decision or entry) | Added |
|---|---|---|

Retired this revision: guard · reason — or *"None retired."*

## §7 SYSTEM STATE
Versions, deployments, record counts, and anything a successor must know to trust the environment. Each line with how it was verified and when.
