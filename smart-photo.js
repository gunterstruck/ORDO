// smart-photo.js – Smart Photo Capture & Result UI
// Foto von überall: KI erkennt Raum, Container und Items automatisch

import Brain from './brain.js';
import { callGemini, loadingManager, getErrorMessage, uploadVideoToGemini, deleteGeminiFile, MAX_VIDEO_SIZE_MB } from './ai.js';
import { capturePhoto, captureVideo } from './camera.js';
import { blobToBase64, resizeImage } from './photo-flow.js';
import { showToast } from './modal.js';
import { ROOM_TYPES, ensureRoom, debugLog, escapeHTML } from './app.js';

// ── Smart Photo Prompt ──────────────────────────────
function buildSmartPhotoPrompt() {
  const data = Brain.getData();
  const rooms = data?.rooms || {};
  const existingRooms = Object.entries(rooms)
    .map(([id, r]) => {
      const containerList = Object.entries(r.containers || {})
        .map(([cId, c]) => `${cId} ("${c.name}")`)
        .join(', ');
      return `${id}: ${r.name} (Container: ${containerList || 'keine'})`;
    })
    .join('\n');

  return `Du siehst ein Foto aus einem Haushalt. Analysiere:

1. WELCHER RAUM ist das? (Küche, Bad, Schlafzimmer, etc.)
2. WELCHER CONTAINER/MÖBEL ist das? (Schrank, Regal, Schublade, etc.)
3. WELCHE GEGENSTÄNDE sind sichtbar?

BESTEHENDE RÄUME UND CONTAINER IM HAUSHALT:
${existingRooms || '(noch keine Räume angelegt)'}

Falls du einen bestehenden Raum erkennst, nutze dessen ID.
Falls du einen bestehenden Container erkennst, nutze dessen ID.
Falls es ein neuer Raum ist, schlage einen passenden Slug als ID vor (z.B. "kueche", "bad", "arbeitszimmer").

RAUM-TYPEN (verwende diese IDs): kueche, bad, schlafzimmer, wohnzimmer, arbeitszimmer, kinderzimmer, flur, keller, abstellraum, garage, esszimmer, ankleide, dachboden, garten, gaestezimmer, sonstiges

Antworte NUR mit JSON:
{
  "room": {
    "id": "kueche",
    "name": "Küche",
    "emoji": "🍳",
    "is_new": false
  },
  "container": {
    "id": "oberschrank",
    "name": "Oberschrank",
    "typ": "schrank",
    "is_new": true
  },
  "items": [
    { "name": "Teller", "menge": 8 },
    { "name": "Tassen", "menge": 6 }
  ],
  "description": "Oberschrank in der Küche mit Geschirr"
}

Regeln:
- container.typ muss sein: schrank, regal, schublade, kiste, tisch, kommode, sonstiges
- container.id: Kleinbuchstaben, keine Umlaute (ae, oe, ue, ss), Unterstriche statt Leerzeichen
- room.id: verwende bestehende ID wenn Raum existiert, sonst slug
- items: Nur klar sichtbare Gegenstände, keine Vermutungen
- menge: Geschätzte Anzahl (1 wenn unklar)`;
}

// ── Smart Photo Capture Flow ────────────────────────
export async function startSmartPhotoCapture() {
  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showToast('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.', 'warning');
    return;
  }

  // 1. Foto aufnehmen
  const file = await capturePhoto();
  if (!file) return;

  // 2. Resize & convert
  let resizedBlob;
  try {
    resizedBlob = await resizeImage(file, 1200, { quality: 0.7 });
  } catch {
    resizedBlob = file;
  }
  const base64 = await blobToBase64(resizedBlob);
  const mimeType = resizedBlob.type || 'image/jpeg';

  // 3. Show loading overlay
  showSmartPhotoLoading();

  try {
    // 4. Call AI
    const prompt = buildSmartPhotoPrompt();
    const messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: 'Analysiere dieses Foto. Erkenne Raum, Möbelstück und Gegenstände.' }
      ]
    }];

    const raw = await callGemini(apiKey, prompt, messages, {
      taskType: 'analyzePhoto',
      hasImage: true
    });

    const responseText = typeof raw === 'string' ? raw : raw.text || JSON.stringify(raw);
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Kein JSON in Antwort');

    const analysis = JSON.parse(jsonMatch[0]);

    // 5. Show result UI
    showSmartPhotoResult(analysis, resizedBlob, base64, mimeType);

  } catch (err) {
    hideSmartPhotoOverlay();
    debugLog(`Smart Photo Fehler: ${err.message}`);
    showToast('Foto konnte nicht analysiert werden: ' + getErrorMessage(err), 'error');
  }
}

// ── Loading Overlay ─────────────────────────────────
function showSmartPhotoLoading() {
  let overlay = document.getElementById('smart-photo-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'smart-photo-overlay';
    overlay.className = 'smart-photo-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="smart-photo-modal">
      <div class="smart-photo-loading">
        <div class="loading-dots"><span></span><span></span><span></span></div>
        <p id="smart-photo-status">Foto wird analysiert...</p>
      </div>
    </div>
  `;
  overlay.style.display = 'flex';

  // Feedback bei langsamer API direkt im Overlay aktualisieren
  const slowHandler = () => {
    const statusEl = document.getElementById('smart-photo-status');
    if (statusEl) statusEl.textContent = 'API antwortet langsam — versuche alternatives Modell...';
  };
  const fallbackHandler = (e) => {
    const statusEl = document.getElementById('smart-photo-status');
    if (statusEl) statusEl.textContent = `Wechsel auf ${e.detail?.usedModel || 'Fallback'}...`;
  };
  window.addEventListener('ordo-api-slow', slowHandler);
  window.addEventListener('ordo-model-fallback', fallbackHandler);

  // Cleanup-Referenz für hideSmartPhotoOverlay
  overlay._cleanupListeners = () => {
    window.removeEventListener('ordo-api-slow', slowHandler);
    window.removeEventListener('ordo-model-fallback', fallbackHandler);
  };
}

// ── Result UI ───────────────────────────────────────
function showSmartPhotoResult(analysis, photoBlob, base64, mimeType) {
  let overlay = document.getElementById('smart-photo-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'smart-photo-overlay';
    overlay.className = 'smart-photo-overlay';
    document.body.appendChild(overlay);
  }

  const room = analysis.room || {};
  const container = analysis.container || {};
  const items = analysis.items || [];
  const roomEmoji = room.emoji || ROOM_TYPES[room.id]?.emoji || '🏠';
  const isNewRoom = room.is_new !== false && !Brain.getRoom(room.id);
  const isNewContainer = container.is_new !== false;

  const photoUrl = URL.createObjectURL(photoBlob);

  const itemsHtml = items.map(i =>
    `<div class="smart-photo-item">✅ ${i.menge > 1 ? i.menge + '× ' : ''}${i.name}</div>`
  ).join('');

  overlay.innerHTML = `
    <div class="smart-photo-modal">
      <div class="smart-photo-header">
        <button class="smart-photo-close" id="smart-photo-close" aria-label="Schließen">✕</button>
        <span class="smart-photo-title">📷 Erkannt</span>
      </div>
      <div class="smart-photo-content">
        <img src="${photoUrl}" class="smart-photo-preview" alt="Foto-Vorschau">
        <div class="smart-photo-location">
          📍 ${roomEmoji} ${escapeHTML(room.name || 'Raum')}${isNewRoom ? ' (neu)' : ''} › ${escapeHTML(container.name || 'Container')}${isNewContainer ? ' (neu)' : ''}
        </div>
        ${items.length > 0 ? `
          <div class="smart-photo-items-label">Gefunden:</div>
          <div class="smart-photo-items">${itemsHtml}</div>
        ` : '<div class="smart-photo-items-label">Keine Gegenstände erkannt</div>'}
        ${analysis.description ? `<div class="smart-photo-desc">${escapeHTML(analysis.description)}</div>` : ''}
        <div class="smart-photo-actions">
          <button class="smart-photo-btn primary" id="smart-photo-confirm">✅ Stimmt so</button>
          <button class="smart-photo-btn" id="smart-photo-discard">🗑️ Verwerfen</button>
        </div>
      </div>
    </div>
  `;
  overlay.style.display = 'flex';

  // Event: Close
  document.getElementById('smart-photo-close').addEventListener('click', () => {
    URL.revokeObjectURL(photoUrl);
    hideSmartPhotoOverlay();
  });

  // Event: Confirm — save everything with one tap
  document.getElementById('smart-photo-confirm').addEventListener('click', async () => {
    try {
      // Ensure room exists
      if (isNewRoom || !Brain.getRoom(room.id)) {
        const emoji = roomEmoji;
        Brain.addRoom(room.id, room.name || room.id, emoji);
      }

      // Build container ID — mit Fuzzy-Match gegen existierende Container
      let containerId = container.id || (container.name || 'container').toLowerCase()
        .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

      // Fuzzy-Match: Prüfe ob ein Container mit ähnlichem Namen schon existiert
      if (!Brain.getContainer(room.id, containerId)) {
        const roomData = Brain.getRoom(room.id);
        if (roomData?.containers) {
          const fuzzyMatch = Brain._findFuzzyContainer(roomData.containers, container.name);
          if (fuzzyMatch) {
            containerId = fuzzyMatch[0]; // Verwende die existierende ID
          }
        }
      }

      // Add container if still new after fuzzy check
      if (!Brain.getContainer(room.id, containerId)) {
        Brain.addContainer(room.id, containerId, container.name || containerId, container.typ || 'sonstiges', [], false);
      }

      // Add items (mit Fuzzy-Dedup gegen existierende Items)
      const existingItems = Brain.getContainerItemNames(room.id, containerId);
      for (const item of items) {
        if (!existingItems.some(n => Brain.isFuzzyMatch(n, item.name))) {
          Brain.addItem(room.id, containerId, item.name, item.menge || 1);
        }
      }

      // Save photo to IndexedDB
      try {
        await Brain.savePhoto(room.id, containerId, photoBlob);
      } catch (photoErr) {
        debugLog(`Foto-Speicherung fehlgeschlagen: ${photoErr.message}`);
      }

      URL.revokeObjectURL(photoUrl);
      hideSmartPhotoOverlay();
      showToast(`${roomEmoji} ${room.name} › ${container.name}: ${items.length} Gegenstände gespeichert`, 'success');

      // Ergebnis in den Dialog-Stream posten
      try {
        const { agentMessage } = await import('./dialog-stream.js');
        const { onboardingPhotoComplete, companionSays } = await import('./ordo-agent.js');

        // Onboarding-Phase 3: Erstes Foto abschließen
        const onboardingState = localStorage.getItem('ordo_onboarding_completed');
        if (onboardingState === 'pending_photo') {
          onboardingPhotoComplete({ room, items });
        } else {
          // Normaler Scan: Ergebnis im Stream zeigen
          const text = companionSays({
            sachlich: `${roomEmoji} ${room.name} › ${container.name}: ${items.length} Gegenstände gespeichert.`,
            freundlich: `${roomEmoji} ${room.name} › ${container.name} erkannt! ${items.length} Gegenstände gespeichert.`,
            kauzig: `${roomEmoji} ${room.name} › ${container.name}. ${items.length} Dinge. Gemerkt.`,
          });
          agentMessage(text, [
            { type: 'ContainerList', props: { roomId: room.id } },
          ], [
            { icon: '📷', label: 'Nächstes Foto', action: 'takePhoto', primary: true },
            { icon: '🏠', label: 'Zuhause', action: 'showHome' },
          ]);
        }
      } catch (streamErr) {
        debugLog(`Dialog-Stream Update fehlgeschlagen: ${streamErr.message}`);
      }

    } catch (err) {
      showToast('Fehler beim Speichern: ' + err.message, 'error');
    }
  });

  // Event: Discard
  document.getElementById('smart-photo-discard').addEventListener('click', () => {
    URL.revokeObjectURL(photoUrl);
    hideSmartPhotoOverlay();
  });
}

function hideSmartPhotoOverlay() {
  const overlay = document.getElementById('smart-photo-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    if (overlay._cleanupListeners) overlay._cleanupListeners();
  }
}

// ── Smart Video Capture Flow ───────────────────────
export async function startSmartVideoCapture() {
  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showToast('API Key nicht gesetzt. Bitte in den Einstellungen eintragen.', 'warning');
    return;
  }

  // 1. Video aufnehmen
  let file;
  try {
    file = await captureVideo(300);
  } catch { /* cancelled */ }
  if (!file) return;

  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > MAX_VIDEO_SIZE_MB) {
    showToast(`Video zu groß (${Math.round(sizeMB)} MB). Maximum: ${MAX_VIDEO_SIZE_MB} MB.`, 'error');
    return;
  }

  // 2. Loading anzeigen
  showSmartPhotoLoading();
  const statusEl = document.getElementById('smart-photo-status');
  if (statusEl) statusEl.textContent = 'Video wird hochgeladen...';

  let uploadedFile = null;
  try {
    // 3. Upload zu Gemini File API
    uploadedFile = await uploadVideoToGemini(apiKey, file, (phase, pct) => {
      if (statusEl) {
        if (phase === 'uploading') statusEl.textContent = `Video wird hochgeladen... ${Math.round(pct)}%`;
        else if (phase === 'processing') statusEl.textContent = 'Video wird verarbeitet...';
      }
    });

    if (statusEl) statusEl.textContent = 'Video wird analysiert...';

    // 4. AI-Analyse mit Smart-Photo-Prompt (erkennt Raum + Container + Items)
    const prompt = buildSmartPhotoPrompt();
    const messages = [{
      role: 'user',
      content: [
        { type: 'file', source: { type: 'uri', uri: uploadedFile.fileUri, mimeType: uploadedFile.mimeType } },
        { type: 'text', text: 'Analysiere dieses Video. Erkenne Raum, Möbelstück und Gegenstände. Nutze alle Frames für eine vollständige Erfassung.' }
      ]
    }];

    const raw = await callGemini(apiKey, prompt, messages, {
      taskType: 'videoAnalysis',
      hasVideo: true
    });

    const responseText = typeof raw === 'string' ? raw : raw.text || JSON.stringify(raw);
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Kein JSON in Antwort');

    const analysis = JSON.parse(jsonMatch[0]);

    // 5. Ergebnis-UI anzeigen (gleiche UI wie Smart Photo)
    showSmartPhotoResult(analysis, file, null, file.type || 'video/webm');

  } catch (err) {
    hideSmartPhotoOverlay();
    debugLog(`Smart Video Fehler: ${err.message}`);
    showToast('Video konnte nicht analysiert werden: ' + getErrorMessage(err), 'error');
  } finally {
    if (uploadedFile?.fileName) {
      deleteGeminiFile(apiKey, uploadedFile.fileName).catch(() => {});
    }
  }
}

// ── FAB Setup ───────────────────────────────────────
export function setupPhotoFAB() {
  // Don't add if already exists
  if (document.getElementById('photo-fab')) return;

  const fab = document.createElement('button');
  fab.id = 'photo-fab';
  fab.className = 'photo-fab';
  fab.innerHTML = '📷';
  fab.setAttribute('aria-label', 'Foto aufnehmen');
  document.body.appendChild(fab);

  fab.addEventListener('click', () => {
    startSmartPhotoCapture();
  });
}
