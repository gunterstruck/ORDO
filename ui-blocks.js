// ui-blocks.js – UI-Block-Renderer für den Dialog-Stream
// Jeder Block-Typ hat eine Render-Funktion die ein DOM-Element zurückgibt.

import Brain from './brain.js';
import { escapeHTML } from './app.js';
import {
  calculateFreedomIndex, getQuickDecision, getArchivedByReason,
  getImprovementReport, getSeasonalRecommendations, detectLifeEvents,
} from './organizer.js';
import { getTodaySummary } from './session-log.js';

// ══════════════════════════════════════
// BLOCK REGISTRY
// ══════════════════════════════════════

const BLOCK_REGISTRY = {};

/**
 * Registriert einen Block-Typ.
 */
export function registerBlock(type, renderer) {
  BLOCK_REGISTRY[type] = renderer;
}

/**
 * Rendert einen Block.
 * @param {{ type, props, children? }} block
 * @returns {HTMLElement|null}
 */
export function renderBlock(block) {
  const renderer = BLOCK_REGISTRY[block.type];
  if (!renderer) {
    console.warn('Unbekannter Block:', block.type);
    return null;
  }
  return renderer(block.props || {}, block.children);
}

// ══════════════════════════════════════
// HELPERS
// ══════════════════════════════════════

function countItemsInRoom(room) {
  let count = 0;
  for (const container of Object.values(room.containers || {})) {
    const items = container.items || [];
    count += items.filter(i => typeof i === 'string' || i.status !== 'archiviert').length;
    // Rekursiv in Sub-Containern
    if (container.containers) {
      count += countItemsInRoom({ containers: container.containers });
    }
  }
  return count;
}

function getItemFreshnessClass(item) {
  if (!item.last_seen) return '';
  const daysSince = (Date.now() - new Date(item.last_seen).getTime()) / 86400000;
  if (daysSince < 1) return 'item-fresh';
  if (daysSince < 30) return 'item-stale';
  return 'item-ghost';
}

// ══════════════════════════════════════
// PHASE A: 10 KOMPONENTEN
// ══════════════════════════════════════

// 1. ScoreCard — Kopf-Freiheits-Index
registerBlock('ScoreCard', () => {
  const { percent } = calculateFreedomIndex();
  const el = document.createElement('div');
  el.classList.add('block-score-card');
  el.innerHTML = `
    <div class="score-header">\u{1F9E0} Kopf-Freiheits-Index</div>
    <div class="score-bar-container">
      <div class="score-bar-fill" style="width: ${percent}%"></div>
    </div>
    <div class="score-value">${percent}%</div>
  `;
  return el;
});

// 2. RoomGrid — Alle Räume als tippbare Kacheln
registerBlock('RoomGrid', () => {
  const data = Brain.getData();
  const rooms = Object.entries(data.rooms || {});
  const el = document.createElement('div');
  el.classList.add('block-room-grid');

  if (rooms.length === 0) {
    el.innerHTML = '<div class="block-empty">Noch keine R\u00e4ume. Mach ein Foto!</div>';
    return el;
  }

  for (const [roomId, room] of rooms) {
    const itemCount = countItemsInRoom(room);
    const containerCount = Object.keys(room.containers || {}).length;

    const card = document.createElement('div');
    card.classList.add('block-room-card');
    card.innerHTML = `
      <span class="room-emoji">${escapeHTML(room.emoji || '\u{1F3E0}')}</span>
      <span class="room-name">${escapeHTML(room.name)}</span>
      <span class="room-meta">${itemCount} Items \u00b7 ${containerCount} Container</span>
    `;
    card.addEventListener('click', async () => {
      const { handleAction } = await import('./ordo-agent.js');
      handleAction({ action: 'showRoom', roomId });
    });
    el.appendChild(card);
  }

  return el;
});

// 3. ContainerList — Container eines Raums
registerBlock('ContainerList', (props) => {
  const room = Brain.getRoom(props.roomId);
  if (!room) return null;

  const el = document.createElement('div');
  el.classList.add('block-container-list');

  el.innerHTML = `
    <div class="container-list-header">
      ${escapeHTML(room.emoji || '\u{1F3E0}')} ${escapeHTML(room.name)}
    </div>
  `;

  for (const [cId, container] of Object.entries(room.containers || {})) {
    const itemCount = (container.items || []).filter(i =>
      typeof i === 'string' || i.status !== 'archiviert'
    ).length;

    const tile = document.createElement('div');
    tile.classList.add('block-container-tile');
    tile.innerHTML = `
      <div class="container-tile-icon">\u{1F4E6}</div>
      <div class="container-tile-info">
        <div class="container-tile-name">${escapeHTML(container.name)}</div>
        <div class="container-tile-meta">${itemCount} Items</div>
      </div>
      <button class="container-tile-photo" data-action="photoContainer"
              data-room="${escapeHTML(props.roomId)}" data-container="${escapeHTML(cId)}">\u{1F4F7}</button>
    `;
    tile.addEventListener('click', async (e) => {
      const { handleAction } = await import('./ordo-agent.js');
      if (e.target.closest('[data-action="photoContainer"]')) {
        handleAction({ action: 'photoContainer', roomId: props.roomId, containerId: cId });
      } else {
        handleAction({ action: 'showContainer', roomId: props.roomId, containerId: cId });
      }
    });
    el.appendChild(tile);
  }

  return el;
});

// 4. ItemList — Items in einem Container
registerBlock('ItemList', (props) => {
  const room = Brain.getRoom(props.roomId);
  if (!room) return null;
  const container = (room.containers || {})[props.containerId];
  if (!container) return null;

  const el = document.createElement('div');
  el.classList.add('block-item-list');

  const activeItems = (container.items || []).filter(i =>
    typeof i === 'string' || i.status !== 'archiviert'
  );

  if (activeItems.length === 0) {
    el.innerHTML = '<div class="block-empty">Keine Items in diesem Container.</div>';
    return el;
  }

  // Suchfeld
  const searchWrap = document.createElement('div');
  searchWrap.className = 'item-list-search-wrap';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = '🔍 Suchen…';
  searchInput.className = 'item-list-search';
  searchWrap.appendChild(searchInput);
  el.appendChild(searchWrap);

  const listContainer = document.createElement('div');

  function renderItems(query) {
    listContainer.innerHTML = '';
    const q = (query || '').toLowerCase();

    for (const item of activeItems) {
      const name = typeof item === 'string' ? item : item.name;
      const status = typeof item === 'object' ? item.status : 'aktiv';
      const menge = typeof item === 'object' ? item.menge : 1;
      const freshness = typeof item === 'object' ? getItemFreshnessClass(item) : '';

      if (q && !name.toLowerCase().includes(q)) continue;

      const row = document.createElement('div');
      row.classList.add('block-item-row');
      if (freshness) row.classList.add(freshness);
      if (status === 'vermisst') row.classList.add('item-missing');

      const prefix = status === 'vermisst' ? '⚠️ ' : '';
      row.innerHTML = `
        <span class="item-name">${prefix}${menge > 1 ? menge + '\u00d7 ' : ''}${escapeHTML(name)}</span>
        <span class="item-row-chevron">›</span>
      `;
      row.addEventListener('click', async () => {
        const { handleAction } = await import('./ordo-agent.js');
        handleAction({
          action: 'showItemDetail',
          roomId: props.roomId,
          containerId: props.containerId,
          itemName: name,
        });
      });
      listContainer.appendChild(row);
    }
  }

  renderItems('');
  searchInput.addEventListener('input', () => renderItems(searchInput.value));

  el.appendChild(listContainer);
  return el;
});

// 5. ContainerPhoto — Foto eines Containers im Dialog-Stream
registerBlock('ContainerPhoto', (props) => {
  // props: { roomId, containerId, roomName?, containerName? }
  const el = document.createElement('div');
  el.className = 'block-container-photo';

  const wrap = document.createElement('div');
  wrap.className = 'block-container-photo-wrap';
  wrap.innerHTML = '<span class="block-container-photo-empty" style="display:none"></span>';
  el.appendChild(wrap);

  const label = document.createElement('div');
  label.className = 'block-container-photo-label';
  el.appendChild(label);

  // Async laden — blockiert Renderer nicht
  Brain.findBestPhoto(props.roomId, props.containerId).then(async (result) => {
    if (!result?.blob) {
      wrap.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'block-container-photo-empty';
      empty.textContent = 'Noch kein Foto für diesen Bereich.';
      wrap.appendChild(empty);
      return;
    }

    const objectUrl = URL.createObjectURL(result.blob);
    wrap.innerHTML = '';

    const img = document.createElement('img');
    img.src = objectUrl;
    img.className = 'block-container-photo-img';
    img.alt = props.containerName || props.containerId;
    img.addEventListener('click', async () => {
      const { showLightbox } = await import('./brain-view.js');
      (showLightbox || (() => {}))(objectUrl);
    });
    wrap.appendChild(img);

    if (result.source === 'parent') {
      label.textContent = '📦 übergeordneter Behälter';
    } else {
      label.textContent = `📦 ${props.containerName || props.containerId}`;
    }
    if (result.timestamp) {
      const d = new Date(result.timestamp);
      label.textContent += ` · ${d.toLocaleDateString('de-DE')}`;
    }
  }).catch(() => {
    wrap.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'block-container-photo-empty';
    empty.textContent = 'Noch kein Foto für diesen Bereich.';
    wrap.appendChild(empty);
  });

  return el;
});

// 6. PhotoButton — Großer Foto-Auslöser
registerBlock('PhotoButton', (props) => {
  const el = document.createElement('button');
  el.classList.add('block-photo-btn');
  el.textContent = '\u{1F4F7} ' + (props.label || 'Foto aufnehmen');
  el.addEventListener('click', async () => {
    const { handleAction } = await import('./ordo-agent.js');
    handleAction({ action: 'takePhoto', ...props });
  });
  return el;
});

// 6. VideoButton — Video-Auslöser
registerBlock('VideoButton', (props) => {
  const el = document.createElement('button');
  el.classList.add('block-video-btn');
  el.textContent = '\u{1F3A5} ' + (props.label || 'Video drehen');
  el.addEventListener('click', async () => {
    const { handleAction } = await import('./ordo-agent.js');
    handleAction({ action: 'takeVideo', ...props });
  });
  return el;
});

// 7. QuestStep — Ein Aufräum-Schritt
registerBlock('QuestStep', () => {
  const quest = Brain.getQuest();
  if (!quest?.active) return null;

  const step = quest.current_step || quest.plan?.[0];
  if (!step) return null;

  const el = document.createElement('div');
  el.classList.add('block-quest-step');

  const stepLabel = {
    move: '\u{1F504} Umr\u00e4umen',
    decide: '\u{1F914} Entscheiden',
    consolidate: '\u{1F4E6} Zusammenlegen',
    optimize: '\u{1F4A1} Tipp',
  }[step.action_type] || '\u{1F4CB} Schritt';

  el.innerHTML = `
    <div class="quest-step-badge">${stepLabel}</div>
    <div class="quest-step-item">${escapeHTML(step.item_name || '')}</div>
    ${step.reason ? `<div class="quest-step-reason">${escapeHTML(step.reason)}</div>` : ''}
  `;

  return el;
});

// 8. SettingsPanel — Einstellungen als Block
registerBlock('SettingsPanel', () => {
  const el = document.createElement('div');
  el.classList.add('block-settings');

  const apiKey = localStorage.getItem('ordo_api_key');
  const personality = localStorage.getItem('ordo_personality') || 'kauzig';
  const tts = localStorage.getItem('ordo_tts_enabled') === 'true';
  const previewEnabled = localStorage.getItem('ordo_use_preview_models') !== 'false';

  el.innerHTML = `
    <div class="settings-title">\u2699\uFE0F Einstellungen</div>

    <div class="settings-group">
      <div class="settings-label">Gemini API Key</div>
      <div class="settings-value">${apiKey ? '\u2705 ' + escapeHTML(apiKey.slice(0, 4)) + '...' : '\u274C Nicht gesetzt'}</div>
      <button class="settings-btn" data-action="changeApiKey">\u00c4ndern</button>
    </div>

    <div class="settings-group">
      <div class="settings-label">Pers\u00f6nlichkeit</div>
      <div class="settings-options">
        <button class="settings-option ${personality === 'sachlich' ? 'active' : ''}" data-personality="sachlich">Sachlich</button>
        <button class="settings-option ${personality === 'freundlich' ? 'active' : ''}" data-personality="freundlich">Freundlich</button>
        <button class="settings-option ${personality === 'kauzig' ? 'active' : ''}" data-personality="kauzig">Kauzig</button>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-label">ORDO spricht</div>
      <button class="settings-toggle ${tts ? 'on' : ''}" data-action="toggleTTS">
        ${tts ? '\u{1F50A} An' : '\u{1F507} Aus'}
      </button>
    </div>

    <div class="settings-group">
      <div class="settings-label">KI-Modelle</div>
      <div class="settings-description">
        Preview-Modelle sind neuer, aber manchmal \u00fcberlastet und langsam.
        Stable-Modelle sind zuverl\u00e4ssiger.
      </div>
      <button class="settings-toggle ${previewEnabled ? 'on' : ''}"
              data-action="togglePreviewModels">
        ${previewEnabled ? '\u{1F9EA} Preview-Modelle aktiv' : '\u2705 Stable-Modelle aktiv'}
      </button>
    </div>

    <div class="settings-group">
      <button class="settings-btn" data-action="exportData">\u{1F4E4} Daten exportieren</button>
      <button class="settings-btn" data-action="importData">\u{1F4E5} Daten importieren</button>
    </div>
  `;

  // Event-Delegation
  el.addEventListener('click', async (e) => {
    const { handleAction } = await import('./ordo-agent.js');

    const btn = e.target.closest('[data-action]');
    if (btn) handleAction({ action: btn.dataset.action });

    const persBtn = e.target.closest('[data-personality]');
    if (persBtn) {
      handleAction({ action: 'setPersonality', value: persBtn.dataset.personality });
    }
  });

  return el;
});

// 9. CapabilitiesCard — "Was kann ich?"
registerBlock('CapabilitiesCard', () => {
  const el = document.createElement('div');
  el.classList.add('block-capabilities');

  const capabilities = [
    { icon: '\u{1F4F7}', label: 'Inventar erfassen', desc: 'Foto oder Video \u2192 ich erkenne was drin ist', action: 'takePhoto' },
    { icon: '\u{1F9F9}', label: 'Aufr\u00e4umen helfen', desc: 'Ich zeige dir was wohin geh\u00f6rt', action: 'startCleanup' },
    { icon: '\u{1F3E0}', label: 'Wohnung anzeigen', desc: 'Dein Zuhause als Karte', action: 'showHome' },
    { icon: '\u{1F4CB}', label: 'Berichte erstellen', desc: 'Versicherung, Spendenliste, Verkauf', action: 'showReports' },
    { icon: '\u23F0', label: 'Verfallsdaten', desc: 'Was ist abgelaufen?', action: 'showExpiry' },
    { icon: '\u{1F6E1}\uFE0F', label: 'Garantien', desc: 'Welche laufen bald ab?', action: 'showWarranty' },
    { icon: '\u{1F5FA}\uFE0F', label: 'Grundriss', desc: 'Dein Zuhause als Karte', action: 'showMap' },
    { icon: '\u{1F4CA}', label: 'Fortschritt', desc: 'Du vor 3 Monaten vs. heute', action: 'showImprovement' },
    { icon: '\u{1F3A4}', label: 'Live reden', desc: 'Echtzeit-Gespr\u00e4ch mit mir', action: 'startLive' },
    { icon: '\u{1F4DD}', label: 'Was hab ich geschafft?', desc: 'Heutige Aktivit\u00e4t', action: 'showActivity' },
    { icon: '\u2753', label: 'Hilfe', desc: 'Frag mich einfach!', action: 'showHelp' },
  ];

  el.innerHTML = '<div class="capabilities-title">Das kann ich f\u00fcr dich:</div>';

  for (const cap of capabilities) {
    const row = document.createElement('div');
    row.classList.add('capability-row');
    row.innerHTML = `
      <span class="cap-icon">${cap.icon}</span>
      <div class="cap-info">
        <div class="cap-label">${escapeHTML(cap.label)}</div>
        <div class="cap-desc">${escapeHTML(cap.desc)}</div>
      </div>
    `;
    row.addEventListener('click', async () => {
      const { handleAction } = await import('./ordo-agent.js');
      handleAction({ action: cap.action });
    });
    el.appendChild(row);
  }

  return el;
});

// 10. OnboardingKeyInput — API-Key Eingabe
registerBlock('OnboardingKeyInput', () => {
  const el = document.createElement('div');
  el.classList.add('block-onboarding-key');
  el.innerHTML = `
    <div class="onboarding-key-label">Gemini API Key einf\u00fcgen:</div>
    <div class="onboarding-key-input-row">
      <input type="password" id="onboarding-key-field"
             placeholder="AIza..." autocomplete="off"
             class="onboarding-key-field">
      <button id="onboarding-key-submit" class="onboarding-key-submit">
        Testen \u27A4
      </button>
    </div>
    <div class="onboarding-key-hint">
      Kostenlos auf <a href="https://aistudio.google.com/apikey"
      target="_blank" rel="noopener">aistudio.google.com</a>
    </div>
  `;

  el.querySelector('#onboarding-key-submit').addEventListener('click', async () => {
    const key = el.querySelector('#onboarding-key-field').value.trim();
    if (!key) return;
    const { handleAction } = await import('./ordo-agent.js');
    handleAction({ action: 'testApiKey', key });
  });

  // Enter-Taste im Input-Feld
  el.querySelector('#onboarding-key-field').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      el.querySelector('#onboarding-key-submit').click();
    }
  });

  return el;
});

// ══════════════════════════════════════
// PHASE B: 21 KOMPONENTEN
// ══════════════════════════════════════

// 11. ExpiryList — Verfallsdaten-Übersicht
registerBlock('ExpiryList', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-expiry-list');

  let items = [];
  try { items = Brain.getExpiringItems?.(30) || []; } catch { /* ok */ }

  if (items.length === 0) {
    el.innerHTML = '<div class="block-empty">Keine Verfallsdaten vorhanden.</div>';
    return el;
  }

  const maxItems = props.compact ? (props.maxItems || 3) : items.length;
  const expired = items.filter(e => e.isExpired);
  const soon = items.filter(e => !e.isExpired && (e.isExpiringSoon || e.daysUntilExpiry <= 30));
  const ok = items.filter(e => !e.isExpired && !e.isExpiringSoon && e.daysUntilExpiry > 30);

  function addSection(title, list, icon) {
    if (list.length === 0) return;
    const titleEl = document.createElement('div');
    titleEl.className = 'expiry-section-title';
    titleEl.textContent = title;
    el.appendChild(titleEl);

    const itemName = (item) => item.item?.name || item.itemName || '';
    const location = (item) => [item.roomName, item.containerName].filter(Boolean).join(' \u203A ');

    for (const item of list.slice(0, maxItems)) {
      const days = Math.abs(item.daysUntilExpiry || 0);
      const row = document.createElement('div');
      row.className = 'expiry-row';
      row.innerHTML = `
        <span class="expiry-icon">${icon}</span>
        <div class="expiry-info">
          <div class="expiry-name">${escapeHTML(itemName(item))}</div>
          <div class="expiry-meta">${escapeHTML(location(item))} \u00b7 ${item.isExpired ? `${days} Tage abgelaufen` : `${days} Tage`}</div>
        </div>
      `;
      if (item.isExpired) {
        const btn = document.createElement('button');
        btn.className = 'expiry-action';
        btn.textContent = '\u{1F5D1}\uFE0F Entsorgen';
        btn.addEventListener('click', async () => {
          const { handleAction } = await import('./ordo-agent.js');
          handleAction({ action: 'archiveItem', itemName: itemName(item), roomId: item.roomId, containerId: item.containerId });
        });
        row.appendChild(btn);
      }
      el.appendChild(row);
    }
  }

  addSection('Abgelaufen', expired, '\u{1F534}');
  addSection('Bald ablaufend', soon, '\u{1F7E1}');
  if (!props.compact) addSection('OK', ok, '\u{1F7E2}');

  return el;
});

// 12. WarrantyList — Garantie-Übersicht
registerBlock('WarrantyList', () => {
  const el = document.createElement('div');
  el.classList.add('block-warranty-list');

  const data = Brain.getData();
  const warranties = [];

  for (const [roomId, room] of Object.entries(data.rooms || {})) {
    for (const [cId, container] of Object.entries(room.containers || {})) {
      for (const item of (container.items || [])) {
        const obj = typeof item === 'string' ? null : item;
        if (!obj || obj.status === 'archiviert' || !obj.warranty) continue;
        const expiryDate = new Date(obj.warranty.expires || obj.warranty.end || obj.warranty);
        if (isNaN(expiryDate.getTime())) continue;
        const daysLeft = Math.ceil((expiryDate - Date.now()) / 86400000);
        warranties.push({
          name: obj.name, roomName: room.name, containerName: container.name,
          expiryDate, daysLeft, isExpired: daysLeft < 0,
        });
      }
    }
  }

  if (warranties.length === 0) {
    el.innerHTML = '<div class="block-empty">Keine Garantien erfasst.</div>';
    return el;
  }

  warranties.sort((a, b) => a.daysLeft - b.daysLeft);

  for (const w of warranties) {
    const row = document.createElement('div');
    row.className = 'warranty-row';
    const statusClass = w.isExpired ? 'expired' : w.daysLeft <= 30 ? 'warning' : 'active';
    const statusText = w.isExpired ? 'Abgelaufen' : w.daysLeft <= 30 ? `${w.daysLeft} Tage` : 'Aktiv';
    row.innerHTML = `
      <div class="warranty-info">
        <div class="warranty-name">${escapeHTML(w.name)}</div>
        <div class="warranty-meta">${escapeHTML(w.roomName)} \u00b7 bis ${w.expiryDate.toLocaleDateString('de-DE')}</div>
      </div>
      <span class="warranty-status ${statusClass}">${statusText}</span>
    `;
    el.appendChild(row);
  }

  return el;
});

// 13. DonationList — Spendenliste
registerBlock('DonationList', () => {
  const el = document.createElement('div');
  el.classList.add('block-donation-list');

  const { donated } = getArchivedByReason();

  if (donated.length === 0) {
    el.innerHTML = '<div class="block-empty">Keine Spenden bisher.</div>';
    return el;
  }

  let totalValue = 0;
  for (const item of donated) {
    const row = document.createElement('div');
    row.className = 'donation-row';
    const val = item.value || 0;
    totalValue += val;
    row.innerHTML = `
      <span class="donation-name">${escapeHTML(item.name)}</span>
      ${val ? `<span class="donation-value">${val}\u20AC</span>` : ''}
      <span class="donation-origin">${escapeHTML(item.roomName || '')}</span>
    `;
    el.appendChild(row);
  }

  const footer = document.createElement('div');
  footer.className = 'donation-total';
  footer.textContent = `Gesamt: ${donated.length} Gegenst\u00e4nde` + (totalValue > 0 ? ` \u00b7 ca. ${totalValue}\u20AC` : '');
  el.appendChild(footer);

  return el;
});

// 14. SalesCard — Verkaufs-Entwürfe
registerBlock('SalesCard', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-sales-card');

  const items = props.items || [];
  if (items.length === 0) {
    el.innerHTML = '<div class="block-empty">Keine Verkaufs-Entwürfe.</div>';
    return el;
  }

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'sales-item';
    card.innerHTML = `
      <div class="sales-title">${escapeHTML(item.title || item.name || '')}</div>
      <div class="sales-desc">${escapeHTML(item.description || '')}</div>
      ${item.price ? `<div class="sales-price">ca. ${item.price}\u20AC</div>` : ''}
    `;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'sales-copy-btn';
    copyBtn.textContent = '\u{1F4CB} Kopieren';
    copyBtn.addEventListener('click', async () => {
      const text = `${item.title || item.name}\n${item.description}\nPreis: ${item.price || 'VB'}\u20AC`;
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '\u2705 Kopiert!';
      } catch {
        copyBtn.textContent = '\u274C Fehler';
      }
      setTimeout(() => { copyBtn.textContent = '\u{1F4CB} Kopieren'; }, 2000);
    });
    card.appendChild(copyBtn);
    el.appendChild(card);
  }

  return el;
});

// 15. ReportMenu — Berichte-Übersicht
registerBlock('ReportMenu', () => {
  const el = document.createElement('div');
  el.classList.add('block-report-menu');

  const options = [
    { icon: '\u{1F4CA}', label: 'Versicherungsbericht', action: 'generateInsuranceReport' },
    { icon: '\u{1F4CB}', label: 'Spendenliste', action: 'generateDonationPDF' },
    { icon: '\u{1F4B0}', label: 'Verkaufs-Entw\u00fcrfe', action: 'showSalesView' },
    { icon: '\u{1F4C8}', label: 'Verbesserungs-Report', action: 'showImprovement' },
  ];

  for (const opt of options) {
    const row = document.createElement('div');
    row.className = 'report-option';
    row.innerHTML = `
      <span class="report-icon">${opt.icon}</span>
      <span class="report-label">${opt.label}</span>
    `;
    row.addEventListener('click', async () => {
      const { handleAction } = await import('./ordo-agent.js');
      handleAction({ action: opt.action });
    });
    el.appendChild(row);
  }

  return el;
});

// 16. CleanupOptions — Session-Auswahl
registerBlock('CleanupOptions', () => {
  const el = document.createElement('div');
  el.classList.add('block-cleanup-options');

  const { percent } = calculateFreedomIndex();
  const scoreEl = document.createElement('div');
  scoreEl.className = 'cleanup-score';
  scoreEl.textContent = `Dein Score: ${percent}%`;
  el.appendChild(scoreEl);

  const options = [
    { icon: '\u26A1', label: '2 Minuten', desc: 'Eine Entscheidung', minutes: 2 },
    { icon: '\u2615', label: '5 Minuten', desc: 'Quick Wins', minutes: 5 },
    { icon: '\u{1F9F9}', label: '15 Minuten', desc: 'Einen Container', minutes: 15 },
    { icon: '\u{1F3E0}', label: '30 Minuten', desc: 'Richtig aufr\u00e4umen', minutes: 30 },
  ];

  for (const opt of options) {
    const row = document.createElement('div');
    row.className = 'cleanup-option';
    row.innerHTML = `
      <span class="cleanup-option-icon">${opt.icon}</span>
      <div class="cleanup-option-text">
        <div class="cleanup-option-label">${opt.label}</div>
        <div class="cleanup-option-desc">${opt.desc}</div>
      </div>
    `;
    row.addEventListener('click', async () => {
      const { handleAction } = await import('./ordo-agent.js');
      handleAction({ action: 'startCleanupQuest', minutes: opt.minutes });
    });
    el.appendChild(row);
  }

  return el;
});

// 17. QuickDecision — Eine einzelne Entscheidung
registerBlock('QuickDecision', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-quick-decision');

  const decision = props.itemName
    ? { itemName: props.itemName, roomName: props.roomName || '', containerName: props.containerName || '', monthsAgo: props.monthsAgo, value: props.value, roomId: props.roomId, containerId: props.containerId }
    : getQuickDecision();

  if (!decision) {
    el.innerHTML = '<div class="block-empty">Alles in Ordnung \u2014 keine offenen Entscheidungen!</div>';
    return el;
  }

  el.innerHTML = `
    <div class="qd-item-name">${escapeHTML(decision.itemName)}</div>
    <div class="qd-location">${escapeHTML(decision.roomName || '')} \u203A ${escapeHTML(decision.containerName || '')}</div>
    ${decision.monthsAgo ? `<div class="qd-detail">Seit ${decision.monthsAgo} Monaten nicht bewegt</div>` : ''}
    ${decision.value ? `<div class="qd-value">Gesch\u00e4tzter Wert: ca. ${decision.value}\u20AC</div>` : ''}
  `;

  const actions = document.createElement('div');
  actions.className = 'qd-actions';

  const buttons = [
    { icon: '\u{1F5D1}\uFE0F', label: 'Entsorgen', reason: 'entsorgt' },
    { icon: '\u{1F381}', label: 'Spenden', reason: 'gespendet' },
    { icon: '\u{1F4B0}', label: 'Verkaufen', reason: 'verkauft' },
    { icon: '\u{1F4E6}', label: 'Behalten', reason: 'behalten' },
  ];

  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'qd-btn';
    btn.textContent = `${b.icon} ${b.label}`;
    btn.addEventListener('click', async () => {
      const { handleAction } = await import('./ordo-agent.js');
      if (b.reason === 'behalten') {
        handleAction({ action: 'showHome' });
      } else {
        if (decision.roomId && decision.containerId) {
          Brain.archiveItem(decision.roomId, decision.containerId, decision.itemName, b.reason);
        }
        handleAction({ action: 'quickDecision' }); // nächste Entscheidung
      }
    });
    actions.appendChild(btn);
  }

  el.appendChild(actions);
  return el;
});

// 18. QuestSummary — Quest-Abschluss
registerBlock('QuestSummary', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-quest-summary');

  const stats = props.stats || {};
  const scoreDelta = (stats.scoreAfter || 0) - (stats.scoreBefore || 0);

  el.innerHTML = `
    <div class="quest-complete-emoji">\u{1F389}</div>
    <div class="quest-stats">
      ${stats.moved ? `<div>\u{1F504} ${stats.moved} umger\u00e4umt</div>` : ''}
      ${stats.discarded ? `<div>\u{1F5D1}\uFE0F ${stats.discarded} entsorgt</div>` : ''}
      ${stats.donated ? `<div>\u{1F381} ${stats.donated} gespendet</div>` : ''}
    </div>
    ${scoreDelta !== 0 ? `<div class="quest-score-delta">${stats.scoreBefore}% \u2192 ${stats.scoreAfter}% (${scoreDelta > 0 ? '+' : ''}${scoreDelta})</div>` : ''}
    ${props.quote ? `<div class="quest-quote">${escapeHTML(props.quote)}</div>` : ''}
  `;

  return el;
});

// 19. RoomCheckCard — Raum-Analyse
registerBlock('RoomCheckCard', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-room-check');

  const data = props.data;
  if (!data) { el.innerHTML = '<div class="block-empty">Keine Raum-Daten.</div>'; return el; }

  el.innerHTML = `
    <div class="room-check-header">
      <span class="room-check-name">${escapeHTML(data.roomName || '')}</span>
      <span class="room-check-score">${data.roomScore}%</span>
    </div>
  `;

  const issues = document.createElement('div');
  issues.className = 'room-check-issues';

  if (data.wrongItems?.length > 0) {
    issues.innerHTML += `<div class="room-check-issue">\u26A0\uFE0F ${data.wrongItems.length} Dinge am falschen Ort</div>`;
  }
  if (data.duplicates?.length > 0) {
    issues.innerHTML += `<div class="room-check-issue">\u{1F503} ${data.duplicates.length} Duplikate</div>`;
  }
  if (data.staleItems?.length > 0) {
    issues.innerHTML += `<div class="room-check-issue">\u{1F4A4} ${data.staleItems.length} lange nicht gesehen</div>`;
  }
  if (data.overfilled?.length > 0) {
    issues.innerHTML += `<div class="room-check-issue">\u{1F4E6} ${data.overfilled.length} Container \u00fcberf\u00fcllt</div>`;
  }

  el.appendChild(issues);

  // Container fill levels
  if (data.containerScores?.length > 0) {
    const containers = document.createElement('div');
    containers.className = 'room-check-containers';
    for (const c of data.containerScores.slice(0, 5)) {
      const fillPct = c.capacity ? Math.min(100, Math.round((c.capacity.count / Math.max(c.capacity.capacity || 20, 1)) * 100)) : 50;
      containers.innerHTML += `
        <div class="room-check-container-row">
          <span>${escapeHTML(c.containerName)}</span>
          <div class="room-check-fill-bar"><div class="room-check-fill" style="width:${fillPct}%"></div></div>
        </div>
      `;
    }
    el.appendChild(containers);
  }

  return el;
});

// 20. HouseholdCheckCard — Haushalts-Analyse
registerBlock('HouseholdCheckCard', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-household-check');

  const data = props.data;
  if (!data) { el.innerHTML = '<div class="block-empty">Keine Daten.</div>'; return el; }

  el.innerHTML = `
    <div class="hc-overall">
      <div class="hc-overall-score">${data.overallScore}%</div>
      <div class="hc-overall-label">Gesamt-Score \u00b7 ${data.totalItems || 0} Gegenst\u00e4nde</div>
    </div>
  `;

  if (data.roomScores?.length > 0) {
    const bars = document.createElement('div');
    bars.className = 'hc-room-bars';
    for (const r of data.roomScores) {
      bars.innerHTML += `
        <div class="hc-room-row">
          <span class="hc-room-name">${escapeHTML(r.roomName || '')}</span>
          <div class="hc-room-bar"><div class="hc-room-bar-fill" style="width:${r.roomScore}%"></div></div>
          <span class="hc-room-score">${r.roomScore}%</span>
        </div>
      `;
    }
    el.appendChild(bars);
  }

  const issuesParts = [];
  if (data.totalWrongPlace > 0) issuesParts.push(`${data.totalWrongPlace} falsch platziert`);
  if (data.totalStale > 0) issuesParts.push(`${data.totalStale} lange nicht gesehen`);
  if (data.pendingDonations > 0) issuesParts.push(`${data.pendingDonations} Spenden`);
  if (data.pendingSales > 0) issuesParts.push(`${data.pendingSales} Verk\u00e4ufe`);

  if (issuesParts.length > 0) {
    const issuesEl = document.createElement('div');
    issuesEl.className = 'hc-issues';
    issuesEl.textContent = issuesParts.join(' \u00b7 ');
    el.appendChild(issuesEl);
  }

  return el;
});

// 21. ImprovementReport — Verbesserungs-Report
registerBlock('ImprovementReport', () => {
  const el = document.createElement('div');
  el.classList.add('block-improvement');

  const report = getImprovementReport();

  const trendIcon = report.trend === 'aufwärts' ? '\u2191' : report.trend === 'abwärts' ? '\u2193' : '\u2192';
  const trendText = report.trend === 'aufwärts' ? 'Aufwärts!' : report.trend === 'abwärts' ? 'Abwärts' : 'Stabil';

  el.innerHTML = `<div class="improvement-trend">${trendIcon} ${trendText}</div>`;

  const bars = [
    { label: 'Heute', value: report.current },
    { label: 'Vor 1 Woche', value: report.weekAgo },
    { label: 'Vor 1 Monat', value: report.monthAgo },
    { label: 'Vor 3 Monaten', value: report.threeMonthsAgo },
  ];

  for (const bar of bars) {
    if (bar.value === null) continue;
    el.innerHTML += `
      <div class="improvement-bar-row">
        <span class="improvement-bar-label">${bar.label}</span>
        <div class="improvement-bar"><div class="improvement-bar-fill" style="width:${bar.value}%"></div></div>
        <span class="improvement-bar-value">${bar.value}%</span>
      </div>
    `;
  }

  if (report.milestones?.length > 0) {
    const ms = document.createElement('div');
    ms.className = 'improvement-milestones';
    for (const m of report.milestones) {
      ms.innerHTML += `<div>${m.emoji} ${escapeHTML(m.label)}</div>`;
    }
    el.appendChild(ms);
  }

  return el;
});

// 22. SeasonalCard — Saisonale Empfehlung
registerBlock('SeasonalCard', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-seasonal');

  const rec = getSeasonalRecommendations();
  if (!rec) { el.innerHTML = '<div class="block-empty">Keine saisonalen Tipps.</div>'; return el; }

  el.innerHTML = `<div class="seasonal-header">${rec.season.emoji} ${escapeHTML(rec.season.label)}</div>`;

  const maxItems = props.compact ? 3 : 20;

  function addSection(title, items, btnLabel, btnIcon) {
    if (items.length === 0) return;
    const section = document.createElement('div');
    section.className = 'seasonal-section';
    section.innerHTML = `<div class="seasonal-section-title">${title}</div>`;

    for (const item of items.slice(0, maxItems)) {
      const row = document.createElement('div');
      row.className = 'seasonal-item';
      row.innerHTML = `
        <span class="seasonal-item-name">${escapeHTML(item.itemName)}</span>
        <span class="seasonal-item-reason">${escapeHTML(item.reason)}</span>
      `;
      const btn = document.createElement('button');
      btn.className = 'seasonal-item-btn';
      btn.textContent = `${btnIcon} ${btnLabel}`;
      btn.addEventListener('click', async () => {
        const { handleAction } = await import('./ordo-agent.js');
        handleAction({ action: 'archiveItem', itemName: item.itemName, roomId: item.roomId, containerId: item.containerId });
      });
      row.appendChild(btn);
      section.appendChild(row);
    }
    el.appendChild(section);
  }

  addSection('Einlagern', rec.storeAway, 'Einlagern', '\u{1F4E6}');
  addSection('Rausholen', rec.bringOut, 'Rausholen', '\u2600\uFE0F');

  if (rec.tip) {
    const tip = document.createElement('div');
    tip.className = 'seasonal-tip';
    tip.textContent = rec.tip;
    el.appendChild(tip);
  }

  return el;
});

// 23. LifeEventBanner — Lebensereignis-Meldung
registerBlock('LifeEventBanner', () => {
  const el = document.createElement('div');
  el.classList.add('block-life-event');

  const events = detectLifeEvents();
  if (events.length === 0) {
    el.innerHTML = '<div class="block-empty">Keine besonderen Ereignisse erkannt.</div>';
    return el;
  }

  const event = events[0];
  el.innerHTML = `
    <div class="life-event-header">${event.emoji} ${escapeHTML(event.message)}</div>
    <div class="life-event-body">${escapeHTML(event.suggestion || '')}</div>
    <div class="life-event-actions">
      <button class="life-event-btn primary" data-action="${escapeHTML(event.action || 'showHome')}">${escapeHTML(event.suggestion ? 'Ja, los!' : 'OK')}</button>
      <button class="life-event-dismiss">\u2715 Nicht relevant</button>
    </div>
  `;

  el.querySelector('.life-event-btn').addEventListener('click', async () => {
    const { handleAction } = await import('./ordo-agent.js');
    handleAction({ action: event.action || 'showHome' });
  });

  el.querySelector('.life-event-dismiss').addEventListener('click', () => {
    el.style.display = 'none';
  });

  return el;
});

// 24. SpatialMap — 2D-Grundriss
registerBlock('SpatialMap', () => {
  const el = document.createElement('div');
  el.classList.add('block-spatial-map');

  const data = Brain.getData();
  const rooms = Object.entries(data.rooms || {});

  if (rooms.length === 0) {
    el.innerHTML = '<div class="block-empty">Noch keine R\u00e4ume erfasst.</div>';
    return el;
  }

  const grid = document.createElement('div');
  grid.className = 'spatial-map-grid';

  const colors = ['#E8A87C', '#85CDCA', '#D8A7CA', '#C9B1FF', '#A8D8A8', '#FFD6A5', '#FFB3B3', '#B5EAD7'];

  for (const [roomId, room] of rooms) {
    const itemCount = countItemsInRoom(room);
    const colorIdx = rooms.indexOf(rooms.find(([id]) => id === roomId)) % colors.length;

    const cell = document.createElement('div');
    cell.className = 'spatial-map-cell';
    cell.style.borderColor = colors[colorIdx];
    cell.style.background = colors[colorIdx] + '15';
    cell.innerHTML = `
      <span class="spatial-map-emoji">${escapeHTML(room.emoji || '\u{1F3E0}')}</span>
      <span class="spatial-map-name">${escapeHTML(room.name)}</span>
      <span class="spatial-map-count">${itemCount} Items</span>
    `;
    cell.addEventListener('click', async () => {
      const { handleAction } = await import('./ordo-agent.js');
      handleAction({ action: 'showRoom', roomId });
    });
    grid.appendChild(cell);
  }

  el.appendChild(grid);
  return el;
});

// 25. PhotoResult — Foto-Analyse-Ergebnis
registerBlock('PhotoResult', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-photo-result');

  const result = props.result || {};
  const items = result.items || [];
  const roomName = result.roomName || props.roomName || '';
  const containerName = result.containerName || props.containerName || '';

  if (props.photoUrl) {
    const img = document.createElement('img');
    img.className = 'photo-result-preview';
    img.src = props.photoUrl;
    img.alt = 'Foto';
    el.appendChild(img);
  }

  if (roomName || containerName) {
    const loc = document.createElement('div');
    loc.className = 'photo-result-location';
    loc.textContent = `\u{1F4CD} ${roomName}${containerName ? ' \u203A ' + containerName : ''}`;
    el.appendChild(loc);
  }

  if (items.length > 0) {
    const list = document.createElement('div');
    list.className = 'photo-result-items';
    for (const item of items) {
      const name = typeof item === 'string' ? item : item.name || '';
      const menge = typeof item === 'object' ? item.menge : 1;
      const row = document.createElement('div');
      row.className = 'photo-result-item';
      row.textContent = `\u2705 ${menge > 1 ? menge + '\u00d7 ' : ''}${name}`;
      list.appendChild(row);
    }
    el.appendChild(list);
  } else {
    el.innerHTML += '<div class="block-empty">Keine Gegenst\u00e4nde erkannt.</div>';
  }

  return el;
});

// 26. SmartPhotoResult — Smart-Foto-Ergebnis
registerBlock('SmartPhotoResult', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-photo-result');

  const result = props.result || {};
  const isNew = props.isNew;

  if (props.photoUrl) {
    const img = document.createElement('img');
    img.className = 'photo-result-preview';
    img.src = props.photoUrl;
    img.alt = 'Smart Foto';
    el.appendChild(img);
  }

  const loc = document.createElement('div');
  loc.className = 'photo-result-location';
  loc.textContent = `\u{1F4CD} ${escapeHTML(result.roomName || '')} \u203A ${escapeHTML(result.containerName || '')}${isNew ? ' (neu)' : ''}`;
  el.appendChild(loc);

  const items = result.items || [];
  if (items.length > 0) {
    const list = document.createElement('div');
    list.className = 'photo-result-items';
    for (const item of items) {
      const name = typeof item === 'string' ? item : item.name || '';
      const row = document.createElement('div');
      row.className = 'photo-result-item';
      row.textContent = `\u2705 ${name}`;
      list.appendChild(row);
    }
    el.appendChild(list);
  }

  return el;
});

// 27. ItemDetailCard — Gegenstand im Detail
registerBlock('ItemDetailCard', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-item-detail');

  const room = Brain.getRoom(props.roomId);
  const container = room ? (room.containers || {})[props.containerId] : null;
  if (!container) { el.innerHTML = '<div class="block-empty">Item nicht gefunden.</div>'; return el; }

  const items = container.items || [];
  const itemObj = items.find(i => {
    const name = typeof i === 'string' ? i : i.name;
    return name === props.itemName;
  });

  const item = typeof itemObj === 'string' ? { name: itemObj } : (itemObj || { name: props.itemName });

  el.innerHTML = `<div class="item-detail-name">${escapeHTML(item.name)}</div>`;
  el.innerHTML += `<div class="item-detail-location">${escapeHTML(room?.name || '')} \u203A ${escapeHTML(container.name)}</div>`;

  // Status & Freshness
  if (item.last_seen) {
    const days = Math.round((Date.now() - new Date(item.last_seen).getTime()) / 86400000);
    el.innerHTML += `<div class="item-detail-section"><span class="item-detail-label">Zuletzt gesehen</span><div class="item-detail-value">vor ${days} Tagen</div></div>`;
  }

  // Purchase
  if (item.purchase) {
    const parts = [];
    if (item.purchase.price) parts.push(`${item.purchase.price}\u20AC`);
    if (item.purchase.store) parts.push(escapeHTML(item.purchase.store));
    if (item.purchase.date) parts.push(escapeHTML(item.purchase.date));
    if (parts.length) {
      el.innerHTML += `<div class="item-detail-section"><span class="item-detail-label">Kauf</span><div class="item-detail-value">${parts.join(' \u00b7 ')}</div></div>`;
    }
  }

  // Warranty
  if (item.warranty) {
    const exp = item.warranty.expires || item.warranty.end || item.warranty;
    el.innerHTML += `<div class="item-detail-section"><span class="item-detail-label">Garantie</span><div class="item-detail-value">bis ${escapeHTML(String(exp))}</div></div>`;
  }

  // Expiry
  if (item.expiry_date) {
    el.innerHTML += `<div class="item-detail-section"><span class="item-detail-label">Verfallsdatum</span><div class="item-detail-value">${escapeHTML(String(item.expiry_date))}</div></div>`;
  }

  // Valuation
  if (item.valuation?.replacement_value) {
    el.innerHTML += `<div class="item-detail-section"><span class="item-detail-label">Wert</span><div class="item-detail-value">ca. ${item.valuation.replacement_value}\u20AC</div></div>`;
  }

  return el;
});

// 28. SearchResults — Suchergebnisse
registerBlock('SearchResults', (props) => {
  const el = document.createElement('div');
  el.classList.add('block-search-results');

  el.innerHTML = `
    <div class="search-found">\u{1F50D} ${escapeHTML(props.itemName || 'Item')} gefunden!</div>
    <div class="search-location">${escapeHTML(props.roomName || '')} \u203A ${escapeHTML(props.containerName || '')}</div>
    ${props.lastSeen ? `<div class="search-last-seen">Zuletzt gesehen: ${escapeHTML(props.lastSeen)}</div>` : ''}
  `;

  return el;
});

// 29. OfflineNotice — Offline-Hinweis
registerBlock('OfflineNotice', () => {
  const el = document.createElement('div');
  el.classList.add('block-offline');

  el.innerHTML = `
    <div class="offline-title">\u{1F4F6} Du bist offline</div>
    <div class="offline-desc">Fotos werden gespeichert und sp\u00e4ter analysiert.</div>
    <div class="offline-queue">\u{1F4F7} Warteschlange: 0 Fotos</div>
  `;

  return el;
});

// 30. ActivityLog — Heutige Aktivität
registerBlock('ActivityLog', () => {
  const el = document.createElement('div');
  el.classList.add('block-activity-log');

  const summary = getTodaySummary() || { actions: 0, photos: 0, chats: 0 };

  el.innerHTML = `
    <div class="activity-header">Heute:</div>
    <div class="activity-stat">\u{1F4CB} ${summary.actions} Aktionen</div>
    <div class="activity-stat">\u{1F4F7} ${summary.photos} Fotos</div>
    <div class="activity-stat">\u{1F4AC} ${summary.chats} Nachrichten</div>
  `;

  if (summary.actions === 0) {
    el.innerHTML += '<div class="activity-comment">Noch nichts passiert heute. Los geht\'s!</div>';
  } else if (summary.actions > 10) {
    el.innerHTML += '<div class="activity-comment">Produktiver Tag!</div>';
  }

  return el;
});

// 31. LiveDialogCard — Echtzeit-Gespräch via Gemini Live API
registerBlock('LiveDialogCard', () => {
  const el = document.createElement('div');
  el.classList.add('block-live-dialog');

  let session = null;
  let isActive = false;

  el.innerHTML = `
    <div class="live-orb" id="live-orb">\u{1F3A4}</div>
    <div class="live-status" id="live-status">Bereit</div>
    <div class="live-transcript" id="live-transcript"></div>
    <div class="live-controls">
      <button class="live-btn live-btn-start" id="live-start">\u{1F3A4} Live starten</button>
      <button class="live-btn live-btn-stop" id="live-stop">\u23F9\uFE0F Beenden</button>
    </div>
  `;

  const orb = el.querySelector('#live-orb');
  const statusEl = el.querySelector('#live-status');
  const transcript = el.querySelector('#live-transcript');
  const startBtn = el.querySelector('#live-start');
  const stopBtn = el.querySelector('#live-stop');

  function addTranscriptLine(text, role) {
    const line = document.createElement('div');
    line.className = 'live-transcript-line' + (role === 'agent' ? ' agent' : '');
    line.textContent = text;
    transcript.appendChild(line);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function updateState(state) {
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

  startBtn.addEventListener('click', async () => {
    if (isActive) return;
    isActive = true;
    startBtn.style.display = 'none';
    stopBtn.style.display = 'inline-block';

    try {
      const { GeminiLiveSession, ORDO_FUNCTIONS, functionCallToAction, executeOrdoAction } = await import('./ai.js');
      const apiKey = Brain.getApiKey();
      if (!apiKey) {
        statusEl.textContent = 'Kein API-Key!';
        return;
      }

      session = new GeminiLiveSession();
      session.onStateChange = updateState;
      session.onTranscript = (text, role) => addTranscriptLine(text, role === 'model' ? 'agent' : 'user');
      session.onError = (msg) => {
        addTranscriptLine('\u26A0\uFE0F ' + msg, 'agent');
        updateState('disconnected');
      };

      // Function Calls ausführen und Ergebnis im Transcript anzeigen
      session.onFunctionCall = (call) => {
        const action = functionCallToAction(call);
        if (action && action.type !== 'found') {
          executeOrdoAction(action);
          addTranscriptLine(`\u2705 ${call.name}`, 'agent');
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
      addTranscriptLine('Live-Session gestartet. Sprich einfach!', 'agent');
    } catch (err) {
      statusEl.textContent = 'Fehler: ' + (err.message || 'Verbindung fehlgeschlagen');
      isActive = false;
      startBtn.style.display = 'inline-block';
      stopBtn.style.display = 'none';
    }
  });

  stopBtn.addEventListener('click', async () => {
    if (session) {
      session.disconnect();
      session = null;
    }
    isActive = false;
    startBtn.style.display = 'inline-block';
    stopBtn.style.display = 'none';
    updateState('disconnected');
    addTranscriptLine('Session beendet.', 'agent');

    const { handleAction } = await import('./ordo-agent.js');
    handleAction({ action: 'endLive' });
  });

  return el;
});
