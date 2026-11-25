-- =============================================================================
-- V20261125100000 - Ladepunkte ohne Säule aufräumen (vp-ladepunkte-doppelt).
-- -----------------------------------------------------------------------------
-- Aus jeder gemeldeten Ladesäule komponiert die Plattform eine Komponente
-- (measurement_point mit entity_type 'ev-charger', ChargerComponentComposer);
-- die Bindung steht in device_charge_point.entity_id. „Ladesäule entfernen"
-- löschte bis hierher die gemeldete Zeile, nicht aber die Komponente: Steuerung
-- › Laden zeigte den Ladepunkt weiter, obwohl der Aufbau keine Säule mehr kannte,
-- und ein Herzschlag aus der Zeit vor der Rücknahme legte daneben einen zweiten
-- (namenlosen) an. Seit diesem Stand räumt die Rücknahme ihre Komponente selbst
-- ab (ChargingConfigService.remove); hier geht, was vorher liegen blieb.
--
-- Gelöscht wird GENAU eine 'ev-charger'-Komponente, auf die KEINE gemeldete
-- Säule mehr zeigt - gleich welcher Box (die Zeilen einer ausgebauten Box
-- bleiben gespeichert und schützen ihre Komponente damit). Dieselben Schritte
-- wie „Komponente entfernen" (EntityRegistryService.deleteEntity mit
-- purgePoint): der Regel-Anspruch (flow_claim, ohne Fremdschlüssel) und der
-- Punkt; Rollen-Zuordnung, Steuerprofil samt Fassungen und die übrigen Anhänge
-- gehen über ihr ON DELETE CASCADE mit. Aufgezeichnete Messwerte bleiben.
--
-- NICHT angefasst wird eine solche Komponente, an der etwas Gemessenes hängt
-- oder die ein Fremdschlüssel schützt: eine Messstelle, deren Quelle sie je
-- war (Bindung, Protokoll, Formel-Term - der Weg des Berichts-Belegs), eine
-- Kanalbindung einer Bezugsgröße, der Zählerbaum, eine Bindung als I/O-Modul.
-- Sie bleibt gespeichert; Steuerung › Laden zeigt sie trotzdem nicht mehr, weil
-- keine Box ihre Säule meldet (VerbraucherService).
--
-- Läuft als Eigentümer (RLS greift nicht). Idempotent: ein zweiter Lauf findet
-- nichts mehr, und auf einer frischen Datenbank ändert sie nichts.
-- =============================================================================
WITH ohne_saeule AS (
    SELECT mp.id
      FROM measurement_point mp
     WHERE mp.entity_type = 'ev-charger'
       AND NOT EXISTS (SELECT 1 FROM device_charge_point c WHERE c.entity_id = mp.id)
       AND NOT EXISTS (SELECT 1 FROM messstelle_quelle q WHERE q.entity_id = mp.id)
       AND NOT EXISTS (SELECT 1 FROM messstelle_formel_term t WHERE t.entity_id = mp.id)
       AND NOT EXISTS (SELECT 1 FROM messstelle_aenderung a
                        WHERE a.art = 'quelle_gebunden'
                          AND lower(a.neu->>'komponente') = mp.id::text)
       AND NOT EXISTS (SELECT 1 FROM bezugsgroesse_kanalbindung b WHERE b.entity_id = mp.id)
       AND NOT EXISTS (SELECT 1 FROM komponente_haengt_an k
                        WHERE k.komponente_id = mp.id OR k.haengt_an = mp.id)
       AND NOT EXISTS (SELECT 1 FROM consumer_profile p WHERE p.io_entity_id = mp.id)
),
anspruch AS (
    DELETE FROM flow_claim f USING ohne_saeule o WHERE f.entity_id = o.id
)
DELETE FROM measurement_point mp USING ohne_saeule o WHERE mp.id = o.id;
