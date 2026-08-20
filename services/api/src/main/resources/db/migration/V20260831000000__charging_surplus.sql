-- =============================================================================
-- V20260831000000 - PV-Ueberschussladen: die QUELLEN-Wahl des Kunden (Stufe 4).
-- -----------------------------------------------------------------------------
-- Bis hierher besass das Portal genau EINE Zahl ueber den Ladepark: die
-- Anschlussgrenze (Stufe 3). Sie sagt, WIE VIEL insgesamt fliessen darf. Stufe 4
-- fuegt die zweite Frage hinzu, und sie ist eine andere: WOHER der Ladestrom
-- kommen soll.
--
-- ⚠ ES ENTSTEHT KEINE ZWEITE GRENZE. Die zwei Bahnen komponieren
-- most-restrictive-wins, und keine kann die andere aufweichen: das
-- Lastmanagement schuetzt den Anschluss (physisch), das Ueberschussladen
-- entscheidet die Quelle (wirtschaftlich). Gerechnet und durchgesetzt wird beides
-- weiter auf der BOX - die Anschlussgrenze ist eine physische Grenze, ihr
-- Waechter darf nicht am WAN haengen (Konzept E1).
--
-- ⚠ NULL heisst "der Kunde hat nichts gewaehlt" und die Box behaelt ihre eigene
-- Einstellung - es heisst NIE 'schnell'. 'schnell' ist eine AUSSAGE des Kunden
-- ("keine Quellen-Politik"); die beiden zu verschmelzen liesse ein spaeter
-- ergaenztes Feld eine bestehende Wahl still ueberschreiben. Deshalb sind beide
-- Spalten NULLABLE OHNE Default (dieselbe Dreiwertigkeit wie can_apply /
-- cert_source).
--
-- Dazu die Beobachtungs-Seite: was die BOX ueber ihre Quellen-Bahn meldet, wird
-- neben dem Budget aufbewahrt (je Herzschlag ganz ersetzt, wie der Rest von
-- device_charging_budget), und je Stecker, ob eine Uebersteuerung laeuft.
--
-- Alles ADDITIV: eine Anlage ohne Wahl und eine aeltere Box verhalten sich
-- zeichengleich wie vor dieser Migration.
--
-- Datums-Version nach der AGENTS.md-Regel zur Migrations-Koordination.
-- =============================================================================

-- --- Die WAHL des Kunden (Portal -> retained Dokument -> Box) ---------------

ALTER TABLE site_charging_config
    ADD COLUMN IF NOT EXISTS surplus_policy   TEXT,
    ADD COLUMN IF NOT EXISTS storage_priority TEXT;

-- Das Vokabular des Kontrakts, hier ein zweites Mal festgenagelt: ein Wort, das
-- die Box nicht kennt, darf gar nicht erst gespeichert werden koennen.
ALTER TABLE site_charging_config DROP CONSTRAINT IF EXISTS site_charging_config_policy_chk;
ALTER TABLE site_charging_config ADD CONSTRAINT site_charging_config_policy_chk
    CHECK (surplus_policy IS NULL
           OR surplus_policy IN ('nur_sonne', 'sonne_zuerst', 'schnell'));

ALTER TABLE site_charging_config DROP CONSTRAINT IF EXISTS site_charging_config_storage_chk;
ALTER TABLE site_charging_config ADD CONSTRAINT site_charging_config_storage_chk
    CHECK (storage_priority IS NULL
           OR storage_priority IN ('speicher_vor_auto', 'auto_vor_speicher'));

-- --- Was die BOX darueber meldet (Herzschlag -> Anzeige) --------------------

ALTER TABLE device_charging_budget
    -- Die Wahl, wie die Box sie WIRKLICH faehrt (sie kann von der gepflegten
    -- abweichen, solange ein retained Dokument noch nicht angekommen ist - genau
    -- das soll eine Flaeche sehen koennen).
    ADD COLUMN IF NOT EXISTS surplus_policy     TEXT,
    ADD COLUMN IF NOT EXISTS storage_priority   TEXT,
    -- Ob ueberhaupt eine Quellen-Bahn gilt, und welche Stufe sie hat.
    ADD COLUMN IF NOT EXISTS surplus_active     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS surplus_mode       TEXT,
    ADD COLUMN IF NOT EXISTS surplus_note       TEXT,
    ADD COLUMN IF NOT EXISTS surplus_blind      BOOLEAN NOT NULL DEFAULT FALSE,
    -- Die Zahlen. NULLABLE, weil kein Messwert NIE eine 0 ist: surplus_kw ist
    -- nur bei aktiver Bahn gesetzt, total/battery nur bei frischer Messung.
    ADD COLUMN IF NOT EXISTS surplus_kw         DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS surplus_total_kw   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS surplus_battery_kw DOUBLE PRECISION,
    -- Wie viel der Zuteilung die Sonne gerade deckt - eine STANDORT-Aussage,
    -- nie eine Solarquote je Fahrzeug (Strom ist am Hub nicht etikettiert).
    ADD COLUMN IF NOT EXISTS source_allocated_kw DOUBLE PRECISION;

ALTER TABLE device_charge_connector
    -- Laeuft an diesem Stecker gerade eine Uebersteuerung? Die Flaeche SAGT es:
    -- eine volle Ladung, die niemand angefordert hat, waere ein stiller Bruch
    -- der eigenen Prioritaet des Kunden.
    ADD COLUMN IF NOT EXISTS boost BOOLEAN NOT NULL DEFAULT FALSE;
