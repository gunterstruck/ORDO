// modal.js – Modal-System (Input/Confirm/Toast)
// Kein eigener State, rein funktional (Promise-basiert)

import { requestOverlay, releaseOverlay } from './overlay-manager.js';

export function showToast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast--out');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

// showInputModal({ title, description?, fields: [{ label, placeholder, defaultValue?, type? }] }) → Promise<string[]|null>
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

    const inputs = [];
    fields.forEach(f => {
      if (f.label) {
        const label = document.createElement('label');
        label.className = 'ordo-modal-field-label';
        label.textContent = f.label;
        fieldsEl.appendChild(label);
      }
      if (f.type === 'select' && f.options) {
        const select = document.createElement('select');
        select.className = 'ordo-modal-select';
        f.options.forEach(opt => {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          if (opt.value === f.defaultValue) o.selected = true;
          select.appendChild(o);
        });
        fieldsEl.appendChild(select);
        inputs.push(select);
      } else {
        const input = document.createElement('input');
        input.className = 'ordo-modal-input';
        input.type = f.type || 'text';
        input.placeholder = f.placeholder || '';
        input.value = f.defaultValue || '';
        fieldsEl.appendChild(input);
        inputs.push(input);
      }
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ordo-modal-btn ordo-modal-btn--cancel';
    cancelBtn.textContent = 'Abbrechen';

    const okBtn = document.createElement('button');
    okBtn.className = 'ordo-modal-btn ordo-modal-btn--primary';
    okBtn.textContent = 'OK';

    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);

    function close(result) {
      modal.style.display = 'none';
      modal.removeEventListener('click', onBackdrop);
      releaseOverlay('modal-input');
      resolve(result);
    }

    function onBackdrop(e) {
      if (e.target === modal) close(null);
    }

    cancelBtn.addEventListener('click', () => close(null));
    okBtn.addEventListener('click', () => {
      const values = inputs.map(i => i.value);
      close(values);
    });
    modal.addEventListener('click', onBackdrop);

    // Enter key submits
    inputs.forEach(input => {
      if (input.tagName === 'INPUT') {
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const values = inputs.map(i => i.value);
            close(values);
          }
        });
      }
    });

    modal.style.display = 'flex';
    setTimeout(() => inputs[0]?.focus(), 50);
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

    function close(result) {
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
