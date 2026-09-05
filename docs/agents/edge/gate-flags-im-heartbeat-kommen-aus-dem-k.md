# Gate-Flags im Heartbeat kommen aus dem KERN, nie aus einem Readback-Stempel

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 40).


Ein Readback-Stempel ist eine Layer-1-BEOBACHTUNG und niemals die Autorität für
ein Gate-Flag. Zwei Live-Defekte derselben Klasse haben das bewiesen — beide
zeigten sich als eine dauerhaft falsche Aussage im Portal, während `:8484`
korrekt war:

- **`certified`**: der Node-RED-Flow stempelt es aus seiner STATISCHEN
  Familien-Allowlist (`inverter-control-routing.js` `CERTIFIED = {sunspec}`), die
  die per-Gerät erteilte **First-Light**-Freigabe gar nicht kennen kann → ein
  freigegebener Deye (`hybrid_3p`) meldete dauerhaft `certified:false`.
- **`control_enabled`**: der Exec-Node stempelt `!!ctrl.controlEnabled`, und
  `controlRelease()` setzte `controlEnabled` gar nicht → `!!undefined` = `false`.
  Nach JEDEM First-Light-Test feuert der TTL-Auto-Revert einen RELEASE, dieser
  Readback ist damit der LETZTE, den die Cloud auf einer unzertifizierten Familie
  sieht, und jeder folgende Heartbeat wiederholte `control_enabled:false` — das
  Portal sagte auf Dauer „Die Wechselrichter-Steuerung ist ausgeschaltet".

`agent.controlSummary` liest deshalb BEIDE Flags aus dem Snapshot
(`snap.ControlCertified` / `snap.ControlEnabled`, gepflegt von
`applySetpoint`/`calibration.go` — genau die Werte der lokalen Karte). Das ändert
NUR, was BERICHTET wird: wer schreiben darf, entscheiden weiterhin das
`control_enabled` auf `edge/setpoint` und die Allowlist des Executors. Den
`CERTIFIED`-Map des Flows nicht „reparieren": First-Light ist bewusst eine
Laufzeit-Freigabe pro Gerät. Weichen Kern und Readback ab, nennt
`logControlGateDivergence` beide Werte einmal pro 10 min im Log statt still zu
überschreiben. `controlRelease` trägt `opts.controlEnabled` inzwischen auf jedem
Zweig durch (Defence in Depth — der Readback lügt nicht mehr strukturell, ersetzt
den Kern-Fix aber nicht: beim Calibration-Revert ist `control_enabled:false`
ehrlich). Beweis: `agent/control_test.go
TestHeartbeatCertifiedFollowsTheCoreNotTheFlowAllowlist` +
`TestHeartbeatControlEnabledFollowsTheCoreNotTheReleaseReadback` (je beide
Richtungen — ein Flow, der ein Gate BEHAUPTET, gewinnt nie),
`inverter-control-routing.test.js` + `flows-sync.test.js`.

**Beim nächsten Feld im Heartbeat zuerst fragen: Beobachtung oder Gate?**
Beobachtungen (`all_match`, `mismatch_roles`, `commanded/confirmed_kw`,
`control_path`, `remote_status_raw`, `possible_conflict`) gehören zum Readback;
Gate-Flags gehören in den Kern.

