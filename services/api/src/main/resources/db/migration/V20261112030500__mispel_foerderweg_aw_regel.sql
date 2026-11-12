-- MiSpeL MP-12b: die AW-Differenzierung als Stammdatum am Förderweg
-- (Vertrag docs/contracts/v2/mispel-foerderweg.md Fassung 1.1, § 7).
--
-- Die Marktprämie wird in der Abgrenzungs- und der Pauschaloption nur für die
-- Netzeinspeisung in AW>0-Zeiten gezahlt: Formel (24)¼ = WENN [ AW¼ > 0 ; 1 ; 0 ]
-- (Anlage 1 S. 17 und S. 38; (P12)¼ Anlage 2 S. 31). „In welchen Viertelstunden
-- sich der anzulegende Wert nach den verschiedenen gesetzlichen Differenzierungen
-- aufgrund von negativen (bzw. schwach positiven) Spotmarktpreisen auf null
-- verringert, veröffentlichen die Übertragungsnetzbetreiber“ (Anlage 1 S. 17
-- Fn. 8) — in eeg_aw_zeit je regel (MP-7, V20261002110000). Welche dieser
-- Veröffentlichungen für die Anlage gilt, trägt der Betreiber hier ein:
--   viertelstunde      „1 Viertelstunde“ (§ 51 EEG)
--   viertelstunde_2ct  „2ct Logik“ (§ 51b EEG, Biogas; Anlage 1 S. 17 Fn. 7)
--   stunden_1 … stunden_6  „1/2/3/4/6 Stunden“ (§ 51 EEG in früheren Fassungen)
-- Dasselbe geschlossene Vokabular wie der CHECK von eeg_aw_zeit.regel.
--
-- KEINE ABLEITUNG: VoltPilot schließt die Regel nicht aus Inbetriebnahme oder
-- Leistung; ohne Eintrag (NULL) rechnen Optimierer und Erlöse wie bisher den
-- W4-Rückfall „AW¼ = 0 bei SP¼ < 0“, und die Marktprämie bleibt vorläufig.
--
-- BESTAND: nur eine neue, leere Spalte. Jede vorhandene Fassung behält NULL —
-- ihr Verhalten ändert sich nicht. Keine Bestandszeile wird geschrieben.
--
-- Nur an einer MiSpeL-Option (Abgrenzung, Pauschal): die anderen Förderwege
-- rechnen die Prämie nicht nach den Formelsätzen (24)/(P12).

ALTER TABLE site_foerderweg ADD COLUMN IF NOT EXISTS aw_regel TEXT;

ALTER TABLE site_foerderweg DROP CONSTRAINT IF EXISTS site_foerderweg_aw_regel_chk;
ALTER TABLE site_foerderweg ADD CONSTRAINT site_foerderweg_aw_regel_chk CHECK (aw_regel IS NULL OR (
    aw_regel IN ('viertelstunde', 'viertelstunde_2ct',
                 'stunden_1', 'stunden_2', 'stunden_3', 'stunden_4', 'stunden_6')
    AND foerderweg IN ('marktpraemie_abgrenzung', 'marktpraemie_pauschal')));

-- Die App-Rolle hängt Fassungen an (GRANT INSERT aus V20261002141500 gilt für
-- die ganze Tabelle, also auch für die neue Spalte) und darf weiter nur
-- aufgehoben_am setzen: eine Fassung wird nie umgeschrieben.

COMMENT ON COLUMN site_foerderweg.aw_regel IS
    'MiSpeL MP-12b: AW-Differenzierung der Anlage = die ÜNB-Veröffentlichung (eeg_aw_zeit.regel, Anlage 1 S. 17 Fn. 8); NULL = kein Stammdatum, W4-Rückfall, vorläufig.';
