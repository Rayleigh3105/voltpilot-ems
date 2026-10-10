-- Folgepaket vp-uems-bilanz-richtungspaar-korrektur: eine KORRIGIERTE Version
-- traegt ihr Richtungspaar mit.
--
-- V20260918104000 bildet den Anteil eines Kanals mit zwei Flussrichtungen je
-- Rohwert in der Viertelstunde, V20260918101000 summiert ihn in Tag und
-- Periode -- aber nur fuer Version 1. Die Versionen der Korrektur-Kaskade
-- (AP-08 IP-17) hatten keine Spalte dafuer; die Bilanz setzte einen Laden-/
-- Entladen-Term darum nach jeder Korrektur ehrlich auf "keine Werte"
-- (BilanzRichtungswerte, AP-16 IP-9).
--
-- Die Spalten folgen derselben Regel wie Version 1, eine Ebene hoeher nichts
-- neu gerechnet:
--   messreihe_viertelstunde_version.energie_positiv/_negativ -- aus denselben
--     Rohwert-Fakten wie `energie` derselben Zeile (Nachlieferung,
--     Ablesestaende, Umklassifizierung), sonst NULL;
--   messreihe_periode_version.menge_positiv/_negativ -- Tag und Monat aus den
--     Viertelstunden in ihrer neuesten Fassung, das Jahr aus seinen Monaten.
-- NULL bleibt, wo die Richtung fachlich nicht bestimmbar ist: ein berichtigter
-- Wert (wert_berichtigt) und jeder Ersatzwert setzen eine Nettomenge, keine
-- Richtung; eine berechnete Messstelle hat kein Paar.
--
-- Bestand: keine Nachfuellung, kein Default, kein neuer Fremdschluessel.
-- Versionen von VOR diesem Paket behalten ihr NULL-Paar (unbekannt ist keine
-- Null); eine noch vorlaeufige zieht es beim naechsten Nachzug mit.
-- Version 1 (messreihe_viertelstunde, messreihe_tag, messreihe_periode) wird
-- nicht angefasst.
ALTER TABLE messreihe_viertelstunde_version ADD COLUMN IF NOT EXISTS energie_positiv NUMERIC;
ALTER TABLE messreihe_viertelstunde_version ADD COLUMN IF NOT EXISTS energie_negativ NUMERIC;
ALTER TABLE messreihe_periode_version       ADD COLUMN IF NOT EXISTS menge_positiv NUMERIC;
ALTER TABLE messreihe_periode_version       ADD COLUMN IF NOT EXISTS menge_negativ NUMERIC;

-- Ein Anteil ist ein Betrag; er ist nie negativ (VerbrauchRegeln.anteilDesWerts).
ALTER TABLE messreihe_viertelstunde_version DROP CONSTRAINT IF EXISTS messreihe_viertelstunde_version_anteil_chk;
ALTER TABLE messreihe_viertelstunde_version ADD CONSTRAINT messreihe_viertelstunde_version_anteil_chk
    CHECK (energie_positiv >= 0 AND energie_negativ >= 0);
ALTER TABLE messreihe_periode_version DROP CONSTRAINT IF EXISTS messreihe_periode_version_richtungspaar_chk;
ALTER TABLE messreihe_periode_version ADD CONSTRAINT messreihe_periode_version_richtungspaar_chk
    CHECK (menge_positiv >= 0 AND menge_negativ >= 0);

COMMENT ON COLUMN messreihe_viertelstunde_version.energie_positiv IS
    'Wie messreihe_viertelstunde.energie_positiv, fuer diese Version: aus denselben Rohwert-Fakten '
    'wie energie. NULL = keine zwei Richtungen, eine Nettomengen-Berichtigung oder ein Ersatzwert '
    '(keine Richtung bestimmbar), oder die Version entstand vor V20260923231500.';
COMMENT ON COLUMN messreihe_viertelstunde_version.energie_negativ IS
    'Der Betrag des negativen Anteils derselben Version; unbekannt ist keine Null.';
COMMENT ON COLUMN messreihe_periode_version.menge_positiv IS
    'Wie messreihe_tag/messreihe_periode.menge_positiv, fuer diese Version: aus den Viertelstunden '
    'in ihrer neuesten Fassung summiert (das Jahr aus seinen Monaten). NULL, sobald ein Teil sein '
    'Paar nicht traegt oder ein Ersatzwert in der Periode wirkt.';
COMMENT ON COLUMN messreihe_periode_version.menge_negativ IS
    'Wie messreihe_periode_version.menge_positiv, fuer den negativen Anteil.';
-- SELECT/INSERT/DELETE stehen an der Tabelle und decken die Zusatzspalten; RLS
-- und FORCE ebenso. UPDATE auf messreihe_periode_version ist dagegen SPALTENWEISE
-- vergeben (V20260914120000: der Nachzug einer vorlaeufigen Version darf nur ihren
-- Inhalt schreiben, nie Schluessel, Nummer oder Anlass). Das Richtungspaar ist
-- Inhalt und zieht mit -- darum hier die beiden Spalten dazu, sonst scheitert jeder
-- Nachzug an "permission denied". messreihe_viertelstunde_version kennt kein UPDATE.
GRANT UPDATE (menge_positiv, menge_negativ) ON messreihe_periode_version TO ${adminDbUser};
