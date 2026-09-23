-- AP-16 P1, Befund aus IP-20: Ort und Größe am Messbedarf zusätzlich als Struktur.
-- Neben dem Wortlaut (`ort`, `groesse`) steht optional GENAU ein Ort-Verweis — ein Standort
-- (`standort_id`) oder ein Gebäude/Bereich (`ort_id`), wie bei `messstelle_ort` — und optional
-- die Größe aus dem Katalog der Messstelle (`messgroesse`, `richtung`). Den Katalog prüft
-- `MessbedarfService` gegen `MessstelleRegeln.GROESSEN_KATALOG`; hier steht nur die Form.
-- Keine Bestandszeile ändert sich: alle vier Spalten bleiben in jeder vorhandenen Zeile NULL, und
-- ohne Struktur bleibt der Wortlaut führend für die Anzeige.
ALTER TABLE messbedarf
    ADD COLUMN standort_id UUID,
    ADD COLUMN ort_id UUID,
    ADD COLUMN messgroesse TEXT,
    ADD COLUMN richtung TEXT;
ALTER TABLE messbedarf
    ADD CONSTRAINT messbedarf_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort(id, tenant_id) ON DELETE RESTRICT,
    ADD CONSTRAINT messbedarf_ort_fk FOREIGN KEY (ort_id, tenant_id)
        REFERENCES ort(id, tenant_id) ON DELETE RESTRICT,
    ADD CONSTRAINT messbedarf_hoechstens_ein_ort CHECK (num_nonnulls(standort_id, ort_id) <= 1),
    ADD CONSTRAINT messbedarf_messgroesse_chk CHECK (messgroesse IS NULL OR btrim(messgroesse) <> ''),
    ADD CONSTRAINT messbedarf_richtung_chk CHECK (richtung IS NULL
        OR (messgroesse IS NOT NULL AND btrim(richtung) <> ''));
CREATE INDEX messbedarf_standort_idx ON messbedarf(tenant_id, standort_id) WHERE standort_id IS NOT NULL;
CREATE INDEX messbedarf_ort_idx ON messbedarf(tenant_id, ort_id) WHERE ort_id IS NOT NULL;

GRANT UPDATE (standort_id, ort_id, messgroesse, richtung) ON messbedarf TO ${appDbUser};
