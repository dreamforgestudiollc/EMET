# EMET 0.3.9

EMET is an MCP server for document control (ISO 9001 7.5.3 / ISO 13485 4.2.5): persistent shared memory for AI agents, bot teams, and chats. Version 0.3.9. EMET holds no certification and claims no conformity. The stored document shapes are not frozen. Pin a version if you depend on them. Stored rows are not rewritten. No new setting is required. This revision is not published from this file. See [CHANGELOG.md](CHANGELOG.md).

## What 0.3.9 changes

0.3.9 is a docs and release-checklist revision. First-timer pages, the GitHub Pages site, and the in-repo release notes now describe the current behavior: the admin password versus the connect passphrase, key sign-in (`EMET-AUTH-046`; `EMET-AUTH-045` keeps its published meaning), read integrity (`EMET-DOC-089`), owner-approved condense (`condense_approved`, `EMET-DOC-025`, `EMET-DOC-090`), staged writes, the machine-line gate (`EMET-MEM-018`), `carry_forward`, and continuity. `docs/RELEASING.md` is the content-audit checklist for every public revision. `tests/release-content-audit.test.js` is the automated check.

The connect passphrase stays on the connect page. The admin password, set at `/owner/admin-password`, opens the chooser, grants, break-glass, and settings. A bot, a member, or a guest signs in with an issued key and source tag, never the owner password or the admin password.
