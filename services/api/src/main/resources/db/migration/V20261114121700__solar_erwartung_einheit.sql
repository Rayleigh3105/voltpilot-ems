-- =============================================================================
-- V20261114121700 - Anlagen-Check A1 (Bedienkonzept vp-privatkunde-bedienkonzept
-- §9.2, Captain BK-4 = A): die am Vortag erwartete Erzeugung JE EINHEIT und Tag.
-- -----------------------------------------------------------------------------
-- Die Prognose einer Anlage ist eine Summe über die Dachflächen ihrer
-- bestätigten PV-Einheiten (S4); `forecast` hält nur diese Summe. Der Rückblick-
-- Lauf des Prognose-Dienstes (voltpilot_forecast.rueckblick, derselbe Lauf wie
-- forecast_rueckblick) teilt den Abend-Lauf (17:45 ± 15 min des Vortags) je
-- Viertelstunde nach dem physikalischen Anteil jeder Einheit auf und legt die
-- Tagessumme hier ab (voltpilot_forecast.einheit_erwartung). Die Einheiten eines
-- Tages und Modells summieren sich zur Tagessumme des Abend-Laufs.
--
-- Bauart wie forecast_rueckblick (V20261111170000): RLS-gebunden, der Lauf
-- schreibt als vertraute Backend-Rolle und trägt tenant_id selbst ein, das
-- Portal liest über die RLS-gebundene App-Rolle (nur SELECT). Jedes Modell der
-- Anlage bekommt Zeilen; die api liest die des AKTIVEN PV-Modells.
--
-- `leistung_kwp` ist die kWp der Einheit am Tag der Rechnung - die Regel
-- „Sonnentag" (erwartet ab 0,5 kWh je kWp) braucht sie je Tag, auch wenn die
-- Einheit später anders bestätigt wird.
--
-- Rein additiv: neue Tabelle, keine Rückfüllung (rückwirkend nur über
-- `rueckblick run --days-back`, solange `forecast` den Abend-Lauf hält).
-- Funktioniert auf frischer DB in Versionsreihenfolge (register_einheit ab
-- V20261112100000) und bei späterer Ankunft (out-of-order).
-- =============================================================================

CREATE TABLE IF NOT EXISTS solar_erwartung_einheit (
    day           DATE           NOT NULL,  -- Europe/Berlin Tag (wie Historie)
    tenant_id     UUID           NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id       UUID           NOT NULL,
    einheit_id    UUID           NOT NULL REFERENCES register_einheit(id) ON DELETE CASCADE,
    model         TEXT           NOT NULL,  -- Registry-Modell-Id
    lead_days     SMALLINT       NOT NULL CHECK (lead_days >= 1),
    erwartet_kwh  NUMERIC(12, 4) NOT NULL CHECK (erwartet_kwh >= 0),
    leistung_kwp  NUMERIC(10, 3) NOT NULL CHECK (leistung_kwp > 0),
    computed_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, einheit_id, model, day, lead_days)
);
CREATE INDEX IF NOT EXISTS idx_solar_erwartung_einheit_site_day
    ON solar_erwartung_einheit (site_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_solar_erwartung_einheit_tenant
    ON solar_erwartung_einheit (tenant_id);
CREATE INDEX IF NOT EXISTS idx_solar_erwartung_einheit_einheit
    ON solar_erwartung_einheit (einheit_id);

-- V2s ALTER DEFAULT PRIVILEGES gäbe der App-Rolle auch INSERT/UPDATE/DELETE; es gibt keinen Schreibpfad der
-- api (nur der Rückblick-Lauf schreibt) - also lesen ja, schreiben nein (das component_template-Muster).
GRANT SELECT ON solar_erwartung_einheit TO ${appDbUser};
REVOKE INSERT, UPDATE, DELETE ON solar_erwartung_einheit FROM ${appDbUser};

ALTER TABLE solar_erwartung_einheit ENABLE ROW LEVEL SECURITY;
ALTER TABLE solar_erwartung_einheit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS solar_erwartung_einheit_isolation ON solar_erwartung_einheit;
CREATE POLICY solar_erwartung_einheit_isolation ON solar_erwartung_einheit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE solar_erwartung_einheit IS
    'Am Vortag erwartete PV-Erzeugung je bestaetigter Einheit und Tag (Abend-Lauf '
    'nach physikalischem Anteil aufgeteilt). Geschrieben vom Rueckblick-Lauf des '
    'Prognose-Dienstes; gelesen vom Anlagen-Check. Bedienkonzept '
    'vp-privatkunde-bedienkonzept, report.md Abschnitt 9.2 A1.';
