// Pure function of the caller's inputs. Returns numbers. Writes nothing.

const MISSING = "missing-input";
const ASSUMPTION = "assumption-not-checked";

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function push(flags, flag) {
  if (flag && flags.indexOf(flag) < 0) flags.push(flag);
}

function ceilToInt(value) {
  const nearest = Math.round(value);
  if (Math.abs(value - nearest) < 1e-9) return nearest;
  return Math.ceil(value);
}

function blank(flags, missing, error) {
  return {
    ok: false,
    flags,
    missing,
    wrote: false,
    error,
    n: null,
    marginOfError: false,
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
    missing.push("kind", "z", "e");
    return fail(flags, missing, "Missing kind, z, e.");
  }
  if (input.kind !== "proportion" && input.kind !== "mean") missing.push("kind");
  if (!isNum(input.z)) missing.push("z");
  if (!isNum(input.e)) missing.push("e");
  if (missing.length) {
    return fail(flags, missing, "Missing " + missing.join(", ") + ".");
  }
  if (!(input.e > 0)) {
    missing.push("e");
    return fail(flags, missing, "e must be greater than 0.");
  }

  let raw = null;
  if (input.kind === "proportion") {
    if (!isNum(input.p) || input.p < 0 || input.p > 1) {
      missing.push("p");
      return fail(flags, missing, "p must be between 0 and 1.");
    }
    raw = (input.z * input.z * input.p * (1 - input.p)) / (input.e * input.e);
  } else {
    if (!isNum(input.sigma) || !(input.sigma > 0)) {
      missing.push("sigma");
      return fail(flags, missing, "sigma must be greater than 0.");
    }
    const ratio = (input.z * input.sigma) / input.e;
    raw = ratio * ratio;
  }

  push(flags, ASSUMPTION);
  return {
    ok: true,
    flags,
    missing,
    wrote: false,
    error: null,
    n: ceilToInt(raw),
    marginOfError: true,
  };
}
