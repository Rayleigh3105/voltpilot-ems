# Powador-Altgeräte seriell anbinden - Feld-Checkliste

Für den Vor-Ort-Termin bei der dritten KACO-Plattform (`kaco_serial`,
[`KACO.md` §11](../KACO.md)): Powador-Geräte **vor** der TL3/Ethernet-Generation
(konkreter Anlass: ein Powador 3200 - INT, Baujahr Q1/2014, 3,2 kW, einphasig,
ohne jede Netzwerk-Schnittstelle). Diese Liste ist Betreiber-Doku im Repo, keine
Kundenmail.

## 1. Zusatzhardware

Das Gerät selbst hat keinen Netzwerk-Anschluss. Benötigt wird ein zusätzlicher,
**transparenter RS485-zu-Ethernet-Wandler** (z. B. Waveshare „RS485 TO ETH",
oder ein USR-TCP232-ähnliches Gerät) - VoltPilot bindet keinen bestimmten
Hersteller an, sondern verlangt nur:

- **9600 8N1** (9600 Baud, 8 Datenbits, kein Paritätsbit, 1 Stoppbit).
- **TCP-Server-Modus** (nicht „Client"): der Wandler wartet auf die
  Verbindung der Box, nicht umgekehrt.
- **Keine Protokoll-Übersetzung** - insbesondere KEIN „Modbus-Gateway"-Modus.
  Powador spricht kein Modbus; eine solche Übersetzung würde die Bytes
  verstümmeln.
- Ein fester TCP-Port (am Wandler konfiguriert, herstellerabhängig -
  Werksvorgabe z. B. 8899 oder 4196 nachsehen).

## 2. Verdrahtung an den Powador-RS485-Klemmen

- Typenschild fotografieren: exakter Modellname, Seriennummer, Baujahr.
- Die RS485-Klemmen am Gerät finden (A/B bzw. +/-, je Handbuch des genauen
  Baujahrs - es gibt über die Produktlebenszeit mehrere Klemmenbelegungen).
  Beim Zweifel A/B einmal vertauscht probieren, bevor an der Software gesucht
  wird - eine vertauschte Polung antwortet exakt wie ein stummes Gerät.
- Kabel so kurz wie praktikabel, verdrillt, Schirm einseitig auf Erde (übliche
  RS485-Praxis - lange ungeschirmte Strecken sind die häufigste Ursache für
  Checksummenfehler auf einem ansonsten korrekt konfigurierten Bus).
- **Nur EIN Wandler am Bus** für diese Anlage - kein zweiter RS485-Client
  (Datenlogger, Anzeige) gleichzeitig am selben Zweig, sonst Buskollisionen.

## 3. Wandler-Grundkonfiguration

1. Wandler per Erstkonfiguration (Hersteller-Tool, meist über eine temporäre
   IP oder seriell) auf **9600 8N1**, **TCP-Server-Modus**, festen Port
   einstellen.
2. Feste IP bzw. DHCP-Reservierung für den Wandler setzen - wie bei jedem
   anderen VoltPilot-Gerätepfad (Solarman-Logger, KACO-Kommunikationseinheit)
   empfohlen, damit die Anlage nach einem Neustart erreichbar bleibt.
3. **Die RS485-Busadresse am Powador ablesen** (Display-Menü bzw.
   DIP-Schalter, modellabhängig) - sie wird im VoltPilot-Verbindungsformular
   eingetragen, NIE geraten. Bei genau einem Gerät am Bus ist die
   Werksvorgabe meist 0.

## 4. In VoltPilot anlegen

Marke **KACO**, Modell **„Powador 3200 - INT"** (oder „Anderes
Powador-Altgerät (seriell)"), Verbindungsweg **„Seriell über einen
RS485-zu-Ethernet-Wandler"**:

| Feld | Eintrag |
|---|---|
| IP-Adresse des RS485-zu-Ethernet-Wandlers | die IP des Wandlers (NICHT die des Wechselrichters) |
| Port | der am Wandler konfigurierte TCP-Port |
| RS485-Adresse des Wechselrichters | die in Schritt 3 abgelesene Busadresse (0-31) |

## 5. Erste Probe

- „Verbindung testen" im Verbindungsformular ausführen.
- Antwortet das Gerät NICHT: zuerst die RS485-Verdrahtung (A/B-Polung, Schritt
  2) prüfen, dann die Wandler-Konfiguration (Schritt 3), zuletzt die
  Busadresse.
- Antwortet das Gerät mit einem **anderen** Kommando-Byte als erwartet (die
  Box erkennt das und meldet es statt plausibel aussehenden Unsinn zu
  liefern): das Gerät spricht ein ANDERES KACO-Protokoll als die hier
  implementierte Serie „00" - in diesem Fall hier **nicht weiterbauen**,
  sondern das abweichende Protokoll zuerst dokumentieren (siehe `KACO.md`
  §11.4/§6).
- Gelesene Werte (Status, Spannungen, Ströme, Leistung, Temperatur,
  Tagesertrag) gegen das Typenschild bzw. den Momentanwert am Display des
  Geräts plausibilisieren.

## 6. Was dieser Weg NICHT kann

- **Keine Fernsteuerung.** Diese Geräte-Generation hat kein dokumentiertes
  Steuerregister - nicht einmal gesperrt vorbereitet wie bei den anderen
  KACO-Plattformen. Es gibt nichts zu aktivieren.
- **Kein Speicher, kein Netzzähler** über diesen Weg - reine String-Erzeugung.
