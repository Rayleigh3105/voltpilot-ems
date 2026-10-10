-- UEMS AP-07 IP-18b, Teil 1b — die beiden Box-Schlüssel bauen, ohne zu sperren.
--
-- V20260922236000 legt edge_entity_id und die Box-Verdichtung an. Diese Migration
-- baut die zwei partiellen Schlüssel und nimmt uq_device_measurement_sample_idempotency
-- danach weg - ohne device_measurement_sample für den Writer zu sperren, solange
-- der Bau über den ganzen Bestand läuft.
--
-- Warum nicht der übliche Weg: device_measurement_sample ist eine Hypertable
-- (V20260848000000, ein Chunk je Tag, 90 Tage Aufbewahrung). TimescaleDB 2.17.2
-- lehnt CREATE INDEX CONCURRENTLY ab ("hypertables do not support concurrent index
-- creation"), und WITH (timescaledb.transaction_per_chunk) gibt es nicht für
-- UNIQUE ("cannot use timescaledb.transaction_per_chunk with UNIQUE or PRIMARY
-- KEY"). Ein gewöhnliches CREATE UNIQUE INDEX hält die Wurzel im ShareLock, bis der
-- letzte Chunk gebaut ist - jedes INSERT wartet so lange.
--
-- Darum dasselbe, was transaction_per_chunk täte, ausgeschrieben:
--   1. Die Schlüssel an der WURZEL mit ON ONLY. Kein Chunk wird gelesen; jeder ab
--      jetzt neu angelegte Chunk bekommt sie von Timescale selbst.
--   2. Je bestehendem Chunk EINE Transaktion: Index auf dem Chunk bauen und in
--      _timescaledb_catalog.chunk_index eintragen - dieselbe Zeile, die Timescale für
--      einen neuen Chunk schreibt. Gesperrt ist nur dieser Chunk (ShareLock, für die
--      Dauer seines Baus); der Writer schreibt in alle anderen weiter.
--   3. Erst wenn jeder Chunk beide neuen Schlüssel trägt, fällt der alte: je Chunk,
--      dann an der Wurzel. DROP INDEX braucht einen kurzen AccessExclusiveLock.
-- Jede Anweisung wartet höchstens 5 s auf ihre Sperre und versucht es dann nach 2 s
-- erneut (zwölfmal), damit ein langer Leser keine Warteschlange vor dem Writer
-- aufstaut.
--
-- Ohne Flyway-Transaktion (…_bauen.sql.conf: executeInTransaction=false): in EINER
-- Transaktion hielte Flyway jede Sperre bis zum Schluss, und die Prozedur dürfte
-- nicht committen. Wiederholbar nach jedem Abbruch - auch wenn das Kubelet die api
-- mitten im Bau beendet: jeder Schritt prüft, was schon steht, und macht dort weiter.
-- Ein INVALID gebliebener Chunk-Index (etwa aus einem Handversuch mit
-- CONCURRENTLY) wird vorher entfernt.
--
-- Übergang: solange der alte Schlüssel neben den neuen steht, weist ON CONFLICT DO
-- NOTHING des Writers (ohne Ziel: alle Schlüssel des Chunks) genau das ab, was er
-- vorher abwies. Ein geteilter Punkt behielte bis dahin nur seine erste Komponente
-- je Tick - die Box nennt noch keinen (IP-18b Box-Schritt ruht, PR 1124).
-- Drehbuch: docs/rollout/uems-erste-freigabe.md §2.7.

-- Eine DDL-Anweisung mit Sperr-Frist: höchstens 5 s warten, dann nach 2 s erneut,
-- zwölfmal. false = die Tabelle ist weg (die Aufbewahrung hat den Chunk entfernt).
CREATE OR REPLACE FUNCTION uems_box_schluessel_mit_frist(anweisung TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  versuch INT := 0;
BEGIN
  LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '5s', true);
      EXECUTE anweisung;
      PERFORM set_config('lock_timeout', '0', true);
      RETURN true;
    EXCEPTION
      WHEN undefined_table THEN RETURN false;
      WHEN lock_not_available THEN
        versuch := versuch + 1;
        IF versuch >= 12 THEN RAISE; END IF;
        PERFORM pg_sleep(2);
    END;
  END LOOP;
END $$;

-- Jede Anweisung mit Sperre ist eine eigene Transaktion (COMMIT nach jedem Schritt).
CREATE OR REPLACE PROCEDURE uems_box_schluessel_bauen()
LANGUAGE plpgsql AS $$
DECLARE
  neue CONSTANT TEXT[][] := ARRAY[
    ['uq_device_measurement_sample_box',
     '(device_id, point_key, time, edge_sequence) WHERE edge_entity_id IS NULL'],
    ['uq_device_measurement_sample_box_komponente',
     '(device_id, point_key, edge_entity_id, time, edge_sequence) WHERE edge_entity_id IS NOT NULL']];
  alt CONSTANT TEXT := 'uq_device_measurement_sample_idempotency';
  ht INT;
  ch RECORD;
  i INT;
  idx TEXT;
BEGIN
  SELECT id INTO ht FROM _timescaledb_catalog.hypertable
   WHERE schema_name = 'public' AND table_name = 'device_measurement_sample';
  IF ht IS NULL THEN
    RAISE EXCEPTION 'device_measurement_sample ist keine Hypertable';
  END IF;

  -- 1. Wurzel.
  FOR i IN 1 .. array_length(neue, 1) LOOP
    PERFORM uems_box_schluessel_mit_frist(format(
        'CREATE UNIQUE INDEX IF NOT EXISTS %I ON ONLY public.device_measurement_sample %s',
        neue[i][1], neue[i][2]));
    COMMIT;
  END LOOP;

  -- 2. Je Chunk, der den Schlüssel noch nicht im Timescale-Katalog trägt.
  FOR ch IN
    SELECT c.id, c.schema_name, c.table_name, j AS i
      FROM _timescaledb_catalog.chunk c, generate_subscripts(neue, 1) AS j
     WHERE c.hypertable_id = ht AND NOT c.dropped
       AND NOT EXISTS (SELECT 1 FROM _timescaledb_catalog.chunk_index ci
                        WHERE ci.chunk_id = c.id AND ci.hypertable_index_name = neue[j][1])
     ORDER BY c.id, j
  LOOP
    idx := left(ch.table_name || '_' || neue[ch.i][1], 63);
    IF EXISTS (SELECT 1 FROM pg_index x JOIN pg_class k ON k.oid = x.indexrelid
                JOIN pg_namespace n ON n.oid = k.relnamespace
                WHERE n.nspname = ch.schema_name AND k.relname = idx AND NOT x.indisvalid) THEN
      PERFORM uems_box_schluessel_mit_frist(format('DROP INDEX %I.%I', ch.schema_name, idx));
      COMMIT;
    END IF;
    IF uems_box_schluessel_mit_frist(format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I %s',
                                           idx, ch.schema_name, ch.table_name, neue[ch.i][2])) THEN
      INSERT INTO _timescaledb_catalog.chunk_index
             (chunk_id, index_name, hypertable_id, hypertable_index_name)
      VALUES (ch.id, idx, ht, neue[ch.i][1]);
    END IF;
    COMMIT;
  END LOOP;

  -- 3. Der alte Schlüssel fällt nur, wenn KEIN Chunk mehr ohne einen neuen ist.
  IF EXISTS (SELECT 1 FROM _timescaledb_catalog.chunk c, generate_subscripts(neue, 1) AS j
              WHERE c.hypertable_id = ht AND NOT c.dropped
                AND NOT EXISTS (SELECT 1 FROM _timescaledb_catalog.chunk_index ci
                                 WHERE ci.chunk_id = c.id AND ci.hypertable_index_name = neue[j][1])) THEN
    RAISE EXCEPTION 'Ein Chunk von device_measurement_sample trägt die neuen Box-Schlüssel nicht; % bleibt', alt;
  END IF;
  FOR ch IN
    SELECT c.schema_name, ci.index_name FROM _timescaledb_catalog.chunk_index ci
      JOIN _timescaledb_catalog.chunk c ON c.id = ci.chunk_id
     WHERE ci.hypertable_id = ht AND ci.hypertable_index_name = alt
     ORDER BY c.id
  LOOP
    PERFORM uems_box_schluessel_mit_frist(format('DROP INDEX IF EXISTS %I.%I', ch.schema_name, ch.index_name));
    COMMIT;
  END LOOP;
  PERFORM uems_box_schluessel_mit_frist(format('DROP INDEX IF EXISTS public.%I', alt));
  COMMIT;
END $$;

CALL uems_box_schluessel_bauen();
DROP PROCEDURE uems_box_schluessel_bauen();
DROP FUNCTION uems_box_schluessel_mit_frist(TEXT);

COMMENT ON INDEX uq_device_measurement_sample_box IS
    'Box-Schlüssel ohne genannte Komponente: dieselbe Spaltenfolge wie der '
    'abgelöste uq_device_measurement_sample_idempotency (UEMS AP-07 IP-18b).';
COMMENT ON INDEX uq_device_measurement_sample_box_komponente IS
    'Box-Schlüssel des geteilten Punkts: je von der Box genannter Komponente '
    '(UEMS AP-07 IP-18b).';
