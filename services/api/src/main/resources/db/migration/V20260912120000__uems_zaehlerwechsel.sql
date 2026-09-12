-- UEMS AP-04 IP-17 — Zählerwechsel als EIN Vorgang.
--
-- Der Wechsel braucht KEINE neue Tabelle: er schreibt in die, die schon stehen —
-- `geraet` (Ausbau des alten, Einbau des neuen), `geraet_komponente` (die Speisung
-- wandert), `messstelle_quelle` (die laufende Bindung endet, die neue beginnt),
-- `quelle_einstellung` (übernommene Fassungen am neuen Einbau) und
-- `messstelle_aenderung` (der eine Protokolleintrag). Die Spaltenrechte dafür hat
-- die App-Rolle seit V20260911200000/V20260911250000/V20260911280000.
--
-- Diese Migration weitet deshalb nur ZWEI geschlossene Vokabulare, beide indem sie
-- den AKTUELLEN Stand abschreibt (Hausregel „ein CHECK wird geweitet, indem man den
-- AKTUELLEN Stand abschreibt — nie den der Ur-Migration"):
--
--   1. `messstelle_aenderung.art` um `zaehler_gewechselt` — der eine Eintrag je
--      betroffener Messstelle, mit Urheber und Rückwirkend-Marker. Abgeschrieben
--      wird der Stand von V20260911280000 (IP-11: + einstellung_geaendert).
--   2. `component_change_event.event_type` um `device_replaced` — die MARKE im
--      Komponenten-Verlauf (§5.5 „Verlauf der Komponente mit Marke ‚Zähler
--      gewechselt'"). Sie ist additiv und ein ZEITPUNKT, nie ein Auftrag zur
--      rückwirkenden Neuberechnung (derselbe Satz wie für `family_changed`,
--      V20260843000000). Der Verlauf der Messwerte liest weiter NUR
--      `family_changed` (MeasurementHistoryService) — die neue Art ändert dort
--      zeichengleich nichts.
--
-- Nicht diese Migration: der Controllerwechsel mit seinen Karten (IP-19), das
-- Änderungsprotokoll am Gerät `geraet_aenderung` (IP-21).

-- -----------------------------------------------------------------------------
-- 1. Das Protokoll an der Messstelle kennt den Zählerwechsel
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_aenderung DROP CONSTRAINT IF EXISTS messstelle_aenderung_art_chk;
ALTER TABLE messstelle_aenderung ADD CONSTRAINT messstelle_aenderung_art_chk CHECK (art IN (
    'angelegt', 'bearbeitet', 'angehalten', 'fortgesetzt', 'archiviert',
    'nebengroesse_hinzugefuegt', 'nebengroesse_archiviert',
    'ort_zugeordnet', 'ort_korrigiert', 'stellung_zugeordnet', 'stellung_korrigiert',
    'quelle_gebunden', 'quelle_beendet',
    'einstellung_geaendert',
    'zaehler_gewechselt'));

-- -----------------------------------------------------------------------------
-- 2. Die Marke im Komponenten-Verlauf
-- -----------------------------------------------------------------------------
ALTER TABLE component_change_event DROP CONSTRAINT IF EXISTS component_change_event_event_type_check;
ALTER TABLE component_change_event ADD CONSTRAINT component_change_event_event_type_check
    CHECK (event_type IN ('edited', 'family_changed', 'rolled_back', 'device_replaced'));
