# Per-tag handoff statechart

`EMET_TAG_HANDOFFS` is off unless the value is `warn` or `enforce`. Off is the default. Both pictures are also on `/statechart`. The executable steps are `perTagHandoffStep` in `src/per-tag-handoff-statechart.js`.

The reference model is `verification/per-tag-handoff/PerTagHandoff.tla`, with `PerTagHandoff.cfg`, `view.mjs`, and `StampCounter.cfg`. TLC 2.19 found **958,557 distinct states** (8,532,898 generated), search depth 20, no error. `TypeOK`, `OwnHandoffOnly`, `RowPatchedOnlyByOpener`, `NoLostBoardUpdate`, `ReadOnlyWritesNothing`, `IdsCarryPerson`, `OpenWorkOnlyInProgress`, `StaleMarkOnlyWhileOpen`, and `StampReproducible` hold. The run is `verification/per-tag-handoff/tlc-output.txt`. That model is too big to draw: the chart budget is 500 states.

`StampCounter.cfg` checks `StampVersionsOnly` instead, a stamp of versions without the as-of age. It breaks in four steps: an AI starts, a write AI writes its own handoff, another start reads the view, then time passes and the line is aging. The path is `verification/per-tag-handoff/out-counter/`. The product stamp carries `as_of` so the same inputs rebuild that class.

The earlier draft, before the locked decisions, is `verification/per-tag-handoff/v1-draft/`. TLC on that draft found 187 distinct states. It does not have the opener rule, the person segment, or the as-of stamp.

The pictures below are drawn from a split of the reference, each inside the 500-state budget. The conflict module has no clock. The time module has no board. The full model checks both together, including a read-only tag trying to write another handoff. The time picture hides that refusal attempt. Both pictures hide a finish that stays in the same label.

Conflict: `verification/per-tag-handoff/split/PerTagConflict.tla`. TLC found 138 distinct states. The chart draws 7 states and 20 arrows.

```mermaid
stateDiagram-v2
  state "Legend" as legend {
    lg0: refused
    lg1: session
    lg2: rest
  }
  class lg0 pink
  class lg1 blue
  class lg2 teal
  s0: No handoffs yet
  s1: In session, merged view read
  s2: Write refused, nothing written
  s3: Handoffs at rest
  s4: In session, board moved since read
  s5: In session, row conflict waiting for the hub
  s6: At rest, row conflict waiting for the hub
  [*] --> s0
  s0 --> s1: an AI starts and reads the view
  s1 --> s2: an AI tries to write another AI's handoff or an AI tries to patch a row it did not open
  s1 --> s3: a write AI writes its own handoff last
  s1 --> s4: a write AI opens a board row
  s2 --> s1: an AI starts and reads the view or a write AI opens a board row or a write AI writes its own handoff last
  s2 --> s3: a write AI writes its own handoff last
  s3 --> s1: an AI starts and reads the view
  s2 --> s4: a write AI opens a board row or a write AI writes its own handoff last or an AI starts and reads the view
  s4 --> s2: an AI tries to patch a row it did not open or an AI tries to write another AI's handoff or a write on a moved board is refused
  s4 --> s1: a write AI writes its own handoff last
  s4 --> s5: a write AI writes its own handoff last
  s1 --> s5: a write AI writes its own handoff last
  s2 --> s5: a write AI writes its own handoff last or an AI starts and reads the view
  s4 --> s3: a write AI writes its own handoff last
  s4 --> s6: a write AI writes its own handoff last
  s1 --> s6: a write AI writes its own handoff last
  s5 --> s2: an AI tries to write another AI's handoff or an AI tries to patch a row it did not open
  s5 --> s6: a write AI writes its own handoff last
  s2 --> s6: a write AI writes its own handoff last
  s6 --> s5: an AI starts and reads the view
  class s0 teal
  class s1 blue
  class s2 pink
  class s3 teal
  class s4 blue
  class s5 blue
  class s6 teal
```

Time: `verification/per-tag-handoff/split/PerTagTime.tla`. TLC found 143 distinct states. The chart draws 7 states and 19 arrows.

```mermaid
stateDiagram-v2
  state "Legend" as legend {
    lg0: session
    lg1: rest
  }
  class lg0 blue
  class lg1 teal
  s0: No handoff yet
  s1: In session, merged view read
  s2: In session, work shown in progress
  s3: Handoff at rest
  s4: In session, open work marked stale
  s5: Handoff at rest, line aging
  s6: In session, reading an aging line
  [*] --> s0
  s0 --> s1: an AI starts, reads the view, and stamps it
  s1 --> s2: a write AI saves work in an open session
  s1 --> s3: a write AI writes its own handoff last or a read-only AI leaves, writing nothing
  s1 --> s0: a read-only AI leaves, writing nothing
  s1 --> s4: a write AI saves work in an open session
  s2 --> s4: time passes (24 hours open, 7 days aging)
  s2 --> s3: a write AI writes its own handoff last
  s3 --> s1: an AI starts, reads the view, and stamps it
  s3 --> s5: time passes (24 hours open, 7 days aging)
  s2 --> s1: a write AI writes its own handoff last
  s4 --> s3: a write AI writes its own handoff last
  s5 --> s6: an AI starts, reads the view, and stamps it
  s4 --> s1: a write AI writes its own handoff last
  s6 --> s2: a write AI saves work in an open session
  s1 --> s6: an AI starts, reads the view, and stamps it
  s6 --> s5: a read-only AI leaves, writing nothing
  s1 --> s5: a read-only AI leaves, writing nothing
  s6 --> s4: a write AI saves work in an open session
  s6 --> s1: a read-only AI leaves, writing nothing
  class s0 teal
  class s1 blue
  class s2 blue
  class s3 teal
  class s4 blue
  class s5 teal
  class s6 blue
```

The counter-check draws only the path that breaks `StampVersionsOnly`:

```mermaid
stateDiagram-v2
  state "Legend" as legend {
    lg0: session
    lg1: rest
    lg2: Breaks StampVersionsOnly in some cases
    lg3: Path to the StampVersionsOnly bug
  }
  class lg0 blue
  class lg1 teal
  class lg2 mayBreak
  class lg3 bugPath
  s0: No handoffs yet
  s1: In session, merged view read
  s2: Handoffs at rest
  [*] --> s0
  s0 --> s1: an AI starts, reads the merged view, and stamps it
  s1 --> s2: a write AI writes its own handoff last
  s2 --> s1: an AI starts, reads the merged view, and stamps it
  s1 --> s1: time passes (24 hours open, 7 days aging)
  classDef mayBreak fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06
  class s0 teal
  class s0 bugPath
  class s1 blue
  class s1 mayBreak
  class s1 bugPath
  class s2 teal
  class s2 bugPath
```

What the reader can check:

- A tag patches a board row it opened. The hub changes another tag's row only when that row is marked in conflict.
- A bot tag may patch its own rows. It still cannot write the hub handoff.
- Each write tag writes its own handoff. Another tag's handoff is refused.
- A read-only tag writes nothing.
- An open session with material work is an in-progress line. It is not a pointer and it is not a lag. After the long tick it is stale-open, and only while that session is still open. Nothing here blocks.
- A handoff line ages after the long tick. The stamp records the age it was read at, so the view can be rebuilt. A stamp of versions alone cannot.
