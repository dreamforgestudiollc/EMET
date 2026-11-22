export const title = "Per-tag handoffs: write, merge on read, init";
const busy = (v) => Object.values(v.phase).some((p) => p === "in");
export const state = (v) => {
  const anyIn = Object.entries(v.phase).filter(([, p]) => p === "in").map(([t]) => t);
  if (v.refused) return "Write refused, nothing written";
  if (anyIn.length === 0) return (v.hv.hub + v.hv.writer === 0) ? "No handoffs yet" : "Handoffs at rest";
  const stale = anyIn.some((t) => v.seen[t] !== v.board);
  return stale ? "In session, board moved since read" : "In session, merged view read";
};
export const group = (v) => (v.refused ? "refused" : busy(v) ? "session" : "rest");
export const colors = { refused: "pink", session: "blue", rest: "teal" };
export const step = (a) => ({
  Start: "an AI starts and reads the merged view and the board",
  PatchBoard: "a write AI patches the board it read",
  StalePatch: "a patch on a moved board is refused",
  WrapOwn: "a write AI writes its own handoff last",
  ForeignWrite: "an AI tries to write another AI's handoff",
  LeaveReadOnly: "a read-only AI leaves, writing nothing",
  Done: null,
}[a] ?? a);
