# TEMPLATE — GRANT

**Template control:** id `templates/GRANT.md` · revision: the store's version governs · status: DRAFT, not in force · approved: pending — R2 design 2026-10-26; IN FORCE only once the user approves this text and the decision record is filed · owner: EMET (base) · built to `templates/STANDARD.md` · supersedes: none
**Fills:** a grant record. Unmapped while DRAFT. The live credential is the OAuth token family (`src/grants.js`, `src/oauth-provider.js`). A filled `grants/<grant id>.md` is a later, owner-written record of that credential. It is not a second secret and it does not authorize anything by itself.
**Failure it prevents:** a write stamped with another connection's name because the credential that made the write was not on the row. The shared case is one OAuth client, one consent, and a caller-declared tag (recorded 2026-10-11 and 2026-10-15). The credential was the token family. The row did not carry it.
**Completion rules:** `templates/STANDARD.md` §5, unmodified.

---

## HOW TO FILL — rules specific to this template

1. **One record per grant.** The grant id is the token family. Do not invent a second id. Do not copy the access token, the refresh token, or the passphrase into this record.
2. **The door is owner, member, or guest.** Guest is the invite door. A missing door on an old token is recorded as unknown, not guessed as owner.
3. **The tag is bound to this grant.** A declared tag is a claim. It does not outrank the tag this grant was given. Two agents that share one bearer still share one grant; say so in §3.
4. **End a grant by supersede, revoke, or retain.** Revoke stops new use. The record stays. Nothing in this template is a delete.
5. **Do not fill a grace window.** A household rotation is revoke-all and fresh invites. Blank means there is none. Do not write a number.

---

## §0 RECORD CONTROL
- Template: `templates/GRANT.md` rev __ · Grant revision: the store's version governs
- Grant id: __
- Door: __ (owner · member · guest · unknown)
- Written (local): __ · Session id: __ · Source tag: __

## §1 CREDENTIAL
- **Client id:** __ (registration id or metadata URL; not a secret)
- **Person id:** __
- **Bound tag:** __
- **Created:** __ · **Created via:** __ (consent · invite · migration)
- **Status:** __ (live · revoked · superseded)

## §2 WHAT THIS DOOR MAY DO
- **Scopes:** __
- **May approve new writers:** __ (owner only, until a later decision says otherwise)
- **Write versus read:** __ · If Claude or ChatGPT: `NOT DECIDED`

## §3 SHARED BEARER
Who else can present this same grant, or *"None — this grant is one consent and one holder."*

## §4 END
- **Action:** __ (revoke · supersede · retain) · **Grace window:** none
- **Replaced by grant id:** __ or *"None."*
- **Reason:** __
- **Rows already written:** retained. A correction is a later record, not an edit of the old row.

## §5 NOT THIS RECORD
Chooser page, deep link, and break-glass: later. Household rotate-all: later, and it has no grace window. A second login kept only to obtain another client id: later, revoked, not erased.
