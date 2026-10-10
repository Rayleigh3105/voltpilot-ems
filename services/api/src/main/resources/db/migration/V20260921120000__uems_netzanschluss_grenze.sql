-- =============================================================================
-- UEMS AP-15 IP-3 — das GRENZBLATT am Netzanschluss (Konzept vp-uems-ap15-verbund
-- §6.1, §8 IP-3, Kasten W1 — Auflösung übernommen am 21.09.2026; Vertrag
-- docs/contracts/v2/netzanschluss.md §5).
--
--   netzanschluss_grenze   Einspeisegrenze und Bezugsgrenze je Netzanschluss,
--                          zeitgültig: eine Fassung gilt ab ihrem Tag bis zum
--                          Vortag der nächsten
--
-- ⚠ ZWEI GRENZEN, KEINE PREISE (W1): Tarif, Vergütung und Leistungspreis bleiben
-- an der Anlage. `site.max_feed_in_kw` und `site_charging_config.grid_limit_kw`
-- bleiben, wo sie sind; es gilt der ENGERE Wert aus Anlage und Netzanschluss —
-- ohne gebundenen Netzanschluss oder ohne Fassung der alte Wert der Anlage. Die
-- Regel lebt in EINER Auflösungs-Klasse (uems/GrenzeAufloesung ⟷ Python-Zwilling
-- voltpilot_optimization/grenze_aufloesung.py, Vektoren
-- netzanschluss-grenze-vectors.json), nicht in SQL.
--
-- DIE TAGE (dieselbe Zeitform wie anlage_netzanschluss): `gueltig_ab` ist ein Tag
-- in der Zeitzone des Standorts; eine Fassung endet am Vortag der nächsten, es gibt
-- KEIN `gueltig_bis`. Eine Fassung mit beiden Werten NULL heißt „ab diesem Tag
-- keine Grenze am Netzanschluss“ — dann gilt wieder der Wert der Anlage.
-- Eine zweite Fassung am SELBEN Tag ersetzt die erste: die alte wird aufgehoben
-- (`aufgehoben_am`), nie überschrieben; das Protokoll nennt alt und neu.
--
-- DAS PROTOKOLL ist das des Netzanschlusses (netzanschluss_aenderung, Art
-- `grenze`): ein Objekt, ein Protokoll. Der CHECK der Art wird dafür ERWEITERT
-- (Vereinigung mit dem Stand von V20260913235000, keine andere Migration setzt ihn).
--
-- ⚠ REIN ADDITIV: eine leere Tabelle kommt dazu, ein CHECK wird weiter; keine
-- Bestandszeile ändert sich, es wird KEINE Zeile angelegt. Eine Anlage ohne
-- Fassung verhält sich Byte für Byte wie vorher.
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (ein Fremdschlüssel prüft ohne RLS).
-- =============================================================================

CREATE TABLE IF NOT EXISTS netzanschluss_grenze (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID          NOT NULL,
    netzanschluss_id    UUID          NOT NULL,
    gueltig_ab          DATE          NOT NULL,
    einspeisegrenze_kw  NUMERIC(12, 3),
    bezugsgrenze_kw     NUMERIC(12, 3),
    aufgehoben_am       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by          TEXT,
    CONSTRAINT netzanschluss_grenze_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT netzanschluss_grenze_netzanschluss_fk FOREIGN KEY (netzanschluss_id, tenant_id)
        REFERENCES netzanschluss (id, tenant_id) ON DELETE RESTRICT,
    -- Unbekannt ist keine Null: eine fehlende Grenze ist NULL, nie 0 kW.
    CONSTRAINT netzanschluss_grenze_einspeisung_chk
        CHECK (einspeisegrenze_kw IS NULL OR einspeisegrenze_kw > 0),
    CONSTRAINT netzanschluss_grenze_bezug_chk
        CHECK (bezugsgrenze_kw IS NULL OR bezugsgrenze_kw > 0)
);
-- Je Anschluss und Tag höchstens EINE wirksame Fassung.
CREATE UNIQUE INDEX IF NOT EXISTS netzanschluss_grenze_eine_je_tag
    ON netzanschluss_grenze (tenant_id, netzanschluss_id, gueltig_ab)
    WHERE aufgehoben_am IS NULL;

-- Das Protokoll des Netzanschlusses nennt die neue Art `grenze` (alt/neu = die
-- Fassung des Tages). Vereinigung mit dem Stand von V20260913235000.
ALTER TABLE netzanschluss_aenderung DROP CONSTRAINT IF EXISTS netzanschluss_aenderung_art_chk;
ALTER TABLE netzanschluss_aenderung ADD CONSTRAINT netzanschluss_aenderung_art_chk
    CHECK (art IN ('angelegt', 'bearbeitet', 'gebunden', 'anlage_entfernt', 'grenze'));

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE netzanschluss_grenze ENABLE ROW LEVEL SECURITY;
ALTER TABLE netzanschluss_grenze FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS netzanschluss_grenze_tenant_isolation ON netzanschluss_grenze;
CREATE POLICY netzanschluss_grenze_tenant_isolation ON netzanschluss_grenze
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. ALTER DEFAULT PRIVILEGES gibt beiden Rollen alles — hier wird ALLES
-- genommen und eng neu gegeben. Eine Fassung wird aufgehoben, nie geändert oder
-- gelöscht; das Offboarding (TenantRepository.offboard) räumt sie ab.
-- -----------------------------------------------------------------------------
REVOKE ALL ON netzanschluss_grenze FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON netzanschluss_grenze TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON netzanschluss_grenze TO ${appDbUser};
GRANT SELECT, DELETE ON netzanschluss_grenze TO ${adminDbUser};

COMMENT ON TABLE netzanschluss_grenze IS
    'UEMS AP-15 IP-3: Grenzblatt am Netzanschluss (Einspeise-/Bezugsgrenze, zeitgueltig ab Tag); es gilt der engere Wert aus Anlage und Netzanschluss (W1), keine Preise.';
