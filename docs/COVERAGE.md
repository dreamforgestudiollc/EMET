# Code coverage

Measured 2026-10-07 22:44 UTC at a pre-release commit, Node v22.14.0. Regenerate with `npm run coverage`.

**An input to review, not a gate** (owner's ruling 2026-09-29). No threshold fails the build; the number is here so a reviewer or auditor can see what the suite exercises and what it does not.

## Totals

- Lines:     89.6%  (10286 of 11480 executable lines in src/)
- Functions: 91.2%  (839 of 920 functions in loaded files)
- Files:     38 of 38 loaded by at least one suite
- Suites:    64 of 64 passed; 1852 checks passed, 0 failed

## Method

- Node's built-in V8 coverage (`NODE_V8_COVERAGE`), no dependency. Every suite runs in its own process; coverage from all of them is merged.
- A line counts when it is not blank and not wholly comment. It is covered when any suite ran the code at its first character.
- A function is covered when any suite called it. Functions are counted only in files a suite loaded.
- V8 does not report a function nested inside a function that never ran, so the function figure undercounts uncalled code and reads high. **The line figure is the one to trust.**
- A file no suite loads counts with every executable line uncovered - it is not left out.
- The comment scanner is simple: a quote or `//` inside a regular-expression literal can misjudge that one line.

## Per file, lowest line coverage first

| File | Lines covered | Lines | Functions called | Loaded by a suite |
|---|---|---|---|---|
| `src/env.js` | 42.9% | 12 / 28 | 2 / 2 | yes |
| `src/http-remote.js` | 53.4% | 102 / 191 | 9 / 14 | yes |
| `src/gaps.js` | 80.1% | 258 / 322 | 23 / 34 | yes |
| `src/dispatch.js` | 80.6% | 154 / 191 | 5 / 9 | yes |
| `src/index.js` | 80.7% | 205 / 254 | 7 / 13 | yes |
| `src/logger.js` | 81.9% | 177 / 216 | 22 / 25 | yes |
| `src/database.js` | 83.8% | 434 / 518 | 39 / 45 | yes |
| `src/tools.js` | 84.0% | 2703 / 3219 | 157 / 174 | yes |
| `src/setup.js` | 90.4% | 838 / 927 | 59 / 65 | yes |
| `src/oauth-provider.js` | 91.3% | 558 / 611 | 60 / 73 | yes |
| `src/session.js` | 94.6% | 739 / 781 | 60 / 61 | yes |
| `src/validation.js` | 95.3% | 702 / 737 | 31 / 31 | yes |
| `src/persons.js` | 95.4% | 83 / 87 | 10 / 11 | yes |
| `src/provenance.js` | 95.9% | 140 / 146 | 6 / 6 | yes |
| `src/conformance.js` | 95.9% | 377 / 393 | 45 / 45 | yes |
| `src/guides.js` | 96.0% | 24 / 25 | 4 / 4 | yes |
| `src/content_analyzer.js` | 96.3% | 233 / 242 | 13 / 14 | yes |
| `src/session-graph.js` | 96.4% | 541 / 561 | 76 / 78 | yes |
| `src/layers.js` | 97.0% | 318 / 328 | 13 / 13 | yes |
| `src/redact.js` | 97.1% | 102 / 105 | 19 / 20 | yes |
| `src/invites.js` | 97.7% | 129 / 132 | 8 / 8 | yes |
| `src/startup-pages.js` | 97.9% | 233 / 238 | 41 / 42 | yes |
| `src/named-items.js` | 98.3% | 175 / 178 | 22 / 23 | yes |
| `src/lessons-to-checks.js` | 99.7% | 291 / 292 | 24 / 25 | yes |
| `src/aleph.js` | 100.0% | 227 / 227 | 20 / 20 | yes |
| `src/annotations.js` | 100.0% | 45 / 45 | 4 / 4 | yes |
| `src/approve-throttle.js` | 100.0% | 31 / 31 | 6 / 6 | yes |
| `src/atlas-role.js` | 100.0% | 21 / 21 | 2 / 2 | yes |
| `src/disciplines.js` | 100.0% | 11 / 11 | 0 / 0 | yes |
| `src/floor.js` | 100.0% | 121 / 121 | 1 / 1 | yes |
| `src/metadata.js` | 100.0% | 21 / 21 | 3 / 3 | yes |
| `src/mongo-connect.js` | 100.0% | 20 / 20 | 4 / 5 | yes |
| `src/request-log.js` | 100.0% | 65 / 65 | 8 / 8 | yes |
| `src/scopes.js` | 100.0% | 43 / 43 | 9 / 9 | yes |
| `src/security-headers.js` | 100.0% | 18 / 18 | 3 / 3 | yes |
| `src/startup-payload.js` | 100.0% | 69 / 69 | 10 / 10 | yes |
| `src/transcript-session.js` | 100.0% | 65 / 65 | 14 / 14 | yes |
| `src/version.js` | 100.0% | 1 / 1 | 0 / 0 | yes |
