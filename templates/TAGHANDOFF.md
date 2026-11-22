# TEMPLATE — TAG HANDOFF

**Template control:** id `templates/TAGHANDOFF.md` · revision: the store's version governs · status: IN FORCE with the flag · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `HANDOFF/<tag>.md` — one write tag's own session narrative, written last at that tag's close. It is a record when `EMET_TAG_HANDOFFS` is `warn` or `enforce`: revision 1 is written plain, every later revision is written whole with `supersedes` and a reason, and `patch_doc` is refused. The hub's `HANDOFF.md` is not filled from this template.
**Failure it prevents:** several write tags sharing one handoff, so the next session opens on whichever tag closed last, and a board row changed by a tag that did not open it.
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

The flag is off by default. While it is off this template is not applied. The view that reads §1 is computed on read and is not a record.

---

## HOW TO FILL — rules specific to this template

1. **This is this tag's record.** It holds what this tag did. Another tag's handoff is not this file.
2. **Write this last,** after the working documents, the episodic record, any board patch of rows this tag opened, and the transcript.
3. **§1 is the only section the shared view reads, plus the close-verification line.** At most 10 lines. Each line names a board row id, the state as this tag sees it, and the next step.
4. **The view does not pick a winner.** If two tags disagree, both lines stay, under a conflict mark. Only the hub resolves a marked conflict, and the board write names the stamp.

---

## §0 RECORD CONTROL

- Template: `templates/TAGHANDOFF.md` rev __ · Handoff revision: v__ · Supersedes: v__ (or "none — first revision")
- Session id: __ · Source tag: __ · Person: the owner · Machine: __ · Written (local): __

## §1 OVERALL PICTURE

At most 10 rows. The view reads this table and the close-verification line.

| Row | State | Next step |
| --- | --- | --- |
| B-___ | __ | __ |

## §2 DONE THIS SESSION

| What | Evidence |
| --- | --- |

Or: *"Nothing completed this session."*

## §3 CLOSE VERIFICATION

Close verification: episodic __

The episodic id counts as a pointer only when that session is closed. An open session is an in-progress line on the view, not a pointer.
