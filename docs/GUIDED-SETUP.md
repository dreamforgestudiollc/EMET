# Guided setup — let your AI set EMET up for you

This is the path for someone who has never deployed anything. You do three things in a
browser when asked. Your AI does everything else — installs, configures, deploys, verifies —
and tells you what it did at each stage.

**Part A** is for you. It is short. **Part B** is for your AI; you do not need to read it.

---

## Part A — for the person

### What you are setting up

A memory your AI keeps between conversations, on every device you use — it is a small server
plus a database, and your AI will hold the whole thing together from here. When it is done,
you say **"initialize"** at the start of a conversation and your AI picks up where it left
off.

### What you need before you start

- **Claude** (or another MCP-capable assistant) — and a way for it to run commands on your
  computer. See *Giving your AI a shell* below. This is the one step you do yourself.
- **About 30–45 minutes**, mostly waiting.
- **An email address** for two free accounts: MongoDB Atlas (the database) and Railway (the
  host). Atlas's free tier needs no card. Railway may ask for a card or a small plan for an
  always-on server — check what it shows you at sign-up; your AI will tell you the moment it
  needs you there.

### Giving your AI a shell

Your AI can only set things up if it can run commands. Pick whichever of these matches what
you have:

| You use | What to do |
|---|---|
| **Claude Desktop (the app)** | Install **Desktop Commander**, an MCP server that gives Claude a terminal and file access. Run this in a terminal: `npx @wonderwhy-er/desktop-commander@latest setup` (needs Node.js — <https://nodejs.org>, LTS). Then **fully quit and restart Claude Desktop.** Other installers: <https://github.com/wonderwhy-er/DesktopCommanderMCP>. |
| **Claude Code (the terminal tool)** | Nothing. It already has a shell. |
| **Claude Cowork** | Nothing. It has its own shell. |

One honest note about Desktop Commander: it can run any command you could run. That is what
makes guided setup possible, and it is also why you should read what your AI says it is about
to do. Per-step approval in Claude Desktop is the safety net — keep it on.

### Starting

Paste this into a new conversation:

> Set up EMET for me. Fetch `https://raw.githubusercontent.com/dreamforgestudiollc/EMET/main/docs/GUIDED-SETUP.md`, read Part B, and follow it stage by stage. Ask me only when a step needs me — I will sign in to things when you tell me to. I want the remote (phone-reachable) server too.

(Drop the last sentence if you only want it on this one computer. If the link does not open
for your AI — the repository may be private — download this file and paste Part B into the
conversation instead.)

### The three moments you will be asked to act

1. **Sign in to MongoDB Atlas** — a browser window opens; create an account or sign in. Your AI waits.
2. **Sign in to Railway** — same shape. If Railway asks for a card or a plan, that is between you and Railway; your AI will pause until you are through.
3. **Add the connector in Claude** — Settings → Connectors → *Add custom connector* → paste the URL your AI gives you → enter the passphrase it gives you. Enable it in your conversation from the **+** menu.

Then say **"initialize"**. Your AI will ask you a few questions about who it should be and who you are. That is the setup interview, and it is the part that turns a database into a memory.

### Keep two things

Your AI will hand you a **passphrase** and a **URL** at the end. Keep both somewhere safe. The passphrase is the whole perimeter of your memory — there is no second factor.

### Every conversation from now on: two words

**"initialize"** as your first message — your AI loads who it is, who you are, and where you
left off. **"wrap up"** as your last — it writes the handoff, the state, a session entry and
the word-for-word transcript, then confirms with `emet_session_close` that everything landed.
Wait for it to say **complete** before you close the window. Skip the first and it answers from
guesswork; skip the second and the next session inherits a hole. The README's *Every session
after that* section says why.

---

## Part B — for the AI

You are setting up EMET for a person who may never have done anything like this. Your job is to
do every step you can, ask for exactly the steps you cannot, verify each stage before the next,
and report plainly. Read all of Part B before running anything.

### Rules that hold for the whole procedure

1. **Never put a secret in the conversation.** Not the connection string, not the passphrase,
   not a token. Write them to files and environment variables with your tools. When you must
   hand the person a value (the passphrase, once), say what it is for and where to keep it.
   EMET masks secrets in anything written to its own store; the chat you are in is not that store.
2. **Generate the passphrase yourself.** 24+ characters, letters and digits, no ambiguous
   glyphs — `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`.
   Do not ask the person to invent one.
3. **Verify before proceeding.** Every stage ends with a check. If the check fails, stop, show
   the person the actual output, and say what you think it means — marked as your reading, not
   as fact. Do not retry blindly and do not invent a cause.
4. **Ask only at the three human moments** (Atlas sign-in, Railway sign-in, connector add) and
   when a command genuinely needs something only they have. Everything else is yours.
5. **One machine at a time.** If you are running in a cloud sandbox rather than on the person's
   computer, say so, and know that local-server config (stage 2) must be written on *their*
   machine, not yours.
6. **Report each stage in two or three sentences.** What you did, what you verified, what is next.

### Stage 0 — check the ground

```
node --version        # need 20+ (package.json engines); 22 preferred
npm --version
git --version
```

If `node` is missing: on Windows `winget install OpenJS.NodeJS.LTS`; macOS `brew install node`;
Linux via the distribution package or <https://nodejs.org>. If `git` is missing, download the
repository as a zip instead of cloning.

Then get the code:

```
git clone https://github.com/dreamforgestudiollc/EMET.git
cd EMET
npm install
```

**Verify:** `node -e "import('./src/layers.js').then(m => console.log(Object.keys(m.LAYER_CHARTER).length + ' layers'))"` prints `6 layers`.

### Stage 1 — the database (MongoDB Atlas)

**Install the Atlas CLI.** Windows: download and run the `.msi` from
<https://www.mongodb.com/docs/atlas/cli/current/install-atlas-cli/> (you can open the download
for the person and ask them to click through; then open a fresh shell so PATH updates). macOS:
`brew install mongodb-atlas-cli`. Linux: the apt/yum instructions on that same page. Verify with
`atlas --version`.

**Human moment 1.** Run:

```
atlas auth login
```

A browser opens. Tell the person: *"A MongoDB window has opened. Create an account or sign in — the free tier needs no card. Tell me when you are back."* Wait. Then `atlas auth whoami` must print their account.

**Create everything in one command.** Generate a database password first (same method as the
passphrase; keep it out of the chat). Then:

```
atlas setup --clusterName emet --tier M0 --username emet_app --password <generated> \
  --accessListIp 0.0.0.0/0 --skipSampleData --skipMongosh --force
```

`--accessListIp 0.0.0.0/0` is deliberate: a hosted server's egress IP is dynamic, so it cannot
be allowlisted, and security rests on the scoped user plus the OAuth passphrase. If the person
wants a **local-only** setup, use `--currentIp` instead. `--force` accepts defaults for
anything unspecified (provider and region — fine). If `atlas setup` reports it needs a project
or organization, follow its prompt; it creates them.

Cluster creation takes a few minutes. Poll:

```
atlas clusters describe emet --output json
```

until `"stateName": "IDLE"`.

**Get the connection string and write `.env`:**

```
atlas clusters connectionStrings describe emet --output json
```

Take the `standardSrv` value (`mongodb+srv://emet.xxxxx.mongodb.net`) and insert the user and
password: `mongodb+srv://emet_app:<password>@emet.xxxxx.mongodb.net/?retryWrites=true&w=majority`.
**Percent-encode the password if it contains `@ : / ? # [ ] %`** — a generated base64url
password will not. Copy `.env.example` to `.env` and set:

```
MONGODB_URI=<the string above>
MONGODB_DB=emet
EMET_SOURCE_TAG=<this computer's name, e.g. laptop>
```

**Verify:** `node -e "import('mongodb').then(async ({MongoClient}) => { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); console.log('ok', (await c.db('emet').command({ping:1})).ok); await c.close(); })"` — run with the `.env` loaded (`node --env-file=.env -e "..."` on Node 20.6+). Expect `ok 1`. If it times out, the access list has not propagated yet; wait a minute and retry once.

**Skip the vector index for now.** `semantic_recall` is optional; keyword recall works without
it, and Atlas Automated Embedding is not available on every tier. It is a later step, in
[SETUP.md](SETUP.md) stage 1, item 7, once everything else works.

### Stage 2 — the local server (this computer)

This is what the person's desktop assistant talks to. It runs from the repo folder.

Write the MCP client entry. For Claude Desktop, merge into `claude_desktop_config.json`
(Windows `%APPDATA%\Claude\claude_desktop_config.json`; macOS
`~/Library/Application Support/Claude/claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json`).
**Read the file first and merge — do not overwrite other servers** (Desktop Commander's own
entry is in there):

```json
"emet": {
  "command": "node",
  "args": ["<absolute path to repo>/src/index.js"],
  "env": { "MONGODB_URI": "<from .env>", "MONGODB_DB": "emet", "EMET_SOURCE_TAG": "<same tag>" }
}
```

Absolute path, forward slashes are fine on Windows. For Claude Code: `claude mcp add emet -e MONGODB_URI=<...> -e MONGODB_DB=emet -e EMET_SOURCE_TAG=<tag> -- node <absolute path>/src/index.js`, or the `.mcp.json` equivalent.

**Human moment (small):** *"Fully quit Claude Desktop — from the system tray, not just the window — and open it again. Tell me when it is back."* Then, in the new conversation, the `emet` tools appear. Call `emet_status`: expect `initialized: false` and a live database. Call it again with `probe: true`: it writes a probe and reads it back — expect every check passed.

If the person only wanted this computer, skip to stage 4.

### Stage 3 — the remote server (phone and everything else)

```
npm i -g @railway/cli
railway --version
```

On Windows, if the shim fails with `'"node"' is not recognized`, call the binary directly:
`%APPDATA%\npm\node_modules\@railway\cli\bin\railway.exe`.

**Human moment 2.** Run `railway login` (plain — not `--browserless`, which only works when
approved on the same machine). Tell the person: *"A Railway window has opened. Create an account
or sign in. If it asks for a card or a plan, that is Railway's requirement for an always-on
server — decide there and tell me when you are through."* Wait. `railway whoami` must print them.

**Create the project and set variables BEFORE the first deploy** — a server that boots once
misconfigured leaves residue:

```
railway init                      # from the repo root; name it emet
railway variables --set MONGODB_URI=<from .env> --set MONGODB_DB=emet \
  --set EMET_OAUTH_PASSPHRASE=<generated passphrase> --set EMET_SOURCE_TAGS=<every host's tag, e.g. laptop,phone>
railway up --detach
railway domain                    # prints https://<something>.up.railway.app
railway variables --set PUBLIC_URL=https://<that host>
railway up --detach               # second pass: PUBLIC_URL is the OAuth issuer and must match
```

Leave `EMET_SOURCE_TAG` unset on this server: several hosts share it, each host passes its own
tag as `source` on its writes, and `EMET_SOURCE_TAGS` registers the tags. A default tag would
make every host look the same; set one only on a server a single host uses.

The repository's `Dockerfile` already starts the HTTP transport; no start command to set. The
two-pass deploy is not optional. **Never run `railway variables` without `--kv` and never paste
its output anywhere** — it prints secrets in plaintext.

**Verify** (build takes about two minutes; poll):

```
curl https://<host>/health                                  → {"ok":true,"service":"emet","tools":N,...}
curl https://<host>/.well-known/oauth-authorization-server  → OAuth metadata, not a 404
```

A 404 on the second means `PUBLIC_URL` is wrong. The connector URL is `https://<host>/mcp` —
**the `/mcp` suffix is required**; the root path is 404 by design.

**Human moment 3.** Tell the person, exactly: *"Open Claude → Settings → Connectors → Add custom
connector. Name: EMET. URL: `https://<host>/mcp`. Click connect — you will be sent to a
passphrase page. The passphrase is: `<passphrase>` — keep it; it is the only key to your memory.
Then enable EMET in this conversation from the + menu and tell me."*

**Verify from the remote route:** `emet_status` with `probe: true` through the connector. Then the real
test — `remember` something on one route and `recall` it on the other. If both see it, the
deployment is real.

### Stage 4 — the interview

Say nothing about setup. Call `emet_initialize`. On a new store it returns `setup_required` and
the interview questions. Ask them **conversationally, one at a time** — what the assistant should
be called and how it should carry itself, the person's name in the form they want used, what the
memory is for, and optionally how they want to be worked with and this host's tag. Then
`emet_setup_complete`. It refuses partial answers rather than inventing an identity; that is
correct behaviour.

Then hand the person the short instruction block from [BOOTSTRAP.md](BOOTSTRAP.md) to paste
into their project instructions, so future sessions consult the memory without being told.

### Stage 5 — close out

Tell the person, in plain words:

- what was set up (local server, remote server, or both) and where the code lives on disk;
- the connector URL and that the passphrase is the whole perimeter — rotate it by changing
  `EMET_OAUTH_PASSPHRASE` on Railway and redeploying, which invalidates every device;
- that every host has its own source tag (a local entry's `EMET_SOURCE_TAG`; on the shared
  remote server, the `source` each host passes, registered in `EMET_SOURCE_TAGS`), and what
  this one's is;
- that `emet_status` (and `emet_status` with `probe: true`) is the thing to call when
  something seems wrong, and [SETUP.md](SETUP.md) has the symptom table;
- that after any future deploy which changes the tool list, each device must reconnect the
  connector to see the new tools — nothing breaks, the new ones just stay invisible until then.
- that if they later run other agents (bots) against the same memory, each needs its own tag,
  its own handoff and a roster row before its first write — [BOTS.md](BOTS.md) is the procedure,
  and their own assistant's tag (the hub) is never listed as a bot.

Do not summarise what the person told you in the interview back at them. It is stored; they
know what they said.
