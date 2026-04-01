// live-modal.js – Verschiebbares Live-Chat Modal
// Öffnet ein schwebendes Fenster für Echtzeit-Gespräche via Gemini Live API.
// Kann minimiert und per Drag verschoben werden.

import Brain from './brain.js';
import { calculateFreedomIndex } from './organizer.js';

let modalEl = null;
let session = null;
let isActive = false;
let isMinimized = false;

// ── DOM erstellen ────────────────────────────────────

function ensureModal() {
  if (modalEl) return modalEl;

  modalEl = document.createElement('div');
  modalEl.id = 'live-chat-modal';
  modalEl.className = 'live-modal';
  modalEl.style.display = 'none';
  modalEl.innerHTML = `
    <div class="live-modal-header" id="live-modal-drag">
      <span class="live-modal-title">Live Chat</span>
      <div class="live-modal-header-btns">
        <button class="live-modal-minimize" id="live-modal-minimize" aria-label="Minimieren">&#x2015;</button>
        <button class="live-modal-close" id="live-modal-close" aria-label="Schließen">\u2715</button>
      </div>
    </div>
    <div class="live-modal-body">
      <div class="live-orb" id="lm-orb">\u{1F3A4}</div>
      <div class="live-status" id="lm-status">Bereit</div>
      <div class="live-transcript" id="lm-transcript"></div>
      <div class="live-controls">
        <button class="live-btn live-btn-start" id="lm-start">\u{1F3A4} Live starten</button>
        <button class="live-btn live-btn-stop" id="lm-stop" style="display:none">\u23F9\uFE0F Beenden</button>
      </div>
    </div>
  `;

  document.body.appendChild(modalEl);

  // Minimierter Knopf (schwebt als kleiner Button)
  const fab = document.createElement('button');
  fab.id = 'live-chat-fab';
  fab.className = 'live-fab';
  fab.style.display = 'none';
  fab.innerHTML = '\u{1F3A4}';
  fab.setAttribute('aria-label', 'Live Chat öffnen');
  document.body.appendChild(fab);

  // ── Events ──
  setupDrag(modalEl, modalEl.querySelector('#live-modal-drag'));

  modalEl.querySelector('#live-modal-minimize').addEventListener('click', minimize);
  modalEl.querySelector('#live-modal-close').addEventListener('click', close);
  fab.addEventListener('click', expand);

  modalEl.querySelector('#lm-start').addEventListener('click', startSession);
  modalEl.querySelector('#lm-stop').addEventListener('click', stopSession);

  return modalEl;
}

// ── Drag-Logik ───────────────────────────────────────

function setupDrag(el, handle) {
  let isDragging = false;
  let startX, startY, origX, origY;

  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    isDragging = true;
    handle.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startY = e.clientY;
    const rect = el.getBoundingClientRect();
    origX = rect.left;
    origY = rect.top;
    el.style.transition = 'none';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    el.style.left = `${origX + dx}px`;
    el.style.top = `${origY + dy}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  });

  handle.addEventListener('pointerup', () => {
    isDragging = false;
    el.style.transition = '';
  });
}

// ── Open / Close / Minimize ──────────────────────────

export function openLiveModal() {
  const modal = ensureModal();
  modal.style.display = '';
  isMinimized = false;
  document.getElementById('live-chat-fab').style.display = 'none';

  // Position reset (unten rechts)
  modal.style.right = '12px';
  modal.style.bottom = '80px';
  modal.style.left = 'auto';
  modal.style.top = 'auto';

  // Auto-start wenn nicht aktiv
  if (!isActive) {
    modalEl.querySelector('#lm-start').click();
  }
}

function minimize() {
  if (!modalEl) return;
  isMinimized = true;
  modalEl.style.display = 'none';
  const fab = document.getElementById('live-chat-fab');
  if (fab) {
    fab.style.display = 'flex';
    if (isActive) fab.classList.add('live-fab--active');
  }
}

function expand() {
  if (!modalEl) return;
  isMinimized = false;
  modalEl.style.display = '';
  const fab = document.getElementById('live-chat-fab');
  if (fab) fab.style.display = 'none';
}

function close() {
  stopSession();
  if (modalEl) modalEl.style.display = 'none';
  const fab = document.getElementById('live-chat-fab');
  if (fab) {
    fab.style.display = 'none';
    fab.classList.remove('live-fab--active');
  }
  isMinimized = false;
}

// ── Transcript Helpers ───────────────────────────────

function addTranscriptLine(text, role) {
  const transcript = modalEl?.querySelector('#lm-transcript');
  if (!transcript) return;
  const line = document.createElement('div');
  line.className = 'live-transcript-line' + (role === 'agent' ? ' agent' : '');
  line.textContent = text;
  transcript.appendChild(line);
  transcript.scrollTop = transcript.scrollHeight;

  // Auto-expand wenn minimiert und Agent spricht
  if (isMinimized && role === 'agent') {
    const fab = document.getElementById('live-chat-fab');
    if (fab) fab.classList.add('live-fab--pulse');
    setTimeout(() => fab?.classList.remove('live-fab--pulse'), 2000);
  }
}

function updateState(state) {
  const statusEl = modalEl?.querySelector('#lm-status');
  const orb = modalEl?.querySelector('#lm-orb');
  if (!statusEl || !orb) return;

  statusEl.textContent = {
    connecting: 'Verbinde...',
    connected: 'Verbunden',
    listening: 'H\u00f6re zu...',
    responding: 'ORDO spricht...',
    disconnected: 'Beendet',
  }[state] || state;

  orb.className = 'live-orb';
  if (state === 'listening') orb.classList.add('listening');
  if (state === 'responding') orb.classList.add('speaking');
}

// ── Session Start / Stop ─────────────────────────────

async function startSession() {
  if (isActive) return;
  isActive = true;

  const startBtn = modalEl.querySelector('#lm-start');
  const stopBtn = modalEl.querySelector('#lm-stop');
  startBtn.style.display = 'none';
  stopBtn.style.display = 'inline-block';

  try {
    const { GeminiLiveSession, ORDO_FUNCTIONS, functionCallToAction, executeOrdoAction } = await import('./ai.js');
    const apiKey = Brain.getApiKey();
    if (!apiKey) {
      updateState('disconnected');
      addTranscriptLine('Kein API-Key! Bitte in den Einstellungen eintragen.', 'agent');
      resetButtons();
      return;
    }

    session = new GeminiLiveSession();
    session.onStateChange = updateState;
    session.onTranscript = (text, role) => addTranscriptLine(text, role === 'model' ? 'agent' : 'user');
    session.onError = (msg) => {
      addTranscriptLine('\u26A0\uFE0F ' + msg, 'agent');
      updateState('disconnected');
      resetButtons();
    };

    // Function Calls ausf\u00fchren
    session.onFunctionCall = async (call) => {
      const action = functionCallToAction(call);
      if (action && action.type !== 'found') {
        executeOrdoAction(action);
        addTranscriptLine(`\u2705 ${call.name}`, 'agent');

        // Aktion auch im Dialog-Stream anzeigen
        try {
          const { handleAction } = await import('./ordo-agent.js');
          // Bestimmte Aktionen im Dialog-Stream reflektieren
          if (action.type === 'add_room' || action.type === 'delete_room') {
            handleAction({ action: 'showHome' });
          }
        } catch { /* ok */ }

        return { success: true };
      }
      return { error: 'Unbekannte Aktion' };
    };

    const data = Brain.getData();
    const rooms = Object.keys(data.rooms || {});
    const { percent } = calculateFreedomIndex();
    const personality = localStorage.getItem('ordo_personality') || 'kauzig';

    const roomDetails = rooms.map(r => {
      const room = data.rooms[r];
      const containers = Object.keys(room?.containers || {}).map(cId => {
        const c = room.containers[cId];
        const itemCount = c?.items?.length || 0;
        return `  - ${c?.name || cId} (${itemCount} Items)`;
      });
      return `${room?.name || r}:\n${containers.join('\n') || '  (leer)'}`;
    });

    const contextPrompt = `Du bist ORDO, ein Haushaltsassistent.
Der Nutzer spricht live mit dir \u00fcber sein Zuhause.
Du kannst Aktionen ausf\u00fchren: R\u00e4ume anlegen, Container erstellen, Items hinzuf\u00fcgen/entfernen etc.
Nutze die verf\u00fcgbaren Functions um \u00c4nderungen wirklich durchzuf\u00fchren!

AKTUELLER ZUSTAND:
- ${rooms.length} R\u00e4ume:
${roomDetails.join('\n') || '(keine R\u00e4ume)'}
- Kopf-Freiheits-Index: ${percent}%
- Pers\u00f6nlichkeit: ${personality}

Antworte kurz und nat\u00fcrlich. Du bist der ${personality}e Hausmeister.
Wenn der Nutzer einen Raum oder Container anlegen will, nutze die passende Function.`;

    await session.connect(apiKey, contextPrompt, { tools: ORDO_FUNCTIONS });
    addTranscriptLine('Sprich einfach los!', 'agent');
  } catch (err) {
    addTranscriptLine('Fehler: ' + (err.message || 'Verbindung fehlgeschlagen'), 'agent');
    updateState('disconnected');
    resetButtons();
  }
}

async function stopSession() {
  if (session) {
    session.disconnect();
    session = null;
  }
  isActive = false;
  updateState('disconnected');
  addTranscriptLine('Session beendet.', 'agent');
  resetButtons();

  const fab = document.getElementById('live-chat-fab');
  if (fab) fab.classList.remove('live-fab--active');

  // endLive im Dialog-Stream anzeigen
  try {
    const { handleAction } = await import('./ordo-agent.js');
    handleAction({ action: 'endLive' });
  } catch { /* ok */ }
}

function resetButtons() {
  isActive = false;
  const startBtn = modalEl?.querySelector('#lm-start');
  const stopBtn = modalEl?.querySelector('#lm-stop');
  if (startBtn) startBtn.style.display = 'inline-block';
  if (stopBtn) stopBtn.style.display = 'none';
}

// ── Cleanup bei Seitenwechsel ────────────────────────

export function isLiveModalActive() {
  return isActive;
}
