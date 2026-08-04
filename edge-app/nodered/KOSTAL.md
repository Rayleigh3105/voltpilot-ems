# KOSTAL PLENTICORE BI: Auslesen über Modbus TCP (Betreiber-Anleitung)

Der KOSTAL PLENTICORE BI ist ein **reiner Batterie-Wechselrichter** (AC-gekoppelt;
die DC-Seite IST die Hochvolt-Batterie, es gibt keine PV-MPPTs). VoltPilot liest
ihn als **Primär-Wechselrichter** über den herstellereigenen Modbus-TCP-Server —
Grundlage ist die offizielle Schnittstellenbeschreibung („PIKO IQ/PLENTICORE —
KOSTAL Interface description MODBUS (TCP) & SunSpec with control information",
Rev. 2.9). Vollständige Analyse: firstmate `data/vp-kostal-plenticore-s5/report.md`.

**Nur lesen.** Die Steuerung (externes Batteriemanagement, Register 1024–1044,
Tier 2) ist ein eigenes, über Prüfstand/First-Light gegatetes Inkrement — dieser
Lesepfad schreibt nie.

## 1. Transport

| Was | Wert |
|---|---|
| Protokoll | Modbus TCP (FC3, Holding Registers) |
| Port | **1502** (Werk; am Gerät änderbar) |
| Unit-ID | **71** (Werk; am Gerät änderbar, Register 4) |
| Byte-Reihenfolge (Float/2-Wort) | Register 5: `0x00` = **Little-Endian/CDAB (Werk)**, `0x01` = Big-Endian/ABCD — VoltPilot erkennt sie automatisch je Zyklus („Automatisch"); nur bei Problemen manuell festlegen |

**Voraussetzung am Gerät:** Modbus (TCP) muss im Webserver des Wechselrichters
aktiviert sein (Servicemenü; Register 2 „MODBUS Enable"). Ohne Aktivierung
antwortet der Port nicht — „Verbindung testen" meldet dann `unreachable`/`no_answer`
mit dem Hinweis.

## 2. Was gelesen wird (Registerkarte)

Ein Poll liest fünf FC3-Blöcke (alle weit unter dem 125-Register-Maximum;
Quelle der Wahrheit: [`kostal/kostal-decode.js`](kostal/kostal-decode.js)):

| Block | Register | Inhalt |
|---|---|---|
| 5 (1) | 5 | Byte-Reihenfolge (Auto-Erkennung) |
| 56 (2) | 56 | Wechselrichter-Status (U32: 0 Off … 6 FeedIn, 7 Throttled, 10 Standby) |
| 252 (2) | 252 | **Netzleistung** (Float, W) — der Messwert des angeschlossenen Energiezählers (KSEM) |
| 514 (75) | 514 / 531 / 582 / 588 | **SoC** (U16, %) / Nennleistung (W) / **Batterieleistung** (S16, W) / Batterietyp |
| 1068 (16) | 1068 / 1076 / 1078 / 1080 / 1082 | Nutzkapazität (Wh) / BMS-Lade-/Entladegrenze (W) / Batteriemanagement-Modus / Sensortyp |

Veröffentlicht werden auf `edge/telemetry`:

- `battery_power_kw` — **gemessen**, VoltPilot-Konvention **+ Laden / − Entladen**.
  ⚠ Das Kostal-Register meldet **− Laden / + Entladen** (Doku Note 1, identisch
  am Strom-Register 200 beschriftet) — der Decoder **negiert**;
  `invert_batt_sign` ist die Notluke, falls eine Firmware abweicht
  (VERIFY-on-device, First-Light-Disziplin).
- `soc_pct` — nach der socPlausible-Regel: außerhalb (0, 100] wird der Kanal
  VERWORFEN, nie fabriziert.
- `power_kw` — die Netzleistung des Zählers, NUR wenn ein Sensor installiert ist
  (Register 1082 ≠ 0xFF). ⚠ Das Vorzeichen hängt an der **konfigurierten
  Sensorposition**: Position 2 (Netzanschlusspunkt — der Normalfall bei
  BI-Anlagen mit KSEM) = + Bezug / − Einspeisung = VoltPilot-Konvention;
  Position 1 (Hausverbrauchszweig) braucht `invert_grid_sign` bzw. eine andere
  Netzquelle. Auf dem echten Gerät kalibrieren.
- **KEIN `pv_power_kw`, KEIN `load_kw`** — der BI hat keine PV; die PV der
  Anlage kommt als Erzeuger-Quellen von den anderen Wechselrichtern, das Haus
  rechnet der Core (`Haus = Erzeugung − Einspeisung − Batterie`).

Die Familie `kostal_plenticore` ist eine **Batterie-Familie**
(`inverter.FamilyHasBattery`): fehlt die Batteriemessung, wird der Hausverbrauch
verworfen (Lücke im Chart) statt Batterie = 0 zu erfinden.

## 3. Einrichtung in VoltPilot

`:8484` → Einrichten → Anlage → Wechselrichter: Marke **KOSTAL**, Modell
(z. B. **PLENTICORE BI 10/26**), IP-Adresse. Port/Unit-ID/Byte-Reihenfolge sind
vorbelegt (1502/71/Automatisch). „Verbindung testen" liest einmalig und zeigt
Netz + SoC.

## 4. Abgrenzungen / bewusste Grenzen

- **Hybride (PLENTICORE plus) werden hier bewusst NICHT angeboten:** deren
  PV-DC-Register sind in diesem Lesepfad nicht decodiert; ein Batterie-only-Read
  eines PV-tragenden Hybrids würde die Hausbilanz still verfälschen. Eigenes
  Inkrement, wenn eine solche Anlage ansteht.
- **Nur EIN System soll auf den Wechselrichter zugreifen** (evcc-Caveat der
  Praxis): kein zweites EMS parallel betreiben.
- Der KSEM hat zusätzlich eine EIGENE Modbus-Schnittstelle; als separate
  Netz-Zähler-QUELLE ist er ein mögliches späteres Inkrement — hier wird sein
  Messwert über den Wechselrichter (Register 252) mitgelesen.
- Steuerung/First-Light/Prüfstand: siehe den Scout-Report §3 (Bauplan) und
  künftig `CONTROL-BENCH.md` → Kostal (kommt mit dem Steuer-Inkrement).

## 5. Firmware-Hinweis

Die Registerkarte gilt für G1 ab UI 01.16.05025 (Praxis-Untergrenze der
Feld-Integrationen) und ist mit der aktuellen Doku Rev. 2.9 (G1 ab UI
01.30.12092, G2, G3/MP G3) deckungsgleich für die hier gelesenen Register.
Vor Inbetriebnahme Firmware aktualisieren (Webserver), Stand notieren.
