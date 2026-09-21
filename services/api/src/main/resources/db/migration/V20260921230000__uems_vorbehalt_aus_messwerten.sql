-- =============================================================================
-- UEMS AP-15 IP-13 — der VORBEHALT AUS MESSWERTEN (Konzept vp-uems-ap15-verbund
-- §4.4 B4, Kasten W10, Matrixzeile A20, Fall R23; entschieden am 21.09.2026;
-- Vertrag docs/contracts/v2/steuerungsverbund.md §8).
--
--   steuerungsverbund_bilanz   + hoechstes_ungeregeltes_kw/_von: der höchste
--                              BELEGTE Viertelstundenwert des Ungeregelten des
--                              Tages — dieselbe Rechnung wie die Bilanz (IP-12),
--                              nur ihr anderes Ende; unvollständige
--                              Viertelstunden zählen nicht (W10)
--   steuerungsverbund_vorbehalt  je selbsttätiger ERHÖHUNG und je VORSCHLAG zum
--                              Senken eine Zeile: Zahl, Herkunft (Höchstwert,
--                              seine Viertelstunde, Zeitraum, Messtage), was der
--                              Zweischritt daraus machte; ein Vorschlag wird nur
--                              durch die Plattform-Rolle wirksam
--   steuerungsverbund_aenderung  art + 'vorbehalt' (Protokoll jeder wirksamen
--                              Änderung des Vorbehalts)
--
-- Die Regel ist uems/VorbehaltRegel (rein, Vektoren
-- docs/contracts/v2/vorbehalt-vectors.json); der Lauf uems/VorbehaltLaeufer.
-- Diese Migration legt KEINE Zeile an und ändert keine: eine Anlage ohne
-- Gemeinsame Steuerung bekommt nie eine (I6, R22).
--
-- ⚠ Der art-CHECK des Protokolls ist die VEREINIGUNG aller Wörter, die bis
-- hierher gebaut sind (IP-4 V20260921140000) plus 'vorbehalt'. Wer ihn später
-- erweitert, schreibt wieder die Vereinigung — nie nur seinen Stand, sonst
-- verengt eine später eintreffende Migration ihn out-of-order. Beim Bau
-- (21.09.2026) trug kein offener PR gegen uems eine Migration.
-- =============================================================================

ALTER TABLE steuerungsverbund_bilanz ADD COLUMN IF NOT EXISTS hoechstes_ungeregeltes_kw NUMERIC;
ALTER TABLE steuerungsverbund_bilanz ADD COLUMN IF NOT EXISTS hoechstes_von TIMESTAMPTZ;

ALTER TABLE steuerungsverbund_aenderung DROP CONSTRAINT IF EXISTS steuerungsverbund_aenderung_art_chk;
ALTER TABLE steuerungsverbund_aenderung ADD CONSTRAINT steuerungsverbund_aenderung_art_chk
    CHECK (art IN ('eingerichtet', 'stufe', 'epoche', 'mitglied', 'anlage_entfernt', 'vorbehalt'));

CREATE TABLE IF NOT EXISTS steuerungsverbund_vorbehalt (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    site_id              UUID        NOT NULL,
    steuerungsverbund_id UUID        NOT NULL,
    -- Heute nur die Bezugsseite (B4); die Einspeiseseite bleibt erklärt.
    richtung             TEXT        NOT NULL DEFAULT 'bezug',
    -- erhoeht = selbsttätig wirksam (verengt nur) · vorschlag = senken, wartet
    -- auf die Freigabe der Plattform-Rolle
    art                  TEXT        NOT NULL,
    zustand              TEXT        NOT NULL,
    alt_kw               NUMERIC,
    neu_kw               NUMERIC     NOT NULL,
    -- Die Herkunft: höchster belegter Viertelstundenwert des Ungeregelten, seine
    -- Viertelstunde, der Zeitraum (Tage der Anlage, beide eingeschlossen) und
    -- wie viele Tage darin gemessen sind.
    hoechstwert_kw       NUMERIC     NOT NULL,
    hoechstwert_von      TIMESTAMPTZ,
    zeitraum_von         DATE        NOT NULL,
    zeitraum_bis         DATE        NOT NULL,
    messtage             INTEGER     NOT NULL,
    fassung              TEXT        NOT NULL,
    -- Was der Zweischritt daraus machte (SteuerungsverbundAnteilDienst.Grund,
    -- klein; veroeffentlicht = Übergang gesendet). NULL, solange nichts wirkt.
    anteile              TEXT,
    erstellt_von         TEXT        NOT NULL,
    erstellt_am          TIMESTAMPTZ NOT NULL DEFAULT now(),
    entschieden_von      TEXT,
    entschieden_am       TIMESTAMPTZ,
    CONSTRAINT steuerungsverbund_vorbehalt_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT steuerungsverbund_vorbehalt_verbund_fk FOREIGN KEY (steuerungsverbund_id, site_id, tenant_id)
        REFERENCES steuerungsverbund (id, site_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT steuerungsverbund_vorbehalt_richtung_chk CHECK (richtung IN ('einspeisung', 'bezug')),
    CONSTRAINT steuerungsverbund_vorbehalt_art_chk CHECK (art IN ('erhoeht', 'vorschlag')),
    CONSTRAINT steuerungsverbund_vorbehalt_zustand_chk
        CHECK ((art = 'erhoeht' AND zustand = 'wirksam')
               OR (art = 'vorschlag' AND zustand IN ('offen', 'freigegeben', 'ersetzt', 'hinfaellig'))),
    -- Erhöhen verengt nur: neu > alt. Ein Vorschlag erweitert: neu < alt, oder
    -- es gab noch keinen Wert.
    CONSTRAINT steuerungsverbund_vorbehalt_richtung_der_zahl_chk
        CHECK ((art = 'erhoeht' AND alt_kw IS NOT NULL AND neu_kw > alt_kw)
               OR (art = 'vorschlag' AND (alt_kw IS NULL OR neu_kw < alt_kw))),
    CONSTRAINT steuerungsverbund_vorbehalt_zahl_chk CHECK (neu_kw >= 0 AND hoechstwert_kw IS NOT NULL),
    CONSTRAINT steuerungsverbund_vorbehalt_zeitraum_chk CHECK (zeitraum_von <= zeitraum_bis AND messtage >= 0),
    CONSTRAINT steuerungsverbund_vorbehalt_anteile_chk
        CHECK (anteile IS NULL OR anteile IN ('veroeffentlicht', 'kein_verbund', 'stufe_zu_frueh',
               'noch_nicht_scharf', 'auslegung_passt_nicht', 'zweischritt_laeuft', 'rueckgespielt',
               'wirksame_anteile_unbekannt', 'unveraendert')),
    CONSTRAINT steuerungsverbund_vorbehalt_entschieden_chk
        CHECK ((zustand IN ('wirksam', 'offen')) = (entschieden_am IS NULL)
               AND (entschieden_am IS NULL OR btrim(coalesce(entschieden_von, '')) <> '')),
    CONSTRAINT steuerungsverbund_vorbehalt_von_chk CHECK (btrim(erstellt_von) <> '')
);
-- Höchstens EIN offener Vorschlag je Verbund und Richtung.
CREATE UNIQUE INDEX IF NOT EXISTS steuerungsverbund_vorbehalt_ein_offener
    ON steuerungsverbund_vorbehalt (steuerungsverbund_id, richtung) WHERE zustand = 'offen';
CREATE INDEX IF NOT EXISTS idx_steuerungsverbund_vorbehalt_verbund
    ON steuerungsverbund_vorbehalt (steuerungsverbund_id, erstellt_am DESC);

-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
ALTER TABLE steuerungsverbund_vorbehalt ENABLE ROW LEVEL SECURITY;
ALTER TABLE steuerungsverbund_vorbehalt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steuerungsverbund_vorbehalt_tenant_isolation ON steuerungsverbund_vorbehalt;
CREATE POLICY steuerungsverbund_vorbehalt_tenant_isolation ON steuerungsverbund_vorbehalt
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Rechte: lesen, anhängen und NUR den Entscheid eines Vorschlags bzw. das
-- Ergebnis des Zweischritts nachtragen; Zahl und Herkunft ändert niemand. Das
-- Offboarding (TenantRepository.offboard) räumt vor dem Verbund ab; die Metrik
-- liest über die Admin-Rolle.
REVOKE ALL ON steuerungsverbund_vorbehalt FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON steuerungsverbund_vorbehalt TO ${appDbUser};
GRANT UPDATE (zustand, entschieden_von, entschieden_am, anteile) ON steuerungsverbund_vorbehalt TO ${appDbUser};
GRANT SELECT, DELETE ON steuerungsverbund_vorbehalt TO ${adminDbUser};
