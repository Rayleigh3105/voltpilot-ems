# Huawei SUN2000 + LUNA2000: Auslesen über Modbus TCP (Betreiber-Anleitung)

Huawei SUN2000 (L1/M1/MB0/MAP0) mit angeschlossenem LUNA2000-Speicher. Die
LUNA2000-Batterie hat **keinen eigenen Kommunikationsweg** - sie wird komplett
über die Speicher-Register des Wechselrichters gelesen (und später gesteuert).
Für VoltPilot ist das deshalb **ein** Integrationspunkt: eine Modbus-TCP-
Verbindung zum Wechselrichter deckt PV, Batterie und (mit installiertem Smart
Power Sensor) das Netz ab. Register- und Schreibfolgen-Landkarte:
[`catalog/control-profiles/profiles/huawei.json`](../../catalog/control-profiles/profiles/huawei.json)
(Herstellerquelle „SUN2000MA Modbus Interface Definitions" Issue 08 + Feldquellen).
Decoder: [`huawei-decode.js`](huawei/huawei-decode.js).

Die **Steuerung** (Tier 2, erzwungener Sollwert) ist vorbereitet, aber **hart
gesperrt**: kein einziges Huawei-Gerät wurde je gemessen, also geht kein
Schreibbefehl heraus - anders als bei KOSTAL (§5 in [KOSTAL.md](KOSTAL.md))
gibt es hier keine "bis zum Prüfstand"-Ausnahme über die Freigabeliste; die
Sperre fällt erst mit bewusster Code-Änderung nach einem Zertifizierungslauf
am echten Kundengerät (Abschnitt 4).

## 1. Transport

| Was | Wert |
|---|---|
| Protokoll | Modbus TCP (FC3 lesen, FC6/FC16 für eine spätere Steuerung) |
| Port | **502** (Werk) |
| Unit-ID | **0** bei direkter Verbindung (WLAN/LAN), oft **1** hinter einem Smart Dongle |
| Wort-Reihenfolge (32-Bit-Register) | **immer Big-Endian, High-Word zuerst** - am Gerät nicht umschaltbar, anders als bei KOSTAL gibt es kein Byte-Order-Register |
| Wartezeit nach dem Verbinden | **1 s** vor der ersten Anfrage (Leser, Verbindungstest und Gerätesuche, Docker-Box und Edge Light) |

**Wartezeit nach dem Verbinden:** Der Smart Dongle einer Feldanlage
(SUN2000-3KTL-M1, Software V100R001C00SPC153) lässt eine Anfrage, die gleich
nach dem Verbindungsaufbau kommt, unbeantwortet. Gemessen am 25.11.2026 über
den Wartungstunnel, Modell-Register 30000 je Pause dreimal: sofort 0 von 3
beantwortet, nach 0,3 s und 0,5 s je 1 von 3, nach 0,7 s, 1 s und 1,5 s je 3
von 3. Deshalb fragen der Leser (`makeHuaweiReader`, `connectPauseMs`; Go:
`layer1.Options.HuaweiConnectPause`) und der Huawei-Erkenner der Gerätesuche
(`suche.Takt.HuaweiRuhe`) erst 1 s nach dem Verbinden. Ein Mehrregister-Feld
beantwortet der Dongle nur ganz; ein Teil davon (30000 mit 8 statt 15
Registern) endet mit Ausnahme 02.

**Voraussetzung am Gerät:** Modbus TCP muss über ein **Installateur-Konto**
freigeschaltet werden - ohne diese Freischaltung antwortet das Gerät gar
nicht. **Nur EIN Modbus-Client gleichzeitig:** über das interne WLAN
unterbricht ein angemeldeter Modbus-Client laut mehreren unabhängigen Quellen
die FusionSolar-App; ein Smart Dongle (WLAN-FE/LAN/4G) erlaubt beiden
parallelen Zugriff.

## 2. Was gelesen wird (Registerkarte)

Ein Poll liest vier FC3-Blöcke (alle weit unter dem 125-Register-Maximum;
Quelle der Wahrheit: [`huawei/huawei-decode.js`](huawei/huawei-decode.js)):

| Block | Register | Inhalt |
|---|---|---|
| 32064 (2) | 32064/32065 | **PV-Eingangsleistung** (I32, W) - die Erzeugung |
| 32080 (2) | 32080/32081 | AC-Wirkleistung (I32, W) - nur Meta, NICHT die Erzeugung (siehe unten) |
| 37113 (2) | 37113/37114 | **Netzleistung** (I32, W) - nur mit installiertem Smart Power Sensor (DTSU666-H/DDSU666-H) sinnvoll |
| 37760 (7) | 37760 / 37762 / 37765-37766 | **Batterie-SoC** (U16, ×0,1 %) / Batterie-Laufstatus / **Lade-/Entladeleistung** (I32, W) |

Veröffentlicht werden auf `edge/telemetry`:

- `pv_power_kw` - kommt aus dem **DC-seitigen** Register 32064, NIEMALS aus
  32080 (AC). ⚠ Dieselbe Falle wie bei der KACO-NH3-Lektion: auf einem Hybriden
  nettet die AC-Leistung die Batterie bereits ein - 32080 als PV zu
  veröffentlichen würde die Erzeugung um die Entladung aufblasen.
- `battKw` - **gemessen**, Feldquelle dokumentiert bereits VoltPilots eigene
  Konvention (**+ Laden / − Entladen**), also KEINE Negation per Vorgabe;
  `invert_batt_sign` ist die First-Light-Notluke (VERIFY-on-device, das
  Vorzeichen ist Sicherheit D - an keinem Gerät gemessen).
- `soc_pct` - nach der socPlausible-Regel: außerhalb (0, 100] wird der Kanal
  VERWORFEN, nie fabriziert.
- `power_kw` - die Netzleistung des Smart Power Sensors (Register 37113). Huawei
  definiert **> 0 = Einspeisung, < 0 = Bezug** (Modbus Interface Definitions
  Issue 04 S. 19/68 und Issue 08; das evcc-Template liest 37113 mit `scale: -1`).
  VoltPilot rechnet **+ = Bezug**, deshalb negiert der Decoder den Rohwert
  standardmäßig (Testvektor in `huawei-decode.test.js`). `invert_grid_sign`
  stellt die Rohrichtung wieder her - die Notluke für einen Sensor mit
  verkehrt herum angeschlossenen Wandlern; an keinem Gerät gemessen
  (Sicherheit D). Ohne Sensor bleibt der
  Block leer (abgelehnter Read) und der Kanal fehlt ehrlich, statt eine 0 zu
  erfinden.
- **KEIN `load_kw`** - der Core rechnet die Hauslast aus der Bilanz
  (`Haus = Erzeugung − Einspeisung − Batterie`).

Die Familie `huawei_sun2000_luna` ist eine **Batterie-Familie**
(`inverter.FamilyHasBattery`): fehlt die Batteriemessung, wird der
Hausverbrauch verworfen (Lücke im Chart) statt Batterie = 0 zu erfinden.

## 3. Einrichtung in VoltPilot

`:8484` → Einrichten → Anlage → Wechselrichter: Marke **Huawei**, Modell
(z. B. **SUN2000-M1** für die 3KTL-M1-Baureihe des Kunden), IP-Adresse.
Port/Unit-ID sind vorbelegt (502/0). „Verbindung testen" liest einmalig und
zeigt PV, SoC und Batterieleistung (Netz nur mit installiertem Sensor).

**Edge Light** (die Ein-Programm-Box, [Paritätsliste](../../edge-light/docs/paritaet.md))
liest denselben Weg seit 04.11.2026 mit dem Go-Zwilling
`core/internal/huaweidecode` über den gemeinsamen Modbus-TCP-Client
`core/internal/modbustcp` - als Hauptgerät und als weitere Energiequelle
(Erzeuger oder Netz-Zähler). Beide Seiten hängen an den gemeinsamen Vektoren
`huawei/huawei-decode-vectors.json`, erzeugt aus `huawei-decode.js`
(`node huawei/huawei-decode-vectors.gen.js` nach jeder Änderung am Decoder).
Der Verbindungstest unterscheidet dort `unreachable`, `no_answer` und
`invalid_response`; ein Gerät, das jeden Block ablehnt, bekommt den Hinweis
auf Unit-ID und Modbus-TCP-Freischaltung.

## 4. Steuerung

Huawei bietet zwei Registerfamilien (Details und exakte Schreibfolgen:
[`catalog/control-profiles/profiles/huawei.json`](../../catalog/control-profiles/profiles/huawei.json)):

| Absicht | Hebel | Register | Stand |
|---|---|---|---|
| Eigenverbrauchs-Fenster (E_laden/E_gedrosselt, E_decken, H) | Gerät regelt selbst innerhalb der Grenzen | **47075** max. Ladeleistung, **47077** max. Entladeleistung (je U32 W), **47086** Arbeitsmodus | **47077 freigegeben** auf Edge Light und Edge Industrie für SUN2000-M1; **47075 gesperrt** bis zu den Sonnen-Tests (Captain-Entscheid C, 26.11.2026) |
| Netzladen (N) | erzwungener Sollwert | **47087** Netzladen, **47100** Richtung, **47246** Modus, **47083** Dauer (Minuten), **47247** Ladeleistung (U32 W) | **nicht freigegeben** (Captain 25.11.2026); nur als gesperrter Entwurf im Node-RED-Plan |
| Verkaufen (A) | erzwungener Sollwert | **47249** Entladeleistung (U32 W) + 47100/47246/47083 | nicht verdrahtet (kein Signal unterscheidet „gezielt verkaufen“ von „nur decken“) |

**Der Fensterpfad** (`core/internal/steuerplan/huawei.go`, `core/internal/layer1/steuern_huawei.go`): das
Gerät bleibt im Eigenverbrauch, und die Box setzt nur die **Entladegrenze 47077**. Die Ladegrenze 47075 ist
gesperrt, bis ihre Wirkung bei PV-Überschuss an einem sonnigen Tag gemessen ist (Captain-Entscheid C vom 26.11.2026).

- **Vorbedingung:** 47086 = 2 (Eigenverbrauch). Nur in diesem Modus ist die Grenze gemessen; die Box liest 47086
  und schreibt es nie.
- **Halten und Laden** (Sollwert ≥ 0): 47077 = 0, das Entladen ist gesperrt. Das Laden regelt das Gerät selbst,
  auch bei einem Sollwert mit `grid_charge_allowed`.
- **Decken** (negativer Sollwert): 47077 = eigener Wert des Geräts, das Entladen ist frei; eine Ladesperre gibt es
  nicht.
- **Rückgabe:** 47077 zurück auf den eigenen Wert des Geräts. 47087/47088 (Netzladen am Gerät) fasst die Box nie
  an.
  - Die Box liest diese Werte vor dem ersten Schreiben und legt sie dauerhaft in `steuern.json` ab; ohne die
    Ablage schreibt sie nicht.
  - Die Rückgabe läuft bei Not-Aus, bei einem veralteten Sollwert (20 min), ohne Freigabe oder Zertifizierung, am
    Ende des Tagesbudgets und nach einem Neustart der Box.
  - Die Box löscht die Werte erst, wenn sie zurückgelesen sind.
- **Schreiben:** nur, wenn das Gerät einen anderen Wert hält (Toleranz 100 W). Jeder Takt mit Schreiben
  verbraucht einen Planwechsel des Tagesbudgets (höchstens 20, der letzte Platz gehört der Rückgabe), weil
  47077 als Dauerspeicher gilt.
- **Tore:**
  - Edge-Light-Freigabe je Familie, Pfad und Modell (`layer1/freigabe.go`).
  - `control_enabled` (Not-Aus).
  - Zertifizierung des Geräts (`device_certified`): über das **Plattform-Register** im Portal (Marke `huawei`,
    Modell `sun2000-m1`, Familie `huawei_sun2000_luna`, ohne Steuerpfad) und die **Scharfschaltung** der Anlage.
    First-Light gibt es für Huawei nicht (`calibrationControllable`): ihr Beleg, die gemessene Bewegung gegen
    einen Sollwert, passt nicht zum Fensterpfad, in dem das Gerät selbst regelt.
- **Verbindung:** eine Sitzung je Takt auf der Spur des Geräts (geteilt mit dem Poll), 1 s Wartezeit nach dem
  Verbinden.

**Gemessen** an einer Feldanlage SUN2000-3KTL-M1 mit LUNA2000
([Messbericht](huawei/MESSBERICHT-2026-11.md)):

- 47075/47077 sind W mit Gain 1 und wirken nach 1,4–6 s.
- Das Zwangsladen endet einmal geschrieben nach 47083 Minuten von selbst; neu geschrieben hält es.
- Die frühere Rückgabe des Node-RED-Adapters (47075 = 47077 = 0) war Halten. Sie schreibt jetzt die eigenen
  Werte zurück.
- E_decken setzt 47077 zurück, damit der Speicher nach Halten oder Laden wieder entladen darf.

**Die Docker-Box** hat keinen Huawei-Ausführer. `huaweiControl` liefert dort weiter nur `planned`
(`writes` leer).

**Prüfstand:** [`core/cmd/vp-huawei-pruefstand`](../core/cmd/vp-huawei-pruefstand)

- `lesen`, `wartezeit` und `leseplan` lesen nur.
- `folge` fährt eine Schreibfolge des Adapters: Ausgangswerte sichern, schreiben, halten, wiederherstellen,
  gegenlesen.
- `steuerweg` fährt den Go-Pfad der Box selbst und endet mit Not-Aus.
- Geschrieben werden nur die Absichtsregister, 47246 nie 1.

## 5. Abgrenzungen / offene Punkte

- Ob 47075/47077 im Dauerspeicher liegen, ist ohne Stromunterbrechung nicht
  gemessen (Sicherheit D); deshalb Tagesbudget und nur Abweichungen schreiben.
- Ob die Box beim Fensterpfad nachregeln soll (`daempfung.box_regelt`), ist
  offen; die gemessene Einschwingzeit steht nur als Wissen im Profil.
- Die **Wechselrichter-Automatik** (Selbstregel-Modus, wie bei KOSTAL §Wechselrichter-Automatik
  oder KACO NH3) ist für Huawei noch NICHT verdrahtet: ohne ein dokumentiertes
  "Schreiben einstellen reicht"-Register wäre ein Übergabe-Primitiv hier
  erfunden statt belegt - ein späteres Inkrement, wenn die Bench-Daten da sind.
- Vor-Ort-Checkliste (Scout `data/vp-kundenanlage-huawei-s1/report.md` §4):
  Smart Dongle vorhanden oder nur internes WLAN? Firmware-Version? Ist Modbus
  TCP bereits freigeschaltet? Smart Power Sensor am Netzanschlusspunkt
  verbaut?
