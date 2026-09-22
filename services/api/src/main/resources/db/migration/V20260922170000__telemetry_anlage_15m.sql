-- =============================================================================
-- V20260922170000 - Eine Regel "welche Groesse von welcher Box", drei Nutzer
-- (UEMS AP-15 Folgepaket vp-uems-v15-folge-mehrbox-restleser; W2, B1).
-- -----------------------------------------------------------------------------
-- V20260922020000 hat die Anlagen-Summen einer Mehr-Box-Anlage mit bestimmter
-- fuehrender Box in refresh_telemetry_rollups geheilt (222 statt 367 kW). Drei
-- Leser rechneten danach weiter je Anlage ueber alle Boxen gemittelt:
--   * SeriesRepository.recomputeRollupsForSite (nach einem Geraete-Purge) - eine
--     Java-Kopie der ALTEN Rollup-Ausdruecke, die die Buckets wieder mischte;
--   * die Tagesansicht HistoryRepository.dayBuckets (roh, live);
--   * services/forecast evaluate._actuals und forecast_collect._telemetry_history.
--
-- Statt die Regel ein drittes Mal zu kopieren, steht sie jetzt an EINER Stelle:
--   * telemetry_fuehrende_box(site)  - die Bedingung "bestimmte fuehrende Box"
--     (dieselbe wie im Optimierer inputs.load_fuehrende_boxen): lead_device_id
--     gesetzt, in DIESER Anlage angemeldet und nicht ausgebaut, und mindestens
--     eine weitere Box ebenso. Sonst NULL.
--   * telemetry_anlage_15m(von, bis, site) - die 15-Minuten-Zeilen je Anlage mit
--     genau den Ausdruecken von V20260922020000 (Zweig je_anlage fuer jede
--     andere Anlage Wort fuer Wort wie V20260712000000, Zweig
--     je_mehr_box_anlage mit Bezug/Einspeisung an der fuehrenden Box, PV Summe,
--     Last fuehrende + Nettoabgabe je weiterer Box, Speicher Summe, SoC an der
--     Box des primaeren Speichers). Die Zeitgrenzen gelten auf den ROHEN
--     Zeilen (time >= von, time < bis; NULL = offen), site NULL = alle Anlagen.
--     Die Energien sind ungerundetes NUMERIC - die Tagesansicht liest sie so
--     wie bisher ihre eigenen Ausdruecke, erst die Rollup-Tabelle rundet beim
--     Einfuegen auf NUMERIC(14, 6), wie bisher.
--   * refresh_telemetry_rollups liest die 15m-Stufe aus dieser Funktion; die
--     1h/1d-Stufen sind unveraendert.
--
-- LANGUAGE sql, STABLE, SECURITY INVOKER: die Funktion ist inline-faehig (der
-- Planer setzt sie in die aufrufende Abfrage ein, Zeit- und Anlagengrenze
-- wirken auf die Hypertable), und sie sieht nur, was der Aufrufer sieht - fuer
-- voltpilot_app also die Zeilen des eigenen Mandanten (RLS auf telemetry,
-- site, device, asset). Kein neues Recht, keine neue Tabelle.
--
-- Kein Nachrechnen: diese Migration ruft die Prozedur NICHT auf, die Werte
-- der Prozedur sind fuer jede Anlage dieselben wie mit V20260922020000.
-- =============================================================================

CREATE OR REPLACE FUNCTION telemetry_fuehrende_box(p_site UUID)
RETURNS UUID
LANGUAGE sql STABLE AS $$
    SELECT s.lead_device_id
    FROM site s
    WHERE s.id = p_site
      AND s.lead_device_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM device d
                   WHERE d.id = s.lead_device_id AND d.site_id = s.id
                     AND d.ausgebaut_am IS NULL)
      AND EXISTS (SELECT 1 FROM device d
                   WHERE d.site_id = s.id AND d.id <> s.lead_device_id
                     AND d.ausgebaut_am IS NULL)
$$;

CREATE OR REPLACE FUNCTION telemetry_anlage_15m(p_von TIMESTAMPTZ, p_bis TIMESTAMPTZ, p_site UUID)
RETURNS TABLE (
    bucket                TIMESTAMPTZ,
    tenant_id             UUID,
    site_id               UUID,
    pv_kwh                NUMERIC,
    load_kwh              NUMERIC,
    grid_import_kwh       NUMERIC,
    grid_export_kwh       NUMERIC,
    battery_charge_kwh    NUMERIC,
    battery_discharge_kwh NUMERIC,
    soc_min_pct           NUMERIC,
    soc_max_pct           NUMERIC,
    soc_last_pct          NUMERIC,
    n_samples             BIGINT
)
LANGUAGE sql STABLE AS $$
    WITH fuehrung AS MATERIALIZED (
        SELECT k.site_id, k.fuehrende_box, k.speicher_box
        FROM (
            SELECT s.id                                                     AS site_id,
                   telemetry_fuehrende_box(s.id)                            AS fuehrende_box,
                   (SELECT a.device_id FROM asset a
                     WHERE a.site_id = s.id AND a.type = 'battery' AND a.is_primary
                     ORDER BY a.id LIMIT 1)                                 AS speicher_box
            FROM site s
            WHERE p_site IS NULL OR s.id = p_site
        ) k
        WHERE k.fuehrende_box IS NOT NULL
    ),
    je_anlage AS (
        SELECT time_bucket('15 minutes', time)                              AS bucket,
               tenant_id,
               site_id,
               avg(pv_power_kw) * 0.25                                      AS pv_kwh,
               avg(load_kw) * 0.25                                          AS load_kwh,
               avg(CASE WHEN power_kw IS NOT NULL
                        THEN greatest(power_kw, 0) END) * 0.25              AS grid_import_kwh,
               avg(CASE WHEN power_kw IS NOT NULL
                        THEN greatest(-power_kw, 0) END) * 0.25             AS grid_export_kwh,
               avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL
                             AND pv_power_kw IS NOT NULL
                        THEN greatest(power_kw - load_kw + pv_power_kw, 0)
                   END) * 0.25                                              AS battery_charge_kwh,
               avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL
                             AND pv_power_kw IS NOT NULL
                        THEN greatest(-(power_kw - load_kw + pv_power_kw), 0)
                   END) * 0.25                                              AS battery_discharge_kwh,
               min(soc_pct)                                                 AS soc_min_pct,
               max(soc_pct)                                                 AS soc_max_pct,
               last(soc_pct, time)                                          AS soc_last_pct,
               count(*)                                                     AS n_samples
        FROM telemetry
        WHERE (p_von IS NULL OR time >= p_von)
          AND (p_bis IS NULL OR time < p_bis)
          AND (p_site IS NULL OR site_id = p_site)
          AND site_id NOT IN (SELECT f.site_id FROM fuehrung f)
        GROUP BY 1, 2, 3
    ),
    je_box AS (
        SELECT time_bucket('15 minutes', t.time)                            AS bucket,
               t.tenant_id,
               t.site_id,
               t.device_id,
               t.device_id = f.fuehrende_box                                AS fuehrt,
               -- NULL ohne Speicher-Box: dann zaehlt jede Box (wie bisher)
               t.device_id = f.speicher_box                                 AS speichert,
               avg(t.pv_power_kw)                                           AS pv_kw,
               avg(t.load_kw)                                               AS load_kw,
               avg(CASE WHEN t.power_kw IS NOT NULL AND t.load_kw IS NOT NULL
                        THEN t.load_kw - t.power_kw END)                    AS abgabe_kw,
               avg(CASE WHEN t.power_kw IS NOT NULL
                        THEN greatest(t.power_kw, 0) END)                   AS bezug_kw,
               avg(CASE WHEN t.power_kw IS NOT NULL
                        THEN greatest(-t.power_kw, 0) END)                  AS einspeisung_kw,
               avg(CASE WHEN t.power_kw IS NOT NULL AND t.load_kw IS NOT NULL
                             AND t.pv_power_kw IS NOT NULL
                        THEN greatest(t.power_kw - t.load_kw + t.pv_power_kw, 0)
                   END)                                                     AS laden_kw,
               avg(CASE WHEN t.power_kw IS NOT NULL AND t.load_kw IS NOT NULL
                             AND t.pv_power_kw IS NOT NULL
                        THEN greatest(-(t.power_kw - t.load_kw + t.pv_power_kw), 0)
                   END)                                                     AS entladen_kw,
               min(t.soc_pct)                                               AS soc_min_pct,
               max(t.soc_pct)                                               AS soc_max_pct,
               last(t.soc_pct, t.time)                                      AS soc_last_pct,
               max(t.time)                                                  AS zuletzt,
               count(*)                                                     AS n_samples
        FROM telemetry t
        JOIN fuehrung f ON f.site_id = t.site_id
        WHERE (p_von IS NULL OR t.time >= p_von)
          AND (p_bis IS NULL OR t.time < p_bis)
        GROUP BY 1, 2, 3, 4, 5, 6
    ),
    je_mehr_box_anlage AS (
        SELECT bucket,
               tenant_id,
               site_id,
               sum(pv_kw) * 0.25                                            AS pv_kwh,
               CASE WHEN bool_and(abgabe_kw IS NOT NULL) FILTER (WHERE NOT fuehrt) IS FALSE
                    THEN NULL
                    ELSE (max(load_kw) FILTER (WHERE fuehrt)
                          + coalesce(sum(abgabe_kw) FILTER (WHERE NOT fuehrt), 0)) * 0.25
               END                                                          AS load_kwh,
               max(bezug_kw) FILTER (WHERE fuehrt) * 0.25                   AS grid_import_kwh,
               max(einspeisung_kw) FILTER (WHERE fuehrt) * 0.25             AS grid_export_kwh,
               sum(laden_kw) * 0.25                                         AS battery_charge_kwh,
               sum(entladen_kw) * 0.25                                      AS battery_discharge_kwh,
               min(soc_min_pct) FILTER (WHERE speichert IS NOT FALSE)       AS soc_min_pct,
               max(soc_max_pct) FILTER (WHERE speichert IS NOT FALSE)       AS soc_max_pct,
               last(soc_last_pct, zuletzt) FILTER (WHERE speichert IS NOT FALSE)
                                                                            AS soc_last_pct,
               sum(n_samples)::BIGINT                                       AS n_samples
        FROM je_box
        GROUP BY 1, 2, 3
    )
    SELECT * FROM je_anlage
    UNION ALL
    SELECT * FROM je_mehr_box_anlage
$$;

CREATE OR REPLACE PROCEDURE refresh_telemetry_rollups(since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
    -- The 15m stage: the site rows of telemetry_anlage_15m (V20260922170000),
    -- the same expressions as V20260922020000.
    INSERT INTO telemetry_rollup_15m
    SELECT * FROM telemetry_anlage_15m(time_bucket('15 minutes', since), NULL, NULL)
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
