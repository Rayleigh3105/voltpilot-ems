# Korrektur-Prüfseite und Ersatzwert-Routen (AP-08 IP-16)

Die Portal-Routen stehen in `KorrekturPortalController` und `KorrekturPortalService`;
Formen und Felder sind gegen `docs/contracts/openapi.yaml` geprüft. Die vorhandenen
Freigabe-/Rücknahmerouten bleiben in `KorrekturFreigabeController`.

- `GET /standorte/{standortId}/korrekturen`, `GET /korrekturen/{kennung}`:
  Standort-Zaun vor Inhalt und Rechten; Vorschau, Urheber, Begründung, mögliche
  Entscheidungen und Auswirkungen. Die Detailform normalisiert auch die bestehende
  Ablese-Spur; ihr ursprünglicher Schreib- und Freigabeweg bleibt erhalten.
- `GET /messstellen/{kennzeichen}/ersatzwerte/luecken` liefert die letzte
  Fortschreibung einer sichtbaren Lücke, einschließlich des tatsächlichen Zuwachses.
  Die bestehende Werte-Route enthält nur Ereigniskennung und Zeit, keine Nutzlast.
- `POST /messstellen/{kennzeichen}/ersatzwerte/vorschau` liest ausschließlich.
  `POST /messstellen/{kennzeichen}/ersatzwerte` erfasst Ersatzwert und Korrektur
  atomar. Bei Vier-Augen bleibt die Korrektur ein Vorschlag; sonst wird sie direkt
  freigegeben. Nachgetragene Ablesestände nach Endgültigkeit (F12) und
  System-Vorschläge werden weiterhin nie automatisch freigegeben.
- `POST /korrekturen/{kennung}/ablehnen` hängt eine Ablehnung an.
  `POST /ersatzwerte/{kennung}/zuruecknehmen` funktioniert auch für Ersatzwerte aus
  dem Bestand ohne verknüpfte Korrektur. Verknüpfte Rücknahmen schreiben beide
  Fassungen gemeinsam, auch über die vorhandene Korrektur-Rücknahme.

## Ein Rechenplan

`ErsatzwertLauf.planen` lädt dieselben Fakten für Vorschau und Job. Die Vorschau
schreibt keine Probe-Zeilen. Gröbere Perioden rechnen über `KaskadeStufen` mit
zusätzlichen, ausschließlich im Speicher gehaltenen Vorschau-Eingängen. Das Jahr
berücksichtigt dabei auch die Monate der geplanten Viertelstunden-Versionen.
`KorrekturPortalAuswirkungen` findet die abhängigen Formeln; Kennzahlen und Berichte
verwenden ihre vorhandene Kaskaden-Auswahl. Namen werden auf die Lesesicht begrenzt.

Vor Freigabe eines Ersatzwert-Vorschlags wird der Plan unter derselben Reihensperre
wie der Job erneut geprüft. Geänderte Fakten verlangen eine neue Prüfung (409).
JSON-Zahltypen nach einem jsonb-Rundlauf sind kein fachlicher Unterschied.

## Freigabe ist noch keine gebildete Version

`messreihe_ersatzwert` kennt nur wirksam/zurückgenommen. Ein verknüpfter offener oder
abgelehnter Korrektur-Vorschlag sperrt den Ersatzwert daher **in jeder Leseauswahl des
Jobs und der Periodenrechnung**. Die Kaskade wartet auf die gerechnete Ersatzwert-
Fassung. Sie verarbeitet anschließend den Korrektur-Anlass genau einmal; der
verknüpfte Ersatzwert ist kein zweiter Kaskaden-Anlass. Seine `correction`-Meldung
trägt die Ersatzwertkennung, wie das Ereignisvokabular verlangt.

Ein unverknüpfter Ersatzwert aus dem Bestand läuft unverändert über den bisherigen
Ersatzwert-Anlass. Rohwerte und bestehende Versionszeilen werden nicht verändert.

## Prüfung

`KorrekturPortalApiTest`: echte JWT-/RLS-Routen, read-only Vorschau, Vorschau gegen
Job/Kaskade, Vier-Augen, unveränderte Werte vor Freigabe, Standort-Bearbeiter,
fremde Standorte/Quellen, Ablehnen, beide Rücknahmen und unverknüpfter Bestand.
`KorrekturFreigabeSchnittstelleVertragTest` hält auch die neuen DTOs gegen OpenAPI.
Bei Änderungen am Freigabedienst zusätzlich Ablesung und Bezugswert-Eingabe prüfen.

TimescaleDB 2.17 kann `DISTINCT ON` unter den RLS-Unterplänen mit SkipScan ablehnen.
`ErsatzwertLauf.neuesteVersionen` liest darum geordnet und entdoppelt in Java; die
Mengenbildung und Auswahl der neuesten Version bleiben identisch.

## Portal (IP-16)

Am Standort öffnet `MessstellenPage` die Korrektur-Liste. Auf der Messstellen-Seite
bindet `WerteSektion` die `KorrekturWerkzeuge` ein: dieselbe Liste für die Messstelle,
Ersatzwerte sowie Einstiege an Lücken-, Zählerbruch- und Korrektur-Markern. Ohne den
Kontext bleiben andere Wirte der Werte-Sektion unverändert. Die Rechte kommen aus
`rollen.ts`, die einzelne Freigabe zusätzlich aus dem aktuellen Server-Urteil.

`korrekturen.ts` bestimmt Methoden nach Lückenart und bildet Eingaben ab. Es rechnet
keinen Verbrauch. Geschlossene Lücken werden auf die einschließenden Viertelstunden
bezogen, wie der bestehende Ersatzwert-Vertrag es verlangt. Vorschau und Auswirkungen
kommen vom Server; `KorrekturVorschau` skaliert diese Werte ausschließlich für das Bild.
`ErsatzwertDialog` schreibt erst nach Vorschau, `KorrekturenDialog` begründet jede
Entscheidung. Nach Neuladen eines Verlaufs wird der neue Auslöser fokussiert.

Prüfen: `korrekturen.test.ts`, `KorrekturenDialog.test.tsx`, `copy.test.ts` und die
Tests der geänderten Wirte. `e2e/korrekturen.spec.ts` nimmt bei 375/1440 px auf;
`KORREKTUR_BILDER` legt die echten Bildschirmfotos außerhalb des Repos ab.
