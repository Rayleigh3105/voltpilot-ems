-- UEMS AP-04 IP-10, Nacharbeit: JEDE NEU angelegte Komponente bekommt ihr Gerät
-- im Anlege-Weg — nach DERSELBEN Regel, nach der V20260911200000 jeder
-- Bestandskomponente eins gegeben hat (Konzept vp-uems-ap04-messstellen §4.6
-- Regel 6: je Komponente und Zeitpunkt EIN Gerät).
--
-- EINE REGEL, ZWEI AUFRUFER. Die Regel zieht aus uems_geraete_ableiten() in
-- uems_geraet_ableiten_fuer(komponente) um — die Ableitung EINER Komponente
-- (und der Geschwister, die mit ihr ein Gerät bilden). Sie hat ZWEI Aufrufer:
--   * der Anlege-Weg: ein Trigger an measurement_point (unten), und
--   * die Bestands-Ableitung uems_geraete_ableiten(), die jetzt nur noch in
--     fester Reihenfolge über die Komponenten ohne Speisung läuft und je eine
--     die Regel ruft. Geräteart, Hersteller/Typ/Seriennummer, Geräte-ID,
--     Gruppierung, eingebaut_am und Kennzeichen stehen damit an EINER Stelle.
-- Inhaltlich ändert sich an der Regel nichts (Kopf von V20260911200000); auch
-- `aus_bestand = true` bleibt: eingebaut_am ist auch bei einer neuen
-- Komponente der Beginn ihres Verlaufs in VoltPilot (ihre Anlagezeit), nie ein
-- erhobener Einbautag — den trägt erst ein Einbau, den ein Mensch erfasst
-- (Zählerwechsel IP-17, Controller AP-05), mit `aus_bestand = false`.
--
-- WARUM EIN TRIGGER UND KEIN AUFRUF IM JAVA-CODE: heute legen fünf Stellen in
-- zwei Repositories Komponenten an (EntityRegistryRepository.createBatteryHybrid-
-- Point / createComposedPoint / createEntityPoint / createAdoptedPoint,
-- MeasurementPointRepository.create), hinter ihnen ein Dutzend Dienste. Ein
-- Trigger deckt alle ab — und jede künftige Stelle, die es nicht vergessen
-- kann. measurement_point selbst ändert sich nicht (keine Spalte, kein Index,
-- keine Policy).
--
-- WARUM ZUR COMMIT-ZEIT (CONSTRAINT TRIGGER … INITIALLY DEFERRED): die
-- Anlege-Wege schreiben eine Komponente in mehreren Schritten — erst die
-- nackte Zeile, dann in derselben Transaktion Typ, Anbindung, Pin
-- (setEntityConfig, die Verbindung aus ComponentService.create …). Die Regel
-- liest genau diese Felder (Marke, Modell, Verbindung, Pin, Typ). Zur
-- Commit-Zeit sieht sie den Endstand der Transaktion — also genau das, was
-- uems_geraete_ableiten() direkt nach dem Commit sähe. Und nur so hängen die
-- komponierten Geschwister eines Hybrid-Wechselrichters UNABHÄNGIG von der
-- Anlege-Reihenfolge an seinem Einbau: legt eine Transaktion erst den
-- Netzzähler und dann den Wechselrichter an, stehen zur Commit-Zeit beide da.
-- Eine Komponente, die dieselbe Transaktion schon mit einer Speisung versieht
-- (ein Controller mit Energiekarte, AP-05), behält genau diese — die Regel
-- legt nur für Komponenten OHNE JEDE Speisung an; eine Komponente, die die
-- Transaktion wieder löscht, bekommt nichts. Ohne Transaktion (autocommit)
-- ist das Ende der Anweisung der Commit.
-- ⚠ Die Regel sieht jeden Commit für sich: legt eine SPÄTERE Transaktion den
-- Wechselrichter einer Box an, deren Netzzähler schon ein eigenes Gerät hat,
-- bleibt es dabei — ein Gerät wird nie umgruppiert (das wäre ein Austausch,
-- IP-17). Genau das täte auch uems_geraete_ableiten() nach jedem Commit.
--
-- RECHTE / SECURITY-ART:
--   * uems_geraet_ableiten_fuer(komponente) läuft als AUFRUFER (SECURITY
--     INVOKER). Unter der App-Rolle gilt ihre RLS: sie sieht und schreibt nur
--     Zeilen des Mandanten aus app.tenant_id — eine fremde Komponente ist
--     unsichtbar, die Funktion tut dann nichts. Sie kann nichts, was die Rolle
--     nicht ohnehin darf (INSERT auf geraet/geraet_komponente, den Zähler —
--     V20260911200000), und legt nur an, was der Trigger ohnehin anlegt. Die
--     App-Rolle und die Admin-Rolle (BYPASSRLS, die Anlage-Wege über
--     adminJdbcTemplate) bekommen EXECUTE, PUBLIC nicht: der Trigger ruft sie
--     unter der Rolle, die die Komponente anlegt, und dieser Aufruf prüft das
--     Recht.
--   * uems_geraete_ableiten() — die Schleife über ALLE Mandanten — bleibt
--     PUBLIC-entzogen: kein Schreibweg der App ruft sie, nur die Migrationen
--     (ohne RLS) als Eigner.
--   * Die Trigger-Funktion selbst ist nur als Trigger aufrufbar.
-- Kein SECURITY DEFINER: der Eigner umginge die RLS, und ein Anlege-Weg ohne
-- Mandanten-Kontext schriebe dann still Geräte — so aber scheitert er schon an
-- measurement_point selbst.

-- -----------------------------------------------------------------------------
-- Die Regel für EINE Komponente
-- -----------------------------------------------------------------------------
-- Gibt zurück, wie viele Geräte sie neu angelegt hat (0 oder 1). Tut nichts für
-- eine Komponente, die es (für den Aufrufer) nicht gibt oder die schon eine
-- Speisung hat — ein zweiter Aufruf legt nichts an. Die Gruppe ist die ihrer
-- Box: der ERSTE battery-hybrid der Box (created_at, id — EntityRegistry-
-- Repository.firstEntityOfType) trägt ihre komponierten Geschwister, wenn er
-- gerade mit abgeleitet wird oder ein laufendes Gerät hat; sonst ist die Gruppe
-- die Komponente allein.
CREATE OR REPLACE FUNCTION uems_geraet_ableiten_fuer(p_komponente UUID) RETURNS INTEGER
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE
    k        RECORD;
    g        RECORD;
    ziel     UUID;
    angelegt INTEGER := 0;
BEGIN
    SELECT mp.id, mp.tenant_id, mp.site_id, mp.device_id INTO k
    FROM measurement_point mp WHERE mp.id = p_komponente;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM geraet_komponente v
                            WHERE v.tenant_id = k.tenant_id AND v.entity_id = k.id) THEN
        RETURN 0;
    END IF;

    WITH offen AS (
        -- Die Komponenten ihrer Box ohne JEDE Verknüpfung (ohne Box: nur sie),
        -- mit dem Beginn ihres Verlaufs.
        SELECT mp.id, mp.created_at,
               coalesce(mp.entity_type, mp.role) AS art,
               mp.edge_source_id, mp.brand, mp.model, mp.connection_json,
               date_trunc('minute', least(mp.created_at,
                       (SELECT min(r.bucket) FROM telemetry_v2_rollup_1d r
                        WHERE r.entity_id = mp.id::text)) AT TIME ZONE 'UTC')
                   AT TIME ZONE 'UTC' AS beginn
        FROM measurement_point mp
        WHERE mp.site_id = k.site_id
          AND (mp.id = k.id OR mp.device_id = k.device_id)
          AND NOT EXISTS (SELECT 1 FROM geraet_komponente v
                          WHERE v.tenant_id = mp.tenant_id AND v.entity_id = mp.id)
    ),
    wechselrichter AS (
        -- Der Wechselrichter der Box: ihr ERSTER battery-hybrid — nur, wenn er
        -- gerade mit abgeleitet wird oder ein laufendes Gerät hat.
        SELECT w.id
        FROM (SELECT id, tenant_id FROM measurement_point
              WHERE site_id = k.site_id AND device_id = k.device_id
                AND coalesce(entity_type, role) = 'battery-hybrid'
              ORDER BY created_at, id LIMIT 1) w
        WHERE EXISTS (SELECT 1 FROM offen o WHERE o.id = w.id)
           OR EXISTS (SELECT 1 FROM geraet_komponente v
                      WHERE v.tenant_id = w.tenant_id AND v.entity_id = w.id
                        AND v.gueltig_bis IS NULL)
    ),
    gruppiert AS (
        SELECT o.*,
               coalesce(CASE WHEN o.art IN ('producer', 'pv-generation', 'grid-meter', 'house-load')
                              AND o.edge_source_id IS NULL
                              AND nullif(btrim(o.brand), '') IS NULL
                              AND nullif(btrim(o.model), '') IS NULL
                              AND (o.connection_json IS NULL
                                   OR o.connection_json IN ('null'::jsonb, '{}'::jsonb))
                         THEN (SELECT w.id FROM wechselrichter w) END,
                        o.id) AS anker
        FROM offen o
    )
    SELECT gr.anker,
           array_agg(gr.id ORDER BY gr.created_at, gr.id) AS komponenten,
           array_agg(gr.beginn ORDER BY gr.created_at, gr.id) AS beginne,
           min(gr.beginn) AS eingebaut_am
    INTO g
    FROM gruppiert gr
    WHERE gr.anker = (SELECT anker FROM gruppiert WHERE id = k.id)
    GROUP BY gr.anker;

    -- Speist der Wechselrichter schon, hängen die neuen Geschwister an seinen
    -- laufenden Einbau.
    SELECT v.geraet_id INTO ziel FROM geraet_komponente v
    WHERE v.tenant_id = k.tenant_id AND v.entity_id = g.anker AND v.gueltig_bis IS NULL;

    IF ziel IS NULL THEN
        INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, geraeteart,
                            hersteller, typ, seriennummer, geraete_id, eingebaut_am,
                            aus_bestand)
        SELECT k.tenant_id, k.site_id, n.kennzeichen, n.kennzeichen,
               CASE
                   WHEN a.art IN ('battery-hybrid', 'producer', 'pv-generation', 'inverter')
                       THEN 'wechselrichter'
                   WHEN a.art IN ('grid-meter', 'modbus-generic') THEN 'zaehler'
                   WHEN a.art IN ('wallbox', 'ev-charger') THEN 'ladestation'
                   WHEN a.art = 'user-defined-battery' THEN 'speicher'
                   ELSE 'sonstiges'
               END,
               nullif(btrim(a.brand), ''),
               nullif(btrim(a.model), ''),
               CASE WHEN a.communication = 'kaco_http'
                    THEN nullif(btrim(a.connection_json ->> 'serial'), '') END,
               CASE WHEN a.unit_id ~ '^[0-9]{1,3}$' THEN a.unit_id::integer END,
               g.eingebaut_am,
               true
        FROM (SELECT mp.*, coalesce(mp.entity_type, mp.role) AS art,
                     CASE WHEN mp.communication = 'solarman_v5'
                          THEN btrim(mp.connection_json ->> 'mb_slave_id')
                          ELSE btrim(mp.connection_json ->> 'unit_id') END AS unit_id
              FROM measurement_point mp WHERE mp.id = g.anker) a
        CROSS JOIN LATERAL (SELECT uems_geraet_kennzeichen(k.tenant_id) AS kennzeichen) n
        RETURNING id INTO ziel;
        angelegt := 1;
    END IF;

    INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, gueltig_ab)
    SELECT k.tenant_id, ziel, u.komponente, greatest(u.beginn, e.eingebaut_am)
    FROM unnest(g.komponenten, g.beginne) AS u(komponente, beginn)
    CROSS JOIN (SELECT eingebaut_am FROM geraet WHERE id = ziel) e;
    RETURN angelegt;
END
$$;

REVOKE EXECUTE ON FUNCTION uems_geraet_ableiten_fuer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_geraet_ableiten_fuer(UUID) TO ${appDbUser}, ${adminDbUser};

-- -----------------------------------------------------------------------------
-- Die Bestands-Ableitung ruft dieselbe Regel
-- -----------------------------------------------------------------------------
-- Reihenfolge wie bisher: Mandant, Anlage nach Anlagezeit, darin nach der
-- frühesten Komponente — die erste Komponente einer Gruppe, die die Schleife
-- trifft, ist deren früheste, also vergibt sie die Kennzeichen GR-n genau so
-- wie V20260911200000. Eine Komponente, die schon mit ihrer Gruppe eine
-- Speisung bekam, überspringt die Regel selbst. Weiterhin nur als Eigner.
CREATE OR REPLACE FUNCTION uems_geraete_ableiten() RETURNS INTEGER
    LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    k        RECORD;
    angelegt INTEGER := 0;
BEGIN
    FOR k IN
        SELECT mp.id
        FROM measurement_point mp
        JOIN site s ON s.id = mp.site_id
        WHERE NOT EXISTS (SELECT 1 FROM geraet_komponente v
                          WHERE v.tenant_id = mp.tenant_id AND v.entity_id = mp.id)
        ORDER BY mp.tenant_id, s.created_at, s.id, mp.created_at, mp.id
    LOOP
        angelegt := angelegt + uems_geraet_ableiten_fuer(k.id);
    END LOOP;
    RETURN angelegt;
END
$$;

REVOKE EXECUTE ON FUNCTION uems_geraete_ableiten() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- Der Anlege-Weg
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uems_geraet_anlegen() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    PERFORM uems_geraet_ableiten_fuer(NEW.id);
    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS uems_geraet_anlegen ON measurement_point;
CREATE CONSTRAINT TRIGGER uems_geraet_anlegen
    AFTER INSERT ON measurement_point
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION uems_geraet_anlegen();

-- Was zwischen V20260911200000 und dieser Fassung ohne Gerät entstand, holt die
-- Bestands-Ableitung jetzt nach (ein Lauf ohne solche Komponenten legt nichts an).
SELECT uems_geraete_ableiten();
