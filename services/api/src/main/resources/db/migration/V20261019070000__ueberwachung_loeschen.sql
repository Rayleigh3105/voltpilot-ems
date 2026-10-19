-- =============================================================================
-- V20261019070000 - Löschen einer eigenen Überwachung (Abnahme-Befund)
-- -----------------------------------------------------------------------------
-- Produktions-Befund: eine selbst angelegte Überwachung (z. B. PV-Erzeugung)
-- ließ sich nicht wieder löschen - der Betreiber wörtlich: "wie kann ich diese
-- denn wieder löschen also die Überwachung?" Konzept vp-alerting-konzept-m1,
-- Entscheid 3B ("Verlauf ist Historie" - der Alarm-Verlauf einer Regel bleibt
-- auch nach ihrem Ende erhalten, wie "wieder normal"/"erledigt").
--
-- Eine Regel physisch löschen geht nicht ohne Datenverlust im Verlauf: jeder
-- jemals ausgelöste `alarm` trägt `ueberwachung_id` als Fremdschlüssel
-- (`alarm_ueberwachung_fk`, ohne ON DELETE CASCADE) - ein DELETE auf `ueberwachung`
-- schlüge an jeder Regel mit Historie fehl, und ein CASCADE verlöre genau den
-- Verlauf, den Entscheid 3B ausdrücklich erhält. Diese Migration fügt deshalb
-- ein eigenes Soft-Delete-Feldpaar hinzu - ABSICHTLICH NICHT das bestehende
-- `aktiv` (das bleibt für eine spätere "Anhalten"/Pause-Funktion frei, die ein
-- Abnahme-Folgekandidat ist: eine angehaltene Regel soll wieder anlaufen
-- können, eine gelöschte nie wieder auftauchen - zwei verschiedene Zustände).
--
--   geloescht_am/geloescht_von  wie `erledigt_am`/`erledigt_durch` an `alarm`:
--                beide NULL oder beide gesetzt. Jede Regel-Leserei (Läufer,
--                "Überwachungen"-Liste, scharf schalten, Stummschalten,
--                externe Empfänger) blendet eine gelöschte Regel ab jetzt aus
--                (additiv in UeberwachungRepository, kein Schema-Zwang dafür).
--
-- Beim Löschen schließt der Dienst zudem jeden noch offenen Alarm der Regel
-- (`erledigt_durch = 'regel_geloescht'`, bereits seit V20261015130000 in der
-- CHECK vorgesehen) und schreibt einen Verlaufseintrag - dafür erweitert diese
-- Migration `alarm_verlauf_art_chk` additiv um 'geloescht' (dasselbe Muster wie
-- `ueberwachung_herkunft_chk` in V20261015140000: nur die CHECK weitet sich).
-- =============================================================================

ALTER TABLE ueberwachung
    ADD COLUMN IF NOT EXISTS geloescht_am  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS geloescht_von TEXT;

ALTER TABLE ueberwachung DROP CONSTRAINT IF EXISTS ueberwachung_geloescht_chk;
ALTER TABLE ueberwachung ADD CONSTRAINT ueberwachung_geloescht_chk
    CHECK ((geloescht_am IS NULL) = (geloescht_von IS NULL));

ALTER TABLE alarm_verlauf DROP CONSTRAINT alarm_verlauf_art_chk;
ALTER TABLE alarm_verlauf ADD CONSTRAINT alarm_verlauf_art_chk
    CHECK (art IN ('ausgeloest', 'versand', 'gesehen', 'wieder_normal', 'erledigt', 'geloescht'));
