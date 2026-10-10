-- UEMS AP-15 IP-15 (P1): eine Laufnummer je Anlage, aufsteigend, am Lauf gespeichert.
-- Der Optimierer vergibt sie nach dem Speichern des Laufs (höchste Nummer der Anlage + 1) und
-- schreibt sie in die Plan-Dokumente einer Anlage mit Gemeinsamer Steuerung
-- (docs/contracts/v2/mqtt-schedule-2.0.md §14). Additiv: eine wahlfreie Spalte, die Migration
-- schreibt keinen Wert — Bestandsläufe bleiben ohne Nummer, keine Bestandszeile ändert sich.
-- Idempotent (IF NOT EXISTS / pg_constraint), damit die Reihenfolge der Ankunft keine Rolle spielt.

ALTER TABLE site_plan_run ADD COLUMN IF NOT EXISTS lauf_nr BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_plan_run_lauf_nr_chk') THEN
        ALTER TABLE site_plan_run ADD CONSTRAINT site_plan_run_lauf_nr_chk
            CHECK (lauf_nr IS NULL OR lauf_nr > 0);
    END IF;
END $$;
