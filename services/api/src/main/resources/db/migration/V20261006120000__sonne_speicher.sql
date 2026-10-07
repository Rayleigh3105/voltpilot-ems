-- =============================================================================
-- V20261006120000 - „Sonne + Speicher": die Ladequelle, die dem Auto vom
-- Hausspeicher gibt, was laut Prognose bis zur nächsten Erzeugung nicht
-- gebraucht wird (Wunsch des Kapitäns 06.10.2026; Fachregel
-- docs/verbrauchssteuerung.md#sonne--speicher).
-- -----------------------------------------------------------------------------
-- VIER Orte, vier verschiedene Aussagen - alle rein ADDITIV:
--
--   * site_charge_point_allowlist.storage_release - die WAHL je Säule. Die
--     Quellen-Bahn bleibt `nur_sonne` (source); das Flag sagt der Box, dass sie
--     zusätzlich Speicherenergie oberhalb der Untergrenze freigeben darf. Eine
--     Box, die das Flag nicht kennt, fährt damit genau den verlangten Rückfall
--     „Nur Sonne" - deshalb kein neues Bahn-Wort (ein unbekanntes Wort ließe
--     eine ältere Box den ganzen Eintrag überspringen). FALSE ist die Vorgabe:
--     keine bestehende Säule ändert ihr Verhalten.
--   * site_charging_config.storage_release_reserve_kwh - die RESERVE je Anlage
--     über dem Reservestapel des Speichers. NULL = keine eigene Angabe, es gilt
--     die Vorgabe des Optimierers (storage_release.DEFAULT_RESERVE_KWH,
--     1,0 kWh) - nie eine erfundene 0.
--   * schedule.ev_release_floor_soc_pct - die UNTERGRENZE je Viertelstunde,
--     dieselbe Zahl, die der MQTT-Fahrplan trägt (Portal: Ladeplan). NULL =
--     in diesem Slot keine Freigabe (der Plan handelt, oder die Anlage fährt
--     die Quelle nicht).
--   * device_charging_budget.storage_release_* - was die BOX gerade daraus
--     macht (Herzschlag -> Anzeige): freigegebene Leistung, Untergrenze,
--     gemessener Ladestand, Stufe und Satz. NULLABLE, weil kein Messwert NIE
--     eine 0 ist.
--
-- RLS/Grants erben alle vier Tabellen (V20260834000000, V20260829000000,
-- V20260701020000, V20260828000000); ein ADD COLUMN ändert daran nichts. Der
-- SELECT-Grant auf schedule ist spaltenunabhängig. Bootstrap-Spiegel:
-- infra/local/timescale/04-schedule.sql (schedule). Out-of-order-sicher: jede
-- Anweisung ist IF NOT EXISTS bzw. DROP ... IF EXISTS vor ADD CONSTRAINT.
-- =============================================================================

ALTER TABLE site_charge_point_allowlist
    ADD COLUMN IF NOT EXISTS storage_release BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE site_charging_config
    ADD COLUMN IF NOT EXISTS storage_release_reserve_kwh NUMERIC;
ALTER TABLE site_charging_config
    DROP CONSTRAINT IF EXISTS site_charging_config_storage_release_reserve_chk;
ALTER TABLE site_charging_config ADD CONSTRAINT site_charging_config_storage_release_reserve_chk
    CHECK (storage_release_reserve_kwh IS NULL
           OR (storage_release_reserve_kwh >= 0 AND storage_release_reserve_kwh <= 100));

ALTER TABLE schedule ADD COLUMN IF NOT EXISTS ev_release_floor_soc_pct NUMERIC(5, 1);

ALTER TABLE device_charging_budget
    -- Gibt die Box gerade Speicherenergie an Autos auf „Sonne + Speicher"?
    ADD COLUMN IF NOT EXISTS storage_release_active BOOLEAN NOT NULL DEFAULT FALSE,
    -- Die freigegebene Speicherleistung [kW], nur bei aktiver Freigabe.
    ADD COLUMN IF NOT EXISTS storage_release_kw DOUBLE PRECISION,
    -- Die Untergrenze der laufenden Viertelstunde [% SoC], wie die Box sie hat.
    ADD COLUMN IF NOT EXISTS storage_release_floor_soc_pct DOUBLE PRECISION,
    -- Der gemessene Ladestand, gegen den die Box entschieden hat [%].
    ADD COLUMN IF NOT EXISTS storage_release_soc_pct DOUBLE PRECISION,
    -- Die Stufe (geschlossenes Vokabular der Box) und ihr deutscher Satz.
    ADD COLUMN IF NOT EXISTS storage_release_mode TEXT,
    ADD COLUMN IF NOT EXISTS storage_release_note TEXT;
