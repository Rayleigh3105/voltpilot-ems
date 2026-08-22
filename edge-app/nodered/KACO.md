# KACO-Wechselrichter lesen - Referenz + Einrichtung

Quelle der Palette + der Belege: Scout-Report `data/vp-kaco-palette-y6`
(offizielle KACO-/AISWEI-Dokumente, OpenEMS-/evcc-/Home-Assistant-Produktivcode).
Diese Datei ist die BETREIBER-Sicht: was am Gerät einzustellen ist, was VoltPilot
liest und was bewusst nicht geht.

## 0. Das Wichtigste zuerst: KACO sind ZWEI Plattformen

| Linie | Modelle | Wie sie gelesen wird |
|---|---|---|
| **KACO-eigen** (Neckarsulm) | blueplanet **TL1**, blueplanet **TL3**, **Powador TL3** (Ethernet-Generation), blueplanet **NX3 M8/M10**, **gridsave** | echtes **SunSpec Modbus TCP**, Port 502, Basisadresse 40001 |
| **AISWEI/Solplanet-OEM** | blueplanet **NX1 M2**, **NX3 M2**, **NX3 M3/M5**, hybrid **NH3** | Kommunikationseinheit (WLAN-/LAN-Stick): HTTP-JSON auf Port 8484, AISWEI-Registerkarte, SunSpec über den Stick |

Beide sind gebaut. §1-§7 beschreiben die **KACO-eigene** Linie (sie braucht
keinen neuen Decoder - VoltPilot liest sie mit demselben SunSpec-Walker wie
einen Fronius Eco, `nodered/sunspec/sunspec-live.js`), §8-§10 die
**AISWEI-Plattform**.

## 1. Modbus TCP am Gerät einschalten (WICHTIG!)

Ohne diesen Schritt antwortet das Gerät gar nicht.

1. Am Display des Wechselrichters oder in seiner Weboberfläche:
   **„Netzwerk – Modbus TCP – Betriebsmodus"** einschalten (bei manchen
   Baureihen heißt der Zweig **„Netzwerkdienste – Modbus TCP"**).
2. **Port** stehen lassen (Standard **502**).
3. **„Schreibzugriff erlauben" NICHT einschalten.** Es ist ein eigener,
   werksseitig ausgeschalteter Schalter und wird **für das Lesen nicht
   gebraucht**. VoltPilot steuert einen KACO derzeit nicht (siehe §5).

Bei Geräten mit **Firmware < V4.00** gibt es den Schreibzugriff-Schalter gar
nicht; gelesen wird trotzdem (TL1/TL3 ab V2.02, Powador TL3 ab V2.10).

## 2. Unit-ID

- **blueplanet TL1/TL3 und Powador TL3:** die Unit-ID wird über TCP ignoriert -
  **1** passt immer.
- **Geräte hinter einer Kommunikationseinheit** (WLAN-/LAN-Stick): der
  Hersteller vergibt **3**.
- Nach einem Stick-Firmware-Update ist die Adresse in Einzelfällen auf **126**
  gewandert (Feldbericht). Antwortet das Gerät nicht, sind 1 / 3 / 126 die drei
  Kandidaten.

**Nur EINE Modbus-TCP-Verbindung gleichzeitig.** Hält schon ein Solar-Log, ein
HEMS oder evcc die Verbindung, bricht die zweite mit „connection reset by peer"
ab. Vor dem Einrichten prüfen, wer sonst noch am Gerät hängt.

## 3. ⚠ blueplanet TL1: einphasig, meldet aber SunSpec-Modell **102**

Die einphasigen TL1 melden das SunSpec-Modell **102 (Split-Phase)**, nicht 101 -
so listet es KACOs eigene App Note für die Tx1/Tx3-Serie („001, 102, 103").
Das ist kein Defekt, sondern KACOs Wahl. evcc kannte 102 nicht und scheiterte an
genau diesen Geräten („sunspec model not found: 101/111/103/113").

VoltPilot decodiert 102 mit demselben Punkt-Layout wie 101/103 - ein TL1 liest
also ohne Sonderfall (festgenagelt in `sunspec/sunspec-live.test.js` und
`sunspec-live.e2e.test.js` gegen einen echten Socket).

**Und die zweite Hälfte:** die Klassifikation `split` beschreibt das MODELL, nie
das Gerät. Ein blueplanet TL1 ist und bleibt ein **Einphaser**.

## 4. Was gelesen wird

Über den SunSpec-Walk kommen (je nach Firmware und Modell-Liste des Geräts):

| Kanal | Woher |
|---|---|
| `pv_power_kw` | Wechselrichter-Modell 102/103 (bzw. 112/113) `W`, bei einem String-Gerät IST die AC-Ausgangsleistung die Erzeugung |
| `power_kw` (Netz) | nur mit einem SunSpec-**Zähler**modell (21X) am selben Gerät - **Vorzeichen am Gerät prüfen** |
| Betriebszustand | `St` (u. a. `THROTTLED` = eine Begrenzung ist aktiv) |

**Nachts** antwortet ein TL3 ohne Einstrahlung teils gar nicht oder verzögert.
Das ist normal: VoltPilot trägt einen fehlenden Messwert als **abwesend**, nie
als 0.

### ⚠ gridsave: nur lesen, und ohne Ladestand

Ein `blueplanet gridsave` ist ein reiner **Batterie-Wechselrichter ohne PV** und
braucht zwingend ein externes EMS. VoltPilot liest ihn hier über die
AC-Leistung des Modells 103. Der **Ladestand kommt darüber NICHT**: er steht im
KACO-Vendor-Modell 64203, in das das EMS ihn selbst hineinschreibt. Der
EMS-Pfad (Vendor-Modelle 64201-64204 mit Zustandsmaschine und Pflicht-Watchdog)
ist bewusst ein eigener, späterer Schritt.

## 5. Steuerung: derzeit KEINE

KACO dokumentiert die Wirkleistungsbegrenzung selbst über **SunSpec Model 123**
(`WMaxLimPct` + `WMaxLim_Ena`; das offizielle Beispiel schreibt 40295/40299) -
also genau das Primitiv, das unser Fronius-Adapter fährt. **Gebaut ist davon in
dieser Stufe nichts**, und es ist an keinem Gerät geprüft. Eine KACO-Anlage wird
von VoltPilot ausschließlich **gelesen**.

Der Schalter „Schreibzugriff erlauben" bleibt deshalb aus (§1).

## 6. Bewusst NICHT anbindbar

| Gerät | Warum |
|---|---|
| **blueplanet hybrid 10.0 TL3** | proprietäres **EDCOM**-Protokoll (Katek), ab Firmware 8.x nur mit Partner-Identkey; kein Modbus, kein Webinterface |
| Powador **2500xi…8000xi**, **supreme**, **2002-6002**, **000xi** | RS232/RS485 mit KACOs ASCII-Protokoll (9600 8N1), kein Modbus |
| Powador **16.0/18.0 TR3** | RS485/RS232 only |
| Powador **30.0-40.0 TL3 Erstgeneration** (ohne „M1") | laut KACOs Schnittstellen-Übersicht nur RS232/RS485 - erst mit Nachweis eines Ethernet-Ports listen |
| blueplanet **360 NX3**, Zentral-/Nordamerika-Geräte | außerhalb der Zielgruppe bzw. Transport unbelegt |

## 7. Einrichten der KACO-eigenen Linie (Selbstverdrahtung - kein Flow-Edit)

Auf `:8484` → **Einrichten** → Wechselrichter: Marke **KACO**, Modell vom
Typenschild suchen (die Modell-Suche findet „TL1", „TL3", „Powador", „NX3",
„gridsave"), IP eintragen, **Verbindung testen**. Der Rest verdrahtet sich
selbst; die Box liest das Gerät ab dem nächsten Poll.

Bei **Dunkelheit** gilt: ist das SunSpec-Common-Modell lesbar, steht die
Verbindung - die Messwerte kommen mit der ersten Einstrahlung.

## 8. Die AISWEI-Plattform: NX1 / NX3 / hybrid NH3

Diese Geräte hängen an einer **Kommunikationseinheit** (WLAN-/LAN-Stick
`KNE-NX3-RCN-G1`, Connect-GEN2, beim NH3 Connect-NH). Sie sprechen drei lokale
Dialekte; VoltPilot nutzt zwei davon.

### 8.1 ⚠ Der Vorgabe-Weg ist die App-Schnittstelle (HTTP 8484) - und warum

Der Stick kennt die Betriebsmodi **„Datenupload / SmartCloud" ODER „Modbus TCP
IP Server"** - **nie beides**. Wer Modbus TCP am Stick einschaltet, nimmt dem
Kunden seine KACO-App und die Cloud-Überwachung.

Die **HTTP-JSON-Schnittstelle auf Port 8484 läuft PARALLEL zur Cloud**. Deshalb
ist sie der Vorgabe-Weg: **am Gerät muss nichts umgestellt werden.**

Der SunSpec-Weg über den Stick steht als **Experten-Ausweg** daneben (im
Anlege-Fluss unter „Verbindungsweg"). Er steht in der Notiz **jedes** betroffenen
Modells - er soll niemanden überraschen.

| | HTTP 8484 (Vorgabe) | SunSpec über den Stick (Ausweg) |
|---|---|---|
| KACO-App / SmartCloud | bleibt | **wird abgeschaltet** |
| Einstellung am Gerät nötig | nein | ja (App → „Modbus TCP IP Server") |
| Speicher (NH3) | ja (`device=4`) | unbelegt (siehe §9) |

### 8.2 Was abgerufen wird

Alles im LAN, ohne Anmeldung:

| Aufruf | Inhalt |
|---|---|
| `GET /getdev.cgi?device=2` | das **Inventar**: `isn` = Seriennummer des Wechselrichters, `add` = Modbus-Adresse, `rate` |
| `GET /getdevdata.cgi?device=2&sn=<isn>` | Wechselrichter: `pac` (W), `fac` (cHz), `eto`/`etd` (0,1 kWh), `tmp` (0,1 °C), `vpv[]`/`ipv[]` (DC-Stränge) |
| `GET /getdevdata.cgi?device=3&sn=<isn>` | Zähler: `pac` = Netzleistung, **+ Bezug / − Einspeisung** |
| `GET /getdevdata.cgi?device=4&sn=<isn>` | Batterie (NH3): `pb` (W), `soc` (%), `vb` (0,01 V), `cb` (0,1 A), `soh` |

**Die Seriennummer wird nie abgetippt.** Das Feld im Formular ist optional; der
Verbindungstest holt sie aus dem Inventar. Nur wenn an EINER
Kommunikationseinheit mehrere Wechselrichter hängen, wählt man mit ihr aus.

### 8.3 ⚠ Beim Hybriden kommt die Erzeugung von der DC-Seite

Ein String-Gerät (NX1/NX3) hat keine Batterie: seine AC-Ausgangsleistung `pac`
**ist** die Erzeugung.

Bei einem **Hybriden (NH3)** ist `pac` dagegen `PV + Entladung − Ladung`. `pac`
als PV zu veröffentlichen bliese die Erzeugung um die Entladung auf. VoltPilot
rechnet die PV dort deshalb aus den DC-Strängen (`Σ vpv[i] × ipv[i]`). Sind die
Strang-Werte nicht lesbar, wird **gar keine PV** veröffentlicht - nie die
AC-Leistung ersatzweise.

Genau dafür gibt es zwei Decode-Profile (`kaco_http` und `kaco_http_hybrid`);
welches gilt, folgt aus dem gewählten Modell.

### 8.4 Nachts

Stick und Wechselrichter fahren herunter, die Abrufe laufen in Timeouts. Was
zurückkommt, wird getragen; der Rest ist **abwesend**, nie 0.

## 9. Der hybride NH3 über seinen eigenen Ethernet-Port (Experten-Weg)

Der NH3 hat - anders als die NX-Geräte - einen **eigenen Ethernet-Anschluss**
und beantwortet dort die **AISWEI-eigene Registerkarte** (TCP 502, Unit-ID 1).
Dieser Weg geht **nicht** über den Stick und kostet deshalb ebenfalls keine
Cloud-Anbindung. Er ist der Ausweg, wenn die App-Schnittstelle nicht antwortet.

Gelesen werden: PV-Gesamtleistung (31601), Batterieleistung (31619), Ladestand
(31622), Netzleistung (46434) sowie Gerätetyp/Seriennummer/Nennleistung.

⚠ **Adress-Konvention:** `3xxxx` sind **Input**-Register (FC4, Draht-Adresse =
Nummer − 30001), `4xxxx` sind **Holding**-Register (FC3, Nummer − 40001). Wer
pauschal FC3 sendet, liest die falsche Tabelle und bekommt plausibel aussehenden
Unsinn.

## 10. ⚠ Am Gerät zu prüfen (VERIFY-on-device)

Nichts davon konnte an einem echten KACO gemessen werden. Beim ersten
Kundengerät gehören diese Punkte auf die Liste:

1. **Vorzeichen der Batterie.** Die AISWEI-Registerkarte dokumentiert für den
   **Schreib**-Sollwert (41153) „− laden / + entladen". VoltPilot übernimmt diese
   Konvention auch für die **gelesenen** Werte (`pb` bzw. 31619) und **negiert**
   sie, weil es intern „+ = Ladung" führt. Das ist eine begründete Annahme, kein
   Beleg - lädt die Batterie und das Cockpit zeigt negativ, ist der Haken
   „Batterie-Vorzeichen invertieren" die Antwort.
2. **Vorzeichen des Netzes** (`device=3` `pac` bzw. 46434): + muss Bezug sein.
3. **Wort-Reihenfolge** der 32-Bit-Register (wir lesen hohes Wort zuerst). Ein
   vertauschtes Wort fällt als absurd große Zahl auf, nie als plausibler Wert.
4. **Vollständigkeit der DC-Stränge** (`vpv`/`ipv`): 2 MPPT beim NH3 M2, 3 beim
   M3. Ein fehlender Strang macht die PV zu klein.
5. **Unit-ID** am NH3-Ethernet-Port (evcc nennt 1; die am Display gepflegte
   „Modbus-Adresse" 3 gilt dem RS485-Bus).
6. **Ob der NH3 zusätzlich ein SunSpec-Speichermodell (124/802) liefert** - das
   ist offen; über den Stick-SunSpec-Weg gibt es deshalb heute keinen belegten
   Ladestand.
7. **HTTP 8484 auf NX3 M3/M5 und NH3**: für den NX3 M2 belegt, für die übrigen
   plausibel (gleiche Plattform). Neuere Dongles leiten auf **HTTPS** um - dafür
   gibt es den Haken „Selbstsigniertes Zertifikat akzeptieren".

## Siehe auch

- `nodered/sunspec/sunspec-live.js` - der Walker + die Decodierung (geteilt mit Fronius)
- `nodered/kaco/kaco-http.js` - die App-Schnittstelle (Port 8484)
- `nodered/kaco/aiswei-decode.js` - die AISWEI-Registerkarte des NH3
- `FRONIUS.md` §5b - derselbe Lesepfad aus der Fronius-Sicht
- `edge-app/INVERTER-CONFIG.md` - der Vertrag der retained `edge/inverter/config`
