-- AP-16 IP-19, P1/P2: Messbedarf am Energieeinsatz. Keine Bestandszeile wird angelegt.
CREATE TABLE messbedarf_kennzeichen_seq (
    tenant_id UUID PRIMARY KEY REFERENCES tenant(id) ON DELETE RESTRICT,
    zaehler BIGINT NOT NULL CHECK (zaehler > 0)
);

CREATE TABLE messbedarf (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen TEXT NOT NULL,
    einsatz_id UUID NOT NULL,
    wortlaut TEXT NOT NULL,
    ort TEXT,
    groesse TEXT,
    frist DATE,
    zustand TEXT NOT NULL DEFAULT 'offen',
    messstelle_id UUID,
    begruendung TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messbedarf_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT messbedarf_kennzeichen_uq UNIQUE (tenant_id, kennzeichen),
    CONSTRAINT messbedarf_kennzeichen_chk CHECK (kennzeichen ~ '^MB-[1-9][0-9]{0,12}$'),
    CONSTRAINT messbedarf_einsatz_fk FOREIGN KEY (einsatz_id, tenant_id)
        REFERENCES energieeinsatz(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messbedarf_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messbedarf_wortlaut_chk CHECK (btrim(wortlaut) <> ''),
    CONSTRAINT messbedarf_ort_chk CHECK (ort IS NULL OR btrim(ort) <> ''),
    CONSTRAINT messbedarf_groesse_chk CHECK (groesse IS NULL OR btrim(groesse) <> ''),
    CONSTRAINT messbedarf_zustand_chk CHECK (zustand IN ('offen', 'eingeloest', 'verworfen')),
    CONSTRAINT messbedarf_aufloesung_chk CHECK (
        (zustand = 'offen' AND messstelle_id IS NULL AND begruendung IS NULL)
        OR (zustand = 'eingeloest' AND messstelle_id IS NOT NULL AND begruendung IS NULL)
        OR (zustand = 'verworfen' AND messstelle_id IS NULL
            AND begruendung IS NOT NULL AND btrim(begruendung) <> '')),
    CONSTRAINT messbedarf_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT messbedarf_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT messbedarf_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX messbedarf_einsatz_idx ON messbedarf(tenant_id, einsatz_id, created_at, id);
CREATE INDEX messbedarf_messstelle_idx ON messbedarf(tenant_id, messstelle_id) WHERE messstelle_id IS NOT NULL;

CREATE FUNCTION messbedarf_kennzeichen_setzen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE nummer BIGINT;
BEGIN
    IF NEW.kennzeichen IS NULL THEN
        INSERT INTO messbedarf_kennzeichen_seq (tenant_id, zaehler) VALUES (NEW.tenant_id, 1)
            ON CONFLICT (tenant_id) DO UPDATE SET zaehler = messbedarf_kennzeichen_seq.zaehler + 1
            RETURNING zaehler INTO nummer;
        NEW.kennzeichen := 'MB-' || nummer;
    ELSIF NEW.kennzeichen ~ '^MB-[1-9][0-9]{0,12}$' THEN
        INSERT INTO messbedarf_kennzeichen_seq (tenant_id, zaehler)
            VALUES (NEW.tenant_id, substring(NEW.kennzeichen FROM 4)::bigint)
            ON CONFLICT (tenant_id) DO UPDATE SET zaehler = greatest(
                messbedarf_kennzeichen_seq.zaehler, EXCLUDED.zaehler);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER messbedarf_kennzeichen_setzen BEFORE INSERT ON messbedarf
    FOR EACH ROW EXECUTE FUNCTION messbedarf_kennzeichen_setzen();
CREATE TRIGGER messbedarf_kennzeichen_seq_rueckt_vor BEFORE UPDATE ON messbedarf_kennzeichen_seq
    FOR EACH ROW EXECUTE FUNCTION messstelle_kennzeichen_seq_rueckt_vor();

CREATE TABLE messbedarf_aenderung (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    messbedarf_id UUID NOT NULL,
    art TEXT NOT NULL CHECK (art IN ('erfasst', 'bearbeitet', 'eingeloest', 'verworfen')),
    alt JSONB,
    neu JSONB,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messbedarf_aenderung_bedarf_fk FOREIGN KEY (messbedarf_id, tenant_id)
        REFERENCES messbedarf(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messbedarf_aenderung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT messbedarf_aenderung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT messbedarf_aenderung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX messbedarf_aenderung_bedarf_idx
    ON messbedarf_aenderung(tenant_id, messbedarf_id, created_at, id);

ALTER TABLE messbedarf ENABLE ROW LEVEL SECURITY;
ALTER TABLE messbedarf FORCE ROW LEVEL SECURITY;
CREATE POLICY messbedarf_tenant_isolation ON messbedarf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE messbedarf_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE messbedarf_aenderung FORCE ROW LEVEL SECURITY;
CREATE POLICY messbedarf_aenderung_tenant_isolation ON messbedarf_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE messbedarf_kennzeichen_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE messbedarf_kennzeichen_seq FORCE ROW LEVEL SECURITY;
CREATE POLICY messbedarf_kennzeichen_seq_tenant_isolation ON messbedarf_kennzeichen_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON messbedarf, messbedarf_aenderung, messbedarf_kennzeichen_seq FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON messbedarf, messbedarf_aenderung, messbedarf_kennzeichen_seq TO ${appDbUser};
GRANT UPDATE (wortlaut, ort, groesse, frist, zustand, messstelle_id, begruendung,
    actor_sub, actor_name, actor_rolle, actor_art, updated_at) ON messbedarf TO ${appDbUser};
GRANT UPDATE (zaehler) ON messbedarf_kennzeichen_seq TO ${appDbUser};
GRANT SELECT, DELETE ON messbedarf, messbedarf_aenderung, messbedarf_kennzeichen_seq TO ${adminDbUser};
REVOKE ALL ON SEQUENCE messbedarf_aenderung_id_seq FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE messbedarf_aenderung_id_seq TO ${appDbUser}, ${adminDbUser};

-- Die beiden mit IP-3 reservierten Kundenereignisse werden additiv eingelöst.
ALTER FUNCTION messreihe_ereignis_vokabular() RENAME TO messreihe_ereignis_vokabular_vor_messbedarf;
CREATE FUNCTION messreihe_ereignis_vokabular()
RETURNS TABLE (art TEXT, urheber TEXT[], zeitform TEXT, grenzen TEXT, offen_erlaubt BOOLEAN,
               bezug_pflicht TEXT[], bezug_erlaubt TEXT[], pflicht TEXT[], felder TEXT[],
               fortschreibbar TEXT[], bestand BOOLEAN)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT * FROM messreihe_ereignis_vokabular_vor_messbedarf()
  UNION ALL VALUES
    ('messbedarf_erfasst', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['messbedarf']::text[], '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[], false),
    ('messbedarf_eingeloest', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['messbedarf', 'messstelle']::text[], '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[], false)
$$;

CREATE OR REPLACE FUNCTION messreihe_ereignis_urheber_erlaubt(p_art TEXT, p_urheber TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM messreihe_ereignis_vokabular() v
                 WHERE v.art = p_art AND p_urheber = ANY (v.urheber))
$$;
CREATE OR REPLACE FUNCTION messreihe_ereignis_zeit_erlaubt(
    p_art TEXT, p_urheber TEXT, p_zeit TIMESTAMPTZ, p_von TIMESTAMPTZ, p_bis TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE((SELECT CASE
      WHEN v.zeitform = 'zeitpunkt' THEN p_von IS NULL AND p_bis IS NULL
      WHEN p_von IS NULL OR p_zeit IS DISTINCT FROM p_von THEN false
      WHEN p_bis IS NULL THEN v.offen_erlaubt AND p_urheber <> 'box'
      WHEN v.grenzen = 'halboffen' THEN p_bis > p_von ELSE p_bis >= p_von END
    FROM messreihe_ereignis_vokabular() v WHERE v.art = p_art), false)
$$;
CREATE OR REPLACE FUNCTION messreihe_ereignis_bezug_erlaubt(
    p_art TEXT, p_kennungen JSONB, p_messkanal TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_kennungen) IS DISTINCT FROM 'object' THEN false ELSE
    NOT EXISTS (SELECT 1 FROM jsonb_each(p_kennungen) k
                WHERE k.key NOT IN ('box', 'datenquelle', 'komponente', 'messstelle', 'bezugsgroesse',
                                    'bericht', 'kennzahl', 'energieeinsatz', 'messbedarf')
                   OR jsonb_typeof(k.value) <> 'string')
    AND COALESCE((SELECT v.bezug_pflicht <@ b.bezug
                         AND b.bezug <@ (v.bezug_pflicht || v.bezug_erlaubt)
      FROM messreihe_ereignis_vokabular() v,
           LATERAL (SELECT ARRAY(SELECT jsonb_object_keys(p_kennungen))
             || CASE WHEN p_messkanal IS NULL THEN '{}'::text[] ELSE ARRAY['messkanal']::text[] END AS bezug) b
      WHERE v.art = p_art), false) END
$$;
CREATE OR REPLACE FUNCTION messreihe_ereignis_nutzlast_erlaubt(p_art TEXT, p_nutzlast JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_nutzlast) IS DISTINCT FROM 'object' THEN false ELSE
    COALESCE((SELECT v.pflicht <@ k.felder AND k.felder <@ (v.pflicht || v.felder)
      FROM messreihe_ereignis_vokabular() v,
           LATERAL (SELECT ARRAY(SELECT jsonb_object_keys(p_nutzlast)) AS felder) k
      WHERE v.art = p_art), false) END
$$;

ALTER TABLE messreihe_ereignis DROP CONSTRAINT messreihe_ereignis_art_chk;
ALTER TABLE messreihe_ereignis ADD CONSTRAINT messreihe_ereignis_art_chk CHECK (art IN (
    'data_gap', 'backfill', 'duplicate_conflict', 'sequence_gap', 'sequence_reset',
    'late_arrival', 'counter_reset', 'counter_overflow', 'device_boundary', 'handover',
    'unassigned_reader', 'rejected', 'clock_ahead', 'too_old', 'clock_jump', 'box_restart',
    'device_restart', 'frozen_source', 'range_limit', 'layout_changed', 'error_change',
    'state_change', 'bitfield_change', 'text_change', 'substitute', 'correction',
    'verteilung_geaendert', 'bilanz_neu_berechnet', 'bericht_freigegeben', 'bericht_revision_angestossen',
    'bericht_entwurf_neu_gebildet', 'bericht_abgerufen', 'kennzahl_neu_gebildet', 'einstufung_gesetzt',
    'messbedarf_erfasst', 'messbedarf_eingeloest'));
