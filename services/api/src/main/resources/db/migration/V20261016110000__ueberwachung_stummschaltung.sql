-- =============================================================================
-- V20261016110000 - Alerting Scheibe 3: Stummschalten (einmalig, mit Ende)
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.4 "Ruhezeiten und Stummschalten", §7
-- Scheibe 3, §9). Eine Stummschaltung ist EINMALIG und braucht ein Ende
-- ("Wartung bis 17 Uhr") - anders als die wiederkehrende Ruhezeit
-- (V20261016100000). Anders als Ruhezeit (die nur die Zustellung VERZÖGERT,
-- §6.4) unterdrückt eine Stummschaltung die Zustellung ENDGÜLTIG für ihr
-- Fenster: keine nachträgliche Zustellung, wenn sie endet (die Meldung selbst
-- entsteht trotzdem und steht im Verlauf, §6.4 "was unterdrückt wird, steht
-- trotzdem in den Meldungen").
--
--   auswahl      genau EINS von {"regel": "<ueberwachung_id>"},
--                {"anlage": "<site_id>"} oder {"standort": "<standort_id>"}
--                (§6.4: "eine Regel, ein Bezug oder ein ganzer Standort").
--   standort_id  der Standort-Zaun fuer site_scope (wie `alarm`): bei
--                `{"standort": ...}` derselbe Standort, bei `{"anlage":...}`/
--                `{"regel":...}` der Standort der Anlage bzw. Regel zur
--                Anlegezeit - NULL nur fuer eine unternehmensweite Regel.
--   bis          Ende-Pflicht (NOT NULL, CHECK bis > von): "kein Stumm fuer
--                immer" (§6.4).
--   grund/von_wem im Verlauf (§6.4: "mit Grund und Name im Verlauf") - diese
--                Zeile IST der Verlauf, append-only ueber den Zaun unten.
-- =============================================================================

CREATE TABLE IF NOT EXISTS stummschaltung (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    standort_id     UUID,
    auswahl         JSONB       NOT NULL,
    von             TIMESTAMPTZ NOT NULL DEFAULT now(),
    bis             TIMESTAMPTZ NOT NULL,
    grund           TEXT,
    von_wem         TEXT        NOT NULL,
    erstellt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT stummschaltung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT stummschaltung_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id),
    CONSTRAINT stummschaltung_bis_chk CHECK (bis > von),
    CONSTRAINT stummschaltung_von_wem_chk CHECK (von_wem <> ''),
    CONSTRAINT stummschaltung_auswahl_chk CHECK (
        (auswahl ? 'regel')::int + (auswahl ? 'anlage')::int + (auswahl ? 'standort')::int = 1)
);
-- Der Zusteller fragt "ist dieser Alarm/diese Regel/dieser Standort JETZT
-- stumm?" (WHERE von <= jetzt AND bis > jetzt) - der Index trägt den Filter
-- auf `bis`, den jede solche Abfrage braucht.
CREATE INDEX IF NOT EXISTS idx_stummschaltung_bis ON stummschaltung (tenant_id, bis);

ALTER TABLE stummschaltung ENABLE ROW LEVEL SECURITY;
ALTER TABLE stummschaltung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stummschaltung_tenant_isolation ON stummschaltung;
CREATE POLICY stummschaltung_tenant_isolation ON stummschaltung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS site_scope ON stummschaltung;
CREATE POLICY site_scope ON stummschaltung AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE coalesce(standort_id = ANY (uems_zugriff_standort_ids()), false) END);

-- Rechte wie `ueberwachung` (V20261015130000): die Laufzeitrolle verwaltet
-- selbst, kein BYPASSRLS-Schreiben noetig - der Zusteller liest stummschaltung
-- nicht ueber den Admin-Pfad, sondern dieselbe RLS-Verbindung des gerade
-- bedienten Kundenbereichs (TenantContext ist beim Versand schon gesetzt,
-- Zusteller.lauf()).
REVOKE ALL ON stummschaltung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON stummschaltung TO ${appDbUser};
GRANT SELECT ON stummschaltung TO ${adminDbUser};
GRANT DELETE ON stummschaltung TO ${adminDbUser};

COMMENT ON TABLE stummschaltung IS
    'Alerting Scheibe 3 (§6.4): eine EINMALIGE Stummschaltung mit Ende-Pflicht fuer eine Regel, eine Anlage oder einen ganzen Standort.';
