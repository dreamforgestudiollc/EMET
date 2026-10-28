# TEMPLATE — SESSION DISPOSITION

**Template control:** id `templates/SESSIONDISPOSITION.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-10-28 · session-disposition brief · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `records/<name>.md` — one session, or a batch of sessions, noted under document control. **Every `records/*` document is validated against this template by its id** (`templates/STANDARD.md` §9 map). Leaving out the control block does not exempt it (§9a L4).
**Failure it prevents:** `emet_session_close` compares receipts with the store as it stands that day, so a close attempted days later blocks, and a third blocked close escalates. A fabricated receipt is not a close. Reference case, 2026-10-28: an early `save_transcript` for `2026-10-28_mb-main-chat-backfill-2026-10-26`, inserted_id `6ae1df09c4da08b2cadc1fb4`, eight exchanges, first assistant line opening `grok-bot-vm-453484571 Wed Oct 28 07:38:40 EDT 2026`. That row is a duplicate of `2026-10-28_mb-main-chat-backfill-2026-10-26_verbatim_part1`, written by `emet_transcript_append`, machine line `no local shell MCP`. The duplicate is marked SUPERSEDED and retained. It is not deleted, and it is not a close.
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **One record may list one session or many.** A batch is one record. Each row is one subject: a session, or one transcript row named by `inserted_id`.
2. **Disposition is one of** `CARRIED_FORWARD` · `ABANDONED_NO_TRANSCRIPT` · `SUPERSEDED_BY_LATER_SESSION` · `CLOSED_NORMAL` · `RETAINED_OPEN_CRITICAL`. **Reason** is at least 10 characters. **Evidence** names a record, a revision, an inserted id, or dated words. A blank is not evidence.
3. **A row does not close the session and does not write a receipt.** `emet_session_close` stays receipt-strict. `CLOSED_NORMAL` is rare. Use it only when a real close's receipts still match the store. The row is not those receipts.
4. **`inserted_id` set** means the row dispositions that transcript document. Use `SUPERSEDED_BY_LATER_SESSION`. The transcript stays in the store. Nothing is deleted. That row does not by itself resolve the session. A session-level row for the same `session_id` uses `inserted_id` `None — <what was checked>`.
5. **`CARRIED_FORWARD` and `SUPERSEDED_BY_LATER_SESSION` name `carried_forward_to`.** The others may say `None — <what was checked>`.
6. **`RETAINED_OPEN_CRITICAL` keeps the session open.** Use it when a formal close is still owed, or when the work stays on the ladder. Do not invent the close. Checkpoint overdue listing treats the session-level row as the disposition of record. The session row stays until a real `emet_session_close`.
7. **`ABANDONED_NO_TRANSCRIPT` is for no live transcript save.** Say that `last_saved_at` is null. Do not use it when a live save exists.
8. **A subject leaves the next revision of this record only through §3**, with evidence. The prior revision stays in `documents_history`. Nothing is deleted.
9. **Rows in §0 match the table.** A count that does not match the rows is a nonconformance.

### Example — superseded duplicate, and a backfill that still needs a real close

Late Oct 25 PM and Oct 27 after about 8:40 had no owner main-chat turns (hidden wakes only). The filtered 31-exchange append path is the complete substance backfill for Oct 25 through Oct 27. These open sessions still need a formal `emet_session_close`. Do not invent closes: `2026-10-28_mb-main-chat-backfill-2026-10-25_verbatim_part1` and `_verbatim_part2`, `2026-10-28_mb-main-chat-backfill-2026-10-26_verbatim_part1`, `2026-10-28_mb-main-chat-backfill-2026-10-27_verbatim_part1` and `_verbatim_part2`.

The early `save_transcript` stays SUPERSEDED. It is a duplicate of the Oct 26 verbatim append path. It is not deleted.

| session_id | opened_at | last_saved_at | disposition | reason | evidence | carried_forward_to | inserted_id |
|---|---|---|---|---|---|---|---|
| 2026-10-28_mb-main-chat-backfill-2026-10-26 | None — this row dispositions the early save_transcript, not the session open. | None — the live Oct 26 backfill is the verbatim part, not this inserted id. | SUPERSEDED_BY_LATER_SESSION | Early save_transcript is a SUPERSEDED duplicate of the verbatim_part1 append path. The transcript row is retained and is not deleted. | inserted_id 6ae1df09c4da08b2cadc1fb4 has 8 exchanges. The first assistant message opens with grok-bot-vm-453484571 Wed Oct 28 07:38:40 EDT 2026. The correct Oct 26 backfill is 2026-10-28_mb-main-chat-backfill-2026-10-26_verbatim_part1 via emet_transcript_append, machine line no local shell MCP. | 2026-10-28_mb-main-chat-backfill-2026-10-26_verbatim_part1 | 6ae1df09c4da08b2cadc1fb4 |
| 2026-10-28_mb-main-chat-backfill-2026-10-26_verbatim_part1 | None — not an overdue-inventory timestamp. This row records the open append path. | None — this row does not invent a save time. The append path holds the substance. | RETAINED_OPEN_CRITICAL | This open backfill still needs a formal emet_session_close. The filtered 31-exchange append path is the complete substance for Oct 25 through Oct 27. Do not invent a close or a receipt. | Coverage note 2026-10-28. Late Oct 25 PM and Oct 27 after about 8:40 had no owner main-chat turns (hidden wakes only). | None — formal close is still owed on this session. | None — this row dispositions the session, not one transcript document. |

---

## §0 RECORD CONTROL
- Template: `templates/SESSIONDISPOSITION.md` rev __ · Record revision: the store's version governs
- Session id: __ · Source tag: __ · Written (local): __
- Scope: __
- Rows: __

## §1 DISPOSITION
| session_id | opened_at | last_saved_at | disposition | reason | evidence | carried_forward_to | inserted_id |
|---|---|---|---|---|---|---|---|

Or: *None — no session in this record. Checked against: __.*

## §2 LIMITS
What this record does not do. It does not write an `emet_session_close` receipt, it does not mark a session closed, and it does not delete a transcript. A superseded `inserted_id` stays in the store.

Say what was checked, including a coverage note when the batch is a backfill. Or: *None — checked against: __.*

## §3 SUPERSESSION
- Supersedes: __ — or *None — first disposition record.*

| session_id | inserted_id | why it left | evidence |
|---|---|---|---|

A subject leaves §1 only by a row here. Name the later record that holds it. The prior revision stays in the archive.
Or: *None — no subject left this revision.*
