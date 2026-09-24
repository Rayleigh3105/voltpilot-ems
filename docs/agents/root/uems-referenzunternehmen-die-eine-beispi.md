# UEMS-Referenzunternehmen Ahrenberg: die EINE Beispielquelle aller Pakete

Angelegt am 11.09.2026 mit Fassung 1.1 der Datei (Abgleich mit den gemergten UEMS-Verträgen
AP-01 bis AP-07 und dem Rechte-Vertrag). **Fassung 1.2 seit 12.09.2026** (AP-09 IP-2 + AP-10 IP-2,
Entscheide E1–E17 und E19 = A).

**[`docs/contracts/v2/uems-referenzunternehmen.json`](../../contracts/v2/uems-referenzunternehmen.json)**
+ Schema ist die EINZIGE Quelle für Kennzeichen, Werte und Zeitpunkte der „Kunststoffwerk
Ahrenberg GmbH“. Ein Fall, der ein Ahrenberg-Objekt benutzt, nennt dessen Kennzeichen und
übernimmt dessen Werte, nie abweichend. Was ein Fall dazuerfindet, steht in seinem `annahme`.

## Die Formen, die jedes Paket übernimmt

- **Zwei Zeitformen.** TAGESGENAU (AP-02 E9): Ort → Elternknoten, Anlage → Standort,
  Messstelle → Ort, elektrische Stellung, Kostenstellen-Anteile, Kostenstellen und
  Bezugsflächen. `gueltig_ab` ist ein Tag (`2024-03-12`), `gueltig_bis` der LETZTE gültige Tag,
  einschließlich; die alte endet am Vortag der neuen. MINUTENGENAU (AP-04 E2, AP-06 E1):
  führende Quellen, Geräte-Einbauten, Stromwandler und Datenquelle → Box, halboffen
  `[ab, bis)`. Alles andere ist ein Zeitpunkt. Wer einen Tag als Zeitpunkt braucht, nimmt
  00:00 Uhr am Standort (TS `mitternacht` aus `uemsOrtsbaum.ts`) und rechnet sonst nichts um.
- **Orte sind zeitgültig** (`zuordnungen`, Art `ort_eltern`). Beim Standort ist das sein
  Bestehen, `nach` bleibt `null`. Die festen Felder `gebaeude[].standort` und
  `bereiche[].eltern` zeigen den Stand zur Momentaufnahme.
- **`U` ist das Unternehmen als Ort** (MS-19). `KB-AHRENBERG` ist der Kundenbereich
  (`unternehmen.kundenbereich`).
- **Rückwirkend (AP-02 E2):** eine Tages-Zuordnung oder Fläche, die nach ihrem „gültig ab“
  eingetragen wurde, trägt `eingetragen_am` und das `abzeichen` des Ortsbaum-Vertrags
  (Tage = Eintragstag − gilt ab). Die Bestandsanlage AN-1 bringt ihren Verlauf ab 12.03.2024
  mit, eingetragen am 01.10.2026, also „rückwirkend (933 Tage)“. Der Anbau Halle 2 hat
  „rückwirkend (14 Tage)“.
- **Protokolle** stehen im Vokabular des Datenquellen-Vertrags (`modbus_tcp`, `ocpp`). Bei OCPP
  ist die Adresse die Stations-Kennung.
- **Unterstützung:** `seit` ist ein Zeitpunkt, `gueltig_bis` das ENDDATUM — ein Kalendertag,
  einschließlich (Elektro Brunner bis 15.12.2026, der Zugriff endet am 16.12.2026 00:00). Nur ein
  Notfall-Zugriff endet auf die Minute, 24 h nach `seit`.
- **Vergleichsquelle:** MS-01 ← K-1 · Einspeise-/Bezugsleistung am Wechselrichter, Zweck
  „Plausibilität“, ab 20.11.2026 08:30 (eingetragen von Ines Kaltenbach). Die Form ist die
  `vergleichsbindung` des Messstellen-Vertrags, je Größe (`vergleichsquellen`, sonst `[]`).
- **Box Halle 2 am 03.11.2026:** 14:00 Ausfall, die Box puffert. Um 17:30 kommt sie zurück und
  liefert nach. Das Netzteil ist defekt, die Box läuft aber bis zum Tausch weiter. Am
  04.11.2026 um 09:38 übernimmt E-2′.

## Was die Fassung 1.2 dazugelegt hat (12.09.2026)

Rein ADDITIV, mit ZWEI entschiedenen Berichtigungen. Jede andere Angabe der Fassung 1.1 steht
unverändert in 1.2 — das prüfen beide Zwillinge, und die Berichtigungen rechnen sich aus der
Datei selbst nach.

- **Bezugsgrößen** tragen neben ihrem freien Text die GESCHLOSSENEN Vokabulare des
  Bezugsdaten-Vertrags: `einheit_code`, `periode_code`, `wertart`, `messstelle`.
  `einheit` bleibt „kg Granulat“, `einheit_code` ist `kg` — der Stoff wandert nie in die
  Einheit. `geltung_art` nimmt zusätzlich die übrigen Geltungsbereiche aus AP-09 E1 an
  (die 1.1-Werte `prozess` und `ort` bleiben). Neu: **BZ-5** „Ladezeit Ladepunkt Halle 2“
  (`geltung_art: messstelle` → MS-14). Ein Stammdatum hat KEINE Periode, ein Periodenwert
  immer eine.
- **`MS-21.ablesungen[]`** — die beiden manuellen Gas-Ablesungen (01.10. 07:15 = 48 211 m³,
  02.11. 07:40 = 49 451 m³, beide von JW). Die Monatszuordnung steht an der SCHLIESSENDEN
  Ablesung; die erste eröffnet nur und ordnet nichts zu. Zwischen zwei Ablesungen wird nie
  interpoliert.
- **MS-22 „Lindach nicht zugeordnet“** — der Rest der Bilanz von AN-3 (`formel_typ: rest`,
  Ort „keiner“ wie MS-20, keine Kostenstellen-Anteile). Ohne ihn hätte Lindach eine
  unsichtbare Bilanzdifferenz von 1 200 kWh. Damit sind es **22 Messstellen, davon 5
  berechnete**.
- **`formel_typ`** je berechneter Messstelle, aus `messstelle-formel.md` §0: MS-09 · MS-15 ·
  MS-22 `rest`, MS-19 · MS-20 `gewichtete_summe`.
- **`beispielwerte.tag_2026_10_18_kwh`** — die Plan-Abnahme des Captains an echten Zahlen:
  MS-16 100, MS-17 60, MS-18 30, MS-22 10 kWh.
- **`beispielwerte.oktober_2026_laden_kwh`/`_entladen_kwh`** an MS-04 (7 900 / 7 100). Der
  Speicher geht mit ZWEI Anteilen in eine Bilanz ein, nie als Saldo 800.
- ⚠ **Zwei entschiedene Berichtigungen** (AP-10 E19 = A) — die EINZIGEN Stellen, an denen 1.2
  einen 1.1-Wert anfasst:
  **MS-09 Oktober 52 600 → 54 580 kWh** (Befund W10: die eigenen Eingänge der Formel ergeben
  54 580) und **`gueltig_bis: 2026-12-31` an den vier 9000-Anteilen** (MS-02, MS-03, MS-04,
  MS-09; Befund W8: kein Anteil gilt über das Bestehen seiner Kostenstelle hinaus). Die
  Nachfolge-Anteile bleiben OFFEN — ab 2027 ist MS-03 ehrlich „nicht verteilt“, nie still auf
  9010/9020 umgehängt.

## Was die Fassung 1.5 dazugelegt hat (21.09.2026, AP-15 IP-1, E8 = A)

Rein ADDITIV: ohne ihre Zusätze ist die Datei Zeichen für Zeichen 1.4 (Fingerabdruck in beiden
Zwillingen). Neu ist die **gemeinsame Steuerung** von AN-1 — zwei steuernde Boxen hinter NA-1:

- **Box E-4 „Box Verwaltung“** (Heimat AN-1, `fuehrend_fuer: null`, LAN 192.168.40.0/24) ab
  03.05.2027, Nachfolgerin **E-4′** ab dem Box-Tausch 12.10.2027 (R17; Seriennummer frei gewählt).
  DQ-8 (PV-Wechselrichter, Steuerquelle), DQ-9 (sechs Ladepunkte OCPP, Steuerquelle), DQ-10
  (Abgangszähler = eigener Messpunkt), Geräte GR-11 … GR-18, Komponenten K-12, K-13.1 … K-13.6, K-14.
- **„Höchstens eine Steuerquelle je Anlage“ gilt nur OHNE gemeinsame Steuerung.** Mit ihr liest
  jede Steuerquelle eine Mitglied-Box mit Heimat in der Anlage.
- **`netzanschluss_grenzen[]`** (tagesgenau): NA-1 ab 03.05.2027 Einspeisung 100, Bezug 550 kW.
- **`gemeinsame_steuerungen[]`** V-1: E-1 `fuehrt` (Messpunkt DQ-2), E-4/E-4′ `steuert_mit`
  (DQ-10), Stufen S0/S2/S3 (kein S4 — nicht gebaut), Auslegung 40/60 und 0/77 kW, Vorbehalt 473
  = 430 × 1,1. **`geraete_rueckfaelle[]`** je steuerbarer Komponente und Richtung.
- **`abnahmefaelle_ap15`**: R1 … R22 mit „gegeben“ wörtlich aus AP-15 §7; R16 `stand: entwurf`.
- ⚠ **Zeitachsen-Zeilen mit `gemeinsame_steuerung: V-1`** verlängern die Zeitachse nur für die
  gemeinsame Steuerung. Wer den Horizont der übrigen Welt misst (Fortschreibungen der
  Messstellen-Vektoren), nimmt genau diese Zeilen aus — ein Wächterfall bricht, sobald eine davon
  eine Messstelle, Datenquelle oder Bezugsgröße der Messstellen-Vektoren nennt.
- ⚠ **Bestands-Spiegel nehmen die Objekte der `steuert_mit`-Boxen aus** (benannte Regel):
  `src/test/datenquellenFixtures.test.ts` (Bühne, fällt mit AP-15 IP-23 weg) und
  `MessstelleRegisterApiTest` (legt nur den Bestand an). `UemsDatenquelleMigrationTest` leitet
  seine Kennzeichen aus der Datei ab und legt DQ-8 … DQ-10 mit an.

## Was die Fassungen 1.6 bis 1.8 dazugelegt haben (22./23.09.2026)

Herkunft je Fassung: `_herkunft.fassung_1_6` … `fassung_1_8` in der Datei. Jede Fassung legt ihre
Zusätze in eigene Blöcke oder markierte Zeilen, damit „ohne die Zusätze = Vorgänger“ nachrechenbar
bleibt (Nachtrag AP-18 IP-3, 24.09.2026).

- **1.6 (AP-16 IP-1, E11 = A):** `bewertung_umfang`, Prozess P-7, `energieeinsaetze[]` EE-1 … EE-8,
  `bewertung_kriterien[]`, `einstufungen[]`, `messbedarfe[]` MB-1, MS-23 mit GR-19/K-15,
  `messmittel_angaben[]`, die Toleranz an der Vergleichsquelle von MS-01, die Bewertungs-Berichte
  BW-2026-0001/BW-2027-0001, `abnahmefaelle_ap16` und elf Zeilen der Zeitachse. Zahlen 2027 sind
  ausdrücklich Annahmen.
- **1.7 (Befund aus PR 1104, AP-16 IP-17):** K-1 steht an MS-01 zusätzlich an der Hauptgröße
  Wirkenergie Bezug (`herleitung: integration`) und trägt dort die Toleranz-Fassung; die
  Zeitachsen-Zeile vom 20.11.2026 nennt beide Größen; `abnahmefaelle_ap16` ergänzt R9. ⚠ Keine
  reine Ergänzung — der Rückweg zu 1.6 setzt K-1 an die Nebengröße zurück.
- **1.8 (AP-17 IP-1, E12 = A, E9 = C):** `bezugsgroessen_1_8` BZ-8, `kennzahlen_1_8` KZ-0006,
  `fassungen` an den Kennzahlen, `bezugsbasen[]` BB-0001 … BB-0005, `leistungsvergleiche[]`
  VB-2028-0001, `abnahmefaelle_ap17` und dreizehn Zeitachsen-Zeilen mit `bezugsbasis`. ⚠ Zwei
  W12-Nachträge ändern Bestandswerte: die Eingänge der Einstufungen von EE-5/EE-6 nennen jetzt
  die Einzelwerte der Messstellen (Summen gleich). `null` sind Monatswerte MS-10 Jan./Feb. 2027 und
  die Prüfsumme von VB-2028-0001/1; die `sha256:…`-Kürzel in den gegeben-Blöcken sind Platzhalter
  des Konzepts, nachrechenbar ist nur die Prüfsumme in `bezugsbasen[]`. Die Koeffizienten sind
  gröber gerundet als der Vertrag einfriert (siehe `uems-bezugsbasis-vertrag.md`).

**Falle für die nächste Fassung:** `UemsReferenzunternehmenVectorsTest` hält je Fassung einen
Fingerabdruck (`FASSUNG_1_x_SHA256`) und die Zahl der `_comment`-Zeilen (`KOMMENTAR_ZEILEN_1_x`)
fest; `ohneFassung18` nimmt die Zusätze von 1.8 heraus und muss danach 1.7 treffen,
`ohneFassung19` (AP-18 IP-1) ebenso bis 1.8. Wer die nächste Fassung anlegt, schreibt ihr
`ohneFassung…` samt Fingerabdruck der Vorgängerin, hängt Kommentarzeilen nur ANS ENDE
von `_comment` und fährt beide Zwillinge sowie die Leser der Datei (siehe unten).

## Die Prüfungen

Die Zwillinge Java `uems/UemsReferenzunternehmenVectorsTest` und TS
`src/uemsReferenzunternehmen.test.ts` prüfen dieselben Invarianten:

- Schema über `UemsSchemaLaeufer`.
- Kein Ziel vor seinem Bestehen (Ortsbaum `ziel_gab_es_noch_nicht`).
- Jeder Wechsel stößt an: am Folgetag oder auf die Minute.
- Das Abzeichen jedes rückwirkenden Eintrags ist das des Ortsbaum-Vertrags; die Zeitachse
  nennt kein anderes.
- Die Ortsfelder stimmen mit der Zuordnung zur Momentaufnahme überein.
- Eine Vergleichsquelle überlappt nie mit demselben Messwert und ist nie zugleich führend.
- Dazu Hauptzähler, 100 % Anteile, eine Box je Datenquelle, eindeutige Kennzeichen und kein
  Verweis ins Leere.

Seit Fassung 1.2 zusätzlich (beide Zwillinge, dieselben Prüfungen):

- **Jede berechnete Messstelle rechnet ihren eigenen Oktober-Wert** aus den Beispielwerten
  ihrer eigenen Eingänge (MS-09, MS-15, MS-19, MS-20, MS-22). Das ist der DAUERHAFTE Nachweis
  der Berichtigung W10 — und der Grund, warum eine neue Zahl in der Datei nicht mehr still
  falsch sein kann.
- **Die Plan-Abnahme rechnet:** 100 − 60 − 30 = 10 kWh am 18.10.2026, Richtung „Bezug“, der
  Rest ohne Ort und ohne Gerät.
- **Kein Kostenstellen-Anteil gilt länger als seine Kostenstelle** (W8).
- **Die Ablesungen sind eine Kette steigender Stände**; die erste ordnet keinen Monat zu, ein
  zugeordneter Monat wird von seinem Ablesezeitraum berührt.
- **Jede Bezugsgröße nutzt das geschlossene Vokabular** von `bezugsdaten-vectors.json`
  (`einheiten`, `periode_art`, `wertart`, `geltung_art`); `formel_typ` das von
  `messstelle-formel.md` §0.

Seit Fassung 1.5 zusätzlich: Steuerquellen je Anlage (s. o.), die gemeinsame Steuerung hängt an
Anlage, Netzanschluss und führender Box, die Auslegung rechnet aus Grenze, Grundlast und
Rückfällen, jeder Rückfall hängt an einer steuerbaren Komponente, und die „gegeben“-Werte der
Abnahmefälle sind die Objekte der Datei.

Gegen die Datei prüfen außerdem die Tests der Messstellen, der Herkunft, der Datenquellen, der
Rechte und die Migrationstests `UemsStandortMigrationTest`, `UemsOrteMigrationTest` und
`MessstelleMigrationTest` (Testcontainers). **Wer die Datei ändert, fährt alle
davon.** Sie laufen mit `./mvnw clean test -Dtest='com.voltpilot.api.uems.*Test'` und
`npx vitest run src/uems*.test.ts src/rechte.test.ts`.

## Was die Fassung 1.9 dazugelegt hat (24.09.2026, AP-18 IP-1, W8/W9)

Rein ADDITIV: `ohneFassung19` nimmt die Zusätze heraus, dann ist die Datei Zeichen für Zeichen
1.8 (Fingerabdruck in beiden Zwillingen). Neu sind Ziele, Maßnahmen und Abweichungen:

- **Sechs neue Wurzel-Schlüssel** (§8 IP-1 zählte vier — Zählfehler, AP-18 B.6 B5):
  `energieziele[]` (EZ-2028-0001), `massnahmen[]` (M-2028-0001 mit Messgrundlage, M-2028-0002
  ohne), `abweichungen[]` (AW-2026-0001, AW-2028-0001), `auffaelligkeiten[]` (drei Vermerke),
  `kennzahlen_1_9_monate` (KZ-0004 04/2028–01/2029, Annahme) und `abnahmefaelle_ap18` (R1, R3–R8,
  R12 „gegeben“ wörtlich).
- **Nachträge in Bestandsblöcken:** K-2028-0001 in `korrekturen[]`, EE-3 Fassung 3 in
  `einstufungen[]` (Fassung 2 endet am 19.11.2028), `pflege[]` nur an BB-0001.
- **Nachlese 24.09.2026 (Z7–Z9, Lesarten LA7/LA8), innerhalb von 1.9:** R3 nennt für EE-1 die
  Einstufungs-Fassung 1 (keine Ausnahme mehr in den Zwillingen). EE-3 Fassung 3 urteilt nach
  Kriterien-Fassung 2 K1 `ueber_schwelle` (6,2 % ≥ 5 %), Vorschlag `ueber_schwelle`, Einstufung
  der Person `nicht_wesentlich` — die Abweichung vom Vorschlag ist `vorschlag` ≠ `einstufung`,
  wie bei EE-3 Fassung 1; ein eigenes Feld gibt es nicht. ⚠ **Eine berechnete Messstelle wird nie
  direkt berichtigt:** K-2028-0001 trifft MS-06 (−600 kWh), MS-20 und KZ-0004 stehen in `folgen[]`;
  `berichtigungsFehler` in beiden Zwillingen prüft das. Werte ohne Konzept-Beleg nennt
  `korrekturen[].annahme.felder`. Die Oktober-Rechnung der Zwillinge liest nur Korrekturen der
  Periode 2026-10.
- **Ein Muster für jeden Vorgang:** Verantwortlicher aus `personen[]`, Termin bzw. Frist, `zustand`
  = letzter Schritt eines append-only `verlauf[]`. Jeder Schritt ist einer der 18 Übergänge aus AP-18
  `vorgaenge.json` (Tabelle `UEBERGAENGE` in beiden Zwillingen). `person: null` gibt es nur bei
  Schritten der Naht (`auffaelligkeit_vermerkt`, `anstoss_gesetzt`).
- **Kopien mit Prüfsumme** (Anlass, Ausgangslage, Stand der Wirkung, Ziel-Stand): sha256 über den
  kanonischen Text wie bei den Grundlagen von 1.8. Wer eine Zahl in einer Kopie ändert, rechnet die
  Prüfsumme neu. Die Rot-Proben der Zwillinge zeigen, was dann bricht.
- ⚠ **Zeitachsen-Zeilen mit `verbesserung`** sind fachfremd für den Messstellen-Horizont
  (`MessstelleRegelnVectorsTest`, `uemsMessstelle.test.ts` nehmen sie aus) — wie
  `gemeinsame_steuerung`, `energetische_bewertung` und `bezugsbasis`.
- **Σ erwartet** ist die Summe der UNgerundeten Monatswerte `a + b·kg`, erst die Summe wird auf
  ganze kWh gerundet (663 139, nicht 663 140).

## Gesehen, bewusst nicht angefasst

- **Kennungen der Datei ≠ Kennungen des Produkts (AP-19 W11, 24.09.2026).** `BW-2026-0001`/`BW-2027-0001`
  (Bewertungs-Berichte, 1.6) und `VB-2028-0001` (Leistungsvergleich, 1.8) sind Konzept-Kennungen; das Produkt
  nennt jeden Bericht `BR-JJJJ-nnnn` (`bericht_kennung_chk` in `V20260915050000`), die Familie steht an `vorlage`.
  Nachweise vergleichen Berichte darum über Vorlage und Zeitraum, nie über den Präfix; die Managementbewertung
  heißt in Datei und Produkt `BR-2029-0001`. Die `bezugsbasen[]` tragen keinen Verantwortlichen — das Produkt
  verlangt ihn und leitet ihn nach AP-17 B4 aus dem Verantwortlichen der Kennzahl ab (`V20260924071500`). Die
  Datei bleibt, wie sie ist.
- **Claudia Berger und Werk Lindach.** Ihre Zuweisung „seit 01.10.2026“ gilt auch für Werk
  Lindach, das erst ab 15.10.2026 besteht (AP-03 §4.1).
- **`messstelle-vectors.json`, Fall `vorschlag-naechste-nummer`** sagt in seiner Begründung
  „Ahrenberg hat 21 Messstellen“ und pinnt `zaehler: 21` → `MS-0022`. Der Fall rechnet mit
  SEINEN EIGENEN Eingängen und bleibt grün; ihn zu ändern hieße, einen Abnahmefall zu ändern.
  Die Reihe MS-01…MS-22 der Referenzdatei kollidiert nicht mit dem Vorschlag MS-0022.
