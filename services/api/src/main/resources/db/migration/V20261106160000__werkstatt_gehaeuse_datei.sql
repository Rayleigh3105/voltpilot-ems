-- =============================================================================
-- V20261106160000 - Die Box-Druckdatei des Gehäuses (3MF) im Portal.
-- -----------------------------------------------------------------------------
-- vp-mango-3mf-pro-box (Option B aus vp-mango-einrichtung-detailseite, PR 1674):
-- der Werkstatt-Dienst baut die Druckdatei MIT Referenz in Klarschrift und
-- QR-Code im Unterteil je Box selbst (services/werkstatt-dienst/internal/
-- gehaeuse, Konzept Schritt 19/P10, Entscheid 8) und lädt sie nach einem
-- Auftrag ohne Fehler zur API hoch. Die Karte „Gehäuse-Druckdatei (3MF)“ der
-- Werkstatt-Box-Seite bietet GENAU diese Datei zum Download an.
--
--   box_id          die Box des Registers (werkstatt_box); eine Zeile je Box,
--                   ein wiederholter Upload (Nachdruck, neuer Bau) überschreibt
--                   mit dem neueren Stand (kein Verlauf, kein append-only).
--   name            Dateiname wie der Dienst ihn liefert (gehaeuse-<ref>.3mf).
--   sha256, bytes   Prüfsumme und Größe, serverseitig aus den Bytes gebildet,
--                   nie vom Hochladenden übernommen.
--   daten           die Bytes; wenige MB (BYTEA, kein Teil-Upload nötig).
--
-- GLOBALE Betriebsdaten wie werkstatt_box: eine Box in der Werkstatt gehört
-- noch keinem Mandanten, also kein tenant_id. Die App-Rolle bekommt KEIN Recht,
-- RLS ohne Policy ist der zweite Riegel (dasselbe Muster wie V20261026200000).
-- =============================================================================

CREATE TABLE IF NOT EXISTS werkstatt_gehaeuse_datei (
    box_id          UUID        PRIMARY KEY REFERENCES werkstatt_box (id) ON DELETE CASCADE,
    edge_ref        TEXT        NOT NULL UNIQUE,
    name            TEXT        NOT NULL,
    sha256          TEXT        NOT NULL,
    bytes           BIGINT      NOT NULL CHECK (bytes > 0),
    daten           BYTEA       NOT NULL,
    hochgeladen_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    hochgeladen_von TEXT        NOT NULL,
    CONSTRAINT werkstatt_gehaeuse_datei_name_chk CHECK (name ~ '^[a-z0-9][a-z0-9._-]{2,119}\.3mf$'),
    CONSTRAINT werkstatt_gehaeuse_datei_sha_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT werkstatt_gehaeuse_datei_laenge_chk CHECK (octet_length(daten) = bytes)
);

REVOKE ALL ON werkstatt_gehaeuse_datei FROM ${appDbUser};
REVOKE ALL ON werkstatt_gehaeuse_datei FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON werkstatt_gehaeuse_datei TO ${adminDbUser};

ALTER TABLE werkstatt_gehaeuse_datei ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_gehaeuse_datei FORCE ROW LEVEL SECURITY;
