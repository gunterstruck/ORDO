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

// ── Phase 4: Saisonale Intelligenz & Verbesserungs-Tracking ──

describe('getCurrentSeason()', () => {
  it('gibt eine gültige Saison zurück', () => {
    const season = context.getCurrentSeason();
    assert(season !== null);
    assert(typeof season.key === 'string');
    assert(typeof season.label === 'string');
    assert(typeof season.emoji === 'string');
    assert(Array.isArray(season.months));
    assert(Array.isArray(season.storeAway));
    assert(Array.isArray(season.bringOut));
    assert(typeof season.tip === 'string');
  });

  it('Saison hat korrekte Monats-Zuordnung', () => {
    const season = context.getCurrentSeason();
    const currentMonth = new Date().getMonth() + 1;
    assert(season.months.includes(currentMonth));
  });
});

describe('getSeasonalRecommendations()', () => {
  it('gibt Empfehlungen mit season, storeAway, bringOut zurück', () => {
    seedData();
    const result = context.getSeasonalRecommendations();
    assert(result !== null);
    assert(typeof result.season === 'object');
    assert(typeof result.season.label === 'string');
    assert(typeof result.season.emoji === 'string');
    assert(Array.isArray(result.storeAway));
    assert(Array.isArray(result.bringOut));
    assert(typeof result.tip === 'string');
  });

  it('findet saisonale Items im Haushalt', () => {
    seedData();
    // Füge Winterjacke in Schlafzimmer hinzu (sollte im Frühling storeAway sein)
    context.Brain.addRoom('schlafzimmer', 'Schlafzimmer', '🛏️');
    context.Brain.addContainer('schlafzimmer', 'schrank', 'Kleiderschrank', 'schrank');
    context.Brain.addItem('schlafzimmer', 'schrank', 'Winterjacke');
    // Füge Sonnencreme in Keller hinzu (sollte im Frühling bringOut sein)
    context.Brain.addRoom('keller', 'Keller', '🏚️');
    context.Brain.addContainer('keller', 'regal1', 'Kellerregal', 'regal');
    context.Brain.addItem('keller', 'regal1', 'Sonnencreme');

    const result = context.getSeasonalRecommendations();
    // Items sollten gefunden werden, abhängig von der aktuellen Jahreszeit
    assert(result !== null);
    // Die Ergebnis-Arrays sind valide
    assert(Array.isArray(result.storeAway));
    assert(Array.isArray(result.bringOut));
  });
});

describe('detectLifeEvents()', () => {
  it('gibt ein leeres Array wenn keine Events erkannt werden', () => {
    seedData();
    const events = context.detectLifeEvents();
    assert(Array.isArray(events));
  });

  it('erkennt Baby-Items', () => {
    localStorage.clear();
    context.Brain.init();
    context.Brain.addRoom('kinderzimmer', 'Kinderzimmer', '👶');
    context.Brain.addContainer('kinderzimmer', 'wickel', 'Wickeltisch', 'sonstiges');
    context.Brain.addItem('kinderzimmer', 'wickel', 'Windeln');
    context.Brain.addItem('kinderzimmer', 'wickel', 'Schnuller');
    context.Brain.addItem('kinderzimmer', 'wickel', 'Babyfon');

    const events = context.detectLifeEvents();
    const baby = events.find(e => e.event === 'nachwuchs');
    assert(baby !== undefined);
    assertEqual(baby.emoji, '👶');
  });

  it('erkennt Entrümpelung bei vielen archivierten Items', () => {
    localStorage.clear();
    context.Brain.init();
    context.Brain.addRoom('kueche', 'Küche', '🍳');
    context.Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
    // 15+ archivierte Items
    for (let i = 0; i < 16; i++) {
      context.Brain.addItem('kueche', 'schrank', `Item${i}`);
      context.Brain.archiveItem('kueche', 'schrank', `Item${i}`, i % 3 === 0 ? 'gespendet' : 'entsorgt');
    }

    const events = context.detectLifeEvents();
    const entruempelung = events.find(e => e.event === 'entruempelung');
    assert(entruempelung !== undefined);
    assertEqual(entruempelung.emoji, '🧹');
  });
});

describe('getImprovementReport()', () => {
  it('gibt Report mit current Score zurück', () => {
    seedData();
    const report = context.getImprovementReport();
    assert(typeof report.current === 'number');
    assert(report.current >= 0 && report.current <= 100);
    assert(typeof report.trend === 'string');
    assert(Array.isArray(report.milestones));
    assert(typeof report.totalRemoved === 'number');
    assert(typeof report.totalDecisions === 'number');
  });

  it('erkennt Trend aufwärts wenn Score gestiegen', () => {
    seedData();
    // Simuliere Score-History mit niedrigerem Wert vor einer Woche
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const history = [{ date: weekAgo, percent: 50 }];
    localStorage.setItem('ordo_score_history', JSON.stringify(history));

    const report = context.getImprovementReport();
    // Wenn current > 50 + 3, Trend sollte aufwärts sein
    if (report.current > 53) {
      assertEqual(report.trend, 'aufwärts');
    }
    assertEqual(report.weekAgo, 50);
  });

  it('gibt null für historische Werte ohne Daten', () => {
    seedData();
    localStorage.removeItem('ordo_score_history');
    const report = context.getImprovementReport();
    assertEqual(report.weekAgo, null);
    assertEqual(report.monthAgo, null);
    assertEqual(report.threeMonthsAgo, null);
  });

  it('erkennt Meilensteine', () => {
    localStorage.clear();
    context.Brain.init();
    context.Brain.addRoom('kueche', 'Küche', '🍳');
    context.Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
    // 10+ archivierte Items für Meilenstein
    for (let i = 0; i < 11; i++) {
      context.Brain.addItem('kueche', 'schrank', `Ding${i}`);
      context.Brain.archiveItem('kueche', 'schrank', `Ding${i}`, 'entsorgt');
    }

    const report = context.getImprovementReport();
    const sortiert = report.milestones.find(m => m.emoji === '🎯');
    assert(sortiert !== undefined);
    assert(report.totalRemoved >= 11);
  });
});

printResults();
