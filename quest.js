// quest.js – Blueprint, Inventar-Quest & Aufräum-Quest

import Brain from './brain.js';
import { analyzeBlueprint as analyzeBlueprintWithAI, loadingManager } from './ai.js';
import { showToast, showInputModal, showConfirmModal } from './modal.js';
import { renderBrainView } from './brain-view.js';
import { handlePhotoFile } from './photo-flow.js';
import { showView, escapeHTML, isoNow } from './app.js';
import { requestOverlay, releaseOverlay } from './overlay-manager.js';
import { buildCleanupPlan, calculateFreedomIndex, getDisposalGuide } from './organizer.js';
import { getPersonality } from './chat.js';

// Analysis messages now handled by LoadingManager in ai.js

const PHOTO_TIPS = [
  'Tipp: Gutes Licht hilft – mach das Licht an wenn nötig.',
  'Tipp: Mach das Foto frontal, nicht schräg.',
  'Tipp: Wenn es voll ist, mach ruhig 2 Fotos (oben + unten).'
];

let blueprintState = null;
let quest = null;
let isMinimized = false;
let instructionCounter = 0;
let hooksReady = false;

function ensureQuestElements() {
  if (!document.getElementById('quest-overlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'quest-overlay';
    overlay.className = 'quest-overlay';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);
  }
  if (!document.getElementById('quest-mini-badge')) {
    const badge = document.createElement('button');
    badge.id = 'quest-mini-badge';
    badge.className = 'quest-mini-badge';
    badge.style.display = 'none';
    badge.addEventListener('click', () => {
      isMinimized = false;
      showCurrentStep();
    });
    document.body.appendChild(badge);
  }
}

export function startBlueprint() {
  ensureQuestElements();
  blueprintState = { photos: [], analysis: null };
  renderBlueprintCollector();
}

function renderBlueprintCollector() {
  const overlay = document.getElementById('quest-overlay');
  if (!overlay || !blueprintState) return;
  if (!requestOverlay('blueprint-review', 50, () => {
    overlay.style.display = 'none';
    releaseOverlay('blueprint-review');
    blueprintState = null;
  })) return;
  overlay.style.display = 'flex';

  const thumbs = blueprintState.photos.map((p, idx) => `
    <div class="blueprint-thumb" data-idx="${idx}">${p.userLabel || `Raum ${idx + 1}`}</div>
  `).join('');

  overlay.innerHTML = `
    <div class="quest-card">
      <h2>🏠 Wohnung scannen</h2>
      <p>Mach ein Überblicksfoto von jedem Raum. Stell dich in die Tür und fotografiere den ganzen Raum.</p>
      <div class="blueprint-thumb-row">${thumbs || '<div class="blueprint-thumb blueprint-thumb--empty">Noch keine Räume</div>'}</div>
      <p>${blueprintState.photos.length} ${blueprintState.photos.length === 1 ? 'Raum' : 'Räume'} fotografiert</p>
      <div class="quest-row">
        <button id="blueprint-add-photo" class="onboarding-btn-primary">📷 Nächsten Raum fotografieren</button>
        <button id="blueprint-finish" class="onboarding-btn-secondary" ${blueprintState.photos.length === 0 ? 'disabled' : ''}>Das waren alle Räume → Weiter</button>
        <button id="blueprint-cancel" class="onboarding-btn-skip">Abbrechen</button>
      </div>
      <input id="blueprint-file-input" type="file" accept="image/*" capture="environment" style="display:none">
    </div>
  `;

  overlay.querySelector('#blueprint-add-photo')?.addEventListener('click', () => {
    overlay.querySelector('#blueprint-file-input')?.click();
  });
  overlay.querySelector('#blueprint-file-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (file) await addBlueprintPhoto(file);
    e.target.value = '';
  });
  overlay.querySelector('#blueprint-finish')?.addEventListener('click', async () => {
    const result = await analyzeBlueprint(blueprintState.photos);
    showBlueprintReview(result);
  });
  overlay.querySelector('#blueprint-cancel')?.addEventListener('click', () => {
    overlay.style.display = 'none';
    releaseOverlay('blueprint-review');
    blueprintState = null;
  });
}

export async function addBlueprintPhoto(roomPhotoBlob) {
  if (!blueprintState) return;
  const result = await showInputModal({
    title: 'Raum benennen (optional)',
    fields: [{ placeholder: 'z.B. Küche, Wohnzimmer...' }]
  });
  const userLabel = result?.[0]?.trim() || '';
  blueprintState.photos.push({ blob: roomPhotoBlob, userLabel });
  renderBlueprintCollector();
}

export async function analyzeBlueprint(photos) {
  const overlay = document.getElementById('quest-overlay');
  if (!overlay) return null;

  overlay.innerHTML = `
    <div class="quest-card">
      <h2>🏠 Wohnung wird erkannt...</h2>
      <div class="quest-progress-bar"><div id="blueprint-progress-fill" class="quest-progress-fill" style="width:15%"></div></div>
      <p id="blueprint-analysis-message"></p>
    </div>
  `;

  const statusEl = document.getElementById('blueprint-analysis-message');
  loadingManager.start('analyzeBlueprint', statusEl);

  try {
    const analysis = await analyzeBlueprintWithAI(photos);
    blueprintState.analysis = analysis;
    const fill = document.getElementById('blueprint-progress-fill');
    if (fill) fill.style.width = '100%';
    return analysis;
  } catch (err) {
    showToast('Blueprint-Analyse fehlgeschlagen. Bitte nochmal versuchen.', 'error');
    throw err;
  } finally {
    loadingManager.stop();
  }
}

export function showBlueprintReview(analysis) {
  if (!analysis) return;
  const overlay = document.getElementById('quest-overlay');
  if (!overlay) return;

  const rooms = Array.isArray(analysis.raeume) ? analysis.raeume : [];
  overlay.innerHTML = `
    <div class="quest-card">
      <h2>🏠 Deine Wohnung</h2>
      <p>Ich habe ${rooms.length} Räume erkannt. Stimmt das?</p>
      <div id="blueprint-review-list"></div>
      <div class="quest-row">
        <button id="blueprint-add-room" class="onboarding-btn-secondary">+ Raum fehlt? Hinzufügen</button>
        <button id="blueprint-back" class="onboarding-btn-skip">Abbrechen</button>
        <button id="blueprint-confirm" class="onboarding-btn-primary">Sieht gut aus! ✓</button>
      </div>
    </div>
  `;

  const list = overlay.querySelector('#blueprint-review-list');
  rooms.forEach((room, roomIndex) => {
    const roomRow = document.createElement('div');
    roomRow.className = 'blueprint-review-item room';
    roomRow.innerHTML = `<input type="checkbox" data-room="${roomIndex}" checked> <span data-edit-room="${roomIndex}">${escapeHTML(room.emoji || '🏠')} ${escapeHTML(room.name || room.id)}</span>`;
    list.appendChild(roomRow);

    (room.moebel || []).forEach((m, mIndex) => {
      const mRow = document.createElement('div');
      mRow.className = 'blueprint-review-item moebel';
      mRow.innerHTML = `<input type="checkbox" data-room="${roomIndex}" data-moebel="${mIndex}" checked> <span data-edit-moebel="${roomIndex}:${mIndex}">${escapeHTML(m.name)}</span>`;
      list.appendChild(mRow);
    });
  });

  list.addEventListener('click', async e => {
    const roomEdit = e.target.closest('[data-edit-room]');
    const moebelEdit = e.target.closest('[data-edit-moebel]');
    if (roomEdit) {
      const idx = Number(roomEdit.dataset.editRoom);
      const r = await showInputModal({ title: 'Raum umbenennen', fields: [{ value: rooms[idx].name || '' }] });
      if (r?.[0]?.trim()) {
        rooms[idx].name = r[0].trim();
        roomEdit.textContent = `${rooms[idx].emoji || '🏠'} ${rooms[idx].name}`;
      }
    }
    if (moebelEdit) {
      const [rIdx, mIdx] = moebelEdit.dataset.editMoebel.split(':').map(Number);
      const r = await showInputModal({ title: 'Möbel umbenennen', fields: [{ value: rooms[rIdx].moebel[mIdx].name || '' }] });
      if (r?.[0]?.trim()) {
        rooms[rIdx].moebel[mIdx].name = r[0].trim();
        moebelEdit.textContent = rooms[rIdx].moebel[mIdx].name;
      }
    }
  });

  overlay.querySelector('#blueprint-add-room')?.addEventListener('click', async () => {
    const r = await showInputModal({
      title: 'Raum hinzufügen',
      fields: [{ placeholder: 'Raumname' }, { placeholder: 'Emoji (optional)' }]
    });
    if (!r?.[0]?.trim()) return;
    rooms.push({
      id: Brain.slugify(r[0]),
      name: r[0].trim(),
      emoji: r[1]?.trim() || '🏠',
      moebel: []
    });
    showBlueprintReview(analysis);
  });

  overlay.querySelector('#blueprint-back')?.addEventListener('click', () => startBlueprint());

  overlay.querySelector('#blueprint-confirm')?.addEventListener('click', () => {
    const roomChecks = [...overlay.querySelectorAll('input[data-room]:not([data-moebel])')];
    const furnitureChecks = [...overlay.querySelectorAll('input[data-moebel]')];
    const confirmedRooms = [];
    rooms.forEach((room, roomIdx) => {
      const roomEnabled = roomChecks.find(c => Number(c.dataset.room) === roomIdx)?.checked !== false;
      if (!roomEnabled) return;
      const moebel = (room.moebel || []).filter((_, mIdx) =>
        furnitureChecks.find(c => Number(c.dataset.room) === roomIdx && Number(c.dataset.moebel) === mIdx)?.checked !== false
      );
      confirmedRooms.push({ ...room, moebel });
    });
    confirmBlueprint({ ...analysis, raeume: confirmedRooms });
  });
}

export function confirmBlueprint(confirmedStructure) {
  const rooms = Array.isArray(confirmedStructure?.raeume) ? confirmedStructure.raeume : [];
  let roomCount = 0;
  let containerCount = 0;

  rooms.forEach(room => {
    const roomId = Brain.slugify(room.id || room.name || `raum_${roomCount + 1}`);
    if (!Brain.getRoom(roomId)) {
      Brain.addRoom(roomId, room.name || roomId, room.emoji || '🏠');
      roomCount++;
    }
    (room.moebel || []).forEach(m => {
      const cId = Brain.slugify(m.id || m.name || `container_${Date.now()}`);
      if (!Brain.getContainer(roomId, cId)) {
        Brain.addContainer(roomId, cId, m.name || cId, m.typ || 'sonstiges', [], false);
        containerCount++;
      }
    });
  });

  // Raumfotos in IndexedDB persistieren
  (blueprintState?.photos || []).forEach(async (p, idx) => {
    try {
      await Brain.savePhoto(`blueprint_room_${idx}_${Date.now()}`, p.blob);
    } catch(err) {
      console.warn('Blueprint-Foto konnte nicht gespeichert werden:', err.message);
    }
  });

  renderBrainView();
  showToast(`${roomCount} Räume und ${containerCount} Bereiche angelegt ✓`, 'success');

  const overlay = document.getElementById('quest-overlay');
  if (overlay) overlay.style.display = 'none';
  releaseOverlay('blueprint-review');
  blueprintState = null;

  initQuest(confirmedStructure);
}

export function calculateQuestPlan(blueprintResult) {
  const plan = [];
  const existingRooms = Brain.getRooms();

  for (const room of (blueprintResult?.raeume || [])) {
    const roomId = Brain.slugify(room.id || room.name || 'raum');
    for (const moebel of (room.moebel || [])) {
      const containerId = Brain.slugify(moebel.id || moebel.name || 'bereich');
      const existing = Brain.getContainer(roomId, containerId);
      const hasItems = existing && (existing.items || []).length > 0;
      if (hasItems) continue;
      plan.push({
        room_id: roomId,
        container_id: containerId,
        room_name: room.name || existingRooms[roomId]?.name || roomId,
        container_name: moebel.name || containerId,
        container_type: moebel.typ || 'schrank',
        priority: moebel.prioritaet || 'mittel',
        status: 'pending'
      });
    }
  }

  plan.sort((a, b) => {
    const prioOrder = { hoch: 0, mittel: 1, niedrig: 2 };
    const roomDifficulty = { keller: 10, abstellkammer: 9, garage: 8, dachboden: 7 };

    const prioDiff = (prioOrder[a.priority] ?? 1) - (prioOrder[b.priority] ?? 1);
    if (prioDiff !== 0) return prioDiff;

    if (a.room_id !== b.room_id) {
      const aDiff = roomDifficulty[a.room_id] || 0;
      const bDiff = roomDifficulty[b.room_id] || 0;
      return aDiff - bDiff;
    }

    return 0;
  });

  return plan;
}

export function initQuest(structure) {
  const plan = calculateQuestPlan(structure);
  if (plan.length === 0) {
    showToast('Keine neuen Bereiche für die Quest gefunden.', 'warning');
    return null;
  }

  plan[0].status = 'current';
  quest = {
    active: true,
    started: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    progress: {
      containers_total: plan.length,
      containers_done: 0,
      containers_skipped: 0,
      items_found: 0,
      percent: 0
    },
    current_step: {
      room_id: plan[0].room_id,
      container_id: plan[0].container_id,
      instruction: generateInstruction(plan[0]),
      step_number: 1
    },
    plan,
    completed_at: null
  };

  Brain.saveQuest(quest);
  showCurrentStep();
  return quest;
}

export function loadQuest() {
  ensureQuestElements();
  setupQuestHooks();
  quest = Brain.getQuest();
  if (!quest?.active) {
    updateMiniBadge();
    return null;
  }
  updateMiniBadge();
  return quest;
}

function setupQuestHooks() {
  if (hooksReady) return;
  hooksReady = true;
  document.addEventListener('ordo:review-confirmed', e => {
    const detail = e.detail || {};
    if (!quest?.active || !quest.current_step) return;
    if (detail.roomId !== quest.current_step.room_id || detail.containerId !== quest.current_step.container_id) return;
    completeCurrentStep(detail.itemsCount || 0);
  });

  // Observer: check quest progress when items are added via Brain
  Brain.on('itemAdded', ({ roomId, containerId }) => {
    if (!quest?.active || !quest.current_step) return;
    if (roomId === quest.current_step.room_id && containerId === quest.current_step.container_id) {
      // Item was added to the current quest step container
      const c = Brain.getContainer(roomId, containerId);
      const itemCount = c?.items?.length || 0;
      completeCurrentStep(itemCount);
    }
  });
}

function saveQuest() {
  if (!quest) return;
  Brain.saveQuest(quest);
}

export function getProgress() {
  if (!quest?.progress) return { percent: 0, done: 0, total: 0 };
  return {
    percent: quest.progress.percent || 0,
    done: quest.progress.containers_done || 0,
    total: quest.progress.containers_total || 0
  };
}

function generateInstruction(container) {
  const instructions = {
    schrank: [
      'Öffne den {name} und fotografiere den Inhalt.',
      'Mach die Tür auf und halte drauf – ich will alles sehen.'
    ],
    regal: [
      'Fotografiere das {name} von vorne – alle Fächer sichtbar.',
      'Stell dich davor und mach ein Foto vom ganzen Regal.'
    ],
    schublade: [
      'Zieh die {name} ganz raus und fotografiere von oben.',
      'Schublade auf, Foto von oben – so erkenne ich am meisten.'
    ],
    kommode: ['Öffne die {name} – fang mit der obersten Schublade an.'],
    kiste: ['Mach den Deckel auf und fotografiere rein.']
  };

  const templates = instructions[container.container_type] || instructions.schrank;
  const template = templates[Math.floor(Math.random() * templates.length)];
  instructionCounter += 1;
  const maybeTip = instructionCounter % 3 === 0 ? `\n\n${PHOTO_TIPS[instructionCounter % PHOTO_TIPS.length]}` : '';
  return template.replace('{name}', container.container_name) + maybeTip;
}

function calculateNextStep() {
  if (!quest?.plan?.length) return null;
  const next = quest.plan.find(step => step.status === 'pending');
  if (!next) return null;

  quest.plan.forEach(step => {
    if (step.status === 'current') step.status = 'done';
  });
  next.status = 'current';

  const stepNumber = quest.plan.findIndex(s => s === next) + 1;
  quest.current_step = {
    room_id: next.room_id,
    container_id: next.container_id,
    instruction: generateInstruction(next),
    step_number: stepNumber
  };
  quest.last_activity = new Date().toISOString();
  return quest.current_step;
}

export function showCurrentStep() {
  ensureQuestElements();
  if (!quest?.active || !quest.current_step) return;

  if (quest.type === 'cleanup') {
    showCleanupStep(quest);
  } else {
    showInventoryStep();
  }
}

function showInventoryStep() {
  if (!requestOverlay('quest-overlay', 50, () => pauseQuest())) return;
  const overlay = document.getElementById('quest-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  renderQuestOverlay();
  updateMiniBadge();
}

function renderQuestOverlay() {
  const overlay = document.getElementById('quest-overlay');
  if (!overlay || !quest?.current_step) return;

  const step = quest.current_step;
  const room = Brain.getRoom(step.room_id);
  const container = Brain.getContainer(step.room_id, step.container_id);
  const progress = getProgress();

  overlay.innerHTML = `
    <div class="quest-card">
      <h2>🏠 Inventar-Quest ${progress.percent}%</h2>
      <div class="quest-progress-bar"><div class="quest-progress-fill" style="width:${progress.percent}%"></div></div>
      <p>Schritt ${step.step_number} von ${progress.total}</p>
      <p>📍 ${room?.name || step.room_id}</p>
      <p>🗄️ ${container?.name || step.container_id}</p>
      <p class="quest-instruction">${step.instruction}</p>
      <div class="quest-row">
        <button id="quest-photo" class="onboarding-btn-primary">📷 Foto machen</button>
        <button id="quest-skip" class="onboarding-btn-secondary">Überspringen</button>
        <button id="quest-minimize" class="onboarding-btn-skip">Quest minimieren</button>
      </div>
      <div class="quest-row">
        <button id="quest-overview" class="onboarding-btn-secondary">Fortschritt anzeigen</button>
        <button id="quest-stop" class="onboarding-btn-skip">Quest beenden</button>
      </div>
    </div>
  `;

  overlay.querySelector('#quest-photo')?.addEventListener('click', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = async e => {
      const file = e.target.files?.[0];
      if (file) await processQuestPhoto(file);
    };
    input.click();
  });
  overlay.querySelector('#quest-skip')?.addEventListener('click', async () => {
    const reason = await showInputModal({
      title: 'Schritt überspringen',
      fields: [{ placeholder: 'Warum? (optional)' }]
    });
    skipCurrentStep(reason?.[0] || 'Mache ich später');
  });
  overlay.querySelector('#quest-minimize')?.addEventListener('click', () => pauseQuest());
  overlay.querySelector('#quest-overview')?.addEventListener('click', () => renderQuestOverview());
  overlay.querySelector('#quest-stop')?.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Quest beenden?',
      message: 'Die Quest wird beendet. Alles bisher Erfasste bleibt gespeichert.',
      confirmText: 'Quest beenden',
      cancelText: 'Abbrechen'
    });
    if (ok) {
      quest.active = false;
      quest.completed_at = new Date().toISOString();
      saveQuest();
      overlay.style.display = 'none';
      releaseOverlay('quest-overlay');
      updateMiniBadge();
    }
  });
}

function renderQuestOverview() {
  const overlay = document.getElementById('quest-overlay');
  if (!overlay || !quest) return;
  const grouped = {};
  quest.plan.forEach(step => {
    grouped[step.room_name] = grouped[step.room_name] || [];
    grouped[step.room_name].push(step);
  });

  const blocks = Object.entries(grouped).map(([room, steps]) => {
    const done = steps.filter(s => s.status === 'done').length;
    return `<div class="quest-overview-room"><strong>${done === steps.length ? '✅' : '⏳'} ${escapeHTML(room)} (${done}/${steps.length})</strong>${steps.map(s => `<div class="quest-overview-item" data-room="${escapeHTML(s.room_id)}" data-container="${escapeHTML(s.container_id)}">${s.status === 'done' ? '✅' : s.status === 'skipped' ? '⏸️' : '⏳'} ${escapeHTML(s.container_name)}</div>`).join('')}</div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="quest-card">
      <h2>🏠 Inventar-Quest ${getProgress().percent}%</h2>
      ${blocks}
      <div class="quest-row">
        <button id="quest-overview-back" class="onboarding-btn-primary">Zurück</button>
      </div>
    </div>
  `;

  overlay.querySelector('#quest-overview-back')?.addEventListener('click', () => renderQuestOverlay());
  overlay.querySelectorAll('.quest-overview-item').forEach(el => {
    el.addEventListener('click', () => {
      const roomId = el.dataset.room;
      const containerId = el.dataset.container;
      const step = quest.plan.find(s => s.room_id === roomId && s.container_id === containerId);
      if (!step) return;
      quest.plan.forEach(s => {
        if (s.status === 'current') s.status = 'pending';
      });
      step.status = 'current';
      quest.current_step = {
        room_id: roomId,
        container_id: containerId,
        instruction: generateInstruction(step),
        step_number: quest.plan.findIndex(s => s === step) + 1
      };
      saveQuest();
      renderQuestOverlay();
    });
  });
}

export async function processQuestPhoto(blob) {
  if (!quest?.current_step) return;
  const step = quest.current_step;
  await handlePhotoFile(blob, step.room_id, step.container_id);
}

export function completeCurrentStep(itemsFound = 0) {
  if (!quest?.current_step) return;
  const step = quest.current_step;
  Brain.completeQuestStep(step.room_id, step.container_id, itemsFound);

  quest = Brain.getQuest();
  const next = calculateNextStep();
  if (!next) {
    quest.active = false;
    quest.completed_at = new Date().toISOString();
    quest.progress.percent = 100;
    saveQuest();
    showQuestCompleted();
    return;
  }
  saveQuest();
  showToast(`✅ ${itemsFound} Gegenstände übernommen. Nächster Bereich folgt.`, 'success');
  showCurrentStep();
}

function showQuestCompleted() {
  const overlay = document.getElementById('quest-overlay');
  if (!overlay || !quest) return;
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="quest-card">
      <h2>🏠 Dein Zuhause ist erfasst!</h2>
      <p>${Object.keys(Brain.getRooms()).length} Räume</p>
      <p>${quest.progress.containers_done} Bereiche (${quest.progress.containers_skipped} übersprungen)</p>
      <p>${quest.progress.items_found} Gegenstände</p>
      <div class="quest-row">
        <button id="quest-to-chat" class="onboarding-btn-primary">Zum Chat →</button>
        <button id="quest-report" class="onboarding-btn-secondary">Ja, PDF exportieren</button>
      </div>
    </div>
  `;
  overlay.querySelector('#quest-to-chat')?.addEventListener('click', () => {
    overlay.style.display = 'none';
    releaseOverlay('quest-overlay');
    showView('chat');
  });
  overlay.querySelector('#quest-report')?.addEventListener('click', () => {
    overlay.style.display = 'none';
    releaseOverlay('quest-overlay');
    const reportBtn = document.getElementById('brain-report-btn');
    if (reportBtn) reportBtn.click();
  });
  updateMiniBadge();
}

export function skipCurrentStep(reason) {
  if (!quest?.current_step) return;
  const step = quest.current_step;
  Brain.skipQuestStep(step.room_id, step.container_id, reason);
  quest = Brain.getQuest();
  const next = calculateNextStep();
  if (!next) {
    quest.active = false;
    quest.completed_at = new Date().toISOString();
    saveQuest();
    showQuestCompleted();
    return;
  }
  saveQuest();
  showCurrentStep();
}

export function pauseQuest() {
  isMinimized = true;
  const overlay = document.getElementById('quest-overlay');
  if (overlay) overlay.style.display = 'none';
  releaseOverlay('quest-overlay');
  updateMiniBadge();
}

export function resumeQuest() {
  isMinimized = false;
  showCurrentStep();
}

function updateMiniBadge() {
  const badge = document.getElementById('quest-mini-badge');
  if (!badge) return;
  if (quest?.active && isMinimized) {
    badge.style.display = 'block';
    const icon = quest.type === 'cleanup' ? '🧹' : '🏠';
    badge.textContent = `${icon} ${getProgress().percent}% | Weiter →`;
  } else {
    badge.style.display = 'none';
  }
}

export function shouldShowQuestResume() {
  const q = Brain.getQuest();
  return !!(q?.active);
}

export function getQuestState() {
  return quest;
}

// ══════════════════════════════════════════════════════════
// Aufräum-Quest (Cleanup Quest) – Phase 2
// ══════════════════════════════════════════════════════════

const ACTION_LABELS = {
  move: { icon: '🔄', label: 'UMRÄUMEN' },
  decide: { icon: '🤔', label: 'ENTSCHEIDEN' },
  consolidate: { icon: '📦', label: 'ZUSAMMENLEGEN' },
  optimize: { icon: '💡', label: 'TIPP' },
};

/**
 * Startet eine Aufräum-Quest basierend auf der Session-Auswahl.
 * @param {number} minutes - Zeitfenster (2/5/15/30)
 */
export function startCleanupQuest(minutes) {
  ensureQuestElements();

  const maxSteps = minutes <= 5 ? 5 : minutes <= 15 ? 10 : 20;
  const plan = buildCleanupPlan(maxSteps, minutes);

  if (plan.length === 0) {
    showToast('Keine offenen Aufgaben gefunden! 🎉', 'success');
    return;
  }

  quest = {
    type: 'cleanup',
    active: true,
    started: isoNow(),
    last_activity: isoNow(),
    progress: {
      containers_total: plan.length,
      containers_done: 0,
      containers_skipped: 0,
      items_moved: 0,
      items_archived: 0,
      items_decided: 0,
      percent: 0,
      score_start: calculateFreedomIndex().percent,
    },
    current_step: plan[0],
    plan,
    completed_at: null,
  };

  Brain.saveQuest(quest);
  showCleanupStep(quest);
}

function showCleanupStep(q) {
  if (!requestOverlay('cleanup-quest', 50, () => pauseCleanupQuest())) return;

  const overlay = document.getElementById('quest-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';

  const step = q.current_step;
  if (!step) {
    finishCleanupQuest();
    return;
  }

  const progress = getCleanupProgress(q);
  const actionInfo = ACTION_LABELS[step.action_type] || ACTION_LABELS.optimize;
  const fromRoom = Brain.getRoom(step.from_room);
  const fromContainer = Brain.getContainer(step.from_room, step.from_container);

  let stepContent = '';

  switch (step.action_type) {
    case 'move':
      stepContent = renderMoveStep(step, fromRoom, fromContainer);
      break;
    case 'decide':
      stepContent = renderDecideStep(step, fromRoom, fromContainer);
      break;
    case 'consolidate':
      stepContent = renderConsolidateStep(step);
      break;
    case 'optimize':
    default:
      stepContent = renderOptimizeStep(step, fromRoom, fromContainer);
      break;
  }

  overlay.innerHTML = `
    <div class="quest-card cleanup-quest-card">
      <div class="cleanup-quest-header">
        <span>🧹 Aufräum-Quest</span>
        <span>${progress.currentStep} / ${progress.total}</span>
      </div>
      <div class="quest-progress-bar"><div class="quest-progress-fill" style="width:${progress.percent}%"></div></div>
      <div class="cleanup-score-preview quest-score-display">${calculateFreedomIndex().percent}%</div>
      <div class="cleanup-step-badge ${step.action_type}">${actionInfo.icon} ${actionInfo.label}</div>
      ${stepContent}
      <div class="cleanup-quest-footer">
        <button id="cleanup-pause" class="cleanup-action-btn">⏸️ Pause</button>
      </div>
    </div>
  `;

  // Bind action handlers
  bindCleanupStepActions(step);

  overlay.querySelector('#cleanup-pause')?.addEventListener('click', () => pauseCleanupQuest());
  updateMiniBadge();
}

function renderMoveStep(step, fromRoom, fromContainer) {
  const toRoom = step.to_room ? Brain.getRoom(step.to_room) : null;
  const toContainer = step.to_container ? Brain.getContainer(step.to_room, step.to_container) : null;
  const toRoomName = toRoom?.name || step.to_room || '?';
  const toContainerName = toContainer?.name || step.to_container || '(wähle Ziel)';

  return `
    <div class="cleanup-item-name">${escapeHTML(step.item_name)}</div>
    <div class="cleanup-location">📍 Jetzt: ${escapeHTML(fromRoom?.name || step.from_room)} › ${escapeHTML(fromContainer?.name || step.from_container)}</div>
    <div class="cleanup-location">📍 Besser: ${escapeHTML(toRoomName)}${step.to_container ? ' › ' + escapeHTML(toContainerName) : ''}</div>
    <div class="cleanup-reason">"${escapeHTML(step.reason)}"</div>
    <div class="cleanup-location">⏱️ ~${step.estimated_minutes} Minuten</div>
    <div class="cleanup-actions">
      <button id="cleanup-done" class="cleanup-action-btn primary">✅ Erledigt</button>
      <button id="cleanup-skip" class="cleanup-action-btn">⏭️ Überspringen</button>
    </div>
  `;
}

function renderDecideStep(step, fromRoom, fromContainer) {
  const disposal = step.disposal_guide || getDisposalGuide(step.item_name);
  const itemObj = findItemObject(step.from_room, step.from_container, step.item_name);
  const monthsInfo = itemObj?.last_seen
    ? `⏱️ Seit ${Math.round((Date.now() - new Date(itemObj.last_seen).getTime()) / (1000 * 60 * 60 * 24 * 30))} Monaten nicht bewegt`
    : '';
  const valueInfo = itemObj?.valuation?.replacement_value || itemObj?.purchase?.price;

  return `
    <div class="cleanup-item-name">${escapeHTML(step.item_name)}</div>
    <div class="cleanup-location">📍 ${escapeHTML(fromRoom?.name || step.from_room)} › ${escapeHTML(fromContainer?.name || step.from_container)}</div>
    ${monthsInfo ? `<div class="cleanup-location">${monthsInfo}</div>` : ''}
    ${valueInfo ? `<div class="cleanup-location">💰 Geschätzter Wert: ~${valueInfo} €</div>` : ''}
    <div class="disposal-tip">${escapeHTML(disposal.icon)} ${escapeHTML(disposal.text)}</div>
    <div class="cleanup-actions">
      <button id="cleanup-discard" class="cleanup-action-btn danger">🗑️ Entsorgen</button>
      <button id="cleanup-donate" class="cleanup-action-btn donate">🎁 Spenden</button>
      <button id="cleanup-keep" class="cleanup-action-btn">📦 Behalten</button>
    </div>
    <div class="cleanup-actions">
      <button id="cleanup-skip" class="cleanup-action-btn">⏭️ Überspringen</button>
    </div>
  `;
}

function renderConsolidateStep(step) {
  const locations = step.locations || [];
  const locHtml = locations.map(loc =>
    `<div class="cleanup-location">📍 ${escapeHTML(loc.roomName || loc.roomId)} › ${escapeHTML(loc.containerName || loc.containerId)}</div>`
  ).join('');

  return `
    <div class="cleanup-item-name">${escapeHTML(step.item_name)} — ${locations.length}× in ${locations.length} Bereichen</div>
    ${locHtml}
    <div class="cleanup-actions">
      <button id="cleanup-consolidate-reduce" class="cleanup-action-btn primary">1 behalten, Rest entsorgen</button>
      <button id="cleanup-consolidate-keep" class="cleanup-action-btn">Alle behalten, ist gewollt</button>
    </div>
    <div class="cleanup-actions">
      <button id="cleanup-skip" class="cleanup-action-btn">⏭️ Überspringen</button>
    </div>
  `;
}

function renderOptimizeStep(step, fromRoom, fromContainer) {
  return `
    <div class="cleanup-item-name">${escapeHTML(step.item_name)}</div>
    <div class="cleanup-location">📍 ${escapeHTML(fromRoom?.name || step.from_room)} › ${escapeHTML(fromContainer?.name || step.from_container)}</div>
    <div class="cleanup-reason">"${escapeHTML(step.reason)}"</div>
    <div class="cleanup-actions">
      <button id="cleanup-done" class="cleanup-action-btn primary">✅ Tipp umgesetzt</button>
      <button id="cleanup-skip" class="cleanup-action-btn">⏭️ Überspringen</button>
    </div>
  `;
}

function findItemObject(roomId, containerId, itemName) {
  const container = Brain.getContainer(roomId, containerId);
  if (!container) return null;
  return (container.items || []).find(i => {
    const name = typeof i === 'string' ? i : i.name;
    return name === itemName;
  });
}

function bindCleanupStepActions(step) {
  const overlay = document.getElementById('quest-overlay');
  if (!overlay) return;

  // Skip
  overlay.querySelector('#cleanup-skip')?.addEventListener('click', () => {
    markCleanupStep(step, 'skipped');
    advanceCleanupQuest();
  });

  // MOVE done
  overlay.querySelector('#cleanup-done')?.addEventListener('click', async () => {
    if (step.action_type === 'move') {
      await handleMoveAction(step);
    } else {
      // optimize or generic done
      markCleanupStep(step, 'done');
      showToast('Gut gemacht!', 'success');
      advanceCleanupQuest();
    }
  });

  // DECIDE: Entsorgen
  overlay.querySelector('#cleanup-discard')?.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Entsorgen?',
      message: `${step.item_name} wirklich entsorgen?`,
      confirmText: 'Ja, entsorgen',
      cancelText: 'Abbrechen'
    });
    if (!ok) return;
    Brain.archiveItem(step.from_room, step.from_container, step.item_name, 'entsorgt');
    step.archive_reason = 'entsorgt';
    markCleanupStep(step, 'done');
    quest.progress.items_archived = (quest.progress.items_archived || 0) + 1;
    const disposal = step.disposal_guide || getDisposalGuide(step.item_name);
    showToast(`${disposal.icon} ${disposal.text}`, 'success', 3000);
    advanceCleanupQuest();
  });

  // DECIDE: Spenden
  overlay.querySelector('#cleanup-donate')?.addEventListener('click', () => {
    Brain.archiveItem(step.from_room, step.from_container, step.item_name, 'gespendet');
    step.archive_reason = 'gespendet';
    markCleanupStep(step, 'done');
    quest.progress.items_archived = (quest.progress.items_archived || 0) + 1;
    showToast('Auf die Spendenliste gesetzt', 'success');
    advanceCleanupQuest();
  });

  // DECIDE: Behalten
  overlay.querySelector('#cleanup-keep')?.addEventListener('click', () => {
    markCleanupStep(step, 'done');
    showToast('OK, bleibt wo es ist', 'success');
    advanceCleanupQuest();
  });

  // CONSOLIDATE: reduce
  overlay.querySelector('#cleanup-consolidate-reduce')?.addEventListener('click', async () => {
    await handleConsolidateReduce(step);
  });

  // CONSOLIDATE: keep all
  overlay.querySelector('#cleanup-consolidate-keep')?.addEventListener('click', () => {
    markCleanupStep(step, 'done');
    showToast('OK, bleibt alles wo es ist', 'success');
    advanceCleanupQuest();
  });
}

async function handleMoveAction(step) {
  const oldScore = calculateFreedomIndex().percent;

  // Determine target container
  let toRoom = step.to_room;
  let toContainer = step.to_container;

  if (!toContainer && toRoom) {
    // Ask which container in the target room
    const room = Brain.getRoom(toRoom);
    const containers = room ? Object.entries(room.containers || {}) : [];
    if (containers.length > 0) {
      const options = containers.map(([cId, c]) => ({ value: cId, label: c.name || cId }));
      const result = await showInputModal({
        title: `Wohin in ${room?.name || toRoom}?`,
        fields: [{ type: 'select', options }]
      });
      if (!result) return;
      toContainer = result[0];
    }
  }

  if (toRoom && toContainer) {
    if (toRoom === step.from_room) {
      Brain.moveItem(step.from_room, step.from_container, toContainer, step.item_name);
    } else {
      Brain.moveItemCrossRoom(step.from_room, step.from_container, toRoom, toContainer, step.item_name);
    }
    quest.progress.items_moved = (quest.progress.items_moved || 0) + 1;
  }

  markCleanupStep(step, 'done');
  const newScore = calculateFreedomIndex().percent;
  animateScoreChange(oldScore, newScore);
  advanceCleanupQuest();
}

async function handleConsolidateReduce(step) {
  const locations = step.locations || [];
  if (locations.length < 2) {
    markCleanupStep(step, 'done');
    advanceCleanupQuest();
    return;
  }

  const options = locations.map((loc, idx) => ({
    value: String(idx),
    label: `${loc.roomName || loc.roomId} › ${loc.containerName || loc.containerId}`
  }));

  const result = await showInputModal({
    title: 'Welche willst du behalten?',
    fields: [{ type: 'select', options }]
  });
  if (!result) return;

  const keepIdx = parseInt(result[0], 10);
  const oldScore = calculateFreedomIndex().percent;

  locations.forEach((loc, idx) => {
    if (idx !== keepIdx) {
      Brain.archiveItem(loc.roomId, loc.containerId, step.item_name, 'entsorgt');
      quest.progress.items_archived = (quest.progress.items_archived || 0) + 1;
    }
  });

  markCleanupStep(step, 'done');
  step.archive_reason = 'entsorgt';
  const newScore = calculateFreedomIndex().percent;
  animateScoreChange(oldScore, newScore);
  advanceCleanupQuest();
}

function markCleanupStep(step, status) {
  const planStep = quest.plan.find(s => s.step_number === step.step_number);
  if (planStep) planStep.status = status;
}

function getCleanupProgress(q) {
  const done = q.plan.filter(s => s.status === 'done').length;
  const skipped = q.plan.filter(s => s.status === 'skipped').length;
  const total = q.plan.length;
  const currentIdx = q.plan.findIndex(s => s.step_number === q.current_step?.step_number);

  return {
    done,
    skipped,
    total,
    currentStep: currentIdx + 1,
    percent: total > 0 ? Math.round(((done + skipped) / total) * 100) : 0,
  };
}

function advanceCleanupQuest() {
  if (!quest) return;

  const progress = getCleanupProgress(quest);
  quest.progress.containers_done = progress.done;
  quest.progress.containers_skipped = progress.skipped;
  quest.progress.percent = progress.percent;
  quest.last_activity = isoNow();

  // Find next pending step
  const nextStep = quest.plan.find(s => s.status === 'pending');

  if (!nextStep) {
    finishCleanupQuest();
    return;
  }

  quest.current_step = nextStep;
  Brain.saveQuest(quest);
  showCleanupStep(quest);
}

function finishCleanupQuest() {
  if (!quest) return;
  quest.active = false;
  quest.completed_at = isoNow();
  quest.progress.percent = 100;
  Brain.saveQuest(quest);
  showCleanupComplete();
}

function getCleanupSummary(q) {
  const done = q.plan.filter(s => s.status === 'done');
  const skipped = q.plan.filter(s => s.status === 'skipped');

  return {
    totalSteps: q.plan.length,
    doneSteps: done.length,
    skippedSteps: skipped.length,
    itemsMoved: done.filter(s => s.action_type === 'move').length,
    itemsArchived: done.filter(s =>
      s.action_type === 'decide' || s.action_type === 'archive'
    ).length,
    itemsDonated: done.filter(s => s.archive_reason === 'gespendet').length,
    itemsDiscarded: done.filter(s => s.archive_reason === 'entsorgt').length,
    decisions: done.filter(s =>
      s.action_type === 'decide' || s.action_type === 'consolidate'
    ).length,
    scoreStart: q.progress.score_start,
    scoreEnd: calculateFreedomIndex().percent,
    duration: Math.round(
      (Date.now() - new Date(q.started).getTime()) / 60000
    ),
  };
}

function getCompletionMessage(summary, personality) {
  if (personality === 'sachlich') {
    return `${summary.doneSteps} Aufgaben erledigt. Index: ${summary.scoreEnd}%.`;
  }
  if (personality === 'freundlich') {
    return `Super gemacht! ${summary.decisions} Entscheidungen weniger im Kopf.`;
  }
  // kauzig (default)
  const comments = [
    'Na also. Geht doch.',
    'Siehst du. War gar nicht so schlimm.',
    'Dein Oberschrank dankt dir.',
    `Ich hab gesagt es dauert nur ${summary.duration} Minuten. Hatte ich recht? Natürlich.`,
    'Weniger Chaos. Weniger Cortisol. Gern geschehen.',
  ];
  return comments[Math.floor(Math.random() * comments.length)];
}

function showCleanupComplete() {
  const overlay = document.getElementById('quest-overlay');
  if (!overlay || !quest) return;
  overlay.style.display = 'flex';

  const summary = getCleanupSummary(quest);
  const personality = getPersonality();
  const message = getCompletionMessage(summary, personality);

  const scoreDelta = summary.scoreEnd - summary.scoreStart;
  const scoreSign = scoreDelta >= 0 ? '↑' : '↓';

  const stats = [];
  if (summary.itemsMoved > 0) stats.push(`• ${summary.itemsMoved} Dinge umgeräumt`);
  if (summary.decisions > 0) stats.push(`• ${summary.decisions} Entscheidungen getroffen`);
  if (summary.itemsDiscarded > 0) stats.push(`• ${summary.itemsDiscarded} Dinge entsorgt`);
  if (summary.itemsDonated > 0) stats.push(`• ${summary.itemsDonated} Dinge gespendet`);
  if (summary.skippedSteps > 0) stats.push(`• ${summary.skippedSteps} übersprungen`);

  overlay.innerHTML = `
    <div class="quest-card cleanup-complete">
      <h2>🎉 Aufräum-Quest geschafft!</h2>
      <p>In ${summary.duration} Minuten:</p>
      <div class="cleanup-stats">${stats.join('\n')}</div>
      <p>Dein Kopf-Freiheits-Index:</p>
      <div class="cleanup-score-preview">${summary.scoreStart}% → ${summary.scoreEnd}% ${scoreSign}${Math.abs(scoreDelta)}%</div>
      <div class="quest-progress-bar"><div class="quest-progress-fill" style="width:${summary.scoreEnd}%"></div></div>
      <div class="cleanup-quote">"${escapeHTML(message)}"<br>— ORDO</div>
      <div class="cleanup-actions">
        <button id="cleanup-again" class="cleanup-action-btn primary">🧹 Noch eine Runde</button>
        <button id="cleanup-home" class="cleanup-action-btn">🏠 Zurück zu Mein Zuhause</button>
      </div>
    </div>
  `;

  overlay.querySelector('#cleanup-again')?.addEventListener('click', () => {
    overlay.style.display = 'none';
    releaseOverlay('cleanup-quest');
    startCleanupQuest(15);
  });
  overlay.querySelector('#cleanup-home')?.addEventListener('click', () => {
    overlay.style.display = 'none';
    releaseOverlay('cleanup-quest');
    renderBrainView();
    showView('brain');
  });
  updateMiniBadge();
}

function pauseCleanupQuest() {
  isMinimized = true;
  const overlay = document.getElementById('quest-overlay');
  if (overlay) overlay.style.display = 'none';
  releaseOverlay('cleanup-quest');
  updateMiniBadge();
}

function animateScoreChange(oldPercent, newPercent) {
  const el = document.querySelector('.quest-score-display');
  if (!el) return;

  el.classList.add('score-changing');
  el.textContent = `${oldPercent}% → ${newPercent}%`;

  if (newPercent > oldPercent) {
    el.classList.add('score-up');
    const delta = newPercent - oldPercent;
    showToast(`↑${delta}% — dein Kopf wird freier`, 'success');
  }

  setTimeout(() => {
    el.textContent = `${newPercent}%`;
    el.classList.remove('score-changing', 'score-up');
  }, 2000);
}
