-- =============================================================================
-- UEMS AP-15 IP-5 — „Mitglied bestätigen“ an der Gemeinsamen Steuerung
-- (Konzept vp-uems-ap15-verbund §4.9 I4, §5.7 Box-Tausch R17; Vertrag
-- docs/contracts/v2/steuerungsverbund.md §6).
--
--   steuerungsverbund_mitglied.bestaetigt_am / bestaetigt_von
--       wann und von wem der Betreiber das Mitglied bestätigt hat. NULL = noch
--       nicht bestätigt: eine Nachfolgerin nach dem Box-Tausch bekommt erst nach
--       der Bestätigung wieder einen Plan (IP-15 liest die Spalte). Das
--       Scharfschalten bestätigt alle Mitglieder, die es prüft.
--
-- Nur die Plattform-Rolle schreibt die Spalten (Route unter /api/v1/admin, I4/I5);
-- die Laufzeitrolle der API bekommt dafür ein Spalten-Recht wie für gesendet/
-- quittiert — nie ein Recht auf Box, Rolle, Messpunkt oder Zeitraum.
--
-- ⚠ REIN ADDITIV: zwei wahlfreie Spalten an einer Tabelle, die in Produktion noch
-- leer ist (IP-4, V20260921140000); keine Bestandszeile ändert sich, es wird
-- KEINE Zeile angelegt. Eine Anlage ohne Gemeinsame Steuerung merkt nichts (I6).
-- =============================================================================

ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS bestaetigt_am TIMESTAMPTZ;
ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS bestaetigt_von TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'steuerungsverbund_mitglied_bestaetigt_chk') THEN
        ALTER TABLE steuerungsverbund_mitglied ADD CONSTRAINT steuerungsverbund_mitglied_bestaetigt_chk
            CHECK ((bestaetigt_am IS NULL) = (bestaetigt_von IS NULL)
                   AND (bestaetigt_von IS NULL OR btrim(bestaetigt_von) <> ''));
    END IF;
END $$;

GRANT UPDATE (bestaetigt_am, bestaetigt_von) ON steuerungsverbund_mitglied TO ${appDbUser};

COMMENT ON COLUMN steuerungsverbund_mitglied.bestaetigt_am IS
    'UEMS AP-15 IP-5: vom Betreiber bestaetigt (Scharfschalten oder Mitglied bestaetigen nach Box-Tausch); NULL = noch nicht.';
