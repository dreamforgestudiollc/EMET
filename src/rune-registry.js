/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 * Licensed under the MIT License - see LICENSE
 *
 * Active RUNED directives for this process. A GEM that is off is not in
 * this map, so its tools are not registered. The tool name is
 * gem_<gem>__<rune>. A call serves the code. It does not run it.
 */

const active = new Map();
const reserved = new Set();

export function runeToolName(gemId, runeName) {
  return `gem_${gemId}__${runeName}`;
}

export function reserveToolNames(names) {
  for (const name of names) reserved.add(name);
}

export function toolNameReserved(name) {
  return reserved.has(name);
}

/** Replace the active set. Called when the release socket seats GEMs. */
export function bindRunes(list) {
  active.clear();
  for (const rune of list || []) {
    if (!rune || typeof rune.gemId !== 'string' || typeof rune.name !== 'string') continue;
    const tool = runeToolName(rune.gemId, rune.name);
    if (reserved.has(tool)) continue;
    active.set(tool, { ...rune, tool });
  }
}

export function activeRune(name) {
  return active.get(name) || null;
}

export function activeRunes() {
  return [...active.values()];
}

/** The metadata.gem a client sends to seal a result: `<gem>@<version>`. */
export function metadataGemValue(rune) {
  return `${rune.gemId}@${rune.gemVersion}`;
}

/** Sentence the tool list and the served description both state. The value is in backticks so the period is not part of it. */
export function metadataGemClause(rune) {
  return `To seal a result, set metadata.gem to \`${metadataGemValue(rune)}\`.`;
}

/** Tool list entries for directives that are on. Empty when none are. */
export function runeToolList() {
  return activeRunes().map((rune) => ({
    name: rune.tool,
    description: `${rune.description} A call returns the code and does not run it. runtime ${rune.runtime}. served ${rune.sha256}. ${metadataGemClause(rune)}`,
    inputSchema: rune.inputSchema || { type: 'object' },
    outputSchema: rune.outputSchema || { type: 'object' },
    runtime: rune.runtime,
    sha256: rune.sha256,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: !(rune.annotations && rune.annotations.idempotentHint === false),
      openWorldHint: false
    }
  }));
}
