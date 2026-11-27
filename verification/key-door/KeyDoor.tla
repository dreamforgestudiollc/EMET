---- MODULE KeyDoor ----
\* Key sign-in. Passphrase, passphrase plus a key, or a key alone.
\* A key-only session has no owner rights.
\* A granted key session is attributed to the key's tag.
\* One key has one live consent. A later sign-in replaces it.
\* Revoke and expiry close that consent. A write after that does not happen.
\* The passphrase consent does not read a key.

VARIABLES signIn, key, role, ownerRights, attribution, granted, phase, consents, wrote, last
vars == <<signIn, key, role, ownerRights, attribution, granted, phase, consents, wrote, last>>

SignIn == {"passphrase", "owner_key", "key_only", "absent"}
Key == {"none", "active", "revoked", "expired", "unregistered", "mismatch"}
Role == {"start", "primary", "secondary", "key", "refused"}
Attribution == {"none", "owner_login", "key_tag"}
Phase == {"start", "decided", "live", "closed"}
Last == {"start", "grant", "refuse", "write", "revoke", "expire", "replace"}

Legal(s, k) ==
  IF s \in {"passphrase", "absent"} THEN k = "none"
  ELSE k \in Key

Result(s, k) ==
  IF s = "passphrase" THEN "primary"
  ELSE IF s \in {"owner_key", "key_only"} /\ k = "active" THEN
    IF s = "owner_key" THEN "secondary" ELSE "key"
  ELSE "refused"

OwnerOf(r) == r = "primary"
AttrOf(r) ==
  CASE r = "primary" -> "owner_login"
    [] r \in {"secondary", "key"} -> "key_tag"
    [] OTHER -> "none"
GrantedOf(r) == r \in {"primary", "secondary", "key"}
LiveRole(r) == r \in {"key", "secondary"}

TypeOK ==
  /\ signIn \in SignIn \cup {"start"}
  /\ key \in Key
  /\ role \in Role
  /\ ownerRights \in BOOLEAN
  /\ attribution \in Attribution
  /\ granted \in BOOLEAN
  /\ phase \in Phase
  /\ consents \in {0, 1}
  /\ wrote \in BOOLEAN
  /\ last \in Last

Init ==
  /\ signIn = "start"
  /\ key = "none"
  /\ role = "start"
  /\ ownerRights = FALSE
  /\ attribution = "none"
  /\ granted = FALSE
  /\ phase = "start"
  /\ consents = 0
  /\ wrote = FALSE
  /\ last = "start"

SignInStep ==
  /\ phase = "start"
  /\ \E s \in SignIn, k \in Key:
      /\ Legal(s, k)
      /\ LET r == Result(s, k) IN
          /\ signIn' = s
          /\ key' = k
          /\ role' = r
          /\ ownerRights' = OwnerOf(r)
          /\ attribution' = AttrOf(r)
          /\ granted' = GrantedOf(r)
          /\ wrote' = FALSE
          /\ IF LiveRole(r) /\ GrantedOf(r) THEN
              /\ phase' = "live"
              /\ consents' = 1
              /\ last' = "grant"
            ELSE
              /\ phase' = "decided"
              /\ consents' = 0
              /\ last' = IF GrantedOf(r) THEN "grant" ELSE "refuse"

Live ==
  /\ phase = "live"
  /\ granted = TRUE
  /\ key = "active"
  /\ LiveRole(role)
  /\ consents = 1

Write ==
  /\ Live
  /\ wrote' = TRUE
  /\ last' = "write"
  /\ UNCHANGED <<signIn, key, role, ownerRights, attribution, granted, phase, consents>>

Revoke ==
  /\ phase = "live"
  /\ LiveRole(role)
  /\ key' = "revoked"
  /\ granted' = FALSE
  /\ consents' = 0
  /\ phase' = "closed"
  /\ last' = "revoke"
  /\ UNCHANGED <<signIn, role, ownerRights, attribution, wrote>>

Expire ==
  /\ phase = "live"
  /\ LiveRole(role)
  /\ key' = "expired"
  /\ granted' = FALSE
  /\ consents' = 0
  /\ phase' = "closed"
  /\ last' = "expire"
  /\ UNCHANGED <<signIn, role, ownerRights, attribution, wrote>>

\* A second sign-in for the same key replaces the consent. The count stays one.
Replace ==
  /\ Live
  /\ last # "replace"
  /\ last' = "replace"
  /\ consents' = 1
  /\ UNCHANGED <<signIn, key, role, ownerRights, attribution, granted, phase, wrote>>

Done ==
  /\ phase \in {"decided", "closed"}
  /\ UNCHANGED vars

Next == SignInStep \/ Write \/ Revoke \/ Expire \/ Replace \/ Done

Spec == Init /\ [][Next]_vars

\* A key-only session is not the owner.
KeyOnlyNeverOwner ==
  role # "key" \/ ownerRights = FALSE

\* A secondary session is not the owner.
SecondaryNeverOwner ==
  role # "secondary" \/ ownerRights = FALSE

\* A granted key session is stamped with the key's tag.
KeyAttribution ==
  role \notin {"key", "secondary"} \/ ~granted \/ (attribution = "key_tag" /\ ownerRights = FALSE)

\* The passphrase consent stays the primary owner.
PrimaryUnchanged ==
  role # "primary" \/ (signIn = "passphrase" /\ ownerRights = TRUE /\ attribution = "owner_login" /\ key = "none")

\* A dead, unregistered, mismatched, or missing key grants nothing on a key consent.
BadKeyRefused ==
  signIn \notin {"owner_key", "key_only"}
    \/ key \notin {"revoked", "expired", "unregistered", "mismatch", "none"}
    \/ granted = FALSE
    \/ phase = "closed"

\* A write is recorded only while the key consent is live.
NoWriteAfterRevoke ==
  last # "write" \/ (key = "active" /\ granted = TRUE /\ phase = "live")

\* One key, one live consent.
OneLiveConsent ==
  consents \in {0, 1}
    /\ (phase = "live" => consents = 1)
    /\ (phase = "closed" => consents = 0)

====
