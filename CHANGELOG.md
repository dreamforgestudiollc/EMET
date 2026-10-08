# Changelog

All notable changes to EMET are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/). EMET is still 0.x: the stored data shapes may
change before 1.0.

## Unreleased

### Added

- A static website in `site/`, for search, and a GitHub Actions workflow that publishes that folder to GitHub Pages on pushes to `main`.
- The README records the origin in the same words as the site: EMET was built by Dreamforge Studio LLC from a neurodivergent user’s own need for an AI assistant that remembers. The word coined for that is neurendipity: neurodivergent and serendipity.

### Changed

- The README now opens with the search line and a short account of what EMET does, in the same words as the website: an MCP (Model Context Protocol) memory server, persistent shared memory for AI agents, bot teams and chats. The previous opening paragraph, including how to connect a single-session chat, is kept below that.

### Fixed

- A module file is opened from `fileURLToPath` and `path.resolve`. On Windows, `new URL(...).pathname` is `/C:/...`, and resolving that against a `C:` working directory produced `C:\C:\...` and the open failed.
- `.env.example` no longer assigns `TRUST_PROXY`. The server trusts exactly one proxy hop (Railway's edge) and does not read that variable.

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

There is no 0.2.0 release: 0.2.1 follows 0.1.0 directly, so this entry lists every change
since 0.1.0.

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
