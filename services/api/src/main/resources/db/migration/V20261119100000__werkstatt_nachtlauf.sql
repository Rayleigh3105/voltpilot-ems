-- =============================================================================
-- Werkstatt: Nachtlauf (Konzept vp-update-vor-zuordnung, Entscheid des
-- Captains 18.11.2026: E3 = B, §11.2; Stufe S4).
--
-- Jede Nacht zwischen 02:00 und 05:00 Berliner Zeit legt der Takt
-- NachtlaufWatcher für wartende Boxen mit Tunnel denselben Auftrag
-- „aufspielen" an wie der Knopf (werkstatt_fernlauf, Akteur nachtlauf); dafür
-- braucht es keine neue Spalte.
--
-- werkstatt_nachtlauf_schalter: der Schalter des Betriebs auf Geräte › Updates
-- („Nachts von selbst: an · Anhalten"). Nur angehängt: jede Umstellung ist eine
-- Zeile mit dem Menschen, der umgelegt hat; es gilt die jüngste. Keine Zeile
-- heißt an (ab Werk an).
--
-- Globale Betriebsdaten wie werkstatt_fernlauf: keine Rechte für die App-Rolle,
-- RLS mit FORCE und ohne Policy, nur über voltpilot_admin.
-- =============================================================================

CREATE TABLE IF NOT EXISTS werkstatt_nachtlauf_schalter (
    id           UUID        PRIMARY KEY,
    an           BOOLEAN     NOT NULL,
    akteur_sub   TEXT        NOT NULL,
    akteur_name  TEXT,
    geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_werkstatt_nachtlauf_schalter_am ON werkstatt_nachtlauf_schalter (geaendert_am DESC);

CREATE OR REPLACE FUNCTION werkstatt_nachtlauf_schalter_unveraenderlich() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'werkstatt_nachtlauf_schalter: eine Umstellung wird weder geändert noch gelöscht';
END;
$$;

DROP TRIGGER IF EXISTS werkstatt_nachtlauf_schalter_unveraenderlich ON werkstatt_nachtlauf_schalter;
CREATE TRIGGER werkstatt_nachtlauf_schalter_unveraenderlich BEFORE UPDATE OR DELETE ON werkstatt_nachtlauf_schalter
    FOR EACH ROW EXECUTE FUNCTION werkstatt_nachtlauf_schalter_unveraenderlich();

REVOKE ALL ON werkstatt_nachtlauf_schalter FROM ${appDbUser};
REVOKE ALL ON werkstatt_nachtlauf_schalter FROM ${adminDbUser};
GRANT SELECT, INSERT ON werkstatt_nachtlauf_schalter TO ${adminDbUser};

ALTER TABLE werkstatt_nachtlauf_schalter ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_nachtlauf_schalter FORCE ROW LEVEL SECURITY;
