/** Reader labels for the conflict half. No clock. */

export const title = "Who may patch a board row";

export const state = (v) => {
  if (v.refused) return "Write refused, nothing written";
  const inside = Object.entries(v.phase).filter(([, p]) => p === "in").map(([t]) => t);
  if (inside.length === 0) {
    if (v.hv.hub + v.hv.writer === 0) return "No handoffs yet";
    return v.conflict ? "At rest, row conflict waiting for the hub" : "Handoffs at rest";
  }
  if (v.conflict) return "In session, row conflict waiting for the hub";
  if (inside.some((t) => v.seen[t] !== v.board)) return "In session, board moved since read";
  return "In session, merged view read";
};

export const step = (action) => {
  const labels = {
    Start: "an AI starts and reads the view",
    OpenRow: "a write AI opens a board row",
    PatchOwnRow: "the opener patches its row",
    ForeignRowPatch: "an AI tries to patch a row it did not open",
    ResolveConflict: "the hub resolves a marked conflict",
    StalePatch: "a write on a moved board is refused",
    WrapOwn: "a write AI writes its own handoff last",
    ForeignWrite: "an AI tries to write another AI's handoff",
    Done: null
  };
  return Object.prototype.hasOwnProperty.call(labels, action) ? labels[action] : null;
};

export const group = (v) => (v.refused ? "refused" : Object.values(v.phase).some((p) => p === "in") ? "session" : "rest");

export const colors = { refused: "pink", session: "blue", rest: "teal" };
