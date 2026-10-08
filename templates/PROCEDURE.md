# TEMPLATE — PROCEDURE

**Template control:** id `templates/PROCEDURE.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-11 · a decision record · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `procedures/<name>.md` — reference procedures and work instructions: how to do one specific thing on one specific system (Tier 3). **Every `procedures/*` document is validated against this template by its id** (`templates/STANDARD.md` §9 map); leaving out the control block does not exempt it (§9a L4). Work instructions that exist outside the store come in when they are next rewritten, not before.
**Failure it prevents:** recorded paths and commands that went stale unverified and failed silently when followed — an interpreter path that no longer existed carried in two bootstrap documents for months; a deploy command naming the project instead of the service (reference install, August–September 2026).
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **Every path, command and version carries the date it was last seen working, and on which machine.** An entry with no verification date is a nonconformance.
2. **A step that has failed is corrected by revision, with the failure recorded in §5** — never edited out silently.
3. **Machine-specific steps say which machine.** A procedure that is true on one machine and not another states both, or states which one it was checked on.

---

## §0 RECORD CONTROL
- Template: `templates/PROCEDURE.md` rev __ · Procedure revision: the store's version governs
- Applies to: system / machine · Last verified end to end: __ (date, machine, session id)

## §1 PURPOSE
What this procedure does and when to use it, one or two lines.

## §2 PRECONDITIONS
What must be true before starting, each with how to check it.

## §3 STEPS
| # | Step | Exact command or action | Expected result | Last verified (date, machine) |
|---|---|---|---|---|

## §4 VERIFY
How to confirm the procedure worked — the check, not the claim.

## §5 KNOWN FAILURES
| Date | What failed | Cause, or "undetermined" | Correction |
|---|---|---|---|

Or *"None recorded."*
