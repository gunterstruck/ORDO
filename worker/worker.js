// ordo-proxy – Cloudflare Worker
// Leitet Gemini API Calls weiter, Key bleibt serverseitig.
// Rate-Limiting per anonymer Session-ID.

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

    // Session-ID aus Header (vom Client generiert, anonym)
    const sessionId = request.headers.get('X-ORDO-Session') || 'unknown';

    // Rate-Limit prüfen
    const rateLimitKey = `rate:${sessionId}:${todayString()}`;
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
    'Access-Control-Allow-Headers': 'Content-Type, X-ORDO-Session',
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
