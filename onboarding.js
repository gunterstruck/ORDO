import Brain from './brain.js';
import { callGemini, getErrorMessage, deleteGeminiFile, uploadVideoToGemini } from './ai.js';
import { showToast } from './modal.js';
import { debugLog, showView, ROOM_PRESETS } from './app.js';
import { resizeImage, blobToBase64, showStagingOverlay, addFileToStaging, showReviewPopup, setStagingTarget, closeStagingOverlay } from './photo-flow.js';

let scannedRooms = [];
let videoScanAbortController = null;

export function setupOnboarding() {
  document.getElementById('onboarding-start').addEventListener('click', () => showOnboardingScreen('scan'));
  document.getElementById('onboarding-skip').addEventListener('click', finishOnboarding);
  document.getElementById('onboarding-scan-photo-btn').addEventListener('click', () => {
    document.getElementById('onboarding-scan-input').click();
  });
  document.getElementById('onboarding-scan-video-btn').addEventListener('click', () => {
    document.getElementById('onboarding-video-input').click();
  });
  document.getElementById('onboarding-scan-input').addEventListener('change', onRoomScanPhoto);
  document.getElementById('onboarding-video-input').addEventListener('change', onRoomScanVideo);
  document.getElementById('onboarding-add-more').addEventListener('click', () => showOnboardingScreen('scan'));
  document.getElementById('onboarding-confirm-all').addEventListener('click', confirmAllScannedRooms);
  document.getElementById('onboarding-finish').addEventListener('click', finishOnboarding);

  // Settings re-trigger
  document.getElementById('settings-room-scan').addEventListener('click', startRoomScan);
}

export function showOnboarding() {
  scannedRooms = [];
  document.getElementById('nav').style.display = 'none';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const onb = document.getElementById('view-onboarding');
  onb.style.display = 'flex';
  onb.classList.add('active');
  showOnboardingScreen('welcome');
}

export function showOnboardingScreen(screen) {
  const screens = ['onboarding-welcome', 'onboarding-step-scan', 'onboarding-step-review', 'onboarding-step-done'];
  screens.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const map = { welcome: 'onboarding-welcome', scan: 'onboarding-step-scan', review: 'onboarding-step-review', done: 'onboarding-step-done' };
  const el = document.getElementById(map[screen]);
  if (el) el.style.display = 'flex';

  if (screen === 'scan') {
    document.getElementById('onboarding-scan-status').style.display = 'none';
    const btns = document.querySelector('.onboarding-scan-buttons');
    if (btns) btns.style.display = 'flex';
    const labels = document.querySelector('.onboarding-scan-labels');
    if (labels) labels.style.display = 'flex';
    const count = scannedRooms.length;
    document.getElementById('onboarding-scan-desc').textContent = count === 0
      ? 'Fotografiere einen Raum oder filme einen Rundgang durch deine Wohnung (max. 5 Min.).'
      : `${count} ${count === 1 ? 'Raum' : 'Räume'} erkannt. Fotografiere oder filme den nächsten Raum.`;
  }
  if (screen === 'review') {
    renderScannedRoomCards();
  }
}

// Shared prompt for room detection (photo + video)
const ROOM_DETECT_SYSTEM_PROMPT_SINGLE = `Du bist ein Raumerkennungs-Assistent. Analysiere dieses Foto und erkenne:
1. Um welchen Raum es sich handelt (z.B. Küche, Wohnzimmer, Schlafzimmer, Bad, Arbeitszimmer, Keller, Flur, Kinderzimmer, Garage, Balkon, Dachboden, Gästezimmer)
2. Welche Aufbewahrungsmöbel sichtbar sind (Schränke, Regale, Schubladen, Kommoden, Tische, Kisten etc.)

Antworte NUR mit diesem JSON:
{
  "raum_typ": "kueche",
  "raum_name": "Küche",
  "raum_emoji": "🍳",
  "moebel": [
    {"name": "Hängeschrank über Spüle", "typ": "schrank"},
    {"name": "Gewürzregal", "typ": "regal"}
  ],
  "konfidenz": "hoch"
}

Regeln:
- raum_typ muss einer dieser IDs sein: kueche, wohnzimmer, schlafzimmer, bad, arbeitszimmer, keller, flur, kinderzimmer, garage, balkon, dachboden, gaestezimmer, sonstiges
- Für raum_name verwende den deutschen Namen
- moebel.typ muss sein: schrank, regal, schublade, kiste, tisch, kommode, sonstiges
- Benenne Möbel spezifisch nach Position/Eigenschaft (z.B. "Schrank links neben Tür", "Bücherregal an der Wand")
- Erkenne nur deutlich sichtbare Möbel, erfinde keine
- konfidenz: hoch/mittel/niedrig – wie sicher bist du beim Raumtyp?`;

const ROOM_DETECT_SYSTEM_PROMPT_MULTI = (n) => `Du bist ein Raumerkennungs-Assistent. Du siehst ${n} Fotos desselben Raums aus verschiedenen Blickwinkeln.
Identifiziere jedes Möbelstück nur EINMAL, auch wenn es in mehreren Fotos sichtbar ist.

Antworte NUR mit diesem JSON:
{
  "raum_typ": "kueche",
  "raum_name": "Küche",
  "raum_emoji": "🍳",
  "moebel": [
    {"name": "Hängeschrank über Spüle", "typ": "schrank"},
    {"name": "Gewürzregal", "typ": "regal"}
  ],
  "konfidenz": "hoch"
}

Regeln:
- raum_typ muss einer dieser IDs sein: kueche, wohnzimmer, schlafzimmer, bad, arbeitszimmer, keller, flur, kinderzimmer, garage, balkon, dachboden, gaestezimmer, sonstiges
- Für raum_name verwende den deutschen Namen
- moebel.typ muss sein: schrank, regal, schublade, kiste, tisch, kommode, sonstiges
- Benenne Möbel spezifisch nach Position/Eigenschaft (z.B. "Schrank links neben Tür", "Bücherregal an der Wand")
- Erkenne nur deutlich sichtbare Möbel, erfinde keine
- WICHTIG: Jedes Möbelstück nur EINMAL auflisten, auch wenn es in mehreren Fotos aus verschiedenen Winkeln zu sehen ist
- konfidenz: hoch/mittel/niedrig – wie sicher bist du beim Raumtyp?`;

const ROOM_DETECT_SYSTEM_PROMPT_VIDEO = `Du bist ein Raumerkennungs-Assistent. Analysiere dieses Video eines Wohnungsrundgangs.
Erkenne ALLE verschiedenen Räume, die im Video zu sehen sind, und die sichtbaren Aufbewahrungsmöbel in jedem Raum.

Antworte NUR mit diesem JSON:
{
  "raeume": [
    {
      "raum_typ": "kueche",
      "raum_name": "Küche",
      "raum_emoji": "🍳",
      "moebel": [
        {"name": "Hängeschrank über Spüle", "typ": "schrank"},
        {"name": "Gewürzregal", "typ": "regal"}
      ]
    },
    {
      "raum_typ": "wohnzimmer",
      "raum_name": "Wohnzimmer",
      "raum_emoji": "🛋️",
      "moebel": [
        {"name": "TV-Schrank", "typ": "schrank"},
        {"name": "Bücherregal", "typ": "regal"}
      ]
    }
  ]
}

Regeln:
- raum_typ muss einer dieser IDs sein: kueche, wohnzimmer, schlafzimmer, bad, arbeitszimmer, keller, flur, kinderzimmer, garage, balkon, dachboden, gaestezimmer, sonstiges
- Für raum_name verwende den deutschen Namen
- moebel.typ muss sein: schrank, regal, schublade, kiste, tisch, kommode, sonstiges
- Benenne Möbel spezifisch nach Position/Eigenschaft (z.B. "Schrank links neben Tür", "Bücherregal an der Wand")
- Erkenne nur deutlich sichtbare Möbel, erfinde keine
- Jeden Raum nur einmal auflisten, auch wenn er mehrfach im Video erscheint
- Bei Fluren/Durchgängen nur auflisten wenn dort Möbel stehen`;

function showScanSpinner(text, showCancel = false) {
  const btns = document.querySelector('.onboarding-scan-buttons');
  if (btns) btns.style.display = 'none';
  const labels = document.querySelector('.onboarding-scan-labels');
  if (labels) labels.style.display = 'none';
  const status = document.getElementById('onboarding-scan-status');
  status.style.display = 'flex';
  document.getElementById('onboarding-scan-status-text').textContent = text || 'KI analysiert…';

  // Cancel button for video processing
  let cancelBtn = document.getElementById('onboarding-scan-cancel');
  if (showCancel) {
    if (!cancelBtn) {
      cancelBtn = document.createElement('button');
      cancelBtn.id = 'onboarding-scan-cancel';
      cancelBtn.className = 'onboarding-btn-skip';
      cancelBtn.style.marginTop = '12px';
      cancelBtn.textContent = 'Abbrechen';
      status.appendChild(cancelBtn);
    }
    cancelBtn.style.display = '';
    cancelBtn.onclick = () => {
      if (videoScanAbortController) {
        videoScanAbortController.abort();
        videoScanAbortController = null;
      }
      hideScanSpinner();
      showToast('Video-Verarbeitung abgebrochen.', 'warning');
    };
  } else if (cancelBtn) {
    cancelBtn.style.display = 'none';
  }
}

function hideScanSpinner() {
  const btns = document.querySelector('.onboarding-scan-buttons');
  if (btns) btns.style.display = 'flex';
  const labels = document.querySelector('.onboarding-scan-labels');
  if (labels) labels.style.display = 'flex';
  document.getElementById('onboarding-scan-status').style.display = 'none';
  document.getElementById('onboarding-scan-progress').style.display = 'none';
  const cancelBtn = document.getElementById('onboarding-scan-cancel');
  if (cancelBtn) cancelBtn.style.display = 'none';
  videoScanAbortController = null;
}

function mergeDetectedRoom(result) {
  const existingIdx = scannedRooms.findIndex(r => r.id === result.raum_typ);
  if (existingIdx >= 0) {
    const existing = scannedRooms[existingIdx];
    const newContainers = (result.moebel || []).map(m => ({
      name: m.name || 'Möbel',
      typ: m.typ || 'sonstiges'
    }));
    existing.containers = [...existing.containers, ...newContainers];
  } else {
    let roomId = result.raum_typ || 'sonstiges';
    if (scannedRooms.some(r => r.id === roomId) && roomId === 'sonstiges') {
      roomId = 'sonstiges_' + Date.now();
    }
    scannedRooms.push({
      id: roomId,
      name: result.raum_name || ROOM_PRESETS[roomId]?.[1] || 'Raum',
      emoji: result.raum_emoji || ROOM_PRESETS[roomId]?.[0] || '🏠',
      containers: (result.moebel || []).map(m => ({
        name: m.name || 'Möbel',
        typ: m.typ || 'sonstiges'
      }))
    });
  }
}

async function onRoomScanPhoto(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showToast('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.', 'error');
    return;
  }

  // Open staging overlay so user can collect multiple photos
  setStagingTarget({ roomId: '__roomscan__', containerId: '__roomscan__', containerName: 'Raumscan', mode: 'add', roomScanFlow: true });
  showStagingOverlay('📷 Raum erfassen');
  addFileToStaging(file);
}

// Called from analyzeAllStagedPhotos when roomScanFlow is detected
export async function analyzeRoomScanPhotos(photos) {
  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showToast('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.', 'error');
    return;
  }

  closeStagingOverlay();
  showScanSpinner('KI analysiert den Raum…');

  try {
    const photoCount = photos.length;
    const prompt = photoCount > 1 ? ROOM_DETECT_SYSTEM_PROMPT_MULTI(photoCount) : ROOM_DETECT_SYSTEM_PROMPT_SINGLE;

    const imageContents = photos.map(p => ({
      type: 'image',
      source: { type: 'base64', media_type: p.mimeType, data: p.base64 }
    }));

    const messages = [{
      role: 'user',
      content: [
        ...imageContents,
        { type: 'text', text: photoCount > 1
          ? `Du siehst ${photoCount} Fotos desselben Raums aus verschiedenen Blickwinkeln. Erkenne den Raum und alle sichtbaren Aufbewahrungsmöbel.`
          : 'Erkenne diesen Raum und die sichtbaren Aufbewahrungsmöbel.' }
      ]
    }];

    const raw = await callGemini(apiKey, prompt, messages);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Kein JSON in Antwort');

    mergeDetectedRoom(JSON.parse(jsonMatch[0]));
    showOnboardingScreen('review');

  } catch (err) {
    hideScanSpinner();
    showToast(getErrorMessage(err), 'error');
  }
}

async function onRoomScanVideo(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showToast('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.', 'error');
    return;
  }

  // Validate video type
  if (!file.type.startsWith('video/')) {
    showToast('Bitte eine Video-Datei wählen.', 'error');
    return;
  }

  // Abort controller for cancellation
  videoScanAbortController = new AbortController();
  const abortSignal = videoScanAbortController;

  const progressBar = document.getElementById('onboarding-scan-progress');
  const progressFill = document.getElementById('onboarding-scan-progress-fill');
  showScanSpinner('Video wird hochgeladen…', true);
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';

  let uploadedFile = null;

  // Reset debug log for this upload
  const dbgEl = document.getElementById('onboarding-debug-log');
  if (dbgEl) dbgEl.textContent = '';
  const dbgPanel = document.getElementById('onboarding-debug-panel');
  if (dbgPanel) dbgPanel.open = true;

  try {
    // Check if cancelled before each major step
    if (abortSignal.signal.aborted) throw new Error('aborted');

    // Upload video to Gemini File API
    uploadedFile = await uploadVideoToGemini(apiKey, file, (phase, pct) => {
      if (abortSignal.signal.aborted) return;
      progressFill.style.width = `${pct}%`;
      if (phase === 'upload') {
        document.getElementById('onboarding-scan-status-text').textContent = 'Video wird hochgeladen…';
      } else if (phase === 'processing') {
        document.getElementById('onboarding-scan-status-text').textContent = 'Video wird verarbeitet…';
      } else if (phase === 'ready') {
        document.getElementById('onboarding-scan-status-text').textContent = 'KI analysiert Räume…';
      }
    });

    if (abortSignal.signal.aborted) throw new Error('aborted');

    // Analyze with Gemini
    debugLog('Sende Video an Gemini zur Raumanalyse…');
    document.getElementById('onboarding-scan-status-text').textContent = 'KI erkennt Räume und Möbel…';
    progressFill.style.width = '100%';

    const messages = [{
      role: 'user',
      content: [
        { type: 'file', source: { type: 'uri', uri: uploadedFile.fileUri, mimeType: uploadedFile.mimeType } },
        { type: 'text', text: 'Analysiere dieses Video eines Wohnungsrundgangs. Erkenne alle sichtbaren Räume und Aufbewahrungsmöbel.' }
      ]
    }];

    const raw = await callGemini(apiKey, ROOM_DETECT_SYSTEM_PROMPT_VIDEO, messages);

    if (abortSignal.signal.aborted) throw new Error('aborted');

    debugLog(`Gemini-Antwort erhalten (${raw.length} Zeichen)`);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      debugLog(`FEHLER: Kein JSON in Antwort. Rohe Antwort: ${raw.slice(0, 500)}`);
      throw new Error('Kein JSON in Antwort');
    }

    const result = JSON.parse(jsonMatch[0]);
    const rooms = result.raeume || [];
    debugLog(`${rooms.length} Räume erkannt: ${rooms.map(r => r.name || r.id).join(', ')}`);

    if (rooms.length === 0) {
      showToast('Keine Räume im Video erkannt. Bitte erneut versuchen.', 'error');
      hideScanSpinner();
      return;
    }

    // Merge all detected rooms
    rooms.forEach(room => mergeDetectedRoom(room));

    showOnboardingScreen('review');

  } catch (err) {
    debugLog(`FEHLER: ${err.message}`);
    hideScanSpinner();
    if (err.message === 'aborted') {
      // User cancelled – already handled by cancel button
      return;
    }
    // Show fallback hint for video failures
    const isVideoError = err.message?.includes('Video') || err.message?.includes('Upload') || err.message?.includes('Status-Abfrage');
    if (isVideoError) {
      showToast('Video-Verarbeitung fehlgeschlagen. Versuche es mit einzelnen Fotos.', 'error');
    } else {
      showToast(getErrorMessage(err), 'error');
    }
  } finally {
    videoScanAbortController = null;
    // Cleanup: delete uploaded file from Gemini
    if (uploadedFile?.fileName) {
      deleteGeminiFile(apiKey, uploadedFile.fileName);
    }
  }
}

function renderScannedRoomCards() {
  const container = document.getElementById('onboarding-room-cards');
  container.innerHTML = '';

  scannedRooms.forEach((room, roomIdx) => {
    const card = document.createElement('div');
    card.className = 'onboarding-room-card';

    // Header with emoji, name, delete
    const header = document.createElement('div');
    header.className = 'onboarding-room-card-header';
    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'onboarding-room-card-emoji';
    emojiSpan.textContent = room.emoji;
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'onboarding-room-card-name';
    nameInput.value = room.name;
    nameInput.dataset.roomIdx = roomIdx;
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'onboarding-room-card-delete';
    deleteBtn.dataset.roomIdx = roomIdx;
    deleteBtn.setAttribute('aria-label', 'Raum entfernen');
    deleteBtn.textContent = '✕';
    header.appendChild(emojiSpan);
    header.appendChild(nameInput);
    header.appendChild(deleteBtn);
    card.appendChild(header);

    // Container list
    if (room.containers.length > 0) {
      const list = document.createElement('div');
      list.className = 'onboarding-room-card-containers';
      room.containers.forEach((c, cIdx) => {
        const chip = document.createElement('div');
        chip.className = 'onboarding-container-chip';
        const typeEmoji = { schrank: '🗄️', regal: '📚', schublade: '🗃️', kiste: '📦', tisch: '🪑', kommode: '🪟', sonstiges: '📁' };
        const chipLabel = document.createElement('span');
        chipLabel.textContent = `${typeEmoji[c.typ] || '📁'} ${c.name}`;
        const chipDelete = document.createElement('button');
        chipDelete.className = 'onboarding-container-chip-delete';
        chipDelete.dataset.roomIdx = roomIdx;
        chipDelete.dataset.cIdx = cIdx;
        chipDelete.setAttribute('aria-label', 'Entfernen');
        chipDelete.textContent = '✕';
        chip.appendChild(chipLabel);
        chip.appendChild(chipDelete);
        list.appendChild(chip);
      });
      card.appendChild(list);
    } else {
      const empty = document.createElement('p');
      empty.className = 'onboarding-room-card-empty';
      empty.textContent = 'Keine Möbel erkannt';
      card.appendChild(empty);
    }

    container.appendChild(card);
  });

  // Event: delete room
  container.querySelectorAll('.onboarding-room-card-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      scannedRooms.splice(parseInt(btn.dataset.roomIdx), 1);
      renderScannedRoomCards();
    });
  });

  // Event: edit room name
  container.querySelectorAll('.onboarding-room-card-name').forEach(input => {
    input.addEventListener('change', () => {
      scannedRooms[parseInt(input.dataset.roomIdx)].name = input.value.trim() || 'Raum';
    });
  });

  // Event: delete container
  container.querySelectorAll('.onboarding-container-chip-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const rIdx = parseInt(btn.dataset.roomIdx);
      const cIdx = parseInt(btn.dataset.cIdx);
      scannedRooms[rIdx].containers.splice(cIdx, 1);
      renderScannedRoomCards();
    });
  });

  // Update confirm button text
  const total = scannedRooms.reduce((sum, r) => sum + r.containers.length, 0);
  const confirmBtn = document.getElementById('onboarding-confirm-all');
  confirmBtn.textContent = `${scannedRooms.length} ${scannedRooms.length === 1 ? 'Raum' : 'Räume'} & ${total} Möbel übernehmen`;
  confirmBtn.disabled = scannedRooms.length === 0;
}

function confirmAllScannedRooms() {
  let roomCount = 0;
  let containerCount = 0;

  scannedRooms.forEach(room => {
    // Create room
    const preset = ROOM_PRESETS[room.id];
    Brain.addRoom(room.id, room.name, room.emoji || (preset ? preset[0] : '🏠'));
    roomCount++;

    // Create first-level containers
    room.containers.forEach((c, i) => {
      const cId = room.id + '_' + (c.name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20) || 'moebel') + '_' + i;
      Brain.addContainer(room.id, cId, c.name, c.typ || 'sonstiges', [], false);
      containerCount++;
    });
  });

  // Update done description
  document.getElementById('onboarding-done-desc').textContent =
    `${roomCount} ${roomCount === 1 ? 'Raum' : 'Räume'} und ${containerCount} Möbel wurden angelegt. Frag mich einfach, z.B. „Was liegt im Schrank?"`;

  showOnboardingScreen('done');
}

export function showOnboardingDoneStep() {
  showOnboardingScreen('done');
}

export function finishOnboarding() {
  localStorage.setItem('onboarding_completed', 'true');
  scannedRooms = [];
  document.getElementById('view-onboarding').style.display = 'none';
  document.getElementById('view-onboarding').classList.remove('active');
  document.getElementById('nav').style.display = 'flex';
  showView('brain');
}

// Re-trigger room scan from settings (or brain view)
export function startRoomScan() {
  scannedRooms = [];
  document.getElementById('nav').style.display = 'none';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const onb = document.getElementById('view-onboarding');
  onb.style.display = 'flex';
  onb.classList.add('active');
  showOnboardingScreen('scan');
}

export { scannedRooms };
