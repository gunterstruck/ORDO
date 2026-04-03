// ordo-proxy – Cloudflare Worker
// Leitet Gemini API Calls weiter, Key bleibt serverseitig.
// Rate-Limiting per IP-Adresse (CF-Connecting-IP) + User-Agent-Hash.

const DAILY_LIMIT = 50;         // Requests pro Gerät pro Tag
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export default {
  async fetch(request, env) {
    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Nur POST erlauben
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
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

    // Rate-Limit prüfen
    const rateLimitKey = `rate:${deviceKey}:${todayString()}`;
    const currentCount = parseInt(await env.RATE_LIMIT.get(rateLimitKey) || '0');

    if (currentCount >= DAILY_LIMIT) {
      return jsonResponse({
        error: 'rate_limit',
        message: 'Tageslimit erreicht',
        limit: DAILY_LIMIT,
        resetAt: nextMidnightUTC(),
      }, 429);
    }

    // Request-Body lesen
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
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

      // Rate-Counter erhöhen (TTL: 24 Stunden)
      await env.RATE_LIMIT.put(rateLimitKey, String(currentCount + 1), {
        expirationTtl: 86400,
      });

      // Gemini-Antwort durchreichen
      const geminiBody = await geminiResponse.text();

      return new Response(geminiBody, {
        status: geminiResponse.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': 'application/json',
          'X-ORDO-Remaining': String(DAILY_LIMIT - currentCount - 1),
          'X-ORDO-Limit': String(DAILY_LIMIT),
        },
      });

    } catch (err) {
      return jsonResponse({ error: 'proxy_error', message: err.message }, 502);
    }
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-ORDO-Remaining, X-ORDO-Limit',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
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
