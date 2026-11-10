# GEM socket

The GEM standard is maintained in the GEM library, not in this file.

The copy under review in this repository is [`gem-library/`](../../gem-library/README.md). Its canonical home is the private repository [EMET-GEMs](https://github.com/dreamforgestudiollc/EMET-GEMs). When that folder is moved, this page should point at that repository and stop pointing at a second copy.

The socket takes these rules from the library:

- Validate each `gem.json` against `gem.schema.json` (spec revision `2026-10-12`).
- On every `emet_initialize`, serve `gems_available` for each installed GEM, active or not, and `gems_active` for those that are on.
- Name that list in the startup text a bot reads, in the place the charter gives to what is available this session.
- Keep both fields whole in the startup payload, in the same class as the floor.
- Apply the precedence, the refusal rules, and the load limits in the specification. A refused GEM does not stop the session.

The socket is `src/socket.js`. It runs `gem-check` (`src/gem-check.js`) before a GEM can load. This release seats four bundled GEMs: Neurendipity, Lean Six Sigma, bot-team backup, and Fieldnote. Each stays off unless the install turns it on. Neurendipity and Lean Six Sigma turn on when `EMET_ACTIVE_GEMS` names them. Bot-team backup turns on when the first-run interview records yes. Fieldnote is a developer case-study of a runed GEM, not a user-facing GEM. The startup text names a GEM `on` when it is active and `off` when it is not. With nothing named and the interview left at no, `gems_active` is empty. `emet_floor` takes `gem` to read a floor without turning the GEM on. The guide id `guides/NEURODIVERGENT_SUPPORT.md` resolves to the Neurendipity copy. The example at `gem-library/examples/neurendipity/` is a shape, not the installed GEM. The socket does not run RUNED code. While its GEM is on, each RUNE is one read-only tool in the tool list, `gem_<gem>__<rune>`, and that tool serves the RUNE's code, inputs, outputs, description, and served hash ([GEP-0003](../../gem-library/proposals/GEP-0003-client-side-execution.md)). The client runs the code. An empty mount logs nothing. A seating summary is logged only when a GEM is installed.
