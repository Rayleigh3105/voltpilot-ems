# MiSpeL — Anfrage-Paket Direktvermarkter

> **ENTWURF — nicht versandt, niemand angeschrieben.** Stand 02.10.2026, Paket MP-43 des MiSpeL-Bauplans (Entscheid
> E8 = D: der Kunde bringt seinen eigenen Direktvermarkter mit, oder VoltPilot wählt einen Partner aus den Angeboten dreier
> angefragter Kandidaten). Anfrage und Vergleichsraster gelten erst, wenn der Captain sie freigegeben hat. **Wen VoltPilot
> anfragt, entscheidet der Captain** — die Kandidaten in [Abschnitt 3](#3-kandidaten--platzhalter-vorschlag) sind nur
> ein Vorschlag. Versand und Gespräche führt der Captain oder wer von ihm beauftragt ist; jeder Versand wird in
> [Abschnitt 5](#5-versandprotokoll) festgehalten. Das Paket ist keine Rechtsauskunft; wo VoltPilot eine Norm auslegt,
> steht **Lesart VoltPilot**.

Das Paket hat vier Teile: (1) die Anforderungsliste — was ein Direktvermarkter für Gewerbeanlagen im Mischbetrieb nach
MiSpeL können muss und was VoltPilot ihm liefert; (2) die gleichlautende Anfrage an drei Kandidaten; (3) die Kandidaten
als Platzhalter mit öffentlich belegten Angaben; (4) das Vergleichsraster für die Angebote. Grundlage ist die Festlegung
der Bundesnetzagentur zur Marktintegration von Speichern und Ladepunkten (MiSpeL) vom 01.10.2026, Az. 618-25-02. Die
Rechtsfragen, die das Paket berührt, stehen im [Rechtsfragen-Katalog](rechtsfragen.md); die Mengen, die VoltPilot dem
Direktvermarkter liefert, im Vertrag [MiSpeL-Abgrenzungsoption](../contracts/v2/mispel-abgrenzung.md#nachweis-und-export-mp-16).

## Quellen und Zitierweise

| Kürzel | Dokument |
|---|---|
| **T** | Festlegung, Tenor mit Begründung (94 S.), `https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/ErneuerbareEnergien/EEG_Aufsicht/MiSpeL/DL/MiSpeL_TenorMitBegruendung.html` |
| **A1** | Anlage 1 Abgrenzungsoption (104 S.), `…/MiSpeL/DL/MiSpeL_Abgrenzungsoptionen.html` |
| **A2** | Anlage 2 Pauschaloption (56 S.), `…/MiSpeL/DL/MiSpeL_Pauschaloptionen.html` |
| **G-…** | Gesetzestext von `gesetze-im-internet.de`, abgerufen 01.10.2026 (G-EEG § 10b, § 20, § 21b) |
| **St-Next** | Stellungnahme der Next Kraftwerke GmbH zur Konsultation (bis 24.10.2025), `https://data.bundesnetzagentur.de/Bundesnetzagentur/SharedDocs/Downloads/DE/Sachgebiete/Energie/Unternehmen_Institutionen/ErneuerbareEnergien/Mispel/Next.pdf` |
| **W-…** | Webseite oder Pressetext eines Kandidaten, je Zeile mit URL; abgerufen 02.10.2026. *[sekundär]* = Fachpresse |

„T S. 24“ = Tenor, PDF-Seite 24. „A1 S. 38, (26)“ = Anlage 1, Seite 38, Formel (26). Die Festlegung hat keine
Randnummern. Begriffe und Formelnummern stehen wörtlich wie in Anlage 1 und im Vertrag
`docs/contracts/v2/mispel-abgrenzung-vectors.json`. Die Festlegung sagt „Direktvermarkter“, das EEG
„Direktvermarktungsunternehmer“ (§ 20 S. 2 EEG) bzw. „Direktvermarktungsunternehmen“ (§ 10b EEG); gemeint ist dieselbe Rolle.

## 1. Anforderungsliste

Je Anforderung: was die Festlegung oder das Gesetz verlangt, was VoltPilot dafür liefert und was der Direktvermarkter
können muss. Die Nummern D1–D9 kehren in der Anfrage und im Raster wieder.

### D1 — Gesonderter Bilanzkreis je Einspeisestelle

- **Festlegung:** Voraussetzung 4 der Abgrenzungsoption: „Die gesamte Netzeinspeisung an der Einspeisestelle muss …
  in einem gesonderten Bilanzkreis oder Unterbilanzkreis nach § 20 S. 2 EEG bilanziert werden (in der Regel ist dies ein
  Bilanzkreis des Direktvermarkters, der sich um die Abnahme, Bilanzierung und Vermarktung des eingespeisten Stroms
  kümmert)“ (A1 S. 21). Die Bundesnetzagentur betont „einheitlich in ‚einem‘ (Singular) gesonderten Bilanzkreis oder
  Unterbilanzkreis“ (T S. 25); gleich für die Pauschaloption, Voraussetzung 7 (A2 S. 20; T S. 74).
- **Gesetz:** § 20 S. 2 EEG: Bilanz- oder Unterbilanzkreis, „in dem ausschließlich Strom bilanziert wird, bei dem der
  förderfähige Anteil aus dem Stromspeicher nach der Abgrenzungs- oder Pauschaloption bestimmt wird“ (G-EEG § 20).
- **Lesart VoltPilot:** Mehrere MiSpeL-Einspeisestellen dürfen sich einen gesonderten Bilanzkreis teilen, solange darin
  nur MiSpeL-Strom steht; je Einspeisestelle ist es *ein* Kreis, nicht ein Kreis je Anlage. Bestätigung durch den
  Direktvermarkter erbeten (Frage A1.2).
- **Der Direktvermarkter muss:** einen solchen Kreis führen, für Gewerbeanlagen ab der Größe unserer Beispielkunden
  (100 kWp PV mit 65 kWh Speicher) wirtschaftlich anbieten und sagen, was er kostet.

### D2 — Mischbetrieb nach MiSpeL: Zuordnung, Option, Übergangszeit

- **Festlegung:** Der Anlagenbetreiber ordnet „mindestens eine EE-Anlage sowie die Stromspeicher und bidirektional
  nutzbaren Ladepunkte hinter der Einspeisestelle der Veräußerungsform der Direktvermarktung per Marktprämie“ zu und gibt
  an, ob das auf Basis der Abgrenzungs- oder der Pauschaloption geschieht, nach §§ 21b, 21c EEG (T S. 2 Ziff. 5). Die
  Zuordnung darf er „z.B. von seinem Direktvermarkter vornehmen“ lassen (T S. 90). Bis 30.09.2027 nur „im Einverständnis
  mit dem jeweiligen Netzbetreiber und Messstellenbetreiber“ (T S. 3 Ziff. 9a); die Pauschaloption frühestens „ab dem
  ersten Kalendertag des Kalendermonats, der auf die beihilferechtliche Genehmigung der Europäischen Kommission … folgt“
  (T S. 3 Ziff. 9b). Die Marktprämie wird dann mit dem Jahresmarktwert
  bestimmt, auch für Bestandsanlagen (T S. 25–26).
- **VoltPilot liefert:** Stufe 1 rechnet die Formelsätze A1, A5 (mit A5-Variante), A10 und A11 der Abgrenzungsoption
  (Bauplan § 8.5, E5 = B); Pilot mit Einverständnis von Netz- und Messstellenbetreiber vor dem 01.10.2027 (E6 = D).
- **Der Direktvermarkter muss:** Anlagen in der Abgrenzungsoption annehmen (Zuordnung samt Speicher), die Zuordnung im
  Auftrag melden können, einen Pilot in der Übergangszeit mittragen und sagen, wie er mit dem Jahresmarktwert rechnet.

### D3 — Mengenaustausch: was VoltPilot je Monat liefert

- **Festlegung:** Für Marktprämien muss der Anlagenbetreiber „die Voraussetzungen und Anforderungen an die Bestimmung und
  den Nachweis dieser förderfähigen Netzeinspeisung nach Anlage 1 einhalten“ (T S. 2 Ziff. 3). Bezugszeitraum ist der
  Kalendermonat; Bestimmung nur auf mess- und eichrechtskonformen Viertelstundenwerten (T S. 28). Ein Wechsel des
  Direktvermarkters ist ausdrücklich **keine** bestimmungsrelevante Änderung (T S. 58).
- **VoltPilot liefert** (MP-16, gemergt): je Kalendermonat und Kalenderjahr einen Nachweis als CSV und PDF für den
  Empfänger `direktvermarkter`, Route `GET /api/v1/sites/{siteId}/mispel/abgrenzung/monate/{JJJJ-MM}/nachweis.csv|.pdf?empfaenger=direktvermarkter`
  (und `…/jahre/{JJJJ}/…`). Inhalt: Formelsatz, Messkonzept (Z1 am Netzanschluss, Z2 am Speicher), alle Zwischenwerte,
  Lücken, Viertelstunden, Prüfsumme. Für den Direktvermarkter stehen darin:

  | Formel | Begriff (A1, wörtlich) | Fundstelle |
  |---|---|---|
  | (4) | Gesamte Netzeinspeisung im Kalendermonat | A1 S. 34 |
  | (26) | Förderfähige zeitgleiche Netzeinspeisung von EE-Strom in AW>0-Zeiten direkt aus der EE-Anlage im Kalendermonat | A1 S. 38 |
  | (31) | Förderfähige Netzeinspeisung von EE-Speichererzeugung in AW>0-Zeiten aus dem Stromspeicher und/oder Ladepunkt im Kalendermonat | A1 S. 39 |
  | (32) | Insgesamt förderfähige Netzeinspeisung in AW>0-Zeiten im Kalendermonat | A1 S. 39 |
  | (33) | Insgesamt förderfähige Netzeinspeisung in AW>0-Zeiten im Kalenderjahr | A1 S. 39 |
  | (26a)/(26b) … (33a)/(33b) | dieselben Größen je EE-Anlage a und b im Sonderfall A5 | A1 S. 47–49 |

  A10 und A11 haben keine Förderseite (A1 Abschn. 10); der Direktvermarkter bekommt dann den Satz statt einer Zahl.
  **Stand:** „vorläufig“ auf Gerätewerten, „endgültig“ nur auf Werten des Messstellenbetreibers; ein vorläufiger Monat
  trägt `gilt_als_nachweis=nein` und im PDF „vorläufig – keine Mengenbestimmung“ (E4 = C).
- **Abweichung mit Grund:** Das Format der Marktkommunikation regelt die Festlegung nicht (T S. 25, S. 90, S. 92); bis
  EDI@Energy-Formate feststehen, liefert VoltPilot CSV und PDF mit denselben Werten.
- **Der Direktvermarkter muss:** sagen, welche Größen er braucht, ob er CSV/PDF bis zur MaKo annimmt, wer die förderfähige
  Menge gegenüber dem Netzbetreiber vertritt und wie er Rumpfmonate (A1 Abschn. 11) behandelt.

### D4 — Fahrplanaustausch und Steuerung

- **Festlegung:** „Der Direktvermarkter kann in beiden MiSpeL-Optionen die Netzeinspeisung (aus der Solaranlage sowie aus
  dem Stromspeicher und/oder Ladepunkt) steuern und durch eine Verlagerung in Zeiten mit besonders hohen Preisen
  optimieren“ (T S. 73). Wie Fahrpläne ausgetauscht werden, regelt sie nicht (T S. 25: Zeitreihentypen „nicht Gegenstand“).
- **VoltPilot liefert:** einen Viertelstunden-Plan je Standort aus dem Optimierer (Mischbetrieb als dritte Betriebsart,
  Monatszustand als Eingang). Die Anbietergrenze steht als Stub im Dienst `services/marketing-adapter`
  (`MarketingSchedule` mit Standort und Leistung je Zeitscheibe in kW); den echten Adapter baut MP-20 erst nach der Wahl.
  Die lokale Ausführung und die Schutzgrenzen entscheidet die Box vor Ort; die Cloud plant nur.
- **Der Direktvermarkter muss:** sagen, wer den Plan macht (er, VoltPilot, gemeinsam), in welchem Format und Takt er
  Fahrpläne annimmt oder sendet (Day-Ahead, Intraday, Gate-Closure), wie Abweichungen abgerechnet werden
  (Ausgleichsenergie) und ob er den Speicher selbst einsetzen will.

### D5 — Fernsteuerung nach § 10b EEG

- **Gesetz:** Anlagen über 25 kW in der Direktvermarktung brauchen technische Einrichtungen, über die das
  Direktvermarktungsunternehmen „jederzeit a) die Ist-Einspeisung abrufen kann und b) die Einspeiseleistung …
  ferngesteuert regeln kann“ (§ 10b Abs. 1 S. 1 EEG). Eine gemeinsame Einrichtung für mehrere Anlagen am selben
  Verknüpfungspunkt genügt (Abs. 1 S. 2). Ab 01.01.2028 und ab Einbau eines intelligenten Messsystems über das
  Smart-Meter-Gateway (Abs. 2). Die Rechte des Netzbetreibers nach § 13 EnWG bleiben unberührt (Abs. 3). Die Festlegung
  selbst regelt § 10b nicht.
- **VoltPilot liefert:** die Box am Standort liest Ist-Werte und regelt Wechselrichter und Speicher; physische
  Schreibfreigaben sind modell- und gerätebezogen.
- **Lesart VoltPilot:** Die Box kann die „gemeinsame technische Einrichtung“ nach § 10b Abs. 1 S. 2 EEG sein; zu klären,
  ob der Direktvermarkter das anerkennt.
- **Der Direktvermarkter muss:** sagen, welche Steuerschnittstelle er heute verlangt (eigene Steuerbox, Protokoll), ob er
  über VoltPilot steuern kann, wie ein Steuersignal gegenüber den Schutzgrenzen der Box Vorrang hat, und wie er den
  Übergang auf das Smart-Meter-Gateway ab 2028 plant.

### D6 — Kleine Anlagen

- **Festlegung/Gesetz:** Die Abgrenzungsoption hat keine Größengrenze; die Pauschaloption gilt für Solaranlagen bis
  30 kWp (A2 S. 6) und erst nach der EU-Genehmigung (T S. 3 Ziff. 9b). § 10b EEG greift erst über 25 kW.
- **Was es für VoltPilot heißt:** Bei Haushalten in der Einspeisevergütung entscheidet das Direktvermarktungsentgelt, ob
  sich der Wechsel lohnt (Konzept, Kundentyp c1: −130 … +175 €/a, Schätzung). Öffentliche Entgelte für Kleinanlagen gibt
  es kaum.
- **Der Direktvermarkter muss:** sagen, ab welcher Größe er Anlagen annimmt, was eine Kleinanlage kostet (fix, variabel,
  Einrichtung), ob er Kleinanlagen ohne eigene Steuerbox nimmt und ob er die Pauschaloption anbieten will.

### D7 — Standalone-Speicher (A10) und Speicher ohne Erzeugung (A11)

- **Festlegung:** A10 = „ein Stromspeicher (ohne Ladepunkt)“ ohne andere Erzeugung und ohne sonstige Verbräuche hinter der
  Einspeise- bzw. Entnahmestelle, nur Zähler Z1 (A1 S. 95); A11 = Stromspeicher und/oder Ladepunkt ohne sonstige Erzeugung,
  mit Verbrauch (A1 S. 98–102). Beide regeln nur die Umlageseite; eine Marktprämie gibt es dort nicht (A1 Abschn. 10).
- **Lesart VoltPilot:** Ohne Marktprämie verlangt § 20 S. 2 EEG keinen gesonderten Bilanzkreis; vermarktet wird der
  Speicher trotzdem über einen Händler oder Vermarkter. Das ist der Kundentyp b (Gewerbe ohne EEG-Anlage, 100 kWh/50 kW).
- **Der Direktvermarkter muss:** sagen, ob und ab welcher Größe er Standalone- und Gewerbespeicher hinter einem
  Verbrauchsanschluss vermarktet, mit welchem Erlösmodell (Gewinnbeteiligung, Festpreis, Mindesterlös) und welche
  Schnittstelle er dafür braucht.

### D8 — Messwerte, Daten und Rollen

- **Festlegung:** Netzbetreiber und Messstellenbetreiber müssen die Optionen „ermöglichen“ (T S. 2 Ziff. 7); die
  Marktkommunikation regelt BK6, nicht die Festlegung (T S. 92). Die Übergangszeit dient dazu, die „MaKo-Prozesse“
  anzupassen (T S. 92).
- **VoltPilot:** keine Marktrolle; rechnet, optimiert und weist nach. Endgültige Mengen nur auf Werten des
  Messstellenbetreibers.
- **Der Direktvermarkter muss:** sagen, ob er die endgültigen Viertelstundenwerte selbst vom Messstellenbetreiber bekommt
  oder von VoltPilot, wie Kundendaten geschützt werden (Auftragsverarbeitung), und wann seine MaKo-Prozesse für MiSpeL
  massengeschäftstauglich sind — spätestens zum 01.10.2027, wenn das Einverständnis von Netz- und Messstellenbetreiber
  nicht mehr Voraussetzung ist.

### D9 — Vertrag, Haftung, Partnerschaft

- **Festlegung:** keine Vorgaben; Wechsel der Veräußerungsform nach §§ 21b, 21c EEG (T S. 2 Ziff. 5).
- **VoltPilot (E1 = D):** „mit Ihrem oder unserem Direktvermarkter“ — keine Exklusivität, jeder Direktvermarkter kann
  angebunden werden.
- **Der Direktvermarkter muss:** Laufzeit, Kündigung, Wechselfristen, Haftung (Ausgleichsenergie, verlorene Marktprämie
  bei fehlerhafter Bestimmung, Steuerungsfehler), Verfügbarkeitszusagen und eine Testumgebung für den Durchstich (MP-20)
  nennen, und sagen, ob er VoltPilot-Kunden als Partner gesondert führt.

## 2. Anfrage (gleichlautend an alle drei Kandidaten)

> Platzhalter in eckigen Klammern füllt der Captain. Der Text geht an alle drei Kandidaten wortgleich; nur Anrede und
> Empfänger ändern sich. Beilagen (Musterexport) erst nach Freigabe des Captains.

**Betreff:** Anfrage Direktvermarktung für Gewerbe-PV mit Speicher im Mischbetrieb nach MiSpeL (BNetzA, Az. 618-25-02)

Sehr geehrte Damen und Herren, [Anrede],

VoltPilot ist ein Energiemanagementsystem für Photovoltaik, Speicher und Ladepunkte im Gewerbe. Mit der Festlegung der
Bundesnetzagentur zur Marktintegration von Speichern und Ladepunkten (MiSpeL) vom 01.10.2026 können unsere Kunden ihren
Speicher künftig aus Solarstrom und aus dem Netz laden, ohne die Marktprämie für den Solarstrom zu verlieren
(Abgrenzungsoption, Anlage 1). Dafür muss die gesamte Netzeinspeisung in einem gesonderten Bilanzkreis nach § 20 S. 2 EEG
bilanziert werden — in der Regel beim Direktvermarkter.

Wir suchen einen Direktvermarkter, den wir unseren Gewerbekunden empfehlen und technisch anbinden. Unsere Kunden können
weiterhin ihren eigenen Direktvermarkter mitbringen; eine Exklusivität streben wir nicht an. Wir fragen drei
Direktvermarkter mit demselben Text an und vergleichen die Antworten.

**Was wir mitbringen:** eine monatliche Mengenbestimmung nach Anlage 1 (Formelsätze A1, A5, A10, A11) als CSV und PDF
mit allen Zwischenwerten, darunter die förderfähigen Mengen (26), (31), (32) und (33); einen Viertelstunden-Fahrplan je
Standort aus unserer Optimierung; eine Box am Standort, die Ist-Werte liest und Wechselrichter und Speicher regelt.

**Typische Anlagen:** Gewerbe mit 100–750 kWp PV in der Direktvermarktung und 65–500 kWh Speicher; Gewerbe ohne
EEG-Anlage mit einem reinen Speicher ab 100 kWh/50 kW; später Haushalte bis 30 kWp (Pauschaloption, Anlage 2).

**Unsere Fragen** (bitte nummeriert beantworten; „noch offen“ ist eine gute Antwort):

1. **Bilanzkreis (D1).** 1.1 Führen Sie für Anlagen in der Abgrenzungsoption einen gesonderten Bilanz- oder
   Unterbilanzkreis nach § 20 S. 2 EEG? 1.2 Ein Kreis je Einspeisestelle, oder mehrere MiSpeL-Einspeisestellen in einem
   gemeinsamen Kreis? 1.3 Was kostet er den Anlagenbetreiber, ab wann ist er verfügbar?
2. **Mischbetrieb (D2).** 2.1 Nehmen Sie Anlagen in der Abgrenzungsoption samt Speicher (Zuordnung nach Tenorziffer 5)
   an? 2.2 Übernehmen Sie die Zuordnung und die Angabe der Option im Auftrag des Anlagenbetreibers? 2.3 Tragen Sie einen
   Pilot in der Übergangszeit bis 30.09.2027 mit, wenn Netz- und Messstellenbetreiber einverstanden sind? 2.4 Wie
   berücksichtigen Sie, dass die Marktprämie dann nach dem Jahresmarktwert bestimmt wird?
3. **Mengen (D3).** 3.1 Welche Mengen brauchen Sie je Monat und Anlage, und von wem? 3.2 Nehmen Sie bis zur
   Marktkommunikation CSV und PDF an? 3.3 Wer vertritt die förderfähige Menge gegenüber dem Netzbetreiber? 3.4 Wie
   behandeln Sie Rumpfmonate und vorläufige Monate?
4. **Fahrplan und Steuerung (D4).** 4.1 Wer erstellt den Fahrplan — Sie, wir oder beide? 4.2 Format, Takt und Fristen
   (Day-Ahead, Intraday)? 4.3 Wie rechnen Sie Abweichungen ab? 4.4 Wollen Sie den Speicher selbst am Markt einsetzen, und
   wie teilen wir ihn mit dem Eigenverbrauch und der Lastspitzenkappung des Kunden?
5. **Fernsteuerung § 10b EEG (D5).** 5.1 Welche technische Einrichtung verlangen Sie heute? 5.2 Erkennen Sie unsere Box
   als gemeinsame Einrichtung nach § 10b Abs. 1 S. 2 EEG an, wenn sie Ihre Signale ausführt? 5.3 Wie planen Sie den
   Übergang auf das Smart-Meter-Gateway ab 01.01.2028?
6. **Kleine Anlagen (D6).** 6.1 Ab welcher Leistung nehmen Sie Anlagen an? 6.2 Was kostet eine Anlage unter 30 kWp
   (fest, variabel, Einrichtung)? 6.3 Werden Sie die Pauschaloption nach der EU-Genehmigung anbieten?
7. **Standalone-Speicher (D7).** 7.1 Vermarkten Sie Gewerbespeicher ohne EEG-Anlage hinter einem Verbrauchsanschluss?
   7.2 Ab welcher Größe, mit welchem Erlösmodell (Gewinnbeteiligung, Festpreis, Mindesterlös)?
8. **Daten und Marktkommunikation (D8).** 8.1 Beziehen Sie die Viertelstundenwerte des Messstellenbetreibers selbst?
   8.2 Wann sind Ihre MaKo-Prozesse für MiSpeL massengeschäftstauglich — spätestens zum 01.10.2027? 8.3 Auftragsverarbeitung
   und Datenschutz?
9. **Vertrag und Partnerschaft (D9).** 9.1 Laufzeit, Kündigung, Wechselfristen? 9.2 Haftung für Ausgleichsenergie,
   verlorene Marktprämie und Steuerungsfehler? 9.3 Verfügbarkeitszusagen? 9.4 Gibt es eine Testumgebung für die
   Anbindung? 9.5 Bieten Sie ein Partnermodell für Softwareanbieter an, und zu welchen Bedingungen?

Wir freuen uns über eine Antwort bis [Datum, Vorschlag: sechs Wochen nach Versand] und stehen für ein Gespräch zur
Verfügung. Ein anonymisierter Musterexport kann auf Wunsch beigelegt werden.

Mit freundlichen Grüßen
[Name, Funktion, Kontakt]

## 3. Kandidaten — Platzhalter-Vorschlag

Der Captain wählt je Gruppe einen Kandidaten (E8 = D); die Gruppen kommen aus Entscheid E8 (A–C). Belegt ist nur, was
mit URL dasteht (abgerufen 02.10.2026); alles andere steht als Frage in der Anfrage.

| Gruppe | Vorschlag | Öffentlich belegt | Als Frage offen |
|---|---|---|---|
| **A** PV + Speicher im Gewerbe | **LUOX Energy** (Marke der Lumenaza GmbH) | Direktvermarktung Gewerbe: „Fixes Dienstleistungsentgelt, das sich an der Erzeugungskapazität der Anlage orientiert“, „Variables Dienstleistungsentgelt von 3 % des absoluten Börsenwerts der eingespeisten Strommenge“, „Einmalige Einrichtungsgebühr in Höhe von 200 Euro“, Abrechnung „zu viertelstündlichen Day-Ahead-Börsenpreisen“, „kurze Kündigungsfristen“; Steuerung u. a. über SMA Cluster Controller/Data Manager M, Solar-Log, meteocontrol; Partner FENECON, Sigenergy — W `https://www.luox-energy.de/gewerbe/direktvermarktung`. Lumenaza Community heißt jetzt LUOX — *[sekundär]* `https://www.pv-magazine.de/unternehmensmeldungen/lumenaza-gmbh-laeutet-mit-der-marke-luox-energy-ein-neues-kapitel-fuer-verbraucher-und-produzenten-von-gruener-energie-ein/`. Multi-Use-Optimierung von Gewerbespeichern mit Furo — *[sekundär]* `https://www.photovoltaik.sh/news/multi-use-optimierung-von-gewerbe-und-industriebatteriespeichern-kombination-von-furo-software-und-luox-energy-markttarifen` | Höhe des fixen Entgelts; gesonderter Bilanzkreis nach § 20 S. 2 EEG; MiSpeL überhaupt; Standalone-Speicher (laut internem Vermerk zu OpenProject #492 nicht abgedeckt — unbelegt) |
| **B** Speicher-Vermarkter | **Entrix** (Alternativen: enspired, The Mobility House) | Industriespeicher „mit einer Leistung zwischen etwa 250 kW und 5 MW“; „erst ab rund 3 MW ist die Teilnahme an Energie- und Kapazitätsmärkten in der Praxis wirtschaftlich attraktiv“; Märkte Day-Ahead, Intraday, FCR, aFRR; Anbindung über „SCADA, API oder Gateway“ — W `https://www.entrixenergy.com/de/industriespeicher`. Tesvolt-Feldtest mit den Vermarktern Enspired, Entrix, The Mobility House, Mindestanschluss 50 kW/50 kWh — *[sekundär]* `https://www.pv-magazine.de/2025/11/25/feldtest-mit-tesvolt-gewerbespeichern-lassen-sich-vier-bis-fuenfstellige-summen-im-monat-erloesen/` | Erlösmodell; Direktvermarktung der PV mit Marktprämie (oder nur Speicher); gesonderter Bilanzkreis; Speicher unter 250 kW über Bündelung |
| **C** Großer Direktvermarkter | **Next Kraftwerke** (Alternative: Statkraft) | „Als Direktvermarkter im Leistungsbereich über 100 kW fokussieren wir unsere Antworten auf die Abgrenzungsoption“; „Auch wenn die MaKo-Anpassungen Zeit benötigen, darf die fehlende MaKo nicht zu einer Verzögerung der Umsetzung führen“ — St-Next S. 2, S. 4; Co-Location Green „ab 1 MW Batteriespeichergröße“ — W `https://www.next-kraftwerke.de/energie-blog/mispel-agnes-batteriespeicher` (16.04.2026). Statkraft: Solarstrom über Direktvermarktung, für den Speicher „ein Profit-Share-Modell“, „Wir steuern die Green-Co-Location-Anlage gezielt gemäß Preissignalen“ (34,5 MW PV, 12 MW/24 MWh) — *[sekundär]* `https://www.pv-magazine.de/2026/05/05/statkraft-wird-drei-photovoltaik-gruenstromspeicher-von-suncatcher-vermarkten/` | Anlagen unter 100 kW; Speicher unter 1 MW; Entgelte; Statkraft-Mindestgröße (in Suchtreffern „ab 50 kWp“, nicht belegt) |

**Was die Belege schon zeigen:** Die Speicher-Vermarkter und die großen Direktvermarkter nennen öffentlich Größen
oberhalb unserer Gewerbe-Beispiele (250 kW, 1 MW, 3 MW, 100 kW); nur LUOX nennt Preise und eine Zielgruppe ab kleinen
Anlagen. Darum fragt die Anfrage in jeder Gruppe nach Bündelung und Mindestgrößen.

## 4. Vergleichsraster für die Angebote

Je Kriterium 0–3 Punkte (0 = nicht angeboten, 1 = als Absicht, 2 = angeboten mit Einschränkung, 3 = angeboten und
belegt). **K.-o.** heißt: bei 0 scheidet das Angebot für Stufe 1 aus. Das Gewicht ist ein Vorschlag; der Captain legt es
fest, bevor die erste Antwort eintrifft.

| Nr. | Kriterium | Frage | K.-o. | Gewicht | Kandidat A | Kandidat B | Kandidat C |
|---|---|---|---|---|---|---|---|
| R1 | Gesonderter Bilanzkreis nach § 20 S. 2 EEG je Einspeisestelle | 1.1–1.2 | ja | 3 | | | |
| R2 | Abgrenzungsoption samt Speicher; Zuordnung im Auftrag | 2.1–2.2 | ja | 3 | | | |
| R3 | Pilot in der Übergangszeit bis 30.09.2027 | 2.3 | | 2 | | | |
| R4 | **MaKo-Reife zum 01.10.2027** (massengeschäftstauglich, Termin genannt) | 8.2 | | 3 | | | |
| R5 | **Konditionen** Gewerbe 100 kWp/65 kWh: fest €/a + variabel + Einrichtung + Bilanzkreis; Summe €/a | 1.3, 6.2 | | 3 | | | |
| R6 | Konditionen Speicher: Erlösmodell und Anteil für den Kunden | 4.4, 7.2 | | 2 | | | |
| R7 | **Mindestgrößen** PV / Speicher / Bündelung kleiner Anlagen | 6.1, 7.2 | | 3 | | | |
| R8 | **Schnittstellen** Mengen: nimmt CSV/PDF nach MP-16 bis zur MaKo | 3.1–3.2 | | 2 | | | |
| R9 | **Schnittstellen** Fahrplan: Format, Takt, wer plant | 4.1–4.2 | | 2 | | | |
| R10 | **Schnittstellen** Fernsteuerung § 10b über die VoltPilot-Box; Weg zum Smart-Meter-Gateway 2028 | 5.1–5.3 | | 3 | | | |
| R11 | Standalone-Speicher (A10/A11) | 7.1 | | 1 | | | |
| R12 | Pauschaloption für Haushalte nach EU-Genehmigung | 6.3 | | 1 | | | |
| R13 | **Haftung**: Ausgleichsenergie, verlorene Marktprämie, Steuerungsfehler — wer trägt was | 4.3, 9.2 | | 3 | | | |
| R14 | Laufzeit, Kündigung, Wechselfristen; keine Exklusivität | 9.1, 9.5 | | 2 | | | |
| R15 | Testumgebung für den Durchstich (MP-20) | 9.4 | | 2 | | | |
| R16 | Daten: MSB-Werte, Auftragsverarbeitung | 8.1, 8.3 | | 1 | | | |
| | **Summe** (Punkte × Gewicht) | | | | | | |

**Wirtschaftliche Probe zu R5:** Das Konzept rechnet beim Gewerbekunden a2 (100 kWp, 65 kWh, börsenindizierter Bezug)
mit einem knapp negativen Saldo, darin der gesonderte Bilanzkreis mit −300 / −150 / ±0 €/a (Schätzung). Liegen die
angebotenen Kosten für Bilanzkreis und Entgelt über 300 €/a, lohnt die Abgrenzungsoption für diese Größe nicht; das
Angebot bleibt dann für größere Anlagen (a3, a4) interessant. Die Zahlen gehen nach der Wahl in die Rollenprüfung (MP-44).

## 5. Versandprotokoll

Vom Captain auszufüllen; ohne Eintrag gilt eine Anfrage als nicht versandt.

| Kandidat | Freigabe Anfrage + Raster (Datum, durch) | Versandt am | an (Stelle, nicht Person) | Antwort bis | Antwort erhalten | Gespräch |
|---|---|---|---|---|---|---|
| A — [Name] | | | | | | |
| B — [Name] | | | | | | |
| C — [Name] | | | | | | |

## Was bewusst offen bleibt

- Die Auswahl der drei Kandidaten, die Gewichte im Raster, der Versand und die Gespräche (Captain).
- Der Adapter zum gewählten Direktvermarkter (MP-20) — erst nach der Wahl.
- Die Lesarten zu § 20 S. 2 EEG (ein Kreis für mehrere Einspeisestellen) und § 10b Abs. 1 S. 2 EEG (Box als gemeinsame
  Einrichtung) sind nicht abgestimmt; die Antworten der Kandidaten zeigen, ob sie in den [Rechtsfragen-Katalog](rechtsfragen.md) gehören.
- Kein Musterexport liegt bei; ein anonymisierter Export braucht die Freigabe des Captains.
