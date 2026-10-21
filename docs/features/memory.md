# Memory layers

Six layers hold curated claims: identity, semantic, episodic, procedural, meta, and working. `save_to_layer` writes one entry. `recall` searches by keyword. `query_layer` filters one layer. `revise_memory` supersedes an entry with a new one. The old entry stays readable.

## Sub-features

- memory-save: `save_to_layer` writes one entry and reads it back before it reports success.
- memory-recall: `recall` ranks current entries first. Pass `order` `"latest"` for time order.
- memory-query: `query_layer` takes a layer and optional filters.
- memory-revise: `revise_memory` adds a new entry that points at the one it replaces. Episodic entries are not revised.

## How to get to it (user POV)

After startup, open a transcript session and pass that `session_id` on the save. Name the layer. Semantic and procedural saves also need a source: the session, or `metadata.derived_from`. Search with `recall` using the words you stored. Use `query_layer` when you know the layer and want a filter. To correct an entry, `revise_memory` with the full new text. Do not edit the old row.

## Driving it with verify-emet

```
npm run verify -- feature memory
npm run verify -- run save_to_layer recall query_layer revise_memory
```

The drive saves a working-layer sentence, recalls it, queries that layer, then supersedes the saved id. Keyword search does not need a vector index. That index is a different feature.

## Gotchas

- A semantic or procedural save with no `session_id` and no `derived_from` is refused, and nothing is written.
- A governed write with no session is refused. Open one with `emet_session_open` and the startup `load_id` first.
- `revise_memory` does not accept the episodic layer. Events stay as written.
