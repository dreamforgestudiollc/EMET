# EMET Console

The console is a separate Railway service in the same project as EMET. It is a static app. It holds no memory and no passwords. Each EMET server the app talks to keeps its own store, its own admin password, and its own allow-list.

Do not point the console at a second EMET server unless the owner has approved that instance. A throwaway test server is a disposable store, torn down after the test.

## Create the service

1. In the EMET Railway project, add a service from this repo.
2. Set the service root directory to `console`.
3. Railway reads `console/railway.json` and builds `console/Dockerfile`.
4. The EMET server service stays on the repo root. Its image does not copy `console/` (`.dockerignore`).
5. Deploy the console service only after the server image that contains `/console/api` is the one running. This document does not deploy either one.

## Variables

Set these on the services. The names are the whole of what this repo records. Values stay in Railway.

**EMET server**

| Name | What it does |
|---|---|
| `EMET_CONSOLE_ORIGINS` | Comma-separated exact origins of the console (scheme, host, and port). Empty or unset turns `/console/api` off. |
| `EMET_SOURCE_TAGS` | Must include `emet-console` or Add note refuses with EMET-DOC-020. |
| `EMET_CONSOLE_REFRESH_IDLE_DAYS` | Optional. Default 14. A remembered phone that sits idle past this is signed out. |
| `EMET_CONSOLE_REFRESH_ABSOLUTE_DAYS` | Optional. Default 30. A remembered phone cannot last longer than this. |

**Console service**

| Name | What it does |
|---|---|
| `EMET_CONSOLE_PUBLIC_URL` | The public https origin of this console service, with no path. It is the origin inside the CIMD document at `/.well-known/emet-console-client.json`. |
| `EMET_CONSOLE_CONNECT_ORIGINS` | Comma-separated https origins of the EMET servers this app may call. They are added to `connect-src`. |

The console does not receive `EMET_OAUTH_PASSPHRASE`, `EMET_ADMIN_PEPPER`, the admin password, or `MONGODB_URI`.

## Sign-in

The app opens that server's `/authorize` with scope `emet.console` and PKCE. The owner types the admin password on the server's page. The connect passphrase is refused. "Remember this phone" is unticked until the person ticks it there.

Each server must list this console's origin in its own `EMET_CONSOLE_ORIGINS`, and must list `emet-console` in `EMET_SOURCE_TAGS`, before Add note works.

## A second, throwaway server

1. Add another EMET service in the same project from this repo, with its own volume-less store and its own variables. Do not copy the production database.
2. Set that service's `EMET_CONSOLE_ORIGINS` to the same console origin, and add `emet-console` to its `EMET_SOURCE_TAGS`.
3. Add that server's https origin to the console's `EMET_CONSOLE_CONNECT_ORIGINS`.
4. In the app, Add server, paste the throwaway URL, and confirm the `meta` card before saving.
5. Tear the throwaway service down when the test is finished. Remove its origin from `EMET_CONSOLE_CONNECT_ORIGINS`.

## Health

`GET /health` on the console service returns `{ "ok": true, "service": "emet-console" }`. It is not an EMET memory route.
