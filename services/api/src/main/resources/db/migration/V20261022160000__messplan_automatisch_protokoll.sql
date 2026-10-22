-- UEMS EZ-18 „Messplan automatisch“: nach „Steuerung verbinden“ wählt die Cloud die Punkte des Erzeuger-
-- Registerbilds selbst für die zuständige Box aus (beim Anlegen und, für schon angelegte Steuerungen, im Takt
-- des Mess-Abgleichs). Das Protokoll der Datenquelle nennt das Ergebnis: wie viele Punkte gewählt, welche wegen
-- des Messwertbudgets ausgelassen wurden — nie still nichts.
--
-- Nur das Vokabular von data_source_aenderung.art wächst um `messwerte_ausgewaehlt`; der CHECK baut auf dem
-- Stand von V20260917109000 auf. Kein Bestand ändert sich.

ALTER TABLE data_source_aenderung
    DROP CONSTRAINT data_source_aenderung_art_chk;
ALTER TABLE data_source_aenderung
    ADD CONSTRAINT data_source_aenderung_art_chk CHECK (art IN (
        'angelegt', 'bearbeitet', 'erreichbarkeit_geprueft', 'zustaendigkeit_begonnen',
        'zustaendigkeit_gewechselt', 'zustaendigkeit_zurueckgenommen',
        'aus_bestand_uebernommen', 'messwerte_ausgewaehlt'));
