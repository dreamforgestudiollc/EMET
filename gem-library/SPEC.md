# Golem Expertise Module (GEM) specification

**Revision:** 2026-10-12
**Status:** Draft
**Home:** [EMET-GEMs](https://github.com/dreamforgestudiollc/EMET-GEMs) (private). The copy in an EMET server checkout at `gem-library/` is the text under review until it is moved.

This revision stays Draft until the Neurendipity GEM has passed the conformance checks in an EMET release and the core-floor move in [GEP-0001](proposals/GEP-0001-core-floor-and-neurendipity-gem.md) has shipped. Alex may then mark it Current. A later breaking revision gets a new date. A clarification that does not break a valid manifest does not change the date.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in BCP 14 [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals, as shown here.

The JSON Schema [gem.schema.json](gem.schema.json) is normative for the manifest's shape. This text is normative for behavior. If they disagree, the schema wins on shape and this text wins on behavior, and the disagreement is a defect to fix in the same revision.

## 1. Terms

**EMET** is a memory server. Its function is the record: what was written, what was decided, and what still stands. It is not a behavior framework.

**Core floor.** The lines every install serves and nobody can switch off: integrity, honesty, no sycophancy, truth over speculation, fact-checking, and persistence. They ship in server code. Setup cannot write them.

**Socket.** The seat where a GEM is mounted. The word means that seat only. It does not mean a host connector or a network socket.

**Golem Expertise Module (GEM).** A folder of engagement lines and guides that seats in the socket. The name marks the golem legend: the word *emet*, truth, animates the figure. The 2026-09-08 expansion "Guided Engagement Module" is superseded.

**RUNED (Registered Utility Node Executable Directive).** One declared, registered tool built into a GEM. The 2026-09-08 expansion "Registered Utility Node Extension" (RUNE) is superseded. Where an older note says RUNE, read RUNED.

**RUNED GEM.** A GEM whose manifest contains one or more RUNED directives.

**Library.** The private repository EMET-GEMs, which holds this standard, plus a public submission repository that does not exist yet. Outside authors will submit GEMs to that public repository. They do not change this standard.

## 2. Design principles

1. The core floor is the memory minimum. Behavioral guidance lives in GEMs.
2. Core floor protections are non-removable. No GEM weakens them. The socket enforces that. Author goodwill is not the control.
3. A GEM that fails a check is refused. The session still starts.
4. Context is a budget. Every active GEM costs startup bytes, so caps are part of the standard.
5. Security requirements are in force in this revision. Bundled prompt GEMs are the only GEMs a release may load before the matching checks ship. The requirements for every other GEM are already written, and a missing checker is not permission to load one.
6. Alex is the sole approver of this standard, the schema, and the socket rules. His bots may sponsor a change. Other people may author GEMs that follow the standard. They MUST NOT alter it.

## 3. Where this standard lives

This directory is self-contained. Its canonical home is `https://github.com/dreamforgestudiollc/EMET-GEMs`, private for now.

A public submission repository will take pull requests that add GEMs. Its name is not chosen. A pull request there MUST NOT modify `SPEC.md`, `gem.schema.json`, `CONFORMANCE.md`, or the socket rules. Those files change only in EMET-GEMs, by a GEP Alex accepts.

The EMET server repository keeps a pointer for the socket. It does not carry a second editable copy of this standard after the move.

## 4. Relation to MCP

Checked against the Model Context Protocol specification revision 2026-07-28, the feature deprecation policy, and the Skills extension (SEP-2640, Final). A GEM is not an MCP skill, and this revision does not serve GEMs through `skills/list` or `skill://`. The alignments below are deliberate. The differences are deliberate.

Aligned:

- Specification revisions are dates, `YYYY-MM-DD`, and change when a breaking change lands. Document states are Draft, Current, and Final.
- Manifest digests use the Skills form: `sha256:` plus 64 lowercase hex digits, and `size` is the byte length of the same raw bytes. A length mismatch fails the same way a digest mismatch fails. Activation and consent bind to that file list. A changed digest is a new revision and needs fresh consent where consent applies.
- `name` is a label. Identity is separate. For a GEM the identity is `id` inside one EMET server.
- A RUNED directive uses the MCP tool fields from that base revision: `name`, `title`, `description`, `inputSchema`, `outputSchema`, and annotations `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
- Deprecation of a field or a check waits at least 12 months, or 90 days when Alex records an active security risk. See section 14.

Different on purpose:

- MCP tool annotations are hints, and a client treats them as untrusted. EMET REQUIRES the four hints on every RUNED directive and does not apply MCP's defaults (read-only false, destructive true, open world true). Absence fails validation.
- `reads`, `writes`, and `network` are EMET fields. The MCP tool type does not declare store access. The socket enforces them. They are not hints.
- Skills allow up to 512 files and 16 MiB because a host pulls files on demand. An active GEM's floor is inside every startup, which EMET already pages at 18,000 bytes. GEM caps are much smaller. See sections 6 and 9.
- This project has one approver. It does not copy the MCP SEP sponsor process. See section 16.

## 5. Manifest

A GEM directory contains `gem.json` and the files it lists. `gem.json` MUST validate against [gem.schema.json](gem.schema.json). The schema's `spec` const is `2026-10-12`. A socket MUST refuse a manifest whose `spec` it does not implement.

| Field | Rule |
|---|---|
| `id` | Stable. Lowercase, digits, hyphens. Unique on one server. |
| `name` | Label people see. Not unique. |
| `description` | One short summary. Served on `gems_available`. |
| `version` | `MAJOR.MINOR.PATCH`. A suffix is refused. A leading zero is refused. |
| `kind` | `gem` or `runed-gem`. |
| `requires.emet` | Exact version, or one of `>=`, `^`, `~`, on `MAJOR.MINOR.PATCH`. The socket refuses a GEM when the running version is outside the range. `^0.3.0` means `>=0.3.0 <0.4.0`. |
| `priority` | Integer 0 through 100. Higher wins. Equal priority: the `id` that sorts first in UTF-8 byte order wins. |
| `defaultOn` | Whether a fresh install activates it before the user asks. Neurendipity is `false`. |
| `released` | The socket seats a GEM only when this is the boolean `true`. `false`, the string `"true"`, `1`, and `null` are refused. A missing field is allowed only for Neurendipity 1.2.3 and Fieldnote 1.0.1 when the id, the version, and every file digest match the pin. A shorter file list does not match. The pin covers the id, the version, and the file digests. It does not cover every other manifest field, including `defaultOn`, `priority`, `requires`, `description`, `name`, `authors`, `license`, rune `description`, schemas, the guides list, `distribution`, `coverage`, and rune metadata other than the version. `overrides` still needs SR-05 consent. A rune `execution` of `server` and `distribution` `library` are refused by GC-02. `gem.json` is not hashed: anyone who can edit it can already add `released: true`, so hashing it would grant nothing extra. Any other GEM missing the field is refused, including a bumped version of those two. The check runs on every boot. A read error refuses and does not turn the check off. |
| `overrides` | Dotted paths of modifiable defaults this GEM changes. Empty means the GEM only adds lines. Core protection paths fail the check. A non-empty list requires recorded user consent at activation, bound to the file digests. |
| `distribution` | `bundled` or `library`. |
| `floor` | Path of the floor JSON. It MUST appear in `files`. |
| `guides` | On-demand markdown paths. Each MUST appear in `files`. |
| `runes` | Empty for `kind` `gem`. One to sixteen entries for `kind` `runed-gem`. |
| `files` | Every content file except `gem.json`. Each path once. |
| `authors`, `license` | Required. |
| `changelog` | Optional. What changed in this version: a string, a list, or an object of notes. The socket does not read it. |
| `update` | Optional. How this version relates to the previous release of the same GEM. An object. `class` `initial` is the first release. The socket does not read it. |
| `knowledge` | Optional. Notes or a corpus shipped with the GEM: a string, a list, or an object. The socket does not read it. |
| `coverage` | Optional. What this GEM covers: a string, a list of at most 256 entries, or an object. The socket does not read it. Lean Six Sigma ships a list of 90 entries. |
| `signature` | Required when `distribution` is `library`. Optional on `bundled`. See section 12. |

`files[].digest` is `sha256:` plus 64 lowercase hex digits of the file's raw bytes. `files[].size` is that byte length. The checker MUST NOT normalize newlines before hashing. Authors MUST store text as LF.

The example [examples/neurendipity/gem.json](examples/neurendipity/gem.json) is a valid manifest. Its floor lines are illustrative. The server MUST NOT load that example directory.

## 6. GEM content

`floor.json`:

```json
{
  "sections": {
    "section_key": {
      "title": "Title",
      "note": "When these lines apply.",
      "lines": { "line_key": "One rule." }
    }
  },
  "reassertion": ["Short line worth re-reading."]
}
```

Section keys MUST match `^[a-z][a-z0-9_]{0,40}$`. Line values are strings. A GEM MUST NOT use the section keys `voice`, `engagement`, `persistence`, `corpus_discipline`, or `operating_discipline`. Those belong to the core floor and to the operating discipline in server code. A GEM adds sections. The `overrides` list is the only patch into a core path, and only for a modifiable path, and only with consent.

Guides are markdown under `guides/`. They are not copied into startup. The server serves them when a session asks for that doc id.

### Size limits

| Limit | Maximum |
|---|---|
| Floor file, raw bytes | 8,192 |
| One guide | 65,536 |
| Guides per GEM | 16 |
| Listed files | 32 |
| Sum of `files[].size` | 262,144 |
| RUNED directives | 16 |
| `reassertion` lines | 24 |

These figures are the Draft limits. A GEP can change them before this revision is Current.

## 7. Lifecycle

The socket performs these steps. A failure at any step refuses that GEM and continues.

1. **Discover.** Read child directories of the release's `gems/` directory. Once library GEMs are allowed, also read the accepted list shipped with the release. Do not discover the document store, the network, or a user-supplied path.
2. **Validate.** Run the checks in [CONFORMANCE.md](CONFORMANCE.md).
3. **Load.** Parse the floor of each GEM that validated. Do not register tools yet.
4. **Activate.** Turn on a GEM whose `defaultOn` is true, or that the user asked for, subject to the caps and to consent. Register RUNED tools only in a release that is allowed to execute them (section 12).
5. **Deactivate.** Remove the GEM from `gems_active` and unregister its tools. It stays in `gems_available`.
6. **Unload.** A bundled GEM leaves memory when the process stops. This revision does not define a way to delete a bundled directory at runtime.

`defaultOn: true` with an empty `overrides` MAY activate without a prompt. Any non-empty `overrides` MUST wait for recorded consent, even when `defaultOn` is true. Neurendipity is `defaultOn: false` and `overrides: []`. It activates when the user asks.

## 8. Precedence

When a core protection, the user's current word, a GEM, and a character modifier speak to the same point, they rank in this order, highest first:

1. **Core floor protections.** They hold against a GEM, a character modifier, and a request to drop them. The user can ask for more care, more explanation, or a different pace. The user cannot turn off honesty, persistence, or fact-checking.
2. **The user's current word**, on everything the core floor leaves open, including whether an optional GEM is on.
3. **Active GEMs**, by `priority`. A higher priority line is the one served when two active GEMs set the same section and line key. The other line is omitted.
4. **Character modifiers**, on register, tone, pace, length, and how much is said unasked. A modifier may make the assistant more careful. It does not weaken a core protection or a GEM the user left on.

A GEM MAY override a modifiable default only after consent at activation. Consent does not create an exception for a core protection.

This is the same scoping the charter uses: the user's word governs what the floor leaves to the user, and the floor governs what is owed on every install. The 2026-09-11 decision still holds for modifiable defaults (voice, pace, how much is explained), with the conflict resolved with the user when the GEM is activated.

GEM text is data to the socket and instructions to the model. Precedence is how the socket orders those instructions. The floor-negation lint is a separate control on the file. A line that passes the lint and still argues with the core floor loses to the core floor.

## 9. Sockets, limits, and the available list

| Limit | Maximum |
|---|---|
| Installed GEMs listed | 16 |
| Active GEMs | 4 |
| Sum of active floor-file sizes | 16,384 bytes |

The server MUST include two fields on every `emet_initialize`, including a server with no GEMs and a server whose GEMs all failed validation:

```json
{
  "gems_available": [
    {
      "id": "neurendipity",
      "name": "Neurendipity",
      "description": "Neurodivergent engagement. Off unless the user asks for it.",
      "version": "1.0.0",
      "kind": "gem",
      "spec": "2026-10-12",
      "priority": 50,
      "distribution": "bundled",
      "defaultOn": false,
      "active": false,
      "loadable": true,
      "bytes": 953
    }
  ],
  "gems_active": []
}
```

The object above is the field shape. `bytes` here is the example floor file, not the size after GEP-0001 moves the real lines.

`gems_available` lists every installed GEM, active or not, ordered by `id` ascending. A GEM that failed validation is listed with `loadable: false`, `active: false`, and `reason` set to the check id (`GC-05`, `SR-02`, and so on). `reason` is omitted when `loadable` is true. `bytes` is the raw size of the floor file, or `0` when the file could not be trusted.

When a GEM is active, `gems_active` contains one object per active GEM, higher priority first:

```json
{
  "id": "neurendipity",
  "version": "1.0.0",
  "priority": 50,
  "floor_digest": "sha256:...",
  "floor": {},
  "reassertion": []
}
```

Both fields are in the same class as the core floor: the server MUST keep them whole in the startup payload. It MUST NOT replace them with a pointer, and it MUST NOT drop them when the payload is paged. The implementation adds them to the startup fidelity list that already protects the floor.

The startup text a bot reads MUST name the list in the place the charter gives to what is available this session. One line per GEM: `id`, `name`, and `on` or `off`. A refused GEM adds the reason code, not a stack trace. An empty list still prints `GEMs installed: none.` An installed GEM that is off is not a capability of the session. The bot MUST NOT describe it as active.

`emet_floor` will take a `gem` argument to read one GEM's floor. `emet_status` will report each GEM's byte cost. Those tool changes are later server work. This revision requires the fields and the text above so that work has a fixed shape.

## 10. RUNED directives

A RUNED directive is client-executed code the socket serves while its GEM is active, and withdraws when the GEM is deactivated. The socket MUST NOT execute RUNE code. There is no fallback that runs it. [GEP-0003](proposals/GEP-0003-client-side-execution.md) is the contract. It supersedes GEP-0002.

Required members: `name`, `description`, `execution`, `artifact`, `sha256`, `version`, `runtime`, `inputSchema` (JSON Schema, `type` `object`), `outputSchema` (JSON Schema), `annotations` (all four hints), `reads`, `writes`, `network`. Optional: `title`.

`execution` MUST be `client`. `artifact` is the path of the code file, under `runes/`, and listed in `files`. `sha256` is the digest of that file's raw bytes, in the same `sha256:` form as a file digest. `version` is the GEM's semver. `runtime` names the runtime the client needs to run the code.

`network` MUST be `none`. This revision grants no network capability. `destructiveHint` MUST be `false`, because EMET does not delete. `openWorldHint` MUST be `false`. It describes the served code. The store is a closed world, and EMET cannot enforce that once the code runs in the client's sandbox. `readOnlyHint` MUST be `true`. `reads` MUST be empty. `writes` MUST be empty.

A client RUNE MUST be a deterministic function of the inputs the caller passes in. It MUST NOT import `emet/rune`. No client shim of `emet/rune` is offered, because that would put the client's scopes in charge of store access. The client reads through the normal EMET tools and passes those values in. A RUNE MUST NOT receive a database handle, a connection string, or a collection object.

`gem.schema.json` gains these members in the implementation of this section, together with the fieldnote rewrite. Until that change, the schema still wins on shape, as the note under the revision date says.

### One tool per RUNE

While the GEM is active, the socket registers one tool per RUNE in the tool list. The name is `gem_<gem>__<rune>`: the GEM `id`, then `__`, then the RUNE `name`. The name MUST NOT be a reserved core tool name. `readOnlyHint` is true, `destructiveHint` is false, `idempotentHint` is true, and `openWorldHint` is false. The scope is `emet.read`.

The tool list entry carries that RUNE's description, input schema, output schema, runtime, and served sha256. The description states that a call returns the code and does not run it. The tool description and the served `description` state the exact `metadata.gem` value to use, `<gem>@<version>`. A call checks the RUNE against the active GEMs and the hash pin, then returns `{code, sha256, version, runtime, instructions, inputSchema, outputSchema, description}`. It runs nothing. The served code counts toward the GEM's byte cost.

The startup text names each active RUNE's runtime, inputs, outputs, and served sha256 before consent, in the place the charter gives to what is available this session.

A client without a sandbox gets no result and MUST say so. EMET does not run the code for it. A GEM SHOULD carry a guidance-only path where it can.

A missing `readOnlyHint` is a schema failure. The socket MUST NOT fall through to a write scope to "be safe." The safe outcome is refusal of the GEM.

### Kept results

A result is kept only through the existing governed write path. That path applies the session id, the load id, the monorail order, the receipt, and the board guard. There is no exemption flag for a GEM. Size floors on document writes apply. The server stamps the caller's registered source tag from authentication: the sub-key `key_id` or the owner login, the session, and the exchange. It MUST NOT take attribution from client metadata. A directive MUST NOT choose its own source tag. The server sets `metadata.gem` to `id@version`. A write whose `metadata.gem` does not match the active directive is refused, and the error says `metadata.gem` must be `'<gem>@<version>'`.

The served code is treated as a controlled document. A kept result is a record of a claim, not a verified output. EMET supports the organization's document and record controls (ISO 9001 7.5.3 / ISO 13485 4.2.5). It claims no certification and no conformity. The organization validates EMET and any GEM for its own use.

Six controls cover a kept result:

1. **Serve log.** At serve time the server records the principal, `session_id`, `gem`, `rune`, `version`, the served `sha256`, and the time. The audit line is one copy. The serve log is the other. `logs/gem-serves.json` keeps the latest `SERVE_CAP` rows for each principal (200), so one caller cannot evict another's serves. This release creates the new collection `<prefix>gem_serves` (`SERVE_COLLECTION`, the install's `EMET_COLLECTION_PREFIX`, default `emet_`). Alex approved it as an append-only write site on the write-path allow-list. The collection keeps every row. Nothing is deleted. Each serve appends a row, so the collection grows with every serve. That is the storage cost of keeping the record. There is no rate limiter. A kept result matches a row for that principal, session, gem, rune, and served hash. A redeploy that drops the file still matches against those Mongo rows. When the store is not connected, the file is the only copy and a redeploy drops it. Fieldnote is off by default. The file cap is in place before fieldnote is turned on.
2. **Principal binding.** Attribution is set by the server from authentication. It is never taken from client metadata. This is EMET's existing attribution rule.
3. **Input hashes.** Each result records a sha256 of its inputs, or a reference to them. The input hash is reported by the client, so it does not make a result replayable on its own. A replayable result also needs its inputs kept or refetchable.
4. **Retention.** Superseded artifacts stay retrievable by sha256, through kept release tags plus an artifact index keyed by sha256. The query that finds results tied to a superseded hash is part of the implementation that follows this text.
5. **Immutable attestation.** `gem`, `version`, `rune`, the served sha256, the client-reported sha256, the input hash, and the principal cannot be changed by a later write. Writes are append-only and supersede-only. The client-reported sha256 is kept for traceability. It is not integrity evidence.
6. **Library gate.** Artifacts are unsigned. A hash plus two-reviewer release review is enough for a bundled GEM. For a GEM from outside the release, the hash comes from the same manifest the gate checks, so integrity rests on the library gate. Signing stays out of scope.

Declarative directives, when they are implemented, are a named call into an existing EMET tool with arguments fixed in the manifest. They use the same dispatch path. They are not client RUNEs. This revision's schema is the declaration.

## 11. Security and trust

This section is the trust model. It is not a placeholder for a later design.

### Classes

| Class | What it is | When the socket may load it |
|---|---|---|
| Bundled prompt GEM | `distribution: bundled`, `kind: gem`, directory is `gems/<id>/` inside the EMET release | The first socket release, after the static checks pass |
| Bundled RUNED GEM | Same, `kind: runed-gem` | A release that serves each RUNE and does not execute RUNE code |
| Library GEM | `distribution: library`, signed, on the accepted list | A release that verifies signatures and the accepted list |

Until the first socket release, EMET loads no GEM.

`distribution: bundled` in a manifest is a claim. The socket MUST ignore that claim unless the directory is the release's `gems/<id>/` for that `id`. A copy in the document store, a path the user passes, or a download MUST NOT load, even if the hashes match a bundled GEM.

### Hash pinning

Every content file is pinned by `digest` and `size`. The socket MUST refuse the GEM on mismatch. Consent, when required, is bound to the set of digests. A changed file is a different GEM revision.

### Signatures

Library GEMs MUST be signed. The signature covers the manifest so the file list cannot be swapped under it.

1. Remove the `signature` member.
2. Canonicalize the remaining JSON with RFC 8785.
3. Sign those UTF-8 bytes with Ed25519.
4. `signature.alg` is `Ed25519`. `signature.keyid` names a key in the checker's trust store. `signature.value` is standard base64 of the 64-byte signature.

The trust store is `keys.json` shipped with `gem-check` and with the EMET release. Shape: `{ "keys": [ { "keyid": "...", "alg": "Ed25519", "publicKey": "<base64 of 32 bytes>" } ] }`. Alex changes that file. A GEM that contains `keys.json` fails validation. A submission pull request MUST NOT be the source of a new key.

No creator key is published in this Draft. `gem-check` MUST fail a library GEM with `no trust store` until `keys.json` exists. Bundled GEMs may omit `signature` until then, and they remain pinned by digest plus the release tree.

### The socket does not run the code

The socket MUST NOT execute RUNE code. Static analysis at load, and the artifact hash check in [CONFORMANCE.md](CONFORMANCE.md) GC-19, are how a release shows the served code matches the declaration. The server does not run the code a second time to show it again.

These guarantees move to the client. EMET does not claim them:

- Process isolation, and the wall-clock and memory limits.
- No network access. `openWorldHint: false` describes the served code. EMET cannot enforce it once the code runs in the client's sandbox.
- Enforcement of declared reads and writes. Under section 10 the RUNE has no store access.
- Output caps during the run. EMET still applies its write floors to anything written back.
- Correctness of the result.

A client-executed result that is kept is recorded as attested by the client. It is replayable from recorded inputs. EMET does not re-execute it. This is the carve-out from charter commitment 1: EMET verifies the record, not the computation.

A guard test MUST fail if `src/` or `gems/` contains `child_process`, `spawn`, `worker_threads`, `vm`, `new Function`, a computed `import()` path, or an import of a RUNE runner. The allow-list in `src/` is `src/gem-check.js`'s own `node --check` call and its named `vm` and `node:vm` comparisons, matched in code and not in comments. The banned-import list is in `verification/load-gate/load-gate.mjs`, which that walk does not scan. A second test adds a spawn and confirms the guard still catches it.

### What the checker is, and is not

`gem-check` is specified in [CONFORMANCE.md](CONFORMANCE.md) down to check ids, patterns, limits, and exit codes, so a later change can implement it without inventing the rules. Exit 0 is necessary for a library GEM and for a bundled GEM that a release will ship. Exit 0 is not sufficient for a library GEM. Alex accepts it, or it does not enter the list the socket trusts.

GC-19 checks that the artifact exists, that its digest matches the manifest, and that the static load-gate scan in [CONFORMANCE.md](CONFORMANCE.md) GC-16 finds none of the reaches listed there. That list is the whole list. `Math.round` and `Math.sqrt` inside a function are not reaches. A computed key that is a literal, or a `const` bound directly to a primitive literal, is not a reach. A top-level frozen null-prototype table read inside a recognized `Object.hasOwn` guard is not a reach when the key is one `const` primitive (`const n = String(input.n)` or `Number(...)`, or a `typeof` check for `'string'` or `'number'` the gate recognizes, including the binding of `for (const k of …)`). The guard's non-own-key safety rests on that table being frozen with a null prototype: a key that is not own reads `undefined`. A member, a `let`, or a const object used as the key is a reach. A loop label is not a reach. A loop index used as a computed key is a reach. A computed key in a destructuring or assignment pattern is a reach unless it is a string or number literal. The scan parses with acorn 8.19.0 and fails closed. It does not run the code. This standard does not claim the client's sandbox as EMET's isolation.

### Floor-negation lint

The checker MUST reject GEM text that matches the patterns in [CONFORMANCE.md](CONFORMANCE.md). That lint is cheap and incomplete. Precedence still applies to every line that passes.

## 12. Threat model

| Threat | What it looks like | Mitigation |
|---|---|---|
| Prompt injection via GEM text | Floor lines or a guide tell the model to ignore honesty, skip named items, or flatter | Core floor outranks GEM text. The user's current word outranks the GEM. The lint rejects the obvious phrasings. A GEM is off until the user asks, unless an accepted GEP sets `defaultOn`. Library text loads only after signature checks and the owner's acceptance. |
| Malicious RUNED code | The served code reads the database, spawns a process, or reaches the network | The socket does not execute the code. No database handle is passed in. The code MUST NOT import `emet/rune`. `reads` and `writes` are empty. Static analysis refuses the reaches listed in CONFORMANCE.md GC-16, and nothing beyond that list. A digest mismatch refuses the GEM. Isolation of the run is the client's. A `runed-gem` does not load in a release that lacks those checks. |
| Supply chain | A file is swapped, a dependency is added, or the submitter ships the public key | Digests on every file. Signature against keys the checker already has. No runtime dependencies. The accepted list and the trust store ship in the release, not in the pull request. |
| Data exfiltration | Memory or a user secret leaves through the served code | `network` is `none` on the declaration. The load-gate scan refuses network APIs. `reads` is empty. EMET does not run the code, so it does not claim the client's sandbox blocks a connection. A kept write goes through the governed doors. |
| Privilege escalation via scopes | A missing hint becomes a write, or a read-only tool writes | All four hints are required. MCP defaults are not applied. `readOnlyHint` is true. `reads` and `writes` are empty, so the RUNE has no store scope. `destructiveHint` and `openWorldHint` are fixed false. A later write of a result uses the normal write path. The directive cannot set its source tag. `metadata.gem` is stamped by the server. |
| Denial of service via size | A large floor is attached to every startup, or served code is huge | Caps in sections 6 and 9. Over cap refuses the GEM and still returns initialize. Wall-clock and memory limits during a run are the client's. GEM bytes, including served code, sit inside the startup accounting the server already uses. |

## 13. Submission

Outside GEMs enter through a pull request to the public submission repository, once that repository exists. Until it exists, no outside GEM can be submitted, and EMET loads only bundled GEMs that ship in a release Alex has accepted.

The pull request contains the GEM directory and nothing from this standard. Continuous integration runs `gem-check` on that directory. A non-zero exit rejects the automated gate. Reviewers MUST NOT merge past a failing check.

After exit 0, Alex reviews. A bot he designates MAY sponsor: prepare notes, re-run the checker, comment on the pull request. The bot MUST NOT be the acceptance. the owner's acceptance records the `id`, `version`, file digests, `keyid`, date, and spec revision on the list the next EMET release ships. The socket loads a library GEM only when the bytes match that list (server refusal SR-01).

A GEM that fails any check in [CONFORMANCE.md](CONFORMANCE.md) is not on that list. Passing the script and then being edited in place without a new check is not acceptance. The digests are the acceptance.

## 14. Versioning and deprecation

- This document's revision date changes only for a breaking change. States: Draft, Current, Final. Final will not change.
- A GEM's `version` is semver. A breaking change to lines an install may have relied on MUST bump the major version. This revision accepts `MAJOR.MINOR.PATCH`. A suffix is refused. A leading zero is refused.
- The socket MUST refuse a GEM whose `spec` it does not implement, and whose `requires.emet` excludes the running server.
- A deprecated manifest field or check stays available for at least 12 months after the Current revision that marks it deprecated, or 90 days when Alex records an active security risk in the deprecation GEP. Removal is a new spec date. The deprecation GEP names what replaces it, or states that nothing does.
- One old doc id is special. When the Neurendipity guide moves, `guides/NEURODIVERGENT_SUPPORT.md` on the server MUST keep resolving to the GEM's guide for one release, then that alias MAY be removed. That alias is server behavior from GEP-0001, not a second copy of the text.

## 15. Conformance

A GEM conforms to this revision when `gem-check` exits 0 against it and, for a library GEM, Alex has accepted that digest set. The EMET server conforms when its socket implements sections 7 through 13 and the server refusals in [CONFORMANCE.md](CONFORMANCE.md), and when a refused GEM still leaves `emet_initialize` successful.

The reference GEM is Neurendipity, `id` `neurendipity`. It is bundled. `defaultOn` is false. It carries reading people, the neurodivergent engagement lines, the wellbeing corpus lines, and the neurodivergent guide. It does not carry RUNED directives. The move itself is [GEP-0001](proposals/GEP-0001-core-floor-and-neurendipity-gem.md).

## 16. Proposals

A GEM Enhancement Proposal (GEP) is a markdown file in `proposals/`, named `GEP-NNNN-short-title.md`. Status is one of Draft, Accepted, Final, Rejected, Superseded.

Alex is the sole approver. He sets Accepted, Rejected, or Superseded. Final requires the conformance checks for the proposal's observable behavior to exist and to pass. A bot he designates MAY sponsor a GEP. A sponsor does not approve.

Only Alex and his bots change this specification, `gem.schema.json`, `CONFORMANCE.md`, and the socket rules. Other people author GEMs.

A GEP that asks EMET to build something MUST answer the four questions in charter commitment 6:

1. What failure does it fix, and where is it on record?
2. What does it replace or retire?
3. How will we know it worked? One measure, checked in a pilot.
4. What holds it once it works?

A GEP does not amend the charter. Charter text changes by a charter revision with the user's approval.

## Appendix A. Reference GEM

Neurendipity. Manifest shape: [examples/neurendipity/gem.json](examples/neurendipity/gem.json). Decisions and the core/ND split: [GEP-0001](proposals/GEP-0001-core-floor-and-neurendipity-gem.md).

## Appendix B. Authoring

Step by step: [AUTHORING.md](AUTHORING.md).
