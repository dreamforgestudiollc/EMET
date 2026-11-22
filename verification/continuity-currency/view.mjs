/** Reader labels for the continuity-currency tip-lag chart. Episodic ids are not drawn. */

export const title = "Continuity currency";

export const state = (v) => {
  if (v.phase === "GateOff") return "Gate off";
  if (v.phase === "Comparing") return "Comparing";
  if (v.phase === "Current") return "Current";
  if (v.phase === "DocumentedNoOp") return "Documented no-op";
  if (v.phase === "Warning") return "Warning, does not block";
  if (v.phase === "BlockHeld") return "Block asked, still open";
  if (v.phase === "NoHandoff") return "No handoff";
  if (v.phase === "Unreadable") return "Unreadable";
  if (v.phase === "FallbackOnly") return "Fallback only, does not block";
  if (v.phase === "FallbackHeld") return "Block asked of a fallback, still open";
  return v.phase;
};

export const step = (action) => {
  const labels = {
    FlagStaysOff: "warn flag stays off",
    EnableWarn: "warn flag on",
    SeeCurrent: "handoff cites the live material tip",
    SeeNoOp: "documented no-op, no newer material tip",
    SeeScratch: "newer episodic is scratch or diagnosis only",
    SeeVersionOnly: "version number alone",
    SeeLag: "material tip is newer",
    SeeFallback: "only a fallback tip is newer",
    SeeNoHandoff: "no handoff to compare",
    SeeUnreadable: "the comparison could not be read",
    AskBlock: "block asked, still does not block",
    AskBlockOnFallback: "block asked, still does not block",
    CompareAgain: "the next initialize compares again"
  };
  return labels[action] ?? null;
};

export const group = (v) => {
  if (v.phase === "Warning" || v.phase === "BlockHeld") return "warn";
  if (v.phase === "FallbackOnly" || v.phase === "FallbackHeld") return "fallback";
  if (v.phase === "NoHandoff" || v.phase === "Unreadable") return "missing";
  if (v.phase === "GateOff") return "off";
  if (v.phase === "Comparing") return "compare";
  return "clear";
};

export const colors = {
  off: "tan",
  compare: "blue",
  clear: "teal",
  warn: "orange",
  fallback: "yellow",
  missing: "purple"
};
