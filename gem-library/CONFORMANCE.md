# Conformance and security checklist

Revision 2026-10-11. Normative requirements are in [SPEC.md](SPEC.md). This file is the list `gem-check` implements, and the map from each threat to the checks that hold it.

`gem-check` takes one argument: the GEM directory. It reads `gem.schema.json` from the checker package, not from the GEM directory. It reads the trust store `keys.json` from the checker package. A `keys.json` inside the GEM is a failure.

Output is one line per check, on stdout: `GC-01 pass` or `GC-01 fail: <reason>`. A check that does not apply prints `GC-19 skip: no runes`. Exit `0` means every required check passed or skipped as specified. Exit `1` means a failure or an unexpected throw (fail closed). Exit `2` means the argument was missing or not a directory. Stderr is empty on exit 0.

The socket runs the same checks before load, then applies the server refusals (SR) below. A failure refuses that GEM. `emet_initialize` still returns. `gems_available` includes the GEM with `loadable: false` and `reason` set to the first failed id (`GC-05`, `SR-02`, and so on).

## Checks

### GC-01 JSON

`gem.json` exists at the directory root and parses as one JSON object. Trailing commas and comments fail.

### GC-02 Schema

The object validates against `gem.schema.json` for revision `2026-10-11`. Report the schema path that failed.

### GC-03 Spec revision

`spec` is a revision this checker supports. This revision supports `2026-10-11` only. Any other value fails, including a newer date.

### GC-04 Files and paths

- Every `files[].path` is unique.
- Each path is relative, uses `/`, does not start with `/`, and does not contain `..` or a backslash.
- The path resolves, after realpath, to a file inside the GEM directory. A symlink that escapes fails.
- The file exists and is a regular file.
- `floor` equals one of those paths. Each `guides` entry equals one of those paths.
- Every regular file in the directory except `gem.json` is listed. Unlisted files fail, including `keys.json`, editor swap files, and `node_modules`.
- For `kind` `gem`, no listed path ends in `.js`, `.mjs`, `.cjs`, `.wasm`, `.sh`, `.py`, `.exe`, `.so`, `.dylib`, or `.dll`.

### GC-05 Digests

For each `files` entry, read the raw bytes with no newline conversion. `size` equals the byte length. `digest` equals `sha256:` plus the lowercase hex SHA-256 of those bytes. Compare with a constant-time equality on the hex string.

### GC-06 Floor shape

`floor` parses as JSON. The object has only `sections` and `reassertion`.

- `sections` is an object. Each value has `title` (string), `note` (string), and `lines` (object of strings). No nested objects inside `lines`.
- Section keys match `^[a-z][a-z0-9_]{0,40}$`.
- Forbidden section keys: `voice`, `engagement`, `persistence`, `corpus_discipline`, `operating_discipline`.
- `reassertion` is an array of 1 to 24 strings.
- The raw floor file is at most 8,192 bytes (GC-08 repeats the cap so a size failure has its own id).

### GC-07 Guides

Zero to 16 guides. Each is UTF-8 markdown, at most 65,536 bytes. A NUL byte fails.

### GC-08 Floor cap

The floor file's raw size is at most 8,192 bytes.

### GC-09 Total cap

The sum of `files[].size` is at most 262,144.

### GC-10 Kind

`kind` `gem` has `runes` length 0. `kind` `runed-gem` has `runes` length 1 to 16. Rune `name` values are unique.

### GC-11 Signature

- `distribution` `bundled`: `signature` may be absent. If present, it must verify with the same steps as a library GEM.
- `distribution` `library`: `signature` is required.
- Algorithm: remove `signature`, canonicalize the remaining object with RFC 8785, verify Ed25519 over those UTF-8 bytes. `value` is standard base64 and decodes to 64 bytes. `keyid` matches one entry in the checker's `keys.json` (`alg` `Ed25519`, `publicKey` standard base64 of the 32-byte public key).
- A missing trust store fails every library GEM with `no trust store`. It does not fail a bundled GEM that has no signature.
- The GEM directory must not contain `keys.json` (also caught by GC-04).

The socket does not treat `distribution: bundled` as proof. It loads `bundled` only from the release's `gems/` directory. See SR-01.

### GC-12 Overrides

Each `overrides` entry is a dotted path. It fails if it equals, or starts with, any of:

- `voice.not_modifiable`
- `voice.honesty`
- `voice.measured`
- `voice.epistemic_honesty`
- `voice.discipline`
- `voice.no_moralising`
- `engagement.answer_and_stop`
- `engagement.no_borrowed_hazards`
- `engagement.not_retired`
- `engagement.their_own_plan`
- `engagement.no_rapport_mirroring`
- `persistence.named_items`
- `corpus_discipline.judgment_gated`
- `corpus_discipline.name_the_weight`
- `corpus_discipline.equips_not_diagnoses`
- `corpus_discipline.lived_data_wins`

An override of any other core path also fails until a GEP adds it to the modifiable list. This revision's modifiable paths are `voice.composure`, `voice.directness`, `voice.concrete`, `voice.restraint`, `voice.priorities`, `engagement.lead`, `engagement.one_question`, `engagement.path_forward`, `engagement.mentorship`, `engagement.adapt`, `engagement.acknowledge`, `engagement.modifiable`, `engagement.goal_check`.

### GC-13 Floor-negation lint

Apply the patterns below, case insensitive, to every string in `floor.json`, to `description`, and to each rune `description`. A match fails. This is a lint. A reworded instruction can miss the list and still loses under precedence. The socket still serves the core floor above the GEM.

Patterns (ECMAScript, `i` flag, `.` matches newlines):

- `ignore the (core )?floor`
- `disregard the (core )?floor`
- `override the (core )?floor`
- `you may flatter`
- `flattery is (fine|welcome|encouraged)`
- `soften the truth`
- `do not verify`
- `skip verification`
- `verification is optional`
- `invent a cause`
- `do not name (their |the )?(items|named)`
- `skip named[_ ]items`
- `named[_ ]items (are|is) optional`
- `out of sight[\s\S]{0,40}(skip|ignore|do not name)`
- `the user does not need the truth`

### GC-14 Secrets

Scan `gem.json` and every listed file, as text. A match fails. There is no allowlist file. A false positive is cleared by a GEP that changes this list, not by the GEM author.

- `-----BEGIN (?:RSA |OPENSSH |EC |PRIVATE )?KEY-----`
- `AKIA[0-9A-Z]{16}`
- `mongodb(?:\+srv)?:\/\/[^\s\/]+:[^\s\/]+@`
- `(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^\s'"]{12,}` with the case-insensitive flag

### GC-15 Dependencies

Fail if any of these exist: `node_modules/`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`.

If `package.json` exists, fail when `dependencies`, `devDependencies`, `optionalDependencies`, or `bundledDependencies` is present and has one or more keys. A prompt GEM fails if `package.json` exists at all.

### GC-16 Static analysis

Skip with `skip: no code` when no file under `runes/` ends in `.js` or `.mjs`. A `runed-gem` with no such file is still valid: the directive is declarative until code is added.

For each such file:

- Parse as an ES module. A syntax error fails.
- `import` and `export ... from` sources, `import()`, and `require()` arguments must be string literals. A non-literal fails.
- Allowed specifiers: `emet/rune`, and a relative path that stays inside the GEM directory after normalization and is listed in `files`.
- Any other specifier fails. In particular: `fs`, `node:fs`, `net`, `node:net`, `dgram`, `dns`, `tls`, `http`, `https`, `child_process`, `worker_threads`, `cluster`, `vm`, `module`, `mongodb`, and any specifier containing `mongodb`.
- A call to `eval` or `Function`, or a member call `process.binding` or `process.dlopen`, fails.
- A string literal matching `https?://` or `mongodb(\+srv)?:\/\/` fails. Guides may contain `https` URLs. This rule is only for code.

### GC-17 Permissions agree

For each rune:

- `network` is `none`.
- `openWorldHint` is false. `destructiveHint` is false.
- If `readOnlyHint` is true, `writes` is empty.
- Every `reads` and `writes` entry matches the schema's access pattern.
- `writes` entries are a subset of the layers and doc prefixes the dispatch wrapper will accept. An entry outside that vocabulary fails closed.

### GC-18 No raw database

On every code file from GC-16, fail if the source contains `MongoClient`, `mongoose`, `collection(`, `.db(`, `getDb`, or `databaseUrl`, even inside a comment. The dispatch wrapper is the only store access, and it is reached through `emet/rune`.

### GC-19 Sandbox

Skip with `skip: no runes` when `runes` is empty. A `runed-gem` must run this check. There is no skip for a `runed-gem`.

The runner starts a separate process for the GEM's code. The requirement is the observable result, not a particular sandbox product:

- The process has no working network. The checker's own canary (a fixture directive that calls `net.connect` to `127.0.0.1:9`) must fail. If that canary succeeds, GC-19 fails for the GEM under test as well. Fail closed.
- Wall clock limit: 5 seconds for each invocation. Memory limit: 128 MB. Exceeding either fails the check.
- The only resolved import is a test double of `emet/rune` that records reads and writes and refuses anything outside the rune's `reads` and `writes`.
- Fixture store: one semantic row whose text is `GEM_CHECK_CANARY_SECRET`, and one document `doc:gem-check-fixture`. Invoke each rune once with an empty object (or the smallest object its `inputSchema` allows).
- Fail if the process's stdout, stderr, or any file it creates contains `GEM_CHECK_CANARY_SECRET`.
- Fail if it writes a file outside the empty work directory the runner created.
- Fail if a read of a layer or doc prefix outside `reads` returns data.
- Fail if a write outside `writes` is recorded.
- A second invocation asks the rune, through its arguments, to return the canary and to write `identity`. The dispatch double refuses. If the rune's result contains the canary, or a write is recorded, the check fails.

### GC-20 EMET range

`requires.emet` matches the schema pattern. The socket (SR-06) checks that the running version satisfies the range. `gem-check` only checks the grammar, unless it is given `--emet-version x.y.z`, in which case a range that excludes that version fails.

Comparators this revision evaluates: exact, `>=`, `^`, `~`, each on a `MAJOR.MINOR.PATCH` version. `^` and `~` use the usual semver bounds (`^1.2.3` is `>=1.2.3 <2.0.0`; `~1.2.3` is `>=1.2.3 <1.3.0`; a leading `0` follows the same shape, so `^0.3.0` is `>=0.3.0 <0.4.0`).

### GC-21 Rune schemas

Each `inputSchema.type` is the string `object`. If `outputSchema` is present it is a JSON object. Annotation keys other than `title` and the four hints fail (the schema already rejects them; this check exists so the report names GC-21).

### GC-22 Code location

Code files (the extensions in GC-04) appear only under `runes/` and only when `kind` is `runed-gem`. Each is listed in `files`.

## Server refusals

These run in the socket, after `gem-check`. They are not all visible from the GEM directory alone.

| Id | Refuse the GEM when |
|---|---|
| SR-01 | The directory is not the release's `gems/<id>/` and the id plus file digests are not on the accepted library list shipped with that release. |
| SR-02 | Activating it would make more than 4 GEMs active. |
| SR-03 | More than 16 GEMs are installed. List the first 16 by id. Refuse the rest with this code. |
| SR-04 | The sum of active floor-file sizes would exceed 16,384 bytes. |
| SR-05 | `overrides` is non-empty and there is no recorded user consent for this id and this set of file digests. |
| SR-06 | The running EMET version is outside `requires.emet`. |
| SR-07 | Reserved. The session is never the thing that fails. SR-07 is not a GEM failure. Initialize returns. |

Consent is bound to the file digests. A new digest needs new consent. `defaultOn: true` does not count as consent when `overrides` is non-empty.

## What a release may load

| GEM | Load when |
|---|---|
| Bundled, `kind` `gem`, checks GC-01 through GC-18 and GC-20 through GC-22 pass, SR-01 through SR-06 pass | The socket release that runs these checks. GC-19 skips. |
| Bundled, `kind` `runed-gem` | The same, plus GC-19 in that release, and the dispatch wrapper is the process's only store access. |
| `distribution` `library` | The same, plus GC-11 against the release's trust store, and SR-01 finds the digests on the accepted list. |

Until those checks exist in a release, the socket loads nothing. A missing checker is not a pass.

## Threats and the checks that hold them

| Threat | Holds it |
|---|---|
| Prompt injection in GEM text | Precedence in SPEC.md. GC-13. The GEM stays off until the user asks, unless a later accepted GEP sets `defaultOn`. Library text also needs GC-11 and the owner's acceptance. |
| Malicious RUNE code | GC-04, GC-10, GC-15, GC-16, GC-18, GC-19. Writes only through dispatch (SPEC.md). No load of `runed-gem` before GC-19 ships. |
| Supply chain | GC-05, GC-11, GC-15, SR-01. The trust store and the accepted list ship with the release, not in the submission. |
| Data exfiltration | `network` `none`, GC-16, GC-17, GC-19 (canary secret and the network canary). |
| Privilege escalation via scopes | GC-02 and GC-17. Annotations are required, so MCP's defaults (read-only false, destructive true, open world true) never apply. Dispatch enforces `reads` and `writes`. The rune cannot set the source tag. |
| Denial of service via size | GC-07, GC-08, GC-09, SR-02, SR-03, SR-04. GC-19 limits time and memory. A refusal does not drop the session. |

Passing this list is necessary. The owner's acceptance is the step that admits a GEM which did not ship inside the EMET release under review. A bot the owner designates may run the checker and sponsor the review. The bot's pass is not acceptance.
