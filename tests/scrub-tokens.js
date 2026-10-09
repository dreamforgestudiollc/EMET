/**
 * EMET - the public tree carries no install-specific names (public snapshot).
 *
 * The names are checked by digest, not by spelling, so this file does not
 * itself publish the list it guards against. A word is any run of [a-z0-9]
 * after lower-casing; each word's sha256 (first 16 hex) is compared with the
 * set below.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PRIVATE_WORD_DIGESTS = new Set([
  'a8cb1254b7f7a6c6', 'c28ee0bfc3cbf014', '0aefc65b1ba43f88', 'fc5a299cd6cd644f',
  '960a38ace75a2fe9', 'b00ef262afae566b', 'ca5bcec12f716f44', 'e18ebaabb9f2fba0',
  '5842a9abe95881a4', '6cb784e0f985cba2', '2961c5a0feb2a8c9'
]);
export const digest = (w) => crypto.createHash('sha256').update(w).digest('hex').slice(0, 16);

/** Install-specific words found in a text (digests only are compared; the words found are returned). */
export function privateWordsIn(text, digests = PRIVATE_WORD_DIGESTS) {
  const found = new Set();
  // A regex escape (\b, \s) is not part of a word.
  for (const w of String(text).replace(/\\[a-zA-Z]/g, ' ').toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (digests.has(digest(w))) found.add(w);
  }
  return [...found];
}

// A private decision or incident record cited by number (fixture ids below 100 are generic).
export const PRIVATE_RECORD_REF = /\b(procedural|episodic|semantic) #?[1-9]\d{2,}\b/i;
// A deploy target named in a command (use a placeholder such as <service>).
// Bare record numbers (a hash and three or more digits) and private PR numbers ("PR", a hash, a number).
// A CSS colour followed by a semicolon and a fixture ref glued to a word are not record refs.
export const BARE_RECORD_REF = /(?<![\w&])#[1-9]\d{2,}(?![\d;a-fA-F])/;
export const PRIVATE_PR_REF = /\bPRs? ?#\d+\b/;
// An approval time stamped in Eastern time (h:mm, AM or PM, then ET); plain fixture clock times are fine.
export const APPROVAL_TIME = /\b\d{1,2}:\d{2} ?(?:AM|PM) ET\b/;
export const NAMED_SERVICE = /--service [a-z0-9]/i;
// A short commit-like hex id in prose. Public upstream ids and fixture digests are allowed.
export const SHORT_HEX = /(?<![0-9a-zA-Z_./-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,12}(?![0-9a-zA-Z_-])/g;
export const ALLOWED_HEX = new Set(['acdb5c8c', 'feb7628ae8a0', '15a3c529bee0', 'abcd1234']);

// A board item id cited from the owner's board (B- and three digits). B-001 to
// B-009 are the generic format examples the templates use.
export const BOARD_ID = /\bB-(?!00\d\b)\d{3}\b/;
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;
const TEST_TITLE_WITH_ID = /\b(?:testGroup|test|describe|it)\(\s*['"`][^'"`]*\bB-\d{3}\b/;
/** Lines citing a board id. In tests/ a board id in fixture text is a row id and is
 *  fine; only a comment or a test title that cites one is a reference. */
export function boardIdLines(rel, text) {
  const inTests = rel.startsWith('tests/');
  const out = [];
  String(text).split('\n').forEach((line, i) => {
    if (!BOARD_ID.test(line)) return;
    if (!inTests || COMMENT_LINE.test(line) || TEST_TITLE_WITH_ID.test(line)) out.push(`${rel}:${i + 1}`);
  });
  return out;
}
// A dated document path in the owner's staging/ folder (staging/<name>-2026-09.md).
// The generic forms (staging/*, staging/x.md, the folder map) are fine.
export const STAGING_STORE_PATH = /\bstaging\/[a-z0-9-]+-20\d\d-\d\d(?:-\d\d)?\.md\b/i;
// An entry cited by a short store-local ref (a layer or tracker name, a hash, a number).
export const SHORT_STORE_REF = /\b(?:meta|EMET) #\d+\b/;

// An internal review document cited by name or by section number. "working
// papers" and the like are fine.
export const INTERNAL_PAPER_REF = /\badmission (?:paper|gate)\b|\bpaper(?:'s)? (?:section|test list|\d)/i;

/** Present only in the private source. The publish scrub does not copy them. */
export const PRIVATE_TREE_MARKERS = [
  'REVIEW.md',
  'docs/status/2026-09-29-state-of-the-system.md',
  '.github/workflows/ci.yml',
];

export function isPrivateTree(root) {
  return PRIVATE_TREE_MARKERS.every((rel) => fs.existsSync(path.join(root, rel)));
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.nyc_output']);
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT = /\.(js|mjs|cjs|json|md|txt|yml|yaml|example|toml|sh)$|^(Dockerfile|LICENSE|\.gitignore|\.dockerignore|\.env\.example)$/;

/** Every shipped text file under root, relative paths. */
export function shippedTextFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
      const rel = path.relative(root, path.join(dir, e.name));
      const posix = rel.split(path.sep).join('/');
      // The public site is shipped text too: a private word in the page must fail the same way.
      // sitemap.xml and .nojekyll are part of that publish, so a missing one fails the walk.
      const sitePage = posix.startsWith('site/') && (/\.(html|css|xml)$/.test(e.name) || e.name === '.nojekyll');
      // The Pages workflow ships with the site, so a publish built from this walk keeps it.
      const pagesWorkflow = posix === '.github/workflows/pages.yml';
      // glama.json is the public directory listing. package-lock.json stays skipped.
      const glamaListing = posix === 'glama.json';
      if (SKIP_FILES.has(e.name) || (!TEXT.test(e.name) && !sitePage && !pagesWorkflow && !glamaListing)) continue;
      out.push(posix);
    }
  };
  walk(root);
  return out.sort();
}

const SITE_ASSET = /\.(?:png|jpe?g|gif|webp|svg|ico)$/i;

/** Text files plus the site image assets a Pages publish uploads. */
export function shippedPublishFiles(root) {
  const out = new Set(shippedTextFiles(root));
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); continue; }
      if (!SITE_ASSET.test(e.name)) continue;
      out.add(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'site'));
  return [...out].sort();
}

const SITE_ORIGIN = 'https://dreamforgestudiollc.github.io';
const SITE_PREFIX = '/EMET/';

function imagePath(url) {
  return String(url).split(/[?#]/)[0];
}

function pushJsonImage(image, out) {
  if (typeof image === 'string') out.push(image);
  else if (Array.isArray(image)) { for (const item of image) pushJsonImage(item, out); }
  else if (image && typeof image === 'object' && typeof image.url === 'string') out.push(image.url);
}

function collectJsonImages(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) collectJsonImages(item, out); return; }
  if (Object.prototype.hasOwnProperty.call(node, 'image')) pushJsonImage(node.image, out);
  if (node['@graph']) collectJsonImages(node['@graph'], out);
}

/**
 * Image references in one HTML page.
 * `paths` are files the publish walk must contain.
 * `faults` are references that must fail the presence check: a root-relative
 * URL, a protocol-relative URL, a JSON-LD image that is one of those, or a
 * path that climbs out of the repository.
 */
export function siteImageRefs(html, pageRel = 'site/index.html') {
  const refs = new Set();
  const faults = new Set();
  const pageDir = path.posix.dirname(pageRel);
  const consider = (raw) => {
    if (raw == null) return;
    const url = String(raw).trim();
    if (!url || url.startsWith('data:') || url.startsWith('#') || url.startsWith('mailto:')) return;
    const relUrl = imagePath(url);
    if (!SITE_ASSET.test(relUrl)) return;
    if (relUrl.startsWith('//') || relUrl.startsWith('/')) { faults.add(url); return; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(relUrl)) {
      let parsed;
      try { parsed = new URL(relUrl); } catch { faults.add(url); return; }
      if (parsed.origin !== SITE_ORIGIN || !parsed.pathname.startsWith(SITE_PREFIX)) return;
      addLocal(decodeURIComponent(parsed.pathname.slice(SITE_PREFIX.length)), url);
      return;
    }
    addLocal(relUrl, url);
  };
  const addLocal = (relUrl, original) => {
    if (relUrl.startsWith('/') || relUrl.startsWith('//')) { faults.add(original); return; }
    const rel = path.posix.normalize(path.posix.join(pageDir, relUrl));
    if (!rel || rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) { faults.add(original); return; }
    if (!SITE_ASSET.test(rel)) { faults.add(original); return; }
    refs.add(rel);
  };
  const text = String(html);
  for (const m of text.matchAll(/(?:\bsrc(?!set)|\bhref|\bcontent)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) consider(m[1] ?? m[2] ?? m[3]);
  for (const m of text.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    for (const part of (m[1] ?? m[2] ?? m[3] ?? '').split(',')) consider(part.trim().split(/\s+/)[0]);
  }
  for (const m of text.matchAll(/<script\b[^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json')[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); }
    catch {
      if (/"image"\s*:/.test(m[1])) faults.add(m[1].trim());
      continue;
    }
    const images = [];
    collectJsonImages(data, images);
    for (const image of images) consider(image);
  }
  return { paths: [...refs].sort(), faults: [...faults].sort() };
}
