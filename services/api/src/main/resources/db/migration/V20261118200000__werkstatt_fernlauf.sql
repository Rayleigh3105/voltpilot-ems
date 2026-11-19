-- =============================================================================
-- Werkstatt: Fernlauf durch den Wartungstunnel (Konzept
-- vp-update-vor-zuordnung, entschieden 18.11.2026: E1 = A, E2 = A; Stufe S1).
--
-- werkstatt_fernlauf: ein Auftrag „aufspielen“ für eine Box ohne Kundenkonto.
-- Die API legt ihn an (Knopf in der Geräteakte, später auch Sammel- und
-- Nachtlauf), öffnet dafür ein Fenster für den Techniker-Zugang des
-- Werkstatt-Dienstes und nennt den Auslöser als Akteur (akteur_sub,
-- akteur_name), nie fest „Admin“. Der Dienst holt den Auftrag mit seiner
-- Meldung der Ansicht ab, nimmt ihn an (begonnen_am) und meldet je Schritt
-- (schritt, schritt_seit, schritte). Fassung, Quelle und Prüfsummen stehen
-- fest am Auftrag (aus dem signierten Manifest der neuesten Fassung, wie die
-- Freigabe der Werkstatt); der Dienst prüft sie gegen die Signatur. Geändert werden nur diese Spalten des
-- Fortschritts; gelöscht wird nichts.
--
-- werkstatt_fernlauf_ergebnis: das Ergebnis, je Auftrag genau eine Zeile, nur
-- angehängt (wie die Abnahme mit quelle dienst): Fassung vorher und nachher,
-- Ergebnis, Grund, Belege. quelle portal: die API hat einen Auftrag beendet,
-- den der Dienst nie angenommen oder nie zu Ende gemeldet hat.
--
-- Globale Betriebsdaten wie werkstatt_auftrag: keine Rechte für die App-Rolle,
-- RLS mit FORCE und ohne Policy, nur über voltpilot_admin.
-- =============================================================================

CREATE TABLE IF NOT EXISTS werkstatt_fernlauf (
    id              UUID        PRIMARY KEY,
    edge_ref        TEXT        NOT NULL,
    art             TEXT        NOT NULL,
    fassung_vorher  TEXT,
    fassung_ziel    TEXT        NOT NULL,
    release_seq     BIGINT      NOT NULL,
    quelle          TEXT        NOT NULL,
    programm_sha256 TEXT        NOT NULL,
    skripte_sha256  TEXT        NOT NULL,
    fenster_id      UUID        NOT NULL REFERENCES fernwartung_fenster (id),
    akteur_sub      TEXT        NOT NULL,
    akteur_name     TEXT,
    erteilt_am      TIMESTAMPTZ NOT NULL DEFAULT now(),
    begonnen_am     TIMESTAMPTZ,
    schritt         TEXT,
    schritt_seit    TIMESTAMPTZ,
    schritte        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    gemeldet_am     TIMESTAMPTZ,
    CONSTRAINT werkstatt_fernlauf_art_chk CHECK (art IN ('aufspielen')),
    CONSTRAINT werkstatt_fernlauf_ref_chk CHECK (edge_ref ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
    CONSTRAINT werkstatt_fernlauf_fassung_chk CHECK (length(fassung_ziel) BETWEEN 1 AND 64
        AND (fassung_vorher IS NULL OR length(fassung_vorher) BETWEEN 1 AND 64)),
    CONSTRAINT werkstatt_fernlauf_sha_chk CHECK (programm_sha256 ~ '^[0-9a-f]{64}$'
        AND skripte_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT werkstatt_fernlauf_quelle_chk CHECK (quelle ~ '^https?://'),
    CONSTRAINT werkstatt_fernlauf_schritte_chk CHECK (jsonb_typeof(schritte) = 'array')
);
CREATE INDEX IF NOT EXISTS idx_werkstatt_fernlauf_ref ON werkstatt_fernlauf (edge_ref, erteilt_am DESC);
CREATE INDEX IF NOT EXISTS idx_werkstatt_fernlauf_offen ON werkstatt_fernlauf (erteilt_am) WHERE begonnen_am IS NULL;

CREATE TABLE IF NOT EXISTS werkstatt_fernlauf_ergebnis (
    fernlauf_id     UUID        PRIMARY KEY REFERENCES werkstatt_fernlauf (id),
    edge_ref        TEXT        NOT NULL,
    ergebnis        TEXT        NOT NULL,
    grund           TEXT,
    schritt         TEXT,
    fassung_vorher  TEXT,
    fassung_nachher TEXT,
    belege          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    quelle          TEXT        NOT NULL,
    erfasst_am      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT werkstatt_fernlauf_ergebnis_chk CHECK (ergebnis IN ('fertig', 'zurueck', 'unveraendert', 'offen')),
    CONSTRAINT werkstatt_fernlauf_ergebnis_quelle_chk CHECK (quelle IN ('dienst', 'portal')),
    CONSTRAINT werkstatt_fernlauf_ergebnis_belege_chk CHECK (jsonb_typeof(belege) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_werkstatt_fernlauf_ergebnis_ref ON werkstatt_fernlauf_ergebnis (edge_ref, erfasst_am DESC);

CREATE OR REPLACE FUNCTION werkstatt_fernlauf_ergebnis_unveraenderlich() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'werkstatt_fernlauf_ergebnis: ein Ergebnis wird weder geändert noch gelöscht';
END;
$$;

DROP TRIGGER IF EXISTS werkstatt_fernlauf_ergebnis_unveraenderlich ON werkstatt_fernlauf_ergebnis;
CREATE TRIGGER werkstatt_fernlauf_ergebnis_unveraenderlich BEFORE UPDATE OR DELETE ON werkstatt_fernlauf_ergebnis
    FOR EACH ROW EXECUTE FUNCTION werkstatt_fernlauf_ergebnis_unveraenderlich();

REVOKE ALL ON werkstatt_fernlauf FROM ${appDbUser};
REVOKE ALL ON werkstatt_fernlauf FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON werkstatt_fernlauf TO ${adminDbUser};

REVOKE ALL ON werkstatt_fernlauf_ergebnis FROM ${appDbUser};
REVOKE ALL ON werkstatt_fernlauf_ergebnis FROM ${adminDbUser};
GRANT SELECT, INSERT ON werkstatt_fernlauf_ergebnis TO ${adminDbUser};

ALTER TABLE werkstatt_fernlauf ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_fernlauf FORCE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_fernlauf_ergebnis ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_fernlauf_ergebnis FORCE ROW LEVEL SECURITY;
