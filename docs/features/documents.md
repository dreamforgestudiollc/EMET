# Documents

Continuity documents are versioned. `write_doc` stores a new revision and archives the previous one. When a host truncates one argument, `write_doc_begin`, `write_doc_append`, and `write_doc_commit` send the same revision in parts. `write_doc_abort` drops an open stage and leaves the current document unchanged. `read_doc` reads the current text, in pages when it is long. `read_doc_history` reads a retained revision. `list_docs` lists metadata. `patch_doc` replaces one exact substring. `rename_doc` reissues a document under a new id and marks the old id obsolete. `restore_doc` writes a retained revision back. `validate_doc` checks form and continuity and writes nothing. `accept_nonconformance` records a written disposition for a marker that will not be corrected. `retire_doc` marks a drop obsolete. The document stays.

## Sub-features

- doc-write: `write_doc` and `patch_doc` archive the prior copy and check the digest on the way back.
- doc-stage: `write_doc_begin`, `write_doc_append`, and `write_doc_commit` assemble one revision. `write_doc_abort` drops the stage.
- doc-read: `read_doc`, `read_doc_history`, and `list_docs` do not change the store.
- doc-check: `validate_doc` is the write-path check, borrowed, with no write.
- doc-reissue: `rename_doc` writes the destination first, then marks the old id obsolete.
- doc-restore: `restore_doc` copies a retained revision back through the normal write path. The source tag must be listed in `EMET_RESTORE_TAGS`.
- doc-accept: `accept_nonconformance` keeps the marker and writes the acceptance beside it.
- doc-retire: `retire_doc` is for drops. A working note is edited, not retired.

## How to get to it (user POV)

You already have a session open. `list_docs` shows the ids. `read_doc` with a `doc_id` returns the text. For a small edit, `patch_doc` with the exact old text, the new text, and a reason of at least 10 characters. For a new document, `write_doc` with the whole text. Records such as the handoff are written whole, with `supersedes` set to the version in force. `validate_doc` before you store a draft. If a stored document is nonconforming and you will not correct it, `accept_nonconformance` with a reason. To mark a drop obsolete, `retire_doc`. `read_doc` still returns it, flagged retired.

## Driving it with verify-emet

```
npm run verify -- feature documents
npm run verify -- run read_doc read_doc_history write_doc write_doc_begin write_doc_append write_doc_commit write_doc_abort list_docs patch_doc rename_doc restore_doc validate_doc accept_nonconformance retire_doc
```

The drive writes a note, patches it, restores the retained revision, renames it, writes an area, accepts a nonconforming area, and retires a drop. `--dry-run` skips the calls whose annotations say they replace what is already there.

## Gotchas

- `patch_doc` requires the old text to match exactly once. Zero matches or several matches write nothing.
- `retire_doc` refuses a working document. Write a `drops/` id if you mean a drop.
- `restore_doc` refuses a tag that is not in `EMET_RESTORE_TAGS`. The standalone drive sets that list to its own source tag inside the temp process. It does not read your environment.
- `accept_nonconformance` refuses a document that has no nonconformance marker.
- Prior versions are retained. A correction adds a revision. It does not remove the old one.
