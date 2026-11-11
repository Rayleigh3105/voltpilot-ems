-- UEMS EZ-16 „Programmstand im Portal“ (Konzept vp-erzeuger-wago-konzept §3.7, §4.10, EW-13 B): der Soll-Stand
-- des VoltPilot-SPS-Programms je Registerbild-Fassung. Das Bild meldet den Ist-Stand im Kopf-Register 7
-- `programmstand` (U16, JJMM: 2610 = Oktober 2026); die api vergleicht beide und meldet „älter als erwartet“.
--
-- Rein additiv: NULL = folgt der VoltPilot-Bibliothek (der Stand steht in der api, `erzeuger/Programmstand`,
-- bis EZ-3 die Bibliothek mit eigenen Releases liefert). Jede vorhandene Fassung bleibt NULL und folgt damit der
-- Bibliothek. Eine Fassung ist unveränderlich (nur gueltig_bis wird gesetzt): ein anderer Soll kommt mit einer
-- neuen Fassung — darum kein neuer UPDATE-Grant.
ALTER TABLE registerbild_fassung ADD COLUMN IF NOT EXISTS programmstand_soll INTEGER;

-- JJMM mit Monat 1 … 12; 0xFFFF ist im Bild die Ungültig-Marke und nie ein Soll.
ALTER TABLE registerbild_fassung DROP CONSTRAINT IF EXISTS registerbild_fassung_programmstand_chk;
ALTER TABLE registerbild_fassung ADD CONSTRAINT registerbild_fassung_programmstand_chk CHECK (
    programmstand_soll IS NULL
    OR (programmstand_soll BETWEEN 1 AND 9912 AND programmstand_soll % 100 BETWEEN 1 AND 12));
