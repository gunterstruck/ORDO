// app.js – Bootstrap, Wiring, Init (schlanker Einstiegspunkt)

import Brain from './brain.js';
import { setupChat, initChat, maybeShowChatSuggestions } from './chat.js';
import { setupPhoto, setupPickingView, setupStagingOverlay, setupReviewOverlay, renderRoomDropdown, applyNfcContextToPhotoView } from './photo-flow.js';
import { setupBrain, renderBrainView, setupMapViewToggle, setupNfcContextView, renderNfcContextView, setupPhotoTimeline, setupMoveContainerOverlay, checkWarrantyBanner } from './brain-view.js';
import { setupOnboarding, showOnboarding } from './onboarding.js';
import { setupSettings, renderSettings, setupPullToRefresh } from './settings.js';
import { setupCamera } from './camera.js';

// ── State ──────────────────────────────────────────────
let currentView = 'chat';
let nfcContext = null;

// ── Constants ──────────────────────────────────────────
const ROOM_PRESETS = {
  kueche: ['🍳', 'Küche'], wohnzimmer: ['🛋️', 'Wohnzimmer'],
  schlafzimmer: ['🛏️', 'Schlafzimmer'], arbeitszimmer: ['💻', 'Arbeitszimmer'],
  keller: ['📦', 'Keller'], bad: ['🚿', 'Bad'], sonstiges: ['🏠', 'Sonstiges'],
  flur: ['🚪', 'Flur'], garage: ['🚗', 'Garage'], kinderzimmer: ['🧸', 'Kinderzimmer'],
  balkon: ['🌿', 'Balkon'], dachboden: ['🏚️', 'Dachboden'], gaestezimmer: ['🛏️', 'Gästezimmer']
};

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
  const line = `[${ts}] ${msg}\n`;
  for (const id of ['debug-log', 'photo-debug-log', 'onboarding-debug-log']) {
    const el = document.getElementById(id);
    if (!el) continue;
    const current = el.textContent === '— noch kein Log —' ? '' : el.textContent;
    el.textContent = line + current;
  }
  for (const panelId of ['photo-debug-panel', 'onboarding-debug-panel']) {
    const panel = document.getElementById(panelId);
    if (panel) panel.open = true;
  }
}

// ── State Getters/Setters ──────────────────────────────
function getNfcContext() { return nfcContext; }
function setNfcContext(ctx) { nfcContext = ctx; }
function getCurrentView() { return currentView; }

// ── Service Worker ─────────────────────────────────────
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js').catch(err => { debugLog(`Service Worker Registrierung fehlgeschlagen: ${err.message}`); });
  let reloading = false;
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

  // Back button on photo view
  document.getElementById('photo-back-btn').addEventListener('click', () => showView('chat'));
}

function closeAllOverlays() {
  const overlayIds = ['camera-overlay', 'staging-overlay', 'review-overlay', 'picking-overlay', 'photo-timeline-overlay', 'move-container-overlay', 'lightbox'];
  overlayIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = 'none';
      el.classList.remove('lightbox--visible');
    }
  });
}

function showView(name) {
  closeAllOverlays();
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
  setupCamera();

  if (!localStorage.getItem('onboarding_completed') && Brain.isEmpty()) {
    showOnboarding();
  } else if (nfcContext && nfcContext.tag) {
    showView('nfc-context');
  } else {
    showView('chat');
  }

  // Check for expiring warranties and show banner
  checkWarrantyBanner();
});

// ── Exports für andere Module ──────────────────────────
export { currentView, nfcContext, ROOM_PRESETS, escapeHTML, debugLog, ensureRoom, showView, getNfcContext, setNfcContext, getCurrentView };
