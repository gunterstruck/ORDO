// companion.js – Kontextueller KI-Begleiter (Floating Companion)
// Omnipräsenter Assistent, der den aktuellen View-Kontext versteht.

import Brain from './brain.js';
import { callGemini, ORDO_FUNCTIONS, functionCallToAction, executeOrdoAction, normalizeOrdoAction, buildMessages, loadingManager } from './ai.js';
import { getPersonalityPrompt } from './chat.js';
import { calculateFreedomIndex, getQuickWins } from './organizer.js';
import { getCurrentView, getNfcContext } from './app.js';

// ── State ─────────────────────────────────────────────
let companionHistory = [];
let currentViewContext = 'chat';
let isOpen = false;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let hasGreetedForView = {};

const VIEW_LABELS = {
  chat: 'Suche & Chat',
  photo: 'Erfassung',
  brain: 'Zuhause-Übersicht',
  settings: 'Einstellungen',
  'nfc-context': 'NFC-Tag Ansicht',
};

// ── System Prompt Builder ─────────────────────────────
function buildCompanionSystemPrompt() {
  const personality = getPersonalityPrompt();
  const context = Brain.buildContext();
  const score = calculateFreedomIndex();
  const viewLabel = VIEW_LABELS[currentViewContext] || currentViewContext;

  const quickWins = getQuickWins(2)
    .map(w => `- ${w.description}`)
    .join('\n') || '- Keine';

  const rooms = Brain.getRooms();
  const roomCount = Object.keys(rooms).length;
  const itemCount = Object.values(rooms).reduce((sum, r) => {
    return sum + Object.values(r.containers || {}).reduce((s, c) => s + (c.items?.length || 0), 0);
  }, 0);

  const householdStatus = roomCount === 0
    ? 'leer (noch keine Räume erfasst)'
    : `${roomCount} Räume, ca. ${itemCount} Gegenstände`;

  let viewHint = '';
  switch (currentViewContext) {
    case 'chat':
      viewHint = 'Hilf bei der allgemeinen Suche nach Gegenständen oder beantworte Fragen zum Haushalt.';
      break;
    case 'photo':
      viewHint = 'Unterstütze beim Benennen von Räumen, erkläre den Foto-/Video-Scan oder hilf bei der Erfassung.';
      break;
    case 'brain':
      viewHint = 'Schlage vor, Gegenstände zu verschieben, zeige Statistiken zum Kopf-Freiheits-Index oder hilf beim Sortieren.';
      break;
    case 'settings':
      viewHint = 'Erkläre technische Details wie den API-Key, NFC-Tags oder die Persönlichkeitseinstellung.';
      break;
    case 'nfc-context':
      viewHint = 'Der Nutzer schaut sich einen NFC-Tag-Ort an. Hilf beim Aktualisieren des Inhalts.';
      break;
  }

  return `Du bist ORDO, der intelligente Begleiter innerhalb dieser PWA.
Deine Aufgabe ist es, den Nutzer kontextbezogen zu unterstützen.

AKTUELLER KONTEXT:
- Aktuelle Ansicht: ${viewLabel}
- Haushalt-Status: ${householdStatus}
- Kopf-Freiheits-Index: ${score.percent}%

${personality}

VERHALTENSREGELN:
1. BEGRÜẞUNG: Wenn der Nutzer das Chat-Fenster öffnet, beginne (falls es der erste Kontakt auf dieser Seite ist) mit einem kurzen Hinweis auf seinen aktuellen Ort.
2. KOMPETENZ: Du hast vollen Zugriff auf die Funktionen (Function Calls) von ORDO (add_item, move_item, etc.).
3. TONALITÄT: Bleibe bei deinem kauzigen, aber herzlichen Hausmeister-Stil.
4. KÜRZE: Antworte extrem kompakt (max. 2 Sätze), da das Modal nur wenig Platz bietet.

SPEZIFISCHE HILFE FÜR AKTUELLE SEITE (${viewLabel}):
${viewHint}

TOP QUICK WINS:
${quickWins}

Hier ist was du über diesen Haushalt weißt:
${context}

AKTIONEN – nutze Function Calls wenn nötig:
- add_item, remove_item, remove_items, move_item, replace_items
- add_room, add_container, delete_container, rename_container, delete_room
- show_found_item

WICHTIG:
- Max 2 Sätze pro Antwort.
- Bevorzuge Function Calls statt Text-Marker.
- Verwende slugifizierte IDs (ä→ae, ö→oe, ü→ue, ß→ss, Leerzeichen→_).`;
}

// ── Context Update (called from app.js on view change) ──
export function updateCompanionContext(viewName) {
  currentViewContext = viewName;
}

// ── Setup ─────────────────────────────────────────────
export function setupCompanion() {
  const circle = document.getElementById('companion-circle');
  const modal = document.getElementById('companion-modal');
  const minimize = document.getElementById('companion-minimize');
  const resize = document.getElementById('companion-resize');
  const voiceBtn = document.getElementById('companion-voice');

  if (!circle || !modal) return;

  // Toggle modal on circle click
  circle.addEventListener('click', () => {
    if (isDragging) return;
    toggleCompanion();
  });

  // Minimize
  minimize.addEventListener('click', () => closeCompanion());

  // Resize toggle
  resize.addEventListener('click', () => {
    modal.classList.toggle('companion-modal--large');
  });

  // Voice input
  if (voiceBtn) {
    voiceBtn.addEventListener('click', startCompanionVoice);
  }

  // Draggable circle
  setupDrag(circle);
}

// ── Drag Logic ────────────────────────────────────────
function setupDrag(el) {
  let startX, startY, moved;

  const onStart = (x, y) => {
    const rect = el.getBoundingClientRect();
    dragOffset.x = x - rect.left;
    dragOffset.y = y - rect.top;
    startX = x;
    startY = y;
    moved = false;
    el.style.transition = 'none';
  };

  const onMove = (x, y) => {
    const dx = Math.abs(x - startX);
    const dy = Math.abs(y - startY);
    if (dx > 5 || dy > 5) moved = true;
    if (!moved) return;

    isDragging = true;
    const newX = x - dragOffset.x;
    const newY = y - dragOffset.y;

    // Clamp within viewport
    const maxX = window.innerWidth - el.offsetWidth;
    const maxY = window.innerHeight - el.offsetHeight;
    el.style.left = `${Math.max(0, Math.min(newX, maxX))}px`;
    el.style.top = `${Math.max(0, Math.min(newY, maxY))}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  };

  const onEnd = () => {
    el.style.transition = '';
    setTimeout(() => { isDragging = false; }, 50);
  };

  // Touch events
  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    onStart(t.clientX, t.clientY);
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    const t = e.touches[0];
    onMove(t.clientX, t.clientY);
    if (moved) e.preventDefault();
  }, { passive: false });

  el.addEventListener('touchend', onEnd);

  // Mouse events
  el.addEventListener('mousedown', e => {
    onStart(e.clientX, e.clientY);
    const mousemove = ev => onMove(ev.clientX, ev.clientY);
    const mouseup = () => {
      document.removeEventListener('mousemove', mousemove);
      document.removeEventListener('mouseup', mouseup);
      onEnd();
    };
    document.addEventListener('mousemove', mousemove);
    document.addEventListener('mouseup', mouseup);
  });
}

// ── Open / Close ──────────────────────────────────────
function toggleCompanion() {
  if (isOpen) {
    closeCompanion();
  } else {
    openCompanion();
  }
}

function openCompanion() {
  const modal = document.getElementById('companion-modal');
  const circle = document.getElementById('companion-circle');
  if (!modal) return;

  modal.style.display = 'flex';
  isOpen = true;
  circle.classList.add('companion-circle--active');

  // Auto-greet on first open per view
  if (!hasGreetedForView[currentViewContext]) {
    hasGreetedForView[currentViewContext] = true;
    autoGreet();
  }
}

function closeCompanion() {
  const modal = document.getElementById('companion-modal');
  const circle = document.getElementById('companion-circle');
  if (!modal) return;

  modal.style.display = 'none';
  isOpen = false;
  circle.classList.remove('companion-circle--active');
}

export function isCompanionOpen() { return isOpen; }

// ── Auto Greet ────────────────────────────────────────
async function autoGreet() {
  const apiKey = Brain.getApiKey();
  if (!apiKey) return;

  const viewLabel = VIEW_LABELS[currentViewContext] || currentViewContext;
  const systemPrompt = buildCompanionSystemPrompt();
  const greetPrompt = `Der Nutzer hat gerade das Begleiter-Fenster in der Ansicht "${viewLabel}" geöffnet. Begrüße ihn kurz (1 Satz) mit Bezug auf diese Ansicht. Kein "Hallo" oder "Hi" – steig direkt ein.`;

  const messages = buildMessages([], greetPrompt);

  appendCompanionMessage('assistant', '…', true);

  try {
    const response = await callGemini(apiKey, systemPrompt, messages, { taskType: 'chat' });
    removeLoadingMessage();
    const text = response.text || response;
    appendCompanionMessage('assistant', text);
    companionHistory.push({ role: 'assistant', content: text });
  } catch {
    removeLoadingMessage();
  }
}

// ── Voice Input ───────────────────────────────────────
async function startCompanionVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    appendCompanionMessage('assistant', 'Spracherkennung wird auf diesem Gerät nicht unterstützt.');
    return;
  }

  const voiceBtn = document.getElementById('companion-voice');
  if (voiceBtn) {
    voiceBtn.classList.add('companion-voice--listening');
    voiceBtn.textContent = '🔴';
  }

  try {
    const text = await new Promise((resolve, reject) => {
      const rec = new SpeechRecognition();
      rec.lang = 'de-DE';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      let settled = false;

      rec.onresult = (event) => {
        if (!settled) { settled = true; resolve(event.results[0][0].transcript); }
      };
      rec.onerror = (event) => {
        if (!settled) {
          settled = true;
          if (event.error === 'no-speech') resolve(null);
          else reject(event);
        }
      };
      rec.onend = () => {
        if (!settled) { settled = true; resolve(null); }
      };
      rec.start();
      setTimeout(() => rec.stop(), 10000);
    });

    if (text) {
      await sendCompanionMessage(text);
    }
  } catch {
    // Speech recognition failed silently
  } finally {
    if (voiceBtn) {
      voiceBtn.classList.remove('companion-voice--listening');
      voiceBtn.textContent = '🎤';
    }
  }
}

// ── Send Message ──────────────────────────────────────
async function sendCompanionMessage(text) {
  if (!text) return;

  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    appendCompanionMessage('assistant', 'API Key fehlt. Bitte in den Einstellungen eintragen.');
    return;
  }

  appendCompanionMessage('user', text);
  companionHistory.push({ role: 'user', content: text });

  // Loading indicator
  appendCompanionMessage('assistant', '…', true);

  try {
    const systemPrompt = buildCompanionSystemPrompt();
    const history = companionHistory.slice(-16).map(m => ({ role: m.role, content: m.content }));
    const chatMessages = buildMessages(history, text);

    const response = await callGemini(apiKey, systemPrompt, chatMessages, {
      tools: ORDO_FUNCTIONS,
      taskType: 'chat',
    });

    removeLoadingMessage();

    const responseText = response.text || '';
    const functionCalls = response.functionCalls || [];

    // Execute function calls
    for (const call of functionCalls) {
      const action = functionCallToAction(call);
      if (!action) continue;
      const normalized = normalizeOrdoAction(action);
      if (normalized) executeOrdoAction(normalized);
    }

    if (responseText) {
      appendCompanionMessage('assistant', responseText);
      companionHistory.push({ role: 'assistant', content: responseText });
    }
  } catch (err) {
    removeLoadingMessage();
    appendCompanionMessage('assistant', 'Fehler bei der Anfrage. Versuch es nochmal.');
  }
}

// ── DOM Helpers ───────────────────────────────────────
function appendCompanionMessage(role, text, isLoading = false) {
  const container = document.getElementById('companion-messages');
  if (!container) return;

  const div = document.createElement('div');
  div.className = `companion-msg companion-msg--${role}`;
  if (isLoading) {
    div.classList.add('companion-msg--loading');
    div.innerHTML = '<span class="companion-dots"><span>.</span><span>.</span><span>.</span></span>';
  } else {
    div.textContent = text;
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeLoadingMessage() {
  const container = document.getElementById('companion-messages');
  if (!container) return;
  const loading = container.querySelector('.companion-msg--loading');
  if (loading) loading.remove();
}
