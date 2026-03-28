// chat.js – Chat-UI, Nachrichten senden/empfangen, Spracheingabe

import Brain from './brain.js';
import { callGemini, ORDO_FUNCTIONS, functionCallToAction, processMarkers, executeOrdoAction, normalizeOrdoAction, getErrorMessage, buildMessages, resolveContainerFromPath, loadingManager } from './ai.js';
import { showToast } from './modal.js';
import { debugLog, showView, getNfcContext, ensureRoom } from './app.js';
import { renderBrainView, showLightbox, closeLightbox } from './brain-view.js';
import { resizeImageForChat, renderRoomDropdown } from './photo-flow.js';
import { capturePhoto } from './camera.js';
import { calculateFreedomIndex, getQuickWins } from './organizer.js';

// ── Personality Prompts ───────────────────────────────
const PERSONALITY_PROMPTS = {
  sachlich: 'Antworte sachlich und neutral. Keine Kommentare, nur Fakten. Kurz und präzise.',
  freundlich: 'Antworte freundlich und hilfsbereit. Gelegentlich ein leichter Humor. Warmherzig aber nicht überschwänglich. Kein "Gerne!", kein "Tolle Frage!".',
  kauzig: `Dein Charakter: Wie ein erfahrener Hausmeister — kompetent, direkt, mit trockenem Humor. Du tust gelegentlich so als wäre die Arbeit unter deiner Würde, lieferst dann aber perfekte Antworten.

Stil-Regeln:
- Antworte in maximal 2-3 kurzen Sätzen
- Kein "Gerne!", kein "Tolle Frage!", kein "Ich freue mich"
- Gelegentlich ein trockener Kommentar (nicht bei jeder Antwort)
- Immer korrekt und hilfsbereit trotz des Tons
- Warmherzig unter der rauen Schale

Beispiele für deinen Ton:
- "Die Schere? Küchenschublade, links hinten. Wo sie immer liegt."
- "Du hast drei Scheren in drei verschiedenen Räumen. Ambitioniert. Eine würde auch reichen."
- "Der Oberschrank hat 18 Gegenstände auf einer Fläche für 12. Ich sag ja nur."
- "Kassenbon erkannt: Bohrmaschine, 89,99€, Bauhaus. Garantie läuft noch 8 Monate. Heb den Bon auf."

Beispiele was du NICHT sagst:
- "Ich helfe dir gerne dabei!" — zu generisch
- "Das ist eine tolle Frage!" — Floskel
- "Ich freue mich, dass du fragst!" — unecht
- "Leider kann ich das nicht..." — defensiv
- Beleidigungen, Herablassung — nie

Wichtig: Der Charakter soll Spaß machen und die App sympathisch wirken lassen. Er darf NIEMALS dazu führen dass der Nutzer sich unwohl fühlt. Im Zweifel: Weniger Sarkasmus, mehr Wärme.`
};

export function getPersonalityPrompt() {
  const setting = localStorage.getItem('ordo_personality') || 'kauzig';
  return PERSONALITY_PROMPTS[setting] || PERSONALITY_PROMPTS.kauzig;
}

export function getPersonality() {
  return localStorage.getItem('ordo_personality') || 'kauzig';
}

export function setPersonality(value) {
  if (PERSONALITY_PROMPTS[value]) {
    localStorage.setItem('ordo_personality', value);
  }
}

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
  setupKeyboardHandling();
}

function setupKeyboardHandling() {
  const chatInput = document.getElementById('chat-input');
  const inputRow = document.getElementById('chat-input-row');

  // Scroll input into view when focused (important for Android soft keyboard)
  chatInput.addEventListener('focus', () => {
    setTimeout(() => {
      chatInput.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }, 300);
  });

  // Use visualViewport API to adjust for soft keyboard on mobile
  if (window.visualViewport) {
    let pendingUpdate = false;
    const onViewportResize = () => {
      if (pendingUpdate) return;
      pendingUpdate = true;
      requestAnimationFrame(() => {
        pendingUpdate = false;
        const keyboardOffset = window.innerHeight - window.visualViewport.height;
        if (keyboardOffset > 50) {
          // Keyboard is open — lift input row above keyboard
          inputRow.style.paddingBottom = `${keyboardOffset + 8}px`;
        } else {
          // Keyboard closed — reset to CSS default
          inputRow.style.paddingBottom = '';
        }
        // Keep messages scrolled to bottom
        const messages = document.getElementById('chat-messages');
        messages.scrollTop = messages.scrollHeight;
      });
    };
    window.visualViewport.addEventListener('resize', onViewportResize);
  }
}

function setupChatCamera() {
  const btn = document.getElementById('chat-camera');
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
        'Hmm. Hier ist ja noch nichts. Zeig mir mal einen Raum – ein Foto reicht. Dann weiß ich Bescheid.');
    } else {
      appendMessage('assistant', 'Moin. Was liegt an?');
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

  if (document.getElementById('chat-send')?.disabled) return;

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showSystemMessage('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.');
    return;
  }

  // Disable input while sending
  setSendingState(true);
  input.value = '';
  if (photo) clearChatPhoto();
  hideChatSuggestions();

  const displayText = photo ? (text ? `📷 ${text}` : '📷 Foto') : text;
  appendMessage('user', displayText);
  Brain.addChatMessage('user', displayText);

  // Loading-Bubble mit Phasen-Anzeige
  const taskType = photo ? 'analyzePhoto' : 'chat';
  const loadingBubble = createLoadingBubble();
  const chatContainer = document.getElementById('chat-messages');
  chatContainer.appendChild(loadingBubble);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  const statusEl = loadingBubble.querySelector('.loading-status');
  loadingManager.start(taskType, statusEl);

  const nfcContext = getNfcContext();

  try {
    const context = Brain.buildContext();
    const organizerScore = calculateFreedomIndex();
    const organizerQuickWins = getQuickWins(3)
      .map(win => `- ${win.description} (${win.estimatedMinutes} Min, -${win.impactPoints})`)
      .join('\n') || '- Keine offenen Quick Wins';

    const personality = getPersonalityPrompt();

    let systemPrompt = `Du bist ORDO, der Haushaltsassistent. Du hast den Überblick über diesen Haushalt und weißt wo jedes Teil liegt.

${personality}

Hier ist was du über diesen Haushalt weißt:
${context}

AUFRÄUMKONTEXT:
KOPF-FREIHEITS-INDEX: ${organizerScore.percent}%
OFFENE ENTSCHEIDUNGEN: ${organizerScore.totalDebt}
TOP QUICK WINS:
${organizerQuickWins}

REGELN:
- Antworte immer in maximal 2-3 kurzen Sätzen.
- Wenn du etwas nicht weißt, bitte um ein Foto.
- Wenn der Nutzer nach Aufräumen, Ordnung oder Optimierung fragt: nenne 2-3 Quick Wins und frage, ob er eine Aufräum-Session starten möchte.

AKTIONEN:
Du kannst die Datenbank verändern. Nutze dazu die bereitgestellten Funktionen (Function Calls).
Bevorzuge IMMER Function Calls statt Text-Marker.

Verfügbare Funktionen:
- add_item: Gegenstand hinzufügen (room, container_id, item, menge)
- remove_item: Gegenstand entfernen (room, container_id, item)
- remove_items: Mehrere entfernen (room, container_id, items[])
- move_item: Verschieben (from_room, from_container_id, item, to_room, to_container_id)
- replace_items: Alle Items ersetzen (room, container_id, items[{name, menge}])
- add_room: Neuen Raum anlegen (room, name, emoji)
- add_container: Neuen Behälter anlegen (room, container_id, name, typ)
- delete_container: Behälter löschen (room, container_id)
- rename_container: Umbenennen (room, container_id, new_name)
- delete_room: Raum löschen (room)
- show_found_item: Zeige wo ein Gegenstand liegt (item, room, container_id)

WICHTIG:
- Bei destruktiven Aktionen (delete_container, delete_room): IMMER erst nachfragen, dann erst beim nächsten Turn die Funktion aufrufen.
- Bei einfachen Änderungen: Direkt ausführen + bestätigen.
- Wenn du unsicher bist welcher Behälter gemeint ist: Frage nach, keine Aktion.
- Bei show_found_item: Nenne den Ort UND rufe die Funktion auf. Die App zeigt dann automatisch einen Foto-Button.
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

    const response = await callGemini(apiKey, systemPrompt, chatMessages, { tools: ORDO_FUNCTIONS, taskType, hasImage: !!photo });
    loadingBubble.remove();
    loadingManager.stop();

    // Extract text and function calls
    const responseText = response.text || '';
    const functionCalls = response.functionCalls || [];

    // Process function calls (preferred over markers)
    const fcActions = [];
    const fcFoundItems = [];
    for (const call of functionCalls) {
      const action = functionCallToAction(call);
      if (!action) continue;
      if (action.type === 'found') {
        fcFoundItems.push(action);
      } else {
        fcActions.push(action);
      }
    }

    // Fallback: parse legacy markers from text if no function calls
    let cleanText = responseText;
    let markerActions = [];
    let markerFoundItems = [];
    if (fcActions.length === 0 && fcFoundItems.length === 0 && responseText) {
      if (responseText.includes('##SAVE##')) {
        handleSaveResponse(responseText);
        // handleSaveResponse does its own message display, skip below
        cleanText = '';
      } else {
        const parsed = processMarkers(responseText);
        cleanText = parsed.cleanText;
        markerActions = parsed.actions;
        markerFoundItems = parsed.foundItems;
      }
    } else if (responseText) {
      // Strip markers from text even when function calls exist
      cleanText = processMarkers(responseText).cleanText;
    }

    // Combine: function calls take priority, fallback markers supplement
    const allActions = fcActions.length > 0 ? fcActions : markerActions;
    const allFoundItems = fcFoundItems.length > 0 ? fcFoundItems : markerFoundItems;

    if (cleanText) {
      const msgDiv = appendMessage('assistant', cleanText);
      Brain.addChatMessage('assistant', cleanText);
      if (allFoundItems.length > 0) {
        renderFoundPhotoButtons(msgDiv, allFoundItems);
      }
    }

    // Execute actions
    allActions
      .map(normalizeOrdoAction)
      .filter(Boolean)
      .forEach(action => executeOrdoAction(action));
  } catch (err) {
    loadingBubble.remove();
    loadingManager.stop();
    showSystemMessage(getErrorMessage(err));
  } finally {
    setSendingState(false);
  }
}

function createLoadingBubble() {
  const bubble = document.createElement('div');
  bubble.classList.add('chat-msg', 'chat-msg--assistant', 'loading-bubble');
  bubble.innerHTML = `
    <div class="loading-dots">
      <span></span><span></span><span></span>
    </div>
    <div class="loading-status">Denke nach...</div>
  `;
  return bubble;
}

function setSendingState(isSending) {
  const btn = document.getElementById('chat-send');
  const input = document.getElementById('chat-input');
  if (!btn || !input) return;
  btn.disabled = isSending;
  input.disabled = isSending;
  if (isSending) {
    btn.classList.add('sending');
  } else {
    btn.classList.remove('sending');
    input.focus();
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
