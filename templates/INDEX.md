# EMET CONTROLLED DOCUMENT LIBRARY — REGISTER

**Status:** **ADOPTED by the user 2026-09-11** (*"Yes I do"*; a decision record). **IN FORCE with the repository commit**, because the shipped copy governs (`templates/STANDARD.md` §9a L1; `CHARTER.md` §9). Revision: the store's version governs. Decision records (kept in the owner's store): scope, latitude, validation not optional (mark for audit and review); review of 2026-09-11: validation v1 and shipping, locks, close order, charter lock, seed statuses and triggers.
**Written:** 2026-09-10. **Brought current** 2026-09-11, session `2026-09-11_morning-mobile-init`, source `mobile`, after the user's full review of the set. **This revision also removes install-specific names** — the reference install's orchestrator, private documents, named employers, machine paths and seed names — under the scope rule that shipped forms are generic. The reference install's own records keep them.

---

## RULES FOR THIS LIBRARY

1. **A template earns its place by naming the recorded failure it prevents.** No named failure, no template. (Over-engineering is an acceptance criterion.)
2. **State a rule once.** Rules already held in server code (the floor, the layer charter, the write-path door) are pointed to, never copied into a document.
3. **Templates are controlled documents; filled documents are records.** A template changes by revision (versioned, prior copy archived, never deleted). A record is corrected by a later record, never by rewriting history.
4. **No implied conformity** (a decision record). This library puts document control into practice; it does not claim certification against any standard.
5. **Revision numbers are the store's.** A control line says "the store's version governs" rather than carrying its own number — a hand-kept number drifts (it did: one template's line said v1 at store v6).

---

## DOCUMENT HIERARCHY — four tiers

| Tier | Role | Holds |
|---|---|---|
| **1 — Charter** | What EMET is, what it is for, how it is structured, how information flows, how documents are controlled | `CHARTER.md` — DRAFT; locked like the base templates: ships with the release, a store copy is not authoritative, and it is present before any first-run interview |
| **2 — Procedures** | How a session runs, start to close | The floor, layer charter, startup instructions and close protocol — in server code, pointed to. The close order is stated once, in `CHARTER.md` §6. An install may add its own orchestrator; it points here and restates nothing |
| **3 — Work instructions and reference** | How to do a specific thing | `procedures/*` (PROCEDURE template) · an install's own reference and debug documents |
| **4 — Forms and records** | Templates (forms) and the documents filled from them (records) | `templates/*` → `HANDOFF.md`, `STATE.md`, `threads/*`, `seeds/*`, `staging/*`, `procedures/*` · layer entries and transcripts (structure enforced by code) |

---

## REGISTER

Every document listed under **Fills** is validated against its template by its id (`templates/STANDARD.md` §9 map); leaving out the control block does not exempt it (§9a L4).

| Template | Fills | Failure it prevents (recorded) | Status |
|---|---|---|---|
| `templates/STANDARD.md` | Governs every template | Anything added beyond the base built without a common control; a validator that an install could configure, remap or edit into weakness | DRAFT — reviewed 2026-09-11. Validation §9, locks L1–L6 §9a |
| `templates/HANDOFF.md` | `HANDOFF.md` | An unscoped "nothing pending" relayed as board-wide; items dropped from the chain with no decision; stale priorities from a handoff written from memory; a handoff whose first action was "open by asking"; a handoff attesting to saves not yet made | DRAFT — reviewed 2026-09-11 (written last, in one write). In trial use since 2026-09-10 |
| `templates/BOARD.md` | `STATE.md` | Stacked addenda with superseded lines above current ones; two open actions dropped with no disposition; counts restated instead of items named; a dated section migrated instead of rebuilt, missing three calendar items; a passed date closed on an assumed outcome | DRAFT — reviewed 2026-09-11 (rule 5). In trial use since 2026-09-10 |
| `templates/SEED.md` | `seeds/*` | A met trigger unsurfaced for weeks; triggers naming an event nobody scheduled; executed seeds still read as live; a paused seed indistinguishable from one that never fired | DRAFT — reviewed 2026-09-11. Triggers `DATE` · `ROW` · `SIGNAL` · `TOPIC`; statuses `DORMANT` · `MET` · `SHELVED` · `ACTED ON` |
| `templates/THREAD.md` | `threads/*` | Threads grown past 140 KB with the current state buried under history; a priority list still telling the user to submit an application already submitted | DRAFT — reviewed 2026-09-11. §1 replaced, not appended; 64 KB log split (a chosen limit, not measured) |
| `templates/STAGING.md` | `staging/*` | An assistant-authored proposal read as a decision; drafts with no visible status; a staging document escaping validation by omission | DRAFT — reviewed 2026-09-11. Status line says who decided; `IN USE` for documents the user works from |
| `templates/PROCEDURE.md` | `procedures/*` | Recorded paths and commands going stale unverified — an interpreter path that no longer existed; a deploy command naming the project instead of the service | DRAFT — reviewed 2026-09-11. Every step dated and machine-named |
| `templates/IDENTITY.md` | `bootstrap/IDENTITY.md` | No standing form for the assistant's name and phrase; each install invented a different shape | IN FORCE 2026-09-26 · a decision record |
| `templates/CHARACTER.md` | `bootstrap/CHARACTER.md` (also SOUL, PERSONALITY) | A store that boots flattened, or a personality document with no standing sections | IN FORCE 2026-09-26 · a decision record |
| `templates/USER.md` | `bootstrap/USER.md` | A store that relearns the person's name and preferences every session | IN FORCE 2026-09-26 · a decision record |
| `templates/INSTALL.md` | `bootstrap/INSTALL.md` | A paste-block start that cannot check a machine or tag a write | IN FORCE 2026-09-26 · a decision record |
| `templates/BOTHANDOFF.md` | `bots/<tag>/HANDOFF.md` (unmapped while DRAFT) | A bot that could close only by writing the user's own handoff and board; scheduled bot runs citing sessions never opened (episodic records); bot handoffs marked nonconforming against a template that demands a board | DRAFT — requested by the user 2026-10-01; approval and decision record pending. Supersede-only after revision 1 (`EMET_RECORD_DOCS`) |
| `templates/ROSTER.md` | `bots/ROSTER.md` (unmapped while DRAFT) | A bot tag the server did not treat as a bot because its handoff id was never listed (a live check of per-bot close records, 2026-10-01); the hub's tag at risk of being listed with the bots | DRAFT — requested by the user 2026-10-01; approval and decision record pending. The hub is listed apart and never in `EMET_RECORD_DOCS` |

**Deliberately NOT templated:** an install's own orchestrator (a single document, not a type) · layer entries and transcripts (structure already enforced by the write-path door) · an install's private reference documents that have their own convention and no recorded failure.

**Bootstrap templates (2026-09-26):** `templates/IDENTITY.md`, `templates/CHARACTER.md`, `templates/USER.md`, `templates/INSTALL.md` — IN FORCE (user: "Go ahead"). They are the empty structure the interview fills. An install's existing bootstrap *records* are revised only to meet the template's form, with no loss of original content (user, 2026-09-11 and 2026-09-26).

---

## BUILD ORDER

0. ~~STANDARD~~ — written 2026-09-10.
1. ~~HANDOFF + BOARD~~ — written 2026-09-10; in trial use.
2. ~~CHARTER~~ — written 2026-09-10; §1 intended use awaits the user's words.
3. ~~SEED + THREAD~~ — written 2026-09-10 evening.
4. ~~STAGING + PROCEDURE~~ — written 2026-09-10 evening.
5. ~~Migrate the position document into the BOARD form~~ — done 2026-09-10.
6. ~~Review of the full set with the user~~ — done 2026-09-11.
7. **Validation v1** — DECIDED 2026-09-11: the priced scope plus locks L1–L6. Not built — bridged session.
8. **Repository commit** — the charter and templates ship in the release; the set becomes IN FORCE with it.

## LATITUDE — DECIDED (user, 2026-09-10; a decision record)
*"They must be followed but can be expanded and there can be a generic template standard guidlines for anything added above and beyond will be created within those guidelines."* Base templates: required sections fixed; installs may expand, never loosen. Anything beyond the base is built to `templates/STANDARD.md`.

## SCOPE — DECIDED (user, 2026-09-10; a decision record)
**Product-level.** *"This will be built and baked into the EMET repo as the standard base form/floor state to move forward to public use by others."*
- The charter and every template ship in the EMET repo as the base every install starts from. **The reference install is the first user, not the scope.**
- **Shipped forms are generic:** "user" and "assistant", never a named person or assistant. Install-specific content lives in the install's own records, never in a template or this register.
- **Shipping — DECIDED 2026-09-11:** the repository carries the base templates and the setup interview writes them into each new store.
- Repo-facing text states current state only while the repo is private (a decision record).
- ⚠ **The charter and this register become public, so the undrawn disclosure line (a decision record) bears on how much architecture they state.**

## OPEN — the user's
- **Adoption — DECIDED 2026-09-11** (a decision record). IN FORCE with the repository commit.
- **Where local templates live** in an install's store.
- **Intended-use statement** for the charter.
- **The disclosure line** — before the repository goes public.
