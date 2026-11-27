/**
 * Authorize doors and the diagrams served at /statechart.
 *
 * Each picture is the same text as its module and its doc. The page is
 * computed on read. It is not a record.
 */

import { CONTINUITY_CURRENCY_MERMAID, CONTINUITY_CURRENCY_STEPS } from './continuity-currency-statechart.js';
import { PER_TAG_HANDOFF_MERMAID, PER_TAG_TIME_MERMAID, PER_TAG_HANDOFF_STEPS } from './per-tag-handoff-statechart.js';
import { SUBKEY_SESSION_MERMAID, SUBKEY_SESSION_STEPS } from './subkey-session-statechart.js';
import { RELOAD_AFTER_COMPACTION_MERMAID, RELOAD_AFTER_COMPACTION_STEPS } from './reload-after-compaction-statechart.js';
import { SOURCE_SAVE_MERMAID, SOURCE_SAVE_STEPS } from './source-save-statechart.js';
import { KEY_DOOR_MERMAID, KEY_DOOR_STEPS } from './key-door-statechart.js';
import { CONSOLE_MERMAID, CONSOLE_STEPS } from './console-statechart.js';
import { CONDENSE_MERMAID, CONDENSE_STEPS } from './condense-statechart.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function section(title, prose, steps, charts) {
  const items = (steps || []).map((line) => `<li>${esc(line)}</li>`).join('\n');
  const pictures = (charts || []).map((chart) => `<pre>${esc(chart)}</pre>`).join('\n');
  return `<h2>${esc(title)}</h2>
<p>${prose}</p>
<ol>
${items}
</ol>
${pictures}`;
}

export function statechartBody() {
  return [
    section(
      'Continuity currency',
      'This is the tip-lag gate on emet_initialize. It compares the served handoff with the material episodic tip. A lag returns a warning. The call is not blocked. The handoff and the board are not rewritten.',
      CONTINUITY_CURRENCY_STEPS,
      [CONTINUITY_CURRENCY_MERMAID]
    ),
    section(
      'Per-tag handoffs',
      'Off unless EMET_TAG_HANDOFFS is warn or enforce. The shared view is computed on read and is not stored.',
      PER_TAG_HANDOFF_STEPS,
      [PER_TAG_HANDOFF_MERMAID, PER_TAG_TIME_MERMAID]
    ),
    section(
      'Sub-key sessions',
      'One live session per key. Inside the last hour, and for one grace window after the handle expires, a renewal presents the sub-key and the current handle. The old session closes into the new one. Past the grace window the sweep records auto_closed. The row stays.',
      SUBKEY_SESSION_STEPS,
      [SUBKEY_SESSION_MERMAID]
    ),
    section(
      'Unregistered source saves',
      'A save whose source is an exact member of the transcript registry is stored. An unregistered source is stored until the cutoff and the receipt names that date. On the cutoff date, America/New_York, the save is refused with EMET-MEM-035 and nothing is written. A row already stored, including a pre-attribution row, stays readable.',
      SOURCE_SAVE_STEPS,
      [SOURCE_SAVE_MERMAID]
    ),
    section(
      'Reload after compaction',
      'After any compaction or summary, the host re-runs emet_initialize for every page and works from HANDOFF and STATE. The rule is on every initialize. The checks run when EMET_CONTINUITY_CURRENCY is 1. A skipped reload warns and does not block. HANDOFF and STATE are not rewritten. Nothing is deleted. EMET_CONTINUITY_CURRENCY_BLOCK stays inert.',
      RELOAD_AFTER_COMPACTION_STEPS,
      [RELOAD_AFTER_COMPACTION_MERMAID]
    ),
    section(
      'Key sign-in',
      'The primary owner signs in with the connect passphrase. A secondary owner signs in with that passphrase and a sub-key. A bot, a member, or a guest signs in with the sub-key and the source tag on that key. A key session writes as that tag. It does not receive owner rights.',
      KEY_DOOR_STEPS,
      [KEY_DOOR_MERMAID]
    ),
    section(
      'EMET Console',
      'The console is a separate app. The owner signs in with the admin password. A key signs in through the key door and is refused on every owner view with EMET-AUTH-046. Remember this phone is a tick box on this server\'s sign-in page, unticked unless the person ticks it. A note is saved through the same dispatch path as the tools, tagged emet-console. The console mints no key and no invite.',
      CONSOLE_STEPS,
      [CONSOLE_MERMAID]
    ),
    section(
      'Condensing a document',
      'A write under half the size this session first saw is refused (EMET-DOC-025). The owner door, or a writer approval the owner has granted, can write the short revision when the call passes condense_approved and a reason. A bot or a sub-key without that approval is still refused. The owner password is not that approval. The prior revision stays in documents_history.',
      CONDENSE_STEPS,
      [CONDENSE_MERMAID]
    )
  ].join('\n');
}
