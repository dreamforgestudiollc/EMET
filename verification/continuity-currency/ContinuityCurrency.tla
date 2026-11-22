---- MODULE ContinuityCurrency ----
\* Continuity-currency (tip-lag) gate.
\* Warn, current, documented no-op, no handoff, unreadable, or fallback-only.
\* The gate does not rewrite HANDOFF or STATE and does not block.
\* This is not wiki page currency. Episodic ids are not states in this model.
\* `newer` and `claim` are the classes the comparison can see.
\* `fallback` is a logged tip. It warns and it is not block-eligible.

EXTENDS Integers

VARIABLES phase, flag, newer, claim, handoffMutated, blocked, warning, blockEligible
vars == <<phase, flag, newer, claim, handoffMutated, blocked, warning, blockEligible>>

Phase == {
  "GateOff", "Comparing", "Current", "DocumentedNoOp", "Warning", "BlockHeld",
  "NoHandoff", "Unreadable", "FallbackOnly", "FallbackHeld"
}
Flag == {"off", "warn"}
Newer == {"none", "scratch", "material", "fallback"}
Claim == {"at_tip", "behind", "version_only"}

TypeOK ==
  /\ phase \in Phase
  /\ flag \in Flag
  /\ newer \in Newer
  /\ claim \in Claim
  /\ handoffMutated \in BOOLEAN
  /\ blocked \in BOOLEAN
  /\ warning \in BOOLEAN
  /\ blockEligible \in BOOLEAN

Init ==
  /\ phase = "GateOff"
  /\ flag = "off"
  /\ newer = "none"
  /\ claim = "at_tip"
  /\ handoffMutated = FALSE
  /\ blocked = FALSE
  /\ warning = FALSE
  /\ blockEligible = FALSE

\* The warn flag stays off. No warning is shown.
FlagStaysOff ==
  /\ phase = "GateOff"
  /\ flag = "off"
  /\ phase' = "GateOff"
  /\ warning' = FALSE
  /\ UNCHANGED <<flag, newer, claim, handoffMutated, blocked, blockEligible>>

\* The warn flag is turned on. The next initialize compares.
EnableWarn ==
  /\ phase = "GateOff"
  /\ flag = "off"
  /\ flag' = "warn"
  /\ phase' = "Comparing"
  /\ warning' = FALSE
  /\ blockEligible' = FALSE
  /\ UNCHANGED <<newer, claim, handoffMutated, blocked>>

\* The handoff cites the live material tip.
SeeCurrent ==
  /\ phase = "Comparing"
  /\ flag = "warn"
  /\ claim' = "at_tip"
  /\ newer' = "none"
  /\ phase' = "Current"
  /\ warning' = FALSE
  /\ blockEligible' = FALSE
  /\ UNCHANGED <<flag, handoffMutated, blocked>>

\* A documented no-op has no newer material tip.
SeeNoOp ==
  /\ phase = "Comparing"
  /\ flag = "warn"
  /\ claim' = "at_tip"
  /\ newer' = "none"
  /\ phase' = "DocumentedNoOp"
  /\ warning' = FALSE
  /\ blockEligible' = FALSE
  /\ UNCHANGED <<flag, handoffMutated, blocked>>

\* A newer episodic is scratch or diagnosis only. The material tip did not move.
SeeScratch ==
  /\ phase = "Comparing"
  /\ flag = "warn"
  /\ claim' = "at_tip"
  /\ newer' = "scratch"
  /\ phase' = "Current"
  /\ warning' = FALSE
  /\ blockEligible' = FALSE
  /\ UNCHANGED <<flag, handoffMutated, blocked>>

\* A version number alone cannot see a material tip that the handoff does not cite.
SeeVersionOnly ==
  /\ phase = "Comparing"
  /\ flag = "warn"
  /\ claim' = "version_only"
  /\ newer' = "material"
  /\ phase' = "Current"
  /\ warning' = FALSE
  /\ blockEligible' = FALSE
  /\ UNCHANGED <<flag, handoffMutated, blocked>>

\* The material tip is newer than the handoff claim.
SeeLag ==
  /\ phase = "Comparing"
  /\ flag = "warn"
  /\ claim' = "behind"
  /\ newer' = "material"
  /\ phase' = "Warning"
  /\ warning' = TRUE
  /\ blockEligible' = TRUE
  /\ handoffMutated' = FALSE
  /\ blocked' = FALSE
  /\ UNCHANGED <<flag>>

\* Only a fallback tip is newer. The warning is logged. It is not block-eligible.
SeeFallback ==
  /\ phase = "Comparing"
  /\ flag = "warn"
  /\ claim' = "behind"
  /\ newer' = "fallback"
  /\ phase' = "FallbackOnly"
  /\ warning' = TRUE
  /\ blockEligible' = FALSE
  /\ handoffMutated' = FALSE
  /\ blocked' = FALSE
  /\ UNCHANGED <<flag>>

\* The store has no handoff to compare. That is not a warning.
SeeNoHandoff ==
  /\ phase = "Comparing"
  /\ flag = "warn"
  /\ claim' = "at_tip"
  /\ newer' = "none"
  /\ phase' = "NoHandoff"
  /\ warning' = FALSE
  /\ blockEligible' = FALSE
  /\ handoffMutated' = FALSE
  /\ blocked' = FALSE
  /\ UNCHANGED <<flag>>

\* The comparison could not be read. That is not a warning.
SeeUnreadable ==
  /\ phase = "Comparing"
  /\ flag = "warn"
  /\ claim' = "at_tip"
  /\ newer' = "none"
  /\ phase' = "Unreadable"
  /\ warning' = FALSE
  /\ blockEligible' = FALSE
  /\ handoffMutated' = FALSE
  /\ blocked' = FALSE
  /\ UNCHANGED <<flag>>

\* Phase 2 was asked for. Only a block-eligible lag moves to BlockHeld.
\* `blockEligible` is the guard: FallbackOnly is in the phase set and is refused.
AskBlock ==
  /\ phase \in {"Warning", "FallbackOnly"}
  /\ blockEligible = TRUE
  /\ phase' = "BlockHeld"
  /\ warning' = TRUE
  /\ blocked' = FALSE
  /\ handoffMutated' = FALSE
  /\ UNCHANGED <<flag, newer, claim, blockEligible>>

\* Phase 2 was asked for on a lag that is not block-eligible.
AskBlockOnFallback ==
  /\ phase \in {"Warning", "FallbackOnly"}
  /\ blockEligible = FALSE
  /\ phase' = "FallbackHeld"
  /\ warning' = TRUE
  /\ blocked' = FALSE
  /\ handoffMutated' = FALSE
  /\ UNCHANGED <<flag, newer, claim, blockEligible>>

\* The next initialize compares again. Documents stay as they were.
CompareAgain ==
  /\ phase \in {"Current", "DocumentedNoOp", "Warning", "BlockHeld", "NoHandoff", "Unreadable", "FallbackOnly", "FallbackHeld"}
  /\ flag = "warn"
  /\ phase' = "Comparing"
  /\ warning' = FALSE
  /\ blockEligible' = FALSE
  /\ UNCHANGED <<flag, newer, claim, handoffMutated, blocked>>

Next ==
  \/ FlagStaysOff
  \/ EnableWarn
  \/ SeeCurrent
  \/ SeeNoOp
  \/ SeeScratch
  \/ SeeVersionOnly
  \/ SeeLag
  \/ SeeFallback
  \/ SeeNoHandoff
  \/ SeeUnreadable
  \/ AskBlock
  \/ AskBlockOnFallback
  \/ CompareAgain

Spec == Init /\ [][Next]_vars

\* No action rewrites a continuity record.
NeverRewrites == handoffMutated = FALSE

\* Phase 1 does not block, including after a block is asked for.
NeverBlocks == blocked = FALSE

\* A warning is a material lag, or a fallback-only lag. Scratch, a no-op, and a version number are not.
WarnOnlyOnMaterialLag ==
  warning = TRUE =>
    /\ blocked = FALSE
    /\ handoffMutated = FALSE
    /\ \/ (phase \in {"Warning", "BlockHeld"} /\ newer = "material" /\ claim = "behind" /\ blockEligible = TRUE)
       \/ (phase \in {"FallbackOnly", "FallbackHeld"} /\ newer = "fallback" /\ claim = "behind" /\ blockEligible = FALSE)

\* The flag-off surface shows nothing.
FlagOffShowsNothing == flag = "off" => phase = "GateOff" /\ warning = FALSE

\* A documented no-op is not a warning.
NoOpIsNotAWarning == phase = "DocumentedNoOp" => warning = FALSE

\* No handoff is not a warning, and nothing is written.
NoHandoffIsQuiet == phase = "NoHandoff" => warning = FALSE /\ blocked = FALSE /\ handoffMutated = FALSE

\* An unreadable comparison is not a warning, and nothing is written.
UnreadableIsQuiet == phase = "Unreadable" => warning = FALSE /\ blocked = FALSE /\ handoffMutated = FALSE

\* Fallback-only warns and is not block-eligible.
FallbackOnlyIsNotBlockEligible ==
  newer = "fallback" => blocked = FALSE /\ blockEligible = FALSE

\* Scratch or diagnosis-only does not warn.
ScratchIsNotAWarning == newer = "scratch" => warning = FALSE

\* Version alone cannot see the lag class.
VersionAloneDoesNotWarn == claim = "version_only" => warning = FALSE

====
