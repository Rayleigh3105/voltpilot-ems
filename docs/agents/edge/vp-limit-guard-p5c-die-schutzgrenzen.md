# vp-limit-guard (P5c): die Schutzgrenzen auf der Box — und die BMS-Kappe im Wächter

Angelegt am 09.09.2026. Cloud-Seite, Vertrag, Vorlage und die volle Begründung: root
`AGENTS.md` → `docs/agents/root/der-schutz-grenzbaustein-p5c.md`. Ebene 1:
`vp-mqtt-read-p5-die-selbst-angebundene.md` / `vp-http-read-p5-http-die-web-auskunft.md`,
Ebene 2: `vp-soc-derive-p5b-die-soc-ableitung.md`, Bindung: `die-speiser-bindung-auf-der-box-p6.md`.
Konzept `data/vp-deye-diybms-luecke-l5/report.md` §3.2b + §3.3.

Palette **0.13.0** bringt `nodes/vp-limit-guard.js` (Katalogtyp `vp.bms.limit`) und
`lib/limit-protection.js`. Der Knoten leitet aus Ladestand und Zellspannungen ab, WAS DIE
BATTERIE ZULÄSST, und veröffentlicht bis zu vier Kanäle als ganz normale Entitäts-Telemetrie:
`charge_limit_a`, `discharge_limit_a`, `charge_allowed`, `discharge_allowed`.

## Die Regeln, die halten müssen

- **`lib/limit-protection.js` ist die reine Rechnung** — `currentFromSoc` / `latch` /
  `evaluate`, ohne Broker, ohne Node-RED, ohne Uhr (`now` reist als Parameter herein). WAS
  eine Batterie zulässt, ist eine Aussage über Sicherheit; sie muss ohne Docker vollständig
  prüfbar sein.
- **Er hängt am ENDE der Kette** (`Takt → Lese-Knoten → [vp-soc-derive] → dieser Knoten`), an
  einer KANTE und nie am Takt (`triggerable: false`). Seine Treppe braucht den ABGELEITETEN
  Ladestand; am Takt rechnete er auf dem Stand des VORIGEN Taktes.
- **Jede Stufe reicht weiter, was sie weiß.** `vp-soc-derive` gibt seit P5c auf seinem AUSGANG
  die Rohkanäle SAMT dem gerechneten Ladestand weiter (die TELEMETRIE bleibt unverändert bei
  zwei Kanälen). Ohne das bräuchte der Schutz zwei Kanten und müsste sich aus zwei Nachrichten
  ein Bild zusammensetzen, deren Reihenfolge nichts garantiert.
- **Der Faktor mV→V lebt genau einmal**: dieser Baustein benutzt `soc-derivation.cellVolt`,
  statt ihn ein zweites Mal hinzuschreiben.
- **⚠ Er schreibt auf KEIN Gerät.** Kein Register, keine Adresse, kein Kommando — er
  veröffentlicht ausschließlich auf dem lokalen VoltPilot-Bus. Der Kundenflow, dem er
  nachgebaut ist, schreibt die Deye-Grenzen; VoltPilot tut das erst hinter dem
  Zertifizierungs-Gate.
- **„Nur bei Änderung", aber mit Wiederholung.** Ein unveränderter Satz Grenzen reist nicht
  bei jedem Takt (der `rbe`-Teil des Kundenflows), wird aber nach `REPEAT_AFTER_MS` (2 min)
  wiederholt — sonst verfiele die Wächter-Kappe (Frischefenster 5 min) genau dann, wenn der
  Pack ruhig steht.
- **Der Riegel ist ein GEDÄCHTNIS** und überlebt einen Neustart (dauerhafte Kontextablage
  `'file'`) — aber nur, solange `hold_s` gilt: was ein Pack in einer unbeobachteten
  Viertelstunde getan hat, weiß niemand.

## Die Kappe im Wächter (`internal/guards`)

`guards.Limits.Bms` ist ein **ZEIGER**; `nil` = der Pack hat nichts gesagt, und dann ändert
sich nichts. Ein Nullwert, der „0 kW" hieße, hätte jede Anlage ohne Schutzbaustein
stillgelegt. Die Kappe wird ZWEIMAL angelegt (vor und nach der §14a-Korrektur, genau wie das
Nennband) und RESTRINGIERT nur. Neue Stufe: `guard:bms_limit`.

`guards.BmsKw(limitA, packVoltageV)` rechnet Ampere in Kilowatt: **ohne gemessene
Packspannung gibt es keine Strom-Kappe** — eine geratene Nennspannung wäre eine erfundene
Leistungsgrenze. Ausnahme: 0 A sind bei jeder Spannung 0 kW.

⚠ **Beide Klemm-Pfade tragen sie**: der v2-Arbiter (`desired.Deps.BmsEnvelope`) UND der v1
`applySetpoint`. Letzteres ist nicht optional — auf einer v1-gesteuerten Anlage ist das der
Pfad, der wirklich den Wechselrichter schreibt, und ein Wächter, den der Live-Pfad überspringt,
ist ein Wächter dem Namen nach.

`agent.bmsEnvelope(entityID)` löst auf, WESSEN Grenzen gelten: erst die kommandierte Entität
selbst (eigenständige Batterie), dann der über `role_assignment` (P6) gebundene Speiser —
immer aus EINER Entität, und nur, wenn ihre Telemetrie jünger als `bmsEnvelopeWindow` (5 min)
ist. Bewusst NICHT über `entityReading`: die lokale Komposition (M-B3-local) ist ein
ANZEIGE-Ersatz und darf nie ein Steuer-Eingang werden.

## Tests

`vp-palette/test/limit_guard_spec.js` (die geteilten Vektoren
`docs/contracts/v2/limit-protection-vectors.json` durch die echte Rechnung, plus der Knoten am
laufenden Broker), `internal/guards/bmslimit_test.go` (der Block `waechter` derselben Datei
durch `ClampTraced`; dazu: Schweigen ändert nichts, die Kappe restringiert nur),
`internal/agent/bms_envelope_test.go` (Batterie → Bindung → Wächter, samt „Schweigen ist keine
Sperre"), `flowc/compile.test.js` (die Kette + gepinnter Hash der Fixture
`flow-graph.valid.mqtt-battery-protected.json`).
