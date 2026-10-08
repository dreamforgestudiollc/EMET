# EMET benchmarks — implementation language evaluation

**Run 2026-09-08. Four implementations, one specification, live MongoDB Atlas, identical hosting.**
**Conclusion: EMET stays on JavaScript — on measurement, not by default.**

---

## Why this exists

A programmer friend of the maintainer suggested that a more object-oriented or compiled
language — Java, Python, C++, and Rust in particular — would likely be faster than Node and
serve EMET better long term. That is a reasonable prior and it deserved a real answer rather
than a defence of the status quo.

Two questions were separated, because they have different answers and different costs:

1. **Language** — is JavaScript the right substrate for EMET's backend?
2. **Durability** — which practices have legs, independent of language?

This document reports the first. It also reports the thing the exercise actually produced,
which was not a language choice.

**Nothing here argues from intuition about language speed.** Every number was measured, and
every limit of the measurement is stated.

---

## Method

**One specification, implemented once per language, as a single file with the tasks as
functions inside it** — so connection, configuration, fixtures, timing and output are written
once per language and shared by every task, rather than drifting across eight separate scripts.

Each implementation ran as its own service on the same platform (Railway, region `sfo`),
against the **same live MongoDB Atlas cluster**, reading the **same fixtures file**, writing to
throwaway `bench_*` collections that never touch EMET's own data.

### Equivalence — checked before any timing was read

Two digests are computed by every implementation: a fixed canonical string, and the **masked**
form of a secret-bearing fixture. If they differ, the implementations are not doing the same
work and no timing means anything.

| language | canonical probe | masked secret |
|---|---|---|
| javascript | `feb7628ae8a0…` | `15a3c529bee0…` |
| python | `feb7628ae8a0…` | `15a3c529bee0…` |
| go | `feb7628ae8a0…` | `15a3c529bee0…` |
| rust | `feb7628ae8a0…` | `15a3c529bee0…` |

**Identical across all four.** This check is what separates a benchmark from four programs
that happen to run.

### Clock points

Per task the implementations record `t_total`, and `t_driver` — the summed duration of every
awaited database call. `t_inproc = t_total − t_driver` is the language's own work: hashing,
masking, serialisation, validation, receipt construction.

⚠ **The split is not clean, and the report does not pretend otherwise.** BSON encoding and TLS
happen *inside* the driver call and are genuinely language and driver work counted in
`t_driver`. The two buckets are therefore "in-process work outside the driver call" and
"driver call duration". **No single "language speed" number is produced, because none would be
honest.**

Percentiles are p50 and p95, never mean.

### Tasks

`T1` connect · `T2` write through the full door (mask, digest content and metadata, insert,
read back, verify) · `T3` structured read with filters · `T5` supersession write · `T6`
document write with archive and sha256 read-back · `T9` 300 KB document write · `T10` 300 KB
server-side read-modify-write · `T11` bulk write of 100 records.

The 300 KB size is not arbitrary: it is the size of a real EMET thread document.

---

## Results — in-process work, p50 milliseconds

| task | javascript | python | go | rust |
|---|---|---|---|---|
| T2 door write (small) | 0.141 | 0.088 | 0.046 | **0.033** |
| T3 structured read | 0.037 | 0.030 | **0.007** | **0.007** |
| T5 supersession write | 0.132 | 0.070 | 0.029 | **0.027** |
| T6 document write (small) | 0.314 | 0.180 | 0.227 | **0.089** |
| **T9 300 KB write** | 1.198 | 12.185 | **45.540** | **1.092** |
| T10 300 KB read-modify-write | 0.763 | 0.599 | 0.850 | **0.428** |
| T11 bulk 100 records | 0.784 | 0.610 | 1.290 | **0.244** |

### The finding that matters — where the 300 KB in-process time goes

| step | javascript | python | go | rust |
|---|---|---|---|---|
| **mask (regex passes over 300 KB)** | **0.592** | 11.642 | **44.845** | 0.769 |
| sha256 (300 KB) | 0.211 | 0.226 | 0.340 | **0.156** |

**Masking is the entire story, and it inverts the premise the exercise began with.**
JavaScript is the *fastest* of the four at it: V8's JIT-compiled engine beats Rust's `regex`
crate and is **75× faster than Go's RE2**. A compiled language turned out to be the slowest
implementation in the benchmark, by an order of magnitude, at the operation that dominates.

### Total latency and what it means

| task | javascript | python | go | rust |
|---|---|---|---|---|
| T2 | 136.1 | 139.7 | 138.5 | 123.2 |
| T6 | 542.7 | 560.9 | 558.0 | 491.4 |
| T9 | 209.5 | 226.5 | 264.4 | 190.5 |
| T11 | 73.8 | 74.2 | 76.6 | 65.2 |

⚠ **No language ranking should be read from this table.** These are dominated by the Atlas
round trip. The spread between languages (10–20%) is the same order as ordinary network
variance, and each language was run once, not interleaved.

**For JavaScript and Rust, in-process work never exceeds ~1% of any operation.** Go reaches
17.2% on T9, entirely because of the regex.

---

## Results — concurrency

The serial numbers leave one question open: does a single-threaded runtime degrade when
several callers hit it at once? That is measured with **concurrent inbound requests** — what
the condition actually looks like against a live server — each performing one 300 KB mask and
digest with **no database**, so nothing hides behind network latency.

| | conc | throughput/s | in-process p50 ms | in-process p95 ms |
|---|---|---|---|---|
| **javascript** | 1 | 10.92 | 1.250 | 1.555 |
| | 4 | 37.22 | 0.878 | 1.430 |
| | **16** | **59.62** | **0.904** | **1.413** |
| **rust** | 1 | 10.75 | 2.249 | 4.628 |
| | 4 | 35.73 | 2.420 | 6.452 |
| | **16** | 57.72 | 2.619 | 4.359 |
| **go** | 1 | 6.90 | 47.116 | 64.208 |
| | 4 | 21.97 | 55.600 | 75.655 |
| | **16** | 50.88 | 73.791 | 126.559 |
| **python** | 1 | 8.93 | 18.126 | 25.698 |
| | 4 | 21.35 | 43.540 | 76.169 |
| | **16** | **15.26** ⬇ | 46.095 | 112.792 |

**JavaScript wins outright: highest throughput at every level, lowest in-process latency, and
the flattest curve** (1.250 → 0.904 ms from concurrency 1 to 16 — it *improves* as the JIT
warms). Rust is a close second and scales cleanly. Go degrades 57%. **Python's throughput
collapses past concurrency 4** — textbook GIL contention.

**The mechanism matters more than the ranking.** Node's single thread was never the bottleneck
because the per-request CPU cost is small: 0.5 ms of masking does not saturate an event loop.
Python fails on the *same* architecture because its mask costs 35× more. **Being
single-threaded is only a liability when each request is expensive — which is an argument for
making requests cheap, not for changing language.** And Go had cores to spread across and still
lost: **parallelism does not fix a slow inner loop.**

⚠ **Core counts:** `os.cpus()` (Node) and `runtime.NumCPU()` (Go) reported **48** — the *host*
count; those APIs ignore the container's cgroup quota. Rust's `available_parallelism()`
respects it and reported **8**. The honest figure is ~8 usable cores, which **strengthens** the
result: the multi-core runtimes genuinely had room and still did not win.

---

## Standards provenance

Beyond performance, the maintainer set a standing priority on candidates provable against
confirmed standards. Verified 2026-09-08:

| candidate | language standard |
|---|---|
| **JavaScript** | **ECMA-262 and ISO/IEC 16262** — dual-standardised |
| C# | ECMA-334, plus an ISO/IEC edition |
| Java | **No ISO or ECMA standard.** Governed by the JCP, the JLS (JSR 901) and a TCK — a rigorous but vendor-administered regime |
| Rust | No language standard. A *qualified toolchain* exists (Ferrocene, TÜV SÜD: ISO 26262 ASIL D, IEC 61508 SIL 3, IEC 62304 Class C) — a different guarantee, aimed at safety-critical software |
| Go, Python | No standards-body specification found |

**JavaScript is the only candidate with an international language standard.** TypeScript, often
proposed as the cheap improvement, has none at all — it is a vendor-controlled superset, and
adopting it would trade a standard for a governance model.

⚠ The ISO edition of ECMAScript (16262:2011) lags ECMA-262's annual editions considerably.
The stamp is real; its currency is not.

---

## Conclusion

**EMET stays on JavaScript**, and the decision rests on two independently measured legs:

1. **Standards** — the only dual-standardised candidate.
2. **Performance, serial and concurrent** — the difference is not merely negligible; **it
   favours JavaScript**, which posted the highest throughput and lowest in-process latency at
   every concurrency level tested.

The port was never competing for much. In-process work is ≤1% of any operation, because
**EMET is round-trip-bound, not compute-bound.** Against that, a port would have to re-earn
**673 test assertions across 17 suites**, counted for the 2026-09-08 run (the current suite is larger; the README states that count), the single write path, two transports and a proven
OAuth flow.

### What the exercise actually produced

Not a language choice — **a function to optimise.**

The benchmark identified the write-path scrubber as the dominant in-process cost. Profiling the
real implementation on a 300 KB body found something the benchmark alone could not:

| case | before | after |
|---|---|---|
| clean prose, no secrets | 6.401 ms | **0.962 ms** |
| secret-bearing | 7.251 ms | **3.549 ms** |

**Nine tenths of the worst case was being paid by documents containing nothing to redact** —
the cost was scanning, not replacing. Three causes: a regular expression compiled per literal
*on every call*, the literal registry re-sorted every call, and four pattern rules scanning the
full body unconditionally. Fixed by caching the order, using plain substring operations for
literals, and giving each rule a **necessary-condition prefilter**.

Behaviour is unchanged and that was the acceptance criterion: **hit counts are identical on
every case and the redaction suite passes untouched.** A prefilter that changed what got masked
would be a defect, not an optimisation.

**This saves ~3.7 ms per large write. The gap between the fastest and slowest reasonable
language candidate was ~0.1 ms.** The function was worth roughly thirty times the port.

---

## What was not measured

Stated plainly, because a report that only lists what it proved is advocacy.

- **MCP over streamable HTTP, and OAuth, were not implemented in any candidate.** They measure
  what an SDK *can do*, not how fast it is. **They remain the only substantive reason to build
  further implementations.**
- **Stranger-install cost was not measured.** A single compiled binary needs no runtime where
  Node does, and the `.mcpb` bundle format supports Node, Python and compiled binaries with
  dependencies bundled — which narrows the gap by an unknown amount. **That question is settled
  by an install on a clean machine, not by benchmarking.** It is the open axis.
- **Vector search** was excluded: it needs an index provisioned on the bench collection, and
  embedding happens server-side, so it carries almost no signal about language.
- **One run per language, not interleaved or repeated.** All services ran in `sfo` while the
  production service runs in US East; same-region running would shrink driver times and raise
  in-process shares by a projected factor of ~3 — without changing the ranking.
- The concurrency runs used a **simplified masker**, not EMET's production scrubber. Same
  shape, different absolute numbers.

## Two harness defects, found and corrected before comparing

Both would have compared *programs* rather than languages, which is the failure this kind of
exercise exists to avoid:

- JavaScript counted substring occurrences with `split()`, allocating an array over a 300 KB
  body, where Python and Go used a scanning count. Corrected to a scan.
- A structured-read task failed because an earlier task's per-iteration writes left duplicates
  that crowded lower-importance fixtures out of a limited, sorted read. Corrected by seeding
  singletons.

Each cause was read from the failing result's own diagnostic output rather than guessed.

## Reproducing the scrubber measurement

`scripts/redact-bench.mjs` measures the write-path scrubber alone — no database, no network.
**Run it before and after any change to `src/redact.js`.** The four-language services were
scaffolding and have been torn down; this instrument guards shipped code and remains.
