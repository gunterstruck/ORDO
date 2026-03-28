import Brain from './brain.js';
import { callGemini } from './ai.js';
import { showConfirmModal } from './modal.js';
import { debugLog, ensureRoom, getCurrentView } from './app.js';
import { renderRoomDropdown } from './photo-flow.js';
import { renderBrainView } from './brain-view.js';
import { showReportDialog } from './report.js';
import { getPersonality, setPersonality } from './chat.js';

let settingsInitialized = false;

export function setupSettings() {
  document.getElementById('settings-save-key').addEventListener('click', () => {
    const key = document.getElementById('settings-api-key').value.trim();
    if (key) {
      Brain.setApiKey(key);
      showSettingsMsg('API Key gespeichert.', 'success');
    }
  });

  // API key visibility toggle
  document.getElementById('settings-api-key-toggle').addEventListener('click', () => {
    const input = document.getElementById('settings-api-key');
    const btn = document.getElementById('settings-api-key-toggle');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = '🙈';
    } else {
      input.type = 'password';
      btn.textContent = '👁️';
    }
  });

  document.getElementById('settings-report').addEventListener('click', () => showReportDialog());

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
      localStorage.removeItem('ordo_onboarding_completed');
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
      ], { taskType: 'test' });
      debugLog(`TEST ERFOLGREICH: Antwort = "${result}"`);
    } catch (err) {
      debugLog(`TEST FEHLGESCHLAGEN: ${err.message}`);
    }
  });

  document.getElementById('debug-clear-btn').addEventListener('click', () => {
    const el = document.getElementById('debug-log');
    if (el) el.textContent = '— noch kein Log —';
  });

  // API Log display
  const apiLogBtn = document.getElementById('debug-api-log-btn');
  if (apiLogBtn) {
    apiLogBtn.addEventListener('click', () => {
      const el = document.getElementById('debug-api-log');
      if (!el) return;
      try {
        const log = JSON.parse(localStorage.getItem('ordo_api_log') || '[]');
        if (log.length === 0) {
          el.textContent = '— noch keine API-Calls —';
        } else {
          el.textContent = log.map(e => {
            const d = (e.duration / 1000).toFixed(1);
            return `${e.taskType} → ${e.model} (${e.thinking}) → ${d}s`;
          }).join('\n');
        }
      } catch(err) { console.warn('API-Log konnte nicht geladen werden:', err.message); el.textContent = '— Fehler beim Laden —'; }
    });
  }

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

  // Personality setting
  document.querySelectorAll('input[name="personality"]').forEach(radio => {
    radio.addEventListener('change', e => {
      setPersonality(e.target.value);
      showSettingsMsg('Persönlichkeit gespeichert.', 'success');
    });
  });

  // Copy NFC URL
  document.getElementById('nfc-copy-btn')?.addEventListener('click', () => {
    const url = document.getElementById('nfc-fallback-url').textContent;
    navigator.clipboard.writeText(url)
      .then(() => showSettingsMsg('URL kopiert.', 'success'))
      .catch(() => showSettingsMsg('Kopieren fehlgeschlagen.', 'error'));
  });
}

export function renderSettings() {
  document.getElementById('settings-api-key').value = Brain.getApiKey();
  renderRoomDropdown('nfc-room-select');
  updateNfcPreview();

  // Set personality radio
  const currentPersonality = getPersonality();
  const radio = document.querySelector(`input[name="personality"][value="${currentPersonality}"]`);
  if (radio) radio.checked = true;

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

export function showSettingsMsg(msg, type) {
  const el = document.getElementById('settings-msg');
  el.textContent = msg;
  el.className = `settings-msg settings-msg--${type}`;
  el.style.display = 'block';
  if (type === 'success') setTimeout(() => { el.style.display = 'none'; }, 3000);
}

export function setupPullToRefresh() {
  // Indikator-Element erzeugen
  const indicator = document.createElement('div');
  indicator.id = 'ptr-indicator';
  indicator.textContent = '↓ Zum Aktualisieren ziehen';
  document.body.appendChild(indicator);

  let touchStartY = 0;
  let ptrActive = false;

  function getActiveScrollTop() {
    // Im Chat-View scrollt #chat-messages, in allen anderen Views das View selbst
    if (getCurrentView() === 'chat') {
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
