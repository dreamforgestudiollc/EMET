# EMET TEMPLATE STANDARD

**Template control:** id `templates/STANDARD.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-11 · a decision record · owner: EMET (base) · decision record: the owner's
**Governs:** every base template shipped with EMET, every extension an install adds to one, and every new template an install creates.

---

## 1. PURPOSE

A template is a control. It puts the answer in front of whoever fills it before the moment a field could be skipped. This standard exists so that anything added beyond the shipped base is built the same way, without a review gate. **The standard is the control.**

## 2. TERMS

- **Base template** — ships with EMET. Its required sections are fixed.
- **Extension** — a section or field an install adds to a base template.
- **Local template** — a new template an install creates for a document type the base does not cover.
- **Record** — a document filled from a template. HANDOFF, the board, a thread, a seed.
- **User** — the person the install serves. **Assistant** — the model working through EMET.

## 3. RULES FOR BASE TEMPLATES

1. **Must be followed.** Every required section appears, in order, in every record.
2. **An install may not** remove, rename, reorder, merge, or make optional any required section or field.
3. **An install may expand** — add sections, add fields, or make an optional field required. **Tighten, never loosen.**
4. **Extensions sit after the required sections they relate to** and are marked `[EXTENSION — <install>]` so a reader can always tell base from local.
5. A base template changes only by an EMET release. An install that needs a base change proposes it upstream; it does not patch its copy.

## 4. RULES FOR NEW TEMPLATES (local)

A local template is valid only if it carries all of the following:

1. **Template control block** (§6).
2. **The recorded failure it prevents** — a specific incident or entry, not a general benefit. **No named failure, no template.**
3. **Its required sections, in priority order** — most consequential first.
4. **The completion rules** (§5), unmodified. A local template may add rules; it may not relax these.
5. **Plain naming** — the file name says what the document is.

## 5. COMPLETION RULES — apply to every record from every template

1. **Every required section appears.** Nothing is omitted because it seems empty.
2. **Every field is answered.** "None" is valid. A blank is not. "N/A" carries a one-line reason.
3. **Every "none / nothing / clear" states its scope** — what was checked, against what. An unscoped negative is a nonconformance.
4. **Carried items are carried, not rebuilt.** Where a template carries a list forward, an item leaves only with a written disposition and its evidence.
5. **A section that could not be completed says so:** `NOT COMPLETED — <reason>`. An honest gap conforms; a silent one does not.

## 6. CONTROL BLOCKS

**Every template opens with a template control block:**
template id · revision · status (DRAFT / IN FORCE / RETIRED) · **approved** (who · date · decision record — required before status can be IN FORCE; ISO 13485 §4.2.4 and ISO 9001 §7.5.2, review and approval before issue; added 2026-09-11, architecture pass) · owner (EMET or the install) · failure it prevents · supersedes

**Every record opens with a record control block:**
template id and revision used · record revision · session id · source tag · written (local date and time) · scope of the session or author, one line

## 7. CHANGE CONTROL

- Templates and records are revised through the versioned document store: each revision archives the prior copy.
- **Nothing is deleted.** A template no longer used is marked RETIRED; its content is retained.
- A record is corrected by a later revision or a later record, never by rewriting what earlier revisions said.

## 8. WHAT THIS STANDARD DOES NOT DO

- It does not claim conformity with any external standard. It puts document control into practice.
- It does not restate rules held in server code (the floor, the layer charter, the write path). It points to them.

---

## 9. VALIDATION — NOT OPTIONAL (the user, 2026-09-10)

*"There needs to be a document template validation tool that isn't optional either freestanding or incorporated into established regular processes."*

**Every record from a templated document type is validated against its template. No caller can skip it.**

**Design — priced 2026-09-10; v1 scope APPROVED by the user 2026-09-11; not yet built. Build detail and limits are kept in the owner's store.**
- **Where it cannot be skipped:** the write path. Every document write already passes one door (redaction, digests, read-back, receipt). Validation runs there on every write to a templated type.
- **Which documents are templated:** by the record control block's template id, **and** by a document-id map (`HANDOFF.md` → HANDOFF, `STATE.md` → BOARD, `seeds/*` → SEED, `threads/*` → THREAD, `staging/*` → STAGING, `procedures/*` → PROCEDURE …). The map means leaving out the control block cannot evade validation.
- **Where it is also visible:** the write receipt carries the verdict; reads carry it per document (as integrity is carried today); session start counts nonconforming documents (as record gaps are counted today).
- **Freestanding use:** the same check callable on demand — to audit existing records, migrate old ones, and check a new local template against this standard.

**What v1 checks (approved scope):** control block present · a template set IN FORCE carries its approval (who · date · record) · every required section present and in order · no empty required section · no unfilled template placeholder left in the record · `NOT COMPLETED` carries a reason · a template's own checks where it names them (the BOARD's counts must match its rows) · **carry-forward — every item on the previous revision's list is still present or carries a disposition row.** The prior revision is already archived, so this is a comparison, not a judgment. (This check alone would have caught the two board items that were dropped.)

**What a machine cannot fully check:** whether a "none" states its scope honestly, or whether an answer is true. Those remain the author's and the reader's. The tool checks form and continuity, not truth.

**DECIDED — the user, 2026-09-10 (a decision record): *"Mark for audit and review."*** A nonconforming write is **not rejected.** It lands, carries a visible nonconformance marker listing what failed, and stays counted and surfaced at session start until it is **reviewed and dispositioned** — either **corrected** by a later revision (which clears the marker by passing), or **accepted** with a written reason recorded on the document. A marker is never cleared silently.

### 9a. LOCKS — nothing may weaken a template's function (the user, 2026-09-11: *"lock it down and reduce opportunities to weaken it's function as a template"*)

Each lock names the weakening it prevents. L1 is the user's decision; L2–L6 are the assistant's design under his direction, included in v1 scope. **L4 and L5 confirmed by the user 2026-09-11** after the architecture pass flagged them as preventing evasions no one had attempted — kept on a small footprint: *"either way by function or fault they provide something vs nothing by their exclusion."*

- **L1 — The shipped copy governs base templates.** Required sections **and status** are read from the copy that ships with the release, never from the store copy. A store copy missing a shipped section, or stating a different status, is itself marked nonconforming. *Prevents:* loosening a template by editing the store copy; switching validation off by flipping a template to DRAFT or RETIRED. **The same lock applies to `CHARTER.md`** — stated in the charter's §9.
- **L2 — No off switch.** No setting, environment variable or tool argument disables validation or exempts a document. *Prevents:* "not optional" becoming optional by configuration.
- **L3 — The map only tightens.** Settings may add document-to-template mappings; they may not remove or redirect a base mapping. The board and handoff mappings follow the same settings that session start and session close use, so the document startup reads is always the document that is validated. *Prevents:* unmapping the board, or moving it to an id nothing checks.
- **L4 — A declared template adds, never replaces.** If a record's control block names a different template than the map, the record is validated against both and the disagreement is a warning. *Prevents:* declaring a weaker local template to evade the base.
- **L5 — Rename and retire do not escape.** Renaming a mapped document to an unmapped id marks the renamed document; retiring a base template's store copy is marked. *Prevents:* validation evaded by moving or retiring the thing it checks.
- **L6 — An acceptance covers one revision.** `accept_nonconformance` applies only to the revision it names; the next revision is validated fresh. Accepted markers stay counted at session start, separately from open ones. *Prevents:* one acceptance becoming a standing waiver, or hiding the marker.

## OPEN — to be priced, not assumed
- **How base templates ship — DECIDED 2026-09-11 (the user):** the repository carries the base templates and the setup interview writes them into each new store. The only shape in which a stranger's install gets templates at all.
- **Where local templates live** in an install's store — still open.
- **Base-template drift in the store — DECIDED 2026-09-11 (the user): the shipped copy governs.** Now lock L1 in §9a.
