# TEMPLATE — STAGING

**Template control:** id `templates/STAGING.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-11 · a decision record · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `staging/<name>-<yyyy-mm>.md` — work lists, proposals, pricings, research notes: anything that is worked on before it is decided.
**Failure it prevents:** an instance-authored proposal read later as a decision — a delete tool was specified from a staging note nobody had approved, and the note contradicted itself (reference install, a decision record); drafts with no visible status, so a reader could not tell a priced option from an adopted one.
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **The status line is the first thing a reader sees, and it says who decided.** A staging document is never a decision. When the user decides, the decision is recorded where decisions live (a layer entry, the board, the thread) and this document's status line points to it.
2. **Every claim says where it came from:** read from code or a document (name it and its revision), measured (how), or inferred (marked as inference).
3. **When the work is finished or abandoned, or an `IN USE` document is no longer used, the document is retired** with a one-line reason — never left in the working view as if current.
4. **Every `staging/*` document is validated against this template by its id** (`templates/STANDARD.md` §9 map) — leaving out the control block does not exempt it (§9a L4). *Prevents:* a staging document escaping validation by omission (found at review, 2026-09-11).

---

## §0 RECORD CONTROL
- **Status:** one of `DRAFT` · `PRICED, NOT APPROVED` · `PROPOSED TO THE USER <date>` · `DECIDED — see <record>` · `IN USE — <what uses it>` (a schedule or work list the user works from — not a proposal, not a decision) · `ABANDONED — <reason>`
- **Authored by:** user / assistant (from what) · Session id: __ · Source tag: __ · Written (local): __
- **Board row:** __ — or *"None — this is not tracked work."*

## §1 QUESTION
What this document exists to answer, in one or two sentences.

## §2 WHAT WAS FOUND
The substance. Sources named per rule 2.

## §3 OPTIONS OR PROPOSAL
Options in ascending order of cost and invasiveness, each with what it prevents and what it costs — or the single proposal and its price. Or *"None — findings only."*

## §4 WHAT IS THE USER'S TO DECIDE
One line each — or *"Nothing; this is reference."*

## §5 LIMITS
What this does not establish, and what could make it wrong.
