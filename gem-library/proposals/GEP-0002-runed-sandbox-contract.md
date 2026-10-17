# GEP-0002: RUNED sandbox contract (review gate for socket PR 5)

**Status:** Superseded by [GEP-0003](GEP-0003-client-side-execution.md) (Alex, 2026-10-16)
**Date:** 2026-10-14
**Approver:** Alex
**Sponsor:** the hub (a sponsor does not approve)
**Spec revision:** 2026-10-11

Superseded means this file is the record of the sandbox contract. It is not the contract in force. It was Accepted on 2026-10-14. Alex set Superseded on 2026-10-16 when he accepted GEP-0003. The text below is kept. It is not deleted.

## Summary

This GEP freezes the isolation contract for RUNED directives before socket PR 5 ([ROADMAP](../../docs/ROADMAP.md), GEM socket, PR 5) is coded. It collects the rules in [SPEC.md](../SPEC.md) sections 10 to 12 and [CONFORMANCE.md](../CONFORMANCE.md) GC-19 into one numbered list, adds the stricter rules marked **[stricter than SPEC]** (each with a test), and makes that list the review gate the reviewer applies to PR 5. The implementation may be stricter than this list. It may not be looser.

EMET's function stays memory. The core floor, the Charter, per-client attribution (registered source tag, session id, load id, receipt), and the ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording are unchanged by this GEP and by PR 5. A RUNED directive is a tool inside that system. It does not make EMET a generic tool host or a generic memory server.

## The contract

The items below were the review gate for socket PR 5. [GEP-0003](GEP-0003-client-side-execution.md) retires them. Each item was a MUST for any release that loaded a `runed-gem` under this contract. Source in brackets. Text marked **[stricter than SPEC]** is a rule SPEC 10–12 and GC-19 do not state. Accepting this GEP adopts it, and CONFORMANCE.md gains the matching fixtures in PR 5. Each item names the test that proves it.

1. **Separate process.** RUNED code runs in a separate OS process. No in-process isolation is accepted (`vm`, `worker_threads`, realm shims). [SPEC 11] *Test:* a directive reports `process.pid`; it differs from the server's and is a distinct OS process.
2. **Limits.** [SPEC 12; GC-19: 5 s, 128 MB] **[stricter than SPEC]** in how they are measured:
   - wall clock 5 s and CPU time 5 s per invocation, enforced separately;
   - 128 MB on the whole process tree (RSS or cgroup `memory.max`), not V8 heap alone;
   - on a limit, the runner kills the process group or cgroup, children included, and confirms the kill by reaping the exit;
   - process count cap 1 (no fork or spawn) and open-fd cap 32.
   *Test:* fixtures that spin 6 s, sleep 6 s, allocate 200 MB, fork a child that outlives the parent, and fork-bomb. Each is killed at the limit, no process remains, and GC-19 fails the rune. The behaviour on a kill (refused call, session kept) is **[stricter than SPEC]**; *test:* the session answers a next call.
3. **No network, denied by the OS.** `network` MUST be `none` [SPEC 10, 11]. Node's global `fetch` and `WebSocket` need no import, so the deny is at the OS level (network namespace or seccomp), not in JavaScript. **[stricter than SPEC]** The GC-19 canary at `127.0.0.1:9` is replaced by runner-owned probes, because that port refuses even when the network is open. *Tests*, each must fail from inside the sandbox:
   - TCP to a listener the runner opens on 127.0.0.1 and on ::1; the runner asserts no connection arrived;
   - DNS resolution of a name;
   - a UDP send to a runner-owned UDP socket;
   - TCP to an external address;
   - unix-domain sockets, including the server's own.
   If any probe connects, every RUNED GEM fails. Fail closed.
4. **Import allow-list, plus OS file denial.** Only `emet/rune` and files listed in the GEM's manifest resolve [SPEC 12]. **[stricter than SPEC]** Named escape routes are blocked, one fixture each, each expected to fail:
   - Node built-ins, packages, `require`;
   - `module.createRequire`;
   - `import()` of `data:`, `file:` and `node:` URLs;
   - `process.binding` and `process._linkedBinding`;
   - `process.dlopen` and `.node` native addons;
   - `WebAssembly`;
   - `--experimental-loader`, `--import` and `NODE_OPTIONS` (the runner sets the flags and ignores the inherited ones).
   An allow-list alone is not isolation. It is paired with item 1, item 5 and OS-level filesystem denial (Node `--permission` with `--allow-fs-read`/`--allow-fs-write` limited to the GEM directory and work directory, plus item 5's separate uid or namespace).
5. **No database handle, clean start.** No database handle, connection string or collection object [SPEC 10]. **[stricter than SPEC]**:
   - an explicit allow-listed env (empty by default), never the parent's `process.env`;
   - only fds 0–2 inherited;
   - argv free of secrets;
   - a private temp dir inside the work directory;
   - a separate uid or pid/mount namespace, so `/proc/<ppid>/environ`, the server's `.env` and `keys.json` cannot be read.
   *Test:* the child dumps `process.env`, `process.argv`, `/proc/self/fd` and attempts `/proc/<ppid>/environ`, `.env` and `keys.json`. None contains `MONGODB_URI`, the OAuth passphrase or the fixture secret, and the reads fail.
6. **Declared reads and writes, as store scopes.** `reads` and `writes` are allow-lists of layers or `doc:` prefixes [SPEC 10]. They govern the store through `emet/rune`, not the filesystem (item 7). The dispatch wrapper refuses an undeclared access at runtime, and GC-19 proves it; both are required [SPEC 11]. `readOnlyHint: true` forces empty `writes`. `destructiveHint` and `openWorldHint` are `false`. A missing hint refuses the GEM [SPEC 10, 12]. **[stricter than SPEC]** Prefix matching is on whole path segments: `doc:foo` matches `doc:foo` and `doc:foo/...`, not `doc:foobar`. *Test:* undeclared read and write fixtures, a `doc:foobar` probe under `doc:foo`, read-only-with-writes, and a missing hint are all refused.
7. **Filesystem: the work directory only.** **[stricter than SPEC]**:
   - writes only inside the runner's empty work directory [GC-19], enforced by the OS (item 4), so a check-then-write race (TOCTOU) cannot cross it;
   - paths are resolved through symlinks, and `..` traversal out is refused;
   - the work directory is capped at 1 MB.
   *Test:* a write via `..`, a write via a symlink to outside, and a 2 MB write. Each fails, and nothing appears outside.
8. **One write path, server-owned attribution.** RUNED writes use the same dispatch: session id, load id, monorail order, receipt, board guard, size floors. No GEM exemption flag exists [SPEC 10]. The server stamps the caller's registered source tag and `metadata.gem` = `id@version`. A directive cannot choose its source tag, and a mismatched `metadata.gem` is refused [SPEC 10, 12]. *Test:* a dispatch spy shows those fields on a RUNED write. A grep finds no exemption flag. A rune passing its own source tag or a forged `metadata.gem` is refused.
9. **No leakage** [GC-19, its wording]. Fixture store: one semantic row `GEM_CHECK_CANARY_SECRET` and `doc:gem-check-fixture`. The check fails if that secret appears on stdout, stderr, or in any file the process can write (the work directory, given item 7). On a second invocation, the rune's arguments ask for the canary and for an `identity` write. The dispatch double refuses the call. If the rune's result contains the canary, or a write is recorded, the check fails.
10. **Output caps.** **[stricter than SPEC]** 64 KB each for stdout and stderr, and 256 KB for the result. Over a cap, the stream is truncated at the cap and the call refused. Output is never buffered whole. *Test:* a fixture that prints 10 MB stays within the cap in server memory and is refused.
11. **Concurrency.** **[stricter than SPEC]** One sandbox at a time per session, and at most 2 per server. The server's event loop never waits synchronously on a sandbox. *Test:* three parallel calls from one session run one at a time, and `emet_status` answers while a 5 s rune runs.
12. **Load scope.** PR 5 loads only bundled RUNED GEMs from the release's `gems/<id>/`, digest-pinned. Store copies, user paths and downloads are refused even with matching digests [SPEC 11]. The reference RUNED GEM is bundled and off by default [ROADMAP PR 5]. *Test:* each of those three copies is refused.

### Side channels (noted, not closed)

How long a call takes and how much memory it uses can show how much store data a rune touched. Item 11 limits starvation of the server. This revision does not pad timing. A later GEP may.

## Review gate

the reviewer reviews PR 5 against items 1 to 12 and checks each one off by test name or code location in the review. PR 5 does not merge while any item is unmet, waived, behind a flag, or deferred to a later PR. A change to any item needs a later GEP that Alex accepts. A code comment, config default, or test skip is not that GEP. GC-19 has no skip for a `runed-gem`.

## Charter commitment 6

1. **Failure it fixes.** Without a frozen contract, PR 5 could ship a weaker sandbox (in-process, network allowed, a DB handle "for speed") and the spec text would trail the code. On record: SPEC 11 states Node has no in-process sandbox this standard accepts; ROADMAP PR 5 names the sandbox and network canary as scope.
2. **What it replaces.** The GC-19 network canary at `127.0.0.1:9`, which passes on an open network, is replaced by item 3's probes. Everything else gathers or tightens the existing SPEC and GC-19 rules.
3. **Measure.** The PR 5 review shows all 12 items checked with evidence, and GC-19 passes in CI with every item 3 probe failing to connect. Checked in the PR 5 pilot.
4. **What holds it.** GC-19 in CI, the dispatch wrapper at runtime, and this GEP as the review gate. Changes only by a GEP Alex accepts.

## Out of scope

Network capability, library GEMs, signatures and `keys.json`, declarative directives, and monorail switches that pick a GEM. Each waits for its own proposal.
