# UEMS-Kennzahl-Wochen (AP-11 IP-12)

Die Woche als Periode einer Kennzahl: `periode_art = woche` für jede Kennzahl mit Grundperiode Tag (Tag → Woche · Monat ·
Jahr) und für eine mit Wochen-Bezugsgröße als Nenner (Grundperiode Woche → nur Woche). Spezifikation: AP-11 §8 IP-12,
E3 (P1–P5), K13. Keine Migration, keine neue Route — `GET …/werte?periode=woche` las die Zeilen schon (IP-7).

## Was es tut

- **Lauf und Vorschau** bilden die Woche wie jede andere Periode (`KennzahlLauf.kennzahl`, `KennzahlVorschauService`),
  fein vor grob: Tag, Woche, Monat, Jahr. Die Woche ist nie Teilperiode — `KennzahlLauf.feinere` überspringt sie, sie geht
  in keinem Monat auf.
- **Messstelle je Woche** über `MessstelleWerteService.wochen` (paketweit, kein Raster der Route): Grenzen
  `MessstelleWerteRegeln.woche` = Montag 00:00 bis Montag 00:00 in der Zone des STANDORTS der Anlage (167/168/169 h),
  Reihe über `MessstelleWerteRegeln.deckung`, Menge `ZeitraumMenge.zeitraum` (über `SpeicherklasseHistorie.zeitraum`) —
  aus den Periodenständen an den Wochengrenzen, nie Summe der Tage.
- **Bezugsgröße je Woche, Stammdatum, Kennzahl:** die vorhandenen Lesewege von `KennzahlEingangLeser` (wirksame Fassung,
  Stichtag Sonntag, gespeicherte Wochen-Zeile).
- **Passung unverändert:** `KennzahlRegeln.periode` (P1–P3). Eine Monatskennzahl aus Wochenwerten bleibt 422
  `periode_passt_nicht` (K13 Versuch 2), eine Tageskennzahl aus Monatswerten ebenso.

## Fallen

- ⚠ **Die Woche hat keine Versionen** — wie die Stunde: trägt eine ihrer Viertelstunden eine Version ab 2 (Kaskade,
  Ersatzwert), liefert die Messstelle `version_nicht_gebildet` ohne Zahl, und die Kennzahl-Woche wird „keine Werte“
  (`zaehler_fehlt`) — nie die Zahl von Version 1. Befund: erst ein `ZeitraumMenge` mit Versionen macht korrigierte Wochen
  wieder zählbar.
- ⚠ **Berechnete Messstelle hat keine Woche** (`berechnet`, keine Wochen-Spur); ebenso Momentanwert und Energie aus Leistung
  (`integration`). Eine Wochen-Kennzahl auf einem Gesamtwert bleibt ohne Zahl (Befund).
- ⚠ **Zone:** die Datenbank führt nur `TagRegeln.ZONEN` (Berlin, Wien, Zürich — alle mit Berliner Versatz). Die abweichende
  Zone belegt die Regel (`MessstelleWerteRegelnTest`, New York); der Testcontainers-Fall zeigt Zürich, Ortszeit statt UTC
  und 169 Stunden am Ende der Sommerzeit.
- ⚠ **Bestehende Kennzahlen mit Tages-Grundperiode** bekommen Wochen-Zeilen, sobald ihre Messstelle Viertelstunden hat.
  Monat und Jahr bleiben, wie sie waren (die Zeit-Periode liest Tage, nie Wochen).
- **Kosten:** je Woche mit Bindung ein `ZeitraumMenge.zeitraum`; Wochen ohne Bindung fragen nichts (`keine_quelle`). Der
  Regellauf reicht 24 Monate zurück (≈ 105 Wochen).

## Prüfen

`MessstelleWerteRegelnTest` (Wochengrenzen), `KennzahlVectorsTest` Familie `periode` (Wochenfälle als Annahme),
`KennzahlLaufQuelltextTest` (rein); `UemsKennzahlRechenlaufTest.ip12…`, `KennzahlApiTest.k13…` (Testcontainers).
