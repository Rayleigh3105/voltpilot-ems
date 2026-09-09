## Optimierer ehrlich ohne Ladestand (P7): kein SoC ⇒ kein Speicher im Plan

Scout-Report `data/vp-deye-diybms-luecke-l5` §3.3 / Paket P7, Captain-Entscheid **E4=b**.

**Der Zustand davor.** Fehlte die frische `soc_pct`-Messung im Frischefenster
(`OPTIMIZER_SOC_MAX_AGE_MINUTES`, Vorgabe 120 min), sprang `inputs.gather_inputs` auf
`DEFAULT_SOC_PCT = 50` und plante daraus einen vollen Speicher-Fahrplan: Entladungen aus
einem Stand, den niemand kannte, eine SoC-Bahn im Diagramm, die niemand gemessen hatte,
und die geplante Ersparnis, die aus beidem folgte (`plannedSavingsTodayEur`, `savingsEur`).
An einer Anlage, die gar keinen echten Ladestand liefern KANN — ein Deye im
Spannungsmodus ohne BMS-SoC — war das keine Näherung, sondern eine Erfindung bis auf die
Kundenfläche.

**Die Regel jetzt.** Die HERKUNFT des Start-Ladestands ist ein Fakt des Laufs, aus einem
GESCHLOSSENEN Vokabular (`domain.SOC_SOURCES`, ein Wort außerhalb wird verworfen, nie
geraten — auch der CHECK in der Migration):

- `gemessen` — echte `soc_pct`-Telemetrie im Frischefenster. Normalfall, alles wie vor P7.
- `berechnet` — ein ABGELEITETER Stand. Der generische SoC-Baustein folgt in einem eigenen
  Paket; die Spalte nimmt ihn schon auf. **Planungstechnisch dem gemessenen
  gleichgestellt, aber gekennzeichnet**, damit eine Fläche die schwächere Herkunft benennen
  kann (`schedule.ts ladestandHerkunftNote`). Heute schreibt ihn niemand.
- `unbekannt` — kein Ladestand. **Der einzige Zustand, der den Plan ändert.**

Bei `unbekannt` gilt, alles an EINEM Schalter (`OptimizationInput.soc_unbekannt`):
Lade-/Entladegrenzen 0 (dieselbe BOUND wie `battery_held`, also KNOWN_CONSTRAINTS und
Golden-Suite unberührt) · keine Nacht-Wertfunktion · **keine der fünf
In-Slot-Vollmachten** (`cover_load_from_battery`, `unplanned_load_discharge`,
`charge_surplus_to_battery`, `limit_discharge_to_load`, `charge_from_surplus_only`) —
sonst wäre „Ruhe" keine Ruhe, denn das sind VOLLMACHTEN gegen gemessene Werte, nicht
Sollwerte, und `unplanned_load_discharge` zielt ausdrücklich auf einen RUHENDEN Slot ·
keine Messlatte (`stur_cost_eur`) · **kein v2-Schattenplan** (`engine._shadow_publish_v2`
steigt aus, sonst entstünde die Erfindung eine Etage tiefer). Der `initial_soc_kwh` ist
dann ein reiner MODELL-PLATZHALTER (der technische Boden), der den Solver nie verlässt.

**Die Anlage wird NICHT übersprungen.** Abregelung, Einspeisegrenze, §14a und die
Prognose-Sicht bleiben ein echter Plan — nur ohne Speicher.

**Wie die NULLen bis in die Fläche reisen** (das Elegante daran: es musste keine einzige
Summenformel angefasst werden). Ein Ruhe-Lauf schreibt `schedule.soc_pct = NULL` (es gibt
keine geplante Bahn) und `schedule.baseline_cost_eur = NULL` (ohne geplanten Speicher gibt
es keine Referenz, gegen die sich eine Ersparnis messen ließe; eine 0,00 € wäre
„geplant und nichts wert" statt „gar nicht geplant"). Jeder Ersparnis-Leser filtert seit je
auf `baseline_cost_eur IS NOT NULL` — `HistoryRepository.plannedSavings`,
`OverviewRepository`, Portal `schedule.ts plannedDayCosts`. Einzige Ausnahme war
`ScheduleRepository.latestForSite`/`dayAsPlanned`, die ein NULL per `nz()` in eine 0
verwandelten; sie teilen sich jetzt `ScheduleRepository.plannedSavings(slots)` mit
derselben Semantik.

**Der Grund ist EXPORTIERT, nicht erraten** (die Erklärbarkeits-Hausregel): `soc_source`
ist ein RUN-Fakt, je Slot-Zeile wiederholt wie `terminal_value_eur_per_kwh`
(Migration `V20260910000000`), reist als `SchedulePlanDto.socSource` und trägt den
Fahrplan-Satz `schedule.ts KEIN_LADESTAND_NOTE`. **NULL = Lauf vor der Spalte und wird wie
`gemessen` gelesen, NIE wie `unbekannt`** — sonst behauptete jeder Alt-Lauf rückwirkend,
er habe ohne Ladestand geplant. Der Tages-Splice trägt es ebenfalls null (aus vielen
Läufen genäht, keine EINE Herkunft).

**Der MQTT-Fahrplan-Kontrakt ist UNBERÜHRT.** Die Box bekommt einen Ruhe-Plan als das, was
er ist — lauter `battery_setpoint_kw = 0` und keine optionale Vollmacht.

**Notausgang:** `OPTIMIZER_REQUIRE_MEASURED_SOC` (Vorgabe AN, Hausregel). AUS stellt den
dokumentierten Vor-P7-Zustand samt Erfindung wieder her — nur für den Fall, dass eine
kaputte Telemetrie-Spalte sonst eine ganze Flotte stilllegt.

Tests: `services/optimization/tests/test_soc_source.py` (beide Richtungen — die neue
Ehrlichkeit UND die unveränderte Normalität, damit keine Zusicherung leerläuft),
`tests/test_freshness.py`, Portal `schedule.test.ts` + `pages/FahrplanSection.test.tsx`.
