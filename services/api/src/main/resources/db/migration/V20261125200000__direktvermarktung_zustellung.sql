-- =============================================================================
-- V20261125200000 - Direktvermarktung: Zustellung zwischen Cloud und Box
-- (Konzept vp-direktvermarktung-konzept d2 §5.7 "Zustellung", Vertrag
-- docs/contracts/v2/direktvermarktung-zustellung.md). Baut auf
-- V20261125140000 auf (dieselbe Serie, dieselbe Merge-Reihenfolge - diese
-- Migration kommt nie vor ihr an).
--
-- Buchführung der Zustellung am Anschluss selbst: WELCHE Box das retained
-- Profil gerade hält (box_id), seit wann (profil_zugestellt_am) und in welcher
-- Fassung (profil_revision). Der Box-Tausch (PS-D22: erst löscht die alte Box
-- und quittiert, dann bekommt die neue) ist genau diese Spalte: zustellen darf
-- der Abgleich nur, wenn box_id leer ist.
-- =============================================================================

ALTER TABLE direktvermarktung ADD COLUMN IF NOT EXISTS box_id UUID REFERENCES device(id) ON DELETE SET NULL;
ALTER TABLE direktvermarktung ADD COLUMN IF NOT EXISTS profil_zugestellt_am TIMESTAMPTZ;
ALTER TABLE direktvermarktung ADD COLUMN IF NOT EXISTS profil_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE direktvermarktung ADD COLUMN IF NOT EXISTS zugestellter_fingerabdruck TEXT;

COMMENT ON COLUMN direktvermarktung.box_id IS
    'Die Box, die das retained Profil gerade hält (NULL = keine). Gelöschte Box: SET NULL - der '
    'Abgleich stellt dann an die neue führende Box zu. Erst löscht die alte Box und quittiert '
    '"geloescht", dann wird an die neue zugestellt (PS-D22).';
COMMENT ON COLUMN direktvermarktung.profil_revision IS
    'Zählt je Neuzustellung aufwärts; die Box erkennt daran eine geänderte Fassung (z. B. neuer '
    'Zugangs-Fingerabdruck) gegenüber einer bloßen Wiederzustellung.';

-- Der Abgleich sucht Anschlüsse mit hängen gebliebener Zustellung (Box weg, Eintrag beendet).
CREATE INDEX IF NOT EXISTS idx_direktvermarktung_box ON direktvermarktung (box_id) WHERE box_id IS NOT NULL;

-- Protokoll-Ereignisse der Zustellung (CHECK auf dem AKTUELLEN Schema neu aufgebaut,
-- Projektregel "CHECK-Erweiterungen auf dem aktuellen Schema aufbauen"):
--   profil_zugestellt      das retained Profil ging an eine Box
--   profil_zurueckgezogen  der Rückzug ist von der Box quittiert (geloescht)
--   zugang_angefragt       die Box hat den Zugang mit seinem Fingerabdruck erbeten
ALTER TABLE direktvermarktung_protokoll DROP CONSTRAINT IF EXISTS ck_direktvermarktung_protokoll_ereignis;
ALTER TABLE direktvermarktung_protokoll ADD CONSTRAINT ck_direktvermarktung_protokoll_ereignis CHECK (ereignis IN (
    'gewaehlt', 'zugestimmt', 'zugang_hochgeladen', 'zugang_abgelehnt', 'zugang_zugestellt',
    'zugang_zurueckgezogen', 'zustand', 'startdatum_gesetzt', 'wechsel_geplant', 'beendet',
    'profil_zugestellt', 'profil_zurueckgezogen', 'zugang_angefragt'));
