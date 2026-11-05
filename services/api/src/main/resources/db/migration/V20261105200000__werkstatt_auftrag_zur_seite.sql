-- =============================================================================
-- Werkstatt: Lauf-Seite (Konzept vp-werkstatt-lauf-seite, entschieden
-- 05.11.2026, E1 A und E2 A).
--
-- werkstatt_auftrag: „Nochmal versuchen“ aus dem Portal. Eine eingehende
-- Verbindung zum Werkstatt-Dienst gibt es nicht; der Dienst holt offene
-- Aufträge mit seiner Meldung der Ansicht ab (PUT /api/v1/werkstatt-dienst/
-- ansicht?auftraege=1). Ein Auftrag nennt nur den angehaltenen Lauf; was der
-- Dienst dann tut, entscheidet er selbst (nur Fälle ohne Handgriff an der Box,
-- er löscht nie etwas). abgeholt_am setzt die Abholung; sonst ändert sich
-- nichts, gelöscht wird nichts.
--
-- werkstatt_zur_seite: „Box zur Seite legen“, festgehalten mit Fall, Lösung,
-- Grund und Zeit. Append-only (nur SELECT, INSERT); ein Lauf höchstens einmal.
--
-- Globale Betriebsdaten wie werkstatt_lauf: keine Rechte für die App-Rolle,
-- RLS mit FORCE und ohne Policy, nur über voltpilot_admin.
-- =============================================================================

CREATE TABLE IF NOT EXISTS werkstatt_auftrag (
    id          UUID        PRIMARY KEY,
    art         TEXT        NOT NULL,
    lauf        TEXT        NOT NULL,
    erteilt_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    erteilt_von TEXT        NOT NULL,
    abgeholt_am TIMESTAMPTZ,
    CONSTRAINT werkstatt_auftrag_art_chk CHECK (art IN ('nochmal')),
    CONSTRAINT werkstatt_auftrag_lauf_chk CHECK (lauf ~ '^[A-Za-z0-9._:-]{1,80}$')
);
CREATE INDEX IF NOT EXISTS idx_werkstatt_auftrag_offen ON werkstatt_auftrag (erteilt_am) WHERE abgeholt_am IS NULL;

CREATE TABLE IF NOT EXISTS werkstatt_zur_seite (
    id            UUID        PRIMARY KEY,
    lauf          TEXT        NOT NULL UNIQUE,
    box           TEXT,
    fall          TEXT,
    loesung_titel TEXT,
    schritt       TEXT,
    grund         TEXT,
    gelegt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    gelegt_von    TEXT        NOT NULL,
    CONSTRAINT werkstatt_zur_seite_lauf_chk CHECK (lauf ~ '^[A-Za-z0-9._:-]{1,80}$')
);
CREATE INDEX IF NOT EXISTS idx_werkstatt_zur_seite_gelegt ON werkstatt_zur_seite (gelegt_am DESC);

REVOKE ALL ON werkstatt_auftrag FROM ${appDbUser};
REVOKE ALL ON werkstatt_auftrag FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON werkstatt_auftrag TO ${adminDbUser};

REVOKE ALL ON werkstatt_zur_seite FROM ${appDbUser};
REVOKE ALL ON werkstatt_zur_seite FROM ${adminDbUser};
GRANT SELECT, INSERT ON werkstatt_zur_seite TO ${adminDbUser};

ALTER TABLE werkstatt_auftrag ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_auftrag FORCE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_zur_seite ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_zur_seite FORCE ROW LEVEL SECURITY;
