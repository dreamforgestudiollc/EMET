# GEM specification

**Revision:** 2026-10-11
**Status:** Draft
**Home:** [EMET-GEMs](https://github.com/dreamforgestudiollc/EMET-GEMs) (private). The copy in an EMET server checkout at `gem-library/` is the text under review until it is moved.

This revision stays Draft until the Neurendipity GEM has passed the conformance checks in an EMET release and the core-floor move in [GEP-0001](proposals/GEP-0001-core-floor-and-neurendipity-gem.md) has shipped. The owner may then mark it Current. A later breaking revision gets a new date. A clarification that does not break a valid manifest does not change the date.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in BCP 14 [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals, as shown here.

The JSON Schema [gem.schema.json](gem.schema.json) is normative for the manifest's shape. This text is normative for behavior. If they disagree, the schema wins on shape and this text wins on behavior, and the disagreement is a defect to fix in the same revision.

## 1. Terms

**EMET** is a memory server. Its function is the record: what was written, what was decided, and what still stands. It is not a behavior framework.

**Core floor.** The lines every install serves and nobody can switch off: integrity, honesty, no sycophancy, truth over speculation, fact-checking, and persistence. They ship in server code. Setup cannot write them.

**Socket.** The seat where a GEM is mounted. The word means that seat only. It does not mean a host connector or a network socket.

**GEM (Golem Expertise Module).** A folder of engagement lines and guides that seats in the socket. The name marks the golem legend: the word *emet*, truth, animates the figure. The 2026-09-08 expansion "Guided Engagement Module" is superseded.

**RUNED (Registered Utility Node Executable Directive).** One declared, registered tool built into a GEM. The 2026-09-08 expansion "Registered Utility Node Extension" (RUNE) is superseded. Where an older note says RUNE, read RUNED.

**RUNED GEM.** A GEM whose manifest contains one or more RUNED directives.

**Library.** The private repository EMET-GEMs, which holds this standard, plus a public submission repository that does not exist yet. Outside authors will submit GEMs to that public repository. They do not change this standard.

## 2. Design principles

1. The core floor is the memory minimum. Behavioral guidance lives in GEMs.
2. Core floor protections are non-removable. No GEM weakens them. The socket enforces that. Author goodwill is not the control.
3. A GEM that fails a check is refused. The session still starts.
4. Context is a budget. Every active GEM costs startup bytes, so caps are part of the standard.
5. Security requirements are in force in this revision. Bundled prompt GEMs are the only GEMs a release may load before the matching checks ship. The requirements for every other GEM are already written, and a missing checker is not permission to load one.
6. The owner is the sole approver of this standard, the schema, and the socket rules. The owner's bots may sponsor a change. Other people may author GEMs that follow the standard. They MUST NOT alter it.

## 3. Where this standard lives

This directory is self-contained. Its canonical home is `https://github.com/dreamforgestudiollc/EMET-GEMs`, private for now.

A public submission repository will take pull requests that add GEMs. Its name is not chosen. A pull request there MUST NOT modify `SPEC.md`, `gem.schema.json`, `CONFORMANCE.md`, or the socket rules. Those files change only in EMET-GEMs, by a GEP the owner accepts.

The EMET server repository keeps a pointer for the socket. It does not carry a second editable copy of this standard after the move.

## 4. Relation to MCP

Checked against the Model Context Protocol specification revision 2026-07-28, the feature deprecation policy, and the Skills extension (SEP-2640, Final). A GEM is not an MCP skill, and this revision does not serve GEMs through `skills/list` or `skill://`. The alignments below are deliberate. The differences are deliberate.

Aligned:

- Specification revisions are dates, `YYYY-MM-DD`, and change when a breaking change lands. Document states are Draft, Current, and Final.
- Manifest digests use the Skills form: `sha256:` plus 64 lowercase hex digits, and `size` is the byte length of the same raw bytes. A length mismatch fails the same way a digest mismatch fails. Activation and consent bind to that file list. A changed digest is a new revision and needs fresh consent where consent applies.
- `name` is a label. Identity is separate. For a GEM the identity is `id` inside one EMET server.
- A RUNED directive uses the MCP tool fields from that base revision: `name`, `title`, `description`, `inputSchema`, `outputSchema`, and annotations `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
- Deprecation of a field or a check waits at least 12 months, or 90 days when the owner records an active security risk. See section 14.

Different on purpose:

- MCP tool annotations are hints, and a client treats them as untrusted. EMET REQUIRES the four hints on every RUNED directive and does not apply MCP's defaults (read-only false, destructive true, open world true). Absence fails validation.
- `reads`, `writes`, and `network` are EMET fields. The MCP tool type does not declare store access. The socket enforces them. They are not hints.
- Skills allow up to 512 files and 16 MiB because a host pulls files on demand. An active GEM's floor is inside every startup, which EMET already pages at 18,000 bytes. GEM caps are much smaller. See sections 6 and 9.
- This project has one approver. It does not copy the MCP SEP sponsor process. See section 16.

## 5. Manifest

A GEM directory contains `gem.json` and the files it lists. `gem.json` MUST validate against [gem.schema.json](gem.schema.json). The schema's `spec` const is `2026-10-11`. A socket MUST refuse a manifest whose `spec` it does not implement.

| Field | Rule |
|---|---|
| `id` | Stable. Lowercase, digits, hyphens. Unique on one server. |
| `name` | Label people see. Not unique. |
| `description` | One short summary. Served on `gems_available`. |
| `version` | `MAJOR.MINOR.PATCH` only, this revision. |
| `kind` | `gem` or `runed-gem`. |
| `requires.emet` | Exact version, or one of `>=`, `^`, `~`, on `MAJOR.MINOR.PATCH`. The socket refuses a GEM when the running version is outside the range. `^0.3.0` means `>=0.3.0 <0.4.0`. |
| `priority` | Integer 0 through 100. Higher wins. Equal priority: the `id` that sorts first in UTF-8 byte order wins. |
| `defaultOn` | Whether a fresh install activates it before the user asks. Neurendipity is `false`. |
| `overrides` | Dotted paths of modifiable defaults this GEM changes. Empty means the GEM only adds lines. Core protection paths fail the check. A non-empty list requires recorded user consent at activation, bound to the file digests. |
| `distribution` | `bundled` or `library`. |
| `floor` | Path of the floor JSON. It MUST appear in `files`. |
| `guides` | On-demand markdown paths. Each MUST appear in `files`. |
| `runes` | Empty for `kind` `gem`. One to sixteen entries for `kind` `runed-gem`. |
| `files` | Every content file except `gem.json`. Each path once. |
| `authors`, `license` | Required. |
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
      "spec": "2026-10-11",
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

A RUNED directive is a tool the socket registers while its GEM is active, and unregisters when the GEM is deactivated.

Required members: `name`, `description`, `inputSchema` (JSON Schema, `type` `object`), `annotations` (all four hints), `reads`, `writes`, `network`. Optional: `title`, `outputSchema`.

`network` MUST be `none`. This revision grants no network capability. `destructiveHint` MUST be `false`, because EMET does not delete. `openWorldHint` MUST be `false`, because the store is a closed world. If `readOnlyHint` is true, `writes` MUST be empty.

`reads` and `writes` are allow-lists. Each entry is a layer name (`identity`, `semantic`, `episodic`, `procedural`, `meta`, `working`) or `doc:` plus a document id prefix.

### Write path

A RUNED directive MUST NOT receive a database handle, a connection string, or a collection object. The only store entry is the EMET module `emet/rune`, which calls the same dispatch path as every other write.

That path already applies the session id, the load id, the monorail order, the receipt, and the board guard. A RUNED write goes through it unchanged. There is no exemption flag for a GEM. Size floors on document writes apply. The server stamps the caller's registered source tag and sets `metadata.gem` to `id@version`. A directive MUST NOT choose its own source tag. A write whose `metadata.gem` does not match the active directive is refused.

A missing `readOnlyHint` is a schema failure. The socket MUST NOT fall through to a write scope to "be safe." The safe outcome is refusal of the GEM.

Declarative directives, when they are implemented, are a named call into an existing EMET tool with arguments fixed in the manifest. They use this same dispatch path. This revision's schema is the declaration. Execution waits for the release named in section 12.

## 11. Security and trust

This section is the trust model. It is not a placeholder for a later design.

### Classes

| Class | What it is | When the socket may load it |
|---|---|---|
| Bundled prompt GEM | `distribution: bundled`, `kind: gem`, directory is `gems/<id>/` inside the EMET release | The first socket release, after the static checks pass |
| Bundled RUNED GEM | Same, `kind: runed-gem` | A release that includes the sandbox and the dispatch wrapper |
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

The trust store is `keys.json` shipped with `gem-check` and with the EMET release. Shape: `{ "keys": [ { "keyid": "...", "alg": "Ed25519", "publicKey": "<base64 of 32 bytes>" } ] }`. The owner changes that file. A GEM that contains `keys.json` fails validation. A submission pull request MUST NOT be the source of a new key.

No creator key is published in this Draft. `gem-check` MUST fail a library GEM with `no trust store` until `keys.json` exists. Bundled GEMs may omit `signature` until then, and they remain pinned by digest plus the release tree.

### Declared access

The socket MUST refuse a read, a write, or a network attempt that the directive did not declare. `network` other than `none` fails this revision. Static analysis and the sandbox in [CONFORMANCE.md](CONFORMANCE.md) are how a release shows the code matches the declaration. The dispatch wrapper is how the running server shows it again. Both are required for RUNED code. Either one alone is not enough.

### What the checker is, and is not

`gem-check` is specified in [CONFORMANCE.md](CONFORMANCE.md) down to check ids, patterns, limits, and exit codes, so a later change can implement it without inventing the rules. Exit 0 is necessary for a library GEM and for a bundled GEM that a release will ship. Exit 0 is not sufficient for a library GEM. The owner accepts it, or it does not enter the list the socket trusts.

Node has no in-process sandbox that this standard will treat as isolation. RUNED code runs in a separate process with no network, a wall-clock limit, and a memory limit, or it does not run. This standard does not claim in-process isolation.

### Floor-negation lint

The checker MUST reject GEM text that matches the patterns in [CONFORMANCE.md](CONFORMANCE.md). That lint is cheap and incomplete. Precedence still applies to every line that passes.

## 12. Threat model

| Threat | What it looks like | Mitigation |
|---|---|---|
| Prompt injection via GEM text | Floor lines or a guide tell the model to ignore honesty, skip named items, or flatter | Core floor outranks GEM text. The user's current word outranks the GEM. The lint rejects the obvious phrasings. A GEM is off until the user asks, unless an accepted GEP sets `defaultOn`. Library text loads only after signature checks and the owner's acceptance. |
| Malicious RUNED code | The tool reads the database directly, spawns a process, or writes outside its declaration | No database handle. Import allow-list is `emet/rune` and listed files inside the GEM. Writes go through dispatch. Static analysis, secret scanning, and a separate process with no network. A `runed-gem` does not load in a release that lacks those checks. |
| Supply chain | A file is swapped, a dependency is added, or the submitter ships the public key | Digests on every file. Signature against keys the checker already has. No runtime dependencies. The accepted list and the trust store ship in the release, not in the pull request. |
| Data exfiltration | Memory or a user secret leaves the process | `network` is `none`. The sandbox's own canary must fail to connect. A fixture secret must not appear on stdout, stderr, or a file the process writes. Reads are an allow-list. |
| Privilege escalation via scopes | A missing hint becomes a write, or a read-only tool writes | All four hints are required. MCP defaults are not applied. `readOnlyHint: true` forces empty `writes`. `destructiveHint` and `openWorldHint` are fixed false. Dispatch enforces the allow-lists. The directive cannot set its source tag. `metadata.gem` is stamped by the server. |
| Denial of service via size | A large floor is attached to every startup, or a tool loops | Caps in sections 6 and 9. Over cap refuses the GEM and still returns initialize. The sandbox kills the process at 5 seconds or 128 MB. GEM bytes sit inside the startup pages the server already uses. |

## 13. Submission

Outside GEMs enter through a pull request to the public submission repository, once that repository exists. Until it exists, no outside GEM can be submitted, and EMET loads only bundled GEMs that ship in a release the owner has accepted.

The pull request contains the GEM directory and nothing from this standard. Continuous integration runs `gem-check` on that directory. A non-zero exit rejects the automated gate. Reviewers MUST NOT merge past a failing check.

After exit 0, the owner reviews. A bot the owner designates MAY sponsor: prepare notes, re-run the checker, comment on the pull request. The bot MUST NOT be the acceptance. The owner's acceptance records the `id`, `version`, file digests, `keyid`, date, and spec revision on the list the next EMET release ships. The socket loads a library GEM only when the bytes match that list (server refusal SR-01).

A GEM that fails any check in [CONFORMANCE.md](CONFORMANCE.md) is not on that list. Passing the script and then being edited in place without a new check is not acceptance. The digests are the acceptance.

## 14. Versioning and deprecation

- This document's revision date changes only for a breaking change. States: Draft, Current, Final. Final will not change.
- A GEM's `version` is semver. A breaking change to lines an install may have relied on MUST bump the major version. This revision of the spec does not accept pre-release tags in `version`.
- The socket MUST refuse a GEM whose `spec` it does not implement, and whose `requires.emet` excludes the running server.
- A deprecated manifest field or check stays available for at least 12 months after the Current revision that marks it deprecated, or 90 days when the owner records an active security risk in the deprecation GEP. Removal is a new spec date. The deprecation GEP names what replaces it, or states that nothing does.
- One old doc id is special. When the Neurendipity guide moves, `guides/NEURODIVERGENT_SUPPORT.md` on the server MUST keep resolving to the GEM's guide for one release, then that alias MAY be removed. That alias is server behavior from GEP-0001, not a second copy of the text.

## 15. Conformance

A GEM conforms to this revision when `gem-check` exits 0 against it and, for a library GEM, the owner has accepted that digest set. The EMET server conforms when its socket implements sections 7 through 13 and the server refusals in [CONFORMANCE.md](CONFORMANCE.md), and when a refused GEM still leaves `emet_initialize` successful.

The reference GEM is Neurendipity, `id` `neurendipity`. It is bundled. `defaultOn` is false. It carries reading people, the neurodivergent engagement lines, the wellbeing corpus lines, and the neurodivergent guide. It does not carry RUNED directives. The move itself is [GEP-0001](proposals/GEP-0001-core-floor-and-neurendipity-gem.md).

## 16. Proposals

A GEM Enhancement Proposal (GEP) is a markdown file in `proposals/`, named `GEP-NNNN-short-title.md`. Status is one of Draft, Accepted, Final, Rejected, Superseded.

The owner is the sole approver. He sets Accepted, Rejected, or Superseded. Final requires the conformance checks for the proposal's observable behavior to exist and to pass. A bot the owner designates MAY sponsor a GEP. A sponsor does not approve.

Only The owner and the owner's bots change this specification, `gem.schema.json`, `CONFORMANCE.md`, and the socket rules. Other people author GEMs.

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
