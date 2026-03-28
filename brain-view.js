// brain-view.js – Brain-Ansicht, Map-View, NFC-Context, Lightbox, Dialoge

import Brain from './brain.js';
import { showToast, showInputModal, showConfirmModal } from './modal.js';
import { showView, debugLog, ensureRoom, getNfcContext, setNfcContext, getCurrentView, escapeHTML } from './app.js';
import { openCameraForContainer, showStagingOverlay, addFileToStaging, setStagingTarget } from './photo-flow.js';
import { capturePhoto } from './camera.js';
import { sendChatMessage } from './chat.js';
import { analyzeReceipt, estimateSingleItemValue } from './ai.js';
import { showReportDialog } from './report.js';
import { showCurrentStep, startBlueprint, startCleanupQuest } from './quest.js';
import { requestOverlay, releaseOverlay } from './overlay-manager.js';
import { showItemDetailPanel } from './item-detail.js';
import { showWarrantyOverview, checkWarrantyBanner } from './warranty-view.js';
import { calculateFreedomIndex, getQuickWins, getQuickDecision, getTasksForTimeSlot, simulateScore, containerCheck, recordWeeklyScore, getScoreTrend } from './organizer.js';

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
    if (getCurrentView() === 'brain') renderBrainView();
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

  const startBtn = document.createElement('button');
  startBtn.className = 'brain-add-btn';
  startBtn.dataset.action = 'organizer-start-session';
  startBtn.textContent = '🧹 Aufräum-Session starten';
  wrap.appendChild(startBtn);

  return wrap;
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
        const success = Brain.moveItem(fromRoom, fromContainer, targetContainerId, itemName);
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
    Brain.moveItem(
      lastSpatialAction.toRoom,
      lastSpatialAction.toContainer,
      lastSpatialAction.fromContainer,
      lastSpatialAction.item
    );
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
  if (n.includes('buero') || n.includes('büro') || n.includes('arbeit') || n.includes('office')) return 'buero';
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

  if (Object.keys(rooms).length === 0) {
    const empty = document.createElement('div');
    empty.className = 'map-empty-state';
    empty.textContent = 'Noch keine Räume angelegt. Starte mit einem Foto!';
    mapEl.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'map-grid';
  grid.id = 'map-grid';

  for (const [roomId, room] of Object.entries(rooms)) {
    const cell = document.createElement('div');
    const typeClass = getRoomTypeClass(roomId, room.name);
    const freshClass = getFreshnessClass(room.last_updated);
    cell.className = `map-room-cell map-room-cell--${typeClass} map-room-cell--${freshClass}`;
    cell.dataset.roomId = roomId;

    const emoji = document.createElement('div');
    emoji.className = 'map-room-emoji';
    emoji.textContent = room.emoji || '🏠';

    const name = document.createElement('div');
    name.className = 'map-room-name';
    name.textContent = room.name;

    const itemCount = countRoomItems(room);
    const containerCount = Brain.countContainers(room.containers);
    const count = document.createElement('div');
    count.className = 'map-room-count';
    count.textContent = `${containerCount} Bereiche · ${itemCount} Dinge`;

    cell.appendChild(emoji);
    cell.appendChild(name);
    cell.appendChild(count);

    cell.addEventListener('click', () => handleMapRoomClick(roomId, cell));
    grid.appendChild(cell);

    // Async: load newest container photo as background
    loadRoomPreviewPhoto(roomId, room, cell);
  }

  mapEl.appendChild(grid);
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

// Animated transition from room grid to room detail
function handleMapRoomClick(roomId, clickedCell) {
  const grid = document.getElementById('map-grid');
  if (!grid) return renderMapRoomDetail(roomId);

  // Mark clicked cell and fade siblings
  clickedCell.classList.add('map-room-cell--zooming');
  for (const cell of grid.children) {
    if (cell !== clickedCell) cell.classList.add('map-room-cell--fading');
  }

  setTimeout(() => renderMapRoomDetail(roomId), 220);
}

function renderMapRoomDetail(roomId) {
  const mapEl = document.getElementById('brain-map');
  if (!mapEl) return;
  const room = Brain.getRoom(roomId);
  if (!room) return;

  mapEl.innerHTML = '';

  const detail = document.createElement('div');
  detail.className = 'map-room-detail';

  // Header with back button
  const header = document.createElement('div');
  header.className = 'map-detail-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'map-back-btn';
  backBtn.textContent = '← Zurück';
  backBtn.addEventListener('click', () => {
    detail.classList.add('map-room-detail--exiting');
    setTimeout(() => renderMapView(), 200);
  });

  const title = document.createElement('span');
  title.className = 'map-detail-title';
  title.textContent = `${room.emoji} ${room.name}`;

  header.appendChild(backBtn);
  header.appendChild(title);
  detail.appendChild(header);

  const containers = Brain.getOrderedContainers(roomId);
  if (containers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'map-empty-state';
    empty.textContent = 'Noch keine Bereiche erfasst.';
    detail.appendChild(empty);
  } else {
    const grid = document.createElement('div');
    grid.className = 'map-container-grid';

    for (const [cId, c] of containers) {
      const tile = document.createElement('div');
      const freshClass = getFreshnessClass(c.last_updated);
      tile.className = `map-container-tile map-container-tile--${freshClass}`;
      tile.dataset.containerId = cId;
      tile.dataset.dropRoom = roomId;
      tile.dataset.dropContainer = cId;

      // Photo area (top half) or emoji fallback
      const photoArea = document.createElement('div');
      photoArea.className = 'map-container-photo-area';

      if (c.has_photo || c.photo_history?.length > 0) {
        const thumb = document.createElement('img');
        thumb.className = 'map-container-thumb';
        thumb.alt = c.name;
        (async () => {
          try {
            const photoKey = Brain.getLatestPhotoKey(roomId, cId);
            let blob = await Brain.getPhoto(photoKey);
            if (!blob) blob = await Brain.getPhoto(`${roomId}_${cId}`);
            if (blob) thumb.src = URL.createObjectURL(blob);
          } catch (err) { debugLog(`Map-Thumbnail laden fehlgeschlagen: ${err.message}`); }
        })();
        photoArea.appendChild(thumb);
      } else {
        const emojiDiv = document.createElement('div');
        emojiDiv.className = 'map-container-emoji';
        emojiDiv.textContent = getContainerTypeEmoji(c.typ);
        photoArea.appendChild(emojiDiv);
      }
      tile.appendChild(photoArea);

      // Info area (bottom half)
      const info = document.createElement('div');
      info.className = 'map-container-info';

      const name = document.createElement('div');
      name.className = 'map-container-name';
      name.textContent = c.name;

      const itemCount = (c.items || []).filter(i => typeof i === 'string' || i.status !== 'archiviert').length;
      const meta = document.createElement('div');
      meta.className = 'map-container-meta';
      const parts = [`${itemCount} Dinge`];
      if (c.last_updated) parts.push(Brain.formatDate(c.last_updated));
      meta.textContent = parts.join(' · ');

      info.appendChild(name);
      info.appendChild(meta);
      tile.appendChild(info);

      // Camera button (Aufgabe 5)
      const camBtn = document.createElement('button');
      camBtn.className = 'map-container-cam-btn';
      if (c.has_photo || c.photo_history?.length > 0) {
        camBtn.textContent = '📷';
        camBtn.title = 'Neues Foto machen';
      } else {
        camBtn.textContent = '📷';
        camBtn.title = 'Erstes Foto machen';
        camBtn.classList.add('map-container-cam-btn--cta');
      }
      camBtn.addEventListener('click', e => {
        e.stopPropagation();
        openCameraForContainer(roomId, cId);
      });
      tile.appendChild(camBtn);

      tile.addEventListener('click', () => {
        if (dragState) return; // Don't navigate during drag
        // Switch to list view and navigate to container
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
      setupContainerTileDrag(tile, roomId, cId, grid);

      grid.appendChild(tile);
    }
    detail.appendChild(grid);
  }

  mapEl.appendChild(detail);
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

async function showRoomContextMenu(roomId, room) {
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
        if (room) showRoomContextMenu(roomEl.dataset.roomId, room);
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
export {
  setupBrain, renderBrainView, setupMapViewToggle,
  setupNfcContextView, renderNfcContextView,
  setupPhotoTimeline, setupMoveContainerOverlay,
  showLightbox, closeLightbox, showBrainToast,
  checkWarrantyBanner
};
