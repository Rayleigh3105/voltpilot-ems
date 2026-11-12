-- =============================================================================
-- V20261112153000 - Box-Verdichtung: die Mandanten-Sperre gilt je Stufe, nicht
--                   je Lauf (Befund vp-kunde-loeschen-504).
-- -----------------------------------------------------------------------------
-- device_measurement_rollup_job verdichtet 90 Tage in ZWEI Stufen (5m, 15m).
-- Bisher liefen beide in EINER Transaktion: die erste Stufe sperrt per
-- FOR KEY SHARE die Zeilen ALLER Mandanten (V20260926004700) und hält diese
-- Sperren bis zum Commit NACH der zweiten Stufe. In Produktion läuft der Job
-- regelmäßig >1 min - ein Löschzug, der währenddessen startet, wartet an
-- seinem FOR UPDATE auf der Mandantenzeile die restliche Job-Laufzeit
-- (gemessen am Prod-nahen Rig: 60 s Wartezeit hinter einem 86-s-Lauf).
--
-- Ein COMMIT zwischen den Stufen halbiert die maximale Wartezeit und ändert
-- an der Schutz-Semantik von V20260926004700 nichts: jede Stufe sperrt selbst
-- und ist mit ON CONFLICT über ihr festes Fenster idempotent. Schlägt die
-- zweite Stufe fehl, bleibt die erste committet - der nächste Lauf verdichtet
-- beide Fenster erneut. Ein Löschzug, der zwischen den Stufen committet, wird
-- von der zweiten Stufe korrekt ausgelassen (die Mandantenzeile ist weg).
-- Der Scheduler ruft die Prozedur ohne umgebende Transaktion auf, COMMIT ist
-- dort erlaubt (wie in den Timescale-Policies).
--
-- Die beiden Telemetrie-Jobs (7-Tage-Fenster, Läufe im Sekundenbereich)
-- bleiben unverändert; ihr Fenster ist klein genug.
-- =============================================================================

CREATE OR REPLACE PROCEDURE device_measurement_rollup_job(job_id INT, config JSONB)
LANGUAGE plpgsql AS $$
BEGIN
  CALL refresh_device_measurement_rollup('device_measurement_rollup_5m',
                                          INTERVAL '5 minutes', now()-INTERVAL '90 days');
  COMMIT;
  CALL refresh_device_measurement_rollup('device_measurement_rollup_15m',
                                          INTERVAL '15 minutes', now()-INTERVAL '90 days');
END $$;
