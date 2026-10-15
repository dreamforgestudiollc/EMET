# Security

## Reporting a vulnerability

Report privately through [GitHub security advisories](https://github.com/dreamforgestudiollc/EMET/security/advisories/new). Do not open a public issue. Include the EMET version, the transport (stdio or remote HTTP), and steps to reproduce. Do not include real passphrases, tokens, connection strings or memory content.

## Supported versions

EMET is 0.x. Only the latest release ([releases](https://github.com/dreamforgestudiollc/EMET/releases)) receives fixes.

## Scope

EMET runs on infrastructure you control: your host, your MongoDB, your `EMET_OAUTH_PASSPHRASE`. Securing that deployment is yours. Reports about EMET's own code are in scope, including OAuth, source-tag guards (`EMET_SOURCE_TAGS`), access grants, the no-delete write path, and the GEM socket and `gem-check`.
