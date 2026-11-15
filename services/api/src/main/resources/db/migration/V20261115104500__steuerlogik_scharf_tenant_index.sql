-- Löschzug-Indexdeckung (LoeschzugIndexdeckungTest, wie V20261115083000) für die zwei Tabellen der
-- Steuerlogik Stufe 3 (V20261114200000): steuerlogik_einstellung und steuerlogik_protokoll tragen
-- tenant_id mit einem CASCADE-Fremdschlüssel auf tenant, aber noch keinen Index, der mit tenant_id
-- beginnt - ohne ihn sind Katalog-Zählung und RI-Prüfung des Löschzugs je Mandant ein Seq-Scan.
--
-- Die Einstellung (eine Zeile je Logik, gelesen über den Primärschlüssel) bekommt tenant_id allein.
-- Das Protokoll bekommt tenant_id vor dem Zugriffspfad seiner Leser (je Logik nach Zeit): unter RLS
-- trägt dann EIN Index beide Prädikate, statt dass der Planer einen reinen tenant_id-Index mit
-- idx_steuerlogik_protokoll_logik_am zu einem BitmapAnd verbindet.

CREATE INDEX IF NOT EXISTS idx_steuerlogik_einstellung_tenant ON steuerlogik_einstellung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerlogik_protokoll_tenant_logik_am ON steuerlogik_protokoll (tenant_id, logik_id, am);
