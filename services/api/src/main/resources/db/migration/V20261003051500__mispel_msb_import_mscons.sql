-- MiSpeL MP-15b: Werte des Messstellenbetreibers auch im EDIFACT-Format MSCONS
-- (Vertrag docs/contracts/v2/mispel-abgrenzung.md, Abschnitt „Werte des Messstellenbetreibers“).
--
-- Dieselbe Ablage wie die CSV aus MP-15 (V20261003015500): ein Import je Datei, die Werte je Zählpunkt,
-- Richtung und Viertelstunde. Neu ist nur das Format der Datei; der CHECK wird um 'mscons' erweitert.
-- Keine Bestandszeile ändert sich (bisher steht dort nur 'csv').

ALTER TABLE mispel_msb_import DROP CONSTRAINT IF EXISTS mispel_msb_import_format_chk;
ALTER TABLE mispel_msb_import ADD CONSTRAINT mispel_msb_import_format_chk CHECK (format IN ('csv', 'mscons'));
