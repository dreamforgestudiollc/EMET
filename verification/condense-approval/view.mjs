/** Reader labels for an owner-approved condense. */

export const title = "Condensing a document";

export const state = (v) => {
  if (v.phase === "start") return "Full document";
  if (v.phase === "refused") return "Refused";
  if (v.phase === "pending_approval") return "Pending approval";
  if (v.phase === "approved_written") return "Approved and written";
  return v.phase;
};

export const step = (action, from, to) => {
  if (action === "Done") return null;
  if (to.phase === "refused" && to.flag === "off") return "you send a shorter document";
  if (to.phase === "refused" && to.actor === "bot") return "a bot asks, with no owner approval";
  if (to.phase === "pending_approval" && to.approval === "other") return "the approval names another document";
  if (to.phase === "pending_approval" && to.reason === "empty") return "the reason is missing";
  if (to.phase === "pending_approval") return "the owner has not approved it";
  if (to.phase === "approved_written" && to.actor === "owner") return "the owner writes the short revision";
  if (to.phase === "approved_written") return "a named approval writes the short revision, no access code and no client door";
  return null;
};

export const group = (v) => {
  if (v.phase === "refused") return "refused";
  if (v.phase === "pending_approval") return "waiting";
  if (v.phase === "approved_written") return "kept";
  return "start";
};

export const colors = {
  start: "blue",
  refused: "orange",
  waiting: "yellow",
  kept: "teal"
};
