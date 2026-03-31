// modal.js – Modal-System (Input/Confirm/Toast)
// Voice-First: Eingabefelder nutzen Spracheingabe als primäre Methode.
// Kein eigener State, rein funktional (Promise-basiert)

import { requestOverlay, releaseOverlay } from './overlay-manager.js';
import { createVoiceField } from './voice-input.js';

export function showToast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast--out');
    toast.addEventListener('animationend', () => toast.remove());
    // Fallback removal in case animationend never fires
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration + 1000);
  }, duration);
}

// showInputModal({ title, description?, fields: [{ label, placeholder, defaultValue?, type?, options? }] }) → Promise<string[]|null>
// Voice-First: Text fields become voice-first fields with mic trigger + suggestion + confirm/reject.
// Select fields and password fields remain unchanged.
export function showInputModal({ title, description, fields }) {
  return new Promise(resolve => {
    if (!requestOverlay('modal-input', 100, () => {
      const modal = document.getElementById('ordo-modal');
      if (modal) modal.style.display = 'none';
      releaseOverlay('modal-input');
      resolve(null);
    })) { resolve(null); return; }

    const modal = document.getElementById('ordo-modal');
    const titleEl = document.getElementById('ordo-modal-title');
    const descEl = document.getElementById('ordo-modal-desc');
    const fieldsEl = document.getElementById('ordo-modal-fields');
    const actionsEl = document.getElementById('ordo-modal-actions');

    titleEl.textContent = title;
    descEl.textContent = description || '';
    fieldsEl.innerHTML = '';
    actionsEl.innerHTML = '';

    const voiceFields = [];

    fields.forEach(f => {
      if (f.label) {
        const label = document.createElement('label');
        label.className = 'ordo-modal-field-label';
        label.textContent = f.label;
        fieldsEl.appendChild(label);
      }

      // Password fields stay as regular inputs (API keys, etc.)
      if (f.type === 'password') {
        const input = document.createElement('input');
        input.className = 'ordo-modal-input';
        input.type = 'password';
        input.placeholder = f.placeholder || '';
        input.value = f.defaultValue || '';
        fieldsEl.appendChild(input);
        voiceFields.push({
          getValue: () => input.value,
          el: input,
          isNative: true,
        });
        return;
      }

      // Select fields and voice-first text fields
      const vf = createVoiceField({
        placeholder: f.placeholder || 'Antippen zum Sprechen…',
        defaultValue: f.defaultValue || '',
        type: f.type,
        options: f.options,
        prompt: 'Ich höre zu…',
      });

      fieldsEl.appendChild(vf.el);
      voiceFields.push(vf);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ordo-modal-btn ordo-modal-btn--cancel';
    cancelBtn.textContent = 'Abbrechen';

    const okBtn = document.createElement('button');
    okBtn.className = 'ordo-modal-btn ordo-modal-btn--primary';
    okBtn.textContent = 'OK';

    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      modal.style.display = 'none';
      modal.removeEventListener('click', onBackdrop);
      voiceFields.forEach(vf => vf.destroy?.());
      releaseOverlay('modal-input');
      resolve(result);
    }

    function onBackdrop(e) {
      if (e.target === modal) close(null);
    }

    cancelBtn.addEventListener('click', () => close(null));
    okBtn.addEventListener('click', () => {
      const values = voiceFields.map(vf => vf.getValue());
      close(values);
    });
    modal.addEventListener('click', onBackdrop);

    // Enter key submits for native inputs
    voiceFields.forEach(vf => {
      if (vf.isNative && vf.el?.tagName === 'INPUT') {
        vf.el.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const values = voiceFields.map(v => v.getValue());
            close(values);
          }
        });
      }
    });

    modal.style.display = 'flex';

    // Auto-trigger voice on the first voice-capable field
    setTimeout(() => {
      const firstVoice = voiceFields.find(vf => vf.focus && !vf.isNative);
      if (firstVoice) {
        firstVoice.focus();
      } else {
        // Fallback: focus first native input
        const firstNative = voiceFields.find(vf => vf.isNative);
        if (firstNative?.el) firstNative.el.focus();
      }
    }, 100);
  });
}

// showConfirmModal({ title, description, confirmLabel?, danger? }) → Promise<boolean>
export function showConfirmModal({ title, description, confirmLabel, danger }) {
  return new Promise(resolve => {
    if (!requestOverlay('modal-confirm', 100, () => {
      const modal = document.getElementById('ordo-modal');
      if (modal) modal.style.display = 'none';
      releaseOverlay('modal-confirm');
      resolve(false);
    })) { resolve(false); return; }

    const modal = document.getElementById('ordo-modal');
    const titleEl = document.getElementById('ordo-modal-title');
    const descEl = document.getElementById('ordo-modal-desc');
    const fieldsEl = document.getElementById('ordo-modal-fields');
    const actionsEl = document.getElementById('ordo-modal-actions');

    titleEl.textContent = title;
    descEl.textContent = description || '';
    fieldsEl.innerHTML = '';
    actionsEl.innerHTML = '';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ordo-modal-btn ordo-modal-btn--cancel';
    cancelBtn.textContent = 'Abbrechen';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = `ordo-modal-btn ${danger ? 'ordo-modal-btn--danger' : 'ordo-modal-btn--primary'}`;
    confirmBtn.textContent = confirmLabel || 'Ja';

    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(confirmBtn);

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      modal.style.display = 'none';
      modal.removeEventListener('click', onBackdrop);
      releaseOverlay('modal-confirm');
      resolve(result);
    }

    function onBackdrop(e) {
      if (e.target === modal) close(false);
    }

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    modal.addEventListener('click', onBackdrop);

    modal.style.display = 'flex';
    setTimeout(() => confirmBtn.focus(), 50);
  });
}
