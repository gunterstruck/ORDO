// session-log.js – Minimales Session-Logging für den Agent
// Speichert Aktionen in sessionStorage für Kontext-Begrüßung und Debugging.

const LOG_KEY = 'ordo_session_log';
const MAX_ENTRIES = 100;

function getLog() {
  try {
    return JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
  } catch { return []; }
}

function saveLog(entries) {
  try {
    sessionStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch { /* sessionStorage voll oder nicht verfügbar */ }
}

/**
 * Loggt eine Aktion.
 * @param {string} action - Was passiert ist
 * @param {string|null} detail - Zusätzliche Details
 * @param {string} source - Quelle (ui, system, agent, voice)
 */
export function logAction(action, detail = null, source = 'ui') {
  const entries = getLog();
  entries.push({
    action,
    detail,
    source,
    ts: new Date().toISOString(),
  });
  saveLog(entries);
}

/**
 * Gibt den Zeitpunkt der letzten Aktivität zurück.
 * @returns {Date|null}
 */
export function getLastActivityTime() {
  // Persistenter Timestamp für App-übergreifende Nutzung
  const stored = localStorage.getItem('ordo_last_activity');
  if (stored) return new Date(stored);

  // Fallback: letzte Session-Aktion
  const entries = getLog();
  if (entries.length === 0) return null;
  return new Date(entries[entries.length - 1].ts);
}

/**
 * Speichert den aktuellen Zeitpunkt als letzte Aktivität.
 */
export function touchActivity() {
  localStorage.setItem('ordo_last_activity', new Date().toISOString());
}

/**
 * Gibt eine Zusammenfassung der heutigen Session zurück.
 * @returns {{ actions: number, photos: number, chats: number }}
 */
export function getTodaySummary() {
  const entries = getLog();
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = entries.filter(e => e.ts?.startsWith(today));

  return {
    actions: todayEntries.length,
    photos: todayEntries.filter(e => e.action?.includes('photo') || e.action?.includes('Photo')).length,
    chats: todayEntries.filter(e => e.source === 'agent' || e.action?.includes('chat')).length,
  };
}
