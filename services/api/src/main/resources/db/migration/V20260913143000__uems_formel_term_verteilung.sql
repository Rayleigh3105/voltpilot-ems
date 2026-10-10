-- =============================================================================
-- UEMS AP-10 IP-5 — PR #688 nachziehen (3/4): die Term-Art `verteilung` und das
-- Feld `anteil` am Formel-Term (Entscheide E4, E11; Vertrag
-- docs/contracts/v2/messstelle-formel.md §1.1 und §6.3, die zwei benannten
-- Ablehnungen im Block `leseweg` von docs/contracts/v2/verteilung-vectors.json).
--
-- Rein ADDITIV an messstelle_formel_term (V20260912093000, Fassungen
-- V20260912210000). Keine neue Tabelle, keine bestehende Zeile ändert sich:
--
--   anteil           `positiv` | `negativ` — welcher Teil eines Messwerts eingeht
--                    (eine Speicher-Messstelle „Laden / Entladen“ geht mit ZWEI
--                    Termen ein, nie als Saldo). NULL = die Vorgabe `gesamt`: ein
--                    Term ohne das Feld verhält sich genau wie heute (§1.1), und
--                    `gesamt` hat genau EINE Schreibweise. Darum bekommt keine
--                    Bestandszeile einen Wert (Bestandsschutz-Vergleich).
--   verteilung_ziel  die Kostenstelle, deren Anteil an `quell_messstelle_id` ein
--                    Term der Art `verteilung` liest („4100 von MS-07“).
--
-- ⚠ `verteilung_ziel` HAT NOCH KEINEN FREMDSCHLÜSSEL. Die Tabelle `kostenstelle`
-- gibt es erst mit AP-10 IP-7, die Verteilung `messstelle_verteilung` erst mit
-- IP-8. Das IP-7-Paket zieht den Schlüssel nach — über (verteilung_ziel,
-- tenant_id) → kostenstelle (id, tenant_id), wie jeder UEMS-Verweis mit dem
-- Mandanten. Bis dahin kann KEIN Schreibweg einen solchen Term speichern: die
-- Formel-Schnittstelle lehnt ihn benannt ab (422 `verteilung_wartet_auf_ip8`,
-- ebenso 422 `anteil_wartet_auf_ap08` für `positiv`/`negativ`, bis AP-08 IP-7
-- den Anteil an der Quellenbindung liest). Die Entscheidung dafür steht an EINER
-- Stelle, uems/AnteilLeseweg — nicht in dieser Datei.
--
-- Die CHECKs werden geweitet, indem der AKTUELLE Stand abgeschrieben wird (der von
-- V20260912093000 — V20260912210000 hat sie nicht berührt):
--
--   1. messstelle_formel_term_eingang_chk   + `verteilung`
--   2. messstelle_formel_term_bindung_chk   + der Zweig `verteilung` (Quell-Messstelle
--      UND Ziel, kein Messkanal); die zwei bestehenden Zweige verlangen zusätzlich
--      `verteilung_ziel IS NULL` — jede Bestandszeile erfüllt das (neue Spalte).
--   3. NEU messstelle_formel_term_anteil_chk
--   4. NEU messstelle_formel_term_verteilung_faktor_chk — ein Verteilungs-Term kopiert
--      nie den Anteil als Faktor (Vertrags-Code `verteilungs_term_ohne_faktor`: er
--      liefe der Verteilung davon, sobald sie sich ändert). Die Schnittstelle lehnt
--      zuerst ab; das hier ist die Grenze der Datenbank.
--
-- Unberührt: Zaun (ENABLE + FORCE RLS, Policy), Rechte (SELECT + INSERT seit
-- V20260912210000 — die Terme sind Historie ihrer Fassung; Spalten-Rechte gibt es an
-- dieser Tabelle nicht, die neuen Spalten folgen dem Tabellen-Recht), die Trigger
-- `messstelle_formel_term_pruefen` und `messstelle_formel_term_zu_fassung`, das
-- Offboarding (räumt die ganze Tabelle ab). Kein Sequenz-Grant (keine Sequenz).
-- =============================================================================

ALTER TABLE messstelle_formel_term ADD COLUMN IF NOT EXISTS anteil TEXT;
ALTER TABLE messstelle_formel_term ADD COLUMN IF NOT EXISTS verteilung_ziel UUID;

-- -----------------------------------------------------------------------------
-- 1. Die dritte Eingangs-Art
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_formel_term DROP CONSTRAINT IF EXISTS messstelle_formel_term_eingang_chk;
ALTER TABLE messstelle_formel_term ADD CONSTRAINT messstelle_formel_term_eingang_chk
    CHECK (eingang_art IN ('messkanal', 'messstelle', 'verteilung'));

-- -----------------------------------------------------------------------------
-- 2. Genau die zu `eingang_art` passende Bindung, nie beide, nie keine.
--    ⚠ coalesce(…, false): ein CHECK nimmt NULL an.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_formel_term DROP CONSTRAINT IF EXISTS messstelle_formel_term_bindung_chk;
ALTER TABLE messstelle_formel_term ADD CONSTRAINT messstelle_formel_term_bindung_chk CHECK (coalesce(
    (eingang_art = 'messkanal'
        AND entity_id IS NOT NULL AND btrim(point_key) <> '' AND quell_messstelle_id IS NULL
        AND verteilung_ziel IS NULL)
    OR (eingang_art = 'messstelle'
        AND quell_messstelle_id IS NOT NULL AND entity_id IS NULL AND point_key IS NULL
        AND verteilung_ziel IS NULL)
    OR (eingang_art = 'verteilung'
        AND quell_messstelle_id IS NOT NULL AND verteilung_ziel IS NOT NULL
        AND entity_id IS NULL AND point_key IS NULL),
    false));

-- -----------------------------------------------------------------------------
-- 3. Der Anteil: NULL = `gesamt` (die Vorgabe, genau eine Schreibweise).
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_formel_term DROP CONSTRAINT IF EXISTS messstelle_formel_term_anteil_chk;
ALTER TABLE messstelle_formel_term ADD CONSTRAINT messstelle_formel_term_anteil_chk
    CHECK (anteil IS NULL OR anteil IN ('positiv', 'negativ'));

-- -----------------------------------------------------------------------------
-- 4. Ein Verteilungs-Term trägt den Faktor 1 — der Anteil kommt aus der Verteilung
--    des Tages, nie aus einer Kopie in der Formel.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_formel_term DROP CONSTRAINT IF EXISTS messstelle_formel_term_verteilung_faktor_chk;
ALTER TABLE messstelle_formel_term ADD CONSTRAINT messstelle_formel_term_verteilung_faktor_chk
    CHECK (eingang_art <> 'verteilung' OR faktor = 1);

-- „Welche Formeln lesen den Anteil dieser Kostenstelle?“ (Ende einer Kostenstelle, IP-7/IP-8).
-- tenant_id vorn wie jeder Schlüssel an einem noch nicht verbundenen Verweis.
CREATE INDEX IF NOT EXISTS idx_messstelle_formel_term_verteilung_ziel
    ON messstelle_formel_term (tenant_id, verteilung_ziel)
    WHERE verteilung_ziel IS NOT NULL;

COMMENT ON COLUMN messstelle_formel_term.anteil IS
    'positiv | negativ — welcher Teil eines Messwerts eingeht (AP-10 E4); NULL = gesamt, die Vorgabe. '
    'Lesbar erst mit AP-08 IP-7 (bis dahin lehnt die Schnittstelle ab: anteil_wartet_auf_ap08).';
COMMENT ON COLUMN messstelle_formel_term.verteilung_ziel IS
    'Bei eingang_art = verteilung: die Kostenstelle, deren Anteil des TAGES an quell_messstelle_id der Term '
    'liest (AP-10 E11). Noch OHNE Fremdschlüssel — kostenstelle entsteht mit AP-10 IP-7, das den Schlüssel '
    'nachzieht; bis zur Verteilung (IP-8) lehnt die Schnittstelle ab: verteilung_wartet_auf_ip8.';
