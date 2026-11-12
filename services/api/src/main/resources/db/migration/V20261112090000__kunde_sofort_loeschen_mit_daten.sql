-- Kunde sofort löschen, auch mit Daten (vp-kunde-sofort-loeschen-mit-daten; Captain 12.11.2026: die
-- Frist nach Vertragsende sperrt das Löschen nicht mehr - der Plattform-Admin löscht jeden Kunden
-- sofort endgültig, mit oder ohne Datenbestand, aktiv oder beendet). Der neue Anlass
-- 'sofort_mit_daten' bekommt dieselbe Freiheit wie 'sofort_keine_daten' (keine Fristen-Spalten,
-- V20261111210000): nur der alte Anlass 'frist_abgelaufen' (Bestandszeilen; kein neuer Löschzug
-- erzeugt ihn mehr) verlangt sie weiterhin.
ALTER TABLE mandant_loeschnachweis DROP CONSTRAINT mandant_loeschnachweis_frist_chk;
ALTER TABLE mandant_loeschnachweis DROP CONSTRAINT mandant_loeschnachweis_anlass_chk;
ALTER TABLE mandant_loeschnachweis ADD CONSTRAINT mandant_loeschnachweis_anlass_chk
    CHECK (anlass IN ('frist_abgelaufen', 'sofort_keine_daten', 'sofort_mit_daten'));
ALTER TABLE mandant_loeschnachweis ADD CONSTRAINT mandant_loeschnachweis_frist_chk
    CHECK (btrim(geloescht_von) <> ''
           AND ((anlass = 'frist_abgelaufen'
                 AND beendet_am IS NOT NULL AND frist_tage IS NOT NULL AND frist_tage > 0
                 AND loeschung_fruehestens IS NOT NULL AND geloescht_am >= beendet_am)
                OR (anlass IN ('sofort_keine_daten', 'sofort_mit_daten')
                    AND frist_tage IS NULL AND loeschung_fruehestens IS NULL)));

ALTER TABLE kundenbereich_geloescht_protokoll DROP CONSTRAINT kundenbereich_geloescht_anlass_chk;
ALTER TABLE kundenbereich_geloescht_protokoll ADD CONSTRAINT kundenbereich_geloescht_anlass_chk
    CHECK (anlass IN ('frist_abgelaufen', 'sofort_keine_daten', 'sofort_mit_daten'));
