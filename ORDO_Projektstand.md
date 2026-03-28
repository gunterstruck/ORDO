# ORDO Projektstand

**Datum:** 28.03.2026  
**Quelle:** Automatisch aus dem Quellcode abgeleitet

---

## 1) Was ist ORDO?

### ORDO in einem Satz
ORDO ist eine browserbasierte PWA für Haushaltsinventar, die Räume/Behälter/Gegenstände lokal verwaltet und KI-gestützt Fotos, Chat und Organisationshilfen für das Auffinden und Pflegen von Inventar anbietet.

### Technologien
- **Frontend:** Vanilla JavaScript (ES-Module), HTML, CSS
- **Datenspeicher:** `localStorage` + `IndexedDB`
- **PWA:** Service Worker + Manifest
- **KI:** Google Gemini API (Client-seitiger Aufruf)
- **Browser-APIs:**
  - Kamera (`getUserMedia`, `MediaRecorder` + File-Input-Fallback)
  - Spracheingabe (`SpeechRecognition`/`webkitSpeechRecognition`)
  - Web NFC (`NDEFReader`, mit manuellem Fallback)

### Wo laufen die Daten? (Lokal vs. Cloud)
- **Lokal im Browser:**
  - Haushaltsstruktur, Chat-Historie, Quest-Status, UI-Settings in `localStorage`
  - Fotos/Belege als Blobs in `IndexedDB`
- **Cloud:**
  - Nur KI-Anfragen/Dateiuploads an Google Gemini-Endpunkte
  - Keine eigene Server-API/kein eigenes Backend im Code

### Welche KI wird genutzt und wofür?
- **Gemini 2.5 Flash**: schnelle Text-/Chat-Aufgaben
- **Gemini 2.5 Pro**: bild-/videointensive und komplexe Aufgaben (Fotoanalyse, Blueprint, Organizer-Checks, Wertermittlung, Beleganalyse)
- Einsatzbereiche:
  - Chat-Antworten und Function Calling
  - Fotoanalyse (Containerinhalte)
  - Blueprint/Wohnungsstruktur aus Raumfotos
  - Video-gestützte Raumanalyse
  - Kassenbonanalyse
  - Versicherungs-Wertschätzung
  - Organizer-Containerchecks

---

## 2) Feature-Liste (Was läuft)

> Status-Logik: Nur Features mit realem Codepfad sind als ✅ markiert.

### Kern-Features (Chat, Foto, Brain-View, NFC)

1. **Chat mit KI und Verlauf**  
   - Beschreibung: Nutzer kann text- und fotobasiert fragen; Antworten werden gespeichert.  
   - Module: `chat.js`, `ai.js`, `brain.js`  
   - Status: ✅ Implementiert

2. **Function Calling für Datenänderungen im Chat**  
   - Beschreibung: KI kann strukturierte Aktionen (z. B. add/move/remove Item, Räume/Container) ausführen.  
   - Module: `ai.js`, `chat.js`, `brain.js`  
   - Status: ✅ Implementiert

3. **Fotoaufnahme und Galerieimport**  
   - Beschreibung: Fotos können per Kamera oder Dateiauswahl aufgenommen und analysiert werden.  
   - Module: `photo-flow.js`, `camera.js`  
   - Status: ✅ Implementiert

4. **Interaktives Picking (Hotspots)**  
   - Beschreibung: KI-Vorschläge auf Foto werden als Hotspots geprüft/ergänzt/bestätigt.  
   - Module: `photo-flow.js`  
   - Status: ✅ Implementiert

5. **Staging + Review-Overlay**  
   - Beschreibung: Mehrere Fotos sammeln, gemeinsam analysieren, Treffer manuell korrigieren/übernehmen.  
   - Module: `photo-flow.js`, `index.html`  
   - Status: ✅ Implementiert

6. **Brain-View (Hierarchieansicht)**  
   - Beschreibung: Räume, Container, Untercontainer, aktive/archivierte/unsichere Items mit Interaktionen.  
   - Module: `brain-view.js`, `brain.js`  
   - Status: ✅ Implementiert

7. **Map-View-Umschaltung im Brain-View**  
   - Beschreibung: Zwischen Listen- und Kartenansicht umschaltbar.  
   - Module: `brain-view.js`  
   - Status: ✅ Implementiert

8. **NFC-Kontextansicht**  
   - Beschreibung: URL-Parameter `room`/`tag` öffnen kontextbezogene Ansicht inkl. Aktionen.  
   - Module: `app.js`, `brain-view.js`  
   - Status: ✅ Implementiert

9. **NFC-Tag schreiben**  
   - Beschreibung: Tags werden per Web NFC beschrieben; bei Unsupported-Devices gibt es URL-Fallback.  
   - Module: `settings.js`  
   - Status: ✅ Implementiert

### Daten & Lebenszyklus (Frische, Archiv, Migration)

10. **Datenmodell v1.5 + Migration**  
    - Beschreibung: Initialisierung, Versions-Upgrade, Legacy-Key-Migration, Lazy-Migration von String-Items.  
    - Module: `brain.js`, `app.js`  
    - Status: ✅ Implementiert

11. **Item-Lifecycle (aktiv/vermisst/archiviert)**  
    - Beschreibung: Zustände, Zeitstempel, Sichtungszähler und Archivierungsgründe werden geführt.  
    - Module: `brain.js`, `brain-view.js`  
    - Status: ✅ Implementiert

12. **Frische-Logik (fresh/stale/ghost/unconfirmed)**  
    - Beschreibung: Zeitliche Bewertung von Gegenständen über `last_seen`.  
    - Module: `brain.js`, `brain-view.js`  
    - Status: ✅ Implementiert

13. **Foto-Historie pro Container**  
    - Beschreibung: Mehrere Fotos pro Container inkl. Limit, Legacy-Fallback-Key und Timeline-Overlay.  
    - Module: `brain.js`, `brain-view.js`, `settings.js`  
    - Status: ✅ Implementiert

14. **Delta-/Merge-Logik bei Analysen**  
    - Beschreibung: Analyseergebnisse werden in bestehende Container/Fuzzy-Matches integriert statt blind ersetzt.  
    - Module: `brain.js`, `photo-flow.js`  
    - Status: ✅ Implementiert

15. **Export/Import inkl. Fotos**  
    - Beschreibung: JSON Export/Import mit eingebetteten Foto-DataURLs.  
    - Module: `brain.js`, `settings.js`  
    - Status: ✅ Implementiert

### KI-Funktionen (Analyse, Wertschätzung, Bewertung)

16. **Fotoanalyse für Inventarstruktur**  
    - Beschreibung: KI erkennt Behälter und Inhalte aus Fotos.  
    - Module: `photo-flow.js`, `ai.js`  
    - Status: ✅ Implementiert

17. **Blueprint-Analyse (Wohnungsstruktur)**  
    - Beschreibung: Mehrere Raumfotos werden zu Räumen/Möbeln priorisiert ausgewertet.  
    - Module: `quest.js`, `ai.js`  
    - Status: ✅ Implementiert

18. **Kassenbonanalyse**  
    - Beschreibung: KI extrahiert Datum/Preis/Händler/Garantiehinweis.  
    - Module: `ai.js`, `item-detail.js`  
    - Status: ✅ Implementiert

19. **Wertschätzung einzelner und vieler Items**  
    - Beschreibung: Einzel- und Batch-Schätzung von Wiederbeschaffungswerten.  
    - Module: `ai.js`, `report.js`, `item-detail.js`  
    - Status: ✅ Implementiert

20. **Organizer-Containercheck per KI**  
    - Beschreibung: KI bewertet Container inkl. Empfehlungen/Score.  
    - Module: `ai.js`, `organizer.js`, `brain-view.js`  
    - Status: ✅ Implementiert

### Aufräumen & Organisation (Organizer, Score, Quick Wins)

21. **Organizer-Heuristik (lokal)**  
    - Beschreibung: Klassifikation, Raumzuordnung, Duplikaterkennung, Entsorgungsleitfaden.  
    - Module: `organizer.js`  
    - Status: ✅ Implementiert

22. **Freedom-Index, Weekly Score, Trend**  
    - Beschreibung: Punktesystem und Verlauf für Ordnung/Organisation.  
    - Module: `organizer.js`, `brain-view.js`  
    - Status: ✅ Implementiert

23. **Quick Wins & Zeit-Slots**  
    - Beschreibung: Kurzaufgaben und Entscheidungen (z. B. behalten/spenden/entsorgen).  
    - Module: `organizer.js`, `brain-view.js`  
    - Status: ✅ Implementiert

### Quest & Onboarding (Blueprint, geführte Inventarisierung)

24. **Onboarding mit API-Key-Test**  
    - Beschreibung: Erststart-Flow inklusive Key-Test, Scan-Auswahl und Abschlussflag.  
    - Module: `onboarding.js`, `app.js`  
    - Status: ✅ Implementiert

25. **Quest-System für geführte Inventarisierung**  
    - Beschreibung: Plan, Fortschritt, Schrittabschluss/Skip, Overlay und Resume.  
    - Module: `quest.js`, `brain.js`  
    - Status: ✅ Implementiert

26. **Video-Raumanalyse im Onboarding**  
    - Beschreibung: Video-Upload zu Gemini Files API mit Polling/Timeout/Retry.  
    - Module: `onboarding.js`, `ai.js`, `camera.js`  
    - Status: ✅ Implementiert

### Versicherung & Finanzen (Garantien, Kassenbons, PDF)

27. **Item-Detail mit Kauf-/Garantie-Daten**  
   - Beschreibung: Preis, Kaufdatum, Garantie, Notizen und Belegfoto an Gegenstand bindbar.  
   - Module: `item-detail.js`, `brain.js`  
   - Status: ✅ Implementiert

28. **Garantie-Übersicht und Banner**  
   - Beschreibung: Aktive/ablaufende/abgelaufene Garantien inkl. Tageshinweis.  
   - Module: `warranty-view.js`, `brain.js`, `brain-view.js`  
   - Status: ✅ Implementiert

29. **PDF-Versicherungsbericht**  
   - Beschreibung: Berichtserstellung inkl. Summen, Tabellen und KI-Schätzung fehlender Werte.  
   - Module: `report.js`, `ai.js`  
   - Status: ✅ Implementiert

### Infrastruktur (Modals, Toasts, Observer, Overlay-Manager)

30. **Modal-/Confirm-/Input-System**  
   - Beschreibung: Promise-basierte Modaleingaben und Bestätigungen mit Overlay-Priorisierung.  
   - Module: `modal.js`, `overlay-manager.js`  
   - Status: ✅ Implementiert

31. **Toast-System**  
   - Beschreibung: zentrale Feedback-Toast-Komponente.  
   - Module: `modal.js`  
   - Status: ✅ Implementiert

32. **Observer-Eventsystem im Datenkern**  
   - Beschreibung: Datenänderungen werden per `Brain.on/_emit` an UI/Flows verteilt.  
   - Module: `brain.js`, `brain-view.js`, `quest.js`, `chat.js`  
   - Status: ✅ Implementiert

33. **Loading-Manager mit Phasenfeedback**  
   - Beschreibung: pro Task abgestufte Ladephasen (Textwechsel/Progress-Hinweise).  
   - Module: `ai.js`  
   - Status: ✅ Implementiert

34. **Overlay-Manager mit Prioritätsstack**  
   - Beschreibung: konkurrierende Overlays werden über Prioritäten und Stack geregelt.  
   - Module: `overlay-manager.js`, diverse UI-Module  
   - Status: ✅ Implementiert

### PWA & Offline (Service Worker, Offline-Queue)

35. **PWA Service Worker**  
   - Beschreibung: App-Shell-Caching + Runtime-Caching + Offline-Dokument-Fallback.  
   - Module: `service-worker.js`  
   - Status: ✅ Implementiert

36. **Offline-Queue für Fotoanalyse**  
   - Beschreibung: Offline erfasste Fotos werden gepuffert und online nachverarbeitet.  
   - Module: `photo-flow.js`, `brain.js`  
   - Status: ✅ Implementiert

---

## 3) Technischer Stand

### 3A) Modul-Übersicht

| Modul | Zeilen | Verantwortung |
|---|---:|---|
| `app.js` | 257 | Bootstrap, Initialisierung, Navigation, SW-Registrierung, LocalStorage-Key-Migration |
| `brain.js` | 1958 | Datenkern: Modell, CRUD, Migration, Observer, Export/Import, IndexedDB-Fotozugriff |
| `brain-view.js` | 2502 | Haupt-UI „Mein Zuhause“, Map/List, Delegation, Organizer-Interaktionen, NFC-Kontext |
| `photo-flow.js` | 1698 | Foto-Workflow, Staging, Picking, Review, Queue |
| `chat.js` | 691 | Chat-UI, Sprachinput, Function-Call-Verarbeitung |
| `ai.js` | 1349 | Gemini API, Modellrouting, Thinking, Function-Definitions, Analysefunktionen |
| `onboarding.js` | 684 | Onboarding-Schritte, Foto-/Video-Scan, API-Key-Test |
| `quest.js` | 667 | Blueprint + geführte Inventarisierungs-Quest |
| `report.js` | 749 | PDF-Versicherungsbericht inkl. Tabellen und Wertberechnung |
| `settings.js` | 342 | Einstellungen, API-Key, NFC-Schreiben, Import/Export, Pull-to-refresh |
| `camera.js` | 327 | Kamera-/Videoaufnahme über Browser-APIs mit Fallback |
| `modal.js` | 167 | Toast/Input/Confirm-Modal-System |
| `overlay-manager.js` | 67 | Globaler Overlay-Prioritätsstack |
| `item-detail.js` | 748 | Detailpanel pro Gegenstand (Beleg, Garantie, Wert) |
| `warranty-view.js` | 128 | Garantieübersicht und Tagesbanner |
| `organizer.js` | 494 | Aufräum-Logik, Scores, Quick Wins, Caching |
| `service-worker.js` | 103 | Caching-Strategie und Offline-Verhalten |

### 3B) Datenmodell

#### Modellversion
- Aktuelle Versionsmarke: **`1.5`**

#### Struktur (Beispielobjekt mit aktuellen Feldern)

```json
{
  "version": "1.5",
  "created": 1710000000000,
  "rooms": {
    "kueche": {
      "name": "Küche",
      "emoji": "🍳",
      "containers": {
        "oberschrank": {
          "name": "Oberschrank",
          "typ": "schrank",
          "items": [
            {
              "name": "Teller",
              "status": "aktiv",
              "first_seen": "2026-03-01T10:00:00",
              "last_seen": "2026-03-28T09:15:00",
              "seen_count": 4,
              "menge": 8,
              "archived_at": null,
              "archived_reason": null,
              "purchase": {
                "date": "2024-05-10",
                "price": 59.99,
                "store": "IKEA",
                "warranty_months": 24,
                "warranty_expires": "2026-05-10",
                "receipt_photo_key": "receipt_kueche_oberschrank_teller_171...",
                "notes": "Set mit Schalen"
              },
              "valuation": {
                "replacement_value": 65,
                "replacement_range_min": 50,
                "replacement_range_max": 80,
                "source": "batch_ai",
                "estimated_at": "2026-03-20T12:00:00",
                "model_recognized": "IKEA OFTAST"
              },
              "object_id": "obj_123",
              "crop_ref": "crop_456",
              "spatial": { "x": 0.42, "y": 0.31 }
            }
          ],
          "uncertain_items": ["Glasdeckel"],
          "containers": {},
          "quantities": { "Teller": 8 },
          "photo_analyzed": true,
          "has_photo": true,
          "photo_history": ["2026-03-20T11:58:00", "2026-03-28T09:10:00"],
          "last_updated": 1711111111111,
          "infrastructure_ignore": [
            { "name": "Scharnier", "marked_at": "2026-03-28T09:12:00" }
          ],
          "spatial": { "zone": "linke_wand" }
        }
      },
      "container_order": ["oberschrank"],
      "last_updated": 1711111111111,
      "hint": "Raum wirkt gut strukturiert",
      "spatial": { "mapX": 2, "mapY": 1 }
    }
  },
  "chat_history": [
    { "role": "user", "content": "Wo sind die Teller?", "ts": 1711111111111 }
  ],
  "quest": {
    "active": true,
    "started": "2026-03-28T08:00:00Z",
    "last_activity": "2026-03-28T09:00:00Z",
    "progress": {
      "containers_total": 20,
      "containers_done": 7,
      "containers_skipped": 2,
      "items_found": 95,
      "percent": 45
    },
    "current_step": {
      "room_id": "kueche",
      "container_id": "oberschrank",
      "step_number": 10
    },
    "plan": [],
    "completed_at": null
  },
  "last_updated": 1711111111111
}
```

#### Was wird in `localStorage` gespeichert?
Aktiv genutzte Schlüssel im Code:
1. `haushalt_data`
2. `ordo_api_key`
3. `ordo_api_log`
4. `ordo_onboarding_completed`
5. `ordo_personality`
6. `ordo_photo_history_limit`
7. `ordo_view_mode`
8. `ordo_warranty_hint_shown`
9. `ordo_photo_queue`
10. `ordo_organizer_cache`
11. `ordo_score_history`

Legacy-Migration in `app.js`:
- `gemini_api_key` → `ordo_api_key`
- `brain_view_mode` → `ordo_view_mode`
- `photo_history_limit` → `ordo_photo_history_limit`
- `onboarding_completed` → `ordo_onboarding_completed`
- `last_warranty_hint_shown` → `ordo_warranty_hint_shown`

#### Was wird in `IndexedDB` gespeichert?
- Datenbank: `haushalt_photos`
- Version: `1`
- Object Store: `photos` (`keyPath: id`)
- Inhalt: Foto-/Beleg-Blobs plus Zeitstempel (`{ id, blob, ts }`)
- Key-Schemata im Code:
  - Containerfoto: `${roomId}_${containerId}_${timestamp}`
  - Legacyfoto: `${roomId}_${containerId}`
  - Queuefoto: `queued_${roomId}_${containerId}_${timestamp}`
  - Belegfoto: `receipt_${roomId}_${containerId}_${slug(itemName)}_${timestamp}`

### 3C) KI-Integration

#### Verwendete Gemini-Modelle
- `gemini-2.5-flash`
- `gemini-2.5-pro`

#### Modell-Routing (Flash vs. Pro)
- **Pro**, wenn:
  - `hasImage === true` oder `hasVideo === true`
  - oder `taskType` in: `analyzeBlueprint`, `analyzeReceipt`, `batchEstimateValues`, `containerCheck`, `roomCheck`, `householdCheck`
- **Flash** sonst

#### Prompt-/Task-Typen im Code (`taskType`)
1. `chat`
2. `analyzePhoto`
3. `analyzeHotspots`
4. `analyzeBlueprint`
5. `videoAnalysis`
6. `analyzeReceipt`
7. `estimateValue`
8. `batchEstimateValues`
9. `containerCheck`
10. `test`

> Hinweis: `chat` wird teils implizit als Default genutzt und in `chat.js` explizit gesetzt.

#### Function Calling
- Aktiv im Chat-Call (`tools: ORDO_FUNCTIONS`)
- Definierte Funktionen (11):
  1. `add_item`
  2. `remove_item`
  3. `remove_items`
  4. `move_item`
  5. `replace_items`
  6. `add_room`
  7. `add_container`
  8. `delete_container`
  9. `rename_container`
  10. `delete_room`
  11. `show_found_item`

#### Thinking-Modus
- `thinkingConfig` ist task-spezifisch aktiv:
  - 512: `analyzePhoto`, `analyzeReceipt`, `estimateValue`
  - 1024: `batchEstimateValues`
  - 2048: `analyzeBlueprint`, `containerCheck`, `roomCheck`
  - 4096: `householdCheck`, `videoAnalysis`
- Kein Thinking für `chat`, `analyzeHotspots`, `test`.

### 3D) Architektur-Patterns

1. **Observer-Pattern (Brain Events)**
   - `Brain.on/off/_emit` in `brain.js`
   - Emittierte Eventtypen: `dataChanged`, `roomAdded`, `roomDeleted`, `containerAdded`, `containerDeleted`, `itemAdded`, `itemRemoved`, `itemMoved`, `itemArchived`, zusätzlich `actionExecuted` (aus `ai.js` via `Brain._emit`)

2. **Event-Delegation (Brain-View)**
   - Zentraler Delegation-Handler auf dem Brain-Root statt viele Einzel-Listener für jede Zeile/Kachel
   - `closest(...)`-basiertes Routing auf Action-Selektoren

3. **Overlay-Manager (Prioritäts-Stack)**
   - `requestOverlay(id, priority, closeFn)` blockiert niedrigere/gleichhohe Overlays
   - `releaseOverlay` und `closeTopOverlay` steuern Stack-Lebenszyklus
   - Prioritäten im aktuellen Code: **30, 50, 60, 70, 80, 100**

4. **Offline-Queue**
   - Offline-Fotos in `localStorage`-Queue + Blob in IndexedDB
   - Verarbeitung bei App-Start (delayed) und bei `online`-Event

5. **Loading-Manager (Phasen-Feedback)**
   - Zentral in `ai.js`
   - Task-abhängige Texte/Phasen

6. **Persönlichkeits-System (3 Stufen)**
   - `sachlich`, `freundlich`, `kauzig`
   - beeinflusst den Chat-Systemprompt

### 3E) Tests

#### Wie viele Tests gibt es?
- **259** `it(...)`-Testfälle in den echten Testdateien

#### Welche Test-Dateien existieren?
- `tests/brain.test.js`
- `tests/app-logic.test.js`
- `tests/ux-flows.test.js`
- `tests/organizer.test.js`
- `tests/quest.test.js`
- plus Infrastruktur:
  - `tests/test-runner.js`
  - `tests/module-loader.js`
  - `tests/run-all.js`

#### Was wird getestet, was nicht?
**Getestet (stark):**
- Brain-Core (CRUD, Migrationen, Lifecycle, Werte/Garantie-Bausteine)
- Marker-/Action-Logik inkl. Normalisierung
- zentrale UX-Flows mit Mock-DOM

**Getestet (schmal):**
- Organizer (nur wenige Kernfälle)
- Quest (Basisfälle)

**Nicht als echter End-to-End-Pfad abgedeckt:**
- Service Worker/PWA-Lebenszyklus in realem Browser
- echte Netz-/Gemini-Integrationspfade
- echte Kamera/NFC/Speech-Interaktion

### 3F) PWA-Qualität

#### Service Worker
- Cache-Version: `v7`
- Strategie:
  - **App-Shell:** Stale-While-Revalidate
  - **sonstige GET-Ressourcen:** Cache-first (+ runtime put)
  - **Gemini-API-Calls:** explizit vom Caching ausgenommen
  - **Dokument-Fallback:** `index.html` bei Fetch-Fehlern

#### Was wird gecacht?
- App-Shell enthält HTML, CSS, alle Kernmodule, Manifest und Icons

#### Manifest
- Name: `ORDO – Dein Haushaltsassistent`
- Short name: `ORDO`
- Display: `standalone`
- Orientation: `portrait`
- Theme color: `#E8A87C`
- Background color: `#FFFFFF`
- Icons: `192x192`, `512x512` (`purpose: any maskable`)
- Sprache: `de`

#### Viewport-Konfiguration
- `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`

### 3G) Externe Abhängigkeiten

#### CDN/Libraries
1. **jsPDF**  
   - Version: `2.5.2`  
   - Einbindung: CDN (`cdnjs`) via Script-Tag
2. **jsPDF AutoTable**  
   - Version: `3.8.4`  
   - Einbindung: CDN (`cdnjs`) via Script-Tag

#### Externe Dienste/APIs
- Google Gemini REST API (`generativelanguage.googleapis.com`) für Text/Bild/Video-Analyse
- Gemini Files API für resumable Video-Upload + Polling

---

## 4) Was noch offen ist

### 4A) Geparkte Features

Es gibt **kein separates Konzeptdokument** (z. B. Produkt-Roadmap-Spezifikation) im Repository.  
Vorhanden sind Audit-/Review-Berichte (`CODEBASE_AUDIT_REPORT.md`, `QUALITY_REVIEW_REPORT_SPRINT.md`, `CODE_REVIEW.md`), die primär Bestands- und Qualitätsanalysen dokumentieren.

Daher: **Kein eigener „geplant aber nicht implementiert“-Katalog aus dedizierten Konzeptdokumenten ableitbar.**

### 4B) Bekannte Einschränkungen (aus Code ableitbar)

1. **Kein eigenes Backend / keine Serverpersistenz**
   - Daten liegen nur im Browser (lokal).
2. **Kein Multi-User / keine Authentifizierung**
   - Kein Nutzerkonto-, Rollen- oder Rechtekonzept im Code.
3. **API-Key im Client**
   - Key liegt in `localStorage`; Requests gehen direkt vom Browser an Gemini.
4. **Keine Push-Notifications**
   - Kein Push-/Notification-Service implementiert.
5. **Abhängigkeit von Browser-Features**
   - NFC, Kamera, Speech hängen von Geräte-/Browserunterstützung ab.
6. **Offline nur teilweise**
   - Lokales Arbeiten möglich, KI-Funktionen benötigen Netz/API-Key; Queue puffert nur bestimmte Flows.
7. **PWA-Caching ohne differenzierte feingranulare Invalidation pro Modul**
   - Versionierung zentral über SW-Cache-Version.

---

## 5) Statistiken

| Metrik | Wert |
|---|---:|
| Module (JS, produktiv) | 17 |
| Gesamtzeilen JS (ohne Tests) | 12.931 |
| Gesamtzeilen CSS | 4.509 |
| Gesamtzeilen HTML | 572 |
| Tests gesamt (`it`) | 259 |
| Test-Dateien | 5 (plus 3 Test-Infrastruktur-Dateien) |
| localStorage-Keys (aktiv) | 11 |
| Gemini-Prompt-Typen (`taskType`) | 10 (inkl. `chat` als explizit/default) |
| Function-Call-Definitionen | 11 |
| Observer-Events | 10 |
| Overlay-Prioritäten | 6 (30, 50, 60, 70, 80, 100) |

---

## 6) Roadmap-Empfehlung

### 1. Baut direkt auf bestehender Infrastruktur auf

1. **Organizer- und Quest-Ausbau**
   - Mehr Regeln/Scoring-Feinheiten in `organizer.js`
   - Mehr Schrittlogik/UX-Politur in `quest.js`
   - Begründung: Grundarchitektur, Datenmodell und Overlays sind vorhanden.

2. **Testausbau in schwachen Bereichen**
   - Organizer- und Quest-Testtiefe erhöhen
   - Queue-Replay-/Konfliktfälle ergänzen
   - Begründung: Test-Framework existiert bereits.

3. **Bessere Reporting-Varianten**
   - zusätzliche PDF-Filter/Layouts, z. B. nur Räume, nur Garantien, nur fehlende Werte
   - Begründung: `report.js` ist schon ausgebaut.

### 2. Benötigt neue Infrastruktur (aber kein Fundamentwechsel)

1. **Sichere Key-Verwaltung**
   - optionaler Proxy/Token-Relay statt direkter Client-Key-Nutzung
2. **Optionaler Cloud-Sync**
   - Backup/Synchronisation über User-Konto
3. **Telemetrie/Diagnosekanal**
   - strukturierte Fehler-/Performance-Logs statt rein lokaler Debug-Strings

### 3. Benötigt fundamentale Änderungen

1. **Multi-User & Rechte**
   - Nutzerverwaltung, Auth, Datenschutz-/Berechtigungsmodell
2. **Echte kollaborative Datenhaltung**
   - Konfliktlösung, Versionierung, ggf. serverseitiges Event-/Sync-Modell
3. **Serverseitige KI-Orchestrierung**
   - zentralisiertes Prompting, Kostenkontrolle, Schutz vor API-Key-Exposition

---

## Kurzfazit

ORDO ist technisch kein Prototyp mehr, sondern eine funktionsreiche, lokal-first PWA mit realer KI-Integration, stabiler Datenkernarchitektur und breiter Featurebasis (Chat, Foto-Workflows, Quest, Organizer, Versicherung/Report, NFC). Der größte nächste Hebel liegt nicht in neuen Einzel-Features, sondern in **Qualitätstiefe** (Testabdeckung in Integrationspfaden), **Sicherheits-/Betriebsreife** (Key/Backend-Optionen) und **Skalierung der Architektur** (bei langfristigem Multi-User-/Cloud-Ziel).
