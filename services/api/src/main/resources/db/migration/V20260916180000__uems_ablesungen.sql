-- AP-09 IP-8: zweite Rohwert-Spur, ohne erfundene Box/Komponente.
-- Kanalwerte behalten Schlüssel, Herkunft, Rechte und Aufbewahrung.
ALTER TABLE messstelle_quelle ADD COLUMN art TEXT NOT NULL DEFAULT 'messkanal';
ALTER TABLE messstelle_quelle ALTER COLUMN entity_id DROP NOT NULL;
ALTER TABLE messstelle_quelle ALTER COLUMN geraet_id DROP NOT NULL;
ALTER TABLE messstelle_quelle ADD CONSTRAINT messstelle_quelle_art_chk CHECK (coalesce(
    (art = 'messkanal' AND entity_id IS NOT NULL AND geraet_id IS NOT NULL)
    OR (art = 'ablesung' AND entity_id IS NULL AND geraet_id IS NULL AND rolle = 'fuehrend'
        AND kanal_wertart = 'counter' AND herleitung = 'differenzen' AND anteil IS NULL), false));

CREATE FUNCTION uems_ablesung_quelle_unveraenderlich() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.art IS DISTINCT FROM OLD.art THEN
    RAISE EXCEPTION 'Die Quellen-Art bleibt unverändert' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER uems_ablesung_quelle_unveraenderlich BEFORE UPDATE ON messstelle_quelle
FOR EACH ROW EXECUTE FUNCTION uems_ablesung_quelle_unveraenderlich();

ALTER TABLE device_measurement_sample
    ADD COLUMN ablesung_quelle_id UUID,
    ADD COLUMN ablesung_fassung INTEGER,
    ADD COLUMN ablesung_stand NUMERIC,
    ADD COLUMN zuordnung_monat DATE,
    ADD COLUMN woher TEXT,
    ADD COLUMN urheber JSONB,
    ADD COLUMN ablesung_korrektur TEXT;
ALTER TABLE device_measurement_sample ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE device_measurement_sample ALTER COLUMN device_id DROP NOT NULL;
ALTER TABLE device_measurement_sample ALTER COLUMN catalog_version DROP NOT NULL;
ALTER TABLE device_measurement_sample ALTER COLUMN edge_sequence DROP NOT NULL;
ALTER TABLE device_measurement_sample ADD CONSTRAINT device_measurement_sample_ablesung_quelle_fk
    FOREIGN KEY (ablesung_quelle_id, tenant_id) REFERENCES messstelle_quelle(id, tenant_id) ON DELETE RESTRICT;
ALTER TABLE device_measurement_sample ADD CONSTRAINT device_measurement_sample_ablesung_chk CHECK (coalesce(
    (ablesung_quelle_id IS NULL AND site_id IS NOT NULL AND device_id IS NOT NULL
        AND catalog_version IS NOT NULL AND edge_sequence IS NOT NULL
        AND ablesung_fassung IS NULL AND ablesung_stand IS NULL AND zuordnung_monat IS NULL
        AND woher IS NULL AND urheber IS NULL AND ablesung_korrektur IS NULL)
    OR (ablesung_quelle_id IS NOT NULL AND ablesung_fassung >= 1
        AND ablesung_stand >= 0 AND ablesung_stand NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND (zuordnung_monat IS NULL OR extract(day FROM zuordnung_monat) = 1)
        AND woher IN ('eingabe','import') AND jsonb_typeof(urheber) = 'object'
        AND urheber ->> 'art' IN ('kunde','unterstuetzung','voltpilot','notfall')
        AND btrim(urheber ->> 'sub') <> '' AND btrim(urheber ->> 'name') <> ''
        AND urheber ->> 'rolle' IN ('kundenadministrator','energiemanager','bearbeiter','bedienberechtigt',
                                  'leser','unterstuetzer','voltpilot_betrieb')
        AND site_id IS NULL AND device_id IS NULL AND entity_id IS NULL AND device_install_id IS NULL
        AND applied_revision IS NULL AND catalog_version IS NULL AND edge_sequence IS NULL
        AND value_kind = 'counter' AND aggregation_kind = 'counter' AND role = 'fuehrend'
        AND quality = 'good' AND long_term_cadence_s IS NULL AND raw_numeric IS NOT NULL AND decoded_numeric = raw_numeric
        AND date_trunc('minute', time) = time
        AND ((ablesung_fassung = 1 AND ablesung_korrektur IS NULL)
             OR (ablesung_fassung > 1 AND ablesung_korrektur ~ '^K-[0-9]{4}-[0-9]{4,}$'))), false));
CREATE UNIQUE INDEX uq_device_measurement_sample_ablesung
    ON device_measurement_sample(tenant_id, ablesung_quelle_id, time, ablesung_fassung)
    WHERE ablesung_quelle_id IS NOT NULL;

-- Dauerhafter Fassungs-/Herkunftsnachweis der Ablesung. Die Rohwertklasse wird nach
-- 90 Tagen aufgeräumt; die kundenseitige Eingabe samt ihrer Berichtigungen bleibt.
CREATE TABLE messstelle_ablesung_fassung (
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    quelle_id UUID NOT NULL,
    zeitpunkt TIMESTAMPTZ NOT NULL,
    fassung INTEGER NOT NULL CHECK (fassung >= 1),
    stand NUMERIC NOT NULL CHECK (stand >= 0 AND stand NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
    zuordnung_monat DATE CHECK (extract(day FROM zuordnung_monat) = 1),
    woher TEXT NOT NULL CHECK (woher IN ('eingabe','import')),
    urheber JSONB NOT NULL,
    korrektur TEXT,
    eingetragen_am TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, quelle_id, zeitpunkt, fassung),
    FOREIGN KEY (quelle_id, tenant_id) REFERENCES messstelle_quelle(id, tenant_id) ON DELETE RESTRICT
);
ALTER TABLE messstelle_ablesung_fassung ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_ablesung_fassung FORCE ROW LEVEL SECURITY;
CREATE POLICY messstelle_ablesung_fassung_tenant ON messstelle_ablesung_fassung
USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON messstelle_ablesung_fassung TO ${appDbUser};
GRANT SELECT, DELETE ON messstelle_ablesung_fassung TO ${adminDbUser};
-- Einziger Löschweg: das bestehende Offboarding des Kundenbereichs, nur Verwaltung.
CREATE FUNCTION uems_ablesungen_entfernen(p_tenant UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.device_measurement_sample WHERE tenant_id = p_tenant AND ablesung_quelle_id IS NOT NULL;
  DELETE FROM public.messstelle_ablesung_fassung WHERE tenant_id = p_tenant;
END $$;
REVOKE ALL ON FUNCTION uems_ablesungen_entfernen(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_ablesungen_entfernen(UUID) TO ${adminDbUser};

-- Nur der Raw-INSERT legt den Nachweis an. Kein zweiter Kundenschreibweg.
CREATE FUNCTION uems_ablesung_nachweis() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.ablesung_quelle_id IS NOT NULL THEN
    INSERT INTO public.messstelle_ablesung_fassung VALUES
      (NEW.tenant_id, NEW.ablesung_quelle_id, NEW.time, NEW.ablesung_fassung, NEW.ablesung_stand,
       NEW.zuordnung_monat, NEW.woher, NEW.urheber, NEW.ablesung_korrektur, NEW.received_at);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION uems_ablesung_nachweis() FROM PUBLIC;
CREATE TRIGGER uems_ablesung_nachweis AFTER INSERT ON device_measurement_sample
FOR EACH ROW EXECUTE FUNCTION uems_ablesung_nachweis();
CREATE FUNCTION uems_ablesung_nachweis_unveraenderlich() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Der Ablesungsnachweis ist unveränderlich' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER uems_ablesung_nachweis_unveraenderlich BEFORE UPDATE ON messstelle_ablesung_fassung
FOR EACH ROW EXECUTE FUNCTION uems_ablesung_nachweis_unveraenderlich();

CREATE FUNCTION uems_ablesung_rohwert_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q messstelle_quelle; letzte INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.ablesung_quelle_id IS NOT NULL THEN
    RAISE EXCEPTION 'Eine Ablesung wird nie überschrieben' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ablesung_quelle_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO q FROM messstelle_quelle WHERE id = NEW.ablesung_quelle_id AND tenant_id = NEW.tenant_id;
  IF q.art IS DISTINCT FROM 'ablesung' OR NEW.time < q.gueltig_ab
     OR (q.gueltig_bis IS NOT NULL AND NEW.time >= q.gueltig_bis) THEN
    RAISE EXCEPTION 'Keine Ablesungsquelle zur Messzeit' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ablesung:' || q.id, 0));
  SELECT max(fassung) INTO letzte FROM messstelle_ablesung_fassung
    WHERE tenant_id = NEW.tenant_id AND quelle_id = q.id AND zeitpunkt = NEW.time;
  IF NEW.ablesung_fassung <> coalesce(letzte, 0) + 1 THEN
    RAISE EXCEPTION 'Ablesungs-Fassung folgt nicht lückenlos' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER uems_ablesung_rohwert_pruefen BEFORE INSERT OR UPDATE ON device_measurement_sample
FOR EACH ROW EXECUTE FUNCTION uems_ablesung_rohwert_pruefen();

CREATE OR REPLACE FUNCTION uems_kanal_korrektur_reihen_gueltig(p_reihen JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  -- CASE statt AND/OR: SQL verspricht keine Auswertungsreihenfolge, und
  -- jsonb_array_elements/jsonb_object_keys werfen auf der falschen Form.
  SELECT CASE WHEN jsonb_typeof(p_reihen) IS DISTINCT FROM 'array' OR jsonb_array_length(p_reihen) = 0
              THEN false
         ELSE NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(p_reihen) r
                 WHERE CASE WHEN jsonb_typeof(r) <> 'object' THEN true
                       ELSE ARRAY(SELECT jsonb_object_keys(r) ORDER BY 1) <> ARRAY['entity_id', 'messkanal']
                            OR jsonb_typeof(r -> 'entity_id') <> 'string'
                            OR jsonb_typeof(r -> 'messkanal') <> 'string'
                            OR NOT (r ->> 'entity_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                            OR btrim(r ->> 'messkanal') = '' OR length(r ->> 'messkanal') > 240
                       END)
              AND (SELECT count(DISTINCT r) FROM jsonb_array_elements(p_reihen) r) = jsonb_array_length(p_reihen)
         END
$$;
CREATE OR REPLACE FUNCTION messreihe_korrektur_reihen_gueltig(p_reihen JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT uems_kanal_korrektur_reihen_gueltig(p_reihen) OR coalesce(CASE
    WHEN jsonb_typeof(p_reihen) = 'array' AND jsonb_array_length(p_reihen) = 1
         AND jsonb_typeof(p_reihen -> 0) = 'object' THEN
      ARRAY(SELECT jsonb_object_keys(p_reihen -> 0) ORDER BY 1) = ARRAY['groesse','messstelle_id','spur']
      AND p_reihen -> 0 ->> 'spur' = 'ablesung'
      AND btrim(p_reihen -> 0 ->> 'groesse') <> ''
      AND p_reihen -> 0 ->> 'messstelle_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ELSE false END, false)
$$;
ALTER TABLE messreihe_korrektur ADD CONSTRAINT messreihe_korrektur_ablesung_art_chk CHECK (
    NOT coalesce(reihen -> 0 ->> 'spur' = 'ablesung', false) OR art = 'ablesestaende_nachgetragen');

ALTER TABLE messreihe_periode ADD COLUMN ablesung BOOLEAN;
ALTER TABLE messreihe_periode DROP CONSTRAINT messreihe_periode_spur_chk;
ALTER TABLE messreihe_periode
    ADD CONSTRAINT messreihe_periode_spur_chk CHECK (
        (messstelle_id IS NULL AND formel_fassung_id IS NULL AND formel_typ IS NULL
         AND entity_id IS NOT NULL AND messkanal IS NOT NULL AND ablesung IS NULL
         AND teile_erwartet IS NOT NULL AND teile_vorhanden IS NOT NULL AND teile_endgueltig IS NOT NULL
         AND erhalten IS NOT NULL AND erwartet IS NOT NULL)
        OR
        (messstelle_id IS NOT NULL AND formel_fassung_id IS NOT NULL
         AND formel_typ IN ('gewichtete_summe', 'rest', 'saldo')
         AND entity_id IS NULL AND messkanal IS NULL
         AND teile_erwartet IS NULL AND teile_vorhanden IS NULL AND teile_endgueltig IS NULL
         AND erhalten IS NULL AND erwartet IS NULL
         AND wertart IS NULL AND energie IS NULL AND summe IS NULL AND ablesung IS NULL)
        OR (coalesce(ablesung, false) = true AND messstelle_id IS NOT NULL AND formel_fassung_id IS NULL AND formel_typ IS NULL
            AND entity_id IS NULL AND messkanal IS NULL AND wertart = 'counter'
            AND teile_erwartet IS NULL AND teile_vorhanden IS NULL AND teile_endgueltig IS NULL
            AND erhalten IS NULL AND erwartet IS NULL AND energie IS NULL AND summe IS NULL));
GRANT INSERT ON messreihe_periode, messreihe_periode_version TO ${appDbUser};
CREATE FUNCTION uems_ablesung_perioden_schreibgrenze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = '${appDbUser}' AND (NEW.entity_id IS NOT NULL OR NEW.wertart IS DISTINCT FROM 'counter'
      OR NOT EXISTS (
      SELECT 1 FROM messstelle_quelle q WHERE q.tenant_id = NEW.tenant_id AND q.messstelle_id = NEW.messstelle_id
      AND q.art = 'ablesung' AND q.rolle = 'fuehrend')) THEN
    RAISE EXCEPTION 'Der Eingabeweg schreibt nur Ablesungsperioden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER uems_ablesung_perioden_schreibgrenze BEFORE INSERT ON messreihe_periode
FOR EACH ROW EXECUTE FUNCTION uems_ablesung_perioden_schreibgrenze();
CREATE TRIGGER uems_ablesung_perioden_schreibgrenze BEFORE INSERT ON messreihe_periode_version
FOR EACH ROW EXECUTE FUNCTION uems_ablesung_perioden_schreibgrenze();

CREATE OR REPLACE FUNCTION messreihe_ereignis_vokabular()
RETURNS TABLE (art TEXT, urheber TEXT[], zeitform TEXT, grenzen TEXT, offen_erlaubt BOOLEAN,
               bezug_pflicht TEXT[], bezug_erlaubt TEXT[], pflicht TEXT[], felder TEXT[],
               fortschreibbar TEXT[], bestand BOOLEAN)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('data_gap', ARRAY['writer', 'box', 'cloud']::text[], 'zeitraum', 'halboffen', true,
     '{}'::text[], ARRAY['box', 'datenquelle', 'komponente', 'messkanal', 'messstelle']::text[],
     ARRAY['erkannt_aus']::text[],
     ARRAY['erwartet_fehlend', 'nachgeliefert_am', 'fehlerklasse', 'ursache_ereignis',
           'zuwachs', 'einheit', 'stand_vor', 'stand_nach']::text[],
     ARRAY['bis', 'erwartet_fehlend', 'nachgeliefert_am', 'ursache_ereignis',
           'zuwachs', 'einheit', 'stand_vor', 'stand_nach']::text[], true),
    ('backfill', ARRAY['writer', 'cloud']::text[], 'zeitraum', 'geschlossen', false,
     ARRAY['box', 'datenquelle']::text[], '{}'::text[],
     ARRAY['eingang_von', 'eingang_bis', 'anzahl']::text[],
     ARRAY['erwartet']::text[],
     '{}'::text[], false),
    ('duplicate_conflict', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'komponente', 'messkanal']::text[], ARRAY['messstelle']::text[],
     ARRAY['messzeit', 'gespeicherter_wert', 'abgewiesener_wert', 'sequenzen']::text[],
     ARRAY['einheit']::text[],
     '{}'::text[], false),
    ('sequence_gap', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'sequenz_erwartet', 'sequenz_erhalten', 'anzahl']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('sequence_reset', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'sequenz_erwartet', 'sequenz_erhalten']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('late_arrival', ARRAY['writer', 'cloud']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['eingangszeit', 'anzahl']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('counter_reset', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['stand_alt', 'stand_neu']::text[],
     ARRAY['messzeit_alt', 'einheit']::text[],
     '{}'::text[], true),
    ('counter_overflow', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['stand_alt', 'stand_neu', 'messzeit_alt', 'wertebereich_modul',
           'hoechstzuwachs_je_kadenz', 'kadenz_s']::text[],
     ARRAY['einheit']::text[],
     '{}'::text[], false),
    ('device_boundary', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente']::text[], ARRAY['messkanal', 'messstelle']::text[],
     ARRAY['anlass', 'einbau_alt', 'einbau_neu', 'eingetragen_am']::text[],
     ARRAY['endstand', 'anfangsstand', 'einheit', 'bestaetigt_ereignis']::text[],
     '{}'::text[], false),
    ('handover', ARRAY['cloud']::text[], 'zeitraum', 'halboffen', true,
     ARRAY['datenquelle']::text[], '{}'::text[],
     ARRAY['anlass', 'box_alt', 'box_neu']::text[],
     '{}'::text[],
     ARRAY['bis']::text[], false),
    ('unassigned_reader', ARRAY['writer']::text[], 'zeitraum', 'geschlossen', false,
     ARRAY['box', 'datenquelle', 'komponente']::text[], ARRAY['messkanal']::text[],
     ARRAY['anzahl']::text[],
     ARRAY['zustaendige_box']::text[],
     '{}'::text[], false),
    ('rejected', ARRAY['datenannahme', 'writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'grund']::text[],
     ARRAY['anzahl', 'sequenz']::text[],
     '{}'::text[], false),
    ('clock_ahead', ARRAY['datenannahme']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'vor_s']::text[],
     ARRAY['anzahl', 'sequenz']::text[],
     '{}'::text[], false),
    ('too_old', ARRAY['datenannahme']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'alter_s']::text[],
     ARRAY['anzahl', 'sequenz']::text[],
     '{}'::text[], false),
    ('clock_jump', ARRAY['datenannahme']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'sequenz', 'sprung_s']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('box_restart', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     '{}'::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('device_restart', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], '{}'::text[],
     '{}'::text[],
     ARRAY['herzschlag_vorher', 'herzschlag_nachher']::text[],
     '{}'::text[], false),
    ('frozen_source', ARRAY['box', 'writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], ARRAY['komponente', 'messkanal']::text[],
     '{}'::text[],
     ARRAY['lesungen', 'herzschlag']::text[],
     '{}'::text[], false),
    ('range_limit', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], ARRAY['komponente']::text[],
     '{}'::text[],
     ARRAY['statuswort']::text[],
     '{}'::text[], false),
    ('layout_changed', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], '{}'::text[],
     '{}'::text[],
     ARRAY['fassung_erwartet', 'fassung_gelesen', 'karten_erwartet', 'karten_gelesen']::text[],
     '{}'::text[], false),
    ('error_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('state_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('bitfield_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('text_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('substitute', ARRAY['kunde']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['messstelle']::text[],
     ARRAY['ersatzwert', 'methode', 'status']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('correction', ARRAY['cloud', 'kunde']::text[], 'zeitraum', 'halboffen', false,
     '{}'::text[], ARRAY['komponente', 'messkanal', 'messstelle', 'bezugsgroesse']::text[],
     ARRAY['korrektur', 'korrektur_art', 'status']::text[],
     ARRAY['ersatzwert', 'fassung_alt', 'fassung_neu', 'import']::text[],
     '{}'::text[], false),
    ('verteilung_geaendert', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['messstelle']::text[], '{}'::text[],
     ARRAY['eingetragen_am']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('bilanz_neu_berechnet', ARRAY['cloud']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['messstelle']::text[], '{}'::text[],
     ARRAY['ausloeser']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('bericht_freigegeben', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['bericht']::text[], '{}'::text[],
     ARRAY['nr', 'datenstand', 'pruefsumme']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('bericht_revision_angestossen', ARRAY['cloud']::text[], 'zeitpunkt', NULL, false,
     ARRAY['bericht']::text[], '{}'::text[],
     ARRAY['nr', 'anstoss_art', 'anlass_kennung']::text[],
     ARRAY['anlass_fassung']::text[],
     '{}'::text[], false),
    ('bericht_entwurf_neu_gebildet', ARRAY['cloud']::text[], 'zeitpunkt', NULL, false,
     ARRAY['bericht']::text[], '{}'::text[],
     ARRAY['datenstand']::text[],
     ARRAY['anlass_kennung']::text[],
     '{}'::text[], false),
    ('bericht_abgerufen', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['bericht']::text[], '{}'::text[],
     ARRAY['nr', 'format']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('kennzahl_neu_gebildet', ARRAY['cloud']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['kennzahl']::text[], '{}'::text[],
     ARRAY['ausloeser', 'version']::text[],
     '{}'::text[],
     '{}'::text[], false)
$$;
