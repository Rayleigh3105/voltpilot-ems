-- =============================================================================
-- UEMS AP-11 IP-5: eine Kennzahl ohne einen einzigen Wert löschen (V5, §5.7).
--
-- Die Tabellen (V20260915003000) geben der Anwendung kein DELETE: Fassungen und
-- Eingänge sind Historie ihrer Kennzahl. Gelöscht wird darum über EINE Funktion,
-- die genau die Regel des Vertrags prüft (Muster uems_ort_loeschen):
--
--   1. Nur im Kundenbereich des Aufrufers (`app.tenant_id`); eine fremde oder
--      unbekannte Kennzahl ist NULL — nicht da, nie ein Fehler, der sie verrät.
--   2. Nur ohne einen einzigen Wert (`kennzahl_hat_werte`) und nur, wenn keine
--      ANDERE Kennzahl sie liest — in keiner Fassung, auch keiner beendeten
--      (`kennzahl_wird_gelesen`, die lesenden Kennzeichen in der Meldung).
--   3. Die Zeile verschwindet mit ihren Fassungen und Eingängen; das Protokoll
--      hat keinen Verweis und überlebt sie.
--   4. Der Kennzeichen-Verlauf verliert nur den VERWEIS
--      (`ON DELETE SET NULL (kennzahl_id)`), nie seine Zeile: der Primärschlüssel
--      (tenant_id, kennzeichen) bleibt belegt — ein Kennzeichen wird nie
--      weitergegeben, auch nicht das einer gelöschten Kennzahl (Muster
--      V20260913120000, Bezugsgröße). Die automatische Vergabe sieht den Grabstein.
--
-- Nicht angefasst: kennzahl_wert/kennzahl_wert_eingang (append-only), die Rechte
-- der Tabellen (die Anwendung bekommt nur EXECUTE auf die Funktion), RLS/FORCE,
-- das Vokabular, jede bestehende Zeile. Kein Backfill.
-- =============================================================================

-- 4. Der Verlauf hält das Kennzeichen, nicht die Zeile.
ALTER TABLE kennzahl_kennzeichen_verlauf ALTER COLUMN kennzahl_id DROP NOT NULL;
ALTER TABLE kennzahl_kennzeichen_verlauf
    DROP CONSTRAINT IF EXISTS kennzahl_kennzeichen_verlauf_kennzahl_fk;
ALTER TABLE kennzahl_kennzeichen_verlauf
    ADD CONSTRAINT kennzahl_kennzeichen_verlauf_kennzahl_fk
        FOREIGN KEY (kennzahl_id, tenant_id)
        REFERENCES kennzahl (id, tenant_id) ON DELETE SET NULL (kennzahl_id);

-- ⚠ SET NULL ist ein UPDATE auf dem Verlauf — den hält kennzahl_kennzeichen_verlauf_append_only
-- (reject_audit_mutation) für JEDE Änderung zu. Die eigene Funktion lässt GENAU den Grabstein
-- durch: `kennzahl_id` wird NULL, jede andere Spalte bleibt Zeichen für Zeichen. Jede andere
-- Änderung scheitert wie bisher mit „audit rows are append-only“.
CREATE OR REPLACE FUNCTION kennzahl_kennzeichen_verlauf_nur_grabstein() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kennzahl_id IS NOT NULL AND NEW.kennzahl_id IS NULL
     AND NEW.tenant_id = OLD.tenant_id AND NEW.kennzeichen = OLD.kennzeichen
     AND NEW.belegt_am = OLD.belegt_am THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only';
END $$;
DROP TRIGGER IF EXISTS kennzahl_kennzeichen_verlauf_append_only ON kennzahl_kennzeichen_verlauf;
CREATE TRIGGER kennzahl_kennzeichen_verlauf_append_only BEFORE UPDATE ON kennzahl_kennzeichen_verlauf
    FOR EACH ROW EXECUTE FUNCTION kennzahl_kennzeichen_verlauf_nur_grabstein();

-- 1.–3. Löschen: gibt das Kennzeichen der gelöschten Kennzahl zurück, NULL = nicht da.
CREATE OR REPLACE FUNCTION uems_kennzahl_loeschen(p_kennzahl UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    tenant_scope UUID := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
    v_kennzeichen TEXT;
    v_leser TEXT;
BEGIN
    IF tenant_scope IS NULL THEN
        RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
    END IF;
    IF p_kennzahl IS NULL THEN
        RAISE EXCEPTION 'a kennzahl is required' USING ERRCODE = '22023';
    END IF;
    SELECT k.kennzeichen INTO v_kennzeichen
      FROM kennzahl k WHERE k.id = p_kennzahl AND k.tenant_id = tenant_scope FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM kennzahl_wert w WHERE w.kennzahl_id = p_kennzahl AND w.tenant_id = tenant_scope) THEN
        RAISE EXCEPTION 'Die Kennzahl % traegt Werte und wird nicht geloescht', v_kennzeichen
            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'kennzahl_hat_werte';
    END IF;
    SELECT string_agg(DISTINCT l.kennzeichen, ', ' ORDER BY l.kennzeichen) INTO v_leser
      FROM kennzahl_eingang e
      JOIN kennzahl l ON l.id = e.kennzahl_id AND l.tenant_id = e.tenant_id
     WHERE e.eingang_kennzahl_id = p_kennzahl AND e.tenant_id = tenant_scope AND e.kennzahl_id <> p_kennzahl;
    IF v_leser IS NOT NULL THEN
        RAISE EXCEPTION 'Die Kennzahl % wird von % gelesen', v_kennzeichen, v_leser
            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'kennzahl_wird_gelesen';
    END IF;

    DELETE FROM kennzahl_eingang e WHERE e.kennzahl_id = p_kennzahl AND e.tenant_id = tenant_scope;
    DELETE FROM kennzahl_fassung f WHERE f.kennzahl_id = p_kennzahl AND f.tenant_id = tenant_scope;
    DELETE FROM kennzahl k WHERE k.id = p_kennzahl AND k.tenant_id = tenant_scope;
    RETURN v_kennzeichen;
END $$;
REVOKE ALL ON FUNCTION uems_kennzahl_loeschen(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_kennzahl_loeschen(UUID) TO ${appDbUser};
