-- =============================================================================
-- V20260845000000 - device_override: der Handeingriff an einer KOMPONENTE und
-- die „Automatik pausieren"-Sperre einer ganzen Anlage (Steuerung Stufe 4,
-- Konzept vp-steuerung-konzept-b3 §3.2 + §3.7 B2/B5/B6, Captain-Entscheid S1 =
-- A). ADDITIV.
-- -----------------------------------------------------------------------------
-- `consumer_override` (V20260813010000) bleibt UNANGETASTET: es ist der
-- Verbraucher-Eingriff mit seinem eigenen Vokabular (start|stop), seinem
-- eigenen Lesepfad und seinem PK auf `entity_id`. Diese Tabelle ist der
-- ENTITÄTS-AGNOSTISCHE Nachbar für die zwei Dinge, die es dort nicht gibt:
--
--   speicher_halten  „Ladestand halten" - der Speicher lädt und entlädt nicht
--                    (setpoint_kw = 0; das Kommando EXISTIERT, S1 = A).
--   speicher_laden   „Speicher jetzt laden" - Ladeleistung als Sollwert.
--                    ⚠ Ob dabei aus dem NETZ geladen werden darf, entscheidet
--                    NICHT diese Zeile: die Box klemmt jeden Ladewunsch durch
--                    ihre Registry-Guards, und `charge_from_grid_allowed`
--                    (D-8, abwesend/false = nur Solar) bindet dort für JEDEN
--                    Halter. Die EEG-Regel gilt also strukturell weiter.
--   pause            „Automatik pausieren" - Fahrplan UND Regeln ruhen für die
--                    Dauer; Messen, Guards und die Einspeise-Wache laufen
--                    weiter. Gilt der ANLAGE, deshalb OHNE entity_id.
--
-- ⚠ Eine Dauer ist PFLICHT (`ends_at NOT NULL`) - ein Eingriff läuft nie
-- unbegrenzt (§16). Über 4 h wird er cloud-seitig ERNEUERT (B6), statt die
-- D-5-Kappe des Arbiters zu dehnen: `renewed_at` ist der Stempel des letzten
-- ausgesendeten Wunsches, `ends_at` das Ziel.
--
-- Mandantengebunden mit ENABLE + FORCE RLS wie `consumer_override` - das sind
-- KUNDENDATEN. ⚠ Das BIGSERIAL braucht sein EIGENES `GRANT USAGE ON SEQUENCE`
-- (V4s ALTER DEFAULT PRIVILEGES deckt Tabellen ab, Sequenzen sind eine andere
-- Objektklasse - die dokumentierte `rollout_event`-Falle).
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_override (
    id            BIGSERIAL     PRIMARY KEY,
    tenant_id     UUID          NOT NULL,
    site_id       UUID          NOT NULL,
    kind          TEXT          NOT NULL
                                CHECK (kind IN ('speicher_halten', 'speicher_laden', 'pause')),
    -- NULL = die ganze Anlage (kind='pause'); sonst die Komponente.
    entity_id     UUID,
    target_value  NUMERIC(10,3),
    ends_at       TIMESTAMPTZ   NOT NULL,
    renewed_at    TIMESTAMPTZ,
    created_by    TEXT,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT device_override_pause_has_no_entity
        CHECK ((kind = 'pause') = (entity_id IS NULL))
);

-- Höchstens EIN lebender Eingriff je Komponente ...
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_override_entity
    ON device_override (entity_id) WHERE entity_id IS NOT NULL;
-- ... und höchstens EINE Pause je Anlage.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_override_pause
    ON device_override (site_id) WHERE entity_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_device_override_site ON device_override (site_id);
-- Der Erneuerungs-Lauf (B6) sucht ausschliesslich über die Frist.
CREATE INDEX IF NOT EXISTS idx_device_override_ends ON device_override (ends_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_override TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE device_override_id_seq TO ${appDbUser};

ALTER TABLE device_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_override FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_override_isolation ON device_override;
CREATE POLICY device_override_isolation ON device_override
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Das Audit-Vokabular um die Geräte-Eingriffe weiten (eine angewandte Migration
-- ist unveränderlich, der CHECK wird deshalb hier ersetzt).
--
-- ⚠ Und `entity_id` wird NULLBAR: „Automatik pausieren" ist ein Ereignis der
-- ANLAGE, es hat keine Komponente. Eine geliehene Id (etwa die des Speichers)
-- wäre eine Falschaussage über den Umfang des Eingriffs, und eine zweite
-- Audit-Tabelle daneben wäre eine zweite Papier-Spur für dieselbe Frage
-- („wer hat wann was von Hand getan?"). Der bestehende Lesepfad
-- `ConsumerAuditRepository.forConsumer` filtert auf `entity_id = ?` - eine
-- NULL-Zeile trifft er per Konstruktion nie, sein Verhalten ist unverändert.
ALTER TABLE consumer_audit_event ALTER COLUMN entity_id DROP NOT NULL;
--
-- ⚠ EIN CHECK WIRD GEWEITET, INDEM MAN DEN AKTUELLEN STAND ABSCHREIBT - nie den
-- der Tabellen-Migration. Der Stand ist hier V20260821000000 (`switch_*`), nicht
-- V20260812010000; wer die Ur-Liste kopiert, ENTFERNT lautlos die Woerter einer
-- spaeteren Stufe, und der Schaden faellt erst dort auf, wo dieses Wort
-- geschrieben wird (hier: die Geraete-Freigabe des Selbstbaus, HTTP 500). Wer
-- diese Liste das naechste Mal anfasst, holt sich den Stand aus DIESER Datei.
ALTER TABLE consumer_audit_event DROP CONSTRAINT IF EXISTS consumer_audit_event_event_type_check;
ALTER TABLE consumer_audit_event ADD CONSTRAINT consumer_audit_event_event_type_check
    CHECK (event_type IN ('policy_saved', 'policy_activated', 'policy_deactivated',
                          'paused', 'resumed', 'override_started', 'override_stopped',
                          'override_cleared',
                          -- Einheitsmodell Stufe 4 (V20260821000000), unveraendert:
                          'switch_tested', 'switch_released', 'switch_revoked',
                          -- Steuerung Stufe 4: die Handeingriffe.
                          'device_override_started', 'device_override_cleared',
                          'automation_paused', 'automation_resumed'));
