---- MODULE CondenseApproval ----
\* Owner-approved condense of one document (EMET-DOC-025).
\* The default write that shrinks a document below half is refused.
\* A bot tag, including the hub tag, is refused on the
\* owner password. That password is not an approval.
\* A writer approval condenses only the document it names.
\* The owner approves that named grant on the owner chooser. No access code is minted.
\* The grant does not list the client as a standing door. CLIENT_APPROVALS stays as it was.
\* A missing reason, a grant for another document, or an approval that is
\* not granted yet writes nothing.
\* The prior revision stays.

EXTENDS Integers

VARIABLES actor, flag, reason, approval, phase, written, history, password
vars == <<actor, flag, reason, approval, phase, written, history, password>>

Actor == {"owner", "bot", "member"}
Flag == {"off", "on"}
Reason == {"empty", "set"}
\* this: granted for the document being written.
\* other: granted, but for a different document.
Approval == {"none", "pending", "this", "other", "invalid"}
Phase == {"start", "refused", "pending_approval", "approved_written"}

TypeOK ==
  /\ actor \in Actor \cup {"start"}
  /\ flag \in Flag
  /\ reason \in Reason
  /\ approval \in Approval
  /\ phase \in Phase
  /\ written \in BOOLEAN
  /\ history \in BOOLEAN
  /\ password \in BOOLEAN

Init ==
  /\ actor = "start"
  /\ flag = "off"
  /\ reason = "empty"
  /\ approval = "none"
  /\ phase = "start"
  /\ written = FALSE
  /\ history = TRUE
  /\ password = FALSE

RefusePlain ==
  /\ phase = "start"
  /\ \E a \in Actor, r \in Reason, ap \in Approval, pw \in BOOLEAN:
       /\ actor' = a
       /\ flag' = "off"
       /\ reason' = r
       /\ approval' = ap
       /\ password' = pw
       /\ history' = TRUE
       /\ phase' = "refused"
       /\ written' = FALSE

RefuseBot ==
  /\ phase = "start"
  /\ \E r \in Reason, ap \in {"none", "pending", "invalid"}, pw \in BOOLEAN:
       /\ actor' = "bot"
       /\ flag' = "on"
       /\ reason' = r
       /\ approval' = ap
       /\ password' = pw
       /\ history' = TRUE
       /\ phase' = "refused"
       /\ written' = FALSE

WrongDocument ==
  /\ phase = "start"
  /\ \E a \in Actor, r \in Reason, pw \in BOOLEAN:
       /\ actor' = a
       /\ flag' = "on"
       /\ reason' = r
       /\ approval' = "other"
       /\ password' = pw
       /\ history' = TRUE
       /\ phase' = "pending_approval"
       /\ written' = FALSE

MissingReason ==
  /\ phase = "start"
  /\ \E a \in {"owner", "member"}, ap \in {"none", "pending", "this", "invalid"}, pw \in BOOLEAN:
       /\ (a = "owner" \/ ap = "this")
       /\ actor' = a
       /\ flag' = "on"
       /\ reason' = "empty"
       /\ approval' = ap
       /\ password' = pw
       /\ history' = TRUE
       /\ phase' = "pending_approval"
       /\ written' = FALSE

MissingReasonBot ==
  /\ phase = "start"
  /\ \E pw \in BOOLEAN:
       /\ actor' = "bot"
       /\ flag' = "on"
       /\ reason' = "empty"
       /\ approval' = "this"
       /\ password' = pw
       /\ history' = TRUE
       /\ phase' = "pending_approval"
       /\ written' = FALSE

WaitApproval ==
  /\ phase = "start"
  /\ \E a \in {"owner", "member"}, ap \in {"none", "pending", "invalid"}, pw \in BOOLEAN:
       /\ a = "member" \/ ap # "none"
       /\ actor' = a
       /\ flag' = "on"
       /\ reason' = "set"
       /\ approval' = ap
       /\ password' = pw
       /\ history' = TRUE
       /\ phase' = "pending_approval"
       /\ written' = FALSE

OwnerWrites ==
  /\ phase = "start"
  /\ \E ap \in {"none", "this"}, pw \in BOOLEAN:
       /\ actor' = "owner"
       /\ flag' = "on"
       /\ reason' = "set"
       /\ approval' = ap
       /\ password' = pw
       /\ history' = TRUE
       /\ phase' = "approved_written"
       /\ written' = TRUE

ApprovalWrites ==
  /\ phase = "start"
  /\ \E a \in {"bot", "member"}, pw \in BOOLEAN:
       /\ actor' = a
       /\ flag' = "on"
       /\ reason' = "set"
       /\ approval' = "this"
       /\ password' = pw
       /\ history' = TRUE
       /\ phase' = "approved_written"
       /\ written' = TRUE

Done ==
  /\ phase \in {"refused", "pending_approval", "approved_written"}
  /\ UNCHANGED vars

Next ==
  \/ RefusePlain
  \/ RefuseBot
  \/ WrongDocument
  \/ MissingReason
  \/ MissingReasonBot
  \/ WaitApproval
  \/ OwnerWrites
  \/ ApprovalWrites
  \/ Done

Spec == Init /\ [][Next]_vars

NoWriteWithoutFlag == written => flag = "on"
NoWriteWithoutReason == written => reason = "set"
HistoryKept == written => history
PriorStays == history
PendingWritesNothing == phase = "pending_approval" => ~written
RefusedWritesNothing == phase = "refused" => ~written
ApprovedIsWritten == phase = "approved_written" => written
StartUnwritten == phase = "start" => ~written
OwnerOrThisDoc == written => (actor = "owner" \/ approval = "this")
BotNeedsThisDoc == written /\ actor = "bot" => approval = "this"
BotPasswordIsNotEnough ==
  actor = "bot" /\ password /\ approval # "this" /\ phase # "start" => ~written
MemberNeedsThisDoc == written /\ actor = "member" => approval = "this"
OtherDocWritesNothing ==
  approval = "other" /\ flag = "on" /\ phase # "start" =>
    phase = "pending_approval" /\ ~written
NoWriteForOtherDoc == written => approval # "other"
FlagOffIsRefusal == flag = "off" /\ phase # "start" => phase = "refused" /\ ~written

====
