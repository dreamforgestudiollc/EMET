# TEMPLATE — AREA

**Template control:** id `templates/AREA.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-10-20 · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `areas/<slug>.md` — the selector for one compiled topic page.
**Failure it prevents:** a topic page stored as a record, so a view computed from the memory database became a second source of truth (the owner, 2026-10-20). The page body is never written here.
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **This document is a selector.** It names what to look at: layers, tags, keywords, document prefixes, an optional client list, a staleness window, and a cap. It does not state what is true.
2. **The page is computed** by `emet_page` on each request. It is not cached and it is not written back into this document or into any layer.
3. **Only the owner's login** creates or edits an area document: a local (stdio) session, or a remote login whose person has the owner role. Other logins, including Member and Guest, cannot. In practice the owner's AI clients make the entries; the server does not tell a bot from a person.
4. **Staleness days** defaults to 30 when a record leaves it blank. An area may set its own window.
5. **Source clients** `any` reads every client. A list limits the page to those attribution tags.

---

## §0 RECORD CONTROL
- Template: `templates/AREA.md` · Area revision: the store's version governs
- Slug: __
- Title: __

## §1 SELECTOR
- **Layers:** __
- **Tags:** __
- **Keywords:** __
- **Doc id prefixes:** __
- **Source clients:** __
- **Staleness days:** __
- **Item cap:** __

## §2 SCOPE
One line naming what the selector looks at. Not a claim of current fact.
