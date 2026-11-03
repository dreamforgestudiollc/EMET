# Run one EMET instance per project

One collaborative project uses one EMET instance. An instance is one MongoDB database, one running server, and one `EMET_OAUTH_PASSPHRASE`. EMET is not multi-tenant on one database.

The document store has no prefix. One database holds one identity. A second `EMET_COLLECTION_PREFIX` in the same database does not make a second memory. When the configured prefix sees no memories and the same database holds data under another prefix, `emet_initialize` returns `state: "misconfigured"` and refuses the setup interview. That refusal is what stops a second identity from being written beside the first.

Guest access and member access are doors into this one store. They stay off until you set `EMET_INVITES=1` or `EMET_MEMBER_ACCESS=1`. They are not a second project.

ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording is unchanged. EMET holds no certification and claims no conformity. Nothing is deleted. Records are superseded, retired, and retained. The standing text is `CHARTER.md` §7 and `templates/STANDARD.md`.

Run one process per instance. The record of which startup pages a host fetched lives in that process for 60 minutes after the last page. A second replica does not have it, so `emet_session_open` refuses a `load_id` whose pages were fetched elsewhere. See [GUARDRAILS-AND-MONORAILS.md](GUARDRAILS-AND-MONORAILS.md).

EMET is still 0.x. Stored document shapes may change before 1.0. Pin a version if you depend on them.

## Harden one project

Do this before a second host or bot writes.

1. Set `EMET_SOURCE_TAGS` to every host tag and every bot tag this project will use. With the list unset, an unregistered tag is accepted, and the guards on the main records and on `bots/` are off.
2. Set a unique strong `EMET_OAUTH_PASSPHRASE` for this instance. Do not reuse it on another instance. While it is unset, the HTTP server refuses every authorization.
3. Leave guest access, member access, and sub-keys off until you need them. Leave `EMET_INVITES`, `EMET_MEMBER_ACCESS`, and `EMET_SUBKEYS` unset.
4. Optional. Set `EMET_SIGNING_KEY` to 32 random bytes, generated on this host. Keep it only on this host. Do not commit it. Do not store it in MongoDB or in a document. Unset means rows are saved unsigned. A new instance gets its own key. A different key makes an old signature read as not matching. Leave the key stable on a live store.
5. Set `PUBLIC_URL` to the deployed https origin, with no path. It is the OAuth issuer. It must match the live URL exactly. Redeploy after you set it.
6. After any environment change, request `https://<host>/health`. The JSON includes `"ok":true`. Then call `emet_status` with `{"probe": true}`. A read alone does not prove the write path.

Leave `EMET_SOURCE_TAG` unset when several hosts share this server. A default tag makes every host look the same. Over HTTP, document, transcript, and memory writes use the tag bound at approval. A local stdio host still passes an exact tag from `EMET_SOURCE_TAGS` as `source`.

## Clone a project instance

A new project is a new instance. Do not point it at the first project's database.

1. Create a new MongoDB database. Set a new `MONGODB_DB`. Give that database the same least-privilege role as [SETUP.md](SETUP.md). Do not copy the first database into this one when you want an empty project. Copying the database copies its identity, its transcripts, and its grants.
2. Deploy a new service. Use a new `EMET_OAUTH_PASSPHRASE`, a new `PUBLIC_URL`, and a new `EMET_SIGNING_KEY` if you sign. If you turn sub-keys on, generate a new `EMET_SUBKEY_PEPPER`. Do not copy secrets from the other instance.
3. Set `EMET_SOURCE_TAGS` to the hosts of this project only.
4. Request `/health`, then call `emet_status` with `probe: true`.
5. Say initialize. The interview runs on this empty store. `emet_setup_complete` writes this store's identity. It does not read another instance.

GEMs stay on the instance that names them.

- `EMET_ACTIVE_GEMS` is the comma-separated list of GEM ids for this process. It is not shared with another instance. Set it on the new service only when this project wants those GEMs. Restart, then read `emet_status` and confirm `gems`.
- Bundled GEMs ship with `defaultOn` false. An unset `EMET_ACTIVE_GEMS` leaves them off.
- At the interview, yes is the recommended answer for bot-team backup. Yes records that choice in this store's `bootstrap/USER.md`. The assistant then follows `gems/bot-team-backup/guides/BOT_TEAM_BACKUP.md`. EMET does not copy prompts or settings. Secret values are never stored. No, or leaving the question out, leaves the practice off. The GEM id `bot-team-backup` stays out of `EMET_ACTIVE_GEMS` unless you also want its floor text seated. Seating it does not replace the interview answer.
- Neurendipity and Lean Six Sigma are opt-in. Set `EMET_ACTIVE_GEMS` to `neurendipity`, to `lean-six-sigma`, or to both separated by a comma, only on the instance that should use them.
- Fieldnote is a developer case-study. Leave it off.
- Do not weaken the floor. No GEM can remove a protected floor line. Do not edit the floor to match a project. Read a GEM's floor with `emet_floor` and `gem` set to that id. That read does not turn the GEM on.

## Keep an inventory and offboard

Keep an inventory outside the stores. One line per instance is enough. Record the project name, the public URL, the database name, whether guest access, member access, or sub-keys are on, and which GEM ids are active.

Do not put passphrases, connection strings, peppers, or signing keys in the inventory. Do not write those values into any EMET document.

To stop new owner sign-ins that use the old passphrase, set a new `EMET_OAUTH_PASSPHRASE` and redeploy. The passphrase is checked when a device consents and on the owner pages. Tokens already issued keep working until you revoke them. Changing the variable does not, by itself, end those tokens.

To end every grant and every sub-key, open `/owner/break-glass` in your own browser. Sign in with the owner passphrase. Confirm with the exact text `rotate-all`. There is no MCP tool for this, and there is no grace window. Access tokens, refresh tokens, authorization codes, sub-keys, live session handles, and unused invites are superseded, retired, and retained. Rows are not deleted. Devices sign in again with the current passphrase.

To end one member or one bot and leave the rest working, open `/owner/break-glass/revoke-member`. Name that one tag. Confirm with the exact text `revoke-member`. This does not rotate the household.

To end one sub-key and leave the login, call `emet_subkey_revoke` from the owner login. Pass the tag or the key id, and a reason. Later writes that present that session handle are refused. Earlier writes stay as written.

To take an instance out of service, revoke as above, then stop the process. Keep the database. EMET has no tool that drops the record. Pausing the cluster is the database host's control.

## A control plane is future work

A later operator tool could provision an isolated instance. It would create a new database, a new deploy, and a new passphrase. It would not add a tenant to an existing database. It would not share `EMET_OAUTH_PASSPHRASE`, `EMET_SIGNING_KEY`, `EMET_SUBKEY_PEPPER`, or `EMET_ACTIVE_GEMS` across projects.

That tool is not built. Charter commitment 6 says nothing is built until it names the failure it fixes, what it replaces, how we will know it worked, and what holds it once it works. Those four answers are not on record. The item stays a seed in [ROADMAP.md](ROADMAP.md).

## Every instance uses the same session order

Connecting the server does not make a host follow the session. The server refuses a skipped step. There is no report mode and no off switch. Paste the block in [BOOTSTRAP.md](BOOTSTRAP.md). The gates are in [GUARDRAILS-AND-MONORAILS.md](GUARDRAILS-AND-MONORAILS.md).
