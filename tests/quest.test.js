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
