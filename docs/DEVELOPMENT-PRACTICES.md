# Development practices

How a change to EMET is specified, checked, and reviewed.

## Docs ship with the feature

Write the feature page first, from the user's point of view, and land it in the same pull request as the code. The page lives in [docs/features](features/README.md): what the feature is, how a person reaches it, how to drive it, and what goes wrong. A tutorial, a how-to, a reference, and an explanation are different jobs. Do not fold them into one muddy page. The README and the site stay in step with that page when the change is something a user can see.

The feature map is part of the tree, so the next session can read it instead of rediscovering the product. `tests/feature-map.test.js` fails if a registered tool is missing from the map. Update the map in the same change that adds or renames a tool.

## Verify by running

Tests pin behavior. They are not the whole check. `npm run verify` runs [scripts/verify-emet.mjs](../scripts/verify-emet.mjs), which brings EMET up in a temporary directory on the in-memory test database and drives the tools the way a plain install would. A tool that needs a service or a setting that process does not have is reported as a gap. Exit 3 is that report. Exit 1 is a tool that failed. Do not treat 3 as a crash, and do not stub a gap into a pass. A change to a feature is done when `verify-emet` has driven it, not when the unit tests alone are green.

Give the command a small, composable surface: `doctor`, `list`, `run`, and `feature`, plus `--json` and `--dry-run` on anything that replaces or hands out access. Errors say what to do instead.

## Two reviewers

Every pull request gets two independent reviewers. Each one cross-checks the other's verdict against the diff and against a run of the change. A disagreement is resolved in the thread before merge.

## Where this came from

These practices follow Lauren Tan's *The Complete Guide to pstack*: a verification command you can run, a feature map in the repo, and docs written before the implementation so the code has something to be checked against.

- Part 1: <https://x.com/poteto/status/2094457600259842065>
- Part 2: <https://x.com/poteto/status/2097732320606507506>
