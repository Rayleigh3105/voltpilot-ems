-- =============================================================================
-- UEMS AP-08 IP-3 — INTERVALLMENGE und MOMENTANWERT je Periode: Mittel, Min,
-- Max, gemessene Zeit — und die GEKENNZEICHNETE Integration aus Leistung.
--
-- Konzept vp-uems-ap08-verbrauch §4.2 (I1–I5, M1–M6), §4.5 (Fortpflanzung),
-- §8 IP-3; Captain-Entscheide 11.09.2026 (E5 = A: Energie aus Leistung nur als
-- gekennzeichnete Größe „aus Leistung integriert", Rechteck-Halten ≤ 2 × Kadenz,
-- nur gemessene Zeit; E6 = A: Vollständigkeit aus den Lücken, nicht aus dem
-- Prozentwert).
--
-- DIE DREI WERTARTEN. Der Zählerstand ist seit IP-2/IP-5 durch (`menge` aus den
-- Periodenständen). Dieses Paket ergänzt die zwei anderen:
--   * MOMENTANWERT (gauge): Mittel, Min, Max über die guten Werte, die GEMESSENE
--     ZEIT — und, wo eine Quellenbindung die Herleitung `integration` trägt,
--     die ENERGIE aus der Leistung. Nie in `menge` (M6: ein Momentanwert liefert
--     nie die Verbrauchsmenge), nie ohne Kennzeichen (E5), nie über eine Lücke
--     hinweg aufgefüllt.
--   * INTERVALLMENGE: die Regel ist verdrahtet, die Spalten stehen — aber das
--     Rohwert-Vokabular (value_kind: counter, gauge, state, bitfield, text) hat
--     heute KEIN Wort dafür (Befund aus AP-07 IP-12, ViertelstundeRegeln.
--     regelWort). Die Intervallmenge einer MESSSTELLE entsteht aus einem Zähler
--     (Herleitung `differenzen`) oder aus einer Leistung (`integration`).
--
-- Gerechnet wird hier NICHTS. Die Regeln sind `VerbrauchRegeln.momentanwertTeil`
-- / `momentanwertAusTeilperioden` (Vertrag verbrauch-vectors.json,
-- `regeln.werte_teilperioden`, F3, F18, F24; Python-Zwilling verbrauch.py).
--
-- WAS SCHON DASTAND UND NICHT DOPPELT ANGELEGT WIRD: an der Viertelstunde
-- `mittel`, `min_wert`, `max_wert`, `summe` (AP-07 IP-12), `menge_zustand`,
-- `kennzeichen` (IP-2), `erhalten`/`erwartet`/`abdeckung_prozent`, die
-- Qualitätszähler; am Tag zusätzlich `mittel`/`min_wert`/`max_wert` (IP-13) und
-- `menge_zustand`/`kennzeichen` (IP-5); am Monat/Jahr `menge_zustand`,
-- `kennzeichen`, `erster_*`/`letzter_*` (IP-5).
--
-- ADDITIV. Nur neue, NULL-bare Spalten und CHECKs, die jede bestehende Zeile
-- schon erfüllt (Momentanwert-Zeilen tragen heute keine Menge, keine Summe und
-- keine Energie). Keine Zeile ändert sich durch diese Migration (per
-- Fingerabdruck bewiesen, UemsIntervallMomentanwertTest).
--
-- ⚠ WAS HIER NICHT ENTSTEHT: kein neues Wort im Rohwert-Vokabular, keine
-- Korrektur, keine Kaskade, keine Version > 1 (IP-12 ff.), keine Ersatzwerte
-- (E7), keine Vorzeichen-Aufteilung (M5 = IP-7), keine Route, kein Lesepfad.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Die Hausregel E5 an der Datenbankgrenze: eine Energie steht nie ohne ihr
--    Kennzeichen
-- -----------------------------------------------------------------------------
-- Geprüft wird das WORT des Kennzeichen-Vokabulars („aus Leistung integriert",
-- `kennzeichen` der Vektor-Datei), nicht der ganze Satz — dessen Wortlaut hält
-- der Vertrag mit beiden Zwillingen (VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT).
CREATE OR REPLACE FUNCTION messreihe_energie_gekennzeichnet(energie NUMERIC, kennzeichen JSONB)
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT energie IS NULL
        OR (jsonb_typeof(kennzeichen) = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(kennzeichen) AS k(satz)
                         WHERE satz LIKE 'aus Leistung integriert%'));
$$;

COMMENT ON FUNCTION messreihe_energie_gekennzeichnet(NUMERIC, JSONB) IS
    'AP-08 IP-3 / E5: eine Energie aus Leistung steht nie ohne das Kennzeichen "aus Leistung '
    'integriert" - sonst waere sie von einer gemessenen Energiemenge nicht zu unterscheiden.';

-- -----------------------------------------------------------------------------
-- 2. Die Viertelstunde
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_viertelstunde
    -- M4/E5: die Energie aus der Leistung in der Einheit der Reihe × Stunde
    -- (kW → kWh), UNGERUNDET — nur so ergeben die Viertelstunden zusammen genau
    -- den Tag. Nur, wenn eine Quellenbindung der Reihe die Herleitung
    -- `integration` trägt; NULL heißt „nicht integriert" oder „kein guter Wert",
    -- NIE 0.
    ADD COLUMN IF NOT EXISTS energie      NUMERIC,
    -- M2: die gemessene Zeit in Sekunden (gute Werte × Kadenz). Nur Momentanwert.
    ADD COLUMN IF NOT EXISTS gemessen_s   INTEGER,
    -- M3 über Perioden: zwischen zwei guten Werten DIESER Viertelstunde liegt
    -- eine Lücke (über 2 × Kadenz). Ein gröberer Zeitraum braucht das, weil ein
    -- unvollständiger RAND an einer inneren Grenze kein Rand mehr ist — eine
    -- Lücke aber eine Lücke bleibt. Nur Momentanwert.
    ADD COLUMN IF NOT EXISTS luecke_innen BOOLEAN;

ALTER TABLE messreihe_viertelstunde
    ADD CONSTRAINT messreihe_viertelstunde_energie_kennzeichen_chk
        CHECK (messreihe_energie_gekennzeichnet(energie, kennzeichen)),
    -- M6: ein Momentanwert liefert nie eine Menge; eine Energie kommt nur aus ihm.
    ADD CONSTRAINT messreihe_viertelstunde_momentanwert_chk
        CHECK ((wertart IS DISTINCT FROM 'gauge' OR menge IS NULL)
               AND (energie IS NULL OR wertart = 'gauge')),
    ADD CONSTRAINT messreihe_viertelstunde_keine_werte_energie_chk
        CHECK (menge_zustand IS DISTINCT FROM 'keine Werte' OR (energie IS NULL AND summe IS NULL)),
    ADD CONSTRAINT messreihe_viertelstunde_gemessen_chk
        CHECK (gemessen_s IS NULL OR gemessen_s >= 0);

-- -----------------------------------------------------------------------------
-- 3. Der Tag
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_tag
    -- Die Summe der guten Werte des Tages, UNGERUNDET — das Mittel ist
    -- summe ÷ erhalten, nie ein Mittel von Mitteln.
    ADD COLUMN IF NOT EXISTS summe        NUMERIC,
    ADD COLUMN IF NOT EXISTS energie      NUMERIC,
    ADD COLUMN IF NOT EXISTS gemessen_s   INTEGER,
    ADD COLUMN IF NOT EXISTS luecke_innen BOOLEAN;

ALTER TABLE messreihe_tag
    ADD CONSTRAINT messreihe_tag_energie_kennzeichen_chk
        CHECK (messreihe_energie_gekennzeichnet(energie, kennzeichen)),
    ADD CONSTRAINT messreihe_tag_momentanwert_chk
        CHECK ((wertart IS DISTINCT FROM 'gauge' OR menge IS NULL)
               AND (energie IS NULL OR wertart = 'gauge')),
    ADD CONSTRAINT messreihe_tag_keine_werte_energie_chk
        CHECK (menge_zustand IS DISTINCT FROM 'keine Werte' OR (energie IS NULL AND summe IS NULL)),
    ADD CONSTRAINT messreihe_tag_gemessen_chk
        CHECK (gemessen_s IS NULL OR gemessen_s >= 0);

-- -----------------------------------------------------------------------------
-- 4. Monat und Jahr — die Klasse hatte bisher gar kein Mittel
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_periode
    ADD COLUMN IF NOT EXISTS mittel       NUMERIC,
    ADD COLUMN IF NOT EXISTS min_wert     NUMERIC,
    ADD COLUMN IF NOT EXISTS max_wert     NUMERIC,
    ADD COLUMN IF NOT EXISTS summe        NUMERIC,
    ADD COLUMN IF NOT EXISTS energie      NUMERIC,
    ADD COLUMN IF NOT EXISTS gemessen_s   INTEGER,
    ADD COLUMN IF NOT EXISTS luecke_innen BOOLEAN;

ALTER TABLE messreihe_periode
    ADD CONSTRAINT messreihe_periode_energie_kennzeichen_chk
        CHECK (messreihe_energie_gekennzeichnet(energie, kennzeichen)),
    ADD CONSTRAINT messreihe_periode_momentanwert_chk
        CHECK ((wertart IS DISTINCT FROM 'gauge' OR menge IS NULL)
               AND (energie IS NULL OR wertart = 'gauge')),
    ADD CONSTRAINT messreihe_periode_keine_werte_energie_chk
        CHECK (menge_zustand IS DISTINCT FROM 'keine Werte' OR (energie IS NULL AND summe IS NULL)),
    ADD CONSTRAINT messreihe_periode_gemessen_chk
        CHECK (gemessen_s IS NULL OR gemessen_s >= 0);

-- -----------------------------------------------------------------------------
-- 5. Rechte
-- -----------------------------------------------------------------------------
-- NICHTS zu tun: Rechte hängen an den TABELLEN (App nur SELECT, Schreiben über
-- die BYPASSRLS-Rolle), die neuen Spalten erben sie; RLS + FORCE gilt je Zeile.
-- Geprüft wird es trotzdem (UemsIntervallMomentanwertTest).

-- -----------------------------------------------------------------------------
-- 6. Was die Spalten bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN messreihe_viertelstunde.summe IS
    'Die Summe der guten Werte im Fenster der Wertart-Regel, UNGERUNDET: Intervallmenge (I1) die '
    'Mengen mit Ende in (Beginn, Ende]; seit AP-08 IP-3 auch Momentanwert (M2) die Werte in '
    '[Beginn, Ende) - daraus das Mittel groeberer Perioden als summe / erhalten, nie als Mittel von '
    'Mitteln. Zaehlerstand: NULL.';
COMMENT ON COLUMN messreihe_viertelstunde.energie IS
    'AP-08 IP-3 / E5: die Energie aus der Leistung (Einheit der Reihe x Stunde), UNGERUNDET, '
    'Rechteck-Halten bis zum naechsten guten Wert (hoechstens 2 x Kadenz), nur gemessene Zeit. Nur mit '
    'Kennzeichen "aus Leistung integriert" und nur, wenn eine Quellenbindung der Reihe die Herleitung '
    'integration traegt. NULL = nicht integriert oder kein guter Wert - nie 0, nie Mittel x Laenge.';
COMMENT ON COLUMN messreihe_viertelstunde.gemessen_s IS
    'AP-08 M2: die gemessene Zeit in Sekunden (gute Werte x Kadenz). Nur Momentanwert.';
COMMENT ON COLUMN messreihe_viertelstunde.luecke_innen IS
    'AP-08 M3: zwischen zwei guten Werten dieser Periode liegt eine Luecke (> 2 x Kadenz). Nur '
    'Momentanwert; ein groeberer Zeitraum setzt daraus seine Vollstaendigkeit zusammen.';
COMMENT ON COLUMN messreihe_tag.summe IS
    'AP-08 IP-3: die Summe der guten Werte des Tages, ungerundet (Summe der Viertelstunden-Summen). '
    'Das Mittel ist summe / erhalten.';
COMMENT ON COLUMN messreihe_tag.energie IS
    'AP-08 IP-3 / E5: die Energie aus Leistung des Tages, ungerundet - Summe der Viertelstunden-'
    'Energien plus das Halten ueber Viertelstunden ohne Wert. Nur mit Kennzeichen "aus Leistung '
    'integriert"; NULL, wenn nicht jede Viertelstunde mit Werten integriert wurde.';
COMMENT ON COLUMN messreihe_tag.menge_zustand IS
    'AP-08 §4.5: vollstaendig / unvollstaendig / keine Werte - nicht die Spalte zustand '
    '(vorlaeufig/endgueltig). Zaehlerstand seit IP-5, Momentanwert seit IP-3 (Luecken und Raender '
    'nach M3, nicht der Prozentwert). NULL = keine Regel fuer diese Wertart.';
COMMENT ON COLUMN messreihe_periode.mittel IS
    'AP-08 IP-3: das Mittel der guten Werte der Periode = summe / erhalten, auf eine Nachkommastelle wie '
    'die Viertelstunde - nie ein Mittel von Mitteln.';
COMMENT ON COLUMN messreihe_periode.energie IS
    'AP-08 IP-3 / E5: die Energie aus Leistung der Periode, ungerundet, nur mit Kennzeichen "aus '
    'Leistung integriert". Monat aus den Viertelstunden, Jahr aus den Monaten.';
