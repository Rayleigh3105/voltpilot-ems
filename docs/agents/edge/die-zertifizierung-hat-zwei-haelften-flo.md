# Die Zertifizierung hat ZWEI Hälften: Flotten-Allowlist + Laufzeit-Freigabe pro Gerät

Ausgelagert aus `edge-app/AGENTS.md` am 05.09.2026 (Abschnitt Nr. 39).


Der Schreib-Gate im Executor lautet
`controlEnabled && (CERTIFIED_CONTROL_FAMILIES.has(family) || setpoint.device_certified === true || calibration)`.

- **Flottenweit** = `CERTIFIED_CONTROL_FAMILIES` in `inverter-control-routing.js`
  (heute nur `sunspec`): eine am Prüfstand für die ganze Modellklasse belegte
  Familie. Diese Liste NICHT „reparieren", indem man eine auf EINEM Gerät
  freigegebene Familie einträgt.
- **Pro Gerät** = die First-Light-Freigabe, die der Kern als **`device_certified`**
  auf `edge/setpoint` mitschickt (`Agent.controlCertified` = env-Allowlist MERGED
  mit `data_dir/calibration-certified.json`). Vorher erreichte diese Freigabe
  Layer 1 nur eingefaltet in `control_enabled` — ein Wert, der AUCH beim reinen
  Not-Aus false ist. Der Executor konnte „freigegeben, Steuerung an" nicht von
  „nicht freigegeben" unterscheiden und plante auf dem freigegebenen Piloten
  (`hybrid_3p`) dauerhaft `writes: []`: **der Fahrplan erreichte den
  Wechselrichter nie, nur der Kalibrier-Bypass schrieb** — First-Light war für
  den Realbetrieb wirkungslos.

Regeln, die dabei bleiben: `controlEnabled` ist auf BEIDEN Seiten das äußere AND;
`guards.Clamp` bleibt vorgelagert autoritativ und der Adapter darf nur VERENGEN;
SoC-Band, Magnitudenkappung, Remote-Watchdog (1101) und die Schreib-REIHENFOLGE
(Watchdog zuerst, Enable zuletzt) sind unberührt; die Beweisführung der Freigabe
(readback-bestätigter Test mit gemessener Bewegung) ist unverändert — geändert hat
sich NUR, wen die Freigabe erreicht.

`controlRelease` nimmt dieselbe Freigabe (`opts.deviceCertified`) — **tragend**:
was gefahren werden darf, muss auch zurückgegeben werden können, sonst übernähme
ein freigegebenes Gerät die Steuerung und gäbe sie bei Not-Aus/stillem Kern nie
zurück. `certified` bleibt bewusst EINE Variable (Gate, deutscher Grund,
Readback-Stempel, `dualControllerSignal` meinen alle „dieses Gerät darf live
geschrieben werden") — genau das, was der Kern rechnet, womit der Readback jetzt
mit dem Kern übereinstimmt statt by design zu divergieren.

**Ein `device_certified`-Feld nützt nur, wenn es auch ankommt:** `vp-sollwert`
reicht das Kommando VOLLSTÄNDIG durch (kein Feld-Whitelist wie
`vp-telemetrie.shape()`) — durch `nodes_spec.js` gepinnt. Beide Images müssen
deployt werden: der Kern sendet das Feld, der Flow liest es.

Beweise: `agent/control_test.go` (Setpoint trägt die Freigabe; Kill-Switch bleibt
außen), `inverter-control-routing.test.js` (granted/ungranted/absent, nur ein
echtes `true` zählt, Release-Symmetrie, N1/Nennleistung weiterhin verweigert),
`flows-sync.test.js` (Inline-Kopie == Modul für den granted-Fahrplan + den
durchgereichten Release) und `deye-control.e2e.test.js` „FAHRPLAN e2e" (echter
Plan-Node aus flows.json -> echter Executor -> in-process Solarman-V5-Logger, OHNE
Allowlist-Mutation und OHNE Kalibrier-Flag).

