# Formulas

Compute these from inputs you supply. A missing input stops the calculation. Five client calculators return numbers for capability, DPMO and yield, control limits, sample size, and the basic statistics in this guide. They do not write a record. Takt time, OEE, Little's Law, rolled throughput yield, first pass yield, and a sigma level stay hand calculations. Illustrations use the test vectors below. They are not your process data.

Control-chart factors for subgroup sizes 2 through 10 are the table in NIST/SEMATECH e-Handbook section 6.3.2.1, checked against that page on 2026-10-11. For n = 5 the page prints A2 = 0.577, D3 = 0, D4 = 2.115. Some pocket cards print D4 for n = 5 as 2.114. This package uses 2.115.

| n | A2 | D3 | D4 |
| --- | --- | --- | --- |
| 2 | 1.880 | 0 | 3.267 |
| 3 | 1.023 | 0 | 2.575 |
| 4 | 0.729 | 0 | 2.282 |
| 5 | 0.577 | 0 | 2.115 |
| 6 | 0.483 | 0 | 2.004 |
| 7 | 0.419 | 0.076 | 1.924 |
| 8 | 0.373 | 0.136 | 1.864 |
| 9 | 0.337 | 0.184 | 1.816 |
| 10 | 0.308 | 0.223 | 1.777 |

## DPMO

Definition. DPO = defects / (units * opportunities per unit). DPMO = DPO * 1,000,000.

Assumptions. You counted defects, units, and opportunities the way the operational definition says. This is not first pass yield of units.

Worked example. Test vector: 10 defects, 100 units, 5 opportunities per unit. DPO = 10 / (100 * 5) = 10 / 500 = 0.02. DPMO = 0.02 * 1,000,000 = 20000.

Reference. The count definition is the one used with the ASQ Certified Six Sigma Black Belt body of knowledge (DMAIC Measure). Page pin is part of the 2027-10-11 source review. https://www.asq.org/cert/six-sigma-black-belt

## Opportunity yield

Definition. Opportunity yield = 1 - DPO. It is the share of opportunities with no defect.

Assumptions. Same counts as DPMO. Do not call this first pass yield.

Worked example. Test vector: DPO = 0.02. Opportunity yield = 1 - 0.02 = 0.98.

Reference. Same count path as DPMO. https://www.asq.org/cert/six-sigma-black-belt

## First pass yield

Definition. First pass yield = (units in - units that failed) / units in.

Assumptions. You supply units in and units that failed. A unit can fail once in this ratio. It is not DPO.

Worked example. Test vector for the definition check: units in = 100, units that failed = 2. First pass yield = (100 - 2) / 100 = 0.98. If you do not have both counts, leave the yield blank. The 0.98 here is from unit counts, not from the DPMO vector.

Reference. Standard throughput yield of units, kept separate from opportunity yield so the two 0.98 results are not treated as the same measurement. https://www.asq.org/cert/six-sigma-black-belt

## Rolled throughput yield

Definition. RTY is the product of the step yields you list.

Assumptions. Each step yield is a yield you already computed or measured. Do not invent a step yield.

Worked example. Test vector: 0.9, 0.8, and 0.95. RTY = 0.9 * 0.8 * 0.95 = 0.684.

Reference. Product of step yields, as used in the Black Belt process-yield material. https://www.asq.org/cert/six-sigma-black-belt

## Sigma level

Definition. Long-term z is the standard-normal quantile whose upper tail equals the defect rate, when you ask for that model. A shifted sigma equals that z plus a shift you choose. This package does not insert 1.5 when you omit the shift.

This version does not compute the inverse normal. Leave the sigma fields blank. Report DPMO and opportunity yield from the counts. The phrase "about 3.4 DPMO at six sigma" is the common Motorola table with a 1.5 shift, rounded. It is a label for that convention. It is not a count from your project, and this package does not calculate it.

Assumptions. A sigma level needs a named model. If you do not name one, do not state a sigma level.

Worked example. Test vector is the hand DPMO path: 10 defects, 100 units, 5 opportunities. DPO = 0.02. DPMO = 20000. Opportunity yield = 0.98. Sigma level: not computed.

Reference. Count path as in the DPMO section. Convention label is not a NIST computed vector. https://www.asq.org/cert/six-sigma-black-belt

## Cp

Definition. Cp = (USL - LSL) / (6 * sigma).

Assumptions. Normal model if you want the handbook meaning. Stable process. Sigma is the within-subgroup sigma when you call the index Cp. NIST/SEMATECH 6.1.6. If normality was not checked, say so. https://www.itl.nist.gov/div898/handbook/pmc/section1/pmc16.htm

Worked example. Test vector: USL = 10, LSL = 0, sigma = 1. Cp = (10 - 0) / (6 * 1) = 10/6.

## Cpu

Definition. Cpu = (USL - mean) / (3 * sigma).

Assumptions. Same normal model and stability notes as Cp. Needs a mean and an upper spec.

Worked example. Test vector: USL = 10, mean = 7, sigma = 1. Cpu = (10 - 7) / 3 = 1.

Reference. NIST/SEMATECH 6.1.6. https://www.itl.nist.gov/div898/handbook/pmc/section1/pmc16.htm

## Cpl

Definition. Cpl = (mean - LSL) / (3 * sigma).

Assumptions. Same notes as Cpu, with a lower spec.

Worked example. Test vector: mean = 7, LSL = 0, sigma = 1. Cpl = (7 - 0) / 3 = 7/3.

Reference. NIST/SEMATECH 6.1.6. https://www.itl.nist.gov/div898/handbook/pmc/section1/pmc16.htm

## Cpk

Definition. Cpk = the smaller of Cpu and Cpl.

Assumptions. Same normal model and stability notes. Cpk is not larger than Cp when both specs exist and the mean is inside them.

Worked example. Test vector: Cpu = 1, Cpl = 7/3. Cpk = 1.

Reference. NIST/SEMATECH 6.1.6. https://www.itl.nist.gov/div898/handbook/pmc/section1/pmc16.htm

## Pp

Definition. Pp uses the Cp algebra with the overall sigma of the individuals: Pp = (USL - LSL) / (6 * sigma overall).

Assumptions. Do not relabel a within sigma as overall. If the label disagrees with the formula, write "sigma label mismatch" and keep the number you actually computed under the name of the sigma you passed.

Worked example. Test vector: USL = 10, LSL = 0, overall sigma = 1. Pp = 10/6.

Reference. Same algebra as NIST/SEMATECH 6.1.6, with the overall sigma named as such. https://www.itl.nist.gov/div898/handbook/pmc/section1/pmc16.htm

## Ppk

Definition. Ppk is the smaller of the one-sided indexes computed with the overall sigma.

Assumptions. Same label rule as Pp.

Worked example. Test vector: mean = 7, USL = 10, LSL = 0, overall sigma = 1. Upper index = 1. Lower index = 7/3. Ppk = 1.

Reference. Same algebra as Cpk in NIST/SEMATECH 6.1.6, using overall sigma. https://www.itl.nist.gov/div898/handbook/pmc/section1/pmc16.htm

## Sigma from range

Definition. sigma hat = R-bar / d2. You pass d2. This package does not look up d2 for you except to point at the handbook when you copy a table.

Assumptions. Rational subgroups, normal model for the d2 relationship. NIST/SEMATECH 6.3.2.1: the mean of the range is d2 * sigma. https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc321.htm

Worked example. Test vector: R-bar = 1.128, d2 = 1.128. sigma hat = 1.128 / 1.128 = 1. The value 1.128 is d2 for a span of 2, stated on NIST/SEMATECH 6.3.2.2. https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc322.htm

## X-bar and R

Definition. For subgroup size n, using factors you take from the table above or pass in yourself:

- Upper X-bar = X double bar + A2 * R-bar
- Lower X-bar = X double bar - A2 * R-bar
- Center X-bar = X double bar
- Upper R = D4 * R-bar
- Lower R = D3 * R-bar
- Center R = R-bar

Leave a negative X-bar lower limit as that negative number. Floor a negative R lower limit at 0 and say the formula went below 0. The worked example above stays positive, so it does not show that floor. A negative center stays negative. X double bar = -5, R-bar = 2, n = 5, A2 = 0.577 gives upper X-bar = -3.846 and lower X-bar = -6.154. X double bar = -1 with the same R-bar and A2 gives lower X-bar = -2.154. Do not floor those lower limits.

Assumptions. Shewhart three-sigma limits. Normal model for the factor derivation. Rational subgroups. NIST/SEMATECH 6.3.2.1. https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc321.htm

Worked example. Test vector: n = 5, A2 = 0.577, D4 = 2.115, D3 = 0, X double bar = 50, R-bar = 4. Upper X-bar = 50 + 0.577 * 4 = 50 + 2.308 = 52.308. Lower X-bar = 50 - 2.308 = 47.692. Upper R = 2.115 * 4 = 8.46. Lower R = 0.

## Individuals and moving range

Definition. Moving range is the absolute difference of successive points. d2 for span 2 is 1.128.

- Upper individuals = x-bar + 3 * MR-bar / 1.128
- Lower individuals = x-bar - 3 * MR-bar / 1.128
- Center = x-bar
- Upper moving range = D4 * MR-bar with D4 = 3.267 from the n = 2 row
- Lower moving range = 0

Leave a negative individuals lower limit as that negative number. The moving-range lower limit stays 0. x-bar = -1 and MR-bar = 0.5 give lower individuals = -1 - 1.5/1.128, about -2.330. Do not floor it.

Assumptions. NIST/SEMATECH 6.3.2.2. The moving range uses successive pairs. https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc322.htm

Worked example. Test vector: x-bar = 10, MR-bar = 2. Upper = 10 + 6/1.128. Lower = 10 - 6/1.128. Upper moving range = 3.267 * 2 = 6.534. Lower moving range = 0. In a spreadsheet, 6/1.128 is about 5.319149, so the individuals limits are about 15.319149 and 4.680851. Keep the fraction 6/1.128 as the exact form.

## p chart

Definition. For equal subgroup size n:

- Upper = p-bar + 3 * square root of (p-bar * (1 - p-bar) / n)
- Lower = p-bar - 3 * square root of (p-bar * (1 - p-bar) / n), then 0 if that result is negative
- Center = p-bar

Assumptions. Binomial model, independent units, constant n. NIST/SEMATECH 6.3.3.2. https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc332.htm

Worked example. Test vector: p-bar = 0.1, n = 100. Square root of (0.1 * 0.9 / 100) = square root of 0.0009 = 0.03. Upper = 0.1 + 0.09 = 0.19. Lower = 0.1 - 0.09 = 0.01.

## np chart

Definition. Center = n * p-bar. Upper = center + 3 * square root of (n * p-bar * (1 - p-bar)). Lower = center - that same quantity, then 0 if negative.

Assumptions. Same binomial model as the p chart. The mean of the count is n * p and the variance is n * p * (1 - p), as stated in NIST/SEMATECH 6.3.3.2. https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc332.htm

Worked example. Test vector: n = 100, p-bar = 0.1. Center = 10. Square root of (100 * 0.1 * 0.9) = square root of 9 = 3. Upper = 10 + 9 = 19. Lower = 10 - 9 = 1.

## c chart

Definition. Upper = c-bar + 3 * square root of c-bar. Lower = c-bar - 3 * square root of c-bar, then 0 if negative. Center = c-bar.

Assumptions. Poisson counts, equal area of opportunity. The normal approximation is the usual basis for these limits. NIST/SEMATECH 6.3.3.1. The handbook example is this vector. https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc331.htm

Worked example. Test vector: c-bar = 16. Square root of 16 = 4. Upper = 16 + 12 = 28. Lower = 16 - 12 = 4. Clamp vector: c-bar = 1. Square root of 1 = 1. Upper = 1 + 3 = 4. The formula lower limit is 1 - 3 = -2, so the reported lower limit is 0.

## u chart

Definition. Upper = u-bar + 3 * square root of (u-bar / n). Lower = u-bar - 3 * square root of (u-bar / n), then 0 if negative. Center = u-bar. Here n is the opportunity size for this limit. One n per calculation. A different subgroup size needs another calculation.

Assumptions. Poisson counts per unit of opportunity. Same three-sigma Poisson form as NIST/SEMATECH 6.3.3.1, per unit. https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc331.htm

Worked example. Test vector: u-bar = 4, n = 4. Square root of (4 / 4) = 1. Upper = 4 + 3 = 7. Lower = 4 - 3 = 1.

## Sample size for a proportion

Definition. n = z squared * p * (1 - p) / E squared, then the smallest integer greater than or equal to that value.

Assumptions. Normal approximation for a margin of error. Write "margin of error, not power". E must be greater than 0. p is between 0 and 1.

Worked example. Test vector: z = 2, p = 0.5, E = 0.1. n = 4 * 0.25 / 0.01 = 1 / 0.01 = 100.

Reference. Classical normal-approximation sample size in the ASQ Certified Six Sigma Black Belt body of knowledge. https://www.asq.org/cert/six-sigma-black-belt

## Sample size for a mean

Definition. n = (z * sigma / E) squared, then the same ceiling.

Assumptions. Sigma treated as known. Margin of error, not a power calculation. E and sigma greater than 0.

Worked example. Test vector: z = 2, sigma = 5, E = 1. n = (10 / 1) squared = 100.

Reference. Same margin-of-error algebra as the proportion sample size, in the ASQ Certified Six Sigma Black Belt body of knowledge. https://www.asq.org/cert/six-sigma-black-belt

## Known-sigma confidence interval

Definition. Interval from x-bar - z * (sigma / square root of n) to x-bar + z * (sigma / square root of n).

Assumptions. Sigma known. Normal model, or a large sample if you say that is the basis. You supply z. This package does not choose 1.96 for you.

Worked example. Test vector: x-bar = 10, sigma = 2, n = 16, z = 2. Standard error = 2 / 4 = 0.5. Margin = 2 * 0.5 = 1. Interval = 9 to 11.

Reference. Known-sigma interval in the ASQ Certified Six Sigma Black Belt body of knowledge. https://www.asq.org/cert/six-sigma-black-belt

## Confidence interval with t

Definition. Interval from x-bar - t * (s / square root of n) to x-bar + t * (s / square root of n). t is the critical value you supply.

Assumptions. Sigma unknown. You bring t from a table you trust. This package does not look up t.

Worked example. Test vector: x-bar = 10, s = 2, n = 16, t = 2. Standard error = 0.5. Margin = 1. Interval = 9 to 11. The 2 is your input, not a table lookup.

Reference. Interval with a caller-supplied t, in the ASQ Certified Six Sigma Black Belt body of knowledge. https://www.asq.org/cert/six-sigma-black-belt

## One-sample t

Definition. t = (x-bar - mu0) / (s / square root of n). Degrees of freedom = n - 1.

Assumptions. Independent observations. Normal model, or you say it was not checked. Sigma estimated from this sample. No p-value in this version. If you also supply a critical value, say whether the absolute statistic exceeds it. Do not look up the critical value here.

Worked example. Test vector: x-bar = 10, mu0 = 8, s = 2, n = 16. Denominator = 2 / 4 = 0.5. t = (10 - 8) / 0.5 = 4. Degrees of freedom = 15.

Reference. One-sample t in the ASQ Certified Six Sigma Black Belt body of knowledge. https://www.asq.org/cert/six-sigma-black-belt

## Chi-square goodness of fit

Definition. Chi-square = the sum of (observed - expected) squared / expected. Degrees of freedom = k - 1 - m, where k is the number of classes and m is the number of parameters you estimated from the data. You pass m. Each expected value must be greater than 0.

Assumptions. Independent counts. Expected counts large enough for the approximation you intend. If an expected value is 0, do not report the statistic.

Worked example. Test vector: observed 10, 20, 30. Expected 20, 20, 20. m = 0. Terms: (10 - 20) squared / 20 = 5, (20 - 20) squared / 20 = 0, (30 - 20) squared / 20 = 5. Chi-square = 10. Degrees of freedom = 3 - 1 - 0 = 2.

Reference. Chi-square goodness of fit in the ASQ Certified Six Sigma Black Belt body of knowledge. https://www.asq.org/cert/six-sigma-black-belt

## One-way ANOVA

Definition. Grand mean, group means, between sum of squares (SSB), within sum of squares (SSW), mean squares, and F = MSB / MSW. Degrees of freedom between = groups minus 1. Degrees of freedom within = observations minus groups.

Assumptions. Independent groups. Normality not tested by this arithmetic. Equal variance not tested by this arithmetic. No p-value in this version.

Worked example. Test vector: groups {1, 2, 3} and {4, 5, 6}. Grand mean = 21 / 6 = 3.5. Group means = 2 and 5. SSB = 3 * (2 - 3.5) squared + 3 * (5 - 3.5) squared = 3 * 2.25 + 3 * 2.25 = 13.5. SSW = (1 - 2) squared + (2 - 2) squared + (3 - 2) squared + (4 - 5) squared + (5 - 5) squared + (6 - 5) squared = 1 + 0 + 1 + 1 + 0 + 1 = 4. MSB = 13.5 / 1 = 13.5. MSW = 4 / 4 = 1. F = 13.5. Degrees of freedom between = 1. Degrees of freedom within = 4.

Reference. One-way ANOVA in the ASQ Certified Six Sigma Black Belt body of knowledge. https://www.asq.org/cert/six-sigma-black-belt

## Simple linear regression

Definition. Slope = sum of (x - x-bar) * (y - y-bar) / sum of (x - x-bar) squared. Intercept = y-bar - slope * x-bar. R squared = 1 - (residual sum of squares / total sum of squares).

Assumptions. A straight line is your choice. If every x is equal, do not report a slope. If n is under 3 and the x values are not all equal, you may still report the fit and you flag small n. No p-value in this version.

Worked example. Test vector: (1, 2), (2, 4), (3, 6). x-bar = 2. y-bar = 4. Numerator = (-1) * (-2) + 0 * 0 + 1 * 2 = 4. Denominator = 1 + 0 + 1 = 2. Slope = 2. Intercept = 4 - 2 * 2 = 0. Fitted values match y, so residual sum of squares = 0 and R squared = 1.

Reference. Simple linear regression in the ASQ Certified Six Sigma Black Belt body of knowledge. https://www.asq.org/cert/six-sigma-black-belt

## Takt time

Definition. Takt = available time / customer demand, for the same period.

Assumptions. Both numbers cover one period. Demand is the customer's demand, not the rate you wish you could run.

Worked example. Test vector: 480 minutes available, 240 units demanded. Takt = 480 / 240 = 2 minutes per unit.

Reference. Takt time in the ASQ Certified Six Sigma Black Belt body of knowledge (Lean). https://www.asq.org/cert/six-sigma-black-belt

## OEE

Definition. OEE = availability * performance * quality, each a ratio from 0 to 1.

- Availability = run time / planned time
- Performance = (ideal cycle time * total count) / run time
- Quality = good count / total count

A factor outside 0 to 1 is not clamped. Stop and check the inputs.

Assumptions. The three ratios describe the same period.

Worked example. Test vector: 0.9, 0.8, and 0.75. OEE = 0.9 * 0.8 * 0.75 = 0.54.

Reference. OEE in the ASQ Certified Six Sigma Black Belt body of knowledge (Lean). https://www.asq.org/cert/six-sigma-black-belt

## Little's Law

Definition. Average inventory = average throughput * average flow time, in consistent units.

Assumptions. The averages describe the same stable period. Units of throughput and flow time must match (per day with days, not per day with hours, unless you convert).

Worked example. Test vector: 20 units per day, flow time 2 days. Inventory = 20 * 2 = 40.

Reference. Little's Law in the ASQ Certified Six Sigma Black Belt body of knowledge (Lean). https://www.asq.org/cert/six-sigma-black-belt

## RPN

Definition. RPN = severity * occurrence * detection, only when all three integers are present. Each score is an integer you enter from 1 to 10.

Assumptions. The scale is the one your FMEA sheet uses. A blank score means a blank RPN. Do not average a missing score into a 1 or a 10.

Worked example. Test vector: severity 8, occurrence 4, detection 5. RPN = 8 * 4 * 5 = 160.

Reference. FMEA RPN in the ASQ Certified Six Sigma Black Belt body of knowledge. https://www.asq.org/cert/six-sigma-black-belt
