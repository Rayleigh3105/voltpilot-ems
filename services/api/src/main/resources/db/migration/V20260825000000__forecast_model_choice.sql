-- =============================================================================
-- V20260825000000 - Die Wahl des AKTIVEN Prognosemodells wird DATEN.
-- ADDITIV: eine neue Tabelle, keine bestehende wird angefasst. Ohne eine Zeile
-- verhaelt sich JEDER Pfad byte-identisch wie vorher.
-- -----------------------------------------------------------------------------
-- WOFÜR (Captain-Auftrag 18.08.2026, docs/forecasting.md):
--
-- Der Schattenbetrieb misst seit Langem, welches Prognosemodell naeher an der
-- Wirklichkeit lag - aber die BEFOERDERUNG eines Kandidaten war eine
-- Umgebungsvariable (VOLTPILOT_ACTIVE_LOAD_MODEL / _PV_MODEL) an drei
-- Containern plus ein Redeploy. Damit war die eine Handlung, die aus der
-- Messung folgt, die einzige, die das Portal nicht anbieten konnte.
--
-- ⚠ DIE PRAEZEDENZ IST DER GANZE VERTRAG UND STEHT WOERTLICH SO IM CODE:
--   1. eine Zeile hier (die JUENGSTE je Art)  -> sie gewinnt,
--   2. sonst die Umgebungsvariable,
--   3. sonst der Registry-Default (das Basismodell).
-- Die Umgebungsvariable bleibt also der VORGABE-Wert, nicht ein Gegenspieler:
-- eine Flotte, die den Schalter nie benutzt, ist von dieser Migration nicht zu
-- unterscheiden. Und weil die Zeile gewinnt, ist ein spaeterer Env-Edit auf
-- einer umgestellten Flotte wirkungslos - genau richtig, denn sonst haette ein
-- Redeploy die bewusste Portal-Entscheidung stillschweigend zurueckgenommen.
--
-- ⚠ DIE TABELLE IST APPEND-ONLY UND IST DAMIT ZUGLEICH DAS AUDIT-JOURNAL.
-- Sie traegt je Umstellung eine Zeile mit von->zu, Urheber und Zeitpunkt; der
-- aktuelle Stand ist das juengste `id` je Art (DISTINCT ON, das
-- ScheduleRepository-Muster). Eine „eine Zeile je Art"-Tabelle mit UPDATE haette
-- den VERLAUF verloren - und ein zweites Journal daneben waere eine zweite
-- Wahrheit ueber dasselbe Ereignis gewesen. `previous_model_id` steht deshalb
-- MIT in der Zeile: „von->zu" ist die Aussage, die ein Betreiber sucht, und sie
-- aus zwei Zeilen zu rekonstruieren waere eine Ableitung, die jede Fläche
-- wiederholen muesste.
--
-- ⚠ GLOBAL, ohne tenant_id und ohne RLS - wie edge_release,
-- provisioned_device, component_template und inverter_control_certification,
-- und aus demselben Grund: welches Modell die PLATTFORM rechnen laesst, ist
-- eine Aussage ueber das Produkt, keine Kundendaten. Eine tenant_id wuerde
-- einen kundenweisen Schalter SUGGERIEREN, den es nicht gibt (der Optimierer
-- liest die Wahl einmal je Lauf fuer die ganze Flotte, exakt die heutige
-- Env-Semantik). Gefenced ist der ENDPUNKT: geschrieben wird ausschliesslich
-- ueber /api/v1/admin/forecast-models mit klassenweitem
-- @PreAuthorize("hasRole('platform-admin')") und der BYPASSRLS-Rolle
-- voltpilot_admin - die /admin/fleet-Disziplin.
--
-- Die App-Rolle bekommt hier SELECT (anders als bei rollout): die
-- Prognosequalitaet-Seite eines KUNDEN muss sagen koennen, welches Modell
-- gerade plant; ohne diesen Lesepfad zeigte sie nach einer Umstellung
-- weiterhin das alte Modell als „live" an. Geschrieben wird von ihr nie.
--
-- Datums-Version oberhalb des hoechsten ausgelieferten Standes
-- (V20260824000000) - eine kleinere Version waere fuer Flyway „out of order"
-- und wuerde auf einer langlebigen DB nie angewandt.
-- =============================================================================

CREATE TABLE IF NOT EXISTS forecast_model_choice (
    id                BIGSERIAL   PRIMARY KEY,
    -- 'load' | 'pv' - das Vokabular der Prognosearten (ForecastKind).
    model_kind        TEXT        NOT NULL,
    -- Die Modell-Id, die ab jetzt plant (voltpilot_forecast.registry).
    model_id          TEXT        NOT NULL,
    -- Was sie abgeloest hat. NULL = die erste Umstellung dieser Art
    -- (davor galt die Umgebungsvariable bzw. der Registry-Default) - eine
    -- ehrliche Luecke, nie ein erfundener Vorgaenger.
    previous_model_id TEXT,
    -- Das JWT-Subject des Portal-Admins - die maschinenstabile Identitaet,
    -- wie im rollout_event-Journal.
    set_by            TEXT        NOT NULL,
    -- Der Anzeige-Name (preferred_username) NEBEN dem Subject: eine UUID ist
    -- kein Urheber, den ein Mensch liest. NULL = nicht im Token - die Flaeche
    -- sagt dann „von einem Portal-Admin", nie eine nackte Kennung.
    set_by_name       TEXT,
    set_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_forecast_model_choice_kind CHECK (model_kind IN ('load', 'pv'))
);

-- Der Lesepfad ist immer „die juengste Zeile je Art" - genau dieser Index.
CREATE INDEX IF NOT EXISTS idx_forecast_model_choice_kind
    ON forecast_model_choice (model_kind, id DESC);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gaebe der App-Rolle sonst auch INSERT/UPDATE/
-- DELETE auf dieser GLOBALEN Tabelle - eine offene Tuer ohne Aufrufer. Lesen
-- ja (die Kunden-Prognoseseite), schreiben weg: das provisioned_device-Muster.
GRANT SELECT ON forecast_model_choice TO ${appDbUser};
REVOKE INSERT, UPDATE, DELETE ON forecast_model_choice FROM ${appDbUser};

-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Grant: V4s ALTER DEFAULT
-- PRIVILEGES deckt Tabellen ab, Sequenzen sind eine andere Objektklasse. Ohne
-- diese Zeile scheitert genau der Schreibpfad, der die Papier-Spur traegt, mit
-- „permission denied for sequence" (die dokumentierte rollout_event-Falle).
GRANT USAGE, SELECT ON SEQUENCE forecast_model_choice_id_seq TO ${adminDbUser};
