# GEP-0003: Client-side execution of RUNED directives

**Status:** Accepted (Alex, 2026-10-16)
**Date:** 2026-10-16
**Approver:** Alex
**Sponsor:** the hub (a sponsor does not approve)
**Spec revision:** 2026-10-11
**Supersedes:** [GEP-0002](GEP-0002-runed-sandbox-contract.md)

Accepted means the decisions below are the ones to build. It is not Final. Final waits on the code change that follows this GEP, on GC-19 as restated here, and on the pilot measure below. Alex can revise any row in this file before it is Final.

## Summary

The socket serves RUNED code. It does not run it. On 2026-10-16, production deploy `commit-034c4b7f` (commit `commit-08bd39f`) logged `GEM refused: fieldnote GC-19 fail: sandbox unavailable (user namespaces blocked)`. GC-19 failed closed, and fieldnote could not load. A new host or a separate sandbox service would rebuild a sandbox every calling AI already has.

A client RUNE is a pure function. `reads` and `writes` are empty, and the code does not import `emet/rune`. While its GEM is active, the socket registers one read-only tool per RUNE. That tool returns the RUNE's code, inputs, outputs, description, and served hash. The calling client runs the code in its own sandbox. EMET never runs it as a fallback. A kept result goes through the existing governed doors. It is a record of what the client attested, replayable from recorded inputs, not a result EMET re-executed.

This is a carve-out from charter commitment 1, stated on the Extension-socket row: EMET verifies the record, not the computation. EMET supports the organization's document and record controls (ISO 9001 7.5.3 / ISO 13485 4.2.5). It claims no certification and no conformity. The organization validates EMET and any GEM for its own use. The served code is a controlled document. A kept result is a record of a claim, not a verified output. The ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording elsewhere is unchanged by this GEP.

## the owner's decision

Alex accepted client-side execution on 2026-10-16, with one change to the r3 design. The tool is one per RUNE, not the single `emet_gem_artifact`.

Each active RUNE is its own entry in the tool list, named `gem_<gem>__<rune>` (the GEM `id`, then `__`, then the RUNE `name`). The name reuses the existing reservation of core tool names. `readOnlyHint` is true, `openWorldHint` is false, and the scope is `emet.read`. A call checks the RUNE against the active GEMs and the hash pin, then returns `{code, sha256, version, runtime, instructions, inputSchema, outputSchema, description}`. It runs nothing. The tools/list entry carries that RUNE's description, input schema, output schema, runtime, and served sha256, and the description says the call returns the code and does not run it. The served code counts toward the GEM's byte cost. The startup text names each active RUNE's runtime, inputs, outputs, and served sha256 before consent.

With `reads` and `writes` empty, there is nothing per RUNE to consent to beyond the GEM's own activation. Consent, activation, retire, cost, and the monorail gates stay as they are.

## The contract

Normative text is [SPEC.md](../SPEC.md) sections 10 to 12 and [CONFORMANCE.md](../CONFORMANCE.md) GC-19. The points the code change must meet:

1. **The socket MUST NOT execute RUNE code.** No in-process runner, no separate-process sandbox, and no fallback that runs the code when the client has no sandbox. A client without a sandbox has no result and must say so.
2. **Pure functions.** `execution` is `client`. `reads` and `writes` are empty. The RUNE does not import `emet/rune`. No client shim of `emet/rune` is offered. The client reads through the normal EMET tools and passes those values in.
3. **One tool per RUNE**, as decided above. Not `emet_gem_artifact`.
4. **Guarantees that move to the client.** EMET does not claim process isolation, wall-clock and memory limits, a network denial once the code is in the client's sandbox, output caps during the run, or correctness of the result. `openWorldHint: false` describes the served code. EMET still applies its write floors to anything written back.
5. **Records.** The six controls in SPEC.md §10. The input-hash sentence is: each result records a sha256 of its inputs, or a reference to them. The input hash is reported by the client, so it does not make a result replayable on its own. A replayable result also needs its inputs kept or refetchable.
6. **Fieldnote is off by default.** It is rewritten as a pure function: the client reads `working` and passes the rows in, and fieldnote declares `reads: []`. Turning it on for the pilot needs the owner's separate OK.

## What holds it

Two controls, both in the code change that follows this GEP. An instruction to be careful is not one of them.

1. **Guard test.** The test fails if `src/` or `gems/` contains `child_process` or `spawn`, or an import of a RUNE runner. The allow-list is `src/gem-check.js`'s own `node --check` call and its banned-import list entry, matched in code and not in comments. A companion test adds a new spawn and confirms the guard still catches it.
2. **Load gate.** GC-19 is a hash-and-manifest check plus the static scan in CONFORMANCE.md GC-16. The artifact exists, its digest matches, and the served code has none of the reaches that section lists. A failure refuses the GEM. GC-19 does not run the code. The dependency on GC-16 is kept.

## Charter commitment 6

1. **Failure it fixes, and where it is on record.** Fieldnote cannot load. Production deploy `commit-034c4b7f` (commit `commit-08bd39f`), about the recorded time on 2026-10-16, logged `GEM refused: fieldnote GC-19 fail: sandbox unavailable (user namespaces blocked)`. The earlier `bash missing` failure was fixed before that deploy. This one was observed.
2. **What it replaces or retires.** GEP-0002, kept as a record and marked superseded. The code change removes the server sandbox rather than leaving it dormant: `src/rune-confine.c`, `src/rune-setup.sh`, `src/rune-sandbox.js`, `src/rune-child.js`, `src/rune-bridge.js`, `src/rune-hooks.js`, `src/rune-loader.js`, `tests/rune-sandbox.test.js`, and `scripts/alpine-sandbox-smoke.sh`. It also removes the GC-19 sandbox probe, the `alpine-sandbox` CI job, the `EMET_REQUIRE_SANDBOX=1` setting, and the sandbox packages in the image. `rune-registry.js` and `rune-scope.js` stay. `rune-dispatch.js` becomes the serve path. Scope tests and the guard test move. They are not deleted.
3. **How will we know it worked?** In a pilot with fieldnote enabled, the fieldnote tool serves fieldnote, GC-19 (the hash check) passes, and a kept result carries a served sha256 that matches the serve log and an input hash. Enabling fieldnote for that pilot needs the owner's separate OK.
4. **What holds it once it works?** The guard test and the GC-19 load gate above. Changes to this contract only by a later GEP Alex accepts.

## Out of scope

Signing artifacts. A creator keyring. Library GEMs from outside the release, beyond the library gate already specified. Enabling fieldnote. The code change itself, which follows this GEP and does not land in the same pull request.
