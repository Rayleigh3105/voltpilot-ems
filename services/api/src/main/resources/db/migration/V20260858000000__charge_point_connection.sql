-- Cockpit Phase 1 / C1: WO eine Ladesaeule haengt (Captain-Entscheid E5).
--
-- `haus` = hinter dem Hausanschluss - der Normalfall: ihre Leistung steckt in
-- der Netzmessung der Anlage, das Budget-Gesetz der Box
-- (`budget = planbar - (Netzbezug - Ladeleistung)`) gilt fuer sie.
-- `eigen` = ein EIGENER Netzanschluss/Zaehler: ihre Leistung steckt NICHT in
-- dieser Messung. Sie dort zurueckzuaddieren liesse den Rest zu klein und das
-- Budget zu gross ausfallen - der HAUSANSCHLUSS koennte um genau ihre Leistung
-- ueberschritten werden.
--
-- ZWEI Spalten, zwei Tabellen, zwei verschiedene Aussagen - und das ist Absicht:
--
--   * `site_charge_point_allowlist.connection` ist das SOLL des Kunden. Es
--     entsteht im Anbinde-Dialog und reist im retained Dokument zur Box.
--   * `device_charge_point.connection` ist das IST, das die Box MELDET. Erst es
--     belegt, dass die Unterscheidung dort wirklich angekommen ist - eine
--     Portal-Angabe allein sagt nichts darueber, wonach die Box rechnet.
--
-- Beide NULLABLE OHNE DEFAULT: NULL heisst „nicht gesagt" bzw. „nicht gemeldet"
-- (eine aeltere Box), NIE `eigen`. Wer daraus `eigen` machte, naehme eine reale
-- Ladeleistung aus der Bilanz einer Anlage, ueber die niemand etwas gesagt hat.
--
-- Rein ADDITIV: eine Anlage ohne Ladepunkt und eine Box ohne das Feld verhalten
-- sich zeichengleich wie vorher. RLS/Grants erben beide Tabellen (V20260834000000
-- bzw. V20260828000000); ein ADD COLUMN aendert daran nichts.

ALTER TABLE site_charge_point_allowlist
    ADD COLUMN IF NOT EXISTS connection TEXT;

ALTER TABLE site_charge_point_allowlist
    DROP CONSTRAINT IF EXISTS site_charge_point_allowlist_connection_chk;
ALTER TABLE site_charge_point_allowlist ADD CONSTRAINT site_charge_point_allowlist_connection_chk
    CHECK (connection IS NULL OR connection IN ('haus', 'eigen'));

ALTER TABLE device_charge_point
    ADD COLUMN IF NOT EXISTS connection TEXT;

ALTER TABLE device_charge_point
    DROP CONSTRAINT IF EXISTS device_charge_point_connection_chk;
ALTER TABLE device_charge_point ADD CONSTRAINT device_charge_point_connection_chk
    CHECK (connection IS NULL OR connection IN ('haus', 'eigen'));
