// local-intents.js – Local intent recognition for navigation & simple commands
// Kein API-Call nötig für einfache Befehle

import Brain from './brain.js';
import { calculateFreedomIndex } from './organizer.js';

/**
 * Check if a voice/text command can be handled locally without API call.
 * Returns an action object or null if not recognized.
 */
export function checkLocalIntent(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  // Navigation: rooms
  const rooms = Brain.getRooms();
  for (const [id, room] of Object.entries(rooms)) {
    const name = room.name.toLowerCase();
    const pattern = new RegExp(`(zeig|öffne|geh|gehe).*(${name}|${id})`, 'i');
    if (pattern.test(lower)) {
      return { action: 'showRoom', roomId: id, roomName: room.name };
    }
  }

  // Cleanup / Aufräumen
  if (/aufräumen|aufräum|lass.*aufräum|räum.*auf|ausmisten|entrümpel/i.test(lower)) {
    return { action: 'startCleanup' };
  }

  // Warranty / Garantie
  if (/garantie|was läuft.*ab|warranty/i.test(lower)) {
    return { action: 'showWarranty' };
  }

  // Expiry / Verfallsdaten
  if (/verfallsdatum|ablaufdatum|mhd|haltbar|abgelaufen|expiry|verfallsdaten/i.test(lower)) {
    return { action: 'showExpiry' };
  }

  // Report / Versicherungsbericht
  if (/bericht|versicherung|pdf|report/i.test(lower)) {
    return { action: 'showReports' };
  }

  // Settings
  if (/einstellungen|settings|einstellung/i.test(lower)) {
    return { action: 'showSettings' };
  }

  // Show brain / household
  if (/mein zuhause|haushalt|übersicht|überblick/i.test(lower)) {
    return { action: 'showHome' };
  }

  // Photo
  if (/foto.*machen|fotografier|aufnehmen|kamera/i.test(lower)) {
    return { action: 'takePhoto' };
  }

  // Spendenliste PDF
  if (/spendenliste|spenden.*(pdf|liste|export)/i.test(lower)) {
    return { action: 'generateDonationPDF' };
  }

  // Verkaufs-Entwürfe
  if (/verkauf|verkaufen|ebay|kleinanzeigen|vinted|verkaufsanzeige/i.test(lower)) {
    return { action: 'showSalesView' };
  }

  // Raum-Check
  if (/raum.?check|raum.*prüf|prüf.*(die|den|das)\s+\w+/i.test(lower)) {
    // Try to find which room
    const rooms = Brain.getRooms();
    for (const [id, room] of Object.entries(rooms)) {
      if (lower.includes(room.name.toLowerCase())) {
        return { action: 'roomCheck', roomId: id, roomName: room.name };
      }
    }
    return { action: 'roomCheck' };
  }

  // Haushalts-Check
  if (/haushalts.?check|gesamt.*check|alles.*prüf|wie steht.*haushalt/i.test(lower)) {
    return { action: 'householdCheck' };
  }

  // Verbesserungs-Report / Fortschritt
  if (/verbessert|fortschritt|entwicklung|vergleich|vor.*monat|besser geworden/i.test(lower)) {
    return { action: 'showImprovement' };
  }

  // Saisonale Empfehlungen
  if (/saison|frühling|frühjahr|herbst|winter|sommer|jahreszeit|einlagern|rausholen|frühjahrsputz/i.test(lower)) {
    return { action: 'showSeasonalDetails' };
  }

  // 3D-Raumansicht
  if (/3d|drei.?d|begehbar|raum.*ansicht|3d.*ansicht/i.test(lower)) {
    // Try to find which room
    const rooms3d = Brain.getRooms();
    for (const [id, room] of Object.entries(rooms3d)) {
      if (lower.includes(room.name.toLowerCase())) {
        return { action: 'show3DRoom', roomId: id, roomName: room.name };
      }
    }
    return { action: 'show3DRoom' };
  }

  // Capabilities / Help
  if (/was kannst du|hilfe|funktionen|features/i.test(lower))
    return { action: 'showCapabilities' };

  // Live Dialog
  if (/live|lass uns reden|echtzeit|reden wir|sprich mit mir/i.test(lower))
    return { action: 'startLive' };

  // Activity
  if (/was hab ich|was haben wir|zusammenfassung|geschafft/i.test(lower))
    return { action: 'showActivity' };

  // Map / Grundriss
  if (/karte|grundriss|plan(?!e)|map\b/i.test(lower))
    return { action: 'showMap' };

  return null;
}

/**
 * Execute a locally recognized intent.
 * Phase B: dispatch all intents through handleAction
 * This ensures everything renders in the dialog stream.
 */
export function executeLocalIntent(intent) {
  import('./ordo-agent.js').then(({ handleAction }) => {
    handleAction(intent);
  });

  // Return null — the agent message is handled by handleAction
  return null;
}

/**
 * Compute context-dependent quick suggestions.
 * Returns max 4 suggestions as { label, icon, action } objects.
 */
export function getSuggestions() {
  const suggestions = [];
  const data = Brain.getData();
  const rooms = data?.rooms || {};
  const roomEntries = Object.entries(rooms);
  const hasData = roomEntries.length > 0;

  // Active quest → highest priority
  const quest = Brain.getQuest();
  if (quest?.active) {
    suggestions.push({
      label: quest.type === 'cleanup' ? 'Aufräum-Quest fortsetzen' : 'Quest fortsetzen',
      icon: '🏠',
      actionType: 'continueQuest'
    });
  }

  // Warranty warning
  try {
    const expiring = Brain.getExpiringWarranties(14);
    if (expiring.length > 0) {
      suggestions.push({
        label: `Garantie: ${expiring[0].itemName}`,
        icon: '⚠️',
        actionType: 'showWarranty'
      });
    }
  } catch { /* warranty module may not be loaded */ }

  // Quick cleanup suggestion
  if (hasData) {
    const { percent } = calculateFreedomIndex();
    if (percent < 80) {
      suggestions.push({
        label: 'Schnell aufräumen',
        icon: '🧹',
        actionType: 'startCleanup'
      });
    }
  }

  // "Where is...?" quick search
  if (hasData) {
    suggestions.push({
      label: 'Wo ist...?',
      icon: '🔍',
      actionType: 'searchItem'
    });
  }

  // Photo capture
  suggestions.push({
    label: 'Foto aufnehmen',
    icon: '📷',
    actionType: 'takePhoto'
  });

  return suggestions.slice(0, 4);
}
