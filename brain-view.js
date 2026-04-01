// brain-view.js – Brain-Ansicht, Map-View, NFC-Context, Lightbox, Dialoge

import Brain, { calculateAutoLayout, calculateNeighborLayout } from './brain.js';
import { showToast, showInputModal, showConfirmModal } from './modal.js';
import { showView, debugLog, ensureRoom, getNfcContext, setNfcContext, getCurrentView, escapeHTML, normalizeRoomType } from './app.js';
import { openCameraForContainer, showStagingOverlay, addFileToStaging, setStagingTarget } from './photo-flow.js';
import { capturePhoto } from './camera.js';
import { sendChatMessage } from './chat.js';
import { analyzeReceipt, estimateSingleItemValue } from './ai.js';
import { showReportDialog } from './report.js';
import { showCurrentStep, startBlueprint, startCleanupQuest, showRoomCheck, showHouseholdCheck, showSalesView } from './quest.js';
import { requestOverlay, releaseOverlay } from './overlay-manager.js';
import { init3DView, destroy3DView, isWebGLAvailable, loadSplat, loadGLTF, clearSplats, check3DAvailability } from './spatial-3d.js';
import { generateWorldFromPhoto, downloadSplat, hasMarbleKey, getMarbleKey } from './marble-api.js';
import { showItemDetailPanel } from './item-detail.js';
import { showWarrantyOverview, checkWarrantyBanner, showExpiryOverview, checkExpiryBanner } from './warranty-view.js';
import { calculateFreedomIndex, getQuickWins, getQuickDecision, getTasksForTimeSlot, simulateScore, containerCheck, recordWeeklyScore, getScoreTrend, getCurrentSeason, getSeasonalRecommendations, detectLifeEvents, getImprovementReport, getArchivedByReason } from './organizer.js';

// ── Room Colors (type-based pastels) ──────────────────
const ROOM_COLORS = {
  kueche:        { bg: '#FFF3E0', border: '#FFB74D' },
  bad:           { bg: '#E3F2FD', border: '#64B5F6' },
  schlafzimmer:  { bg: '#F3E5F5', border: '#BA68C8' },
  wohnzimmer:    { bg: '#FFF8E1', border: '#FFD54F' },
  arbeitszimmer: { bg: '#E8EAF6', border: '#7986CB' },
  kinderzimmer:  { bg: '#E8F5E9', border: '#81C784' },
  flur:          { bg: '#EFEBE9', border: '#A1887F' },
  keller:        { bg: '#ECEFF1', border: '#90A4AE' },
  abstellraum:   { bg: '#F5F5F5', border: '#BDBDBD' },
  garage:        { bg: '#ECEFF1', border: '#78909C' },
  esszimmer:     { bg: '#FFF8E1', border: '#FFCA28' },
  ankleide:      { bg: '#FCE4EC', border: '#F48FB1' },
  dachboden:     { bg: '#EFEBE9', border: '#BCAAA4' },
  garten:        { bg: '#E8F5E9', border: '#66BB6A' },
  gaestezimmer:  { bg: '#F3E5F5', border: '#CE93D8' },
  sonstiges:     { bg: '#F5F0EB', border: '#D4C5B5' },
  default:       { bg: '#F5F0EB', border: '#D4C5B5' },
};

function getRoomColor(roomIdOrName) {
  const normalized = normalizeRoomType(roomIdOrName);
  return ROOM_COLORS[normalized] || ROOM_COLORS.default;
}

function getRoomFreshness(room) {
  let latestUpdate = 0;
  function scanContainers(containers) {
    for (const c of Object.values(containers || {})) {
      const updated = c.last_updated || 0;
      if (updated > latestUpdate) latestUpdate = updated;
      if (c.containers) scanContainers(c.containers);
    }
  }
  scanContainers(room.containers);

  if (latestUpdate === 0) return { cls: 'stale', label: 'Noch nie aktualisiert' };

  const daysSince = (Date.now() - latestUpdate) / (1000 * 60 * 60 * 24);
  if (daysSince < 1) return { cls: 'fresh', label: 'Heute' };
  if (daysSince < 30) return { cls: 'fresh', label: `Vor ${Math.round(daysSince)} ${Math.round(daysSince) === 1 ? 'Tag' : 'Tagen'}` };
  if (daysSince < 180) return { cls: 'aging', label: `Vor ${Math.round(daysSince / 30)} Monaten` };
  return { cls: 'stale', label: `Vor ${Math.round(daysSince / 30)} Monaten` };
}

// ── State ──────────────────────────────────────────────
let brainViewMode = localStorage.getItem('ordo_view_mode') || 'list';
let nfcCtxInactivityTimer = null;
let moveContainerState = null;
let organizerSessionMode = null;

// ── Filter State ─────────────────────────────────────
let currentFilter = 'all'; // 'all' | 'mobile' | 'fixed'

// ── Drag-and-Drop State ────────────────────────────────
let dragState = null;
// { type: 'item'|'container', itemName, roomId, fromContainerId,
//   ghostEl, originalEl, startX, startY, offsetX, offsetY,
//   dropBarEl, rafId, active }
let lastSpatialAction = null;
let undoToastTimer = null;

// ── Helpers ────────────────────────────────────────────
function setupLongPress(el, callback) {
  let timer;
  el.addEventListener('pointerdown', () => { timer = setTimeout(callback, 600); });
  el.addEventListener('pointerup', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => clearTimeout(timer));
}

function showBrainToast(msg) {
  const existing = document.getElementById('brain-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'brain-toast';
  toast.className = 'brain-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function setupBrain() {
  recordWeeklyScore();

  // Observer: auto-refresh brain view when data changes
  Brain.on('dataChanged', () => {
    if (getCurrentView() === 'brain') {
      if (brainViewMode === 'map') {
        // Only re-render overview, not if we're in room detail
        const mapEl = document.getElementById('brain-map');
        if (mapEl && !mapEl.querySelector('.map-room-detail')) {
          renderMapView();
        }
      } else {
        renderBrainView();
      }
    }
  });

  // Observer: AI actions trigger a brain view refresh
  Brain.on('actionExecuted', () => {
    renderBrainView();
  });

  document.getElementById('brain-add-room').addEventListener('click', showAddRoomDialog);
  document.getElementById('brain-scan-rooms').addEventListener('click', startBlueprint);
  document.getElementById('brain-warranty-overview').addEventListener('click', showWarrantyOverview);
  document.getElementById('brain-report-btn').addEventListener('click', () => showReportDialog());

  // Map view toggle
  setupMapViewToggle();

  // Lightbox close
  const lb = document.getElementById('lightbox');
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });

  // Event delegation for brain-tree (single listeners instead of per-element)
  setupBrainTreeDelegation();
}

function renderBrainView() {
  // If map mode is active, render map instead
  if (brainViewMode === 'map') {
    document.getElementById('brain-tree').style.display = 'none';
    document.getElementById('brain-map').style.display = '';
    renderMapView();
    return;
  }
  document.getElementById('brain-tree').style.display = '';
  document.getElementById('brain-map').style.display = 'none';

  const container = document.getElementById('brain-tree');
  const rooms = Brain.getRooms();
  container.innerHTML = '';

  const dashboard = buildOrganizerDashboard();
  if (dashboard) container.appendChild(dashboard);

  // Update header with total household value
  const totalValue = Brain.getTotalHouseholdValue();
  const headerTitle = document.querySelector('.brain-view-title');
  if (headerTitle) {
    if (totalValue.itemCount > 0) {
      const valText = totalValue.min === totalValue.max
        ? `${formatValueDE(totalValue.min)}`
        : `~${formatValueDE(totalValue.min)}–${formatValueDE(totalValue.max)}`;
      headerTitle.innerHTML = `🏠 Mein Zuhause <span class="brain-header-value">${valText}</span>`;
    } else {
      headerTitle.textContent = '🏠 Mein Zuhause';
    }
  }

  const header = document.querySelector('.brain-view-header');
  const existingQuestBadge = header?.querySelector('.brain-quest-badge');
  if (existingQuestBadge) existingQuestBadge.remove();
  const activeQuest = Brain.getQuest();
  if (header && activeQuest?.active) {
    const questBtn = document.createElement('button');
    questBtn.className = 'brain-quest-badge';
    questBtn.textContent = `🏠 Quest ${activeQuest.progress?.percent || 0}% · Fortsetzen`;
    questBtn.addEventListener('click', () => showCurrentStep());
    header.appendChild(questBtn);
  }

  // Hide breadcrumb when rendering full view
  const breadcrumb = document.getElementById('brain-breadcrumb');
  if (breadcrumb) breadcrumb.style.display = 'none';

  // Filter bar
  if (Object.keys(rooms).length > 0) {
    const filterBar = document.createElement('div');
    filterBar.className = 'brain-filter-bar';
    [
      { key: 'all', label: 'Alles' },
      { key: 'mobile', label: '\u{1F4E6} Umzug' },
      { key: 'fixed', label: '\u{1F3E0} Fest' }
    ].forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'brain-filter-btn' + (currentFilter === f.key ? ' active' : '');
      btn.dataset.filter = f.key;
      btn.textContent = f.label;
      filterBar.appendChild(btn);
    });
    filterBar.addEventListener('click', e => {
      const btn = e.target.closest('.brain-filter-btn');
      if (!btn || btn.dataset.filter === currentFilter) return;
      currentFilter = btn.dataset.filter;
      renderBrainView();
    });
    container.appendChild(filterBar);
  }

  if (Object.keys(rooms).length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'brain-empty-cta';
    const ctaIcon = document.createElement('span');
    ctaIcon.className = 'brain-empty-cta-icon';
    ctaIcon.textContent = '🏠';
    const ctaText = document.createElement('p');
    ctaText.className = 'brain-empty-cta-text';
    ctaText.textContent = 'Dein Zuhause ist noch leer. Starte mit einem Foto von einem Schrank, Regal oder einer Schublade.';
    emptyEl.appendChild(ctaIcon);
    emptyEl.appendChild(ctaText);
    const btn = document.createElement('button');
    btn.className = 'brain-empty-cta-btn';
    btn.textContent = '📷 Erstes Foto machen';
    // Click handled by delegation on #brain-tree
    emptyEl.appendChild(btn);
    container.appendChild(emptyEl);
    return;
  }

  for (const [roomId, room] of Object.entries(rooms)) {
    container.appendChild(buildRoomNode(roomId, room));
  }
}

function buildOrganizerDashboard() {
  if (Brain.isEmpty()) return null;

  const score = calculateFreedomIndex();
  const quickWins = getQuickWins(3);
  const trend = getScoreTrend();

  const wrap = document.createElement('div');
  wrap.className = 'organizer-dashboard';

  const title = document.createElement('div');
  title.className = 'freedom-index';
  title.textContent = `🧠 Dein Kopf ist zu ${score.percent}% frei`;

  const bar = document.createElement('div');
  bar.className = 'freedom-bar';
  const fill = document.createElement('div');
  fill.className = 'freedom-bar-fill';
  fill.style.width = `${score.percent}%`;
  fill.classList.add(score.percent >= 75 ? 'high' : (score.percent >= 50 ? 'medium' : 'low'));
  bar.appendChild(fill);

  const detail = document.createElement('div');
  detail.className = 'freedom-detail';
  detail.textContent = `${score.totalDebt} offene Entscheidungen`;

  wrap.appendChild(title);
  wrap.appendChild(bar);
  wrap.appendChild(detail);

  if (trend) {
    const trendEl = document.createElement('div');
    trendEl.className = 'freedom-detail';
    const sign = trend.delta >= 0 ? '↑' : '↓';
    trendEl.innerHTML = `<span class="freedom-trend">${sign} ${Math.abs(trend.delta)} ${trend.delta >= 0 ? 'mehr' : 'weniger'} als letzte Woche</span>`;
    wrap.appendChild(trendEl);
  }

  const qwTitle = document.createElement('div');
  qwTitle.className = 'freedom-detail';
  qwTitle.style.marginTop = '10px';
  qwTitle.textContent = '⚡ Quick Wins:';
  wrap.appendChild(qwTitle);

  const list = document.createElement('div');
  list.className = 'quick-wins-list';
  quickWins.forEach((win, idx) => {
    const row = document.createElement('button');
    row.className = 'quick-win-item';
    row.dataset.action = 'organizer-quick-win';
    row.dataset.winIndex = String(idx);
    row.innerHTML = `<span>• ${escapeHTML(win.description)}</span><span class="quick-win-impact">${win.estimatedMinutes} Min · -${win.impactPoints}</span>`;
    list.appendChild(row);
  });
  if (quickWins.length === 0) {
    const row = document.createElement('div');
    row.className = 'quick-win-item';
    row.textContent = 'Aktuell keine offenen Quick Wins ✨';
    list.appendChild(row);
  }
  wrap.appendChild(list);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px';

  const startBtn = document.createElement('button');
  startBtn.className = 'brain-add-btn';
  startBtn.dataset.action = 'organizer-start-session';
  startBtn.textContent = '🧹 Aufräum-Session starten';
  startBtn.style.flex = '1';
  btnRow.appendChild(startBtn);

  const hhCheckBtn = document.createElement('button');
  hhCheckBtn.className = 'brain-add-btn';
  hhCheckBtn.dataset.action = 'organizer-household-check';
  hhCheckBtn.textContent = '🏠 Haushalts-Check';
  hhCheckBtn.style.flex = '1';
  btnRow.appendChild(hhCheckBtn);

  wrap.appendChild(btnRow);

  // Expiry banner
  const expiryBannerEl = buildExpiryDashboardBanner();
  if (expiryBannerEl) wrap.appendChild(expiryBannerEl);

  // Seasonal card
  const seasonalCard = buildSeasonalCard();
  if (seasonalCard) wrap.appendChild(seasonalCard);

  // Life event banner
  const lifeEventBanner = buildLifeEventBanner();
  if (lifeEventBanner) wrap.appendChild(lifeEventBanner);

  // Improvement compact
  const improvementCard = buildImprovementCompact();
  if (improvementCard) wrap.appendChild(improvementCard);

  return wrap;
}

function buildExpiryDashboardBanner() {
  const expiring = Brain.getExpiringItems(30);
  const expired = expiring.filter(e => e.isExpired);
  const soon = expiring.filter(e => !e.isExpired);
  if (expired.length === 0 && soon.length === 0) return null;

  const parts = [];
  if (expired.length > 0) parts.push(`${expired.length} abgelaufen`);
  if (soon.length > 0) parts.push(`${soon.length} läuft bald ab`);

  const banner = document.createElement('div');
  banner.className = 'expiry-banner';
  banner.innerHTML = `<span>⚠️ ${parts.join(', ')}</span><span style="font-size:12px">📋 Details</span>`;
  banner.addEventListener('click', () => showExpiryOverview());
  return banner;
}

function buildSeasonalCard() {
  const seasonal = getSeasonalRecommendations();
  if (!seasonal) return null;
  if (seasonal.storeAway.length === 0 && seasonal.bringOut.length === 0) return null;

  const dismissKey = `ordo_seasonal_dismissed_${seasonal.season.key}`;
  const dismissed = localStorage.getItem(dismissKey);
  if (dismissed) {
    const daysSince = (Date.now() - new Date(dismissed).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) return null;
  }

  const topItem = seasonal.storeAway[0] || seasonal.bringOut[0];
  const action = seasonal.storeAway.length > 0 ? 'einlagern' : 'rausholen';
  const count = seasonal.storeAway.length + seasonal.bringOut.length;

  const card = document.createElement('div');
  card.className = 'seasonal-card';
  card.dataset.season = seasonal.season.key;

  const header = document.createElement('div');
  header.className = 'seasonal-header';
  const headerLabel = document.createElement('span');
  headerLabel.textContent = `${seasonal.season.emoji} ${seasonal.season.label}`;
  header.appendChild(headerLabel);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'seasonal-dismiss';
  dismissBtn.textContent = '✕';
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    localStorage.setItem(dismissKey, new Date().toISOString());
    card.remove();
  });
  header.appendChild(dismissBtn);

  const body = document.createElement('div');
  body.className = 'seasonal-body';
  body.textContent = count > 1
    ? `${count} Dinge könnten ${action === 'einlagern' ? 'eingelagert' : 'rausgeholt'} werden.`
    : `${escapeHTML(topItem.itemName)} → ${escapeHTML(topItem.reason)}`;

  const actions = document.createElement('div');
  actions.className = 'seasonal-actions';

  const detailBtn = document.createElement('button');
  detailBtn.className = 'seasonal-action-btn';
  detailBtn.textContent = 'Details';
  detailBtn.addEventListener('click', () => showSeasonalDetails());
  actions.appendChild(detailBtn);

  const laterBtn = document.createElement('button');
  laterBtn.className = 'seasonal-action-btn secondary';
  laterBtn.textContent = 'Später';
  laterBtn.addEventListener('click', () => {
    localStorage.setItem(dismissKey, new Date().toISOString());
    card.remove();
  });
  actions.appendChild(laterBtn);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(actions);

  return card;
}

function showSeasonalDetails() {
  const seasonal = getSeasonalRecommendations();
  if (!seasonal) return;

  if (!requestOverlay('seasonal-details')) return;

  const overlay = document.createElement('div');
  overlay.className = 'quest-overlay';
  overlay.id = 'seasonal-details';

  let html = `<div class="quest-header">
    <span>${seasonal.season.emoji} ${escapeHTML(seasonal.season.label)}</span>
    <button class="quest-close" data-action="close-seasonal">✕</button>
  </div><div class="quest-body" style="padding:14px;">`;

  if (seasonal.storeAway.length > 0) {
    html += `<div style="font-weight:600;margin-bottom:8px;">📦 EINLAGERN (${seasonal.storeAway.length})</div>`;
    for (const item of seasonal.storeAway) {
      html += `<div class="seasonal-detail-item">
        <div>• ${escapeHTML(item.itemName)} <span style="color:var(--text-secondary);font-size:12px;">(${escapeHTML(item.roomName)})</span></div>
        <div style="color:var(--text-secondary);font-size:12px;margin-left:12px;">→ in den ${escapeHTML(item.targetRoomType)} · ${escapeHTML(item.reason)}</div>
        <button class="seasonal-action-btn" style="margin:4px 0 8px 12px;font-size:12px;padding:4px 10px;" data-action="seasonal-store" data-room="${item.roomId}" data-container="${item.containerId}" data-item="${escapeHTML(item.itemName)}" data-target="${escapeHTML(item.targetRoomType)}">📦 Einlagern</button>
      </div>`;
    }
  }

  if (seasonal.bringOut.length > 0) {
    html += `<div style="font-weight:600;margin:12px 0 8px;">🔄 RAUSHOLEN (${seasonal.bringOut.length})</div>`;
    for (const item of seasonal.bringOut) {
      html += `<div class="seasonal-detail-item">
        <div>• ${escapeHTML(item.itemName)} <span style="color:var(--text-secondary);font-size:12px;">(${escapeHTML(item.roomName)})</span></div>
        <div style="color:var(--text-secondary);font-size:12px;margin-left:12px;">${escapeHTML(item.reason)}</div>
      </div>`;
    }
  }

  html += `<div class="improvement-quote">${escapeHTML(seasonal.tip)}</div>`;

  if (seasonal.storeAway.length > 1) {
    html += `<button class="seasonal-action-btn" data-action="seasonal-store-all" style="width:100%;margin-top:8px;">📦 Alle einlagern</button>`;
  }

  html += `<button class="seasonal-action-btn secondary" data-action="close-seasonal" style="width:100%;margin-top:8px;">🏠 Zurück</button>`;
  html += `</div>`;

  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-action="close-seasonal"]');
    if (closeBtn) {
      overlay.remove();
      releaseOverlay('seasonal-details');
      return;
    }

    const storeBtn = e.target.closest('[data-action="seasonal-store"]');
    if (storeBtn) {
      const { room, container, item, target } = storeBtn.dataset;
      const storageRoom = findStorageRoomByType(target);
      if (storageRoom) {
        Brain.moveItem(room, container, item, storageRoom.roomId, storageRoom.containerId);
        showToast(`${item} → ${storageRoom.roomName}`);
        storeBtn.closest('.seasonal-detail-item').style.opacity = '0.4';
        storeBtn.disabled = true;
        storeBtn.textContent = '✓ Eingelagert';
      } else {
        showToast(`Kein ${target} gefunden`, 'error');
      }
      return;
    }

    const storeAllBtn = e.target.closest('[data-action="seasonal-store-all"]');
    if (storeAllBtn) {
      let moved = 0;
      for (const item of seasonal.storeAway) {
        const storageRoom = findStorageRoomByType(item.targetRoomType);
        if (storageRoom) {
          Brain.moveItem(item.roomId, item.containerId, item.itemName, storageRoom.roomId, storageRoom.containerId);
          moved++;
        }
      }
      showToast(`${moved} Dinge eingelagert`);
      overlay.remove();
      releaseOverlay('seasonal-details');
      renderBrainView();
    }
  });
}

function findStorageRoomByType(targetType) {
  const data = Brain.getData();
  for (const [roomId, room] of Object.entries(data.rooms || {})) {
    const roomType = normalizeRoomType(room.name);
    if (roomType === targetType) {
      const containerIds = Object.keys(room.containers || {});
      if (containerIds.length > 0) {
        return { roomId, roomName: room.name, containerId: containerIds[0] };
      }
    }
  }
  return null;
}

function buildLifeEventBanner() {
  const events = detectLifeEvents();
  if (events.length === 0) return null;

  const top = events[0];
  const dismissKey = `ordo_life_event_dismissed_${top.event}`;
  const dismissed = localStorage.getItem(dismissKey);
  if (dismissed) return null;

  const banner = document.createElement('div');
  banner.className = 'life-event-banner';

  const title = document.createElement('div');
  title.className = 'life-event-title';
  title.textContent = `${top.emoji} ${top.message}`;

  const body = document.createElement('div');
  body.className = 'life-event-body';
  body.textContent = top.suggestion;

  const actions = document.createElement('div');
  actions.className = 'seasonal-actions';

  const actionBtn = document.createElement('button');
  actionBtn.className = 'seasonal-action-btn';
  actionBtn.textContent = top.suggestion.split('?')[0];
  actionBtn.addEventListener('click', () => {
    executeLifeEventAction(top.action);
    localStorage.setItem(dismissKey, new Date().toISOString());
    banner.remove();
  });
  actions.appendChild(actionBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'seasonal-action-btn secondary';
  dismissBtn.textContent = '✕ Nicht relevant';
  dismissBtn.addEventListener('click', () => {
    localStorage.setItem(dismissKey, new Date().toISOString());
    banner.remove();
  });
  actions.appendChild(dismissBtn);

  banner.appendChild(title);
  banner.appendChild(body);
  banner.appendChild(actions);

  return banner;
}

function executeLifeEventAction(action) {
  switch (action) {
    case 'generateDonationPDF':
      import('./report.js').then(m => m.generateDonationListPDF());
      break;
    case 'startCleanup':
      startCleanupQuest();
      break;
    case 'showArchiveSummary':
      showImprovementReport();
      break;
    case 'suggestForRoom':
      showHouseholdCheck();
      break;
  }
}

function buildImprovementCompact() {
  const report = getImprovementReport();
  if (report.current === undefined) return null;
  if (!report.weekAgo && !report.monthAgo && !report.threeMonthsAgo && report.milestones.length === 0 && report.totalRemoved === 0) return null;

  const wrap = document.createElement('div');
  wrap.className = 'improvement-compact';

  const headline = document.createElement('div');
  headline.className = 'improvement-headline';

  if (report.threeMonthsAgo !== null) {
    headline.textContent = `📈 Vor 3 Monaten: ${report.threeMonthsAgo}% → Heute: ${report.current}%`;
  } else if (report.monthAgo !== null) {
    headline.textContent = `📈 Vor 1 Monat: ${report.monthAgo}% → Heute: ${report.current}%`;
  } else {
    headline.textContent = `📈 Dein Fortschritt`;
  }
  wrap.appendChild(headline);

  const delta = document.createElement('div');
  const ref = report.threeMonthsAgo ?? report.monthAgo ?? report.weekAgo;
  if (ref !== null) {
    const diff = report.current - ref;
    const sign = diff >= 0 ? '↑' : '↓';
    const trendLabel = report.trend === 'aufwärts' ? '📈' : report.trend === 'abwärts' ? '📉' : '➡️';
    delta.className = `improvement-delta ${diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'neutral'}`;
    delta.textContent = `${sign}${Math.abs(diff)}% · Trend: ${report.trend} ${trendLabel}`;
    wrap.appendChild(delta);
  }

  if (report.milestones.length > 0) {
    const ms = document.createElement('div');
    ms.className = 'improvement-milestones';
    for (const m of report.milestones) {
      const line = document.createElement('div');
      line.textContent = `${m.emoji} ${m.label}`;
      ms.appendChild(line);
    }
    wrap.appendChild(ms);
  }

  const detailBtn = document.createElement('button');
  detailBtn.className = 'seasonal-action-btn';
  detailBtn.textContent = '📊 Detailbericht';
  detailBtn.style.marginTop = '8px';
  detailBtn.addEventListener('click', () => showImprovementReport());
  wrap.appendChild(detailBtn);

  return wrap;
}

function showImprovementReport() {
  const report = getImprovementReport();
  const overlayId = requestOverlay('improvement-report');
  if (!overlayId) return;

  const overlay = document.createElement('div');
  overlay.className = 'quest-overlay';
  overlay.id = overlayId;

  const bars = [
    { label: 'Heute', value: report.current },
    { label: 'Vor 1 Woche', value: report.weekAgo },
    { label: 'Vor 1 Monat', value: report.monthAgo },
    { label: 'Vor 3 Monaten', value: report.threeMonthsAgo },
  ];

  let barsHtml = '';
  for (const b of bars) {
    if (b.value === null) continue;
    barsHtml += `<div class="score-history-bar">
      <span class="score-history-label">${escapeHTML(b.label)}</span>
      <div style="flex:1;background:var(--bg-secondary);border-radius:4px;overflow:hidden;">
        <div class="score-history-fill" style="width:${b.value}%"></div>
      </div>
      <span class="score-history-value">${b.value}%</span>
    </div>`;
  }

  let milestonesHtml = '';
  for (const m of report.milestones) {
    milestonesHtml += `<div>${m.emoji} ${escapeHTML(m.label)}</div>`;
  }

  const quote = getImprovementMessage(report);

  overlay.innerHTML = `<div class="quest-header">
    <span>📊 Verbesserungs-Report</span>
    <button class="quest-close" data-action="close-improvement">✕</button>
  </div>
  <div class="quest-body" style="padding:14px;">
    <div style="font-weight:600;margin-bottom:8px;">Kopf-Freiheits-Index:</div>
    ${barsHtml}
    ${milestonesHtml ? `<div style="font-weight:600;margin:16px 0 8px;">Meilensteine:</div><div class="improvement-milestones">${milestonesHtml}</div>` : ''}
    ${quote ? `<div class="improvement-quote">${escapeHTML(quote)}<br>— ORDO</div>` : ''}
    <button class="seasonal-action-btn secondary" data-action="close-improvement" style="width:100%;margin-top:12px;">🏠 Zurück</button>
  </div>`;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-improvement"]')) {
      overlay.remove();
      releaseOverlay(overlayId);
    }
  });

  // Animate bars after render
  requestAnimationFrame(() => {
    overlay.querySelectorAll('.score-history-fill').forEach(el => {
      const w = el.style.width;
      el.style.width = '0%';
      requestAnimationFrame(() => { el.style.width = w; });
    });
  });
}

function getImprovementMessage(report) {
  if (!report.threeMonthsAgo) {
    return 'Noch nicht genug Daten für einen Langzeitvergleich. In ein paar Wochen kann ich dir zeigen wie du dich verbessert hast!';
  }

  const delta = report.current - report.threeMonthsAgo;

  if (delta >= 15) return `+${delta}% in 3 Monaten. Du hast richtig aufgeräumt!`;
  if (delta >= 5) return `Nicht schlecht. Vor drei Monaten war hier deutlich mehr Chaos.`;
  if (delta >= 0) return 'Du hältst den Stand — das ist auch eine Leistung!';
  return `Hmm, es hat sich etwas angesammelt. Sollen wir eine Runde aufräumen?`;
}

function buildRoomNode(roomId, room) {
  const roomEl = document.createElement('div');
  roomEl.className = 'brain-room';
  roomEl.dataset.roomId = roomId;

  const totalContainers = Brain.countContainers(room.containers);

  const header = document.createElement('div');
  header.className = 'brain-room-header';
  const emojiSpanR = document.createElement('span');
  emojiSpanR.className = 'brain-room-emoji';
  emojiSpanR.textContent = room.emoji;
  const nameSpanR = document.createElement('span');
  nameSpanR.className = 'brain-room-name';
  nameSpanR.textContent = room.name;
  const countSpanR = document.createElement('span');
  countSpanR.className = 'brain-room-count';
  countSpanR.textContent = totalContainers;
  header.appendChild(emojiSpanR);
  header.appendChild(nameSpanR);
  header.appendChild(countSpanR);

  const body = document.createElement('div');
  body.className = 'brain-room-body';

  // Click toggle and long-press handled by delegation on #brain-tree

  if (totalContainers === 0) {
    const empty = document.createElement('p');
    empty.className = 'brain-empty-room';
    empty.textContent = 'Noch nichts erfasst – mach ein Foto.';
    body.appendChild(empty);
  } else {
    for (const [cId, c] of Object.entries(room.containers || {})) {
      body.appendChild(buildContainerNode(roomId, cId, c, 0));
    }
  }

  // Add container button
  const addBtn = document.createElement('button');
  addBtn.className = 'brain-add-btn';
  addBtn.textContent = '+ Bereich hinzufügen';
  addBtn.dataset.action = 'add-container';
  addBtn.dataset.room = roomId;
  body.appendChild(addBtn);

  // Room-Check button
  if (totalContainers > 0) {
    const roomCheckBtn = document.createElement('button');
    roomCheckBtn.className = 'brain-add-btn';
    roomCheckBtn.textContent = '🏠 Raum-Check';
    roomCheckBtn.dataset.action = 'organizer-room-check';
    roomCheckBtn.dataset.room = roomId;
    roomCheckBtn.style.marginTop = '4px';
    body.appendChild(roomCheckBtn);
  }

  roomEl.appendChild(header);
  roomEl.appendChild(body);
  return roomEl;
}

function buildContainerNode(roomId, cId, c, depth) {
  const el = document.createElement('div');
  const allActiveItems = (c.items || []).filter(item => typeof item === 'string' || item.status !== 'archiviert');
  const archivedItems = (c.items || []).filter(item => typeof item !== 'string' && item.status === 'archiviert');

  // Apply filter
  const infraList = Brain.getInfrastructureIgnoreList(roomId, cId);
  const activeItems = currentFilter === 'all' ? allActiveItems :
    allActiveItems.filter(item => {
      const name = Brain.getItemName(item);
      const isInfra = infraList.includes(name);
      return currentFilter === 'mobile' ? !isInfra : isInfra;
    });
  const hasItems = activeItems.length > 0;
  const hasChildren = c.containers && Object.keys(c.containers).length > 0;
  el.className = `brain-container ${hasItems ? 'has-items' : 'empty'}`;
  el.setAttribute('data-container-id', cId);
  el.dataset.roomId = roomId;
  if (depth > 0) {
    el.classList.add('brain-container--nested');
    el.style.marginLeft = `${depth * 18}px`;
  }
  if (depth > 0) {
    el.classList.add('brain-container--depth-' + Math.min(depth, 3));
  }

  const typIcon = { schrank: '🗄️', regal: '📚', schublade: '🗃️', kiste: '📦', tisch: '🪑', tuer: '🚪', fach: '📚', sonstiges: '📋' };
  const icon = typIcon[c.typ] || '📋';

  const header = document.createElement('div');
  header.className = 'brain-container-header';

  const headerLeft = document.createElement('span');
  headerLeft.textContent = `${icon} ${c.name}`;
  // Show item count (reflects current filter)
  if (activeItems.length > 0) {
    const itemCount = document.createElement('span');
    itemCount.className = 'brain-container-child-count';
    itemCount.textContent = `${activeItems.length}`;
    headerLeft.appendChild(itemCount);
  } else if (hasChildren) {
    const childCount = document.createElement('span');
    childCount.className = 'brain-container-child-count';
    childCount.textContent = `${Object.keys(c.containers).length}`;
    headerLeft.appendChild(childCount);
  }

  // Container value sum
  const cVal = Brain.getContainerValue(roomId, cId);
  if (cVal.min > 0 || cVal.max > 0) {
    const valSpan = document.createElement('span');
    valSpan.className = 'brain-container-value';
    valSpan.textContent = cVal.min === cVal.max
      ? `${formatValueDE(cVal.min)}`
      : `~${formatValueDE(cVal.min)}–${formatValueDE(cVal.max)}`;
    headerLeft.appendChild(valSpan);
  }

  const headerRight = document.createElement('small');
  headerRight.textContent = c.last_updated ? Brain.formatDate(c.last_updated) : '';

  const activeQuest = Brain.getQuest();
  const isPendingQuestContainer = !!activeQuest?.active && Array.isArray(activeQuest.plan) &&
    activeQuest.plan.some(step => step.room_id === roomId && step.container_id === cId && step.status !== 'done');
  if (isPendingQuestContainer) {
    el.classList.add('brain-container--quest-pending');
    const questMark = document.createElement('span');
    questMark.className = 'brain-container-quest-mark';
    questMark.textContent = '📷 Noch nicht erfasst';
    headerRight.appendChild(questMark);
  }

  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  const body = document.createElement('div');
  body.className = 'brain-container-body';
  body.style.display = 'none';

  // Click toggle and long-press handled by delegation on #brain-tree

  // Thumbnail area
  const thumbnailWrapper = document.createElement('div');
  thumbnailWrapper.className = 'brain-thumbnail-wrapper';

  // Photo history hint
  const photoHistoryHint = document.createElement('div');
  photoHistoryHint.className = 'brain-photo-history-hint';
  photoHistoryHint.style.display = 'none';

  // Items as chips
  const chips = document.createElement('div');
  chips.className = 'brain-chips';

  activeItems.forEach(item => {
    const chip = document.createElement('span');
    const name = Brain.getItemName(item);
    const menge = typeof item === 'string' ? (c.quantities?.[item] || 1) : (item.menge || 1);
    const isVermisst = typeof item !== 'string' && item.status === 'vermisst';
    const freshness = Brain.getItemFreshness(item);
    chip.className = 'brain-chip' + (isVermisst ? ' brain-chip--vermisst' : '') + ` brain-chip--${freshness}`;
    chip.dataset.action = 'item-chat';
    chip.dataset.itemName = name;
    chip.dataset.draggable = 'item';

    // Crop thumbnail if available
    const cropRef = typeof item === 'object' ? item.crop_ref : null;
    if (cropRef) {
      chip.classList.add('brain-chip--has-crop');
      const cropImg = document.createElement('img');
      cropImg.className = 'brain-chip-crop';
      cropImg.alt = name;
      (async () => {
        try {
          const blob = await Brain.getPhoto(cropRef);
          if (blob) {
            const url = URL.createObjectURL(blob);
            cropImg.src = url;
            cropImg.dataset.blobUrl = url;
          }
        } catch(err) { console.warn('Crop konnte nicht geladen werden:', err.message); }
      })();
      chip.appendChild(cropImg);
    }

    const textSpan = document.createElement('span');
    const emojiPrefix = freshness === 'stale' ? '⏱ ' : freshness === 'ghost' ? '👻 ' : '';
    textSpan.textContent = emojiPrefix + (menge > 1 ? `${menge}x ` : '') + name + (isVermisst ? ' ⚠' : '');
    chip.appendChild(textSpan);

    // Warranty badge
    if (typeof item === 'object' && item.purchase?.warranty_expires) {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const expires = new Date(item.purchase.warranty_expires);
      expires.setHours(0, 0, 0, 0);
      const daysLeft = Math.ceil((expires - now) / (1000 * 60 * 60 * 24));
      const badge = document.createElement('span');
      badge.className = 'warranty-badge';
      if (daysLeft < 0) {
        badge.classList.add('warranty-badge--expired');
        badge.textContent = '🛡️';
        badge.title = `Garantie abgelaufen seit ${Math.abs(daysLeft)} Tagen`;
      } else if (daysLeft <= 30) {
        badge.classList.add('warranty-badge--warning');
        badge.textContent = '🛡️';
        badge.title = `Garantie läuft in ${daysLeft} Tagen ab`;
      } else {
        badge.textContent = '🛡️';
        badge.title = `Garantie bis ${item.purchase.warranty_expires}`;
      }
      chip.appendChild(badge);
    }

    // Value badge
    const displayValue = Brain.getItemDisplayValue(item);
    if (displayValue) {
      const vBadge = document.createElement('span');
      vBadge.className = `value-badge value-badge--${displayValue.type}`;
      vBadge.textContent = displayValue.type === 'documented'
        ? `${Math.round(displayValue.value)}€ ✓`
        : `~${Math.round(displayValue.value)}€`;
      chip.appendChild(vBadge);
    }

    // Quantity stepper for items with menge > 1
    if (menge > 1 && typeof item === 'object') {
      chip.classList.add('brain-chip--has-stepper');
      const stepper = document.createElement('span');
      stepper.className = 'brain-chip-stepper';
      stepper.dataset.roomId = roomId;
      stepper.dataset.containerId = cId;
      stepper.dataset.itemName = name;

      const minusBtn = document.createElement('button');
      minusBtn.className = 'brain-chip-stepper-btn';
      minusBtn.textContent = '\u2212';
      minusBtn.dataset.action = 'qty-minus';
      minusBtn.dataset.roomId = roomId;
      minusBtn.dataset.containerId = cId;
      minusBtn.dataset.itemName = name;

      const qtySpan = document.createElement('span');
      qtySpan.className = 'brain-chip-qty';
      qtySpan.textContent = `${menge}x`;
      qtySpan.dataset.action = 'qty-edit';
      qtySpan.dataset.roomId = roomId;
      qtySpan.dataset.containerId = cId;
      qtySpan.dataset.itemName = name;

      const plusBtn = document.createElement('button');
      plusBtn.className = 'brain-chip-stepper-btn';
      plusBtn.textContent = '+';
      plusBtn.dataset.action = 'qty-plus';
      plusBtn.dataset.roomId = roomId;
      plusBtn.dataset.containerId = cId;
      plusBtn.dataset.itemName = name;

      stepper.appendChild(minusBtn);
      stepper.appendChild(qtySpan);
      stepper.appendChild(plusBtn);
      chip.appendChild(stepper);

      // Update text to not duplicate the menge prefix
      textSpan.textContent = emojiPrefix + name + (isVermisst ? ' ⚠' : '');
    }

    if (freshness === 'unconfirmed') chip.title = 'Noch nie per Foto bestätigt';
    // Click, long-press, and drag handled by delegation on #brain-tree
    chips.appendChild(chip);
  });

  // Filter empty hint
  if (currentFilter !== 'all' && activeItems.length === 0 && allActiveItems.length > 0) {
    const hint = document.createElement('div');
    hint.className = 'brain-filter-empty-hint';
    hint.textContent = currentFilter === 'mobile' ? 'Keine mobilen Gegenstände' : 'Keine festen Gegenstände';
    chips.appendChild(hint);
  }

  // Show archived items toggle
  if (archivedItems.length > 0) {
    const archiveToggle = document.createElement('div');
    archiveToggle.className = 'brain-archive-toggle';
    archiveToggle.textContent = `📦 ${archivedItems.length} archiviert`;
    archiveToggle.dataset.count = archivedItems.length;
    archiveToggle.dataset.open = 'false';
    const archiveChips = document.createElement('div');
    archiveChips.className = 'brain-chips brain-chips--archived';
    archiveChips.style.display = 'none';
    archivedItems.forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'brain-chip brain-chip--archived';
      chip.textContent = item.name;
      chip.title = item.archived_at ? `Archiviert am ${Brain.formatDate(new Date(item.archived_at).getTime())}` : 'Archiviert';
      chip.dataset.action = 'archive-restore';
      chip.dataset.itemName = item.name;
      archiveChips.appendChild(chip);
    });
    // Click handled by delegation on #brain-tree
    chips.appendChild(archiveToggle);
    chips.appendChild(archiveChips);
  }

  // Uncertain items (from inhalt_unsicher) shown with "?" badge
  (c.uncertain_items || []).forEach(item => {
    const chip = document.createElement('span');
    chip.className = 'brain-chip brain-chip--uncertain';
    chip.textContent = `${item} ?`;
    chip.title = 'Noch nicht bestätigt';
    chip.dataset.action = 'uncertain-chat';
    chip.dataset.itemName = item;
    chip.dataset.containerName = c.name;
    // Click handled by delegation on #brain-tree
    chips.appendChild(chip);
  });

  // Child containers (recursive)
  const childrenWrapper = document.createElement('div');
  childrenWrapper.className = 'brain-children';
  if (hasChildren) {
    for (const [childId, child] of Object.entries(c.containers)) {
      childrenWrapper.appendChild(buildContainerNode(roomId, childId, child, depth + 1));
    }
  }

  // Add item button
  const addItemBtn = document.createElement('button');
  addItemBtn.className = 'brain-add-item-btn';
  addItemBtn.textContent = '+ Gegenstand';
  addItemBtn.dataset.action = 'add-item';
  addItemBtn.dataset.room = roomId;
  addItemBtn.dataset.container = cId;

  // Add child container button
  const addChildBtn = document.createElement('button');
  addChildBtn.className = 'brain-add-item-btn';
  addChildBtn.textContent = '+ Bereich darunter';
  addChildBtn.dataset.action = 'add-child-container';
  addChildBtn.dataset.room = roomId;
  addChildBtn.dataset.container = cId;

  // Camera button – opens staging overlay for this container
  const cameraItemBtn = document.createElement('button');
  cameraItemBtn.className = 'brain-camera-item-btn';
  cameraItemBtn.innerHTML = '📷 Foto';
  cameraItemBtn.title = 'Foto machen und Inhalt per KI erkennen';
  cameraItemBtn.dataset.action = 'container-camera';
  cameraItemBtn.dataset.room = roomId;
  cameraItemBtn.dataset.container = cId;

  const organizerCheckBtn = document.createElement('button');
  organizerCheckBtn.className = 'brain-camera-item-btn';
  organizerCheckBtn.innerHTML = '🧹 Aufräum-Check';
  organizerCheckBtn.title = 'Container mit KI aufräumen lassen';
  organizerCheckBtn.dataset.action = 'organizer-container-check';
  organizerCheckBtn.dataset.room = roomId;
  organizerCheckBtn.dataset.container = cId;

  const btnRow = document.createElement('div');
  btnRow.className = 'brain-item-btn-row';
  btnRow.appendChild(addItemBtn);
  btnRow.appendChild(addChildBtn);
  btnRow.appendChild(cameraItemBtn);
  btnRow.appendChild(organizerCheckBtn);

  body.appendChild(thumbnailWrapper);
  body.appendChild(photoHistoryHint);
  body.appendChild(chips);
  body.appendChild(childrenWrapper);
  body.appendChild(btnRow);
  el.appendChild(header);
  el.appendChild(body);
  return el;
}

async function loadThumbnail(roomId, cId, c, wrapper) {
  // Only render once
  if (wrapper.dataset.loaded) return;
  wrapper.dataset.loaded = '1';

  const photoKey = Brain.getLatestPhotoKey(roomId, cId);
  let blob = null;
  try {
    blob = await Brain.getPhoto(photoKey);
    // Fallback to legacy key
    if (!blob) blob = await Brain.getPhoto(`${roomId}_${cId}`);
  } catch (err) { debugLog(`Thumbnail laden fehlgeschlagen (IndexedDB): ${err.message}`); }

  if (blob) {
    const objectUrl = URL.createObjectURL(blob);
    const div = document.createElement('div');
    div.className = 'brain-thumbnail';
    const img = document.createElement('img');
    img.src = objectUrl;
    img.alt = c.name;
    img.addEventListener('click', () => showLightbox(objectUrl));
    div.appendChild(img);
    wrapper.appendChild(div);

    // Show photo history hint
    const history = Brain.getPhotoHistory(roomId, cId);
    if (history.length > 1) {
      const hintEl = wrapper.parentElement.querySelector('.brain-photo-history-hint');
      if (hintEl) {
        const lastDate = Brain.formatDate(new Date(history[history.length - 1]).getTime());
        hintEl.textContent = `📷 ${history.length} Fotos  ·  zuletzt ${lastDate}`;
        hintEl.style.display = 'block';
        hintEl.style.cursor = 'pointer';
        hintEl.addEventListener('click', () => showPhotoTimeline(roomId, cId));
      }
    }
  } else {
    // Placeholder
    const div = document.createElement('div');
    div.className = 'brain-thumbnail-empty';
    const emptyIcon = document.createElement('span');
    emptyIcon.textContent = '📷';
    const emptyText = document.createElement('p');
    emptyText.textContent = 'Noch kein Foto. Tippe hier um zu scannen.';
    div.appendChild(emptyIcon);
    div.appendChild(emptyText);
    div.addEventListener('click', () => openCameraForContainer(roomId, cId));
    wrapper.appendChild(div);
  }
}

// ── DRAG-AND-DROP SYSTEM ─────────────────────────────────

function startItemDrag(chipEl, roomId, containerId, itemName, x, y) {
  if (typeof navigator.vibrate === 'function') navigator.vibrate(50);

  const rect = chipEl.getBoundingClientRect();
  const ghost = chipEl.cloneNode(true);
  ghost.className = 'drag-ghost drag-ghost--item';
  ghost.style.width = rect.width + 'px';
  ghost.style.left = '0px';
  ghost.style.top = '0px';
  ghost.style.transform = `translate(${rect.left}px, ${rect.top}px) scale(1.05)`;
  document.body.appendChild(ghost);

  chipEl.classList.add('drag-origin');

  // Mark eligible drop containers in the tree
  document.querySelectorAll('.brain-container').forEach(el => {
    if (el.dataset.containerId !== containerId) {
      el.classList.add('drop-eligible');
    }
  });

  // Build drop-zone bar with other containers in this room
  const dropBar = buildDropBar(roomId, containerId);
  document.body.appendChild(dropBar);
  requestAnimationFrame(() => dropBar.classList.add('drop-bar--visible'));

  dragState = {
    type: 'item',
    itemName,
    roomId,
    fromContainerId: containerId,
    ghostEl: ghost,
    originalEl: chipEl,
    startX: rect.left,
    startY: rect.top,
    offsetX: x - rect.left,
    offsetY: y - rect.top,
    dropBarEl: dropBar,
    rafId: null,
    active: true,
    currentDropTarget: null,
    autoScrollId: null
  };
}

function buildDropBar(roomId, excludeContainerId) {
  const bar = document.createElement('div');
  bar.className = 'drop-bar';

  const label = document.createElement('div');
  label.className = 'drop-bar-label';
  label.textContent = 'Hierhin verschieben:';
  bar.appendChild(label);

  const scroll = document.createElement('div');
  scroll.className = 'drop-bar-scroll';

  const room = Brain.getRoom(roomId);
  const containers = Object.entries(room?.containers || {});
  for (const [cId, c] of containers) {
    if (cId === excludeContainerId) continue;
    const zone = document.createElement('div');
    zone.className = 'drop-zone';
    zone.dataset.dropRoom = roomId;
    zone.dataset.dropContainer = cId;

    const emoji = document.createElement('span');
    emoji.className = 'drop-zone-emoji';
    emoji.textContent = getContainerTypeEmoji(c.typ);

    const name = document.createElement('span');
    name.className = 'drop-zone-name';
    name.textContent = c.name;

    const count = document.createElement('span');
    count.className = 'drop-zone-count';
    const itemCount = (c.items || []).filter(i => typeof i === 'string' || i.status !== 'archiviert').length;
    count.textContent = `${itemCount} Dinge`;

    zone.appendChild(emoji);
    zone.appendChild(name);
    zone.appendChild(count);
    scroll.appendChild(zone);

    // Also add child containers as drop targets
    if (c.containers) {
      for (const [childId, child] of Object.entries(c.containers)) {
        if (childId === excludeContainerId) continue;
        const childZone = document.createElement('div');
        childZone.className = 'drop-zone drop-zone--nested';
        childZone.dataset.dropRoom = roomId;
        childZone.dataset.dropContainer = childId;

        const childEmoji = document.createElement('span');
        childEmoji.className = 'drop-zone-emoji';
        childEmoji.textContent = getContainerTypeEmoji(child.typ);

        const childName = document.createElement('span');
        childName.className = 'drop-zone-name';
        childName.textContent = `${c.name} › ${child.name}`;

        childZone.appendChild(childEmoji);
        childZone.appendChild(childName);
        scroll.appendChild(childZone);
      }
    }
  }

  bar.appendChild(scroll);
  return bar;
}

function handleDragMove(x, y) {
  if (!dragState?.active) return;

  // Auto-scroll when near viewport edges
  handleAutoScroll(y);

  if (dragState.rafId) cancelAnimationFrame(dragState.rafId);
  dragState.rafId = requestAnimationFrame(() => {
    if (!dragState?.active) return;
    const tx = x - dragState.offsetX;
    const ty = y - dragState.offsetY;
    dragState.ghostEl.style.transform = `translate(${tx}px, ${ty}px) scale(1.05)`;

    // Check drop zones (drop-bar zones + in-tree eligible containers)
    const elUnder = document.elementFromPoint(x, y);
    const dropZone = elUnder?.closest?.('.drop-zone')
      || elUnder?.closest?.('.map-container-tile[data-drop-container]')
      || elUnder?.closest?.('.brain-container.drop-eligible');

    // Clear previous highlight (cached, no querySelectorAll)
    if (dragState.currentDropTarget && dragState.currentDropTarget !== dropZone) {
      dragState.currentDropTarget.classList.remove('drop-zone--hover', 'map-container-tile--drop-hover', 'drop-hover');
    }

    if (dropZone) {
      if (dropZone.classList.contains('drop-eligible')) {
        dropZone.classList.add('drop-hover');
      } else {
        dropZone.classList.add(dropZone.classList.contains('drop-zone') ? 'drop-zone--hover' : 'map-container-tile--drop-hover');
      }
      dragState.currentDropTarget = dropZone;
    } else {
      dragState.currentDropTarget = null;
    }
  });
}

function handleAutoScroll(clientY) {
  const threshold = 60;
  const scrollSpeed = 8;
  const scrollContainer = document.getElementById('brain-tree');
  if (!scrollContainer) return;

  if (clientY < threshold) {
    scrollContainer.scrollTop -= scrollSpeed;
  } else if (clientY > window.innerHeight - threshold) {
    scrollContainer.scrollTop += scrollSpeed;
  }
}

async function handleDragEnd() {
  if (!dragState?.active) return;

  const target = dragState.currentDropTarget;
  if (target) {
    // Support both drop-bar zones and in-tree container drops
    const targetContainerId = target.dataset.dropContainer || target.dataset.containerId;
    const targetRoomId = target.dataset.dropRoom || target.dataset.roomId || dragState.roomId;

    if (targetContainerId && targetContainerId !== dragState.fromContainerId) {
      const targetContainer = Brain.getContainer(targetRoomId, targetContainerId);
      const targetName = targetContainer?.name || targetContainerId;
      const itemName = dragState.itemName;
      const fromRoom = dragState.roomId;
      const fromContainer = dragState.fromContainerId;

      // Show confirm modal
      cleanupDrag();
      const ok = await showConfirmModal({
        title: 'Verschieben',
        description: `"${itemName}" → ${targetName}?`,
        confirmLabel: 'Verschieben'
      });

      if (ok) {
        const success = targetRoomId !== fromRoom
          ? Brain.moveItemAcrossRooms(fromRoom, fromContainer, targetRoomId, targetContainerId, itemName)
          : Brain.moveItem(fromRoom, fromContainer, targetContainerId, itemName);
        if (success) {
          if (typeof navigator.vibrate === 'function') navigator.vibrate([30, 50, 30]);
          lastSpatialAction = {
            type: 'move_item',
            item: itemName,
            fromRoom: fromRoom,
            fromContainer: fromContainer,
            toRoom: targetRoomId,
            toContainer: targetContainerId
          };
          renderBrainView();
          showUndoToast(`${itemName} → ${targetName} verschoben`);
        }
      } else {
        renderBrainView();
      }
      return;
    }
  }

  // No valid drop – animate back
  cancelDrag();
}

function cancelDrag() {
  if (!dragState) return;

  const ghost = dragState.ghostEl;
  if (ghost) {
    ghost.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
    ghost.style.transform = `translate(${dragState.startX}px, ${dragState.startY}px) scale(1)`;
    ghost.style.opacity = '0';
    setTimeout(() => ghost.remove(), 220);
  }

  if (dragState.originalEl) dragState.originalEl.classList.remove('drag-origin');
  if (dragState.dropBarEl) {
    dragState.dropBarEl.classList.remove('drop-bar--visible');
    setTimeout(() => dragState.dropBarEl.remove(), 200);
  }

  // Clear in-tree drop highlights
  document.querySelectorAll('.drop-eligible').forEach(el => el.classList.remove('drop-eligible', 'drop-hover'));

  if (dragState.currentDropTarget) {
    dragState.currentDropTarget.classList.remove('drop-zone--hover', 'map-container-tile--drop-hover');
  }

  if (dragState.rafId) cancelAnimationFrame(dragState.rafId);
  dragState = null;
}

function cleanupDrag() {
  if (!dragState) return;
  if (dragState.ghostEl) dragState.ghostEl.remove();
  if (dragState.originalEl) dragState.originalEl.classList.remove('drag-origin');
  if (dragState.dropBarEl) {
    dragState.dropBarEl.classList.remove('drop-bar--visible');
    setTimeout(() => dragState.dropBarEl.remove(), 200);
  }
  // Clear in-tree drop highlights
  document.querySelectorAll('.drop-eligible').forEach(el => el.classList.remove('drop-eligible', 'drop-hover'));
  if (dragState.currentDropTarget) {
    dragState.currentDropTarget.classList.remove('drop-zone--hover', 'map-container-tile--drop-hover', 'drop-hover');
  }
  if (dragState.rafId) cancelAnimationFrame(dragState.rafId);
  dragState = null;
}

// ── CONTAINER REORDER (Map View) ─────────────────────────

function setupContainerTileDrag(tileEl, roomId, containerId, gridEl) {
  let longPressTimer = null;
  let startX = 0, startY = 0;
  let moved = false;

  tileEl.addEventListener('touchstart', e => {
    if (dragState) return;
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    moved = false;

    longPressTimer = setTimeout(() => {
      if (!moved) {
        e.preventDefault();
        startContainerDrag(tileEl, roomId, containerId, gridEl, startX, startY);
      }
    }, 500);
  }, { passive: false });

  tileEl.addEventListener('touchmove', e => {
    if (dragState?.active && dragState.type === 'container_reorder') {
      e.preventDefault();
      handleContainerDragMove(e.touches[0].clientX, e.touches[0].clientY);
      return;
    }
    const touch = e.touches[0];
    if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) {
      moved = true;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }
  }, { passive: false });

  tileEl.addEventListener('touchend', e => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (dragState?.active && dragState.type === 'container_reorder') {
      e.preventDefault();
      handleContainerDragEnd();
    }
  });

  tileEl.addEventListener('touchcancel', () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (dragState?.active && dragState.type === 'container_reorder') cancelContainerDrag();
  });
}

function startContainerDrag(tileEl, roomId, containerId, gridEl, x, y) {
  if (typeof navigator.vibrate === 'function') navigator.vibrate(50);

  const rect = tileEl.getBoundingClientRect();
  const ghost = tileEl.cloneNode(true);
  ghost.className = 'drag-ghost drag-ghost--container';
  ghost.style.width = rect.width + 'px';
  ghost.style.height = rect.height + 'px';
  ghost.style.left = '0px';
  ghost.style.top = '0px';
  ghost.style.transform = `translate(${rect.left}px, ${rect.top}px) scale(1.05)`;
  document.body.appendChild(ghost);

  tileEl.classList.add('drag-origin');

  // Collect tile positions for reorder calculation
  const tiles = Array.from(gridEl.querySelectorAll('.map-container-tile'));
  const tileData = tiles.map(t => ({
    el: t,
    id: t.dataset.containerId,
    rect: t.getBoundingClientRect()
  }));

  dragState = {
    type: 'container_reorder',
    roomId,
    containerId,
    ghostEl: ghost,
    originalEl: tileEl,
    gridEl,
    tileData,
    startX: rect.left,
    startY: rect.top,
    offsetX: x - rect.left,
    offsetY: y - rect.top,
    rafId: null,
    active: true,
    currentOrder: tiles.map(t => t.dataset.containerId),
    previousOrder: tiles.map(t => t.dataset.containerId)
  };
}

function handleContainerDragMove(x, y) {
  if (!dragState?.active || dragState.type !== 'container_reorder') return;

  if (dragState.rafId) cancelAnimationFrame(dragState.rafId);
  dragState.rafId = requestAnimationFrame(() => {
    if (!dragState?.active) return;
    const tx = x - dragState.offsetX;
    const ty = y - dragState.offsetY;
    dragState.ghostEl.style.transform = `translate(${tx}px, ${ty}px) scale(1.05)`;

    // Calculate which grid position the ghost is over
    const centerX = x;
    const centerY = y;
    let closestIdx = -1;
    let closestDist = Infinity;

    dragState.tileData.forEach((td, idx) => {
      if (td.id === dragState.containerId) return;
      const cx = td.rect.left + td.rect.width / 2;
      const cy = td.rect.top + td.rect.height / 2;
      const dist = Math.hypot(centerX - cx, centerY - cy);
      if (dist < closestDist) { closestDist = dist; closestIdx = idx; }
    });

    if (closestIdx >= 0 && closestDist < 120) {
      // Reorder
      const dragIdx = dragState.currentOrder.indexOf(dragState.containerId);
      if (dragIdx >= 0 && closestIdx !== dragIdx) {
        const newOrder = [...dragState.currentOrder];
        newOrder.splice(dragIdx, 1);
        newOrder.splice(closestIdx, 0, dragState.containerId);
        dragState.currentOrder = newOrder;

        // Update visual order via CSS order
        newOrder.forEach((id, i) => {
          const tile = dragState.gridEl.querySelector(`[data-container-id="${id}"]`);
          if (tile) tile.style.order = i;
        });
      }
    }
  });
}

function handleContainerDragEnd() {
  if (!dragState?.active || dragState.type !== 'container_reorder') return;

  const orderChanged = dragState.currentOrder.join(',') !== dragState.previousOrder.join(',');
  if (orderChanged) {
    if (typeof navigator.vibrate === 'function') navigator.vibrate([30, 50, 30]);

    lastSpatialAction = {
      type: 'reorder_containers',
      roomId: dragState.roomId,
      previousOrder: [...dragState.previousOrder]
    };

    Brain.setContainerOrder(dragState.roomId, dragState.currentOrder);
    cleanupContainerDrag();
    renderMapRoomDetail(lastSpatialAction.roomId);
    showUndoToast('Reihenfolge geändert');
  } else {
    cancelContainerDrag();
  }
}

function cancelContainerDrag() {
  if (!dragState) return;
  const ghost = dragState.ghostEl;
  if (ghost) {
    ghost.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
    ghost.style.transform = `translate(${dragState.startX}px, ${dragState.startY}px) scale(1)`;
    ghost.style.opacity = '0';
    setTimeout(() => ghost.remove(), 220);
  }
  if (dragState.originalEl) dragState.originalEl.classList.remove('drag-origin');
  // Reset order styles
  if (dragState.gridEl) {
    dragState.gridEl.querySelectorAll('.map-container-tile').forEach(t => t.style.order = '');
  }
  if (dragState.rafId) cancelAnimationFrame(dragState.rafId);
  dragState = null;
}

function cleanupContainerDrag() {
  if (!dragState) return;
  if (dragState.ghostEl) dragState.ghostEl.remove();
  if (dragState.originalEl) dragState.originalEl.classList.remove('drag-origin');
  if (dragState.rafId) cancelAnimationFrame(dragState.rafId);
  dragState = null;
}

// ── UNDO SYSTEM ──────────────────────────────────────────

function showUndoToast(message) {
  if (undoToastTimer) clearTimeout(undoToastTimer);
  const existing = document.getElementById('undo-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'undo-toast';
  toast.className = 'undo-toast';

  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;

  const undoBtn = document.createElement('button');
  undoBtn.className = 'undo-toast-btn';
  undoBtn.textContent = 'Rückgängig';
  undoBtn.addEventListener('click', e => {
    e.stopPropagation();
    executeUndo();
  });

  toast.appendChild(msgSpan);
  toast.appendChild(undoBtn);
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('undo-toast--visible'));

  undoToastTimer = setTimeout(() => {
    toast.classList.remove('undo-toast--visible');
    toast.classList.add('undo-toast--out');
    setTimeout(() => toast.remove(), 300);
    lastSpatialAction = null;
    undoToastTimer = null;
  }, 5000);
}

function executeUndo() {
  if (!lastSpatialAction) return;

  if (lastSpatialAction.type === 'move_item') {
    if (lastSpatialAction.toRoom !== lastSpatialAction.fromRoom) {
      Brain.moveItemAcrossRooms(
        lastSpatialAction.toRoom,
        lastSpatialAction.toContainer,
        lastSpatialAction.fromRoom,
        lastSpatialAction.fromContainer,
        lastSpatialAction.item
      );
    } else {
      Brain.moveItem(
        lastSpatialAction.toRoom,
        lastSpatialAction.toContainer,
        lastSpatialAction.fromContainer,
        lastSpatialAction.item
      );
    }
    showBrainToast(`Rückgängig: ${lastSpatialAction.item} zurück verschoben`);
  } else if (lastSpatialAction.type === 'reorder_containers') {
    Brain.setContainerOrder(lastSpatialAction.roomId, lastSpatialAction.previousOrder);
    showBrainToast('Reihenfolge wiederhergestellt');
  }

  lastSpatialAction = null;
  if (undoToastTimer) { clearTimeout(undoToastTimer); undoToastTimer = null; }
  const toast = document.getElementById('undo-toast');
  if (toast) toast.remove();
  renderBrainView();
}

// ── MAP VIEW ─────────────────────────────────────────────

function setupMapViewToggle() {
  const toggle = document.getElementById('brain-view-toggle');
  if (!toggle) return;
  toggle.querySelectorAll('.brain-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === brainViewMode) return;
      brainViewMode = mode;
      localStorage.setItem('ordo_view_mode', mode);
      toggle.querySelectorAll('.brain-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (mode === 'map') {
        document.getElementById('brain-tree').style.display = 'none';
        document.getElementById('brain-map').style.display = '';
        renderMapView();
      } else {
        document.getElementById('brain-tree').style.display = '';
        document.getElementById('brain-map').style.display = 'none';
        renderBrainView();
      }
    });
  });

  // Restore saved mode
  if (brainViewMode === 'map') {
    toggle.querySelectorAll('.brain-toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === 'map');
    });
  }
}

function getRoomTypeClass(roomId, roomName) {
  const n = (roomId + ' ' + roomName).toLowerCase();
  if (n.includes('kueche') || n.includes('küche') || n.includes('kitchen')) return 'kueche';
  if (n.includes('bad') || n.includes('bath') || n.includes('wc') || n.includes('dusche')) return 'bad';
  if (n.includes('schlaf') || n.includes('bedroom')) return 'schlafzimmer';
  if (n.includes('wohn') || n.includes('living')) return 'wohnzimmer';
  if (n.includes('buero') || n.includes('büro') || n.includes('arbeit') || n.includes('office')) return 'arbeitszimmer';
  if (n.includes('flur') || n.includes('diele') || n.includes('hall')) return 'flur';
  if (n.includes('keller') || n.includes('basement')) return 'keller';
  if (n.includes('garage')) return 'garage';
  if (n.includes('kinder') || n.includes('kids')) return 'kinderzimmer';
  return 'default';
}

function getFreshnessClass(lastUpdated) {
  if (!lastUpdated) return 'old';
  const ageMs = Date.now() - lastUpdated;
  const oneMonth = 30 * 24 * 60 * 60 * 1000;
  const sixMonths = 6 * oneMonth;
  if (ageMs < oneMonth) return 'fresh';
  if (ageMs < sixMonths) return 'stale';
  return 'old';
}

function countRoomItems(room) {
  let count = 0;
  function countInContainers(containers) {
    for (const c of Object.values(containers || {})) {
      count += (c.items || []).filter(i => typeof i === 'string' || i.status !== 'archiviert').length;
      if (c.containers) countInContainers(c.containers);
    }
  }
  countInContainers(room.containers);
  return count;
}

function renderMapView() {
  const mapEl = document.getElementById('brain-map');
  if (!mapEl) return;
  mapEl.innerHTML = '';

  const rooms = Brain.getRooms();
  const roomIds = Object.keys(rooms);

  if (roomIds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'map-empty-state';
    empty.textContent = 'Noch keine Räume angelegt. Starte mit einem Foto!';
    mapEl.appendChild(empty);
    return;
  }

  // Calculate layout (neighbor-based if available, else grid)
  const hasNeighbors = roomIds.some(id => rooms[id].spatial?.neighbors?.length > 0);
  const layout = hasNeighbors ? calculateNeighborLayout(rooms) : calculateAutoLayout(rooms);

  const grid = document.createElement('div');
  grid.className = 'map-grid';
  grid.id = 'map-grid';

  // Long-press state for context menu
  let longPressTimer = null;

  for (const [roomId, room] of Object.entries(rooms)) {
    const color = getRoomColor(roomId);
    const freshness = getRoomFreshness(room);
    const itemCount = countRoomItems(room);

    const cell = document.createElement('div');
    cell.className = 'map-room-cell';
    cell.dataset.roomId = roomId;
    cell.style.background = color.bg;
    cell.style.borderColor = color.border;

    const emoji = document.createElement('div');
    emoji.className = 'map-room-emoji';
    emoji.textContent = room.emoji || '🏠';

    const name = document.createElement('div');
    name.className = 'map-room-name';
    name.textContent = room.name;

    const count = document.createElement('div');
    count.className = 'map-room-count';
    count.textContent = `${itemCount} Items`;

    const dot = document.createElement('span');
    dot.className = `map-freshness ${freshness.cls}`;
    dot.title = freshness.label;

    cell.appendChild(emoji);
    cell.appendChild(name);
    cell.appendChild(count);
    cell.appendChild(dot);

    // Tap to zoom
    cell.addEventListener('click', () => handleMapRoomClick(roomId, cell));

    // Long-press for context menu
    cell.addEventListener('pointerdown', (e) => {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        e.preventDefault();
        showRoomContextMenu(roomId);
      }, 600);
    });
    cell.addEventListener('pointerup', () => { if (longPressTimer) clearTimeout(longPressTimer); });
    cell.addEventListener('pointerleave', () => { if (longPressTimer) clearTimeout(longPressTimer); });

    grid.appendChild(cell);

    // Async: load newest container photo as background
    loadRoomPreviewPhoto(roomId, room, cell);
  }

  mapEl.appendChild(grid);

  // Render neighbor connection lines (async, after grid is in DOM)
  if (hasNeighbors) {
    requestAnimationFrame(() => renderConnectionLines(rooms, grid));
  }

  // Legend
  const legend = document.createElement('div');
  legend.className = 'map-legend';
  legend.innerHTML = `
    <span><span class="map-legend-dot" style="background:#2ecc71"></span> Frisch</span>
    <span><span class="map-legend-dot" style="background:#f39c12"></span> &gt;1 Monat</span>
    <span><span class="map-legend-dot" style="background:#bdc3c7"></span> &gt;6 Monate</span>
  `;
  mapEl.appendChild(legend);
}

/**
 * Renders dashed SVG lines between neighboring rooms on the map grid.
 * @param {Object} rooms - room data
 * @param {HTMLElement} grid - the map grid element
 */
function renderConnectionLines(rooms, grid) {
  if (!grid.isConnected) return;

  const gridRect = grid.getBoundingClientRect();
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('map-connection-svg');
  svg.setAttribute('width', gridRect.width);
  svg.setAttribute('height', gridRect.height);

  const drawn = new Set();

  for (const [roomId, room] of Object.entries(rooms)) {
    if (!room.spatial?.neighbors) continue;

    const fromCell = grid.querySelector(`.map-room-cell[data-room-id="${roomId}"]`);
    if (!fromCell) continue;

    for (const neighborId of room.spatial.neighbors) {
      if (!rooms[neighborId]) continue;
      // Only draw each pair once
      const pairKey = [roomId, neighborId].sort().join(':');
      if (drawn.has(pairKey)) continue;
      drawn.add(pairKey);

      const toCell = grid.querySelector(`.map-room-cell[data-room-id="${neighborId}"]`);
      if (!toCell) continue;

      const fromRect = fromCell.getBoundingClientRect();
      const toRect = toCell.getBoundingClientRect();

      const x1 = fromRect.left + fromRect.width / 2 - gridRect.left;
      const y1 = fromRect.top + fromRect.height / 2 - gridRect.top;
      const x2 = toRect.left + toRect.width / 2 - gridRect.left;
      const y2 = toRect.top + toRect.height / 2 - gridRect.top;

      const line = document.createElementNS(svgNS, 'line');
      line.classList.add('map-connection-line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      svg.appendChild(line);
    }
  }

  if (svg.childNodes.length > 0) {
    grid.style.position = 'relative';
    grid.appendChild(svg);
  }
}

// Find the newest photo among all containers in a room, load it as background
async function loadRoomPreviewPhoto(roomId, room, cell) {
  let newestKey = null;
  let newestTs = 0;

  function scanContainers(containers) {
    for (const [cId, c] of Object.entries(containers || {})) {
      if (c.has_photo || c.photo_history?.length > 0) {
        const ts = c.last_updated || 0;
        if (ts > newestTs) {
          newestTs = ts;
          newestKey = { roomId, cId };
        }
      }
      if (c.containers) scanContainers(c.containers);
    }
  }
  scanContainers(room.containers);

  if (!newestKey) return; // No photos – keep pastel style

  try {
    const photoKey = Brain.getLatestPhotoKey(newestKey.roomId, newestKey.cId);
    let blob = await Brain.getPhoto(photoKey);
    if (!blob) blob = await Brain.getPhoto(`${newestKey.roomId}_${newestKey.cId}`);
    if (!blob) return;

    // Check cell is still in DOM
    if (!cell.isConnected) { return; }

    const url = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.className = 'map-room-bg';
    img.src = url;
    img.alt = '';
    cell.insertBefore(img, cell.firstChild);
    cell.classList.add('map-room-cell--has-photo');
  } catch (err) {
    debugLog(`Raum-Vorschau laden fehlgeschlagen: ${err.message}`);
  }
}

// Animated zoom transition from room grid to room detail
function handleMapRoomClick(roomId, clickedCell) {
  const grid = document.getElementById('map-grid');
  if (!grid) return renderMapRoomDetail(roomId);

  // Get cell position for zoom animation
  const rect = clickedCell.getBoundingClientRect();
  const color = clickedCell.style.background || '#F5F0EB';

  // Create zoom transition overlay
  const transition = document.createElement('div');
  transition.className = 'map-zoom-transition';
  transition.style.top = `${rect.top}px`;
  transition.style.left = `${rect.left}px`;
  transition.style.width = `${rect.width}px`;
  transition.style.height = `${rect.height}px`;
  transition.style.background = color;
  document.body.appendChild(transition);

  // Also fade siblings
  clickedCell.classList.add('map-room-cell--zooming');
  for (const cell of grid.children) {
    if (cell !== clickedCell) cell.classList.add('map-room-cell--fading');
  }

  // Animate to fullscreen
  requestAnimationFrame(() => {
    transition.classList.add('expanding');

    transition.addEventListener('transitionend', () => {
      transition.remove();
      renderMapRoomDetail(roomId);
    }, { once: true });

    // Safety fallback if transitionend doesn't fire
    setTimeout(() => {
      if (transition.isConnected) {
        transition.remove();
        renderMapRoomDetail(roomId);
      }
    }, 500);
  });
}

function renderMapRoomDetail(roomId) {
  const mapEl = document.getElementById('brain-map');
  if (!mapEl) return;
  const room = Brain.getRoom(roomId);
  if (!room) return;

  // Register as overlay for back-button support
  if (!requestOverlay('map-room-detail', 40, () => backToMapOverview())) return;

  // History entry for browser back button
  history.pushState({ view: 'map-room', roomId }, '');

  mapEl.innerHTML = '';

  const detail = document.createElement('div');
  detail.className = 'map-room-detail';

  // Header with back button and camera
  const header = document.createElement('div');
  header.className = 'map-room-detail-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'map-back-btn';
  backBtn.textContent = '←';
  backBtn.title = 'Zurück zur Übersicht';
  backBtn.addEventListener('click', () => {
    backToMapOverview();
  });

  const title = document.createElement('span');
  title.className = 'map-room-detail-title';
  title.textContent = `${room.emoji || '🏠'} ${room.name}`;

  const roomCamBtn = document.createElement('button');
  roomCamBtn.className = 'map-back-btn';
  roomCamBtn.textContent = '📷';
  roomCamBtn.title = 'Neues Foto';
  roomCamBtn.addEventListener('click', () => {
    // Open camera targeting this room's first container or room itself
    const containers = Brain.getOrderedContainers(roomId);
    if (containers.length > 0) {
      openCameraForContainer(roomId, containers[0][0]);
    }
  });

  header.appendChild(backBtn);
  header.appendChild(title);
  header.appendChild(roomCamBtn);
  detail.appendChild(header);

  const containers = Brain.getOrderedContainers(roomId);
  if (containers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'map-empty-state';
    empty.textContent = 'Noch keine Bereiche erfasst.';
    detail.appendChild(empty);
  } else {
    const containerGrid = document.createElement('div');
    containerGrid.className = 'map-container-grid';

    for (const [cId, c] of containers) {
      const tile = document.createElement('div');
      tile.className = 'map-container-tile';
      tile.dataset.containerId = cId;
      tile.dataset.roomId = roomId;
      tile.dataset.dropRoom = roomId;
      tile.dataset.dropContainer = cId;

      // Thumbnail area
      const thumbContainer = document.createElement('div');
      thumbContainer.className = 'tile-thumb-container';

      if (c.has_photo || c.photo_history?.length > 0) {
        const thumb = document.createElement('img');
        thumb.className = 'tile-thumb';
        thumb.alt = c.name;
        // Async photo load
        (async () => {
          try {
            const photoKey = Brain.getLatestPhotoKey(roomId, cId);
            let blob = await Brain.getPhoto(photoKey);
            if (!blob) blob = await Brain.getPhoto(`${roomId}_${cId}`);
            if (blob && thumb.isConnected) {
              const url = URL.createObjectURL(blob);
              thumb.src = url;
              thumb.onload = () => URL.revokeObjectURL(url);
            }
          } catch (err) { debugLog(`Map-Thumbnail laden fehlgeschlagen: ${err.message}`); }
        })();
        thumbContainer.appendChild(thumb);
      } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'tile-thumb-placeholder';
        placeholder.textContent = getContainerTypeEmoji(c.typ);
        thumbContainer.appendChild(placeholder);
      }
      tile.appendChild(thumbContainer);

      // Info area
      const info = document.createElement('div');
      info.className = 'tile-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'tile-name';
      nameEl.textContent = c.name;

      const itemCount = (c.items || []).filter(i => typeof i === 'string' || i.status !== 'archiviert').length;
      const meta = document.createElement('div');
      meta.className = 'tile-meta';
      const parts = [`${itemCount} Items`];
      if (c.last_updated) {
        parts.push(Brain.formatDate(c.last_updated));
      } else {
        parts.push('nie fotografiert');
      }
      meta.textContent = parts.join(' · ');

      info.appendChild(nameEl);
      info.appendChild(meta);
      tile.appendChild(info);

      // Camera button
      const camBtn = document.createElement('button');
      camBtn.className = 'tile-photo-btn';
      camBtn.dataset.containerId = cId;
      camBtn.dataset.roomId = roomId;
      camBtn.textContent = '📷';
      camBtn.title = c.has_photo ? 'Neues Foto' : 'Erstes Foto machen';
      camBtn.addEventListener('click', e => {
        e.stopPropagation();
        openCameraForContainer(roomId, cId);
      });
      tile.appendChild(camBtn);

      // Tap on container → switch to list view with container open
      tile.addEventListener('click', () => {
        if (dragState) return;
        backToMapOverview();
        // Switch to list view
        brainViewMode = 'list';
        localStorage.setItem('ordo_view_mode', 'list');
        const toggle = document.getElementById('brain-view-toggle');
        if (toggle) toggle.querySelectorAll('.brain-toggle-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.mode === 'list'));
        document.getElementById('brain-tree').style.display = '';
        document.getElementById('brain-map').style.display = 'none';
        renderBrainView();
        setTimeout(() => {
          const containerEl = document.querySelector(`[data-container-id="${cId}"]`);
          if (containerEl) containerEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      });

      // Container reorder drag (map view only)
      setupContainerTileDrag(tile, roomId, cId, containerGrid);

      containerGrid.appendChild(tile);
    }
    detail.appendChild(containerGrid);
  }

  // 3D-Button (nur wenn WebGL verfügbar und Marble Key oder Scan vorhanden)
  if (isWebGLAvailable()) {
    const has3D = hasMarbleKey();
    // Check for cached splat async, show button optimistically if marble key exists
    Brain.getSplat(roomId).then(cachedSplat => {
      if (has3D || cachedSplat) {
        const btn3d = document.createElement('button');
        btn3d.className = 'room-3d-btn';
        btn3d.innerHTML = '🔮 Raum in 3D anzeigen';
        btn3d.addEventListener('click', () => show3DRoom(roomId));
        // Insert before footer if exists, otherwise append
        const footer = detail.querySelector('.map-room-footer');
        if (footer) {
          detail.insertBefore(btn3d, footer);
        } else {
          detail.appendChild(btn3d);
        }
      }
    });
  }

  // Room footer with organizer info
  try {
    const data = Brain.getData();
    const freedomIndex = calculateFreedomIndex();
    const quickWins = getQuickWins(3);
    const roomQuickWins = quickWins.filter(qw => qw.roomId === roomId);

    if (freedomIndex || roomQuickWins.length > 0) {
      const footer = document.createElement('div');
      footer.className = 'map-room-footer';
      const parts = [];
      if (freedomIndex) parts.push(`🧠 Kopf-Freiheits-Index: ${freedomIndex.percent}%`);
      if (roomQuickWins.length > 0) parts.push(`${room.name}: ${roomQuickWins.length} Quick Wins verfügbar`);
      footer.textContent = parts.join('\n');
      detail.appendChild(footer);
    }
  } catch (e) { /* organizer info is optional */ }

  mapEl.appendChild(detail);
}

function backToMapOverview() {
  releaseOverlay('map-room-detail');
  const mapEl = document.getElementById('brain-map');
  if (mapEl) {
    const detail = mapEl.querySelector('.map-room-detail');
    if (detail) {
      detail.classList.add('map-room-detail--exiting');
      setTimeout(() => renderMapView(), 200);
      return;
    }
  }
  renderMapView();
}

function showRoomContextMenu(roomId) {
  const room = Brain.getRoom(roomId);
  if (!room) return;

  const actions = [
    { label: '✏️ Raum umbenennen', action: async () => {
      const result = await showInputModal({
        title: 'Raum umbenennen',
        fields: [{ name: 'name', label: 'Name', value: room.name }]
      });
      if (result?.name?.trim()) {
        Brain.renameRoom(roomId, result.name.trim());
        renderMapView();
      }
    }},
    { label: '😀 Emoji ändern', action: async () => {
      const result = await showInputModal({
        title: 'Emoji wählen',
        fields: [{ name: 'emoji', label: 'Emoji', value: room.emoji || '🏠' }]
      });
      if (result?.emoji?.trim()) {
        Brain.renameRoom(roomId, room.name, result.emoji.trim());
        renderMapView();
      }
    }},
    { label: '📷 Raum fotografieren', action: () => {
      const containers = Brain.getOrderedContainers(roomId);
      if (containers.length > 0) {
        openCameraForContainer(roomId, containers[0][0]);
      }
    }},
    { label: '🧹 Aufräum-Check', action: () => {
      startCleanupQuest(roomId);
    }},
  ];

  // Build simple action sheet
  const overlay = document.createElement('div');
  overlay.className = 'map-context-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const sheet = document.createElement('div');
  sheet.className = 'map-context-sheet';

  const sheetTitle = document.createElement('div');
  sheetTitle.className = 'map-context-title';
  sheetTitle.textContent = `${room.emoji || '🏠'} ${room.name}`;
  sheet.appendChild(sheetTitle);

  for (const item of actions) {
    const btn = document.createElement('button');
    btn.className = 'map-context-action';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      overlay.remove();
      item.action();
    });
    sheet.appendChild(btn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'map-context-action map-context-cancel';
  cancelBtn.textContent = 'Abbrechen';
  cancelBtn.addEventListener('click', () => overlay.remove());
  sheet.appendChild(cancelBtn);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
}

// ── BREADCRUMB NAVIGATION ──────────────────────────────
function updateBreadcrumb(roomId, containerId) {
  const breadcrumb = document.getElementById('brain-breadcrumb');
  if (!breadcrumb) return;

  const room = Brain.getRoom(roomId);
  if (!room) return;

  const path = Brain.getContainerPath(roomId, containerId);
  if (path.length === 0) {
    breadcrumb.style.display = 'none';
    return;
  }

  breadcrumb.innerHTML = '';
  breadcrumb.style.display = 'flex';

  // Room
  const roomSpan = document.createElement('span');
  roomSpan.className = 'brain-breadcrumb-item';
  roomSpan.textContent = `${room.emoji} ${room.name}`;
  roomSpan.addEventListener('click', () => {
    breadcrumb.style.display = 'none';
  });
  breadcrumb.appendChild(roomSpan);

  // Container path
  path.forEach((cId, idx) => {
    const sep = document.createElement('span');
    sep.className = 'brain-breadcrumb-sep';
    sep.textContent = '>';
    breadcrumb.appendChild(sep);

    const c = Brain.getContainer(roomId, cId);
    const span = document.createElement('span');
    span.className = 'brain-breadcrumb-item';
    if (idx === path.length - 1) span.classList.add('brain-breadcrumb-item--active');
    span.textContent = c?.name || cId;
    breadcrumb.appendChild(span);
  });
}

// ── NFC CONTEXT VIEW ──────────────────────────────────

function setupNfcContextView() {
  document.getElementById('nfc-ctx-back').addEventListener('click', () => {
    clearNfcCtxInactivityTimer();
    showView('chat');
  });

  document.getElementById('nfc-ctx-chat-btn').addEventListener('click', () => {
    clearNfcCtxInactivityTimer();
    showView('chat');
  });

  document.getElementById('nfc-ctx-photo-btn').addEventListener('click', async () => {
    const file = await capturePhoto();
    if (!file || !getNfcContext()) return;

    const roomId = getNfcContext().room;
    const containerId = getNfcContext()?.tag;
    if (!roomId || !containerId) return;

    // Ensure room and container exist
    ensureRoom(roomId);
    if (!Brain.getContainer(roomId, containerId)) {
      Brain.addContainer(roomId, containerId, containerId, 'sonstiges');
    }

    const containerName = Brain.getContainer(roomId, containerId)?.name || containerId;

    // Open staging/review workflow
    setStagingTarget({
      roomId,
      containerId,
      containerName,
      mode: 'update'
    });

    showStagingOverlay(`📷 ${containerName}`);
    await addFileToStaging(file);
  });

  // Touch/click resets inactivity timer
  const nfcView = document.getElementById('view-nfc-context');
  nfcView.addEventListener('click', resetNfcCtxInactivityTimer);
  nfcView.addEventListener('touchstart', resetNfcCtxInactivityTimer);
}

function clearNfcCtxInactivityTimer() {
  if (nfcCtxInactivityTimer) {
    clearTimeout(nfcCtxInactivityTimer);
    nfcCtxInactivityTimer = null;
  }
}

function resetNfcCtxInactivityTimer() {
  clearNfcCtxInactivityTimer();
  nfcCtxInactivityTimer = setTimeout(() => {
    if (getCurrentView() === 'nfc-context') {
      showView('chat');
    }
  }, 60000); // 1 minute inactivity → back to chat
}

async function renderNfcContextView() {
  if (!getNfcContext()) return;

  const roomId = getNfcContext().room;
  const containerId = getNfcContext()?.tag;
  const room = Brain.getRoom(roomId);
  const container = containerId ? Brain.getContainer(roomId, containerId) : null;

  // Room label
  const roomLabel = document.getElementById('nfc-ctx-room-label');
  roomLabel.textContent = room ? `${room.emoji} ${room.name}` : roomId;

  // Container name
  const containerNameEl = document.getElementById('nfc-ctx-container-name');
  const typeEmoji = getContainerTypeEmoji(container?.typ);
  containerNameEl.textContent = container ? `${typeEmoji} ${container.name}` : (containerId || '');

  // Photo
  const photoArea = document.getElementById('nfc-ctx-photo-area');
  const photoImg = document.getElementById('nfc-ctx-photo');
  const photoDate = document.getElementById('nfc-ctx-photo-date');
  const emptyArea = document.getElementById('nfc-ctx-empty');
  const itemsArea = document.getElementById('nfc-ctx-items');
  const childrenArea = document.getElementById('nfc-ctx-children');

  photoArea.style.display = 'none';
  emptyArea.style.display = 'none';
  itemsArea.style.display = 'none';
  childrenArea.style.display = 'none';

  const nfcActiveItems = (container?.items || []).filter(item => typeof item === 'string' || item.status !== 'archiviert');
  const hasItems = nfcActiveItems.length > 0;
  const hasChildren = container?.containers && Object.keys(container.containers).length > 0;
  const hasContent = hasItems || hasChildren;

  // Show photo if available
  if (containerId) {
    const photoInfo = await Brain.findBestPhoto(roomId, containerId);
    if (photoInfo?.blob) {
      const url = URL.createObjectURL(photoInfo.blob);
      photoImg.src = url;
      photoArea.style.display = 'block';
      if (photoInfo.timestamp) {
        const d = new Date(photoInfo.timestamp);
        photoDate.textContent = `📷 Foto (${d.toLocaleDateString('de-DE')})`;
      } else {
        photoDate.textContent = '';
      }
      // Click photo for lightbox
      photoImg.onclick = () => {
        const lb = document.getElementById('lightbox');
        document.getElementById('lightbox-img').src = url;
        lb.style.display = 'flex';
        requestAnimationFrame(() => lb.classList.add('lightbox--visible'));
      };
    }
  }

  // Items
  if (hasItems) {
    itemsArea.style.display = 'block';
    const chipsEl = document.getElementById('nfc-ctx-item-chips');
    chipsEl.innerHTML = '';
    nfcActiveItems.forEach(item => {
      const chip = document.createElement('span');
      const name = Brain.getItemName(item);
      const menge = typeof item === 'string' ? (container.quantities?.[item] || 1) : (item.menge || 1);
      chip.className = 'nfc-ctx-chip';
      chip.textContent = menge > 1 ? `${menge}x ${name}` : name;
      chipsEl.appendChild(chip);
    });
  }

  // Child containers
  if (hasChildren) {
    childrenArea.style.display = 'block';
    const listEl = document.getElementById('nfc-ctx-children-list');
    listEl.innerHTML = '';
    for (const [childId, child] of Object.entries(container.containers)) {
      const row = document.createElement('button');
      row.className = 'nfc-ctx-child-row';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${getContainerTypeEmoji(child.typ)} ${child.name}`;

      const arrow = document.createElement('span');
      arrow.className = 'nfc-ctx-child-arrow';
      arrow.textContent = '▸';

      row.appendChild(nameSpan);
      row.appendChild(arrow);

      row.addEventListener('click', () => {
        // Navigate into child container
        setNfcContext({ room: roomId, tag: childId });
        renderNfcContextView();
      });

      listEl.appendChild(row);
    }
  }

  // Empty state
  if (!hasContent && !(await Brain.findBestPhoto(roomId, containerId))) {
    emptyArea.style.display = 'block';
    emptyArea.textContent = '';
    const emptyP = document.createElement('p');
    emptyP.className = 'nfc-ctx-empty-text';
    emptyP.textContent = 'Dieser Bereich ist noch leer.';
    const hintP = document.createElement('p');
    hintP.className = 'nfc-ctx-empty-hint';
    hintP.textContent = 'Mach ein Foto vom geöffneten Bereich und ich merke mir was drin ist.';
    emptyArea.appendChild(emptyP);
    emptyArea.appendChild(hintP);
    document.getElementById('nfc-ctx-photo-btn-label').textContent = '📷 Erstes Foto machen';
  } else {
    document.getElementById('nfc-ctx-photo-btn-label').textContent = '📷 Foto aktualisieren';
  }

  // Start inactivity timer
  resetNfcCtxInactivityTimer();
}

function getContainerTypeEmoji(typ) {
  const map = { schrank: '🗄️', regal: '📚', schublade: '🗃️', kiste: '📦', tisch: '🪑' };
  return map[typ] || '📦';
}

// ── PHOTO TIMELINE ─────────────────────────────────────
function setupPhotoTimeline() {
  document.getElementById('photo-timeline-close').addEventListener('click', closePhotoTimeline);
}

async function showPhotoTimeline(roomId, containerId) {
  const overlay = document.getElementById('photo-timeline-overlay');
  const grid = document.getElementById('photo-timeline-grid');
  grid.innerHTML = '';

  const history = Brain.getPhotoHistory(roomId, containerId);
  if (history.length === 0) return;

  overlay.style.display = 'flex';

  for (const ts of history) {
    const photoKey = `${roomId}_${containerId}_${ts}`;
    try {
      const blob = await Brain.getPhoto(photoKey);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const card = document.createElement('div');
      card.className = 'photo-timeline-card';

      const img = document.createElement('img');
      img.src = url;
      img.alt = ts;
      img.addEventListener('click', () => showLightbox(url));

      const date = document.createElement('span');
      date.className = 'photo-timeline-date';
      date.textContent = Brain.formatDate(new Date(ts).getTime());

      const isLatest = ts === history[history.length - 1];
      if (isLatest) {
        const badge = document.createElement('span');
        badge.className = 'photo-timeline-badge';
        badge.textContent = 'aktuell';
        card.appendChild(badge);
      }

      card.appendChild(img);
      card.appendChild(date);
      grid.appendChild(card);
    } catch (err) { debugLog(`Timeline-Foto laden fehlgeschlagen: ${err.message}`); }
  }
}

function closePhotoTimeline() {
  document.getElementById('photo-timeline-overlay').style.display = 'none';
}

// ── MOVE CONTAINER OVERLAY ─────────────────────────────
function setupMoveContainerOverlay() {
  document.getElementById('move-container-close').addEventListener('click', closeMoveContainerOverlay);
  document.getElementById('move-container-cancel').addEventListener('click', closeMoveContainerOverlay);
}

function showMoveContainerOverlay(roomId, containerId) {
  moveContainerState = { roomId, containerId };
  const overlay = document.getElementById('move-container-overlay');
  const list = document.getElementById('move-container-list');
  list.innerHTML = '';

  const container = Brain.getContainer(roomId, containerId);
  const containerName = container?.name || containerId;

  // Option: move to room root
  const rootItem = document.createElement('button');
  rootItem.className = 'move-container-item';
  rootItem.textContent = `🏠 Raum-Ebene (${Brain.getRoom(roomId)?.name || roomId})`;
  rootItem.addEventListener('click', () => {
    Brain.moveContainer(roomId, containerId, null);
    closeMoveContainerOverlay();
    renderBrainView();
    showBrainToast(`${containerName} verschoben`);
  });
  list.appendChild(rootItem);

  // All other containers as potential parents
  const allContainers = Brain.getAllContainersFlat(roomId, containerId);
  allContainers.forEach(({ id, name, path }) => {
    const item = document.createElement('button');
    item.className = 'move-container-item';
    item.textContent = path;
    item.addEventListener('click', () => {
      Brain.moveContainer(roomId, containerId, id);
      closeMoveContainerOverlay();
      renderBrainView();
      showBrainToast(`${containerName} verschoben nach ${name}`);
    });
    list.appendChild(item);
  });

  overlay.style.display = 'flex';
}

function closeMoveContainerOverlay() {
  document.getElementById('move-container-overlay').style.display = 'none';
  moveContainerState = null;
}

// ── ADD CHILD CONTAINER ────────────────────────────────
async function showAddChildContainerDialog(roomId, parentId) {
  const result = await showInputModal({
    title: 'Unterbereich hinzufügen',
    fields: [
      { label: 'Name', placeholder: 'z.B. "Schublade oben", "Linke Tür"' },
      { label: 'Typ', type: 'select', defaultValue: 'sonstiges', options: [
        { value: 'schublade', label: 'Schublade' }, { value: 'fach', label: 'Fach' },
        { value: 'tuer', label: 'Tür' }, { value: 'kiste', label: 'Kiste' },
        { value: 'regal', label: 'Regal' }, { value: 'sonstiges', label: 'Sonstiges' }
      ]}
    ]
  });
  if (!result || !result[0]?.trim()) return;
  const id = Brain.slugify(result[0].trim());
  Brain.addChildContainer(roomId, parentId, id, result[0].trim(), result[1] || 'sonstiges');
  renderBrainView();
}

function showLightbox(src) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  img.src = src;
  lb.style.display = 'flex';
  requestAnimationFrame(() => lb.classList.add('lightbox--visible'));
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.classList.remove('lightbox--visible');
  setTimeout(() => {
    lb.style.display = 'none';
    const img = document.getElementById('lightbox-img');
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = '';
    // Clean up proof lightbox elements
    const proofActions = lb.querySelector('.lightbox-proof-actions');
    if (proofActions) proofActions.remove();
    const proofDate = lb.querySelector('.lightbox-proof-date');
    if (proofDate) proofDate.remove();
  }, 200);
}

async function showAddRoomDialog() {
  const result = await showInputModal({
    title: 'Raum hinzufügen',
    fields: [
      { label: 'Name', placeholder: 'z.B. Küche, Schlafzimmer' },
      { label: 'Emoji', placeholder: '🏠', defaultValue: '🏠' }
    ]
  });
  if (!result || !result[0]?.trim()) return;
  const id = Brain.slugify(result[0].trim());
  Brain.addRoom(id, result[0].trim(), result[1] || '🏠');
  renderBrainView();
}

async function showAddContainerDialog(roomId) {
  const result = await showInputModal({
    title: 'Bereich hinzufügen',
    fields: [
      { label: 'Name', placeholder: 'z.B. "Schrank links neben Tür"' },
      { label: 'Typ', type: 'select', defaultValue: 'sonstiges', options: [
        { value: 'schrank', label: 'Schrank' }, { value: 'regal', label: 'Regal' },
        { value: 'schublade', label: 'Schublade' }, { value: 'kiste', label: 'Kiste' },
        { value: 'tisch', label: 'Tisch' }, { value: 'sonstiges', label: 'Sonstiges' }
      ]}
    ]
  });
  if (!result || !result[0]?.trim()) return;
  const id = Brain.slugify(result[0].trim());
  Brain.addContainer(roomId, id, result[0].trim(), result[1] || 'sonstiges');
  renderBrainView();
}

async function showRoomContextMenuList(roomId, room) {
  const result = await showInputModal({
    title: `${room.emoji} ${room.name}`,
    description: 'Was möchtest du tun?',
    fields: [
      { type: 'select', defaultValue: '0', options: [
        { value: '0', label: 'Aktion wählen…' },
        { value: '1', label: 'Umbenennen' },
        { value: '2', label: 'Löschen' }
      ]}
    ]
  });
  if (!result || result[0] === '0') return;
  if (result[0] === '1') {
    const nameResult = await showInputModal({
      title: 'Raum umbenennen',
      fields: [{ label: 'Neuer Name', defaultValue: room.name }]
    });
    if (nameResult && nameResult[0]?.trim()) {
      Brain.renameRoom(roomId, nameResult[0].trim());
      renderBrainView();
    }
  } else if (result[0] === '2') {
    const ok = await showConfirmModal({
      title: 'Raum löschen',
      description: `"${room.name}" und alle Inhalte wirklich löschen?`,
      confirmLabel: 'Löschen',
      danger: true
    });
    if (ok) {
      Brain.deleteRoom(roomId);
      renderBrainView();
    }
  }
}

async function showItemContextMenu(roomId, cId, itemName) {
  const result = await showInputModal({
    title: itemName,
    description: 'Was möchtest du tun?',
    fields: [
      { type: 'select', defaultValue: '0', options: [
        { value: '0', label: 'Aktion wählen…' },
        { value: '1', label: 'Archivieren (entfernt)' },
        { value: '2', label: 'Löschen (endgültig)' }
      ]}
    ]
  });
  if (!result || result[0] === '0') return;
  if (result[0] === '1') {
    Brain.archiveItem(roomId, cId, itemName);
    showToast(`"${itemName}" archiviert`);
    renderBrainView();
  } else if (result[0] === '2') {
    const ok = await showConfirmModal({
      title: 'Gegenstand löschen',
      description: `"${itemName}" unwiderruflich löschen?`,
      confirmLabel: 'Löschen',
      danger: true
    });
    if (ok) {
      Brain.removeItem(roomId, cId, itemName);
      renderBrainView();
    }
  }
}

async function showContainerContextMenu(roomId, cId, c) {
  const result = await showInputModal({
    title: c.name,
    description: 'Was möchtest du tun?',
    fields: [
      { type: 'select', defaultValue: '0', options: [
        { value: '0', label: 'Aktion wählen…' },
        { value: '1', label: 'Umbenennen' },
        { value: '2', label: 'Löschen' },
        { value: '3', label: 'Verschieben' }
      ]}
    ]
  });
  if (!result || result[0] === '0') return;
  if (result[0] === '1') {
    const nameResult = await showInputModal({
      title: 'Bereich umbenennen',
      fields: [{ label: 'Neuer Name', defaultValue: c.name }]
    });
    if (nameResult && nameResult[0]?.trim()) {
      Brain.renameContainer(roomId, cId, nameResult[0].trim());
      renderBrainView();
    }
  } else if (result[0] === '2') {
    const ok = await showConfirmModal({
      title: 'Bereich löschen',
      description: `"${c.name}" und alle Inhalte wirklich löschen?`,
      confirmLabel: 'Löschen',
      danger: true
    });
    if (ok) {
      Brain.deleteContainer(roomId, cId);
      renderBrainView();
    }
  } else if (result[0] === '3') {
    showMoveContainerOverlay(roomId, cId);
  }
}

async function showOrganizerSessionChoices() {
  if (Brain.getQuest()?.active) {
    const proceed = await showConfirmModal({
      title: 'Quest läuft noch',
      description: 'Du hast eine Inventar-Quest die noch läuft. Möchtest du trotzdem eine Aufräum-Session starten?',
      confirmLabel: 'Ja, starten'
    });
    if (!proceed) return;
  }
  const result = await showInputModal({
    title: 'Wie viel Zeit und Energie hast du?',
    fields: [{
      type: 'select',
      options: [
        { value: '2', label: '⚡ 30 Sek – eine Entscheidung' },
        { value: '5', label: '☕ 5 Min – ein paar Quick Wins' },
        { value: '15', label: '🧹 15 Min – einen Bereich' },
        { value: '30', label: '🏠 30+ Min – richtig aufräumen' }
      ],
      defaultValue: organizerSessionMode || '5'
    }]
  });
  if (!result) return;
  organizerSessionMode = result[0];
  const tasks = getTasksForTimeSlot(parseInt(result[0], 10));

  if (tasks.mode === 'quick_decision') {
    showQuickDecisionOverlay();
    return;
  }

  // 5/15/30 Min → Aufräum-Quest starten
  const minutes = parseInt(result[0], 10);
  startCleanupQuest(minutes);
}

function showQuickDecisionOverlay() {
  const decision = getQuickDecision();
  if (!decision) {
    showToast('Heute sind keine Quick Decisions offen ✨');
    return;
  }
  if (!requestOverlay('quick-decision', 80, () => {
    document.querySelector('.container-check-overlay')?.remove();
    releaseOverlay('quick-decision');
  })) return;

  const overlay = document.createElement('div');
  overlay.className = 'container-check-overlay';
  overlay.innerHTML = `
    <div class="quick-decision">
      <h3>⚡ Schnelle Entscheidung</h3>
      <div class="quick-decision-item">${escapeHTML(decision.itemName)}</div>
      <div class="quick-decision-meta">📍 ${escapeHTML(decision.roomName)} > ${escapeHTML(decision.containerName)}</div>
      <div class="quick-decision-meta">⏱️ Seit ${decision.monthsAgo} Monaten nicht bewegt</div>
      <div class="quick-decision-meta">💰 Geschätzter Wert: ~${escapeHTML(String(decision.value || '?'))} €</div>
      <div class="quick-decision-actions">
        <button class="discard">🗑️ Entsorgen</button>
        <button class="donate">🎁 Spenden</button>
        <button class="keep">📦 Behalten</button>
      </div>
      <p class="quick-decision-meta">Entsorgen: ${escapeHTML(decision.disposal.icon)} ${escapeHTML(decision.disposal.text)}</p>
      <button class="brain-add-btn" data-close="1">Schließen</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); releaseOverlay('quick-decision'); };
  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.dataset.close) close();
  });

  const archiveWithReason = (reason) => {
    Brain.archiveItem(decision.roomId, decision.containerId, decision.itemName, reason);
    const sim = simulateScore([{ type: 'archive', itemName: decision.itemName }]);
    showToast(`${decision.itemName} ${reason}. Dein Kopf ist jetzt zu ${sim.simulatedPercent}% frei. ↑${sim.delta}%`);
    close();
    renderBrainView();
  };

  overlay.querySelector('.discard').addEventListener('click', () => archiveWithReason('entsorgt'));
  overlay.querySelector('.donate').addEventListener('click', () => archiveWithReason('gespendet'));
  overlay.querySelector('.keep').addEventListener('click', () => {
    showToast('OK, bleibt wo es ist. Nächste Entscheidung?');
    close();
  });
}

async function runOrganizerContainerCheck(roomId, containerId) {
  try {
    const photoKey = Brain.getLatestPhotoKey(roomId, containerId);
    const blob = photoKey ? await Brain.getPhoto(photoKey) : null;
    if (!blob) {
      showToast('Bitte zuerst ein neues Foto für diesen Bereich aufnehmen.', 'error');
      return;
    }
    const base64 = await blobToBase64(blob);
    const result = await containerCheck(roomId, containerId, base64);
    showContainerCheckOverlay(roomId, containerId, result);
  } catch (err) {
    showToast(`Aufräum-Check fehlgeschlagen: ${err.message}`, 'error');
  }
}

function showContainerCheckOverlay(roomId, containerId, result) {
  const container = Brain.getContainer(roomId, containerId);
  if (!container) return;
  if (!requestOverlay('container-check', 70, () => {
    document.querySelector('.container-check-overlay')?.remove();
    releaseOverlay('container-check');
  })) return;

  const overlay = document.createElement('div');
  overlay.className = 'container-check-overlay';
  const recommendations = Array.isArray(result.recommendations) ? result.recommendations : [];
  const grouped = {
    move: recommendations.filter(r => r.type === 'move'),
    discard: recommendations.filter(r => r.type === 'discard'),
    optimize: recommendations.filter(r => r.type === 'optimize')
  };
  const simulation = simulateScore(recommendations.map(r => ({ type: r.type === 'move' ? 'move' : (r.type === 'discard' ? 'archive' : 'keep') })));

  overlay.innerHTML = `
    <h3>🧹 Aufräum-Check: ${escapeHTML(container.name)}</h3>
    <p>${escapeHTML(result.summary || 'Mit kleinen Schritten wird dieser Bereich noch besser.')}</p>
    <div class="check-section-title">🔄 UMRÄUMEN</div>
    ${(grouped.move.map(renderRecommendationCard).join('') || '<div class="check-recommendation">Keine Umräum-Empfehlungen</div>')}
    <div class="check-section-title">🗑️ AUSMISTEN</div>
    ${(grouped.discard.map(renderRecommendationCard).join('') || '<div class="check-recommendation">Keine Ausmist-Empfehlungen</div>')}
    <div class="check-section-title">💡 OPTIMIEREN</div>
    ${(grouped.optimize.map(renderRecommendationCard).join('') || '<div class="check-recommendation">Keine Optimierungs-Tipps</div>')}
    <div class="score-preview">Vorher: ${simulation.currentPercent}% → Nachher: ~${simulation.simulatedPercent}%</div>
    <button class="brain-add-btn" data-action="organizer-apply-all">Alle Änderungen ausführen</button>
    <button class="brain-add-btn" data-close="1">Schließen</button>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => {
    if (e.target.dataset.close || e.target === overlay) {
      overlay.remove();
      releaseOverlay('container-check');
      return;
    }
    const act = e.target.dataset.apply;
    if (!act) return;
    const item = e.target.dataset.item;
    if (act === 'discard') Brain.archiveItem(roomId, containerId, item);
    showToast(`${item} aktualisiert`);
    e.target.disabled = true;
  });

  overlay.querySelector('[data-action="organizer-apply-all"]').addEventListener('click', () => {
    recommendations.forEach(rec => {
      if (rec.type === 'discard') Brain.archiveItem(roomId, containerId, rec.item);
    });
    showToast('Empfehlungen angewendet.');
    overlay.remove();
    renderBrainView();
  });
}

function renderRecommendationCard(rec) {
  const emoji = rec.type === 'move' ? '🔄' : (rec.type === 'discard' ? '🗑️' : '💡');
  const actionLabel = rec.type === 'discard' ? 'Entsorgen' : (rec.type === 'move' ? 'Verschieben' : 'Tipp verstanden ✓');
  return `<div class=\"check-recommendation\">
    <div>${emoji} ${escapeHTML(rec.item || 'Hinweis')}</div>
    <div class=\"reason\">${escapeHTML(rec.reason || '')}</div>
    <button data-apply=\"${escapeHTML(rec.type)}\" data-item=\"${escapeHTML(rec.item || '')}\">${actionLabel}</button>
  </div>`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1]);
    reader.onerror = () => reject(new Error('Foto konnte nicht gelesen werden'));
    reader.readAsDataURL(blob);
  });
}

// ── EVENT DELEGATION (brain-tree) ──────────────────────

function setupBrainTreeDelegation() {
  const root = document.getElementById('brain-tree');
  let lpTimer = null;
  let lpFired = false;

  // -- Click delegation: one handler for all brain-tree interactions --
  root.addEventListener('click', async (e) => {
    if (lpFired) { lpFired = false; return; }

    // Crop image → lightbox (must be before item-chat to catch stopPropagation)
    const cropImg = e.target.closest('.brain-chip-crop');
    if (cropImg && cropImg.dataset.blobUrl) {
      e.stopPropagation();
      showLightbox(cropImg.dataset.blobUrl);
      return;
    }

    // Quantity stepper buttons (must be before item-chat)
    const qtyBtn = e.target.closest('[data-action="qty-minus"], [data-action="qty-plus"], [data-action="qty-edit"]');
    if (qtyBtn) {
      e.stopPropagation();
      const { roomId, containerId, itemName, action } = qtyBtn.dataset;
      if (action === 'qty-minus') {
        const result = Brain.updateItemQuantity(roomId, containerId, itemName, -1);
        if (result === 'confirm_remove') {
          const ok = await showConfirmModal({
            title: `${itemName} entfernen?`,
            description: `"${itemName}" archivieren oder behalten?`,
            confirmLabel: 'Archivieren'
          });
          if (ok) {
            Brain.archiveItem(roomId, containerId, itemName);
            showToast(`"${itemName}" archiviert`);
          } else {
            // Keep at 1
            Brain.setItemQuantity(roomId, containerId, itemName, 1);
          }
        }
        renderBrainView();
      } else if (action === 'qty-plus') {
        Brain.updateItemQuantity(roomId, containerId, itemName, +1);
        renderBrainView();
      } else if (action === 'qty-edit') {
        const container = Brain.getContainer(roomId, containerId);
        const item = container?.items?.find(i => Brain.getItemName(i) === itemName);
        const currentQty = item?.menge || 1;
        const result = await showInputModal({
          title: `Menge: ${itemName}`,
          fields: [{ label: 'Neue Menge', type: 'number', defaultValue: String(currentQty), placeholder: 'Menge' }]
        });
        if (result && result[0]?.trim()) {
          const newQty = parseInt(result[0], 10);
          if (newQty > 0 && !isNaN(newQty)) {
            Brain.setItemQuantity(roomId, containerId, itemName, newQty);
            renderBrainView();
          }
        }
      }
      return;
    }

    const organizerStartBtn = e.target.closest('[data-action="organizer-start-session"]');
    if (organizerStartBtn) {
      await showOrganizerSessionChoices();
      return;
    }

    const quickWinBtn = e.target.closest('[data-action="organizer-quick-win"]');
    if (quickWinBtn) {
      const win = getQuickWins(3)[parseInt(quickWinBtn.dataset.winIndex || '0', 10)];
      if (win) {
        showToast(`${win.description} (${win.estimatedMinutes} Min)`, 'success');
      }
      return;
    }

    const organizerCheckBtn = e.target.closest('[data-action="organizer-container-check"]');
    if (organizerCheckBtn) {
      await runOrganizerContainerCheck(organizerCheckBtn.dataset.room, organizerCheckBtn.dataset.container);
      return;
    }

    const roomCheckBtn = e.target.closest('[data-action="organizer-room-check"]');
    if (roomCheckBtn) {
      showRoomCheck(roomCheckBtn.dataset.room);
      return;
    }

    const hhCheckBtn = e.target.closest('[data-action="organizer-household-check"]');
    if (hhCheckBtn) {
      showHouseholdCheck();
      return;
    }

    // Active item chip → open item detail panel
    const itemChip = e.target.closest('[data-action="item-chat"]');
    if (itemChip) {
      const containerEl = itemChip.closest('.brain-container');
      if (containerEl) {
        showItemDetailPanel(containerEl.dataset.roomId, containerEl.dataset.containerId, itemChip.dataset.itemName);
      }
      return;
    }

    // Archived item → restore confirmation
    const archiveChip = e.target.closest('[data-action="archive-restore"]');
    if (archiveChip) {
      const containerEl = archiveChip.closest('.brain-container');
      const ok = await showConfirmModal({
        title: 'Wiederherstellen',
        description: `"${archiveChip.dataset.itemName}" wiederherstellen?`,
        confirmLabel: 'Wiederherstellen'
      });
      if (ok) {
        Brain.restoreItem(containerEl.dataset.roomId, containerEl.dataset.containerId, archiveChip.dataset.itemName);
        renderBrainView();
      }
      return;
    }

    // Archive toggle → show/hide archived items
    const archiveToggle = e.target.closest('.brain-archive-toggle');
    if (archiveToggle) {
      const archiveChips = archiveToggle.nextElementSibling;
      const isOpen = archiveToggle.dataset.open === 'true';
      archiveToggle.dataset.open = String(!isOpen);
      archiveChips.style.display = !isOpen ? 'flex' : 'none';
      const count = archiveToggle.dataset.count;
      archiveToggle.textContent = !isOpen
        ? `📦 ${count} archiviert ▲`
        : `📦 ${count} archiviert`;
      return;
    }

    // Uncertain item → chat
    const uncertainChip = e.target.closest('[data-action="uncertain-chat"]');
    if (uncertainChip) {
      showView('chat');
      const input = document.getElementById('chat-input');
      input.value = `Ist "${uncertainChip.dataset.itemName}" wirklich in "${uncertainChip.dataset.containerName}"?`;
      setTimeout(() => sendChatMessage(), 100);
      return;
    }

    // Add item button
    const addItemBtn = e.target.closest('[data-action="add-item"]');
    if (addItemBtn) {
      const result = await showInputModal({
        title: 'Gegenstand hinzufügen',
        fields: [{ placeholder: 'Name des Gegenstands' }]
      });
      if (result && result[0]?.trim()) {
        Brain.addItem(addItemBtn.dataset.room, addItemBtn.dataset.container, result[0].trim());
        renderBrainView();
      }
      return;
    }

    // Add child container button
    const addChildBtn = e.target.closest('[data-action="add-child-container"]');
    if (addChildBtn) {
      showAddChildContainerDialog(addChildBtn.dataset.room, addChildBtn.dataset.container);
      return;
    }

    // Camera button
    const cameraBtn = e.target.closest('[data-action="container-camera"]');
    if (cameraBtn) {
      e.stopPropagation();
      openCameraForContainer(cameraBtn.dataset.room, cameraBtn.dataset.container);
      return;
    }

    // Add container button (room level)
    const addContainerBtn = e.target.closest('[data-action="add-container"]');
    if (addContainerBtn) {
      showAddContainerDialog(addContainerBtn.dataset.room);
      return;
    }

    // Empty CTA button
    if (e.target.closest('.brain-empty-cta-btn')) {
      showView('photo');
      return;
    }

    // Container header toggle
    const containerHeader = e.target.closest('.brain-container-header');
    if (containerHeader) {
      const containerEl = containerHeader.closest('.brain-container');
      const body = containerEl.querySelector(':scope > .brain-container-body');
      const isOpen = containerHeader.classList.contains('brain-container-header--open');
      body.style.display = isOpen ? 'none' : 'block';
      containerHeader.classList.toggle('brain-container-header--open', !isOpen);
      if (!isOpen) {
        const roomId = containerEl.dataset.roomId;
        const cId = containerEl.dataset.containerId;
        const thumbnailWrapper = body.querySelector('.brain-thumbnail-wrapper');
        const c = Brain.getContainer(roomId, cId);
        if (c) loadThumbnail(roomId, cId, c, thumbnailWrapper);
        updateBreadcrumb(roomId, cId);
      }
      return;
    }

    // Room header toggle
    const roomHeader = e.target.closest('.brain-room-header');
    if (roomHeader) {
      const roomEl = roomHeader.closest('.brain-room');
      const body = roomEl.querySelector('.brain-room-body');
      const isOpen = !roomHeader.classList.contains('collapsed');
      body.style.display = isOpen ? 'none' : 'block';
      roomHeader.classList.toggle('collapsed', isOpen);
      return;
    }
  });

  // -- Long-press delegation for context menus --
  root.addEventListener('pointerdown', (e) => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    lpFired = false;

    // Skip long-press on stepper buttons
    if (e.target.closest('.brain-chip-stepper')) return;

    const chip = e.target.closest('.brain-chip[data-action="item-chat"]');
    if (chip) {
      const containerEl = chip.closest('.brain-container');
      lpTimer = setTimeout(() => {
        lpFired = true;
        showItemContextMenu(containerEl.dataset.roomId, containerEl.dataset.containerId, chip.dataset.itemName);
      }, 600);
      return;
    }

    const containerHeader = e.target.closest('.brain-container-header');
    if (containerHeader) {
      const containerEl = containerHeader.closest('.brain-container');
      lpTimer = setTimeout(() => {
        lpFired = true;
        const c = Brain.getContainer(containerEl.dataset.roomId, containerEl.dataset.containerId);
        if (c) showContainerContextMenu(containerEl.dataset.roomId, containerEl.dataset.containerId, c);
      }, 600);
      return;
    }

    const roomHeader = e.target.closest('.brain-room-header');
    if (roomHeader) {
      const roomEl = roomHeader.closest('.brain-room');
      lpTimer = setTimeout(() => {
        lpFired = true;
        const room = Brain.getRoom(roomEl.dataset.roomId);
        if (room) showRoomContextMenuList(roomEl.dataset.roomId, room);
      }, 600);
    }
  });

  root.addEventListener('pointerup', () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });
  root.addEventListener('pointercancel', () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } });

  // -- Touch drag delegation for item chips --
  let dragTimer = null;
  let dragStartX = 0, dragStartY = 0;
  let dragMoved = false;

  root.addEventListener('touchstart', (e) => {
    if (dragState) return;
    // Don't initiate drag from stepper buttons
    if (e.target.closest('.brain-chip-stepper')) return;
    const chip = e.target.closest('[data-draggable="item"]');
    if (!chip) return;

    const touch = e.touches[0];
    dragStartX = touch.clientX;
    dragStartY = touch.clientY;
    dragMoved = false;

    dragTimer = setTimeout(() => {
      if (!dragMoved) {
        e.preventDefault();
        const containerEl = chip.closest('.brain-container');
        startItemDrag(chip, containerEl.dataset.roomId, containerEl.dataset.containerId, chip.dataset.itemName, dragStartX, dragStartY);
      }
    }, 500);
  }, { passive: false });

  root.addEventListener('touchmove', (e) => {
    if (dragState?.active) {
      e.preventDefault();
      handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
      return;
    }
    if (dragTimer) {
      const touch = e.touches[0];
      if (Math.abs(touch.clientX - dragStartX) > 10 || Math.abs(touch.clientY - dragStartY) > 10) {
        dragMoved = true;
        clearTimeout(dragTimer);
        dragTimer = null;
      }
    }
  }, { passive: false });

  root.addEventListener('touchend', (e) => {
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
    if (dragState?.active) {
      e.preventDefault();
      handleDragEnd();
    }
  });

  root.addEventListener('touchcancel', () => {
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
    if (dragState?.active) cancelDrag();
  });
}

// showItemDetailPanel imported from item-detail.js

function formatValueDE(value) {
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace('.', ',')} T€`;
  return `${Math.round(value)} €`;
}


// ── Exports ────────────────────────────────────────────
// ── 3D Room Viewer ─────────────────────────────────────────

/**
 * Zeigt einen Raum als 3D-Ansicht.
 * Flow: Cache prüfen → Marble API → Anzeigen
 */
async function show3DRoom(roomId) {
  // 1. Prüfe ob WebGL verfügbar
  if (!isWebGLAvailable()) {
    showToast('3D wird auf diesem Gerät nicht unterstützt', 'error');
    return;
  }

  // 2. Prüfe ob gecachter Splat existiert
  const cachedSplat = await Brain.getSplat(roomId);

  if (cachedSplat) {
    // Direkt anzeigen
    const overlay = create3DOverlay(roomId);
    if (!overlay) return;
    const blobUrl = URL.createObjectURL(new Blob([cachedSplat]));
    try {
      await loadSplat(blobUrl);
    } catch (err) {
      console.warn('Splat laden fehlgeschlagen, versuche GLTF:', err);
      try {
        await loadGLTF(new Blob([cachedSplat]));
      } catch (err2) {
        console.error('3D-Daten konnten nicht geladen werden:', err2);
        showToast('3D-Daten konnten nicht geladen werden', 'error');
      }
    }
    return;
  }

  // 3. Prüfe ob Marble Key vorhanden
  if (!hasMarbleKey()) {
    showToast('Marble API Key in den Einstellungen eintragen für 3D-Ansicht', 'info');
    return;
  }

  // 4. Kein Cache → Foto nehmen und Marble API aufrufen
  const room = Brain.getRoom(roomId);
  const roomPhoto = await getLatestRoomPhoto(roomId);

  if (!roomPhoto) {
    showToast('Kein Foto vorhanden. Mach erst ein Foto vom Raum.', 'info');
    return;
  }

  // 5. Overlay mit Loading anzeigen
  const overlay = create3DOverlay(roomId);
  if (!overlay) return;
  showLoadingIn3D(overlay, 'Erstelle 3D-Ansicht...');

  try {
    const base64 = await blobToBase64(roomPhoto);
    const marbleKey = getMarbleKey();

    // 6. Marble API aufrufen
    const result = await generateWorldFromPhoto(base64, marbleKey);

    // 7. Splat herunterladen
    const splatData = await downloadSplat(result.splatUrl);

    // 8. In IndexedDB cachen
    await Brain.saveSplat(roomId, splatData);

    // 9. Anzeigen
    const blobUrl = URL.createObjectURL(new Blob([splatData]));
    await loadSplat(blobUrl);

    hideLoadingIn3D(overlay);
    debugLog(`3D-Raum generiert: ${room?.name || roomId}`);

  } catch (err) {
    console.error('3D-Generierung fehlgeschlagen:', err);
    showToast('3D-Ansicht konnte nicht erstellt werden', 'error');
    close3DViewer();
  }
}

/**
 * Erstellt das 3D-Overlay.
 */
function create3DOverlay(roomId) {
  if (!requestOverlay('3d-viewer', 70, () => close3DViewer())) return null;

  const room = Brain.getRoom(roomId);
  const overlay = document.createElement('div');
  overlay.id = 'spatial-3d-overlay';
  overlay.classList.add('spatial-3d-overlay');

  overlay.innerHTML = `
    <div class="spatial-3d-header">
      <button class="spatial-3d-back" id="spatial-3d-back">← Zurück</button>
      <span class="spatial-3d-title">${escapeHTML(room?.emoji || '🏠')} ${escapeHTML(room?.name || 'Raum')} (3D)</span>
      <button class="spatial-3d-refresh" id="spatial-3d-refresh">🔄</button>
    </div>
    <div class="spatial-3d-canvas" id="spatial-3d-canvas"></div>
    <div class="spatial-3d-hint">
      Finger-Gesten: 1 Finger drehen · 2 Finger zoomen
    </div>
    <div class="spatial-3d-footer">
      <button class="spatial-3d-btn" id="spatial-3d-close">🏠 Zurück zur Karte</button>
    </div>
  `;

  document.body.appendChild(overlay);

  // Events
  document.getElementById('spatial-3d-back').addEventListener('click', close3DViewer);
  document.getElementById('spatial-3d-close').addEventListener('click', close3DViewer);
  document.getElementById('spatial-3d-refresh').addEventListener('click', () => {
    close3DViewer();
    Brain.deleteSplat(roomId).then(() => show3DRoom(roomId));
  });

  // Three.js initialisieren
  const canvas = document.getElementById('spatial-3d-canvas');
  init3DView(canvas);

  return overlay;
}

function close3DViewer() {
  destroy3DView();
  const overlay = document.getElementById('spatial-3d-overlay');
  if (overlay) overlay.remove();
  releaseOverlay('3d-viewer');
}

function showLoadingIn3D(overlay, text) {
  const canvas = overlay.querySelector('.spatial-3d-canvas');
  if (!canvas) return;
  const loading = document.createElement('div');
  loading.className = 'spatial-3d-loading';
  loading.innerHTML = `
    <div class="spatial-3d-loading-spinner"></div>
    <div class="spatial-3d-loading-text">${escapeHTML(text)}</div>
  `;
  canvas.appendChild(loading);
}

function hideLoadingIn3D(overlay) {
  const loading = overlay.querySelector('.spatial-3d-loading');
  if (loading) loading.remove();
}

/**
 * Holt das neueste Foto eines Raums (erstes Container-Foto).
 */
async function getLatestRoomPhoto(roomId) {
  const containers = Brain.getOrderedContainers(roomId);
  for (const [cId, c] of containers) {
    if (c.has_photo || c.photo_history?.length > 0) {
      const photoKey = Brain.getLatestPhotoKey(roomId, cId);
      const blob = await Brain.getPhoto(photoKey);
      if (blob) return blob;
      // Fallback key
      const blob2 = await Brain.getPhoto(`${roomId}_${cId}`);
      if (blob2) return blob2;
    }
  }
  return null;
}

export {
  setupBrain, renderBrainView, setupMapViewToggle,
  setupNfcContextView, renderNfcContextView,
  setupPhotoTimeline, setupMoveContainerOverlay,
  showLightbox, closeLightbox, showBrainToast,
  checkWarrantyBanner, checkExpiryBanner, showExpiryOverview,
  showSeasonalDetails, showImprovementReport,
  show3DRoom
};
