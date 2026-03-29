// quest.js – Blueprint & Inventar-Quest

import Brain from './brain.js';
import { analyzeBlueprint as analyzeBlueprintWithAI, loadingManager, callGemini } from './ai.js';
import { showToast, showInputModal, showConfirmModal } from './modal.js';
import { renderBrainView } from './brain-view.js';
import { handlePhotoFile, handleVideoFile } from './photo-flow.js';
import { showView, escapeHTML, debugLog } from './app.js';
import { requestOverlay, releaseOverlay, isOverlayActive } from './overlay-manager.js';
import { capturePhoto, captureVideo } from './camera.js';
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
  // Only request overlay on first render; skip on re-renders (overlay already registered)
  if (!isOverlayActive('blueprint-review')) {
    if (!requestOverlay('blueprint-review', 50, () => {
      overlay.style.display = 'none';
      releaseOverlay('blueprint-review');
      blueprintState = null;
    })) return;
  }
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
        <button id="blueprint-add-video" class="onboarding-btn-secondary">🎬 Video-Rundgang starten</button>
        <button id="blueprint-upload-video" class="onboarding-btn-secondary">📁 Video hochladen</button>
        <button id="blueprint-finish" class="onboarding-btn-secondary" ${blueprintState.photos.length === 0 ? 'disabled' : ''}>Das waren alle Räume → Weiter</button>
        <button id="blueprint-cancel" class="onboarding-btn-skip">Abbrechen</button>
      </div>
      <input id="blueprint-video-input" type="file" accept="video/*" style="display:none">
    </div>
  `;

  overlay.querySelector('#blueprint-add-photo')?.addEventListener('click', async () => {
    const file = await capturePhoto();
    if (file) await addBlueprintPhoto(file);
  });
  overlay.querySelector('#blueprint-add-video')?.addEventListener('click', async () => {
    const file = await captureVideo(300); // max 5 min
    if (file) {
      overlay.style.display = 'none';
      releaseOverlay('blueprint-review');
      blueprintState = null;
      handleVideoFile(file);
    }
  });
  overlay.querySelector('#blueprint-upload-video')?.addEventListener('click', () => {
    overlay.querySelector('#blueprint-video-input')?.click();
  });
  overlay.querySelector('#blueprint-video-input')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (file) {
      overlay.style.display = 'none';
      releaseOverlay('blueprint-review');
      blueprintState = null;
      handleVideoFile(file);
    }
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

const ROOM_SUGGESTIONS = [
  'Wohnzimmer', 'Schlafzimmer', 'Küche', 'Bad',
  'Flur', 'Kinderzimmer', 'Arbeitszimmer', 'Abstellraum',
  'Keller', 'Balkon', 'Garage', 'Gästezimmer',
];

function showRoomNamePicker(photoBlob) {
  return new Promise(resolve => {
    const alreadyUsed = new Set((blueprintState?.photos || []).map(p => p.userLabel));
    const suggestions = ROOM_SUGGESTIONS.filter(r => !alreadyUsed.has(r));

    const result = showInputModal({
      title: 'Raum benennen (optional)',
      description: 'Wähle, tippe, oder beschreib den Raum:',
      fields: [{ placeholder: 'z.B. Küche, Wohnzimmer...' }]
    });

    // After modal is visible, inject quick-select buttons + chat
    setTimeout(() => {
      const fieldsEl = document.getElementById('ordo-modal-fields');
      if (!fieldsEl) { result.then(resolve); return; }
      const input = fieldsEl.querySelector('input');

      // Quick-select room buttons
      if (suggestions.length > 0) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px';
        for (const name of suggestions) {
          const btn = document.createElement('button');
          btn.textContent = name;
          btn.className = 'onboarding-btn-secondary';
          btn.style.cssText = 'padding:6px 12px;font-size:14px;margin:0';
          btn.addEventListener('click', () => {
            if (input) input.value = name;
            document.querySelector('.ordo-modal-btn--primary')?.click();
          });
          row.appendChild(btn);
        }
        fieldsEl.appendChild(row);
      }

      // Mini-chat section
      const chatSection = document.createElement('div');
      chatSection.style.cssText = 'margin-top:12px;border-top:1px solid #eee;padding-top:10px';
      chatSection.innerHTML = `
        <div style="font-size:13px;color:#888;margin-bottom:6px">💬 Oder beschreib den Raum:</div>
        <div id="room-chat-log" style="max-height:120px;overflow-y:auto;margin-bottom:8px;font-size:13px"></div>
        <div style="display:flex;gap:6px">
          <input id="room-chat-input" type="text" class="ordo-modal-input" placeholder="z.B. &quot;Das ist wo wir kochen&quot;" style="flex:1;margin:0">
          <button id="room-chat-send" class="onboarding-btn-primary" style="padding:6px 14px;font-size:14px;margin:0;white-space:nowrap">Fragen</button>
        </div>
      `;
      fieldsEl.appendChild(chatSection);

      const chatInput = document.getElementById('room-chat-input');
      const chatSend = document.getElementById('room-chat-send');
      const chatLog = document.getElementById('room-chat-log');
      let chatHistory = [];

      async function sendChatForRoom() {
        const text = chatInput?.value?.trim();
        if (!text) return;
        chatInput.value = '';
        chatSend.disabled = true;
        chatSend.textContent = '...';

        // Show user message
        const userBubble = document.createElement('div');
        userBubble.style.cssText = 'padding:4px 8px;border-radius:8px;background:#f0f0f0;margin-bottom:4px';
        userBubble.textContent = text;
        chatLog.appendChild(userBubble);
        chatLog.scrollTop = chatLog.scrollHeight;

        chatHistory.push({ role: 'user', content: text });

        try {
          const apiKey = Brain.getApiKey();
          if (!apiKey) throw new Error('Kein API-Key');

          const usedList = [...alreadyUsed].join(', ');
          const systemPrompt = `Du bist ein freundlicher Assistent der hilft, Räume zu benennen.
Der Nutzer beschreibt einen Raum oder sagt was drin ist. Erkenne welcher Raum es ist.
${usedList ? `Bereits erfasste Räume (nicht nochmal vorschlagen): ${usedList}` : ''}
Antworte kurz und freundlich. Nenne den erkannten Raumnamen klar.
Antworte mit diesem JSON am Ende deiner Nachricht:
{"raum_name": "Erkannter Name"}`;

          // Build messages including photo context if available
          const messages = [];
          if (photoBlob && chatHistory.length === 1) {
            const base64 = await blobToBase64(photoBlob);
            messages.push({
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: photoBlob.type || 'image/jpeg', data: base64 } },
                { type: 'text', text }
              ]
            });
          } else {
            for (const m of chatHistory) {
              messages.push({ role: m.role, content: m.content });
            }
          }

          const raw = await callGemini(apiKey, systemPrompt, messages, { taskType: 'chat' });
          const responseText = typeof raw === 'string' ? raw : (raw.text || '');

          chatHistory.push({ role: 'assistant', content: responseText });

          // Extract room name from JSON in response
          const jsonMatch = responseText.match(/\{\s*"raum_name"\s*:\s*"([^"]+)"\s*\}/);
          const displayText = responseText.replace(/\{[\s\S]*?\}/g, '').trim();

          // Show bot response
          const botBubble = document.createElement('div');
          botBubble.style.cssText = 'padding:4px 8px;border-radius:8px;background:#fff3e6;margin-bottom:4px';
          botBubble.textContent = displayText || responseText;
          chatLog.appendChild(botBubble);

          if (jsonMatch?.[1]) {
            const roomName = jsonMatch[1];
            if (input) input.value = roomName;
            // Show accept button
            const acceptBtn = document.createElement('button');
            acceptBtn.className = 'onboarding-btn-primary';
            acceptBtn.style.cssText = 'padding:6px 14px;font-size:14px;margin:4px 0 0;width:100%';
            acceptBtn.textContent = `✓ "${roomName}" übernehmen`;
            acceptBtn.addEventListener('click', () => {
              document.querySelector('.ordo-modal-btn--primary')?.click();
            });
            chatLog.appendChild(acceptBtn);
          }

          chatLog.scrollTop = chatLog.scrollHeight;
        } catch (err) {
          debugLog(`Room-Chat Fehler: ${err.message}`);
          const errBubble = document.createElement('div');
          errBubble.style.cssText = 'padding:4px 8px;color:#c0392b;font-size:12px';
          errBubble.textContent = 'Fehler – versuch es nochmal oder tippe den Namen direkt ein.';
          chatLog.appendChild(errBubble);
        } finally {
          chatSend.disabled = false;
          chatSend.textContent = 'Fragen';
        }
      }

      chatSend?.addEventListener('click', sendChatForRoom);
      chatInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); sendChatForRoom(); }
      });

      result.then(resolve);
    }, 60);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function addBlueprintPhoto(roomPhotoBlob) {
  if (!blueprintState) return;
  const result = await showRoomNamePicker(roomPhotoBlob);
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
  if (!quest?.active) return;
  if (quest.type === 'cleanup') {
    showCleanupStep(quest);
  } else {
    if (!quest.current_step) return;
    if (!requestOverlay('quest-overlay', 50, () => pauseQuest())) return;
    const overlay = document.getElementById('quest-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    renderQuestOverlay();
    updateMiniBadge();
  }
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
    const icon = quest.type === 'cleanup' ? '\u{1F9F9}' : '\u{1F3E0}';
    badge.textContent = `${icon} ${getProgress().percent}% | Weiter \u2192`;
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

// ── Aufräum-Quest (Cleanup Quest) ─────────────────────

/**
 * Startet eine Aufräum-Quest basierend auf der Session-Auswahl.
 * @param {number} minutes - Zeitfenster (5/15/30)
 */
export function startCleanupQuest(minutes) {
  ensureQuestElements();
  const maxSteps = minutes <= 5 ? 5 : minutes <= 15 ? 10 : 20;
  const plan = buildCleanupPlan(maxSteps, minutes);

  if (plan.length === 0) {
    showToast('Keine offenen Aufgaben gefunden! \u{1F389}', 'success');
    return;
  }

  const scoreNow = calculateFreedomIndex().percent;

  quest = {
    type: 'cleanup',
    active: true,
    started: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    progress: {
      containers_total: plan.length,
      containers_done: 0,
      containers_skipped: 0,
      items_moved: 0,
      items_archived: 0,
      items_decided: 0,
      percent: 0,
      score_start: scoreNow,
    },
    current_step: plan[0],
    plan,
    completed_at: null,
  };

  Brain.saveQuest(quest);
  showCleanupStep(quest);
}

function showCleanupStep(q) {
  ensureQuestElements();
  if (!q?.active || !q.plan) return;

  const currentStep = q.plan.find(s => s.status === 'pending');
  if (!currentStep) {
    finishCleanupQuest();
    return;
  }
  q.current_step = currentStep;

  if (!requestOverlay('cleanup-quest', 50, () => pauseCleanupQuest())) return;

  const overlay = document.getElementById('quest-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';

  const done = q.plan.filter(s => s.status === 'done').length;
  const skipped = q.plan.filter(s => s.status === 'skipped').length;
  const total = q.plan.length;
  const stepNum = done + skipped + 1;
  const percent = total > 0 ? Math.round(((done + skipped) / total) * 100) : 0;

  const scoreNow = calculateFreedomIndex().percent;

  let stepContent = '';
  switch (currentStep.action_type) {
    case 'move': stepContent = renderMoveStep(currentStep); break;
    case 'decide': stepContent = renderDecideStep(currentStep); break;
    case 'consolidate': stepContent = renderConsolidateStep(currentStep); break;
    default: stepContent = renderOptimizeStep(currentStep); break;
  }

  overlay.innerHTML = `
    <div class="quest-card cleanup-quest-card">
      <div class="cleanup-quest-header">
        <span>\u{1F9F9} Aufr\u00e4um-Quest</span>
        <span>${stepNum} / ${total}</span>
      </div>
      <div class="quest-progress-bar"><div class="quest-progress-fill" style="width:${percent}%"></div></div>
      <div class="cleanup-score-preview quest-score-display">${scoreNow}%</div>
      ${stepContent}
      <div class="cleanup-actions-footer">
        <button id="cleanup-pause" class="cleanup-action-btn">\u23F8\uFE0F Pause</button>
      </div>
    </div>
  `;

  // Wire up action buttons
  wireCleanupActions(overlay, currentStep, q);
  overlay.querySelector('#cleanup-pause')?.addEventListener('click', () => pauseCleanupQuest());

  updateMiniBadge();
}

function renderMoveStep(step) {
  const fromRoom = Brain.getRoom(step.from_room);
  const fromContainer = Brain.getContainer(step.from_room, step.from_container);
  const toRoom = step.to_room ? Brain.getRoom(step.to_room) : null;

  return `
    <div class="cleanup-step-badge move">\u{1F504} UMRÄUMEN</div>
    <div class="cleanup-item-name">${escapeHTML(step.item_name)}</div>
    <div class="cleanup-location">\u{1F4CD} Jetzt: ${escapeHTML(fromRoom?.name || step.from_room)} &gt; ${escapeHTML(fromContainer?.name || step.from_container)}</div>
    ${toRoom ? `<div class="cleanup-location">\u{1F4CD} Besser: ${escapeHTML(toRoom.name)}${step.to_container ? ' &gt; ' + escapeHTML(step.to_container) : ''}</div>` : ''}
    ${step.reason ? `<div class="cleanup-reason">"${escapeHTML(step.reason)}"</div>` : ''}
    <div class="cleanup-location">\u23F1\uFE0F ~${step.estimated_minutes} Minuten</div>
    <div class="cleanup-actions">
      <button class="cleanup-action-btn primary" data-action="done">\u2705 Erledigt</button>
      <button class="cleanup-action-btn" data-action="skip">\u23ED\uFE0F \u00DCberspringen</button>
    </div>
  `;
}

function renderDecideStep(step) {
  const fromRoom = Brain.getRoom(step.from_room);
  const fromContainer = Brain.getContainer(step.from_room, step.from_container);
  const disposal = step.disposal_guide || getDisposalGuide(step.item_name);

  return `
    <div class="cleanup-step-badge decide">\u{1F914} ENTSCHEIDEN</div>
    <div class="cleanup-item-name">${escapeHTML(step.item_name)}</div>
    <div class="cleanup-location">\u{1F4CD} ${escapeHTML(fromRoom?.name || step.from_room)} &gt; ${escapeHTML(fromContainer?.name || step.from_container)}</div>
    ${step.reason ? `<div class="cleanup-location">\u23F1\uFE0F ${escapeHTML(step.reason)}</div>` : ''}
    <div class="disposal-tip">${escapeHTML(disposal.icon)} ${escapeHTML(disposal.text)}</div>
    <div class="cleanup-actions">
      <button class="cleanup-action-btn danger" data-action="discard">\u{1F5D1}\uFE0F Entsorgen</button>
      <button class="cleanup-action-btn donate" data-action="donate">\u{1F381} Spenden</button>
      <button class="cleanup-action-btn" data-action="keep">\u{1F4E6} Behalten</button>
    </div>
    <div class="cleanup-actions">
      <button class="cleanup-action-btn" data-action="skip">\u23ED\uFE0F \u00DCberspringen</button>
    </div>
  `;
}

function renderConsolidateStep(step) {
  const locs = step.locations || [];
  const locList = locs.map(l => {
    const room = Brain.getRoom(l.roomId);
    return `<div class="cleanup-location">\u{1F4CD} ${escapeHTML(room?.name || l.roomId)} &gt; ${escapeHTML(l.containerName || l.containerId)}</div>`;
  }).join('');

  return `
    <div class="cleanup-step-badge consolidate">\u{1F4E6} ZUSAMMENLEGEN</div>
    <div class="cleanup-item-name">${escapeHTML(step.item_name)} \u2014 ${locs.length}\u00D7 in ${locs.length} Bereichen</div>
    ${locList}
    <div class="cleanup-actions">
      <button class="cleanup-action-btn primary" data-action="consolidate-keep-one">1 behalten, Rest entsorgen</button>
      <button class="cleanup-action-btn" data-action="consolidate-keep-all">Alle behalten, ist gewollt</button>
    </div>
    <div class="cleanup-actions">
      <button class="cleanup-action-btn" data-action="skip">\u23ED\uFE0F \u00DCberspringen</button>
    </div>
  `;
}

function renderOptimizeStep(step) {
  const fromRoom = Brain.getRoom(step.from_room);
  const fromContainer = Brain.getContainer(step.from_room, step.from_container);

  return `
    <div class="cleanup-step-badge optimize">\u{1F4A1} TIPP</div>
    <div class="cleanup-item-name">${escapeHTML(step.item_name || step.reason || 'Optimierung')}</div>
    ${step.from_room ? `<div class="cleanup-location">\u{1F4CD} ${escapeHTML(fromRoom?.name || step.from_room)}${fromContainer ? ' &gt; ' + escapeHTML(fromContainer.name) : ''}</div>` : ''}
    ${step.reason ? `<div class="cleanup-reason">"${escapeHTML(step.reason)}"</div>` : ''}
    <div class="cleanup-actions">
      <button class="cleanup-action-btn primary" data-action="tip-done">\u2705 Tipp umgesetzt</button>
      <button class="cleanup-action-btn" data-action="skip">\u23ED\uFE0F \u00DCberspringen</button>
    </div>
  `;
}

function wireCleanupActions(overlay, step, q) {
  // MOVE: done
  overlay.querySelector('[data-action="done"]')?.addEventListener('click', async () => {
    const oldScore = calculateFreedomIndex().percent;

    if (step.to_room) {
      let targetContainer = step.to_container;
      if (!targetContainer) {
        // Ask user to pick a container in the target room
        const targetRoom = Brain.getRoom(step.to_room);
        const containers = Object.entries(targetRoom?.containers || {});
        if (containers.length > 0) {
          const options = containers.map(([cId, c]) => ({ value: cId, label: c.name || cId }));
          const result = await showInputModal({
            title: 'Wohin hast du es gelegt?',
            fields: [{ type: 'select', options }]
          });
          targetContainer = result?.[0] || containers[0][0];
        } else {
          targetContainer = null;
        }
      }
      if (targetContainer) {
        Brain.moveItemAcrossRooms(step.from_room, step.from_container, step.to_room, targetContainer, step.item_name);
      }
    }

    completeCleanupStep(q, step, 'done');
    q.progress.items_moved = (q.progress.items_moved || 0) + 1;
    Brain.saveQuest(q);

    const newScore = calculateFreedomIndex().percent;
    animateScoreChange(oldScore, newScore);
    showCleanupStep(q);
  });

  // DECIDE: discard
  overlay.querySelector('[data-action="discard"]')?.addEventListener('click', () => {
    const oldScore = calculateFreedomIndex().percent;
    Brain.archiveItem(step.from_room, step.from_container, step.item_name, 'entsorgt');
    step.archive_reason = 'entsorgt';
    completeCleanupStep(q, step, 'done');
    q.progress.items_archived = (q.progress.items_archived || 0) + 1;
    Brain.saveQuest(q);

    const disposal = step.disposal_guide || getDisposalGuide(step.item_name);
    showToast(`${disposal.icon} ${disposal.text}`, 'success', 3000);

    const newScore = calculateFreedomIndex().percent;
    animateScoreChange(oldScore, newScore);
    showCleanupStep(q);
  });

  // DECIDE: donate
  overlay.querySelector('[data-action="donate"]')?.addEventListener('click', () => {
    const oldScore = calculateFreedomIndex().percent;
    Brain.archiveItem(step.from_room, step.from_container, step.item_name, 'gespendet');
    step.archive_reason = 'gespendet';
    completeCleanupStep(q, step, 'done');
    q.progress.items_archived = (q.progress.items_archived || 0) + 1;
    Brain.saveQuest(q);
    showToast('Auf die Spendenliste gesetzt', 'success');

    const newScore = calculateFreedomIndex().percent;
    animateScoreChange(oldScore, newScore);
    showCleanupStep(q);
  });

  // DECIDE: keep
  overlay.querySelector('[data-action="keep"]')?.addEventListener('click', () => {
    completeCleanupStep(q, step, 'done');
    Brain.saveQuest(q);
    showToast('OK, bleibt wo es ist');
    showCleanupStep(q);
  });

  // CONSOLIDATE: keep one
  overlay.querySelector('[data-action="consolidate-keep-one"]')?.addEventListener('click', async () => {
    const locs = step.locations || [];
    if (locs.length > 1) {
      const options = locs.map((l, i) => {
        const room = Brain.getRoom(l.roomId);
        return { value: String(i), label: `${room?.name || l.roomId} > ${l.containerName || l.containerId}` };
      });
      const result = await showInputModal({
        title: 'Welche willst du behalten?',
        fields: [{ type: 'select', options }]
      });
      const keepIdx = parseInt(result?.[0] || '0', 10);
      const oldScore = calculateFreedomIndex().percent;
      locs.forEach((l, i) => {
        if (i !== keepIdx) {
          Brain.archiveItem(l.roomId, l.containerId, step.item_name, 'entsorgt');
        }
      });
      step.archive_reason = 'entsorgt';
      completeCleanupStep(q, step, 'done');
      q.progress.items_archived = (q.progress.items_archived || 0) + (locs.length - 1);
      Brain.saveQuest(q);

      const newScore = calculateFreedomIndex().percent;
      animateScoreChange(oldScore, newScore);
    } else {
      completeCleanupStep(q, step, 'done');
      Brain.saveQuest(q);
    }
    showCleanupStep(q);
  });

  // CONSOLIDATE: keep all
  overlay.querySelector('[data-action="consolidate-keep-all"]')?.addEventListener('click', () => {
    completeCleanupStep(q, step, 'done');
    Brain.saveQuest(q);
    showToast('OK, alle behalten');
    showCleanupStep(q);
  });

  // OPTIMIZE: tip done
  overlay.querySelector('[data-action="tip-done"]')?.addEventListener('click', () => {
    completeCleanupStep(q, step, 'done');
    Brain.saveQuest(q);
    showToast('Gut gemacht!', 'success');
    showCleanupStep(q);
  });

  // Skip (all types)
  overlay.querySelector('[data-action="skip"]')?.addEventListener('click', () => {
    completeCleanupStep(q, step, 'skipped');
    Brain.saveQuest(q);
    showCleanupStep(q);
  });
}

function completeCleanupStep(q, step, status) {
  step.status = status;
  const done = q.plan.filter(s => s.status === 'done').length;
  const skipped = q.plan.filter(s => s.status === 'skipped').length;
  const total = q.plan.length;
  q.progress.containers_done = done;
  q.progress.containers_skipped = skipped;
  q.progress.percent = total > 0 ? Math.round(((done + skipped) / total) * 100) : 0;
  q.last_activity = new Date().toISOString();

  if (status === 'done' && (step.action_type === 'decide' || step.action_type === 'consolidate')) {
    q.progress.items_decided = (q.progress.items_decided || 0) + 1;
  }
}

function finishCleanupQuest() {
  if (!quest) return;
  quest.active = false;
  quest.completed_at = new Date().toISOString();
  quest.progress.percent = 100;
  Brain.saveQuest(quest);
  showCleanupCompleted(quest);
}

function pauseCleanupQuest() {
  isMinimized = true;
  const overlay = document.getElementById('quest-overlay');
  if (overlay) overlay.style.display = 'none';
  releaseOverlay('cleanup-quest');
  updateMiniBadge();
}

function getCleanupSummary(q) {
  const done = q.plan.filter(s => s.status === 'done');
  const skipped = q.plan.filter(s => s.status === 'skipped');

  return {
    totalSteps: q.plan.length,
    doneSteps: done.length,
    skippedSteps: skipped.length,
    itemsMoved: done.filter(s => s.action_type === 'move').length,
    itemsArchived: done.filter(s => s.archive_reason === 'entsorgt').length,
    itemsDonated: done.filter(s => s.archive_reason === 'gespendet').length,
    decisions: done.filter(s => s.action_type === 'decide' || s.action_type === 'consolidate').length,
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
    `Ich hab gesagt es dauert nur ${summary.duration} Minuten. Hatte ich recht? Nat\u00fcrlich.`,
    'Weniger Chaos. Weniger Cortisol. Gern geschehen.',
  ];
  return comments[Math.floor(Math.random() * comments.length)];
}

function showCleanupCompleted(q) {
  const overlay = document.getElementById('quest-overlay');
  if (!overlay) return;

  if (!requestOverlay('cleanup-quest', 50, () => {
    overlay.style.display = 'none';
    releaseOverlay('cleanup-quest');
  })) {
    // If overlay was already registered, just reuse it
    releaseOverlay('cleanup-quest');
    requestOverlay('cleanup-quest', 50, () => {
      overlay.style.display = 'none';
      releaseOverlay('cleanup-quest');
    });
  }

  overlay.style.display = 'flex';

  const summary = getCleanupSummary(q);
  const personality = getPersonality();
  const message = getCompletionMessage(summary, personality);
  const scoreDelta = summary.scoreEnd - summary.scoreStart;
  const deltaStr = scoreDelta > 0 ? `\u2191${scoreDelta}%` : (scoreDelta === 0 ? '\u00B10%' : `\u2193${Math.abs(scoreDelta)}%`);

  const stats = [];
  if (summary.itemsMoved > 0) stats.push(`\u2022 ${summary.itemsMoved} Dinge umger\u00e4umt`);
  if (summary.decisions > 0) stats.push(`\u2022 ${summary.decisions} Entscheidungen getroffen`);
  if (summary.itemsArchived > 0) stats.push(`\u2022 ${summary.itemsArchived} Dinge entsorgt`);
  if (summary.itemsDonated > 0) stats.push(`\u2022 ${summary.itemsDonated} Dinge gespendet`);
  if (summary.skippedSteps > 0) stats.push(`\u2022 ${summary.skippedSteps} \u00fcbersprungen`);

  overlay.innerHTML = `
    <div class="quest-card cleanup-complete">
      <h2>\u{1F389} Aufr\u00e4um-Quest geschafft!</h2>
      <p>In ${summary.duration} Minuten:</p>
      <div class="cleanup-stats">${stats.join('\n')}</div>
      <div class="cleanup-score-preview">
        <div>Dein Kopf-Freiheits-Index:</div>
        <div>${summary.scoreStart}% \u2192 ${summary.scoreEnd}%  ${deltaStr}</div>
        <div class="quest-progress-bar" style="margin-top:8px"><div class="quest-progress-fill" style="width:${summary.scoreEnd}%"></div></div>
      </div>
      <div class="cleanup-quote">"${escapeHTML(message)}"<br>\u2014 ORDO</div>
      <div class="cleanup-actions">
        <button class="cleanup-action-btn primary" id="cleanup-again">\u{1F9F9} Noch eine Runde</button>
        <button class="cleanup-action-btn" id="cleanup-home">\u{1F3E0} Zur\u00fcck zu Mein Zuhause</button>
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
    isMinimized = false;
    updateMiniBadge();
    renderBrainView();
    showView('brain');
  });
}

function animateScoreChange(oldPercent, newPercent) {
  const el = document.querySelector('.quest-score-display');
  if (!el) return;

  el.classList.add('score-changing');
  el.textContent = `${oldPercent}% \u2192 ${newPercent}%`;

  if (newPercent > oldPercent) {
    el.classList.add('score-up');
    const delta = newPercent - oldPercent;
    showToast(`\u2191${delta}% \u2014 dein Kopf wird freier`, 'success');
  }

  setTimeout(() => {
    el.textContent = `${newPercent}%`;
    el.classList.remove('score-changing', 'score-up');
  }, 2000);
}
