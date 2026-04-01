// dialog-stream.test.js – Tests für dialog-stream.js
// Ausführen: node tests/dialog-stream.test.js

const { describe, it, assert, assertEqual, printResults } = require('./test-runner');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripModuleSyntax } = require('./module-loader');

// ── Mock: DOM ──────────────────────────────────
const elements = {};

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
    childNodes: [],
    innerHTML: '',
    textContent: '',
    _listeners: {},
    addEventListener(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    },
    appendChild(child) { this.children.push(child); this.childNodes.push(child); return child; },
    remove() {
      if (this._parent) {
        this._parent.children = this._parent.children.filter(c => c !== this);
      }
    },
    get parentNode() { return this._parent || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollTo() {},
  };
  return el;
}

const streamContainer = createMockElement('div');
streamContainer.id = 'dialog-stream';

const document = {
  getElementById(id) {
    if (id === 'dialog-stream') return streamContainer;
    return null;
  },
  createElement(tag) {
    const el = createMockElement(tag);
    // Track parent when appended
    const origAppend = el.appendChild.bind(el);
    el.appendChild = function(child) {
      child._parent = el;
      return origAppend(child);
    };
    return el;
  },
  addEventListener() {},
};

// ── Lade dialog-stream.js + ui-blocks.js stub ──
function loadDialogStream() {
  // Stub renderBlock
  const uiBlocksStub = 'function renderBlock(block) { if (!block || !block.type) return null; var el = document.createElement("div"); el.textContent = block.type; return el; }';

  let dsCode = fs.readFileSync(path.join(__dirname, '..', 'dialog-stream.js'), 'utf8');
  dsCode = stripModuleSyntax(dsCode);
  dsCode = dsCode.replace(/^(const|let) /gm, 'var ');

  const context = vm.createContext({
    document,
    console,
    requestAnimationFrame: (fn) => fn(),
  });

  vm.runInContext(uiBlocksStub, context);
  vm.runInContext(dsCode, context);
  return context;
}

// ── Hilfsfunktionen ─────────────────────────────

function resetStream() {
  streamContainer.children = [];
  streamContainer.childNodes = [];
  streamContainer.innerHTML = '';
}

// ── Tests ───────────────────────────────────────

console.log('💬 Dialog Stream Tests\n' + '═'.repeat(50));

const ctx = loadDialogStream();

describe('agentMessage()', () => {
  it('adds agent bubble to stream', () => {
    resetStream();
    ctx.agentMessage('Hallo', [], []);
    assert(streamContainer.children.length === 1, 'Should have 1 child');
    const msg = streamContainer.children[0];
    assert(msg.classList.contains('stream-agent'), 'Should have stream-agent class');
    assert(msg.classList.contains('stream-msg'), 'Should have stream-msg class');
  });

  it('renders text content', () => {
    resetStream();
    ctx.agentMessage('Test Nachricht', [], []);
    const msg = streamContainer.children[0];
    // First child should be the text div
    assert(msg.children.length >= 1, 'Should have at least 1 child element');
    const textEl = msg.children[0];
    assert(textEl.classList.contains('stream-text'), 'Text element should have stream-text class');
    assertEqual(textEl.textContent, 'Test Nachricht');
  });

  it('renders action buttons', () => {
    resetStream();
    ctx.agentMessage('', [], [
      { icon: '📷', label: 'Foto', action: 'takePhoto' },
      { icon: '🏠', label: 'Home', action: 'showHome' },
    ]);
    const msg = streamContainer.children[0];
    // Should have an action row
    const actionRow = msg.children.find(c => c.classList && c.classList.contains('stream-actions'));
    assert(actionRow, 'Should have action row');
    assertEqual(actionRow.children.length, 2, 'Should have 2 action buttons');
  });

  it('limits actions to max 4', () => {
    resetStream();
    const actions = [
      { icon: '1', label: 'A1', action: 'a1' },
      { icon: '2', label: 'A2', action: 'a2' },
      { icon: '3', label: 'A3', action: 'a3' },
      { icon: '4', label: 'A4', action: 'a4' },
      { icon: '5', label: 'A5', action: 'a5' },
      { icon: '6', label: 'A6', action: 'a6' },
    ];
    ctx.agentMessage('', [], actions);
    const msg = streamContainer.children[0];
    const actionRow = msg.children.find(c => c.classList && c.classList.contains('stream-actions'));
    assert(actionRow, 'Should have action row');
    assert(actionRow.children.length <= 4, `Should have max 4 buttons, got ${actionRow.children.length}`);
  });

  it('renders UI blocks', () => {
    resetStream();
    ctx.agentMessage('', [{ type: 'ScoreCard', props: {} }], []);
    const msg = streamContainer.children[0];
    // Should have a rendered block child
    assert(msg.children.length >= 1, 'Should have rendered block');
  });
});

describe('userMessage()', () => {
  it('adds user bubble to stream', () => {
    resetStream();
    ctx.userMessage('Hallo User');
    assert(streamContainer.children.length === 1, 'Should have 1 child');
    const msg = streamContainer.children[0];
    assert(msg.classList.contains('stream-user'), 'Should have stream-user class');
  });

  it('contains the user text', () => {
    resetStream();
    ctx.userMessage('Mein Text');
    const msg = streamContainer.children[0];
    const textEl = msg.children[0];
    assertEqual(textEl.textContent, 'Mein Text');
  });
});

describe('clearStream()', () => {
  it('empties container', () => {
    resetStream();
    ctx.agentMessage('Msg 1', [], []);
    ctx.agentMessage('Msg 2', [], []);
    assert(streamContainer.children.length === 2, 'Should have 2 messages before clear');
    ctx.clearStream();
    assertEqual(streamContainer.innerHTML, '', 'Container should be empty after clearStream');
  });
});

describe('showStreamLoading / hideStreamLoading', () => {
  it('showStreamLoading adds loading indicator', () => {
    resetStream();
    const loadingEl = ctx.showStreamLoading();
    assert(streamContainer.children.length === 1, 'Should have loading element');
    assert(loadingEl.classList.contains('stream-loading'), 'Should have stream-loading class');
  });

  it('hideStreamLoading removes indicator', () => {
    resetStream();
    const loadingEl = ctx.showStreamLoading('Laden...');
    // Manually set parent reference for remove() to work
    loadingEl._parent = streamContainer;
    ctx.hideStreamLoading(loadingEl);
    // The element should be removed (via remove())
    const remaining = streamContainer.children.filter(c => c.classList && c.classList.contains('stream-loading'));
    assertEqual(remaining.length, 0, 'Loading indicator should be removed');
  });
});

// ── Ergebnis ────────────────────────────────────
const allPassed = printResults();
if (!allPassed) process.exit(1);
