# vp-soc-derive (P5b Ebene 2): die SoC-Ableitung auf der Box

Angelegt am 09.09.2026. Cloud-Seite, Kontrakt, Kurven-Vorlage und die volle Begründung: root
`AGENTS.md` → `docs/agents/root/der-soc-ableitungs-baustein-p5b-ebene-2.md`. Ebene 1:
`vp-mqtt-read-p5-die-selbst-angebundene.md`. Konzept
`data/vp-deye-diybms-luecke-l5/report.md` §3.2b, Vertrags-Entscheid D-23.

Palette **0.11.0** bringt `nodes/vp-soc-derive.js` (Katalogtyp `vp.soc.derive`) und
`lib/soc-derivation.js`. Der Knoten nimmt die Standard-Batteriekanäle, die eine Ebene-1-Quelle
gerade geliefert hat, LEITET daraus den Ladestand ab und veröffentlicht ihn als ganz normale
Entitäts-Telemetrie auf `edge/entities/{id}/telemetry` — zwei Kanäle, `soc_pct` UND
`soc_source_code`. Es entsteht keine zweite Mechanik und kein zweiter SoC-Begriff.

## Die Regeln, die halten müssen

- **`lib/soc-derivation.js` ist die reine Rechnung** — `socFromVoltage` / `deriveOcv` /
  `deriveCoulomb` / `derive`, ohne Broker, ohne Node-RED, ohne Uhr (`now` reist als Parameter
  herein). WOHER ein Ladestand kommt und wann es KEINEN gibt, ist eine Aussage über
  Ehrlichkeit; sie muss ohne Docker vollständig prüfbar sein.
- **Er hängt an einer KANTE hinter dem Lese-Knoten, NICHT am Takt** (`triggerable: false` im
  Katalog, `outputsOf` kennt beide Knoten). Der Auslöser trifft nur die Quelle; hinge der
  Ableiter selbst am Takt, rechnete er auf dem Stand des VORIGEN Taktes.
- **Konservatives MINIMUM** aus höchster und niedrigster Zelle (`min(f(vmax, Ladekurve),
  f(vmin, Entladekurve))`) — der Pack kann nur hergeben, was seine schwächste Zelle hält.
  `conservative_min: false` ist die ausdrücklich gewählte optimistische Lesart (das MAXIMUM);
  ein MITTEL gibt es nicht, es wäre eine erfundene Zelle.
- **Eine frische MESSUNG schlägt jede Rechnung** (`prefer_direct`, Vorgabe an). Nur der
  Vergleichsbetrieb schaltet das ab.
- **Nie eine erfundene Zahl.** Fehlt der Eingang (Zellspannung bzw. Anker), wird NICHTS
  veröffentlicht — nie eine Vorgabe, nie eine 50.
- **Ein eingefrorener Wert bekommt NIE einen frischen Zeitstempel.** Der Knoten sendet ihn gar
  nicht erneut; er zeigt ihn samt Alter im Status, und die Telemetrie lässt ihn altern. Nach
  `hold_s` (Vorgabe 900 s) vergisst er ihn.
- **Der Zaehl-Zustand ist DAUERHAFT** — `node.context().set(key, …, 'file')`, die
  `localfilesystem`-Ablage aus `edge-app/nodered/settings.js` (dieselbe, die den
  Deye-Steuer-Snapshot trägt). Beim Laden nach einem Neustart gilt DIESELBE `hold_s`-Regel wie
  im Betrieb: eine Lücke, die die Frist reißt, verwirft den Zustand, statt darüber
  hinwegzurechnen — was ein Speicher unbeobachtet getan hat, weiß niemand.
- **Vorzeichen:** `power_kw` ist POSITIV beim LADEN. Eine Quelle mit umgekehrter Zählrichtung
  braucht keinen zweiten Begriff — die Feld-Zuordnung der Ebene 1 hat `scale`, und `-1` ist die
  ganze Antwort.
- **Der Wirkungsgrad dämpft die LADE-Seite, nicht beide** — sonst stünde er zweimal in
  derselben Bilanz.
- **Nur lesend.** Der Knoten schreibt auf kein Kundengerät; veröffentlicht wird ausschließlich
  auf dem lokalen VoltPilot-Bus.

## ⚠ Palette 0.11.0 ist die Untergrenze des Flows

`min_palette_version` steht für den ganzen Batterie-Flow (Lese-Knoten UND Ableiter) auf
`0.11.0` — eine ältere Palette quittiert den Rollout mit `unsupported`, statt still nichts zu
tun. Es gilt dieselbe Reihenfolge-Falle wie bei P5: **das Edge-Release muss eine Anlage
erreichen, bevor dort die erste Ableitung angelegt wird.**

## Tests

```bash
(cd edge-app/nodered/vp-palette && npx mocha test/soc_derive_spec.js --timeout 15000 --exit)
(cd edge-app/nodered/flowc && node --test compile.test.js)
```

`test/soc_derive_spec.js` liest `docs/contracts/v2/soc-derivation-vectors.json` PER PFAD und
fährt jeden Vektor durch die echte Rechnung — der Beleg-Tag des Kunden (vmin 3,393 V /
vmax 3,606 V → **7,3 %** konservativ, 31,5 % aus der höchsten Zelle allein), die Klemmung, die
Ladungszählung mit Anker/Lücke/Rekalibrierung, dazu vier Läufe am laufenden Bus (darunter der
Beweis, dass ein eingefrorener Wert NICHT erneut gesendet wird).
