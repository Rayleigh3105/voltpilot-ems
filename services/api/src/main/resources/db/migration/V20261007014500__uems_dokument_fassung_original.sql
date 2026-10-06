-- =============================================================================
-- Konzept Nachweisen n1, Entscheid 10 (PR 2 Dokumente): das unterschriebene Original
-- gehört zur Fassung, nicht zum Dokument. Additiv: fünf Spalten an
-- energiemanagement_dokument_fassung - Ablage, Bezeichnung, Kennung, Adresse und die
-- im Browser gebildete Prüfsumme, nie die Datei (G3, Entscheid 9) - mit derselben
-- Regel wie jeder Verweis (energiemanagement_verweis_ok: ohne Ablage keiner seiner
-- Teile). Nur eine Wortlaut-Fassung trägt ein Original; bei einer Verweis-Fassung IST
-- der Verweis das Original.
--
-- Geschrieben wird es mit dem Entwurf oder beim Übergang aus dem Entwurf (Antrag oder
-- Freigabe, wer entschieden hat, hat meist auch unterschrieben). Danach hält
-- energiemanagement_fassung_eingefroren die Fassung samt Original unveränderlich, wie
-- bisher; kein Trigger und keine Funktion ändert sich. Bestehende Zeilen bleiben ohne
-- Original; das Original am Dokument (beleg_*) bleibt stehen und gehört lesend zu
-- Fassung 1, an der es beim Anlegen festgehalten wurde.
--
-- Späte Ankunft: ADD COLUMN IF NOT EXISTS, ein CHECK, den nur diese Version anlegt,
-- und das Recht der App-Rolle auf genau diese Spalten (wie V20260925013500 je Spalte).
-- =============================================================================

ALTER TABLE energiemanagement_dokument_fassung
    ADD COLUMN IF NOT EXISTS original_bezeichnung TEXT,
    ADD COLUMN IF NOT EXISTS original_ablage TEXT,
    ADD COLUMN IF NOT EXISTS original_kennung TEXT,
    ADD COLUMN IF NOT EXISTS original_adresse TEXT,
    ADD COLUMN IF NOT EXISTS original_sha256 CHAR(64);

ALTER TABLE energiemanagement_dokument_fassung
    ADD CONSTRAINT energiemanagement_fassung_original_chk CHECK (
        coalesce(energiemanagement_verweis_ok(original_bezeichnung, original_ablage, original_kennung,
            original_adresse, NULL, NULL, original_sha256), false)
        AND (form = 'wortlaut' OR original_ablage IS NULL));

GRANT UPDATE (original_bezeichnung, original_ablage, original_kennung, original_adresse, original_sha256)
    ON energiemanagement_dokument_fassung TO ${appDbUser};
