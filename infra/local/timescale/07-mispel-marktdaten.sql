-- =============================================================================
-- Voltpilot-EMS - MiSpeL-Marktdaten (LOCAL DEV bootstrap)
-- -----------------------------------------------------------------------------
-- Additive dev-only init file mirroring the canonical Flyway migration
--   services/market-data/db/migration/V20261002110000__mispel_marktdaten.sql
-- (the api's V20261002110000 applies the same DDL idempotently at runtime and
-- grants the app role SELECT). Keep the shapes in sync; the migrations are
-- authoritative.
--
-- eeg_aw_zeit: AW>0-Zeiten der Uebertragungsnetzbetreiber je Regel
-- (netztransparenz.de, "Negativer Spotmarktpreis - Uebersichtstabellen").
-- annual_market_value: Jahresmarktwert je Energietraeger. Market-wide data:
-- NO tenant_id, NO RLS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS eeg_aw_zeit (
    regel             TEXT         NOT NULL CHECK (regel IN (
                          'viertelstunde', 'viertelstunde_2ct',
                          'stunden_1', 'stunden_2', 'stunden_3', 'stunden_4', 'stunden_6')),
    ts                TIMESTAMPTZ  NOT NULL,  -- Beginn der (Viertel-)Stunde
    aufloesung        TEXT         NOT NULL CHECK (aufloesung IN ('PT15M', 'PT60M')),
    aw_groesser_null  BOOLEAN      NOT NULL,  -- "Ja" = TRUE, "Nein" = FALSE
    source            TEXT         NOT NULL DEFAULT 'netztransparenz',
    fetched_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (regel, ts)
);

CREATE TABLE IF NOT EXISTS annual_market_value (
    year          INTEGER        NOT NULL CHECK (year BETWEEN 2000 AND 2100),
    technology    TEXT           NOT NULL,  -- 'solar', 'wind_an_land', 'wind_auf_see', 'allgemein'
    value_ct_kwh  NUMERIC(8, 3)  NOT NULL,  -- the TSOs' native unit
    provisional   BOOLEAN        NOT NULL DEFAULT FALSE,
    source        TEXT           NOT NULL DEFAULT 'netztransparenz',
    fetched_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (technology, year)
);
