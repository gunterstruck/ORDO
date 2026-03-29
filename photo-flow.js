// photo-flow.js – Foto-Aufnahme, Staging, Picking, Review

import Brain from './brain.js';
import { callGemini, getErrorMessage, loadingManager } from './ai.js';
import { showToast, showInputModal } from './modal.js';
import { ROOM_PRESETS, ensureRoom, debugLog, showView, getNfcContext, getCurrentView } from './app.js';
import { renderBrainView, showBrainToast } from './brain-view.js';
import { showOnboardingDoneStep, analyzeRoomScanPhotos } from './onboarding.js';
import { appendMessage } from './chat.js';
import { capturePhoto, captureVideo } from './camera.js';
import { uploadVideoToGemini, deleteGeminiFile, FILE_API_URL, FILE_API_GET_URL, MAX_VIDEO_SIZE_MB } from './ai.js';

// ── State ──────────────────────────────────────────────
let pickingState = null;
let pickingRecognition = null;
let pickingIsRecording = false;
let stagedPhotos = [];
let stagingTarget = null;
let reviewState = null;

// ── Image Helpers ──────────────────────────────────────
function resizeImage(file, maxWidth = 1200, { quality = 0.7, returnFormat = 'blob' } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxWidth || height > maxWidth) {
        const ratio = Math.min(maxWidth / width, maxWidth / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error('Resize failed')); return; }
        if (returnFormat === 'base64') {
          const reader = new FileReader();
          reader.onload = e => resolve({ base64: e.target.result.split(',')[1], mimeType: 'image/jpeg' });
          reader.readAsDataURL(blob);
        } else {
          resolve(blob);
        }
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Ladefehler')); };
    img.src = url;
  });
}

// Convenience wrapper for chat image resizing
function resizeImageForChat(file) {
  return resizeImage(file, 1024, { quality: 0.85, returnFormat: 'base64' });
}

// Convert Blob to base64 string (without data URL prefix)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Photo View ───────────────────────────────────────
function setupPhoto() {
  document.getElementById('photo-camera-btn').addEventListener('click', async () => {
    const roomId = document.getElementById('photo-room-select').value;
    if (!roomId) { showPhotoStatus('Bitte zuerst einen Raum wählen.', 'error'); return; }
    const customName = document.getElementById('photo-custom-name').value.trim();
    const containerId = customName ? Brain.slugify(customName) : 'inhalt';
    stagingTarget = { roomId, containerId, containerName: customName, mode: 'add' };
    const file = await capturePhoto();
    if (file) {
      if (!document.getElementById('staging-overlay').style.display || document.getElementById('staging-overlay').style.display === 'none') {
        const title = stagingTarget?.containerName ? `📷 ${stagingTarget.containerName}` : '📷 Fotos sammeln';
        showStagingOverlay(title);
      }
      addFileToStaging(file);
    } else {
      if (stagedPhotos.length === 0) { stagingTarget = null; }
    }
  });
  document.getElementById('photo-gallery-btn').addEventListener('click', () => {
    const roomId = document.getElementById('photo-room-select').value;
    if (!roomId) { showPhotoStatus('Bitte zuerst einen Raum wählen.', 'error'); return; }
    const customName = document.getElementById('photo-custom-name').value.trim();
    const containerId = customName ? Brain.slugify(customName) : 'inhalt';
    stagingTarget = { roomId, containerId, containerName: customName, mode: 'add' };
    document.getElementById('photo-input-gallery').click();
  });
  // Gallery file input feeds into the staging area
  document.getElementById('photo-input-gallery').addEventListener('change', e => {
    if (e.target.files[0]) {
      if (!document.getElementById('staging-overlay').style.display || document.getElementById('staging-overlay').style.display === 'none') {
        const title = stagingTarget?.containerName ? `📷 ${stagingTarget.containerName}` : '📷 Fotos sammeln';
        showStagingOverlay(title);
      }
      addFileToStaging(e.target.files[0]);
    } else {
      if (stagedPhotos.length === 0) { closeStagingOverlay(); stagingTarget = null; }
    }
    e.target.value = '';
  });

  // ── Video buttons ──────────────────────────────────
  document.getElementById('photo-video-btn').addEventListener('click', async () => {
    const roomId = document.getElementById('photo-room-select').value;
    if (!roomId) { showPhotoStatus('Bitte zuerst einen Raum wählen.', 'error'); return; }
    const file = await captureVideo(300); // max 5 min
    if (file) handleVideoFile(file);
  });

  document.getElementById('photo-video-upload-btn').addEventListener('click', () => {
    const roomId = document.getElementById('photo-room-select').value;
    if (!roomId) { showPhotoStatus('Bitte zuerst einen Raum wählen.', 'error'); return; }
    document.getElementById('photo-input-video').click();
  });

  document.getElementById('photo-input-video').addEventListener('change', e => {
    if (e.target.files[0]) handleVideoFile(e.target.files[0]);
    e.target.value = '';
  });

  // ── Ort: Mic dictation ──────────────────────────────
  const customMicBtn = document.getElementById('photo-custom-mic');
  let customMicRec = null;
  customMicBtn?.addEventListener('click', () => {
    if (customMicRec) {
      customMicRec.stop();
      customMicRec = null;
      customMicBtn.classList.remove('recording');
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { showToast('Spracherkennung nicht verfügbar.', 'error'); return; }
    customMicRec = new SpeechRecognition();
    customMicRec.lang = 'de-DE';
    customMicRec.continuous = false;
    customMicRec.interimResults = false;
    customMicRec.onresult = e => {
      document.getElementById('photo-custom-name').value = e.results[0][0].transcript;
    };
    customMicRec.onend = () => { customMicRec = null; customMicBtn.classList.remove('recording'); };
    customMicRec.onerror = () => { customMicRec = null; customMicBtn.classList.remove('recording'); };
    customMicRec.start();
    customMicBtn.classList.add('recording');
  });

  // ── Ort: Chat toggle + send ─────────────────────────
  const chatToggle = document.getElementById('photo-custom-chat');
  const chatArea = document.getElementById('photo-custom-chat-area');
  chatToggle?.addEventListener('click', () => {
    const visible = chatArea.style.display !== 'none';
    chatArea.style.display = visible ? 'none' : 'block';
    if (!visible) document.getElementById('photo-custom-chat-input')?.focus();
  });

  const chatSendBtn = document.getElementById('photo-custom-chat-send');
  const chatInput = document.getElementById('photo-custom-chat-input');
  const chatLog = document.getElementById('photo-custom-chat-log');
  let ortChatHistory = [];

  async function sendOrtChat() {
    const text = chatInput?.value?.trim();
    if (!text) return;
    chatInput.value = '';
    chatSendBtn.disabled = true;
    chatSendBtn.textContent = '...';

    const userBubble = document.createElement('div');
    userBubble.style.cssText = 'padding:4px 8px;border-radius:8px;background:#f0f0f0;margin-bottom:4px;font-size:13px';
    userBubble.textContent = text;
    chatLog.appendChild(userBubble);
    chatLog.scrollTop = chatLog.scrollHeight;

    ortChatHistory.push({ role: 'user', content: text });

    try {
      const apiKey = Brain.getApiKey();
      if (!apiKey) throw new Error('Kein API-Key');
      const roomId = document.getElementById('photo-room-select').value;
      const roomName = roomId ? (Brain.getRoom(roomId)?.name || roomId) : '';
      const systemPrompt = `Du bist ein Assistent der hilft, Orte in der Wohnung zu benennen.
Der Nutzer beschreibt wo etwas steht oder liegt.${roomName ? ` Aktueller Raum: ${roomName}.` : ''}
Erkenne den Ort und gib einen kurzen, klaren Namen.
Antworte kurz und freundlich.
Antworte mit diesem JSON am Ende deiner Nachricht:
{"ort_name": "Erkannter Ort"}`;

      const raw = await callGemini(apiKey, systemPrompt, ortChatHistory, { taskType: 'chat' });
      const responseText = typeof raw === 'string' ? raw : (raw.text || '');
      ortChatHistory.push({ role: 'assistant', content: responseText });

      const jsonMatch = responseText.match(/\{\s*"ort_name"\s*:\s*"([^"]+)"\s*\}/);
      const displayText = responseText.replace(/\{[\s\S]*?\}/g, '').trim();

      const botBubble = document.createElement('div');
      botBubble.style.cssText = 'padding:4px 8px;border-radius:8px;background:#fff3e6;margin-bottom:4px;font-size:13px';
      botBubble.textContent = displayText || responseText;
      chatLog.appendChild(botBubble);

      if (jsonMatch?.[1]) {
        const ortName = jsonMatch[1];
        document.getElementById('photo-custom-name').value = ortName;
        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'onboarding-btn-primary';
        acceptBtn.style.cssText = 'padding:4px 12px;font-size:13px;margin:4px 0 0;width:100%';
        acceptBtn.textContent = `✓ "${ortName}" übernehmen`;
        acceptBtn.addEventListener('click', () => { chatArea.style.display = 'none'; });
        chatLog.appendChild(acceptBtn);
      }
      chatLog.scrollTop = chatLog.scrollHeight;
    } catch (err) {
      debugLog(`Ort-Chat Fehler: ${err.message}`);
      const errBubble = document.createElement('div');
      errBubble.style.cssText = 'padding:4px 8px;color:#c0392b;font-size:12px';
      errBubble.textContent = 'Fehler – versuch es nochmal oder tippe direkt.';
      chatLog.appendChild(errBubble);
    } finally {
      chatSendBtn.disabled = false;
      chatSendBtn.textContent = 'Fragen';
    }
  }

  chatSendBtn?.addEventListener('click', sendOrtChat);
  chatInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendOrtChat(); }
  });
}

function renderRoomDropdown(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const rooms = Brain.getRooms();
  select.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Raum wählen…';
  select.appendChild(defaultOpt);

  const roomList = Object.entries(rooms);
  roomList.forEach(([id, room]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${room.emoji} ${room.name}`;
    select.appendChild(opt);
  });

  // Add predefined rooms if not present
  Object.entries(ROOM_PRESETS).forEach(([id, [emoji, name]]) => {
    if (!rooms[id] && !document.querySelector(`#${selectId} option[value="${id}"]`)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${emoji} ${name}`;
      select.appendChild(opt);
    }
  });
}

function applyNfcContextToPhotoView() {
  const hint = document.getElementById('photo-nfc-hint');
  if (!getNfcContext()) {
    if (hint) hint.style.display = 'none';
    return;
  }

  const room = Brain.getRoom(getNfcContext().room);
  const container = getNfcContext().tag ? Brain.getContainer(getNfcContext().room, getNfcContext().tag) : null;
  const roomName = room?.name || getNfcContext().room;
  const containerName = container?.name || getNfcContext()?.tag || '';

  const select = document.getElementById('photo-room-select');
  if (select && getNfcContext()?.room) select.value = getNfcContext().room;

  const customName = document.getElementById('photo-custom-name');
  if (customName && containerName) customName.value = containerName;

  if (hint) {
    hint.textContent = `📍 Foto wird "${containerName || roomName}" zugeordnet`;
    hint.style.display = 'block';
  }
}

async function handlePhotoFile(file, targetRoomId = null, targetContainerId = null) {
  if (!file) return;

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showPhotoStatus('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.', 'error');
    return;
  }

  if (file.size > 4 * 1024 * 1024) {
    showPhotoStatus('Foto zu groß – bitte ein kleineres wählen oder Auflösung reduzieren.', 'error');
    return;
  }

  const roomId = targetRoomId || document.getElementById('photo-room-select').value;
  if (!roomId) {
    showPhotoStatus('Bitte zuerst einen Raum wählen.', 'error');
    return;
  }

  // Offline: queue photo for later analysis
  if (!navigator.onLine) {
    const containerId = targetContainerId || (document.getElementById('photo-custom-name').value.trim() ? Brain.slugify(document.getElementById('photo-custom-name').value.trim()) : 'inhalt');
    const blob = file instanceof Blob ? file : new Blob([file], { type: 'image/jpeg' });
    await queuePhotoForAnalysis(blob, roomId, containerId);
    const count = getQueueLength();
    showPhotoStatus(`📷 Foto gespeichert. Die Analyse wird nachgeholt sobald du wieder Internet hast. (${count} Foto${count > 1 ? 's' : ''} in der Warteschlange)`, 'success');
    return;
  }

  const customName = targetContainerId
    ? (Brain.getContainer(roomId, targetContainerId)?.name || '')
    : document.getElementById('photo-custom-name').value.trim();

  // Show preview
  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result.split(',')[1];
    const mimeType = file.type || 'image/jpeg';

    // Show preview image (only in photo view context)
    if (!targetRoomId) {
      const preview = document.getElementById('photo-preview');
      preview.src = e.target.result;
      preview.style.display = 'block';
    }

    startAnalysisAnimation();

    try {
      // Ensure room exists
      ensureRoom(roomId);

      // Build container context for dedup (Mechanism C)
      let containerContextBlock = '';
      if (targetContainerId) {
        const existingItems = Brain.getContainerItemNames(roomId, targetContainerId);
        if (existingItems.length > 0) {
          containerContextBlock = `\nDieser Behälter enthält bereits folgende Gegenstände: ${existingItems.join(', ')}. Wenn du einen dieser Gegenstände wiedererkennst, liste ihn NICHT erneut auf. Liste NUR neue Gegenstände, die noch nicht in der Liste stehen.`;
        }
      }

      // Build infrastructure ignore list for this container
      let infrastructureBlock = '';
      if (targetContainerId) {
        const ignoreNames = Brain.getInfrastructureIgnoreList(roomId, targetContainerId);
        const globalIgnore = Brain.getGlobalInfrastructure();
        const allIgnore = [...new Set([...ignoreNames, ...globalIgnore])];
        if (allIgnore.length > 0) {
          infrastructureBlock = `\nFolgende Dinge wurden vom Nutzer als fest installiert markiert. Erkenne sie NICHT als Gegenstände: ${allIgnore.join(', ')}.`;
        }
      }

      const systemPrompt = `GRUNDREGEL – Was ist ein Gegenstand?
Inventarisiere ausschließlich lose Gegenstände, also Dinge, die ein Mensch ohne Werkzeug aufheben und woanders hinlegen kann. Stell dir die Umzugskarton-Faustregel vor: Wenn du es beim Umzug nicht in eine Kiste packen würdest, ist es kein Gegenstand – dann ignoriere es.

Möbelstücke erkennst du als Behälter (Schrank, Regal, Kommode usw.), aber ihre fest verbauten Bestandteile sind keine eigenständigen Gegenstände. Griffe, Scharniere, Führungsschienen und Beschläge gehören zum Möbel selbst und werden nicht aufgelistet. Prüfe bei Zweifeln: Besteht das Objekt aus demselben Material wie das Möbelstück und ist nahtlos damit verbunden? Dann ist es ein Teil davon, kein eigener Gegenstand.

Ignoriere grundsätzlich fest installierte Infrastruktur, zum Beispiel: Griffe und Knäufe, Türscharniere, Schubladenführungen, Steckdosen und Lichtschalter, Regalhalterungen und Dübel, fest montierte Kleiderstangen, Heizkörper und Thermostate, Rauchmelder, Fensterbeschläge und Türzargen, Fußleisten, fest eingebaute Deckenleuchten und Wandlampen, Wasserhähne, Spülbecken, Einbaugeräte, Regalboden-Halterungen und Soft-Close-Dämpfer. Das sind nur Beispiele – generell gilt: Alles was verschraubt, verklebt, eingebaut oder fest montiert ist, wird ignoriert.${infrastructureBlock}

Analysiere dieses Foto eines Raums oder Möbelstücks.
Wenn du ein Möbelstück mit erkennbaren Unterteilungen siehst (Türen, Schubladen, Fächer, Regalböden), bilde die Hierarchie im JSON ab.
Ein Behälter kann Unterbehälter haben. Nutze das Feld "behaelter" rekursiv.${containerContextBlock}
Antworte NUR mit diesem JSON, nichts anderes:
{
  "behaelter": [
    {
      "id": "eindeutige_id",
      "name": "menschlicher Name",
      "typ": "schrank|regal|schublade|kiste|tuer|sonstiges",
      "position": "kurze Positionsbeschreibung",
      "inhalt_sicher": ["Gegenstand der klar in diesem Behälter liegt"],
      "inhalt_unsicher": [
        {
          "name": "Gegenstand",
          "vermutung": "liegt vermutlich in diesem Behälter, aber nicht 100% sicher"
        }
      ],
      "behaelter": [
        {
          "id": "unterbeh_id",
          "name": "Name des Unterbehälters",
          "typ": "schublade|fach|tuer|kiste|sonstiges",
          "inhalt_sicher": ["..."],
          "behaelter": []
        }
      ]
    }
  ],
  "lose_gegenstaende": ["Gegenstand klar außerhalb aller Behälter"],
  "unklar": [
    {
      "name": "Gegenstand",
      "kontext": "Kurze Beschreibung warum unklar"
    }
  ],
  "raumhinweis": "kurze Raumcharakteristik"
}
Regeln:
- Nur verschachteln wenn du die Zugehörigkeit klar erkennen kannst
- Im Zweifel flach lassen
- Maximal 3 Ebenen tief
- Jeder Behälter braucht eine eindeutige ID`;

      const messages = [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64 }
          },
          {
            type: 'text',
            text: customName ? `Foto aus: ${customName}` : 'Analysiere dieses Foto.'
          }
        ]
      }];

      const raw = await callGemini(apiKey, systemPrompt, messages, { taskType: 'analyzePhoto', hasImage: true });

      // Extract JSON from response
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Kein JSON in Antwort');

      const analysis = JSON.parse(jsonMatch[0]);

      // If targeting a specific container, force its name/id
      if (targetContainerId && analysis.behaelter?.length > 0) {
        const c = Brain.getContainer(roomId, targetContainerId);
        if (c) {
          analysis.behaelter[0].name = c.name;
          analysis.behaelter[0].id = targetContainerId;
        }
      } else if (customName && analysis.behaelter?.length > 0) {
        analysis.behaelter[0].name = customName;
        analysis.behaelter[0].id = Brain.slugify(customName);
      }

      const count = Brain.applyPhotoAnalysis(roomId, analysis);

      // Determine primary container ID for photo saving and picking view
      let primaryContainerId = targetContainerId;
      if (!primaryContainerId && analysis.behaelter?.length > 0) {
        primaryContainerId = Brain.slugify(analysis.behaelter[0].id || analysis.behaelter[0].name);
      } else if (!primaryContainerId && customName) {
        primaryContainerId = Brain.slugify(customName);
      } else if (!primaryContainerId) {
        primaryContainerId = 'inhalt';
      }

      // Save resized photo to IndexedDB with history
      try {
        const resized = await resizeImage(file, 1200);
        await Brain.savePhotoWithHistory(roomId, primaryContainerId, resized);
        Brain.setContainerHasPhoto(roomId, primaryContainerId, true);
      } catch(err) { console.warn('Foto konnte nicht gespeichert werden:', err.message); }

      // New flow (main photo view only): hotspot picking view
      if (!targetRoomId) {
        const photoDataUrl = e.target.result;
        showPhotoStatus('Erkenne Gegenstände im Foto…', 'loading');
        try {
          const hotspotsData = await analyzeHotspots(apiKey, base64, mimeType, roomId, primaryContainerId);
          // Ensure container exists for items to be saved into
          if (!Brain.getContainer(roomId, primaryContainerId)) {
            const containerName = customName || analysis.behaelter?.[0]?.name || 'Inhalt';
            Brain.addContainer(roomId, primaryContainerId, containerName, 'sonstiges', [], true);
          }
          showPickingView(roomId, primaryContainerId, photoDataUrl, hotspotsData);
          stopAnalysisAnimation();
          document.getElementById('photo-status').style.display = 'none';
        } catch {
          // Fallback: old behavior with chat follow-up questions
          stopAnalysisAnimation();
          processPhotoAnalysisResult(roomId, analysis);
          showPhotoStatus(`Ich habe ${count} Bereiche gelernt.`, 'success');
          renderBrainView();
        }
      } else {
        stopAnalysisAnimation();
        showPhotoStatus(`Ich habe ${count} Bereiche gelernt.`, 'success');
        renderBrainView();
      }
    } catch (err) {
      stopAnalysisAnimation();
      showPhotoStatus(getErrorMessage(err), 'error');
    }
  };
  reader.readAsDataURL(file);
}

// ── Video Analysis for Photo View ─────────────────────
let videoAbortController = null;

async function handleVideoFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    showPhotoStatus('Bitte eine Video-Datei wählen.', 'error');
    return;
  }

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showPhotoStatus('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.', 'error');
    return;
  }

  const roomId = document.getElementById('photo-room-select').value;
  if (!roomId) {
    showPhotoStatus('Bitte zuerst einen Raum wählen.', 'error');
    return;
  }

  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_VIDEO_SIZE_MB) {
    showPhotoStatus(`Video zu groß (${Math.round(sizeMB)} MB). Maximum: ${MAX_VIDEO_SIZE_MB} MB.`, 'error');
    return;
  }

  videoAbortController = new AbortController();
  startAnalysisAnimation('videoAnalysis');

  let uploadedFile = null;
  try {
    ensureRoom(roomId);

    // Upload video to Gemini File API
    uploadedFile = await uploadVideoToGemini(apiKey, file, (phase, pct) => {
      if (videoAbortController?.signal.aborted) return;
    });

    if (videoAbortController?.signal.aborted) throw new Error('aborted');

    // Build system prompt for container-level video analysis
    const customName = document.getElementById('photo-custom-name').value.trim();
    const systemPrompt = `Du bist ein Raumerkennungs-Assistent. Analysiere dieses Video eines Raums.
Erkenne alle sichtbaren Aufbewahrungsmöbel und deren Inhalte.

Antworte NUR mit diesem JSON:
{
  "behaelter": [
    {
      "id": "eindeutige_id",
      "name": "menschlicher Name",
      "typ": "schrank|regal|schublade|kiste|tuer|sonstiges",
      "position": "kurze Positionsbeschreibung",
      "inhalt_sicher": ["Gegenstand der klar in diesem Behälter liegt"],
      "inhalt_unsicher": [
        {
          "name": "Gegenstand",
          "vermutung": "liegt vermutlich in diesem Behälter, aber nicht 100% sicher"
        }
      ],
      "behaelter": []
    }
  ],
  "lose_gegenstaende": ["Gegenstand klar außerhalb aller Behälter"],
  "unklar": [
    {
      "name": "Gegenstand",
      "kontext": "Kurze Beschreibung warum unklar"
    }
  ],
  "raumhinweis": "kurze Raumcharakteristik"
}
Regeln:
- Inventarisiere nur lose Gegenstände (Umzugskarton-Faustregel)
- Ignoriere fest installierte Infrastruktur (Griffe, Steckdosen, Heizkörper etc.)
- Maximal 3 Ebenen tief
- Jeder Behälter braucht eine eindeutige ID
- Analysiere das Video frame-übergreifend für eine vollständige Erfassung`;

    const messages = [{
      role: 'user',
      content: [
        { type: 'file', source: { type: 'uri', uri: uploadedFile.fileUri, mimeType: uploadedFile.mimeType } },
        { type: 'text', text: customName ? `Video-Analyse aus: ${customName}` : 'Analysiere dieses Video des Raums.' }
      ]
    }];

    const raw = await callGemini(apiKey, systemPrompt, messages, { taskType: 'videoAnalysis', hasVideo: true });

    if (videoAbortController?.signal.aborted) throw new Error('aborted');

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Kein JSON in Antwort');

    const analysis = JSON.parse(jsonMatch[0]);

    // Apply custom name if set
    if (customName && analysis.behaelter?.length > 0) {
      analysis.behaelter[0].name = customName;
      analysis.behaelter[0].id = Brain.slugify(customName);
    }

    const count = Brain.applyPhotoAnalysis(roomId, analysis);

    stopAnalysisAnimation();
    showPhotoStatus(`🎬 Video analysiert – ${count} Bereiche erkannt.`, 'success');
    renderBrainView();

  } catch (err) {
    stopAnalysisAnimation();
    if (err.message === 'aborted') return;
    const baseMsg = getErrorMessage(err);
    showPhotoStatus(baseMsg + '\n💡 Tipp: Versuche stattdessen einzelne Fotos.', 'error');
  } finally {
    videoAbortController = null;
    if (uploadedFile?.fileName) {
      deleteGeminiFile(apiKey, uploadedFile.fileName).catch(() => {});
    }
  }
}

function cancelVideoAnalysis() {
  if (videoAbortController) {
    videoAbortController.abort();
    videoAbortController = null;
    stopAnalysisAnimation();
    showPhotoStatus('Video-Analyse abgebrochen.', 'error');
  }
}

function showPhotoStatus(msg, type) {
  const el = document.getElementById('photo-status');
  el.textContent = msg;
  el.className = `photo-status photo-status--${type}`;
  el.style.display = 'block';
}

// ── Rotating Analysis Messages (via LoadingManager) ───
function startAnalysisAnimation(taskType = 'analyzePhoto') {
  stopAnalysisAnimation();
  const el = document.getElementById('photo-status');
  el.className = 'photo-status photo-status--loading';
  el.style.display = 'block';
  loadingManager.start(taskType, el);
}

function stopAnalysisAnimation() {
  loadingManager.stop();
}

// ── PHOTO ANALYSIS CONFIDENCE PROCESSING ──────────────
// Generates chat follow-up messages for unsicher/unklar items
function processPhotoAnalysisResult(roomId, analysis) {
  const unsicherQuestions = [];
  const unklarItems = [];

  (analysis.behaelter || []).forEach(b => {
    const containerName = b.name;
    // inhalt_unsicher → saved with uncertain flag, ask user to confirm
    (b.inhalt_unsicher || []).forEach(u => {
      const itemName = typeof u === 'string' ? u : u.name;
      unsicherQuestions.push({ item: itemName, container: containerName });
    });
  });

  (analysis.unklar || []).forEach(u => {
    unklarItems.push(typeof u === 'string' ? u : u.name);
  });

  if (unsicherQuestions.length === 0 && unklarItems.length === 0) return;

  // Switch to chat to show follow-up questions
  showView('chat');

  // Unsichere Items: one question per item
  unsicherQuestions.forEach(({ item, container }) => {
    const msg = `Ich habe eine ${item} gefunden und sie vorläufig in "${container}" einsortiert. Stimmt das, oder soll ich sie woanders zuordnen?`;
    appendMessage('assistant', msg);
    Brain.addChatMessage('assistant', msg);
  });

  // Unklar Items: one combined message
  if (unklarItems.length > 0) {
    const list = unklarItems.join(', ');
    const msg = `Ein paar Dinge konnte ich nicht zuordnen: ${list}. Wo sollen die hin?`;
    appendMessage('assistant', msg);
    Brain.addChatMessage('assistant', msg);
  }
}

// ── HOTSPOT ANALYSIS ────────────────────────────────────
async function analyzeHotspots(apiKey, base64, mimeType, roomId, containerId) {
  // Build existing items context for dedup
  let existingItemsHint = '';
  if (roomId && containerId) {
    const existingItems = Brain.getContainerItemNames(roomId, containerId);
    if (existingItems.length > 0) {
      existingItemsHint = `\nDieser Behälter enthält bereits: ${existingItems.join(', ')}. Erkenne diese Gegenstände NICHT erneut – liste nur NEUE Gegenstände auf.`;
    }
  }

  // Build infrastructure ignore list for hotspot analysis
  let infrastructureHint = '';
  if (roomId && containerId) {
    const ignoreNames = Brain.getInfrastructureIgnoreList(roomId, containerId);
    const globalIgnore = Brain.getGlobalInfrastructure();
    const allIgnore = [...new Set([...ignoreNames, ...globalIgnore])];
    if (allIgnore.length > 0) {
      infrastructureHint = `\nFolgende Dinge wurden vom Nutzer als fest installiert markiert. Setze KEINE Hotspots darauf: ${allIgnore.join(', ')}.`;
    }
  }

  const systemPrompt = `GRUNDREGEL – Was ist ein Gegenstand?
Markiere ausschließlich lose Gegenstände, also Dinge, die ein Mensch ohne Werkzeug aufheben und woanders hinlegen kann. Stell dir die Umzugskarton-Faustregel vor: Wenn du es beim Umzug nicht einpacken würdest, ist es kein Gegenstand.

Setze KEINE Hotspots auf fest installierte Infrastruktur. Kein Hotspot auf Griffe, Scharniere, Steckdosen, Lichtschalter, Regalhalterungen, Heizkörper, Fensterbeschläge, Fußleisten, eingebaute Leuchten, Wasserhähne, Spülbecken oder Einbaugeräte. Wenn etwas zum Möbel gehört (gleicher Werkstoff, nahtlos verbunden), ist es Teil des Behälters, nicht ein Gegenstand.

Wenn du bei einem Objekt unsicher bist, ob es fest montiert oder lose ist (z.B. ein Monitorarm, eine Tischlampe mit Klemme), setze trotzdem einen Hotspot, aber markiere ihn mit "typ": "unsicher_fest".${infrastructureHint}

Analysiere dieses Foto eines Aufbewahrungsorts. Identifiziere einzelne, klar unterscheidbare Gegenstände.
WICHTIG: Versuche NICHT alles zu erkennen. Nur Dinge die du mit Sicherheit als einzelnes Objekt identifizieren kannst.${existingItemsHint}
Antworte NUR mit JSON:
{
  "hotspots": [
    {
      "id": "obj_1",
      "vermutung": "menschlicher Name, z.B. weißes USB-Netzteil",
      "konfidenz": "hoch",
      "position": { "x": 0.5, "y": 0.3 },
      "typ": "item"
    }
  ],
  "zusammenfassung": "kurze Beschreibung was du siehst",
  "erkannt": 3,
  "geschaetzt": 10,
  "hinweis": "z.B. Viele Kabel überlappen sich"
}
Regeln:
- position x,y ist der ungefähre Mittelpunkt des Objekts (0=links/oben, 1=rechts/unten)
- Nur Objekte mit mindestens mittlerer Konfidenz aufnehmen
- Lieber 5 sichere Hotspots als 15 unsichere
- Bei komplettem Chaos: Wenige markante Dinge rauspicken
- Das Feld "typ" ist optional: "item" (Standard, normaler Gegenstand), "container" (ein Unterbehälter), "unsicher_fest" (du bist unsicher ob fest montiert oder lose). Setze "typ" nur wenn es nicht "item" ist.

OPTIONAL – Wertschätzung:
Schätze für jeden erkannten Gegenstand den ungefähren Wiederbeschaffungswert (Neupreis heute in Euro).
- Nur schätzen wenn du Marke, Modell oder Typ hinreichend erkennen kannst
- Bei generischen Gegenständen ohne erkennbare Marke (z.B. "weißer Teller", "Handtuch") → groben Durchschnittswert angeben
- Bei Kleinkram unter 5€ → null (nicht schätzen)
- Gib eine Bandbreite an (min/max), nicht nur einen Wert
- Wenn unsicher → replacement_value: null
Ergänze im JSON pro Hotspot (optional):
"replacement_value": Zahl oder null,
"replacement_range": [min, max] oder null,
"brand_model": "Erkannte Marke/Modell" oder null`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text', text: 'Analysiere die Gegenstände in diesem Foto.' }
    ]
  }];

  const raw = await callGemini(apiKey, systemPrompt, messages, { taskType: 'analyzeHotspots', hasImage: true });
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Kein JSON in Antwort');
  return JSON.parse(jsonMatch[0]);
}

// ── PICKING VIEW ─────────────────────────────────────────
function setupPickingView() {
  document.getElementById('picking-close').addEventListener('click', closePickingView);
  document.getElementById('picking-done').addEventListener('click', finishPicking);
  document.getElementById('picking-panel-confirm').addEventListener('click', confirmHotspotItem);
  document.getElementById('picking-panel-skip').addEventListener('click', skipHotspotItem);
  document.getElementById('picking-panel-mic').addEventListener('click', togglePickingMic);
  document.getElementById('picking-photo-wrapper').addEventListener('click', addFreeHotspot);
  document.getElementById('picking-panel-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmHotspotItem(); }
  });
}

function showPickingView(roomId, containerId, photoDataUrl, hotspotsData) {
  pickingState = {
    roomId,
    containerId,
    hotspots: (hotspotsData.hotspots || []).filter(h => h.position?.x != null && h.position?.y != null),
    summary: hotspotsData,
    confirmed: {},
    activeId: null
  };

  const overlay = document.getElementById('picking-overlay');
  const photo = document.getElementById('picking-photo');
  photo.src = photoDataUrl;
  overlay.style.display = 'flex';
  document.getElementById('picking-panel').style.display = 'none';

  const erkannt = hotspotsData.erkannt || pickingState.hotspots.length;
  const geschaetzt = hotspotsData.geschaetzt || erkannt;
  const hinweis = hotspotsData.hinweis ? ` ${hotspotsData.hinweis}.` : '';
  const summaryEl = document.getElementById('picking-summary');

  if (erkannt > 0) {
    summaryEl.textContent = `Ich habe ${erkannt} ${erkannt === 1 ? 'Ding' : 'Dinge'} erkannt, schätze aber ca. ${geschaetzt} Sachen.${hinweis} Tippe auf eine Markierung zum Bestätigen oder auf das Foto um eigene zu setzen.`;
  } else {
    summaryEl.textContent = `Hier ist einiges durcheinander.${hinweis} Ich habe wenig erkannt – tippe direkt auf das Foto um Dinge zu markieren.`;
  }

  if (photo.complete && photo.naturalWidth > 0) {
    renderPickingHotspots();
  } else {
    photo.onload = () => renderPickingHotspots();
  }
}

function getImageRenderRect() {
  const photo = document.getElementById('picking-photo');
  const wrapper = document.getElementById('picking-photo-wrapper');
  const wRect = wrapper.getBoundingClientRect();
  const imgAspect = photo.naturalWidth / photo.naturalHeight;
  const wrapperAspect = wRect.width / wRect.height;

  let renderW, renderH, offsetX, offsetY;
  if (imgAspect > wrapperAspect) {
    renderW = wRect.width;
    renderH = wRect.width / imgAspect;
    offsetX = 0;
    offsetY = (wRect.height - renderH) / 2;
  } else {
    renderH = wRect.height;
    renderW = wRect.height * imgAspect;
    offsetX = (wRect.width - renderW) / 2;
    offsetY = 0;
  }
  return { renderW, renderH, offsetX, offsetY };
}

function renderPickingHotspots() {
  if (!pickingState) return;
  const wrapper = document.getElementById('picking-photo-wrapper');
  wrapper.querySelectorAll('.picking-hotspot').forEach(h => h.remove());

  const { hotspots, confirmed, activeId } = pickingState;
  const { renderW, renderH, offsetX, offsetY } = getImageRenderRect();

  hotspots.forEach(hs => {
    const dot = document.createElement('button');
    dot.className = 'picking-hotspot';
    dot.dataset.id = hs.id;

    const isConfirmed = !!confirmed[hs.id];
    const isUncertain = hs.typ === 'unsicher_fest';
    if (isConfirmed) dot.classList.add('picking-hotspot--confirmed');
    else if (isUncertain) dot.classList.add('picking-hotspot--uncertain');
    if (activeId === hs.id) dot.classList.add('picking-hotspot--active');

    dot.style.left = `${offsetX + hs.position.x * renderW}px`;
    dot.style.top = `${offsetY + hs.position.y * renderH}px`;

    if (isUncertain && !isConfirmed) {
      dot.textContent = '?';
    }

    const label = document.createElement('span');
    label.className = 'picking-hotspot-label';
    label.textContent = isConfirmed ? confirmed[hs.id].name : hs.vermutung;
    dot.appendChild(label);

    dot.addEventListener('click', e => { e.stopPropagation(); openHotspotPanel(hs.id); });
    wrapper.appendChild(dot);
  });
}

function openHotspotPanel(hotspotId) {
  if (!pickingState) return;
  pickingState.activeId = hotspotId;
  renderPickingHotspots();

  const hs = pickingState.hotspots.find(h => h.id === hotspotId);
  const existing = pickingState.confirmed[hotspotId];

  const panel = document.getElementById('picking-panel');
  const labelEl = document.getElementById('picking-panel-label');
  const input = document.getElementById('picking-panel-input');
  const actionsEl = panel.querySelector('.picking-panel-actions');

  // Remove any previous uncertain buttons
  const oldUncertain = panel.querySelector('.picking-uncertain-actions');
  if (oldUncertain) oldUncertain.remove();

  const isUncertain = hs?.typ === 'unsicher_fest' && !existing;

  if (isUncertain) {
    // Show decision buttons instead of normal input flow
    labelEl.textContent = hs.vermutung
      ? `"${hs.vermutung}" – Fest installiert oder loser Gegenstand?`
      : 'Fest installiert oder loser Gegenstand?';
    input.style.display = 'none';
    actionsEl.style.display = 'none';

    const uncertainDiv = document.createElement('div');
    uncertainDiv.className = 'picking-uncertain-actions';

    const infraBtn = document.createElement('button');
    infraBtn.className = 'picking-uncertain-btn picking-uncertain-btn--infra';
    infraBtn.innerHTML = '🔧 Gehört zum Möbel';
    infraBtn.addEventListener('click', () => {
      const name = hs.vermutung || 'Unbekannt';
      Brain.addInfrastructureIgnore(pickingState.roomId, pickingState.containerId, name);
      // Remove this hotspot entirely
      pickingState.hotspots = pickingState.hotspots.filter(h => h.id !== hotspotId);
      pickingState.activeId = null;
      panel.style.display = 'none';
      input.style.display = '';
      actionsEl.style.display = '';
      renderPickingHotspots();
    });

    const itemBtn = document.createElement('button');
    itemBtn.className = 'picking-uncertain-btn picking-uncertain-btn--item';
    itemBtn.innerHTML = '✅ Ist ein Gegenstand';
    itemBtn.addEventListener('click', () => {
      // Switch to normal confirmation flow
      hs.typ = 'item';
      input.style.display = '';
      actionsEl.style.display = '';
      uncertainDiv.remove();
      labelEl.textContent = hs.vermutung ? `KI-Vorschlag: "${hs.vermutung}"` : 'Was ist das?';
      input.value = hs.vermutung || '';
      renderPickingHotspots();
      input.focus();
      input.select();
    });

    uncertainDiv.appendChild(infraBtn);
    uncertainDiv.appendChild(itemBtn);
    panel.appendChild(uncertainDiv);
  } else {
    // Normal flow
    input.style.display = '';
    actionsEl.style.display = '';
    labelEl.textContent = existing
      ? 'Bestätigt – Name ändern:'
      : (hs?.vermutung ? `KI-Vorschlag: "${hs.vermutung}"` : 'Was ist das?');
    input.value = existing ? existing.name : (hs?.vermutung || '');
  }

  panel.style.display = 'flex';
  if (!isUncertain) {
    input.focus();
    input.select();
  }
}

async function confirmHotspotItem() {
  if (!pickingState) return;
  const input = document.getElementById('picking-panel-input');
  const name = input.value.trim();
  if (!name) return;

  const hotspotId = pickingState.activeId;
  if (!hotspotId) return;

  const { roomId, containerId } = pickingState;
  const hs = pickingState.hotspots.find(h => h.id === hotspotId);

  // Create and save crop
  let cropId = null;
  if (hs) {
    try {
      const photo = document.getElementById('picking-photo');
      const cropBlob = await createCropFromHotspot(photo, hs.position);
      cropId = `${roomId}_${containerId}_${hotspotId}`;
      await Brain.savePhoto(`crop_${cropId}`, cropBlob);
    } catch(err) { console.warn('Crop fehlgeschlagen:', err.message); }
  }

  // Dedup: check for similar item in container (Mechanism B)
  const similarItem = Brain.findSimilarItem(roomId, containerId, name);
  if (similarItem) {
    // Update existing item instead of creating a new one
    Brain.updateExistingItem(roomId, containerId, similarItem.name);
    // Attach crop_ref to existing item if crop was created
    if (cropId) {
      const data2 = Brain.getData();
      const c2 = Brain._findContainerInTree(data2.rooms?.[roomId]?.containers, containerId);
      if (c2) {
        Brain._migrateContainerItems(c2);
        const item = c2.items.find(i => Brain.getItemName(i) === similarItem.name);
        if (item && typeof item === 'object') {
          item.crop_ref = `crop_${cropId}`;
          Brain.save(data2);
        }
      }
    }
  } else {
    // Save new item with spatial position from hotspot
    const spatialOpts = {};
    if (hs && hs.position) {
      spatialOpts.spatial = { position: { x: hs.position.x, y: hs.position.y } };
    }
    if (cropId) spatialOpts.crop_ref = `crop_${cropId}`;
    const data = Brain.getData();
    const c = Brain._findContainerInTree(data.rooms?.[roomId]?.containers, containerId);
    if (c) {
      Brain._migrateContainerItems(c);
      const exists = c.items.some(i => Brain.getItemName(i) === name);
      if (!exists) {
        // Attach valuation from hotspot if available
        if (hs && hs.replacement_value != null) {
          spatialOpts.valuation = {
            replacement_value: hs.replacement_value,
            replacement_range_min: Array.isArray(hs.replacement_range) ? hs.replacement_range[0] : null,
            replacement_range_max: Array.isArray(hs.replacement_range) ? hs.replacement_range[1] : null,
            source: 'photo_ai',
            estimated_at: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
            model_recognized: hs.brand_model || null
          };
        }
        c.items.push(Brain.createItemObject(name, spatialOpts));
        c.last_updated = Date.now();
        Brain.save(data);
      }
    }
  }

  // Save valuation for existing items that got matched
  if (similarItem && hs && hs.replacement_value != null) {
    Brain.setValuation(roomId, containerId, similarItem.name, {
      replacement_value: hs.replacement_value,
      replacement_range_min: Array.isArray(hs.replacement_range) ? hs.replacement_range[0] : null,
      replacement_range_max: Array.isArray(hs.replacement_range) ? hs.replacement_range[1] : null,
      source: 'photo_ai',
      model_recognized: hs.brand_model || null
    });
  }

  // Mark confirmed
  pickingState.confirmed[hotspotId] = { name, cropId };
  pickingState.activeId = null;

  document.getElementById('picking-panel').style.display = 'none';
  renderPickingHotspots();
}

function skipHotspotItem() {
  if (!pickingState) return;
  pickingState.activeId = null;
  document.getElementById('picking-panel').style.display = 'none';
  renderPickingHotspots();
}

function addFreeHotspot(e) {
  if (!pickingState) return;
  const wrapper = document.getElementById('picking-photo-wrapper');
  const photo = document.getElementById('picking-photo');
  if (e.target !== wrapper && e.target !== photo) return;

  const wRect = wrapper.getBoundingClientRect();
  const { renderW, renderH, offsetX, offsetY } = getImageRenderRect();

  const clickX = e.clientX - wRect.left;
  const clickY = e.clientY - wRect.top;
  const x = (clickX - offsetX) / renderW;
  const y = (clickY - offsetY) / renderH;

  if (x < 0 || x > 1 || y < 0 || y > 1) return;

  const newId = `custom_${Date.now()}`;
  pickingState.hotspots.push({ id: newId, vermutung: '', konfidenz: 'mittel', position: { x, y } });
  renderPickingHotspots();
  openHotspotPanel(newId);
}

async function createCropFromHotspot(photoImg, position) {
  const CROP_SIZE = 200;
  const canvas = document.createElement('canvas');
  canvas.width = CROP_SIZE;
  canvas.height = CROP_SIZE;
  const ctx = canvas.getContext('2d');

  const imgW = photoImg.naturalWidth;
  const imgH = photoImg.naturalHeight;
  const halfSize = Math.min(imgW, imgH) * 0.2;
  const centerX = position.x * imgW;
  const centerY = position.y * imgH;
  const srcX = Math.max(0, centerX - halfSize);
  const srcY = Math.max(0, centerY - halfSize);
  const srcW = Math.min(halfSize * 2, imgW - srcX);
  const srcH = Math.min(halfSize * 2, imgH - srcY);

  ctx.drawImage(photoImg, srcX, srcY, srcW, srcH, 0, 0, CROP_SIZE, CROP_SIZE);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.85));
}

function finishPicking() {
  if (!pickingState) return;
  const { confirmed, roomId, containerId } = pickingState;
  const count = Object.keys(confirmed).length;
  const container = Brain.getContainer(roomId, containerId);
  const containerName = container?.name || containerId;

  closePickingView();
  renderBrainView();

  if (count > 0) {
    showPhotoStatus(
      `Du hast ${count} ${count === 1 ? 'Gegenstand' : 'Gegenstände'} in "${containerName}" gespeichert.\nDu kannst jederzeit ein neues Foto machen um mehr zu erfassen.`,
      'success'
    );
  } else {
    showPhotoStatus('Nichts gespeichert. Du kannst jederzeit ein neues Foto machen.', 'success');
  }
}

function closePickingView() {
  document.getElementById('picking-overlay').style.display = 'none';
  if (pickingIsRecording && pickingRecognition) {
    pickingRecognition.stop();
    pickingIsRecording = false;
  }
  document.getElementById('picking-panel-mic').classList.remove('recording');
  pickingState = null;
}

function togglePickingMic() {
  const btn = document.getElementById('picking-panel-mic');

  if (pickingIsRecording) {
    if (pickingRecognition) pickingRecognition.stop();
    pickingIsRecording = false;
    btn.classList.remove('recording');
    return;
  }

  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  pickingRecognition = new SpeechRecognition();
  pickingRecognition.lang = 'de-DE';
  pickingRecognition.continuous = false;
  pickingRecognition.interimResults = false;

  pickingRecognition.onresult = e => {
    document.getElementById('picking-panel-input').value = e.results[0][0].transcript;
  };
  pickingRecognition.onend = () => {
    pickingIsRecording = false;
    btn.classList.remove('recording');
  };
  pickingRecognition.onerror = () => {
    pickingIsRecording = false;
    btn.classList.remove('recording');
  };

  pickingRecognition.start();
  pickingIsRecording = true;
  btn.classList.add('recording');
}

// ── STAGING OVERLAY ────────────────────────────────────
function setupStagingOverlay() {
  document.getElementById('staging-close').addEventListener('click', closeStagingOverlay);
  document.getElementById('staging-cancel-btn').addEventListener('click', closeStagingOverlay);
  document.getElementById('staging-add-btn').addEventListener('click', async () => {
    const file = await capturePhoto();
    if (file) addFileToStaging(file);
    else if (stagedPhotos.length === 0) closeStagingOverlay();
  });
  document.getElementById('staging-analyze-btn').addEventListener('click', analyzeAllStagedPhotos);

  // Delegated click handler for staging thumbnails (avoids per-element listeners)
  document.getElementById('staging-thumbnails').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.staging-thumb-remove');
    if (!removeBtn) return;
    const thumb = removeBtn.closest('.staging-thumb');
    const index = parseInt(thumb.dataset.index);
    stagedPhotos.splice(index, 1);
    renderStagingThumbnails();
    const analyzeBtn = document.getElementById('staging-analyze-btn');
    analyzeBtn.disabled = stagedPhotos.length === 0;
    analyzeBtn.textContent = stagedPhotos.length > 1
      ? `${stagedPhotos.length} Fotos analysieren`
      : 'Analysieren';
  });
}

function showStagingOverlay(title) {
  stagedPhotos = [];
  document.getElementById('staging-thumbnails').innerHTML = '';
  document.getElementById('staging-analyze-btn').disabled = true;
  document.getElementById('staging-analyze-btn').textContent = 'Analysieren';
  document.getElementById('staging-title').textContent = title || 'Fotos sammeln';
  const hint = document.getElementById('staging-hint');
  if (stagingTarget?.roomScanFlow) {
    hint.textContent = 'Tipp: Fotografiere den Raum aus mehreren Blickwinkeln für bessere Ergebnisse. Jedes Möbelstück wird nur einmal erkannt.';
    hint.style.display = '';
  } else {
    hint.style.display = 'none';
  }
  document.getElementById('staging-overlay').style.display = 'flex';
}

function closeStagingOverlay() {
  document.getElementById('staging-overlay').style.display = 'none';
  stagedPhotos = [];
  stagingTarget = null;
}

async function addFileToStaging(file) {
  if (!file) return;
  if (stagedPhotos.length >= 5) {
    showToast('Maximal 5 Fotos möglich.', 'warning');
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    showToast('Foto zu groß – bitte ein kleineres wählen.', 'warning');
    return;
  }
  try {
    const { base64, mimeType } = await resizeImageForChat(file);
    const previewUrl = `data:${mimeType};base64,${base64}`;
    stagedPhotos.push({ base64, mimeType, previewUrl, originalFile: file });
    renderStagingThumbnails();
    const analyzeBtn = document.getElementById('staging-analyze-btn');
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = stagedPhotos.length > 1
      ? `${stagedPhotos.length} Fotos analysieren`
      : 'Analysieren';
  } catch {
    showToast('Foto konnte nicht geladen werden.', 'error');
  }
}

function renderStagingThumbnails() {
  const container = document.getElementById('staging-thumbnails');
  container.innerHTML = '';
  stagedPhotos.forEach((photo, index) => {
    const thumb = document.createElement('div');
    thumb.className = 'staging-thumb';
    thumb.dataset.index = index;
    const img = document.createElement('img');
    img.src = photo.previewUrl;
    img.alt = `Foto ${index + 1}`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'staging-thumb-remove';
    removeBtn.textContent = '✕';
    removeBtn.setAttribute('aria-label', `Foto ${index + 1} entfernen`);
    // Click handled by delegation on #staging-thumbnails
    thumb.appendChild(img);
    thumb.appendChild(removeBtn);
    container.appendChild(thumb);
  });
  // Show/hide "add more" hint
  const addBtn = document.getElementById('staging-add-btn');
  addBtn.style.display = stagedPhotos.length >= 5 ? 'none' : '';
}

async function analyzeAllStagedPhotos() {
  if (stagedPhotos.length === 0 || !stagingTarget) return;

  // Room scan flow: delegate to onboarding module
  if (stagingTarget.roomScanFlow) {
    const photos = stagedPhotos.map(p => ({ base64: p.base64, mimeType: p.mimeType }));
    analyzeRoomScanPhotos(photos);
    return;
  }

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showToast('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.', 'error');
    return;
  }

  const { roomId, containerId, containerName, mode } = stagingTarget;
  const analyzeBtn = document.getElementById('staging-analyze-btn');
  analyzeBtn.disabled = true;
  analyzeBtn.textContent = 'Analysiere…';

  try {
    ensureRoom(roomId);

    // Check if container already has items → Delta mode
    const existingContainer = Brain.getContainer(roomId, containerId);
    const existingActiveItems = existingContainer ? Brain.getActiveItems(roomId, containerId) : [];
    const isDeltaMode = existingActiveItems.length > 0;

    const photoCount = stagedPhotos.length;
    let systemPrompt;

    if (isDeltaMode) {
      // Delta mode: compare photo with known contents
      const knownItemsList = existingActiveItems.map(item => {
        const name = Brain.getItemName(item);
        const menge = item.menge || 1;
        return menge > 1 ? `${menge}x ${name}` : name;
      }).join(', ');

      systemPrompt = `Analysiere ${photoCount > 1 ? 'alle ' + photoCount + ' Fotos zusammen' : 'dieses Foto'}.
Vergleiche das Foto mit dem bekannten Inhalt dieses Behälters.
Bekannter Inhalt (aus der Datenbank): ${knownItemsList}

Antworte NUR mit diesem JSON:
{
  "bestaetigt": [
    {"name": "Schere", "menge": 1}
  ],
  "nicht_gesehen": [
    {"name": "Alter Adapter", "vermutung": "nicht mehr sichtbar"}
  ],
  "neu_erkannt": [
    {"name": "Taschenlampe", "menge": 1}
  ],
  "hinweis": "optionaler Kommentar (sonst leer lassen)"
}
Regeln:
- "bestaetigt": Dinge die du auf dem Foto siehst UND die im bekannten Inhalt stehen
- "nicht_gesehen": Dinge aus dem bekannten Inhalt die du auf dem Foto NICHT sehen kannst
- "neu_erkannt": Dinge die du auf dem Foto siehst aber die NICHT im bekannten Inhalt stehen
- Sei ehrlich: Wenn etwas verdeckt sein könnte, sage das in der "vermutung"
- Mengen aktualisieren wenn sich die Anzahl geändert hat
- Jede Variante (Farbe, Muster, Größe) ist ein separater Eintrag
- Bei mehreren Fotos: Kombiniere alle Erkenntnisse`;
    } else {
      systemPrompt = `Analysiere ${photoCount > 1 ? 'alle ' + photoCount + ' Fotos zusammen' : 'dieses Foto'}.
WICHTIG: Zähle identische oder ähnliche Gegenstände und gib die Menge an. Sei spezifisch bei Farbe, Muster und Größe.
Antworte NUR mit diesem JSON:
{
  "inhalt": [
    {"name": "Handtuch, dunkelblau", "menge": 3},
    {"name": "Handtuch, weiß", "menge": 2}
  ],
  "hinweis": "optionaler Tipp wenn Sachen übereinanderliegen oder schwer zählbar sind (sonst leer lassen)"
}
Regeln:
- Jede Variante (Farbe, Muster, Größe) ist ein separater Eintrag mit eigenem Mengenwert
- NICHT "Handtücher" (zu allgemein) → sondern "Handtuch, dunkelblau" mit Menge 3
- Bei mehreren Fotos: Kombiniere alle Erkenntnisse, vermeide Duplikate
- Schätze Mengen wenn nicht exakt zählbar
- hinweis nur setzen wenn wirklich hilfreich (z.B. "Dinge liegen übereinander – einzeln fotografieren hilft")`;
    }

    if (getNfcContext()?.tag) {
      systemPrompt += `\nKontext: Der Nutzer steht vor "${Brain.getContainer(getNfcContext().room, getNfcContext().tag)?.name || getNfcContext().tag}". Das Foto zeigt vermutlich einen Teil dieses Möbelstücks.`;
    }

    const imageContents = stagedPhotos.map(p => ({
      type: 'image',
      source: { type: 'base64', media_type: p.mimeType, data: p.base64 }
    }));
    const textContent = {
      type: 'text',
      text: containerName ? `Inhalt von: ${containerName}` : 'Analysiere die Gegenstände.'
    };

    const messages = [{ role: 'user', content: [...imageContents, textContent] }];
    const raw = await callGemini(apiKey, systemPrompt, messages, { taskType: 'analyzePhoto', hasImage: true });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Kein JSON in Antwort');

    const analysis = JSON.parse(jsonMatch[0]);
    let items;
    let deltaData = null;

    if (isDeltaMode) {
      // Parse delta response into three sections
      const bestaetigt = (analysis.bestaetigt || []).map((item, i) => ({
        id: `confirmed_${i}`,
        name: typeof item === 'string' ? item : (item.name || ''),
        menge: typeof item === 'string' ? 1 : Math.max(1, parseInt(item.menge) || 1),
        checked: true,
        section: 'bestaetigt'
      })).filter(item => item.name.trim());

      const nichtGesehen = (analysis.nicht_gesehen || []).map((item, i) => ({
        id: `missing_${i}`,
        name: typeof item === 'string' ? item : (item.name || ''),
        vermutung: typeof item === 'string' ? '' : (item.vermutung || ''),
        action: 'nichts', // 'nichts' | 'weg' | 'verdeckt'
        section: 'nicht_gesehen'
      })).filter(item => item.name.trim());

      const neuErkannt = (analysis.neu_erkannt || []).map((item, i) => ({
        id: `new_${i}`,
        name: typeof item === 'string' ? item : (item.name || ''),
        menge: typeof item === 'string' ? 1 : Math.max(1, parseInt(item.menge) || 1),
        checked: true,
        section: 'neu_erkannt'
      })).filter(item => item.name.trim());

      items = [...bestaetigt, ...neuErkannt]; // for backwards compat with confirmReview
      deltaData = { bestaetigt, nichtGesehen, neuErkannt };
    } else {
      items = (analysis.inhalt || []).map((item, i) => ({
        id: `item_${i}`,
        name: typeof item === 'string' ? item : (item.name || ''),
        menge: typeof item === 'string' ? 1 : Math.max(1, parseInt(item.menge) || 1),
        checked: true
      })).filter(item => item.name.trim());
    }

    // Save first photo to IndexedDB with history
    try {
      const firstFile = stagedPhotos[0].originalFile;
      if (firstFile) {
        const resized = await resizeImage(firstFile, 1200);
        await Brain.savePhotoWithHistory(roomId, containerId, resized);
      }
      if (!Brain.getContainer(roomId, containerId)) {
        Brain.addContainer(roomId, containerId, containerName || containerId, 'sonstiges', [], true);
      }
      Brain.setContainerHasPhoto(roomId, containerId, true);
    } catch(err) { console.warn('Foto konnte nicht gespeichert werden:', err.message); }

    const hint = (analysis.hinweis || '').trim();
    const isOnboarding = stagingTarget?.onboardingFlow;
    closeStagingOverlay();
    showReviewPopup(roomId, containerId, containerName, items, mode || 'add', hint || null, isOnboarding, deltaData);

  } catch (err) {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Analysieren';
    showToast(getErrorMessage(err), 'error');
  }
}

// ── REVIEW OVERLAY ─────────────────────────────────────
function setupReviewOverlay() {
  document.getElementById('review-confirm').addEventListener('click', confirmReview);
  document.getElementById('review-cancel').addEventListener('click', closeReviewPopup);
  document.getElementById('review-add-manual').addEventListener('click', addManualReviewItem);
}

function showReviewPopup(roomId, containerId, containerName, items, mode, hinweis, onboardingFlow, deltaData) {
  reviewState = {
    roomId, containerId, containerName,
    items: items.map(i => ({ ...i })),
    mode, onboardingFlow,
    deltaData: deltaData ? {
      bestaetigt: deltaData.bestaetigt.map(i => ({ ...i })),
      nichtGesehen: deltaData.nichtGesehen.map(i => ({ ...i })),
      neuErkannt: deltaData.neuErkannt.map(i => ({ ...i }))
    } : null
  };
  renderReviewList();

  const titleEl = document.querySelector('.review-title');
  const subtitleEl = document.getElementById('review-subtitle');
  const hintEl = document.querySelector('.review-hint');

  if (deltaData) {
    titleEl.textContent = 'Inhalt aktualisieren';
    hintEl.textContent = 'Bestätigte Gegenstände werden aktualisiert. Bei nicht gesehenen: entscheide ob weg oder nur verdeckt.';
  } else {
    titleEl.textContent = 'Erkannte Gegenstände';
    hintEl.textContent = 'Hake an was stimmt. Korrigiere Namen oder Mengen per Tippen. Nicht Erkanntes unten manuell hinzufügen.';
  }
  subtitleEl.textContent = containerName ? `für "${containerName}"` : '';

  const tipEl = document.getElementById('review-tip');
  if (hinweis) {
    tipEl.textContent = `💡 Tipp: ${hinweis}`;
    tipEl.style.display = 'block';
  } else {
    tipEl.style.display = 'none';
  }

  document.getElementById('review-overlay').style.display = 'flex';
}

function renderReviewList() {
  if (!reviewState) return;
  const listEl = document.getElementById('review-list');
  listEl.innerHTML = '';

  if (reviewState.deltaData) {
    renderDeltaReviewList(listEl);
  } else {
    renderNormalReviewList(listEl);
  }
}

function renderNormalReviewList(listEl) {
  reviewState.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `review-item${item.checked ? '' : ' review-item--unchecked'}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.checked;
    checkbox.className = 'review-checkbox';
    checkbox.addEventListener('change', e => {
      reviewState.items[index].checked = e.target.checked;
      row.classList.toggle('review-item--unchecked', !e.target.checked);
    });

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = item.name;
    nameInput.className = 'review-name-input';
    nameInput.setAttribute('aria-label', 'Gegenstandsname');
    nameInput.addEventListener('input', e => {
      reviewState.items[index].name = e.target.value;
    });

    const mengeWrapper = document.createElement('div');
    mengeWrapper.className = 'review-menge';

    const mengeInput = document.createElement('input');
    mengeInput.type = 'number';
    mengeInput.min = '1';
    mengeInput.max = '999';
    mengeInput.value = item.menge;
    mengeInput.className = 'review-menge-input';
    mengeInput.setAttribute('aria-label', 'Menge');
    mengeInput.addEventListener('input', e => {
      reviewState.items[index].menge = parseInt(e.target.value) || 1;
    });

    const mengeLabel = document.createElement('span');
    mengeLabel.textContent = 'x';
    mengeLabel.className = 'review-menge-label';

    mengeWrapper.appendChild(mengeInput);
    mengeWrapper.appendChild(mengeLabel);

    row.appendChild(checkbox);
    row.appendChild(nameInput);
    row.appendChild(mengeWrapper);
    listEl.appendChild(row);
  });
}

function renderDeltaReviewList(listEl) {
  const { bestaetigt, nichtGesehen, neuErkannt } = reviewState.deltaData;

  // Section 1: Confirmed items (green)
  if (bestaetigt.length > 0) {
    const section = document.createElement('div');
    section.className = 'delta-section delta-section--confirmed';
    const header = document.createElement('div');
    header.className = 'delta-section-header';
    header.innerHTML = `<span class="delta-section-icon">&#x2705;</span> Best&auml;tigt (${bestaetigt.length})`;
    section.appendChild(header);

    bestaetigt.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = `review-item${item.checked ? '' : ' review-item--unchecked'}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.checked;
      checkbox.className = 'review-checkbox';
      checkbox.addEventListener('change', e => {
        reviewState.deltaData.bestaetigt[i].checked = e.target.checked;
        row.classList.toggle('review-item--unchecked', !e.target.checked);
      });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'review-name-label';
      nameSpan.textContent = item.name;

      const mengeSpan = document.createElement('span');
      mengeSpan.className = 'review-menge-label';
      mengeSpan.textContent = `${item.menge}x`;

      row.appendChild(checkbox);
      row.appendChild(nameSpan);
      row.appendChild(mengeSpan);
      section.appendChild(row);
    });

    listEl.appendChild(section);
  }

  // Section 2: Newly detected items (blue)
  if (neuErkannt.length > 0) {
    const section = document.createElement('div');
    section.className = 'delta-section delta-section--new';
    const header = document.createElement('div');
    header.className = 'delta-section-header';
    header.innerHTML = `<span class="delta-section-icon">&#x1F195;</span> Neu erkannt (${neuErkannt.length})`;
    section.appendChild(header);

    neuErkannt.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = `review-item${item.checked ? '' : ' review-item--unchecked'}`;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.checked;
      checkbox.className = 'review-checkbox';
      checkbox.addEventListener('change', e => {
        reviewState.deltaData.neuErkannt[i].checked = e.target.checked;
        row.classList.toggle('review-item--unchecked', !e.target.checked);
      });

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = item.name;
      nameInput.className = 'review-name-input';
      nameInput.setAttribute('aria-label', 'Gegenstandsname');
      nameInput.addEventListener('input', e => {
        reviewState.deltaData.neuErkannt[i].name = e.target.value;
      });

      const mengeWrapper = document.createElement('div');
      mengeWrapper.className = 'review-menge';
      const mengeInput = document.createElement('input');
      mengeInput.type = 'number';
      mengeInput.min = '1';
      mengeInput.max = '999';
      mengeInput.value = item.menge;
      mengeInput.className = 'review-menge-input';
      mengeInput.setAttribute('aria-label', 'Menge');
      mengeInput.addEventListener('input', e => {
        reviewState.deltaData.neuErkannt[i].menge = parseInt(e.target.value) || 1;
      });
      const mengeLabel = document.createElement('span');
      mengeLabel.textContent = 'x';
      mengeLabel.className = 'review-menge-label';
      mengeWrapper.appendChild(mengeInput);
      mengeWrapper.appendChild(mengeLabel);

      row.appendChild(checkbox);
      row.appendChild(nameInput);
      row.appendChild(mengeWrapper);
      section.appendChild(row);
    });

    listEl.appendChild(section);
  }

  // Section 3: Not seen items (orange)
  if (nichtGesehen.length > 0) {
    const section = document.createElement('div');
    section.className = 'delta-section delta-section--missing';
    const header = document.createElement('div');
    header.className = 'delta-section-header';
    header.innerHTML = `<span class="delta-section-icon">&#x26A0;&#xFE0F;</span> Nicht mehr gesehen (${nichtGesehen.length})`;
    section.appendChild(header);

    const tip = document.createElement('p');
    tip.className = 'delta-section-tip';
    tip.textContent = 'Manche Dinge sind vielleicht nur verdeckt.';
    section.appendChild(tip);

    nichtGesehen.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'review-item delta-missing-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'review-name-label delta-missing-name';
      nameSpan.textContent = item.name;
      if (item.vermutung) nameSpan.title = item.vermutung;

      const actions = document.createElement('div');
      actions.className = 'delta-missing-actions';

      const wegBtn = document.createElement('button');
      wegBtn.className = 'delta-btn delta-btn--weg' + (item.action === 'weg' ? ' delta-btn--active' : '');
      wegBtn.textContent = 'Weg';
      wegBtn.setAttribute('aria-label', `${item.name} ist weg`);

      const verdecktBtn = document.createElement('button');
      verdecktBtn.className = 'delta-btn delta-btn--verdeckt' + (item.action === 'verdeckt' ? ' delta-btn--active' : '');
      verdecktBtn.textContent = 'Verdeckt';
      verdecktBtn.setAttribute('aria-label', `${item.name} ist verdeckt`);

      wegBtn.addEventListener('click', () => {
        const current = reviewState.deltaData.nichtGesehen[i].action;
        reviewState.deltaData.nichtGesehen[i].action = current === 'weg' ? 'nichts' : 'weg';
        wegBtn.classList.toggle('delta-btn--active', reviewState.deltaData.nichtGesehen[i].action === 'weg');
        verdecktBtn.classList.remove('delta-btn--active');
      });

      verdecktBtn.addEventListener('click', () => {
        const current = reviewState.deltaData.nichtGesehen[i].action;
        reviewState.deltaData.nichtGesehen[i].action = current === 'verdeckt' ? 'nichts' : 'verdeckt';
        verdecktBtn.classList.toggle('delta-btn--active', reviewState.deltaData.nichtGesehen[i].action === 'verdeckt');
        wegBtn.classList.remove('delta-btn--active');
      });

      actions.appendChild(wegBtn);
      actions.appendChild(verdecktBtn);

      row.appendChild(nameSpan);
      row.appendChild(actions);
      section.appendChild(row);
    });

    listEl.appendChild(section);
  }
}

function closeReviewPopup() {
  document.getElementById('review-overlay').style.display = 'none';
  reviewState = null;
}

function confirmReview() {
  if (!reviewState) return;
  const { roomId, containerId, containerName, items, mode, deltaData } = reviewState;
  const isOnboarding = reviewState.onboardingFlow;

  ensureRoom(roomId);
  if (!Brain.getContainer(roomId, containerId)) {
    Brain.addContainer(roomId, containerId, containerName || containerId, 'sonstiges', [], true);
  }

  if (deltaData) {
    // Delta mode: process three sections separately
    let totalChanges = 0;

    // 1. Confirmed items: update last_seen and seen_count
    const confirmedNames = deltaData.bestaetigt
      .filter(i => i.checked)
      .map(i => i.name);
    if (confirmedNames.length > 0) {
      Brain.updateItemsLastSeen(roomId, containerId, confirmedNames);
      totalChanges += confirmedNames.length;
    }
    // Also update menge for confirmed items if changed
    deltaData.bestaetigt.filter(i => i.checked).forEach(i => {
      const c = Brain.getContainer(roomId, containerId);
      const existing = (c?.items || []).find(item => Brain.getItemName(item) === i.name);
      if (existing && typeof existing === 'object' && existing.menge !== i.menge) {
        existing.menge = i.menge;
      }
    });
    if (deltaData.bestaetigt.some(i => i.checked)) {
      const data = Brain.getData();
      Brain.save(data);
    }

    // 2. Newly detected items: add as new
    const newItems = deltaData.neuErkannt
      .filter(i => i.checked && i.name.trim())
      .map(i => ({ name: i.name.trim(), menge: i.menge || 1, checked: true }));
    if (newItems.length > 0) {
      Brain.addItemsFromReview(roomId, containerId, newItems);
      totalChanges += newItems.length;
    }

    // 3. Not seen items: archive or leave
    deltaData.nichtGesehen.forEach(item => {
      if (item.action === 'weg') {
        Brain.archiveItem(roomId, containerId, item.name);
        totalChanges++;
      }
      // 'verdeckt' → do nothing (item stays active, last_seen NOT updated)
      // 'nichts' → do nothing
    });

    const containerDisplayName = Brain.getContainer(roomId, containerId)?.name || containerName || containerId;
    closeReviewPopup();
    renderBrainView();

    const archivedCount = deltaData.nichtGesehen.filter(i => i.action === 'weg').length;
    let msg = `${confirmedNames.length} bestätigt`;
    if (newItems.length > 0) msg += `, ${newItems.length} neu`;
    if (archivedCount > 0) msg += `, ${archivedCount} archiviert`;

    if (isOnboarding) {
      showOnboardingDoneStep();
    } else if (getCurrentView() === 'brain') {
      showBrainToast(msg);
    } else {
      showPhotoStatus(`${containerDisplayName}: ${msg}`, 'success');
    }

    if (typeof CustomEvent !== 'undefined') {
      document.dispatchEvent(new CustomEvent('ordo:review-confirmed', {
        detail: { roomId, containerId, itemsCount: confirmedNames.length + newItems.length, mode: 'delta' }
      }));
    }
  } else {
    // Normal mode (first scan)
    if (mode === 'replace') {
      const data = Brain.getData();
      if (data.rooms?.[roomId]?.containers?.[containerId]) {
        data.rooms[roomId].containers[containerId].items = [];
        data.rooms[roomId].containers[containerId].quantities = {};
        Brain.save(data);
      }
    }

    const count = Brain.addItemsFromReview(roomId, containerId, items);
    const containerDisplayName = Brain.getContainer(roomId, containerId)?.name || containerName || containerId;

    closeReviewPopup();
    renderBrainView();

    if (isOnboarding) {
      showOnboardingDoneStep();
    } else if (getCurrentView() === 'brain') {
      showBrainToast(`${count} ${count === 1 ? 'Gegenstand' : 'Gegenstände'} übernommen`);
    } else {
      showPhotoStatus(
        `${count} ${count === 1 ? 'Gegenstand' : 'Gegenstände'} in "${containerDisplayName}" übernommen.`,
        'success'
      );
    }

    if (typeof CustomEvent !== 'undefined') {
      document.dispatchEvent(new CustomEvent('ordo:review-confirmed', {
        detail: { roomId, containerId, itemsCount: count, mode: 'normal' }
      }));
    }
  }
}

async function addManualReviewItem() {
  if (!reviewState) return;
  const result = await showInputModal({
    title: 'Gegenstand hinzufügen',
    fields: [{ placeholder: 'Name des Gegenstands' }]
  });
  if (!result || !result[0]?.trim()) return;
  reviewState.items.push({
    id: `manual_${Date.now()}`,
    name: result[0].trim(),
    menge: 1,
    checked: true
  });
  renderReviewList();
}

// ── Open Camera for Container (used by brain-view) ────
async function openCameraForContainer(roomId, cId) {
  const container = Brain.getContainer(roomId, cId);
  const containerName = container?.name || cId;
  stagingTarget = { roomId, containerId: cId, containerName, mode: 'add' };
  showStagingOverlay(`📷 ${containerName}`);
  const file = await capturePhoto();
  if (file) addFileToStaging(file);
  else if (stagedPhotos.length === 0) closeStagingOverlay();
}

function setStagingTarget(val) { stagingTarget = val; }

// ── Offline Photo Queue ───────────────────────────────
const QUEUE_KEY = 'ordo_photo_queue';

async function queuePhotoForAnalysis(blob, roomId, containerId) {
  const photoKey = `queued_${roomId}_${containerId}_${Date.now()}`;
  await Brain.savePhoto(photoKey, blob);

  const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  queue.push({
    photoKey,
    roomId,
    containerId,
    queuedAt: new Date().toISOString(),
    status: 'pending'
  });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  updateQueueBadge();
  return photoKey;
}

function getQueueLength() {
  const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  return queue.filter(q => q.status === 'pending' || q.status === 'retry').length;
}

function updateQueueBadge() {
  let badge = document.getElementById('offline-queue-badge');
  const count = getQueueLength();
  if (count === 0) {
    if (badge) badge.style.display = 'none';
    return;
  }
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'offline-queue-badge';
    badge.className = 'offline-queue-badge';
    document.body.appendChild(badge);
  }
  badge.textContent = `📶 ${count} Foto${count > 1 ? 's' : ''} warte${count > 1 ? 'n' : 't'} auf Analyse`;
  badge.style.display = 'block';
}

async function processQueue() {
  const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  const pending = queue.filter(q => q.status === 'pending' || q.status === 'retry');

  if (pending.length === 0) return;
  if (!navigator.onLine) return;

  const apiKey = Brain.getApiKey();
  if (!apiKey) return;

  let doneCount = 0;

  for (const entry of pending) {
    try {
      const blob = await Brain.getPhoto(entry.photoKey);
      if (!blob) {
        entry.status = 'failed';
        continue;
      }

      const base64 = await blobToBase64(blob);
      // Run the normal photo analysis flow
      await handlePhotoFile(new File([blob], 'queued.jpg', { type: 'image/jpeg' }), entry.roomId, entry.containerId);

      entry.status = 'done';
      doneCount++;

      // Remove temporary queue photo
      await Brain.deletePhoto(entry.photoKey);
    } catch (err) {
      console.warn('Queue processing failed:', err);
      entry.status = 'retry';
    }
  }

  // Update queue: remove completed entries
  const remaining = queue.filter(q => q.status !== 'done');
  localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  updateQueueBadge();

  if (doneCount > 0) {
    showToast(`${doneCount} Foto${doneCount > 1 ? 's' : ''} nachträglich analysiert`, 'success');
  }
}

function setupOfflineQueue() {
  // Process queue on app start (delayed)
  setTimeout(processQueue, 3000);

  // Process queue when back online
  window.addEventListener('online', () => {
    showToast('Wieder online', 'success');
    setTimeout(processQueue, 1000);
  });

  // Show badge on load
  updateQueueBadge();
}

// ── Exports ────────────────────────────────────────────
export {
  setupPhoto, setupPickingView, setupStagingOverlay, setupReviewOverlay,
  renderRoomDropdown, applyNfcContextToPhotoView,
  resizeImage, resizeImageForChat, blobToBase64,
  showStagingOverlay, closeStagingOverlay, addFileToStaging, showReviewPopup,
  openCameraForContainer, handlePhotoFile, handleVideoFile, cancelVideoAnalysis, showPhotoStatus,
  setStagingTarget,
  queuePhotoForAnalysis, processQueue, setupOfflineQueue, getQueueLength, updateQueueBadge
};
