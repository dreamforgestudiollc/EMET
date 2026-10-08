# TEMPLATE — SEED

**Template control:** id `templates/SEED.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-13 (record control stated once, as front matter — the user's instruction; prior approval 2026-09-11 · a decision record) · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `seeds/<name>.md` — an idea that is valid but wrongly timed, parked with the condition that brings it back.
**Failure it prevents:** a met trigger that sat unsurfaced for weeks because nothing at startup could tell it had fired (reference install, 2026-09-10); triggers that name an event nobody scheduled, so they could never fire (three seeds waiting on a "post-certification review" that was never put on a calendar, same date); a seed that had already been executed still sitting as a seed, read at every startup as live (reference install, supersession work, August 2026).
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

⚠ **CHANGED 2026-09-13 — record control is the YAML front matter, and it is stated in exactly one place.** This template previously carried a `## §0 RECORD CONTROL` heading *and* told the author to put that same record control in YAML front matter. Front matter cannot sit underneath a markdown heading and still be front matter, so no seed could ever satisfy both — and because the conformance checker reads a template's required sections from its own `## §N` headings, it demanded a `## §0` heading that every correctly-written seed necessarily lacked. Every seed in the store was marked nonconforming for obeying the template. The requirement has moved to rule 4 below, where it is stated once and is satisfiable. **Nothing was relaxed: the front matter is still required, and a seed without it is still wrong.** The remaining half of this fix belongs in the product — see the note at the foot of this template.

---

## HOW TO FILL — rules specific to this template

1. **Every trigger is testable without asking the user.** It is one of four kinds, and nothing else:
   - `DATE` — a calendar date. Fires on or after it.
   - `ROW` — a board row id and the change that fires it (`B-001 opens`, `B-002 closes`). The board row must exist when the seed is planted; if it does not, open one.
   - `SIGNAL` — something a startup can observe by name: a named document reaching a named state, a named external item closing. **Name where it is checked.**
   - `TOPIC` — the user raises a named subject. **Checked during the session, not at startup:** list the subject words in the trigger so any session that has scanned the seed recognises them when they come up. *Prevents:* outlawing a trigger that works — the reference install's first-run-experience seed fired correctly this way on 2026-09-11.
   A trigger that names an event with no date and no board row ("after the review", "when there is time") is a nonconformance: plant it as `ROW` against a row that schedules the event, or as `DATE`.
2. **A seed changes status, it does not linger.** `DORMANT` → `MET` (date, and whether it was surfaced to the user) → either `ACTED ON` with a disposition, or `SHELVED`. An acted-on seed is retired (`retire_doc`), never left in the working view. Its content is retained.
   - **`SHELVED`** — the trigger was met and the user paused it. Record the user's words, the date, and **resumes when:** the trigger that brings it back. Not raised as work, and named in the startup list's parked section with its resume trigger, like a parked board row (charter §3 commitment 8, 2026-09-23). When the resume trigger is met it returns to `MET`. **The status log keeps the earlier `MET` row, so a shelved seed always shows it has fired before** — returning it to `DORMANT` would erase that (the user, 2026-09-11: *"it will mark it as MET but waiting which returning to DORMANT has no indication that it was previously MET"*). *Prevents:* a seed the user paused mid-work being indistinguishable from one that never fired.
3. **The user's words are carried verbatim and dated, or the section says the seed is assistant-authored.** An assistant-authored idea is not a decision until the user says so.
4. **RECORD CONTROL IS THE YAML FRONT MATTER, AT THE TOP OF THE FILE, BEFORE ANY HEADING.** It is required, and it is where a startup reads the trigger without parsing the body. It carries nothing that is also stated in the body.
```
---
template: templates/SEED.md rev __
trigger:
  - kind: DATE | ROW | SIGNAL | TOPIC
    test: __            # the date · the row id and the change · the observable, and where it is checked · the subject words
status: DORMANT | MET | SHELVED | ACTED ON
resumes_when: __        # SHELVED only — the trigger that brings it back
planted: __             # local date
planted_by: __          # source tag
session: __             # session id
---
```
⚠ **Put the trigger in the front matter itself, never in a fenced ```yaml block inside the body.** A fenced block is body text; a startup scan cannot read it. Four seeds in the reference install do this and are invisible to an automated scan.

---

## §1 THE IDEA
What it is, in two or three sentences, and **why now is the wrong time** — the reason it is a seed and not a board row.

## §2 WHOSE IDEA
The user's words, verbatim, with the date — or *"Assistant-authored; not decided by the user."*

## §3 WHEN IT FIRES — WHAT TO DO FIRST
The first concrete action when a trigger is met, so the session that finds it does not have to re-derive it. One or two lines.

## §4 OPEN QUESTIONS
Questions for the user, not answered by the assistant — or *"None."*

## §5 STATUS LOG
| Date | Status | Evidence (board row, document revision, record id, user's words) |
|---|---|---|
| __ | DORMANT — planted | this revision |

**Disposition when ACTED ON is one of:** `MOVED TO BOARD <row id>` · `EXECUTED` (evidence required) · `DROPPED BY USER` (their words and date). Then retire the seed.

## §6 RELATED
Board rows, threads, records — or *"None."*

---

**PRODUCT NOTE, not a rule for authors.** The conformance checker derives a template's required sections from that template's own `## §N` headings. That is correct for every other template and wrong for this one, because this template's record control is front matter by design. Removing the heading fixes it from the template side with no code change and no loss of the requirement. The complete fix is in the checker: for a template whose record control is declared as front matter, read the front matter as the record-control section rather than looking for a heading. Built 2026-09-26: `checkSeedFrontMatter` in `src/conformance.js` checks trigger kind (DATE, ROW, SIGNAL, TOPIC), status, test, planted fields, and `resumes_when` on SHELVED. A seed can now fail for a bad trigger, not only for a missing heading.
