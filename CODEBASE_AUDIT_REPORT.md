# ORDO – Codebase Audit Report

**Datum:** 2026-03-27
**Zweck:** Vollständiger Abgleich Codebasis vs. Dokumentation

---

## 1. Codebasis-Übersicht

### Dateistruktur & Zeilenanzahl

| Datei | Zeilen | Zweck |
|-------|--------|-------|
| **app.js** | 154 | Bootstrap, Wiring, Entry Point |
| **brain.js** | 1.327 | Datenhaltung, LocalStorage, IndexedDB |
| **brain-view.js** | 1.774 | Hierarchische Ansicht (Brain-View) |
| **photo-flow.js** | 1.515 | Foto-Workflow, Hotspots, Staging, Review |
| **chat.js** | 552 | Chat-Interface, Spracherkennung |
| **ai.js** | 605 | Gemini API, Marker-System |
| **onboarding.js** | 674 | Onboarding-Wizard |
| **settings.js** | 303 | Einstellungen, NFC-Schreiben |
| **camera.js** | 326 | Kamera-Hardware, Video-Recording |
| **modal.js** | 149 | Modale Dialoge, Toast-System |
| **service-worker.js** | 87 | PWA Offline-Cache |
| **index.html** | 516 | HTML-Struktur |
| **style.css** | 3.501 | Gesamtes Styling |

**Summe Produktionscode: 11.483 Zeilen**

### Tests

| Datei | Zeilen | Abdeckung |
|-------|--------|-----------|
| brain.test.js | 1.347 | Brain-Logik, Migration, Lifecycle |
| app-logic.test.js | 661 | App-Logik, Marker-System |
| ux-flows.test.js | 559 | UX-Flows, Chat, Review |
| test-runner.js | 81 | Custom Test-Framework |
| module-loader.js | 67 | Modul-Loader für Tests |
| run-all.js | 38 | Test-Runner-Script |

**Summe Testcode: 2.753 Zeilen**

### Architektur-Status

**Modul-Refactoring: Abgeschlossen.** app.js ist nur noch 154 Zeilen (Bootstrap).
Der Code ist in 10 ES6-Module aufgeteilt mit sauberer Import/Export-Struktur.
Kein Monolith mehr.

---

## 2. Feature-Status-Matrix

### MVP-Kern-Features

| # | Feature | Status | Dateien | Funktionen |
|---|---------|--------|---------|------------|
| 1 | Chat-View | ✅ Implementiert | chat.js, ai.js | `setupChat()`, `sendChatMessage()`, `callGemini()` |
| 2 | Foto-Analyse | ✅ Implementiert | photo-flow.js, ai.js | `handlePhotoFile()`, `analyzeHotspots()` |
| 3 | Review-Popup | ✅ Implementiert | photo-flow.js | `showReviewPopup()`, `renderReviewPopup()` |
| 4 | Brain-View | ✅ Implementiert | brain-view.js, brain.js | `renderBrainView()`, `buildRoomNode()`, `buildContainerNode()` |
| 5 | NFC-Kontext | ✅ Implementiert | app.js, brain-view.js | `parseNfcParams()`, `getNfcContext()`, `setNfcContext()` |
| 6 | NFC-Tag schreiben | ✅ Implementiert | settings.js | `writeNfcTag()`, `showNfcFallback()` |
| 7 | Rekursive Hierarchie | ✅ Implementiert | brain.js, brain-view.js | `_findContainerInTree()`, `addChildContainer()`, `getContainerPath()` |
| 8 | Onboarding | ✅ Implementiert | onboarding.js | `showOnboarding()`, `finishOnboarding()`, `Brain.isEmpty()` |
| 9 | JSON Export/Import | ✅ Implementiert | brain.js, settings.js | `exportData()`, `importData()`, `exportWithPhotos()`, `importWithPhotos()` |
| 10 | IndexedDB für Fotos | ✅ Implementiert | brain.js | `initPhotoDB()`, `savePhoto()`, `getPhoto()`, `savePhotoWithHistory()` |
| 11 | Chat ändert Datenbank | ✅ Implementiert | ai.js, chat.js | `executeOrdoAction()`, `processMarkers()` – add_item, remove_item, move_item, delete_room etc. |
| 12 | Spracherkennung | ✅ Implementiert | chat.js, photo-flow.js | `toggleMic()`, `togglePickingMic()` – Web Speech API (de-DE) |
| 13 | PWA / Service Worker | ✅ Implementiert | service-worker.js, manifest.json | Stale-while-revalidate, Cache v5, Offline-fähig |
| 14 | Einstellungen | ✅ Implementiert | settings.js | `renderSettings()` – API-Key, Impressum, Debug, Foto-History-Limit |

### Erweiterte Features

| # | Feature | Status | Dateien | Anmerkungen |
|---|---------|--------|---------|-------------|
| 15 | Visual Proof on Demand | ✅ Implementiert | chat.js | `renderFoundPhotoButtons()`, `showProofLightbox()` – FOUND-Marker, Foto-Alter-Warnung |
| 16 | Interaktives Picking / Hotspots | ✅ Implementiert | photo-flow.js | `showPickingView()`, `renderPickingHotspots()`, `openHotspotPanel()` – Klick-to-Confirm |
| 17 | Delta-Abgleich | ✅ Implementiert | brain.js, brain-view.js | 3-Sektionen-Review: Bestätigt/Neu/Fehlend, automatische Archivierung |
| 18 | Item-Lebenszyklus | ✅ Implementiert | brain.js | `createItemObject()` – status, first_seen, last_seen, seen_count, menge |
| 19 | Visual Decay | ✅ Implementiert | brain-view.js, brain.js | `getItemFreshness()` – CSS: fresh/stale/ghost, Emojis ⏱👻 |
| 20 | Visuelle Deduplizierung | ✅ Implementiert | photo-flow.js, brain.js | `findSimilarItem()`, `isFuzzyMatch()`, `levenshtein()` – 3 Mechanismen (A/B/C) |
| 21 | Spatial UX | 🔨 Teilweise | photo-flow.js, brain-view.js | Hotspot-Positionen gespeichert, Map-View existiert, Drag-UX unvollständig |
| 22 | Mobiles vs. Festes Inventar | 🔨 Teilweise | brain.js, brain-view.js | Infrastruktur-Filterung ✅, UI-Filter mobil/fest fehlt |
| 23 | Mengen-Erkennung | ✅ Implementiert | brain.js, photo-flow.js | `menge`-Feld, "3x"-Parsing, Review-Popup mit Mengen-Editor |
| 24 | Staging-System | ✅ Implementiert | photo-flow.js | `setupStagingOverlay()`, `addFileToStaging()` – max 5 Fotos |
| 25 | Modal-System | ✅ Implementiert | modal.js | `showInputModal()`, `showConfirmModal()`, `showToast()` – Promise-basiert |
| 26 | Modul-Refactoring | ✅ Implementiert | alle | 10 ES6-Module, app.js nur 154 Zeilen Bootstrap |
| 27 | Map-View | ✅ Implementiert | brain-view.js | `setupMapViewToggle()`, `renderMapView()` – List/Map-Toggle, 2 Zoom-Stufen |
| 28 | Toast-System | ✅ Implementiert | modal.js | `showToast(type, message, duration)` – success/error/warning/loading |

**Zusammenfassung: 26 von 28 Features voll implementiert, 2 teilweise.**

---

## 3. Datenmodell-Analyse

### Aktuelle Datenstruktur (LocalStorage, Key: `haushalt_data`)

```javascript
{
  version: '1.3',
  created: 1711234567890,
  rooms: {
    "kueche": {
      name: "Küche",
      emoji: "🍳",
      containers: {
        "schrank_1": {
          name: "Oberschrank",
          typ: "schrank",
          items: [
            {
              name: "Teller",
              status: "aktiv",           // aktiv | vermisst | archiviert
              first_seen: "2026-03-15T10:30:00",
              last_seen: "2026-03-20T14:00:00",
              seen_count: 3,
              menge: 5
            }
          ],
          uncertain_items: [],
          containers: { /* verschachtelte Container */ },
          photo_analyzed: true,
          has_photo: true,
          photo_history: ["1711234567890"],
          infrastructure_ignore: [
            { name: "Scharnier", marked_at: "2026-03-15" }
          ],
          last_updated: 1711234567890
        }
      },
      container_order: ["schrank_1"],
      last_updated: 1711234567890
    }
  },
  chat_history: [
    { role: "user", content: "Wo sind meine Teller?", ts: 1711234567890 }
  ],
  last_updated: 1711234567890
}
```

### Items: Dual-Format mit Lazy Migration

Items können **Strings (Legacy v1.2)** oder **Objekte (v1.3)** sein.
Beim Zugriff via `getContainer()` werden Strings automatisch migriert
(`_migrateContainerItems()`, brain.js:510-520). Migration ist lazy –
erst wenn ein Container geladen wird.

**Lifecycle-Felder vorhanden:** status, first_seen, last_seen, seen_count,
menge, archived_at, spatial, crop_ref, object_id.

### IndexedDB vs. LocalStorage

| Aspekt | LocalStorage | IndexedDB |
|--------|--------------|-----------|
| **Inhalt** | Alle Metadaten (Räume, Container, Items, Chat) | Nur Foto-Blobs |
| **DB/Key** | Key: `haushalt_data` | DB: `haushalt_photos`, Store: `photos` |
| **Format** | JSON-String | Binäre Blobs mit Timestamp |
| **Zugriff** | Synchron | Asynchron (Promise-basiert) |
| **Key-Schema** | – | `{roomId}_{containerId}_{timestamp}` |
| **Größenlimit** | ~5-10 MB | 50+ MB |
| **Export** | Direkt als JSON | Konvertiert zu DataURL vor Export |

### buildContext() – Was die KI sieht

**Funktion:** brain.js:1008-1069

Erzeugt einen Klartext-String der gesamten Haushalt-Struktur:
- Zeigt nur **aktive + vermisste** Items (archivierte separat als Hinweis)
- Inkludiert Mengen ("5x Teller") und Status-Marker ("vermisst")
- Rekursive Verschachtelung mit Einrückung
- Container-IDs für KI-Referenz in ORDO-Markern
- Letzte 20 archivierte Items als historischer Kontext

**Beispiel-Output:**
```
Raum: 🍳 Küche [id: kueche]
  schrank: Oberschrank [id: schrank_1] → 5x Teller, Glas (vermisst)
    Archiviert: Serviette (entfernt am 15.03.2026)
```

---

## 4. Technische Schulden

### 4.1 prompt() / alert() / confirm()

**Status: SAUBER.** Null Vorkommen in Produktionscode.
Alle browser-nativen Dialoge wurden durch `showInputModal()`,
`showConfirmModal()` und `showToast()` ersetzt.

### 4.2 Event-Listener-Duplikate – KRITISCH

`renderBrainView()` wird wiederholt aufgerufen und erzeugt in
`buildContainerNode()` bei jedem Render neue Event-Listener via
`addEventListener` in forEach-Schleifen, **ohne die alten zu entfernen**.

| Datei | Zeilen | Problem |
|-------|--------|---------|
| brain-view.js | 224-271 | Item-Chips: click + drag Handler in forEach |
| brain-view.js | 282-299 | Archivierte Items: click-Handler in forEach |
| brain-view.js | 312-324 | Uncertain Items: click-Handler in forEach |
| photo-flow.js | 907-929 | Staging-Thumbnails: click-Handler ohne Cleanup |

Nur **3 `removeEventListener`-Aufrufe** im gesamten Projekt (modal.js, camera.js).
Listener akkumulieren bei jedem Re-Render → **Memory Leak**.

### 4.3 Globale Variablen

**Kein window-Pollution.** Alle Module nutzen ES6-Module mit let/const
auf Modul-Ebene. Keine `window.xxx`-Zuweisungen. Modul-State-Variablen
(z.B. `let dragState` in brain-view.js) sind korrekt gekapselt.

### 4.4 Error Handling – Lücken

| Problem | Datei | Zeile | Detail |
|---------|-------|-------|--------|
| Swallowed Errors | brain.js | 248, 252, 430, 436, 846 | `.catch(() => {})` verschluckt alle Fehler |
| Kein Catch | settings.js | 139 | `clipboard.writeText().then(...)` ohne `.catch()` |
| Unzuverlässig | ai.js | 18 | `navigator.onLine` ist nicht zuverlässig |
| Generisch | ai.js | 98 | Alle API-Fehler → "Kurze Verbindungsstörung" |
| Kein Timeout | ai.js | ~471 | Video-Upload kann hängen bleiben |

**Positiv:** `callGemini()` in ai.js hat solides try/catch mit benutzerfreundlichen Meldungen.

### 4.5 Performance-Risiken bei 500+ Items

| Problem | Datei | Zeilen | Impact |
|---------|-------|--------|--------|
| Volle DOM-Neuberechnung | brain-view.js | 69, 95-97 | `innerHTML = ''` + kompletter Re-Build |
| Nested Loops bei Drag | brain-view.js | 535-582 | `buildDropBar()` iteriert alle Container |
| DOM-Queries in Drag-Move | brain-view.js | 603 | `querySelectorAll()` auf MouseMove |
| O(m×n) Levenshtein | brain.js | 1121-1124 | String-Vergleich bei Fuzzy-Match |
| Kein Paging | photo-flow.js | 1161 | Review-Popup rendert alle Items |
| Kein Debouncing | settings.js | 131-134 | Input-Event ohne Debounce |

---

## 5. Offene Fragen – Antworten

### Frage A: Quality Sprint durchgeführt?

**JA. Vollständig.** Alle browser-nativen Dialoge sind ersetzt.
`modal.js` enthält `showInputModal()`, `showConfirmModal()`, `showToast()`.
Null prompt()/alert()/confirm() im Produktionscode.

### Frage B: Modul-Refactoring durchgeführt?

**JA. Vollständig.** app.js war vorher ~4.664 Zeilen, ist jetzt 154 Zeilen
Bootstrap. 10 ES6-Module mit sauberer Import/Export-Trennung.

### Frage C: Daten-Frische Phase 1 implementiert?

**JA.** Delta-Abgleich beim Re-Fotografieren ist implementiert
(3-Sektionen-Review: Bestätigt/Neu/Fehlend). Item-Lebenszyklus mit
status/first_seen/last_seen/seen_count ist aktiv. Visual Decay mit
CSS-Klassen (fresh/stale/ghost) und Emoji-Indikatoren funktioniert.

### Frage D: Deduplizierung implementiert?

**JA.** Drei-Schicht-System: Mechanismus A (Hotspot-Bestätigung),
B (Fuzzy-Match beim Picking), C (Container-Kontext bei Foto-Analyse).
Levenshtein-Distanz + deutsche Artikel-Normalisierung.

### Frage E: Filterung Mobiles vs. Festes Inventar implementiert?

**TEILWEISE.** Infrastruktur-Filterung ist da (Umzugskarton-Metapher im
Prompt, `infrastructure_ignore`-Liste, Uncertain-Hotspot-UI). Aber: Es gibt
**keinen expliziten UI-Filter** "zeige nur mobile Gegenstände" in der Brain-View.

### Frage F: Visual Proof on Demand v2 implementiert?

**JA.** FOUND-Marker im System-Prompt, `renderFoundPhotoButtons()` zeigt
Foto-Beweis-Buttons im Chat, Lightbox mit Alter-Warnung,
"Neues Foto"/"Stimmt nicht mehr"-Aktionen.

---

## 6. Empfehlung: Priorisierte nächste Schritte

### Priorität 1 – Technische Schulden (Stabilität)

1. **Event-Listener-Cleanup** – `buildContainerNode()` in brain-view.js
   erzeugt bei jedem Render neue Listener ohne Cleanup. Lösung: Event-Delegation
   auf Container-Ebene oder `replaceChild()`-Pattern.

2. **Error-Handling konsolidieren** – Die 5× `.catch(() => {})` in brain.js
   durch sinnvolles Logging ersetzen. Clipboard-API in settings.js absichern.

### Priorität 2 – Performance (Skalierbarkeit)

3. **Brain-View virtualisieren** – Bei 500+ Items wird der volle DOM-Rebuild
   zum Problem. Mindestens: Collapsed-Rooms nicht rendern, Pagination für
   große Container.

4. **Drag-Performance** – `buildDropBar()` und DOM-Queries in
   `handleDragMove()` optimieren (Caching, Throttling).

### Priorität 3 – Feature-Vervollständigung

5. **Mobiles vs. Festes Inventar UI** – Filter-Toggle in der Brain-View
   hinzufügen (Infrastruktur ist da, UI fehlt).

6. **Spatial UX vervollständigen** – Drag-and-Drop für Items zwischen
   Containern ist vorbereitet, UX unvollständig.

### Priorität 4 – Robustheit

7. **Offline-Erkennung verbessern** – `navigator.onLine` durch tatsächlichen
   Fetch-Test ergänzen.

8. **Video-Upload Timeout** – AbortController mit Timeout für Gemini
   File API Upload.

---

## Gesamtbewertung

Der Code ist **überraschend sauber**: 26/28 Features implementiert, saubere
Modulstruktur, Tests vorhanden, keine browser-nativen Dialoge mehr. Die
Hauptrisiken sind Event-Listener-Leaks und fehlende Performance-Optimierung
für große Datensätze.
