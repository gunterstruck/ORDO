import Brain from './brain.js';
import { callGemini, getErrorMessage, deleteGeminiFile, uploadVideoToGemini, extractJSON } from './ai.js';
import { showToast } from './modal.js';
import { debugLog, showView, ROOM_PRESETS } from './app.js';
import { resizeImage, blobToBase64, showStagingOverlay, addFileToStaging, showReviewPopup, setStagingTarget, closeStagingOverlay } from './photo-flow.js';
import { capturePhoto, captureVideo } from './camera.js';
import { startBlueprint } from './quest.js';

let scannedRooms = [];
let videoScanAbortController = null;

export function setupOnboarding() {
  document.getElementById('onboarding-start').addEventListener('click', () => {
    // Skip API-key step if key already exists
    if (Brain.getApiKey()) {
      showOnboardingScreen('first-photo');
    } else {
      showOnboardingScreen('apikey');
    }
  });
  document.getElementById('onboarding-skip').addEventListener('click', finishOnboarding);

  // API-Key step
  setupApiKeyStep();

  // Simplified step 3: First photo
  setupFirstPhotoStep();

  // Legacy scan buttons (for re-trigger from settings)
  document.getElementById('onboarding-scan-photo-btn')?.addEventListener('click', async () => {
    const file = await capturePhoto();
    if (file) onRoomScanPhoto(file);
  });
  document.getElementById('onboarding-scan-video-btn')?.addEventListener('click', async () => {
    const file = await captureVideo(300);
    if (file) onRoomScanVideo(file);
  });
  document.getElementById('onboarding-add-more')?.addEventListener('click', () => showOnboardingScreen('scan'));
  document.getElementById('onboarding-confirm-all')?.addEventListener('click', confirmAllScannedRooms);
  document.getElementById('onboarding-finish')?.addEventListener('click', finishOnboarding);
  document.getElementById('onboarding-done-finish')?.addEventListener('click', finishOnboarding);
  document.getElementById('onboarding-start-blueprint')?.addEventListener('click', () => startBlueprint());
  document.getElementById('onboarding-start-single')?.addEventListener('click', () => showOnboardingScreen('scan'));
  document.getElementById('onboarding-photo-skip')?.addEventListener('click', finishOnboarding);

  // Settings re-trigger
  document.getElementById('settings-room-scan')?.addEventListener('click', startBlueprint);
}

function setupFirstPhotoStep() {
  const photoBtn = document.getElementById('onboarding-photo-btn');
  if (!photoBtn) return;

  photoBtn.addEventListener('click', async () => {
    const file = await capturePhoto();
    if (!file) return;

    const apiKey = Brain.getApiKey();
    if (!apiKey) {
      showToast('API Key nicht gesetzt.', 'error');
      return;
    }

    // Show spinner
    const statusEl = document.getElementById('onboarding-scan-status');
    if (statusEl) statusEl.style.display = 'flex';
    document.getElementById('onboarding-scan-status-text').textContent = 'KI analysiert den Raum…';

    try {
      const resizedBlob = await resizeImage(file, 1200, { quality: 0.7 });
      const base64 = await blobToBase64(resizedBlob);
      const mimeType = resizedBlob.type || 'image/jpeg';

      const existingBlock = buildExistingContainersBlockForAllKnownRooms();
      const prompt = ROOM_DETECT_SYSTEM_PROMPT_SINGLE(existingBlock);

      const messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: 'Erkenne diesen Raum und die sichtbaren Aufbewahrungsmöbel.' }
        ]
      }];

      const raw = await callGemini(apiKey, prompt, messages, { taskType: 'analyzePhoto', hasImage: true });
      const responseText = typeof raw === 'string' ? raw : raw.text || JSON.stringify(raw);
      const result = extractJSON(responseText);
      if (!result) throw new Error('Kein JSON in Antwort');
      mergeDetectedRoom(result);

      // Save rooms immediately
      confirmAllScannedRooms();

      // Show result
      if (statusEl) statusEl.style.display = 'none';
      const resultEl = document.getElementById('onboarding-photo-result');
      const resultText = document.getElementById('onboarding-photo-result-text');
      if (resultEl && resultText) {
        const containerCount = result.moebel?.length || 0;
        resultText.textContent = `${result.raum_emoji || '🏠'} ${result.raum_name || 'Raum'} mit ${containerCount} Möbelstück${containerCount !== 1 ? 'en' : ''} erkannt!`;
        resultEl.style.display = 'block';
      }

      // Show finish button
      const finishBtn = document.getElementById('onboarding-finish');
      if (finishBtn) finishBtn.style.display = 'block';

    } catch (err) {
      if (statusEl) statusEl.style.display = 'none';
      showToast(getErrorMessage(err), 'error');
    }
  });
}

function setupApiKeyStep() {
  const input = document.getElementById('onboarding-apikey-input');
  const testBtn = document.getElementById('onboarding-apikey-test');
  const nextBtn = document.getElementById('onboarding-apikey-next');
  const skipBtn = document.getElementById('onboarding-apikey-skip');
  const statusEl = document.getElementById('onboarding-apikey-status');

  input.addEventListener('input', () => {
    const hasValue = input.value.trim().length > 0;
    testBtn.disabled = !hasValue;
    nextBtn.disabled = !hasValue;
    statusEl.style.display = 'none';
  });

  testBtn.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) return;

    testBtn.disabled = true;
    testBtn.textContent = 'Teste…';
    statusEl.style.display = 'block';
    statusEl.className = 'onboarding-apikey-status onboarding-apikey-status--pending';
    statusEl.textContent = 'Verbindung wird geprüft…';

    try {
      await callGemini(key, 'Antworte mit genau einem Wort: OK', [{ role: 'user', content: 'Test' }], { taskType: 'test' });
      statusEl.className = 'onboarding-apikey-status onboarding-apikey-status--ok';
      statusEl.textContent = 'Verbindung OK ✓';
      Brain.setApiKey(key);
      nextBtn.disabled = false;
    } catch (err) {
      statusEl.className = 'onboarding-apikey-status onboarding-apikey-status--error';
      statusEl.textContent = 'Schlüssel ungültig oder Fehler: ' + getErrorMessage(err);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Testen';
    }
  });

  nextBtn.addEventListener('click', () => {
    const key = input.value.trim();
    if (key) {
      Brain.setApiKey(key);
    }
    showOnboardingScreen('first-photo');
  });

  skipBtn.addEventListener('click', () => {
    showToast('Ohne Schlüssel kann die App keine Fotos analysieren. Du kannst ihn später in den Einstellungen eintragen.', 'warning');
    showOnboardingScreen('first-photo');
  });
}

export function showOnboarding() {
  scannedRooms = [];
  const nav = document.getElementById('nav');
  if (nav) nav.style.display = 'none';
  // Hide all views (including chat which has active class in HTML by default)
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('active');
    v.style.display = 'none';
  });
  const onb = document.getElementById('view-onboarding');
  if (onb) {
    onb.style.display = 'flex';
    onb.classList.add('active');
  }
  showOnboardingScreen('welcome');
}

export function showOnboardingScreen(screen) {
  const screens = ['onboarding-welcome', 'onboarding-step-apikey', 'onboarding-step-first-photo', 'onboarding-step-start-choice', 'onboarding-step-scan', 'onboarding-step-review', 'onboarding-step-done'];
  screens.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const map = {
    welcome: 'onboarding-welcome',
    apikey: 'onboarding-step-apikey',
    'first-photo': 'onboarding-step-first-photo',
    'start-choice': 'onboarding-step-start-choice',
    scan: 'onboarding-step-scan',
    review: 'onboarding-step-review',
    done: 'onboarding-step-done'
  };
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

// Build a prompt block listing existing containers for a room so the AI reuses names
function buildExistingContainersBlock(roomId) {
  // Check Brain for already-saved containers
  const room = Brain.getRoom(roomId);
  let containers = [];
  if (room) {
    const flat = Brain.getAllContainersFlat(roomId);
    containers = flat.map(c => ({ name: c.name, typ: '' }));
  }
  // Also check scannedRooms (onboarding flow, not yet saved)
  const scanned = scannedRooms.find(r => r.id === roomId);
  if (scanned && scanned.containers) {
    for (const sc of scanned.containers) {
      // Avoid duplicates between Brain and scannedRooms
      if (!containers.some(c => c.name === sc.name)) {
        containers.push({ name: sc.name, typ: sc.typ || '' });
      }
    }
  }
  if (containers.length === 0) return '';
  const list = containers.map(c => `- ${c.name}${c.typ ? ' (' + c.typ + ')' : ''}`).join('\n');
  return `\n\nIn diesem Raum existieren bereits folgende Möbelstücke:\n${list}\n\nWenn du eines dieser Möbelstücke auf dem Foto wiedererkennst, verwende EXAKT den bestehenden Namen. Lege nur neue Container an für Möbel die wirklich NOCH NICHT in der obigen Liste stehen. Wenn du ein Möbelstück siehst das der bestehenden Liste ähnelt, verwende den EXAKTEN bestehenden Namen – NICHT eine Variante davon.`;
}

// Build a combined existing-containers block for all known rooms (Brain + scannedRooms)
function buildExistingContainersBlockForAllKnownRooms() {
  const roomIds = new Set();
  // Collect from scannedRooms
  for (const r of scannedRooms) roomIds.add(r.id);
  // Collect from Brain
  const brainRooms = Brain.getRooms();
  for (const id of Object.keys(brainRooms)) roomIds.add(id);

  const blocks = [];
  for (const id of roomIds) {
    const block = buildExistingContainersBlock(id);
    if (block) blocks.push(block);
  }
  return blocks.length > 0 ? blocks.join('\n') : '';
}

// Shared prompt for room detection (photo + video)
const ROOM_DETECT_SYSTEM_PROMPT_SINGLE = (existingBlock = '') => `Du bist ein Raumerkennungs-Assistent. Analysiere dieses Foto und erkenne:
1. Um welchen Raum es sich handelt (z.B. Küche, Wohnzimmer, Schlafzimmer, Bad, Arbeitszimmer, Keller, Flur, Kinderzimmer, Garage, Balkon, Dachboden, Gästezimmer)
2. Welche Aufbewahrungsmöbel sichtbar sind (Schränke, Regale, Schubladen, Kommoden, Tische, Kisten etc.)
${existingBlock}
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

const ROOM_DETECT_SYSTEM_PROMPT_MULTI = (n, existingBlock = '') => `Du bist ein Raumerkennungs-Assistent. Du siehst ${n} Fotos desselben Raums aus verschiedenen Blickwinkeln.
Identifiziere jedes Möbelstück nur EINMAL, auch wenn es in mehreren Fotos sichtbar ist.
${existingBlock}
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

const ROOM_DETECT_SYSTEM_PROMPT_VIDEO = (existingBlock = '') => `Du bist ein Raumerkennungs-Assistent. Analysiere dieses Video eines Wohnungsrundgangs.
Erkenne ALLE verschiedenen Räume, die im Video zu sehen sind, und die sichtbaren Aufbewahrungsmöbel in jedem Raum.
${existingBlock}
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
- Bei Fluren/Durchgängen nur auflisten wenn dort Möbel stehen
- Wenn bereits Möbelstücke bekannt sind, verwende EXAKT deren bestehende Namen – NICHT eine Variante davon`;

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

// Check if a new container name is a fuzzy duplicate of any existing container
function isContainerDuplicate(newName, existingContainers) {
  for (const existing of existingContainers) {
    if (Brain.isFuzzyMatch(existing.name, newName)) return existing;
  }
  return null;
}

// Also check against saved Brain containers for a room
function isContainerDuplicateInBrain(newName, roomId) {
  const flat = Brain.getAllContainersFlat(roomId);
  for (const c of flat) {
    if (Brain.isFuzzyMatch(c.name, newName)) return c;
  }
  return null;
}

function mergeDetectedRoom(result) {
  const existingIdx = scannedRooms.findIndex(r => r.id === result.raum_typ);
  if (existingIdx >= 0) {
    const existing = scannedRooms[existingIdx];
    const newContainers = (result.moebel || []).map(m => ({
      name: m.name || 'Möbel',
      typ: m.typ || 'sonstiges'
    }));
    // Deduplicate: only add containers that don't fuzzy-match existing ones
    for (const nc of newContainers) {
      const dupInScanned = isContainerDuplicate(nc.name, existing.containers);
      const dupInBrain = isContainerDuplicateInBrain(nc.name, existing.id);
      if (!dupInScanned && !dupInBrain) {
        existing.containers.push(nc);
      }
    }
  } else {
    let roomId = result.raum_typ || 'sonstiges';
    if (scannedRooms.some(r => r.id === roomId) && roomId === 'sonstiges') {
      roomId = 'sonstiges_' + Date.now();
    }
    // Filter out containers that already exist in Brain for this room
    const newContainers = (result.moebel || [])
      .map(m => ({ name: m.name || 'Möbel', typ: m.typ || 'sonstiges' }))
      .filter(c => !isContainerDuplicateInBrain(c.name, roomId));
    scannedRooms.push({
      id: roomId,
      name: result.raum_name || ROOM_PRESETS[roomId]?.[1] || 'Raum',
      emoji: result.raum_emoji || ROOM_PRESETS[roomId]?.[0] || '🏠',
      containers: newContainers
    });
  }
}

async function onRoomScanPhoto(file) {
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
    // Build existing containers block from scannedRooms + Brain for context
    const existingBlock = buildExistingContainersBlockForAllKnownRooms();
    const prompt = photoCount > 1 ? ROOM_DETECT_SYSTEM_PROMPT_MULTI(photoCount, existingBlock) : ROOM_DETECT_SYSTEM_PROMPT_SINGLE(existingBlock);

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

    const raw = await callGemini(apiKey, prompt, messages, { taskType: 'analyzePhoto', hasImage: true });
    const responseText = typeof raw === 'string' ? raw : raw.text || JSON.stringify(raw);
    const parsed = extractJSON(responseText);
    if (!parsed) throw new Error('Kein JSON in Antwort');
    mergeDetectedRoom(parsed);
    showOnboardingScreen('review');

  } catch (err) {
    hideScanSpinner();
    showToast(getErrorMessage(err), 'error');
  }
}

async function onRoomScanVideo(file) {
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

    // Build existing containers block from all known rooms
    const videoExistingBlock = buildExistingContainersBlockForAllKnownRooms();
    const raw = await callGemini(apiKey, ROOM_DETECT_SYSTEM_PROMPT_VIDEO(videoExistingBlock), messages, { taskType: 'videoAnalysis', hasVideo: true });

    if (abortSignal.signal.aborted) throw new Error('aborted');

    const responseText = typeof raw === 'string' ? raw : raw.text || JSON.stringify(raw);
    debugLog(`Gemini-Antwort erhalten (${responseText.length} Zeichen)`);
    const result = extractJSON(responseText);
    if (!result) {
      debugLog(`FEHLER: Kein JSON in Antwort. Rohe Antwort: ${String(raw).slice(0, 500)}`);
      throw new Error('Kein JSON in Antwort');
    }
    const rooms = result.raeume || [];
    debugLog(`${rooms.length} Räume erkannt: ${rooms.map(r => r.raum_name || r.raum_typ).join(', ')}`);

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
    // Always show fallback hint to use single photos instead
    const baseMsg = getErrorMessage(err);
    const isVideoError = err.message?.includes('Video') || err.message?.includes('Upload') || err.message?.includes('Status-Abfrage') || err.message?.includes('Timeout');
    const fallbackHint = '\n💡 Tipp: Verwende stattdessen die Foto-Funktion – mehrere Fotos liefern oft bessere Ergebnisse als ein Video.';
    showToast(isVideoError
      ? 'Video-Verarbeitung fehlgeschlagen.' + fallbackHint
      : baseMsg + fallbackHint, 'error');
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

    // Create first-level containers (skip duplicates already saved in Brain)
    room.containers.forEach((c, i) => {
      // Check if a similar container already exists in Brain for this room
      if (isContainerDuplicateInBrain(c.name, room.id)) return;

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
  localStorage.setItem('ordo_onboarding_completed', 'true');
  scannedRooms = [];
  const onb = document.getElementById('view-onboarding');
  if (onb) {
    onb.style.display = 'none';
    onb.classList.remove('active');
  }
  // Reset inline display on all views so CSS classes take over again
  document.querySelectorAll('.view').forEach(v => { v.style.display = ''; });
  // Re-hide onboarding after clearing inline styles
  if (onb) onb.style.display = 'none';
  const nav = document.getElementById('nav');
  if (nav) nav.style.display = 'flex';
  showView('brain');
}

// Re-trigger room scan from settings (or brain view)
export function startRoomScan() {
  scannedRooms = [];
  const nav = document.getElementById('nav');
  if (nav) nav.style.display = 'none';
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('active');
    v.style.display = 'none';
  });
  const onb = document.getElementById('view-onboarding');
  if (onb) {
    onb.style.display = 'flex';
    onb.classList.add('active');
  }
  showOnboardingScreen('scan');
}

export { scannedRooms };
