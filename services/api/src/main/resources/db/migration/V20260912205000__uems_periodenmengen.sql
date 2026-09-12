-- =============================================================================
-- UEMS AP-08 IP-5 — TAGES-, MONATS- UND JAHRESMENGEN aus den PERIODENSTÄNDEN,
-- in der Zeitzone des Standorts, mit 23- und 25-Stunden-Tagen.
--
-- Konzept vp-uems-ap08-verbrauch §4.3 (P1–P3, P7), §4.5 (Fortpflanzung), §8 IP-5;
-- Captain-Entscheide 11.09.2026 (E1 = A: Menge aus den Periodenständen, Verlauf-
-- Abdeckung getrennt; E10 = A: Ortszeit).
--
-- ⚠ DER EINE SATZ DIESES PAKETS: eine Tagesmenge ist NICHT die Summe der
-- Viertelstunden. Sie ist Stand am Tagesende − Stand am Tagesanfang über die
-- gemessenen Strecken (Z1–Z7). Die Summe verliert jede Lücke, in der keine
-- Viertelstundenmenge bildbar war (F8: ein Tag mit 3,5 Stunden Box-Ausfall ist
-- trotzdem VOLLSTÄNDIG 2 304 kWh, weil der Zähler weitergezählt hat) — und sie
-- ist schon ohne jede Lücke falsch, weil jede Teilmenge gerundet ist (F16: 31
-- Tage summieren sich zu 55 100,013 kWh, der Oktober hat 55 100,000).
--
-- Gerechnet wird hier NICHTS. Die Regel ist `VerbrauchRegeln.
-- zaehlerstandAusTeilperioden` (Vertrag `verbrauch-vectors.json`,
-- `regeln.teilperioden`, Python-Zwilling `verbrauch.zaehlerstand_aus_teilperioden`);
-- die Läufe `uems/TagVerdichter` und `uems/PeriodeVerdichter` rufen sie an.
--
-- ADDITIV. Keine bestehende Zeile ändert sich durch diese Migration. Was
-- hinzukommt:
--   1. an der Tagesklasse `messreihe_tag` die MENGE (menge, menge_zustand,
--      kennzeichen, kadenz_s) — und die berichtigte Bedeutung zweier Spalten,
--   2. die Klasse `messreihe_periode` für MONAT und JAHR (Hypertable,
--      3 653 Tage) mit ihrer durable Arbeitsliste.
--
-- ⚠ WAS HIER NICHT ENTSTEHT: keine Korrektur, keine Kaskade, keine Version > 1
-- (AP-08 IP-12 ff.), keine Ersatzwerte (IP-9/E7), kein Lücken-Melder, keine
-- Löschwege, keine Route, keine Portal-Fläche.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Die Tagesklasse bekommt ihre MENGE
-- -----------------------------------------------------------------------------
-- IP-13 (V20260912190000) hat die Tagesklasse bewusst OHNE Menge gebaut und
-- die Periodenstände hineingeschrieben — für genau dieses Paket. Die Spalten
-- sind dieselben wie an der Viertelstunde (V20260912180000), damit ein Leser
-- beide gleich liest.
ALTER TABLE messreihe_tag
    -- Z1–Z7 über den Tag: Stand am Tagesende − Stand am Tagesanfang, über die
    -- gemessenen Strecken. NULL = keine Menge bildbar — NIE 0.
    ADD COLUMN IF NOT EXISTS menge         NUMERIC,
    -- §4.5: vollständig · unvollständig · keine Werte. NICHT `zustand` daneben
    -- (vorläufig/endgültig). NULL = AP-08 hat für diese Wertart keine
    -- Periodenregel über Zählerständen (Momentanwert: IP-3).
    ADD COLUMN IF NOT EXISTS menge_zustand TEXT,
    -- Was an diesem Tag zu sagen ist, in der Reihenfolge der Feststellung —
    -- Wortlaut und Reihenfolge sind Vertrag.
    ADD COLUMN IF NOT EXISTS kennzeichen   JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Die Kadenz, mit der die Menge gebildet wurde (Fenster der Periodenstände,
    -- Lückenschwelle, Erwartung einer Viertelstunde ohne Zeile) — die der
    -- jüngsten Viertelstunde des Tages. Damit ist die Zahl erklärbar, und ein
    -- Monat kann sie weiterreichen.
    ADD COLUMN IF NOT EXISTS kadenz_s      INTEGER;

ALTER TABLE messreihe_tag
    ADD CONSTRAINT messreihe_tag_menge_zustand_chk
        CHECK (menge_zustand IS NULL OR menge_zustand IN
               ('vollständig', 'unvollständig', 'keine Werte', 'mit Ersatzwert')),
    ADD CONSTRAINT messreihe_tag_keine_werte_chk
        CHECK (menge_zustand IS DISTINCT FROM 'keine Werte' OR menge IS NULL),
    ADD CONSTRAINT messreihe_tag_kennzeichen_chk
        CHECK (messreihe_viertelstunde_kennzeichen_erlaubt(kennzeichen)),
    ADD CONSTRAINT messreihe_tag_kadenz_chk
        CHECK (kadenz_s IS NULL OR kadenz_s BETWEEN 1 AND 86400);

-- -----------------------------------------------------------------------------
-- 2. Monat und Jahr: `messreihe_periode`
-- -----------------------------------------------------------------------------
-- EINE Klasse für beide Stufen — dieselben Fakten wie ein Tag, eine Stufe
-- gröber. `tag` ist der ERSTE Kalendertag der Periode in der gespeicherten
-- Zeitzone (01.10.2026 für den Oktober, 01.01.2026 für das Jahr) und die
-- Partitionierungs-Spalte.
--
-- ⚠ Fortpflanzung der Zeit (§4.5): ein Monat ist VORLÄUFIG, solange einer
-- seiner Tage vorläufig ist oder seine eigene Frist (Monatsende + 7 Tage) läuft
-- — ein Jahr ebenso über seine Monate. Eine Monatszahl, die ihre vorläufigen
-- Tage nicht zugibt, wäre eine Behauptung.
CREATE TABLE IF NOT EXISTS messreihe_periode (
    tag                 DATE        NOT NULL,
    art                 TEXT        NOT NULL,
    tenant_id           UUID        NOT NULL,
    entity_id           UUID        NOT NULL,
    messkanal           TEXT        NOT NULL,
    site_id             UUID,

    -- Die Grenze, nachlesbar (W10/A8) — wie am Tag.
    zeitzone            TEXT        NOT NULL,
    zeitzone_herkunft   TEXT        NOT NULL,
    beginn              TIMESTAMPTZ NOT NULL,
    ende                TIMESTAMPTZ NOT NULL,
    -- 743 · 744 · 745 im Oktober/März, 8 759 · 8 760 · 8 784 … im Jahr: die
    -- Umstellungstage stecken darin, gezählt aus beginn/ende, nie als 24 × Tage.
    stunden             INTEGER     NOT NULL,

    -- Die Teile: Tage eines Monats (28–31) bzw. Monate eines Jahres (12). Ein
    -- Teil ohne Zeile hatte keinen einzigen Wert und wird nie zur Null.
    teile_erwartet      SMALLINT    NOT NULL,
    teile_vorhanden     SMALLINT    NOT NULL,
    teile_endgueltig    SMALLINT    NOT NULL,

    wertart             TEXT,
    -- Die Periodenstände an den Grenzen dieser Periode (Z1) mit ihren Messzeiten
    -- — NULL, wenn an der Grenze nicht gemessen wurde; nie fortgeschrieben.
    stand_anfang        NUMERIC,
    stand_anfang_zeit   TIMESTAMPTZ,
    stand_ende          NUMERIC,
    stand_ende_zeit     TIMESTAMPTZ,
    erster_wert         NUMERIC,
    erster_zeit         TIMESTAMPTZ,
    letzter_wert        NUMERIC,
    letzter_zeit        TIMESTAMPTZ,

    menge               NUMERIC,
    menge_zustand       TEXT,
    kennzeichen         JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Verlauf-Abdeckung = Summe erhalten ÷ Summe erwartet (§4.5), abgeschnitten.
    erhalten            INTEGER     NOT NULL,
    erwartet            INTEGER     NOT NULL,
    abdeckung_prozent   SMALLINT,
    kadenz_s            INTEGER,
    n_nachgeliefert     INTEGER     NOT NULL DEFAULT 0,

    zustand             TEXT        NOT NULL DEFAULT 'vorlaeufig',
    endgueltig_ab       TIMESTAMPTZ NOT NULL,
    berechnet_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT messreihe_periode_art_chk CHECK (art IN ('monat', 'jahr')),
    CONSTRAINT messreihe_periode_tag_chk
        CHECK (extract(day FROM tag) = 1 AND (art = 'monat' OR extract(month FROM tag) = 1)),
    CONSTRAINT messreihe_periode_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')
               AND zeitzone_herkunft IN ('standort', 'unternehmen', 'vorgabe')),
    CONSTRAINT messreihe_periode_grenze_chk
        CHECK (ende > beginn
               AND (ende AT TIME ZONE 'UTC')
                   = (beginn AT TIME ZONE 'UTC') + (stunden * INTERVAL '1 hour')),
    CONSTRAINT messreihe_periode_teile_chk
        CHECK (teile_erwartet BETWEEN 1 AND 31
               AND teile_vorhanden BETWEEN 0 AND teile_erwartet
               AND teile_endgueltig BETWEEN 0 AND teile_vorhanden),
    CONSTRAINT messreihe_periode_wertart_chk
        CHECK (wertart IS NULL OR wertart IN ('counter', 'gauge', 'state', 'bitfield', 'text')),
    CONSTRAINT messreihe_periode_menge_zustand_chk
        CHECK (menge_zustand IS NULL OR menge_zustand IN
               ('vollständig', 'unvollständig', 'keine Werte', 'mit Ersatzwert')),
    CONSTRAINT messreihe_periode_keine_werte_chk
        CHECK (menge_zustand IS DISTINCT FROM 'keine Werte' OR menge IS NULL),
    CONSTRAINT messreihe_periode_kennzeichen_chk
        CHECK (messreihe_viertelstunde_kennzeichen_erlaubt(kennzeichen)),
    CONSTRAINT messreihe_periode_zaehler_chk
        CHECK (erhalten >= 0 AND erwartet >= 0 AND n_nachgeliefert >= 0
               AND (kadenz_s IS NULL OR kadenz_s BETWEEN 1 AND 86400)),
    CONSTRAINT messreihe_periode_abdeckung_chk
        CHECK (abdeckung_prozent IS NULL
               OR (abdeckung_prozent BETWEEN 0 AND 100
                   AND (abdeckung_prozent < 100 OR erhalten >= erwartet))),
    CONSTRAINT messreihe_periode_zustand_chk
        CHECK (zustand IN ('vorlaeufig', 'endgueltig')
               AND (zustand = 'vorlaeufig' OR teile_endgueltig = teile_vorhanden)),
    CONSTRAINT messreihe_periode_frist_chk
        CHECK ((endgueltig_ab AT TIME ZONE 'UTC')
               = (ende AT TIME ZONE 'UTC') + INTERVAL '7 days'),
    CONSTRAINT messreihe_periode_version_chk CHECK (version >= 1)
);

-- Chunk 10 Jahre: je Reihe höchstens 13 Zeilen im Jahr. Ohne Vorgabe-Indizes.
SELECT create_hypertable('messreihe_periode', 'tag', if_not_exists => TRUE,
                         chunk_time_interval => INTERVAL '3650 days',
                         create_default_indexes => FALSE);

CREATE UNIQUE INDEX IF NOT EXISTS uq_messreihe_periode_reihe
    ON messreihe_periode (tenant_id, entity_id, messkanal, art, tag);

CREATE INDEX IF NOT EXISTS idx_messreihe_periode_vorlaeufig
    ON messreihe_periode (tag)
    WHERE zustand = 'vorlaeufig';

-- Zehn Jahre, wie Viertelstunde und Tag.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                    WHERE proc_name = 'policy_retention'
                      AND hypertable_name = 'messreihe_periode') THEN
        PERFORM add_retention_policy('messreihe_periode', INTERVAL '3653 days');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Die ARBEITSLISTE der Perioden — durable, wie die der Tage
-- -----------------------------------------------------------------------------
-- Der Schlüssel IST der Eintrag, Entnahme unter `FOR UPDATE SKIP LOCKED`,
-- entnehmen und schreiben in EINER Transaktion. Anders als die Tagesliste merkt
-- sie sich den ORTSKALENDER-Tag: wer einträgt, ist der Tageslauf bzw. der
-- Monatslauf, und der kennt die Zeitzone schon.
CREATE TABLE IF NOT EXISTS messreihe_periode_arbeit (
    tenant_id      UUID        NOT NULL,
    entity_id      UUID        NOT NULL,
    messkanal      TEXT        NOT NULL,
    art            TEXT        NOT NULL,
    tag            DATE        NOT NULL,
    -- `tag` = ein Tag dieses Monats wurde neu geschrieben; `monat` = ein Monat
    -- dieses Jahres; `frist` = die Periode ist vorläufig, ihre Frist abgelaufen.
    grund          TEXT        NOT NULL,
    eingetragen_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_periode_arbeit_pk
        PRIMARY KEY (tenant_id, entity_id, messkanal, art, tag),
    CONSTRAINT messreihe_periode_arbeit_art_chk CHECK (art IN ('monat', 'jahr')),
    CONSTRAINT messreihe_periode_arbeit_grund_chk CHECK (grund IN ('tag', 'monat', 'frist'))
);

-- Erst die Monate, dann die Jahre — ein Jahr soll auf seinen frischen Monaten stehen.
CREATE INDEX IF NOT EXISTS idx_messreihe_periode_arbeit_reihenfolge
    ON messreihe_periode_arbeit (art DESC, tag, eingetragen_am);

-- -----------------------------------------------------------------------------
-- 4. Der Mandantenzaun
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_periode ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_periode FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_periode_tenant_isolation ON messreihe_periode;
CREATE POLICY messreihe_periode_tenant_isolation ON messreihe_periode
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messreihe_periode_arbeit ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_periode_arbeit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_periode_arbeit_tenant_isolation ON messreihe_periode_arbeit;
CREATE POLICY messreihe_periode_arbeit_tenant_isolation ON messreihe_periode_arbeit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- 5. Rechte — die App LIEST, der Hintergrund-Lauf (BYPASSRLS) schreibt
-- -----------------------------------------------------------------------------
REVOKE ALL ON messreihe_periode FROM ${appDbUser};
GRANT SELECT ON messreihe_periode TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_periode TO ${adminDbUser};

REVOKE ALL ON messreihe_periode_arbeit FROM ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_periode_arbeit TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- 6. Was die Spalten bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON TABLE messreihe_tag IS
    'Speicherklasse Tageswerte (UEMS AP-07 IP-13, E6/E7/W10): ein Kalendertag in der ZEITZONE DES '
    'STANDORTS, die Zeitzone steht in der Zeile (A8). Hypertable, Chunk 1 Jahr, Aufbewahrung '
    '3 653 Tage, RLS + FORCE, OHNE Kompression (Layout messreihe_tag_kompression_layout). Gebildet '
    'aus den Viertelstundenwerten des Tages. Seit AP-08 IP-5 mit MENGE (menge, menge_zustand, '
    'kennzeichen, kadenz_s): aus den PERIODENSTAENDEN gebildet von '
    'VerbrauchRegeln.zaehlerstandAusTeilperioden - NIE als Summe der Viertelstunden.';
COMMENT ON COLUMN messreihe_tag.menge IS
    'AP-08 IP-5: die Tagesmenge aus den Periodenstaenden (Stand Tagesende - Stand Tagesanfang ueber '
    'die gemessenen Strecken), NICHT die Summe der Viertelstunden. NULL = keine Menge bildbar, NIE 0. '
    'Fehlt ein Stand an einer Grenze, ist sie der gemessene Teil und menge_zustand = unvollstaendig.';
COMMENT ON COLUMN messreihe_tag.menge_zustand IS
    'AP-08 §4.5: vollstaendig / unvollstaendig / keine Werte der MENGE - nicht die Spalte zustand '
    '(vorlaeufig/endgueltig). NULL = keine Periodenregel fuer diese Wertart.';
COMMENT ON COLUMN messreihe_tag.stand_anfang IS
    'Z1: der Periodenstand an der TAGESGRENZE (letzter guter Wert in (Tagesbeginn - Kadenz, '
    'Tagesbeginn]) - NULL, wenn dort nicht gemessen wurde. Seit AP-08 IP-5 genau so; vorher stand hier '
    'der erste Stand irgendeiner Viertelstunde des Tages. Der erste gemessene Wert steht in erster_wert.';
COMMENT ON COLUMN messreihe_tag.stand_ende IS
    'Z1: der Periodenstand am TAGESENDE - NULL, wenn dort nicht gemessen wurde. Der letzte gemessene '
    'Wert steht in letzter_wert.';
COMMENT ON COLUMN messreihe_tag.abdeckung_prozent IS
    'Verlauf-Abdeckung (§4.5): Summe erhalten / Summe erwartet, abgeschnitten, nie auf 100 % '
    'gerundet. Seit AP-08 IP-5 zaehlt eine Viertelstunde OHNE Zeile mit ihrer Erwartung (F8: 85 %, '
    'nicht 98 %). Abdeckung ist nicht Vollstaendigkeit - die sagt menge_zustand.';
COMMENT ON TABLE messreihe_periode IS
    'Speicherklasse Monats- und Jahreswerte (UEMS AP-08 IP-5): Kalenderperioden in der ZEITZONE DES '
    'STANDORTS, Zone in der Zeile. Menge aus den PERIODENSTAENDEN der Periode '
    '(VerbrauchRegeln.zaehlerstandAusTeilperioden ueber die Tage bzw. Monate), nie als Summe. '
    'Vorlaeufig, solange ein Teil vorlaeufig ist oder die Frist (Ende + 7 Tage) laeuft. Hypertable, '
    'Aufbewahrung 3 653 Tage, RLS + FORCE.';
COMMENT ON COLUMN messreihe_periode.tag IS
    'Der ERSTE Kalendertag der Periode in der gespeicherten Zeitzone (01.10.2026 = Oktober 2026, '
    '01.01.2026 = Jahr 2026).';
COMMENT ON TABLE messreihe_periode_arbeit IS
    'Durable Arbeitsliste der Monats- und Jahreswerte (AP-08 IP-5): gefuellt vom Tageslauf (ein Tag '
    'wurde geschrieben), vom Monatslauf (ein Monat wurde geschrieben) und vom Frist-Durchgang; '
    'geleert in derselben Transaktion, in der die Periode geschrieben wird.';
