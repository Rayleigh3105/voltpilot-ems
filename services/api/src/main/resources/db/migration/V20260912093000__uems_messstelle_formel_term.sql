-- =============================================================================
-- UEMS AP-10 (Formel-Typ „gewichtete Summe"): die FORMEL einer berechneten
-- Messstelle als geordnete Liste von TERMEN (Konzept vp-helfer-konzept-h1 §2.2;
-- Vertrag docs/contracts/v2/messstelle-formel.md mit dem Java-Zwilling
-- uems/MessstelleFormelRegeln und dem TS-Zwilling frontend/portal/src/
-- uemsMessstelleFormel.ts). Sie loest die im Messstellen-Vertrag (E9,
-- messstelle.md §4.5/§4 „Formel · Eingaenge") reservierte AP-10-Stelle ein — KEIN
-- zweites, konkurrierendes „Helfer"-Modell (Hausregel „Vertraege sind additiv").
--
-- Eine berechnete Messstelle IST eine normale `messstelle`-Zeile mit
-- `art = 'berechnet'` (V20260911140000). Diese Migration fuegt genau EINE
-- mandantengebundene Tabelle hinzu, rein additiv (keine bestehende Spalte, kein
-- Vertrag und keine Box wird beruehrt):
--
--   messstelle_formel_term   eine Zeile = ein Term der gewichteten Summe:
--                            ENTWEDER ein Messkanal einer Komponente
--                            (entity_id + point_key, die Quellenbindung wie in
--                            IP-13) ODER eine andere Messstelle
--                            (quell_messstelle_id, Verkettung/Bausteine), je mit
--                            Vorzeichen und optionalem Faktor. `position` haelt
--                            die Reihenfolge stabil.
--
-- Der WERT wird in der Cloud gerechnet (MessstelleFormelBerechnung), on-the-fly
-- aus den historisierten Samples (device_measurement_sample + 15-min-Rollups) —
-- diese Tabelle traegt NUR die Definition, nie einen Wert. Die Hauptgroesse der
-- Messstelle leitet MessstelleFormelRegeln aus den Termen ab (alle Terme dieselbe
-- Vertrags-Groesse); sie steht identitaetsstiftend in `messstelle` selbst.
--
-- ⚠ NUR AN EINER BERECHNETEN MESSSTELLE. Ein Term an einer `gemessen`-Messstelle
-- waere sinnlos; der Trigger unten weist ihn ab. Ein Term verweist NIE auf seine
-- eigene Messstelle (CHECK); der volle Zyklus ueber messstelle-Terme wird im
-- Zwilling geprueft (MessstelleFormelRegeln.zyklus, wie die Stellungs-Kette).
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (die Falle aus V20260911100000):
-- messstelle_id, entity_id und quell_messstelle_id verweisen ueber
-- (…, tenant_id), nie nur ueber die id.
--
-- LOESCHEN: die Terme sind die AKTUELLE Definition der Formel, keine Historie
-- (anders als die zeitgueltige Quellenbindung messstelle_quelle) — die App-Rolle
-- darf sie ersetzen (INSERT/DELETE), das Aendern einer Formel schreibt das
-- Aenderungsprotokoll messstelle_aenderung. → messstelle: ON DELETE RESTRICT
-- (eine Messstelle wird archiviert, nie geloescht; das Offboarding raeumt die
-- Tabelle ueber die Admin-Rolle ab, vor den Messstellen). → measurement_point:
-- ON DELETE CASCADE wie jede Tabelle an einer Komponente (messstelle_quelle,
-- device_measurement_selection).
-- =============================================================================

CREATE TABLE IF NOT EXISTS messstelle_formel_term (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL,
    -- Die berechnete Messstelle, deren Formel dieser Term ist.
    messstelle_id       UUID        NOT NULL,
    -- Reihenfolge/Anzeige, stabil: je Messstelle einmal (Unique unten).
    position            INTEGER     NOT NULL,
    -- Ein Term ist ENTWEDER ein Messkanal einer Komponente ODER eine andere
    -- Messstelle (Trigger/CHECK unten stellen die passende Bindung sicher).
    eingang_art         TEXT        NOT NULL,
    -- Bei `messkanal`: die Quellenbindung (Komponente + Kanalname/point_key) wie
    -- in IP-13. Das Geraet wird NICHT gespeichert — der Cloud-Rechenweg loest die
    -- lesende Box zur Rechenzeit ueber device_measurement_selection auf.
    entity_id           UUID,
    point_key           TEXT,
    -- Bei `messstelle`: die verkettete Messstelle (Baustein).
    quell_messstelle_id UUID,
    -- Captain: jeder Term hat ein Vorzeichen und einen optionalen Faktor.
    vorzeichen          TEXT        NOT NULL,
    faktor              NUMERIC     NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messstelle_formel_term_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_formel_term_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_formel_term_entity_fk FOREIGN KEY (entity_id, tenant_id)
        REFERENCES measurement_point (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT messstelle_formel_term_quell_fk FOREIGN KEY (quell_messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    -- Eine Reihenfolge ist je Messstelle eindeutig; tenant_id vorn, damit der
    -- Unique-Index VOR dem Fremdschluessel und OHNE RLS prueft (die Falle aus
    -- V20260911100000).
    CONSTRAINT messstelle_formel_term_position_uq UNIQUE (tenant_id, messstelle_id, position),
    CONSTRAINT messstelle_formel_term_position_chk CHECK (position >= 0),
    CONSTRAINT messstelle_formel_term_eingang_chk CHECK (eingang_art IN ('messkanal', 'messstelle')),
    CONSTRAINT messstelle_formel_term_vorzeichen_chk CHECK (vorzeichen IN ('+', '-')),
    -- Ein Faktor 0 waere ein Term ohne Wirkung — sinnlos, nie gespeichert.
    CONSTRAINT messstelle_formel_term_faktor_chk CHECK (faktor <> 0),
    -- Genau die zu `eingang_art` passende Bindung, nie beide, nie keine.
    -- ⚠ coalesce(…, false): ein CHECK nimmt NULL an.
    CONSTRAINT messstelle_formel_term_bindung_chk CHECK (coalesce(
        (eingang_art = 'messkanal'
            AND entity_id IS NOT NULL AND btrim(point_key) <> '' AND quell_messstelle_id IS NULL)
        OR (eingang_art = 'messstelle'
            AND quell_messstelle_id IS NOT NULL AND entity_id IS NULL AND point_key IS NULL),
        false)),
    -- Ein Term ist nie seine eigene Messstelle (der Selbst-Zyklus schon an der
    -- Datenbankgrenze; die laengeren Kreise prueft der Zwilling).
    CONSTRAINT messstelle_formel_term_nicht_selbst
        CHECK (quell_messstelle_id IS NULL OR quell_messstelle_id <> messstelle_id)
);

-- Die Terme einer Formel, in Reihenfolge.
CREATE INDEX IF NOT EXISTS idx_messstelle_formel_term_messstelle
    ON messstelle_formel_term (messstelle_id, position);
-- „Welche Formeln nutzen diesen Messkanal?" (Loeschen/Umbenennen einer Komponente).
CREATE INDEX IF NOT EXISTS idx_messstelle_formel_term_entity
    ON messstelle_formel_term (entity_id, point_key);
-- „Welche Formeln verketten diese Messstelle?" (Zyklus, Archivieren).
CREATE INDEX IF NOT EXISTS idx_messstelle_formel_term_quell
    ON messstelle_formel_term (quell_messstelle_id);

-- -----------------------------------------------------------------------------
-- Ein Term haengt nur an einer BERECHNETEN Messstelle. Laeuft als Aufrufer: der
-- Mandant ist NEW.tenant_id, den das WITH CHECK der Policy bereits geprueft hat,
-- und die Messstelle haengt ueber den zusammengesetzten Fremdschluessel an
-- demselben.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messstelle_formel_term_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM messstelle m
         WHERE m.id = NEW.messstelle_id AND m.tenant_id = NEW.tenant_id
           AND m.art = 'berechnet') THEN
    RAISE EXCEPTION 'Ein Formel-Term haengt nur an einer berechneten Messstelle (%)', NEW.messstelle_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_formel_term_nur_berechnet';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messstelle_formel_term_pruefen ON messstelle_formel_term;
CREATE TRIGGER messstelle_formel_term_pruefen BEFORE INSERT OR UPDATE ON messstelle_formel_term
    FOR EACH ROW EXECUTE FUNCTION messstelle_formel_term_pruefen();

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_formel_term ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_formel_term FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_formel_term_tenant_isolation ON messstelle_formel_term;
CREATE POLICY messstelle_formel_term_tenant_isolation ON messstelle_formel_term
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/
-- DELETE auf jede neue Tabelle. Die Terme sind die AKTUELLE Definition der Formel
-- (keine Historie): die App-Rolle darf sie ersetzen. Die BYPASSRLS-Rolle
-- voltpilot_admin behaelt V4s Rechte (das Offboarding loescht ueber sie). Kein
-- BIGSERIAL, also kein Sequenz-Grant.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON messstelle_formel_term TO ${appDbUser};

COMMENT ON TABLE messstelle_formel_term IS
    'Ein Term der gewichteten Summe einer berechneten Messstelle (UEMS AP-10): Messkanal '
    '(entity_id + point_key) oder verkettete Messstelle (quell_messstelle_id), je mit Vorzeichen '
    'und Faktor. Nur Definition, nie ein Wert. Vertrag docs/contracts/v2/messstelle-formel.md.';
