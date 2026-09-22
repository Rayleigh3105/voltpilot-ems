-- =============================================================================
-- UEMS AP-15 Folgepaket — Ausscheiden eines Mitglieds aus der Gemeinsamen
-- Steuerung (Konzept vp-uems-ap15-verbund §5.5 „Auflösen“, I3/I4, G5, V5, R12;
-- Vertrag docs/contracts/v2/steuerungsverbund.md §5).
--
--   steuerungsverbund_mitglied.scheidet_aus_seit / scheidet_aus_wartet_auf /
--   scheidet_aus_von
--       das Mitglied scheidet aus: sein Anteil fällt im Zweischritt auf den
--       Rückfall seiner Geräte; es endet erst mit dem Zielstand. `quittung` =
--       es wartet auf die Quittung seiner Box (Route „ausscheiden“),
--       `betreiber` = die Box ist abgemeldet, es wartet auf die Bestätigung des
--       Betreibers, dass ihre Geräte vom Netz sind. NULL = scheidet nicht aus.
--   steuerungsverbund_mitglied.vom_netz_bestaetigt_am / _von
--       der Betreiber hat bestätigt, dass die Geräte der Box vom Netz sind (I4) —
--       dann ist ihr Rückfall nicht mehr zu reservieren.
--   steuerungsverbund_anteile.anlass + 'ausscheiden'
--   steuerungsverbund_aenderung.art + 'mitglied_ausgeschieden'
--
-- Rechte: die Laufzeitrolle bekommt UPDATE auf genau die fünf neuen Spalten.
--
-- ⚠ REIN ADDITIV: fünf wahlfreie Spalten ohne Vorgabe, beide CHECKs sind die
-- VEREINIGUNG aller bisherigen Wörter (V20260921190000 bzw. V20260922150000)
-- mit dem neuen — sie verengen nichts, auch nicht out-of-order. Keine
-- Bestandszeile ändert sich, es wird KEINE Zeile angelegt. Ohne Gemeinsame
-- Steuerung merkt niemand etwas (I6).
-- =============================================================================

ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS scheidet_aus_seit TIMESTAMPTZ;
ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS scheidet_aus_wartet_auf TEXT;
ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS scheidet_aus_von TEXT;
ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS vom_netz_bestaetigt_am TIMESTAMPTZ;
ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS vom_netz_bestaetigt_von TEXT;

ALTER TABLE steuerungsverbund_mitglied DROP CONSTRAINT IF EXISTS steuerungsverbund_mitglied_ausscheiden_chk;
ALTER TABLE steuerungsverbund_mitglied ADD CONSTRAINT steuerungsverbund_mitglied_ausscheiden_chk
    CHECK ((scheidet_aus_seit IS NULL) = (scheidet_aus_wartet_auf IS NULL)
           AND (scheidet_aus_wartet_auf IS NULL OR scheidet_aus_wartet_auf IN ('quittung', 'betreiber'))
           AND (vom_netz_bestaetigt_am IS NULL OR scheidet_aus_seit IS NOT NULL));

GRANT UPDATE (scheidet_aus_seit, scheidet_aus_wartet_auf, scheidet_aus_von, vom_netz_bestaetigt_am,
              vom_netz_bestaetigt_von)
    ON steuerungsverbund_mitglied TO ${appDbUser};

ALTER TABLE steuerungsverbund_anteile DROP CONSTRAINT IF EXISTS steuerungsverbund_anteile_anlass_chk;
ALTER TABLE steuerungsverbund_anteile ADD CONSTRAINT steuerungsverbund_anteile_anlass_chk
    CHECK (anlass IN ('scharfschalten', 'aendern', 'zielstand', 'ausscheiden'));

ALTER TABLE steuerungsverbund_aenderung DROP CONSTRAINT IF EXISTS steuerungsverbund_aenderung_art_chk;
ALTER TABLE steuerungsverbund_aenderung ADD CONSTRAINT steuerungsverbund_aenderung_art_chk
    CHECK (art IN ('eingerichtet', 'stufe', 'epoche', 'mitglied', 'anlage_entfernt', 'vorbehalt', 'vorgabe_signal',
                   'geraete', 'erzeuger', 'box_getauscht', 'mitglied_ausgeschieden'));

COMMENT ON COLUMN steuerungsverbund_mitglied.scheidet_aus_seit IS
    'UEMS AP-15 §5.5: seit wann das Mitglied ausscheidet (Zweischritt auf den Rueckfall seiner Geraete); NULL = scheidet nicht aus.';
COMMENT ON COLUMN steuerungsverbund_mitglied.scheidet_aus_wartet_auf IS
    'UEMS AP-15 §5.5/I4: quittung = wartet auf die Quittung der Box, betreiber = Box abgemeldet, wartet auf die Bestaetigung, dass ihre Geraete vom Netz sind.';
COMMENT ON COLUMN steuerungsverbund_mitglied.vom_netz_bestaetigt_am IS
    'UEMS AP-15 §5.5/I4: der Betreiber hat bestaetigt, dass die Geraete der Box vom Netz sind; ihr Rueckfall bleibt nicht reserviert.';
