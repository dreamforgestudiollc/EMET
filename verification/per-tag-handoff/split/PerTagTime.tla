---- MODULE PerTagTime ----
\* Time half of the reference model. No board. One writer and the reader.
\* Open work is in progress, then stale-open. A stamp of versions alone misses aging.
EXTENDS Naturals
Writers == {"hub"}
Readers == {"guest"}
Tags == Writers \cup Readers
MaxV == 1

DocId(w) == w
Cred(t) == t

VARIABLES phase, hv, author, refused, hage, openAge, epiOpen, ptr, stampV, stampA, viewClass
vars == <<phase, hv, author, refused, hage, openAge, epiOpen, ptr, stampV, stampA, viewClass>>

LineClass(a) == IF a = 1 THEN "aging" ELSE "current"
ViewOf(v, a) == IF v = 0 THEN "none" ELSE LineClass(a)

Init ==
  /\ phase = [t \in Tags |-> "out"]
  /\ hv = 0 /\ author = "none"
  /\ refused = FALSE
  /\ hage = 0
  /\ openAge = [t \in Tags |-> 0]
  /\ epiOpen = [t \in Tags |-> FALSE]
  /\ ptr = 0
  /\ stampV = [t \in Tags |-> 0]
  /\ stampA = [t \in Tags |-> 0]
  /\ viewClass = [t \in Tags |-> "none"]

Start(t) ==
  /\ phase[t] = "out"
  /\ phase' = [phase EXCEPT ![t] = "in"]
  /\ openAge' = [openAge EXCEPT ![t] = 0]
  /\ stampV' = [stampV EXCEPT ![t] = hv]
  /\ stampA' = [stampA EXCEPT ![t] = hage]
  /\ viewClass' = [viewClass EXCEPT ![t] = ViewOf(hv, hage)]
  /\ refused' = FALSE
  /\ UNCHANGED <<hv, author, hage, epiOpen, ptr>>

SaveMaterial ==
  /\ phase["hub"] = "in" /\ ~epiOpen["hub"]
  /\ epiOpen' = [epiOpen EXCEPT !["hub"] = TRUE]
  /\ refused' = FALSE
  /\ UNCHANGED <<phase, hv, author, hage, openAge, ptr, stampV, stampA, viewClass>>

Tick ==
  /\ \/ \E t \in Tags : phase[t] = "in" /\ openAge[t] = 0
     \/ hv > 0 /\ hage = 0
  /\ openAge' = [t \in Tags |-> IF phase[t] = "in" THEN 1 ELSE openAge[t]]
  /\ hage' = IF hv > 0 THEN 1 ELSE hage
  /\ refused' = FALSE
  /\ UNCHANGED <<phase, hv, author, epiOpen, ptr, stampV, stampA, viewClass>>

WrapOwn ==
  /\ phase["hub"] = "in" /\ hv < MaxV
  /\ Cred("hub") = DocId("hub")
  /\ hv' = hv + 1
  /\ author' = "hub"
  /\ hage' = 0
  /\ phase' = [phase EXCEPT !["hub"] = "out"]
  /\ ptr' = IF epiOpen["hub"] THEN ptr + 1 ELSE ptr
  /\ epiOpen' = [epiOpen EXCEPT !["hub"] = FALSE]
  /\ openAge' = [openAge EXCEPT !["hub"] = 0]
  /\ refused' = FALSE
  /\ UNCHANGED <<stampV, stampA, viewClass>>

LeaveReadOnly ==
  /\ phase["guest"] = "in"
  /\ phase' = [phase EXCEPT !["guest"] = "out"]
  /\ openAge' = [openAge EXCEPT !["guest"] = 0]
  /\ refused' = FALSE
  /\ UNCHANGED <<hv, author, hage, epiOpen, ptr, stampV, stampA, viewClass>>

Done == hv = MaxV /\ UNCHANGED vars

Next ==
  \/ \E t \in Tags : Start(t)
  \/ SaveMaterial
  \/ Tick
  \/ WrapOwn
  \/ LeaveReadOnly
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in [Tags -> {"out", "in"}]
  /\ hv \in 0..MaxV
  /\ hage \in 0..1
  /\ openAge \in [Tags -> 0..1]

OwnHandoffOnly == author \in {"hub", "none"}
ReadOnlyWritesNothing == author # "guest"
OpenWorkOnlyInProgress == epiOpen["hub"] => phase["hub"] = "in"
StaleMarkOnlyWhileOpen == \A t \in Tags : openAge[t] = 1 => phase[t] = "in"
StampReproducible == \A t \in Tags : phase[t] = "in" => viewClass[t] = ViewOf(stampV[t], stampA[t])
IdsCarryPerson == TRUE

====
