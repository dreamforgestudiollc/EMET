# Conformance and security checklist

Revision 2026-10-12. Normative requirements are in [SPEC.md](SPEC.md). This file is the list `gem-check` implements, and the map from each threat to the checks that hold it.

`gem-check` takes one argument: the GEM (Golem Expertise Module) directory. It reads `gem.schema.json` from the checker package, not from the GEM directory. It reads the trust store `keys.json` from the checker package. A `keys.json` inside the GEM is a failure.

Output is one line per check, on stdout: `GC-01 pass` or `GC-01 fail: <reason>`. A check that does not apply prints `GC-19 skip: no runes`. Exit `0` means every required check passed or skipped as specified. Exit `1` means a failure or an unexpected throw (fail closed). Exit `2` means the argument was missing or not a directory. Stderr is empty on exit 0.

The socket runs the same checks before load, then applies the server refusals (SR) below. A failure refuses that GEM. `emet_initialize` still returns. `gems_available` includes the GEM with `loadable: false` and `reason` set to the first failed id (`GC-05`, `SR-02`, and so on).

## Checks

### GC-01 JSON

`gem.json` exists at the directory root and parses as one JSON object. Trailing commas and comments fail. The directory argument must be a real directory. A symlink fails (`symlink`).

### GC-02 Schema

The object validates against `gem.schema.json` for revision `2026-10-12`. Report the schema path that failed. `changelog`, `knowledge`, and `coverage` are optional. Each accepts a string, a list, or an object. Any other shape fails. A `coverage` list holds at most 256 entries. `update` is optional. It is an object the socket does not read. `class` `initial` is the first release of that GEM. Lean Six Sigma ships `coverage` as a list of 90 entries.

### GC-03 Spec revision

`spec` is a revision this checker supports. This revision supports `2026-10-12` only. Any other value fails, including a newer date and `2026-10-11`.

### GC-04 Files and paths

- Every `files[].path` is unique.
- Each path is relative, uses `/`, does not start with `/`, and does not contain `..` or a backslash.
- The path resolves, after realpath, to a file inside the GEM directory. A symlink that escapes fails (`symlink escapes`). A symlink whose path is `runes` or is under `runes/` fails (`symlink`) and is not followed.
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

Skip with `skip: no code` when `runes/` contains no file. A file under `runes/` whose name does not end in `.js` or `.mjs` fails (`rune extension`). It is not skipped. A `runed-gem` with no code file still fails GC-19, which requires the artifact.

For each such file:

- Parse as an ES module. A syntax error fails.
- `import` and `export ... from` sources, `import()`, and `require()` arguments must be string literals. A non-literal fails.
- Allowed specifiers: a relative path that normalizes to a file under that GEM's `runes/`, is listed in `files`, and whose resolved real path also stays under `runes/`. A `../` that leaves `runes/`, including a listed `../lib/h.js`, fails. GC-04 refuses a symlink under `runes/` before this scan. The resolved real path is the backstop: gem-check records it and `runeSpecifierReason` refuses a real path outside `runes/`. The check is `runeSpecifierReason` in `verification/load-gate/load-gate.mjs`. gem-check calls that function and passes the real path. An import of `emet/rune` fails GC-19. A client RUNE has no store module. GC-16 still allows `emet/rune` so GC-19 can name it.
- Any other specifier fails (`specifier not allowed`). In particular: `fs`, `node:fs`, `node:child_process`, `node:vm`, `net`, `node:net`, `dgram`, `dns`, `tls`, `http`, `https`, `child_process`, `worker_threads`, `cluster`, `vm`, `module`, `mongodb`, a URL, a bare package, a path that normalizes outside the GEM, and any specifier containing `mongodb`.
- The source is parsed with acorn 8.19.0 (`ecmaVersion: "latest"`, `sourceType: "module"`, `allowHashBang: true`), which decodes `\u` escapes before the names are checked. A parse error fails closed (`parse`). There is no second, weaker scan. Source over 65,536 bytes fails before the parse (`too large`). The scanner and its corpus are `verification/load-gate/load-gate.mjs` and `verification/load-gate/corpus.json`. EMET-GEMs vendors those two files byte-for-byte.
- Only the AST node types that walker admits are allowed. Any other node, including one added in a later language edition, fails (`syntax`). That refusal covers `class`, tagged templates, `for await`, and generator functions (`function*`, so `yield Math` fails here). `for-in` fails (`syntax`) even with `const`. Dynamic `import()` fails (`syntax`). `import.meta` fails (`env`).
- `var` fails wherever it appears (`syntax`), including `for (var … of …)`, `for (var … in …)`, and a `var` nested in a function that hides a top-level `const`.
- A parameter, catch binding, `const`, `let`, or function inside a function fails (`syntax`) when its name is also a top-level binding. A parameter may shadow a host global (`function f(values, Date)`); that binding is the parameter, not the global. A loop label is not a binding. A string or a comment is not a reference.
- A free identifier that names a host global fails. Each name is its own rule.
  - `global`: `globalThis`, `global`, `self`, `window`
  - `env`: `process` (including `process.env` and `process.argv`)
  - `clock`: `Date`, `performance`
  - `random`: `crypto`
  - `timer`: `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`, `queueMicrotask`, `requestAnimationFrame`, `cancelAnimationFrame`
  - `Function`: the identifier `Function`
  - `eval`: the identifier `eval`
  - `require`: the identifier `require`
  - `reflect`: `Reflect`
  - `intl`: `Intl`
  - `navigator`: `navigator`
  - `wasm`: `WebAssembly`
  - `atomics`: `Atomics`
  - `proxy`: `Proxy`
  - `weakref`: `WeakRef`
  - `finalizer`: `FinalizationRegistry`
  - `memory`: `SharedArrayBuffer`, `Buffer` (including `Buffer.allocUnsafe`)
  - `intrinsic`: `structuredClone`
- A call to `eval` or `Function`, or a member call `process.binding` or `process.dlopen`, also fails in the text scan that runs before the parse.
- `Math` is admitted only as the object of a direct member read or call whose name is in the scanner's list: `abs`, `acos`, `acosh`, `asin`, `asinh`, `atan`, `atan2`, `atanh`, `cbrt`, `ceil`, `clz32`, `cos`, `cosh`, `exp`, `expm1`, `floor`, `fround`, `hypot`, `imul`, `log`, `log1p`, `log10`, `log2`, `max`, `min`, `pow`, `round`, `sign`, `sin`, `sinh`, `sqrt`, `tan`, `tanh`, `trunc`, `E`, `LN10`, `LN2`, `LOG10E`, `LOG2E`, `PI`, `SQRT1_2`, `SQRT2`. `random` is not in the list. The Math object itself fails (`random`) if it is stored, passed, returned, thrown, spread, destructured (`{ round } = Math`), or written (`Math.round =`). `Math.round(Math.sqrt(n))` inside a function does not. `Math.round(1)` at the top level does, because it is a top-level call.
- `Object`, `Array`, `JSON`, `Number`, `String`, `Boolean`, `RegExp`, and the Error constructors are admitted only as the object of a listed member, or as a call `Array()` / `Object()` / `Number()` / `String()` / `Boolean()`, or as `new Error` / `Error()` (and the same for `TypeError`, `RangeError`, `EvalError`, `ReferenceError`, `SyntaxError`, `URIError`). Listed members: `Object.hasOwn`, `Object.freeze`, `Object.is`, `Array.isArray`, `JSON.parse`, `JSON.stringify`, `Number.isFinite`, `Number.isNaN`, `Number.isInteger`, `Number.isSafeInteger`, `Number.parseFloat`, `Number.parseInt`, `String.fromCharCode`, `String.fromCodePoint`. `RegExp` has no listed members. `RegExp.$1`, `RegExp.lastMatch`, `RegExp.input`, and any other `RegExp` member fail (`intrinsic`), as do `RegExp()` and `new RegExp()`. Storing one (`{ J: JSON }`, `input ? Object : Object`, `input || Object`) fails (`intrinsic`). A shadowed Error constructor (`function f(Error) { return new Error() }`) fails (`module state`).
- These Object members fail on their own rules, reason `intrinsic`: `getOwnPropertyDescriptor`, `getOwnPropertyDescriptors`, `getPrototypeOf`, `setPrototypeOf`, `defineProperty`, `defineProperties`. `Object.create`, `Object.keys`, and `Object.assign` are not listed members, so they fail (`intrinsic`) too.
- `toLocaleString`, `localeCompare`, `toLocaleDateString`, `toLocaleTimeString`, `toLocaleUpperCase`, and `toLocaleLowerCase` fail (`intl`), including a destructuring binding or assignment (`const { toLocaleString: f } = [1]`). `toString` stays admitted.
- A member or literal key named `constructor` fails (`Function`), including `\u0063onstructor`. A member or key named `prototype` or `__proto__` fails (`prototype`), except the property `__proto__: null` inside the freeze pattern below. `{ p: Array.prototype }`, `[Array.prototype]`, and `Array.prototype.push =` fail. `Error.prepareStackTrace`, `Error.stackTraceLimit`, `Error.captureStackTrace`, and `.stack` fail (`intrinsic`).
- `.call`, `.apply`, and `.bind` fail (`module state`).
- A member write (`=`, `+=`, `++`, `delete`) fails (`module state`) unless the object is an object or array literal created in that function (`const o = {}; o.a = 1`). A write through a parameter, a getter return, a destructured table, or a prototype fails.
- A computed member key fails (`computed key`) unless it is one of these:
  - a string, number, boolean, or null literal, or a `const` whose initializer is that literal directly (not another name, not a call, not a member), and the value is not `constructor`, `__proto__`, or `prototype`. `values[0]` and `const index = 0; values[index]` pass. A `let`, a `var`, a parameter, a `for` index, a template, concatenation, `join`, `fromCharCode`, and `''[k][k]` / `[][k][k]` / `fn[k]` fail.
  - a read of a top-level frozen table, inside a guard this walker recognizes. There is no loop-index exception. `FACTORS[input.n]` with no guard fails. The key is one `const` binding, the same binding in the guard and in the read, and that binding is a primitive before the guard: `const n = String(input.n)` or `const n = Number(input.n)` (one argument, callee not shadowed, not `new`), or a `typeof` check for `'string'` or `'number'`. A `for (const k of input.keys)` binding is that const, and the loop still needs `String(k)`, `Number(k)`, or a `typeof` check on `k` before the read. Recognized checks are `typeof n === 'string'`, `typeof n === 'number'`, either side of `===` / `!==`, joined as `typeof n === 'string' || typeof n === 'number'`, or an early `if (typeof n !== 'string' && typeof n !== 'number') return` (a single `!== 'string'` or `!== 'number'` also counts). `typeof n !== 'object'` is not a check. The early `typeof` exit and the early `hasOwn` exit are each one abrupt statement (`return`, `throw`, `break`, or `continue`), or a block whose only statement is one of those. A member (`input.n` read twice), a `let`, a parameter, a call, a const object (`const k = input.key`, including one whose `toString` or `Symbol.toPrimitive` returns one own key and then another), and a second `const` of the same name in an inner block fail (`computed key`). The recognized guards are: `if (Object.hasOwn(TABLE, n))` around the read; `if (!Object.hasOwn(TABLE, n)) return` (or `throw`, `break`, `continue`) and then the read later in that block; `Object.hasOwn(TABLE, n) ? TABLE[n] : …`; `Object.hasOwn(TABLE, n) && TABLE[n]`; `!Object.hasOwn(TABLE, n) || TABLE[n]`. The opposite polarity fails. The guard does not extend into a nested function. The guard's non-own-key safety rests on the table being frozen with a null prototype, so a key that is not an own property reads `undefined`. Forcing the key to a string or a number, or proving that type with `typeof`, keeps the checked key the same as the key that is read.
- A computed key in a binding or assignment pattern is a string or number literal, and that literal is checked for `constructor`, `prototype`, `__proto__`, and locale names. This is the same check for a declaration, a parameter, a default, a nested pattern, a `catch`, a `for-of`, and an assignment (`({ [k]: c } = …)`). A member (`const { [x.k]: c } = () => {}`), a concatenation (`['constr' + 'uctor']`), and a const (`const m = 'toLocaleString'; const { [m]: f } = [1]`) fail (`computed key`). The literal form `const { ['toLocaleString']: f } = [1]` fails (`intl`). `m['call']`, `m['apply']`, and `m['bind']` fail (`module state`) the same way `.call`, `.apply`, and `.bind` do.
- The only top-level call is the freeze pattern. A table is `Object.freeze` of an object literal that has `__proto__: null`, or `Object.freeze` of an array, nested the same way. Nested objects repeat `__proto__: null`. Values are primitives or the same pattern. No methods, no spreads, no other `__proto__`, no `constructor` or `prototype` key. A dynamic index is admitted only on the object form, and only inside a guard above. Arrays take literal indexes only, because an array still has a prototype.
- A table binding may be the object of a member read or the first argument of `Object.hasOwn`. It fails (`module state`) if it is passed (`id(T)`, `m.call(null, T)`, `[T].forEach`, `Object.is(T, k)`), spread, returned, thrown, stored, destructured, or method-called (`T.l.sort`, `push.apply`). `Object.seal` is not `Object.freeze`. `.freeze` counts only when the callee object is the unbound identifier `Object`; `JSON.freeze` is not a table (`intrinsic`). An object literal without `__proto__: null` is not a table. Reading `FACTORS[n].A2` passes when `n` is the primitive `const` above and every row's `A2` is a primitive. `const row = FACTORS[n]` fails, because that binds the row object. A dynamic index of a frozen array fails.
- Any other top-level call fails (`module state`): `JSON.parse`, `'ab'.split('')`, `Array(0)`, an IIFE, `Math.round(1)`. `new` fails (`module state`) except the Error constructors, so `new Map()` fails inside a function too. A top-level `let` or `var` fails. A top-level `const` may be a primitive literal, the freeze pattern, a function, or an imported binding. An unfrozen object or array at the top level fails. A property write on a parameter fails, including one hidden in a default (`function g(s = (g.s = {}))`).
- A string literal matching `https?://` or `mongodb(\+srv)?:\/\/` fails. Guides may contain `https` URLs. This rule is only for code.

### GC-17 Permissions agree

For each rune:

- `network` is `none`.
- `openWorldHint` is false. `destructiveHint` is false.
- If `readOnlyHint` is true, `writes` is empty.
- Every `reads` and `writes` entry matches the schema's access pattern.
- `writes` entries are a subset of the layers and doc prefixes the dispatch wrapper will accept. An entry outside that vocabulary fails closed.

### GC-18 No raw database

On every code file from GC-16, fail if the source contains `MongoClient`, `mongoose`, `collection(`, `.db(`, `getDb`, or `databaseUrl`, even inside a comment. A client RUNE has no store access. GC-19 fails an import of `emet/rune`.

### GC-19 Artifact hash and load gate

Skip with `skip: no runes` when `runes` is empty. A `runed-gem` must run this check. There is no skip for a `runed-gem`.

This check does not run RUNE code. The socket MUST NOT execute RUNE code. [GEP-0003](proposals/GEP-0003-client-side-execution.md) replaces the sandbox probe recorded in GEP-0002. The checker implements this section.

For each rune:

- `execution` is `client`. `artifact` names a file listed in `files`, under `runes/`. That file exists, and the digest of its raw bytes equals the rune's `sha256`. A missing file or a mismatch fails. The digest comparison reuses the same hash helpers as the file pin.
- `reads` is empty and `writes` is empty. `readOnlyHint` is true. `network` is `none`.
- The source does not import `emet/rune`.
- A static load-gate scan, the same one as GC-16, finds no network APIs, no dynamic `import()`, no computed `import()` path, and none of the reaches GC-16 lists. `Math.round` and `Math.sqrt` inside a function are not reaches. A literal index and a `const` bound directly to a primitive literal are not reaches. A frozen null-prototype table read inside a recognized `Object.hasOwn` guard is not a reach when the key is one `const` primitive (`String(...)`, `Number(...)`, or a recognized `typeof` check for `'string'` or `'number'`). A member, a `let`, or a const object used as that key is a reach. A loop index used as a computed key is a reach. A loop label is not a reach. `input.y.at(i)` is a method call, not a computed member. If GC-16 failed, GC-19 fails. That dependency is kept on purpose.
- Any failure of this check fails the rune and refuses the GEM. The session stays up.

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
| SR-08 | `gem.json` `released` is not the boolean `true`. `false`, the string `"true"`, `1`, and `null` fail. A missing field is allowed only for `neurendipity` 1.2.3 and `fieldnote` 1.0.1 when the id, the version, and every file digest match the pin in the socket. A shorter file list does not match. The pin covers the id, the version, and the file digests. It does not cover every other manifest field, including `defaultOn`, `priority`, `requires`, `description`, `name`, `authors`, `license`, rune `description`, schemas, the guides list, `distribution`, `coverage`, and rune metadata other than the version. `overrides` still needs SR-05 consent. A rune `execution` of `server` and `distribution` `library` are refused by GC-02. `gem.json` is not hashed: anyone who can edit it can already add `released: true`, so hashing it would grant nothing extra. Any other GEM missing the field is refused, including a bumped version of those two. The check runs on every boot. A read error refuses that GEM and does not turn the check off. The socket logs the value that failed. A missing field on `neurendipity` or `fieldnote` that missed the pin says `(legacy pin mismatch: version/digests)`. An unpinned GEM does not get that hint. |

Consent is bound to the file digests. A new digest needs new consent. `defaultOn: true` does not count as consent when `overrides` is non-empty.

## What a release may load

| GEM | Load when |
|---|---|
| Bundled, `kind` `gem`, checks GC-01 through GC-18 and GC-20 through GC-22 pass, SR-01 through SR-06 pass | The socket release that runs these checks. GC-19 skips. |
| Bundled, `kind` `runed-gem` | The same, plus GC-19 in that release, and the socket does not execute the RUNE code. |
| `distribution` `library` | The same, plus GC-11 against the release's trust store, and SR-01 finds the digests on the accepted list. |

Until those checks exist in a release, the socket loads nothing. A missing checker is not a pass.

## Threats and the checks that hold them

| Threat | Holds it |
|---|---|
| Prompt injection in GEM text | Precedence in SPEC.md. GC-13. The GEM stays off until the user asks, unless a later accepted GEP sets `defaultOn`. Library text also needs GC-11 and the owner's acceptance. |
| Malicious RUNE code | GC-04, GC-10, GC-15, GC-16, GC-18, GC-19. The socket does not execute the code (SPEC.md). No load of `runed-gem` before this GC-19 ships. |
| Supply chain | GC-05, GC-11, GC-15, SR-01. The trust store and the accepted list ship with the release, not in the submission. |
| Data exfiltration | `network` `none`, GC-16, GC-17, GC-19 (the hash pin and the static load-gate scan: no network APIs). The client sandbox is not a claim EMET makes. |
| Privilege escalation via scopes | GC-02, GC-17, and GC-19. Annotations are required, so MCP's defaults (read-only false, destructive true, open world true) never apply. `reads` and `writes` are empty. The rune cannot set the source tag. |
| Denial of service via size | GC-07, GC-08, GC-09, SR-02, SR-03, SR-04. Wall-clock and memory limits during a run are the client's. A refusal does not drop the session. |

Passing this list is necessary. the owner's acceptance is the step that admits a GEM which did not ship inside the EMET release under review. A bot he designates may run the checker and sponsor the review. The bot's pass is not acceptance.
