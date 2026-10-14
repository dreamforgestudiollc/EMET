---
name: emet-memory
description: Use EMET as controlled, shared memory. Use at the start of a session, before answering anything that may depend on earlier work, and whenever a decision, fact or handoff should be kept for other agents or devices.
---

# EMET memory

EMET keeps records under document control (ISO 9001 / ISO 13485 style). Nothing is deleted:
records are superseded, retired and retained, and every write is attributed to the client that made it.

## Start of session

1. Call `emet_status` once. On a new deployment, call it with `{"probe": true}` to prove the write path.
2. If setup has not been completed, follow `emet_initialize`.
3. Read the standing rules with `emet_floor` and follow them.
4. Before writing, open a session with `emet_session_open`.

## While working

- Recall before you answer: `recall` (keyword), `semantic_recall` (meaning, Atlas only), `query_layer`.
- Save a durable fact or decision with `save_to_layer`. Correct one with `revise_memory`. Never try to delete.
- Controlled documents: `read_doc`, `write_doc`, `patch_doc`, `validate_doc`. Use the templates the server offers.
- Do not type another client's source tag. Attribution comes from the signed-in client.

## End of session

Close with `emet_session_close`, updating the board and the handoff as the server asks, so the next
agent or device starts where you stopped.
