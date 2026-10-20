// Pure function of the caller's inputs. Returns numbers. Writes nothing.

const MISSING = "missing-input";
const ASSUMPTION = "assumption-not-checked";
const LABEL = "sigma-label-mismatch";

const WITHIN = Object.freeze({
  __proto__: null,
  cp: true,
  cpk: true,
  cpu: true,
  cpl: true,
});
const OVERALL = Object.freeze({
  __proto__: null,
  pp: true,
  ppk: true,
});

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
    value: null,
    sigmaUsed: null,
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
    missing.push("index", "sigmaKind");
    return fail(flags, missing, "Missing index, sigmaKind.");
  }

  const index = String(input.index);
  const sigmaKind = input.sigmaKind;
  if (!Object.hasOwn(WITHIN, index) && !Object.hasOwn(OVERALL, index)) missing.push("index");
  if (sigmaKind !== "within" && sigmaKind !== "overall") missing.push("sigmaKind");
  if (missing.length) {
    return fail(flags, missing, "Missing " + missing.join(", ") + ".");
  }

  const hasSigma = isNum(input.sigma);
  const hasRange = isNum(input.rBar) || isNum(input.d2);
  if (hasSigma && hasRange) {
    missing.push("sigma", "rBar", "d2");
    return fail(flags, missing, "Pass sigma or the range pair, not both.");
  }

  let sigmaUsed = null;
  if (hasSigma) {
    if (!(input.sigma > 0)) {
      missing.push("sigma");
      return fail(flags, missing, "sigma must be greater than 0.");
    }
    sigmaUsed = input.sigma;
  } else if (isNum(input.rBar) && isNum(input.d2)) {
    if (!(input.d2 > 0) || !(input.rBar / input.d2 > 0)) {
      missing.push("rBar", "d2");
      return fail(flags, missing, "sigma must be greater than 0.");
    }
    sigmaUsed = input.rBar / input.d2;
  } else {
    if (!isNum(input.rBar)) missing.push("rBar");
    if (!isNum(input.d2)) missing.push("d2");
    if (!hasRange) missing.push("sigma");
    return fail(flags, missing, "Missing " + missing.join(", ") + ".");
  }

  const need = [];
  if (index === "cp" || index === "pp" || index === "cpk" || index === "ppk" || index === "cpl") {
    if (!isNum(input.lsl)) need.push("lsl");
  }
  if (index === "cp" || index === "pp" || index === "cpk" || index === "ppk" || index === "cpu") {
    if (!isNum(input.usl)) need.push("usl");
  }
  if (index === "cpk" || index === "ppk" || index === "cpu" || index === "cpl") {
    if (!isNum(input.mean)) need.push("mean");
  }
  if (need.length) {
    return fail(flags, need, "Missing " + need.join(", ") + ".");
  }

  if (isNum(input.usl) && isNum(input.lsl) && input.usl < input.lsl) {
    return fail(flags, [], "USL is below LSL.");
  }

  const expected = Object.hasOwn(WITHIN, index) ? "within" : "overall";
  if (sigmaKind !== expected) push(flags, LABEL);

  let value = null;
  if (index === "cp" || index === "pp") {
    value = (input.usl - input.lsl) / (6 * sigmaUsed);
  } else if (index === "cpu") {
    value = (input.usl - input.mean) / (3 * sigmaUsed);
  } else if (index === "cpl") {
    value = (input.mean - input.lsl) / (3 * sigmaUsed);
  } else {
    const cpu = (input.usl - input.mean) / (3 * sigmaUsed);
    const cpl = (input.mean - input.lsl) / (3 * sigmaUsed);
    value = Math.min(cpu, cpl);
  }

  push(flags, ASSUMPTION);
  return {
    ok: true,
    flags,
    missing,
    wrote: false,
    error: null,
    value,
    sigmaUsed,
  };
}
