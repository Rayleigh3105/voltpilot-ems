# Planungshorizont: 48 h angefragt, auf echte Eingaben gekürzt (28.08.2026)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 78).


Captain-Entscheid „Option A". Der produktive Zyklus plante eine harte `SLOTS_24H = 96`,
also endete ein 18:30-Lauf um 18:15 des Folgetags - **der Abend des Folgetags existierte
für ihn nicht**. Gespeicherter Strom war damit nur in den letzten 90 Minuten des Fensters
etwas wert, der Plan lud wenige kWh und drosselte einen Negativpreis-Mittag, den er hätte
einlagern können (Anlage Pilsting, Box `edge-45gz7da`). Die Preise für morgen liegen ab
~12:45 in `day_ahead_prices` - die Daten waren da, das Fenster nicht.

- **⚠ DER HORIZONT IST EINE ANFRAGE, NIE EINE ZUSAGE.** `OPTIMIZER_HORIZON_SLOTS`
  (`config.horizon_slots()`, Vorgabe **192 = 48 h**, erlaubt 16..192, Müll bricht laut ab)
  ist, was der Zyklus WÜNSCHT; `inputs.gather_inputs` kürzt in ZWEI Stufen auf
  `min(Anfrage, bekannte Preise, echte Prognosen)`. **`96` stellt das Verhalten vor dem
  28.08.2026 exakt her - der Sofort-Rollback ohne Code.**
- **⚠ `OPTIMIZER_HORIZON_HOURS` wird AKZEPTIERT, nicht abgelehnt - und das ist eine
  bewusste Umkehr am selben Tag.** Die erste Fassung wies den veralteten Namen laut ab
  („fail loudly"). Die **k8s-Manifeste setzen ihn HEUTE**
  (`apps/voltpilot/base/optimization/optimization.env` = `OPTIMIZER_HORIZON_HOURS=24`),
  eine Ablehnung hätte den `optimization`-Container beim nächsten Deploy in den
  Neustart-Kreisel geschickt und die **GANZE Flotte ohne Fahrplan** gelassen - genau
  die Klasse, von der die OTA-Listener-Falle und die Flyway-Prüfsummen-Vorfälle
  handeln. **Ein Konfigurationsname ist keinen flottenweiten Planungsausfall wert.**
  Die Auflösung (`config.horizon_slots`, die EINE Stelle - der Replan-Container
  erreicht den Horizont über `engine.plan_site`, nie über die CLI): nur der Alias ⇒
  `Stunden × 4` mit lauter Deprecation-WARN · beide gesetzt und EINIG ⇒ der
  Slots-Wert, dieselbe WARN · beide WIDERSPRÜCHLICH ⇒ lauter Abbruch, der BEIDE Werte
  nennt (dort ist Verweigern richtig: zwei Betreiber-Absichten widersprechen sich, und
  still eine zu wählen plante eine echte Flotte auf einem Fenster, das niemand wollte)
  · Müll in einem der beiden ⇒ lauter Abbruch, veraltet hin oder her.
- **⚠ Die zweite Kürzung ist ASYMMETRISCH, und das ist ihr ganzer Sinn**
  (`inputs.real_forecast_horizon`, rein + Docker-frei geprüft): die ersten **96** Slots
  bleiben UNANGETASTET - dort gilt weiter „gespeicherte Prognose, sonst
  Persistenz-Baseline über die Telemetrie", eine Anlage ohne Prognosezeilen bekommt also
  ihren Plan wie bisher. NUR die Verlängerung DARÜBER hinaus läuft über den
  zusammenhängenden Präfix, den BEIDE gespeicherten Reihen wirklich decken. Eine
  Verlängerung auf synthetischen Werten wäre schlimmer, als den zweiten Tag gar nicht zu
  sehen. `_forecast_or_fallback` ist alles-oder-nichts - ohne diese Kürzung hätte der
  48-h-Wunsch JEDEN Plan auf die Fallback-Baseline geworfen.
- **Der Kontrakt zur Box ist UNVERÄNDERT** (`publisher.EDGE_PLAN_SLOTS = 96`, derselbe
  Deckel in `publisher_v2`): der Edge bekommt weiter höchstens 24 h. Ein 192-Slot-Plan
  erreicht das Gerät **byte-identisch** zu einem 96-Slot-Plan (gepinnt in
  `test_horizon.py`) - kein Edge-Release, kein Schema-Wechsel, kein Rollout. Die ferne
  Hälfte des Horizonts ist eine PLANUNGS-Eingabe, keine Ausführungs-Anweisung: ihre
  Aufgabe ist, die gespeicherte kWh zu bepreisen, auf die die nahe Hälfte handelt.
  **PERSISTIERT wird der volle Horizont** (das Portal zeigt ihn).
- **Der Prognosedienst liefert die 48 h wirklich:** `FORECAST_HORIZON_HOURS` steht auf 48,
  und die PV-Modelle hören auf, wo echtes WETTER aufhört (`forecast_collect.pv_horizon`).
  Grund: `OpenMeteoWeatherProvider` beantwortet einen Zeitstempel außerhalb seiner Proben
  mit `0 W/m2` - von Nacht nicht zu unterscheiden. Bei 24 h war der Zweig unerreichbar
  (der Wetter-Feed reicht ~3 Tage), bei 48 h kann er einen einen Tag ausgefallenen Feed
  überholen. **LOAD wird NIE gekürzt** (seine Baseline braucht Telemetrie, kein Wetter);
  die Kürzung des Optimierers nimmt die kürzere der beiden Reihen.
- **⚠ Horizont-Agnostik ist geprüft, nicht angenommen:** `derive_terminal_value` (das
  Quantil läuft jetzt über bis zu zwei Sonnentage), `explain`, `slot_trim`, `co_solver`,
  der Lastspitzen-Epigraph und `persistence` leiten alles aus `len(inputs)` ab, und die
  vier Tie-Break-Terme sind auf `t / max(n-1, 1)` normiert. `whatif.py` behält seinen
  EIGENEN Vorgabe-Horizont `SLOTS_24H` (eine Vorschau darf nicht mehr kosten als die
  Frage wert ist).
- **Gemessen** (Apple Silicon, echter Solver INKLUSIVE der Erklär-LP): 96 Slots p50
  116 ms, 192 Slots p50 **245 ms** (mit Lastspitzenkappung 296 ms) - Faktor ~2, weit
  innerhalb des 15-min-Takts. Wächter: `test_pilsting_evening.py` (Budget 3 s).
- **Beweise:** rein `test_horizon.py` (27: Hebel + Kürzungsregel + der byte-identische
  Edge-Payload, dazu die Kürzung END-TO-END durch die echte `gather_inputs`-SQL) ·
  `test_pilsting_evening.py` (8: der Live-Fall mit echtem Solver - der 24-h-Plan endet bei
  **5 % SoC** und regelt 202,6 kWh ab, der 48-h-Plan steht im selben Moment bei **95 %**
  und regelt 156,2 kWh ab; **plus die ehrliche Grenze als eigener Test** - ohne
  Einspeisegrenze regeln BEIDE Pläne dieselbe Energie ab, ein Horizont macht keinen
  Speicher größer) · forecast `test_collect.py` (`pv_horizon` + „PV gekürzt, LOAD nie") ·
  Portal `schedule.test.ts`/`ScheduleChart.test.tsx` (zwei Tagesmarken, nichts wird bei 96
  gekappt) . Im echten Chrome bei 1440 und 375 gemessen: 0 px horizontaler Überlauf, 0
  überstehende Elemente, keine Konsolenmeldungen.
- **Ops (gitops, k3s):** die Manifeste tragen heute `OPTIMIZER_HORIZON_HOURS=24` und
  `FORECAST_HORIZON_HOURS=24`. Drei Änderungen im gitops-Repo, in EINEM Commit:
  `apps/voltpilot/base/optimization/optimization.env` → `OPTIMIZER_HORIZON_HOURS`
  ENTFERNEN und `OPTIMIZER_HORIZON_SLOTS=192` setzen; derselbe Wert am
  `simulation`/Replan-Deployment (es nutzt `engine.plan_site`, ein halber Rollback
  spaltete sonst die Flotte); `apps/voltpilot/base/forecast/forecast.env` →
  `FORECAST_HORIZON_HOURS=48`. **Keine davon ist eine Startbedingung** - ohne sie
  läuft alles weiter (der Alias trägt 24 h und der Prognosedienst 24 h, das Fenster
  kürzt sich ehrlich darauf), das Inkrement wirkt dann nur noch nicht.

- **⚠ Warum der Terminalwert das nicht allein lösen kann** (der tiefere Befund): mit einer
  gepflegten Einspeisegrenze ist der Überschuss JENSEITS der Kappe kostenlos, der
  Lade-Anker von `derive_terminal_value` fällt damit legitim auf **0** - und ein
  24-h-Fenster hat dann buchstäblich nichts, WOFÜR es Energie halten könnte. Es entleert
  den Speicher in die Tageslast des Folgetags und steht abends leer da. Das 48-h-Fenster
  braucht den Terminalwert dafür gar nicht: der Abend liegt IM Horizont.

