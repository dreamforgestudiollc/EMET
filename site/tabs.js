/**
 * EMET site tabs.
 *
 * The page is one document. This script turns the subject list under the hero
 * into tabs. With JavaScript disabled it does not run: the header links stay
 * anchors, every section stays visible, and no demo module is referenced.
 *
 * Demo plug-in
 * ------------
 * Each subject panel may include one mount, after its static copy:
 *
 *   <div class="demo-mount" data-demo-mount="start"></div>
 *
 * The mount is empty, and the stylesheet hides an empty mount, so the static
 * copy is the whole panel until a demo fills it. Nothing in this file loads a
 * demo. Do not add a script tag for one. That would cost the first paint.
 *
 * To attach a demo later, set data-demo-src on that mount to a module path
 * relative to the page, for example demos/start.js. The first time the reader
 * opens that subject, the module is imported. If it exports mount(mountEl,
 * panel) or a default function of that shape, that function is called.
 *
 * The subject that is already open on the first paint does not import during
 * page load. Its import waits until the browser is idle. A subject the reader
 * never opens is never imported.
 *
 * A module that is already running may register instead:
 *
 *   EMETSite.registerDemo({
 *     id: 'start',
 *     load: function (mountEl, panel) {
 *       // build the simulator into mountEl
 *     }
 *   });
 *
 * load runs once for that subject. Registering the subject that is open now
 * runs load now; registering one that is closed waits until it is opened.
 *
 * Pause and resume. The panel emits a bubbling event, and so does the document:
 *
 *   emet-tab-show   detail: { id, panel, mount }
 *   emet-tab-hide   detail: { id, panel, mount }
 *
 * emet-tab-hide fires on the panel that is about to be covered, before it is
 * hidden, so a running demo can stop. emet-tab-show fires on the panel that
 * just became visible, and then load runs. load can finish after a later hide.
 * When the import resolves, check panel.hidden and pause if it is hidden.
 *
 * With JavaScript disabled the mount stays empty and the panel is the static
 * section.
 */

export const TAB_IDS = Object.freeze([
  'what', 'hosts', 'access', 'record', 'start', 'origin', 'project',
]);

export const SHOW_EVENT = 'emet-tab-show';
export const HIDE_EVENT = 'emet-tab-hide';

export function tabIdFromHash(hash, ids = TAB_IDS) {
  const id = String(hash || '').replace(/^#/, '');
  return ids.includes(id) ? id : ids[0];
}

/** Next index for a horizontal tablist. -1 when the key does not move tabs. */
export function indexForKey(index, key, count) {
  if (count <= 0) return -1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

export function mountTabs(doc, win, opts = {}) {
  const nav = doc.querySelector('nav.subject-nav');
  if (!nav) return null;
  const list = nav.querySelector('ul');
  if (!list) return null;
  const tabs = [...list.querySelectorAll('a[href^="#"]')];
  const root = doc.documentElement;
  root.classList.add('js');

  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-orientation', 'horizontal');
  list.setAttribute('role', 'presentation');

  const byId = new Map();
  for (const tab of tabs) {
    const id = tab.getAttribute('href').slice(1);
    const panel = doc.getElementById(id) || doc.getElementById(`panel-${id}`);
    if (!panel) continue;
    if (!tab.id) tab.id = `tab-${id}`;
    // The hash stays #id for links and for the no-JS page. While tabs are
    // running, the section id moves so the browser does not scroll to it.
    panel.setAttribute('data-subject', id);
    if (panel.id !== `panel-${id}`) panel.id = `panel-${id}`;
    tab.setAttribute('data-subject', id);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    const item = tab.parentElement;
    if (item && item.tagName && String(item.tagName).toLowerCase() === 'li') {
      item.setAttribute('role', 'presentation');
    }
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    byId.set(id, { tab, panel });
  }
  if (byId.size === 0) return null;

  const registry = new Map();
  const started = new Set();
  let current = null;

  function mountFor(panel) {
    return panel.querySelector('[data-demo-mount]');
  }

  function emit(panel, name, id) {
    const mount = mountFor(panel);
    const EventCtor = win.CustomEvent;
    const event = new EventCtor(name, { bubbles: true, detail: { id, panel, mount } });
    panel.dispatchEvent(event);
  }

  function scheduleInitial(fn) {
    if (typeof opts.scheduleInitial === 'function') {
      opts.scheduleInitial(fn);
      return;
    }
    const ric = win.requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => fn());
      return;
    }
    const timer = typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout;
    if (doc.readyState === 'complete') timer(fn, 1);
    else win.addEventListener('load', () => timer(fn, 1), { once: true });
  }

  function importModule(src) {
    if (typeof opts.importModule === 'function') return opts.importModule(src);
    return import(new URL(src, doc.baseURI).href);
  }

  function startDemo(id, panel, initial) {
    if (started.has(id)) return;
    const mount = mountFor(panel);
    const reg = registry.get(id);
    const src = mount ? mount.getAttribute('data-demo-src') : null;
    if (!reg && !src) return;
    started.add(id);
    const run = () => {
      let task;
      try {
        task = reg
          ? reg.load(mount, panel)
          : Promise.resolve(importModule(src)).then((mod) => {
            const fn = mod && (typeof mod.mount === 'function' ? mod.mount : mod.default);
            if (typeof fn === 'function') return fn(mount, panel);
          });
      } catch (err) {
        started.delete(id);
        if (win.console && typeof win.console.error === 'function') win.console.error('EMET demo failed to load:', id, err);
        return;
      }
      Promise.resolve(task).catch((err) => {
        started.delete(id);
        if (win.console && typeof win.console.error === 'function') win.console.error('EMET demo failed to load:', id, err);
      });
    };
    if (initial) scheduleInitial(run);
    else run();
  }

  function show(id, { focus = false, initial = false } = {}) {
    if (!byId.has(id)) return false;
    if (current === id) {
      if (focus && typeof byId.get(id).tab.focus === 'function') byId.get(id).tab.focus();
      return false;
    }
    for (const [otherId, entry] of byId) {
      if (otherId === id) continue;
      if (otherId === current) emit(entry.panel, HIDE_EVENT, otherId);
      entry.panel.hidden = true;
      entry.tab.setAttribute('aria-selected', 'false');
      entry.tab.tabIndex = -1;
    }
    const next = byId.get(id);
    current = id;
    root.setAttribute('data-tab', id);
    next.panel.hidden = false;
    next.tab.setAttribute('aria-selected', 'true');
    next.tab.tabIndex = 0;
    if (focus && typeof next.tab.focus === 'function') next.tab.focus();
    emit(next.panel, SHOW_EVENT, id);
    startDemo(id, next.panel, initial);
    return true;
  }

  function writeHash(id, mode) {
    const y = typeof win.scrollY === 'number' ? win.scrollY : 0;
    const url = `${win.location.pathname}${win.location.search}#${id}`;
    const state = { tab: id };
    if (mode === 'push') win.history.pushState(state, '', url);
    else win.history.replaceState(state, '', url);
    if (typeof win.scrollTo !== 'function' || typeof win.scrollY !== 'number') return;
    const pin = () => { if (win.scrollY !== y) win.scrollTo(0, y); };
    pin();
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(pin);
  }

  function keepAt(y, ms) {
    if (typeof win.scrollTo !== 'function') return;
    const until = Date.now() + ms;
    let user = false;
    const release = () => { user = true; };
    if (typeof win.addEventListener === 'function') {
      for (const type of ['wheel', 'pointerdown', 'touchstart']) {
        win.addEventListener(type, release, { capture: true, once: true, passive: true });
      }
    }
    const setInt = typeof win.setInterval === 'function' ? win.setInterval.bind(win) : setInterval;
    const clearInt = typeof win.clearInterval === 'function' ? win.clearInterval.bind(win) : clearInterval;
    const timer = setInt(() => {
      if (user || Date.now() > until) {
        clearInt(timer);
        return;
      }
      if (win.scrollY !== y) win.scrollTo(0, y);
    }, 32);
  }

  function choose(id, mode, focus) {
    const initial = current == null;
    const changed = show(id, { focus, initial });
    if (changed && mode) writeHash(id, mode);
    return changed;
  }

  const live = String(win.location.hash || '').replace(/^#/, '');
  const pending = root.getAttribute('data-pending-hash') || '';
  const initialId = byId.has(live) ? live : (byId.has(pending) ? pending : [...byId.keys()][0]);
  show(initialId, { focus: false, initial: true });
  if (pending) root.removeAttribute('data-pending-hash');
  const fromHash = byId.has(pending) || byId.has(live);
  if (fromHash) keepAt(0, 1800);
  const hashNow = String(win.location.hash || '').replace(/^#/, '');
  if (hashNow !== initialId && fromHash) {
    // The early script clears the hash so the first paint does not jump.
    // Put it back after load, once the section id no longer matches it.
    const restore = () => {
      if (current !== initialId) return;
      const now = String(win.location.hash || '').replace(/^#/, '');
      if (now === initialId) return;
      writeHash(initialId, 'replace');
    };
    if (doc.readyState === 'complete') restore();
    else win.addEventListener('load', restore, { once: true });
  }

  function subjectOf(tab) {
    return tab.getAttribute('data-subject');
  }

  for (const tab of tabs) {
    if (!byId.has(subjectOf(tab))) continue;
    tab.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.button) return;
      event.preventDefault();
      choose(subjectOf(tab), 'push', false);
    });
  }

  nav.addEventListener('keydown', (event) => {
    const ordered = tabs.filter((tab) => byId.has(subjectOf(tab)));
    const index = ordered.indexOf(doc.activeElement);
    if (index < 0) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      choose(subjectOf(ordered[index]), 'push', true);
      return;
    }
    const next = indexForKey(index, event.key, ordered.length);
    if (next < 0) return;
    event.preventDefault();
    choose(subjectOf(ordered[next]), 'push', true);
  });

  win.addEventListener('hashchange', () => {
    const id = String(win.location.hash || '').replace(/^#/, '');
    if (byId.has(id)) show(id, { focus: false, initial: false });
  });

  win.addEventListener('popstate', () => {
    const id = tabIdFromHash(win.location.hash, [...byId.keys()]);
    show(id, { focus: false, initial: false });
  });

  function registerDemo(def) {
    if (!def || typeof def.load !== 'function' || !byId.has(def.id)) {
      throw new Error('registerDemo expects { id, load } for a subject on this page');
    }
    registry.set(def.id, def);
    if (current === def.id) startDemo(def.id, byId.get(def.id).panel, false);
  }

  const api = {
    registerDemo,
    tabs: Object.freeze([...byId.keys()]),
    events: { show: SHOW_EVENT, hide: HIDE_EVENT },
  };
  win.EMETSite = api;
  return api;
}

function boot() {
  mountTabs(document, window);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
