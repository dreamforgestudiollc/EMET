# Bot-team backup

Optional. Off unless the first-run answer recorded in `bootstrap/USER.md` under BOT-TEAM BACKUP is `yes`. Yes is the recommended choice. Leaving the question out records `no`.

EMET does not run this recipe. The assistant does, and only after that recorded yes.

## What to write

For each bot the install uses, keep one controlled document at `bot-team/<bot>.md`. Use the bot's own tag as `<bot>`, the same tag its writes already carry. The document holds:

- the bot's name
- the prompt it runs with
- the settings that are not secret
- the routines it follows
- the skills it uses

Write the document through the normal document tools. A later change is a new revision of the same id. Do not delete the previous copy. If nothing changed since the last revision, do not write again.

Check on a steady cadence the install chooses, such as at session close, and only write when the text would differ.

## What never goes in

Never store secret values, tokens, passwords or card data. Not in `bot-team/<bot>.md`, not in `bot-team/RECOVERY.md`, and not in any other bot-team document. A name of a connector or a login is not a secret. The value behind it is.

## Recovery

Keep the rebuild order in `bot-team/RECOVERY.md`, filled from `guides/BOT_TEAM_RECOVERY.md`. That document lists what a person must reconnect by hand. It does not store the secrets themselves.
