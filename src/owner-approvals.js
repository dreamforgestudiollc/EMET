/**
 * Owner approvals — retired by R4.
 *
 * Superseded by /owner/chooser. This path stays mounted so an old bookmark
 * answers with a pointer instead of disappearing. Sub-key records are not
 * deleted and are not rewritten. Pending rows are listed on the chooser.
 * ISO 9001 7.5.3 / ISO 13485 4.2.5: supersede, retire, retain.
 *
 * The passphrase session is an owner factor, not a writer grant
 * (grants.js OWNER_PAGE). This file does not stamp writes.
 */

import { OWNER_APPROVALS_RETIRED } from './grants.js';
import { sendHtml } from './owner-session.js';

export { SESSION_MS } from './owner-session.js';

function retiredBody() {
  const next = OWNER_APPROVALS_RETIRED.superseded_by;
  return `<h1>Owner approvals retired</h1>
<p>This page was retired by R4. It is superseded by <a href="${next}">${next}</a>. Pending sub-keys are listed there. Records are retained. Nothing was deleted.</p>
<p>ISO 9001 7.5.3 / ISO 13485 4.2.5. Break-glass recovery is <a href="/owner/break-glass">/owner/break-glass</a>.</p>`;
}

function retired(req, res) {
  res.locals.reason = 'owner_approvals_retired';
  sendHtml(res, 410, retiredBody(), 'EMET owner approvals');
}

/**
 * @param {import('express').Express} app
 * @param {object} [_options] kept so the Railway EMET mount stays the same call.
 */
export function mountOwnerApprovals(app, _options = {}) {
  app.get('/owner/approvals', retired);
  app.post('/owner/approvals/login', retired);
  app.post('/owner/approvals/decide', retired);
}
