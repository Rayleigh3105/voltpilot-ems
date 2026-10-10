-- AP-06 IP-19: Nachfolger-Anmeldung. Keine Bestandszeile wird verändert.
ALTER TABLE device DROP CONSTRAINT device_ausgebaut_chk;
ALTER TABLE device ADD CONSTRAINT device_ausgebaut_chk
    CHECK ((status IN ('ausgebaut', 'retired')) = (ausgebaut_am IS NOT NULL));

-- Zugleich Protokoll und dauerhafter Zustellauftrag. Hardware-Beobachtungen und
-- historische Identitäten bleiben an der bisherigen Box.
CREATE TABLE device_succession (
    tenant_id UUID NOT NULL,
    old_device_id UUID NOT NULL,
    new_device_id UUID NOT NULL,
    site_id UUID NOT NULL,
    previous_site_id UUID NOT NULL,
    effective_at TIMESTAMPTZ NOT NULL,
    actor_sub TEXT,
    actor_name TEXT,
    actor_rolle TEXT,
    actor_art TEXT NOT NULL,
    transferred JSONB NOT NULL,
    delivered_at TIMESTAMPTZ,
    last_error TEXT,
    PRIMARY KEY (tenant_id, old_device_id),
    UNIQUE (tenant_id, new_device_id),
    CHECK (old_device_id <> new_device_id),
    CHECK (date_trunc('minute', effective_at AT TIME ZONE 'UTC') = effective_at AT TIME ZONE 'UTC')
);
ALTER TABLE device_succession ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_succession FORCE ROW LEVEL SECURITY;
CREATE POLICY device_succession_tenant ON device_succession
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON device_succession FROM ${appDbUser};
GRANT SELECT, INSERT ON device_succession TO ${appDbUser};
GRANT UPDATE (delivered_at, last_error) ON device_succession TO ${appDbUser};
GRANT SELECT, DELETE ON device_succession TO ${adminDbUser};

-- Dieselbe Box-Sperre wie Ausbau/Tausch: kein neuer Zeitraum kann zwischen
-- Zuständigkeitsprüfung und Retirement an der alten Box vorbeischreiben.
CREATE OR REPLACE FUNCTION uems_zustaendigkeit_box_pruefen() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE ausgebaut TIMESTAMPTZ;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.device_id = OLD.device_id
            AND NEW.tenant_id = OLD.tenant_id THEN
        RETURN NEW;
    END IF;
    SELECT d.ausgebaut_am INTO ausgebaut FROM device d
        WHERE d.id = NEW.device_id AND d.tenant_id = NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Box % gibt es in diesem Kundenbereich nicht', NEW.device_id
            USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'data_source_assignment_box_fk',
                  TABLE = 'data_source_assignment';
    END IF;
    IF ausgebaut IS NOT NULL THEN
        RAISE EXCEPTION 'Box % ist ausgebaut', NEW.device_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'data_source_assignment_box_ausgebaut',
                  TABLE = 'data_source_assignment';
    END IF;
    RETURN NEW;
END
$$;
