# VoltPilot-Registerbild WAGO v1 (UEMS AP-05 IP-2)

Stand 15.09.2026 · Vertrag 1.0 · Registerbild Hauptversion 1, Nebenversion 0 · Konzept
`data/vp-uems-ap05-wago` §4.1, §4.5, §4.6, §8 IP-2 · Entscheide E1, E2, E4, E9 vom 10.09.2026.

Das Registerbild ist eine **Vereinbarung, kein Programm.** Auf einer WAGO-Steuerung PFC200/PFC100 kommt
von außen niemand an die 3-Phasen-Leistungsmessklemmen („Energiekarten“) heran — „No direct access from
fieldbus to the process image for I/O modules“ (Handbuch 750-8212 S. 8). Ein Programm muss die Werte
kopieren. Dieser Vertrag legt fest, **wohin**: in einen zusammenhängenden Registerbereich aus Kopf und je
einem gleich gebauten Block pro Karte 750-494/-495, den die Box per Modbus TCP liest. Den Baustein baut der
Installateur in das bestehende Programm ein und bleibt Eigentümer (E2, Referenzbaustein IP-3). Gelesen wird
das Registerbild von der Treiberfamilie `wago.registerbild` (IP-6, IP-7).

**Stand vor dem Pilot.** Nichts hier ist an einer Steuerung belegt. Es gibt keine Hardware und weder einen
eingebauten Baustein noch einen ausgelieferten Leser. Darum trägt jede Zahl ihre Herkunft (§1). Was am Gerät
festzustellen ist, steht gesammelt in §9.

| Datei | Rolle |
|---|---|
| [`wago-registerbild.md`](./wago-registerbild.md) | dieser Vertrag |
| [`wago-registerbild-vectors.json`](./wago-registerbild-vectors.json) | Aufbau, Herkunft jeder Angabe, 13 Lese-Fälle V1–V13 (alle `herkunft: vertrag`, `belegt: false`) |
| [`wago-registerbild.schema.json`](./wago-registerbild.schema.json) | Schema der Vektor-Datei (Teilmenge des UEMS-Schema-Läufers) |
| `frontend/portal/src/wagoRegisterbild.test.ts` | Prüfer: Schema, lückenloser Aufbau, Herkunft jeder Zahl, Vertrag ⟷ Datei ⟷ Hardwareblatt-Vorlage, Rechenbeispiele, ein unabhängiger Leser über alle Fälle |

**Zwillinge gibt es noch keine.** Wer den Aufbau ändert, ändert Vektor-Datei, Vertrag und Test gemeinsam —
sobald IP-6/IP-7 gebaut sind, auch deren Leser.

## 1. Drei Arten von Zahlen

| Herkunft | Bedeutung | Beispiel |
|---|---|---|
| **Festlegung** | Dieser Vertrag bestimmt die Zahl. Sie sagt nichts über Hardware, nur wie Programm und Box sich verständigen. | Signatur 0x5650 0x5242, Kopflänge 12 |
| **Handbuch** | Wörtlich in einem WAGO-Handbuch belegt, mit Seite — und nur für die Artikel, für die dieses Handbuch spricht. | Messwert-ID 074 (Handbuch 750-495 S. 81) |
| **zu erheben** | Am Gerät festzustellen (Erhebungsbogen, Hardwareblatt, Pilotschritt). Kein Schätzwert, keine Null. | Basisadresse, Wortfolge |

Dazu kommt eine Zahl aus dem Repository: höchstens 120 Wörter je Anfrage (§7). In der Vektor-Datei steht
jede Zahl als Angabe mit `art`, `fundstelle` und bei Handbuch-Angaben `gilt_fuer`; der Test prüft, dass das
zitierte Handbuch den Artikel überhaupt abdeckt.

⚠ **Die Handbuch-Angaben zu Messwert-IDs, Datentypen, Skalierung, den Kartenregistern 32/35 und „ungültig“
stammen aus dem Handbuch der 750-495.** Für die 750-494 — die Karte an Ahrenberg C-1 — belegen die
ausgewerteten Zitate nur den Aufbau des Prozessabbilds (24 Byte, Handbuch 750-494 S. 39). Alles andere ist
dort **zu erheben**, auch wenn es gleich aussehen dürfte. Das gilt besonders für den Energie-Faktor: ob ein
Schritt bei der 750-494/000-001 0,01 kWh oder 0,05 kWh ist, ist **nicht belegt** (Befund aus IP-1). Ein um
Faktor fünf falscher Zählerstand sieht nur „etwas hoch“ aus.

## 2. Parameter je Anlage

Nicht fest verdrahtet — hier unterscheiden sich echte Anlagen. Die Werte stehen in der Hardwareblatt-Fassung
und gelten ab ihrem Gültigkeitsbeginn.

| Parameter | Werte | Herkunft |
|---|---|---|
| Basisadresse | Protokolladresse (0-basiert, so wie sie im Telegramm steht) des ersten Kopf-Worts; 0 … 65 535; Basisadresse + Kopflänge + Kartenzahl · Kartenblocklänge ≤ 65 536 | zu erheben: Programm → Hardwareblatt §3, Pilotschritt 1 |
| Funktionscode | 3 (Holding Register) oder 4 (Input Register) | zu erheben: Programm → Hardwareblatt §4, Pilotschritt 1 |
| Wortfolge | `big` = höherwertiges Wort zuerst, `little` = niederwertiges zuerst; gilt für jeden 32-bit-Wert (Prüfwert, Kennung, Messwerte). Im Messpunkt-Katalog: `big` → `big`, `little` → `word_little_byte_big` (`catalog/measurement-points/schema/catalog.schema.json:205`) | zu erheben: Hardwareblatt §3, Pilotschritt 2 |
| Soll | Kartenzahl, Controller-Kennung, je Karte Steckplatz, Kartentyp, Variante | zu erheben: Erhebungsbogen B1/B2 → Hardwareblatt §2 |

- Innerhalb eines Worts gilt die Byte-Reihenfolge des Modbus-Protokolls. Parameter ist nur, in welcher
  Reihenfolge die zwei Wörter eines 32-bit-Werts stehen.
- Die Unit-ID gehört nicht zum Registerbild, sondern zur Datenquelle — dort ist sie Parameter, nie Identität
  (Konzept §6.2).

## 3. Kopf (12 Wörter ab der Basisadresse)

| Offset | Wörter | Feld | Typ | Inhalt | Herkunft |
|---|---|---|---|---|---|
| 0 | 1 | `signatur_1` | UInt16 | 0x5650 („VP“) | Festlegung |
| 1 | 1 | `signatur_2` | UInt16 | 0x5242 („RB“) | Festlegung |
| 2 | 1 | `hauptversion` | UInt16 | 1 | Festlegung |
| 3 | 1 | `nebenversion` | UInt16 | 0; steigt mit jeder additiven Stufe (§6) | Festlegung |
| 4 | 1 | `kopflaenge` | UInt16 | 12; ein Leser verlangt ≥ 12 | Festlegung |
| 5 | 1 | `kartenblocklaenge` | UInt16 | 42; ein Leser verlangt ≥ 42 | Festlegung |
| 6 | 1 | `kartenzahl` | UInt16 | Anzahl der Karten-Blöcke | Wert zu erheben (Soll) |
| 7 | 1 | `herzschlag` | UInt16 | je Sekunde + 1, beim Programmstart 0, von 65 535 auf 0 | Takt, Start, Überlauf: Festlegung; Wert zu erheben |
| 8 | 2 | `wortfolge_pruefwert` | UInt32 | 0x01020304 = 16 909 060 | Festlegung |
| 10 | 2 | `controller_kennung` | UInt32 | vom Installateur gesetzte Zahl, 0 = nicht gesetzt | Bedeutung: Festlegung; Wert zu erheben (Soll) |

- **Signatur und Versionen sind einzelne Wörter.** Die Wortfolge ändert sie nicht; ein Leser erkennt das
  Registerbild, bevor er die Wortfolge braucht. Das Konzept nennt „VP“; ausgeschrieben sind es zwei Wörter,
  damit ein zufälliger Registerinhalt nicht als Registerbild durchgeht.
- **Herzschlag.** Ein Leser schließt daraus genau zwei Dinge: steht er über **3 aufeinanderfolgende
  Lesungen**, sind die Werte eingefroren — Qualität `stale`, keine Samples als gemessen (Konzept §4.6,
  §6.3). Ist er kleiner als bei der letzten Lesung, ohne dass ein Überlauf passt, ist das Programm neu
  angelaufen (Ereignis-Bedarf IP-8). Eine Uhrzeit leitet niemand daraus ab: ob die Steuerung den
  Sekundentakt hält, ist zu erheben (Pilotschritt 1, zwei Lesungen).
- **Wortfolge-Prüfwert.** Das Programm schreibt 0x01020304 mit derselben Routine wie jeden Messwert. Liest
  die Box ihn mit dem Parameter nicht als 0x01020304, gibt es keinen Kartenwert (§5). Der Prüfwert bestätigt
  den Parameter, er ersetzt ihn nicht: ein eigenes Programm des Kunden kann Messwerte anders kopieren, darum
  prüft Pilotschritt 2 die Wortfolge an echten Zählerständen. Vorbild ist der feste Byte-Order-Test 0x2002 =
  0x1234 des Kopplers 750-362 (Handbuch 750-362 S. 202).
- **Die Controller-Kennung ist kein Identitätsbeweis.** Sie zeigt nur, ob unter der Adresse die Steuerung
  antwortet, die das Hardwareblatt erwartet — C-1 und C-2 können dasselbe Registerbild an derselben Adresse
  tragen (Konzept §6.2). Das Gerät bleibt über die Seriennummer vom Typenschild identifiziert; eine Adresse
  beweist keine Gerätegleichheit.

## 4. Karten-Block (42 Wörter je Karte)

Karte n (ab 0 gezählt) beginnt bei Basisadresse + Kopflänge + n · Kartenblocklänge — immer mit den Längen
**aus dem Kopf**, nie mit 12 und 42 als Konstanten.

| Offset | Wörter | Feld | Typ | Inhalt | Herkunft |
|---|---|---|---|---|---|
| 0 | 1 | `steckplatz` | UInt16 | Position am Klemmenbus; 1 = erste Klemme rechts neben der Steuerung | Zählweise: Erhebungsbogen B1; Wert zu erheben |
| 1 | 1 | `kartentyp` | UInt16 | 494 oder 495 (Artikelnummer ohne „750-“) | Vokabular: Festlegung (E1); Schreibweise wie die Klemmenliste des Kopplers (Handbuch 750-362 S. 205); Wert zu erheben |
| 2 | 1 | `variante` | UInt16 | Teil 1 · 1000 + Teil 2: /000-001 → 1, /025-001 → 25 001, ohne Variante → 0 | Festlegung; Wert zu erheben |
| 3 | 1 | `gueltigkeit` | Bitfeld | welche Teile das Programm gelesen hat (§4.1) | Festlegung |
| 4 | 1 | `kartenregister_32` | UInt16 | Rohwert; Bit 12 … 15 = Anwenderskalierung | Handbuch 750-495 S. 85; welches Bit welche Phase meint: zu erheben |
| 5 | 1 | `kartenregister_35` | UInt16 | Rohwert; zulässig 0 … 6, Werkseinstellung 4 | Handbuch 750-495 S. 274 Tab. 67 |
| 6 | 12 | `statuswoerter` | 3 × 4 UInt16 | je Gruppe Statuswort 1 und erweiterte Statuswörter 1–3 (§4.2) | Handbuch 750-362 S. 225 Tab. 203 |
| 18 | 24 | `messwerte` | 12 × 32 bit | Standardsatz in Kartenskalierung (§4.3) | Handbuch 750-495 S. 62 Tab. 26; 750-494 S. 39 |

- **Identität der Karte = (Gerät, Steckplatz)** (E4). Kartentyp und Variante prüfen nur, ob die erwartete
  Karte steckt; ein Umstecken wird sichtbar und nie still umgehängt.
- **„Kartenregister“ heißt: Register in der Karte** (Registerkommunikation, Handbuch 750-495 S. 63) — nie eine
  Modbus-Adresse des Registerbilds. Das Programm kopiert ihren Rohwert; Faktor und Bitbedeutung liest die
  Cloud aus der Hardwareblatt-Fassung.

### 4.1 Gültigkeit

| Bit | Name | Bedeutung |
|---|---|---|
| 0 | `karte_gelesen` | Messwerte und Statuswörter stammen aus einem vollständigen Lesesatz; 0 = keine Kartenwerte (Karte gezogen, Klemmenbusfehler) |
| 1 | `kartenregister_32_gelesen` | Kartenregister 32 wurde gelesen |
| 2 | `kartenregister_35_gelesen` | Kartenregister 35 wurde gelesen |
| 3 | `statuswoerter_gelesen` | die zwölf Statuswörter wurden gelesen |
| 4–15 | — | in 1.0 immer 0; eine Nebenversion darf ihnen Bedeutung geben |

Ist ein Bit 0, ist der Teil **unbekannt** — seine Wörter werden nicht gelesen, auch nicht als 0. Ein
eigenes Bitfeld braucht es, weil nicht belegt ist, ob das Programm die Kartenregister überhaupt lesen kann,
und weil ein Register keinen „ungültig“-Wert hat, den das Programm stattdessen schreiben könnte.

### 4.2 Statuswörter

Die Karte liefert je Auswahl vier Prozesswerte und dazu Statuswort 1 und die erweiterten Statuswörter 1–3
(Handbuch 750-495 S. 62 Tab. 26; im Koppler-Abbild vier Eingangsworte, Handbuch 750-362 S. 225). Die Flags
beziehen sich auf die gerade gewählten Werte — „Bereichsbegrenzung Prozesswert x“ meint den x-ten Wert der
Auswahl (Handbuch 750-495 S. 55). Darum trägt der Block die Statuswörter **je Gruppe**:

| Gruppe | Wörter im Block | deckt Messwert |
|---|---|---|
| 1 | 6–9 | 1–4 |
| 2 | 10–13 | 5–8 |
| 3 | 14–17 | 9–12 |

- **Packung (Festlegung):** Wort = Byte(2k) · 256 + Byte(2k+1), Byte 0 der Karte steht also im
  höherwertigen Byte von Statuswort 1.
- **Zu erheben:** die Bitlage der Bereichsbegrenzung (Hardwareblatt Zeile 13, Pilotschritt 2) — und ob sich
  die vier Messwerte jeder Gruppe in EINER Auswahl lesen lassen. Zitiert ist nur „010 = AC-Messwerte“
  (Handbuch 750-495 S. 63), nicht die Kollektion jeder einzelnen Messwert-ID. Findet IP-3 oder Pilotschritt 1
  anderes, gilt der Vorbehalt aus §6.

### 4.3 Messwerte (Standardsatz E9)

Zwölf 32-bit-Werte in der Skalierung der Karte, unverändert, in der Reihenfolge der Hardwareblatt-Zeilen
1–12; das Statuswort der Zeile 13 sind die Wörter aus §4.2. Im Registerbild wird nichts umgerechnet —
Einheit, Faktor und Wertart kommen aus Katalog (IP-4) und Hardwareblatt-Fassung. Wirkleistung gesamt steht
nicht im Prozessabbild (Handbuch 750-495 S. 54) und ist kein Feld; die Box bildet sie als Summe (E9).

| Nr. | Offset | Wörter | Feld | Messwert | Gruppe | Messwert-ID | Datentyp | Kartenskalierung (belegt nur für 750-495) |
|---|---|---|---|---|---|---|---|---|
| 1 | 18 | 2 | `energy_import_total` | Wirkenergie Bezug gesamt (Zählerstand) | 1 | 074 | UInt32 | Kartenregister 35 = 4: 0,01 kWh (1 A) · 0,05 kWh (5 A) |
| 2 | 20 | 2 | `energy_export_total` | Wirkenergie Lieferung gesamt (Zählerstand) | 1 | `zu erheben` | `zu erheben` | wie Nr. 1 |
| 3 | 22 | 2 | `power_l1` | Wirkleistung L1 | 1 | 007 | Int32 | 0,01 W (1 A) · 0,05 W (5 A) |
| 4 | 24 | 2 | `power_l2` | Wirkleistung L2 | 1 | 008 | Int32 | wie Nr. 3 |
| 5 | 26 | 2 | `power_l3` | Wirkleistung L3 | 2 | 009 | Int32 | wie Nr. 3 |
| 6 | 28 | 2 | `voltage_l1` | Spannung L1 | 2 | 004 | UInt32 | 0,01 V |
| 7 | 30 | 2 | `voltage_l2` | Spannung L2 | 2 | 005 | UInt32 | 0,01 V |
| 8 | 32 | 2 | `voltage_l3` | Spannung L3 | 2 | 006 | UInt32 | 0,01 V |
| 9 | 34 | 2 | `current_l1` | Strom L1 | 3 | 001 | UInt32 | 0,0001 A (1 A, Rogowski) · 0,0005 A (5 A) |
| 10 | 36 | 2 | `current_l2` | Strom L2 | 3 | 002 | UInt32 | wie Nr. 9 |
| 11 | 38 | 2 | `current_l3` | Strom L3 | 3 | 003 | UInt32 | wie Nr. 9 |
| 12 | 40 | 2 | `frequency` | Netzfrequenz | 3 | `zu erheben` | UInt32 | 0,001 Hz |

Fundstellen: Messwert-IDs, Datentypen und Faktoren Handbuch 750-495 S. 79–81 (074 auf S. 81), Frequenz S. 74
(Beispiel 2), Energie S. 274 Tab. 67.

- **Ungültig ist nicht 0.** Der größte Wert des Datentyps heißt ungültig — UInt32 4 294 967 295, Int32
  2 147 483 647 (Handbuch 750-495 S. 79 Tab. 27) → kein Wert. Maßgeblich ist der Datentyp des Felds:
  0xFFFFFFFF in einem Int32-Feld ist −1 und damit ein Wert (V7).
- **Ohne belegten Datentyp kein Wert.** Messwert 2 liefert nie eine Zahl, bis Pilotschritt 1 den Datentyp
  erhoben hat. Das Nachtragen ändert kein Wort und keine Bedeutung — es ist additiv.
- **Das Vorzeichen der Wirkleistung ist zu erheben** (Pilotschritt 2 gegen den Vergleichszähler). Bis dahin
  leitet niemand daraus Bezug oder Einspeisung ab. Die Zählerstände Bezug und Lieferung bleiben getrennt
  (Konzept §4.5).

## 5. Lesen: in dieser Reihenfolge

1. Signatur ≠ 0x5650 0x5242 → `signatur_fremd`
2. Hauptversion ≠ 1 → `hauptversion_fremd`
3. Kopflänge < 12, Kartenblocklänge < 42, zu wenige Wörter oder über den Adressraum hinaus → `laenge_ungueltig`
4. Prüfwert, gelesen mit dem Parameter Wortfolge, ≠ 0x01020304 → `wortfolge_abweichend`
5. Kartenzahl ≠ Soll → `kartenzahl_abweichend`
6. Controller-Kennung ≠ Soll → `controller_kennung_abweichend`

Jeder dieser Gründe heißt **nicht lesbar: kein einziger Kartenwert** — lieber keine Zahl als eine falsche
(Konzept §5.4). Bei 5 und 6 ist der Kopf selbst lesbar und darf angezeigt werden („4 Karten statt 3“).

Danach je Karte:

1. Kartentyp nicht 494 oder 495 → `kartentyp_fremd`
2. Steckplatz, Kartentyp oder Variante ≠ Soll → `aufbau_abweichend`
3. Gültigkeit Bit 0 = 0 → `nicht_gelesen`
4. sonst `gelesen`: Messwerte roh und nach Datentyp, Kartenregister und Statuswörter nur mit gesetztem Bit

Welche Findings und Ereignisse daraus werden (`registerbild_unbekannt`, `layout_changed`, `frozen_source`,
`device_restart`), bauen IP-7 und IP-8. Dieser Vertrag legt nur fest, wann ein Wort ein Wert ist.

## 6. Versionierung

- **Additiv heißt anhängen.** Eine Nebenversion verlängert den Kopf (Kopflänge), den Karten-Block
  (Kartenblocklänge) oder gibt einem bisher immer 0 gesetzten Gültigkeitsbit Bedeutung. Kein Wort ändert je
  seinen Offset oder seine Bedeutung.
- **Ein Leser navigiert mit den Längen aus dem Kopf** und überspringt Wörter, die er nicht kennt (V6). Ein
  Feld gibt es, wenn Offset + Wörter ≤ Länge; fehlt es in einer älteren Fassung, ist es unbekannt, nicht 0.
  Die Nebenversion ist Auskunft, keine Weiche.
- **Hauptversion 2** braucht, wer etwas entfernt, verschiebt oder umdeutet. v1 und v2 können an zwei
  Basisadressen nebeneinander stehen; welche die Box liest, sagt die Hardwareblatt-Fassung ab ihrem
  Gültigkeitsbeginn.
- **Vorbehalt vor dem Pilot.** Solange kein Baustein beim Kunden läuft und kein Leser ausgeliefert ist (Stand
  heute), berichtigt ein PR eine Annahme, die IP-3 oder Pilotschritt 1 widerlegt, in Fassung 1.0 selbst —
  Vertrag, Vektor-Datei und Test gemeinsam. Ab dem ersten eingebauten Baustein oder ausgelieferten Leser gilt
  die additive Regel ohne Ausnahme.
- Beispiel für eine spätere 1.1: das Wandlerverhältnis aus den Kartenregistern 39–42 (Handbuch 750-495 S. 85)
  als zusätzliche Wörter am Blockende, mit Gültigkeitsbit 4.

## 7. Größe und Anfragen

Das Registerbild ist 12 + 42 · K Wörter lang. Die Box liest höchstens 120 Wörter je Anfrage
(`edge-app/nodered/measurements/measurement-planner.js:97`) und **teilt einen Karten-Block nie auf zwei
Anfragen** — sonst könnten die Hälften aus zwei verschiedenen Lesesätzen stammen.

| Karten | Wörter | Anfragen je Lesung | Beispiel |
|---|---|---|---|
| 1 | 54 | 1 | — |
| 2 | 96 | 1 | C-2 Lindach (EK-5, EK-6) |
| 3 | 138 | 2 | — |
| 4 | 180 | 2 | C-1 Halle 2 (EK-1 … EK-4) |
| 5 | 222 | 3 | C-1 ab 01.03.2027 mit EK-7 |

⚠ **Abweichung vom Konzept:** E9 rechnet für Ahrenberg mit einer Anfrage je Minute, IP-6 mit mehreren
Blöcken erst ab vier Karten. Mit Statuswörtern je Gruppe braucht C-1 zwei Anfragen je Lesung, bei 60 s also
zwei von 30 erlaubten Anfragen je Minute (`measurement-planner.js:6`). Die Grenze bleibt weit entfernt.

## 8. Rechenbeispiele

Die Kopf-Wörter von V1: `0x5650 0x5242 0x0001 0x0000 0x000C 0x002A 0x0004 0x06C3 0x0102 0x0304 0x0000 0x0001`
= Registerbild 1.0, Kopf 12, Block 42, 4 Karten, Herzschlag 1 731, Controller-Kennung 1.

Wörter → Wert (der Test rechnet jede Zeile nach; gegengerechnet mit `python3`):

| Wörter | Wortfolge | Datentyp | Wert | Anmerkung |
|---|---|---|---|---|
| `0x0038 0x52F0` | big | UInt32 | 3 691 248 | Zählerstand EK-1 in V1 (ausgedacht) |
| `0x52F0 0x0038` | little | UInt32 | 3 691 248 | dieselbe Zahl, Wörter getauscht |
| `0x0038 0x5470` | big | UInt32 | 3 691 632 | Rohwörter aus Konzept §4.11 — sie ergeben NICHT 3 691 248 |
| `0x0009 0x6FC5` | big | UInt32 | 618 437 | Zählerstand EK-3 in V1 |
| `0x0009 0x6F85` | big | UInt32 | 618 373 | Rohwörter aus Konzept §4.11 — sie ergeben nicht 618 437 |
| `0xFFFF 0x8AD0` | big | Int32 | −30 000 | Wirkleistung L3 an EK-1 in V1 |
| `0xFFFF 0xFFFF` | big | Int32 | −1 | ein Wert, nicht „ungültig“ |
| `0xFFFF 0xFFFF` | big | UInt32 | kein Wert | UInt32 ungültig |
| `0x7FFF 0xFFFF` | big | Int32 | kein Wert | Int32 ungültig |
| `0x0102 0x0304` | big | UInt32 | 16 909 060 | Wortfolge-Prüfwert |
| `0x0304 0x0102` | big | UInt32 | 50 594 050 | Prüfwert eines little-Programms, als big gelesen → `wortfolge_abweichend` (V3) |

Rohwert × Faktor — nur, wo der Faktor belegt ist:

| Rohwert | Faktor | Ergebnis | gilt für |
|---|---|---|---|
| 3 691 248 | 0,01 kWh | 36 912,48 kWh | 750-495 (1 A), Kartenregister 35 = 4 — Handbuch 750-495 S. 274 Tab. 67 |
| 3 691 248 | 0,05 kWh | 184 562,40 kWh | 750-495/000-001 (5 A), Kartenregister 35 = 4 — ebd. |
| −30 000 | 0,05 W | −1 500 W | 750-495/000-001 (5 A) — Handbuch 750-495 S. 79–81; was das Vorzeichen bedeutet, ist zu erheben |

**An C-1 (750-494/000-001) gibt es keine kWh-Zahl**, bis Pilotschritt 2 den Faktor erhoben hat: derselbe
Rohwert wäre 36 912,48 oder 184 562,40 kWh.

## 9. Was am Gerät zu erheben ist

| Angabe | Warum offen | Wo |
|---|---|---|
| Basisadresse, Funktionscode | vergibt das Programm des Installateurs | Hardwareblatt §3/§4, Pilotschritt 1 |
| Wortfolge | hängt an der Kopierroutine des Programms | Pilotschritt 2 (Prüfwert und echter Zählerstand) |
| Kartenzahl, Steckplätze, Kartentypen, Varianten, Controller-Kennung | Aufbau der Anlage | Erhebungsbogen B1/B2, Pilotschritt 1 |
| Messwert-ID von Wirkenergie Lieferung gesamt und Netzfrequenz | nicht in den ausgewerteten Handbuchseiten (zitiert: Lieferung L1–L3 = 070–072) | Pilotschritt 1 |
| Datentyp von Wirkenergie Lieferung gesamt | ebenso | Pilotschritt 1 |
| Jede Angabe aus dem Handbuch 750-495, angewandt auf die 750-494 | die Messwert-Tabelle der 750-494 ist nicht ausgewertet | Pilotschritt 1/2 |
| Energie-Faktor je Karte (Kartenregister 35) | bei der 750-494 nicht belegt: 0,01 oder 0,05 kWh | Pilotschritt 2 |
| Welches Bit von Kartenregister 32 welche Phase meint | nur „Bit 12 … 15“ zitiert | Pilotschritt 2 |
| Bitlage der Bereichsbegrenzung in den Statuswörtern | nicht zitiert | Pilotschritt 2 |
| Vier Messwerte jeder Gruppe in einer Auswahl lesbar | Kollektion je Messwert-ID nicht zitiert | IP-3, Pilotschritt 1 |
| Ob das Programm die Kartenregister 32/35 lesen kann | Registerkommunikation oder Bibliothek am PFC nicht belegt | IP-3, Pilotschritt 1 |
| Vorzeichen der Wirkleistung | nicht zitiert | Pilotschritt 2 |
| Sekundentakt des Herzschlags | hängt am Task der Steuerung | Pilotschritt 1 (zwei Lesungen) |
| Ob eine Anfrage einen halb geschriebenen Karten-Block sehen kann | Zusammenspiel Modbus-Dienst und Task nicht belegt | Pilotschritt 1 |
| Funktionscodes 3 und 4 unter e!RUNTIME | belegt nur für CODESYS 2.3 (Handbuch 750-8202 S. 183) | Pilotschritt 1 |

## 10. Abgrenzung

Dieser Vertrag ist kein Treiber (IP-6, IP-7, IP-8), kein Baustein (IP-3), keine Katalog-Familie (IP-4),
keine Simulator-Vorstufe (IP-12) und kein Pilot-Beleg (IP-14). Die Registerliste eines Kunden (E1 Stufe A1)
und das Prozessabbild des Kopplers (AW-2) sind andere Wege und nicht Teil des Registerbilds. Erhebungsbogen,
Hardwareblatt-Vorlage und Referenzdatensatz-Schema: [`docs/wago/`](../../wago/erhebungsbogen.md),
[`wago-referenzdatensatz.schema.json`](./wago-referenzdatensatz.schema.json).

## Quellen (abgerufen 10.09.2026)

| Kurzname | Dokument |
|---|---|
| Handbuch 750-495 | Handbuch 750-495 3-Phasen-Leistungsmessmodul, Version 1.3.0, © 2023 — https://www.wago.com/wagoweb/documentation/750/ger_manu/modules/m07500495_xxxxxxxx_0de.pdf |
| Handbuch 750-494 | Handbuch 750-494(/xxx-xxx), Version 1.5.0 — https://www.wago.com/wagoweb/documentation/750/ger_manu/modules/m07500494_xxxxxxxx_0de.pdf |
| Handbuch 750-362 | Manual 750-362 FC Modbus TCP G4, Version 1.1.1 — https://www.wago.com/wagoweb/documentation/750/eng_manu/coupler_controller/m07500362_xxxxxxxx_0en.pdf |
| Handbuch 750-8212 | Product manual 750-8212 PFC200 G2 2ETH RS, FW 04.05.08(27) — https://www.wago.com/wagoweb/documentation/750/eng_manu/coupler_controller/m07508212_xxxxxxxx_0en.pdf |
| Handbuch 750-8202 | Manual 750-8202 PFC200 2ETH RS, Version 3.12.0 — https://www.wago.com/wagoweb/documentation/750/eng_manu/coupler_controller/m07508202_xxxxxxxx_0en.pdf |
