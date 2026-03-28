## 1. Modul-Übersicht

### 1A: Datei-Übersicht (alle JavaScript-Dateien)

| Datei | Zeilen | Imports von | Exportiert |
|---|---:|---|---|
| ai.js | 1347 | ./brain.js, ./app.js, ./chat.js, ./brain-view.js | 26 Exports inkl. `callGemini`, `determineModel`, `ORDO_FUNCTIONS` |
| app.js | 183 | ./brain.js, ./chat.js, ./photo-flow.js, ./brain-view.js, ./onboarding.js, ./settings.js, ./camera.js, ./quest.js | Re-Export-Block (`showView`, `escapeHTML`, etc.) |
| brain-view.js | 3345 | ./brain.js, ./modal.js, ./app.js, ./photo-flow.js, ./camera.js, ./chat.js, ./ai.js, ./report.js, ./quest.js, ./organizer.js | Re-Export-Block (View-Funktionen) |
| brain.js | 1970 | – | `default Brain` + Konstanten |
| camera.js | 326 | – | `capturePhoto`, `captureVideo`, `setupCamera` |
| chat.js | 690 | ./brain.js, ./ai.js, ./modal.js, ./app.js, ./brain-view.js, ./photo-flow.js, ./camera.js, ./organizer.js | 17 Exports inkl. `sendChatMessage` |
| modal.js | 149 | – | `showToast`, `showInputModal`, `showConfirmModal` |
| onboarding.js | 684 | ./brain.js, ./ai.js, ./modal.js, ./app.js, ./photo-flow.js, ./camera.js, ./quest.js | 8 Exports inkl. `analyzeRoomScanPhotos` |
| organizer.js | 503 | ./brain.js, ./ai.js | 16 Exports inkl. Score-/Decision-Funktionen |
| photo-flow.js | 1698 | ./brain.js, ./ai.js, ./modal.js, ./app.js, ./brain-view.js, ./onboarding.js, ./chat.js, ./camera.js | Re-Export-Block (inkl. Offline Queue APIs) |
| quest.js | 654 | ./brain.js, ./ai.js, ./modal.js, ./brain-view.js, ./photo-flow.js, ./app.js | 17 Exports inkl. Blueprint/Quest-Steuerung |
| report.js | 749 | ./brain.js, ./ai.js, ./modal.js, ./app.js | `showReportDialog` |
| service-worker.js | 87 | – | keine ES-Exports (SW-Skript) |
| settings.js | 342 | ./brain.js, ./ai.js, ./modal.js, ./app.js, ./photo-flow.js, ./brain-view.js, ./report.js, ./chat.js | `setupSettings`, `renderSettings`, etc. |
| tests/app-logic.test.js | 750 | CommonJS (`require`) | keine ES-Exports |
| tests/brain.test.js | 1632 | CommonJS (`require`) | keine ES-Exports |
| tests/module-loader.js | 68 | CommonJS (`require`) | `module.exports = { stripModuleSyntax }` |
| tests/organizer.test.js | 97 | CommonJS (`require`) | keine ES-Exports |
| tests/quest.test.js | 99 | CommonJS (`require`) | keine ES-Exports |
| tests/run-all.js | 40 | CommonJS (`require`) | keine ES-Exports |
| tests/test-runner.js | 81 | CommonJS (`require`) | `module.exports = {...}` |
| tests/ux-flows.test.js | 561 | CommonJS (`require`) | keine ES-Exports |

### 1B: Abhängigkeits-Graph

**Import-Topologie (Produktivmodule):**
- `brain.js` wird von 10 Modulen importiert (klarer Core-Knoten).
- `ai.js` und `app.js` werden jeweils von 8 Modulen importiert.
- `service-worker.js` wird von keinem Modul importiert (wird korrekt über `navigator.serviceWorker.register(...)` geladen).

**Wichtige Befunde:**
1. **Großer zyklischer Cluster**: `ai.js`, `app.js`, `brain-view.js`, `chat.js`, `onboarding.js`, `organizer.js`, `photo-flow.js`, `quest.js`, `report.js`, `settings.js` hängen indirekt zirkulär zusammen.
2. **Gott-Modul-Tendenz**: `brain-view.js` (3345 Zeilen) bündelt sehr viel UI-/Feature-Logik.
3. **Kein offensichtlicher ungenutzter Produktiv-ES6-Modulfile** (bis auf SW-Sonderfall).

### 1C: Größen-Check

- **> 1000 Zeilen:** `ai.js` (1347), `photo-flow.js` (1698), `brain.js` (1970), `brain-view.js` (3345)
- **> 2000 Zeilen:** `brain-view.js` (3345)
- Fazit: **Ja, `brain-view.js` ist wieder monolithisch** und stellt den größten Wartbarkeits-/Regressionstreiber dar.

---

## 2. Konsistenz-Report

### 2A: API-Aufruf-Konsistenz

**Was konsistent ist:**
- Alle gefundenen Gemini-Aufrufe laufen über `callGemini(...)`.
- `callGemini(...)` nutzt zentral `determineModel(...)` + `taskType`-basiertes Thinking + `logApiCall(...)`.

**Inkonsistenzen / Lücken:**
1. **LoadingManager nicht einheitlich**:
   - `chat.js`, `photo-flow.js`, `quest.js` nutzen `loadingManager` aktiv.
   - `settings.js` Debug-Test (`callGemini`) ohne `loadingManager`.
   - `onboarding.js` API-Key-Test (`callGemini`) ohne `loadingManager`.
2. **`taskType` fehlt nirgends in den gefundenen `callGemini`-Calls** (positiv).
3. **Hardcoded Modell außerhalb Routing:** nicht gefunden (positiv).
4. **try/catch um API-Aufrufe nicht überall gleich stark nutzerorientiert**:
   - Einige Catches informieren Nutzer via Toast/Systemmessage.
   - Andere Stellen loggen nur/verschlucken Fehler (z. B. einige non-blocking Catches).

### 2B: Function-Calling-Konsistenz

- `ORDO_FUNCTIONS` werden im Chat-Call mitgeschickt (`tools: ORDO_FUNCTIONS`) und priorisiert verarbeitet.
- Legacy-Marker (`<!--ORDO:...-->`, `<!--SAVE:...-->`, etc.) laufen als Fallback weiter.
- Function-Call-Ergebnisse werden via `functionCallToAction(...)` normalisiert und dann ausgeführt.
- **Unbekannte Function-Calls** werden nur geloggt und verworfen (kein expliziter User-Hinweis).

### 2C: Observer-Pattern-Konsistenz

**Positiv:**
- `Brain.save(...)` emittiert zentral `dataChanged`.
- Kern-Mutationen (`addItem`, `removeItem`, `moveItem`, `archiveItem`) emittieren domänenspezifische Events.
- Listener-Nutzung ist defensiv (`try/catch` pro Callback).

**Auffälligkeiten:**
1. Nur wenige `Brain.on(...)`-Abonnenten (`brain-view`: `dataChanged`; `quest`: `itemAdded`).
2. Einige Datenänderungen laufen über direkte `localStorage.setItem(...)` außerhalb des Brain-Eventsystems (z. B. Queue/Settings-Schlüssel) – gewollt, aber uneinheitlich.
3. Potenzial für Doppel-Trigger in Quest-Fluss: sowohl `ordo:review-confirmed` als auch `itemAdded` können Schrittabschluss anstoßen (mit Guards, aber eng gekoppelt).

### 2D: Naming-Konsistenz

- **JS-Funktionen:** überwiegend camelCase, konsistent.
- **CSS-Klassen:** überwiegend kebab-case, konsistent.
- **Event-Namen:** Mischung aus `dataChanged` und `ordo:...`-CustomEvents (intern konsistent, global aber heterogen).
- **LocalStorage-Keys:** uneinheitliche Präfixe (`haushalt_*`, `ordo_*`, `gemini_api_key`, `brain_view_mode`).
- **IndexedDB-/Photo-Keys:** mehrere Schemata (`room_container_ts`, `blueprint_room_*`, `queued_*`) – funktional ok, aber inkonsistent.

---

## 3. Feature-Integrations-Probleme

### 3A: Quest + Organizer

- **Overlay-Kollision potenziell möglich**: Quest-Overlay und Organizer-Overlays werden unabhängig in DOM gerendert; es gibt keine zentrale Overlay-Orchestrierung.
- Quest-Fortschritt wird bei Item-Änderungen aktualisiert (Observer + Event), Dashboard-Refresh hängt an `renderBrainView()`/`dataChanged` und funktioniert im Codepfad grundsätzlich.
- Parallelität (Quest + Aufräum-Session) ist technisch möglich; explizite Produktregel dafür ist nicht zentral abgesichert.

### 3B: Versicherungsbericht + Organizer

- Bericht verarbeitet standardmäßig aktive Items; archivierte Items sind filterbar/ausblendbar.
- Damit erscheinen „entsorgt/gespendet“ (archiviert) standardmäßig nicht in aktiven Summen.
- `archived_reason` wird nicht als eigener Auswertungskanal im Bericht prominent genutzt (mehr Status-basiert als Grund-basiert).

### 3C: Wertschätzung + Organizer

- Organizer nutzt `valuation.replacement_value || purchase.price` bei Stale/Quick-Decision-Kontext.
- Archivieren in Organizer wirkt auf Gesamtwert, da Wertberechnung archivierte Items ausklammert.
- Regel „<10€ höhere Entsorgungspriorität“ ist nicht als harte, klar sichtbare globale Priorisierungsregel zentral codiert; eher implizit über vorhandene Heuristiken.

### 3D: Blueprint + bestehende Räume

- Bestehende Räume/Container werden nicht blind dupliziert (`addRoom`/`addContainer` prüfen Existenz).
- Namens-/ID-Kollisionen führen eher zu Merge/Reuse als Duplikat.
- Bei gleichen Namen aber anderer Semantik bleibt man auf slug-ID-Logik angewiesen (Risiko: semantische Kollision statt Duplikat).

### 3E: Offline-Queue + Quest + Organizer

- Quest-Foto offline: wird in Queue gelegt.
- Queue-Verarbeitung nutzt später regulären Photo-Flow; dadurch können Quest-Schritte über `itemAdded` abgeschlossen werden.
- Organizer-Kernfunktionen sind lokal datenbasiert und offline nutzbar; KI-gestützte Checks benötigen Online/API.

### 3F: Persönlichkeit + Function Calling

- Persönlichkeit beeinflusst den Chat-Systemprompt direkt.
- Function-Calling-Definitionen werden unabhängig davon im selben Chat-Call mitgesendet.
- Keine sichtbare branch-spezifische Einschränkung nach Persönlichkeitsstufe.

---

## 4. Code-Qualität

### 4A: Error Handling

Befunde:
1. Es gibt mehrere **silent catches** (`catch {}`) für wichtige Nebenpfade (z. B. Fotospeichern, Einbettungen, lokale Logs).
2. Mehrere Catches nutzen nur `console.warn`/`debugLog` ohne User-Feedback (teils bewusst non-blocking).
3. `JSON.parse` ist häufig abgesichert, aber nicht ausnahmslos in allen `localStorage`-Lesewegen mit Recovery-Strategie.
4. IndexedDB-Operationen sind oft defensiv gekapselt; Fehler werden teils nur still aufgelöst.

### 4B: Memory & Performance

- Viele Event-Listener werden bei Setup gebunden; mehrfaches Setup wird in einigen Modulen abgefangen, aber nicht überall gleich strikt.
- Große Dateien (`brain-view.js`, `brain.js`, `photo-flow.js`) erhöhen Re-Render-/Wartungsrisiko.
- Offline-Queue wächst potenziell bis Abarbeitung; Retry-Einträge bleiben erhalten (kein hartes Aging/Backoff-Limit sichtbar).
- Keine offensichtliche unendliche Rekursion gefunden.

### 4C: Datenmodell-Integrität

- Migration String→Objekt-Items ist weiterhin implementiert und in Tests breit abgedeckt.
- Defaults für neue Felder (`quest`, `valuation`-Teilfelder, `archived_reason`) werden meist defensiv behandelt.
- Referenzintegrität (Item→Container) hängt stark an Laufzeit-Guards; kein globales Integrity-Audit über Gesamtdaten gefunden.
- Gleichzeitige Writes: zentrale `save(...)` reduziert Risiko, aber UI-Events + asynchrone Flows können enge Timing-Fenster erzeugen.

### 4D: Toter Code

- Keine komplett toten Kernmodule gefunden.
- Potenziell ungenutzte Export-/Hilfsfunktionen sind ohne Voll-Callgraph schwer final zu belegen; hier wäre Lint/coverage-gestützte Nachanalyse sinnvoll.

### 4E: Duplikate im Code

- Wiederkehrende Patterns bei Overlay-Rendering/`innerHTML`-Blöcken.
- Wiederholte JSON-Extraktion aus Modellantworten (Regex + Parse + Fallback) in mehreren Stellen.
- Wiederkehrende UI/Toast/Catch-Muster über Module verteilt.

---

## 5. Test-Abdeckung

### 5A: Test-Inventar

| Test-Datei | Anzahl Tests (`it`) | Was wird getestet |
|---|---:|---|
| tests/brain.test.js | 155 | Datenmodell, Migration, Observer, Quest-Basis, Warranty, Fuzzy-Logik |
| tests/app-logic.test.js | 57 | Marker-Parsing, Action-Normalisierung/Ausführung, Error-Mapping, Offline-Queue-Logik |
| tests/ux-flows.test.js | 41 | UI-Flows (gemockt), Navigation, Review/Picking/Settings |
| tests/organizer.test.js | 4 | Kernheuristiken Organizer |
| tests/quest.test.js | 2 | Quest-Sortierung + Progress-Basis |

### 5B: Test-Lücken (nach Risiko)

- **Hoch:** echte End-to-End-Interaktion zwischen `quest.js`, `photo-flow.js`, `brain-view.js` (vor allem Offline→Online-Replay).
- **Hoch:** `ai.js` echte API-Integrationspfade inkl. Function-Calling-Edgecases.
- **Mittel:** Organizer-Scoring/Quick-Decision-Heuristik deutlich unterabgedeckt (nur 4 Tests).
- **Niedrig:** reine Renderpfade teils vorhanden, aber stark mock-basiert.

### 5C: Test-Qualität

- Positiv: Viele Tests prüfen konkrete Ergebnisse statt „läuft ohne Fehler“.
- Einschränkung: Großteil ist Unit-/Mock-lastig; Browser-/PWA-/SW-Realitätsnähe begrenzt.
- Keine offensichtlichen „immer-grünen No-op“-Tests dominant, aber einige Flows bleiben sehr oberflächlich.

---

## 6. Sicherheit

### 6A: API-Key-Handling

- API-Key liegt im `localStorage` (`gemini_api_key`) im Klartext.
- Kein Hardcoding im Quellcode gefunden.
- In Debug-Logs wird ein gekürzter Key-Preview geloggt (erste Zeichen sichtbar).

### 6B: Daten-Exposition

- Externe API-Ziele im Code fokussieren auf Gemini-Endpunkte.
- Service Worker cached generisch GET-Ressourcen; bei gleichen Origin-Routen ist das sinnvoll, sollte aber auf sensible Antworten geprüft bleiben.
- Diverse Nutzungs-/Statusdaten liegen im `localStorage` (inkl. Queue, Personality, API-Log).

### 6C: Input-Sanitization

- Es gibt `escapeHTML(...)`, aber viele Stellen nutzen `innerHTML` direkt mit dynamischen Inhalten.
- Insbesondere bei zusammengesetzten Overlays (z. B. Quest-/Organizer-/Report-HTML) besteht prinzipielles XSS-Risiko, falls untrusted Inputs durchlaufen.
- Gemini-Response-Text wird nicht zentral sanitisiert, bevor er in HTML-Templates landen könnte (kontextabhängig).

---

## 7. PWA-Qualität

### 7A: Service Worker

- Cache-Version ist auf `v6`.
- App-Shell enthält aktuell nur Kernassets (`index.html`, `style.css`, `app.js`, `brain.js`, `manifest.json`).
- Neue Feature-Module sind nicht explizit App-Shell-gepinnt, werden aber via Runtime-Caching geholt.
- Offline-Strategie: SWR für Shell, Cache-first für Rest; grundsätzlich solide, aber Update-/Stale-Risiko bei modulreicher App bleibt.

### 7B: Manifest

- Icons `192` und `512` referenziert.
- Theme-/Background-Farben gesetzt.
- Name/Short-Name aktuell konsistent zum Produktbranding im Code („Haushaltsassistent“/„Haushalt“), aber UI-Texte sprechen oft „ORDO“.

### 7C: Performance-Budgets

- Gesamtgröße (JS+CSS+HTML): ~594.9 KB roh.
- JS allein: ~461.4 KB roh.
- App-Shell Cold-Load (SW kalt): ~193.7 KB roh.
- Große Module (`brain-view.js`, `brain.js`, `photo-flow.js`) sind Kandidaten für weitere Aufteilung/lazy loading.

---

## 8. Priorisierte Fix-Liste

### Kritisch (Nutzerwirkung hoch)
1. **XSS-/Sanitization-Härtung** bei `innerHTML`-Pfaden mit dynamischen Daten. (Aufwand: M)
2. **Overlay-/Flow-Koordination Quest vs Organizer** (gleichzeitige Overlays/Interaktionen). (Aufwand: M)
3. **Monolithische `brain-view.js` Entkopplung** zur Senkung von Regressionen. (Aufwand: L)

### Mittel
4. **Error-Handling vereinheitlichen** (silent catches auf echte UX-Entscheidung bringen). (Aufwand: M)
5. **LocalStorage-/Key-Schema konsolidieren** (Prefixing, Datenschutzklarheit). (Aufwand: S-M)
6. **Organizer-/Quest-Integrations-Tests ausbauen** (offline replay, race-nahe Flows). (Aufwand: M)

### Niedrig
7. **Duplikate (JSON-Parse-/Overlay-Muster) abstrahieren**. (Aufwand: M)
8. **SW App-Shell-Strategie dokumentieren/justieren** (gezieltes Precaching wichtiger Module). (Aufwand: S-M)

---

## 9. Gesamtbewertung

**Ehrliche Einschätzung:**
- Die Codebasis ist **funktional fortgeschritten** und für einen schnellen Feature-Sprint bemerkenswert robust (insb. Brain-Tests).
- **Aber**: Durch starke zyklische Kopplung + sehr große UI-Module + inkonsistente Fehler-/Sanitization-Pfade ist das Risiko für regressionsreiche Releases erhöht.

**Produktionsreife:**
- **Eingeschränkt produktionsreif** für kontrollierten Einsatz/Beta.
- Für breiten Rollout sollten die kritischen Punkte (Sanitization, Overlay-Koordination, Modulschnitt) zuerst adressiert werden.

**Manuell zu testen (explizit):**
- Gleichzeitige Quest+Organizer-Overlay-Flows auf echten Mobilgeräten.
- Offline-Queue-Replay mit aktivem Quest-Schritt über mehrere Fotos.
- SW-Update-Verhalten bei Feature-Deploys (stale module edge cases).
