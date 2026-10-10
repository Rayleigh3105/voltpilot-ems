-- UEMS AP-07 IP-18b Punktzustand: ein geteilter Punkt (derselbe point_key für zwei Komponenten,
-- jede mit ihrer entity_id am Sample) führt den Punktzustand der Box weiter, statt ihn stehen zu
-- lassen. Der Writer schreibt die letzte Beobachtung über alle Komponenten in dieselbe Zeile und
-- setzt dazu diese Messzeit: component_read_at = last_read_at heißt „die letzte Beobachtung
-- nannte eine Komponente". Ihr Wert gehört dann EINER Komponente; die Geräteseite zeigt ihn nicht
-- als Wert der Box (Box-Verlauf nur edge_entity_id IS NULL, Entscheid firstmate 22.09.2026).
-- Ein späterer Wert ohne Komponente rückt last_read_at weiter und hebt das Kennzeichen damit auf,
-- ohne die Spalte zu nennen - die Anweisung eines heutigen Punkts bleibt Zeichen für Zeichen die
-- bisherige.
--
-- Nur eine Spalte, NULL für jede Bestandszeile, keine Zeile wird umgeschrieben. Die Löschwege
-- (uems_messwerte_der_anlage_entfernen, uems_messwerte_des_kundenbereichs_entfernen, CASCADE über
-- Gerät und Anlage) nehmen die ganze Zeile mit und brauchen deshalb nichts Neues.
ALTER TABLE device_measurement_point_state
    ADD COLUMN IF NOT EXISTS component_read_at TIMESTAMPTZ;

COMMENT ON COLUMN device_measurement_point_state.component_read_at IS
    'Messzeit der letzten Beobachtung mit Komponente (geteilter Punkt, AP-07 IP-18b); gleich last_read_at: der Wert gehört einer Komponente, nicht der Box.';
