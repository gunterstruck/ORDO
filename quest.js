// quest.js – Blueprint & Inventar-Quest

import Brain from './brain.js';
import { analyzeBlueprint as analyzeBlueprintWithAI } from './ai.js';
import { showToast, showInputModal, showConfirmModal } from './modal.js';
import { renderBrainView } from './brain-view.js';
import { handlePhotoFile } from './photo-flow.js';
import { showView } from './app.js';

const ANALYSIS_MESSAGES = [
  'Ich schaue mir deine Wohnung an...',
  'Ah, ich erkenne Möbelstücke...',
  'Mal sehen was in den Räumen steht...',
  'Gleich hab ich alles zusammen...',
  'Fast fertig – ich sortiere die Ergebnisse...'
];

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

  let messageIndex = 0;
  overlay.innerHTML = `
    <div class="quest-card">
      <h2>🏠 Wohnung wird erkannt...</h2>
      <div class="quest-progress-bar"><div id="blueprint-progress-fill" class="quest-progress-fill" style="width:15%"></div></div>
      <p id="blueprint-analysis-message">${ANALYSIS_MESSAGES[0]}</p>
    </div>
  `;

  const interval = window.setInterval(() => {
    messageIndex = (messageIndex + 1) % ANALYSIS_MESSAGES.length;
    const msg = document.getElementById('blueprint-analysis-message');
    const fill = document.getElementById('blueprint-progress-fill');
    if (msg) msg.textContent = ANALYSIS_MESSAGES[messageIndex];
    if (fill) fill.style.width = `${Math.min(95, 15 + messageIndex * 20)}%`;
  }, 3000);

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
    window.clearInterval(interval);
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
    roomRow.innerHTML = `<input type="checkbox" data-room="${roomIndex}" checked> <span data-edit-room="${roomIndex}">${room.emoji || '🏠'} ${room.name || room.id}</span>`;
    list.appendChild(roomRow);

    (room.moebel || []).forEach((m, mIndex) => {
      const mRow = document.createElement('div');
      mRow.className = 'blueprint-review-item moebel';
      mRow.innerHTML = `<input type="checkbox" data-room="${roomIndex}" data-moebel="${mIndex}" checked> <span data-edit-moebel="${roomIndex}:${mIndex}">${m.name}</span>`;
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
    } catch {
      // non-blocking
    }
  });

  renderBrainView();
  showToast(`${roomCount} Räume und ${containerCount} Bereiche angelegt ✓`, 'success');

  const overlay = document.getElementById('quest-overlay');
  if (overlay) overlay.style.display = 'none';
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
    return `<div class="quest-overview-room"><strong>${done === steps.length ? '✅' : '⏳'} ${room} (${done}/${steps.length})</strong>${steps.map(s => `<div class="quest-overview-item" data-room="${s.room_id}" data-container="${s.container_id}">${s.status === 'done' ? '✅' : s.status === 'skipped' ? '⏸️' : '⏳'} ${s.container_name}</div>`).join('')}</div>`;
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
    showView('chat');
  });
  overlay.querySelector('#quest-report')?.addEventListener('click', () => {
    overlay.style.display = 'none';
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
    badge.textContent = `🏠 ${getProgress().percent}% | Weiter →`;
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
