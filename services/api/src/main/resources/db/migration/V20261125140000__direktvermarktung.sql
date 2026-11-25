-- =============================================================================
-- V20261125140000 - Direktvermarktung Stufe 3 (Cloud): der Anschluss einer
-- Anlage an einen Direktvermarkter (z. B. luox energy), Konzept
-- vp-direktvermarktung-konzept d2, Abschnitt 5.7, Entscheidungen E1-E6 = A.
--
-- Vier mandanteneigene Tabellen mit RLS + FORCE ROW LEVEL SECURITY:
--   direktvermarktung           - je Anlage ein Anschluss (Zustand, Zustimmung,
--                                  Start-/Enddatum); waehrend eines geplanten
--                                  Wechsels (Abschnitt 6 "Wechsel") darf der
--                                  alte und der neue Eintrag kurz nebeneinander
--                                  bestehen - "nie zwei aktiv" meint zwei ohne
--                                  geplantes Ende, nicht zwei Zeilen ueberhaupt.
--   direktvermarktung_zugang    - nur die Struktur fuer das Chiffrat der
--                                  Zugangsdatei; das Oeffnen der ZIP, die
--                                  Verschluesselung (AES-256-GCM,
--                                  VP_PARTNERZUGANG_SCHLUESSEL) und die
--                                  plattformweite Fingerabdruck-Pruefung sind
--                                  eigener, sicherheitskritischer Auftrag
--                                  (separate PR, Freigabe beim Captain) - diese
--                                  Migration legt nur die Spalten an, ohne eine
--                                  Mandantengrenze zu unterlaufen.
--   direktvermarktung_protokoll - append-only (Muster register_write_event,
--                                  V20260827000000): GRANT SELECT, INSERT,
--                                  REVOKE UPDATE, DELETE.
--   direktvermarktung_stand     - der letzte Herzschlag-Block der Box, nur
--                                  Anzeige; ohne Zeile zeigt das Portal "Stand
--                                  unbekannt" (Konzept 5.1 "Unbekannt ist keine
--                                  Null"). Geschrieben wird sie erst, sobald die
--                                  Box die Schnittstelle bedient (ausserhalb
--                                  dieses Auftrags - "Zustellung" ist
--                                  ausdruecklich nicht Teil dieser Stufe).
-- =============================================================================

CREATE TABLE IF NOT EXISTS direktvermarktung (
    id                   UUID        PRIMARY KEY,
    tenant_id            UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id              UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    -- Schluessel in den Partnerkatalog (catalog/direktvermarkter/<partner>.json, E6 = A). Kein
    -- Fremdschluessel: der Katalog ist eine Datei, keine Tabelle.
    partner              TEXT        NOT NULL,
    zustand              TEXT        NOT NULL DEFAULT 'entwurf',
    zustimmung_am        TIMESTAMPTZ,
    zustimmung_von       TEXT,
    zustimmung_rolle     TEXT,
    -- Die Textfassung, der zugestimmt wurde (F14 offen, trotzdem schon festgehalten).
    zustimmung_fassung   TEXT,
    startdatum           DATE,
    ende                 DATE,
    -- Ein geplanter Wechsel: der neue Eintrag verweist auf den, den er ablöst (Abschnitt 6 "Wechsel").
    folgt_auf            UUID REFERENCES direktvermarktung(id),
    revision             INTEGER     NOT NULL DEFAULT 1,
    erstellt_am          TIMESTAMPTZ NOT NULL DEFAULT now(),
    aktualisiert_am      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_direktvermarktung_zustand CHECK (zustand IN (
        'entwurf', 'wartet_auf_zugang', 'verbindet', 'wartet_auf_partner', 'verbunden', 'gestoert',
        'endet', 'beendet'))
);

CREATE INDEX IF NOT EXISTS idx_direktvermarktung_site ON direktvermarktung (site_id, erstellt_am DESC);
CREATE INDEX IF NOT EXISTS idx_direktvermarktung_tenant ON direktvermarktung (tenant_id, site_id);

-- "Ein Anschluss je Anlage, genau ein aktiver Partner" (5.1) UND "nie zwei aktiv" (Abschnitt 6):
-- hoechstens ein Eintrag je Anlage, der weder beendet noch schon auf ein Ende terminiert ist. Der
-- Wechsel selbst braucht zwei Zeilen (die alte mit `ende` gesetzt, die neue ohne) - die faengt diese
-- Regel bewusst nicht ab, die Reihenfolge dafuer haelt DirektvermarktungService.
CREATE UNIQUE INDEX IF NOT EXISTS ux_direktvermarktung_aktiv_ohne_ende
    ON direktvermarktung (site_id) WHERE zustand <> 'beendet' AND ende IS NULL;

CREATE TABLE IF NOT EXISTS direktvermarktung_zugang (
    id                      UUID        PRIMARY KEY,
    tenant_id               UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id                 UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    direktvermarktung_id    UUID        NOT NULL REFERENCES direktvermarktung(id) ON DELETE CASCADE,
    -- AES-256-GCM: Chiffrat und Nonce getrennt, der Schluessel kommt aus VP_PARTNERZUGANG_SCHLUESSEL
    -- (Umgebung, nie in der DB). Nur Zertifikat, Schluessel, CA und Gegenstelle/Port - nie das Passwort.
    chiffrat                BYTEA       NOT NULL,
    nonce                   BYTEA       NOT NULL,
    fingerabdruck           TEXT        NOT NULL,
    gueltig_bis             TIMESTAMPTZ,
    hochgeladen_am          TIMESTAMPTZ NOT NULL DEFAULT now(),
    hochgeladen_von         TEXT,
    zugestellt_am           TIMESTAMPTZ,
    zurueckgezogen_am       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_direktvermarktung_zugang_dv ON direktvermarktung_zugang (direktvermarktung_id);
CREATE INDEX IF NOT EXISTS idx_direktvermarktung_zugang_site ON direktvermarktung_zugang (site_id);
-- Absichtlich KEIN plattformweiter Unique-Index auf `fingerabdruck` hier: unter FORCE ROW LEVEL
-- SECURITY saehe ein Mandant mit einer schlichten WHERE-Pruefung nie das Zertifikat eines anderen
-- Mandanten, waehrend ein naiver Unique-Index ueber Mandantengrenzen hinweg schon durch die
-- Konfliktmeldung verraet, dass es anderswo existiert. "Plattformweit eindeutig ueber eine eigene,
-- nicht mandantenlesbare Pruefung" (5.7) ist deshalb Teil des separaten, sicherheitskritischen
-- Auftrags, der diese Tabelle tatsaechlich beschreibt.

CREATE TABLE IF NOT EXISTS direktvermarktung_protokoll (
    id                      BIGSERIAL   PRIMARY KEY,
    tenant_id               UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id                 UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    -- Kein Fremdschluessel auf direktvermarktung: ein geloeschter Entwurf darf sein eigenes Protokoll
    -- nicht mitreissen (Muster register_write_event.device_id).
    direktvermarktung_id    UUID,
    ereignis                TEXT        NOT NULL,
    von                     TEXT,
    rolle                   TEXT,
    daten                   JSONB,
    am                      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_direktvermarktung_protokoll_ereignis CHECK (ereignis IN (
        'gewaehlt', 'zugestimmt', 'zugang_hochgeladen', 'zugang_abgelehnt', 'zugang_zugestellt',
        'zugang_zurueckgezogen', 'zustand', 'startdatum_gesetzt', 'wechsel_geplant', 'beendet'))
);

CREATE INDEX IF NOT EXISTS idx_direktvermarktung_protokoll_site ON direktvermarktung_protokoll (site_id, am DESC);
CREATE INDEX IF NOT EXISTS idx_direktvermarktung_protokoll_dv ON direktvermarktung_protokoll (direktvermarktung_id)
    WHERE direktvermarktung_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS direktvermarktung_stand (
    site_id                 UUID        PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
    tenant_id               UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    tunnel_oben_seit        TIMESTAMPTZ,
    handshake_am            TIMESTAMPTZ,
    gegenstelle             TEXT,
    letzte_abfrage_am       TIMESTAMPTZ,
    abfragen_je_minute      NUMERIC(6, 2),
    letzte_schreibung_am    TIMESTAMPTZ,
    vorgabe_pct             INTEGER,
    lebenszeichen_am        TIMESTAMPTZ,
    einspeisung_w           INTEGER,
    erzeugung_w             INTEGER,
    netzbetreiber_pct       INTEGER,
    referenz_w              INTEGER,
    gemeldet_am             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Rechte + RLS (Muster V20261115230000__steuerweg.sql)
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON direktvermarktung         TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON direktvermarktung_zugang  TO ${appDbUser};
GRANT SELECT, INSERT                 ON direktvermarktung_protokoll TO ${appDbUser};
-- V2s ALTER DEFAULT PRIVILEGES gaebe der App-Rolle sonst auch UPDATE/DELETE - ein Protokoll, das sich
-- aendern liesse, waere keins (Muster register_write_event).
REVOKE UPDATE, DELETE ON direktvermarktung_protokoll FROM ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE direktvermarktung_protokoll_id_seq TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON direktvermarktung_stand   TO ${appDbUser};

ALTER TABLE direktvermarktung ENABLE ROW LEVEL SECURITY;
ALTER TABLE direktvermarktung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS direktvermarktung_isolation ON direktvermarktung;
CREATE POLICY direktvermarktung_isolation ON direktvermarktung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE direktvermarktung_zugang ENABLE ROW LEVEL SECURITY;
ALTER TABLE direktvermarktung_zugang FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS direktvermarktung_zugang_isolation ON direktvermarktung_zugang;
CREATE POLICY direktvermarktung_zugang_isolation ON direktvermarktung_zugang
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE direktvermarktung_protokoll ENABLE ROW LEVEL SECURITY;
ALTER TABLE direktvermarktung_protokoll FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS direktvermarktung_protokoll_isolation ON direktvermarktung_protokoll;
CREATE POLICY direktvermarktung_protokoll_isolation ON direktvermarktung_protokoll
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE direktvermarktung_stand ENABLE ROW LEVEL SECURITY;
ALTER TABLE direktvermarktung_stand FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS direktvermarktung_stand_isolation ON direktvermarktung_stand;
CREATE POLICY direktvermarktung_stand_isolation ON direktvermarktung_stand
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
