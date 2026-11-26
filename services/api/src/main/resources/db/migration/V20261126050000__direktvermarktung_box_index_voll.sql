-- Löschzug-Index-Deckung (vorgefunden beim Bau des Zugangsdatei-Auftrags, unabhängig davon):
-- idx_direktvermarktung_box (V20261125200000) ist ein TEIL-Index (WHERE box_id IS NOT NULL) - die
-- RI-Prüfung des Löschzugs (direktvermarktung.box_id -> device.id, ON DELETE SET NULL) braucht einen
-- VOLLEN, führenden Index auf der Kindseite, sonst ist jede gelöschte Box ein Seq-Scan über
-- direktvermarktung aller Mandanten (Muster LoeschzugIndexdeckungTest, Befund vp-kunde-loeschen-504).
DROP INDEX IF EXISTS idx_direktvermarktung_box;
CREATE INDEX IF NOT EXISTS idx_direktvermarktung_box ON direktvermarktung (box_id);
