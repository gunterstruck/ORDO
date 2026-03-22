// app.js – Main application logic

const MODEL = 'gemini-3-flash-preview';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

// ── State ──────────────────────────────────────────────
let currentView = 'chat';
let recognition = null;
let isRecording = false;
let nfcContext = null; // { room, tag } from URL params
let chatPendingPhoto = null; // { base64, mimeType } – Foto im Chat-Eingabefeld

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
  setupPullToRefresh();
  showView('chat');
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
  document.getElementById('footer-settings').addEventListener('click', () => showView('settings'));
  document.getElementById('footer-impressum').addEventListener('click', () => showView('impressum'));
}

function showView(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('active');

  const navBtn = document.querySelector(`.nav-btn[data-view="${name}"]`);
  if (navBtn) navBtn.classList.add('active');

  if (name === 'chat') initChat();
  if (name === 'brain') renderBrainView();
  if (name === 'settings') renderSettings();
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

async function resizeImageForChat(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1024;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        const ratio = Math.min(MAX / width, MAX / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        const reader = new FileReader();
        reader.onload = e => resolve({ base64: e.target.result.split(',')[1], mimeType: 'image/jpeg' });
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Ladefehler')); };
    img.src = url;
  });
}

// Resize a File/Blob to max maxWidth pixels and return a JPEG Blob
function resizeImage(file, maxWidth = 1200) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxWidth) {
        const ratio = maxWidth / width;
        width = maxWidth;
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Resize failed'));
      }, 'image/jpeg', 0.7);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Ladefehler')); };
    img.src = url;
  });
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

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    appendMessage('assistant', 'API Key nicht gesetzt. Bitte in den Einstellungen eintragen.');
    return;
  }

  input.value = '';
  if (photo) clearChatPhoto();

  // Nutzernachricht anzeigen (mit Kamera-Icon wenn Foto dabei)
  const displayText = photo ? (text ? `📷 ${text}` : '📷 Foto') : text;
  appendMessage('user', displayText);
  Brain.addChatMessage('user', displayText);

  const thinking = appendMessage('assistant', '…', true);

  try {
    const context = Brain.buildContext();

    // Basis-System-Prompt
    let systemPrompt = `Du bist ein stiller Haushaltsassistent.
Hier ist was du über diesen Haushalt weißt:
${context}

Antworte immer in maximal 2 kurzen Sätzen.
Wenn du etwas nicht weißt, sag es direkt und bitte den Nutzer ein Foto zu machen.
Antworte immer auf Deutsch.

Wenn der Nutzer einen Gegenstand erwähnt und du weißt wo er hingehört (weil er es gesagt hat oder weil ein NFC-Kontext gesetzt ist), speichere ihn automatisch.
Füge dafür am Ende deiner Antwort diesen Marker ein (der Nutzer sieht ihn nicht):
<!--SAVE:{"action":"add_item","room":"raum_slug","container":"container_slug","item":"Name"}-->

Mögliche SAVE-Aktionen: add_item, move_item (mit "from_room","from_container" zusätzlich), remove_item, add_container.

Du kannst die Haushaltsdatenbank aktiv verändern. Wenn der Nutzer sagt dass etwas nicht mehr existiert, verschoben wurde, aufgebraucht ist oder sich geändert hat, führe die passende Aktion aus.
Füge am Ende deiner Antwort einen unsichtbaren ACTION-Marker ein. Format: <!--ACTION:{"type":"...", ...}-->

Verfügbare ACTION-Typen:
- add_item: {"type":"add_item","room":"...","container":"...","item":"..."}
- remove_item: {"type":"remove_item","room":"...","container":"...","item":"..."}
- move_item: {"type":"move_item","from_room":"...","from_container":"...","to_room":"...","to_container":"...","item":"..."}
- remove_items: {"type":"remove_items","room":"...","container":"...","items":["...",  "..."]}
- replace_items: {"type":"replace_items","room":"...","container":"...","items":["...","..."]}
- delete_container: {"type":"delete_container","room":"...","container":"..."}
- rename_container: {"type":"rename_container","room":"...","container":"...","new_name":"..."}
- delete_room: {"type":"delete_room","room":"..."}
- add_container: {"type":"add_container","room":"...","container":"...","name":"...","typ":"..."}

WICHTIG:
- Verwende als room und container IDs die slugifizierten Namen aus der Datenbank (siehe Kontext oben).
- Wenn du nicht sicher bist WELCHER Gegenstand oder Behälter gemeint ist, frage ERST nach. Füge dann KEINEN Marker ein.
- Bei destruktiven Aktionen (delete_container, delete_room): Frage IMMER kurz nach bevor du den Marker einfügst. Erst wenn der Nutzer bestätigt → Marker einfügen.
- Bei einfachen Änderungen (remove_item, move_item): Direkt ausführen, nur kurz bestätigen.
- Nutze die exakten IDs aus dem Kontext.

Wenn du Raum oder Behälter nicht kennst, frage zuerst nach. Füge dann KEINEN Marker ein.
Verwende slugifizierte IDs: Kleinbuchstaben, Umlaute umschreiben (ä→ae, ö→oe, ü→ue, ß→ss), Leerzeichen zu Unterstrichen.
Beispiele: "Küche" → "kueche", "Schrank links" → "schrank_links"`;

    // NFC-Kontext in System-Prompt einbetten
    if (nfcContext) {
      const nfcRoom = Brain.getRoom(nfcContext.room);
      const nfcContainer = nfcContext.tag ? Brain.getContainer(nfcContext.room, nfcContext.tag) : null;
      const nfcRoomName = nfcRoom?.name || nfcContext.room;
      const nfcContainerName = nfcContainer?.name || nfcContext.tag || '';
      if (nfcContainerName) {
        systemPrompt += `\n\nDer Nutzer steht gerade vor: ${nfcContainerName} im Raum ${nfcRoomName}. Wenn er ein Foto schickt oder Gegenstände erwähnt, ordne sie diesem Behälter zu (room: "${nfcContext.room}", container: "${nfcContext.tag}") – außer er sagt ausdrücklich etwas anderes.`;
      } else {
        systemPrompt += `\n\nDer Nutzer befindet sich gerade im Raum: ${nfcRoomName}. Ordne erwähnte Gegenstände diesem Raum zu – außer er sagt ausdrücklich etwas anderes.`;
      }
    }

    // Erweiterung für Foto-Nachrichten
    if (photo) {
      const knownRooms = Object.entries(Brain.getRooms())
        .map(([id, r]) => `${id} (${r.name})`).join(', ') || 'noch keine Räume bekannt';

      systemPrompt += `

Auf diesem Foto: Analysiere es im Kontext des Haushalts.
A) Zeigt es einen Raum, Schrank, Regal oder Möbelstück → erkenne was drin liegt und füge <!--SAVE:...--> Marker für jeden erkannten Gegenstand ein.
B) Zeigt es einen einzelnen Gegenstand → frage wo er liegt und speichere ihn mit <!--SAVE:...--> wenn der Nutzer antwortet.
C) Allgemeine Frage → beantworte sie einfach.
Bekannte Räume: ${knownRooms}`;

      // Bei NFC-Kontext: KI weiß schon wo sie ist
      if (nfcContext) {
        const nfcRoom = Brain.getRoom(nfcContext.room);
        const nfcContainer = nfcContext.tag ? Brain.getContainer(nfcContext.room, nfcContext.tag) : null;
        systemPrompt += `\nDer Nutzer steht vor "${nfcContainer?.name || nfcContext.tag || nfcRoom?.name}" – ordne erkannte Gegenstände direkt diesem Behälter zu (room: "${nfcContext.room}", container: "${nfcContext.tag || ''}").`;
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

    // Legacy ##SAVE##-Marker prüfen (Rückwärtskompatibilität)
    if (response.includes('##SAVE##')) {
      handleSaveResponse(response);
    } else {
      // <!--SAVE:...--> Marker-System (add/move/remove items, add container)
      const { cleanText: afterSave, actions: saveActions } = processSaveMarkers(response);
      // <!--ACTION:...--> Marker-System (alle Aktionen inkl. delete/rename)
      const { cleanText, actions: actionActions } = processActions(afterSave);
      appendMessage('assistant', cleanText);
      Brain.addChatMessage('assistant', cleanText);
      saveActions.forEach(action => executeSaveAction(action));
      actionActions.forEach(action => executeAction(action));
    }
  } catch (err) {
    thinking.remove();
    appendMessage('assistant', getErrorMessage(err));
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
    // Raum anlegen falls noch nicht vorhanden
    if (!Brain.getRoom(roomId)) {
      const presets = { kueche: ['🍳', 'Küche'], wohnzimmer: ['🛋️', 'Wohnzimmer'], schlafzimmer: ['🛏️', 'Schlafzimmer'], arbeitszimmer: ['💻', 'Arbeitszimmer'], keller: ['📦', 'Keller'], bad: ['🚿', 'Bad'], sonstiges: ['🏠', 'Sonstiges'] };
      const p = presets[roomId] || ['🏠', roomId];
      Brain.addRoom(roomId, p[1], p[0]);
    }
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

// ── SAVE MARKER SYSTEM ─────────────────────────────────

// Extracts all <!--SAVE:{...}--> markers from AI response text
// Returns { cleanText, actions[] }
function processSaveMarkers(text) {
  const actions = [];
  const cleanText = text.replace(/<!--SAVE:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const action = JSON.parse(jsonStr.trim());
      actions.push(action);
    } catch { /* ignore malformed markers */ }
    return '';
  }).trim();
  return { cleanText, actions };
}

// Executes a parsed save action from the AI
function executeSaveAction(action) {
  const presets = {
    kueche: ['🍳', 'Küche'], wohnzimmer: ['🛋️', 'Wohnzimmer'],
    schlafzimmer: ['🛏️', 'Schlafzimmer'], arbeitszimmer: ['💻', 'Arbeitszimmer'],
    keller: ['📦', 'Keller'], bad: ['🚿', 'Bad'], sonstiges: ['🏠', 'Sonstiges']
  };

  function ensureRoom(roomId) {
    if (roomId && !Brain.getRoom(roomId)) {
      const p = presets[roomId] || ['🏠', roomId];
      Brain.addRoom(roomId, p[1], p[0]);
    }
  }

  try {
    switch (action.action) {
      case 'add_item': {
        ensureRoom(action.room);
        if (!Brain.getContainer(action.room, action.container)) {
          Brain.addContainer(action.room, action.container, action.container, 'sonstiges');
        }
        Brain.addItem(action.room, action.container, action.item);
        const c = Brain.getContainer(action.room, action.container);
        const r = Brain.getRoom(action.room);
        showSystemMessage(`✓ ${action.item} → ${c?.name || action.container} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'move_item': {
        Brain.removeItem(action.from_room || action.room, action.from_container || action.container, action.item);
        ensureRoom(action.room);
        if (!Brain.getContainer(action.room, action.container)) {
          Brain.addContainer(action.room, action.container, action.container, 'sonstiges');
        }
        Brain.addItem(action.room, action.container, action.item);
        const c = Brain.getContainer(action.room, action.container);
        const r = Brain.getRoom(action.room);
        showSystemMessage(`✓ ${action.item} verschoben → ${c?.name || action.container} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'remove_item': {
        Brain.removeItem(action.room, action.container, action.item);
        showSystemMessage(`✓ ${action.item} entfernt`);
        renderBrainView();
        break;
      }
      case 'add_container': {
        ensureRoom(action.room);
        Brain.addContainer(action.room, action.container, action.name || action.container, action.typ || 'sonstiges');
        const r = Brain.getRoom(action.room);
        showSystemMessage(`✓ Neuer Bereich: ${action.name || action.container} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      // need_info → no action needed
    }
  } catch { /* silent fail – don't break chat */ }
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

// ── ACTION MARKER SYSTEM ────────────────────────────────

// Extracts all <!--ACTION:{...}--> markers from AI response text
// Returns { cleanText, actions[] }
function processActions(text) {
  const actions = [];
  const cleanText = text.replace(/<!--ACTION:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const action = JSON.parse(jsonStr.trim());
      actions.push(action);
    } catch { /* ignore malformed markers */ }
    return '';
  }).trim();
  return { cleanText, actions };
}

// Executes a parsed action from the ACTION marker system
function executeAction(action) {
  try {
    switch (action.type) {
      case 'add_item': {
        if (!Brain.getRoom(action.room)) return;
        if (!Brain.getContainer(action.room, action.container)) return;
        Brain.addItem(action.room, action.container, action.item);
        const c = Brain.getContainer(action.room, action.container);
        const r = Brain.getRoom(action.room);
        showSystemMessage(`✓ ${action.item} hinzugefügt zu ${c?.name || action.container} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'remove_item': {
        if (!Brain.getRoom(action.room)) return;
        const c = Brain.getContainer(action.room, action.container);
        if (!c) return;
        const r = Brain.getRoom(action.room);
        Brain.removeItem(action.room, action.container, action.item);
        showSystemMessage(`✓ ${action.item} entfernt aus ${c?.name || action.container} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'move_item': {
        const fromC = Brain.getContainer(action.from_room, action.from_container);
        const toR = Brain.getRoom(action.to_room);
        const toC = Brain.getContainer(action.to_room, action.to_container);
        if (!fromC || !toR || !toC) return;
        const fromR = Brain.getRoom(action.from_room);
        Brain.removeItem(action.from_room, action.from_container, action.item);
        Brain.addItem(action.to_room, action.to_container, action.item);
        showSystemMessage(`✓ ${action.item} verschoben: ${fromR?.name || action.from_room} → ${toR?.name || action.to_room}`);
        renderBrainView();
        break;
      }
      case 'remove_items': {
        if (!Brain.getRoom(action.room)) return;
        const c = Brain.getContainer(action.room, action.container);
        if (!c) return;
        const r = Brain.getRoom(action.room);
        (action.items || []).forEach(item => Brain.removeItem(action.room, action.container, item));
        showSystemMessage(`✓ ${(action.items || []).length} Gegenstände entfernt aus ${c?.name || action.container} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'replace_items': {
        if (!Brain.getRoom(action.room)) return;
        const c = Brain.getContainer(action.room, action.container);
        if (!c) return;
        const r = Brain.getRoom(action.room);
        const data = Brain.getData();
        data.rooms[action.room].containers[action.container].items = action.items || [];
        Brain.save(data);
        showSystemMessage(`✓ Inhalt aktualisiert: ${c?.name || action.container} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'delete_container': {
        if (!Brain.getRoom(action.room)) return;
        const c = Brain.getContainer(action.room, action.container);
        if (!c) return;
        const r = Brain.getRoom(action.room);
        const containerName = c.name;
        const roomName = r?.name || action.room;
        Brain.deleteContainer(action.room, action.container);
        Brain.deletePhoto(action.room + '_' + action.container);
        showSystemMessage(`✓ ${containerName} gelöscht (${roomName})`);
        renderBrainView();
        break;
      }
      case 'rename_container': {
        if (!Brain.getRoom(action.room)) return;
        const c = Brain.getContainer(action.room, action.container);
        if (!c) return;
        const r = Brain.getRoom(action.room);
        const oldName = c.name;
        Brain.renameContainer(action.room, action.container, action.new_name);
        showSystemMessage(`✓ ${oldName} umbenannt zu ${action.new_name} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
      case 'delete_room': {
        const r = Brain.getRoom(action.room);
        if (!r) return;
        const roomName = r.name;
        const data = Brain.getData();
        const containers = data.rooms[action.room]?.containers || {};
        Object.keys(containers).forEach(cId => {
          Brain.deletePhoto(action.room + '_' + cId);
        });
        Brain.deleteRoom(action.room);
        showSystemMessage(`✓ Raum ${roomName} gelöscht`);
        renderBrainView();
        break;
      }
      case 'add_container': {
        if (!Brain.getRoom(action.room)) return;
        Brain.addContainer(action.room, action.container, action.name || action.container, action.typ || 'sonstiges');
        const r = Brain.getRoom(action.room);
        showSystemMessage(`✓ Neuer Behälter: ${action.name || action.container} (${r?.name || action.room})`);
        renderBrainView();
        break;
      }
    }
  } catch { /* silent fail – don't break chat */ }
}

// ── PHOTO VIEW ─────────────────────────────────────────
function setupPhoto() {
  document.getElementById('photo-camera-btn').addEventListener('click', () => {
    document.getElementById('photo-input-camera').click();
  });
  document.getElementById('photo-gallery-btn').addEventListener('click', () => {
    document.getElementById('photo-input-gallery').click();
  });
  document.getElementById('photo-input-camera').addEventListener('change', e => handlePhotoFile(e.target.files[0]));
  document.getElementById('photo-input-gallery').addEventListener('change', e => handlePhotoFile(e.target.files[0]));
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
  const presets = [
    ['kueche', '🍳', 'Küche'],
    ['wohnzimmer', '🛋️', 'Wohnzimmer'],
    ['schlafzimmer', '🛏️', 'Schlafzimmer'],
    ['arbeitszimmer', '💻', 'Arbeitszimmer'],
    ['keller', '📦', 'Keller'],
    ['bad', '🚿', 'Bad'],
    ['sonstiges', '🏠', 'Sonstiges']
  ];
  presets.forEach(([id, emoji, name]) => {
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
      const presets = { kueche: ['🍳', 'Küche'], wohnzimmer: ['🛋️', 'Wohnzimmer'], schlafzimmer: ['🛏️', 'Schlafzimmer'], arbeitszimmer: ['💻', 'Arbeitszimmer'], keller: ['📦', 'Keller'], bad: ['🚿', 'Bad'], sonstiges: ['🏠', 'Sonstiges'] };
      if (!Brain.getRoom(roomId)) {
        const p = presets[roomId] || ['🏠', roomId];
        Brain.addRoom(roomId, p[1], p[0]);
      }

      const systemPrompt = `Analysiere dieses Foto eines Raums oder Möbelstücks.
Antworte NUR mit diesem JSON, nichts anderes:
{
  "behaelter": [
    {
      "id": "eindeutige_id",
      "name": "menschlicher Name",
      "typ": "schrank|regal|schublade|kiste|sonstiges",
      "position": "kurze Positionsbeschreibung",
      "inhalt_sicher": ["Gegenstand der klar in diesem Behälter liegt"],
      "inhalt_unsicher": [
        {
          "name": "Gegenstand",
          "vermutung": "liegt vermutlich in diesem Behälter, aber nicht 100% sicher"
        }
      ]
    }
  ],
  "lose_gegenstaende": ["Gegenstand klar außerhalb aller Behälter"],
  "unklar": [
    {
      "name": "Gegenstand",
      "kontext": "Kurze Beschreibung warum unklar, z.B. liegt zwischen zwei Behältern"
    }
  ],
  "raumhinweis": "kurze Raumcharakteristik"
}`;

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

      // Save resized photo to IndexedDB for the first (main) container
      if (analysis.behaelter?.length > 0) {
        try {
          const resized = await resizeImage(file, 1200);
          const primaryId = targetContainerId || Brain.slugify(analysis.behaelter[0].id || analysis.behaelter[0].name);
          const photoKey = `${roomId}_${primaryId}`;
          await Brain.savePhoto(photoKey, resized);
          Brain.setContainerHasPhoto(roomId, primaryId, true);
        } catch { /* photo save failed silently */ }
      }

      // Feature 1: process three confidence levels and generate chat messages
      if (!targetRoomId) {
        processPhotoAnalysisResult(roomId, analysis);
      }

      showPhotoStatus(`Ich habe ${count} Bereiche gelernt.`, 'success');
      renderBrainView();
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

  if (Object.keys(rooms).length === 0) {
    container.innerHTML = '<p class="brain-empty">Noch keine Räume erfasst.<br>Mach ein Foto zum Einlernen.</p>';
    return;
  }

  for (const [roomId, room] of Object.entries(rooms)) {
    container.appendChild(buildRoomNode(roomId, room));
  }
}

function buildRoomNode(roomId, room) {
  const roomEl = document.createElement('div');
  roomEl.className = 'brain-room';

  const hasContainers = Object.keys(room.containers || {}).length > 0;

  const header = document.createElement('div');
  header.className = 'brain-room-header';
  header.innerHTML = `<span class="brain-room-emoji">${room.emoji}</span><span class="brain-room-name">${room.name}</span><span class="brain-room-count">${Object.keys(room.containers || {}).length}</span>`;

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

  if (!hasContainers) {
    const empty = document.createElement('p');
    empty.className = 'brain-empty-room';
    empty.textContent = 'Noch keine Bereiche – mach ein Foto.';
    body.appendChild(empty);
  } else {
    for (const [cId, c] of Object.entries(room.containers)) {
      body.appendChild(buildContainerNode(roomId, cId, c));
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

function buildContainerNode(roomId, cId, c) {
  const el = document.createElement('div');
  el.className = `brain-container ${c.items?.length > 0 ? 'has-items' : 'empty'}`;

  const typIcon = { schrank: '🗄️', regal: '📚', schublade: '🗃️', kiste: '📦', tisch: '🪑', sonstiges: '📋' };
  const icon = typIcon[c.typ] || '📋';

  const header = document.createElement('div');
  header.className = 'brain-container-header';
  header.innerHTML = `<span>${icon} ${c.name}</span><small>${c.last_updated ? Brain.formatDate(c.last_updated) : ''}</small>`;

  let open = false;
  const body = document.createElement('div');
  body.className = 'brain-container-body';
  body.style.display = 'none';

  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? 'block' : 'none';
    if (open) loadThumbnail(roomId, cId, c, thumbnailWrapper);
  });

  setupLongPress(header, () => showContainerContextMenu(roomId, cId, c));

  // Thumbnail area
  const thumbnailWrapper = document.createElement('div');
  thumbnailWrapper.className = 'brain-thumbnail-wrapper';

  // Items as chips
  const chips = document.createElement('div');
  chips.className = 'brain-chips';

  (c.items || []).forEach(item => {
    const chip = document.createElement('span');
    chip.className = 'brain-chip';
    chip.textContent = item;
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

  // Add item button
  const addItemBtn = document.createElement('button');
  addItemBtn.className = 'brain-add-item-btn';
  addItemBtn.textContent = '+ Gegenstand';
  addItemBtn.addEventListener('click', () => {
    const name = prompt('Gegenstand hinzufügen:');
    if (name?.trim()) {
      Brain.addItem(roomId, cId, name.trim());
      renderBrainView();
    }
  });

  body.appendChild(thumbnailWrapper);
  body.appendChild(chips);
  body.appendChild(addItemBtn);
  el.appendChild(header);
  el.appendChild(body);
  return el;
}

async function loadThumbnail(roomId, cId, c, wrapper) {
  // Only render once
  if (wrapper.dataset.loaded) return;
  wrapper.dataset.loaded = '1';

  const photoKey = `${roomId}_${cId}`;
  let blob = null;
  try {
    blob = await Brain.getPhoto(photoKey);
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
  } else {
    // Placeholder
    const div = document.createElement('div');
    div.className = 'brain-thumbnail-empty';
    div.innerHTML = '<span>📷</span><p>Noch kein Foto.<br>Tippe hier um zu scannen.</p>';
    div.addEventListener('click', () => openCameraForContainer(roomId, cId));
    wrapper.appendChild(div);
  }
}

// Hidden file input for brain-view per-container photo capture
let _brainPhotoInput = null;
let _brainPhotoTarget = null; // { roomId, cId }

function openCameraForContainer(roomId, cId) {
  if (!_brainPhotoInput) {
    _brainPhotoInput = document.createElement('input');
    _brainPhotoInput.type = 'file';
    _brainPhotoInput.accept = 'image/*';
    _brainPhotoInput.style.display = 'none';
    document.body.appendChild(_brainPhotoInput);
    _brainPhotoInput.addEventListener('change', async e => {
      const file = e.target.files[0];
      _brainPhotoInput.value = '';
      if (!file || !_brainPhotoTarget) return;
      await handlePhotoFile(file, _brainPhotoTarget.roomId, _brainPhotoTarget.cId);
    });
  }
  _brainPhotoTarget = { roomId, cId };
  _brainPhotoInput.click();
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
  }, 200);
}

function showAddRoomDialog() {
  const name = prompt('Name des Raums:');
  if (!name?.trim()) return;
  const emoji = prompt('Emoji für den Raum (z.B. 🍳):', '🏠');
  const id = Brain.slugify(name.trim());
  Brain.addRoom(id, name.trim(), emoji || '🏠');
  renderBrainView();
}

function showAddContainerDialog(roomId) {
  const name = prompt('Name des Bereichs (z.B. "Schrank links neben Tür"):');
  if (!name?.trim()) return;
  const typ = prompt('Typ (schrank/regal/schublade/kiste/tisch/sonstiges):', 'sonstiges');
  const id = Brain.slugify(name.trim());
  Brain.addContainer(roomId, id, name.trim(), typ || 'sonstiges');
  renderBrainView();
}

function showRoomContextMenu(roomId, room) {
  const action = prompt(`Raum: ${room.emoji} ${room.name}\n\nAktion:\n1 = Umbenennen\n2 = Löschen`);
  if (action === '1') {
    const newName = prompt('Neuer Name:', room.name);
    if (newName?.trim()) Brain.renameRoom(roomId, newName.trim());
    renderBrainView();
  } else if (action === '2') {
    if (confirm(`${room.name} wirklich löschen?`)) {
      Brain.deleteRoom(roomId);
      renderBrainView();
    }
  }
}

function showContainerContextMenu(roomId, cId, c) {
  const action = prompt(`Bereich: ${c.name}\n\nAktion:\n1 = Umbenennen\n2 = Löschen`);
  if (action === '1') {
    const newName = prompt('Neuer Name:', c.name);
    if (newName?.trim()) Brain.renameContainer(roomId, cId, newName.trim());
    renderBrainView();
  } else if (action === '2') {
    if (confirm(`${c.name} wirklich löschen?`)) {
      Brain.deleteContainer(roomId, cId);
      renderBrainView();
    }
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
    await Brain.exportData();
  });

  document.getElementById('settings-import').addEventListener('click', () => {
    document.getElementById('settings-import-file').click();
  });

  document.getElementById('settings-import-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Vorhandene Daten werden überschrieben – fortfahren?')) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      const ok = await Brain.importData(ev.target.result);
      if (ok) {
        showSettingsMsg('Haushalt erfolgreich geladen.', 'success');
        renderBrainView();
      } else {
        showSettingsMsg('Import fehlgeschlagen – ungültiges Format.', 'error');
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('settings-reset').addEventListener('click', async () => {
    if (confirm('Wirklich alles zurücksetzen? Alle Daten gehen verloren.')) {
      await Brain.resetAll();
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

  // NFC info toggle
  document.getElementById('nfc-info-toggle').addEventListener('click', () => {
    const body = document.getElementById('nfc-info-body');
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  });

  // Copy NFC URL
  document.getElementById('nfc-copy-btn')?.addEventListener('click', () => {
    const url = document.getElementById('nfc-preview-url').textContent;
    navigator.clipboard.writeText(url).then(() => showSettingsMsg('URL kopiert.', 'success'));
  });
}

function renderSettings() {
  document.getElementById('settings-api-key').value = Brain.getApiKey();
  renderRoomDropdown('nfc-room-select');
  updateNfcPreview();

  // Add "Neuer Raum" option
  const sel = document.getElementById('nfc-room-select');
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ Neuer Raum';
  sel.appendChild(newOpt);

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
    const room = Brain.getRoom(roomId);
    if (!room) {
      const presets = { kueche: ['🍳', 'Küche'], wohnzimmer: ['🛋️', 'Wohnzimmer'], schlafzimmer: ['🛏️', 'Schlafzimmer'], arbeitszimmer: ['💻', 'Arbeitszimmer'], keller: ['📦', 'Keller'], bad: ['🚿', 'Bad'], sonstiges: ['🏠', 'Sonstiges'] };
      const p = presets[roomId] || ['🏠', roomId];
      Brain.addRoom(roomId, p[1], p[0]);
    }
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

// ── LONG PRESS ─────────────────────────────────────────
function setupLongPress(el, callback) {
  let timer;
  el.addEventListener('pointerdown', () => { timer = setTimeout(callback, 600); });
  el.addEventListener('pointerup', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => clearTimeout(timer));
}
