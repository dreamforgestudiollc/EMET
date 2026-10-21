# Startup

The first thing a session does. `emet_initialize` is the only setup step a person has to know by name. A new store answers with a short interview. `emet_setup_complete` records those answers. `emet_status` says whether the store is reachable and, when asked, proves the write path.

## Sub-features

- startup-interview: `emet_initialize` on a new store returns the questions and writes nothing.
- startup-pages: a large startup comes back in pages. Read every page before relying on it. `page` `"all"` returns the whole startup in one result.
- startup-complete: `emet_setup_complete` writes the identity documents and the owner. A second run is refused unless `reissue` is true.
- startup-status: `emet_status` reports the store. `probe: true` writes a document, reads it back, and removes that document only.

## How to get to it (user POV)

Open a session and call `emet_initialize` with no arguments before you answer from memory. If the result says setup is required, ask the interview questions and pass the answers to `emet_setup_complete`. Call `emet_initialize` again and follow `page_notice` until the last page. Keep `startup_page.load_id`. Later, `emet_status` is the check that the store is up. Use the probe after a configuration change, not on every turn.

## Driving it with verify-emet

```
npm run verify -- feature startup
npm run verify -- run emet_initialize emet_setup_complete emet_status
```

The standalone run uses the in-memory test database. `emet_setup_complete` replaces identity documents, so `--dry-run` skips it and names the call it would have made. The status probe is skipped for the same reason.

## Gotchas

- An open without `load_id`, or with a page of that startup never fetched, is refused. Call `emet_initialize` again and read every page.
- Re-running setup on a store that is already set up is refused until the owner passes `reissue: true`.
- `probe: true` removes only the probe document. It is not a general delete.
