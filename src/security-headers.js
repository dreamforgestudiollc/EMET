/**
 * Baseline headers on every HTTP response.
 *
 * The consent page sets its own Content-Security-Policy. These four headers
 * are set again just before the status line is written, so a later handler
 * cannot drop them, and they do not replace that policy.
 */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
});

export function securityHeaders(_req, res, next) {
  const apply = () => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  };
  apply();
  const writeHead = res.writeHead;
  res.writeHead = function writeHeadWithSecurityHeaders(...args) {
    apply();
    return writeHead.apply(this, args);
  };
  next();
}
