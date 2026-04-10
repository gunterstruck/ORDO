// app.js – Bootstrap, Wiring, Init (Generative UI – Phase A)
// Radikal vereinfacht: Kein View-Switching mehr. Eine Seite. Ein Dialog.

import Brain from './brain.js';
import { startOnboarding, showContextGreeting, handleAction, handleUserInput } from './ordo-agent.js';
import { getProviderConfig } from './ai.js';
import { systemMessage, clearStream } from './dialog-stream.js';
import { logAction, touchActivity } from './session-log.js';
import { setupPickingView, setupStagingOverlay, setupReviewOverlay, setupOfflineQueue, cancelVideoAnalysis, closeStagingOverlay, stopPhotoMicRecognitions } from './photo-flow.js';
import { setupCamera } from './camera.js';
import { loadQuest } from './quest.js';
import { closeTopOverlay } from './overlay-manager.js';
import { setupPhotoTimeline, setupMoveContainerOverlay } from './brain-view.js';

// ── Constants ──────────────────────────────────────────
const ROOM_TYPES = {
  kueche:        { name: 'Küche',         emoji: '🍳', aliases: ['kitchen'] },
  bad:           { name: 'Bad',           emoji: '🚿', aliases: ['bathroom', 'wc', 'toilette', 'dusche'] },
  schlafzimmer:  { name: 'Schlafzimmer',  emoji: '🛏️', aliases: ['bedroom'] },
  wohnzimmer:    { name: 'Wohnzimmer',    emoji: '🛋️', aliases: ['living'] },
  arbeitszimmer: { name: 'Arbeitszimmer', emoji: '💻', aliases: ['büro', 'office', 'buero'] },
  kinderzimmer:  { name: 'Kinderzimmer',  emoji: '🧸', aliases: ['kids'] },
  flur:          { name: 'Flur',          emoji: '🚪', aliases: ['diele', 'eingang', 'garderobe', 'corridor'] },
  keller:        { name: 'Keller',        emoji: '📦', aliases: ['basement'] },
  abstellraum:   { name: 'Abstellraum',   emoji: '📦', aliases: ['lager', 'hauswirtschaft', 'utility'] },
  garage:        { name: 'Garage',        emoji: '🚗', aliases: [] },
  esszimmer:     { name: 'Esszimmer',     emoji: '🍽️', aliases: ['dining'] },
  ankleide:      { name: 'Ankleide',      emoji: '👔', aliases: ['closet', 'walk-in'] },
  dachboden:     { name: 'Dachboden',     emoji: '🏚️', aliases: ['attic'] },
  garten:        { name: 'Garten',        emoji: '🌳', aliases: ['garden', 'terrasse', 'balkon'] },
  sonstiges:     { name: 'Sonstiges',     emoji: '🏠', aliases: [] },
  gaestezimmer:  { name: 'Gästezimmer',   emoji: '🛏️', aliases: ['guest'] },
};

function normalizeRoomType(input) {
  const lower = (input || '').toLowerCase();
  for (const [type, config] of Object.entries(ROOM_TYPES)) {
    if (lower === type) return type;
    if (lower === config.name.toLowerCase()) return type;
    if (config.aliases.some(a => lower.includes(a))) return type;
  }
  return lower;
}

function getRoomEmoji(type) {
  return ROOM_TYPES[type]?.emoji || '🏠';
}

function getRoomLabel(type) {
  return ROOM_TYPES[type]?.name || type;
}

const ROOM_PRESETS = {};
for (const [id, config] of Object.entries(ROOM_TYPES)) {
  ROOM_PRESETS[id] = [config.emoji, config.name];
}

// ── Helpers ────────────────────────────────────────────
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function ensureRoom(roomId) {
  if (roomId && !Brain.getRoom(roomId)) {
    const p = ROOM_PRESETS[roomId] || ['🏠', roomId];
    Brain.addRoom(roomId, p[1], p[0]);
  }
}

function debugLog(msg) {
  const ts = new Date().toLocaleTimeString('de-DE');
  const line = `[${ts}] ${msg}`;
  console.log(line);
}

// ── State (Compat-Shims für bestehende Module) ────────
let currentView = 'chat';
let nfcContext = null;

function getNfcContext() { return nfcContext; }
function setNfcContext(ctx) { nfcContext = ctx; }
function getCurrentView() { return currentView; }

/**
 * showView — Kompatibilitäts-Shim.
 * Bestehende Module rufen showView() auf (z.B. nach Quest-Ende).
 * Im neuen UI leiten wir das an den Agent weiter.
 */
function showView(name) {
  currentView = name;
  // Overlay-Module erwarten, dass showView Overlays schließt
  closeAllOverlays();
}

// ── Overlay Management ────────────────────────────────
function closeAllOverlays() {
  const overlayIds = ['camera-overlay', 'staging-overlay', 'review-overlay', 'picking-overlay', 'photo-timeline-overlay', 'move-container-overlay', 'lightbox', 'fullscreen-overlay', 'quest-overlay', 'item-detail-panel'];
  overlayIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = 'none';
      el.classList.remove('lightbox--visible');
      el.classList.add('hidden');
    }
  });
  const modal = document.getElementById('ordo-modal');
  if (modal) modal.style.display = 'none';

  const cameraVideo = document.getElementById('camera-video');
  if (cameraVideo?.srcObject) {
    cameraVideo.srcObject.getTracks().forEach(t => t.stop());
    cameraVideo.srcObject = null;
  }

  cancelVideoAnalysis();
  // Mikrofon-Erkennungen der Photo-View stoppen, falls noch aktiv
  stopPhotoMicRecognitions();
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

// ── Service Worker ─────────────────────────────────────
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js').catch(err => {
    debugLog(`Service Worker Registrierung fehlgeschlagen: ${err.message}`);
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

// ── localStorage Migration ─────────────────────────────
function migrateStorageKey(oldKey, newKey) {
  if (localStorage.getItem(newKey) !== null) return;
  const value = localStorage.getItem(oldKey);
  if (value !== null) {
    localStorage.setItem(newKey, value);
    localStorage.removeItem(oldKey);
  }
}

function migrateLocalStorageKeys() {
  migrateStorageKey('gemini_api_key', 'ordo_api_key');
  migrateStorageKey('brain_view_mode', 'ordo_view_mode');
  migrateStorageKey('photo_history_limit', 'ordo_photo_history_limit');
  migrateStorageKey('onboarding_completed', 'ordo_onboarding_completed');
  migrateStorageKey('last_warranty_hint_shown', 'ordo_warranty_hint_shown');
}

// ── Input Bar ──────────────────────────────────────────
function setupInputBar() {
  // Voice
  document.getElementById('voice-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('voice-btn');
    btn?.classList.add('listening');
    try {
      const text = await listenForSpeech();
      if (text) handleUserInput(text);
    } finally {
      btn?.classList.remove('listening');
    }
  });

  // Photo
  document.getElementById('photo-btn')?.addEventListener('click', () => {
    handleAction({ action: 'takePhoto' });
  });

  // Video
  document.getElementById('video-btn')?.addEventListener('click', () => {
    handleAction({ action: 'takeVideo' });
  });

  // Text-Input
  const wrapper = document.getElementById('text-input-wrapper');
  const input = document.getElementById('text-input');
  const sendBtn = document.getElementById('send-btn');

  // Tap auf den collapsed wrapper öffnet ihn
  wrapper?.addEventListener('click', (e) => {
    if (wrapper.classList.contains('collapsed')) {
      wrapper.classList.remove('collapsed');
      input?.focus();
      e.stopPropagation();
    }
  });

  sendBtn?.addEventListener('click', () => {
    const text = input?.value.trim();
    if (text) {
      handleUserInput(text);
      input.value = '';
      wrapper?.classList.add('collapsed');
    }
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendBtn?.click();
    }
  });

  // Collapse wenn Fokus verloren geht und leer
  input?.addEventListener('blur', () => {
    setTimeout(() => {
      if (!input.value.trim()) {
        wrapper?.classList.add('collapsed');
      }
    }, 200);
  });
}

// ── Voice Input (Web Speech API) ───────────────────────
function listenForSpeech() {
  return new Promise((resolve) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      // Kein Speech API → Text-Input öffnen
      const wrapper = document.getElementById('text-input-wrapper');
      const input = document.getElementById('text-input');
      if (wrapper && input) {
        wrapper.classList.remove('collapsed');
        input.focus();
      }
      resolve(null);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'de-DE';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let resolved = false;
    const done = (text) => {
      if (resolved) return;
      resolved = true;
      resolve(text);
    };

    recognition.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript;
      done(text || null);
    };

    recognition.onerror = () => done(null);
    recognition.onend = () => done(null);

    // Timeout nach 10 Sekunden
    setTimeout(() => {
      if (!resolved) {
        recognition.stop();
        done(null);
      }
    }, 10000);

    try {
      recognition.start();
    } catch {
      done(null);
    }
  });
}

// ── Global Keyboard Handling ──────────────────────────
function setupGlobalKeyboardHandling() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTopOverlay();
    }
  });

  window.addEventListener('popstate', () => {
    if (closeTopOverlay()) {
      if (typeof globalThis.history?.pushState === 'function') {
        globalThis.history.pushState(null, '');
      }
    }
  });
}

// ── Visibility Change ──────────────────────────────────
let lastVisible = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const away = (Date.now() - lastVisible) / 60000;
    if (away > 5) {
      showContextGreeting();
    }
    lastVisible = Date.now();
  } else {
    lastVisible = Date.now();
  }
});

// ── Online/Offline ─────────────────────────────────────
window.addEventListener('offline', () => {
  systemMessage('📶 Offline — Fotos werden lokal gespeichert');
});

window.addEventListener('online', () => {
  systemMessage('📶 Wieder online');
});

// ── Proxy Quota Indicator ─────────────────────────────
window.addEventListener('ordo-proxy-quota', (e) => {
  const { remaining, limit } = e.detail;
  const indicator = document.getElementById('quota-indicator');

  if (!indicator) return;

  // Nur im Proxy-Modus zeigen
  const config = getProviderConfig();
  if (config.primary !== 'proxy') {
    indicator.style.display = 'none';
    return;
  }

  indicator.style.display = 'flex';
  indicator.textContent = `${remaining}/${limit}`;

  // Farbe je nach Verbrauch
  indicator.classList.remove('quota-warning', 'quota-critical');
  if (remaining <= 5) {
    indicator.classList.add('quota-critical');
  } else if (remaining <= 15) {
    indicator.classList.add('quota-warning');
  }
});

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Kritische Init
  migrateLocalStorageKeys();
  Brain.init();
  parseNfcParams();

  // Safe Setup — jede Funktion einzeln abgesichert
  const safeSetup = [
    ['registerServiceWorker', registerServiceWorker],
    ['setupInputBar', setupInputBar],
    ['setupGlobalKeyboardHandling', setupGlobalKeyboardHandling],
    ['setupPickingView', setupPickingView],
    ['setupStagingOverlay', setupStagingOverlay],
    ['setupReviewOverlay', setupReviewOverlay],
    ['setupCamera', setupCamera],
    ['setupOfflineQueue', setupOfflineQueue],
    ['loadQuest', loadQuest],
    ['setupPhotoTimeline', setupPhotoTimeline],
    ['setupMoveContainerOverlay', setupMoveContainerOverlay],
  ];
  for (const [name, fn] of safeSetup) {
    try { fn(); } catch (err) { console.error(`[ORDO] ${name} fehlgeschlagen:`, err); }
  }

  // Header-Buttons
  document.getElementById('ordo-home-btn')?.addEventListener('click', () => {
    clearStream();
    handleAction({ action: 'showHome' });
  });
  document.getElementById('ordo-settings-btn')?.addEventListener('click', () => {
    handleAction({ action: 'showSettings' });
  });

  // Entscheidung: Onboarding oder Begrüßung
  // Kein API-Key-Check mehr nötig — der Proxy funktioniert immer
  const isFirstStart = !localStorage.getItem('ordo_onboarding_completed');
  if (isFirstStart) {
    startOnboarding();
  } else {
    showContextGreeting();
  }

  logAction('App gestartet', null, 'system');
  touchActivity();
});

// ── Exports für andere Module ──────────────────────────
export {
  currentView, nfcContext,
  ROOM_PRESETS, ROOM_TYPES,
  normalizeRoomType, getRoomEmoji, getRoomLabel,
  escapeHTML, debugLog, ensureRoom,
  showView, getNfcContext, setNfcContext, getCurrentView,
};
