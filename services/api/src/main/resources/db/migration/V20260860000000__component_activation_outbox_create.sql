-- L9 (Scout `vp-portal-box-spiegel-s2` §4): das ANLEGEN einer Komponente laeuft
-- seither denselben Outbox-Weg wie Bearbeiten und Rollback - Push NACH dem
-- Commit, mit Wiederholung. Dafuer braucht `operation` sein drittes Wort.
--
-- ⚠ Der CHECK wird geweitet, indem der AKTUELLE Stand abgeschrieben und um EIN
-- Wort ergaenzt wird (Haus-Regel, siehe `consumer_audit_event`): wer stattdessen
-- die Liste der Ur-Migration kopiert, entfernt lautlos jedes Wort, das seither
-- dazugekommen ist. Stand hier: V20260843000000 (`component_edit`,
-- `component_rollback`), seither unveraendert.
--
-- Der Name der alten Bedingung ist WISSBAR, nicht geraten: die Tabelle entsteht
-- ausschliesslich in V20260843000000, dort steht der CHECK inline an der Spalte
-- `operation` ohne eigenen Namen, und Postgres vergibt dafuer
-- `<tabelle>_<spalte>_check`. Eine angewandte Migration wird nie geaendert, also
-- kann sich das nicht mehr verschieben.
ALTER TABLE component_activation_outbox
    DROP CONSTRAINT IF EXISTS component_activation_outbox_operation_check;
ALTER TABLE component_activation_outbox
    ADD CONSTRAINT component_activation_outbox_operation_check
    CHECK (operation IN ('component_create', 'component_edit', 'component_rollback'));
