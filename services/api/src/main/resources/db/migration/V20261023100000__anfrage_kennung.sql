-- =============================================================================
-- V20261023100000 - Anfrage-Kennung (Idempotency-Key) fuer das Anlegen
-- (Anlage-Flow a1, Befund B3, Untersuchung vp-anlage-flow-konzept §4).
-- -----------------------------------------------------------------------------
-- Ging die Antwort auf "Weiter" verloren, bat das Portal ums Wiederholen - und
-- das Wiederholen legte die Anlage doppelt an. Jetzt sendet das Portal je
-- Formular eine feste Kennung im Kopf "Idempotency-Key"; die api merkt sich
-- Kennung, Fingerabdruck der Anfrage und ihre Antwort je Kundenbereich und
-- Route und gibt bei derselben Kennung dieselbe Antwort zurueck, statt ein
-- zweites Mal anzulegen. Eine Kennung gilt 24 Stunden.
--
-- Spalten:
--   route          'POST /api/v1/sites', 'POST /api/v1/standorte'
--   kennung        der Kopf Idempotency-Key, wie der Client ihn sendet
--   fingerabdruck  SHA-256 der gelesenen Anfrage - dieselbe Kennung mit einer
--                  anderen Anfrage ist ein Fehler (422), nie eine Antwort
--   status         der HTTP-Status der gemerkten Antwort (201)
--   antwort        der Koerper der Antwort, wie er gesendet wurde (JSON-Text)
--
-- Rein additiv: neue Tabelle, nur die api liest und schreibt sie - RLS wie
-- jede mandanteneigene Tabelle.
-- =============================================================================

CREATE TABLE IF NOT EXISTS anfrage_kennung (
    tenant_id      UUID         NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    route          TEXT         NOT NULL,
    kennung        TEXT         NOT NULL,
    fingerabdruck  TEXT         NOT NULL,
    status         SMALLINT     NOT NULL,
    antwort        TEXT         NOT NULL,
    angelegt_am    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, route, kennung),
    CONSTRAINT anfrage_kennung_laenge_chk CHECK (char_length(kennung) BETWEEN 8 AND 200)
);

ALTER TABLE anfrage_kennung ENABLE ROW LEVEL SECURITY;
ALTER TABLE anfrage_kennung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anfrage_kennung_tenant_isolation ON anfrage_kennung;
CREATE POLICY anfrage_kennung_tenant_isolation ON anfrage_kennung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON anfrage_kennung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON anfrage_kennung TO ${appDbUser};
GRANT SELECT, DELETE ON anfrage_kennung TO ${adminDbUser};

COMMENT ON TABLE anfrage_kennung IS
    'Anlage-Flow a1 (B3): Idempotency-Key je Kundenbereich und Route mit der gemerkten Antwort (24 h) - dieselbe Kennung legt nie doppelt an.';
