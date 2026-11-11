-- =============================================================================
-- Box verbinden S4 ("Andere Kennung", Konzept vp-box-verbinden-konzept, Bauschnitt 7.1,
-- E4 = A; Konzept vp-plattform-admin-box-benutzer-konzept, Abschnitt 3.5): eine nie gemeldete
-- Box austauschen, während die richtige verbunden wird (geloest_art = 'kunde', schon erlaubt).
--
-- Der Anlass dieses Wegs ist kein admin-gewählter Grund ("Falsche Kennung verbunden" bleibt dem
-- Admin-Formular vorbehalten, V20261110090000): er entsteht automatisch beim Verbinden selbst, nie
-- aus einer Auswahl. Ein eigenes Wort hält ihn in der Kundenakte von den vier admin-gewählten
-- Gründen unterschieden (BoxLoesenService.ANLAESSE prüft weiterhin nur diese vier - der Admin kann
-- 'andere_kennung' nicht wählen, nur DeviceController.claim schreibt ihn).
--
-- Additiv (W1): die drei bestehenden Migrationen bleiben unverändert; DROP/ADD CONSTRAINT in EINER
-- Anweisung, das ADD validiert gegen den Bestand - jede bestehende Zeile erfüllt den alten CHECK
-- und damit den neuen. Kein Bestandswert ändert sich.
-- =============================================================================

ALTER TABLE box_loesen_protokoll
    DROP CONSTRAINT box_loesen_protokoll_anlass_chk,
    ADD CONSTRAINT box_loesen_protokoll_anlass_chk
        CHECK (anlass IN ('falsche_kennung', 'fremder_kunde', 'doppelt_verbunden', 'anderer_anlass', 'andere_kennung'));
