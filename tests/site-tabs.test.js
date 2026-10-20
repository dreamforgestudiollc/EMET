/**
 * The public site's subject list is tabs when JavaScript runs, and the same
 * document when it does not. Wording on the page, including the ISO 9001
 * 7.5.3 / ISO 13485 4.2.5 fact, stays as written. Version text stays 0.2.6.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TAB_IDS, SHOW_EVENT, HIDE_EVENT, tabIdFromHash, indexForKey, mountTabs } from '../site/tabs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const html = read('site/index.html');
const css = read('site/styles.css');
const js = read('site/tabs.js');

const ISO_DT = 'Document control (ISO 9001 7.5.3 / ISO 13485 4.2.5)';
const ISO_DD = 'No delete, on any store, by design. Corrections are made by adding: entries are superseded, documents are revised or retired, and retired means obsolete, not gone. Prior versions are retained, and templates are controlled documents. EMET supports that work; it holds no certification and claims no conformity.';

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

  test('version text stays 0.2.6', () => {
    assert.ok(html.includes('EMET 0.2.6'));
    assert.ok(html.includes('"version": "0.2.6"'));
    assert.ok(!html.includes('0.2.5') && !html.includes('0.2.7'));
  });

  test('header anchors are the original subjects and every section is in the page', () => {
    const header = html.slice(html.indexOf('class="header-nav"'), html.indexOf('</header>'));
    for (const [id, label] of [['what', 'What it is'], ['hosts', 'Hosts'], ['access', 'Access'], ['record', 'Record'], ['start', 'Start'], ['origin', 'Origin']]) {
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
    assert.strictEqual(doc.querySelector('nav.subject-nav').getAttribute('role'), 'tablist');
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

  test('arrow keys, Home, and End move the selected subject', () => {
    const { doc, win, pushes } = page();
    mountTabs(doc, win);
    const nav = doc.querySelector('nav.subject-nav');
    doc.getElementById('tab-what').focus();
    const right = key(doc, nav, 'ArrowRight');
    assert.strictEqual(right.defaultPrevented, true);
    assert.strictEqual(doc.activeElement, doc.getElementById('tab-hosts'));
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'hosts');
    key(doc, nav, 'End');
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'project');
    key(doc, nav, 'Home');
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'what');
    key(doc, nav, 'ArrowLeft');
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'project');
    assert.ok(pushes.length >= 4);
    doc.activeElement = doc.body;
    const ignored = key(doc, nav, 'ArrowRight');
    assert.strictEqual(ignored.defaultPrevented, false);
    assert.strictEqual(doc.documentElement.getAttribute('data-tab'), 'project');
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
