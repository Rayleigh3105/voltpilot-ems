-- Der bewusste HALT des Box-Appliers (Befund L1, Scout vp-portal-box-spiegel-s2).
--
-- Bis hierher kannte diese Tabelle genau zwei Antworten auf „was ist mit der
-- neuesten Push-Revision passiert?": angewandt (applied_revision) oder nicht
-- gekonnt (refused_revision). Es gibt aber eine DRITTE, und sie ist der
-- Normalfall, sobald ein Kunde seine letzte verbundene Komponente löscht: die
-- Box hat die Revision GESEHEN, bewusst nichts angewandt und behält ihren
-- laufenden Stand. Ohne eigene Spalten rechnete das Portal Soll != Ist und
-- sagte dauerhaft „Änderung unterwegs zur Box" - über einen Push, der längst
-- beantwortet ist.
--
-- ⚠ Ein DRITTES Spaltenpaar, kein umgedeutetes: `applied_revision` bleibt „was
-- diese Box wirklich fährt" (ein Halt hat nichts angewandt) und `refused_*`
-- bleibt „was sie NICHT KONNTE". Ein Halt ist weder das eine noch das andere -
-- ihn in einen der beiden Kanäle zu pressen hieße, entweder einen Stand zu
-- behaupten, den niemand fährt, oder einen Fehler zu melden, den es nicht gibt.
--
-- Rein ADDITIV: nullbar ohne Default. NULL heißt „die Box hat keinen Halt
-- gemeldet" - eine ältere Box sendet die Felder gar nicht, und daraus darf
-- weder ein Halt noch dessen Gegenteil folgen. Bestehende Zeilen sind
-- unberührt, RLS/Grants der Tabelle decken die neuen Spalten mit ab.

ALTER TABLE device_component_apply
    ADD COLUMN IF NOT EXISTS held_revision TEXT,
    ADD COLUMN IF NOT EXISTS held_reason   TEXT;

COMMENT ON COLUMN device_component_apply.held_revision IS
    'Die letzte Revision, die die Box GESEHEN und bewusst NICHT angewandt hat '
    '(sie behält ihren laufenden Stand). NULL = kein Halt gemeldet.';
COMMENT ON COLUMN device_component_apply.held_reason IS
    'Der deutsche Grund des Halts, wörtlich von der Box durchgereicht.';
