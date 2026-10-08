# Deploying EMET as a remote MCP server

This deploys `src/http-remote.js` as an OAuth-protected HTTPS endpoint, so hosts that cannot
run a local process — phones, tablets, web clients, third-party agents — reach the same
memory store as your desktop.

The memory logic is identical to the local server. Only the transport differs.

## Prerequisites

Finish **Stage 1** of [SETUP.md](SETUP.md) first. You need a `mongodb+srv://` URI with a
scoped user, and Atlas Network Access set to `0.0.0.0/0` — a hosted platform's egress IP is
dynamic, so it cannot be allowlisted. Security rests on the scoped user plus the OAuth
passphrase; both are required.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | yes | Atlas connection string, scoped user. |
| `MONGODB_DB` | yes | Database name. Must match your other hosts, or they will not see each other's writes. |
| `PUBLIC_URL` | yes | The public **https** base URL. This is the OAuth issuer and must match the deployed URL exactly. |
| `EMET_OAUTH_PASSPHRASE` | yes | Typed once per device to authorize it. Make it strong — it is the only thing between the internet and your memory. |
| `EMET_SOURCE_TAG` | optional | Default tag for a write that passes no `source`. Leave it unset on a server several hosts share (see below); set it only when one host uses this deployment. |
| `EMET_TIMEZONE` | optional | IANA time zone that session ids are dated in, e.g. `America/Chicago`. Default `America/New_York`. An unknown name falls back to the default and `emet_session_open` says so. |
| `EMET_CLOSE_GRACE_MINUTES` | optional | Minutes after a complete close in which a session still takes its one closing exchange (the reply sent after the close). Default `5`; `0` turns the window off; at most `60` (a larger value is capped at 60). A negative or non-numeric value is not used: the server logs a warning and uses `5`. |
| `EMET_GAP_BASELINE` | optional | ISO date (or Unix seconds) from which the record is held to the current rules. The startup line then reports gaps since that date beside the lifetime figure. |
| `PORT` | auto | Injected by the platform. |
| `TRUST_PROXY` | not read | The server trusts exactly one proxy hop (Railway's edge). TRUST_PROXY is not read. The `/mcp` body limit is 256kb. |

## Checklist before 0.2.3

Read this before you deploy the release that follows 0.2.2. It does not change a version number. It is the list of settings and client habits that will start failing if you leave them as they were.

- **`EMET_SOURCE_TAGS` must list every real host tag**, as an exact member. Tags named in this repository's example env, docs, and live-tag checks are: `cli`, `mobile`, `desktop-host`, `cloud-host`, `project-host`, `hub-bot` (the hub; do not also list it in `EMET_RECORD_DOCS`), `reviewer-bot`, `tester-bot`, `memory-bot`, `intake-bot`, and `research-bot`. Your install may use a shorter list. A tag that is not an exact member is refused, and the refusal does not print the list.
- **A scheduled job that still sends a `cloud-scheduled-` prefix must switch to an exact registered tag.** `cloud-scheduled-intake` was retired on 2026-10-02. A prefix is not a tag. The weekly intake runs under `intake-bot`.
- **An HTTP client whose stored token has no source tag must sign in again.** Refresh of that token is refused. The new consent binds a registered tag. An empty registry has no members.
- **Caps already in force.** A client that used to send more is refused, and nothing is written:
  - 20 new drops per New York day, in one bucket: the whole local process on stdio, one shared visitor bucket for HTTP with no signed-in client, the source tag bound at approval when there is one, or that OAuth client otherwise. A source the caller types does not move the bucket.
  - HTTP request body: 256 KB.
  - A transcript field: 32,000 characters. The whole transcript request: 256,000 characters.
  - Tool calls: 300 per minute for that person and client, and a per-tool cap (120 for `recall` and `semantic_recall`, 100 for `query_layer`, 30 for `emet_status`, 60 for `save_to_layer`, 60 for every other tool).
  - Client-metadata fetches: 60 per host per minute, 120 in total, 64 KB, 5 second timeout. The connection uses the public address already checked. A redirect is refused.
  - A document edit may not leave it under half the size this session first saw, and not under half of its largest size in the last 24 hours.
  - Recall ranks in the store before it keeps a window of at least 200 rows, or 20 times the page.
  - The window for one closing exchange after a complete close is at most 60 minutes.

## Before you touch anything

**Set the environment variables BEFORE the first deploy, not after.** A server that boots once
with the wrong configuration creates collections, mints OAuth tokens, and generally leaves
residue you then have to reason about. Variables first, deploy second.

**Write down the current deployment id** if you are replacing a running service:
`railway status` prints it. Rolling back is Dashboard → Deployments → that entry → Redeploy.

**⚠ `railway variables` prints values in plaintext**, including your connection string and your
passphrase. Use `railway variables --kv` and read only the key names unless you specifically
need a value. Do not paste that output into a chat, an issue, or a screenshot. Redacting it
afterwards does not work reliably - table output wraps long values across lines, and a
credential split over two rows defeats the pattern you were counting on.

## Railway

```
npm i -g @railway/cli
railway login
railway init                     # from the repo root
railway up
railway variables --set MONGODB_URI=... --set MONGODB_DB=emet \
  --set EMET_OAUTH_PASSPHRASE=... --set EMET_SOURCE_TAGS=mobile,desktop,cli
railway domain                   # get the public URL
railway variables --set PUBLIC_URL=https://<app>.up.railway.app
railway up                       # redeploy so PUBLIC_URL matches the live URL
```

One service serves every host, so register the hosts' tags with `EMET_SOURCE_TAGS` and leave
`EMET_SOURCE_TAG` unset: a default tag makes every host look the same (see `.env.example`).
Over HTTP, document, transcript, and memory writes use the tag bound when that host was
approved. A local stdio host still passes an exact registered tag as `source`.

**Tokens issued before source tags were bound.** An access token whose row has no `source_tag`
can still write when the caller names a tag that is an exact member of `EMET_SOURCE_TAGS`.
That is no wider than the registry: an empty registry has no members, and a tag that is only
a prefix match does not count. Refreshing such a token is refused with `invalid_grant` and a
message to sign in again, so the new consent binds a registered tag. The empty tag is not
copied onto the replacement. Those logins age out on their own as each access token expires
and the refresh is refused. After this deploy, a host whose writes are refused for a missing
source tag signs in once. A member code can carry a registered tag: the owner sets `source`
when creating the code, and redeem binds that tag.

**The monorail runs in enforce only** (2026-10-03). There is no mode setting: every gate refuses a
skipped step before anything is written, and the reply says how to pass. `EMET_SESSION_GRAPH` is
no longer read; remove it from the service's variables in the Railway dashboard. If the session
store cannot be read, a governed write that names a session is refused and nothing is written.
Transcript writes and `emet_session_open` fail the same way
([GUARDRAILS-AND-MONORAILS.md](GUARDRAILS-AND-MONORAILS.md)). The record of which startup
pages each host fetched is kept in the server's memory for 60 minutes after its last page, so
after every deploy or restart, or a longer pause, an open with an older `load_id` is refused once
and told to call `emet_initialize {}` again.

There is no setting to turn the monorail's refusals off. In an emergency, redeploy the previous
release, git tag `v0.1.0`, and check EMET_SESSION_GRAPH first: unset or report flags
skipped steps without blocking them (a closed session still takes no new exchanges, and a
session-store outage still blocks transcript writes and `emet_session_open`); enforce keeps
refusing; off stops consulting the graph, including the closed-session lock, so a closed session
takes new exchanges again, a session-store outage blocks nothing, and closes are not recorded. That also rolls back every other change in this release, including
byte-paged read_doc.

When a close returns `complete`, the server records the session as closed before it sends the
close's reply, **when that write succeeds**. A failed write is retried once; if it still fails, the
reply says `closed_recorded: false` with a warning (the session is not locked yet; calling the close
again records it).

**Per-bot close records.** To run a bot in its own session, add `bots/<source tag>/HANDOFF.md` to
`EMET_RECORD_DOCS` (comma list), e.g. `bots/intake-bot/HANDOFF.md`. That one id makes the tag a
bot tag: its sessions close against `bots/<tag>/HANDOFF.md` with seven receipts and no board, only its
own revisions count, and `write_doc`, `patch_doc`, `retire_doc`, `rename_doc` and
`accept_nonconformance` refuse it the main handoff and board.
`retire_doc` and `rename_doc` are refused to a bot tag for every document, not only the main
records (retiring and renaming are the owner's and the hub's), and `emet_setup_complete` is refused
to a bot tag.
Do not map a bot's handoff to `templates/HANDOFF.md`: that template asks for a board a bot does
not keep, so every bot close would be marked nonconforming. Bot handoffs have their own form,
`templates/BOTHANDOFF.md`; while it is DRAFT, leave bot handoffs unmapped, and once it is IN FORCE
add `bots/<tag>/HANDOFF.md=templates/BOTHANDOFF.md` to `EMET_TEMPLATE_MAP` (it marks conformance and
never rejects a write). Setting `EMET_RECORD_DOCS` replaces its value: keep every entry already
there and append. Nothing else is set, and no data changes shape. To undo it for one bot, remove
its id from `EMET_RECORD_DOCS`: that tag goes back to the host rules (it cannot close without the
main records) and the write refusal lifts. The id must match exactly (no leading `./`, the tag's
exact case); a typo silently leaves the tag on the host rules and lifts the write refusal. Register
the tag in `EMET_SOURCE_TAGS` as well, or its transcript appends are refused. Never list the hub's
own tag (e.g. `hub-bot`): a listed tag can no longer write the main records.
The full procedure — tag naming, the roster (`templates/ROSTER.md`), the session loop and
corrections — is [BOTS.md](BOTS.md).

**Write guards on records (both always on).** `write_doc`, `patch_doc`,
`retire_doc`, `rename_doc` and `accept_nonconformance` apply two more refusals, and nothing is written
when either fires:
- *Registered hosts only on the main records.* When `EMET_SOURCE_TAGS` is set, a write to the main
  handoff or board (`EMET_HANDOFF_DOC`, `EMET_STATE_DOC`) is refused unless its `source` is one of the
  listed tags. A write with no `source` is refused too, and so is a misspelled or unlisted tag
  (scheduled runs such as `cloud-scheduled-*` included). Before turning this on, make sure every tag
  that writes the main records - the hub's own tag in particular - is in `EMET_SOURCE_TAGS`. With
  `EMET_SOURCE_TAGS` unset nothing changes.
- *A bot writes only its own folder; registered tags only under `bots/`.* A bot tag (one whose
  `bots/<tag>/HANDOFF.md` is in `EMET_RECORD_DOCS`) is refused any write under `bots/` outside
  `bots/<tag>/`: other bots' records and `bots/ROSTER.md` belong to the hub. With `EMET_SOURCE_TAGS`
  set, a write under `bots/` by anything other than a listed bot also needs a registered tag: an
  unregistered or misspelled tag, a write with no `source` (it falls back to `EMET_SOURCE_TAG`), and
  `cloud-scheduled-*` runs are refused. Registered host tags still write anywhere under `bots/`.

**Known gap (F-2, later).** A tag that is registered but not listed as a bot is a host for both
guards, so it can still write the main records and any bot's folder. To fence a bot, set both
variables in one change. **With `EMET_SOURCE_TAGS` unset, both guards are opt-in and off:** any
caller can write the main records and every bot folder, so set the registry on any shared install.

**Legacy `CASCADE_` names.** Only the settings read through `setting()` in `src/env.js` also accept
the legacy `CASCADE_...` name as a deprecated fallback (the `EMET_` name wins when both are set):
`EMET_SOURCE_TAG`, `EMET_SOURCE_TAGS`, `EMET_OAUTH_PASSPHRASE`, `EMET_AUDIT_LOG`, `EMET_HANDOFF_DOC`,
`EMET_STATE_DOC`, `EMET_INSTALL_DOC`, `EMET_CHARACTER_DOC`, `EMET_TEMPLATE_MAP`, `EMET_RECORD_DOCS`,
`EMET_READ_DOC_PAGE`, `EMET_SIGNING_KEY`, `EMET_GAP_BASELINE`, `EMET_CIMD`, `EMET_INVITES`,
`EMET_TIMEZONE` and `EMET_CLOSE_GRACE_MINUTES`. These read `process.env` directly, so **only the
`EMET_` name works** and a `CASCADE_` name is ignored: `EMET_COLLECTION_PREFIX`,
`EMET_VECTOR_INDEX`, `EMET_CORPUS_INDEX`, `EMET_CORPORA`, `EMET_CORPUS_COLLECTION`,
`EMET_REQUEST_LOG` and `EMET_CRASH_LOG`. (`MONGODB_URI`, `MONGODB_DB`, `PUBLIC_URL`, `PORT`, `HOST`,
`LOG_LEVEL`, `LOG_FORMAT` and `DEBUG` have no prefix. `TRUST_PROXY` is not read: the server trusts exactly one proxy hop (Railway's edge).) Use the `EMET_` names.

**The two-pass deploy is not optional.** `PUBLIC_URL` is the OAuth issuer; until it matches
the real URL, authorization fails in ways that look like a client problem.

The repository's `Dockerfile` starts the HTTP transport (`node src/http-remote.js`), and Railway
builds from it — there is no start command to set. (If you deploy without the Dockerfile, the
start command is `npm run start:http`.)

**Would rather have your assistant run all of this?** [GUIDED-SETUP.md](GUIDED-SETUP.md).

### If the CLI misbehaves on Windows

Two things cost real time and neither is obvious:

- **The npm `.cmd` shim fails with `'"node"' is not recognized`** if node is not on PATH in the
  shell that launches it. The package ships a native binary - call it directly:
  `%APPDATA%\npm\node_modules\@railway\cli\bin\railway.exe`
- **`railway login --browserless` only works if you approve on the SAME machine.** The flow
  redirects to `127.0.0.1`, so approving the code on your phone or another computer completes
  nothing and the CLI waits forever. Plain `railway login` opens the right browser locally and
  is more reliable.

Non-interactive linking needs explicit flags:
`railway link --project <name> --service <name> --environment production`

## Fly.io (alternative)

```
fly launch --no-deploy
fly secrets set MONGODB_URI=... MONGODB_DB=emet PUBLIC_URL=https://<app>.fly.dev \
  EMET_OAUTH_PASSPHRASE=... EMET_SOURCE_TAGS=mobile,desktop,cli
fly deploy
```

## Smoke test before connecting anything

```
curl https://<host>/health
curl https://<host>/.well-known/oauth-authorization-server
```

The first should report ok and a tool count. The second should return OAuth metadata, not a
404 — if it 404s, `PUBLIC_URL` is wrong.

## Connecting clients

**Claude (all interfaces, including phone):** Settings → Connectors → Add custom connector →
URL `https://<host>/mcp` → connect → you are sent to a passphrase page → enter
`EMET_OAUTH_PASSPHRASE`. Enable it per conversation from the "+" menu.

**Any other MCP client:** point it at `https://<host>/mcp` and complete the OAuth flow.

Then verify from that device: `emet_status` with `probe: true`, followed by a `recall` of something
you saved elsewhere. If the remote host sees what the laptop wrote, the deployment is real.

## Notes

- **Release note: startup stage 1 (the host-aware startup amendment).** Three behaviour changes take effect
  live on deploy:
  - **Re-running setup is refused.** `emet_setup_complete` on a store where both
    `bootstrap/IDENTITY.md` and `bootstrap/USER.md` already exist is refused unless the call passes
    `reissue: true` (a top-level boolean) on the owner's explicit word; nothing is written. A host
    flow that re-runs setup at startup now gets a refusal. That is intended: tell the owner.
  - **Bots lose `retire_doc` and `rename_doc` everywhere,** their own `bots/<tag>/` folder
    included. Retiring and renaming are the owner's and the hub's. `emet_setup_complete` is also
    refused to a bot tag.
  - **`emet_initialize` no longer creates the owner person.** Only `emet_setup_complete` does. An
    older install that was set up before the owner row existed, and never had one created, keeps
    resolving its owner as the legacy subject `owner` until the owner runs `emet_setup_complete`
    once with `reissue: true` (which also writes new versions of the identity documents; prior
    versions are archived). There is no separate tool for this.
- **Clients cache tool lists, and this WILL catch you.** After any deploy that changes the
  tool surface, every host keeps offering the old set until you reconnect the connector there.
  Nothing breaks - existing tools keep working - but new tools stay invisible. Reconnect each
  host: phone, desktop, CLI, anything else. This is the last-mile step people forget.
- **Costs.** A small Atlas cluster plus a hobby-tier host runs in the low tens of dollars a
  month. Both have free tiers adequate for a single user.
- **The passphrase is the whole perimeter.** There is no second factor. Rotate it by changing
  the variable and redeploying; existing device authorizations are invalidated.
