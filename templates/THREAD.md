# TEMPLATE — THREAD

**Template control:** id `templates/THREAD.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-11 · a decision record · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `threads/<name>.md` — the working document for one project or line of work: its current position, its decisions and their reasons, and a dated log.
**Failure it prevents:** threads grown by appended sections until the current state sat under hundreds of kilobytes of history (reference install: two threads at 147 KB and 328 KB). A phone session did not read one — the mobile startup skips threads by rule — so the board marked its career rows `NOT COMPLETED` (2026-09-10); whether a phone session could read a thread that size was never tested. When it was read, its priority list still told the user to submit an application that had been submitted two weeks earlier — the current state was never rewritten, only appended to.
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **§1 is replaced, never appended.** Every update that changes the project's position rewrites §1 in full, with its as-of date. History goes to §4.
2. **The board holds status; the thread holds detail.** Open items live on the board as rows. The thread refers to them by id and holds what a row cannot: context, options, reasoning. An item that is open in the thread and absent from the board is a nonconformance — open the row.
3. **§1 through §3 must be readable on a phone.** When the whole document passes 64 KB — **a chosen limit on what a thread costs to load into context on any interface, not a measured one; revise it if it is ever measured** — the oldest §4 entries move to a log record `threads/<name>--log-<first date>-to-<last date>.md`, and §5 lists it. Nothing is deleted: the moved entries stay in the log record and in the document history.
4. **Decisions carry the user's words.** A recommendation the user has not accepted is not in §3.

---

## §0 RECORD CONTROL
- Template: `templates/THREAD.md` rev __ · Thread revision: the store's version governs
- Last updated: __ (local) · Session id: __ · Source tag: __
- **What this thread is for, one line:** __

## §1 CURRENT STATE — as of __
- **Phase:** __
- **What is true now:** three to eight lines. Each claim says how it was verified and when, or is marked unverified.
- **Board rows for this thread:** ids and their one-line next actions — or *"None open — checked against board v__."*
- **Waiting on:** who or what, and since when — or *"Nothing."*

## §2 KEY FACTS AND CONSTRAINTS
Standing facts a new reader needs before acting: people, systems, limits, fixed dates. Each points to its record (layer entry id, document) where one exists. Or *"None beyond §1."*

## §3 DECISIONS
| Date | Decision | User's words, verbatim | Recorded as |
|---|---|---|---|

Or *"No decisions recorded."* A decision reversed later stays in the table; its reversal is a new row naming the one it replaces.

## §4 LOG — newest last
Dated entries, append-only. Each opens with `### YYYY-MM-DD — <one-line summary> (session id)`. What happened, what changed on the board, what was learned. A correction is a new entry that names the one it corrects; earlier entries are not rewritten.

## §5 LOG RECORDS
Earlier log entries moved out under rule 3: document id · date range — or *"None."*
