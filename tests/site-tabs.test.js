/**
 * The public site's subject list is tabs when JavaScript runs, and the same
 * document when it does not. Wording on the page, including the ISO 9001
 * 7.5.3 / ISO 13485 4.2.5 fact, stays as written. The product version stays
 * 0.2.6. A release credit names the changelog section that recorded it.
 * The 0.2.6 list and every 0.2.x mention in Origin, the project, and GEM
 * are closed sets. GEM facts are read from the manifests, the socket, and
 * the specification, and the early hash map names the same subjects as the
 * tab rules.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'url';
import { TAB_IDS, SHOW_EVENT, HIDE_EVENT, tabIdFromHash, indexForKey, allowedDemoSrc, mountTabs } from '../site/tabs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const html = read('site/index.html');
const css = read('site/styles.css');
const js = read('site/tabs.js');

const ISO_DT = 'Document control (ISO 9001 7.5.3 / ISO 13485 4.2.5)';
const ISO_DD = 'No delete, on any store, by design. Corrections are made by adding: entries are superseded, documents are revised or retired, and retired means obsolete, not gone. Prior versions are retained, and templates are controlled documents. EMET supports that work; it holds no certification and claims no conformity.';

function panelHtml(id) {
  const start = html.indexOf(`id="${id}"`);
  const end = html.indexOf(`data-demo-mount="${id}"`, start);
  if (start < 0 || end < 0) throw new Error(`panel ${id} not found`);
  return html.slice(start, end);
}

function changelogSection(heading) {
  const change = read('CHANGELOG.md');
  const start = change.indexOf(heading);
  if (start < 0) throw new Error(`missing ${heading}`);
  const rest = change.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

function panelWords(fragment) {
  const text = fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  return text.split(/\s+/).filter(Boolean);
}

function versionMarks(fragment) {
  return [...fragment.matchAll(/0\.2\.\d+/g)].map((item) => item[0]);
}

function grouped(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function releasedLegacy() {
  const socket = read('src/socket.js');
  const start = socket.indexOf('export const RELEASED_LEGACY');
  const block = socket.slice(start, socket.indexOf(']);', start));
  return [...block.matchAll(/id: '([^']+)',\s*version: '([^']+)'/g)].map((item) => ({ id: item[1], version: item[2] }));
}

function bundledGems() {
  const dir = path.join(ROOT, 'gems');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'gem.json')))
    .map((entry) => entry.name)
    .sort();
}

function gemManifest(id) {
  return JSON.parse(read(`gems/${id}/gem.json`));
}

function specTerm(stem) {
  const spec = read('gem-library/SPEC.md');
  const found = spec.match(new RegExp(`\\*\\*(${stem} \\([^)]+\\))\\.\\*\\*`));
  if (!found) throw new Error(`SPEC has no term ${stem}`);
  return found[1];
}

function siteTextFiles() {
  const root = path.join(ROOT, 'site');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|css|js|xml|txt|md|json)$/i.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  return files;
}

function outsideCode(text) {
  return text.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, '');
}

function factBlock(panel, manifest) {
  const dt = `<dt>${manifest.name} ${manifest.version}</dt>`;
  const at = panel.indexOf(dt);
  if (at < 0) throw new Error(`missing ${dt}`);
  const ddStart = panel.indexOf('<dd>', at);
  const ddEnd = panel.indexOf('</dd>', ddStart);
  return panel.slice(ddStart, ddEnd + 5);
}

function inlineIdEntries(source) {
  const inline = source.slice(source.indexOf('<script>'), source.indexOf('</script>'));
  const body = inline.match(/var ids = \{([^}]+)\}/);
  if (!body) throw new Error('inline id map missing');
  return [...body[1].matchAll(/([a-z]+)\s*:\s*([^,\s}]+)/g)].map((item) => [item[1], item[2]]);
}

function runEarlyHash(source, hash) {
  const inline = source.slice(source.indexOf('<script>') + '<script>'.length, source.indexOf('</script>'));
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  const sandbox = {
    location: { hash },
    document: {
      documentElement: {
        classList: { add(name) { classes.add(name); } },
        setAttribute(key, value) { attrs[key] = String(value); },
        getAttribute(key) { return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null; },
      },
    },
    history: {},
  };
  sandbox.window = {
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  vm.runInNewContext(inline, sandbox);
  return { attrs, classes, listeners, location: sandbox.location };
}

function matches(node, sel) {
  let rest = sel.trim();
  if (rest.startsWith('[')) return attrOk(node, rest);
  const tag = (rest.match(/^[a-zA-Z0-9-]*/) || [''])[0];
  if (tag && node.tag !== tag) return false;
  rest = rest.slice(tag.length);
  while (rest.startsWith('.')) {
    const cls = (rest.slice(1).match(/^[a-zA-Z0-9_-]*/) || [''])[0];
    if (!node.classes.has(cls)) return false;
    rest = rest.slice(1 + cls.length);
  }
  if (!rest) return true;
  if (rest.startsWith('[')) return attrOk(node, rest);
  return false;
}

function attrOk(node, spec) {
  const found = spec.match(/^\[([^\]=^$~|]+)(?:(\^)?="([^"]*)")?\]$/);
  if (!found) return false;
  if (!Object.prototype.hasOwnProperty.call(node.attrs, found[1])) return false;
  if (found[3] == null) return true;
  const value = String(node.attrs[found[1]]);
  return found[2] === '^' ? value.startsWith(found[3]) : value === found[3];
}

function walk(node) {
  const out = [node];
  for (const child of node.children) out.push(...walk(child));
  return out;
}

function el(doc, tag, attrs = {}, children = []) {
  const node = {
    tag,
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    attrs: { ...attrs },
    classes: new Set(String(attrs.class || '').split(/\s+/).filter(Boolean)),
    children: [],
    parentElement: null,
    ownerDocument: doc,
    listeners: new Map(),
    _hidden: false,
    tabIndex: 0,
  };
  node.classList = { add(name) { node.classes.add(name); } };
  Object.defineProperty(node, 'hidden', {
    get() { return node._hidden; },
    set(value) { node._hidden = Boolean(value); },
  });
  node.setAttribute = (key, value) => {
    node.attrs[key] = String(value);
    if (key === 'id') node.id = String(value);
  };
  node.getAttribute = (key) => (Object.prototype.hasOwnProperty.call(node.attrs, key) ? node.attrs[key] : null);
  node.removeAttribute = (key) => { delete node.attrs[key]; };
  node.addEventListener = (type, fn) => {
    if (!node.listeners.has(type)) node.listeners.set(type, []);
    node.listeners.get(type).push(fn);
  };
  node.dispatchEvent = (event) => {
    event.target = node;
    let current = node;
    while (current) {
      for (const fn of [...(current.listeners.get(event.type) || [])]) fn(event);
      if (!event.bubbles) break;
      current = current.parentElement;
    }
    return true;
  };
  node.focus = () => { doc.activeElement = node; };
  node.blur = () => { doc.activeElement = doc.body || null; };
  node.querySelectorAll = (sel) => walk(node).filter((item) => item !== node && matches(item, sel));
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  node.append = (child) => {
    child.parentElement = node;
    node.children.push(child);
  };
  for (const child of children) node.append(child);
  return node;
}

function page(ids = TAB_IDS) {
  const doc = {
    readyState: 'complete',
    activeElement: null,
    baseURI: 'https://dreamforgestudiollc.github.io/EMET/',
  };
  const htmlEl = el(doc, 'html');
  const body = el(doc, 'body');
  const nav = el(doc, 'nav', { class: 'subject-nav', 'aria-label': 'On this page' }, [
    el(doc, 'ul', {}, ids.map((id) => el(doc, 'li', {}, [
      el(doc, 'a', { href: `#${id}`, id: `tab-${id}` }),
    ]))),
  ]);
  const panels = el(doc, 'div', { class: 'subject-panels' }, ids.map((id) => el(doc, 'section', { id, class: 'block' }, [
    el(doc, 'div', { class: 'demo-mount', 'data-demo-mount': id }),
  ])));
  htmlEl.append(body);
  body.append(nav);
  body.append(panels);
  doc.documentElement = htmlEl;
  doc.body = body;
  doc.getElementById = (id) => walk(htmlEl).find((node) => node.id === id) || null;
  doc.querySelector = (sel) => walk(htmlEl).find((node) => matches(node, sel)) || null;
  doc.querySelectorAll = (sel) => walk(htmlEl).filter((node) => matches(node, sel));
  const pushes = [];
  const replaces = [];
  const winListeners = new Map();
  const win = {
    location: { pathname: '/EMET/', search: '', hash: '' },
    history: {
      pushState(_state, _title, url) {
        pushes.push(url);
        win.location.hash = url.slice(url.indexOf('#'));
      },
      replaceState(_state, _title, url) {
        replaces.push(url);
        win.location.hash = url.slice(url.indexOf('#'));
      },
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = Boolean(init.bubbles);
        this.detail = init.detail || null;
      }
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      winListeners.set(type, (winListeners.get(type) || []).filter((item) => item !== fn));
    },
    console: { error() {} },
  };
  win.fire = (type) => {
    for (const fn of [...(winListeners.get(type) || [])]) fn();
  };
  return { doc, win, pushes, replaces };
}

function click(tab) {
  const event = {
    type: 'click',
    bubbles: true,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  tab.dispatchEvent(event);
  return event;
}

function key(doc, nav, name) {
  const event = {
    type: 'keydown',
    key: name,
    bubbles: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  nav.dispatchEvent(event);
  return event;
}

testGroup('the site keeps its words and degrades without JavaScript', () => {
  test('the ISO 9001 7.5.3 / ISO 13485 4.2.5 fact is unchanged', () => {
    assert.ok(html.includes(`<dt>${ISO_DT}</dt>`));
    assert.ok(html.includes(`<dd>${ISO_DD}</dd>`));
  });

  test('version marks stay 0.2.6', () => {
    assert.ok(html.includes('EMET 0.2.6'));
    assert.ok(html.includes('"version": "0.2.6"'));
    assert.ok(!html.includes('0.2.7'));
    const outsideCredits = html.replace(panelHtml('origin'), '').replace(panelHtml('gem'), '');
    assert.ok(!outsideCredits.includes('0.2.5'));
    assert.ok(panelHtml('gem').includes('The 0.2.5 changelog added it.'));
  });

  test('header anchors are the original subjects and every section is in the page', () => {
    const header = html.slice(html.indexOf('class="header-nav"'), html.indexOf('</header>'));
    for (const [id, label] of [['what', 'What it is'], ['hosts', 'Hosts'], ['access', 'Access'], ['record', 'Record'], ['start', 'Start'], ['origin', 'Origin'], ['gem', 'GEM']]) {
      assert.ok(header.includes(`href="#${id}">${label}</a>`), label);
      assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.ok(!header.includes('#project'));
    assert.ok(!/<section\b[^>]*\shidden\b/.test(html));
    assert.ok(!html.includes('role="tab"'));
    assert.ok(html.includes('<script type="module" src="tabs.js"></script>'));
  });

  test('each subject has an empty demo mount and the tab list matches the script', () => {
    const nav = html.slice(html.indexOf('class="subject-nav"'), html.indexOf('class="subject-panels"'));
    for (const id of TAB_IDS) {
      assert.ok(nav.includes(`href="#${id}"`), id);
      assert.strictEqual(html.split(`data-demo-mount="${id}"`).length - 1, 1, id);
    }
    assert.ok(nav.includes('>The project</a>'));
    assert.ok(!/data-demo-src=/.test(html));
    const declared = [...html.matchAll(/id="tab-([a-z]+)"/g)].map((item) => item[1]);
    assert.deepStrictEqual(declared, [...TAB_IDS]);
  });

  test('each subject panel has substantive content', () => {
    const docs = 'https://github.com/dreamforgestudiollc/EMET/blob/main/';
    for (const id of TAB_IDS) {
      const panel = panelHtml(id);
      const count = panelWords(panel).length;
      assert.ok(count >= 300, `${id} has ${count} words`);
      assert.ok(!/data-demo-src=/.test(panel), id);
      assert.equal((panel.match(/data-demo-mount=/g) || []).length, 0, id);
    }
    for (const id of ['hosts', 'access', 'record', 'start', 'origin', 'gem', 'project']) {
      const panel = panelHtml(id);
      assert.ok((panel.match(/<h3\b/g) || []).length >= 4, `${id} headings`);
      assert.ok(panel.includes('<h3>Limits</h3>'), `${id} limits`);
      assert.ok(panel.includes('<h3>Read more</h3>'), `${id} links`);
      assert.ok(panel.includes(docs), `${id} doc link`);
    }
  });

  test('What it is links to every other tab and keeps the workshop image', () => {
    const what = panelHtml('what');
    for (const id of TAB_IDS) {
      if (id === 'what') continue;
      assert.ok(what.includes(`href="#${id}"`), `#${id}`);
    }
    assert.ok(what.includes('Golem Expertise Module (GEM)'));
    assert.ok(what.includes('RUNED (Registered Utility Node Executable Directive)'));
    assert.ok(what.includes('gems of knowledge'));
    assert.ok(what.includes('explicitly marked it released'));
    assert.ok(!what.includes('legacy'));
    assert.ok(!what.includes('boolean'));
    assert.ok(!what.includes('<figcaption'));
    assert.ok(!what.includes('The full workshop scene'));
    assert.ok(what.includes('alt="Sepia biomechanical sculpture of a woman seated in a Dreamforge Studio workshop, with tools and gears around her and the Hebrew word אמת on her headband."'));
    assert.ok(!html.includes('<figcaption'));
    assert.ok(!css.includes('figcaption'));
    const iso = what.slice(what.indexOf('<dt>Document control'), what.indexOf('</dd>', what.indexOf('<dt>Document control')) + 5);
    assert.ok(iso.includes(`<dt>${ISO_DT}</dt>`));
    assert.ok(iso.includes(`<dd>${ISO_DD}</dd>`));
  });

  test('the released check names the bundled GEMs that seat without that mark', () => {
    const what = panelHtml('what');
    const at = what.indexOf('<dt>Released check</dt>');
    const line = what.slice(at, what.indexOf('</dd>', at) + 5);
    const rows = releasedLegacy();
    const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
    const missing = bundledGems().filter((id) => !Object.hasOwn(gemManifest(id), 'released'));
    assert.deepStrictEqual(missing, rows.map((row) => row.id).sort());
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      const manifest = gemManifest(row.id);
      assert.strictEqual(manifest.version, row.version);
      assert.ok(!Object.hasOwn(manifest, 'released'), row.id);
    }
    for (const id of bundledGems()) {
      if (rows.some((row) => row.id === id)) continue;
      assert.strictEqual(gemManifest(id).released, true, id);
    }
    assert.ok(line.includes('explicitly marked it released'));
    assert.ok(line.includes(`${words[rows.length]} older bundled GEMs`), 'exception');
    assert.ok(line.includes('pin of their id, version, and every file'));
    assert.ok(!line.includes('legacy'));
    assert.ok(!line.includes('boolean'));
  });

  test('the spec date on the page is SPEC_REVISION', () => {
    const rev = read('src/gem-check.js').match(/export const SPEC_REVISION = '(\d{4}-\d{2}-\d{2})'/);
    assert.ok(rev, 'SPEC_REVISION');
    const date = rev[1];
    const spec = read('gem-library/SPEC.md').match(/\*\*Revision:\*\* (\d{4}-\d{2}-\d{2})/);
    assert.strictEqual(spec[1], date);
    for (const id of ['origin', 'gem', 'project']) {
      assert.ok(panelHtml(id).includes(`Draft, revision ${date}`), id);
    }
    assert.ok(panelHtml('gem').includes(`spec <code>${date}</code>`));
    const shown = [...html.matchAll(/revision (\d{4}-\d{2}-\d{2})/g)].map((item) => item[1]);
    assert.ok(shown.length >= 1);
    for (const item of shown) assert.strictEqual(item, date);
  });

  test('the GEM panel uses the pinned names and the bundled facts', () => {
    const gem = panelHtml('gem');
    const spec = read('gem-library/SPEC.md');
    const v025 = changelogSection('## 0.2.5 - 2026-10-14');
    assert.ok(spec.startsWith('# Golem Expertise Module (GEM) specification'));
    assert.ok(spec.includes('**RUNED (Registered Utility Node Executable Directive).**'));
    assert.ok(gem.includes('Golem Expertise Module (GEM)'));
    assert.ok(gem.includes('RUNED (Registered Utility Node Executable Directive)'));
    assert.ok(gem.includes('gems of knowledge'));
    assert.ok(!gem.includes('Golem Expansion Module'));
    assert.ok(!html.includes('Golem Expansion Module'));
    assert.ok(!/<h3>[^<]*(?:[Rr]eleased|[Bb]yte|[Ll]egacy)/.test(gem));
    assert.ok(gem.includes('Only the boolean <code>true</code> counts.'));
    assert.ok(gem.includes('Neurendipity 1.2.3 and Fieldnote 1.0.1'));
    assert.ok(v025.includes('Neurendipity, the bundled GEM at `gems/neurendipity`'));
    assert.ok(gem.includes('16,384 bytes'));
    assert.ok(read('src/socket.js').includes('MAX_ACTIVE_FLOOR_BYTES = 16384'));
    assert.ok(read('src/socket.js').includes('MAX_INSTALLED = 16'));
    assert.ok(read('src/socket.js').includes('MAX_ACTIVE = 4'));
    const seated = gem.slice(gem.indexOf('<h3>How a GEM is checked and seated</h3>'), gem.indexOf('<h3>The bundled GEMs</h3>'));
    assert.ok(seated.includes('Only the boolean <code>true</code> counts.'));
    assert.ok(seated.includes('legacy') === false);
    assert.ok(seated.includes('Neurendipity 1.2.3 and Fieldnote 1.0.1'));
    for (const [dir, version, kind] of [
      ['neurendipity', '1.2.3', 'gem'],
      ['lean-six-sigma', '0.9.0', 'runed-gem'],
      ['bot-team-backup', '1.0.0', 'gem'],
      ['fieldnote', '1.0.1', 'runed-gem'],
    ]) {
      const manifest = JSON.parse(read(`gems/${dir}/gem.json`));
      assert.strictEqual(manifest.version, version);
      assert.strictEqual(manifest.kind, kind);
      assert.strictEqual(manifest.license, 'MIT');
      assert.deepStrictEqual(manifest.authors, ['Dreamforge Studio LLC']);
      assert.ok(gem.includes(version), version);
    }
    assert.strictEqual(JSON.parse(read('gem-library/examples/neurendipity/gem.json')).license, 'MIT');
    assert.ok(read('gem-library/SPEC.md').includes('| `authors`, `license` | Required. |'));
    assert.ok(read('gem-library/gem.schema.json').includes('"license"'));
    for (const sentence of [
      'The GEM specification requires <code>authors</code> and <code>license</code> on every manifest.',
      '<code>license</code> is a string of 1 to 40 characters. The specification does not name which licenses that string may hold.',
      'Each bundled GEM in this release sets <code>license</code> to <code>MIT</code> and <code>authors</code> to Dreamforge Studio LLC',
      'The repository <code>LICENSE</code> is the MIT License for this software. The copyright lines are C.I.P.S. LLC and Dreamforge Studio LLC.',
      'The pin that allows a missing <code>released</code> flag does not cover the <code>license</code> field.',
      'GEMs may be offered as licensed add-ons. This repository does not state prices, license terms for that offer, or a marketplace.',
    ]) {
      assert.ok(gem.includes(sentence), sentence);
    }
    assert.ok(read('gems/lean-six-sigma/CHANGELOG.md').includes('Pre-release 0.9.0'));
    assert.ok(gem.includes('calls 0.9.0 a pre-release'));
    assert.ok(read('gem-library/SPEC.md').includes('cannot be lost, edited away, or forked per install') || read('src/floor.js').includes('cannot be lost, edited away, or forked per install'));
    assert.ok(gem.includes('forked per install'));
  });

  test('the site does not restore retired names for GEM or RUNED', () => {
    const retired = [
      /\bformerly\b/i,
      /\bformerly\s+\w+/i,
      /\(\s*formerly\s+[^)]+\)/i,
      /\bpreviously\s+called\b/i,
      /\bwas\s+called\b/i,
      /\bnow\s+called\b/i,
      /\baka\b/i,
      /\bold\s+name\b/i,
      /\bold\s+name\s+(?:was|is)\b/i,
      /\bguided\s+engagement\b/i,
      /\bregistered\s+utility\s+node\s+extension\b/i,
      /\bguided\s+engagement(?:\s+module)?\b[^.\n]{0,80}\bis\s+superseded\b/i,
      /\bregistered\s+utility\s+node\s+extension\b[^.\n]{0,80}\bis\s+superseded\b/i,
      /\bgolem\s+expansion\s+module\b/i,
      /\bolder\s+note\s+says\b/i,
      /\bread\s+runed\b/i,
      /2026-09-08\s+expansion/i,
    ];
    const files = siteTextFiles();
    const rels = files.map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
    for (const required of ['site/index.html', 'site/styles.css', 'site/sitemap.xml']) {
      assert.ok(rels.includes(required), required);
    }
    const page = fs.readFileSync(path.join(ROOT, 'site/index.html'), 'utf8');
    const cssText = fs.readFileSync(path.join(ROOT, 'site/styles.css'), 'utf8');
    const mapText = fs.readFileSync(path.join(ROOT, 'site/sitemap.xml'), 'utf8');
    assert.ok(page.includes('<title>'));
    assert.ok(/<meta\s/i.test(page));
    assert.ok(page.includes('<!--'));
    assert.ok(cssText.includes('/*'));
    assert.ok(mapText.includes('<urlset'));
    const allowed = [
      ISO_DD,
      'entries are superseded',
      'are superseded whole',
      'names the version it supersedes',
      'A superseded or expired entry',
      'A record is superseded, never patched.',
      'Registered Utility Node Executable Directive is superseded.',
    ];
    for (const pattern of retired) {
      for (const sentence of allowed) {
        assert.equal(pattern.test(sentence), false, `${pattern} matched product wording: ${sentence}`);
      }
    }
    assert.ok(retired.some((pattern) => pattern.test('Guided Engagement Module is superseded.')));
    assert.ok(retired.some((pattern) => pattern.test('The Registered Utility Node Extension is superseded.')));
    assert.equal(retired.some((pattern) => pattern.test('A record is superseded, never patched.')), false);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const where = path.relative(ROOT, file);
      for (const pattern of retired) {
        assert.equal(pattern.test(text), false, `${where} matches ${pattern}`);
      }
      assert.equal(/\bRUNE(?!D)\b/.test(outsideCode(text)), false, `${where} uses the bare name RUNE`);
    }
    const gem = panelHtml('gem');
    assert.ok(gem.includes('The name marks the golem legend: the word <span lang="he">אמת</span>, truth, animates the figure.'));
    assert.ok(gem.includes('RUNED (Registered Utility Node Executable Directive) is one declared, registered tool built into a GEM. A RUNED GEM is a GEM whose manifest contains one or more of those directives.'));
    assert.ok(html.includes('One read-only tool per RUNED'));
    assert.ok(html.includes('imports the RUNED load gate'));
    assert.ok(html.includes('and the RUNED load gate'));
    assert.ok(html.includes('<code>gem_&lt;gem&gt;__&lt;rune&gt;</code>'));
    assert.ok(html.includes(ISO_DD));
    assert.ok(html.includes('entries are superseded'));
    assert.ok(html.includes('are superseded whole'));
    assert.ok(html.includes('names the version it supersedes'));
    assert.ok(html.includes('A superseded or expired entry'));
  });

  test('origin credits goal_check and no_rapport_mirroring to 0.2.5', () => {
    const origin = panelHtml('origin');
    const v025 = changelogSection('## 0.2.5 - 2026-10-14');
    const v026 = changelogSection('## 0.2.6 - 2026-10-20');
    assert.ok(origin.includes('Version 0.2.5 added two core floor lines.'));
    assert.ok(origin.includes('<code>goal_check</code>'));
    assert.ok(origin.includes('<code>no_rapport_mirroring</code>'));
    assert.ok(origin.includes('state the person’s goal and underlying problem in one sentence in your own words, marked as your read, and confirm.'));
    assert.ok(origin.includes('no echoing, flattery, or agreement to build rapport or seem attuned. Agreement is earned by substance.'));
    assert.ok(origin.includes('The 0.2.6 changelog records that the floor is unchanged.'));
    assert.ok(!origin.includes('release notes for 0.2.6'));
    assert.ok(!origin.includes('Floor lines in this version'));
    assert.ok(!/0\.2\.6[^.]{0,160}goal_check/.test(origin));
    assert.ok(!/0\.2\.6[^.]{0,160}no_rapport_mirroring/.test(origin));
    assert.ok(v025.includes('two new core floor lines: `goal_check` and `no_rapport_mirroring`'));
    assert.ok(v025.includes('Core floor, engagement: `goal_check`'));
    assert.ok(v025.includes('before multi-step work, on an ambiguous request, or when the conversation turns, state the person\'s goal and underlying problem in one sentence in your own words, marked as your read, and confirm'));
    assert.ok(v025.includes('no echoing, flattery, or agreement to build rapport or seem attuned'));
    assert.ok(v025.includes('agreement is earned by substance'));
    assert.ok(v026.includes('the floor are unchanged'));
    assert.ok(!v026.includes('goal_check'));
    assert.ok(!v026.includes('no_rapport_mirroring'));
    const notes = read('RELEASE_NOTES-0.2.6.md');
    assert.ok(notes.includes('## Floor lines in this version'));
    assert.ok(!origin.includes('Floor lines in this version'));
  });

  test('each other version claim on the six panels matches the changelog', () => {
    const v025 = changelogSection('## 0.2.5 - 2026-10-14');
    const v026 = changelogSection('## 0.2.6 - 2026-10-20');
    const origin = panelHtml('origin');
    const project = panelHtml('project');
    const changedStart = project.indexOf('<h3>What 0.2.6 changed</h3>');
    const changedEnd = project.indexOf('<h3>What is in the tree</h3>');
    assert.ok(changedStart >= 0 && changedEnd > changedStart);
    const changed = project.slice(changedStart, changedEnd);

    for (const id of ['hosts', 'access', 'record', 'start']) {
      assert.ok(!/0\.2\.\d/.test(panelHtml(id)), `${id} names no release`);
    }
    assert.ok(!project.includes('0.2.5'));
    assert.ok(!changed.includes('goal_check'));
    assert.ok(!changed.includes('no_rapport_mirroring'));
    assert.ok(!changed.includes('NEURODIVERGENT_SUPPORT'));

    assert.ok(origin.includes('still resolves, for one release'));
    assert.ok(v025.includes('still resolves to that GEM\'s copy for one release'));
    assert.ok(!v026.includes('for one release'));
    assert.ok(!changed.includes('for one release'));

    assert.ok(origin.includes('Draft, revision 2026-10-12'));
    assert.ok(project.includes('(Draft, revision 2026-10-12)'));
    assert.ok(read('gem-library/SPEC.md').includes('**Revision:** 2026-10-12'));
    assert.ok(v026.includes('spec `2026-10-12`'));
    assert.ok(v025.includes('Draft revision 2026-10-11'));
    assert.ok(!html.includes('revision 2026-10-11'));

    const pkg = JSON.parse(read('package.json'));
    const server = JSON.parse(read('server.json'));
    assert.strictEqual(pkg.version, '0.2.6');
    assert.strictEqual(server.version, '0.2.6');
    assert.ok(project.includes('EMET 0.2.6'));
    assert.ok(project.includes('The registry manifest for 0.2.6.'));
    assert.ok(project.includes('0.2.6, then the earlier releases.'));

    const claims = [
      ['Delegated client sub-keys', 'Delegated client sub-keys (EMET-0001'],
      ['emet_subkey_request', '`emet_subkey_request`'],
      ['emet_subkey_claim', '`emet_subkey_claim`'],
      ['emet_subkey_revoke', '`emet_subkey_revoke`'],
      ['emet_subkey_end_session', '`emet_subkey_end_session`'],
      ['Keys expire after 30 days', 'Keys expire after 30 days and can be reissued.'],
      ['Approve and revoke stay on the owner', 'Approve and revoke stay on the owner\'s own login.'],
      ['reports each GEM', 'reports each GEM\'s byte cost'],
      ['off unless the first-run interview records yes', 'off unless the first-run interview records yes.'],
      ['Yes is the recommended choice', 'Yes is the recommended choice.'],
      ['does not copy prompts or settings itself', 'EMET does not copy prompts or settings itself.'],
      ['Secret values are never stored', 'Secret values are never stored.'],
      ['Lean Six Sigma 0.9.0', 'Lean Six Sigma 0.9.0'],
      ['lean-six-sigma', '`EMET_ACTIVE_GEMS=lean-six-sigma`'],
      ['&gt;=0.2.6', '`>=0.2.6`'],
      ['MAJOR.MINOR.PATCH', '`MAJOR.MINOR.PATCH` with no suffix'],
      ['gem_&lt;gem&gt;__&lt;rune&gt;', '`gem_<gem>__<rune>`'],
      ['The server sandbox is removed', 'The server sandbox is removed.'],
      ['boolean <code>true</code>', 'not the boolean `true`'],
      ['<code>"true"</code>', 'the string `"true"`'],
      ['<code>1</code>, and <code>null</code> fail', '`1`, and `null` fail'],
      ['<code>verification/</code>', 'include `verification/`'],
      ['src/host-reach.js', '`src/host-reach.js` imports the RUNE load gate'],
      ['stated again', 'again states the client-executed RUNE carve-out'],
      ['EMET verifies the record, not the computation', 'EMET verifies the record, not the computation.'],
    ];
    for (const [onSite, inChangelog] of claims) {
      assert.ok(changed.includes(onSite), `site missing: ${onSite}`);
      assert.ok(v026.includes(inChangelog), `0.2.6 changelog missing: ${inChangelog}`);
    }
    assert.ok(!v025.includes('emet_subkey_request'));
    assert.ok(!v025.includes('Lean Six Sigma 0.9.0'));
    assert.ok(!v025.includes('bot-team backup'));
    assert.ok(!v025.includes('byte cost'));

    const prose = changed.slice(changed.indexOf('</h3>') + 5, changed.indexOf('<ul')).replace(/\s+/g, ' ').trim();
    assert.strictEqual(prose, '<p class="prose">The stored document shapes are not frozen. Pin a version if you depend on them. The document-control wording is unchanged. The charter commitment on client-executed tools is stated again: EMET verifies the record, not the computation.</p>');
    const lis = [...changed.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((item) => item[1]);
    const liClaims = [
      ['Delegated client sub-keys', 'Delegated client sub-keys (EMET-0001'],
      ['reports each GEM', 'reports each GEM\'s byte cost'],
      ['off unless the first-run interview records yes', 'off unless the first-run interview records yes.'],
      ['Lean Six Sigma 0.9.0', 'Lean Six Sigma 0.9.0'],
      ['gem_&lt;gem&gt;__&lt;rune&gt;', '`gem_<gem>__<rune>`'],
      ['boolean <code>true</code>', 'not the boolean `true`'],
      ['<code>verification/</code>', 'include `verification/`'],
    ];
    assert.strictEqual(lis.length, liClaims.length);
    for (const [onSite, inChangelog] of liClaims) {
      assert.strictEqual(lis.filter((li) => li.includes(onSite)).length, 1, onSite);
      assert.ok(v026.includes(inChangelog), onSite);
    }

    assert.deepStrictEqual(versionMarks(origin), ['0.2.5', '0.2.6']);
    assert.deepStrictEqual(versionMarks(project), ['0.2.6', '0.2.6', '0.2.6', '0.2.6', '0.2.6']);
    for (const phrase of [
      'EMET 0.2.6 is free and open source',
      '<h3>What 0.2.6 changed</h3>',
      '0.2.6, then the earlier releases.',
      'The registry manifest for 0.2.6.',
    ]) {
      assert.ok(project.includes(phrase), phrase);
    }

    const lss = gemManifest('lean-six-sigma');
    const gemVersions = [];
    for (const id of ['neurendipity', 'lean-six-sigma', 'bot-team-backup', 'fieldnote']) {
      const manifest = gemManifest(id);
      const bound = manifest.requires.emet.match(/0\.2\.\d+/);
      assert.ok(bound, id);
      gemVersions.push(bound[0]);
      if (id === 'neurendipity') {
        assert.ok(v025.includes('Neurendipity, the bundled GEM'));
        gemVersions.push('0.2.5');
      }
    }
    assert.deepStrictEqual(bundledGems(), ['bot-team-backup', 'fieldnote', 'lean-six-sigma', 'neurendipity']);
    assert.deepStrictEqual(versionMarks(panelHtml('gem')), gemVersions);
    assert.ok(changed.includes(`Lean Six Sigma ${lss.version}`));
    assert.ok(changed.includes(lss.requires.emet.replaceAll('>', '&gt;')));
    const named = [...html.matchAll(/Lean Six Sigma (\d+\.\d+\.\d+)/g)].map((item) => item[1]);
    assert.ok(named.length >= 2);
    for (const version of named) assert.strictEqual(version, lss.version);
    assert.ok(v026.includes(`Lean Six Sigma ${lss.version}`));
    assert.ok(html.includes(`<dt>Lean Six Sigma ${lss.version}</dt>`));
  });

  test('styles wrap the tabs, keep panels visible without the js class, and do not animate them', () => {
    assert.match(css, /nav ul[\s\S]*flex-wrap:\s*wrap/);
    assert.match(css, /\.subject-nav \{\s*display:\s*none;/);
    assert.match(css, /html\.js \.subject-nav \{\s*display:\s*block;/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /\.demo-mount:empty \{\s*display:\s*none;/);
    assert.ok(!/\.subject-nav[^{]*\{[^}]*overflow-x:\s*(?:auto|scroll|hidden)/.test(css));
    assert.ok(!/white-space:\s*nowrap/.test(css));
  });

  test('demo loading is described and not imported up front', () => {
    assert.ok(js.includes(SHOW_EVENT) && js.includes(HIDE_EVENT));
    assert.ok(js.includes('data-demo-src'));
    assert.ok(js.includes('registerDemo'));
    assert.strictEqual([...js.matchAll(/\bimport\s*\(/g)].length, 1);
    assert.ok(!/^import /m.test(js));
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'site', 'demos')), false);
  });

  test('the early script keeps the subject fragment when tabs.js does not run', () => {
    const inline = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    assert.ok(inline.includes("root.setAttribute('data-tab'"));
    assert.ok(inline.includes("addEventListener('hashchange'"));
    assert.ok(!inline.includes('replaceState'));
    assert.ok(!inline.includes('data-pending-hash'));
    assert.ok(!inline.includes('location.hash ='));
    const entries = inlineIdEntries(html);
    assert.deepStrictEqual(entries.map((entry) => entry[0]), [...TAB_IDS]);
    for (const [, value] of entries) assert.strictEqual(value, '1');
    const showAt = css.indexOf('html.js[data-tab="what"]');
    const showRule = css.slice(showAt, css.indexOf('{', showAt));
    const cssIds = [];
    for (const item of showRule.matchAll(/html\.js\[data-tab="([a-z]+)"\]/g)) {
      if (!cssIds.includes(item[1])) cssIds.push(item[1]);
    }
    assert.deepStrictEqual(cssIds, [...TAB_IDS]);
    for (const id of TAB_IDS) {
      assert.ok(showRule.includes(`html.js[data-tab="${id}"] #${id}`), id);
      assert.ok(showRule.includes(`html.js[data-tab="${id}"] [data-subject="${id}"]`), id);
    }
    const header = html.slice(html.indexOf('class="header-nav"'), html.indexOf('</header>'));
    const headerIds = [...header.matchAll(/href="#([a-z]+)"/g)].map((item) => item[1]);
    assert.deepStrictEqual(headerIds, TAB_IDS.filter((id) => id !== 'project'));
    const opened = runEarlyHash(html, '#gem');
    assert.ok(opened.classes.has('js'));
    assert.strictEqual(opened.attrs['data-tab'], 'gem');
    opened.location.hash = '#record';
    opened.listeners.hashchange();
    assert.strictEqual(opened.attrs['data-tab'], 'record');
    opened.location.hash = '#gem';
    opened.listeners.hashchange();
    assert.strictEqual(opened.attrs['data-tab'], 'gem');
  });

  test('GEM tab facts are the bundled manifests, the socket caps, and the specification names', () => {
    const gem = panelHtml('gem');
    const what = panelHtml('what');
    const ids = bundledGems();
    const countWord = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'][ids.length];
    const bundled = gem.slice(gem.indexOf('<h3>The bundled GEMs</h3>'), gem.indexOf('<h3>Turning one on</h3>'));
    assert.ok(bundled.includes(`${countWord} GEMs ship in <code>gems/</code>`));
    const flags = new Set(ids.map((id) => gemManifest(id).defaultOn));
    assert.deepStrictEqual([...flags], [false]);
    assert.ok(bundled.includes('Each has <code>defaultOn</code> false'));
    assert.ok(!bundled.includes('defaultOn</code> true'));
    const turning = gem.slice(gem.indexOf('<h3>Turning one on</h3>'), gem.indexOf('<h3>License</h3>'));
    assert.ok(turning.includes('Every bundled GEM in this release has <code>defaultOn</code> false'));
    const socket = read('src/socket.js');
    const installed = Number(socket.match(/export const MAX_INSTALLED = (\d+)/)[1]);
    const active = Number(socket.match(/export const MAX_ACTIVE = (\d+)/)[1]);
    const floorCap = Number(socket.match(/export const MAX_ACTIVE_FLOOR_BYTES = (\d+)/)[1]);
    const caps = turning.slice(turning.indexOf('The caps the socket enforces'), turning.indexOf('</p>', turning.indexOf('The caps the socket enforces')));
    assert.ok(caps.includes(`${installed} installed`), 'installed cap');
    assert.ok(caps.includes(`${active} active`), 'active cap');
    assert.ok(caps.includes(`${grouped(floorCap)} bytes`), 'floor cap');
    const checker = read('src/gem-check.js');
    const guideCount = Number(checker.match(/guides\.length > (\d+)/)[1]);
    const guideBytes = Number(checker.match(/buf\.length > (\d+)\) return fail\('GC-07'/)[1]);
    const floorFileMax = Number(checker.match(/floorBuf\.length > (\d+)/)[1]);
    const listedSum = Number(checker.match(/sum > (\d+)/)[1]);
    assert.ok(caps.includes(`${grouped(floorFileMax)} bytes`));
    assert.ok(caps.includes(`${grouped(guideBytes)} bytes`));
    assert.ok(caps.includes(`at most ${guideCount} guides`));
    assert.ok(caps.includes(grouped(listedSum)));
    for (const id of ids) {
      const manifest = gemManifest(id);
      const dd = factBlock(gem, manifest);
      assert.ok(dd.includes(`<code>kind</code> <code>${manifest.kind}</code>`), id);
      const req = manifest.requires.emet.replaceAll('>', '&gt;');
      assert.ok(dd.includes(`<code>requires.emet</code> is <code>${req}</code>`), id);
      if (manifest.released === true) assert.ok(dd.includes('<code>released</code> is true'), id);
      else assert.ok(dd.includes('no <code>released</code> field'), id);
      if (dd.includes('defaultOn')) assert.ok(dd.includes(`defaultOn</code> ${manifest.defaultOn}`), id);
      if (id === 'lean-six-sigma') {
        const listed = manifest.files.find((file) => file.path === manifest.floor);
        const onDisk = fs.statSync(path.join(ROOT, 'gems', id, manifest.floor)).size;
        assert.strictEqual(onDisk, listed.size);
        assert.ok(dd.includes(`${grouped(onDisk)} bytes`), 'LSS floor');
        assert.ok(bundled.indexOf('Each has <code>defaultOn</code> false') < bundled.indexOf(`<dt>${manifest.name} ${manifest.version}</dt>`));
      }
    }
    const gemName = specTerm('Golem Expertise Module');
    const runedName = specTerm('RUNED');
    const h2 = gem.match(/<h2 id="gem-title">([^<]*)<\/h2>/);
    assert.strictEqual(h2[1], gemName);
    const plain = gem.slice(gem.indexOf('<h3>A plain GEM and a RUNED GEM</h3>'), gem.indexOf('<h3>How a GEM is checked and seated</h3>'));
    assert.ok(plain.startsWith('<h3>A plain GEM and a RUNED GEM</h3>'));
    assert.ok(plain.includes(runedName));
    assert.ok(what.includes(`<dt>${gemName}</dt>`));
    const runedFact = what.slice(what.indexOf('<dt>RUNED GEM</dt>'), what.indexOf('</dd>', what.indexOf('<dt>RUNED GEM</dt>')) + 5);
    assert.ok(runedFact.includes(runedName));
  });
});

testGroup('tabs follow the hash, the keyboard, and a lazy demo', () => {
  test('an unknown hash names the first subject', () => {
    assert.strictEqual(tabIdFromHash(''), 'what');
    assert.strictEqual(tabIdFromHash('#start'), 'start');
    assert.strictEqual(tabIdFromHash('#nope'), 'what');
    assert.strictEqual(indexForKey(0, 'ArrowRight', 7), 1);
    assert.strictEqual(indexForKey(0, 'ArrowLeft', 7), 6);
    assert.strictEqual(indexForKey(3, 'Home', 7), 0);
    assert.strictEqual(indexForKey(3, 'End', 7), 6);
    assert.strictEqual(indexForKey(3, 'ArrowDown', 7), 4);
    assert.strictEqual(indexForKey(3, 'ArrowUp', 7), 2);
    assert.strictEqual(indexForKey(3, 'PageDown', 7), -1);
  });

  test('a deep link opens that subject and a click updates the hash without a second push', () => {
    const { doc, win, pushes, replaces } = page();
    win.location.hash = '#start';
    const api = mountTabs(doc, win);
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'start');
    assert.strictEqual(doc.getElementById('start'), null);
    assert.strictEqual(doc.getElementById('panel-start').hidden, false);
    assert.strictEqual(doc.getElementById('panel-what').hidden, true);
    assert.strictEqual(doc.getElementById('tab-start').getAttribute('aria-selected'), 'true');
    assert.strictEqual(doc.getElementById('tab-start').getAttribute('role'), 'tab');
    assert.strictEqual(doc.getElementById('tab-what').tabIndex, -1);
    const nav = doc.querySelector('nav.subject-nav');
    assert.strictEqual(nav.getAttribute('role'), null);
    const tablist = nav.querySelector('ul');
    assert.strictEqual(tablist.getAttribute('role'), 'tablist');
    assert.strictEqual(tablist.getAttribute('aria-orientation'), 'horizontal');
    assert.strictEqual(tablist.getAttribute('aria-label'), 'On this page');
    assert.deepStrictEqual(pushes, []);
    assert.deepStrictEqual(replaces, []);
    const hosts = doc.getElementById('tab-hosts');
    const event = click(hosts);
    assert.strictEqual(event.defaultPrevented, true);
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'hosts');
    assert.strictEqual(win.location.hash, '#hosts');
    assert.deepStrictEqual(pushes, ['/EMET/#hosts']);
    click(hosts);
    assert.deepStrictEqual(pushes, ['/EMET/#hosts']);
    const modified = {
      type: 'click', bubbles: true, button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
    };
    hosts.dispatchEvent(modified);
    assert.strictEqual(modified.defaultPrevented, false);
    assert.ok(api.tabs.includes('project'));
  });

  test('arrow keys, Home, and End move the selected subject and focus follows', () => {
    const { doc, win, pushes } = page();
    mountTabs(doc, win);
    const tablist = doc.querySelector('[role="tablist"]');
    const what = doc.getElementById('tab-what');
    const hosts = doc.getElementById('tab-hosts');
    what.focus();
    const right = key(doc, tablist, 'ArrowRight');
    assert.strictEqual(right.defaultPrevented, true);
    assert.strictEqual(doc.activeElement, hosts);
    assert.notStrictEqual(doc.activeElement, doc.body);
    assert.strictEqual(hosts.getAttribute('aria-selected'), 'true');
    assert.strictEqual(what.getAttribute('aria-selected'), 'false');
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'hosts');
    const stay = key(doc, tablist, 'Enter');
    assert.strictEqual(stay.defaultPrevented, true);
    assert.strictEqual(doc.activeElement, hosts);
    key(doc, tablist, 'End');
    assert.strictEqual(doc.activeElement, doc.getElementById('tab-project'));
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'project');
    key(doc, tablist, 'Home');
    assert.strictEqual(doc.activeElement, what);
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'what');
    key(doc, tablist, 'ArrowLeft');
    assert.strictEqual(doc.activeElement, doc.getElementById('tab-project'));
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'project');
    assert.ok(pushes.length >= 4);
    doc.activeElement = doc.body;
    const ignored = key(doc, tablist, 'ArrowRight');
    assert.strictEqual(ignored.defaultPrevented, false);
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'project');
  });

  test('unselected tabs are aria-selected false', () => {
    const { doc, win } = page();
    win.location.hash = '#start';
    mountTabs(doc, win);
    const selected = [];
    for (const id of TAB_IDS) {
      const tab = doc.getElementById(`tab-${id}`);
      const value = tab.getAttribute('aria-selected');
      if (id === 'start') {
        assert.strictEqual(value, 'true', id);
        selected.push(id);
      } else {
        assert.strictEqual(value, 'false', id);
      }
    }
    assert.deepStrictEqual(selected, ['start']);
  });

  test('each tab names its panel and each panel names its tab', () => {
    const { doc, win } = page();
    mountTabs(doc, win);
    for (const id of TAB_IDS) {
      const tab = doc.getElementById(`tab-${id}`);
      const panel = doc.getElementById(`panel-${id}`);
      assert.strictEqual(tab.getAttribute('role'), 'tab', id);
      assert.strictEqual(panel.getAttribute('role'), 'tabpanel', id);
      assert.strictEqual(tab.getAttribute('aria-controls'), panel.id, id);
      assert.strictEqual(tab.getAttribute('aria-controls'), `panel-${id}`, id);
      assert.strictEqual(panel.getAttribute('aria-labelledby'), tab.id, id);
      assert.strictEqual(panel.getAttribute('aria-labelledby'), `tab-${id}`, id);
    }
  });

  test('hashchange switches the open subject', () => {
    const { doc, win } = page();
    mountTabs(doc, win);
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'what');
    win.location.hash = '#record';
    win.fire('hashchange');
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'record');
    assert.strictEqual(doc.getElementById('panel-record').hidden, false);
    assert.strictEqual(doc.getElementById('panel-what').hidden, true);
    assert.strictEqual(doc.getElementById('tab-record').getAttribute('aria-selected'), 'true');
    assert.strictEqual(doc.getElementById('tab-what').getAttribute('aria-selected'), 'false');
  });

  test('show and hide events fire, and a demo loads once, after idle for the first subject', () => {
    const { doc, win } = page();
    const queued = [];
    const imported = [];
    const events = [];
    for (const id of TAB_IDS) {
      const panel = doc.getElementById(id);
      panel.addEventListener(SHOW_EVENT, (event) => events.push(['show', event.detail.id, event.detail.mount]));
      panel.addEventListener(HIDE_EVENT, (event) => events.push(['hide', event.detail.id]));
    }
    doc.getElementById('what').querySelector('[data-demo-mount]').setAttribute('data-demo-src', 'demos/what.js');
    doc.getElementById('start').querySelector('[data-demo-mount]').setAttribute('data-demo-src', 'demos/start.js');
    const api = mountTabs(doc, win, {
      scheduleInitial(fn) { queued.push(fn); },
      importModule(src) {
        imported.push(src);
        return { mount() {} };
      },
    });
    assert.deepStrictEqual(imported, []);
    assert.strictEqual(queued.length, 1);
    assert.deepStrictEqual(events.map((item) => item[0] + ':' + item[1]), ['show:what']);
    assert.strictEqual(events[0][2].getAttribute('data-demo-mount'), 'what');
    queued[0]();
    assert.deepStrictEqual(imported, ['demos/what.js']);
    click(doc.getElementById('tab-start'));
    assert.deepStrictEqual(imported, ['demos/what.js', 'demos/start.js']);
    assert.ok(events.some((item) => item[0] === 'hide' && item[1] === 'what'));
    assert.ok(events.some((item) => item[0] === 'show' && item[1] === 'start'));
    click(doc.getElementById('tab-what'));
    click(doc.getElementById('tab-start'));
    assert.deepStrictEqual(imported, ['demos/what.js', 'demos/start.js']);
    let loads = 0;
    api.registerDemo({ id: 'record', load() { loads += 1; } });
    assert.strictEqual(loads, 0);
    click(doc.getElementById('tab-record'));
    assert.strictEqual(loads, 1);
    click(doc.getElementById('tab-what'));
    click(doc.getElementById('tab-record'));
    assert.strictEqual(loads, 1);
    assert.throws(() => api.registerDemo({ id: 'missing', load() {} }), /registerDemo/);
  });

  test('a pending hash opens that subject and restores the hash after load', () => {
    const { doc, win, replaces } = page();
    doc.readyState = 'interactive';
    doc.documentElement.setAttribute('data-pending-hash', 'origin');
    mountTabs(doc, win);
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'origin');
    assert.strictEqual(doc.getElementById('panel-origin').hidden, false);
    assert.strictEqual(doc.getElementById('panel-what').hidden, true);
    assert.strictEqual(doc.documentElement.getAttribute('data-pending-hash'), null);
    assert.deepStrictEqual(replaces, []);
    win.fire('load');
    assert.deepStrictEqual(replaces, ['/EMET/#origin']);
    assert.strictEqual(doc.getElementById('panel-origin').id, 'panel-origin');
  });

  test('a demo module path must be same-origin', () => {
    const base = 'https://dreamforgestudiollc.github.io/EMET/';
    assert.strictEqual(allowedDemoSrc('demos/start.js', base), `${base}demos/start.js`);
    assert.strictEqual(allowedDemoSrc('/EMET/demos/start.js', base), `${base}demos/start.js`);
    assert.strictEqual(allowedDemoSrc(`${base}demos/start.js`, base), `${base}demos/start.js`);
    assert.strictEqual(allowedDemoSrc('https://evil.example/demo.js', base), null);
    assert.strictEqual(allowedDemoSrc('//evil.example/demo.js', base), null);
    assert.strictEqual(allowedDemoSrc('javascript:alert(1)', base), null);
    assert.strictEqual(allowedDemoSrc('data:text/javascript,alert(1)', base), null);

    const { doc, win } = page();
    const imported = [];
    doc.getElementById('start').querySelector('[data-demo-mount]').setAttribute('data-demo-src', 'https://evil.example/demo.js');
    doc.getElementById('hosts').querySelector('[data-demo-mount]').setAttribute('data-demo-src', '//evil.example/demo.js');
    doc.getElementById('record').querySelector('[data-demo-mount]').setAttribute('data-demo-src', `${base}demos/record.js`);
    mountTabs(doc, win, {
      scheduleInitial() {},
      importModule(src) {
        imported.push(src);
        return { mount() {} };
      },
    });
    click(doc.getElementById('tab-start'));
    click(doc.getElementById('tab-hosts'));
    click(doc.getElementById('tab-record'));
    assert.deepStrictEqual(imported, [`${base}demos/record.js`]);
  });

  test('back restores the subject the hash names', () => {
    const { doc, win } = page();
    mountTabs(doc, win);
    click(doc.getElementById('tab-access'));
    win.location.hash = '#record';
    win.fire('popstate');
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'record');
    assert.strictEqual(doc.getElementById('panel-access').hidden, true);
    win.location.hash = '';
    win.fire('popstate');
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'what');
  });
});

summary('site tabs');
