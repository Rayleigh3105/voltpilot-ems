# Wechselrichter-Steuerung: Freigabe am Prüfstand (Bench-Verification)

Die VoltPilot-Steuerung schreibt den optimierten Fahrplan-Sollwert in den
Wechselrichter **und liest jedes Register zurück**, um register-genau zu belegen,
dass der Wechselrichter den Befehl übernommen hat (Rückleseverifikation, siehe
`inverter-control-routing.js` + `:8484` „Steuerung & Bestätigung").

**Sicherheitsvorgabe (Captain-Entscheidung 3, nicht verhandelbar):** Der generische
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

**Tier-Modell + Standard-EIN (Stand 2026, `vp-batctl-generic-r4`):** Die Steuerung
dispatcht jetzt nach **`control_tier`** (0 read-only · 1 SunSpec-Modell 124 · 2 Vendor-EMS ·
3 Deye Time-of-Use), nicht nach der Lese-Kommunikation - so bekommt ein künftiger
Tier-2-Hersteller (Sungrow/SolarEdge) seinen eigenen Adapter, obwohl er über
`modbus_tcp` liest. `VP_CONTROL_ENABLED` ist **standardmäßig EIN** (Owner-Entscheidung);
sicher ist das ausschließlich, weil die **Zertifizierungs-Allowlist die eigentliche
Geräte-Klammer** ist: eine unzertifizierte Familie liefert `writes:[]`, also **keinen
Live-Schreibbefehl**, egal ob der Not-Aus an ist. Der **Deye-Solarman-V5-Schreib-Executor
ist gebaut und offline bewiesen** (`deye-control.e2e.test.js`: Schreiben→Zurücklesen→Abgleich
gegen einen echten In-Process-Solarman-V5-Server, EEPROM-Write-on-Change, Fail-Safe-Release),
aber `hybrid_3p` steht **NICHT** in der Allowlist → er macht in Produktion nichts. **Die
Freigabe = diese Checkliste bestehen, DANN die Familie in die Allowlist eintragen** (der
einzige, code-freie Schalter, der Live-Schreiben aktiviert). Sign/Scale sind Config
(`invert_control_sign`, `power_scale`; Deye HV = Dekawatt ×10) und werden hier kalibriert,
nie angenommen. **Dual-Controller-Warnung:** Solange VoltPilot steuert, muss das eigene
Smart-Control/„Selbstverbrauch+"-Programm des Wechselrichters AUS sein (evcc-Regel „nur ein
Controller"); ein möglicher Konflikt wird über die Rückmeldung/den Status sichtbar gemacht.

Diese Datei ist die Vorlage, die firstmate dem Captain für die Prüfstand-Sitzung an
seinem echten **SUN-\*-SG01HP3-EU** (und einem LV-Gerät **SG04LP3**) übergibt.

## First-Light-Kalibrierung (`:8484`, der geführte erste Schreibbefehl)

Der **allererste echte Schreibbefehl** auf einen produktiven Kundenspeicher läuft über
die geführte **First-Light-Kalibrierung** auf `:8484` (Karte „Steuerung kalibrieren",
`static/calibration.js` → `POST /api/calibration/*`). Sie ersetzt das manuelle
„kleinen Wert schreiben → zurücklesen → prüfen, ob sich die Batterie richtig bewegt"
aus report §5.7 durch eine sichere, auf **jeder Achse begrenzte** Bedienoberfläche:

- **Getrennter, eng begrenzter Schreibpfad** (nicht der Optimierer-Pfad) und bewusst
  **NICHT über die Zertifizierungs-Allowlist gegated** – genau das ist der Sinn: sign/scale
  am echten Gerät beweisen, BEVOR es zertifiziert wird. Der Bypass betrifft **nur** die
  Zertifizierung; `VP_CONTROL_ENABLED` (Not-Aus) muss weiter EIN sein.
- **Kleiner Betrag:** `|Sollwert| ≤ VP_CALIBRATION_MAX_KW` (Default **1,0 kW**), zusätzlich
  durch `guards.Clamp` begrenzt – die Oberfläche kann physisch nicht mehr kommandieren.
- **Kurz + Auto-Neutral:** jeder Testschreib **kehrt nach `VP_CALIBRATION_TTL_SECONDS`
  (Default 30 s) selbsttätig auf Neutral (Release) zurück** – ein Controller-eigener
  Watchdog, auch wenn die Oberfläche geschlossen ist. Der Befehl **rastet nie ein**.
- **Ein-Klick-Abbruch** („Abbrechen → Neutral"), ausgeschaltet per Voreinstellung
  (erst scharfschalten), jeder Schreib wird protokolliert.
- **Beobachten + prüfen an einer Stelle:** die Register-Rückmeldung („Kam der Befehl an?",
  aus der Karte „Steuerung & Bestätigung") plus die **Telemetrie-Differenz** („Hat die
  Batterie sich bewegt?" – gemessene Batterieleistung vs. kommandiert), damit **Vorzeichen
  und Größe sichtbar** werden. Falsches Vorzeichen → `invert_control_sign` setzen und erneut
  testen; ~10× daneben → `power_scale` = 10 (HV) und erneut testen (persistiert auf die
  Deye-Verbindung).
- **Freigabe = gated auf bestandene Kalibrierung:** erst wenn Vorzeichen UND Skala bestätigt
  sind, wird „Steuerung freigeben" freigeschaltet. Das ist eine **PER-GERÄT**-Zertifizierung
  (`calibration-certified.json` im Data-Dir, in `Agent.controlCertified` mit der
  Env-Allowlist gemergt) – danach steuert der Fahrplan **diesen** Wechselrichter live. Es
  **auto-zertifiziert nie**.

**Verhältnis zur Checkliste unten:** First-Light deckt die interaktiven Sign-/Scale-/
„Batterie bewegt sich"-Punkte am echten Gerät ab. Die restlichen Prüfpunkte (Limit-vs-Force,
EEPROM-Kadenz innerhalb der Endurance, Fail-Safe-Verhalten, Dual-Controller) bleiben Sache
der Bench-Sitzung. Die **fleet-weite** Freigabe einer Familie bleibt der Allowlist-Eintrag
(`VP_CONTROL_CERTIFIED_FAMILIES`); die First-Light-Freigabe ist die geräte-lokale Variante
für die erste Inbetriebnahme. Wo alles liegt: `internal/config` (die zwei Knöpfe),
`internal/calibration` (reine Zustandsmaschine + Verdikt), `agent/calibration.go` (der
Schreibpfad + Watchdog + Persistenz), `inverter-control-routing.js` (der Executor-Bypass),
`static/calibration.js` (die Oberfläche).

## Vor der Sitzung

- Steuerung an einem **Ersatz-/Testspeicher** verifizieren, nie am produktiven
  Kundenspeicher. Ein falscher Schreibbefehl kann die Batterie beschädigen.
- Nur mit gesetzten Software-Klammern (Strom-/SoC-/Leistungsgrenzen) arbeiten; die
  Guards des Core (`guards.Clamp`) begrenzen den kW-Sollwert bereits, der Adapter darf
  ihn nie aufweiten.
- Read-Pfad muss stehen: der `deye/solarman-probe.js`-Dump (`node solarman-probe.js
  --ip <logger> --serial <n> --family hybrid_3p`) muss plausible Messwerte liefern,
  bevor überhaupt geschrieben wird.

## Deye zuerst: hat dieses Gerät die FERNSTEUERUNG? (10 Sekunden, rein lesend)

Seit Deye-Protokoll **V105.1** gibt es einen echten externen-EMS-Registerblock **1100–1121**
(Fernsteuerung/Remote Mode): ein vorzeichenbehafteter Leistungssollwert für die Batterie,
abgesichert durch einen **Totmannschalter im Wechselrichter**. Er ist **firmwareabhängig**.
Das ist der billigste und entscheidendste Prüfstand-Schritt überhaupt - **vor** allem anderen:

```bash
# auf der Edge-VM, im selben LAN wie der Logger - NUR LESEN (FC03)
node edge-app/nodered/deye/solarman-probe.js \
  --ip <logger-ip> --serial <LOGGER-Seriennummer> \
  --start 0x044C --count 22          # = Register 1100..1121
```

| Ergebnis | Bedeutung | weiter |
|---|---|---|
| Modbus-Ausnahme / keine Antwort / nur Müll | Fernsteuerung **nicht vorhanden** | Zeitfenster-Checkliste unten |
| Plausible Werte, insbesondere **`1101 = 0xFFFF`** (der dokumentierte „Watchdog aus"-Standard) | Fernsteuerung **vorhanden** | hier weiter |
| `1104` in 0..2 **und** `1105` in 0..5 | PR-#978-Lage → Sollwert auf **1109** | der Adapter schreibt genau diese Lage |
| `1106` in 0..1 und `1111` sieht wie ±1200 aus | ältere V105.1-Lage (AC-seitig) | VoltPilot schreibt sie **nicht** und fällt auf ToU zurück |

Die Edge-App macht dieselbe Prüfung von selbst (zwei FC3-Lesebefehle, gecacht pro Logger, bei
Neustart erneut) und zeigt das Ergebnis auf der `:8484`-Karte „Steuerung & Bestätigung" als
**Fernsteuerung (Remote Mode)** bzw. **Zeitfenster-Steuerung (ToU)** an. Fehlt die Fernsteuerung,
kann Deye-Support sie per Firmware-Update **aus der Ferne** einspielen (`servicede@deye.com.cn`,
Seriennummer des Wechselrichters angeben) - Quelle: openEMS-Community #2541.

### Checkliste Deye FERNSTEUERUNG (pro Modell/Firmware)

Voraussetzung: **mittlerer SoC (40–70 %)**, ruhige Batterie (siehe „Ruhige Ausgangslage" oben),
Modell im Katalog ausgewählt (die Nennleistung kommt daher - der Sollwert ist 0,1 % davon).

- [ ] **Der erste Schreibbefehl ist klein.** First-Light-Kalibrierung mit ≤ 1 kW (`VP_CALIBRATION_MAX_KW`),
      TTL-Auto-Rückgabe aktiv. Nichts von Hand am Register schreiben.
- [ ] **Reihenfolge auf dem Draht:** `1101` (Totmann) zuerst → `1104=1` → `1105` → `1108` → `1109` →
      `1100=1` **zuletzt**. Im Log/Readback nachvollziehen.
- [ ] **Vorzeichen:** ein **Entlade**-Befehl schreibt einen **positiven** Wert nach 1109, ein
      **Lade**-Befehl einen negativen. Bewegt sich die Batterie in die *falsche* Richtung, ist das ein
      Konfigurationsfehler → `invert_control_sign` setzen, **niemals** den Code ändern.
- [ ] **Skala:** die gemessene Batterieleistung entspricht dem Befehl (±Regelabweichung). Bei 30 kW ist
      1 kW ≙ 33 Einheiten. Weicht sie um Faktor 10 ab, stimmt die Nennleistung des gewählten Modells nicht.
- [ ] **PV bleibt unangetastet:** batterieseitige Regelung darf die Erzeugung NICHT drosseln.
      Tut sie es doch, wurde AC-/netzseitig geschrieben - abbrechen.
- [ ] **Rücklesen:** `1109` echot den Sollwert, `1100` liest 1, `1121` (Status) wird protokolliert.
- [ ] **Rückmeldung ohne Antwort ist KEINE Abweichung** (Live-Vorfall 2026-07-30, siehe
      `DEYE.md` → „Die Rückmeldung: was ein Register-Ist-Wert BEDEUTET"): ein Ist-Wert
      **außerhalb** des dokumentierten Bereichs (typisch `65535` auf `1100`/`1104`/`1105`)
      ist ein Füller des Loggers und muss in der Tabelle als **„keine Antwort"** stehen,
      nicht als „⚠ Abweichung"; `1101` mit einem Wert **unter** dem scharfgestellten
      (z. B. 51 von 60) ist der Totmann **im Betrieb** und gilt als bestätigt. Eine
      Warnung darf erst nach **3 aufeinanderfolgenden** echten Abweichungen erscheinen -
      ein einzelner Flackerzyklus nie.
- [ ] **Totmann beweisen (der wichtigste Punkt):** aufhören zu schreiben und **warten**. Nach Ablauf von
      `1101` muss `1100` von selbst auf 0 gehen und der Wechselrichter normal weiterlaufen -
      **ohne dass eine Einstellung verändert ist**. Am Display steht währenddessen „Remote Mode".
- [ ] **Ausdrückliche Rückgabe:** `1100 ← 0` beendet die Steuerung sofort.
- [ ] **SoC-Grenzen:** unterhalb `soc_min` / oberhalb `soc_max` darf kein Befehl mehr in die falsche
      Richtung wirken. ⚠ Es gibt einen Feldbericht, dass die geräteeigenen SoC-Grenzen im Remote Mode
      **nicht** greifen - deshalb ist die VoltPilot-Klammer die maßgebliche und muss hier geprüft werden.
- [ ] **Keine Installateur-Einstellung verändert:** Energy Pattern, Solar Sell, Max Sell Power,
      Einspeisegrenze und ToU-Slots vorher/nachher vergleichen - sie müssen **identisch** sein.
      (Der Fernsteuerungspfad schreibt sie gar nicht; dieser Punkt ist die Gegenprobe.)

Erst wenn alles abgehakt ist, kommt die Familie in die Freigabe (siehe unten).

## Checkliste Deye ZEITFENSTER (ToU) - der Rückfall (report §6.3)

1. **Register-Adressen bestätigen.** Die ha-solarman-Adressen für dieses Firmware-Release
   verifizieren: Work Mode (`0x008E` 3p / `0x00F4` 1p), Time-of-Use-Enable (`0x0092` / `0x00F8`),
   ToU-Programm 1 (Startzeit `0x0094`/`0x00FA`, Leistung `0x009A`/`0x0100`, Ziel-SoC `0x00A6`/`0x010C`,
   Charging-Enum `0x00AC`/`0x0112`) und die Lade-/Entlade-STROMgrenzen (`0x006C`/`0x006D` bzw.
   `0x00D2`/`0x00D3`) - alle in `DEYE_CONTROL_REG`. Als Beweis, dass die Adressen NICHT im
   Telemetriefenster liegen: der Lese-Dump `0x008D…0x00B1` (3p) muss statische Config-Werte
   zeigen (Enums, Prozente, Zeiten), nicht die schwankende Live-Telemetrie aus `0x024C…`/`0x0F00…`.
   Abweichung → Adresse pro Modell in der Config überschreiben (kein Code-Edit), **nie eine
   geratene Adresse als zertifiziert ausliefern**.
2. **ENTLADEN: der Ziel-SoC allein reicht NICHT (report `vp-deye-tou-dir-q5` §8/§9).**
   Der ToU-Ziel-SoC ist ein Entlade-**Boden**, kein Befehl; in Export First lädt der Deye
   den Überschuss erst in die Batterie. Reihenfolge am Prüfstand:
   - **(a) Batterie zuerst auf ≈40-70 % entladen.** Bei 100 % SoC ist eine Entladung
     praktisch unbeobachtbar (die volle Batterie kann kein „+12 kW" aufnehmen, ein
     „Laden auf 100 %"-No-Op täuscht einen Fix vor). Batterie **ruhig** (`|vorher| <
     ~0,5·|Befehl|`), idealerweise wenig PV.
   - **(b) Strategie A billig widerlegen:** den ALTEN Entladeplan (Ziel-SoC 5 %, kein
     Solar Sell) fahren - er liefert KEINE saubere, gekappte Entladung. Als
     kontrollierten Beweis protokollieren.
   - **(c) Korrigierten Plan (§8) testen, 6b ZUERST:** Solar Sell AN (`0x0091`) +
     Energy Pattern Load First (`0x008D`) + Export-Grenze `0x008F` = X + Ziel-SoC-Boden;
     jedes Register zurücklesen UND die **gemessene** Batterieleistung muss bei ≈X
     **negativ** werden. Wenn nicht → auf **6a** eskalieren (Max-Ladestrom `0x006C`
     klemmen; NICHT in diesem PR verdrahtet). Die Programm-Leistungskappe bestätigen
     (X = 2 kW schreiben → ≤ 2 kW).
   - **(d) Ziel-SoC = 100 % lädt** weiterhin (Strategie A fürs Laden, gegen die
     Telemetrie querchecken).
   - **(e) `invert_control_sign` AUS lassen** (§5, Ablenkungsmanöver) - nur bei einer
     *tatsächlich* beobachteten Wire-Level-Inversion NACH korrigiertem Mapping setzen.
2a. **Aktiver Slot (N2).** Durch Lesen der Programm-2-6-Startzeiten bestätigen, dass
   Programm 1 zur Testzeit der aktive Slot ist; sonst sind die Programm-1-Schreibvorgänge
   inert. Der Executor liest die 6 Zeiten und WARNT bei Verdrängung - wir schreiben
   Programme 2-6 NIE um; einmalige Inbetriebnahme setzt das Slot-Raster (§8.9).
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
7. **Fail-Safe + Snapshot-Restore (Deye hat KEINEN Revert-Timer).** Belegen: Steuerung
   abschalten (`VP_CONTROL_ENABLED=false`) bzw. Plan veraltet (>20 Min) bzw.
   Verbindungsverlust → der Wechselrichter kehrt in einen sicheren Neutralzustand
   zurück. Weil die neuen Hebel (Energy Pattern, Solar Sell, Max Sell Power)
   Installateur-Einstellungen sind, MUSS `controlRelease` die **vor der Steuerung per
   FC3 aufgenommenen** Werte zurückschreiben (nicht nur `tou_enable = 0`) - prüfen, dass
   NICHTS latch-t (kein stehender Export-Enable / geänderte Energy-Pattern / stehende
   Sell-Power). Auch **Absturz-Wiederherstellung** testen: Steuerung schreiben, Node-RED
   neu starten (der Snapshot in `/data/context` überlebt) → beim Start setzt der
   Wiederherstellungs-Knoten die Installateur-Werte zurück.

## Checkliste Fronius (SunSpec Modbus, Curtailment - Increment 1)

Fronius-Steuerung läuft über **SunSpec Modbus** (Modell 123 `WMaxLimPct`), nicht die
Solar-API und nicht `config/timeofuse` (Design-Bericht `vp-fronius-control-scout-c4`).
Der Adapter (`inverter-control-routing.js` → `froniusControl`) + die Modell-Erkennung
(`sunspec/model-discovery.js`) sind gebaut, aber **unzertifiziert**: Fronius steht
**nicht** in `CERTIFIED_CONTROL_FAMILIES` / `VP_CONTROL_CERTIFIED_FAMILIES`, der Plan
ist **nur `planned`** (`bench_pending`), es gibt **keinen Live-Write**. Der
automatisierte Beweis läuft nur gegen den **Simulator** (SunSpec-Profil, Reg 40/41/42);
ein echter Fronius-Write geht erst nach diesem Durchgang live.

**Vor der Sitzung (Fronius-spezifisch):**

- Am Wechselrichter **Kommunikation → Modbus**: (1) **SunSpec Model Type** wählen
  (`float` 111/112/113 oder `int + SF` 101/102/103) und (2) **„Allow Control"** ankreuzen
  (zweiter Schalter neben „Solar API aktivieren"). Ohne „Allow Control" antwortet der
  Wechselrichter auf keine Schreibbefehle.
- **An einem Ersatz-Wechselrichter mit echter Batterie** testen, nie am Kundengerät.
- Steuer-Endpunkt: Modbus TCP auf `<IP>:502` (getrennt vom Solar-API-Lese-Port 80);
  ggf. `control_port`/`control_unit_id` in der Inverter-Config setzen.

**Abzuhaken (pro Modell/Firmware, Bericht §3.3):**

1. **Modell-Erkennung.** Der dynamische Walk (`sunspec/model-discovery.js`) findet
   Common (1), Nameplate (120), **Immediate Controls (123)** und Storage (124) auf
   genau diesem Gerät + Firmware + SunSpec-Model-Type korrekt. **Adressen live erkannt,
   nie aus einer Tabelle** (zwei Community-Tabellen widersprachen sich beim selben
   Register). Modell 123 fehlt → idle-sicher, kein Schreibplan.
2. **`WMaxLimPct`/`WMaxLim_Ena` wirken + lesen zurück.** Einen Wert (z. B. 50 %)
   schreiben, per FC3 zurücklesen (Rückleseschleife), und gegen die gemessene
   Einspeiseleistung querchecken, dass die Begrenzung tatsächlich greift.
3. **`WMaxLimPct_RvrtTms` (Totmann-Schalter).** Wert setzen, Schreiben **einstellen** →
   der Wechselrichter muss die Begrenzung nach Ablauf des Rückfall-Timeouts **sicher
   aufheben** (kein stehender Zwangswert). Standard 60 s (der Core republiziert alle
   ~10 s), Bereich laut Handbuch 0-28800 s - am Gerät verifizieren.
4. **kW↔%-Umrechnung.** `WMaxLimPct` ist Prozent der Nennleistung; die erkannte
   `WRtg` (× 10^`WRtg_SF`) und der live gelesene `WMaxLimPct_SF` (Fallback -2) müssen
   die kW↔%-Umrechnung sauber round-trippen (z. B. 6 kW Cap auf 12 kW → 50 %).
5. **Vorzeichen/Skalierung.** Firmware-abhängig, nie annehmen (im Code „VERIFY on
   device" markiert). Am echten Gerät bestätigen, dass eine höhere `WMaxLimPct` mehr
   Einspeisung erlaubt und `WMaxLim_Ena = 0` die Begrenzung wirklich aufhebt.
6. **Reihenfolge + Fail-Safe.** Der Plan schreibt Wert + Rückfall-Timer VOR der
   Aktivierung. Bestätigen: Steuerung aus / Plan veraltet / Verbindungsverlust →
   neutraler Zustand (keine stehende Begrenzung).

## Checkliste Fronius PV-Abregelung (Increment 3) - die geführte Freigabe auf der Anlage

Increment 3 macht die Abregelung auf **fronius_sunspec-ERZEUGER-QUELLEN** live -
aber **NUR je einzeln freigegebener Wechselrichter-Einheit** (First-Light-Grant
`ip:port#unit_id`, nie die Familien-Allowlist). Der Nachweis ist geführt und
läuft direkt auf der Anlage (`:8484` → Einrichten → „PV-Abregelung
kalibrieren") - KEIN Register-Handbetrieb nötig. Für die zwei Pilsting-Fronius
(`192.168.210.40:502`, Unit 1 + Unit 2), **je Einheit einzeln, bei Sonne
(≥ 5 kW aktuelle Leistung der Einheit)**:

1. **Voraussetzungen prüfen.** Am Datamanager Kommunikation → Modbus:
   „Allow Control" ist angehakt (ohne antwortet der Wechselrichter auf keinen
   Schreibbefehl); `VP_CONTROL_ENABLED=true` auf dem Core; beide Fronius sind
   als fronius_sunspec-Erzeuger-Quellen eingerichtet und liefern Daten.
2. **Karte öffnen.** `:8484` → Einrichten → „PV-Abregelung kalibrieren": beide
   Einheiten erscheinen mit Status „noch nicht freigegeben" + aktueller
   Leistung. (Ist das Kalibrier-Kennwort gesetzt, fragt die Karte danach.)
3. **Test starten** („Test: auf X kW begrenzen (80 %)"). Was passieren MUSS,
   live auf der Karte:
   - „Register: ✓ bestätigt" - `WMaxLimPct`/`RvrtTms`/`Ena` wurden geschrieben
     und unverändert zurückgelesen (an live erkannten Modell-123-Adressen);
   - der „Tiefste Messwert" fällt binnen ~1-2 Minuten auf die Test-Begrenzung
     (z. B. 21,4 kW → ≤ ~17,1 kW). Fällt er NICHT, obwohl die Register
     bestätigt sind, übersteuert etwas die Modbus-Begrenzung (lokale
     Einstellung / Solar.web / Smart-Meter-Regel - Modbus hat auf Fronius die
     NIEDRIGSTE Priorität): NICHT freigeben, Ursache am Gerät klären.
4. **Automatischer Rückfall.** Nach spätestens 120 s endet der Test von selbst
   und die Leistung erholt sich (der native `WMaxLimPct_RvrtTms` = 60 s ist
   dabei der Geräte-Totmann - auch bei Absturz des Core bleibt nichts
   gedrosselt). Das MUSS sichtbar passieren, bevor freigegeben wird.
5. **Freigeben.** „Abregelung freigeben" wird erst aktiv, wenn BEIDE Nachweise
   vorliegen (Register bestätigt + Leistung gefallen) und bleibt es für 3 min
   nach Testende. Die Freigabe gilt dieser EINEN Einheit (physisch verankert,
   überlebt Neustart + Quellen-Neuanlage); „Freigabe zurücknehmen" jederzeit.
6. **Wiederholen für Unit 2**, dann Gegenprobe im Betrieb: bei der nächsten
   „Abregeln"-Phase des Fahrplans zeigt die Betrieb-Karte „VoltPilot begrenzt
   die PV-Einspeisung … (bestätigt)" mit der Summe der Einzel-Begrenzungen,
   und der Export am Netzanschluss folgt. Ein „möglicher Override" auf der
   Karte / im Portal-Heartbeat ist IMMER ein Handlungsauftrag (fremden
   Controller abschalten), nie zu ignorieren.

## Checkliste Fronius (SunSpec Modbus, Batterie-Laden/-Entladen - Increment 2)

Batterie-Laden/-Entladen läuft über **SunSpec Modell 124 (Storage)** (+ 802/803 für
Batteriebank-Details, falls vorhanden) - `InWRte`/`OutWRte`, `StorCtl_Mod`,
`MinRsvPct`, `ChaGriSet`, mit dem herstellereigenen `InOutWRte_RvrtTms`-Totmann-Schalter.
Der Adapter (`inverter-control-routing.js` → `froniusControl`) plant diese Register über
`sunspec/model-discovery.js` → `planStorage`. **Höheres Risiko als Curtailment: ein
falsches Vorzeichen oder eine falsche Skalierung kann die Batterie schädigen** (Bericht
§3.4). Wie Curtailment ist es **unzertifiziert**: Fronius steht nicht in
`CERTIFIED_CONTROL_FAMILIES` / `VP_CONTROL_CERTIFIED_FAMILIES`, der Plan ist **nur
`planned` (`bench_pending`)**, es gibt **keinen Live-Write**. Batteriesteuerung ist
**pro Batterie-Marke** (BYD, LG Chem RESU, Fronius-eigene Linie …) einzeln zu bestätigen,
genau wie die Deye-Familien.

**Vor der Sitzung (zusätzlich zur Curtailment-Vorbereitung oben):**

- **Echte Batterie am Ersatz-Wechselrichter**, nie am Kundenspeicher - ein falscher
  Lade-/Entlade-Befehl kann die Batterie beschädigen.
- „Allow Control" muss gesetzt sein (siehe Curtailment-Abschnitt); der Read-Pfad
  (SoC, Batterieleistung) muss plausible Werte liefern, bevor geschrieben wird.

**Abzuhaken (pro Modell/Batterie-Marke/Firmware, Bericht §3.3/§3.4, in dieser Reihenfolge):**

1. **Modell-Erkennung findet Storage.** Der dynamische Walk lokalisiert Modell 124
   (und 802/803 falls vorhanden) korrekt auf genau diesem Gerät + Firmware. **Adressen
   live erkannt, nie aus einer Tabelle.** Modell 124 fehlt → idle-sicher, kein Speicher-
   Schreibplan (auch bei vorhandenem Modell 123 wird dann nur Curtailment geplant).
2. **`InWRte`/`OutWRte` Richtung + Vorzeichen.** Belegen, dass ein Laden-Sollwert
   `InWRte` setzt (+ `StorCtl_Mod` Bit0) und **tatsächlich lädt**, ein Entladen-Sollwert
   `OutWRte` (+ Bit1) und **tatsächlich entlädt** - gegen die gemessene Batterieleistung
   querchecken, nie annehmen. Bei invertierter Schreibrichtung `invert_control_sign` in
   der Inverter-Config setzen (der Adapter liest es, hardcodiert nie ein Vorzeichen).
3. **`StorCtl_Mod`-Bit-Semantik.** Bestätigen: Bit0 = Ladebegrenzung aktiv, Bit1 =
   Entladebegrenzung aktiv; `StorCtl_Mod = 0` = Steuerung freigegeben (Rückfall auf
   Eigenverbrauch). Und dass das Setzen des Bits die Rate **erzwingt** (nicht nur nach
   oben begrenzt) - falls es nur begrenzt, ist die Zuordnung pro Modell zu überdenken.
4. **`WChaMax`-basierte kW↔%-Umrechnung.** `InWRte`/`OutWRte` sind Prozent von `WChaMax`
   (der Nennladeleistung der Batterie), skaliert mit dem **live gelesenen** `InOutWRte_SF`
   (Fallback -2). Die Umrechnung über die tatsächliche `WChaMax` sauber round-trippen
   (z. B. 5 kW auf 10 kW `WChaMax` → 50 %). `WChaMax` selbst über `WChaMax_SF` prüfen.
5. **`MinRsvPct` (Reserve-Untergrenze) aus `soc_min`.** Belegen, dass der geschriebene
   Wert die Reserve-SoC-Untergrenze setzt (skaliert mit `MinRsvPct_SF`) - ein
   Reserve-Boden, **kein** per-Zyklus-Ziel (anders als der Deye-Ziel-SoC-Trick;
   `InWRte`/`OutWRte` tragen die Richtung direkt, der Trick entfällt hier).
6. **`ChaGriSet` Netzlade-Gate + EEG-Standard AUS.** Bestätigen: das Netzlade-Register
   wird **nur** auf `GRID` gesetzt, wenn der Standort Netzladen ausdrücklich erlaubt
   (`grid_charge_allowed`, aus `site.netzladen_erlaubt`) **UND** geladen wird; sonst `PV`
   (aus). Standard AUS - **vor** dem ersten scharfen Netzlade-Bit verifizieren. Das
   genaue Enum (`PV`/`GRID`) ist am Gerät zu bestätigen (community-dokumentiert).
7. **`InOutWRte_RvrtTms` (Totmann-Schalter) end-to-end.** Wert setzen, Schreiben
   **einstellen** → die Batterie muss nach Ablauf des Rückfall-Timeouts in den
   **Eigenverbrauch zurückkehren** (nicht auf der letzten befohlenen Rate stehen bleiben).
   Standard 60 s (der Core republiziert alle ~10 s), Bereich 0-28800 s.
8. **Reihenfolge + Rücklese-Treue.** Der Plan schreibt Raten + Reserve + Netzlade-Gate +
   Rückfall-Timer VOR dem `StorCtl_Mod` (die Aktivierungs-Bits zuletzt). Bestätigen: jedes
   Register liest prompt seinen geschriebenen Wert zurück (die Rückleseschleife), UND die
   Batterie handelt tatsächlich (gegen die Telemetrie-Leistung).
9. **EEPROM-Schreibkadenz.** `MinRsvPct`/`ChaGriSet` sind Config (EEPROM), `InWRte`/
   `OutWRte`/`StorCtl_Mod` sind RAM-Register (durch `RvrtTms` gesichert). Die
   Write-on-Change-Politik (`dwell_s`/`min_change` je WriteOp) gegen die
   Herstellerangaben zur EEPROM-Schreibfestigkeit prüfen.

**Batterie-Marken einzeln freigeben:** Storage-Register/802-803-Details können je
Batterie-Marke abweichen. Jede Marke, mit der Fronius-Batteriesteuerung ausgeliefert
wird, durchläuft diese Liste separat - genau wie Deye pro Familie.

Nach bestandener Curtailment- **und** Storage-Freigabe: siehe „Freigabe" unten.

## Freigabe (Zertifizierung)

Erst wenn **alle sieben Punkte** für ein konkretes Modell/Firmware bestätigt sind:

- Die Register-Familie in die Zertifizierungs-Allowlist aufnehmen -
  `VP_CONTROL_CERTIFIED_FAMILIES` im Core (z. B. `sunspec,hybrid_3p` bzw.
  `sunspec,fronius_solar_api` für Fronius-Curtailment) und
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

## go-e Charger (Wallbox) — ZERTIFIZIERT in Software, nur kurze Geräte-Kontrolle

Anders als Deye/Fronius braucht die **go-e-Wallbox keine Prüfstand-Freigabe pro
Modell**: die **go-e HTTP-API v2** ist dokumentiert, versioniert und deterministisch
(github.com/goecharger/go-eCharger-API-v2). Es gibt **keine geratenen Firmware-Register**
— die Steuerschlüssel und ihre Enums sind veröffentlichte Fakten, und die komplette
Schreib-→Rücklese-Schleife ist in Software beweisbar (`goe/goe-control.js`
`goe-control.test.js` gegen einen In-Process-HTTP-Server; der Go-Zwilling
`edge-app/core/internal/goe` gegen einen `httptest`-Server). Ein falscher Strom lädt
das Auto nur etwas langsamer/schneller — **kein Batterie-Gesundheits-/Garantierisiko**
wie ein Deye-ToU- oder Fronius-Speicher-Schreibbefehl. Deshalb ist `goe_http_api`
**zertifiziert** (`CERTIFIED_CONTROL_FAMILIES` in `goe/goe-control.js` bzw.
`goe.PlanFor().Certified` im Core) und darf hinter dem Not-Aus `VP_CONTROL_ENABLED`
live schreiben.

Die Wallbox ist ein **Verbraucher (Consumer)-Entity**: der E2-Arbiter klammert den
gewünschten Ladesollwert über das Verbraucher-Band und der Consumer-Control-Loop
(`edge-app/core/internal/agent/consumer_control.go`) setzt ihn physisch (`frc`/`amp`)
und liest `/api/status` zurück. Steuerschlüssel (go-e-API v2 `apikeys-en.md`):
`frc` = forceState (Neutral=0, Off=1, On=2), `amp` = requestedCurrent (A).

**Kurze Geräte-Kontrolle (VERIFY-on-device, an der ersten echten Wallbox — kein voller
Prüfstand):** dieselbe Ehrlichkeit wie bei jedem Hersteller.
1. **Phasen/Spannung bestätigen.** Der kW→A-Umrechnung liegt `I = P/(Phasen·Spannung)`
   zugrunde (Default 3 Phasen @ 230 V). Prüfen, dass die Wallbox auf der erwarteten
   Phasenzahl lädt (`pnp`/`nrg`-Ströme) — die Phasenzahl ist Config
   (`driver.connection.phases`), **kein** Schreibbefehl (v2 hat keinen einfachen
   settbaren Phasen-Schalter-Schlüssel).
2. **`frc`/`amp`-Semantik bestätigen.** Ein Ladebefehl setzt `frc=On` + `amp` und die
   Rücklesung (`/api/status`) muss `frc`/`amp` echoen (all_match). Ein Nullsollwert →
   `frc=Off`; ein veralteter/fehlender Befehl → `frc=Neutral` (gibt die Kontrolle an die
   Wallbox-Logik zurück, nie ein hängender Zwangs-Strom).
3. **Not-Aus.** `VP_CONTROL_ENABLED=false` → **null HTTP** an die Wallbox (die zwei
   Live-Lesestandorte werden nie angefasst).

## Checkliste Kostal PLENTICORE (externe Batteriesteuerung, Tier 2)

Der PLENTICORE ist der **einfachste** Steuerfall der Flotte: ein offiziell
dokumentierter, vorzeichenbehafteter Watt-Sollwert plus ein **geräteeigener
Watchdog** — nichts ist geraten, alles ist zu VERIFIZIEREN. Analyse:
firstmate `data/vp-kostal-plenticore-s5/report.md`; Registerkarte + Lesepfad:
[`KOSTAL.md`](KOSTAL.md).

### Vorbereitung (mit VORLAUF — nicht am Prüfstandstag beginnen)

1. **Installateur-Zugang beschaffen:** Master Key steht auf dem Typenschild,
   der persönliche **Service-Code** wird bei Kostal beantragt. Ohne beides
   öffnet sich das Servicemenü nicht.
2. **Firmware aktualisieren** (Webserver). Das Referenzgerät kam mit UI
   01.23.07734; die aktuelle Protokoll-Doku (Rev. 2.9) gilt ab UI 01.30.12092.
   Stand notieren.
3. **Modbus aktivieren + Werte notieren:** Webserver → Modbus/TCP an, Port
   (Werk 1502), Unit-ID (Werk 71), **Byte-Reihenfolge** (Register 5, Werk
   Little/CDAB).
4. **Externe Batteriesteuerung einschalten:** Webserver → **Servicemenü →
   Batterieeinstellungen → Batteriesteuerung: „Extern über Protokoll Modbus
   (TCP)"** → Speichern. Der **Timeout** steht auf derselben Seite —
   auf **60 s** stellen (gemeinsamer Standard der Feld-Integrationen; unser
   Sollwert-Takt ~10 s hält ihn mühelos).
5. **Nur EIN Steuersystem:** kein zweites EMS/Portal darf die Batterie
   steuern, sonst kämpfen zwei Regler.
6. **Sensorposition des Energiezählers (KSEM) notieren** (1 = Hausverbrauch,
   2 = Netzanschlusspunkt) — bestimmt das Vorzeichen von Register 252.

### Messprogramm (halber Tag)

1. **Nur lesen.** Register 514 (SoC), 582 (Batterieleistung), 252 (Netz), 56
   (Status), 1076/1078 (BMS-Grenzen) gegen die Webserver-Anzeige prüfen.
   Vorzeichen kalibrieren: Laden ⇒ 582 negativ ⇒ VoltPilot `battery_power_kw`
   **positiv**; Einspeisung ⇒ 252 negativ (bei Sensorposition 2).
2. **Aktivierungs-Tor:** Register **1080 muss 2 melden** („extern via MODBUS").
   Meldet es 0/1, schreibt VoltPilot nichts und nennt den Hebel — das ist
   korrekt, dann fehlt Schritt 4 der Vorbereitung.
3. **First-Light** (`:8484` → Steuerung kalibrieren): ±0,5–1 kW in BEIDE
   Richtungen aus ruhiger Baseline. Urteil = Rücklesen von 1034 stimmt (der
   Wert ist float32-Watt) **und** 582 bewegt sich in Befehlsrichtung.
   Größenordnung prüfen: das Register IST Watt, ein ×1000-Fehler wäre sofort
   sichtbar.
4. **Watchdog messen (die T-Zahl).** Schreiben einstellen, Stoppuhr laufen
   lassen, bis 582 wieder dem internen Verhalten folgt. Erwartet: ≤ Timeout +
   wenige Sekunden. Ergebnis dokumentieren (und als
   `VP_OTA_NEUTRAL_VERIFIED=kostal_plenticore:<T>` eintragen, wenn autonome
   OTA auf dieser Box je aktiviert wird).
5. **Release-Probe.** Sollwert 0 ⇒ sofort neutral; danach Rückkehr zur
   internen Batteriesteuerung nach Ablauf des Timeouts. ⚠ Auf ÄLTEREN
   G1-Ständen ist diese Rückgabe laut Feldberichten gelegentlich unzuverlässig
   (Abhilfe: im Webserver kurz auf „interne Batteriesteuerung" umschalten oder
   Gerät neu starten) — hier ausdrücklich prüfen.
6. **SoC-Fenster.** Entladebefehl an der SoC-Untergrenze ⇒ `guards.Clamp`
   liefert 0 ⇒ Gerät verharrt; Ladebefehl an der Obergrenze analog. VoltPilot
   schreibt die Geräte-Register 1042/1044 NIE — die Klemme ist die Autorität.
7. **Netzladen.** Ladung über die PV-Produktion hinaus nur mit
   `netzladen_erlaubt` (EEG-Klemme); Gegenprobe über den Energiezähler
   „Total AC charge energy (grid to battery)" (Register 1054).
8. **24-h-Soak** (erst lesend, dann gesteuerte Zyklen), Rücklesungen ohne
   Abweichungen.

### Freigabe

Nach bestandenem Programm: Freigabe **pro Gerät** über die
First-Light-Karte (persistiert in `calibration-certified.json`). Die
flottenweite Aufnahme von `kostal_plenticore` in
`VP_CONTROL_CERTIFIED_FAMILIES` + `CERTIFIED_CONTROL_FAMILIES` erst, wenn die
Modellklasse belegt ist — bis dahin bleibt die Familie ABSICHTLICH draußen
(der Code shippt schreibfähig, aber stumm).

## Siehe auch

- [`goe/goe-control.js`](goe/goe-control.js) — der zertifizierte go-e-Steueradapter
  (Schreibplan + Rücklesen), Zwilling von `goe/goe-api.js` (Lesen); Go-Zwilling
  `edge-app/core/internal/goe`, gemeinsame Vektoren `goe/goe-control-vectors.json`.
- [`inverter-control-routing.js`](inverter-control-routing.js) - die getestete
  `controlRoute`-Abstraktion (Schreibplan + Rücklesen), Quelle der Wahrheit.
- [`deye/solarman-v5.js`](deye/solarman-v5.js) - die FC6/FC16-Schreibframes für Deye
  (Round-Trip-getestet).
- [`DEYE.md`](DEYE.md) → „Ausgeklammert: Hybrid-Batteriesteuerung" - die
  ha-solarman-basierten Steuerregister je Familie (Ausgangspunkt für Punkt 1).
- [`davidrapan/ha-solarman`](https://github.com/davidrapan/ha-solarman) (MIT) - Quelle der
  Adressen (`deye_p3.yaml` = `hybrid_3p`, `deye_hybrid.yaml` = `hybrid_1p`).
- Scout-Bericht `vp-inverter-control-arch/report.md` §6.3 - die ursprüngliche Liste.
