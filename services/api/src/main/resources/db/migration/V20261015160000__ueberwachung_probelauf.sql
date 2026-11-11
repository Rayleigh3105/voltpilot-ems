-- =============================================================================
-- V20261015160000 - Alerting Scheibe 2: 30-Tage-Probelauf
-- -----------------------------------------------------------------------------
-- Konzept vp-alerting-konzept-m1 (§6.1 Leitsatz 9, §6.4, §6.8 Entwurf 1: "die
-- Überwachung zeigt, was sie gemeldet HÄTTE, bevor sie scharf ist"), Brief-Punkt
-- 1 (Nachbesserung 15.10.2026).
--
-- Eine EIGENE Überwachung startet im Probelauf (ueberwachung.probelauf_bis =
-- jetzt + 30 Tage): der Zustandsautomat läuft normal weiter (Dauer, Hysterese,
-- Alarm-Zeilen, Verlauf - derselbe Nachweis wie eine scharfe Regel), aber der
-- Zusteller versendet währenddessen nichts (UeberwachungsService), und jeder
-- in dieser Zeit entstandene Alarm trägt alarm.probelauf = true, damit das
-- Meldungs-Center "hätte gemeldet" von einer echten Meldung unterscheiden
-- kann. NULL = kein Probelauf (ab Werk gesäte Regeln; eine Regel, deren
-- Probelauf vorbei oder von Hand beendet ist).
--
-- Additiv: keine bestehende Spalte, Zeile oder Policy ändert sich.
-- =============================================================================

ALTER TABLE ueberwachung ADD COLUMN IF NOT EXISTS probelauf_bis TIMESTAMPTZ;

ALTER TABLE alarm ADD COLUMN IF NOT EXISTS probelauf BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN ueberwachung.probelauf_bis IS
    'Alerting Scheibe 2 (§6.4, §6.8): bis wann die Regel im Probelauf ist (NULL = scharf). Ausgewertet, aber kein Versand, solange jetzt() davor liegt.';
COMMENT ON COLUMN alarm.probelauf IS
    'Alerting Scheibe 2: true = waehrend des Probelaufs ihrer Regel entstanden ("haette gemeldet"), nie versendet.';
