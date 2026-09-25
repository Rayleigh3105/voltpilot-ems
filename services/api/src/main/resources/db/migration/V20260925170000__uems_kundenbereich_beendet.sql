-- =============================================================================
-- UEMS AP-20 IP-16 — Vertragsende I: der Zustand „beendet" am Kundenbereich (E10 = A, BT4, RF-08).
--
-- Der Kundenbereich ist die Zeile in `tenant`. „aktiv" heißt: `beendet_am IS NULL`; „beendet" heißt:
-- alle drei Spalten tragen einen Wert. Es gibt bewusst KEINE Zustandsspalte mit Default — sie trüge in
-- jeder Bestandszeile einen Wert, und der Bestandsschutz der Migrationsnachbarn zählt das zu Recht als
-- geänderte Zeile. Ein „geloescht" steht nie hier: die Zeile verschwindet mit dem Löschweg; den
-- Nachweis darüber schreibt IP-18 (`mandant_loeschnachweis`).
--
-- Übergänge (§5.6) nur über die Plattform-Routen `…/admin/tenants/{id}/beenden|wiederaufnehmen`:
--   aktiv → beendet  (Auftrag, Begründung, Name eintippen, Frist in Tagen — Startwert 90)
--   beendet → aktiv  (Auftrag, Begründung — eine Wiederaufnahme ist kein neuer Kundenbereich)
-- Jeder Übergang ist EINMALIG: ein beendeter Kundenbereich wird nie umgeschrieben (neuer Zeitpunkt,
-- andere Frist), nur wieder aufgenommen und dann neu beendet — der Trigger unten hält das auch gegen
-- einen Weg, der nicht über die Routen geht. Die App-Rolle ändert die Spalten nie.
--
-- Das Protokoll `kundenbereich_uebergang` ist das Plattform-Protokoll der Übergänge: append-only, nur
-- die Admin-Rolle liest und schreibt (SELECT, INSERT). Es geht mit dem Kundenbereich (FK CASCADE) —
-- der Löschweg bleibt in IP-16 unverändert; was nach dem Löschen bleibt, sagt IP-18.
-- =============================================================================

ALTER TABLE tenant ADD COLUMN IF NOT EXISTS beendet_am TIMESTAMPTZ;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS beendet_frist_tage INTEGER;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS beendet_von TEXT;

ALTER TABLE tenant DROP CONSTRAINT IF EXISTS tenant_beendet_chk;
ALTER TABLE tenant ADD CONSTRAINT tenant_beendet_chk CHECK (
    (beendet_am IS NULL AND beendet_frist_tage IS NULL AND beendet_von IS NULL)
    OR (beendet_am IS NOT NULL AND beendet_frist_tage > 0 AND btrim(beendet_von) <> ''));

CREATE OR REPLACE FUNCTION tenant_beendet_einmalig() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF (OLD.beendet_am, OLD.beendet_frist_tage, OLD.beendet_von)
            IS NOT DISTINCT FROM (NEW.beendet_am, NEW.beendet_frist_tage, NEW.beendet_von) THEN
        RETURN NEW;
    END IF;
    IF current_user = '${appDbUser}' THEN
        RAISE EXCEPTION 'Den Zustand eines Kundenbereichs ändert nur der Betrieb (%)', OLD.id
            USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'tenant_beendet_nur_betrieb';
    END IF;
    IF OLD.beendet_am IS NOT NULL AND NEW.beendet_am IS NOT NULL THEN
        RAISE EXCEPTION 'Ein beendeter Kundenbereich wird nicht umgeschrieben, nur wieder aufgenommen (%)', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'tenant_beendet_einmalig';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS tenant_beendet_einmalig ON tenant;
CREATE TRIGGER tenant_beendet_einmalig BEFORE UPDATE ON tenant
    FOR EACH ROW EXECUTE FUNCTION tenant_beendet_einmalig();

CREATE TABLE IF NOT EXISTS kundenbereich_uebergang (
    id            BIGSERIAL   PRIMARY KEY,
    tenant_id     UUID        NOT NULL,
    von           TEXT        NOT NULL,
    nach          TEXT        NOT NULL,
    auftrag       TEXT        NOT NULL,
    begruendung   TEXT        NOT NULL,
    frist_tage    INTEGER,
    akteur_sub    TEXT,
    akteur_name   TEXT        NOT NULL,
    zeitpunkt     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT kundenbereich_uebergang_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE CASCADE,
    CONSTRAINT kundenbereich_uebergang_richtung_chk
        CHECK ((von = 'aktiv' AND nach = 'beendet' AND frist_tage > 0)
               OR (von = 'beendet' AND nach = 'aktiv' AND frist_tage IS NULL)),
    CONSTRAINT kundenbereich_uebergang_pflicht_chk
        CHECK (btrim(auftrag) <> '' AND btrim(begruendung) <> '' AND btrim(akteur_name) <> ''
               AND (akteur_sub IS NULL OR akteur_sub <> ''))
);
CREATE INDEX IF NOT EXISTS idx_kundenbereich_uebergang_tenant
    ON kundenbereich_uebergang (tenant_id, zeitpunkt DESC, id DESC);

-- Mandantenzaun wie jede Tabelle mit tenant_id — die App-Rolle hat trotzdem kein Recht darauf.
ALTER TABLE kundenbereich_uebergang ENABLE ROW LEVEL SECURITY;
ALTER TABLE kundenbereich_uebergang FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kundenbereich_uebergang_tenant_isolation ON kundenbereich_uebergang;
CREATE POLICY kundenbereich_uebergang_tenant_isolation ON kundenbereich_uebergang
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON kundenbereich_uebergang FROM ${appDbUser};
GRANT SELECT, INSERT ON kundenbereich_uebergang TO ${adminDbUser};
REVOKE ALL ON SEQUENCE kundenbereich_uebergang_id_seq FROM ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE kundenbereich_uebergang_id_seq TO ${adminDbUser};
