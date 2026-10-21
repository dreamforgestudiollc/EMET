# Error codes and the error report

This is the behavior EMET 0.3.1 ships. The code table is generated from the registry: [ERROR-CODES.md](ERROR-CODES.md). A code’s meaning does not change. A removed code is added to the retired list, stays in that table, and its number is not reused.

## Where the code goes

Every error returned to a caller carries `error.emet_code`, shaped `EMET-<AREA>-<NNN>`. The existing `error.code` field (`VALIDATION_ERROR`, `DATABASE_ERROR`, `INTERNAL_ERROR`, and the rest) is unchanged. Message text is unchanged when a code is added.

An error that reaches the caller with no registered code is `EMET-INT-001`.

## The operational log

`error_log` is operational bookkeeping. It is not a memory, a document, or a transcript, and it is not a controlled record. No tool edits or deletes a log entry. A dated job removes a row when the log is over 10,000 entries or the row is older than 90 days, whichever comes first, and only after writing a daily summary (`day`, `emet_code`, `tool`, `version`, `count`) that is kept. The job logs how many rows it rotated.

A failed log write still returns the original error. The process log hears only the fixed line `error log write failed`.

A row stores the time, the code, the class code, the tool name, the version, the transport, the caller tag when that tag is registered, the role (`owner` or `guest`), a correlation id, and a count. It does not store argument values or names, message text, memory or document content, document ids or titles, area or page names, person names or ids, email addresses, IP addresses, tokens, passphrases, client secrets, query strings, or stack traces.

## The report

`emet_error_report` is owner-only and read-only. A local stdio session is the owner. On HTTP the signed-in person must have the owner role. Anyone else receives `EMET-AUTH-038` (“The error report is owner-only.”), not an empty report.

The tool writes nothing and sends nothing. EMET has no mail sender and opens no network connection for this tool.

Inputs are optional: `since` (default 7 days, at most 90), `codes`, `correlation_id`, and `limit` (default 50, maximum 200). A correlation id is looked up on its own, so the id the caller was given still resolves inside the log window even when `since` would exclude that day.

The result is, in order:

1. The full report, never truncated.
2. A `mailto:` draft, when an address is set.
3. A structured email `{to, subject, body_text, short_id, version}`, plus the mailto link, so a calling assistant can pass it to its own email tool.

`to` is `EMET_REPORT_EMAIL`. When the variable is unset, the address is `dreamforgestudio@mail.grokbot.com`. An empty string means no email: the tool returns the report and `email: null`. Any other value is treated the same way unless it is one plain address: exactly one `@`, a local part of letters, digits, and `. _ + -` that does not start or end with a dot and does not contain `..`, and a domain of at least two labels separated by dots. A label is letters, digits, and `-`, does not start or end with `-`, and is not empty.

The subject is `EMET error report <version> <6 hex characters>`. `body_text` is the full report shown above. The mailto body is that same text when it fits, and a shorter draft when it does not. The link is at most 1,800 characters. Totals stay when they fit. Recent lines are cut to the newest that fit, and the draft says so. The report in the tool output stays complete.

## A bot may send it, after a yes

EMET itself never sends the report. A person can open the mailto draft. An assistant that has its own mailbox can send the structured email with its own email tool, addressed to the same `to`.

The calling assistant may send this report only after showing the report to its user and getting their OK. That sentence is in the tool description and in the tool output. It is not part of the report body, so the text the recipient reads stays the report.

This is an owner decision added after the report was specified as a draft the person sends. The server stays free of SMTP and of any network call on this path.
