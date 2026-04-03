// proxy-gateway.test.js – Tests für Proxy-Gateway + Zero-Key-Onboarding
// Ausführen: node tests/proxy-gateway.test.js

const { describe, it, assert, assertEqual, assertDeepEqual, printResults } = require('./test-runner');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadAllModules } = require('./module-loader');

// ── Mock: Browser-APIs ────────���─────────────────────────
const storage = {};
const localStorage = {
  getItem(key) { return storage[key] || null; },
  setItem(key, value) { storage[key] = String(value); },
  removeItem(key) { delete storage[key]; },
  clear() { Object.keys(storage).forEach(k => delete storage[k]); }
};

const mockElements = {};
function createMockElement(id) {
  return {
    id,
    style: { display: '' },
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c, force) { force ? this._classes.add(c) : this._classes.delete(c); },
      contains(c) { return this._classes.has(c); }
    },
    innerHTML: '',
    textContent: '',
    value: '',
    dataset: {},
    children: [],
    hidden: false,
    disabled: false,
    _listeners: {},
    addEventListener(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(child) { this.children.push(child); },
    remove() {},
    click() {},
    focus() {},
    select() {},
    setAttribute() {},
    getBoundingClientRect() { return { width: 375, height: 600, left: 0, top: 0 }; },
    scrollTop: 0,
    scrollHeight: 0,
    get complete() { return true; },
    naturalWidth: 800,
    naturalHeight: 600,
    src: '',
    alt: '',
    open: false
  };
}

const document = {
  getElementById(id) {
    if (!mockElements[id]) mockElements[id] = createMockElement(id);
    return mockElements[id];
  },
  querySelector() { return createMockElement('mock'); },
  querySelectorAll() { return []; },
  createElement(tag) {
    return {
      ...createMockElement('dynamic'),
      tagName: tag.toUpperCase(),
      className: '',
      appendChild(child) {},
      addEventListener() {}
    };
  },
  addEventListener() {},
  body: { appendChild() {} }
};

const dispatchedEvents = [];
const window = {
  location: { search: '', origin: 'https://example.com', pathname: '/', reload() {} },
  indexedDB: undefined,
  SpeechRecognition: undefined,
  webkitSpeechRecognition: undefined,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent(e) { dispatchedEvents.push(e); },
};

const navigator = {
  onLine: true,
  serviceWorker: { register() { return Promise.resolve(); }, addEventListener() {} },
  clipboard: { writeText() { return Promise.resolve(); } }
};

// Mock crypto.randomUUID
const crypto = {
  randomUUID() { return 'test-uuid-1234-5678-abcdefghijkl'; }
};

// ── Alle Module laden ──────���────────────────────────────
const rootDir = path.join(__dirname, '..');
const allCode = loadAllModules(rootDir);

const context = vm.createContext({
  localStorage, indexedDB: undefined, window: { ...window, indexedDB: undefined },
  crypto,
  Date, JSON, Object, Array, Math, parseInt, console, Error, Promise,
  fetch: () => Promise.reject(new Error('not available')),
  confirm: () => true, document, navigator,
  URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
  Image: class { onload() {} onerror() {} set src(v) { this.onload(); } },
  FileReader: class { onload() {} readAsDataURL() { this.onload({ target: { result: 'data:image/jpeg;base64,/9j/' } }); } },
  setTimeout: (fn, ms) => fn(),
  clearTimeout() {},
  setInterval() { return 0; },
  clearInterval() {},
  requestAnimationFrame: (fn) => fn(),
  alert() {},
  prompt() { return null; },
  Blob: class {},
  HTMLCanvasElement: class {},
  NDEFReader: undefined,
  CustomEvent: class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  },
  AbortController: class {
    constructor() { this.signal = {}; }
    abort() {}
  },
  AbortSignal: { timeout() { return {}; } },
});

vm.runInContext(allCode, context);

function resetAll() {
  localStorage.clear();
  context.Brain.init();
  dispatchedEvents.length = 0;
}

// ══��═══════════════════════════════════════════════════════
// TESTS
// ��═══════════════���═════════════════════════════════════════

console.log('\u26A1 Proxy-Gateway + Zero-Key Tests\n' + '\u2550'.repeat(50));

// ── getProviderConfig ────────────────────────────────────
describe('getProviderConfig() – Provider-Routing', () => {
  const getProviderConfig = context.getProviderConfig;

  it('gibt "proxy" als Primary zurück wenn kein Key gesetzt', () => {
    resetAll();
    const config = getProviderConfig();
    assertEqual(config.primary, 'proxy');
  });

  it('gibt "gemini" als Primary zurück wenn Key vorhanden', () => {
    resetAll();
    localStorage.setItem('ordo_api_key', 'AIzaTestKey1234567890');
    const config = getProviderConfig();
    assertEqual(config.primary, 'gemini');
  });

  it('hat "proxy" als Fallback wenn Key vorhanden', () => {
    resetAll();
    localStorage.setItem('ordo_api_key', 'AIzaTestKey1234567890');
    const config = getProviderConfig();
    assert(config.fallbacks.includes('proxy'), 'proxy should be in fallbacks');
  });

  it('nutzt gespeicherte Provider-Config wenn vorhanden', () => {
    resetAll();
    const custom = { primary: 'openrouter', fallbacks: ['gemini'], keys: { openrouter: 'test' } };
    localStorage.setItem('ordo_providers', JSON.stringify(custom));
    const config = getProviderConfig();
    assertEqual(config.primary, 'openrouter');
  });
});

// ── getSessionId ────��────────────────────────────────────
describe('getSessionId() – Session-ID Verwaltung', () => {
  const getSessionId = context.getSessionId;

  it('generiert UUID und speichert sie', () => {
    resetAll();
    const sid = getSessionId();
    assertEqual(sid, 'test-uuid-1234-5678-abcdefghijkl');
    assertEqual(localStorage.getItem('ordo_session_id'), sid);
  });

  it('gibt bestehende Session-ID zurück', () => {
    resetAll();
    localStorage.setItem('ordo_session_id', 'existing-session-id');
    const sid = getSessionId();
    assertEqual(sid, 'existing-session-id');
  });
});

// ── PROVIDERS ────────────────────────────────────────────
describe('PROVIDERS – Proxy Provider', () => {
  const PROVIDERS = context.PROVIDERS;

  it('hat einen proxy Provider', () => {
    assert(PROVIDERS.proxy, 'proxy provider should exist');
  });

  it('proxy Provider hat format "proxy"', () => {
    assertEqual(PROVIDERS.proxy.format, 'proxy');
  });

  it('proxy Provider heißt "ORDO Cloud"', () => {
    assertEqual(PROVIDERS.proxy.name, 'ORDO Cloud');
  });

  it('gemini Provider existiert weiterhin', () => {
    assert(PROVIDERS.gemini, 'gemini provider should still exist');
    assertEqual(PROVIDERS.gemini.format, 'gemini');
  });
});

// ── setProviderConfig ────────────────────────────────────
describe('setProviderConfig() – Provider-Config speichern', () => {
  const setProviderConfig = context.setProviderConfig;
  const getProviderConfig = context.getProviderConfig;

  it('speichert und lädt Config korrekt', () => {
    resetAll();
    const config = { primary: 'gemini', fallbacks: ['proxy'], keys: {} };
    setProviderConfig(config);
    const loaded = getProviderConfig();
    assertEqual(loaded.primary, 'gemini');
    assert(loaded.fallbacks.includes('proxy'), 'should include proxy fallback');
  });
});

// ── Rate-Limit Event ─────────────────────────────────────
describe('_emitRemainingQuota – Event Emission', () => {
  it('feuert ordo-proxy-quota Event', () => {
    resetAll();
    // _emitRemainingQuota ist private, testen über Seiteneffekt
    // Das Event wird in _callProxyFormat nach der Response gefeuert
    // Hier testen wir nur dass die Funktion existiert und keinen Fehler wirft
    try {
      context._emitRemainingQuota(42);
      assert(true, 'should not throw');
    } catch (e) {
      assert(false, 'should not throw: ' + e.message);
    }
  });
});

// ── App Start Logic ──────────────────────────────────────
describe('App Start Logic – Zero-Key', () => {
  it('prüft ordo_onboarding_completed statt API-Key', () => {
    // Lese app.js und prüfe dass kein hasApiKey Check mehr da ist
    const appCode = fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8');
    assert(!appCode.includes("const hasApiKey = !!localStorage.getItem('ordo_api_key')"),
      'app.js should not check for API key at startup');
    assert(appCode.includes('isFirstStart'),
      'app.js should use isFirstStart flag');
  });
});

// ── Onboarding ───────────────────────────────────────────
describe('Onboarding – Zero-Key Flow', () => {
  it('startOnboarding existiert und erwähnt keinen API-Key', () => {
    const agentCode = fs.readFileSync(path.join(rootDir, 'ordo-agent.js'), 'utf8');
    // Finde die startOnboarding Funktion
    const match = agentCode.match(/export function startOnboarding\(\)[^}]*\{[\s\S]*?^}/m);
    assert(match, 'startOnboarding should exist');
    assert(!match[0].includes('API-Key'), 'startOnboarding should not mention API-Key');
    assert(!match[0].includes('onboardingStep2'), 'startOnboarding should not reference onboardingStep2');
  });
});

// ── UI Blocks (source-level check) ───────────────────────
describe('UI Blocks – Neue Blöcke', () => {
  const blocksCode = fs.readFileSync(path.join(rootDir, 'ui-blocks.js'), 'utf8');

  it('RateLimitCard ist registriert', () => {
    assert(blocksCode.includes("registerBlock('RateLimitCard'"),
      'ui-blocks.js should register RateLimitCard');
  });

  it('ApiKeyUpgrade ist registriert', () => {
    assert(blocksCode.includes("registerBlock('ApiKeyUpgrade'"),
      'ui-blocks.js should register ApiKeyUpgrade');
  });

  it('RateLimitCard zeigt Tageslimit-Info', () => {
    assert(blocksCode.includes('rate-limit-title'),
      'RateLimitCard should have title element');
    assert(blocksCode.includes('rate-limit-upgrade'),
      'RateLimitCard should have upgrade section');
  });

  it('ApiKeyUpgrade hat Input-Feld und Test-Button', () => {
    assert(blocksCode.includes('upgrade-key-field'),
      'ApiKeyUpgrade should have key input field');
    assert(blocksCode.includes('upgrade-key-submit'),
      'ApiKeyUpgrade should have submit button');
  });
});

// ══════════════════════════════════════════════════════════
// ERGEBNIS
// ══════════════════════��═══════════════════════════════════

const success = printResults();
process.exit(success ? 0 : 1);
