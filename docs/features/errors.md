# Error codes and the error log

Every error carries a stable code, such as `EMET-INT-001`, next to the existing error field. The registry is `src/error-codes.js`. The table is `docs/ERROR-CODES.md`. A code's meaning does not change. A removed code stays retired and its number is not reused.

Operational errors go to a separate log, `error_log`. It is not a controlled record. It keeps up to 10,000 entries or 90 days, whichever is smaller, and a daily summary of each day is kept in `error_log_summary` with no end date. Rotation removes entries from `error_log` only. The log holds codes, counts, times, and the version. It holds no message text, arguments, document content, names, or secrets.

`emet_error_report` is owner-only and read-only. It returns the report and an email draft. You read it, and you press Send yourself. EMET never sends mail.

## Sub-features

- errors-codes: each returned error includes `error.emet_code`. An uncoded error that reaches a caller is `EMET-INT-001`.
- errors-log: `error_log` and `error_log_summary` are operational. They are not superseded documents.
- errors-report: `emet_error_report` reads the log and builds a `mailto:` draft. The address is `EMET_REPORT_EMAIL` when that variable is set. When it is unset, the address is `dreamforgestudio@mail.grokbot.com`. An empty string returns the report and no email.

## How to get to it (user POV)

When a call fails, read `error.emet_code` and look it up in `docs/ERROR-CODES.md`. To send a problem on, run `emet_error_report` as the owner. Read the report, open the link, check the email in your own mail app, then send it. Set `EMET_REPORT_EMAIL` to keep reports at an address you choose.

## Driving it with verify-emet

```
npm run verify -- feature errors
npm run verify -- run emet_error_report
```

The drive calls the tool as a local owner, the way stdio does, and expects a report. It does not send mail. There is no mail sender in this command.

## Gotchas

- A remote caller who is not the owner is refused. The local process is the owner.
- The draft is not a delivery receipt. EMET does not open a network connection for this tool.
- The log is not a controlled record. Controlled records are still superseded, retired, and retained.
