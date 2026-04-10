// ai.js – KI-Kommunikation, Prompts, Response-Parsing, Action-Ausführung
// Keinerlei direkter DOM-Zugriff. Importiert DOM-Funktionen aus anderen Modulen.
// Unterstützt Gemini (Standard), OpenAI und OpenRouter als Fallback-Provider.

import Brain from './brain.js';
import { debugLog, ensureRoom } from './app.js';

// ── Proxy Configuration ──────────────────────────────
const PROXY_URL = 'https://ordo-proxy.workers.dev';
// In der Entwicklung: 'http://localhost:8787'

// Kein client-seitiger Session-Header nötig — das Rate-Limiting
// läuft serverseitig über die IP-Adresse (CF-Connecting-IP).
// Der Client muss sich nicht identifizieren.

/**
 * Feuert wenn der Proxy die verbleibende Tages-Quota meldet.
 * Der Dialog kann dem Nutzer zeigen: "Noch 12 von 50 Anfragen heute"
 */
function _emitRemainingQuota(remaining) {
  try {
    window.dispatchEvent(new CustomEvent('ordo-proxy-quota', {
      detail: { remaining, limit: 50 },
    }));
  } catch { /* ignore */ }
}

// ── Provider Configuration ────────────────────────────
const PROVIDERS = {
  proxy: {
    name: 'ORDO Cloud',
    format: 'proxy',
    // Kein API-Key nötig — der Proxy hat ihn
  },
  gemini: {
    name: 'Google Gemini',
    // Key wird als Header gesendet, damit er nicht in der URL (History, Referer, Logs) landet.
    buildUrl: (model /*, apiKey */) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    format: 'gemini',
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    format: 'openai',
    models: { fast: 'gpt-4o-mini', pro: 'gpt-4o' },
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    format: 'openai',
    models: { fast: 'google/gemini-2.5-flash-preview', pro: 'google/gemini-2.5-pro-preview', lite: 'google/gemini-2.5-flash-lite' },
  },
};

export function getProviderConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem('ordo_providers') || 'null');
    if (stored) return stored;
  } catch { /* ignore */ }

  // Default: Hat der Nutzer einen eigenen Key?
  const hasOwnKey = !!localStorage.getItem('ordo_api_key');

  if (hasOwnKey) {
    return { primary: 'gemini', fallbacks: ['proxy'], keys: {} };
  }

  // Kein Key → Proxy als Primary (Zero-Key-Modus)
  return { primary: 'proxy', fallbacks: [], keys: {} };
}

export function setProviderConfig(config) {
  localStorage.setItem('ordo_providers', JSON.stringify(config));
}

export { PROVIDERS };

// ── Model Routing ─────────────────────────────────────
// Verfügbare Gemini-Modelle (Google AI Studio / gen-lang-client Projekt):
//
// 3.x  : gemini-3-flash-preview, gemini-3.1-pro-preview, gemini-3.1-flash-lite-preview
// 2.5  : gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite
//         gemini-2.5-pro-preview-tts, gemini-2.5-flash-preview-tts
// 2.0  : gemini-2.0-flash, gemini-2.0-flash-lite
// Alias: gemini-pro-latest, gemini-flash-latest, gemini-flash-lite-latest
// Spezial (nicht genutzt): gemini-robotics-er-1.5-preview, nano-banana, nano-banana-2, nano-banana-pro

const MODELS = {
  // ── Preview (neueste Generation) ──
  fast: 'gemini-3-flash-preview',           // neuestes Flash – Chat & Text
  pro: 'gemini-3.1-pro-preview',            // neuestes Pro – Foto/Video-Analyse, räumliche Tiefe
  lite: 'gemini-3.1-flash-lite-preview',    // neuestes Lite – einfache/schnelle Aufgaben, günstigster Preview

  // ── Stabil (GA-Modelle, zuverlässig) ──
  stableFast: 'gemini-2.5-flash',           // stabiles Flash – Fallback bei Überlastung
  stablePro: 'gemini-2.5-pro',              // stabiles Pro – Fallback bei Überlastung
  stableLite: 'gemini-2.5-flash-lite',      // stabiles Lite – günstigster Fallback

  // ── Legacy (bewährt, letzter Fallback) ──
  legacyFast: 'gemini-2.0-flash',           // 2.0 Flash – letzter Fallback, sehr stabil

  // ── TTS (Text-to-Speech) ──
  tts: 'gemini-2.5-flash-preview-tts',      // TTS Flash – Sprachausgabe (schnell, günstig)
  ttsPro: 'gemini-2.5-pro-preview-tts',     // TTS Pro – Sprachausgabe (höhere Qualität)
};

/**
 * Gibt true zurück wenn Preview-Modelle erwünscht sind.
 * Default: true → bisheriges Verhalten bleibt erhalten.
 */
export function usePreviewModels() {
  try {
    const val = localStorage.getItem('ordo_use_preview_models');
    return val === null ? true : val === 'true';
  } catch { return true; }
}

// Timeout für einzelne API-Requests (ms) – kurz genug um schnell zu fallbacken
const REQUEST_TIMEOUT_MS = 15000;
const VIDEO_TIMEOUT_MS = 60000; // Video-Analyse braucht länger

/**
 * Event: API antwortet langsam (nach 8s ohne Antwort).
 * Wird vom Dialog-Stream aufgefangen und dem Nutzer gezeigt.
 */
function _emitSlowWarning(model) {
  try {
    window.dispatchEvent(new CustomEvent('ordo-api-slow', { detail: { model } }));
  } catch { /* ignore */ }
}

/**
 * Event: Modell-Fallback wurde ausgelöst.
 * Informiert den Nutzer transparent über den Wechsel.
 */
function _emitModelFallback(requestedModel, usedModel) {
  try {
    window.dispatchEvent(new CustomEvent('ordo-model-fallback', {
      detail: { requestedModel, usedModel },
    }));
  } catch { /* ignore */ }
}

/**
 * Bestimmt das optimale Modell basierend auf dem Input.
 * @param {Object} options
 * @param {boolean} [options.hasImage] - Foto im Request
 * @param {boolean} [options.hasVideo] - Video im Request
 * @param {string} [options.taskType] - Art der Aufgabe
 * @returns {string} Modellname
 */
function determineModel({ hasImage = false, hasVideo = false, taskType = 'chat' } = {}) {
  const preview = usePreviewModels();

  // Multimodale Analyse (Foto/Video) → Pro-Klasse
  if (hasVideo || hasImage) return preview ? MODELS.pro : MODELS.stablePro;

  // Komplexe Textaufgaben → Pro-Klasse
  const PRO_TASKS = [
    'analyzeBlueprint',
    'analyzeReceipt',
    'batchEstimateValues',
    'containerCheck',
    'roomCheck',
    'householdCheck',
  ];
  if (PRO_TASKS.includes(taskType)) return preview ? MODELS.pro : MODELS.stablePro;

  // Einfache/kurze Aufgaben → Lite-Klasse
  const LITE_TASKS = ['analyzeHotspots', 'test'];
  if (LITE_TASKS.includes(taskType)) return preview ? MODELS.lite : MODELS.stableLite;

  // Chat & mittlere Textaufgaben → Flash-Klasse
  return preview ? MODELS.fast : MODELS.stableFast;
}

// ── Thinking Configuration ────────────────────────────
const THINKING_CONFIG = {
  chat: null,
  analyzeHotspots: null,
  test: null,
  analyzePhoto: { thinkingBudget: 512 },
  analyzeReceipt: { thinkingBudget: 512 },
  estimateValue: { thinkingBudget: 512 },
  analyzeBlueprint: { thinkingBudget: 2048 },
  batchEstimateValues: { thinkingBudget: 1024 },
  containerCheck: { thinkingBudget: 2048 },
  roomCheck: { thinkingBudget: 2048 },
  householdCheck: { thinkingBudget: 4096 },
  videoAnalysis: { thinkingBudget: 4096 },
};

function getThinkingConfig(taskType) {
  return THINKING_CONFIG[taskType] || null;
}

function buildGenerationConfig(options = {}) {
  const config = { maxOutputTokens: 8192 };
  const taskType = options.taskType || 'chat';

  // Chat: niedrigere temperature für schnellere, konsistentere Antworten
  if (taskType === 'chat') {
    config.temperature = 0.7;
  }

  const thinking = getThinkingConfig(taskType);
  if (thinking) {
    config.thinkingConfig = thinking;
  }
  return config;
}

// ── AI Response Sanitization ─────────────────────────
/**
 * Entfernt potenziell gefährliche HTML aus KI-Antworten.
 * Kein volles Escaping (würde Antwort unlesbar machen),
 * nur Script-Tags und Event-Handler.
 */
function sanitizeAIResponse(text) {
  if (!text) return '';
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\bhref\s*=\s*["']javascript:[^"']*["']/gi, '')
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\bon\w+\s*=\s*[^\s>"']+/gi, '')
    .replace(/\bon\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/<iframe\b[^>]*>.*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>.*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '');
}

// ── API Call Logging ──────────────────────────────────
function logApiCall(taskType, model, thinkingConfig, startTime) {
  const duration = Date.now() - startTime;
  const thinking = thinkingConfig ? `thinking:${thinkingConfig.thinkingBudget}` : 'no-thinking';
  console.log(`[ORDO API] ${taskType} → ${model} (${thinking}) → ${duration}ms`);
  try {
    const log = JSON.parse(localStorage.getItem('ordo_api_log') || '[]');
    log.push({ taskType, model, thinking, duration, timestamp: new Date().toISOString() });
    if (log.length > 50) log.splice(0, log.length - 50);
    localStorage.setItem('ordo_api_log', JSON.stringify(log));
  } catch(err) { console.warn('API-Log konnte nicht gespeichert werden:', err.message); }
}

// ── Loading Phase Definitions ─────────────────────────
const LOADING_PHASES = {
  chat: [
    { after: 0, text: 'Denke nach...' },
    { after: 3000, text: 'Formuliere Antwort...' },
  ],
  analyzePhoto: [
    { after: 0, text: 'Lade Foto hoch...' },
    { after: 2000, text: 'KI analysiert das Bild...' },
    { after: 5000, text: 'Gegenstände werden erkannt...' },
    { after: 9000, text: 'Positionen werden bestimmt...' },
    { after: 14000, text: 'Strukturiere Inventar-Daten...' },
    { after: 20000, text: 'Gleich fertig...' },
  ],
  analyzeHotspots: [
    { after: 0, text: 'Erkenne Gegenstände...' },
    { after: 2000, text: 'KI analysiert das Bild...' },
    { after: 5000, text: 'Positionen werden bestimmt...' },
    { after: 9000, text: 'Gleich fertig...' },
  ],
  analyzeBlueprint: [
    { after: 0, text: 'Lade Raumfotos hoch...' },
    { after: 3000, text: 'Ich schaue mir deine Wohnung an...' },
    { after: 6000, text: 'Räume werden erkannt...' },
    { after: 10000, text: 'Möbelstücke werden identifiziert...' },
    { after: 15000, text: 'Struktur wird aufgebaut...' },
    { after: 22000, text: 'Fast fertig — sortiere die Ergebnisse...' },
  ],
  analyzeReceipt: [
    { after: 0, text: 'Lese Kassenbon...' },
    { after: 2000, text: 'Suche Datum und Preis...' },
    { after: 5000, text: 'Extrahiere Details...' },
  ],
  videoAnalysis: [
    { after: 0, text: 'Video wird hochgeladen...' },
    { after: 5000, text: 'KI analysiert das Video...' },
    { after: 12000, text: 'Räume und Objekte werden erkannt...' },
    { after: 20000, text: 'Strukturiere die Ergebnisse...' },
    { after: 30000, text: 'Das dauert etwas bei großen Videos...' },
  ],
  batchEstimateValues: [
    { after: 0, text: 'Schätze Wiederbeschaffungswerte...' },
    { after: 3000, text: 'Analysiere Marktpreise...' },
    { after: 7000, text: 'Berechne Bandbreiten...' },
  ],
  estimateValue: [
    { after: 0, text: 'Schätze Wert...' },
    { after: 2000, text: 'Analysiere Marktpreis...' },
    { after: 5000, text: 'Gleich fertig...' },
  ],
  default: [
    { after: 0, text: 'Verarbeite...' },
    { after: 5000, text: 'Dauert etwas länger...' },
    { after: 15000, text: 'Gleich geschafft...' },
  ],
};

class LoadingManager {
  constructor() {
    this.timers = [];
    this.currentElement = null;
    this.active = false;
  }

  start(taskType, targetElement) {
    this.stop();
    this.currentElement = targetElement;
    this.active = true;
    const phases = LOADING_PHASES[taskType] || LOADING_PHASES.default;
    for (const phase of phases) {
      const timer = setTimeout(() => {
        if (!this.active) return;
        if (this.currentElement) {
          this.currentElement.textContent = phase.text;
        }
      }, phase.after);
      this.timers.push(timer);
    }
  }

  stop() {
    this.active = false;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
    this.currentElement = null;
  }
}

const loadingManager = new LoadingManager();

export { MODELS, determineModel, logApiCall, loadingManager };

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const FILE_API_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
export const FILE_API_GET_URL = 'https://generativelanguage.googleapis.com/v1beta/files';
export const MAX_VIDEO_DURATION_SEC = 300;
export const MAX_VIDEO_SIZE_MB = 200;

// ── Function Calling Declarations ─────────────────────
const ORDO_FUNCTIONS = [
  {
    name: "add_item",
    description: "Füge einen Gegenstand zu einem Container hinzu",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", description: "ID des Raums" },
        container_id: { type: "string", description: "ID des Containers" },
        item: { type: "string", description: "Name des Gegenstands" },
        menge: { type: "number", description: "Anzahl (default: 1)" }
      },
      required: ["room", "container_id", "item"]
    }
  },
  {
    name: "remove_item",
    description: "Entferne einen Gegenstand aus einem Container",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", description: "ID des Raums" },
        container_id: { type: "string", description: "ID des Containers" },
        item: { type: "string", description: "Name des Gegenstands" }
      },
      required: ["room", "container_id", "item"]
    }
  },
  {
    name: "remove_items",
    description: "Entferne mehrere Gegenstände aus einem Container",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", description: "ID des Raums" },
        container_id: { type: "string", description: "ID des Containers" },
        items: { type: "array", items: { type: "string" }, description: "Liste der Gegenstandsnamen" }
      },
      required: ["room", "container_id", "items"]
    }
  },
  {
    name: "move_item",
    description: "Verschiebe einen Gegenstand in einen anderen Container",
    parameters: {
      type: "object",
      properties: {
        from_room: { type: "string" },
        from_container_id: { type: "string" },
        item: { type: "string" },
        to_room: { type: "string" },
        to_container_id: { type: "string" }
      },
      required: ["from_room", "from_container_id", "item", "to_room", "to_container_id"]
    }
  },
  {
    name: "replace_items",
    description: "Ersetze alle Items in einem Container durch eine neue Liste",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string" },
        container_id: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              menge: { type: "number" }
            },
            required: ["name"]
          }
        }
      },
      required: ["room", "container_id", "items"]
    }
  },
  {
    name: "add_room",
    description: "Lege einen neuen Raum an",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", description: "Slugifizierte ID des Raums" },
        name: { type: "string", description: "Anzeigename des Raums" },
        emoji: { type: "string" }
      },
      required: ["room", "name"]
    }
  },
  {
    name: "add_container",
    description: "Lege einen neuen Container in einem Raum an",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string" },
        container_id: { type: "string", description: "Slugifizierte ID" },
        name: { type: "string" },
        typ: { type: "string", enum: ["schrank", "regal", "schublade", "kiste", "kommode", "sonstiges"] }
      },
      required: ["room", "container_id", "name"]
    }
  },
  {
    name: "delete_container",
    description: "Lösche einen Container",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string" },
        container_id: { type: "string" }
      },
      required: ["room", "container_id"]
    }
  },
  {
    name: "rename_container",
    description: "Benenne einen Container um",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string" },
        container_id: { type: "string" },
        new_name: { type: "string" }
      },
      required: ["room", "container_id", "new_name"]
    }
  },
  {
    name: "delete_room",
    description: "Lösche einen Raum",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string" }
      },
      required: ["room"]
    }
  },
  {
    name: "publish_to_kleinanzeigen",
    description: "Erstellt eine Verkaufsanzeige für einen Artikel auf Kleinanzeigen. Auslösen wenn der Nutzer einen Artikel verkaufen, loswerden oder inserieren möchte.",
    parameters: {
      type: "object",
      properties: {
        item: { type: "string", description: "Name des zu verkaufenden Artikels" },
        room: { type: "string", description: "ID des Raums wo der Artikel liegt (optional)" },
        container_id: { type: "string", description: "ID des Containers (optional)" }
      },
      required: ["item"]
    }
  },
  {
    name: "show_found_item",
    description: "Zeige dem Nutzer wo ein Gegenstand gefunden wurde",
    parameters: {
      type: "object",
      properties: {
        item: { type: "string", description: "Name des Gegenstands" },
        room: { type: "string", description: "Raum-ID" },
        container_id: { type: "string", description: "Container-ID" }
      },
      required: ["item", "room", "container_id"]
    }
  },
  {
    name: "show_view",
    description: "Zeige dem Nutzer eine bestimmte Ansicht/UI-View. Nutze dies wenn der Nutzer nach einer Übersicht, Ansicht, Karte, Bericht oder allen verfügbaren Ansichten fragt.",
    parameters: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["home", "showcase", "warranty", "expiry", "improvement", "map", "cleanup", "settings", "capabilities", "reports", "activity"],
          description: "Welche Ansicht gezeigt werden soll: home=Zuhause/Räume, showcase=Alle UI-Blöcke/Cards/Ansichten zeigen, warranty=Garantien, expiry=Verfallsdaten, improvement=Fortschritt, map=Grundriss/Karte, cleanup=Aufräumen, settings=Einstellungen, capabilities=Was kann ich, reports=Berichte, activity=Aktivität"
        }
      },
      required: ["view"]
    }
  }
];

// Convert a function call from Gemini to the internal ORDO action format
function functionCallToAction(call) {
  const args = call.args || {};
  switch (call.name) {
    case 'add_item':
      return { type: 'add_item', room: args.room, path: [args.container_id], item: args.item, menge: args.menge || 1 };
    case 'remove_item':
      return { type: 'remove_item', room: args.room, path: [args.container_id], item: args.item };
    case 'remove_items':
      return { type: 'remove_items', room: args.room, path: [args.container_id], items: args.items || [] };
    case 'move_item':
      return { type: 'move_item', from_room: args.from_room, from_path: [args.from_container_id], to_room: args.to_room, to_path: [args.to_container_id], item: args.item };
    case 'replace_items':
      return { type: 'replace_items', room: args.room, path: [args.container_id], items: (args.items || []).map(i => typeof i === 'string' ? { name: i, menge: 1 } : i) };
    case 'add_room':
      return { type: 'add_room', room: args.room, name: args.name, emoji: args.emoji };
    case 'add_container':
      return { type: 'add_container', room: args.room, path: [], id: args.container_id, name: args.name, typ: args.typ || 'sonstiges' };
    case 'delete_container':
      return { type: 'delete_container', room: args.room, path: [args.container_id] };
    case 'rename_container':
      return { type: 'rename_container', room: args.room, path: [args.container_id], new_name: args.new_name };
    case 'delete_room':
      return { type: 'delete_room', room: args.room };
    case 'publish_to_kleinanzeigen':
      return {
        type: 'publishToKleinanzeigen',
        itemName: call.args?.item || '',
        roomId: call.args?.room || null,
        containerId: call.args?.container_id || null,
      };
    case 'show_found_item':
      return { type: 'found', room: args.room, path: [args.container_id], item: args.item };
    case 'show_view': {
      const viewMap = {
        home: 'showHome', showcase: 'showBlockShowcase', warranty: 'showWarranty',
        expiry: 'showExpiry', improvement: 'showImprovement', map: 'showMap',
        cleanup: 'startCleanup', settings: 'showSettings', capabilities: 'showCapabilities',
        reports: 'showReports', activity: 'showActivity',
      };
      return { type: 'show_view', action: viewMap[args.view] || 'showHome' };
    }
    default:
      debugLog(`Unbekannter Function Call: ${call.name}`);
      return null;
  }
}

export { ORDO_FUNCTIONS, functionCallToAction };

// ── Gemini API ─────────────────────────────────────────
/**
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {Array<{role: string, content: string|Array}>} messages
 * @param {{tools?: Array, taskType?: string, hasImage?: boolean, hasVideo?: boolean}} [options]
 * @returns {Promise<string|{text: string, functionCalls: Array}>}
 */
export async function callGemini(apiKey, systemPrompt, messages, options = {}) {
  if (!navigator.onLine) {
    debugLog('FEHLER: Gerät ist offline (navigator.onLine = false)');
    const err = new Error('offline');
    err.debugInfo = { provider: 'keine', reason: 'Gerät ist offline (kein Internet)', timestamp: new Date().toISOString() };
    throw err;
  }

  // Determine provider chain: primary → fallbacks
  const providerCfg = getProviderConfig();
  const providerChain = [providerCfg.primary, ...providerCfg.fallbacks].filter(Boolean);
  if (providerChain.length === 0) providerChain.push('gemini');

  const debugDetails = [];
  let lastError = null;

  for (const providerId of providerChain) {
    const provider = PROVIDERS[providerId];
    if (!provider) continue;

    // Proxy braucht keinen API-Key
    if (provider.format === 'proxy') {
      try {
        const result = await _callProvider(providerId, provider, null, systemPrompt, messages, options);
        if (debugDetails.length > 0) {
          debugLog(`✓ Fallback erfolgreich: ${provider.name}`);
        }
        if (typeof result === 'object' && result !== null) {
          result._debugInfo = { provider: provider.name, fallbacksTrialled: debugDetails, timestamp: new Date().toISOString() };
        }
        return result;
      } catch (err) {
        // Rate-Limit? → Spezielle Behandlung, weiterwerfen
        if (err.message === 'rate_limit') {
          throw err;
        }
        debugDetails.push({ provider: provider.name, status: 'failed', error: err.message });
        lastError = err;
        debugLog(`✗ ${provider.name} fehlgeschlagen: ${err.message}`);
        continue;
      }
    }

    // Resolve API key: provider-specific key, or the main key for gemini
    const providerKey = providerCfg.keys?.[providerId] || (providerId === 'gemini' ? apiKey : '');
    if (!providerKey) {
      const skip = `${provider.name}: Kein API-Key konfiguriert – übersprungen`;
      debugLog(skip);
      debugDetails.push({ provider: provider.name, status: 'skipped', reason: 'Kein API-Key' });
      continue;
    }

    try {
      const result = await _callProvider(providerId, provider, providerKey, systemPrompt, messages, options);
      if (debugDetails.length > 0) {
        debugLog(`✓ Fallback erfolgreich: ${provider.name}`);
      }
      // Only attach debug info to object results (when tools are used);
      // string results (no tools) are returned as-is
      if (typeof result === 'object' && result !== null) {
        result._debugInfo = { provider: provider.name, fallbacksTrialled: debugDetails, timestamp: new Date().toISOString() };
      }
      return result;
    } catch (err) {
      const detail = {
        provider: provider.name,
        status: 'failed',
        error: err.message,
        httpStatus: err.httpStatus || null,
        timestamp: new Date().toISOString(),
      };
      debugDetails.push(detail);
      debugLog(`✗ ${provider.name} fehlgeschlagen: ${err.message}`);
      lastError = err;
    }
  }

  // All providers failed
  lastError = lastError || new Error('Kein Provider verfügbar');
  lastError.debugInfo = {
    providers: debugDetails,
    timestamp: new Date().toISOString(),
    totalProviders: providerChain.length,
    reason: providerChain.length > 1
      ? `Alle ${providerChain.length} Provider sind fehlgeschlagen`
      : `${PROVIDERS[providerChain[0]]?.name || providerChain[0]} ist nicht erreichbar`,
  };
  throw lastError;
}

// ── Provider-specific API call ────────────────────────
async function _callProvider(providerId, provider, apiKey, systemPrompt, messages, options) {
  if (provider.format === 'proxy') {
    return _callProxyFormat(systemPrompt, messages, options);
  }
  if (provider.format === 'openai') {
    return _callOpenAIFormat(provider, apiKey, systemPrompt, messages, options);
  }
  return _callGeminiFormat(apiKey, systemPrompt, messages, options);
}

// ── Proxy API call (ORDO Cloud) ─────────────────────
async function _callProxyFormat(systemPrompt, messages, options) {
  const model = determineModel(options);
  const genConfig = buildGenerationConfig(options);
  const startTime = Date.now();

  debugLog(`Proxy-Anfrage → Modell: ${model}, Task: ${options.taskType || 'chat'}`);

  // Proxy erwartet dasselbe Format wie Gemini,
  // nur an eine andere URL und ohne Key im Query-String.
  const geminiContents = messages.map(msg => {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof msg.content === 'string') {
      parts = [{ text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      parts = msg.content.map(item => {
        if (item.type === 'image') {
          return { inlineData: { mimeType: item.source.media_type, data: item.source.data } };
        } else if (item.type === 'file') {
          return { fileData: { fileUri: item.source.uri, mimeType: item.source.mimeType } };
        } else if (item.type === 'text') {
          return { text: item.text };
        }
        return { text: '' };
      });
    } else {
      parts = [{ text: String(msg.content) }];
    }
    return { role, parts };
  });

  const requestBody = {
    model,  // Der Proxy routet an das richtige Modell
    contents: geminiContents,
    generationConfig: genConfig,
  };

  // System-Prompt
  if (systemPrompt) {
    requestBody.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  // Tools (Function Calling)
  if (options.tools?.length > 0) {
    requestBody.tools = [{ functionDeclarations: options.tools }];
    requestBody.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  const controller = new AbortController();
  const effectiveTimeout = options.hasVideo ? VIDEO_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  let slowTimer = null;
  try {
    slowTimer = setTimeout(() => _emitSlowWarning(model), 8000);

    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Kein Session-Header — Rate-Limiting ist IP-basiert (CF-Connecting-IP)
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    // Rate-Limit-Header auswerten
    const remaining = response.headers.get('X-ORDO-Remaining');
    if (remaining !== null) {
      _emitRemainingQuota(parseInt(remaining));
    }

    // Rate-Limit erreicht?
    if (response.status === 429) {
      const errorData = await response.json();
      const err = new Error('rate_limit');
      err.rateLimitInfo = errorData;
      throw err;
    }

    if (!response.ok) {
      const err = new Error(`Proxy-Fehler: HTTP ${response.status}`);
      err.httpStatus = response.status;
      throw err;
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason ?? 'UNKNOWN';
    if (finishReason === 'SAFETY') throw new Error('safety_block');
    if (finishReason === 'MAX_TOKENS') throw new Error('max_tokens');

    const parts = candidate?.content?.parts || [];

    logApiCall(options.taskType || 'chat', model, null, startTime);
    debugLog(`Proxy-Antwort in ${Date.now() - startTime}ms`);

    // If function calling is enabled, return structured response
    if (options.tools) {
      const textParts = [];
      const functionCalls = [];
      for (const part of parts) {
        if (part.text) textParts.push(part.text);
        if (part.functionCall) functionCalls.push(part.functionCall);
      }
      const text = sanitizeAIResponse(textParts.join(''));
      return { text, functionCalls };
    }

    // Standard text-only response
    const text = sanitizeAIResponse(parts[0]?.text ?? '');
    if (!text) debugLog(`Warnung: Leere Proxy-Antwort. Volle Antwort: ${JSON.stringify(data).slice(0, 500)}`);
    return text;

  } finally {
    clearTimeout(timeoutId);
    if (slowTimer) clearTimeout(slowTimer);
  }
}

async function _callGeminiFormat(apiKey, systemPrompt, messages, options) {
  const model = determineModel(options);
  const genConfig = buildGenerationConfig(options);
  const thinkingCfg = getThinkingConfig(options.taskType || 'chat');
  const startTime = Date.now();

  const keyPreview = apiKey ? apiKey.slice(0, 4) + '…' : '(leer)';
  debugLog(`Anfrage starten → Modell: ${model}, Task: ${options.taskType || 'chat'}, Key: ${keyPreview}`);

  const geminiContents = messages.map(msg => {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof msg.content === 'string') {
      parts = [{ text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      parts = msg.content.map(item => {
        if (item.type === 'image') {
          return { inlineData: { mimeType: item.source.media_type, data: item.source.data } };
        } else if (item.type === 'file') {
          return { fileData: { fileUri: item.source.uri, mimeType: item.source.mimeType } };
        } else if (item.type === 'text') {
          return { text: item.text };
        }
        return { text: '' };
      });
    } else {
      parts = [{ text: String(msg.content) }];
    }
    return { role, parts };
  });

  // Retry with exponential backoff for 5xx/429 errors + model fallback
  const MAX_RETRIES = 2;
  const modelsToTry = [model];
  // Fallback-Kette: Preview → stabiles Modell → Legacy
  if (model === MODELS.pro) {
    modelsToTry.push(MODELS.fast, MODELS.stablePro, MODELS.stableFast);
  } else if (model === MODELS.stablePro) {
    modelsToTry.push(MODELS.stableFast, MODELS.legacyFast);
  } else if (model === MODELS.fast) {
    modelsToTry.push(MODELS.stableFast, MODELS.legacyFast);
  } else if (model === MODELS.lite) {
    modelsToTry.push(MODELS.stableLite, MODELS.legacyFast);
  } else if (model === MODELS.stableLite) {
    modelsToTry.push(MODELS.legacyFast);
  }

  for (const currentModel of modelsToTry) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Key wird als Header gesendet (siehe fetch-Call unten) – nicht in die URL hängen
      const apiUrl = `${API_BASE}/${currentModel}:generateContent`;
      const requestBody = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: geminiContents,
        generationConfig: genConfig
      };

      if (options.tools) {
        requestBody.tools = [{ functionDeclarations: options.tools }];
        requestBody.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      }

      let response;
      const controller = new AbortController();
      let timeoutId = null;
      let slowTimer = null;
      try {
        // Timeout: bricht den Request ab – Video-Analyse bekommt mehr Zeit
        const effectiveTimeout = options.hasVideo ? VIDEO_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

        // Feedback nach 8s: Nutzer informieren dass API langsam ist
        slowTimer = setTimeout(() => {
          _emitSlowWarning(currentModel);
        }, 8000);

        response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        clearTimeout(slowTimer);
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        clearTimeout(slowTimer);
        const isTimeout = fetchErr.name === 'AbortError';
        const usedTimeout = options.hasVideo ? VIDEO_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        debugLog(isTimeout
          ? `TIMEOUT nach ${usedTimeout / 1000}s (Modell: ${currentModel})`
          : `NETZWERK-FEHLER: ${fetchErr.message}`);
        // Bei Timeout: SOFORT nächstes Modell (nicht retrien — bringt nichts)
        if (isTimeout) {
          if (currentModel !== modelsToTry[modelsToTry.length - 1]) {
            debugLog(`${currentModel} Timeout – wechsle sofort zu ${modelsToTry[modelsToTry.indexOf(currentModel) + 1]}…`);
            break;
          }
          const err = new Error(`Alle Modelle nicht erreichbar (Timeout nach ${usedTimeout / 1000}s)`);
          err.httpStatus = 408;
          throw err;
        }
        // Netzwerk-Fehler: normal retrien
        if (attempt < MAX_RETRIES) {
          const wait = Math.pow(2, attempt + 1) * 1000;
          debugLog(`Retry ${attempt + 1}/${MAX_RETRIES} in ${wait / 1000}s…`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw fetchErr;
      }

      debugLog(`HTTP Status: ${response.status} ${response.statusText} (Modell: ${currentModel}, Versuch: ${attempt + 1})`);

      if (!response.ok) {
        const rawText = await response.text().catch(() => '');
        debugLog(`API Fehlerantwort: ${rawText.slice(0, 400)}`);

        // Non-retryable errors
        if (response.status === 403) { const e = new Error('api_key'); e.httpStatus = 403; e.responseBody = rawText.slice(0, 500); throw e; }
        // 400 INVALID_ARGUMENT: try next model (may be model-specific parameter issue)
        if (response.status === 400) {
          debugLog(`✗ ${currentModel} → 400 Bad Request`);
          if (currentModel !== modelsToTry[modelsToTry.length - 1]) {
            debugLog(`Wechsle zu ${modelsToTry[modelsToTry.indexOf(currentModel) + 1]}…`);
            break; // try next model
          }
          const e = new Error('bad_request'); e.httpStatus = 400; e.responseBody = rawText.slice(0, 500); throw e;
        }

        // Retryable errors (5xx, 429) – retry with backoff
        if (attempt < MAX_RETRIES && (response.status >= 500 || response.status === 429)) {
          const wait = Math.pow(2, attempt + 1) * 1000;
          debugLog(`${currentModel}: HTTP ${response.status} – Retry ${attempt + 1}/${MAX_RETRIES} in ${wait / 1000}s…`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        // Last retry failed – try next model if available, otherwise throw
        if (currentModel !== modelsToTry[modelsToTry.length - 1]) {
          debugLog(`${currentModel} nicht verfügbar (HTTP ${response.status}) – versuche ${modelsToTry[modelsToTry.indexOf(currentModel) + 1]}…`);
          break; // break retry loop, continue model loop
        }

        const err = new Error(response.status === 429 ? 'quota' : `HTTP ${response.status}`);
        err.httpStatus = response.status;
        err.responseBody = rawText.slice(0, 500);
        throw err;
      }

      // Success – parse response
      const data = await response.json();
      const candidate = data.candidates?.[0];
      const finishReason = candidate?.finishReason ?? 'UNKNOWN';
      if (finishReason === 'SAFETY') throw new Error('safety_block');
      if (finishReason === 'MAX_TOKENS') throw new Error('max_tokens');

      const parts = candidate?.content?.parts || [];

      logApiCall(options.taskType || 'chat', currentModel, thinkingCfg, startTime);

      const isStableFallback = currentModel === MODELS.stableFast || currentModel === MODELS.stablePro;
      if (currentModel !== model) {
        const fallbackNote = isStableFallback
          ? `⚠️ Stabiles Modell ${currentModel} verwendet (${model} war nicht erreichbar)`
          : `Hinweis: Fallback-Modell ${currentModel} verwendet (statt ${model})`;
        debugLog(fallbackNote);
        _emitModelFallback(model, currentModel);
      }

      // If function calling is enabled, return structured response
      if (options.tools) {
        const textParts = [];
        const functionCalls = [];
        for (const part of parts) {
          if (part.text) textParts.push(part.text);
          if (part.functionCall) functionCalls.push(part.functionCall);
        }
        const text = sanitizeAIResponse(textParts.join(''));
        debugLog(`Antwort OK – ${text.length} Zeichen, ${functionCalls.length} Function Calls, finishReason: ${finishReason}`);
        return { text, functionCalls };
      }

      // Standard text-only response
      const text = sanitizeAIResponse(parts[0]?.text ?? '');
      debugLog(`Antwort OK – ${text.length} Zeichen, finishReason: ${finishReason}`);
      if (!text) debugLog(`Warnung: Leere Antwort. Volle Antwort: ${JSON.stringify(data).slice(0, 500)}`);
      return text;
    }
  }

  // Should not reach here, but safety net
  const err = new Error('HTTP 503');
  err.httpStatus = 503;
  throw err;
}

// ── OpenAI-compatible API call (OpenAI, OpenRouter, etc.) ──
async function _callOpenAIFormat(provider, apiKey, systemPrompt, messages, options) {
  const modelKey = (options.hasImage || options.hasVideo) ? 'pro' : 'fast';
  const model = provider.models?.[modelKey] || provider.models?.fast;
  const startTime = Date.now();

  debugLog(`Anfrage starten → ${provider.name}, Modell: ${model}, Task: ${options.taskType || 'chat'}`);

  // Convert messages to OpenAI format
  const openaiMessages = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (typeof msg.content === 'string') {
      openaiMessages.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const parts = msg.content.map(item => {
        if (item.type === 'image') {
          return { type: 'image_url', image_url: { url: `data:${item.source.media_type};base64,${item.source.data}` } };
        } else if (item.type === 'text') {
          return { type: 'text', text: item.text };
        }
        return { type: 'text', text: '' };
      });
      openaiMessages.push({ role, content: parts });
    } else {
      openaiMessages.push({ role, content: String(msg.content) });
    }
  }

  const requestBody = { model, messages: openaiMessages, max_tokens: 8192 };

  let response;
  try {
    response = await fetch(provider.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
    });
  } catch (fetchErr) {
    debugLog(`NETZWERK-FEHLER (${provider.name}): ${fetchErr.message}`);
    throw fetchErr;
  }

  debugLog(`${provider.name} HTTP Status: ${response.status} ${response.statusText}`);

  if (!response.ok) {
    const rawText = await response.text().catch(() => '');
    debugLog(`${provider.name} Fehlerantwort: ${rawText.slice(0, 400)}`);
    const err = new Error(
      response.status === 429 ? 'quota' :
      response.status === 401 || response.status === 403 ? 'api_key' :
      response.status === 400 ? 'bad_request' :
      `HTTP ${response.status}`
    );
    err.httpStatus = response.status;
    err.responseBody = rawText.slice(0, 500);
    throw err;
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const text = sanitizeAIResponse(choice?.message?.content ?? '');

  logApiCall(options.taskType || 'chat', model, null, startTime);
  debugLog(`${provider.name} Antwort OK – ${text.length} Zeichen`);

  // Return in consistent format
  if (options.tools) {
    return { text, functionCalls: [] };
  }
  return text;
}

/**
 * Robuste JSON-Extraktion aus einer KI-Textantwort.
 * Frühere Aufrufer nutzten `/\{[\s\S]*\}/` (greedy): das bricht bei Antworten
 * mit mehreren JSON-Fragmenten (z.B. Code-Beispiel im Preamble + echte Antwort).
 * Diese Funktion strippt Code-Fences, probiert erst einen vollen Parse und
 * fällt dann auf einen Klammer-balancierten Scanner ab dem ersten `{` zurück.
 *
 * @param {string} text
 * @returns {any|null} geparstes Objekt/Array oder null
 */
export function extractJSON(text) {
  if (typeof text !== 'string' || !text) return null;
  const stripped = text.replace(/```(?:json)?/gi, '```').replace(/```/g, '').trim();
  // Optimistisch: komplette Antwort ist JSON
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  // Balancierten ersten JSON-Block ab erstem '{' oder '[' extrahieren
  const firstObj = stripped.indexOf('{');
  const firstArr = stripped.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) return null;
  const openChar = stripped[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) {
        const candidate = stripped.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

export function getErrorMessage(err) {
  if (err.message === 'offline') return 'Ich bin gerade offline. Deine gespeicherten Infos kann ich dir trotzdem zeigen.';
  if (err.message === 'api_key') return 'API Key ungültig oder abgelaufen. Bitte in den Einstellungen prüfen.';
  if (err.message === 'bad_request') return 'Anfrage ungültig – Foto zu groß oder falsches Format. Bitte ein anderes Foto versuchen.';
  if (err.message === 'quota') return 'Tageslimit der kostenlosen Google AI API erreicht (429). Bitte morgen wieder versuchen oder ein bezahltes Konto nutzen.';
  if (err.message === 'safety_block') return 'Das Foto wurde vom Sicherheitsfilter blockiert. Bitte ein anderes Foto versuchen.';
  if (err.message === 'max_tokens') return 'Antwort zu lang – bitte ein übersichtlicheres Foto wählen.';
  if (err.message === 'Kein JSON in Antwort') return 'Die KI hat keine auswertbare Antwort geliefert. Bitte nochmal versuchen.';
  if (err.message?.includes('Video zu groß')) return err.message;
  if (err.message?.includes('Video-Verarbeitung') || err.message?.includes('Timeout')) return err.message;
  if (err.message?.includes('too large') || err.message?.includes('size')) return 'Datei zu groß – bitte eine kleinere wählen oder Auflösung reduzieren.';
  if (err instanceof SyntaxError || err.message?.includes('JSON')) return 'Antwort war unvollständig – bitte nochmal versuchen.';
  if (err instanceof TypeError) return 'Keine Internetverbindung. Versuch es gleich nochmal.';
  if (err.message?.startsWith('HTTP 5')) return 'Der KI-Dienst ist gerade nicht erreichbar. Versuch es später.';
  return 'Kurze Verbindungsstörung – bitte nochmal versuchen.';
}

/**
 * Erstellt strukturierte Debug-Info für die Fehleranzeige im Chat.
 * @param {Error} err - Der aufgetretene Fehler
 * @returns {{message: string, details: string, hasDebug: boolean}}
 */
export function getErrorWithDebug(err) {
  const message = getErrorMessage(err);
  const info = err.debugInfo;

  // Even without debugInfo, show basic details for HTTP errors
  if (!info) {
    if (err.httpStatus) {
      const lines = [
        `HTTP ${err.httpStatus}`,
        `Retries: 2× mit Backoff (2s, 4s) versucht`,
      ];
      if (err.responseBody) lines.push(`Server: ${err.responseBody.slice(0, 200)}`);
      return { message, details: lines.join('\n'), hasDebug: true };
    }
    return { message, details: '', hasDebug: false };
  }

  const lines = [];
  lines.push(`Zeitpunkt: ${new Date(info.timestamp).toLocaleTimeString('de-DE')}`);

  if (info.reason) {
    lines.push(`Ursache: ${info.reason}`);
  }

  if (info.providers) {
    lines.push(`Getestete Provider: ${info.totalProviders}`);
    for (const p of info.providers) {
      const status = p.status === 'skipped' ? 'Übersprungen' : `HTTP ${p.httpStatus || '?'}`;
      lines.push(`  ${p.provider}: ${status} – ${p.reason || p.error || ''}`);
    }
    lines.push(`Retries: Je 2× mit Backoff (2s, 4s) + Modell-Fallback`);
  }

  if (info.provider && info.provider !== 'keine') {
    lines.push(`Provider: ${info.provider}`);
  }

  const providerCfg = getProviderConfig();
  const hasFallbacks = providerCfg.fallbacks.length > 0;
  if (!hasFallbacks) {
    lines.push('');
    lines.push('Tipp: Unter Einstellungen > API kannst du Fallback-Provider aktivieren (OpenAI, OpenRouter).');
  }

  return { message, details: lines.join('\n'), hasDebug: true };
}

// ── Loading State Helper ──────────────────────────────
/**
 * Wraps einen async Button-Handler mit Loading-State.
 * Verhindert Doppelklicks und zeigt visuelles Feedback.
 */
export function withLoading(buttonEl, asyncFn) {
  let running = false;
  return async function(...args) {
    if (running) return;
    running = true;
    const originalContent = buttonEl.innerHTML;
    buttonEl.disabled = true;
    buttonEl.classList.add('btn-loading');
    buttonEl.textContent = '⏳';
    try {
      return await asyncFn.apply(this, args);
    } catch (err) {
      console.error('Action failed:', err);
      throw err;
    } finally {
      running = false;
      buttonEl.disabled = false;
      buttonEl.classList.remove('btn-loading');
      buttonEl.innerHTML = originalContent;
    }
  };
}

export async function analyzeBlueprint(roomPhotos) {
  const apiKey = Brain.getApiKey();
  if (!apiKey) throw new Error('api_key');
  const safePhotos = Array.isArray(roomPhotos) ? roomPhotos.filter(p => p?.blob) : [];
  if (safePhotos.length === 0) throw new Error('Keine Fotos für Blueprint-Analyse');

  const labelHints = safePhotos
    .map((p, i) => (p.userLabel ? `Foto ${i}: Nutzer sagt "${p.userLabel}"` : ''))
    .filter(Boolean)
    .join('\n');

  const prompt = `
Du siehst ${safePhotos.length} Überblicksfotos einer Wohnung.
Jedes Foto zeigt einen anderen Raum aus der Türperspektive.

Analysiere ALLE Fotos und erstelle die komplette Struktur der Wohnung.

Identifiziere pro Raum:
1. Raumtyp und Name (Küche, Bad, Schlafzimmer, etc.)
2. Jedes sichtbare Möbelstück oder Aufbewahrungssystem
   (Schränke, Regale, Kommoden, Vitrinen, Sideboards...)
3. Erkennbare Unterteilungen wenn sichtbar
   (Türen, Schubladen, Fächer – nur wenn klar sichtbar)
4. Ungefähre Position des Möbels im Raum
   ("linke Wand", "neben dem Fenster", "gegenüber der Tür")

Ergänze für jeden Raum eine Liste der angrenzenden Räume (neighbors).
Beispiel: Die Küche grenzt an den Flur und das Wohnzimmer.

Antworte NUR mit JSON:
{
  "wohnung_typ": "Wohnung",
  "raeume": [
    {
      "foto_index": 0,
      "id": "kueche",
      "name": "Küche",
      "emoji": "🍳",
      "merkmale": "hell, Fenster zur Straße, Fliesenboden",
      "neighbors": ["flur", "wohnzimmer"],
      "moebel": [
        {
          "id": "kuechenzeile_ober",
          "name": "Oberschränke Küchenzeile",
          "typ": "schrank",
          "position": "linke Wand",
          "unterteilungen": ["3 Türen"],
          "prioritaet": "hoch"
        }
      ]
    }
  ],
  "zusammenfassung": "Zusammenfassung der Wohnung"
}

Regeln:
- "prioritaet" ist "hoch" für große Möbel mit viel Stauraum,
  "mittel" für kleinere, "niedrig" für offene Regale/Ablagen
- Ignoriere Infrastruktur (Heizkörper, Steckdosen, Lampen)
- Ignoriere Elektrogeräte die keine Aufbewahrung sind
  (Fernseher, Waschmaschine)
- Wenn du unsicher bist ob etwas ein Schrank oder ein
  Deko-Möbel ist, nimm es trotzdem auf
- IDs: Kleinbuchstaben, Unterstriche, eindeutig pro Wohnung
- Emojis: Verwende passende Raum-Emojis
${labelHints}
`.trim();

  // allSettled: ein einzelnes kaputtes Foto darf nicht die komplette Analyse abbrechen
  const settled = await Promise.allSettled(safePhotos.map(async p => {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(p.blob);
    });
    return { type: 'image', source: { media_type: p.blob.type || 'image/jpeg', data: base64 } };
  }));
  const images = settled
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
  if (images.length === 0) throw new Error('Keine der Fotos konnten gelesen werden.');

  const response = await callGemini(apiKey, 'Du antwortest ausschließlich mit validem JSON.', [
    { role: 'user', content: [{ type: 'text', text: prompt }, ...images] }
  ], { taskType: 'analyzeBlueprint', hasImage: true });

  const parsed = extractJSON(response);
  if (!parsed || typeof parsed !== 'object') throw new Error('Kein JSON in Antwort');
  parsed.raeume = Array.isArray(parsed.raeume) ? parsed.raeume : [];
  return parsed;
}

// ── Message Building ───────────────────────────────────
export function buildMessages(history, newUserText) {
  const msgs = [];
  let lastRole = null;
  for (const m of history) {
    if (m.role === lastRole && msgs.length > 0) {
      // Merge consecutive same-role messages instead of dropping
      const last = msgs[msgs.length - 1];
      last.content = last.content + '\n' + m.content;
    } else {
      msgs.push({ role: m.role, content: m.content });
      lastRole = m.role;
    }
  }
  if (newUserText) {
    if (lastRole === 'user') {
      msgs.push({ role: 'assistant', content: '…' });
    }
    msgs.push({ role: 'user', content: newUserText });
  }
  return msgs;
}

// ── UNIFIED ORDO MARKER SYSTEM ─────────────────────────
export function processMarkers(text) {
  const actions = [];
  const foundItems = [];

  let cleanText = text.replace(/<!--ORDO:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const marker = JSON.parse(jsonStr.trim());
      if (marker.type === 'found') {
        foundItems.push(marker);
      } else {
        actions.push(marker);
      }
    } catch (err) { debugLog(`ORDO-Marker ungültig: ${err.message} – ${jsonStr.slice(0, 100)}`); }
    return '';
  });

  cleanText = cleanText.replace(/<!--SAVE:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const action = JSON.parse(jsonStr.trim());
      const converted = convertLegacySaveToOrdo(action);
      if (converted) actions.push(converted);
    } catch (err) { debugLog(`Legacy-SAVE Marker ungültig: ${err.message}`); }
    return '';
  });

  cleanText = cleanText.replace(/<!--ACTION:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const action = JSON.parse(jsonStr.trim());
      const converted = convertLegacyActionToOrdo(action);
      if (converted) actions.push(converted);
    } catch (err) { debugLog(`Legacy-ACTION Marker ungültig: ${err.message}`); }
    return '';
  });

  cleanText = cleanText.replace(/<!--FOUND:([\s\S]*?)-->/g, (_, jsonStr) => {
    try {
      const item = JSON.parse(jsonStr.trim());
      if (item.room && item.container) {
        foundItems.push({ type: 'found', room: item.room, path: [item.container], item: item.item });
      }
    } catch (err) { debugLog(`Legacy-FOUND Marker ungültig: ${err.message}`); }
    return '';
  });

  return { cleanText: cleanText.trim(), actions, foundItems };
}

export function convertLegacySaveToOrdo(action) {
  switch (action.action) {
    case 'add_item':
      return { type: 'add_item', room: action.room, path: [action.container], item: action.item, menge: 1 };
    case 'move_item':
      return { type: 'move_item', from_room: action.from_room || action.room, from_path: [action.from_container || action.container], to_room: action.room, to_path: [action.container], item: action.item };
    case 'remove_item':
      return { type: 'remove_item', room: action.room, path: [action.container], item: action.item };
    case 'add_container':
      return { type: 'add_container', room: action.room, path: [], id: action.container, name: action.name || action.container, typ: action.typ || 'sonstiges' };
    default: return null;
  }
}

export function convertLegacyActionToOrdo(action) {
  switch (action.type) {
    case 'add_item':
      return { type: 'add_item', room: action.room, path: [action.container], item: action.item, menge: 1 };
    case 'remove_item':
      return { type: 'remove_item', room: action.room, path: [action.container], item: action.item };
    case 'move_item':
      return { type: 'move_item', from_room: action.from_room, from_path: [action.from_container], to_room: action.to_room, to_path: [action.to_container], item: action.item };
    case 'remove_items':
      return { type: 'remove_items', room: action.room, path: [action.container], items: action.items };
    case 'replace_items':
      return { type: 'replace_items', room: action.room, path: [action.container], items: (action.items || []).map(i => typeof i === 'string' ? { name: i, menge: 1 } : i) };
    case 'delete_container':
      return { type: 'delete_container', room: action.room, path: [action.container] };
    case 'rename_container':
      return { type: 'rename_container', room: action.room, path: [action.container], new_name: action.new_name };
    case 'delete_room':
      return { type: 'delete_room', room: action.room };
    case 'add_container':
      return { type: 'add_container', room: action.room, path: [], id: action.container, name: action.name || action.container, typ: action.typ || 'sonstiges' };
    default: return null;
  }
}

export function resolveContainerFromPath(roomId, path) {
  if (!path || path.length === 0) return null;
  return path[path.length - 1];
}

// ── normalizeOrdoAction – Action-Härtung gegen Prompt-Injection ──
const ALLOWED_FIELDS = {
  add_item:         ['type', 'room', 'path', 'item', 'menge'],
  remove_item:      ['type', 'room', 'path', 'item'],
  remove_items:     ['type', 'room', 'path', 'items'],
  replace_items:    ['type', 'room', 'path', 'items'],
  move_item:        ['type', 'from_room', 'from_path', 'to_room', 'to_path', 'item'],
  add_room:         ['type', 'room', 'name', 'emoji'],
  add_container:    ['type', 'room', 'path', 'id', 'name', 'typ'],
  delete_container: ['type', 'room', 'path'],
  rename_container: ['type', 'room', 'path', 'new_name'],
  delete_room:      ['type', 'room']
};

export function normalizeOrdoAction(raw) {
  // 1. Must be a non-null object with a string type
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;

  const type = raw.type.trim();

  // 5. Reject unknown types
  if (!ALLOWED_FIELDS[type]) return null;

  const allowed = ALLOWED_FIELDS[type];
  const result = { type };

  // 7. Only allow whitelisted fields
  for (const key of allowed) {
    if (key === 'type') continue;
    if (raw[key] === undefined) continue;

    let val = raw[key];

    // 2. Trim all string fields
    if (typeof val === 'string') {
      val = val.trim();
      if (!val) continue; // skip empty strings
    }

    // 3. Clean path arrays (remove empty strings)
    if (key === 'path' || key === 'from_path' || key === 'to_path') {
      if (Array.isArray(val)) {
        val = val.map(s => typeof s === 'string' ? s.trim() : s).filter(s => s !== '');
      } else {
        continue; // skip non-array paths
      }
    }

    // 3. Clean items arrays
    if (key === 'items' && Array.isArray(val)) {
      val = val.filter(item => {
        if (typeof item === 'string') return item.trim() !== '';
        if (typeof item === 'object' && item !== null) return true;
        return false;
      }).map(item => {
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'object' && item !== null) {
          const cleaned = {};
          if (typeof item.name === 'string') cleaned.name = item.name.trim();
          if (item.menge !== undefined) cleaned.menge = Math.max(1, parseInt(item.menge) || 1);
          return cleaned;
        }
        return item;
      });
    }

    // 4. Normalize menge to at least 1
    if (key === 'menge') {
      val = Math.max(1, parseInt(val) || 1);
    }

    result[key] = val;
  }

  // 6. Destructive action checks: target must exist
  if (type === 'delete_room') {
    if (!result.room || !Brain.getRoom(result.room)) return null;
  }
  if (type === 'delete_container') {
    const cId = resolveContainerFromPath(result.room, result.path);
    if (!result.room || !Brain.getRoom(result.room) || !cId || !Brain.getContainer(result.room, cId)) return null;
  }

  return result;
}

// ── Action Executor ────────────────────────────────────
export function executeOrdoAction(action) {
  try {
    // Validate destructive actions: target must exist
    if (action.type === 'delete_room' && !Brain.getRoom(action.room)) {
      debugLog(`Marker ignoriert: Raum "${action.room}" existiert nicht`);
      return;
    }
    if (action.type === 'delete_container') {
      const cId = resolveContainerFromPath(action.room, action.path);
      if (!Brain.getRoom(action.room) || !cId || !Brain.getContainer(action.room, cId)) {
        debugLog(`Marker ignoriert: Container "${cId}" in "${action.room}" existiert nicht`);
        return;
      }
    }

    const containerId = resolveContainerFromPath(action.room, action.path);

    const emitAction = (message) => {
      Brain._emit('actionExecuted', { type: action.type, message, success: true });
    };

    switch (action.type) {
      case 'add_item': {
        ensureRoom(action.room);
        if (containerId && !Brain.getContainer(action.room, containerId)) {
          Brain.addContainer(action.room, containerId, containerId, 'sonstiges');
        }
        if (containerId) {
          Brain.addItem(action.room, containerId, action.item);
          if (action.menge && action.menge > 1) {
            const data = Brain.getData();
            const c = Brain._findContainerInTree(data.rooms?.[action.room]?.containers, containerId);
            if (c) {
              if (!c.quantities) c.quantities = {};
              c.quantities[action.item] = action.menge;
              const itemObj = c.items.find(i => Brain.getItemName(i) === action.item);
              if (itemObj && typeof itemObj === 'object') itemObj.menge = action.menge;
              Brain.save(data);
            }
          }
          const c = Brain.getContainer(action.room, containerId);
          const r = Brain.getRoom(action.room);
          emitAction(`✓ ${action.item} → ${c?.name || containerId} (${r?.name || action.room})`);
        }
        break;
      }
      case 'remove_item': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        Brain.removeItem(action.room, containerId, action.item);
        emitAction(`✓ ${action.item} entfernt aus ${c?.name || containerId} (${r?.name || action.room})`);
        break;
      }
      case 'remove_items': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        (action.items || []).forEach(item => Brain.removeItem(action.room, containerId, item));
        emitAction(`✓ ${(action.items || []).length} Gegenstände entfernt aus ${c?.name || containerId} (${r?.name || action.room})`);
        break;
      }
      case 'move_item': {
        const fromId = resolveContainerFromPath(action.from_room, action.from_path);
        const toId = resolveContainerFromPath(action.to_room, action.to_path);
        if (!fromId || !toId) return;
        const fromC = Brain.getContainer(action.from_room, fromId);
        const toR = Brain.getRoom(action.to_room);
        const toC = Brain.getContainer(action.to_room, toId);
        if (!fromC || !toR || !toC) return;
        const fromR = Brain.getRoom(action.from_room);
        Brain.moveItemAcrossRooms(action.from_room, fromId, action.to_room, toId, action.item);
        emitAction(`✓ ${action.item} verschoben: ${fromR?.name || action.from_room} → ${toR?.name || action.to_room}`);
        break;
      }
      case 'replace_items': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        const data = Brain.getData();
        const roomData = data.rooms?.[action.room];
        if (!roomData) return;
        const cont = Brain._findContainerInTree(roomData.containers, containerId);
        if (cont) {
          cont.items = (action.items || []).map(i => {
            const name = typeof i === 'string' ? i : i.name;
            const menge = typeof i === 'object' ? Math.max(1, parseInt(i.menge) || 1) : 1;
            return Brain.createItemObject(name, { menge });
          });
          cont.quantities = {};
          (action.items || []).forEach(i => {
            if (typeof i === 'object' && i.menge > 1) {
              cont.quantities[i.name] = i.menge;
            }
          });
          Brain.save(data);
        }
        emitAction(`✓ Inhalt aktualisiert: ${c?.name || containerId} (${r?.name || action.room})`);
        break;
      }
      case 'add_room': {
        if (!Brain.getRoom(action.room)) {
          Brain.addRoom(action.room, action.name || action.room, action.emoji || '🏠');
        }
        emitAction(`✓ Neuer Raum: ${action.name || action.room}`);
        break;
      }
      case 'add_container': {
        ensureRoom(action.room);
        const parentId = action.path && action.path.length > 0 ? action.path[action.path.length - 1] : null;
        if (parentId && Brain.getContainer(action.room, parentId)) {
          Brain.addChildContainer(action.room, parentId, action.id, action.name || action.id, action.typ || 'sonstiges');
        } else {
          Brain.addContainer(action.room, action.id, action.name || action.id, action.typ || 'sonstiges');
        }
        const r = Brain.getRoom(action.room);
        emitAction(`✓ Neuer Bereich: ${action.name || action.id} (${r?.name || action.room})`);
        break;
      }
      case 'delete_container': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        const containerName = c.name;
        Brain.deleteContainer(action.room, containerId);
        emitAction(`✓ ${containerName} gelöscht (${r?.name || action.room})`);
        break;
      }
      case 'rename_container': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        const oldName = c.name;
        Brain.renameContainer(action.room, containerId, action.new_name);
        emitAction(`✓ ${oldName} umbenannt zu ${action.new_name} (${r?.name || action.room})`);
        break;
      }
      case 'delete_room': {
        const r = Brain.getRoom(action.room);
        if (!r) return;
        const roomName = r.name;
        Brain.deleteRoom(action.room);
        emitAction(`✓ Raum ${roomName} gelöscht`);
        break;
      }
    }
  } catch (err) { debugLog(`Aktion fehlgeschlagen: ${err.message}`); }
}

// ── Retry Fetch ────────────────────────────────────────
export async function fetchWithRetry(url, options, maxRetries = 3, label = 'Request') {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status === 400 || res.status === 403 || res.status === 404) return res;
      if (attempt < maxRetries && (res.status >= 500 || res.status === 429)) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        debugLog(`${label}: HTTP ${res.status} – Retry ${attempt + 1}/${maxRetries} in ${wait / 1000}s…`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < maxRetries) {
        const wait = Math.pow(2, attempt + 1) * 1000;
        debugLog(`${label}: Netzwerkfehler – Retry ${attempt + 1}/${maxRetries} in ${wait / 1000}s… (${err.message})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

export async function uploadVideoToGemini(apiKey, file, onProgress, abortSignal) {
  const sizeMB = file.size / (1024 * 1024);
  debugLog(`Video-Upload gestartet: ${file.name} (${sizeMB.toFixed(1)} MB, ${file.type})`);

  if (!file.size) {
    throw new Error('Video-Datei ist leer (0 Bytes).');
  }

  if (sizeMB > MAX_VIDEO_SIZE_MB) {
    throw new Error(`Video zu groß (${Math.round(sizeMB)} MB). Maximum: ${MAX_VIDEO_SIZE_MB} MB.`);
  }

  const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/mpeg', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska'];
  const mimeBase = (file.type || '').split(';')[0].trim().toLowerCase();
  if (!mimeBase || !SUPPORTED_VIDEO_TYPES.includes(mimeBase)) {
    throw new Error(`Video-Format nicht unterstützt: "${file.type || 'unbekannt'}". Unterstützt: MP4, WebM, OGG.`);
  }

  onProgress?.('upload', 0);

  debugLog('Starte resumable Upload-Session…');
  const startRes = await fetchWithRetry(FILE_API_URL, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': file.size,
      'X-Goog-Upload-Header-Content-Type': file.type,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { displayName: file.name } })
  }, 3, 'Upload-Start');

  if (!startRes.ok) {
    const errText = await startRes.text().catch(() => '');
    debugLog(`Upload-Start fehlgeschlagen: HTTP ${startRes.status} – ${errText}`);
    if (startRes.status === 400 || startRes.status === 403) throw new Error('api_key');
    throw new Error(`Upload-Start fehlgeschlagen: HTTP ${startRes.status} – ${errText}`);
  }

  const uploadUrl = startRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('Kein Upload-URL erhalten');
  debugLog('Upload-URL erhalten. Starte Chunk-Upload…');

  const CHUNK_SIZE = 8 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let offset = 0;

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    if (abortSignal?.aborted) throw new Error('aborted');

    const isLast = chunkIdx === totalChunks - 1;
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(offset, end);
    const command = isLast ? 'upload, finalize' : 'upload';

    debugLog(`Chunk ${chunkIdx + 1}/${totalChunks} senden (${(offset / 1024 / 1024).toFixed(1)}–${(end / 1024 / 1024).toFixed(1)} MB)…`);

    const chunkController = new AbortController();
    const chunkTimeout = setTimeout(() => chunkController.abort(), 120000);
    // Forward external abort to chunk controller
    const abortHandler = () => chunkController.abort();
    abortSignal?.addEventListener('abort', abortHandler, { once: true });
    let chunkRes;
    try {
      chunkRes = await fetchWithRetry(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': end - offset,
          'X-Goog-Upload-Offset': String(offset),
          'X-Goog-Upload-Command': command
        },
        body: chunkBlob,
        signal: chunkController.signal
      }, 4, `Chunk ${chunkIdx + 1}/${totalChunks}`);
    } catch (err) {
      clearTimeout(chunkTimeout);
      abortSignal?.removeEventListener('abort', abortHandler);
      if (abortSignal?.aborted) throw new Error('aborted');
      if (err.name === 'AbortError') throw new Error('Timeout beim Video-Upload – Verbindung zu langsam.');
      throw err;
    }
    clearTimeout(chunkTimeout);
    abortSignal?.removeEventListener('abort', abortHandler);

    if (!chunkRes.ok) {
      const errText = await chunkRes.text().catch(() => '');
      debugLog(`Chunk-Upload fehlgeschlagen: HTTP ${chunkRes.status} – ${errText}`);
      throw new Error(`Video-Upload fehlgeschlagen bei Chunk ${chunkIdx + 1}/${totalChunks}: HTTP ${chunkRes.status} – ${errText}`);
    }

    offset = end;
    const uploadPct = Math.round(((chunkIdx + 1) / totalChunks) * 45);
    onProgress?.('upload', uploadPct);

    if (isLast) {
      const uploadData = await chunkRes.json();
      debugLog(`Upload abgeschlossen. Response: ${JSON.stringify(uploadData).slice(0, 300)}`);
      const fileObj = uploadData.file;
      if (!fileObj?.name) throw new Error('Keine Datei-Referenz erhalten');

      // Caller über den hochgeladenen Filename informieren, damit sein Cleanup-Pfad
      // auch dann greift, wenn die nachfolgende Verarbeitung fehlschlägt oder
      // der Nutzer abbricht.
      const uploadedFileName = fileObj.name;
      onProgress?.('uploaded', 50, { fileName: uploadedFileName });

      // Hilfsfunktion: Bei Errors den Filename anhängen, damit der Caller weiß,
      // dass er aufräumen muss.
      const withFileName = (err) => {
        try { err.fileName = uploadedFileName; } catch { /* ignore */ }
        return err;
      };

      onProgress?.('processing', 50);
      debugLog(`Datei hochgeladen: ${uploadedFileName}. Warte auf Verarbeitung…`);

      let attempts = 0;
      const maxAttempts = 48; // 48 × 2.5s = 120s timeout
      let pollErrors = 0;

      // fileObj.name is e.g. "files/abc123" – strip "files/" prefix to avoid double "files/" in URL
      const fileId = uploadedFileName.startsWith('files/') ? uploadedFileName.slice(6) : uploadedFileName;

      while (attempts < maxAttempts) {
        if (abortSignal?.aborted) throw withFileName(new Error('aborted'));
        const pollUrl = `${FILE_API_GET_URL}/${fileId}`;
        debugLog(`Poll-URL: ${pollUrl}`);
        const checkRes = await fetchWithRetry(
          pollUrl,
          { headers: { 'x-goog-api-key': apiKey } }, 2, 'Status-Poll'
        );

        if (!checkRes.ok) {
          pollErrors++;
          const errText = await checkRes.text().catch(() => '');
          debugLog(`Status-Abfrage fehlgeschlagen: HTTP ${checkRes.status} – ${errText}`);
          if (pollErrors >= 5) throw withFileName(new Error(`Status-Abfrage fehlgeschlagen nach ${pollErrors} Fehlern: HTTP ${checkRes.status}`));
          await new Promise(r => setTimeout(r, 3000));
          attempts++;
          continue;
        }

        const checkData = await checkRes.json();
        const state = checkData.state;
        debugLog(`Poll #${attempts + 1}: state=${state}`);

        if (state === 'ACTIVE') {
          debugLog(`Datei bereit: ${checkData.uri}`);
          onProgress?.('ready', 100);
          return { fileUri: checkData.uri, mimeType: checkData.mimeType, fileName: uploadedFileName };
        }
        if (state === 'FAILED') {
          debugLog(`Verarbeitung fehlgeschlagen. Response: ${JSON.stringify(checkData).slice(0, 300)}`);
          throw withFileName(new Error('Video-Verarbeitung fehlgeschlagen. Bitte ein kürzeres Video versuchen.'));
        }

        attempts++;
        const progress = 50 + Math.min(45, (attempts / maxAttempts) * 45);
        onProgress?.('processing', progress);
        await new Promise(r => setTimeout(r, 2500));
      }

      throw withFileName(new Error('Video-Verarbeitung dauert zu lange (Timeout nach 120 s). Bitte ein kürzeres Video versuchen oder stattdessen einzelne Fotos verwenden.'));
    }
  }
}

export async function deleteGeminiFile(apiKey, fileName) {
  try {
    const fileId = fileName.startsWith('files/') ? fileName.slice(6) : fileName;
    await fetch(`${FILE_API_GET_URL}/${fileId}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': apiKey },
    });
  } catch (err) { debugLog(`Gemini-Datei löschen fehlgeschlagen: ${err.message}`); }
}

// ── Valuation ─────────────────────────────────────────

// Batch estimate replacement values for items without price (text-only, no photos)
export async function batchEstimateValues(apiKey, items) {
  if (!items || items.length === 0) return [];

  const CHUNK_SIZE = 100;
  const allResults = [];

  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const itemList = chunk.map(item =>
      `- ${item.name}${item.menge > 1 ? ` (${item.menge}x)` : ''} – ${item.roomName} > ${item.containerName}`
    ).join('\n');

    const prompt = `Du bist ein Versicherungsberater. Schätze den Wiederbeschaffungswert (Neupreis in Deutschland, 2026) für folgende Haushaltsgegenstände.

Antworte NUR mit JSON-Array:
[
  {
    "name": "Exakter Name wie in der Liste",
    "replacement_value": Zahl,
    "replacement_range": [min, max],
    "confidence": "hoch" | "mittel" | "niedrig"
  }
]

Regeln:
- Neupreis = Was kostet ein vergleichbares Produkt heute neu im deutschen Einzelhandel?
- Bei Mengenangaben (z.B. "5x Teller"): Einzelpreis angeben, nicht Gesamtpreis
- Bei Kleinkram < 3€: replacement_value: 0
- Wenn du keine sinnvolle Schätzung machen kannst: replacement_value: null
- Sei konservativ – lieber etwas höher schätzen

Gegenstände:
${itemList}`;

    const messages = [{ role: 'user', content: prompt }];
    const raw = await callGemini(apiKey, 'Du bist ein Versicherungsberater für Hausratversicherungen. Antworte nur mit JSON.', messages, { taskType: 'batchEstimateValues' });

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        allResults.push(...parsed);
      } catch(err) { console.warn('Wertschätzungs-Chunk konnte nicht geparst werden:', err.message); }
    }
  }

  return allResults;
}

// Estimate single item value using container photo
export async function estimateSingleItemValue(apiKey, imageBase64, itemName) {
  const prompt = `Du siehst ein Foto eines Aufbewahrungsorts. Darin befindet sich: "${itemName}".

Schätze den Wiederbeschaffungswert (Neupreis heute in Euro) für diesen Gegenstand.

Antworte NUR mit JSON:
{
  "replacement_value": Zahl oder null,
  "replacement_range": [min, max] oder null,
  "brand_model": "Erkannte Marke/Modell" oder null,
  "confidence": "hoch" | "mittel" | "niedrig"
}

Regeln:
- Wenn du Marke/Modell erkennen kannst, nenne sie
- Gib immer eine Bandbreite an
- Bei Kleinkram unter 5€ → null
- Wenn unsicher → replacement_value: null`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ]
  }];

  const response = await callGemini(apiKey, 'Du bist ein Wertgutachter. Antworte nur mit JSON.', messages, { taskType: 'estimateValue', hasImage: true });
  const parsed = extractJSON(response);
  if (!parsed) throw new Error('Kein JSON in Antwort');
  return parsed;
}

// ── Receipt Analysis ──────────────────────────────────
export async function analyzeReceipt(apiKey, imageBase64, itemName) {
  const prompt = `Du siehst ein Foto eines Kassenbons oder einer Rechnung.
Extrahiere folgende Informationen soweit erkennbar:

1. Kaufdatum
2. Gesamtbetrag oder Einzelpreis für "${itemName}" falls sichtbar
3. Name des Geschäfts / Händlers
4. Garantiehinweise falls auf dem Bon sichtbar

Antworte NUR mit JSON:
{
  "date": "YYYY-MM-DD" oder null,
  "price": Zahl oder null,
  "store": "Name" oder null,
  "warranty_hint": "Text" oder null,
  "confidence": "hoch" | "mittel" | "niedrig",
  "hinweis": "Freitext falls etwas unklar ist"
}

Wenn du das Datum nicht im Format YYYY-MM-DD lesen kannst,
gib es so an wie du es liest und setze confidence auf "niedrig".
Wenn der Bon unleserlich oder verblasst ist, sag das im Hinweis.
Wenn das Foto kein Kassenbon ist, antworte mit:
{ "error": "Das sieht nicht nach einem Kassenbon aus." }`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ]
  }];

  const response = await callGemini(apiKey, 'Du bist ein Kassenbon-Scanner. Antworte nur mit JSON.', messages, { taskType: 'analyzeReceipt', hasImage: true });

  const parsed = extractJSON(response);
  if (!parsed) throw new Error('Kein JSON in Antwort');
  return parsed;
}

// ── Expiry Date Detection ────────────────────────────
/**
 * Liest ein Verfallsdatum von einem Foto einer Verpackung.
 * @param {string} apiKey
 * @param {string} imageBase64
 * @returns {Promise<{ date: string, type: string, confidence: string, raw_text: string }|null>}
 */
export async function detectExpiryDate(apiKey, imageBase64) {
  const prompt = `Lies das Verfallsdatum / Mindesthaltbarkeitsdatum von diesem Foto einer Verpackung.

Suche nach:
- "MHD" oder "mindestens haltbar bis" (Lebensmittel)
- "Verwendbar bis" oder "EXP" (Medikamente)
- PAO-Symbol (offener Tiegel) mit Monatszahl (Kosmetik)
- "Best before" / "Use by" (englische Produkte)

Antworte NUR mit JSON:
{
  "date": "2026-09-15",
  "type": "lebensmittel",
  "confidence": "hoch",
  "raw_text": "MHD: 15.09.2026"
}

Typen: "lebensmittel", "medikament", "kosmetik", "sonstiges"
Datumsformat: YYYY-MM-DD (oder YYYY-MM wenn kein Tag erkennbar)

Wenn du kein Verfallsdatum findest:
{ "date": null, "confidence": "nicht_gefunden" }`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ]
  }];

  try {
    const response = await callGemini(apiKey, 'Du bist ein Verfallsdaten-Scanner. Antworte nur mit JSON.', messages, { taskType: 'analyzeReceipt', hasImage: true });
    const parsed = extractJSON(response);
    return parsed && parsed.date ? parsed : null;
  } catch {
    return null;
  }
}

// ── Organizer: Container Check ───────────────────────
/**
 * Analysiert einen Container mit Foto + Haushaltsdaten.
 * Nutzt Gemini Pro mit Thinking für gründliche Bewertung.
 * @returns {Promise<{score: number, summary: string, recommendations: Array, ok_items?: string[], estimated_total_minutes?: number}>}
 */
export async function analyzeContainerForOrganizing(imageBase64, containerContext, householdSummary) {
  const prompt = `
Du bist ein freundlicher, erfahrener Aufräumberater.
Du analysierst einen Container in einem Haushalt.

CONTAINER: ${containerContext.containerName} in ${containerContext.roomName}
CONTAINER-TYP: ${containerContext.containerType}

AKTUELLER INHALT (aus der Datenbank):
${containerContext.itemList}

GESAMTER HAUSHALT (Zusammenfassung):
${householdSummary}

BEWERTUNGSKRITERIEN:
1. Funktionszone: Gehört jeder Gegenstand in diesen Raum?
2. Nutzungshäufigkeit: Sind oft genutzte Dinge griffbereit?
3. Duplikate: Gibt es den gleichen Gegenstand woanders?
4. Alter: Gegenstände seit 12+ Monaten nicht bestätigt?
5. Füllstand: Überladen oder Platz verschwendet?
6. Zustand: Erkennbar kaputte oder veraltete Gegenstände?

TONALITÄT: Freundlich, ermutigend, nie belehrend.
Statt "Das gehört nicht hierhin" → "Im Flur wäre das praktischer".
Der Nutzer hat immer das letzte Wort.

Antworte NUR mit JSON:
{
  "score": 7,
  "summary": "Ermutigendes Statement in 1-2 Sätzen",
  "recommendations": [
    {
      "type": "move",
      "item": "Winterhandschuhe",
      "reason": "Im Flur greifst du sie morgens direkt beim Rausgehen",
      "target_room": "flur",
      "target_container": "garderobe",
      "priority": "hoch",
      "estimated_minutes": 2
    }
  ],
  "ok_items": ["Teller", "Schüsseln", "Gläser"],
  "estimated_total_minutes": 10
}`;

  const apiKey = Brain.getApiKey();
  if (!apiKey) throw new Error('api_key');

  const response = await callGemini(
    apiKey,
    'Du bist ein Aufräumassistent. Antworte nur mit JSON.',
    [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt }
      ]
    }],
    { taskType: 'containerCheck', hasImage: true }
  );

  const parsed = extractJSON(response);
  if (!parsed) throw new Error('Kein JSON in Antwort');
  return parsed;
}

/**
 * Generiert Verkaufstexte für mehrere Items in einem Call.
 * @param {Array<{ name, value, category, roomName }>} items
 * @returns {Array<{ index, title, description, suggested_price, price_reasoning }>}
 */
export async function generateSalesTexts(items) {
  if (items.length === 0) return [];

  const apiKey = Brain.getApiKey();
  if (!apiKey) throw new Error('api_key');

  const itemList = items.map((item, i) =>
    `${i + 1}. ${item.name}, Geschätzter Neupreis: ${item.value ? item.value + '€' : 'unbekannt'}, Herkunft: ${item.roomName}`
  ).join('\n');

  const prompt = `
Erstelle für folgende Gegenstände jeweils einen Verkaufstext
für eBay Kleinanzeigen / Vinted / Flohmarkt.

${itemList}

Pro Gegenstand antworte mit JSON:
{
  "items": [
    {
      "index": 1,
      "title": "Kurzer Verkaufstitel (max 50 Zeichen)",
      "description": "Ansprechende Beschreibung (3-5 Sätze). Ehrlich, freundlich, ohne Übertreibung.",
      "suggested_price": 35,
      "price_reasoning": "Gebrauchtpreis ca. 40-60% vom Neupreis"
    }
  ]
}

Regeln:
- Preise realistisch (40-60% vom Neupreis für guten Zustand)
- Beschreibung nennt Zustand ehrlich
- Keine Marken-Claims die du nicht kennst
- Titel kurz und suchmaschinenfreundlich
- Antworte NUR mit JSON
`;

  const result = await callGemini(apiKey, 'Antworte nur mit JSON.', [
    { role: 'user', content: prompt }
  ], { taskType: 'batchEstimateValues' });

  try {
    const parsed = extractJSON(result);
    return parsed?.items || [];
  } catch {
    console.warn('Verkaufstext-Parsing fehlgeschlagen');
    return [];
  }
}

// ── Gemini Multimodal Live API (WebSocket Audio Streaming) ──────

const LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const LIVE_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/**
 * GeminiLiveSession – bidirektionale Audio-Session mit Gemini Live API.
 *
 * Flow:
 * 1. connect(apiKey, systemPrompt) → WebSocket öffnen, Setup senden
 * 2. Mikrofon-Audio wird auf 16kHz PCM16 resampelt und als realtime_input gesendet
 * 3. Server antwortet mit Audio-Chunks (PCM16 24kHz) via serverContent
 * 4. Audio-Chunks werden dekodiert und über AudioContext abgespielt
 * 5. Unterbrechungen werden nativ von der API behandelt (interrupted=true)
 *
 * Events (Callbacks):
 *   onStateChange(state)       – 'connecting' | 'connected' | 'listening' | 'responding' | 'disconnected'
 *   onTranscript(text, role)   – Text-Transkript vom Server (falls vorhanden)
 *   onError(message)           – Fehlermeldung
 *   onActivityDetected()       – Audio-Aktivität erkannt (für Idle-Timer)
 */
export class GeminiLiveSession {
  constructor() {
    this.ws = null;
    this.micStream = null;
    this.audioContext = null;
    this.playbackContext = null;
    this.micProcessor = null;
    this.state = 'disconnected';

    // Callbacks
    this.onStateChange = null;
    this.onTranscript = null;
    this.onError = null;
    this.onActivityDetected = null;
    this.onFunctionCall = null; // (call) => Promise<result>

    // Audio playback queue
    this._playbackQueue = [];
    this._isPlaying = false;
    this._currentSource = null;

    // VAD for idle detection
    this._vadAnalyser = null;
    this._vadInterval = null;
  }

  async connect(apiKey, systemPrompt, options = {}) {
    if (this.ws) this.disconnect();
    this._tools = options.tools || null;

    this._setState('connecting');

    try {
      // 1. Mikrofon-Zugriff (mit differenzierter Fehlerbehandlung)
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
      } catch (micErr) {
        if (micErr.name === 'NotAllowedError') {
          throw new Error('Mikrofon-Zugriff wurde verweigert. Bitte erlaube den Zugriff in den Browser-Einstellungen.');
        } else if (micErr.name === 'NotFoundError') {
          throw new Error('Kein Mikrofon gefunden.');
        }
        throw new Error(`Mikrofon-Fehler: ${micErr.message}`);
      }

      // 2. WebSocket öffnen (mit sauberem Timeout)
      // Browser-WebSockets unterstützen keine custom Headers – hier bleibt der
      // Key zwangsläufig im URL-Query. Die Verbindung erfolgt über WSS (TLS),
      // sodass der Key auf der Leitung geschützt ist; in Referer/History taucht
      // er nicht auf, weil WebSockets keine Referer senden.
      const url = `${LIVE_WS_URL}?key=${encodeURIComponent(apiKey)}`;
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer'; // Gemini sendet JSON als Binary-Frames

      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error('Verbindungs-Timeout (10s)')); }
        }, 10000);
        this.ws.onopen = () => {
          if (!settled) { settled = true; clearTimeout(timer); resolve(); }
        };
        this.ws.onerror = () => {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error('WebSocket-Verbindung fehlgeschlagen')); }
        };
      });

      // 3. Setup mit System-Prompt und Audio-Konfiguration
      //    Server erwartet "setup" als Top-Level-Key (nicht "config")
      const setupPayload = {
        setup: {
          model: `models/${LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Aoede' }
              }
            }
          },
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          }
        }
      };

      // Tools für Function Calling (z.B. Räume anlegen, Items verwalten)
      // HINWEIS: outputAudioTranscription und Tools zusammen verursachen
      // 1011-Fehler (bekannter Gemini-Bug). Daher nur eins von beiden.
      if (this._tools && this._tools.length > 0) {
        setupPayload.setup.tools = [{
          functionDeclarations: this._tools
        }];
      } else {
        // Transkription nur ohne Tools aktivieren
        setupPayload.setup.outputAudioTranscription = {};
      }

      this.ws.send(JSON.stringify(setupPayload));

      // 4. Auf Setup-Bestätigung warten (mit sauberem Timeout)
      //    Fängt: setupComplete, data.error UND vorzeitiges WebSocket-Close ab.
      await new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          clearTimeout(timer);
          this.ws?.removeEventListener('message', onMsg);
          this.ws?.removeEventListener('close', onClose);
        };

        const settle = (fn, val) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn(val);
        };

        const timer = setTimeout(() => {
          settle(reject, new Error('Setup-Timeout (15s) – keine Bestätigung vom Server. Prüfe Modell und API-Key.'));
        }, 15000);

        const onMsg = async (event) => {
          // Datentyp erkennen und zu String konvertieren (String, ArrayBuffer oder Blob)
          let text;
          const dtype = typeof event.data;
          try {
            if (dtype === 'string') {
              text = event.data;
            } else if (event.data instanceof ArrayBuffer) {
              text = new TextDecoder().decode(event.data);
            } else if (event.data instanceof Blob) {
              text = await event.data.text();
            } else {
              text = String(event.data);
            }
          } catch (decodeErr) {
            settle(reject, new Error(`Kann Server-Nachricht nicht dekodieren (${dtype}): ${decodeErr.message}`));
            return;
          }
          debugLog(`[Live] Setup-Raw (${dtype}, ${event.data?.byteLength ?? event.data?.size ?? '?'} bytes): ${text.substring(0, 500)}`);

          try {
            const data = JSON.parse(text);

            if (data.setupComplete) {
              settle(resolve, undefined);
              return;
            }

            if (data.error) {
              const errMsg = data.error.message || data.error.status || JSON.stringify(data.error);
              settle(reject, new Error(`Server-Fehler: ${errMsg}`));
              return;
            }

            // Unbekannte JSON-Struktur – loggen aber weiter warten
            debugLog(`[Live] Setup: Unbekannte Nachricht: ${JSON.stringify(data).substring(0, 300)}`);
          } catch {
            settle(reject, new Error(`Unerwartete Server-Antwort (kein JSON): ${text.substring(0, 300)}`));
          }
        };

        const onClose = (event) => {
          const reason = event.reason || `Code ${event.code}`;
          debugLog(`[Live] WebSocket während Setup geschlossen: code=${event.code} reason=${event.reason || 'keine'}`);
          settle(reject, new Error(`WebSocket geschlossen vor Setup-Bestätigung (${reason})`));
        };

        this.ws.addEventListener('message', onMsg);
        this.ws.addEventListener('close', onClose);
      });

      // 5. Nachrichten-Handler einrichten
      this.ws.onmessage = (event) => this._handleMessage(event).catch(err => {
        debugLog(`[Live] Nachrichten-Verarbeitung fehlgeschlagen: ${err.message}`);
        this.onError?.('Nachrichtenfehler: ' + err.message);
      });
      this.ws.onclose = (event) => {
        debugLog(`[Live] WebSocket geschlossen: code=${event.code} reason=${event.reason || 'keine'}`);
        if (this.state !== 'disconnected') {
          // Code 1000 = normaler Schluss, alles andere ist unerwartet
          if (event.code !== 1000) {
            this.onError?.(`Verbindung getrennt (Code ${event.code})`);
          }
          this.disconnect();
        }
      };
      this.ws.onerror = (event) => {
        debugLog(`[Live] WebSocket-Fehler: ${event?.message || 'unbekannt'}`);
        this.onError?.('WebSocket-Fehler');
        this.disconnect();
      };

      // 6. Audio-Capture starten
      await this._startAudioCapture();

      // 7. Playback-Context erstellen und sicherstellen dass er läuft
      this.playbackContext = new AudioContext({ sampleRate: 24000 });
      if (this.playbackContext.state === 'suspended') {
        await this.playbackContext.resume();
      }

      this._setState('listening');

    } catch (err) {
      this.onError?.(err.message || 'Verbindung fehlgeschlagen');
      this.disconnect();
    }
  }

  disconnect() {
    this._setState('disconnected');

    // Mikrofon stoppen
    if (this.micStream) {
      this.micStream.getTracks().forEach(t => t.stop());
      this.micStream = null;
    }

    // Audio-Processor trennen
    if (this.micProcessor) {
      if (this.micProcessor.port) this.micProcessor.port.onmessage = null;
      this.micProcessor.disconnect();
      this.micProcessor = null;
    }

    // Audio-Contexts schließen
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    if (this.playbackContext && this.playbackContext.state !== 'closed') {
      this.playbackContext.close().catch(() => {});
      this.playbackContext = null;
    }

    // VAD stoppen
    if (this._vadInterval) {
      clearInterval(this._vadInterval);
      this._vadInterval = null;
    }

    // WebSocket schließen
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      if (this.ws.readyState <= WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }

    // Playback stoppen und Queue leeren
    this._stopPlayback();
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  // ── Audio Capture (Mic → WebSocket) ──────────────────

  async _startAudioCapture() {
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const source = this.audioContext.createMediaStreamSource(this.micStream);

    // VAD-Analyser auf Mikrofon-Input
    this._vadAnalyser = this.audioContext.createAnalyser();
    this._vadAnalyser.fftSize = 512;
    source.connect(this._vadAnalyser);

    // VAD-Polling starten
    const vadBuffer = new Uint8Array(this._vadAnalyser.frequencyBinCount);
    this._vadInterval = setInterval(() => {
      if (!this._vadAnalyser) return;
      this._vadAnalyser.getByteFrequencyData(vadBuffer);
      const avg = vadBuffer.reduce((s, v) => s + v, 0) / vadBuffer.length;
      if (avg > 15) {
        this.onActivityDetected?.();
      }
    }, 200);

    // PCM-Capture: AudioWorklet (modern) mit ScriptProcessor-Fallback
    const sendPcmChunk = (pcm16Buffer) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const base64 = this._arrayBufferToBase64(pcm16Buffer);
      try {
        this.ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              data: base64,
              mimeType: 'audio/pcm;rate=16000'
            }
          }
        }));
      } catch {
        // WebSocket bereits geschlossen – ignorieren
      }
    };

    if (this.audioContext.audioWorklet) {
      // Modern: AudioWorkletNode
      try {
        await this.audioContext.audioWorklet.addModule('pcm-processor.js');
        this.micProcessor = new AudioWorkletNode(this.audioContext, 'pcm-processor');
        source.connect(this.micProcessor);
        this.micProcessor.connect(this.audioContext.destination);
        this.micProcessor.port.onmessage = (e) => {
          sendPcmChunk(e.data.pcm16);
        };
      } catch (err) {
        debugLog(`[Live] AudioWorklet fehlgeschlagen, nutze Fallback: ${err.message}`);
        this._setupScriptProcessorFallback(source, sendPcmChunk);
      }
    } else {
      // Fallback: ScriptProcessorNode (für ältere Browser)
      this._setupScriptProcessorFallback(source, sendPcmChunk);
    }
  }

  _setupScriptProcessorFallback(source, sendPcmChunk) {
    this.micProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(this.micProcessor);
    const gain = this.audioContext.createGain();
    gain.gain.value = 0;
    this.micProcessor.connect(gain);
    gain.connect(this.audioContext.destination);
    this.micProcessor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = this._float32ToPcm16(float32);
      sendPcmChunk(pcm16.buffer);
    };
  }

  // ── Message Handler (WebSocket → Audio Playback) ─────

  async _handleMessage(event) {
    let data;
    try {
      let text;
      if (typeof event.data === 'string') {
        text = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(event.data);
      } else if (event.data instanceof Blob) {
        text = await event.data.text();
      } else {
        text = String(event.data);
      }
      data = JSON.parse(text);
    } catch { return; }

    // Server-Fehler (z.B. Rate-Limit, ungültiger Request)
    if (data.error) {
      const errMsg = data.error.message || JSON.stringify(data.error);
      debugLog(`[Live] Server-Fehler: ${errMsg}`);
      this.onError?.(errMsg);
      this.disconnect();
      return;
    }

    // ── Function Call (toolCall) vom Server ──
    const toolCall = data.toolCall;
    if (toolCall && toolCall.functionCalls) {
      this.onActivityDetected?.();
      const responses = [];
      for (const fc of toolCall.functionCalls) {
        let result = { success: true };
        if (this.onFunctionCall) {
          try {
            result = await this.onFunctionCall(fc) || { success: true };
          } catch (err) {
            result = { error: err.message };
          }
        }
        responses.push({
          id: fc.id,
          response: result
        });
      }
      // Function-Call-Ergebnis an Server zurücksenden
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          toolResponse: { functionResponses: responses }
        }));
      }
      return;
    }

    const serverContent = data.serverContent;
    if (!serverContent) return;

    // Unterbrechung – Server signalisiert, dass Nutzer reingesprochen hat
    if (serverContent.interrupted) {
      this._stopPlayback();
      this._setState('listening');
      this.onActivityDetected?.();
      return;
    }

    // Parts verarbeiten
    const parts = serverContent.modelTurn?.parts;
    if (parts) {
      this._setState('responding');
      this.onActivityDetected?.();

      for (const part of parts) {
        // Audio-Chunk
        if (part.inlineData?.mimeType?.startsWith('audio/')) {
          const pcmBytes = this._base64ToArrayBuffer(part.inlineData.data);
          this._enqueueAudio(pcmBytes);
        }
        // Text (Transkript)
        if (part.text) {
          this.onTranscript?.(part.text, 'assistant');
        }
      }
    }

    // Output-Transkript (wenn outputAudioTranscription aktiv)
    if (serverContent.outputTranscription?.text) {
      this.onTranscript?.(serverContent.outputTranscription.text, 'assistant');
    }

    // Input-Transkript (Nutzer-Sprache als Text)
    if (serverContent.inputTranscription?.text) {
      this.onTranscript?.(serverContent.inputTranscription.text, 'user');
    }

    // Turn abgeschlossen
    if (serverContent.turnComplete) {
      this._onPlaybackComplete(() => {
        if (this.state !== 'disconnected') {
          this._setState('listening');
        }
      });
    }
  }

  // ── Audio Playback (PCM16 24kHz → AudioContext) ──────

  _enqueueAudio(pcm16Buffer) {
    this._playbackQueue.push(pcm16Buffer);
    if (!this._isPlaying) this._playNextChunk();
  }

  _playNextChunk() {
    if (!this.playbackContext || this.playbackContext.state === 'closed' || this._playbackQueue.length === 0) {
      this._isPlaying = false;
      this._currentSource = null;
      return;
    }

    this._isPlaying = true;
    const pcmBytes = this._playbackQueue.shift();

    // ArrayBuffer muss korrekt aligned sein für Int16Array
    const aligned = new Uint8Array(pcmBytes);
    const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 2));
    const float32 = new Float32Array(int16.length);

    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = this.playbackContext.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const src = this.playbackContext.createBufferSource();
    src.buffer = buffer;
    src.connect(this.playbackContext.destination);
    this._currentSource = src;
    src.onended = () => {
      if (this._currentSource === src) this._currentSource = null;
      this._playNextChunk();
    };
    src.start();
  }

  _stopPlayback() {
    this._playbackQueue = [];
    if (this._currentSource) {
      try { this._currentSource.stop(); } catch { /* already stopped */ }
      this._currentSource = null;
    }
    this._isPlaying = false;
  }

  _onPlaybackComplete(callback) {
    const check = () => {
      if (!this._isPlaying && this._playbackQueue.length === 0) {
        callback();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  }

  // ── Hilfsfunktionen ──────────────────────────────────

  _float32ToPcm16(float32) {
    const pcm16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  }

  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
