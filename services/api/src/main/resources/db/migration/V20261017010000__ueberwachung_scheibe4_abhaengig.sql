-- =============================================================================
-- V20261017010000 - Alerting Scheibe 4: abhängige Meldungen unter der Box
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.4 Nr. 7, §9): "Meldet sich eine Box nicht,
-- gehen 'keine Daten' ihrer Geräte und Werte nicht einzeln hinaus, sondern
-- stehen unter der Meldung der Box" - dasselbe Ziel wie "Eine statt einer
-- Flut" des Lücken-Melders (docs/agents/root/uems-luecken-melder.md).
--
-- alarm.unterdrueckt_durch verweist auf den Box-/Datenquelle-Alarm DERSELBEN
-- Anlage, unter dem dieser Alarm im Center steht: ausgewertet und im Verlauf
-- nachweisbar (§6.10 Punkt 4), aber OHNE eigenen Versand (UeberwachungsService.
-- ausloesen). KEIN FOREIGN KEY auf (tenant_id, id) hier - der Eltern-Alarm und
-- dieser Alarm teilen immer denselben Kundenbereich (beide aus demselben Lauf,
-- derselbe anlageId), ein Fremdschlüssel nur auf (id) wäre ausreichend, aber
-- die bestehenden FKs dieser Tabelle gehen alle über (tenant_id, id) (Muster
-- der Migration V20261015130000) - additiv übernommen.
--
-- Additiv: keine bestehende Spalte, Zeile oder Policy ändert sich.
-- =============================================================================

ALTER TABLE alarm ADD COLUMN IF NOT EXISTS unterdrueckt_durch UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'alarm_unterdrueckt_durch_fk'
    ) THEN
        ALTER TABLE alarm ADD CONSTRAINT alarm_unterdrueckt_durch_fk
            FOREIGN KEY (tenant_id, unterdrueckt_durch) REFERENCES alarm (tenant_id, id);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_alarm_unterdrueckt_durch
    ON alarm (unterdrueckt_durch) WHERE unterdrueckt_durch IS NOT NULL;

COMMENT ON COLUMN alarm.unterdrueckt_durch IS
    'Alerting Scheibe 4 (§6.4 Nr. 7): der Box-/Datenquelle-Alarm derselben Anlage, unter dem dieser Alarm im Center steht - ausgewertet, aber ohne eigenen Versand.';
