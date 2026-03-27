// ai.js – Gemini-Kommunikation, Prompts, Response-Parsing, Action-Ausführung
// Keinerlei direkter DOM-Zugriff. Importiert DOM-Funktionen aus anderen Modulen.

import Brain from './brain.js';
import { debugLog, ensureRoom } from './app.js';
import { showSystemMessage } from './chat.js';
import { renderBrainView } from './brain-view.js';

export const MODEL = 'gemini-3-flash-preview';
export const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';
export const FILE_API_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
export const FILE_API_GET_URL = 'https://generativelanguage.googleapis.com/v1beta/files';
export const MAX_VIDEO_DURATION_SEC = 300;
export const MAX_VIDEO_SIZE_MB = 200;

// ── Gemini API ─────────────────────────────────────────
export async function callGemini(apiKey, systemPrompt, messages) {
  if (!navigator.onLine) {
    debugLog('FEHLER: Gerät ist offline (navigator.onLine = false)');
    throw new Error('offline');
  }

  const keyPreview = apiKey ? apiKey.slice(0, 8) + '…' : '(leer)';
  debugLog(`Anfrage starten → Modell: ${MODEL}, Key: ${keyPreview}`);

  const geminiContents = messages.map(msg => {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof msg.content === 'string') {
      parts = [{ text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      parts = msg.content.map(item => {
        if (item.type === 'image') {
          return { inlineData: { mimeType: item.source.media_type, data: item.source.data } };
        } else if (item.type === 'file') {
          return { fileData: { fileUri: item.source.uri, mimeType: item.source.mimeType } };
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
    if (response.status === 403) throw new Error('api_key');
    if (response.status === 400) throw new Error('bad_request');
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

export function getErrorMessage(err) {
  if (err.message === 'offline') return 'Ich bin gerade offline. Deine gespeicherten Infos kann ich dir trotzdem zeigen.';
  if (err.message === 'api_key') return 'API Key ungültig oder abgelaufen. Bitte in den Einstellungen prüfen.';
  if (err.message === 'bad_request') return 'Anfrage ungültig – Foto zu groß oder falsches Format. Bitte ein anderes Foto versuchen.';
  if (err.message === 'quota') return 'Tageslimit der kostenlosen Google AI API erreicht (429). Bitte morgen wieder versuchen oder ein bezahltes Konto nutzen.';
  if (err.message === 'safety_block') return 'Das Foto wurde vom Sicherheitsfilter blockiert. Bitte ein anderes Foto versuchen.';
  if (err.message === 'max_tokens') return 'Antwort zu lang – bitte ein übersichtlicheres Foto wählen.';
  if (err.message === 'Kein JSON in Antwort') return 'Die KI hat keine auswertbare Antwort geliefert. Bitte nochmal versuchen.';
  if (err.message?.includes('Video zu groß')) return err.message;
  if (err.message?.includes('Video-Verarbeitung') || err.message?.includes('Timeout')) return err.message;
  if (err.message?.includes('too large') || err.message?.includes('size')) return 'Datei zu groß – bitte eine kleinere wählen oder Auflösung reduzieren.';
  if (err instanceof SyntaxError || err.message?.includes('JSON')) return 'Antwort war unvollständig – bitte nochmal versuchen.';
  if (err instanceof TypeError) return 'Keine Internetverbindung. Versuch es gleich nochmal.';
  if (err.message?.startsWith('HTTP 5')) return 'Der KI-Dienst ist gerade nicht erreichbar. Versuch es später.';
  return 'Kurze Verbindungsstörung – bitte nochmal versuchen.';
}

// ── Message Building ───────────────────────────────────
export function buildMessages(history, newUserText) {
  const msgs = [];
  let lastRole = null;
  for (const m of history) {
    if (m.role !== lastRole) {
      msgs.push({ role: m.role, content: m.content });
      lastRole = m.role;
    }
  }
  if (lastRole === 'user') {
    msgs.push({ role: 'assistant', content: '…' });
  }
  msgs.push({ role: 'user', content: newUserText });
  return msgs;
}

// ── UNIFIED ORDO MARKER SYSTEM ─────────────────────────
export function processMarkers(text) {
  const actions = [];
  const foundItems = [];

  let cleanText = text.replace(/<!--ORDO:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const marker = JSON.parse(jsonStr.trim());
      if (marker.type === 'found') {
        foundItems.push(marker);
      } else {
        actions.push(marker);
      }
    } catch (err) { debugLog(`ORDO-Marker ungültig: ${err.message} – ${jsonStr.slice(0, 100)}`); }
    return '';
  });

  cleanText = cleanText.replace(/<!--SAVE:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const action = JSON.parse(jsonStr.trim());
      const converted = convertLegacySaveToOrdo(action);
      if (converted) actions.push(converted);
    } catch (err) { debugLog(`Legacy-SAVE Marker ungültig: ${err.message}`); }
    return '';
  });

  cleanText = cleanText.replace(/<!--ACTION:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const action = JSON.parse(jsonStr.trim());
      const converted = convertLegacyActionToOrdo(action);
      if (converted) actions.push(converted);
    } catch (err) { debugLog(`Legacy-ACTION Marker ungültig: ${err.message}`); }
    return '';
  });

  cleanText = cleanText.replace(/<!--FOUND:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const item = JSON.parse(jsonStr.trim());
      if (item.room && item.container) {
        foundItems.push({ type: 'found', room: item.room, path: [item.container], item: item.item });
      }
    } catch (err) { debugLog(`Legacy-FOUND Marker ungültig: ${err.message}`); }
    return '';
  });

  return { cleanText: cleanText.trim(), actions, foundItems };
}

export function convertLegacySaveToOrdo(action) {
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

export function convertLegacyActionToOrdo(action) {
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

export function resolveContainerFromPath(roomId, path) {
  if (!path || path.length === 0) return null;
  return path[path.length - 1];
}

// ── normalizeOrdoAction – Action-Härtung gegen Prompt-Injection ──
const ALLOWED_FIELDS = {
  add_item:         ['type', 'room', 'path', 'item', 'menge'],
  remove_item:      ['type', 'room', 'path', 'item'],
  remove_items:     ['type', 'room', 'path', 'items'],
  replace_items:    ['type', 'room', 'path', 'items'],
  move_item:        ['type', 'from_room', 'from_path', 'to_room', 'to_path', 'item'],
  add_container:    ['type', 'room', 'path', 'id', 'name', 'typ'],
  delete_container: ['type', 'room', 'path'],
  rename_container: ['type', 'room', 'path', 'new_name'],
  delete_room:      ['type', 'room']
};

export function normalizeOrdoAction(raw) {
  // 1. Must be a non-null object with a string type
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;

  const type = raw.type.trim();

  // 5. Reject unknown types
  if (!ALLOWED_FIELDS[type]) return null;

  const allowed = ALLOWED_FIELDS[type];
  const result = { type };

  // 7. Only allow whitelisted fields
  for (const key of allowed) {
    if (key === 'type') continue;
    if (raw[key] === undefined) continue;

    let val = raw[key];

    // 2. Trim all string fields
    if (typeof val === 'string') {
      val = val.trim();
      if (!val) continue; // skip empty strings
    }

    // 3. Clean path arrays (remove empty strings)
    if (key === 'path' || key === 'from_path' || key === 'to_path') {
      if (Array.isArray(val)) {
        val = val.map(s => typeof s === 'string' ? s.trim() : s).filter(s => s !== '');
      } else {
        continue; // skip non-array paths
      }
    }

    // 3. Clean items arrays
    if (key === 'items' && Array.isArray(val)) {
      val = val.filter(item => {
        if (typeof item === 'string') return item.trim() !== '';
        if (typeof item === 'object' && item !== null) return true;
        return false;
      }).map(item => {
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'object' && item !== null) {
          const cleaned = {};
          if (typeof item.name === 'string') cleaned.name = item.name.trim();
          if (item.menge !== undefined) cleaned.menge = Math.max(1, parseInt(item.menge) || 1);
          return cleaned;
        }
        return item;
      });
    }

    // 4. Normalize menge to at least 1
    if (key === 'menge') {
      val = Math.max(1, parseInt(val) || 1);
    }

    result[key] = val;
  }

  // 6. Destructive action checks: target must exist
  if (type === 'delete_room') {
    if (!result.room || !Brain.getRoom(result.room)) return null;
  }
  if (type === 'delete_container') {
    const cId = resolveContainerFromPath(result.room, result.path);
    if (!result.room || !Brain.getRoom(result.room) || !cId || !Brain.getContainer(result.room, cId)) return null;
  }

  return result;
}

// ── Action Executor ────────────────────────────────────
export function executeOrdoAction(action) {
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
          if (action.menge && action.menge > 1) {
            const data = Brain.getData();
            const c = Brain._findContainerInTree(data.rooms?.[action.room]?.containers, containerId);
            if (c) {
              if (!c.quantities) c.quantities = {};
              c.quantities[action.item] = action.menge;
              const itemObj = c.items.find(i => Brain.getItemName(i) === action.item);
              if (itemObj && typeof itemObj === 'object') itemObj.menge = action.menge;
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
          cont.items = (action.items || []).map(i => {
            const name = typeof i === 'string' ? i : i.name;
            const menge = typeof i === 'object' ? Math.max(1, parseInt(i.menge) || 1) : 1;
            return Brain.createItemObject(name, { menge });
          });
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

// ── Retry Fetch ────────────────────────────────────────
export async function fetchWithRetry(url, options, maxRetries = 3, label = 'Request') {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status === 400 || res.status === 403 || res.status === 404) return res;
      if (attempt < maxRetries && (res.status >= 500 || res.status === 429)) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        debugLog(`${label}: HTTP ${res.status} – Retry ${attempt + 1}/${maxRetries} in ${wait / 1000}s…`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < maxRetries) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        debugLog(`${label}: Netzwerkfehler – Retry ${attempt + 1}/${maxRetries} in ${wait / 1000}s… (${err.message})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

export async function uploadVideoToGemini(apiKey, file, onProgress) {
  const sizeMB = file.size / (1024 * 1024);
  debugLog(`Video-Upload gestartet: ${file.name} (${sizeMB.toFixed(1)} MB, ${file.type})`);

  if (sizeMB > MAX_VIDEO_SIZE_MB) {
    throw new Error(`Video zu groß (${Math.round(sizeMB)} MB). Maximum: ${MAX_VIDEO_SIZE_MB} MB.`);
  }

  onProgress?.('upload', 0);

  debugLog('Starte resumable Upload-Session…');
  const startRes = await fetchWithRetry(`${FILE_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': file.size,
      'X-Goog-Upload-Header-Content-Type': file.type,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { displayName: file.name } })
  }, 3, 'Upload-Start');

  if (!startRes.ok) {
    const errText = await startRes.text().catch(() => '');
    debugLog(`Upload-Start fehlgeschlagen: HTTP ${startRes.status} – ${errText}`);
    if (startRes.status === 400 || startRes.status === 403) throw new Error('api_key');
    throw new Error(`Upload-Start fehlgeschlagen: HTTP ${startRes.status} – ${errText}`);
  }

  const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('Kein Upload-URL erhalten');
  debugLog('Upload-URL erhalten. Starte Chunk-Upload…');

  const CHUNK_SIZE = 8 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let offset = 0;

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    const isLast = chunkIdx === totalChunks - 1;
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(offset, end);
    const command = isLast ? 'upload, finalize' : 'upload';

    debugLog(`Chunk ${chunkIdx + 1}/${totalChunks} senden (${(offset / 1024 / 1024).toFixed(1)}–${(end / 1024 / 1024).toFixed(1)} MB)…`);

    const chunkController = new AbortController();
    const chunkTimeout = setTimeout(() => chunkController.abort(), 120000);
    let chunkRes;
    try {
      chunkRes = await fetchWithRetry(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': end - offset,
          'X-Goog-Upload-Offset': String(offset),
          'X-Goog-Upload-Command': command
        },
        body: chunkBlob,
        signal: chunkController.signal
      }, 4, `Chunk ${chunkIdx + 1}/${totalChunks}`);
    } catch (err) {
      clearTimeout(chunkTimeout);
      if (err.name === 'AbortError') throw new Error('Timeout beim Video-Upload – Verbindung zu langsam.');
      throw err;
    }
    clearTimeout(chunkTimeout);

    if (!chunkRes.ok) {
      const errText = await chunkRes.text().catch(() => '');
      debugLog(`Chunk-Upload fehlgeschlagen: HTTP ${chunkRes.status} – ${errText}`);
      throw new Error(`Video-Upload fehlgeschlagen bei Chunk ${chunkIdx + 1}/${totalChunks}: HTTP ${chunkRes.status} – ${errText}`);
    }

    offset = end;
    const uploadPct = Math.round(((chunkIdx + 1) / totalChunks) * 45);
    onProgress?.('upload', uploadPct);

    if (isLast) {
      const uploadData = await chunkRes.json();
      debugLog(`Upload abgeschlossen. Response: ${JSON.stringify(uploadData).slice(0, 300)}`);
      const fileObj = uploadData.file;
      if (!fileObj?.name) throw new Error('Keine Datei-Referenz erhalten');

      onProgress?.('processing', 50);
      debugLog(`Datei hochgeladen: ${fileObj.name}. Warte auf Verarbeitung…`);

      let attempts = 0;
      const maxAttempts = 48; // 48 × 2.5s = 120s timeout
      let pollErrors = 0;

      // fileObj.name is e.g. "files/abc123" – strip "files/" prefix to avoid double "files/" in URL
      const fileId = fileObj.name.startsWith('files/') ? fileObj.name.slice(6) : fileObj.name;

      while (attempts < maxAttempts) {
        const pollUrl = `${FILE_API_GET_URL}/${fileId}?key=${apiKey}`;
        debugLog(`Poll-URL: ${pollUrl}`);
        const checkRes = await fetchWithRetry(
          pollUrl,
          {}, 2, 'Status-Poll'
        );

        if (!checkRes.ok) {
          pollErrors++;
          const errText = await checkRes.text().catch(() => '');
          debugLog(`Status-Abfrage fehlgeschlagen: HTTP ${checkRes.status} – ${errText}`);
          if (pollErrors >= 5) throw new Error(`Status-Abfrage fehlgeschlagen nach ${pollErrors} Fehlern: HTTP ${checkRes.status}`);
          await new Promise(r => setTimeout(r, 3000));
          attempts++;
          continue;
        }

        const checkData = await checkRes.json();
        const state = checkData.state;
        debugLog(`Poll #${attempts + 1}: state=${state}`);

        if (state === 'ACTIVE') {
          debugLog(`Datei bereit: ${checkData.uri}`);
          onProgress?.('ready', 100);
          return { fileUri: checkData.uri, mimeType: checkData.mimeType, fileName: fileObj.name };
        }
        if (state === 'FAILED') {
          debugLog(`Verarbeitung fehlgeschlagen. Response: ${JSON.stringify(checkData).slice(0, 300)}`);
          throw new Error('Video-Verarbeitung fehlgeschlagen. Bitte ein kürzeres Video versuchen.');
        }

        attempts++;
        const progress = 50 + Math.min(45, (attempts / maxAttempts) * 45);
        onProgress?.('processing', progress);
        await new Promise(r => setTimeout(r, 2500));
      }

      throw new Error('Video-Verarbeitung dauert zu lange (Timeout nach 120 s). Bitte ein kürzeres Video versuchen oder stattdessen einzelne Fotos verwenden.');
    }
  }
}

export async function deleteGeminiFile(apiKey, fileName) {
  try {
    const fileId = fileName.startsWith('files/') ? fileName.slice(6) : fileName;
    await fetch(`${FILE_API_GET_URL}/${fileId}?key=${apiKey}`, { method: 'DELETE' });
  } catch (err) { debugLog(`Gemini-Datei löschen fehlgeschlagen: ${err.message}`); }
}

export function checkForItemExtraction(userText, assistantResponse) {
  // Handled via <!--SAVE:--> markers in the AI response
}

// ── Valuation ─────────────────────────────────────────

// Batch estimate replacement values for items without price (text-only, no photos)
export async function batchEstimateValues(apiKey, items) {
  if (!items || items.length === 0) return [];

  const CHUNK_SIZE = 100;
  const allResults = [];

  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const itemList = chunk.map(item =>
      `- ${item.name}${item.menge > 1 ? ` (${item.menge}x)` : ''} – ${item.roomName} > ${item.containerName}`
    ).join('\n');

    const prompt = `Du bist ein Versicherungsberater. Schätze den Wiederbeschaffungswert (Neupreis in Deutschland, 2026) für folgende Haushaltsgegenstände.

Antworte NUR mit JSON-Array:
[
  {
    "name": "Exakter Name wie in der Liste",
    "replacement_value": Zahl,
    "replacement_range": [min, max],
    "confidence": "hoch" | "mittel" | "niedrig"
  }
]

Regeln:
- Neupreis = Was kostet ein vergleichbares Produkt heute neu im deutschen Einzelhandel?
- Bei Mengenangaben (z.B. "5x Teller"): Einzelpreis angeben, nicht Gesamtpreis
- Bei Kleinkram < 3€: replacement_value: 0
- Wenn du keine sinnvolle Schätzung machen kannst: replacement_value: null
- Sei konservativ – lieber etwas höher schätzen

Gegenstände:
${itemList}`;

    const messages = [{ role: 'user', content: prompt }];
    const raw = await callGemini(apiKey, 'Du bist ein Versicherungsberater für Hausratversicherungen. Antworte nur mit JSON.', messages);

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        allResults.push(...parsed);
      } catch { /* chunk parse failed */ }
    }
  }

  return allResults;
}

// Estimate single item value using container photo
export async function estimateSingleItemValue(apiKey, imageBase64, itemName) {
  const prompt = `Du siehst ein Foto eines Aufbewahrungsorts. Darin befindet sich: "${itemName}".

Schätze den Wiederbeschaffungswert (Neupreis heute in Euro) für diesen Gegenstand.

Antworte NUR mit JSON:
{
  "replacement_value": Zahl oder null,
  "replacement_range": [min, max] oder null,
  "brand_model": "Erkannte Marke/Modell" oder null,
  "confidence": "hoch" | "mittel" | "niedrig"
}

Regeln:
- Wenn du Marke/Modell erkennen kannst, nenne sie
- Gib immer eine Bandbreite an
- Bei Kleinkram unter 5€ → null
- Wenn unsicher → replacement_value: null`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ]
  }];

  const response = await callGemini(apiKey, 'Du bist ein Wertgutachter. Antworte nur mit JSON.', messages);
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Kein JSON in Antwort');
  return JSON.parse(jsonMatch[0]);
}

// ── Receipt Analysis ──────────────────────────────────
export async function analyzeReceipt(apiKey, imageBase64, itemName) {
  const prompt = `Du siehst ein Foto eines Kassenbons oder einer Rechnung.
Extrahiere folgende Informationen soweit erkennbar:

1. Kaufdatum
2. Gesamtbetrag oder Einzelpreis für "${itemName}" falls sichtbar
3. Name des Geschäfts / Händlers
4. Garantiehinweise falls auf dem Bon sichtbar

Antworte NUR mit JSON:
{
  "date": "YYYY-MM-DD" oder null,
  "price": Zahl oder null,
  "store": "Name" oder null,
  "warranty_hint": "Text" oder null,
  "confidence": "hoch" | "mittel" | "niedrig",
  "hinweis": "Freitext falls etwas unklar ist"
}

Wenn du das Datum nicht im Format YYYY-MM-DD lesen kannst,
gib es so an wie du es liest und setze confidence auf "niedrig".
Wenn der Bon unleserlich oder verblasst ist, sag das im Hinweis.
Wenn das Foto kein Kassenbon ist, antworte mit:
{ "error": "Das sieht nicht nach einem Kassenbon aus." }`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ]
  }];

  const response = await callGemini(apiKey, 'Du bist ein Kassenbon-Scanner. Antworte nur mit JSON.', messages);

  // Extract JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Kein JSON in Antwort');

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error('Kein JSON in Antwort');
  }
}

// ── Blueprint Analysis ────────────────────────────────────
// Analyzes multiple room photos in one call to detect rooms + furniture

export async function analyzeBlueprint(apiKey, roomPhotos) {
  // roomPhotos: [{ base64, mimeType, userLabel }]
  const prompt = `Du siehst ${roomPhotos.length} Überblicksfotos einer Wohnung.
Jedes Foto zeigt einen anderen Raum aus der Türperspektive.

Analysiere ALLE Fotos und erstelle die komplette Struktur der Wohnung.

Identifiziere pro Raum:
1. Raumtyp und Name (Küche, Bad, Schlafzimmer, etc.)
2. Jedes sichtbare Möbelstück oder Aufbewahrungssystem (Schränke, Regale, Kommoden, Vitrinen, Sideboards...)
3. Erkennbare Unterteilungen wenn sichtbar (Türen, Schubladen, Fächer – nur wenn klar sichtbar)
4. Ungefähre Position des Möbels im Raum ("linke Wand", "neben dem Fenster", "gegenüber der Tür")

Antworte NUR mit JSON:
{
  "wohnung_typ": "Wohnung" | "Haus" | "Apartment" | "WG",
  "raeume": [
    {
      "foto_index": 0,
      "id": "kueche",
      "name": "Küche",
      "emoji": "🍳",
      "merkmale": "hell, Fenster zur Straße, Fliesenboden",
      "moebel": [
        {
          "id": "kuechenzeile_ober",
          "name": "Oberschränke Küchenzeile",
          "typ": "schrank",
          "position": "linke Wand",
          "unterteilungen": ["3 Türen"],
          "prioritaet": "hoch"
        }
      ]
    }
  ],
  "zusammenfassung": "3-Zimmer-Wohnung mit X Räumen und Y Aufbewahrungsmöbeln erkannt."
}

Regeln:
- "prioritaet" ist "hoch" für große Möbel mit viel Stauraum, "mittel" für kleinere, "niedrig" für offene Regale/Ablagen
- Ignoriere Infrastruktur (Heizkörper, Steckdosen, Lampen)
- Ignoriere Elektrogeräte die keine Aufbewahrung sind (Fernseher, Waschmaschine)
- Wenn du unsicher bist ob etwas ein Schrank oder ein Deko-Möbel ist, nimm es trotzdem auf
- IDs: Kleinbuchstaben, Unterstriche, eindeutig pro Wohnung
- Emojis: Verwende passende Raum-Emojis
- moebel.typ muss sein: schrank, regal, schublade, kiste, tisch, kommode, sonstiges
${roomPhotos.map((p, i) =>
  p.userLabel ? `Foto ${i}: Nutzer sagt "${p.userLabel}"` : ''
).filter(Boolean).join('\n')}`;

  const imageContents = roomPhotos.map(p => ({
    type: 'image',
    source: { type: 'base64', media_type: p.mimeType || 'image/jpeg', data: p.base64 }
  }));

  const messages = [{
    role: 'user',
    content: [
      ...imageContents,
      { type: 'text', text: `Analysiere diese ${roomPhotos.length} Raumfotos und erstelle die Wohnungsstruktur.` }
    ]
  }];

  const raw = await callGemini(apiKey, prompt, messages);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Kein JSON in Antwort');
  return JSON.parse(jsonMatch[0]);
}
