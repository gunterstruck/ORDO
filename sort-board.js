// sort-board.js – Aussortier-Board (Kanban-Pipeline)
// Vorgemerkte Items gruppiert nach Unentschieden / Verkaufen / Spenden / Entsorgen.
// Vormerken passiert im Item-Detail ("Aussortieren"), Abschluss archiviert
// mit passendem Grund (verkauft/gespendet/entsorgt) für die Organizer-Statistik.

import Brain from './brain.js';
import { escapeHTML } from './app.js';
import { requestOverlay, releaseOverlay } from './overlay-manager.js';
import { showToast } from './modal.js';

const GROUPS = [
  ['undecided', '🤔 Unentschieden'],
  ['sell', '💰 Verkaufen'],
  ['donate', '🎁 Spenden'],
  ['discard', '🗑️ Entsorgen'],
];

const DONE_LABEL = { sell: 'verkauft', donate: 'gespendet', discard: 'entsorgt' };

export function showSortBoard() {
  if (!requestOverlay('sort-board', 30, () => {
    document.getElementById('item-detail-panel')?.remove();
    releaseOverlay('sort-board');
  })) return;

  const existing = document.getElementById('item-detail-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'item-detail-panel';
  panel.className = 'item-detail-panel';

  const overlay = document.createElement('div');
  overlay.className = 'item-detail-overlay';
  overlay.addEventListener('click', () => { panel.remove(); releaseOverlay('sort-board'); });

  const sheet = document.createElement('div');
  sheet.className = 'item-detail-sheet';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'item-detail-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => { panel.remove(); releaseOverlay('sort-board'); });
  sheet.appendChild(closeBtn);

  const title = document.createElement('h2');
  title.className = 'item-detail-title';
  title.textContent = '📤 Aussortieren';
  sheet.appendChild(title);

  const content = document.createElement('div');
  renderBoardContent(content);
  sheet.appendChild(content);

  panel.appendChild(overlay);
  panel.appendChild(sheet);
  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.classList.add('item-detail-panel--visible'));
}

function renderBoardContent(content) {
  content.innerHTML = '';
  const board = Brain.getSortBoard();
  const total = GROUPS.reduce((sum, [key]) => sum + board[key].length, 0);

  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'item-detail-empty-hint';
    empty.textContent = 'Nichts vorgemerkt. Öffne ein Item und tippe auf „Aussortieren“, um es hier in die Pipeline zu legen.';
    content.appendChild(empty);
    return;
  }

  for (const [key, label] of GROUPS) {
    const entries = board[key];
    if (entries.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'warranty-overview-group';

    const header = document.createElement('div');
    header.className = 'warranty-overview-header';
    header.textContent = `${label} (${entries.length})`;
    group.appendChild(header);

    entries.forEach(entry => {
      const el = document.createElement('div');
      el.className = 'warranty-item sort-board-item';

      const valueText = entry.value != null ? ` · ~${Math.round(entry.value)} €` : '';
      const mengeText = entry.menge > 1 ? `${entry.menge}× ` : '';
      el.innerHTML = `<span class="warranty-item-name">${escapeHTML(mengeText + entry.name)}</span><span class="warranty-item-days">${escapeHTML(valueText.replace(' · ', ''))}</span><span class="warranty-item-location">${escapeHTML(`${entry.roomName} > ${entry.containerName}`)}</span>`;

      const btnRow = document.createElement('div');
      btnRow.className = 'item-detail-purchase-actions sort-board-actions';

      if (key === 'undecided') {
        for (const [target, targetLabel] of [['sell', '💰'], ['donate', '🎁'], ['discard', '🗑️'], ['keep', '↩️ Behalten']]) {
          const b = document.createElement('button');
          b.className = 'item-detail-action-btn';
          b.textContent = targetLabel;
          b.addEventListener('click', e => {
            e.stopPropagation();
            Brain.setSortStatus(entry.roomId, entry.containerId, entry.name, target);
            renderBoardContent(content);
          });
          btnRow.appendChild(b);
        }
      } else {
        const doneBtn = document.createElement('button');
        doneBtn.className = 'item-detail-action-btn';
        doneBtn.textContent = '✓ Erledigt';
        doneBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (Brain.completeSortItem(entry.roomId, entry.containerId, entry.name)) {
            showToast(`"${entry.name}" als ${DONE_LABEL[key]} archiviert`);
            renderBoardContent(content);
          }
        });
        btnRow.appendChild(doneBtn);

        const keepBtn = document.createElement('button');
        keepBtn.className = 'item-detail-action-btn';
        keepBtn.textContent = '↩️ Behalten';
        keepBtn.addEventListener('click', e => {
          e.stopPropagation();
          Brain.setSortStatus(entry.roomId, entry.containerId, entry.name, 'keep');
          showToast(`"${entry.name}" bleibt`);
          renderBoardContent(content);
        });
        btnRow.appendChild(keepBtn);
      }

      el.appendChild(btnRow);
      group.appendChild(el);
    });

    content.appendChild(group);
  }
}
