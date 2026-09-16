-- AP-10 IP-16: Saldo-Fassungen und ihre berechnete Hauptgröße (E1/F9).
-- Kein Bestandsinhalt und keine Rechte ändern sich. Rest bleibt ohne Terme;
-- der Schreibweg prüft die beiden Hauptzähler derselben Anlage zum Gültigkeitstag.
ALTER TABLE messstelle_formel_fassung DROP CONSTRAINT messstelle_formel_fassung_typ_chk;
ALTER TABLE messstelle_formel_fassung ADD CONSTRAINT messstelle_formel_fassung_typ_chk
    CHECK (formel_typ IN ('gewichtete_summe', 'rest', 'saldo'));

-- Der bisherige Katalog bleibt für gemessene Größen und Quellen unverändert.
-- Saldiert ist ausschließlich eine berechnete Energiemenge, nie ein Messkanal.
ALTER TABLE messstelle DROP CONSTRAINT messstelle_hauptgroesse_katalog;
ALTER TABLE messstelle ADD CONSTRAINT messstelle_hauptgroesse_katalog CHECK (
    messstelle_groesse_im_katalog(medium, groesse, richtung, einheit, wertart)
    OR coalesce(art = 'berechnet' AND medium = 'Strom' AND groesse = 'Wirkenergie'
        AND richtung = 'saldiert' AND einheit = 'kWh' AND wertart = 'Intervallmenge', false)
);
