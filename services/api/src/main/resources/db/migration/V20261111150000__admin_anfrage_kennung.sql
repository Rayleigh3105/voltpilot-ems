-- =============================================================================
-- V20261111150000 - Anfrage-Kennung (Idempotency-Key) fuer "Neuer Kunde"
-- (Befund vp-kundenakte-fremde-personen, Punkt 5: doppelter Kunde).
-- -----------------------------------------------------------------------------
-- POST /api/v1/admin/tenants hatte keine Anfrage-Kennung: ein Doppelklick oder
-- das Wiederholen nach einem Netzfehler legte denselben Kunden zweimal an
-- (tenant.name ist BEWUSST nicht eindeutig - zwei Privatkunden duerfen gleich
-- heissen, eine UNIQUE-Grenze waere fachlich falsch). Die Tabelle
-- anfrage_kennung (V20261023100000) ist je Kundenbereich geschluesselt und
-- braucht einen TenantContext - beim Anlegen eines Kunden gibt es den noch
-- nicht. Darum hier dieselbe Mechanik je BETREIBER-KONTO (akteur_sub).
--
-- Global ohne Mandant, wie plattform_braucht_dich_erledigt (V20261106170000):
-- keine Rechte fuer die App-Rolle, RLS mit FORCE und ohne Policy, gelesen und
-- geschrieben nur ueber die BYPASSRLS-Rolle voltpilot_admin.
-- =============================================================================

CREATE TABLE IF NOT EXISTS admin_anfrage_kennung (
    akteur_sub     TEXT         NOT NULL,
    route          TEXT         NOT NULL,
    kennung        TEXT         NOT NULL,
    fingerabdruck  TEXT         NOT NULL,
    status         SMALLINT     NOT NULL,
    antwort        TEXT         NOT NULL,
    angelegt_am    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (akteur_sub, route, kennung),
    CONSTRAINT admin_anfrage_kennung_laenge_chk CHECK (char_length(kennung) BETWEEN 8 AND 200)
);

REVOKE ALL ON admin_anfrage_kennung FROM ${appDbUser};
REVOKE ALL ON admin_anfrage_kennung FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_anfrage_kennung TO ${adminDbUser};

ALTER TABLE admin_anfrage_kennung ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_anfrage_kennung FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE admin_anfrage_kennung IS
    'Idempotency-Key der Plattform-Verwaltung je Betreiber-Konto und Route mit der gemerkten Antwort (24 h) - dieselbe Kennung legt nie doppelt an.';
