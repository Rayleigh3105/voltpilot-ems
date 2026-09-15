# WAGO-Hardwareblatt: Vorlage für den Nachweis

Das Hardwareblatt belegt, dass VoltPilot eine **Kombination** — Steuerung · Energiekarte (WAGO:
3-Phasen-Leistungsmessklemme) · Ausgabeweg — wirklich lesen kann: Messwert für Messwert, von der Quelle
in der Karte bis zur Messstelle, mit Register, Rohwert, Skalierung und Einheit. Ein Blatt gilt für eine
Kombination (dann „unterstützt“) oder für eine einzelne Anlage (dann „belegt je Kunde“, Entscheid E8).

> **Der Simulator dient dem Bauen, nie dem Beleg.** Eine Zeile wird nur durch Pilotschritt 2 — den
> Vergleich gegen eine unabhängige Referenz am echten Gerät — „belegt“. Simulator, Handbuch und
> Erhebungsbogen setzen nie etwas auf „belegt“.

## So füllen Sie es aus

**Woher jede Angabe kommt.** Jedes Feld nennt seine Quelle. Eine Angabe aus einer anderen Quelle gehört
nicht hinein.

| Quelle | Was sie beitragen darf |
|---|---|
| **Bogen** | Das Soll: was der Kunde im [Erhebungsbogen](erhebungsbogen.md) angegeben hat (mit Nummer). |
| **Handbuch** | Feste Eigenschaften: Messwert-ID, Datentyp und Skalierung der Karte; feste Register von Koppler und Steuerung. Immer mit Dokument, Version und Seite. |
| **Programm** | Registeradressen, die die Kundenanwendung vergibt: aus Registerliste oder Projektdatei (mit Datei und Stand). |
| **Schritt 1** | Pilot-Protokoll „Zugriff“: was die Box tatsächlich gelesen hat — Rohwörter mit Uhrzeit. |
| **Schritt 2** | Pilot-Protokoll „Vergleich“: was gegen die Referenz stimmt oder abweicht. |

**Keine Registeradresse aus dem Gedächtnis.** Eine Adresse steht nur im Blatt, wenn sie aus dem Programm,
aus einem Handbuch (feste Register) oder aus einem Pilot-Protokoll stammt.

**Leer heißt „noch nicht erhoben“.** Wer etwas nicht weiß, schreibt `zu erheben` und dazu, welcher
Schritt es klärt — nie einen Schätzwert, nie eine 0.

**Nachweis je Zeile** — genau eines dieser Wörter:

| Wort | Bedeutung |
|---|---|
| `nicht belegt` | Ausgangszustand. Bleibt so nach Simulator, Handbuch und Bogen. |
| `belegt (Pilot <Datum>)` | Pilotschritt 2 hat die Zeile gegen die Referenz bestätigt; im Referenzdatensatz steht mindestens ein Fall `belegt: true` dazu. |
| `abweichend (<Grund>)` | Pilotschritt 2 hat einen Unterschied gefunden; der Grund steht in der Zeile. |
| `Regel, kein Register` | Der Wert wird auf der Box gebildet, nicht gelesen (Wirkleistung gesamt). |

---

## 1 Kopf

| Feld | Eintrag | Woher |
|---|---|---|
| Kombination | Steuerung · Energiekarte · Ausgabeweg | Bogen A1, B2, A3/A4 |
| Blatt gilt für | ☐ die Kombination ☐ nur die Anlage: ______ (belegt je Kunde) | Auswertung des Bogens |
| Fassung | Nr. ___ · gilt ab (Datum, Uhrzeit) ___ · Anlass ___ · Vorgänger-Fassung ___ | Abschnitt 7 |
| Steuerung (Gerät) | Hersteller WAGO · Artikelnummer ___ · Seriennummer ___ (vom Typenschild oder aus der Web-Oberfläche, getippt) · Firmware ___ | Bogen A1, A2; Schritt 1 |
| Programm | Name ___ · Stand ___ · geschrieben von ___ · gepflegt von ___ | Bogen A3 |
| Typenschild per Modbus | PFC: Register 0xFA10–0xFA17 ☐ gelesen (Rohwörter im Protokoll) ☐ antwortet nicht · Koppler: 0x2010–0x2014 und Klemmenliste 0x2030 ff. ☐ gelesen | Handbuch; Schritt 1 |
| Datenquelle | Modbus TCP · IP-Adresse ___ · Port ___ · Geräte-ID ___ (beim Koppler ignoriert) · Netz/VLAN ___ | Bogen D1 |
| Zuständige Box | Box ___ · seit ___ | Bogen D2; Portal |
| Weitere Leser | wer ___ · Verbindungen ___ · Takt ___ | Bogen D3 |
| Modbus-Watchdog | ☐ aus ☐ an, Zeit ___ | Bogen D4 |

## 2 Karten — eine Zeile je Karte

| Karte | Steckplatz | Artikelnummer | Karten-Firmware | Wandler Primär/Sekundär oder Rogowski | Anwenderskalierung | Wandler angewendet | Register 35 (Energie-Auflösung) | Speicherintervall Energiezähler (Register 46) | Anschlussart (Messtopologie) | Komponente |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |

| Spalte | Woher | Hinweis |
|---|---|---|
| Steckplatz, Artikelnummer | Bogen B1, B2; Schritt 1 | Die Karte ist (Steuerung, Steckplatz) — Entscheid E4. Kartenzahl und Reihenfolge prüft Schritt 1 gegen den Bogen. |
| Karten-Firmware | Schritt 1, falls lesbar | Sonst `zu erheben`; über den Bus nicht belegt lesbar. |
| Wandler | Bogen B3 | Rogowski-Karten haben kein Wandlerverhältnis und keine Anwenderskalierung. |
| Anwenderskalierung | Bogen B4 → Schritt 2 | ein = Karte liefert Primärwerte; aus = Sekundärwerte 1:1 (Werkseinstellung). |
| Wandler angewendet | Schritt 2 | `in der Karte eingestellt, nur dokumentiert` oder `von VoltPilot angewendet (Faktor n)` — Entscheid E5. Solange `zu erheben`, wird der Messwert nicht als Hauptgröße einer Messstelle gebunden. |
| Register 35 | Bogen B5 → Schritt 1 | Werkseinstellung 4; zulässig 0–6. |
| Register 46 | Schritt 1 | 60–255 s; so viel Zählerstand kann bei einem Stromausfall fehlen. |
| Messtopologie | Bogen B5 → Schritt 1 | Ab Karten-Firmware 05 wählbar; darunter fest eingestellt. |
| Komponente | Portal | Je Karte genau eine Komponente. |

## 3 Ausgabeweg und Registerbild

| Feld | Eintrag | Woher |
|---|---|---|
| Ausgabeweg | ☐ AW-1 Modbus TCP aus dem Programm, VoltPilot-Registerbild ☐ AW-1 Registerliste des Kunden ☐ AW-2 Prozessabbild des Kopplers ☐ anderer: ___ | Bogen A3, A4 |
| Registerbild: Version im Kopf | ___ (Rohwörter) | Schritt 1 |
| Registerbild: Signatur im Kopf | ___ (Rohwörter) | Schritt 1 |
| Kartenzahl im Kopf | gelesen ___ · laut Bogen B2 ___ · ☐ stimmt überein | Schritt 1 |
| Herzschlag | Lesung 1 ___ · Lesung 2 ___ · Abstand ___ s · ☐ zählt | Schritt 1 |
| Basisadresse | ___ | Programm; Schritt 1 |
| Wörter je Karte | ___ | Vertrag „VoltPilot-Registerbild WAGO v1“ |
| Wortfolge der 32-bit-Werte | ☐ höherwertiges Wort zuerst (`big`) ☐ niederwertiges zuerst (`little`) | Schritt 2 |
| Registerliste des Kunden (statt Registerbild) | Datei ___ · Stand ___ · Zeilen ___ | Bogen A4, E2 |
| Koppler (statt Registerbild) | Klemmenliste 0x2030 ff. ___ · Abbildgrößen 0x1022/0x1023 ___ · Wortversatz je Karte ___ | Handbuch 750-362; Schritt 1 |

## 4 Zeilen — ein Messwert je Zeile

Die Zeilen 1–13 sind der Standardsatz je Karte (Entscheid E9, Lesetakt 60 s) und werden **für jede
Karte** wiederholt. Vorausgefüllt ist nur, was das Handbuch belegt; alles andere trägt die Messung ein.

| Nr. | Messwert | Karte / Steckplatz | Quelle in der Karte: COL_ID · MET_ID · Datentyp | Register: Adresse · Funktionscode · Wörter | Rohwörter (Lesung, Uhrzeit) | Skalierung → Einheit | Wertart | Messkanal | Messstelle | Referenz | Nachweis |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Wirkenergie Bezug gesamt (Zählerstand) | | 010 · 074 · UInt32 | | | Register 35 = 4: 0,01 kWh, bei 5-A-Karten „/000-001“ 0,05 kWh ¹ → kWh | Zählerstand | | | Zuwachs über ≥ 1 h gegen Vergleichszähler (Ablesung) | nicht belegt |
| 2 | Wirkenergie Lieferung gesamt (Zählerstand) | | 010 · `zu erheben` ² · `zu erheben` | | | wie Nr. 1 → kWh | Zählerstand | | | wie Nr. 1 | nicht belegt |
| 3–5 | Wirkleistung L1 / L2 / L3 | | 010 · 007 / 008 / 009 · Int32 | | | 0,01 W (1 A) · 0,05 W (5 A) → kW | Momentanwert | | | Zangenmessgerät | nicht belegt |
| 6–8 | Spannung L1 / L2 / L3 | | 010 · 004 / 005 / 006 · UInt32 | | | 0,01 V → V | Momentanwert | | | Zangenmessgerät | nicht belegt |
| 9–11 | Strom L1 / L2 / L3 | | 010 · 001 / 002 / 003 · UInt32 | | | 0,0001 A (1 A, Rogowski) · 0,0005 A (5 A) → A | Momentanwert | | | Zangenmessgerät | nicht belegt |
| 12 | Netzfrequenz | | 010 · `zu erheben` ² · UInt32 | | | 0,001 Hz → Hz | Momentanwert | | | Vergleichsmessgerät mit Frequenzanzeige | nicht belegt |
| 13 | Statuswort (mit erweiterten Statuswörtern) | | Eingangswort 0 (erweitert 1–3) · Bitfeld | | | Bits → Qualität je Wert; Flag „Bereichsbegrenzung Prozesswert x“ — Bitlage `zu erheben` | Zustand (Bitfeld) | | — | Ereignisprüfung, Abschnitt 5 | nicht belegt |
| 14 | Wirkleistung gesamt | Summe der Karte | nicht im Prozessabbild ³ | — | — | Summe Nr. 3–5 auf der Box → kW | Momentanwert, berechnet auf der Box | | | — | Regel, kein Register |
| 15 | Herzschlag des Programms | Steuerung | Kopf des Registerbilds, vom Programm gezählt | | | UInt16, zählt hoch, läuft über → „Programm läuft“ | Zustand | | — | zwei Lesungen, Abschnitt 3 | nicht belegt |

¹ Handbuch 750-495, S. 274 Tab. 67 („Register 35 – Skalierungsfaktor für Energiewerte“). Für die 750-494
ist die Tabelle nicht belegt; welcher Faktor gilt, entscheidet Pilotschritt 2.
² Diese Messwert-ID steht nicht in den ausgewerteten Handbuchseiten. Belegt sind nur Wirkenergie Lieferung
L1–L3 (070–072) und der Faktor 0,001 Hz der Frequenz.
³ Handbuch 750-495, S. 54: Gesamtleistungen „können nicht über das Prozessabbild ausgelesen werden“.

**Regeln für jede Zeile**

- **Ungültig ist nicht 0.** Der größte Wert des Datentyps bedeutet „ungültig“ — UInt32 4 294 967 295,
  Int32 2 147 483 647 (Handbuch 750-495, S. 79). Die Zeile hält fest, was die Box daraus macht: kein Wert,
  Qualität `invalid`.
- **Rohwörter sind die Wahrheit.** Eingetragen werden die Registerwörter so, wie sie über Modbus kamen,
  in Lesereihenfolge — nie aus dem erwarteten Wert zurückgerechnet.
- **Wertart je Zeile:** Zählerstand, Momentanwert, Zustand oder „berechnet auf der Box“. Sie entscheidet
  Aufbewahrung und Rechenregel.
- **Messkanal und Messstelle** kommen aus dem Portal. Eine Zeile ohne Messstelle ist erlaubt
  (Plausibilität, Vergleichsquelle) und trägt `—`.

## 5 Verhalten — die drei offenen Fragen je Kombination

Die ersten zwei klärt der Vergleich. Die übrigen drei Prüfungen stören die Werte kurz und laufen **nur im
Wartungsfenster, mit Zustimmung von Kunde und Installateur** (Bogen E3). Ohne Zustimmung bleibt die Zeile
`nicht belegt` und der Erfahrungswert aus dem Bogen wird eingetragen.

| Frage | Zustimmung (wer, wann) | Ergebnis | Rohwörter / Protokoll | Erfahrungswert aus dem Bogen | Nachweis |
|---|---|---|---|---|---|
| Wo lebt der Zählerstand? | — | ☐ in der Karte ☐ im Programm | | C1 | |
| Primär- oder Sekundärwerte? | — | ☐ Primärwerte (in der Karte eingestellt) ☐ Sekundärwerte, Faktor ___ | | B3, B4 | |
| Steuerung kurz stromlos: laufen die Zählerstände weiter? | | Stand vorher ___ · Stand nachher ___ · Dauer ___ · Herzschlag neu begonnen ☐ | | C2 | |
| Zähler mit WAGO-I/O-CHECK zurückgesetzt: sieht die Box es? | | Stand vorher ___ · nachher ___ · Ereignis `counter_reset` ☐ | | C3 | |
| Karte gezogen: sieht die Box den geänderten Aufbau? | | Kartenzahl im Kopf vorher ___ · nachher ___ · Ereignis `layout_changed` ☐ | | — | |

## 6 Nachweis und Freigabe

| Feld | Eintrag |
|---|---|
| Pilotschritt 1 (Zugriff) | Datum ___ · Ort ___ · Prüfer ___ · Protokoll `docs/wago/pilot/<datum>-schritt1.md` |
| Pilotschritt 2 (Vergleich) | Datum ___ · Ort ___ · Prüfer ___ · Protokoll `docs/wago/pilot/<datum>-schritt2.md` |
| Vergleichsquellen | Zähler ___ mit Ablesung (Uhrzeit, Stand) ___ und ___ · Zangenmessgerät (Typ) ___ |
| Wartungsfenster | Zustimmung von ___ am ___ · ☐ keine Zustimmung |
| Referenzdatensatz | Datei ___ nach [`wago-referenzdatensatz.schema.json`](../contracts/v2/wago-referenzdatensatz.schema.json) |
| Ergebnis | ☐ unterstützt ☐ belegt je Kunde ☐ in Prüfung — Pilot ausstehend |
| Geprüft von | Name, Firma, Datum |

**Unterstützt** heißt: jede Zeile, die das Blatt führt, trägt `belegt` oder `Regel, kein Register`, und
der Referenzdatensatz hat für jeden dieser Messwerte mindestens einen Fall `belegt: true`. Fälle aus dem
Simulator tragen `belegt: false` und zählen nicht — das Schema weist einen Simulator-Fall mit
`belegt: true` ab.

## 7 Fassungen

Eine neue Fassung entsteht, wenn sich ändert: Wandler, Anwenderskalierung, Register 35, Registerbild-Version
oder Programm, eine Karte wird getauscht (Entscheid E6) oder die Steuerung wird getauscht. Die neue Fassung
gilt ab einem Zeitpunkt; ältere Werte bleiben ihrer Fassung zugeordnet.

| Fassung | gilt ab | Anlass | was sich ändert | Nachweis |
|---|---|---|---|---|
| 1 | | | | |

---

## Beispiel: Ahrenberg, Steuerung C-1, Karte EK-1 (vor dem Pilot)

Aus dem [Erhebungsbogen-Beispiel](erhebungsbogen.md#beispiel-kunststoffwerk-ahrenberg-halle-2-steuerung-c-1)
und [`uems-referenzunternehmen.json`](../contracts/v2/uems-referenzunternehmen.json). Die Registeradressen
bleiben absichtlich `zu erheben`: bei C-1 vergibt sie das Programm.

**Kopf:** Kombination PFC200 750-8212 (Firmware 04.05.08(27)) · 750-494/000-001 · AW-1 Modbus TCP aus dem
Programm, VoltPilot-Registerbild v1 · Gerät GR-7 „WAGO-Controller C-1“, Seriennummer `zu erheben`
(Pilotschritt 1), Programm „Halle2_Energie“ (Elektro Brunner, 2019) · Datenquelle DQ-4, Modbus TCP
192.168.20.10:502, Geräte-ID 1, VLAN 20 „Produktion“ · zuständig Box E-2 bis 04.11.2026 09:38, seither
E-2′ „Box Halle 2 (neu)“ · Weitere Leser: Gebäudeleittechnik, 1 Verbindung, alle 10 s · Watchdog aus.

**Karten:** EK-1 Steckplatz 2 · 750-494/000-001 · Wandler 400/5 A · Anwenderskalierung `zu erheben`
(Pilotschritt 2) · Register 35 `zu erheben` (Pilotschritt 1) · Komponente K-8.1. Ebenso EK-2 (Steckplatz 3,
250/5 A, K-8.2), EK-3 (Steckplatz 4, 100/5 A, K-8.3), EK-4 (Steckplatz 5, 60/5 A, K-8.4).

| Nr. | Messwert | Karte / Steckplatz | Quelle in der Karte | Register | Rohwörter | Skalierung → Einheit | Wertart | Messkanal | Messstelle | Nachweis |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Wirkenergie Bezug gesamt | EK-1 / 2 | 010 · 074 · UInt32 | `zu erheben` (Programm) | `zu erheben` | Faktor `zu erheben` (0,01 oder 0,05 kWh) → kWh | Zählerstand | Wirkenergie Bezug | MS-10 Netzbezug Halle 2 (Hauptgröße) | nicht belegt |
| 3–5 | Wirkleistung L1–L3 | EK-1 / 2 | 010 · 007–009 · Int32 | `zu erheben` | `zu erheben` | 0,05 W → kW | Momentanwert | Wirkleistung | MS-10 (Nebengröße) | nicht belegt |
| 14 | Wirkleistung gesamt | EK-1 | nicht im Prozessabbild | — | — | Summe L1–L3 → kW | berechnet auf der Box | Wirkleistung gesamt | MS-10 (Nebengröße) | Regel, kein Register |
| 15 | Herzschlag | C-1 | Kopf des Registerbilds | `zu erheben` | `zu erheben` | UInt16 | Zustand | — | — | nicht belegt |

**Fassungen:** Fassung 1 gilt ab dem Pilot. Fassung 2 ab 01.02.2027: Wandler EK-2 250/5 A → 400/5 A.

---

## Quellen

WAGO-Dokumentation, abgerufen am 10.09.2026 (Belege des Konzepts AP-05):

- Handbuch 750-495 „3-Phasen-Leistungsmessmodul“, Version 1.3.0 —
  <https://www.wago.com/wagoweb/documentation/750/ger_manu/modules/m07500495_xxxxxxxx_0de.pdf>
  (S. 54 Gesamtleistung und Energiezähler, S. 55 Speicherintervall und Bereichsbegrenzung, S. 62–64
  Prozessabbild und COL_ID/MET_ID, S. 74 Frequenz, S. 79–81 Datentypen und Faktoren, S. 85 Anwenderskalierung,
  S. 274 Tab. 67 Register 35)
- Handbuch 750-494, Version 1.5.0 —
  <https://www.wago.com/wagoweb/documentation/750/ger_manu/modules/m07500494_xxxxxxxx_0de.pdf> (S. 33
  Energiezähler in der Klemme)
- Manual 750-362 Modbus TCP, Version 1.1.1 —
  <https://www.wago.com/wagoweb/documentation/750/eng_manu/coupler_controller/m07500362_xxxxxxxx_0en.pdf>
  (S. 81 Verbindungen, S. 199/205 Abbildgrößen und Klemmenliste, Tab. 203 S. 225 Leistungsmessklemme im Abbild)
- Manual 750-8206 PFC200, Version 3.11.0 —
  <https://www.wago.com/wagoweb/documentation/750/eng_manu/coupler_controller/m07508206_xxxxxxxx_0en.pdf>
  (Tab. 73 S. 220 feste Register, Typenschild 0xFA10–0xFA17)

Die Tabellen zu Datentypen und Faktoren stammen aus dem Handbuch 750-495. Für die 750-494 bestätigt sie
der Pilot; ihre vollständige Messwert-Tabelle ist nicht belegt.
