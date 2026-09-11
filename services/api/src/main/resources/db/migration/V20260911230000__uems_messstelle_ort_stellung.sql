-- =============================================================================
-- UEMS AP-04 IP-7 (Teil Ort und elektrische Stellung): die zeitgültige
-- Zuordnung der MESSSTELLE zu ihrem Ort und zu ihrer Stellung im elektrischen
-- Baum einer Anlage (Konzept vp-uems-ap04-messstellen §4.1/§6.2/§8, Captain-
-- Entscheide E12 vom 10.09.2026). Maßgeblich sind der Messstellen-Vertrag
-- docs/contracts/v2/messstelle.md (§1 `orte`/`elektrische_stellung`, §6
-- Regel 8) mit MessstelleRegeln und für die Tage der Ortsbaum-Vertrag
-- docs/contracts/v2/ortsbaum-vectors.json mit OrtsbaumAbleitung — die
-- Mechanik von AP-02, die AP-04 übernimmt.
--
--   messstelle_ort       wo eine Messstelle an welchem Tag sitzt: am
--                        Unternehmen, an einem Standort ODER an einem Ort
--                        (Gebäude, Bereich) — je Zeile genau eines
--   messstelle_stellung  wo sie an welchem Tag im elektrischen Baum steht:
--                        Anlage + Stellung + „Unterzähler von" (Bezug-Messstelle)
--
-- Dazu weitet sie den CHECK `messstelle_aenderung_art_chk` um die vier Arten
-- ort_zugeordnet · ort_korrigiert · stellung_zugeordnet · stellung_korrigiert
-- (den Stand von V20260911140000 abgeschrieben). Sonst bleibt jede bestehende
-- Tabelle zeichengleich; die Box kennt keine Messstellen.
--
-- Prozess- und Kostenstellen-Zuordnung (messstelle_prozess,
-- messstelle_kostenstelle) sind NICHT dieses Paket: sie warten auf die
-- Prozess- und Kostenstellen-OBJEKTE (AP-00), statt eine Freitext-Referenz
-- anzulegen, die später migriert werden müsste.
--
-- DIE TAGE (AP-02 E9, dieselbe Mechanik wie ort_zuordnung/anlage_standort):
-- „gültig ab" ist ein TAG (00:00 in der Zeitzone des Standorts); `gueltig_bis`
-- ist der LETZTE gültige Tag, einschließlich — NULL = offen; je Messstelle
-- genau EIN Intervall je Tag (Exklusions-Constraint auf
-- daterange(ab, bis, '[]')); ein neues „gültig ab" beendet das laufende am
-- VORTAG; eine Korrektur hebt ein Intervall auf (`aufgehoben_am`) und lässt es
-- lesbar. Eine Intervall-Zeile wird nie gelöscht und nie umgeschrieben (Rechte
-- unten). Rückwirkung ist erlaubt und steht im Protokoll (messstelle_aenderung,
-- `rueckwirkend`); die Zeile trägt `created_at`, der Eintragstag ist ablesbar.
--
-- WAS DIE DATENBANK NICHT PRÜFT (Regeln des Schreibwegs MessstelleZuordnungService,
-- die den Tag, den Baum oder andere Messstellen brauchen):
--   * „Das Ziel besteht an JEDEM Tag des neuen Intervalls" (Ortsbaum-Gründe
--     `ziel_gab_es_noch_nicht`, `ziel_archiviert` → 422 `ort_ungueltig`) —
--     dieselbe Begründung wie in V20260911110000.
--   * „Unternehmen" nur für eine BERECHNETE Messstelle (Vertrag, `ortArt`):
--     die Art steht an der Messstelle, die Zeile kennt sie nicht.
--   * Regel 8 über mehrere Messstellen (E12): „Unterzähler von" zeigt auf eine
--     Messstelle DERSELBEN Anlage, ohne Zyklus; je Anlage und Richtung höchstens
--     EIN Hauptzähler, alle am selben Zähler; berechnet oder Medium ≠ Strom nur
--     „keine". Das urteilt MessstelleRegeln.stellungPruefen an jedem Tag, an
--     dem sich im neuen Intervall etwas ändert.
--   Die Datenbank hält die zeitlose Hälfte: Vokabular, genau ein Ziel,
--   „Unterzähler von" genau bei „Unterzähler" und nie auf sich selbst, bis ≥ ab,
--   keine Überlappung — und über die zusammengesetzten Fremdschlüssel den
--   Mandanten in JEDEM Verweis.
--
-- LÖSCHEN (Plan-Regel „nichts mit Historie wird gelöscht"): jeder Fremd-
-- schlüssel ist ON DELETE RESTRICT, die App-Rolle hat auf beiden Tabellen kein
-- DELETE. Das Offboarding (TenantRepository.offboard) räumt sie ausdrücklich
-- ab, VOR der Messstelle und vor der Kaskade über `site`. Eine Anlage mit
-- Messstellen-Stellung lässt sich deshalb (wie mit Standort-Zuordnung,
-- V20260911100000) nicht löschen, solange die Stellung steht; ein Standort,
-- Gebäude oder Bereich mit Messstelle ebenso nicht.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- messstelle_ort — wo eine Messstelle an welchem Tag sitzt (Vertrag §1 `orte`)
-- -----------------------------------------------------------------------------
-- Genau EIN Ziel je Zeile: das Unternehmen des Kundenbereichs (Kennzeichen „U",
-- nur berechnet — MS-19), ein Standort (MS-01 am Zählerplatz) oder ein Ort des
-- Baums (Gebäude MS-03, Bereich MS-06). Die App-Rolle darf nur `gueltig_bis`
-- und `aufgehoben_am` ändern (Rechte unten).
CREATE TABLE IF NOT EXISTS messstelle_ort (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    messstelle_id   UUID        NOT NULL,
    unternehmen_id  UUID,
    standort_id     UUID,
    ort_id          UUID,
    gueltig_ab      DATE        NOT NULL,
    gueltig_bis     DATE,
    aufgehoben_am   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    CONSTRAINT messstelle_ort_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Der Mandant reist in JEDEM Verweis mit (ein Fremdschlüssel prüft ohne RLS).
    CONSTRAINT messstelle_ort_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_ort_unternehmen_fk FOREIGN KEY (unternehmen_id, tenant_id)
        REFERENCES unternehmen (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_ort_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_ort_ort_fk FOREIGN KEY (ort_id, tenant_id)
        REFERENCES ort (id, tenant_id) ON DELETE RESTRICT,
    -- „Je Tag genau ein Ort" beginnt bei der Zeile: genau EIN Ziel (num_nonnulls
    -- ist nie NULL).
    CONSTRAINT messstelle_ort_genau_ein_ziel
        CHECK (num_nonnulls(unternehmen_id, standort_id, ort_id) = 1),
    -- ab = bis ist erlaubt: ein Tag ist ein Intervall.
    CONSTRAINT messstelle_ort_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    -- Je Messstelle genau EIN Ort je Tag. '[]', weil `bis` der letzte Tag IST;
    -- ein aufgehobenes Intervall belegt keinen Tag mehr; tenant_id vorn, weil der
    -- Constraint VOR dem Fremdschlüssel und ohne RLS prüft (V20260911100000).
    CONSTRAINT messstelle_ort_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        messstelle_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);
-- „Was hängt an diesem Standort / Ort?" (Archiv-Sperre, Register) — und die
-- RESTRICT-Prüfung beim Löschen eines Ziels.
CREATE INDEX IF NOT EXISTS idx_messstelle_ort_standort
    ON messstelle_ort (standort_id, gueltig_ab) WHERE standort_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messstelle_ort_ort
    ON messstelle_ort (ort_id, gueltig_ab) WHERE ort_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messstelle_ort_unternehmen
    ON messstelle_ort (unternehmen_id) WHERE unternehmen_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- messstelle_stellung — wo eine Messstelle an welchem Tag im elektrischen Baum
-- steht (Vertrag §1 `elektrische_stellung`, §6)
-- -----------------------------------------------------------------------------
-- Die Anlage ist die heutige `site`. Die Stellung ist das Wort des Vertrags
-- (Kundenwort mit Umlaut, wie `messstelle.richtung`). „Unterzähler von" ist die
-- Bezug-Messstelle — ein Verweis auf die Zeile, nicht auf ihr Kennzeichen:
-- eine Umbenennung (E7) ändert die Stellung nicht.
CREATE TABLE IF NOT EXISTS messstelle_stellung (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID        NOT NULL,
    messstelle_id     UUID        NOT NULL,
    site_id           UUID        NOT NULL,
    stellung          TEXT        NOT NULL,
    unterzaehler_von  UUID,
    gueltig_ab        DATE        NOT NULL,
    gueltig_bis       DATE,
    aufgehoben_am     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by        TEXT,
    CONSTRAINT messstelle_stellung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_stellung_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    -- Über uq_site_id_tenant_identity (V20260844000000): nur eine Anlage
    -- SEINES Mandanten.
    CONSTRAINT messstelle_stellung_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_stellung_bezug_fk FOREIGN KEY (unterzaehler_von, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    -- Das geschlossene Vokabular von MessstelleRegeln.STELLUNGEN.
    CONSTRAINT messstelle_stellung_chk CHECK (stellung IN
        ('Hauptzähler', 'Unterzähler', 'Erzeuger', 'Speicher', 'Abzweig', 'keine')),
    -- Vertrag §6, Gründe `bezug_nur_bei_unterzaehler` und `bezug_fehlt`: der
    -- Bezug steht GENAU bei „Unterzähler".
    CONSTRAINT messstelle_stellung_bezug_genau_bei_unterzaehler
        CHECK ((stellung = 'Unterzähler') = (unterzaehler_von IS NOT NULL)),
    -- Grund `selbst`: nie der eigene Unterzähler.
    CONSTRAINT messstelle_stellung_nicht_selbst
        CHECK (unterzaehler_von IS DISTINCT FROM messstelle_id),
    CONSTRAINT messstelle_stellung_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    -- Je Messstelle genau EINE Stellung je Tag (wie oben).
    CONSTRAINT messstelle_stellung_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        messstelle_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);
-- „Welche Messstellen stehen in dieser Anlage?" (Hauptzähler-Regel, Bilanz AP-10)
-- und „wer ist Unterzähler von …?" (die Kette, der Zyklus).
CREATE INDEX IF NOT EXISTS idx_messstelle_stellung_site
    ON messstelle_stellung (site_id, gueltig_ab);
CREATE INDEX IF NOT EXISTS idx_messstelle_stellung_bezug
    ON messstelle_stellung (unterzaehler_von) WHERE unterzaehler_von IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Das Protokoll kennt die Zuordnungen. Der Stand von V20260911140000,
-- abgeschrieben und geweitet:
--   ort_zugeordnet · stellung_zugeordnet  ein neues „gültig ab" (das laufende
--                                         Intervall endet am Vortag) oder die
--                                         erste Zuordnung
--   ort_korrigiert · stellung_korrigiert  ein Intervall ab seinem Beginn ersetzt
--                                         (das alte ist aufgehoben, lesbar)
-- `gilt_ab` ist dabei Mitternacht des Tages in der Zeitzone des Unternehmens;
-- `alt`/`neu` tragen das Intervall vorher/nachher in der Form des Vertrags.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_aenderung DROP CONSTRAINT IF EXISTS messstelle_aenderung_art_chk;
ALTER TABLE messstelle_aenderung ADD CONSTRAINT messstelle_aenderung_art_chk CHECK (art IN (
    'angelegt', 'bearbeitet', 'angehalten', 'fortgesetzt', 'archiviert',
    'nebengroesse_hinzugefuegt', 'nebengroesse_archiviert',
    'ort_zugeordnet', 'ort_korrigiert', 'stellung_zugeordnet', 'stellung_korrigiert'));

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_ort ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_ort FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_ort_tenant_isolation ON messstelle_ort;
CREATE POLICY messstelle_ort_tenant_isolation ON messstelle_ort
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messstelle_stellung ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_stellung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_stellung_tenant_isolation ON messstelle_stellung;
CREATE POLICY messstelle_stellung_tenant_isolation ON messstelle_stellung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird weggenommen, was es nicht geben darf. Die
-- BYPASSRLS-Rolle voltpilot_admin deckt V4s ALTER DEFAULT PRIVILEGES ab (das
-- Offboarding löscht über sie). Das REVOKE auf Tabellenebene nimmt auch
-- Spaltenrechte mit; das GRANT danach setzt genau die genannten wieder — ein
-- erneuter Lauf landet im selben Zustand.
--
-- Ein Intervall wird beendet oder aufgehoben — nie gelöscht, nie umgeschrieben:
-- Beginn, Ziel, Anlage, Stellung und Bezug bleiben, wie sie eingetragen wurden.
GRANT SELECT, INSERT ON messstelle_ort TO ${appDbUser};
REVOKE UPDATE, DELETE ON messstelle_ort FROM ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON messstelle_ort TO ${appDbUser};

GRANT SELECT, INSERT ON messstelle_stellung TO ${appDbUser};
REVOKE UPDATE, DELETE ON messstelle_stellung FROM ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON messstelle_stellung TO ${appDbUser};
