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

**Diese Datei beschreibt heute die KACO-EIGENE Linie.** Sie braucht keinen neuen
Decoder: VoltPilot liest sie mit demselben SunSpec-Walker, mit dem es einen
Fronius Eco liest (`nodered/sunspec/sunspec-live.js`).

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

## 7. Einrichten (Selbstverdrahtung - kein Flow-Edit)

Auf `:8484` → **Einrichten** → Wechselrichter: Marke **KACO**, Modell vom
Typenschild suchen (die Modell-Suche findet „TL1", „TL3", „Powador", „NX3",
„gridsave"), IP eintragen, **Verbindung testen**. Der Rest verdrahtet sich
selbst; die Box liest das Gerät ab dem nächsten Poll.

Bei **Dunkelheit** gilt: ist das SunSpec-Common-Modell lesbar, steht die
Verbindung - die Messwerte kommen mit der ersten Einstrahlung.

## Siehe auch

- `nodered/sunspec/sunspec-live.js` - der Walker + die Decodierung (geteilt mit Fronius)
- `FRONIUS.md` §5b - derselbe Lesepfad aus der Fronius-Sicht
- `edge-app/INVERTER-CONFIG.md` - der Vertrag der retained `edge/inverter/config`
