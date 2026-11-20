# VoltPilot-Bibliothek für CODESYS V3.5 (WAGO): Erzeuger-Bild, Koppelbild und WAGO-Bild

Die SPS-Seite der Stufen 2 „Lesen“, 4 „Wünschen“ und 5 „Mehr lesen“ des PFC200-Konzepts (Entscheid E3 = A: VoltPilot verantwortet Bibliothek, Grundprogramm und Vorlagen).
Der Baustein `FB_VP_ErzeugerBild` füllt das [VoltPilot-Registerbild Erzeuger v1](../../docs/contracts/v2/erzeuger-registerbild.md) aus getippten Werten des Anlagenprogramms; die Box liest es alle 5 s über Modbus TCP, auf einem PFC200 mit VoltPilot über 127.0.0.1 („in diesem Gerät“).
Der Baustein `FB_VP_Koppelbild` ist die SPS-Seite des [VoltPilot-Koppelbilds v1](../../docs/contracts/v2/koppelbild.md): die Box schreibt Wünsche, der Baustein prüft sie, begrenzt sie auf das Angebot, lässt sie nach der Frist von selbst ablaufen und quittiert; das Anlagenprogramm entscheidet immer selbst.
Der Baustein `FB_VP_WagoBild` füllt das [VoltPilot-Registerbild WAGO v1](../../docs/contracts/v2/wago-registerbild.md) mit den Werten der 3-Phasen-Leistungsmessklemmen 750-494/-495 („Energiekarten“), die das Anlagenprogramm aus den Karten liest; von außen kommt niemand an die Klemmen.
Der Fachbetrieb rechnet keine Register, packt keine Wörter und baut keinen Herzschlag.

Die Quellen liegen als Structured Text im EMS-Repository, solange es das eigene SPS-Repository aus Entscheid EW-13 B nicht gibt; dorthin ziehen sie mit Prüfer und Vektor-Bezug um.

## Was hier liegt

| Pfad | Inhalt |
|---|---|
| `bibliothek/VP_ErzeugerTypen.st` | Datentypen: das Abbild `T_VP_ErzeugerBild` (332 Wörter) und je Abschnitt des Bilds eine Struktur in den Einheiten des Vertrags |
| `bibliothek/VP_ErzeugerPacken.st` | Packfunktionen: U16, S16, U32, S32 mit Typ-Maximum für „kein Wert“, Text in ISO 8859-1, Bits |
| `bibliothek/FB_VP_ErzeugerBild.st` | der Baustein: Kopf, Herzschlag, alle Abschnitte, je Einheit 10 Wörter, Namen ab 140 |
| `bibliothek/VP_KoppelTypen.st` | Datentypen des Koppelbilds: die Abbilder `T_VP_KoppelWunsch` (64 Wörter) und `T_VP_KoppelQuittung` (116 Wörter), Angebot, Rückmeldung und Wunsch je Stellplatz |
| `bibliothek/VP_KoppelPacken.st` | Packen und Lesen von 32-bit-Werten, das Siegel (CRC-16/MODBUS) für Wunsch und Quittung |
| `bibliothek/VP_WagoTypen.st` | Datentypen des WAGO-Bilds: das Abbild `T_VP_WagoBild` (684 Wörter, höchstens 16 Karten) und `ST_VP_WagoKarte` (Steckplatz, Typ, Variante, je Teil ein Feld `...Gelesen`, Kartenregister 32/35, zwölf Statuswörter, zwölf Messwerte als Bitmuster der Karte) |
| `bibliothek/VP_WagoPacken.st` | `VP_WagoSetze32`: jeder 32-bit-Wert in der Wortfolge der Anlage, auch der Prüfwert |
| `bibliothek/FB_VP_WagoBild.st` | der Baustein WAGO-Bild: Kopf 1.0, Herzschlag (Wort 7), je Karte 42 Wörter mit Gültigkeitsbits, unbekannt = Typ-Maximum, Blöcke hinter der Kartenzahl 0 |
| `bibliothek/FB_VP_Koppelbild.st` | der Baustein Koppelbild: Prüfung in der Reihenfolge des Vertrags, Frist (höchstens `tHoechsteFrist`, Vorgabe 60 s), Lebenszeichen, Urteile, Quittung |
| `grundprogramm/` | `GVL_VoltPilot` (die Abbilder und die Lampe) und das Grundprogramm: Bibliothek, keine Anlage (0 Einheiten), Herzschlag läuft, Probe-Stellplatz 8 auf der Lampe am Gerät |
| `probeprojekt/` | Probeprojekt für PS-P9 bis PS-P13: drei ausgedachte PV-Wechselrichter, feste Werte, ein Koppelbild mit Grenze der Erzeugung und Lampe; `erwartung.json` sagt, was die Box davon lesen muss |
| `vorlagen/pv/`, `vorlagen/bhkw/` | Vorlagen der Anlagenprogramme, die den Wunsch annehmen: PV (Grenze der Erzeugung) und BHKW (Grenze, Motor 1 ein/aus); Vorrang von Netzbetreiber und Direktvermarkter bleibt im Programm |
| `plcopen/*.xml` | ERZEUGT aus den `.st`-Quellen: PLCopen XML (TC6 0201) zum Import in CODESYS - Bibliothek allein, Grundprogramm, Probeprojekt, die zwei Vorlagen |
| `pruefer/` | Prüfer gegen die Vertragsvektoren: ein Interpreter für genau die ST-Teilmenge der Bibliothek, ein unabhängiger Leser nach Vertrag, das Koppelbild aus der Vektor-Datei (`koppel.py`), das WAGO-Bild gegen den Leser der Box (`wago.py`), der PLCopen-Erzeuger |

## Prüfen

```
python3 sps/codesys/pruefer/pruefe.py              # Bericht, Exit 1 bei Fehler
python3 sps/codesys/pruefer/pruefe.py --schreibe   # dazu erwartung.json und plcopen/*.xml neu schreiben
python3 -m unittest discover -s sps/codesys/pruefer
```

`edge-light/scripts/test.sh` ruft den Prüfer auf (Schritt 4), damit er mit jedem Edge-Light-Release läuft.

Der Prüfer führt den Structured Text der Bibliothek selbst aus und prüft:

1. **Vertragsfälle.**
   Für jeden lesbaren Fall der [Vektor-Datei](../../docs/contracts/v2/erzeuger-registerbild-vectors.json) bildet er die Eingänge, mit denen ein Anlagenprogramm genau dieses Bild meint, ruft den Baustein auf und verlangt dieselben Wörter für jedes Feld, das der Vertrag liest.
   Danach liest er das Bild des Bausteins nach Vertrag §7 und verlangt genau die Erwartung des Falls: Kopf, Werte, Gründe, Einheiten, Namen.
   Heute 15 Lesungen aus zehn Fällen (E1, E2, E8 bis E11, E13, E18, E20, E21, bei E8 und E9 jede lesbare Lesung der Folge).
   Die nicht lesbaren Lesungen (E3 bis E6, E12, E14 bis E17, die dritte von E8) erzeugt ein Programm mit diesem Baustein nicht, E7 (Fassung 1.1) und E19 (Namen ab 60) auch nicht - der Bericht nennt sie mit Grund.
2. **Herzschlag:** beim Programmstart 0, +1 je Sekunde auch über lange Zyklen, 65535 → 0, weiter über den Überlauf von `TIME()` nach 49 Tagen.
3. **Unbekannt ist nie 0:** ein gedeckter Wert ohne sein Gültigkeitsbit und ein Wert mit `...Bekannt := FALSE` stehen als Typ-Maximum im Bild.
4. **Prüfwert über die Packfunktion** (Vertrag §1, Fall E5), nie als zwei Konstanten.
5. **Grundprogramm:** Kopf lesbar (Fassung 1.0, Programmstand 2611), keine Anlage (`te_anzahl` 0), der Herzschlag läuft.
6. **Probeprojekt:** lesbar, Einspeisung negativ, Umlaut im Typnamen; `erwartung.json` aktuell.
7. **Koppelbild, Vertragsfälle:** für jeden Schritt jedes Falls der [Vektor-Datei](../../docs/contracts/v2/koppelbild-vectors.json) (29 Fälle K1 bis K28) setzt er die Halteregister, ruft den Baustein mit den Eingängen der Anlage auf und verlangt genau die 116 Wörter der Quittung und dieselben Ausgänge (Urteile, zugelassene Werte, Frist, `edge_lebt`).
8. **Koppelbild, Uhr:** Frist und `edge_lebt` rechnen über den Überlauf von `TIME()` nach 49 Tagen; eine Edge, die 49 Tage schweigt, lebt danach nicht wieder auf. Der Prüfwert der Quittung geht über `VP_KoppelSetzeU32`.
9. **Grundprogramm:** Probe-Stellplatz 8 schaltet die Lampe und lässt sie nach 20 s Frist los (Fall K20).
10. **Vorlagen:** PV begrenzt auf Wunsch, der Netzbetreiber überstimmt, nach der Frist und bei Hand fährt die Anlage mit eigenen Werten; BHKW begrenzt und schaltet Motor 1 aus, ein Abruf des Direktvermarkters geht vor.
11. **WAGO-Bild, Vertragsfälle** (`wago.py`): für jeden Fall der [WAGO-Vektoren](../../docs/contracts/v2/wago-registerbild-vectors.json), den ein Programm mit diesem Baustein schreiben kann, bildet er die Eingänge, ruft den Baustein auf und verlangt dieselben Wörter für jedes Wort, das der Vertrag liest (§5: Kopf, je Karte Steckplatz, Typ, Variante, Gültigkeit und nur hinter gesetzten Bits Kartenregister, Statuswörter, Messwerte).
    Danach liest der Leser der Box (`edge-app/nodered/measurements/wago-registerbild.js`; sein Go-Zwilling `edge-app/core/internal/wagobild` hängt an denselben Vektoren) das Bild des Bausteins mit Parameter und Soll des Falls und muss genau die Erwartung ergeben.
    Heute zehn Fälle (V1 bis V3, V7 bis V13; V2 und V3 in Wortfolge `little`); V4 (Fassung 2), V5 (fremde Signatur) und V6 (Fassung 1.1) erzeugt der Baustein nicht.
12. **WAGO-Bild, Rest:** ein unbekannter Teil steht als Typ-Maximum im Bild (Int32 16#7FFFFFFF), Blöcke hinter der Kartenzahl sind 0, der Herzschlag zählt je Sekunde, der Prüfwert geht über `VP_WagoSetze32`.
13. **PLCopen XML** aus denselben Quellen und aktuell.

Ein Interpreter ist kein CODESYS: er prüft die Rechnung, nicht die Übersetzung.
Was er voraussetzt, steht im nächsten Abschnitt und wird an der IDE und am Gerät bestätigt.

## In CODESYS benutzen

1. Neues Standardprojekt für den PFC200 G2 (750-8212) mit der Firmware des Soll-Stands, dann **Projekt › PLCopenXML importieren** mit `plcopen/VoltPilot_Grundprogramm.xml` (oder `..._Probeprojekt.xml`).
   Für eine echte Bibliothek: Bibliotheksprojekt anlegen, `plcopen/VoltPilot_Bibliothek.xml` importieren, als Bibliothek speichern und installieren.
2. Im Gerätebaum einen **Modbus TCP Server** (Slave-Gerät) anlegen, Port 502, und seine **Eingangsregister 0 bis 331** auf `GVL_VoltPilot.aErzeugerBild` abbilden (Funktionscode 4, Adresse 0-basiert wie im Telegramm).
3. `PLC_PRG` in die zyklische Task (z. B. 100 ms); der Baustein läuft in derselben Task, die das Abbild an den Modbus-Server übergibt.
4. Im Anlagenprogramm statt der festen Werte des Probeprojekts die eigenen Messungen in `stAnlage`, `stNetzbetreiber`, `stDirektvermarkter`, `stWirkung` und `astEinheit` schreiben; `udiSteuerungId` vergibt VoltPilot, `uiProgrammstand` ist der eigene Stand (JJMM).
5. Im Portal die Anlagensteuerung über „Gerät hinzufügen › Anlagensteuerung“ verbinden; läuft das Programm auf einem PFC200 mit VoltPilot, „Wo läuft die Steuerung?“ = **In diesem Gerät**.

Koppelbild dazu:

6. Im selben Modbus-TCP-Server die **Eingangsregister 1000 bis 1115** auf `GVL_VoltPilot.aKoppelQuittung` und die **Halteregister 0 bis 63** auf `GVL_VoltPilot.aKoppelWunsch` abbilden; den Watchdog des Servers für die Halteregister einschalten (leert er sie, lehnt der Baustein Nullen ab, Fall K7).
7. `FB_VP_Koppelbild` einmal je Zyklus aufrufen, mit derselben Kennung wie das Erzeuger-Bild; je Stellplatz das Angebot eintragen (Art, Ziel, Nummer, Band, bereit), den Ausgang `aWunsch[n]` in die eigene Logik führen und in `aRueckmeldung[n]` melden, was wirklich gilt. Muster: `vorlagen/pv/PLC_PRG.st`.
8. Den Probe-Stellplatz 8 (`xProbeLampe`) auf den Ausgang mit der Lampe legen; das Grundprogramm bringt ihn mit.
9. Im Portal je Stellplatz Schalt-Test und Freigabe; erst danach wünscht die Box dort.

Energiekarten (WAGO-Bild) dazu:

10. Im selben Modbus-TCP-Server die **Eingangsregister 2000 bis 2683** auf `GVL_VoltPilot.aWagoBild` abbilden (Basisadresse 2000, Funktionscode 4, die Vorgabe für neue Anlagen); eine bestehende Anlage behält ihre Basisadresse, sie steht im Hardwareblatt.
11. Je Karte die gelesenen Werte in `astKarte[n]` kopieren, unverändert in der Skalierung der Karte: was das Programm nicht gelesen hat, bleibt `...Gelesen := FALSE` (Karte gezogen, Klemmenbusfehler, Kartenregister nicht lesbar), nie eine 0.
12. `fbWago(udiControllerKennung := ..., xWortfolgeLittle := FALSE, uiKartenzahl := ..., astKarte := astKarte, aBild := GVL_VoltPilot.aWagoBild);` einmal je Zyklus in derselben Task.
13. Basisadresse, Funktionscode, Wortfolge, Controller-Kennung und je Karte Steckplatz, Typ und Variante gehören ins Hardwareblatt der Anlage; daraus prüft die Box jede Lesung (Soll).

## Was nur in der IDE oder am Gerät geht

Offen, bis jemand es mit CODESYS bzw. am Test-PFC200 belegt:

| Was | Wo belegen |
|---|---|
| Import der PLCopen-Dateien ohne Rückfrage, insbesondere die globale Variablenliste (CODESYS-eigener `addData`-Block) und die Dokumentation an Typen und Bausteinen | IDE |
| Übersetzen ohne Fehler und Warnungen; die Teilmenge nutzt nur IEC-Standard (`X_TO_Y`, `SHL`, `SHR`, `LEN`, `TIME()`, Zeichenzugriff `s[i]`) | IDE |
| `DINT_TO_UDINT` und `INT_TO_WORD` behalten das Bitmuster (Zweierkomplement) - der Prüfer setzt das voraus; das Probeprojekt trägt dafür −1200 W am Netzpunkt und −0,950 cos φ | PS-P9 (Lesung gegen `erwartung.json`) |
| Zeichenketten in ISO 8859-1: ein „ü“ im Typnamen steht als 0xFC im Bild | PS-P9 (Typname „Probe-Wechselrichter 3 (Grün)“) |
| Die Abbildung der Eingangsregister 0 bis 331 auf `GVL_VoltPilot.aErzeugerBild` im Modbus-Server-Gerät, Antwort auf 127.0.0.1:502 und Sperre von außen | PS-P9, PS-P8 |
| Lizenz: Modbus TCP aus der Grundausstattung, SYS bleibt grün | PS-P9 |
| STOP/RUN: der Herzschlag steht im STOP, die Box meldet nach drei gleichen Lesungen `frozen_source`; nach RUN läuft er weiter, nach einem Neustart springt er zurück (`device_restart`) | PS-P13 |
| Grundprogramm als Boot-Applikation per Datei statt mit der IDE | PS-P14 |
| Ob ein Block halb geschrieben ausgeliefert werden kann (Vertrag §13) | erster Einbau |
| Abbildung der Eingangsregister 1000..1115 und der Halteregister 0..63 im selben Server neben 0..331; ob dafür ein durchgehender Bereich 0..1115 nötig ist | PS-P9, PS-P10 |
| Ob ein zweiter Server mit eigenem Port nur für VoltPilot möglich ist (Port 502 bliebe dem Kunden) | PS-P10 |
| Ob ein Telegramm halb sichtbar werden kann und wie oft das Siegel greift (Schreib-Probe mit 20 Telegrammen je Sekunde) | PS-P11 |
| Frist auf die Sekunde: Edge anhalten, die Lampe geht nach der Frist aus; nach dem Fortsetzen wieder `angenommen` | PS-P12 |
| Ob die Halteregister nach einem Neustart der Laufzeit leer sind (der Baustein nimmt sie dann als Vergleichsstand, `kopf_urteil` `keins`) | PS-P13 |
| Speicher und Last mit Koppelbild, Edge Light und Tunnel | PS-P21 |
| Welcher Ausgang die Lampe am Gerät trägt (`xProbeLampe`) | PS-P9 |
| `MIN`, `LIMIT`, `SHR` und `XOR` auf `WORD` wie im Interpreter; `TIME_TO_UDINT` über den Überlauf von `TIME()` | IDE, PS-P12 |
| WAGO-Bild: die Abbildung der Eingangsregister 2000 bis 2683 auf `GVL_VoltPilot.aWagoBild` neben Erzeuger-Bild und Quittung, Antwort auf 127.0.0.1:502 | PS-P9 (mit dem WAGO-Bild), PS-P10 |
| WAGO-Bild: `SHR` und `AND` auf `DWORD` wie im Interpreter; ein Int32 der Karte behält über `DINT_TO_DWORD` sein Bitmuster; die Box liest Kartenwerte in Wortfolge `big` und `little` | IDE, PS-P9 |
| WAGO-Bild: wie ein Programm die Karte liest (Registerkommunikation, Messwert-Auswahl je Gruppe), Bitlage der Bereichsbegrenzung, Datentyp der Lieferung, Energie-Faktor der 750-494 | Vertrag §9, Pilotschritte 1 und 2 an einer Anlage mit Karten |
| WAGO-Bild: STOP/RUN wie beim Erzeuger-Bild (`frozen_source`, `device_restart`) | PS-P13 |

## Abgrenzung

Kein Lesen der Karten selbst: `FB_VP_WagoBild` kopiert, was das Anlagenprogramm gelesen hat; wie es an die Werte kommt (Registerkommunikation, Auswahl der Messwerte), ist am Gerät zu erheben (Vertrag §9).
Die Bausteine schreiben Fassung 1.0 ihrer Bilder; eine Nebenversion braucht eine neue Fassung von Bibliothek, Vektoren und Prüfer zugleich.
Die Bibliothek meldet ihre Fassung im Koppelbild (`bibliothek`, 0x0100); das Portal vergleicht sie mit dem Soll (Alarm „Bibliothek veraltet“).
Bestimmt ein Wunsch die Grenze, nennt `quelle_p` im Erzeuger-Bild keine Stelle (0): das Erzeuger-Bild bleibt Wort für Wort 1.0, wer stellt, sagt die Quittung (Koppelbild §14).
