# UEMS-Verbrauchsvertrag: eine Wahrheit, zwei Prüfungen (Python ⟷ Java)

Neu angelegt am 12.09.2026 (AP-08 IP-1, das erste Bau-Paket der Verbrauchsbildung — die Datei,
gegen die IP-2 … IP-20 gebaut werden).

- **[`docs/contracts/v2/verbrauch.md`](../../contracts/v2/verbrauch.md)** — der Vertrag in
  Prosa: Eingang, drei Wertarten, die vier Fallen, das Ergebnis. Ausdrücklich KEINE zweite
  Regelbeschreibung: wo Text und Vektor-Datei sich widersprechen, gilt die Datei.
- **[`verbrauch-vectors.json`](../../contracts/v2/verbrauch-vectors.json)** +
  **[`verbrauch.schema.json`](../../contracts/v2/verbrauch.schema.json)** — 23 handgerechnete
  Fälle (F1–F23) im Referenzunternehmen Ahrenberg, dazu Schwellen, Zustands- und
  Kennzeichen-Vokabular. Erzeugt aus `data/vp-uems-ap08-verbrauch/referenzfaelle.json`, nicht
  abgeschrieben; `_abweichungen` nennt jede bewusste Abweichung mit Grund (heute genau eine).
- **Python:** `services/optimization/voltpilot_optimization/verbrauch.py` (rein: keine Uhr,
  keine DB, kein Netz) + `tests/test_verbrauch.py`.
- **Java:** `services/api/.../uems/VerbrauchRegeln` (rein: ohne Spring, ohne DB, ohne Uhr) +
  `VerbrauchVectorsTest` (`@TestFactory`, exakt, Schema über den geteilten
  `uems/UemsSchemaLaeufer`).

## Der Gleichlauf ist der Zweck

Verbrauch wird an ZWEI Stellen gerechnet: im Optimierer (Python) und in der
Cloud-Schnittstelle (Java). Zwei Umsetzungen einer Rechenregel driften auseinander, sobald
sie nicht beide gegen DIESELBE Datei geprüft werden. Beide Tests lesen
`docs/contracts/v2/verbrauch-vectors.json` **per Pfad** — wer sie verschiebt, bricht beide
absichtlich. Dasselbe Muster wie beim sturen Speicher
(`docs/contracts/stur-speicher-vectors.json` mit `voltpilot_optimization/stur.py` ⟷
`repo/StandardSpeicher.java`).

**Beide Zwillinge sind grün** — kein ausgeschalteter und kein roter Test. Der Bauplan sah für
IP-1 einen zunächst roten Java-Test vor; stattdessen liegt die reine Java-Funktion gleich mit,
weil ein dauerhaft roter Test auf `main` echte Fehlschläge verdeckt.

## ⚠ Noch ruft niemand an

Dieses Paket ändert KEIN Verhalten: keine Migration, keine Tabelle, keine Route, keine
Portal-Fläche, kein Eingriff in die Messwert-Strecke oder in bestehende Verdichtungen. Der
Verdichtungs-Job bekommt die Regel mit IP-2 (Zählerstand), IP-3 (Intervallmenge/Momentanwert),
IP-4 (Ereignisse) und IP-5 (Perioden).

## Die vier Fallen, die die Fälle bewachen

- **Eine Lücke ist nie eine Null.** Wo keine Menge bildbar ist, steht `null` — nie `0`, nie
  „unverändert". Ein Zählerrücksprung erzeugt nie einen fiktiven Verbrauch (Plan-Abnahme 1,
  F6); ein Box-Ausfall erscheint nie als gemessener Stillstand (Plan-Abnahme 2, F8).
- **Abdeckung ist NICHT Vollständigkeit.** `abdeckung_prozent` sagt, wie viele Werte ankamen;
  `zustand` sagt, ob jede Kilowattstunde gezählt ist. Ein Tag darf **vollständig** sein und
  85 % Abdeckung haben (F8) — die Zählerstände an beiden Tagesgrenzen genügen. Nie auf 100 %
  runden.
- **Eine Lücke beginnt ÜBER 2 × Kadenz, nicht ab.** Strikt größer, dieselbe Schwelle wie
  `ZustandAbleitung.LUECKE_FAKTOR`; ein Test nagelt die beiden Zahlen aneinander. F15 zeigt
  beide Seiten der Schwelle in einem Fall — und ist genau die Stelle, an der die Vorlage
  (mit `≥`) sich selbst widersprach.
- **Ein Tag hat nicht 24 Stunden.** Tag/Monat/Jahr sind Kalenderperioden in der Zeitzone des
  Standorts, Viertelstunde und Stunde laufen im UTC-Raster durch; am Umstellungstag 23 oder
  25 Stunden (F13, F14).

## Beim Ändern

`kennzeichen` ist Vertrag — Text UND Reihenfolge (erst die nicht gemessenen Ränder, dann je
Nachbarschaft Gerätegrenze/Überlauf/Rücksetzung/Lücke, zuletzt die Neustarts). Beide Zwillinge
vergleichen exakt, ohne Toleranz. Gerechnet wird ungerundet, verglichen auf drei
Nachkommastellen; die Java-Seite rechnet mit demselben Dezimal-Kontext wie Python
(28 Stellen, half-even), sonst weichen Mittelwert und integrierte Energie an der
Rundungsgrenze ab.

Prüfnachweis (gezielt, ohne Docker):
`(cd services/optimization && ./.venv/bin/python -m pytest tests/test_verbrauch.py -q)` und
`(cd services/api && ./mvnw test -Dtest=VerbrauchVectorsTest)` — JDK 21 nötig.
