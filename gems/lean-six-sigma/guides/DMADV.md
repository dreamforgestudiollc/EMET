## DMADV

DMADV is the path for a new design (Design for Six Sigma): Define, Measure, Analyze, Design, Verify. DMAIC is the path for an existing process. If the work is a new design, keep the DMADV label. Do not copy DMADV results into a DMAIC phase.

The same rules apply. Ask for data. Leave a blank blank. Name assumptions you did not check. Illustrations are not your data. Use `guides/FORMULAS.md` when a formula applies. The five client calculators return numbers and do not write a record. Say when a predicted capability is only as good as the inputs you supplied.

A Black Belt coaching a design team asks who the customer is, which CTQ is measurable, and which validation row came from a trial. This package does not certify a belt.

## Define

Define the new design in customer and business terms.

- Customer: who will use the design, in the words the sponsor uses.
- Business case: why a new design is required, and what the current process cannot do. Leave cost figures blank until finance or the user supplies them.
- Charter: problem in design language (the need, not a chosen concept), goal, scope in, scope out, team, champion, start, and target end.
- The champion's acceptance is a name the user supplies. This package does not sign.

Open `guides/TEMPLATES.md#Project charter` and mark the sheet "DMADV" so it is not filed as a DMAIC charter.

## Measure

Measure sets the CTQs and the targets before a concept is chosen.

- Voice statements in the customer's words.
- Need, driver, and a CTQ with target, lower spec, upper spec, unit, and measurement method.
- A Kano label only when the user supplies one.
- Targets the user sets. A target copied from a similar product is still the user's number, and the source is written on the sheet.
- If no voice has been collected, write the dated plan and leave the CTQ specs blank.

## Analyze

Analyze compares design concepts the user lists. It does not invent a concept.

- List the concepts the team is willing to consider. Leave the list empty until they name them.
- For each concept, record the risks the user names: safety, compliance, capability, cost, and time. An empty risk cell stays empty.
- Score only ratings the user enters. See the FMEA template if they want RPN.
- Write the concept they select, and the reason in their words. If they have not selected one, the gate stays open.

## Design

Design records the selected design at a level a pilot can build.

- The selected concept and the features that meet each CTQ.
- Predicted capability only from inputs the user supplies (mean, sigma, specs), computed with `guides/FORMULAS.md#Cp` and the Cpk section. Name whether sigma is within-subgroup or overall. If normality was not checked, say so.
- A pilot plan: units, site, measures, and the decision rule the user states.
- A DOE plan if they will experiment, or the words "no designed experiment on this project". This version does not build a design matrix.

## Verify

Verify uses validation data the user collected, then leaves a control plan for the new process.

- Validation rows: what was run, how many, and the results they recorded. Do not fill results from the prediction.
- Compare results to the CTQ specs. A miss stays a miss.
- Control plan for the new process: step, CTQ, spec, method, sample, owner. Limits from stable validation data, or "limits not set".
- Response plan and process owner.
- Financial worksheet from measured results. Soft savings stay labeled soft.
