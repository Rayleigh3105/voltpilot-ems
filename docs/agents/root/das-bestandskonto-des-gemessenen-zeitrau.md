# Das BESTANDSKONTO des gemessenen Zeitraums (die FK2-Gutschrift auf der Erlöse-Seite)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 65).


Diagnose `data/vp-tagesbild-minus-f3` §6 (Live-Fall Pilsting/Herzogau, 21.08.2026 12:19).
Rein ADDITIV: vier nullable DTO-Felder, kein Schema, keine Migration — `savedEur`, die
Baseline und der Optimierer sind UNANGETASTET.

- **Der behobene Befund.** `savedEur` ist eine ZAHLUNGSBILANZ ohne Bestandskonto: sie
  bewertet jede Viertelstunde nur nach dem, was über den Netzanschluss GEFLOSSEN ist —
  eine in den Speicher gewanderte kWh zählt darin als entgangener Einspeise-Erlös, und ihr
  Gegenwert (der Abend) existiert mittags noch nicht. Über einem ökonomisch einwandfreien
  Plan stand deshalb „−4,69 €", während ≈ 44 kWh im Speicher lagen. Der Juli-Fix FK2
  (`ScheduleRepository.bankedValue`, PR #144) rechnet genau diese Gutschrift — aber nur für
  den PLAN auf der Fahrplan-Seite; die Erlöse-Welt und das Tagesbild hatten ihn NIE.
- **⚠ DIE LEITENTSCHEIDUNG: der Bestand geht NIE in `savedEur` ein.** Die gemessene Kasse
  bleibt die gemessene Kasse; der Bestand ist ein ZWEITER, als „nach dem Plan bewertet"
  beschrifteter Posten DANEBEN. Ihn hineinzurechnen ergäbe zwei Geldwahrheiten über dieselbe
  Zahl — dieselbe Falle, die `tagesbild.ts` bei der Geisterkurve schon einmal ausdrücklich
  vermieden hat.
- **Vier additive Felder auf `SiteEarningsDto`** (`GET /api/v1/sites/{id}/earnings`, in
  `openapi.yaml`): `speicherDeltaKwh` (ΔLadestand × Kapazität, + gespeichert / − entnommen),
  `speicherWertCtKwh` (λ), `speicherWertEur` und `speicherWertBasis` (`plan`|`terminal` —
  damit die Fläche sagen kann, WOMIT bewertet wurde). Der mandantenweite `/api/v1/earnings`
  ist bewusst UNBERÜHRT (er beantwortet eine Portfolio-Frage; der Bestand gehört EINER Anlage).
- **⚠ Die Bewertung ist λ (`schedule.stored_value_ct_kwh`), und zwar bewusst** — der vom
  Optimierer selbst persistierte Wert einer GESPEICHERTEN kWh (Verluste + Verschleiß sind
  darin schon enthalten, also nie ein zweites η). Zum Tarif oder zum Abendpreis zu bewerten
  erfände eine Verwendung, die der Plan nicht garantiert. Rückfall ist der Terminalwert des
  Laufs (`terminal_value_eur_per_kwh`, die FK2-Präzedenz); ohne beides bleibt die Bewertung
  NULL und die Fläche zeigt nur die gemessenen kWh.
- **Die reine Hälfte ist `repo/SpeicherBank`** (Docker-frei geprüft, das
  `MeasuredSlots`/`Tagesprotokoll`/`FleetPflege`-Muster); `EarningsRepository.storageBank`
  ist die SQL-Hälfte — drei schmale Abfragen, alle RLS-gefenced. **Ohne primären Speicher
  läuft keine einzige davon** (ein Frühausstieg nach der Kapazitätsabfrage).
- **⚠ Der Anker ist `min(to, jetzt)`:** solange der Zeitraum LÄUFT, ist der Bestand der von
  JETZT (sonst hinkte die Zeile dem kWh-Satz daneben hinterher); ein abgeschlossener
  Zeitraum endet an seiner letzten Viertelstunde. Am laufenden Zeitraum gewinnt deshalb das
  ROHE Telemetrie-Sample (§7.1 „dieselbe Quelle wie der kWh-Satz"), der Rollup-Stand
  (`telemetry_rollup_15m.soc_last_pct`) ist nur der Rückfall — er hinkt bis zu 15 Minuten.
- **⚠ Der Anfangsbestand ist der letzte Eimer VOR dem Fenster, nie der erste darin** — der
  erste im Fenster steht schon eine Viertelstunde nach Beginn und trüge die erste Ladung
  bereits in sich. Drei Suchfenster begrenzen die Abfragen und sind zugleich
  Ehrlichkeitsregeln: 7 Tage für den Anfangsbestand, 2 Stunden für das rohe Sample, 6 Stunden
  für λ (ein λ von gestern bewertete den Bestand von heute mit dem Preisbild von gestern).
  `range=all` hat per Konstruktion keinen Anfangsbestand und liefert deshalb ehrlich `null`.
- **Beide Vorzeichen werden gezeigt** (der FK2-Wortlaut): positiv = in den Folgetag
  gespeichert, negativ = aus dem Vortag entnommen. Ein Zeitraum, der die Bank des Vortags
  VERBRAUCHT, überclaimt sonst.
- **Beweise:** rein `SpeicherBankTest` (8: der Live-Fall 24 % → 92 % an 65 kWh mit λ 18,9 ct
  ⇒ 44,2 kWh ⇒ +8,35 €, die Auflösung mit negativem Vorzeichen, der leere Speicher am
  Tagesende als GEMESSENE Null, der Terminal-Rückfall, „λ schlägt den Terminalwert", ohne
  Bewertung nur die kWh, ohne Ladestand gar nichts) · Testcontainers
  `PortalApiTest.siteEarningsCarryTheStorageBankOfTheMeasuredDay` (echte DB: der abgeschlossene
  Tag mit den drei λ-Lockvögeln — älterer Slot, älterer Lauf, Slot NACH dem bewerteten
  Moment —, der FK2-Rückfall mit negativem Delta, der Vorrang des rohen Samples am laufenden
  Tag, und vier ehrliche Nullen ohne Speicher). Portal-Seite in `frontend/portal/AGENTS.md`.

