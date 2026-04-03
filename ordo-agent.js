// ordo-agent.js – Agent-Kern: Der Agent entscheidet was angezeigt wird.
// Verarbeitet User-Eingaben, navigiert durch die App, steuert das Onboarding.

import Brain from './brain.js';
import {
  agentMessage, userMessage, systemMessage,
  showStreamLoading, hideStreamLoading, clearStream,
} from './dialog-stream.js';
import { calculateFreedomIndex, getQuickWins, getSeasonalRecommendations } from './organizer.js';
import { checkLocalIntent, executeLocalIntent } from './local-intents.js';
import { getPersonality, getPersonalityPrompt } from './chat.js';
import {
  callGemini, ORDO_FUNCTIONS, functionCallToAction,
  processMarkers, executeOrdoAction, normalizeOrdoAction,
  buildMessages, loadingManager, getErrorMessage,
} from './ai.js';
import { logAction, getLastActivityTime, touchActivity } from './session-log.js';
import { BLOCK_REGISTRY } from './ui-blocks.js';

// ══════════════════════════════════════
// API-FEEDBACK EVENTS
// ══════════════════════════════════════

// Zeigt dem Nutzer wenn die API langsam ist
window.addEventListener('ordo-api-slow', (e) => {
  const loadingEls = document.querySelectorAll('.stream-loading .stream-loading-text');
  const lastEl = loadingEls[loadingEls.length - 1];
  if (lastEl) {
    lastEl.textContent = 'API antwortet langsam — bitte Geduld...';
  }
});

// Zeigt dem Nutzer wenn auf ein anderes Modell gewechselt wurde
window.addEventListener('ordo-model-fallback', (e) => {
  const { requestedModel, usedModel } = e.detail || {};
  if (requestedModel && usedModel) {
    systemMessage(`⚡ ${requestedModel} war überlastet — ${usedModel} hat übernommen.`);
  }
});

// ══════════════════════════════════════
// PERSONALITY HELPER
// ══════════════════════════════════════

/**
 * Wählt Text basierend auf der aktiven Persönlichkeit.
 * @param {{ sachlich: string, freundlich: string, kauzig: string }} variants
 * @returns {string}
 */
export function companionSays(variants) {
  const p = getPersonality();
  return variants[p] || variants.kauzig || Object.values(variants)[0] || '';
}

// ══════════════════════════════════════
// USER INPUT HANDLER
// ══════════════════════════════════════

/**
 * Verarbeitet eine User-Eingabe (Sprache, Text oder Action).
 */
export async function handleUserInput(input) {
  if (typeof input === 'string' && input.trim()) {
    userMessage(input);
    Brain.addChatMessage('user', input);
  }

  touchActivity();

  // 1. Lokaler Intent? (kein API-Call)
  if (typeof input === 'string') {
    const intent = checkLocalIntent(input);
    if (intent) {
      const response = executeLocalIntent(intent);
      if (response) {
        agentMessage(response, [], getSmartActions('local'));
        Brain.addChatMessage('assistant', response);
      }
      return;
    }
  }

  // 2. Gemini für alles andere
  const apiKey = Brain.getApiKey();
  if (!apiKey) {
    agentMessage(
      'Ich brauche einen API-Key um zu antworten. Geh in die Einstellungen.',
      [],
      [{ icon: '\u2699\uFE0F', label: 'Einstellungen', action: 'showSettings', primary: true }],
    );
    return;
  }

  const loading = showStreamLoading('Denke nach...');

  try {
    const context = Brain.buildContext();
    const score = calculateFreedomIndex();
    const personality = getPersonalityPrompt();
    const quickWins = getQuickWins(3)
      .map(w => `- ${w.description} (${w.estimatedMinutes} Min, -${w.impactPoints})`)
      .join('\n') || '- Keine offenen Quick Wins';

    const systemPrompt = `Du bist ORDO, der Haushaltsassistent. Du hast den \u00dcberblick \u00fcber diesen Haushalt und wei\u00dft wo jedes Teil liegt.

${personality}

Hier ist was du \u00fcber diesen Haushalt wei\u00dft:
${context}

AUFR\u00c4UMKONTEXT:
KOPF-FREIHEITS-INDEX: ${score.percent}%
OFFENE ENTSCHEIDUNGEN: ${score.totalDebt}
TOP QUICK WINS:
${quickWins}

VERFÜGBARE UI-BLÖCKE:
Du kannst folgende Blöcke im Dialog rendern. Nutze sie aktiv — antworte
nicht mit Text wenn ein Block die Information besser darstellt.
${Object.keys(BLOCK_REGISTRY).join(', ')}

WANN WELCHER BLOCK:
- Nutzer fragt nach Zuhause/Übersicht → MetricGrid + TabbedPanel (Räume, Hinweise, Vorschläge)
- Nutzer fragt nach einem Raum → RichCards mit expandierbaren Containern
- Nutzer fragt nach Container-Inhalt → ItemList
- Nutzer fragt nach Garantien → WarrantyList
- Nutzer fragt nach Verfallsdaten/MHD → ExpiryList
- Nutzer fragt nach Aufräumen/Ordnung → CleanupOptions oder ProgressCard
- Nutzer fragt nach Fortschritt/Verbesserung → ImprovementReport
- Nutzer fragt nach Karte/Grundriss → SpatialMap
- Nutzer fragt was du kannst / nach allen Ansichten → CapabilitiesCard + show_view(view: "showcase")
- Nutzer fragt nach Verkaufen → SalesCard
- Nutzer fragt nach Spenden → DonationList
- Nutzer fragt nach Berichten → ReportMenu
- Nutzer fragt nach Einstellungen → SettingsPanel
- 2-3 Kennzahlen nebeneinander → MetricGrid
- Laufende Session/Quest → ProgressCard
- Einzelne große Kennzahl → ScoreMetric
- 3+ Kategorien gruppieren → TabbedPanel
- Raum/Container/Vorschlag mit Badge → RichCard

REGELN:
- Antworte immer in maximal 2-3 kurzen S\u00e4tzen.
- Wenn du etwas nicht wei\u00dft, bitte um ein Foto.
- Wenn der Nutzer nach Aufr\u00e4umen, Ordnung oder Optimierung fragt: nenne 2-3 Quick Wins und frage, ob er eine Aufr\u00e4um-Session starten m\u00f6chte.

UI-ANSICHTEN:
Du hast die Funktion show_view() um dem Nutzer interaktive Ansichten zu zeigen.
DU ENTSCHEIDEST welche Ansicht zum Kontext passt — zeige sie PROAKTIV, nicht erst auf Nachfrage.

REGELN für show_view():
1. Wenn der Nutzer nach etwas fragt das eine Ansicht hat → zeige sie ZUSÄTZLICH zu deiner Textantwort
2. Wenn der Nutzer alle Ansichten/Cards/Blöcke sehen will → show_view(view: "showcase")
3. Wenn der Nutzer nach Fähigkeiten fragt → show_view(view: "capabilities")
4. Kombiniere immer: kurze Textantwort + passende show_view()

KONTEXT-MAPPING (zeige proaktiv die passende Ansicht):
- Nutzer fragt nach Räumen, Wohnung, Zuhause → show_view(view: "home")
- Nutzer fragt nach Garantien, Gewährleistung → show_view(view: "warranty")
- Nutzer fragt nach Verfallsdaten, MHD, abgelaufen → show_view(view: "expiry")
- Nutzer will aufräumen, Ordnung schaffen → show_view(view: "cleanup")
- Nutzer fragt nach Fortschritt, Verbesserung → show_view(view: "improvement")
- Nutzer fragt nach Karte, Grundriss, Layout → show_view(view: "map")
- Nutzer will Einstellungen ändern → show_view(view: "settings")
- Nutzer fragt nach Berichten, Versicherung → show_view(view: "reports")
- Nutzer fragt was heute passiert ist → show_view(view: "activity")
- Nutzer fragt was du kannst, zeig alles, alle Cards → show_view(view: "showcase")
- Nutzer will Artikel verkaufen / loswerden / inserieren
  → publish_to_kleinanzeigen Function Call auslösen
  → KleinanzeigenCard zeigt fertige Anzeige

WICHTIG: Schreibe KEINE HTML-Tags, Block-Objekte oder agentMessage() in deinen Text. Nutze NUR show_view() für Ansichten.

AKTIONEN:
Du kannst die Datenbank verändern. Nutze dazu die bereitgestellten Funktionen (Function Calls).
Bevorzuge IMMER Function Calls statt Text-Marker.`;

    const history = Brain.getChatHistory().slice(-20).map(m => ({ role: m.role, content: m.content }));
    const chatMessages = buildMessages(history, null);

    const response = await callGemini(apiKey, systemPrompt, chatMessages, {
      tools: ORDO_FUNCTIONS,
      taskType: 'chat',
      hasImage: false,
    });

    hideStreamLoading(loading);

    // Text + Function Calls verarbeiten
    const functionCalls = response.functionCalls || [];
    let cleanText = response.text || '';

    // Function Calls
    const fcActions = [];
    for (const call of functionCalls) {
      const action = functionCallToAction(call);
      if (!action) continue;
      if (action.type === 'found') continue;
      if (action.type === 'show_view') {
        await handleAction({ action: action.action });
        continue;
      }
      fcActions.push(action);
    }

    // Marker-Fallback
    if (fcActions.length === 0 && cleanText) {
      const parsed = processMarkers(cleanText);
      cleanText = parsed.cleanText;
      parsed.actions
        .map(normalizeOrdoAction)
        .filter(Boolean)
        .forEach(a => executeOrdoAction(a));
    } else if (cleanText) {
      cleanText = processMarkers(cleanText).cleanText;
    }

    // FC Actions ausführen
    fcActions
      .map(normalizeOrdoAction)
      .filter(Boolean)
      .forEach(a => executeOrdoAction(a));

    if (cleanText) {
      agentMessage(cleanText, [], getSmartActions('chat_response'));
      Brain.addChatMessage('assistant', cleanText);
    }

  } catch (err) {
    hideStreamLoading(loading);
    const errMsg = getErrorMessage(err);
    agentMessage(companionSays({
      sachlich: `Fehler: ${errMsg}`,
      freundlich: `Da ist etwas schiefgelaufen: ${errMsg}`,
      kauzig: `Das hat nicht geklappt. ${errMsg}`,
    }), [], [
      { icon: '\u{1F504}', label: 'Nochmal', action: 'retry', primary: true },
      { icon: '\u{1F4F7}', label: 'Foto stattdessen', action: 'takePhoto' },
    ]);
  }
}

// ══════════════════════════════════════
// ACTION HANDLER
// ══════════════════════════════════════

/**
 * Verarbeitet eine Action (Button-Tap).
 */
export async function handleAction(action) {
  logAction(`Action: ${action.action}`, JSON.stringify(action), 'ui');
  touchActivity();

  switch (action.action) {

    // --- NAVIGATION ---

    case 'showHome':
      showHome();
      break;

    case 'showRoom':
      showRoom(action.roomId);
      break;

    case 'showContainer':
      showContainer(action.roomId, action.containerId);
      break;

    case 'showItemDetail': {
      // Öffne item-detail Panel falls vorhanden
      try {
        const { showItemDetailPanel } = await import('./item-detail.js');
        showItemDetailPanel(action.roomId, action.containerId, action.itemName);
      } catch {
        agentMessage(`Item: ${action.itemName}`);
      }
      break;
    }

    // --- DOKUMENT-VIEWER ---

    case 'showDocument': {
      // action.roomId, action.containerId, action.itemName → Kassenbon
      // action.photoKey → direkter Foto-Key
      // action.label → Anzeige-Label
      const { openDocumentViewer, openReceiptForItem } = await import('./document-viewer.js');

      if (action.itemName && action.roomId && action.containerId) {
        const found = await openReceiptForItem(
          action.roomId, action.containerId, action.itemName
        );
        if (!found) {
          agentMessage(companionSays({
            sachlich: 'Kein Kassenbon für dieses Item gefunden.',
            freundlich: 'Ich finde keinen Kassenbon dafür. Wurde keiner fotografiert?',
            kauzig: 'Kein Bon. Nicht da.',
          }), [], [
            { icon: '📄', label: 'Kassenbon fotografieren', action: 'takePhoto', primary: true },
          ]);
        }
      } else if (action.photoKey) {
        const blob = await Brain.getPhoto(action.photoKey);
        if (blob) {
          await openDocumentViewer({
            blob,
            mimeType: blob.type || 'image/jpeg',
            label: action.label || 'Dokument',
          });
        }
      }
      break;
    }

    // --- KAMERA ---

    case 'takePhoto': {
      const { startSmartPhotoCapture } = await import('./smart-photo.js');
      startSmartPhotoCapture();
      break;
    }

    case 'takeVideo': {
      const { startSmartVideoCapture } = await import('./smart-photo.js');
      startSmartVideoCapture();
      break;
    }

    case 'photoContainer': {
      // Kamera direkt für einen Container öffnen
      const { startSmartPhotoCapture } = await import('./smart-photo.js');
      startSmartPhotoCapture();
      break;
    }

    // --- AUFRÄUMEN ---

    case 'startCleanup': {
      const { startCleanupQuest, showCurrentStep } = await import('./quest.js');
      startCleanupQuest(15);
      break;
    }

    case 'resumeQuest': {
      const { showCurrentStep } = await import('./quest.js');
      showCurrentStep();
      break;
    }

    case 'questStepDone': {
      const { completeCurrentStep } = await import('./quest.js');
      completeCurrentStep(0);
      break;
    }

    case 'questStepSkip': {
      const { skipCurrentStep } = await import('./quest.js');
      skipCurrentStep('Via Dialog \u00fcbersprungen');
      break;
    }

    case 'continueQuest': {
      const { showCurrentStep } = await import('./quest.js');
      showCurrentStep();
      break;
    }

    case 'searchItem':
      agentMessage(companionSays({
        sachlich: 'Was suchst du?',
        freundlich: 'Was suchst du? Tippe den Namen ein!',
        kauzig: 'Was ist weg? Raus damit.',
      }));
      break;

    // --- BERICHTE ---

    case 'showExpiry': {
      const { showExpiryOverview } = await import('./warranty-view.js');
      showExpiryOverview();
      break;
    }

    case 'showWarranty': {
      const { showWarrantyOverview } = await import('./warranty-view.js');
      showWarrantyOverview();
      break;
    }

    case 'showImprovement':
      agentMessage(companionSays({
        sachlich: 'Dein Fortschritt:',
        freundlich: 'Schau mal wie du dich verbessert hast!',
        kauzig: 'Ob sich was getan hat...',
      }), [
        { type: 'ImprovementReport', props: {} },
      ], [
        { icon: '🏠', label: 'Zurück', action: 'showHome' },
      ]);
      break;

    case 'showReports':
      showReportsMenu();
      break;

    case 'generateInsuranceReport': {
      const { showReportDialog } = await import('./report.js');
      showReportDialog();
      break;
    }

    // --- SETTINGS ---

    case 'showSettings':
      agentMessage('Hier sind deine Einstellungen:', [
        { type: 'SettingsPanel', props: {} },
      ]);
      break;

    case 'setPersonality': {
      const { setPersonality } = await import('./chat.js');
      setPersonality(action.value);
      agentMessage(companionSays({
        sachlich: `Pers\u00f6nlichkeit: ${action.value}.`,
        freundlich: `Alles klar, ich bin jetzt ${action.value}!`,
        kauzig: `Gut. Ab jetzt bin ich ${action.value}. Passt schon.`,
      }));
      break;
    }

    case 'changeApiKey':
      agentMessage('Neuen API-Key eingeben:', [
        { type: 'OnboardingKeyInput', props: {} },
      ]);
      break;

    case 'toggleTTS': {
      const current = localStorage.getItem('ordo_tts_enabled') === 'true';
      localStorage.setItem('ordo_tts_enabled', (!current).toString());
      agentMessage(companionSays({
        sachlich: `Sprache ${!current ? 'aktiviert' : 'deaktiviert'}.`,
        freundlich: !current ? 'Ich rede jetzt mit dir!' : 'Okay, ich bin still.',
        kauzig: !current ? 'Na gut, dann rede ich halt.' : 'Endlich Ruhe.',
      }));
      break;
    }

    case 'togglePreviewModels': {
      const current = localStorage.getItem('ordo_use_preview_models') !== 'false';
      localStorage.setItem('ordo_use_preview_models', (!current).toString());
      // Panel neu rendern damit der Toggle-Zustand stimmt
      handleAction({ action: 'showSettings' });
      break;
    }

    case 'exportData': {
      try {
        const { exportData } = await import('./brain.js');
        // Trigger download via Brain export
        const data = Brain.getData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ordo-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        agentMessage('Export heruntergeladen.');
      } catch {
        agentMessage('Export fehlgeschlagen.');
      }
      break;
    }

    case 'importData': {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          Brain.importData(data);
          agentMessage('Daten importiert! Die App wird neu geladen.', [], [
            { icon: '\u{1F3E0}', label: 'Mein Zuhause', action: 'showHome', primary: true },
          ]);
        } catch {
          agentMessage('Import fehlgeschlagen. Ist das eine g\u00fcltige ORDO-Datei?');
        }
      });
      input.click();
      break;
    }

    // --- BLOCK SHOWCASE ---

    case 'showBlockShowcase': {
      const rooms = Brain.getRooms();
      const roomEntries = Object.entries(rooms);
      const firstRoomId = roomEntries[0]?.[0] || null;
      const firstRoom = roomEntries[0]?.[1] || null;
      const firstContainerId = firstRoom
        ? Object.keys(firstRoom.containers || {})[0]
        : null;

      const hasData = roomEntries.length > 0;

      agentMessage(
        companionSays({
          sachlich: 'Hier sind alle verfügbaren Ansichten:',
          freundlich: 'Schau mal, das alles kann ich dir anzeigen!',
          kauzig: 'Na gut. Hier. Alles was ich kann.',
        })
      );

      // Gruppe 1: Zuhause & Navigation
      agentMessage('🏠 Dein Zuhause', [
        { type: 'ScoreCard', props: {} },
        { type: 'RoomGrid', props: {} },
      ]);

      // Gruppe 2: Container & Items (nur wenn Daten vorhanden)
      if (hasData && firstRoomId && firstContainerId) {
        agentMessage(`📦 Beispiel: ${firstRoom.name}`, [
          { type: 'ContainerList', props: { roomId: firstRoomId } },
        ]);
        agentMessage('📋 Items in einem Container', [
          { type: 'ItemList', props: { roomId: firstRoomId, containerId: firstContainerId } },
        ]);
      }

      // Gruppe 3: Berichte
      agentMessage('📊 Berichte & Listen', [
        { type: 'ExpiryList', props: { compact: true, maxItems: 2 } },
        { type: 'WarrantyList', props: {} },
        { type: 'DonationList', props: {} },
      ]);

      // Gruppe 4: Aufräumen
      agentMessage('🧹 Aufräumen', [
        { type: 'CleanupOptions', props: {} },
        { type: 'QuickDecision', props: {} },
      ]);

      // Gruppe 5: Quest (nur wenn aktiv)
      const quest = Brain.getQuest();
      if (quest?.active) {
        agentMessage('🗺️ Aktiver Quest', [
          { type: 'QuestStep', props: {} },
        ]);
      }

      // Gruppe 6: Karte & Fortschritt
      agentMessage('🗺️ Karte & Fortschritt', [
        { type: 'SpatialMap', props: {} },
        { type: 'ImprovementReport', props: {} },
      ]);

      // Gruppe 7: Einstellungen
      agentMessage('⚙️ Einstellungen', [
        { type: 'SettingsPanel', props: {} },
      ]);

      // Abschluss mit Capabilities-Übersicht
      agentMessage(
        companionSays({
          sachlich: 'Das sind alle Ansichten. Tippe eine an.',
          freundlich: 'Das war alles! Was möchtest du als nächstes?',
          kauzig: 'Fertig. Such dir was aus.',
        }),
        [{ type: 'CapabilitiesCard', props: {} }],
        [
          { icon: '📷', label: 'Foto machen', action: 'takePhoto', primary: true },
          { icon: '🏠', label: 'Mein Zuhause', action: 'showHome' },
        ]
      );
      break;
    }

    // --- CAPABILITIES ---

    case 'showCapabilities':
      agentMessage('', [{ type: 'CapabilitiesCard', props: {} }]);
      break;

    // --- ONBOARDING ---

    case 'onboardingStep2':
      onboardingStep2();
      break;

    case 'explainApiKey':
      explainApiKey();
      break;

    case 'testApiKey':
      await testAndSaveApiKey(action.key);
      break;

    case 'startFirstPhoto':
    case 'startFirstVideo': {
      const { startSmartPhotoCapture } = await import('./smart-photo.js');
      startSmartPhotoCapture();
      break;
    }

    // --- RETRY ---

    case 'retry':
      agentMessage(companionSays({
        sachlich: 'Was m\u00f6chtest du tun?',
        freundlich: 'Okay, nochmal von vorne. Was brauchst du?',
        kauzig: 'Also gut. Was soll ich tun?',
      }), [], getSmartActions('general'));
      break;

    // --- BERICHTE (Phase B) ---

    case 'generateInsuranceReport': {
      const { showReportDialog } = await import('./report.js');
      showReportDialog();
      break;
    }

    case 'generateDonationPDF': {
      const { generateDonationListPDF } = await import('./report.js');
      await generateDonationListPDF();
      agentMessage('Spendenliste als PDF erstellt.', [], [
        { icon: '📋', label: 'Nochmal', action: 'generateDonationPDF' },
        { icon: '🏠', label: 'Zurück', action: 'showHome' },
      ]);
      break;
    }

    case 'publishToKleinanzeigen': {
      // action.itemName, action.roomId, action.containerId
      // action.listing (optional, wenn schon generiert)

      if (!action.itemName) {
        // Kein Item angegeben → Agent fragt nach
        agentMessage(companionSays({
          sachlich: 'Welchen Artikel möchtest du verkaufen?',
          freundlich: 'Was soll ich auf Kleinanzeigen stellen?',
          kauzig: 'Was willst du loswerden?',
        }));
        break;
      }

      const room = action.roomId ? Brain.getRoom(action.roomId) : null;
      const container = (action.roomId && action.containerId)
        ? Brain.getContainer(action.roomId, action.containerId)
        : null;

      agentMessage(
        companionSays({
          sachlich: `Anzeige für: ${action.itemName}`,
          freundlich: `Ich bereite eine Anzeige für „${action.itemName}" vor!`,
          kauzig: `${action.itemName}. Schauen wir mal was das bringt.`,
        }),
        [{
          type: 'KleinanzeigenCard',
          props: {
            itemName: action.itemName,
            roomId: action.roomId || null,
            containerId: action.containerId || null,
            listing: action.listing || null,
          }
        }]
      );
      break;
    }

    case 'showSalesView': {
      agentMessage('Erstelle Verkaufs-Entwürfe...', []);
      try {
        const { getSellableItems } = await import('./organizer.js');
        const { generateSalesTexts } = await import('./ai.js');
        const items = getSellableItems();
        if (items.length === 0) {
          agentMessage(companionSays({
            sachlich: 'Keine verkaufbaren Items gefunden.',
            freundlich: 'Ich finde gerade nichts zum Verkaufen.',
            kauzig: 'Nichts da. Erst aussortieren, dann verkaufen.',
          }));
          break;
        }
        const texts = await generateSalesTexts(items);
        agentMessage('Verkaufs-Entwürfe:', [
          { type: 'SalesCard', props: { items: texts } },
        ]);
      } catch {
        agentMessage('Verkaufs-Entwürfe konnten nicht erstellt werden.');
      }
      break;
    }

    case 'showDonationList':
      agentMessage('Spendenliste:', [
        { type: 'DonationList', props: {} },
      ], [
        { icon: '📄', label: 'Als PDF', action: 'generateDonationPDF' },
        { icon: '🏠', label: 'Zurück', action: 'showHome' },
      ]);
      break;

    // --- AUFRÄUMEN (Phase B) ---

    case 'startCleanupQuest': {
      const { startCleanupQuest: startQuest } = await import('./quest.js');
      startQuest(action.minutes || 15);
      break;
    }

    case 'quickDecision':
      agentMessage(companionSays({
        sachlich: 'Eine Entscheidung:',
        freundlich: 'Was meinst du zu diesem Teil?',
        kauzig: 'Behalten oder weg?',
      }), [
        { type: 'QuickDecision', props: {} },
      ]);
      break;

    case 'roomCheck': {
      const { roomCheck: doRoomCheck } = await import('./organizer.js');
      const check = doRoomCheck(action.roomId);
      if (check) {
        agentMessage(`Raum-Check: ${check.roomName}`, [
          { type: 'RoomCheckCard', props: { data: check } },
        ], [
          { icon: '🧹', label: 'Aufräumen', action: 'startCleanup', primary: true },
          { icon: '🏠', label: 'Zurück', action: 'showHome' },
        ]);
      } else {
        agentMessage('Diesen Raum kenne ich nicht.');
      }
      break;
    }

    case 'householdCheck': {
      const { householdCheck: doHouseholdCheck } = await import('./organizer.js');
      const hCheck = doHouseholdCheck();
      agentMessage('Haushalts-Check:', [
        { type: 'HouseholdCheckCard', props: { data: hCheck } },
      ], [
        { icon: '🧹', label: 'Aufräumen', action: 'startCleanup', primary: true },
        { icon: '📋', label: 'Spendenliste', action: 'showDonationList' },
      ]);
      break;
    }

    // --- VERBESSERUNG & SAISON (Phase B) ---

    case 'showSeasonalDetails':
    case 'showSeasonal':
      agentMessage(companionSays({
        sachlich: 'Saisonale Empfehlungen:',
        freundlich: 'Hier ein paar saisonale Tipps!',
        kauzig: 'Was die Saison so verlangt:',
      }), [
        { type: 'SeasonalCard', props: {} },
      ], [
        { icon: '🏠', label: 'Zurück', action: 'showHome' },
      ]);
      break;

    // --- SPATIAL (Phase B) ---

    case 'showMap':
      agentMessage(companionSays({
        sachlich: 'Dein Zuhause:',
        freundlich: 'Hier ist dein Zuhause als Karte!',
        kauzig: 'Da wohnst du also.',
      }), [
        { type: 'SpatialMap', props: {} },
      ], [
        { icon: '🏠', label: 'Zurück', action: 'showHome' },
      ]);
      break;

    case 'show3DRoom': {
      const { show3DRoom: render3D } = await import('./brain-view.js');
      render3D(action.roomId);
      break;
    }

    // --- AKTIVITÄT (Phase B) ---

    case 'showActivity':
    case 'showSessionSummary':
      agentMessage(companionSays({
        sachlich: 'Heutige Aktivität:',
        freundlich: 'Das hast du heute geschafft!',
        kauzig: 'Was du so getrieben hast:',
      }), [
        { type: 'ActivityLog', props: {} },
      ], [
        { icon: '🏠', label: 'Zurück', action: 'showHome' },
      ]);
      break;

    // --- LIVE DIALOG (Phase B) ---

    case 'startLive':
    case 'liveDialog': {
      const { openLiveModal } = await import('./live-modal.js');
      openLiveModal();
      break;
    }

    case 'endLive':
      agentMessage(companionSays({
        sachlich: 'Live-Dialog beendet.',
        freundlich: 'Gutes Gespräch! Hier was wir besprochen haben:',
        kauzig: 'So. Genug geredet.',
      }), [
        { type: 'ActivityLog', props: { sessionOnly: true } },
      ], [
        { icon: '📷', label: 'Foto', action: 'takePhoto' },
        { icon: '🏠', label: 'Mein Zuhause', action: 'showHome' },
      ]);
      break;

    // --- ARCHIVIEREN (Phase B) ---

    case 'archiveItem':
      agentMessage(`${action.itemName || 'Item'} — was soll damit passieren?`, [
        { type: 'QuickDecision', props: {
          itemName: action.itemName,
          roomId: action.roomId,
          containerId: action.containerId,
          mode: 'archive',
        }},
      ]);
      break;

    case 'moveItem':
      agentMessage(companionSays({
        sachlich: `${action.itemName || 'Item'} verschieben — wohin?`,
        freundlich: `Klar, wohin soll ${action.itemName || 'das'} denn?`,
        kauzig: `${action.itemName || 'Ding'} umziehen? Wohin?`,
      }), [], [
        { icon: '🏠', label: 'Raum wählen', action: 'showHome' },
      ]);
      break;

    case 'donateItem':
      agentMessage(companionSays({
        sachlich: `${action.itemName || 'Item'} wird als Spende markiert.`,
        freundlich: `Super, ${action.itemName || 'das'} wird gespendet! Gute Tat!`,
        kauzig: `${action.itemName || 'Ding'} weg. Karma +1.`,
      }), [
        { type: 'QuickDecision', props: {
          itemName: action.itemName,
          roomId: action.roomId,
          containerId: action.containerId,
          mode: 'archive',
        }},
      ]);
      break;

    // --- HILFE (Phase B) ---

    case 'showHelp':
      agentMessage(companionSays({
        sachlich: 'Frag mich einfach was du brauchst.',
        freundlich: 'Ich bin für dich da! Frag mich einfach.',
        kauzig: 'Frag. Aber kurz.',
      }), [
        { type: 'CapabilitiesCard', props: {} },
      ]);
      break;

    // --- FOTO ANZEIGEN ---

    case 'showPhoto': {
      const rooms = Brain.getRooms();

      // Fall A: Container bekannt → direkt anzeigen
      if (action.containerId && action.roomId) {
        const container = Brain.getContainer(action.roomId, action.containerId);
        const room = Brain.getRoom(action.roomId);
        agentMessage(
          companionSays({
            sachlich: `Foto: ${container?.name || action.containerId}`,
            freundlich: `Hier ist das Foto von ${container?.name || action.containerId}!`,
            kauzig: `Da. Das Foto.`,
          }),
          [{ type: 'ContainerPhoto', props: {
            roomId: action.roomId,
            containerId: action.containerId,
            roomName: room?.name,
            containerName: container?.name,
          }}],
          [{ icon: '📷', label: 'Neues Foto', action: 'takePhoto', primary: false }]
        );
        break;
      }

      // Fall B: Nur Raum bekannt → neuesten Container mit Foto finden
      if (action.roomId) {
        const room = Brain.getRoom(action.roomId);
        if (!room) { agentMessage('Diesen Raum kenne ich nicht.'); break; }

        const containersWithPhotos = Object.entries(room.containers || {})
          .filter(([, c]) => c.has_photo || (c.photo_history?.length > 0))
          .sort(([, a], [, b]) => (b.last_updated || 0) - (a.last_updated || 0));

        if (containersWithPhotos.length === 0) {
          agentMessage(companionSays({
            sachlich: `Für ${room.name} sind noch keine Fotos gespeichert.`,
            freundlich: `Von ${room.name} habe ich noch kein Foto. Mach eins!`,
            kauzig: `${room.name} ist noch unbekannt. Kamera raus.`,
          }), [], [{ icon: '📷', label: 'Foto machen', action: 'takePhoto', primary: true }]);
          break;
        }

        const [newestId, newestContainer] = containersWithPhotos[0];
        const blocks = [{ type: 'ContainerPhoto', props: {
          roomId: action.roomId,
          containerId: newestId,
          roomName: room.name,
          containerName: newestContainer.name,
        }}];

        const hint = containersWithPhotos.length > 1
          ? ` (${containersWithPhotos.length} Bereiche mit Fotos)`
          : '';

        agentMessage(
          companionSays({
            sachlich: `Aktuellstes Foto aus ${room.name}${hint}:`,
            freundlich: `Das neueste Foto aus dem ${room.name}${hint}:`,
            kauzig: `Hier. ${room.name}${hint}.`,
          }),
          blocks,
          containersWithPhotos.length > 1
            ? containersWithPhotos.slice(1, 3).map(([cId, c]) => ({
                icon: '📦',
                label: c.name,
                action: 'showPhoto',
                roomId: action.roomId,
                containerId: cId,
              }))
            : [{ icon: '📷', label: 'Neues Foto', action: 'takePhoto' }]
        );
        break;
      }

      agentMessage('Von was soll ich das Foto zeigen?');
      break;
    }

    // --- FALLBACK ---

    default:
      if (action.chatMessage) {
        await handleUserInput(action.chatMessage);
      }
      break;
  }
}

// ══════════════════════════════════════
// AGENT-VIEWS (als Dialog-Blöcke)
// ══════════════════════════════════════

/**
 * Home-Ansicht im Dialog.
 */
function showHome() {
  const score = calculateFreedomIndex();
  const data = Brain.getData();
  const rooms = Object.entries(data.rooms || {});
  const roomCount = rooms.length;

  // Bei leerer Wohnung: einfache Ansicht
  if (roomCount === 0) {
    agentMessage(
      'Dein Zuhause ist noch leer. Mach ein Foto von einem Raum!',
      [{ type: 'ScoreCard', props: {} }],
      [
        { icon: '\u{1F4F7}', label: 'Foto', action: 'takePhoto' },
        { icon: '\u{1F3A5}', label: 'Film', action: 'takeVideo' },
        { icon: '\u{1F3A4}', label: 'Live reden', action: 'startLive' },
      ],
    );
    return;
  }

  // Daten-Frische berechnen (rekursiv über Sub-Container)
  let totalItems = 0;
  let freshItems = 0;
  function countFreshness(containers) {
    for (const container of Object.values(containers || {})) {
      for (const item of (container.items || [])) {
        if (typeof item === 'string') {
          // String-Items: kein Tracking → als neutral/frisch zählen
          totalItems++;
          freshItems++;
          continue;
        }
        if (item.status === 'archiviert') continue;
        totalItems++;
        if (item.last_seen) {
          const daysSince = (Date.now() - new Date(item.last_seen).getTime()) / 86400000;
          if (daysSince < 30) freshItems++;
        }
      }
      // Rekursiv in Sub-Container
      if (container.containers) countFreshness(container.containers);
    }
  }
  for (const [, room] of rooms) {
    countFreshness(room.containers);
  }
  const freshPercent = totalItems > 0 ? Math.round((freshItems / totalItems) * 100) : 0;

  const blocks = [];

  // Backward-Compatibility: ältere Flows/Tests erwarten weiterhin eine ScoreCard im Home-Block.
  blocks.push({
    type: 'ScoreCard',
    props: {
      score: score.percent,
      subtitle: `${score.totalDebt} offene Entscheidungen`,
    },
  });

  // MetricGrid: Freiheitsindex + Daten-Frische
  blocks.push({
    type: 'MetricGrid',
    props: {
      columns: 2,
      metrics: [
        {
          label: 'Kopf-Freiheits-Index',
          value: score.percent,
          unit: '%',
          color: score.percent >= 70 ? 'success' : score.percent >= 40 ? 'warning' : 'danger',
          sublabel: `${score.totalDebt} offene Entscheidungen`,
        },
        {
          label: 'Daten-Frische',
          value: freshPercent,
          unit: '%',
          color: freshPercent >= 70 ? 'success' : freshPercent >= 40 ? 'warning' : 'danger',
          sublabel: `${totalItems} Gegenstände`,
        },
      ],
    },
  });

  // TabbedPanel: Räume, Hinweise, Vorschläge
  const roomCards = rooms.map(([roomId, room]) => {
    const containerCount = Object.keys(room.containers || {}).length;
    let itemCount = 0;
    for (const c of Object.values(room.containers || {})) {
      itemCount += (c.items || []).filter(i => typeof i === 'string' || i.status !== 'archiviert').length;
    }
    return {
      type: 'RichCard',
      props: {
        title: `${room.emoji || '\u{1F3E0}'} ${room.name}`,
        info: `${itemCount} Gegenst\u00e4nde \u00b7 ${containerCount} Container`,
        action: `showRoom|${roomId}`,
      },
    };
  });

  // Hinweise Tab
  const alertCards = [];
  try {
    const expired = (Brain.getExpiringItems?.(0) || []).filter(e => e.isExpired);
    if (expired.length > 0) {
      alertCards.push({
        type: 'RichCard',
        props: {
          badge: { text: `${expired.length} abgelaufen`, color: 'danger' },
          title: '\u26A0\uFE0F Abgelaufene Produkte',
          info: expired.slice(0, 3).map(e => e.name).join(', '),
          action: 'showExpiry',
        },
      });
    }
  } catch { /* ok */ }

  // Vorschläge Tab
  const suggestCards = [];
  try {
    const quickWins = getQuickWins(3);
    for (const w of quickWins) {
      suggestCards.push({
        type: 'RichCard',
        props: {
          badge: { text: `${w.estimatedMinutes} Min`, color: 'info' },
          title: `\u{1F4A1} ${w.description}`,
          info: `Wirkung: -${w.impactPoints} Belastungspunkte`,
          action: 'startCleanup',
        },
      });
    }
  } catch { /* ok */ }

  // Saisonale Empfehlung
  try {
    const seasonal = getSeasonalRecommendations();
    if (seasonal && (seasonal.storeAway.length + seasonal.bringOut.length) > 0) {
      suggestCards.push({
        type: 'RichCard',
        props: {
          badge: { text: 'Saisonal', color: 'warning' },
          title: '\u{1F343} Saisonale Empfehlung',
          info: `${seasonal.storeAway.length} verstauen, ${seasonal.bringOut.length} hervorholen`,
          action: 'showSeasonal',
        },
      });
    }
  } catch { /* ok */ }

  // Nur TabbedPanel wenn es genug Inhalt gibt
  if (alertCards.length > 0 || suggestCards.length > 0) {
    const tabs = [{ id: 'rooms', label: 'R\u00e4ume', icon: '\u{1F3E0}' }];
    const children = { rooms: roomCards };

    if (alertCards.length > 0) {
      tabs.push({ id: 'alerts', label: 'Hinweise', icon: '\u26A0\uFE0F' });
      children.alerts = alertCards;
    }
    if (suggestCards.length > 0) {
      tabs.push({ id: 'suggest', label: 'Vorschl\u00e4ge', icon: '\u{1F4A1}' });
      children.suggest = suggestCards;
    }

    blocks.push({
      type: 'TabbedPanel',
      props: { tabs, defaultTab: 'rooms' },
      children,
    });
  } else {
    // Fallback: einfaches RoomGrid
    blocks.push({ type: 'RoomGrid', props: {} });
  }

  agentMessage(
    `${roomCount} R\u00e4ume, ${score.percent}% frei.`,
    blocks,
    [
      { icon: '\u{1F4F7}', label: 'Foto', action: 'takePhoto' },
      { icon: '\u{1F3A5}', label: 'Film', action: 'takeVideo' },
      { icon: '\u{1F3A4}', label: 'Live reden', action: 'startLive' },
      { icon: '\u{1F9F9}', label: 'Aufr\u00e4umen', action: 'startCleanup' },
    ],
  );
}

/**
 * Raum-Detail im Dialog.
 */
function showRoom(roomId) {
  const room = Brain.getRoom(roomId);
  if (!room) {
    agentMessage('Diesen Raum kenne ich nicht.');
    return;
  }

  const containers = Object.entries(room.containers || {});
  const blocks = [];

  if (containers.length === 0) {
    // Kein Container: klassische Ansicht
    blocks.push({ type: 'ContainerList', props: { roomId } });
  } else {
    // RichCards mit expandierbaren Items pro Container
    for (const [cId, container] of containers) {
      const items = (container.items || []).filter(i =>
        typeof i === 'string' || i.status !== 'archiviert'
      );

      const expandItems = items.slice(0, 10).map(item => {
        const name = typeof item === 'string' ? item : item.name;
        return {
          label: name,
          actions: [
            { label: 'Verschieben', action: `moveItem|${name}|${roomId}` },
            { label: 'Entfernen', action: `archiveItem|${name}`, confirm: 'Wirklich?' },
          ],
        };
      });

      // Frische bestimmen
      let freshCount = 0;
      for (const item of items) {
        if (typeof item !== 'string' && item.last_seen) {
          const days = (Date.now() - new Date(item.last_seen).getTime()) / 86400000;
          if (days < 7) freshCount++;
        }
      }
      const badgeColor = freshCount > items.length / 2 ? 'success' : items.length > 0 ? 'warning' : 'info';
      const badgeText = freshCount > items.length / 2 ? 'Frisch' : items.length > 0 ? 'Prüfen' : 'Leer';

      blocks.push({
        type: 'RichCard',
        props: {
          badge: { text: badgeText, color: badgeColor },
          title: `\u{1F4E6} ${container.name}`,
          info: `${items.length} Gegenst\u00e4nde`,
          action: `showContainer|${roomId}|${cId}`,
          expandable: expandItems.length > 0,
          expandItems,
        },
      });
    }
  }

  agentMessage(
    `${room.emoji || '\u{1F3E0}'} ${room.name}:`,
    blocks,
    [
      { icon: '\u{1F4F7}', label: 'Fotografieren', action: 'takePhoto', primary: true },
      { icon: '\u{1F3E0}', label: 'Zur\u00fcck', action: 'showHome' },
    ],
  );
}

/**
 * Container-Detail im Dialog.
 */
function showContainer(roomId, containerId) {
  const room = Brain.getRoom(roomId);
  const container = room ? (room.containers || {})[containerId] : null;
  if (!container) {
    agentMessage('Diesen Container kenne ich nicht.');
    return;
  }

  agentMessage(
    `\u{1F4E6} ${container.name}:`,
    [{ type: 'ItemList', props: { roomId, containerId } }],
    [
      { icon: '\u{1F4F7}', label: 'Foto', action: 'photoContainer', roomId, containerId, primary: true },
      { icon: '\u2B05\uFE0F', label: room.name, action: 'showRoom', roomId },
    ],
  );
}

/**
 * Berichte-Menü im Dialog.
 */
function showReportsMenu() {
  agentMessage(companionSays({
    sachlich: 'Verfügbare Berichte:',
    freundlich: 'Welchen Bericht brauchst du?',
    kauzig: 'Berichte. Bitte sehr.',
  }), [
    { type: 'ReportMenu', props: {} },
  ]);
}

// ══════════════════════════════════════
// ONBOARDING (KRITISCH: Ohne KI!)
// ══════════════════════════════════════

/**
 * Phase 1: PRE-AGENT — Statisches Willkommen
 * Kein Gemini. Kein API-Call. Geskripteter Dialog.
 */
export function startOnboarding() {
  clearStream();

  // Nachricht 1: Begrüßung (sofort)
  agentMessage(
    'Hey! Ich bin ORDO \u2014 dein Haushaltsassistent. ' +
    'Ich helfe dir dein Zuhause zu organisieren.',
  );

  // Nachricht 2: Was ich kann (nach 600ms)
  setTimeout(() => {
    agentMessage(
      'Alles was du tun musst: mit mir reden und Fotos machen. ' +
      'Ich erkenne was auf dem Foto ist und merke mir wo alles liegt.',
      [],
      [{ icon: '\u{1F44B}', label: 'Klingt gut!', action: 'onboardingStep2', primary: true }],
    );
  }, 600);
}

/**
 * Phase 1b: API-Key Erklärung + Eingabe
 */
function onboardingStep2() {
  agentMessage(
    'Damit ich Fotos analysieren und mit dir chatten kann, ' +
    'brauche ich eine Verbindung zu Google Gemini. ' +
    'Das ist die KI die mir meine Superkr\u00e4fte gibt.',
  );

  setTimeout(() => {
    agentMessage(
      'Du brauchst daf\u00fcr einen kostenlosen API-Key von Google:',
      [{ type: 'OnboardingKeyInput', props: {} }],
      [{ icon: '\u2753', label: 'Was ist ein API-Key?', action: 'explainApiKey' }],
    );
  }, 400);
}

/**
 * "Was ist ein API-Key?" — Statische Erklärung
 */
function explainApiKey() {
  agentMessage(
    'Ein API-Key ist wie ein Passwort das Google dir gibt, ' +
    'damit ich ihre KI benutzen darf. Er ist kostenlos. ' +
    'Geh auf aistudio.google.com/apikey, klick auf ' +
    '"Create API Key", und kopiere den Schl\u00fcssel hierher. ' +
    'Er beginnt mit "AIza...".',
    [{ type: 'OnboardingKeyInput', props: {} }],
  );
}

/**
 * API-Key testen. DAS ist der erste echte API-Call.
 */
async function testAndSaveApiKey(key) {
  if (!key || key.length < 10) {
    agentMessage(
      'Hmm, das sieht nicht nach einem g\u00fcltigen Key aus. ' +
      'Er sollte mit "AIza" beginnen und ziemlich lang sein.',
      [{ type: 'OnboardingKeyInput', props: {} }],
    );
    return;
  }

  const loading = showStreamLoading('Teste Verbindung zu Gemini...');

  try {
    Brain.setApiKey(key);

    const result = await callGemini(key, 'Antworte mit genau einem Wort: OK', [
      { role: 'user', content: 'Test' },
    ], {
      taskType: 'test',
    });

    hideStreamLoading(loading);

    if (result && result.text) {
      // PHASE 2: AGENT ERWACHT
      localStorage.setItem('ordo_onboarding_completed', 'pending_photo');

      agentMessage('\u{1F389} Verbindung steht! Ich bin jetzt live.');

      setTimeout(() => {
        agentMessage(
          'Jetzt wird\'s spannend. Mach ein Foto von irgendeinem ' +
          'Raum oder Schrank. Egal welcher \u2014 ich erkenne den Rest.',
          [{ type: 'PhotoButton', props: { label: 'Erstes Foto aufnehmen' } }],
          [
            { icon: '\u{1F4F7}', label: 'Foto aufnehmen', action: 'startFirstPhoto', primary: true },
            { icon: '\u{1F3A5}', label: 'Oder ein Video', action: 'startFirstVideo' },
          ],
        );
      }, 500);
    }

  } catch (err) {
    hideStreamLoading(loading);
    localStorage.removeItem('ordo_api_key');  // Key entfernen wenn ungültig

    agentMessage(
      'Der Key funktioniert leider nicht. ' +
      'Bitte pr\u00fcfe ob du ihn richtig kopiert hast. ' +
      'Manchmal fehlt am Anfang oder Ende ein Zeichen.',
      [{ type: 'OnboardingKeyInput', props: {} }],
      [{ icon: '\u2753', label: 'Hilfe', action: 'explainApiKey' }],
    );
  }
}

/**
 * Phase 3: Erstes Foto wurde analysiert.
 * Wird von photo-flow.js / smart-photo.js aufgerufen wenn die Analyse fertig ist.
 */
export function onboardingPhotoComplete(result) {
  localStorage.setItem('ordo_onboarding_completed', 'true');

  const roomName = result?.room?.name || 'ein Raum';
  const itemCount = result?.items?.length || 0;

  agentMessage(
    `Perfekt! Ich habe ${roomName} erkannt` +
    (itemCount > 0 ? ` mit ${itemCount} Gegenst\u00e4nden.` : '.') +
    ' Ab jetzt bin ich dein Inventar-Ged\u00e4chtnis.',
    [],
    [
      { icon: '\u{1F4F7}', label: 'N\u00e4chstes Foto', action: 'takePhoto', primary: true },
      { icon: '\u{1F3E0}', label: 'Mein Zuhause', action: 'showHome' },
      { icon: '\u2753', label: 'Was kannst du noch?', action: 'showCapabilities' },
    ],
  );
}

/**
 * Kontext-Begrüßung für wiederkehrende Nutzer.
 */
export function showContextGreeting() {
  const lastActivity = getLastActivityTime();
  const quest = Brain.getQuest();
  const { percent } = calculateFreedomIndex();
  const data = Brain.getData();
  const roomCount = Object.keys(data.rooms || {}).length;

  // Prüfe ob Onboarding noch nicht abgeschlossen
  const onboardingState = localStorage.getItem('ordo_onboarding_completed');
  if (onboardingState === 'pending_photo') {
    agentMessage(
      'Willkommen zur\u00fcck! Du hattest noch kein Foto gemacht. ' +
      'Mach eins \u2014 egal von welchem Raum.',
      [{ type: 'PhotoButton', props: { label: 'Foto aufnehmen' } }],
      [
        { icon: '\u{1F4F7}', label: 'Foto', action: 'takePhoto', primary: true },
        { icon: '\u{1F3A5}', label: 'Video', action: 'takeVideo' },
      ],
    );
    return;
  }

  // Blocks
  const blocks = [];
  if (roomCount > 0) {
    blocks.push({ type: 'ScoreCard', props: {} });
  }

  // Actions
  const actions = [
    { icon: '\u{1F4F7}', label: 'Foto', action: 'takePhoto' },
    { icon: '\u{1F3A5}', label: 'Film', action: 'takeVideo' },
    { icon: '\u{1F3A4}', label: 'Live reden', action: 'startLive' },
  ];

  if (quest?.active) {
    actions.unshift({
      icon: quest.type === 'cleanup' ? '\u{1F9F9}' : '\u{1F3E0}',
      label: 'Quest fortsetzen',
      action: 'resumeQuest',
      primary: true,
    });
  } else if (roomCount > 0) {
    actions.push({ icon: '\u{1F9F9}', label: 'Aufr\u00e4umen', action: 'startCleanup' });
  }

  // Greeting-Text (persönlichkeitsabhängig)
  let greeting;
  if (roomCount === 0) {
    greeting = companionSays({
      sachlich: 'Noch keine R\u00e4ume erfasst. Mach ein Foto.',
      freundlich: 'Mach ein Foto von einem Raum \u2014 ich erkenne den Rest!',
      kauzig: 'Immer noch leer hier. Foto. Jetzt.',
    });
  } else {
    const minutesAway = lastActivity
      ? (Date.now() - lastActivity.getTime()) / 60000 : 0;

    if (minutesAway > 10080) {
      greeting = companionSays({
        sachlich: `${Math.round(minutesAway / 1440)} Tage seit dem letzten Besuch. Score: ${percent}%.`,
        freundlich: `Lange nicht gesehen! Dein Score steht bei ${percent}%.`,
        kauzig: `${Math.round(minutesAway / 1440)} Tage. Ich dachte schon du hast mich vergessen. ${percent}%.`,
      });
    } else if (minutesAway > 1440) {
      greeting = companionSays({
        sachlich: `Score: ${percent}%. ${roomCount} R\u00e4ume.`,
        freundlich: `Willkommen zur\u00fcck! ${percent}% frei.`,
        kauzig: `Da bist du ja. ${percent}%.`,
      });
    } else {
      greeting = companionSays({
        sachlich: `${percent}%.`,
        freundlich: `Hey! ${percent}% frei.`,
        kauzig: `Moin. ${percent}%.`,
      });
    }

    // Dringende Hinweise
    const expiring = Brain.getExpiringItems?.(0) || [];
    const expired = expiring.filter(e => e.isExpired);
    if (expired.length > 0) {
      greeting += ` \u26A0\uFE0F ${expired.length} Ding${expired.length > 1 ? 'e' : ''} abgelaufen.`;
      actions.push({ icon: '\u23F0', label: 'Pr\u00fcfen', action: 'showExpiry' });
    }
  }

  // Räume als Grid
  if (roomCount > 0) {
    blocks.push({ type: 'RoomGrid', props: {} });
  }

  agentMessage(greeting, blocks, actions);
}

// ══════════════════════════════════════
// SMART ACTIONS
// ══════════════════════════════════════

function getSmartActions(context) {
  const actions = [];
  const quest = Brain.getQuest();

  actions.push({ icon: '\u{1F4F7}', label: 'Foto', action: 'takePhoto' });

  if (quest?.active) {
    actions.push({ icon: '\u{1F9F9}', label: 'Quest', action: 'resumeQuest' });
  }

  actions.push({ icon: '\u{1F3E0}', label: 'Zuhause', action: 'showHome' });

  return actions.slice(0, 3);
}
