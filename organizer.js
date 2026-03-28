// organizer.js – Der Aufräumassistent

import Brain from './brain.js';
import { analyzeContainerForOrganizing } from './ai.js';
import { ROOM_TYPES } from './app.js';

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

// ROOM_TYPE_LABELS derived from centralized ROOM_TYPES
const ROOM_TYPE_LABELS = Object.fromEntries(
  Object.entries(ROOM_TYPES).map(([k, v]) => [k, v.name])
);

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

export function normalizeRoomType(roomNameOrType) {
  const lower = (roomNameOrType || '').toLowerCase();
  for (const [type, config] of Object.entries(ROOM_TYPES)) {
    if (lower === type) return type;
    if (lower === config.name.toLowerCase()) return type;
    if (config.aliases.some(a => lower.includes(a))) return type;
  }
  return lower;
}

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
    suggestedRoomName: ROOM_TYPE_LABELS[classification.allowedRooms[0]] || classification.allowedRooms[0]
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
  const cache = JSON.parse(localStorage.getItem(RECOMMENDATION_CACHE_KEY) || '{}');
  const key = `${roomId}_${containerId}`;
  const entry = cache[key];
  if (!entry) return null;

  const age = Date.now() - new Date(entry.timestamp).getTime();
  if (age > 7 * 24 * 60 * 60 * 1000) return null;

  return entry.data;
}

function cacheRecommendations(roomId, containerId, data) {
  const cache = JSON.parse(localStorage.getItem(RECOMMENDATION_CACHE_KEY) || '{}');
  cache[`${roomId}_${containerId}`] = { data, timestamp: new Date().toISOString() };
  localStorage.setItem(RECOMMENDATION_CACHE_KEY, JSON.stringify(cache));
}

export function recordWeeklyScore() {
  const { percent } = calculateFreedomIndex();
  const history = JSON.parse(localStorage.getItem(SCORE_HISTORY_KEY) || '[]');
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
  const history = JSON.parse(localStorage.getItem(SCORE_HISTORY_KEY) || '[]');
  if (history.length < 2) return null;
  const current = history[history.length - 1];
  const previous = history[history.length - 2];
  return {
    delta: current.percent - previous.percent,
    previousPercent: previous.percent,
    currentPercent: current.percent
  };
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
