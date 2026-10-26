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

Belegt durch KACOs eigene Betriebsanleitung (Powador 3200-6600, Dok.
31001135-06,
[PDF](https://www.selectronic.com.au/manuals/31001135-06-130417_HB_3200_6600_Operating_Instructions_EN_Web.pdf)):
der Powador 3200-6600 hat **RS232 UND RS485 fest verbaut**, beide auf der
Kommunikationsplatine an der Türinnenseite. **RS485 ist der vorgesehene
Monitoring-Weg**.

- Typenschild fotografieren: exakter Modellname, Seriennummer, Baujahr.
- Die RS485-Klemmen auf der Kommunikationsplatine finden: **`DATA+`
  (Ader B) / `DATA-` (Ader A)**.
- Kabel: **verdrillte, geschirmte Zweidrahtleitung** (z. B. **LI2YCY
  2x2x0,5**), Schirm einseitig auf Erde. Max. Buslänge **1200 m**.
- **Busadresse im Einstellungsmenü des Wechselrichters setzen** - **1-32**,
  je Gerät am Bus **eindeutig** (0 ist keine gültige Adresse). Notieren,
  nicht raten.
- **Abschlusswiderstand am Endgerät des Busses aktivieren** (ebenfalls
  Einstellungsmenü bzw. Klemmeneinheit) - bei nur einem Gerät am Bus ist
  dieses Gerät das Endgerät.
- **Nur EIN Wandler am Bus** für diese Anlage - kein zweiter RS485-Client
  (Datenlogger, Anzeige) gleichzeitig am selben Zweig, sonst Buskollisionen.

## 3. Wandler-Grundkonfiguration

1. Wandler per Erstkonfiguration (Hersteller-Tool, meist über eine temporäre
   IP oder seriell) auf **9600 8N1**, **TCP-Server-Modus**, festen Port
   einstellen.
2. Feste IP bzw. DHCP-Reservierung für den Wandler setzen - wie bei jedem
   anderen VoltPilot-Gerätepfad (Solarman-Logger, KACO-Kommunikationseinheit)
   empfohlen, damit die Anlage nach einem Neustart erreichbar bleibt.
3. **Die im Einstellungsmenü vergebene Busadresse (1-32) notieren** - sie
   wird im VoltPilot-Verbindungsformular eingetragen, NIE geraten. 0 ist
   keine gültige Adresse.

## 4. In VoltPilot anlegen

Marke **KACO**, Modell **„Powador 3200 - INT"** (oder „Anderes
Powador-Altgerät (seriell)"), Verbindungsweg **„Seriell über einen
RS485-zu-Ethernet-Wandler"**:

| Feld | Eintrag |
|---|---|
| IP-Adresse des RS485-zu-Ethernet-Wandlers | die IP des Wandlers (NICHT die des Wechselrichters) |
| Port | der am Wandler konfigurierte TCP-Port |
| RS485-Adresse des Wechselrichters | die in Schritt 3 notierte Busadresse (1-32) |

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
