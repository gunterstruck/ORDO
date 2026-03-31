// warranty-view.js – Warranty Overview, Expiry Overview & Banners

import Brain from './brain.js';
import { escapeHTML } from './app.js';
import { requestOverlay, releaseOverlay } from './overlay-manager.js';
import { showItemDetailPanel } from './item-detail.js';
import { showToast } from './modal.js';

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
  banner.innerHTML = `<span>🛡️ ${expiring.length} Garantie${expiring.length > 1 ? 'n' : ''} ${expiring.length > 1 ? 'laufen' : 'läuft'} bald ab</span><button class="warranty-banner-btn">Ansehen</button>`;

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

// ── Expiry / Verfallsdaten ──────────────────────────────

function getExpiryStatus(daysUntil) {
  if (daysUntil < 0) return { cls: 'expired', label: `Abgelaufen seit ${Math.abs(daysUntil)} Tagen`, icon: '🔴' };
  if (daysUntil <= 7) return { cls: 'critical', label: `Noch ${daysUntil} Tage`, icon: '🔴' };
  if (daysUntil <= 30) return { cls: 'warning', label: `Noch ${daysUntil} Tage`, icon: '🟡' };
  if (daysUntil <= 90) return { cls: 'upcoming', label: `Noch ${Math.round(daysUntil / 30)} Monate`, icon: '🟢' };
  return { cls: 'ok', label: `Noch ${Math.round(daysUntil / 30)} Monate`, icon: '🟢' };
}

export { getExpiryStatus };

export function showExpiryOverview() {
  if (!requestOverlay('expiry-overview', 30, () => {
    document.getElementById('item-detail-panel')?.remove();
    releaseOverlay('expiry-overview');
  })) return;

  const existing = document.getElementById('item-detail-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'item-detail-panel';
  panel.className = 'item-detail-panel';

  const overlay = document.createElement('div');
  overlay.className = 'item-detail-overlay';
  overlay.addEventListener('click', () => { panel.remove(); releaseOverlay('expiry-overview'); });

  const sheet = document.createElement('div');
  sheet.className = 'item-detail-sheet';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'item-detail-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => { panel.remove(); releaseOverlay('expiry-overview'); });
  sheet.appendChild(closeBtn);

  const title = document.createElement('h2');
  title.className = 'item-detail-title';
  title.textContent = '⏰ Verfallsdaten';
  sheet.appendChild(title);

  const allExpiry = Brain.getItemsWithExpiry();

  if (allExpiry.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'item-detail-empty-hint';
    empty.textContent = 'Keine Verfallsdaten erfasst.';
    sheet.appendChild(empty);
  } else {
    const expired = allExpiry.filter(e => e.isExpired);
    const expiringSoon = allExpiry.filter(e => !e.isExpired && e.daysUntilExpiry <= 30);
    const ok = allExpiry.filter(e => !e.isExpired && e.daysUntilExpiry > 30);

    if (expired.length > 0) {
      sheet.appendChild(buildExpiryGroup('Abgelaufen', expired, panel));
    }
    if (expiringSoon.length > 0) {
      sheet.appendChild(buildExpiryGroup('Läuft bald ab (30 Tage)', expiringSoon, panel));
    }
    if (ok.length > 0) {
      sheet.appendChild(buildExpiryGroup('Alles OK', ok, panel));
    }
  }

  // Back button
  const backBtn = document.createElement('button');
  backBtn.className = 'item-detail-action-btn';
  backBtn.style.cssText = 'margin-top: 16px; width: 100%;';
  backBtn.textContent = '🏠 Zurück';
  backBtn.addEventListener('click', () => { panel.remove(); releaseOverlay('expiry-overview'); });
  sheet.appendChild(backBtn);

  panel.appendChild(overlay);
  panel.appendChild(sheet);
  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.classList.add('item-detail-panel--visible'));
}

function buildExpiryGroup(label, items, panel) {
  const section = document.createElement('div');
  section.className = 'expiry-section';

  const sectionTitle = document.createElement('div');
  sectionTitle.className = 'expiry-section-title';
  sectionTitle.textContent = label;
  section.appendChild(sectionTitle);

  items.forEach(exp => {
    const status = getExpiryStatus(exp.daysUntilExpiry);
    const el = document.createElement('div');
    el.className = 'expiry-item';

    const icon = document.createElement('span');
    icon.className = 'expiry-icon';
    icon.textContent = status.icon;
    el.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'expiry-info';

    const name = document.createElement('div');
    name.className = 'expiry-name';
    name.textContent = exp.item.name;
    info.appendChild(name);

    const location = document.createElement('div');
    location.className = 'expiry-location';
    location.textContent = `${exp.roomName} > ${exp.containerName}`;
    info.appendChild(location);

    const statusEl = document.createElement('div');
    statusEl.className = `expiry-status ${status.cls}`;
    statusEl.textContent = status.label;
    info.appendChild(statusEl);

    el.appendChild(info);

    // Action button
    if (exp.isExpired) {
      const disposeBtn = document.createElement('button');
      disposeBtn.className = 'expiry-action-btn danger';
      disposeBtn.textContent = '🗑️ Entsorgen';
      disposeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        Brain.archiveItem(exp.roomId, exp.containerId, exp.item.name, 'entsorgt');
        const disposalTip = getDisposalTip(exp.expiryType);
        showToast(disposalTip ? `${exp.item.name} entsorgt. ${disposalTip}` : `${exp.item.name} entsorgt`);
        panel.remove();
        releaseOverlay('expiry-overview');
        showExpiryOverview(); // Refresh
      });
      el.appendChild(disposeBtn);
    } else if (exp.isExpiringSoon) {
      const checkBtn = document.createElement('button');
      checkBtn.className = 'expiry-action-btn';
      checkBtn.textContent = '📷 Datum prüfen';
      checkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.remove();
        releaseOverlay('expiry-overview');
        startExpiryPhotoCheck(exp.roomId, exp.containerId, exp.item.name);
      });
      el.appendChild(checkBtn);
    }

    // Click to open item detail
    el.addEventListener('click', () => {
      panel.remove();
      releaseOverlay('expiry-overview');
      showItemDetailPanel(exp.roomId, exp.containerId, exp.item.name);
    });

    section.appendChild(el);
  });

  return section;
}

function getDisposalTip(type) {
  switch (type) {
    case 'medikament': return 'Tipp: Medikamente → Apotheke';
    case 'kosmetik': return 'Tipp: Kosmetik → Restmüll';
    case 'lebensmittel': return 'Tipp: Biomüll oder Restmüll';
    default: return '';
  }
}

function startExpiryPhotoCheck(roomId, containerId, itemName) {
  // Trigger camera for expiry date check
  // Uses the existing camera infrastructure
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.addEventListener('change', async () => {
    if (!input.files?.[0]) { input.remove(); return; }
    const file = input.files[0];
    input.remove();

    try {
      showToast('Lese Verfallsdatum...', 'info');
      const { detectExpiryDate } = await import('./ai.js');
      const { blobToBase64 } = await import('./photo-flow.js');

      // Get API key
      const apiKey = Brain.getApiKey();
      if (!apiKey) { showToast('API-Key fehlt', 'error'); return; }

      const base64 = await blobToBase64(file);
      const result = await detectExpiryDate(apiKey, base64);

      if (result?.date) {
        const formatted = formatExpiryDate(result.date);
        const confirmed = window.confirm(`Erkannt: ${result.raw_text || formatted}\n\nStimmt das?`);
        if (confirmed) {
          Brain.setItemExpiry(roomId, containerId, itemName, {
            date: result.date,
            type: result.type || 'sonstiges',
            source: 'photo_ai',
          });
          showToast(`Verfallsdatum aktualisiert: ${formatted}`);
        }
      } else {
        showToast('Kein Verfallsdatum erkannt', 'error');
      }
    } catch (err) {
      console.error('Expiry photo check failed:', err);
      showToast('Fehler beim Lesen des Datums', 'error');
    }
  });

  input.click();
}

function formatExpiryDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 2) return `${parts[1]}/${parts[0]}`;
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return dateStr;
}

export function checkExpiryBanner() {
  const lastShown = localStorage.getItem('ordo_expiry_hint_shown');
  const today = new Date().toISOString().slice(0, 10);
  if (lastShown === today) return;

  const expiring = Brain.getExpiringItems(7);
  const expired = expiring.filter(e => e.isExpired);
  const soon = expiring.filter(e => !e.isExpired);
  if (expired.length === 0 && soon.length === 0) return;

  localStorage.setItem('ordo_expiry_hint_shown', today);

  const parts = [];
  if (expired.length > 0) parts.push(`${expired.length} abgelaufen`);
  if (soon.length > 0) parts.push(`${soon.length} läuft bald ab`);

  const banner = document.createElement('div');
  banner.className = 'expiry-banner';
  banner.innerHTML = `<span>⏰ ${parts.join(', ')}</span><button class="warranty-banner-btn">Details</button>`;

  banner.querySelector('.warranty-banner-btn').addEventListener('click', () => {
    banner.remove();
    showExpiryOverview();
  });

  document.body.appendChild(banner);

  setTimeout(() => {
    if (banner.parentNode) {
      banner.classList.add('warranty-banner--out');
      banner.addEventListener('animationend', () => banner.remove());
    }
  }, 10000);
}

export { formatExpiryDate, startExpiryPhotoCheck };
