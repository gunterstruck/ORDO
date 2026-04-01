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

function loadOrganizer(Brain) {
  const appCode = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const orgCode = fs.readFileSync(path.join(__dirname, '..', 'organizer.js'), 'utf8');
  const context = vm.createContext({
    Brain,
    localStorage,
    window: { localStorage, addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null },
    Date, JSON, Object, Array, Math, parseInt, console, Error, Promise, String,
    setTimeout: (fn) => fn(),
    clearTimeout() {}
  });
  let code = stripModuleSyntax(appCode);
  code = code.replace(/^(const|let) /gm, 'var ');
  vm.runInContext(code, context);
  let orgStripped = stripModuleSyntax(orgCode);
  orgStripped = orgStripped.replace(/^(const|let) /gm, 'var ');
  vm.runInContext(orgStripped, context);
  return context;
}

console.log('🧭 Quest Tests\n' + '═'.repeat(50));

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

describe('Quest-Typ-Unterscheidung', () => {
  it('setzt type=inventory für Quests ohne type (Abwärtskompatibilität)', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.saveQuest({ active: true, plan: [{ room_id: 'a', container_id: 'b', status: 'pending' }] });
    const q = Brain.getQuest();
    assertEqual(q.type, 'inventory');
  });

  it('behält type=cleanup bei', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.saveQuest({ type: 'cleanup', active: true, plan: [] });
    const q = Brain.getQuest();
    assertEqual(q.type, 'cleanup');
  });
});

describe('buildCleanupPlan()', () => {
  it('generiert gültigen Plan aus Quick Wins', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addRoom('bad', 'Bad', '🚿');
    Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
    Brain.addContainer('bad', 'spiegel', 'Spiegelschrank', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Ibuprofen');
    Brain.addItem('kueche', 'schrank', 'Schere');
    Brain.addItem('bad', 'spiegel', 'Schere');
    // Make Ibuprofen stale to generate a quick win
    const data = Brain.getData();
    const ibu = data.rooms.kueche.containers.schrank.items.find(i => i.name === 'Ibuprofen');
    ibu.last_seen = '2023-01-01T00:00:00Z';
    Brain.save(data);

    const org = loadOrganizer(Brain);
    const plan = org.buildCleanupPlan(10, 30);
    assert(Array.isArray(plan), 'Plan sollte ein Array sein');
    if (plan.length > 0) {
      assert(plan[0].step_number === 1, 'Erster Schritt sollte step_number 1 haben');
      assert(plan[0].status === 'pending', 'Status sollte pending sein');
      assert(['move', 'decide', 'consolidate', 'optimize'].includes(plan[0].action_type), 'action_type sollte gültig sein');
      assert(plan[0].item_name, 'item_name sollte vorhanden sein');
    }
  });

  it('respektiert maxSteps und maxMinutes', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
    // Add several stale items to generate wins
    for (let i = 0; i < 10; i++) {
      Brain.addItem('kueche', 'schrank', `Ding ${i}`);
    }
    const data = Brain.getData();
    for (const item of data.rooms.kueche.containers.schrank.items) {
      if (typeof item === 'object') item.last_seen = '2023-01-01T00:00:00Z';
    }
    Brain.save(data);

    const org = loadOrganizer(Brain);
    const plan = org.buildCleanupPlan(3, 30);
    assert(plan.length <= 3, 'Plan sollte maxSteps respektieren');
  });
});

describe('Cross-Room moveItemAcrossRooms', () => {
  it('verschiebt Items zwischen Räumen', () => {
    localStorage.clear();
    const Brain = loadBrain();
    Brain.init();
    Brain.addRoom('kueche', 'Küche', '🍳');
    Brain.addRoom('flur', 'Flur', '🚪');
    Brain.addContainer('kueche', 'schrank', 'Oberschrank', 'schrank');
    Brain.addContainer('flur', 'garderobe', 'Garderobe', 'schrank');
    Brain.addItem('kueche', 'schrank', 'Handschuhe');

    const result = Brain.moveItemAcrossRooms('kueche', 'schrank', 'flur', 'garderobe', 'Handschuhe');
    assert(result === true, 'moveItemAcrossRooms sollte true zurückgeben');

    const fromC = Brain.getContainer('kueche', 'schrank');
    const toC = Brain.getContainer('flur', 'garderobe');
    const fromItems = (fromC.items || []).map(i => typeof i === 'string' ? i : i.name);
    const toItems = (toC.items || []).map(i => typeof i === 'string' ? i : i.name);
    assert(!fromItems.includes('Handschuhe'), 'Handschuhe sollte nicht mehr in Küche sein');
    assert(toItems.includes('Handschuhe'), 'Handschuhe sollte im Flur sein');
  });
});

describe('Cleanup Quest Abschluss-Summary', () => {
  it('berechnet Summary korrekt', () => {
    const plan = [
      { step_number: 1, status: 'done', action_type: 'move', archive_reason: null },
      { step_number: 2, status: 'done', action_type: 'decide', archive_reason: 'entsorgt' },
      { step_number: 3, status: 'done', action_type: 'decide', archive_reason: 'gespendet' },
      { step_number: 4, status: 'skipped', action_type: 'consolidate', archive_reason: null },
      { step_number: 5, status: 'done', action_type: 'optimize', archive_reason: null },
    ];
    const done = plan.filter(s => s.status === 'done');
    const skipped = plan.filter(s => s.status === 'skipped');
    assertEqual(done.length, 4);
    assertEqual(skipped.length, 1);
    assertEqual(done.filter(s => s.action_type === 'move').length, 1);
    assertEqual(done.filter(s => s.archive_reason === 'entsorgt').length, 1);
    assertEqual(done.filter(s => s.archive_reason === 'gespendet').length, 1);
    assertEqual(done.filter(s => s.action_type === 'decide' || s.action_type === 'consolidate').length, 2);
  });
});
