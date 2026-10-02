-- MiSpeL MP-29: der MiSpeL-Check rechnet auch die Pauschaloption (Anlage 2 der Festlegung, Basisfall P1
-- „Stromspeicher“, A2 Abschn. 4.1.1 S. 25). Ihr Formelsatz steht in site_mispel_check.formelsatz; der CHECK
-- kannte bisher nur die Formelsätze der Anlage 1 (V20261002234100). Additiv: die VEREINIGUNG aus dem
-- bisherigen Vokabular und den Formelsätzen der Anlage 2 (wie mispel_pauschal_jahr, V20261002191500).
-- Keine Zeile ändert sich; idempotent (DROP IF EXISTS + ADD), in jeder Merge-Reihenfolge nach V20261002234100.
ALTER TABLE site_mispel_check DROP CONSTRAINT IF EXISTS site_mispel_check_formelsatz_chk;
ALTER TABLE site_mispel_check ADD CONSTRAINT site_mispel_check_formelsatz_chk
    CHECK (formelsatz IS NULL OR formelsatz IN ('A1', 'A2', 'A3', 'A4', 'A5', 'A5-Variante', 'A10', 'A11',
                                                'P1', 'P2', 'P3', 'P4', 'P4-Variante', 'P5'));

COMMENT ON TABLE site_mispel_check IS
    'MiSpeL MP-48/MP-29: letzter Stand des MiSpeL-Checks je Anlage (heute gegen Abgrenzungs- oder Pauschaloption); ohne Zeile = wird gerechnet. Vertrag docs/contracts/v2/mispel-check.md.';
