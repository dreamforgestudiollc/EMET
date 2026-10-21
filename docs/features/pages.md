# Topic pages

A topic page is a view computed when you ask. It is not a record, it is not stored, and `recall` does not return it. `emet_pages` lists the current area documents. `emet_page` builds one page. `emet_page_lint` flags problems and writes nothing. The owner writes the selector as `areas/<slug>.md`.

## Sub-features

- pages-list: `emet_pages` returns a line count, a stale count, and the newest source time for each area.
- pages-read: `emet_page` cites every displayed line. A line with no source is dropped.
- pages-lint: `emet_page_lint` reports contradictions, broken links, and stale lines. A fix is a person's edit, not this tool.

## How to get to it (user POV)

The owner writes `areas/<slug>.md` with `write_doc`, filled from the area template: layers, tags, keywords, document prefixes, source clients, a staleness window, and a cap. Then `emet_pages` to see the areas, and `emet_page` with that slug to read the view. `emet_page_lint` with the same slug, or with no area, to see findings. Only the owner can read a page.

## Driving it with verify-emet

```
npm run verify -- feature pages
npm run verify -- run emet_pages emet_page emet_page_lint
```

The drive writes `areas/verify.md` first, then lists, reads, and lints it. The page body is not written back.

## Gotchas

- There is no page until an area document exists. The error tells you to write `areas/<slug>.md`.
- A local session is the owner. A remote login must be the owner person.
- Lint does not revise, retire, or accept anything. Those stay separate tools.
