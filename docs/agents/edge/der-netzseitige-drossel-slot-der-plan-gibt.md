# Der NETZSEITIGE DROSSEL-SLOT: der Plan gibt den Netzpunkt an den Wechselrichter

Der Produktivpfad zum [Netz-Sollwert-Test](der-netz-sollwert-test-derselbe-sollwert.md)
(Konzept `vp-deye-netzseitig-drossel-k2`, Paket P3, gebaut nach dem bestandenen
Live-Lauf an Herzogau am 08.10.2026). In einem Fahrplan-Slot mit Abregelung
regelt der Deye den Netzanschluss selbst auf 0 W und drosselt dafür seine
**eigene** PV. Vertrag: `docs/contracts/v2/plan-execution-ownership.md` →
„Netzseitiger Drossel-Slot"; Registerlage und Befunde: `nodered/DEYE.md` → „Der
netzseitige Drossel-Slot". Was HIER gelten muss:

- **Die Regel liegt rein in `guards/gridtarget.go`**, `agent/gridtarget.go` ist
  nur Verdrahtung (die Bauform von `nativemode.go` / `agent/native.go`). Eintritt
  in einem Satz: Slot trägt `pv_limit_kw` UND der Plan entlädt nicht UND
  Ladestand über Reserve + 3 %. Nie für die registrierte Einspeisegrenze – die
  halten die Fronius, der Einspeisewächter bleibt Fronius-only.
- **⚠ Sollwert weglassen heißt nicht Aufsicht weglassen.** Netzseitig führt der
  Deye die Batterie und hält seine eigenen SoC-Grenzen nicht ein (er entlädt bis
  0 %). `guards.Clamp` klemmt dort nichts – jede Schutzgrenze ist deshalb eine
  Beobachtung mit benannter, bis zum Slot-Ende gerasteter Rücknahme.
- **⚠ Nach OBEN gibt es bewusst keine Rücknahme** (Captain-Entscheid E4,
  `GridTargetChargeCeilingPct = 100`). Ein voller Speicher ist der Zustand, in
  dem der Modus die eigene PV drosselt; eine Rücknahme bei 95 % gäbe sie bei
  negativem Preis wieder frei. Wer hier eine Obergrenze „nachzieht", baut den
  Fehler ein, den das Paket behebt.
- **⚠ Die Freigabe und die Registerfolge gehören Layer 1**
  (`nodered/deye-grid-target.js`, im Flow WÖRTLICH eingebettet – eine Quelle,
  zwei Laufzeiten). Der Kern fragt nur, wenn Layer 1 den Hebel als `grid_target`
  in `native_capabilities.intents` meldet. Ein weiteres Modell = ein
  Netz-Sollwert-Test an genau diesem Modell + ein Eintrag in
  `GRID_TARGET_RELEASES` mit Prüfnachweis. Die Kalibrierung öffnet den Zweig nicht.
- **⚠ Der BELEG sind die Register der Rückmeldung, kein Wort.** Rolle
  `power_control_mode` liest 2, Rolle `grid_power` hält das Ziel
  (`gridTargetEvidence`); `mode` bleibt `normal`. Der Palettenknoten
  `vp-control-readback` hat eine feste Feldliste – ein neues Modus-Wort wäre dort
  weggefallen. Gepinnt in `control-readback-vectors.json`
  (`netzseitig_takt1_eintritt`).
- **⚠ Register, die halten, beweisen nichts über die WIRKUNG.** Die Aufsicht
  läuft auf dem gemessenen Netzpunkt (Band 0,5 kW, Frist 60 s), und `match` im
  Herzschlag ist diese Messung, kein Register-Echo.
- **⚠ „Netz folgt nicht" rechnet dem Deye nur zu, was er beantworten kann.**
  Live-Befund 08.10.2026: „Ziel 0" stellt nur den eigenen Anteil (eigene PV plus
  Speicherladung), nicht die Fronius-Einspeisung. Einspeisung bei ausgereiztem
  Deye ist deshalb KEINE Rücknahme (sie gäbe seine PV obendrauf frei), sondern
  der Hinweis `eigener_anteil_ausgeschoepft`; ein unbekannter Eigenanteil zählt
  als der des Deye.
- **⚠ Das Ziel ist nie ein Bezugs-Ziel** – höchstens +50 W, im Kern
  (`ClampGridTarget`) UND in Layer 1, dort auch nach dem Runden auf
  Register-Einheiten (30 kW: 0,05 kW rundete sonst auf 60 W).
- **⚠ Die Reihenfolge ist die Sicherheit:** `1101` → (`1109 ← 0` Neutralschritt,
  solange nicht belegt) → `1115 ← 999` VOR dem Umschalten → `1104 ← 2` →
  `1109 ← Ziel` → `1100 ← 1`. Die Rückkehr ist der gewöhnliche Fernsteuer-Plan –
  das geht nur, weil das Ziel 0 batterieseitig wieder neutral ist.
- **Die Korrekturen sind im Slot freigegeben** (`inSlotCorrections` in
  `applySetpoint`): Trim, Lastfolge, Defizit-Deckung, Überschuss-Aufnahme, „Auto
  vor Speicher", Lastspitzen-Wächter. Die Entscheidung fällt deshalb VOR ihnen;
  `battery_setpoint_kw` bleibt der reine Planwert = die Referenz der Rücknahme.
- **Fronius zuerst, der Deye regelt den Rest:** der belegte Slot ist der
  Innenkreis der K6-Kaskade (`gridTargetInner`), mit SoC-Obergrenze 100 % und
  der GEMESSENEN Batterieleistung als Batterie-Term.
- **K6 gilt auch hier:** „Gerät regelt" nur für das Führungsgerät mit Zähler am
  Netzpunkt. Tests müssen den Zählerort setzen (`declareMeterAtGridPoint`).
- **Nicht unter gemeinsamer Steuerung:** hält die Box ein Anteile-Dokument
  (AP-15), wird der Slot verweigert (`gemeinsame_steuerung`). Anteil-Wächter,
  Einfrierprobe und Sprungprobe setzen voraus, dass eine Verstellung der Box am
  Zähler ankommt – netzseitig gleicht das Gerät sie aus. Wer beides
  zusammenführen will, entwirft es zuerst.
- **Ein armierter Netz-Sollwert-Test hat Vorrang**; der Produktivpfad trägt
  daneben keinen Zustand (`releaseGridTarget` an den frühen Ausgängen).
- **Wörter über vier Sprachen** stehen in
  `docs/contracts/v2/grid-target-vectors.json` (Go-Kern, Node-RED, api; das
  Portal liest dieselben Felder): `battery_mode`/`execution.mode`/`per_unit.mode`
  = `grid_target`, `grid_target_kw`, `target_kw`, `match`. Am Eintrag des
  Primären steht `mode` DAUERHAFT, `target_kw` nur bei stehender Absicht,
  `match` erst mit Beleg.
- **Beweise:** `guards/gridtarget_test.go` + `gridtarget_vectors_test.go` (Regel,
  Vokabular, Vektoren) · `agent/gridtarget_test.go` + `gridtarget_vectors_test.go`
  (Bus, byte-gleich ohne Hebel/Freigabe, jede Rücknahme, Herzschlag, Beleg über
  die Palette) · `nodered/deye-grid-target.test.js`, `flows-sync.test.js`,
  `deye-control.e2e.test.js` („Drossel-Slot e2e", echter Solarman-Logger),
  `control-profiles.test.js` · api `ControlStatusListenerTest`,
  `CurtailmentStatusListenerTest`.
