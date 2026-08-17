-- =============================================================================
-- V20260822000000 - „Grenzen & Wächter" Stufe 0: der EINSPEISEWÄCHTER und die
-- GERÄTE-EIGENE Einspeisegrenze werden cloud-seitig lesbar. ADDITIVE Spalten an
-- device_curtailment_status (V20260802020000) - keine neue Tabelle.
-- -----------------------------------------------------------------------------
-- Warum an DIESER Tabelle und nicht an einer eigenen: beide Aussagen kommen aus
-- dem SELBEN Herzschlag-Block (`curtailment`), werden je Herzschlag als Ganzes
-- ersetzt und beschreiben denselben Wirkpfad (die Einspeisebegrenzung am
-- Netzverknüpfungspunkt). Eine zweite Tabelle hätte einen zweiten Zuhörer, einen
-- zweiten Lesepfad und - der eigentliche Schaden - eine zweite Wahrheit über
-- dieselbe Momentaufnahme erzeugt.
--
-- WAS BISHER FEHLTE (Herzogau-Untersuchung Runde 1 §9-B / Runde 2 §2+§7):
-- die Box sendet den `export_guard`-Block seit ihrem Bau in JEDEM Herzschlag -
-- geltende Grenze, kommandierte Kappe, ob sie greift, und ob sie überhaupt an
-- ein Gerät geschrieben werden kann. Cloud-seitig las ihn NIEMAND. Die Frage
-- „welche Einspeisegrenze hält die Box, und wirkt sie überhaupt?" war deshalb
-- nur per Wartungstunnel zu beantworten; sie hat zwei Untersuchungsrunden
-- gekostet. Kein Edge-Release nötig - nur ein Lesepfad.
--
--   guard_limit_kw     die für die Anlage geltende Einspeisegrenze, wie die BOX
--                      sie kennt (aus `grid_export_limit_kw` des Fahrplans).
--   guard_state        ueberwacht | regelt | haelt | zieht_zusammen |
--                      sicherheitskappe - das maschinenlesbare Wort NEBEN dem
--                      deutschen Satz (das target_verdict-neben-state-Muster).
--                      Ein Wort außerhalb dieses Vokabulars wird beim Ingest
--                      verworfen; dann steht hier NULL und keine Fläche behauptet
--                      etwas.
--   guard_reason       der deutsche Satz der Box zu genau diesem Zustand.
--   guard_cap_kw       die anlagenweite PV-Kappe, die der Wächter gerade
--                      kommandiert (NULL = keine).
--   guard_limiting     die Kappe hält die Erzeuger gerade wirklich zurück.
--   guard_blind        das Urteil entstand NICHT aus einer frischen Messung am
--                      Netzverknüpfungspunkt (Halten / Zusammenziehen /
--                      Sicherheitskappe).
--   guard_effective    FALSE = die Kappe erreicht KEIN Gerät. Das ist das Feld,
--                      das eine Anlage davor bewahrt, an einen Schutz zu
--                      glauben, den sie nicht hat.
--   guard_reach        der deutsche Satz, der die Lücke benennt - LEER/NULL,
--                      wenn die Kappe jedes Gerät erreicht.
--
-- Die Geräte-eigene Grenze (Vierer #4, Runde 2 §3 K1) daneben: der Deye in
-- Herzogau hielt in 0x00E7 einen Installateur-Deckel von 33,0 kW, während im
-- Portal 70 kW hinterlegt waren - zwei Runden lang unsichtbar, weil niemand das
-- Register las.
--
--   device_export_limit_kw        die im Wechselrichter eingestellte
--                                 Einspeisegrenze am Netzpunkt.
--   device_export_limit_register  das Register, aus dem sie stammt ("0x00e7") -
--                                 der Beleg für den späteren Roh-Blick, damit
--                                 eine Zahl nie ohne ihre Herkunft dasteht.
--   device_export_limit_read_at   WANN das Gerät gelesen wurde. Ein EIGENER
--                                 Frische-Anker, weil dieses Register höchstens
--                                 einmal täglich gelesen wird (Ein-Socket-Gesetz)
--                                 - checked_at ist der Rücklese-Zeitpunkt der
--                                 Abregel-Einheiten und wäre hier eine falsche
--                                 Frischezusage.
--
-- ALLE Spalten sind NULLABLE OHNE DEFAULT: NULL heißt „hat die Box nicht
-- gemeldet" (ältere Edge, Familie ohne Register, noch nie gelesen) und NIE 0.
-- Eine ältere Box bleibt damit zeichengleich; ein älteres Portal ignoriert die
-- Spalten.
--
-- Date-based version per the AGENTS.md migration-version coordination
-- (V20260821000000 war der höchste ausgelieferte Stand).
-- =============================================================================

ALTER TABLE device_curtailment_status
    ADD COLUMN IF NOT EXISTS guard_limit_kw               DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS guard_state                  TEXT,
    ADD COLUMN IF NOT EXISTS guard_reason                 TEXT,
    ADD COLUMN IF NOT EXISTS guard_cap_kw                 DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS guard_limiting               BOOLEAN,
    ADD COLUMN IF NOT EXISTS guard_blind                  BOOLEAN,
    ADD COLUMN IF NOT EXISTS guard_effective              BOOLEAN,
    ADD COLUMN IF NOT EXISTS guard_reach                  TEXT,
    ADD COLUMN IF NOT EXISTS device_export_limit_kw       DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS device_export_limit_register TEXT,
    ADD COLUMN IF NOT EXISTS device_export_limit_read_at  TIMESTAMPTZ;

-- Das Vokabular als DB-CHECK, damit ein künftiger Schreiber es nicht umgehen
-- kann (der Ingest verwirft ein unbekanntes Wort schon vorher). NULL bleibt
-- ausdrücklich erlaubt = „nicht gemeldet".
ALTER TABLE device_curtailment_status
    DROP CONSTRAINT IF EXISTS device_curtailment_status_guard_state_chk;
ALTER TABLE device_curtailment_status
    ADD CONSTRAINT device_curtailment_status_guard_state_chk
    CHECK (guard_state IS NULL OR guard_state IN
        ('ueberwacht', 'regelt', 'haelt', 'zieht_zusammen', 'sicherheitskappe'));

-- Beides-oder-keines: eine Geräte-Grenze ohne ihren Lese-Zeitpunkt wäre eine
-- Zahl ohne Frische, und eine ohne Register eine Zahl ohne Herkunft.
ALTER TABLE device_curtailment_status
    DROP CONSTRAINT IF EXISTS device_curtailment_status_device_limit_chk;
ALTER TABLE device_curtailment_status
    ADD CONSTRAINT device_curtailment_status_device_limit_chk
    CHECK ((device_export_limit_kw IS NULL
                AND device_export_limit_register IS NULL
                AND device_export_limit_read_at IS NULL)
        OR (device_export_limit_kw IS NOT NULL
                AND device_export_limit_register IS NOT NULL
                AND device_export_limit_read_at IS NOT NULL));
