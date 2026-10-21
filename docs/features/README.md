# Feature map

This is the map of what EMET does today, written from the outside. Each file is one feature. A feature names the tools that belong to it, how a person reaches it, how `verify-emet` drives it, and the traps that waste a run.

`npm run verify` is the command. It is `scripts/verify-emet.mjs`. From a checkout it starts EMET in a temporary directory on the in-memory test database, with no `.env` and no settings copied from the machine that launched it. A tool that still needs a service or a setting a plain install does not have is a gap. The command reports the gap and does not pretend the call succeeded. Exit 0 means every driven tool passed and the selection had no gap. Exit 1 means a tool failed, Node is older than 22, or the test database is missing. Exit 2 means the command line was not understood. Exit 3 means the only problems are gaps.

| Feature | What it is |
|---|---|
| [Startup](startup.md) | First call, the interview, and the store status. |
| [Memory layers](memory.md) | Save, search, query, and supersede layer entries. |
| [Search beyond keywords](search.md) | Meaning search and an optional corpus. Both are gaps on a standalone run. |
| [Transcripts](transcripts.md) | Open a session, append each exchange, and close. |
| [Documents](documents.md) | Versioned documents, history, and obsolescence. |
| [Topic pages](pages.md) | Computed views. They are not records. |
| [Error codes and the error log](errors.md) | Stable codes, the operational log, and `emet_error_report`. |
| [The record and the floor](record.md) | Gap counts, and the floor that ships in the server. |
| [Access](access.md) | Approving a client, and the two doors for a second person. |
| [Client sub-keys](subkeys.md) | Delegated keys. Off unless you turn them on. |
| [GEMs](gems.md) | Add-on behavior the client runs. EMET checks the record. |

A registered tool that is missing from this map fails `tests/feature-map.test.js`. Add the tool to the feature file in the same change that registers it.
