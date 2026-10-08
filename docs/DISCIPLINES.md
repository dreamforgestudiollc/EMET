# Operating disciplines — the reasoning behind the nine lines

`emet_initialize` serves `operating_discipline`: nine one-line rules (`DISCIPLINE_SUMMARY` in `src/disciplines.js`). This document is the long form — why each rule exists. It was carried inside the code until 2026-09-27, when the code audit found the same rules stated twice in one file with only the short form ever served (finding 3.13). The reasoning is for people; the lines are for the model.

Each rule exists because its absence caused a real, traced loss of information in production use.

These disciplines are **guardrails**: they bound the field in which the model uses its judgment. The steps that must never depend on judgment (open, append every exchange, board before handoff, close in order) run on **the monorail**, the server-checked session graph. See [Guardrails & Monorails](GUARDRAILS-AND-MONORAILS.md).

**Recall before assuming.** Before answering anything that may have prior context — a decision, a preference, a configuration, a name — search memory first. Answering from what seems likely, when the store would have told you, is the most common way a memory system silently stops mattering.

**Verify every write.** A save is not done because the call returned. Read it back. A claimed save that was never verified is worse than no save, because it stops anyone from looking again. This applies to reads too: before acting on a recorded path, id, or fact, confirm it still exists.

**The two tiers stay independent.** Layer entries hold curated meaning. Transcripts hold the word-for-word exchange. They are deliberately separate: when a layer entry is relevant but thin, the transcript around its timestamp holds the depth that was compressed out. Summarising at transcript-write time collapses the two into one and destroys the second layer of inquiry. Store transcripts verbatim. If a payload will not transmit, split it across parts — never compress it.

**Supersede, never mutate.** Correcting the record means writing a new entry that supersedes the old one, not editing or deleting it. The superseded entry stays reachable. It is marked with the date it ended and what replaced it. The current entry is listed first in every order, including a request for the latest and a timestamp sort. It does not fade and it is not hidden. A revision must stand alone and carry the dated specifics it is based on — an abstracted principle is weaker than the sentence someone actually said. Events are immutable: never revise an episodic entry.

**Consolidate late.** Wait for roughly three instances of a stable pattern before merging observations into one standing entry. Merging early buries the differences that turn out to matter.

**Provenance is part of the memory.** Every write records which host produced it. Set a distinct source tag per host. A shared default tag is not attribution — it is ambiguity that becomes invisible the moment a second host connects, and it makes forks impossible to see.

**Findings, not explanations.** When something in the record is unaccounted for, write down what was observed and stop. Do not attach a cause you did not verify. A plausible invented explanation is harder to dislodge later than an open question, and the most dangerous inventions are the reassuring ones.

**Mark inference as inference.** State what is known, what is inferred, and what is unknown, as three different things. If a value has not been observed, record it as unknown rather than supplying a likely one.

**Write at the moment.** Save when it happens, not at the end. A problem solved, a decision made with its reasoning, a stated preference, a correction — each is worth an entry while the specifics are still exact. Long working sessions deserve progress entries, because context can be lost without warning.

**Name the layer.** Every write names its layer. An entry saved without one is not routed by content — both routers were measured against the record and neither is fit to place material in a durable layer by guess — it lands in the working layer, flagged. It does not age out and it is not hidden. The layer charter says what belongs where; choosing is the writer's job, not the door's.

**Hand off before the gap.** Losing context mid-task is a failure. Before any interruption, restart, or handoff, write down what was in progress, why it stopped, and the exact next step. The handoff is the thread that survives the gap.
