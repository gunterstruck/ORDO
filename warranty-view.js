// warranty-view.js – Warranty Overview & Banner (extracted from brain-view.js)

import Brain from './brain.js';
import { escapeHTML } from './app.js';
import { requestOverlay, releaseOverlay } from './overlay-manager.js';
import { showItemDetailPanel } from './item-detail.js';

export function showWarrantyOverview() {
  if (!requestOverlay('warranty-overview', 30, () => {
    document.getElementById('item-detail-panel')?.remove();
    releaseOverlay('warranty-overview');
  })) return;

  const existing = document.getElementById('item-detail-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'item-detail-panel';
  panel.className = 'item-detail-panel';

  const overlay = document.createElement('div');
  overlay.className = 'item-detail-overlay';
  overlay.addEventListener('click', () => { panel.remove(); releaseOverlay('warranty-overview'); });

  const sheet = document.createElement('div');
  sheet.className = 'item-detail-sheet';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'item-detail-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => { panel.remove(); releaseOverlay('warranty-overview'); });
  sheet.appendChild(closeBtn);

  const title = document.createElement('h2');
  title.className = 'item-detail-title';
  title.textContent = '🛡️ Garantie-Übersicht';
  sheet.appendChild(title);

  const expiring = Brain.getExpiringWarranties(30);
  const expired = Brain.getExpiredWarranties();
  const active = Brain.getActiveWarranties();

  if (expiring.length === 0 && expired.length === 0 && active.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'item-detail-empty-hint';
    empty.textContent = 'Keine Garantien erfasst.';
    sheet.appendChild(empty);
  } else {
    if (expiring.length > 0) {
      sheet.appendChild(buildWarrantyGroup('⚠️ Bald ablaufend', expiring, 'warranty-item--expiring'));
    }
    if (expired.length > 0) {
      sheet.appendChild(buildWarrantyGroup('❌ Abgelaufen', expired, 'warranty-item--expired'));
    }
    if (active.length > 0) {
      sheet.appendChild(buildWarrantyGroup(`✅ Aktiv (${active.length})`, active, ''));
    }
  }

  panel.appendChild(overlay);
  panel.appendChild(sheet);
  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.classList.add('item-detail-panel--visible'));
}

function buildWarrantyGroup(label, items, className) {
  const group = document.createElement('div');
  group.className = 'warranty-overview-group';

  const header = document.createElement('div');
  header.className = 'warranty-overview-header';
  header.textContent = label;
  group.appendChild(header);

  items.forEach(w => {
    const name = Brain.getItemName(w.item);
    const room = Brain.getRoom(w.roomId);
    const container = Brain.getContainer(w.roomId, w.containerId);

    const el = document.createElement('div');
    el.className = `warranty-item ${className}`;

    const daysText = w.daysLeft >= 0 ? `noch ${w.daysLeft} Tage` : `seit ${Math.abs(w.daysLeft)} Tagen`;
    const locationText = `${room?.name || w.roomId} > ${container?.name || w.containerId}`;

    el.innerHTML = `<span class="warranty-item-name">🛡️ ${escapeHTML(name)}</span><span class="warranty-item-days">${escapeHTML(daysText)}</span><span class="warranty-item-location">${escapeHTML(locationText)}</span>`;

    el.addEventListener('click', () => {
      const existingPanel = document.getElementById('item-detail-panel');
      if (existingPanel) existingPanel.remove();
      releaseOverlay('warranty-overview');
      showItemDetailPanel(w.roomId, w.containerId, name);
    });

    group.appendChild(el);
  });

  return group;
}

export function checkWarrantyBanner() {
  const lastShown = localStorage.getItem('ordo_warranty_hint_shown');
  const today = new Date().toISOString().slice(0, 10);
  if (lastShown === today) return;

  const expiring = Brain.getExpiringWarranties(30);
  if (expiring.length === 0) return;

  localStorage.setItem('ordo_warranty_hint_shown', today);

  const banner = document.createElement('div');
  banner.className = 'warranty-banner';
  banner.innerHTML = `<span>🛡️ ${expiring.length} Garantie${expiring.length > 1 ? 'n' : ''} läuft bald ab</span><button class="warranty-banner-btn">Ansehen</button>`;

  banner.querySelector('.warranty-banner-btn').addEventListener('click', () => {
    banner.remove();
    showWarrantyOverview();
  });

  document.body.appendChild(banner);

  setTimeout(() => {
    if (banner.parentNode) {
      banner.classList.add('warranty-banner--out');
      banner.addEventListener('animationend', () => banner.remove());
    }
  }, 10000);
}
