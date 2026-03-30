// organizer.test.js – Tests für organizer.js

const { describe, it, assert, assertEqual, printResults } = require('./test-runner');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripModuleSyntax } = require('./module-loader');

const storage = {};
const localStorage = {
  getItem(key) { return storage[key] || null; },
  setItem(key, value) { storage[key] = String(value); },
  removeItem(key) { delete storage[key]; },
  clear() { Object.keys(storage).forEach(k => delete storage[k]); }
};

const context = vm.createContext({
  localStorage,
  window: { localStorage },
  document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null },
  console,
  Date,
  JSON,
  Object,
  Array,
  Math,
  parseInt,
  setTimeout: (fn) => fn(),
  clearTimeout() {}
});

const rootDir = path.join(__dirname, '..');
function load(file) {
  let code = fs.readFileSync(path.join(rootDir, file), 'utf8');
  code = stripModuleSyntax(code);
  code = code.replace(/^(const|let) /gm, 'var ');
  vm.runInContext(code, context);
}

load('brain.js');
load('app.js');
load('organizer.js');

function seedData() {
  localStorage.clear();
  context.Brain.init();
  context.Brain.addRoom('kueche', 'Küche', '🍳');
  context.Brain.addRoom('bad', 'Bad', '🚿');
  context.Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
  context.Brain.addContainer('bad', 'spiegel', 'Spiegelschrank', 'schrank');
  context.Brain.addItem('kueche', 'schrank', 'Ibuprofen');
  context.Brain.addItem('kueche', 'schrank', 'USB Kabel');
  context.Brain.addItem('kueche', 'schrank', 'Schere');
  context.Brain.addItem('bad', 'spiegel', 'Schere');

  const data = context.Brain.getData();
  const ibuprofen = data.rooms.kueche.containers.schrank.items.find(i => i.name === 'Ibuprofen');
  ibuprofen.last_seen = '2023-01-01T00:00:00Z';
  ibuprofen.purchase = { price: 5 };
  context.Brain.save(data);
}

console.log('🧹 Organizer Tests\n' + '═'.repeat(50));

describe('classifyItem()', () => {
  it('erkennt Medikamente', () => {
    const result = context.classifyItem('Ibuprofen 400mg');
    assertEqual(result.category, 'medikamente');
  });
});

describe('getDisposalGuide()', () => {
  it('liefert Elektro-Entsorgung', () => {
    const result = context.getDisposalGuide('USB Kabel');
    assertEqual(result.icon, '⚡');
  });
});

describe('calculateFreedomIndex()', () => {
  it('berechnet Score und Breakdown', () => {
    seedData();
    const score = context.calculateFreedomIndex();
    assert(typeof score.percent === 'number');
    assert(score.breakdown.wrongPlace.length >= 1);
    assert(score.breakdown.staleItems.length >= 1);
  });
});

describe('getQuickWins()', () => {
  it('liefert sortierte Quick Wins', () => {
    seedData();
    const wins = context.getQuickWins(5);
    assert(wins.length > 0);
    assert(wins[0].impactPoints / wins[0].estimatedMinutes >= wins[wins.length - 1].impactPoints / wins[wins.length - 1].estimatedMinutes);
  });
});

describe('getArchivedByReason()', () => {
  it('gruppiert archivierte Items nach Grund', () => {
    seedData();
    // Archiviere Items mit verschiedenen Gründen
    context.Brain.archiveItem('kueche', 'schrank', 'Ibuprofen', 'gespendet');
    context.Brain.archiveItem('kueche', 'schrank', 'USB Kabel', 'entsorgt');

    const result = context.getArchivedByReason();
    assertEqual(result.donated.length, 1);
    assertEqual(result.donated[0].name, 'Ibuprofen');
    assertEqual(result.discarded.length, 1);
    assertEqual(result.discarded[0].name, 'USB Kabel');
    assertEqual(result.sold.length, 0);
    assertEqual(result.stored.length, 0);
  });

  it('erkennt verkauft und eingelagert', () => {
    seedData();
    context.Brain.archiveItem('kueche', 'schrank', 'Schere', 'verkauft');

    const result = context.getArchivedByReason();
    assertEqual(result.sold.length, 1);
    assertEqual(result.sold[0].name, 'Schere');
  });
});

describe('getSellableItems()', () => {
  it('filtert Items mit Wert > 10€', () => {
    seedData();
    // Ibuprofen hat Preis 5€ → nicht verkaufbar
    context.Brain.archiveItem('kueche', 'schrank', 'Ibuprofen', 'gespendet');

    // Füge teures Item hinzu und archiviere es
    context.Brain.addItem('kueche', 'schrank', 'Bohrmaschine');
    const data = context.Brain.getData();
    const item = data.rooms.kueche.containers.schrank.items.find(i => i.name === 'Bohrmaschine');
    item.valuation = { replacement_value: 80 };
    context.Brain.save(data);
    context.Brain.archiveItem('kueche', 'schrank', 'Bohrmaschine', 'entsorgt');

    const sellable = context.getSellableItems();
    assert(sellable.length >= 1);
    assert(sellable[0].value > 10);
  });
});

describe('findStorageRoom()', () => {
  it('gibt null wenn kein Lagerraum existiert', () => {
    seedData();

    const storage = context.findStorageRoom();
    assertEqual(storage, null);
  });

  it('findet Keller als Lagerraum', () => {
    seedData();
    context.Brain.addRoom('keller', 'Keller', '🏚️');
    context.Brain.addContainer('keller', 'regal1', 'Kellerregal', 'regal');

    const storage = context.findStorageRoom();
    assert(storage !== null);
    assertEqual(storage.roomId, 'keller');
    assertEqual(storage.roomName, 'Keller');
  });
});

describe('roomCheck()', () => {
  it('berechnet Score für einen Raum', () => {
    seedData();
    const result = context.roomCheck('kueche');
    assert(result !== null);
    assert(typeof result.roomScore === 'number');
    assert(result.roomScore >= 0 && result.roomScore <= 100);
    assertEqual(result.roomId, 'kueche');
    assertEqual(result.roomName, 'Küche');
    assert(typeof result.totalItems === 'number');
    assert(Array.isArray(result.containerScores));
    assert(Array.isArray(result.wrongItems));
    assert(Array.isArray(result.staleItems));
  });

  it('gibt null für unbekannten Raum', () => {
    seedData();
    const result = context.roomCheck('nichtda');
    assertEqual(result, null);
  });
});

describe('findDuplicatesInRoom()', () => {
  it('findet Duplikate innerhalb eines Raums', () => {
    localStorage.clear();
    context.Brain.init();
    context.Brain.addRoom('kueche', 'Küche', '🍳');
    context.Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
    context.Brain.addContainer('kueche', 'schub', 'Schublade', 'schublade');
    context.Brain.addItem('kueche', 'schrank', 'Schere');
    context.Brain.addItem('kueche', 'schub', 'Schere');

    const dupes = context.findDuplicatesInRoom('kueche');
    assert(dupes.length >= 1);
    assertEqual(dupes[0].name, 'schere');
    assertEqual(dupes[0].count, 2);
  });
});

describe('householdCheck()', () => {
  it('gibt Gesamt-Score und Raum-Scores zurück', () => {
    seedData();
    const result = context.householdCheck();
    assert(typeof result.overallScore === 'number');
    assert(result.overallScore >= 0 && result.overallScore <= 100);
    assert(Array.isArray(result.roomScores));
    assert(result.roomScores.length > 0);
    assert(typeof result.totalItems === 'number');
    assert(Array.isArray(result.topQuickWins));
    assert(typeof result.pendingDonations === 'number');
    assert(typeof result.pendingSales === 'number');
  });
});

printResults();
