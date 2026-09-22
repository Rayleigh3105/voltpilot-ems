-- AP-15 I1: ausdrücklich keine Einspeisegrenze ist etwas anderes als unbekannt.
-- Bestehende Fassungen bleiben unbekannt, wenn kein Wert eingetragen ist.
-- Tabellenrechte und RLS der Grenzblatt-Tabelle gelten auch für die neue Spalte;
-- UPDATE bleibt auf aufgehoben_am beschränkt, Fassungen werden nie umgeschrieben.
ALTER TABLE netzanschluss_grenze
    ADD COLUMN einspeisegrenze_keine BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT netzanschluss_grenze_keine_oder_wert_chk
        CHECK (NOT einspeisegrenze_keine OR einspeisegrenze_kw IS NULL);
