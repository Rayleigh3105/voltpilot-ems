-- =============================================================================
-- V20260830000000 - Der Ladepunkt-Strom des Kommando-Verlaufs (Stufe 3).
-- -----------------------------------------------------------------------------
-- Die Befehle-Seite zeigt je Schreibweg einen STROM (Kommando-Transparenz V1).
-- Seit Lastmanagement Stufe 3 gibt es einen weiteren: das OCPP-Ladeprofil, das
-- die Box einer Ladesäule hinterlegt. Ohne ihn müsste die Seite sagen
-- „Ladevorgänge erscheinen hier nicht" - genau die Lücke, gegen die es die
-- Seite gibt.
--
-- Es entsteht KEINE Tabelle: der Verlauf wohnt weiter in device_command_log,
-- diese Migration weitet nur sein Vokabular (dieselbe Form wie die Erweiterung
-- des consumer_audit_event-CHECKs in V20260821000000).
-- =============================================================================

ALTER TABLE device_command_log DROP CONSTRAINT IF EXISTS device_command_log_stream_chk;
ALTER TABLE device_command_log ADD CONSTRAINT device_command_log_stream_chk
    CHECK (stream IN ('batterie', 'abregelung', 'verbraucher', 'waechter', 'ladepunkt'));
