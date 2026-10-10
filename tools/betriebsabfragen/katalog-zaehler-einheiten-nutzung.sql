-- Betriebsabfrage: Hängen die Zähler-Messpunkte des Katalogs, für die die Cloud keine Zahl in einem
-- Mengen-Satz nennen konnte (Befund PR 726: 41 ohne Einheit, 25 in VAh, 4 in „0,1 kWh“, 1 in Wmin),
-- an einer echten Anlage — also: hat ein Kunde sie ausgewählt, kommen Messwerte, speisen sie eine
-- Messstelle?
--
-- Nur lesend. Ausführen mit einer Rolle, die RLS umgeht (die Tabellen tragen FORCE ROW LEVEL SECURITY),
-- z. B. psql als Verwaltungsrolle in `BEGIN READ ONLY; … ROLLBACK;`. Die Messwerte werden über die
-- letzten 90 Tage gezählt (Rohdaten-Frist). Ein Messpunkt ist nur „in Benutzung“, wenn ihn jemand
-- AUSGEWÄHLT hat: es gibt keine automatische Auswahl, der eingebaute Wechselrichter-Weg liest über
-- die Telemetrie, nicht über diese Schlüssel.
--
-- Die Schlüssel sind die Vorlagen des Katalogs 2026.09.11.1; gespeichert stehen Vorlage (Auswahl,
-- Quellenbindung) oder konkreter Schlüssel (Messwerte, z. B. `…unit[wh]`) — darum ein Muster je Vorlage.
-- Neu erzeugen: aus `catalog/measurement-points` (Liste `ZAEHLER_OHNE_ANZEIGE_EINHEIT`). Geprüft von
-- `KatalogEinheitenNutzungAbfrageTest` gegen die Entwicklungs-DB (Migrationen + db/dev).
WITH katalog(gruppe, point_key, muster) AS (
    VALUES
        ('ohne Einheit', 'deye.hybrid_3p.battery-1.battery-1-cycles', '^deye\.hybrid_3p\.battery\-1\.battery\-1\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-10.battery-10-cycles', '^deye\.hybrid_3p\.battery\-10\.battery\-10\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-11.battery-11-cycles', '^deye\.hybrid_3p\.battery\-11\.battery\-11\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-12.battery-12-cycles', '^deye\.hybrid_3p\.battery\-12\.battery\-12\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-13.battery-13-cycles', '^deye\.hybrid_3p\.battery\-13\.battery\-13\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-14.battery-14-cycles', '^deye\.hybrid_3p\.battery\-14\.battery\-14\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-15.battery-15-cycles', '^deye\.hybrid_3p\.battery\-15\.battery\-15\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-16.battery-16-cycles', '^deye\.hybrid_3p\.battery\-16\.battery\-16\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-17.battery-17-cycles', '^deye\.hybrid_3p\.battery\-17\.battery\-17\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-18.battery-18-cycles', '^deye\.hybrid_3p\.battery\-18\.battery\-18\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-19.battery-19-cycles', '^deye\.hybrid_3p\.battery\-19\.battery\-19\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-2.battery-2-cycles', '^deye\.hybrid_3p\.battery\-2\.battery\-2\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-20.battery-20-cycles', '^deye\.hybrid_3p\.battery\-20\.battery\-20\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-3.battery-3-cycles', '^deye\.hybrid_3p\.battery\-3\.battery\-3\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-4.battery-4-cycles', '^deye\.hybrid_3p\.battery\-4\.battery\-4\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-5.battery-5-cycles', '^deye\.hybrid_3p\.battery\-5\.battery\-5\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-6.battery-6-cycles', '^deye\.hybrid_3p\.battery\-6\.battery\-6\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-7.battery-7-cycles', '^deye\.hybrid_3p\.battery\-7\.battery\-7\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-8.battery-8-cycles', '^deye\.hybrid_3p\.battery\-8\.battery\-8\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.battery-9.battery-9-cycles', '^deye\.hybrid_3p\.battery\-9\.battery\-9\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.meter.today-battery-life-cycles', '^deye\.hybrid_3p\.meter\.today\-battery\-life\-cycles$'),
        ('ohne Einheit', 'deye.hybrid_3p.meter.total-battery-life-cycles', '^deye\.hybrid_3p\.meter\.total\-battery\-life\-cycles$'),
        ('ohne Einheit', 'goe.api_v2.eto', '^goe\.api_v2\.eto$'),
        ('ohne Einheit', 'goe.api_v2.eto_mid', '^goe\.api_v2\.eto_mid$'),
        ('ohne Einheit', 'goe.api_v2.wh', '^goe\.api_v2\.wh$'),
        ('ohne Einheit', 'goe.api_v2.wh_mid', '^goe\.api_v2\.wh_mid$'),
        ('ohne Einheit', 'goe.api_v2.whb', '^goe\.api_v2\.whb$'),
        ('ohne Einheit', 'goe.api_v2.whg', '^goe\.api_v2\.whg$'),
        ('ohne Einheit', 'goe.api_v2.who', '^goe\.api_v2\.who$'),
        ('ohne Einheit', 'goe.api_v2.whs', '^goe\.api_v2\.whs$'),
        ('ohne Einheit', 'ocpp.1_6.metervalues.energy.active.export.register.context[*].format[*].phase[*].location[*].unit[*]', '^ocpp\.1_6\.metervalues\.energy\.active\.export\.register\.context\[[^]]*\]\.format\[[^]]*\]\.phase\[[^]]*\]\.location\[[^]]*\]\.unit\[[^]]*\]$'),
        ('ohne Einheit', 'ocpp.1_6.metervalues.energy.active.import.register.context[*].format[*].phase[*].location[*].unit[*]', '^ocpp\.1_6\.metervalues\.energy\.active\.import\.register\.context\[[^]]*\]\.format\[[^]]*\]\.phase\[[^]]*\]\.location\[[^]]*\]\.unit\[[^]]*\]$'),
        ('ohne Einheit', 'ocpp.1_6.metervalues.energy.reactive.export.register.context[*].format[*].phase[*].location[*].unit[*]', '^ocpp\.1_6\.metervalues\.energy\.reactive\.export\.register\.context\[[^]]*\]\.format\[[^]]*\]\.phase\[[^]]*\]\.location\[[^]]*\]\.unit\[[^]]*\]$'),
        ('ohne Einheit', 'ocpp.1_6.metervalues.energy.reactive.import.register.context[*].format[*].phase[*].location[*].unit[*]', '^ocpp\.1_6\.metervalues\.energy\.reactive\.import\.register\.context\[[^]]*\]\.format\[[^]]*\]\.phase\[[^]]*\]\.location\[[^]]*\]\.unit\[[^]]*\]$'),
        ('ohne Einheit', 'shelly.gen1.input[*].inputs[*].event_cnt', '^shelly\.gen1\.input\[[^]]*\]\.inputs\[[^]]*\]\.event_cnt$'),
        ('ohne Einheit', 'shelly.gen1.system.cfg_changed_cnt', '^shelly\.gen1\.system\.cfg_changed_cnt$'),
        ('ohne Einheit', 'shelly.gen1.system.serial', '^shelly\.gen1\.system\.serial$'),
        ('ohne Einheit', 'shelly.gen2plus.sys.cfg_rev', '^shelly\.gen2plus\.sys\.cfg_rev$'),
        ('ohne Einheit', 'shelly.gen2plus.sys.kvs_rev', '^shelly\.gen2plus\.sys\.kvs_rev$'),
        ('ohne Einheit', 'shelly.gen2plus.sys.schedule_rev', '^shelly\.gen2plus\.sys\.schedule_rev$'),
        ('ohne Einheit', 'shelly.gen2plus.sys.webhook_rev', '^shelly\.gen2plus\.sys\.webhook_rev$'),
        ('VAh', 'sunspec.model_122.actvah', '^sunspec\.model_122\.actvah$'),
        ('VAh', 'sunspec.model_201.totvahexp', '^sunspec\.model_201\.totvahexp$'),
        ('VAh', 'sunspec.model_201.totvahexppha', '^sunspec\.model_201\.totvahexppha$'),
        ('VAh', 'sunspec.model_201.totvahexpphb', '^sunspec\.model_201\.totvahexpphb$'),
        ('VAh', 'sunspec.model_201.totvahexpphc', '^sunspec\.model_201\.totvahexpphc$'),
        ('VAh', 'sunspec.model_201.totvahimp', '^sunspec\.model_201\.totvahimp$'),
        ('VAh', 'sunspec.model_201.totvahimppha', '^sunspec\.model_201\.totvahimppha$'),
        ('VAh', 'sunspec.model_201.totvahimpphb', '^sunspec\.model_201\.totvahimpphb$'),
        ('VAh', 'sunspec.model_201.totvahimpphc', '^sunspec\.model_201\.totvahimpphc$'),
        ('VAh', 'sunspec.model_202.totvahexp', '^sunspec\.model_202\.totvahexp$'),
        ('VAh', 'sunspec.model_202.totvahexppha', '^sunspec\.model_202\.totvahexppha$'),
        ('VAh', 'sunspec.model_202.totvahexpphb', '^sunspec\.model_202\.totvahexpphb$'),
        ('VAh', 'sunspec.model_202.totvahexpphc', '^sunspec\.model_202\.totvahexpphc$'),
        ('VAh', 'sunspec.model_202.totvahimp', '^sunspec\.model_202\.totvahimp$'),
        ('VAh', 'sunspec.model_202.totvahimppha', '^sunspec\.model_202\.totvahimppha$'),
        ('VAh', 'sunspec.model_202.totvahimpphb', '^sunspec\.model_202\.totvahimpphb$'),
        ('VAh', 'sunspec.model_202.totvahimpphc', '^sunspec\.model_202\.totvahimpphc$'),
        ('VAh', 'sunspec.model_203.totvahexp', '^sunspec\.model_203\.totvahexp$'),
        ('VAh', 'sunspec.model_203.totvahexppha', '^sunspec\.model_203\.totvahexppha$'),
        ('VAh', 'sunspec.model_203.totvahexpphb', '^sunspec\.model_203\.totvahexpphb$'),
        ('VAh', 'sunspec.model_203.totvahexpphc', '^sunspec\.model_203\.totvahexpphc$'),
        ('VAh', 'sunspec.model_203.totvahimp', '^sunspec\.model_203\.totvahimp$'),
        ('VAh', 'sunspec.model_203.totvahimppha', '^sunspec\.model_203\.totvahimppha$'),
        ('VAh', 'sunspec.model_203.totvahimpphb', '^sunspec\.model_203\.totvahimpphb$'),
        ('VAh', 'sunspec.model_203.totvahimpphc', '^sunspec\.model_203\.totvahimpphc$'),
        ('0,1 kWh', 'kaco_http.energy-today', '^kaco_http\.energy\-today$'),
        ('0,1 kWh', 'kaco_http.energy-total', '^kaco_http\.energy\-total$'),
        ('0,1 kWh', 'kaco_http_hybrid.energy-today', '^kaco_http_hybrid\.energy\-today$'),
        ('0,1 kWh', 'kaco_http_hybrid.energy-total', '^kaco_http_hybrid\.energy\-total$'),
        ('Wmin', 'shelly.gen1.meter[*].meters[*].total', '^shelly\.gen1\.meter\[[^]]*\]\.meters\[[^]]*\]\.total$')
),
auswahl AS (
    SELECT k.gruppe, k.point_key, s.site_id
      FROM katalog k
      JOIN device_measurement_selection s ON s.point_key ~ k.muster AND s.enabled
),
messwerte AS (
    SELECT DISTINCT k.gruppe, k.point_key, m.site_id
      FROM katalog k
      JOIN device_measurement_sample m ON m.point_key ~ k.muster
     WHERE m.time > now() - interval '90 days'
),
quellen AS (
    SELECT k.gruppe, k.point_key, q.messstelle_id
      FROM katalog k
      JOIN messstelle_quelle q ON q.kanal ~ k.muster
     WHERE q.gueltig_bis IS NULL OR q.gueltig_bis > now()
)
SELECT g.gruppe,
       (SELECT count(*) FROM katalog k WHERE k.gruppe = g.gruppe)                          AS katalog_punkte,
       (SELECT count(DISTINCT point_key) FROM auswahl a WHERE a.gruppe = g.gruppe)         AS punkte_ausgewaehlt,
       (SELECT count(DISTINCT site_id) FROM auswahl a WHERE a.gruppe = g.gruppe)           AS anlagen_mit_auswahl,
       (SELECT count(DISTINCT point_key) FROM messwerte m WHERE m.gruppe = g.gruppe)       AS punkte_mit_messwerten_90d,
       (SELECT count(DISTINCT site_id) FROM messwerte m WHERE m.gruppe = g.gruppe)         AS anlagen_mit_messwerten_90d,
       (SELECT count(DISTINCT messstelle_id) FROM quellen q WHERE q.gruppe = g.gruppe)     AS messstellen_gespeist
  FROM (VALUES (1, 'ohne Einheit'), (2, 'VAh'), (3, '0,1 kWh'), (4, 'Wmin')) AS g(rang, gruppe)
 ORDER BY g.rang;
