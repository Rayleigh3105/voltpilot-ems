-- MiSpeL MP-32: die Formelsätze A2, A3 und A4 — Basisfälle mit Ladepunkt
-- (Anlage 1 S. 29–32, Abschn. 4.1.2–4.1.4) — im Förderweg und im Monatslauf.
--
-- Beide CHECKs tragen das geschlossene Vokabular der Formelsätze; der Vertrag
-- docs/contracts/v2/mispel-abgrenzung.md nimmt A2–A4 mit MP-32 auf
-- (FoerderwegRegeln.FORMELSAETZE, MispelAbgrenzungRechenwerk.FORMELSAETZE).
-- Nur eine Erweiterung: die neue Liste ist die Vereinigung mit der alten, keine
-- Zeile ändert sich und keine wird ungültig. A6–A9 bleiben ausgeschlossen
-- (E5 = B, erst wenn ein Kunde sie braucht).

ALTER TABLE site_foerderweg DROP CONSTRAINT IF EXISTS site_foerderweg_formelsatz_chk;
ALTER TABLE site_foerderweg ADD CONSTRAINT site_foerderweg_formelsatz_chk
    CHECK (formelsatz IS NULL OR formelsatz IN ('A1', 'A2', 'A3', 'A4', 'A5', 'A5-Variante', 'A10', 'A11'));

ALTER TABLE mispel_abgrenzung_monat DROP CONSTRAINT IF EXISTS mispel_abgrenzung_monat_formelsatz_chk;
ALTER TABLE mispel_abgrenzung_monat ADD CONSTRAINT mispel_abgrenzung_monat_formelsatz_chk
    CHECK (formelsatz IN ('A1', 'A2', 'A3', 'A4', 'A5', 'A5-Variante', 'A10', 'A11'));
