-- =============================================================================
-- UEMS AP-03 IP-5: der Standort-Zaun in der Datenbank — Policy `site_scope`
-- =============================================================================
--
-- Seit IP-4 setzt `TenantAwareDataSource` je Verbindung neben `app.tenant_id`
-- die Einstellungen `app.zugriff` (unternehmen | standorte) und
-- `app.standort_ids` ('{uuid,…}'). Diese Migration ist ihr Leser (AP-03 §6.2
-- Punkt 3): eine RESTRICTIVE Policy `site_scope` auf `site`, `standort`,
-- `anlage_standort`, `ort`, `measurement_point` und `device`. RESTRICTIVE heißt: sie wird
-- mit der Mandanten-Policy UND-verknüpft, die unverändert bleibt (§6.3 additiv).
--
-- Sichtbar ist eine Zeile, wenn
--   * `app.zugriff` LEER ist (NULL auf einer frischen Verbindung, '' nach dem
--     Zurücksetzen): kein Zugriff im Spiel — Jobs, Takt, Start-Läufer,
--     `/admin/**`, die Plattform ohne Kopf. Es gilt allein der Mandanten-Zaun,
--     genau wie vor diesem Paket;
--   * `app.zugriff` = 'unternehmen': Kundenkonto mit mandantenweiter Zuweisung
--     (nach der Bestandsübernahme E12 jedes heutige Konto) oder der Umschalter;
--   * sonst NUR, wenn der Standort der Zeile in `app.standort_ids` liegt — bei
--     Anlage und Gebäude/Bereich der Standort HEUTE (Tag in der Zeitzone des
--     Unternehmens, wie `StandortLesemodell.heute`). Jeder andere Wert als
--     leer/'unternehmen' ist der enge Zaun, auch ein Tippfehler.
--
-- Rechte hängen am Standort, Daten am Stichtag (A16): wer ST-1 hat, sieht die
-- Anlage, solange sie HEUTE an ST-1 hängt; die beendete Zuordnung an ST-1 bleibt
-- sichtbar (Berichte über die Vergangenheit), die neue an ST-3 nicht.
-- Eine Anlage OHNE gültige Zuordnung ist für standortbeschränkte Nutzer
-- unsichtbar, für unternehmensweite sichtbar (AP-03 §8 IP-5).
--
-- Schreiben (WITH CHECK): wo die Zeile ihren Standort selbst nennt (`standort`,
-- `anlage_standort`, `measurement_point` und `device` über ihre Anlage), gilt dieselbe
-- Bedingung. `site` und `ort` bekommen ihren Standort erst mit der NÄCHSTEN
-- Zeile (Zuordnung) — ihr Anlegen ist eine Frage des Rechts (IP-6), nicht des
-- Zauns; ändern und löschen lässt USING nur an sichtbaren Zeilen zu.
--
-- Die Prüffunktionen sind SECURITY INVOKER: sie lesen `anlage_standort`,
-- `ort_zuordnung` und `unternehmen` unter DERSELBEN Rolle und damit unter deren
-- Policies. Keine der Policies liest `site` oder `ort` zurück (kein Zyklus).
-- PARALLEL SAFE, weil sie nur Sitzungs-Einstellungen, `now()` und Tabellen
-- lesen; die Einstellungen gehen mit dem GUC-Zustand an parallele Worker. Das
-- CASE wertet die Funktion nur im engen Zaun aus — der Bestand bezahlt nichts.
-- =============================================================================

CREATE OR REPLACE FUNCTION uems_zugriff_unternehmensweit() RETURNS BOOLEAN
    LANGUAGE sql STABLE PARALLEL SAFE
AS $$
    SELECT coalesce(NULLIF(current_setting('app.zugriff', true), ''), 'unternehmen') = 'unternehmen'
$$;

CREATE OR REPLACE FUNCTION uems_zugriff_standort_ids() RETURNS UUID[]
    LANGUAGE sql STABLE PARALLEL SAFE
AS $$
    SELECT coalesce(NULLIF(current_setting('app.standort_ids', true), '')::uuid[], '{}'::uuid[])
$$;

-- „Heute" eines Kundenbereichs: der Tag in der Zeitzone seines Unternehmens.
CREATE OR REPLACE FUNCTION uems_zugriff_heute(p_tenant UUID) RETURNS DATE
    LANGUAGE sql STABLE PARALLEL SAFE
AS $$
    SELECT (now() AT TIME ZONE coalesce(
               (SELECT u.zeitzone FROM unternehmen u WHERE u.tenant_id = p_tenant),
               'Europe/Berlin'))::date
$$;

-- Hängt die Anlage heute an einem Standort der Anfrage?
CREATE OR REPLACE FUNCTION uems_zugriff_anlage_sichtbar(p_site UUID, p_tenant UUID) RETURNS BOOLEAN
    LANGUAGE sql STABLE PARALLEL SAFE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM anlage_standort a
         WHERE a.tenant_id = p_tenant
           AND a.site_id = p_site
           AND a.aufgehoben_am IS NULL
           AND daterange(a.gueltig_ab, a.gueltig_bis, '[]') @> uems_zugriff_heute(p_tenant)
           AND a.standort_id = ANY (uems_zugriff_standort_ids()))
$$;

-- Hängt das Gebäude oder der Bereich heute an einem Standort der Anfrage?
-- Ein Gebäude hängt direkt am Standort, ein Bereich am Standort oder an einem
-- Gebäude (genau ein Elternteil, `ort_zuordnung_genau_ein_eltern`; nie Bereich
-- unter Bereich) — darum reicht EINE Stufe.
CREATE OR REPLACE FUNCTION uems_zugriff_ort_sichtbar(p_ort UUID, p_tenant UUID) RETURNS BOOLEAN
    LANGUAGE sql STABLE PARALLEL SAFE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM ort_zuordnung z
          LEFT JOIN ort_zuordnung g
            ON g.tenant_id = z.tenant_id
           AND g.ort_id = z.eltern_ort_id
           AND g.aufgehoben_am IS NULL
           AND daterange(g.gueltig_ab, g.gueltig_bis, '[]') @> uems_zugriff_heute(p_tenant)
         WHERE z.tenant_id = p_tenant
           AND z.ort_id = p_ort
           AND z.aufgehoben_am IS NULL
           AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> uems_zugriff_heute(p_tenant)
           AND coalesce(z.eltern_standort_id, g.eltern_standort_id) = ANY (uems_zugriff_standort_ids()))
$$;

GRANT EXECUTE ON FUNCTION uems_zugriff_unternehmensweit() TO ${appDbUser};
GRANT EXECUTE ON FUNCTION uems_zugriff_standort_ids() TO ${appDbUser};
GRANT EXECUTE ON FUNCTION uems_zugriff_heute(UUID) TO ${appDbUser};
GRANT EXECUTE ON FUNCTION uems_zugriff_anlage_sichtbar(UUID, UUID) TO ${appDbUser};
GRANT EXECUTE ON FUNCTION uems_zugriff_ort_sichtbar(UUID, UUID) TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- Die Policies
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS site_scope ON site;
CREATE POLICY site_scope ON site AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE uems_zugriff_anlage_sichtbar(id, tenant_id) END)
    WITH CHECK (true);

DROP POLICY IF EXISTS site_scope ON standort;
CREATE POLICY site_scope ON standort AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE id = ANY (uems_zugriff_standort_ids()) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE id = ANY (uems_zugriff_standort_ids()) END);

DROP POLICY IF EXISTS site_scope ON anlage_standort;
CREATE POLICY site_scope ON anlage_standort AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE standort_id = ANY (uems_zugriff_standort_ids()) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE standort_id = ANY (uems_zugriff_standort_ids()) END);

DROP POLICY IF EXISTS site_scope ON ort;
CREATE POLICY site_scope ON ort AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE uems_zugriff_ort_sichtbar(id, tenant_id) END)
    WITH CHECK (true);

DROP POLICY IF EXISTS site_scope ON measurement_point;
CREATE POLICY site_scope ON measurement_point AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE uems_zugriff_anlage_sichtbar(site_id, tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE uems_zugriff_anlage_sichtbar(site_id, tenant_id) END);

-- Das Gerät (Box, Wechselrichter, Zähler) gehört wie die Messkomponente seiner
-- Anlage (`device.site_id`, NOT NULL). Die §8-Zelle nennt es nicht; die Routen
-- `/api/v1/devices/{id}` (ändern, löschen, Daten löschen), der Claim eines schon
-- bekannten Geräts und die Box-Auswahl der Datenquellen lesen es aber ohne
-- Anlage — mit dieser Policy sind fremde Geräte dort 404 wie ihre Anlage
-- (§6.2 Punkt 3: „Geräte- und Reihen-Abfragen laufen über die gefilterte Anlage").
DROP POLICY IF EXISTS site_scope ON device;
CREATE POLICY site_scope ON device AS RESTRICTIVE
    USING (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                ELSE uems_zugriff_anlage_sichtbar(site_id, tenant_id) END)
    WITH CHECK (CASE WHEN uems_zugriff_unternehmensweit() THEN true
                     ELSE uems_zugriff_anlage_sichtbar(site_id, tenant_id) END);
