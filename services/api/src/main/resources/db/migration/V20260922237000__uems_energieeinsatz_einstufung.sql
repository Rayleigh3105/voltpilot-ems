-- AP-16 IP-11, F1-F5: Eine Person stuft ein. Zahlen liefern nur den eingefrorenen Vorschlag.
CREATE TABLE energieeinsatz_einstufung (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    einsatz_id UUID NOT NULL,
    nummer INTEGER NOT NULL CHECK (nummer > 0),
    einstufung TEXT NOT NULL CHECK (einstufung IN ('wesentlich', 'nicht_wesentlich')),
    begruendung TEXT NOT NULL CHECK (btrim(begruendung) <> ''),
    herkunft JSONB NOT NULL CHECK (jsonb_typeof(herkunft) = 'object'),
    grund JSONB NOT NULL CHECK (jsonb_typeof(grund) = 'array'
        AND grund <@ '["K1", "K2", "K3", "K4"]'::jsonb),
    vorgeschlagen_ab DATE NOT NULL,
    gueltig_ab DATE,
    gueltig_bis DATE,
    rueckwirkend BOOLEAN NOT NULL,
    actor_sub TEXT NOT NULL CHECK (btrim(actor_sub) <> ''),
    actor_name TEXT NOT NULL CHECK (btrim(actor_name) <> ''),
    actor_rolle TEXT NOT NULL CHECK (actor_rolle IN ('kundenadministrator', 'energiemanager')),
    actor_art TEXT NOT NULL CHECK (actor_art IN ('kunde', 'unterstuetzung', 'notfall')),
    vieraugen BOOLEAN NOT NULL,
    freigabe_status TEXT NOT NULL CHECK (freigabe_status IN ('beantragt', 'freigegeben')),
    entscheidung_sub TEXT,
    entscheidung_name TEXT,
    entscheidung_rolle TEXT,
    entscheidung_art TEXT,
    entschieden_am TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energieeinsatz_einstufung_einsatz_fk FOREIGN KEY (einsatz_id, tenant_id)
        REFERENCES energieeinsatz(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energieeinsatz_einstufung_nummer_uq UNIQUE (tenant_id, einsatz_id, nummer),
    CONSTRAINT energieeinsatz_einstufung_tage_chk CHECK (
        gueltig_bis IS NULL OR (gueltig_ab IS NOT NULL AND gueltig_bis >= gueltig_ab)),
    CONSTRAINT energieeinsatz_einstufung_status_chk CHECK (
        (freigabe_status = 'freigegeben') = (gueltig_ab IS NOT NULL)
        AND (vieraugen OR freigabe_status = 'freigegeben')),
    CONSTRAINT energieeinsatz_einstufung_vieraugen_chk CHECK (coalesce(
        CASE WHEN vieraugen AND freigabe_status = 'freigegeben' THEN
            entscheidung_sub <> actor_sub AND btrim(entscheidung_sub) <> ''
            AND btrim(entscheidung_name) <> ''
            AND entscheidung_rolle IN ('kundenadministrator', 'energiemanager')
            AND entscheidung_art IN ('kunde', 'unterstuetzung', 'notfall')
            AND entschieden_am IS NOT NULL
        ELSE entscheidung_sub IS NULL AND entscheidung_name IS NULL
            AND entscheidung_rolle IS NULL AND entscheidung_art IS NULL AND entschieden_am IS NULL
        END, false))
);

CREATE UNIQUE INDEX energieeinsatz_einstufung_wirksam_uq
    ON energieeinsatz_einstufung (tenant_id, einsatz_id)
    WHERE freigabe_status = 'freigegeben' AND gueltig_bis IS NULL;
CREATE UNIQUE INDEX energieeinsatz_einstufung_beantragt_uq
    ON energieeinsatz_einstufung (tenant_id, einsatz_id)
    WHERE freigabe_status = 'beantragt';

ALTER TABLE energieeinsatz_einstufung ENABLE ROW LEVEL SECURITY;
ALTER TABLE energieeinsatz_einstufung FORCE ROW LEVEL SECURITY;
CREATE POLICY energieeinsatz_einstufung_tenant_isolation ON energieeinsatz_einstufung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON energieeinsatz_einstufung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON energieeinsatz_einstufung TO ${appDbUser};
GRANT UPDATE (gueltig_ab, gueltig_bis, rueckwirkend, freigabe_status,
    entscheidung_sub, entscheidung_name, entscheidung_rolle, entscheidung_art, entschieden_am)
    ON energieeinsatz_einstufung TO ${appDbUser};
GRANT SELECT, DELETE ON energieeinsatz_einstufung TO ${adminDbUser};

ALTER TABLE energieeinsatz_aenderung DROP CONSTRAINT energieeinsatz_aenderung_art_check;
ALTER TABLE energieeinsatz_aenderung ADD CONSTRAINT energieeinsatz_aenderung_art_check CHECK (art IN
    ('angelegt', 'bearbeitet', 'verantwortlicher', 'einflussgroessen', 'beendet',
     'einstufung_gesetzt', 'einstufung_bestaetigt'));

-- Die Reservierung aus AP-16 IP-3 wird ein Wort des gemeinsamen Ereignisvertrags.
ALTER FUNCTION messreihe_ereignis_vokabular() RENAME TO messreihe_ereignis_vokabular_vor_einstufung;
CREATE FUNCTION messreihe_ereignis_vokabular()
RETURNS TABLE (art TEXT, urheber TEXT[], zeitform TEXT, grenzen TEXT, offen_erlaubt BOOLEAN,
               bezug_pflicht TEXT[], bezug_erlaubt TEXT[], pflicht TEXT[], felder TEXT[],
               fortschreibbar TEXT[], bestand BOOLEAN)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT * FROM messreihe_ereignis_vokabular_vor_einstufung()
    UNION ALL
    SELECT 'einstufung_gesetzt', ARRAY['kunde']::text[], 'zeitpunkt', NULL::text, false,
        ARRAY['energieeinsatz']::text[], '{}'::text[],
        ARRAY['fassung', 'einstufung', 'gruende']::text[], '{}'::text[], '{}'::text[], false
$$;

CREATE OR REPLACE FUNCTION messreihe_ereignis_bezug_erlaubt(
    p_art TEXT, p_kennungen JSONB, p_messkanal TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_kennungen) IS DISTINCT FROM 'object' THEN false ELSE
    NOT EXISTS (SELECT 1 FROM jsonb_each(p_kennungen) k
                WHERE k.key NOT IN ('box', 'datenquelle', 'komponente', 'messstelle', 'bezugsgroesse',
                                    'bericht', 'kennzahl', 'energieeinsatz')
                   OR jsonb_typeof(k.value) <> 'string')
    AND COALESCE((
      SELECT v.bezug_pflicht <@ b.bezug AND b.bezug <@ (v.bezug_pflicht || v.bezug_erlaubt)
        FROM messreihe_ereignis_vokabular() v,
             LATERAL (SELECT ARRAY(SELECT jsonb_object_keys(p_kennungen))
                             || CASE WHEN p_messkanal IS NULL THEN '{}'::text[]
                                     ELSE ARRAY['messkanal']::text[] END AS bezug) b
       WHERE v.art = p_art), false)
  END
$$;

ALTER TABLE messreihe_ereignis DROP CONSTRAINT messreihe_ereignis_art_chk;
ALTER TABLE messreihe_ereignis ADD CONSTRAINT messreihe_ereignis_art_chk CHECK (art IN (
    'data_gap', 'backfill', 'duplicate_conflict', 'sequence_gap', 'sequence_reset',
    'late_arrival', 'counter_reset', 'counter_overflow', 'device_boundary', 'handover',
    'unassigned_reader', 'rejected', 'clock_ahead', 'too_old', 'clock_jump', 'box_restart',
    'device_restart', 'frozen_source', 'range_limit', 'layout_changed', 'error_change',
    'state_change', 'bitfield_change', 'text_change', 'substitute', 'correction',
    'verteilung_geaendert', 'bilanz_neu_berechnet', 'bericht_freigegeben', 'bericht_revision_angestossen',
    'bericht_entwurf_neu_gebildet', 'bericht_abgerufen', 'kennzahl_neu_gebildet', 'einstufung_gesetzt'));
