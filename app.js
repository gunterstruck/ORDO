// app.js – Bootstrap, Wiring, Init (schlanker Einstiegspunkt)

import Brain from './brain.js';
import { setupChat, initChat, maybeShowChatSuggestions } from './chat.js';
import { setupPhoto, setupPickingView, setupStagingOverlay, setupReviewOverlay, renderRoomDropdown, applyNfcContextToPhotoView, setupOfflineQueue } from './photo-flow.js';
import { setupBrain, renderBrainView, setupMapViewToggle, setupNfcContextView, renderNfcContextView, setupPhotoTimeline, setupMoveContainerOverlay, checkWarrantyBanner } from './brain-view.js';
import { setupOnboarding, showOnboarding } from './onboarding.js';
import { setupSettings, renderSettings, setupPullToRefresh } from './settings.js';
import { setupCamera } from './camera.js';
import { loadQuest, showCurrentStep, pauseQuest, startCleanupQuest } from './quest.js';
import { closeTopOverlay } from './overlay-manager.js';

// ── State ──────────────────────────────────────────────
let currentView = 'chat';
let nfcContext = null;

// ── Constants ──────────────────────────────────────────
// ── Zentrale Raum-Definitionen ────────────────────────
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

// Legacy ROOM_PRESETS format (backwards compat for modules that use [emoji, name] format)
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

function isoNow() {
  return new Date().toISOString();
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

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  migrateLocalStorageKeys();
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
  setupOfflineQueue();
  loadQuest();
  setupGlobalKeyboardHandling();

  if (!localStorage.getItem('ordo_onboarding_completed') && Brain.isEmpty()) {
    showOnboarding();
  } else if (nfcContext && nfcContext.tag) {
    showView('nfc-context');
  } else {
    showView('chat');
  }

  const activeQuest = Brain.getQuest();
  if (activeQuest?.active) {
    setTimeout(() => {
      const questLabel = activeQuest.type === 'cleanup' ? 'Aufräum-Quest' : 'Inventar-Quest';
      const doneCount = activeQuest.progress?.containers_done || 0;
      const totalCount = activeQuest.progress?.containers_total || 0;
      const percent = activeQuest.progress?.percent || 0;
      const msg = activeQuest.type === 'cleanup'
        ? `Du hast eine ${questLabel} die noch läuft.\n${doneCount} von ${totalCount} Schritten erledigt.\n\nWeitermachen?`
        : `Du warst mittendrin – ${percent}% geschafft.\n\nWeitermachen?`;
      const shouldContinue = window.confirm(msg);
      if (shouldContinue) showCurrentStep();
      else pauseQuest();
    }, 250);
  }

  // Listen for cleanup quest start from chat AI
  document.addEventListener('ordo:start-cleanup-quest', (e) => {
    const minutes = e.detail?.minutes || 15;
    startCleanupQuest(minutes);
  });

  // Check for expiring warranties and show banner
  checkWarrantyBanner();
});

// ── Global Keyboard Handling ──────────────────────────
function setupGlobalKeyboardHandling() {
  // Scroll inputs into view when soft keyboard opens (for modals, overlays, etc.)
  // Chat has its own more specific handler via visualViewport
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('.ordo-modal-input, .ordo-modal-select, .picking-panel-input, .onboarding-apikey-input')) {
      setTimeout(() => {
        e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }
  });

  // Escape closes top overlay
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTopOverlay();
    }
  });

  // Mobile back button closes top overlay instead of navigating away
  window.addEventListener('popstate', (e) => {
    if (closeTopOverlay()) {
      history.pushState(null, '');
    }
  });
}

// ── Exports für andere Module ──────────────────────────
export { currentView, nfcContext, ROOM_PRESETS, ROOM_TYPES, normalizeRoomType, getRoomEmoji, getRoomLabel, escapeHTML, debugLog, isoNow, ensureRoom, showView, getNfcContext, setNfcContext, getCurrentView };
