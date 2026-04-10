// ordo-proxy – Cloudflare Worker
// Leitet Gemini API Calls weiter, Key bleibt serverseitig.
// Rate-Limiting per IP-Adresse (CF-Connecting-IP) + User-Agent-Hash.

const DAILY_LIMIT = 50;         // Requests pro Gerät pro Tag
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Whitelist der erlaubten Origins (Wildcard erlaubt sonst Quota-Klau durch
// beliebige Websites, da die Proxy-URL im Client-Code steht).
// Via env.ALLOWED_ORIGINS überschreibbar (kommagetrennt), sonst dieser Default.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://ordo.app',
  'https://ordo-app.pages.dev',
  'https://gunterstruck.github.io',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
];

function getAllowedOrigins(env) {
  if (env && typeof env.ALLOWED_ORIGINS === 'string' && env.ALLOWED_ORIGINS.trim()) {
    return env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function resolveAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = getAllowedOrigins(env);
  return allowed.includes(origin) ? origin : null;
}

export default {
  async fetch(request, env) {
    const allowedOrigin = resolveAllowedOrigin(request, env);

    // CORS Preflight
    if (request.method === 'OPTIONS') {
      if (!allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, { headers: corsHeaders(allowedOrigin) });
    }

    // Nur POST erlauben
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, allowedOrigin);
    }

    // Origin prüfen – unbekannte Origins haben hier nichts zu suchen
    if (!allowedOrigin) {
      return jsonResponse({ error: 'forbidden_origin' }, 403, null);
    }

    // IP-basiertes Rate-Limiting (serverseitig, nicht manipulierbar)
    // CF-Connecting-IP wird von Cloudflare gesetzt — der Client
    // kann ihn NICHT fälschen. localStorage-Löschen, Inkognito,
    // PWA-Neuinstall ändern nichts an der IP.
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Optional: Feineres Raster für Shared-IPs (Büro-Netze)
    // User-Agent-Hash unterscheidet verschiedene Geräte hinter einer IP
    const ua = request.headers.get('User-Agent') || '';
    const uaHash = await hashString(ua.slice(0, 64));
    const deviceKey = `${clientIP}:${uaHash}`;

    // Rate-Limit prüfen UND Counter sofort erhöhen, bevor der Gemini-Call geht.
    // Vorher wurde put() erst nach der Response aufgerufen → bei n parallelen
    // Requests sahen alle denselben alten Wert und das Limit war umgehbar.
    // KV ist nicht strikt atomar, aber das "reserve-first"-Pattern reduziert
    // den TOCTOU-Raum auf wenige Millisekunden.
    const rateLimitKey = `rate:${deviceKey}:${todayString()}`;
    const currentCount = parseInt(await env.RATE_LIMIT.get(rateLimitKey) || '0');

    if (currentCount >= DAILY_LIMIT) {
      return jsonResponse({
        error: 'rate_limit',
        message: 'Tageslimit erreicht',
        limit: DAILY_LIMIT,
        resetAt: nextMidnightUTC(),
      }, 429, allowedOrigin);
    }

    const reservedCount = currentCount + 1;
    await env.RATE_LIMIT.put(rateLimitKey, String(reservedCount), {
      expirationTtl: 86400,
    });

    // Request-Body lesen
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, allowedOrigin);
    }

    // Modell aus dem Body extrahieren
    const model = body.model || 'gemini-2.5-flash';

    // An Gemini weiterleiten
    const geminiUrl = `${GEMINI_BASE}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    try {
      const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: body.contents,
          systemInstruction: body.systemInstruction,
          generationConfig: body.generationConfig,
          tools: body.tools,
          safetySettings: body.safetySettings,
        }),
      });

      // Gemini-Antwort durchreichen
      const geminiBody = await geminiResponse.text();

      return new Response(geminiBody, {
        status: geminiResponse.status,
        headers: {
          ...corsHeaders(allowedOrigin),
          'Content-Type': 'application/json',
          'X-ORDO-Remaining': String(DAILY_LIMIT - reservedCount),
          'X-ORDO-Limit': String(DAILY_LIMIT),
        },
      });

    } catch (err) {
      // Netzwerk-/Upstream-Fehler: Reservierung zurücknehmen, damit der Nutzer
      // für Worker-interne Probleme nicht belastet wird.
      try {
        await env.RATE_LIMIT.put(rateLimitKey, String(currentCount), { expirationTtl: 86400 });
      } catch { /* best effort */ }
      return jsonResponse({ error: 'proxy_error', message: err.message }, 502, allowedOrigin);
    }
  },
};

function corsHeaders(allowedOrigin) {
  const origin = allowedOrigin || 'null';
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-ORDO-Remaining, X-ORDO-Limit',
  };
}

function jsonResponse(data, status = 200, allowedOrigin = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(allowedOrigin), 'Content-Type': 'application/json' },
  });
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function nextMidnightUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Kurzer Hash eines Strings (für User-Agent-Differenzierung).
 * Kein kryptografischer Anspruch — nur um Geräte zu unterscheiden.
 */
async function hashString(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 4))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
