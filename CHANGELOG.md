# Changelog

All notable changes to EMET are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/). EMET is still 0.x: the stored data shapes may
change before 1.0.

## Unreleased

## 0.2.6 - 2026-10-20

### Added
- First-use setup can turn on delegated client sub-keys (EMET-0001). `more_than_one_bot` is optional and defaults to no. Yes writes the flag, a generated pepper and version 1 into `.env` only when that file is the config source, after the store writes succeed, and does not turn the flag on in the running process. A hosted server refuses and tells the owner to set `EMET_SUBKEYS=1`, an owner-generated `EMET_SUBKEY_PEPPER` and `EMET_SUBKEY_PEPPER_VERSION=1`, then redeploy. See `docs/SUBKEYS.md`.
- Delegated client sub-keys (EMET-0001, accepted 2026-10-15). Behind `EMET_SUBKEYS=1` (off registers nothing new): `emet_subkey_request`, `emet_subkey_claim`, `emet_subkey_revoke`, and `emet_subkey_end_session`, plus the `subkey` and `session_handle` arguments and the `declared_attribution` gap. A bot on the shared owner login presents an `emk_` key at `emet_session_open` and the one-time `emh_` session handle on later writes. The server stamps the key's tag. Keys expire after 30 days and can be reissued. Approve and revoke stay on the owner's own login. Each bot holds its key as a local secret. HMAC seals store a pepper version so the previous pepper still verifies during rotation. Records live in the subkeys collection and its history, readable by the owner and the chief of staff. Each change is a compare-and-set on that document's revision and writes only the documents it changed. History events have their own ids and a duplicate-key error is not dropped. A correct handle is never locked out; only failed presentations count, per key, per client, and per session. Each open keeps its own record. Closing a session releases it only when the caller holds that session's key and handle, checked against `receipts.transcript_session_id`. A transcript row written in that session carries `key_id`. With the flag off the tool list is unchanged. Startup ends any live sub-key session once, in the background, when that collection already exists, and a write does not open the sub-key store. A write that presents an `emh_` handle, or names a sub-key session this process has seen, is refused. An empty `EMET_SOURCE_TAGS` refuses every sub-key tag. A store that ran the first build still has sub-key rows in the `emet/CLIENT_APPROVALS.md` history; production did not run that build.
- `emet_status` reports each GEM's byte cost (`gems`): installed and active counts, active floor bytes against `MAX_ACTIVE_FLOOR_BYTES`, headroom, the enforced caps, and per-GEM id, version, kind, bytes and refusal reason. Read-only and carries no floor text; a socket failure is reported in the field and never fails the status (GEM socket PR 4).
- Optional bot-team backup, off unless the first-run interview records yes. Yes is the recommended choice. The answer is stored on `bootstrap/USER.md`. The recipe and the recovery template ship as the bundled bot-team-backup GEM. EMET does not copy prompts or settings itself. Secret values are never stored. The recorded answer accepts yes or no in the user's words. Yes and Yes. count as yes. A non-string and any other text are refused before a write.
- Lean Six Sigma 0.9.0, a bundled runed GEM, off unless `EMET_ACTIVE_GEMS=lean-six-sigma`. Its `requires.emet` is `>=0.2.6` and `released` is true. Rune file digests are unchanged. `guides/BELTS.md` is `sha256:e9e591af0e2d89a27cddf73da48e4f4acacd1785e22473d42dd3b56366d008d0`. `gem.json` is `sha256:5f9da0caf7719a73f19bfbff211002eb66dbd0f988fd094131b56c4ecf438b31` and `CHANGELOG.md` is `sha256:d07810bd35e71952cea36212b878d8762a43b4f7b8e5f710b41a4190308d86fc`, the shipped 0.9.0 copy. `gems/artifact-index.json` is unchanged.

### Security
- `EMET_SUBKEY_PEPPER` is masked on the write path. Setup does not return it or write it into a hosted container's `.env`. A leaked active key is revoked with `emet_subkey_revoke` from the owner's login. Deny applies only to a pending request. ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording, the Charter and the floor are unchanged.

### Fixed
- The bot-team backup answer accepts yes or no in the user's words, the same way as the multi-bot question. Yes and Yes. record the flag. A non-string and any other text are still refused before a write.
- The socket refuses a GEM whose `gem.json` `released` is not the boolean `true` (SR-08) on every boot. `false`, the string `"true"`, `1`, and `null` fail, and the socket logs the value. A missing field is allowed only for `neurendipity` 1.2.3 and `fieldnote` 1.0.1 when the id, the version, and every file digest match the pin. A shorter file list does not match. The pin covers the id, the version, and the file digests. It does not cover every other manifest field, including `defaultOn`, `priority`, `requires`, `description`, `name`, `authors`, `license`, rune `description`, schemas, the guides list, `distribution`, `coverage`, and rune metadata other than the version. `overrides` still needs SR-05 consent. A rune `execution` of `server` and `distribution` `library` are refused by GC-02. `gem.json` is not hashed: anyone who can edit it can already add `released: true`, so hashing it would grant nothing extra. A missing field on `neurendipity` or `fieldnote` that missed the pin says `(legacy pin mismatch: version/digests)`. An unpinned GEM does not get that hint. Any other GEM missing the field is refused, including a bumped version of those two. A read error refuses and does not turn the check off. Deleting or corrupting `fieldnote` does not disable the check. Two candidates that share an id log their own refusal.
- A RUNE may import only a file under the same GEM's `runes/`. A relative import that normalizes outside `runes/`, such as `../lib/h.js`, is refused even when that file is listed. A resolved real path outside `runes/` is refused, so a symlink that leaves `runes/` cannot be imported. A symlinked GEM directory fails GC-01 (`symlink`), and that refusal is not reused for the real directory. A symlinked file under `runes/` fails GC-04 (`symlink`) and is not followed. The socket records that refusal instead of omitting the entry. A `.JS` file under `runes/` is scanned. `.cjs` is not treated as a JavaScript module.
- The deploy image and the npm package include `verification/`. `src/host-reach.js` imports the RUNE load gate from there. A release that omitted the directory crashed at startup with `ERR_MODULE_NOT_FOUND`.
- RUNE import specifiers are checked in the vendored load gate (`runeSpecifierReason`). A bare package, `node:`, a URL, `emet/rune`, a path that normalizes outside the GEM, `../` with no file list, and a relative import that is not in the passed file list are refused. gem-check calls the same function. GC-16 still allows `emet/rune`; GC-19 still names that failure. A file under `runes/` that is not `.js` or `.mjs` fails GC-16 (`rune extension`) instead of being skipped.
- The GC-19 load gate is an allowlist (`verification/load-gate/load-gate.mjs`, the file EMET-GEMs vendors with `corpus.json`). acorn 8.19.0, fail closed, no second scan. Only listed AST nodes are admitted. No `var`, and no binding may reuse a top-level name. `Math` is only a direct read or call of a listed member, never `random`, and the Math object is never stored, passed, or returned. A computed key is a literal, a `const` bound directly to a primitive literal, or a read of a top-level `Object.freeze({ __proto__: null, … })` table inside a recognized `Object.hasOwn` guard. The guarded key is one `const` that is a primitive before the guard (`const n = String(input.n)` or `Number(...)`, or a recognized `typeof` check for `'string'` or `'number'`). A const object is refused: `toString` or `Symbol.toPrimitive` can return one own key at the check and another at the read. A member, a `let`, or a parameter does not qualify. The guard's non-own-key safety rests on the table being frozen with a null prototype. `.freeze` counts only on the unbound `Object` identifier. There is no loop-index exception. Tables are not passed, spread, or returned. A member write is admitted only on an object or array born in that function. `prototype`, `Array.prototype`, `Error.prepareStackTrace`, and `RegExp.$1` fail. `toLocaleString`, `localeCompare`, `toLocaleDateString`, and `toLocaleTimeString` fail (`intl`). `Buffer`, including `Buffer.allocUnsafe`, fails (`memory`). A `for (const k of …)` key still needs `String`/`Number` or a `typeof` check. `toLocaleUpperCase`, `toLocaleLowerCase`, and a destructured locale name fail (`intl`). A computed key in a binding or assignment pattern must be a string or number literal, including nested patterns, parameters, defaults, `catch`, and `for-of`. Concatenation, a member, and a const used as that key fail. `m['call']` fails with `.call`. The checker accepts spec `2026-10-12` and optional `changelog`, `update`, `knowledge`, and `coverage`. A `coverage` list holds at most 256 entries.
- The per-RUNE description and served response wrap the `metadata.gem` value in backticks, so the sentence period is not copied with the value.
- A per-RUNE tool states the exact `metadata.gem` value (`<gem>@<version>`, for example `fieldnote@1.0.1`) in its description and in the served response. A save that does not use that form says `metadata.gem` must be `'<gem>@<version>'`.
- The serve log file `logs/gem-serves.json` keeps the latest `SERVE_CAP` (200) rows for each principal, so one caller cannot evict another. This release creates the new collection `<prefix>gem_serves` (`SERVE_COLLECTION`). Alex approved it as an append-only write site on the write-path allow-list. The collection keeps every row. Nothing is deleted. A redeploy that drops the file can still seal a result. Concurrent serves write distinct temp files, and one process records one serve at a time. Tests point the file at a temp path. The guard and the GC-19 load gate reject `vm`, `new Function`, and a computed `import()` path. When the store is not connected, the file is the only copy and a redeploy drops it. Fieldnote is off by default. See SPEC.md §10.
- Error text again replaces a stack frame with `[stack-frame]`. The publish workflow runs only on a published release. Public text no longer carries a private path, a private branch name, or an install-specific display name.
- Bot-team backup references name `gems/bot-team-backup/guides/BOT_TEAM_BACKUP.md`, the file on disk.

### Changed
- Lean Six Sigma is 0.9.0, `released` true, `requires.emet` `>=0.2.6`. The GEM version pattern is `MAJOR.MINOR.PATCH` with no suffix. A version suffix fails GC-02. `gem.json` (`sha256:5f9da0caf7719a73f19bfbff211002eb66dbd0f988fd094131b56c4ecf438b31`) and `CHANGELOG.md` (`sha256:d07810bd35e71952cea36212b878d8762a43b4f7b8e5f710b41a4190308d86fc`) are the shipped 0.9.0 copy. The same digests are recorded in `tests/fixtures/lss-source/DIGESTS.json`.
- The socket serves RUNED code and does not run it (GEP-0003). One read-only tool per RUNE, named `gem_<gem>__<rune>`, returns the code, description, inputs, outputs, runtime, and served sha256. The server sandbox is removed. GC-19 checks the artifact hash and a static load gate: no network, no dynamic `import()`, no `eval`. A kept result is sealed on the existing write path. The principal comes from authentication. The served hash is the pin. The client-reported hash and the input hash are stored for traceability. Those attestation fields do not change on a later write. Superseded artifacts stay in `gems/artifact-index.json` by sha256. Charter commitment 1, the Extension-socket carve-out: "EMET verifies the record, not the computation. Client-executed RUNE results are recorded as attested by the client; they are replayable from recorded inputs, not re-executed by EMET." Fieldnote is off by default. ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording is unchanged.
- Version 0.2.6. Charter commitment 1 again states the client-executed RUNE carve-out: EMET verifies the record, not the computation. ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording is unchanged.

### Docs
- Client-side execution of RUNED directives (GEP-0003, accepted by Alex 2026-10-16). Supersedes GEP-0002, which is kept. The socket must not run RUNE code. One read-only tool per RUNE serves that RUNE's code, inputs, outputs, description, and served hash. SPEC.md §10–12, CONFORMANCE.md GC-19, the charter commitment 1 carve-out (EMET verifies the record, not the computation) and the Extension-socket row, and `docs/gem/README.md`. ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording is unchanged. No code change in this revision.

## 0.2.5 - 2026-10-14

Per-session attribution with client approval, the GEM socket with the bundled Neurendipity GEM (off unless the user asks), and two new core floor lines: `goal_check` and `no_rapport_mirroring`. ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording is unchanged. No stored data shapes change; deploy over 0.2.4.

### Fixed

- Neurendipity 1.2.3 (the reviewer's non-blocking nit on #40). `NEURODIVERGENT_SUPPORT.md` §8 prose now reads "A meta-analysis (2026, online 2025)" to match the Vann-Adibe tag. In-text tags for Bougoure et al. and Pagán et al. now carry "(online 2025)" in both guides, matching their Sources entries. gem.json digests updated. Guides only; floor unchanged.

- Review fixes from the reviewer for #38 and #39. Floor: `no_rapport_mirroring` now reads "agree as a way to build rapport or seem attuned", allows quoting the person for accuracy, and limits the no-praise rule to "praise or rapport-building language used for effect"; `acknowledge` now acknowledges good thinking "when it is earned by substance, stated as a specific reason, not as praise", which removes the conflict between the two lines. New tests cover the protected and modifiable override paths, the wording, and the reassertion line. Neurendipity 1.2.2: the 'poor at telling current from past burnout' finding is now attributed to the prepublication AASPIRE measure, not the ABSI (AUTISTIC_BURNOUT.md); the year convention is applied to Cai 2026 (online 2025, *Autism Research* 19(2)), Vann-Adibe 2026 (online 2025, *Appl Psychophysiol Biofeedback* 51(3)), and Bougoure (online 2025); Pagán values now "were associated with" camouflaging; Ferrie comma fixed. ISO 9001 / ISO 13485 document-control wording is unchanged.

### Added

- Core floor, engagement: `goal_check` (before multi-step work, on an ambiguous request, or when the conversation turns, state the person's goal and underlying problem in one sentence in your own words, marked as your read, and confirm; distinct from `their_own_plan`, it checks the goal underneath and never re-narrates a stated plan) and `no_rapport_mirroring` (no echoing, flattery, or agreement to build rapport or seem attuned; that is manipulation; agreement is earned by substance; state the obvious only when it adds information; default register is plain facts, with no emotional padding, praise, or rapport-building language). One matching reassertion line. `no_rapport_mirroring` is a protected override path; `goal_check` joins the modifiable list (a GEM or modifier may tune when it fires, never remove the anti-mirroring line). Targets the next public release, which must update the repo, website, README, npm package, MCP Registry entry, and description together.
- Neurendipity 1.2.1 (accuracy fixes from the reviewer's review of #37, under the owner's 2026-10-12 10:17 AM approval). Guides only; floor unchanged. Bougoure line in `NEURODIVERGENT_SUPPORT.md` rewritten (AUC 0.92 vs PHQ-9 0.78; correlates with depression and anxiety, so it does not on its own tell burnout from depression). Arnold 2023 sample limits; Osborne described as 14 studies with qualitative data synthesised; Pagán 'was associated with' and therapy-programme recruitment; van Asselt scope and no intervention studies; Vann-Adibe effect label, heterogeneity and moderator scope; Comerford UK-only and 'a sense of community'; Ferrie & Hafetz sample limits, service line tagged as a suggestion; Clarey author initials. One year convention stated (issue year, online year in brackets); Pagán cited as 2026 (online 2025).
- Neurendipity 1.2.0 (the owner's approval 2026-10-12 10:17 AM). Guides only; floor unchanged. `AUTISTIC_BURNOUT.md`: measurement (Arnold 2023 ABSI, Bougoure 2026), shame and dual masking (Clarey 2026), camouflaging as energy cost and unmasking as a balancing act (Osborne 2026), culture (Pagán 2025). `NEURODIVERGENT_SUPPORT.md`: RSD scoping review findings (van Asselt 2026) and self-compassion validity (Cai 2025) in §3; Osborne and Pagán in §6; interoception meta-analysis (Klein 2025) and remote HRV biofeedback meta-analysis (Vann-Adibe 2025) in §8; Comerford 2026 and Ferrie & Hafetz 2026 in §9. Support only, not counseling or treatment.
- Attribution per session, v2 (replaces the reverted #32). Agents sharing one OAuth login are stamped with the tag they declare (`source_basis: declared`, `source_login` kept), but a declared tag never gains rights beyond the login's tag: every guard runs for both. Every write naming a session is checked against the tag that owns the session, rebuilt after a restart from the session's stored rows. New clients: the first write by an unknown tag is refused and queued in `emet/CLIENT_APPROVALS.md` with who connected, the declared name, client_id and what it tried to write, routed to the chief-of-staff bot (`EMET_COS_TAG`) or, with none set, to the owner. A first, solo client on a fresh store is approved at once as the owner's primary. New tool `emet_client_approve`. `emet_initialize` and `emet_status` report the caller's real tag and, to the owner or COS, the pending clients.

- The GEM socket (`src/socket.js`) and `gem-check` (`src/gem-check.js`). This release seats bundled prompt GEMs only. A refused GEM is listed with its check id and does not stop startup. An empty mount logs nothing. A seating summary is logged only when a GEM is installed. RUNE execution is not implemented and is refused. No new runtime dependency.
- Neurendipity, the bundled GEM at `gems/neurendipity` (reading people, the neurodivergent engagement lines, the wellbeing corpus lines, the matching reassertion lines, and the guide). It is off unless the install sets `EMET_ACTIVE_GEMS=neurendipity`. `emet_floor` takes a `gem` argument to read an installed GEM's floor without turning it on. The guide id `guides/NEURODIVERGENT_SUPPORT.md` still resolves to that GEM's copy for one release.

### Changed

- The core floor keeps persistence (named items, including what was set aside on purpose), a general epistemic-honesty line (established, emerging, or anecdote), the epistemic corpus lines, and the honesty protections. An active GEM ranks below the floor and below the user's current word. Neurodivergent engagement is no longer on every install.

### Docs

- README and website: version 0.2.5; a GEM socket fact; the website gains a Document control (ISO 9001 7.5.3 / ISO 13485 4.2.5) fact in the README's words; the tool count is 30 with `emet_client_approve` (docs/PERMISSIONS.md lists it with the tools that can replace or hand out access).
- GEM standard, Draft revision 2026-10-11, in `gem-library/` (canonical home: the private repository EMET-GEMs). The charter's extension socket, commitment 8, and the core-floor row are revised: EMET is a memory resource, core floor protections stay non-removable, and neurodivergent engagement is the bundled Neurendipity GEM, off unless the user asks.
- Registering a bot (`docs/BOTS.md` §4, with a pointer in `docs/DEPLOY.md`): every bot writes under its own source tag, `<prefix>-<bot>`. When a bot joins the roster, append its tag to the end of `EMET_SOURCE_TAGS`, keep every existing tag in order, and add `bots/<tag>/HANDOFF.md` to `EMET_RECORD_DOCS` before its first write. Setting either variable redeploys the server; afterwards, check `/health` and `emet_status`.

## 0.2.4 - 2026-10-08

A board fix, a public website, and the first npm package, `@dreamforgestudiollc/emet`. A session that boots with no unhandled drops can edit the board again. No data shapes or settings change; deploy over 0.2.3 as is.

### Added

- A static website in `site/`, for search, and a GitHub Actions workflow that publishes that folder to GitHub Pages on pushes to `main`.
- `glama.json` at the repo root names `dreamforgestudiollc` as maintainer for the Glama directory listing.
- The README records the origin in the same words as the site: EMET was built by Dreamforge Studio LLC from a neurodivergent user’s own need for an AI assistant that remembers. The word coined for that is neurendipity: neurodivergent and serendipity.
- The public-scrub suite reads the Pages workflow's deploy job `if` and requires it to be exactly `github.repository == 'dreamforgestudiollc/EMET' && github.ref == 'refs/heads/main'`. A repository name that only contains that text, such as `dreamforgestudiollc/EMET-private`, does not pass.
- The same suite requires `site/sitemap.xml`, `site/robots.txt`, `site/.nojekyll`, and every image the site HTML references to be present on the scrub and publish walk. Removing one of those files fails the suite.
- `server.json` for the Official MCP Registry. Its name is `io.github.dreamforgestudiollc/emet`, the same value as `mcpName` in package.json. The npm package it names is the stdio server at version 0.2.4.
- The pack test reads the text inside the tarball. On a scrubbed tree, an install-specific name in any packed file fails it. On this private tree that check waits, because the publish scrub has not rewritten those files yet.
- The site image check fails a root-relative `/EMET/` image URL, a protocol-relative URL, a JSON-LD image in one of those forms, and a path that climbs out of the repository. A second Pages job with no `if` fails the deploy gate.

### Changed

- The README now opens with the search line and a short account of what EMET does, in the same words as the website: an MCP (Model Context Protocol) memory server, persistent shared memory for AI agents, bot teams and chats. The previous opening paragraph, including how to connect a single-session chat, is kept below that.
- package.json is prepared for a public npm release at version 0.2.4. The package name is now `@dreamforgestudiollc/emet`. It was `emet-mcp-server`. npm refused the unscoped name `emet` at publish as too similar to existing package names, so the package uses the documented scoped fallback with `"publishConfig": { "access": "public" }`. `server.json` names the same package. The command it installs is still `emet`. `@black-knight.dev/emet` is a different server that also installs a command named `emet`. Keywords match the public GitHub topics. `repository`, `homepage` (`https://dreamforgestudiollc.github.io/EMET/`), and `bugs` point at the public project. `bin` and `main` stay `src/index.js`. `engines` stays Node 20 or newer. The `files` list ships the server, the charter, templates, guides, top-level docs, the changelog, the registry manifest, and `.env.example`. It does not ship tests, scripts, `docs/status/`, backups, or `.env`.

### Fixed

- A session that boots with no unhandled drops can edit or restore the board. The empty list was not saved, so the board guard treated it as a list that had failed to load. A list that really failed to load is still refused. Retired drops stay off that list.
- A module file is opened from `fileURLToPath` and `path.resolve`. On Windows, `new URL(...).pathname` is `/C:/...`, and resolving that against a `C:` working directory produced `C:\C:\...` and the open failed.
- `.env.example` no longer assigns `TRUST_PROXY`. The server trusts exactly one proxy hop (Railway's edge) and does not read that variable.
- The example environment that ships is the public one. It listens on `127.0.0.1`, registers the generic tags `laptop,phone,cli`, and leaves `EMET_OAUTH_PASSPHRASE` commented out, so HTTP authorization stays refused until someone sets a passphrase. The pack test fails if the packed example assigns a passphrase, binds `0.0.0.0`, or names this install's source tags.

## 0.2.3 - 2026-10-07

The security fixes from the October audit, recall that ranks by how well an entry matches and keeps ended entries visible, and public wording that matches the code. Read the 0.2.3 checklist in docs/DEPLOY.md before upgrading: every host tag must be listed in `EMET_SOURCE_TAGS`, a `cloud-scheduled-` tag is refused, and an HTTP client whose token has no source tag signs in again once.

### Security

- The client-metadata fetch connects to the public address it already checked. A second DNS answer cannot move that connection onto a private, loopback, link-local, or metadata address. A redirect is still refused.
- That address check uses the parsed bits of the address. The whole link-local range `fe80::/10` is refused, including `fe90::` and `febf::`. The same check refuses loopback, private, unique-local, unspecified, multicast, IPv4-mapped and IPv4-compatible addresses, NAT64 `64:ff9b::/96`, and carrier-grade NAT. An unreachable pinned address rejects the fetch and does not crash the process.
- Every HTTP response sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and HSTS. The consent page keeps its own content security policy.
- `save_transcript` no longer reads a file path. The caller passes the exchanges, each field is capped, and the whole request is capped. The server does not read the disk for a transcript.
- An invite code, an authorization code, and a refresh token can be spent once. A second redeem does not create a second person. Inside a short grace window a repeated refresh returns the replacement already issued; any other reuse revokes that whole sign-in.
- A board edit or restore runs only when the session has a verified drop list from `emet_session_open`. An append does not open that session. No write may shrink a document below half of its largest size in the last 24 hours. That window is a floor on cuts, not a fading of memory.
- A refusal does not publish the list of source tags, and a `cloud-scheduled-` prefix is not a registered tag. Over HTTP the source tag is the one bound at approval. Stdio stamps one local subject, and the 20-drop cap is one bucket for the whole local process.
- Setup, guest invites, and member codes are the owner's. A guest invite is read-only. Opening a session, and a status check that probes the write path, need write access. The probe removes its own document and leaves the collection. An HTTP token with no scopes is not the owner. The consent page shows the scopes it is granting.
- A governed write that names a session stops when the session record cannot be read. Nothing is written.
- The client-metadata fetch refuses loopback, private, link-local, and metadata addresses, and it is rate limited. Tool rate limits are per person and client. The HTTP body limit is 256kb, and the server trusts one proxy hop.
- The consent page sends a content security policy, denies framing, and sends HSTS. Error details are not attached on HTTP, including a rate-limit response. The audit log is redacted the same way as the console.
- A token issued before source tags were stored may still write when the caller names a tag that is an exact member of `EMET_SOURCE_TAGS`. Refreshing that token is refused (`invalid_grant`): the client signs in again, and the new consent binds a registered tag. Those logins age out on their own. An empty registry has no members, so that fallback does not accept an arbitrary tag.
- The local stdio client is the owner and can create guest and member codes. Over HTTP those codes still require an owner person. A member code can carry a registered source tag, set by the owner when the code is created and bound when the code is redeemed.
- A later verified `emet_session_open` clears `drops_unverified` when the drop load succeeds, including when open drops remain. Only a failed drop load sets the flag. An open drop still has to be retired before the board is edited.

### Fixed

- Session start lists the half-finished, dated, open, undecided, and parked rows it can read (`named_items`). A section that is not a table is marked unread, including prose such as "None". Unread is not an empty list: the session still reads the document. An empty list is not a reason to skip the document. Nothing is hidden, and nothing is dropped because it is old.
- The handoff refusal names `patch_doc` for the board. Restoring the board counts as the board step.
- Recall orders matches by how many of your words appear, then by importance. Current entries come first in every order, including time order. Pass `order: 'latest'` for time order. A standalone "latest", "newest", or "most recent", together with other words, reorders those matches and does not change which rows match. "latest-budget", "not the latest", and a bare "latest" are ordinary keywords.
- An entry that has expired or been superseded stays in recall and in layer queries. It is marked with the date it ended and, when a newer entry replaced it, which one. The current entry is listed first, including when you ask for the latest or sort by time. Pass `history: true` when you need the ended entries and the current ones already fill the limit.
- Revising an entry records the end date and the new entry's id on the old one. The old entry stays readable.
- Retired documents stay in the document list and in the startup scan, after the current ones, marked with the date they were retired and what replaced them. A retired drop is listed apart from the drops that still need a decision.
- A recall or a layer query ranks matching rows in the store before it keeps a bounded window (at least 200 rows, or 20 times the page). The rank is the same as the page: current entries first, then how many words match and importance, or time when you asked for the latest. A better match is not dropped for a lower importance or an older time. A blank sort value comes first when the order is ascending and last when it is descending. A word is matched as itself, so `$gt` is that text. Capital and lower case count as the same match, including `École` and `école`. `İ` matches only itself. Full-width letters fold only with their full-width counterparts. `ẞ` and `ß` fold together. The page keeps the store's hit count, so the two do not disagree. The sort may use disk so a layer of large entries can finish.

### Changed

- The public wording now matches the code on who can join (one owner; Guest is read-only and Member is read and write; both stay off until turned on), on the drop-cap buckets, and on working documents (`retire_doc` refuses them; a rename marks the old id retired and the text stays). The charter states the monorail is enforce only, and that a templated write is checked, marked, and kept as the current revision.

### Internal

- Tests now pin the guards a mutation check left unasserted, and the MCP SDK and proxy-addr dependencies are updated.
- Session close prunes size baselines only for sessions closed or idle more than 7 days, and only those keys. A live session's baseline on a document is not touched.
- An HTTP caller with no OAuth client id is stored as http:visitor, never in a stdio bucket.
- The test suite sets the boot-list store timeout short so a missing store does not stall the run.
- The HTTP visitor check calls the HTTP tool path with no OAuth client id, and the baseline prune check leaves a document with only live or fresh baselines unwritten.
- Reviewers now have a checklist (`REVIEW.md`), and pull requests and pushes to main run the test suite with coverage (`.github/workflows/ci.yml`).

## 0.2.2 - 2026-10-04

The board is guarded, and the test store is shared.

- A session cannot wipe or overwrite the board. The server sets up a blank board, and a session can only edit it, with a reason. An added item says where it came from. A removed or closed item says why.
- No change may leave a document under half the size it had when this session first touched it. Overlapping edits and a walk-down across edits are refused. Working documents are edited, not retired.
- A board edit or restore is refused while a drop listed at that session's boot is still open. Drops are capped at 20 per caller per New York day. A drop with no source is stored as visitor.
- An owner-listed host can restore an earlier version of the board or a working document, with a reason, when the copy matches its stored hash. A record is not restored. A shipped copy is never restored.
- Every write records the person and the connected app, stamped by the server from the login, never taken from the caller.
- A read-only token can initialize and open a session. A missing board is provisioned only for a write-scoped caller, or at setup.
- The test suites share one in-memory store. No behavior change.

## 0.2.1 - 2026-10-03

Startup comes in pages that fit every host, every startup carries a `load_id`, long documents
are read in byte-sized pages, and the session-order check now refuses every skipped step, with
the way to pass in the same reply. After upgrading, each host reconnects once to see the new
arguments, then reads its startup again before opening a session.

### Added

- **Startup in pages.** `emet_initialize` now sends the startup in pages of about 18 KB
  each, so it fits hosts that cut long tool results short. The rules and instructions that
  must always be followed come first. Page 1 lists what every page carries, and each page
  names the exact call for the next one. Every page of one startup comes from the same
  snapshot, even if new memories are written in between. If the startup changes partway
  through, the server says so and you start again from page 1. `page: "all"` still returns
  the whole startup in one result for hosts with no size limit, led by its `load_id`. The page size can be set
  with `EMET_INIT_PAGE_BYTES` (12,000–19,000 bytes, default 18,000). Hosts may need to
  reconnect once to see the new `page` and `load_id` arguments. A `page` that isn't a whole
  number from 1, or `"all"`, is refused with a clear message.
- **Missing-page check when a session opens.** `emet_session_open` checks that every page
  of your startup was fetched, named by the `load_id` from your startup pages. An open with
  a page missing is refused (see Changed).
- `.env.example` now lists every setting the server reads. New entries include
  `EMET_MEMBER_ACCESS`, the page-size settings, the document-name overrides,
  `EMET_RECORD_DOCS`, `EMET_TEMPLATE_MAP`, `EMET_CIMD` and `EMET_REQUEST_LOG`.
- `CHANGELOG.md` (this file).
- **`read_doc` version pin.** Pass the `version` (or `sha256`) your first page returned as
  `expected_version` (or `expected_sha256`) with each later page. If the document changed
  in between, the read is refused with "document changed - restart from offset 0" and no
  content, so pages of two versions are never joined. The pin is optional; without it a read
  works as before. A shipped guide has no version, so pin it by `sha256`.

### Changed

- **The session-order check now refuses every skipped step.** It runs in enforce only: there
  is no report mode and no off switch, and `EMET_SESSION_GRAPH` is no longer read (remove it
  from the service's variables). A skipped step is refused before anything is written, and
  the refusal is recorded in `emet_gaps`. Every refusal says how to pass in the same reply:
  an open with no `load_id` is told to pass it from the startup pages; a missing startup page
  is named with the exact `emet_initialize` call; a skipped exchange is named with the
  `emet_transcript_append` call; a write with no session is told to open one with
  `emet_session_open` and its `load_id`; a write to a closed session is told the work belongs
  in the next session; an early handoff names each step and its tool. A session id the caller
  sent is echoed at most 64 characters, so the instruction always fits. A transcript write
  with a missing or unregistered `source` is told first to pass one, then which tags are
  accepted: the first 8 registered tags, then "+N more", and the caller's tag capped at 64
  characters, so the refusal stays under the cap with any number of registered tags. One exception stays: if
  the check cannot read the records of the session a write names, the write goes ahead and is
  recorded as `unknown`.
  Writes that name no session (for example the scheduled weekly intake) are now refused
  (gate `no_session`) until they open a session.
- The startup sends each memory layer's importance band once instead of twice, which saves
  a little space at the start of every session.
- **`read_doc` pages are now measured in bytes, as the host receives them.** A long
  document comes back in pages (was 40,000 characters). A page ends before its text, written
  as JSON (where every newline, quote and backslash costs an extra byte), plus 1,500 bytes
  kept for the rest of the result would pass the limit (default 18,000). So a page of
  quote-heavy, code-like or short-line text holds less document text than a page of prose.
  The 1,500 bytes is an allowance, not a measurement: a result whose other fields run longer
  (for example a long list of conformance failures) can still pass 18,000 bytes, and a host
  that cuts at about 20,000 bytes is not guaranteed the whole result in every case. A page
  never splits a character. `offset`, `next_offset`, `returned` and `size` in the `page`
  block are UTF-8 bytes; `returned_escaped` is the page's size as JSON, and `envelope_spare`
  is the 1,500. Following `next_offset` still gives back the whole document exactly. The
  result's whole-document `size` stays in characters; `size_unit` says so and `size_bytes`
  gives the UTF-8 bytes. `EMET_READ_DOC_PAGE` sets the limit (default 18000).
- **Startup pages say to fetch them all before opening a session.** Page 1 and every page
  that names a next call now say "Fetch all N pages before emet_session_open; an open with
  any page not fetched is refused." The line replaces the older "keep calling until a page
  says it is the last", and binding text stays where it was.
- **Missing startup pages go through the session-order check.** `emet_session_open` passes
  a `startup_pages` gate: an open with a page of its startup never fetched is refused,
  nothing is written, and the reply leads with the exact call for the first missing page and
  names the missing pages once, as ranges (`2-40`), so it fits the 500-character error cap
  however many pages are missing. A `load_id` the server has no record of (made up, expired
  60 minutes after its last page, or from before a restart) is refused too, since its pages
  cannot be checked: the reply says to call `emet_initialize {}`, fetch every page and open
  with the `load_id` it returns. After a server restart each host does that once.
  The record of fetched pages now keeps up to 2,000 loads for 60 minutes after each load's
  last page (the page cache still keeps 32 payloads for 10 minutes), so many hosts starting at
  once, or a host that opens a while after reading its startup, still open.
- **A session open must name its startup.** Pass the `load_id` from your startup pages
  (`startup_page.load_id`; every page carries it and the last page names it) to
  `emet_session_open`, so the page check runs on your own startup, never on another host's.
  It stays optional in the tool schema, but an open without it is refused before anything is
  written and told to pass it. The server no longer falls back to the latest startup it built.
- **Every startup carries a load_id, so every host can open a session.** A startup served
  whole - `page: "all"`, a startup that fits one result, and a store that is not set up yet
  (or cannot be reached, or is misconfigured) - now leads with `startup_page` (`index`, `of: 1`,
  `load_id`, `next: null`) and a `page_notice` that says to pass that `load_id` to
  `emet_session_open`. The load is recorded with every page fetched, so the open passes the
  page check. The payload after those two fields is unchanged, byte for byte, and its `load_id`
  is the same one its pages carry. The startup tests' byte-for-byte pins now compare the payload
  after pinning the two leading fields exactly. On a new store the setup flow opens a session
  with that `load_id`, appends, records the interview with `emet_setup_complete` (which never
  needs a session) and closes as usual.
- When EMET Guest Access and EMET Member Access are both off, the refusal message now
  names both and the setting that turns each one on.
- The README explains that Grok Bot teams and single-session Grok chats on the same server
  share one memory: what the bots save is there for a fresh chat to find once it
  initializes, and the reverse. A single-session chat uses that memory most reliably when the
  instruction block from `docs/BOOTSTRAP.md` is in its project instructions, or, where there is
  no such field, pasted as its first message.
- The server reports version 0.2.1.
- The README has a short "Best practices" section: split the work by what each host does
  best, with a single-session chat for long one-sitting drafting and review and bots for the
  rest. The one line you send the chat names the document that holds the task.
- The README says how to connect a single-session chat: add the server's `/mcp` URL as a
  remote MCP connector on a host that supports its OAuth sign-in, sign in with the passphrase,
  then put the `docs/BOOTSTRAP.md` block in the project instructions.
- The README's Best practices section adds eight short entries: fetch every startup page and
  open with its `load_id`; set `EMET_SOURCE_TAGS` before a second writer; put the instruction
  block in the project's instructions; standing approval for reads; reconnect after a tool-list
  change; register a bot in one change; prove the write path with `probe: true`; keep house
  style in the store.
- In the public release, the shipped `CHARTER.md` and nine base templates carry no internal
  ids; the meaning is unchanged. An install whose stored charter is the public 0.1.0 text is
  reported as differing from the shipped copy until it is rewritten with `write_doc`.
- **The startup and the docs say to open a session with the startup's `load_id`.** The
  startup's short instructions read "After every startup page, call emet_session_open with
  its load_id", and `tools_in_force` reads "emet_session_open with the startup's load_id, after
  every startup page". On a live-sized store the five pages, as received, are 17,301, 17,864,
  13,778, 14,033 and 5,560 bytes; every page stays within the 18,000-byte page budget, and a
  test checks it. The bot session loop in `docs/BOTS.md` starts with `emet_initialize {}` and
  every page it names (`{"page": "all"}` only on a host known to read long results whole) and
  opens with that `load_id`; the README, the paste-in block in `docs/BOOTSTRAP.md` and the bot
  handoff template say the same.
- `docs/DEPLOY.md`'s rollback note says what each `EMET_SESSION_GRAPH` value does on the
  older build, and `docs/ROADMAP.md` records the enforce-only monorail and paged startup as
  deployed.

### Fixed

- In `emet_gaps`, session-order results now show the source tag of memory saves and
  revisions (they showed none before), and flagged document writes now name the document.
- The README and the permissions guide now give the correct tool count: 28 tools, 12 of
  them read-only.
- The "Known gaps" entry about the scheduled weekly intake is rewritten in plain words and
  matches how such writes are handled now.
- The upstream project EMET is built from can no longer be reached at its old address.
  The credit is kept as it was, with a note that the link is unavailable.
- The README, the setup and guided-setup guides, the deploy guide and the message at the end
  of setup no longer say to set a distinct `EMET_SOURCE_TAG` per host. On a server several
  hosts share it stays unset: each host passes its own `source`, and `EMET_SOURCE_TAGS`
  registers the tags, as `.env.example` already said. A default tag is only for a server one
  host uses.
- `emet_session_close` takes `source`, and the close is never refused for it. The close is
  attributed only to a registered tag that wrote the session (the `source` passed, else the
  server's default tag); otherwise it warns and says why: no tag, a tag not registered in
  `EMET_SOURCE_TAGS`, or a tag that did not write the session. The tag is echoed capped at
  whole characters. It used to warn on every close on a server with no default tag, even when
  the host passed a registered tag of its own.
- The bot handoff template's session loop now says to fetch every startup page, with
  `{"page": "all"}` only on a host known to read long results whole, as `docs/BOTS.md` does.
- The setup interview's note for a store that is already initialized now says a second
  `emet_setup_complete` is refused unless `reissue: true` is passed. It said a re-run would
  create a new version.

### Security

- Updated three dependencies to patch releases that fix moderate advisories: `fast-uri`
  3.1.8, `hono` 4.13.12 and `ip-address` 10.7.3. No direct dependency changed.
- New tests confirm that a code is refused before any lookup when both access doors are
  off, that the owner's sign-in still refreshes, and that a database outage is reported
  as a server error (500), not as a bad sign-in.

## 0.1.0 - 2026-10-02

The first public release.

### Added

- **A shared memory server for MCP.** One store in MongoDB (Atlas or self-hosted) that
  several hosts can read and write: desktop and command-line apps, browser and phone
  clients, and assistants from other vendors.
- **Six memory layers and a word-for-word transcript tier.** Curated memories and the
  conversations behind them are kept apart, so neither can quietly overwrite the other.
- **Every write is checked.** Each write is read back and compared before it is reported
  as saved. Each memory carries a content digest (and a signature, when a signing key is
  set), and each layer forms a hash chain that `emet_gaps` can walk end to end.
- **Corrections without deletion.** Memories and transcripts are corrected by superseding
  them, never by editing or deleting them. Documents can be changed, but every earlier
  version is kept in their history, and they are retired rather than deleted.
- **A versioned document store** with templates, a conformance check and a full revision
  history.
- **Session start and close.** One call to `emet_initialize` gives the assistant everything
  it needs at the start; `emet_session_open` starts the transcript. Closing a session
  requires receipts for each record it was supposed to update.
- **A session-order check** that watches the order of a session's writes. It ships in
  report mode: it flags what it would refuse and blocks nothing.
- **Local or remote.** The same code runs as a local stdio server or as a remote HTTP
  server with OAuth sign-in, protected by a passphrase you choose.
- **Two optional access doors, both off by default.** EMET Guest Access gives a second
  person read access; EMET Member Access gives a new person read and write access, never
  the owner's identity. Each person's sign-in only refreshes while its own door is on.
- **Source tags.** Every write records which host made it. Registering the allowed tags
  with `EMET_SOURCE_TAGS` turns on the guards against unknown or mistyped tags.
- **Least-privilege database access.** A script and guide for a database role that can add
  and update records but never delete them.
- **Secrets masked before storage.** Common secrets such as API keys, tokens and
  passwords in connection strings are masked in content before it is saved.
- **Clear sign-in errors.** An expired, revoked, replaced or unknown sign-in is answered as
  a sign-in problem (401 or 400) that tells the app to sign in again, not as a server error.
- 28 tools, 12 of them read-only, each labelled with standard MCP hints so a host can tell
  reads from writes (and, if it chooses, skip approval for reads).
