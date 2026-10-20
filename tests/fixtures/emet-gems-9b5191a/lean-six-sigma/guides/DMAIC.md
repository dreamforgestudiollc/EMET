## DMAIC

DMAIC is the path for an existing process: Define, Measure, Analyze, Improve, Control. A new design uses the DMADV note in `guides/DMADV.md` and keeps that label.

Work one phase at a time. If you do not know the phase, start at Define and say that is where you started. Copy blanks from `guides/TEMPLATES.md`. Compute from `guides/FORMULAS.md` with your own data. Five client calculators return numbers for capability, DPMO and yield, control limits, sample size, and basic statistics. They do not write a record. File a sealed record only when you ask.

An illustration in a template is not your data. Leave a field blank until you supply the fact. A tollgate item with no answer stays open. You may defer an item only by writing the deferral and the date.

Project figures stay in this install. Do not send them to another host, an inbox, or a service.

## Define

Define names the problem, the goal, and the boundaries. It does not name a cause and it does not name a solution.

1. Write the problem statement: what is wrong, where, when, and how large. Include a baseline, or write "baseline not measured yet". Keep the cause and the remedy out of this sentence. Those belong in Analyze and Improve, after the data.
2. Write the goal as baseline, target, and date. Leave the baseline blank until Measure records it.
3. Write scope in and scope out. Name the process steps that are inside the project and the sites, products, or shifts that are outside it.
4. Name the team, the roles, and the champion. The champion accepts the charter. This package does not sign for them.
5. Write the business case in the customer's terms and in the company's terms. Money waits for the financial worksheet and for a person in finance.
6. Build a SIPOC: suppliers, inputs, about five to seven process steps, outputs, customers.
7. Record the voice of the customer in their words, then a CTQ that can be measured: target, lower spec, upper spec, unit, and method. If you do not have a voice yet, write a dated plan to collect it.
8. Open `guides/TEMPLATES.md#Project charter` and fill only the lines you know.

Coach note. A Yellow Belt can draft the charter, the SIPOC, and the CTQ tree. Ask whether a Green Belt or a Black Belt should read the problem statement before the champion accepts it.

## Define tollgate

Read each line. Leave it open until the user supplies it, or until the user writes a deferral and a date.

- Problem statement with what, where, when, and magnitude. No cause. No solution.
- Baseline number, or the words "baseline not measured yet".
- Goal with target and date.
- Scope in and scope out.
- Team, roles, and champion.
- Business case.
- SIPOC.
- At least one CTQ, or a dated plan to collect the voice of the customer.
- Charter status: the name of the person the user says has accepted it.

Do not close a line because a similar project usually has that answer.

## Measure

Measure turns the CTQ into a number you can trust, then records the baseline from data you collected.

1. Write an operational definition for each measure: what is counted, the unit, the inclusion rule, and the exclusion rule. Two people using the definition should reach the same count on the same item.
2. Fill the data collection plan: continuous or discrete, source, method, who collects, when, and the stratification factors (shift, line, product, or others you name). Leave sample size blank until you calculate it from `guides/FORMULAS.md#Sample size for a proportion` or `#Sample size for a mean`, or until you supply a size from a standard your sponsor already uses.
3. Plan the measurement system before you trust the baseline. Use `guides/TEMPLATES.md#MSA and Gage R&R plan`. This version records the plan and any result you already have. It does not calculate Gage R&R.
4. Map the process or the value stream with times the user measured. Lead time and process time stay blank until those times exist. See `guides/LEAN.md#Value stream map`.
5. Compute the baseline only from the rows you collected. DPMO, yield, and capability come from `guides/FORMULAS.md` with those inputs. Name the formula. If an input is missing, stop and ask.
6. State the assumptions beside any index: stable process, and, for Cp and Cpk, a normal model unless you say you did not check normality.

Coach note. Do not quote a sigma level from a training table. The count path is DPMO. Inverse normal is not computed in this version. See `guides/FORMULAS.md#Sigma level`.

## Measure tollgate

- Operational definition for each measure.
- Data collection plan, including who collects and when.
- MSA plan. A result only if you already have one.
- Process map or value stream map built from observed steps.
- Baseline computed from your data, with the formula named.
- Sample size either calculated from the formula guide or supplied by you, with the source written down.
- Assumptions named, including any you did not check.

## Analyze

Analyze keeps a cause only when the evidence you bring supports it. The package does not pick the cause.

1. Build a cause list with the fishbone. Categories may be people, method, machine, material, measurement, and environment. Drop or add a category. Every cause is in your words.
2. Run Five Whys on the causes you choose to push on. Stop at the why you stop at. Leave the countermeasure blank until you write it.
3. Choose a test from `guides/TEMPLATES.md#Hypothesis test selection`. You pick. The guide names assumptions. For a test this package works by hand, follow the matching section in `guides/FORMULAS.md`. For a test marked named only, write the name and the assumptions, and compute it with your own textbook. This version does not return a p-value.
4. Write the cause you accept for Improve. If you do not accept one yet, the item stays open.

Coach note. A Green Belt can run the basic tests in the formula guide. Ask whether a Black Belt should review a designed experiment, a Gage decision, or a savings number finance has not signed.

## Analyze tollgate

- Fishbone or an equivalent cause list from you.
- Five Whys for the causes you selected.
- The analysis you chose, with assumptions written beside the result.
- The cause you accept for Improve, in your words.
- Any test you did not run left as "not run", not as a result.

## Improve

Improve changes the process against the accepted cause, on a pilot first.

1. Write countermeasures that name the accepted cause they address. A countermeasure with no cause stays a draft.
2. Write the pilot plan: where, how many units or how many days, what you will measure, and what "better" means using the goal from Define.
3. If you will run a designed experiment, fill `guides/TEMPLATES.md#DOE planning`. If you will not, write "no designed experiment on this project". This version does not build a design matrix. You supply the run order.
4. Score an FMEA for the change with severity, occurrence, and detection you enter from 1 to 10. RPN is the product only when all three numbers are present. See `guides/FORMULAS.md#RPN`.
5. Record pilot results from the pilot data only. Update the financial worksheet from those results. Hard savings and soft savings stay in their own rows. Do not annualize unless you supply the number of periods and ask for the product.
6. Use Lean tools where they match the cause: 5S, setup reduction, pull, mistake-proofing, or a kaizen cycle. See `guides/LEAN.md`.

## Improve tollgate

- Countermeasures tied to accepted causes.
- Pilot plan.
- DOE plan, or the words "no designed experiment on this project".
- FMEA scored only with your ratings.
- Pilot results from your data.
- Financial worksheet updated from those results, with soft savings still labeled soft.
- The name of the person in finance who validated a hard-savings number, or a blank if nobody has.

## Control

Control hands a stable method to a process owner, with limits from your data and a response when a point crosses a limit.

1. Write the control plan: step, CTQ, spec, measurement method, sample size and frequency, chart type, and owner.
2. Write the response plan: which limit, the immediate action, containment, escalation, and the condition for resuming. A point is out of limits only when you supply the point and the limits, or when you compare a supplied point to limits you just computed from supplied data.
3. Set chart limits from a stable set of your data, using `guides/FORMULAS.md`, or write "limits not set".
4. Name the process owner and the handoff date.
5. Record lessons you actually learned. Do not fill lessons from a template example.
6. Leave the benefits in the state the worksheet records.
7. Write how often the owner will look at the chart.

This version calculates limits. It does not apply Western Electric or Nelson run rules. Add those only when you choose a published rule and apply it to points you supply.

## Control tollgate

- Control plan.
- Response plan.
- Control limits from your stable data, or the words "limits not set".
- Process owner and handoff.
- Lessons you recorded.
- Benefits in the worksheet's own words.
- Monitoring frequency.
