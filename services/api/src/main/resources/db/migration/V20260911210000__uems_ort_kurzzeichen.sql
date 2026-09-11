-- UEMS AP-02 IP-4: die KURZZEICHEN der Ortsstruktur — Belegung und Zähler,
-- EINMAL für Standort (ST-n), Gebäude (G-n) und Bereich (B-n).
--
-- Die Prosa-Wahrheit ist das Konzept vp-uems-ap02-ortsstruktur (§4.1, Regel 13,
-- Entscheid E8 = A vom 10.09.2026): ein Kurzzeichen wird automatisch vergeben,
-- ist änderbar, eindeutig je Kundenbereich und wird NIE wiederverwendet —
-- „dieselbe Regel wie für Messstellen" (AP-04 E7, V20260911140000).
--
-- Die Indizes uq_standort_kurzzeichen (V20260911100000) und uq_ort_kurzzeichen
-- (V20260911110000) sehen nur das HEUTIGE Kurzzeichen, und jeder nur seine
-- Tabelle. Zwei Lücken schließt diese Migration an der Datenbankgrenze:
--   * das FRÜHERE Kurzzeichen eines umbenannten Orts bleibt belegt — ein
--     Export oder Bericht aus der Zeit davor nennt es (A10: „das alte
--     Kurzzeichen B-5 wird nicht wiederverwendet");
--   * ein Kurzzeichen ist über `standort` UND `ort` eindeutig. Der Kopf von
--     V20260911110000 ließ das dem Schreibweg („ein Kurzzeichen, das zwischen
--     standort und ort kollidiert"); die gemeinsame Belegung hält es jetzt
--     selbst, auch gegen zwei gleichzeitige Schreiber.
--
-- Die Schreibwege (IP-4 Standort, IP-5 Gebäude/Bereich) benutzen GENAU diese
-- Bausteine: `uems_ort_kurzzeichen` vergibt, `uems_ort_kurzzeichen_vorschlag`
-- nennt das nächste, ohne zu vergeben, und die Belegung lesen sie für die
-- Ablehnung mit Verweis (Java: OrtKurzzeichen).
--
-- ⚠ REIN ADDITIV. Keine Spalte, kein Index und keine Policy einer bestehenden
-- Tabelle ändert sich; es kommen zwei Tabellen, zwei Trigger und drei
-- Funktionen dazu.

-- -----------------------------------------------------------------------------
-- ort_kurzzeichen — die BELEGUNG: jedes Kurzzeichen, das ein Ort je trug
-- -----------------------------------------------------------------------------
-- Eine Zeile je Kurzzeichen, ohne Groß-/Kleinschreibung (st-1 = ST-1, wie die
-- Indizes der beiden Tabellen). Sie entsteht AUSSCHLIESSLICH aus einem wirklich
-- getragenen Kurzzeichen (Trigger unten); die App-Rolle kann sie nur lesen. Ein
-- Ort darf zu seinem EIGENEN früheren Kurzzeichen zurück. Kein Fremdschlüssel
-- auf standort/ort: die Belegung überlebt ein Löschen ohne Historie (E1, IP-15)
-- — auch dann wird das Kurzzeichen nie weitergegeben.
CREATE TABLE IF NOT EXISTS ort_kurzzeichen (
    tenant_id   UUID        NOT NULL,
    kurzzeichen TEXT        NOT NULL,
    objekt_art  TEXT        NOT NULL,
    objekt_id   UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ort_kurzzeichen_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT ort_kurzzeichen_objekt_art_chk
        CHECK (objekt_art IN ('standort', 'gebaeude', 'bereich')),
    -- Dieselbe Form wie standort_kurzzeichen_chk / ort_kurzzeichen_chk.
    CONSTRAINT ort_kurzzeichen_form_chk
        CHECK (char_length(kurzzeichen) BETWEEN 1 AND 24
               AND kurzzeichen = btrim(kurzzeichen))
);

-- tenant_id vorn: ein Index prüft ohne RLS und darf keinem fremden Mandanten
-- ein Kurzzeichen verraten (derselbe Grund wie bei uq_standort_kurzzeichen).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ort_kurzzeichen_belegt
    ON ort_kurzzeichen (tenant_id, lower(kurzzeichen));
CREATE INDEX IF NOT EXISTS idx_ort_kurzzeichen_objekt
    ON ort_kurzzeichen (objekt_id);

-- -----------------------------------------------------------------------------
-- ort_kurzzeichen_seq — der Zähler der automatischen Kurzzeichen je Art
-- -----------------------------------------------------------------------------
-- Eine Tabelle, nie ein BIGSERIAL (das Muster data_source_kennzeichen_seq): eine
-- Sequenz zählte über alle Mandanten und verlöre Nummern bei jedem Rollback.
-- `naechste_nummer` ist die nächste Nummer, die der Kundenbereich für die Art
-- vergibt (fehlt die Zeile: 1). Der Zähler rückt nur mit einem gespeicherten
-- Kurzzeichen vor (dieselbe Transaktion) und nie zurück.
CREATE TABLE IF NOT EXISTS ort_kurzzeichen_seq (
    tenant_id       UUID    NOT NULL,
    objekt_art      TEXT    NOT NULL,
    naechste_nummer INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT ort_kurzzeichen_seq_pk PRIMARY KEY (tenant_id, objekt_art),
    CONSTRAINT ort_kurzzeichen_seq_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT ort_kurzzeichen_seq_objekt_art_chk
        CHECK (objekt_art IN ('standort', 'gebaeude', 'bereich')),
    CONSTRAINT ort_kurzzeichen_seq_nummer_chk CHECK (naechste_nummer >= 1)
);

-- Der Zähler rückt nur vor: eine übersprungene Nummer wird nie mehr vergeben.
CREATE OR REPLACE FUNCTION ort_kurzzeichen_seq_rueckt_vor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.objekt_art <> OLD.objekt_art
     OR NEW.naechste_nummer < OLD.naechste_nummer THEN
    RAISE EXCEPTION 'Der Kurzzeichen-Zaehler rueckt nur vor (% auf %)',
      OLD.naechste_nummer, NEW.naechste_nummer
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ort_kurzzeichen_seq_rueckt_nur_vor';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ort_kurzzeichen_seq_rueckt_vor ON ort_kurzzeichen_seq;
CREATE TRIGGER ort_kurzzeichen_seq_rueckt_vor BEFORE UPDATE ON ort_kurzzeichen_seq
    FOR EACH ROW EXECUTE FUNCTION ort_kurzzeichen_seq_rueckt_vor();

-- ST · G · B — der Präfix der automatischen Kurzzeichen je Art (E8).
CREATE OR REPLACE FUNCTION uems_ort_kurzzeichen_praefix(p_art TEXT) RETURNS TEXT
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE p_art WHEN 'standort' THEN 'ST' WHEN 'gebaeude' THEN 'G' WHEN 'bereich' THEN 'B' END
$$;

-- Das nächste freie Kurzzeichen der Art — und der Zähler rückt dahinter. Die
-- Zeile (Mandant, Art) wird gesperrt (oder angelegt): parallele Vergaben warten
-- aufeinander, statt dieselbe Nummer zu ziehen. Eine Nummer, deren Kurzzeichen
-- schon belegt ist (von Hand vergeben, früher getragen, archiviert), wird
-- übersprungen. Läuft als Aufrufer: unter RLS vergibt die App-Rolle nur für
-- ihren eigenen Mandanten (die Policy des Zählers lehnt einen fremden ab).
CREATE OR REPLACE FUNCTION uems_ort_kurzzeichen(p_tenant UUID, p_art TEXT) RETURNS TEXT
    LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    praefix TEXT := uems_ort_kurzzeichen_praefix(p_art);
    n INTEGER;
BEGIN
    IF praefix IS NULL THEN
        RAISE EXCEPTION 'Unbekannte Ort-Art %', p_art USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO ort_kurzzeichen_seq AS z (tenant_id, objekt_art, naechste_nummer)
    VALUES (p_tenant, p_art, 1)
    ON CONFLICT (tenant_id, objekt_art) DO UPDATE SET naechste_nummer = z.naechste_nummer
    RETURNING z.naechste_nummer INTO n;
    WHILE EXISTS (SELECT 1 FROM ort_kurzzeichen k
                  WHERE k.tenant_id = p_tenant AND lower(k.kurzzeichen) = lower(praefix || '-' || n)) LOOP
        n := n + 1;
    END LOOP;
    UPDATE ort_kurzzeichen_seq SET naechste_nummer = n + 1
    WHERE tenant_id = p_tenant AND objekt_art = p_art;
    RETURN praefix || '-' || n;
END
$$;

-- Der VORSCHLAG des Anlege-Dialogs („vorbelegt, meist unberührt", E8): dasselbe
-- Kurzzeichen, das `uems_ort_kurzzeichen` jetzt vergäbe — ohne den Zähler zu
-- bewegen und ohne eine Zeile anzulegen.
CREATE OR REPLACE FUNCTION uems_ort_kurzzeichen_vorschlag(p_tenant UUID, p_art TEXT) RETURNS TEXT
    LANGUAGE plpgsql STABLE AS $$
DECLARE
    praefix TEXT := uems_ort_kurzzeichen_praefix(p_art);
    n INTEGER;
BEGIN
    IF praefix IS NULL THEN
        RAISE EXCEPTION 'Unbekannte Ort-Art %', p_art USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT z.naechste_nummer INTO n FROM ort_kurzzeichen_seq z
    WHERE z.tenant_id = p_tenant AND z.objekt_art = p_art;
    n := coalesce(n, 1);
    WHILE EXISTS (SELECT 1 FROM ort_kurzzeichen k
                  WHERE k.tenant_id = p_tenant AND lower(k.kurzzeichen) = lower(praefix || '-' || n)) LOOP
        n := n + 1;
    END LOOP;
    RETURN praefix || '-' || n;
END
$$;

-- -----------------------------------------------------------------------------
-- Jede Vergabe und jede Umbenennung belegt das Kurzzeichen
-- -----------------------------------------------------------------------------
-- An `standort` UND an `ort`, egal über welchen Weg geschrieben wird. SECURITY
-- DEFINER, weil die App-Rolle die Belegung nur lesen darf; der Mandant ist
-- NEW.tenant_id, den das WITH CHECK der Tabelle bereits geprüft hat. Trägt oder
-- trug ein ANDERER Ort das Kurzzeichen, scheitert das INSERT an
-- uq_ort_kurzzeichen_belegt (23505) — nie eine stille Weitergabe. Die Art
-- steht bei `ort` in der Zeile (gebaeude | bereich), bei `standort` im Namen der
-- Tabelle; to_jsonb liest `art`, ohne dass die Funktion die Spalte kennen muss.
CREATE OR REPLACE FUNCTION ort_kurzzeichen_belegen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_art TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kurzzeichen = OLD.kurzzeichen THEN
    RETURN NULL;
  END IF;
  v_art := CASE WHEN TG_TABLE_NAME = 'standort' THEN 'standort' ELSE to_jsonb(NEW) ->> 'art' END;
  -- Der Ort darf zu seinem EIGENEN früheren Kurzzeichen zurück.
  PERFORM 1 FROM public.ort_kurzzeichen
    WHERE tenant_id = NEW.tenant_id AND lower(kurzzeichen) = lower(NEW.kurzzeichen)
      AND objekt_id = NEW.id;
  IF NOT FOUND THEN
    INSERT INTO public.ort_kurzzeichen (tenant_id, kurzzeichen, objekt_art, objekt_id)
    VALUES (NEW.tenant_id, NEW.kurzzeichen, v_art, NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ort_kurzzeichen_belegen() FROM PUBLIC;

DROP TRIGGER IF EXISTS standort_kurzzeichen_belegen ON standort;
CREATE TRIGGER standort_kurzzeichen_belegen AFTER INSERT OR UPDATE OF kurzzeichen ON standort
    FOR EACH ROW EXECUTE FUNCTION ort_kurzzeichen_belegen();
DROP TRIGGER IF EXISTS ort_kurzzeichen_belegen ON ort;
CREATE TRIGGER ort_kurzzeichen_belegen AFTER INSERT OR UPDATE OF kurzzeichen ON ort
    FOR EACH ROW EXECUTE FUNCTION ort_kurzzeichen_belegen();

-- Der Bestand (idempotent): was heute schon ein Kurzzeichen trägt, belegt es.
-- Standorte zuerst; ein Ort, der (vor dieser Migration möglich) dasselbe
-- Kurzzeichen trägt wie ein Standort seines Mandanten, bekommt keine zweite
-- Zeile — seine nächste Umbenennung wird dann geprüft wie jede andere.
INSERT INTO ort_kurzzeichen (tenant_id, kurzzeichen, objekt_art, objekt_id)
SELECT s.tenant_id, s.kurzzeichen, 'standort', s.id FROM standort s
ON CONFLICT DO NOTHING;
INSERT INTO ort_kurzzeichen (tenant_id, kurzzeichen, objekt_art, objekt_id)
SELECT o.tenant_id, o.kurzzeichen, o.art, o.id FROM ort o
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (Hausregel: fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE ort_kurzzeichen ENABLE ROW LEVEL SECURITY;
ALTER TABLE ort_kurzzeichen FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ort_kurzzeichen_tenant_isolation ON ort_kurzzeichen;
CREATE POLICY ort_kurzzeichen_tenant_isolation ON ort_kurzzeichen
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ort_kurzzeichen_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE ort_kurzzeichen_seq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ort_kurzzeichen_seq_tenant_isolation ON ort_kurzzeichen_seq;
CREATE POLICY ort_kurzzeichen_seq_tenant_isolation ON ort_kurzzeichen_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird bewusst weggenommen, was es nicht geben darf.
-- Die BYPASSRLS-Rolle voltpilot_admin deckt V4s ALTER DEFAULT PRIVILEGES ab (das
-- Offboarding löscht über sie). Kein BIGSERIAL, darum kein Sequenz-Grant.
--
-- Die Belegung entsteht nur aus einem getragenen Kurzzeichen (Trigger).
GRANT SELECT ON ort_kurzzeichen TO ${appDbUser};
REVOKE INSERT, UPDATE, DELETE ON ort_kurzzeichen FROM ${appDbUser};
-- Der Zähler rückt vor, er verschwindet nicht.
GRANT SELECT, INSERT, UPDATE ON ort_kurzzeichen_seq TO ${appDbUser};
REVOKE DELETE ON ort_kurzzeichen_seq FROM ${appDbUser};
