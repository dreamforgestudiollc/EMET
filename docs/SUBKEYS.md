# When more than one bot uses EMET

One EMET. One owner login. If more than one bot or AI writes through that login, each bot that can keep a key file gets its own key. The server stamps the tag on the key. A bot does not get to name another bot's tag and have that stamp stick.

This is part of EMET. It is the same server, the same owner page, and the same keys. It is not a second product, and it is not a fork.

The Charter and the floor are unchanged. This supports ISO 9001:2015 clause 7.5.3 and ISO 13485:2016 clause 4.2.5 (identification of who changed a record, retention of records, nothing deleted), as the README and the Charter word it. EMET claims no certification. The organization validates EMET for its own use.

## Turn it on

Say **initialize**. Your assistant asks whether more than one bot or AI will use this memory. Answer in your own words. Leaving it out is the same as no.

- **No.** Sub-keys stay off. That one client uses its own source tag. The tool list does not grow.
- **Yes, and this server reads a `.env` file.** Setup writes three settings into that file after your identity is saved: sub-keys on, a pepper the server generates, and version 1. You do not type the pepper, and it is not repeated. Restart (or redeploy) the server once. The tools and `/owner/chooser` appear together after that restart. They do not turn on in the server that is already running. `/owner/approvals` stays as a retired pointer.
- **Yes, and the server takes its settings from the platform** (Railway or anything else that injects environment variables). Setup refuses before it saves anything. No pepper or .env was written. Run setup again without yes to finish the rest. Then set these in the platform's variables and redeploy:
  1. `EMET_SUBKEYS=1`
  2. `EMET_SUBKEY_PEPPER` — generate it yourself, at least 32 bytes, for example with `openssl rand -hex 32`
  3. `EMET_SUBKEY_PEPPER_VERSION=1`

  Do not paste the pepper into the chat or into any EMET document.

A single client does not get this turned on. The page and the tools ship with EMET. They stay quiet until the answer is yes and the server has restarted with the flag on.

If this memory is already set up and you later add bots, say so. Your assistant turns sub-keys on only after you explicitly agree to run setup again. That writes a new version of your identity documents. The previous version is kept.

## Approve a bot

List each bot's tag in `EMET_SOURCE_TAGS` before it asks for a key. An empty list refuses every request.

1. Open `/owner/chooser` on the same host you already use for this memory. Enter the passphrase you already use when you connect a device. A correct passphrase opens a short session. A wrong one is counted with the other passphrase attempts. `/owner/approvals` was retired by R4 and answers with a pointer here. The sub-key records stay listed on the chooser. If every AI client is locked out, open `/owner/break-glass` in your own browser.
2. Each bot that can keep a key file asks for a key with its own tag.
3. On the chooser, approve that request. Deny applies only to a pending request.
4. The bot claims the key within 24 hours. It keeps the key where the other bots cannot read it. The key is never written into EMET.

A bot opens a session with that key. `emet_session_open` returns `session_handle` once. Every later write in that session passes `session_handle`. A write that names the session and omits the handle, or sends a different one, is refused, and nothing is written. The handle is not a receipt and is not written into a document.

## A key lasts 30 days

To renew a key, the bot asks again with the same tag, you approve it on the page, and the bot claims the new key within 24 hours. The previous key works for a few minutes while the bot switches, then it stops. Earlier writes stay as they were written.

## Revoking your login

Revoking the owner login stops every sub-key. The keys hang off that login. They do not keep working after it is gone.

## A phone, or a web project

A host that cannot store a key file does not take a sub-key. A phone, or a web project instance, uses the tag on its own connection.

## Security

The pepper is a server secret. When this server reads `.env`, setup writes that file and does not put the pepper in the database, in a document, or in the answer it gives your assistant. An MCP call is what writes the file, and only on that kind of server. A hosted server does not get a pepper written into its container.

The approvals page uses the same passphrase as connecting a device, and a wrong passphrase counts toward the same lockout.

What a sub-key shows is that a write was made with a key you approved. If several bots can read each other's files, EMET cannot prove which program was holding the key. If you think an active key has leaked, revoke it from your own login (`emet_subkey_revoke`), then the bot requests a new key and you approve it on the page. Deny only applies to a pending request.

## Building a bot team

For designing a team of bots, see Lauren Tan (@poteto, https://x.com/poteto), who works on Grok Bot and describes choosing a bot topology (one generalist, several narrow specialists, or generalists each owning a project) in [this post](https://x.com/poteto/status/2109781899610874002). Her bot designer, [dr eggbot](https://x.ai/bot/93gOz3op1UQdBdbekQFLK) ([source](https://x.com/poteto/status/2106895160298852470)), helped design the EMET author's own bot team.
