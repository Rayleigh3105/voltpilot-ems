-- =============================================================================
-- V20261026200000 - Werkstatt: Register der Boxen vor dem Versand und ihre Abnahme.
-- -----------------------------------------------------------------------------
-- Entscheid des Kapitäns vom 26.10.2026 (Bericht voltpilot-box-einrichtung-portal,
-- Abschnitt 3.5, erster Schnitt): eine Seite „Geräte › Werkstatt" führt durch
-- die Einrichtung einer Box und hält fest, was dabei herauskam.
--
--   werkstatt_box       das Register: eine Zeile je Box, die in der Werkstatt
--                       eingerichtet wird oder wurde. Referenz, Box-Art, das
--                       LAN-Netz, auf das die Box gestellt ist, und welche
--                       Schritte des Ablaufs wer wann abgehakt hat.
--   werkstatt_abnahme   das Abnahmeprotokoll (das „Übergabeprotokoll" der
--                       Werkstatt-Regel in edge-light/docs/mango.md):
--                       Host-Schlüssel, Fassung, die Prüfungen der Regel, die
--                       Werkstatt-Probe mit dem, was der Tunnel-Dienst zu ihr
--                       gemeldet hatte, wer, wann. Append-only.
--
-- GLOBALE Betriebsdaten wie fernwartung_*: eine Box in der Werkstatt gehört
-- noch keinem Mandanten, also kein tenant_id. Die App-Rolle bekommt KEIN Recht,
-- RLS ohne Policy ist der zweite Riegel. Gelesen und geschrieben wird nur über
-- die BYPASSRLS-Rolle voltpilot_admin aus platform-admin-Routen.
--
-- Kein Geheimnis in diesen Tabellen: das Root-Passwort entsteht im Browser
-- und geht nie an die API; gespeichert wird nur, DASS der Schritt erledigt ist.
-- =============================================================================

CREATE TABLE IF NOT EXISTS werkstatt_box (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    edge_ref          TEXT        NOT NULL UNIQUE,
    box_art           TEXT        NOT NULL DEFAULT 'edge-light',
    -- Die LAN-Adresse der Box mit Präfix (z. B. 10.213.0.1/24), sobald sie
    -- umgestellt ist; die API prüft Form und Lage.
    lan_netz          TEXT,
    -- Je Schritt des Ablaufs: {"<schritt>": {"am": "<Zeit>", "von": "<Name>"}}.
    schritte          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    notiz             TEXT,
    angelegt_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
    angelegt_von      TEXT        NOT NULL,
    angelegt_von_name TEXT,
    geaendert_am      TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_von     TEXT        NOT NULL,
    CONSTRAINT werkstatt_box_art_chk CHECK (box_art IN ('edge-light', 'edge-app')),
    CONSTRAINT werkstatt_box_ref_chk CHECK (length(btrim(edge_ref)) BETWEEN 3 AND 80),
    CONSTRAINT werkstatt_box_schritte_chk CHECK (jsonb_typeof(schritte) = 'object'),
    CONSTRAINT werkstatt_box_notiz_chk CHECK (notiz IS NULL OR length(notiz) <= 500)
);

CREATE TABLE IF NOT EXISTS werkstatt_abnahme (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    box_id           UUID        NOT NULL REFERENCES werkstatt_box (id),
    edge_ref         TEXT        NOT NULL,
    -- Fingerabdruck des Host-Schlüssels, wie ssh-keygen -lf ihn zeigt.
    host_schluessel  TEXT        NOT NULL,
    fassung          TEXT        NOT NULL,
    tunnel_adresse   INET        NOT NULL,
    lan_netz         TEXT        NOT NULL,
    -- Die Kennungen der Prüfungen, die abgehakt waren (Vektor:
    -- docs/contracts/werkstatt-pruefungen.json).
    pruefungen       JSONB       NOT NULL,
    -- Die Werkstatt-Probe: Fenster, Techniker, Zeiten und was der Tunnel-Dienst
    -- dazu gemeldet hatte - Anzeige, kein Beweis.
    probe            JSONB       NOT NULL,
    notiz            TEXT,
    erfasst_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
    erfasst_von      TEXT        NOT NULL,
    erfasst_von_name TEXT,
    CONSTRAINT werkstatt_abnahme_host_chk CHECK (host_schluessel ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
    CONSTRAINT werkstatt_abnahme_fassung_chk CHECK (fassung ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$'),
    CONSTRAINT werkstatt_abnahme_pruefungen_chk CHECK (jsonb_typeof(pruefungen) = 'array'),
    CONSTRAINT werkstatt_abnahme_probe_chk CHECK (jsonb_typeof(probe) = 'object'),
    CONSTRAINT werkstatt_abnahme_notiz_chk CHECK (notiz IS NULL OR length(notiz) <= 500)
);

CREATE INDEX IF NOT EXISTS idx_werkstatt_abnahme_box
    ON werkstatt_abnahme (box_id, erfasst_am DESC);

-- Ein Protokoll wird nicht nachträglich geändert: eine neue Abnahme ist eine
-- neue Zeile. Dieselbe Funktion wie fernwartung_protokoll.
DROP TRIGGER IF EXISTS werkstatt_abnahme_append_only ON werkstatt_abnahme;
CREATE TRIGGER werkstatt_abnahme_append_only BEFORE UPDATE OR DELETE ON werkstatt_abnahme
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- -----------------------------------------------------------------------------
-- Rechte: wie fernwartung_* (V20261007163700). Die App-Rolle bekommt nichts,
-- die Admin-Rolle, was die Routen brauchen: kein DELETE, an der Abnahme nur
-- Anhängen und Lesen.
-- -----------------------------------------------------------------------------
REVOKE ALL ON werkstatt_box, werkstatt_abnahme FROM ${appDbUser};
REVOKE ALL ON werkstatt_box, werkstatt_abnahme FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON werkstatt_box TO ${adminDbUser};
GRANT SELECT, INSERT ON werkstatt_abnahme TO ${adminDbUser};

ALTER TABLE werkstatt_box ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_box FORCE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_abnahme ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_abnahme FORCE ROW LEVEL SECURITY;
