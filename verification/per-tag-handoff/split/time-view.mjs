/** Reader labels for the time half. No board. */

export const title = "Open work, stale-open, and aging";

export const state = (v) => {
  if (v.refused) return "Write refused, nothing written";
  const inside = Object.entries(v.phase).filter(([, p]) => p === "in").map(([t]) => t);
  if (inside.length === 0) {
    if (v.hv === 0) return "No handoff yet";
    return v.hage === 1 ? "Handoff at rest, line aging" : "Handoff at rest";
  }
  if (inside.some((t) => v.epiOpen[t] && v.openAge[t] === 1)) return "In session, open work marked stale";
  if (inside.some((t) => v.epiOpen[t])) return "In session, work shown in progress";
  if (inside.some((t) => v.viewClass[t] === "aging")) return "In session, reading an aging line";
  return "In session, merged view read";
};

export const step = (action) => {
  const labels = {
    Start: "an AI starts, reads the view, and stamps it",
    SaveMaterial: "a write AI saves work in an open session",
    Tick: "time passes (24 hours open, 7 days aging)",
    WrapOwn: "a write AI writes its own handoff last",
    ForeignWrite: null,
    LeaveReadOnly: "a read-only AI leaves, writing nothing",
    Done: null
  };
  return Object.prototype.hasOwnProperty.call(labels, action) ? labels[action] : null;
};

export const group = (v) => (v.refused ? "refused" : Object.values(v.phase).some((p) => p === "in") ? "session" : "rest");

export const colors = { refused: "pink", session: "blue", rest: "teal" };
