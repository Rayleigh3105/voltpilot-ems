-- =============================================================================
-- Zählerbaum (Konzept vp-zaehlerbaum-konzept, Captain-Entscheide E1-E5 vom
-- 10.11.2026, alle A): WO ein Zähler oder ein gemessener Verbraucher im
-- elektrischen Baum einer Anlage hängt - am Gerät im Aufbau, für jede Anlage,
-- privat wie gewerblich (E1 A). Vertrag docs/contracts/v2/zaehlerbaum.md mit
-- ZaehlerbaumRegeln (Java) und zaehlerbaum.ts (TS), gemeinsamen Vektoren
-- zaehlerbaum-vectors.json.
--
--   komponente_haengt_an   wo eine Komponente an welchem Tag im Baum hängt:
--                          `haengt_an` zeigt auf die ELTERN-Komponente
--                          (ein anderer Zähler derselben Anlage) - ein
--                          Verweis auf die Zeile, nicht auf ihr Kennzeichen.
--
-- Dieselbe Zeit-Mechanik wie `messstelle_stellung` (V20260911230000, UEMS
-- AP-04 IP-7): „gültig ab" ist ein TAG (00:00 der Standortzone); `gueltig_bis`
-- ist der letzte gültige Tag, einschließlich - NULL = offen; je Komponente
-- genau EIN Intervall je Tag (Exklusions-Constraint auf
-- daterange(ab, bis, '[]')); ein neues „gültig ab" beendet das laufende am
-- VORTAG; eine Korrektur hebt ein Intervall auf (`aufgehoben_am`) und lässt es
-- lesbar. Eine Intervall-Zeile wird nie gelöscht und nie umgeschrieben (Rechte
-- unten).
--
-- VORGABE (Bericht §3.1): eine Komponente OHNE Zeile hängt an der Wurzel (dem
-- Netzanschluss) - jede Bestandsanlage ist am ersten Tag zeichengleich zu
-- heute, ohne Rückfüllung.
--
-- WAS DIE DATENBANK NICHT PRÜFT (Regeln des Schreibwegs ZaehlerbaumService,
-- die die Anlage, den Baum oder die Rolle der Eltern-Komponente brauchen -
-- genau wie bei `messstelle_stellung`, Vorbild V20260911230000):
--   * dieselbe Anlage, kein Kreis, nicht an sich selbst, Eltern ist ein
--     Zähler (Netzanschluss oder Unterzähler), der Netzanschluss hängt
--     nirgends (Bericht R6, Gründe `fremde_anlage` · `zyklus` · `selbst` ·
--     `eltern_kein_zaehler`). Das urteilt ZaehlerbaumRegeln.haengtAnPruefen
--     an jedem Tag, an dem sich im neuen Intervall etwas ändert.
--   Die Datenbank hält die zeitlose Hälfte: genau ein Ziel, nicht auf sich
--   selbst, bis ≥ ab, keine Überlappung - und über die zusammengesetzten
--   Fremdschlüssel den Mandanten in JEDEM Verweis.
--
-- LÖSCHEN (Plan-Regel „nichts mit Historie wird gelöscht"): jeder Fremd-
-- schlüssel ist ON DELETE RESTRICT, die App-Rolle hat kein DELETE. Eine
-- Komponente mit eigener Zeile oder als Eltern einer anderen lässt sich
-- deshalb nicht löschen, solange die Zuordnung steht (wie heute bei anderen
-- Fremdschlüsseln auf measurement_point - AP-07 E8 ersetzt das Löschen
-- insgesamt irgendwann durch „ausgebaut").
--
-- `measurement_point` referenziert hier über die schon vorhandene
-- `uq_measurement_point_id_tenant` (V20260855000000) - keine neue
-- Eindeutigkeit nötig.
-- =============================================================================

CREATE TABLE IF NOT EXISTS komponente_haengt_an (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    komponente_id   UUID        NOT NULL,
    haengt_an       UUID        NOT NULL,
    gueltig_ab      DATE        NOT NULL,
    gueltig_bis     DATE,
    aufgehoben_am   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      TEXT,
    CONSTRAINT komponente_haengt_an_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Der Mandant reist in JEDEM Verweis mit (ein Fremdschlüssel prüft ohne RLS).
    CONSTRAINT komponente_haengt_an_komponente_fk FOREIGN KEY (komponente_id, tenant_id)
        REFERENCES measurement_point (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT komponente_haengt_an_eltern_fk FOREIGN KEY (haengt_an, tenant_id)
        REFERENCES measurement_point (id, tenant_id) ON DELETE RESTRICT,
    -- Grund `selbst` (R6): nie die eigene Eltern-Komponente.
    CONSTRAINT komponente_haengt_an_nicht_selbst
        CHECK (haengt_an IS DISTINCT FROM komponente_id),
    CONSTRAINT komponente_haengt_an_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    -- Je Komponente genau EINE Zuordnung je Tag.
    CONSTRAINT komponente_haengt_an_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        komponente_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);
-- „Was hängt an dieser Komponente?" (der Baum, der Zyklus-Test) und „wo hängt
-- diese Komponente heute?" (die Geräteliste, der Hinzufügen-Ablauf).
CREATE INDEX IF NOT EXISTS idx_komponente_haengt_an_komponente
    ON komponente_haengt_an (komponente_id, gueltig_ab);
CREATE INDEX IF NOT EXISTS idx_komponente_haengt_an_eltern
    ON komponente_haengt_an (haengt_an, gueltig_ab);

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE komponente_haengt_an ENABLE ROW LEVEL SECURITY;
ALTER TABLE komponente_haengt_an FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS komponente_haengt_an_tenant_isolation ON komponente_haengt_an;
CREATE POLICY komponente_haengt_an_tenant_isolation ON komponente_haengt_an
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle - hier wird weggenommen, was es nicht geben darf. Die
-- BYPASSRLS-Rolle voltpilot_admin deckt V4s ALTER DEFAULT PRIVILEGES ab (das
-- Offboarding löscht über sie).
--
-- Ein Intervall wird beendet oder aufgehoben - nie gelöscht, nie umgeschrieben:
-- Komponente, Anlage und Eltern bleiben, wie sie eingetragen wurden.
GRANT SELECT, INSERT ON komponente_haengt_an TO ${appDbUser};
REVOKE UPDATE, DELETE ON komponente_haengt_an FROM ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON komponente_haengt_an TO ${appDbUser};

COMMENT ON TABLE komponente_haengt_an IS
    'Zeitgültige Eltern-Zuordnung einer Komponente im elektrischen Baum einer Anlage '
    '(Zählerbaum-Konzept, Captain-Entscheide E1-E5 vom 10.11.2026); nie überschrieben, '
    'nur beendet oder aufgehoben. Vertrag docs/contracts/v2/zaehlerbaum.md.';
