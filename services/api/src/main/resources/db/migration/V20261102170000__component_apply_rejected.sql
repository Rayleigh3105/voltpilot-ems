-- Die Geräte, die die Box beim Anwenden ÜBERSPRUNGEN hat (Herzschlag
-- component_apply.rejected_components).
--
-- Bis hierher verwarf die Box einen ganzen Push, sobald sie EINEM Gerät keine
-- Rolle zuordnen konnte - am VoltPilotGATE (02.11.2026) blieben so Hauslast und
-- Netzzähler unangewandt, weil drei Shelly-Ausgänge als Messgeräte ohne Rolle
-- angelegt waren. Jetzt wendet sie alles andere an und meldet genau diese
-- Geräte einzeln, mit Kennung und deutschem Grund. Das Portal zeigt den Grund
-- am jeweiligen Gerät.
--
-- Die Liste gehört zu dem Stand, den die Zeile beschreibt: zur angewandten
-- Revision, vor der ersten Anwendung zur gehaltenen. Sie ist eine eigene
-- Spalte, kein umgedeutetes refused_reason - die Revision ist ja angewandt,
-- nur ohne diese Geräte.
--
-- Rein ADDITIV: nullbar ohne Default. NULL heißt „die Box hat nichts
-- übersprungen" (oder meldet das Feld als ältere Box nicht). Bestehende Zeilen
-- sind unberührt, RLS/Grants der Tabelle decken die neue Spalte mit ab.

ALTER TABLE device_component_apply
    ADD COLUMN IF NOT EXISTS rejected_components JSONB;

COMMENT ON COLUMN device_component_apply.rejected_components IS
    'Die Geräte, die die Box beim Anwenden übersprungen hat: '
    '[{"entity_id": "...", "reason": "..."}], wörtlich von der Box. NULL = keines.';
