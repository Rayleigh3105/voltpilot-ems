-- =============================================================================
-- V20261115200000 - Steuerlogik Stufe 5: die Sammlung der Bausteine.
-- -----------------------------------------------------------------------------
-- Ein Baustein ist eine Logik mit Lücken und einem Satz (Bericht 6.7). Die
-- Bausteine von VoltPilot für den Start stehen im Vertrag
-- (docs/contracts/v2/steuerlogik/bausteine/) und liegen nicht hier. Hier liegen
-- die, die jemand aus einer Logik speichert (E4 = A):
--
--   herkunft 'fachbetrieb': ein Partner-Konto (Unterstützung der Art
--     Installateur) speichert für seine Kunden. Einen Fachbetrieb als Einheit
--     über mehrere Kunden gibt es im Portal nicht (Bericht 8.8); die Sammlung
--     hängt am Konto (partner_sub = Keycloak-Subject, über alle Kundenbereiche
--     dasselbe).
--   herkunft 'voltpilot': die Plattform speichert für alle Kunden.
--
-- Die Tabelle gehört keinem Kundenbereich und trägt darum keinen tenant_id.
-- Wer welchen Baustein sieht, setzt die Datenbank durch (FORCE RLS): einen von
-- VoltPilot jeder; einen eines Fachbetriebs nur, wer ihm im eigenen
-- Kundenbereich eine Unterstützung der Art Installateur gewährt hat, die
-- begonnen hat und nicht vorzeitig beendet wurde, solange sein Konto nicht
-- gesperrt oder entfernt ist. Die Unterabfrage liest zugriff und benutzer unter
-- deren eigenem Mandantenzaun, also nur den Kundenbereich der Anfrage. Ein
-- Partner sieht seine eigenen Bausteine so in jedem Kundenbereich, in dem er
-- arbeitet. Gelöscht wird nie; ein entfernter Baustein trägt entfernt_am.
-- =============================================================================

CREATE TABLE IF NOT EXISTS steuerlogik_baustein (
    id             UUID        PRIMARY KEY,
    herkunft       TEXT        NOT NULL CHECK (herkunft IN ('voltpilot', 'fachbetrieb')),
    partner_sub    TEXT,
    name           TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
    -- der Baustein in seiner Form (block, name, sentence, logic), wie der Logik-Dienst ihn baute
    text           TEXT        NOT NULL CHECK (length(text) BETWEEN 1 AND 300000),
    content_hash   TEXT        NOT NULL,
    angelegt_am    TIMESTAMPTZ NOT NULL,
    angelegt_von   TEXT        NOT NULL,
    angelegt_name  TEXT,
    entfernt_am    TIMESTAMPTZ,
    entfernt_von   TEXT,
    CONSTRAINT steuerlogik_baustein_partner_chk
        CHECK ((herkunft = 'fachbetrieb') = (partner_sub IS NOT NULL AND btrim(partner_sub) <> '')),
    CONSTRAINT steuerlogik_baustein_entfernt_chk
        CHECK ((entfernt_am IS NULL) = (entfernt_von IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_steuerlogik_baustein_partner
    ON steuerlogik_baustein (partner_sub, angelegt_am) WHERE entfernt_am IS NULL;

GRANT SELECT, INSERT ON steuerlogik_baustein TO ${appDbUser};
GRANT UPDATE (entfernt_am, entfernt_von) ON steuerlogik_baustein TO ${appDbUser};

ALTER TABLE steuerlogik_baustein ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerlogik_baustein FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerlogik_baustein_sicht ON steuerlogik_baustein;
CREATE POLICY steuerlogik_baustein_sicht ON steuerlogik_baustein
    USING (herkunft = 'voltpilot' OR EXISTS (
        SELECT 1 FROM zugriff z
        JOIN benutzer b ON b.tenant_id = z.tenant_id AND b.sub = z.benutzer_sub
        WHERE z.benutzer_sub = steuerlogik_baustein.partner_sub
          AND z.rolle = 'unterstuetzer' AND z.art = 'installateur'
          AND z.gueltig_ab <= now() AND z.beendet_am IS NULL
          AND b.konto = 'partner' AND b.zustand IN ('angelegt', 'aktiv')))
    WITH CHECK (herkunft = 'voltpilot' OR EXISTS (
        SELECT 1 FROM zugriff z
        JOIN benutzer b ON b.tenant_id = z.tenant_id AND b.sub = z.benutzer_sub
        WHERE z.benutzer_sub = steuerlogik_baustein.partner_sub
          AND z.rolle = 'unterstuetzer' AND z.art = 'installateur'
          AND z.gueltig_ab <= now() AND z.beendet_am IS NULL
          AND b.konto = 'partner' AND b.zustand IN ('angelegt', 'aktiv')));
