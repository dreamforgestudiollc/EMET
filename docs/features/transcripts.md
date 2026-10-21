# Transcripts

The word-for-word tier. `emet_session_open` starts a session. `emet_transcript_append` stores one exchange after each reply. `save_transcript` is the fallback when a host cannot append per reply. `query_transcripts` reads sessions back. `revise_transcript` supersedes a stored part. `emet_session_close` checks that the session's work was written. It does not write the work itself.

## Sub-features

- transcript-open: `emet_session_open` needs `load_id` from startup. A closed id is not reopened; the next id gets a numeric suffix.
- transcript-append: `emet_transcript_append` stores one exchange. The first exchange must carry a measured machine line, or the words `no local shell MCP`.
- transcript-batch: `save_transcript` stores a whole session when append-per-reply is impossible.
- transcript-read: `query_transcripts` reads by time range or session id.
- transcript-revise: `revise_transcript` writes a new part and marks the parent superseded. `reason` is required.
- transcript-close: `emet_session_close` compares your receipts with the store. `complete` means the receipts matched. Anything else is not saved.

## How to get to it (user POV)

Finish startup, then `emet_session_open` with the `load_id` you were given and a short slug. After every reply, `emet_transcript_append` with that session id, the user message, and your reply. At the end, `emet_session_close` with receipts taken from the tool results of this session, not from memory. Tell the user the session is saved only when the state is `complete`.

## Driving it with verify-emet

```
npm run verify -- feature transcripts
npm run verify -- run emet_session_open emet_transcript_append save_transcript query_transcripts revise_transcript emet_session_close
```

The drive has no local shell, so the first append uses `no local shell MCP`. The close on that throwaway session reports what is still missing. A state other than `complete` is still a working tool: it checked, and it refused to pretend.

## Gotchas

- The first append is refused without a machine line or `no local shell MCP`. Nothing is written.
- A closed session takes one closing exchange inside the grace window, then it locks.
- Close receipts have to match the store. Invented ids come back `blocked` or `incomplete`.
