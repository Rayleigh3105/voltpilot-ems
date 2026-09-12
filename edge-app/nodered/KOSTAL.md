# KOSTAL PLENTICORE BI: Auslesen über Modbus TCP (Betreiber-Anleitung)

Der KOSTAL PLENTICORE BI ist ein **reiner Batterie-Wechselrichter** (AC-gekoppelt;
die DC-Seite IST die Hochvolt-Batterie, es gibt keine PV-MPPTs). VoltPilot liest
ihn als **Primär-Wechselrichter** über den herstellereigenen Modbus-TCP-Server —
Grundlage ist die offizielle Schnittstellenbeschreibung („PIKO IQ/PLENTICORE —
KOSTAL Interface description MODBUS (TCP) & SunSpec with control information",
Rev. 2.9). Decoder und Registerkarte: [`kostal-decode.js`](kostal/kostal-decode.js).

Die **Steuerung** (externes Batteriemanagement, Tier 2) ist gebaut, aber
**stumm**: bis zur Prüfstand-/First-Light-Freigabe auf dem echten Gerät geht kein
einziger Schreibbefehl hinaus (Abschnitt 5).

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
- Steuerung/First-Light/Prüfstand: §5 unten +
  [`CONTROL-BENCH.md`](CONTROL-BENCH.md) → „Checkliste Kostal PLENTICORE".

## 5. Steuerung (externes Batteriemanagement, Tier 2)

Der PLENTICORE hat eine **offizielle, dokumentierte** externe Batteriesteuerung —
anders als bei Deye ist hier nichts trianguliert. VoltPilot nutzt sie mit **EINEM
Hebel**:

| Was | Wie |
|---|---|
| Sollwert | **Register 1034** „Battery charge power (DC) setpoint, absolute", **float32 Watt**, geschrieben per **FC16** (ein 2-Wort-Wert passt nicht in FC6) |
| Vorzeichen | ⚠ Kostal: **− = Laden / + = Entladen** — VoltPilot negiert (unsere Konvention ist + = Laden); `invert_control_sign` ist die First-Light-Notluke |
| Halten | schlicht Sollwert **0** — es gibt keinen zweiten Hebel |
| Freigabe-Tor | **Register 1080** muss **2** melden („extern via MODBUS"); sonst wird NICHT geschrieben, sondern der Hebel genannt |
| Rückgabe | Sollwert 0 einmal, danach aufhören zu schreiben |

**Die EIN-HEBEL-DISZIPLIN ist tragend, nicht Stil.** Solange extern gesteuert
wird, bleibt in der Sitzung JEDES geschriebene Register in Kraft, bis der
Watchdog abläuft — wer 1034 mit den Grenz-/SoC-Registern mischt, baut
Zustandskonflikte, bei denen die Batterie komplett blockiert (belegt in der
Praxis: evcc #26709, openHAB-Thread). Deshalb fasst VoltPilot **1038/1040/1042/1044
NIE** an: `guards.Clamp` ist vorgelagert die SoC- und Leistungs-Autorität, und der
Adapter bekommt einen bereits geklemmten Wert.

**Der Watchdog ist die Failsafe-Rückfallebene.** Der Wechselrichter hat einen im
Webserver konfigurierbaren Timeout (Empfehlung **60 s**): bleibt der Sollwert aus,
verwirft er ihn und kehrt zur **internen Batteriesteuerung** zurück. Die
Steuerregister sind RAM (laut Doku beim Reset verworfen), deshalb ist das
Re-Assert bei jedem ~10-s-Takt kein Verschleiß, sondern **der Watchdog-Kick**
(`always: true`, `dwell_s: 0`). Drei unabhängige Ebenen: unser Takt hält den
Watchdog → Kern still > 20 min ⇒ Release (Sollwert 0) → VoltPilot tot ⇒
Geräte-Watchdog. Weil kein Installateurs-Zustand angefasst wird, gibt es **nichts
zu restaurieren** (anders als beim Deye-ToU-Pfad).

**PV-Abregelung gibt es hier nicht** (der BI hat keine MPPTs): ein `pv_limit_kw`
wird als „nicht unterstützt" GEMELDET, nie still verworfen.

**Freigabe-Status:** `kostal_plenticore` steht ABSICHTLICH **nicht** in
`CERTIFIED_CONTROL_FAMILIES`/`VP_CONTROL_CERTIFIED_FAMILIES`. Bis zum Prüfstand
plant der Adapter vollständig (`planned`), schreibt aber nichts; die
First-Light-Kalibrierung auf `:8484` ist die eine bewusste, begrenzte Ausnahme,
und `VP_CONTROL_ENABLED` bleibt das äußere UND. Ablauf:
[`CONTROL-BENCH.md`](CONTROL-BENCH.md) → „Checkliste Kostal PLENTICORE".

## 6. Firmware-Hinweis

Die Registerkarte gilt für G1 ab UI 01.16.05025 (Praxis-Untergrenze der
Feld-Integrationen) und ist mit der aktuellen Doku Rev. 2.9 (G1 ab UI
01.30.12092, G2, G3/MP G3) deckungsgleich für die hier gelesenen Register.
Vor Inbetriebnahme Firmware aktualisieren (Webserver), Stand notieren.

## Wechselrichter-Automatik (Selbstregel-Modus)

In einem Slot, den die Wolke als „Verbrauch decken lohnt sich" markiert
(`cover_load_from_battery` / `unplanned_load_discharge`), darf die Box aufhören,
alle 10 Sekunden einen Sollwert zu schreiben, und die Regelung dem Gerät selbst
überlassen. Vertrag + Aufsicht: `docs/contracts/v2/plan-execution-ownership.md`
und `edge-app/core/internal/guards/nativemode.go`; Prüfstand-Tor:
[`UNPLANNED-LOAD-BENCH.md`](UNPLANNED-LOAD-BENCH.md).

**Der Schreibplan ist der RELEASE-Plan dieses Tiers plus ein
Zustands-Rücklesen als BELEG — einmal geschrieben, danach nur noch gelesen.**

| | |
|---|---|
| **hinein** | **GAR NICHTS** — aufhören zu schreiben IST die Übergabe: nach dem im Webserver eingestellten Timeout (30–60 s) verwirft der Wechselrichter den externen Sollwert und kehrt zur internen Batteriesteuerung zurück. |
| **heraus** | `1034` wieder schreiben — sofort wirksam. |
| **Nachweis** | ⚠ **BEHAVIORAL, kein Register.** `1080` liest in BEIDEN Zuständen 2, es gibt also keinen Registerwert, der sie unterscheidet. Der Prüfstand muss beobachten, dass `582` (Batterieleistung) der Hauslast folgt, während wir nichts schreiben. |
| **EEG** | kein lesbares Ladequellen-Register ⇒ auf einer EEG-Anlage wird die Automatik VERWEIGERT. |
| **Totmann** | der geräteeigene (Webserver-Timeout). |

**⚠ Die Hinein-Latenz ist der Timeout T (bis 60 s)** — deutlich länger als bei
jedem anderen Adapter. Sie ist genau die Größe, gegen die die Marge über dem
Reserve-Boden bemessen ist, und Kriterium 8 verlangt, sie zu messen.

**Was der Prüfstand noch beweisen muss:** T am konkreten Gerät, der behaviorale
Nachweis über mindestens 5 Minuten mit Lastwechsel, und der widersprüchlich
belegte „sticky 0"-Fall (gibt ein weiter geschriebenes `0` intern zurück?).
