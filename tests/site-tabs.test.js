/**
 * The public site's subject list is tabs when JavaScript runs, and the same
 * document when it does not. Wording on the page, including the ISO 9001
 * 7.5.3 / ISO 13485 4.2.5 fact, stays as written. The product version stays
 * 0.2.6. A release credit names the changelog section that recorded it.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
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
