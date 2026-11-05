-- Geräte & Updates G3: der Verlauf je Box.
--
-- Bis hierher gab es keinen: device_update_status wird bei jedem Herzschlag
-- ERSETZT (nur „was läuft JETZT"), und rollout_event ist ein globales Journal der
-- Portal-Handlungen ohne Geräte-Index. Was die BOX gemeldet hat - welcher Stand
-- wann lief, welches Ziel sie angenommen oder abgelehnt hat, wann ein Update
-- fehlschlug oder zurückgenommen wurde - ging mit dem nächsten Herzschlag
-- verloren.
--
-- box_update_verlauf hält genau diese WECHSEL fest, NUR ANHÄNGEND:
--   art = 'stand'   - der laufende Stempel wechselt (wert = neu, vorher = alt;
--                     vorher NULL = erste Meldung der Box)
--   art = 'urteil'  - das Prüfurteil der Box zu einem Ziel wechselt
--                     (ziel, wert = ok | deferred | rejected, grund)
--   art = 'zustand' - der Update-Zustand wird failed oder rolled_back
--                     (ziel, wert, grund)
-- am ist Serverzeit (eine Uhr mit device_update_target und den drei Fakten).
--
-- Geschrieben wird von EINEM Trigger auf device_update_status: er sieht OLD und
-- NEW unter der Zeilensperre, also schreibt auch ein zweiter api-Pod, der
-- denselben Herzschlag verarbeitet, keinen doppelten Eintrag. Er läuft als die
-- aufrufende Rolle (der Ingest unter der App-Rolle mit dem Mandanten des Topics);
-- die Policy unten prüft deshalb tenant_id = Sitzungs-Mandant = NEW.tenant_id.
-- Ältere api-Pods (rollender Wechsel) schreiben device_update_status unverändert
-- weiter - der Trigger hängt trotzdem an; nichts an ihnen bricht.
--
-- Die Mandanten-Löschung findet die Tabelle über ihre tenant_id-Spalte von selbst
-- (TenantRepository, information_schema).
CREATE TABLE IF NOT EXISTS box_update_verlauf (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  UUID        NOT NULL,
    device_id  UUID        NOT NULL,
    am         TIMESTAMPTZ NOT NULL DEFAULT now(),
    art        TEXT        NOT NULL,
    wert       TEXT,
    vorher     TEXT,
    ziel       TEXT,
    grund      TEXT,
    CONSTRAINT box_update_verlauf_art_chk CHECK (art IN ('stand', 'urteil', 'zustand'))
);

CREATE INDEX IF NOT EXISTS idx_box_update_verlauf_geraet
    ON box_update_verlauf (device_id, am DESC);

-- Nur anhängen: die App-Rolle liest und hängt an (der Trigger läuft unter ihr),
-- die Admin-Rolle liest (Route je Box) und löscht nur mit dem Mandanten.
GRANT SELECT, INSERT ON box_update_verlauf TO ${appDbUser};
REVOKE UPDATE, DELETE ON box_update_verlauf FROM ${appDbUser};
REVOKE UPDATE ON box_update_verlauf FROM ${adminDbUser};

ALTER TABLE box_update_verlauf ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_update_verlauf FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS box_update_verlauf_isolation ON box_update_verlauf;
CREATE POLICY box_update_verlauf_isolation ON box_update_verlauf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION box_update_verlauf_mitschreiben() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    lief_alt TEXT;
    lief_neu TEXT := COALESCE(NEW.current_version, NEW.version);
BEGIN
    IF TG_OP = 'UPDATE' THEN
        lief_alt := COALESCE(OLD.current_version, OLD.version);
    END IF;
    IF lief_neu IS NOT NULL AND lief_neu IS DISTINCT FROM lief_alt THEN
        INSERT INTO box_update_verlauf (tenant_id, device_id, art, wert, vorher)
        VALUES (NEW.tenant_id, NEW.device_id, 'stand', lief_neu, lief_alt);
    END IF;
    IF NEW.target_verdict IS NOT NULL AND (TG_OP = 'INSERT'
            OR NEW.target_verdict IS DISTINCT FROM OLD.target_verdict
            OR NEW.target_version IS DISTINCT FROM OLD.target_version) THEN
        INSERT INTO box_update_verlauf (tenant_id, device_id, art, wert, ziel, grund)
        VALUES (NEW.tenant_id, NEW.device_id, 'urteil', NEW.target_verdict, NEW.target_version,
                CASE WHEN NEW.target_verdict <> 'ok' THEN NEW.reason END);
    END IF;
    IF NEW.state IN ('failed', 'rolled_back') AND (TG_OP = 'INSERT'
            OR NEW.state IS DISTINCT FROM OLD.state) THEN
        INSERT INTO box_update_verlauf (tenant_id, device_id, art, wert, ziel, grund)
        VALUES (NEW.tenant_id, NEW.device_id, 'zustand', NEW.state, NEW.target_version, NEW.reason);
    END IF;
    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS box_update_verlauf_mitschreiben ON device_update_status;
CREATE TRIGGER box_update_verlauf_mitschreiben
    AFTER INSERT OR UPDATE ON device_update_status
    FOR EACH ROW EXECUTE FUNCTION box_update_verlauf_mitschreiben();

-- Der Geräte-Index des Portal-Journals: die Route je Box liest rollout_event
-- nach device_id (bisher nur nach Zeit und Lauf indiziert).
CREATE INDEX IF NOT EXISTS idx_rollout_event_device
    ON rollout_event (device_id, at DESC) WHERE device_id IS NOT NULL;
