# Search beyond keywords

`semantic_recall` searches the six memory layers by meaning. `corpus_recall` searches an optional corpus the user loaded separately. Neither is where a session starts, and neither runs for real on the standalone test database.

## Sub-features

- search-semantic: `semantic_recall` needs a vector search index on the memory collections.
- search-corpus: `corpus_recall` needs a corpus collection you populate, and a vector index on it. Until then it is not session memory.

## How to get to it (user POV)

Use `recall` or `query_layer` for the words you stored. Call `semantic_recall` when you want matches that do not share those words, and only after the vector index exists on your database. Call `corpus_recall` only after you have loaded a corpus of your own. An empty corpus is an empty answer, not a failure of memory.

## Driving it with verify-emet

```
npm run verify -- feature search
npm run verify -- run semantic_recall corpus_recall
```

Both tools are standalone gaps, so this run exits 3. The command does not call them. An empty result from the in-memory store would look like a successful search, and that would hide the missing index.

## Gotchas

- A gaps-only run exits 3. Do not treat that as a crash in the tool. The report says what to use instead. A failed tool still exits 1.
- `corpus_recall` is not a second copy of session memory.
- Turning the gap into a pass means giving the standalone process a real vector index, not a stub that returns no rows.
