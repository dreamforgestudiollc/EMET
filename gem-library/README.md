# EMET GEM library

Canonical home: [github.com/dreamforgestudiollc/EMET-GEMs](https://github.com/dreamforgestudiollc/EMET-GEMs) (private).

This folder is the GEM standard for EMET. It is written so it can move into that repository as it stands. Links inside the folder are relative. After the move, EMET-GEMs is the copy that governs, and the EMET server repository keeps only the pointer its socket needs.

EMET is a memory server. A GEM (Golem Expertise Module) is optional guidance that seats in the socket. The core floor stays the memory minimum and cannot be switched off. The reference GEM is Neurendipity (`neurendipity`). It ships bundled with EMET and is off unless the user asks for it.

## What is in this folder

| File | Role |
|---|---|
| [SPEC.md](SPEC.md) | The standard. Draft, revision 2026-10-11. |
| [gem.schema.json](gem.schema.json) | JSON Schema for `gem.json`. |
| [AUTHORING.md](AUTHORING.md) | How to make a GEM or a RUNED GEM. |
| [CONFORMANCE.md](CONFORMANCE.md) | The `gem-check` checks and the security checklist. |
| [proposals/GEP-0001-core-floor-and-neurendipity-gem.md](proposals/GEP-0001-core-floor-and-neurendipity-gem.md) | Accepted proposal for the first move. |
| [examples/neurendipity/](examples/neurendipity/gem.json) | A manifest that validates. Illustrative lines, not the floor text to ship. |

## Two repositories, on purpose

- **EMET-GEMs (this standard).** Private working copy. The owner and the owner's bots change the spec, the schema, and the socket rules here. Reference and bundled GEM sources are kept here too, then copied into an EMET release to load.
- **A public submission repository, not created yet.** Outside authors will open a pull request there to submit a GEM or a RUNED GEM. Its name and the day it opens are the owner's decision. Nothing from that repository loads until `gem-check` passes and the owner accepts it.

A submission pull request cannot change `SPEC.md`, `gem.schema.json`, or the socket rules. Those change only by a GEP the owner accepts.

## What EMET loads

The server loads a GEM only from the `gems/` directory inside an EMET release, and only after the checks in [CONFORMANCE.md](CONFORMANCE.md) that apply to a bundled prompt GEM. A folder a user drops in, a document in the store, or a fetch from the network is not a bundled GEM. RUNED code and third-party GEMs stay unloaded until the release that enforces their checks. The rules they must already meet are in [SPEC.md](SPEC.md).

The socket is not built yet. This folder does not change server behavior.
