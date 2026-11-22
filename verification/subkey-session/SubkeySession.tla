---- MODULE SubkeySession ----
\* One sub-key, one session slot.
\* Renewal and reclaim replace that slot. They do not add a second live session.
\* A handle with no key does not mint the next session.
\* Another key's credential does not close this session.
\* Time is a phase: fresh, window, grace, beyond. Handles and key bytes are not states.
\* `store` counts session-record writes. A status read and a leaked handle leave it unchanged.

EXTENDS Integers

VARIABLES sess, phase, kind, wrap, gen, live, reclaims, bareMint, closedBy, prevClosed, store, prevStore, act
vars == <<sess, phase, kind, wrap, gen, live, reclaims, bareMint, closedBy, prevClosed, store, prevStore, act>>
session == <<sess, phase, kind, wrap, gen, live, reclaims, bareMint, closedBy, prevClosed>>

Sess == {
  "opening", "live", "renewal_offered", "ended", "expired",
  "unwrapped", "closed", "auto_closed", "revoked"
}
Phase == {"fresh", "window", "grace", "beyond"}
Kind == {"bot", "chat"}
Closed == {"closed", "auto_closed", "revoked"}
Closer == {"none", "same", "owner", "sweep"}
Act == {"init", "write", "status", "bare", "idle"}

TypeOK ==
  /\ sess \in Sess
  /\ phase \in Phase
  /\ kind \in Kind
  /\ wrap \in BOOLEAN
  /\ gen \in 0..1
  /\ live \in 0..1
  /\ reclaims \in 0..1
  /\ bareMint \in BOOLEAN
  /\ closedBy \in Closer
  /\ prevClosed \in BOOLEAN
  /\ store \in Nat
  /\ prevStore \in Nat
  /\ act \in Act

Init ==
  /\ sess = "opening"
  /\ phase = "fresh"
  /\ kind \in Kind
  /\ wrap \in BOOLEAN
  /\ gen = 0
  /\ live = 0
  /\ reclaims = 0
  /\ bareMint = FALSE
  /\ closedBy = "none"
  /\ prevClosed = FALSE
  /\ store = 0
  /\ prevStore = 0
  /\ act = "init"

\* A step that changes the session record.
Wrote ==
  /\ store' = store + 1
  /\ prevStore' = store
  /\ act' = "write"

\* A step that does not change the session record.
Read(name) ==
  /\ store' = store
  /\ prevStore' = store
  /\ act' = name

Terminal == sess \in Closed

Commit ==
  /\ sess = "opening"
  /\ phase \in {"fresh", "window"}
  /\ sess' = "live"
  /\ live' = 1
  /\ Wrote
  /\ UNCHANGED <<phase, kind, wrap, gen, reclaims, bareMint, closedBy, prevClosed>>

Lose ==
  /\ sess = "opening"
  /\ sess' = "ended"
  /\ live' = 0
  /\ Wrote
  /\ UNCHANGED <<phase, kind, wrap, gen, reclaims, bareMint, closedBy, prevClosed>>

Offer ==
  /\ sess = "live"
  /\ phase = "window"
  /\ live = 1
  /\ sess' = "renewal_offered"
  /\ Wrote
  /\ UNCHANGED <<phase, kind, wrap, gen, live, reclaims, bareMint, closedBy, prevClosed>>

Advance ==
  /\ phase /= "beyond"
  /\ phase' = IF phase = "fresh" THEN "window"
              ELSE IF phase = "window" THEN "grace"
              ELSE "beyond"
  /\ IF sess \in {"live", "renewal_offered"} /\ phase' \in {"grace", "beyond"}
     THEN /\ sess' = "expired"
          /\ live' = 0
     ELSE /\ sess' = sess
          /\ live' = live
  /\ Wrote
  /\ UNCHANGED <<kind, wrap, gen, reclaims, bareMint, closedBy, prevClosed>>

\* The sub-key and the previous handle. One slot. The previous session is closed.
Renew ==
  /\ gen < 1
  /\ phase \in {"window", "grace"}
  /\ sess \in {"live", "renewal_offered", "expired"}
  /\ sess' = "live"
  /\ phase' = "fresh"
  /\ gen' = gen + 1
  /\ live' = 1
  /\ prevClosed' = TRUE
  /\ closedBy' = "same"
  /\ bareMint' = FALSE
  /\ Wrote
  /\ UNCHANGED <<kind, wrap, reclaims>>

\* The same key, once. A bot's healthy slot is not reclaimed. A chat slot is.
Reclaim ==
  /\ reclaims < 1
  /\ sess /= "opening"
  /\ ~Terminal
  /\ \/ kind = "chat"
     \/ sess \in {"ended", "expired", "unwrapped"}
     \/ phase \in {"grace", "beyond"}
  /\ sess' = "live"
  /\ phase' = "fresh"
  /\ live' = 1
  /\ reclaims' = reclaims + 1
  /\ prevClosed' = TRUE
  /\ closedBy' = "same"
  /\ bareMint' = FALSE
  /\ Wrote
  /\ UNCHANGED <<kind, wrap, gen>>

Unwrap ==
  /\ kind = "chat"
  /\ wrap = FALSE
  /\ phase = "grace"
  /\ sess = "expired"
  /\ sess' = "unwrapped"
  /\ live' = 0
  /\ bareMint' = FALSE
  /\ Wrote
  /\ UNCHANGED <<phase, kind, wrap, gen, reclaims, closedBy, prevClosed>>

OwnerClose ==
  /\ ~Terminal
  /\ sess' = "closed"
  /\ live' = 0
  /\ closedBy' = "owner"
  /\ prevClosed' = TRUE
  /\ Wrote
  /\ UNCHANGED <<phase, kind, wrap, gen, reclaims, bareMint>>

Sweep ==
  /\ ~Terminal
  /\ \/ phase = "beyond"
     \/ sess = "ended"
  /\ sess' = "auto_closed"
  /\ live' = 0
  /\ closedBy' = "sweep"
  /\ prevClosed' = TRUE
  /\ Wrote
  /\ UNCHANGED <<phase, kind, wrap, gen, reclaims, bareMint>>

Revoke ==
  /\ ~Terminal
  /\ sess' = "revoked"
  /\ live' = 0
  /\ closedBy' = "owner"
  /\ Wrote
  /\ UNCHANGED <<phase, kind, wrap, gen, reclaims, bareMint, prevClosed>>

\* A leaked handle. It does not mint, and it does not write. Unwrapped is the next open, which presents the key.
Bare ==
  /\ ~Terminal
  /\ Read("bare")
  /\ UNCHANGED session

\* Another tag. The session does not change.
Foreign ==
  /\ ~Terminal
  /\ Read("idle")
  /\ UNCHANGED session

Collision ==
  /\ kind = "bot"
  /\ sess \in {"live", "renewal_offered"}
  /\ phase \in {"fresh", "window"}
  /\ Read("idle")
  /\ UNCHANGED session

Rest ==
  /\ Terminal
  /\ Read("idle")
  /\ UNCHANGED session

\* A status read. The session record is unchanged, and `store` does not move.
Status ==
  /\ Read("status")
  /\ UNCHANGED session

Next ==
  \/ Commit
  \/ Lose
  \/ Offer
  \/ Advance
  \/ Renew
  \/ Reclaim
  \/ Unwrap
  \/ OwnerClose
  \/ Sweep
  \/ Revoke
  \/ Bare
  \/ Foreign
  \/ Collision
  \/ Status
  \/ Rest

Spec == Init /\ [][Next]_vars /\ WF_vars(Advance) /\ WF_vars(Sweep) /\ WF_vars(Commit) /\ WF_vars(Lose)

\* One live session, including across renewal.
AtMostOneLive == live <= 1

\* A healthy slot is the one live session.
HealthyOccupies ==
  (sess \in {"live", "renewal_offered"} /\ phase \in {"fresh", "window"}) => live = 1

\* A handle alone never mints.
NoBareMint == bareMint = FALSE

\* A status read and a leaked handle leave the store counter where it was.
ReadLeavesStore ==
  act \in {"status", "bare"} => store = prevStore

\* Another credential does not become the closer.
NoForeignClose == closedBy /= "foreign"

\* A close records who closed it. The sweep, the owner, or the same key.
ClosedHasCloser ==
  sess \in {"closed", "auto_closed"} => closedBy \in {"same", "owner", "sweep"}

RevokedByOwner == sess = "revoked" => closedBy = "owner"

\* An unwrapped chat is not a live session.
UnwrappedIdle == sess = "unwrapped" => live = 0

\* Every session reaches a closed state. Renewal is optional. The sweep is not.
EventuallyClosed == <> (sess \in Closed)

====
