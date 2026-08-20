-- =============================================================================
-- V20260828000000 - Die Ladepunkte werden cloud-sichtbar (Lastmanagement Stufe 3).
-- -----------------------------------------------------------------------------
-- Die Box ist seit Stufe 0 das CSMS: die Ladesäulen wählen SIE an, sie verteilt
-- das Anschluss-Budget und hält es gegen den gemessenen Netzbezug (Konzept
-- `data/vp-ocpp-lastmgmt-konzept-w4` §3.2/§4). Sichtbar war das bisher NUR auf
-- der `:8484`-Seite der Box - "welche Säule lädt gerade, und warum wartet die
-- dritte?" war aus dem Portal unbeantwortbar. Die Edge trägt die Antwort seit
-- Stufe 3 als additiven `chargers`-Block im Herzschlag; diese drei Tabellen
-- sind ihr Speicher.
--
-- ⚠ DREI Tabellen, weil es DREI Gegenstände sind, und jede wird je Herzschlag
-- GANZ ersetzt (die device_source_status-Disziplin: der Herzschlag trägt das
-- vollständige Ist, ein Merge hinterließe Geister):
--   * device_charging_budget  - EINE Zeile je Gerät: das Standort-Budget, das
--     sich alle Säulen teilen. Es gehört dem STANDORT, nicht einer Säule.
--   * device_charge_point     - eine Zeile je Ladesäule.
--   * device_charge_connector - eine Zeile je Stecker (ein Stecker = ein
--     Fahrzeug = ein Anspruch auf das Budget, Konzept §3.5).
-- Eine Säule OHNE gemeldete Stecker muss sichtbar bleiben (das ist der ehrliche
-- Zustand "eingetragen, hat sich noch nicht gemeldet"), deshalb sind Stecker
-- eine eigene Tabelle und keine Spalten der Säulen-Zeile.
--
-- ⚠ ANZEIGE-DATEN. Nichts hiervon speist Telemetrie, Rollups, Erlöse oder den
-- Optimierer; die Cloud SIEHT zu, sie entscheidet nicht - die Anschlussgrenze
-- ist eine physische Grenze und ihr Wächter darf nicht am WAN hängen (E1).
--
-- ⚠ SCOPE-ZAUN (E4): Lastmanagement pur. Sitzungen sind BETRIEBS-, keine
-- Abrechnungsdaten - kein Eichrecht, kein Roaming, kein Nutzer-Management, und
-- deshalb auch KEIN Sitzungs-Archiv: gespeichert ist der laufende Zustand, nie
-- eine Historie, aus der jemand eine Rechnung ableiten könnte.
--
-- Mandantengebunden + RLS + FORCE wie device_source_status / device_control_status
-- (der Zuhörer schreibt als App-Rolle mit dem Mandanten des Topics in
-- app.tenant_id; WITH CHECK garantiert, dass die Zeile dort landet).
--
-- Datums-Version nach der AGENTS.md-Regel zur Migrations-Koordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_charging_budget (
    device_id           UUID          NOT NULL PRIMARY KEY,
    tenant_id           UUID          NOT NULL,
    site_id             UUID          NOT NULL,
    -- Die zwei Tore der Box: der Server läuft (enabled) bzw. die LEBENDE
    -- Zuteilung darf geschrieben werden (control_enabled). Ohne das zweite
    -- fährt die Anlage auf n x Sicherheitsprofil - sicher, nur nicht
    -- optimiert -, und control_note sagt WARUM.
    enabled             BOOLEAN       NOT NULL DEFAULT FALSE,
    control_enabled     BOOLEAN       NOT NULL DEFAULT FALSE,
    control_note        TEXT,
    -- Die gepflegten Zahlen des Standorts.
    grid_limit_kw       DOUBLE PRECISION,
    margin_pct          DOUBLE PRECISION,
    min_power_kw        DOUBLE PRECISION,
    -- Das lebende Budget und was daraus geworden ist. measured_kw / site_load_kw
    -- / site_grid_kw sind NULLABLE: kein Messwert ist NIE eine 0.
    budget_kw           DOUBLE PRECISION,
    allocated_kw        DOUBLE PRECISION,
    reserved_kw         DOUBLE PRECISION,
    measured_kw         DOUBLE PRECISION,
    site_load_kw        DOUBLE PRECISION,
    site_grid_kw        DOUBLE PRECISION,
    -- Die Stufe, in der das Budget entstand, und ihr deutscher Satz. Der Satz
    -- wird EINMAL geschrieben (internal/lastmgmt) und hier nur aufbewahrt.
    budget_mode         TEXT,
    budget_note         TEXT,
    budget_blind        BOOLEAN       NOT NULL DEFAULT FALSE,
    eff_limit_kw        DOUBLE PRECISION,
    -- Das Ausfall-Profil MIT seinen Termen, damit eine Oberfläche dem Kunden
    -- die Rechnung zeigen kann statt einer nackten Zahl.
    safe_default_kw     DOUBLE PRECISION,
    safe_default_note   TEXT,
    safe_default_holds  BOOLEAN,
    safe_worst_case_kw  DOUBLE PRECISION,
    max_house_load_kw   DOUBLE PRECISION,
    connector_count     INTEGER       NOT NULL DEFAULT 0,
    reported_at         TIMESTAMPTZ   NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_charging_budget_site
    ON device_charging_budget (site_id);

CREATE TABLE IF NOT EXISTS device_charge_point (
    device_id       UUID          NOT NULL,
    charge_point_id TEXT          NOT NULL,   -- die OCPP-ChargePointId, DIE Identität
    tenant_id       UUID          NOT NULL,
    site_id         UUID          NOT NULL,
    label           TEXT,
    priority        BOOLEAN       NOT NULL DEFAULT FALSE,
    connected       BOOLEAN       NOT NULL DEFAULT FALSE,
    -- ⚠ Selbstauskunft der Station, NUR zur Anzeige (herstellerneutral,
    -- Konzept §0 VERBINDLICH): kein Code darf auf diese drei verzweigen.
    vendor          TEXT,
    model           TEXT,
    firmware        TEXT,
    -- ready = die zwei DAUERHAFTEN Profile sind hinterlegt; note nennt den
    -- Grund, wenn nicht - nie ein unerklärtes "nicht bereit".
    ready           BOOLEAN       NOT NULL DEFAULT FALSE,
    note            TEXT,
    last_seen       TIMESTAMPTZ,
    -- Die Komponente, die die Plattform für diese Säule komponiert hat
    -- (measurement_point mit entity_type 'ev-charger'). NULL = noch keine.
    -- Bewusst OHNE Fremdschlüssel: die Zeile ist eine MOMENTAUFNAHME des
    -- Geräts und darf ein Löschen der Komponente weder blockieren noch
    -- mitgelöscht werden (das rollout_device.device_ref-Muster).
    entity_id       UUID,
    reported_at     TIMESTAMPTZ   NOT NULL,
    PRIMARY KEY (device_id, charge_point_id)
);

CREATE INDEX IF NOT EXISTS idx_device_charge_point_site
    ON device_charge_point (site_id);

CREATE TABLE IF NOT EXISTS device_charge_connector (
    device_id       UUID          NOT NULL,
    charge_point_id TEXT          NOT NULL,
    connector_id    INTEGER       NOT NULL,
    tenant_id       UUID          NOT NULL,
    site_id         UUID          NOT NULL,
    status          TEXT,                     -- das OCPP-1.6-Vokabular, verbatim
    charging        BOOLEAN       NOT NULL DEFAULT FALSE,
    allocated_kw    DOUBLE PRECISION,         -- NULL = nicht Teil der Entscheidung
    reason          TEXT,                     -- das Maschinenwort des Verteilers
    reason_text     TEXT,                     -- sein deutscher Satz, unverändert
    next_turn       TIMESTAMPTZ,              -- geschätzter Termin; NULL = nichts sagen
    power_kw        DOUBLE PRECISION,         -- gemessen; NULL = nicht gemeldet
    energy_kwh      DOUBLE PRECISION,
    soc_pct         DOUBLE PRECISION,
    command_status  TEXT,                     -- die Antwort der Säule
    readback        TEXT,                     -- ok | abweichend | unbekannt
    readback_note   TEXT,
    session_since   TIMESTAMPTZ,
    reported_at     TIMESTAMPTZ   NOT NULL,
    PRIMARY KEY (device_id, charge_point_id, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_device_charge_connector_site
    ON device_charge_connector (site_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_charging_budget TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON device_charge_point TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON device_charge_connector TO ${appDbUser};

ALTER TABLE device_charging_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_charging_budget FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_charging_budget_isolation ON device_charging_budget;
CREATE POLICY device_charging_budget_isolation ON device_charging_budget
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE device_charge_point ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_charge_point FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_charge_point_isolation ON device_charge_point;
CREATE POLICY device_charge_point_isolation ON device_charge_point
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE device_charge_connector ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_charge_connector FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_charge_connector_isolation ON device_charge_connector;
CREATE POLICY device_charge_connector_isolation ON device_charge_connector
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
