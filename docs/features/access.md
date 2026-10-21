# Access

The store has one owner. `emet_client_approve` approves or denies a client that was flagged on a first write. `emet_invite_create` mints a one-time guest code. `emet_member_access_create` mints a one-time member code. Both doors are off unless you turn them on. A code is shown once and is not stored in the clear.

## Sub-features

- access-approve: `emet_client_approve` takes a tag and a decision of `approve` or `deny`. Pending clients are listed by `emet_initialize` and `emet_status`.
- access-guest: `emet_invite_create` is EMET Guest Access, read-only. It stays off unless `EMET_INVITES=1`.
- access-member: `emet_member_access_create` is EMET Member Access, read and write, never the owner. It stays off unless `EMET_MEMBER_ACCESS=1`.

## How to get to it (user POV)

A new client is read-limited until you approve it. You see the pending tag in startup or status, then call `emet_client_approve`. For a second person, turn on the door you mean, then create the code and show it once. They paste it on the connect screen instead of the passphrase. Guest access is not member access.

## Driving it with verify-emet

```
npm run verify -- feature access
npm run verify -- run emet_client_approve emet_invite_create emet_member_access_create
```

On a plain install the two doors are off. The drive expects those two calls to refuse with `EMET-AUTH-030` and `EMET-AUTH-034`. That refusal is the tool working. The approve call denies a tag that exists only inside the temp database. `--dry-run` skips all three, because each one can change who has access.

## Gotchas

- Do not invent a guest or member answer during setup. The doors stay off until the matching variable is `1`.
- A client does not approve itself.
- The code is not in the result a second time. Show it when it is created.
