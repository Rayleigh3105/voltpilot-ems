-- =============================================================================
-- V20260922020000 - Anlagen-Summen einer Mehr-Box-Anlage im 15-Minuten-Rollup
-- (UEMS AP-15 Folgepunkt vp-uems-v15-folge-leser-je-anlage; W2 "zwei Fragen,
-- zwei Anker", B1 "der Netzzaehler hat genau eine zustaendige Box: die fuehrende").
-- -----------------------------------------------------------------------------
-- Befund: refresh_telemetry_rollups (V20260712000000) gruppiert je
-- (bucket, tenant_id, site_id) und MITTELT damit die Zeilen aller sendenden
-- Boxen einer Anlage nach ihrer Anzahl. Die Annahme "eine sendende Box je
-- Anlage" (V20260701030000, Kopf) gilt seit den Mehr-Box-Paketen (AP-06) nicht
-- mehr: im Augenblick R3 (Netzzaehler 367 kW an der fuehrenden Box, Abgang der
-- zweiten Box 77 kW) ergab das 222 kW Bezug statt 367 kW.
--
-- Neu, und NUR fuer eine Mehr-Box-Anlage mit bestimmter fuehrender Box
-- (site.lead_device_id gesetzt, diese Box ist in DIESER Anlage angemeldet und
-- nicht ausgebaut, und mindestens eine weitere Box ist es auch - dieselbe
-- Bedingung wie der Optimierer in inputs.load_fuehrende_boxen):
--   * grid_import_kwh / grid_export_kwh: nur die Zeilen der fuehrenden Box
--     (sie liest den Netzzaehler); sendet sie im Bucket nicht, bleibt er NULL.
--   * pv_kwh: SUMME der Box-Mittel (die Erzeugung der Anlage).
--   * load_kwh: Mittel der fuehrenden Box PLUS je weiterer Box ihr Mittel von
--     (load_kw - power_kw). Die Box bildet load_kw aus ihrer eigenen Bilanz
--     (pv + power - Speicher, edge-app/core/internal/agent/agent.go
--     houseFromBalance); die PV einer anderen Box kennt sie nicht. Die Last der
--     fuehrenden Box ist darum um die Nettoabgabe (PV - Laden) jeder weiteren
--     Box zu klein, und genau die ist deren load_kw - power_kw. Fehlt einer
--     weiteren Box, die im Bucket sendet, dieses Paar, ist die Last unbekannt
--     (NULL), nie die zu kleine Zahl der fuehrenden Box.
--   * battery_charge_kwh / battery_discharge_kwh: Summe der Box-Werte, jeder
--     wie bisher je Probe aus der eigenen Bilanz der Box geteilt.
--   * soc_*: nur die Box des geplanten Speichers (asset.device_id der primaeren
--     Batterie, der Anker von IP-9); ohne sie alle Boxen wie bisher.
--   * n_samples: alle Proben aller Boxen, wie bisher.
-- Jede andere Anlage - jede Ein-Box-Anlage und jede ohne bestimmte fuehrende
-- Box - laeuft durch den Zweig `je_anlage` mit den Ausdruecken von
-- V20260712000000, Wort fuer Wort: dieselben Rollup-Zeilen wie heute.
--
-- Kein Nachrechnen des Bestands: diese Migration ruft die Prozedur NICHT auf.
-- Der vorhandene Job telemetry_rollups_job verdichtet wie immer alle 15
-- Minuten die letzten 7 Tage neu; ab seinem ersten Lauf sind diese und alle
-- neuen Buckets richtig. Aeltere Buckets einer Mehr-Box-Anlage bleiben
-- gemittelt (nur auf uems, Produktion hat keine); nachrechnen liesse sich mit
-- CALL refresh_telemetry_rollups('<ab>').
--
-- Die 1h/1d-Stufen summieren wie bisher aus der 15m-Stufe und sind
-- unveraendert uebernommen.
-- =============================================================================

CREATE OR REPLACE PROCEDURE refresh_telemetry_rollups(since TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO telemetry_rollup_15m
    WITH fuehrung AS MATERIALIZED (
        SELECT s.id AS site_id,
               s.lead_device_id AS fuehrende_box,
               (SELECT a.device_id FROM asset a
                 WHERE a.site_id = s.id AND a.type = 'battery' AND a.is_primary
                 ORDER BY a.id LIMIT 1)                                     AS speicher_box
        FROM site s
        WHERE s.lead_device_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM device d
                       WHERE d.id = s.lead_device_id AND d.site_id = s.id
                         AND d.ausgebaut_am IS NULL)
          AND EXISTS (SELECT 1 FROM device d
                       WHERE d.site_id = s.id AND d.id <> s.lead_device_id
                         AND d.ausgebaut_am IS NULL)
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
        WHERE time >= time_bucket('15 minutes', since)
          AND site_id NOT IN (SELECT site_id FROM fuehrung)
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
        WHERE t.time >= time_bucket('15 minutes', since)
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
