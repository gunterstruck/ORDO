// brain-view.js – Brain-Ansicht, Map-View, NFC-Context, Lightbox, Dialoge

import Brain from './brain.js';
import { showToast, showInputModal, showConfirmModal } from './modal.js';
import { showView, debugLog, ensureRoom, getNfcContext, setNfcContext, getCurrentView } from './app.js';
import { openCameraForContainer, showStagingOverlay, addFileToStaging, setStagingTarget } from './photo-flow.js';
import { capturePhoto } from './camera.js';
import { startRoomScan } from './onboarding.js';
import { sendChatMessage } from './chat.js';

// ── State ──────────────────────────────────────────────
let brainViewMode = localStorage.getItem('brain_view_mode') || 'list';
let nfcCtxInactivityTimer = null;
let moveContainerState = null;

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
  document.getElementById('brain-add-room').addEventListener('click', showAddRoomDialog);
  document.getElementById('brain-scan-rooms').addEventListener('click', startRoomScan);

  // Map view toggle
  setupMapViewToggle();

  // Lightbox close
  const lb = document.getElementById('lightbox');
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
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

  // Hide breadcrumb when rendering full view
  const breadcrumb = document.getElementById('brain-breadcrumb');
  if (breadcrumb) breadcrumb.style.display = 'none';

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
    btn.addEventListener('click', () => showView('photo'));
    emptyEl.appendChild(btn);
    container.appendChild(emptyEl);
    return;
  }

  for (const [roomId, room] of Object.entries(rooms)) {
    container.appendChild(buildRoomNode(roomId, room));
  }
}

function buildRoomNode(roomId, room) {
  const roomEl = document.createElement('div');
  roomEl.className = 'brain-room';

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

  let open = true;
  const body = document.createElement('div');
  body.className = 'brain-room-body';

  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? 'block' : 'none';
    header.classList.toggle('collapsed', !open);
  });

  // Long press to rename/delete
  setupLongPress(header, () => showRoomContextMenu(roomId, room));

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
  addBtn.addEventListener('click', () => showAddContainerDialog(roomId));
  body.appendChild(addBtn);

  roomEl.appendChild(header);
  roomEl.appendChild(body);
  return roomEl;
}

function buildContainerNode(roomId, cId, c, depth) {
  const el = document.createElement('div');
  const activeItems = (c.items || []).filter(item => typeof item === 'string' || item.status !== 'archiviert');
  const archivedItems = (c.items || []).filter(item => typeof item !== 'string' && item.status === 'archiviert');
  const hasItems = activeItems.length > 0;
  const hasChildren = c.containers && Object.keys(c.containers).length > 0;
  el.className = `brain-container ${hasItems ? 'has-items' : 'empty'}`;
  el.setAttribute('data-container-id', cId);
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
  if (hasChildren) {
    const childCount = document.createElement('span');
    childCount.className = 'brain-container-child-count';
    childCount.textContent = `${Object.keys(c.containers).length}`;
    headerLeft.appendChild(childCount);
  }

  const headerRight = document.createElement('small');
  headerRight.textContent = c.last_updated ? Brain.formatDate(c.last_updated) : '';

  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  let open = false;
  const body = document.createElement('div');
  body.className = 'brain-container-body';
  body.style.display = 'none';

  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? 'block' : 'none';
    header.classList.toggle('brain-container-header--open', open);
    if (open) {
      loadThumbnail(roomId, cId, c, thumbnailWrapper);
      updateBreadcrumb(roomId, cId);
    }
  });

  setupLongPress(header, () => showContainerContextMenu(roomId, cId, c));

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
    const emojiPrefix = freshness === 'stale' ? '⏱ ' : freshness === 'ghost' ? '👻 ' : '';
    chip.textContent = emojiPrefix + (menge > 1 ? `${menge}x ` : '') + name + (isVermisst ? ' ⚠' : '');
    if (freshness === 'unconfirmed') chip.title = 'Noch nie per Foto bestätigt';
    chip.addEventListener('click', () => {
      showView('chat');
      const input = document.getElementById('chat-input');
      input.value = `Wo ist die ${name}?`;
      setTimeout(() => sendChatMessage(), 100);
    });
    setupLongPress(chip, () => showItemContextMenu(roomId, cId, name));
    chips.appendChild(chip);
  });

  // Show archived items toggle
  if (archivedItems.length > 0) {
    const archiveToggle = document.createElement('div');
    archiveToggle.className = 'brain-archive-toggle';
    archiveToggle.textContent = `📦 ${archivedItems.length} archiviert`;
    let archiveOpen = false;
    const archiveChips = document.createElement('div');
    archiveChips.className = 'brain-chips brain-chips--archived';
    archiveChips.style.display = 'none';
    archivedItems.forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'brain-chip brain-chip--archived';
      chip.textContent = item.name;
      chip.title = item.archived_at ? `Archiviert am ${Brain.formatDate(new Date(item.archived_at).getTime())}` : 'Archiviert';
      chip.addEventListener('click', async () => {
        const ok = await showConfirmModal({
          title: 'Wiederherstellen',
          description: `"${item.name}" wiederherstellen?`,
          confirmLabel: 'Wiederherstellen'
        });
        if (ok) {
          Brain.restoreItem(roomId, cId, item.name);
          renderBrainView();
        }
      });
      archiveChips.appendChild(chip);
    });
    archiveToggle.addEventListener('click', () => {
      archiveOpen = !archiveOpen;
      archiveChips.style.display = archiveOpen ? 'flex' : 'none';
      archiveToggle.textContent = archiveOpen
        ? `📦 ${archivedItems.length} archiviert ▲`
        : `📦 ${archivedItems.length} archiviert`;
    });
    chips.appendChild(archiveToggle);
    chips.appendChild(archiveChips);
  }

  // Uncertain items (from inhalt_unsicher) shown with "?" badge
  (c.uncertain_items || []).forEach(item => {
    const chip = document.createElement('span');
    chip.className = 'brain-chip brain-chip--uncertain';
    chip.textContent = `${item} ?`;
    chip.title = 'Noch nicht bestätigt';
    chip.addEventListener('click', () => {
      showView('chat');
      const input = document.getElementById('chat-input');
      input.value = `Ist "${item}" wirklich in "${c.name}"?`;
      setTimeout(() => sendChatMessage(), 100);
    });
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
  addItemBtn.addEventListener('click', async () => {
    const result = await showInputModal({
      title: 'Gegenstand hinzufügen',
      fields: [{ placeholder: 'Name des Gegenstands' }]
    });
    if (result && result[0]?.trim()) {
      Brain.addItem(roomId, cId, result[0].trim());
      renderBrainView();
    }
  });

  // Add child container button
  const addChildBtn = document.createElement('button');
  addChildBtn.className = 'brain-add-item-btn';
  addChildBtn.textContent = '+ Bereich darunter';
  addChildBtn.addEventListener('click', () => {
    showAddChildContainerDialog(roomId, cId);
  });

  // Camera button – opens staging overlay for this container
  const cameraItemBtn = document.createElement('button');
  cameraItemBtn.className = 'brain-camera-item-btn';
  cameraItemBtn.innerHTML = '📷 Foto';
  cameraItemBtn.title = 'Foto machen und Inhalt per KI erkennen';
  cameraItemBtn.addEventListener('click', e => {
    e.stopPropagation();
    openCameraForContainer(roomId, cId);
  });

  const btnRow = document.createElement('div');
  btnRow.className = 'brain-item-btn-row';
  btnRow.appendChild(addItemBtn);
  btnRow.appendChild(addChildBtn);
  btnRow.appendChild(cameraItemBtn);

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

// ── MAP VIEW ─────────────────────────────────────────────

function setupMapViewToggle() {
  const toggle = document.getElementById('brain-view-toggle');
  if (!toggle) return;
  toggle.querySelectorAll('.brain-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === brainViewMode) return;
      brainViewMode = mode;
      localStorage.setItem('brain_view_mode', mode);
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

    cell.addEventListener('click', () => renderMapRoomDetail(roomId));
    grid.appendChild(cell);
  }

  mapEl.appendChild(grid);
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
  backBtn.addEventListener('click', () => renderMapView());

  const title = document.createElement('span');
  title.className = 'map-detail-title';
  title.textContent = `${room.emoji} ${room.name}`;

  header.appendChild(backBtn);
  header.appendChild(title);
  detail.appendChild(header);

  const containers = Object.entries(room.containers || {});
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
      tile.className = 'map-container-tile';

      // Photo thumbnail or emoji
      if (c.has_photo) {
        const thumb = document.createElement('img');
        thumb.className = 'map-container-thumb';
        thumb.alt = c.name;
        // Load async
        (async () => {
          try {
            const photoKey = Brain.getLatestPhotoKey(roomId, cId);
            let blob = await Brain.getPhoto(photoKey);
            if (!blob) blob = await Brain.getPhoto(`${roomId}_${cId}`);
            if (blob) thumb.src = URL.createObjectURL(blob);
          } catch (err) { debugLog(`Map-Thumbnail laden fehlgeschlagen: ${err.message}`); }
        })();
        tile.appendChild(thumb);
      } else {
        const emojiDiv = document.createElement('div');
        emojiDiv.className = 'map-container-emoji';
        emojiDiv.textContent = getContainerTypeEmoji(c.typ);
        tile.appendChild(emojiDiv);
      }

      const name = document.createElement('div');
      name.className = 'map-container-name';
      name.textContent = c.name;

      const itemCount = (c.items || []).filter(i => typeof i === 'string' || i.status !== 'archiviert').length;
      const meta = document.createElement('div');
      meta.className = 'map-container-meta';
      const parts = [`${itemCount} Dinge`];
      if (c.last_updated) parts.push(Brain.formatDate(c.last_updated));
      meta.textContent = parts.join(' · ');

      tile.appendChild(name);
      tile.appendChild(meta);

      tile.addEventListener('click', () => {
        // Switch to list view and navigate to container
        brainViewMode = 'list';
        localStorage.setItem('brain_view_mode', 'list');
        const toggle = document.getElementById('brain-view-toggle');
        if (toggle) toggle.querySelectorAll('.brain-toggle-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.mode === 'list'));
        document.getElementById('brain-tree').style.display = '';
        document.getElementById('brain-map').style.display = 'none';
        renderBrainView();
        // Try to expand and scroll to the container
        setTimeout(() => {
          const containerEl = document.querySelector(`[data-container-id="${cId}"]`);
          if (containerEl) containerEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      });

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

// ── Exports ────────────────────────────────────────────
export {
  setupBrain, renderBrainView, setupMapViewToggle,
  setupNfcContextView, renderNfcContextView,
  setupPhotoTimeline, setupMoveContainerOverlay,
  showLightbox, closeLightbox, showBrainToast
};
