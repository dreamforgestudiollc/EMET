---- MODULE PerTagConflict ----
\* Conflict half of the reference model. No clock. One board step. No reader.
\* The hub changes a foreign row only while a conflict is marked.
EXTENDS Naturals
Writers == {"hub", "writer"}
MaxV == 1
MaxB == 1

VARIABLES phase, hv, author, board, seen, patches, refused, opener, patchedBy, resolvedBy, conflict
vars == <<phase, hv, author, board, seen, patches, refused, opener, patchedBy, resolvedBy, conflict>>

Init ==
  /\ phase = [w \in Writers |-> "out"]
  /\ hv = [w \in Writers |-> 0]
  /\ author = [w \in Writers |-> "none"]
  /\ board = 0 /\ patches = 0
  /\ seen = [w \in Writers |-> 0]
  /\ refused = FALSE
  /\ opener = "none" /\ patchedBy = {} /\ resolvedBy = {} /\ conflict = FALSE

Start(t) ==
  /\ phase[t] = "out"
  /\ phase' = [phase EXCEPT ![t] = "in"]
  /\ seen' = [seen EXCEPT ![t] = board]
  /\ refused' = FALSE
  /\ UNCHANGED <<hv, author, board, patches, opener, patchedBy, resolvedBy, conflict>>

BoardWrite(t) ==
  /\ seen[t] = board /\ board < MaxB
  /\ board' = board + 1 /\ patches' = patches + 1
  /\ seen' = [seen EXCEPT ![t] = board + 1]
  /\ refused' = FALSE

OpenRow(t) ==
  /\ phase[t] = "in" /\ opener = "none"
  /\ BoardWrite(t)
  /\ opener' = t
  /\ UNCHANGED <<phase, hv, author, patchedBy, resolvedBy, conflict>>

PatchOwnRow(t) ==
  /\ phase[t] = "in" /\ opener = t
  /\ BoardWrite(t)
  /\ patchedBy' = patchedBy \cup {t}
  /\ UNCHANGED <<phase, hv, author, opener, resolvedBy, conflict>>

ForeignRowPatch(t) ==
  /\ phase[t] = "in" /\ opener \notin {t, "none"}
  /\ ~(t = "hub" /\ conflict)
  /\ refused' = TRUE
  /\ UNCHANGED <<phase, hv, author, board, seen, patches, opener, patchedBy, resolvedBy, conflict>>

ResolveConflict ==
  /\ phase["hub"] = "in" /\ conflict /\ opener = "writer"
  /\ BoardWrite("hub")
  /\ resolvedBy' = resolvedBy \cup {"hub"}
  /\ conflict' = FALSE
  /\ UNCHANGED <<phase, hv, author, opener, patchedBy>>

StalePatch(t) ==
  /\ phase[t] = "in" /\ seen[t] # board
  /\ seen' = [seen EXCEPT ![t] = board]
  /\ refused' = TRUE
  /\ UNCHANGED <<phase, hv, author, board, patches, opener, patchedBy, resolvedBy, conflict>>

WrapOwn(t, disagree) ==
  /\ phase[t] = "in" /\ hv[t] < MaxV
  /\ hv' = [hv EXCEPT ![t] = hv[t] + 1]
  /\ author' = [author EXCEPT ![t] = t]
  /\ phase' = [phase EXCEPT ![t] = "out"]
  /\ conflict' = (conflict \/ (disagree /\ opener \notin {t, "none"}))
  /\ refused' = FALSE
  /\ UNCHANGED <<board, seen, patches, opener, patchedBy, resolvedBy>>

ForeignWrite(t, u) ==
  /\ phase[t] = "in" /\ u # t
  /\ refused' = TRUE
  /\ UNCHANGED <<phase, hv, author, board, seen, patches, opener, patchedBy, resolvedBy, conflict>>

Done == /\ \A w \in Writers : hv[w] = MaxV
        /\ UNCHANGED vars

Next ==
  \/ \E t \in Writers : Start(t)
  \/ \E t \in Writers : OpenRow(t) \/ PatchOwnRow(t) \/ StalePatch(t)
  \/ \E t \in Writers : ForeignRowPatch(t)
  \/ ResolveConflict
  \/ \E t \in Writers, d \in BOOLEAN : WrapOwn(t, d)
  \/ \E t \in Writers, u \in Writers : ForeignWrite(t, u)
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in [Writers -> {"out", "in"}]
  /\ hv \in [Writers -> 0..MaxV]
  /\ board \in 0..MaxB
  /\ opener \in Writers \cup {"none"}

OwnHandoffOnly == \A w \in Writers : author[w] \in {w, "none"}
RowPatchedOnlyByOpener == patchedBy \subseteq {opener} /\ resolvedBy \subseteq {"hub"}
NoLostBoardUpdate == board = patches
ReadOnlyWritesNothing == TRUE

====
