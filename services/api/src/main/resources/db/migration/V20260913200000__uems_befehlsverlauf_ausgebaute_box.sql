-- =============================================================================
-- UEMS AP-07 IP-11 Folgepaket — offene Perioden des Befehlsverlaufs einer Box,
-- die nicht mehr am Betrieb teilnimmt, werden BEENDET (nie gelöscht).
--
-- device_command_log hat keinen Fremdschlüssel auf device. Das Abmelden hat die
-- Zeilen einer Box darum nie geräumt — und eine offene Periode
-- (kind = 'periode', ended_at IS NULL) schließt nur der nächste Herzschlag
-- DERSELBEN Box. Nach dem Abmelden kommt keiner mehr: im Befehlsverlauf „lief"
-- die letzte Anweisung der alten Box seitdem für immer, und das Aufräumen
-- (CommandLogRepository.prune) nimmt eine offene Periode nie. Das ist ein
-- bestehender Mangel, keine Folge von IP-11.
--
-- Ab jetzt beendet der Ausbau selbst diese Perioden
-- (CommandLogRepository.beimAusbauBeenden, im Abmelde-Weg). Diese Migration
-- zieht dieselbe Regel EINMAL für den Bestand nach: für jede offene Periode,
-- deren Box
--   * ausgebaut ist (device.ausgebaut_am gesetzt, seit V20260913150000) oder
--   * nicht mehr existiert (vor V20260913150000 hat das Abmelden die Zeile
--     aus device gelöscht).
--
-- Geschlossen wird wie im Schreibweg (closeOpenExcept) an ihrem LETZTEN
-- BELEGTEN Zeitpunkt, ended_at = last_seen_at: es wird nie eine Zeit
-- behauptet, in der niemand hingesehen hat, und es entsteht kein Ereignis —
-- der Ausbau ist kein Stopp. Keine andere Spalte und keine andere Zeile ändert
-- sich, nichts wird gelöscht; Beginn, Verlauf und Urteil der Periode bleiben.
--
-- Läuft als Flyway-Superuser (BYPASSRLS), also über alle Mandanten.
-- Idempotent: eine zweite Ausführung findet keine offene Periode mehr.
-- =============================================================================

UPDATE device_command_log l
   SET ended_at = l.last_seen_at
 WHERE l.kind = 'periode'
   AND l.ended_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM device d
                    WHERE d.id = l.device_id
                      AND d.ausgebaut_am IS NULL);
