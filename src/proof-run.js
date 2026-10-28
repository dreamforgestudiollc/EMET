/**
 * Last R7 proof-run status.
 *
 * Operational metric for this process, in the same family as the owl
 * retirement and rotate-all lines. The controlled record is the proof pack
 * under docs/proof/R7/ in the EMET-private repo. This module does not write
 * the memory store, does not mint a grant, and does not rotate credentials.
 * A fresh process reports not_run. Railway EMET therefore reports not_run
 * until a harness run is recorded in that process.
 *
 * ISO 9001 7.5.3 / ISO 13485 4.2.5: a later run does not delete an earlier
 * one. The in-process history keeps every record. The proof pack is the
 * retained copy that survives a restart.
 */

const history = [];

export function _resetProofRunForTests() {
  history.length = 0;
}

export function proofRunHistory() {
  return history.map((row) => ({ ...row }));
}

export function proofRunMetric() {
  const last = history.length ? history[history.length - 1] : null;
  return {
    rung: 'R7',
    status: last ? last.status : 'not_run',
    last_at: last ? last.at : null,
    last_correlation_id: last ? last.correlation_id : null,
    passed: last ? last.passed : 0,
    failed: last ? last.failed : 0,
    retained: history.length,
    deleted: false,
    since_process_start: true
  };
}

export function proofStartupLine() {
  const metric = proofRunMetric();
  if (metric.status === 'fail') {
    return `[emet] PROOF RUN FAILED status=fail rung=R7 failed=${metric.failed} retained=${metric.retained}`;
  }
  if (metric.status === 'pass') {
    return `[emet] proof-run status=pass rung=R7 failed=0 retained=${metric.retained}`;
  }
  return '[emet] proof-run status=not_run rung=R7';
}

/**
 * Record one matrix run. `correlation_id` is kept only when it is 16 hex
 * characters. Anything else is dropped, so a token cannot land in the metric.
 */
export function recordProofRun({ pass, passed, failed, correlation_id } = {}) {
  const status = pass === true && !(Number(failed) > 0) ? 'pass' : 'fail';
  const correlation = typeof correlation_id === 'string' && /^[0-9a-f]{16}$/.test(correlation_id)
    ? correlation_id
    : null;
  history.push({
    at: new Date().toISOString(),
    status,
    passed: Number(passed) || 0,
    failed: Number(failed) || 0,
    correlation_id: correlation
  });
  if (status === 'fail') console.error(proofStartupLine());
  return proofRunMetric();
}
