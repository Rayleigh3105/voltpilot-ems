# UEMS-Speicher-Wächter (AP-07 IP-16)

- `DbStorageMetricsCollector` exponiert die täglich gecachten Reihen
  `voltpilot_db_table_bytes`, `…_plan_fraction` und `…_plan_warning` je interner
  Mandantenkennung und Klasse (`roh`, `vm`, `tag`, `ereignis`). Keine
  Kundennamen als Labels.
- `DbHealthMetricsRepository.tenantTableSizes()` läuft ausschließlich über die
  BYPASSRLS-Admin-Datenquelle außerhalb eines Kundenkontexts. Sie verteilt die
  echte physische Hypertable-Größe proportional zu `pg_column_size`; Scrapes
  führen kein SQL aus.
- Planwerte und 70-%-Grenzen: `docs/performance/speicherplanung.md`. Der
  bestehende 0,5-TB-Flottenalarm über `sum(voltpilot_db_total_bytes)` bleibt
  getrennt und unverändert.
- Die E7-B-Messung läuft nur lokal und synthetisch über
  `docs/performance/measure-vm-compression.sh`; Protokoll:
  `docs/performance/vm-kompression-2026-09-17.md`. Nie Zugangsdaten einer
  Produktion oder eines geteilten Dev-Stacks verwenden.
