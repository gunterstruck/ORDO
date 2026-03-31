// dialog-stream.js – Dialog-Stream Engine
// Der zentrale Container für alle Agent- und User-Nachrichten.
// Alle UI-Blöcke werden hier als DOM-Elemente in den Stream eingefügt.

import { renderBlock } from './ui-blocks.js';

const streamContainer = () => document.getElementById('dialog-stream');

/**
 * Escaped HTML-Sonderzeichen.
 */
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Fügt eine Agent-Nachricht zum Stream hinzu.
 * @param {string} text - Text der Nachricht (kann leer sein)
 * @param {Array} blocks - UI-Blöcke (Komponenten)
 * @param {Array} actions - Action-Buttons
 * @returns {HTMLElement}
 */
export function agentMessage(text, blocks = [], actions = []) {
  const msg = document.createElement('div');
  msg.classList.add('stream-msg', 'stream-agent');

  // Text
  if (text) {
    const textEl = document.createElement('div');
    textEl.classList.add('stream-text');
    textEl.textContent = text;
    msg.appendChild(textEl);
  }

  // UI-Blöcke
  for (const block of blocks) {
    const rendered = renderBlock(block);
    if (rendered) msg.appendChild(rendered);
  }

  // Action-Buttons
  if (actions.length > 0) {
    const actionsEl = createActionRow(actions);
    msg.appendChild(actionsEl);
  }

  appendAndScroll(msg);
  return msg;
}

/**
 * Fügt eine User-Nachricht zum Stream hinzu.
 */
export function userMessage(text) {
  const msg = document.createElement('div');
  msg.classList.add('stream-msg', 'stream-user');

  const textEl = document.createElement('div');
  textEl.classList.add('stream-text');
  textEl.textContent = text;
  msg.appendChild(textEl);

  appendAndScroll(msg);
  return msg;
}

/**
 * Fügt eine System-Info zum Stream hinzu (dezent).
 */
export function systemMessage(text) {
  const msg = document.createElement('div');
  msg.classList.add('stream-msg', 'stream-system');
  msg.textContent = text;
  appendAndScroll(msg);
  return msg;
}

/**
 * Zeigt einen Loading-Indikator im Stream.
 * @returns {HTMLElement} - Referenz zum Entfernen
 */
export function showStreamLoading(text = 'Denke nach...') {
  const msg = document.createElement('div');
  msg.classList.add('stream-msg', 'stream-agent', 'stream-loading');
  msg.innerHTML = `
    <div class="stream-loading-dots">
      <span></span><span></span><span></span>
    </div>
    <div class="stream-loading-text">${escapeHTML(text)}</div>
  `;
  appendAndScroll(msg);
  return msg;
}

/**
 * Entfernt den Loading-Indikator.
 */
export function hideStreamLoading(loadingEl) {
  if (loadingEl && loadingEl.parentNode) {
    loadingEl.remove();
  }
}

/**
 * Scrollt den Stream nach unten.
 */
function appendAndScroll(element) {
  const container = streamContainer();
  if (!container) return;
  container.appendChild(element);

  // Smooth scroll nach unten
  requestAnimationFrame(() => {
    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth',
    });
  });
}

/**
 * Leert den Stream (für Neustart / Home).
 */
export function clearStream() {
  const container = streamContainer();
  if (container) container.innerHTML = '';
}

/**
 * Action-Buttons als Chip-Row.
 * handleAction wird lazy importiert um Zirkuläre Deps zu vermeiden.
 */
function createActionRow(actions) {
  const row = document.createElement('div');
  row.classList.add('stream-actions');

  for (const action of actions.slice(0, 4)) {
    const btn = document.createElement('button');
    btn.classList.add('stream-action-btn');
    if (action.primary) btn.classList.add('primary');
    btn.innerHTML = `${action.icon ? action.icon + ' ' : ''}${escapeHTML(action.label)}`;

    btn.addEventListener('click', async () => {
      // Chip als aktiviert markieren
      btn.classList.add('activated');
      row.classList.add('used');
      // Action ausführen — lazy import um Zirkuläre Deps zu vermeiden
      const { handleAction } = await import('./ordo-agent.js');
      handleAction(action);
    });

    row.appendChild(btn);
  }

  return row;
}
