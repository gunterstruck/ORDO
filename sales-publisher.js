// sales-publisher.js – Mini-Modul: Kleinanzeigen Assisted Publishing
// Generiert Verkaufsanzeigen per KI und öffnet kleinanzeigen.de
// mit Text im Clipboard. Kein automatisches Posting — bewusste Entscheidung.

import Brain from './brain.js';
import { callGemini, extractJSON } from './ai.js';
import { registerBlock } from './ui-blocks.js';
import { escapeHTML } from './app.js';

// ── Anzeigen-Generator ────────────────────────────────

/**
 * Generiert einen Kleinanzeigen-Entwurf per Gemini.
 * Nutzt Foto wenn vorhanden, sonst nur Metadaten.
 *
 * @param {string} itemName
 * @param {Object} itemObj - vollständiges Item-Objekt aus Brain
 * @param {Blob|null} photoBlob - Foto des Containers (optional)
 * @returns {Promise<{title, description, price, category}>}
 */
export async function generateListing(itemName, itemObj, photoBlob) {
  const apiKey = Brain.getApiKey();
  if (!apiKey) throw new Error('Kein API Key');

  const priceHint = itemObj?.valuation?.replacement_value
    ? `Geschätzter Wiederbeschaffungswert: ${itemObj.valuation.replacement_value}€`
    : itemObj?.purchase?.price
    ? `Kaufpreis war: ${itemObj.purchase.price}€`
    : 'Kein Preis bekannt';

  const systemPrompt = `Du bist ein Experte für Kleinanzeigen-Texte auf kleinanzeigen.de.
Erstelle einen realistischen, ansprechenden Verkaufstext für einen Gebrauchtartikel.
Ton: direkt, ehrlich, keine Übertreibungen. Typisch deutsch, kein Marketing-Sprech.

Antworte NUR mit diesem JSON, nichts anderes:
{
  "title": "Kurzer Titel (max 50 Zeichen, Zustand erwähnen)",
  "description": "Beschreibung (3-5 Sätze: was ist es, Zustand, Besonderheiten, Abholung/Versand)",
  "price": 0,
  "price_hint": "Begründung des Preises in einem Satz",
  "category": "Kategorie-Vorschlag für kleinanzeigen.de"
}

Preis: Gebrauchtwert ist typisch 30-50% des Neuwerts. ${priceHint}.
Sei realistisch — lieber etwas tiefer ansetzen damit es schnell geht.`;

  const messages = [];

  if (photoBlob) {
    // Mit Foto: Gemini sieht den Artikel
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(photoBlob);
    });
    messages.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: photoBlob.type || 'image/jpeg', data: base64 } },
        { type: 'text', text: `Artikel: ${itemName}\n${priceHint}\nErstelle eine Kleinanzeige.` }
      ]
    });
  } else {
    // Ohne Foto: nur Metadaten
    messages.push({
      role: 'user',
      content: `Artikel: ${itemName}\n${priceHint}\nErstelle eine Kleinanzeige.`
    });
  }

  const raw = await callGemini(apiKey, systemPrompt, messages, {
    taskType: photoBlob ? 'analyzePhoto' : 'chat',
    hasImage: !!photoBlob,
  });

  const text = typeof raw === 'string' ? raw : (raw.text || '');
  const parsed = extractJSON(text);
  if (!parsed) throw new Error('Kein JSON in Antwort');
  return parsed;
}

// ── Share / Clipboard ─────────────────────────────────

/**
 * Kopiert Text in die Zwischenablage.
 * Fallback: execCommand (ältere Browser).
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  }
}

/**
 * Öffnet kleinanzeigen.de Inserieren-Seite.
 * Auf Mobile: öffnet die App wenn installiert (Intent-URL).
 * Auf Desktop: normaler Tab.
 */
function openKleinanzeigen() {
  // Mobile: versuche App-Intent
  const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (isMobile) {
    // Android Intent für Kleinanzeigen-App
    window.location.href = 'intent://kleinanzeigen.de/s-inserieren/k0#Intent;scheme=https;package=com.ebay.kleinanzeigen;end';
    // Fallback nach 1.5s wenn App nicht installiert
    setTimeout(() => {
      window.open('https://www.kleinanzeigen.de/s-inserieren/k0', '_blank');
    }, 1500);
  } else {
    window.open('https://www.kleinanzeigen.de/s-inserieren/k0', '_blank');
  }
}

// ── UI-Block: KleinanzeigenCard ───────────────────────

/**
 * Zeigt einen fertigen Anzeigen-Entwurf im Dialog.
 * props: {
 *   itemName: string,
 *   roomId: string,
 *   containerId: string,
 *   listing?: { title, description, price, category } // wenn schon generiert
 * }
 */
registerBlock('KleinanzeigenCard', (props) => {
  const el = document.createElement('div');
  el.className = 'block-kleinanzeigen-card';

  if (props.listing) {
    renderListingCard(el, props);
  } else {
    renderGenerateButton(el, props);
  }

  return el;
});

function renderGenerateButton(el, props) {
  el.innerHTML = `
    <div class="ka-card-header">
      <span class="ka-card-icon">🏷️</span>
      <div>
        <div class="ka-card-title">${escapeHTML(props.itemName)}</div>
        <div class="ka-card-sub">Anzeige noch nicht generiert</div>
      </div>
    </div>
    <button class="ka-generate-btn">
      ✨ Anzeige erstellen lassen
    </button>
  `;

  el.querySelector('.ka-generate-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '⏳ Gemini schreibt...';

    try {
      // Foto laden
      const photoResult = await Brain.findBestPhoto(props.roomId, props.containerId).catch(() => null);
      const photoBlob = photoResult?.blob || null;

      // Item-Objekt laden
      const container = Brain.getContainer(props.roomId, props.containerId);
      const itemObj = container?.items?.find(i =>
        (typeof i === 'string' ? i : i.name) === props.itemName
      );

      // Listing generieren
      const listing = await generateListing(props.itemName, itemObj, photoBlob);

      // Block neu rendern mit Ergebnis
      el.innerHTML = '';
      renderListingCard(el, { ...props, listing });

    } catch (err) {
      btn.disabled = false;
      btn.textContent = `✨ Nochmal versuchen (${err.message})`;
    }
  });
}

function renderListingCard(el, props) {
  const { listing, itemName } = props;
  const fullText = `${listing.title}\n\n${listing.description}\n\nPreis: ${listing.price}€ VB`;

  el.innerHTML = `
    <div class="ka-card-header">
      <span class="ka-card-icon">🏷️</span>
      <div>
        <div class="ka-card-title">Fertige Anzeige</div>
        <div class="ka-card-sub">${escapeHTML(listing.category || '')}</div>
      </div>
    </div>

    <div class="ka-listing-preview">
      <div class="ka-listing-field">
        <span class="ka-field-label">Titel</span>
        <span class="ka-field-value">${escapeHTML(listing.title)}</span>
      </div>
      <div class="ka-listing-field">
        <span class="ka-field-label">Beschreibung</span>
        <span class="ka-field-value ka-desc">${escapeHTML(listing.description)}</span>
      </div>
      <div class="ka-listing-field ka-price-row">
        <span class="ka-field-label">Preis</span>
        <span class="ka-price">${listing.price}€ VB</span>
      </div>
      ${listing.price_hint ? `<div class="ka-price-hint">💡 ${escapeHTML(listing.price_hint)}</div>` : ''}
    </div>

    <div class="ka-actions">
      <button class="ka-btn-copy">📋 Text kopieren</button>
      <button class="ka-btn-open">🔗 Kleinanzeigen öffnen</button>
      <button class="ka-btn-regenerate">🔄 Neu generieren</button>
    </div>

    <div class="ka-status" style="display:none"></div>
  `;

  const status = el.querySelector('.ka-status');

  // Text kopieren
  el.querySelector('.ka-btn-copy').addEventListener('click', async () => {
    const ok = await copyToClipboard(fullText);
    if (ok) {
      status.textContent = '✅ Text kopiert! Jetzt auf Kleinanzeigen einfügen.';
      status.style.display = 'block';
      setTimeout(() => { status.style.display = 'none'; }, 3000);
    }
  });

  // Kleinanzeigen öffnen (mit auto-copy)
  el.querySelector('.ka-btn-open').addEventListener('click', async () => {
    await copyToClipboard(fullText);
    status.textContent = '📋 Text kopiert — Kleinanzeigen öffnet sich...';
    status.style.display = 'block';
    setTimeout(() => openKleinanzeigen(), 400);
    setTimeout(() => { status.style.display = 'none'; }, 4000);
  });

  // Neu generieren
  el.querySelector('.ka-btn-regenerate').addEventListener('click', () => {
    el.innerHTML = '';
    renderGenerateButton(el, props);
  });
}
