// chat.js – Chat-UI, Nachrichten senden/empfangen, Spracheingabe

import Brain from './brain.js';
import { callGemini, processMarkers, executeOrdoAction, normalizeOrdoAction, getErrorMessage, buildMessages, resolveContainerFromPath } from './ai.js';
import { showToast } from './modal.js';
import { debugLog, showView, getNfcContext, ensureRoom } from './app.js';
import { renderBrainView, showLightbox, closeLightbox } from './brain-view.js';
import { resizeImageForChat, renderRoomDropdown } from './photo-flow.js';
import { capturePhoto } from './camera.js';

// ── State ──────────────────────────────────────────────
let recognition = null;
let isRecording = false;
let chatPendingPhoto = null;

export { chatPendingPhoto };

export function setChatPendingPhoto(val) { chatPendingPhoto = val; }

// ── Setup ──────────────────────────────────────────────
export function setupChat() {
  document.getElementById('chat-send').addEventListener('click', sendChatMessage);
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  document.getElementById('chat-mic').addEventListener('click', toggleMic);
  setupChatCamera();
}

function setupChatCamera() {
  const btn = document.getElementById('chat-camera');
  const input = document.getElementById('chat-photo-input');
  const removeBtn = document.getElementById('chat-photo-remove');

  btn.addEventListener('click', async () => {
    const file = await capturePhoto();
    if (!file) return;

    if (file.size > 4 * 1024 * 1024) {
      showToast('Foto zu groß – bitte ein kleineres wählen.', 'error');
      return;
    }

    try {
      const { base64, mimeType } = await resizeImageForChat(file);
      chatPendingPhoto = { base64, mimeType };

      const thumb = document.getElementById('chat-photo-thumb');
      thumb.src = `data:${mimeType};base64,${base64}`;
      document.getElementById('chat-photo-preview').hidden = false;
    } catch {
      showToast('Foto konnte nicht geladen werden.', 'error');
    }
  });

  input.addEventListener('change', async e => {
    const file = e.target.files[0];
    input.value = '';
    if (!file) return;

    if (file.size > 4 * 1024 * 1024) {
      showToast('Foto zu groß – bitte ein kleineres wählen.', 'error');
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
      debugLog('Chat-Foto konnte nicht geladen werden');
      showToast('Foto konnte nicht geladen werden.', 'error');
    }
  });

  removeBtn.addEventListener('click', clearChatPhoto);
}

export function clearChatPhoto() {
  chatPendingPhoto = null;
  document.getElementById('chat-photo-preview').hidden = true;
  document.getElementById('chat-photo-thumb').src = '';
}

export function initChat() {
  const messages = document.getElementById('chat-messages');
  const nfcContext = getNfcContext();
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

export function appendMessage(role, text, thinking = false) {
  const messages = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg chat-msg--${role}${thinking ? ' chat-msg--thinking' : ''}`;
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

export async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  const photo = chatPendingPhoto;

  if (!text && !photo) return;

  const sendBtn = document.getElementById('chat-send');
  if (sendBtn.classList.contains('sending')) return;

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showSystemMessage('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.');
    return;
  }

  sendBtn.classList.add('sending');
  input.value = '';
  if (photo) clearChatPhoto();
  hideChatSuggestions();

  const displayText = photo ? (text ? `📷 ${text}` : '📷 Foto') : text;
  appendMessage('user', displayText);
  Brain.addChatMessage('user', displayText);

  const thinking = appendMessage('assistant', '…', true);
  const nfcContext = getNfcContext();

  try {
    const context = Brain.buildContext();

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
    const chatMessages = buildMessages(history, text || 'Was siehst du auf diesem Foto?');

    if (photo) {
      const lastMsg = chatMessages[chatMessages.length - 1];
      lastMsg.content = [
        { type: 'image', source: { type: 'base64', media_type: photo.mimeType, data: photo.base64 } },
        { type: 'text', text: text || 'Was siehst du auf diesem Foto?' }
      ];
    }

    const response = await callGemini(apiKey, systemPrompt, chatMessages);
    thinking.remove();

    if (response.includes('##SAVE##')) {
      handleSaveResponse(response);
    } else {
      const { cleanText, actions, foundItems } = processMarkers(response);
      const msgDiv = appendMessage('assistant', cleanText);
      Brain.addChatMessage('assistant', cleanText);
      actions
        .map(normalizeOrdoAction)
        .filter(Boolean)
        .forEach(action => executeOrdoAction(action));
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

  let analysis = null;
  let roomId = 'sonstiges';
  try {
    const jsonMatch = jsonPart.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysis = JSON.parse(jsonMatch[0]);
      roomId = analysis.raumId || 'sonstiges';
    }
  } catch (err) { debugLog(`Legacy-SAVE JSON nicht parsebar: ${err.message}`); }

  if (!analysis) return;

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

export function showSystemMessage(text) {
  const messages = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg chat-msg--system';
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

export function appendSystemMessage(text) {
  showSystemMessage(text);
}

// ── PHOTO PROOF BUTTONS ────────────────────────────────
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

    const room = Brain.getRoom(found.room);
    const container = Brain.getContainer(found.room, containerId);
    const locationName = container?.name || containerId;

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

    btn.textContent = `\uD83D\uDCF7 ${foundItems.length > 1 ? locationName + ' ansehen' : 'Foto ansehen'}`;
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

function showProofLightbox(blob, timestamp, roomId, containerId, itemName) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');

  let proofActions = lb.querySelector('.lightbox-proof-actions');
  if (proofActions) proofActions.remove();
  let proofDate = lb.querySelector('.lightbox-proof-date');
  if (proofDate) proofDate.remove();

  const url = URL.createObjectURL(blob);
  img.src = url;

  if (timestamp) {
    const dateEl = document.createElement('div');
    dateEl.className = 'lightbox-proof-date';
    const photoDate = new Date(timestamp);
    dateEl.textContent = `Aufgenommen am ${photoDate.toLocaleDateString('de-DE')}`;
    lb.appendChild(dateEl);
  }

  const actionsEl = document.createElement('div');
  actionsEl.className = 'lightbox-proof-actions';

  const newPhotoBtn = document.createElement('button');
  newPhotoBtn.className = 'lightbox-proof-btn';
  newPhotoBtn.textContent = 'Neues Foto machen';
  newPhotoBtn.addEventListener('click', () => {
    closeLightbox();
    showView('photo');
    const roomSelect = document.getElementById('photo-room-select');
    if (roomSelect) roomSelect.value = roomId;
  });

  const wrongBtn = document.createElement('button');
  wrongBtn.className = 'lightbox-proof-btn lightbox-proof-btn--secondary';
  wrongBtn.textContent = 'Stimmt nicht mehr';
  wrongBtn.addEventListener('click', () => {
    closeLightbox();
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

// ── VOICE INPUT ────────────────────────────────────────
export function toggleMic() {
  const btn = document.getElementById('chat-mic');
  if (isRecording) {
    if (recognition) recognition.stop();
    isRecording = false;
    btn.classList.remove('recording');
    return;
  }

  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    showToast('Spracheingabe wird von diesem Browser nicht unterstützt.', 'warning');
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

// ── CHAT QUICK-SUGGESTIONS ─────────────────────────────
export function maybeShowChatSuggestions() {
  const messages = document.getElementById('chat-messages');
  const suggestions = document.getElementById('chat-suggestions');
  if (messages.children.length <= 1 || suggestions.children.length === 0) {
    const history = Brain.getChatHistory();
    const lastMsg = history[history.length - 1];
    if (!lastMsg || (Date.now() - lastMsg.ts > 5 * 60 * 1000) || messages.children.length <= 1) {
      renderChatSuggestions();
    }
  }
}

export function renderChatSuggestions() {
  const container = document.getElementById('chat-suggestions');
  container.innerHTML = '';

  if (Brain.isEmpty()) {
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

  const rooms = Brain.getRooms();
  const roomEntries = Object.entries(rooms);
  const suggestions = [];

  if (roomEntries.length > 0) {
    const [, firstRoom] = roomEntries[0];
    suggestions.push(`Was liegt in der ${firstRoom.name}?`);
  }
  if (roomEntries.length > 1) {
    const [, secondRoom] = roomEntries[1];
    suggestions.push(`Zeig mir ${secondRoom.name}`);
  }

  let foundItemName = null;
  for (const [, room] of roomEntries) {
    for (const [, c] of Object.entries(room.containers || {})) {
      const active = (c.items || []).filter(i => typeof i === 'string' || i.status !== 'archiviert');
      if (active.length > 0) {
        foundItemName = Brain.getItemName(active[Math.floor(Math.random() * active.length)]);
        break;
      }
    }
    if (foundItemName) break;
  }
  if (foundItemName) {
    suggestions.push(`Wo ist ${foundItemName}?`);
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

export function sendSuggestion(text) {
  const input = document.getElementById('chat-input');
  input.value = text;
  sendChatMessage();
}

export function hideChatSuggestions() {
  document.getElementById('chat-suggestions').innerHTML = '';
}
