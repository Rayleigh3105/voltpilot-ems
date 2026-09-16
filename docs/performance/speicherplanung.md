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
