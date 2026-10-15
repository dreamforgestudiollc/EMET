# Contributing

## Before you open a pull request

- Open an issue first for anything beyond a typo. The feature template asks the four questions EMET asks of every change it builds ([CHARTER.md](CHARTER.md)).
- Run the tests: `npm ci && npm test`.
- Keep the write path additive. No change may add a delete or a remove on any store. `write-path.test.js` and `atlas-role.test.js` enforce this.

## Set by the maintainer

These change only by the maintainer's decision:

- [CHARTER.md](CHARTER.md).
- The core floor (`src/floor.js`) and its protected lines.
- The README's document-control section (ISO 9001 7.5.3 / ISO 13485 4.2.5).
- Attribution: source tags, session and load ids, client approval.
- The GEM standard, schema and socket rules in [`gem-library/`](gem-library/). Anyone may author a GEM; see [gem-library/AUTHORING.md](gem-library/AUTHORING.md).

## Security

See [SECURITY.md](SECURITY.md).
