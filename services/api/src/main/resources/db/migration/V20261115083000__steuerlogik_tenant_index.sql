-- Löschzug-Indexdeckung (Befund vp-kunde-loeschen-504, siehe V20261112150000/V20261112151000): die
-- drei Steuerlogik-Tabellen (V20261114180000) tragen tenant_id und eine CASCADE-Fremdschlüssel auf
-- tenant, aber noch keinen Index, der mit tenant_id beginnt - ohne ihn ist sowohl die
-- Katalog-Zählung des Löschzugs als auch seine RI-Prüfung je gelöschter Mandantenzeile ein
-- Seq-Scan über alle Mandanten (LoeschzugIndexdeckungTest).

CREATE INDEX IF NOT EXISTS idx_steuerlogik_tenant ON steuerlogik (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerlogik_lauf_tenant ON steuerlogik_lauf (tenant_id);
CREATE INDEX IF NOT EXISTS idx_steuerlogik_wechsel_tenant ON steuerlogik_wechsel (tenant_id);
