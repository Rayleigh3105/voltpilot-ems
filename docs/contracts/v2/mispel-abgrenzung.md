# MiSpeL-Abgrenzungsoption: Formelsätze A1, A2, A3, A4, A5, A10, A11

Vertrag zu Anlage 1 („Abgrenzungsoption“) der Festlegung zur Marktintegration von Speichern und
Ladepunkten (MiSpeL, Az. 618-25-02, Beschluss vom 01.10.2026). Bau-Paket MP-4 der Stufe 1; die Basisfälle mit
Ladepunkt A2, A3, A4 kamen mit MP-32 (Stufe B, [unten](#ladepunkte-a2-a3-a4-mp-32)).

- **[`mispel-abgrenzung-vectors.json`](./mispel-abgrenzung-vectors.json)** — die Wahrheit: Formelkatalog
  (Nummer, Begriff und Rechenweg **wörtlich** aus Anlage 1, Fundstelle je Formel), die fünf Formelsätze,
  Regeln, Lesarten, 21 Rechenfälle und 9 Erkennungsfälle für Rumpfmonate (MP-21), jeder mit Fundstelle. Wo dieser Text und die Datei sich widersprechen, gilt die
  Datei — und dann ist einer von beiden falsch.
- **[`mispel-abgrenzung.schema.json`](./mispel-abgrenzung.schema.json)** — Schema der Datei.
- **Leser im Gleichlauf** (beide per Pfad, beide prüfen L1–L10 unten; L9 in den Rechenwerk-Tests):
  Java `services/api/src/test/java/com/voltpilot/api/mispel/MispelAbgrenzungVectorsTest.java`,
  Python `services/optimization/tests/test_mispel_abgrenzung_vectors.py`.
- **Rechenwerke im Gleichlauf** (beide rechnen jeden Fall exakt nach, ungerundet):
  Python `services/optimization/voltpilot_optimization/mispel_abgrenzung.py` (MP-9, für Optimierer und
  Simulation; exakte Brüche, Stufen Viertelstunde → ∑M → Monat → ∑J, Monat auch aus laufenden Summen),
  Test `services/optimization/tests/test_mispel_abgrenzung_rechenwerk.py`; Java
  `services/api/src/main/java/com/voltpilot/api/mispel/MispelAbgrenzungRechenwerk.java` (MP-8, dieselben Stufen
  mit exakten Brüchen `Bruch`), Test `…/mispel/MispelAbgrenzungRechenwerkTest.java`. Der Java-Zwilling nimmt AW¼
  als „AW¼ > 0“ an — mehr wertet (24)¼ nicht aus. Eingebaut: der Monatslauf (MP-8, unten); der Optimierer
  liest seit MP-11 die Monatswerte des jüngsten Laufs als Monatszustand (`inputs.load_mispel_bisher`); Simulation
  MP-13 noch nicht.

Zitierweise: „A1 S. 35“ = Anlage 1, Seite 35; „T S. 38“ = Tenor mit Begründung, Seite 38. Die Festlegung
hat keine Randnummern.

## Umfang

| Formelsatz | Fallkonstellation (Anlage 1) | Zähler | Eingänge je Viertelstunde | Fundstelle |
|---|---|---|---|---|
| A1 | Basisfall A1: „Stromspeicher“ | Z1, Z2 | Z1NB¼, Z1NE¼, Z2V¼, Z2E¼, AW¼ | S. 29, S. 32–39 |
| A2 | Basisfall A2: „Ladepunkt“ | Z1, Z2 | wie A1 | S. 29–30, S. 32–39 |
| A3 | Basisfall A3: „Stromspeicher und Ladepunkt“ (vereinfachte Alternative zu A4) | Z1, Z2 | wie A1 | S. 30–31, S. 32–39 |
| A4 | Basisfall A4: „Stromspeicher und Ladepunkt mit gesonderter Messung für die Speicherverluste“ | Z1, Z2, Z3 | wie A1 und Z3V¼, Z3E¼ | S. 31–39 |
| A5 | Sonderfall A5: Mehrere gleichartige EE-Anlagen (Abwandlung zu A1) | Z1, Z2 | wie A1, aber AWa¼, AWb¼; Stammdaten Painst, Pbinst | S. 43–51 |
| A5-Variante | vereinfachtes Vorgehen bei jederzeit übereinstimmenden AW>0-Zeiten | Z1, Z2 | wie A5 | S. 52–54 |
| A10 | Sonderfall A10: rein netzgekoppelter Stromspeicher | Z1 | Z1NB¼, Z1NE¼ | S. 94–97 |
| A11 | Sonderfall A11: Stromspeicher und/oder Ladepunkt ohne sonstige Erzeugung | Z1 | Z1NB¼, Z1NE¼ | S. 98–102 |

**Nicht in diesem Vertrag** (Bauplan § 8.5, E5 = B): A6–A9 erst, wenn ein Kunde sie braucht (`nicht_im_umfang`
ist seit MP-32 leer, der Katalog trägt (1)–(33) vollständig); die Pauschaloption (Anlage 2) in MP-24. Ein Wechsel des
Formelsatzes innerhalb eines Monats und das Erkennen von Rumpfmonaten aus den Änderungsprotokollen sind
MP-21 ([unten](#rumpfmonate-erkennen-mp-21)); die Rechenfälle führen Rumpfmonate als vorgegebenen Zeitraum.

## Eingänge, Einheiten, Vorzeichen

Alle Zählerwerte sind **Strommengen je Viertelstunde in kWh** (keine Leistung) und nie negativ: der
Zweirichtungszähler Z1 trennt Netzbezug Z1NB¼ und Netzeinspeisung Z1NE¼, Z2 trennt Verbrauch Z2V¼ (Laden)
und Erzeugung Z2E¼ (Entladen) im Stromspeicher und/oder Ladepunkt (A1 S. 32), Z3 in A4 Verbrauch Z3V¼ und Erzeugung
Z3E¼ im Stromspeicher allein (A1 S. 32). AW¼ ist der anzulegende Wert
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

## Ladepunkte: A2, A3, A4 (MP-32)

Ein bidirektional nutzbarer Ladepunkt ist in der Abgrenzungsoption einem Stromspeicher gleichgestellt (A1 S. 12;
§ 19 Abs. 3 S. 5 EEG, § 21 Abs. 3 EnFG): Laden ist Verbrauch **im Ladepunkt**, Rückspeisen Erzeugung **im
Ladepunkt**, gleich welches Elektromobil angesteckt ist (A1 S. 7, Begriff „Ladepunkt“). A2, A3 und A4 rechnen die
Formeln von A1 mit drei Fallunterscheidungen (A1 S. 34–37):

| Nr. | Rechenweg | Begriff | Formelsätze | Seite |
|---|---|---|---|---|
| (7)A4 | `∑M Z3V¼` | Verbrauch im Stromspeicher in der Fallkonstellation A4 im Kalendermonat | A4 | S. 34 |
| (8)A4 | `∑M Z3E¼` | Erzeugung im Stromspeicher in der Fallkonstellation A4 im Kalendermonat | A4 | S. 34 |
| (14)A2,A3,A4 | `0,85` | Wirkungsgrad der Stromspeicherung in den Fallkonstellationen A2, A3 und A4 | A2, A3, A4 | S. 35 |
| (17)A4 | `MAX [ (7)A4 – (8)A4 ; 0 ]` | Verluste im Stromspeicher in der Fallkonstellation A4 im Kalendermonat | A4 | S. 36 |
| (19)A2,A3 | `0` | Keine privilegierungsfähigen Stromspeicherverluste in den Fallkonstellationen A2 und A3 im Kalendermonat | A2, A3 | S. 37 |

- **Fremdtankstrom** — (12) = MAX [ (6) – (5) ; 0 ] und (13) = MAX [ (11) – (12) ; 0 ] gelten unverändert (S. 35):
  übersteigt die Erzeugung im Stromspeicher und/oder Ladepunkt im Kalendermonat die an Z2 gemessenen Verbräuche, ist
  der Überschuss anderswo geladener, „mitgebrachter“ Strom; er wird weder saldiert noch gefördert (S. 16, Abschn.
  2.1.6). Prüfnachweis: 20 kWh geladen, 30 kWh zurückgespeist → (12) = 10 kWh (Fall
  `a2-fremdtankstrom-20-geladen-30-rueckgespeist`). Der erkannte Wert ist eine **Mindestmenge**: Verluste eines
  Stromspeichers hinter demselben Z2 verdecken einen Teil (S. 16; Fall `a4-fremdtankstrom-mindestens`).
- **Wirkungsgrad 0,85** statt (6) / (5), „mangels geeigneter Messwerte“ (S. 35) — auch wenn Z2 einen anderen zeigt
  (Fall `a2-wirkungsgrad-0-85-ohne-verlustprivileg`). (14)A2,A3,A4 und (19)A2,A3 tragen ihren festen Wert als
  `konstante` im Katalog (Regel L10).
- **Kein Verlustprivileg für Ladepunkte** — (19)A2,A3 = 0; die Speicherverluste der Elektromobile sind ein nicht
  abgrenzbarer Teil ihres umlagepflichtigen Fahrstroms (S. 12). A2 und A3 führen (17) und (18) nicht (Lesart unter
  `abweichungen`, S. 36–37). In A4 sind nur die an Z3 gemessenen Verluste des Stromspeichers anteilig
  privilegierungsfähig; mit denselben Zählern Z1 und Z2 ergibt A3 darum eine um (19)A1,A4 geringere
  umlagereduzierende Strommenge (S. 30; Fälle `a3-speicher-und-ladepunkt-ohne-verlustprivileg` und
  `a4-gesonderte-messung-speicherverluste`).
- **A11 für Ladepunkte** — A11 tritt an die Stelle der Basisfälle A1 bis A4 (S. 24), mit Ladepunkt als Abwandlung zu
  A2 oder A3; als Abwandlung zu A4 scheidet A11 aus (S. 99). Mit Ladepunkt gilt A11 mit **und** ohne sonstigen
  Verbrauch (S. 99; Fall `a11-ladepunkt-ohne-sonstigen-verbrauch`) und mindert die umlagereduzierende Strommenge
  gegenüber A2 und A3 nicht (S. 98). Mit nur Z1 ist Fremdtankstrom nicht erkennbar und wird nicht abgezogen (S. 16);
  die MIN-Funktion in (20)A11 begrenzt auf den Netzbezug (3). **A10** ist für Ladepunkte nicht anwendbar (S. 95).
- **Pauschaloption** — die Ladepunkt-Rechengröße (P2)P2 = 0,2 und (P2)P3 = MIN [ (P2)P1 ; (P2)P2 ] stehen seit
  MP-24/MP-25 im Vertrag [MiSpeL-Pauschal](./mispel-pauschal.md) (A2 S. 29; Fälle `p2-ladepunkt-rechengroesse-0-2`,
  `p3-speicher-und-ladepunkt-guenstigere-rechengroesse`); auch dort ist Fremdtankstrom nicht erkennbar (A1 S. 16).
- **Förderweg und Monatslauf** — A2–A4 sind als Formelsatz wählbar ([Förderweg](./mispel-foerderweg.md)); die Wahl
  A3 statt A4 und A11 statt A1 bis A4 bindet bis zum Ende des Kalenderjahres (S. 24). `V20261002224700` erweitert
  die Formelsatz-CHECKs von `site_foerderweg` und `mispel_abgrenzung_monat`; der Monatslauf liest in A4 sechs Zähler
  (Prüfnachweis mit Docker: `MispelAbgrenzungMonatslaufTest#monatslaufA4MitZ3AmSpeicher`). Der Optimierer plant
  A2–A4 noch nicht im Mischbetrieb (`pricing.MISCHBETRIEB_FORMELSAETZE` bleibt A1, A5, A5-Variante): das Fahrzeug
  als Speicher ist MP-33.

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
  Gerechnet wird ungerundet; gerundet wird nur die Anzeigezahl im Nachweis ([MP-16](#nachweis-und-export-mp-16)).
- **rumpfmonate** — ein Monat wird an jedem Tag außer dem Monatsersten geteilt, an dem sich Fallkonstellation,
  Messkonzept oder Werte zur Bestimmung ändern; Rumpfmonate nur für Teile, die nach Anlage 1 zu bestimmen sind
  (A1 S. 102–104). Lesarten: Grenze tagesscharf, Zählerwechsel ohne neues Messkonzept teilt nicht, Schlüssel
  `JJJJ-MM/T` (T = erster Tag) — je mit Grund unter `abweichungen`.
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
Monatsende ausspeisen, wenn er sie saldieren will. Stand MP-11: der Plan bucht jeden Monat für sich, rechnet (12)
aber nur aus den bisherigen Summen (für den Lauf 0, Normalbetrieb mit (5) ≥ (6)); diesen Grenzfall sieht er nicht.

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
| `a11-rumpfmonate-speicher-kommt-zum-ladepunkt` | A11 | Speicher kommt am 15.06. zum Ladepunkt (Basisfall A2 → A3): zwei Rumpfmonate, (21)A11 = 50 statt 20 im ganzen Monat | A1 S. 102, Abschn. 11; S. 100–101 |
| `a2-fremdtankstrom-20-geladen-30-rueckgespeist` | A2 | Prüfnachweis MP-32: (5) = 20, (6) = 30 → (12) = 10 kWh Fremdtankstrom; (16) = 11,5 statt 21,5 | A1 S. 16, Abschn. 2.1.6; Formeln (12), (13), (14)A2,A3,A4: S. 35; (19)A2,A3: S. 37 |
| `a2-wirkungsgrad-0-85-ohne-verlustprivileg` | A2 | gemessen 72,5 / 80, gerechnet 0,85; (19)A2,A3 = 0 trotz (5) > (6); Rückspeisung bei AW¼ = 0 | A1 S. 35, S. 37; S. 12, Abschn. 2.1.3 |
| `a3-speicher-und-ladepunkt-ohne-verlustprivileg` | A3 | Speicher und Ladepunkt hinter Z2: (20) = 33 | A1 S. 30, Abschn. 4.1.3; S. 35, S. 37 |
| `a4-gesonderte-messung-speicherverluste` | A4 | dieselben Z1/Z2 mit Z3: (17)A4 = 10, (19)A1,A4 = 5,5, (20) = 38,5 statt 33 | A1 S. 30–32, Abschn. 4.1.3–4.1.4; S. 34, S. 36–37 |
| `a4-fremdtankstrom-mindestens` | A4 | 32 kWh mitgebracht, (12) = 28 erkannt: Speicherverluste verdecken den Rest | A1 S. 16, Abschn. 2.1.6 („mindestens“); S. 35–36 |
| `a11-ladepunkt-ohne-sonstigen-verbrauch` | A11 | Ladepunkt ohne Erzeugung und ohne sonstigen Verbrauch: 20 geladen, 30 zurück → (20)A11 = (3) = 20 | A1 S. 99, Abschn. 10.3.1; S. 98; S. 16 |
| `a5-rumpfmonate-leistungsaenderung` | A5 | Anlage b ab 15.05. 30 statt 10 kW: zwei Rumpfmonate mit eigenem (ZFa)/(ZFb) | A1 S. 102–103, Abschn. 11 (bestimmungsrelevante Änderung: „für Zuordnungsfaktoren relevante Leistungsänderungen von bereits eingebundenen gleichartigen EE-Anlagen“) |

## Monatslauf und Nachweis (MP-8)

`mispel/MispelAbgrenzungService.monatslauf(anlage, monat, vorgaben)` rechnet je Anlage (Einspeisestelle) einen
Kalendermonat oder einen vorgegebenen Rumpfmonat (A1 S. 102, Abschn. 11; erkannt mit `monatslaeufe`, MP-21 unten):

- **Eingänge:** die Zähler aus `ZaehlerrolleService.anlage` ([Zählerrolle](./mispel-zaehlerrolle.md)) am ersten
  und letzten Tag — sie müssen gleich sein, sonst `bestimmungsrelevante_aenderung` (Zähler fällt weg) bzw.
  `zaehlerwechsel_im_zeitraum` (andere Messstelle oder Angaben, kein Rumpfmonat; abschnittsweises Lesen offen); ihre Viertelstundenmengen über
  die Messstelle (`MispelZaehlerLeser`, in kWh) — mit Wertequelle „Messstellenbetreiber“ und eingelesenen Werten für
  Zählpunkt und Richtung im Zeitraum NUR diese ([MP-15](#werte-des-messstellenbetreibers-und-abgleich-mp-15)); AW¼ > 0 aus `MispelMarktdatenRepository.awZeiten` mit der
  AW-Regel der Anlage. Formelsatz, AW-Regel und Painst/Pbinst gibt der Aufrufer vor; der Läufer (MP-8b, unten) nimmt
  Formelsatz und AW-Regel aus dem Förderweg.
- **Lücke:** fehlt einer Viertelstunde ein Zählerwert oder AW¼, bleibt sie aus den Summen draußen und steht im
  Nachweis (Anzahl und Beginn je fehlendem Eingang) — nie als Null; ohne eine vollständige Viertelstunde `keine_werte`.
- **Stand (E4 = C):** `endgueltig` nur ohne Lücke, mit Wertequelle „Messstellenbetreiber“ und Urteil „tauglich“ an
  jedem Zähler (Tenor S. 28; § 21 Abs. 4 S. 2 EnFG), endgültigen Viertelstunden, AW¼ aus der ÜNB-Liste und nach
  Ende des Zeitraums; sonst `vorlaeufig` mit Gründen (`luecken`, `wertequelle_geraet`, `zaehler_<urteil>:<MS>`,
  `viertelstunden_vorlaeufig`, `aw_rueckfall`, `zeitraum_offen`; in A2–A4 aus den Ladepunkten am ersten Tag
  ([MP-31](./mispel-ladepunkt-bidirektional.md), `LadepunktService.anlage`) `kein_ladepunkt_der_festlegung` (A1 S. 26
  Fn. 21, S. 29–31) und `ladepunkt_<befund>:<MS>` je Fehler-Befund, z. B. `unidirektional_hinter_z2` (A1 S. 25)). `wertequelle` des Laufs ist `geraet`, sobald ein
  Zähler vom Gerät liest — auch mit Wertequelle „Messstellenbetreiber“, solange für ihn keine Werte eingelesen sind
  (dann zusätzlich `msb_werte_fehlen:<MS>`, MP-15). Die Datenbank hält endgültig = Messstellenbetreiber + lückenlos selbst (CHECK).
- **Nachweis:** `mispel_abgrenzung_monat` (`V20261002153700`, RLS + FORCE, App nur SELECT/INSERT) je Lauf als
  Fassung: kanonischer JSON-**Text** (Festlegung, Vertrag + Fassung, Rechenwerk-Version, Zähler mit Zählpunkt,
  MSB, Eichstatus, Wertequelle und Urteil, AW-Regeln, Lücken, je Viertelstunde Eingänge und Zwischenwerte,
  Monatswerte) und SHA-256 über genau diese Bytes. Gleiche Prüfsumme = keine neue Fassung. Zahlen exakt (Dezimal
  oder `z/n`), `null` = nicht bestimmbar. Export und Rundung: [MP-16](#nachweis-und-export-mp-16). Die Maps des
  Texts sind geordnet (nie `Map.of`: dessen Reihenfolge wechselt je JVM und damit die Prüfsumme).

Prüfnachweis mit Docker: `(cd services/api && ./mvnw test -Dtest=MispelAbgrenzungMonatslaufTest)`.

### Der Läufer (MP-8b)

`mispel/MispelMonatslaufLaeufer` stößt `monatslaeufe` je Anlage mit einer Fassung `marktpraemie_abgrenzung` selbst an
(`voltpilot.mispel.monatslauf.enabled`, täglich 05:17 Europe/Berlin, Katalog `mispel_monatslauf` in
[Betriebsüberwachung](../../agents/root/uems-betriebsueberwachung.md)). „Sobald die erforderlichen viertelstündlich
erfassten Messwerte zum abgelaufenen Kalendermonat feststehen, lassen sich die relevanten Werte für den jeweiligen
Kalendermonat nach dem Formelsatz zu der jeweiligen Fallkonstellation bestimmen“ (A1 S. 14, Abschn. 2.1.4):

- **Wann:** ein Monat erst nach seinem Ablauf (Berliner Tag); auf Gerätewerten `vorlaeufig`. Ein vorläufiger Monat
  wird in jedem Takt neu gerechnet und wird `endgueltig`, sobald die Werte des Messstellenbetreibers eingelesen sind
  (MP-15) und die übrigen Bedingungen oben stimmen. Ein endgültiger Monat rechnet nur neu, wenn danach ein Import des
  Messstellenbetreibers seinen Zeitraum an einer Messstelle der Anlage überdeckt oder eine Fassung des Förderwegs
  eingetragen bzw. aufgehoben wurde. Gleiche Prüfsumme = keine neue Fassung.
- **Welche Monate:** ab Oktober 2026 (Festlegung) die des laufenden Kalenderjahres und bis zum 31.05. auch die des
  Vorjahres — die Monatswerte gehen in die Endabrechnung des Kalenderjahres (A1 S. 14), mitgeteilt bis 31.05. des
  Folgejahres (§ 21 Abs. 7 EnFG). Danach bleibt ein Monat, wie er gespeichert ist.
- **Vorgaben:** je wirksame Fassung des [Förderwegs](./mispel-foerderweg.md) ein Fallstand ab `gueltig_ab` — in der
  Abgrenzungsoption mit `formelsatz` und `aw_regel` dieser Fassung, sonst ohne (keine Bestimmung nach Anlage 1). Eine
  zum Monatsersten vorgemerkte Fassung gilt so ab ihrem Monat. Anlass beim Wechsel des Förderwegs:
  `erstmalige_zuordnung`, wenn vorher keine Fassung stand und der Tag kein Monatserster ist, sonst
  `wechsel_zuordnung` (A1 S. 103) — mitten im Monat lehnt `teilen` ihn ab.
- **Nicht bestimmbar, übersprungen:** A5/A5-Variante (Painst/Pbinst und AW-Regel der Anlage b, A1 S. 46, trägt der
  Förderweg nicht) und A1–A4 ohne `aw_regel` (ohne sie keine Liste der ÜNB, A1 S. 17 Fn. 8). Lehnt das Rechenwerk
  ab (`MispelAbgrenzungAbgelehnt`), bleibt der Monat ohne Lauf; ein anderer Fehler zählt beim Melder. Keiner hält eine
  andere Anlage oder einen anderen Monat auf.

Prüfnachweis mit Docker: `(cd services/api && ./mvnw test -Dtest=MispelMonatslaufLaeuferTest)`.

## Rumpfmonate erkennen (MP-21)

Anlage 1 Abschn. 11 (S. 102–104): eine **bestimmungsrelevante Änderung** innerhalb eines Kalendermonats teilt ihn
in **Rumpfmonate**; jeder tritt an die Stelle des Kalendermonats und wird mit dem Formelsatz seiner Fallkonstellation
bestimmt. Reine Regel `mispel/MispelRumpfmonate.teilen` ⟷ Python `mispel_abgrenzung.rumpfmonate`, Vektoren unter
`rumpfmonate` (Regel L9).

- **Stand** ab einem Tag: Fallkonstellation (Formelsatz, Basisfall A1–A4 dahinter; ohne Formelsatz keine Bestimmung
  nach Anlage 1), Messkonzept (Z1/Z2/Z3 → Messstelle), Werte zur Bestimmung (Painst, Pbinst, AW-Regel). Anlass aus dem
  geschlossenen Vokabular `speicher_ladepunkt · erzeugung · sonstiger_verbrauch · messkonzept · erstmalige_zuordnung ·
  wechsel_zuordnung · zaehlerwechsel · netznutzer · direktvermarkter · personell` (S. 102–104).
- **Wirkung** aus dem Vergleich zweier Stände: `fallkonstellation`, `messkonzept`, `werte` teilen; `zaehlerwechsel`
  (dieselben Zähler, andere Messstelle) und eine Änderung ohne Wirkung (Netznutzer, Direktvermarkter, Personen) nicht.
- **Teilung:** am Monatsersten kein Rumpfmonat (S. 103). Zwei Rumpfmonate nur, wenn vor UND nach der Änderung nach
  Anlage 1 zu bestimmen ist — kommt der Speicher erst hinzu, gibt es nur den Rumpfmonat danach („vor und/oder nach“,
  S. 102). `wechsel_zuordnung` mitten im Monat wird abgelehnt (`wechsel_nur_zum_monatsersten`, S. 103; § 21b Abs. 1
  S. 2 EEG). Schlüssel `JJJJ-MM` bzw. `JJJJ-MM/T`.
- **Dienst:** `MispelAbgrenzungService.teilung(anlage, monat, fallstaende)` nimmt die Fallkonstellation aus den
  Fallständen des Aufrufers (im Läufer MP-8b: aus dem Förderweg) und das Messkonzept je Tag aus dem Änderungsprotokoll der
  Zähler — Fassungen der Zählerrolle und Stellungen der Messstellen (`ZaehlerrolleService.anlage`, MP-6);
  `monatslaeufe(…)` rechnet jeden Teil mit dem Monatslauf. Prüfnachweis mit Docker:
  `MispelAbgrenzungMonatslaufTest#rumpfmonateAusDemAenderungsprotokollErkannt`.

## Nachweis und Export (MP-16)

Aus den gespeicherten Läufen entsteht je Kalendermonat die monatliche Mengenbestimmung und je Kalenderjahr der
Jahresnachweis für die Mitteilung des Lieferanten bis 31.05. des Folgejahres (§ 21 Abs. 7 EnFG), als CSV und PDF:

- **Routen** (`web/SiteMispelNachweisController`, Recht `export.standort` + Leseweg der Anlage, kein `produces`):
  `GET /api/v1/sites/{siteId}/mispel/abgrenzung/monate/{JJJJ-MM}/nachweis.csv|.pdf?empfaenger=…` und
  `…/jahre/{JJJJ}/nachweis.csv|.pdf?empfaenger=…`. Ablehnungen `{code, message}`: `empfaenger_unbekannt`,
  `zeitraum_ungueltig` (400, vor 2026-10), `kein_lauf` (404), `pruefsumme_abweichend` (409).
- **Nur aus den Läufen:** `mispel/MispelNachweis` (rein) liest je Zeitraumbeginn die jüngste Fassung; überschneiden
  sich Zeiträume, gilt der zuletzt gerechnete Lauf. Jeder Nachweis-Text wird vorher gegen seine Prüfsumme geprüft.
  Selbst gebildet wird nur ∑J als Summe der Jahresbeiträge der Läufe ((22), (33), (33a)/(33b) …, A1 S. 37, S. 39).
- **Empfänger** sind Rollen der Festlegung, nie Unternehmen (E8 = D): `lieferant` (3), (16), (19), (20), (21) / (22)
  (A1 Abschn. 4.3); `direktvermarkter` (4), (26), (31), (32) / (33) mit a/b in A5 (Abschn. 4.4); `netzbetreiber`
  beide. Alle bekommen denselben Formelsatz (Nummer, Rechenweg, Begriff, Fundstelle aus der Vektor-Datei, die
  `pom.xml` ins Jar legt), dasselbe Messkonzept (Zähler aus MP-6) und dieselben Zwischenwerte; A10/A11 haben keine
  Förderseite (Abschn. 10) — der Direktvermarkter bekommt dann den Satz statt einer Zahl.
- **Stand (E4 = C):** endgültig nur, wenn jeder Lauf endgültig ist und zwischen den Läufen keine Lücke liegt; das Jahr
  zusätzlich bis 31.12. (`nicht_bis_jahresende`). Vor dem ersten Lauf darf der Zeitraum offen sein — ein Rumpfmonat
  steht „vor und/oder nach“ der Änderung (A1 S. 102); das Jahr nennt „Bestimmung nach Anlage 1 ab …“. Vorläufig heißt
  nie „Mengenbestimmung“: CSV `gilt_als_nachweis=nein`, PDF mit Wasserzeichen „vorläufig – keine Mengenbestimmung“.
- **Zahlen:** CSV `wert` kaufmännisch gerundet (kWh auf 3, Faktoren auf 6 Nachkommastellen) und `wert_exakt`
  ungerundet (Dezimalzahl oder `z/n`); das PDF zeigt die gerundete Zahl. Anlage 1 regelt keine Rundung.
- **Form:** CSV wie der Berichts-CSV (UTF-8 mit BOM, CRLF, `# schlüssel=wert`, `;`, Dezimalkomma, Abschnitte
  `laeufe`, `abdeckung`, `ergebnis`, `messkonzept`, `angaben`, `formelsatz`, `luecken`, `viertelstunden`; im Jahr
  `laeufe`, `abdeckung`, `ergebnis`, `monatswerte`). Das PDF setzt `uems/BerichtPdf.setzen` (PDFBox, Liberation
  Sans); byte-gleich bei jeder Erzeugung, Datum = jüngste Rechenzeit, `/ID` aus den Prüfsummen. Das Format der
  Marktkommunikation regelt die Festlegung nicht (T S. 25, S. 28, S. 92); EDI@Energy folgt, sobald festgelegt.

Prüfnachweis: `(cd services/api && ./mvnw test -Dtest='MispelNachweisTest,MispelNachweisApiTest')` (der zweite mit
Docker). Der Download-Knopf steht in der Kundenansicht (MP-18, unten).

## Kundenansicht Mengen und Ertrag (MP-18)

Verlauf › Erlöse, Zeitraum Monat und Jahr (Bedienkonzept BK-18 Variante A, abgestimmt 02.10.2026): Karte „MiSpeL ·
Mengen nach Anlage 1“ unter der Kennzahlleiste, kein neuer Reiter.

- **Routen** (`web/SiteMispelMengenController`, Leseweg der Anlage, außerhalb 404):
  `GET /api/v1/sites/{siteId}/mispel/abgrenzung/monate/{JJJJ-MM}` und `…/jahre/{JJJJ}`. Immer 200 für eine sichtbare
  Anlage; `abgrenzung = false` = keine Bestimmung nach Anlage 1 im Zeitraum (keine Karte), `mispel` = Abgrenzungs- oder
  Pauschaloption (für W5). Ablehnung `zeitraum_ungueltig` (400) wie der Nachweis.
- **Nur aus den Läufen:** `mispel/MispelMengenService` wählt die geltenden Läufe wie der Nachweis (`MispelNachweis.monat`,
  Prüfsumme) und liest ihre Monatswerte; `mispel/MispelMengen` (rein) beschriftet jede Menge mit Nummer, Begriff und
  Fundstelle aus dem Katalog. Farben nach A1 S. 18: grün (26), gelb (31), rot (16) — in A5 (26a) + (26b), (31a) + (31b);
  Netzbezug (3), umlagereduziert (20), umlagebelastet (21), förderfähig (32). Selbst gebildet wird nur **grau =
  (4) − (26) − (31) − (16)** (weder förderfähig noch saldierungsfähig: AW ≤ 0, Fremdtankstrom); Anlage 1 benennt diese
  Restgröße nicht, sie ist ≥ 0, weil (16) + (28) = (13) ≤ (11) und (31) ≤ (28).
- **Was das wert ist:** vermiedene Umlagen und vermiedenes Netzentgelt = (20) × `umlagen_ct` bzw.
  `netzentgelt_arbeitspreis_ct` des Preisblatts (`site_supply_price`) × (1 + USt), auf Cent gerundet; ohne Satz
  `offen` (`preisblatt_fehlt`). Marktprämie = (32) × max(AW − Jahresmarktwert Solar, 0) (A1 S. 21 Vor. 5), `offen`
  solange der Jahresmarktwert fehlt oder vorläufig ist (`jahresmarktwert_offen`), ohne AW (`anzulegender_wert_fehlt`) und in
  A5 (`je_anlage_a5`) — nie 0 €. Ohne Lauf sind `stand` und `wert` `null`.
- **Stand:** der des Nachweises (E4 = C). Ist ein Lauf endgültig und hatte sein Zeitraum vorher eine vorläufige Fassung
  mit anderen Zahlen, trägt der Teil `aenderung` (vorige Fassung, ihre Gründe, Unterschied in €) — die Jahresansicht
  nennt so den Grund neben dem Monat.
- **Portal:** `components/erloese/MispelKarte.tsx` (Monat, Jahr, Nachweis-Blatt am Telefon) über `mispelMengen.ts`
  (nur Formatierung). Der Nachweis geht über die Routen von MP-16; vorläufige Zeiträume nur als „Vorschau (PDF)“ mit
  Wasserzeichen. Für Anlagen mit `mispel = true` nennt der Preise-Fuß der Erlöse kein „davon durch Netzladen“ (W5).
  Im Prop `ampel` neben dem Stand steht der Satz der Abweichungsampel ([MP-15](#werte-des-messstellenbetreibers-und-abgleich-mp-15)).

Prüfnachweis: `(cd services/api && ./mvnw test -Dtest=MispelMengenApiTest)` (Docker; Simulator-Anlage durch den echten
Monatslauf; hält `frontend/portal/e2e/mispel-mengen-fixtures.json` gleich der Antwort der Route, neu schreiben mit
`-Dmispel.fixtures.schreiben=true`) und `npx playwright test e2e/mispel-mengen.spec.ts` (375 und 1440 px).

## Werte des Messstellenbetreibers und Abgleich (MP-15)

Maßgeblich für Nachweis und Abrechnung sind die Werte des Messstellenbetreibers: „alle anderen umlage- und
förderrelevanten Strommengen [sind] viertelstundengenau mit mess- und eichrechtskonformen Messeinrichtungen zu
erfassen“ (Tenor S. 28, Abschn. 3.2.3.2.1; § 21 Abs. 4 S. 2 EnFG, § 85d S. 1 Nr. 1 EEG); nicht mess- und
eichrechtskonform erfasste Messwerte „scheidet [...] aus“ (ebd.). Bedienkonzept BK-15 Variante A (abgestimmt 02.10.2026).

- **Einlesen** an der Messstelle: `POST /api/v1/messstellen/{id}/msb-werte` (multipart `datei`, Recht
  `messstelle.bearbeiten`, `web/MessstelleMsbAbgleichController`) → `{importDatei, neu, zaehlpunkte, richtungen}`.
  Jede Zeile muss einen Zählpunkt nennen, den die Messstelle in einer Fassung ihrer [Zählerrolle](./mispel-zaehlerrolle.md)
  trägt (auch vor einem Zählerwechsel); beide Richtungen sind erlaubt (Z1 = zwei Messstellen, ein Zählpunkt).
  Ablehnungen `{code, message, …}`: `datei_ungueltig` (400, `grund`, `format` und `zeile` bei CSV bzw. `segment` bei
  MSCONS — 0 = die ganze Datei), `kein_zaehlpunkt` (422), `zaehlpunkt_fremd` (422, `zaehlpunkt`); fremde Messstelle 404.
  Dieselbe Datei (SHA-256) ist derselbe Import (`neu = false`). Das Format erkennt der Import an der Datei: beginnt sie
  (nach BOM und Leerraum) mit `UNA` oder `UNB`, ist sie MSCONS, sonst CSV; `importDatei.format` = `csv` | `mscons`.
  `uebergangen` zählt Mengen ohne wahren Wert (nur MSCONS, sonst 0).
- **Format heute: CSV** (`mispel/MsbWerteCsv`, rein): Kopfzeile `zeitstempel;zaehlpunkt;richtung;kwh` (Reihenfolge frei,
  `;` mit Dezimalkomma oder `,` mit Dezimalpunkt, `#`-Zeilen übersprungen); `zeitstempel` = Beginn der Viertelstunde mit
  Versatz (ISO 8601); `richtung` = `bezug`/`abgabe` oder OBIS `1-1:1.29.0`/`1-1:2.29.0`; `kwh` ≥ 0 je Viertelstunde.
  Nichts wird ergänzt: eine fehlende Viertelstunde bleibt fehlend.
- **Format MSCONS (MP-15b)** (`mispel/MsbWerteMscons`, rein): EDIFACT-Lastgang des Messstellenbetreibers nach EDI@Energy
  MSCONS MIG 2.5 / AHB 3.2 (verbindlich ab 01.10.2026, BNetzA BK6 Mitteilung Nr. 56 vom 01.04.2026) oder der Vorfassung
  2.4c (`UNH+…+MSCONS:D:04B:UN:2.5`); andere Nachrichtentypen und Versionen werden abgelehnt. Gelesen werden je
  `LOC+172` (Zählpunkt der Messlokation, 33 Zeichen; eine Marktlokations-ID wird abgelehnt) die Lastgänge `PIA+5`
  `1-1:1.29.0` (Bezug) und `1-1:2.29.0` (Abgabe); andere OBIS-Kennzahlen (z. B. Blindarbeit) werden übergangen. Je
  `QTY` die Menge in kWh (Einheit `KWH` oder keine; jede andere wird abgelehnt, nichts wird umgerechnet) mit `DTM+163`
  (Beginn) und `DTM+164` (Ende = Beginn + 15 min, sonst abgelehnt), Format 303 mit Versatz (BDEW: UTC, `?+00`) — die
  Tage der Zeitumstellung haben so 92 bzw. 100 Viertelstunden ohne Mehrdeutigkeit. **Nur der wahre Wert (`QTY+220`)**
  wird übernommen; Ersatz-, Vorschlags-, Prognose- und nicht verwendbare Werte bleiben eine Lücke (`uebergangen`), weil
  nur der gemessene Wert „mit mess- und eichrechtskonformen Messeinrichtungen“ erfasst ist (Tenor S. 28); ein späterer
  Import mit wahren Werten ersetzt die Lücke. `UNT`-Segmentzahl, `UNT`/`UNZ`-Referenzen und das abschließende `UNZ`
  werden geprüft (abgeschnittene Datei). Trennzeichen aus `UNA`, Freigabezeichen `?`, Zeichensatz UNOC.
  Die Umsetzung in der Marktkommunikation ist „nicht Regelungsgegenstand dieser Festlegung“ (Tenor S. 28; MaKo-Rahmen
  durch die BK6, S. 92) — CSV und MSCONS wählt VoltPilot; beide landen in derselben Ablage mit derselben Ampel.
- **Speicher** (`V20261003015500`, RLS + FORCE; `format` `csv` | `mscons` seit `V20261003051500`): `mispel_msb_import` (Datei, Messstelle, Prüfsumme, Zeitraum) und
  `mispel_msb_wert` je Zählpunkt, Richtung und Viertelstunde (Schlüssel) — nicht je Messstelle: ein Zählerwechsel bringt
  einen neuen Zählpunkt, die Werte des alten bleiben. Ein späterer Import ersetzt den Wert derselben Viertelstunde
  (`ersetzt` zählt sie); App nur SELECT/INSERT und UPDATE `(kwh, import_id)`.
- **Monatslauf:** liest für einen Zähler mit Wertequelle „Messstellenbetreiber“ die eingelesenen Werte seines
  Zählpunkts und seiner Richtung (Bezug/Laden = `bezug`, Abgabe/Entladen/Erzeugung = `abgabe`); liegt im Zeitraum keiner
  vor, liest er vom Gerät (Vorschau, `wertequelle_geraet` + `msb_werte_fehlen:<MS>`). Eine Viertelstunde ohne Wert des
  Messstellenbetreibers ist eine Lücke — nie mit Gerätewerten aufgefüllt. Werte des Messstellenbetreibers gelten als
  endgültige Viertelstunden.
- **Ampel** je Zähler, Richtung und Monat (`mispel/MsbAbgleichRegeln`, rein): Abweichung = (Gerät − Messstellenbetreiber)
  ÷ Messstellenbetreiber; |Abweichung| ≤ 2 % `gruen`, ≤ 5 % `gelb`, sonst `rot`; `grau` „nicht vergleichbar“ mit Grund
  `keine_msb_werte`, `keine_geraetewerte`, `zaehlerwechsel` (mehr als ein Zählpunkt bzw. andere Messstelle im Monat) oder
  `luecke` (eine Seite hat weniger Viertelstunden als der Monat) — `null` statt 0 für alles nicht Bestimmbare. **Die
  Festlegung nennt keine Schwellen:** 2 % / 5 % sind ein Vorschlag, einstellbar über
  `voltpilot.mispel.abgleich.gruen-bis-prozent` / `gelb-bis-prozent` (keine Oberfläche), im Pilot MP-47 zu bestätigen.
- **Wirkung** (`MispelMengenService.wirkung`, nur aus den Läufen): der erste geltende endgültige Lauf gegen seine vorige
  vorläufige Fassung — Farben (26)/(31)/(16)/grau vorher → nachher und Saldierung (vermiedene Umlagen + Netzentgelt auf
  (20), wie MP-18) vorher → nachher in €.
- **Routen zum Lesen:** `GET /api/v1/messstellen/{id}/msb-abgleich` (Recht `messstelle.ansehen`; je Monat ab 10/2026,
  neuester zuerst, höchstens 24: Gerät, Messstellenbetreiber, Unterschied, Ampel, Wirkung; Importe; Schwellen) und
  `GET /api/v1/sites/{siteId}/mispel/abgrenzung/monate/{JJJJ-MM}/abgleich` (Leseweg der Anlage, fremd 404,
  `zeitraum_ungueltig` 400; die Zählrichtungen Z1NB, Z1NE, Z2V, Z2E (Z3V, Z3E) am Monatsersten, `groessteAbweichung`,
  `wirkung`, `schwellen`).
- **Portal:** `components/erloese/MsbAbgleich.tsx` über `mispelAbgleich.ts` (nur Formatierung): in der Monatskarte
  (MP-18) ein Satz mit der größten Abweichung und ihrer Wirkung, „Abgleich ansehen ›“ öffnet das Blatt „Abgleich“ mit
  den Zählrichtungen; an der Messstelle die Tabelle je Monat und „Werte des Messstellenbetreibers einlesen“. Kein neuer
  Reiter. Ohne Werte des Messstellenbetreibers im Monat schweigt die Karte.

Prüfnachweis: `(cd services/api && ./mvnw test -Dtest='MsbAbgleichRegelnTest,MsbWerteMsconsTest,MsbAbgleichApiTest')`
(Docker; ein realistischer Monat im Format des Messstellenbetreibers — Dezember 2026, 2 976 Viertelstunden je Richtung,
mit Lücke und Zählerwechsel, als CSV und als MSCONS mit Ersatzwerten —, ein November mit bekannten Abweichungen, der aus
CSV und MSCONS dieselbe Ampel ergibt, und die Tage der Zeitumstellung 25.10.2026 mit 100 und 28.03.2027 mit 92
Viertelstunden, in UTC und in Ortszeit) und `npx playwright test e2e/msb-abgleich.spec.ts` (375 und 1440 px). **Offen
bis zum Pilot (MP-47):** der Import eines echten MSB-Monats (CSV oder MSCONS), ob Ersatzwerte (`QTY+67`) als Werte des
Messstellenbetreibers gelten dürfen, und die Bestätigung der Schwellen.

## Was die Leser prüfen (L1–L10)

Beide Leser prüfen dieselbe Liste; ein Fall, den nur einer anmahnt, ist ein Fehler im anderen.

1. **L1 Schema** — Java über `uems/UemsSchemaLaeufer`, Python über `jsonschema` (Draft 2020-12).
2. **L2 Katalog** — jede Formelnummer einmal; A1 trägt (1) bis (33) außer (7)A4/(8)A4, A4 jede, A2 und A3 alle
   außer (7), (8), (17), (18); zusammen mit `nicht_im_umfang` ist (1)–(33) vollständig; Formelsatz und Formel nennen einander in beide Richtungen;
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
9. **L9 Rumpfmonate** — jeder Erkennungsfall ergibt in beiden Zwillingen genau die erwarteten Rumpfmonate und
   Änderungen (oder die Ablehnung); nennt er einen `rechenfall`, sind seine Rumpfmonate genau dessen `zeitraeume`.
   Java `MispelRumpfmonateTest`, Python `test_mispel_abgrenzung_rechenwerk.py::test_l9_rumpfmonate_wie_vektoren`.
10. **L10 Konstanten** — eine Formel mit `konstante` ((14)A2,A3,A4 = 0,85, (19)A2,A3 = 0; A1 S. 35, S. 37) trägt
   genau diesen Wert in jedem Monat.

Prüfnachweis (ohne Docker):
`(cd services/api && ./mvnw test -Dtest=MispelAbgrenzungVectorsTest)` (JDK 21) und
`(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_mispel_abgrenzung_vectors.py tests/test_mispel_abgrenzung_rechenwerk.py -q)`.

## Beim Ändern

Eine geänderte Formel, ein neuer Fall oder eine neue Lesart ändert die Vektor-Datei, das Schema und beide
Leser zusammen; jede Abweichung von Anlage 1 bekommt einen Eintrag in `abweichungen` mit Fundstelle. Alle
Leser finden: `rg -l "mispel-abgrenzung" services frontend` — ab MP-8/MP-9 gehören die Rechenwerk-Tests
dazu. Erwartete Werte werden gerechnet, nicht abgeschrieben; wer einen Fall von Hand ändert, rechnet ihn
in beiden Zwillingen nach.
