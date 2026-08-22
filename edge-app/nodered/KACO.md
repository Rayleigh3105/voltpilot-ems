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

## 5. Steuerung: VORBEREITET und GESPERRT

**Eine KACO-Anlage wird von VoltPilot ausschließlich gelesen.** Der Steuerpfad
ist gebaut, aber er gibt keinen einzigen Schreibbefehl heraus - siehe §11.

Der Schalter „Schreibzugriff erlauben" am Gerät bleibt deshalb **aus** (§1).

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

## 11. Der vorbereitete, gesperrte Steuerpfad

Für einmal ist die Register-Lage **dokumentiert** - anders als bei Deye, wo sie
mühsam aus einer Fremdintegration rekonstruiert werden musste. Gemessen hat sie
an einem KACO trotzdem niemand von uns. Deshalb ist alles gebaut und **gesperrt**.

### 11.1 Was gesperrt heißt

| | |
|---|---|
| ausgehende Schreibbefehle | **keine** (`writes: []`) |
| erfundene Rückleseregister | **keine** (`readbacks: []`) |
| was der Adapter liefert | der **Plan** (`planned`, jeder Eintrag `bench_pending`) - das Artefakt, das eine Prüfstand-Sitzung abarbeitet |

⚠ **Die Sperre ist härter als die übliche Freigabeliste.** Bei Fronius oder Deye
öffnet eine First-Light-Freigabe am Gerät den Schreibweg. Bei KACO **nicht**:
`writes` bleibt leer **unabhängig von der Freigabe**. Sie fällt erst, wenn diese
Zeilen bewusst geändert werden - nicht durch einen Klick. Ein Test nagelt genau
das fest.

### 11.2 KACO-eigene Linie: Wirkleistungsbegrenzung über SunSpec Model 123

KACO beschreibt sie selbst: App Note „blueplanet 100-125 NX3" §2.3.1 mit dem
Beispiel **40295** (`WMaxLimPct`) / **40299** (`WMaxLim_Ena`), und das Handbuch
87.0 TL3 §10.4.1: *„P-Limit ist nur über das MODBUS/SunSpec-Wechselrichtermodell
123 WMaxLimPct und per RS485-Kommunikation verfügbar."*

Das ist **dasselbe Primitiv, das der Fronius-Adapter fährt**, also wird seine
Planung geteilt statt nachgebaut - und die Adressen kommen aus dem
Discovery-Walk am Gerät, nie aus einer Konstante. Ohne Walk gibt es **keinen
Plan**, nie eine erfundene Adresse.

Zwei KACO-eigene Vorbehalte für den Prüfstand:
1. **Die Schreib-Form.** KACOs Beispiel schreibt die zwei Register **einzeln
   (FC6)**; Fronius verlangt den geschlossenen **FC16**-Block (am 09.08.2026 an
   einer echten Anlage gemessen). Der Ausweg ist das Verbindungsfeld
   „Schreib-Funktionscode (Abregelung)".
2. **Die Firmware.** Der Schreibzugriff ist ein eigener Menüpunkt und existiert
   erst ab Paket **V4.00**. Ein Gerät mit V3.x liest Model 123, nimmt aber keinen
   Schreibbefehl an. Ohne die Modell-1-`Version` des Geräts ist das nicht
   entscheidbar - also wird es nicht entschieden.

### 11.3 hybrid NH3: Batterie-Sollwert über die AISWEI-Registerkarte

Belegt durch die OEM-Doku und evccs produktives `solplanet-modbus`-Template, das
für „KACO Blueplanet Hybrid NH3" die Fähigkeit `battery-control` führt.

| Register | Bedeutung |
|---|---|
| **41104** | Betriebsmodus: 1 Aus · 2 Eigenverbrauch · 3 Backup · **4 „Customer defined"** (nur dort gilt der Sollwert) |
| **41152** | Lade-/Entlade-Flag: 1 Stop · 2 Laden · 3 Entladen |
| **41153** | Lade-/Entladeleistung, S16 in W. ⚠ **AISWEI-Vorzeichen: − laden / + entladen** - die Umkehrung unserer Konvention, der Plan negiert deshalb |
| **41154 / 41155** | SoC-Ober-/Untergrenze (× 0,01 %) |

⚠ **Es gibt kein Totmann-Register.** In der AISWEI-Doku ist keines dokumentiert -
anders als bei Deyes Fernsteuerung (1101) oder KOSTALs eigenem Watchdog. Ein
gesetzter Sollwert bliebe also stehen, bis ihn jemand ändert. **Der Failsafe muss
deshalb unserer sein:** laufend re-assertieren und bei Stille 41104 aktiv auf
**2 (Eigenverbrauch)** zurücksetzen - genau das Muster, das der Shelly- und der
go-e-Executor fahren. Die Rücknahme ist als Plan gebaut; **dass sie am Gerät
wirkt, ist Prüfstand-Pflicht, bevor je etwas geschrieben wird.**

### 11.4 App-Schnittstelle: gar kein Steuerweg

Über HTTP 8484 gibt es keinen dokumentierten Steuerweg. Der Adapter sagt das
(„kein Steuerweg (nur lesen)") statt eine Adresse zu raten.

### 11.5 gridsave: ein eigenes Kapitel, nicht dieses

Ein gridsave braucht ein externes EMS und spricht dafür die KACO-Vendor-Modelle
**64201-64204** - mit Zustandsmaschine, Lade-/Entladekennlinie und einem
**Pflicht-Watchdog** (60 s, alle 10 s getriggert). VoltPilot *könnte* dieses EMS
sein; das ist ein eigener Bau mit eigener Untersuchung, kein Nebenprodukt dieser
Stufe.

## 12. Kunden-Termin-Checkliste

Was **nur am echten Gerät** geht. Abzuarbeiten, bevor irgendeine Steuerung je
scharf geschaltet wird.

1. **Typenschild fotografieren**: exakter Modellname (z. B.
   `blueplanet hybrid 10.0 NH3 M3 WM OD IIG0`), Seriennummer, Baujahr.
2. **Plattform erkennen**: WLAN-Stick (SSID `B0…`, Typ `KNE-NX3-RCN-G1` /
   Connect-GEN2 / Connect-NH) = AISWEI-Plattform; Ethernet-Buchse mit
   Display/Webserver = KACO-eigene Linie.
3. **Firmware** notieren (Webserver/App oder SunSpec Modell 1 `Version`).
   TL/Powador: **≥ V4.00** wäre Voraussetzung für Schreibzugriff.
4. **Betriebsmodus der Kommunikationseinheit** notieren (SmartCloud /
   Modbus TCP IP Server / App local) - **und ob der Kunde seine KACO-App behalten
   will** (dann bleibt es beim HTTP-8484-Weg).
5. **Modbus TCP aktivieren** (TL/Powador: „Netzwerk – Modbus TCP –
   Betriebsmodus"), **Unit-ID ablesen**.
6. **Discovery-Dump ziehen**: die vollständige SunSpec-Modell-Liste mit Längen.
   Das klärt 101/102/103 vs. 111/112/113, ob ein Speichermodell (124/802)
   existiert, 160 und die Vendor-Modelle 64xxx.
7. **Batterie (NH3)**: AISWEI-Register 31619/31622 gegen die HTTP-Werte
   `pb`/`soc` vergleichen; **Vorzeichen** und SoC-Skalierung (× 0,01)
   verifizieren; `41104`-Istwert notieren; BMS1/BMS2.
8. **Netzzähler**: SDM630 angeschlossen? `device=3` / 46434 / SunSpec-Modell 2xx
   prüfen; Vorzeichen (+ = Bezug) kalibrieren.
9. **HTTP 8484 testen**: `curl http://<stick>:8484/getdev.cgi?device=2`
   (liefert `isn`, `add`, `rate`), dann `getdevdata.cgi?device=2|3|4&sn=<isn>`.
   Bei neuem Dongle **HTTPS/443** probieren.
10. **Schreibzugriff**: ist das Menü überhaupt vorhanden? **NICHT aktivieren** -
    nur feststellen. Die Steuerung bleibt gesperrt.
11. **Einzelverbindungs-Regel**: sicherstellen, dass kein anderer Modbus-Client
    (Solar-Log, HEMS, evcc) dieselbe Verbindung hält.
12. **Bei Dunkelheit**: ist das SunSpec-Common-Modell lesbar, steht die
    Verbindung - die Messwerte kommen mit der ersten Einstrahlung.

Erst danach - und erst nach einer beaufsichtigten Prüfstand-Sitzung nach
`CONTROL-BENCH.md` - darf über eine Freigabe überhaupt gesprochen werden.

## Siehe auch

- `nodered/sunspec/sunspec-live.js` - der Walker + die Decodierung (geteilt mit Fronius)
- `nodered/kaco/kaco-http.js` - die App-Schnittstelle (Port 8484)
- `nodered/kaco/aiswei-decode.js` - die AISWEI-Registerkarte des NH3
- `FRONIUS.md` §5b - derselbe Lesepfad aus der Fronius-Sicht
- `edge-app/INVERTER-CONFIG.md` - der Vertrag der retained `edge/inverter/config`
- `CONTROL-BENCH.md` → KACO - die Prüfstand-Checkliste
