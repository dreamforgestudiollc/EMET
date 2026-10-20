// Pure function of the caller's inputs. Returns numbers. Writes nothing.
// This version does not return a p-value.

const MISSING = "missing-input";
const ASSUMPTION = "assumption-not-checked";
const SMALL = "small-n";
const ZERO = "zero-variance";

const TESTS = Object.freeze({
  __proto__: null,
  "one-sample-t": true,
  "chi-square-gof": true,
  "anova-oneway": true,
  "simple-regression": true,
  "z-interval": true,
  "t-interval": true,
});

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function push(flags, flag) {
  if (flag && flags.indexOf(flag) < 0) flags.push(flag);
}

function shell(flags, missing, ok, error) {
  return {
    ok,
    flags,
    missing,
    wrote: false,
    error,
    t: null,
    df: null,
    exceedsCritical: null,
    chiSquare: null,
    grandMean: null,
    groupMeans: null,
    ssb: null,
    ssw: null,
    msb: null,
    msw: null,
    f: null,
    dfBetween: null,
    dfWithin: null,
    slope: null,
    intercept: null,
    r2: null,
    low: null,
    high: null,
  };
}

function refuse(flags, missing, error) {
  if (missing.length) push(flags, MISSING);
  return shell(flags, missing, false, error);
}

function nums(list) {
  return Array.isArray(list) && list.length > 0 && list.every(isNum);
}

function sampleN(input, missing) {
  if (!Number.isInteger(input.n) || !(input.n >= 2)) {
    missing.push("n");
    return false;
  }
  return true;
}

export function run(input) {
  const flags = [];
  const missing = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    missing.push("test");
    return refuse(flags, missing, "Missing test.");
  }
  const test = String(input.test);
  if (!Object.hasOwn(TESTS, test)) {
    missing.push("test");
    return refuse(flags, missing, "Missing test.");
  }

  if (test === "one-sample-t") {
    if (!isNum(input.xBar)) missing.push("xBar");
    if (!isNum(input.mu0)) missing.push("mu0");
    if (!isNum(input.s)) missing.push("s");
    if (!isNum(input.n)) missing.push("n");
    if (missing.length) {
      return refuse(flags, missing, "Missing " + missing.join(", ") + ".");
    }
    if (!(input.s > 0)) {
      missing.push("s");
      return refuse(flags, missing, "s must be greater than 0.");
    }
    if (!sampleN(input, missing)) {
      return refuse(flags, missing, "n must be an integer of 2 or more.");
    }
    const t = (input.xBar - input.mu0) / (input.s / Math.sqrt(input.n));
    const df = input.n - 1;
    let exceedsCritical = null;
    if (Object.hasOwn(input, "tCrit")) {
      if (!isNum(input.tCrit)) {
        missing.push("tCrit");
        return refuse(flags, missing, "Missing tCrit.");
      }
      exceedsCritical = Math.abs(t) > input.tCrit;
    }
    push(flags, ASSUMPTION);
    return {
      ...shell(flags, missing, true, null),
      t,
      df,
      exceedsCritical,
    };
  }

  if (test === "chi-square-gof") {
    if (!nums(input.observed)) missing.push("observed");
    if (!nums(input.expected)) missing.push("expected");
    if (!isNum(input.parametersEstimated)) missing.push("parametersEstimated");
    if (missing.length) {
      return refuse(flags, missing, "Missing " + missing.join(", ") + ".");
    }
    if (input.observed.length !== input.expected.length) {
      missing.push("expected");
      return refuse(flags, missing, "observed and expected must be the same length.");
    }
    if (input.expected.some((value) => !(value > 0))) {
      missing.push("expected");
      return refuse(flags, missing, "Each expected count must be greater than 0.");
    }
    const df = input.observed.length - 1 - input.parametersEstimated;
    if (!(df > 0)) {
      return refuse(flags, missing, "Degrees of freedom must be greater than 0.");
    }
    let chi = 0;
    for (let i = 0; i < input.observed.length; i += 1) {
      const observed = input.observed.at(i);
      const expected = input.expected.at(i);
      const diff = observed - expected;
      chi += (diff * diff) / expected;
    }
    push(flags, ASSUMPTION);
    return {
      ...shell(flags, missing, true, null),
      df,
      chiSquare: chi,
    };
  }

  if (test === "anova-oneway") {
    const groups = input.groups;
    if (!Array.isArray(groups) || groups.length < 2 || !groups.every(nums)) {
      missing.push("groups");
      return refuse(flags, missing, "Missing groups.");
    }
    const flat = groups.flat();
    const grand = flat.reduce((sum, value) => sum + value, 0) / flat.length;
    const means = groups.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
    let ssb = 0;
    let ssw = 0;
    groups.forEach((group, index) => {
      const mean = means.at(index);
      ssb += group.length * (mean - grand) * (mean - grand);
      group.forEach((value) => {
        ssw += (value - mean) * (value - mean);
      });
    });
    const dfBetween = groups.length - 1;
    const dfWithin = flat.length - groups.length;
    let ok = dfWithin > 0;
    let error = null;
    let msb = null;
    let msw = null;
    let f = null;
    if (!(dfWithin > 0)) {
      push(flags, ZERO);
      ok = false;
      error = "Degrees of freedom must be greater than 0.";
    } else {
      msb = ssb / dfBetween;
      msw = ssw / dfWithin;
      f = msw === 0 ? null : msb / msw;
      if (msw === 0) {
        push(flags, ZERO);
        ok = false;
        error = "Mean square within is 0.";
      }
      if (ok) push(flags, ASSUMPTION);
    }
    return {
      ...shell(flags, missing, ok, error),
      grandMean: grand,
      groupMeans: means,
      ssb,
      ssw,
      msb,
      msw,
      f,
      dfBetween,
      dfWithin,
    };
  }

  if (test === "simple-regression") {
    if (!nums(input.x)) missing.push("x");
    if (!nums(input.y)) missing.push("y");
    if (missing.length) {
      return refuse(flags, missing, "Missing " + missing.join(", ") + ".");
    }
    if (input.x.length !== input.y.length) {
      missing.push("y");
      return refuse(flags, missing, "x and y must be the same length.");
    }
    const n = input.x.length;
    const xBar = input.x.reduce((sum, value) => sum + value, 0) / n;
    const yBar = input.y.reduce((sum, value) => sum + value, 0) / n;
    let num = 0;
    let den = 0;
    let tss = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = input.x.at(i) - xBar;
      const y = input.y.at(i);
      num += dx * (y - yBar);
      den += dx * dx;
      const dy = y - yBar;
      tss += dy * dy;
    }
    if (den === 0) {
      push(flags, ZERO);
      return shell(flags, missing, false, "The x values have no spread.");
    }
    const slope = num / den;
    const intercept = yBar - slope * xBar;
    let rss = 0;
    for (let i = 0; i < n; i += 1) {
      const residual = input.y.at(i) - (intercept + slope * input.x.at(i));
      rss += residual * residual;
    }
    const r2 = tss === 0 ? 1 : 1 - rss / tss;
    if (n < 3) push(flags, SMALL);
    push(flags, ASSUMPTION);
    return {
      ...shell(flags, missing, true, null),
      slope,
      intercept,
      r2,
    };
  }

  if (test === "z-interval") {
    if (!isNum(input.xBar)) missing.push("xBar");
    if (!isNum(input.sigma)) missing.push("sigma");
    if (!isNum(input.n)) missing.push("n");
    if (!isNum(input.z)) missing.push("z");
    if (missing.length) {
      return refuse(flags, missing, "Missing " + missing.join(", ") + ".");
    }
    if (!(input.sigma > 0)) {
      missing.push("sigma");
      return refuse(flags, missing, "sigma must be greater than 0.");
    }
    if (!sampleN(input, missing)) {
      return refuse(flags, missing, "n must be an integer of 2 or more.");
    }
    const margin = input.z * (input.sigma / Math.sqrt(input.n));
    push(flags, ASSUMPTION);
    return {
      ...shell(flags, missing, true, null),
      low: input.xBar - margin,
      high: input.xBar + margin,
    };
  }

  if (!isNum(input.xBar)) missing.push("xBar");
  if (!isNum(input.s)) missing.push("s");
  if (!isNum(input.n)) missing.push("n");
  if (!isNum(input.tCrit)) missing.push("tCrit");
  if (missing.length) {
    return refuse(flags, missing, "Missing " + missing.join(", ") + ".");
  }
  if (!(input.s > 0)) {
    missing.push("s");
    return refuse(flags, missing, "s must be greater than 0.");
  }
  if (!sampleN(input, missing)) {
    return refuse(flags, missing, "n must be an integer of 2 or more.");
  }
  const margin = input.tCrit * (input.s / Math.sqrt(input.n));
  push(flags, ASSUMPTION);
  return {
    ...shell(flags, missing, true, null),
    low: input.xBar - margin,
    high: input.xBar + margin,
  };
}
