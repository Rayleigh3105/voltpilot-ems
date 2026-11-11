-- =============================================================================
-- V20261109120000 - Werkstatt-Auftrag: „gehaeuse“ als zweite Art.
-- -----------------------------------------------------------------------------
-- vp-mango-3mf-pro-box, automatisch nachholen: „Erneut erstellen“ für die
-- Box-Druckdatei (Gehäuse, P10) von der Werkstatt-Box-Seite im Portal. Der
-- Auftrag nutzt dieselbe Tabelle wie „Nochmal versuchen“ (V20261105200000):
-- die Spalte lauf trägt hier die Edge-Referenz statt einer Lauf-Kennung, ihre
-- Form (edge-xxxxxxx) passt zur bestehenden CHECK-Erweiterung. Additiv: die
-- Spalten, Rechte und RLS bleiben unverändert, nur die erlaubten Werte von
-- art wachsen.
-- =============================================================================

ALTER TABLE werkstatt_auftrag DROP CONSTRAINT werkstatt_auftrag_art_chk;
ALTER TABLE werkstatt_auftrag ADD CONSTRAINT werkstatt_auftrag_art_chk CHECK (art IN ('nochmal', 'gehaeuse'));
