-- =============================================================================
-- UEMS AP-15 Folgepaket zu IP-30 (Befund A14) — Box-Tausch in der Gemeinsamen
-- Steuerung (Konzept vp-uems-ap15-verbund A14, R17, I3/I4; Vertrag
-- docs/contracts/v2/steuerungsverbund.md §5).
--
--   steuerungsverbund_mitglied.vorgaenger_mitglied_id
--       das Mitglied, dessen Box diese ersetzt (AP-06 E7) — NULL = eingerichtet,
--       nicht getauscht. Die Nachfolgerin erbt über diese Linie das
--       Sprungprobe-Protokoll (die Quellen reisen beim Tausch 1:1 mit).
--   steuerungsverbund_mitglied.anteil_kennung
--       die Box-Kennung, unter der das zuletzt gespeicherte Anteils-Dokument den
--       Anteil dieses Mitglieds führt — beim Tausch die der Vorgängerin. Das
--       Dokument bleibt, wie es ist (dieselbe Epoche, dieselbe Revision, nie
--       umgeschrieben: die anderen Boxen haben es quittiert); nur der Versand an
--       die Nachfolgerin und jeder Leser schlüsseln den Eintrag auf sie um. Das
--       nächste Dokument führt die Nachfolgerin unter der eigenen Kennung.
--   steuerungsverbund_aenderung.art + 'box_getauscht'
--
-- Kein Recht ändert sich: die Laufzeitrolle hat INSERT auf die ganze Tabelle, und
-- beide Spalten werden nur beim Anlegen geschrieben (kein UPDATE-Recht).
--
-- ⚠ REIN ADDITIV: zwei wahlfreie Spalten ohne Vorgabe, der CHECK ist die
-- VEREINIGUNG aller bisherigen Wörter (V20260922070000) mit dem neuen — er
-- verengt nichts, auch nicht out-of-order. Keine Bestandszeile ändert sich, es
-- wird KEINE Zeile angelegt. Ein Box-Tausch außerhalb einer Gemeinsamen
-- Steuerung merkt nichts (I6).
-- =============================================================================

ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS vorgaenger_mitglied_id UUID;
ALTER TABLE steuerungsverbund_mitglied ADD COLUMN IF NOT EXISTS anteil_kennung UUID;

ALTER TABLE steuerungsverbund_aenderung DROP CONSTRAINT IF EXISTS steuerungsverbund_aenderung_art_chk;
ALTER TABLE steuerungsverbund_aenderung ADD CONSTRAINT steuerungsverbund_aenderung_art_chk
    CHECK (art IN ('eingerichtet', 'stufe', 'epoche', 'mitglied', 'anlage_entfernt', 'vorbehalt', 'vorgabe_signal',
                   'geraete', 'erzeuger', 'box_getauscht'));

COMMENT ON COLUMN steuerungsverbund_mitglied.vorgaenger_mitglied_id IS
    'UEMS AP-15 A14/R17: Mitglied der ersetzten Box beim Box-Tausch (AP-06 E7); NULL = nicht getauscht.';
COMMENT ON COLUMN steuerungsverbund_mitglied.anteil_kennung IS
    'UEMS AP-15 A14/R17: Box-Kennung, unter der das gespeicherte Anteils-Dokument den Anteil dieses Mitglieds fuehrt (die der Vorgaengerin); NULL = die eigene.';
