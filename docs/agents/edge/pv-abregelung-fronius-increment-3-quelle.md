# PV-Abregelung (Fronius Increment 3): Quellen-Schreibpfad, Freigabe JE EINHEIT, Wirkung > Register

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 43).


Die Fahrplan-Phase "Abregeln" wird auf **fronius_sunspec-ERZEUGER-QUELLEN**
physisch ausgefuehrt (Pilsting: zwei Fronius hinter EINER IP, Unit-IDs 1+2).
Operator-Doku: `nodered/FRONIUS.md` par.6b + `nodered/CONTROL-BENCH.md`
"Checkliste Fronius PV-Abregelung". Regeln, die halten muessen:

- **EIN Planungs-Truth: `nodered/sunspec/curtail.js`** (pure; model-discovery
  wird INJIZIERT wie bei sunspec-live) - Aufteilung der Anlagen-Begrenzung
  (proportional zur Nennleistung, Wasserfall, minus gemessenem
  unkontrollierbarem Anteil), Gates, Release, Override-Erkennung. Die
  Flow-Knoten "PV-Abregelung / Schreibplan"+Executor im QUELLEN-Tab betten es
  ein (flows-sync pinnt); der Go-Zwilling ist NUR der unitKey
  (`agent/curtail.go curtailUnitKey` == `curtail.js unitKey`, byte-identisch).
- **Der `curtail`-Block am edge/setpoint traegt den ROHEN Kill-Switch** -
  bewusst NICHT das Top-Level-`control_enabled` (das ist mit der Freigabe des
  PRIMAER-Wechselrichters verundet und darf nie ein anderes Geraet gaten).
  Dazu `pv_uncontrolled_kw` (Composite-PV minus Fronius-Quellen-PV) + je
  Quelle `certified`/`capacity_kwp`/`test`. Auch der Kalibrier-Override
  (calibration.go) publiziert den Block, damit ein Batterie-First-Light die
  Caps nicht kurz aufhebt.
- **Freigabe JE PHYSISCHER EINHEIT** (`ip:port#unit_id`,
  `data_dir/curtail-certified.json`, versioniert wie
  calibration-certified.json): Evidenz = Register-Readback bestaetigt UND
  gemessene Leistung auf die Begrenzung gefallen (internal/curtailcal;
  80-%-Test, min. 5 kW, TTL 120 s, 3 min Confirm-Grace, Abort invalidiert).
  Register allein reichen NIE - Modbus hat auf Fronius die NIEDRIGSTE
  Prioritaet (lokale Einstellung/Solar.web/Smart Meter uebersteuern still),
  deshalb prueft der Executor die WIRKUNG nach 90 s Settle und meldet
  "moeglicher Override" (:8484 + Heartbeat `curtailment`-Block).
- **Readbacks je Einheit reiten edge/control/readback mit `curtail:true`** -
  der Core routet sie in `Snapshot.CurtailUnits`, NIE in `Snapshot.Control`
  (das Primaer-Geraet). Der Heartbeat-`curtailment`-Block traegt die
  Faehigkeit (Einheiten/freigegeben/Kill-Switch aus dem KERN) + die
  Beobachtungen (aktiv/bestaetigt/Override) - so unterscheidet die Cloud
  "geplant und ausgefuehrt" von "geplant, Anlage kann es (noch) nicht".
  Die Cloud LIEST ihn seit PR 3 der Pilsting-Analyse (api-Listener
  `CurtailmentStatusListener` -> `device_curtailment_status` ->
  `GET /sites/{id}/curtailment-status`, Portal-Drei-Stufen-Wortlaut);
  Edge-seitig aendert das NICHTS - der Block ist unveraendert.
- **Socket-Disziplin im Quellen-Tab = die BEGRENZTE Schreib-Lease**
  (`nodered/sunspec/curtail-lease.js`, von Poll UND Executor eingebettet;
  Live-Vorfall Pilsting 2026-07-28: der unbegrenzte Vorgaenger - Anspruch auf
  JEDEM Takt auch fuers reine Beobachten, Walk-Retry ohne Backoff, kein
  Zyklus-Deadline, Poll wich bedingungslos aus - liess beide Quellen 15+ min
  verhungern, das seltene freie Fenster fiel immer an Quelle #1). Regeln, die
  halten muessen: der Executor beansprucht `curtail_want:<ip:port>` NUR wenn
  der Takt wirklich schreibt oder eine Discovery ansteht (reines Ruecklesen:
  kein Anspruch, weicht `src_reading:` aus, max. 1x/OBSERVE_MIN_MS je
  Gateway); die Lease wird zwischen Ops NEU gestempelt (Herzschlag) und in
  JEDEM Ausgang (finally) freigegeben; ein Gateway-Zyklus laeuft unter
  EXEC_DEADLINE_MS (Op-Timeouts aufs Restbudget gekappt); eine
  FEHLGESCHLAGENE Discovery wird `{failed:true, reason}` mit
  DISC_FAIL_BACKOFF_MS gecacht (Erfolg: 1 h). Der Poll weicht einer frischen
  Lease max. MAX_CLAIM_SKIPS Ticks je Quelle aus, ERZWINGT dann die Lesung
  (Warn "Telemetrie darf nicht verhungern"), verwirft eine Lease ohne
  Herzschlag nach CLAIM_TTL_MS laut (verwaister Executor) und ROTIERT den
  Zyklus-Start ueber die Quellen. Fehlgruende erreichen die Karte:
  `curtailcal.UnitView.last_error` traegt den letzten blocked-Readback-Grund
  (< 15 min, gesundes Readback loescht). `src_last:` (Messwert-Stash fuer
  Split + Wirkungs-Pruefung), One-Shot-Release (`curtail_was:`) und der
  native `WMaxLimPct_RvrtTms`-Totmann (60 s) sind unveraendert - aufhoeren
  zu schreiben IST der Failsafe. Beweise: `curtail-lease.e2e.test.js` (echte
  Node-Bodies gegen In-Process-Gateways incl. hang), `curtail-lease.test.js`,
  flows-sync-Pins. Test-Override `flow.curtail_deadline_ms` nur fuer Tests
  (sv5_acquire_ms-Praezedenz).
- `CERTIFIED_CONTROL_FAMILIES` bleibt unveraendert; Batterie-Steuerung, alle
  Deye-Pfade (`deyeRemoteControl` haelt `pvLimitSupported:false`) und
  guards.Clamp sind unberuehrt.

