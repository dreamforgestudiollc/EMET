## Assumption flags

Name the assumptions a result needs before the result is used. If an assumption was not checked, say it was not checked. Do not treat an unchecked assumption as if it held. Do not invent a test result to paper over a gap.

These are the flags this package uses. Attach the ones that apply. Leave the others off the result.

### Normal model

Cp, Cpk, Pp, Ppk, and the z interval use a normal model when you want the handbook meaning of the index. Say whether you checked normality. If you did not, write "normality not checked". NIST/SEMATECH e-Handbook section 6.1.6 states that those capability indexes assume a normal distribution, and that the sample should be large. This package does not run a normality test for you.

### Stable process

Capability and control limits describe a process whose mean and spread are steady over the data you used. If the chart is not stable, or you did not look, write "stability not checked". Do not quote a Cpk from a data set you already called unstable.

### Sigma kind

Within-subgroup sigma (from a rational subgroup, often R-bar / d2) and overall sigma (the standard deviation of all individuals) are different inputs. Cp and Cpk take the within sigma when that is what you claim. Pp and Ppk take the overall sigma. If the label and the formula disagree, write "sigma label mismatch" and do not relabel the input.

### Independence

t, chi-square, ANOVA, and regression treat observations as independent unless you say otherwise. Paired data are not two independent samples. Write "pairing" when the row is a pair, and use a paired method. This version names the paired t and does not work that statistic. See the hypothesis selection guide.

### Equal variance

Two-sample t and one-way ANOVA are sensitive to unequal spread. Write "equal variance not checked" unless you checked it. This version works the one-way ANOVA sums of squares and does not test the variances for you.

### Binomial or Poisson

A p chart and an np chart use a binomial model: a unit conforms or it does not, trials are independent, and the subgroup size is the n you used. A c chart and a u chart use a Poisson model: counts, and a constant area of opportunity for a c chart. NIST/SEMATECH sections 6.3.3.1 and 6.3.3.2 are the references. If the opportunity changes and you used a c chart, say so and consider a u chart.

### Sample size and the margin of error

The sample-size formulas in this package are normal approximations for a margin of error. They are not a power calculation for a hypothesis test. Write "margin of error, not power" on the plan.

### Small n and zero spread

Regression with fewer than three points still returns a fit when the x values are not all equal, and you flag small n. If every x is equal, there is no slope. Do not report one.

### Critical values and p-values

This version returns a t statistic, a chi-square statistic, ANOVA sums of squares and F, and a regression fit. It does not return a p-value. A critical value is used only when you supply it. The package does not look up a t table for you.

### Illustrations

Worked examples and filled template rows are illustrations. They are not your process. Copy the arithmetic shape. Supply your own inputs.
