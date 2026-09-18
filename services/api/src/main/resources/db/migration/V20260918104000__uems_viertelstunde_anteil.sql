-- AP-12 Folgepaket vp-uems-b12-tagesverlauf-speicher, zweiter Schnitt
-- (firstmate 18.09.2026: Option A): der Anteil eines Vorzeichen-Kanals JE
-- ROHWERT, dort gespeichert, wo er entsteht.
--
-- Warum HIER und nicht eine Ebene hoeher: AP-08 E15/M5 sagt woertlich, ein
-- vorzeichenbehafteter Kanal wird "je Rohwert, VOR JEDER VERDICHTUNG" in
-- max(0, P) und max(0, -P) getrennt. Ab der Tages-Ebene ist die Viertelstunde
-- schon zu EINER vorzeichenbehafteten Energie verdichtet; ein Vorzeichen-
-- wechsel INNERHALB der Viertelstunde waere verloren, eine Summe ueber
-- Viertelstunden-Vorzeichen also eine Naeherung. Eine Naeherung hat in einem
-- Nachweis, den ein Berichts-Abzug byte-gleich festhaelt, nichts zu suchen
-- (bericht.md EW3/A6).
--
-- Die beiden Spalten stehen neben `energie`, nicht an ihrer Stelle: `energie`
-- bleibt die vorzeichenbehaftete Energie der Viertelstunde und jede heute
-- sichtbare Zahl bleibt byte-gleich.
--
-- ---- Warum das am Hypertable eine reine METADATEN-Aenderung ist ------------
-- 1. ADD COLUMN auf eine NULLBARE Spalte OHNE Default schreibt seit
--    PostgreSQL 11 nur den Katalog um -- kein Tabellen-Rewrite, kein Scan.
--    TimescaleDB reicht das an die Chunks weiter, mit derselben Eigenschaft.
-- 2. KOMPRIMIERTE Chunks kann es an dieser Tabelle nicht geben: sie traegt
--    seit V20260912170000 ENABLE + FORCE ROW LEVEL SECURITY, und TimescaleDB
--    verweigert Kompression auf einer Tabelle mit RLS ("compression cannot be
--    used on table with row security" -- dieselbe Klasse ist in
--    V20260809000000 als Grund vermerkt, warum hier nur `forecast` komprimiert
--    ist). An `messreihe_viertelstunde` laeuft nur eine Aufbewahrungs-Regel
--    (3653 Tage), keine Kompressions-Regel.
-- 3. Der CHECK steht darum ausdruecklich als NOT VALID: ein gueltiger CHECK
--    muesste jede bestehende Zeile lesen (auf dieser Tabelle der teuerste Teil
--    ueberhaupt), NOT VALID schreibt nur den Katalog. Fuer JEDE neue oder
--    geaenderte Zeile gilt er trotzdem -- und mehr behauptet er nicht, denn
--    der Bestand ist ueberall NULL.
--
-- Bestand: keine Nachfuellung, kein Default, kein neuer Fremdschluessel.
-- Viertelstunden von VOR diesem Paket behalten ihr NULL-Paar; der Bericht
-- zeigt das Paar dann als fehlend MIT Grund, nie als 0 (unbekannt ist keine
-- Null). Nachgerechnet wird nur ueber den bestehenden Rueckrechnungsweg und
-- nur aus noch vorhandenen Rohwerten.
ALTER TABLE messreihe_viertelstunde ADD COLUMN IF NOT EXISTS energie_positiv NUMERIC;
ALTER TABLE messreihe_viertelstunde ADD COLUMN IF NOT EXISTS energie_negativ NUMERIC;

-- Ein Anteil ist ein Betrag; er ist nie negativ (VerbrauchRegeln.anteilDesWerts).
ALTER TABLE messreihe_viertelstunde ADD CONSTRAINT messreihe_viertelstunde_anteil_chk
    CHECK (energie_positiv >= 0 AND energie_negativ >= 0) NOT VALID;

COMMENT ON COLUMN messreihe_viertelstunde.energie_positiv IS
    'Der positive Anteil eines Kanals mit zwei Flussrichtungen in einer Groesse: '
    'die Energie aus max(0, P) JE ROHWERT (AP-08 E15/M5), integriert wie energie. '
    'NULL = der Kanal fuehrt keine zwei Richtungen, seine Menge entsteht nicht aus '
    'integrierter Leistung, oder die Verdichtung lief vor V20260918104000.';
COMMENT ON COLUMN messreihe_viertelstunde.energie_negativ IS
    'Der Betrag des negativen Anteils derselben Viertelstunde: Energie aus '
    'max(0, -P) je Rohwert. energie bleibt die vorzeichenbehaftete Energie.';
-- Die Tabellenrechte decken nullbare Zusatzspalten; RLS und FORCE stehen an der
-- Tabelle, nicht an der Spalte.
