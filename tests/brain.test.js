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

// const → var, damit Variablen im globalen Scope des Kontexts landen
const modifiedBrainCode = brainCode.replace(/\bconst (Brain|STORAGE_KEY|PHOTO_DB_NAME|PHOTO_DB_VERSION|PHOTO_STORE)\b/g, 'var $1');
vm.runInContext(modifiedBrainCode, context);
const Brain = context.Brain;

// ── Hilfsfunktionen ─────────────────────────────────────
function resetBrain() {
  localStorage.clear();
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
    assertEqual(data.version, '1.1');
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
    localStorage.removeItem('gemini_api_key');
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

  it('getData() gibt null bei korruptem JSON', () => {
    localStorage.setItem('haushalt_data', 'not valid json{{{');
    const data = Brain.getData();
    assertEqual(data, null);
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

// ── Ergebnis ────────────────────────────────────────────
const success = printResults();
process.exit(success ? 0 : 1);
