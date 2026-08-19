-- =============================================================================
-- V20260826000000 - Die Wahl des Prognosemodells wird eine Entscheidung JE
-- ANLAGE, und der KUNDE trifft sie selbst.
-- ADDITIV: eine neue Tabelle, keine bestehende wird angefasst. Ohne eine Zeile
-- plant JEDE Anlage byte-identisch wie vorher.
-- -----------------------------------------------------------------------------
-- WOFÜR (Captain-Auftrag 19.08.2026 - er REVIDIERT die Plattformweit-Semantik
-- von V20260825000000 vom Vortag):
--
-- Der Schalter aus V20260825000000 war plattformweit und admin-only. Beides ist
-- fachlich falsch: welches Prognosemodell am besten passt, hängt an der
-- EINZELNEN Anlage (Lastprofil, Wetterlage, Speichergröße) - ein Kandidat, der
-- auf einem Gewerbehof gewinnt, kann auf einem Einfamilienhaus verlieren. Und
-- die Entscheidung ist eine über die EIGENE Anlage, also gehört sie dem Kunden.
--
-- ⚠ DIE PRÄZEDENZ IST DER GANZE VERTRAG UND STEHT WÖRTLICH SO IM CODE
--   (ForecastModels.resolve · voltpilot_forecast.model_choice.ModelChoices):
--   1. die JÜNGSTE Zeile HIER, je (Anlage, Art)      -> sie gewinnt,
--   2. sonst die jüngste Zeile in forecast_model_choice (die PLATTFORM-Vorgabe),
--   3. sonst die Umgebungsvariable (VOLTPILOT_ACTIVE_*_MODEL),
--   4. sonst der Registry-Default (das Basismodell).
-- Die Plattform-Wahl bleibt damit genau das, was ihr Name sagt: die VORGABE für
-- jede Anlage, die keine eigene getroffen hat. Sie wird von dieser Migration
-- nicht angefasst und behält ihren admin-only Schreibpfad.
--
-- ⚠ APPEND-ONLY, und damit zugleich das Audit-Journal JE ANLAGE (Anforderung 4).
-- Eine Zeile trägt von->zu, Urheber und Zeitpunkt; „was gilt gerade" ist die
-- jüngste `id` je (site_id, model_kind) - DISTINCT ON, das ScheduleRepository-
-- Muster. Eine „eine Zeile je Anlage und Art"-Tabelle mit UPDATE hätte den
-- VERLAUF verloren, und ein zweites Journal daneben wäre eine zweite Wahrheit
-- über dasselbe Ereignis gewesen. Deshalb nimmt die App-Rolle UPDATE/DELETE
-- ausdrücklich NICHT (der Kaskaden-Löschpfad unten ist davon unberührt: eine
-- referenzielle Aktion läuft als Eigentümer der Tabelle und umgeht sowohl
-- Rechte als auch FORCE-RLS).
--
-- ⚠ MANDANTENGEBUNDEN MIT RLS + FORCE - anders als die globale
-- forecast_model_choice, und aus genau dem Grund, aus dem es diese Tabelle
-- gibt: das hier ist eine Entscheidung über EINE KUNDENANLAGE, also sind es
-- Kundendaten. Der Kunde schreibt sie über die RLS-gefencte App-Rolle
-- (/api/v1/sites/{id}/forecast-models, KEIN @PreAuthorize - Authentifizierung
-- + RLS sind der Zaun, eine fremde Anlage ist 404), ein Portal-Admin über den
-- X-Tenant-Id-Umschalter auf demselben Pfad. Es gibt hier bewusst KEINEN
-- BYPASSRLS-Schreibpfad.
--
-- Datums-Version oberhalb des höchsten ausgelieferten Standes
-- (V20260825000000) - eine kleinere Version wäre für Flyway „out of order" und
-- würde auf einer langlebigen DB nie angewandt.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_forecast_model_choice (
    id                BIGSERIAL   PRIMARY KEY,
    site_id           UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    tenant_id         UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    -- 'load' | 'pv' - das Vokabular der Prognosearten (ForecastKind).
    model_kind        TEXT        NOT NULL,
    -- Die Modell-Id, die ab jetzt FÜR DIESE ANLAGE plant.
    model_id          TEXT        NOT NULL,
    -- Was sie abgelöst hat (das zuvor WIRKSAME Modell dieser Anlage, also ggf.
    -- die Plattform-Vorgabe). NULL = die erste Umstellung dieser Anlage und Art
    -- - eine ehrliche Lücke, nie ein erfundener Vorgänger.
    previous_model_id TEXT,
    -- Das JWT-Subject des Umstellers - die maschinenstabile Identität, wie im
    -- rollout_event-Journal.
    set_by            TEXT        NOT NULL,
    -- Der Anzeige-Name (preferred_username) NEBEN dem Subject: eine UUID ist
    -- kein Urheber, den ein Mensch liest. NULL = nicht im Token.
    set_by_name       TEXT,
    set_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_site_forecast_model_choice_kind
        CHECK (model_kind IN ('load', 'pv'))
);

-- Der Lesepfad ist immer „die jüngste Zeile je Anlage und Art" - genau dieser
-- Index; er trägt zugleich den Verlaufs-Lesepfad derselben Anlage.
CREATE INDEX IF NOT EXISTS idx_site_forecast_model_choice
    ON site_forecast_model_choice (site_id, model_kind, id DESC);

-- -----------------------------------------------------------------------------
-- Rechte + RLS (das rule_event-Muster: append-only Journal, mandantengebunden)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON site_forecast_model_choice TO ${appDbUser};
-- V2s ALTER DEFAULT PRIVILEGES gäbe der App-Rolle sonst auch UPDATE/DELETE -
-- ein nachträglich änderbares Journal wäre keins.
REVOKE UPDATE, DELETE ON site_forecast_model_choice FROM ${appDbUser};

-- ⚠ Ein BIGSERIAL braucht sein EIGENES Sequenz-Recht: V4s
-- `ALTER DEFAULT PRIVILEGES` deckt TABELLEN ab, Sequenzen sind eine andere
-- Objektklasse (sonst „permission denied for sequence" auf genau dem
-- Schreibpfad, der die Papier-Spur trägt - die dokumentierte
-- rollout_event-Falle).
GRANT USAGE, SELECT ON SEQUENCE site_forecast_model_choice_id_seq TO ${appDbUser};

ALTER TABLE site_forecast_model_choice ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_forecast_model_choice FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_forecast_model_choice_isolation ON site_forecast_model_choice;
CREATE POLICY site_forecast_model_choice_isolation ON site_forecast_model_choice
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
