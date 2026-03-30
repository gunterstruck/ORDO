// local-intents.js – Local intent recognition for navigation & simple commands
// Kein API-Call nötig für einfache Befehle

import Brain from './brain.js';
import { showView } from './app.js';
import { calculateFreedomIndex } from './organizer.js';
import { showWarrantyOverview } from './warranty-view.js';
import { startSmartPhotoCapture } from './smart-photo.js';
import { showRoomCheck, showHouseholdCheck, showSalesView } from './quest.js';
import { generateDonationListPDF } from './report.js';
import { showSeasonalDetails, showImprovementReport } from './brain-view.js';

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
      return { action: 'navigateRoom', room: id, roomName: room.name };
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

  // Report / Versicherungsbericht
  if (/bericht|versicherung|pdf|report/i.test(lower)) {
    return { action: 'showReport' };
  }

  // Settings
  if (/einstellungen|settings|einstellung/i.test(lower)) {
    return { action: 'showSettings' };
  }

  // Show brain / household
  if (/mein zuhause|haushalt|übersicht|überblick/i.test(lower)) {
    return { action: 'showBrain' };
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
        return { action: 'showRoomCheck', roomId: id, roomName: room.name };
      }
    }
    return { action: 'showRoomCheck' };
  }

  // Haushalts-Check
  if (/haushalts.?check|gesamt.*check|alles.*prüf|wie steht.*haushalt/i.test(lower)) {
    return { action: 'showHouseholdCheck' };
  }

  // Verbesserungs-Report / Fortschritt
  if (/verbessert|fortschritt|entwicklung|vergleich|vor.*monat|besser geworden/i.test(lower)) {
    return { action: 'showImprovementReport' };
  }

  // Saisonale Empfehlungen
  if (/saison|frühling|frühjahr|herbst|winter|sommer|jahreszeit|einlagern|rausholen|frühjahrsputz/i.test(lower)) {
    return { action: 'showSeasonalDetails' };
  }

  return null;
}

/**
 * Execute a locally recognized intent.
 * Returns a response string for the chat.
 */
export function executeLocalIntent(intent) {
  switch (intent.action) {
    case 'navigateRoom':
      showView('brain');
      return `Hier ist ${intent.roomName}.`;

    case 'startCleanup': {
      const score = calculateFreedomIndex();
      return `Dein Kopf ist zu ${score.percent}% frei. ${score.totalDebt} offene Entscheidungen. Ich stelle dir eine Aufräum-Quest zusammen.`;
    }

    case 'showWarranty':
      showWarrantyOverview();
      return 'Hier ist die Garantie-Übersicht.';

    case 'showReport':
      showView('settings');
      return 'Öffne die Einstellungen für den Versicherungsbericht.';

    case 'showSettings':
      showView('settings');
      return 'Einstellungen geöffnet.';

    case 'showBrain':
      showView('brain');
      return 'Hier ist dein Zuhause.';

    case 'takePhoto':
      startSmartPhotoCapture();
      return null; // No chat response needed

    case 'generateDonationPDF':
      generateDonationListPDF();
      return 'Spendenliste wird erstellt...';

    case 'showSalesView':
      showSalesView();
      return 'Erstelle Verkaufs-Entwürfe...';

    case 'showRoomCheck':
      if (intent.roomId) {
        showRoomCheck(intent.roomId);
        return `Raum-Check für ${intent.roomName} wird gestartet.`;
      }
      // No specific room → show household check instead
      showHouseholdCheck();
      return 'Hier ist der Haushalts-Check.';

    case 'showHouseholdCheck':
      showHouseholdCheck();
      return 'Hier ist der Haushalts-Check.';

    case 'showImprovementReport':
      showImprovementReport();
      return 'Hier ist dein Fortschritts-Report.';

    case 'showSeasonalDetails':
      showSeasonalDetails();
      return 'Hier sind die saisonalen Empfehlungen.';

    default:
      return null;
  }
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
