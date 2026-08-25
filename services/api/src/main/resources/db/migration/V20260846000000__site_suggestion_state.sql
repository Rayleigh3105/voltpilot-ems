-- =============================================================================
-- V20260846000000 - site_suggestion_state: das GEDÄCHTNIS der Vorschläge
-- (Steuerung Stufe 6, Konzept `vp-steuerung-konzept-b3` §3.3 + §4). ADDITIV.
-- -----------------------------------------------------------------------------
-- ⚠ EIN VORSCHLAG WIRD NIE GESPEICHERT. Er ist eine ABLEITUNG aus Fahrplan
-- (Überschuss- und Preis-Fenster), steuerbaren Komponenten und dem, was schon
-- läuft - §4 wörtlich: „Vorschläge selbst werden nie gespeichert (Ableitung)".
-- Ihn zu persistieren erzeugte eine zweite Wahrheit, die veraltet, sobald sich
-- der Fahrplan ändert - und er ändert sich alle 15 Minuten.
--
-- Gespeichert wird deshalb NUR das Gegenteil: dass der Kunde einen Vorschlag
-- gerade NICHT sehen will. Das ist eine Entscheidung des Kunden, es überlebt
-- den Geräte- und Browserwechsel, und `localStorage` ist im Haus verboten
-- (Konzept §7) - also gehört es hierher.
--
--   spaeter    „Später" - eine Vertagung. Kurz (1 Tag): der Vorschlag hängt an
--              einem Fenster von HEUTE, morgen ist es ein anderes.
--   abgelehnt  „Ablehnen" - 7 Tage weg (§3.3 wörtlich).
--
-- ⚠ `muted_until` rechnet der SERVER (`Vorschlaege.stummBis`), nie der Client:
-- eine vom Client gewählte Frist wäre ein Weg, einen Vorschlag für immer
-- verstummen zu lassen, ohne ihn je abzulehnen.
--
-- Mandantengebunden mit ENABLE + FORCE RLS wie `site_profile_state` - das sind
-- KUNDENDATEN, und der Kunde schreibt sie über den RLS-gefencten App-Pfad;
-- ein Plattform-Admin erreicht sie über den `X-Tenant-Id`-Umschalter. KEIN
-- BYPASSRLS.
--
-- KEIN BIGSERIAL, also auch kein `GRANT USAGE ON SEQUENCE` (die dokumentierte
-- `rollout_event`-Falle): der Schlüssel ist (Anlage, Vorschlag) - je Vorschlag
-- gibt es genau EINE Haltung, und ein Verlauf der Ablehnungen hätte keinen
-- Leser.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_suggestion_state (
    site_id        UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    -- Der ABGELEITETE Schlüssel des Vorschlags (`vorschlaege.ts` `key`):
    -- Art + Komponente, z. B. `ueberschuss:9f3c…`. Ein OFFENES Vokabular wie
    -- `site_profile_state.profile` - eine neue Vorschlags-Art ist Code, nicht
    -- DDL. Der CHECK hält nur die FORM (kein Leerzeichen, keine Sonderzeichen),
    -- damit ein Schlüssel nie aus einem Kundennamen entsteht.
    suggestion_key TEXT        NOT NULL
                               CHECK (suggestion_key ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
    state          TEXT        NOT NULL CHECK (state IN ('spaeter', 'abgelehnt')),
    muted_until    TIMESTAMPTZ NOT NULL,
    tenant_id      UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    updated_by     TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, suggestion_key)
);

CREATE INDEX IF NOT EXISTS idx_site_suggestion_state_site
    ON site_suggestion_state (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON site_suggestion_state TO ${appDbUser};

ALTER TABLE site_suggestion_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_suggestion_state FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_suggestion_state_isolation ON site_suggestion_state;
CREATE POLICY site_suggestion_state_isolation ON site_suggestion_state
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
