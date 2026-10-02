# MiSpeL-Abgrenzungsoption: Formelsätze A1, A5, A10, A11

Vertrag zu Anlage 1 („Abgrenzungsoption“) der Festlegung zur Marktintegration von Speichern und
Ladepunkten (MiSpeL, Az. 618-25-02, Beschluss vom 01.10.2026). Bau-Paket MP-4 der Stufe 1.

- **[`mispel-abgrenzung-vectors.json`](./mispel-abgrenzung-vectors.json)** — die Wahrheit: Formelkatalog
  (Nummer, Begriff und Rechenweg **wörtlich** aus Anlage 1, Fundstelle je Formel), die fünf Formelsätze,
  Regeln, Lesarten und 14 Fälle mit Fundstelle. Wo dieser Text und die Datei sich widersprechen, gilt die
  Datei — und dann ist einer von beiden falsch.
- **[`mispel-abgrenzung.schema.json`](./mispel-abgrenzung.schema.json)** — Schema der Datei.
- **Leser im Gleichlauf** (beide per Pfad, beide prüfen L1–L8 unten):
  Java `services/api/src/test/java/com/voltpilot/api/mispel/MispelAbgrenzungVectorsTest.java`,
  Python `services/optimization/tests/test_mispel_abgrenzung_vectors.py`.
- **Rechenwerke im Gleichlauf** (beide rechnen jeden Fall exakt nach, ungerundet):
  Python `services/optimization/voltpilot_optimization/mispel_abgrenzung.py` (MP-9, für Optimierer und
  Simulation; exakte Brüche, Stufen Viertelstunde → ∑M → Monat → ∑J, Monat auch aus laufenden Summen),
  Test `services/optimization/tests/test_mispel_abgrenzung_rechenwerk.py`; Java folgt mit MP-8 (Monatslauf
  mit Nachweis). Eingebaut ist noch keins: Optimierer MP-10/MP-11, Simulation MP-13.

Zitierweise: „A1 S. 35“ = Anlage 1, Seite 35; „T S. 38“ = Tenor mit Begründung, Seite 38. Die Festlegung
hat keine Randnummern.

## Umfang

| Formelsatz | Fallkonstellation (Anlage 1) | Zähler | Eingänge je Viertelstunde | Fundstelle |
|---|---|---|---|---|
| A1 | Basisfall A1: „Stromspeicher“ | Z1, Z2 | Z1NB¼, Z1NE¼, Z2V¼, Z2E¼, AW¼ | S. 29, S. 32–39 |
| A5 | Sonderfall A5: Mehrere gleichartige EE-Anlagen (Abwandlung zu A1) | Z1, Z2 | wie A1, aber AWa¼, AWb¼; Stammdaten Painst, Pbinst | S. 43–51 |
| A5-Variante | vereinfachtes Vorgehen bei jederzeit übereinstimmenden AW>0-Zeiten | Z1, Z2 | wie A5 | S. 52–54 |
| A10 | Sonderfall A10: rein netzgekoppelter Stromspeicher | Z1 | Z1NB¼, Z1NE¼ | S. 94–97 |
| A11 | Sonderfall A11: Stromspeicher und/oder Ladepunkt ohne sonstige Erzeugung | Z1 | Z1NB¼, Z1NE¼ | S. 98–102 |

**Nicht in diesem Vertrag** (Bauplan § 8.5, E5 = B): A2–A4 mit den Formeln (7)A4, (8)A4, (14)A2,A3,A4,
(17)A4, (19)A2,A3 — sie stehen mit Fundstelle unter `nicht_im_umfang` und kommen mit Stufe B (MP-32);
A6–A9 erst, wenn ein Kunde sie braucht; die Pauschaloption (Anlage 2) in MP-24. Ein Wechsel des
Formelsatzes innerhalb eines Monats und das Erkennen von Rumpfmonaten aus den Änderungsprotokollen sind
MP-21; hier stehen Rumpfmonate nur als vorgegebener Zeitraum.

## Eingänge, Einheiten, Vorzeichen

Alle Zählerwerte sind **Strommengen je Viertelstunde in kWh** (keine Leistung) und nie negativ: der
Zweirichtungszähler Z1 trennt Netzbezug Z1NB¼ und Netzeinspeisung Z1NE¼, Z2 trennt Verbrauch Z2V¼ (Laden)
und Erzeugung Z2E¼ (Entladen) im Stromspeicher und/oder Ladepunkt (A1 S. 32). AW¼ ist der anzulegende Wert
in ct/kWh; die Formeln werten nur aus, ob er größer null ist ((24)¼, A1 S. 38, Abschn. 2.1.7). Painst und
Pbinst sind installierte Leistungen in kW nach § 24 Abs. 3 S. 2 EEG (A1 S. 45). Formelwerte sind kWh, nur
die Faktoren und Anteile (14)A1, (18), (30), (30a), (30b), (ZFa), (ZFb) sind ohne Einheit.

## Die Formeln von A1

Nummer, Rechenweg und Begriff wörtlich aus Anlage 1. „(14)“ in (15), „(17)“ in (19) und „(19)“ in (20)
sind die Fallunterscheidungen, die Anlage 1 im Text auflöst (S. 36–37); in diesem Vertrag gelten
(14)A1, (17)A1 und (19)A1,A4.

| Nr. | Rechenweg | Begriff | Seite |
|---|---|---|---|
| (1)¼ | `MIN [ Z1NB¼ ; Z2V¼ ]` | Viertelstundenwert des zeitgleichen Netzstromverbrauchs im Stromspeicher und/oder Ladepunkt | S. 33 |
| (2)¼ | `MIN [ Z1NE¼ ; Z2E¼ ]` | Viertelstundenwert der zeitgleichen Netzeinspeisung aus dem Stromspeicher und/oder Ladepunkt | S. 34 |
| (3) | `∑M Z1NB¼` | Gesamter Netzbezug im Kalendermonat | S. 34 |
| (4) | `∑M Z1NE¼` | Gesamte Netzeinspeisung im Kalendermonat | S. 34 |
| (5) | `∑M Z2V¼` | Verbrauch im Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 34 |
| (6) | `∑M Z2E¼` | Erzeugung im Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 34 |
| (9) | `∑M (1)¼` | Zeitgleicher Netzstromverbrauch im Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 34 |
| (10) | `(5) – (9)` | Zeitgleicher Verbrauch von Strom aus der EE-Anlage im Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 34 |
| (11) | `∑M (2)¼` | Basiswert der zeitgleichen Netzeinspeisung aus dem Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 35 |
| (12) | `MAX [ (6) – (5) ; 0 ]` | Fremdtankstrom im Kalendermonat | S. 35 |
| (13) | `MAX [ (11) – (12) ; 0 ]` | Berücksichtigungsfähige zeitgleiche Netzeinspeisung aus dem Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 35 |
| (14)A1 | `(6) / (5)` | Wirkungsgrad der Stromspeicherung in der Fallkonstellation A1 | S. 35 |
| (15) | `(14) • (10)` | EE-Speichererzeugung im Kalendermonat | S. 36 |
| (16) | `MAX [ (13) – (15) ; 0 ]` | Saldierungsfähige Netzeinspeisung im Kalendermonat | S. 36 |
| (17)A1 | `MAX [ (5) – (6) ; 0 ]` | Verluste im Stromspeicher in der Fallkonstellation A1 im Kalendermonat | S. 36 |
| (18) | `(16) / (6)` | Anteil der saldierungsfähigen Netzeinspeisung an der Erzeugung im Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 36 |
| (19)A1,A4 | `(18) • (17)` | Privilegierungsfähige Stromspeicherverluste in den Fallkonstellationen A1 und A4 im Kalendermonat | S. 37 |
| (20) | `MIN [ (16) + (19) ; (3) ]` | Umlagereduzierende Strommenge im Kalendermonat | S. 37 |
| (21) | `(3) – (20)` | Umlagebelasteter Netzbezug im Kalendermonat | S. 37 |
| (22) | `∑J (21)` | Umlagebelasteter Netzbezug im Kalenderjahr | S. 37 |
| (23)¼ | `Z1NE¼ – (2)¼` | Viertelstundenwert der grundsätzlich förderfähigen zeitgleichen Netzeinspeisung von EE-Strom direkt aus der EE-Anlage | S. 38 |
| (24)¼ | `WENN [ AW¼ > 0 ; 1 ; 0 ]` | AW>0-Zeiten | S. 38 |
| (25)¼ | `(24)¼ • (23)¼` | Viertelstundenwert der förderfähigen zeitgleichen Netzeinspeisung von EE-Strom in AW>0-Zeiten direkt aus der EE-Anlage | S. 38 |
| (26) | `∑M (25)¼` | Förderfähige zeitgleiche Netzeinspeisung von EE-Strom in AW>0-Zeiten direkt aus der EE-Anlage im Kalendermonat | S. 38 |
| (27)¼ | `(24)¼ • (2)¼` | Viertelstundenwert der zeitgleichen Netzeinspeisung in AW>0-Zeiten aus dem Stromspeicher und/oder Ladepunkt | S. 38 |
| (28) | `MIN [ (13) ; (15) ]` | Grundsätzlich förderfähige Netzeinspeisung von EE-Speichererzeugung aus dem Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 38–39 |
| (29) | `∑M (27)¼` | Zeitgleiche Netzeinspeisung in AW>0-Zeiten aus dem Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 39 |
| (30) | `(29) / (11)` | AW>0-Anteil der zeitgleichen Netzeinspeisung aus dem Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 39 |
| (31) | `(30) • (28)` | Förderfähige Netzeinspeisung von EE-Speichererzeugung in AW>0-Zeiten aus dem Stromspeicher und/oder Ladepunkt im Kalendermonat | S. 39 |
| (32) | `(26) + (31)` | Insgesamt förderfähige Netzeinspeisung in AW>0-Zeiten im Kalendermonat | S. 39 |
| (33) | `∑J (32)` | Insgesamt förderfähige Netzeinspeisung in AW>0-Zeiten im Kalenderjahr | S. 39 |

**A5** übernimmt (1)¼ bis (22), (23)¼ und (28) von A1 — (23)¼ und (28) dann für die Summe der
gleichartigen Anlagen (S. 45) — und teilt die Förderseite je Anlage auf: (ZFa) = Painst / (Painst + Pbinst),
(23a)¼ A5 = (ZFa) • (23)¼, (24a)¼ = WENN [ AWa¼ > 0 ; 1 ; 0 ], (28a)A5 = (ZFa) • (28), (30a) = (29a) / (11),
bis (32a) = (26a) + (31a) und (33a) = ∑J (32a); ebenso für b (S. 46–49). Eine Gesamtsumme (32)/(33) gibt es
in A5 nicht (S. 50). **A5-Variante** rechnet A1 vollständig für beide Anlagen gemeinsam und teilt erst
am Ende: (32a)A5-Variante = (ZFa) • (32) (S. 53); sie stellt weder besser noch schlechter (S. 50).
**A10** ersetzt (20) bis (22): (20)A10 = (3), (21)A10 = (3) – (20)A10 = 0 (S. 96). **A11** ersetzt (16) und
(20) bis (22): (16)A11 = (4), (20)A11 = MIN [ (16)A11 ; (3) ] (S. 100–101). A10 und A11 haben keine
Förderseite — sie gelten nach Abschn. 10 für Fallkonstellationen ohne marktprämien-geförderte EE-Anlage.

**Farben** (A1 S. 18, Abschn. 2.3): grün = förderfähige Einspeisung von EE-Strom direkt aus der EE-Anlage
(26); gelb = EE-Strom im Speicher und förderfähige EE-Speichererzeugung (10), (15), (31); rot = Netzbezug im
Speicher und saldierungsfähige Netzeinspeisung (9), (16).

## Regeln, die Anlage 1 offenlässt

Jede steht mit Grund und Fundstelle in `regeln` bzw. `abweichungen` der Vektor-Datei.

- **zeit** — Eine Viertelstunde gehört zum Kalendermonat und Kalenderjahr, in dem sie nach gesetzlicher
  Zeit (MEZ/MESZ, Europe/Berlin) beginnt; `beginn` trägt immer den Versatz zur UTC, nie „Z“. Anlage 1
  sagt nur „Summe über alle Viertelstunden eines Kalendermonats“ (S. 33). Wer in UTC zuordnet, legt die
  erste Stunde jedes Monats in den Vormonat (Fall `a11-monatsgrenzen-in-ortszeit`).
- **nenner_null** — (14)A1, (18), (30), (30a), (30b) sind Quotienten ohne Regel für den Nenner null. Ein
  solcher Quotient ist nicht bestimmbar (`null`), das Produkt, in das er eingeht, ist 0. Bei (14)A1 und den
  AW>0-Anteilen ist der andere Faktor dann ohnehin 0 ((10) = 0 bzw. (28) = 0); bei (18) ist mit (6) = 0 auch
  (16) = 0, ohne saldierungsfähige Netzeinspeisung gibt es keinen Anteil, der Verluste privilegiert, also
  (19)A1,A4 = 0. Das passiert in jedem Monat, in dem der Speicher nur lädt.
- **viertelstunden_ohne_fluss** — Die Fälle führen nur Viertelstunden mit Stromfluss; eine weggelassene
  trägt 0 kWh. Das kürzt die Vektor-Datei und ist **keine Lückenregel**: im Rechenwerk ist eine fehlende
  Viertelstunde eine Lücke und nie eine Null (MP-8, Stand „vorläufig“ nach E4).
- **vergleich** — Vektor-Zahlen sind exakte Dezimalzahlen; die Leser lesen sie als BigDecimal bzw. Decimal.
  Gerechnet wird ungerundet; Rundung für Anzeige und Nachweis ist MP-16.
- **Bezeichnung (28a)A5** — S. 49 schreibt in (31a)/(31b) „(28a)¼ A5“; die Formel heißt auf S. 48 „(28a)A5“
  und ist ein Monatswert. Der Vertrag folgt S. 48.

## Befund: Speicherinhalt über die Monatsgrenze

Die Formeln bestimmen jeden Kalendermonat für sich (A1 S. 14, Abschn. 2.1.4). Lädt ein Speicher im
Formelsatz A1 am 30.09. aus dem Netz und speist am 01.10. ein, dann ist der September-Netzbezug
umlagebelastet ((21) = 50) und im Oktober gilt die Erzeugung über dem Verbrauch als **Fremdtankstrom**
((12) = 45): die Einspeisung wird weder saldiert noch gefördert (Fall
`a1-monatsgrenze-speicherinhalt-als-fremdtankstrom`). Derselbe Speicher als A10 trägt in keinem Monat
Umlage (Fall `a10-monatsgrenze-speicherinhalt`). Über einen vollen Zyklus im Monat stimmen A1 und A10
überein, wie Anlage 1 es sagt (S. 94; Fälle `a10-voller-zyklus` und `a1-netzspeicher-voller-zyklus`). Das
ist die wörtliche Anwendung, kein Rechenfehler — der Optimierer (MP-11) muss netzgeladene Energie vor dem
Monatsende ausspeisen, wenn er sie saldieren will.

## Fälle

| Fall | Formelsatz | zeigt | Fundstelle |
|---|---|---|---|
| `bnetza-beispielrechnungen-speichervorrang` | A1 | BNetzA-Zahlenbeispiele zum Speichervorrang: (1)¼ = 100 bei 130 kWh Netzbezug, (2)¼ = 80 bei 80 kWh Einspeisung | A1 S. 15–16, Abschn. 2.1.5, Beispielrechnung 1 (Abb. 1) und Beispielrechnung 2 (Abb. 2) |
| `a1-monat-alle-formeln` | A1 | jede Formel ungleich null: Netz- und Solarladen, AW¼ = 0 bei Solar- und Speichereinspeisung, (19)A1,A4 > 0 | A1 S. 33–39, Abschn. 4.2.2–4.2.5, Formeln (1)¼ bis (33) |
| `a1-htw-fehlanreiz-gesicherte-zuordnung` | A1 | mittags entladen, mit PV nachfüllen: (16) = 0, alles förderfähig | T S. 38–39 (Hinweis HTW Berlin, Dezember 2025) |
| `a1-monatsgrenze-speicherinhalt-als-fremdtankstrom` | A1 | Netzladung 30.09., Einspeisung 01.10.: (21) = 50 im September, (12) = 45 im Oktober; (18), (14)A1, (30) = null | A1 S. 14, Abschn. 2.1.4 (Kalendermonat als Saldierungsperiode) |
| `a10-monatsgrenze-speicherinhalt` | A10 | dieselben Z1-Werte als A10: (21)A10 = 0 in beiden Monaten | A1 S. 95–97, Abschn. 10.2.2–10.2.3, Formeln (20)A10 bis (22)A10 |
| `a10-voller-zyklus` | A10 | 100 kWh Bezug, 90 kWh Einspeisung: (20)A10 = (3) | A1 S. 94–96, Abschn. 10.2 und 10.2.2 |
| `a1-netzspeicher-voller-zyklus` | A1 | derselbe Zyklus nach A1: 90 saldiert + 10 Verluste = (20)A10 | A1 S. 94, Abschn. 10.2 („weder zu einer Besser- noch zu einer Schlechterstellung“) |
| `a11-speicher-mit-sonstigem-verbrauch` | A11 | (16)A11 = (4), keine privilegierungsfähigen Verluste | A1 S. 100–101, Abschn. 10.3.2–10.3.3, Formeln (16)A11 bis (22)A11 |
| `a11-ladepunkt-fremdtankstrom-nicht-erkennbar` | A11 | Ladepunkt speist mehr ein als bezogen: MIN in (20)A11 begrenzt auf (3) | A1 S. 16, Abschn. 2.1.6 (Fremdtankstrom im Sonderfall A11 nicht identifizierbar) |
| `a11-monatsgrenzen-in-ortszeit` | A11 | Sommerzeit-Ende, Monats- und Jahreswechsel in gesetzlicher Zeit statt UTC | A1 S. 33, Abschn. 4.2.1 (∑M, ∑J) |
| `a5-zwei-anlagen-unterschiedliche-aw` | A5 | 30 kW + 10 kW, AWa¼ = 0 bei AWb¼ > 0: Förderung je Anlage | A1 S. 43–51, Abschn. 5.1–5.4.1, Formeln (ZFa) bis (33b) |
| `a5-uebereinstimmende-aw` | A5 | gleiche AW>0-Zeiten nach A5: (32a) = 63, (32b) = 21 | A1 S. 50, Abschn. 5.4 („weder zu einer Besser- noch zu einer Schlechterstellung“) |
| `a5-variante-uebereinstimmende-aw` | A5-Variante | dieselben Eingänge nach A5-Variante: (32a)A5-Variante = 63, (32b)A5-Variante = 21 | A1 S. 52–54, Abschn. 5.4.2, Formeln (32a)A5-Variante bis (33b)A5-Variante |
| `a5-rumpfmonate-leistungsaenderung` | A5 | Anlage b ab 15.05. 30 statt 10 kW: zwei Rumpfmonate mit eigenem (ZFa)/(ZFb) | A1 S. 102–103, Abschn. 11 (bestimmungsrelevante Änderung: „für Zuordnungsfaktoren relevante Leistungsänderungen von bereits eingebundenen gleichartigen EE-Anlagen“) |

## Was die Leser prüfen (L1–L8)

Beide Leser prüfen dieselbe Liste; ein Fall, den nur einer anmahnt, ist ein Fehler im anderen.

1. **L1 Schema** — Java über `uems/UemsSchemaLaeufer`, Python über `jsonschema` (Draft 2020-12).
2. **L2 Katalog** — jede Formelnummer einmal; A1 trägt (1) bis (33) außer (7)A4/(8)A4; zusammen mit
   `nicht_im_umfang` ist (1)–(33) vollständig; Formelsatz und Formel nennen einander in beide Richtungen;
   `summe.von` und `quotient` zeigen auf bekannte Formeln oder Eingänge.
3. **L3 Eingänge** — Namen eindeutig; jede Viertelstunde trägt genau die Eingänge ihres Formelsatzes;
   Stammdaten genau bei A5/A5-Variante; in der A5-Variante stimmen die AW>0-Zeiten von a und b überein.
4. **L4 Raster** — Beginn auf dem Viertelstundenraster, streng aufsteigend; Rumpfmonat: von < bis.
5. **L5 Monats- und Jahresgrenzen** — die erwarteten Monate sind genau die Kalendermonate (gesetzliche
   Zeit) bzw. Rumpfmonate der Viertelstunden, die Jahre genau deren Kalenderjahre.
6. **L6 Vollständigkeit** — jeder Monat, jedes Jahr und jede Viertelstunde trägt genau die Formeln ihres
   Formelsatzes und ihrer Ebene, in Katalog-Reihenfolge.
7. **L7 Summen** — jede ∑M-Formel ist die exakte Summe ihrer Viertelstunden, jede ∑J-Formel die Summe ihrer
   Monate und Rumpfmonate.
8. **L8 Nenner null** — `null` steht genau dort, wo ein Quotient den Nenner 0 hat; nie in Jahren oder
   Viertelstunden.

Prüfnachweis (ohne Docker):
`(cd services/api && ./mvnw test -Dtest=MispelAbgrenzungVectorsTest)` (JDK 21) und
`(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_mispel_abgrenzung_vectors.py tests/test_mispel_abgrenzung_rechenwerk.py -q)`.

## Beim Ändern

Eine geänderte Formel, ein neuer Fall oder eine neue Lesart ändert die Vektor-Datei, das Schema und beide
Leser zusammen; jede Abweichung von Anlage 1 bekommt einen Eintrag in `abweichungen` mit Fundstelle. Alle
Leser finden: `rg -l "mispel-abgrenzung" services frontend` — ab MP-8/MP-9 gehören die Rechenwerk-Tests
dazu. Erwartete Werte werden gerechnet, nicht abgeschrieben; wer einen Fall von Hand ändert, rechnet ihn
in beiden Zwillingen nach.
