-- =============================================================================
-- UEMS AP-16 IP-17 (G5, E10 = A): die Toleranz je Vergleichsquelle als Fassung.
--
-- Fassung 1 ist der Startwert des Bewertungsvertrags (2 % je Monat,
-- docs/contracts/v2/bewertung.md §13) und wird NIE gespeichert: ohne Zeile gilt
-- er, ab dem Beginn der Vergleichsquelle. Jede Änderung ist eine neue Fassung
-- n + 1 mit Begründung und Akteur, gültig ab dem Monat ihres Eintrags in der
-- Zeitzone der Messstelle — ein abgeschlossener Monat wird nie nachträglich
-- anders beurteilt (nichts verschwindet). Kein UPDATE, kein App-DELETE.
--
-- Eine eigene Tabelle statt einer Art in quelle_einstellung: jene Fassungen
-- hängen am Einbau (geraet_id NOT NULL), wirken auf den Messwert
-- (angewendet/dokumentiert) und stehen in GET /geraete/{id}/einstellungen. Die
-- Toleranz gehört an die BINDUNG „Vergleich“ einer Messstelle (derselbe
-- Messwert kann an zwei Messstellen vergleichen) und ändert keinen Wert.
--
-- Additiv: eine neue, leere Tabelle; keine Bestandszeile ändert sich.
-- =============================================================================

CREATE TABLE IF NOT EXISTS vergleich_toleranz (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID         NOT NULL,
    -- Die Vergleichsquelle: eine Bindung der Rolle `vergleich` (Trigger unten).
    messstelle_quelle_id UUID         NOT NULL,
    -- 2, 3, … — Fassung 1 ist der Startwert des Vertrags.
    fassung              INTEGER      NOT NULL,
    -- Prozent je Monat, bezogen auf die führende Monatsmenge.
    prozent              NUMERIC(5,2) NOT NULL,
    -- Der erste Monat (Tag 1), den diese Fassung beurteilt.
    gilt_ab_monat        DATE         NOT NULL,
    begruendung          TEXT         NOT NULL,
    -- Der Urheber im Akteur-Vokabular von AP-03 (wie quelle_kadenz).
    actor_sub            TEXT,
    actor_name           TEXT         NOT NULL,
    actor_rolle          TEXT,
    actor_art            TEXT         NOT NULL,
    eingetragen_am       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT vergleich_toleranz_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Über uq_messstelle_quelle_id_tenant (V20260912160000); das Löschen einer
    -- Komponente folgt ihrer Bindung.
    CONSTRAINT vergleich_toleranz_bindung_fk FOREIGN KEY (messstelle_quelle_id, tenant_id)
        REFERENCES messstelle_quelle (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT uq_vergleich_toleranz_fassung UNIQUE (tenant_id, messstelle_quelle_id, fassung),
    CONSTRAINT vergleich_toleranz_fassung_chk CHECK (fassung >= 2),
    CONSTRAINT vergleich_toleranz_prozent_chk CHECK (prozent > 0 AND prozent <= 100),
    CONSTRAINT vergleich_toleranz_monat_chk CHECK (extract(day FROM gilt_ab_monat) = 1),
    CONSTRAINT vergleich_toleranz_begruendung_chk
        CHECK (char_length(begruendung) BETWEEN 1 AND 500 AND btrim(begruendung) <> ''),
    CONSTRAINT vergleich_toleranz_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT vergleich_toleranz_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT vergleich_toleranz_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);

CREATE INDEX IF NOT EXISTS idx_vergleich_toleranz_bindung
    ON vergleich_toleranz (messstelle_quelle_id, fassung);

-- Nur eine Vergleichsquelle trägt eine Toleranz — eine führende Quelle wird nie
-- gegen eine Schwelle geprüft.
CREATE OR REPLACE FUNCTION vergleich_toleranz_nur_vergleich() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM messstelle_quelle q
                    WHERE q.id = NEW.messstelle_quelle_id AND q.tenant_id = NEW.tenant_id
                      AND q.rolle = 'vergleich') THEN
        RAISE EXCEPTION 'Eine Toleranz steht nur an einer Vergleichsquelle'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'vergleich_toleranz_nur_vergleich';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS vergleich_toleranz_nur_vergleich ON vergleich_toleranz;
CREATE TRIGGER vergleich_toleranz_nur_vergleich BEFORE INSERT ON vergleich_toleranz
    FOR EACH ROW EXECUTE FUNCTION vergleich_toleranz_nur_vergleich();

ALTER TABLE vergleich_toleranz ENABLE ROW LEVEL SECURITY;
ALTER TABLE vergleich_toleranz FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vergleich_toleranz_tenant_isolation ON vergleich_toleranz;
CREATE POLICY vergleich_toleranz_tenant_isolation ON vergleich_toleranz
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON vergleich_toleranz FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON vergleich_toleranz TO ${appDbUser};
GRANT SELECT, DELETE ON vergleich_toleranz TO ${adminDbUser};
