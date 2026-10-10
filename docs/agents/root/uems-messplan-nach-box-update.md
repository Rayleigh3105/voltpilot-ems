# UEMS: Messplan nach dem Box-Update (Generalprobe B2)

Angelegt am 23.09.2026. Befund B2 der Rollout-Generalprobe: jede Box mit Mess-Auswahl verlor beim
Box-Update ihren Messplan.

## Ablauf, der den Plan verlor

1. Die Box bekommt ein Release mit neuem Laufzeitstand (Palette `catalog.json`) und startet neu.
2. Der Core spielt die gespeicherte Konfiguration alten Stands lokal wieder ein
   (`edge-app/core/internal/agent/measurements.go`, `setMeasurementIdentity`).
3. Der Planer verlangt exakte Gleichheit des Stands (`measurement-planner.js`, `buildPlan`) und lehnt
   alles mit `unsupported_catalog` ab. Der vorherige Plan lag nur im RAM: keine Messung.
4. Die Ablehnung ist eine gültige Quittung derselben Revision. `edge_ack` besteht, nichts ist offen.
   Der Revisions-Anstoß (PR 1128) greift nur bei einem geteilten Punkt.

## Regel (MessplanNachBoxUpdateApiTest)

- `MeasurementConfigReconciler#katalogstandNachliefern` läuft am Anfang jedes Durchlaufs und beim Start.
  Er wählt aus der Datenbank Boxen mit einer aktiven Zeile `rejected`/`unsupported_catalog`, ohne
  offene Revision, deren letztes `selection_requested` einen anderen Stand trägt als
  `MeasurementCatalog#version`.
- `MeasurementSelectionService#planImKatalogstandNeuAusliefern` prüft das unter der Gerätesperre erneut.
  Es legt Revision + 1 an: ein `selection_requested` mit dem heutigen Stand, Akteur
  `system:katalogstand`. Keine Auswahlzeile ändert sich. `pending()` liefert im selben Durchlauf aus.
- **Ohne Schleife:** Lehnt die Box auch den heutigen Stand ab (Box ohne Update gegen die neue Cloud),
  trägt die letzte Revision schon diesen Stand. Dann folgt nichts mehr. Andere Ablehnungsgründe lösen
  nichts aus.
- Die Box meldet ihren Laufzeitstand nicht; das Urteil ist die Ablehnung selbst. Ein wählbares
  Statusfeld `catalog_version` wäre eine additive Verfeinerung (Core `WrapStatus`, Listener,
  Vertrag). Sie ist nicht gebaut.
- Aus der Datenbank, nicht aus der Quittung: Die Regel greift in beiden Reihenfolgen. Kam das
  Box-Update vor dem api-Deploy, liefert die neue api beim Start nach.

## Rollout-Reihenfolge

Die api mit dieser Regel wird vor dem Box-Release deployt. Nur die api kann nachliefern. Eine Box, die
vorher ihr Update bekommt, misst bis zum api-Deploy nicht. Tor GA, Punkt `NW-3u`
(`tools/freigabe/pruefe_tor.py`), verlangt den grünen Bericht von `MessplanNachBoxUpdateApiTest`.
Die Box-Hälfte liegt in `measurement-runtime.test.js` („update path …“). NW-3/NW-3neu prüfen nur
eine frische Box.
