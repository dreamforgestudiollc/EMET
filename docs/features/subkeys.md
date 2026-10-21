# Client sub-keys

Delegated keys for more than one client. Off unless `EMET_SUBKEYS=1`. With the flag off, the host's tool list does not include `emet_subkey_request`, `emet_subkey_claim`, `emet_subkey_revoke`, or `emet_subkey_end_session`.

## Sub-features

- subkey-request: `emet_subkey_request` asks for a key for one registered source tag. Only an authenticated owner login may call it. The result carries a one-time claim nonce.
- subkey-claim: `emet_subkey_claim` turns an approved nonce into a key shown once.
- subkey-revoke: `emet_subkey_revoke` retires a key's authority. The record stays. Later writes with that session handle are refused.
- subkey-end: `emet_subkey_end_session` ends a stuck live session and leaves the key usable.

## How to get to it (user POV)

Leave this off for a single client. When you want it, say yes in the interview only if this server reads `.env`. Otherwise set `EMET_SUBKEYS=1`, a pepper you generate, and `EMET_SUBKEY_PEPPER_VERSION=1`, then start the server again. From the owner login, request a key, approve it, and let the client claim it once. The client keeps the key as a local secret. It is never written into EMET content.

## Driving it with verify-emet

```
npm run verify -- feature subkeys
npm run verify -- run emet_subkey_request emet_subkey_claim emet_subkey_revoke emet_subkey_end_session
```

All four are standalone gaps, so this run exits 3. A temp directory has no flag, no pepper, and no authenticated owner login, so the tools are not registered. The command reports that. It does not turn the flag on to hide the gap. A failed tool still exits 1.

## Gotchas

- A server that is not reading `.env` will not write the pepper into that file. You set the three variables and start the server again.
- The claim nonce and the key are shown once.
- With the flag off, a write that presents a session handle is refused.
