-- =============================================================================
-- UEMS AP-08 IP-13 — Ersatzwert-Methoden: die Viertelstunde als VERSION
-- =============================================================================
-- ⚠ EINE GESCHÄTZTE VERTEILUNG VERÄNDERT DEN GEMESSENEN GESAMTBETRAG NIE. Die
-- Methoden a–c verteilen den Zuwachs einer Zählerstand-Lücke, den die Datenbank
-- schon geprüft hat (messreihe_ersatzwert_luecke, V20260913190000); die Summe ihrer
-- gespeicherten Anteile ist EXAKT dieser Zuwachs. Gerechnet wird NICHT hier und
-- nicht im Lauf, sondern in der Rechenregel VerbrauchRegeln ⟷ verbrauch.py gegen
-- docs/contracts/v2/verbrauch-vectors.json (Block `ersatzwerte`).
--
-- Was entsteht:
--
--   1. `messreihe_viertelstunde_version` — die Viertelstunde mit ihren geltenden
--      Ersatzwerten als Version n ≥ 2. Version 1 ist und bleibt die Zeile des
--      Verdichtungs-Laufs in messreihe_viertelstunde (oder, in einer Lücke, gar keine
--      Zeile); sie wird nie angefasst. Jede Neubildung ist eine WEITERE Zeile:
--      APPEND-ONLY (UPDATE scheitert für jede Rolle), lückenlos 2, 3, 4 … je
--      Viertelstunde. Ein Widerruf ist ebenfalls eine Version — mit den Zahlen von
--      Version 1: ein zurückgenommener Ersatzwert hinterlässt keine Spur in den
--      Zahlen, aber jede Version bleibt lesbar (F21: V1 · V2 verteilt · V3).
--   2. `messreihe_ersatzwert_wirkung` — je Ersatzwert, bis zu welcher Fassung der
--      Lauf ihn gerechnet hat und mit welchem Ergebnis: `gebildet`, `ohne_wirkung`
--      (zurückgenommen) oder eine BENANNTE Ablehnung (regeln.ersatzwert_ablehnungen
--      der Vektor-Datei, dazu `rohwerte_fehlen` des Laufs). Das ist der Arbeitsstand
--      des Laufs: eine Fassung ohne Wirkung ist Arbeit, und eine gerechnete wird beim
--      zweiten Lauf nicht wieder geschrieben.
--
-- Wörter NUR in `messreihe_ersatzwert_wirkung_woerter()`; der CHECK fragt sie.
--
-- NICHT HIER: keine Tag-, Monats- oder Jahresversion und keine berechnete Messstelle
-- (die Kaskade, IP-17), keine Vorschlags-Erzeugung (IP-14), keine Vier-Augen-Prüfung
-- (IP-15), keine Route und kein Portal (IP-16). Kein Rohwert, keine Zeile von
-- messreihe_viertelstunde, messreihe_tag oder messreihe_periode wird angefasst, und
-- keine bestehende Tabelle bekommt eine Spalte.

-- -----------------------------------------------------------------------------
-- 1. Die Wörter der Wirkung
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messreihe_ersatzwert_wirkung_woerter() RETURNS TEXT[]
    LANGUAGE sql IMMUTABLE AS $$
    SELECT ARRAY[
        'gebildet',
        'ohne_wirkung',
        -- regeln.ersatzwert_ablehnungen, Zeile für Zeile
        'wertart_passt_nicht',
        'kein_gemessener_zuwachs',
        'zeitraum_nicht_die_luecke',
        'vorperiode_fehlt',
        'vergleichsquelle_fehlt',
        'profil_negativ',
        'profil_ohne_verbrauch',
        'betrag_fuer_mehrere_viertelstunden',
        'einheit_passt_nicht',
        'endstand_unter_letztem_wert',
        'anfangsstand_ueber_naechstem_wert',
        'ueberschneidet_ersatzwert',
        -- nur der Lauf: Methode d rechnet Z4 aus den Rohwerten, und die haben 90 Tage Aufbewahrung
        'rohwerte_fehlen'
    ]::text[];
$$;

-- -----------------------------------------------------------------------------
-- 2. messreihe_viertelstunde_version
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messreihe_viertelstunde_version (
    tenant_id           UUID        NOT NULL,
    entity_id           UUID        NOT NULL,
    messkanal           TEXT        NOT NULL,
    intervall_beginn    TIMESTAMPTZ NOT NULL,
    -- 1 ist die Zeile des Verdichtungs-Laufs; hier stehen nur die folgenden.
    version             INTEGER     NOT NULL,
    -- Die Menge dieser Version; NULL = keine Menge bildbar, nie 0.
    menge               NUMERIC,
    menge_zustand       TEXT        NOT NULL,
    -- Klartext-Sätze, Wortlaut UND Reihenfolge sind Vertrag (ergebnis-zustand).
    kennzeichen         JSONB       NOT NULL,
    -- Was die geltenden Ersatzwerte in DIESER Viertelstunde setzen (a–c: der Anteil am
    -- Zuwachs, e–g: der Wert); NULL = keiner (Widerruf, oder nur ein Ablesestand d).
    -- Über die Viertelstunden einer Lücke ist die Summe EXAKT ihr gemessener Zuwachs.
    anteil              NUMERIC,
    -- Die Kennungen, die in dieser Version wirken; leer = der Bestand (Version 1).
    ersatzwerte         TEXT[]      NOT NULL,
    -- Welche Fassung welches Ersatzwerts die Neubildung auslöste.
    anlass_kennung      TEXT        NOT NULL,
    anlass_fassung      INTEGER     NOT NULL,
    -- `berechnet_am` der Zeile von Version 1, auf der gerechnet wurde; NULL = es gab keine.
    basis_berechnet_am  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_viertelstunde_version_pk
        PRIMARY KEY (tenant_id, entity_id, messkanal, intervall_beginn, version),
    CONSTRAINT messreihe_viertelstunde_version_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messreihe_viertelstunde_version_version_chk CHECK (version >= 2),
    CONSTRAINT messreihe_viertelstunde_version_raster_chk CHECK (uems_viertelstunde_raster(intervall_beginn)),
    CONSTRAINT messreihe_viertelstunde_version_messkanal_chk
        CHECK (btrim(messkanal) <> '' AND length(messkanal) <= 240),
    CONSTRAINT messreihe_viertelstunde_version_zustand_chk
        CHECK (menge_zustand IN ('vollständig', 'unvollständig', 'keine Werte', 'mit Ersatzwert')),
    -- Unbekannt ist keine Null: „keine Werte“ trägt keine Zahl, „mit Ersatzwert“ immer eine.
    CONSTRAINT messreihe_viertelstunde_version_zahl_chk CHECK (
        (menge_zustand <> 'keine Werte' OR menge IS NULL)
        AND (menge_zustand <> 'mit Ersatzwert' OR menge IS NOT NULL)),
    -- Ein Ersatzwert, der wirkt, macht die Viertelstunde „mit Ersatzwert“ — oder, ohne Zahl, bleibt
    -- sie, was die Rohwerte sagen; ohne Ersatzwert ist sie nie „mit Ersatzwert“.
    CONSTRAINT messreihe_viertelstunde_version_wirkt_chk CHECK (
        (cardinality(ersatzwerte) > 0 OR (menge_zustand <> 'mit Ersatzwert' AND anteil IS NULL))),
    CONSTRAINT messreihe_viertelstunde_version_kennzeichen_chk CHECK (jsonb_typeof(kennzeichen) = 'array'),
    CONSTRAINT messreihe_viertelstunde_version_kennung_chk CHECK (
        anlass_kennung ~ '^EW-[0-9]{4}-[0-9]{4,}$' AND anlass_fassung >= 1
        AND array_position(ersatzwerte, NULL) IS NULL),
    CONSTRAINT messreihe_viertelstunde_version_zahl_nan_chk CHECK (
        coalesce(menge <> 'NaN'::numeric, true) AND coalesce(anteil <> 'NaN'::numeric, true))
);

-- Die neueste Version je Viertelstunde — der Leseweg des Laufs und der späteren Flächen.
CREATE INDEX IF NOT EXISTS idx_messreihe_viertelstunde_version_reihe
    ON messreihe_viertelstunde_version (tenant_id, entity_id, messkanal, intervall_beginn, version DESC);

-- Append-only: eine Version wird nie überschrieben — für JEDE Rolle.
CREATE OR REPLACE FUNCTION messreihe_viertelstunde_version_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'messreihe_viertelstunde_version ist append-only: eine Version wird nie geändert'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'messreihe_viertelstunde_version_append_only';
END $$;

DROP TRIGGER IF EXISTS messreihe_viertelstunde_version_append_only ON messreihe_viertelstunde_version;
CREATE TRIGGER messreihe_viertelstunde_version_append_only BEFORE UPDATE ON messreihe_viertelstunde_version
    FOR EACH ROW EXECUTE FUNCTION messreihe_viertelstunde_version_append_only();

-- Lückenlos: die nächste Version ist genau die höchste + 1 (die erste ist 2). Zwei gleichzeitige
-- trifft der Primärschlüssel.
CREATE OR REPLACE FUNCTION messreihe_viertelstunde_version_lueckenlos() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hoechste INTEGER;
BEGIN
  SELECT max(v.version) INTO hoechste FROM public.messreihe_viertelstunde_version v
   WHERE v.tenant_id = NEW.tenant_id AND v.entity_id = NEW.entity_id AND v.messkanal = NEW.messkanal
     AND v.intervall_beginn = NEW.intervall_beginn;
  IF NEW.version <> coalesce(hoechste, 1) + 1 THEN
    RAISE EXCEPTION 'Version % der Viertelstunde %: erwartet %', NEW.version, NEW.intervall_beginn,
          coalesce(hoechste, 1) + 1
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messreihe_viertelstunde_version_lueckenlos';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messreihe_viertelstunde_version_lueckenlos ON messreihe_viertelstunde_version;
CREATE TRIGGER messreihe_viertelstunde_version_lueckenlos BEFORE INSERT ON messreihe_viertelstunde_version
    FOR EACH ROW EXECUTE FUNCTION messreihe_viertelstunde_version_lueckenlos();

-- -----------------------------------------------------------------------------
-- 3. messreihe_ersatzwert_wirkung
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messreihe_ersatzwert_wirkung (
    tenant_id     UUID        NOT NULL,
    kennung       TEXT        NOT NULL,
    -- Die höchste Fassung des Ersatzwerts, die gerechnet ist.
    fassung       INTEGER     NOT NULL,
    ergebnis      TEXT        NOT NULL,
    -- Wie viele Viertelstunden-Versionen die letzte Rechnung dieses Ersatzwerts schrieb.
    versionen     INTEGER     NOT NULL,
    berechnet_am  TIMESTAMPTZ NOT NULL,
    CONSTRAINT messreihe_ersatzwert_wirkung_pk PRIMARY KEY (tenant_id, kennung),
    CONSTRAINT messreihe_ersatzwert_wirkung_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messreihe_ersatzwert_wirkung_kennung_chk CHECK (kennung ~ '^EW-[0-9]{4}-[0-9]{4,}$'),
    CONSTRAINT messreihe_ersatzwert_wirkung_fassung_chk CHECK (fassung >= 1 AND versionen >= 0),
    CONSTRAINT messreihe_ersatzwert_wirkung_ergebnis_chk
        CHECK (coalesce(ergebnis = ANY (messreihe_ersatzwert_wirkung_woerter()), false))
);

-- -----------------------------------------------------------------------------
-- 4. Der Zaun und die Rechte
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_viertelstunde_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_viertelstunde_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_viertelstunde_version_tenant_isolation ON messreihe_viertelstunde_version;
CREATE POLICY messreihe_viertelstunde_version_tenant_isolation ON messreihe_viertelstunde_version
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messreihe_ersatzwert_wirkung ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_ersatzwert_wirkung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_ersatzwert_wirkung_tenant_isolation ON messreihe_ersatzwert_wirkung;
CREATE POLICY messreihe_ersatzwert_wirkung_tenant_isolation ON messreihe_ersatzwert_wirkung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles — hier wird ALLES genommen und eng neu
-- gegeben. Die App liest nur (die Versionen bildet der Lauf); die BYPASSRLS-Rolle des Laufs liest,
-- hängt Versionen an und schreibt die Wirkung fort, gelöscht wird nur beim Offboarding.
REVOKE ALL ON messreihe_viertelstunde_version, messreihe_ersatzwert_wirkung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON messreihe_viertelstunde_version, messreihe_ersatzwert_wirkung TO ${appDbUser};
GRANT SELECT, INSERT, DELETE ON messreihe_viertelstunde_version TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_ersatzwert_wirkung TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- 5. Was sie bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON TABLE messreihe_viertelstunde_version IS
    'UEMS AP-08 IP-13: die Viertelstunde mit ihren geltenden Ersatzwerten als Version n >= 2 - '
    'Version 1 bleibt die Zeile in messreihe_viertelstunde. Append-only, lueckenlos je Viertelstunde; '
    'ein Widerruf ist eine Version mit den Zahlen von Version 1. Gerechnet von VerbrauchRegeln '
    '(verbrauch-vectors.json, Block ersatzwerte), nie hier.';
COMMENT ON COLUMN messreihe_viertelstunde_version.anteil IS
    'Was die geltenden Ersatzwerte in dieser Viertelstunde setzen. Ueber die Viertelstunden einer '
    'Luecke ist die Summe (a-c) EXAKT ihr gemessener Zuwachs; den Rest aus dem Abschneiden auf 9 '
    'Nachkommastellen traegt die letzte Viertelstunde.';
COMMENT ON TABLE messreihe_ersatzwert_wirkung IS
    'UEMS AP-08 IP-13: je Ersatzwert die hoechste gerechnete Fassung und ihr Ergebnis (gebildet, '
    'ohne_wirkung oder eine benannte Ablehnung) - der Arbeitsstand des Ersatzwert-Laufs.';
