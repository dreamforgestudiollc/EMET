# GEP-0001: Core floor and the Neurendipity GEM

**Status:** Accepted
**Date:** 2026-10-11
**Approver:** The owner
**Sponsor:** none (a bot the owner designates may sponsor a later revision; a sponsor does not approve)
**Spec revision:** 2026-10-11

Accepted means the decisions below are the ones to build. It is not Final. Final waits on the floor move, the conformance checks, and a pilot measurement. The owner can revise any row in this file before it is Final.

## Summary

EMET is a memory server. The core floor stays the minimum that keeps that memory honest. Neurodivergent engagement moves into the reference GEM **Neurendipity** (`id` `neurendipity`). The GEM ships inside EMET and is off unless the user asks for it. The origin stands: EMET was designed first for neurodivergent users, and that support stays available as an opt-in.

The 2026-09-08 names are superseded. GEM means Golem Expertise Module. RUNED means Registered Utility Node Executable Directive. Socket means the GEM seat.

## Decisions

These are the owner's decisions of 2026-10-11. They replace the earlier recommendation that Neurendipity (then sketched as `nd-support`) would be on by default.

1. EMET's function is memory. The core floor is integrity, honesty, no sycophancy, truth over speculation, fact-checking, and persistence. Behavioral guidance lives in GEMs.
2. The reference GEM is Neurendipity, `neurendipity`. It receives `reading_people`, the neurodivergent floor lines, the wellbeing corpus lines, and the neurodivergent guide.
3. Neurendipity is bundled and **off** unless the user requests it. EMET without that request is a general memory server.
4. `emet_initialize` lists every installed GEM, active or not. The bot-facing startup text names the same list.
5. The security and trust model in [SPEC.md](../SPEC.md) is in force now. Bundled prompt GEMs are the only ones a release may load before the matching checks exist. Every other class of GEM already has the rules it must pass.
6. The owner is the sole approver of the standard, the schema, and the socket rules. The owner's bots may sponsor. Other people may author GEMs and may not change the standard.
7. The standard lives in the private repository EMET-GEMs. A public repository for submissions comes later. Its name is not chosen.
8. Named-item behavior stays on the core floor as a persistence rule. Only the neurodivergent framing moves.
9. A general epistemic-honesty line stays on the core floor. The neurodivergent evidence tags (peer-reviewed, emerging, anecdotal) move with the GEM.
10. Epistemic corpus lines stay on the core floor. `presence_first` and `wellbeing_wins` move with the GEM.
11. The numeric caps in SPEC.md are Draft limits. They can change by a later GEP before this spec revision is Current.

## What moves, and what stays

Measured from the server file `src/floor.js` on 2026-10-11. Byte lengths are UTF-8 JSON.

| Section or line | Bytes now | Where it goes |
|---|---:|---|
| `voice` (all ten lines: composure, measured, directness, concrete, restraint, honesty, priorities, discipline, no_moralising, not_modifiable) | 1,668 | Stays. Honesty, no flattery, and truth over speculation are core protections. Style lines that are not protections stay in the file until a later GEP gives them a GEM. This GEP does not move them into Neurendipity. |
| `engagement` except the clause named below | 1,806 | Stays, for the same reason. Protections that stay by name: `answer_and_stop`, `no_borrowed_hazards` (the rule), `not_retired`, `their_own_plan`. |
| `engagement.no_borrowed_hazards`, the clause "for a user with rejection sensitivity it is corrosive" | (inside 1,806) | Neurendipity. The rule stays in core. |
| `reading_people` (all lines, including masking) | 1,578 | Neurendipity. |
| `neurodivergent_support` except persistence behavior | 2,383 | Neurendipity, including the guide pointer, validation, flare, burnout, late identification, and the evidence-tag line. |
| `neurodivergent_support.out_of_sight` | (inside 2,383) | Behavior stays in core as persistence (`named_items` at startup). The framing "for a neurodivergent user" moves to Neurendipity and does not repeat the procedure. |
| `neurodivergent_support.epistemic_honesty` | (inside 2,383) | A general line stays in core voice: tag a claim as established, emerging, or anecdote. The peer-reviewed / emerging / anecdotal tags stay in the GEM. |
| `corpus_discipline`: `judgment_gated`, `name_the_weight`, `equips_not_diagnoses`, `lived_data_wins` | (inside 705) | Core. |
| `corpus_discipline`: `presence_first`, `wellbeing_wins` | (inside 705) | Neurendipity. |
| Precedence | 485 | Stays in core, plus one sentence: an active GEM ranks below the floor and below the user's current word. |
| Reassertion lines 1 to 4 (answer and stop, no borrowed caution, no flattery, say what is uncertain) | (inside 936) | Core. |
| Reassertion lines 5 to 9 (validation, presence, outsized reaction, masking, burnout) | (inside 936) | Neurendipity. |
| Reassertion line 10 (out of sight) | (inside 936) | Core. It is the persistence rule. |
| Reassertion line 11 (evidence tags) | (inside 936) | General form stays in core. The neurodivergent tag line stays in the GEM. |
| Operating discipline, nine lines in server code, outside this file | n/a | Core. Unaffected. Fact-checking lives here. |
| `guides/NEURODIVERGENT_SUPPORT.md` | 26,430 | Moves with the GEM. On demand, not part of startup. The old id resolves for one release. |

Whole floor object today: 8,229 bytes. Reassertion array: 936. Precedence string: 485. Together: 9,650.

A worked estimate of the file after this move, GEM off (the default), using the line split above: core floor 4,666 bytes, reassertion 480, precedence 600, together 5,746. That is 3,904 bytes less than today. The same wording puts the Neurendipity floor document at 4,853 bytes, under the 8,192 cap. With the GEM on, startup carries both: 5,746 plus 4,853, which is 949 bytes more than today's 9,650, because the persistence rule stays in core and the framing is a separate GEM line. PR 3 remeasures with the real wording. These figures are the estimate, not the pilot result.

Lines in `voice` and `engagement` that are manner rather than protection (for example mentorship, pace, analogy) are not core protections and are not part of Neurendipity. They remain in `src/floor.js` until a later GEP names a home. This GEP does not invent that GEM.

## Charter commitment 6

**What failure does it fix, and where is it on record?** The neurodivergent engagement rules sit inside the non-removable floor, so every install and every bot receives them, and nobody can turn them off. That is the wrong shape for a memory server. The lines are in `src/floor.js` (`reading_people`, `neurodivergent_support`, the two wellbeing corpus lines, reassertion lines 5 to 9) and they are served at every `emet_initialize`.

**What does it replace or retire?** Those lines leave the core floor. They are not copied into a second always-on document. The guide moves with them. Persistence behavior, general epistemic honesty, the epistemic corpus lines, and the honesty protections stay.

**How will we know it worked?** One pair of measures, taken the same way before the move and after, in the implementation pilot: the UTF-8 JSON size of the core floor object plus reassertion plus precedence, and the byte length of the `emet_initialize` payload. Baseline on 2026-10-11: floor 8,229, reassertion 936, precedence 485. With Neurendipity off, the core figure should fall by the moved sections (worked estimate: 9,650 down to 5,746). With Neurendipity on, `gems_available` shows it active and the GEM floor is present. The guide's 26,430 bytes should stay out of startup either way. The roadmap's live-sized startup is about 64 KB whole; the pilot records that length too, so a host-facing change is visible and not only the floor file.

**What holds it once it works?** The charter: core protections are non-removable, and no GEM may weaken them. The socket refuses a GEM that fails `gem-check`, including the floor-negation lint and the section-key ban. Neurendipity's manifest has `defaultOn: false`. The available list shows the GEM while it is off, so a bot does not treat it as active. Until the socket ships, nothing has moved and the hold is this GEP plus the charter revision.

## Security effects

Neurendipity is a prompt GEM: no RUNED directives, no code. The threat that applies is prompt injection by GEM text, held by precedence and the lint. The rest of the trust model is specified now so a later RUNED GEM does not arrive ahead of its checks. See [SPEC.md](../SPEC.md) sections 11 and 12 and [CONFORMANCE.md](../CONFORMANCE.md).

## What the implementation changes, later

Not this proposal's patch. Server work follows in later pull requests: the socket and `gem-check`, then `gems/neurendipity` with the real lines and the guide alias, then activation controls, then RUNED execution. The example manifest in this folder is the shape, not the payload to install.
