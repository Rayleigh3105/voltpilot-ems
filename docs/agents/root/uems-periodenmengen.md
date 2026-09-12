# UEMS-Periodenmengen: Tag, Monat, Jahr und freier Zeitraum aus den Periodenständen

**AP-08 IP-5.** Migration `V20260912205000__uems_periodenmengen.sql`; Regel
`uems/VerbrauchRegeln.zaehlerstandAusTeilperioden` ⟷ Python
`voltpilot_optimization/verbrauch.zaehlerstand_aus_teilperioden` (Vertrag
`docs/contracts/v2/verbrauch.md` §7, `regeln.teilperioden`); Eingang `uems/ViertelstundenTeile`;
Läufe `uems/TagVerdichter` (Tag) und `uems/PeriodeVerdichter` (Monat, Jahr) im Takt von
`EndgueltigkeitLaeufer`; freier Zeitraum `uems/ZeitraumMenge`. Tests: `VerbrauchTeilperiodenTest`
+ `test_verbrauch.py` (Lockstep, rein), `UemsPeriodenmengeTest` (Testcontainers).

## Der eine Satz

**Eine Tagesmenge ist NICHT die Summe der Viertelstunden.** Sie ist Stand am Tagesende − Stand
am Tagesanfang über die gemessenen Strecken. Die Summe verliert jede Lücke, in der keine
Viertelstundenmenge bildbar war (F8: Summe 1 966,4 kWh, Tag 2 304,0 kWh vollständig — die
Differenz ist der gemessene Zuwachs über den Box-Ausfall), und sie ist schon ohne Lücke falsch,
weil jede Teilmenge gerundet ist (F16: 31 Tage = 55 100,013 kWh, der Oktober = 55 100,000).

## Aus Periodenständen — wie genau

Die Regel bekommt die gespeicherten **Teilperioden** (Stand(von), Stand(bis), erster/letzter
guter Wert, Menge, erhalten, erwartet, Kennzeichen) und rechnet Kettenende − Kettenanfang, plus
je Teilperiode ihren **Bruch** (Gerätegrenze, Überlauf, Rücksetzung — sonst genau 0) und je
Grenze OHNE Stand die Nachbarschaft „letzter Wert davor → erster Wert danach" (Lücke, Rücksetzung,
Gerätegrenze wie in der Rohwert-Regel). `VerbrauchTeilperiodenTest` hält an jeder
Zählerstand-Erwartung ≥ 30 min fest, dass das dasselbe ergibt wie die Regel über die Rohwerte.

⚠ **Fehlt ein Stand an einer Grenze, wird keiner erfunden.** Die Menge ist dann der gemessene
Teil und `unvollständig` mit „Anfang/Ende nicht gemessen" (Z3, F20) — nie ein fortgeschriebener
oder zurückgerechneter Stand, nie eine Schätzung.

⚠ **Welche Teile:** ein TAG und ein MONAT aus den Viertelstunden, ein JAHR aus den Monaten. Der
Monat liest bewusst NICHT die Tageszeilen: ein Tag, der vor IP-5 schon endgültig war, trägt keine
Menge und wird nie angefasst. Gelesen wird zusätzlich die letzte Viertelstunde mit gutem Wert
vor `von` (≤ 1 Tag) und die an `bis` — daraus kommen die Stände an den Grenzen.

## Der freie Zeitraum (P7)

`ZeitraumMenge.zeitraum(tenant, entity, kanal, von, bis, jetzt)` — nur im Viertelstunden-Raster
(sonst `IllegalArgumentException`), über die App-Verbindung hinter RLS. Er hat **eigene**
Periodenstände und wird aus den Viertelstunden gebildet, nie aus Tagen/Monaten
zusammengeklebt: F20 20.–21.10. ist VOLLSTÄNDIG 4 608 kWh, obwohl beide Tage unvollständig sind
(Summe der Tage 4 416). Noch ohne Route (Lese-Modell = IP-9).

## Zeitzone, 23-/25-Stunden-Tage

Tag, Monat, Jahr sind Kalenderperioden in der **Zeitzone des Standorts**; Zone + Herkunft
stehen in jeder Zeile (Tag wie IP-13, Monat übernimmt sie von seiner jüngsten Tageszeile, Jahr von
seinem jüngsten Monat). Die Stundenzahl eines Tages kommt weiter aus `TagRegeln.stunden` →
`BezugsPeriode` → `VerbrauchRegeln.stunden`; Monat/Jahr tragen `stunden` aus `beginn`/`ende`
(Oktober 2026 = 745). Keine vierte Zählung.

## Die Fortpflanzung (§4.5)

- **vorläufig/endgültig:** ein Monat ist vorläufig, solange ein Tag oder eine Viertelstunde
  vorläufig ist oder seine Frist (Ende + 7 Tage) läuft; ein Jahr ebenso über seine Monate
  (`TagRegeln.zustand`). `teile_vorhanden`/`teile_endgueltig` sagen, wie viele.
- **Abdeckung** = Summe erhalten ÷ Summe erwartet — eine Viertelstunde OHNE Zeile zählt mit
  `Länge ÷ Kadenz`. ⚠ Das gilt seit IP-5 auch für `messreihe_tag.erwartet`/`abdeckung_prozent`
  (F8: 85 %, vorher 98 %).
- **Kennzeichen und Vollständigkeit** kommen aus der Regel; Randkennzeichen an inneren Grenzen
  entfallen, Lücke/Rücksetzung/Gerätegrenze bleiben in Reihenfolge.

## Tabellen und Läufe

- `messreihe_tag` + `menge`, `menge_zustand`, `kennzeichen`, `kadenz_s`; ⚠ `stand_anfang`/
  `stand_ende` sind jetzt die Stände an den TAGESGRENZEN (vorher: erster Stand irgendeiner
  Viertelstunde). Endgültige Tage von vor IP-5 behalten beides wie gebildet (nie angefasst).
- `messreihe_periode` (art `monat`|`jahr`, `tag` = erster Kalendertag): Hypertable, Chunk 10 Jahre,
  Aufbewahrung 3 653 Tage, RLS + FORCE, App nur SELECT.
- `messreihe_periode_arbeit`: durable, Entnahme `FOR UPDATE SKIP LOCKED`, entnehmen und schreiben
  in EINER Transaktion; Quellen: Tag geschrieben → Monat, Monat geschrieben → Jahr, Frist,
  `nachholen()` (Monate mit Tageszeilen ohne Monatszeile). Upsert lässt endgültige und
  unveränderte Zeilen in Ruhe.

## Grenzen

Keine Korrektur/Kaskade/Version > 1 (IP-12 ff.), keine Ersatzwerte (IP-9/E7), keine Menge für
Momentanwert-/Intervall-Reihen über Perioden (IP-3; `menge_zustand` bleibt NULL), keine Route,
keine Portal-Fläche. Der Lesepfad (PR 703) zeigt die Tagesmenge noch nicht:
`SpeicherklasseHistorie.tage` setzt `menge_summe` und `chart_value` für Zähler fest auf NULL.
