-- =============================================================================
-- V20260806000000 - OTA Stufe 4 „Politur" (Scout vp-ota-rollout-h4 §9 Stufe 4,
-- §6 D2, §8.2). ADDITIV: zwei nullable Spalten-Gruppen, keine bestehende Zeile
-- ändert ihre Bedeutung. Eine Flotte, die nichts Neues anfasst, verhält sich
-- zeichengleich wie nach Stufe 3.
-- -----------------------------------------------------------------------------
-- 1. rollout.auto_advance - die WELLEN-AUTOMATIK als OPTION.
--
-- Captain-Entscheid D4 sagt „Wellen hand-advanced (bei ≤10 Geräten richtig)" -
-- deshalb ist DEFAULT FALSE die Vorgabe und bleibt es. Wer sie einschaltet,
-- bekommt genau EINE Erleichterung: eine Welle, deren Bake-Kriterium erfüllt
-- ist (24 h gesund UND ≥1 echter Steuerzyklus, inklusive des dreiwertigen
-- NICHT_PRUEFBAR), wird vom Wächter freigegeben statt von einer Hand.
--
-- Was sie ausdrücklich NICHT ändert: das Bake-Kriterium selbst, den Auto-Halt
-- (jedes failed/rolled_back/verstummt friert weiterhin ALLES ein - und der
-- Halt wird VOR der Automatik geprüft, ein angehaltener Rollout kann also nie
-- weiterlaufen), und die Endgültigkeit des Not-Aus.
--
-- 2. device_update_status.{root_key_ids, trust_set_*} - die VERTRAUENS-
--    IDENTITÄT je Gerät (TOFU-Abschluss-Verfolgung + Rotations-Drill).
--
-- Bis hierher war „welche Box trägt schon ein schlüsseltragendes Image?" nur
-- über eine handgeführte Liste beantwortbar (docs/ota-signing.md §6 Schritt 5:
-- „Bis Stufe 2 ist diese Liste die einzige Stelle, an der das steht"), und
-- „welche Box hat das neue Trust-Set nach einer Rotation schon gesehen?" gar
-- nicht. Die Edge meldet beides seit Stufe 4 im `update`-Block; hier wird es
-- persistiert.
--
-- ⚠ DREI Zustände, die eine Oberfläche unterscheiden MUSS, und deshalb drei
-- verschiedene Speicherformen:
--   root_key_ids IS NULL      = ein ÄLTERER Stand meldet gar nichts → „unbekannt"
--   root_key_ids = ''         = ein Image OHNE eingebackene Wurzel → Crossover
--                               OFFEN (der dokumentierte Vor-TOFU-Zustand, ein
--                               ehrlicher Befund, KEIN Fehler)
--   root_key_ids = 'root-…'   = gekreuzt
-- Genau deshalb ist es TEXT und nicht etwa ein Array mit NOT NULL DEFAULT '{}':
-- ein Default macht aus „nie gemeldet" stillschweigend „kein Schlüssel".
--
-- Gespeichert als komma-getrennte, SORTIERTE Liste. key_ids sind per Kontrakt
-- `^[a-z0-9][a-z0-9._-]{0,63}$` (otaverify), enthalten also nie ein Komma - die
-- Trennung ist eindeutig, und der Ingest lehnt alles andere ab.
--
-- Anzeige-only wie der ganze Block: nichts hiervon steuert irgendetwas, und es
-- gibt weiterhin KEINEN Schreibpfad zum Gerät.
--
-- Datums-Version nach der AGENTS.md-Koordination.
-- =============================================================================

ALTER TABLE rollout
    ADD COLUMN IF NOT EXISTS auto_advance BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE device_update_status
    ADD COLUMN IF NOT EXISTS root_key_ids TEXT,
    ADD COLUMN IF NOT EXISTS trust_set_key_ids TEXT,
    ADD COLUMN IF NOT EXISTS trust_set_generated_at TEXT,
    ADD COLUMN IF NOT EXISTS trust_set_signed_by TEXT,
    ADD COLUMN IF NOT EXISTS trust_set_error TEXT;

-- trust_set_generated_at ist bewusst TEXT und kein TIMESTAMPTZ: es ist der
-- STEMPEL AUS DEM SIGNIERTEN DOKUMENT, den ein Rotations-Drill zeichengleich
-- über die Flotte vergleicht. Ihn in einen Zeitstempel zu parsen hieße, ihn in
-- eine andere Zeitzone umzuformen und dann zwei Boxen mit demselben Set
-- verschieden aussehen zu lassen - dieselbe Disziplin, aus der
-- edge_release.manifest `text` ist.
