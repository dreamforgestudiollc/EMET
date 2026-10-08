// Micro-benchmark for the write-path scrubber. No database, no network:
// this measures ONLY the in-process cost the four-language benchmark showed to
// be the dominant one. Run before and after any change to redact.js.
import { redactWithReport, registerSecret, _clearRegisteredSecrets } from '../src/redact.js';

const N = Number(process.argv[2] || 50);

// Representative registered literals: what registerSecretsFromEnv would hold on
// the live service (a URI, its password, a passphrase).
_clearRegisteredSecrets();
registerSecret('mongodb+srv://benchuser:notarealpassword123@cluster0.example.mongodb.net/emet');
registerSecret('notarealpassword123');
registerSecret('bench-passphrase-not-real-0000');

const HEADER = '# EMET benchmark large document\nPATCH-TARGET-v1\n';
const BLOCK = 'The wise speak because they have something to say. The foolish speak because they have to say something. A work instruction that says be careful is not a control; a fixture that will not close on a bad part is. Nothing is lost, the current view simply stops showing it. Passphrase: hunter2-not-a-real-secret appears here so the scrub is exercised at scale.\n';
const CLEAN_BLOCK = 'The wise speak because they have something to say. The foolish speak because they have to say something. A work instruction that says be careful is not a control; a fixture that will not close on a bad part is. Nothing is lost, the current view simply stops showing it. Ordinary prose with no interesting words in it at all.\n';

function build(block, bytes) {
  let s = HEADER;
  while (s.length < bytes) s += block;
  return s.slice(0, bytes);
}

function time(label, text, expectHits) {
  redactWithReport(text); // warm
  const samples = [];
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    const r = redactWithReport(text);
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    hits = r.hits;
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const flag = expectHits !== undefined && hits !== expectHits ? `  <-- EXPECTED ${expectHits} HITS` : '';
  console.log(`${label.padEnd(46)} p50 ${p50.toFixed(3).padStart(9)} ms   p95 ${p95.toFixed(3).padStart(9)} ms   hits ${hits}${flag}`);
  return p50;
}

console.log(`redact.js micro-benchmark, ${N} iterations per case\n`);
time('300 KB, secret-bearing (worst case)', build(BLOCK, 307200));
time('300 KB, clean prose (common case)', build(CLEAN_BLOCK, 307200), 0);
time('300 KB, clean prose + one real literal', build(CLEAN_BLOCK, 307200).slice(0, 307100) + '\nnotarealpassword123\n');
time('8 KB, secret-bearing', build(BLOCK, 8192));
time('1 KB, clean', build(CLEAN_BLOCK, 1024), 0);
