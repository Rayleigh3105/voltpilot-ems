-- =============================================================================
-- UEMS AP-15 Folge zu IP-5 — der TRÄGER von G6 „Signal liegt an“ je Mitglied
-- (Konzept vp-uems-ap15-verbund Regel G6, Matrixzeile A16, Fall R18, Anhang B
-- Z3; Vertrag docs/contracts/v2/steuerungsverbund.md §6).
--
--   steuerungsverbund_mitglied.vorgabe_signal       ja · nein · unbekannt —
--       liegt das Signal des Netzbetreibers (§ 14a u. ä.) an dieser Box an? Der
--       Kundenadministrator erklärt es beim Einrichten (PUT …/gemeinsame-steuerung,
--       IP-23 fragt es ab). Vorgabe `unbekannt`: unbekannt ist keine Null, und
--       G6 zählt es als „liegt nicht an“ (uems/SteuerungsverbundScharfschalten).
--   steuerungsverbund_mitglied.vorgabe_signal_am / _von
--       wann und von wem zuletzt erklärt; NULL = nie erklärt (dann `unbekannt`).
--   steuerungsverbund_aenderung  art + 'vorgabe_signal' (je Änderung ein
--       Eintrag, alt/neu = {box_id, vorgabe_signal}).
--
-- Die andere Hälfte von G6 — „hinter der Box hängen steuerbare Verbraucher nach
-- § 14a“ — hat KEINE Spalte: sie wird aus steuerungsverbund_geraet (IP-7)
-- abgeleitet (uems/SteuerungsverbundNachweiseHeute).
--
-- Das Signal gehört nicht zur Identität des Mitglieds (Box, Rolle, Messpunkt, T6):
-- eine Änderung schreibt die Spalte der offenen Zeile um, statt das Intervall zu
-- beenden — dafür das Spalten-Recht, nie ein Recht auf Box, Rolle, Messpunkt
-- oder Zeitraum.
--
-- ⚠ Der art-CHECK des Protokolls ist die VEREINIGUNG aller Wörter, die bis
-- hierher gebaut sind (IP-4 V20260921140000, IP-13 V20260921230000
-- 'vorbehalt') plus 'vorgabe_signal'. Wer ihn später erweitert, schreibt wieder
-- die Vereinigung — nie nur seinen Stand. Beim Bau (21.09.2026) trug kein
-- anderer offener PR gegen uems einen art-CHECK dieser Tabelle.
--
-- ⚠ REIN ADDITIV: drei Spalten an einer Tabelle, die in Produktion noch leer ist;
-- es wird KEINE Zeile angelegt. Eine Anlage ohne Gemeinsame Steuerung merkt
-- nichts (I6).
-- =============================================================================

ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS vorgabe_signal TEXT NOT NULL DEFAULT 'unbekannt';
ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS vorgabe_signal_am TIMESTAMPTZ;
ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS vorgabe_signal_von TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'steuerungsverbund_mitglied_vorgabe_signal_chk') THEN
        ALTER TABLE steuerungsverbund_mitglied ADD CONSTRAINT steuerungsverbund_mitglied_vorgabe_signal_chk
            CHECK (vorgabe_signal IN ('ja', 'nein', 'unbekannt')
                   AND (vorgabe_signal_am IS NULL) = (vorgabe_signal_von IS NULL)
                   AND (vorgabe_signal_von IS NULL OR btrim(vorgabe_signal_von) <> '')
                   AND (vorgabe_signal = 'unbekannt' OR vorgabe_signal_am IS NOT NULL));
    END IF;
END $$;

GRANT UPDATE (vorgabe_signal, vorgabe_signal_am, vorgabe_signal_von) ON steuerungsverbund_mitglied TO ${appDbUser};

ALTER TABLE steuerungsverbund_aenderung DROP CONSTRAINT IF EXISTS steuerungsverbund_aenderung_art_chk;
ALTER TABLE steuerungsverbund_aenderung ADD CONSTRAINT steuerungsverbund_aenderung_art_chk
    CHECK (art IN ('eingerichtet', 'stufe', 'epoche', 'mitglied', 'anlage_entfernt', 'vorbehalt', 'vorgabe_signal'));

COMMENT ON COLUMN steuerungsverbund_mitglied.vorgabe_signal IS
    'UEMS AP-15 G6: liegt das Signal des Netzbetreibers (Paragraf 14a) an dieser Box an - ja, nein, unbekannt (Vorgabe; zaehlt als nein).';
