# Wechselrichter-Steuerung: Freigabe am Prüfstand (Bench-Verification)

Die VoltPilot-Steuerung schreibt den optimierten Fahrplan-Sollwert in den
Wechselrichter **und liest jedes Register zurück**, um register-genau zu belegen,
dass der Wechselrichter den Befehl übernommen hat (Rückleseverifikation, siehe
`inverter-control-routing.js` + `:8484` „Steuerung & Bestätigung").

**Sicherheitsvorgabe (Captain-Entscheidung 3, nicht verhandelbar):** Steuerung ist
**standardmäßig AUS** (`VP_CONTROL_ENABLED=false`), und **kein Modell schreibt live,
bevor es am Prüfstand freigegeben (zertifiziert) wurde.** Der generische
SunSpec-/Modbus-Adapter ist gegen den Simulator bewiesen und daher zertifiziert;
**alle Deye-Familien sind bewusst NICHT zertifiziert** (`CERTIFIED_CONTROL_FAMILIES`
in `inverter-control-routing.js` bzw. `VP_CONTROL_CERTIFIED_FAMILIES` im Core) und
bleiben **nur lesend**, bis diese Checkliste pro Modell abgearbeitet ist. Die
ToU-/Work-Mode-Register in `inverter-control-routing.js` (`DEYE_CONTROL_REG`) sind
seit 2026-07-08 **quellenbasiert aus [`davidrapan/ha-solarman`](https://github.com/davidrapan/ha-solarman)**
(MIT; `deye_p3.yaml` → `hybrid_3p`, `deye_hybrid.yaml` → `hybrid_1p`) statt trianguliert -
ha-solarman steuert denselben Solarman-V5-Logger, die Adressen sind also belastbar.
Sie bleiben dennoch **als `bench_pending` markiert** (per Modell/Firmware zu bestätigen) und
werden bis zur Freigabe nie in einen Schreibbefehl umgesetzt. Konkrete Adressen: siehe
die Tabelle in [`DEYE.md`](DEYE.md) → „Ausgeklammert: Hybrid-Batteriesteuerung".

Diese Datei ist die Vorlage, die firstmate dem Captain für die Prüfstand-Sitzung an
seinem echten **SUN-\*-SG01HP3-EU** (und einem LV-Gerät **SG04LP3**) übergibt.

## Vor der Sitzung

- Steuerung an einem **Ersatz-/Testspeicher** verifizieren, nie am produktiven
  Kundenspeicher. Ein falscher Schreibbefehl kann die Batterie beschädigen.
- Nur mit gesetzten Software-Klammern (Strom-/SoC-/Leistungsgrenzen) arbeiten; die
  Guards des Core (`guards.Clamp`) begrenzen den kW-Sollwert bereits, der Adapter darf
  ihn nie aufweiten.
- Read-Pfad muss stehen: der `deye/solarman-probe.js`-Dump (`node solarman-probe.js
  --ip <logger> --serial <n> --family hybrid_3p`) muss plausible Messwerte liefern,
  bevor überhaupt geschrieben wird.

## Checkliste (pro Modell/Firmware abzuhaken - report §6.3)

1. **Register-Adressen bestätigen.** Die ha-solarman-Adressen für dieses Firmware-Release
   verifizieren: Work Mode (`0x008E` 3p / `0x00F4` 1p), Time-of-Use-Enable (`0x0092` / `0x00F8`),
   ToU-Programm 1 (Startzeit `0x0094`/`0x00FA`, Leistung `0x009A`/`0x0100`, Ziel-SoC `0x00A6`/`0x010C`,
   Charging-Enum `0x00AC`/`0x0112`) und die Lade-/Entlade-STROMgrenzen (`0x006C`/`0x006D` bzw.
   `0x00D2`/`0x00D3`) - alle in `DEYE_CONTROL_REG`. Als Beweis, dass die Adressen NICHT im
   Telemetriefenster liegen: der Lese-Dump `0x008D…0x00B1` (3p) muss statische Config-Werte
   zeigen (Enums, Prozente, Zeiten), nicht die schwankende Live-Telemetrie aus `0x024C…`/`0x0F00…`.
   Abweichung → Adresse pro Modell in der Config überschreiben (kein Code-Edit), **nie eine
   geratene Adresse als zertifiziert ausliefern**.
2. **Richtung über Ziel-SoC.** Belegen, dass ein ToU-Slot mit Ziel-SoC = 100 %
   tatsächlich **lädt** und mit Ziel-SoC = SoC-Untergrenze tatsächlich **entlädt**
   (Strategie A). Gegen die gemessene Batterieleistung querchecken.
3. **Vorzeichen jedes geschriebenen Werts.** Firmware-abhängig - nie annehmen. Über
   die vorhandenen `invert_*`-Flags kalibrieren; falls die Schreibrichtung invertiert
   ist, `invert_control_sign` in der Inverter-Config setzen (der Adapter liest es,
   hardcodiert nie ein Vorzeichen).
4. **Strom vs. Leistung.** ToU-Leistung ist Watt, die Grenzen sind **Ampere**. Die
   kW→A-Umrechnung (über die gemessene Batteriespannung) verifizieren, falls
   strombasiert gesteuert wird.
5. **Rücklese-Treue.** Belegen, dass jedes geschriebene Register **prompt seinen
   geschriebenen Wert zurückliest** (die Rückleseschleife), UND dass der
   Wechselrichter tatsächlich handelt (gegen die Telemetrie-Leistung querchecken). Die
   `:8484`-Karte muss „bestätigt" zeigen; eine echte Abweichung muss als „Abweichung"
   erscheinen.
6. **EEPROM-Schreibkadenz.** Die ToU-/Work-Mode-Register sind EEPROM. Bestätigen, dass
   die Write-on-Change-+-Mindestverweildauer-Politik (`dwell_s`/`min_change` je
   WriteOp, slot-orientiert ≤ 4×/h) innerhalb der Herstellerangaben zur
   Schreibfestigkeit liegt.
7. **Fail-Safe.** Belegen: Steuerung abschalten (`VP_CONTROL_ENABLED=false`) bzw. Plan
   veraltet (>20 Min) bzw. Verbindungsverlust → der Wechselrichter kehrt in einen
   sicheren Neutralzustand zurück (Eigenverbrauch / kein erzwungener Sollwert, keine
   veraltete Begrenzung latch-t). Kein stehender Zwangssollwert.

## Freigabe (Zertifizierung)

Erst wenn **alle sieben Punkte** für ein konkretes Modell/Firmware bestätigt sind:

- Die Register-Familie in die Zertifizierungs-Allowlist aufnehmen -
  `VP_CONTROL_CERTIFIED_FAMILIES` im Core (z. B. `sunspec,hybrid_3p`) und
  `CERTIFIED_CONTROL_FAMILIES` in `inverter-control-routing.js` (+ dem synchron
  gehaltenen Flow-Knoten). Beide Gates sind absichtlich redundant (Defense-in-Depth).
- Steuerung pro Gerät scharfschalten: `VP_CONTROL_ENABLED=true` erst für die
  freigegebenen Geräte.
- Netzladen bleibt EEG-gesperrt: das Netzlade-Bit wird nur gesetzt, wenn der Standort
  Netzladen ausdrücklich erlaubt (`grid_charge_allowed`, aus `site.netzladen_erlaubt`);
  Standard ist AUS.

Solange ein Modell nicht freigegeben ist, zeigt das Portal „Steuerung für dieses
Modell noch nicht freigegeben" und die `:8484`-Karte „nur lesen" - die Anlage wird
ausgelesen, aber nicht gesteuert.

## Siehe auch

- [`inverter-control-routing.js`](inverter-control-routing.js) - die getestete
  `controlRoute`-Abstraktion (Schreibplan + Rücklesen), Quelle der Wahrheit.
- [`deye/solarman-v5.js`](deye/solarman-v5.js) - die FC6/FC16-Schreibframes für Deye
  (Round-Trip-getestet).
- [`DEYE.md`](DEYE.md) → „Ausgeklammert: Hybrid-Batteriesteuerung" - die
  ha-solarman-basierten Steuerregister je Familie (Ausgangspunkt für Punkt 1).
- [`davidrapan/ha-solarman`](https://github.com/davidrapan/ha-solarman) (MIT) - Quelle der
  Adressen (`deye_p3.yaml` = `hybrid_3p`, `deye_hybrid.yaml` = `hybrid_1p`).
- Scout-Bericht `vp-inverter-control-arch/report.md` §6.3 - die ursprüngliche Liste.
