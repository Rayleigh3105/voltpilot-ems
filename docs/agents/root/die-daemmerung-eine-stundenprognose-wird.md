# Die DÄMMERUNG: eine Stundenprognose wird sonnenstandsgerecht auf Viertelstunden verteilt

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 76).


Live-Fall Pilsting/Herzogau, 28.08.2026 19:37 Uhr (Box `edge-45gz7da`). Der Plan von 19:30 Uhr
sah für 19:45 einen PV-ÜBERSCHUSS von 3,04 kW; real lieferte die 100-kWp-Anlage 1,3 kW gegen ein
2,7-kW-Haus, die Box kaufte 1,4 kW für 25 ct, und der Speicher stand auf 92 %. Der Fahrplan war
ökonomisch einwandfrei — seine EINGABE war es nicht. Alles hier ist ADDITIV; die Tages-Energie einer
Prognose ändert sich um kein Wh (in `test_solar`/`test_openmeteo` festgenagelt).

- **⚠ EIN STUNDENWERT VON OPEN-METEO BESCHREIBT DIE VORANGEGANGENE STUNDE.** Der Wert mit der
  Beschriftung `T` ist das Mittel über `[T−1h, T)` — dokumentiert UND an der API nachgemessen: holt
  man denselben Tag als `minutely_15` und mittelt die vier Viertelstunden von `[T−1h, T)`, kommt zu
  JEDER Tagesstunde auf die Ziffer der Stundenwert bei `T` heraus, während die FOLGENDE Stunde nie
  passt (die Tabelle steht in `services/forecast/tests/fixtures/README-pilsting.md`). Der Adapter las
  bis hierher die Beschriftung `floor(t)` und servierte damit ein Fenster, dessen MITTE 30 bis 105
  Minuten in der VERGANGENHEIT liegt — **morgens systematisch zu niedrig, abends zu hoch.** Es ist
  ausdrücklich KEIN Zeitzonen-Fehler (`timezone=UTC` wird angefordert und `ensure_utc` überall
  angewandt) — es ist die Beschriftungs-Konvention, und `OpenMeteoWeatherProvider.HOURLY_MEAN_COVERS`
  ist der eine Ort, an dem sie lebt.
- **⚠ Ein flacher Stundenwert KANN NICHT FALLEN.** Die letzte Viertelstunde vor Sonnenuntergang erbte
  damit den Sonnenschein der ersten. Verteilt wird jetzt nach dem Anteil der Viertelstunde an der
  CLEAR-SKY-Energie der Stunde (`solar.clear_sky_ghi_mean`). Weil der Anteil ein Verhältnis von
  MITTELN ist, mitteln die vier Viertelstunden exakt auf den Stundenwert zurück — **die Verteilung
  verschiebt Energie innerhalb der Stunde und erzeugt oder vernichtet keine** —, und eine
  Viertelstunde mit der Sonne unter dem Horizont bekommt exakt 0. Der Strahlungsanteil trägt seine
  EIGENE Form (`solar.clear_sky_dni`): DNI fällt bei Sonnenuntergang viel langsamer als GHI.
- **⚠ `poa_irradiance` rekonstruiert den Strahl als `ghi / cos(zenit)` — und das EXPLODIERT bei
  tiefer Sonne.** Bei 1,9° Sonnenhöhe werden aus 6 W/m² GHI ein 156 W/m² „Strahl", und eine geneigte
  Fläche darauf scheint Kilowatt zu machen. **Jede Clear-Sky-HÜLLE begrenzt den Strahl deshalb mit
  `clear_sky_dni` (Luftmassen-Modell), nie mit dem Rückfall der Transposition.** Wer eine neue
  physikalische Obergrenze baut, fällt sonst in genau diese Falle.
- **Der Clear-Sky-DECKEL (`voltpilot_forecast/pvceiling.py`) ist der strukturelle Rückhalt.** Auf
  einer korrekt ausgerichteten physikalischen Prognose ist er per Konstruktion ein **No-op** (echte
  Einstrahlung übersteigt durch dieselbe Geometrie nie die Clear-Sky-Einstrahlung), er greift also
  ausschließlich dort, wo die Einstrahlung eines Slots nicht zu dessen Sonne gehört — und er ist die
  **EINZIGE** physikalische Schranke des Schatten-Kandidaten `pv-residual-xgb`, dessen
  `physisch + Residuum` vorher nur auf die Nennleistung geklemmt war und nach Sonnenuntergang
  Erzeugung erfinden durfte. Zwei Regeln halten ihn davon ab, je echte Erzeugung zu kappen: der
  Strahl kommt aus dem Luftmassen-Modell, und er ist **nie enger als eine waagerechte Fläche** (eine
  Ost/West-Anlage mit der DACH-Vorgabe Süd/30° wird nicht für unsere Aktenlage bestraft).
  Not-Aus `VOLTPILOT_PV_CLEAR_SKY_CEILING_ENABLED`, Spielraum `VOLTPILOT_PV_CLEAR_SKY_HEADROOM` (1,25).
- **⚠ `forecast_accuracy` bewertet ganze BERLINER TAGE** — beide Fehler waren darin unsichtbar, weil
  sich Morgen (zu niedrig) und Abend (zu hoch) über den Tag fast aufheben. Gemessen an den eigenen
  Viertelstunden der Anlage: Dämmerung 19–20 Uhr Bias **+4,17 → +0,04 kW**, Morgen 05–09 Uhr
  **−2,99 → −0,02 kW**, ganzer Tag MAE **4,87 → 1,78 kW**, Tages-Energie 296 → 286 kWh = exakt die
  Referenz. **Wer diese Fehlerklasse sucht, misst in BÄNDERN, nicht in Tagen.**
- **⚠ WER „WO ENDET DAS ECHTE WETTER?" FRAGT, FRAGT MIT `hour_label_for` — sonst antworten die
  zwei Hälften verschieden.** `forecast_collect.pv_horizon` (48-h-Fenster, PR 547) entscheidet die
  ABDECKUNG, `OpenMeteoWeatherProvider` liefert die WERTE; entscheidet die eine mit `floor(t)`,
  während die andere `floor(t)+1h` liest, schreibt der Sammler für die LETZTE Stunde des Feeds
  erfundene Nullen — genau die synthetischen Werte, für deren Verhinderung `pv_horizon` gebaut
  wurde, und über die der Optimierer sein Fenster dann verlängert. Beim Zusammenführen der beiden
  Änderungen reproduziert (Feed bis 13:00 ⇒ `pv_horizon` erlaubte 15 Slots, der Anbieter beantwortete
  drei davon mit 0 W/m²); gepinnt und mutationsgeprüft von
  `test_pv_horizon_agrees_with_what_the_provider_can_answer`.
- **Die zweite Hälfte ist der Optimierer:** der LAUFENDE Slot wird aus der Telemetrie beantwortet
  (`voltpilot_optimization/pv_nowcast.py`), nicht aus einer Prognose — der Spiegel der seit P1/P2
  bestehenden Last-Korrektur, und die Lücke, die der Verhältnis-Anker der MORGENPROGNOSE per Design
  nicht schließen kann (er liest ABGESCHLOSSENE Slots und sieht die Wolke von vor einer Minute nicht).
  Reihenfolge im `gather_inputs`: Prognose → Verhältnis-Anker → **Messwert-Nowcast** → Nachtboden,
  und **der Nachtboden behält das letzte Wort** (ein Messwert schlägt keine Physik). Fail-soft und
  Vorgabe AN wie der Anker; Knöpfe
  `OPTIMIZER_PV_NOWCAST_{ENABLED,DECAY_SLOTS,MAX_AGE_SECONDS,LOOKBACK_SECONDS}`
  (an, 2 Slots, 30 s, 120 s).
- **⚠ DER MESSWERT IST EIN FENSTER-MITTEL, NIE EIN EINZELNES SAMPLE** (Herzogau 29.08.2026, Scout
  `vp-herzogau-einspeisung-statt-laden-h3`). Die erste Fassung zog über `_fresh_measurement` das
  NEUESTE Sample — bei ~180 Samples je Viertelstunde entschied damit der Zeitpunkt des Neuplans
  allein, welcher Wert für den ganzen Slot spricht. Am 29.08. fiel er in eine sechsminütige Wolke
  (PV 8,88 gegen 15,33 kW Haus), der Lauf befahl eine **ENTLADUNG von −7,17 kW**, während 23 kW ins
  Netz gingen. Dieselben 24 Messungen GEMITTELT sagen 17,04 kW = Überschuss = laden. Gelesen wird
  jetzt über `_recent_pv_samples` (der Zwilling von `_recent_load_samples`, gleiche Spaltenform,
  gleiche Frische-Regel auf dem NEUESTEN Sample) plus `pv_nowcast.window_mean`.
  **⚠ Ausdrücklich das ARITHMETISCHE Mittel, NICHT die EWMA des Last-Pfads:** mit α = 0,35
  konvergiert die auf die letzten Sekunden und erbt denselben Münzwurf (an denselben Daten gemessen:
  Einzel 8,88 · EWMA 9,30 · Mittel 17,04). Bei ruhiger Sonne liegen alle drei innerhalb von 0,4 kW —
  das Mittel kostet also nichts, wo das Einzel-Sample schon richtig lag. Es ist dieselbe Hausregel,
  die für den Verhältnis-Anker längst aufgeschrieben ist („ein Einzel-Sample wäre ein Zufallsgriff
  aus der Viertelstunde").
- **⚠ AUF EINEM ABGEREGELTEN SLOT DARF DER MESSWERT NUR HEBEN, NIE SENKEN** (`raise_only`, Glied 1b
  desselben Vorfalls). Dort ist die Messung die AUSGANGSLEISTUNG unter UNSERER EIGENEN Kappe, also
  ein BODEN des Potenzials und nicht das Potenzial: sie als Potenzial zu lesen schließt einen
  Regelkreis — kappen → weniger messen → weniger planen → Kappe fällt weg → exportieren (am 29.08.
  um 10:47 real: 16 kW ins Netz bei negativem Preis). Eine Messung ÜBER der Prognose bleibt ein
  Beweis und wird angewandt; eine darunter beweist nichts. **„Messung + Kappen-Spielraum" wurde
  verworfen** — niemand kennt den Spielraum, und eine erfundene Zahl ist schlechter als die
  Prognose. Die Asymmetrie ist in der offen gelassenen Richtung sicher: eine zu OPTIMISTISCHE
  PV-Eingabe endet in einem Ladebefehl, den die BOX längst auf den gemessenen Überschuss klemmt
  (`charge_from_surplus_only`, Lastfolger) — für die zu pessimistische gibt es keinen Fänger.
- **⚠ Die Abregel-Frage wird aus dem EIGENEN Plan beantwortet** (`_running_slot_curtailed`: der
  jüngste Lauf mit `generated_at <= now`, dessen Slot über `now`, `curtail_kw > 0`) — nicht aus
  `device_curtailment_status`. Dessen `applied_cap_kw` ist die SUMME der Kappen der ABREGELBAREN
  Einheiten (Herzogau: zwei Fronius zu je 11,97 kW), die Messung dagegen die ganze Anlage samt des
  nicht abregelbaren Deye-Anteils — die beiden zu vergleichen ist ein Kategorienfehler. Der Plan ist
  außerdem die URSACHE jeder Kappe, also eine Runde FRÜHER verfügbar und von einem veralteten
  Herzschlag unabhängig. Unbeantwortbar heißt `False` = nicht abgeregelt = das zweiseitige Verhalten
  von vorher, kostet also nie einen Plan.
- **⚠ `_fresh_measurement` nimmt AUSDRÜCKLICH KEIN `pv_power_kw` mehr** (die Spalten-Whitelist ist
  ein hartes `raise`, kein `assert` — S15): der Einzelwert-Griff auf die PV IST der Fehler oben, und
  ein Eintrag in der Whitelist wäre die Einladung, ihn wieder einzuführen. Ein Aufrufer, der
  `gather_inputs` fälscht, braucht für die PV eine Antwort auf die FENSTER-Abfrage
  (`SELECT time, pv_power_kw … time >= … time <= …`) und für den Abregel-Zweig eine auf
  `FROM schedule` — siehe die Attrappe in `tests/test_pv_nowcast.py`.
- **Beweise:** rein `services/forecast/tests/test_solar.py` (Luftmassen-Strahl, Energie-Erhaltung der
  Form, monotoner Abfall, Rand-Fälle) · `test_pvceiling.py` (9) · `test_dusk_forecast.py` (10, gegen
  die VERBATIM aufgezeichnete Antwort `fixtures/open_meteo_pilsting_2026-08-28.json`: der Deckel, der
  Slot 19:45, exakt 0 nach Sonnenuntergang, Monotonie, beide Richtungen des Versatzes, naiv==UTC) ·
  `test_openmeteo.py` (Ausrichtung, Erhaltung, Stunden-Anfrage bleibt ungeformt) · `test_ml.py`
  („ein Residuum überlebt den Sonnenuntergang nicht", nicht-vakuum) · Optimierer
  `tests/test_pv_nowcast.py` (17: die reine Regel, die `gather_inputs`-Verdrahtung inkl. veraltet /
  kein Wert / Not-Aus / kaputter Knopf / Nachtboden, und der Vorfall durch den ECHTEN Solver — 1,3 kW
  gemessen gegen 2,7 kW Haus ⇒ −1,4 kW Entladung, Netz 0,0, `cover_load_from_battery`, mit dem
  Phantom-Überschuss als nicht-vakuumem Gegenstück).
- **Ops:** keine neue Pflicht-Variable (alle Knöpfe haben Vorgaben, alle Not-Aus-Schalter sind
  Vorgabe AN — die dokumentierte gitops-Falle). Deploy = Cloud-Images (`forecast` + `optimization`);
  **kein Edge-Release nötig** — der eingefrorene MQTT-Fahrplan-Kontrakt ist unberührt.

