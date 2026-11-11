# EMET 0.3.6

Historical note: these are the notes for 0.3.6. This revision is not published from this file. The 0.3.5 package on npm was published before this cleanup. See [CHANGELOG.md](CHANGELOG.md).

EMET is an MCP memory server: persistent shared memory for AI agents, bot teams, and chats. Version 0.3.6. The stored document shapes are not frozen. Pin a version if you depend on them. Stored data shapes are unchanged from 0.3.5. Tool behavior is unchanged.

EMET holds no certification and claims no conformity. The document-control wording is unchanged: ISO 9001 7.5.3 / ISO 13485 4.2.5. EMET stays one shared server with verified per-client attribution. It is not a generic memory server, and it is not forked per client.

## Roadmap

[docs/ROADMAP.md](docs/ROADMAP.md) is the public list of what ships and what does not. Upcoming work is labeled Proposed, Planned, or Later phase. Nothing in that section is built unless it says so.

Proposed, and not built: a Workshop Village MCP server for bot-team collaboration, built onto EMET or independent of it, and shared project drawers for files handed off between bot teams. An organization may later designate a shared network drive as the drawer store. That choice is not decided, and it is not approved to build.

Planned, and not in this public release: per-source-tag handoffs, where each writing AI writes only its own handoff and a shared view is computed on read. A private build has that shape behind a flag. The flag is not in this release. Also planned: continuity-currency enforcement so initialize cannot run on a stale handoff or board when a newer record exists; backup and restore verification runbooks (the clone-instance recipe is already documented); stronger source-tag onboarding and further per-door extensions (the extension socket itself is built); currency and lock levels on topic pages (the 0.3.0 topic views already ship); and transcript query and read-tool validation improvements.

Later phase, and not built: fuller multi-person use of the one server, beyond the member and guest doors that already ship.

Discussion is in [GitHub issues](https://github.com/dreamforgestudiollc/EMET/issues).

## Public wording

Source comments, log lines, and a test host no longer spell an install-specific retired account or a live private host. The retirement check still matches that account by digest. The GEM standard a reviewer can read is `gem-library/` in this repository. It is Draft. A public submission repository for outside GEMs does not exist yet. `EMET-AUTH-045` is also refused on a break-glass reissue. The npm package includes these release notes, `SECURITY.md`, and `CONTRIBUTING.md`.

## Record

Nothing is deleted, on any store, by design. A memory entry is superseded by a new revision. A document is revised or retired, and retired means obsolete, not gone. Prior versions stay.

Every write is read back and compared before it is reported as saved.
