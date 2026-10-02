# MiSpeL — Speicher und Ladepunkte im Mischbetrieb

Stand 02.10.2026 (MiSpeL MP-23). Quelle: Festlegung der Bundesnetzagentur zur Marktintegration von Speichern und
Ladepunkten („MiSpeL“, Az. 618-25-02, Beschluss vom 01.10.2026) — Tenor mit Begründung, Anlage 1
(Abgrenzungsoption), Anlage 2 (Pauschaloption). Zitierweise wie in den Verträgen: „A1 S. 35“ = Anlage 1, Seite 35;
„T S. 3 Ziff. 9a“ = Tenor, Seite 3, Ziffer 9a. Die Festlegung hat keine Randnummern.

Diese Seite ist der Einstieg. Was gebaut ist, regeln die Verträge unter [`docs/contracts/v2/mispel-*`](../contracts/v2/README.md)
und die Wegweiser unter `docs/agents/root/mispel-*`; hier steht nur, wie die Teile zusammengehören und wo sie wohnen.
Wo diese Seite und ein Vertrag sich widersprechen, gilt der Vertrag — und dann ist einer von beiden falsch.

| Unterlage in diesem Ordner | Stand |
|---|---|
| [Rechtsfragen-Katalog](rechtsfragen.md) (MP-3) | Entwurf, nicht versandt — acht Fragen und die Regel, die bis zur Antwort gilt |
| [Anfrage-Paket Direktvermarkter](direktvermarkter-anfrage.md) (MP-43) | Entwurf, nicht versandt — Anforderungen D1–D9, Vergleichsraster |

## 1. Was die Festlegung regelt

Bisher gab es für einen Speicher an einer EEG-Anlage nur die **Ausschließlichkeitsoption**: der Speicher nimmt keinen
Netzstrom auf, sonst entfällt die Förderung seiner Einspeisung. MiSpeL eröffnet zusätzlich die **Abgrenzungsoption**
und die **Pauschaloption**, „um die strikte Trennung von ‚Grünstrom‘ und ‚Netzstrom‘ zu überwinden“ (T S. 3, Gründe I.1).
Geregelt werden zwei Rechtsbereiche (T S. 3–4):

- **Marktprämie** für die förderfähige Netzeinspeisung aus EE-Anlage und Speicher bzw. Ladepunkt (§ 19 Abs. 3b/3c EEG;
  T Ziff. 3 und 4);
- **Umlageprivilegien** für die saldierungsfähige Netzeinspeisung aus dem Speicher bzw. Ladepunkt (§ 21 Abs. 1 bis 4a
  EnFG; T Ziff. 1 und 2) — auch ohne marktprämiengeförderte EE-Anlage (T Ziff. 1 S. 2, Ziff. 2 S. 2).

Kern der Festlegung sind die **Formelsätze**, nach denen die Mengen zu bestimmen und nachzuweisen sind (T S. 4).

| Regel | Fundstelle |
|---|---|
| Beide Optionen nur, wenn mindestens eine EE-Anlage und alle Speicher und bidirektionalen Ladepunkte hinter der Einspeisestelle der Direktvermarktung per Marktprämie zugeordnet sind, mit der Angabe „Abgrenzung“ oder „Pauschal“ | T S. 2 Ziff. 5 S. 1 |
| Zuordnung und Wechsel nach §§ 21b, 21c EEG, also zum Monatsersten | T S. 2 Ziff. 5 S. 2 |
| Netz- und Messstellenbetreiber müssen die Inanspruchnahme ermöglichen | T S. 2 Ziff. 7 |
| Wirkung mit Bekanntgabe | T S. 2 Ziff. 8 |
| Bis 30.09.2027 nur im Einverständnis mit Netz- und Messstellenbetreiber | T S. 3 Ziff. 9a |
| Pauschaloption (Ziff. 2 und 4) frühestens ab dem Monatsersten nach der beihilferechtlichen Genehmigung der EU-Kommission | T S. 3 Ziff. 9b |
| Bestimmung und Nachweis nur auf mess- und eichrechtskonformen Viertelstundenwerten | T S. 28 |

### Die drei Farben (A1 Abschn. 2.3, S. 18)

Anlage 1 kennzeichnet ihre Strommengen mit Schriftfarben; Produkt, Optimierer und Nachweis übernehmen sie:

- **grün** — förderfähige Einspeisung von EE-Strom direkt aus der EE-Anlage ins Netz;
- **gelb** — EE-Strom im Speicher und/oder Ladepunkt und die förderfähige Einspeisung von EE-Speichererzeugung;
- **rot** — Netzbezug im Speicher und/oder Ladepunkt und die umlagereduzierende saldierungsfähige Netzeinspeisung daraus.

Zwei Regeln tragen die Rechnung: der **Speichervorrang** je Viertelstunde — Netzbezug gilt zuerst als im Speicher
verbraucht, (1)¼ = MIN [ Z1NB¼ ; Z2V¼ ] (§ 21 Abs. 4 S. 3 EnFG; A1 S. 33) — und der **Abzug der
EE-Speichererzeugung** von der saldierungsfähigen Netzeinspeisung, (16) = MAX [ (13) – (15) ; 0 ] (A1 S. 36). Die
Saldierungsperiode ist der **Kalendermonat** (Abgrenzung) bzw. das **Kalenderjahr** (Pauschal, A2 S. 28–33).

## 2. Förderweg und Betriebsart

Der **Förderweg** ist das Stammdatum je Einspeisestelle (Anlage, `site`), aus dem Netzladen, Exportwert,
Marktwertbasis, Box-Klemme und Portaltexte folgen — fünf Werte mit den Begriffen aus EEG und Festlegung.
„Förderweg“ ist das Produktwort für Veräußerungsform plus Option (§ 19 Abs. 3 S. 1 EEG); die amtlichen Begriffe
stehen in jeder Antwort daneben. Regeln, Bestand ohne Zeile und Schnittstelle: [Vertrag Förderweg](../contracts/v2/mispel-foerderweg.md) (MP-5).

| Förderweg | Betriebsart des Optimierers | Stand |
|---|---|---|
| `einspeiseverguetung` | EEG-Modus (Netzladen ausgeschlossen) | gebaut |
| `marktpraemie_ausschliesslichkeit` | **EEG-Modus**: FK3-Klemme (Laden bis zur erzeugten PV); die **strenge Variante** „kein Speicherverbrauch bei gleichzeitigem Netzbezug“ (A1 S. 11) ist ein Betreiber-Schalter, Standard aus — [Wegweiser](../agents/root/mispel-strenge-ausschliesslichkeit.md) (MP-45) | gebaut, strenge Variante aus bis zur Rechtsantwort |
| `marktpraemie_abgrenzung` (A1, A5, A5-Variante) | **Mischbetrieb**: zwei Ladewege, Buchung nach Speichervorrang, Exportwert je Farbe — [Wegweiser](../agents/root/mispel-optimierer-mischbetrieb.md) (MP-10) | gebaut, mit Monatszustand (MP-11) |
| `marktpraemie_pauschal` | **Jahreszustand**: Wert der nächsten Einspeise-kWh nach Jahresstand — unter (P1) Prämie, zwischen (P1) und (P4) nichts, darüber Saldierung bis zum Jahres-Netzbezug (nur SP≥0); ohne Jahreslauf über die Spiegel wie vorher — [Wegweiser](../agents/root/mispel-optimierer-mischbetrieb.md#pauschaloption-jahreszustand-mp-26) (MP-26) | gebaut für P1–P3; P4, P4-Variante, P5 offen |
| `ungefoerdert` | **Händler-Modus** (Export zu blankem Spot) | gebaut |

- **Händler-Modus = Förderweg `ungefoerdert` (W6).** Eine EEG-Anlage in Direktvermarktung, die Netzstrom einspeichern
  will, nutzt den Mischbetrieb: dort bekommt die EE-Speichererzeugung (gelb) die Marktprämie und rot die Saldierung,
  während der Händler-Modus alles zu blankem Spot exportiert.
- **`dv_konform` ist entfernt (W8, MP-10):** seine Bedeutung trägt der Förderweg `marktpraemie_ausschliesslichkeit`.
- **Box (MP-14, BK-14 Variante A):** Der Förderweg reist im Plan zur Box (`foerderweg`). Die EEG-Klemme gilt nur noch für
  Einspeisevergütung und Ausschließlichkeitsoption, streng über MP-45. Abgrenzung, Pauschal und ungefördert laden aus
  dem Netz nach der Einstellung des Kunden, innerhalb der Export-, § 14a- und Negativpreis-Wächter. Ohne Feld lädt die Box
  nur mit Sonnenstrom. Die Box zeigt den Förderweg als erste Zeile im „Lade- & Entladeplan“
  ([Wegweiser](../agents/root/mispel-box-foerderweg.md)).
- **Einrichtung im Portal (MP-17, BK-17 Variante A):** Anlage › Einstellungen, Zeile „Förderweg“ (statt
  „Veräußerungsform“) mit dem Dialog „Förderweg ändern“ — Förderweg · Zähler · Formelsatz · Partner · Prüfen, Kurzweg
  für Einspeisevergütung, Ausschließlichkeitsoption und ungefördert. Ein Wechsel wird zum nächsten Monatsersten
  **vorgemerkt** (Vertrag 1.2 § 5, `FoerderwegSpiegelLaeufer` legt die Spiegel am Tag um); der Partner
  (Direktvermarkter, gesonderter Bilanzkreis) ist Angabe der Fassung. Zwilling `frontend/portal/src/mispelFoerderweg.ts`,
  Bühne `e2e/foerderweg.tsx`.
- **MiSpeL-Check im Portal (MP-48, BK-48 Variante A):** in Schritt 1 des Dialogs „Förderweg ändern“, sobald die
  Abgrenzungsoption gewählt ist (und heute nicht schon gilt): Betrag im Jahr mit Vorzeichen, ein Satz Grund, Spanne
  ungünstig bis günstig; „Wie gerechnet?“ zeigt die Posten mit Vorzeichen und was die Abgrenzungsoption verlangt.
  Daten nur lesend aus `site_mispel_check` (`GET /api/v1/sites/{siteId}/mispel-check`,
  [Vertrag](../contracts/v2/mispel-check.md)); ohne Zeile „wird gerechnet“, nie 0 €.
- **Der alte Schalter `netzladen_erlaubt`** bietet das Portal seit MP-17 nur noch, wo der Förderweg Netzladen zulässt
  (sonst gesperrt mit Grund); ohne Fassung ist er der Bestand, mit Fassung bestimmt der Förderweg ([Vertrag § 6](../contracts/v2/mispel-foerderweg.md#6-der-alte-netzlade-schalter-bis-mp-17-w2--b),
  [Wegweiser Netzladen-Schalter](../agents/root/per-site-grid-charging-switch-site-netzl.md)).
- **Ausmaß der Ausschließlichkeit messen:** der [Ausschließlichkeits-Prüfer](../agents/root/mispel-ausschliesslichkeits-pruefer.md)
  (MP-2) zeigt dem Betreiber je Anlage und Monat (1)¼ auf Gerätewerten — keine Steuerung, keine Portalfläche.

## 3. Zählerrollen

Die Abgrenzungsoption braucht Z1 am Netzanschluss und Z2 am Speicher bzw. Ladepunkt, hinter Z2 nichts anderes
(A1 S. 23–25, S. 32–33; Z3 nur im Basisfall A4). Die Rolle hängt an der Messstelle des Messstellen-Registers, je
Fassung mit Zählpunkt, Messstellenbetreiber, Eichstatus und Wertequelle; Plausibilitätsbefunde beim Lesen:
[Vertrag Zählerrolle](../contracts/v2/mispel-zaehlerrolle.md) (MP-6). Am bidirektionalen Ladepunkt liest MP-31 Z2 aus
diesen Rollen und stellt daneben die Fähigkeit V2H/V2G als Fassungen ab einem Tag (ohne Fassung gilt der Bestand als
unidirektional, A1 S. 26) und das Fahrzeugfenster für den Optimierer:
[Vertrag bidirektionaler Ladepunkt](../contracts/v2/mispel-ladepunkt-bidirektional.md) (MP-31).

## 4. Rechenwerk der Abgrenzungsoption

Ein Vertrag, eine Vektor-Datei, zwei Rechenwerke im Gleichlauf (exakte Brüche, ungerundet):

- **Vertrag und Vektoren** (MP-4): [Regeln](../contracts/v2/mispel-abgrenzung.md), [Vektoren](../contracts/v2/mispel-abgrenzung-vectors.json),
  [Schema](../contracts/v2/mispel-abgrenzung.schema.json) — Formelnummer, Begriff und Rechenweg **wörtlich** aus Anlage 1, Fundstelle je Formel.
- **Python** `services/optimization/voltpilot_optimization/mispel_abgrenzung.py` (MP-9, für Optimierer und Simulation).
- **Java** `services/api/.../mispel/MispelAbgrenzungRechenwerk.java` (MP-8, für Monatslauf und Nachweis).
- **Formelsätze** (E5 = B): A1, A5, A5-Variante, A10, A11; seit MP-32 auch A2–A4 für Ladepunkte (Wirkungsgrad 0,85,
  Fremdtankstrom (12)/(13), Verluste nur am Stromspeicher in A4 privilegiert; A11 auch für Ladepunkte, A10 nicht,
  [Vertrag](../contracts/v2/mispel-abgrenzung.md#ladepunkte-a2-a3-a4-mp-32)). A6–A9 erst, wenn ein Kunde
  sie braucht (Basisfälle A1–A4 und Sonderfälle A5–A9: A1 S. 8–9, Übersicht 1; A10, A11 ohne marktprämiengeförderte
  EE-Anlage: A1 S. 94–102). Die Pauschaloption (Anlage 2) hat einen eigenen Vertrag (MP-24):
  [Regeln](../contracts/v2/mispel-pauschal.md), [Vektoren](../contracts/v2/mispel-pauschal-vectors.json),
  [Schema](../contracts/v2/mispel-pauschal.schema.json) — Formeln (P1)–(P22)R der Formelsätze P1–P5 mit Rumpfjahr und
  Tabelle 1; Rechenwerk MP-25 in Java (`mispel/MispelPauschalRechenwerk.java`) und Python
  (`voltpilot_optimization/mispel_pauschal.py`), anwendbar erst ab dem Monatsersten nach der EU-Genehmigung (T S. 3 Ziff. 9b).
- **Bindung:** der vereinfachte Formelsatz (A10/A11 statt A1, A5-Variante statt A5) bindet bis zum Jahresende
  (A1 S. 24, Abschn. 3.2.3); geprüft beim Eintragen des Förderwegs. Das **Gebot der Bestnutzung** (vereinfacht
  verboten, wenn die Zähler den genaueren Formelsatz tragen) prüft der Formelsatz-Vorschlag der Einrichtung (MP-17)
  gegen die Zählerrollen; der Server prüft es noch nicht.

## 5. Monatslauf, Rumpfmonate, Nachweis

- **Monatslauf** (MP-8): je Anlage und Kalendermonat aus Zählerwerten und AW>0-Zeiten; gespeichert als Fassung mit
  kanonischem Nachweis-Text und SHA-256 (`mispel_abgrenzung_monat`). Lücken bleiben Lücken, nie Null.
  [Vertrag, Abschnitt Monatslauf](../contracts/v2/mispel-abgrenzung.md#monatslauf-und-nachweis-mp-8). Der Läufer
  (MP-8b, `MispelMonatslaufLaeufer`, täglich) rechnet je Anlage in der Abgrenzungsoption nach Monatsende vorläufig und
  mit den Werten des Messstellenbetreibers endgültig, Formelsatz und AW-Regel aus dem Förderweg des Monats
  ([Der Läufer](../contracts/v2/mispel-abgrenzung.md#der-läufer-mp-8b)).
- **Jahreslauf der Pauschaloption** (MP-25): je Anlage und Kalender- oder Rumpfjahr (tagesscharfe Sommerperiode,
  A2 S. 53–55), nur an Tagen mit Förderweg Pauschaloption, ein Zähler Z1 genügt; gespeichert in `mispel_pauschal_jahr`
  wie der Monatslauf. Vor der EU-Genehmigung bleibt jeder Lauf vorläufig (`eu_genehmigung_ausstehend`).
  [Vertrag, Abschnitt Jahreslauf](../contracts/v2/mispel-pauschal.md#rechenwerk-und-jahreslauf-mp-25).
- **Stand vorläufig / endgültig** (E4 = C): endgültig nur auf Werten des Messstellenbetreibers, lückenlos, mit
  AW>0-Liste der ÜNB und nach Ende des Zeitraums (T S. 28; § 21 Abs. 4 S. 2 EnFG). Eine vorläufige Zahl heißt nie
  „Mengenbestimmung“.
- **Rumpfmonate** (MP-21): eine bestimmungsrelevante Änderung im Kalendermonat teilt ihn; am Monatsersten entsteht kein
  Rumpfmonat (A1 Abschn. 11, S. 102–104). [Vertrag, Abschnitt Rumpfmonate](../contracts/v2/mispel-abgrenzung.md#rumpfmonate-erkennen-mp-21).
- **Nachweis und Export** (MP-16): CSV und PDF je Monat und Jahr für die Rollen Lieferant, Direktvermarkter,
  Netzbetreiber; Jahresnachweis für die Mitteilung bis 31.05. des Folgejahres (§ 21 Abs. 7 EnFG).
  [Vertrag, Abschnitt Nachweis](../contracts/v2/mispel-abgrenzung.md#nachweis-und-export-mp-16),
  PDF-Setzer: [Wegweiser](../agents/root/uems-bericht-ausgabe-pdf.md).

Wo diese Teile im Code liegen und welche Fallen sie haben, steht im [UEMS-Wegweiser](../agents/root/uems-uebersicht.md)
unter den MiSpeL-Einträgen (MP-5, MP-6, MP-8, MP-16, MP-21).

## 6. Marktdaten

AW>0-Zeiten nach der Liste der Übertragungsnetzbetreiber ((24)¼ = WENN [ AW¼ > 0 ; 1 ; 0 ], A1 S. 38; Liste
A1 S. 17 Fn. 8), SP¼ aus den Day-Ahead-Preisen und der Jahresmarktwert. An Tagen in Abgrenzungs- oder
Pauschaloption rechnen **Optimierer und Erlöse** die Marktprämie mit dem Jahresmarktwert und nur in AW>0-Viertelstunden
— eine Grundlage für beide (MP-12). [Wegweiser Marktdaten](../agents/root/mispel-marktdaten-aw-sp-jahresmarktwert.md) (MP-7, MP-12).

## 7. Herkunft des Speicherstroms: Formel statt Schätzung (W5)

Für dieselbe Anlage darf es nur **einen** Netzstrom-Anteil geben. Entschieden am 02.10.2026:

- **MiSpeL-Anlagen** (Förderweg `marktpraemie_abgrenzung`/`marktpraemie_pauschal`) zeigen nur die amtlichen Mengen
  grün/gelb/rot aus dem Rechenwerk.
- **Förderweg `ungefoerdert`** (Händler-Modus) behält den Zwei-Töpfe-Ausweis „davon durch Netzladen verdient“
  (`EarningsRepository.arbitrageSplit`), beschriftet als VoltPilot-Schätzung — [Wegweiser](../agents/root/arbitrage-ausweis-davon-arbitrage-gewinn.md).
- Der Drei-Töpfe-Entwurf ist durch die Formel ersetzt: [Speicherherkunft](../attribution-three-pot.md).

**Seit MP-18:** Verlauf › Erlöse zeigt für MiSpeL-Anlagen die Karte „MiSpeL · Mengen nach Anlage 1“
([Vertrag § Kundenansicht](../contracts/v2/mispel-abgrenzung.md#kundenansicht-mengen-und-ertrag-mp-18)) und nennt im
Preise-Fuß kein „davon durch Netzladen“ mehr. **Noch offen:** `arbitrageSplit` wählt die Anlagen in der API weiter über
`netzladen_erlaubt` (die Cockpit-Kachel „davon Arbitrage“ zeigt die Schätzung darum noch), und im Förderweg
`ungefoerdert` trägt der Ausweis noch nicht das Wort „Schätzung“.

## 8. Abweichungen von der Festlegung

Wo das Produkt bewusst nur einen Teil umsetzt oder vorsichtiger rechnet — jede Stelle mit Grund:

| Wo | Festlegung | Produkt | Warum |
|---|---|---|---|
| Formelsätze | Fallkonstellationen A1–A9 (A1 S. 8–9, Übersicht 1) und A10, A11 (A1 S. 94–102) | A1, A5, A5-Variante, A10, A11; A2–A4 für Ladepunkte (MP-32) | deckt die Gewerbe-Kundentypen und bidirektionale Ladepunkte; andere Fälle bekommen „noch nicht unterstützt“ statt einer Näherung |
| Ausschließlichkeitsoption | kein Speicherverbrauch bei gleichzeitigem Netzbezug (A1 S. 11) | FK3 bleibt Standard, strenge Variante schaltbar (MP-45), Ausmaß misst MP-2 | die Festlegung regelt diese Option nicht neu; die Rechtsfolge klärt die Anfrage im [Katalog](rechtsfragen.md) |
| Vorläufige Mengen | nur eichrechtskonforme Viertelstundenwerte (T S. 28) | Vorschau auf Gerätewerten, Stand „vorläufig“; Nachweis nur endgültig | Steuerung braucht Werte vor Monatsende; die vorläufige Zahl ist keine Mengenbestimmung |
| Datenformate | Marktkommunikation nicht geregelt (T S. 28, S. 90, S. 92) | CSV und PDF mit denselben Werten | vor EDI@Energy gibt es kein amtliches Format |
| Prämien-Viertelstunden | AW>0-Liste der ÜNB (A1 S. 17 Fn. 8) | Liste importiert; ohne Liste Rückfall „keine Prämie bei SP¼ < 0“, Monat bleibt „vorläufig“ | der Rückfall hält nur die Steuerung am Laufen |
| Rot-Exportwert | Saldierung der Umlagen (§ 21 EnFG), Netzentgelt über § 118 Abs. 6 EnWG (A1 S. 18) | Gutschrift nur für Umlagen + Netzentgelt-Arbeitspreis; Stromsteuer, Konzessionsabgabe und Leistungspreis nicht | Stromsteuer liegt außerhalb der BNetzA-Befugnis (A1 S. 18 Fn. 10); bis zur Rechtsklärung vorsichtig |
| Wort „Förderweg“ | Veräußerungsform und Option (§ 19 Abs. 3 S. 1 EEG) | ein Stammdatum, amtlicher Begriff daneben | verhindert widersprüchliche Kombinationen |

## 9. Was noch nicht gebaut ist

- **Optimierer:** Jahreszustand der Pauschaloption für die Sonderfälle P4, P4-Variante und P5 (MP-26 baut P1–P3);
  der MiSpeL-Check rechnet von der Pauschaloption nur den Basisfall P1 (MP-29), P2–P5 bleiben `nicht_unterstuetzt`. Der
  MiSpeL-Check in der Simulation rechnet (MP-13, [Wegweiser](../agents/root/mispel-check-simulation.md)); seine Anzeige steht im Förderweg-Dialog (MP-48); wer ihn je Anlage rechnet und in
  `site_mispel_check` ablegt, fehlt (MP-13b) — bis dahin zeigt das Portal „wird gerechnet“.
- **Rechenwerk:** der Optimierer plant A2–A4 noch nicht im Mischbetrieb (Fahrzeug als Speicher: MP-33); Rumpfjahre
  der Pauschaloption gibt der Aufrufer noch vor (Erkennung aus Fallständen wie MP-21 fehlt), Zählerrolle ZW für P5 fehlt. Der Läufer des Monatslaufs (MP-8b) überspringt A5/A5-Variante (Painst/Pbinst und
  AW-Regel der Anlage b trägt der Förderweg nicht) und A1–A4 ohne eingetragene AW-Regel.
- **Messwerte des Messstellenbetreibers:** Import (CSV und MSCONS 2.5/2.4c, MP-15b) und Abgleich gegen Gerätewerte
  stehen (MP-15, [Vertrag](../contracts/v2/mispel-abgrenzung.md#werte-des-messstellenbetreibers-und-abgleich-mp-15));
  offen sind die Partner-Schnittstelle, ein echter MSB-Monat, Ersatzwerte (`QTY+67`, heute Lücke) und die Schwellen
  2 % / 5 % (Pilot MP-47).
- **Oberflächen** — jede beginnt erst nach einem mit dem Captain abgestimmten Bedienkonzept (BK-…): Einrichtung des Förderwegs mit Formelsatz-Vorschlag und Gebot der Bestnutzung (MP-17;
  ersetzt auch den Portaltext zum Netzladen, W2, und bringt den Hinweis auf die Abgrenzungsoption an einer EEG-Anlage
  im Händler-Modus, W6), Kundenansicht Mengen und Ertrag mit Nachweis-Abruf (MP-18, W5).
- **Partner:** Einverständnis-Paket für die Übergangszeit (MP-19), Direktvermarkter-Schnittstelle (MP-20).
- **Bidirektionale Ladepunkte** (Stufe B): ein bidirektionaler Ladepunkt wird wie ein Speicher behandelt
  (A1 Abschn. 3.2.5, S. 26–27). Das Datenmodell steht (MP-31); es fehlen Rechenwerk A2–A4 mit Fremdtankstrom (MP-32),
  Optimierer (MP-33), Box (MP-36ff.; der Simulator steht, MP-34,
  [Wegweiser](../agents/root/mispel-simulator-fahrzeug.md); OCPP 2.0.1 mit beiden Registern Z2V/Z2E misst seit
  MP-35, [Umfang](../edge-ocpp201.md)) und die Fläche nach BK-41 (MP-41).
