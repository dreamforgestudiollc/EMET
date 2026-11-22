# PerTagHandoff

TLC reached more states than the chart budget of 500, so the chart draws only the bug paths: 3 states and 4 arrows.

## StampVersionsOnly breaks
The shortest path has 4 steps:
0. No handoffs yet
1. an AI starts, reads the merged view, and stamps it: In session, merged view read
2. a write AI writes its own handoff last: Handoffs at rest
3. an AI starts, reads the merged view, and stamps it: In session, merged view read
4. time passes (24 hours open, 7 days aging): In session, merged view read

## Rules not checked
TypeOK, OwnHandoffOnly, RowPatchedOnlyByOpener, NoLostBoardUpdate, ReadOnlyWritesNothing, IdsCarryPerson, OpenWorkOnlyInProgress, StaleMarkOnlyWhileOpen, NoDeadlock
After the first break, each TLC run stops at 100,000 distinct states. A run reached that bound before it checked these rules in every state.
