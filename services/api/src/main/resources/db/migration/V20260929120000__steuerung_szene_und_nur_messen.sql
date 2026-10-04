-- =============================================================================
-- V20260929120000 - Steuerung neu (Konzept `docs/konzepte/steuerung`, E2 + E6):
-- „nur messen" hält dauerhaft, und die Szenen einer Anlage. ADDITIV.
-- -----------------------------------------------------------------------------
-- 1) „Nicht steuern, nur messen" (E2)
--
-- Ein neu verbundenes Gerät ohne Auftrag fragt die Steuerung einmal: übernehmen,
-- anders einstellen oder nur messen. „Nur messen" ist eine Entscheidung des
-- Kunden über SEIN Gerät, keine Vertagung - sie gilt, bis er sie selbst
-- zurücknimmt. `site_suggestion_state` (V20260846000000) kannte bisher nur
-- „später" (1 Tag) und „abgelehnt" (7 Tage); nach sieben Tagen stünde die
-- Frage wieder da. Die Haltung `nur_messen` hat deshalb KEINE Frist
-- (`muted_until IS NULL`), und nur sie darf ohne Frist stehen.
--
-- Die Frist rechnet weiter der SERVER (`Vorschlaege.stummBis`); der Client
-- nennt nur das Wort. Zurücknehmen ist ein DELETE der Zeile.
--
-- 2) Szenen (E6: „ein Tipp, mehrere Geräte")
--
-- Eine Szene („Urlaub", „Unterwegs", „Sparen") pausiert die Geräte, die der
-- Kunde beim Einschalten wählt, über den bestehenden Pausenweg
-- (`ConsumerPolicyActivationService.pause`: Regel zurückgezogen, der Failsafe
-- des Geräts gilt). Die Tabelle merkt sich, WELCHE Geräte die Szene selbst
-- pausiert hat - beim Beenden setzt sie genau diese fort und keines, das schon
-- vorher pausiert war. Höchstens eine Szene je Anlage (Primärschlüssel).
--
-- Mandantengebunden mit ENABLE + FORCE RLS wie `site_suggestion_state`; KEIN
-- BIGSERIAL, also keine Sequenz-Grants.
-- =============================================================================

-- 1) nur_messen ohne Frist ----------------------------------------------------

ALTER TABLE site_suggestion_state
    DROP CONSTRAINT IF EXISTS site_suggestion_state_state_check;
ALTER TABLE site_suggestion_state
    ADD CONSTRAINT site_suggestion_state_state_check
    CHECK (state IN ('spaeter', 'abgelehnt', 'nur_messen'));

ALTER TABLE site_suggestion_state ALTER COLUMN muted_until DROP NOT NULL;

ALTER TABLE site_suggestion_state
    DROP CONSTRAINT IF EXISTS site_suggestion_state_frist_check;
ALTER TABLE site_suggestion_state
    ADD CONSTRAINT site_suggestion_state_frist_check
    CHECK ((state = 'nur_messen') = (muted_until IS NULL));

-- 2) Szenen ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS site_scene (
    site_id           UUID        PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
    -- Geschlossenes Vokabular; Portal (`steuerung/szenen.ts`) und
    -- `Szenen.java` ändern es gemeinsam.
    scene_key         TEXT        NOT NULL
                                  CHECK (scene_key IN ('urlaub', 'unterwegs', 'sparen')),
    -- Die Geräte (Komponenten-Ids), die DIESE Szene pausiert hat.
    paused_entity_ids UUID[]      NOT NULL DEFAULT '{}',
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_by        TEXT,
    tenant_id         UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE
);

GRANT SELECT, INSERT, UPDATE, DELETE ON site_scene TO ${appDbUser};

ALTER TABLE site_scene ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_scene FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_scene_isolation ON site_scene;
CREATE POLICY site_scene_isolation ON site_scene
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
