-- =============================================================================
-- UEMS AP-09 IP-5: eine Bezugsgröße OHNE einen einzigen Wert darf gelöscht werden
-- (M6) — und ihr Kennzeichen bleibt trotzdem belegt (M2).
--
-- V20260913104500 (IP-4) hat DELETE für die Anwendung gesperrt: die Tabellen
-- kannten nur das Archivieren, und der Kennzeichen-Verlauf hielt die Zeile per
-- Fremdschlüssel (RESTRICT) fest. Die Schreibroute `DELETE /api/v1/bezugsgroessen/{id}`
-- (AP-09 §8 IP-5, M6 „gelöscht wird sie nur ohne einen einzigen Wert“) braucht
-- genau diese eine Öffnung — ENG:
--
--   1. Die Anwendung bekommt DELETE auf `bezugsgroesse` — NUR dort. Werte,
--      Kennzeichen-Verlauf und Protokoll bleiben für sie unlöschbar.
--   2. Ein Trigger lehnt das Löschen ab, sobald die Bezugsgröße EINE Wert-Zeile
--      trägt (auch eine Rücknahme ist eine Fassung, Invariante 1) — für JEDE Rolle
--      außer dem Offboarding, das die Werte vorher selbst abräumt. Die
--      Fremdschlüssel der Wert-Zeilen (RESTRICT) bleiben die zweite Wand; der
--      Trigger gibt der Ablehnung ihren Namen (`bezugsgroesse_hat_werte`).
--      Gleichzeitigkeit: DELETE nimmt die Zeilensperre FOR UPDATE, das Einfügen
--      eines Werts FOR KEY SHARE auf dieselbe Zeile — ein unbestätigter erster Wert
--      lässt das Löschen warten, danach lehnt der Trigger ab.
--   3. Der Kennzeichen-Verlauf verliert beim Löschen nur den VERWEIS
--      (`ON DELETE SET NULL (bezugsgroesse_id)`), nie seine Zeile: der
--      Primärschlüssel (tenant_id, kennzeichen) bleibt belegt, die Belegung wird
--      ein Grabstein ohne Träger. Ein neues Kennzeichen scheitert daran weiter mit
--      `bezugsgroesse_kennzeichen_belegt` — kein Kennzeichen wird je weitergegeben,
--      auch nicht das einer gelöschten Bezugsgröße. Die automatische Vergabe folgt
--      auf die höchste je belegte Nummer und sieht den Grabstein mit.
--   4. Das Protokoll kennt die Art `geloescht`. Die Liste wird geweitet, indem der
--      AKTUELLE Stand (`angelegt`, `bearbeitet`, `archiviert` aus V20260913104500)
--      abgeschrieben und ergänzt wird. Das Protokoll hat keinen Verweis auf die
--      Bezugsgröße und überlebt sie.
--
-- Nicht angefasst: `bezugsgroesse_wert` (append-only, DELETE nur Offboarding),
-- die Rechte der Verwaltungsrolle, RLS/FORCE (unverändert, gilt auch für DELETE),
-- jede bestehende Zeile. Kein Backfill.
-- =============================================================================

-- 3. Der Verlauf hält das Kennzeichen, nicht die Zeile.
ALTER TABLE bezugsgroesse_kennzeichen_verlauf ALTER COLUMN bezugsgroesse_id DROP NOT NULL;
ALTER TABLE bezugsgroesse_kennzeichen_verlauf
    DROP CONSTRAINT IF EXISTS bezugsgroesse_kennzeichen_verlauf_bezugsgroesse_fk;
ALTER TABLE bezugsgroesse_kennzeichen_verlauf
    ADD CONSTRAINT bezugsgroesse_kennzeichen_verlauf_bezugsgroesse_fk
        FOREIGN KEY (bezugsgroesse_id, tenant_id)
        REFERENCES bezugsgroesse (id, tenant_id) ON DELETE SET NULL (bezugsgroesse_id);

-- ⚠ SET NULL ist ein UPDATE auf dem Verlauf — und den hält seit IP-4 der Trigger
-- bezugsgroesse_kennzeichen_verlauf_append_only (reject_audit_mutation) für JEDE
-- Änderung zu. Er bekommt eine eigene Funktion, die GENAU den Grabstein durchlässt:
-- `bezugsgroesse_id` wird NULL, jede andere Spalte bleibt Zeichen für Zeichen. Jede
-- andere Änderung scheitert wie bisher mit „audit rows are append-only“. Die
-- Anwendung hat ohnehin kein UPDATE-Recht auf den Verlauf; den Grabstein setzt nur
-- die Fremdschlüssel-Aktion.
CREATE OR REPLACE FUNCTION bezugsgroesse_kennzeichen_verlauf_nur_grabstein() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.bezugsgroesse_id IS NOT NULL AND NEW.bezugsgroesse_id IS NULL
     AND NEW.tenant_id = OLD.tenant_id AND NEW.kennzeichen = OLD.kennzeichen
     AND NEW.belegt_am = OLD.belegt_am THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit rows are append-only';
END $$;
DROP TRIGGER IF EXISTS bezugsgroesse_kennzeichen_verlauf_append_only ON bezugsgroesse_kennzeichen_verlauf;
CREATE TRIGGER bezugsgroesse_kennzeichen_verlauf_append_only BEFORE UPDATE ON bezugsgroesse_kennzeichen_verlauf
    FOR EACH ROW EXECUTE FUNCTION bezugsgroesse_kennzeichen_verlauf_nur_grabstein();

-- 2. M6: nur ohne einen einzigen Wert.
CREATE OR REPLACE FUNCTION bezugsgroesse_nur_ohne_wert_loeschen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bezugsgroesse_wert w
              WHERE w.bezugsgroesse_id = OLD.id AND w.tenant_id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'Die Bezugsgröße % trägt Werte und wird nicht gelöscht', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_hat_werte';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS bezugsgroesse_nur_ohne_wert_loeschen ON bezugsgroesse;
CREATE TRIGGER bezugsgroesse_nur_ohne_wert_loeschen BEFORE DELETE ON bezugsgroesse
    FOR EACH ROW EXECUTE FUNCTION bezugsgroesse_nur_ohne_wert_loeschen();

-- 4. Die Protokoll-Art `geloescht` — der aktuelle Stand, abgeschrieben und ergänzt.
ALTER TABLE bezugsgroesse_aenderung DROP CONSTRAINT IF EXISTS bezugsgroesse_aenderung_art_chk;
ALTER TABLE bezugsgroesse_aenderung ADD CONSTRAINT bezugsgroesse_aenderung_art_chk
    CHECK (art IN ('angelegt', 'bearbeitet', 'archiviert', 'geloescht'));

-- 1. Die eine Öffnung.
GRANT DELETE ON bezugsgroesse TO ${appDbUser};

COMMENT ON TRIGGER bezugsgroesse_nur_ohne_wert_loeschen ON bezugsgroesse IS
    'UEMS AP-09 M6: eine Bezugsgroesse wird nur ohne einen einzigen Wert geloescht; sonst archiviert.';
COMMENT ON CONSTRAINT bezugsgroesse_kennzeichen_verlauf_bezugsgroesse_fk ON bezugsgroesse_kennzeichen_verlauf IS
    'UEMS AP-09 M2: beim Loeschen bleibt die Belegung als Grabstein (bezugsgroesse_id NULL); nie weitergegeben.';
