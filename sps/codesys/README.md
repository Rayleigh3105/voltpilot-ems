# VoltPilot-Bibliothek für CODESYS V3.5 (WAGO): Erzeuger-Bild

Die SPS-Seite von Stufe 2 „Lesen“ des PFC200-Konzepts (Entscheid E3 = A: VoltPilot verantwortet Bibliothek, Grundprogramm und Vorlagen).
Der Baustein `FB_VP_ErzeugerBild` füllt das [VoltPilot-Registerbild Erzeuger v1](../../docs/contracts/v2/erzeuger-registerbild.md) aus getippten Werten des Anlagenprogramms; die Box liest es alle 5 s über Modbus TCP, auf einem PFC200 mit VoltPilot über 127.0.0.1 („in diesem Gerät“).
Der Fachbetrieb rechnet keine Register, packt keine Wörter und baut keinen Herzschlag.

Die Quellen liegen als Structured Text im EMS-Repository, solange es das eigene SPS-Repository aus Entscheid EW-13 B nicht gibt; dorthin ziehen sie mit Prüfer und Vektor-Bezug um.

## Was hier liegt

| Pfad | Inhalt |
|---|---|
| `bibliothek/VP_ErzeugerTypen.st` | Datentypen: das Abbild `T_VP_ErzeugerBild` (332 Wörter) und je Abschnitt des Bilds eine Struktur in den Einheiten des Vertrags |
| `bibliothek/VP_ErzeugerPacken.st` | Packfunktionen: U16, S16, U32, S32 mit Typ-Maximum für „kein Wert“, Text in ISO 8859-1, Bits |
| `bibliothek/FB_VP_ErzeugerBild.st` | der Baustein: Kopf, Herzschlag, alle Abschnitte, je Einheit 10 Wörter, Namen ab 140 |
| `grundprogramm/` | `GVL_VoltPilot` (das Abbild) und das Grundprogramm: Bibliothek, keine Anlage (0 Einheiten), Herzschlag läuft |
| `probeprojekt/` | Probeprojekt für PS-P9 und PS-P13: drei ausgedachte PV-Wechselrichter, feste Werte; `erwartung.json` sagt, was die Box davon lesen muss |
| `plcopen/*.xml` | ERZEUGT aus den `.st`-Quellen: PLCopen XML (TC6 0201) zum Import in CODESYS - Bibliothek allein, Grundprogramm, Probeprojekt |
| `pruefer/` | Prüfer gegen die Vertragsvektoren: ein Interpreter für genau die ST-Teilmenge der Bibliothek, ein unabhängiger Leser nach Vertrag, der PLCopen-Erzeuger |

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
7. **PLCopen XML** aus denselben Quellen und aktuell.

Ein Interpreter ist kein CODESYS: er prüft die Rechnung, nicht die Übersetzung.
Was er voraussetzt, steht im nächsten Abschnitt und wird an der IDE und am Gerät bestätigt.

## In CODESYS benutzen

1. Neues Standardprojekt für den PFC200 G2 (750-8212) mit der Firmware des Soll-Stands, dann **Projekt › PLCopenXML importieren** mit `plcopen/VoltPilot_Grundprogramm.xml` (oder `..._Probeprojekt.xml`).
   Für eine echte Bibliothek: Bibliotheksprojekt anlegen, `plcopen/VoltPilot_Bibliothek.xml` importieren, als Bibliothek speichern und installieren.
2. Im Gerätebaum einen **Modbus TCP Server** (Slave-Gerät) anlegen, Port 502, und seine **Eingangsregister 0 bis 331** auf `GVL_VoltPilot.aErzeugerBild` abbilden (Funktionscode 4, Adresse 0-basiert wie im Telegramm).
3. `PLC_PRG` in die zyklische Task (z. B. 100 ms); der Baustein läuft in derselben Task, die das Abbild an den Modbus-Server übergibt.
4. Im Anlagenprogramm statt der festen Werte des Probeprojekts die eigenen Messungen in `stAnlage`, `stNetzbetreiber`, `stDirektvermarkter`, `stWirkung` und `astEinheit` schreiben; `udiSteuerungId` vergibt VoltPilot, `uiProgrammstand` ist der eigene Stand (JJMM).
5. Im Portal die Anlagensteuerung über „Gerät hinzufügen › Anlagensteuerung“ verbinden; läuft das Programm auf einem PFC200 mit VoltPilot, „Wo läuft die Steuerung?“ = **In diesem Gerät**.

## Was nur in der IDE oder am Gerät geht

Offen, bis jemand es mit CODESYS bzw. am Test-PFC200 belegt:

| Was | Wo belegen |
|---|---|
| Import der drei PLCopen-Dateien ohne Rückfrage, insbesondere die globale Variablenliste (CODESYS-eigener `addData`-Block) und die Dokumentation an Typen und Bausteinen | IDE |
| Übersetzen ohne Fehler und Warnungen; die Teilmenge nutzt nur IEC-Standard (`X_TO_Y`, `SHL`, `SHR`, `LEN`, `TIME()`, Zeichenzugriff `s[i]`) | IDE |
| `DINT_TO_UDINT` und `INT_TO_WORD` behalten das Bitmuster (Zweierkomplement) - der Prüfer setzt das voraus; das Probeprojekt trägt dafür −1200 W am Netzpunkt und −0,950 cos φ | PS-P9 (Lesung gegen `erwartung.json`) |
| Zeichenketten in ISO 8859-1: ein „ü“ im Typnamen steht als 0xFC im Bild | PS-P9 (Typname „Probe-Wechselrichter 3 (Grün)“) |
| Die Abbildung der Eingangsregister 0 bis 331 auf `GVL_VoltPilot.aErzeugerBild` im Modbus-Server-Gerät, Antwort auf 127.0.0.1:502 und Sperre von außen | PS-P9, PS-P8 |
| Lizenz: Modbus TCP aus der Grundausstattung, SYS bleibt grün | PS-P9 |
| STOP/RUN: der Herzschlag steht im STOP, die Box meldet nach drei gleichen Lesungen `frozen_source`; nach RUN läuft er weiter, nach einem Neustart springt er zurück (`device_restart`) | PS-P13 |
| Grundprogramm als Boot-Applikation per Datei statt mit der IDE | PS-P14 |
| Ob ein Block halb geschrieben ausgeliefert werden kann (Vertrag §13) | erster Einbau |

## Abgrenzung

Kein Koppelbild (Wunsch, Quittung, Frist; Stufe 4), kein Baustein Energiekarten (Stufe 5), keine Vorlagen PV und BHKW (Stufe 4).
Der Baustein schreibt Fassung 1.0 des Bilds; eine Nebenversion braucht eine neue Fassung von Bibliothek, Vektoren und Prüfer zugleich.
