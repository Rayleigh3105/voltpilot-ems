-- =============================================================================
-- V20260914193000 - UEMS AP-01 IP-4: Ruhe bis zum Start (Regel R0, Entscheid E7 = A).
-- -----------------------------------------------------------------------------
-- Eine Anlage, die zur Funktion „Steuern & Optimieren" gehört, aber noch nicht
-- gestartet ist (oder angehalten wurde), ruht OHNE Enddatum - im heutigen
-- Pause-Zustand der Box (`automationPaused`), statt mit einem erfundenen fernen
-- Zeitpunkt. Dafür reicht eine Zeile `device_override` mit `kind = 'pause'`
-- und der neuen Herkunft 'funktion'.
--
-- EINE LOCKERUNG, KEIN UMBAU:
--   * `herkunft` ist NULLBAR und im Bestand leer: eine Zeile ohne Herkunft ist
--     genau der Handeingriff von V20260845000000 - keine Bestandszeile ändert
--     sich, kein Backfill.
--   * `ends_at` verliert NOT NULL, aber der CHECK verlangt das Ende weiter für
--     JEDEN Handeingriff (Herkunft leer) - Speicher-Eingriffe UND die Pause von
--     Hand. Leer darf es NUR für die Ruhe der Funktion sein.
--   * Die Ruhe der Funktion hat IMMER KEIN Ende: eine Pause MIT Ende ist nach
--     dem Funktions-Zustands-Vertrag (funktion-zustand-vectors.json,
--     `ruhe_eintrag`) ein Handeingriff und kein Anhalten - eine Funktions-Zeile
--     mit Ende wäre dort falsch eingeordnet.
--   * Die Funktion ruht nur ANLAGEN-weit (`kind = 'pause'`), nie eine Komponente.
--
-- Die Regel steht Zeile für Zeile in docs/contracts/v2/override-vectors.json
-- (Block `zeilen`) und in `uems/RuheRegel.zeileAbgelehnt` - wer den CHECK
-- weitet, ändert alle drei. Drei CHECKs statt einem, damit jeder Verstoss
-- GENAU EINEN Namen trägt; Postgres prüft sie in Namensreihenfolge (ende →
-- funktion_ohne_ende → herkunft), und genau so prüft die reine Regel.
--
-- Unverändert: die Unique-Indizes (weiter höchstens EINE Pause je Anlage - die
-- Ruhe und eine Pause von Hand schliessen sich aus), RLS + FORCE, die Grants,
-- der Erneuerungs-Index. Die bestehenden Leser filtern `ends_at > now()` und
-- `ends_at <= now()` - eine Zeile ohne Ende fällt dort per Konstruktion heraus.
-- =============================================================================

ALTER TABLE device_override ADD COLUMN IF NOT EXISTS herkunft TEXT;

ALTER TABLE device_override DROP CONSTRAINT IF EXISTS device_override_herkunft_chk;
ALTER TABLE device_override ADD CONSTRAINT device_override_herkunft_chk
    CHECK (herkunft IS NULL OR (herkunft = 'funktion' AND kind = 'pause'));

ALTER TABLE device_override ALTER COLUMN ends_at DROP NOT NULL;

-- Das Ende bleibt Pflicht - ausser für die Ruhe der Funktion (coalesce: ein
-- NULL darf einen CHECK nicht bestehen lassen).
ALTER TABLE device_override DROP CONSTRAINT IF EXISTS device_override_ende_chk;
ALTER TABLE device_override ADD CONSTRAINT device_override_ende_chk
    CHECK (ends_at IS NOT NULL OR coalesce(herkunft = 'funktion', false));

-- Die Ruhe der Funktion hat nie ein Ende.
ALTER TABLE device_override DROP CONSTRAINT IF EXISTS device_override_funktion_ohne_ende_chk;
ALTER TABLE device_override ADD CONSTRAINT device_override_funktion_ohne_ende_chk
    CHECK (herkunft IS DISTINCT FROM 'funktion' OR ends_at IS NULL);
