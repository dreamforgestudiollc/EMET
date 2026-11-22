---- MODULE PerTagHandoff ----
EXTENDS Naturals
\* Design sketch: per-tag handoffs, a merged view computed on read,
\* one shared board under optimistic versioning. Two write tags, one read-only tag.
Writers == {"hub", "writer"}
Readers == {"guest"}
Tags == Writers \cup Readers
MaxV == 1
MaxB == 1

VARIABLES phase, hv, author, board, seen, patches, refused
vars == <<phase, hv, author, board, seen, patches, refused>>

None == [w \in Writers |-> 0]

Init ==
  /\ phase = [t \in Tags |-> "out"]
  /\ hv = [w \in Writers |-> 0]
  /\ author = [w \in Writers |-> "none"]
  /\ board = 0
  /\ seen = [t \in Tags |-> 0]
  /\ patches = 0
  /\ refused = FALSE

\* Any tag starts: reads the merged view (every write tag's latest handoff) and the board.
Start(t) ==
  /\ phase[t] = "out"
  /\ phase' = [phase EXCEPT ![t] = "in"]
  /\ seen' = IF t \in Writers THEN [seen EXCEPT ![t] = board] ELSE seen
  /\ refused' = FALSE
  /\ UNCHANGED <<hv, author, board, patches>>

\* A write tag patches the board it last read.
PatchBoard(t) ==
  /\ t \in Writers /\ phase[t] = "in" /\ seen[t] = board /\ board < MaxB
  /\ board' = board + 1 /\ patches' = patches + 1
  /\ seen' = [seen EXCEPT ![t] = board + 1]
  /\ refused' = FALSE
  /\ UNCHANGED <<phase, hv, author>>

\* A patch on a board that moved since this tag read it is refused; the tag re-reads.
StalePatch(t) ==
  /\ t \in Writers /\ phase[t] = "in" /\ seen[t] # board
  /\ seen' = [seen EXCEPT ![t] = board]
  /\ refused' = TRUE
  /\ UNCHANGED <<phase, hv, author, board, patches>>

\* Wrap-up: a write tag supersedes only its own handoff, last.
WrapOwn(t) ==
  /\ t \in Writers /\ phase[t] = "in" /\ hv[t] < MaxV
  /\ hv' = [hv EXCEPT ![t] = hv[t] + 1]
  /\ author' = [author EXCEPT ![t] = t]
  /\ phase' = [phase EXCEPT ![t] = "out"]
  /\ refused' = FALSE
  /\ UNCHANGED <<board, seen, patches>>

\* A tag tries to write another tag's handoff: the credential check refuses it.
ForeignWrite(t, u) ==
  /\ phase[t] = "in" /\ u \in Writers /\ u # t
  /\ refused' = TRUE
  /\ UNCHANGED <<phase, hv, author, board, seen, patches>>

\* A read-only tag leaves without writing anything.
LeaveReadOnly(t) ==
  /\ t \in Readers /\ phase[t] = "in"
  /\ phase' = [phase EXCEPT ![t] = "out"]
  /\ refused' = FALSE
  /\ UNCHANGED <<hv, author, board, seen, patches>>

Done == \A w \in Writers : hv[w] = MaxV /\ UNCHANGED vars

Next ==
  \/ \E t \in Tags : Start(t)
  \/ \E t \in Writers : PatchBoard(t)
  \/ \E t \in Writers : StalePatch(t)
  \/ \E t \in Writers : WrapOwn(t)
  \/ \E t \in Tags, u \in Writers : ForeignWrite(t, u)
  \/ \E t \in Readers : LeaveReadOnly(t)
  \/ Done

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in [Tags -> {"out", "in"}]
  /\ hv \in [Writers -> 0..MaxV]
  /\ board \in 0..MaxB

\* Each handoff is written only by its own tag.
OwnHandoffOnly == \A w \in Writers : author[w] \in {w, "none"}
\* No board patch is lost: every applied patch is one board version.
NoLostBoardUpdate == board = patches
\* A read-only tag never authors a handoff.
ReadOnlyWritesNothing == \A w \in Writers : author[w] \notin Readers
====
