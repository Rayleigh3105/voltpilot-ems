-- =============================================================================
-- UEMS AP-08 IP-4 — ein Bruch, der SPÄTER eingeht, rechnet die Periode neu
-- =============================================================================
-- Die Arbeitslisten der Viertelstunde (V20260912170000) und des Tages
-- (V20260912190000) füllen sich aus dem, was EINGEHT: Rohwerte (Viertelstunde)
-- und neu gebildete Viertelstunden (Tag). Eine Gerätegrenze trägt der Kunde aber
-- oft Stunden nach dem Wechsel ein (Referenz 18.11.2026: Wechsel 10:40,
-- eingetragen 11:05), ein Neustart kommt als eigene Meldung — die Rohwerte
-- dieser Viertelstunden sind längst verdichtet. Ohne einen Eintrag bliebe die
-- VORLÄUFIGE Periode bei „Rücksetzung“ bzw. „ohne Neustart“ stehen, bis ein
-- zufälliger Nachzügler sie neu bildet.
--
-- Darum ein dritter Grund `ereignis`: der Lauf trägt die Viertelstunden und
-- Tage ein, die ein seit dem Zeiger eingegangenes `device_boundary`,
-- `device_restart` oder `counter_overflow` betrifft — im selben Zeiger-Fenster
-- und in derselben Transaktion wie die Rohwerte. Eine ENDGÜLTIGE Zeile rührt die
-- Neubildung trotzdem nie an (der Schreibsatz schließt sie aus, AP-07 E5); der
-- Nachtrag nach der Endgültigkeit ist ein Vorschlag (AP-08 IP-14), nicht hier.
--
-- ADDITIV: beide CHECKs werden zur Obermenge; keine vorhandene Zeile wird
-- ungültig. Die Tabellen sind gewöhnliche Tabellen (keine Hypertables).

ALTER TABLE messreihe_viertelstunde_arbeit DROP CONSTRAINT IF EXISTS messreihe_viertelstunde_arbeit_grund_chk;
ALTER TABLE messreihe_viertelstunde_arbeit ADD CONSTRAINT messreihe_viertelstunde_arbeit_grund_chk
    CHECK (grund IN ('eingang', 'rueckrechnung', 'ereignis'));

ALTER TABLE messreihe_tag_arbeit DROP CONSTRAINT IF EXISTS messreihe_tag_arbeit_grund_chk;
ALTER TABLE messreihe_tag_arbeit ADD CONSTRAINT messreihe_tag_arbeit_grund_chk
    CHECK (grund IN ('viertelstunde', 'frist', 'rueckrechnung', 'ereignis'));

COMMENT ON CONSTRAINT messreihe_viertelstunde_arbeit_grund_chk ON messreihe_viertelstunde_arbeit IS
    'eingang = ein Rohwert ist eingetroffen; rueckrechnung = die einmalige Rueckrechnung; '
    'ereignis = ein spaeter eingegangener Bruch (device_boundary, device_restart, counter_overflow), AP-08 IP-4.';
COMMENT ON CONSTRAINT messreihe_tag_arbeit_grund_chk ON messreihe_tag_arbeit IS
    'viertelstunde = eine Viertelstunde des UTC-Tages wurde neu gebildet; frist; rueckrechnung; '
    'ereignis = ein spaeter eingegangener Bruch (AP-08 IP-4).';
