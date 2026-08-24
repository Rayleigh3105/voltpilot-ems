-- =============================================================================
-- V20260839000000 - cockpit_layout (Anwendungs-Programm Stufe 3), ADDITIVE.
-- -----------------------------------------------------------------------------
-- Der LAYOUT-SPEICHER des Cockpits (Scout vp-portal-zielbild-anwendungen §3.2 E,
-- Captain-Entscheide E1/E2/E4 vom 24.08.2026). Bis hierher war die Komposition
-- des Cockpits deterministisch und UNGESPEICHERT: `cockpitBlocks` + `BLOCK_ORDER`
-- + `leadSlot` entschieden alles, es gab weder Editor noch Ablage (§2.4). Ein
-- Kunde konnte eine Kachel nicht ausblenden, ein Betreiber fuer seine 20 Anlagen
-- nichts vorgeben.
--
--   E1: "Cockpit-Layout an der Anlage, Portfolio-Layout am Kunden, dazu eine
--        optionale kunden-weite Betreiber-Vorgabe fuer alle Anlagen (die
--        Anlagen-Vorgabe gewinnt)."
--   E2: "Kunde gewinnt (Eigen > Vorgabe > Preset > Katalog); Pflicht-Bausteine
--        sind Katalog-Eigenschaft, keine Admin-Sperre in V1; Layout je
--        ORGANISATION, nicht je Benutzer; Reset faellt auf die Vorgabe und sagt
--        das."
--
-- GESPEICHERT WIRD NUR ABSICHT, nie die abgeleitete Flaeche (die M3-Regel von
-- site_profile_state, hier woertlich uebernommen). Das Dokument nennt
-- Baustein-SCHLUESSEL und ihre relative Reihenfolge; WELCHE Bausteine eine
-- Anlage ueberhaupt hat, bleibt Anwendungen x Faehigkeiten und wird bei jedem
-- Rendern neu abgeleitet. Daraus folgen die zwei Eigenschaften, an denen alles
-- haengt:
--   * KEINE ZEILE = das heutige Verhalten, Zeichen fuer Zeichen. Jede
--     Bestandsanlage rendert nach dieser Migration exakt wie vorher
--     (Beweis: frontend/portal/src/migration.test.ts).
--   * Ein Baustein, dessen Anwendung gerade nicht aktiv ist, wird beim Rendern
--     STILL UEBERSPRUNGEN, seine Praeferenz bleibt aber gespeichert - ein
--     spaeteres Wiedereinschalten stellt das alte Bild her. Deshalb lehnt der
--     Schreibpfad einen momentan nicht verfuegbaren Baustein ausdruecklich
--     NICHT ab (er prueft Katalog-Zugehoerigkeit, Flaeche und die
--     Pflicht-Regel).
--
-- SCOPE-GENERISCH VON ANFANG AN (E1): `scope_kind` traegt heute 'site' (das
-- Anlagen-Cockpit) und 'tenant' (die kunden-weite Vorgabe des Betreibers);
-- `surface` traegt heute 'cockpit' und ist fuer 'portfolio' (Stufe 4)
-- vorbereitet. Beides ist ein CHECK und keine eigene Tabelle, weil die
-- Aufloesung fuer alle Faelle dieselbe ist - eine zweite Tabelle waere eine
-- zweite Wahrheit ueber denselben Vorgang.
--
-- ZWEI SCHICHTEN (`layer`), und die Reihenfolge ist die Rechte-Ordnung:
--   'vorgabe' - der Betreiber/Portal-Admin gestaltet den Normalfall (kunden-weit
--               ueber scope_kind='tenant', je Anlage ueber scope_kind='site').
--   'eigen'   - der Kunde. Er GEWINNT (E2); sein "Zuruecksetzen" ist ein DELETE
--               genau dieser Zeile und faellt damit auf die Vorgabe zurueck.
-- Eine dritte Schicht je BENUTZER ist additiv nachruestbar (scope_kind='user'),
-- wird aber erst gebraucht, wenn ein Betreiber viele Mitarbeiter mit
-- verschiedenen Rollen hat - heute ist ein Kunde eine Organisation mit wenigen
-- Konten (E2).
--
-- MANDANTENGEBUNDEN mit RLS + FORCE wie site_profile_state / flow_definition:
-- das sind KUNDENDATEN. Der Kunde schreibt sie ueber den RLS-gefencten
-- App-Datenpfad, ein Portal-Admin erreicht sie ueber den X-Tenant-Id-Umschalter
-- - kein BYPASSRLS, kein neuer Datenpfad. Die App-Rolle braucht hier auch
-- DELETE: der Reset IST ein Loeschen.
--
-- `updated_by` ist die Papier-Spur (das site_forecast_model_choice-Muster): wer
-- eine Vorgabe gemacht hat, ist die Frage, die im Supportfall gestellt wird.
--
-- Version ueber dem hoechsten ausgelieferten Stand (V20260838000000) - eine
-- Migration unterhalb des Stands einer langlebigen DB ist fuer Flyway
-- "out of order" und wird nie angewandt.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cockpit_layout (
    -- 'site' = eine Anlage, 'tenant' = die kunden-weite Vorgabe. Bewusst KEIN
    -- Fremdschluessel: die Spalte zeigt je nach Art auf zwei verschiedene
    -- Tabellen. Der Zaun ist die RLS-Policy plus die Existenzpruefung im
    -- Dienst, nicht die referenzielle Integritaet.
    scope_kind TEXT        NOT NULL CHECK (scope_kind IN ('site', 'tenant')),
    scope_id   UUID        NOT NULL,
    -- 'cockpit' = das Anlagen-Cockpit; 'portfolio' ist fuer Stufe 4 reserviert.
    surface    TEXT        NOT NULL CHECK (surface IN ('cockpit', 'portfolio')),
    layer      TEXT        NOT NULL CHECK (layer IN ('vorgabe', 'eigen')),
    -- {version:1, order:[…], hidden:[…], shown:[…], lead:…}. jsonb ist hier
    -- richtig (anders als bei einem SIGNIERTEN Dokument): es wird gelesen und
    -- neu geschrieben, nie byteweise verglichen.
    document   JSONB       NOT NULL,
    tenant_id  UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    -- JWT-sub des Schreibers; NULL nur, wenn kein Subject im Token stand.
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_kind, scope_id, surface, layer)
);

CREATE INDEX IF NOT EXISTS idx_cockpit_layout_scope
    ON cockpit_layout (scope_kind, scope_id, surface);

GRANT SELECT, INSERT, UPDATE, DELETE ON cockpit_layout TO ${appDbUser};

ALTER TABLE cockpit_layout ENABLE ROW LEVEL SECURITY;
ALTER TABLE cockpit_layout FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cockpit_layout_isolation ON cockpit_layout;
CREATE POLICY cockpit_layout_isolation ON cockpit_layout
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE cockpit_layout IS
    'Der gespeicherte WILLE ueber das Cockpit-Layout (Anwendungs-Programm '
    'Stufe 3): Reihenfolge, ausgeblendete Bausteine und der Lead - je Anlage '
    'bzw. kunden-weit, je Schicht (Vorgabe/Eigen). Keine Zeile = der '
    'deterministische Katalog-Standard.';
