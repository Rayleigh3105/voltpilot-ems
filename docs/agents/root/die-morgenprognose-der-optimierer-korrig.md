# Die MORGENPROGNOSE: der Optimierer korrigiert die PV-Prognose um ihren eigenen GEMESSENEN Fehler

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 75).


Live-Fall Pilsting/Herzogau, 23.08.2026 (Scout `data/vp-negativpreis-herzogau-g3` §5.1;
Captain-Order „Prognose fix" 24.08.2026). Der Fahrplan-Lauf von **09:36** hatte die
09:30-MESSUNG (~38 kW) in der Datenbank und plante trotzdem für 09:30/09:45 eine **0,5-kW-ENTLADUNG**,
weil seine PV-Prognose dort UNTER dem Hausverbrauch lag — mitten im Negativpreis-Fenster, während
~30 kW ins Netz liefen. Alles hier ist ADDITIV; eine Anlage ohne Beleg-Slots plant byte-identisch
wie vorher.

- **⚠ ZWEI GLASWÄNDE, EINE URSACHE-KLASSE — und die zweite ist die, die man sonst übersieht.**
  (1) **Das Modell kennt je Anlage nur EINE Ausrichtung:** `forecast_collect.load_sites`
  (`services/forecast/.../forecast_collect.py:152-186`) liest GENAU EINE `asset`-Zeile vom Typ `pv`
  und baut daraus eine einzige `PlantSpec` mit EINEM `azimuth_deg`/`tilt_deg` (Vorgabe Süd/30°,
  `domain.py:100-101`) — eine Ost+West+Deye-Dachlandschaft ist damit morgens strukturell zu niedrig
  (in Herzogau trägt die OST-Anlage 83 % der 08:25-Erzeugung). (2) **Niemand schaute darauf, was die
  Anlage GERADE liefert:** `inputs._forecast_or_fallback` konsumierte die gespeicherte Prognose
  wörtlich; Telemetrie wurde nur für SoC/§14a (`_fresh_measurement`) und als FALLBACK gelesen. Eine
  zu wolkige Morgenprognose überlebte damit jeden 15-Minuten-Neuplan unangetastet.
- **Der Fix ist EINE generische, stammdatenfreie Korrektur:** `voltpilot_optimization/nowcast.py`
  (rein, ohne DB/Uhr/IO — das `Tagesprotokoll`/`FleetPflege`-Muster) vergleicht über die letzten
  ABGESCHLOSSENEN Slots, was das AKTIVE Modell VORHERGESAGT und was die Anlage GEMESSEN hat, und
  trägt dieses Verhältnis in den NAHEN Horizont — abklingend auf die unveränderte Prognose. Ein
  ost-lastiges Dach zeigt morgens ein Verhältnis > 1 und nachmittags < 1, OHNE dass jemand einen
  Azimut pflegt; eine systematisch zu wolkige Aussicht zeigt es ganztags; echt schlechteres Wetter
  als prognostiziert zeigt < 1 und der Plan hört auf, eine Ladung zu erwarten, die nicht kommt.
  Es ist die klassische Clear-Sky-Index-Persistenz, mit dem eigenen aktiven Modell als Referenz.
- **⚠ Er wohnt im OPTIMIERER, nicht im Prognosedienst — drei Gründe, und der zweite ist bindend:**
  er braucht `now` und frischere Telemetrie als den letzten Sammel-Lauf; ihn unter `pv-physical`
  zurückzuschreiben würde die ganze Bewertungs-Semantik korrumpieren (`forecast_accuracy` bewertete
  ein Modell an einer Zahl, die es nicht erzeugt hat, und der Skill des Kandidaten dagegen wäre
  bedeutungslos); und als NEUES Modell bräuchte er eine Beförderung JE ANLAGE, erreichte die Flotte
  also gar nicht. Im Optimierer korrigiert er **das jeweils aktive Modell**, ein später befördertes
  `pv-residual-xgb` KOMPONIERT also mit ihm statt gegen ihn. Angewandt wird er auf die FINALE
  PV-Reihe unmittelbar VOR `fallback.night_floor_pv` — derselbe Platz, dieselbe Begründung
  („eine defensive Korrektur der PV-EINGABE, unabhängig von der Quelle").
- **⚠ Folge, die jede Fläche kennen muss: `forecast_accuracy` misst weiter das GESPEICHERTE Modell,
  nicht die geankerte Reihe, mit der geplant wurde.** Das ist richtig so (ein Anker ist ein Nowcast,
  der binnen zwei Stunden verfällt, keine Prognose) — und die Zahl je LAUF steht in der
  Admin-Optimizer-Diagnose (`schedule.pv_anchor_ratio` → `pvAnchorRatio`, Karte „PV-Anker (Messung)"
  neben „Aktive Modelle").
- **Vier Eigenschaften machen ihn flottenweit sicher** (alle in `nowcast.py` dokumentiert):
  VERHÄLTNIS statt Differenz (ein kW-Offset stünde nachts noch da) · **Beleg oder nichts** (unter
  `min_slots` wird die Prognose UNVERÄNDERT durchgereicht; eine stumme Anlage liefert gar keinen
  Beleg-Slot, ein totes Gerät kann also nie eine Prognose auf null ziehen) · **zweifach begrenzt**
  (symmetrische Klemme `1/max..max`, Vorgabe 5 — bemessen an dem, was Ausrichtungs- und Wetterfehler
  physikalisch zusammen ergeben können; die HARTE Schranke ist die Nennleistung der Anlage) ·
  **er verfällt** (linear auf 1,0 über 8 Slots — jenseits davon sind Bias und Wolke nicht mehr
  unterscheidbar; das genügt, weil der ausgeführte Slot bei 15-min-MPC immer der erste, voll
  geankerte ist).
- **⚠ Der Beleg nimmt NUR abgeschlossene Slots** (`_lookback_slot_starts`): der erste Horizont-Slot
  läuft noch (B1), sein Messmittel wäre ein Teilmittel unbekannter Abdeckung — und das Verhältnis
  (anders als die rohe Leistung) bewegt sich über eine Viertelstunde kaum. Die Messung wird über
  `voltpilot_forecast.domain.slot_means` zu Slot-MITTELN verdichtet (die Hausregel; ein Einzel-Sample
  wäre ein Zufallsgriff aus der Viertelstunde), und die Vorhersage-Seite trägt `run_at < time`
  im SQL — die Ex-ante-Eigenschaft ist damit eine Eigenschaft der ABFRAGE, keine Annahme über den
  Sammler.
- **Fail-soft wie die Erklär-Schicht:** `_anchor_pv_input` fängt ALLES (kaputter Env-Wert,
  unerreichbarer Lesepfad) und gibt die UNVERÄNDERTE Prognose zurück — eine fehlende Korrektur ist
  ein schlechterer Plan, eine geworfene Ausnahme gar kein Plan. Not-Aus `OPTIMIZER_PV_ANCHOR_ENABLED`
  (Vorgabe AN — ein per Vorgabe ausgeschaltetes Flag müsste im gitops-Repo nachgezogen werden, die
  dokumentierte Falle).
- **Replay-Beweis (`tests/test_morning_anchor_replay.py`, echter Solver, echte DE-LU-Preise des
  23.08.):** der 09:30-Slot dreht von **−0,5 kW Entladung auf +21,5 kW Ladung** (Netz 0,0), der
  gemessene Export dieses Slots fällt von **31,2 auf 9,2 kW**, die erste Stunde des Negativfensters
  von 29,3 auf 8,0 kWh, und der Speicher ist um **12:00 statt 13:30** voll. **⚠ Die ehrliche Grenze
  steht als Zusicherung im Test:** über das GANZE Fenster exportieren beide Pläne dieselben ~190 kWh
  — dort bindet die Speichergröße (~55 nutzbare kWh gegen ~290 kWh Überschuss), der Anker verschiebt
  also den ZEITPUNKT der Aufnahme, nicht ihre Summe; den Rest schließt erst das zweite Glied der
  Ursachenkette, eine AUSFÜHRBARE Abregelung. Die Rekonstruktion der drei nicht messbaren Eingaben
  ist im Test-Docstring offengelegt und wird GEPRÜFT statt geglaubt (ein eigener Test füttert die
  rekonstruierte Prognose dem echten Solver und bekommt den dokumentierten Lauf zurück; ein zweiter
  fährt vier verschiedene Morgen-Rekonstruktionen und bekommt EINEN identischen Plan).
- **Offen geblieben (und dadurch weniger dringend):** der STRUKTURELLE Fix derselben ersten Ursache —
  die PV-Prognose als SUMME je Erzeuger-Quelle mit eigener Ausrichtung. `measurement_point` trägt
  `capacity_kwp` und eine MaStR-Referenz je Quelle, aber KEINEN Azimut/Neigung; es braucht also
  einen Datenmodell-Schritt. Der Anker fängt den Ausrichtungs-Bias im nahen Horizont ab, und dort
  fällt die Dispatch-Entscheidung.
- **Beweise:** rein `tests/test_nowcast.py` (25: Energie- statt Slot-Verhältnis, „Modell sah gar
  keine Sonne" ⇒ Klemme statt Absturz, symmetrische Klemme, stumme Anlage belegt NICHTS,
  Dämmerungs-Slots tragen keinen Beleg, Nachtslot bleibt 0, Nennleistungs-Deckel in beide Richtungen,
  Env-Knöpfe, die Verdrahtung gegen ein gefälschtes psycopg inkl. Slot-MITTEL, Not-Aus und
  fail-soft) · `tests/test_morning_anchor_replay.py` (5) · api
  `AdminApiTest.optimizerDiagnosticsDecomposeSlotsWithRealTariffAndRemuneration` (echte DB: der Lauf
  trägt seinen Anker, ein Lauf ohne Anker sagt NICHTS statt „1,0") · Portal `optimizer.test.ts` +
  `OptimizerPage.test.tsx` (beide mutationsgeprüft).
- **Ops:** keine neue Pflicht-Variable (alle Knöpfe haben Vorgaben). Deploy = Cloud-Images
  (`optimization` + `api` + `frontend`); **kein Edge-Release nötig** — die Korrektur steckt in den
  veröffentlichten `pv_kw`-Werten, der eingefrorene MQTT-Fahrplan-Kontrakt ist unberührt.

