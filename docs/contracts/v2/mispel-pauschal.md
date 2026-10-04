# MiSpeL-Pauschaloption: Formelsätze P1 bis P5

Vertrag zu Anlage 2 („Pauschaloption“) der Festlegung zur Marktintegration von Speichern und
Ladepunkten (MiSpeL, Az. 618-25-02, Beschluss vom 01.10.2026). Bau-Paket MP-24 der Stufe 2.

> **Erst ab der EU-Genehmigung anwendbar.** Die Pauschaloption (Tenorziffern 2 und 4) gilt frühestens für
> Netzeinspeisung ab dem ersten Kalendertag des Kalendermonats, der auf die beihilferechtliche Genehmigung
> der Europäischen Kommission zu § 19 Abs. 3c EEG folgt (T S. 3, Tenorziffer 9 b; A2 S. 20, Voraussetzung 10;
> § 101 Abs. 1 EEG). Der Termin ist offen. Bis dahin ist dieser Vertrag Vorbau (E7 = B): Rechenwerk,
> Optimierer und Simulation dürfen ihn lesen, kein Kunde wird danach abgerechnet.

- **[`mispel-pauschal-vectors.json`](./mispel-pauschal-vectors.json)** — die Wahrheit: Formelkatalog (Nummer,
  Begriff und Rechenweg **wörtlich** aus Anlage 2, Fundstelle je Formel), die sechs Formelsätze, Regeln,
  Lesarten, 14 Rechenfälle und die 49 Zellen der Tabellen 1 und 2, jeder Fall und jede Zelle mit Fundstelle.
  Wo dieser Text und die Datei sich widersprechen, gilt die Datei — und dann ist einer von beiden falsch.
- **[`mispel-pauschal.schema.json`](./mispel-pauschal.schema.json)** — Schema der Datei.
- **Leser im Gleichlauf** (beide per Pfad, beide prüfen L1–L10 unten):
  Java `services/api/src/test/java/com/voltpilot/api/mispel/MispelPauschalVectorsTest.java`,
  Python `services/optimization/tests/test_mispel_pauschal_vectors.py`.
- **Rechenwerk (MP-25):** Java `services/api/src/main/java/com/voltpilot/api/mispel/MispelPauschalRechenwerk.java`
  und Python `services/optimization/voltpilot_optimization/mispel_pauschal.py` rechnen jeden Fall und jede Zelle
  exakt nach; der Jahreslauf `MispelPauschalService.jahreslauf` speichert Ergebnis und Nachweis
  ([unten](#rechenwerk-und-jahreslauf-mp-25)). MP-26 (Optimierer-Jahreszustand) und MP-29 (Haushalts-Check) lesen es.

Zitierweise: „A2 S. 30“ = Anlage 2, Seite 30; „T S. 67“ = Tenor mit Begründung, Seite 67; „A1 S. 98“ = Anlage 1,
Seite 98. Die Festlegung hat keine Randnummern.

## Umfang

| Formelsatz | Fallkonstellation (Anlage 2) | Zähler | Eingänge je Viertelstunde | Stammdaten | Fundstelle |
|---|---|---|---|---|---|
| P1 | Basisfall P1: „Stromspeicher“ | Z1 | Z1NB¼, Z1NE¼, AW¼, SP¼ | Pinst, SKinst | S. 25–33 |
| P2 | Basisfall P2: „Ladepunkt“ | Z1 | wie P1 | Pinst | S. 26–33 |
| P3 | Basisfall P3: „Stromspeicher und Ladepunkt“ | Z1 | wie P1 | Pinst, SKinst | S. 26–33 |
| P4 | Sonderfall P4: Mehrere Solaranlagen (Abwandlung zu P1) | Z1 | Z1NB¼, Z1NE¼, AWa¼, AWb¼, SP¼ | Pinst, SKinst, Painst, Pbinst | S. 34–40 |
| P4-Variante | vereinfachtes Vorgehen bei jederzeit übereinstimmenden AW>0-Zeiten | Z1 | wie P4 | wie P4 | S. 41–42 |
| P5 | Sonderfall P5: separate Stromlieferung für eine Wärmepumpe (Abwandlung zu P1) | Z1, ZW | Z1NB¼, ZWNE¼, AW¼, SP¼ | Pinst, SKinst | S. 42–46 |

Dazu die Rumpfjahr-Formeln (P17) bis (P4)R (Abschn. 9, S. 51–56), die in jedem Formelsatz gelten, sobald eine
bestimmungsrelevante Änderung das Kalenderjahr teilt, und die Umlagesaldierung bei ausschließlich ungeförderten
Solaranlagen (Abschn. 8, S. 48–51) als entsprechende Anwendung mit (P12)¼ = 1.

**Nicht in diesem Vertrag** (je mit Grund unter `nicht_im_umfang`): unterschiedlich umlagepflichtige
Netzbezugsmengen (Abschn. 7 — keine eigenen Formeln, Verweis auf Anlage 1 Abschn. 9); der Wärmepumpen-Netzbezug
∑J [ZWNB¼ – Z1NB¼] (Fn. 33, § 22 EnFG — keine Formel der Festlegung); P4, P4-Variante und P5 in Abwandlung zu
P2/P3 (Anlage 2 zeigt nur P1, Regel `abwandlungen`); die Voraussetzungen der Pauschaloption (Abschn. 3.1:
≤ 30 kWp ohne Steckersolar, nur Solaranlagen, ein Betreiber, nur Direktvermarktung, Jahresmarktwert — Sache von
Förderweg MP-5, Einrichtung MP-27 und Rechenwerk MP-25). Sind Messwerte für einen A-Formelsatz vorhanden, ist die
Pauschaloption ausgeschlossen (A2 S. 22, Abschn. 3.2.3) — dann gilt [Anlage 1](./mispel-abgrenzung.md).

## Eingänge, Einheiten, Vorzeichen

Alle Zählerwerte sind **Strommengen je Viertelstunde in kWh** (keine Leistung) und nie negativ: der
Zweirichtungszähler Z1 am Netzanschluss trennt Netzbezug Z1NB¼ und Netzeinspeisung Z1NE¼ (S. 27). In P5 wird die
Netzeinspeisung am Zähler ZW gemessen (ZWNE¼), der saldierungsrelevante Netzbezug weiter an Z1 (S. 45–46). AW¼ ist
der anzulegende Wert in ct/kWh, ausgewertet wird nur „> 0“ ((P12)¼); SP¼ ist der Spotmarktpreis nach § 3 Nr. 42a
EEG in ct/kWh, **darf negativ sein**, ausgewertet wird nur „≥ 0“ ((P5)¼). Pinst ist die installierte Leistung
**aller** Solaranlagen hinter der Einspeisestelle in kWp, einschließlich ungeförderter und der Solaranlagen in
Steckersolargeräten (S. 27) — für die 30-kWp-Schwelle zählen Steckersolargeräte dagegen nicht (S. 19, S. 35).
SKinst ist die installierte Kapazität aller Stromspeicher in kWh, **ohne** Ladepunkte (S. 27). Painst/Pbinst sind
Leistungen nach § 24 Abs. 3 S. 2 Halbsatz 2 EEG (S. 36). Formelwerte sind kWh je Kalenderjahr bzw. Rumpfjahr;
ohne Einheit sind die Rechengrößen (P2)P1/(P2)P2/(P2)P3 und die Faktoren (ZFa)/(ZFb); (P17), (P19)R, (P20),
(P22)R sind Tage.

**Woher die Eingänge im Bestand kommen** (für MP-25): AW>0 aus der ÜNB-Liste `eeg_aw_zeit` mit der AW-Regel der
Einspeisestelle `site_foerderweg.aw_regel`, SP¼ aus `day_ahead_prices` DE-LU, beides nur über
`MispelMarktdatenRepository` (MP-7, [Wegweiser](../../agents/root/mispel-marktdaten-aw-sp-jahresmarktwert.md));
fehlend ist unbekannt, nie 0. Für P4 mit zwei geförderten Anlagen gilt derselbe offene Punkt wie für A5: `aw_regel`
ist die Regel der Anlage a, AWb¼ gibt der Aufrufer vor ([Förderweg § 7](./mispel-foerderweg.md#7-die-aw-differenzierung-fassung-11-mp-12b)).
Z1NB¼/Z1NE¼ liest die Zählerrolle Z1 ([MP-6](./mispel-zaehlerrolle.md)); eine Rolle ZW für P5 gibt es dort noch nicht.

**Ein Zähler sieht keinen Fremdtankstrom:** mitgebrachter Fahrzeugstrom, der am Ladepunkt eingespeist wird, ist in
der Pauschaloption „nicht (auch nicht anteilig)“ erkennbar und wird nicht abgezogen (A2 S. 11, Fn. 10). Es gibt keine
Verlustprivilegierung (A2 S. 8, Fn. 5) und **keinen Monatsbezug** — die BNetzA lehnt eine monatliche Saldierung
ausdrücklich ab (T S. 63).

## Die Formeln

Nummer, Rechenweg und Begriff wörtlich aus Anlage 2. „(P2)“ in (P3) ist je Fallkonstellation (P2)P1, (P2)P2 oder
(P2)P3 (S. 30).

| Nr. | Rechenweg | Begriff | Formelsätze | Seite |
|---|---|---|---|---|
| (P1) | `Pinst • 500 kWh/kW` | Pauschalgrenze der Förderfähigkeit im Kalenderjahr | alle | S. 28 |
| (P2)P1 | `0,1 kWh/kW • Pinst / SKinst` | Rechengröße zum Größenverhältnis zwischen Solarleistung und Speicherkapazität in der Fallkonstellation P1 (Stromspeicher) | P1, P3, P4, P4-Var., P5 | S. 28–29 |
| (P2)P2 | `0,2` | Rechengröße in der Fallkonstellation P2 (Ladepunkt) | P2, P3 | S. 29 |
| (P2)P3 | `MIN [ (P2)P1 ; (P2)P2 ]` | Rechengröße in der Fallkonstellation P3 (Stromspeicher und Ladepunkt) | P3 | S. 29 |
| (P3) | `(P2) • (P1)` | Indifferenzbereich im Kalenderjahr | alle | S. 30 |
| (P4) | `(P1) + (P3)` | Pauschalgrenze der Saldierungsfähigkeit im Kalenderjahr | alle | S. 30 |
| (P5)¼ | `WENN [ SP¼ ≥ 0 ; 1 ; 0 ]` | SP≥0-Zeiten | alle | S. 30 |
| (P6)¼ | `(P5)¼ • Z1NE¼` | Viertelstundenwert der Netzeinspeisung in SP≥0-Zeiten | außer P5 | S. 30 |
| (P7) | `∑J (P6)¼` | Netzeinspeisung in SP≥0-Zeiten im Kalenderjahr | alle | S. 30 |
| (P8) | `MAX [ (P7) – (P4) ; 0 ]` | Grundsätzlich saldierungsfähige Netzeinspeisung in SP≥0-Zeiten im Kalenderjahr | alle | S. 30 |
| (P9) | `∑J Z1NB¼` | Gesamter Netzbezug im Kalenderjahr | alle | S. 31 |
| (P10) | `MIN [ (P8) ; (P9) ]` | Saldierungsfähige Netzeinspeisung im Kalenderjahr | alle | S. 31, S. 32 |
| (P11) | `(P9) – (P10)` | Umlagebelasteter Netzbezug im Kalenderjahr | alle | S. 31, S. 32 |
| (P12)¼ | `WENN [ AW¼ > 0 ; 1 ; 0 ]` | AW>0-Zeiten | außer P4 | S. 31 |
| (P13)¼ | `(P12)¼ • Z1NE¼` | Viertelstundenwert der Netzeinspeisung in AW>0-Zeiten | P1–P3, P4-Var. | S. 31 |
| (P14) | `∑J (P13)¼` | Netzeinspeisung in AW>0-Zeiten im Kalenderjahr | außer P4 | S. 31 |
| (P15) | `MIN [ (P14) ; (P1) ]` | Förderfähige Netzeinspeisung im Kalenderjahr | außer P4 | S. 32–33 |

**P4** übernimmt (P1) bis (P11) — (P1) dann für die Summe der Solaranlagen (S. 36) — und bestimmt die Förderseite
je Anlage statt (P12)¼ bis (P15) (S. 39): (ZFa) = `Painst / (Painst + Pbinst)` „Zuordnungs-Faktor der Solaranlage a“,
(P12a)¼ = `WENN [ AWa¼ > 0 ; 1 ; 0 ]` „AWa>0-Zeiten“, (P13a)¼ = `(P12a)¼ • Z1NE¼`, (P14a) = `∑J (P13a)¼`,
(P15a) = `MIN [ (P14a) ; (P1) ]` „Grundsätzlich förderfähige Netzeinspeisung in AWa>0-Zeiten im Kalenderjahr“,
(P16a) = `(ZFa) • (P15a)` „Förderfähige Netzeinspeisung in Bezug auf Solaranlage a in AWa>0-Zeiten im
Kalenderjahr“; ebenso für b (S. 36–38). **P4-Variante** rechnet (P12)¼ bis (P15) für beide Anlagen gemeinsam und
teilt erst am Ende: (P16a)P4-Variante = `(ZFa) • (P15)` (S. 41); sie stellt weder besser noch schlechter (S. 39).
**P5** ersetzt nur zwei Formeln: (P6)¼ P5 = `(P5)¼ • ZWNE¼` und (P13)¼ P5 = `(P12)¼ • ZWNE¼` (S. 46); im Katalog
tragen sie `ersetzt`, und (P7)/(P14) summieren in P5 die ersetzende Formel.

**Rumpfjahr** (Abschn. 9.1–9.2, S. 53–55):

| Nr. | Rechenweg | Begriff | Seite |
|---|---|---|---|
| (P17) | `ANZAHL [ TS ] = 183` | Anzahl der Tage der Sommerperiode | S. 54 |
| (P18) | `(P1) / (P17)` | Tagesproportionale Teilmenge der Pauschalgrenze der Förderfähigkeit je Tag der Sommerperiode | S. 54 |
| (P19)R | `ANZAHL [ TRS ]` | Anzahl der Tage des Rumpfjahres in der Sommerperiode | S. 54 |
| (P1)R | `(P19)R • (P18)` | Pauschalgrenze der Förderfähigkeit des Rumpfjahrs | S. 54 |
| (P20) | `ANZAHL [ TK ]` | Anzahl der Tage des Kalenderjahres | S. 54 |
| (P21) | `(P3) / (P20)` | Tagesproportionale Teilmenge des Indifferenzbereichs je Tag des Kalenderjahres | S. 55 |
| (P22)R | `ANZAHL [ TR ]` | Anzahl der Tage des Rumpfjahres | S. 55 |
| (P3)R | `(P22)R • (P21)` | Indifferenzbereich des Rumpfjahres | S. 55 |
| (P4)R | `(P1)R + (P3)R` | Pauschalgrenze der Saldierungsfähigkeit des Rumpfjahres | S. 55 |

Die Förder-Pauschalgrenze verteilt sich **nur über die Sommerperiode April bis September** (183 Tage), der
Indifferenzbereich über alle Tage des Kalenderjahres (365/366) — ein Rumpfjahr Januar bis März hat also (P1)R = 0
(T S. 88–89).

**Farben** (A2 S. 16, Abschn. 2.3): grün = förderfähige Einspeisung direkt aus der Solaranlage; gelb = EE-Strom im
Speicher/Ladepunkt und förderfähige EE-Speichererzeugung; rot = Netzstrom im Speicher/Ladepunkt und saldierungsfähige
Netzeinspeisung. In der Pauschaloption sind grün und gelb nicht trennbar — (P15) ist ihre gemeinsame Menge (S. 33).

## Was eine Jahreseinspeisung wird

Die gesamte Netzeinspeisung eines Kalenderjahres wird pauschal in drei Teilmengen eingeordnet (A2 S. 9–10,
Abb. 1): bis (P1) **grundsätzlich förderfähig**, zwischen (P1) und (P4) **indifferent** (weder gefördert noch
saldiert), über (P4) **grundsätzlich saldierungsfähig** — saldiert aber nur Einspeisung in SP≥0-Zeiten und höchstens
bis zum Jahres-Netzbezug (P10). Je kleiner der Speicher im Verhältnis zur Solarleistung, desto breiter der
Indifferenzbereich (S. 11). Für den Optimierer (MP-26) heißt das: der Wert der nächsten eingespeisten kWh hängt am
Jahresstand — unter (P1) die Marktprämie, zwischen (P1) und (P4) nichts, darüber in SP≥0-Zeiten die Gutschrift bis
zum Jahres-Netzbezug, ohne Verlustprivilegierung (S. 8 Fn. 5). Gebaut in `solver._add_jahreszustand` mit dem jüngsten
Jahreslauf als Eingang ([Wegweiser](../../agents/root/mispel-optimierer-mischbetrieb.md#pauschaloption-jahreszustand-mp-26)).

## Regeln, die Anlage 2 offenlässt, und Lesarten

Jede steht mit Grund und Fundstelle in `regeln` bzw. `abweichungen` der Vektor-Datei.

- **zeit** — Eine Viertelstunde gehört zu dem Kalendertag und Kalenderjahr, an dem sie nach gesetzlicher Zeit
  (Europe/Berlin) beginnt; `beginn` trägt immer den Versatz, nie „Z“ (Fall `p1-jahresgrenze-in-ortszeit`).
- **rumpfjahre** — Der Tag der Änderung zählt zum Rumpfjahr **davor** (S. 53, TR); Rumpfjahre sind ganze
  Kalendertage, `von` und `bis` **einschließlich**, Schlüssel `von/bis`. Je Rumpfjahr gelten seine Stammdaten;
  (P1) bis (P4) werden damit für das ganze Kalenderjahr bestimmt und gehen nur über (P18)/(P21) ein; in (P8) tritt
  (P4)R an die Stelle von (P4), in (P15), (P15a), (P15b) tritt (P1)R an die Stelle von (P1) (S. 51: „Das jeweilige
  Rumpfjahr tritt … an die Stelle des Kalenderjahres“; S. 53: (P1)R, (P3)R, (P4)R werden „parallel, aber mit
  abweichendem Inhalt verwendet“). Achtung beim Lesen aus Änderungsprotokollen: der Abgrenzungs-Vertrag beginnt den
  neuen Rumpfmonat an dem Tag, ab dem der neue Stand gilt (Lesart, Anlage 1 nennt keine Zeiteinheit,
  [Abgrenzung](./mispel-abgrenzung.md#rumpfmonate-erkennen-mp-21)); in der Pauschaloption zählt der Änderungstag
  wörtlich noch zum alten Rumpfjahr, die neuen Stammdaten gelten ab dem Folgetag.
- **ungefoerdert** — Für eine ungeförderte Solaranlage entfällt ihr AW-Eingang (Feld `ungefoerdert` des Falls);
  die zugehörige (P12)¼/(P12a)¼/(P12b)¼ ist in jeder Viertelstunde 1, ein so bestimmter Wert hat keinen
  Förderanspruch (S. 40, S. 50).
- **Lesart (P2)P1/(P2)P2 in P3** — Formeln mit Index P1/P2/P3 „gelten ausschließlich in der jeweiligen
  Fallkonstellation“ (S. 28), (P2)P3 braucht aber beide Werte (S. 29). Der Formelsatz P3 führt sie als
  Vergleichswerte mit; in (P3) geht nur (P2)P3 ein.
- **Lesart AW¼ in der P4-Variante** — Die Variante liest AWa¼ und AWb¼, die Leser prüfen „jederzeit
  übereinstimmende AW>0-Zeiten“ (S. 41), (P12)¼ wertet AWa¼ aus.
- **Lesart Pinst in P4** — Pinst = Painst + Pbinst (S. 36), von den Lesern geprüft.
- **Lesart Rundung** — Anlage 2 rundet nur „zur vereinfachten Darstellung“ (S. 12, S. 56). Die Vektoren sind exakt;
  jede BNetzA-Zahl ist der kaufmännisch gerundete exakte Wert (15 kWp / 4 kWh: exakt 10 312,5, gedruckt „10.313“).
- **vergleich** — Vektor-Zahlen sind exakt: Dezimalzahl, wo endlich, sonst gekürzter Bruch als Text `Zähler/Nenner`
  (etwa (ZFa) = `10/11`, (P18) = `4000/183`) — genau die Form von `Bruch.text()` aus dem Abgrenzungs-Nachweis. Leser
  vergleichen exakt (Java `mispel/Bruch`, Python `Fraction`).
- **viertelstunden_ohne_fluss** / **viertelstunden_buendeln** — Die Fälle führen nur Viertelstunden mit Fluss und
  bündeln Jahresmengen in wenige Viertelstunden (mehr, als eine Anlage dieser Größe physikalisch liefert). Keine
  Lückenregel: im Rechenwerk ist eine fehlende Viertelstunde eine Lücke, nie eine Null (MP-25).
- **Begriff (P1)R** — S. 54 „des Rumpfjahrs“, S. 56 „des Rumpfjahres“; der Katalog folgt der Formel (S. 54).

## Fälle

| Fall | Formelsatz | zeigt | Fundstelle |
|---|---|---|---|
| `bnetza-beispielrechnung-1-geringe-einspeisung` | P1 | 8 kWp / 10 kWh → 4 000 / 320 / 4 320 kWh; 3 000 kWh Einspeisung ganz förderfähig, (P10) = 0 | A2 S. 13, Abschn. 2.1.6, Beispielrechnung 1 (Abb. 2) |
| `bnetza-beispielrechnung-2-hohe-einspeisung` | P1 | 6 000 kWh Einspeisung, 1 500 kWh Bezug: 4 000 förderfähig, 320 indifferent, (P8) = 1 680, (P10) = 1 500, (P11) = 0 | A2 S. 14, Abschn. 2.1.6, Beispielrechnung 2 (Abb. 3) |
| `p1-sp-und-aw-zeiten` | P1 | SP¼ = 0 zählt, SP¼ < 0 bei AW¼ > 0 nicht saldierungsfähig, aber förderfähig; (P10) durch (P8) begrenzt | A2 S. 14–15, Abschn. 2.1.7–2.1.8; S. 30–32 |
| `p2-ladepunkt-rechengroesse-0-2` | P2 | (P2)P2 = 0,2 → (P3) = 800; gleiche Mengen wie Beispielrechnung 2: (P10) = 1 200 statt 1 500 | A2 S. 29; T S. 67 (0,5 → 0,2) |
| `p3-speicher-und-ladepunkt-guenstigere-rechengroesse` | P3 | 30 kWp / 4 kWh + Ladepunkt: MIN [ 0,75 ; 0,2 ] → (P4) = 18 000 statt 26 250 | A2 S. 29; S. 12 |
| `p4-zwei-solaranlagen-unterschiedliche-aw` | P4 | AWa¼ > 0 bei AWb¼ = 0: (P16a) = 3 680, (P16b) = 800 | A2 S. 34–40 |
| `p4-uebereinstimmende-aw` | P4 | gleiche AW>0-Zeiten: (P16a) = 4 000, (P16b) = 1 000 | A2 S. 38–39 |
| `p4-variante-uebereinstimmende-aw` | P4-Variante | dieselben Eingänge: (P16a)P4-Variante = 4 000, (P16b)P4-Variante = 1 000 | A2 S. 41–42 |
| `p4-steckersolar-ungefoerdert` | P4 | Hausdach 8 kWp gefördert + Steckersolar 0,8 kWp ungefördert: Pinst = 8,8, (P12b)¼ = 1, (ZFa) = 10/11 | A2 S. 40; S. 27; S. 19, S. 35 |
| `p5-waermepumpe-separat` | P5 | Einspeisung an ZW, Bezug an Z1: (P10) = 300, (P11) = 700 | A2 S. 42–46 |
| `p1-ausschliesslich-ungefoerdert` | P1 | nur ungeförderte Solaranlage: (P12)¼ = 1, (P10) = 500; (P15) ohne Förderanspruch | A2 S. 48–51, Abschn. 8 |
| `bnetza-rumpfjahre-zweiter-speicher-am-16-mai` | P1 | zweiter Speicher am 16. Mai: 136/46 und 229/137 Tage, (P1)R ≈ 1 005 / 2 995, (P3)R ≈ 119 / 134, (P4)R ≈ 1 125 / 3 128; Tagesgrenze in gesetzlicher Zeit | A2 S. 55–56, Abschn. 9.3 |
| `p1-jahresgrenze-in-ortszeit` | P1 | Jahreswechsel in MEZ statt UTC; jedes Jahr für sich, kein Übertrag | A2 S. 28; T S. 63 |
| `p1-rumpfjahre-sommerperiode-tagesscharf-schaltjahr` | P1 | MP-25: drei Rumpfjahre 2028 (Änderungen am 31.03. und 30.09.): 91/0, 183/183 und 92/0 Tage, (P20) = 366; (P1)R = 0 / 5 000 / 0 — Winter-Einspeisung in AW>0-Zeiten ist nicht förderfähig, (P3)R ≈ 124 / 167 / 251 je Rumpfjahr; Tagesgrenzen in MESZ | A2 S. 53–55, Abschn. 9.1–9.2; T S. 88–89 |

**Tabelle 1 und 2** (A2 S. 12): `pauschalgrenzen` trägt alle 49 Zellen (Pinst 1/4/6/8/10/15/30 kWp × SKinst
45/30/15/10/8/6/4 kWh) mit exaktem (P1), (P2)P1, (P3), (P4) und den gedruckten Werten — Tabelle 1 absolut (kWh/a),
Tabelle 2 je kWp (kWh/kWp). Die Ladepunkt-Rechengröße 0,2 belegen die Fälle `p2-…` und `p3-…`.

## Rechenwerk und Jahreslauf (MP-25)

Zwei Rechenwerke im Gleichlauf, Stufe für Stufe gleich: Viertelstunde ((P5)¼, (P6)¼, (P12…)¼, (P13…)¼) → ∑J über
das (Rumpf-)Jahr → Jahreswerte; ungerundet mit `Bruch` bzw. `Fraction`, Katalog-Reihenfolge wie die Vektor-Datei. Die
Rechnung summiert genau die übergebenen Viertelstunden — ob ein Jahr vollständig ist, entscheidet der Jahreslauf.

| Stelle | Java `MispelPauschalRechenwerk` | Python `mispel_pauschal` |
|---|---|---|
| Lauf | `rechne(formelsatz, viertelstunden, stammdaten, rumpfjahre, ungefoerdert[, basisfall])` | `rechne(formelsatz, viertelstunden, stammdaten=, rumpfjahre=, ungefoerdert=, basisfall=)` |
| AW¼ | Wahrheitswert „AW¼ > 0“ (mehr liefert die ÜNB-Liste nicht) | Zahl, ausgewertet nur „> 0“ |
| SP¼ | Preis in ct/kWh, ausgewertet nur „≥ 0“ | ebenso |
| Rumpfjahr | `Rumpfjahr(von, bis, stammdaten)`, Tage einschließlich | `Rumpfjahr(von, bis, stammdaten)` |
| Tage | `sommertage(von, bis)` = ANZAHL [ TRS ]; (P20) aus dem Kalenderjahr | `sommertage(von, bis)` |

Beide lehnen ab, statt zu raten: fehlender Eingang (unbekannt ist keine Null), negativer Zählerwert, fremder Eingang,
Viertelstunde außerhalb des Rasters, doppelt oder in keinem Rumpfjahr, überlappende oder jahresübergreifende
Rumpfjahre, SKinst = 0, Pinst ≠ Painst + Pbinst (P4/P4-Variante), auseinanderlaufende AW>0-Zeiten in der P4-Variante
(A2 S. 41). **Regel `abwandlungen`:** P4, P4-Variante und P5 rechnen mit `basisfall` P2 oder P3 deren Rechengröße
((P2)P2 bzw. (P2)P1, (P2)P2, (P2)P3 statt (P2)P1; in Abwandlung zu P2 ohne SKinst, A2 S. 27) — Anlage 2 zeigt nur
die P1-Abwandlung (A2 S. 34, S. 43, S. 49), darum ohne eigenen Vektorfall, geprüft gegen den Basisfall selbst.

**Jahreslauf** `MispelPauschalService.jahreslauf(anlage, jahr, Vorgaben)` (Muster des Monatslaufs der
[Abgrenzung](./mispel-abgrenzung.md#monatslauf-und-nachweis-mp-8)) — je Lauf ein Kalenderjahr oder ein vorgegebenes
Rumpfjahr `[rumpfVon, rumpfBis]`:

- **Förderweg** ([MP-5](./mispel-foerderweg.md)) an jedem Tag „Marktprämie mit Pauschaloption“ (geprüft am ersten Tag
  und an jedem Beginn einer Fassung), sonst `foerderweg_nicht_pauschal`; die AW-Regel der Fassung (MP-12b) gilt für
  AW¼/AWa¼, AWb¼ gibt der Aufrufer vor. Ohne AW-Regel rechnet der Lauf mit dem Rückfall „AW¼ = 0 bei SP¼ < 0“ und
  bleibt vorläufig (`aw_regel_fehlt`, `aw_rueckfall`; Bauplan W4). Wechselt die AW-Regel im Zeitraum:
  `aw_regel_wechselt`.
- **Zähler** Z1NB/Z1NE aus der Zählerrolle Z1 ([MP-6](./mispel-zaehlerrolle.md)) — ein Zähler genügt (A2 S. 27). Trägt
  die Anlage am ersten oder letzten Tag Z2/Z3, lehnt der Lauf ab (`messkonzept_anlage_1`): „Keine vereinfachte
  pauschale Bestimmung nach Anlage 2 bei Messwerten für die genauere Bestimmung nach Anlage 1“ (A2 S. 22, Abschn.
  3.2.3). P5 braucht ZW (A2 S. 45–46); diese Rolle gibt es noch nicht (`zaehler_fehlt`).
- **SP¼** DE-LU und **AW¼ > 0** nur über `MispelMarktdatenRepository` (MP-7); fehlt eins davon oder ein Zählerwert,
  ist die Viertelstunde eine Lücke — sie bleibt draußen und steht im Nachweis.
- **Stand** wie MP-8 (E4 = C): `endgueltig` nur mit Werten des Messstellenbetreibers, tauglichem Zähler, ohne Lücke,
  endgültigen Viertelstunden, ÜNB-AW, vorbeigegangenem Zeitraum — und erst, wenn die Pauschaloption gilt
  (`voltpilot.mispel.pauschaloption-ab` gesetzt und erreicht, T S. 3 Ziff. 9 b); sonst `vorlaeufig` mit
  `eu_genehmigung_ausstehend` (Vorbau E7 = B: gerechnet wird trotzdem).
- **Gespeichert** in `mispel_pauschal_jahr` (`V20261002191500`, RLS + FORCE, App-Rolle nur SELECT/INSERT): Fassungen
  je Anlage und `tag_von`, Nachweis als kanonischer JSON-**Text** + SHA-256 (nie `jsonb`), gleiche Prüfsumme schreibt
  nichts. Der Nachweis trägt je Viertelstunde eine Zeile in der Folge von `spalten` (Eingänge, „AW¼ > 0“, SP¼, ¼-Formeln)
  — ein Jahr hat bis 35 136 Viertelstunden.

**Lesart Rumpfjahr-Grenzen:** Formelsatz, Stammdaten und Rumpfjahr gibt heute der Aufrufer vor (die Förderweg-Fassung
kennt nur A-Formelsätze). Bei einer Änderung innerhalb der Pauschaloption zählt der Änderungstag zum Rumpfjahr davor
(A2 S. 53, TR). Wechselt die Zuordnung zur Pauschaloption „zum ersten Kalendertag eines Kalendermonats“ (A2 S. 52,
Fn. 40; Tenorziffer 5), beginnt das Rumpfjahr der Pauschaloption an diesem Monatsersten — an diesem Tag gilt die neue
Veräußerungsform bereits; der Lauf prüft genau das am Förderweg. Eine Erkennung der Rumpfjahre aus Fallständen (wie
MP-21 für Rumpfmonate) folgt mit Einrichtung und Portal (MP-27).

## Jahresstand für das Portal (MP-27)

`GET /api/v1/sites/{siteId}/mispel/pauschal/jahre/{jahr}` (Leseweg der Anlage, `messwerte.ansehen`, fremd 404;
`SiteMispelPauschalController`) → `{site_id, jahr, anwendbar_ab, staende[], schaetzung}`. Je (Rumpf-)Jahr des
Kalenderjahres die **jüngste Fassung** aus `mispel_pauschal_jahr` (`MispelPauschalRepository#jahresstaende`): `tag_von`,
`tag_bis`, `rumpfjahr`, `fassung`, `formelsatz`, `basisfall`, `stand`, `stand_gruende`, `wertequelle`,
`viertelstunden_erwartet/_gerechnet`, `gerechnet_am`, `stammdaten` und `jahreswerte` des Schlüssels — ohne die
Viertelstunden des Nachweises. Die Werte des Nachweises sind ungerundete Brüche; die Route rundet sie **nur zur Anzeige**
auf drei Nachkommastellen (der Nachweis bleibt ungerundet). Ein Jahr ohne Lauf hat leere `staende` (keine Karte).
`schaetzung` ist immer `null`: eine Schätzung bis Jahresende braucht ein Jahresprofil, das der Jahreszustand (MP-26)
noch nicht hat — hochgerechnet mit dem bisherigen Tempo wird nicht (Bedienkonzept BK-27).

**Lesart „wo das Jahr steht“** (Portal `mispelPauschal.ts#jahresstand`, Karte „MiSpeL · Jahresstand nach Anlage 2“ in
Verlauf › Erlöse): förderfähig zählt die Netzeinspeisung in AW>0-Zeiten bis (P1) — (P15) = MIN [ (P14) ; (P1) ];
saldierungsfähig zählt die Netzeinspeisung bei nicht negativem Preis über (P4) — (P8) = MAX [ 0 ; (P7) − (P4) ]. Der
Strich „heute“ steht darum unter (P1) bei (P14), darüber bei (P7); dazwischen der Indifferenzbereich (P3). Im Rumpfjahr
treten (P1)R/(P3)R/(P4)R an die Stelle (Regel `rumpfjahre`, A2 S. 54–55). Fehlt (P14) oder (P7), steht „offen“.
Die Pauschalgrenzen der Einrichtung rechnet das Portal aus dem Aufbau nach (P1), (P2)P1/P2/P3, (P3), (P4) und das
Rumpfjahr nach (P17)–(P4)R — geprüft gegen diese Vektoren (`mispelPauschal.test.ts`: `pauschalgrenzen`,
`bnetza-rumpfjahre-zweiter-speicher-am-16-mai`).

## Was die Leser prüfen (L1–L10)

Beide Leser prüfen dieselbe Liste; ein Fall, den nur einer anmahnt, ist ein Fehler im anderen.

1. **L1 Schema** — Java über `uems/UemsSchemaLaeufer`, Python über `jsonschema` (Draft 2020-12).
2. **L2 Katalog** — jede Formelnummer einmal; P1, P2 und P5 tragen je (P1) bis (P15) genau einmal; zusammen ist
   (P1)–(P22) vollständig; Formelsatz und Formel nennen einander in beide Richtungen, in Katalog-Reihenfolge;
   `summe.von`, `quotient` und `ersetzt` zeigen auf bekannte Formeln oder Eingänge; eine ersetzte Formel steht nicht
   neben ihrer Ersetzung.
3. **L3 Eingänge und Stammdaten** — Namen eindeutig; jede Viertelstunde trägt genau die Eingänge ihres
   Formelsatzes ohne die ungeförderten; Stammdaten genau die des Formelsatzes (am Fall oder je Rumpfjahr);
   SKinst > 0; in P4/P4-Variante Pinst = Painst + Pbinst; in der P4-Variante stimmen die AW>0-Zeiten überein.
4. **L4 Raster** — Beginn auf dem Viertelstundenraster, streng aufsteigend, erwartete Viertelstunden in derselben
   Folge; Rumpfjahre lückenlos aneinander (nächstes `von` = voriges `bis` + 1 Tag).
5. **L5 Jahresgrenzen** — die erwarteten Jahre sind genau die Kalenderjahre (gesetzliche Zeit) bzw. Rumpfjahre der
   Viertelstunden; ein Rumpfjahr liegt in einem Kalenderjahr, Schlüssel `von/bis`.
6. **L6 Vollständigkeit** — jedes Jahr trägt genau die Jahres-Formeln seines Formelsatzes (ein Rumpfjahr dazu die
   Rumpfjahr-Formeln), jede Viertelstunde genau die ¼-Formeln, in Katalog-Reihenfolge.
7. **L7 Summen** — jede ∑J-Formel ist die exakte Summe ihrer Viertelstunden im (Rumpf-)Jahr (in P5 über die
   ersetzende Formel); (P5)¼ und (P12…)¼ folgen SP¼ bzw. AW¼, ungeförderte Anlagen tragen 1.
8. **L8 Zahlform** — jede Zahl ist eine Dezimalzahl oder ein gekürzter Bruch, der kein endlicher Dezimalbruch ist.
9. **L9 Rumpfjahr-Tage** — (P17) = 183 = Tage April–September, (P20) = Tage des Kalenderjahres, (P19)R und (P22)R
   = Sommer- bzw. alle Tage zwischen `von` und `bis` einschließlich.
10. **L10 BNetzA-Rundung** — jede Zahl unter `bnetza` (Fall) und `bnetza`/`bnetza_je_kwp` (Tabellenzelle) ist der
    kaufmännisch auf die gedruckten Stellen gerundete exakte Wert; Tabelle 1 hat alle 49 Zellen.

Prüfnachweis (ohne Docker):
`(cd services/api && ./mvnw test -Dtest='MispelPauschalVectorsTest,MispelPauschalRechenwerkTest')` (JDK 21) und
`(cd services/optimization && PYTHONPATH=. uv run --no-project --with pytest --with jsonschema python -m pytest tests/test_mispel_pauschal_vectors.py tests/test_mispel_pauschal_rechenwerk.py -q)`;
mit Docker dazu `MispelPauschalJahreslaufTest`.

## Beim Ändern

Eine geänderte Formel, ein neuer Fall oder eine neue Lesart ändert die Vektor-Datei, das Schema und beide Leser
zusammen; jede Abweichung von Anlage 2 bekommt einen Eintrag in `abweichungen` mit Fundstelle. Alle Leser finden:
`rg -l "mispel-pauschal" services frontend` — dazu gehören die Rechenwerk-Tests `MispelPauschalRechenwerkTest`,
`MispelPauschalJahreslaufTest` (Testcontainers) und `test_mispel_pauschal_rechenwerk.py`. Erwartete Werte werden
gerechnet, nicht abgeschrieben (exakt, mit Brüchen); wer einen Fall von Hand ändert, rechnet ihn nach und lässt
beide Leser laufen. Die Datei wird nicht ins Jar gepackt (anders als `mispel-abgrenzung-vectors.json` für MP-16); wer
sie zur Laufzeit braucht, trägt sie in `services/api/pom.xml` und `services/api/Dockerfile` ein.
