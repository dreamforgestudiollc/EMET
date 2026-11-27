---- MODULE EmetConsole ----
\* EMET Console (separate front-end app): sign-in, "remember this phone",
\* refresh, step-up and privileged actions for ONE connected EMET server.
\* Server isolation across several servers is in EmetConsoleServers.tla.
\* v2 2026-11-24: adds remember-this-phone (opt-in device-bound refresh row),
\* refresh with re-checks, device revoke, and Bat S-2 (key-door refresh row
\* with no key id is refused).
EXTENDS Naturals, FiniteSets

CONSTANTS Keys, PHASE, MAXPW

NOKEY == "nokey"

VARIABLES
  sess,      \* "none" | "owner" | "key"  - live access session for this phone
  sessPw,    \* admin-password version the owner session was minted under
  sessKey,   \* key behind a key session, or "none"
  stepUp,    \* "none" | "password" - how the step-up window was opened
  pwVer,     \* current admin-password version on the server
  keyState,  \* [Keys -> {"unissued","live","revoked"}]
  tokens,    \* [Keys -> BOOLEAN]  live access tokens exist for the key
  remember,  \* the owner/key holder ticked "remember this phone" at sign-in
  rrow,      \* server-side refresh row for this phone: [kind, pw, key]
  view,      \* "none" | "owner" | "key"  - what the server last served
  writes,    \* set of [tag, by] records written through the console
  minted,    \* access grants minted through the console
  privLog,   \* set of [stepUp, by], one per privileged action
  loggedOut  \* the person pressed sign out and has not signed in again

vars == <<sess, sessPw, sessKey, stepUp, pwVer, keyState, tokens, remember, rrow, view, writes, minted, privLog, loggedOut>>

TAG == "emet-console"
NoRow == [kind |-> "none", pw |-> 0, key |-> "none"]

Init ==
  /\ sess = "none" /\ sessPw = 0 /\ sessKey = "none" /\ stepUp = "none"
  /\ pwVer = 0
  /\ keyState = [k \in Keys |-> "unissued"]
  /\ tokens = [k \in Keys |-> FALSE]
  /\ remember = FALSE /\ rrow = NoRow
  /\ view = "none" /\ writes = {} /\ minted = 0 /\ privLog = {}
  /\ loggedOut = FALSE

OwnerValid == sess = "owner" /\ sessPw = pwVer

\* ---- sign-in (remember is the opt-in tick box, off by default) ----
OwnerSignsIn(r) ==
  /\ sess = "none"
  /\ sess' = "owner" /\ sessPw' = pwVer /\ stepUp' = "none" /\ sessKey' = "none"
  /\ remember' = r
  /\ rrow' = IF r THEN [kind |-> "owner", pw |-> pwVer, key |-> "none"] ELSE NoRow
  /\ loggedOut' = FALSE
  /\ UNCHANGED <<pwVer, keyState, tokens, view, writes, minted, privLog>>

KeySignsIn(k, r) ==
  /\ sess = "none" /\ keyState[k] = "live"
  /\ sess' = "key" /\ sessKey' = k /\ tokens' = [tokens EXCEPT ![k] = TRUE]
  /\ remember' = r
  /\ rrow' = IF r THEN [kind |-> "key", pw |-> 0, key |-> k] ELSE NoRow
  /\ loggedOut' = FALSE
  /\ UNCHANGED <<sessPw, stepUp, pwVer, keyState, view, writes, minted, privLog>>

\* Bat S-2: a key-door refresh row with no key id (legacy or corrupted) exists.
LegacyKeyRowWithNoKeyId ==
  /\ rrow.kind = "none" /\ remember /\ ~loggedOut
  /\ rrow' = [kind |-> "key", pw |-> 0, key |-> NOKEY]
  /\ UNCHANGED <<sess, sessPw, sessKey, stepUp, pwVer, keyState, tokens, remember, view, writes, minted, privLog, loggedOut>>

\* ---- access token lapses; the refresh row (if any) stays ----
AccessLapses ==
  /\ sess /= "none"
  /\ sess' = "none" /\ sessKey' = "none" /\ stepUp' = "none" /\ view' = "none"
  /\ UNCHANGED <<sessPw, pwVer, keyState, tokens, remember, rrow, writes, minted, privLog, loggedOut>>

\* ---- refresh: re-checks everything, never grants step-up ----
RefreshOK ==
  \/ rrow.kind = "owner" /\ rrow.pw = pwVer
  \/ rrow.kind = "key" /\ rrow.key \in Keys /\ keyState[rrow.key] = "live"

Refresh ==
  /\ sess = "none" /\ rrow.kind /= "none" /\ RefreshOK
  /\ sess' = rrow.kind
  /\ sessPw' = IF rrow.kind = "owner" THEN pwVer ELSE sessPw
  /\ sessKey' = IF rrow.kind = "key" THEN rrow.key ELSE "none"
  /\ stepUp' = "none"
  /\ UNCHANGED <<pwVer, keyState, tokens, remember, rrow, view, writes, minted, privLog, loggedOut>>

\* Refused refresh (S-2 row, stale password, revoked key): row deleted, nothing served.
RefreshRefused ==
  /\ sess = "none" /\ rrow.kind /= "none" /\ ~RefreshOK
  /\ rrow' = NoRow
  /\ UNCHANGED <<sess, sessPw, sessKey, stepUp, pwVer, keyState, tokens, remember, view, writes, minted, privLog, loggedOut>>

\* ---- sign out ends the session AND deletes this phone's refresh row ----
SignOut ==
  /\ sess /= "none" \/ rrow.kind /= "none"
  /\ sess' = "none" /\ sessKey' = "none" /\ stepUp' = "none" /\ view' = "none"
  /\ rrow' = NoRow /\ remember' = FALSE /\ loggedOut' = TRUE
  /\ UNCHANGED <<sessPw, pwVer, keyState, tokens, writes, minted, privLog>>

\* Owner removes this remembered phone from the server (sessions list, Phase 2/3,
\* or break-glass): session and refresh row end together.
DeviceRevokedFromServer ==
  /\ rrow.kind /= "none"
  /\ rrow' = NoRow
  /\ sess' = "none" /\ sessKey' = "none" /\ stepUp' = "none" /\ view' = "none"
  /\ UNCHANGED <<sessPw, pwVer, keyState, tokens, remember, writes, minted, privLog, loggedOut>>

\* ---- reading ----
OpenOwnerView ==
  /\ OwnerValid
  /\ view' = "owner"
  /\ UNCHANGED <<sess, sessPw, sessKey, stepUp, pwVer, keyState, tokens, remember, rrow, writes, minted, privLog, loggedOut>>

KeyAsksOwnerView ==           \* refused with EMET-AUTH-046, nothing served
  /\ sess = "key"
  /\ UNCHANGED vars

OpenKeyView ==
  /\ sess = "key" /\ sessKey \in Keys /\ keyState[sessKey] = "live"
  /\ view' = "key"
  /\ UNCHANGED <<sess, sessPw, sessKey, stepUp, pwVer, keyState, tokens, remember, rrow, writes, minted, privLog, loggedOut>>

AddNote ==
  /\ OwnerValid
  /\ writes' = writes \cup {[tag |-> TAG, by |-> "owner"]}
  /\ UNCHANGED <<sess, sessPw, sessKey, stepUp, pwVer, keyState, tokens, remember, rrow, view, minted, privLog, loggedOut>>

\* ---- step-up: only by re-entering the admin password ----
StepUp ==
  /\ OwnerValid /\ stepUp = "none"
  /\ stepUp' = "password"
  /\ UNCHANGED <<sess, sessPw, sessKey, pwVer, keyState, tokens, remember, rrow, view, writes, minted, privLog, loggedOut>>

StepUpLapses ==               \* 5 minutes pass
  /\ stepUp /= "none"
  /\ stepUp' = "none"
  /\ UNCHANGED <<sess, sessPw, sessKey, pwVer, keyState, tokens, remember, rrow, view, writes, minted, privLog, loggedOut>>

\* ---- privileged actions (Phase 3 only) ----
Priv == OwnerValid /\ stepUp = "password" /\ PHASE >= 3

IssueKey(k) ==
  /\ Priv /\ keyState[k] = "unissued"
  /\ keyState' = [keyState EXCEPT ![k] = "live"]
  /\ minted' = minted + 1
  /\ privLog' = privLog \cup {[stepUp |-> stepUp, by |-> sess]}
  /\ UNCHANGED <<sess, sessPw, sessKey, stepUp, pwVer, tokens, remember, rrow, view, writes, loggedOut>>

RevokeKey(k) ==               \* tokens and refresh rows for the key go in the same step
  /\ Priv /\ keyState[k] = "live"
  /\ keyState' = [keyState EXCEPT ![k] = "revoked"]
  /\ tokens' = [tokens EXCEPT ![k] = FALSE]
  /\ rrow' = IF rrow.kind = "key" /\ rrow.key = k THEN NoRow ELSE rrow
  /\ privLog' = privLog \cup {[stepUp |-> stepUp, by |-> sess]}
  /\ UNCHANGED <<sess, sessPw, sessKey, stepUp, pwVer, remember, view, writes, minted, loggedOut>>

KeyRevokedElsewhere ==        \* chat tool, break-glass, rotation/grace end (S-3)
  /\ sess = "key" /\ sessKey \in Keys /\ keyState[sessKey] = "live"
  /\ keyState' = [keyState EXCEPT ![sessKey] = "revoked"]
  /\ tokens' = [tokens EXCEPT ![sessKey] = FALSE]
  /\ rrow' = IF rrow.kind = "key" /\ rrow.key = sessKey THEN NoRow ELSE rrow
  /\ sess' = "none" /\ sessKey' = "none" /\ view' = "none"
  /\ UNCHANGED <<sessPw, stepUp, pwVer, remember, writes, minted, privLog, loggedOut>>

PasswordRotated ==            \* ends owner sessions and owner refresh rows
  /\ pwVer < MAXPW
  /\ pwVer' = pwVer + 1
  /\ IF sess = "owner"
       THEN sess' = "none" /\ stepUp' = "none" /\ view' = "none"
       ELSE UNCHANGED <<sess, stepUp, view>>
  /\ rrow' = IF rrow.kind = "owner" THEN NoRow ELSE rrow
  /\ UNCHANGED <<sessPw, sessKey, keyState, tokens, remember, writes, minted, privLog, loggedOut>>

Next ==
  \/ \E r \in BOOLEAN : OwnerSignsIn(r)
  \/ \E k \in Keys, r \in BOOLEAN : KeySignsIn(k, r)
  \/ LegacyKeyRowWithNoKeyId
  \/ AccessLapses \/ Refresh \/ RefreshRefused \/ SignOut \/ DeviceRevokedFromServer
  \/ OpenOwnerView \/ KeyAsksOwnerView \/ OpenKeyView \/ AddNote
  \/ StepUp \/ StepUpLapses
  \/ (\E k \in Keys : IssueKey(k)) \/ (\E k \in Keys : RevokeKey(k))
  \/ KeyRevokedElsewhere \/ PasswordRotated

Spec == Init /\ [][Next]_vars

\* ---------------- rules ----------------
ConsoleIsOwnerOnly == view = "owner" => sess = "owner"
KeySessionCannotReachOwnerViews == sess = "key" => view /= "owner"
NoConsoleAfterLogoutOrRotate == view = "owner" => OwnerValid
ConsoleWriteAttributed == \A w \in writes : w.tag = TAG /\ w.by = "owner"
ConsoleNeverMintsAccess == PHASE < 3 => (minted = 0 /\ privLog = {})
PrivilegedActionRequiresStepUp == \A p \in privLog : p.stepUp = "password" /\ p.by = "owner"
RevokeTakesEffectImmediately ==
  \A k \in Keys : keyState[k] = "revoked" =>
     (~tokens[k] /\ ~(sess = "key" /\ sessKey = k) /\ ~(rrow.kind = "key" /\ rrow.key = k))
\* remember-this-phone rules
RememberIsOptIn == rrow.kind /= "none" => remember
StepUpOnlyByPassword == stepUp \in {"none", "password"}
NoOwnerRefreshAfterRotate == rrow.kind = "owner" => rrow.pw = pwVer
SessionNeedsLiveCredential ==
  /\ (sess = "owner" => sessPw = pwVer)
  /\ (sess = "key" => sessKey \in Keys /\ keyState[sessKey] = "live")
LogoutEndsRemember == loggedOut => (rrow.kind = "none" /\ sess = "none")
====
