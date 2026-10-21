# The record and the floor

`emet_gaps` counts holes in the record and names the ids behind the counts. It does not fill them. `emet_floor` reads the standing description of how the assistant engages. The floor ships in the server, so setup cannot overwrite it.

## Sub-features

- record-gaps: `emet_gaps` covers unsourced assertions, attribution, digest mismatches, broken supersession, and the other classes the tool lists. Counts are complete. The id lists are capped.
- record-floor: `emet_floor` returns the core floor. `compact: true` is the short form. `section` returns one section. `gem` reads one installed GEM's floor and does not turn that GEM on.

## How to get to it (user POV)

Call `emet_gaps` when you want to know how trustworthy the record is, before a consolidation pass, or after a migration. Closing a gap is a person's decision. Call `emet_floor` when you need the floor again without running startup. `emet_initialize` already returns the whole floor on a ready store.

## Driving it with verify-emet

```
npm run verify -- feature record
npm run verify -- run emet_gaps emet_floor
```

`emet_floor` does not need the test database. `emet_gaps` does. A floor-only run is the fast check that the command can start.

## Gotchas

- A gap count is not a repair. The tool identifies. It does not write.
- Reading a GEM floor does not seat that GEM.
- Re-reading the floor is not the same as being bound by it.
