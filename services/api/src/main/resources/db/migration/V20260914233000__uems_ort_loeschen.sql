-- =============================================================================
-- UEMS AP-02 IP-15 — Ein Gebäude oder einen Bereich löschen, NUR ohne Historie (E1)
-- =============================================================================
-- Archivieren ist der Normalweg; gelöscht wird nur ein Ort, an dem nie etwas
-- hing (E1, Captain 10.09.2026: „Option A"). Die App-Rolle hat auf `ort` und
-- `ort_zuordnung` bewusst KEIN DELETE (V20260911110000) — daran ändert diese
-- Migration nichts. Sie legt eine enge Funktion an (Muster: die Löschwege,
-- V20260913150000), die genau diesen einen Weg geht:
--
--   * nur im Kundenbereich der Sitzung (`app.tenant_id`), sonst `false` (404);
--   * nur ohne jede Historie — sonst `restrict_violation` mit der Bedingung
--     `ort_hat_historie`, und nichts ist gelöscht. „Historie" heißt hier: eine
--     Zeile, die auf den Ort zeigt, auch eine beendete oder aufgehobene —
--     Messstelle am Ort, Fläche, ein Bereich darunter, eine Bezugsgröße. Die
--     Regel urteilt der Schreibweg vorher (`OrtsbaumAbleitung.loeschen`); das hier
--     ist die Rückwand, und die Fremdschlüssel (alle ON DELETE RESTRICT) sind die
--     Rückwand dahinter;
--   * die eigenen Zuordnungen des Orts gehen mit, sonst nichts. Das Kurzzeichen
--     bleibt in `ort_kurzzeichen` belegt (nie wiederverwendet), und die
--     Protokolleinträge bleiben stehen — der Schreibweg trägt „gelöscht" am
--     Elternknoten ein.
--
-- Keine Tabelle, keine Spalte, keine Zeile ändert sich: der Bestand ist nach
-- dieser Migration zeichengleich.

CREATE OR REPLACE FUNCTION uems_ort_loeschen(p_ort UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    tenant_scope UUID := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
BEGIN
    IF tenant_scope IS NULL THEN
        RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
    END IF;
    IF p_ort IS NULL THEN
        RAISE EXCEPTION 'an ort is required' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM ort o WHERE o.id = p_ort AND o.tenant_id = tenant_scope FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM messstelle_ort m WHERE m.ort_id = p_ort AND m.tenant_id = tenant_scope)
       OR EXISTS (SELECT 1 FROM flaeche_gueltigkeit f WHERE f.ort_id = p_ort AND f.tenant_id = tenant_scope)
       OR EXISTS (SELECT 1 FROM ort_zuordnung k WHERE k.eltern_ort_id = p_ort AND k.tenant_id = tenant_scope)
       OR EXISTS (SELECT 1 FROM bezugsgroesse g WHERE g.ort_id = p_ort AND g.tenant_id = tenant_scope) THEN
        RAISE EXCEPTION 'Der Ort % traegt Historie und wird nicht geloescht', p_ort
            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'ort_hat_historie';
    END IF;

    DELETE FROM ort_zuordnung z WHERE z.ort_id = p_ort AND z.tenant_id = tenant_scope;
    DELETE FROM ort o WHERE o.id = p_ort AND o.tenant_id = tenant_scope;
    RETURN true;
END
$$;

REVOKE ALL ON FUNCTION uems_ort_loeschen(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_ort_loeschen(UUID) TO ${appDbUser};
