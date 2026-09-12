# Verbrauchsvertrag: aus Rohwerten wird die Menge einer Periode (UEMS AP-08)

Stand 12.09.2026 · Vertrag 1.0 · Konzept `data/vp-uems-ap08-verbrauch` §4 (Rechenregeln
Z1–Z9, I1–I5, M1–M6, P1–P7), Entscheide E1–E15 vom 11.09.2026 · Beispielwelt
[`uems-referenzunternehmen.json`](./uems-referenzunternehmen.json) (Kunststoffwerk Ahrenberg
GmbH).

Dieser Vertrag sagt, wie aus den Rohwerten **einer** Messreihe der Verbrauch **einer**
Periode wird — und, mindestens genauso wichtig, wann er **keine Zahl** wird.

**Die Regel steht nicht in diesem Text, sie steht in der Vektor-Datei.** Dieses Dokument
erklärt, was dort steht, und benennt die Fallen; es ist bewusst **keine zweite
Regelbeschreibung**, die von der Datei wegdriften könnte. Wo Text und Datei sich
widersprechen, gilt die Datei.

| Datei | Rolle |
|---|---|
| [`verbrauch-vectors.json`](./verbrauch-vectors.json) | **die eine Wahrheit**: 23 handgerechnete Referenzfälle (F1–F23) mit Eingang und erwartetem Ergebnis |
| [`verbrauch.schema.json`](./verbrauch.schema.json) | das Schema für Eingang, Ergebnis und die Vektor-Datei selbst (JSON-Schema 2020-12) |
| `services/optimization/voltpilot_optimization/verbrauch.py` | der **Python-Zwilling** (rein: keine Uhr, keine DB, kein Netz) |
| `services/api/.../uems/VerbrauchRegeln.java` | der **Java-Zwilling** (rein: ohne Spring, ohne DB, ohne Uhr) |
| `…/tests/test_verbrauch.py` · `…/uems/VerbrauchVectorsTest.java` | beide fahren DIESELBE Vektor-Datei, per Pfad |

**Wer eine Regel ändert, ändert beide Zwillinge UND die Vektor-Datei.**

Warum es zwei Umsetzungen gibt: der Optimierer rechnet Verbrauch in Python, die
Cloud-Schnittstelle in Java. Zwei Umsetzungen einer Rechenregel driften auseinander, sobald
sie nicht beide gegen dieselbe Datei geprüft werden — dasselbe Muster wie beim sturen
Speicher (`stur-speicher-vectors.json` mit `voltpilot_optimization/stur.py` ⟷
`repo/StandardSpeicher.java`).

> **Wer anruft:** seit AP-08 IP-2 der Verdichtungs-Lauf je Viertelstunde, seit IP-5 der
> Tageslauf, der Monats-/Jahreslauf und der freie Zeitraum (§7). Die Kern-Telemetrie, ihre
> Rollups, das Cockpit und die Erlöse sind unberührt.

## 1. Der Eingang: eine Reihe, eine Periode

Ein Fall der Vektor-Datei gibt **eine** Reihe (`input.reihe`) oder mehrere benannte
(`input.reihen`, etwa führende Quelle neben Vergleichsquelle) und erwartet je Periode ein
Ergebnis.

Eine Reihe trägt ihre **Wertart** (AP-07 E12), ihre **Einheit**, ihre **Kadenz** und ihre
Rohwerte. Die Kadenz ist die Erwartung an den Abstand der Werte — sie bestimmt das Fenster
des Periodenstands, die Lückenschwelle und die erwartete Anzahl, **nie** das Raster der
Periode (P4). Optional kommen `faktor` (Z8: Rohwert × Faktor ergibt die Einheit — er stammt
aus der Einstellungs-Fassung zur Messzeit, AP-04 E5, nie aus der Rechnung), `ereignisse`
(AP-07 IP-3), `wertebereich_modul` und `hoechstzuwachs_je_kadenz` (Z6) sowie `integrieren`
(M4) hinzu.

Rohwerte stehen als **Abschnitte** (`von`/`bis`/`kadenz_s`/`stand_von`/`zuwachs_je_kadenz`,
beide Grenzen inklusive) oder einzeln (`t`/`v`/`q`). `luecken` entfernt anschließend die
Werte in `[von, bis)` — so beschreibt ein Fall einen Box-Ausfall, ohne die Abschnitte zu
zerschneiden. **Eine entfernte Strecke ist nicht dasselbe wie ein gemessener Stillstand**;
genau das prüfen F8 und F20.

## 2. Drei Wertarten, drei Regeln

**Zählerstand** (Z1–Z9) — Menge = Stand am Periodenende − Stand am Periodenanfang, gebildet
über die gemessenen Strecken dazwischen. `Stand(t)` ist der letzte gute Wert in
`(t − Kadenz, t]`; fehlt er, wurde an dieser Periodengrenze **nicht gemessen** und der Stand
wird **nicht** aus einem älteren Wert fortgeschrieben. Gerätegrenze (Z4), Rücksetzung (Z5),
Überlauf (Z6) und Neustart (Z7) unterbrechen die Differenzbildung, statt einen fiktiven
Verbrauch zu erzeugen.

**Intervallmenge** (I1–I5) — Summe der guten Intervallmengen, deren **Ende** in
`(von, bis]` liegt. Hier ist jede fehlende Intervallmenge verlorene **Menge**, nicht nur
verlorene Zeit: schon ein fehlender Wert macht die Periode unvollständig, ohne
Loch-Kriterium.

**Momentanwert** (M1–M6) — Mittel, Minimum und Maximum über die guten Werte in
`[von, bis)`. Vollständig ist die Periode nur, wenn sie kein Loch über zwei Kadenzen hat
**und** beide Ränder innerhalb einer Kadenz gemessen sind. Energie aus Leistung entsteht nur
mit Rechteck-Halten über höchstens zwei Kadenzen und **nur über gemessene Zeit** — nie
Mittel × Periodenlänge, das würde die Lücke stillschweigend auffüllen.

## 3. Die vier Fallen

**Eine Lücke ist nie eine Null.** Wo keine Menge bildbar ist, steht `null` — nicht `0` und
nicht „unverändert". Ein Zählerrücksprung erzeugt nie einen fiktiven Verbrauch
(Plan-Abnahme 1, F6); ein Box-Ausfall erscheint nie als gemessener Stillstand
(Plan-Abnahme 2, F8).

**Abdeckung ist nicht Vollständigkeit.** `abdeckung_prozent` sagt, wie viele Werte ankamen;
`zustand` sagt, ob jede Kilowattstunde gezählt und zugeordnet ist. Ein Tag darf **vollständig**
sein und trotzdem 85 % Abdeckung haben (F8) — die Zählerstände an beiden Tagesgrenzen
genügen. Die Abdeckung wird nie auf 100 % gerundet.

**Eine Lücke beginnt ÜBER zwei Kadenzen, nicht ab.** Die Schwelle ist strikt größer und
dieselbe wie im schon gemergten Zustandsvertrag (`ZustandAbleitung.LUECKE_FAKTOR`,
[`uems-zustand-vectors.json`](./uems-zustand-vectors.json)). Zwei Zahlen für dieselbe Aussage
wären genau die Drift, die diese Datei verhindern soll. F15 zeigt beide Seiten der Schwelle
in einem Fall.

**Ein Tag hat nicht 24 Stunden.** Tag, Monat und Jahr sind Kalenderperioden in der Zeitzone
des Standorts; Viertelstunde und Stunde laufen im UTC-Raster durch. Am Umstellungstag hat der
Tag 23 oder 25 Stunden (F13, F14) — deshalb trägt jede Erwartung dieser beiden Fälle ihre
`stunden`.

## 4. Das Ergebnis

Je Periode: `menge` (oder `mittel`/`min`/`max`/`energie_kwh`), `zustand`, `erhalten`,
`erwartet`, `abdeckung_prozent` und `kennzeichen`. Das Zustandsvokabular ist geschlossen:
**vollständig · unvollständig · keine Werte · mit Ersatzwert** (§4.5). „mit Ersatzwert"
entsteht erst mit AP-08 IP-13; bis dahin kommt es in keinem Fall vor.

`kennzeichen` ist die Liste dessen, was an dieser Periode zu sagen ist — **in der Reihenfolge,
in der die Regel es feststellt**: erst die nicht gemessenen Ränder, dann je Nachbarschaft der
Wertfolge Gerätegrenze, Überlauf, Rücksetzung oder Lücke, zuletzt die Neustarts. Text und
Reihenfolge sind Teil des Vertrags; beide Zwillinge werden exakt darauf geprüft. Die
Kundensätze daraus baut AP-08 IP-8, nicht dieser Vertrag.

Gerechnet wird **ungerundet**; verglichen wird auf drei Nachkommastellen
(`regeln.vergleich_nachkommastellen`). Gerundet wird erst bei Anzeige und Export (E11).

## 5. Abweichungen von der Vorlage

Die Vektor-Datei ist aus `data/vp-uems-ap08-verbrauch/referenzfaelle.json` **erzeugt**, nicht
abgeschrieben. Jede Stelle, an der sie bewusst davon abweicht, steht als Eintrag in
`_abweichungen` — mit Fall, Feld, Vorlagenwert, neuem Wert und Grund. Ist die Liste leer,
wurde nichts geändert. Heute trägt sie genau einen Eintrag (F15, Lückenschwelle; Menge,
Zustand und Abdeckung der Vorlage bleiben unberührt).

## 6. Was dieser Vertrag NICHT regelt

Ersatzwerte und ihre Methoden, Korrekturen und Versionierung (§4.6, ab IP-12), die
Fortpflanzung über berechnete Messstellen (§4.5, AP-10), die Fortpflanzung von Intervallmenge
und Momentanwert über Perioden (IP-3), die Kundensätze (IP-8), die Zustandsart `state` (S1/S2)
und die Bildung der Perioden selbst — eine Erwartung nennt ihre Periode als `von`/`bis`, sie
wird hier nicht erzeugt. All das kommt in eigenen
Paketen und erweitert diese Datei **additiv**: `schema_version` bleibt, ein abwesendes Feld
heißt „der Zustand von vorher", nie ein geratener Wert.

## 7. Zählerstand aus Teilperioden (AP-08 IP-5, P7/§4.5)

Ein Tag, ein Monat, ein Jahr oder ein freier Zeitraum wird **nicht aus Rohwerten neu
gerechnet** (die leben 90 Tage) und **nie als Summe seiner Teilmengen** gebildet, sondern aus
dem, was die gespeicherten Teilperioden tragen: `Stand(von)`, `Stand(bis)`, erster und letzter
guter Wert, Menge, erhalten, erwartet, Kennzeichen (`regeln.teilperioden`; Java
`VerbrauchRegeln.zaehlerstandAusTeilperioden`, Python `verbrauch.zaehlerstand_aus_teilperioden`).

- **Menge** = Stand am Kettenende − Stand am Kettenanfang, dazu je Teilperiode ihr **Bruch**
  (Menge minus eigene gerundete Standdifferenz — genau 0 ohne Gerätegrenze, Überlauf,
  Rücksetzung) und je Grenze **ohne** gemessenen Stand die Nachbarschaft „letzter Wert davor →
  erster Wert danach", eingeordnet wie jede andere (Lücke, Rücksetzung, Gerätegrenze).
- **Periodenstände** der gröberen Periode trägt die Teilperiode, die dort beginnt oder endet;
  liegt keine an, der letzte gute Wert davor im Fenster `(t − Kadenz, t]` — nie ein älterer.
- **Kennzeichen:** Randkennzeichen an inneren Grenzen entfallen, alles andere bleibt in seiner
  Reihenfolge; Neustarts kommen aus den Ereignissen der gröberen Periode.
- **Abdeckung** = Summe erhalten ÷ Summe erwartet; eine Teilperiode ohne Zeile zählt mit
  `Länge ÷ Kadenz`.

Die Summe gerundeter Teilmengen wäre schon ohne jede Lücke falsch: 31 Oktobertage aus F16
summieren sich zu 55 100,013 kWh, der Oktober hat 55 100,000. **Beide Zwillinge prüfen an jeder
Zählerstand-Erwartung ab zwei Viertelstunden**, dass die Zusammensetzung aus Viertelstunden (und
über Tage) die Erwartung der Datei ergibt (`VerbrauchTeilperiodenTest`, `test_verbrauch.py`).
Fehlt an einer Grenze der Stand, ist die Menge der **gemessene Teil** und `unvollständig` (F20)
— ein Stand wird nie erfunden oder fortgeschrieben.
