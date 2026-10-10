# Speicherplanung und Wächter

Stand: 17.09.2026. Quelle ist die reproduzierbare Rechnung `k_speicher.py`
aus AP-07, Szenario „100 Messstellen (1 300 Kanäle × 60 s; alle Kanäle in der
Zehn-Jahres-Klasse)“. Entschieden ist E7-A: RLS-Tabellen ohne Kompression.

| Klasse | Tabelle | Zeilen im eingeschwungenen Bestand | Plan je Mandant, unkomprimiert | Warnung ab 70 % |
|---|---|---:|---:|---:|
| `roh` | `device_measurement_sample` | 168 480 000 | 20 217 600 000 B | 14 152 320 000 B |
| `vm` | `messreihe_viertelstunde` | 455 894 400 | 109 414 656 000 B | 76 590 259 200 B |
| `tag` | `messreihe_tag` | 4 748 900 | 1 329 692 000 B | 930 784 400 B |
| `ereignis` | `messreihe_ereignis` | 1 095 900 | 350 688 000 B | 245 481 600 B |

**Das Richtungspaar der Viertelstunde kostet im Plan praktisch nichts** (`V20260918104000`,
`energie_positiv`/`energie_negativ`). Gerechnet, nicht geschätzt:

- **Solange beide NULL sind: 0 B je Zeile.** Eine NULL-Spalte belegt in PostgreSQL keinen Datenraum;
  sie wächst nur die Null-Bitmap. `messreihe_viertelstunde` geht von 47 auf 49 Spalten, die Bitmap
  also von 6 auf 7 Byte — und der Zeilenkopf ist in beiden Fällen `MAXALIGN(23 + Bitmap) = 32 B`.
  Die Zeile wird nicht um ein einziges Byte länger. Das gilt für den gesamten Bestand, denn die
  Migration füllt nichts nach.
- **Gefüllt: ~24 B je Zeile, aber nur an 54 von 2 395 Katalogpunkten (2,3 %)** — nur Kanäle mit zwei
  Flussrichtungen, deren Menge aus integrierter Leistung entsteht. Im Szenario oben sind das
  ≈ 0,25 GB je Mandant im Zehn-Jahres-Bestand, **0,23 % des `vm`-Plans**. Die Plan- und
  Warnschwellen bleiben darum unverändert; die 70-%-Warnung verschiebt sich nicht messbar.

Die Werte stehen für die Laufzeit identisch in `DbHealthMetrics.STORAGE_PLAN`.
`voltpilot_db_table_bytes{class,tenant}` ordnet die echte physische
Hypertable-Größe proportional zur logischen Zeilengröße einer internen
Mandantenkennung zu. Kundennamen werden nicht exportiert. Die Zuordnung wird
standardmäßig einmal täglich durch die Admin-Datenquelle berechnet und im
`DbStorageMetricsCollector` gecacht; ein Prometheus-Scrape führt keine
Datenbankabfrage aus.

`voltpilot_db_table_plan_fraction{class,tenant}` nennt den Anteil am Plan.
`voltpilot_db_table_plan_warning{class,tenant}` springt ab einschließlich 70 %
auf `1`. Der bestehende Flottenalarm bleibt davon getrennt:
`sum(voltpilot_db_total_bytes)` alarmiert bei 0,5 TB tatsächlicher
Datenbankbelegung.
