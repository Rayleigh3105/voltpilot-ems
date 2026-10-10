# WAGO-Erhebungsbogen: Energiekarten beim Kunden aufnehmen

Mit diesem Bogen nehmen Sie eine WAGO-Steuerung mit Energiekarten auf, **bevor** VoltPilot darauf
zugreift. Ausgefüllt wird er am Schaltschrank, am besten zusammen mit dem Installateur — auf Papier
oder am Telefon. Aus den Antworten entstehen später die Datenquelle, das Gerät (die Steuerung) und je
Energiekarte eine Komponente; und aus jedem „weiß nicht“ eine Prüfaufgabe für den Pilot.

„Energiekarte“ heißt bei WAGO **3-Phasen-Leistungsmessklemme** (750-493, 750-494, 750-495). Wer
beim Hersteller nachschlägt, sucht nach diesem Wort.

**Drei Regeln**

1. **„Weiß nicht“ ist eine gute Antwort.** Sie wird zur Prüfaufgabe, nie zu einer Annahme. Nichts
   schätzen, nichts ergänzen, was niemand abgelesen hat.
2. **Abschreiben statt erinnern.** Artikelnummern, Firmware und Wandler vom Typenschild, vom Aufkleber
   oder aus der Web-Oberfläche der Steuerung. Wo „Foto“ steht: fotografieren.
3. **Ein Bogen je Steuerung.** Zwei Steuerungen sind zwei Bögen.

**Mitnehmen:** Telefon mit Kamera, Zugang zur Web-Oberfläche der Steuerung (Browser, Passwort beim
Installateur), diesen Bogen.

Ein ausgefülltes Beispiel steht unten: [Beispiel Ahrenberg](#beispiel-kunststoffwerk-ahrenberg-halle-2-steuerung-c-1).

---

## Kopf

| | |
|---|---|
| Kunde, Standort | |
| Wo steht die Steuerung? (Gebäude, Raum, Schaltschrank) | |
| Ausgefüllt von (Name, Firma) | |
| Datum | |

## A · Die Steuerung

**A1 Welche Steuerung trägt die Energiekarten?**
Artikelnummer: ______ ☐ Foto Typenschild · Seriennummer: ______ ☐ nicht lesbar
*Wo:* Aufkleber am Kopfmodul, ganz links in der Reihe. Häufig: 750-8212 (PFC200), 750-8100 (PFC100),
750-362 (Koppler), 751-9301 (Compact Controller).

**A2 Welcher Firmware-Stand läuft?**
Firmware: ______ ☐ weiß nicht
*Wo:* Web-Oberfläche der Steuerung → „Information“ → „Firmware revision“.

**A3 Läuft auf der Steuerung ein Programm?**
☐ ja ☐ nein ☐ weiß nicht · Name des Programms: ______ · geschrieben von: ______ · gepflegt von: ______
*Hilfe:* Ein Koppler (750-352, 750-362) hat kein Programm. Bei PFC100, PFC200 und Compact Controller
kommen die Werte der Karten nur über ein Programm nach außen.

**A4 Gibt das Programm heute Werte per Modbus TCP heraus?**
☐ ja ☐ nein ☐ weiß nicht · Welche? ☐ Leistung ☐ Zählerstände (kWh) ☐ Spannung, Strom ☐ andere: ______
Registerliste (Tabelle, Dokument, Bildschirmfoto)? ☐ liegt bei ☐ gibt es nicht ☐ weiß nicht
*Wo:* Web-Oberfläche → „Modbus Services Configuration“ (die Seite erscheint nur, wenn die Laufzeit
e!RUNTIME aktiv ist).

**A5 Gehen die Messwerte heute noch auf einem anderen Weg nach außen?**
☐ nein ☐ Web-Visualisierung ☐ WAGO-App „Energiedatenmanagement“ ☐ OPC UA ☐ MQTT oder Cloud
☐ CSV-Datei ☐ anderer: ______

## B · Die Energiekarten

**B1 Welche Klemmen stecken rechts neben der Steuerung — alle, von links nach rechts?**
☐ Foto der ganzen Klemmenreihe

| Position | Artikelnummer (Aufdruck) |
|---|---|
| 1 | |
| 2 | |
| 3 | |
| … | |

*Hilfe:* Position 1 ist die erste Klemme rechts neben der Steuerung. Die Position wird später der
Steckplatz der Karte. Die Web-Oberfläche zeigt die Liste unter „I/O Config“.

**B2 Welche Positionen sind Energiekarten, welcher Typ, und was misst jede?**

| Position | Typ (Aufkleber) | Was misst sie? (Zuleitung, Abgang, Maschine) |
|---|---|---|
| | | |

*Hilfe:* Typ 750-493, 750-494 oder 750-495. Der Zusatz sagt den Wandler: ohne Zusatz 1 A,
„/000-001“ 5 A, „/000-002“ Rogowski-Spule.

**B3 Welcher Stromwandler hängt an jeder Karte?**

| Position | Wandler Primär/Sekundär (z. B. 200/5 A) oder Rogowski-Spule (Typ) | ☐ Foto |
|---|---|---|
| | | |

*Wo:* Aufschrift am Wandler oder Schaltplan. Ohne Wandler misst die Karte nicht.

**B4 Rechnet die Karte selbst mit dem Wandler um?** (WAGO: „Anwenderskalierung“)
☐ ja, in der Karte eingestellt ☐ nein, Werkseinstellung ☐ das Programm rechnet um ☐ weiß nicht
☐ gilt für alle Karten ☐ je Karte verschieden: ______
*Hilfe:* Wenn ja, zeigt die Karte den Strom am Abgang (zum Beispiel 180 A). Wenn nein, zeigt sie
höchstens 5 A. Prüfen kann es der Installateur mit WAGO-I/O-CHECK.

**B5 Hat jemand an den Karten sonst etwas umgestellt — Energie-Auflösung oder Anschlussart?**
☐ nein, Werkseinstellung ☐ ja: ______ ☐ weiß nicht
*Hilfe:* Im WAGO-Handbuch heißt die Werkseinstellung der Energie-Auflösung „Register 35 = 4“, die
Anschlussart „Messtopologie“. Wer daran gedreht hat, weiß es meist noch.

## C · Zählerstände und Verhalten

**C1 Wo werden heute Zählerstände (kWh) geführt?**
☐ in der Karte ☐ im Programm ☐ in einem anderen System: ______ ☐ nirgends ☐ weiß nicht
*Hilfe:* Die Karten 750-494 und 750-495 zählen selbst. Manche Programme zählen zusätzlich oder
setzen die Zähler der Karte zurück.

**C2 Was passierte beim letzten Stromausfall oder Neustart der Steuerung mit den Zählerständen?**
☐ liefen weiter ☐ standen danach auf 0 ☐ hat niemand geprüft ☐ gab noch keinen · Wann war das? ______

**C3 Kann jemand die Zähler zurücksetzen?**
☐ nein ☐ ja, mit WAGO-I/O-CHECK ☐ ja, im Programm ☐ weiß nicht · Wer? ______
*Hilfe:* Zurücksetzen ist erlaubt — VoltPilot muss es nur sehen können.

**C4 Gab es Netzwerkstörungen zwischen Steuerung und Rest der Anlage?**
☐ nein ☐ selten ☐ oft ☐ weiß nicht · Wann, wie lange? ______

## D · Netzwerk

**D1 Unter welcher Adresse ist die Steuerung erreichbar?**
IP-Adresse: ______ · Port: ______ (meist 502) · Netz oder VLAN: ______
*Wo:* Web-Oberfläche → „TCP/IP“. Beim Koppler steht das letzte Byte oft am DIP-Schalter.

**D2 Hängt die VoltPilot-Box im selben Netz?**
☐ ja ☐ nein, eine Firewall-Regel oder Route ist nötig ☐ weiß nicht · Welche Box? ______

**D3 Wer liest die Steuerung heute sonst noch per Modbus TCP?**
☐ niemand ☐ Leittechnik ☐ Visualisierung ☐ anderer: ______ · Wie viele Verbindungen, wie oft? ______
*Hilfe:* Ein Koppler 750-362 erlaubt höchstens 15 Modbus-TCP-Verbindungen.

**D4 Ist der Modbus-Watchdog eingeschaltet?**
☐ nein ☐ ja ☐ weiß nicht
*Wo:* Web-Oberfläche → „Watchdog“. *Hilfe:* Ist er an, schalten Ausgänge ab, wenn keine Anfragen kommen.

## E · Ansprechpartner, Unterlagen, Pilot

**E1 Wer betreut die Steuerung?**
Firma, Name, Telefon: ______ · Beim Kunden verantwortlich: ______

**E2 Welche Unterlagen liegen bei?**
☐ Projektdatei (e!COCKPIT oder CODESYS) ☐ Registerliste ☐ Schaltplan der Wandler
☐ Fotos der Typenschilder ☐ Export des Prozessabbilds ☐ nichts

**E3 Wann ist ein Termin vor Ort möglich?**
Zeitfenster ohne Störung der Produktion: ______ · Fernzugang: ☐ ja ☐ nein
Zähler zum Vergleichen (zum Beispiel der Zähler des Netzbetreibers): ______
Dürfen in einem Wartungsfenster Prüfungen laufen, die die Werte kurz stören — Steuerung kurz stromlos,
einen Zähler zurücksetzen, eine Karte ziehen?
☐ ja ☐ nein ☐ noch nicht gefragt · Wer entscheidet? ______
*Hilfe:* Ohne diese Prüfungen bleibt das Verhalten bei Neustart und Rücksetzung „nicht belegt“ — dann
zählt die Antwort aus C2 und C3.

**E4 Soll VoltPilot noch andere Zähler lesen?**
☐ nein ☐ ja: ______ (zum Beispiel WAGO-Energiezähler 879, andere Modbus-Zähler; eine weitere
Steuerung bekommt einen eigenen Bogen)

---

## Was der Bogen ergibt

Aus Steuerung (A1), Karten (B2) und Ausgabeweg (A3/A4) ergibt sich die **Kombination**. Für sie gibt
es genau drei Antworten (Konzept AP-05, Entscheid E8):

| Antwort | Wann | Was folgt |
|---|---|---|
| **unterstützt (belegt)** | Die Kombination hat ein Hardwareblatt, dessen Zeilen im Pilot belegt sind. | Einrichtung mit der geprüften Vorlage. Heute gilt das für **keine** Kombination: die Pilotkombination PFC200 (750-82xx, e!RUNTIME) × 750-494/-495 × VoltPilot-Registerbild v1 ist „in Prüfung — Pilot ausstehend“. |
| **belegt je Kunde** | Das Programm gibt eine eigene Registerliste heraus (A4), oder PFC100 vor dem eigenen Pilot-Nachweis. | Ein eigenes Hardwareblatt für diese Anlage, ohne Zusage für andere Kunden. |
| **nicht unterstützt** — mit Ausweg | Compact Controller 751-9301 und Edge Controller 752-8303 (Energiekarten nicht belegt steckbar), Karte 750-493, ältere Laufzeit CODESYS 2.3, WAGO-App „Energiedatenmanagement“ ohne Registerliste. | Ausweg benennen: Registerbild ins Programm einbauen lassen (Installateur), Koppler-Weg (750-352/-362) später, WAGO-Energiezähler 879 für neue Messstellen. |

**Aus „weiß nicht“ werden Prüfaufgaben:**

| Antwort „weiß nicht“ bei | Prüfaufgabe | Wann |
|---|---|---|
| A1 Seriennummer, A2 Firmware | Typenschild und Web-Oberfläche ablesen | Pilotschritt 1 (Zugriff) |
| A4 Modbus TCP | Verbindungstest der Box | Pilotschritt 1 |
| B5 Einstellungen | Einstellungen der Karte auslesen | Pilotschritt 1 |
| B4 Umrechnung in der Karte | Vergleich gegen Zählerablesung und Zangenmessgerät | Pilotschritt 2 (Vergleich) |
| C1 Zählerstände | Zuwachs gegen Vergleichszähler über mindestens eine Stunde | Pilotschritt 2 |
| C2 Neustart, C3 Rücksetzen | Prüfung im Wartungsfenster, nur mit Zustimmung (E3) | Pilotschritt 2 |
| D2 Netz | Kunden-IT: Route oder Firewall-Regel | vor Pilotschritt 1 |
| E3 Wartungsfenster | Zustimmung einholen | vor Pilotschritt 2 |

Das Ergebnis der Pilotschritte steht im [Hardwareblatt](hardwareblatt-vorlage.md).

---

## Beispiel: Kunststoffwerk Ahrenberg, Halle 2, Steuerung C-1

Alle Kennzeichen und Werte stammen aus dem Referenzunternehmen
[`uems-referenzunternehmen.json`](../contracts/v2/uems-referenzunternehmen.json) und dem Konzept AP-05.
Was dort nicht steht, ist hier „weiß nicht“ — auch im Beispiel wird nichts erfunden.

**Kopf:** Kunststoffwerk Ahrenberg, Werk Ahrenberg (ST-1), Halle 2 (Anlage AN-2) · Steuerung C-1 ·
ausgefüllt von Elektro Brunner GmbH (Thomas Brunner) mit Jonas Wendlinger · vor der Einrichtung am
01.10.2026

| Nr. | Antwort |
|---|---|
| A1 | 750-8212 (PFC200 G2) · Foto ☑ · Seriennummer: nicht notiert → Prüfaufgabe Pilotschritt 1 |
| A2 | 04.05.08(27), abgelesen in der Web-Oberfläche |
| A3 | ja — e!COCKPIT-Projekt „Halle2_Energie“, 2019 geschrieben von Elektro Brunner, gepflegt von Elektro Brunner; die Projektdatei liegt beim Installateur |
| A4 | ja, Modbus TCP aktiv (Port 502) · Leistung je Karte für die Gebäudeleittechnik · **Zählerstände nicht enthalten** · Registerliste „Halle2_Modbus.xlsx“ (12 Zeilen) liegt bei |
| A5 | Web-Visualisierung des Programms (nur Anzeige); sonst nichts |
| B1 | 1: 750-602 (Einspeisung) · 2: 750-494/000-001 · 3: 750-494/000-001 · 4: 750-494/000-001 · 5: 750-494/000-001 · 6: 750-600 (Endklemme) · Foto ☑ |
| B2 | Position 2: EK-1, 750-494/000-001, Hauptmessung Halle 2 · 3: EK-2, Spritzguss SG07–SG10 · 4: EK-3, Montage M1 · 5: EK-4, Lager Halle 2 |
| B3 | EK-1 400/5 A · EK-2 250/5 A (Tausch auf 400/5 A geplant zum 01.02.2027) · EK-3 100/5 A · EK-4 60/5 A |
| B4 | weiß nicht (der Installateur meint: ja, 2019 mit WAGO-I/O-CHECK eingestellt) → Prüfaufgabe Pilotschritt 2 |
| B5 | weiß nicht → Prüfaufgabe Pilotschritt 1 |
| C1 | in der Karte (laut Installateur); das Programm zählt nicht selbst; die Leittechnik zeigt nur Leistung; Stände wurden nie abgelesen |
| C2 | hat niemand geprüft — letzter Stromausfall 12.05.2026, etwa 4 Minuten → Prüfaufgabe Pilotschritt 2 |
| C3 | ja, Elektro Brunner mit WAGO-I/O-CHECK; im Programm nicht |
| C4 | selten — VLAN „Produktion“ 2025 zweimal, je etwa 20 Minuten |
| D1 | 192.168.20.10 · Port 502 · VLAN 20 „Produktion“ (192.168.20.0/24) |
| D2 | ja — Box E-2 „Box Halle 2“ im VLAN 20, keine Firewall dazwischen |
| D3 | Gebäudeleittechnik, 1 Verbindung, alle 10 s |
| D4 | nein (Web-Oberfläche „Watchdog“: disabled) |
| E1 | Elektro Brunner GmbH, Thomas Brunner (Installateur) · beim Kunden: Jonas Wendlinger (IT-Leitung, Kundenadministrator) |
| E2 | Registerliste „Halle2_Modbus.xlsx“, 5 Fotos der Typenschilder, Schaltplan Blatt 12 (Wandler); Projektdatei auf Anfrage beim Installateur |
| E3 | vor Ort mit Elektro Brunner, freitags 14–17 Uhr · kein Fernzugang · Vergleich mit dem Zähler am Netzanschluss NA-2 „Anschluss Halle 2“ (Ablesung) · Prüfungen im Wartungsfenster: noch nicht gefragt → Jonas Wendlinger klärt es mit Elektro Brunner |
| E4 | nein für Halle 2 · Werk Lindach: Steuerung C-2 mit EK-5 und EK-6 → eigener Bogen |

**Ergebnis des Beispiels:** Kombination PFC200 750-8212 · 750-494/000-001 · Programm mit Modbus TCP.
Die Registerliste von heute enthält keine Zählerstände — „belegt je Kunde“ würde also nur Leistung
liefern. Zur **Pilotkombination** wird C-1, sobald Elektro Brunner das VoltPilot-Registerbild v1 in
„Halle2_Energie“ einbaut; bis zum Pilot steht sie auf „in Prüfung — Pilot ausstehend“. Prüfaufgaben:
Seriennummer und Einstellungen (Pilotschritt 1), Umrechnung in der Karte und Verhalten beim Stromausfall
(Pilotschritt 2), Zustimmung zum Wartungsfenster (vor Pilotschritt 2).
