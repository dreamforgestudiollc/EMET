# EMET 0.3.7

EMET is an MCP server for document control (ISO 9001 7.5.3 / ISO 13485 4.2.5): persistent shared memory for AI agents, bot teams, and chats. Version 0.3.7. EMET holds no certification and claims no conformity. The stored document shapes are not frozen. Pin a version if you depend on them. Stored rows are not rewritten. No new setting is required. This revision is not published from this file. See [CHANGELOG.md](CHANGELOG.md).

## What changed

Per-tag handoffs ship off unless the owner sets `EMET_TAG_HANDOFFS` to `warn` or `enforce`. Each write tag keeps `HANDOFF/<tag>.md`. The hub tag keeps `HANDOFF.md`. The shared view is computed on read and is not a record. A call that declares no tag is kept. A stale handoff does not refuse a call.

When that flag is on, material episodic rows written before `2026-09-27T00:00:00.000Z` with no registered source are listed as legacy pre-attribution. They do not make the overall check warn. A newer untagged row still warns.

Continuity currency (`EMET_CONTINUITY_CURRENCY`) compares the served handoff with the live material episodic tip on `emet_initialize` and `emet_session_open`. It defaults off. Set it to `1` to turn it on. A lag warns and does not block. The server does not rewrite HANDOFF or STATE. `EMET_CONTINUITY_CURRENCY_BLOCK` is reserved and is not applied.

A sub-key handle still lasts 12 hours. In the last hour, and for one hour after expiry, an open with the key and the current handle renews the session. After that, a sweep marks a stranded session `auto_closed`. Nothing is deleted. The row and the transcript stay. A chat key with no wrap-up is reported unwrapped on the next open. `emet_subkey_set_kind` stores `bot` or `chat`. A key with no kind stored is a bot. `emet_status` does not write.

The npm package includes `docs/features/`.

## Upgrade

No stored-data migration. No new required setting. Deploy over 0.3.6 as is. Listings gain `emet_subkey_set_kind`. ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording is unchanged.
