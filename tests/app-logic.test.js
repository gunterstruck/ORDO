// app-logic.test.js – Tests für app.js Logik-Funktionen
// Ausführen: node tests/app-logic.test.js

const { describe, it, assert, assertEqual, assertDeepEqual, printResults } = require('./test-runner');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Mock: Browser-APIs ──────────────────────────────────
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

const window = {
  location: { search: '', origin: 'https://example.com', pathname: '/', reload() {} },
  indexedDB: undefined,
  SpeechRecognition: undefined,
  webkitSpeechRecognition: undefined
};

const navigator = { onLine: true, serviceWorker: { register() { return Promise.resolve(); }, addEventListener() {} }, clipboard: { writeText() { return Promise.resolve(); } } };

// ── Brain laden ─────────────────────────────────────────
const brainCode = fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8');
const context = vm.createContext({
  localStorage, indexedDB: undefined, window: { ...window, indexedDB: undefined },
  Date, JSON, Object, Array, Math, parseInt, console, Error, Promise,
  fetch: () => Promise.reject(new Error('not available')),
  confirm: () => true, document, navigator,
  URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
  Image: class { onload() {} onerror() {} set src(v) { this.onload(); } },
  FileReader: class { onload() {} readAsDataURL() { this.onload({ target: { result: 'data:image/jpeg;base64,/9j/' } }); } },
  setTimeout: (fn, ms) => fn(),
  clearTimeout() {},
  requestAnimationFrame: (fn) => fn(),
  alert() {},
  prompt() { return null; },
  confirm: () => true,
  Blob: class {},
  HTMLCanvasElement: class {},
  NDEFReader: undefined
});

// const → var damit Variablen im globalen Context landen
vm.runInContext(brainCode.replace(/\bconst (Brain|STORAGE_KEY|PHOTO_DB_NAME|PHOTO_DB_VERSION|PHOTO_STORE)\b/g, 'var $1'), context);

// ── App-Code laden (nur bestimmte Funktionen) ───────────
const appCode = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
// const/let top-level → var
const modifiedAppCode = appCode.replace(/^(const|let) /gm, 'var ');
vm.runInContext(modifiedAppCode, context);

function resetAll() {
  localStorage.clear();
  context.Brain.init();
  Object.keys(mockElements).forEach(k => delete mockElements[k]);
}

// ══════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════

console.log('⚙️  App Logic Tests\n' + '═'.repeat(50));

// ── processSaveMarkers ──────────────────────────────────
describe('processSaveMarkers()', () => {
  const processSaveMarkers = context.processSaveMarkers;

  it('extrahiert SAVE-Marker aus Text', () => {
    const input = 'Ich habe das gespeichert.<!--SAVE:{"action":"add_item","room":"kueche","container":"schrank","item":"Teller"}-->';
    const result = processSaveMarkers(input);
    assertEqual(result.cleanText, 'Ich habe das gespeichert.');
    assertEqual(result.actions.length, 1);
    assertEqual(result.actions[0].action, 'add_item');
    assertEqual(result.actions[0].item, 'Teller');
  });

  it('extrahiert mehrere Marker', () => {
    const input = 'Text<!--SAVE:{"action":"add_item","room":"a","container":"b","item":"X"}-->Mehr<!--SAVE:{"action":"add_item","room":"a","container":"b","item":"Y"}-->';
    const result = processSaveMarkers(input);
    assertEqual(result.actions.length, 2);
    assertEqual(result.actions[0].item, 'X');
    assertEqual(result.actions[1].item, 'Y');
  });

  it('ignoriert ungültige JSON-Marker', () => {
    const input = 'Text<!--SAVE:not valid json-->';
    const result = processSaveMarkers(input);
    assertEqual(result.actions.length, 0);
    assertEqual(result.cleanText, 'Text');
  });

  it('gibt leere Actions bei Text ohne Marker', () => {
    const result = processSaveMarkers('Einfacher Text ohne Marker');
    assertEqual(result.actions.length, 0);
    assertEqual(result.cleanText, 'Einfacher Text ohne Marker');
  });
});

// ── processActions ──────────────────────────────────────
describe('processActions()', () => {
  const processActions = context.processActions;

  it('extrahiert ACTION-Marker', () => {
    const input = 'Erledigt.<!--ACTION:{"type":"remove_item","room":"kueche","container":"schrank","item":"Teller"}-->';
    const result = processActions(input);
    assertEqual(result.cleanText, 'Erledigt.');
    assertEqual(result.actions.length, 1);
    assertEqual(result.actions[0].type, 'remove_item');
  });

  it('handhabt delete_room Action', () => {
    const input = 'Raum gelöscht.<!--ACTION:{"type":"delete_room","room":"kueche"}-->';
    const result = processActions(input);
    assertEqual(result.actions[0].type, 'delete_room');
    assertEqual(result.actions[0].room, 'kueche');
  });

  it('handhabt move_item Action', () => {
    const input = 'Verschoben.<!--ACTION:{"type":"move_item","from_room":"kueche","from_container":"schrank","to_room":"wohnzimmer","to_container":"regal","item":"Vase"}-->';
    const result = processActions(input);
    const action = result.actions[0];
    assertEqual(action.type, 'move_item');
    assertEqual(action.from_room, 'kueche');
    assertEqual(action.to_room, 'wohnzimmer');
    assertEqual(action.item, 'Vase');
  });

  it('handhabt replace_items Action', () => {
    const input = 'Aktualisiert.<!--ACTION:{"type":"replace_items","room":"kueche","container":"schrank","items":["Teller","Tasse"]}-->';
    const result = processActions(input);
    assertEqual(result.actions[0].type, 'replace_items');
    assertDeepEqual(result.actions[0].items, ['Teller', 'Tasse']);
  });
});

// ── buildMessages ───────────────────────────────────────
describe('buildMessages()', () => {
  const buildMessages = context.buildMessages;

  it('erstellt korrekte Nachrichtensequenz', () => {
    const history = [
      { role: 'user', content: 'Hallo' },
      { role: 'assistant', content: 'Hi!' }
    ];
    const result = buildMessages(history, 'Wo ist die Schere?');
    assertEqual(result.length, 3);
    assertEqual(result[0].role, 'user');
    assertEqual(result[1].role, 'assistant');
    assertEqual(result[2].role, 'user');
    assertEqual(result[2].content, 'Wo ist die Schere?');
  });

  it('fügt dummy Assistant ein wenn History mit User endet', () => {
    const history = [
      { role: 'user', content: 'Hallo' }
    ];
    const result = buildMessages(history, 'Noch eine Frage');
    assertEqual(result.length, 3);
    assertEqual(result[0].role, 'user');
    assertEqual(result[1].role, 'assistant');
    assertEqual(result[1].content, '…');
    assertEqual(result[2].role, 'user');
  });

  it('handhabt leere History', () => {
    const result = buildMessages([], 'Erste Nachricht');
    assertEqual(result.length, 1);
    assertEqual(result[0].role, 'user');
    assertEqual(result[0].content, 'Erste Nachricht');
  });

  it('dedupliziert aufeinanderfolgende gleiche Rollen', () => {
    const history = [
      { role: 'user', content: 'A' },
      { role: 'user', content: 'B' },
      { role: 'assistant', content: 'C' }
    ];
    const result = buildMessages(history, 'D');
    // Nur erste user-msg wird behalten (Duplikat-Logik)
    assertEqual(result[0].role, 'user');
    assertEqual(result[0].content, 'A');
    assertEqual(result[1].role, 'assistant');
    assertEqual(result[1].content, 'C');
    assertEqual(result[2].role, 'user');
    assertEqual(result[2].content, 'D');
  });
});

// ── getErrorMessage ─────────────────────────────────────
describe('getErrorMessage()', () => {
  const getErrorMessage = context.getErrorMessage;

  it('erkennt Offline-Fehler', () => {
    const msg = getErrorMessage(new Error('offline'));
    assert(msg.includes('offline'), 'Sollte Offline-Meldung enthalten');
  });

  it('erkennt API-Key-Fehler', () => {
    const msg = getErrorMessage(new Error('api_key'));
    assert(msg.includes('API Key'), 'Sollte API Key Meldung enthalten');
  });

  it('erkennt Quota-Fehler', () => {
    const msg = getErrorMessage(new Error('quota'));
    assert(msg.includes('429') || msg.includes('Tageslimit'), 'Sollte Rate-Limit erwähnen');
  });

  it('erkennt Safety-Block', () => {
    const msg = getErrorMessage(new Error('safety_block'));
    assert(msg.includes('Sicherheitsfilter'), 'Sollte Safety-Filter erwähnen');
  });

  it('erkennt Max-Tokens', () => {
    const msg = getErrorMessage(new Error('max_tokens'));
    assert(msg.includes('lang') || msg.includes('übersichtlich'), 'Sollte Hilfe anbieten');
  });

  it('erkennt JSON-Parse-Fehler', () => {
    const msg = getErrorMessage(new SyntaxError('Unexpected token'));
    assert(msg.includes('unvollständig') || msg.includes('nochmal'), 'Sollte Retry empfehlen');
  });

  it('gibt generische Meldung für unbekannte Fehler', () => {
    const msg = getErrorMessage(new Error('whatever'));
    assert(msg.includes('Verbindungsstörung') || msg.includes('nochmal'), 'Sollte generische Meldung sein');
  });
});

// ── executeAction (Integration mit Brain) ───────────────
describe('executeAction() – Integration', () => {
  const executeAction = context.executeAction;
  const Brain = context.Brain;

  it('add_item fügt Item hinzu', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    executeAction({ type: 'add_item', room: 'kueche', container: 'schrank', item: 'Teller' });
    const c = Brain.getContainer('kueche', 'schrank');
    assert(c.items.includes('Teller'));
  });

  it('add_item ignoriert fehlenden Raum', () => {
    resetAll();
    executeAction({ type: 'add_item', room: 'gibts_nicht', container: 'schrank', item: 'Teller' });
    // Kein Crash
    assert(true);
  });

  it('remove_item entfernt Item', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    executeAction({ type: 'remove_item', room: 'kueche', container: 'schrank', item: 'Teller' });
    const c = Brain.getContainer('kueche', 'schrank');
    assert(!c.items.includes('Teller'));
  });

  it('remove_items entfernt mehrere Items', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.addItem('kueche', 'schrank', 'Tasse');
    Brain.addItem('kueche', 'schrank', 'Glas');
    executeAction({ type: 'remove_items', room: 'kueche', container: 'schrank', items: ['Teller', 'Tasse'] });
    const c = Brain.getContainer('kueche', 'schrank');
    assert(!c.items.includes('Teller'));
    assert(!c.items.includes('Tasse'));
    assert(c.items.includes('Glas'));
  });

  it('replace_items ersetzt alle Items', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Alter Teller');
    executeAction({ type: 'replace_items', room: 'kueche', container: 'schrank', items: ['Neuer Teller', 'Neue Tasse'] });
    const c = Brain.getContainer('kueche', 'schrank');
    assertDeepEqual(c.items, ['Neuer Teller', 'Neue Tasse']);
  });

  it('delete_container löscht Container', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    executeAction({ type: 'delete_container', room: 'kueche', container: 'schrank' });
    assertEqual(Brain.getContainer('kueche', 'schrank'), null);
  });

  it('rename_container benennt Container um', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Alter Schrank', 'schrank');
    executeAction({ type: 'rename_container', room: 'kueche', container: 'schrank', new_name: 'Neuer Schrank' });
    assertEqual(Brain.getContainer('kueche', 'schrank').name, 'Neuer Schrank');
  });

  it('delete_room löscht Raum', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    executeAction({ type: 'delete_room', room: 'kueche' });
    assertEqual(Brain.getRoom('kueche'), null);
  });

  it('add_container erstellt Container', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    executeAction({ type: 'add_container', room: 'kueche', container: 'neues_regal', name: 'Neues Regal', typ: 'regal' });
    const c = Brain.getContainer('kueche', 'neues_regal');
    assert(c !== null);
    assertEqual(c.name, 'Neues Regal');
    assertEqual(c.typ, 'regal');
  });

  it('unbekannter Action-Typ crasht nicht', () => {
    resetAll();
    executeAction({ type: 'unknown_type', room: 'test' });
    assert(true);
  });
});

// ── executeSaveAction (Integration mit Brain) ───────────
describe('executeSaveAction() – Integration', () => {
  const executeSaveAction = context.executeSaveAction;
  const Brain = context.Brain;

  it('add_item erstellt Raum und Container automatisch', () => {
    resetAll();
    executeSaveAction({ action: 'add_item', room: 'kueche', container: 'schrank', item: 'Teller' });
    assert(Brain.getRoom('kueche') !== null, 'Raum sollte erstellt werden');
    assert(Brain.getContainer('kueche', 'schrank') !== null, 'Container sollte erstellt werden');
    assert(Brain.getContainer('kueche', 'schrank').items.includes('Teller'));
  });

  it('move_item verschiebt Item zwischen Containern', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Vase');
    Brain.addRoom('wohnzimmer', 'Wohnzimmer', '🛋️');
    Brain.addContainer('wohnzimmer', 'regal', 'Regal', 'regal');

    executeSaveAction({ action: 'move_item', from_room: 'kueche', from_container: 'schrank', room: 'wohnzimmer', container: 'regal', item: 'Vase' });
    assert(!Brain.getContainer('kueche', 'schrank').items.includes('Vase'));
    assert(Brain.getContainer('wohnzimmer', 'regal').items.includes('Vase'));
  });

  it('remove_item entfernt Item', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    executeSaveAction({ action: 'remove_item', room: 'kueche', container: 'schrank', item: 'Teller' });
    assert(!Brain.getContainer('kueche', 'schrank').items.includes('Teller'));
  });
});

// ── Ergebnis ────────────────────────────────────────────
const success = printResults();
process.exit(success ? 0 : 1);
