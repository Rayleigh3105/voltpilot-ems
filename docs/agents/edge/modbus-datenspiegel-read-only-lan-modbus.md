# Modbus-Datenspiegel: read-only LAN Modbus slave, NEVER a socket consumer

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 41).


`core/internal/mirror` + `agent/mirror.go` serve every register on the LAN
(container 1502, host `${VP_MIRROR_PORT:-502}`; unit = `mb_slave_id` -> native
Deye pass-through, unit 100 -> the frozen VoltPilot map v1) - full operator
doc + register tables in `edge-app/MODBUS-SPIEGEL.md`, Loxone sensor list in
`docs/loxone-voltpilot-map.md`. Rules that must hold when touching it:

- **THE invariant: a consumer request never causes I/O.** Answers come only
  from caches fed over the local bus (retained `edge/registers/raw` from the
  Deye poll, the gated composite at `onLocalTelemetry`, control readbacks for
  the 1100-1121 window). Consumer demand may only steer what OUR poll fetches:
  the learned want set rides retained `edge/registers/want`, and the router
  merges AT MOST ONE learned block (<= 64 regs, <= 8 blocks, LRU) per 5-s
  cycle, AFTER the primary blocks, inside the unchanged sv5 lock that yields
  to control writes. Never widen these caps; the watchdog argument rests on
  them.
- The control window 1100-1121 is readable (from readbacks) but must NEVER
  enter the learned set/poll; FC3/FC4 are the only dispatched function codes
  (no write path exists in the package).
- Staleness keys on the PAYLOAD ts of `edge/registers/raw` (poll time), so a
  stale retained message after a core restart serves nothing fresh; native
  blocks answer 0x0B when stale, the VP map surfaces age/quality in-map.
- Default OFF (`mirror.json`); disabled = no listener AND an empty retained
  want set. The Einrichten card (`static/mirror.js`, `#mirrorCard`) is a
  NORMAL-mode customer control (owner decision) - toggle + copy-ready address;
  only the register detail is Technik-gated. `VP_MIRROR_PORT` is display+
  mapping only (compose lockstep incl. `install.sh generate_compose()`).
- **⚠ `learned_blocks` LEER ist die WAHRHEIT, kein Defekt** (Backlog
  `vp-mirror-blocks-anzeige`, Live-Beweis 30.07.: Reads OK auf Unit 1 + 100,
  Zaehler 0). Es zaehlt AUSSCHLIESSLICH die ZUSAETZLICHEN Bloecke, die der
  Spiegel in den Node-RED-Poll aufnehmen musste, weil der PRIMAERE Poll sie
  nicht abdeckt - auf einer gesunden Anlage, deren Verbraucher liest, was der
  Primaer-Poll ohnehin liefert, ist es fuer immer 0, waehrend beide Units echte
  Werte liefern. Es ist deshalb KEINE Aussage ueber „liefert der Spiegel?"; die
  belastbaren Fakten dafuer sind `raw_age_s` (Unit = native Durchreiche) und
  `telemetry_age_s` (Unit 100). `mirror.js detailLine` nennt genau die zwei
  (inkl. ihres ehrlichen „noch keine Daten") und zeigt die gelernten Bloecke
  NUR, wenn es wirklich welche gibt - eine dauerhafte „0 gelernte
  Registerbereiche" las sich wie „hier wird nichts ausgeliefert".
- **⚠ `mirror.js` ist die EINE Quelle des Spiegel-Zustands auf der Seite**
  (`window.VPMirror.state()` + das Ereignis `vp:mirror-state`, beides aus
  `render()` gesetzt): der Datenfreigabe-Akkordeon-Kopf (`einrichten.js`) SEEDET
  daraus und folgt dann dem Ereignis - Kopf und Karte koennen sich damit nicht
  widersprechen. **NOCH UNBEKANNT ist NICHT „Aus"**: `datenfreigabeSummary(null)`
  liefert „…", nie eine Behauptung, die niemand gemessen hat (der Kopf las sonst
  „Aus + grauer Punkt" ueber einer Karte mit „Bereit"). Die statische
  Erst-Anzeige in `einrichten.html` traegt aus demselben Grund „…".
- Proofs: `internal/mirror` units (framing/fuzz/learner/staleness),
  `agent/mirror_integration_test.go` (bus->TCP byte-match, learn->deliver,
  /api/mirror toggle), `nodered/mirror-poll.e2e.test.js` (real poll +
  in-process Solarman logger: learned-after-primary, refusal isolation,
  write-intent skip), `test/e2e-compose.sh` (unit 100 vs /api/state, FC6
  refused). A learned block the inverter refuses ('Modbus-Ausnahme') is
  dropped + answered 0x02 - keep that error string stable across the
  auto-solarman copy and `mirror.UpdateRaw`.

