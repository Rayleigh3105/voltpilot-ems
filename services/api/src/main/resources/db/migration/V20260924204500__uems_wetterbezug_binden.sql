-- AP-17 IP-12c (E9 = C): der Kunde bindet eine Gradtagzahl selbst an das Wetter-Archiv
-- (PUT/DELETE /api/v1/bezugsgroessen/{id}/wetterbezug) — bis hier ging das nur per SQL.
-- Additiv: keine Tabelle, keine Spalte, keine Bestandszeile ändert sich.
--
-- 1. Lösen löscht die eine Zeile in `bezugsgroesse_wetterbezug` (die Tabelle kennt kein Ende und kein
--    UPDATE). Die bezogenen Werte bleiben; RLS (FORCE) hält den Löschweg im eigenen Kundenbereich.
-- 2. Das Änderungsprotokoll der Bezugsgröße nennt Binden und Lösen: die Vereinigung aus
--    V20260917100000 (dem letzten Stand dieses CHECKs) und den zwei neuen Wörtern.

GRANT DELETE ON bezugsgroesse_wetterbezug TO ${appDbUser};

ALTER TABLE bezugsgroesse_aenderung DROP CONSTRAINT bezugsgroesse_aenderung_art_chk;
ALTER TABLE bezugsgroesse_aenderung ADD CONSTRAINT bezugsgroesse_aenderung_art_chk CHECK
    (art IN ('angelegt','bearbeitet','archiviert','geloescht','stammdatum_eingetragen','kanal_gebunden','kanal_beendet',
             'wetter_gebunden','wetter_geloest'));
