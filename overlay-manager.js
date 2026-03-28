// overlay-manager.js – Zentraler Overlay-Stack zur Koordination aller Overlays

const overlayStack = [];

/**
 * Registriert ein Overlay als aktiv.
 * Gibt false zurück wenn ein höher-priorisiertes Overlay bereits offen ist.
 * @param {string} id - Eindeutiger Name des Overlays
 * @param {number} priority - Höher = wichtiger (Modal > Quest > Dashboard)
 * @param {Function} closeFn - Funktion um das Overlay zu schließen
 * @returns {boolean} true wenn das Overlay geöffnet werden darf
 */
export function requestOverlay(id, priority, closeFn) {
  const current = overlayStack[overlayStack.length - 1];

  if (current && current.id === id) {
    return false;
  }

  if (current && current.priority >= priority) {
    console.warn(`Overlay "${id}" blockiert: "${current.id}" hat Vorrang`);
    return false;
  }

  overlayStack.push({ id, priority, closeFn });
  history.pushState({ overlay: id }, '');
  return true;
}

/**
 * Meldet ein Overlay als geschlossen.
 */
export function releaseOverlay(id) {
  const index = overlayStack.findIndex(o => o.id === id);
  if (index >= 0) {
    overlayStack.splice(index, 1);
  }
}

/**
 * Schließt das oberste Overlay (z.B. bei Escape/Back).
 * @returns {boolean} true wenn ein Overlay geschlossen wurde
 */
export function closeTopOverlay() {
  const top = overlayStack.pop();
  if (top && top.closeFn) {
    top.closeFn();
    return true;
  }
  return false;
}

/**
 * Gibt das aktive Overlay zurück (oder null).
 */
export function getActiveOverlay() {
  return overlayStack.length > 0
    ? overlayStack[overlayStack.length - 1]
    : null;
}

/**
 * Prüft ob ein bestimmtes Overlay offen ist.
 */
export function isOverlayActive(id) {
  return overlayStack.some(o => o.id === id);
}
