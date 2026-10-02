-- MiSpeL MP-5: der Förderweg je Einspeisestelle (Entscheid E2 = B, 02.10.2026)
-- nach der Festlegung der BNetzA zur Marktintegration von Speichern und
-- Ladepunkten (Beschluss 01.10.2026). Vertrag: docs/contracts/v2/mispel-foerderweg.md.
--
-- „Förderweg“ ist das Produktwort für Veräußerungsform und Option zusammen
-- (Bauplan § 8.5); jeder Wert trägt den Begriff aus EEG und Festlegung:
--   einspeiseverguetung              Einspeisevergütung (§ 19 Abs. 1 Nr. 2 EEG)
--   marktpraemie_ausschliesslichkeit Marktprämie, Ausschließlichkeitsoption (§ 19 Abs. 3 S. 1 Nr. 1, Abs. 3a EEG)
--   marktpraemie_abgrenzung          Marktprämie, Abgrenzungsoption (§ 19 Abs. 3b EEG, Anlage 1)
--   marktpraemie_pauschal            Marktprämie, Pauschaloption (§ 19 Abs. 3c EEG, Anlage 2)
--   ungefoerdert                     ungeförderte Direktvermarktung (heute der Händler-Modus)
-- Die Einspeisestelle ist die Anlage (`site`): an ihr hängen heute Netzlade-
-- Schalter, Plan und Box.
--
-- BESTAND OHNE ZEILE: die Tabelle beginnt LEER, keine Bestandszeile ändert sich.
-- Eine Anlage ohne Fassung hat den Förderweg, den ihre heutigen Schalter
-- bedeuten (FoerderwegRegeln.ausBestand): netzladen_erlaubt = TRUE →
-- ungefoerdert; sonst plant_kind direktvermarktung → marktpraemie_ausschliesslichkeit,
-- eigenverbrauch → einspeiseverguetung. Optimierer und Box lesen weiter
-- site.netzladen_erlaubt und site.plant_kind — für jede Bestandsanlage also
-- bitgenau dasselbe. Erst die erste Fassung macht den Förderweg zur einzigen
-- Wahrheit; der Schreibweg hält dann beide Spalten als Spiegel nach.
--
-- FASSUNGEN STATT ÜBERSCHREIBEN (wie V20261002121500): jede Zeile gilt ab einem
-- TAG (gesetzliche Zeit, A1 S. 33) bis zum Tag vor der nächsten Fassung; eine
-- Korrektur desselben Tages hebt die alte Zeile auf (`aufgehoben_am`).
--
-- Was die Datenbank NICHT prüft (Regeln des Schreibwegs FoerderwegRegeln, die
-- die vorige Fassung brauchen): Wechsel nur zum ersten Kalendertag eines
-- Monats (§ 21b Abs. 1 S. 2 EEG, A1 S. 103), die Bindung des Formelsatzes bis
-- zum Ende des Kalenderjahres (A1 S. 24, Abschn. 3.2.3), die Übergangszeit
-- (Tenor Ziff. 9a/9b).

CREATE TABLE IF NOT EXISTS site_foerderweg (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID        NOT NULL,
    site_id               UUID        NOT NULL,
    foerderweg            TEXT        NOT NULL,
    -- Der Formelsatz der Anlage 1 (MP-4, docs/contracts/v2/mispel-abgrenzung.md).
    -- Pflicht in der Abgrenzungsoption; in der ungeförderten Direktvermarktung
    -- wahlfrei für die Umlageprivilegien (Tenor Ziff. 1 S. 2); sonst leer.
    formelsatz            TEXT,
    -- Bis 30.09.2027 nur im Einverständnis mit Netz- und Messstellenbetreiber
    -- (Tenor Ziff. 9a). Die Angabe des Kunden, keine Prüfung durch VoltPilot.
    einverstaendnis       BOOLEAN     NOT NULL DEFAULT FALSE,
    gueltig_ab            DATE        NOT NULL,
    aufgehoben_am         TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by            TEXT,
    CONSTRAINT site_foerderweg_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT site_foerderweg_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    -- Das geschlossene Vokabular von FoerderwegRegeln.Foerderweg.
    CONSTRAINT site_foerderweg_foerderweg_chk CHECK (foerderweg IN ('einspeiseverguetung',
        'marktpraemie_ausschliesslichkeit', 'marktpraemie_abgrenzung', 'marktpraemie_pauschal', 'ungefoerdert')),
    -- Die Formelsätze des Vertrags MP-4 (E5 = B); weitere kommen per neuer Migration.
    CONSTRAINT site_foerderweg_formelsatz_chk
        CHECK (formelsatz IS NULL OR formelsatz IN ('A1', 'A5', 'A5-Variante', 'A10', 'A11')),
    CONSTRAINT site_foerderweg_formelsatz_passt_chk CHECK (
        (foerderweg = 'marktpraemie_abgrenzung' AND formelsatz IS NOT NULL)
        OR (foerderweg = 'ungefoerdert')
        OR (foerderweg IN ('einspeiseverguetung', 'marktpraemie_ausschliesslichkeit', 'marktpraemie_pauschal')
            AND formelsatz IS NULL))
);

-- Je Anlage und Tag höchstens EINE wirksame Fassung.
CREATE UNIQUE INDEX IF NOT EXISTS site_foerderweg_ein_tag
    ON site_foerderweg (site_id, gueltig_ab) WHERE aufgehoben_am IS NULL;
CREATE INDEX IF NOT EXISTS idx_site_foerderweg_tenant
    ON site_foerderweg (tenant_id, site_id, gueltig_ab);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE site_foerderweg ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_foerderweg FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_foerderweg_tenant_isolation ON site_foerderweg;
CREATE POLICY site_foerderweg_tenant_isolation ON site_foerderweg
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Lesen, anhängen, aufheben; gelöscht wird nur mit der Anlage oder im Offboarding.
REVOKE ALL ON site_foerderweg FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON site_foerderweg TO ${appDbUser};
GRANT UPDATE (aufgehoben_am) ON site_foerderweg TO ${appDbUser};
GRANT SELECT, DELETE ON site_foerderweg TO ${adminDbUser};

COMMENT ON TABLE site_foerderweg IS
    'MiSpeL MP-5: Förderweg je Einspeisestelle (Veräußerungsform und Option) als Fassungen ab einem Tag; ohne Zeile gilt der Bestand aus netzladen_erlaubt/plant_kind.';
