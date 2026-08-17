-- Einheitsmodell Stufe 4: „Steuern freigeben".
--
-- Diese Migration legt KEINE neue Tabelle an, und das ist die Aussage: die
-- Schalt-Definition samt Freigabe wohnt in `measurement_point.connection_json`
-- - derselben EINEN Wahrheit je Gerät, die seit Stufe 3 auch den Leseplan
-- traegt (k6 §2.2). Ein zweiter Speicher fuer den Schalter waere ein zweiter
-- Ort, an dem eine Komponente etwas ueber sich behaupten kann, und die Fassungs-
-- Historie in `component_definition` traegt die Freigabe dadurch ohne Zutun mit:
-- „was war am 3. freigegeben" ist eine Frage an die Fassung, nicht an ein Feld.
--
-- Was hier WIRKLICH gebraucht wird, ist die Papier-Spur. `consumer_audit_event`
-- existiert seit Inkrement 4 und beantwortet „wer hat was wann getan"; sein
-- CHECK kennt die drei Schalt-Ereignisse noch nicht.
--
-- ⚠ Eine angewandte Migration ist unveraenderlich, ein CHECK wird deshalb
-- fallengelassen und neu gesetzt (das V20260813010000-Muster). Der Name ist der
-- von Postgres automatisch vergebene.
ALTER TABLE consumer_audit_event
    DROP CONSTRAINT IF EXISTS consumer_audit_event_event_type_check;

ALTER TABLE consumer_audit_event
    ADD CONSTRAINT consumer_audit_event_event_type_check
    CHECK (event_type IN ('policy_saved', 'policy_activated', 'policy_deactivated',
                          'paused', 'resumed', 'override_started', 'override_stopped',
                          'override_cleared',
                          -- Einheitsmodell Stufe 4: die Geraete-Freigabe.
                          -- `switch_tested` wird bewusst MITGESCHRIEBEN, nicht nur
                          -- die Freigabe selbst: ein Schalt-Test schreibt an einer
                          -- Kundenanlage ein Register, und ein Schreibvorgang ohne
                          -- Spur ist genau das, was eine Freigabe glaubwuerdig
                          -- machen soll.
                          'switch_tested', 'switch_released', 'switch_revoked'));
