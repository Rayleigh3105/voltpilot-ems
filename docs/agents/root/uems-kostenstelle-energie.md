# UEMS-Kostenstellen-Sicht: gemessen · verteilt · berechnet — und was niemandem gehört (AP-10 IP-11)

Neu am 14.09.2026. **Eine Kostenstelle muss sagen können, WOHER ihre Zahl kommt.** Konzept
`vp-uems-ap10-bilanzen` §4.6, §4.7, §5.7, §8 IP-11; Entscheide E12 (Tagesanteile) und E13 (eigener Herkunftsvertrag).

## Die vier Herkünfte

| Herkunft | Wann | Kennzeichen am Posten |
|---|---|---|
| **gemessen** | eine gemessene Messstelle geht an diesem Tag zu **100 %** an die Kostenstelle | „verteilt (100 % von MS-17)“ + Kennzeichen der Quelle |
| **verteilt** | eine gemessene Messstelle geht zu einem Anteil **unter 100 %** an sie (ein Mensch hat ihn gesetzt) | „verteilt (70 % von MS-07)“ … „Verteilung geändert am 15.01.2027“ |
| **berechnet** | eine **berechnete** Messstelle (Summe, Rest) geht an sie — gleich zu welchem Anteil | „verteilt (…)“ + „berechnet (Differenz)“ … |
| **nicht verteilt** | eine Messstelle hat an einem Tag einen **Wert, aber keine Verteilungszeile** | „nicht verteilt“ + Kennzeichen der Quelle |

⚠ **„Nicht verteilt“ wird NIE aufgeteilt und NIE weggelassen.** Der Block gehört keiner Kostenstelle: er steht in
JEDER Kostenstellen-Sicht des Kundenbereichs gleich da und zählt in `summe` nie mit. Eine Summe der Kostenstellen, die
den Gesamtverbrauch trifft, weil der Rest still verteilt wurde, ist eine Lüge mit stimmiger Summe. Benannter Test
`KostenstelleEnergieApiTest.nichtVerteiltVerschwindetNieUndWirdNieAufgeteilt`.

| Was | Wo |
|---|---|
| Route | `GET /api/v1/unternehmen/kostenstellen/{id}/energie?periode=tag\|monat\|jahr&am=&version=` (`web/KostenstelleEnergieController`, `web/dto/KostenstelleEnergieDto`) |
| Regel (rein) | `uems/KostenstelleEnergieRegeln.energie` — RUFT `VerteilungRegeln.amTag`/`.erbe` und `BilanzAbleitung.summeOhneAnzeige`; Vertrag Regel `kostenstelle` in `verteilung-vectors.json` 1.2 (F6, F12, F13, F14), nur Java (`zwillinge_grund`) |
| Dienst | `uems/KostenstelleEnergieService` (Tageswerte über `MessstelleWerteService`, Versionen ≥ 2 über `KostenstelleEnergieRepository.versionen`, Herkunft über `BilanzwertHerkunft`) |
| Warnung vor doppelter Zählung | `uems/KostenstelleDoppelzaehlung.pruefe` (rein, Regel `doppelzaehlung` in `verteilung-vectors.json` 1.4) über dieselben Quellen + `BerechnetePeriodenLauf.formelnJeTag` → Feld `doppelzaehlung` (letztes Feld, `enthalten[]`/`nicht_pruefbar[]`) — ändert keine Zahl |
| Kaskaden-Anschluss | `uems/BilanzNeuBerechnet.melden`, gerufen in `KorrekturKaskade.verarbeiten` — KEINE zweite Kaskade |
| Migration | `V20260914140000__uems_bilanz_neu_berechnet.sql`: nur das Vokabular (Funktion + Art-CHECK), keine Tabelle |
| Ereignis | `bilanz_neu_berechnet` (28. Art, nur `cloud`, [von, bis) = die Tage, Bezug NUR die Messstelle, Pflicht `ausloeser` K-…/EW-…) — api + writer `EreignisVokabular`, ingest `BoxEventsValidator.ARTEN`, `uemsEreignis.ts`, `events-raw.event.schema.json` |
| Rechte | `messstelle.ansehen` (Anmerkung in `rechte-matrix.json`), eingetragen, nicht durchgesetzt |
| Tests | `VerteilungVectorsTest` · `KostenstelleEnergieSchnittstelleVertragTest` (rein) · `KostenstelleEnergieApiTest` (10, davon `dieZahlenSindZeichengleich` gegen `src/test/resources/uems/doppelzaehlung-vorher/`) · `UemsBilanzNeuBerechnetMigrationTest` (5) · `UemsKorrekturKaskadeTest` (+2) |

```bash
(cd services/api && ./mvnw test -Dtest='VerteilungVectorsTest,KostenstelleEnergieSchnittstelleVertragTest,EreignisVokabularVectorsTest')
(cd services/api && ./mvnw test -Dtest='KostenstelleEnergieApiTest,UemsBilanzNeuBerechnetMigrationTest,UemsKorrekturKaskadeTest')  # Docker
```

## Die Fallen

1. **Tagesanteile (E12).** Jeder Tag mit SEINEM Anteil, die Periode ist die Summe der Tage — nie ein Periodenbetrag
   mit Stichtag-Anteil (F13: 10 000 / 5 500 kWh, nicht 9 300). Die Summe ist die der Bilanz: ein unvollständiger Tag
   zählt NICHT mit und steht in `fehlend` („mindestens“-Logik), der Posten heißt dann „unvollständig“.
2. **`null` ist nie 0.** Ohne Zuordnung `menge: null` + `grund: keine_zuordnung` (auch gegen die Anzeige der Vorlage
   „9010 Druckluft 0 kWh“, `_abweichungen`). Ein zugeordneter Tag ohne Rohwert ist „keine Werte“
   (`quelle_keine_werte`, so sagt es das Lese-Modell), ohne gespeicherten Schritt `kein_tageswert`. Verschiedene
   Größen/Richtungen/Einheiten → `groessen_gemischt`, je Größe eine `summen`-Zeile (Erzeugung ≠ Abgabe, kWh ≠ m³).
3. **Version 1 bleibt lesbar (F14).** Verteilte Werte werden NIE gespeichert; ein Posten trägt die höchste Version
   seiner Tage (aus `messreihe_periode_version`, Kaskade) und EINMAL „korrigiert (Version n)“. `version=n` liest je
   Tag die höchste Version bis n — `version=1` zeigt die Zahlen vor jeder Korrektur.
4. **„Nicht verteilt“ nur mit Menge.** Eine Messstelle ohne Anteil und ohne eine einzige Menge an den offenen Tagen
   steht nicht im Block (nichts gemessen, nichts offen); ein Momentanwert ohne Anteil nie.
5. **Herkunft (E13).** Je Posten (nicht bei „nicht verteilt“) ein Satz der Art `verteilt` nach
   `bilanzwert-herkunft.schema.json`: Ziel = die Kostenstelle, Fassung des letzten verteilten Tages, EIN Eingang =
   die Quelle über dieselben Tage, ab Version 2 Auslöser `correction MS-xx TT Version n` (seit IP-12 ohne K-Kennung, wie
   F14), `berechnet_am` = die Sicht; seit IP-12 an `tage[]` einer berechneten Quelle der gespeicherte Satz des Tages
   (`uems-bilanzwert-herkunft-routen.md`). Der Messwert-Herkunftsvertrag bleibt unberührt.
6. **Die Meldung kommt aus DERSELBEN Transaktion wie die Versionen** — für jede berechnete Messstelle mit neuer
   Version und jede gemessene Messstelle einer korrigierten Reihe mit Anteil an den Tagen; die Kennung ist abgeleitet
   (Anlass, Fassung, Status, Messstelle). ⚠ Tests, die `messreihe_ereignis` vor/nach der Kaskade vergleichen, nehmen
   die Art aus (`UemsKorrekturKaskadeTest.meldungenVorher`).

## Befunde (benannt, nicht still gelöst)

- **Doppelte Zählung im Referenzunternehmen — seit 14.09.2026 GEWARNT, nicht behoben (Captain-Entscheid „Warnen — die
  Sicht sagt, welcher Posten in welchem enthalten ist, und ändert keine Zahl“):** MS-20 (MS-06 + MS-11 + Anteil 4100
  von MS-07) geht zu 100 % an 4100, MS-06, MS-11 und MS-07 (70 %) ebenfalls — die Sicht zeigt jeden Posten weiter
  ehrlich und ihre `summe` zählt weiter doppelt, aber `doppelzaehlung.enthalten` sagt „MS-06 ist bereits in MS-20
  enthalten“ (auch MS-07: der Term „Anteil 4100“ ist genau dieser Posten, obwohl MS-20 ihn heute ohne Menge führt).
  ⚠ Wer die Warnung anfasst, fährt `dieZahlenSindZeichengleich`: jede Antwort bis `doppelzaehlung` byte-gleich zum
  Stand vor der Warnung. Anteile, Kreis, Abzug: Falle 13 in `docs/contracts/v2/verteilung.md`.
- **Hauptzähler stehen unter „nicht verteilt“:** die Verteilung kennt keine Stellung; MS-01/MS-10/MS-16 („verteilt
  über Unterzähler“) haben keine Zeile und stehen darum dort. Ob ein Hauptzähler mit Unterzählern ausgenommen wird,
  entscheidet die Fläche (IP-15) oder ein Konzept-Nachtrag.
- **Rückwirkend geänderte Verteilung erzeugt keine Version:** die Sicht rechnet sofort mit der neuen Fassung; die
  alte bleibt nur als Zeile (`aufgehoben_am`/`gueltig_bis`) und als `verteilung_geaendert` lesbar, nicht als Zahl
  (F13 „korrigiert (Version 2, rückwirkend 5 Tage)“ ist nicht gebaut).

## Nicht gebaut

Portal-Fläche und `api.ts` (IP-15), Rechte-Durchsetzung (AP-03).
