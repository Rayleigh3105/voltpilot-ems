-- AP-16 IP-8 / KR1: keine Bestandszeilen, Vorgabe erst beim ausdrücklichen Ändern sichern.
CREATE TABLE bewertung_kriterien_fassung (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    unternehmen_id UUID NOT NULL,
    fassung INTEGER NOT NULL CHECK (fassung > 0),
    werte JSONB NOT NULL CHECK (jsonb_typeof(werte) = 'object'),
    kriterien JSONB NOT NULL CHECK (jsonb_typeof(kriterien) = 'array' AND jsonb_array_length(kriterien) = 8),
    gueltig_ab DATE,
    begruendung TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL CHECK (btrim(actor_name) <> ''),
    actor_rolle TEXT,
    actor_art TEXT NOT NULL CHECK (actor_art IN ('kunde','unterstuetzung','voltpilot','notfall')),
    vieraugen BOOLEAN NOT NULL,
    freigabe_status TEXT NOT NULL CHECK (freigabe_status IN ('beantragt','freigegeben','abgelehnt')),
    entscheidung_sub TEXT,
    entscheidung_name TEXT,
    entscheidung_rolle TEXT,
    entscheidung_art TEXT,
    entschieden_am TIMESTAMPTZ,
    entscheidungs_begruendung TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    aufgehoben_am TIMESTAMPTZ,
    UNIQUE (tenant_id, unternehmen_id, fassung),
    FOREIGN KEY (unternehmen_id, tenant_id) REFERENCES unternehmen(id, tenant_id) ON DELETE RESTRICT,
    CHECK (fassung = 1 OR coalesce(btrim(begruendung) <> '', false)),
    CHECK (coalesce(btrim(actor_sub) <> '', false) OR actor_art = 'voltpilot'),
    CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator','energiemanager','bearbeiter','bedienberechtigt','leser','unterstuetzer','voltpilot_betrieb')),
    CHECK ((freigabe_status = 'freigegeben') = (gueltig_ab IS NOT NULL)),
    CHECK (vieraugen OR freigabe_status = 'freigegeben'),
    CHECK (aufgehoben_am IS NULL OR freigabe_status = 'freigegeben'),
    CHECK (coalesce(CASE WHEN vieraugen AND freigabe_status <> 'beantragt' THEN
        entscheidung_sub <> actor_sub AND btrim(entscheidung_sub) <> '' AND btrim(entscheidung_name) <> ''
        AND entscheidung_art IN ('kunde','unterstuetzung','voltpilot','notfall')
        AND entscheidung_rolle IN ('kundenadministrator','energiemanager') AND entschieden_am IS NOT NULL
        ELSE entscheidung_sub IS NULL AND entscheidung_name IS NULL AND entscheidung_rolle IS NULL
            AND entscheidung_art IS NULL AND entschieden_am IS NULL END, false)),
    CHECK (freigabe_status <> 'abgelehnt' OR coalesce(btrim(entscheidungs_begruendung) <> '', false))
);
CREATE UNIQUE INDEX bewertung_kriterien_wirksam ON bewertung_kriterien_fassung(tenant_id, unternehmen_id)
    WHERE freigabe_status = 'freigegeben' AND aufgehoben_am IS NULL;
CREATE UNIQUE INDEX bewertung_kriterien_beantragt ON bewertung_kriterien_fassung(tenant_id, unternehmen_id)
    WHERE freigabe_status = 'beantragt';

ALTER TABLE bewertung_kriterien_fassung ENABLE ROW LEVEL SECURITY;
ALTER TABLE bewertung_kriterien_fassung FORCE ROW LEVEL SECURITY;
CREATE POLICY bewertung_kriterien_tenant_isolation ON bewertung_kriterien_fassung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON bewertung_kriterien_fassung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON bewertung_kriterien_fassung TO ${appDbUser};
GRANT UPDATE (gueltig_ab, freigabe_status, entscheidung_sub, entscheidung_name, entscheidung_rolle,
    entscheidung_art, entschieden_am, entscheidungs_begruendung, aufgehoben_am)
    ON bewertung_kriterien_fassung TO ${appDbUser};
GRANT SELECT, DELETE ON bewertung_kriterien_fassung TO ${adminDbUser};

ALTER TABLE bewertung_aenderung DROP CONSTRAINT bewertung_aenderung_art_check;
ALTER TABLE bewertung_aenderung ADD CONSTRAINT bewertung_aenderung_art_check CHECK (art IN
    ('umfang_angelegt','umfang_geaendert','kriterien_angelegt','kriterien_geaendert',
     'kriterien_freigegeben','kriterien_abgelehnt'));
