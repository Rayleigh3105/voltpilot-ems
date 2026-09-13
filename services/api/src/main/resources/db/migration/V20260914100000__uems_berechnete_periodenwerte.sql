-- =============================================================================
-- UEMS AP-10 IP-10 — Periodenwerte berechneter Messstellen in der Speicherklasse
-- =============================================================================
-- Konzept vp-uems-ap10-bilanzen §8 IP-10 (PR #688 nachziehen 4/4); Captain-
-- Entscheid E6 = A: berechnete Periodenwerte leben in der VORHANDENEN
-- Speicherklasse (`messreihe_viertelstunde` / `messreihe_tag`, dazu Monat und
-- Jahr in `messreihe_periode`) mit eigener Spur `berechnet` plus
-- `bilanzwert_eingang`, gerechnet vom Verdichtungsjob NACH den gemessenen. Der
-- LIVE-Wert bleibt sofort berechnet und wird nie gespeichert.
--
-- Was entsteht:
--
--   1. Die SPUR `berechnet` an allen drei Klassen: `messstelle_id`,
--      `formel_fassung_id`, `formel_typ` — NULL in jeder Bestandszeile
--      (Bestandsschutz: keine Abweichung). Eine berechnete Zeile hat KEINE Reihe
--      (`entity_id`/`messkanal` NULL) und nichts, was nur Rohwerte haben:
--      erhalten/erwartet, Kadenz, Slots/Teile, Wertart, Energie, Summe bleiben
--      NULL — eine 0 wäre eine Behauptung statt einer Zählung. Darum fällt
--      NOT NULL an diesen Spalten, und der CHECK `…_spur_chk` hält die alte
--      Zusage für JEDE gemessene Zeile wörtlich fest (NOT NULL wie bisher).
--   2. Je Klasse ein eindeutiger Teil-Index über Mandant + Messstelle + Periode —
--      der Schlüssel der Spur, wie `uq_…_reihe` der Schlüssel der Reihe ist.
--   3. `bilanzwert_eingang`: je berechneter Zeile ihre Eingänge, wie sie beim
--      Rechnen gelesen wurden (Messstelle bzw. Messkanal, Rolle/Anteil oder
--      Vorzeichen/Faktor, Menge, Zustand, Fassung, Abdeckung, Version,
--      Kennzeichen, Grund) — der Stoff der Herkunft (IP-12) und der Kaskade
--      (IP-11). Hypertable wie die Klassen, zehn Jahre, RLS + FORCE.
--   4. `messreihe_berechnet_stand`: wie weit der Lauf die Vergangenheit einer
--      berechneten Messstelle schon nachgeholt hat (rückwärts in Scheiben) —
--      Laufzustand, nie eine Zahl.
--
-- Was die Datenbank NICHT prüft (Lauf `uems/BerechnetePeriodenLauf`): die
-- Abhängigkeitsordnung und der Formel-Kreis, die Fortpflanzung (§4.5) und dass
-- eine endgültige Zeile nie angefasst wird — das sind Aussagen über Fassungen
-- und Eingänge, nicht über eine Zeile.
--
-- Rechte: die App LIEST, der Hintergrund-Lauf (BYPASSRLS) schreibt — wie die
-- Klassen selbst. Kein neues Ereignis, keine Vokabular-Weite.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Die Spur `berechnet`
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_viertelstunde
    ADD COLUMN IF NOT EXISTS messstelle_id     UUID,
    ADD COLUMN IF NOT EXISTS formel_fassung_id UUID,
    ADD COLUMN IF NOT EXISTS formel_typ        TEXT;

ALTER TABLE messreihe_viertelstunde
    ALTER COLUMN entity_id       DROP NOT NULL,
    ALTER COLUMN messkanal       DROP NOT NULL,
    ALTER COLUMN erhalten        DROP NOT NULL,
    ALTER COLUMN erwartet        DROP NOT NULL,
    ALTER COLUMN kadenz_s        DROP NOT NULL,
    ALTER COLUMN kadenz_herkunft DROP NOT NULL;

ALTER TABLE messreihe_viertelstunde
    ADD CONSTRAINT messreihe_viertelstunde_spur_chk CHECK (
        (messstelle_id IS NULL AND formel_fassung_id IS NULL AND formel_typ IS NULL
         AND entity_id IS NOT NULL AND messkanal IS NOT NULL
         AND erhalten IS NOT NULL AND erwartet IS NOT NULL
         AND kadenz_s IS NOT NULL AND kadenz_herkunft IS NOT NULL)
        OR
        (messstelle_id IS NOT NULL AND formel_fassung_id IS NOT NULL
         AND formel_typ IN ('gewichtete_summe', 'rest', 'saldo')
         AND entity_id IS NULL AND messkanal IS NULL
         AND erhalten IS NULL AND erwartet IS NULL
         AND kadenz_s IS NULL AND kadenz_herkunft IS NULL
         AND wertart IS NULL AND energie IS NULL AND summe IS NULL));

ALTER TABLE messreihe_tag
    ADD COLUMN IF NOT EXISTS messstelle_id     UUID,
    ADD COLUMN IF NOT EXISTS formel_fassung_id UUID,
    ADD COLUMN IF NOT EXISTS formel_typ        TEXT;

ALTER TABLE messreihe_tag
    ALTER COLUMN entity_id        DROP NOT NULL,
    ALTER COLUMN messkanal        DROP NOT NULL,
    ALTER COLUMN slots_erwartet   DROP NOT NULL,
    ALTER COLUMN slots_vorhanden  DROP NOT NULL,
    ALTER COLUMN slots_endgueltig DROP NOT NULL,
    ALTER COLUMN erhalten         DROP NOT NULL,
    ALTER COLUMN erwartet         DROP NOT NULL;

ALTER TABLE messreihe_tag
    ADD CONSTRAINT messreihe_tag_spur_chk CHECK (
        (messstelle_id IS NULL AND formel_fassung_id IS NULL AND formel_typ IS NULL
         AND entity_id IS NOT NULL AND messkanal IS NOT NULL
         AND slots_erwartet IS NOT NULL AND slots_vorhanden IS NOT NULL AND slots_endgueltig IS NOT NULL
         AND erhalten IS NOT NULL AND erwartet IS NOT NULL)
        OR
        (messstelle_id IS NOT NULL AND formel_fassung_id IS NOT NULL
         AND formel_typ IN ('gewichtete_summe', 'rest', 'saldo')
         AND entity_id IS NULL AND messkanal IS NULL
         AND slots_erwartet IS NULL AND slots_vorhanden IS NULL AND slots_endgueltig IS NULL
         AND erhalten IS NULL AND erwartet IS NULL
         AND wertart IS NULL AND energie IS NULL AND summe IS NULL));

ALTER TABLE messreihe_periode
    ADD COLUMN IF NOT EXISTS messstelle_id     UUID,
    ADD COLUMN IF NOT EXISTS formel_fassung_id UUID,
    ADD COLUMN IF NOT EXISTS formel_typ        TEXT;

ALTER TABLE messreihe_periode
    ALTER COLUMN entity_id        DROP NOT NULL,
    ALTER COLUMN messkanal        DROP NOT NULL,
    ALTER COLUMN teile_erwartet   DROP NOT NULL,
    ALTER COLUMN teile_vorhanden  DROP NOT NULL,
    ALTER COLUMN teile_endgueltig DROP NOT NULL,
    ALTER COLUMN erhalten         DROP NOT NULL,
    ALTER COLUMN erwartet         DROP NOT NULL;

ALTER TABLE messreihe_periode
    ADD CONSTRAINT messreihe_periode_spur_chk CHECK (
        (messstelle_id IS NULL AND formel_fassung_id IS NULL AND formel_typ IS NULL
         AND entity_id IS NOT NULL AND messkanal IS NOT NULL
         AND teile_erwartet IS NOT NULL AND teile_vorhanden IS NOT NULL AND teile_endgueltig IS NOT NULL
         AND erhalten IS NOT NULL AND erwartet IS NOT NULL)
        OR
        (messstelle_id IS NOT NULL AND formel_fassung_id IS NOT NULL
         AND formel_typ IN ('gewichtete_summe', 'rest', 'saldo')
         AND entity_id IS NULL AND messkanal IS NULL
         AND teile_erwartet IS NULL AND teile_vorhanden IS NULL AND teile_endgueltig IS NULL
         AND erhalten IS NULL AND erwartet IS NULL
         AND wertart IS NULL AND energie IS NULL AND summe IS NULL));

-- -----------------------------------------------------------------------------
-- 2. Der Schlüssel der Spur
-- -----------------------------------------------------------------------------
-- Teil-Indizes: die gemessenen Zeilen tragen hier nichts, und die Zeit gehört in
-- jeden eindeutigen Index einer Hypertable. Der Lauf schreibt unter einer
-- Transaktions-Sperre je Messstelle; der Index ist die Wand dahinter.
CREATE UNIQUE INDEX IF NOT EXISTS uq_messreihe_viertelstunde_berechnet
    ON messreihe_viertelstunde (tenant_id, messstelle_id, intervall_beginn)
    WHERE messstelle_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messreihe_tag_berechnet
    ON messreihe_tag (tenant_id, messstelle_id, tag)
    WHERE messstelle_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_messreihe_periode_berechnet
    ON messreihe_periode (tenant_id, messstelle_id, art, tag)
    WHERE messstelle_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. Die Eingänge eines berechneten Werts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bilanzwert_eingang (
    -- Beginn der Periode: die Viertelstunde, bzw. 00:00 des Tages / Monats /
    -- Jahres in der Zeitzone der berechneten Zeile.
    periode_beginn        TIMESTAMPTZ NOT NULL,
    tenant_id             UUID        NOT NULL,
    -- Die berechnete Messstelle, deren Zeile diese Eingänge hat.
    messstelle_id         UUID        NOT NULL,
    periode               TEXT        NOT NULL,
    version               INTEGER     NOT NULL DEFAULT 1,
    position              INTEGER     NOT NULL,
    -- Der Eingang: eine Messstelle (Baustein, Stellung) ODER ein Messkanal.
    eingang_messstelle_id UUID,
    eingang_kennzeichen   TEXT,
    entity_id             UUID,
    messkanal             TEXT,
    -- Wie er eingeht: Bilanz-Rolle + Anteil (rest, saldo) oder Vorzeichen + Faktor.
    rolle                 TEXT,
    anteil                TEXT,
    vorzeichen            TEXT,
    faktor                NUMERIC,
    -- Was AP-08 beim Rechnen an ihm sagte. NULL-Menge = „keine Werte“, nie 0.
    menge                 NUMERIC,
    menge_zustand         TEXT,
    fassung               TEXT,
    abdeckung_prozent     SMALLINT,
    eingang_version       INTEGER,
    kennzeichen           JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Warum er keine Zahl hat (das Wort des Lese-Modells), sonst NULL.
    grund                 TEXT,
    berechnet_am          TIMESTAMPTZ NOT NULL,

    CONSTRAINT bilanzwert_eingang_periode_chk
        CHECK (periode IN ('viertelstunde', 'tag', 'monat', 'jahr')),
    CONSTRAINT bilanzwert_eingang_version_chk CHECK (version >= 1 AND position >= 0),
    CONSTRAINT bilanzwert_eingang_form_chk CHECK (
        (eingang_messstelle_id IS NOT NULL AND eingang_kennzeichen IS NOT NULL
         AND entity_id IS NULL AND messkanal IS NULL)
        OR (eingang_messstelle_id IS NULL AND eingang_kennzeichen IS NULL
            AND entity_id IS NOT NULL AND messkanal IS NOT NULL)),
    CONSTRAINT bilanzwert_eingang_rolle_chk
        CHECK (rolle IS NULL OR rolle IN ('zufluss', 'abfluss', 'zugeordnet')),
    CONSTRAINT bilanzwert_eingang_vorzeichen_chk
        CHECK (vorzeichen IS NULL OR vorzeichen IN ('+', '-')),
    CONSTRAINT bilanzwert_eingang_menge_zustand_chk
        CHECK (menge_zustand IS NULL OR menge_zustand IN
               ('vollständig', 'unvollständig', 'keine Werte', 'mit Ersatzwert')),
    CONSTRAINT bilanzwert_eingang_fassung_chk
        CHECK (fassung IS NULL OR fassung IN ('vorlaeufig', 'endgueltig')),
    CONSTRAINT bilanzwert_eingang_kennzeichen_chk
        CHECK (messreihe_viertelstunde_kennzeichen_erlaubt(kennzeichen))
);

SELECT create_hypertable('bilanzwert_eingang', 'periode_beginn', if_not_exists => TRUE,
                         chunk_time_interval => INTERVAL '90 days',
                         create_default_indexes => FALSE);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bilanzwert_eingang
    ON bilanzwert_eingang (tenant_id, messstelle_id, periode, periode_beginn, version, position);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                    WHERE proc_name = 'policy_retention'
                      AND hypertable_name = 'bilanzwert_eingang') THEN
        PERFORM add_retention_policy('bilanzwert_eingang', INTERVAL '3653 days');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Wie weit die Vergangenheit nachgeholt ist
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messreihe_berechnet_stand (
    tenant_id      UUID        NOT NULL,
    messstelle_id  UUID        NOT NULL,
    -- Der früheste Tag, ab dem die Messstelle nachgeholt ist (rückwärts).
    nachgeholt_ab  DATE        NOT NULL,
    fertig         BOOLEAN     NOT NULL DEFAULT false,
    geaendert_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_berechnet_stand_pk PRIMARY KEY (tenant_id, messstelle_id)
);

-- -----------------------------------------------------------------------------
-- 5. Der Mandantenzaun und die Rechte
-- -----------------------------------------------------------------------------
ALTER TABLE bilanzwert_eingang ENABLE ROW LEVEL SECURITY;
ALTER TABLE bilanzwert_eingang FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bilanzwert_eingang_tenant_isolation ON bilanzwert_eingang;
CREATE POLICY bilanzwert_eingang_tenant_isolation ON bilanzwert_eingang
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messreihe_berechnet_stand ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_berechnet_stand FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_berechnet_stand_tenant_isolation ON messreihe_berechnet_stand;
CREATE POLICY messreihe_berechnet_stand_tenant_isolation ON messreihe_berechnet_stand
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON bilanzwert_eingang FROM ${appDbUser};
GRANT SELECT ON bilanzwert_eingang TO ${appDbUser};
GRANT SELECT, INSERT, DELETE ON bilanzwert_eingang TO ${adminDbUser};

REVOKE ALL ON messreihe_berechnet_stand FROM ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_berechnet_stand TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- 6. Was die Spalten bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN messreihe_viertelstunde.messstelle_id IS
    'AP-10 IP-10 (E6): gesetzt NUR in der Spur berechnet - die berechnete Messstelle, deren '
    'Periodenwert die Zeile ist. Dann ohne Reihe (entity_id/messkanal NULL) und ohne Rohwert-Zaehlung.';
COMMENT ON COLUMN messreihe_tag.messstelle_id IS
    'AP-10 IP-10 (E6): gesetzt NUR in der Spur berechnet - siehe messreihe_viertelstunde.messstelle_id.';
COMMENT ON COLUMN messreihe_periode.messstelle_id IS
    'AP-10 IP-10 (E6): gesetzt NUR in der Spur berechnet - siehe messreihe_viertelstunde.messstelle_id.';
COMMENT ON TABLE bilanzwert_eingang IS
    'AP-10 IP-10 (E6/E13): die Eingaenge je berechneter Zeile, wie sie beim Rechnen gelesen wurden. '
    'Hypertable, Chunk 90 Tage, Aufbewahrung 3 653 Tage, RLS + FORCE. Eine vorlaeufige Zeile ersetzt ihre '
    'Eingaenge in derselben Transaktion; eine endgueltige wird nie angefasst.';
COMMENT ON TABLE messreihe_berechnet_stand IS
    'AP-10 IP-10: Laufzustand je berechneter Messstelle - bis zu welchem Tag rueckwaerts ihre '
    'Periodenwerte nachgeholt sind (fertig = am fruehesten Tag mit gemessenen Tageswerten angekommen).';
