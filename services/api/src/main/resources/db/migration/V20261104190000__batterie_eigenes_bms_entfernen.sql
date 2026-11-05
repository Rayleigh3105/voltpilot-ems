-- =============================================================================
-- "Batterie mit eigenem BMS" (Entitaetstyp user-defined-battery, MQTT oder
-- HTTP/JSON) ist aus dem Produkt entfernt: kein Anlegen, kein Bearbeiten, kein
-- Lese-Flow, keine Box-Bausteine. Diese Migration raeumt den Bestand ab, den es
-- danach nicht mehr lesen koennte.
--
-- Was weggeht (nur dieser Typ, sonst nichts):
--   * die Komponente (measurement_point mit entity_type = 'user-defined-battery');
--     ihre Definitionen, Fassungen, Rollen-Zuordnungen (auch die ausdrueckliche
--     Speiser-Bindung) und UEMS-Zeilen haengen per ON DELETE CASCADE daran;
--   * ihre Bezugsgroessen-Kanalbindungen (Fremdschluessel ohne CASCADE) und
--     ihre flow_claim-Reste (kein Fremdschluessel);
--   * die GENERIERTEN Lese-Flows (origin.kind mqtt-device / http-device): die
--     api war ihr einziger Autor, kein Kunden-Flow traegt diese Herkunft.
--
-- Defensiv und wiederholbar: ein leerer Bestand ist ein No-op, ein zweiter Lauf
-- findet nichts. Gemessene Verlaeufe bleiben wie bei jedem Komponenten-Loeschen
-- stehen (Ehrlichkeit der Zahlen, die Aufbewahrung raeumt sie spaeter ab).
-- =============================================================================

DO $$
DECLARE
    komponenten uuid[];
BEGIN
    SELECT coalesce(array_agg(id), ARRAY[]::uuid[])
      INTO komponenten
      FROM measurement_point
     WHERE entity_type = 'user-defined-battery';

    DELETE FROM flow_definition
     WHERE document #>> '{origin,kind}' IN ('mqtt-device', 'http-device');

    IF cardinality(komponenten) = 0 THEN
        RETURN;
    END IF;

    DELETE FROM flow_claim WHERE entity_id = ANY (komponenten);
    DELETE FROM bezugsgroesse_kanalbindung WHERE entity_id = ANY (komponenten);
    DELETE FROM measurement_point WHERE id = ANY (komponenten);
END
$$;
