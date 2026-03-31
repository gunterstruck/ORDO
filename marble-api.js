// marble-api.js – Marble World API Integration (World Labs)
// Verwandelt ein Foto in eine begehbare 3D-Welt (Gaussian Splat)

const MARBLE_API_BASE = 'https://api.worldlabs.ai/v1';

/**
 * Generiert eine 3D-Welt aus einem Foto.
 * @param {string} imageBase64 — Das Foto als Base64
 * @param {string} apiKey — Marble API Key
 * @returns {Promise<{ worldId: string, splatUrl: string, meshUrl: string, previewUrl: string, status: string }>}
 */
export async function generateWorldFromPhoto(imageBase64, apiKey) {
  // 1. Welt erstellen (async — dauert ~30 Sek)
  const createResponse = await fetch(`${MARBLE_API_BASE}/worlds`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        type: 'image',
        data: imageBase64,
      },
      output: {
        format: 'splat',
        quality: 'standard',
      },
    }),
  });

  if (!createResponse.ok) {
    throw new Error(`Marble API Error: ${createResponse.status}`);
  }

  const { world_id } = await createResponse.json();

  // 2. Polling bis fertig
  const result = await pollWorldStatus(world_id, apiKey);
  return result;
}

/**
 * Pollt den Status bis die Welt fertig ist.
 * Timeout: 120 Sekunden.
 */
async function pollWorldStatus(worldId, apiKey, maxWait = 120000) {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const response = await fetch(`${MARBLE_API_BASE}/worlds/${worldId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    const data = await response.json();

    if (data.status === 'completed') {
      return {
        worldId: data.world_id,
        splatUrl: data.outputs?.splat_url,
        meshUrl: data.outputs?.mesh_url,
        previewUrl: data.outputs?.preview_url,
        status: 'completed',
      };
    }

    if (data.status === 'failed') {
      throw new Error(`Marble Welt-Generierung fehlgeschlagen: ${data.error}`);
    }

    // 3 Sekunden warten
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  throw new Error('Marble Timeout: Welt wurde nicht in 2 Minuten fertig');
}

/**
 * Lädt einen Gaussian Splat als ArrayBuffer herunter.
 * @param {string} splatUrl — URL zum .spz File
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadSplat(splatUrl) {
  const response = await fetch(splatUrl);
  if (!response.ok) throw new Error('Splat Download fehlgeschlagen');
  return response.arrayBuffer();
}

/**
 * Prüft ob ein Marble API Key konfiguriert ist.
 */
export function hasMarbleKey() {
  return !!localStorage.getItem('ordo_marble_api_key');
}

/**
 * Gibt den Marble API Key zurück.
 */
export function getMarbleKey() {
  return localStorage.getItem('ordo_marble_api_key');
}
