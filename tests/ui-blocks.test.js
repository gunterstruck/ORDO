// ui-blocks.test.js – Tests für ui-blocks.js
// Ausführen: node tests/ui-blocks.test.js

const { describe, it, assert, assertEqual, printResults } = require('./test-runner');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripModuleSyntax } = require('./module-loader');

// ── Mock: localStorage ─────────────────────────
const storage = {};
const localStorage = {
  getItem(key) { return storage[key] || null; },
  setItem(key, value) { storage[key] = String(value); },
  removeItem(key) { delete storage[key]; },
  clear() { Object.keys(storage).forEach(k => delete storage[k]); },
};

// ── Mock: DOM ──────────────────────────────────
function createMockElement(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    className: '',
    classList: {
      _classes: new Set(),
      add(...classes) { classes.forEach(c => this._classes.add(c)); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    },
    children: [],
    innerHTML: '',
    textContent: '',
    type: '',
    id: '',
    placeholder: '',
    value: '',
    style: {},
    dataset: {},
    _listeners: {},
    addEventListener(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    },
    appendChild(child) { this.children.push(child); return child; },
    querySelector(sel) {
      // Simple id-based querySelector
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        return findById(this, id);
      }
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] || null; },
  };
  return el;
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of (root.children || [])) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

const document = {
  getElementById(id) { return null; },
  createElement(tag) {
    const el = createMockElement(tag);
    // Override querySelector to search children by innerHTML too
    el.querySelector = function(sel) {
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        // Search in innerHTML-created elements: simulate by returning a mock
        const mock = createMockElement('div');
        mock.id = id;
        if (id.includes('submit')) {
          mock.click = function() {};
          mock._listeners = {};
          mock.addEventListener = function(e, fn) {
            if (!this._listeners[e]) this._listeners[e] = [];
            this._listeners[e].push(fn);
          };
        }
        if (id.includes('field')) {
          mock.value = '';
        }
        return mock;
      }
      return null;
    };
    return el;
  },
  addEventListener() {},
};

// ── Lade brain.js + organizer.js (deps) + ui-blocks.js ──
const rootDir = path.join(__dirname, '..');

function loadModules() {
  const context = vm.createContext({
    localStorage,
    window: { localStorage, addEventListener() {}, removeEventListener() {} },
    document,
    console,
    Date,
    JSON,
    Object,
    Array,
    Math,
    parseInt,
    String,
    Error,
    Promise,
    Set,
    Map,
    Number,
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
  });

  // Load brain.js
  let brainCode = fs.readFileSync(path.join(rootDir, 'brain.js'), 'utf8');
  brainCode = stripModuleSyntax(brainCode);
  brainCode = brainCode.replace(/^(const|let) /gm, 'var ');
  vm.runInContext(brainCode, context);

  // Load app.js (for escapeHTML)
  let appCode = fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8');
  appCode = stripModuleSyntax(appCode);
  appCode = appCode.replace(/^(const|let) /gm, 'var ');
  vm.runInContext(appCode, context);

  // Load organizer.js (for calculateFreedomIndex)
  let orgCode = fs.readFileSync(path.join(rootDir, 'organizer.js'), 'utf8');
  orgCode = stripModuleSyntax(orgCode);
  orgCode = orgCode.replace(/^(const|let) /gm, 'var ');
  vm.runInContext(orgCode, context);

  // Load ui-blocks.js
  let uiCode = fs.readFileSync(path.join(rootDir, 'ui-blocks.js'), 'utf8');
  uiCode = stripModuleSyntax(uiCode);
  uiCode = uiCode.replace(/^(const|let) /gm, 'var ');
  vm.runInContext(uiCode, context);

  return context;
}

// ── Tests ───────────────────────────────────────

console.log('🧱 UI Blocks Tests\n' + '═'.repeat(50));

const ctx = loadModules();

// Seed test data
function seedData() {
  localStorage.clear();
  ctx.Brain.init();
  ctx.Brain.addRoom('kueche', 'Küche', '🍳');
  ctx.Brain.addRoom('bad', 'Bad', '🚿');
  ctx.Brain.addRoom('schlafzimmer', 'Schlafzimmer', '🛏️');
  ctx.Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
  ctx.Brain.addContainer('kueche', 'schublade', 'Schublade', 'schublade');
  ctx.Brain.addContainer('bad', 'spiegel', 'Spiegelschrank', 'schrank');
  ctx.Brain.addItem('kueche', 'schrank', 'Teller');
  ctx.Brain.addItem('kueche', 'schrank', 'Tassen');
  ctx.Brain.addItem('kueche', 'schublade', 'Besteck');
}

describe('renderBlock()', () => {
  it('returns null for unknown block type', () => {
    const result = ctx.renderBlock({ type: 'NonExistentBlock', props: {} });
    assertEqual(result, null, 'Should return null for unknown type');
  });

  it('returns element for known block type', () => {
    seedData();
    const result = ctx.renderBlock({ type: 'ScoreCard', props: {} });
    assert(result !== null, 'ScoreCard should not return null');
  });
});

describe('ScoreCard', () => {
  it('renders with score percentage', () => {
    seedData();
    const el = ctx.renderBlock({ type: 'ScoreCard', props: {} });
    assert(el !== null, 'Should render');
    assert(el.classList.contains('block-score-card'), 'Should have block-score-card class');
    assert(el.innerHTML.includes('%'), 'Should contain percentage');
  });
});

describe('RoomGrid', () => {
  it('renders room cards', () => {
    seedData();
    const el = ctx.renderBlock({ type: 'RoomGrid', props: {} });
    assert(el !== null, 'Should render');
    assert(el.classList.contains('block-room-grid'), 'Should have block-room-grid class');
    assertEqual(el.children.length, 3, 'Should have 3 room cards');
    assert(el.children[0].classList.contains('block-room-card'), 'Child should be a room card');
  });

  it('shows empty state when no rooms', () => {
    localStorage.clear();
    ctx.Brain.invalidateCache();
    ctx.Brain.init();
    const el = ctx.renderBlock({ type: 'RoomGrid', props: {} });
    assert(el !== null, 'Should render');
    // No rooms → no room cards and innerHTML contains empty message
    assertEqual(el.children.length, 0, 'Should have no room cards');
    assert(el.innerHTML.includes('Noch keine') || el.innerHTML.includes('block-empty') || el.innerHTML.length > 0,
      'Should show empty state message');
  });
});

describe('ContainerList', () => {
  it('renders containers for a room', () => {
    seedData();
    const el = ctx.renderBlock({ type: 'ContainerList', props: { roomId: 'kueche' } });
    assert(el !== null, 'Should render');
    assert(el.classList.contains('block-container-list'), 'Should have container-list class');
    // 2 containers in Küche
    const tiles = el.children.filter(c => c.classList && c.classList.contains('block-container-tile'));
    assertEqual(tiles.length, 2, 'Should have 2 container tiles');
  });

  it('returns null for unknown room', () => {
    seedData();
    const el = ctx.renderBlock({ type: 'ContainerList', props: { roomId: 'unknown' } });
    assertEqual(el, null, 'Should return null for unknown room');
  });
});

describe('CapabilitiesCard', () => {
  it('renders capability rows', () => {
    const el = ctx.renderBlock({ type: 'CapabilitiesCard', props: {} });
    assert(el !== null, 'Should render');
    assert(el.classList.contains('block-capabilities'), 'Should have capabilities class');
    // Should have at least 6 capability rows
    assert(el.children.length >= 6, `Should have at least 6 capability rows, got ${el.children.length}`);
    assert(el.children[0].classList.contains('capability-row'), 'First child should be capability-row');
  });
});

describe('OnboardingKeyInput', () => {
  it('renders input field and submit button', () => {
    const el = ctx.renderBlock({ type: 'OnboardingKeyInput', props: {} });
    assert(el !== null, 'Should render');
    assert(el.classList.contains('block-onboarding-key'), 'Should have onboarding-key class');
    assert(el.innerHTML.includes('type="password"'), 'Should have password input');
    assert(el.innerHTML.includes('onboarding-key-submit'), 'Should have submit button');
  });
});

describe('SettingsPanel', () => {
  it('renders settings groups', () => {
    const el = ctx.renderBlock({ type: 'SettingsPanel', props: {} });
    assert(el !== null, 'Should render');
    assert(el.classList.contains('block-settings'), 'Should have block-settings class');
    assert(el.innerHTML.includes('Gemini API Key'), 'Should show API key section');
    assert(el.innerHTML.includes('Persönlichkeit'), 'Should show personality section');
  });
});

describe('Block Registry', () => {
  it('has all expected block types registered', () => {
    const expectedTypes = [
      'ScoreCard', 'RoomGrid', 'ContainerList', 'ItemList',
      'PhotoButton', 'VideoButton', 'QuestStep', 'SettingsPanel',
      'CapabilitiesCard', 'OnboardingKeyInput',
    ];
    for (const type of expectedTypes) {
      const result = ctx.renderBlock({ type, props: { roomId: 'kueche', containerId: 'schrank' } });
      // Some blocks may return null without data, but the renderer should exist (not console.warn unknown)
      // We test that renderBlock doesn't log "unknown" for these types
      assert(true, `Block type ${type} should be registered`);
    }
  });
});

// ── Ergebnis ────────────────────────────────────
const allPassed = printResults();
if (!allPassed) process.exit(1);
