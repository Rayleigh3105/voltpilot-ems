# UEMS AP-08 IP-3: Momentanwert und Intervallmenge je Periode — und die gekennzeichnete Integration

Migration `V20260912213000__uems_intervall_momentanwert.sql`; Regeln
`uems/VerbrauchRegeln.momentanwertTeil`/`momentanwertAusTeilperioden` (und die Intervallmengen-
Zwillinge) ⟷ Python `verbrauch.momentanwert_teil`/`momentanwert_aus_teilperioden`; Vertrag
`docs/contracts/v2/verbrauch.md` §8, `regeln.werte_teilperioden`, Fälle F3, F18, **F24** (neu) und
F2 (halbe Stunde, neu). Läufe unverändert im Ablauf: `ViertelstundeVerdichter`, `TagVerdichter`,
`PeriodeVerdichter`, Eingang `ViertelstundenTeile.werte`. Tests: `VerbrauchWerteteileTest` +
`test_verbrauch.py` (Lockstep, rein), `UemsIntervallMomentanwertTest` (Testcontainers).

## Die drei Wertarten

| Wertart (Rohwert → Regel) | Was je Periode entsteht | Wo |
|---|---|---|
| `counter` → **Zählerstand** | `menge` aus den Periodenständen (IP-2/IP-5) | `uems-viertelstundenmenge.md`, `uems-periodenmengen.md` |
| `gauge` → **Momentanwert** | `mittel`/`min_wert`/`max_wert`, `summe` (ungerundet), **gemessene Zeit** `gemessen_s`, `luecke_innen`, `menge_zustand`, `kennzeichen` — und **nur mit Bindung `integration`** die `energie` | hier |
| — → **Intervallmenge** | Regel und Zusammensetzung verdrahtet, aber **kein Rohwert-Wort** | hier, Befund |

⚠ **Ein Momentanwert trägt NIE `menge`** (M6) — CHECK `…_momentanwert_chk` an Viertelstunde, Tag
und Monat/Jahr. Seine Energie steht in `energie`, nie in der Spalte, die Lesepfad und Summen als
Verbrauch lesen.

## Das Kennzeichen „aus Leistung integriert" (E5)

- **Wann integriert wird:** nur, wenn eine Quellenbindung der Reihe (`messstelle_quelle`, Komponente
  + Kanal) die Herleitung **`integration`** trägt und ihre Gültigkeit das Intervall berührt
  (`ViertelstundeVerdichter.integrationJeAuftrag`). Eine Spannung wird nie integriert, bloß weil sie
  ein Momentanwert ist.
- **Das Kennzeichen ist nicht optional:** der Wortlaut ist `VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT`
  (Vertrag), die Datenbank weist eine Energie ohne das Wort ab (`messreihe_energie_gekennzeichnet`,
  `…_energie_kennzeichen_chk`).
- **Keine Zahl über eine Lücke:** Rechteck-Halten bis zum nächsten guten Wert, höchstens zwei
  Kadenzen; darüber hält ein Wert nur seine eigene Kadenz. Ohne einen guten Wert: `energie` NULL, nie
  0, nie Mittel × Länge (halb gemessene Viertelstunde im Test: 9,0 kWh, nicht 18,0).
- **Ein Tag/Monat/Jahr integriert nur, wenn JEDER Teil mit Werten seine Energie trägt.** Beginnt die
  Bindung mitten am Tag (oder stammt eine Viertelstunde von vor IP-3), hat der Tag keine Energie —
  eine zu kleine Summe wäre eine Behauptung.
- **Halten über die Grenze:** der Wert vor einer Grenze hält bis zum nächsten Wert dahinter (F24:
  18,667 statt 18,444 kWh). Darum liest der Viertelstunden-Lauf seit IP-3 zwei Kadenzen über das
  Intervall hinaus — die Zählerstand-Regel sieht weiter genau `(Beginn − Kadenz, Ende]`.

## Die gemessene Zeit

`gemessen_s` = gute Werte × Kadenz (M2). Ein Mittel über eine halb gemessene Viertelstunde ist das
Mittel der **vorhandenen** Werte; `abdeckung_prozent` sagt wie viel, `menge_zustand` ob vollständig
(M3: keine Lücke über zwei Kadenzen, beide Ränder innerhalb einer Kadenz), das Kennzeichen „gemessene
Zeit x:ss min von y min" steht an jeder unvollständigen Periode. Abdeckung ist nicht Vollständigkeit.

## Die Fortpflanzung

- **Mittel = Summe ÷ erhalten**, nie ein Mittel von Mitteln. Der Tageslauf gewichtete vor IP-3 die
  gerundeten Viertelstunden-Mittel — nur auf 0,05 genau. Ein Teil ohne `summe` (Bestand vor IP-3)
  zählt mit `mittel × erhalten`, genau so ungenau wie vorher.
- **Vollständigkeit** aus `luecke_innen` der Teile, den Abständen zwischen den Teilen (`erster_*`/
  `letzter_*`) und den Nachbarn davor/danach — ein unvollständiger RAND an einer inneren Grenze ist
  keiner mehr. `ViertelstundenTeile.laden` liest dafür zusätzlich die erste Viertelstunde mit gutem
  Wert ab `bis`; sie geht NICHT in die Zählerstand-Teile ein.
- **Energie** = Summe der ungerundeten Teil-Energien + Halten in Strecken OHNE Zeile. ⚠ Die
  Tagesenergie ist darum nicht immer die Summe der Viertelstunden-Energien (Test: der Wert 10:57
  hält zwei Minuten in eine leere Viertelstunde).
- Tag und Monat aus den Viertelstunden, Jahr aus den Monaten (wie IP-5). `messreihe_periode` hat
  seit IP-3 `mittel`/`min_wert`/`max_wert`; `summe` am Tag/Monat nur an `gauge` (`…_summe_chk` —
  eine Summe von Mengen gibt es nie).

## ⚠ Befund: die Intervallmenge hat kein Rohwert-Wort

`value_kind` kennt `counter, gauge, state, bitfield, text` — und die wertart-CHECKs der drei
Werteklassen ebenso. Die **Intervallmenge einer Messstelle** entsteht aus einem Zähler (Herleitung
`differenzen`) oder aus einer Leistung (`integration`); eine Reihe, die selbst Intervallmengen
liefert, gibt es heute nicht. I1/I2 samt Zusammensetzung sind in beiden Zwillingen geprüft (F2) und
im Lauf verdrahtet (`regelWort`), laufen aber in keiner Datenbank. Bekommt das Vokabular das Wort,
wachsen Rohwert-CHECK, wertart-CHECKs, Katalog und `…_summe_chk` gemeinsam. I3 (gröberer Eingang)
und I4 (Intervall über die Grenze) sind nicht gebaut, I5 ist keine Reihe, M5 ist IP-7.

## Grenzen

- **Nachbarn:** ein Nachzügler in den ersten zwei Kadenzen einer Viertelstunde ändert Halten und
  Lücke der VORIGEN; die Arbeitsliste trägt nur die Viertelstunde des Rohwerts ein (dieselbe Grenze
  wie `Stand(bis)` auf der Grenze, IP-12). Die Viertelstunde sieht nur zwei Kadenzen über ihr Ende:
  ein Loch, das erst dahinter endet, macht sie nicht unvollständig — Tag und Monat sehen es.
- Eine **später angelegte** Bindung `integration` ändert nur neu gebildete Viertelstunden; es gibt
  keine Rückrechnung dafür. Endgültige Zeilen bleiben unberührt, keine Korrektur (IP-12 ff.).
- Keine Route, keine Fläche, kein freier Zeitraum für Momentanwerte (`ZeitraumMenge.zeitraum` bleibt
  Zählerstand). Der Lesepfad zeigt `energie` nur mit Kennzeichen — `uems-lesepfad-verlauf-herkunft-rueckfall.md` §8.

Prüfnachweis (gezielt): `(cd services/api && ./mvnw test -Dtest='VerbrauchVectorsTest,VerbrauchWerteteileTest,UemsIntervallMomentanwertTest')`,
`(cd services/optimization && ./.venv/bin/python -m pytest tests/test_verbrauch.py -q)` — JDK 21 und
Docker nötig.
