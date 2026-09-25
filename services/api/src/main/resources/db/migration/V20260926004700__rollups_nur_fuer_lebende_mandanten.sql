-- =============================================================================
-- V20260926004700 - Die Verdichtungen schreiben nur für Mandanten, die es beim
-- Schreiben noch gibt (UEMS AP-20, Folge zu IP-18, E10 = A; Befund 3 aus PR 1281).
-- -----------------------------------------------------------------------------
-- Die drei Timescale-Jobs telemetry_rollups_job (v1), telemetry_v2_rollups_job
-- und device_measurement_rollup_job verdichten ein Zeitfenster (7 Tage, 7 Tage,
-- 90 Tage) in einer eigenen Transaktion und schreiben mit ON CONFLICT. Ein Lauf,
-- der vor dem Commit des Löschzugs gelesen hat, konnte danach Buckets des
-- gelöschten Bereichs zurückschreiben: seine neuen Zeilen sieht der Löschzug
-- nicht, und ON CONFLICT trifft die gelöschte Zeile nicht mehr. Der Löschnachweis
-- zählte sie nicht.
--
-- Jede Stufe liest darum nur Zeilen von Mandanten, deren Zeile sie im selben
-- Statement mit FOR KEY SHARE sperren konnte - dieselbe Sperre, die ein
-- Fremdschlüssel beim Einfügen nimmt:
--     tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED)
-- Ein reines EXISTS reicht nicht: unter READ COMMITTED sieht das Statement den
-- Stand seines Beginns, also den Mandanten auch dann noch, wenn der Löschzug
-- währenddessen committet. Die Sperre schließt die Lücke von beiden Seiten:
--   * Der Lauf sperrt zuerst: der Löschzug wartet an seiner ersten Sperre
--     (KundenbereichLoeschung.Wache#vorDemAbbau, FOR UPDATE auf die
--     Mandantenzeile, vor jedem DELETE), bis der Lauf committet hat. Danach
--     löscht er die frisch geschriebenen Buckets mit (jedes seiner Statements
--     sieht den neuen Stand; katalogRestLoeschen läuft nach DELETE FROM tenant).
--   * Der Löschzug sperrt zuerst: SKIP LOCKED lässt den Bereich in diesem Lauf
--     aus, ohne zu warten. Rollt der Löschzug zurück, holt ihn der nächste Lauf
--     nach (das Fenster ist Tage lang).
--   * Der Löschzug committet, bevor der Lauf die Zeile erreicht: die Sperre
--     findet eine gelöschte Zeile, READ COMMITTED gibt sie nicht zurück.
-- Kein Tabellen-LOCK: FOR KEY SHARE verträgt sich mit jeder Änderung einer
-- Mandantenzeile außer DELETE und Schlüsseländerung; Ingest und Fremdschlüssel-
-- Prüfungen nehmen dieselbe Sperre und laufen ungehindert. Kein Nachbar wartet.
--
-- Für jeden lebenden Mandanten ist die Verdichtung Zeile für Zeile dieselbe:
-- jede Gruppe und jede Fensterpartition enthält tenant_id, der Filter nimmt nur
-- ganze Mandanten heraus. Die Anlage filtert er bewusst NICHT: kein Weg löscht
-- Verdichtungen je Anlage (V20260913150000: sie bleiben unberührt), und ein
-- Anlagen-Filter änderte die Verdichtung vorhandener Werte entfernter Anlagen.
-- Ruft jemand eine Prozedur unter RLS auf, sieht er in tenant wie in der Quelle
-- nur den eigenen Mandanten - wie bisher.
--
-- Die Rümpfe sind wörtlich die geltenden (v1: V20260922170000, v2:
-- V20260719020000, Box-Verdichtung: V20260922236000); neu ist je Stufe nur die
-- eine Zeile mit dem Filter. Die Job-Prozeduren rufen sie unverändert. Kein
-- Nachrechnen, keine Tabelle, kein Recht.
-- =============================================================================

CREATE OR REPLACE PROCEDURE refresh_telemetry_rollups(since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
    -- The 15m stage: the site rows of telemetry_anlage_15m (V20260922170000),
    -- the same expressions as V20260922020000.
    INSERT INTO telemetry_rollup_15m
    SELECT * FROM telemetry_anlage_15m(time_bucket('15 minutes', since), NULL, NULL)
    WHERE tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED)
    ON CONFLICT (site_id, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        pv_kwh = EXCLUDED.pv_kwh, load_kwh = EXCLUDED.load_kwh,
        grid_import_kwh = EXCLUDED.grid_import_kwh,
        grid_export_kwh = EXCLUDED.grid_export_kwh,
        battery_charge_kwh = EXCLUDED.battery_charge_kwh,
        battery_discharge_kwh = EXCLUDED.battery_discharge_kwh,
        soc_min_pct = EXCLUDED.soc_min_pct, soc_max_pct = EXCLUDED.soc_max_pct,
        soc_last_pct = EXCLUDED.soc_last_pct, n_samples = EXCLUDED.n_samples;

    -- The 1h/1d cascades sum from the 15m stage; unchanged from V20260712000000.
    INSERT INTO telemetry_rollup_1h
    SELECT time_bucket('1 hour', bucket), tenant_id, site_id,
           sum(pv_kwh), sum(load_kwh), sum(grid_import_kwh), sum(grid_export_kwh),
           sum(battery_charge_kwh), sum(battery_discharge_kwh),
           min(soc_min_pct), max(soc_max_pct), last(soc_last_pct, bucket),
           sum(n_samples)
    FROM telemetry_rollup_15m
    WHERE bucket >= time_bucket('1 hour', since)
      AND tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED)
    GROUP BY 1, 2, 3
    ON CONFLICT (site_id, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        pv_kwh = EXCLUDED.pv_kwh, load_kwh = EXCLUDED.load_kwh,
        grid_import_kwh = EXCLUDED.grid_import_kwh,
        grid_export_kwh = EXCLUDED.grid_export_kwh,
        battery_charge_kwh = EXCLUDED.battery_charge_kwh,
        battery_discharge_kwh = EXCLUDED.battery_discharge_kwh,
        soc_min_pct = EXCLUDED.soc_min_pct, soc_max_pct = EXCLUDED.soc_max_pct,
        soc_last_pct = EXCLUDED.soc_last_pct, n_samples = EXCLUDED.n_samples;

    INSERT INTO telemetry_rollup_1d
    SELECT time_bucket('1 day', bucket, 'Europe/Berlin'), tenant_id, site_id,
           sum(pv_kwh), sum(load_kwh), sum(grid_import_kwh), sum(grid_export_kwh),
           sum(battery_charge_kwh), sum(battery_discharge_kwh),
           min(soc_min_pct), max(soc_max_pct), last(soc_last_pct, bucket),
           sum(n_samples)
    FROM telemetry_rollup_1h
    WHERE bucket >= time_bucket('1 day', since, 'Europe/Berlin')
      AND tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED)
    GROUP BY 1, 2, 3
    ON CONFLICT (site_id, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        pv_kwh = EXCLUDED.pv_kwh, load_kwh = EXCLUDED.load_kwh,
        grid_import_kwh = EXCLUDED.grid_import_kwh,
        grid_export_kwh = EXCLUDED.grid_export_kwh,
        battery_charge_kwh = EXCLUDED.battery_charge_kwh,
        battery_discharge_kwh = EXCLUDED.battery_discharge_kwh,
        soc_min_pct = EXCLUDED.soc_min_pct, soc_max_pct = EXCLUDED.soc_max_pct,
        soc_last_pct = EXCLUDED.soc_last_pct, n_samples = EXCLUDED.n_samples;
END
$$;

CREATE OR REPLACE PROCEDURE refresh_telemetry_v2_rollups(since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO telemetry_v2_rollup_15m
    SELECT time_bucket('15 minutes', time) AS bucket,
           tenant_id,
           site_id,
           entity_id,
           channel,
           avg(value)         AS avg_value,
           min(value)         AS min_value,
           max(value)         AS max_value,
           last(value, time)  AS last_value,
           count(*)           AS n_samples
    FROM telemetry_v2
    WHERE time >= time_bucket('15 minutes', since)
      AND tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED)
    GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (entity_id, channel, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id, site_id = EXCLUDED.site_id,
        avg_value = EXCLUDED.avg_value, min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value, last_value = EXCLUDED.last_value,
        n_samples = EXCLUDED.n_samples;

    INSERT INTO telemetry_v2_rollup_1h
    SELECT time_bucket('1 hour', bucket), tenant_id, site_id, entity_id, channel,
           sum(avg_value * n_samples) / NULLIF(sum(n_samples), 0),
           min(min_value), max(max_value), last(last_value, bucket),
           sum(n_samples)
    FROM telemetry_v2_rollup_15m
    WHERE bucket >= time_bucket('1 hour', since)
      AND tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED)
    GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (entity_id, channel, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id, site_id = EXCLUDED.site_id,
        avg_value = EXCLUDED.avg_value, min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value, last_value = EXCLUDED.last_value,
        n_samples = EXCLUDED.n_samples;

    INSERT INTO telemetry_v2_rollup_1d
    SELECT time_bucket('1 day', bucket, 'Europe/Berlin'), tenant_id, site_id, entity_id, channel,
           sum(avg_value * n_samples) / NULLIF(sum(n_samples), 0),
           min(min_value), max(max_value), last(last_value, bucket),
           sum(n_samples)
    FROM telemetry_v2_rollup_1h
    WHERE bucket >= time_bucket('1 day', since, 'Europe/Berlin')
      AND tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED)
    GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (entity_id, channel, bucket) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id, site_id = EXCLUDED.site_id,
        avg_value = EXCLUDED.avg_value, min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value, last_value = EXCLUDED.last_value,
        n_samples = EXCLUDED.n_samples;
END
$$;

CREATE OR REPLACE PROCEDURE refresh_device_measurement_rollup(
    target_table REGCLASS, bucket_width INTERVAL, since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($q$
    INSERT INTO %s
    WITH ordered AS (
      SELECT *, lag(COALESCE(decoded_numeric, raw_numeric)) OVER
        (PARTITION BY tenant_id, site_id, device_id, point_key ORDER BY time, edge_sequence) AS prev_numeric,
        lag(COALESCE(decoded_text, raw_text, decoded_numeric::text, raw_numeric::text)) OVER
        (PARTITION BY tenant_id, site_id, device_id, point_key ORDER BY time, edge_sequence) AS prev_value
      FROM device_measurement_sample
      WHERE time >= time_bucket($1, $2) AND quality = 'good' AND edge_entity_id IS NULL
        AND tenant_id IN (SELECT id FROM tenant FOR KEY SHARE SKIP LOCKED)
    )
    SELECT time_bucket($1, time), tenant_id, site_id, device_id, point_key,
      aggregation_kind,
      CASE WHEN aggregation_kind IN ('gauge','counter') THEN
        first(COALESCE(decoded_numeric,raw_numeric),time) END,
      CASE WHEN aggregation_kind IN ('gauge','counter') THEN
        last(COALESCE(decoded_numeric,raw_numeric),time) END,
      CASE WHEN aggregation_kind='gauge' THEN min(COALESCE(decoded_numeric,raw_numeric)) END,
      CASE WHEN aggregation_kind='gauge' THEN max(COALESCE(decoded_numeric,raw_numeric)) END,
      CASE WHEN aggregation_kind='gauge' THEN avg(COALESCE(decoded_numeric,raw_numeric)) END,
      CASE WHEN aggregation_kind='counter' THEN
        sum(CASE WHEN prev_numeric IS NULL THEN 0
                 WHEN COALESCE(decoded_numeric,raw_numeric) >= prev_numeric
                   THEN COALESCE(decoded_numeric,raw_numeric)-prev_numeric ELSE 0 END) END,
      count(*) FILTER (WHERE aggregation_kind='counter' AND prev_numeric IS NOT NULL
                    AND COALESCE(decoded_numeric,raw_numeric) < prev_numeric),
      CASE WHEN aggregation_kind IN ('state','event','bitfield','text') THEN
        first(COALESCE(decoded_text,raw_text,decoded_numeric::text,raw_numeric::text),time) END,
      CASE WHEN aggregation_kind IN ('state','event','bitfield','text') THEN
        last(COALESCE(decoded_text,raw_text,decoded_numeric::text,raw_numeric::text),time) END,
      count(*) FILTER (WHERE aggregation_kind IN ('state','event','bitfield','text')
                               AND prev_value IS DISTINCT FROM
                         COALESCE(decoded_text,raw_text,decoded_numeric::text,raw_numeric::text)),
      count(*), last(catalog_version,time)
    FROM ordered
    WHERE long_term_cadence_s = EXTRACT(EPOCH FROM $1)::int
       OR aggregation_kind IN ('state','event','bitfield','text')
    GROUP BY 1,2,3,4,5,6
    ON CONFLICT (tenant_id,site_id,device_id,point_key,bucket) DO UPDATE SET
      aggregation_kind=EXCLUDED.aggregation_kind,
      first_numeric=EXCLUDED.first_numeric,last_numeric=EXCLUDED.last_numeric,
      min_numeric=EXCLUDED.min_numeric,max_numeric=EXCLUDED.max_numeric,
      avg_numeric=EXCLUDED.avg_numeric,positive_delta=EXCLUDED.positive_delta,
      counter_reset_count=EXCLUDED.counter_reset_count,first_text=EXCLUDED.first_text,
      last_text=EXCLUDED.last_text,change_count=EXCLUDED.change_count,
      sample_count=EXCLUDED.sample_count,catalog_version=EXCLUDED.catalog_version
  $q$, target_table) USING bucket_width, since;
END $$;

COMMENT ON PROCEDURE refresh_telemetry_rollups(TIMESTAMPTZ) IS
  'v1-Anlagen-Verdichtung 15m/1h/1d (V20260922170000); schreibt nur für Mandanten, deren Zeile sie '
  'FOR KEY SHARE sperren konnte (V20260926004700, Löschzug E10 = A).';
COMMENT ON PROCEDURE refresh_telemetry_v2_rollups(TIMESTAMPTZ) IS
  'v2-Verdichtung 15m/1h/1d (V20260719020000); schreibt nur für Mandanten, deren Zeile sie '
  'FOR KEY SHARE sperren konnte (V20260926004700, Löschzug E10 = A).';
COMMENT ON PROCEDURE refresh_device_measurement_rollup(REGCLASS, INTERVAL, TIMESTAMPTZ) IS
  'Quality-filtered, historical-site-local durable gauge/counter/state/event/bitfield/text rollups. '
  'Box-Verdichtung: nur Zeilen ohne edge_entity_id (UEMS AP-07 IP-18b, geteilter Punkt). '
  'Nur Mandanten, deren Zeile sie FOR KEY SHARE sperren konnte (V20260926004700, Löschzug E10 = A).';
