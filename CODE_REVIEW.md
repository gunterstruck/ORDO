# ORDO – Umfassendes Code-Review

## 1. Projekt-Zusammenfassung

ORDO ist eine deutsche PWA (Progressive Web App) als "Haushaltsassistent". Die App ermöglicht:
- KI-gestützte Foto-Analyse von Schränken/Regalen via Google Gemini API
- Verwaltung von Räumen, Behältern und Gegenständen
- Chat-basierte Suche nach Gegenständen
- NFC-Tag-Integration für schnellen Zugriff
- Offline-Funktionalität via Service Worker

**Tech-Stack:** Vanilla JS, kein Build-System, kein npm, kein Framework.

---

## 2. Klickpfad-Analyse (UX Flows)

### 2.1 Erststart / Onboarding

**Flow:** App öffnen → Willkommen-Screen → "Los geht's" → Raum wählen → Foto machen → "Perfekt!" → "Jetzt loslegen" → Chat View

**Befunde:**
- **Gut:** Klarer 3-Schritt-Prozess, Skip-Option vorhanden
- **Problem (UX-B1):** Wenn der Nutzer im Onboarding ein Foto macht, wird `showOnboardingDoneStep()` sofort aufgerufen (app.js:2267), BEVOR das Staging-Overlay geschlossen oder die Analyse abgeschlossen ist. Das führt zu einem verwirrenden Zustand: Der "Perfekt!"-Screen erscheint hinter dem Staging-Overlay.
- **Problem (UX-B2):** Es gibt keinen "Zurück"-Button in den Onboarding-Schritten. Wählt man versehentlich den falschen Raum, gibt es keinen Weg zurück.
- **Problem (UX-B3):** Der Onboarding-Foto-Input hat `capture="environment"`, was auf Desktop-Browsern problematisch ist – kein Kamera-Zugriff ohne Galerie-Alternative.

### 2.2 Foto erfassen (Photo View)

**Flow:** Nav "Erfassen" → Raum wählen → Optional: Ort benennen → Kamera/Galerie → Staging Overlay → Foto(s) hinzufügen → "Analysieren" → Review Overlay → Gegenstände prüfen → "Übernehmen"

**Befunde:**
- **Gut:** Multi-Foto-Staging (max 5), Review mit Mengenangabe
- **Problem (UX-P1):** Kamera- und Galerie-Button öffnen GLEICHZEITIG das Staging-Overlay UND den File-Picker (app.js:654-666). Wenn der Nutzer den File-Picker abbricht, bleibt das leere Staging-Overlay offen – verwirrend.
- **Problem (UX-P2):** Ohne gewählten Raum zeigt `showPhotoStatus` eine Fehlermeldung, aber der Status bleibt sichtbar bis zum nächsten Foto-Versuch (kein Auto-Hide).
- **Problem (UX-P3):** `addManualReviewItem()` (app.js:1546-1557) nutzt `prompt()` – ein Browser-Modal, das auf Mobile sehr unschön wirkt und nicht zum modernen UI passt.

### 2.3 Chat-Interaktion

**Flow:** Nav "Finden" → Nachricht eingeben / Vorschlag tippen → KI antwortet → ggf. Gegenstände automatisch gespeichert

**Befunde:**
- **Gut:** Quick-Suggestions kontextabhängig, Foto im Chat möglich, Voice-Input
- **Problem (UX-C1):** Die Chat-Suggestions verschwinden nach der ersten Nachricht und kommen nie wieder (hideChatSuggestions löscht innerHTML). Nach einem Chat-Reset oder wenn der Nutzer zum Chat zurückkehrt, wären neue Vorschläge hilfreich.
- **Problem (UX-C2):** Bei einem API-Fehler (z.B. kein API-Key) wird eine Nachricht als "assistant"-Bubble angezeigt. Das ist semantisch falsch – Fehlermeldungen sollten als System-Message dargestellt werden.
- **Problem (UX-C3):** `sendChatMessage()` hat keinen Loading-State für den Send-Button. Schnelles Doppeltippen kann doppelte Nachrichten senden.

### 2.4 Brain View (Mein Zuhause)

**Flow:** Nav "Mein Zuhause" → Räume sehen → Raum aufklappen → Container aufklappen → Items sehen → Item tippen → Chat öffnet sich mit Frage

**Befunde:**
- **Gut:** Hierarchische Darstellung, Thumbnail-Lazy-Loading, Empty-State mit CTA
- **Problem (UX-BR1):** Kontextmenü (Umbenennen/Löschen) wird über `prompt()` realisiert (app.js:1824-1850). Das ist weder intuitiv noch mobil-freundlich. Ein Bottom-Sheet-Modal wäre besser.
- **Problem (UX-BR2):** `showAddRoomDialog()` und `showAddContainerDialog()` nutzen ebenfalls `prompt()` für Name, Emoji und Typ – drei aufeinanderfolgende Browser-Modale.
- **Problem (UX-BR3):** Beim Tippen auf ein Item-Chip wird direkt `sendChatMessage()` mit 100ms Timeout aufgerufen (app.js:1693-1694). Der Nutzer sieht den Chat-Input kurz gefüllt, bevor die Nachricht abgesendet wird – kein visuelles Feedback.

### 2.5 Einstellungen

**Flow:** Zahnrad → API-Key setzen / NFC konfigurieren / Export-Import / Reset

**Befunde:**
- **Gut:** Klare Sektionierung, NFC-Fallback für iPhones
- **Problem (UX-S1):** Kein "Zurück"-Button in den Einstellungen. Man muss über die Bottom-Nav navigieren, aber der Einstellungs-View hat keinen aktiven Nav-Button (Settings ist nicht in der Nav-Bar).
- **Problem (UX-S2):** `renderSettings()` fügt jedes Mal einen neuen `change`-Event-Listener auf `nfc-room-select` hinzu (app.js:1962). Bei mehrfachem Öffnen der Einstellungen werden Events dupliziert.
- **Problem (UX-S3):** API-Key wird als `type="password"` gespeichert, aber es gibt keinen Toggle zum Anzeigen des Keys. Nutzer können nicht prüfen, ob der Key korrekt eingegeben wurde.

---

## 3. Code-Qualität

### 3.1 Architektur

- **Positiv:** Klare Trennung Brain (Daten) / App (UI/Logik)
- **Positiv:** Saubere Event-Delegation, konsistente Namenskonventionen
- **Negativ:** `app.js` ist mit 2417 Zeilen zu groß für eine einzelne Datei. Empfehlung: Aufteilen in Module (chat.js, photo.js, brain-view.js, etc.)

### 3.2 Duplikate / DRY-Verletzungen

- **DRY-1:** `presets`-Objekt (Raum-Vorgaben) wird 6x identisch definiert:
  - app.js:396, app.js:449-453, app.js:781, app.js:1417-1421, app.js:2017, app.js:2273-2280
  - Sollte eine einzige Konstante sein.
- **DRY-2:** `ensureRoomExists()` (app.js:1415) macht dasselbe wie der Code in `executeSaveAction()` (app.js:455-460) und `handleSaveResponse()` (app.js:396-398).
- **DRY-3:** `resizeImage()` und `resizeImageForChat()` sind nahezu identisch (app.js:151-204). Unterschied: Chat gibt base64 zurück, Photo gibt Blob zurück. Könnte eine Funktion mit Parameter sein.

### 3.3 Fehlerbehandlung

- **FH-1:** Viele `catch {}` ohne jegliches Logging (app.js:867, 1126, 1301, 1402). Im Debug-Modus sollten diese wenigstens `debugLog()` aufrufen.
- **FH-2:** `callGemini()` wirft spezifische Fehler für Status 429 und 400/403, aber Status 403 und 400 werden zusammengefasst als `api_key`. Ein 400er kann auch ein ungültiger Request sein (z.B. zu großes Bild).
- **FH-3:** `Brain.getData()` gibt bei JSON-Parse-Fehler `null` zurück (brain.js:128). Nachfolgende Aufrufe wie `Brain.addItem()` greifen dann auf `null.rooms` zu → TypeError.

### 3.4 Sicherheit

- **SEC-1:** API-Key wird in `localStorage` gespeichert (brain.js:454). Das ist Standard für Client-only Apps, aber der Key wird im Klartext an die URL angehängt: `${API_URL}?key=${apiKey}` (app.js:2148). Keys in URLs können in Browser-History, Proxy-Logs und Referrer-Headers landen.
- **SEC-2:** `innerHTML` wird an mehreren Stellen mit Nutzerdaten verwendet:
  - app.js:1614 (Room-Name im Brain-View)
  - app.js:2284 (Onboarding-Room-Tile)
  - Zwar werden die Daten vom Nutzer selbst gesetzt, aber bei Import-Dateien könnte schadhafter Content enthalten sein.
- **SEC-3:** `processSaveMarkers()` und `processActions()` parsen JSON aus KI-Antworten. Die geparsten Aktionen werden direkt ausgeführt (z.B. `deleteRoom`, `deleteContainer`). Ein bösartiger Prompt-Injection-Angriff über die KI-Antwort könnte theoretisch Daten löschen.

### 3.5 Performance

- **PERF-1:** `Brain.getData()` wird extrem häufig aufgerufen – jeder Aufruf parst den gesamten JSON-String aus localStorage. Bei großen Datensätzen (viele Räume/Container) wird das spürbar.
- **PERF-2:** `renderBrainView()` baut den gesamten DOM-Baum jedes Mal neu auf. Bei vielen Räumen/Containern wäre Virtual DOM oder zumindest partielle Updates effizienter.
- **PERF-3:** `renderSettings()` wird bei jedem View-Wechsel zu Settings aufgerufen und registriert dabei neue Event-Listener (app.js:1962) – Memory-Leak-Potenzial.

### 3.6 Barrierefreiheit (A11y)

- **A11Y-1:** ARIA-Labels sind gut vorhanden für Buttons und Inputs
- **A11Y-2:** Overlays haben `aria-modal="true"` und `role="dialog"` – korrekt
- **A11Y-3:** **Problem:** Focus-Trap fehlt bei Overlays. Keyboard-Nutzer können hinter den Overlays navigieren.
- **A11Y-4:** **Problem:** Keine Keyboard-Navigation für Long-Press-Aktionen (Raum/Container-Kontextmenü). Nur Touch-User können diese nutzen.

---

## 4. Spezifische Bugs

| # | Datei:Zeile | Beschreibung | Schwere |
|---|-------------|--------------|---------|
| B1 | app.js:2267 | Onboarding-Done-Screen erscheint vor Staging/Analyse-Ende | Mittel |
| B2 | app.js:1962 | Event-Listener-Duplizierung in renderSettings() | Niedrig |
| B3 | app.js:605 | `deleteContainer` in executeAction() ruft `Brain.deletePhoto()` direkt auf, obwohl `Brain.deleteContainer()` das bereits tut (brain.js:235) → doppelter Delete-Versuch | Niedrig |
| B4 | app.js:1946 | NFC-Copy nutzt `nfc-preview-url` statt `nfc-fallback-url` → kopiert ggf. falschen Text | Mittel |
| B5 | app.js:419-422 | `buildMessages()` fügt dummy '…' als Assistant-Nachricht ein, wenn History mit User endet. Das kann die KI-Antwortqualität beeinträchtigen | Niedrig |
| B6 | brain.js:302-332 | `applyPhotoAnalysis()` überschreibt Container komplett – vorhandene Items und Quantities gehen verloren | Hoch |

---

## 5. Zusammenfassung

**Stärken:**
- Sauberer, lesbarer Vanilla-JS-Code
- Gute UX-Grundstruktur mit klaren Flows
- Durchdachte Offline-Strategie
- Gute ARIA-Labels und semantisches HTML

**Schwächen:**
- Übermäßige Nutzung von `prompt()` / `alert()` für UX-kritische Aktionen
- Code-Duplikation (besonders Raum-Presets)
- Fehlende Tests
- Event-Listener-Duplizierung
- Monolithische app.js

**Empfohlene Prioritäten:**
1. Bug B6 (applyPhotoAnalysis überschreibt Daten) – Datenverlust-Risiko
2. UX-P1 (Staging-Overlay bei abgebrochenem File-Picker)
3. Event-Listener-Duplizierung (B2)
4. Tests einführen (siehe Testdateien)
