-- MiSpeL MP-33e: die Messlatte „nur laden“ je Ladepunkt und Viertelstunde — derselbe Haushalt, in dem das Auto nur
-- lädt (Bedienkonzept BK-41 A, Captain 04.10.2026). Vertrag: docs/contracts/v2/mispel-messlatte-nur-laden.md § 3;
-- gelesen von GET /api/v1/sites/{siteId}/ladepunkte/ertraege/{JJJJ-MM} (mispel-ladepunkt-bidirektional.md § 6a).
--
-- Die Festlegung (BNetzA Az. 618-25-02, 01.10.2026) kennt diesen Vergleich nicht; er ist VoltPilots Maßstab. Die
-- Mengen der Karte bleiben die des Monatslaufs nach Anlage 1 (mispel_abgrenzung_monat), hier stehen nur die vier
-- Posten, die allein aus dem Vergleich folgen: weniger_gekauft, mehr_geladen, ins_netz_verkauft, akku_verschleiss.
--
-- EINE Zeile je Ladepunkt und Viertelstunde (Beginn, halboffen [zeit, zeit + 15 min)): der Plan, der für sie galt —
-- wie schedule über DISTINCT ON (time) … generated_at DESC, nur gleich beim Schreiben entschieden. Der Optimierer legt
-- je Plan alle Slots seines Horizonts ab; ein späterer Plan ersetzt eine Zeile, ein älterer nie (generated_at). Damit
-- ist das Schreiben wiederholbar: derselbe Plan ein zweites Mal ändert nichts. Die Monatssumme bildet der Leser.
-- Es ist ein PLAN-Wert, keine gemessene Wirkung.
--
-- BESTAND: die Tabelle beginnt LEER, keine Bestandszeile ändert sich. Ohne Zeilen bleibt § 6a bei messlatte_fehlt.
--
-- Die Komponente nimmt ihre Zeilen mit (ON DELETE CASCADE); über sie auch die Anlage und der Mandant.

CREATE TABLE IF NOT EXISTS ladepunkt_messlatte (
    komponente_id          UUID          NOT NULL,
    zeit                   TIMESTAMPTZ   NOT NULL,
    tenant_id              UUID          NOT NULL,
    site_id                UUID          NOT NULL,
    -- Der Plan, aus dem die Zeile stammt (schedule.plan_id / schedule.generated_at).
    plan_id                UUID          NOT NULL,
    generated_at           TIMESTAMPTZ   NOT NULL,
    -- EUR mit Vorzeichen (Ertrag positiv, Kosten negativ) und die kWh dazu, wie domain.MesslattePosten.
    weniger_gekauft_eur    NUMERIC(12, 6) NOT NULL,
    weniger_gekauft_kwh    NUMERIC(12, 6) NOT NULL,
    mehr_geladen_eur       NUMERIC(12, 6) NOT NULL,
    mehr_geladen_kwh       NUMERIC(12, 6) NOT NULL,
    -- Mehr Einspeisung als „nur laden“; negativ, wenn das Zurückspeisen PV-Einspeisung verdrängt.
    ins_netz_verkauft_eur  NUMERIC(12, 6) NOT NULL,
    ins_netz_verkauft_kwh  NUMERIC(12, 6) NOT NULL,
    akku_verschleiss_eur   NUMERIC(12, 6) NOT NULL,
    rueckgespeist_kwh      NUMERIC(12, 6) NOT NULL,
    PRIMARY KEY (komponente_id, zeit),
    CONSTRAINT ladepunkt_messlatte_komponente_fk FOREIGN KEY (komponente_id, tenant_id, site_id)
        REFERENCES measurement_point (id, tenant_id, site_id) ON DELETE CASCADE,
    CONSTRAINT ladepunkt_messlatte_viertelstunde_chk
        CHECK (extract(epoch FROM zeit)::bigint % 900 = 0),
    -- Die EUR-Posten tragen kein festes Vorzeichen: bei negativem Börsenpreis kostet weniger Bezug Geld.
    CONSTRAINT ladepunkt_messlatte_vorzeichen_chk
        CHECK (akku_verschleiss_eur <= 0
            AND weniger_gekauft_kwh >= 0 AND mehr_geladen_kwh >= 0 AND rueckgespeist_kwh >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ladepunkt_messlatte_site_zeit ON ladepunkt_messlatte (site_id, zeit);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE ladepunkt_messlatte ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladepunkt_messlatte FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ladepunkt_messlatte_tenant_isolation ON ladepunkt_messlatte;
CREATE POLICY ladepunkt_messlatte_tenant_isolation ON ladepunkt_messlatte
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Lesen für die Route; geschrieben wird nur vom Optimierer (Backend-Rolle wie schedule).
REVOKE ALL ON ladepunkt_messlatte FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON ladepunkt_messlatte TO ${appDbUser};
GRANT SELECT, DELETE ON ladepunkt_messlatte TO ${adminDbUser};

COMMENT ON TABLE ladepunkt_messlatte IS
    'MiSpeL MP-33e: Messlatte „nur laden“ je Ladepunkt und Viertelstunde aus dem Plan, der für sie galt (vier Posten in EUR und kWh). Vertrag docs/contracts/v2/mispel-messlatte-nur-laden.md § 3.';
