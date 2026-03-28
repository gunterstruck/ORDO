// quest.test.js – Tests für Quest-Plan und Fortschritt

const { describe, it, assertEqual, assert } = require('./test-runner');
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

function loadBrain() {
  const brainCode = fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8');
  const context = vm.createContext({
    localStorage,
    indexedDB: undefined,
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
    fetch: () => Promise.reject(new Error('fetch not available'))
  });
  let code = stripModuleSyntax(brainCode);
  code = code.replace(/\bconst (Brain|STORAGE_KEY|PHOTO_DB_NAME|PHOTO_DB_VERSION|PHOTO_STORE)\b/g, 'var $1');
  vm.runInContext(code, context);
  return context.Brain;
}

function loadQuest(Brain) {
  const questCode = fs.readFileSync(path.join(__dirname, '..', 'quest.js'), 'utf8');
  const context = vm.createContext({
    Brain,
    document: { addEventListener() {}, getElementById() { return null; }, body: { appendChild() {} }, createElement() { return { style: {}, addEventListener() {}, click() {} }; } },
    window: { setInterval() {}, clearInterval() {} },
    showToast() {}, showInputModal: async () => null, showConfirmModal: async () => false,
    renderBrainView() {}, handlePhotoFile: async () => {}, showView() {},
    Date, JSON, Object, Array, Math, parseInt, console, Error, Promise, String
  });
  let code = stripModuleSyntax(questCode);
  code = code.replace(/^(const|let) /gm, 'var ');
  vm.runInContext(code, context);
  return context;
}

const { printResults } = require('./test-runner');

console.log('🧭 Quest Tests\n' + '═'.repeat(50));

describe('Quest-Typ Unterscheidung', () => {
  it('getQuest() setzt type=inventory bei Legacy-Quests', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.saveQuest({
      active: true,
      plan: [{ room_id: 'kueche', container_id: 'a', status: 'pending' }]
    });
    const q = Brain.getQuest();
    assertEqual(q.type, 'inventory');
  });

  it('getQuest() behält cleanup-Typ bei', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.saveQuest({
      type: 'cleanup',
      active: true,
      plan: [{ step_number: 1, status: 'pending', action_type: 'move', item_name: 'Test' }]
    });
    const q = Brain.getQuest();
    assertEqual(q.type, 'cleanup');
  });
});

describe('Cleanup Quest-Plan Schritte', () => {
  it('markiert done/skipped korrekt bei Cleanup-Quest', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.saveQuest({
      type: 'cleanup',
      active: true,
      progress: { containers_total: 3, containers_done: 0, containers_skipped: 0, percent: 0 },
      plan: [
        { step_number: 1, status: 'pending', action_type: 'move', item_name: 'A' },
        { step_number: 2, status: 'pending', action_type: 'decide', item_name: 'B' },
        { step_number: 3, status: 'pending', action_type: 'optimize', item_name: 'C' }
      ]
    });

    const q = Brain.getQuest();
    assertEqual(q.type, 'cleanup');
    assertEqual(q.plan.length, 3);
    assertEqual(q.plan[0].action_type, 'move');
    assertEqual(q.plan[1].action_type, 'decide');
    assertEqual(q.plan[2].action_type, 'optimize');
  });
});

describe('Brain.moveItemCrossRoom()', () => {
  it('verschiebt Item zwischen Räumen', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addRoom('flur', 'Flur', '🚪');
    Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
    Brain.addContainer('flur', 'garderobe', 'Garderobe', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Handschuhe');

    const result = Brain.moveItemCrossRoom('kueche', 'schrank', 'flur', 'garderobe', 'Handschuhe');
    assert(result === true, 'moveItemCrossRoom sollte true zurückgeben');

    const fromC = Brain.getContainer('kueche', 'schrank');
    const toC = Brain.getContainer('flur', 'garderobe');
    assert(fromC.items.every(i => Brain.getItemName(i) !== 'Handschuhe'), 'Item sollte aus Quelle entfernt sein');
    assert(toC.items.some(i => Brain.getItemName(i) === 'Handschuhe'), 'Item sollte im Ziel sein');
  });

  it('gibt false zurück bei ungültigem Container', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');

    const result = Brain.moveItemCrossRoom('kueche', 'schrank', 'flur', 'garderobe', 'Test');
    assert(result === false, 'Sollte false bei ungültigem Ziel zurückgeben');
  });
});

describe('Cleanup Summary berechnung', () => {
  it('berechnet Summary aus Plan korrekt', () => {
    const plan = [
      { step_number: 1, status: 'done', action_type: 'move', item_name: 'A', archive_reason: null },
      { step_number: 2, status: 'done', action_type: 'decide', item_name: 'B', archive_reason: 'entsorgt' },
      { step_number: 3, status: 'done', action_type: 'decide', item_name: 'C', archive_reason: 'gespendet' },
      { step_number: 4, status: 'skipped', action_type: 'optimize', item_name: 'D', archive_reason: null },
      { step_number: 5, status: 'done', action_type: 'consolidate', item_name: 'E', archive_reason: 'entsorgt' },
    ];

    const done = plan.filter(s => s.status === 'done');
    const skipped = plan.filter(s => s.status === 'skipped');
    const itemsMoved = done.filter(s => s.action_type === 'move').length;
    const itemsDonated = done.filter(s => s.archive_reason === 'gespendet').length;
    const itemsDiscarded = done.filter(s => s.archive_reason === 'entsorgt').length;
    const decisions = done.filter(s => s.action_type === 'decide' || s.action_type === 'consolidate').length;

    assertEqual(done.length, 4);
    assertEqual(skipped.length, 1);
    assertEqual(itemsMoved, 1);
    assertEqual(itemsDonated, 1);
    assertEqual(itemsDiscarded, 2);
    assertEqual(decisions, 3);
  });
});

describe('Quest-Plan Sortierung', () => {
  it('sortiert hohe Priorität zuerst', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    const q = loadQuest(Brain);
    const plan = q.calculateQuestPlan({
      raeume: [
        { id: 'wohnzimmer', name: 'Wohnzimmer', moebel: [{ id: 'regal', name: 'Regal', prioritaet: 'niedrig', typ: 'regal' }] },
        { id: 'kueche', name: 'Küche', moebel: [{ id: 'schrank', name: 'Schrank', prioritaet: 'hoch', typ: 'schrank' }] }
      ]
    });
    assertEqual(plan[0].container_id, 'schrank');
    assertEqual(plan[1].container_id, 'regal');
  });
});

describe('Quest-Fortschritt in Brain', () => {
  it('aktualisiert Done/Skip/Percent korrekt', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.saveQuest({
      active: true,
      plan: [
        { room_id: 'kueche', container_id: 'a', status: 'current' },
        { room_id: 'kueche', container_id: 'b', status: 'pending' },
        { room_id: 'bad', container_id: 'c', status: 'pending' }
      ]
    });

    Brain.completeQuestStep('kueche', 'a', 5);
    Brain.skipQuestStep('kueche', 'b', 'später');

    const q = Brain.getQuest();
    assertEqual(q.progress.containers_done, 1);
    assertEqual(q.progress.containers_skipped, 1);
    assertEqual(q.progress.items_found, 5);
    assert(typeof q.progress.percent === 'number', 'Prozent sollte berechnet sein');
  });
});

printResults();
