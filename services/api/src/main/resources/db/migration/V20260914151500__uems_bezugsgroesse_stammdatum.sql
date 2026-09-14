-- =============================================================================
-- UEMS AP-09 IP-6: Bezugs-Stammdaten, die AP-09 selbst hält (Mitarbeitende u. a.,
-- E15) — mit Gültigkeit ab einem Tag, byte-genau das Muster der Bezugsfläche
-- (`flaeche_gueltigkeit`, V20260911110000; §4.3 S4).
--
-- ⚠ Die BEZUGSFLÄCHE bekommt hier KEINE Zeile. Sie steht in der Ortsstruktur
-- (`flaeche_gueltigkeit`) und wird von dort GELESEN (E17); eine zweite Tabelle mit
-- Flächen wäre die zweite Wahrheit, die dieses Paket verhindert. Darum lehnt
-- `bezugsgroesse_stammdatum_keine_flaeche_chk` jede Einheit der Größe `flaeche`
-- ab — für jede Rolle, auch wenn die Schreibroute (422 `flaeche_aus_struktur`)
-- umgangen wird.
--
-- Die Tabelle:
--   * `wert` > 0 — „nicht erhoben“ ist KEINE Zeile, nie eine 0 (wie `m2` der Fläche);
--     NUMERIC(18,6) wie jeder Betrag der Bezugsdaten.
--   * `gueltig_ab` DATE, `gueltig_bis` DATE = LETZTER Tag (NULL offen),
--     `aufgehoben_am` — eine Korrektur hebt ein Intervall auf, sie schreibt nie
--     `wert` um. Je Bezugsgröße ein Wert je Tag: EXCLUDE über
--     `daterange(gueltig_ab, gueltig_bis, '[]')`, `tenant_id` vorn.
--   * M1: `wertart` und `einheit` reisen als Kopie mit und sind per Fremdschlüssel
--     an `bezugsgroesse_bedeutung_uq` gebunden — nach dem ersten Stammdatum-Wert
--     scheitert jede Änderung von Wertart oder Einheit (dieselbe Wand wie
--     `bezugsgroesse_wert_bedeutung_fk`). `wertart` ist fest `stammdatum` (S1: nur
--     ein Stammdatum hat Gültigkeiten).
--   * `created_at` setzt die Datenbank (keine Spalte im INSERT-Recht): der Tag des
--     Eintrags ist die Grundlage des Abzeichens „rückwirkend (n Tage)“.
--
-- Die bestehenden Wände der Bezugsgröße lernen die neue Tabelle kennen — je als
-- NEUE Fassung der Funktion, der aktuelle Stand abgeschrieben und ergänzt:
--   * `bezugsgroesse_nur_ohne_wert_loeschen()` (V20260913120000): ein Stammdatum-Wert
--     ist ein Wert (M6) — gelöscht wird weiter nur ohne einen einzigen.
--   * `bezugsgroesse_identitaet_bleibt()` (V20260913160000): der Geltungsbereich
--     bleibt auch nach dem ersten Stammdatum-Wert fest (M1).
--   * `bezugsgroesse_aenderung_art_chk` (V20260913120000): Protokoll-Art
--     `stammdatum_eingetragen` (§6.1, S4 „Protokoll mit rueckwirkend“).
--
-- Nicht angefasst: jede bestehende Zeile (kein Backfill), `bezugsgroesse_wert`,
-- `flaeche_gueltigkeit`, die Vokabular-Funktion, alle Rechte bestehender Tabellen.
-- =============================================================================

-- Die Größe einer Einheit aus der EINEN Vokabular-Stelle — NULL, wenn das Wort
-- keine Einheit ist. (Schema ausgeschrieben wie `bezugsdaten_wort`.)
CREATE OR REPLACE FUNCTION bezugsdaten_groesse(p_einheit TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT v.groesse FROM public.bezugsdaten_vokabular() v
   WHERE v.vokabular = 'einheiten' AND v.wort = p_einheit
$$;

CREATE TABLE IF NOT EXISTS bezugsgroesse_stammdatum (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID          NOT NULL,
    bezugsgroesse_id  UUID          NOT NULL,
    wertart           TEXT          NOT NULL DEFAULT 'stammdatum',
    einheit           TEXT          NOT NULL,
    wert              NUMERIC(18,6) NOT NULL,
    gueltig_ab        DATE          NOT NULL,
    gueltig_bis       DATE,
    aufgehoben_am     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by        TEXT,
    CONSTRAINT bezugsgroesse_stammdatum_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_stammdatum_bedeutung_fk FOREIGN KEY (bezugsgroesse_id, tenant_id, wertart, einheit)
        REFERENCES bezugsgroesse (id, tenant_id, wertart, einheit) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_stammdatum_wertart_chk CHECK (wertart = 'stammdatum'),
    CONSTRAINT bezugsgroesse_stammdatum_einheit_chk
        CHECK (coalesce(bezugsdaten_wort('einheiten', einheit), false)),
    CONSTRAINT bezugsgroesse_stammdatum_keine_flaeche_chk
        CHECK (coalesce(bezugsdaten_groesse(einheit) <> 'flaeche', false)),
    CONSTRAINT bezugsgroesse_stammdatum_wert_chk CHECK (wert > 0),
    CONSTRAINT bezugsgroesse_stammdatum_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    CONSTRAINT bezugsgroesse_stammdatum_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        bezugsgroesse_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_stammdatum_bezugsgroesse
    ON bezugsgroesse_stammdatum (tenant_id, bezugsgroesse_id, gueltig_ab);

-- M6: ein Stammdatum-Wert ist ein Wert — der aktuelle Stand (V20260913120000) ergänzt.
CREATE OR REPLACE FUNCTION bezugsgroesse_nur_ohne_wert_loeschen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bezugsgroesse_wert w
              WHERE w.bezugsgroesse_id = OLD.id AND w.tenant_id = OLD.tenant_id)
     OR EXISTS (SELECT 1 FROM bezugsgroesse_stammdatum sd
                 WHERE sd.bezugsgroesse_id = OLD.id AND sd.tenant_id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'Die Bezugsgröße % trägt Werte und wird nicht gelöscht', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_hat_werte';
  END IF;
  RETURN OLD;
END $$;

-- M1: der Geltungsbereich bleibt nach dem ersten Wert fest — auch nach dem ersten
-- Stammdatum-Wert. Der aktuelle Stand (V20260913160000) abgeschrieben und ergänzt.
CREATE OR REPLACE FUNCTION bezugsgroesse_identitaet_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'Kennung und Mandant der Bezugsgröße % sind nie änderbar', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_identitaet_unveraenderlich';
  END IF;
  IF (NEW.geltung_art, NEW.unternehmen_id, NEW.standort_id, NEW.ort_id, NEW.messstelle_id,
      NEW.prozess_id, NEW.kostenstelle_id)
       IS DISTINCT FROM (OLD.geltung_art, OLD.unternehmen_id, OLD.standort_id, OLD.ort_id, OLD.messstelle_id,
                         OLD.prozess_id, OLD.kostenstelle_id)
     AND (EXISTS (SELECT 1 FROM bezugsgroesse_wert w
                   WHERE w.bezugsgroesse_id = OLD.id AND w.tenant_id = OLD.tenant_id)
          OR EXISTS (SELECT 1 FROM bezugsgroesse_stammdatum sd
                      WHERE sd.bezugsgroesse_id = OLD.id AND sd.tenant_id = OLD.tenant_id)) THEN
    RAISE EXCEPTION 'Der Geltungsbereich der Bezugsgröße % hat Werte und ist nicht mehr änderbar', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_geltung_nach_erstem_wert';
  END IF;
  RETURN NEW;
END $$;

-- Protokoll-Art `stammdatum_eingetragen` — der aktuelle Stand (V20260913120000) ergänzt.
ALTER TABLE bezugsgroesse_aenderung DROP CONSTRAINT IF EXISTS bezugsgroesse_aenderung_art_chk;
ALTER TABLE bezugsgroesse_aenderung ADD CONSTRAINT bezugsgroesse_aenderung_art_chk
    CHECK (art IN ('angelegt', 'bearbeitet', 'archiviert', 'geloescht', 'stammdatum_eingetragen'));

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE bezugsgroesse_stammdatum ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsgroesse_stammdatum FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bezugsgroesse_stammdatum_tenant_isolation ON bezugsgroesse_stammdatum;
CREATE POLICY bezugsgroesse_stammdatum_tenant_isolation ON bezugsgroesse_stammdatum
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles — hier wird
-- ALLES genommen und eng neu gegeben (das Muster von `flaeche_gueltigkeit`): lesen,
-- eintragen, und am Intervall nur beenden (`gueltig_bis`) oder aufheben
-- (`aufgehoben_am`) — ein anderer Wert ist ein neues Intervall. Kein DELETE für die
-- Anwendung; die Verwaltungsrolle liest und löscht nur (das Offboarding).
-- -----------------------------------------------------------------------------
REVOKE ALL ON bezugsgroesse_stammdatum FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON bezugsgroesse_stammdatum TO ${appDbUser};
GRANT INSERT (id, tenant_id, bezugsgroesse_id, wertart, einheit, wert, gueltig_ab, gueltig_bis, created_by)
    ON bezugsgroesse_stammdatum TO ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON bezugsgroesse_stammdatum TO ${appDbUser};
GRANT SELECT, DELETE ON bezugsgroesse_stammdatum TO ${adminDbUser};

COMMENT ON TABLE bezugsgroesse_stammdatum IS
    'UEMS AP-09 E15: Bezugs-Stammdaten mit Gueltigkeit ab Tag (Mitarbeitende u. a.), Muster flaeche_gueltigkeit; nie eine Flaeche (E17).';
COMMENT ON FUNCTION bezugsdaten_groesse(TEXT) IS
    'Die Groesse einer Einheit aus bezugsdaten_vokabular(); NULL, wenn das Wort keine Einheit ist.';
