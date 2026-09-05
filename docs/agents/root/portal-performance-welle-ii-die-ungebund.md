# Portal-Performance-Welle II: die UNGEBUNDENE Hypertable-Lesung (HAR-Befund 24.08.2026)

Ausgelagert aus `AGENTS.md` am 05.09.2026 (Abschnitt Nr. 107).


Die Fortsetzung des Abschnitts darüber, aus dem HAR-Export einer echten Kundenanlage
(Konto des Betreibers, Auswertung `data/vp-topology-langsam-q6/har-timings.txt`):
`/api/v1/sites/{id}/topology` brauchte **6,7 s Server-Zeit für 2,4 kB Antwort** und
gate-te damit die ganze dritte Ladewelle des Cockpits. **Alle drei Fixes sind reine
Anfrage-FORM - keine Migration, kein neuer Index, kein geändertes Prädikat, kein
geändertes Ergebnis.**

- **⚠ DIE FEHLERKLASSE, und sie ist die WICHTIGSTE Lehre dieser Runde: ein Prädikat
  auf einer Spalte, die NICHT die Partitionsspalte ist, begrenzt das ERGEBNIS, aber
  NICHT die gelesenen Chunks.** Ein Hypertable ist nach seiner Zeitspalte partitioniert;
  ein `WHERE generated_at >= …` auf `schedule` (partitioniert nach `time`), ein
  `max(received_at)` auf `telemetry` (partitioniert nach `time`) oder ein CTE über
  `forecast` ganz ohne Zeitbedingung steigen deshalb in **JEDEN Chunk** ab - die Kosten
  wachsen mit der AUFBEWAHRUNG, für immer, auch wenn die Antwort nur den neuesten Chunk
  braucht. Genau diese Begründung stand als Zusicherung im Javadoc von
  `OverviewRepository.lastPlanPerSite` („ohne Untergrenze wäre es ein Scan über die
  ganze Historie") und war FALSCH. **Wer eine Zeitgrenze als Kostenbremse verkauft,
  prüft, ob sie auf der Partitionsspalte sitzt.**
- **⚠ Die zweite Lehre: TimescaleDB 2.17 hat KEINEN SkipScan für ein MEHRSPALTIGES
  `DISTINCT ON`** (der einspaltige existiert seit 2.2; mehrspaltig kam erst 2.21). Ein
  `DISTINCT ON (entity_id, channel)` lässt sich mit KEINEM Index retten - es bleibt beim
  Lesen aller Zeilen. Die Rettung ist immer, jedem gesuchten Schlüssel seine EIGENE
  Gleichheitsbedingung zu geben (das B4-Muster des Abschnitts darüber).
- **T1 · `TopologyRepository.latestValues` liest je (Entität, Kanal) EINZELN.** Die alte
  Form las die GANZE telemetry_v2-Historie der Anlage und sortierte sie: auf einem
  prod-förmigen Klon (5,13 Mio Zeilen, 1,6 GB, 6 Chunks) **14,6 s, externe Merge-Sortierung
  341 MB, 4.092.635 gelesene Zeilen - um 5 zurückzugeben**. Der Dienst KONSUMIERTE davon
  ohnehin nur die Kanäle aus `capabilities.measure[]` und warf alles andere weg, also ist
  „frag nur nach den konsumierten Paaren" ergebnisgleich. Jedes Paar wird jetzt über den
  SCHON EXISTIERENDEN `uq_telemetry_v2_entity_channel_time` rückwärts geprüft und hält beim
  neuesten Chunk mit Treffer an: **0,95 ms**. **Bewusst KEIN neuer Index** - er brächte
  nichts Messbares und kostete Schreibverstärkung auf dem heissen Ingest-Pfad.
  `TopologyService.channelKeys` baut die Paarliste; **ihr Kanal-Filter MUSS identisch zum
  Render-Loop bleiben**, sonst verliert ein Kanal lautlos seinen Wert. Die Paare reisen als
  zwei parallele `text[]` durch `unnest`, die Anweisung hat also DREI Bind-Parameter
  unabhängig von der Anlagengrösse - eine feste SQL-Zeichenkette (der Statement-Cache des
  Treibers greift) und kein Weg in die Nähe der 65535-Parameter-Grenze.
- **T2 · `OverviewRepository.lastPlanPerSite` ist eine per-Anlage-LATERAL** (Prädikat
  unverändert): **335 ms → 9,0 ms**, 75.362 Buffer weg. Der grösste Einzelposten von
  `/overview`.
- **T3 · Das `latest_run`-CTE von `EarningsRepository.expectedMarketValue` ebenso**:
  **161 ms → 1,4 ms**, auf BEIDEN Erlös-Endpunkten (der Anlagen-Endpunkt rechnet es
  weiterhin flottenweit und wirft alles bis auf eine Anlage weg - eigene Folgearbeit).
- **⚠ Bei T2/T3 WANDERT die RLS-Fence** von `schedule` bzw. dem `forecast`-JOIN auf
  `site` - beide tragen dieselbe Mandanten-Policy (`forecast` trägt gar keine, dort WAR
  der Join schon die ganze Fence), also sieht der Aufrufer exakt dieselben Anlagen. Eine
  still weitende Fence wäre ein Mandanten-Leck, kein Perf-Gewinn: `HotReadRewriteEqualityTest`
  prüft deshalb JEDEN der drei Umbauten gegen die WÖRTLICH einkopierte alte Anweisung als
  Orakel, auf EINER Verbindung als RLS-gefencte App-Rolle mit gesetztem `app.tenant_id`
  (das `PriceSlotEqualityTest`-Muster; mutationsgeprüft in beide Richtungen).
- **Nachzug 31.08.2026 · die zwei vergessenen Zwillinge von T2** (Scout
  `vp-scale-readiness-p4` §3.2): `FleetMetricsRepository.lastPlanPerSite` (alle 60 s im
  Metrik-Sammler) und `AdminFleetRepository.lastPlanPerSite` (je Admin-Puls) trugen bis
  hierher NOCH die fleet-weite `GROUP BY site_id`-Form auf dem Nicht-Partitionsschlüssel
  `generated_at` - der T2-Fix war nur in `OverviewRepository` gelandet, und ihr Doc-Kommentar
  behauptete sogar „die Form von `OverviewRepository.lastPlanPerSite`" (die dort seit Welle II
  eine LATERAL ist). Beide sind jetzt dieselbe per-Anlage-LATERAL (**296 ms → 5 ms**, 59×,
  gemessen an 10,3 Mio Zeilen). **⚠ Anders als bei T2 wandert hier KEINE RLS-Fence:** beide
  Sammler laufen als BYPASSRLS-Rolle `voltpilot_admin` (kein `TenantContext`, cross-tenant per
  Konstruktion), es gibt also keinen Tenant-Qual, der die Planwahl kippen könnte - der Gewinn
  ist rein der SkipScan über `idx_schedule_site_generated`. Gleiches Orakel-Muster wie T2:
  `FleetLastPlanRewriteEqualityTest` fährt die WÖRTLICH einkopierte alte Anweisung als Orakel
  gegen ein echtes TimescaleDB, als `voltpilot_admin`, und beweist dabei die Cross-Tenant-Sicht
  (beide Mandanten in EINER Antwort).
- **Gemessen am prod-förmigen Klon** (3,3 Mio `telemetry`, 5,1 Mio `telemetry_v2`, 1,7 Mio
  `schedule`, 2,3 Mio `forecast`, je 28 Chunks), Endpunkt-Median von 5 warmen Läufen:
  `/topology` **12,64 s → 0,012 s (≈1000×)**, `/overview` 0,147 → 0,095 s, Anlagen-`/earnings`
  0,099 → 0,054 s, Mandanten-`/earnings` 0,167 → 0,125 s.
- **⚠ Das Labor der ersten Welle konnte das NICHT sehen** (`vp-cockpit-perf-p7` §U4 mass
  `/topology` mit 0,03 s): sein Klon hatte **null** `telemetry_v2`-Zeilen, und die anderen
  drei Befunde skalieren mit der Zahl der CHUNKS, also mit der Historien-LÄNGE, nicht mit
  der Zeilenzahl. **Wer einen Lesepfad hier misst, füllt beide Achsen** - Volumen UND
  Aufbewahrungszeitraum (Rezept: `data/vp-topology-langsam-q6`).
- **Bewusst NICHT gefixt, mit Zahlen** (dieselbe Klasse, aber entweder billig oder nur um
  den Preis einer Semantik-Änderung): `OverviewRepository.deviceStatsPerSite` liest
  `max(received_at)` je Gerät ohne jede Zeitgrenze über alle Chunks (12 ms Ausführung +
  54 ms PLANUNG bei 28 Chunks × 3 Geräten) - **jede Grenze würde `lastSeenAt` eines lange
  stummen Geräts zu `null` machen, was das Portal als „wartet auf erste Daten" liest**, also
  ein Produkt-Entscheid, kein Perf-Fix; `PeakShavingRepository` liest mit ~11,7-Jahres-Untergrenze
  und OHNE Obergrenze, zweimal je Anfrage (0,8 ms - `telemetry_rollup_15m` ist klein);
  und die Erlös-Endpunkte setzen 5-8 Anweisungen ab, die JEDE das `price_slot`-CTE
  einbetten (18-100 ms je) - das ist wiederholte Arbeit, keine ungebundene Lesung, und ein
  geteiltes CTE wäre ein Umbau der Geld-Mathematik.

