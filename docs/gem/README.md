# GEM socket

The GEM standard is maintained in the GEM library, not in this file.

The copy under review in this repository is [`gem-library/`](../../gem-library/README.md). Its canonical home is the private repository [EMET-GEMs](https://github.com/dreamforgestudiollc/EMET-GEMs). When that folder is moved, this page should point at that repository and stop pointing at a second copy.

The socket, once built, takes these rules from the library:

- Validate each `gem.json` against `gem.schema.json` (spec revision `2026-10-11`).
- On every `emet_initialize`, serve `gems_available` for each installed GEM, active or not, and `gems_active` for those that are on.
- Name that list in the startup text a bot reads, in the place the charter gives to what is available this session.
- Keep both fields whole in the startup payload, in the same class as the floor.
- Apply the precedence, the refusal rules, and the load limits in the specification. A refused GEM does not stop the session.

The socket is `src/socket.js`. It runs `gem-check` (`src/gem-check.js`) before a GEM can load. This release seats one bundled prompt GEM, `gems/neurendipity`. It is installed and off unless the install sets `EMET_ACTIVE_GEMS=neurendipity`. The startup text then says `neurendipity, Neurendipity, on`. With the setting unset it says `neurendipity, Neurendipity, off`, and `gems_active` is empty. `emet_floor` takes `gem` to read that floor without turning it on. The guide id `guides/NEURODIVERGENT_SUPPORT.md` still resolves, for one release, to the copy under the GEM. The example at `gem-library/examples/neurendipity/` is a shape, not the installed GEM. RUNE execution is not implemented and is refused. An empty mount logs nothing. A seating summary is logged only when a GEM is installed.
