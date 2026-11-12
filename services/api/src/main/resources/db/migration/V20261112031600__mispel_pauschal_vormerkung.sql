-- MiSpeL MP-27 (Portal Haushalt, Bedienkonzept BK-27 = A): die Pauschaloption vormerken, solange ihr Tag noch nicht
-- feststeht — „vorgemerkt, Termin offen“ (Vertrag docs/contracts/v2/mispel-foerderweg.md 1.3, § 5a).
--
-- Die Pauschaloption gilt erst ab dem Monatsersten nach der Genehmigung der EU-Kommission (Tenor S. 3 Ziff. 9 b);
-- bis VoltPilot den Tag in voltpilot.mispel.pauschaloption-ab einträgt (E7 = B), lehnt der Förderweg sie ab
-- (422 pauschaloption_noch_nicht_anwendbar). Eine Vormerkung hier ist darum KEINE Fassung von site_foerderweg:
-- Optimierer, Box, Monats- und Jahreslauf lesen sie nicht; sie hält nur den Wunsch des Kunden und die beiden
-- Voraussetzungen der Anlage 2, die VoltPilot nicht messen kann, mit Datum fest:
--   Voraussetzung 2 — alle Solaranlagen, Speicher und Ladepunkte hinter der Einspeisestelle betreibt derselbe
--                     Anlagenbetreiber (A2 S. 18; § 19 Abs. 3c S. 2 Nr. 2 EEG);
--   Voraussetzung 4 — auch Steckersolargeräte in der Direktvermarktung, keine unentgeltliche Abnahme
--                     (A2 S. 19 mit Fn. 15).
-- Die installierte Leistung der Steckersolargeräte (steckersolar_kwp) zählt nicht für die 30-kWp-Grenze
-- (Voraussetzung 3, A2 S. 19 mit Fn. 14; § 24 Abs. 1 S. 5 EEG), wohl aber für (P1) = Pinst × 500 (A2 S. 27).
--
-- Beginnt leer; ändert keine Bestandszeile. Ändern = neue Zeile, die alte bekommt aufgehoben_am (wie site_foerderweg).
CREATE TABLE IF NOT EXISTS site_pauschal_vormerkung (
    id                            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                     UUID          NOT NULL,
    site_id                       UUID          NOT NULL,
    -- Angabe des Kunden: 0 = keine Steckersolargeräte hinter dem Zähler (eine Antwort, keine Lücke).
    steckersolar_kwp              NUMERIC(10, 3) NOT NULL CHECK (steckersolar_kwp >= 0),
    ein_betreiber_bestaetigt_am   TIMESTAMPTZ   NOT NULL,
    steckersolar_dv_bestaetigt_am TIMESTAMPTZ,
    direktvermarkter              TEXT,
    bilanzkreis_gesondert         BOOLEAN,
    aufgehoben_am                 TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by                    TEXT,
    CONSTRAINT site_pauschal_vormerkung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT site_pauschal_vormerkung_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    -- Voraussetzung 4: mit Steckersolargerät nur mit der Bestätigung „auch in der Direktvermarktung“.
    CONSTRAINT site_pauschal_vormerkung_steckersolar_chk
        CHECK (steckersolar_kwp = 0 OR steckersolar_dv_bestaetigt_am IS NOT NULL),
    CONSTRAINT site_pauschal_vormerkung_dv_chk
        CHECK (direktvermarkter IS NULL OR char_length(direktvermarkter) BETWEEN 1 AND 200)
);

-- Höchstens eine stehende Vormerkung je Anlage.
CREATE UNIQUE INDEX IF NOT EXISTS site_pauschal_vormerkung_eine
    ON site_pauschal_vormerkung (site_id) WHERE aufgehoben_am IS NULL;
CREATE INDEX IF NOT EXISTS idx_site_pauschal_vormerkung_tenant
    ON site_pauschal_vormerkung (tenant_id, site_id);

ALTER TABLE site_pauschal_vormerkung ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_pauschal_vormerkung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_pauschal_vormerkung_tenant_isolation ON site_pauschal_vormerkung;
CREATE POLICY site_pauschal_vormerkung_tenant_isolation ON site_pauschal_vormerkung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON site_pauschal_vormerkung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON site_pauschal_vormerkung TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON site_pauschal_vormerkung TO ${appDbUser};
GRANT SELECT, DELETE ON site_pauschal_vormerkung TO ${adminDbUser};

COMMENT ON TABLE site_pauschal_vormerkung IS
    'MiSpeL MP-27: Pauschaloption vorgemerkt, Termin offen (vor der EU-Genehmigung); Bestätigungen der Voraussetzungen 2 und 4 der Anlage 2 mit Datum. Keine Fassung des Förderwegs.';
