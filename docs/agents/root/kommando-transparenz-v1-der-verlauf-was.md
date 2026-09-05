# Kommando-Transparenz V1 „Der Verlauf": was VoltPilot an ein Gerät schickt, ist kundensichtbar

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 102).


Konzept `data/vp-kommando-transparenz-k3` (Captain-Entscheide F1–F5 vom 17.08.2026). Der Anlass ist
belegt: ein Kunde fragte „drosselt IHR meine Anlage?" — und die belastbare Antwort war NUR über den
Wartungstunnel und rohes Register-Lesen zu gewinnen, zwei Untersuchungsrunden lang. **V1 ist rein
cloud-seitig, NULL Edge-Änderung:** die Kette Executor → Snapshot → Herzschlag existiert seit dem
Bau, es fehlte ausschliesslich der SPEICHER — exakt der `rule_event`-Befund eine Stufe höher,
weshalb diese Stufe dessen Muster wörtlich übernimmt.

- **⚠ WARUM PERIODEN UND NICHT EIN EREIGNIS-LOG (gerechnet, nicht geschätzt):** der Deye-Fernsteuerpfad
  re-assertiert im 10-s-Takt = **~26.500 Schreibbefehle + ~52.000 Rücklese-Register pro Tag und
  Gerät** (≈ 2,35 Mio Zeilen/Monat). Darin wäre die EINE interessante Zeile („Register hielt,
  Leistung folgte nicht") unauffindbar. Gespeichert werden deshalb **HALTEPERIODEN + Punkt-Ereignisse**
  (~130 Zeilen/Tag/Gerät), und die Fläche SAGT die Verdichtung, statt sie zu verstecken.
- **`device_command_log` + `device_command_recording`** (Migration `V20260824000000`): eine Zeile ist
  eine Periode ODER ein Punkt-Ereignis. Mandantengebunden mit RLS + FORCE wie `rule_event` — das
  sind KUNDENDATEN, ausdrücklich NICHT global wie `rollout_event`, und deshalb wohnt die Leseroute
  unter `/sites/**`. ⚠ Das `BIGSERIAL` braucht sein eigenes `GRANT USAGE ON SEQUENCE` (die
  dokumentierte `rollout_event`-Falle). Aufbewahrung **90 Tage** (F3), opportunistisch im Schreibpfad
  (höchstens stündlich je api-Instanz, gedeckelte DELETE) — kein neuer `@Scheduled`-Job.
- **Die Regeln sind rein: `command/CommandLog`** (Docker-frei, jede zeitabhängige Funktion nimmt ihr
  `now` — das `Tagesprotokoll`/`RuleEvents`-Muster). Fünf Ehrlichkeitsregeln tragen sie:
  **die ERSTE Beobachtung eröffnet eine Periode, meldet aber keinen Übergang** (es gibt kein Vorher);
  **Schweigen ist eine Lücke** — nach `GAP_AFTER` (5 min) wird an der letzten belegten Stelle
  geschlossen und die Stille als eigenes Ereignis festgehalten, nie bis „jetzt" behauptet;
  **über eine Lücke hinweg wird KEIN Wechsel behauptet** (der Zeitpunkt wäre erfunden);
  **⚠ der NACHGEFÜHRTE Wert ist bewusst KEIN Schlüssel-Mitglied** — er folgt sekündlich dem
  gemessenen Haus, im Schlüssel zerfiele jede Viertelstunde in Dutzende Perioden (das Roh-Log durch
  die Hintertür), er reist als erster/letzter/min/max im Aggregat; und **nur gemeldete Wörter**.
- **⚠ `keine_antwort` ist NIE `abweichend`** (die PR-280-Lehre, hier bis in die DB): Schweigen ist
  eine Lücke, kein bewiesener Defekt. V1 kann die beiden aus dem 15-s-Herzschlag **nicht trennen**
  und schreibt `keine_antwort`/`prueft` deshalb GAR NICHT — sie stehen im Vokabular für den
  Präzisions-Uplink. `batteryVerdict` liest die Edge-Semantik: die Box NENNT die abweichenden
  Register erst, wenn die Abweichung ENTPRELLT ist, eine nicht-leere Rollen-Liste ist also der
  Beleg für `abweichend`; ohne sie bleibt es beim ehrlichen `unbestaetigt`.
- **⚠ Die vier `cycles*` sind in V1 IMMER NULL, und das ist die Ehrlichkeit:** aus 15-Sekunden-
  Momentaufnahmen lässt sich die Zahl der 10-Sekunden-Schreibvorgänge nicht ableiten. Die Fläche sagt
  „— (zählen wir noch nicht mit)", sie erfindet nie eine Zahl.
- **`CommandLogWriter` reitet auf den DREI bestehenden Zuhörern** (control/curtailment/consumers),
  telemetrie-getrieben, **nie werfend**, kein `@Scheduled`, **kein neues Flag** (die dokumentierte
  OTA-Listener-Falle wird so vermieden). Drei Ströme: `batterie` (der Wechselrichter-Sollwert),
  `abregelung` (die Einspeise-Begrenzung) und `verbraucher` — Letzterer trägt **NUR die
  Bestätigungs-Dimension**, weil Start/Stopp schon im `rule_event`-Protokoll stehen und dieselbe
  Sache zweimal zu speichern zwei Wahrheiten über ein Ereignis erzeugte. `possible_conflict` reist
  ausschliesslich über die schmale `ControlFacts` durch (die Momentaufnahme speichert es nicht, und
  der Verlauf soll dafür keine Spalte in einer fremden Tabelle erzwingen).
- **Leseroute `GET /api/v1/sites/{siteId}/command-history?entity=&range=day|week&at=`**
  (`SiteCommandHistoryController`, RLS-gefenced wie jede `/sites/**`-Route, fremde Anlage 404,
  Admins über den `X-Tenant-Id`-Umschalter; in `openapi.yaml`, tag `commands`). Sie ist **READ-ONLY,
  und das ist eine Konstruktions-Aussage** — Wünsche → Arbitrierung → Schutzgrenzen → Executor
  bleiben unangetastet, es entsteht kein Schreibpfad. Der Live-Zustand reist über die BESTEHENDEN
  `ControlStatusDto`/`CurtailmentStatusDto` mit, damit Cockpit und Befehle-Seite über dieselbe
  Sekunde nie Verschiedenes behaupten können. Mit `entity` kommen IHRE Zeilen PLUS die
  gerätebezogenen (`entity_id IS NULL`) — die betreffen den Schreibweg, über den sie gesteuert wird.
  Nur Tag und Woche: ein Monat wäre ein Fenster, das der Deckel ohnehin kappt.
- **⚠ EIN LAUF WIRD MIKROSEKUNDEN NACH SEINER EIGENEN SLOTGRENZE GESTEMPELT — der Ex-ante-Filter
  trägt deshalb EINE SEKUNDE Toleranz** (Herzogau 29.08.2026, `ScheduleRepository.RUN_STAMP_TOLERANCE`).
  Der Optimierer wird AUF der Viertelstundengrenze ausgelöst und stempelt `generated_at`, wenn er
  losläuft — der 10:00-Lauf trug `08:00:00.000867Z` gegen einen ersten Slot von `08:00:00Z`. Das
  strikte `generated_at <= time` schloss damit JEDEN Lauf aus SEINEM EIGENEN ersten Slot aus, und der
  Tages-Film zeigte für den LAUFENDEN Slot immer den VORIGEN Lauf: „JETZT · Sonne speichern · läuft"
  stand über einem Slot, der als ENTLADUNG befohlen war. **Das traf jeden Slot jeder Anlage** und
  fiel nur auf, weil an diesem Tag zwei aufeinanderfolgende Läufe maximal auseinanderlagen. Die
  Toleranz muss ENG bleiben: eine Sekunde liegt zwei Größenordnungen unter dem 15-Minuten-Takt, ein
  Re-Plan MITTEN im Slot verliert ihn also weiterhin — genau die Ex-ante-Eigenschaft, für die es
  diese Lesart gibt. Beweis: `PortalApiTest.scheduleDayModeGivesARunItsOwnSlotDespiteTheMicrosecondItIsStampedLate`
  (beide Hälften zusammen). **Der Zwilling in `EarningsRepository` ist NICHT betroffen** — dort steht
  rechts ein gebundener Anker-Zeitpunkt, keine Slotgrenze, an der ein Lauf gestempelt wird.
- **⚠ DIE FENSTER-KONVENTION: eine Zeile gehört zum Tag ihres STARTS** (`CommandLog.carryInAfter`,
  Captain-Meldung 19.08.2026). Der „Heute"-Tab begann um 17:26 mit dem Slot „23:45-00:00" — der
  letzten Viertelstunde des VORTAGS. Sie geriet auf ZWEI Wegen hinein, und beide sind mit derselben
  Regel erschlagen: die Abfrage nahm eine Periode, die GENAU auf `from` endete (halb-offenes Fenster
  falsch abgebildet, `ended_at >= from` statt `>`), und sie nahm die reale Überlappung von Sekunden,
  mit der JEDE Mitternachts-Periode in den Folgetag ragt (der Optimierer wechselt den Plan-Sollwert
  um 00:00, geschlossen wird die Periode erst vom NÄCHSTEN Herzschlag). Das Prädikat hat deshalb
  DREI Zweige: `started_at >= from` (im Fenster begonnen — gehört immer dazu, auch nach vier
  Sekunden), `ended_at IS NULL` (läuft noch, beschreibt die Gegenwart) oder
  `ended_at > from + ACCURACY_SECONDS`. **Der Abstand ist GENAU die Herzschlag-Auflösung** (15 s — die Zahl, die die
  Fläche dem Kunden ohnehin nennt): eine Periode, deren ganze Anwesenheit im Tag kürzer ist als ein
  Herzschlag, ist nach dem eigenen Massstab dieses Features keine Aussage über diesen Tag; eine, die
  von 22:00 bis 06:00 durchläuft, sehr wohl — sie zu streichen risse ein unerklärtes Loch in den
  Film, und ein Tag ohne einen einzigen Wechsel behauptete „es wurde nichts geschickt". Verloren ist
  nichts: der Grenz-Slot steht im Fenster des Vortags. **Der Tages-Deckel zählte seit jeher nach
  `started_at` (`countSince`) — genau diese Asymmetrie zur Leseroute war der Fehler.**
- **⚠ Eine 2-Stunden-Verschiebung an der Ingest-Naht wurde GEPRÜFT und ausgeschlossen** (dieselbe
  Meldung, zweite Vermutung): die Spalten sind `TIMESTAMPTZ`, der Edge stempelt RFC-3339 mit Zone,
  `Instant.parse` nimmt beide Formen, JDBC und Jackson reisen zonenrein. Gepinnt von
  `derZeitstempelReistUnverschobenDurchIngestSpeicherUndAntwort` (ein Herzschlag mit `+02:00` kommt
  als derselbe UTC-Zeitpunkt zurück) — wer das Symptom erneut untersucht, misst hier nicht noch mal.
- **`writes: false` ist die F4-Antwort** („VoltPilot sendet an dieses Gerät keine Befehle — es wird
  nur gelesen"): abgeleitet aus dem `control`-Flag ODER einer nicht-leeren `actuate`-Fähigkeit; ohne
  beides ist die Komponente nur-lesend, und genau das darf die Seite dann sagen. Der SATZ wohnt im
  Portal (`src/befehle.ts`), hier steht die Tatsache.
- **⚠ Für Tests, die eine Periode über MITTERNACHT (oder über irgendeine Grenze) tragen sollen: die
  Herzschläge müssen enger liegen als `GAP_AFTER` (5 min).** Ein Sprung von 23:45 direkt auf 00:00
  ist eine LÜCKE — die Periode wird dann an ihrem letzten belegten Zeitpunkt (23:45) geschlossen und
  überquert Mitternacht NIE; ein Grenzfall-Test wäre damit aus dem falschen Grund grün (beim Bau von
  `derMitternachtsGrenzSlotGehoertZumVortagUndNichtInDenHeuteTab` genau so passiert). Der Test hält
  seither vier Herzschläge im 4-Minuten-Takt und prüft ZUERST, dass der Slot wirklich über
  Mitternacht ragt.
- **⚠ Für Tests:** die Zeit kommt aus dem HERZSCHLAG (`control.checked_at` bzw. `ts`), eine Lücke
  lässt sich also ohne eine Sekunde Wartezeit nachstellen — aber die Leseroute klemmt ihr Fenster auf
  JETZT, ein Herzschlag mit einem Zeitstempel in der Zukunft ist damit unsichtbar (in der Nacht
  gemessen: „heute 10:00 UTC" liegt um 00:37 Berliner Zeit noch in der Zukunft). Und das Abräumen
  der Tabelle im Test braucht einen **Mandanten-Kontext** — ohne `app.tenant_id` ist RLS
  default-deny und das DELETE ein STILLES No-op.
- **Beweise:** `CommandLogTest` (18, rein) · `CommandHistoryApiTest` (7, echte DB + Keycloak: die
  Reise Perioden/Wechsel/Fehlschlag/Lücke/Not-Aus, die Abregelung als eigener Strom mit
  dreiwertigem Urteil, der Verbraucher-Ersatz, der Mandanten-Zaun und „ein alter Herzschlag schreibt
  nichts") · Portal `befehle.test.ts` (26) + `BefehleSection.test.tsx` (6). Portal-Seite in
  `frontend/portal/AGENTS.md`.
- **NICHT in V1** (die Stufen 2/3 des Konzepts): der Präzisions-Uplink vom Gerät (`internal/cmdlog`,
  Herzschlag-Block `command_log`, Zyklen-Zähler + Register-Detail, `source='geraet'`) und das
  24-h-Roh-Protokoll auf Abruf. Beide sind additiv und verfeinern diese Tabelle, ohne sie umzubauen.

- **Safety invariants (report §6.1, all enforced):** guards stay authoritative upstream (the adapter never widens the clamped kW); kill-switch off by default; per-model certified allowlist (uncertified → read-only, UI "noch nicht freigegeben"); fail-safe neutral on stale/loss; EEG grid-charge default off. **Never ship a guessed register address as certified** - the Deye ToU addresses are `bench_pending` and produce no live write.
- **Fronius SunSpec curtailment (Increment 1, `vp-fronius-control-curtail`, UNCERTIFIED/planned-only).** Fronius control uses standards-based **SunSpec Modbus** (design report `data/vp-fronius-control-scout-c4`; NOT the Solar-API read path, NOT the rejected evcc `config/timeofuse` HTTP hack). NEW capability: a **real SunSpec model-discovery walker** [`edge-app/nodered/sunspec/model-discovery.js`](edge-app/nodered/sunspec/model-discovery.js) - walks the dynamic model linked list from the SID base (40001/"SunS"), locates Common(1)/Nameplate(120)/**Immediate Controls(123)**/Storage(124), handles int+SF (101/102/103) AND float (111/112/113); **addresses are DISCOVERED LIVE, never hard-coded** (field offsets within a model are the fixed SunSpec definition; the model BASE is discovered), pure/offline-tested (`model-discovery.test.js`). This replaces the sim-only 9-register `sunspec` PROFILE in `modbus-tcp.js` (that is NOT real SunSpec). `planCurtailment` maps `pv_limit_kw` → Model 123 `WMaxLimPct` (kW → % of discovered nameplate `WRtg`) + `WMaxLim_Ena` + `WMaxLimPct_RvrtTms` (the vendor dead-man's-switch), value+revert-timer written BEFORE the enable, uncurtailed slot DISABLES the limit; idle-safe (no writes, no fabricated address) if the SID/Model 123 is missing. Wired into `inverter-control-routing.js` `froniusControl` as adapter **`fronius_sunspec`** (≠ `modbus_tcp`, so the flow write/readback executor no-ops on it, like Deye's `solarman_v5`): Fronius is DELIBERATELY absent from `CERTIFIED_CONTROL_FAMILIES`/`VP_CONTROL_CERTIFIED_FAMILIES`, so `writes:[]`/`readbacks:[]` always, the intended plan is `planned`/`bench_pending` only (needs `opts.sunspec` discovery, absent in-flow this increment → empty planned). Control endpoint is the separate Modbus surface (`connection.control_port` default 502, `control_unit_id` default 1; same ip as the port-80 read). Signs/scaling VERIFY-on-device. Going live needs a real-hardware bench pass (FRONIUS.md §6 + CONTROL-BENCH.md Fronius). **⚠ Since 2026-08-09 the limit is written as ONE FC16 transaction over the contiguous span `WMaxLimPct .. WMaxLim_Ena`, not as separate FC6 writes** - the Pilsting Datamanager STORED a single-register write (the readback confirmed it for 120 s) without ever ADOPTING it, and the revert timer never arrived at all. Fronius documents these five registers as one 0x10 command and Victron's production limiter writes exactly that block; the per-connection flip-back is `curtail_write_fc` (absent = FC16), the twin of Deye's `control_write_fc`. Full account: `edge-app/AGENTS.md` "Die PV-Abregelung wird als EIN FC16-Block geschrieben" + FRONIUS.md §6e.
- **Fronius SunSpec battery charge/discharge (Increment 2, `vp-fronius-control-battery`, UNCERTIFIED/planned-only).** Extends the SAME discovery walker + `froniusControl` (report §1.3/§3.2/§3.4) with **Model 124 (Storage)**: `planStorage` (in `model-discovery.js`) maps `battery_setpoint_kw` (+charge/−discharge) → `InWRte`/`OutWRte` as **% of the discovered `WChaMax`** (nameplate max charge rate, read live w/ `WChaMax_SF`; the `InOutWRte_SF`-scaled register value), picking the direction register + the `StorCtl_Mod` bit (bit0 charge / bit1 discharge; **0 = release/self-consumption** for an idle 0-kW setpoint — no Deye-style target-SoC hack, the rate registers carry direction directly), plus `MinRsvPct` from `soc_min` (reserve floor), the EEG-gated `ChaGriSet` grid-charge gate (`GRID` only when `grid_charge_allowed` AND charging, else `PV`/off — default off, from `site.netzladen_erlaubt`), and the native `InOutWRte_RvrtTms` dead-man's-switch. Ordering is safety-load-bearing: rates + reserve + grid-gate + revert-timer written BEFORE the `StorCtl_Mod` enable bits (armed LAST). `froniusControl` merges curtailment (Inc 1) + storage `planned` lists; `invert_control_sign` flips direction (config, never code). **Higher risk** — a wrong sign/scale can affect a real battery's health/warranty — so like Inc 1 Fronius stays ABSENT from `CERTIFIED_CONTROL_FAMILIES`/`VP_CONTROL_CERTIFIED_FAMILIES`: `writes:[]`/`readbacks:[]` ALWAYS, storage plan is `planned`/`bench_pending` only (needs `opts.sunspec` discovery; absent in-flow → empty planned, so `flows.json`/`flows-sync.test.js` stay green — the flow does no in-flow discovery). Idle-safe if Model 124 is absent (batteryless inverter → curtailment-only) or WChaMax unknown. Battery control is **per-battery-brand** bench_pending (BYD/LG/Fronius) like Deye. No Go/core change (the core already publishes `battery_setpoint_kw`/`soc_min`/`grid_charge_allowed`/`control_enabled` on `edge/setpoint`; the flow executor no-ops on `fronius_sunspec`). Going live needs a real-hardware bench pass per brand (CONTROL-BENCH.md → Fronius Storage checklist, FRONIUS.md §6). Model 802/803 battery-bank detail = calibration cross-check only, not written.

