// brain.test.js – Tests für brain.js (Datenmanagement)
// Ausführen: node tests/brain.test.js

const { describe, it, assert, assertEqual, assertDeepEqual, assertIncludes, assertNotIncludes, printResults } = require('./test-runner');

// ── Mock: localStorage ──────────────────────────────────
const storage = {};
const localStorage = {
  getItem(key) { return storage[key] || null; },
  setItem(key, value) { storage[key] = String(value); },
  removeItem(key) { delete storage[key]; },
  clear() { Object.keys(storage).forEach(k => delete storage[k]); }
};

// ── Mock: indexedDB (nicht verfügbar in Node) ───────────
const indexedDB = undefined;

// ── Brain laden (als Modul simulieren) ──────────────────
const fs = require('fs');
const path = require('path');
const brainCode = fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8');

// Brain in isoliertem Scope ausführen – const -> var damit es auf globalThis landet
const vm = require('vm');
const context = vm.createContext({
  localStorage,
  indexedDB,
  window: { indexedDB: undefined },
  Date,
  JSON,
  Object,
  Array,
  Math,
  parseInt,
  console,
  Error,
  Promise,
  String,
  fetch: () => Promise.reject(new Error('fetch not available')),
  confirm: () => true
});

// ES Module Syntax entfernen und const → var
const { stripModuleSyntax } = require('./module-loader');
let modifiedBrainCode = stripModuleSyntax(brainCode);
modifiedBrainCode = modifiedBrainCode.replace(/\bconst (Brain|STORAGE_KEY|PHOTO_DB_NAME|PHOTO_DB_VERSION|PHOTO_STORE)\b/g, 'var $1');
vm.runInContext(modifiedBrainCode, context);
const Brain = context.Brain;

// ── Hilfsfunktionen ─────────────────────────────────────
function resetBrain() {
  localStorage.clear();
  Brain._cache = null;
  Brain._globalInfraCache = null;
  Brain.init();
}

// ══════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════

console.log('🧠 Brain.js Tests\n' + '═'.repeat(50));

// ── Init ────────────────────────────────────────────────
describe('Brain.init()', () => {
  it('erstellt initiale Datenstruktur', () => {
    resetBrain();
    const data = Brain.getData();
    assert(data !== null, 'Data sollte nicht null sein');
    assertEqual(data.version, '1.5');
    assertDeepEqual(data.rooms, {});
    assertDeepEqual(data.chat_history, []);
    assert(data.created > 0, 'created timestamp fehlt');
    assert(data.last_updated > 0, 'last_updated timestamp fehlt');
  });

  it('überschreibt vorhandene Daten nicht', () => {
    resetBrain();
    Brain.addRoom('test', 'Testraum', '🧪');
    Brain.init();
    const rooms = Brain.getRooms();
    assert(rooms['test'] !== undefined, 'Raum sollte nach Re-Init noch existieren');
  });
});

// ── isEmpty ─────────────────────────────────────────────
describe('Brain.isEmpty()', () => {
  it('gibt true zurück wenn keine Räume vorhanden', () => {
    resetBrain();
    assertEqual(Brain.isEmpty(), true);
  });

  it('gibt false zurück wenn Räume vorhanden', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    assertEqual(Brain.isEmpty(), false);
  });
});

// ── Rooms ───────────────────────────────────────────────
describe('Brain – Räume', () => {
  it('addRoom() erstellt einen neuen Raum', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    const room = Brain.getRoom('kueche');
    assert(room !== null, 'Raum sollte existieren');
    assertEqual(room.name, 'Küche');
    assertEqual(room.emoji, '🍳');
    assertDeepEqual(room.containers, {});
  });

  it('addRoom() erstellt keinen Duplikat', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addRoom('kueche', 'Andere Küche', '🔥');
    const room = Brain.getRoom('kueche');
    assertEqual(room.name, 'Küche', 'Name sollte nicht überschrieben werden');
  });

  it('addRoom() verwendet Standard-Emoji', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '');
    const room = Brain.getRoom('test');
    assertEqual(room.emoji, '🏠');
  });

  it('renameRoom() ändert den Namen', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.renameRoom('kueche', 'Große Küche', '🔥');
    const room = Brain.getRoom('kueche');
    assertEqual(room.name, 'Große Küche');
    assertEqual(room.emoji, '🔥');
  });

  it('renameRoom() ohne neues Emoji behält altes', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.renameRoom('kueche', 'Neue Küche');
    const room = Brain.getRoom('kueche');
    assertEqual(room.emoji, '🍳');
  });

  it('deleteRoom() entfernt den Raum', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.deleteRoom('kueche');
    assertEqual(Brain.getRoom('kueche'), null);
  });

  it('deleteRoom() bei nicht-existentem Raum wirft keinen Fehler', () => {
    resetBrain();
    Brain.deleteRoom('gibts_nicht'); // sollte nicht crashen
    assert(true);
  });

  it('getRooms() gibt alle Räume zurück', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addRoom('bad', 'Bad', '🚿');
    const rooms = Brain.getRooms();
    assertEqual(Object.keys(rooms).length, 2);
    assert(rooms['kueche'] !== undefined);
    assert(rooms['bad'] !== undefined);
  });

  it('getRoom() gibt null für nicht-existenten Raum', () => {
    resetBrain();
    assertEqual(Brain.getRoom('gibts_nicht'), null);
  });
});

// ── Containers ──────────────────────────────────────────
describe('Brain – Container', () => {
  it('addContainer() erstellt einen Container im Raum', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank_1', 'Oberschrank', 'schrank');
    const c = Brain.getContainer('kueche', 'schrank_1');
    assert(c !== null);
    assertEqual(c.name, 'Oberschrank');
    assertEqual(c.typ, 'schrank');
    assertDeepEqual(c.items, []);
  });

  it('addContainer() ignoriert fehlenden Raum', () => {
    resetBrain();
    const result = Brain.addContainer('gibts_nicht', 'test', 'Test', 'sonstiges');
    assertEqual(result, undefined);
  });

  it('addContainer() setzt Standardtyp', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '🧪');
    Brain.addContainer('test', 'c1', 'Container 1');
    const c = Brain.getContainer('test', 'c1');
    assertEqual(c.typ, 'sonstiges');
  });

  it('renameContainer() ändert den Namen', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.renameContainer('kueche', 'schrank', 'Großer Schrank');
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.name, 'Großer Schrank');
  });

  it('deleteContainer() entfernt den Container', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.deleteContainer('kueche', 'schrank');
    assertEqual(Brain.getContainer('kueche', 'schrank'), null);
  });

  it('getContainer() gibt null bei fehlendem Raum', () => {
    resetBrain();
    assertEqual(Brain.getContainer('gibts_nicht', 'test'), null);
  });
});

// ── Items ───────────────────────────────────────────────
describe('Brain – Items', () => {
  it('addItem() fügt Gegenstand hinzu', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    const c = Brain.getContainer('kueche', 'schrank');
    assertIncludes(c.items, 'Teller');
  });

  it('addItem() verhindert Duplikate', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.addItem('kueche', 'schrank', 'Teller');
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.items.length, 1);
  });

  it('removeItem() entfernt Gegenstand', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.addItem('kueche', 'schrank', 'Tasse');
    Brain.removeItem('kueche', 'schrank', 'Teller');
    const c = Brain.getContainer('kueche', 'schrank');
    assertNotIncludes(c.items, 'Teller');
    assertIncludes(c.items, 'Tasse');
  });

  it('removeItem() entfernt auch die Quantity', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    // Manuell Quantity setzen
    const data = Brain.getData();
    data.rooms.kueche.containers.schrank.quantities = { 'Teller': 5 };
    Brain.save(data);
    Brain.removeItem('kueche', 'schrank', 'Teller');
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.quantities['Teller'], undefined);
  });

  it('addItem() bei fehlendem Container wirft keinen Fehler', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addItem('kueche', 'gibts_nicht', 'Teller');
    assert(true, 'Sollte nicht crashen');
  });
});

// ── addItemsFromReview ──────────────────────────────────
describe('Brain – addItemsFromReview()', () => {
  it('fügt gecheckte Items hinzu', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const count = Brain.addItemsFromReview('kueche', 'schrank', [
      { name: 'Teller', menge: 3, checked: true },
      { name: 'Tasse', menge: 1, checked: true },
      { name: 'Glas', menge: 2, checked: false }
    ]);
    assertEqual(count, 2);
    const c = Brain.getContainer('kueche', 'schrank');
    assertIncludes(c.items, 'Teller');
    assertIncludes(c.items, 'Tasse');
    assertNotIncludes(c.items, 'Glas');
  });

  it('setzt Quantities korrekt', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItemsFromReview('kueche', 'schrank', [
      { name: 'Teller', menge: 5, checked: true },
      { name: 'Tasse', menge: 1, checked: true }
    ]);
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.quantities['Teller'], 5);
    assertEqual(c.quantities['Tasse'], undefined, 'Menge 1 sollte keine Quantity setzen');
  });

  it('ignoriert leere Namen', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const count = Brain.addItemsFromReview('kueche', 'schrank', [
      { name: '', menge: 1, checked: true },
      { name: '  ', menge: 1, checked: true }
    ]);
    assertEqual(count, 0);
  });

  it('gibt 0 zurück bei fehlendem Container', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    const count = Brain.addItemsFromReview('kueche', 'gibts_nicht', [
      { name: 'Teller', menge: 1, checked: true }
    ]);
    assertEqual(count, 0);
  });
});

// ── Photo Analysis ──────────────────────────────────────
describe('Brain – applyPhotoAnalysis()', () => {
  it('erstellt Container aus Analyse-Ergebnis', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    const count = Brain.applyPhotoAnalysis('kueche', {
      behaelter: [
        {
          id: 'Oberschrank',
          name: 'Oberschrank',
          typ: 'schrank',
          inhalt_sicher: ['Teller', 'Tasse'],
          inhalt_unsicher: [{ name: 'Glas', vermutung: 'vermutlich' }]
        }
      ],
      raumhinweis: 'Helle Küche'
    });
    assertEqual(count, 1);
    const c = Brain.getContainer('kueche', 'oberschrank');
    assert(c !== null, 'Container sollte existieren');
    assertIncludes(c.items, 'Teller');
    assertIncludes(c.items, 'Tasse');
    assertIncludes(c.uncertain_items, 'Glas');
    assertEqual(c.photo_analyzed, true);
  });

  it('unterstützt Legacy-Format (inhalt statt inhalt_sicher)', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.applyPhotoAnalysis('kueche', {
      behaelter: [
        { id: 'regal', name: 'Regal', typ: 'regal', inhalt: ['Buch', 'DVD'] }
      ]
    });
    const c = Brain.getContainer('kueche', 'regal');
    assertIncludes(c.items, 'Buch');
    assertIncludes(c.items, 'DVD');
  });

  it('speichert Raumhinweis', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.applyPhotoAnalysis('kueche', {
      behaelter: [],
      raumhinweis: 'Große offene Küche'
    });
    const room = Brain.getRoom('kueche');
    assertEqual(room.hint, 'Große offene Küche');
  });

  it('gibt 0 zurück bei fehlendem Raum', () => {
    resetBrain();
    const count = Brain.applyPhotoAnalysis('gibts_nicht', { behaelter: [] });
    assertEqual(count, 0);
  });

  it('vermeidet Duplikate bei Merge mit bestehenden Objekt-Items', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    // Re-analyze same container – Teller already exists as object
    Brain.applyPhotoAnalysis('kueche', {
      behaelter: [
        { id: 'schrank', name: 'Schrank', typ: 'schrank', inhalt_sicher: ['Teller', 'Tasse'] }
      ]
    });
    const c = Brain.getContainer('kueche', 'schrank');
    // Teller should not be duplicated, Tasse should be added
    const tellerCount = c.items.filter(i => Brain.getItemName(i) === 'Teller').length;
    assertEqual(tellerCount, 1, 'Teller sollte nicht dupliziert werden');
    assertIncludes(c.items, 'Tasse');
  });
});

// ── Uncertain Items ─────────────────────────────────────
describe('Brain – Uncertain Items', () => {
  it('addUncertainItem() fügt unsicheres Item hinzu', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addUncertainItem('kueche', 'schrank', 'Vase');
    const c = Brain.getContainer('kueche', 'schrank');
    assertIncludes(c.uncertain_items, 'Vase');
  });

  it('addUncertainItem() verhindert Duplikate', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addUncertainItem('kueche', 'schrank', 'Vase');
    Brain.addUncertainItem('kueche', 'schrank', 'Vase');
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.uncertain_items.length, 1);
  });

  it('confirmUncertainItem() verschiebt Item zu sicheren Items', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addUncertainItem('kueche', 'schrank', 'Vase');
    Brain.confirmUncertainItem('kueche', 'schrank', 'Vase');
    const c = Brain.getContainer('kueche', 'schrank');
    assertNotIncludes(c.uncertain_items, 'Vase');
    assertIncludes(c.items, 'Vase');
  });
});

// ── Chat History ────────────────────────────────────────
describe('Brain – Chat History', () => {
  it('addChatMessage() speichert Nachricht', () => {
    resetBrain();
    Brain.addChatMessage('user', 'Hallo');
    const history = Brain.getChatHistory();
    assertEqual(history.length, 1);
    assertEqual(history[0].role, 'user');
    assertEqual(history[0].content, 'Hallo');
    assert(history[0].ts > 0);
  });

  it('begrenzt History auf 100 Nachrichten', () => {
    resetBrain();
    for (let i = 0; i < 110; i++) {
      Brain.addChatMessage('user', `Nachricht ${i}`);
    }
    const history = Brain.getChatHistory();
    assertEqual(history.length, 100);
    assertEqual(history[0].content, 'Nachricht 10');
  });

  it('clearChatHistory() löscht alle Nachrichten', () => {
    resetBrain();
    Brain.addChatMessage('user', 'Test');
    Brain.clearChatHistory();
    assertEqual(Brain.getChatHistory().length, 0);
  });
});

// ── Slugify ─────────────────────────────────────────────
describe('Brain.slugify()', () => {
  it('konvertiert Umlaute korrekt', () => {
    assertEqual(Brain.slugify('Küche'), 'kueche');
    assertEqual(Brain.slugify('Büro'), 'buero');
    assertEqual(Brain.slugify('Straße'), 'strasse');
    assertEqual(Brain.slugify('Wörter'), 'woerter');
  });

  it('ersetzt Sonderzeichen durch Unterstriche', () => {
    assertEqual(Brain.slugify('Schrank links neben Tür'), 'schrank_links_neben_tuer');
  });

  it('entfernt führende und endende Unterstriche', () => {
    assertEqual(Brain.slugify('  Test  '), 'test');
    assertEqual(Brain.slugify('_Test_'), 'test');
  });

  it('handhabt leere Strings', () => {
    assertEqual(Brain.slugify(''), '');
  });

  it('konvertiert Großbuchstaben', () => {
    assertEqual(Brain.slugify('ABC'), 'abc');
  });
});

// ── formatDate ──────────────────────────────────────────
describe('Brain.formatDate()', () => {
  it('formatiert Timestamp korrekt', () => {
    const ts = new Date(2024, 0, 15).getTime(); // 15. Januar 2024
    const result = Brain.formatDate(ts);
    assert(result.includes('15'), `Datum sollte 15 enthalten: ${result}`);
    assert(result.includes('01') || result.includes('1'), `Datum sollte Januar enthalten: ${result}`);
  });

  it('gibt leeren String für falsy Werte', () => {
    assertEqual(Brain.formatDate(null), '');
    assertEqual(Brain.formatDate(0), '');
    assertEqual(Brain.formatDate(undefined), '');
  });
});

// ── API Key ─────────────────────────────────────────────
describe('Brain – API Key', () => {
  it('setApiKey() und getApiKey()', () => {
    resetBrain();
    Brain.setApiKey('  AIzaTestKey123  ');
    assertEqual(Brain.getApiKey(), 'AIzaTestKey123');
  });

  it('getApiKey() gibt leeren String wenn nicht gesetzt', () => {
    localStorage.removeItem('ordo_api_key');
    assertEqual(Brain.getApiKey(), '');
  });
});

// ── buildContext ────────────────────────────────────────
describe('Brain.buildContext()', () => {
  it('gibt Hinweis bei leerem Haushalt', () => {
    resetBrain();
    assertEqual(Brain.buildContext(), 'Noch keine Haushaltsdaten vorhanden.');
  });

  it('listet Räume und Container auf', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    const ctx = Brain.buildContext();
    assert(ctx.includes('Küche'), 'Kontext sollte Raumname enthalten');
    assert(ctx.includes('Oberschrank'), 'Kontext sollte Containername enthalten');
    assert(ctx.includes('Teller'), 'Kontext sollte Item enthalten');
  });

  it('zeigt Mengen bei Quantities', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItemsFromReview('kueche', 'schrank', [
      { name: 'Teller', menge: 5, checked: true }
    ]);
    const ctx = Brain.buildContext();
    assert(ctx.includes('5x Teller'), 'Kontext sollte Menge anzeigen');
  });

  it('zeigt (leer) bei Container ohne Items', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const ctx = Brain.buildContext();
    assert(ctx.includes('(leer)'), 'Kontext sollte (leer) anzeigen');
  });
});

// ── Data Persistence ────────────────────────────────────
describe('Brain – Datenpersistenz', () => {
  it('getData() parsed JSON korrekt', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '🧪');
    const data = Brain.getData();
    assertEqual(typeof data, 'object');
    assert(data.rooms.test !== undefined);
  });

  it('getData() erholt sich bei korruptem JSON', () => {
    Brain._cache = null;
    localStorage.setItem('haushalt_data', 'not valid json{{{');
    const data = Brain.getData();
    assert(data !== null, 'getData() sollte nie null zurückgeben bei korruptem JSON');
    assertEqual(typeof data, 'object');
    assert(data.rooms !== undefined, 'Erholtene Daten sollten rooms haben');
    resetBrain(); // Reparieren
  });

  it('save() aktualisiert last_updated', () => {
    resetBrain();
    const before = Brain.getData().last_updated;
    // Kleiner Delay um unterschiedlichen Timestamp zu garantieren
    const data = Brain.getData();
    data.last_updated = 0;
    Brain.save(data);
    const after = Brain.getData().last_updated;
    assert(after > 0, 'last_updated sollte gesetzt sein');
  });

  it('resetAll() setzt alles zurück', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addChatMessage('user', 'Test');
    Brain.setApiKey('test_key');
    Brain.resetAll();
    assertEqual(Brain.isEmpty(), true);
    assertEqual(Brain.getChatHistory().length, 0);
  });
});

// ── setContainerHasPhoto ────────────────────────────────
describe('Brain – setContainerHasPhoto()', () => {
  it('setzt has_photo Flag', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.setContainerHasPhoto('kueche', 'schrank', true);
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.has_photo, true);
  });

  it('kann has_photo auf false setzen', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.setContainerHasPhoto('kueche', 'schrank', true);
    Brain.setContainerHasPhoto('kueche', 'schrank', false);
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.has_photo, false);
  });
});

// ── Item Object Format (v1.3) ───────────────────────────
describe('Brain – Item Object Format (v1.3)', () => {
  it('addItem() erzeugt Item-Objekte mit Metadaten', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    const c = Brain.getContainer('kueche', 'schrank');
    const item = c.items[0];
    assertEqual(typeof item, 'object');
    assertEqual(item.name, 'Teller');
    assertEqual(item.status, 'aktiv');
    assertEqual(item.menge, 1);
    assertEqual(item.seen_count, 1);
    assert(item.first_seen !== null, 'first_seen sollte gesetzt sein');
    assert(item.last_seen !== null, 'last_seen sollte gesetzt sein');
  });

  it('getItemName() funktioniert mit String und Objekt', () => {
    assertEqual(Brain.getItemName('Teller'), 'Teller');
    assertEqual(Brain.getItemName({ name: 'Teller', status: 'aktiv' }), 'Teller');
    assertEqual(Brain.getItemName(null), '');
  });

  it('createItemObject() erzeugt korrektes Item-Objekt', () => {
    const item = Brain.createItemObject('Schere');
    assertEqual(item.name, 'Schere');
    assertEqual(item.status, 'aktiv');
    assertEqual(item.menge, 1);
    assertEqual(item.seen_count, 1);
    assert(item.first_seen !== null, 'first_seen sollte gesetzt sein');
    assert(item.last_seen !== null, 'last_seen sollte gesetzt sein');
  });

  it('createItemObject() übernimmt optionale Parameter', () => {
    const item = Brain.createItemObject('Batterien', { menge: 3, status: 'vermisst' });
    assertEqual(item.name, 'Batterien');
    assertEqual(item.menge, 3);
    assertEqual(item.status, 'vermisst');
  });

  it('createItemObject() mit Spatial-Daten', () => {
    const item = Brain.createItemObject('Schere', { spatial: { x: 10, y: 20 } });
    assertEqual(item.name, 'Schere');
    assertDeepEqual(item.spatial, { x: 10, y: 20 });
  });

  it('migrateItem() wandelt String in Objekt um', () => {
    const item = Brain.migrateItem('Teller', { 'Teller': 3 });
    assertEqual(item.name, 'Teller');
    assertEqual(item.status, 'aktiv');
    assertEqual(item.menge, 3);
    assertEqual(item.first_seen, null);
    assertEqual(item.seen_count, 0);
  });

  it('migrateItem() gibt Objekte unverändert zurück', () => {
    const original = { name: 'Teller', status: 'aktiv', menge: 1 };
    const result = Brain.migrateItem(original);
    assertEqual(result, original);
  });

  it('getContainer() migriert String-Items lazy', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    // Manuell altes Format einfügen
    const data = Brain.getData();
    data.rooms.kueche.containers = {
      schrank: { name: 'Schrank', typ: 'schrank', items: ['Teller', 'Tasse'], quantities: { 'Teller': 3 } }
    };
    Brain.save(data);
    Brain._cache = null;
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(typeof c.items[0], 'object');
    assertEqual(c.items[0].name, 'Teller');
    assertEqual(c.items[0].menge, 3);
    assertEqual(c.items[1].name, 'Tasse');
    assertEqual(c.items[1].menge, 1);
  });
});

// ── Archive & Lifecycle ─────────────────────────────────
describe('Brain – Archive & Lifecycle', () => {
  it('archiveItem() setzt Status auf archiviert', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.archiveItem('kueche', 'schrank', 'Teller');
    const c = Brain.getContainer('kueche', 'schrank');
    const item = c.items[0];
    assertEqual(item.status, 'archiviert');
    assert(item.archived_at !== undefined, 'archived_at sollte gesetzt sein');
  });

  it('getActiveItems() filtert archivierte Items', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.addItem('kueche', 'schrank', 'Tasse');
    Brain.archiveItem('kueche', 'schrank', 'Teller');
    const active = Brain.getActiveItems('kueche', 'schrank');
    assertEqual(active.length, 1);
    assertEqual(active[0].name, 'Tasse');
  });

  it('getArchivedItems() gibt nur archivierte Items zurück', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.addItem('kueche', 'schrank', 'Tasse');
    Brain.archiveItem('kueche', 'schrank', 'Teller');
    const archived = Brain.getArchivedItems('kueche', 'schrank');
    assertEqual(archived.length, 1);
    assertEqual(archived[0].name, 'Teller');
  });

  it('restoreItem() stellt archiviertes Item wieder her', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.archiveItem('kueche', 'schrank', 'Teller');
    Brain.restoreItem('kueche', 'schrank', 'Teller');
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.items[0].status, 'aktiv');
    assertEqual(c.items[0].archived_at, undefined);
  });

  it('updateItemsLastSeen() aktualisiert Zeitstempel und Zähler', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    const before = Brain.getContainer('kueche', 'schrank').items[0].seen_count;
    Brain.updateItemsLastSeen('kueche', 'schrank', ['Teller']);
    const after = Brain.getContainer('kueche', 'schrank').items[0];
    assertEqual(after.seen_count, before + 1);
    assert(after.last_seen !== null);
  });

  it('addItemsFromReview() aktualisiert bestehende Items', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    const countBefore = Brain.getContainer('kueche', 'schrank').items[0].seen_count;
    Brain.addItemsFromReview('kueche', 'schrank', [
      { name: 'Teller', menge: 5, checked: true }
    ]);
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.items[0].menge, 5);
    assertEqual(c.items[0].seen_count, countBefore + 1);
    assertEqual(c.items[0].status, 'aktiv');
  });

  it('buildContext() zeigt keine archivierten Items', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.addItem('kueche', 'schrank', 'Tasse');
    Brain.archiveItem('kueche', 'schrank', 'Teller');
    const ctx = Brain.buildContext();
    assert(!ctx.includes('→ Teller') && !ctx.includes(', Teller'), 'Archiviertes Item sollte nicht in aktiver Liste stehen');
    assert(ctx.includes('Tasse'), 'Aktives Item sollte angezeigt werden');
    assert(ctx.includes('Archiviert'), 'Archiv-Sektion sollte sichtbar sein');
  });
});

// ── Version Upgrade ─────────────────────────────────────
describe('Brain – Version Upgrade', () => {
  it('init() migriert v1.2 auf v1.3', () => {
    localStorage.clear();
    Brain._cache = null;
    localStorage.setItem('haushalt_data', JSON.stringify({
      version: '1.2',
      created: Date.now(),
      rooms: {},
      chat_history: [],
      last_updated: Date.now()
    }));
    Brain._cache = null;
    Brain.init();
    const data = Brain.getData();
    assertEqual(data.version, '1.5');
  });
});

// ── Edge Cases ──────────────────────────────────────────
describe('Brain – Edge Cases', () => {
  it('mehrere Container in einem Raum', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'c1', 'Oberschrank', 'schrank');
    Brain.addContainer('kueche', 'c2', 'Unterschrank', 'schrank');
    Brain.addContainer('kueche', 'c3', 'Regal', 'regal');
    Brain.addItem('kueche', 'c1', 'Teller');
    Brain.addItem('kueche', 'c2', 'Topf');
    Brain.addItem('kueche', 'c3', 'Kochbuch');

    assertEqual(Brain.getContainer('kueche', 'c1').items.length, 1);
    assertEqual(Brain.getContainer('kueche', 'c2').items.length, 1);
    assertEqual(Brain.getContainer('kueche', 'c3').items.length, 1);
  });

  it('viele Items in einem Container', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    for (let i = 0; i < 50; i++) {
      Brain.addItem('kueche', 'schrank', `Item ${i}`);
    }
    assertEqual(Brain.getContainer('kueche', 'schrank').items.length, 50);
  });

  it('Sonderzeichen in Item-Namen', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Löffel (groß)');
    Brain.addItem('kueche', 'schrank', 'Müller\'s Tasse');
    Brain.addItem('kueche', 'schrank', '5x USB-C Kabel');
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.items.length, 3);
    assertIncludes(c.items, 'Löffel (groß)');
  });
});

// ── Levenshtein Distance ────────────────────────────────
describe('Brain.levenshtein()', () => {
  it('gibt 0 bei identischen Strings', () => {
    assertEqual(Brain.levenshtein('test', 'test'), 0);
  });

  it('berechnet Distanz korrekt bei einer Änderung', () => {
    assertEqual(Brain.levenshtein('Schere', 'Schere'), 0);
    assertEqual(Brain.levenshtein('Schere', 'Scherf'), 1);
    assertEqual(Brain.levenshtein('abc', 'abcd'), 1);
  });

  it('berechnet Distanz bei völlig verschiedenen Strings', () => {
    assert(Brain.levenshtein('abc', 'xyz') === 3);
  });

  it('handhabt leere Strings', () => {
    assertEqual(Brain.levenshtein('', 'abc'), 3);
    assertEqual(Brain.levenshtein('test', ''), 4);
    assertEqual(Brain.levenshtein('', ''), 0);
  });

  it('handhabt null/undefined', () => {
    assertEqual(Brain.levenshtein(null, 'abc'), 3);
    assertEqual(Brain.levenshtein('abc', null), 3);
  });
});

// ── normalizeName ───────────────────────────────────────
describe('Brain.normalizeName()', () => {
  it('konvertiert zu lowercase', () => {
    assertEqual(Brain.normalizeName('TELLER'), 'teller');
  });

  it('entfernt deutsche Artikel', () => {
    assertEqual(Brain.normalizeName('der Teller'), 'teller');
    assertEqual(Brain.normalizeName('die Schere'), 'schere');
    assertEqual(Brain.normalizeName('das Buch'), 'buch');
    assertEqual(Brain.normalizeName('ein Hammer'), 'hammer');
    assertEqual(Brain.normalizeName('eine Zange'), 'zange');
  });

  it('trimmt Whitespace', () => {
    assertEqual(Brain.normalizeName('  Teller  '), 'teller');
    assertEqual(Brain.normalizeName('der   große  Teller'), 'große teller');
  });

  it('handhabt leere/null Werte', () => {
    assertEqual(Brain.normalizeName(''), '');
    assertEqual(Brain.normalizeName(null), '');
  });
});

// ── isFuzzyMatch ────────────────────────────────────────
describe('Brain.isFuzzyMatch()', () => {
  it('erkennt exakte Matches', () => {
    assert(Brain.isFuzzyMatch('Schere', 'Schere'));
  });

  it('erkennt Matches nach Normalisierung', () => {
    assert(Brain.isFuzzyMatch('der Teller', 'Teller'));
    assert(Brain.isFuzzyMatch('Die Schere', 'schere'));
  });

  it('erkennt Containment-Matches', () => {
    assert(Brain.isFuzzyMatch('Schere', 'Schere, groß'));
    assert(Brain.isFuzzyMatch('Werkzeugkasten rot', 'Werkzeugkasten'));
  });

  it('erkennt ähnliche Namen mit geringer Levenshtein-Distanz', () => {
    assert(Brain.isFuzzyMatch('Schere', 'Scherre'));
    assert(Brain.isFuzzyMatch('Teller', 'Tellerr'));
  });

  it('erkennt Wort-Neuanordnung als Match', () => {
    assert(Brain.isFuzzyMatch('Werkzeugkasten rot', 'Roter Werkzeugkasten'));
  });

  it('erkennt Mengen-Varianten', () => {
    assert(Brain.isFuzzyMatch('3x Batterien AA', 'Batterien AA'));
  });

  it('lehnt klar verschiedene Items ab', () => {
    assert(!Brain.isFuzzyMatch('Schere', 'Schneider'));
    assert(!Brain.isFuzzyMatch('Roter Ordner', 'Blauer Ordner'));
    assert(!Brain.isFuzzyMatch('Teller', 'Hammer'));
  });

  it('handhabt leere/null Werte', () => {
    assert(!Brain.isFuzzyMatch('', 'Schere'));
    assert(!Brain.isFuzzyMatch('Schere', ''));
    assert(!Brain.isFuzzyMatch(null, null));
  });
});

// ── findSimilarItem ─────────────────────────────────────
describe('Brain.findSimilarItem()', () => {
  it('findet exakten Match', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Schere');
    const result = Brain.findSimilarItem('kueche', 'schrank', 'Schere');
    assert(result !== null, 'Sollte exakten Match finden');
    assertEqual(result.name, 'Schere');
  });

  it('findet fuzzy Match', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Werkzeugkasten rot');
    const result = Brain.findSimilarItem('kueche', 'schrank', 'Roter Werkzeugkasten');
    assert(result !== null, 'Sollte ähnlichen Match finden');
  });

  it('gibt null bei keinem Match', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Schere');
    const result = Brain.findSimilarItem('kueche', 'schrank', 'Hammer');
    assertEqual(result, null);
  });

  it('gibt null bei leerem Container', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const result = Brain.findSimilarItem('kueche', 'schrank', 'Irgendwas');
    assertEqual(result, null);
  });

  it('gibt null bei ungültigem Raum/Container', () => {
    resetBrain();
    const result = Brain.findSimilarItem('nope', 'nope', 'Test');
    assertEqual(result, null);
  });
});

// ── isRecentlyPhotographed ──────────────────────────────
describe('Brain.isRecentlyPhotographed()', () => {
  it('gibt true bei frischem Timestamp mit photo_analyzed', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank', [], true);
    const result = Brain.isRecentlyPhotographed('kueche', 'schrank', 10);
    assertEqual(result, true);
  });

  it('gibt false bei altem Timestamp', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank', [], true);
    // Manuell alten Timestamp setzen
    const data = Brain.getData();
    data.rooms.kueche.containers.schrank.last_updated = Date.now() - (20 * 60 * 1000);
    Brain.save(data);
    Brain._cache = null;
    const result = Brain.isRecentlyPhotographed('kueche', 'schrank', 10);
    assertEqual(result, false);
  });

  it('gibt false wenn photo_analyzed nicht gesetzt', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const result = Brain.isRecentlyPhotographed('kueche', 'schrank', 10);
    assertEqual(result, false);
  });

  it('gibt false bei ungültigem Container', () => {
    resetBrain();
    const result = Brain.isRecentlyPhotographed('nope', 'nope');
    assertEqual(result, false);
  });

  it('nutzt 10 Minuten als Default-Threshold', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank', [], true);
    const result = Brain.isRecentlyPhotographed('kueche', 'schrank');
    assertEqual(result, true);
  });
});

// ── getContainerAge ─────────────────────────────────────
describe('Brain.getContainerAge()', () => {
  it('gibt Alter in Millisekunden', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const age = Brain.getContainerAge('kueche', 'schrank');
    assert(age >= 0 && age < 1000, 'Alter sollte sehr gering sein: ' + age);
  });

  it('gibt Infinity bei ungültigem Container', () => {
    resetBrain();
    const age = Brain.getContainerAge('nope', 'nope');
    assertEqual(age, Infinity);
  });
});

// ── getContainerItemNames ───────────────────────────────
describe('Brain.getContainerItemNames()', () => {
  it('gibt Item-Namen als Array zurück', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Teller');
    Brain.addItem('kueche', 'schrank', 'Tasse');
    const names = Brain.getContainerItemNames('kueche', 'schrank');
    assertEqual(names.length, 2);
    assert(names.includes('Teller'));
    assert(names.includes('Tasse'));
  });

  it('zeigt Mengen bei Quantities', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItemsFromReview('kueche', 'schrank', [
      { name: 'Teller', menge: 5, checked: true }
    ]);
    const names = Brain.getContainerItemNames('kueche', 'schrank');
    assert(names.includes('5x Teller'));
  });

  it('gibt leeres Array bei leerem Container', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const names = Brain.getContainerItemNames('kueche', 'schrank');
    assertEqual(names.length, 0);
  });
});

// ── Spatial Fields ──────────────────────────────────────
describe('Brain – Spatial Fields', () => {
  it('addRoom() akzeptiert optionalen spatial Parameter', () => {
    resetBrain();
    const spatial = { position: { x: 10, y: 20 }, size: { w: 100, h: 80 }, neighbors: [] };
    Brain.addRoom('kueche', 'Küche', '🍳', spatial);
    const room = Brain.getRoom('kueche');
    assertDeepEqual(room.spatial, spatial);
  });

  it('addRoom() ohne spatial hat kein spatial Feld', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    const room = Brain.getRoom('kueche');
    assertEqual(room.spatial, undefined);
  });

  it('addContainer() akzeptiert optionalen spatial Parameter', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    const spatial = { position: { x: 5, y: 10 }, wall: 'north' };
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank', [], false, spatial);
    const c = Brain.getContainer('kueche', 'schrank');
    assertDeepEqual(c.spatial, spatial);
  });

  it('addContainer() ohne spatial hat kein spatial Feld', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.spatial, undefined);
  });

  it('createItemObject() akzeptiert spatial und object_id', () => {
    const item = Brain.createItemObject('Schere', {
      spatial: { position: { x: 0.3, y: 0.7 } },
      object_id: 'test-uuid'
    });
    assertDeepEqual(item.spatial, { position: { x: 0.3, y: 0.7 } });
    assertEqual(item.object_id, 'test-uuid');
  });

  it('createItemObject() ohne Extras hat keine Extra-Felder', () => {
    const item = Brain.createItemObject('Schere');
    assertEqual(item.spatial, undefined);
    assertEqual(item.object_id, undefined);
  });
});

// ── updateExistingItem ──────────────────────────────────
describe('Brain.updateExistingItem()', () => {
  it('aktualisiert last_seen und seen_count', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Schere');
    const before = Brain.getContainer('kueche', 'schrank').items[0].seen_count;
    const result = Brain.updateExistingItem('kueche', 'schrank', 'Schere');
    assertEqual(result, true);
    const after = Brain.getContainer('kueche', 'schrank').items[0];
    assertEqual(after.seen_count, before + 1);
    assertEqual(after.status, 'aktiv');
  });

  it('findet Items per Fuzzy-Match', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Werkzeugkasten rot');
    const result = Brain.updateExistingItem('kueche', 'schrank', 'Roter Werkzeugkasten');
    assertEqual(result, true);
  });

  it('gibt false bei keinem Match', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Schere');
    const result = Brain.updateExistingItem('kueche', 'schrank', 'Fernseher');
    assertEqual(result, false);
  });
});

// ── Infrastructure Ignore ────────────────────────────────
describe('Brain.addInfrastructureIgnore()', () => {
  it('fügt Infrastruktur-Eintrag zum Container hinzu', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const result = Brain.addInfrastructureIgnore('kueche', 'schrank', 'Metallgriff');
    assertEqual(result, true);
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.infrastructure_ignore.length, 1);
    assertEqual(c.infrastructure_ignore[0].name, 'Metallgriff');
    assert(c.infrastructure_ignore[0].marked_at !== undefined, 'marked_at sollte gesetzt sein');
  });

  it('verhindert Duplikate', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addInfrastructureIgnore('kueche', 'schrank', 'Metallgriff');
    const result = Brain.addInfrastructureIgnore('kueche', 'schrank', 'Metallgriff');
    assertEqual(result, false);
    const c = Brain.getContainer('kueche', 'schrank');
    assertEqual(c.infrastructure_ignore.length, 1);
  });

  it('gibt false bei leerem Namen', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const result = Brain.addInfrastructureIgnore('kueche', 'schrank', '  ');
    assertEqual(result, false);
  });

  it('gibt false bei nicht-existentem Container', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    const result = Brain.addInfrastructureIgnore('kueche', 'gibts_nicht', 'Griff');
    assertEqual(result, false);
  });
});

describe('Brain.getInfrastructureIgnoreList()', () => {
  it('gibt Namen-Array zurück', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addInfrastructureIgnore('kueche', 'schrank', 'Metallgriff');
    Brain.addInfrastructureIgnore('kueche', 'schrank', 'Scharnier links');
    const list = Brain.getInfrastructureIgnoreList('kueche', 'schrank');
    assertEqual(list.length, 2);
    assertIncludes(list, 'Metallgriff');
    assertIncludes(list, 'Scharnier links');
  });

  it('gibt leeres Array wenn nichts markiert', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const list = Brain.getInfrastructureIgnoreList('kueche', 'schrank');
    assertDeepEqual(list, []);
  });

  it('crasht nicht bei Container ohne infrastructure_ignore (alte Daten)', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    // Manuell das Feld entfernen um alte Daten zu simulieren
    const data = Brain.getData();
    delete data.rooms['kueche'].containers['schrank'].infrastructure_ignore;
    Brain.save(data);
    Brain.invalidateCache();
    const list = Brain.getInfrastructureIgnoreList('kueche', 'schrank');
    assertDeepEqual(list, []);
  });
});

describe('Brain.getGlobalInfrastructure()', () => {
  it('gibt nur Namen zurück die in 3+ Containern vorkommen', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addRoom('bad', 'Bad', '🚿');
    Brain.addRoom('schlafzimmer', 'Schlafzimmer', '🛏️');
    Brain.addContainer('kueche', 'schrank1', 'Schrank 1', 'schrank');
    Brain.addContainer('kueche', 'schrank2', 'Schrank 2', 'schrank');
    Brain.addContainer('bad', 'schrank3', 'Badschrank', 'schrank');
    Brain.addContainer('schlafzimmer', 'schrank4', 'Kleiderschrank', 'schrank');

    // Metallgriff in 3 Containern
    Brain.addInfrastructureIgnore('kueche', 'schrank1', 'Metallgriff');
    Brain.addInfrastructureIgnore('kueche', 'schrank2', 'Metallgriff');
    Brain.addInfrastructureIgnore('bad', 'schrank3', 'Metallgriff');

    // Scharnier nur in 2 Containern
    Brain.addInfrastructureIgnore('kueche', 'schrank1', 'Scharnier');
    Brain.addInfrastructureIgnore('bad', 'schrank3', 'Scharnier');

    const global = Brain.getGlobalInfrastructure();
    assertIncludes(global, 'Metallgriff');
    assertNotIncludes(global, 'Scharnier');
  });

  it('gibt leeres Array wenn keine Infrastruktur markiert', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    const global = Brain.getGlobalInfrastructure();
    assertDeepEqual(global, []);
  });
});

// ── getItemFreshness ────────────────────────────────────
describe('getItemFreshness', () => {
  function daysAgo(n) {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '');
  }

  it('gibt "fresh" für Item mit last_seen vor 5 Tagen', () => {
    const item = Brain.createItemObject('Tasse', { last_seen: daysAgo(5) });
    assertEqual(Brain.getItemFreshness(item), 'fresh');
  });

  it('gibt "fresh" für Item mit last_seen heute (0 Tage)', () => {
    const item = Brain.createItemObject('Löffel', { last_seen: daysAgo(0) });
    assertEqual(Brain.getItemFreshness(item), 'fresh');
  });

  it('gibt "stale" für Item mit last_seen vor 45 Tagen', () => {
    const item = Brain.createItemObject('Gabel', { last_seen: daysAgo(45) });
    assertEqual(Brain.getItemFreshness(item), 'stale');
  });

  it('gibt "stale" für Item mit last_seen genau 30 Tage her', () => {
    const item = Brain.createItemObject('Messer', { last_seen: daysAgo(30) });
    assertEqual(Brain.getItemFreshness(item), 'stale');
  });

  it('gibt "ghost" für Item mit last_seen vor 120 Tagen', () => {
    const item = Brain.createItemObject('Teller', { last_seen: daysAgo(120) });
    assertEqual(Brain.getItemFreshness(item), 'ghost');
  });

  it('gibt "ghost" für Item mit last_seen genau 90 Tage her', () => {
    const item = Brain.createItemObject('Schüssel', { last_seen: daysAgo(90) });
    assertEqual(Brain.getItemFreshness(item), 'ghost');
  });

  it('gibt "unconfirmed" für Item mit last_seen null', () => {
    const item = Brain.createItemObject('Topf', { last_seen: null });
    assertEqual(Brain.getItemFreshness(item), 'unconfirmed');
  });

  it('gibt "unconfirmed" für String-Item (nicht migriert)', () => {
    assertEqual(Brain.getItemFreshness('Altes Item'), 'unconfirmed');
  });

  it('gibt "unconfirmed" für migriertes Item (last_seen null)', () => {
    const item = Brain.migrateItem('Legacy', {});
    assertEqual(Brain.getItemFreshness(item), 'unconfirmed');
  });

  it('gibt "unconfirmed" für null/undefined', () => {
    assertEqual(Brain.getItemFreshness(null), 'unconfirmed');
    assertEqual(Brain.getItemFreshness(undefined), 'unconfirmed');
  });
});

// ── Purchase & Warranty ─────────────────────────────────
describe('Brain.setPurchaseData()', () => {
  it('speichert Kaufdaten an einem Item', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Bohrmaschine');
    const ok = Brain.setPurchaseData('kueche', 'schrank', 'Bohrmaschine', {
      date: '2024-11-15',
      price: 89.99,
      store: 'Bauhaus',
      warranty_months: 24,
      notes: 'Testnotiz'
    });
    assertEqual(ok, true);
    const c = Brain.getContainer('kueche', 'schrank');
    const item = c.items.find(i => Brain.getItemName(i) === 'Bohrmaschine');
    assertEqual(item.purchase.date, '2024-11-15');
    assertEqual(item.purchase.price, 89.99);
    assertEqual(item.purchase.store, 'Bauhaus');
    assertEqual(item.purchase.warranty_months, 24);
    assertEqual(item.purchase.warranty_expires, '2026-11-15');
    assertEqual(item.purchase.notes, 'Testnotiz');
  });

  it('berechnet warranty_expires automatisch', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '🧪');
    Brain.addContainer('test', 'c1', 'Container', 'sonstiges');
    Brain.addItem('test', 'c1', 'Mixer');
    Brain.setPurchaseData('test', 'c1', 'Mixer', { date: '2025-01-31', warranty_months: 12 });
    const c = Brain.getContainer('test', 'c1');
    const item = c.items.find(i => Brain.getItemName(i) === 'Mixer');
    assertEqual(item.purchase.warranty_expires, '2026-01-31');
  });

  it('gibt false zurück bei nicht existierendem Item', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '🧪');
    Brain.addContainer('test', 'c1', 'Container', 'sonstiges');
    const ok = Brain.setPurchaseData('test', 'c1', 'NichtDa', { date: '2025-01-01' });
    assertEqual(ok, false);
  });

  it('aktualisiert bestehende Kaufdaten partiell', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '🧪');
    Brain.addContainer('test', 'c1', 'Container', 'sonstiges');
    Brain.addItem('test', 'c1', 'TV');
    Brain.setPurchaseData('test', 'c1', 'TV', { date: '2024-06-01', price: 500 });
    Brain.setPurchaseData('test', 'c1', 'TV', { store: 'MediaMarkt' });
    const c = Brain.getContainer('test', 'c1');
    const item = c.items.find(i => Brain.getItemName(i) === 'TV');
    assertEqual(item.purchase.date, '2024-06-01');
    assertEqual(item.purchase.price, 500);
    assertEqual(item.purchase.store, 'MediaMarkt');
  });
});

describe('Brain.deletePurchaseData()', () => {
  it('löscht Kaufdaten vom Item', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '🧪');
    Brain.addContainer('test', 'c1', 'Container', 'sonstiges');
    Brain.addItem('test', 'c1', 'Lampe');
    Brain.setPurchaseData('test', 'c1', 'Lampe', { date: '2024-01-01', price: 29.99 });
    const ok = Brain.deletePurchaseData('test', 'c1', 'Lampe');
    assertEqual(ok, true);
    const c = Brain.getContainer('test', 'c1');
    const item = c.items.find(i => Brain.getItemName(i) === 'Lampe');
    assertEqual(item.purchase, undefined);
  });
});

describe('Brain.getExpiringWarranties()', () => {
  it('findet Items mit bald ablaufender Garantie', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Toaster');

    // Set warranty expiring in 10 days from now
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    const soonStr = soon.toISOString().slice(0, 10);
    const buyDate = new Date();
    buyDate.setMonth(buyDate.getMonth() - 23);

    Brain.setPurchaseData('kueche', 'schrank', 'Toaster', {
      date: buyDate.toISOString().slice(0, 10),
      warranty_months: 24
    });
    // Manually override warranty_expires for precise test
    const data = Brain.getData();
    const c = Brain._findContainerInTree(data.rooms.kueche.containers, 'schrank');
    const item = c.items.find(i => Brain.getItemName(i) === 'Toaster');
    item.purchase.warranty_expires = soonStr;
    Brain.save(data);

    const results = Brain.getExpiringWarranties(30);
    assert(results.length >= 1, 'Sollte mindestens 1 Item finden');
    assertEqual(Brain.getItemName(results[0].item), 'Toaster');
    assert(results[0].daysLeft <= 30, 'daysLeft sollte <= 30 sein');
  });

  it('ignoriert archivierte Items', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '🧪');
    Brain.addContainer('test', 'c1', 'Container', 'sonstiges');
    Brain.addItem('test', 'c1', 'AltGerät');
    const soon = new Date();
    soon.setDate(soon.getDate() + 5);
    Brain.setPurchaseData('test', 'c1', 'AltGerät', { date: '2024-01-01', warranty_months: 24 });
    const data = Brain.getData();
    const c = Brain._findContainerInTree(data.rooms.test.containers, 'c1');
    const item = c.items.find(i => Brain.getItemName(i) === 'AltGerät');
    item.purchase.warranty_expires = soon.toISOString().slice(0, 10);
    item.status = 'archiviert';
    Brain.save(data);

    const results = Brain.getExpiringWarranties(30);
    assertEqual(results.length, 0);
  });

  it('gibt leeres Array zurück wenn keine Garantien vorhanden', () => {
    resetBrain();
    const results = Brain.getExpiringWarranties(30);
    assertDeepEqual(results, []);
  });
});

describe('Brain.getExpiredWarranties()', () => {
  it('findet Items mit abgelaufener Garantie', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '🧪');
    Brain.addContainer('test', 'c1', 'Container', 'sonstiges');
    Brain.addItem('test', 'c1', 'AltMixer');

    const past = new Date();
    past.setDate(past.getDate() - 30);
    Brain.setPurchaseData('test', 'c1', 'AltMixer', { date: '2022-01-01', warranty_months: 24 });
    const data = Brain.getData();
    const c = Brain._findContainerInTree(data.rooms.test.containers, 'c1');
    const item = c.items.find(i => Brain.getItemName(i) === 'AltMixer');
    item.purchase.warranty_expires = past.toISOString().slice(0, 10);
    Brain.save(data);

    const results = Brain.getExpiredWarranties();
    assert(results.length >= 1, 'Sollte mindestens 1 abgelaufenes Item finden');
    assert(results[0].daysLeft < 0, 'daysLeft sollte negativ sein');
  });
});

describe('Brain.getActiveWarranties()', () => {
  it('findet Items mit aktiver Garantie (> 30 Tage)', () => {
    resetBrain();
    Brain.addRoom('test', 'Test', '🧪');
    Brain.addContainer('test', 'c1', 'Container', 'sonstiges');
    Brain.addItem('test', 'c1', 'Waschmaschine');

    const future = new Date();
    future.setDate(future.getDate() + 365);
    Brain.setPurchaseData('test', 'c1', 'Waschmaschine', { date: '2025-01-01', warranty_months: 24 });
    const data = Brain.getData();
    const c = Brain._findContainerInTree(data.rooms.test.containers, 'c1');
    const item = c.items.find(i => Brain.getItemName(i) === 'Waschmaschine');
    item.purchase.warranty_expires = future.toISOString().slice(0, 10);
    Brain.save(data);

    const results = Brain.getActiveWarranties();
    assert(results.length >= 1, 'Sollte mindestens 1 aktives Item finden');
    assert(results[0].daysLeft > 30, 'daysLeft sollte > 30 sein');
  });
});

// ── Observer Pattern ───────────────────────────────────
describe('Brain Observer (on/off/_emit)', () => {
  it('on() registriert einen Listener und _emit() ruft ihn auf', () => {
    resetBrain();
    let called = false;
    let receivedData = null;
    const cb = (data) => { called = true; receivedData = data; };
    Brain.on('testEvent', cb);
    Brain._emit('testEvent', { foo: 'bar' });
    assert(called, 'Callback sollte aufgerufen worden sein');
    assertEqual(receivedData.foo, 'bar');
    Brain.off('testEvent', cb);
  });

  it('off() entfernt einen Listener', () => {
    resetBrain();
    let count = 0;
    const cb = () => { count++; };
    Brain.on('testEvent2', cb);
    Brain._emit('testEvent2');
    assertEqual(count, 1);
    Brain.off('testEvent2', cb);
    Brain._emit('testEvent2');
    assertEqual(count, 1, 'Callback sollte nach off() nicht mehr aufgerufen werden');
  });

  it('dataChanged wird bei save() gefeuert', () => {
    resetBrain();
    let fired = false;
    const cb = () => { fired = true; };
    Brain.on('dataChanged', cb);
    Brain.addRoom('test_obs', 'Testraum', '🧪');
    assert(fired, 'dataChanged sollte bei addRoom/save gefeuert werden');
    Brain.off('dataChanged', cb);
  });

  it('itemAdded wird bei addItem() gefeuert', () => {
    resetBrain();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'regal', 'Regal', 'regal');
    let eventData = null;
    const cb = (data) => { eventData = data; };
    Brain.on('itemAdded', cb);
    Brain.addItem('kueche', 'regal', 'Tasse');
    assert(eventData !== null, 'itemAdded Event sollte gefeuert werden');
    assertEqual(eventData.roomId, 'kueche');
    assertEqual(eventData.containerId, 'regal');
    assertEqual(eventData.item, 'Tasse');
    Brain.off('itemAdded', cb);
  });

  it('itemRemoved wird bei removeItem() gefeuert', () => {
    resetBrain();
    Brain.addRoom('bad', 'Bad', '🚿');
    Brain.addContainer('bad', 'schrank', 'Schrank', 'schrank');
    Brain.addItem('bad', 'schrank', 'Seife');
    let eventData = null;
    const cb = (data) => { eventData = data; };
    Brain.on('itemRemoved', cb);
    Brain.removeItem('bad', 'schrank', 'Seife');
    assert(eventData !== null, 'itemRemoved Event sollte gefeuert werden');
    assertEqual(eventData.item, 'Seife');
    Brain.off('itemRemoved', cb);
  });

  it('itemMoved wird bei moveItem() gefeuert', () => {
    resetBrain();
    Brain.addRoom('wz', 'Wohnzimmer', '🛋️');
    Brain.addContainer('wz', 'regal1', 'Regal 1', 'regal');
    Brain.addContainer('wz', 'regal2', 'Regal 2', 'regal');
    Brain.addItem('wz', 'regal1', 'Buch');
    let eventData = null;
    const cb = (data) => { eventData = data; };
    Brain.on('itemMoved', cb);
    Brain.moveItem('wz', 'regal1', 'regal2', 'Buch');
    assert(eventData !== null, 'itemMoved Event sollte gefeuert werden');
    assertEqual(eventData.fromContainerId, 'regal1');
    assertEqual(eventData.toContainerId, 'regal2');
    assertEqual(eventData.itemName, 'Buch');
    Brain.off('itemMoved', cb);
  });

  it('itemArchived wird bei archiveItem() gefeuert', () => {
    resetBrain();
    Brain.addRoom('sz', 'Schlafzimmer', '🛏️');
    Brain.addContainer('sz', 'kommode', 'Kommode', 'kommode');
    Brain.addItem('sz', 'kommode', 'Socken');
    let eventData = null;
    const cb = (data) => { eventData = data; };
    Brain.on('itemArchived', cb);
    Brain.archiveItem('sz', 'kommode', 'Socken');
    assert(eventData !== null, 'itemArchived Event sollte gefeuert werden');
    assertEqual(eventData.itemName, 'Socken');
    Brain.off('itemArchived', cb);
  });

  it('Fehler in Listener stoppt nicht andere Listener', () => {
    resetBrain();
    let secondCalled = false;
    const badCb = () => { throw new Error('test error'); };
    const goodCb = () => { secondCalled = true; };
    Brain.on('testErr', badCb);
    Brain.on('testErr', goodCb);
    Brain._emit('testErr');
    assert(secondCalled, 'Zweiter Listener sollte trotz Fehler im ersten aufgerufen werden');
    Brain.off('testErr', badCb);
    Brain.off('testErr', goodCb);
  });
});

// ── Ergebnis ────────────────────────────────────────────
const success = printResults();
process.exit(success ? 0 : 1);
