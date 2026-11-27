# Error codes and the error report

This is the behavior EMET 0.3.0 ships. The code table is generated from the registry: [ERROR-CODES.md](ERROR-CODES.md). A code’s meaning does not change. A removed code is added to the retired list, stays in that table, and its number is not reused.

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

## Condense approval

`EMET-DOC-025` is still the refusal when a write would leave a document under half the size this session first saw. `EMET-DOC-090` is that same write when `condense_approved` is true and the approval is missing, not granted yet, names another document, or has no reason. The owner door does not need `writer_approval_id`. A bot tag, including the hub and any `hubbot-*` tag, stays on `EMET-DOC-025` when it uses the owner password, and nothing is written. A condense grant must name the document (`doc_id` on `emet_client_approve` when `decision` is `prepare`). the owner approves it on `/owner/chooser` and no access code is minted. A writer approval condenses only the document it names. The registry table is [ERROR-CODES.md](ERROR-CODES.md).

## Unregistered saves

`EMET-MEM-035` is an unregistered source on `save_to_layer`, `revise_memory`, or a document write that still stored such a tag, on or after `EMET_SOURCE_SAVE_CUTOFF` (`America/New_York`, default `2026-12-15`). Nothing is written. Before that date the save is kept and the receipt names the cutoff. Transcript appends stay `EMET-TOOL-004`. The registry table is [ERROR-CODES.md](ERROR-CODES.md).

## Handoff refusals

`EMET-DOC-084` is another tag's handoff, or the hub handoff written by a tag that is not the hub, or the draft id `handoffs/<tag>.md`, or an unregistered credential, or a file in another tag's `bots/<tag>/` folder. `EMET-DOC-085` is a board row the credential did not open, including a deleted row, a restore, a row already on the board with no opener, and a hub write that is not resolving a marked conflict. A hub resolve whose stamp is no longer the view in force is the same code: the message says the stamp is not the view in force and to re-read the handoff view. That includes a stamp whose open sessions, aging, stale-open hours, or registry no longer match, so a hub whose own session becomes tagged after initialize re-reads before the resolve. `EMET-DOC-086` is a reserved two-segment handoff id, a tag equal to a person id, a malformed id, or a tag whose characters the id does not allow. `EMET-DOC-087` is a claimed tag writing under `HANDOFF/`. `EMET-DOC-088` is a declared session tag that is not the HTTP credential, including a claimed tag naming a session. It applies only while `EMET_TAG_HANDOFFS` is `warn` or `enforce`, and only when the call declares a tag. A call that declares no tag is kept. With the flag off the check does not run, and the declared tag is kept. `EMET-CFG-015` is the per-tag flag on with `EMET_HUB_TAG` unset. The registry table is [ERROR-CODES.md](ERROR-CODES.md).
