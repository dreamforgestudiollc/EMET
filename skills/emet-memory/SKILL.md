---
name: emet-memory
description: Use EMET as controlled, shared memory. Use at the start of a session, before answering anything that may depend on earlier work, and whenever a decision, fact or handoff should be kept for other agents or devices.
---

# EMET memory

EMET is an MCP memory server built for document control (ISO 9001 7.5.3 / ISO 13485 4.2.5): persistent, shared memory for AI agents and bot teams. It holds no certification and claims no conformity. Nothing is deleted; records are superseded, retired and retained. Every write is attributed to the client that made it. A GEM tool runs on the client: EMET verifies the record, not the computation. A GEM is seated only when its released flag is true.

## Start of session

1. Call `emet_status` once. On a new deployment, call it with `{"probe": true}` to prove the write path (it writes, reads back and removes a row from `_emet_verify` only).
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