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

printResults();
