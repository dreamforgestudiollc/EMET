# EMET-0001: Delegated client sub-keys (EMET core proposal)

**Status:** Accepted 2026-10-15 by Alex (revision 2, after the reviewer's review of PR 48)
**Date:** 2026-10-15
**Approver:** Alex
**Sponsor:** the hub (a sponsor does not approve)
**Scope:** EMET core attribution (server), not a GEM. This is the first EMET core proposal. Core proposals live in `docs/proposals/` as `EMET-NNNN`.
**Related:** board 126 (per-client attribution), NC issue #49, PR 47 (`EMET_STRICT_LOGIN_TAG`)

Accepted 2026-10-15 by Alex. The tests in §10 are the review gate for the implementation.

## 1. Problem

One EMET server has one owner login. Several AI clients (Grok Bots, the client) reach it over one shared OAuth connection: one `client_id`, one grant, and one bound login tag, `hub-bot`. Under attribution v2 (the default), a caller on that connection may declare a different `source`. That tag is self-asserted, because any client on the connection can name any tag the install accepts.

What board 126 observed on 2026-10-15:
- the client's test write (session `2026-10-15_attribution-check-2026-10-15`) was stamped `hub-bot`.
- the intake bot's attempt to write as `intake-bot` was refused, because the session it wrote into belonged to `hub-bot` (the A1 session tie).

Neither client could get a stamp of its own that the server verifies.

A connector per client was rejected as drift. The fix must live inside EMET: **one server, one owner login, any number of AI clients, and each one writing under a tag the server verifies against an approved credential.**

## 2. Proposal in one paragraph

The owner login issues **sub-keys**. A sub-key is a random secret bound to exactly one source tag and admitted through `emet_client_approve`. A client presents its sub-key at `emet_session_open` and gets back an unguessable **session handle**. Every write in that session must present the handle. The server stamps each such write with the key's tag, whatever `source` the caller sends. Keys and handles are stored only as peppered HMACs, claimed or issued once, and revocable or rotatable. Only one live session per key is allowed. Every issue, claim, use, rotation and revocation is a retained record.

## 3. Who may use sub-keys, and over what transport

- **Owner-person logins only.** Only a login whose person is the owner may request, claim or present sub-keys. Invite (guest) and Member Access logins, which belong to other persons, may not. The D3 cross-person refusal (`source "x" is bound to another person's login`) still applies unchanged.
- **HTTP only.** Sub-keys apply only to authenticated HTTP calls, the path `preflight` already handles. Stdio is a single local host. It keeps the current registry rules (`EMET_SOURCE_TAGS`, `requireRegisteredSource`) and ignores sub-keys. Every sub-key call (request, claim, open, and every write with a handle) needs the owner's HTTP login, so revoking the owner login ends every sub-key.

## 4. Issuing and claiming a sub-key

1. **Request.** A client calls a new tool, `emet_subkey_request { tag }`. The tag must be an exact member of `EMET_SOURCE_TAGS`. An empty `EMET_SOURCE_TAGS` refuses every request. The server creates a pending entry in the subkeys collection (not `emet/CLIENT_APPROVALS.md`) with `kind: "subkey"`, a `key_id`, the requesting `client_id` and grant, and the time. The decision still goes through `emet_client_approve`. The response, and only the response, carries a one-time **claim nonce**: 32 random bytes, prefix `emn_`. The server stores only `HMAC(pepper, nonce)` and the pepper version that sealed it. The nonce never appears in the approvals record, `emet_status` or logs.
2. **Approve.** The owner, or the COS bot named by `EMET_COS_TAG`, decides with the existing `emet_client_approve { tag, decision }`. The current code (`clientApprove`, `src/attribution.js`) refuses when the requester and the approver share a **`client_id` or a grant**. That means a different session on the same shared connection is refused too: the approval has to come from **another OAuth client**, such as the owner's own host (a desktop or CLI login). On today's shared login the COS bot is on the same connection as the bots (`actorIsCos` checks the login tag against `EMET_COS_TAG`). So in practice **the owner's own host or the owner page approves** until the COS has a separate client. The owner page is `GET /owner/approvals`, mounted only when `EMET_SUBKEYS=1`. It checks the existing owner passphrase (`EMET_OAUTH_PASSPHRASE`); a wrong passphrase shares the per-address lockout of `POST /oauth/approve`. A correct passphrase opens a session that lasts 15 minutes. Approve and Deny post that session's CSRF token and the pending `key_id`. A `key_id` that is not that pending row is refused. The owner page returns 400 on an empty `key_id`. Through `emet_client_approve`, a `key_id` that does not match the named tag is refused, and a call with only a tag still decides that tag's pending row. No current caller passes both a `key_id` and a tag, so that mismatch cannot be triggered. The history event is the owner's, with `via: owner_page`. An optional reason is stored on that event when one is given.
3. **Claim.** The requesting client calls `emet_subkey_claim { key_id, nonce }`. The server finds the entry by `key_id`, compares `HMAC(pepper, nonce)` with the stored value in constant time (`crypto.timingSafeEqual`), and only then generates the key. A claim with only the `key_id`, a wrong nonce, or a second claim is refused. The nonce is spent on the first success. An unclaimed approval expires after 24 hours.
4. **Key format and storage.** The key is `emk_<key_id>_<secret>`, where `secret` is 32 random bytes in base64url. The server stores `HMAC-SHA256(pepper, secret)` together with `pepper_version`, plus the tag, the owner subject, `created_at`, `expires_at` (default 30 days, at most 90), `last_used` and status. `pepper` is a server secret (`EMET_SUBKEY_PEPPER`, at least 32 bytes, kept in Railway variables and never in the database). `EMET_SUBKEY_PEPPER_VERSION` names the current pepper (default 1). During rotation, `EMET_SUBKEY_PEPPER_PREV` and `EMET_SUBKEY_PEPPER_PREV_VERSION` stay accepted, so a seal made with the previous pepper still verifies. New seals use the current version. If the pepper is missing, every sub-key tool fails closed. Lookup is by `key_id`, which is indexed, followed by a constant-time compare of the HMAC. Plaintext keys are returned once and are never stored, logged or echoed. `src/redact.js` masks `emk_`, `emh_` and `emn_` tokens. A bare `key_id` stays visible.
5. **One active key per tag.** Issuing a new key for a tag that already has one is a rotation (§7).
6. **No escalation.** A sub-key never grants more than the owner login it hangs off, narrowed to writes under one tag. A sub-key session cannot call `emet_client_approve`, `emet_subkey_request`, `emet_subkey_claim`, `emet_subkey_revoke`, `emet_subkey_end_session`, `emet_invite_create`, `emet_member_access_create`, `emet_setup_complete`, or any settings tool.

## 5. Presenting a sub-key: session plus handle

- **Open.** The client calls `emet_session_open { session_id, subkey: "emk_..." }`. The server looks up the key by `key_id` and compares in constant time. It checks status and expiry, enforces one live session per key (§6), and binds the session to the key's tag with `basis: "subkey"`. It returns a **session handle**: 32 random bytes, prefix `emh_`, stored only as `HMAC(pepper, handle)` beside the session binding. That return is the delivery. The handle is never echoed again in receipts, logs, or `session_graph`.
- **Every write** in that session must carry `session_handle`. The server compares it in constant time with the stored value for that `session_id`. A write that names a sub-key session's id **without** its handle, or with a wrong one, is refused, and nothing is written. Session ids are guessable (`<date>_<slug>`), and the handle is what makes the binding per-client on a shared connection.
- **The stamp** is the key's tag. If the caller's `source` differs, the write is refused. With no `source`, the key's tag is used.
- **No per-call sub-key.** The long-lived key goes over the wire once per session. The handle is per session and short-lived. That limits where the key can leak.
- **Lifetime.** A handle dies when the session closes, after 12 hours, or when its key is revoked, whichever comes first.
- **Without a handle:** writes on the shared connection that are not in a sub-key session follow today's rules (login tag, or a v2 declared tag). With strict mode on (§8), they are stamped with the login's tag only.

## 6. Concurrent use

Only **one live session per key**, whatever the client or grant. A second `emet_session_open` with a key that already has a live session is refused and flagged on the key in the sub-keys collection with the time and the presenting `client_id`. The holder can close its session, or the owner can revoke it, to free the key. The owner can also call `emet_subkey_end_session { tag | key_id }` to end the live session without burning the key: the old handle stops working and the same key can open again. That is the recovery for the single-session lockout. This is detectable on a shared connection, because the check is on the key, not on the client: if a co-tenant steals a key while the real client's session is live, one of them gets refused and the flag shows the collision. It cannot tell who is legitimate. A new open is stored as `opening` and becomes `live` only if the key still points at that open. A write is refused unless its session is the one the key points at. An `opening` session, or a pointer with no session row, blocks another open for 5 seconds and is stale at 5 seconds. The next open then ends it, records `session_lost`, and clears the pointer. If the real client has no live session, a thief can open one undetected until the real client next tries and is refused (§8).

## 7. Revocation, rotation and expiry

- **Revoke:** `emet_subkey_revoke { tag | key_id, reason }`. The owner can always revoke. The COS can revoke only from a different OAuth client than the key's sessions, which on a shared login is usually impossible, so in practice **the owner's host revokes**. Revocation takes effect on the next call. The live handle is invalidated, its next write is refused with "sub-key revoked; open a new session with a current key", and earlier writes stay as written and attributed. If misuse is suspected, they are flagged for review.
- **Rotate:** a new key goes through the same request, approve and claim cycle (§4). The old key stays valid for a grace window (default 10 minutes, can be set to 0) and is then revoked. Rotation is required at expiry. It is recommended after any suspected exposure or concurrent-use flag.
- **Expiry:** expired keys are refused at `emet_session_open`. `emet_initialize` and `emet_status` show expiry 7 days ahead.

## 8. Fit with `EMET_STRICT_LOGIN_TAG`

- **Strict off (today's prod):** sub-key sessions are verified as above. Other writes keep attribution v2 behaviour. `emet_gaps` `ambiguous_attribution` today covers only defaulted, missing or unregistered tags (`src/gaps.js`). A v2 declared tag that **is** registered is not flagged. The implementation therefore adds a new gap, **`declared_attribution`**: writes whose basis is `declared`, grouped by tag and session. That makes the remaining self-asserted writes countable.
- **Strict on:** a declared tag that differs from the login's tag is refused unless the call carries a valid handle for a sub-key session bound to that tag. The recommended end state is strict on, with every client on a sub-key.
- `STRICT_TAG_TOOLS` and `WRITE_TOOLS` keep their meaning. The sub-key and handle check runs in `preflight` before the strict check, in one place.

## 9. Threat model, and what this can and cannot guarantee

**Assets:** the integrity of the "who wrote this" stamp on every record, and the owner's control over who may write.

| Threat | Mitigation | Residual |
|---|---|---|
| A client declares another client's tag (today's gap) | The server stamps from the handle's session key, not from `source`. A mismatch is refused (strict) or counted as `declared_attribution` (non-strict). | Strict off: still possible, counted in `declared_attribution`. Strict on: none for clients without that tag's key and handle. |
| A co-tenant writes into another client's session by naming its `session_id` | Every write in a sub-key session must present the session handle (hash-stored, constant-time compare). | None without the handle. A handle leaked by its holder is a key-theft case below, limited to 12 hours. |
| A co-tenant races the claim using a visible `key_id` | The claim needs the one-time nonce, which is returned only to the requester and stored hashed. | A co-tenant that reads the requester's memory or files at that moment. |
| A client approves its own key | Approval must come from another OAuth client (a different `client_id` and grant). On today's shared login that means the owner's own host. | A compromised owner host. Every approval is recorded. |
| A key leaks into a log or transcript | Keys go over the wire once per session, are stored as peppered HMACs and are never echoed. The implementation **adds an `emk_` rule to `src/redact.js`**; there is none today. | A client that writes its own key into a document's body before redaction. Rotate. |
| **A bot steals another bot's sub-key on a shared host** | One live session per key (refuse and flag a second), short expiry, rotation, revocation, `last_used`. | **Not prevented.** See below. |
| Brute-forcing a key, nonce or handle | 256-bit secrets. Failed presentations are throttled per `key_id`, per `client_id`, and per session. The secret is checked first: a correct handle or nonce is accepted and clears those buckets. The existing `src/approve-throttle.js` covers only the passphrase form at `POST /oauth/approve`, not tool calls. | Negligible. |
| Database read exposure | Sub-key records live in their own collection, not in `emet/CLIENT_APPROVALS.md`. Reads and history are returned only to the owner and the COS. Only HMACs with a pepper held outside the database are stored. | A combined leak of the database and the pepper. Rotate the pepper; all keys must then be reissued. |
| An approval replaces the live key for a tag the owner already approved | The key list shows `replaces_existing_key` and names the key it replaces, on the pending row and on the approve result. | The owner approves a rotation without reading that line. The old key's grace window still applies. |
| `EMET_SUBKEYS` is turned off while a session is live | At startup the server ends every live or opening sub-key session once (state ended, reason `flag_off`). The history event is written before that status change. The sweep tries once and retries a few times in the background, and does not block startup. Ordinary writes do not open the sub-key store. A write that presents an `emh_` handle is refused. A write that names a sub-key session is refused only when that session was live or opening at this process's sweep, and that refusal lasts until the next restart. The tool list stays the flag-off list. If the collection does not exist, it is not created. | Until the sweep has seen a session, a write that only names its `session_id` is an ordinary write. An `emh_` handle is refused either way. |
| A close names another bot's session | `emet_session_close` releases a sub-key session only when the caller presents that session's key and handle. The session id is `receipts.transcript_session_id` when the receipt carries it. A different `session_id` releases neither session. | A caller who holds both secrets. That is the key-theft case above. |

**The honest statement.** EMET can guarantee that a record stamped through a sub-key session carries the tag of a key the owner approved, presented by whoever held that key and its session handle. It cannot guarantee that the process holding them is the client the tag names. When several bots run on one machine with one shared filesystem, environment and connector, a bot that can read another bot's key can open a session as that bot whenever the real bot has no live session. One-live-session detection catches that only when the two collide. Sub-keys change the gap from "any client can claim any tag on any call" into "a client must hold another client's secret". They make impersonation detectable after the fact in some cases (collision flags, `last_used`) and time-limited (expiry, rotation, revocation). Real isolation between bots on one host needs the host to keep each bot's key where the other bots cannot read it, for example a per-bot secret store. That is outside EMET, and this proposal does not claim it. Until a host provides it, attribution on that host is **verified against approved keys, not proven against co-tenant theft**. NC #49 stays open with that wording until it is addressed.

## 10. Required tests (the review gate)

1. A write in a session bound by key `A` (tag `a`) with `source: "b"` is refused. Nothing is written, and the stamp stays `a`.
2. A write with no `source` and a valid handle is stamped with the key's tag. `read_doc_history` shows the tag and the `key_id`, never the key or the handle.
3. **A write that names a sub-key session's `session_id` without its handle, or with a wrong handle, is refused.**
4. **A claim with only the `key_id` (no nonce), or with a wrong nonce, is refused.** A second claim with the right nonce is refused.
5. Approval of a sub-key from the same `client_id` or grant as the request is refused. Approval from another OAuth client succeeds.
6. **A second `emet_session_open` on a key with a live session is refused and flagged, even from the same `client_id` and grant.**
7. A revoked or expired key is refused at session open. A live handle's next write after revocation is refused, and earlier writes are unchanged.
8. On rotation, the old key works only inside the grace window.
9. Key lookup uses `key_id` and a constant-time compare. A missing `EMET_SUBKEY_PEPPER` makes every sub-key tool fail closed.
10. **`src/redact.js` redacts `emk_` keys, handles and nonces** in logs, errors, `emet_status` and transcripts.
11. The failed-present throttle engages after N failures per `key_id`, per `client_id`, and per session. A correct handle or nonce is accepted and clears those buckets. Only a failed presentation is counted.
12. With strict on, a declared tag passes only with a valid handle for that tag. With strict off, existing v2 tests are unchanged, and `declared_attribution` counts registered declared-tag writes.
13. A sub-key session cannot call owner-only tools. Invite and Member Access logins cannot request, claim or present sub-keys. Stdio ignores sub-keys.
14. `emet_status` lists keys (tag, `key_id`, dates, `last_used`, collision flags) only to the owner and the COS, as `approvalsView` does. Everyone else sees nothing.

The implementation also tests a stalled open that cannot write once the pointer has moved, an opening that blocks inside 5 seconds and is stale at 5 seconds, and a `key_id` that is not the pending row.

## 11. Records (document control)

A key's status and last_used change in place. Each change is kept as a history event. Those events are retained and are not replaced. A later open of the same session id adds a session record; it does not replace the earlier one. A store that ran the first build of this feature, which kept sub-key rows inside `emet/CLIENT_APPROVALS.md`, still has those rows in that document's history. The current document does not. Production did not run that build. A change is a compare-and-set on the document's revision. A unique index allows only one pending key per tag. Nothing in the sub-key store is deleted. `read_doc` on `emet/CLIENT_APPROVALS.md` does not return these records. Reads and history are limited to the owner and the COS. `read_doc_history` on a written document shows the stamped tag and, for sub-key sessions, the `key_id`. A transcript row written in that session carries `key_id` as well. The key list in `emet_status` is restricted as in test 14. A pending key that replaces an existing key for the same tag says so on that list.

## 12. Alignment

- **ISO doc control:** this supports ISO 9001:2015 clause 7.5.3 and ISO 13485:2016 clause 4.2.5 (identification of who changed a record, retention of records, nothing deleted), as EMET's README and Charter word it. It claims no certification. The organization validates EMET for its own use.
- **Charter and floor:** no change to either. Sub-keys add a verified stamp. They do not loosen any existing refusal, and every new refusal fails closed.
- **Per-client attribution:** sub-keys make per-client attribution on a shared connection **verified against approved keys, not proven against co-tenant theft** (§9), where today it is self-asserted. The registry, approvals, the session tie and `read_doc_history` all stay as they are.
- **Not a generic memory server feature:** sub-keys exist to attribute controlled records, not to add multi-tenant accounts. One owner, one store.

## 13. Rollout

1. Alex accepts this proposal.
2. Implementation PR covering the tools, handle binding, pepper, redact rule, throttle, `declared_attribution` gap and the tests in §10. the reviewer reviews against §10. A new flag, `EMET_SUBKEYS=1`, keeps sub-keys off by default.
3. Alex sets `EMET_SUBKEY_PEPPER` in Railway, then deploy with the usual verified backup, health check and sandbox check.
4. Turn on `EMET_SUBKEYS=1`. Each client requests a key, Alex approves from his own host, and each client claims its key with its nonce. Re-run board 126 and check with `read_doc_history`.
5. When every client is on a sub-key, turn on `EMET_STRICT_LOGIN_TAG=1`. Close NC #49 only if the residual in §9 is accepted in writing or a host secret store removes it.

## 14. Owner decisions (Alex, 2026-10-15)

- Keys expire after 30 days. The owner can reissue.
- Approve and revoke stay on the owner's own login. No separate OAuth client is added for the chief-of-staff bot. The existing rule stands: the approver must be a different `client_id` and grant from the requester, which on today's shared login is the owner's own host.
- Each bot holds its key as a local secret. The key is never stored in EMET content.
- 2026-10-15, public package: sub-keys ship with EMET. First-use setup asks whether more than one bot or AI will use the memory. The answer is optional and defaults to no. Yes writes the flag and a generated pepper only when `.env` is the config source, and the running process is not flipped. A hosted deploy refuses yes: the owner sets `EMET_SUBKEYS=1`, an owner-generated `EMET_SUBKEY_PEPPER`, and `EMET_SUBKEY_PEPPER_VERSION=1`, then redeploys. The tools, the owner page and the store are the ones already shipped.
