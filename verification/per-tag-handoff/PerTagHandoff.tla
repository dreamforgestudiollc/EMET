---- MODULE PerTagHandoff ----
EXTENDS Naturals
\* Build model for per-tag handoffs, with the locked decisions.
\* Two write tags (hub keeps HANDOFF.md; writer is a bot), one read-only tag.
\* Handoff ids carry a person segment (reserved now; one person until the multi-user phase).
\* One board row is enough to show the opener rule: one tag opens it, the other is foreign.
Writers == {"hub", "writer"}
Readers == {"guest"}
Tags == Writers \cup Readers
Person == "owner"
MaxV == 1
MaxB == 2

\* A write is allowed only when the credential's (person, tag) equals the document's.
DocId(w) == <<Person, w>>
Cred(t)  == <<Person, t>>

VARIABLES phase, hv, author, board, seen, patches, refused,
          opener, patchedBy, resolvedBy, conflict,
          hage, openAge, epiOpen, ptr, stamp, viewSeen
vars == <<phase, hv, author, board, seen, patches, refused,
          opener, patchedBy, resolvedBy, conflict,
          hage, openAge, epiOpen, ptr, stamp, viewSeen>>

\* The merged view, computed on read. Each line: (handoff version, currency class).
\* Age 1 means older than 7 days, shown "aging".
LineClass(a) == IF a = 1 THEN "aging" ELSE "current"
ViewAt(v, a) == [w \in Writers |-> IF v[w] = 0 THEN <<0, "none">> ELSE <<v[w], LineClass(a[w])>>]
EmptyView == ViewAt([w \in Writers |-> 0], [w \in Writers |-> 0])

Init ==
  /\ phase = [t \in Tags |-> "out"]
  /\ hv = [w \in Writers |-> 0]
  /\ author = [w \in Writers |-> "none"]
  /\ board = 0 /\ patches = 0
  /\ seen = [t \in Tags |-> 0]
  /\ refused = FALSE
  /\ opener = "none" /\ patchedBy = {} /\ resolvedBy = {} /\ conflict = FALSE
  /\ hage = [w \in Writers |-> 0]
  /\ openAge = [t \in Tags |-> 0]
  /\ epiOpen = [t \in Tags |-> FALSE]
  /\ ptr = [w \in Writers |-> 0]
  /\ stamp = [t \in Tags |-> [v |-> [w \in Writers |-> 0], a |-> [w \in Writers |-> 0]]]
  /\ viewSeen = [t \in Tags |-> EmptyView]

\* Any tag starts: reads the merged view and records a stamp (versions AND the as-of age).
Start(t) ==
  /\ phase[t] = "out"
  /\ phase' = [phase EXCEPT ![t] = "in"]
  /\ seen' = [seen EXCEPT ![t] = board]
  /\ stamp' = [stamp EXCEPT ![t] = [v |-> hv, a |-> hage]]
  /\ viewSeen' = [viewSeen EXCEPT ![t] = ViewAt(hv, hage)]
  /\ openAge' = [openAge EXCEPT ![t] = 0]
  /\ refused' = FALSE
  /\ UNCHANGED <<hv, author, board, patches, opener, patchedBy, resolvedBy, conflict, hage, epiOpen, ptr>>

BoardWrite(t) ==
  /\ seen[t] = board /\ board < MaxB
  /\ board' = board + 1 /\ patches' = patches + 1
  /\ seen' = [seen EXCEPT ![t] = board + 1]
  /\ refused' = FALSE

\* A write tag opens the row; it becomes the row's opener.
OpenRow(t) ==
  /\ t \in Writers /\ phase[t] = "in" /\ opener = "none"
  /\ BoardWrite(t)
  /\ opener' = t
  /\ UNCHANGED <<phase, hv, author, patchedBy, resolvedBy, conflict, hage, openAge, epiOpen, ptr, stamp, viewSeen>>

\* Only the opener may patch its row.
PatchOwnRow(t) ==
  /\ t \in Writers /\ phase[t] = "in" /\ opener = t
  /\ BoardWrite(t)
  /\ patchedBy' = patchedBy \cup {t}
  /\ UNCHANGED <<phase, hv, author, opener, resolvedBy, conflict, hage, openAge, epiOpen, ptr, stamp, viewSeen>>

\* Any other tag patching the row is refused (the hub too, unless it is resolving a marked conflict).
ForeignRowPatch(t) ==
  /\ phase[t] = "in" /\ opener \notin {t, "none"}
  /\ ~(t = "hub" /\ conflict)
  /\ refused' = TRUE
  /\ UNCHANGED <<phase, hv, author, board, seen, patches, opener, patchedBy, resolvedBy, conflict, hage, openAge, epiOpen, ptr, stamp, viewSeen>>

\* The hub resolves a marked conflict on a row it did not open; the mark clears.
ResolveConflict ==
  /\ phase["hub"] = "in" /\ conflict /\ opener \notin {"hub", "none"}
  /\ BoardWrite("hub")
  /\ resolvedBy' = resolvedBy \cup {"hub"}
  /\ conflict' = FALSE
  /\ UNCHANGED <<phase, hv, author, opener, patchedBy, hage, openAge, epiOpen, ptr, stamp, viewSeen>>

\* A board write on a version that moved since this tag read it is refused; the tag re-reads.
StalePatch(t) ==
  /\ t \in Writers /\ phase[t] = "in" /\ seen[t] # board
  /\ seen' = [seen EXCEPT ![t] = board]
  /\ refused' = TRUE
  /\ UNCHANGED <<phase, hv, author, board, patches, opener, patchedBy, resolvedBy, conflict, hage, openAge, epiOpen, ptr, stamp, viewSeen>>

\* A write tag saves material work in an open session (B-137 shows it as "in progress").
SaveMaterial(t) ==
  /\ t \in Writers /\ phase[t] = "in" /\ ~epiOpen[t]
  /\ epiOpen' = [epiOpen EXCEPT ![t] = TRUE]
  /\ refused' = FALSE
  /\ UNCHANGED <<phase, hv, author, board, seen, patches, opener, patchedBy, resolvedBy, conflict, hage, openAge, ptr, stamp, viewSeen>>

\* Time passes: open sessions pass 24 hours, written handoff lines pass 7 days.
Tick ==
  /\ \/ \E t \in Tags : phase[t] = "in" /\ openAge[t] = 0
     \/ \E w \in Writers : hv[w] > 0 /\ hage[w] = 0
  /\ openAge' = [t \in Tags |-> IF phase[t] = "in" THEN 1 ELSE openAge[t]]
  /\ hage' = [w \in Writers |-> IF hv[w] > 0 THEN 1 ELSE hage[w]]
  /\ refused' = FALSE
  /\ UNCHANGED <<phase, hv, author, board, seen, patches, opener, patchedBy, resolvedBy, conflict, epiOpen, ptr, stamp, viewSeen>>

\* Wrap-up: a write tag supersedes only its own handoff, last. Its line may disagree
\* with the opener's on the row, which marks a conflict for the hub. Only now does the
\* session's material work count as a B-137 pointer (closed sessions only).
WrapOwn(t, disagree) ==
  /\ t \in Writers /\ phase[t] = "in" /\ hv[t] < MaxV
  /\ Cred(t) = DocId(t)
  /\ hv' = [hv EXCEPT ![t] = hv[t] + 1]
  /\ author' = [author EXCEPT ![t] = t]
  /\ hage' = [hage EXCEPT ![t] = 0]
  /\ phase' = [phase EXCEPT ![t] = "out"]
  /\ ptr' = [ptr EXCEPT ![t] = IF epiOpen[t] THEN ptr[t] + 1 ELSE ptr[t]]
  /\ epiOpen' = [epiOpen EXCEPT ![t] = FALSE]
  /\ openAge' = [openAge EXCEPT ![t] = 0]
  /\ conflict' = (conflict \/ (disagree /\ opener \notin {t, "none"}))
  /\ refused' = FALSE
  /\ UNCHANGED <<board, seen, patches, opener, patchedBy, resolvedBy, stamp, viewSeen>>

\* Any tag (bot, non-bot, or read-only) writing another tag's handoff is refused,
\* including a non-hub tag writing HANDOFF.md: the non-bot write gap is closed.
ForeignWrite(t, u) ==
  /\ phase[t] = "in" /\ u \in Writers /\ u # t
  /\ Cred(t) # DocId(u)
  /\ refused' = TRUE
  /\ UNCHANGED <<phase, hv, author, board, seen, patches, opener, patchedBy, resolvedBy, conflict, hage, openAge, epiOpen, ptr, stamp, viewSeen>>

\* A read-only tag leaves without writing anything.
LeaveReadOnly(t) ==
  /\ t \in Readers /\ phase[t] = "in"
  /\ phase' = [phase EXCEPT ![t] = "out"]
  /\ openAge' = [openAge EXCEPT ![t] = 0]
  /\ refused' = FALSE
  /\ UNCHANGED <<hv, author, board, seen, patches, opener, patchedBy, resolvedBy, conflict, hage, epiOpen, ptr, stamp, viewSeen>>

Done == /\ \A w \in Writers : hv[w] = MaxV
        /\ UNCHANGED vars

Next ==
  \/ \E t \in Tags : Start(t)
  \/ \E t \in Writers : OpenRow(t) \/ PatchOwnRow(t) \/ StalePatch(t) \/ SaveMaterial(t)
  \/ \E t \in Tags : ForeignRowPatch(t)
  \/ ResolveConflict
  \/ Tick
  \/ \E t \in Writers, d \in BOOLEAN : WrapOwn(t, d)
  \/ \E t \in Tags, u \in Writers : ForeignWrite(t, u)
  \/ \E t \in Readers : LeaveReadOnly(t)
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in [Tags -> {"out", "in"}]
  /\ hv \in [Writers -> 0..MaxV]
  /\ board \in 0..MaxB
  /\ opener \in Writers \cup {"none"}
  /\ hage \in [Writers -> 0..1] /\ openAge \in [Tags -> 0..1]

\* Decision 4 and the closed gap: each handoff (HANDOFF.md for the hub) is written only by its own tag.
OwnHandoffOnly == \A w \in Writers : author[w] \in {w, "none"}
\* Decision 3: only the opener patches a row; the hub's only exception is resolving a marked conflict.
RowPatchedOnlyByOpener == patchedBy \subseteq {opener} /\ resolvedBy \subseteq {"hub"}
\* No board write is lost: every applied write is one board version.
NoLostBoardUpdate == board = patches
\* A read-only tag writes nothing anywhere.
ReadOnlyWritesNothing ==
  /\ \A w \in Writers : author[w] \notin Readers
  /\ opener \notin Readers /\ patchedBy \cap Readers = {}
\* Decision 8: every handoff id carries the person segment.
IdsCarryPerson == \A w \in Writers : DocId(w)[1] = Person
\* Decision 5: open-session work is never a pointer; it shows as in progress until close,
\* and a stale-open mark exists only on a session that is still open.
OpenWorkOnlyInProgress == \A t \in Tags : epiOpen[t] => phase[t] = "in"
StaleMarkOnlyWhileOpen == \A t \in Tags : openAge[t] = 1 => phase[t] = "in"
\* Decision 6: the view an AI read can be rebuilt from its stamp alone (versions plus as-of age).
StampReproducible == \A t \in Tags : phase[t] = "in" => viewSeen[t] = ViewAt(stamp[t].v, stamp[t].a)
\* Counter-check (expected to FAIL): a stamp of versions only is not enough, because aging moves.
StampVersionsOnly == \A t \in Tags : phase[t] = "in" => viewSeen[t] = ViewAt(stamp[t].v, hage)
====
