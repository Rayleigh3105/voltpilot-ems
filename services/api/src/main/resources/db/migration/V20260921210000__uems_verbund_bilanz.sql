-- =============================================================================
-- UEMS AP-15 IP-12 — die VERBUND-BILANZ der Gemeinsamen Steuerung (Konzept
-- vp-uems-ap15-verbund §3.3, §4.4 B3/B5, Matrixzeile A17, §8.5; entschieden
-- am 21.09.2026; Vertrag docs/contracts/v2/steuerungsverbund.md §7).
--
--   steuerungsverbund_bilanz   je Verbund und Tag EIN Ergebnis des täglichen
--                              Laufs: plausibel · unplausibel · unbekannt, die
--                              Zählung der Viertelstunden, die geringste Zahl
--                              für das Ungeregelte, worauf gerechnet wurde, und
--                              ob die Anlage deshalb auf S1 zurückging
--
-- Die Regel ist uems/VerbundBilanzRegel (rein, Vektoren
-- docs/contracts/v2/verbund-bilanz-vectors.json); der Lauf ist
-- uems/VerbundBilanzLaeufer. Diese Migration legt KEINE Zeile an: eine Anlage
-- ohne Gemeinsame Steuerung bekommt nie eine (I6, R22), auch nicht durch den
-- Lauf.
--
-- ⚠ Ergebnis, kein Zustand: eine Zeile wird nie geändert (kein UPDATE für die
-- App-Rolle). Der Lauf rechnet einen Tag genau einmal; ein zweiter Lauf
-- desselben Tages scheitert an steuerungsverbund_bilanz_je_tag und schreibt
-- nichts. Das Zurückführen auf S1 steht zusätzlich im Protokoll des Verbunds
-- (steuerungsverbund_aenderung, art 'stufe') — hier nur, DASS es geschah.
-- =============================================================================

CREATE TABLE IF NOT EXISTS steuerungsverbund_bilanz (
    id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID        NOT NULL,
    site_id                    UUID        NOT NULL,
    steuerungsverbund_id       UUID        NOT NULL,
    -- Der Tag der Anlage (Europe/Berlin); gerechnet wird nur ein abgeschlossener.
    tag                        DATE        NOT NULL,
    zustand                    TEXT        NOT NULL,
    -- Nur bei `unbekannt`: warum (Vokabular VerbundBilanzRegel.Grund).
    grund                      TEXT,
    viertelstunden_erwartet    INTEGER     NOT NULL,
    viertelstunden_plausibel   INTEGER     NOT NULL,
    viertelstunden_unplausibel INTEGER     NOT NULL,
    viertelstunden_unbekannt   INTEGER     NOT NULL,
    -- Die geringste belegte Zahl für das Ungeregelte (Netzpunkt − Summe der
    -- Box-Beiträge, kW, Bezug positiv) samt ihrer Toleranz und Viertelstunde —
    -- das, was „unplausibel“ erklärt. NULL, wenn keine Viertelstunde belegt ist.
    geringstes_ungeregeltes_kw NUMERIC,
    geringstes_toleranz_kw     NUMERIC,
    geringstes_von             TIMESTAMPTZ,
    -- Worauf: die Messstellen je Term (Netzpunkt, Box-Beiträge), die Stufe vor
    -- dem Lauf, die Fassung der Regel.
    grundlage                  JSONB       NOT NULL,
    stufe_vorher               TEXT        NOT NULL,
    auf_s1_zurueck             BOOLEAN     NOT NULL DEFAULT false,
    -- Wer und wann: der Lauf ist ein Akteur der Plattform, kein Konto.
    gerechnet_von              TEXT        NOT NULL,
    gerechnet_am               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT steuerungsverbund_bilanz_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_bilanz_verbund_fk FOREIGN KEY (steuerungsverbund_id, site_id, tenant_id)
        REFERENCES steuerungsverbund (id, site_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_bilanz_je_tag UNIQUE (steuerungsverbund_id, tag),
    CONSTRAINT steuerungsverbund_bilanz_zustand_chk
        CHECK (zustand IN ('plausibel', 'unplausibel', 'unbekannt')),
    -- Unbekannt ist keine Null (B5): nur `unbekannt` trägt einen Grund, und
    -- `plausibel` hat keine unbekannte Viertelstunde.
    CONSTRAINT steuerungsverbund_bilanz_grund_chk CHECK ((zustand = 'unbekannt') = (grund IS NOT NULL)),
    CONSTRAINT steuerungsverbund_bilanz_zaehlung_chk
        CHECK (viertelstunden_erwartet > 0
               AND viertelstunden_plausibel >= 0 AND viertelstunden_unplausibel >= 0
               AND viertelstunden_unbekannt >= 0
               AND viertelstunden_plausibel + viertelstunden_unplausibel + viertelstunden_unbekannt
                   = viertelstunden_erwartet
               AND (zustand <> 'plausibel' OR (viertelstunden_unbekannt = 0 AND viertelstunden_unplausibel = 0))),
    CONSTRAINT steuerungsverbund_bilanz_stufe_chk
        CHECK (stufe_vorher IN ('erklaert', 'beobachtet', 'geprueft', 'anteile_aktiv', 'angehalten')),
    CONSTRAINT steuerungsverbund_bilanz_zurueck_chk CHECK (NOT auf_s1_zurueck OR zustand = 'unplausibel'),
    CONSTRAINT steuerungsverbund_bilanz_von_chk CHECK (btrim(gerechnet_von) <> '')
);
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_bilanz_site
    ON steuerungsverbund_bilanz (site_id, tag DESC);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE steuerungsverbund_bilanz ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_bilanz FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_bilanz_tenant_isolation ON steuerungsverbund_bilanz;
CREATE POLICY steuerungsverbund_bilanz_tenant_isolation ON steuerungsverbund_bilanz
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Rechte: lesen und anhängen, nie ändern; das Offboarding
-- (TenantRepository.offboard) räumt vor dem Verbund ab. Die Metrik liest über
-- die Admin-Rolle (BYPASSRLS, UemsMetricsCollector-Muster).
REVOKE ALL ON steuerungsverbund_bilanz FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON steuerungsverbund_bilanz TO ${appDbUser};
GRANT SELECT, DELETE ON steuerungsverbund_bilanz TO ${adminDbUser};
