-- AP-16 IP-3, B1/B4/B5: eigenes Objekt Prozess × Träger. Keine Bestandszeile wird geändert.
-- Tagesgültigkeit: gueltig_bis ist der letzte eingeschlossene Tag.
CREATE TABLE energieeinsatz_kennzeichen_seq (
    tenant_id UUID PRIMARY KEY REFERENCES tenant(id) ON DELETE RESTRICT,
    zaehler BIGINT NOT NULL CHECK (zaehler > 0)
);

CREATE TABLE energieeinsatz (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    kennzeichen TEXT NOT NULL,
    prozess_id UUID NOT NULL,
    traeger TEXT NOT NULL,
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    wortlaut TEXT,
    verbraucher_wortlaut TEXT,
    verantwortlich_sub TEXT,
    verantwortlich_name TEXT,
    verantwortlich_konto TEXT,
    gueltig_ab DATE NOT NULL,
    gueltig_bis DATE,
    beendet_am TIMESTAMPTZ,
    beendet_grund TEXT,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energieeinsatz_id_tenant_uq UNIQUE (id, tenant_id),
    CONSTRAINT energieeinsatz_kennzeichen_uq UNIQUE (tenant_id, kennzeichen),
    CONSTRAINT energieeinsatz_kennzeichen_chk CHECK (kennzeichen ~ '^EE-[1-9][0-9]{0,12}$'),
    CONSTRAINT energieeinsatz_prozess_fk FOREIGN KEY (prozess_id, tenant_id)
        REFERENCES prozess(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energieeinsatz_verantwortlich_fk FOREIGN KEY (tenant_id, verantwortlich_sub)
        REFERENCES benutzer(tenant_id, sub) ON DELETE RESTRICT,
    CONSTRAINT energieeinsatz_traeger_chk CHECK (traeger IN ('Strom', 'Gas', 'Wärme', 'Kälte', 'Wasser', 'Druckluft')),
    CONSTRAINT energieeinsatz_verantwortlich_chk CHECK (
        (verantwortlich_sub IS NULL OR (verantwortlich_name IS NOT NULL AND verantwortlich_konto IS NOT NULL))
        AND ((verantwortlich_name IS NULL) = (verantwortlich_konto IS NULL))
        AND (verantwortlich_name IS NULL OR btrim(verantwortlich_name) <> '')
        AND (verantwortlich_konto IS NULL OR btrim(verantwortlich_konto) <> '')),
    CONSTRAINT energieeinsatz_tage_chk CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    CONSTRAINT energieeinsatz_beendet_chk CHECK (
        (gueltig_bis IS NULL) = (beendet_am IS NULL)
        AND (beendet_am IS NULL) = (beendet_grund IS NULL)
        AND (beendet_grund IS NULL OR btrim(beendet_grund) <> '')),
    CONSTRAINT energieeinsatz_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energieeinsatz_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energieeinsatz_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE UNIQUE INDEX energieeinsatz_ein_laufender_uq
    ON energieeinsatz (tenant_id, prozess_id, traeger) WHERE gueltig_bis IS NULL;

-- Atomarer Zähler je Kundenbereich, auch explizite Kennzeichen rücken ihn vor.
CREATE FUNCTION energieeinsatz_kennzeichen_setzen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE nummer BIGINT;
BEGIN
    IF NEW.kennzeichen IS NULL THEN
        INSERT INTO energieeinsatz_kennzeichen_seq (tenant_id, zaehler) VALUES (NEW.tenant_id, 1)
            ON CONFLICT (tenant_id) DO UPDATE SET zaehler = energieeinsatz_kennzeichen_seq.zaehler + 1
            RETURNING zaehler INTO nummer;
        NEW.kennzeichen := 'EE-' || nummer;
    ELSIF NEW.kennzeichen ~ '^EE-[1-9][0-9]{0,12}$' THEN
        INSERT INTO energieeinsatz_kennzeichen_seq (tenant_id, zaehler)
            VALUES (NEW.tenant_id, substring(NEW.kennzeichen FROM 4)::bigint)
            ON CONFLICT (tenant_id) DO UPDATE SET zaehler = greatest(
                energieeinsatz_kennzeichen_seq.zaehler, EXCLUDED.zaehler);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER energieeinsatz_kennzeichen_setzen BEFORE INSERT ON energieeinsatz
    FOR EACH ROW EXECUTE FUNCTION energieeinsatz_kennzeichen_setzen();
CREATE TRIGGER energieeinsatz_kennzeichen_seq_rueckt_vor BEFORE UPDATE ON energieeinsatz_kennzeichen_seq
    FOR EACH ROW EXECUTE FUNCTION messstelle_kennzeichen_seq_rueckt_vor();

CREATE TABLE energieeinsatz_einflussgroesse (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    einsatz_id UUID NOT NULL,
    bezugsgroesse_id UUID,
    wortlaut TEXT,
    art TEXT NOT NULL CHECK (art IN ('produktion', 'betriebszeit', 'wetter', 'sonstige')),
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    aufgehoben_am TIMESTAMPTZ,
    CONSTRAINT energieeinsatz_einflussgroesse_einsatz_fk FOREIGN KEY (einsatz_id, tenant_id)
        REFERENCES energieeinsatz(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energieeinsatz_einflussgroesse_bezug_fk FOREIGN KEY (bezugsgroesse_id, tenant_id)
        REFERENCES bezugsgroesse(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energieeinsatz_einflussgroesse_genau_eins_chk CHECK (
        (bezugsgroesse_id IS NOT NULL AND wortlaut IS NULL)
        OR (bezugsgroesse_id IS NULL AND wortlaut IS NOT NULL AND btrim(wortlaut) <> ''))
);
CREATE UNIQUE INDEX energieeinsatz_einflussgroesse_position_uq
    ON energieeinsatz_einflussgroesse(tenant_id, einsatz_id, position) WHERE aufgehoben_am IS NULL;

CREATE TABLE energieeinsatz_aenderung (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    einsatz_id UUID NOT NULL,
    art TEXT NOT NULL CHECK (art IN ('angelegt', 'bearbeitet', 'verantwortlicher', 'einflussgroessen', 'beendet')),
    alt JSONB,
    neu JSONB,
    actor_sub TEXT,
    actor_name TEXT NOT NULL,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT energieeinsatz_aenderung_einsatz_fk FOREIGN KEY (einsatz_id, tenant_id)
        REFERENCES energieeinsatz(id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT energieeinsatz_aenderung_actor_art_chk CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT energieeinsatz_aenderung_actor_rolle_chk CHECK (actor_rolle IS NULL OR actor_rolle IN
        ('kundenadministrator', 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT energieeinsatz_aenderung_actor_chk CHECK (btrim(actor_name) <> ''
        AND (actor_sub IS NULL OR btrim(actor_sub) <> '') AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX energieeinsatz_aenderung_einsatz_idx ON energieeinsatz_aenderung(tenant_id, einsatz_id, created_at, id);

ALTER TABLE energieeinsatz ENABLE ROW LEVEL SECURITY;
ALTER TABLE energieeinsatz FORCE ROW LEVEL SECURITY;
CREATE POLICY energieeinsatz_tenant_isolation ON energieeinsatz
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE energieeinsatz_einflussgroesse ENABLE ROW LEVEL SECURITY;
ALTER TABLE energieeinsatz_einflussgroesse FORCE ROW LEVEL SECURITY;
CREATE POLICY energieeinsatz_einflussgroesse_tenant_isolation ON energieeinsatz_einflussgroesse
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE energieeinsatz_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE energieeinsatz_aenderung FORCE ROW LEVEL SECURITY;
CREATE POLICY energieeinsatz_aenderung_tenant_isolation ON energieeinsatz_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE energieeinsatz_kennzeichen_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE energieeinsatz_kennzeichen_seq FORCE ROW LEVEL SECURITY;
CREATE POLICY energieeinsatz_kennzeichen_seq_tenant_isolation ON energieeinsatz_kennzeichen_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Default-Grants vollständig zurücknehmen. Protokoll: nur lesen und anhängen.
REVOKE ALL ON energieeinsatz, energieeinsatz_einflussgroesse, energieeinsatz_aenderung,
    energieeinsatz_kennzeichen_seq FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON energieeinsatz, energieeinsatz_einflussgroesse, energieeinsatz_aenderung,
    energieeinsatz_kennzeichen_seq TO ${appDbUser};
GRANT UPDATE (name, wortlaut, verbraucher_wortlaut, verantwortlich_sub, verantwortlich_name,
    verantwortlich_konto, gueltig_bis, beendet_am, beendet_grund) ON energieeinsatz TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON energieeinsatz_einflussgroesse TO ${appDbUser};
GRANT UPDATE (zaehler) ON energieeinsatz_kennzeichen_seq TO ${appDbUser};
-- Nur das administrative Mandanten-Offboarding löscht: Kinder vor Einsatz, vor Benutzer/Prozess/Bezugsgröße.
GRANT SELECT, DELETE ON energieeinsatz, energieeinsatz_einflussgroesse, energieeinsatz_aenderung,
    energieeinsatz_kennzeichen_seq TO ${adminDbUser};
REVOKE ALL ON SEQUENCE energieeinsatz_aenderung_id_seq FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE energieeinsatz_aenderung_id_seq TO ${appDbUser}, ${adminDbUser};
