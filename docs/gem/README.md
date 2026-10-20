# GEM socket

The GEM standard is maintained in the GEM library, not in this file.

The copy under review in this repository is [`gem-library/`](../../gem-library/README.md). Its canonical home is the private repository [EMET-GEMs](https://github.com/dreamforgestudiollc/EMET-GEMs). When that folder is moved, this page should point at that repository and stop pointing at a second copy.

The socket, once built, takes these rules from the library:

- Validate each `gem.json` against `gem.schema.json` (spec revision `2026-10-12`).
- On every `emet_initialize`, serve `gems_available` for each installed GEM, active or not, and `gems_active` for those that are on.
- Name that list in the startup text a bot reads, in the place the charter gives to what is available this session.
- Keep both fields whole in the startup payload, in the same class as the floor.
- Apply the precedence, the refusal rules, and the load limits in the specification. A refused GEM does not stop the session.

The socket is `src/socket.js`. It runs `gem-check` (`src/gem-check.js`) before a GEM can load. This release seats bundled GEMs. Neurendipity and Lean Six Sigma are work-in-progress examples, installed and off unless `EMET_ACTIVE_GEMS` names them. Bot-team backup is optional and off unless the first-run interview records yes. Fieldnote is a developer case-study of a runed GEM. It is not a user-facing GEM, and it is off by default. The startup text then says `neurendipity, Neurendipity, on`, `lean-six-sigma, Lean Six Sigma, on`, or `fieldnote, Fieldnote, on` when that id is named. With the setting unset both lines say `off`, and `gems_active` is empty. `emet_floor` takes `gem` to read a floor without turning the GEM on. The guide id `guides/NEURODIVERGENT_SUPPORT.md` still resolves, for one release, to the copy under Neurendipity. The example at `gem-library/examples/neurendipity/` is a shape, not the installed GEM. The socket does not run RUNED code. While its GEM is on, each RUNE is one read-only tool in the tool list, `gem_<gem>__<rune>`, and that tool serves the RUNE's code, inputs, outputs, description, and served hash ([GEP-0003](../../gem-library/proposals/GEP-0003-client-side-execution.md)). The client runs the code. An empty mount logs nothing. A seating summary is logged only when a GEM is installed.
