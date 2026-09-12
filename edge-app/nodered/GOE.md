# go-e Charger (Wallbox): Lesen + Steuern über die lokale HTTP-API v2

Operator-Notizen für den go-e-Pfad der Verbrauchssteuerung.
Lesen: `goe/goe-api.js` (Quelle mit Rolle **Verbraucher**, `load_kw` aus `nrg[11]`).
Steuern: der Go-Core-Executor `edge-app/core/internal/goe` (der Einzel-Schreiber; Node-RED bleibt bewusst read-only), kanonische JS-Referenz `goe/goe-control.js`, beide an dieselben Golden-Vektoren gepinnt (`goe/goe-control-vectors.json`).
Bench-Ablauf + Zertifizierungs-Abschluss: [`CONTROL-BENCH.md`](CONTROL-BENCH.md) → „go-e Charger".

```mermaid
flowchart LR
  Rule[Plan oder Regel] --> Core[Core: Freigabe und Grenzen]
  Core --> Write[Geräteauftrag]
  Write --> Readback[Rückmeldung lesen]
  Readback --> Measure[Wirkung mit Messwerten prüfen]
```

## 1. Geräte-Voraussetzungen

- **Lokale HTTP-API v2 aktivieren:** go-e-App → Internet → „Lokale HTTP API v2" einschalten.
  Ohne diesen Schalter antwortet die Wallbox auf `/api/status` nicht.
- **Feste Adresse:** der Wallbox im Router eine **feste IP** geben (DHCP-Reservierung).
  mDNS (`go-echarger-XXXXXX.local`) funktioniert je nach Netz, ist aber weniger robust als eine reservierte IP — die Config nimmt beides, empfohlen ist die IP.
- Firmware aktuell halten (die API-v2-Schlüssel sind über die Firmware-Stände stabil; die Schlüssel-Referenz liegt im offiziellen Repo `goecharger/go-eCharger-API-v2`).
- **Phasenumschaltung nur auf umschaltfähiger Hardware** (interner 1p/3p-Umschalter, z. B. go-e Gemini flex; ein fest 1- oder 3-phasig angeschlossenes Modell kann nicht umschalten).
  Deshalb ist sie ein **Config-Opt-in** (`phase_switching`), nie eine Annahme.

## 2. Verbindung testen (D11, Selbst-Service)

`:8484` → Einrichten → Verbraucher hinzufügen (go-e) → **„Verbindung testen"** prüft zweierlei:

1. den **Lesepfad** (`/api/status`: Ladeleistung, Fahrzeugstatus), und
2. den **Steuer-Schreibweg**: die AKTUELLE Ampere-Vorgabe (`amp`) wird wertgleich neu geschrieben und zurückgelesen — ein semantisches No-op, das nie einen Ladevorgang unterbricht, aber beweist, dass die Wallbox Schreibbefehle annimmt und echot („Steuer-Schreibtest bestätigt").
   `frc` (Freigabe) und `psm` (Phasen) werden dabei **nie** angefasst.

Der Test läuft unabhängig von den Steuer-Flags — er ist die Vorstufe, BEVOR ein Betreiber `VP_CONTROL_ENABLED`/`VP_CONSUMER_CONTROL_ENABLED` scharf schaltet.

## 3. Steuerschlüssel + Provenienz

| Schlüssel | Bedeutung | Quelle |
|---|---|---|
| `frc` | forceState: Neutral=0 (Eigenlogik), Off=1, On=2 | offiziell (`apikeys-en.md`) |
| `amp` | requestedCurrent in Ampere | offiziell |
| `psm` | phaseSwitchMode: Auto=0, Force_1=1, Force_3=2 | **nicht in der offiziellen Liste**; produktiv belegt durch evcc (`phases1p3p` schreibt `psm=1/2`) und Home Assistant (`marq24/ha-goecharger-api2`) |
| `pnp` | numberOfPhases (tatsächlich genutzte Phasen) | offiziell, read-only |
| `car`/`nrg`/`acu`/`alw` | Fahrzeugstatus / Energie-Array / erlaubter Strom / Ladefreigabe | offiziell, read-only |

Die offizielle Doku kennt die Phasen-Maschinerie um `psm` herum (`fsp` R/W force_single_phase, `mptwt` min phase toggle wait time, `psh` phaseSwitchHysteresis) — `psm` ist eine Dokumentationslücke, kein geratenes Register.
Ob ein konkretes Modell auf `psm` wirklich den Schütz umschaltet, bleibt **VERIFY-on-device** (Bench-Checkliste).

## 4. Steuer-Verhalten des Treibers

- **kW→A je aktiver Phasenlage**, ABGERUNDET (die tatsächliche Ladeleistung überschreitet nie den Sollwert), geklemmt auf das Strom-Band (`min_current_a`..`max_current_a`, Vorgabe 6..16 A).
- **Failsafe = `release`** (§4.2-Vorgabe für native Wallboxen): bei Stopp, Staleness oder fehlendem Befehl schreibt der Treiber `frc=Neutral` — die Wallbox fällt in ihre EIGENE Logik zurück, nie ein hängender Zwangsstrom und kein erzwungenes Aus.
- **Readback nach jedem Schreiben:** `frc`/`amp`/`psm` werden zurückgelesen und commanded-vs-actual verglichen (`all_match`); ein Schreibfehler oder Timeout ist ein ehrlicher Status (`error_code` im Readback), nie ein stiller Erfolg.
- **Phasenumschaltung (D4)**, nur mit `phase_switching: true`:
  - Die zwei nicht-konvexen Leistungsbereiche entstehen aus dem Strom-Band des GERÄTS: 1-phasig ≈ 1,4–3,7 kW, 3-phasig ≈ 4,2–11 kW (bei 6–16 A @ 230 V).
  - Bereichswahl aus dem Sollwert; ein Wunsch **zwischen** den Bereichen wird restrict-only nach UNTEN geschnappt — ein Wert zwischen den Bereichen erreicht das Gerät nie.
  - **Umschalt-Pacing** (Fahrzeug-Elektronik-Schonung, konservativ, je Gerät justierbar): `phase_switch_dwell_s` (Vorgabe 60 s — der neue Wunsch-Bereich muss so lange stabil sein) + `phase_switch_pause_s` (Vorgabe 300 s Mindestpause zwischen zwei Umschaltungen). Beides zusätzlich zum geräteeigenen Schutz (`mptwt`), nie statt seiner.
  - Während der Pacing-Pause hält der Treiber restrict-only im AKTIVEN Bereich (1p: sein Maximum; 3p bei kleinem Wunsch: Aus) und meldet ehrlich **„wartet - Phasenumschaltpause"** (`guard_phase_switch`, bis ins Portal).
  - Unbekannte Phasenlage (noch kein Readback) ⇒ Umrechnung restrict-sicher mit 3 Phasen, **nie ein blinder `psm`-Schreibbefehl**.

## 5. Config-Felder (`driver.connection` bzw. Quellen-Verbindung)

```json
{
  "ip": "192.168.0.50",
  "port": 80,
  "phases": 3,
  "voltage": 230,
  "min_current_a": 6,
  "max_current_a": 16,
  "phase_switching": true,
  "phase_switch_pause_s": 300,
  "phase_switch_dwell_s": 60
}
```

Nur `ip` ist Pflicht; alles andere hat die genannten Vorgaben.
`phases` gilt für Geräte OHNE Phasenumschaltung (feste Lage); mit `phase_switching` folgt die Umrechnung dem aktiven Bereich.

## 6. Sicherheits-Rahmen (unverändert)

Der Executor läuft nur mit `VP_CONTROL_ENABLED` **und** `VP_CONSUMER_CONTROL_ENABLED` (Vorgabe: global EIN, Verbrauchersteuerung AUS; Lesen und der ausdrücklich ausgelöste Verbindungstest bleiben getrennte Pfade).
Vorgelagert bleiben alle Guards autoritativ: Verbraucher-Klemme des Arbiters, Zyklen-Guard (Mindestlauf/-pause/Startbudget), §14a/Netz/Vertrag.
Der Gerätetyp `wallbox` bleibt im entitytypes-Katalog **unzertifiziert** (`simulator_only`), bis die Bench-Session des Captains den Katalog-Flip als eigenen Mini-PR liefert (D11; `CONTROL-BENCH.md`).
