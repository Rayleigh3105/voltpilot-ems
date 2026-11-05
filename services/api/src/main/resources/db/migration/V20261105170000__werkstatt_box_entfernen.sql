-- Werkstatt: einen unbenutzten Eintrag wieder aus dem Register entfernen
-- (DELETE /api/v1/admin/werkstatt/boxen/{ref}).
--
-- Erlaubt nur, solange die Referenz nirgends in Gebrauch ist (keine Abnahme,
-- kein Lauf des Werkstatt-Dienstes, kein Code, keine Einlösung, kein
-- festgehaltener Geräteschlüssel, kein Tunnel-Schlüssel, keine Kopplung,
-- kein Gerät); das prüft der WerkstattService unter der Werkstatt-Sperre.
-- Entfernt wird dann genau die Zeile in werkstatt_box; mehr legt
-- POST /boxen nicht an.
--
-- Die Spur: vor dem Löschen kommt die ganze Zeile mit wer/wann in
-- werkstatt_box_entfernt, append-only wie werkstatt_abnahme.

CREATE TABLE IF NOT EXISTS werkstatt_box_entfernt (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    box_id             UUID        NOT NULL,
    edge_ref           TEXT        NOT NULL,
    box_art            TEXT        NOT NULL,
    lan_netz           TEXT,
    schritte           JSONB       NOT NULL,
    notiz              TEXT,
    angelegt_am        TIMESTAMPTZ NOT NULL,
    angelegt_von       TEXT        NOT NULL,
    angelegt_von_name  TEXT,
    entfernt_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    entfernt_von       TEXT        NOT NULL,
    entfernt_von_name  TEXT,
    CONSTRAINT werkstatt_box_entfernt_schritte_chk CHECK (jsonb_typeof(schritte) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_werkstatt_box_entfernt_ref
    ON werkstatt_box_entfernt (edge_ref, entfernt_am DESC);

DROP TRIGGER IF EXISTS werkstatt_box_entfernt_append_only ON werkstatt_box_entfernt;
CREATE TRIGGER werkstatt_box_entfernt_append_only BEFORE UPDATE OR DELETE ON werkstatt_box_entfernt
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

REVOKE ALL ON werkstatt_box_entfernt FROM ${appDbUser};
REVOKE ALL ON werkstatt_box_entfernt FROM ${adminDbUser};
GRANT SELECT, INSERT ON werkstatt_box_entfernt TO ${adminDbUser};

ALTER TABLE werkstatt_box_entfernt ENABLE ROW LEVEL SECURITY;
ALTER TABLE werkstatt_box_entfernt FORCE ROW LEVEL SECURITY;

-- Die Admin-Rolle darf eine Register-Zeile jetzt löschen; die Abnahme hängt
-- per Fremdschlüssel daran und bleibt append-only, eine abgenommene Box
-- lässt sich also auch an der Datenbankgrenze nicht entfernen.
GRANT DELETE ON werkstatt_box TO ${adminDbUser};
