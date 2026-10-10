-- UEMS AP-07 IP-18b, Teil 1b — der Box-Schlüssel des GETEILTEN Punkts.
--
-- Teil 1a (PR 1093) lässt die Box denselben point_key für zwei Komponenten
-- melden, jede mit ihrer entity_id (measurement-samples 2.1). Der alte
-- Box-Schlüssel uq_device_measurement_sample_idempotency
-- (device_id, point_key, time, edge_sequence) nimmt davon je Tick nur EINEN
-- Wert an. Diese Migration gibt dem geteilten Punkt einen eigenen Schlüssel und
-- lässt alles Heutige genau so, wie es ist:
--
--   * Neue Spalte edge_entity_id: die Komponente, die die BOX am geteilten Punkt
--     genannt hat — der Wortlaut vom Draht, nicht das Ergebnis des Nachschlags
--     (das steht in entity_id). Für jede Bestandszeile bleibt sie NULL; es wird
--     keine Zeile umgeschrieben.
--   * Zwei partielle Schlüssel ersetzen den alten: ohne edge_entity_id genau die
--     alte Spaltenfolge (für alles Heutige dieselbe Semantik), mit edge_entity_id
--     dieselbe Folge plus die genannte Komponente. Ein Schlüssel über entity_id
--     reicht nicht: er kollidiert, wenn beide Komponenten unaufgelöst sind, und
--     er kann zwischen zwei Zustellungen desselben Umschlags wechseln.
--     Gebaut werden sie NICHT hier, sondern direkt danach in
--     V20260922236500 - Chunk für Chunk, ohne Flyway-Transaktion, damit der Bau
--     die Hypertable nicht für den Writer sperrt. Der alte Index fällt dort erst,
--     nachdem beide neuen auf jedem Chunk stehen.
--   * Die Box-Verdichtung (refresh_device_measurement_rollup) liest nur Zeilen
--     ohne edge_entity_id: ein geteilter Punkt erscheint im Box-Verlauf nicht
--     doppelt; seine Komponentenwerte zeigt nur ihre Reihe (entity_id). Für den
--     Bestand (alles NULL) ist das Zeile für Zeile dieselbe Verdichtung.
--
-- Kein GRANT: die Rechte auf device_measurement_sample sind tabellenweit, RLS
-- und FORCE bleiben unverändert. Kein Fremdschlüssel auf edge_entity_id aus
-- demselben Grund wie bei entity_id (V20260912140000): die Löschwege der
-- Messreihen gehören AP-07 IP-11.

ALTER TABLE device_measurement_sample ADD COLUMN IF NOT EXISTS edge_entity_id UUID;

-- Die Verdichtung aus V20260853000000, wörtlich, mit EINER zusätzlichen
-- Bedingung im Zeilenfilter: AND edge_entity_id IS NULL.
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

COMMENT ON PROCEDURE refresh_device_measurement_rollup(REGCLASS, INTERVAL, TIMESTAMPTZ) IS
  'Quality-filtered, historical-site-local durable gauge/counter/state/event/bitfield/text rollups. '
  'Box-Verdichtung: nur Zeilen ohne edge_entity_id (UEMS AP-07 IP-18b, geteilter Punkt).';
COMMENT ON COLUMN device_measurement_sample.edge_entity_id IS
    'Die Komponente, die die Box an einem GETEILTEN Punkt genannt hat '
    '(measurement-samples 2.1, UEMS AP-07 IP-18b) - Wortlaut vom Draht, nicht '
    'das Ergebnis des Nachschlags (entity_id). NULL = kein geteilter Punkt; so '
    'jede Bestandszeile. Zeilen mit Wert gehören nicht in den Box-Verlauf.';
