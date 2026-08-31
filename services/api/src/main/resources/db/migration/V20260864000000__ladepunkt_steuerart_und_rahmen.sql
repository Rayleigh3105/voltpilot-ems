-- Verbrauchsmanagement v1 / P5: die STEUERART je Ladepunkt und der
-- Ladepark-RAHMEN (Konzept `vp-verbrauchsmgmt-konzept-v1` §2.3, Entscheid E10).
--
-- ZWEI Dinge, zwei Tabellen, zwei verschiedene Aussagen:
--
--   * `site_charge_point_allowlist.source` / `.min_kw` sind die Steuerart EINER
--     Saeule - woher IHR Ladestrom kommen soll und, fuer die Quelle
--     „Sonne zuerst", ab welcher Leistung sie ueberhaupt anfaengt. Der
--     site-weite `site_charging_config.surplus_policy` bleibt daneben der
--     ANLAGEN-STANDARD, dem jede Saeule folgt, die sich nicht selbst geaeussert
--     hat. Beides zu verschmelzen hiesse, eine Wahl fuer alle zu treffen.
--   * die sechs `site_charging_config`-Spalten sind der RAHMEN des Ladeparks -
--     bis hierher konnte ihn nur `:8484` pflegen, und ein Kunde konnte im
--     Portal nicht einmal LESEN, wonach seine Anlage rechnet.
--
-- ALLE Spalten NULLABLE OHNE DEFAULT, und das ist die PATCH-Semantik dieses
-- Pfads: NULL heisst „das Portal aeussert sich dazu nicht" und die BOX behaelt
-- ihren Wert. Es heisst NIE „schnell" und nie 0 - das eine waere eine
-- Netzstrom-Freigabe, die der Kunde nie erteilt hat, das andere eine Grenze,
-- die niemand gezogen hat.
--
-- ⚠ Die PLAUSIBILITAET des Rahmens prueft weiterhin die BOX
-- (`lastmgmt.Settings.Apply`) - sie kennt ihre Saeulen, ihre Stecker und ihre
-- gemessene Gebaeudelast. Hier steht nur, was der Betreiber gesagt hat.
--
-- Rein ADDITIV: eine Anlage ohne Ladepark und eine Box ohne diese Felder
-- verhalten sich zeichengleich wie vorher. RLS/Grants erben beide Tabellen
-- (V20260834000000 bzw. V20260829000000); ein ADD COLUMN aendert daran nichts.

ALTER TABLE site_charge_point_allowlist
    ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE site_charge_point_allowlist
    ADD COLUMN IF NOT EXISTS min_kw NUMERIC;

ALTER TABLE site_charge_point_allowlist
    DROP CONSTRAINT IF EXISTS site_charge_point_allowlist_source_chk;
ALTER TABLE site_charge_point_allowlist ADD CONSTRAINT site_charge_point_allowlist_source_chk
    CHECK (source IS NULL OR source IN ('nur_sonne', 'sonne_zuerst', 'schnell'));

ALTER TABLE site_charge_point_allowlist
    DROP CONSTRAINT IF EXISTS site_charge_point_allowlist_min_kw_chk;
ALTER TABLE site_charge_point_allowlist ADD CONSTRAINT site_charge_point_allowlist_min_kw_chk
    CHECK (min_kw IS NULL OR (min_kw >= 0 AND min_kw <= 1000));

-- Der Ladepark-Rahmen. `static_budget` ist NEGATIV formuliert (wie auf der Box),
-- damit sein Nullwert die gewollte Vorgabe ist: „nimm die Messung, wenn es eine
-- gibt".
ALTER TABLE site_charging_config
    ADD COLUMN IF NOT EXISTS house_reserve_kw NUMERIC;
ALTER TABLE site_charging_config
    ADD COLUMN IF NOT EXISTS margin_pct NUMERIC;
ALTER TABLE site_charging_config
    ADD COLUMN IF NOT EXISTS min_power_kw NUMERIC;
ALTER TABLE site_charging_config
    ADD COLUMN IF NOT EXISTS rotation_minutes INTEGER;
ALTER TABLE site_charging_config
    ADD COLUMN IF NOT EXISTS max_house_load_kw NUMERIC;
ALTER TABLE site_charging_config
    ADD COLUMN IF NOT EXISTS static_budget BOOLEAN;

ALTER TABLE site_charging_config
    DROP CONSTRAINT IF EXISTS site_charging_config_frame_chk;
ALTER TABLE site_charging_config ADD CONSTRAINT site_charging_config_frame_chk
    CHECK ((house_reserve_kw IS NULL OR (house_reserve_kw >= 0 AND house_reserve_kw <= 100000))
       AND (margin_pct IS NULL OR (margin_pct >= 0 AND margin_pct <= 50))
       AND (min_power_kw IS NULL OR (min_power_kw >= 0 AND min_power_kw <= 1000))
       AND (rotation_minutes IS NULL OR (rotation_minutes >= 1 AND rotation_minutes <= 240))
       AND (max_house_load_kw IS NULL OR (max_house_load_kw >= 0 AND max_house_load_kw <= 100000)));
