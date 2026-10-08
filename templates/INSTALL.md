# TEMPLATE — INSTALL

**Template control:** id `templates/INSTALL.md` · revision: the store's version governs · status: IN FORCE · approved: user · 2026-09-26 · a decision record · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** `bootstrap/INSTALL.md` — this install's hosts, machines, source tags, and the checks a session runs before the startup list. Optional; absence is not an error.
**Failure it prevents:** a paste-block-only start that cannot check a machine, mint a session id, or tag a write, because those notes lived only in one install's head (proof of concept 2026-09-26; `install_notes` served from this document when present).
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **Optional.** A new store may have none until the user adds hosts.
2. **Checks are ordered and owned.** A session runs them in the order written and states what this document asks it to state.
3. **No secrets.** Tags and host names only. Credentials never live here.

---

## §0 RECORD CONTROL
- Template: `templates/INSTALL.md` rev __ · Record revision: the store's version governs
- Session id: __ · Source tag: __ · Written (local): __

## §1 HOSTS AND TAGS
Each host this user uses, and the source tag writes from that host carry.

## §2 SESSION START CHECKS
The checks to run before the startup list, in order — or *"None."*

## §3 SESSION ID FORM
The form of the session id, default `YYYY-MM-DD_short-name` from the user's local date — or *"Default."*
