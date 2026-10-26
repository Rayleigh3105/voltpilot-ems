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
- `power_kw` - die Netzleistung des Smart Power Sensors, ebenfalls Sicherheit D
  im Vorzeichen; `invert_grid_sign` ist die Notluke. Ohne Sensor bleibt der
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

## 4. Steuerung (erzwungener Sollwert, Tier 2 - vorbereitet, HART gesperrt)

Huaweis "Forcible Charge/Discharge" ist ein echter forced-watts RAM-Sollwert -
dieselbe Primitiv-Klasse wie KOSTAL, aber auf **zwei** Registerfamilien
verteilt (Details + exakte Schreibfolgen:
[`catalog/control-profiles/profiles/huawei.json`](../../catalog/control-profiles/profiles/huawei.json),
Adapter: `inverter-control-routing.js` → `huaweiControl`):

| Absicht | Hebel | Register |
|---|---|---|
| Eigenverbrauchs-Fenster (E/E_laden/E_decken/E_gedrosselt/H) | Gerät regelt selbst innerhalb der Grenzen | **47075** max. Ladeleistung, **47077** max. Entladeleistung (je U32 W), **47086** Arbeitsmodus |
| Netzladen (N) | erzwungener Sollwert | **47087** Netzladen freigeben, **47100** Richtung, **47246** Modus, **47083** Dauer (Minuten), **47247** Ladeleistung (U32 W) |
| Verkaufen (A) | erzwungener Sollwert | **47249** Entladeleistung (U32 W) + 47100/47246/47083 - in der Landkarte dokumentiert, im Adapter **nicht verdrahtet** (kein Upstream-Signal unterscheidet "gezielt verkaufen" von "nur decken") |

**⚠ Der geräteeigene Totmann ist flüchtig und nur im Dauer-Modus wirksam:**
ein erzwungenes Laden/Entladen endet nach `47083` Minuten - ABER nur wenn
`47246 = 0` (Dauer-Modus). `47246 = 1` (SoC-Modus) hat **keinen Zeit-Rückfall**;
der Adapter schreibt `47246` deshalb niemals auf 1. Der Failsafe ist deshalb
unser eigener: `47083` wird auf die kürzeste verfügbare Einheit (**1 Minute**)
gesetzt und bei jedem Tick neu geschrieben - solange die Box schreibt, läuft
die Minute nie ab; verstummt sie, fällt das Gerät spätestens nach der
laufenden Minute von selbst in seinen Eigenverbrauchsmodus zurück.

**Hängende Zwangsentladung (evcc #26917):** ein fremdes Projekt berichtet ein
Gerät, das eine gesetzte Zwangsentladung nicht von selbst beendet - die
dokumentierte Abhilfe ist Rücklesen + Neusetzen. Das ist einer der Gründe,
warum Absicht A (Verkaufen) hier bewusst nicht verdrahtet ist.

**Freigabe-Status:** `huawei` steht NICHT in `CERTIFIED_CONTROL_FAMILIES` und
wird dort auch durch ein First-Light-Grant NICHT ersetzt (härter gesperrt als
die Freigabeliste, wie bei KACO NH3) - `writes` bleibt in jedem Fall leer, der
Adapter liefert nur `planned` als Bench-Artefakt. Vor jeder Freigabe gehört
dazu: Firmware-Stand am Gerät lesen, Schreibbudget/Dämpfung messen (alle
Sicherheit D in huawei.json), und die Pflicht-Bench-Prüfung „Überschuss mit
kurzen Verbrauchern" (`CONTROL-BENCH.md`) bestehen.

## 5. Abgrenzungen / offene Punkte

- **Keine Verbindungsversuche zu einem Kundengerät** sind Teil dieser Änderung
  gewesen - jede Zahl zu Einschwingzeit, Messtakt oder Schreibverhalten ist
  unbelegt (Sicherheit D), bis ein Prüfstand/Feldtermin sie misst.
- Die **Wechselrichter-Automatik** (Selbstregel-Modus, wie bei KOSTAL §Wechselrichter-Automatik
  oder KACO NH3) ist für Huawei noch NICHT verdrahtet: ohne ein dokumentiertes
  "Schreiben einstellen reicht"-Register wäre ein Übergabe-Primitiv hier
  erfunden statt belegt - ein späteres Inkrement, wenn die Bench-Daten da sind.
- Vor-Ort-Checkliste (Scout `data/vp-kundenanlage-huawei-s1/report.md` §4):
  Smart Dongle vorhanden oder nur internes WLAN? Firmware-Version? Ist Modbus
  TCP bereits freigeschaltet? Smart Power Sensor am Netzanschlusspunkt
  verbaut?
