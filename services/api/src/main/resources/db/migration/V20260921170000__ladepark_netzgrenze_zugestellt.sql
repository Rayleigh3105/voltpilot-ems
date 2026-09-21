-- =============================================================================
-- UEMS AP-15 IP-3, Folgepaket — der ZULETZT ZUGESTELLTE Bezugswert des
-- Ladepark-Dokuments je Anlage (Grenzblatt-Anstoß).
--
--   ladepark_netzgrenze_zugestellt   der `grid_limit_kw`, mit dem das Dokument
--                                     zuletzt erfolgreich zur Box reiste
--
-- WOZU: eine Fassung am Netzanschluss, die erst an einem späteren Tag wirkt,
-- eine neue Bindung und eine aufgehobene Fassung ändern den wirksamen Bezug, ohne
-- dass jemand am Ladepark speichert. Der Anstoß (ChargingConfigService
-- #netzgrenzeNachziehen, stündlicher LadeparkGrenzeLaeufer) vergleicht den HEUTE
-- wirksamen Wert mit dieser Zeile und stellt nur bei einem Unterschied zu. Weil
-- er vergleicht statt sich auf „gestern lief ich“ zu verlassen, holt er nach
-- einem Ausfall nach. Ohne Zeile gilt der Rahmen (`site_charging_config
-- .grid_limit_kw`) als zugestellt — das ist der Stand vor dem Grenzblatt, und
-- eine Anlage ohne Bindung/Fassung bekommt darum nie eine Zustellung.
--
-- `netzgrenze_kw` NULL heißt „das Dokument reiste ohne Grenze“ (Rahmen ohne
-- Wert), nie 0 kW. Dieselbe Spaltenform wie `site_charging_config.grid_limit_kw`
-- (DOUBLE PRECISION): verglichen wird genau das `Double`, das reiste.
--
-- ⚠ REIN ADDITIV: eine LEERE Tabelle kommt dazu; keine Bestandszeile ändert
-- sich, es wird KEINE Zeile angelegt. Sie hängt an der Anlage (ON DELETE
-- CASCADE wie site_charging_config) — Anlage löschen und Offboarding (über die
-- Anlagen) räumen sie mit ab.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ladepark_netzgrenze_zugestellt (
    site_id        UUID              NOT NULL PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
    tenant_id      UUID              NOT NULL,
    netzgrenze_kw  DOUBLE PRECISION,
    zugestellt_am  TIMESTAMPTZ       NOT NULL DEFAULT now(),
    CONSTRAINT ladepark_netzgrenze_zugestellt_kw_chk
        CHECK (netzgrenze_kw IS NULL OR netzgrenze_kw > 0)
);

ALTER TABLE ladepark_netzgrenze_zugestellt ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladepark_netzgrenze_zugestellt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ladepark_netzgrenze_zugestellt_isolation ON ladepark_netzgrenze_zugestellt;
CREATE POLICY ladepark_netzgrenze_zugestellt_isolation ON ladepark_netzgrenze_zugestellt
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Rechte: ALTER DEFAULT PRIVILEGES gibt beiden Rollen alles — hier wird ALLES
-- genommen und eng neu gegeben. Die App schreibt die Zeile fort (Upsert); das
-- Löschen erledigt die Kaskade der Anlage.
REVOKE ALL ON ladepark_netzgrenze_zugestellt FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON ladepark_netzgrenze_zugestellt TO ${appDbUser};
GRANT SELECT, DELETE ON ladepark_netzgrenze_zugestellt TO ${adminDbUser};

COMMENT ON TABLE ladepark_netzgrenze_zugestellt IS
    'UEMS AP-15 IP-3 Folgepaket: zuletzt zugestellter grid_limit_kw des Ladepark-Dokuments je Anlage; der Anstoss stellt nur bei einem anderen wirksamen Bezug zu.';
