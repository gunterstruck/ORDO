// ordo-agent.test.js – Tests für ordo-agent.js
// Ausführen: node tests/ordo-agent.test.js

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

// ── Mock: DOM + Stream ─────────────────────────
const streamMessages = [];

function createMockElement(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    classList: {
      _classes: new Set(),
      add(...classes) { classes.forEach(c => this._classes.add(c)); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    },
    children: [],
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    id: '',
    value: '',
    type: '',
    _listeners: {},
    addEventListener(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    },
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute() {},
    scrollTo() {},
  };
  return el;
}

const streamContainer = createMockElement('div');
streamContainer.id = 'dialog-stream';
streamContainer.appendChild = function(child) {
  this.children.push(child);
  streamMessages.push(child);
  return child;
};

const document = {
  getElementById(id) {
    if (id === 'dialog-stream') return streamContainer;
    return null;
  },
  createElement(tag) { return createMockElement(tag); },
  addEventListener() {},
  querySelectorAll() { return []; },
};

// ── Load ordo-agent.js with stubs ──────────────

function loadAgent() {
  const context = vm.createContext({
    localStorage,
    window: {
      localStorage,
      addEventListener() {},
      removeEventListener() {},
    },
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
    Boolean,
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
    Blob: class { constructor(parts, opts) { this.size = 100; this.type = opts?.type || ''; } },
    URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
  });

  // Stub all dependencies
  vm.runInContext(`
    // Brain stub
    var _brainData = { version: '1.5', rooms: {}, chat_history: [], quest: null, last_updated: Date.now() };
    var Brain = {
      _cache: null,
      getData() { return _brainData; },
      getQuest() { return _brainData.quest; },
      getApiKey() { return localStorage.getItem('ordo_api_key'); },
      getRoom(id) { return (_brainData.rooms || {})[id] || null; },
      getRooms() { return _brainData.rooms || {}; },
      addChatMessage() {},
      getChatHistory() { return _brainData.chat_history || []; },
      setApiKey(k) { localStorage.setItem('ordo_api_key', k); },
      save() { _brainData.last_updated = Date.now(); },
      buildContext() { return ''; },
      getExpiringItems(days) { return []; },
      invalidateCache() { this._cache = null; },
      init() {
        _brainData = { version: '1.5', rooms: {}, chat_history: [], quest: null, last_updated: Date.now() };
      },
      addRoom(id, name, emoji) {
        _brainData.rooms[id] = { name, emoji, containers: {} };
      },
      addContainer(roomId, cId, name, type) {
        if (_brainData.rooms[roomId]) {
          _brainData.rooms[roomId].containers[cId] = { name, type, items: [] };
        }
      },
    };

    // dialog-stream stubs
    var _streamCalls = [];
    function agentMessage(text, blocks, actions) {
      var msg = document.createElement('div');
      msg.classList.add('stream-msg', 'stream-agent');
      msg.textContent = text || '';
      msg._blocks = blocks || [];
      msg._actions = actions || [];
      var container = document.getElementById('dialog-stream');
      if (container) container.appendChild(msg);
      _streamCalls.push({ type: 'agent', text, blocks: blocks || [], actions: actions || [] });
      return msg;
    }
    function userMessage(text) {
      var msg = document.createElement('div');
      msg.classList.add('stream-msg', 'stream-user');
      msg.textContent = text;
      var container = document.getElementById('dialog-stream');
      if (container) container.appendChild(msg);
      _streamCalls.push({ type: 'user', text });
      return msg;
    }
    function systemMessage(text) {
      _streamCalls.push({ type: 'system', text });
      return document.createElement('div');
    }
    function showStreamLoading(text) {
      _streamCalls.push({ type: 'loading', text });
      return document.createElement('div');
    }
    function hideStreamLoading() {}
    function clearStream() {
      var c = document.getElementById('dialog-stream');
      if (c) c.innerHTML = '';
    }

    // organizer stubs
    function calculateFreedomIndex() { return { percent: 50, totalDebt: 5 }; }
    function getQuickWins() { return []; }

    // local-intents stubs
    function checkLocalIntent() { return null; }
    function executeLocalIntent() { return null; }

    // chat stubs
    function getPersonality() { return localStorage.getItem('ordo_personality') || 'kauzig'; }
    function getPersonalityPrompt() { return ''; }

    // ai stubs
    var callGemini = async function() { return { text: 'ok' }; };
    var ORDO_FUNCTIONS = [];
    function functionCallToAction() { return null; }
    function processMarkers(t) { return { cleanText: t, actions: [] }; }
    function executeOrdoAction() {}
    function normalizeOrdoAction(a) { return a; }
    function buildMessages(h) { return h; }
    var loadingManager = {};
    function getErrorMessage(e) { return e.message || 'Fehler'; }

    // session-log stubs
    function logAction() {}
    function getLastActivityTime() { return null; }
    function touchActivity() {}

    // renderBlock stub
    function renderBlock(b) {
      if (!b || !b.type) return null;
      var el = document.createElement('div');
      el.textContent = b.type;
      return el;
    }
  `, context);

  // Load ordo-agent.js (strip imports/exports AND dynamic imports)
  let code = fs.readFileSync(path.join(__dirname, '..', 'ordo-agent.js'), 'utf8');
  // Strip all import statements (including multi-line: import { ... \n ... } from '...')
  code = code.replace(/import\s+(?:\{[\s\S]*?\}|[\w]+)\s+from\s*['"][^'"]*['"];?/g, '');
  code = stripModuleSyntax(code);
  code = code.replace(/^(const|let) /gm, 'var ');
  // Replace dynamic import() calls with no-ops that return stubs
  code = code.replace(/await import\(['"]\.\/([^'"]+)['"]\)/g, (match, mod) => {
    return `({ startSmartPhotoCapture: function(){}, captureVideo: function(){}, startCleanupQuest: function(){}, showCurrentStep: function(){}, showExpiryOverview: function(){}, showWarrantyOverview: function(){}, showReportDialog: function(){}, setPersonality: function(v){ localStorage.setItem('ordo_personality', v); }, exportData: function(){}, showItemDetailPanel: function(){}, handleAction: typeof handleAction === 'function' ? handleAction : function(){} })`;
  });

  vm.runInContext(code, context);
  return context;
}

function resetAll() {
  localStorage.clear();
  streamContainer.children = [];
  streamContainer.innerHTML = '';
  streamMessages.length = 0;
}

// ── Tests ───────────────────────────────────────

console.log('🤖 ORDO Agent Tests\n' + '═'.repeat(50));

const ctx = loadAgent();

describe('companionSays()', () => {
  it('returns text for active personality', () => {
    localStorage.setItem('ordo_personality', 'kauzig');
    const result = ctx.companionSays({
      sachlich: 'A',
      freundlich: 'B',
      kauzig: 'C',
    });
    assertEqual(result, 'C', 'Should return kauzig variant');
  });

  it('returns sachlich variant', () => {
    localStorage.setItem('ordo_personality', 'sachlich');
    const result = ctx.companionSays({
      sachlich: 'Sachlich text',
      freundlich: 'Freundlich text',
      kauzig: 'Kauzig text',
    });
    assertEqual(result, 'Sachlich text');
  });

  it('falls back to kauzig if personality not found', () => {
    localStorage.setItem('ordo_personality', 'nonexistent');
    const result = ctx.companionSays({
      sachlich: 'A',
      freundlich: 'B',
      kauzig: 'C',
    });
    assertEqual(result, 'C', 'Should fall back to kauzig');
  });
});

describe('startOnboarding()', () => {
  it('shows static messages without API call', () => {
    resetAll();
    ctx.startOnboarding();
    const calls = ctx._streamCalls;
    assert(calls.length >= 2, 'Should have at least 2 stream calls');
    assert(calls[0].type === 'agent', 'First call should be agent message');
    assert(calls[0].text.includes('ORDO'), 'First message should mention ORDO');
  });

  it('second message has startFirstPhoto action (Zero-Key)', () => {
    resetAll();
    ctx._streamCalls = [];
    ctx.startOnboarding();
    const calls = ctx._streamCalls;
    assert(calls.length >= 2, 'Should have at least 2 messages');
    const secondMsg = calls[1];
    assert(secondMsg.actions.length > 0, 'Second message should have actions');
    assertEqual(secondMsg.actions[0].action, 'startFirstPhoto', 'Action should be startFirstPhoto');
  });
});

describe('showContextGreeting()', () => {
  it('renders for returning user with rooms', () => {
    resetAll();
    ctx._streamCalls = [];
    ctx._brainData = {
      version: '1.5',
      rooms: { kueche: { name: 'Küche', emoji: '🍳', containers: { s: { name: 'Schrank', items: ['Teller'] } } } },
      chat_history: [],
      quest: null,
      last_updated: Date.now(),
    };
    localStorage.setItem('ordo_onboarding_completed', 'true');
    localStorage.setItem('ordo_personality', 'kauzig');
    ctx.showContextGreeting();
    const calls = ctx._streamCalls;
    assert(calls.length >= 1, 'Should show greeting message');
    assert(calls[0].type === 'agent', 'Should be agent message');
  });

  it('includes quest button if active quest', () => {
    resetAll();
    ctx._streamCalls = [];
    ctx._brainData = {
      version: '1.5',
      rooms: { kueche: { name: 'Küche', emoji: '🍳', containers: {} } },
      chat_history: [],
      quest: { active: true, type: 'cleanup', plan: [] },
      last_updated: Date.now(),
    };
    localStorage.setItem('ordo_onboarding_completed', 'true');
    ctx.showContextGreeting();
    const calls = ctx._streamCalls;
    assert(calls.length >= 1, 'Should show greeting');
    const actions = calls[0].actions;
    const questAction = actions.find(a => a.action === 'resumeQuest');
    assert(questAction, 'Should include resumeQuest action');
  });

  it('shows pending_photo message for incomplete onboarding', () => {
    resetAll();
    ctx._streamCalls = [];
    ctx._brainData = { version: '1.5', rooms: {}, chat_history: [], quest: null, last_updated: Date.now() };
    localStorage.setItem('ordo_onboarding_completed', 'pending_photo');
    ctx.showContextGreeting();
    const calls = ctx._streamCalls;
    assert(calls.length >= 1, 'Should show message');
    assert(calls[0].text.includes('Foto'), 'Should mention photo');
  });
});

describe('handleAction()', () => {
  // handleAction is async — these cases trigger synchronous code paths
  // (showHome, showSettings, showCapabilities don't await external resources)
  it('showHome renders with blocks', () => {
    resetAll();
    ctx._streamCalls = [];
    ctx._brainData = {
      version: '1.5',
      rooms: { kueche: { name: 'Küche', emoji: '🍳', containers: { s: { name: 'Schrank', items: [] } } } },
      chat_history: [],
      quest: null,
      last_updated: Date.now(),
    };
    // handleAction is async but showHome internally is sync
    ctx.handleAction({ action: 'showHome' });
    const calls = ctx._streamCalls;
    assert(calls.length >= 1, 'Should have at least 1 message');
    const homeCall = calls.find(c => c.blocks && c.blocks.some(b => b.type === 'ScoreCard'));
    assert(homeCall, 'Should contain ScoreCard block');
  });

  it('showSettings renders SettingsPanel', () => {
    resetAll();
    ctx._streamCalls = [];
    ctx.handleAction({ action: 'showSettings' });
    const calls = ctx._streamCalls;
    assert(calls.length >= 1, 'Should show settings');
    const settingsCall = calls.find(c => c.blocks && c.blocks.some(b => b.type === 'SettingsPanel'));
    assert(settingsCall, 'Should contain SettingsPanel block');
  });

  it('showCapabilities renders CapabilitiesCard', () => {
    resetAll();
    ctx._streamCalls = [];
    ctx.handleAction({ action: 'showCapabilities' });
    const calls = ctx._streamCalls;
    assert(calls.length >= 1, 'Should show capabilities');
    const capCall = calls.find(c => c.blocks && c.blocks.some(b => b.type === 'CapabilitiesCard'));
    assert(capCall, 'Should contain CapabilitiesCard block');
  });

  it('retry shows smart actions', () => {
    resetAll();
    ctx._streamCalls = [];
    localStorage.setItem('ordo_personality', 'kauzig');
    ctx.handleAction({ action: 'retry' });
    const calls = ctx._streamCalls;
    assert(calls.length >= 1, 'Should show retry message');
    assert(calls[0].actions.length > 0, 'Should have actions');
  });
});

// ── Ergebnis ────────────────────────────────────
const allPassed = printResults();
if (!allPassed) process.exit(1);
