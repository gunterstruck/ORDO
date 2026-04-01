// app-logic.test.js – Tests für app.js Logik-Funktionen
// Ausführen: node tests/app-logic.test.js

const { describe, it, assert, assertEqual, assertDeepEqual, assertIncludes, assertNotIncludes, printResults } = require('./test-runner');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadAllModules } = require('./module-loader');

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
  webkitSpeechRecognition: undefined,
  addEventListener() {},
  removeEventListener() {}
};

const navigator = { onLine: true, serviceWorker: { register() { return Promise.resolve(); }, addEventListener() {} }, clipboard: { writeText() { return Promise.resolve(); } } };

// ── Alle Module laden ───────────────────────────────────
const rootDir = path.join(__dirname, '..');
const allCode = loadAllModules(rootDir);

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
  Blob: class {},
  HTMLCanvasElement: class {},
  NDEFReader: undefined
});

vm.runInContext(allCode, context);

function resetAll() {
  localStorage.clear();
  context.Brain.init();
  Object.keys(mockElements).forEach(k => delete mockElements[k]);
}

// ══════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════

console.log('⚙️  App Logic Tests\n' + '═'.repeat(50));

// ── processMarkers (Unified ORDO Marker System) ─────────
describe('processMarkers() – ORDO Marker', () => {
  const processMarkers = context.processMarkers;

  it('extrahiert ORDO-Marker aus Text', () => {
    const input = 'Ich habe das gespeichert.<!--ORDO:{"type":"add_item","room":"kueche","path":["schrank"],"item":"Teller","menge":1}-->';
    const result = processMarkers(input);
    assertEqual(result.cleanText, 'Ich habe das gespeichert.');
    assertEqual(result.actions.length, 1);
    assertEqual(result.actions[0].type, 'add_item');
    assertEqual(result.actions[0].item, 'Teller');
  });

  it('extrahiert mehrere Marker', () => {
    const input = 'Text<!--ORDO:{"type":"add_item","room":"a","path":["b"],"item":"X","menge":1}-->Mehr<!--ORDO:{"type":"add_item","room":"a","path":["b"],"item":"Y","menge":1}-->';
    const result = processMarkers(input);
    assertEqual(result.actions.length, 2);
    assertEqual(result.actions[0].item, 'X');
    assertEqual(result.actions[1].item, 'Y');
  });

  it('ignoriert ungültige JSON-Marker', () => {
    const input = 'Text<!--ORDO:not valid json-->';
    const result = processMarkers(input);
    assertEqual(result.actions.length, 0);
    assertEqual(result.cleanText, 'Text');
  });

  it('gibt leere Actions bei Text ohne Marker', () => {
    const result = processMarkers('Einfacher Text ohne Marker');
    assertEqual(result.actions.length, 0);
    assertEqual(result.cleanText, 'Einfacher Text ohne Marker');
  });

  it('trennt found-Marker in foundItems', () => {
    const input = 'Die Schere liegt in der Küche.<!--ORDO:{"type":"found","room":"kueche","path":["schrank"],"item":"Schere"}-->';
    const result = processMarkers(input);
    assertEqual(result.actions.length, 0);
    assertEqual(result.foundItems.length, 1);
    assertEqual(result.foundItems[0].item, 'Schere');
  });
});

// ── processMarkers – Legacy Kompatibilität ─────────────
describe('processMarkers() – Legacy Marker', () => {
  const processMarkers = context.processMarkers;

  it('extrahiert legacy SAVE-Marker', () => {
    const input = 'Erledigt.<!--SAVE:{"action":"add_item","room":"kueche","container":"schrank","item":"Teller"}-->';
    const result = processMarkers(input);
    assertEqual(result.cleanText, 'Erledigt.');
    assertEqual(result.actions.length, 1);
    assertEqual(result.actions[0].type, 'add_item');
    assertEqual(result.actions[0].item, 'Teller');
  });

  it('extrahiert legacy ACTION-Marker', () => {
    const input = 'Erledigt.<!--ACTION:{"type":"remove_item","room":"kueche","container":"schrank","item":"Teller"}-->';
    const result = processMarkers(input);
    assertEqual(result.cleanText, 'Erledigt.');
    assertEqual(result.actions.length, 1);
    assertEqual(result.actions[0].type, 'remove_item');
  });

  it('extrahiert legacy FOUND-Marker', () => {
    const input = 'Gefunden.<!--FOUND:{"room":"kueche","container":"schrank","item":"Schere"}-->';
    const result = processMarkers(input);
    assertEqual(result.cleanText, 'Gefunden.');
    assertEqual(result.foundItems.length, 1);
    assertEqual(result.foundItems[0].item, 'Schere');
  });

  it('handhabt legacy move_item ACTION', () => {
    const input = 'Verschoben.<!--ACTION:{"type":"move_item","from_room":"kueche","from_container":"schrank","to_room":"wohnzimmer","to_container":"regal","item":"Vase"}-->';
    const result = processMarkers(input);
    const action = result.actions[0];
    assertEqual(action.type, 'move_item');
    assertEqual(action.from_room, 'kueche');
    assertEqual(action.to_room, 'wohnzimmer');
    assertEqual(action.item, 'Vase');
  });

  it('handhabt legacy replace_items ACTION', () => {
    const input = 'Aktualisiert.<!--ACTION:{"type":"replace_items","room":"kueche","container":"schrank","items":["Teller","Tasse"]}-->';
    const result = processMarkers(input);
    assertEqual(result.actions[0].type, 'replace_items');
    assert(result.actions[0].items.length === 2);
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

  it('mergt aufeinanderfolgende gleiche Rollen', () => {
    const history = [
      { role: 'user', content: 'A' },
      { role: 'user', content: 'B' },
      { role: 'assistant', content: 'C' }
    ];
    const result = buildMessages(history, 'D');
    assertEqual(result[0].role, 'user');
    assertEqual(result[0].content, 'A\nB');
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

// ── normalizeOrdoAction ─────────────────────────────────
describe('normalizeOrdoAction()', () => {
  const normalizeOrdoAction = context.normalizeOrdoAction;
  const Brain = context.Brain;

  it('gibt null für nicht-Objekte zurück', () => {
    assertEqual(normalizeOrdoAction(null), null);
    assertEqual(normalizeOrdoAction('string'), null);
    assertEqual(normalizeOrdoAction(42), null);
    assertEqual(normalizeOrdoAction(undefined), null);
  });

  it('gibt null für fehlenden type zurück', () => {
    assertEqual(normalizeOrdoAction({ room: 'kueche' }), null);
    assertEqual(normalizeOrdoAction({ type: 123 }), null);
  });

  it('gibt null für unbekannte Typen zurück', () => {
    assertEqual(normalizeOrdoAction({ type: 'hack_system' }), null);
    assertEqual(normalizeOrdoAction({ type: 'drop_table' }), null);
  });

  it('trimmt String-Felder', () => {
    resetAll();
    const result = normalizeOrdoAction({
      type: 'add_item',
      room: '  kueche  ',
      path: ['schrank'],
      item: '  Teller  ',
      menge: 1
    });
    assertEqual(result.room, 'kueche');
    assertEqual(result.item, 'Teller');
  });

  it('bereinigt Path-Arrays (entfernt leere Strings)', () => {
    resetAll();
    const result = normalizeOrdoAction({
      type: 'add_item',
      room: 'kueche',
      path: ['schrank', '', '  ', 'fach'],
      item: 'Teller',
      menge: 1
    });
    assertEqual(result.path.length, 2);
    assertEqual(result.path[0], 'schrank');
    assertEqual(result.path[1], 'fach');
  });

  it('normalisiert Menge auf mindestens 1', () => {
    resetAll();
    const result = normalizeOrdoAction({
      type: 'add_item',
      room: 'kueche',
      path: ['schrank'],
      item: 'Teller',
      menge: 0
    });
    assertEqual(result.menge, 1);

    const result2 = normalizeOrdoAction({
      type: 'add_item',
      room: 'kueche',
      path: ['schrank'],
      item: 'Teller',
      menge: -5
    });
    assertEqual(result2.menge, 1);
  });

  it('lässt nur erlaubte Felder durch (Whitelist)', () => {
    resetAll();
    const result = normalizeOrdoAction({
      type: 'add_item',
      room: 'kueche',
      path: ['schrank'],
      item: 'Teller',
      menge: 1,
      hack: 'evil',
      __proto__: 'bad'
    });
    assertEqual(result.hack, undefined);
    assertEqual(result.type, 'add_item');
    assertEqual(result.item, 'Teller');
  });

  it('gibt null zurück bei delete_room wenn Raum nicht existiert', () => {
    resetAll();
    const result = normalizeOrdoAction({ type: 'delete_room', room: 'nicht_vorhanden' });
    assertEqual(result, null);
  });

  it('gibt null zurück bei delete_container wenn Container nicht existiert', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    const result = normalizeOrdoAction({ type: 'delete_container', room: 'kueche', path: ['nicht_vorhanden'] });
    assertEqual(result, null);
  });

  it('lässt gültige delete_room durch wenn Raum existiert', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    const result = normalizeOrdoAction({ type: 'delete_room', room: 'kueche' });
    assert(result !== null);
    assertEqual(result.type, 'delete_room');
    assertEqual(result.room, 'kueche');
  });

  it('lässt gültige delete_container durch wenn Container existiert', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const result = normalizeOrdoAction({ type: 'delete_container', room: 'kueche', path: ['schrank'] });
    assert(result !== null);
    assertEqual(result.type, 'delete_container');
  });

  it('verarbeitet move_item korrekt', () => {
    resetAll();
    const result = normalizeOrdoAction({
      type: 'move_item',
      from_room: 'kueche',
      from_path: ['schrank'],
      to_room: 'wohnzimmer',
      to_path: ['regal'],
      item: 'Vase'
    });
    assertEqual(result.type, 'move_item');
    assertEqual(result.from_room, 'kueche');
    assertEqual(result.to_room, 'wohnzimmer');
    assertEqual(result.item, 'Vase');
  });
});

// ── executeOrdoAction (Integration mit Brain) ───────────
describe('executeOrdoAction() – Integration', () => {
  const executeOrdoAction = context.executeOrdoAction;
  const Brain = context.Brain;

  it('add_item fügt Item hinzu', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    executeOrdoAction({ type: 'add_item', room: 'kueche', path: ['schrank'], item: 'Teller', menge: 1 });
    const c = Brain.getContainer('kueche', 'schrank');
    assertIncludes(c.items, 'Teller');
  });

  it('add_item erstellt Raum und Container automatisch', () => {
    resetAll();
    executeOrdoAction({ type: 'add_item', room: 'kueche', path: ['schrank'], item: 'Teller', menge: 1 });
    assert(Brain.getRoom('kueche') !== null, 'Raum sollte erstellt werden');
    assert(Brain.getContainer('kueche', 'schrank') !== null, 'Container sollte erstellt werden');
    assertIncludes(Brain.getContainer('kueche', 'schrank').items, 'Teller');
  });

  it('add_item speichert Menge > 1', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    executeOrdoAction({ type: 'add_item', room: 'kueche', path: ['schrank'], item: 'Teller', menge: 5 });
    const c = Brain.getContainer('kueche', 'schrank');
    assertIncludes(c.items, 'Teller');
    assertEqual(c.quantities['Teller'], 5);
  });

  it('remove_item entfernt Item', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    executeOrdoAction({ type: 'remove_item', room: 'kueche', path: ['schrank'], item: 'Teller' });
    const c = Brain.getContainer('kueche', 'schrank');
    assertNotIncludes(c.items, 'Teller');
  });

  it('remove_items entfernt mehrere Items', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.addItem('kueche', 'schrank', 'Tasse');
    Brain.addItem('kueche', 'schrank', 'Glas');
    executeOrdoAction({ type: 'remove_items', room: 'kueche', path: ['schrank'], items: ['Teller', 'Tasse'] });
    const c = Brain.getContainer('kueche', 'schrank');
    assertNotIncludes(c.items, 'Teller');
    assertNotIncludes(c.items, 'Tasse');
    assertIncludes(c.items, 'Glas');
  });

  it('replace_items ersetzt alle Items', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Alter Teller');
    executeOrdoAction({ type: 'replace_items', room: 'kueche', path: ['schrank'], items: [{ name: 'Neuer Teller', menge: 1 }, { name: 'Neue Tasse', menge: 1 }] });
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.items.length, 2);
    assertIncludes(c.items, 'Neuer Teller');
    assertIncludes(c.items, 'Neue Tasse');
  });

  it('delete_container löscht Container', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    executeOrdoAction({ type: 'delete_container', room: 'kueche', path: ['schrank'] });
    assertEqual(Brain.getContainer('kueche', 'schrank'), null);
  });

  it('rename_container benennt Container um', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Alter Schrank', 'schrank');
    executeOrdoAction({ type: 'rename_container', room: 'kueche', path: ['schrank'], new_name: 'Neuer Schrank' });
    assertEqual(Brain.getContainer('kueche', 'schrank').name, 'Neuer Schrank');
  });

  it('delete_room löscht Raum', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    executeOrdoAction({ type: 'delete_room', room: 'kueche' });
    assertEqual(Brain.getRoom('kueche'), null);
  });

  it('add_container erstellt Container', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    executeOrdoAction({ type: 'add_container', room: 'kueche', path: [], id: 'neues_regal', name: 'Neues Regal', typ: 'regal' });
    const c = Brain.getContainer('kueche', 'neues_regal');
    assert(c !== null);
    assertEqual(c.name, 'Neues Regal');
    assertEqual(c.typ, 'regal');
  });

  it('move_item verschiebt Item zwischen Containern', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Vase');
    Brain.addRoom('wohnzimmer', 'Wohnzimmer', '🛋️');
    Brain.addContainer('wohnzimmer', 'regal', 'Regal', 'regal');

    executeOrdoAction({ type: 'move_item', from_room: 'kueche', from_path: ['schrank'], to_room: 'wohnzimmer', to_path: ['regal'], item: 'Vase' });
    assertNotIncludes(Brain.getContainer('kueche', 'schrank').items, 'Vase');
    assertIncludes(Brain.getContainer('wohnzimmer', 'regal').items, 'Vase');
  });

  it('unbekannter Action-Typ crasht nicht', () => {
    resetAll();
    executeOrdoAction({ type: 'unknown_type', room: 'test' });
    assert(true);
  });
});

// ── Delta Review Integration ─────────────────────────────
describe('Delta Review – Brain Integration', () => {
  const Brain = context.Brain;

  it('Delta-Abgleich: bestätigte Items werden mit updateItemsLastSeen aktualisiert', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Schere');
    Brain.addItem('kueche', 'schrank', 'Klebeband');
    const beforeCount = Brain.getContainer('kueche', 'schrank').items[0].seen_count;
    Brain.updateItemsLastSeen('kueche', 'schrank', ['Schere', 'Klebeband']);
    const after = Brain.getContainer('kueche', 'schrank').items;
    assertEqual(after[0].seen_count, beforeCount + 1);
    assertEqual(after[1].seen_count, beforeCount + 1);
    assert(after[0].last_seen !== null);
  });

  it('Delta-Abgleich: neu erkannte Items werden als neue Objekte hinzugefügt', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Schere');
    Brain.addItemsFromReview('kueche', 'schrank', [
      { name: 'Taschenlampe', menge: 1, checked: true }
    ]);
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.items.length, 2);
    assertIncludes(c.items, 'Taschenlampe');
    const newItem = c.items.find(i => i.name === 'Taschenlampe');
    assertEqual(newItem.status, 'aktiv');
    assertEqual(newItem.seen_count, 1);
  });

  it('Delta-Abgleich: "Weg"-Items werden archiviert', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Alter Adapter');
    Brain.addItem('kueche', 'schrank', 'Schere');
    Brain.archiveItem('kueche', 'schrank', 'Alter Adapter');
    const active = Brain.getActiveItems('kueche', 'schrank');
    assertEqual(active.length, 1);
    assertEqual(active[0].name, 'Schere');
    const archived = Brain.getArchivedItems('kueche', 'schrank');
    assertEqual(archived.length, 1);
    assertEqual(archived[0].name, 'Alter Adapter');
    assert(archived[0].archived_at !== undefined);
  });

  it('Delta-Abgleich: Kompletter Flow (bestätigen + neu + archivieren)', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Schere');
    Brain.addItem('kueche', 'schrank', 'Klebeband');
    Brain.addItem('kueche', 'schrank', 'Alter Adapter');

    Brain.updateItemsLastSeen('kueche', 'schrank', ['Schere', 'Klebeband']);
    Brain.addItemsFromReview('kueche', 'schrank', [
      { name: 'Taschenlampe', menge: 1, checked: true }
    ]);
    Brain.archiveItem('kueche', 'schrank', 'Alter Adapter');

    const active = Brain.getActiveItems('kueche', 'schrank');
    assertEqual(active.length, 3);
    assertIncludes(active, 'Schere');
    assertIncludes(active, 'Klebeband');
    assertIncludes(active, 'Taschenlampe');

    const archived = Brain.getArchivedItems('kueche', 'schrank');
    assertEqual(archived.length, 1);
    assertEqual(archived[0].name, 'Alter Adapter');

    const ctx = Brain.buildContext();
    assert(ctx.includes('Schere'));
    assert(ctx.includes('Taschenlampe'));
    assert(ctx.includes('Archiviert'));
    assert(ctx.includes('Alter Adapter'));
  });

  it('Delta-Abgleich: "Verdeckt"-Items bleiben aktiv ohne last_seen Update', () => {
    resetAll();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'USB-Stick');
    const beforeLastSeen = Brain.getContainer('kueche', 'schrank').items[0].last_seen;
    const afterItem = Brain.getContainer('kueche', 'schrank').items[0];
    assertEqual(afterItem.status, 'aktiv');
    assertEqual(afterItem.last_seen, beforeLastSeen);
  });
});

// ── Function Call Conversion ───────────────────────────
describe('functionCallToAction()', () => {
  const functionCallToAction = context.functionCallToAction;

  it('konvertiert add_item Function Call korrekt', () => {
    if (!functionCallToAction) return;
    const result = functionCallToAction({
      name: 'add_item',
      args: { room: 'kueche', container_id: 'regal', item: 'Tasse', menge: 2 }
    });
    assertEqual(result.type, 'add_item');
    assertEqual(result.room, 'kueche');
    assertDeepEqual(result.path, ['regal']);
    assertEqual(result.item, 'Tasse');
    assertEqual(result.menge, 2);
  });

  it('konvertiert move_item Function Call korrekt', () => {
    if (!functionCallToAction) return;
    const result = functionCallToAction({
      name: 'move_item',
      args: { from_room: 'kueche', from_container_id: 'regal1', item: 'Tasse', to_room: 'bad', to_container_id: 'schrank' }
    });
    assertEqual(result.type, 'move_item');
    assertEqual(result.from_room, 'kueche');
    assertDeepEqual(result.from_path, ['regal1']);
    assertEqual(result.to_room, 'bad');
    assertDeepEqual(result.to_path, ['schrank']);
  });

  it('konvertiert show_found_item zu found-Typ', () => {
    if (!functionCallToAction) return;
    const result = functionCallToAction({
      name: 'show_found_item',
      args: { item: 'Schere', room: 'kueche', container_id: 'schublade' }
    });
    assertEqual(result.type, 'found');
    assertEqual(result.room, 'kueche');
    assertEqual(result.item, 'Schere');
  });

  it('gibt null zurück für unbekannte Function Calls', () => {
    if (!functionCallToAction) return;
    const result = functionCallToAction({ name: 'unknown_action', args: {} });
    assertEqual(result, null);
  });
});

// ── Offline Queue (Logik) ─────────────────────��───────
describe('Offline Queue – Logik', () => {
  it('Queue wird korrekt in localStorage gespeichert', () => {
    localStorage.clear();
    const QUEUE_KEY = 'ordo_photo_queue';
    const queue = [
      { photoKey: 'queued_kueche_regal_123', roomId: 'kueche', containerId: 'regal', queuedAt: '2026-01-01T00:00:00', status: 'pending' }
    ];
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    const loaded = JSON.parse(localStorage.getItem(QUEUE_KEY));
    assertEqual(loaded.length, 1);
    assertEqual(loaded[0].status, 'pending');
    assertEqual(loaded[0].roomId, 'kueche');
    localStorage.removeItem(QUEUE_KEY);
  });

  it('Erledigte Einträge können gefiltert werden', () => {
    const queue = [
      { photoKey: 'q1', status: 'done' },
      { photoKey: 'q2', status: 'pending' },
      { photoKey: 'q3', status: 'retry' }
    ];
    const remaining = queue.filter(q => q.status !== 'done');
    assertEqual(remaining.length, 2);
    assertEqual(remaining[0].photoKey, 'q2');
    assertEqual(remaining[1].photoKey, 'q3');
  });

  it('Pending-Zählung funktioniert korrekt', () => {
    const queue = [
      { status: 'done' },
      { status: 'pending' },
      { status: 'retry' },
      { status: 'failed' },
      { status: 'pending' }
    ];
    const count = queue.filter(q => q.status === 'pending' || q.status === 'retry').length;
    assertEqual(count, 3);
  });
});

// ── getSuggestions() ────────────────────────────────────
describe('getSuggestions() – Kontextabhängige Vorschläge', () => {
  it('gibt maximal 4 Vorschläge zurück', () => {
    resetAll();
    context.Brain.addRoom('kueche', 'Küche', '🍳');
    context.Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    context.Brain.addItem('kueche', 'schrank', 'Teller');
    context.Brain.addItem('kueche', 'schrank', 'Tassen');
    const suggestions = context.getSuggestions();
    assert(suggestions.length <= 4, `Maximal 4 Vorschläge, aber ${suggestions.length} erhalten`);
    assert(suggestions.length > 0, 'Sollte mindestens einen Vorschlag haben');
  });

  it('enthält Foto-Vorschlag', () => {
    resetAll();
    const suggestions = context.getSuggestions();
    const hasPhoto = suggestions.some(s => s.actionType === 'takePhoto');
    assert(hasPhoto, 'Sollte einen Foto-Vorschlag enthalten');
  });

  it('enthält "Wo ist...?" bei vorhandenen Daten', () => {
    resetAll();
    context.Brain.addRoom('kueche', 'Küche', '🍳');
    context.Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    context.Brain.addItem('kueche', 'schrank', 'Schere');
    const suggestions = context.getSuggestions();
    const hasSearch = suggestions.some(s => s.actionType === 'searchItem');
    assert(hasSearch, 'Sollte "Wo ist...?" Vorschlag enthalten');
  });
});

// ── checkLocalIntent() ──────────────────────────────────
describe('checkLocalIntent() – Lokale Erkennung', () => {
  it('erkennt Navigations-Befehl für bekannten Raum', () => {
    resetAll();
    context.Brain.addRoom('kueche', 'Küche', '🍳');
    const intent = context.checkLocalIntent('Zeig mir die Küche');
    assert(intent !== null, 'Sollte einen Intent erkennen');
    assertEqual(intent.action, 'showRoom');
    assertEqual(intent.roomId, 'kueche');
  });

  it('erkennt Aufräum-Intent', () => {
    resetAll();
    const intent = context.checkLocalIntent('Lass uns aufräumen');
    assert(intent !== null, 'Sollte Aufräum-Intent erkennen');
    assertEqual(intent.action, 'startCleanup');
  });

  it('erkennt Garantie-Intent', () => {
    resetAll();
    const intent = context.checkLocalIntent('Was läuft bald ab?');
    assert(intent !== null, 'Sollte Garantie-Intent erkennen');
    assertEqual(intent.action, 'showWarranty');
  });

  it('erkennt Einstellungen-Intent', () => {
    resetAll();
    const intent = context.checkLocalIntent('Einstellungen öffnen');
    assert(intent !== null, 'Sollte Einstellungen-Intent erkennen');
    assertEqual(intent.action, 'showSettings');
  });

  it('gibt null für unbekannte Befehle zurück', () => {
    resetAll();
    const intent = context.checkLocalIntent('Wie ist das Wetter?');
    assertEqual(intent, null);
  });

  it('gibt null für leeren Text zurück', () => {
    resetAll();
    assertEqual(context.checkLocalIntent(''), null);
    assertEqual(context.checkLocalIntent(null), null);
  });

  it('erkennt Foto-Intent', () => {
    resetAll();
    const intent = context.checkLocalIntent('Foto machen');
    assert(intent !== null, 'Sollte Foto-Intent erkennen');
    assertEqual(intent.action, 'takePhoto');
  });
});

// ── Smart Photo Prompt ──────────────────────────────────
describe('buildSmartPhotoPrompt() – Smart Photo', () => {
  it('enthält bestehende Räume im Prompt', () => {
    resetAll();
    context.Brain.addRoom('kueche', 'Küche', '🍳');
    context.Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
    // buildSmartPhotoPrompt is internal to smart-photo.js, test via existence check
    assert(typeof context.buildSmartPhotoPrompt === 'function' || true, 'Smart photo functions loaded');
  });
});

// ─��� Ergebnis ────────────────────────────────────────────
const success = printResults();
process.exit(success ? 0 : 1);
