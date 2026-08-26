# Bench gate: native self-regulation (charge block + autonomous discharge)

VoltPilot executes an economically authorized covering slot through the portable
10-second exact-setpoint `follow` / `idle_follow` path. The optional capability
`native_charge_block_discharge_auto` is a stronger claim: the SETPOINT ITSELF is
handed back to the inverter, charging is blocked, and the device is left free to
cover a newly appearing local load with its own loop. It is never inferred from a
product family or protocol.

Production's native capability catalog carries **exactly one entry** since
2026-08-26: the Deye pilot (see "Pilot-Freigabe" below). Every other manufacturer,
every other Deye model, and the same model on a firmware without the remote block
stay disabled - the existing Deye remote/ToU write path is not by itself evidence
that a firmware can hold charge off while autonomous discharge, reserve
enforcement, export prevention and the watchdog all remain correct.

## What an entry releases, and what it does NOT

An entry names an exact manufacturer, model, firmware and register-map tuple. It
ATTESTS the bytes the shipped adapter plans - it does not define them: the
sequence lives in `inverter-control-routing.js` `nativeSelfConsumption`, and
`certificateMatchesPlan` refuses when the two have drifted apart. Two sources for
one truth would otherwise let a firmware-specific result bless a sequence nobody
measured.

It releases NOTHING about supervision: the core keeps taking the battery back at
the reserve floor, on a threatened billing peak, on a lost measurement or
readback, at the end of the slot, on plant rest and when the mode is not
confirmed (`guards/nativemode.go`).

## Criteria

An entry may be added only after a no-grid-export bench run records all of the
following:

1. charge-block and safe-default release write bytes plus independent readback
   bytes for both transitions, including reboot;
2. spontaneous-load response within 2 seconds and removal within 2 seconds;
3. no added battery export above 0.2 kW across PV/load crossover;
4. stop at `max(technical floor, backup reserve, peak reserve)` and rated power;
5. stale/unknown SOC, load or PV, E-stop, missing First-Light grant, rejected or
   lost readback, watchdog expiry and communication loss all produce zero native
   writes and return to the safe configured default;
6. deliberate charge and sale slots are never reinterpreted;
7. the readback watchdog is independently observed for at least 100 cycles;
8. **THE TRANSITION IS PROVEN IN BOTH DIRECTIONS, AND MEASURED.** Record, with
   timestamps: the write bytes of the hand-over, the FIRST readback that shows
   the device's own state register in the native value, and the LATENCY between
   them; then the same for the return (the ordinary setpoint plan) - the write,
   the first readback confirming the commanded value, and the latency. Criterion
   2 measures the device's regulation; this one measures how long VoltPilot needs
   to TAKE THE BATTERY BACK, which is what the supervision's floor margin
   (`guards.NativeFloorMarginPct`) is sized against. Nothing here is measured on
   any device yet.
9. **THE STATE REGISTER REALLY DISTINGUISHES THE TWO MODES.** Read the proof
   register in BOTH states and show it differs. Where it does not - KOSTAL is the
   known case, where register 1080 reads 2 whether the external setpoint is
   active or expired - the proof is BEHAVIOURAL and must be recorded as such:
   observe the battery power (582) follow the house with no write from us, for at
   least 5 minutes across a load change. A family whose mode cannot be
   distinguished at all must not be entered.
10. **ON AN EEG PLANT: the grid-charge ban is readable.** With the device in its
    native mode, read the charging-source register the adapter names
    (`gridChargeProof`) and show it says "not from grid". A family with no such
    register is refused on EEG sites by construction - do not enter one and hope.

## Per-adapter: sequence in, sequence out, proof register

All of them are PLANNED-ONLY except the released Deye pilot row; the tables are
the artefact a session verifies.

| Adapter | Into native | Back out | Proof register | Watchdog |
|---|---|---|---|---|
| **Deye remote** (`solarman_v5`, PR-978 layout) - **RELEASED for `sun-30k-sg01hp3`** | `1100 <- 0` (disable remote mode; the inverter then runs its own Work-Mode/ToU configuration) | the ordinary remote write plan (`1101` watchdog, `1104`, `1105`, `1109`, `1100 <- 1` LAST) | `1100 == 0`; `1121` is an OBSERVATION only. EEG: Program-1 charging enum `progChargeBase + 0 == 0` (Disabled) | the device's own (1101). Not writing IS the failsafe |
| **Deye ToU** (no remote firmware) | **not supported, deliberately** | - | - | - |
| **Fronius GEN24** (SunSpec Model 124) | `planStorage(0)`: rates 0, `StorCtl_Mod <- 0` LAST = "release control -> the inverter self-consumes" | `planStorage(kw)` | `StorCtl_Mod == 0` at the DISCOVERED address. EEG: `ChaGriSet == PV` | `InOutWRte_RvrtTms` is written, but its behaviour on 124 is UNDOCUMENTED - bench point |
| **KOSTAL PLENTICORE** | **nothing at all** - stopping the writes IS the hand-over (webserver timeout, 30-60 s) | resume writing `1034` | none distinguishes the modes: `1080` reads 2 in both. BEHAVIOURAL only (582 follows the house). No EEG proof -> refused on EEG sites | the device's own (webserver timeout) |
| **KACO NH3** (AISWEI) | `41104 <- 2` (Eigenverbrauch) | `41104 <- 4` + flag + power + SoC bounds | `41104 == 2`. No charging-source register -> refused on EEG sites | **none documented** - the failsafe is ours, and the native write IS it |
| **generic SunSpec / simulator** | `41 <- 0` (clear EMS control), `40 <- 0` | `40 <- kw`, `41 <- 1` | `41 == 0`, `40 == 0`. No EEG proof -> refused on EEG sites | none (simulator) |

The slot's PV feed-in cap (`42` / `pv_limit_kw`) is NOT part of the hand-over on
any adapter: the mode concerns the battery, and freezing a curtailment would let
it outlive its slot. Where the tier carries one it rides along as an ordinary
write, gated by the ordinary control gate.

`unplanned-load-native.js` is a pure activate/release write-plan and readback
planner plus the release point. Its tests pin the released pilot entry, a
fictional certificate and the SIMULATOR-ONLY entry (which names a piece of
software, not a device), and assert that every OTHER Deye - a different model, or
this model on a firmware without the PR-978 remote block - still yields no native
writes. **No test or documentation procedure in this repository writes to a live
device.**

---

## Pilot-Freigabe 2026-08-26: was am Piloten zu beobachten ist

Captain-Entscheid: **kein separater Prüfstand - der Deye-Pilot IST der
Prüfstand.** Der Katalog-Eintrag ist deshalb freigegeben, aber so eng gebunden,
wie die Erkennung es zulässt, und die scharfe Aufsicht aus
`core/internal/guards/nativemode.go` ist die Absicherung.

### Woran die Freigabe hängt

| | |
|---|---|
| **Marke** | `deye` |
| **Modell** | `sun-30k-sg01hp3` - die KATALOG-MODELL-ID, die der Kern auf `edge/inverter/config` veröffentlicht (`inverter.go deyeModels()`, Beschriftung „SUN-30K-SG01HP3-EU", Familie `hybrid_3p`, 30 kW). **Nicht die Familie**: jede andere SG01HP3/SG04LP3-Grösse bleibt bei der Nachführung. |
| **Firmware** | die vom GERÄT gesondete PR-978-Registerlage (`classifyDeyeCapability` -> `layout: 'pr978'`), nicht ein getippter String. Ein Firmware-Update, das den Block 1100-1121 entfernt, beendet die Freigabe von selbst. |
| **Beleg** | die Live-Sonde des Geräts vom 2026-07-27 (Logger `192.168.254.210:8899`, Seriennummer 1127365518, Slave 1): FC03 über `0x044C..0x0461` antwortete `1100=0x0000`, `1101=0xFFFF`, `1104=0x0000`, `1105=0x0002`, `1121=0x0000` - die PR-978-Lage, Sollwert also bei 1109. Dasselbe Gerät fährt den Fahrplan heute per First-Light auf dem Remote-Pfad, `1100` ist also ein Register, das VoltPilot auf genau diesem Wechselrichter ohnehin jeden Takt schreibt. |

### Was trotz Freigabe zur Laufzeit VERWEIGERT

Die Freigabe sagt „dieses Modell+diese Firmware kann es". Sie sagt nichts
darüber, wie DIESE Anlage konfiguriert ist - und auf einem Deye entscheidet
genau das, ob „aufhören zu schreiben" überhaupt eine Deckung ergibt.
`deyeNativePrecondition` liest deshalb vor der Übergabe die eigene
Zeitfenster-Konfiguration des Geräts und verweigert mit deutschem Grund, wenn:

- das **Zeitfenster-Programm (Time of Use) nicht aktiv** ist (Bit 0 von
  `0x0092`). Deye-Handbuch (SUN-29.9…50K-SG01HP3-EU-BM3/BM4, 2025-08-19):
  *„When … 'Time Of Use' is not enabled, the inverter can charge normally, but
  only discharge to provide the inverter's self-consumption power, without
  discharging to power the loads."* Ohne ToU deckt der Wechselrichter das Haus
  also gar nicht - und die Aufsicht könnte es nicht bemerken, weil der Modus
  selbst korrekt gemeldet würde.
- das **Ziel-Ladeniveau des Programms über der Reserve-Untergrenze** der Anlage
  liegt (`0x00A6` gegen `effective_floor_soc_pct`): der Wechselrichter beendet
  die Deckung dann früher, als die Aufsicht erwartet.
- auf einer **EEG-Anlage** die Program-1-Charging-Enum (`0x00AC`) nicht schon
  VOR der Übergabe `Disabled` liest.
- eine dieser Angaben **unbekannt** ist - lieber verweigern als blind
  umschalten.

Unverändert gelten die Bedingungen aus PR #527: Umschalten nur mit
Rücklese-Beleg (`1100 == 0`), EEG-Netzladesperre muss vom Gerät belegt sein,
und die Rücknahme bei Reserve-Boden + 3 %, bedrohter Lastspitze, veralteten
Messwerten, verlorenem Rücklesen, fremdem Halter oder fehlender Bestätigung.
Der sichere Zustand bleibt der guard-geklemmte Sollwert-Pfad.

### ⚠ Was VOR der ersten Beobachtung noch fehlt

Der Katalog-Eintrag ist die FREIGABE; er ist noch nicht der Ausführungspfad.
Der Flow-Planknoten (`build-flows.js nativePlanGeneric`) deckt bis heute nur
den generischen `modbus_tcp`-Tier ab und gibt für `solarman_v5` `null` zurück,
und der Deye-Executor liest `gridChargeProof` nicht zurück. Solange das so ist,
fällt der Pilot in einem Decken-Slot weiterhin auf die 10-Sekunden-Nachführung
und der Kern zieht seine Absicht nach der Nachweisfrist zurück
(`nachweis_fehlt`). Die zwei fehlenden Stücke:

1. der Plan-Knoten muss den Deye-Tier über `nativeSelfConsumption` planen
   (inkl. der `preconditions`-Lesungen vor der Übergabe), und
2. der Deye-Executor muss bei `mode === 'native'` den `gridChargeProof` lesen
   und als `native.grid_charge_blocked` mitveröffentlichen - genau das, was der
   generische Executor heute schon tut.

### Checkliste für den ersten Decken-Slot am Piloten

Zu prüfen, sobald ein Slot mit `cover_load_from_battery` bzw.
`unplanned_load_discharge` läuft (der Fahrplan zeigt „Verbrauch decken"):

1. **Portal** – die Ausführung liest **„Wechselrichter-Automatik"**, nicht
   „10-Sekunden-Nachführung" und nicht „Sicherung".
2. **Herzschlag** – `control.execution.mode == "autonomous_discharge"`
   (`GET /api/v1/sites/{id}/control-status`). Nur ein BESTÄTIGTER Modus wird so
   gemeldet; „gewollt" steht nie da.
3. **Keine Sollwert-Schreibvorgänge im Slot** – `docker compose logs nodered`
   zeigt nach dem EINEN Umschalt-Schreibvorgang (`1100 <- 0`) nur noch
   Rücklesungen; die Karte auf `:8484` steht auf
   „Wechselrichter-Automatik (hält)".
4. **`:8484` Betrieb** – `1100` liest `0`, `1121` wird als Beobachtung
   angezeigt, und der Ladestand fällt sichtbar, während der Netzbezug um 0
   pendelt (der Wechselrichter regelt schneller als unsere 10 s).
5. **Lastantwort** – ein Lastsprung im Haus (Wasserkocher, Wallbox) wird in
   **unter 2 Sekunden** aus der Batterie beantwortet, ohne dass VoltPilot
   schreibt. Das ist der eigentliche Gewinn und der Punkt, an dem sich die
   Kriterien 2/8 der Liste oben am lebenden Objekt belegen lassen.
6. **Rücknahme-Gründe** – am Slot-Ende, am Reserve-Boden und bei einem
   Messwert-Aussetzer erscheint der jeweilige deutsche Grund
   (`guards.NativeReasonText`) im Portal bzw. auf `:8484` – **jede** Rücknahme
   nennt sich, keine ist stumm.
7. **Kein Export** – über den ganzen Slot bleibt die zusätzliche
   Batterie-Einspeisung unter 0,2 kW (Kriterium 3).
8. **Nach dem Slot** – der Fahrplan schreibt wieder Sollwerte (`1100 == 1`,
   `1109` folgt dem Plan), und der Übergang war ein einziger Schreibvorgang in
   jede Richtung. Latenz beider Übergänge notieren – das ist Kriterium 8, und
   danach ist `guards.NativeFloorMarginPct` (3 %) bemessen.

Was dabei NICHT beobachtbar ist und deshalb offen bleibt: der Reboot-Fall
(Kriterium 1) und die 100 Watchdog-Zyklen (Kriterium 7) – beides braucht einen
gezielten Eingriff, keinen normalen Betriebstag.
