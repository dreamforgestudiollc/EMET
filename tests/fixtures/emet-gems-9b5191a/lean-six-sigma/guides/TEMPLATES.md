# Templates

Copy a blank block onto the project sheet. Leave a cell empty until you have the fact. Each filled block is an illustration with made-up details. Do not copy those details into a live project. A calculator returns numbers only. File a sealed record only when you ask.

## Project charter

Instructions. One charter per project. Problem statement: what, where, when, how large. No cause and no solution in that sentence. Goal: baseline, target, date. Baseline may read "baseline not measured yet". Mark the path DMAIC or DMADV.

Blank

| Field | Entry |
| --- | --- |
| Project name | |
| Path (DMAIC or DMADV) | |
| Problem statement | |
| Business case | |
| Goal baseline | |
| Goal target | |
| Goal date | |
| Scope in | |
| Scope out | |
| Team and roles | |
| Champion | |
| Start date | |
| Target end | |
| Define milestone | |
| Measure milestone | |
| Analyze milestone | |
| Improve milestone | |
| Control milestone | |
| Resources | |

Filled example. Illustration, not your data. Project name: North dock seal leaks. Path: DMAIC. Problem statement: Line 2 seal rejects rose in March at the north dock, 40 rejects in 2,000 seals. Business case: returns and rework. Goal baseline: baseline not measured yet. Goal target: the user sets it. Goal date: the user sets it. Scope in: line 2 seal cell. Scope out: line 1 and the warehouse. Team: one operator, one quality tech, one supervisor. Champion: the name the user supplies. Milestones: blank until dated.

## SIPOC

Instructions. About five to seven process steps. Customer requirements only when you know them.

Blank

| Suppliers | Inputs | Process steps | Outputs | Customers | Requirement if known |
| --- | --- | --- | --- | --- | --- |
| | | 1. | | | |
| | | 2. | | | |
| | | 3. | | | |
| | | 4. | | | |
| | | 5. | | | |

Filled example. Illustration, not your data. Supplier: resin crib. Input: pellet lot. Steps: dry, mold, trim, inspect, pack. Output: sealed case. Customer: finish plant. Requirement: no leak at 5 psi, only if the user has that spec.

## VOC and CTQ tree

Instructions. Keep the voice in the customer's words. A CTQ must be measurable. Kano only if you supply the label.

Blank

| Voice (verbatim) | Customer | Need | Driver | CTQ | Target | LSL | USL | Unit | Method | Kano if supplied |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | |

Filled example. Illustration, not your data. Voice: "The case leaks on the truck." Customer: finish plant. Need: arrives dry. Driver: seal integrity. CTQ: leak pressure. Target: blank. LSL: blank. USL: blank. Unit: psi. Method: hold test. Kano: blank.

## Data collection plan

Instructions. Write the operational definition so two people count the same way. Sample size stays blank until you calculate it or you supply a size and name the source.

Blank

| Measure | Continuous or discrete | Operational definition | Unit | Source | Method | Sample size | Stratification | Who collects | When | Integrity check |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | |

Filled example. Illustration, not your data. Measure: leak fails. Discrete. Definition: a case that loses pressure before 30 seconds on the hold test. Unit: case. Source: line 2 log. Method: tally at inspect. Sample size: blank until calculated. Stratification: shift. Who: the user names them. When: each shift. Integrity check: recount one hour with a second person.

## MSA and Gage R&R plan

Instructions. This sheet plans the study. It does not calculate Gage R&R. Result cells stay blank until you have a result from a study you ran. Write the acceptance rule in the sponsor's words. Do not insert a 10 percent or 30 percent cutoff unless the sponsor stated that rule.

Blank

| Field | Entry |
| --- | --- |
| Instrument | |
| Characteristic | |
| Unit | |
| Resolution | |
| Appraisers | |
| Parts | |
| Replicates | |
| Crossed or nested | |
| Sponsor acceptance rule | |
| Repeatability result | |
| Reproducibility result | |
| Percent of tolerance | |
| Percent of study variation | |

Filled example. Illustration, not your data. Instrument: pressure gage A. Characteristic: leak pressure. Unit: psi. Resolution: 0.1 psi. Appraisers: two names the user supplies. Parts: 10. Replicates: 3. Crossed. Sponsor rule: blank until the sponsor writes it. All four result cells: blank.

## Fishbone

Instructions. Write the effect as the problem, not the cause. Use people, method, machine, material, measurement, and environment, or replace those labels. A cause is marked for testing only when you say so.

Blank

| Effect | Category | Cause | Marked for test (yes or blank) |
| --- | --- | --- | --- |
| | | | |

Filled example. Illustration, not your data. Effect: seal leak at inspect. Category: method. Cause: dwell time shorter than the card. Marked for test: blank until you say yes.

## Five Whys

Instructions. Stop at the why you stop at. Leave later whys blank. Countermeasure stays blank until you write it.

Blank

| Problem statement | |
| --- | --- |
| Why 1 | |
| Why 2 | |
| Why 3 | |
| Why 4 | |
| Why 5 | |
| Countermeasure | |

Filled example. Illustration, not your data. Problem: dwell shorter than the card. Why 1: the timer was set to the old card. Why 2: the card changed last month and the timer was not updated. Why 3 through why 5: blank. Countermeasure: blank until you write the action.

## FMEA

Instructions. Severity, occurrence, and detection are integers you enter from 1 to 10. RPN is severity times occurrence times detection, and only when all three are present. Otherwise RPN stays blank. New ratings stay blank until you return with them. Worked product: see `guides/FORMULAS.md#RPN` (8 times 4 times 5 = 160) as arithmetic, not as a score for this row.

Blank

| Step | Function | Failure mode | Effect | Severity | Cause | Occurrence | Current controls | Detection | RPN | Action | Owner | Date | New severity | New occurrence | New detection | New RPN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | | | | | | | |

Filled example. Illustration, not your data. Step: seal. Function: hold pressure. Failure mode: short dwell. Effect: leak. Severity: blank until you score it. Cause: old timer setting. Occurrence: blank. Controls: work instruction. Detection: blank. RPN: blank. Action: blank. Owner: blank. Date: blank. New ratings: blank.

## Hypothesis test selection

Instructions. Answer the four questions. Then you pick the candidate. The package does not launch a test you did not name. Tests this version works by hand are in `guides/FORMULAS.md`. A row marked named only is a name and a list of assumptions. You compute that statistic with your own source. This version does not return a p-value.

Questions

1. What are you comparing?
2. Are the data measurements or counts?
3. How many groups?
4. Is a standard deviation known, or estimated from this sample?

| Situation you describe | Candidate | In the formula guide |
| --- | --- | --- |
| One mean, sigma estimated from the sample | One-sample t | Yes. Statistic and degrees of freedom. |
| One mean, sigma treated as known | z test | The interval only, when you supply z. The test decision is not computed. |
| Paired measurements | Paired t on the differences | Named only. |
| Two independent means | Two-sample t | Named only. |
| More than two means | One-way ANOVA | Yes. Sums of squares and F. |
| Counts against expected counts | Chi-square goodness of fit | Yes. Statistic and degrees of freedom. |
| Two continuous measures, a line | Simple linear regression | Yes. Slope, intercept, and R squared. |
| A variance, two variances, or a proportion test | The matching textbook test | Named only. |

Blank decision

| Question | Your answer |
| --- | --- |
| What is compared | |
| Measurements or counts | |
| How many groups | |
| Sigma known or estimated | |
| Candidate you pick | |
| Assumptions you have not checked | |

Filled example. Illustration, not your data. Compared: mean dwell time against 12 seconds. Measurements. One group. Sigma estimated. Candidate you pick: one-sample t. Assumptions not checked: normality.

## DOE planning

Instructions. You choose the design name and you supply the run order. This version does not build a design matrix and does not randomize for you.

Blank

| Response | |
| --- | --- |
| Factors and levels | |
| Ranges | |
| Design name you choose | |
| Replicates | |
| Randomized (yes or no) | |
| Run order you supply | |
| Blocking | |
| Noise factors | |

Filled example. Illustration, not your data. Response: leak pressure. Factors: dwell at two levels, temperature at two levels. Ranges: the user writes the numbers. Design name: full factorial. Replicates: 2. Randomized: blank until you say. Run order: blank until you list it. Blocking: none stated. Noise: ambient humidity, blank until measured.

## Control plan

Instructions. One row per step and CTQ. Chart type is a name (individuals, X-bar and R, p, np, c, or u) you choose after you know the data. Limits are computed in the formula guide or written "limits not set".

Blank

| Step | CTQ | Spec | Measurement method | Sample size | Frequency | Chart type | Response plan pointer | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |

Filled example. Illustration, not your data. Step: inspect. CTQ: leak pressure. Spec: blank. Method: hold test. Sample size: 5. Frequency: each hour. Chart: X-bar and R. Response pointer: the response plan row. Owner: the user names them.

## Response plan

Instructions. Name the chart and the limit. Immediate action, containment, escalation, and the resume condition are yours. A point is out of limits only when you supply the point and the limits.

Blank

| Signal (chart and limit) | Immediate action | Owner | Containment | Escalation | Resume when |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

Filled example. Illustration, not your data. Signal: X-bar above the upper limit you calculated. Immediate action: stop the sealer. Owner: cell lead. Containment: hold the last hour of cases. Escalation: supervisor. Resume when: the user writes the condition.

## A3

Instructions. One page of plain sentences. Empty sections stay empty.

Blank

| Background | |
| --- | --- |
| Current condition | |
| Goal | |
| Analysis | |
| Countermeasures | |
| Plan | |
| Follow-up | |

Filled example. Illustration, not your data. Background: north dock leaks in March. Current condition: 40 rejects in 2,000 seals, from the user's count. Goal: blank until set. Analysis: blank until Analyze. Countermeasures: blank. Plan: blank. Follow-up: blank.

## Tollgate checklists

Instructions. Mark a line only when the matching tollgate in `guides/DMAIC.md` or `guides/DMADV.md` is satisfied by something you supplied. An open line stays open.

Blank, DMAIC

| Gate | Item | Open or met | Evidence you supply |
| --- | --- | --- | --- |
| Define | Problem, goal, scope, team, champion, SIPOC, CTQ or dated plan | | |
| Measure | Definitions, data plan, MSA plan, map, baseline from your data | | |
| Analyze | Cause list, Five Whys, chosen analysis, accepted cause | | |
| Improve | Countermeasures, pilot, DOE or "no DOE", FMEA, pilot data, money sheet | | |
| Control | Control plan, response plan, limits or "limits not set", owner, lessons, benefits, frequency | | |

Blank, DMADV

| Gate | Item | Open or met | Evidence you supply |
| --- | --- | --- | --- |
| Define | Customer, business case, charter | | |
| Measure | CTQs and targets you set | | |
| Analyze | Concepts you listed and risks you named | | |
| Design | Selected design, predicted capability from your inputs, pilot plan | | |
| Verify | Validation data you collected, control plan | | |

Filled example. Illustration, not your data. Define row: Open. Evidence: problem statement drafted, champion name still blank.

## Financial benefits worksheet

Instructions. Hard savings and soft savings stay on their own rows. Do not turn soft into hard. Do not annualize unless you supply the number of periods and ask for the product. The finance name stays blank until you supply it.

Blank

| Field | Entry |
| --- | --- |
| Baseline metric | |
| Baseline period | |
| Improved metric | |
| Volume | |
| Cost per unit of the metric | |
| Hard savings | |
| Soft savings (keep this label) | |
| Periods, if you ask to annualize | |
| Finance name | |

Filled example. Illustration, not your data. Baseline metric: leak rejects. Period: March. Improved metric: blank until measured. Volume: blank. Cost per unit: blank until finance or you supply it. Hard savings: blank. Soft savings: blank. Periods: blank. Finance name: blank.
