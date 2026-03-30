// organizer.js – Der Aufräumassistent

import Brain from './brain.js';
import { analyzeContainerForOrganizing } from './ai.js';
import { ROOM_TYPES, normalizeRoomType } from './app.js';

const RECOMMENDATION_CACHE_KEY = 'ordo_organizer_cache';
const SCORE_HISTORY_KEY = 'ordo_score_history';

const ITEM_CATEGORIES = {
  werkzeug: {
    keywords: /schere|hammer|zange|bohr|schraub|säge|feile|meissel|werkzeug|bit|dübel|nagel|schleif|lötkolben|multitool|wasserwaage|massband|akkuschrauber/i,
    allowedRooms: ['abstellraum', 'keller', 'garage', 'arbeitszimmer', 'werkstatt'],
    disposal: 'restmuell'
  },
  medikamente: {
    keywords: /tablette|medikament|pflaster|ibuprofen|salbe|tropfen|verband|aspirin|paracetamol|hustensaft|nasenspray|vitamin|creme|gel|arznei|rezept/i,
    allowedRooms: ['bad', 'schlafzimmer'],
    disposal: 'medikamente'
  },
  kochgeschirr: {
    keywords: /topf|pfanne|sieb|reibe|kelle|schneidebrett|backform|auflauf|wok|bräter|kasserolle|deckel|kochlöffel|schneebesen|nudelholz|messbecher/i,
    allowedRooms: ['kueche'],
    disposal: 'restmuell'
  },
  geschirr: {
    keywords: /teller|tasse|glas|becher|schüssel|schale|kanne|karaffe|müsli|espresso|untertasse|servierplatte/i,
    allowedRooms: ['kueche', 'esszimmer'],
    disposal: 'restmuell'
  },
  besteck: {
    keywords: /messer|gabel|löffel|besteck|teelöffel|buttermesser|vorlegegabel|tortenheber/i,
    allowedRooms: ['kueche', 'esszimmer'],
    disposal: 'restmuell'
  },
  gewuerze: {
    keywords: /salz|pfeffer|gewürz|paprika|oregano|basilikum|curry|zimt|muskat|kümmel|chili|knoblauch|kurkuma|ingwer/i,
    allowedRooms: ['kueche'],
    disposal: 'restmuell'
  },
  kleidung: {
    keywords: /hemd|hose|jacke|mantel|pullover|socke|unterwäsche|kleid|rock|bluse|anzug|jeans|shirt|schal|mütze|handschuh|gürtel|krawatte/i,
    allowedRooms: ['schlafzimmer', 'flur', 'ankleide', 'garderobe'],
    disposal: 'textilien'
  },
  schuhe: {
    keywords: /schuh|stiefel|sneaker|sandale|pantoffel|slipper|pumps|turnschuh|wanderschuh|gummistiefel|ballerina|flip.?flop/i,
    allowedRooms: ['flur', 'schlafzimmer', 'ankleide', 'garderobe'],
    disposal: 'textilien'
  },
  handtuch: {
    keywords: /handtuch|waschlappen|bademantel|duschtuch|gästetuch|badetuch/i,
    allowedRooms: ['bad'],
    disposal: 'textilien'
  },
  bettwaesche: {
    keywords: /bettwäsche|bettlaken|kissenbezug|bettbezug|spannbettlaken|decke|kissen|laken/i,
    allowedRooms: ['schlafzimmer'],
    disposal: 'textilien'
  },
  putzmittel: {
    keywords: /putzmittel|reiniger|lappen|schwamm|besen|wischer|eimer|spülmittel|waschmittel|weichspüler|entkalker|desinfektions|staubsauger|beutel/i,
    allowedRooms: ['bad', 'abstellraum', 'kueche', 'hauswirtschaft'],
    disposal: 'restmuell'
  },
  elektro: {
    keywords: /kabel|ladekabel|adapter|netzteil|usb|hdmi|stecker|verlängerung|mehrfachstecker|fernbedienung|controller|kopfhörer|lautsprecher|charger/i,
    allowedRooms: ['arbeitszimmer', 'wohnzimmer', 'schlafzimmer'],
    disposal: 'elektro'
  },
  buero: {
    keywords: /stift|kugelschreiber|bleistift|textmarker|notiz|block|ordner|hefter|locher|klebeband|tesa|briefumschlag|papier|post.?it|büroklammer|lineal/i,
    allowedRooms: ['arbeitszimmer', 'wohnzimmer'],
    disposal: 'papier'
  },
  spielzeug: {
    keywords: /spielzeug|lego|puppe|ball|puzzle|spiel|figur|plüsch|teddy|baustein|malen|kreide|knete/i,
    allowedRooms: ['kinderzimmer', 'wohnzimmer'],
    disposal: 'restmuell'
  },
  deko: {
    keywords: /vase|kerze|bilderrahmen|deko|figur|skulptur|wandbild|poster|lichterkette|pflanze|blumentopf/i,
    allowedRooms: ['wohnzimmer', 'schlafzimmer', 'flur', 'esszimmer'],
    disposal: 'restmuell'
  },
  batterien: {
    keywords: /batterie|akku|knopfzelle|mignon/i,
    allowedRooms: null,
    disposal: 'batterien'
  },
  glas: {
    keywords: /einmachglas|marmeladenglas|flasche|glasflasche/i,
    allowedRooms: ['kueche', 'keller'],
    disposal: 'glas'
  }
};

// ROOM_TYPE_LABELS derived from centralized ROOM_TYPES (lazy to avoid circular import issue)
let _roomTypeLabels = null;
function getRoomTypeLabels() {
  if (!_roomTypeLabels) {
    _roomTypeLabels = Object.fromEntries(
      Object.entries(ROOM_TYPES).map(([k, v]) => [k, v.name])
    );
  }
  return _roomTypeLabels;
}

const DISPOSAL_GUIDE = {
  elektro: { text: 'Elektroschrott: Zum Wertstoffhof oder Saturn/MediaMarkt Rückgabe', icon: '⚡', hinweis: 'Elektrogeräte nicht in den Hausmüll!' },
  batterien: { text: 'Sammelbox im Supermarkt oder Drogerie', icon: '🔋', hinweis: "Gibt\'s in jedem Supermarkt am Eingang" },
  medikamente: { text: 'Apotheke oder Restmüll', icon: '💊', hinweis: 'Nie in die Toilette oder den Ausguss spülen' },
  textilien: { text: 'Altkleidercontainer oder Sozialkaufhaus', icon: '👕', hinweis: 'Nur saubere, trockene Kleidung' },
  glas: { text: 'Glascontainer (nach Farbe sortiert)', icon: '🫙', hinweis: 'Deckel vorher abschrauben' },
  papier: { text: 'Altpapier-Tonne', icon: '📄', hinweis: 'Keine beschichteten Papiere oder Kassenbons' },
  sperrig: { text: 'Sperrmüll-Termin bei der Stadtverwaltung', icon: '🛋️', hinweis: 'Online buchbar, oft kostenlos' },
  restmuell: { text: 'Hausmüll (graue Tonne)', icon: '🗑️', hinweis: 'Alles was nirgendwo anders hingehört' }
};

function itemNameOf(item) {
  return typeof item === 'string' ? item : (item?.name || '');
}

// normalizeRoomType is now imported from app.js (single source of truth)

export function classifyItem(itemName) {
  const lower = (itemName || '').toLowerCase();
  for (const [category, config] of Object.entries(ITEM_CATEGORIES)) {
    if (config.keywords.test(lower)) {
      return { category, allowedRooms: config.allowedRooms, disposal: config.disposal };
    }
  }
  return null;
}

export function checkItemPlacement(item, roomType) {
  const classification = classifyItem(itemNameOf(item));
  if (!classification) return null;
  if (!classification.allowedRooms) return 'passt';

  const roomNormalized = normalizeRoomType(roomType);
  if (classification.allowedRooms.includes(roomNormalized)) return 'passt';

  return {
    problem: 'falscher_ort',
    category: classification.category,
    suggestion: classification.allowedRooms[0],
    suggestedRoomName: getRoomTypeLabels()[classification.allowedRooms[0]] || classification.allowedRooms[0]
  };
}

export function findHouseholdDuplicates() {
  const data = Brain.getData();
  const flat = [];
  for (const [roomId, room] of Object.entries(data?.rooms || {})) {
    collectItemsRecursive(room.containers, roomId, room.name, flat);
  }

  const groups = [];
  flat.forEach(loc => {
    const match = groups.find(g => Brain.isFuzzyMatch(g.name, loc.name));
    if (match) {
      match.locations.push(loc);
      match.totalCount += (loc.menge || 1);
    } else {
      groups.push({ name: loc.name, locations: [loc], totalCount: loc.menge || 1 });
    }
  });

  return groups
    .filter(g => g.locations.length > 1)
    .sort((a, b) => b.totalCount - a.totalCount);
}

function collectItemsRecursive(containers, roomId, roomName, result) {
  for (const [containerId, container] of Object.entries(containers || {})) {
    for (const item of (container.items || [])) {
      const itemObj = typeof item === 'string' ? { name: item } : item;
      if (itemObj.status === 'archiviert' || !itemObj.name) continue;
      result.push({
        name: itemObj.name,
        roomId,
        roomName,
        containerId,
        containerName: container.name,
        menge: itemObj.menge || 1
      });
    }
    if (container.containers) collectItemsRecursive(container.containers, roomId, roomName, result);
  }
}

export function getContainerCapacity(roomId, containerId) {
  const container = Brain.getContainer(roomId, containerId);
  if (!container) return null;

  const activeItems = (container.items || []).filter(i => {
    const item = typeof i === 'string' ? { status: 'aktiv' } : i;
    return item.status !== 'archiviert';
  });

  const count = activeItems.reduce((sum, i) => {
    const item = typeof i === 'string' ? {} : i;
    return sum + (item.menge || 1);
  }, 0);

  const typicalCapacity = { schrank: 20, regal: 15, schublade: 10, kiste: 12, kommode: 15, sonstiges: 12 };
  const capacity = typicalCapacity[container.typ] || 12;
  const ratio = count / capacity;

  let level = 'ok';
  let score = 1;
  if (ratio <= 0.3) { level = 'leer'; score = 0.5; }
  else if (ratio <= 0.8) { level = 'ok'; score = 1; }
  else if (ratio <= 1) { level = 'voll'; score = 0.7; }
  else { level = 'überfüllt'; score = 0.3; }

  return { count, capacity, ratio, level, score };
}

export function getDisposalGuide(itemName) {
  const classification = classifyItem(itemName);
  const type = classification ? classification.disposal : 'restmuell';
  return DISPOSAL_GUIDE[type] || DISPOSAL_GUIDE.restmuell;
}

function countItemsRecursive(containers) {
  let count = 0;
  for (const container of Object.values(containers || {})) {
    count += Brain.countItemsInContainer(container);
  }
  return count;
}

function analyzeContainersRecursive(containers, roomId, roomName, roomType, breakdown) {
  for (const [containerId, container] of Object.entries(containers || {})) {
    const capacity = getContainerCapacity(roomId, containerId);
    if (capacity && capacity.level === 'überfüllt') {
      breakdown.overfilled.push({ roomId, roomName, containerId, containerName: container.name, count: capacity.count, capacity: capacity.capacity });
    }
    if (capacity && capacity.level === 'leer' && capacity.count > 0) {
      breakdown.underused.push({ roomId, roomName, containerId, containerName: container.name });
    }

    for (const item of (container.items || [])) {
      const itemObj = typeof item === 'string' ? { name: item, status: 'aktiv' } : item;
      if (itemObj.status === 'archiviert') continue;

      const placement = checkItemPlacement(itemObj, roomType);
      if (placement && placement !== 'passt' && placement.problem === 'falscher_ort') {
        breakdown.wrongPlace.push({ ...placement, itemName: itemObj.name, roomId, roomName, containerId, containerName: container.name });
      }

      if (itemObj.last_seen) {
        const monthsSince = (Date.now() - new Date(itemObj.last_seen).getTime()) / (1000 * 60 * 60 * 24 * 30);
        if (monthsSince >= 12) {
          breakdown.staleItems.push({
            itemName: itemObj.name,
            lastSeen: itemObj.last_seen,
            monthsAgo: Math.round(monthsSince),
            roomId,
            roomName,
            containerId,
            containerName: container.name,
            value: itemObj.valuation?.replacement_value || itemObj.purchase?.price || null
          });
        }
      }
    }

    if (container.containers) analyzeContainersRecursive(container.containers, roomId, roomName, roomType, breakdown);
  }
}

export function calculateFreedomIndex() {
  const data = Brain.getData();
  const breakdown = { wrongPlace: [], duplicates: [], staleItems: [], overfilled: [], underused: [] };
  let totalDebt = 0;
  let totalItems = 0;

  for (const [roomId, room] of Object.entries(data?.rooms || {})) {
    const roomType = normalizeRoomType(room.name || roomId);
    analyzeContainersRecursive(room.containers, roomId, room.name, roomType, breakdown);
    totalItems += countItemsRecursive(room.containers);
  }

  const duplicates = findHouseholdDuplicates();
  for (const dup of duplicates) {
    if (dup.totalCount > 2) {
      breakdown.duplicates.push(dup);
      totalDebt += (dup.totalCount - 1);
    }
  }

  totalDebt += breakdown.wrongPlace.length * 2;
  totalDebt += breakdown.staleItems.length;
  totalDebt += breakdown.overfilled.length * 2;
  totalDebt += breakdown.underused.length;

  const maxPossibleDebt = Math.max(totalItems * 3, 1);
  const percent = Math.max(0, Math.min(100, Math.round(100 - (totalDebt / maxPossibleDebt * 100))));

  let label;
  if (percent >= 90) label = 'Hervorragend organisiert!';
  else if (percent >= 75) label = 'Gut organisiert — ein paar Ecken verdienen Aufmerksamkeit.';
  else if (percent >= 60) label = 'OK, aber es gibt Verbesserungspotenzial.';
  else if (percent >= 40) label = 'Einige Bereiche brauchen Aufmerksamkeit.';
  else label = 'Dein Zuhause hat viel Optimierungspotenzial.';

  return { percent, totalDebt, breakdown, label, totalItems };
}

export function getScoreBreakdown() {
  const { breakdown, percent, totalDebt, totalItems, label } = calculateFreedomIndex();
  return { breakdown, percent, totalDebt, totalItems, label };
}

export function simulateScore(actions) {
  const current = calculateFreedomIndex();
  let debtReduction = 0;

  for (const action of (actions || [])) {
    if (action.type === 'archive') debtReduction += 3;
    if (action.type === 'move') debtReduction += 2;
  }

  const simulatedDebt = Math.max(0, current.totalDebt - debtReduction);
  const maxPossibleDebt = Math.max(current.totalItems * 3, 1);
  const simulatedPercent = Math.max(0, Math.min(100, Math.round(100 - (simulatedDebt / maxPossibleDebt * 100))));

  return { currentPercent: current.percent, simulatedPercent, delta: simulatedPercent - current.percent };
}

export function getQuickWins(maxCount = 5) {
  const { breakdown } = calculateFreedomIndex();
  const wins = [];

  breakdown.wrongPlace.forEach(item => {
    wins.push({
      type: 'move',
      description: `${item.itemName} → ${item.suggestedRoomName}`,
      detail: `Gehört nicht in die ${item.roomName}`,
      itemName: item.itemName,
      roomId: item.roomId,
      containerId: item.containerId,
      suggestedRoom: item.suggestion,
      impactPoints: 2,
      estimatedMinutes: 2
    });
  });

  breakdown.staleItems.forEach(item => {
    const valueStr = item.value ? ` (~${item.value}€)` : '';
    wins.push({
      type: 'decide',
      description: `${item.itemName} — seit ${item.monthsAgo} Monaten nicht gesehen${valueStr}`,
      detail: 'Behalten oder weg?',
      itemName: item.itemName,
      roomId: item.roomId,
      containerId: item.containerId,
      impactPoints: item.value && item.value < 10 ? 3 : 1,
      estimatedMinutes: 0.5
    });
  });

  breakdown.duplicates.forEach(dup => {
    wins.push({
      type: 'consolidate',
      description: `${dup.name} — ${dup.totalCount}× in ${dup.locations.length} Bereichen`,
      detail: 'Zusammenlegen oder aussortieren?',
      itemName: dup.name,
      locations: dup.locations,
      impactPoints: Math.max(1, dup.totalCount - 1),
      estimatedMinutes: 5
    });
  });

  // Expired items (high priority health risk)
  try {
    const expiredItems = Brain.getExpiringItems(0).filter(e => e.isExpired);
    for (const exp of expiredItems) {
      wins.push({
        type: 'decide',
        description: `${exp.item.name} — abgelaufen (${Math.abs(exp.daysUntilExpiry)} Tage)`,
        detail: 'Entsorgen?',
        itemName: exp.item.name,
        roomId: exp.roomId,
        containerId: exp.containerId,
        impactPoints: 3,
        estimatedMinutes: 0.5,
      });
    }
  } catch { /* expiry data may not exist */ }

  wins.sort((a, b) => (b.impactPoints / b.estimatedMinutes) - (a.impactPoints / a.estimatedMinutes));
  return wins.slice(0, maxCount);
}

export function getQuickDecision() {
  const { breakdown } = calculateFreedomIndex();
  const staleByValue = [...breakdown.staleItems].sort((a, b) => (a.value || 999) - (b.value || 999));

  if (staleByValue.length > 0) {
    const item = staleByValue[0];
    return {
      type: 'decide',
      itemName: item.itemName,
      roomName: item.roomName,
      containerName: item.containerName,
      monthsAgo: item.monthsAgo,
      value: item.value,
      disposal: getDisposalGuide(item.itemName),
      roomId: item.roomId,
      containerId: item.containerId
    };
  }

  return null;
}

export function getTasksForTimeSlot(minutes) {
  if (minutes <= 2) return { mode: 'quick_decision', task: getQuickDecision() };
  if (minutes <= 5) return { mode: 'quick_wins', tasks: getQuickWins(3) };
  if (minutes <= 15) return { mode: 'container', tasks: getQuickWins(8) };
  return { mode: 'full', tasks: getQuickWins(15) };
}

function summarizeHousehold() {
  const rooms = Brain.getRooms();
  const summary = Object.entries(rooms).map(([roomId, room]) => {
    const itemsCount = countItemsRecursive(room.containers);
    return `${room.name || roomId}: ${itemsCount} aktive Items`;
  });
  return summary.join('; ');
}

export async function containerCheck(roomId, containerId, photoBase64) {
  const cached = getCachedRecommendations(roomId, containerId);
  if (cached) return { ...cached, fromCache: true };

  const room = Brain.getRoom(roomId);
  const container = Brain.getContainer(roomId, containerId);
  if (!room || !container) throw new Error('Container nicht gefunden');

  const itemList = (container.items || [])
    .filter(i => typeof i === 'string' || i.status !== 'archiviert')
    .map(i => itemNameOf(i))
    .join(', ') || 'leer';

  const result = await analyzeContainerForOrganizing(
    photoBase64,
    {
      roomName: room.name,
      containerName: container.name,
      containerType: container.typ || 'sonstiges',
      itemList
    },
    summarizeHousehold()
  );

  cacheRecommendations(roomId, containerId, result);
  return result;
}

export function getCachedRecommendations(roomId, containerId) {
  let cache;
  try { cache = JSON.parse(localStorage.getItem(RECOMMENDATION_CACHE_KEY) || '{}'); } catch { return null; }
  const key = `${roomId}_${containerId}`;
  const entry = cache[key];
  if (!entry) return null;

  const age = Date.now() - new Date(entry.timestamp).getTime();
  if (age > 7 * 24 * 60 * 60 * 1000) return null;

  return entry.data;
}

function cacheRecommendations(roomId, containerId, data) {
  let cache;
  try { cache = JSON.parse(localStorage.getItem(RECOMMENDATION_CACHE_KEY) || '{}'); } catch { cache = {}; }
  cache[`${roomId}_${containerId}`] = { data, timestamp: new Date().toISOString() };
  localStorage.setItem(RECOMMENDATION_CACHE_KEY, JSON.stringify(cache));
}

export function recordWeeklyScore() {
  const { percent } = calculateFreedomIndex();
  let history;
  try { history = JSON.parse(localStorage.getItem(SCORE_HISTORY_KEY) || '[]'); } catch { history = []; }
  const lastEntry = history[history.length - 1];

  if (lastEntry) {
    const daysSince = (Date.now() - new Date(lastEntry.date).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 6) return history;
  }

  history.push({ date: new Date().toISOString(), percent });
  if (history.length > 52) history.shift();
  localStorage.setItem(SCORE_HISTORY_KEY, JSON.stringify(history));
  return history;
}

export function getScoreTrend() {
  let history;
  try { history = JSON.parse(localStorage.getItem(SCORE_HISTORY_KEY) || '[]'); } catch { history = []; }
  if (history.length < 2) return null;
  const current = history[history.length - 1];
  const previous = history[history.length - 2];
  return {
    delta: current.percent - previous.percent,
    previousPercent: previous.percent,
    currentPercent: current.percent
  };
}

// ── Circular Engine: Archivierte Items ─────────────────

/**
 * Gibt alle archivierten Items gruppiert nach Grund zurück.
 * @returns {{ donated: Array, discarded: Array, sold: Array, stored: Array, unknown: Array }}
 */
export function getArchivedByReason() {
  const data = Brain.getData();
  const result = {
    donated: [],
    discarded: [],
    sold: [],
    stored: [],
    unknown: [],
  };

  for (const [roomId, room] of Object.entries(data.rooms || {})) {
    collectArchivedRecursive(room.containers, roomId, room.name, result);
  }

  return result;
}

function collectArchivedRecursive(containers, roomId, roomName, result) {
  for (const [containerId, container] of Object.entries(containers || {})) {
    for (const item of (container.items || [])) {
      const obj = typeof item === 'string' ? null : item;
      if (!obj || obj.status !== 'archiviert') continue;

      const entry = {
        name: obj.name,
        roomId, roomName,
        containerId, containerName: container.name,
        archivedAt: obj.archived_at,
        reason: obj.archived_reason || 'archiviert',
        value: obj.valuation?.replacement_value || obj.purchase?.price || null,
        photoKey: obj.crop_ref || `${roomId}_${containerId}`,
        category: classifyItem(obj.name),
      };

      switch (entry.reason) {
        case 'gespendet': result.donated.push(entry); break;
        case 'entsorgt': result.discarded.push(entry); break;
        case 'verkauft': result.sold.push(entry); break;
        case 'eingelagert': result.stored.push(entry); break;
        default: result.unknown.push(entry); break;
      }
    }

    if (container.containers) {
      collectArchivedRecursive(container.containers, roomId, roomName, result);
    }
  }
}

/**
 * Gibt archivierte Items zurück die verkaufbar sind (Wert > 10€).
 */
export function getSellableItems() {
  const { donated, discarded, unknown } = getArchivedByReason();
  const all = [...donated, ...discarded, ...unknown];

  return all.filter(item =>
    item.value && item.value > 10
  ).sort((a, b) => (b.value || 0) - (a.value || 0));
}

/**
 * Findet einen geeigneten Lagerraum (Keller, Abstellraum, Dachboden, Garage).
 */
export function findStorageRoom() {
  const data = Brain.getData();
  const storageTypes = ['keller', 'abstellraum', 'dachboden', 'garage'];

  for (const [roomId, room] of Object.entries(data.rooms || {})) {
    const roomType = normalizeRoomType(room.name);
    if (storageTypes.includes(roomType)) {
      const containerIds = Object.keys(room.containers || {});
      if (containerIds.length > 0) {
        return {
          roomId,
          roomName: room.name,
          containerId: containerIds[0],
        };
      }
    }
  }

  return null;
}

// ── Raum-Check ─────────────────────────────────────────

/**
 * Analysiert einen kompletten Raum über alle Container hinweg.
 * Komplett lokal, kein API-Call.
 * @param {string} roomId
 * @returns {{ roomScore, containerScores[], wrongItems[], duplicates[], staleItems[], quickWins[], estimatedMinutes, totalItems }}
 */
export function roomCheck(roomId) {
  const room = Brain.getRoom(roomId);
  if (!room) return null;

  const roomType = normalizeRoomType(room.name);
  const containers = room.containers || {};

  const containerScores = [];
  for (const [cId, container] of Object.entries(containers)) {
    const capacity = getContainerCapacity(roomId, cId);
    const wrongItems = [];
    const staleItems = [];

    for (const item of (container.items || [])) {
      const obj = typeof item === 'string' ? { name: item, status: 'aktiv' } : item;
      if (obj.status === 'archiviert') continue;

      const placement = checkItemPlacement(obj, roomType);
      if (placement && placement !== 'passt') wrongItems.push({ ...placement, itemName: obj.name });

      if (obj.last_seen) {
        const months = (Date.now() - new Date(obj.last_seen).getTime()) / (1000 * 60 * 60 * 24 * 30);
        if (months >= 12) staleItems.push({ itemName: obj.name, months: Math.round(months) });
      }
    }

    containerScores.push({
      containerId: cId,
      containerName: container.name,
      capacity,
      wrongItems,
      staleItems,
    });
  }

  const allWrongItems = containerScores.flatMap(c => c.wrongItems);
  const roomDuplicates = findDuplicatesInRoom(roomId);
  const overfilled = containerScores.filter(c => c.capacity?.level === 'überfüllt');
  const underused = containerScores.filter(c => c.capacity?.level === 'leer');

  const totalIssues = allWrongItems.length + roomDuplicates.length
    + overfilled.length + containerScores.reduce((s, c) => s + c.staleItems.length, 0);
  const totalItems = containerScores.reduce((s, c) => s + (c.capacity?.count || 0), 0);
  const maxIssues = Math.max(totalItems * 2, 1);
  const roomScore = Math.max(0, Math.min(100,
    Math.round(100 - (totalIssues / maxIssues * 100))
  ));

  const quickWins = getQuickWins(10).filter(w => w.roomId === roomId);
  const estimatedMinutes = quickWins.reduce((sum, w) => sum + w.estimatedMinutes, 0);

  return {
    roomId,
    roomName: room.name,
    roomScore,
    containerScores,
    wrongItems: allWrongItems,
    duplicates: roomDuplicates,
    overfilled,
    underused,
    staleItems: containerScores.flatMap(c => c.staleItems),
    quickWins,
    estimatedMinutes: Math.round(estimatedMinutes),
    totalItems,
  };
}

/**
 * Findet Duplikate NUR innerhalb eines Raums.
 */
export function findDuplicatesInRoom(roomId) {
  const room = Brain.getRoom(roomId);
  if (!room) return [];

  const itemMap = {};
  for (const [cId, container] of Object.entries(room.containers || {})) {
    for (const item of (container.items || [])) {
      const obj = typeof item === 'string' ? { name: item } : item;
      if (obj.status === 'archiviert') continue;
      const key = obj.name.toLowerCase().trim();
      if (!itemMap[key]) itemMap[key] = [];
      itemMap[key].push({ containerId: cId, containerName: container.name });
    }
  }

  return Object.entries(itemMap)
    .filter(([_, locs]) => locs.length > 1)
    .map(([name, locations]) => ({ name, locations, count: locations.length }));
}

// ── Haushalts-Check ────────────────────────────────────

/**
 * Analysiert den gesamten Haushalt.
 * Komplett lokal, kein API-Call.
 * @returns {{ overallScore, roomScores[], topQuickWins[], totalItems, totalWrongPlace, totalStale, allDuplicates[], pendingDonations, pendingSales, estimatedTotalMinutes }}
 */
export function householdCheck() {
  const data = Brain.getData();
  const roomIds = Object.keys(data.rooms || {});

  const roomScores = roomIds.map(id => roomCheck(id)).filter(Boolean);

  const overallScore = roomScores.length > 0
    ? Math.round(roomScores.reduce((sum, r) => sum + r.roomScore, 0) / roomScores.length)
    : 100;

  const allDuplicates = findHouseholdDuplicates();
  const topQuickWins = getQuickWins(5);

  const totalItems = roomScores.reduce((s, r) => s + r.totalItems, 0);
  const totalWrongPlace = roomScores.reduce((s, r) => s + r.wrongItems.length, 0);
  const totalStale = roomScores.reduce((s, r) => s + r.staleItems.length, 0);

  const archived = getArchivedByReason();
  const pendingDonations = archived.donated.length;
  const pendingSales = archived.sold.length;

  return {
    overallScore,
    roomScores,
    topQuickWins,
    totalItems,
    totalWrongPlace,
    totalStale,
    allDuplicates,
    pendingDonations,
    pendingSales,
    estimatedTotalMinutes: topQuickWins.reduce((s, w) => s + w.estimatedMinutes, 0),
  };
}

// ── Saisonale Intelligenz ─────────────────────────────

const SEASONAL_RULES = {
  spring: {
    months: [3, 4, 5],
    label: 'Frühjahrsputz',
    emoji: '🌸',
    storeAway: [
      { keywords: /winterjacke|wintermantel|skianzug|schneehose|daunenjacke|parka/i, target: 'keller', reason: 'Bis Oktober einlagern' },
      { keywords: /schneeschaufel|streusalz|eiskratzer/i, target: 'keller', reason: 'Erst im November wieder nötig' },
      { keywords: /wärmflasche|heizlüfter|heizdecke/i, target: 'abstellraum', reason: 'Bis zum Herbst einpacken' },
      { keywords: /mütze|handschuh|schal|ohrenschützer/i, target: 'keller', reason: 'Winteraccessoires einlagern' },
      { keywords: /winterstiefel|schneestiefel|moonboot/i, target: 'keller', reason: 'Platz für Sommerschuhe' },
    ],
    bringOut: [
      { keywords: /sonnencreme|sonnenbrille|sonnenhut/i, reason: 'Bald wieder nötig!' },
      { keywords: /gartenmöbel|grill|sonnenschirm/i, reason: 'Raus auf den Balkon/Terrasse' },
      { keywords: /sandalen|flip.?flop|leichte.?schuhe/i, reason: 'Sommerschuhe nach vorne' },
    ],
    tip: 'Frühjahrsputz-Tipp: Alles was du im Winter nicht ein einziges Mal getragen hast → Spendenliste.',
  },
  summer: {
    months: [6, 7, 8],
    label: 'Sommer-Check',
    emoji: '☀️',
    storeAway: [
      { keywords: /regenjacke|regenschirm|gummistiefel/i, target: 'abstellraum', reason: 'Trockenzeit' },
    ],
    bringOut: [
      { keywords: /ventilator|klimagerät/i, reason: 'Wird bald heiß!' },
      { keywords: /badehose|badeanzug|bikini|strandtuch/i, reason: 'Badesaison!' },
    ],
    tip: 'Sommer-Tipp: Perfekte Zeit um den Keller aufzuräumen — bei gutem Wetter kann man alles rausstellen.',
  },
  autumn: {
    months: [9, 10, 11],
    label: 'Herbst-Vorbereitung',
    emoji: '🍂',
    storeAway: [
      { keywords: /gartenmöbel|sonnenschirm|grill.?abdeckung/i, target: 'keller', reason: 'Vor Regen schützen' },
      { keywords: /sommerkleidung|shorts|tank.?top|leinen/i, target: 'schlafzimmer', reason: 'Platz für Winterkleidung' },
      { keywords: /sandalen|flip.?flop|leichte.?schuhe/i, target: 'keller', reason: 'Platz für Winterschuhe' },
    ],
    bringOut: [
      { keywords: /winterjacke|wintermantel|daunenjacke|parka/i, reason: 'Bald wird es kalt' },
      { keywords: /mütze|handschuh|schal/i, reason: 'Winteraccessoires griffbereit legen' },
      { keywords: /winterstiefel|schneestiefel/i, reason: 'Winterschuhe nach vorne' },
      { keywords: /wärmflasche|heizlüfter/i, reason: 'Wird bald gebraucht' },
    ],
    tip: 'Herbst-Tipp: Sommerkleidung die du nie getragen hast → direkt auf die Spendenliste.',
  },
  winter: {
    months: [12, 1, 2],
    label: 'Winter & Jahreswechsel',
    emoji: '❄️',
    storeAway: [],
    bringOut: [
      { keywords: /weihnachtsdeko|christbaum|lichterkette|adventskranz/i, reason: 'Weihnachtszeit!' },
    ],
    tip: 'Nach Weihnachten: Deko einpacken, Geschenke die du nicht brauchst → Spendenliste.',
    postChristmas: {
      months: [1, 2],
      storeAway: [
        { keywords: /weihnachtsdeko|christbaum|lichterkette|adventskranz|krippe/i, target: 'keller', reason: 'Bis nächstes Jahr einpacken' },
      ],
      tip: 'Neues Jahr, neuer Start: Was vom letzten Jahr noch unausgepackt im Schrank steht → brauchst du wahrscheinlich nicht.',
    },
  },
};

export function getCurrentSeason() {
  const month = new Date().getMonth() + 1;
  for (const [key, season] of Object.entries(SEASONAL_RULES)) {
    if (season.months.includes(month)) return { key, ...season };
  }
  return null;
}

function forEachActiveItem(containers, roomId, roomName, callback) {
  for (const [cId, container] of Object.entries(containers || {})) {
    for (const item of (container.items || [])) {
      const obj = typeof item === 'string' ? { name: item, status: 'aktiv' } : item;
      if (obj.status === 'archiviert') continue;
      callback(obj, cId, container.name);
    }
    if (container.containers) {
      forEachActiveItem(container.containers, roomId, roomName, callback);
    }
  }
}

export function getSeasonalRecommendations() {
  const season = getCurrentSeason();
  if (!season) return null;

  const data = Brain.getData();
  const results = {
    season: { label: season.label, emoji: season.emoji, key: season.key },
    storeAway: [],
    bringOut: [],
    tip: season.tip,
  };

  for (const [roomId, room] of Object.entries(data.rooms || {})) {
    const roomType = normalizeRoomType(room.name);
    const isStorage = ['keller', 'abstellraum', 'dachboden', 'garage'].includes(roomType);

    forEachActiveItem(room.containers, roomId, room.name, (item, containerId, containerName) => {
      const name = item.name || '';

      if (!isStorage) {
        for (const rule of season.storeAway) {
          if (rule.keywords.test(name)) {
            results.storeAway.push({
              itemName: name,
              roomId, roomName: room.name,
              containerId, containerName,
              targetRoomType: rule.target,
              reason: rule.reason,
            });
          }
        }
      }

      if (isStorage) {
        for (const rule of season.bringOut) {
          if (rule.keywords.test(name)) {
            results.bringOut.push({
              itemName: name,
              roomId, roomName: room.name,
              containerId, containerName,
              reason: rule.reason,
            });
          }
        }
      }
    });
  }

  // Post-Christmas (Januar/Februar)
  const month = new Date().getMonth() + 1;
  if (season.postChristmas && season.postChristmas.months.includes(month)) {
    for (const [roomId, room] of Object.entries(data.rooms || {})) {
      const roomType = normalizeRoomType(room.name);
      if (['keller', 'abstellraum', 'dachboden'].includes(roomType)) continue;

      forEachActiveItem(room.containers, roomId, room.name, (item, cId, cName) => {
        for (const rule of season.postChristmas.storeAway) {
          if (rule.keywords.test(item.name || '')) {
            results.storeAway.push({
              itemName: item.name,
              roomId, roomName: room.name,
              containerId: cId, containerName: cName,
              targetRoomType: rule.target,
              reason: rule.reason,
            });
          }
        }
      });
    }
    results.tip = season.postChristmas.tip;
  }

  return results;
}

// ── Lebensereignis-Erkennung ──────────────────────────

export function detectLifeEvents() {
  const data = Brain.getData();
  const events = [];
  const now = Date.now();
  const twoWeeks = 14 * 24 * 60 * 60 * 1000;

  // Count recently added rooms (last_updated within 14 days and close to creation)
  const recentRooms = Object.entries(data.rooms || {}).filter(([, room]) => {
    const updated = room.last_updated || 0;
    return (now - updated) < twoWeeks;
  });

  // Count recently archived items
  let recentArchives = 0;
  for (const room of Object.values(data.rooms || {})) {
    forEachArchivedItem(room.containers, (item) => {
      if (item.archived_at && (now - new Date(item.archived_at).getTime()) < twoWeeks) {
        recentArchives++;
      }
    });
  }

  // UMZUG: many new rooms + many archived items
  if (recentRooms.length >= 3 && recentArchives >= 5) {
    events.push({
      event: 'umzug',
      confidence: 'hoch',
      emoji: '📦',
      message: 'Sieht nach Umzug aus! Viele neue Räume und aussortierte Dinge.',
      suggestion: 'Soll ich einen Spendenbericht für die aussortierten Sachen erstellen?',
      action: 'generateDonationPDF',
    });
  }

  // BABY: baby-related items or Kinderzimmer
  const babyKeywords = /baby|wickel|kinderbett|stillkissen|schnuller|windel|fläschchen|strampler|kinderwagen|babyfon/i;
  let babyItemCount = 0;
  for (const room of Object.values(data.rooms || {})) {
    forEachActiveItem(room.containers, '', '', (item) => {
      if (babyKeywords.test(item.name || '')) babyItemCount++;
    });
  }
  const hasKinderzimmer = Object.values(data.rooms || {}).some(r =>
    normalizeRoomType(r.name) === 'kinderzimmer'
  );

  if (babyItemCount >= 3 || (hasKinderzimmer && babyItemCount >= 1)) {
    events.push({
      event: 'nachwuchs',
      confidence: babyItemCount >= 5 ? 'hoch' : 'mittel',
      emoji: '👶',
      message: 'Nachwuchs unterwegs? Ich sehe Baby-Sachen im Haushalt.',
      suggestion: 'Soll ich helfen Platz zu schaffen? Ich kann vorschlagen was woanders hin kann.',
      action: 'startCleanup',
    });
  }

  // ENTRÜMPELUNG: many archived items total
  const archived = getArchivedByReason();
  const archivedCount = archived.donated.length + archived.discarded.length + archived.sold.length;

  if (archivedCount >= 15) {
    events.push({
      event: 'entruempelung',
      confidence: 'mittel',
      emoji: '🧹',
      message: `Du hast ${archivedCount} Dinge aussortiert. Große Entrümpelung!`,
      suggestion: 'Soll ich eine Zusammenfassung erstellen was alles rausgegangen ist?',
      action: 'showArchiveSummary',
    });
  }

  // NEUER RAUM: single recently added room
  if (recentRooms.length === 1) {
    const newRoomName = recentRooms[0][1].name || '';
    events.push({
      event: 'neuer_raum',
      confidence: 'hoch',
      emoji: '🏠',
      message: `Neuer Raum: ${newRoomName}!`,
      suggestion: 'Soll ich Vorschläge machen was dort hingehört?',
      action: 'suggestForRoom',
    });
  }

  return events;
}

function forEachArchivedItem(containers, callback) {
  for (const container of Object.values(containers || {})) {
    for (const item of (container.items || [])) {
      if (typeof item !== 'string' && item.status === 'archiviert') {
        callback(item);
      }
    }
    if (container.containers) forEachArchivedItem(container.containers, callback);
  }
}

// ── Verbesserungs-Report ──────────────────────────────

export function getImprovementReport() {
  let history;
  try { history = JSON.parse(localStorage.getItem(SCORE_HISTORY_KEY) || '[]'); } catch { history = []; }

  const current = calculateFreedomIndex();
  const now = Date.now();
  const weekAgo = findClosestEntry(history, now - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = findClosestEntry(history, now - 30 * 24 * 60 * 60 * 1000);
  const threeMonthsAgo = findClosestEntry(history, now - 90 * 24 * 60 * 60 * 1000);

  let trend = 'stabil';
  if (weekAgo && current.percent > weekAgo.percent + 3) trend = 'aufwärts';
  if (weekAgo && current.percent < weekAgo.percent - 3) trend = 'abwärts';

  const milestones = [];

  if (threeMonthsAgo && current.percent - threeMonthsAgo.percent >= 10) {
    milestones.push({
      label: `+${current.percent - threeMonthsAgo.percent}% in 3 Monaten`,
      emoji: '🚀',
    });
  }

  const archived = getArchivedByReason();
  const totalRemoved = archived.donated.length + archived.discarded.length + archived.sold.length;
  if (totalRemoved >= 10) {
    milestones.push({ label: `${totalRemoved} Dinge aussortiert`, emoji: '🎯' });
  }
  if (archived.donated.length >= 5) {
    milestones.push({ label: `${archived.donated.length} Dinge gespendet`, emoji: '🎁' });
  }
  if (archived.sold.length >= 1) {
    milestones.push({ label: `${archived.sold.length} Dinge verkauft`, emoji: '💰' });
  }

  // Count total decisions from archived + moved items
  let totalDecisions = 0;
  for (const room of Object.values(Brain.getData().rooms || {})) {
    forEachArchivedItem(room.containers, () => { totalDecisions++; });
  }
  if (totalDecisions >= 20) {
    milestones.push({ label: `${totalDecisions} Entscheidungen getroffen`, emoji: '🧠' });
  }

  return {
    current: current.percent,
    weekAgo: weekAgo?.percent || null,
    monthAgo: monthAgo?.percent || null,
    threeMonthsAgo: threeMonthsAgo?.percent || null,
    trend,
    milestones,
    totalRemoved,
    totalDecisions,
  };
}

function findClosestEntry(history, targetTime) {
  if (history.length === 0) return null;

  let closest = null;
  let minDiff = Infinity;

  for (const entry of history) {
    const diff = Math.abs(new Date(entry.date).getTime() - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closest = entry;
    }
  }

  if (minDiff > 14 * 24 * 60 * 60 * 1000) return null;
  return closest;
}

// ── Aufräum-Quest Plan ─────────────────────────────────

function mapWinTypeToAction(winType) {
  switch (winType) {
    case 'move': return 'move';
    case 'decide': return 'decide';
    case 'consolidate': return 'consolidate';
    default: return 'optimize';
  }
}

/**
 * Erstellt einen Aufräum-Quest-Plan aus den aktuellen Quick Wins.
 * Sortiert nach Impact/Aufwand-Verhältnis.
 * @param {number} maxSteps - Maximale Schrittanzahl
 * @param {number} maxMinutes - Zeitlimit in Minuten
 * @returns {Array} Quest-Plan-Schritte
 */
export function buildCleanupPlan(maxSteps = 20, maxMinutes = 30) {
  const wins = getQuickWins(50);
  const plan = [];
  let totalMinutes = 0;

  for (const win of wins) {
    if (plan.length >= maxSteps) break;
    if (totalMinutes + win.estimatedMinutes > maxMinutes) continue;

    plan.push({
      step_number: plan.length + 1,
      status: 'pending',
      action_type: mapWinTypeToAction(win.type),
      item_name: win.itemName,
      from_room: win.roomId || (win.locations?.[0]?.roomId) || null,
      from_container: win.containerId || (win.locations?.[0]?.containerId) || null,
      to_room: win.suggestedRoom || null,
      to_container: null,
      reason: win.detail || win.description,
      priority: win.impactPoints >= 3 ? 'hoch'
              : win.impactPoints >= 2 ? 'mittel' : 'niedrig',
      estimated_minutes: win.estimatedMinutes,
      impact_points: win.impactPoints,
      archive_reason: null,
      disposal_guide: win.type === 'decide'
        ? getDisposalGuide(win.itemName) : null,
      locations: win.locations || null,
    });

    totalMinutes += win.estimatedMinutes;
  }

  return plan;
}
