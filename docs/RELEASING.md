# Releasing EMET

A version-string bump is not a complete release. Every public revision, including a docs-only follow-up, has to describe the **current** behavior a first-time visitor will meet, not only the items that changed in that revision. Gaps left by earlier 0.3.x releases are in scope.

This file is the checklist. `tests/release-content-audit.test.js` fails the build when a required surface is missing, when a first-timer path still teaches a retired secret flow, or when a current behavior listed below is absent from the first-timer pages.

Do not put owner names, private host names, private repository names, or live credentials in this repository.

## Surfaces to audit by content

Check each surface against the behavior in this tree, not against a marketing summary. Open the live or built page where one exists.

| Surface | Where |
|---|---|
| GitHub Pages site as a first-time visitor | `site/index.html` tabs: What, Hosts, Access, Record, Start. Walk Start and Access without opening "What this version changed." |
| README first-timer path | `README.md`: What it does, Document control, Start here, Install, First run, Every session after that |
| Setup walkthrough | `docs/SETUP.md` |
| Deploy walkthrough | `docs/DEPLOY.md` |
| Guided setup | `docs/GUIDED-SETUP.md` |
| Roadmap (shipped vs upcoming) | `docs/ROADMAP.md` |
| Bots, sub-keys, permissions, console | `docs/BOTS.md`, `docs/SUBKEYS.md`, `docs/PERMISSIONS.md`, `docs/CONSOLE.md` |
| Feature topic pages | `docs/features/` |
| Error code table | `docs/ERROR-CODES.md` |
| Changelog | `CHANGELOG.md` |
| In-repo release notes for this version | `RELEASE_NOTES-<version>.md` |
| GitHub release notes | the published release for the tag |
| npm package README and `package.json` description | same `README.md`; description must keep the ISO lead. A wording change here reaches npm only on the next publish, so keep it in agreement with the published listing until then. The published 0.3.8 listing still has an em dash after the version name; fix that dash on the next publish. |
| MCP Registry / `server.json` description | the ISO lead only; do not stuff a feature list into that short field |
| Site sitemap date | `site/sitemap.xml` `lastmod` |

## Current behavior the first-timer path must describe

These already ship in 0.3.8. A first-time reader of Start, Access, the README first-run sections, Setup, Deploy, and Guided setup has to be able to complete a first run without reading the changelog.

1. **ISO document control.** Lead with ISO 9001 7.5.3 / ISO 13485 4.2.5. EMET holds no certification and claims no conformity.
2. **Two HTTP secrets.** Set the admin password at `/owner/admin-password` after the server is up. Creating it requires the connect passphrase, an owner Authorize token, or an owner session. Without one of those, the server returns 401 and writes nothing. If the password is already set, the server returns 409 and writes nothing. An unset `EMET_OAUTH_PASSPHRASE` is not proof and does not mint recovery codes. The connect passphrase stays on the connect page. The admin password opens the chooser, grants, break-glass, and settings.
3. **Connect a client.** Add `https://<host>/mcp` and complete OAuth on the connect page with the connect passphrase, or with a member or guest code when that door is on.
4. **First session.** Say "initialize." The interview is recorded with `emet_setup_complete`, which creates the owner person.
5. **Bots and other keys.** A bot, member, or guest signs in with an issued key and the source tag on that key. It never uses the owner password or the admin password. A refused key sign-in is `EMET-AUTH-046`. `EMET-AUTH-045` stays the refusal for the previous bound-door spelling.
6. **Source tags.** Set `EMET_SOURCE_TAGS` before more than one host or bot writes. Over HTTP, writes use the tag bound at approval.
7. **Staged document writes.** Long revisions use `write_doc_begin`, `write_doc_append`, `write_doc_commit`, and `write_doc_abort`.
8. **Read integrity.** `read_doc` reports whether the stored body matches its digest. `restore_doc` refuses the revision already in force (`EMET-DOC-089`).
9. **Owner-approved condense.** A shorter revision under half size needs `condense_approved` and a reason, or a writer approval that names that document. The default refusal is `EMET-DOC-025`. A missing reason, or an approval for another document, is `EMET-DOC-090`. The prior revision stays. `EMET-DOC-026` is a different rule (half of the daily peak).
10. **Machine-line gate.** The first successful transcript append carries the measured machine line, or the words `no local shell MCP`. A refusal is `EMET-MEM-018`.
11. **`carry_forward`.** `emet_session_close` takes `carry_forward` when a later session already advanced HANDOFF or STATE.
12. **Continuity.** Per-tag handoffs (`EMET_TAG_HANDOFFS`) and continuity currency (`EMET_CONTINUITY_CURRENCY`) ship off unless the owner turns them on.

Do not document a later private change as if it were in this public tree. In particular, do not describe a first-run setup token or a first-run register gate unless this tree actually contains them.

## Retired claims that must not be taught

These were true of earlier 0.3.x flows and are wrong now:

- The connect passphrase is the whole perimeter, or there is no second factor.
- The chooser, grants, or break-glass use the same passphrase as the connect page.
- A bot signs in with the owner password or the admin password.

Historical "What 0.3.x changed" sections may name an older release. They must not be the only place a current behavior is described, and they must not contradict current behavior if a first-timer could take them as instructions.

## Checklist for each public revision

1. Confirm the code in the tag actually does what the notes will say.
2. Walk the GitHub Pages site and the README as a person who has never heard of EMET: what it is, who it is for, install, first-run setup, first session, first bot. Every step must match this tree.
3. Audit every surface in the table above against the current feature set, including behavior that shipped in earlier 0.3.x releases and may have been missed then.
4. Fix every gap in one docs-only pull request. Use the technical-writing standard in this repository. Do not use em dashes or en dashes in new or edited sentences. Historical dashed lines still in the tree are listed exactly in `tests/fixtures/legacy-dash-lines.json`. That list only shrinks. The content-audit test uses that file, not git.
5. Keep owner identifiers out of the public tree.
6. Add or update `RELEASE_NOTES-<version>.md` so it matches the GitHub release notes and the behavior you just audited.
7. Point `site/sitemap.xml` `lastmod` at the release date.
8. Update the roadmap's "where things stand" and its status date when the shipped set changes. Update any test that pins that date in the same change.
9. Get an independent review of the docs pull request and wait for a passing review before merging.
10. After merge, confirm the live site, the npm README (once the package is published), the Registry description, and the GitHub release notes. A docs-only follow-up does not require a version bump by itself; a description change in `package.json` or `server.json` reaches npm or the Registry only on the next publish.
11. Record the release, the audit, and the page-by-page report in the operator memory store.

## The automated check

`tests/release-content-audit.test.js` is discovered by `tests/run-all-tests.js`. It is necessary and not sufficient. A wording change can still be wrong even if the phrases it looks for are present. The first-timer walk and the independent review remain required.
