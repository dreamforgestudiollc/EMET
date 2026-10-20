// Pure function of the caller's inputs. Returns numbers. Writes nothing.

const MISSING = "missing-input";
const SIGMA = "sigma-not-computed";

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function push(flags, flag) {
  if (flag && flags.indexOf(flag) < 0) flags.push(flag);
}

function blank(flags, missing, error) {
  return {
    ok: false,
    flags,
    missing,
    wrote: false,
    error,
    dpo: null,
    dpmo: null,
    opportunityYield: null,
  };
}

function fail(flags, missing, error) {
  if (missing.length) push(flags, MISSING);
  return blank(flags, missing, error);
}

export function run(input) {
  const flags = [];
  const missing = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    missing.push("defects", "units", "opportunitiesPerUnit");
    return fail(flags, missing, "Missing defects, units, opportunitiesPerUnit.");
  }

  if (!isNum(input.defects)) missing.push("defects");
  if (!isNum(input.units)) missing.push("units");
  if (!isNum(input.opportunitiesPerUnit)) missing.push("opportunitiesPerUnit");
  if (missing.length) {
    return fail(flags, missing, "Missing " + missing.join(", ") + ".");
  }

  const problems = [];
  if (!(input.defects >= 0)) {
    missing.push("defects");
    problems.push("defects must be greater than or equal to 0");
  }
  if (!(input.units > 0)) {
    missing.push("units");
    problems.push("units must be greater than 0");
  }
  if (!(input.opportunitiesPerUnit > 0)) {
    missing.push("opportunitiesPerUnit");
    problems.push("opportunities per unit must be greater than 0");
  }
  if (problems.length) {
    return fail(flags, missing, problems.join(". ") + ".");
  }

  const dpo = input.defects / (input.units * input.opportunitiesPerUnit);
  const opportunityYield = 1 - dpo;
  if (opportunityYield < 0 || opportunityYield > 1) {
    return fail(flags, [], "Opportunity yield is outside 0 to 1.");
  }

  push(flags, SIGMA);
  return {
    ok: true,
    flags,
    missing,
    wrote: false,
    error: null,
    dpo,
    dpmo: dpo * 1000000,
    opportunityYield,
  };
}
