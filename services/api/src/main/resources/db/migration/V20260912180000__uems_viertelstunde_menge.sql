-- =============================================================================
-- UEMS AP-08 IP-2 — die MENGE je Viertelstunde: aus den gespeicherten Fakten
-- der Speicherklasse (V20260912170000) wird die erste echte VERBRAUCHSZAHL.
--
-- Konzept vp-uems-ap08-verbrauch §4.2 (Z1–Z3, Z8, Z9), §4.5 (Zustände),
-- Captain-Entscheide 11.09.2026 (alle Option A). Der Vertrag dazu liegt seit
-- AP-08 IP-1 als `docs/contracts/v2/verbrauch-vectors.json` samt beiden
-- Zwillingen (Python `verbrauch.py` ⟷ Java `uems/VerbrauchRegeln`) vor.
--
-- WAS DER VORGÄNGER AUSDRÜCKLICH OFFEN LIESS. V20260912170000 speichert je
-- Viertelstunde die FAKTEN — Stand am Anfang und am Ende (Z1), Summe, Mittel,
-- Min/Max, erster und letzter Wert, Qualitätszähler, Abdeckung, Anker — und
-- rechnet bewusst KEINE Differenz („die Strecke rechnet keine Differenz", A5).
-- Ihr Kommentar sagt darum wörtlich „Keine menge-Spalte". Diese Migration
-- ergänzt genau diese eine Aussage und schreibt den Kommentar fort.
--
-- ADDITIV. Vier neue Spalten an EINER Tabelle, alle mit Vorgabe bzw. NULL-bar:
-- keine bestehende Spalte wird angefasst, kein Index verändert, kein Recht
-- verschoben, keine Zeile einer anderen Tabelle berührt (per Fingerabdruck
-- bewiesen, UemsViertelstundeMengeTest).
--
-- WAS HIER NICHT PASSIERT (die Grenzen des Pakets):
--   * Das UMSCHALTEN auf `endgueltig`, die Spätankunft (`late_arrival`) und die
--     Tageswerte bleiben AP-07 IP-13. Der Lauf schreibt weiter NUR `vorlaeufig`
--     und rührt eine endgültige Zeile nie an.
--   * KORREKTUREN, Kaskade und Versionierung bleiben AP-08 IP-12 ff.;
--     `version` bleibt, wie der Lauf sie setzt (immer 1).
--   * ERSATZWERTE (E7) entstehen hier nicht. Das Wort `mit Ersatzwert` steht im
--     Vokabular, weil der VERTRAG es kennt (`zustaende` der Vektor-Datei) — der
--     Lauf schreibt es nie.
--   * Perioden über der Viertelstunde (Stunde/Tag/Monat/Jahr) sind IP-5.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Die Kennzeichen: eine Liste von KLARTEXT-Sätzen, Reihenfolge inbegriffen
-- -----------------------------------------------------------------------------
-- Ein Kennzeichen ist kein Code, sondern der Satz, den der Kunde liest („Anfang
-- nicht gemessen (kein Stand an der Periodengrenze)"). Sein WORTLAUT und seine
-- REIHENFOLGE sind Vertrag (verbrauch-vectors.json, `kennzeichen`); beide
-- Zwillinge vergleichen exakt. Darum ein JSONB-ARRAY, nicht ein Objekt und
-- nicht eine Menge: eine Umsortierung wäre eine andere Aussage.
--
-- Geprüft wird die FORM (Array aus nicht leeren Zeichenketten), nicht der
-- Wortlaut: das Vokabular wächst mit jeder Regel (IP-3 … IP-6), und eine
-- Datenbankgrenze, die den Satzbau kennt, müsste mit jedem Satz wandern. Was
-- die Sätze sein DÜRFEN, hält der Vertrag — und die Vektor-Tests halten ihn.
CREATE OR REPLACE FUNCTION messreihe_viertelstunde_kennzeichen_erlaubt(k JSONB)
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof(k) = 'array'
       AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(k) AS e(satz)
             WHERE jsonb_typeof(satz) <> 'string'
                OR btrim(satz #>> '{}') = ''
                OR char_length(satz #>> '{}') > 400);
$$;

COMMENT ON FUNCTION messreihe_viertelstunde_kennzeichen_erlaubt(JSONB) IS
    'AP-08 IP-2: die Kennzeichen sind ein ARRAY von Klartext-Saetzen - Wortlaut UND Reihenfolge '
    'sind Vertrag (verbrauch-vectors.json). Geprueft wird die Form, nicht der Satz.';

-- -----------------------------------------------------------------------------
-- 2. Die vier neuen Spalten
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_viertelstunde
    -- Z2/Z3: die Menge der Periode in der Einheit der Reihe. NULL heißt „keine
    -- Menge bildbar" — NIE 0. Eine Lücke, ein einzelner Stand, ein Rücksprung
    -- ohne Endstand: überall steht NULL, nie eine erfundene Null.
    ADD COLUMN IF NOT EXISTS menge         NUMERIC,
    -- §4.5: der Zustand der MENGE (vollständig · unvollständig · keine Werte).
    -- ⚠ NICHT zu verwechseln mit der Spalte `zustand` daneben: die trägt die
    -- Vorläufigkeit (vorlaeufig/endgueltig, AP-07 E5). Zwei verschiedene Fragen,
    -- darum zwei Spalten — „ist die Zahl endgültig?" und „ist jede Kilowattstunde
    -- gezählt?" haben nichts miteinander zu tun.
    -- NULL heißt „AP-08 kennt für diese Wertart keine Regel" (state/bitfield/
    -- text, S1/S2) — keine Aussage, nicht „unvollständig".
    ADD COLUMN IF NOT EXISTS menge_zustand TEXT,
    -- Was an dieser Viertelstunde zu sagen ist, in der Reihenfolge der
    -- Feststellung. Leeres Array heißt „nichts zu sagen".
    ADD COLUMN IF NOT EXISTS kennzeichen   JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Z8: der Faktor, mit dem die Rohwerte in die Einheit der Reihe gerechnet
    -- wurden. Er steht hier, damit `menge` ERKLÄRBAR ist und nicht nur behauptet.
    -- ⚠ Er ist heute IMMER 1, und das ist kein Platzhalter, sondern die Antwort
    -- des Vertrags quelle-einstellung.md §3: `angewendet` heißt „VoltPilot wendet
    -- sie BEIM ERFASSEN an", `dokumentiert` heißt „im Gerät eingestellt,
    -- VoltPilot rechnet nichts um" — in BEIDEN Fällen trägt der gespeicherte
    -- Rohwert den Faktor bereits. Ihn hier ein zweites Mal anzuwenden, würde ihn
    -- verdoppeln. Siehe ViertelstundeRegeln.FAKTOR_DER_FASSUNG.
    ADD COLUMN IF NOT EXISTS faktor        NUMERIC NOT NULL DEFAULT 1;

-- -----------------------------------------------------------------------------
-- 3. Die Regeln an der Datenbankgrenze
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_viertelstunde
    -- Das Vokabular des Vertrags (`zustaende`), geschlossen. Ein fremdes Wort
    -- wird abgewiesen, nie aufgelöst. `mit Ersatzwert` steht hier, weil der
    -- Vertrag es kennt; geschrieben wird es erst mit AP-08 E7 (IP-9).
    ADD CONSTRAINT messreihe_viertelstunde_menge_zustand_chk
        CHECK (menge_zustand IS NULL OR menge_zustand IN
               ('vollständig', 'unvollständig', 'keine Werte', 'mit Ersatzwert')),
    -- Die harte Hausregel an der Datenbankgrenze: wo kein guter Wert war, steht
    -- KEINE Zahl. „keine Werte" und eine Menge schließen einander aus.
    ADD CONSTRAINT messreihe_viertelstunde_keine_werte_chk
        CHECK (menge_zustand IS DISTINCT FROM 'keine Werte' OR menge IS NULL),
    ADD CONSTRAINT messreihe_viertelstunde_kennzeichen_chk
        CHECK (messreihe_viertelstunde_kennzeichen_erlaubt(kennzeichen)),
    -- Ein Faktor 0 löschte jede Menge aus; er ist nie eine Einheit, sondern ein
    -- Fehler (dieselbe Schranke wie `uems_einstellung_wert_gueltig` für die
    -- Skalierung, V20260911280000).
    ADD CONSTRAINT messreihe_viertelstunde_faktor_chk CHECK (faktor <> 0);

-- -----------------------------------------------------------------------------
-- 4. Rechte
-- -----------------------------------------------------------------------------
-- NICHTS zu tun, und das ist Absicht: Rechte hängen in Postgres an der TABELLE,
-- solange sie nicht spaltenweise vergeben sind — und das sind sie hier nicht
-- (V20260912170000: REVOKE ALL + GRANT SELECT für die App-Rolle, volles Schreiben
-- nur für die BYPASSRLS-Rolle). Die neuen Spalten erben das, der Mandantenzaun
-- (RLS + FORCE) gilt ohnehin je ZEILE. Geprüft wird es trotzdem.

-- -----------------------------------------------------------------------------
-- 5. Was die neuen Spalten bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN messreihe_viertelstunde.menge IS
    'AP-08 Z2/Z3: die Menge der Viertelstunde in der Einheit der Reihe, gerechnet von '
    'VerbrauchRegeln (nie im Job). NULL = keine Menge bildbar - NIE 0. Ein Zaehlerruecksprung '
    'erzeugt nie einen erfundenen Verbrauch, ein Box-Ausfall nie einen gemessenen Stillstand.';
COMMENT ON COLUMN messreihe_viertelstunde.menge_zustand IS
    'AP-08 §4.5: Zustand der MENGE - vollstaendig / unvollstaendig / keine Werte. NICHT die '
    'Spalte zustand daneben (die traegt vorlaeufig/endgueltig, AP-07 E5). NULL = AP-08 kennt '
    'fuer diese Wertart keine Regel (state/bitfield/text). Abdeckung ist NICHT Vollstaendigkeit.';
COMMENT ON COLUMN messreihe_viertelstunde.kennzeichen IS
    'AP-08: Klartext-Saetze zu dieser Viertelstunde, in der Reihenfolge der Feststellung. '
    'Wortlaut und Reihenfolge sind Vertrag (verbrauch-vectors.json) - es gibt EINE Formulierung, '
    'nicht zwei. Leeres Array = nichts zu sagen.';
COMMENT ON COLUMN messreihe_viertelstunde.faktor IS
    'AP-08 Z8: der Faktor, mit dem die Rohwerte in die Einheit der Reihe gerechnet wurden - '
    'damit menge erklaerbar ist. Heute IMMER 1: nach quelle-einstellung.md §3 traegt der '
    'gespeicherte Rohwert den Faktor der Fassung bereits (angewendet = beim Erfassen, '
    'dokumentiert = im Geraet). Ein zweites Anwenden wuerde ihn verdoppeln.';

-- Der Tabellen-Kommentar von V20260912170000 sagt „Keine menge-Spalte: die
-- Differenz ueber Intervallgrenzen bildet AP-08." Genau das ist jetzt geschehen —
-- der Satz wird fortgeschrieben, nicht in der alten Datei geaendert (eine
-- angewandte Migration ist unveraenderlich).
COMMENT ON TABLE messreihe_viertelstunde IS
    'Speicherklasse Viertelstundenwerte (UEMS AP-07 IP-12, E6/E7): JEDE Reihe, zehn Jahre '
    '(Retention 3 653 Tage), Chunk 30 Tage, RLS + FORCE, OHNE Kompression - das Layout ist '
    'vorbereitet (messreihe_viertelstunde_kompression_layout). Gebildet aus der MENGE der '
    'Rohwerte eines Intervalls, nie inkrementell fortgeschrieben (§4.5 Reihenfolge Nr. 3). '
    'Seit AP-08 IP-2 traegt sie auch die MENGE (menge, menge_zustand, kennzeichen, faktor) - '
    'gerechnet von VerbrauchRegeln, nie im Job. Eine Viertelstunde ohne einen einzigen '
    'Rohwert bekommt gar keine Zeile: eine Luecke ist keine Null.';
