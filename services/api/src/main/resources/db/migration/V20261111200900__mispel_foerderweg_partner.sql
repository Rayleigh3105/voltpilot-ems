-- MiSpeL MP-17: der Partner der Direktvermarktung als Angabe der Förderweg-Fassung
-- (Vertrag docs/contracts/v2/mispel-foerderweg.md Fassung 1.2, § 4).
--
-- Die Abgrenzungs- und die Pauschaloption setzen eine Direktvermarktung voraus,
-- deren ganze Einspeisung in einem gesonderten Bilanzkreis geführt wird (§ 20 S. 2
-- EEG; Fundament § 2.1). Die Portal-Einrichtung (MP-17, BK-17 Variante A, Schritt
-- „Partner“) fragt beides ab:
--   direktvermarkter       Name des eigenen Direktvermarkters, 1–200 Zeichen
--   bilanzkreis_gesondert  der Direktvermarkter führt die ganze Einspeisung in
--                          einem eigenen Bilanzkreis (Angabe des Kunden)
-- Beides wahlfrei (NULL = nicht erhoben) und nur an einem Weg der
-- Direktvermarktung — die Einspeisevergütung zahlt der Netzbetreiber.
--
-- BESTAND: nur zwei neue, leere Spalten. Jede vorhandene Fassung behält NULL —
-- ihr Verhalten ändert sich nicht. Keine Bestandszeile wird geschrieben.

ALTER TABLE site_foerderweg ADD COLUMN IF NOT EXISTS direktvermarkter TEXT;
ALTER TABLE site_foerderweg ADD COLUMN IF NOT EXISTS bilanzkreis_gesondert BOOLEAN;

ALTER TABLE site_foerderweg DROP CONSTRAINT IF EXISTS site_foerderweg_partner_chk;
ALTER TABLE site_foerderweg ADD CONSTRAINT site_foerderweg_partner_chk CHECK (
    (direktvermarkter IS NULL OR (char_length(direktvermarkter) BETWEEN 1 AND 200
                                  AND direktvermarkter = btrim(direktvermarkter)))
    AND ((direktvermarkter IS NULL AND bilanzkreis_gesondert IS NULL) OR foerderweg <> 'einspeiseverguetung'));

-- Die App-Rolle hängt Fassungen an (GRANT INSERT aus V20261002141500 gilt für
-- die ganze Tabelle, also auch für die neuen Spalten) und darf weiter nur
-- aufgehoben_am setzen: eine Fassung wird nie umgeschrieben.

COMMENT ON COLUMN site_foerderweg.direktvermarkter IS
    'MiSpeL MP-17: Name des eigenen Direktvermarkters (Schritt „Partner“ der Einrichtung); NULL = nicht erhoben.';
COMMENT ON COLUMN site_foerderweg.bilanzkreis_gesondert IS
    'MiSpeL MP-17: die ganze Einspeisung in einem gesonderten Bilanzkreis (§ 20 S. 2 EEG), Angabe des Kunden; NULL = nicht erhoben.';
