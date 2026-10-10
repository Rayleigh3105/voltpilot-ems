-- UEMS AP-20, Folge zu IP-18 (E10 = A: beenden, mitnehmen, nach der Frist löschen — keine Anonymisierung).
--
-- Fünf append-only-Protokolle tragen `tenant_id`, aber KEINEN Fremdschlüssel auf `tenant`, und ihr Trigger
-- (`reject_audit_mutation`) verbot jedes UPDATE/DELETE für jede Rolle. Sie überlebten darum das Löschen eines
-- Kundenbereichs — mit Firmen- und Personennamen (`neu`-JSON, `actor_name`, `created_by`, `note`); der Löschnachweis
-- (V20260925223000) nannte sie unter `verblieben`:
--
--   * `ort_aenderung` (AP-02), `messstelle_aenderung` (AP-04), `data_source_aenderung` (AP-06);
--   * `component_change_event` und `device_site_assignment` (V20260843000000, main) — dieselbe Bauart, im Katalog
--     gefunden: jede Tabelle mit `tenant_id` ohne Fremdschlüssel auf `tenant` und mit einem DELETE-Trigger. Die
--     übrigen Protokolle mit DELETE-Trigger halten den Mandanten per RESTRICT und gehen schon im Löschzug.
--
-- Die Regel, eng gefasst: ein DELETE auf GENAU diesen fünf Tabellen ist nur erlaubt, wenn die Mandantenzeile der
-- Kennung nicht mehr existiert — also nur nach dem `DELETE FROM tenant`. Während der Vertragslaufzeit, auch im Zustand
-- „beendet", scheitert jedes UPDATE und jedes DELETE wie bisher mit „audit rows are append-only" — für jede Rolle,
-- auch für die Verwaltungsrolle und den Eigentümer. Das Löschen eines Standorts oder einer Box lässt die Einträge
-- weiter stehen: der Mandant existiert noch.
--
-- 1. Die Regel sitzt in `reject_audit_mutation()` selbst, nicht in einer neuen Trigger-Funktion: die fünf Trigger
--    bleiben, wie sie sind (Name, Ereignisse, Funktion), und eine Ursprungsmigration, die ihren Trigger erneut
--    anlegt, hebt die Regel nicht auf. Für jede andere Tabelle und für jedes UPDATE bleibt die Funktion Zeichen für
--    Zeichen, was sie war (V20260843000000) — main setzt sie nur dort, das hier ist die Vereinigung.
-- 2. Den Weg geht EINE Funktion (`uems_protokolle_ohne_mandant_entfernen`, SECURITY DEFINER), ausführbar nur von der
--    Verwaltungsrolle, wie die Berichte (V20260915050000): sie verweigert, solange die Mandantenzeile existiert, setzt
--    den Zaun auf GENAU diesen Kundenbereich und löscht die fünf Tabellen. `TenantRepository.offboard` ruft sie nach
--    `DELETE FROM tenant` und vor dem Löschnachweis, in derselben Transaktion; ebenso die Rücknahme einer
--    gescheiterten Selbstregistrierung (`deleteById`). Die Tabellenrechte bleiben unverändert.
-- 3. Die App-Rolle löscht und ändert nie: für die drei UEMS-Protokolle war das schon so; die zwei main-Tabellen hatten
--    UPDATE und DELETE nur aus den Standardrechten (V2) — der Trigger hielt sie, jetzt auch das Recht.
--
-- Keine Zeile, keine Spalte, kein CHECK ändert sich.

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_TABLE_NAME IN ('ort_aenderung', 'messstelle_aenderung', 'data_source_aenderung',
                           'component_change_event', 'device_site_assignment')
     AND NOT EXISTS (SELECT 1 FROM public.tenant t WHERE t.id = (to_jsonb(OLD) ->> 'tenant_id')::uuid) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only';
END $$;

CREATE OR REPLACE FUNCTION uems_protokolle_ohne_mandant_entfernen(p_tenant UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    entfernt BIGINT := 0;
    n BIGINT;
    zaun TEXT := current_setting('app.tenant_id', true);
BEGIN
    IF p_tenant IS NULL THEN
        RAISE EXCEPTION 'a tenant scope is required' USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.tenant_id', p_tenant::text, true);
    IF EXISTS (SELECT 1 FROM public.tenant WHERE id = p_tenant) THEN
        RAISE EXCEPTION 'Kundenbereich % existiert noch: seine Protokolle bleiben', p_tenant
            USING ERRCODE = 'check_violation';
    END IF;
    DELETE FROM ort_aenderung WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM messstelle_aenderung WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM data_source_aenderung WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM component_change_event WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM device_site_assignment WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    PERFORM set_config('app.tenant_id', coalesce(zaun, ''), true);
    RETURN entfernt;
END $$;

REVOKE ALL ON FUNCTION uems_protokolle_ohne_mandant_entfernen(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_protokolle_ohne_mandant_entfernen(UUID) TO ${adminDbUser};

REVOKE UPDATE, DELETE ON component_change_event, device_site_assignment FROM ${appDbUser};

COMMENT ON FUNCTION uems_protokolle_ohne_mandant_entfernen(UUID) IS
    'UEMS AP-20 E10 = A: die fünf Protokolle ohne Fremdschlüssel eines GELÖSCHTEN Kundenbereichs entfernen (Löschzug nach DELETE FROM tenant).';
