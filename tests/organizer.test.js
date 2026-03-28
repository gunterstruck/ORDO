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

describe('buildCleanupPlan()', () => {
  it('generiert Plan aus Quick Wins', () => {
    seedData();
    const plan = context.buildCleanupPlan(10, 30);
    assert(Array.isArray(plan), 'Plan sollte ein Array sein');
    assert(plan.length > 0, 'Plan sollte mindestens einen Schritt haben');
  });

  it('setzt korrekte Felder auf Plan-Schritte', () => {
    seedData();
    const plan = context.buildCleanupPlan(10, 30);
    const step = plan[0];
    assert(step.step_number === 1, 'Erster Schritt sollte step_number 1 haben');
    assertEqual(step.status, 'pending');
    assert(['move', 'decide', 'consolidate', 'optimize'].includes(step.action_type), 'action_type sollte gültig sein');
    assert(typeof step.item_name === 'string', 'item_name sollte String sein');
    assert(typeof step.estimated_minutes === 'number', 'estimated_minutes sollte Zahl sein');
    assert(typeof step.impact_points === 'number', 'impact_points sollte Zahl sein');
  });

  it('respektiert maxSteps Limit', () => {
    seedData();
    const plan = context.buildCleanupPlan(2, 999);
    assert(plan.length <= 2, 'Plan sollte maxSteps respektieren');
  });

  it('respektiert maxMinutes Limit', () => {
    seedData();
    const plan = context.buildCleanupPlan(100, 1);
    let totalMinutes = 0;
    plan.forEach(s => { totalMinutes += s.estimated_minutes; });
    assert(totalMinutes <= 1, 'Gesamtminuten sollten maxMinutes nicht überschreiten');
  });

  it('setzt disposal_guide bei decide-Typ', () => {
    seedData();
    const plan = context.buildCleanupPlan(20, 30);
    const decideStep = plan.find(s => s.action_type === 'decide');
    if (decideStep) {
      assert(decideStep.disposal_guide !== null, 'decide-Schritte sollten disposal_guide haben');
    }
  });
});

printResults();
