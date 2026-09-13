-- =============================================================================
-- UEMS AP-07 IP-11: die Löschwege — ein Messwert der Messwert-Strecke verschwindet
-- nicht mehr nebenbei (E8, AP-06 E7, W6).
--
-- Heute kaskadieren die Fremdschlüssel der Tabellen `device_measurement_*` von
-- `device` und `site` aus: `DELETE FROM device` (das Abmelden, „Gerät entfernen")
-- nimmt die ganze Zusatz-Messwert-Historie der Box mit, `DELETE FROM site` die
-- der Anlage. Nach dieser Migration:
--
--   1. Die Box wird beim Abmelden AUSGEBAUT, nie gelöscht: `device.ausgebaut_am`
--      + `status = 'ausgebaut'` (die beiden Angaben sagen per CHECK dasselbe).
--      Eine ausgebaute Box ist endgültig: Kennung, Mandant, Anlage und
--      Ausbau-Zeitpunkt ändern sich nie mehr (Trigger).
--   2. Die Aufkleber-Kennung ist nur unter den NICHT ausgebauten Boxen eindeutig
--      (partieller Unique-Index): die ausgebaute Zeile behält ihre Kennung als
--      Herkunft ihrer Werte, und dieselbe Hardware kann wie heute wieder
--      angemeldet werden — als neue Box mit neuer Kennung, wie bisher.
--   3. Die Verweise der Messwert-Tabellen auf `device` und `site` werden
--      `ON DELETE RESTRICT`: ein Löschen weiter oben wird ABGELEHNT, statt
--      durchzuschlagen. Wer Werte entfernen darf (Anlage ohne Belege, Offboarding),
--      räumt sie ausdrücklich und vorher selbst ab.
--   4. Eine neue Zuständigkeit an einer ausgebauten Box wird abgelehnt.
--
-- Bestand: KEINE Zeile ändert sich. Die neue Spalte ist in jeder bestehenden Zeile
-- NULL, der CHECK hält für jede heutige Zeile (`status` kennt heute nur
-- `claimed`/`unclaimed`), und die neu angelegten Fremdschlüssel prüfen den
-- Bestand nicht erneut (`NOT VALID`): jede bestehende Zeile hat den alten,
-- gleichlautenden Fremdschlüssel bis zu diesem Statement in DERSELBEN Transaktion
-- erfüllt — ein Prüflauf über alle Chunks der Rohtabelle hielte nur die Sperren
-- länger. `VALIDATE CONSTRAINT` kann jederzeit nachgeholt werden; die Wirkung
-- beim Löschen (RESTRICT) gilt unabhängig davon sofort.
--
-- Bewusst NICHT geändert:
--   * `device_measurement_selection_entity_fk` → measurement_point bleibt
--     CASCADE. Die Auswahl ist Einstellung, kein Wert; die Rohwerte tragen keinen
--     Verweis auf die Komponente (V20260912140000), das Löschen einer Komponente
--     nimmt also keinen Messwert mit — RESTRICT bräche dagegen jedes heutige
--     Komponenten-Löschen mit einer Auswahl.
--   * Die Verdichtungen `device_measurement_rollup_5m/15m` und alle `messreihe_*`
--     haben keinen Verweis auf Löschbares und bleiben unberührt.
--   * `data_source_assignment.device_id` bekommt KEINEN Fremdschlüssel: Zeiträume
--     früher abgemeldeter (gelöschter) Boxen stehen im Bestand ohne ihre Box —
--     ein validierter Verweis scheiterte an ihnen, ein nicht validierter täte so,
--     als gäbe es sie nicht. Befund für ein späteres Paket.
--   * v1-Telemetrie und OCPP-Aufzeichnungen tragen keine Fremdschlüssel auf
--     `device` (Hypertables bzw. eigene Verweise der OCPP-Migrationen); dass das
--     Abmelden sie nicht mehr leert, ist ein Schreibweg-Entscheid (Captain,
--     13.09.2026: beim Abmelden und beim Tausch geht kein Datenbestand verloren)
--     und steht im API-Code, nicht hier.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Die ausgebaute Box
-- -----------------------------------------------------------------------------
ALTER TABLE device ADD COLUMN IF NOT EXISTS ausgebaut_am TIMESTAMPTZ;

ALTER TABLE device DROP CONSTRAINT IF EXISTS device_ausgebaut_chk;
ALTER TABLE device ADD CONSTRAINT device_ausgebaut_chk
    CHECK ((status = 'ausgebaut') = (ausgebaut_am IS NOT NULL));

COMMENT ON COLUMN device.ausgebaut_am IS
    'UEMS AP-07 E8 / AP-06 E7: Zeitpunkt, zu dem die Box abgemeldet wurde. Gesetzt = die Box ist ausgebaut '
    '(status = ausgebaut): sie nimmt am Betrieb nicht mehr teil, ihre Messwerte und deren Herkunft bleiben. '
    'Nie zurückgesetzt.';

-- Ausgebaut ist endgültig: die Angaben, unter denen die Werte der Box gespeichert
-- sind, bleiben. Andere Spalten (etwa die zuletzt gemeldete LAN-Adresse) sind
-- keine Herkunft und bleiben schreibbar wie heute.
CREATE OR REPLACE FUNCTION uems_box_ausgebaut_endgueltig() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.ausgebaut_am IS NOT NULL AND (
            NEW.ausgebaut_am IS DISTINCT FROM OLD.ausgebaut_am
            OR NEW.status IS DISTINCT FROM OLD.status
            OR NEW.external_ref IS DISTINCT FROM OLD.external_ref
            OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.site_id IS DISTINCT FROM OLD.site_id) THEN
        RAISE EXCEPTION 'Box % ist ausgebaut und bleibt es', OLD.id
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'device_ausgebaut_endgueltig',
                  TABLE = 'device';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS device_ausgebaut_endgueltig ON device;
CREATE TRIGGER device_ausgebaut_endgueltig
    BEFORE UPDATE ON device
    FOR EACH ROW EXECUTE FUNCTION uems_box_ausgebaut_endgueltig();

-- -----------------------------------------------------------------------------
-- 2. Die Aufkleber-Kennung: eindeutig unter den nicht ausgebauten Boxen
-- -----------------------------------------------------------------------------
-- Kein `ON CONFLICT (external_ref)` zielt auf `device` (nur auf provisioned_device
-- und device_enrollment), kein Fremdschlüssel verweist auf device(external_ref).
DROP INDEX IF EXISTS uq_device_external_ref;
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_external_ref
    ON device (external_ref) WHERE ausgebaut_am IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Die Messwert-Tabellen: RESTRICT statt CASCADE
-- -----------------------------------------------------------------------------
-- Gleiche Namen, gleiche Spalten, gleiche Ziele wie V20260844000000,
-- V20260850000000 und V20260852000000 — nur die Lösch-Regel ändert sich.
ALTER TABLE device_measurement_sample
    DROP CONSTRAINT IF EXISTS device_measurement_sample_device_tenant_fk;
ALTER TABLE device_measurement_sample
    ADD CONSTRAINT device_measurement_sample_device_tenant_fk
    FOREIGN KEY (device_id, tenant_id)
    REFERENCES device (id, tenant_id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE device_measurement_sample
    DROP CONSTRAINT IF EXISTS device_measurement_sample_site_tenant_fk;
ALTER TABLE device_measurement_sample
    ADD CONSTRAINT device_measurement_sample_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE device_measurement_event
    DROP CONSTRAINT IF EXISTS device_measurement_event_device_tenant_fk;
ALTER TABLE device_measurement_event
    ADD CONSTRAINT device_measurement_event_device_tenant_fk
    FOREIGN KEY (device_id, tenant_id)
    REFERENCES device (id, tenant_id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE device_measurement_event
    DROP CONSTRAINT IF EXISTS device_measurement_event_site_tenant_fk;
ALTER TABLE device_measurement_event
    ADD CONSTRAINT device_measurement_event_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE device_measurement_point_state
    DROP CONSTRAINT IF EXISTS device_measurement_point_state_device_tenant_fk;
ALTER TABLE device_measurement_point_state
    ADD CONSTRAINT device_measurement_point_state_device_tenant_fk
    FOREIGN KEY (device_id, tenant_id)
    REFERENCES device (id, tenant_id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE device_measurement_point_state
    DROP CONSTRAINT IF EXISTS device_measurement_point_state_site_tenant_fk;
ALTER TABLE device_measurement_point_state
    ADD CONSTRAINT device_measurement_point_state_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE device_measurement_selection_event
    DROP CONSTRAINT IF EXISTS device_measurement_selection_event_device_tenant_fk;
ALTER TABLE device_measurement_selection_event
    ADD CONSTRAINT device_measurement_selection_event_device_tenant_fk
    FOREIGN KEY (device_id, tenant_id)
    REFERENCES device (id, tenant_id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE device_measurement_selection_event
    DROP CONSTRAINT IF EXISTS device_measurement_selection_event_site_tenant_fk;
ALTER TABLE device_measurement_selection_event
    ADD CONSTRAINT device_measurement_selection_event_site_tenant_fk
    FOREIGN KEY (site_id, tenant_id)
    REFERENCES site (id, tenant_id) ON DELETE RESTRICT NOT VALID;

-- Die Auswahl zieht beim Umzug einer Box weiter mit (ON UPDATE CASCADE bleibt).
ALTER TABLE device_measurement_selection
    DROP CONSTRAINT IF EXISTS device_measurement_selection_device_fk;
ALTER TABLE device_measurement_selection
    ADD CONSTRAINT device_measurement_selection_device_fk
    FOREIGN KEY (device_id, tenant_id, site_id)
    REFERENCES device (id, tenant_id, site_id)
    ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

-- -----------------------------------------------------------------------------
-- 4. Keine neue Zuständigkeit an einer ausgebauten Box
-- -----------------------------------------------------------------------------
-- Abgeschrieben aus V20260911150000 und um „nicht ausgebaut" ergänzt; die
-- Ausnahme für die Adress-Kaskade bleibt, ein bestehender Zeitraum einer später
-- ausgebauten Box lässt sich also weiter beenden.
CREATE OR REPLACE FUNCTION uems_zustaendigkeit_box_pruefen() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.device_id = OLD.device_id
            AND NEW.tenant_id = OLD.tenant_id THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM device d
                   WHERE d.id = NEW.device_id AND d.tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'Box % gibt es in diesem Kundenbereich nicht', NEW.device_id
            USING ERRCODE = 'foreign_key_violation',
                  CONSTRAINT = 'data_source_assignment_box_fk',
                  TABLE = 'data_source_assignment';
    END IF;
    IF EXISTS (SELECT 1 FROM device d
               WHERE d.id = NEW.device_id AND d.tenant_id = NEW.tenant_id
                 AND d.ausgebaut_am IS NOT NULL) THEN
        RAISE EXCEPTION 'Box % ist ausgebaut', NEW.device_id
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'data_source_assignment_box_ausgebaut',
                  TABLE = 'data_source_assignment';
    END IF;
    RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------
-- 5. Belege: welche Messstellen hängen an den Messwerten einer Anlage oder Box?
-- -----------------------------------------------------------------------------
-- Eine Messreihe (Komponente + Kanal, E2) ist Beleg, sobald sie JE an eine
-- Messstelle gebunden war: laufende oder beendete Quellenbindung, das Protokoll
-- `quelle_gebunden` (es überlebt die Bindungs-Zeile, wenn deren Komponente per
-- Kaskade ging) oder ein Messkanal-Term einer berechneten Messstelle.
-- SECURITY INVOKER: die Anwendung sieht unter RLS nur ihren Kundenbereich.
-- GENAU EINER der Parameter ist gesetzt.
CREATE OR REPLACE FUNCTION uems_messreihen_belege(p_site UUID, p_box UUID)
RETURNS TABLE (id UUID, kennzeichen TEXT, name TEXT)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
    WITH gebunden AS (
        SELECT q.messstelle_id, q.entity_id AS komponente, q.kanal
          FROM messstelle_quelle q
        UNION
        SELECT a.messstelle_id, (a.neu->>'komponente')::uuid, a.neu->>'kanal'
          FROM messstelle_aenderung a
         WHERE a.art = 'quelle_gebunden' AND a.neu->>'kanal' IS NOT NULL
           AND a.neu->>'komponente' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        UNION
        SELECT t.messstelle_id, t.entity_id, t.point_key
          FROM messstelle_formel_term t
         WHERE t.entity_id IS NOT NULL AND t.point_key IS NOT NULL
    )
    SELECT m.id, m.kennzeichen, m.name
      FROM messstelle m
     WHERE EXISTS (
        SELECT 1 FROM gebunden g
         WHERE g.messstelle_id = m.id
           AND (
               -- die Anlage: ihre Komponenten, ihre Auswahl und alles, was an ihr
               -- oder von einer ihrer Boxen gemessen wurde
               (p_site IS NOT NULL AND (
                    EXISTS (SELECT 1 FROM measurement_point p
                             WHERE p.id = g.komponente AND p.site_id = p_site)
                 OR EXISTS (SELECT 1 FROM device_measurement_selection s
                             WHERE s.entity_id = g.komponente AND s.point_key = g.kanal
                               AND (s.site_id = p_site
                                    OR s.device_id IN (SELECT d.id FROM device d WHERE d.site_id = p_site)))
                 OR EXISTS (SELECT 1 FROM device_measurement_sample s
                             WHERE s.site_id = p_site
                               AND s.entity_id = g.komponente AND s.point_key = g.kanal)
                 OR EXISTS (SELECT 1 FROM device d JOIN device_measurement_sample s ON s.device_id = d.id
                             WHERE d.site_id = p_site
                               AND s.entity_id = g.komponente AND s.point_key = g.kanal)))
            OR
               -- die Box: ihre Komponenten, ihre Datenquellen, ihre Auswahl, ihre Werte
               (p_box IS NOT NULL AND (
                    EXISTS (SELECT 1 FROM measurement_point p
                             WHERE p.id = g.komponente AND p.device_id = p_box)
                 OR EXISTS (SELECT 1 FROM measurement_point p
                              JOIN data_source_assignment z
                                ON z.data_source_id = p.data_source_id AND z.tenant_id = p.tenant_id
                             WHERE p.id = g.komponente AND z.device_id = p_box)
                 OR EXISTS (SELECT 1 FROM device_measurement_selection s
                             WHERE s.device_id = p_box
                               AND s.entity_id = g.komponente AND s.point_key = g.kanal)
                 OR EXISTS (SELECT 1 FROM device_measurement_sample s
                             WHERE s.device_id = p_box
                               AND s.entity_id = g.komponente AND s.point_key = g.kanal)))))
     ORDER BY m.kennzeichen, m.id
$$;

REVOKE ALL ON FUNCTION uems_messreihen_belege(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_messreihen_belege(UUID, UUID) TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- 6. Das Entfernen einer Anlage ohne Belege räumt ihre Messwerte ausdrücklich ab
-- -----------------------------------------------------------------------------
-- Die Anwendung hat auf den Messwert-Tabellen kein DELETE (Papierspur,
-- V20260841000000/V20260848000000) — bisher löschte nur die Kaskade. Diese eine
-- Öffnung ist ENG: nur Zeilen der Anlage (und ihrer Boxen) im Kundenbereich aus
-- `app.tenant_id`, und nur, wenn KEINE Messstelle an ihnen hängt — die Prüfung
-- steht hier, nicht nur im Schreibweg: ein Beleg ist für jede Rolle unlöschbar,
-- die diesen Weg nimmt.
CREATE OR REPLACE FUNCTION uems_messwerte_der_anlage_entfernen(p_site UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    tenant_scope UUID := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
    entfernt BIGINT := 0;
    n BIGINT;
BEGIN
    IF tenant_scope IS NULL THEN
        RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
    END IF;
    IF p_site IS NULL THEN
        RAISE EXCEPTION 'a site scope is required' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM site s WHERE s.id = p_site AND s.tenant_id = tenant_scope) THEN
        RETURN 0;
    END IF;
    IF EXISTS (SELECT 1 FROM uems_messreihen_belege(p_site, NULL)) THEN
        RAISE EXCEPTION 'Die Messwerte der Anlage % sind Belege von Messstellen', p_site
            USING ERRCODE = 'restrict_violation', CONSTRAINT = 'messstellen_belege';
    END IF;

    DELETE FROM device_measurement_sample
     WHERE tenant_id = tenant_scope
       AND (site_id = p_site OR device_id IN (SELECT d.id FROM device d WHERE d.site_id = p_site));
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM device_measurement_event
     WHERE tenant_id = tenant_scope
       AND (site_id = p_site OR device_id IN (SELECT d.id FROM device d WHERE d.site_id = p_site));
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM device_measurement_point_state
     WHERE tenant_id = tenant_scope
       AND (site_id = p_site OR device_id IN (SELECT d.id FROM device d WHERE d.site_id = p_site));
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM device_measurement_selection_event
     WHERE tenant_id = tenant_scope
       AND (site_id = p_site OR device_id IN (SELECT d.id FROM device d WHERE d.site_id = p_site));
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM device_measurement_selection
     WHERE tenant_id = tenant_scope
       AND (site_id = p_site OR device_id IN (SELECT d.id FROM device d WHERE d.site_id = p_site));
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    RETURN entfernt;
END $$;

REVOKE ALL ON FUNCTION uems_messwerte_der_anlage_entfernen(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_messwerte_der_anlage_entfernen(UUID) TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- 7. Das Offboarding räumt die Messwerte des Kundenbereichs vorher ab
-- -----------------------------------------------------------------------------
-- `TenantRepository.offboard` (Verwaltungsrolle, eine Transaktion) löscht den
-- Mandanten; die Kaskade über site/device träfe jetzt RESTRICT. Die
-- Verwaltungsrolle hat auf der Auswahl-Historie nur SELECT/INSERT — darum auch
-- hier eine enge Funktion, NUR für sie ausführbar.
CREATE OR REPLACE FUNCTION uems_messwerte_des_kundenbereichs_entfernen(p_tenant UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    entfernt BIGINT := 0;
    n BIGINT;
BEGIN
    IF p_tenant IS NULL THEN
        RAISE EXCEPTION 'a tenant scope is required' USING ERRCODE = '22023';
    END IF;
    DELETE FROM device_measurement_sample WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM device_measurement_event WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM device_measurement_point_state WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM device_measurement_selection_event WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM device_measurement_selection WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    RETURN entfernt;
END $$;

REVOKE ALL ON FUNCTION uems_messwerte_des_kundenbereichs_entfernen(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_messwerte_des_kundenbereichs_entfernen(UUID) TO ${adminDbUser};
