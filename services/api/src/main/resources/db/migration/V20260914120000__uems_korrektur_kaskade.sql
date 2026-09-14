-- =============================================================================
-- UEMS AP-08 IP-17 — die Korrektur-Kaskade: eine freigegebene Korrektur zieht bis
-- zum Jahr durch, ein freigegebener Bericht aber nie
-- =============================================================================
-- Entscheid E9 = A (11.09.2026): nach der Freigabe einer Korrektur (oder eines
-- Ersatzwerts, E7) wird AUTOMATISCH neu gerechnet — alle Perioden der betroffenen
-- Reihen im Zeitraum, alle gröberen Perioden bis zum Jahr, die berechneten
-- Messstellen (AP-10) und die Kennzahlen (AP-11), jede mit „korrigiert (Version n)“
-- (ergebnis-zustand 1.5). Ein freigegebener Bericht (AP-12) wird NIE geändert, er
-- bekommt nur den Revisions-Auslöser. Gerechnet wird NICHT hier, sondern im Lauf
-- uems/KorrekturKaskade mit den Regeln, die schon da sind (VerbrauchRegeln,
-- BerechnetePeriode).
--
-- Was entsteht:
--
--   1. `messreihe_viertelstunde_version` (IP-13) nimmt auch eine Korrektur als Anlass
--      (`K-<Jahr>-<Nr.>`) und trägt zu jeder Version, die die Kaskade schreibt, ihre
--      Rohwert-Fakten (Periodenstände, erster/letzter Wert, erhalten/erwartet, die
--      Momentanwert-Teile): der Tag, der Monat und das Jahr darüber werden aus ihnen
--      gebildet — auch dann noch, wenn die Rohwerte ihre 90 Tage hinter sich haben.
--      Die Zeilen des Ersatzwert-Laufs bleiben, wie sie sind (`korrekturen` NULL).
--   2. `messreihe_periode_version` — Tag, Monat und Jahr einer Reihe und Viertelstunde,
--      Tag, Monat und Jahr einer berechneten Messstelle als Version n ≥ 2. Version 1
--      bleibt die Zeile der Verdichtung in messreihe_tag / messreihe_periode /
--      messreihe_viertelstunde; sie wird nie angefasst. APPEND-ONLY, lückenlos je
--      Periode. Die Eingänge einer berechneten Version stehen, wie bei Version 1, in
--      bilanzwert_eingang (dort mit `version` = n).
--   3. `messreihe_kaskade_wirkung` — je Anlass (Korrektur oder Ersatzwert) die höchste
--      verarbeitete Fassung und ihr Ergebnis: der Arbeitsstand des Laufs. Eine Fassung
--      ohne Wirkung ist Arbeit; eine verarbeitete wird beim zweiten Lauf nicht wieder
--      geschrieben.
--
-- Wörter NUR in `messreihe_kaskade_woerter()`; der CHECK fragt sie.
--
-- NICHT HIER: keine Freigabe und keine Vier-Augen-Prüfung (IP-15), keine Route und
-- kein Portal (IP-16), kein Lesen der Versionen (IP-18), keine Kennzahl (AP-11) und
-- kein Bericht (AP-12) — deren Anschlussstellen sind Java-Nähte ohne Tabelle. Kein
-- Rohwert und keine Zeile von Version 1 wird angefasst; keine bestehende Zeile
-- bekommt einen Wert.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 1. Die Wörter der Wirkung
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messreihe_kaskade_woerter() RETURNS TEXT[]
    LANGUAGE sql IMMUTABLE AS $$
    SELECT ARRAY[
        -- verarbeitet: mindestens eine Stufe hat eine neue Version
        'gebildet',
        -- verarbeitet: keine Stufe weicht ab (etwa derselbe Stand nach Freigabe und Rücknahme)
        'ohne_wirkung',
        -- benannte Ablehnungen: NICHTS ist geschrieben, keine Stufe trägt eine halbe Wahrheit
        'vorschau_fehlt',
        'vorschau_veraltet',
        'rohwerte_fehlen',
        'ueberschneidet_ersatzwert',
        'ersatzwert_ohne_periodenregel'
    ]::text[];
$$;

-- -----------------------------------------------------------------------------
-- 2. Die Viertelstunden-Version: Korrektur als Anlass, Rohwert-Fakten dazu
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_viertelstunde_version DROP CONSTRAINT IF EXISTS messreihe_viertelstunde_version_kennung_chk;
ALTER TABLE messreihe_viertelstunde_version ADD CONSTRAINT messreihe_viertelstunde_version_kennung_chk CHECK (
    (anlass_kennung ~ '^EW-[0-9]{4}-[0-9]{4,}$' OR anlass_kennung ~ '^K-[0-9]{4}-[0-9]{4,}$')
    AND anlass_fassung >= 1
    AND array_position(ersatzwerte, NULL) IS NULL);

ALTER TABLE messreihe_viertelstunde_version
    -- Die Korrekturen, die in dieser Version wirken; NULL = die Zeile schrieb der Ersatzwert-Lauf
    -- (IP-13) und ihre Rohwert-Fakten sind die von Version 1. Leer = die Kaskade schrieb sie und keine
    -- Korrektur wirkt mehr (Rücknahme: die Zahlen von Version 1).
    ADD COLUMN IF NOT EXISTS korrekturen        TEXT[],
    ADD COLUMN IF NOT EXISTS wertart            TEXT,
    ADD COLUMN IF NOT EXISTS stand_anfang       NUMERIC,
    ADD COLUMN IF NOT EXISTS stand_anfang_zeit  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stand_ende         NUMERIC,
    ADD COLUMN IF NOT EXISTS stand_ende_zeit    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS erster_wert        NUMERIC,
    ADD COLUMN IF NOT EXISTS erster_zeit        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS letzter_wert       NUMERIC,
    ADD COLUMN IF NOT EXISTS letzter_zeit       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS erhalten           INTEGER,
    ADD COLUMN IF NOT EXISTS erwartet           INTEGER,
    ADD COLUMN IF NOT EXISTS abdeckung_prozent  INTEGER,
    ADD COLUMN IF NOT EXISTS summe              NUMERIC,
    ADD COLUMN IF NOT EXISTS mittel             NUMERIC,
    ADD COLUMN IF NOT EXISTS min_wert           NUMERIC,
    ADD COLUMN IF NOT EXISTS max_wert           NUMERIC,
    ADD COLUMN IF NOT EXISTS energie            NUMERIC,
    ADD COLUMN IF NOT EXISTS gemessen_s         INTEGER,
    ADD COLUMN IF NOT EXISTS luecke_innen       BOOLEAN;

-- Die Fakten gehören der Kaskade: eine Zeile des Ersatzwert-Laufs trägt keine (sie wären eine zweite,
-- still abweichende Abschrift von Version 1).
ALTER TABLE messreihe_viertelstunde_version DROP CONSTRAINT IF EXISTS messreihe_viertelstunde_version_fakten_chk;
ALTER TABLE messreihe_viertelstunde_version ADD CONSTRAINT messreihe_viertelstunde_version_fakten_chk CHECK (
    korrekturen IS NOT NULL
    OR (wertart IS NULL AND stand_anfang IS NULL AND stand_anfang_zeit IS NULL
        AND stand_ende IS NULL AND stand_ende_zeit IS NULL AND erster_wert IS NULL AND erster_zeit IS NULL
        AND letzter_wert IS NULL AND letzter_zeit IS NULL AND erhalten IS NULL AND erwartet IS NULL
        AND abdeckung_prozent IS NULL AND summe IS NULL AND mittel IS NULL AND min_wert IS NULL
        AND max_wert IS NULL AND energie IS NULL AND gemessen_s IS NULL AND luecke_innen IS NULL));
ALTER TABLE messreihe_viertelstunde_version DROP CONSTRAINT IF EXISTS messreihe_viertelstunde_version_korrektur_chk;
ALTER TABLE messreihe_viertelstunde_version ADD CONSTRAINT messreihe_viertelstunde_version_korrektur_chk CHECK (
    (anlass_kennung LIKE 'K-%') = (korrekturen IS NOT NULL)
    AND array_position(korrekturen, NULL) IS NULL
    AND coalesce(erhalten >= 0 AND erwartet >= 0, true));

COMMENT ON COLUMN messreihe_viertelstunde_version.korrekturen IS
    'AP-08 IP-17: die Korrekturen (K-...), die in dieser Version wirken - gesetzt, wenn die Kaskade die Version '
    'schrieb; dann tragen die Spalten stand_anfang ... luecke_innen die Rohwert-Fakten dieser Version. NULL = '
    'Zeile des Ersatzwert-Laufs (IP-13), Fakten = Version 1.';

-- -----------------------------------------------------------------------------
-- 3. messreihe_periode_version
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messreihe_periode_version (
    tenant_id           UUID        NOT NULL,
    ebene               TEXT        NOT NULL,
    -- Spur Reihe: Komponente + Messkanal. Spur berechnet: die berechnete Messstelle.
    entity_id           UUID,
    messkanal           TEXT,
    messstelle_id       UUID,
    periode_beginn      TIMESTAMPTZ NOT NULL,
    periode_ende        TIMESTAMPTZ NOT NULL,
    -- Der erste Tag der Periode in ihrer Zone (Tag, Monat, Jahr); an der Viertelstunde NULL.
    tag                 DATE,
    zeitzone            TEXT        NOT NULL,
    -- 1 ist die Zeile der Verdichtung; hier stehen nur die folgenden.
    version             INTEGER     NOT NULL,
    wertart             TEXT,
    menge               NUMERIC,
    menge_zustand       TEXT        NOT NULL,
    kennzeichen         JSONB       NOT NULL,
    erhalten            INTEGER,
    erwartet            INTEGER,
    abdeckung_prozent   INTEGER,
    stand_anfang        NUMERIC,
    stand_anfang_zeit   TIMESTAMPTZ,
    stand_ende          NUMERIC,
    stand_ende_zeit     TIMESTAMPTZ,
    erster_wert         NUMERIC,
    erster_zeit         TIMESTAMPTZ,
    letzter_wert        NUMERIC,
    letzter_zeit        TIMESTAMPTZ,
    summe               NUMERIC,
    mittel              NUMERIC,
    min_wert            NUMERIC,
    max_wert            NUMERIC,
    energie             NUMERIC,
    gemessen_s          INTEGER,
    luecke_innen        BOOLEAN,
    -- vorläufig/endgültig der Basis, auf der gerechnet wurde (AP-07 E5) — die Version ändert ihn nicht.
    zustand             TEXT        NOT NULL,
    -- Was in dieser Version wirkt; beide leer = die Zahlen von Version 1 (nach einer Rücknahme).
    korrekturen         TEXT[]      NOT NULL,
    ersatzwerte         TEXT[]      NOT NULL,
    -- Welche Fassung welches Anlasses die Neubildung auslöste.
    anlass_kennung      TEXT        NOT NULL,
    anlass_fassung      INTEGER     NOT NULL,
    -- `berechnet_am` der Zeile von Version 1, auf der gerechnet wurde; NULL = es gab keine.
    basis_berechnet_am  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Wann die Kaskade diese (noch vorläufige) Version zuletzt mit ihrer Grundlage nachgezogen hat; NULL = nie.
    nachgezogen_am      TIMESTAMPTZ,

    CONSTRAINT messreihe_periode_version_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messreihe_periode_version_ebene_chk
        CHECK (ebene IN ('viertelstunde', 'tag', 'monat', 'jahr')),
    -- Genau eine Spur; die Viertelstunde einer Reihe hat ihre Version schon (messreihe_viertelstunde_version).
    CONSTRAINT messreihe_periode_version_spur_chk CHECK (
        (messstelle_id IS NULL AND entity_id IS NOT NULL AND messkanal IS NOT NULL AND ebene <> 'viertelstunde')
        OR (messstelle_id IS NOT NULL AND entity_id IS NULL AND messkanal IS NULL)),
    CONSTRAINT messreihe_periode_version_tag_chk CHECK ((ebene = 'viertelstunde') = (tag IS NULL)),
    CONSTRAINT messreihe_periode_version_zeitraum_chk CHECK (periode_beginn < periode_ende),
    CONSTRAINT messreihe_periode_version_version_chk CHECK (version >= 2),
    CONSTRAINT messreihe_periode_version_messkanal_chk
        CHECK (messkanal IS NULL OR (btrim(messkanal) <> '' AND length(messkanal) <= 240)),
    CONSTRAINT messreihe_periode_version_menge_zustand_chk
        CHECK (menge_zustand IN ('vollständig', 'unvollständig', 'keine Werte', 'mit Ersatzwert')),
    -- Unbekannt ist keine Null.
    CONSTRAINT messreihe_periode_version_zahl_chk CHECK (
        (menge_zustand <> 'keine Werte' OR menge IS NULL)
        AND (menge_zustand <> 'mit Ersatzwert' OR menge IS NOT NULL)),
    CONSTRAINT messreihe_periode_version_zustand_chk CHECK (zustand IN ('vorlaeufig', 'endgueltig')),
    CONSTRAINT messreihe_periode_version_kennzeichen_chk
        CHECK (messreihe_viertelstunde_kennzeichen_erlaubt(kennzeichen)),
    CONSTRAINT messreihe_periode_version_zaehler_chk
        CHECK (coalesce(erhalten >= 0, true) AND coalesce(erwartet >= 0, true) AND coalesce(gemessen_s >= 0, true)),
    CONSTRAINT messreihe_periode_version_anlass_chk CHECK (
        (anlass_kennung ~ '^EW-[0-9]{4}-[0-9]{4,}$' OR anlass_kennung ~ '^K-[0-9]{4}-[0-9]{4,}$')
        AND anlass_fassung >= 1
        AND array_position(korrekturen, NULL) IS NULL AND array_position(ersatzwerte, NULL) IS NULL),
    CONSTRAINT messreihe_periode_version_zahl_nan_chk CHECK (coalesce(menge <> 'NaN'::numeric, true))
);

-- Die Version je Periode einer Reihe bzw. einer berechneten Messstelle — der Schlüssel UND der Leseweg der
-- neuesten Version (version DESC).
CREATE UNIQUE INDEX IF NOT EXISTS uq_messreihe_periode_version_reihe
    ON messreihe_periode_version (tenant_id, entity_id, messkanal, ebene, periode_beginn, version)
    WHERE messstelle_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_messreihe_periode_version_berechnet
    ON messreihe_periode_version (tenant_id, messstelle_id, ebene, periode_beginn, version)
    WHERE messstelle_id IS NOT NULL;

-- Append-only: eine Version wird nie überschrieben — für JEDE Rolle. Mit EINER Ausnahme, und sie ist die Regel von
-- Version 1: eine VORLÄUFIGE Periode (ein laufender Monat, ein laufendes Jahr) entwickelt sich weiter, bis sie endgültig
-- ist. Die neueste Version einer solchen Periode zieht darum mit ihrer Grundlage nach (dieselbe Nummer, derselbe
-- Anlass, derselbe Schlüssel) — sonst stünde neben dem weiterlaufenden Jahr der Verdichtung ein eingefrorenes Jahr der
-- Korrektur: zwei Wahrheiten. Eine endgültige Version und jede ältere bleiben, wie sie sind.
CREATE OR REPLACE FUNCTION messreihe_periode_version_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.zustand = 'vorlaeufig'
     AND NEW.tenant_id = OLD.tenant_id AND NEW.ebene = OLD.ebene AND NEW.periode_beginn = OLD.periode_beginn
     AND NEW.periode_ende = OLD.periode_ende AND NEW.tag IS NOT DISTINCT FROM OLD.tag AND NEW.zeitzone = OLD.zeitzone
     AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id AND NEW.messkanal IS NOT DISTINCT FROM OLD.messkanal
     AND NEW.messstelle_id IS NOT DISTINCT FROM OLD.messstelle_id AND NEW.version = OLD.version
     AND NEW.anlass_kennung = OLD.anlass_kennung AND NEW.anlass_fassung = OLD.anlass_fassung
     AND NEW.created_at = OLD.created_at
     AND NOT EXISTS (
         SELECT 1 FROM public.messreihe_periode_version v
          WHERE v.tenant_id = OLD.tenant_id AND v.ebene = OLD.ebene AND v.periode_beginn = OLD.periode_beginn
            AND v.entity_id IS NOT DISTINCT FROM OLD.entity_id AND v.messkanal IS NOT DISTINCT FROM OLD.messkanal
            AND v.messstelle_id IS NOT DISTINCT FROM OLD.messstelle_id AND v.version > OLD.version) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'messreihe_periode_version ist append-only: eine Version wird nie geändert (nur die neueste vorläufige zieht nach)'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'messreihe_periode_version_append_only';
END $$;
DROP TRIGGER IF EXISTS messreihe_periode_version_append_only ON messreihe_periode_version;
CREATE TRIGGER messreihe_periode_version_append_only BEFORE UPDATE ON messreihe_periode_version
    FOR EACH ROW EXECUTE FUNCTION messreihe_periode_version_append_only();

-- Lückenlos: die nächste Version ist genau die höchste + 1 (die erste ist 2). Zwei gleichzeitige trifft der
-- eindeutige Index.
CREATE OR REPLACE FUNCTION messreihe_periode_version_lueckenlos() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hoechste INTEGER;
BEGIN
  SELECT max(v.version) INTO hoechste FROM public.messreihe_periode_version v
   WHERE v.tenant_id = NEW.tenant_id AND v.ebene = NEW.ebene AND v.periode_beginn = NEW.periode_beginn
     AND v.entity_id IS NOT DISTINCT FROM NEW.entity_id AND v.messkanal IS NOT DISTINCT FROM NEW.messkanal
     AND v.messstelle_id IS NOT DISTINCT FROM NEW.messstelle_id;
  IF NEW.version <> coalesce(hoechste, 1) + 1 THEN
    RAISE EXCEPTION 'Version % der Periode % %: erwartet %', NEW.version, NEW.ebene, NEW.periode_beginn,
          coalesce(hoechste, 1) + 1
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messreihe_periode_version_lueckenlos';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messreihe_periode_version_lueckenlos ON messreihe_periode_version;
CREATE TRIGGER messreihe_periode_version_lueckenlos BEFORE INSERT ON messreihe_periode_version
    FOR EACH ROW EXECUTE FUNCTION messreihe_periode_version_lueckenlos();

-- -----------------------------------------------------------------------------
-- 4. messreihe_kaskade_wirkung
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messreihe_kaskade_wirkung (
    tenant_id      UUID        NOT NULL,
    -- Der Anlass: eine Korrektur (K-…) oder ein Ersatzwert (EW-…).
    anlass_kennung TEXT        NOT NULL,
    -- Die höchste Fassung des Anlasses, die verarbeitet ist.
    fassung        INTEGER     NOT NULL,
    ergebnis       TEXT        NOT NULL,
    -- Wie viele Versionen (alle Stufen zusammen) die letzte Verarbeitung schrieb.
    versionen      INTEGER     NOT NULL,
    berechnet_am   TIMESTAMPTZ NOT NULL,
    CONSTRAINT messreihe_kaskade_wirkung_pk PRIMARY KEY (tenant_id, anlass_kennung),
    CONSTRAINT messreihe_kaskade_wirkung_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messreihe_kaskade_wirkung_kennung_chk
        CHECK (anlass_kennung ~ '^EW-[0-9]{4}-[0-9]{4,}$' OR anlass_kennung ~ '^K-[0-9]{4}-[0-9]{4,}$'),
    CONSTRAINT messreihe_kaskade_wirkung_fassung_chk CHECK (fassung >= 1 AND versionen >= 0),
    CONSTRAINT messreihe_kaskade_wirkung_ergebnis_chk
        CHECK (coalesce(ergebnis = ANY (messreihe_kaskade_woerter()), false))
);

-- -----------------------------------------------------------------------------
-- 5. Der Zaun und die Rechte
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_periode_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_periode_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_periode_version_tenant_isolation ON messreihe_periode_version;
CREATE POLICY messreihe_periode_version_tenant_isolation ON messreihe_periode_version
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messreihe_kaskade_wirkung ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_kaskade_wirkung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_kaskade_wirkung_tenant_isolation ON messreihe_kaskade_wirkung;
CREATE POLICY messreihe_kaskade_wirkung_tenant_isolation ON messreihe_kaskade_wirkung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles — hier wird ALLES genommen und eng neu gegeben.
-- Die App liest nur (die Versionen bildet der Lauf); die BYPASSRLS-Rolle des Laufs liest, hängt Versionen an
-- und schreibt die Wirkung fort, gelöscht wird nur beim Offboarding.
REVOKE ALL ON messreihe_periode_version, messreihe_kaskade_wirkung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON messreihe_periode_version, messreihe_kaskade_wirkung TO ${appDbUser};
GRANT SELECT, INSERT, DELETE ON messreihe_periode_version TO ${adminDbUser};
-- Das Nachziehen einer vorläufigen Version: nur die Spalten ihres Inhalts, nie Schlüssel, Nummer oder Anlass.
GRANT UPDATE (wertart, menge, menge_zustand, kennzeichen, zustand, korrekturen, ersatzwerte, basis_berechnet_am,
              stand_anfang, stand_anfang_zeit, stand_ende, stand_ende_zeit, erster_wert, erster_zeit, letzter_wert,
              letzter_zeit, erhalten, erwartet, abdeckung_prozent, summe, mittel, min_wert, max_wert, energie,
              gemessen_s, luecke_innen, nachgezogen_am)
    ON messreihe_periode_version TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_kaskade_wirkung TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- 6. Was sie bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON TABLE messreihe_periode_version IS
    'UEMS AP-08 IP-17: Tag, Monat und Jahr einer Reihe und Viertelstunde, Tag, Monat und Jahr einer berechneten '
    'Messstelle als Version n >= 2 nach einer Korrektur oder einem Ersatzwert (E9) - Version 1 bleibt die Zeile '
    'der Verdichtung. Append-only, lueckenlos je Periode; eine Ruecknahme ist eine Version mit den Zahlen vor der '
    'Korrektur. Gerechnet von uems/KorrekturKaskade mit VerbrauchRegeln und BerechnetePeriode, nie hier.';
COMMENT ON TABLE messreihe_kaskade_wirkung IS
    'UEMS AP-08 IP-17: je Anlass (Korrektur K-... oder Ersatzwert EW-...) die hoechste verarbeitete Fassung und ihr '
    'Ergebnis (gebildet, ohne_wirkung oder eine benannte Ablehnung) - der Arbeitsstand der Kaskade.';
