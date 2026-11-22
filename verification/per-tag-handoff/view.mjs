export const title = "Per-tag handoffs: own handoff, opener-only rows, merged view on read";
const busy = (v) => Object.values(v.phase).some((p) => p === "in");
export const state = (v) => {
  if (v.refused) return "Write refused, nothing written";
  const anyIn = Object.entries(v.phase).filter(([, p]) => p === "in").map(([t]) => t);
  if (anyIn.length === 0) {
    if (v.hv.hub + v.hv.writer === 0) return "No handoffs yet";
    return v.conflict ? "At rest, row conflict waiting for the hub" : "Handoffs at rest";
  }
  if (v.conflict) return "In session, row conflict waiting for the hub";
  if (anyIn.some((t) => v.epiOpen[t] && v.openAge[t] === 1)) return "In session, open work marked stale (24h)";
  if (anyIn.some((t) => v.epiOpen[t])) return "In session, work shown in progress";
  if (anyIn.some((t) => v.seen[t] !== v.board)) return "In session, board moved since read";
  return "In session, merged view read";
};
export const group = (v) => (v.refused ? "refused" : busy(v) ? "session" : "rest");
export const colors = { refused: "pink", session: "blue", rest: "teal" };
export const step = (a) => ({
  Start: "an AI starts, reads the merged view, and stamps it",
  OpenRow: "a write AI opens a board row",
  PatchOwnRow: "the opener patches its row",
  ForeignRowPatch: "an AI tries to patch a row it did not open",
  ResolveConflict: "the hub resolves a marked row conflict",
  StalePatch: "a write on a moved board is refused",
  SaveMaterial: "a write AI saves work in an open session",
  Tick: "time passes (24 hours open, 7 days aging)",
  WrapOwn: "a write AI writes its own handoff last",
  ForeignWrite: "an AI tries to write another AI's handoff",
  LeaveReadOnly: "a read-only AI leaves, writing nothing",
  Done: null,
}[a] ?? a);
