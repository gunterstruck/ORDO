// item-detail.js – Item Detail Panel (extracted from brain-view.js)

import Brain from './brain.js';
import { escapeHTML, showView, debugLog } from './app.js';
import { showToast, showInputModal, showConfirmModal } from './modal.js';
import { analyzeReceipt, estimateSingleItemValue, detectExpiryDate } from './ai.js';
import { requestOverlay, releaseOverlay } from './overlay-manager.js';
import { sendChatMessage } from './chat.js';
import { capturePhoto } from './camera.js';

// Lazy import to avoid circular dependency
let _showLightbox = null;
async function getLightbox() {
  if (!_showLightbox) {
    const mod = await import('./brain-view.js');
    _showLightbox = mod.showLightbox;
  }
  return _showLightbox;
}

function formatDateDE(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return dateStr;
}

let _reviewFieldCounter = 0;
function createReviewField(label, defaultValue, type) {
  const field = document.createElement('div');
  field.className = 'receipt-review-field';
  const fieldId = `receipt-review-${_reviewFieldCounter++}`;
  const lbl = document.createElement('label');
  lbl.className = 'receipt-review-label';
  lbl.textContent = label;
  lbl.setAttribute('for', fieldId);
  field.appendChild(lbl);
  const input = document.createElement('input');
  input.className = 'receipt-review-input';
  input.id = fieldId;
  input.type = type || 'text';
  input.value = defaultValue || '';
  if (type === 'number') input.step = 'any';
  field.appendChild(input);
  return field;
}

export function showItemDetailPanel(roomId, containerId, itemName) {
  const container = Brain.getContainer(roomId, containerId);
  const room = Brain.getRoom(roomId);
  if (!container || !room) return;

  const item = (container.items || []).find(i => Brain.getItemName(i) === itemName);
  if (!item) return;

  if (!requestOverlay('item-detail', 60, () => {
    document.getElementById('item-detail-panel')?.remove();
    releaseOverlay('item-detail');
  })) return;

  // Remove existing panel
  const existing = document.getElementById('item-detail-panel');
  if (existing) existing.remove();

  const panel = document.createElement('div');
  panel.id = 'item-detail-panel';
  panel.className = 'item-detail-panel';

  const overlay = document.createElement('div');
  overlay.className = 'item-detail-overlay';
  overlay.addEventListener('click', () => { panel.remove(); releaseOverlay('item-detail'); });

  const sheet = document.createElement('div');
  sheet.className = 'item-detail-sheet';

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'item-detail-close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => { panel.remove(); releaseOverlay('item-detail'); });
  sheet.appendChild(closeBtn);

  // Item name
  const title = document.createElement('h2');
  title.className = 'item-detail-title';
  title.textContent = itemName;
  sheet.appendChild(title);

  // Location breadcrumb
  const path = Brain.getContainerPath(roomId, containerId);
  const pathNames = path.map(cId => Brain.getContainer(roomId, cId)?.name || cId);
  const loc = document.createElement('div');
  loc.className = 'item-detail-location';
  loc.textContent = `${room.emoji} ${room.name} → ${pathNames.join(' → ')}`;
  sheet.appendChild(loc);

  // Status section
  const statusSection = document.createElement('div');
  statusSection.className = 'item-detail-section';

  const itemObj = typeof item === 'object' ? item : { name: item, status: 'aktiv' };
  const statusEmoji = itemObj.status === 'aktiv' ? '✅' : itemObj.status === 'vermisst' ? '⚠️' : '📦';

  const fields = [
    ['Status', `${itemObj.status} ${statusEmoji}`],
    ['Menge', String(itemObj.menge || 1)],
  ];
  if (itemObj.first_seen) fields.push(['Erstmals gesehen', Brain.formatDate(new Date(itemObj.first_seen).getTime())]);
  if (itemObj.last_seen) fields.push(['Zuletzt bestätigt', Brain.formatDate(new Date(itemObj.last_seen).getTime())]);
  if (itemObj.seen_count) fields.push(['Bestätigt', `${itemObj.seen_count}× per Foto`]);

  fields.forEach(([label, value]) => {
    const field = document.createElement('div');
    field.className = 'item-detail-field';
    field.innerHTML = `<span class="item-detail-label">${escapeHTML(label)}</span><span class="item-detail-value">${escapeHTML(value)}</span>`;
    statusSection.appendChild(field);
  });
  sheet.appendChild(statusSection);

  // Purchase & Warranty section
  const purchaseSection = document.createElement('div');
  purchaseSection.className = 'item-detail-section';
  const purchaseHeader = document.createElement('div');
  purchaseHeader.className = 'item-detail-section-header';
  purchaseHeader.textContent = 'Kauf & Garantie';
  purchaseSection.appendChild(purchaseHeader);

  const purchaseContent = document.createElement('div');
  purchaseContent.className = 'item-detail-purchase-content';

  if (itemObj.purchase && (itemObj.purchase.date || itemObj.purchase.price || itemObj.purchase.warranty_expires)) {
    renderPurchaseDetails(purchaseContent, itemObj, roomId, containerId, itemName, panel);
  } else {
    renderPurchaseEmpty(purchaseContent, roomId, containerId, itemName, panel);
  }

  purchaseSection.appendChild(purchaseContent);
  sheet.appendChild(purchaseSection);

  // Expiry / Verfallsdaten section
  if (itemObj.expiry?.date) {
    const expirySection = document.createElement('div');
    expirySection.className = 'item-detail-section';
    const expiryHeader = document.createElement('div');
    expiryHeader.className = 'item-detail-section-header';
    expiryHeader.textContent = 'Verfallsdatum';
    expirySection.appendChild(expiryHeader);

    const expiryContent = document.createElement('div');
    expiryContent.className = 'expiry-detail-section';
    renderExpiryDetailSection(expiryContent, itemObj, roomId, containerId, itemName, panel);
    expirySection.appendChild(expiryContent);
    sheet.appendChild(expirySection);
  }

  // Valuation section
  const valuationSection = document.createElement('div');
  valuationSection.className = 'item-detail-section';
  const valuationHeader = document.createElement('div');
  valuationHeader.className = 'item-detail-section-header';
  valuationHeader.textContent = 'Wert';
  valuationSection.appendChild(valuationHeader);

  const valuationContent = document.createElement('div');
  valuationContent.className = 'item-detail-valuation-content';
  renderValuationSection(valuationContent, itemObj, roomId, containerId, itemName, panel);
  valuationSection.appendChild(valuationContent);
  sheet.appendChild(valuationSection);

  // Actions section
  const actionsSection = document.createElement('div');
  actionsSection.className = 'item-detail-section';
  const actionsHeader = document.createElement('div');
  actionsHeader.className = 'item-detail-section-header';
  actionsHeader.textContent = 'Aktionen';
  actionsSection.appendChild(actionsHeader);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'item-detail-actions';

  // Chat action
  const chatBtn = document.createElement('button');
  chatBtn.className = 'item-detail-action-btn';
  chatBtn.textContent = '💬 Im Chat fragen';
  chatBtn.addEventListener('click', () => {
    panel.remove();
    releaseOverlay('item-detail');
    showView('chat');
    const input = document.getElementById('chat-input');
    input.value = `Wo ist die ${itemName}?`;
    setTimeout(() => sendChatMessage(), 100);
  });
  actionsRow.appendChild(chatBtn);

  // Archive action
  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'item-detail-action-btn item-detail-action-btn--danger';
  archiveBtn.textContent = '🗑️ Archivieren';
  archiveBtn.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Archivieren',
      description: `"${itemName}" archivieren?`,
      confirmLabel: 'Archivieren'
    });
    if (ok) {
      Brain.archiveItem(roomId, containerId, itemName);
      showToast(`"${itemName}" archiviert`);
      panel.remove();
      releaseOverlay('item-detail');
    }
  });
  actionsRow.appendChild(archiveBtn);

  actionsSection.appendChild(actionsRow);
  sheet.appendChild(actionsSection);

  panel.appendChild(overlay);
  panel.appendChild(sheet);
  document.body.appendChild(panel);

  // Animate in
  requestAnimationFrame(() => {
    panel.classList.add('item-detail-panel--visible');
  });
}

function renderValuationSection(container, item, roomId, containerId, itemName, panel) {
  const v = item.valuation;

  if (v && v.replacement_value != null) {
    const valueField = document.createElement('div');
    valueField.className = 'item-detail-field';
    let valueText = '💰 Wiederbeschaffungswert: ';
    if (v.replacement_range_min && v.replacement_range_max) {
      valueText += `~${Math.round(v.replacement_range_min)}–${Math.round(v.replacement_range_max)} €`;
    } else {
      valueText += `~${Math.round(v.replacement_value)} €`;
    }
    const sourceLabel = v.source === 'photo_ai' ? 'KI-Schätzung (Foto)' : v.source === 'batch_ai' ? 'KI-Schätzung' : 'Manuell';
    const dateStr = v.estimated_at ? ` vom ${formatDateDE(v.estimated_at.slice(0, 10))}` : '';
    valueText += `\n   (${sourceLabel}${dateStr})`;
    if (v.model_recognized) {
      valueText += `\n   Erkannt als: ${v.model_recognized}`;
    }
    valueField.style.whiteSpace = 'pre-line';
    valueField.textContent = valueText;
    container.appendChild(valueField);

    if (item.purchase?.price != null) {
      const priceField = document.createElement('div');
      priceField.className = 'item-detail-field';
      priceField.textContent = `🛒 Kaufpreis: ${Number(item.purchase.price).toFixed(2).replace('.', ',')} € (Beleg vorhanden)`;
      container.appendChild(priceField);
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'item-detail-purchase-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'item-detail-action-btn';
    editBtn.textContent = '✏️ Bearbeiten';
    editBtn.addEventListener('click', () => {
      showManualValuationInput(roomId, containerId, itemName, v.replacement_value, panel);
    });
    btnRow.appendChild(editBtn);

    const reEstBtn = document.createElement('button');
    reEstBtn.className = 'item-detail-action-btn';
    reEstBtn.textContent = '🔄 Neu schätzen';
    reEstBtn.addEventListener('click', () => {
      aiEstimateItemValue(roomId, containerId, itemName, panel);
    });
    btnRow.appendChild(reEstBtn);

    container.appendChild(btnRow);
  } else if (item.purchase?.price != null) {
    const priceField = document.createElement('div');
    priceField.className = 'item-detail-field';
    priceField.textContent = `🛒 Kaufpreis: ${Number(item.purchase.price).toFixed(2).replace('.', ',')} € (Beleg vorhanden)`;
    container.appendChild(priceField);
  } else {
    const hint = document.createElement('p');
    hint.className = 'item-detail-empty-hint';
    hint.textContent = 'Noch kein Wert hinterlegt';
    container.appendChild(hint);

    const estimateBtn = document.createElement('button');
    estimateBtn.className = 'item-detail-action-btn';
    estimateBtn.textContent = '💰 Wert schätzen lassen';
    estimateBtn.addEventListener('click', () => {
      aiEstimateItemValue(roomId, containerId, itemName, panel);
    });
    container.appendChild(estimateBtn);

    const manualBtn = document.createElement('button');
    manualBtn.className = 'item-detail-action-btn';
    manualBtn.textContent = '✏️ Wert manuell eingeben';
    manualBtn.addEventListener('click', () => {
      showManualValuationInput(roomId, containerId, itemName, null, panel);
    });
    container.appendChild(manualBtn);
  }
}

async function aiEstimateItemValue(roomId, containerId, itemName, panel) {
  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    showToast('Kein API Key hinterlegt', 'error');
    return;
  }

  showToast('Schätze Wert...');

  try {
    const photoKey = Brain.getLatestPhotoKey(roomId, containerId);
    let result;

    if (photoKey) {
      const blob = await Brain.getPhoto(photoKey);
      if (blob) {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(new Error('Foto konnte nicht gelesen werden'));
          reader.readAsDataURL(blob);
        });
        result = await estimateSingleItemValue(apiKey, base64, itemName);
      }
    }

    if (!result) {
      const { batchEstimateValues } = await import('./ai.js');
      const roomObj = Brain.getRoom(roomId);
      const containerObj = Brain.getContainer(roomId, containerId);
      const batch = await batchEstimateValues(apiKey, [{
        name: itemName, menge: 1,
        roomName: roomObj?.name || roomId,
        containerName: containerObj?.name || containerId
      }]);
      if (batch.length > 0) {
        result = batch[0];
        result.source = 'batch_ai';
      }
    }

    if (result && result.replacement_value != null) {
      Brain.setValuation(roomId, containerId, itemName, {
        replacement_value: result.replacement_value,
        replacement_range_min: Array.isArray(result.replacement_range) ? result.replacement_range[0] : null,
        replacement_range_max: Array.isArray(result.replacement_range) ? result.replacement_range[1] : null,
        source: result.source || 'photo_ai',
        model_recognized: result.brand_model || null
      });
      showToast('Wert geschätzt ✓');
      panel.remove();
      releaseOverlay('item-detail');
      showItemDetailPanel(roomId, containerId, itemName);
    } else {
      showToast('Keine Schätzung möglich', 'error');
    }
  } catch (err) {
    showToast('Schätzung fehlgeschlagen', 'error');
    debugLog(`Wertschätzung fehlgeschlagen: ${err.message}`);
  }
}

function showManualValuationInput(roomId, containerId, itemName, currentValue, panel) {
  showInputModal({
    title: 'Wiederbeschaffungswert',
    description: `Wie viel würde "${itemName}" heute neu kosten?`,
    placeholder: 'z.B. 120',
    type: 'number',
    value: currentValue ? String(currentValue) : '',
    confirmLabel: 'Speichern'
  }).then(value => {
    if (value === null || value === undefined) return;
    const numVal = parseFloat(String(value).replace(',', '.'));
    if (isNaN(numVal) || numVal < 0) {
      showToast('Ungültiger Wert', 'error');
      return;
    }
    Brain.setValuation(roomId, containerId, itemName, {
      replacement_value: numVal,
      replacement_range_min: numVal,
      replacement_range_max: numVal,
      source: 'manual'
    });
    showToast('Wert gespeichert ✓');
    panel.remove();
    releaseOverlay('item-detail');
    showItemDetailPanel(roomId, containerId, itemName);
  });
}

function renderPurchaseDetails(container, item, roomId, containerId, itemName, panel) {
  const p = item.purchase;

  if (p.date) {
    const dateField = document.createElement('div');
    dateField.className = 'item-detail-field';
    let dateText = `🛒 Gekauft am ${formatDateDE(p.date)}`;
    if (p.store) dateText += `\n     bei ${p.store}`;
    if (p.price != null) dateText += `\n     für ${Number(p.price).toFixed(2).replace('.', ',')} €`;
    dateField.style.whiteSpace = 'pre-line';
    dateField.textContent = dateText;
    container.appendChild(dateField);
  }

  if (p.warranty_expires) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const expires = new Date(p.warranty_expires);
    expires.setHours(0, 0, 0, 0);
    const daysLeft = Math.ceil((expires - now) / (1000 * 60 * 60 * 24));

    const warrantyField = document.createElement('div');
    warrantyField.className = 'item-detail-field';

    if (daysLeft < 0) {
      warrantyField.classList.add('item-detail-warranty--expired');
      warrantyField.textContent = `❌ Garantie abgelaufen seit ${Math.abs(daysLeft)} Tagen\n     (am ${formatDateDE(p.warranty_expires)})`;
    } else if (daysLeft <= 30) {
      warrantyField.classList.add('item-detail-warranty--warning');
      warrantyField.textContent = `⚠️ Garantie läuft in ${daysLeft} Tagen ab!\n     (am ${formatDateDE(p.warranty_expires)})`;
    } else {
      warrantyField.textContent = `🛡️ Garantie bis ${formatDateDE(p.warranty_expires)}\n     (noch ${daysLeft} Tage)`;
    }
    warrantyField.style.whiteSpace = 'pre-line';
    container.appendChild(warrantyField);
  }

  if (p.notes) {
    const notesField = document.createElement('div');
    notesField.className = 'item-detail-field item-detail-notes';
    notesField.textContent = `📝 ${p.notes}`;
    container.appendChild(notesField);
  }

  if (p.receipt_photo_key) {
    const receiptBtn = document.createElement('button');
    receiptBtn.className = 'item-detail-action-btn';
    receiptBtn.textContent = '📄 Kassenbon ansehen';
    receiptBtn.addEventListener('click', async () => {
      const blob = await Brain.getReceiptPhoto(p.receipt_photo_key);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const showLb = await getLightbox();
        showLb(url);
      } else {
        showToast('Kassenbon nicht gefunden', 'error');
      }
    });
    container.appendChild(receiptBtn);
  }

  const btnRow = document.createElement('div');
  btnRow.className = 'item-detail-purchase-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'item-detail-action-btn';
  editBtn.textContent = '✏️ Bearbeiten';
  editBtn.addEventListener('click', () => {
    showManualPurchaseForm(roomId, containerId, itemName, item.purchase, panel);
  });
  btnRow.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'item-detail-action-btn item-detail-action-btn--danger';
  deleteBtn.textContent = '🗑️ Daten löschen';
  deleteBtn.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Kaufdaten löschen',
      description: `Kaufdaten und Kassenbon für "${itemName}" wirklich löschen?`,
      confirmLabel: 'Löschen',
      danger: true
    });
    if (ok) {
      Brain.deletePurchaseData(roomId, containerId, itemName);
      showToast('Kaufdaten gelöscht');
      panel.remove();
      releaseOverlay('item-detail');
    }
  });
  btnRow.appendChild(deleteBtn);
  container.appendChild(btnRow);
}

function renderPurchaseEmpty(container, roomId, containerId, itemName, panel) {
  const hint = document.createElement('p');
  hint.className = 'item-detail-empty-hint';
  hint.textContent = 'Noch keine Kaufdaten hinterlegt';
  container.appendChild(hint);

  const receiptBtn = document.createElement('button');
  receiptBtn.className = 'item-detail-action-btn';
  receiptBtn.textContent = '📄 Kassenbon fotografieren';
  receiptBtn.addEventListener('click', () => {
    startReceiptCapture(roomId, containerId, itemName, panel);
  });
  container.appendChild(receiptBtn);

  const manualBtn = document.createElement('button');
  manualBtn.className = 'item-detail-action-btn';
  manualBtn.textContent = '✏️ Manuell eingeben';
  manualBtn.addEventListener('click', () => {
    showManualPurchaseForm(roomId, containerId, itemName, null, panel);
  });
  container.appendChild(manualBtn);
}

async function startReceiptCapture(roomId, containerId, itemName, panel) {
  try {
    const file = await capturePhoto();
    if (!file) return;

    showToast('Lese Kassenbon...', 'loading', 10000);

    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const base64Data = result.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const apiKey = Brain.getApiKey();
    if (!apiKey) {
      showToast('Kein API Key hinterlegt', 'error');
      return;
    }

    const result = await analyzeReceipt(apiKey, base64, itemName);

    const loadingToasts = document.querySelectorAll('.toast--loading');
    loadingToasts.forEach(t => t.remove());

    if (result.error) {
      showToast(result.error, 'error');
      return;
    }

    showReceiptReviewForm(roomId, containerId, itemName, result, file, panel);
  } catch (err) {
    const loadingToasts = document.querySelectorAll('.toast--loading');
    loadingToasts.forEach(t => t.remove());
    showToast('Bon-Erkennung fehlgeschlagen: ' + err.message, 'error');
  }
}

function showReceiptReviewForm(roomId, containerId, itemName, aiResult, photoFile, parentPanel) {
  if (parentPanel) parentPanel.remove();

  const panel = document.createElement('div');
  panel.id = 'item-detail-panel';
  panel.className = 'item-detail-panel item-detail-panel--visible';

  const overlay = document.createElement('div');
  overlay.className = 'item-detail-overlay';
  overlay.addEventListener('click', () => { panel.remove(); releaseOverlay('item-detail'); });

  const sheet = document.createElement('div');
  sheet.className = 'item-detail-sheet';

  const title = document.createElement('h2');
  title.className = 'item-detail-title';
  title.textContent = 'Kassenbon erkannt';
  sheet.appendChild(title);

  if (aiResult.confidence) {
    const conf = document.createElement('div');
    conf.className = 'receipt-review-confidence';
    conf.textContent = `Erkennungsqualität: ${aiResult.confidence}`;
    sheet.appendChild(conf);
  }

  if (aiResult.hinweis) {
    const hint = document.createElement('div');
    hint.className = 'receipt-review-hint';
    hint.textContent = `💡 ${aiResult.hinweis}`;
    sheet.appendChild(hint);
  }

  const form = document.createElement('div');
  form.className = 'receipt-review';

  const dateField = createReviewField('Kaufdatum', aiResult.date || '', 'date');
  form.appendChild(dateField);

  const priceField = createReviewField('Preis (€)', aiResult.price != null ? String(aiResult.price) : '', 'number');
  form.appendChild(priceField);

  const storeField = createReviewField('Geschäft', aiResult.store || '', 'text');
  form.appendChild(storeField);

  const warrantyField = createReviewField('Garantie (Monate)', aiResult.warranty_hint ? '' : '24', 'number');
  form.appendChild(warrantyField);

  if (aiResult.warranty_hint) {
    const wHint = document.createElement('div');
    wHint.className = 'receipt-review-hint';
    wHint.textContent = `🛡️ ${aiResult.warranty_hint}`;
    form.appendChild(wHint);
  }

  const notesField = createReviewField('Notizen', '', 'text');
  form.appendChild(notesField);

  const expiryPreview = document.createElement('div');
  expiryPreview.className = 'receipt-review-expiry';
  function updateExpiryPreview() {
    const dateVal = dateField.querySelector('input').value;
    const monthsVal = parseInt(warrantyField.querySelector('input').value);
    if (dateVal && monthsVal > 0) {
      const d = new Date(dateVal);
      d.setMonth(d.getMonth() + monthsVal);
      expiryPreview.textContent = `Garantie läuft ab am ${formatDateDE(d.toISOString().slice(0, 10))}`;
    } else {
      expiryPreview.textContent = '';
    }
  }
  dateField.querySelector('input').addEventListener('input', updateExpiryPreview);
  warrantyField.querySelector('input').addEventListener('input', updateExpiryPreview);
  updateExpiryPreview();
  form.appendChild(expiryPreview);

  sheet.appendChild(form);

  const btnRow = document.createElement('div');
  btnRow.className = 'receipt-review-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'item-detail-action-btn';
  cancelBtn.textContent = 'Abbrechen';
  cancelBtn.addEventListener('click', () => { panel.remove(); releaseOverlay('item-detail'); });
  btnRow.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'item-detail-action-btn item-detail-action-btn--primary';
  saveBtn.textContent = 'Speichern';
  saveBtn.addEventListener('click', async () => {
    const dateVal = dateField.querySelector('input').value || null;
    const priceVal = priceField.querySelector('input').value ? parseFloat(priceField.querySelector('input').value) : null;
    const storeVal = storeField.querySelector('input').value || null;
    const monthsVal = warrantyField.querySelector('input').value ? parseInt(warrantyField.querySelector('input').value) : null;
    const notesVal = notesField.querySelector('input').value || null;

    const purchaseData = {};
    if (dateVal) purchaseData.date = dateVal;
    if (priceVal != null) purchaseData.price = priceVal;
    if (storeVal) purchaseData.store = storeVal;
    if (monthsVal) purchaseData.warranty_months = monthsVal;
    if (notesVal) purchaseData.notes = notesVal;

    if (photoFile) {
      await Brain.saveReceiptPhoto(roomId, containerId, itemName, photoFile);
    }

    Brain.setPurchaseData(roomId, containerId, itemName, purchaseData);

    showToast('Kassenbon gespeichert ✓');
    panel.remove();
  });
  btnRow.appendChild(saveBtn);

  sheet.appendChild(btnRow);
  panel.appendChild(overlay);
  panel.appendChild(sheet);
  document.body.appendChild(panel);
}

function showManualPurchaseForm(roomId, containerId, itemName, existingPurchase, parentPanel) {
  if (parentPanel) parentPanel.remove();

  const panel = document.createElement('div');
  panel.id = 'item-detail-panel';
  panel.className = 'item-detail-panel item-detail-panel--visible';

  const overlay = document.createElement('div');
  overlay.className = 'item-detail-overlay';
  overlay.addEventListener('click', () => { panel.remove(); releaseOverlay('item-detail'); });

  const sheet = document.createElement('div');
  sheet.className = 'item-detail-sheet';

  const title = document.createElement('h2');
  title.className = 'item-detail-title';
  title.textContent = existingPurchase ? 'Kaufdaten bearbeiten' : 'Kaufdaten eingeben';
  sheet.appendChild(title);

  const form = document.createElement('div');
  form.className = 'receipt-review';

  const p = existingPurchase || {};

  const dateField = createReviewField('Kaufdatum', p.date || '', 'date');
  form.appendChild(dateField);

  const priceField = createReviewField('Preis (€)', p.price != null ? String(p.price) : '', 'number');
  form.appendChild(priceField);

  const storeField = createReviewField('Geschäft', p.store || '', 'text');
  form.appendChild(storeField);

  const warrantyField = createReviewField('Garantie (Monate)', p.warranty_months ? String(p.warranty_months) : '24', 'number');
  form.appendChild(warrantyField);

  const notesField = createReviewField('Notizen', p.notes || '', 'text');
  form.appendChild(notesField);

  const expiryPreview = document.createElement('div');
  expiryPreview.className = 'receipt-review-expiry';
  function updateExpiryPreview() {
    const dateVal = dateField.querySelector('input').value;
    const monthsVal = parseInt(warrantyField.querySelector('input').value);
    if (dateVal && monthsVal > 0) {
      const d = new Date(dateVal);
      d.setMonth(d.getMonth() + monthsVal);
      expiryPreview.textContent = `Garantie läuft ab am ${formatDateDE(d.toISOString().slice(0, 10))}`;
    } else {
      expiryPreview.textContent = '';
    }
  }
  dateField.querySelector('input').addEventListener('input', updateExpiryPreview);
  warrantyField.querySelector('input').addEventListener('input', updateExpiryPreview);
  updateExpiryPreview();
  form.appendChild(expiryPreview);

  sheet.appendChild(form);

  const btnRow = document.createElement('div');
  btnRow.className = 'receipt-review-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'item-detail-action-btn';
  cancelBtn.textContent = 'Abbrechen';
  cancelBtn.addEventListener('click', () => { panel.remove(); releaseOverlay('item-detail'); });
  btnRow.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'item-detail-action-btn item-detail-action-btn--primary';
  saveBtn.textContent = 'Speichern';
  saveBtn.addEventListener('click', () => {
    const dateVal = dateField.querySelector('input').value || null;
    const priceVal = priceField.querySelector('input').value ? parseFloat(priceField.querySelector('input').value) : null;
    const storeVal = storeField.querySelector('input').value || null;
    const monthsVal = warrantyField.querySelector('input').value ? parseInt(warrantyField.querySelector('input').value) : null;
    const notesVal = notesField.querySelector('input').value || null;

    const purchaseData = {};
    if (dateVal) purchaseData.date = dateVal;
    if (priceVal != null) purchaseData.price = priceVal;
    if (storeVal) purchaseData.store = storeVal;
    if (monthsVal) purchaseData.warranty_months = monthsVal;
    if (notesVal) purchaseData.notes = notesVal;

    Brain.setPurchaseData(roomId, containerId, itemName, purchaseData);
    showToast('Kaufdaten gespeichert ✓');
    panel.remove();
  });
  btnRow.appendChild(saveBtn);

  sheet.appendChild(btnRow);
  panel.appendChild(overlay);
  panel.appendChild(sheet);
  document.body.appendChild(panel);
}

// ── Expiry Detail Section ────────────────────────────

function getExpiryStatusLocal(daysUntil) {
  if (daysUntil < 0) return { cls: 'expired', label: `Abgelaufen seit ${Math.abs(daysUntil)} Tagen`, icon: '🔴' };
  if (daysUntil <= 7) return { cls: 'critical', label: `Noch ${daysUntil} Tage`, icon: '🔴' };
  if (daysUntil <= 30) return { cls: 'warning', label: `Noch ${daysUntil} Tage`, icon: '🟡' };
  if (daysUntil <= 90) return { cls: 'upcoming', label: `Noch ${Math.round(daysUntil / 30)} Monate`, icon: '🟢' };
  return { cls: 'ok', label: `Noch ${Math.round(daysUntil / 30)} Monate`, icon: '🟢' };
}

function formatExpiryDateDE(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 2) return `${parts[1]}/${parts[0]}`;
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return dateStr;
}

function renderExpiryDetailSection(container, item, roomId, containerId, itemName, panel) {
  const expiry = item.expiry;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const expiryDate = new Date(expiry.date);
  expiryDate.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((expiryDate - now) / (1000 * 60 * 60 * 24));

  const status = getExpiryStatusLocal(daysUntil);

  const dateEl = document.createElement('div');
  dateEl.className = 'expiry-detail-date';
  dateEl.textContent = `⏰ MHD: ${formatExpiryDateDE(expiry.date)}`;
  container.appendChild(dateEl);

  const statusEl = document.createElement('div');
  statusEl.className = `expiry-status ${status.cls}`;
  statusEl.textContent = `${status.icon} ${status.label}`;
  container.appendChild(statusEl);

  if (expiry.detected_at) {
    const sourceEl = document.createElement('div');
    sourceEl.className = 'expiry-detail-source';
    const sourceLabel = expiry.source === 'photo_ai' ? 'Erkannt per Foto' : 'Manuell eingegeben';
    const dateStr = expiry.detected_at.slice(0, 10).split('-').reverse().join('.');
    sourceEl.textContent = `${sourceLabel} am ${dateStr}`;
    container.appendChild(sourceEl);
  }

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;';

  const photoBtn = document.createElement('button');
  photoBtn.className = 'item-detail-action-btn';
  photoBtn.textContent = '📷 Datum aktualisieren';
  photoBtn.addEventListener('click', () => {
    panel.remove();
    releaseOverlay('item-detail');
    import('./warranty-view.js').then(mod => {
      mod.startExpiryPhotoCheck(roomId, containerId, itemName);
    });
  });
  btnRow.appendChild(photoBtn);

  const manualBtn = document.createElement('button');
  manualBtn.className = 'item-detail-action-btn';
  manualBtn.textContent = '✏️ Manuell ändern';
  manualBtn.addEventListener('click', () => {
    editExpiryDate(roomId, containerId, itemName, panel);
  });
  btnRow.appendChild(manualBtn);

  container.appendChild(btnRow);
}

async function editExpiryDate(roomId, containerId, itemName, panel) {
  // Try voice first
  if (window.SpeechRecognition || window.webkitSpeechRecognition) {
    showToast('Sag das Verfallsdatum...', 'info');
    try {
      const spoken = await listenForExpiryDate();
      if (spoken) {
        const parsed = parseGermanDate(spoken);
        if (parsed) {
          Brain.setItemExpiry(roomId, containerId, itemName, {
            date: parsed,
            source: 'manual',
          });
          showToast(`Verfallsdatum: ${formatExpiryDateDE(parsed)}`);
          if (panel) { panel.remove(); releaseOverlay('item-detail'); }
          showItemDetailPanel(roomId, containerId, itemName);
          return;
        }
      }
    } catch { /* voice failed, fall through to datepicker */ }
  }

  // Fallback: native datepicker
  const input = document.createElement('input');
  input.type = 'date';
  input.value = new Date().toISOString().slice(0, 10);
  input.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
  document.body.appendChild(input);

  input.addEventListener('change', () => {
    if (input.value) {
      Brain.setItemExpiry(roomId, containerId, itemName, {
        date: input.value,
        source: 'manual',
      });
      showToast(`Verfallsdatum: ${formatExpiryDateDE(input.value)}`);
      if (panel) { panel.remove(); releaseOverlay('item-detail'); }
      showItemDetailPanel(roomId, containerId, itemName);
    }
    input.remove();
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { if (input.parentNode) input.remove(); }, 300);
  });

  if (input.showPicker) { try { input.showPicker(); } catch { input.click(); } } else { input.click(); }
}

function listenForExpiryDate() {
  return new Promise((resolve, reject) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { reject(new Error('No speech')); return; }

    const recognition = new SpeechRecognition();
    recognition.lang = 'de-DE';
    recognition.maxAlternatives = 1;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      resolve(event.results[0]?.[0]?.transcript || '');
    };
    recognition.onerror = () => resolve(null);
    recognition.start();

    setTimeout(() => {
      try { recognition.stop(); } catch {}
      resolve(null);
    }, 8000);
  });
}

/**
 * Parst deutsche Datumsangaben aus Sprache.
 * "15. September 2026" → "2026-09-15"
 * "September 2026" → "2026-09-01"
 */
export function parseGermanDate(text) {
  const months = {
    januar: '01', februar: '02', 'märz': '03', april: '04',
    mai: '05', juni: '06', juli: '07', august: '08',
    september: '09', oktober: '10', november: '11', dezember: '12',
  };

  const lower = text.toLowerCase().trim();

  // "15. September 2026" or "15 September 2026"
  const fullMatch = lower.match(/(\d{1,2})\.?\s*([a-zäöü]+)\s+(\d{4})/);
  if (fullMatch) {
    const day = fullMatch[1].padStart(2, '0');
    const month = months[fullMatch[2]];
    if (month) return `${fullMatch[3]}-${month}-${day}`;
  }

  // "September 2026"
  const monthYear = lower.match(/([a-zäöü]+)\s+(\d{4})/);
  if (monthYear) {
    const month = months[monthYear[1]];
    if (month) return `${monthYear[2]}-${month}-01`;
  }

  // "09/2026" or "09.2026"
  const numericMatch = lower.match(/(\d{1,2})[\/.](\d{4})/);
  if (numericMatch) {
    const month = numericMatch[1].padStart(2, '0');
    return `${numericMatch[2]}-${month}-01`;
  }

  return null;
}
