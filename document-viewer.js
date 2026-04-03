// document-viewer.js – Mini-Modul: Dokument-Viewer mit Pinch-to-Zoom
// Zeigt PDFs (via PDF.js CDN) und Bilder (JPEG/PNG) in einem Modal.

import Brain from './brain.js';
import { requestOverlay, releaseOverlay } from './overlay-manager.js';

// ── PDF.js lazy laden (nur wenn gebraucht) ────────────
let _pdfjs = null;
async function getPdfJs() {
  if (_pdfjs) return _pdfjs;
  // PDF.js über cdnjs — kein Build-System nötig
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
    script.type = 'module';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  // Worker-Pfad setzen
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
  _pdfjs = window.pdfjsLib;
  return _pdfjs;
}

// ── Pinch-to-Zoom Logik ───────────────────────────────
function setupPinchZoom(el) {
  let scale = 1;
  let lastDist = null;
  let offsetX = 0, offsetY = 0;
  let startX = 0, startY = 0;
  let isPinching = false;

  function applyTransform() {
    el.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    el.style.transformOrigin = 'center center';
  }

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      isPinching = true;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastDist = Math.hypot(dx, dy);
    } else if (e.touches.length === 1) {
      startX = e.touches[0].clientX - offsetX;
      startY = e.touches[0].clientY - offsetY;
    }
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && lastDist !== null) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      scale = Math.max(0.5, Math.min(5, scale * (dist / lastDist)));
      lastDist = dist;
      applyTransform();
    } else if (e.touches.length === 1 && !isPinching) {
      offsetX = e.touches[0].clientX - startX;
      offsetY = e.touches[0].clientY - startY;
      applyTransform();
    }
  }, { passive: false });

  el.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      isPinching = false;
      lastDist = null;
    }
    // Reset wenn zu weit rausgezoomt
    if (scale < 1) {
      scale = 1; offsetX = 0; offsetY = 0;
      el.style.transition = 'transform 0.2s ease';
      applyTransform();
      setTimeout(() => { el.style.transition = ''; }, 200);
    }
  }, { passive: true });

  // Doppel-Tap zum Zurücksetzen
  let lastTap = 0;
  el.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      scale = scale > 1.5 ? 1 : 2.5;
      offsetX = 0; offsetY = 0;
      el.style.transition = 'transform 0.25s ease';
      applyTransform();
      setTimeout(() => { el.style.transition = ''; }, 250);
    }
    lastTap = now;
  }, { passive: true });
}

// ── Foto-Anzeige (JPEG/PNG) ───────────────────────────
function renderImageViewer(blob, label) {
  const url = URL.createObjectURL(blob);
  const wrap = document.createElement('div');
  wrap.className = 'docviewer-img-wrap';

  const img = document.createElement('img');
  img.src = url;
  img.className = 'docviewer-img';
  img.draggable = false;
  wrap.appendChild(img);

  setupPinchZoom(img);

  // Cleanup wenn Modal geschlossen wird
  wrap._cleanup = () => URL.revokeObjectURL(url);
  return wrap;
}

// ── PDF-Anzeige ───────────────────────────────────────
async function renderPdfViewer(blob, label, statusEl) {
  const wrap = document.createElement('div');
  wrap.className = 'docviewer-pdf-wrap';

  try {
    const pdfjs = await getPdfJs();
    if (statusEl) statusEl.textContent = 'Lade PDF...';

    const arrayBuffer = await blob.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.8 });

      const canvas = document.createElement('canvas');
      canvas.className = 'docviewer-page';
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
      }).promise;

      wrap.appendChild(canvas);

      if (statusEl && pageNum === 1) {
        statusEl.textContent = '';
      }
    }

    setupPinchZoom(wrap);

  } catch (err) {
    wrap.innerHTML = `<div class="docviewer-error">PDF konnte nicht geladen werden.<br>${err.message}</div>`;
  }

  return wrap;
}

// ── Modal-Builder ─────────────────────────────────────
export async function openDocumentViewer({ blob, mimeType, label }) {
  if (!blob) return;
  if (!requestOverlay('document-viewer', 80, closeDocumentViewer)) return;

  // Altes Modal entfernen
  document.getElementById('document-viewer-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'document-viewer-modal';
  modal.className = 'docviewer-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'docviewer-header';
  header.innerHTML = `
    <span class="docviewer-label">${label || 'Dokument'}</span>
    <button class="docviewer-close" aria-label="Schließen">✕</button>
  `;
  header.querySelector('.docviewer-close').addEventListener('click', closeDocumentViewer);
  modal.appendChild(header);

  // Status
  const status = document.createElement('div');
  status.className = 'docviewer-status';
  status.textContent = 'Lade...';
  modal.appendChild(status);

  // Content-Bereich
  const content = document.createElement('div');
  content.className = 'docviewer-content';
  modal.appendChild(content);

  document.body.appendChild(modal);

  // Swipe-down zum Schließen
  let touchStartY = 0;
  header.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  header.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - touchStartY;
    if (dy > 60) closeDocumentViewer();
  }, { passive: true });

  // Inhalt rendern
  const isPdf = mimeType === 'application/pdf' ||
                (blob.type === 'application/pdf');

  if (isPdf) {
    const viewer = await renderPdfViewer(blob, label, status);
    content.appendChild(viewer);
  } else {
    status.textContent = '';
    const viewer = renderImageViewer(blob, label);
    content.appendChild(viewer);
  }

  // Animate in
  requestAnimationFrame(() => modal.classList.add('docviewer-modal--visible'));
}

export function closeDocumentViewer() {
  const modal = document.getElementById('document-viewer-modal');
  if (!modal) return;
  modal.classList.remove('docviewer-modal--visible');
  setTimeout(() => {
    // Cleanup Object URLs
    modal.querySelector('[data-cleanup]')?._cleanup?.();
    modal.remove();
    releaseOverlay('document-viewer');
  }, 280);
}

// ── Hilfsfunktion: Quittung eines Items öffnen ────────
export async function openReceiptForItem(roomId, containerId, itemName) {
  const item = Brain.getContainer(roomId, containerId)
    ?.items?.find(i => (typeof i === 'string' ? i : i.name) === itemName);

  const receiptKey = item?.purchase?.receipt_photo_key;
  if (!receiptKey) return false;

  const blob = await Brain.getReceiptPhoto(receiptKey);
  if (!blob) return false;

  await openDocumentViewer({
    blob,
    mimeType: blob.type || 'image/jpeg',
    label: `🧾 Kassenbon: ${itemName}`,
  });
  return true;
}

// ── UI-Block für den Dialog-Stream ───────────────────
import { registerBlock } from './ui-blocks.js';

registerBlock('DocumentViewer', (props) => {
  // props: { photoKey?, receiptKey?, label?, mimeType? }
  // Wird vom Agent gerendert wenn Nutzer nach Dokument fragt

  const el = document.createElement('div');
  el.className = 'block-document-viewer-trigger';

  const btn = document.createElement('button');
  btn.className = 'block-docviewer-btn';
  btn.innerHTML = `
    <span class="docviewer-btn-icon">📄</span>
    <span class="docviewer-btn-label">${props.label || 'Dokument anzeigen'}</span>
    <span class="docviewer-btn-hint">Antippen zum Öffnen · Pinch zum Zoomen</span>
  `;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.querySelector('.docviewer-btn-hint').textContent = 'Lade...';

    try {
      let blob = null;
      let mimeType = props.mimeType || 'application/pdf';

      if (props.receiptKey) {
        blob = await Brain.getReceiptPhoto(props.receiptKey);
        mimeType = blob?.type || 'image/jpeg';
      } else if (props.photoKey) {
        blob = await Brain.getPhoto(props.photoKey);
        mimeType = blob?.type || 'image/jpeg';
      }

      if (!blob) {
        btn.querySelector('.docviewer-btn-hint').textContent = 'Dokument nicht gefunden.';
        btn.disabled = false;
        return;
      }

      await openDocumentViewer({ blob, mimeType, label: props.label });
    } catch (err) {
      btn.querySelector('.docviewer-btn-hint').textContent = 'Fehler beim Laden.';
    } finally {
      btn.disabled = false;
      btn.querySelector('.docviewer-btn-hint').textContent =
        'Antippen zum Öffnen · Pinch zum Zoomen';
    }
  });

  el.appendChild(btn);
  return el;
});
