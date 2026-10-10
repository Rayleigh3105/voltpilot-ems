-- =============================================================================
-- UEMS: eine FLÄCHE als Nenner einer Kennzahl — der Auslöser, wenn sie sich
-- rückwirkend ändert (AP-11 §5.1 „Netzbezug je m²“, Befund aus IP-9)
-- =============================================================================
--
-- Das Kennzahlen-Konzept verspricht einem Bestandskunden „Netzbezug je m²“ als
-- erste anlegbare Kennzahl. Der Nenner dafür ist die BEZUGSFLÄCHE eines Orts —
-- und die steht in der Ortsstruktur (`flaeche_gueltigkeit`, AP-02) und wird von
-- dort GELESEN (AP-09 IP-6, E17). Daran ändert diese Migration NICHTS:
--
--   * `bezugsgroesse_stammdatum_keine_flaeche_chk` (V20260914151500) bleibt, wie
--     er ist — eine Fläche bekommt nie eine Wert-Zeile in AP-09;
--   * die Schreibroute lehnt eine Bezugsgröße in m² weiter ab (422
--     `flaeche_aus_struktur`, M4) — nur ihr Kundensatz nennt jetzt den Weg.
--
-- Was eine Kennzahl als Nenner bindet, ist eine Bezugsgröße OHNE eigene Werte:
-- Wertart `stammdatum`, Einheit der Größe `flaeche`, Geltungsbereich der Ort.
-- Sie ist der Zeiger in die Ortsstruktur, nicht eine zweite Fläche; ihre Zahlen
-- liest `BezugsflaecheLesemodell` aus `flaeche_gueltigkeit`. Dafür braucht es
-- keine Spalte und keine Tabelle — die bestehenden reichen.
--
-- DIESE MIGRATION ÄNDERT GENAU ZWEI DINGE, BEIDE ADDITIV:
--
--   1. Der Kennungs-CHECK von `messreihe_kaskade_wirkung` (zuletzt
--      V20260915150000, dieser Stand abgeschrieben und geweitet) kennt den
--      vierten Auslöser ohne Messreihe: `ort_flaeche:<Ort-ID>`. Er entsteht,
--      wenn die Fläche eines Standorts, Gebäudes oder Bereichs RÜCKWIRKEND
--      geändert wurde (`ort_aenderung`, `flaeche_geaendert`, `rueckwirkend`);
--      die Fassung ist der wievielte solche Eintrag an diesem Ort. AP-11 IP-9
--      hat ihn bewusst nicht gebaut, weil er damals ins Leere gelaufen wäre.
--      Jede bisherige Zeile bleibt gültig, keine Zeile wird geschrieben.
--   2. Ein Teilindex für die Suche der Kaskade: sie läuft alle fünf Minuten über
--      alle Kundenbereiche, eine rückwirkende Flächenänderung ist selten.
--
-- Nicht angefasst: jede bestehende Zeile (kein Backfill), `ort_aenderung` selbst
-- (append-only), `flaeche_gueltigkeit`, `bezugsgroesse`, alle Vokabulare, alle
-- Rechte bestehender Tabellen.
-- =============================================================================

ALTER TABLE messreihe_kaskade_wirkung DROP CONSTRAINT IF EXISTS messreihe_kaskade_wirkung_kennung_chk;
ALTER TABLE messreihe_kaskade_wirkung ADD CONSTRAINT messreihe_kaskade_wirkung_kennung_chk CHECK (
    anlass_kennung ~ '^EW-[0-9]{4}-[0-9]{4,}$'
    OR anlass_kennung ~ '^K-[0-9]{4}-[0-9]{4,}$'
    OR anlass_kennung ~ '^BK-[0-9]{4}-[0-9]{4,}$'
    OR anlass_kennung ~ '^kennzahl_fassung:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR anlass_kennung ~ '^bezugsgroesse_stammdatum:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR anlass_kennung ~ '^ort_flaeche:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

CREATE INDEX IF NOT EXISTS idx_ort_aenderung_flaeche_rueckwirkend
    ON ort_aenderung (tenant_id, objekt_id, id)
    WHERE art = 'flaeche_geaendert' AND rueckwirkend;
