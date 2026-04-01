// chat-actions.test.js – Tests für Generative UI Chat Action Chips
// Ausführen: node tests/chat-actions.test.js

const { describe, it, assert, assertEqual, printResults } = require('./test-runner');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadAllModules } = require('./module-loader');

// ── Mock: localStorage ──────────────────────────────────
const storage = {};
const localStorage = {
  getItem(key) { return storage[key] || null; },
  setItem(key, value) { storage[key] = String(value); },
  removeItem(key) { delete storage[key]; },
  clear() { Object.keys(storage).forEach(k => delete storage[k]); }
};

// ── Mock: DOM ───────────────────────────────────────────
const elements = {};
function createMockElement(id) {
  if (elements[id]) return elements[id];
  const el = {
    id,
    style: { display: '' },
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); }
    },
    innerHTML: '',
    textContent: '',
    value: '',
    dataset: {},
    children: [],
    childNodes: [],
    hidden: false,
    disabled: false,
    _listeners: {},
    addEventListener(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    },
    removeEventListener() {},
    querySelector(sel) { return null; },
    querySelectorAll(sel) { return []; },
    appendChild(child) { this.children.push(child); this.childNodes.push(child); },
    after(child) { this.children.push(child); },
    remove() {},
    click() {},
    focus() {},
    closest(sel) { return null; },
    scrollIntoView() {}
  };
  el.scrollTop = 0;
  Object.defineProperty(el, 'scrollHeight', { get: () => 1000, configurable: true });
  elements[id] = el;
  return el;
}

// Pre-create needed elements
['chat-messages', 'chat-suggestions', 'chat-input', 'chat-send',
 'chat-photo-preview', 'chat-photo-thumb', 'chat-photo-remove',
 'chat-camera', 'voice-main-btn', 'photo-chat-btn', 'video-chat-btn',
 'text-fallback-hint', 'text-fallback-input', 'chat-text-fallback',
 'chat-actions-secondary', 'settings-gear',
].forEach(id => createMockElement(id));

const document = {
  getElementById(id) { return elements[id] || createMockElement(id); },
  createElement(tag) {
    return {
      tag,
      className: '',
      textContent: '',
      innerHTML: '',
      style: { display: '' },
      hidden: false,
      disabled: false,
      dataset: {},
      children: [],
      childNodes: [],
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        contains(c) { return this._classes.has(c); }
      },
      _listeners: {},
      addEventListener(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
      },
      removeEventListener() {},
      appendChild(child) { this.children.push(child); this.childNodes.push(child); },
      after(child) {},
      closest(sel) { return null; },
      querySelector(sel) { return null; },
      querySelectorAll(sel) { return []; },
      remove() {},
      focus() {},
      click() {},
    };
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { appendChild() {}, style: {} }
};

const navigator = { onLine: true, serviceWorker: { register: () => Promise.resolve() } };
const window = {
  localStorage,
  navigator,
  addEventListener() {},
  removeEventListener() {},
  innerHeight: 800,
  innerWidth: 400,
  matchMedia: () => ({ matches: false }),
  visualViewport: null,
  requestAnimationFrame(fn) { fn(); }
};

// ── Load Code ───────────────────────────────────────────
const rootDir = path.resolve(__dirname, '..');
const code = loadAllModules(rootDir);

const sandbox = {
  console, setTimeout: (fn) => fn(), clearTimeout: () => {},
  setInterval: () => 0, clearInterval: () => {},
  document, window, navigator, localStorage,
  requestAnimationFrame: fn => fn(),
  indexedDB: null,
  IDBKeyRange: { bound: () => ({}) },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  Blob: class { constructor() {} },
  FileReader: class { readAsDataURL() {} },
  Image: class { set onload(fn) { fn(); } set src(v) {} get width() { return 100; } get height() { return 100; } },
  HTMLCanvasElement: { prototype: { getContext: () => ({}) } },
  crypto: { getRandomValues: (arr) => arr },
  structuredClone: (obj) => JSON.parse(JSON.stringify(obj)),
  alert: () => {},
  confirm: () => true,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(code, ctx, { filename: 'combined-modules.js' });
} catch (e) {
  // Some modules may have init errors in test env, that's OK
}

// ── Tests ───────────────────────────────────────────────

describe('getContextActions() – Kontext-Logik', () => {
  it('gibt ein Array zurück', () => {
    const actions = ctx.getContextActions();
    assert(Array.isArray(actions), 'Sollte ein Array sein');
  });

  it('gibt max 4 Buttons zurück', () => {
    const actions = ctx.getContextActions('general');
    assert(actions.length <= 4, `Maximal 4, aber ${actions.length} erhalten`);
  });

  it('greeting enthält Foto + Film', () => {
    const actions = ctx.getContextActions('greeting');
    const labels = actions.map(a => a.action);
    assert(labels.includes('takePhoto'), 'Sollte takePhoto enthalten');
    assert(labels.includes('takeVideo'), 'Sollte takeVideo enthalten');
  });

  it('greeting enthält Aufräumen wenn kein aktiver Quest', () => {
    const actions = ctx.getContextActions('greeting');
    const labels = actions.map(a => a.action);
    assert(labels.includes('startCleanup'), 'Sollte startCleanup enthalten');
  });

  it('photo_done enthält Ergebnis ansehen (primary)', () => {
    const actions = ctx.getContextActions('photo_done', { roomId: 'kueche' });
    const showResults = actions.find(a => a.action === 'showResults');
    assert(showResults !== undefined, 'Sollte showResults enthalten');
    assert(showResults.primary === true, 'showResults sollte primary sein');
  });

  it('photo_done enthält Nochmal fotografieren', () => {
    const actions = ctx.getContextActions('photo_done', { roomId: 'kueche', containerId: 'schrank' });
    const retake = actions.find(a => a.action === 'retakePhoto');
    assert(retake !== undefined, 'Sollte retakePhoto enthalten');
  });

  it('ask_for_photo hat Foto als primary', () => {
    const actions = ctx.getContextActions('ask_for_photo');
    const photo = actions.find(a => a.action === 'takePhoto');
    assert(photo !== undefined, 'Sollte takePhoto enthalten');
    assert(photo.primary === true, 'takePhoto sollte primary sein');
  });

  it('cleanup_done enthält 3 Optionen', () => {
    const actions = ctx.getContextActions('cleanup_done');
    assertEqual(actions.length, 3);
    const labels = actions.map(a => a.action);
    assert(labels.includes('startCleanup'), 'Sollte startCleanup enthalten');
    assert(labels.includes('takePhoto'), 'Sollte takePhoto enthalten');
    assert(labels.includes('showResults'), 'Sollte showResults enthalten');
  });

  it('offline hat nur Foto-Button', () => {
    const actions = ctx.getContextActions('offline');
    assertEqual(actions.length, 1);
    assertEqual(actions[0].action, 'takePhoto');
  });

  it('error enthält Foto-Fallback', () => {
    const actions = ctx.getContextActions('error');
    const photo = actions.find(a => a.action === 'takePhoto');
    assert(photo !== undefined, 'Sollte takePhoto als Fallback enthalten');
  });

  it('error mit retryAction enthält Nochmal-Button', () => {
    const actions = ctx.getContextActions('error', { retryAction: 'takePhoto' });
    const retry = actions.find(a => a.label === 'Nochmal versuchen');
    assert(retry !== undefined, 'Sollte Nochmal versuchen enthalten');
  });

  it('general (default) enthält Foto + Film + Live reden', () => {
    const actions = ctx.getContextActions('general');
    assertEqual(actions.length, 3);
    assertEqual(actions[0].action, 'takePhoto');
    assertEqual(actions[1].action, 'takeVideo');
    assertEqual(actions[2].action, 'startLive');
  });

  it('jede Action hat label, icon und action', () => {
    const contexts = ['greeting', 'photo_done', 'ask_for_photo', 'cleanup_done', 'offline', 'error', 'general'];
    for (const ctx_name of contexts) {
      const actions = ctx.getContextActions(ctx_name);
      for (const action of actions) {
        assert(typeof action.label === 'string' && action.label.length > 0,
          `${ctx_name}: label fehlt oder leer`);
        assert(typeof action.icon === 'string' && action.icon.length > 0,
          `${ctx_name}: icon fehlt oder leer`);
        assert(typeof action.action === 'string' && action.action.length > 0,
          `${ctx_name}: action fehlt oder leer`);
      }
    }
  });
});

describe('appendMessage() – Action Chips Rendering', () => {
  it('erstellt Bubble ohne Actions wenn keine übergeben', () => {
    elements['chat-messages'].children = [];
    const div = ctx.appendMessage('assistant', 'Test');
    assertEqual(div.children.length, 0);
  });

  it('erstellt Bubble mit Action Chips wenn Array übergeben', () => {
    elements['chat-messages'].children = [];
    const actions = [
      { label: 'Foto', icon: '📷', action: 'takePhoto' },
      { label: 'Film', icon: '🎥', action: 'takeVideo' },
    ];
    const div = ctx.appendMessage('assistant', 'Test', actions);
    assert(div.children.length > 0, 'Sollte Action-Row als Child haben');
    const actionsRow = div.children[0];
    assert(actionsRow.classList.contains('chat-actions-row'), 'Erste Child sollte chat-actions-row sein');
    assertEqual(actionsRow.children.length, 2);
  });

  it('markiert primary Chips korrekt', () => {
    elements['chat-messages'].children = [];
    const actions = [
      { label: 'Foto', icon: '📷', action: 'takePhoto', primary: true },
    ];
    const div = ctx.appendMessage('assistant', 'Test', actions);
    const chip = div.children[0].children[0];
    assert(chip.classList.contains('primary'), 'Sollte primary Klasse haben');
  });

  it('erstellt keine Actions für User-Nachrichten', () => {
    elements['chat-messages'].children = [];
    const actions = [{ label: 'Foto', icon: '📷', action: 'takePhoto' }];
    const div = ctx.appendMessage('user', 'Test', actions);
    assertEqual(div.children.length, 0);
  });

  it('Boolean true wird als thinking behandelt (nicht als actions)', () => {
    elements['chat-messages'].children = [];
    const div = ctx.appendMessage('assistant', 'Test', true);
    assert(div.className.includes('chat-msg--thinking'), 'Sollte thinking Klasse haben');
    assertEqual(div.children.length, 0);
  });
});

describe('showSystemMessage() – mit Actions', () => {
  it('delegiert an appendMessage mit system role', () => {
    elements['chat-messages'].children = [];
    const actions = [{ label: 'Foto', icon: '📷', action: 'takePhoto' }];
    const div = ctx.showSystemMessage('Test', actions);
    assert(div.className.includes('chat-msg--system'), 'Sollte system Klasse haben');
    assert(div.children.length > 0, 'Sollte Action-Row haben');
  });

  it('funktioniert ohne Actions (backwards compatible)', () => {
    elements['chat-messages'].children = [];
    const div = ctx.showSystemMessage('Test');
    assert(div.className.includes('chat-msg--system'), 'Sollte system Klasse haben');
    assertEqual(div.children.length, 0);
  });
});

// ── Print ───────────────────────────────────────────────
const success = printResults();
process.exit(success ? 0 : 1);
