// ui-blocks.js – UI-Block-Renderer für den Dialog-Stream
// Jeder Block-Typ hat eine Render-Funktion die ein DOM-Element zurückgibt.

import Brain from './brain.js';
import { escapeHTML, getRoomEmoji } from './app.js';
import {
  calculateFreedomIndex, getQuickDecision, getArchivedByReason,
  getSellableItems, roomCheck, householdCheck, getImprovementReport,
  getSeasonalRecommendations, detectLifeEvents, getCurrentSeason,
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

  for (const item of activeItems) {
    const name = typeof item === 'string' ? item : item.name;
    const menge = typeof item === 'object' ? item.menge : 1;
    const freshness = typeof item === 'object' ? getItemFreshnessClass(item) : '';

    const row = document.createElement('div');
    row.classList.add('block-item-row');
    if (freshness) row.classList.add(freshness);
    row.innerHTML = `
      <span class="item-name">${menge > 1 ? menge + '\u00d7 ' : ''}${escapeHTML(name)}</span>
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
    el.appendChild(row);
  }

  return el;
});

// 5. PhotoButton — Großer Foto-Auslöser
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
