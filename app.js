// app.js – Main application logic

const MODEL = 'gemini-3-flash-preview';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

// ── State ──────────────────────────────────────────────
let currentView = 'chat';
let recognition = null;
let isRecording = false;
let nfcContext = null; // { room, tag } from URL params
let chatPendingPhoto = null; // { base64, mimeType } – Foto im Chat-Eingabefeld

// Picking view state
let pickingState = null; // { roomId, containerId, hotspots, confirmed, activeId }
let pickingRecognition = null;
let pickingIsRecording = false;

// Staging / Review state
let stagedPhotos = []; // [{ base64, mimeType, previewUrl, originalFile }]
let stagingTarget = null; // { roomId, containerId, containerName, mode }
let reviewState = null; // { roomId, containerId, containerName, items, mode }

// Move container state
let moveContainerState = null; // { roomId, containerId }

// ── Helpers ─────────────────────────────────────────────
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Toast System ────────────────────────────────────────
function showToast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast--out');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

// ── Modal System ────────────────────────────────────────
// showInputModal({ title, description?, fields: [{ label, placeholder, defaultValue?, type? }] }) → Promise<string[]|null>
function showInputModal({ title, description, fields }) {
  return new Promise(resolve => {
    const modal = document.getElementById('ordo-modal');
    const titleEl = document.getElementById('ordo-modal-title');
    const descEl = document.getElementById('ordo-modal-desc');
    const fieldsEl = document.getElementById('ordo-modal-fields');
    const actionsEl = document.getElementById('ordo-modal-actions');

    titleEl.textContent = title;
    descEl.textContent = description || '';
    fieldsEl.innerHTML = '';
    actionsEl.innerHTML = '';

    const inputs = [];
    fields.forEach(f => {
      if (f.label) {
        const label = document.createElement('label');
        label.className = 'ordo-modal-field-label';
        label.textContent = f.label;
        fieldsEl.appendChild(label);
      }
      if (f.type === 'select' && f.options) {
        const select = document.createElement('select');
        select.className = 'ordo-modal-select';
        f.options.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          if (opt.value === f.defaultValue) o.selected = true;
          select.appendChild(o);
        });
        fieldsEl.appendChild(select);
        inputs.push(select);
      } else {
        const input = document.createElement('input');
        input.className = 'ordo-modal-input';
        input.type = f.type || 'text';
        input.placeholder = f.placeholder || '';
        input.value = f.defaultValue || '';
        fieldsEl.appendChild(input);
        inputs.push(input);
      }
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ordo-modal-btn ordo-modal-btn--cancel';
    cancelBtn.textContent = 'Abbrechen';

    const okBtn = document.createElement('button');
    okBtn.className = 'ordo-modal-btn ordo-modal-btn--primary';
    okBtn.textContent = 'OK';

    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);

    function close(result) {
      modal.style.display = 'none';
      modal.removeEventListener('click', onBackdrop);
      resolve(result);
    }

    function onBackdrop(e) {
      if (e.target === modal) close(null);
    }

    cancelBtn.addEventListener('click', () => close(null));
    okBtn.addEventListener('click', () => {
      const values = inputs.map(i => i.value);
      close(values);
    });
    modal.addEventListener('click', onBackdrop);

    // Enter key submits
    inputs.forEach(input => {
      if (input.tagName === 'INPUT') {
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const values = inputs.map(i => i.value);
            close(values);
          }
        });
      }
    });

    modal.style.display = 'flex';
    setTimeout(() => inputs[0]?.focus(), 50);
  });
}

// showConfirmModal({ title, description, confirmLabel?, danger? }) → Promise<boolean>
function showConfirmModal({ title, description, confirmLabel, danger }) {
  return new Promise(resolve => {
    const modal = document.getElementById('ordo-modal');
    const titleEl = document.getElementById('ordo-modal-title');
    const descEl = document.getElementById('ordo-modal-desc');
    const fieldsEl = document.getElementById('ordo-modal-fields');
    const actionsEl = document.getElementById('ordo-modal-actions');

    titleEl.textContent = title;
    descEl.textContent = description || '';
    fieldsEl.innerHTML = '';
    actionsEl.innerHTML = '';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ordo-modal-btn ordo-modal-btn--cancel';
    cancelBtn.textContent = 'Abbrechen';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = `ordo-modal-btn ${danger ? 'ordo-modal-btn--danger' : 'ordo-modal-btn--primary'}`;
    confirmBtn.textContent = confirmLabel || 'Ja';

    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(confirmBtn);

    function close(result) {
      modal.style.display = 'none';
      modal.removeEventListener('click', onBackdrop);
      resolve(result);
    }

    function onBackdrop(e) {
      if (e.target === modal) close(false);
    }

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    modal.addEventListener('click', onBackdrop);

    modal.style.display = 'flex';
    setTimeout(() => confirmBtn.focus(), 50);
  });
}

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  Brain.init();
  parseNfcParams();
  registerServiceWorker();
  setupNavigation();
  setupChat();
  setupPhoto();
  setupBrain();
  setupSettings();
  setupPickingView();
  setupStagingOverlay();
  setupReviewOverlay();
  setupPullToRefresh();
  setupOnboarding();
  setupPhotoTimeline();
  setupMoveContainerOverlay();
  setupNfcContextView();

  // Show onboarding on very first start (no data, no flag)
  if (!localStorage.getItem('onboarding_completed') && Brain.isEmpty()) {
    showOnboarding();
  } else if (nfcContext && nfcContext.tag) {
    // NFC tag scanned → show contextual view
    showView('nfc-context');
  } else {
    showView('chat');
  }
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('./service-worker.js').catch(() => {});

  // Guard gegen doppelten Reload (controllerchange + statechange können gleichzeitig feuern)
  let reloading = false;

  // Nur auf controllerchange reagieren – feuert einmalig wenn neuer SW übernimmt
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

// ── URL / NFC Params ───────────────────────────────────
function parseNfcParams() {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  const tag = params.get('tag');
  if (room) {
    nfcContext = { room, tag };
  }
}

// ── Navigation ─────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  document.getElementById('settings-gear').addEventListener('click', () => showView('settings'));
}

function showView(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('active');

  const navBtn = document.querySelector(`.nav-btn[data-view="${name}"]`);
  if (navBtn) navBtn.classList.add('active');

  if (name === 'chat') { initChat(); maybeShowChatSuggestions(); }
  if (name === 'brain') renderBrainView();
  if (name === 'settings') renderSettings();
  if (name === 'nfc-context') renderNfcContextView();
  if (name === 'photo') {
    renderRoomDropdown('photo-room-select');
    applyNfcContextToPhotoView();
  }
}

// ── CHAT VIEW ──────────────────────────────────────────
function setupChat() {
  document.getElementById('chat-send').addEventListener('click', sendChatMessage);
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  document.getElementById('chat-mic').addEventListener('click', toggleMic);
  setupChatCamera();
}

// ── CHAT KAMERA ────────────────────────────────────────
function setupChatCamera() {
  const btn = document.getElementById('chat-camera');
  const input = document.getElementById('chat-photo-input');
  const removeBtn = document.getElementById('chat-photo-remove');

  btn.addEventListener('click', () => input.click());

  input.addEventListener('change', async e => {
    const file = e.target.files[0];
    input.value = ''; // Reset, damit dieselbe Datei erneut ausgewählt werden kann
    if (!file) return;

    if (file.size > 4 * 1024 * 1024) {
      appendMessage('assistant', 'Foto zu groß – bitte ein kleineres wählen.');
      return;
    }

    try {
      const { base64, mimeType } = await resizeImageForChat(file);
      chatPendingPhoto = { base64, mimeType };

      const thumb = document.getElementById('chat-photo-thumb');
      thumb.src = `data:${mimeType};base64,${base64}`;
      document.getElementById('chat-photo-preview').hidden = false;
      document.getElementById('chat-input').focus();
    } catch {
      appendMessage('assistant', 'Foto konnte nicht geladen werden.');
    }
  });

  removeBtn.addEventListener('click', clearChatPhoto);
}

function clearChatPhoto() {
  chatPendingPhoto = null;
  document.getElementById('chat-photo-preview').hidden = true;
  document.getElementById('chat-photo-thumb').src = '';
}

// Unified image resize: returnFormat 'base64' → {base64, mimeType}, 'blob' → Blob
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

function initChat() {
  const messages = document.getElementById('chat-messages');
  if (messages.children.length === 0) {
    if (nfcContext) {
      const room = Brain.getRoom(nfcContext.room);
      const container = nfcContext.tag ? Brain.getContainer(nfcContext.room, nfcContext.tag) : null;
      const roomName = room?.name || nfcContext.room;
      const tagName = container?.name || nfcContext.tag || '';
      const loc = tagName ? `${tagName} – ${roomName}` : roomName;
      appendMessage('assistant', `Du bist jetzt bei: ${loc}`);
    } else if (Brain.isEmpty()) {
      appendMessage('assistant',
        'Ich bin neu hier und kenne deinen Haushalt noch nicht. Zeig mir einen Raum – ein Foto reicht. Danach beantworte ich jede Frage sofort. Willst du wissen wie das genau funktioniert? Frag mich.');
    } else {
      appendMessage('assistant', 'Hallo! Was kann ich für dich tun?');
    }
  }
  renderChatSuggestions();
}

function appendMessage(role, text, thinking = false) {
  const messages = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg chat-msg--${role}${thinking ? ' chat-msg--thinking' : ''}`;
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  const photo = chatPendingPhoto; // vor dem Löschen sichern

  if (!text && !photo) return;

  const sendBtn = document.getElementById('chat-send');
  if (sendBtn.classList.contains('sending')) return; // Prevent double-send

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showSystemMessage('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.');
    return;
  }

  sendBtn.classList.add('sending');
  input.value = '';
  if (photo) clearChatPhoto();
  hideChatSuggestions();

  // Nutzernachricht anzeigen (mit Kamera-Icon wenn Foto dabei)
  const displayText = photo ? (text ? `📷 ${text}` : '📷 Foto') : text;
  appendMessage('user', displayText);
  Brain.addChatMessage('user', displayText);

  const thinking = appendMessage('assistant', '…', true);

  try {
    const context = Brain.buildContext();

    // Unified ORDO System-Prompt
    let systemPrompt = `Du bist ORDO, ein stiller Haushaltsassistent. Hier ist was du über diesen Haushalt weißt:
${context}

REGELN:
- Antworte immer in maximal 2 kurzen Sätzen.
- Wenn du etwas nicht weißt, bitte um ein Foto.

AKTIONEN:
Du kannst die Datenbank verändern über Marker. Der Nutzer sieht die Marker nicht.
Format: <!--ORDO:{"type":"...","room":"...","path":[...],...}-->

Verfügbare Typen:
- add_item: Gegenstand hinzufügen (mit menge). {"type":"add_item","room":"...","path":["container_id"],"item":"...","menge":1}
- remove_item: Gegenstand entfernen. {"type":"remove_item","room":"...","path":["container_id"],"item":"..."}
- remove_items: Mehrere entfernen. {"type":"remove_items","room":"...","path":["container_id"],"items":["...","..."]}
- move_item: Gegenstand verschieben. {"type":"move_item","from_room":"...","from_path":["container_id"],"to_room":"...","to_path":["container_id"],"item":"..."}
- replace_items: Alle Items ersetzen. {"type":"replace_items","room":"...","path":["container_id"],"items":[{"name":"...","menge":1}]}
- add_container: Neuen Behälter anlegen. {"type":"add_container","room":"...","path":["parent_id"],"id":"...","name":"...","typ":"..."}
- delete_container: Behälter löschen. {"type":"delete_container","room":"...","path":["container_id"]}
- rename_container: Behälter umbenennen. {"type":"rename_container","room":"...","path":["container_id"],"new_name":"..."}
- delete_room: Raum löschen. {"type":"delete_room","room":"..."}
- found: Gegenstand in Datenbank gefunden. {"type":"found","room":"...","path":["container_id"],"item":"..."}

WICHTIG:
- Bei destruktiven Aktionen (delete_container, delete_room): IMMER erst nachfragen, dann erst beim nächsten Turn den Marker einfügen.
- Bei einfachen Änderungen: Direkt ausführen + bestätigen.
- Verwende path als Array von Container-IDs. Für flache Container: ["container_id"].
- Wenn du unsicher bist welcher Behälter gemeint ist: Frage nach, kein Marker.
- Bei found: Nenne den Ort UND füge den found-Marker ein. Die App zeigt dann automatisch einen Foto-Button falls ein Foto existiert.
- Verwende slugifizierte IDs: Kleinbuchstaben, Umlaute umschreiben (ä→ae, ö→oe, ü→ue, ß→ss), Leerzeichen zu Unterstrichen.
- Beispiele: "Küche" → "kueche", "Schrank links" → "schrank_links"

FOTOS IM CHAT:
Wenn der Nutzer ein Foto schickt, analysiere es:
A) Aufbewahrungsort erkannt → Schlage vor, Inhalt zu speichern.
B) Einzelner Gegenstand → Frage wo er liegt, biete Speichern an.
C) Allgemeine Frage → Beantworte ohne Speichern.`;

    // NFC-Kontext in System-Prompt einbetten
    if (nfcContext) {
      const nfcRoom = Brain.getRoom(nfcContext.room);
      const nfcContainer = nfcContext.tag ? Brain.getContainer(nfcContext.room, nfcContext.tag) : null;
      const nfcRoomName = nfcRoom?.name || nfcContext.room;
      const nfcContainerName = nfcContainer?.name || nfcContext.tag || '';
      if (nfcContainerName) {
        const nfcPath = Brain.getContainerPath(nfcContext.room, nfcContext.tag);
        const pathStr = nfcPath.length > 0 ? JSON.stringify(nfcPath) : `["${nfcContext.tag}"]`;
        systemPrompt += `\n\nDer Nutzer steht gerade vor: ${nfcContainerName} im Raum ${nfcRoomName}. Wenn er Gegenstände erwähnt, ordne sie diesem Behälter zu (room: "${nfcContext.room}", path: ${pathStr}) – außer er sagt ausdrücklich etwas anderes.`;
      } else {
        systemPrompt += `\n\nDer Nutzer befindet sich gerade im Raum: ${nfcRoomName}. Ordne erwähnte Gegenstände diesem Raum zu – außer er sagt ausdrücklich etwas anderes.`;
      }
    }

    // Erweiterung für Foto-Nachrichten
    if (photo) {
      const knownRooms = Object.entries(Brain.getRooms())
        .map(([id, r]) => `${id} (${r.name})`).join(', ') || 'noch keine Räume bekannt';

      systemPrompt += `\nBekannte Räume: ${knownRooms}`;

      if (nfcContext) {
        const nfcRoom = Brain.getRoom(nfcContext.room);
        const nfcContainer = nfcContext.tag ? Brain.getContainer(nfcContext.room, nfcContext.tag) : null;
        const nfcPath = nfcContext.tag ? Brain.getContainerPath(nfcContext.room, nfcContext.tag) : [];
        const pathStr = nfcPath.length > 0 ? JSON.stringify(nfcPath) : `["${nfcContext.tag || ''}"]`;
        systemPrompt += `\nDer Nutzer steht vor "${nfcContainer?.name || nfcContext.tag || nfcRoom?.name}" – ordne erkannte Gegenstände direkt diesem Behälter zu (room: "${nfcContext.room}", path: ${pathStr}).`;
      }
    }

    const history = Brain.getChatHistory().slice(-20).map(m => ({ role: m.role, content: m.content }));
    const messages = buildMessages(history, text || 'Was siehst du auf diesem Foto?');

    // Letztes User-Msg mit Bild anreichern wenn Foto vorhanden
    if (photo) {
      const lastMsg = messages[messages.length - 1];
      lastMsg.content = [
        { type: 'image', source: { type: 'base64', media_type: photo.mimeType, data: photo.base64 } },
        { type: 'text', text: text || 'Was siehst du auf diesem Foto?' }
      ];
    }

    const response = await callGemini(apiKey, systemPrompt, messages);
    thinking.remove();

    // Legacy ##SAVE##-Marker (very old format)
    if (response.includes('##SAVE##')) {
      handleSaveResponse(response);
    } else {
      // Unified ORDO marker system (also handles legacy SAVE/ACTION/FOUND markers)
      const { cleanText, actions, foundItems } = processMarkers(response);
      const msgDiv = appendMessage('assistant', cleanText);
      Brain.addChatMessage('assistant', cleanText);
      actions.forEach(action => executeOrdoAction(action));
      if (foundItems.length > 0) {
        renderFoundPhotoButtons(msgDiv, foundItems);
      }
    }
  } catch (err) {
    thinking.remove();
    showSystemMessage(getErrorMessage(err));
  } finally {
    document.getElementById('chat-send').classList.remove('sending');
  }
}

function handleSaveResponse(response) {
  const [displayText, jsonPart] = response.split('##SAVE##');
  const msgEl = appendMessage('assistant', displayText.trim());
  Brain.addChatMessage('assistant', displayText.trim());

  // JSON parsen
  let analysis = null;
  let roomId = 'sonstiges';
  try {
    const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysis = JSON.parse(jsonMatch[0]);
      roomId = analysis.raumId || 'sonstiges';
    }
  } catch { /* JSON nicht parsebar → kein Speichern-Button */ }

  if (!analysis) return;

  // Speichern-Button an die KI-Nachricht anhängen
  const saveBtn = document.createElement('button');
  saveBtn.className = 'chat-save-btn';
  saveBtn.textContent = '💾 Speichern';
  saveBtn.addEventListener('click', () => {
    ensureRoom(roomId);
    const count = Brain.applyPhotoAnalysis(roomId, analysis);
    saveBtn.textContent = `✓ ${count} Bereiche gespeichert`;
    saveBtn.disabled = true;
    saveBtn.classList.add('chat-save-btn--done');
    renderBrainView();
  });
  msgEl.appendChild(saveBtn);
}

function buildMessages(history, newUserText) {
  // Build proper alternating message array
  const msgs = [];
  let lastRole = null;
  for (const m of history) {
    if (m.role !== lastRole) {
      msgs.push({ role: m.role, content: m.content });
      lastRole = m.role;
    }
  }
  if (lastRole === 'user') {
    // need to add a dummy assistant message or skip last user
    msgs.push({ role: 'assistant', content: '…' });
  }
  msgs.push({ role: 'user', content: newUserText });
  return msgs;
}

function checkForItemExtraction(userText, assistantResponse) {
  // Handled via <!--SAVE:--> markers in the AI response
}

// ── UNIFIED ORDO MARKER SYSTEM ─────────────────────────

// Extracts all <!--ORDO:{...}--> markers from AI response text
// Also handles legacy <!--SAVE:...-->, <!--ACTION:...-->, <!--FOUND:...--> for backwards compat
// Returns { cleanText, actions[], foundItems[] }
function processMarkers(text) {
  const actions = [];
  const foundItems = [];

  // Process unified ORDO markers
  let cleanText = text.replace(/<!--ORDO:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const marker = JSON.parse(jsonStr.trim());
      if (marker.type === 'found') {
        foundItems.push(marker);
      } else {
        actions.push(marker);
      }
    } catch { /* ignore malformed markers */ }
    return '';
  });

  // Legacy: <!--SAVE:...-->
  cleanText = cleanText.replace(/<!--SAVE:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const action = JSON.parse(jsonStr.trim());
      // Convert legacy SAVE format to ORDO format
      const converted = convertLegacySaveToOrdo(action);
      if (converted) actions.push(converted);
    } catch { /* ignore */ }
    return '';
  });

  // Legacy: <!--ACTION:...-->
  cleanText = cleanText.replace(/<!--ACTION:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const action = JSON.parse(jsonStr.trim());
      // Convert legacy ACTION format to ORDO format
      const converted = convertLegacyActionToOrdo(action);
      if (converted) actions.push(converted);
    } catch { /* ignore */ }
    return '';
  });

  // Legacy: <!--FOUND:...-->
  cleanText = cleanText.replace(/<!--FOUND:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const item = JSON.parse(jsonStr.trim());
      if (item.room && item.container) {
        foundItems.push({ type: 'found', room: item.room, path: [item.container], item: item.item });
      }
    } catch { /* ignore */ }
    return '';
  });

  return { cleanText: cleanText.trim(), actions, foundItems };
}

// Convert legacy SAVE marker to ORDO format
function convertLegacySaveToOrdo(action) {
  switch (action.action) {
    case 'add_item':
      return { type: 'add_item', room: action.room, path: [action.container], item: action.item, menge: 1 };
    case 'move_item':
      return { type: 'move_item', from_room: action.from_room || action.room, from_path: [action.from_container || action.container], to_room: action.room, to_path: [action.container], item: action.item };
    case 'remove_item':
      return { type: 'remove_item', room: action.room, path: [action.container], item: action.item };
    case 'add_container':
      return { type: 'add_container', room: action.room, path: [], id: action.container, name: action.name || action.container, typ: action.typ || 'sonstiges' };
    default: return null;
  }
}

// Convert legacy ACTION marker to ORDO format
function convertLegacyActionToOrdo(action) {
  switch (action.type) {
    case 'add_item':
      return { type: 'add_item', room: action.room, path: [action.container], item: action.item, menge: 1 };
    case 'remove_item':
      return { type: 'remove_item', room: action.room, path: [action.container], item: action.item };
    case 'move_item':
      return { type: 'move_item', from_room: action.from_room, from_path: [action.from_container], to_room: action.to_room, to_path: [action.to_container], item: action.item };
    case 'remove_items':
      return { type: 'remove_items', room: action.room, path: [action.container], items: action.items };
    case 'replace_items':
      return { type: 'replace_items', room: action.room, path: [action.container], items: (action.items || []).map(i => typeof i === 'string' ? { name: i, menge: 1 } : i) };
    case 'delete_container':
      return { type: 'delete_container', room: action.room, path: [action.container] };
    case 'rename_container':
      return { type: 'rename_container', room: action.room, path: [action.container], new_name: action.new_name };
    case 'delete_room':
      return { type: 'delete_room', room: action.room };
    case 'add_container':
      return { type: 'add_container', room: action.room, path: [], id: action.container, name: action.name || action.container, typ: action.typ || 'sonstiges' };
    default: return null;
  }
}

// Resolves a path array to the last container ID
function resolveContainerFromPath(roomId, path) {
  if (!path || path.length === 0) return null;
  return path[path.length - 1];
}

// Room presets for auto-creation
const ROOM_PRESETS = {
  kueche: ['🍳', 'Küche'], wohnzimmer: ['🛋️', 'Wohnzimmer'],
  schlafzimmer: ['🛏️', 'Schlafzimmer'], arbeitszimmer: ['💻', 'Arbeitszimmer'],
  keller: ['📦', 'Keller'], bad: ['🚿', 'Bad'], sonstiges: ['🏠', 'Sonstiges'],
  flur: ['🚪', 'Flur'], garage: ['🚗', 'Garage'], kinderzimmer: ['🧸', 'Kinderzimmer'],
  balkon: ['🌿', 'Balkon'], dachboden: ['🏚️', 'Dachboden'], gaestezimmer: ['🛏️', 'Gästezimmer']
};

function ensureRoom(roomId) {
  if (roomId && !Brain.getRoom(roomId)) {
    const p = ROOM_PRESETS[roomId] || ['🏠', roomId];
    Brain.addRoom(roomId, p[1], p[0]);
  }
}

// Unified action executor for all ORDO marker types
function executeOrdoAction(action) {
  try {
    // Validate destructive actions: target must exist
    if (action.type === 'delete_room' && !Brain.getRoom(action.room)) {
      debugLog(`Marker ignoriert: Raum "${action.room}" existiert nicht`);
      return;
    }
    if (action.type === 'delete_container') {
      const cId = resolveContainerFromPath(action.room, action.path);
      if (!Brain.getRoom(action.room) || !cId || !Brain.getContainer(action.room, cId)) {
        debugLog(`Marker ignoriert: Container "${cId}" in "${action.room}" existiert nicht`);
        return;
      }
    }

    const containerId = resolveContainerFromPath(action.room, action.path);

    switch (action.type) {
      case 'add_item': {
        ensureRoom(action.room);
        if (containerId && !Brain.getContainer(action.room, containerId)) {
          Brain.addContainer(action.room, containerId, containerId, 'sonstiges');
        }
        if (containerId) {
          Brain.addItem(action.room, containerId, action.item);
          // Store quantity if > 1
          if (action.menge && action.menge > 1) {
            const data = Brain.getData();
            const c = Brain._findContainerInTree(data.rooms?.[action.room]?.containers, containerId);
            if (c) {
              if (!c.quantities) c.quantities = {};
              c.quantities[action.item] = action.menge;
              Brain.save(data);
            }
          }
          const c = Brain.getContainer(action.room, containerId);
          const r = Brain.getRoom(action.room);
          showSystemMessage(`✓ ${action.item} → ${c?.name || containerId} (${r?.name || action.room})`);
        }
        renderBrainView();
        break;
      }
      case 'remove_item': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        Brain.removeItem(action.room, containerId, action.item);
        showSystemMessage(`✓ ${action.item} entfernt aus ${c?.name || containerId} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'remove_items': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        (action.items || []).forEach(item => Brain.removeItem(action.room, containerId, item));
        showSystemMessage(`✓ ${(action.items || []).length} Gegenstände entfernt aus ${c?.name || containerId} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'move_item': {
        const fromId = resolveContainerFromPath(action.from_room, action.from_path);
        const toId = resolveContainerFromPath(action.to_room, action.to_path);
        if (!fromId || !toId) return;
        const fromC = Brain.getContainer(action.from_room, fromId);
        const toR = Brain.getRoom(action.to_room);
        const toC = Brain.getContainer(action.to_room, toId);
        if (!fromC || !toR || !toC) return;
        const fromR = Brain.getRoom(action.from_room);
        Brain.removeItem(action.from_room, fromId, action.item);
        Brain.addItem(action.to_room, toId, action.item);
        showSystemMessage(`✓ ${action.item} verschoben: ${fromR?.name || action.from_room} → ${toR?.name || action.to_room}`);
        renderBrainView();
        break;
      }
      case 'replace_items': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        const data = Brain.getData();
        const cont = Brain._findContainerInTree(data.rooms[action.room].containers, containerId);
        if (cont) {
          cont.items = (action.items || []).map(i => typeof i === 'string' ? i : i.name);
          cont.quantities = {};
          (action.items || []).forEach(i => {
            if (typeof i === 'object' && i.menge > 1) {
              cont.quantities[i.name] = i.menge;
            }
          });
          Brain.save(data);
        }
        showSystemMessage(`✓ Inhalt aktualisiert: ${c?.name || containerId} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'add_container': {
        ensureRoom(action.room);
        const parentId = action.path && action.path.length > 0 ? action.path[action.path.length - 1] : null;
        if (parentId && Brain.getContainer(action.room, parentId)) {
          Brain.addChildContainer(action.room, parentId, action.id, action.name || action.id, action.typ || 'sonstiges');
        } else {
          Brain.addContainer(action.room, action.id, action.name || action.id, action.typ || 'sonstiges');
        }
        const r = Brain.getRoom(action.room);
        showSystemMessage(`✓ Neuer Bereich: ${action.name || action.id} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'delete_container': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        const containerName = c.name;
        Brain.deleteContainer(action.room, containerId);
        showSystemMessage(`✓ ${containerName} gelöscht (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'rename_container': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        const oldName = c.name;
        Brain.renameContainer(action.room, containerId, action.new_name);
        showSystemMessage(`✓ ${oldName} umbenannt zu ${action.new_name} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'delete_room': {
        const r = Brain.getRoom(action.room);
        if (!r) return;
        const roomName = r.name;
        Brain.deleteRoom(action.room);
        showSystemMessage(`✓ Raum ${roomName} gelöscht`);
        renderBrainView();
        break;
      }
    }
  } catch (err) { debugLog(`Aktion fehlgeschlagen: ${err.message}`); }
}

// Displays a small system confirmation message in the chat
function showSystemMessage(text) {
  const messages = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg chat-msg--system';
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

// Alias used by the ACTION marker system
function appendSystemMessage(text) {
  showSystemMessage(text);
}

// ── PHOTO PROOF BUTTONS (for found items) ──────────────

// Renders photo proof buttons under a chat message element
// foundItems now use ORDO format: { type: 'found', room, path, item }
async function renderFoundPhotoButtons(msgDiv, foundItems) {
  if (!foundItems || foundItems.length === 0) return;

  const btnContainer = document.createElement('div');
  btnContainer.className = 'chat-proof-buttons';

  for (const found of foundItems) {
    const containerId = resolveContainerFromPath(found.room, found.path);
    if (!containerId) continue;
    const photoInfo = await Brain.findBestPhoto(found.room, containerId);
    if (!photoInfo) continue;

    const btn = document.createElement('button');
    btn.className = 'chat-proof-btn';

    // Build label
    const room = Brain.getRoom(found.room);
    const container = Brain.getContainer(found.room, containerId);
    const locationName = container?.name || containerId;

    // Date info
    let dateLabel = '';
    let isOld = false;
    let isVeryOld = false;
    if (photoInfo.timestamp) {
      const photoDate = new Date(photoInfo.timestamp);
      const now = new Date();
      const diffDays = Math.floor((now - photoDate) / (1000 * 60 * 60 * 24));

      if (diffDays > 90) {
        isVeryOld = true;
        const months = Math.floor(diffDays / 30);
        dateLabel = `\u26A0\uFE0F vor ${months} Monaten \u2013 evtl. nicht mehr aktuell`;
      } else if (diffDays > 30) {
        isOld = true;
        const months = Math.floor(diffDays / 30);
        dateLabel = `vor ${months} Monat${months > 1 ? 'en' : ''} aufgenommen`;
      } else {
        dateLabel = `aufgenommen am ${photoDate.toLocaleDateString('de-DE')}`;
      }
    }

    btn.innerHTML = `\uD83D\uDCF7 ${foundItems.length > 1 ? locationName + ' ansehen' : 'Foto ansehen'}`;
    if (dateLabel) {
      const dateSpan = document.createElement('span');
      dateSpan.className = 'chat-proof-date' + (isVeryOld ? ' chat-proof-date--old' : isOld ? ' chat-proof-date--warn' : '');
      dateSpan.textContent = `  \u00B7  ${dateLabel}`;
      btn.appendChild(dateSpan);
    }

    btn.addEventListener('click', () => {
      showProofLightbox(photoInfo.blob, photoInfo.timestamp, found.room, containerId, found.item);
    });

    btnContainer.appendChild(btn);
  }

  if (btnContainer.children.length > 0) {
    msgDiv.after(btnContainer);
    const messages = document.getElementById('chat-messages');
    messages.scrollTop = messages.scrollHeight;
  }
}

// Shows the proof lightbox with photo, date, and action buttons
function showProofLightbox(blob, timestamp, roomId, containerId, itemName) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');

  // Clear previous proof actions
  let proofActions = lb.querySelector('.lightbox-proof-actions');
  if (proofActions) proofActions.remove();
  let proofDate = lb.querySelector('.lightbox-proof-date');
  if (proofDate) proofDate.remove();

  const url = URL.createObjectURL(blob);
  img.src = url;

  // Add date label
  if (timestamp) {
    const dateEl = document.createElement('div');
    dateEl.className = 'lightbox-proof-date';
    const photoDate = new Date(timestamp);
    dateEl.textContent = `Aufgenommen am ${photoDate.toLocaleDateString('de-DE')}`;
    lb.appendChild(dateEl);
  }

  // Add action buttons
  const actionsEl = document.createElement('div');
  actionsEl.className = 'lightbox-proof-actions';

  const newPhotoBtn = document.createElement('button');
  newPhotoBtn.className = 'lightbox-proof-btn';
  newPhotoBtn.textContent = 'Neues Foto machen';
  newPhotoBtn.addEventListener('click', () => {
    closeLightbox();
    // Navigate to photo view with pre-selected room
    showView('photo');
    const roomSelect = document.getElementById('photo-room-select');
    if (roomSelect) roomSelect.value = roomId;
  });

  const wrongBtn = document.createElement('button');
  wrongBtn.className = 'lightbox-proof-btn lightbox-proof-btn--secondary';
  wrongBtn.textContent = 'Stimmt nicht mehr';
  wrongBtn.addEventListener('click', () => {
    closeLightbox();
    // Insert a correction message into the chat
    const input = document.getElementById('chat-input');
    const displayItem = itemName || 'Der Gegenstand';
    input.value = `${displayItem} ist nicht mehr dort.`;
    input.focus();
  });

  actionsEl.appendChild(newPhotoBtn);
  actionsEl.appendChild(wrongBtn);
  lb.appendChild(actionsEl);

  lb.style.display = 'flex';
  requestAnimationFrame(() => lb.classList.add('lightbox--visible'));
}

// ── PHOTO VIEW ─────────────────────────────────────────
function setupPhoto() {
  document.getElementById('photo-camera-btn').addEventListener('click', () => {
    const roomId = document.getElementById('photo-room-select').value;
    if (!roomId) { showPhotoStatus('Bitte zuerst einen Raum wählen.', 'error'); return; }
    const customName = document.getElementById('photo-custom-name').value.trim();
    const containerId = customName ? Brain.slugify(customName) : 'inhalt';
    stagingTarget = { roomId, containerId, containerName: customName, mode: 'add' };
    showStagingOverlay(customName ? `📷 ${customName}` : '📷 Fotos sammeln');
    document.getElementById('photo-input-camera').click();
  });
  document.getElementById('photo-gallery-btn').addEventListener('click', () => {
    const roomId = document.getElementById('photo-room-select').value;
    if (!roomId) { showPhotoStatus('Bitte zuerst einen Raum wählen.', 'error'); return; }
    const customName = document.getElementById('photo-custom-name').value.trim();
    const containerId = customName ? Brain.slugify(customName) : 'inhalt';
    stagingTarget = { roomId, containerId, containerName: customName, mode: 'add' };
    showStagingOverlay(customName ? `📷 ${customName}` : '📷 Fotos sammeln');
    document.getElementById('photo-input-gallery').click();
  });
  // Both hidden inputs feed into the staging area
  document.getElementById('photo-input-camera').addEventListener('change', e => {
    if (e.target.files[0]) addFileToStaging(e.target.files[0]);
    else if (stagedPhotos.length === 0) closeStagingOverlay();
    e.target.value = '';
  });
  document.getElementById('photo-input-gallery').addEventListener('change', e => {
    if (e.target.files[0]) addFileToStaging(e.target.files[0]);
    else if (stagedPhotos.length === 0) closeStagingOverlay();
    e.target.value = '';
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
  if (!nfcContext) {
    if (hint) hint.style.display = 'none';
    return;
  }

  const room = Brain.getRoom(nfcContext.room);
  const container = nfcContext.tag ? Brain.getContainer(nfcContext.room, nfcContext.tag) : null;
  const roomName = room?.name || nfcContext.room;
  const containerName = container?.name || nfcContext.tag || '';

  const select = document.getElementById('photo-room-select');
  if (select && nfcContext.room) select.value = nfcContext.room;

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

    showPhotoStatus('Analysiere Foto…', 'loading');

    try {
      // Ensure room exists
      ensureRoom(roomId);

      const systemPrompt = `Analysiere dieses Foto eines Raums oder Möbelstücks.
Wenn du ein Möbelstück mit erkennbaren Unterteilungen siehst (Türen, Schubladen, Fächer, Regalböden), bilde die Hierarchie im JSON ab.
Ein Behälter kann Unterbehälter haben. Nutze das Feld "behaelter" rekursiv.
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

      const raw = await callGemini(apiKey, systemPrompt, messages);

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
      } catch { /* photo save failed silently */ }

      // New flow (main photo view only): hotspot picking view
      if (!targetRoomId) {
        const photoDataUrl = e.target.result;
        showPhotoStatus('Erkenne Gegenstände im Foto…', 'loading');
        try {
          const hotspotsData = await analyzeHotspots(apiKey, base64, mimeType);
          // Ensure container exists for items to be saved into
          if (!Brain.getContainer(roomId, primaryContainerId)) {
            const containerName = customName || analysis.behaelter?.[0]?.name || 'Inhalt';
            Brain.addContainer(roomId, primaryContainerId, containerName, 'sonstiges', [], true);
          }
          showPickingView(roomId, primaryContainerId, photoDataUrl, hotspotsData);
          document.getElementById('photo-status').style.display = 'none';
        } catch {
          // Fallback: old behavior with chat follow-up questions
          processPhotoAnalysisResult(roomId, analysis);
          showPhotoStatus(`Ich habe ${count} Bereiche gelernt.`, 'success');
          renderBrainView();
        }
      } else {
        showPhotoStatus(`Ich habe ${count} Bereiche gelernt.`, 'success');
        renderBrainView();
      }
    } catch (err) {
      showPhotoStatus(getErrorMessage(err), 'error');
    }
  };
  reader.readAsDataURL(file);
}

function showPhotoStatus(msg, type) {
  const el = document.getElementById('photo-status');
  el.textContent = msg;
  el.className = `photo-status photo-status--${type}`;
  el.style.display = 'block';
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
async function analyzeHotspots(apiKey, base64, mimeType) {
  const systemPrompt = `Analysiere dieses Foto eines Aufbewahrungsorts. Identifiziere einzelne, klar unterscheidbare Gegenstände.
WICHTIG: Versuche NICHT alles zu erkennen. Nur Dinge die du mit Sicherheit als einzelnes Objekt identifizieren kannst.
Antworte NUR mit JSON:
{
  "hotspots": [
    {
      "id": "obj_1",
      "vermutung": "menschlicher Name, z.B. weißes USB-Netzteil",
      "konfidenz": "hoch",
      "position": { "x": 0.5, "y": 0.3 }
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
- Bei komplettem Chaos: Wenige markante Dinge rauspicken`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
      { type: 'text', text: 'Analysiere die Gegenstände in diesem Foto.' }
    ]
  }];

  const raw = await callGemini(apiKey, systemPrompt, messages);
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
    if (isConfirmed) dot.classList.add('picking-hotspot--confirmed');
    if (activeId === hs.id) dot.classList.add('picking-hotspot--active');

    dot.style.left = `${offsetX + hs.position.x * renderW}px`;
    dot.style.top = `${offsetY + hs.position.y * renderH}px`;

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

  labelEl.textContent = existing
    ? 'Bestätigt – Name ändern:'
    : (hs?.vermutung ? `KI-Vorschlag: "${hs.vermutung}"` : 'Was ist das?');
  input.value = existing ? existing.name : (hs?.vermutung || '');

  panel.style.display = 'flex';
  input.focus();
  input.select();
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
    } catch { /* crop failed silently */ }
  }

  // Save item to brain
  Brain.addItem(roomId, containerId, name);

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
  document.getElementById('staging-add-btn').addEventListener('click', () => {
    document.getElementById('staging-photo-input').click();
  });
  document.getElementById('staging-photo-input').addEventListener('change', e => {
    if (e.target.files[0]) addFileToStaging(e.target.files[0]);
    else if (stagedPhotos.length === 0) closeStagingOverlay();
    e.target.value = '';
  });
  document.getElementById('staging-analyze-btn').addEventListener('click', analyzeAllStagedPhotos);
}

function showStagingOverlay(title) {
  stagedPhotos = [];
  document.getElementById('staging-thumbnails').innerHTML = '';
  document.getElementById('staging-analyze-btn').disabled = true;
  document.getElementById('staging-analyze-btn').textContent = 'Analysieren';
  document.getElementById('staging-title').textContent = title || 'Fotos sammeln';
  document.getElementById('staging-hint').style.display = 'none';
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
    document.getElementById('staging-analyze-btn').disabled = false;
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
    const img = document.createElement('img');
    img.src = photo.previewUrl;
    img.alt = `Foto ${index + 1}`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'staging-thumb-remove';
    removeBtn.textContent = '✕';
    removeBtn.setAttribute('aria-label', `Foto ${index + 1} entfernen`);
    removeBtn.addEventListener('click', () => {
      stagedPhotos.splice(index, 1);
      renderStagingThumbnails();
      document.getElementById('staging-analyze-btn').disabled = stagedPhotos.length === 0;
    });
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
    ensureRoomExists(roomId);

    const photoCount = stagedPhotos.length;
    const systemPrompt = `Analysiere ${photoCount > 1 ? 'alle ' + photoCount + ' Fotos zusammen' : 'dieses Foto'}.
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
- hinweis nur setzen wenn wirklich hilfreich (z.B. "Dinge liegen übereinander – einzeln fotografieren hilft")` + (nfcContext?.tag ? `\nKontext: Der Nutzer steht vor "${Brain.getContainer(nfcContext.room, nfcContext.tag)?.name || nfcContext.tag}". Das Foto zeigt vermutlich einen Teil dieses Möbelstücks.` : '');

    const imageContents = stagedPhotos.map(p => ({
      type: 'image',
      source: { type: 'base64', media_type: p.mimeType, data: p.base64 }
    }));
    const textContent = {
      type: 'text',
      text: containerName ? `Inhalt von: ${containerName}` : 'Analysiere die Gegenstände.'
    };

    const messages = [{ role: 'user', content: [...imageContents, textContent] }];
    const raw = await callGemini(apiKey, systemPrompt, messages);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Kein JSON in Antwort');

    const analysis = JSON.parse(jsonMatch[0]);
    const items = (analysis.inhalt || []).map((item, i) => ({
      id: `item_${i}`,
      name: typeof item === 'string' ? item : (item.name || ''),
      menge: typeof item === 'string' ? 1 : Math.max(1, parseInt(item.menge) || 1),
      checked: true
    })).filter(item => item.name.trim());

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
    } catch { /* photo save failed silently */ }

    const hint = (analysis.hinweis || '').trim();
    const isOnboarding = stagingTarget?.onboardingFlow;
    closeStagingOverlay();
    showReviewPopup(roomId, containerId, containerName, items, mode || 'add', hint || null, isOnboarding);

  } catch (err) {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Analysieren';
    showToast(getErrorMessage(err), 'error');
  }
}

// ensureRoomExists → alias for ensureRoom (backwards compat)
function ensureRoomExists(roomId) { ensureRoom(roomId); }

// ── REVIEW OVERLAY ─────────────────────────────────────
function setupReviewOverlay() {
  document.getElementById('review-confirm').addEventListener('click', confirmReview);
  document.getElementById('review-cancel').addEventListener('click', closeReviewPopup);
  document.getElementById('review-add-manual').addEventListener('click', addManualReviewItem);
}

function showReviewPopup(roomId, containerId, containerName, items, mode, hinweis, onboardingFlow) {
  reviewState = { roomId, containerId, containerName, items: items.map(i => ({ ...i })), mode, onboardingFlow };
  renderReviewList();

  const subtitleEl = document.getElementById('review-subtitle');
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

function closeReviewPopup() {
  document.getElementById('review-overlay').style.display = 'none';
  reviewState = null;
}

function confirmReview() {
  if (!reviewState) return;
  const { roomId, containerId, containerName, items, mode } = reviewState;
  const isOnboarding = reviewState.onboardingFlow;

  ensureRoomExists(roomId);
  if (!Brain.getContainer(roomId, containerId)) {
    Brain.addContainer(roomId, containerId, containerName || containerId, 'sonstiges', [], true);
  }

  // In replace mode: clear existing items first
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
  } else if (currentView === 'brain') {
    showBrainToast(`${count} ${count === 1 ? 'Gegenstand' : 'Gegenstände'} übernommen`);
  } else {
    showPhotoStatus(
      `${count} ${count === 1 ? 'Gegenstand' : 'Gegenstände'} in "${containerDisplayName}" übernommen.`,
      'success'
    );
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

function showBrainToast(msg) {
  const existing = document.getElementById('brain-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'brain-toast';
  toast.className = 'brain-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── BRAIN VIEW ─────────────────────────────────────────
function setupBrain() {
  document.getElementById('brain-add-room').addEventListener('click', showAddRoomDialog);

  // Lightbox close
  const lb = document.getElementById('lightbox');
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
}

function renderBrainView() {
  const container = document.getElementById('brain-tree');
  const rooms = Brain.getRooms();
  container.innerHTML = '';

  // Hide breadcrumb when rendering full view
  const breadcrumb = document.getElementById('brain-breadcrumb');
  if (breadcrumb) breadcrumb.style.display = 'none';

  if (Object.keys(rooms).length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'brain-empty-cta';
    const ctaIcon = document.createElement('span');
    ctaIcon.className = 'brain-empty-cta-icon';
    ctaIcon.textContent = '🏠';
    const ctaText = document.createElement('p');
    ctaText.className = 'brain-empty-cta-text';
    ctaText.textContent = 'Dein Zuhause ist noch leer. Starte mit einem Foto von einem Schrank, Regal oder einer Schublade.';
    emptyEl.appendChild(ctaIcon);
    emptyEl.appendChild(ctaText);
    const btn = document.createElement('button');
    btn.className = 'brain-empty-cta-btn';
    btn.textContent = '📷 Erstes Foto machen';
    btn.addEventListener('click', () => showView('photo'));
    emptyEl.appendChild(btn);
    container.appendChild(emptyEl);
    return;
  }

  for (const [roomId, room] of Object.entries(rooms)) {
    container.appendChild(buildRoomNode(roomId, room));
  }
}

function buildRoomNode(roomId, room) {
  const roomEl = document.createElement('div');
  roomEl.className = 'brain-room';

  const totalContainers = Brain.countContainers(room.containers);

  const header = document.createElement('div');
  header.className = 'brain-room-header';
  const emojiSpanR = document.createElement('span');
  emojiSpanR.className = 'brain-room-emoji';
  emojiSpanR.textContent = room.emoji;
  const nameSpanR = document.createElement('span');
  nameSpanR.className = 'brain-room-name';
  nameSpanR.textContent = room.name;
  const countSpanR = document.createElement('span');
  countSpanR.className = 'brain-room-count';
  countSpanR.textContent = totalContainers;
  header.appendChild(emojiSpanR);
  header.appendChild(nameSpanR);
  header.appendChild(countSpanR);

  let open = true;
  const body = document.createElement('div');
  body.className = 'brain-room-body';

  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? 'block' : 'none';
    header.classList.toggle('collapsed', !open);
  });

  // Long press to rename/delete
  setupLongPress(header, () => showRoomContextMenu(roomId, room));

  if (totalContainers === 0) {
    const empty = document.createElement('p');
    empty.className = 'brain-empty-room';
    empty.textContent = 'Noch nichts erfasst – mach ein Foto.';
    body.appendChild(empty);
  } else {
    for (const [cId, c] of Object.entries(room.containers || {})) {
      body.appendChild(buildContainerNode(roomId, cId, c, 0));
    }
  }

  // Add container button
  const addBtn = document.createElement('button');
  addBtn.className = 'brain-add-btn';
  addBtn.textContent = '+ Bereich hinzufügen';
  addBtn.addEventListener('click', () => showAddContainerDialog(roomId));
  body.appendChild(addBtn);

  roomEl.appendChild(header);
  roomEl.appendChild(body);
  return roomEl;
}

function buildContainerNode(roomId, cId, c, depth) {
  const el = document.createElement('div');
  const hasItems = c.items?.length > 0;
  const hasChildren = c.containers && Object.keys(c.containers).length > 0;
  el.className = `brain-container ${hasItems ? 'has-items' : 'empty'}`;
  if (depth > 0) {
    el.classList.add('brain-container--nested');
    el.style.marginLeft = `${depth * 18}px`;
  }
  if (depth > 0) {
    el.classList.add('brain-container--depth-' + Math.min(depth, 3));
  }

  const typIcon = { schrank: '🗄️', regal: '📚', schublade: '🗃️', kiste: '📦', tisch: '🪑', tuer: '🚪', fach: '📚', sonstiges: '📋' };
  const icon = typIcon[c.typ] || '📋';

  const header = document.createElement('div');
  header.className = 'brain-container-header';

  const headerLeft = document.createElement('span');
  headerLeft.textContent = `${icon} ${c.name}`;
  if (hasChildren) {
    const childCount = document.createElement('span');
    childCount.className = 'brain-container-child-count';
    childCount.textContent = `${Object.keys(c.containers).length}`;
    headerLeft.appendChild(childCount);
  }

  const headerRight = document.createElement('small');
  headerRight.textContent = c.last_updated ? Brain.formatDate(c.last_updated) : '';

  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  let open = false;
  const body = document.createElement('div');
  body.className = 'brain-container-body';
  body.style.display = 'none';

  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? 'block' : 'none';
    header.classList.toggle('brain-container-header--open', open);
    if (open) {
      loadThumbnail(roomId, cId, c, thumbnailWrapper);
      updateBreadcrumb(roomId, cId);
    }
  });

  setupLongPress(header, () => showContainerContextMenu(roomId, cId, c));

  // Thumbnail area
  const thumbnailWrapper = document.createElement('div');
  thumbnailWrapper.className = 'brain-thumbnail-wrapper';

  // Photo history hint
  const photoHistoryHint = document.createElement('div');
  photoHistoryHint.className = 'brain-photo-history-hint';
  photoHistoryHint.style.display = 'none';

  // Items as chips
  const chips = document.createElement('div');
  chips.className = 'brain-chips';

  (c.items || []).forEach(item => {
    const chip = document.createElement('span');
    chip.className = 'brain-chip';
    const qty = c.quantities?.[item];
    chip.textContent = qty > 1 ? `${qty}x ${item}` : item;
    chip.addEventListener('click', () => {
      showView('chat');
      const input = document.getElementById('chat-input');
      input.value = `Wo ist die ${item}?`;
      setTimeout(() => sendChatMessage(), 100);
    });
    chips.appendChild(chip);
  });

  // Uncertain items (from inhalt_unsicher) shown with "?" badge
  (c.uncertain_items || []).forEach(item => {
    const chip = document.createElement('span');
    chip.className = 'brain-chip brain-chip--uncertain';
    chip.textContent = `${item} ?`;
    chip.title = 'Noch nicht bestätigt';
    chip.addEventListener('click', () => {
      showView('chat');
      const input = document.getElementById('chat-input');
      input.value = `Ist "${item}" wirklich in "${c.name}"?`;
      setTimeout(() => sendChatMessage(), 100);
    });
    chips.appendChild(chip);
  });

  // Child containers (recursive)
  const childrenWrapper = document.createElement('div');
  childrenWrapper.className = 'brain-children';
  if (hasChildren) {
    for (const [childId, child] of Object.entries(c.containers)) {
      childrenWrapper.appendChild(buildContainerNode(roomId, childId, child, depth + 1));
    }
  }

  // Add item button
  const addItemBtn = document.createElement('button');
  addItemBtn.className = 'brain-add-item-btn';
  addItemBtn.textContent = '+ Gegenstand';
  addItemBtn.addEventListener('click', async () => {
    const result = await showInputModal({
      title: 'Gegenstand hinzufügen',
      fields: [{ placeholder: 'Name des Gegenstands' }]
    });
    if (result && result[0]?.trim()) {
      Brain.addItem(roomId, cId, result[0].trim());
      renderBrainView();
    }
  });

  // Add child container button
  const addChildBtn = document.createElement('button');
  addChildBtn.className = 'brain-add-item-btn';
  addChildBtn.textContent = '+ Bereich darunter';
  addChildBtn.addEventListener('click', () => {
    showAddChildContainerDialog(roomId, cId);
  });

  // Camera button – opens staging overlay for this container
  const cameraItemBtn = document.createElement('button');
  cameraItemBtn.className = 'brain-camera-item-btn';
  cameraItemBtn.innerHTML = '📷 Foto';
  cameraItemBtn.title = 'Foto machen und Inhalt per KI erkennen';
  cameraItemBtn.addEventListener('click', e => {
    e.stopPropagation();
    openCameraForContainer(roomId, cId);
  });

  const btnRow = document.createElement('div');
  btnRow.className = 'brain-item-btn-row';
  btnRow.appendChild(addItemBtn);
  btnRow.appendChild(addChildBtn);
  btnRow.appendChild(cameraItemBtn);

  body.appendChild(thumbnailWrapper);
  body.appendChild(photoHistoryHint);
  body.appendChild(chips);
  body.appendChild(childrenWrapper);
  body.appendChild(btnRow);
  el.appendChild(header);
  el.appendChild(body);
  return el;
}

async function loadThumbnail(roomId, cId, c, wrapper) {
  // Only render once
  if (wrapper.dataset.loaded) return;
  wrapper.dataset.loaded = '1';

  const photoKey = Brain.getLatestPhotoKey(roomId, cId);
  let blob = null;
  try {
    blob = await Brain.getPhoto(photoKey);
    // Fallback to legacy key
    if (!blob) blob = await Brain.getPhoto(`${roomId}_${cId}`);
  } catch { /* IndexedDB not available */ }

  if (blob) {
    const objectUrl = URL.createObjectURL(blob);
    const div = document.createElement('div');
    div.className = 'brain-thumbnail';
    const img = document.createElement('img');
    img.src = objectUrl;
    img.alt = c.name;
    img.addEventListener('click', () => showLightbox(objectUrl));
    div.appendChild(img);
    wrapper.appendChild(div);

    // Show photo history hint
    const history = Brain.getPhotoHistory(roomId, cId);
    if (history.length > 1) {
      const hintEl = wrapper.parentElement.querySelector('.brain-photo-history-hint');
      if (hintEl) {
        const lastDate = Brain.formatDate(new Date(history[history.length - 1]).getTime());
        hintEl.textContent = `📷 ${history.length} Fotos  ·  zuletzt ${lastDate}`;
        hintEl.style.display = 'block';
        hintEl.style.cursor = 'pointer';
        hintEl.addEventListener('click', () => showPhotoTimeline(roomId, cId));
      }
    }
  } else {
    // Placeholder
    const div = document.createElement('div');
    div.className = 'brain-thumbnail-empty';
    const emptyIcon = document.createElement('span');
    emptyIcon.textContent = '📷';
    const emptyText = document.createElement('p');
    emptyText.textContent = 'Noch kein Foto. Tippe hier um zu scannen.';
    div.appendChild(emptyIcon);
    div.appendChild(emptyText);
    div.addEventListener('click', () => openCameraForContainer(roomId, cId));
    wrapper.appendChild(div);
  }
}

// ── BREADCRUMB NAVIGATION ──────────────────────────────
function updateBreadcrumb(roomId, containerId) {
  const breadcrumb = document.getElementById('brain-breadcrumb');
  if (!breadcrumb) return;

  const room = Brain.getRoom(roomId);
  if (!room) return;

  const path = Brain.getContainerPath(roomId, containerId);
  if (path.length === 0) {
    breadcrumb.style.display = 'none';
    return;
  }

  breadcrumb.innerHTML = '';
  breadcrumb.style.display = 'flex';

  // Room
  const roomSpan = document.createElement('span');
  roomSpan.className = 'brain-breadcrumb-item';
  roomSpan.textContent = `${room.emoji} ${room.name}`;
  roomSpan.addEventListener('click', () => {
    breadcrumb.style.display = 'none';
  });
  breadcrumb.appendChild(roomSpan);

  // Container path
  path.forEach((cId, idx) => {
    const sep = document.createElement('span');
    sep.className = 'brain-breadcrumb-sep';
    sep.textContent = '>';
    breadcrumb.appendChild(sep);

    const c = Brain.getContainer(roomId, cId);
    const span = document.createElement('span');
    span.className = 'brain-breadcrumb-item';
    if (idx === path.length - 1) span.classList.add('brain-breadcrumb-item--active');
    span.textContent = c?.name || cId;
    breadcrumb.appendChild(span);
  });
}

// ── NFC CONTEXT VIEW ──────────────────────────────────
let nfcCtxInactivityTimer = null;

function setupNfcContextView() {
  document.getElementById('nfc-ctx-back').addEventListener('click', () => {
    clearNfcCtxInactivityTimer();
    showView('chat');
  });

  document.getElementById('nfc-ctx-chat-btn').addEventListener('click', () => {
    clearNfcCtxInactivityTimer();
    showView('chat');
  });

  document.getElementById('nfc-ctx-photo-btn').addEventListener('click', () => {
    document.getElementById('nfc-ctx-photo-input').click();
  });

  document.getElementById('nfc-ctx-photo-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file || !nfcContext) return;

    const roomId = nfcContext.room;
    const containerId = nfcContext.tag;
    if (!roomId || !containerId) return;

    // Ensure room and container exist
    ensureRoom(roomId);
    if (!Brain.getContainer(roomId, containerId)) {
      Brain.addContainer(roomId, containerId, containerId, 'sonstiges');
    }

    const containerName = Brain.getContainer(roomId, containerId)?.name || containerId;

    // Open staging/review workflow
    stagingTarget = {
      roomId,
      containerId,
      containerName,
      mode: 'update'
    };

    showStagingOverlay(`📷 ${containerName}`);
    await addFileToStaging(file);
    e.target.value = '';
  });

  // Touch/click resets inactivity timer
  const nfcView = document.getElementById('view-nfc-context');
  nfcView.addEventListener('click', resetNfcCtxInactivityTimer);
  nfcView.addEventListener('touchstart', resetNfcCtxInactivityTimer);
}

function clearNfcCtxInactivityTimer() {
  if (nfcCtxInactivityTimer) {
    clearTimeout(nfcCtxInactivityTimer);
    nfcCtxInactivityTimer = null;
  }
}

function resetNfcCtxInactivityTimer() {
  clearNfcCtxInactivityTimer();
  nfcCtxInactivityTimer = setTimeout(() => {
    if (currentView === 'nfc-context') {
      showView('chat');
    }
  }, 60000); // 1 minute inactivity → back to chat
}

async function renderNfcContextView() {
  if (!nfcContext) return;

  const roomId = nfcContext.room;
  const containerId = nfcContext.tag;
  const room = Brain.getRoom(roomId);
  const container = containerId ? Brain.getContainer(roomId, containerId) : null;

  // Room label
  const roomLabel = document.getElementById('nfc-ctx-room-label');
  roomLabel.textContent = room ? `${room.emoji} ${room.name}` : roomId;

  // Container name
  const containerNameEl = document.getElementById('nfc-ctx-container-name');
  const typeEmoji = getContainerTypeEmoji(container?.typ);
  containerNameEl.textContent = container ? `${typeEmoji} ${container.name}` : (containerId || '');

  // Photo
  const photoArea = document.getElementById('nfc-ctx-photo-area');
  const photoImg = document.getElementById('nfc-ctx-photo');
  const photoDate = document.getElementById('nfc-ctx-photo-date');
  const emptyArea = document.getElementById('nfc-ctx-empty');
  const itemsArea = document.getElementById('nfc-ctx-items');
  const childrenArea = document.getElementById('nfc-ctx-children');

  photoArea.style.display = 'none';
  emptyArea.style.display = 'none';
  itemsArea.style.display = 'none';
  childrenArea.style.display = 'none';

  const hasItems = container?.items?.length > 0;
  const hasChildren = container?.containers && Object.keys(container.containers).length > 0;
  const hasContent = hasItems || hasChildren;

  // Show photo if available
  if (containerId) {
    const photoInfo = await Brain.findBestPhoto(roomId, containerId);
    if (photoInfo?.blob) {
      const url = URL.createObjectURL(photoInfo.blob);
      photoImg.src = url;
      photoArea.style.display = 'block';
      if (photoInfo.timestamp) {
        const d = new Date(photoInfo.timestamp);
        photoDate.textContent = `📷 Foto (${d.toLocaleDateString('de-DE')})`;
      } else {
        photoDate.textContent = '';
      }
      // Click photo for lightbox
      photoImg.onclick = () => {
        const lb = document.getElementById('lightbox');
        document.getElementById('lightbox-img').src = url;
        lb.style.display = 'flex';
        requestAnimationFrame(() => lb.classList.add('lightbox--visible'));
      };
    }
  }

  // Items
  if (hasItems) {
    itemsArea.style.display = 'block';
    const chipsEl = document.getElementById('nfc-ctx-item-chips');
    chipsEl.innerHTML = '';
    container.items.forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'nfc-ctx-chip';
      const qty = container.quantities?.[item];
      chip.textContent = qty > 1 ? `${qty}x ${item}` : item;
      chipsEl.appendChild(chip);
    });
  }

  // Child containers
  if (hasChildren) {
    childrenArea.style.display = 'block';
    const listEl = document.getElementById('nfc-ctx-children-list');
    listEl.innerHTML = '';
    for (const [childId, child] of Object.entries(container.containers)) {
      const row = document.createElement('button');
      row.className = 'nfc-ctx-child-row';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${getContainerTypeEmoji(child.typ)} ${child.name}`;

      const arrow = document.createElement('span');
      arrow.className = 'nfc-ctx-child-arrow';
      arrow.textContent = '▸';

      row.appendChild(nameSpan);
      row.appendChild(arrow);

      row.addEventListener('click', () => {
        // Navigate into child container
        nfcContext = { room: roomId, tag: childId };
        renderNfcContextView();
      });

      listEl.appendChild(row);
    }
  }

  // Empty state
  if (!hasContent && !(await Brain.findBestPhoto(roomId, containerId))) {
    emptyArea.style.display = 'block';
    emptyArea.innerHTML = `
      <p class="nfc-ctx-empty-text">Dieser Bereich ist noch leer.</p>
      <p class="nfc-ctx-empty-hint">Mach ein Foto vom geöffneten Bereich und ich merke mir was drin ist.</p>
    `;
    document.getElementById('nfc-ctx-photo-btn-label').textContent = '📷 Erstes Foto machen';
  } else {
    document.getElementById('nfc-ctx-photo-btn-label').textContent = '📷 Foto aktualisieren';
  }

  // Start inactivity timer
  resetNfcCtxInactivityTimer();
}

function getContainerTypeEmoji(typ) {
  const map = { schrank: '🗄️', regal: '📚', schublade: '🗃️', kiste: '📦', tisch: '🪑' };
  return map[typ] || '📦';
}

// ── PHOTO TIMELINE ─────────────────────────────────────
function setupPhotoTimeline() {
  document.getElementById('photo-timeline-close').addEventListener('click', closePhotoTimeline);
}

async function showPhotoTimeline(roomId, containerId) {
  const overlay = document.getElementById('photo-timeline-overlay');
  const grid = document.getElementById('photo-timeline-grid');
  grid.innerHTML = '';

  const history = Brain.getPhotoHistory(roomId, containerId);
  if (history.length === 0) return;

  overlay.style.display = 'flex';

  for (const ts of history) {
    const photoKey = `${roomId}_${containerId}_${ts}`;
    try {
      const blob = await Brain.getPhoto(photoKey);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const card = document.createElement('div');
      card.className = 'photo-timeline-card';

      const img = document.createElement('img');
      img.src = url;
      img.alt = ts;
      img.addEventListener('click', () => showLightbox(url));

      const date = document.createElement('span');
      date.className = 'photo-timeline-date';
      date.textContent = Brain.formatDate(new Date(ts).getTime());

      const isLatest = ts === history[history.length - 1];
      if (isLatest) {
        const badge = document.createElement('span');
        badge.className = 'photo-timeline-badge';
        badge.textContent = 'aktuell';
        card.appendChild(badge);
      }

      card.appendChild(img);
      card.appendChild(date);
      grid.appendChild(card);
    } catch { /* skip */ }
  }
}

function closePhotoTimeline() {
  document.getElementById('photo-timeline-overlay').style.display = 'none';
}

// ── MOVE CONTAINER OVERLAY ─────────────────────────────
function setupMoveContainerOverlay() {
  document.getElementById('move-container-close').addEventListener('click', closeMoveContainerOverlay);
  document.getElementById('move-container-cancel').addEventListener('click', closeMoveContainerOverlay);
}

function showMoveContainerOverlay(roomId, containerId) {
  moveContainerState = { roomId, containerId };
  const overlay = document.getElementById('move-container-overlay');
  const list = document.getElementById('move-container-list');
  list.innerHTML = '';

  const container = Brain.getContainer(roomId, containerId);
  const containerName = container?.name || containerId;

  // Option: move to room root
  const rootItem = document.createElement('button');
  rootItem.className = 'move-container-item';
  rootItem.textContent = `🏠 Raum-Ebene (${Brain.getRoom(roomId)?.name || roomId})`;
  rootItem.addEventListener('click', () => {
    Brain.moveContainer(roomId, containerId, null);
    closeMoveContainerOverlay();
    renderBrainView();
    showBrainToast(`${containerName} verschoben`);
  });
  list.appendChild(rootItem);

  // All other containers as potential parents
  const allContainers = Brain.getAllContainersFlat(roomId, containerId);
  allContainers.forEach(({ id, name, path }) => {
    const item = document.createElement('button');
    item.className = 'move-container-item';
    item.textContent = path;
    item.addEventListener('click', () => {
      Brain.moveContainer(roomId, containerId, id);
      closeMoveContainerOverlay();
      renderBrainView();
      showBrainToast(`${containerName} verschoben nach ${name}`);
    });
    list.appendChild(item);
  });

  overlay.style.display = 'flex';
}

function closeMoveContainerOverlay() {
  document.getElementById('move-container-overlay').style.display = 'none';
  moveContainerState = null;
}

// ── ADD CHILD CONTAINER ────────────────────────────────
async function showAddChildContainerDialog(roomId, parentId) {
  const result = await showInputModal({
    title: 'Unterbereich hinzufügen',
    fields: [
      { label: 'Name', placeholder: 'z.B. "Schublade oben", "Linke Tür"' },
      { label: 'Typ', type: 'select', defaultValue: 'sonstiges', options: [
        { value: 'schublade', label: 'Schublade' }, { value: 'fach', label: 'Fach' },
        { value: 'tuer', label: 'Tür' }, { value: 'kiste', label: 'Kiste' },
        { value: 'regal', label: 'Regal' }, { value: 'sonstiges', label: 'Sonstiges' }
      ]}
    ]
  });
  if (!result || !result[0]?.trim()) return;
  const id = Brain.slugify(result[0].trim());
  Brain.addChildContainer(roomId, parentId, id, result[0].trim(), result[1] || 'sonstiges');
  renderBrainView();
}

function openCameraForContainer(roomId, cId) {
  const container = Brain.getContainer(roomId, cId);
  const containerName = container?.name || cId;
  stagingTarget = { roomId, containerId: cId, containerName, mode: 'add' };
  showStagingOverlay(`📷 ${containerName}`);
  document.getElementById('staging-photo-input').click();
}

function showLightbox(src) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  img.src = src;
  lb.style.display = 'flex';
  requestAnimationFrame(() => lb.classList.add('lightbox--visible'));
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.classList.remove('lightbox--visible');
  setTimeout(() => {
    lb.style.display = 'none';
    const img = document.getElementById('lightbox-img');
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = '';
    // Clean up proof lightbox elements
    const proofActions = lb.querySelector('.lightbox-proof-actions');
    if (proofActions) proofActions.remove();
    const proofDate = lb.querySelector('.lightbox-proof-date');
    if (proofDate) proofDate.remove();
  }, 200);
}

async function showAddRoomDialog() {
  const result = await showInputModal({
    title: 'Raum hinzufügen',
    fields: [
      { label: 'Name', placeholder: 'z.B. Küche, Schlafzimmer' },
      { label: 'Emoji', placeholder: '🏠', defaultValue: '🏠' }
    ]
  });
  if (!result || !result[0]?.trim()) return;
  const id = Brain.slugify(result[0].trim());
  Brain.addRoom(id, result[0].trim(), result[1] || '🏠');
  renderBrainView();
}

async function showAddContainerDialog(roomId) {
  const result = await showInputModal({
    title: 'Bereich hinzufügen',
    fields: [
      { label: 'Name', placeholder: 'z.B. "Schrank links neben Tür"' },
      { label: 'Typ', type: 'select', defaultValue: 'sonstiges', options: [
        { value: 'schrank', label: 'Schrank' }, { value: 'regal', label: 'Regal' },
        { value: 'schublade', label: 'Schublade' }, { value: 'kiste', label: 'Kiste' },
        { value: 'tisch', label: 'Tisch' }, { value: 'sonstiges', label: 'Sonstiges' }
      ]}
    ]
  });
  if (!result || !result[0]?.trim()) return;
  const id = Brain.slugify(result[0].trim());
  Brain.addContainer(roomId, id, result[0].trim(), result[1] || 'sonstiges');
  renderBrainView();
}

async function showRoomContextMenu(roomId, room) {
  const result = await showInputModal({
    title: `${room.emoji} ${room.name}`,
    description: 'Was möchtest du tun?',
    fields: [
      { type: 'select', defaultValue: '0', options: [
        { value: '0', label: 'Aktion wählen…' },
        { value: '1', label: 'Umbenennen' },
        { value: '2', label: 'Löschen' }
      ]}
    ]
  });
  if (!result || result[0] === '0') return;
  if (result[0] === '1') {
    const nameResult = await showInputModal({
      title: 'Raum umbenennen',
      fields: [{ label: 'Neuer Name', defaultValue: room.name }]
    });
    if (nameResult && nameResult[0]?.trim()) {
      Brain.renameRoom(roomId, nameResult[0].trim());
      renderBrainView();
    }
  } else if (result[0] === '2') {
    const ok = await showConfirmModal({
      title: 'Raum löschen',
      description: `"${room.name}" und alle Inhalte wirklich löschen?`,
      confirmLabel: 'Löschen',
      danger: true
    });
    if (ok) {
      Brain.deleteRoom(roomId);
      renderBrainView();
    }
  }
}

async function showContainerContextMenu(roomId, cId, c) {
  const result = await showInputModal({
    title: c.name,
    description: 'Was möchtest du tun?',
    fields: [
      { type: 'select', defaultValue: '0', options: [
        { value: '0', label: 'Aktion wählen…' },
        { value: '1', label: 'Umbenennen' },
        { value: '2', label: 'Löschen' },
        { value: '3', label: 'Verschieben' }
      ]}
    ]
  });
  if (!result || result[0] === '0') return;
  if (result[0] === '1') {
    const nameResult = await showInputModal({
      title: 'Bereich umbenennen',
      fields: [{ label: 'Neuer Name', defaultValue: c.name }]
    });
    if (nameResult && nameResult[0]?.trim()) {
      Brain.renameContainer(roomId, cId, nameResult[0].trim());
      renderBrainView();
    }
  } else if (result[0] === '2') {
    const ok = await showConfirmModal({
      title: 'Bereich löschen',
      description: `"${c.name}" und alle Inhalte wirklich löschen?`,
      confirmLabel: 'Löschen',
      danger: true
    });
    if (ok) {
      Brain.deleteContainer(roomId, cId);
      renderBrainView();
    }
  } else if (result[0] === '3') {
    showMoveContainerOverlay(roomId, cId);
  }
}

// ── SETTINGS VIEW ──────────────────────────────────────
function setupSettings() {
  document.getElementById('settings-save-key').addEventListener('click', () => {
    const key = document.getElementById('settings-api-key').value.trim();
    if (key) {
      Brain.setApiKey(key);
      showSettingsMsg('API Key gespeichert.', 'success');
    }
  });

  document.getElementById('settings-export').addEventListener('click', async () => {
    await Brain.exportData(async (sizeMB) => {
      return showConfirmModal({
        title: 'Große Export-Datei',
        description: `Die Export-Datei ist ca. ${sizeMB} MB groß (Fotos enthalten). Trotzdem exportieren?`,
        confirmLabel: 'Exportieren'
      });
    });
  });

  document.getElementById('settings-import').addEventListener('click', () => {
    document.getElementById('settings-import-file').click();
  });

  document.getElementById('settings-import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const ok = await showConfirmModal({
      title: 'Daten importieren',
      description: 'Vorhandene Daten werden überschrieben – fortfahren?',
      confirmLabel: 'Importieren'
    });
    if (!ok) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      const success = await Brain.importData(ev.target.result);
      if (success) {
        showSettingsMsg('Haushalt erfolgreich geladen.', 'success');
        renderBrainView();
      } else {
        showSettingsMsg('Import fehlgeschlagen – ungültiges Format.', 'error');
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('settings-reset').addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Alles zurücksetzen',
      description: 'Wirklich alles zurücksetzen? Alle Daten gehen verloren.',
      confirmLabel: 'Zurücksetzen',
      danger: true
    });
    if (ok) {
      await Brain.resetAll();
      localStorage.removeItem('onboarding_completed');
      document.getElementById('chat-messages').innerHTML = '';
      showSettingsMsg('App zurückgesetzt.', 'success');
    }
  });

  // Debug buttons
  document.getElementById('debug-test-btn').addEventListener('click', async () => {
    const apiKey = Brain.getApiKey();
    if (!apiKey) {
      debugLog('FEHLER: Kein API Key gespeichert!');
      return;
    }
    debugLog('Starte Testanfrage …');
    try {
      const result = await callGemini(apiKey, 'Du bist ein Testassistent.', [
        { role: 'user', content: 'Sag nur "OK".' }
      ]);
      debugLog(`TEST ERFOLGREICH: Antwort = "${result}"`);
    } catch (err) {
      debugLog(`TEST FEHLGESCHLAGEN: ${err.message}`);
    }
  });

  document.getElementById('debug-clear-btn').addEventListener('click', () => {
    const el = document.getElementById('debug-log');
    if (el) el.textContent = '— noch kein Log —';
  });

  // NFC Tag write
  document.getElementById('nfc-write-btn').addEventListener('click', writeNfcTag);
  document.getElementById('nfc-room-select').addEventListener('change', updateNfcPreview);
  document.getElementById('nfc-container-name').addEventListener('input', updateNfcPreview);

  // Settings advanced toggle
  document.getElementById('settings-advanced-toggle').addEventListener('click', () => {
    const body = document.getElementById('settings-advanced-body');
    const toggle = document.getElementById('settings-advanced-toggle');
    if (body.style.display === 'none') {
      body.style.display = 'flex';
      toggle.textContent = 'Erweitert ▴';
    } else {
      body.style.display = 'none';
      toggle.textContent = 'Erweitert ▾';
    }
  });

  // NFC info toggle
  document.getElementById('nfc-info-toggle').addEventListener('click', () => {
    const body = document.getElementById('nfc-info-body');
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  });

  // Photo history limit
  document.getElementById('settings-photo-history-limit').addEventListener('change', e => {
    Brain.setPhotoHistoryLimit(parseInt(e.target.value) || 10);
    showSettingsMsg('Foto-Historie Limit gespeichert.', 'success');
  });

  // Copy NFC URL
  document.getElementById('nfc-copy-btn')?.addEventListener('click', () => {
    const url = document.getElementById('nfc-fallback-url').textContent;
    navigator.clipboard.writeText(url).then(() => showSettingsMsg('URL kopiert.', 'success'));
  });
}

let settingsInitialized = false;

function renderSettings() {
  document.getElementById('settings-api-key').value = Brain.getApiKey();
  renderRoomDropdown('nfc-room-select');
  updateNfcPreview();

  // Set photo history limit
  const limitSel = document.getElementById('settings-photo-history-limit');
  if (limitSel) limitSel.value = String(Brain.getPhotoHistoryLimit());

  // Add "Neuer Raum" option
  const sel = document.getElementById('nfc-room-select');
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ Neuer Raum';
  sel.appendChild(newOpt);

  // Only register event listener once
  if (!settingsInitialized) {
    settingsInitialized = true;
    sel.addEventListener('change', () => {
      const newRoomInput = document.getElementById('nfc-new-room-group');
      if (sel.value === '__new__') {
        newRoomInput.style.display = 'block';
      } else {
        newRoomInput.style.display = 'none';
      }
      updateNfcPreview();
    });
  }
}

function updateNfcPreview() {
  const roomSel = document.getElementById('nfc-room-select');
  const containerName = document.getElementById('nfc-container-name').value.trim();
  const origin = window.location.origin + window.location.pathname.replace('index.html', '');

  let roomId = roomSel.value;
  if (roomId === '__new__') {
    const newName = document.getElementById('nfc-new-room-name').value.trim();
    roomId = newName ? Brain.slugify(newName) : 'raum';
  }

  const tagId = containerName ? Brain.slugify(containerName) : 'behaelter';
  const url = `${origin}?room=${roomId}&tag=${tagId}`;
  const preview = document.getElementById('nfc-preview-url');
  if (preview) preview.textContent = url;
}

async function writeNfcTag() {
  const roomSel = document.getElementById('nfc-room-select');
  const containerName = document.getElementById('nfc-container-name').value.trim();
  const containerTyp = document.getElementById('nfc-container-typ').value;

  if (!roomSel.value || !containerName) {
    showSettingsMsg('Bitte Raum und Behältername eingeben.', 'error');
    return;
  }

  let roomId = roomSel.value;
  if (roomId === '__new__') {
    const newRoomName = document.getElementById('nfc-new-room-name').value.trim();
    const newRoomEmoji = document.getElementById('nfc-new-room-emoji').value.trim() || '🏠';
    if (!newRoomName) { showSettingsMsg('Bitte Raumnamen eingeben.', 'error'); return; }
    roomId = Brain.slugify(newRoomName);
    Brain.addRoom(roomId, newRoomName, newRoomEmoji);
  }

  const tagId = Brain.slugify(containerName);
  const origin = window.location.origin + window.location.pathname.replace('index.html', '');
  const url = `${origin}?room=${roomId}&tag=${tagId}`;

  // Register container in LocalStorage
  if (!Brain.getContainer(roomId, tagId)) {
    ensureRoom(roomId);
    Brain.addContainer(roomId, tagId, containerName, containerTyp);
  }

  // Try Web NFC
  if ('NDEFReader' in window) {
    try {
      const ndef = new NDEFReader();
      showSettingsMsg('Handy jetzt an den NFC Tag halten…', 'loading');
      await ndef.write({ records: [{ recordType: 'url', data: url }] });
      const room = Brain.getRoom(roomId);
      showSettingsMsg(`Tag beschrieben ✓\n${containerName} – ${room?.name || roomId}\nJetzt Handy an den Tag halten um ihn zu testen.`, 'success');
    } catch (err) {
      showNfcFallback(url);
    }
  } else {
    showNfcFallback(url);
  }
}

function showNfcFallback(url) {
  const fallback = document.getElementById('nfc-fallback');
  const urlEl = document.getElementById('nfc-fallback-url');
  if (fallback) {
    fallback.style.display = 'block';
    urlEl.textContent = url;
  }
  showSettingsMsg('NFC Schreiben nicht verfügbar auf diesem Gerät. Bitte URL manuell in "NFC Tools" eintragen.', 'error');
}

function showSettingsMsg(msg, type) {
  const el = document.getElementById('settings-msg');
  el.textContent = msg;
  el.className = `settings-msg settings-msg--${type}`;
  el.style.display = 'block';
  if (type === 'success') setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ── VOICE INPUT ────────────────────────────────────────
function toggleMic() {
  const btn = document.getElementById('chat-mic');
  if (isRecording) {
    if (recognition) recognition.stop();
    isRecording = false;
    btn.classList.remove('recording');
    return;
  }

  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    appendMessage('assistant', 'Spracheingabe wird von diesem Browser nicht unterstützt.');
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'de-DE';
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = e => {
    const text = e.results[0][0].transcript;
    document.getElementById('chat-input').value = text;
    sendChatMessage();
  };

  recognition.onend = () => {
    isRecording = false;
    btn.classList.remove('recording');
  };

  recognition.onerror = () => {
    isRecording = false;
    btn.classList.remove('recording');
  };

  recognition.start();
  isRecording = true;
  btn.classList.add('recording');
}

// ── DEBUG LOG ───────────────────────────────────────────
function debugLog(msg) {
  const ts = new Date().toLocaleTimeString('de-DE');
  const line = `[${ts}] ${msg}\n`;
  for (const id of ['debug-log', 'photo-debug-log']) {
    const el = document.getElementById(id);
    if (!el) continue;
    const current = el.textContent === '— noch kein Log —' ? '' : el.textContent;
    el.textContent = line + current;
  }
  // Auto-open the photo debug panel on first entry
  const panel = document.getElementById('photo-debug-panel');
  if (panel) panel.open = true;
}

// ── GEMINI API ─────────────────────────────────────────
async function callGemini(apiKey, systemPrompt, messages) {
  if (!navigator.onLine) {
    debugLog('FEHLER: Gerät ist offline (navigator.onLine = false)');
    throw new Error('offline');
  }

  const keyPreview = apiKey ? apiKey.slice(0, 8) + '…' : '(leer)';
  debugLog(`Anfrage starten → Modell: ${MODEL}, Key: ${keyPreview}`);

  // Convert Anthropic-style messages to Gemini format
  const geminiContents = messages.map(msg => {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof msg.content === 'string') {
      parts = [{ text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      parts = msg.content.map(item => {
        if (item.type === 'image') {
          return { inlineData: { mimeType: item.source.media_type, data: item.source.data } };
        } else if (item.type === 'text') {
          return { text: item.text };
        }
        return { text: '' };
      });
    } else {
      parts = [{ text: String(msg.content) }];
    }
    return { role, parts };
  });

  let response;
  try {
    response = await fetch(`${API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: geminiContents,
        generationConfig: { maxOutputTokens: 8192 }
      })
    });
  } catch (fetchErr) {
    debugLog(`NETZWERK-FEHLER: ${fetchErr.message}`);
    throw fetchErr;
  }

  debugLog(`HTTP Status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    debugLog(`API Fehlerantwort: ${rawText.slice(0, 400)}`);
    if (response.status === 429) throw new Error('quota');
    if (response.status === 400 || response.status === 403) throw new Error('api_key');
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason ?? 'UNKNOWN';
  const text = candidate?.content?.parts?.[0]?.text ?? '';
  debugLog(`Antwort OK – ${text.length} Zeichen, finishReason: ${finishReason}`);
  if (finishReason === 'SAFETY') throw new Error('safety_block');
  if (finishReason === 'MAX_TOKENS') throw new Error('max_tokens');
  if (!text) debugLog(`Warnung: Leere Antwort. Volle Antwort: ${JSON.stringify(data).slice(0, 500)}`);
  return text;
}

function getErrorMessage(err) {
  if (err.message === 'offline') return 'Ich bin gerade offline. Deine gespeicherten Infos kann ich dir trotzdem zeigen.';
  if (err.message === 'api_key') return 'API Key ungültig oder nicht gesetzt. Bitte in den Einstellungen prüfen.';
  if (err.message === 'quota') return 'Tageslimit der kostenlosen Google AI API erreicht (429). Bitte morgen wieder versuchen oder ein bezahltes Konto nutzen.';
  if (err.message === 'safety_block') return 'Das Foto wurde vom Sicherheitsfilter blockiert. Bitte ein anderes Foto versuchen.';
  if (err.message === 'max_tokens') return 'Antwort zu lang – bitte ein übersichtlicheres Foto wählen.';
  if (err.message === 'Kein JSON in Antwort') return 'Die KI hat keine auswertbare Antwort geliefert. Bitte nochmal versuchen.';
  if (err.message?.includes('too large') || err.message?.includes('size')) return 'Foto zu groß – bitte ein kleineres wählen oder Auflösung reduzieren.';
  if (err instanceof SyntaxError || err.message?.includes('JSON')) return 'Antwort war unvollständig – bitte nochmal versuchen.';
  return 'Kurze Verbindungsstörung – bitte nochmal versuchen.';
}

// ── PULL TO REFRESH ────────────────────────────────────
function setupPullToRefresh() {
  // Indikator-Element erzeugen
  const indicator = document.createElement('div');
  indicator.id = 'ptr-indicator';
  indicator.textContent = '↓ Zum Aktualisieren ziehen';
  document.body.appendChild(indicator);

  let touchStartY = 0;
  let ptrActive = false;

  function getActiveScrollTop() {
    // Im Chat-View scrollt #chat-messages, in allen anderen Views das View selbst
    if (currentView === 'chat') {
      const msgs = document.getElementById('chat-messages');
      return msgs ? msgs.scrollTop : 0;
    }
    const activeView = document.querySelector('.view.active');
    return activeView ? activeView.scrollTop : 0;
  }

  document.addEventListener('touchstart', e => {
    touchStartY = e.touches[0].clientY;
    ptrActive = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (getActiveScrollTop() > 5) return; // Nicht am oberen Rand

    const dy = e.touches[0].clientY - touchStartY;
    if (dy <= 0) return;

    ptrActive = true;
    const progress = Math.min(dy / 80, 1);
    indicator.style.transform = `translateY(${(progress - 1) * 100}%)`;
    indicator.textContent = dy > 80 ? '↑ Loslassen zum Aktualisieren' : '↓ Zum Aktualisieren ziehen';
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!ptrActive) return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (dy > 80) {
      indicator.style.transform = 'translateY(0)';
      indicator.textContent = '↻ Wird aktualisiert…';
      setTimeout(() => window.location.reload(true), 400);
    } else {
      indicator.style.transform = 'translateY(-100%)';
    }
    ptrActive = false;
  }, { passive: true });
}

// ── ONBOARDING ─────────────────────────────────────────
let onboardingRoomId = null;

function setupOnboarding() {
  document.getElementById('onboarding-start').addEventListener('click', showOnboardingRoomStep);
  document.getElementById('onboarding-skip').addEventListener('click', finishOnboarding);
  document.getElementById('onboarding-photo-btn').addEventListener('click', () => {
    document.getElementById('onboarding-photo-input').click();
  });
  document.getElementById('onboarding-photo-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (onboardingRoomId) {
      // Process through normal photo analysis flow
      ensureRoomExists(onboardingRoomId);
      stagingTarget = { roomId: onboardingRoomId, containerId: 'inhalt', containerName: '', mode: 'add', onboardingFlow: true };
      showStagingOverlay('📷 Fotos sammeln');
      addFileToStaging(file);
      // Don't show done step here - it will be shown after review/staging closes
    }
  });
  document.getElementById('onboarding-finish').addEventListener('click', finishOnboarding);

  // Build room tiles
  const tiles = document.getElementById('onboarding-room-tiles');
  const onboardingRooms = ['kueche', 'wohnzimmer', 'schlafzimmer', 'bad', 'arbeitszimmer', 'keller'];
  onboardingRooms.forEach(id => {
    const [emoji, name] = ROOM_PRESETS[id] || ['🏠', id];
    const tile = document.createElement('button');
    tile.className = 'onboarding-room-tile';
    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'onboarding-room-tile-emoji';
    emojiSpan.textContent = emoji;
    tile.appendChild(emojiSpan);
    tile.appendChild(document.createTextNode(name));
    tile.addEventListener('click', () => {
      onboardingRoomId = id;
      showOnboardingPhotoStep(name);
    });
    tiles.appendChild(tile);
  });
}

function showOnboarding() {
  // Hide nav during onboarding
  document.getElementById('nav').style.display = 'none';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const onb = document.getElementById('view-onboarding');
  onb.style.display = 'flex';
  onb.classList.add('active');
  // Show welcome, hide steps
  onb.querySelector('.onboarding-screen').style.display = 'flex';
  document.getElementById('onboarding-step-room').style.display = 'none';
  document.getElementById('onboarding-step-photo').style.display = 'none';
  document.getElementById('onboarding-step-done').style.display = 'none';
}

function showOnboardingRoomStep() {
  const onb = document.getElementById('view-onboarding');
  onb.querySelector('.onboarding-screen').style.display = 'none';
  document.getElementById('onboarding-step-room').style.display = 'flex';
}

function showOnboardingPhotoStep(roomName) {
  document.getElementById('onboarding-step-room').style.display = 'none';
  document.getElementById('onboarding-photo-desc').textContent =
    `Mach ein Foto von einem Schrank, Regal oder einer Schublade in deiner ${roomName}.`;
  document.getElementById('onboarding-step-photo').style.display = 'flex';
}

function showOnboardingDoneStep() {
  document.getElementById('onboarding-step-photo').style.display = 'none';
  document.getElementById('onboarding-step-done').style.display = 'flex';
}

function finishOnboarding() {
  localStorage.setItem('onboarding_completed', 'true');
  document.getElementById('view-onboarding').style.display = 'none';
  document.getElementById('view-onboarding').classList.remove('active');
  document.getElementById('nav').style.display = 'flex';
  showView('chat');
}

// ── CHAT QUICK-SUGGESTIONS ─────────────────────────────
function maybeShowChatSuggestions() {
  const messages = document.getElementById('chat-messages');
  const suggestions = document.getElementById('chat-suggestions');
  // Show suggestions if chat is empty OR no children in suggestions
  if (messages.children.length <= 1 || suggestions.children.length === 0) {
    // Check if last message is old enough (>5 min)
    const history = Brain.getChatHistory();
    const lastMsg = history[history.length - 1];
    if (!lastMsg || (Date.now() - lastMsg.ts > 5 * 60 * 1000) || messages.children.length <= 1) {
      renderChatSuggestions();
    }
  }
}

function renderChatSuggestions() {
  const container = document.getElementById('chat-suggestions');
  container.innerHTML = '';

  if (Brain.isEmpty()) {
    // Empty household suggestions
    const suggestions = [
      { text: '📷 Erstes Foto machen', action: () => showView('photo') },
      { text: 'Wie funktioniert das?', action: () => sendSuggestion('Wie funktioniert diese App?') }
    ];
    suggestions.forEach(s => {
      const btn = document.createElement('button');
      btn.className = 'chat-suggestion-btn';
      btn.textContent = s.text;
      btn.addEventListener('click', () => {
        hideChatSuggestions();
        s.action();
      });
      container.appendChild(btn);
    });
    return;
  }

  // Generate context-aware suggestions from existing data
  const rooms = Brain.getRooms();
  const roomEntries = Object.entries(rooms);
  const suggestions = [];

  // Pick room-based suggestions
  if (roomEntries.length > 0) {
    const [, firstRoom] = roomEntries[0];
    suggestions.push(`Was liegt in der ${firstRoom.name}?`);
  }
  if (roomEntries.length > 1) {
    const [, secondRoom] = roomEntries[1];
    suggestions.push(`Zeig mir ${secondRoom.name}`);
  }

  // Pick an item-based suggestion
  let foundItem = null;
  for (const [, room] of roomEntries) {
    for (const [, c] of Object.entries(room.containers || {})) {
      if (c.items?.length > 0) {
        foundItem = c.items[Math.floor(Math.random() * c.items.length)];
        break;
      }
    }
    if (foundItem) break;
  }
  if (foundItem) {
    suggestions.push(`Wo ist ${foundItem}?`);
  } else {
    suggestions.push('Wo ist die Schere?');
  }

  suggestions.slice(0, 3).forEach(text => {
    const btn = document.createElement('button');
    btn.className = 'chat-suggestion-btn';
    btn.textContent = text;
    btn.addEventListener('click', () => {
      hideChatSuggestions();
      sendSuggestion(text);
    });
    container.appendChild(btn);
  });
}

function sendSuggestion(text) {
  const input = document.getElementById('chat-input');
  input.value = text;
  sendChatMessage();
}

function hideChatSuggestions() {
  document.getElementById('chat-suggestions').innerHTML = '';
}

// ── LONG PRESS ─────────────────────────────────────────
function setupLongPress(el, callback) {
  let timer;
  el.addEventListener('pointerdown', () => { timer = setTimeout(callback, 600); });
  el.addEventListener('pointerup', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => clearTimeout(timer));
}
