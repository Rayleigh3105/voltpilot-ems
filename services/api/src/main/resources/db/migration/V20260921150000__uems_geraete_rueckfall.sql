-- =============================================================================
-- UEMS AP-15 IP-6 — der GERÄTE-RÜCKFALL je Komponente: der „am Gerät hinterlegte
-- Wert“ mit wer/wann (Konzept vp-uems-ap15-verbund §3.6, Regel G3, Kasten E2 = A,
-- entschieden am 21.09.2026; Vertrag docs/contracts/v2/steuerungsverbund.md §1a).
--
--   komponente_geraete_rueckfall   was ein Gerät tut, wenn seine Box schweigt —
--                                  je Komponente und Richtung, so wie es am Gerät
--                                  eingestellt ist (z. B. der im Wechselrichter
--                                  hinterlegte Rückfallwert 40 kW nach 60 s)
--
-- DIE LESART (EINE Stelle: uems/GeraeteRueckfallRegel): Rückfall einer Komponente
-- in kW je Richtung = der hier hinterlegte Wert, sonst der Eintrag des Katalogs
-- für die Familie (families[].rueckfall_ohne_box), sonst `unbekannt` — und
-- `unbekannt`, `laeuft_frei` und `haelt_letzten_wert` zählen mit der
-- Nennleistung; nur `faellt_auf_wert` mit einer Zahl zählt weniger (G3).
--
-- DAS VOKABULAR ist das geschlossene aus IP-2 (SteuerungsverbundVokabular.
-- GeraeteRueckfall, verbund-anteil-vectors.json `geraete_rueckfall`), die Richtung
-- dieselbe wie Grenzart ohne die Vorgabe des Netzbetreibers.
--
-- ⚠ KEINE BESTÄTIGUNG AM PRÜFSTAND: eine Zeile sagt, was am Gerät eingestellt
-- ist, nicht, dass es geprüft wurde (NW-7 trägt nur der Betreiber ein, nicht hier).
--
-- EINE Angabe je Komponente und Richtung ist wirksam; eine neue hebt die alte auf
-- (`aufgehoben_am`), nie überschrieben, nie gelöscht — die aufgehobenen Zeilen
-- sind das Protokoll (wer = `created_by`, wann = `created_at`).
--
-- LÖSCHEN (die App-Rolle hat kein DELETE):
--   * → tenant: ON DELETE RESTRICT; das Offboarding räumt die Tabelle
--     AUSDRÜCKLICH ab (TenantRepository.offboard), vor den Komponenten.
--   * → measurement_point: ON DELETE CASCADE wie quelle_einstellung — das
--     heutige Löschen einer Anlage oder Komponente bleibt, wie es ist.
--
-- ⚠ REIN ADDITIV: eine leere Tabelle kommt dazu; keine Bestandszeile ändert
-- sich, es wird KEINE Zeile angelegt. Eine Komponente ohne Angabe verhält sich
-- Byte für Byte wie vorher — es liest sie heute niemand außer der Lese-Regel.
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (ein Fremdschlüssel prüft ohne RLS).
-- =============================================================================

CREATE TABLE IF NOT EXISTS komponente_geraete_rueckfall (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID          NOT NULL,
    entity_id       UUID          NOT NULL,
    richtung        TEXT          NOT NULL,
    rueckfall       TEXT          NOT NULL,
    rueckfall_kw    NUMERIC(12, 3),
    nach_s          INTEGER,
    hinweis         TEXT,
    aufgehoben_am   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by      TEXT          NOT NULL,
    CONSTRAINT komponente_geraete_rueckfall_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Über uq_measurement_point_id_tenant (V20260855000000).
    CONSTRAINT komponente_geraete_rueckfall_entity_fk FOREIGN KEY (entity_id, tenant_id)
        REFERENCES measurement_point (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT komponente_geraete_rueckfall_richtung_chk
        CHECK (richtung IN ('einspeisung', 'bezug')),
    CONSTRAINT komponente_geraete_rueckfall_rueckfall_chk
        CHECK (rueckfall IN ('haelt_letzten_wert', 'faellt_auf_wert', 'laeuft_frei', 'unbekannt')),
    -- Eine Zahl gibt es genau bei `faellt_auf_wert`; unbekannt ist keine Null.
    CONSTRAINT komponente_geraete_rueckfall_kw_chk
        CHECK ((rueckfall = 'faellt_auf_wert') = (rueckfall_kw IS NOT NULL)
            AND (rueckfall_kw IS NULL OR rueckfall_kw >= 0)),
    -- Die Frist gibt es nur, wo das Gerät etwas NACH einer Zeit tut.
    CONSTRAINT komponente_geraete_rueckfall_nach_chk
        CHECK (nach_s IS NULL OR (nach_s >= 0 AND rueckfall IN ('haelt_letzten_wert', 'faellt_auf_wert'))),
    CONSTRAINT komponente_geraete_rueckfall_wer_chk
        CHECK (btrim(created_by) <> ''),
    CONSTRAINT komponente_geraete_rueckfall_hinweis_chk
        CHECK (hinweis IS NULL OR char_length(hinweis) <= 500)
);
-- Je Komponente und Richtung höchstens EINE wirksame Angabe.
CREATE UNIQUE INDEX IF NOT EXISTS komponente_geraete_rueckfall_eine_je_richtung
    ON komponente_geraete_rueckfall (tenant_id, entity_id, richtung)
    WHERE aufgehoben_am IS NULL;

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE komponente_geraete_rueckfall ENABLE ROW LEVEL SECURITY;
ALTER TABLE komponente_geraete_rueckfall FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS komponente_geraete_rueckfall_tenant_isolation ON komponente_geraete_rueckfall;
CREATE POLICY komponente_geraete_rueckfall_tenant_isolation ON komponente_geraete_rueckfall
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. ALTER DEFAULT PRIVILEGES gibt beiden Rollen alles — hier wird ALLES
-- genommen und eng neu gegeben. Eine Angabe wird aufgehoben, nie geändert oder
-- gelöscht; das Offboarding (TenantRepository.offboard) räumt sie ab.
-- -----------------------------------------------------------------------------
REVOKE ALL ON komponente_geraete_rueckfall FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON komponente_geraete_rueckfall TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON komponente_geraete_rueckfall TO ${appDbUser};
GRANT SELECT, DELETE ON komponente_geraete_rueckfall TO ${adminDbUser};

COMMENT ON TABLE komponente_geraete_rueckfall IS
    'UEMS AP-15 IP-6: am Geraet hinterlegter Rueckfall je Komponente und Richtung (wer = created_by, wann = created_at); Vorrang vor dem Katalog-Eintrag der Familie, ohne beides zaehlt die Nennleistung (G3).';
