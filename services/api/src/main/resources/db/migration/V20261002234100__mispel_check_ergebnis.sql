-- MiSpeL MP-48: das Ergebnis des MiSpeL-Checks je Anlage (Bauplan vp-mispel-fundament § 8, BK-48 Variante A,
-- Entscheid firstmate mp48-datenweg = A, 02.10.2026). Vertrag: docs/contracts/v2/mispel-check.md.
--
-- Der Check vergleicht DIESELBE Anlage heute gegen die Abgrenzungsoption (Festlegung BNetzA Az. 618-25-02,
-- Beschluss 01.10.2026, Anlage 1; § 19 Abs. 3b EEG) über ein Ganzjahr echter Viertelstundenpreise — nie gegen
-- „ohne Speicher“. Gerechnet wird er von MP-13 (services/optimization/.../simulation/mispel_check.py); das
-- Rechnen je Anlage und das Ablegen hier ist das Folgepaket MP-13b. Diese Tabelle ist nur der Ablageort, den
-- die nur lesende Route GET /api/v1/sites/{siteId}/mispel-check liest.
--
-- EINE Zeile je Anlage: der letzte Stand. Ohne Zeile oder mit Stand `wird_gerechnet` zeigt das Portal
-- „wird gerechnet“ — nie einen Betrag von 0 €; darum sind die Beträge NUR im Stand `fertig` gesetzt.
--
-- BESTAND OHNE ZEILE: die Tabelle beginnt LEER, keine Bestandszeile ändert sich.
CREATE TABLE IF NOT EXISTS site_mispel_check (
    site_id               UUID          PRIMARY KEY,
    tenant_id             UUID          NOT NULL,
    stand                 TEXT          NOT NULL,
    stand_seit            TIMESTAMPTZ   NOT NULL DEFAULT now(),
    -- Der Formelsatz der Anlage 1, mit dem gerechnet wurde (angenommen, solange die Anlage keinen gewählt hat).
    formelsatz            TEXT,
    -- Das Fenster echter Viertelstundenpreise, tagesgenau und EINSCHLIESSLICH des letzten Tages.
    fenster_von           DATE,
    fenster_bis           DATE,
    -- „Unterschied im Jahr“ = mit Abgrenzungsoption − heute, €/Jahr netto, je Annahmen-Fall (MP-13 `spanne`).
    differenz_niedrig_eur NUMERIC(12, 2),
    differenz_mittel_eur  NUMERIC(12, 2),
    differenz_hoch_eur    NUMERIC(12, 2),
    -- Die Posten mit Vorzeichen je Fall: [{art, niedrig_eur, mittel_eur, hoch_eur, herkunft}] (Vertrag § 3).
    posten                JSONB         NOT NULL DEFAULT '[]'::jsonb,
    -- Woraus gerechnet wurde, je Angabe gemessen / Stammdaten / angenommen (Vertrag § 4).
    datenbasis            JSONB         NOT NULL DEFAULT '[]'::jsonb,
    -- Ein Satz für den Kunden in den Ständen `fehlgeschlagen` und `nicht_unterstuetzt`.
    hinweis               TEXT,
    CONSTRAINT site_mispel_check_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT site_mispel_check_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT site_mispel_check_stand_chk
        CHECK (stand IN ('wird_gerechnet', 'fertig', 'fehlgeschlagen', 'nicht_unterstuetzt')),
    -- Das Vokabular von site_foerderweg_formelsatz_chk (V20261002224700).
    CONSTRAINT site_mispel_check_formelsatz_chk
        CHECK (formelsatz IS NULL OR formelsatz IN ('A1', 'A2', 'A3', 'A4', 'A5', 'A5-Variante', 'A10', 'A11')),
    CONSTRAINT site_mispel_check_posten_chk CHECK (jsonb_typeof(posten) = 'array'),
    CONSTRAINT site_mispel_check_datenbasis_chk CHECK (jsonb_typeof(datenbasis) = 'array'),
    -- Fertig heißt: Formelsatz, Fenster und alle drei Beträge; sonst KEIN Betrag (nie 0 € statt „wird gerechnet“).
    CONSTRAINT site_mispel_check_fertig_chk CHECK (
        (stand = 'fertig'
            AND formelsatz IS NOT NULL AND fenster_von IS NOT NULL AND fenster_bis IS NOT NULL
            AND fenster_bis >= fenster_von
            AND differenz_niedrig_eur IS NOT NULL AND differenz_mittel_eur IS NOT NULL
            AND differenz_hoch_eur IS NOT NULL AND jsonb_array_length(posten) > 0)
        OR (stand <> 'fertig'
            AND differenz_niedrig_eur IS NULL AND differenz_mittel_eur IS NULL AND differenz_hoch_eur IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_site_mispel_check_tenant ON site_mispel_check (tenant_id, site_id);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE site_mispel_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_mispel_check FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_mispel_check_tenant_isolation ON site_mispel_check;
CREATE POLICY site_mispel_check_tenant_isolation ON site_mispel_check
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Lesen für die Route; Schreiben (Stand setzen, Ergebnis ablegen) für den Schreiber aus MP-13b, damit er ohne
-- weitere Migration auskommt — im Mandanten (App-Rolle) oder mandantenübergreifend (Admin-Rolle).
REVOKE ALL ON site_mispel_check FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON site_mispel_check TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON site_mispel_check TO ${adminDbUser};

COMMENT ON TABLE site_mispel_check IS
    'MiSpeL MP-48: letzter Stand des MiSpeL-Checks je Anlage (heute gegen Abgrenzungsoption); ohne Zeile = wird gerechnet. Vertrag docs/contracts/v2/mispel-check.md.';
