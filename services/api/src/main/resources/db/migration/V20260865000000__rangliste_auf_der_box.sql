-- Verbrauchsmanagement v1 / P6: die RANGLISTE erreicht die Box.
--
-- P4 hat die Reihenfolge in der Cloud gebaut und auf `consumer_profile
-- .default_service_rank` (die Verbraucher), `storage_relation` und die
-- Vorrang-MENGE `site_charge_point_priority` (die Säulen) projiziert. Was
-- fehlte, war die Position der SÄULEN selbst und die des SPEICHERS - „wer
-- zwischen ihnen zuerst darf, bleibt die Vorrang-Wahl" (P4-Doku). Genau die
-- zwei Zahlen ergänzt diese Migration, damit sie im retained
-- `charging-config`-Dokument zur Box reisen können.
--
-- ⚠ WARUM EINE EIGENE TABELLE UND NICHT EINE SPALTE AUF DER ALLOWLIST:
-- `site_charge_point_allowlist` ist die ZULASSUNGS-Liste ("unter welcher
-- Kennung nimmt die Box eine Säule an"). Eine Säule aus der Rangliste kann dort
-- fehlen - sie kommt aus dem, was die Box GEMELDET hat (`device_charge_point`),
-- und eine Zeile dort anzulegen wäre eine ZULASSUNG, also eine ganz andere
-- Handlung als eine Reihenfolge zu speichern. Eine Spalte auf
-- `site_charge_point_priority` scheidet aus dem gespiegelten Grund aus: dort
-- IST die Anwesenheit der Zeile die Vorrang-Aussage, und eine Säule UNTER dem
-- Speicher hat keinen Vorrang, braucht aber sehr wohl eine Position.
--
-- ⚠ MANDANTENGEBUNDEN mit RLS + FORCE wie jede andere Tabelle dieses Pfads -
-- das ist eine Kundenentscheidung über eine Kundenanlage.
CREATE TABLE IF NOT EXISTS site_charge_point_rank (
    site_id         UUID    NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    charge_point_id TEXT    NOT NULL,
    -- Die 1-basierte Position in der Rangliste des Kunden.
    --
    -- ⚠ GLEICHE ZAHLEN SIND GLEICHRANGIG, und das ist keine Ungenauigkeit,
    -- sondern die ehrliche Projektion: die Fläche zeigt die Säulen EINER Seite
    -- des Speichers als EINE Zeile (RanglisteProjektion.gruppe), der Kunde hat
    -- zwischen ihnen also gar keine Reihenfolge gewählt. Verschiedene Zahlen zu
    -- senden behauptete eine, und die Box hörte auf, zwischen ihnen abzuwechseln.
    rank            INTEGER NOT NULL CHECK (rank > 0 AND rank <= 4096),
    tenant_id       UUID    NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    PRIMARY KEY (site_id, charge_point_id)
);

ALTER TABLE site_charge_point_rank ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_charge_point_rank FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_charge_point_rank_tenant_isolation ON site_charge_point_rank;
CREATE POLICY site_charge_point_rank_tenant_isolation ON site_charge_point_rank
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON site_charge_point_rank TO voltpilot_app;

-- Die Position des SPEICHERS in derselben Liste. Sie ist die zweite Hälfte des
-- Rangs oben: eine Säule mit `rank` < `storage_rank` steht ÜBER dem Speicher
-- und darf in den GANZEN gemessenen Überschuss greifen.
--
-- ⚠ NULL heisst „der Kunde hat nie eine Reihenfolge gezogen", und dann
-- entscheidet weiter allein das anlagenweite `storage_priority` - genau das
-- Verhalten vor P6. Es ist NIE 0.
ALTER TABLE site_charging_config
    ADD COLUMN IF NOT EXISTS storage_rank INTEGER;
ALTER TABLE site_charging_config
    DROP CONSTRAINT IF EXISTS site_charging_config_storage_rank_check;
ALTER TABLE site_charging_config
    ADD CONSTRAINT site_charging_config_storage_rank_check
    CHECK (storage_rank IS NULL OR (storage_rank > 0 AND storage_rank <= 4096));
