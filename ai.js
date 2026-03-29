// ai.js – KI-Kommunikation, Prompts, Response-Parsing, Action-Ausführung
// Keinerlei direkter DOM-Zugriff. Importiert DOM-Funktionen aus anderen Modulen.
// Unterstützt Gemini (Standard), OpenAI und OpenRouter als Fallback-Provider.

import Brain from './brain.js';
import { debugLog, ensureRoom } from './app.js';

// ── Provider Configuration ────────────────────────────
const PROVIDERS = {
  gemini: {
    name: 'Google Gemini',
    buildUrl: (model, apiKey) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
    models: { fast: 'google/gemini-2.5-flash-preview', pro: 'google/gemini-2.5-pro-preview' },
  },
};

export function getProviderConfig() {
  try {
    return JSON.parse(localStorage.getItem('ordo_providers') || 'null') || {
      primary: 'gemini',
      fallbacks: [],
      keys: {},
    };
  } catch { return { primary: 'gemini', fallbacks: [], keys: {} }; }
}

export function setProviderConfig(config) {
  localStorage.setItem('ordo_providers', JSON.stringify(config));
}

export { PROVIDERS };

// ── Model Routing ─────────────────────────────────────
const MODELS = {
  fast: 'gemini-2.5-flash',          // schnell, stabil – Chat & Text (kein preview!)
  pro: 'gemini-2.5-pro',             // präzise, stabil – Foto/Video-Analyse, räumliche Tiefe
};

/**
 * Bestimmt das optimale Modell basierend auf dem Input.
 * @param {Object} options
 * @param {boolean} [options.hasImage] - Foto im Request
 * @param {boolean} [options.hasVideo] - Video im Request
 * @param {string} [options.taskType] - Art der Aufgabe
 * @returns {string} Modellname
 */
function determineModel({ hasImage = false, hasVideo = false, taskType = 'chat' } = {}) {
  // Multimodale Analyse (Foto/Video) → Gemini 2.5 Pro
  if (hasVideo) return MODELS.pro;
  if (hasImage) return MODELS.pro;
  // Komplexe Textaufgaben → Gemini 2.5 Pro
  const PRO_TASKS = [
    'analyzeBlueprint',
    'analyzeReceipt',
    'batchEstimateValues',
    'containerCheck',
    'roomCheck',
    'householdCheck',
  ];
  if (PRO_TASKS.includes(taskType)) return MODELS.pro;
  // Chat & einfache Textaufgaben → Gemini 2.5 Flash
  return MODELS.fast;
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
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\bon\w+\s*=\s*[^\s>"']+/gi, '')
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
    case 'show_found_item':
      return { type: 'found', room: args.room, path: [args.container_id], item: args.item };
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
  if (provider.format === 'openai') {
    return _callOpenAIFormat(provider, apiKey, systemPrompt, messages, options);
  }
  return _callGeminiFormat(apiKey, systemPrompt, messages, options);
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
  // If using fast model, try pro as fallback on server errors
  if (model === MODELS.fast) modelsToTry.push(MODELS.pro);

  for (const currentModel of modelsToTry) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const apiUrl = `${API_BASE}/${currentModel}:generateContent?key=${apiKey}`;
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
      try {
        response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
      } catch (fetchErr) {
        debugLog(`NETZWERK-FEHLER: ${fetchErr.message}`);
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

        // Non-retryable errors – throw immediately
        if (response.status === 403) { const e = new Error('api_key'); e.httpStatus = 403; e.responseBody = rawText.slice(0, 500); throw e; }
        if (response.status === 400) { const e = new Error('bad_request'); e.httpStatus = 400; e.responseBody = rawText.slice(0, 500); throw e; }

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

      if (currentModel !== model) {
        debugLog(`Hinweis: Fallback-Modell ${currentModel} verwendet (statt ${model})`);
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

  const images = await Promise.all(safePhotos.map(async p => {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(p.blob);
    });
    return { type: 'image', source: { media_type: p.blob.type || 'image/jpeg', data: base64 } };
  }));

  const response = await callGemini(apiKey, 'Du antwortest ausschließlich mit validem JSON.', [
    { role: 'user', content: [{ type: 'text', text: prompt }, ...images] }
  ], { taskType: 'analyzeBlueprint', hasImage: true });

  const cleaned = response.replace(/```json/gi, '```');
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Kein JSON in Antwort');
  const parsed = JSON.parse(jsonMatch[0]);
  parsed.raeume = Array.isArray(parsed.raeume) ? parsed.raeume : [];
  return parsed;
}

// ── Message Building ───────────────────────────────────
export function buildMessages(history, newUserText) {
  const msgs = [];
  let lastRole = null;
  for (const m of history) {
    if (m.role !== lastRole) {
      msgs.push({ role: m.role, content: m.content });
      lastRole = m.role;
    }
  }
  if (lastRole === 'user') {
    msgs.push({ role: 'assistant', content: '…' });
  }
  msgs.push({ role: 'user', content: newUserText });
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
        Brain.removeItem(action.from_room, fromId, action.item);
        Brain.addItem(action.to_room, toId, action.item);
        emitAction(`✓ ${action.item} verschoben: ${fromR?.name || action.from_room} → ${toR?.name || action.to_room}`);
        break;
      }
      case 'replace_items': {
        if (!Brain.getRoom(action.room)) return;
        if (!containerId || !Brain.getContainer(action.room, containerId)) return;
        const c = Brain.getContainer(action.room, containerId);
        const r = Brain.getRoom(action.room);
        const data = Brain.getData();
        const cont = Brain._findContainerInTree(data.rooms[action.room].containers, containerId);
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

export async function uploadVideoToGemini(apiKey, file, onProgress) {
  const sizeMB = file.size / (1024 * 1024);
  debugLog(`Video-Upload gestartet: ${file.name} (${sizeMB.toFixed(1)} MB, ${file.type})`);

  if (sizeMB > MAX_VIDEO_SIZE_MB) {
    throw new Error(`Video zu groß (${Math.round(sizeMB)} MB). Maximum: ${MAX_VIDEO_SIZE_MB} MB.`);
  }

  onProgress?.('upload', 0);

  debugLog('Starte resumable Upload-Session…');
  const startRes = await fetchWithRetry(`${FILE_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: {
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
    const isLast = chunkIdx === totalChunks - 1;
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(offset, end);
    const command = isLast ? 'upload, finalize' : 'upload';

    debugLog(`Chunk ${chunkIdx + 1}/${totalChunks} senden (${(offset / 1024 / 1024).toFixed(1)}–${(end / 1024 / 1024).toFixed(1)} MB)…`);

    const chunkController = new AbortController();
    const chunkTimeout = setTimeout(() => chunkController.abort(), 120000);
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
      if (err.name === 'AbortError') throw new Error('Timeout beim Video-Upload – Verbindung zu langsam.');
      throw err;
    }
    clearTimeout(chunkTimeout);

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

      onProgress?.('processing', 50);
      debugLog(`Datei hochgeladen: ${fileObj.name}. Warte auf Verarbeitung…`);

      let attempts = 0;
      const maxAttempts = 48; // 48 × 2.5s = 120s timeout
      let pollErrors = 0;

      // fileObj.name is e.g. "files/abc123" – strip "files/" prefix to avoid double "files/" in URL
      const fileId = fileObj.name.startsWith('files/') ? fileObj.name.slice(6) : fileObj.name;

      while (attempts < maxAttempts) {
        const pollUrl = `${FILE_API_GET_URL}/${fileId}?key=${apiKey}`;
        debugLog(`Poll-URL: ${pollUrl}`);
        const checkRes = await fetchWithRetry(
          pollUrl,
          {}, 2, 'Status-Poll'
        );

        if (!checkRes.ok) {
          pollErrors++;
          const errText = await checkRes.text().catch(() => '');
          debugLog(`Status-Abfrage fehlgeschlagen: HTTP ${checkRes.status} – ${errText}`);
          if (pollErrors >= 5) throw new Error(`Status-Abfrage fehlgeschlagen nach ${pollErrors} Fehlern: HTTP ${checkRes.status}`);
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
          return { fileUri: checkData.uri, mimeType: checkData.mimeType, fileName: fileObj.name };
        }
        if (state === 'FAILED') {
          debugLog(`Verarbeitung fehlgeschlagen. Response: ${JSON.stringify(checkData).slice(0, 300)}`);
          throw new Error('Video-Verarbeitung fehlgeschlagen. Bitte ein kürzeres Video versuchen.');
        }

        attempts++;
        const progress = 50 + Math.min(45, (attempts / maxAttempts) * 45);
        onProgress?.('processing', progress);
        await new Promise(r => setTimeout(r, 2500));
      }

      throw new Error('Video-Verarbeitung dauert zu lange (Timeout nach 120 s). Bitte ein kürzeres Video versuchen oder stattdessen einzelne Fotos verwenden.');
    }
  }
}

export async function deleteGeminiFile(apiKey, fileName) {
  try {
    const fileId = fileName.startsWith('files/') ? fileName.slice(6) : fileName;
    await fetch(`${FILE_API_GET_URL}/${fileId}?key=${apiKey}`, { method: 'DELETE' });
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
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Kein JSON in Antwort');
  return JSON.parse(jsonMatch[0]);
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

  // Extract JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Kein JSON in Antwort');

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error('Kein JSON in Antwort');
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

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Kein JSON in Antwort');
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error('Kein JSON in Antwort');
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

    // Audio playback queue
    this._playbackQueue = [];
    this._isPlaying = false;
    this._currentSource = null;

    // VAD for idle detection
    this._vadAnalyser = null;
    this._vadInterval = null;
  }

  async connect(apiKey, systemPrompt) {
    if (this.ws) this.disconnect();

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
      const url = `${LIVE_WS_URL}?key=${apiKey}`;
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
      this.ws.send(JSON.stringify({
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
      }));

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
      this.ws.onmessage = (event) => this._handleMessage(event);
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
      this._startAudioCapture();

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

    // ScriptProcessor für PCM-Capture (4096 Samples bei 16kHz = 256ms Chunks)
    // Hinweis: ScriptProcessor ist deprecated, aber universell unterstützt.
    // AudioWorklet benötigt eine separate Datei und ist für diesen Use-Case Overkill.
    this.micProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
    source.connect(this.micProcessor);
    // Connect to destination (nötig damit onaudioprocess feuert), aber leise
    const gain = this.audioContext.createGain();
    gain.gain.value = 0; // Mic-Audio nicht über Lautsprecher ausgeben
    this.micProcessor.connect(gain);
    gain.connect(this.audioContext.destination);

    this.micProcessor.onaudioprocess = (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = this._float32ToPcm16(float32);
      const base64 = this._arrayBufferToBase64(pcm16.buffer);

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
