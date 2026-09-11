-- UEMS AP-02 IP-9: die BESTANDSÜBERNAHME der Standorte — die Vorschlagszeilen der
-- Kundenbereiche mit mehreren Anlagen, und der Grabstein der Anlagen-Zuordnung.
--
-- Die Prosa-Wahrheit ist das Konzept vp-uems-ap02-ortsstruktur (E5 = A, E9, E10 = A,
-- §6.3 Bestandskunden, W5; Abnahme A5/A6). Die REGEL ist Vertrag: Familie
-- `bestandsuebernahme` in docs/contracts/v2/ortsbaum-vectors.json mit den Zwillingen
-- BestandsuebernahmeAbleitung.java / uemsBestandsuebernahme.ts. Angewandt wird sie NICHT
-- hier, sondern vom Start-Läufer BestandsuebernahmeLaeufer — die Regel lebt in Java, und
-- eine angewandte Migration ist unveränderlich (dieselbe Begründung wie V2SiteBackfillRunner).
-- Diese Migration legt KEINE Zeile an.
--
-- ⚠ REIN ADDITIV für jede Kunden-Antwort. `site`, `tenant`, `standort` und die Zeilen von
-- `anlage_standort` bleiben zeichengleich; kein Topic, keine Freigabe, kein Betriebsmodell.
--
-- (1) standort_vorschlag — je Anlage eines Kundenbereichs mit MEHREREN Anlagen ein Vorschlag
--     „ein Standort gleichen Namens, Zuordnung ab dem Tag des Anlegens" (E5). Ein Vorschlag
--     ist KEINE Zuordnung: bis zur Bestätigung in der Vorschau (IP-10) bleibt die Anlage
--     „noch nicht zugeordnet" und das Portfolio zeichengleich (A6, A15). Er hat keine
--     Historie — er stirbt mit seiner Anlage (ON DELETE CASCADE, wie `geraet`), und darum
--     auch kein Protokolleintrag: eine Vorschlagszeile ändert die Ortsstruktur nicht.
--
-- (2) anlage_standort: DIE ANLAGE DARF GEHEN, IHRE ZUORDNUNG BLEIBT (W5). Bis hierher
--     verweigerte der Fremdschlüssel anlage_standort_site_fk (RESTRICT) das Löschen einer
--     zugeordneten Anlage — harmlos, solange es keine Zuordnung gab (V20260911100000:
--     „den Grabstein beim Anlagen-Löschen entscheidet IP-9/AP-14"). Ab jetzt legt die
--     Bestandsübernahme für JEDEN Kundenbereich mit einer Anlage eine an, und neue Anlagen
--     bekommen eine beim Anlegen: ohne diese Änderung endete „Anlage löschen" (SiteController,
--     409 bei Geräten, sonst Kaskade) für sie in einem Fehler 500. Das Anlagen-Löschen bleibt
--     unverändert (§6.3, W5); die Zuordnung bleibt als BEENDETES Intervall stehen, mit dem
--     Protokolleintrag „geloescht" am Objekt `anlage` (der Löschweg schreibt beides,
--     AnlageStandortService). Deshalb:
--       * der Fremdschlüssel auf `site` fällt — die Zeile überlebt die Anlage, von der sie
--         erzählt (das Muster von ort_aenderung / component_change_event);
--       * seine EINFÜGE-Hälfte bleibt als Trigger: eine neue (oder umgehängte) Zeile nennt
--         eine Anlage DESSELBEN Mandanten, die es gibt — mit derselben Ablehnung wie vorher
--         (23503, Constraint-Name anlage_standort_site_fk), damit die Ablehnung einem fremden
--         Mandanten weiterhin nichts verrät (UemsStandortMigrationTest). Die Anlagen-Zeile
--         wird bis zum Ende der Transaktion gegen Löschen gesperrt (FOR KEY SHARE), wie es
--         der Fremdschlüssel tat.
--     Die Standort- und Mandanten-Schlüssel bleiben RESTRICT: ein Standort wird archiviert,
--     nie gelöscht; das Offboarding räumt ausdrücklich ab (TenantRepository.offboard).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- (1) standort_vorschlag
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS standort_vorschlag (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        NOT NULL,
    site_id     UUID        NOT NULL,
    -- Der vorgeschlagene Standortname: der Name der Anlage beim Vorschlagen, auf die
    -- Namensregel des Standorts gebracht (BestandsuebernahmeAbleitung.standortName).
    name        TEXT        NOT NULL,
    -- Die Zeitzone, in der `gueltig_ab` gerechnet ist — die des Unternehmens (E9); der
    -- bestätigte Standort bekommt sie vorbelegt.
    zeitzone    TEXT        NOT NULL,
    -- Der Tag von site.created_at in dieser Zeitzone: ab dann gälte die Zuordnung.
    gueltig_ab  DATE        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = VoltPilot selbst (die Bestandsübernahme).
    created_by  TEXT,
    CONSTRAINT standort_vorschlag_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Zusammengesetzt über uq_site_id_tenant_identity (V20260844000000): die Anlage gehört
    -- demselben Mandanten wie der Vorschlag. CASCADE: siehe Kopf.
    CONSTRAINT standort_vorschlag_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    -- Je Anlage höchstens EIN Vorschlag — der zweite Lauf schreibt keinen doppelt.
    -- tenant_id vorn: ein Constraint prüft ohne RLS (die Lehre von anlage_standort).
    CONSTRAINT uq_standort_vorschlag_anlage UNIQUE (tenant_id, site_id),
    CONSTRAINT standort_vorschlag_name_chk
        CHECK (char_length(name) BETWEEN 1 AND 120 AND btrim(name) <> ''),
    CONSTRAINT standort_vorschlag_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')),
    CONSTRAINT standort_vorschlag_created_by_chk
        CHECK (created_by IS NULL OR btrim(created_by) <> '')
);

-- Der Mandantenzaun (Hausregel; A14: fremd ist 404, ohne app.tenant_id 0 Zeilen).
ALTER TABLE standort_vorschlag ENABLE ROW LEVEL SECURITY;
ALTER TABLE standort_vorschlag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS standort_vorschlag_tenant_isolation ON standort_vorschlag;
CREATE POLICY standort_vorschlag_tenant_isolation ON standort_vorschlag
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Rechte: V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE —
-- hier wird weggenommen, was es nicht geben darf. Die Bestandsübernahme schreibt über die
-- App-Rolle mit gesetztem Mandanten; ein Vorschlag wird nie umgeschrieben (was die Vorschau
-- mit ihm tut, bringt IP-10 samt seinem Recht). Mit der Anlage geht er über den
-- Fremdschlüssel, der mit den Rechten des Tabelleneigentümers löscht (wie `geraet`).
-- Kein BIGSERIAL, also kein Sequenz-Grant.
GRANT SELECT, INSERT ON standort_vorschlag TO ${appDbUser};
REVOKE UPDATE, DELETE ON standort_vorschlag FROM ${appDbUser};

-- -----------------------------------------------------------------------------
-- (2) anlage_standort: die Anlage darf gehen, ihre Zuordnung bleibt (W5)
-- -----------------------------------------------------------------------------
ALTER TABLE anlage_standort DROP CONSTRAINT IF EXISTS anlage_standort_site_fk;

-- SECURITY INVOKER (die Vorgabe): unter RLS sieht die App-Rolle nur die Anlagen ihres
-- Mandanten — und der Mandant der Zeile IST ihrer (Policy WITH CHECK). FOR KEY SHARE hält
-- die Anlage bis zum Ende der Transaktion, wie der Fremdschlüssel es tat (die App-Rolle hat
-- das UPDATE auf site, das die Sperre verlangt).
CREATE OR REPLACE FUNCTION uems_anlage_standort_anlage_pruefen() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1 FROM site WHERE id = NEW.site_id AND tenant_id = NEW.tenant_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'anlage_standort_site_fk',
            MESSAGE = 'insert or update on table "anlage_standort" violates foreign key '
                || 'constraint "anlage_standort_site_fk"',
            DETAIL = 'Die Anlage gibt es in diesem Kundenbereich nicht.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS anlage_standort_anlage_da ON anlage_standort;
CREATE TRIGGER anlage_standort_anlage_da
    BEFORE INSERT OR UPDATE OF site_id, tenant_id ON anlage_standort
    FOR EACH ROW EXECUTE FUNCTION uems_anlage_standort_anlage_pruefen();
