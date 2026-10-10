-- =============================================================================
-- UEMS AP-07 IP-9 — Der Lücken-Melder: Stand je Prüfeinheit und Laufzustand
-- =============================================================================
-- Der Melder (`uems/LueckenMelder`, Takt `LueckenLaeufer`) schreibt `data_gap`
-- und `backfill` in `messreihe_ereignis` (V20260911260000) — auf ZWEI Wegen:
--
--   * je REIHE aus der Kadenz ZUM ZEITPUNKT (E9, `quelle_kadenz`): kein guter
--     Wert über 2 × Kadenz (`ZustandAbleitung.LUECKE_FAKTOR`, ohne Boden und
--     ohne Deckel) — die offene Lücke beginnt beim ersten erwarteten, aber
--     fehlenden Wert;
--   * je BOX aus dem letzten Eingang („Box meldet sich nicht“, AP-06 E5): eine
--     offene Lücke je Box (der Kern-Pfad) und je Datenquelle, für die die Box
--     zu dem Zeitpunkt zuständig war (der UEMS-Pfad) — beginnend beim letzten
--     Eingang.
--
-- Beide schließen sich wieder: bei der Rückkehr (`bis`), mit dem Eingang des
-- ersten nachgelieferten Werts (`nachgeliefert_am`), und die Nachlieferung
-- selbst wird je Box und Quelle ein `backfill`. Die Ereignis-Tabelle bleibt
-- append-only: Schließen ist eine Fortschreibung (weitere Zeile, gleiche
-- `ereignis_id`).
--
-- Diese Migration legt NUR den Arbeitsstand des Melders an — keine Spalte an
-- einer bestehenden Tabelle, keine Zeile in einer bestehenden Tabelle.
--
-- 1. `messreihe_luecke_stand`: EINE Zeile je Prüfeinheit (Box oder Reihe) —
--    sie ist Stand UND Arbeitsliste zugleich. `faellig_ab` sagt, wann die
--    Einheit das nächste Mal geprüft werden muss (NULL = erst, wenn wieder
--    etwas eingeht). Entnommen wird unter `FOR UPDATE SKIP LOCKED`, geprüft,
--    gemeldet und der Stand fortgeschrieben in EINER Transaktion: ein Abbruch
--    verliert nichts und meldet nichts doppelt (die Ereignis-Kennungen sind
--    abgeleitet, eine Wiederholung ist `ON CONFLICT DO NOTHING`).
-- 2. `messreihe_luecke_lauf`: der Eingangs-Zeiger (wie `messreihe_viertelstunde_lauf`).
--    Er ist nicht mandantengebunden und trägt darum weder `tenant_id` noch RLS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS messreihe_luecke_stand (
    tenant_id        UUID        NOT NULL,
    -- 'box:<device_id>' oder 'reihe:<entity_id>:<messkanal>' — der Schlüssel.
    einheit          TEXT        NOT NULL,
    art              TEXT        NOT NULL,
    -- Box: die Box selbst. Reihe: die Box, die ihren jüngsten guten Wert lieferte.
    device_id        UUID        NOT NULL,
    site_id          UUID,
    entity_id        UUID,
    messkanal        TEXT,
    -- Box: der jüngste Eingang (Eingangszeit, received_at).
    -- Reihe: die Messzeit des jüngsten guten Werts, der eingegangen ist.
    zuletzt          TIMESTAMPTZ NOT NULL,
    -- `von` der offenen Lücke dieser Einheit (Box: aus dem Herzschlag, Reihe: aus
    -- der Kadenz); NULL = keine offene.
    luecke_seit      TIMESTAMPTZ,
    -- Reihe: die Kadenz, mit der die offene Lücke gemessen und gezählt wird — die
    -- zum Zeitpunkt des letzten guten Werts (E9), nie die von heute.
    luecke_kadenz_s  INTEGER,
    -- Box: der erste Eingang NACH `luecke_seit` — die Rückkehr.
    erste_nach       TIMESTAMPTZ,
    -- Das Eingangsfenster nachgelieferter Werte, das noch nicht verarbeitet ist (Box:
    -- noch nicht als backfill gemeldet; Reihe: noch nicht an ihre geschlossenen
    -- Lücken als `nachgeliefert_am` geschrieben) — und, nur Box, bis wohin gemeldet.
    nachlieferung_von          TIMESTAMPTZ,
    nachlieferung_bis          TIMESTAMPTZ,
    nachlieferung_gemeldet_bis TIMESTAMPTZ,
    -- Reihe: bis zu welcher Messzeit Löcher zwischen guten Werten gesucht sind.
    geprueft_bis     TIMESTAMPTZ,
    faellig_ab       TIMESTAMPTZ,
    geprueft_am      TIMESTAMPTZ,
    angelegt_am      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_luecke_stand_pk PRIMARY KEY (tenant_id, einheit),
    CONSTRAINT messreihe_luecke_stand_art_chk CHECK (coalesce(
        (art = 'box' AND entity_id IS NULL AND messkanal IS NULL
             AND einheit = 'box:' || device_id::text
             AND luecke_kadenz_s IS NULL AND geprueft_bis IS NULL)
        OR (art = 'reihe' AND entity_id IS NOT NULL AND messkanal IS NOT NULL
             AND einheit = 'reihe:' || entity_id::text || ':' || messkanal
             AND erste_nach IS NULL AND nachlieferung_gemeldet_bis IS NULL),
        false)),
    CONSTRAINT messreihe_luecke_stand_kadenz_chk CHECK (coalesce(
        (luecke_seit IS NULL AND luecke_kadenz_s IS NULL)
        OR art = 'box'
        OR (luecke_kadenz_s BETWEEN 1 AND 86400), false)),
    CONSTRAINT messreihe_luecke_stand_nachlieferung_chk CHECK (coalesce(
        (nachlieferung_von IS NULL) = (nachlieferung_bis IS NULL)
        AND (nachlieferung_von IS NULL OR nachlieferung_von <= nachlieferung_bis), false))
);

COMMENT ON TABLE messreihe_luecke_stand IS
    'AP-07 IP-9: Stand und Arbeitsliste des Lücken-Melders — eine Zeile je Box bzw. Reihe; '
    'faellig_ab = nächste Prüfung (NULL = erst beim nächsten Eingang). Entnahme unter '
    'FOR UPDATE SKIP LOCKED, prüfen + melden + fortschreiben in EINER Transaktion. Die Lücken '
    'selbst stehen in messreihe_ereignis (data_gap, backfill), nie hier.';

CREATE INDEX IF NOT EXISTS idx_messreihe_luecke_stand_faellig
    ON messreihe_luecke_stand (faellig_ab)
    WHERE faellig_ab IS NOT NULL;

CREATE TABLE IF NOT EXISTS messreihe_luecke_lauf (
    schluessel   TEXT        PRIMARY KEY,
    zeitpunkt    TIMESTAMPTZ,
    zahl         BIGINT      NOT NULL DEFAULT 0,
    notiz        TEXT,
    geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_luecke_lauf_schluessel_chk CHECK (schluessel IN ('zeiger'))
);

COMMENT ON TABLE messreihe_luecke_lauf IS
    'AP-07 IP-9: Laufzustand des Lücken-Melders — der Eingangs-Zeiger (received_at), bis zu dem '
    'die Eingänge in messreihe_luecke_stand eingetragen sind. Die Zeile wird unter FOR UPDATE '
    'SKIP LOCKED gelesen: ein zweiter Melder überspringt das Eintragen, statt zu warten.';

INSERT INTO messreihe_luecke_lauf (schluessel, zeitpunkt, zahl, notiz)
VALUES ('zeiger', NULL, 0, NULL)
ON CONFLICT (schluessel) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Rechte und Mandantenzaun
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_luecke_stand ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_luecke_stand FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_luecke_stand_tenant_isolation ON messreihe_luecke_stand;
CREATE POLICY messreihe_luecke_stand_tenant_isolation ON messreihe_luecke_stand
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Nur der Melder (BYPASSRLS-Rolle) arbeitet damit; die App-Rolle braucht den
-- Arbeitsstand nicht — die Lücken liest sie aus messreihe_ereignis.
REVOKE ALL ON messreihe_luecke_stand FROM ${appDbUser};
REVOKE ALL ON messreihe_luecke_lauf FROM ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_luecke_stand TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_luecke_lauf TO ${adminDbUser};
