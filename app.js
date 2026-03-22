// app.js – Main application logic

const MODEL = 'gemini-2.0-flash';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// ── State ──────────────────────────────────────────────
let currentView = 'chat';
let recognition = null;
let isRecording = false;
let nfcContext = null; // { room, tag } from URL params

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
  showView('chat');
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
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
  if (name === 'photo') renderRoomDropdown('photo-room-select');
}

// ── CHAT VIEW ──────────────────────────────────────────
function setupChat() {
  document.getElementById('chat-send').addEventListener('click', sendChatMessage);
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  document.getElementById('chat-mic').addEventListener('click', toggleMic);
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
  if (!text) return;

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    appendMessage('assistant', 'API Key nicht gesetzt. Bitte in den Einstellungen eintragen.');
    return;
  }

  input.value = '';
  appendMessage('user', text);
  Brain.addChatMessage('user', text);

  const thinking = appendMessage('assistant', '…', true);

  try {
    const context = Brain.buildContext();
    const systemPrompt = `Du bist ein stiller Haushaltsassistent.
Hier ist was du über diesen Haushalt weißt:
${context}

Antworte immer in maximal 2 kurzen Sätzen.
Wenn du etwas nicht weißt, sag es direkt und bitte den Nutzer ein Foto zu machen.
Wenn der Nutzer einen Gegenstand erwähnt den du noch nicht kennst, frage kurz nach wo er ist und speichere es.
Antworte immer auf Deutsch.`;

    const history = Brain.getChatHistory().slice(-20).map(m => ({ role: m.role, content: m.content }));
    // ensure alternating roles
    const messages = buildMessages(history, text);

    const response = await callClaude(apiKey, systemPrompt, messages);
    thinking.remove();
    appendMessage('assistant', response);
    Brain.addChatMessage('assistant', response);

    // Check if AI asks for location → could trigger info extraction later
    checkForItemExtraction(text, response);
  } catch (err) {
    thinking.remove();
    appendMessage('assistant', getErrorMessage(err));
  }
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
  // Simple heuristic: if user mentions an item location, we could extract it
  // This is handled conversationally by the AI
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

async function handlePhotoFile(file) {
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

  const roomId = document.getElementById('photo-room-select').value;
  if (!roomId) {
    showPhotoStatus('Bitte zuerst einen Raum wählen.', 'error');
    return;
  }

  const customName = document.getElementById('photo-custom-name').value.trim();

  // Show preview
  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result.split(',')[1];
    const mimeType = file.type || 'image/jpeg';

    // Show preview image
    const preview = document.getElementById('photo-preview');
    preview.src = e.target.result;
    preview.style.display = 'block';

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
      "inhalt": ["erkannter Gegenstand 1", "Gegenstand 2"]
    }
  ],
  "lose_gegenstaende": ["Gegenstand außerhalb Behälter"],
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

      const raw = await callClaude(apiKey, systemPrompt, messages);

      // Extract JSON from response
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Kein JSON in Antwort');

      const analysis = JSON.parse(jsonMatch[0]);

      // If custom name given, rename/add main container
      if (customName && analysis.behaelter?.length > 0) {
        analysis.behaelter[0].name = customName;
        analysis.behaelter[0].id = Brain.slugify(customName);
      }

      const count = Brain.applyPhotoAnalysis(roomId, analysis);
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

// ── BRAIN VIEW ─────────────────────────────────────────
function setupBrain() {
  document.getElementById('brain-add-room').addEventListener('click', showAddRoomDialog);
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
  });

  setupLongPress(header, () => showContainerContextMenu(roomId, cId, c));

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

  body.appendChild(chips);
  body.appendChild(addItemBtn);
  el.appendChild(header);
  el.appendChild(body);
  return el;
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

  document.getElementById('settings-export').addEventListener('click', () => {
    Brain.exportData();
  });

  document.getElementById('settings-import').addEventListener('click', () => {
    document.getElementById('settings-import-file').click();
  });

  document.getElementById('settings-import-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Vorhandene Daten werden überschrieben – fortfahren?')) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const ok = Brain.importData(ev.target.result);
      if (ok) {
        showSettingsMsg('Haushalt erfolgreich geladen.', 'success');
        renderBrainView();
      } else {
        showSettingsMsg('Import fehlgeschlagen – ungültiges Format.', 'error');
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('settings-reset').addEventListener('click', () => {
    if (confirm('Wirklich alles zurücksetzen? Alle Daten gehen verloren.')) {
      Brain.resetAll();
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
      const result = await callClaude(apiKey, 'Du bist ein Testassistent.', [
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
  const el = document.getElementById('debug-log');
  if (!el) return;
  const ts = new Date().toLocaleTimeString('de-DE');
  const current = el.textContent === '— noch kein Log —' ? '' : el.textContent;
  el.textContent = `[${ts}] ${msg}\n${current}`;
}

// ── GEMINI API ─────────────────────────────────────────
async function callClaude(apiKey, systemPrompt, messages) {
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
        generationConfig: { maxOutputTokens: 1024 }
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
    if (response.status === 400 || response.status === 403) throw new Error('api_key');
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  debugLog(`Antwort OK – ${text.length} Zeichen`);
  return text;
}

function getErrorMessage(err) {
  if (err.message === 'offline') return 'Ich bin gerade offline. Deine gespeicherten Infos kann ich dir trotzdem zeigen.';
  if (err.message === 'api_key') return 'API Key ungültig oder nicht gesetzt (401). Bitte in den Einstellungen prüfen.';
  if (err.message?.includes('too large') || err.message?.includes('size')) return 'Foto zu groß – bitte ein kleineres wählen oder Auflösung reduzieren.';
  return 'Kurze Verbindungsstörung – bitte nochmal versuchen.';
}

// ── LONG PRESS ─────────────────────────────────────────
function setupLongPress(el, callback) {
  let timer;
  el.addEventListener('pointerdown', () => { timer = setTimeout(callback, 600); });
  el.addEventListener('pointerup', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => clearTimeout(timer));
}
