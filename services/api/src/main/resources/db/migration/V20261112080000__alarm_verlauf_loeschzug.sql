-- =============================================================================
-- V20261112080000 - Der Löschzug nimmt den Alarm-Verlauf mit (vp-kunde-loeschen-500)
-- -----------------------------------------------------------------------------
-- Befund (Produktion, 12.11.2026): das endgültige Löschen eines beendeten Kunden
-- (POST /api/v1/admin/tenants/{id}/delete) starb mit „audit rows are append-only"
-- (P0001) aus reject_audit_mutation(). Der Löschzug (TenantRepository.offboard)
-- löschte alarm_verlauf direkt; sein Trigger (V20261015130000, UPDATE OR DELETE)
-- verbietet aber JEDES DELETE. Die Ausnahme in reject_audit_mutation
-- (V20260925234500) gilt nur für die fünf Protokolle OHNE Fremdschlüssel auf
-- tenant und erst NACH der Mandantenzeile - alarm_verlauf hält den Mandanten per
-- RESTRICT und muss VOR ihr gehen. Jeder Kundenbereich, dessen Überwachung je
-- einen Alarm ausgelöst hat (die ab-Werk-Überwachung tut das z. B. für eine nie
-- gemeldete Box), trägt Verlaufszeilen - sein Löschzug scheiterte damit immer.
-- Lokal fiel das nie auf: die Tests säen die Überwachung (Befund
-- vp-kunde-sofort-loeschen), aber keinen ausgelösten Alarm mit Verlauf, denn der
-- Läufer läuft im Test nicht.
--
-- Die Regel, am Muster kennzahl_wert (V20260915003000): der Verlauf bleibt
-- append-only für JEDE Rolle - ausgelöst, Versand, gesehen, wieder normal,
-- erledigt werden nie geändert und nie gelöscht (§6.10 Punkt 4). Die EINE
-- Ausnahme ist das DELETE im Aufruf von
-- uems_alarmverlauf_des_kundenbereichs_entfernen() für genau dessen
-- Kundenbereich: das Offboarding (UEMS AP-20, E10 = A - gelöscht, nicht
-- anonymisiert) ruft sie vor dem Löschen der Alarme, die der Verlauf per
-- Fremdschlüssel hält. Trigger-Name und -Ereignisse bleiben; nur die Funktion
-- der Tabelle wird eigen. Tabellenrechte bleiben unverändert: der Trigger ist
-- die Regel, wie bisher.
-- =============================================================================

-- ⚠ Der Alarm-Verlauf wird nie geändert und nie gelöscht - JEDES UPDATE und
-- JEDES DELETE, von jeder Rolle. Einzige Ausnahme: das DELETE im Aufruf von
-- uems_alarmverlauf_des_kundenbereichs_entfernen() für genau dessen
-- Kundenbereich. Die Meldung bleibt wörtlich die von reject_audit_mutation().
CREATE OR REPLACE FUNCTION alarm_verlauf_nie_veraendert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('uems.alarmverlauf_entfernen', true) = OLD.tenant_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only';
END $$;

DROP TRIGGER IF EXISTS alarm_verlauf_append_only ON alarm_verlauf;
CREATE TRIGGER alarm_verlauf_append_only BEFORE UPDATE OR DELETE ON alarm_verlauf
    FOR EACH ROW EXECUTE FUNCTION alarm_verlauf_nie_veraendert();

-- -----------------------------------------------------------------------------
-- Der eine Ausgang des Verlaufs: das Offboarding. Nur die Verwaltungsrolle darf
-- die Funktion ausführen; sie setzt den Zaun und die Kennzeichnung für GENAU
-- ihren Kundenbereich und nimmt beide wieder zurück (Muster
-- uems_kennzahlwerte_des_kundenbereichs_entfernen).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uems_alarmverlauf_des_kundenbereichs_entfernen(p_tenant UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    entfernt BIGINT := 0;
    zaun TEXT := current_setting('app.tenant_id', true);
BEGIN
    IF p_tenant IS NULL THEN
        RAISE EXCEPTION 'a tenant scope is required' USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.tenant_id', p_tenant::text, true);
    PERFORM set_config('uems.alarmverlauf_entfernen', p_tenant::text, true);
    DELETE FROM alarm_verlauf WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS entfernt = ROW_COUNT;
    PERFORM set_config('uems.alarmverlauf_entfernen', '', true);
    PERFORM set_config('app.tenant_id', coalesce(zaun, ''), true);
    RETURN entfernt;
END $$;

REVOKE ALL ON FUNCTION uems_alarmverlauf_des_kundenbereichs_entfernen(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_alarmverlauf_des_kundenbereichs_entfernen(UUID) TO ${adminDbUser};

COMMENT ON FUNCTION uems_alarmverlauf_des_kundenbereichs_entfernen(UUID) IS
    'UEMS AP-20 E10 = A (vp-kunde-loeschen-500): den append-only Alarm-Verlauf eines Kundenbereichs im Löschzug entfernen - vor DELETE FROM alarm, in derselben Transaktion.';
