# Setting up EMET

From nothing to a working memory your assistant can use, on every device you own.

There are three stages and they must happen in order: **a database**, **a server**, **an
identity**. The first two are plumbing. The third is the one people skip, and it is the one
that decides whether the thing is useful.

**If you would rather not do the plumbing yourself,** [GUIDED-SETUP.md](GUIDED-SETUP.md) is
the same three stages carried out by your assistant, with you signing in when asked. This
page is the manual walkthrough and the reference the guided path points back to.

---

## Stage 1 — MongoDB Atlas

EMET stores everything in MongoDB. The Atlas free tier is enough to start.

**Trying it on one machine first?** A local MongoDB (version 6 or later) works for everything
except `semantic_recall`, which needs an Atlas vector index (step 7). Set
`MONGODB_URI=mongodb://127.0.0.1:27017/`, skip steps 1–4 and 7, and go to Stage 2. The
`emetRecordKeeper` role (step 2) is still worth creating on a local server that has users
enabled, by hand with `db.createRole`; `scripts/atlas-role.mjs` is for Atlas only. Use Atlas
when you want a second device to reach the same memory.

1. **Create a cluster.** <https://cloud.mongodb.com> → new project → **Create** a cluster.
   Any region near you. Note the cluster name.

2. **Create a database user for EMET, and give it EMET's own role.** Database Access →
   Add New Database User. Authentication: password. Username e.g. `emet_app`.

   EMET keeps its record — it never deletes a memory, a document or a transcript. Give the
   server a login that *cannot* delete them either, so the rule holds at the database and
   not only in the code. The role is **`emetRecordKeeper`**, defined once in
   `src/atlas-role.js`:

   | On | Allowed |
   |---|---|
   | your whole EMET database | find, insert, update, create collection, create index, list collections, list indexes, list search indexes, collection and database stats |
   | `<prefix>oauth_tokens` | remove — revoking a sign-in token |
   | `_emet_verify` | remove — the status check deletes its probe document and does not drop the collection |

   Nothing else may be removed or dropped. `tests/atlas-role.test.js` fails if the code ever
   starts deleting from a collection this role does not allow.

   **The quick way (Atlas CLI).** Install it (`winget install MongoDB.MongoDBAtlasCLI`, or
   see mongodb.com/docs/atlas/cli), sign in with `atlas auth login` in your own terminal —
   it asks you to pick options, so it needs a real keyboard — then from the EMET folder:

   ```
   node scripts/atlas-role.mjs --project <projectId> --db <database> --user emet_app
   ```

   That is a dry run: it prints the commands. Add `--apply` to create the role and move the
   user onto it; `--rollback` puts the user back on `readWrite@<database>`. Find the project id
   with `atlas projects list`. A non-default `EMET_COLLECTION_PREFIX` is picked up, or pass
   `--prefix`.

   **The click way.** Database Access → Custom Roles → Add New Custom Role, name
   `emetRecordKeeper`, add the actions in the table above against your database and the two
   collections; then edit the user and set its role to `emetRecordKeeper`.

   **Prove it.** From any EMET host, run `emet_status` with `probe: true`. It writes, reads
   back and removes a test document, so a role missing something fails there, loudly, instead
   of in the middle of a session.

   - Do *not* grant cluster-wide admin, and do not use this login for maintenance. A one-off
     job that must delete (a migration, a corpus rebuild) gets its own login, used and then
     removed.

3. **Network access.** Network Access → Add IP Address.
   - Local use only: add your own IP.
   - Deploying to Railway or similar: the egress IP is dynamic, so `0.0.0.0/0` is the
     practical option. Security then rests on the scoped user and the OAuth passphrase —
     both are required, and neither is optional.

4. **Get the connection string.** Connect → Drivers → copy the `mongodb+srv://...` URI and
   substitute your user and password. This goes in `MONGODB_URI` and **never** into git.

5. **Pick a database name** and set `MONGODB_DB`. It defaults to `emet`. Collections (`emet_episodic`, `emet_semantic`, …) are
   created on first write — there is nothing to pre-create.

6. **One database per EMET instance.** The document store (`documents`,
   `documents_history`) is deliberately *not* prefixed, so two instances pointed at the same
   database will share their identity and continuity documents even if their memory
   collections use different prefixes. If you want two separate memories, give them separate
   databases - not just separate prefixes.

7. **Vector index — only if you want `semantic_recall`.** Keyword search works without it.
   For meaning-based search, create an Atlas Vector Search index named
   `emet_content_auto` on the `emet_semantic` collection, path `content`, using
   Atlas Automated Embedding. Repeat per layer collection you want searchable.
   ⚠ **Atlas tier migrations can silently drop search indexes created mid-migration.**
   After any tier change, re-check that the index still exists.

---

## Stage 2 — run the server

EMET runs two ways from one codebase. Most people want both eventually: local for speed,
remote so the phone can reach it.

### Local (stdio) — desktop and CLI

```
npm install
npm test                    # optional: no database or credentials needed
cp .env.example .env        # fill in MONGODB_URI at minimum
npm start
```

`.env` is read automatically from the repo root. Real environment variables win over it,
so a hosted deployment that sets them directly is unaffected by a stray local file.

`npm start` prints its startup log and then waits, silently, for an MCP client on standard
input; that is normal. Stop it with Ctrl-C. Day to day you do not run it by hand: your MCP
client starts it from the entry below.

Then point your MCP client at it:

```json
{ "mcpServers": { "emet": {
    "command": "node",
    "args": ["/absolute/path/to/emet/src/index.js"],
    "env": { "MONGODB_URI": "mongodb+srv://...", "MONGODB_DB": "emet", "EMET_SOURCE_TAG": "laptop" }
} } }
```

### Remote (HTTP + OAuth) — phone, tablet, anything else

See **[DEPLOY.md](DEPLOY.md)** for the Railway walkthrough. Short version: deploy
`src/http-remote.js`, set the environment variables, and add the resulting
`https://<host>/mcp` URL as a custom connector in your client.

### Set a distinct source tag on every host

Every write records which host produced it. A local entry, which serves one host, sets that
host's tag with `EMET_SOURCE_TAG`, as in the example above. A remote server several hosts
share leaves `EMET_SOURCE_TAG` unset, and each host passes its own tag as `source` on its
writes: a shared default makes every host look the same, and you will have entries you cannot
attribute. `laptop`, `phone`, `cli`, `work-desktop`. One each.

---

## Stage 3 — the setup interview

This is the part that turns a database into a memory.

**Say "initialize".** There is no setup command to memorize.

Your assistant calls `emet_initialize`, which branches on the state of the store so you do not
have to. A new store returns a short interview; an established one returns the assistant's
identity, your profile, and recent context. Requiring a command would have been backwards —
the one session you would need it is the first one, before you have read any of this.

The interview asks six things, four required and two optional:

- **What the assistant should be called**, and **how it should carry itself.** This becomes
  the identity it speaks from in every session on every host.
- **Your name**, in the form you actually want used.
- **What you are using this memory for**, which shapes what gets treated as worth saving.
- Optionally: how you want to be worked with, and this host's source tag.

Your assistant asks these conversationally, one at a time — not as a form — then calls
`emet_setup_complete`.

Three behaviours worth knowing:

- **It refuses to finish on partial answers** rather than filling in the gaps itself. An
  invented identity is worse than no identity.
- **Re-running is safe.** Documents are versioned and the previous copy is archived to
  `documents_history`. Nothing is overwritten in place, ever.
- **If the store is unreachable, initialize says so** instead of continuing as though memory
  were available. A confident assistant with no memory and no warning is the worst outcome.

What gets written: `bootstrap/IDENTITY.md` and `bootstrap/USER.md` in the document store, plus
an entry in the `identity` layer. All three are read-back verified before setup reports
success. Edit any of them later with `write_doc` — same versioning applies.

**The supporting tools**, which you should not normally need:

| Tool | What it does |
|---|---|
| `emet_status` | Diagnostic: environment, database, collections, vector index, whether identity and user documents exist, per-layer counts and health. With `probe: true` it also connects, pings, **writes a probe and reads the same value back**, then removes it — a read alone will not reveal a broken write path. |
| `emet_setup_complete` | Records the answers, read-back verified, and creates the owner person. The owner's only: refused under a bot tag, and refused on a store that is already set up unless `reissue: true` is passed. |

## Migrating an existing CASCADE deployment

If you are already running upstream CASCADE against a MongoDB store, EMET reads it in
place. **Nothing needs to be renamed, copied, or migrated** - point the new build at your
existing names and every memory, document, transcript and OAuth token stays exactly where
it is.

| Variable | Set it to | Why |
|---|---|---|
| `MONGODB_DB` | your existing database | EMET defaults to `emet`; yours is probably something else |
| `EMET_COLLECTION_PREFIX` | `cascade_` | your layer collections are `cascade_episodic`, etc. |
| `EMET_VECTOR_INDEX` | `cascade_content_auto` | the Atlas Vector Search index `semantic_recall` uses |
| `EMET_CORPORA` | your corpus names, comma-separated | only if you use `corpus_recall`; leave unset otherwise |

`EMET_COLLECTION_PREFIX` also governs the counters collection and the three OAuth
collections, so **devices you have already authorized stay authorized** - there is no
re-consent step.

Your old `CASCADE_SOURCE_TAG` and `CASCADE_OAUTH_PASSPHRASE` continue to work; the `EMET_`
forms take precedence if both are set. New installs should use the `EMET_` names only.

**The server guards against getting this wrong.** If it is configured for a prefix that sees
zero memories while the same database holds populated collections under a different one,
`emet_initialize` returns `state: "misconfigured"` instead of `ready` or `setup_required`, and
refuses to offer the setup interview. This matters because the failure is otherwise silent:
the document store is unprefixed, so a mismatched server still finds your identity and comes
up looking healthy - correct name, correct profile, and an empty memory. It reports the
prefixes it found and how many entries are under them.

**Verify before trusting it.** Run `emet_status` and confirm the layer counts match
what you had, and that `vector_index` reports the index you expect. Then `emet_initialize` -
it should come back `ready` with your existing identity, not `setup_required`. If it says
`setup_required`, one of the four variables above is wrong; **do not run the setup interview,
which would write a new identity over your existing one.**

## Stage 4 — tell your assistant to use it

Setup gives the store an identity. It does not tell your assistant to consult it. See
**[BOOTSTRAP.md](BOOTSTRAP.md)** for the short instruction block to paste into your project,
and for what to expect on hosts that offer no instructions field.

## Verifying it worked

```
emet_status              → initialized: true (false until the setup interview is done)
emet_status probe:true   → every probe check passed
emet_session_open        → a session_id
save_to_layer            → with that session_id, then recall it from a different device
```

Ask your assistant to remember something and it makes these calls. A `semantic` or
`procedural` save without a `session_id` (or a `derived_from`) is refused by design: those
layers must name the conversation they came from.

That last one is the real test. Write from your laptop, read from your phone. If both see it,
the thing is doing its job.

---

## When it does not work

| Symptom | Cause |
|---|---|
| `MONGODB_URI is not set` | No `.env`, or the process was started without it. |
| `source tag "..." is not registered` | The tag is missing from `EMET_SOURCE_TAGS`. Add it, then restart. |
| `a source tag is required` on `emet_transcript_append` | Transcript appends always name their host: pass `source` (a registered tag) on the call. |
| `semantic entries must carry their source` | Open a session with `emet_session_open` and pass its `session_id` on the save. |
| `vector_index: not queryable on this deployment tier` | Normal on a local MongoDB or before the Atlas index exists; only `semantic_recall` needs it. |
| Connect times out | Your IP is not in Atlas Network Access, or the cluster is paused. |
| Auth fails | The password in the URI needs percent-encoding if it contains `@ : / ?` etc. |
| `semantic_recall` returns nothing, keyword search works | The vector index is missing or was dropped by a tier migration. |
| Writes land but another device cannot see them | The two hosts point at different `MONGODB_DB` values. |
| Entries all carry the same source | A server several hosts share has `EMET_SOURCE_TAG` set, so every write that passes no `source` gets that default, or two local entries use the same tag. Unset it on the shared server and have each host pass its own `source`. |
