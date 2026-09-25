-- =============================================================================
-- UEMS AP-20 IP-17 — Vertragsende II: das Protokoll der Gesamtabzüge (E10 = A, BT4, RF-08).
--
-- Der Gesamtabzug (`GET /api/v1/unternehmen/abzug`) wird beim Abruf gebildet und NICHT gespeichert. Was bleibt, ist
-- diese Zeile je Abruf: wer, wann, in welchem Zustand des Kundenbereichs — und nach dem letzten Byte die Zahlen des
-- Abzugs mit der SHA-256 seines Manifests. Die Prüfsumme des letzten vollständigen Abzugs nimmt der Löschnachweis
-- von IP-18 auf (RF-08 Schritt 5).
--
-- Zwei Schritte, beide von der App-Rolle:
--   1. INSERT vor dem ersten Byte (begonnen) — scheitert er, verlässt keine Datei den Server;
--   2. EIN UPDATE nach dem Manifest (abgeschlossen): nur die fünf Abschluss-Spalten (Spalten-Recht), nur von leer
--      auf gefüllt (Trigger). Ein abgebrochener Abruf bleibt als „begonnen“ stehen.
-- Kein DELETE für die App-Rolle; die Zeilen gehen mit dem Kundenbereich (FK CASCADE) — der Löschweg bleibt
-- unverändert. Neue, leere Tabelle: der Bestandsschutz der Migrationsnachbarn verträgt sie.
-- =============================================================================

CREATE TABLE IF NOT EXISTS kundenbereich_abzug (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL,
    begonnen_am      TIMESTAMPTZ NOT NULL DEFAULT now(),
    akteur_sub       TEXT,
    akteur_name      TEXT        NOT NULL,
    -- Der Zustand des Kundenbereichs beim Abruf: der Abzug ist auch im Zustand „aktiv“ erlaubt (§8 IP-17).
    zustand          TEXT        NOT NULL,
    abgeschlossen_am TIMESTAMPTZ,
    dateien          INTEGER,
    zeilen           BIGINT,
    bytes            BIGINT,
    manifest_sha256  TEXT,
    CONSTRAINT kundenbereich_abzug_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE CASCADE,
    CONSTRAINT kundenbereich_abzug_zustand_chk CHECK (zustand IN ('aktiv', 'beendet')),
    CONSTRAINT kundenbereich_abzug_pflicht_chk
        CHECK (btrim(akteur_name) <> '' AND (akteur_sub IS NULL OR akteur_sub <> '')),
    CONSTRAINT kundenbereich_abzug_abschluss_chk CHECK (
        (abgeschlossen_am IS NULL AND dateien IS NULL AND zeilen IS NULL AND bytes IS NULL AND manifest_sha256 IS NULL)
        OR (abgeschlossen_am >= begonnen_am AND dateien > 0 AND zeilen >= 0 AND bytes > 0
            AND manifest_sha256 ~ '^[0-9a-f]{64}$'))
);
CREATE INDEX IF NOT EXISTS idx_kundenbereich_abzug_tenant
    ON kundenbereich_abzug (tenant_id, begonnen_am DESC);

-- Abgeschlossen wird genau einmal, und nur die Abschluss-Spalten ändern sich.
CREATE OR REPLACE FUNCTION kundenbereich_abzug_einmal_abschliessen() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.abgeschlossen_am IS NOT NULL
            OR (OLD.id, OLD.tenant_id, OLD.begonnen_am, OLD.akteur_sub, OLD.akteur_name, OLD.zustand)
               IS DISTINCT FROM (NEW.id, NEW.tenant_id, NEW.begonnen_am, NEW.akteur_sub, NEW.akteur_name, NEW.zustand) THEN
        RAISE EXCEPTION 'Ein Abruf des Gesamtabzugs wird nur einmal abgeschlossen und nie umgeschrieben (%)', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'kundenbereich_abzug_einmalig';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS kundenbereich_abzug_einmalig ON kundenbereich_abzug;
CREATE TRIGGER kundenbereich_abzug_einmalig BEFORE UPDATE ON kundenbereich_abzug
    FOR EACH ROW EXECUTE FUNCTION kundenbereich_abzug_einmal_abschliessen();

ALTER TABLE kundenbereich_abzug ENABLE ROW LEVEL SECURITY;
ALTER TABLE kundenbereich_abzug FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kundenbereich_abzug_tenant_isolation ON kundenbereich_abzug;
CREATE POLICY kundenbereich_abzug_tenant_isolation ON kundenbereich_abzug
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON kundenbereich_abzug FROM ${appDbUser};
GRANT SELECT, INSERT ON kundenbereich_abzug TO ${appDbUser};
GRANT UPDATE (abgeschlossen_am, dateien, zeilen, bytes, manifest_sha256) ON kundenbereich_abzug TO ${appDbUser};
GRANT SELECT ON kundenbereich_abzug TO ${adminDbUser};
