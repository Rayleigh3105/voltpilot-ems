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
| [`verbrauch-vectors.json`](./verbrauch-vectors.json) | **die eine Wahrheit**: 23 handgerechnete Referenzfälle der Vorlage (F1–F23) plus F24 (AP-08 IP-3) mit Eingang und erwartetem Ergebnis |
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
> Tageslauf, der Monats-/Jahreslauf und der freie Zeitraum (§7), seit IP-3 dieselben Läufe für
> Momentanwert und Intervallmenge (§8). Die Kern-Telemetrie, ihre Rollups, das Cockpit und die
> Erlöse sind unberührt.

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

Die vier Brüche und ihre Kennzeichen (AP-08 IP-4 verdrahtet sie in der Strecke):

| Bruch | Woran erkannt | Mit der Angabe | Ohne die Angabe |
|---|---|---|---|
| Gerätegrenze (Z4) | `device_boundary` in `(vorher, nachher]` | Ablesestände: `(Endstand − vorher) + (nachher − Anfangsstand)`, „Gerätegrenze HH:MM mit Ableseständen“ | Beitrag 0, unvollständig: „Gerätegrenze HH:MM ohne Ablesestände“ + „Zuwachs am Wechsel nicht messbar (Ablesestände fehlen)“ |
| Rücksetzung (Z5) | Stand fällt, kein Überlauf | nachgetragener Endstand macht sie zur Gerätegrenze (E3, F12) | Beitrag 0, unvollständig: „Rücksetzung HH:MM ohne Endstand — bis zu 1 Kadenz nicht gezählt“ |
| Überlauf (Z6) | Stand fällt UND `ueberlauf(...)` antwortet | Wertebereich + Höchstzuwachs: `Modul − vorher + nachher`, lückenlos, „Überlauf HH:MM (Wertebereich M)“ | keine Deklaration → kein Überlauf, sondern die Rücksetzung (E4) |
| Neustart (Z7) | `device_restart` in `(von, bis]` | „Neustart HH:MM: bis zu n s Zählung möglicherweise verloren“ mit dem deklarierten `n` | dasselbe mit `n = 255` (AP-05); die Zahl wird nie hochgerechnet |

**Die EINE Überlauf-Entscheidung** ist `VerbrauchRegeln.ueberlauf` ⟷ `verbrauch.ueberlauf`: nur ein
FALLENDER Stand, nur mit Wertebereich UND Höchstzuwachs, nur wenn
`Modul − vorher + nachher ≤ Höchstzuwachs × (Zeitabstand ÷ Kadenz)`. Die Mengenregel, die Prüfung
der Meldung `counter_overflow` und die Erkennung im Writer (`UeberlaufRegel`) fragen dieselbe
Entscheidung; alle drei prüfen sie gegen diese Datei (jeder fallende Nachbar steht genau dort, wo
eine Erwartung „Überlauf HH:MM“ nennt).

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
Kundensätze daraus baut AP-08 IP-8, nicht dieser Vertrag. Den Wortlaut jedes Satzes hält
[`ergebnis-zustand-vectors.json`](./ergebnis-zustand-vectors.json); dort stehen auch die
gespeicherten Wortlaute früherer Fassungen („mit Ablesestände“ bis 1.0). Eine Uhrzeit `HH:MM`
trägt an der doppelten Stunde des Sommerzeit-Endes den Zusatz MESZ/MEZ („Rücksetzung 02:30 MEZ …“).

Gerechnet wird **ungerundet**; verglichen wird auf drei Nachkommastellen
(`regeln.vergleich_nachkommastellen`). Gerundet wird erst bei Anzeige und Export (E11).

## 5. Abweichungen von der Vorlage

Die Vektor-Datei ist aus `data/vp-uems-ap08-verbrauch/referenzfaelle.json` **erzeugt**, nicht
abgeschrieben. Jede Stelle, an der sie bewusst davon abweicht, steht als Eintrag in
`_abweichungen` — mit Fall, Feld, Vorlagenwert, neuem Wert und Grund. Ist die Liste leer,
wurde nichts geändert. Heute trägt sie genau einen Eintrag (F15, Lückenschwelle; Menge,
Zustand und Abdeckung der Vorlage bleiben unberührt).

## 6. Was dieser Vertrag NICHT regelt

Korrekturen und ihre Kaskade über Tag, Monat und Jahr (§4.6, IP-14 ff.; die Ersatzwert-Methoden
selbst regelt seit IP-13 Abschnitt 11), die
Fortpflanzung über berechnete Messstellen (§4.5, AP-10), der gröbere Eingang und das Intervall
über die Grenze (I3/I4), die Kundensätze (IP-8), die
Zustandsart `state` (S1/S2)
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

## 8. Momentanwert und Intervallmenge aus Teilperioden (AP-08 IP-3, §4.5)

Eine gröbere Periode einer Momentanwert- oder Intervallmengen-Reihe wird ebenfalls aus ihren
gespeicherten Teilperioden gebildet (`regeln.werte_teilperioden`; Java
`VerbrauchRegeln.momentanwertAusTeilperioden` / `intervallmengeAusTeilperioden`, Python
`verbrauch.momentanwert_aus_teilperioden` / `intervallmenge_aus_teilperioden`). Ein Teil trägt
dafür neben seinem Ergebnis die **ungerundete Summe** der guten Werte, die **ungerundete
Energie**, die **gemessene Zeit** und ob **in ihm** eine Lücke liegt.

- **Mittel** = Summe der Teilsummen ÷ Summe erhalten — nie ein Mittel von Mitteln (zwei
  Viertelstunden mit 10,05 und 10,04 sind gerundet 10,1 und 10,0; ihr Mittel 10,05 ergäbe 10,1,
  die halbe Stunde hat 10,045 = 10,0). Min/Max über die Teile.
- **Vollständig** nur ohne Lücke zwischen zwei guten Werten — in einem Teil, zwischen zwei
  Teilen, zum letzten Wert davor und zum ersten danach — und mit beiden Rändern innerhalb einer
  Kadenz (M3). Ein unvollständiger RAND eines Teils ist an einer inneren Grenze kein Rand mehr
  (F24: Viertelstunde 10:30 unvollständig, halbe Stunde 10:30–11:00 vollständig).
- **Energie aus Leistung** (E5, M4) nur gekennzeichnet („aus Leistung integriert …“) und nur, wenn
  JEDER Teil mit gutem Wert seine Energie trägt: Summe der ungerundeten Teil-Energien plus je
  Strecke ohne Teil mit Werten das, was der Wert davor dorthin hält. Ohne einen guten Wert gibt es
  keine Zahl — nie 0, nie Mittel × Länge.
- **Halten über die Grenze:** ein Wert hält bis zum nächsten guten Wert, höchstens zwei Kadenzen,
  **auch wenn dieser hinter der Periodengrenze liegt** (F24 Viertelstunde 10:15: 18,667 statt
  18,444 kWh). Nur so ergeben die Viertelstunden-Energien genau die der Stunde (107,308 kWh).
- **Rundung:** die ungerundete Energie ist eine Summe 28-stelliger Divisionen; vor der Rundung auf
  drei Stellen wird Rechenrauschen unter 10⁻¹⁵ entfernt (`ENERGIE_RAUSCHEN_STELLEN`), damit eine
  Summe genau auf der Grenze (F3: 24,1125) nicht als 24,11249…9 kippt.
- **Intervallmenge** = Summe der ungerundeten Teilsummen, einmal gerundet; jede fehlende
  Intervallmenge — auch die eines Teils ohne Zeile — macht die Periode unvollständig (F2, halbe
  Stunde).

Beide Zwillinge prüfen an jeder Momentanwert- und Intervallmengen-Erwartung ab zwei
Viertelstunden, dass die Zusammensetzung die Erwartung der Datei ergibt
(`VerbrauchWerteteileTest`, `test_verbrauch.py`).

## 9. Zuwachs über eine Lücke: gemessen, benannt, nicht verteilt (AP-08 IP-6, E2)

Der Zähler hat weitergezählt, während die Werte fehlten. Die Differenz der Stände um die Lücke ist
darum eine **gemessene** Energiemenge — nur **wann** in der Lücke sie anfiel, weiß niemand. Beides
gilt gleichzeitig, und daraus folgen drei Regeln (`regeln.luecke_zuwachs`):

1. **Die Viertelstunden der Lücke bekommen nichts.** Sie haben keinen Wert und bleiben „keine
   Werte“ — nie 0 kWh, nie ein Anteil (F8 Viertelstunde 14:15–14:30).
2. **Der Zuwachs zählt genau einmal je Stufe** — in der Periode, die die Lücke GANZ enthält:
   Messzeit davor > `von − Kadenz` (der Wert ist ihr Stand am Anfang oder liegt in ihr) und Messzeit
   danach ≤ `bis`. Eine Periode, die die Lücke nur anschneidet, bekommt ihn nicht; ihr fehlt der
   Stand an der Grenze („Anfang/Ende nicht gemessen“). F20: beide Tage je 2 208 kWh unvollständig,
   der Zwei-Tage-Zeitraum 4 608 kWh vollständig.
3. **Er trägt sein Kennzeichen:** „Lücke 23:00–01:00: Zuwachs 192,0 kWh gemessen, nicht auf
   Viertelstunden verteilbar“ — sonst läse ihn jemand als normalen Verbrauch. Einheit und Zone des
   Satzes kommen aus dem Träger `ReihenKontext` (Einheit der Reihe, Zeitzone des Standorts); die Zahl
   spricht `ErgebnisZustand.menge` (ergebnis-zustand 1.3, bis dahin „Zuwachs 192.000“).

Die Entscheidung steht an EINER Stelle: `VerbrauchRegeln.zaehltZu` ⟷ `verbrauch.zaehlt_zu`;
`lueckenZuwachs` ⟷ `luecken_zuwachs` erkennt die Lücke (kein Loch über `luecke_faktor × Kadenz`,
fallender Stand oder Gerätegrenze dazwischen → kein Zuwachs), `lueckenZuwaechse` ⟷
`luecken_zuwaechse` liefert die Lücken, die eine Periode zählt. `mengeZaehlerstand` und die
Zusammensetzung aus Teilperioden kommen über ihre Periodenstände zum selben Ergebnis; beide
Zwillinge halten das an jeder Erwartung mit `luecken_zuwachs` fest (F8, F11, F20, F23: gezählte
Lücke mit Ständen, Zuwachs, Einheit UND Kennzeichen; jede andere Lücke der Reihe steht nicht da).

`kleinsterZeitraum` ⟷ `kleinster_zeitraum` nennt den **kleinsten** ganz enthaltenden Zeitraum der
Kette `regeln.luecke_zeitraeume` (Viertelstunde → Stunde → Tag → Monat → Jahr; Viertelstunde und
Stunde im UTC-Raster, Tag/Monat/Jahr in der Zeitzone des Standorts). `luecken_zuordnung` hält ihn
fest: F8 Tag, F23 Stunde, F20 und F11 Monat, über die Monatsgrenze das Jahr, am 23-/25-Stunden-Tag
der Tag, vier Minuten bei 60 s Kadenz die Viertelstunde selbst, über den Jahreswechsel **keiner** —
dann zählt der Zuwachs nur in einem freien Zeitraum, der die Lücke umfasst.

**Kein Ersatzwert.** Eine Verteilung auf Viertelstunden gibt es nur als manuellen, gekennzeichneten
Ersatzwert (E7 a–c, IP-13) — nie hier, nie automatisch. Die Lücke trägt denselben Zuwachs als
Nutzlast von `data_gap` (`events-vocabulary.md`, „Zuwachs über eine Lücke“).

## 10. Der Anteil eines Vorzeichen-Werts: je Rohwert, nie je Mittelwert (AP-08 IP-7, M5/E15)

Ein Kanal mit Vorzeichen (Katalog `import_export`, etwa K-3 · Wirkleistung) speist die
Bezug-Messstelle mit seinem **positiven** und die Abgabe-Messstelle mit seinem **negativen**
Anteil — die Quellenbindung nennt ihn (`anteil`, `messstelle.md` §5). Die Regel steht in
`regeln.anteil`: geteilt wird **JE ROHWERT, vor jeder Verdichtung** — positiv = `max(0, P)`,
negativ = `max(0, −P)`; erst daraus entstehen Mittel, Min, Max (die Nullen des anderen Anteils
zählen mit) und die Energie je Anteil (wie jede Energie aus Leistung nur mit „aus Leistung
integriert“ und nie über eine Lücke). Das Kennzeichen „positiver Anteil von K-3 · Wirkleistung“
steht **zuerst** — es wird zuerst festgestellt.

Eine Erwartung mit `anteil` (und `quelle`, wie das Kennzeichen sie nennt) liest nur diesen Anteil
ihrer Reihe. F19 trägt dafür die Reihe `wirkleistung` (12:00–12:04 +38,4 kW, 12:05–12:15
−34,2 kW): **MS-01 Mittel 12,8 kW · 3,2 kWh, MS-02 Mittel 22,8 kW · 5,7 kWh** — vereinbar mit den
Zählerständen desselben Falls. `gegenprobe` hält die verworfene Rechnung fest (E15 Option C,
erst mitteln, dann nach Vorzeichen zuordnen): (5 × 38,4 − 10 × 34,2) ÷ 15 = −10,0 → nur
„Abgabe 10,0“; beide Zwillinge prüfen, dass sie herauskommt UND von den Anteilen abweicht.

Zwei Grenzen: das **Box-Vorzeichen** ist schon im Rohwert (AP-04 E5) — es wird hier nie ein
zweites Mal angewendet; und ein **Saldo** entsteht hier nie (E12) — Bezug und Abgabe bleiben
zwei Mengen, „saldiert“ gibt es nur als berechnete Messstelle (AP-10). Die Stelle:
`VerbrauchRegeln.anteilJeRohwert`/`momentanwerteAnteil` ⟷ `verbrauch.anteil_je_rohwert`/
`momentanwerte_anteil`; einen Anteil hat nur ein Momentanwert (ein Zählerstand mit Anteil ist ein
Fehler des Aufrufers).

## 11. Ersatzwert-Methoden: die geschätzte Verteilung ändert den gemessenen Betrag nie (AP-08 IP-13, E7)

Ein Ersatzwert ist eine Zahl, die ein Mensch mit Begründung setzt (`messreihe_ersatzwert`,
`events-vocabulary.md` §4). Die sieben Methoden a–g (E7) rechnen `VerbrauchRegeln` ⟷
`verbrauch.py` gegen den Block **`ersatzwerte`** der Vektor-Datei: Versionen der Reihen von F11
(Version 2), F21 (Widerruf, Version 3) sowie konstruierte Fälle je Methode und je Ablehnung.

- **a–c verteilen den GEMESSENEN Zuwachs** einer Zählerstand-Lücke über ihre Viertelstunden
  `[Boden(erste fehlende Messzeit), Decke(Messzeit danach))` — Gewicht 1 (a) oder die vollständige
  Menge der Profil-Viertelstunde der Vorperiode (b) bzw. der Vergleichsquelle (c).
  `regeln.ersatzwert_verteilung`: jeder Anteil wird ungerundet gerechnet und auf
  `ersatzwert_stellen` = 9 Nachkommastellen **abgeschnitten**, die **letzte** Viertelstunde der
  Lücke bekommt den Rest — dort, wo der Stand nach der Lücke den Zuwachs abschließt. Die Summe der
  gespeicherten Anteile ist darum **exakt** der Zuwachs (Methode b konstruiert: 26,742857186 statt
  26,742857142 in der letzten Viertelstunde).
- **d** macht den Zeitpunkt zur Gerätegrenze mit Ableseständen; Z4 rechnet (F6 mit den Ständen von
  F12: 14,81 kWh). **e** setzt den Betrag EINER Viertelstunde, **f/g** übernehmen die Werte ihres
  Bezugs (gleiche Einheit) — ihr Wert ist die Menge der Viertelstunde.
- **Benannte Ablehnungen** (`regeln.ersatzwert_ablehnungen`, geschlossen): eine Methode, die nicht
  rechnen kann, lehnt mit ihrem Grund ab und weicht nie still auf eine andere aus — fehlt eine
  Viertelstunde der Vorperiode, ist das `vorperiode_fehlt`, nie „dann eben gleichmäßig“.
- **Versionsregel** (`regeln.ersatzwert_version`): eine Periode mit Ersatzwerten ist eine neue
  Version über dem Bestand (Version 1), nie auf einer früheren gerechnet. Nur wirksame gelten; in
  der Folge ihrer Kennung hält der frühere seine Viertelstunden (`ueberschneidet_ersatzwert`).
  Enthält die Periode die Lücke ganz, bleibt ihre Menge (E2) und der Satz „nicht auf
  Viertelstunden verteilbar“ weicht dem Ersatzwert; schneidet sie sie an, kommen die Anteile ihrer
  Viertelstunden dazu (F11: 1 344,0 + 960,0 = 2 304,0), ein Rand in der Lücke ist gedeckt.
  Zustand „mit Ersatzwert“, Kennzeichen zuletzt „mit Ersatzwert (Methode „…“, EW-…)“
  (`ergebnis-zustand` Rang 70); die Abdeckung bleibt die der Rohwerte.
- Ein zurückgenommener Ersatzwert hinterlässt **keine Spur in den Zahlen**: die Version gleicht
  Version 1 Zeichen für Zeichen (F21), und die bessere Methode rechnet vom Bestand aus.

Gebildet werden die Versionen der Viertelstunde (`messreihe_viertelstunde_version`, Lauf
`ErsatzwertLauf`); Tag, Monat und Jahr mit Ersatzwert bildet die Kaskade (IP-17, `uems/KorrekturKaskade`) über dieselbe
Regel `mitErsatzwerten` ⟷ `mit_ersatzwerten` — für a–c; d–g haben über gröberen Perioden keine Regel und werden dort
benannt abgelehnt.
