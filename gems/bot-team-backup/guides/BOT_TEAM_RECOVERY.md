# Bot-team recovery

Copy this into the store as `bot-team/RECOVERY.md` when bot-team backup is on. Revise it when the rebuild order changes. Supersede; do not delete.

Never store secret values, tokens, passwords or card data here. Name the item that has to be reconnected. Leave the value out.

## Rebuild order

1. Restore the memory server and its database from the operator's own backup of that service.
2. Read `bot-team/<bot>.md` for each bot and put back that bot's name, prompt, settings, routines and skills.
3. Reconnect, by hand, every item in the list below. The documents do not contain what those items need in order to authenticate.

## Reconnect by hand

| Item | Where it lives | What the person does |
|---|---|---|
| Connectors | The host's connector settings | Connect each one again. The document may name the connector. It must not hold a key. |
| Logins | The host account for each bot | Sign in again. The document may name the account. It must not hold a password. |
| Secrets | The host's secret store | Put each secret back from the place the operator keeps secrets. This document names the slot, not the value. |

## Rule

If a value is a token, a password, a card number, or any other secret, it does not belong in EMET. Record that the item must be reconnected. Stop there.
