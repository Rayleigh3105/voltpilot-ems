-- vp-schalten-3s (Captain-Entscheid C, 28.11.2026): hält eine Schutzregel der Box einen Verbraucher (Mindestlauf,
-- Mindestpause), meldet die Box mit dem Grund auch, wann die Haltung von selbst endet (consumers.{id}.reason_until).
-- Das Portal sagt damit sofort, ab wann geschaltet wird. Rein additiv: eine leere, nullable Spalte; RLS, Rechte und
-- Löschwege der Tabelle bleiben, wie sie sind.
ALTER TABLE consumer_runtime_status ADD COLUMN IF NOT EXISTS reason_until TIMESTAMPTZ;
