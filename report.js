// report.js – PDF Versicherungsbericht Generator
// Nutzt jsPDF + jspdf-autotable (global über CDN geladen)

import Brain from './brain.js';
import { batchEstimateValues } from './ai.js';
import { showToast } from './modal.js';
import { debugLog } from './app.js';

const JSPDF_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js';
const JSPDF_AUTOTABLE_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.4/jspdf.plugin.autotable.min.js';
let pdfLibrariesLoadPromise = null;

// ── PDF Colors ───────────────────────────────────────────
const COLORS = {
  primary: [232, 124, 62],
  text: [51, 51, 51],
  lightText: [120, 110, 100],
  background: [245, 240, 235],
  white: [255, 255, 255],
  border: [224, 214, 204],
  success: [46, 204, 113],
  warning: [232, 163, 62],
  error: [192, 57, 43],
};

function isPdfLibraryReady() {
  const jsPDF = window.jspdf?.jsPDF;
  return Boolean(jsPDF && typeof jsPDF.prototype?.autoTable === 'function');
}

function loadExternalScript(url) {
  return new Promise((resolve, reject) => {
    const existing = Array.from(document.querySelectorAll('script')).find(s => s.src === url);
    if (existing) {
      if (existing.dataset.loaded === 'true') return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Script konnte nicht geladen werden: ${url}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Script konnte nicht geladen werden: ${url}`));
    document.head.appendChild(script);
  });
}

async function ensurePdfLibrariesLoaded() {
  if (isPdfLibraryReady()) return;
  if (!navigator.onLine) throw new Error('offline');
  if (!pdfLibrariesLoadPromise) {
    pdfLibrariesLoadPromise = (async () => {
      await loadExternalScript(JSPDF_CDN_URL);
      await loadExternalScript(JSPDF_AUTOTABLE_CDN_URL);
      if (!isPdfLibraryReady()) {
        throw new Error('PDF-Bibliotheken nicht verfügbar');
      }
    })();
  }
  try {
    await pdfLibrariesLoadPromise;
  } catch (err) {
    pdfLibrariesLoadPromise = null;
    throw err;
  }
}

// ── Helpers ──────────────────────────────────────────────
function formatDateDE(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length >= 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return dateStr;
}

function formatCurrency(val) {
  if (val == null) return '– €';
  return Number(val).toFixed(2).replace('.', ',') + ' €';
}

function formatCurrencyRound(val) {
  if (val == null) return '– €';
  if (val >= 1000) return (val / 1000).toFixed(1).replace('.', ',') + ' T€';
  return Math.round(val).toLocaleString('de-DE') + ' €';
}

function formatRange(min, max) {
  if (min == null && max == null) return '– €';
  if (min === max || max == null) return formatCurrencyRound(min);
  return `${formatCurrencyRound(min)} – ${formatCurrencyRound(max)}`;
}

function todayDE() {
  return new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function loadPhotoAsDataUrl(photoKey) {
  try {
    const blob = await Brain.getPhoto(photoKey);
    if (!blob) return null;
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch(err) { console.warn('Foto für PDF konnte nicht geladen werden:', err.message); return null; }
}

async function compressImage(dataUrl, maxW, maxH, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxW) { h = h * (maxW / w); w = maxW; }
      if (h > maxH) { w = w * (maxH / h); h = maxH; }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ── Main Export ──────────────────────────────────────────

export async function showReportDialog() {
  const data = Brain.getData();
  if (!data?.rooms || Object.keys(data.rooms).length === 0) {
    showToast('Noch keine Daten vorhanden.');
    return;
  }

  // Count items
  let totalItems = 0;
  const rooms = data.rooms;
  for (const room of Object.values(rooms)) {
    countItems(room.containers, (n) => { totalItems += n; });
  }
  if (totalItems === 0) {
    showToast('Noch keine Gegenstände erfasst.');
    return;
  }

  // Build dialog
  const existing = document.getElementById('report-dialog-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'report-dialog-overlay';
  overlay.className = 'report-dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'report-dialog';

  const title = document.createElement('h3');
  title.className = 'report-dialog-title';
  title.textContent = 'Versicherungsbericht erstellen';

  const optionsHtml = `
    <div class="report-dialog-section">
      <div class="report-dialog-section-title">FOTOS</div>
      <label class="report-dialog-option">
        <input type="checkbox" id="report-opt-container-photos" checked> Container-Fotos (Besitznachweis)
      </label>
      <label class="report-dialog-option">
        <input type="checkbox" id="report-opt-receipt-photos"> Kassenbon-Fotos (Wertnachweis)
      </label>
    </div>
    <div class="report-dialog-section">
      <div class="report-dialog-section-title">WERTE</div>
      <label class="report-dialog-option">
        <input type="checkbox" id="report-opt-estimate" checked> Werte schätzen lassen für Items ohne Kaufpreis (1 API-Call)
      </label>
    </div>
    <div class="report-dialog-section">
      <div class="report-dialog-section-title">INHALT</div>
      <label class="report-dialog-option">
        <input type="checkbox" id="report-opt-archived"> Archivierte Gegenstände zeigen
      </label>
    </div>
    ${totalItems > 500 ? `<div class="report-dialog-warning">Dein Haushalt hat über 500 Gegenstände. Das PDF wird groß. Tipp: Ohne Fotos wird es deutlich kleiner.</div>` : ''}
  `;

  const optionsDiv = document.createElement('div');
  optionsDiv.innerHTML = optionsHtml;

  const actions = document.createElement('div');
  actions.className = 'report-dialog-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'report-dialog-btn report-dialog-btn--cancel';
  cancelBtn.textContent = 'Abbrechen';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const createBtn = document.createElement('button');
  createBtn.className = 'report-dialog-btn report-dialog-btn--primary';
  createBtn.textContent = 'PDF erstellen';
  createBtn.addEventListener('click', async () => {
    const options = {
      containerPhotos: document.getElementById('report-opt-container-photos').checked,
      receiptPhotos: document.getElementById('report-opt-receipt-photos').checked,
      estimateValues: document.getElementById('report-opt-estimate').checked,
      showArchived: document.getElementById('report-opt-archived').checked
    };
    overlay.remove();
    await generateReportWithProgress(options);
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(createBtn);

  dialog.appendChild(title);
  dialog.appendChild(optionsDiv);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function countItems(containers, cb) {
  for (const c of Object.values(containers || {})) {
    cb(Brain.countItemsInContainer(c));
  }
}

// ── Progress Overlay ────────────────────────────────────

async function generateReportWithProgress(options) {
  const existing = document.getElementById('report-progress-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'report-progress-overlay';
  overlay.className = 'report-progress-overlay';

  overlay.innerHTML = `
    <div class="report-progress-modal">
      <div class="report-progress-title">📄 Bericht wird erstellt...</div>
      <div class="report-progress-bar"><div class="report-progress-fill" id="report-progress-fill"></div></div>
      <div class="report-progress-pct" id="report-progress-pct">0%</div>
      <div class="report-progress-detail" id="report-progress-detail">Vorbereitung...</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const fillEl = document.getElementById('report-progress-fill');
  const pctEl = document.getElementById('report-progress-pct');
  const detailEl = document.getElementById('report-progress-detail');

  function updateProgress(pct, detail) {
    fillEl.style.width = `${pct}%`;
    pctEl.textContent = `${Math.round(pct)}%`;
    if (detail) detailEl.textContent = detail;
  }

  try {
    updateProgress(2, 'Lade PDF-Bibliotheken...');
    await ensurePdfLibrariesLoaded();
    const blob = await generateInsuranceReport(options, updateProgress);
    overlay.remove();

    // Download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `ORDO_Inventarbericht_${dateStr}.pdf`;
    a.click();
    URL.revokeObjectURL(url);

    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
    showToast(`Bericht gespeichert ✓ (${sizeMB} MB)`);
  } catch (err) {
    overlay.remove();
    debugLog(`PDF-Generierung fehlgeschlagen: ${err.message}`);
    if (err.message === 'offline' || err.message?.includes('Netz')) {
      showToast('Wertschätzung nicht möglich (offline). Bericht ohne geschätzte Werte erstellt.', 'error');
    } else {
      showToast('PDF-Generierung fehlgeschlagen: ' + err.message, 'error');
    }
  }
}

// ── PDF Generation ──────────────────────────────────────

async function generateInsuranceReport(options, onProgress) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const PAGE_W = 210, PAGE_H = 297;
  const MARGIN = 15;
  const CONTENT_W = PAGE_W - 2 * MARGIN;

  const data = Brain.getData();
  const rooms = data.rooms || {};
  const roomEntries = Object.entries(rooms);

  // Count containers for progress
  let totalContainers = 0;
  for (const room of Object.values(rooms)) {
    totalContainers += Brain.countContainers(room.containers);
  }
  let processedContainers = 0;

  onProgress?.(5, 'Berechne Werte...');

  // Phase 1: Batch estimate values if requested
  if (options.estimateValues) {
    const itemsWithoutValue = Brain.getItemsWithoutValue();
    if (itemsWithoutValue.length > 0) {
      const apiKey = Brain.getApiKey();
      if (apiKey) {
        onProgress?.(8, `Schätze Werte für ${itemsWithoutValue.length} Items...`);
        try {
          const results = await batchEstimateValues(apiKey, itemsWithoutValue);
          // Save results back to items
          for (const est of results) {
            if (est.replacement_value == null) continue;
            const match = itemsWithoutValue.find(i => i.name === est.name);
            if (match) {
              Brain.setValuation(match.roomId, match.containerId, match.name, {
                replacement_value: est.replacement_value,
                replacement_range_min: Array.isArray(est.replacement_range) ? est.replacement_range[0] : null,
                replacement_range_max: Array.isArray(est.replacement_range) ? est.replacement_range[1] : null,
                source: 'batch_ai'
              });
            }
          }
        } catch (err) {
          debugLog(`Batch-Wertschätzung fehlgeschlagen: ${err.message}`);
        }
      }
    }
  }

  onProgress?.(15, 'Erstelle Deckblatt...');

  // Calculate totals
  const totalValue = Brain.getTotalHouseholdValue();
  const activeWarranties = Brain.getActiveWarranties();
  const expiringWarranties = Brain.getExpiringWarranties(30);
  const expiredWarranties = Brain.getExpiredWarranties();
  const totalWarranties = activeWarranties.length + expiringWarranties.length + expiredWarranties.length;

  // Count items & containers
  let totalItems = 0;
  let totalContainersCount = 0;
  for (const room of Object.values(rooms)) {
    totalContainersCount += Brain.countContainers(room.containers);
    countItems(room.containers, (n) => { totalItems += n; });
  }

  let pageNum = 0;

  function addPage() {
    if (pageNum > 0) doc.addPage();
    pageNum++;
  }

  function addFooter() {
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.lightText);
    doc.text(`ORDO Inventarbericht – ${todayDE()}`, MARGIN, PAGE_H - 8);
    doc.text(`Seite ${pageNum}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' });
  }

  function addHeader(title) {
    doc.setFontSize(9);
    doc.setTextColor(...COLORS.lightText);
    doc.text(title, MARGIN, 12);
    doc.setDrawColor(...COLORS.primary);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, 14, PAGE_W - MARGIN, 14);
    return 20;
  }

  function checkPageBreak(y, needed) {
    if (y + needed > PAGE_H - 20) {
      addFooter();
      addPage();
      return 20;
    }
    return y;
  }

  // ── PAGE 1: Cover ────────────────────────────────────
  addPage();

  // Orange accent line
  doc.setDrawColor(...COLORS.primary);
  doc.setLineWidth(1.5);
  doc.line(MARGIN, 65, PAGE_W - MARGIN, 65);

  // Title
  doc.setFontSize(28);
  doc.setTextColor(...COLORS.primary);
  doc.text('ORDO', PAGE_W / 2, 40, { align: 'center' });

  doc.setFontSize(16);
  doc.setTextColor(...COLORS.text);
  doc.text('Haushalts-Inventarbericht', PAGE_W / 2, 52, { align: 'center' });

  doc.setFontSize(11);
  doc.setTextColor(...COLORS.lightText);
  doc.text(`Erstellt am: ${todayDE()}`, PAGE_W / 2, 75, { align: 'center' });

  // Summary box
  let y = 90;
  doc.setFontSize(13);
  doc.setTextColor(...COLORS.text);
  doc.text('ZUSAMMENFASSUNG', MARGIN, y);
  y += 8;
  doc.setFontSize(11);
  doc.text(`${roomEntries.length} ${roomEntries.length === 1 ? 'Raum' : 'Räume'}`, MARGIN + 5, y); y += 6;
  doc.text(`${totalContainersCount} Bereiche`, MARGIN + 5, y); y += 6;
  doc.text(`${totalItems} Gegenstände`, MARGIN + 5, y); y += 12;

  // Total value (the "aha moment")
  if (totalValue.itemCount > 0) {
    doc.setFontSize(13);
    doc.setTextColor(...COLORS.text);
    doc.text('GESCHÄTZTER GESAMTWERT', MARGIN, y); y += 10;

    doc.setFontSize(18);
    doc.setTextColor(...COLORS.primary);
    const rangeText = formatRange(totalValue.min, totalValue.max);
    doc.text(rangeText, MARGIN + 5, y); y += 8;

    doc.setFontSize(10);
    doc.setTextColor(...COLORS.lightText);
    if (totalValue.documented > 0) {
      const docPct = Math.round((totalValue.documented / (totalValue.documented + totalValue.estimated)) * 100);
      doc.text(`davon belegt: ${formatCurrency(totalValue.documented)} (${docPct}%)`, MARGIN + 5, y); y += 5;
      doc.text(`davon geschätzt: ~${formatCurrencyRound(totalValue.estimated)} (${100 - docPct}%)`, MARGIN + 5, y); y += 8;
    }

    // Insurance warning
    doc.setFontSize(10);
    doc.setTextColor(...COLORS.warning);
    doc.text('Hinweis: Prüfen Sie ob Ihre Versicherungssumme ausreicht.', MARGIN + 5, y);
    y += 10;
  }

  // Warranties
  if (totalWarranties > 0) {
    doc.setFontSize(10);
    doc.setTextColor(...COLORS.text);
    doc.text(`${totalWarranties} Gegenstände mit Garantie`, MARGIN + 5, y);
    y += 12;
  }

  // Legend
  y = Math.max(y, 185);
  doc.setFontSize(10);
  doc.setTextColor(...COLORS.text);
  doc.text('LEGENDE', MARGIN, y); y += 7;
  doc.setFontSize(9);
  doc.setTextColor(...COLORS.lightText);
  const legendItems = [
    ['89,99 €  ✓', 'Kaufbeleg vorhanden (stärkster Nachweis)'],
    ['~120 €', 'KI-gestützte Schätzung des Wiederbeschaffungswerts'],
    ['– €', 'Kein Wert ermittelbar'],
  ];
  legendItems.forEach(([symbol, desc]) => {
    doc.setTextColor(...COLORS.text);
    doc.text(symbol, MARGIN + 5, y);
    doc.setTextColor(...COLORS.lightText);
    doc.text(desc, MARGIN + 40, y);
    y += 5;
  });

  // Disclaimer
  y = Math.max(y + 5, 230);
  doc.setDrawColor(...COLORS.border);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 7;
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.lightText);
  doc.text('Erstellt mit ORDO', MARGIN, y); y += 4;
  doc.text('Dieses Dokument dient als Inventarübersicht und ist keine professionelle Wertermittlung.', MARGIN, y);

  addFooter();

  // ── ROOM PAGES ───────────────────────────────────────
  const progressBase = 20;
  const progressPerContainer = totalContainers > 0 ? 60 / totalContainers : 0;

  for (const [roomId, room] of roomEntries) {
    addPage();
    y = addHeader(`${room.emoji || ''} ${room.name}`);

    // Room value
    const roomVal = Brain.getRoomValue(roomId);
    doc.setFontSize(14);
    doc.setTextColor(...COLORS.text);
    doc.text(`${room.emoji || ''} ${room.name}`, MARGIN, y); y += 7;

    if (roomVal.min > 0 || roomVal.max > 0) {
      doc.setFontSize(10);
      doc.setTextColor(...COLORS.lightText);
      doc.text(`Raumwert: ${formatRange(roomVal.min, roomVal.max)}`, MARGIN, y);
      y += 8;
    } else {
      y += 3;
    }

    // Process containers
    y = await renderContainers(doc, roomId, room.containers, y, 0, options, onProgress, progressBase, progressPerContainer, () => processedContainers++, () => processedContainers);

    addFooter();
  }

  // ── LAST PAGE: Value Overview + Disclaimer ────────────
  addPage();
  y = addHeader('Wertübersicht');

  doc.setFontSize(14);
  doc.setTextColor(...COLORS.text);
  doc.text('Wertübersicht', MARGIN, y); y += 8;

  // Room value table
  const roomTableData = roomEntries.map(([roomId, room]) => {
    const rv = Brain.getRoomValue(roomId);
    return [
      `${room.emoji || ''} ${room.name}`,
      formatRange(rv.min, rv.max),
      rv.documented > 0 ? formatCurrency(rv.documented) : '–'
    ];
  });

  roomTableData.push([
    'GESAMT',
    formatRange(totalValue.min, totalValue.max),
    totalValue.documented > 0 ? formatCurrency(totalValue.documented) : '–'
  ]);

  doc.autoTable({
    startY: y,
    head: [['Raum', 'Wert (Bandbreite)', 'Davon belegt']],
    body: roomTableData,
    margin: { left: MARGIN, right: MARGIN },
    styles: { fontSize: 9, textColor: COLORS.text, cellPadding: 3 },
    headStyles: { fillColor: COLORS.primary, textColor: COLORS.white, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: COLORS.background },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    didParseCell: (data) => {
      if (data.row.index === roomTableData.length - 1) {
        data.cell.styles.fontStyle = 'bold';
      }
    }
  });

  y = doc.lastAutoTable.finalY + 12;

  // Warranties summary
  y = checkPageBreak(y, 30);
  doc.setFontSize(12);
  doc.setTextColor(...COLORS.text);
  doc.text('Garantien', MARGIN, y); y += 7;
  doc.setFontSize(10);
  doc.setTextColor(...COLORS.lightText);
  doc.text(`Aktiv: ${activeWarranties.length}`, MARGIN + 5, y);
  doc.text(`Bald ablaufend: ${expiringWarranties.length}`, MARGIN + 50, y);
  doc.text(`Abgelaufen: ${expiredWarranties.length}`, MARGIN + 110, y);
  y += 15;

  // Disclaimer
  y = checkPageBreak(y, 60);
  doc.setDrawColor(...COLORS.primary);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y); y += 8;

  doc.setFontSize(11);
  doc.setTextColor(...COLORS.text);
  doc.text('HINWEISE', MARGIN, y); y += 8;

  doc.setFontSize(9);
  doc.setTextColor(...COLORS.lightText);
  const disclaimers = [
    'Werte mit ✓ basieren auf Kaufbelegen des Eigentümers.',
    'Werte mit ~ sind KI-gestützte Schätzungen des Wiederbeschaffungswerts und keine professionelle Wertermittlung.',
    'Fotos dienen als Besitznachweis.',
    'Dieser Bericht ersetzt KEINE professionelle Inventarbewertung oder ein Sachverständigengutachten.',
    'Empfehlung: Prüfen Sie ob Ihre Hausrat-Versicherungssumme den geschätzten Gesamtwert abdeckt.'
  ];
  disclaimers.forEach(d => {
    y = checkPageBreak(y, 8);
    doc.text(`• ${d}`, MARGIN + 3, y, { maxWidth: CONTENT_W - 6 });
    y += 7;
  });

  addFooter();

  // Return as blob
  return doc.output('blob');
}

// ── Container Rendering ─────────────────────────────────

async function renderContainers(doc, roomId, containers, startY, depth, options, onProgress, progressBase, progressPerContainer, incProcessed, getProcessed) {
  const PAGE_W = 210, PAGE_H = 297, MARGIN = 15, CONTENT_W = PAGE_W - 2 * MARGIN;
  let y = startY;

  for (const [cId, c] of Object.entries(containers || {})) {
    const activeItems = (c.items || []).filter(item => {
      if (typeof item === 'string') return true;
      if (!options.showArchived && item.status === 'archiviert') return false;
      return true;
    });

    if (activeItems.length === 0 && !(c.containers && Object.keys(c.containers).length > 0)) {
      incProcessed();
      continue;
    }

    const containerName = c.name || cId;
    const typIcon = { schrank: '🗄️', regal: '📚', schublade: '🗃️', kiste: '📦', tisch: '🪑', sonstiges: '📋' };
    const icon = typIcon[c.typ] || '📋';

    // Check page break before container section
    y = checkPageBreakGlobal(doc, y, 40);

    // Container header
    const indent = depth * 5;
    doc.setFontSize(11);
    doc.setTextColor(...COLORS.text);
    doc.text(`${indent > 0 ? '  '.repeat(depth) : ''}▸ ${icon} ${containerName}`, MARGIN + indent, y);

    // Container value
    const cVal = Brain.getContainerValue(roomId, cId);
    if (cVal.min > 0 || cVal.max > 0) {
      doc.setFontSize(8);
      doc.setTextColor(...COLORS.lightText);
      doc.text(formatRange(cVal.min, cVal.max), PAGE_W - MARGIN, y, { align: 'right' });
    }
    y += 4;

    // Update progress
    incProcessed();
    const pct = progressBase + (getProcessed() * progressPerContainer);
    onProgress?.(pct, `${containerName} – Lade Daten...`);

    // Container photo
    if (options.containerPhotos) {
      const photoKey = Brain.getLatestPhotoKey(roomId, cId);
      if (photoKey) {
        onProgress?.(pct, `${containerName} – Lade Foto...`);
        const dataUrl = await loadPhotoAsDataUrl(photoKey);
        if (dataUrl) {
          const compressed = await compressImage(dataUrl, 1200, 900, 0.7);
          if (compressed) {
            y = checkPageBreakGlobal(doc, y, 55);
            try {
              doc.addImage(compressed, 'JPEG', MARGIN + indent, y, 80, 60);
              // Photo timestamp
              const photoTs = photoKey.split('_').pop();
              if (photoTs && !isNaN(Number(photoTs))) {
                doc.setFontSize(7);
                doc.setTextColor(...COLORS.lightText);
                doc.text(`Aufgenommen am ${Brain.formatDate(Number(photoTs))}`, MARGIN + indent, y + 63);
              }
              y += 66;
            } catch(err) {
              console.warn('Foto konnte nicht in PDF eingebettet werden:', err.message);
              doc.setFontSize(8);
              doc.setTextColor(...COLORS.lightText);
              doc.text('[Foto konnte nicht eingebettet werden]', MARGIN + indent + 2, y + 5);
              y += 10;
            }
          }
        }
      } else {
        doc.setFontSize(8);
        doc.setTextColor(...COLORS.error);
        doc.text('[Kein Foto vorhanden – Besitznachweis fehlt]', MARGIN + indent + 2, y + 2);
        y += 7;
      }
    }

    // Items table
    if (activeItems.length > 0) {
      const tableData = [];
      for (const item of activeItems) {
        const name = Brain.getItemName(item);
        const menge = typeof item === 'string' ? 1 : (item.menge || 1);
        const mengeStr = menge > 1 ? `${menge}x` : '1';

        let valueStr = '– €';
        let hasReceipt = false;
        if (typeof item === 'object') {
          if (item.purchase?.price != null) {
            valueStr = `${formatCurrency(item.purchase.price)} ✓`;
            hasReceipt = !!item.purchase.receipt_photo_key;
          } else if (item.valuation?.replacement_value != null) {
            const v = item.valuation;
            if (v.replacement_range_min && v.replacement_range_max) {
              valueStr = `~${Math.round(v.replacement_range_min)}–${Math.round(v.replacement_range_max)} €`;
            } else {
              valueStr = `~${Math.round(v.replacement_value)} €`;
            }
          }
        }

        let extra = '';
        if (typeof item === 'object') {
          if (item.valuation?.model_recognized) extra += item.valuation.model_recognized;
          if (item.purchase?.warranty_expires) {
            const now = new Date(); now.setHours(0, 0, 0, 0);
            const exp = new Date(item.purchase.warranty_expires); exp.setHours(0, 0, 0, 0);
            const daysLeft = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
            if (daysLeft > 0) {
              extra += (extra ? ' | ' : '') + `Garantie bis ${formatDateDE(item.purchase.warranty_expires)}`;
            }
          }
        }

        tableData.push([name + (extra ? `\n${extra}` : ''), mengeStr, valueStr]);
      }

      y = checkPageBreakGlobal(doc, y, 20);

      doc.autoTable({
        startY: y,
        head: [['Gegenstand', 'Menge', 'Wert']],
        body: tableData,
        margin: { left: MARGIN + indent, right: MARGIN },
        styles: { fontSize: 8, textColor: COLORS.text, cellPadding: 2, overflow: 'linebreak' },
        headStyles: { fillColor: COLORS.border, textColor: COLORS.text, fontStyle: 'bold', fontSize: 8 },
        alternateRowStyles: { fillColor: [250, 247, 244] },
        columnStyles: {
          0: { cellWidth: CONTENT_W - indent - 35 },
          1: { cellWidth: 15, halign: 'center' },
          2: { cellWidth: 20, halign: 'right' }
        }
      });

      y = doc.lastAutoTable.finalY + 3;

      // Container subtotal
      if (cVal.min > 0 || cVal.max > 0) {
        doc.setFontSize(8);
        doc.setTextColor(...COLORS.lightText);
        doc.text(`Bereichswert: ${formatRange(cVal.min, cVal.max)}`, PAGE_W - MARGIN, y, { align: 'right' });
        y += 5;
      }
    }

    // Receipt photos inline (optional)
    if (options.receiptPhotos) {
      for (const item of activeItems) {
        if (typeof item !== 'object' || !item.purchase?.receipt_photo_key) continue;
        y = checkPageBreakGlobal(doc, y, 35);
        const receiptUrl = await loadPhotoAsDataUrl(item.purchase.receipt_photo_key);
        if (receiptUrl) {
          const compressed = await compressImage(receiptUrl, 600, 400, 0.6);
          if (compressed) {
            try {
              doc.addImage(compressed, 'JPEG', MARGIN + indent + 2, y, 40, 30);
              doc.setFontSize(7);
              doc.setTextColor(...COLORS.lightText);
              const dateLabel = item.purchase.date ? `Kaufbeleg vom ${formatDateDE(item.purchase.date)}` : 'Kaufbeleg';
              doc.text(dateLabel, MARGIN + indent + 44, y + 5);
              doc.text(Brain.getItemName(item), MARGIN + indent + 44, y + 10);
              y += 33;
            } catch(err) { console.warn('Kassenbon konnte nicht eingebettet werden:', err.message); }
          }
        }
      }
    }

    y += 5;

    // Recurse into children
    if (c.containers) {
      y = await renderContainers(doc, roomId, c.containers, y, depth + 1, options, onProgress, progressBase, progressPerContainer, incProcessed, getProcessed);
    }
  }

  return y;
}

function checkPageBreakGlobal(doc, y, needed) {
  const PAGE_H = 297;
  if (y + needed > PAGE_H - 20) {
    // Add footer to current page
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.lightText);
    doc.text(`ORDO Inventarbericht – ${todayDE()}`, 15, PAGE_H - 8);
    doc.addPage();
    return 20;
  }
  return y;
}
