// Pure function of the caller's inputs. Returns numbers. Writes nothing.
// Factor table: NIST/SEMATECH e-Handbook 6.3.2.1, D4 for n = 5 is 2.115.
// Floor only R, moving range, p, np, c, and u. X-bar and individuals stay negative.

const MISSING = "missing-input";
const ASSUMPTION = "assumption-not-checked";
const FLOOR = "lcl-floored-at-zero";
const FACTOR = "factor-out-of-range";

const FACTORS = Object.freeze({
  __proto__: null,
  2: Object.freeze({ __proto__: null, a2: 1.88, d3: 0, d4: 3.267 }),
  3: Object.freeze({ __proto__: null, a2: 1.023, d3: 0, d4: 2.575 }),
  4: Object.freeze({ __proto__: null, a2: 0.729, d3: 0, d4: 2.282 }),
  5: Object.freeze({ __proto__: null, a2: 0.577, d3: 0, d4: 2.115 }),
  6: Object.freeze({ __proto__: null, a2: 0.483, d3: 0, d4: 2.004 }),
  7: Object.freeze({ __proto__: null, a2: 0.419, d3: 0.076, d4: 1.924 }),
  8: Object.freeze({ __proto__: null, a2: 0.373, d3: 0.136, d4: 1.864 }),
  9: Object.freeze({ __proto__: null, a2: 0.337, d3: 0.184, d4: 1.816 }),
  10: Object.freeze({ __proto__: null, a2: 0.308, d3: 0.223, d4: 1.777 }),
});

const CHARTS = Object.freeze({
  __proto__: null,
  "xbar-r": true,
  "i-mr": true,
  p: true,
  np: true,
  c: true,
  u: true,
});

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function push(flags, flag) {
  if (flag && flags.indexOf(flag) < 0) flags.push(flag);
}

function empty(flags, missing, error) {
  return {
    ok: false,
    flags,
    missing,
    wrote: false,
    error,
    center: null,
    ucl: null,
    lcl: null,
    centerR: null,
    uclR: null,
    lclR: null,
    constantsUsed: null,
  };
}

function fail(flags, missing, error) {
  if (missing.length) push(flags, MISSING);
  return empty(flags, missing, error);
}

function floorAtZero(value, flags) {
  if (value < 0) {
    push(flags, FLOOR);
    return 0;
  }
  return value;
}

function constantsFrom(input, missing) {
  const hasA2 = isNum(input.a2);
  const hasD3 = isNum(input.d3);
  const hasD4 = isNum(input.d4);
  const any = hasA2 || hasD3 || hasD4;
  if (any) {
    if (!hasA2) missing.push("a2");
    if (!hasD3) missing.push("d3");
    if (!hasD4) missing.push("d4");
    if (missing.length) return null;
    return { a2: input.a2, d3: input.d3, d4: input.d4, fromTable: false };
  }
  if (!isNum(input.n) || !Number.isInteger(input.n)) return false;
  const key = String(input.n);
  if (!Object.hasOwn(FACTORS, key)) return false;
  return { a2: FACTORS[key].a2, d3: FACTORS[key].d3, d4: FACTORS[key].d4, fromTable: true };
}

export function run(input) {
  const flags = [];
  const missing = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    missing.push("chart");
    return fail(flags, missing, "Missing chart.");
  }
  const chart = String(input.chart);
  if (!Object.hasOwn(CHARTS, chart)) {
    missing.push("chart");
    return fail(flags, missing, "Missing chart.");
  }

  if (chart === "xbar-r") {
    if (!isNum(input.xDoubleBar)) missing.push("xDoubleBar");
    if (!isNum(input.rBar)) missing.push("rBar");
    const constants = constantsFrom(input, missing);
    if (constants === false) {
      if (isNum(input.n)) push(flags, FACTOR);
      else missing.push("n");
      const error = isNum(input.n)
        ? "Subgroup size is outside the factor table."
        : "Missing " + missing.join(", ") + ".";
      return fail(flags, missing, error);
    }
    if (missing.length || constants === null) {
      return fail(flags, missing, "Missing " + missing.join(", ") + ".");
    }
    if (!(input.rBar >= 0)) {
      missing.push("rBar");
      return fail(flags, missing, "rBar must be greater than or equal to 0.");
    }
    const span = constants.a2 * input.rBar;
    push(flags, ASSUMPTION);
    return {
      ok: true,
      flags,
      missing,
      wrote: false,
      error: null,
      center: input.xDoubleBar,
      ucl: input.xDoubleBar + span,
      lcl: input.xDoubleBar - span,
      centerR: input.rBar,
      uclR: constants.d4 * input.rBar,
      lclR: floorAtZero(constants.d3 * input.rBar, flags),
      constantsUsed: constants,
    };
  }

  if (chart === "i-mr") {
    if (!isNum(input.xBar)) missing.push("xBar");
    if (!isNum(input.mrBar)) missing.push("mrBar");
    if (missing.length) {
      return fail(flags, missing, "Missing " + missing.join(", ") + ".");
    }
    if (!(input.mrBar >= 0)) {
      missing.push("mrBar");
      return fail(flags, missing, "mrBar must be greater than or equal to 0.");
    }
    const half = (3 * input.mrBar) / 1.128;
    const constants = { d2: 1.128, d4: 3.267, fromTable: true };
    push(flags, ASSUMPTION);
    return {
      ok: true,
      flags,
      missing,
      wrote: false,
      error: null,
      center: input.xBar,
      ucl: input.xBar + half,
      lcl: input.xBar - half,
      centerR: input.mrBar,
      uclR: 3.267 * input.mrBar,
      lclR: 0,
      constantsUsed: constants,
    };
  }

  if (chart === "c") {
    if (!isNum(input.cBar)) {
      missing.push("cBar");
      return fail(flags, missing, "Missing cBar.");
    }
    if (!(input.cBar >= 0)) {
      missing.push("cBar");
      return fail(flags, missing, "cBar must be greater than or equal to 0.");
    }
    const band = 3 * Math.sqrt(input.cBar);
    push(flags, ASSUMPTION);
    return {
      ok: true,
      flags,
      missing,
      wrote: false,
      error: null,
      center: input.cBar,
      ucl: input.cBar + band,
      lcl: floorAtZero(input.cBar - band, flags),
      centerR: null,
      uclR: null,
      lclR: null,
      constantsUsed: null,
    };
  }

  if (!isNum(input.n) || !(input.n > 0)) missing.push("n");
  if (chart === "u") {
    if (!isNum(input.uBar)) missing.push("uBar");
  } else if (!isNum(input.pBar)) {
    missing.push("pBar");
  }
  if (missing.length) {
    return fail(flags, missing, "Missing " + missing.join(", ") + ".");
  }
  if (chart !== "u" && (input.pBar < 0 || input.pBar > 1)) {
    missing.push("pBar");
    return fail(flags, missing, "pBar must be between 0 and 1.");
  }
  if (chart === "u" && !(input.uBar >= 0)) {
    missing.push("uBar");
    return fail(flags, missing, "uBar must be greater than or equal to 0.");
  }

  let center = null;
  let band = null;
  if (chart === "p") {
    center = input.pBar;
    band = 3 * Math.sqrt((input.pBar * (1 - input.pBar)) / input.n);
  } else if (chart === "np") {
    center = input.n * input.pBar;
    band = 3 * Math.sqrt(input.n * input.pBar * (1 - input.pBar));
  } else {
    center = input.uBar;
    band = 3 * Math.sqrt(input.uBar / input.n);
  }
  push(flags, ASSUMPTION);
  return {
    ok: true,
    flags,
    missing,
    wrote: false,
    error: null,
    center,
    ucl: center + band,
    lcl: floorAtZero(center - band, flags),
    centerR: null,
    uclR: null,
    lclR: null,
    constantsUsed: null,
  };
}
