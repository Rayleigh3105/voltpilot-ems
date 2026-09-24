# Wechselrichter-Automatik (Selbstregel-Modus): der Deckungs-Slot ohne 10-s-Sollwert

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 124).


Captain-Auftrag 26.08.2026 (Scout `data/vp-verbrauch-decken-selbstregel`): „wenn
der Fahrplan Verbrauch decken vorsieht, möchte ich, dass wir keinen Sollwert
vorgeben und den jede 10 Sekunden nachregeln … ich will, dass wir den jeweiligen
Wechselrichter in den Zustand bringen, wo er selbst regelt". **Alles ist ADDITIV:
eine Anlage, deren Layer 1 kein Prüfstand-Zertifikat trägt — also jede
ausgelieferte Anlage — verhält sich byte-identisch wie vorher**, und das ist als
Test festgenagelt.

- **KEIN neues Vertragsfeld** (Captain-Entscheid 1/7). Die Wolke markiert einen
  Slot längst als „Decken lohnt sich" (`cover_load_from_battery` /
  `unplanned_load_discharge`, `slot_trim.py`); WIE das ausgeführt wird — der
  10-s-Follower oder die Automatik des Geräts — war immer eine Entscheidung der
  EDGE. Der frozen `mqtt-schedule`-Vertrag ist unberührt, die Cloud und das
  Portal kennen das Wort `autonomous_discharge` seit PR #514 und brauchten
  KEINE Änderung. Seit K4a (24.09.2026) kennen sie auch `autonomous_charge`
  (Absicht E↑) und `autonomous_selfconsumption` (E/E~); die Box sendet sie erst
  mit K4b. Ein neues Wort braucht alle Listen zugleich:
  `ControlStatusListener.EXECUTION_MODES` (+ Ziel-Messung), das
  `executionMode`-Enum in `docs/contracts/openapi.yaml`, Portal `ExecutionMode`,
  `EXECUTION_MODE_LABEL`/`executionNote`, `fahrplanJetzt.resolveState` und
  `flowConflict.FOLLOWING_MODES`.
- **Die Arbeitsteilung steht in `docs/contracts/v2/plan-execution-ownership.md`**
  („Native self-regulation"): Wolke = der Preis, Layer 1 = die Register + das
  Zertifikat, Kern = die AUFSICHT und die Rücknahme, Rücklesen = der BELEG.
- **⚠ „Selbst regeln" heisst SOLLWERT weglassen, nicht AUFSICHT weglassen**
  (Captain-Entscheid 2): der Kern beobachtet weiter und nimmt die Batterie
  zurück — am Reserve-Boden, bei bedrohter Lastspitze, bei veralteter Messung
  oder Rückmeldung, am Slot-Ende, bei Not-Aus/Pause/Claim, und wenn das Gerät
  den Modus nicht bestätigt. Der SICHERE Zustand bleibt unverändert der
  guard-geklemmte Sollwert-Pfad (Entscheid 6).
- **Die Fähigkeit ist „Laden sperren + autonome Entladung"** (Entscheid 3), nicht
  volle Eigenverbrauchsregelung: die Aufnahme eines Tag-Überschusses bleibt
  grundsätzlich eine Wolken-Entscheidung (`charge_surplus_to_battery`). Die enge
  Ausnahme ist der lokale obere 5-%-PV-Puffer eines bereits von der Wolke als
  `cover_load_from_battery` markierten Eigenverbrauchs-Slots; siehe unten.
- **Deye ohne Fernsteuer-Firmware bleibt beim Follower** (Entscheid 4) — dort ist
  jeder Moduswechsel EEPROM mit ~20 s Latenz.
- **Generisch für JEDEN fähigen Wechselrichter** (Entscheid 8): Deye Remote,
  Fronius Model 124, KOSTAL PLENTICORE, KACO NH3 haben je ihren Primitive
  (`nativeSelfConsumption`). Sequenzen, Beleg-Register und die offenen
  Prüfstand-Punkte: `edge-app/nodered/UNPLANNED-LOAD-BENCH.md` + die vier
  Adapter-Docs.
- **⚠ SEIT DEM 26.08.2026 IST GENAU EIN GERÄT FREIGEGEBEN: der Deye-Pilot**
  (Captain-Entscheid „kein separater Prüfstand — der Pilot IST der Prüfstand").
  Der Katalog-Eintrag hängt an `deye` + der Katalog-Modell-Id
  `sun-30k-sg01hp3` + der vom GERÄT gesondeten PR-978-Registerlage — **nicht an
  der Familie, nicht an einem getippten Firmware-String**. Fronius, KOSTAL und
  KACO bleiben PLANNED-ONLY, jedes andere Deye-Modell und dieselbe Baureihe ohne
  Fernsteuer-Firmware bleiben beim 10-s-Follower, und der Deye-Interlock ist
  nicht gefallen, sondern per Eintrag gehoben (`interlockLifted` +
  `benchRecord`). **Auch mit Freigabe verweigert die Box zur Laufzeit**, wenn die
  eigene Zeitfenster-Konfiguration des Wechselrichters die Deckung nicht hergibt
  (`deyeNativePrecondition`; unbekannt = Verweigerung). Bindung, Belege und die
  Beobachtungs-Checkliste für den ersten Decken-Slot:
  `edge-app/nodered/UNPLANNED-LOAD-BENCH.md` „Pilot-Freigabe 2026-08-26".
- Edge-Details (die Beweis-Schleife, Rücknahme-vs-Verweigerung, die EEG-Regel,
  der Simulator-Katalog, der Not-Aus): `edge-app/CLAUDE.md`
  „Wechselrichter-Automatik".
- **Der Deye-AUSFÜHRUNGSPFAD steht seit dem 26.08.2026** (er war die offene
  zweite Hälfte der Freigabe): der Flow-Planknoten deckt jetzt ZWEI Tiers ab —
  `nativePlanGeneric` (modbus_tcp/SunSpec) und **`nativePlanDeye`** (die
  Fernsteuer-Registerlage), beide synchron gehaltene Kopien von
  `nativeSelfConsumption` und beide gegen das Modul gepinnt. HINEIN = **ein**
  Schreibvorgang `1100 <- 0`, danach nur noch Lesen; HINAUS = der unveränderte
  gewöhnliche Fernsteuer-Plan (`1101`, `1104`, `1105`, `1109`, `1100 <- 1`
  ZULETZT). **⚠ Die Vorbedingung braucht eine Lesung, die ein Plan-Knoten nicht
  machen kann:** der Executor liest die drei Register (`0x0092`/`0x00A6`/`0x00AC`)
  auf jedem native-Takt VOR jedem Schreibvorgang und legt sie je Logger flüchtig
  ab; nicht gelesen = nicht bekannt = Verweigerung mit deutschem Grund. Folge:
  der ERSTE Takt eines Decken-Slots verweigert ehrlich, der zweite schaltet um —
  weit innerhalb der Nachweisfrist des Kerns. **`mode: "native"` wird nur
  gemeldet, wenn `1100` wirklich 0 zurückliest**; nur ein belegter Takt liest
  zusätzlich den `gridChargeProof` (`native.grid_charge_blocked`, dreiwertig).
  Der Lese-Takt VOR der Übergabe meldet dieselbe Frage aus der
  Vorbedingungs-Lesung als `native_precondition.grid_charge_blocked` — damit die
  Absicht an EEG-Anlagen überhaupt stehen bleibt (K3, 24.09.2026; vorher nahm der
  Kern im ersten Takt zurück, die Automatik war an EEG-Anlagen tot).
  Details + die Beobachtungs-Checkliste: `edge-app/AGENTS.md` und
  `edge-app/nodered/UNPLANNED-LOAD-BENCH.md`.
- **Ops:** keine neue Pflicht-Variable, keine Migration, keine Cloud-Änderung.
  `VP_NATIVE_SELF_REGULATION_ENABLED` (Vorgabe AN, Opt-out) ist der Not-Aus je
  Box. Die Edge-Hälfte reist mit dem nächsten Edge-Release.

