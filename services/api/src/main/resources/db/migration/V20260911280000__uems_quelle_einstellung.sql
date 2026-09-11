-- UEMS AP-04 IP-11: EINSTELLUNGS-FASSUNGEN je Quelle — Wandlerverhältnis,
-- Spannungswandler, Skalierung, Offset, Vorzeichen, Impulswertigkeit,
-- Zählerkonstante als zeitgültige Fassungen AN DER QUELLE (Konzept
-- vp-uems-ap04-messstellen §4.2 „Einstellungen je Quelle", §4.4, §6.2; E4 = A,
-- E5 = A). Vertrag: docs/contracts/v2/quelle-einstellung.md + Vektoren.
--
-- DIE QUELLE (E4) ist ein Einbau (`geraet`), optional eine Komponente, die er
-- speist, und optional ein Kanal dieser Komponente. Die Messstelle bleibt
-- hardwarefrei: zwei Messstellen an EINEM Gerät teilen dessen Fassung
-- (MS-01/MS-02 an GR-2). Ein neuer Einbau (Zählerwechsel, IP-17) bringt seine
-- eigenen Fassungen mit — darum hängt die Fassung am Einbau, nicht am Gerät.
--
-- DIE WIRKUNG (E5): nur ab `gueltig_ab`, halboffen auf die Minute [ab, bis).
-- KEIN GESPEICHERTER WERT ÄNDERT SICH: diese Migration und jede Route darüber
-- schreiben nur hier; measurement_point, component_definition, die Messreihen
-- und v2/measurement-config bleiben zeichengleich, und die Box bekommt nichts
-- Neues (die Zustellung angewendeter Fassungen ist AP-06; ein falsch erfasster
-- Zeitraum wird über eine Korrektur berichtigt, AP-08). Die heutigen Felder
-- (`scale`/`offset` je Selbstbau-Kanal, `invert_*_sign`/`power_scale` je
-- Verbindung) bleiben die Wahrheit der Box.
--
-- DREI HERKÜNFTE (`herkunft`):
--   * bestand    — aus der heutigen Verbindung abgeleitet, „gilt seit Beginn"
--                  der Speisung (die Fassung 1, unten); immer angewendet,
--                  immer von VoltPilot selbst.
--   * verbindung — mit einer Änderung der Verbindung geschrieben (der Hebel
--                  „Auf ×10 stellen" im PUT der Komponente, W5): die Box wendet
--                  sie mit der Verbindung an.
--   * eintrag    — über POST /api/v1/geraete/{id}/einstellungen eingetragen;
--                  angewendet heißt hier „Zustellung ausstehend" (AP-06).
--
-- DIE FASSUNG 1 (uems_einstellungen_ableiten_fuer, ein Aufruf je Komponente
-- mit laufender Speisung): die Regel des Vertrags (Familie `verbindung`,
-- Java-Zwilling QuelleEinstellungRegeln.ausVerbindung) liest die Verbindung
-- der Komponente —
--   * Selbstbau (`modbus_baukasten`): je Kanal Skalierung (`scale` ≠ 0) und
--     Offset (`offset`, mit der Einheit des Kanals), Quelle = Einbau +
--     Komponente + Kanal (der Slug);
--   * sonst: `power_scale` 0/1/10 (Zahl oder Text — der Hebel schickt '10')
--     → Skalierung automatisch/×1/×10 an der Komponente; `invert_grid_sign`
--     und `invert_batt_sign` (nur echte Wahrheitswerte) → Vorzeichen
--     umgekehrt am Kanal `power_kw` bzw. `battery_power_kw` der Lesung — zwei
--     Fassungen derselben Art brauchen zwei Quellen.
-- `signed` (der Datentyp s16/s32 eines Registers) ist KEIN umgekehrtes
-- Vorzeichen, sondern die Lesart des Registers — daraus wird nie eine Fassung.
-- Wandler, Spannungswandler, Impulswertigkeit und Zählerkonstante stehen
-- heute nirgends (AP-04 ist-befunde B6) — sie entstehen nur als Eintrag.
-- Beginn ist der Beginn der laufenden Speisung (geraet_komponente.gueltig_ab).
-- Wiederholbar: sie legt je (Quelle, Art) nur an, wo es noch KEINE Fassung
-- gibt; ein zweiter Lauf legt nichts an. Der Hebel-Weg ruft dieselbe Regel,
-- bevor er die Verbindung ändert — so steht der alte Wert als Fassung 1 da,
-- auch für Komponenten, die nach dieser Migration entstanden sind.
--
-- DAS PROTOKOLL (§4.4: „an der Quelle UND an jeder gespeisten Messstelle"):
-- das an der Quelle IST die Fassung (wer · wann · gilt ab · rückwirkend ·
-- Begründung). An jeder Messstelle, deren Quellenbindung (V20260911250000,
-- führend oder Vergleich) zum Beginn der Fassung aus dieser Quelle liest,
-- schreibt der Schreibweg einen Eintrag `einstellung_geaendert` in
-- messstelle_aenderung — dafür weitet diese Migration deren CHECK, indem sie
-- den AKTUELLEN Stand abschreibt (den von V20260911250000).
--
-- LÖSCHEN (die App-Rolle hat kein DELETE; eine Fassung wird BEENDET, nie
-- gelöscht, nie verlängert — ein Trigger hält das an der Datenbankgrenze):
--   * → tenant: ON DELETE RESTRICT; das Offboarding räumt die Tabelle
--     AUSDRÜCKLICH ab (TenantRepository.offboard), vor den Geräten.
--   * → geraet und → measurement_point: ON DELETE CASCADE wie geraet_komponente
--     — das heutige Löschen einer Anlage oder Komponente bleibt, wie es ist.
--
-- Nicht dieses Paket: die Zustellung an die Box (AP-06), Korrekturen (AP-08),
-- der Zählerwechsel mit „Einstellungen übernommen" (IP-17), die Geräteseite
-- (IP-12), die Protokoll-Routen (IP-21).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Die Form eines Werts je Art — der SQL-Zwilling von
-- QuelleEinstellungRegeln.wertGueltig (Familie `wert` der Vektoren)
-- -----------------------------------------------------------------------------
-- Eine Zahl des Werts: nur eine JSON-Zahl mit Betrag ≤ 1.000.000.000, sonst
-- NULL (ein Text „600" wird nie gelesen).
CREATE OR REPLACE FUNCTION uems_einstellung_zahl(p JSONB) RETURNS NUMERIC
    LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    z NUMERIC;
BEGIN
    IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'number' THEN
        RETURN NULL;
    END IF;
    z := (p #>> '{}')::numeric;
    RETURN CASE WHEN abs(z) <= 1000000000 THEN z END;
END
$$;

-- Genau die Felder der Art, keins mehr, keins weniger. coalesce(…, false):
-- ein NULL bestünde jeden CHECK.
CREATE OR REPLACE FUNCTION uems_einstellung_wert_gueltig(p_art TEXT, p_wert JSONB) RETURNS BOOLEAN
    LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    felder TEXT[];
BEGIN
    IF p_wert IS NULL OR jsonb_typeof(p_wert) IS DISTINCT FROM 'object' THEN
        RETURN false;
    END IF;
    SELECT coalesce(array_agg(k ORDER BY k COLLATE "C"), '{}') INTO felder
    FROM jsonb_object_keys(p_wert) AS k;
    RETURN coalesce(CASE p_art
        WHEN 'wandler_strom' THEN felder = ARRAY['primaer_a', 'sekundaer_a']
            AND uems_einstellung_zahl(p_wert -> 'primaer_a') > 0
            AND uems_einstellung_zahl(p_wert -> 'sekundaer_a') > 0
        WHEN 'wandler_spannung' THEN felder = ARRAY['primaer_v', 'sekundaer_v']
            AND uems_einstellung_zahl(p_wert -> 'primaer_v') > 0
            AND uems_einstellung_zahl(p_wert -> 'sekundaer_v') > 0
        WHEN 'skalierung' THEN (felder = ARRAY['faktor']
                AND uems_einstellung_zahl(p_wert -> 'faktor') <> 0)
            OR (felder = ARRAY['automatisch'] AND p_wert -> 'automatisch' = 'true'::jsonb)
        WHEN 'offset' THEN felder = ARRAY['einheit', 'wert']
            AND uems_einstellung_zahl(p_wert -> 'wert') IS NOT NULL
            AND jsonb_typeof(p_wert -> 'einheit') = 'string'
            AND char_length(p_wert ->> 'einheit') <= 32
        WHEN 'vorzeichen_umgekehrt' THEN felder = ARRAY['umgekehrt']
            AND jsonb_typeof(p_wert -> 'umgekehrt') = 'boolean'
        WHEN 'impulswertigkeit' THEN felder = ARRAY['impulse_je_kwh']
            AND uems_einstellung_zahl(p_wert -> 'impulse_je_kwh') > 0
        WHEN 'zaehlerkonstante' THEN felder = ARRAY['je_kwh']
            AND uems_einstellung_zahl(p_wert -> 'je_kwh') > 0
        ELSE false
    END, false);
END
$$;

-- -----------------------------------------------------------------------------
-- quelle_einstellung — eine Fassung
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quelle_einstellung (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    -- Die Quelle: der Einbau …
    geraet_id       UUID        NOT NULL,
    -- … optional die Komponente, die er speist (`entity_id` wie in jeder Tabelle
    -- an einer Komponente) …
    entity_id       UUID,
    -- … und optional ein Kanal dieser Komponente (Slug des Selbstbaus, Kanal
    -- der Lesung, point_key des Katalogs).
    kanal           TEXT,
    art             TEXT        NOT NULL,
    -- Die Form je Art prüft uems_einstellung_wert_gueltig (Vertrag §2).
    wert            JSONB       NOT NULL,
    anwendung       TEXT        NOT NULL,
    herkunft        TEXT        NOT NULL,
    gueltig_ab      TIMESTAMPTZ NOT NULL,
    -- NULL = bis auf Weiteres. Nur die nächste Fassung setzt (bzw. verkürzt) es.
    gueltig_bis     TIMESTAMPTZ,
    -- Wann die Änderung tatsächlich geschah, wenn früher als gueltig_ab (A5:
    -- „tatsächlich getauscht am 20.01.2027") — der Zeitraum dazwischen ist mit
    -- der vorigen Fassung erfasst und nur über eine Korrektur zu berichtigen.
    tatsaechlich_ab TIMESTAMPTZ,
    -- gueltig_ab vor der Minute des Eintrags (QuelleEinstellungRegeln).
    rueckwirkend    BOOLEAN     NOT NULL,
    begruendung     TEXT,
    -- Der Urheber im Akteur-Vokabular von AP-03 (wie messstelle_aenderung,
    -- über uems/ProtokollAkteur); actor_sub NULL = VoltPilot selbst.
    actor_sub       TEXT,
    actor_name      TEXT        NOT NULL,
    actor_rolle     TEXT,
    actor_art       TEXT        NOT NULL,
    eingetragen_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT quelle_einstellung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Zusammengesetzt über uq_geraet_id_tenant: nie der Einbau eines anderen Mandanten.
    CONSTRAINT quelle_einstellung_geraet_fk FOREIGN KEY (geraet_id, tenant_id)
        REFERENCES geraet (id, tenant_id) ON DELETE CASCADE,
    -- Über uq_measurement_point_id_tenant (V20260855000000).
    CONSTRAINT quelle_einstellung_entity_fk FOREIGN KEY (entity_id, tenant_id)
        REFERENCES measurement_point (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT uq_quelle_einstellung_id_tenant UNIQUE (id, tenant_id),
    -- Ein Kanal gehört immer einer Komponente.
    CONSTRAINT quelle_einstellung_kanal_chk CHECK (kanal IS NULL
        OR (entity_id IS NOT NULL AND btrim(kanal) <> '' AND char_length(kanal) <= 240)),
    -- Geschlossen (§4.4). Ein späteres Paket weitet den CHECK, indem es DIESEN
    -- Stand abschreibt.
    CONSTRAINT quelle_einstellung_art_chk CHECK (art IN ('wandler_strom', 'wandler_spannung',
        'skalierung', 'offset', 'vorzeichen_umgekehrt', 'impulswertigkeit', 'zaehlerkonstante')),
    CONSTRAINT quelle_einstellung_wert_chk CHECK (uems_einstellung_wert_gueltig(art, wert)),
    CONSTRAINT quelle_einstellung_anwendung_chk CHECK (anwendung IN ('angewendet', 'dokumentiert')),
    CONSTRAINT quelle_einstellung_herkunft_chk CHECK (herkunft IN ('bestand', 'verbindung', 'eintrag')),
    -- Was aus der Verbindung kommt, wendet die Box an, und es hängt an der
    -- Komponente, deren Verbindung es ist.
    CONSTRAINT quelle_einstellung_verbindung_chk CHECK (herkunft = 'eintrag'
        OR (anwendung = 'angewendet' AND entity_id IS NOT NULL)),
    -- Die Fassung 1 schreibt VoltPilot selbst, ab dem Beginn der Speisung.
    CONSTRAINT quelle_einstellung_bestand_chk CHECK (herkunft <> 'bestand'
        OR (actor_sub IS NULL AND actor_art = 'voltpilot' AND NOT rueckwirkend
            AND tatsaechlich_ab IS NULL)),
    CONSTRAINT quelle_einstellung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT quelle_einstellung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT quelle_einstellung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT quelle_einstellung_begruendung_chk CHECK (begruendung IS NULL
        OR (char_length(begruendung) BETWEEN 1 AND 500 AND btrim(begruendung) <> '')),
    -- Auf die Minute, abgelehnt, nie gerundet. In UTC gerechnet — date_trunc auf
    -- timestamptz hinge an der Zeitzone der Sitzung.
    CONSTRAINT quelle_einstellung_volle_minute
        CHECK (date_trunc('minute', gueltig_ab AT TIME ZONE 'UTC') = gueltig_ab AT TIME ZONE 'UTC'
               AND (gueltig_bis IS NULL
                    OR date_trunc('minute', gueltig_bis AT TIME ZONE 'UTC') = gueltig_bis AT TIME ZONE 'UTC')
               AND (tatsaechlich_ab IS NULL
                    OR date_trunc('minute', tatsaechlich_ab AT TIME ZONE 'UTC')
                           = tatsaechlich_ab AT TIME ZONE 'UTC')),
    CONSTRAINT quelle_einstellung_nicht_leer CHECK (gueltig_bis IS NULL OR gueltig_bis > gueltig_ab),
    CONSTRAINT quelle_einstellung_tatsaechlich_chk CHECK (tatsaechlich_ab IS NULL OR tatsaechlich_ab < gueltig_ab),
    -- „rückwirkend" ist ein Urteil über die Vergangenheit: es steht nie an einer
    -- Fassung, die erst ab einem späteren Zeitpunkt gilt.
    CONSTRAINT quelle_einstellung_rueckwirkend_chk CHECK (NOT rueckwirkend OR gueltig_ab < eingetragen_am),
    -- Je Quelle und Art gilt zu jedem Zeitpunkt höchstens EINE Fassung.
    -- tenant_id vorn: der Constraint prüft ohne RLS und darf einem fremden
    -- Mandanten nichts verraten.
    CONSTRAINT quelle_einstellung_eine_je_zeitpunkt EXCLUDE USING gist (
        tenant_id WITH =,
        geraet_id WITH =,
        (coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
        (coalesce(kanal, '')) WITH =,
        art WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    )
);

-- Die Fassungen eines Einbaus — GET /api/v1/geraete/{id}/einstellungen.
CREATE INDEX IF NOT EXISTS idx_quelle_einstellung_geraet ON quelle_einstellung (geraet_id, gueltig_ab);
-- Das Löschen einer Komponente folgt dem Fremdschlüssel.
CREATE INDEX IF NOT EXISTS idx_quelle_einstellung_entity ON quelle_einstellung (entity_id);

-- Eine Fassung wird nur VERKÜRZT (die nächste beendet sie), nie verlängert, nie
-- umgeschrieben — auch nicht von einer Rolle mit vollem UPDATE-Recht.
CREATE OR REPLACE FUNCTION quelle_einstellung_nur_verkuerzen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.tenant_id, NEW.geraet_id, NEW.entity_id, NEW.kanal, NEW.art, NEW.wert,
        NEW.anwendung, NEW.herkunft, NEW.gueltig_ab, NEW.tatsaechlich_ab, NEW.rueckwirkend,
        NEW.begruendung, NEW.actor_sub, NEW.actor_name, NEW.actor_rolle, NEW.actor_art,
        NEW.eingetragen_am)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.geraet_id, OLD.entity_id, OLD.kanal, OLD.art, OLD.wert,
        OLD.anwendung, OLD.herkunft, OLD.gueltig_ab, OLD.tatsaechlich_ab, OLD.rueckwirkend,
        OLD.begruendung, OLD.actor_sub, OLD.actor_name, OLD.actor_rolle, OLD.actor_art,
        OLD.eingetragen_am) THEN
        RAISE EXCEPTION 'Eine Einstellungs-Fassung wird nie umgeschrieben'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'quelle_einstellung_unveraenderlich';
    END IF;
    IF NEW.gueltig_bis IS DISTINCT FROM OLD.gueltig_bis
       AND (NEW.gueltig_bis IS NULL OR (OLD.gueltig_bis IS NOT NULL AND NEW.gueltig_bis > OLD.gueltig_bis)) THEN
        RAISE EXCEPTION 'Eine Einstellungs-Fassung wird nur verkürzt, nie verlängert'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'quelle_einstellung_nur_verkuerzen';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS quelle_einstellung_nur_verkuerzen ON quelle_einstellung;
CREATE TRIGGER quelle_einstellung_nur_verkuerzen BEFORE UPDATE ON quelle_einstellung
    FOR EACH ROW EXECUTE FUNCTION quelle_einstellung_nur_verkuerzen();

-- -----------------------------------------------------------------------------
-- Das Protokoll an der Messstelle kennt die neue Art. Geweitet, indem der
-- AKTUELLE Stand abgeschrieben wird — der von V20260911250000 (IP-13:
-- quelle_gebunden · quelle_beendet), nie der der Ur-Migration.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_aenderung DROP CONSTRAINT IF EXISTS messstelle_aenderung_art_chk;
ALTER TABLE messstelle_aenderung ADD CONSTRAINT messstelle_aenderung_art_chk CHECK (art IN (
    'angelegt', 'bearbeitet', 'angehalten', 'fortgesetzt', 'archiviert',
    'nebengroesse_hinzugefuegt', 'nebengroesse_archiviert',
    'ort_zugeordnet', 'ort_korrigiert', 'stellung_zugeordnet', 'stellung_korrigiert',
    'quelle_gebunden', 'quelle_beendet',
    'einstellung_geaendert'));

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (Hausregel: fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE quelle_einstellung ENABLE ROW LEVEL SECURITY;
ALTER TABLE quelle_einstellung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quelle_einstellung_tenant_isolation ON quelle_einstellung;
CREATE POLICY quelle_einstellung_tenant_isolation ON quelle_einstellung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird bewusst weggenommen, was es nicht geben
-- darf. Die BYPASSRLS-Rolle deckt V4s ALTER DEFAULT PRIVILEGES ab (das
-- Offboarding löscht über sie). Kein BIGSERIAL, darum kein Sequenz-Grant.
-- Eine Fassung wird beendet — nie gelöscht, nie umgeschrieben.
GRANT SELECT, INSERT ON quelle_einstellung TO ${appDbUser};
REVOKE UPDATE, DELETE ON quelle_einstellung FROM ${appDbUser};
GRANT UPDATE (gueltig_bis) ON quelle_einstellung TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- Die Fassung 1 aus der Verbindung (siehe Kopf)
-- -----------------------------------------------------------------------------
-- Der SQL-Zwilling von QuelleEinstellungRegeln.ausVerbindung (Familie
-- `verbindung` der Vektoren): (reihe, kanal, art, wert) in fester Reihenfolge.
CREATE OR REPLACE FUNCTION uems_einstellungen_aus_verbindung(p_kommunikation TEXT, p_verbindung JSONB)
    RETURNS TABLE (reihe INTEGER, kanal TEXT, art TEXT, wert JSONB)
    LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    c        JSONB;
    n        INTEGER := 0;
    stufe    JSONB;
    s        NUMERIC;
    f        NUMERIC;
    o        NUMERIC;
    einheit  TEXT;
    flagge   RECORD;
BEGIN
    IF p_verbindung IS NULL OR jsonb_typeof(p_verbindung) IS DISTINCT FROM 'object' THEN
        RETURN;
    END IF;
    IF p_kommunikation = 'modbus_baukasten' THEN
        IF jsonb_typeof(p_verbindung -> 'channels') IS DISTINCT FROM 'array' THEN
            RETURN;
        END IF;
        FOR c IN SELECT e FROM jsonb_array_elements(p_verbindung -> 'channels') WITH ORDINALITY AS x(e, i)
                 ORDER BY i LOOP
            IF jsonb_typeof(c) IS DISTINCT FROM 'object'
               OR jsonb_typeof(c -> 'slug') IS DISTINCT FROM 'string'
               OR btrim(c ->> 'slug') = '' THEN
                CONTINUE;
            END IF;
            f := uems_einstellung_zahl(c -> 'scale');
            IF f IS NOT NULL AND f <> 0 THEN
                n := n + 1;
                reihe := n; kanal := c ->> 'slug'; art := 'skalierung';
                wert := jsonb_build_object('faktor', f);
                RETURN NEXT;
            END IF;
            o := uems_einstellung_zahl(c -> 'offset');
            einheit := CASE WHEN jsonb_typeof(c -> 'unit') = 'string' THEN c ->> 'unit' ELSE '' END;
            IF o IS NOT NULL AND char_length(einheit) <= 32 THEN
                n := n + 1;
                reihe := n; kanal := c ->> 'slug'; art := 'offset';
                wert := jsonb_build_object('wert', o, 'einheit', einheit);
                RETURN NEXT;
            END IF;
        END LOOP;
        RETURN;
    END IF;

    stufe := p_verbindung -> 'power_scale';
    s := CASE
        WHEN jsonb_typeof(stufe) = 'number' AND (stufe #>> '{}')::numeric IN (0, 1, 10)
            THEN (stufe #>> '{}')::numeric
        WHEN jsonb_typeof(stufe) = 'string' AND stufe #>> '{}' IN ('0', '1', '10')
            THEN (stufe #>> '{}')::numeric
    END;
    IF s IS NOT NULL THEN
        n := n + 1;
        reihe := n; kanal := NULL; art := 'skalierung';
        wert := CASE WHEN s = 0 THEN jsonb_build_object('automatisch', true)
                     ELSE jsonb_build_object('faktor', s::integer) END;
        RETURN NEXT;
    END IF;
    FOR flagge IN SELECT * FROM (VALUES (1, 'invert_grid_sign', 'power_kw'),
                                        (2, 'invert_batt_sign', 'battery_power_kw')) AS v(i, feld, kanal_der_lesung)
                  ORDER BY i LOOP
        IF jsonb_typeof(p_verbindung -> flagge.feld) = 'boolean' THEN
            n := n + 1;
            reihe := n; kanal := flagge.kanal_der_lesung; art := 'vorzeichen_umgekehrt';
            wert := jsonb_build_object('umgekehrt', p_verbindung -> flagge.feld);
            RETURN NEXT;
        END IF;
    END LOOP;
END
$$;

-- Die Regel für EINE Komponente: je (Quelle, Art) ohne jede Fassung eine
-- Fassung 1, ab dem Beginn der laufenden Speisung. Gibt zurück, wie viele sie
-- angelegt hat. Läuft als AUFRUFER (SECURITY INVOKER): unter der App-Rolle
-- sieht und schreibt sie nur den Mandanten aus app.tenant_id — eine fremde
-- Komponente ist unsichtbar, dann tut sie nichts. Der Hebel-Weg ruft sie, bevor
-- er die Verbindung ändert (QuelleEinstellungService.verbindungGeaendert).
CREATE OR REPLACE FUNCTION uems_einstellungen_ableiten_fuer(p_komponente UUID) RETURNS INTEGER
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE
    s         RECORD;
    e         RECORD;
    angelegt  INTEGER := 0;
BEGIN
    SELECT v.tenant_id, v.geraet_id, v.gueltig_ab, mp.communication, mp.connection_json
      INTO s
      FROM geraet_komponente v
      JOIN measurement_point mp ON mp.id = v.entity_id AND mp.tenant_id = v.tenant_id
     WHERE v.entity_id = p_komponente AND v.gueltig_bis IS NULL;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;
    FOR e IN SELECT * FROM uems_einstellungen_aus_verbindung(s.communication, s.connection_json)
             ORDER BY reihe LOOP
        IF NOT EXISTS (SELECT 1 FROM quelle_einstellung q
                       WHERE q.tenant_id = s.tenant_id AND q.geraet_id = s.geraet_id
                         AND q.entity_id = p_komponente AND q.kanal IS NOT DISTINCT FROM e.kanal
                         AND q.art = e.art) THEN
            INSERT INTO quelle_einstellung (tenant_id, geraet_id, entity_id, kanal, art, wert, anwendung,
                                            herkunft, gueltig_ab, rueckwirkend, actor_name, actor_art)
            VALUES (s.tenant_id, s.geraet_id, p_komponente, e.kanal, e.art, e.wert, 'angewendet',
                    'bestand', s.gueltig_ab, false, 'VoltPilot', 'voltpilot');
            angelegt := angelegt + 1;
        END IF;
    END LOOP;
    RETURN angelegt;
END
$$;

REVOKE EXECUTE ON FUNCTION uems_einstellungen_ableiten_fuer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_einstellungen_ableiten_fuer(UUID) TO ${appDbUser}, ${adminDbUser};

-- Die Ableitung für den Bestand: in fester Reihenfolge über jede laufende
-- Speisung. Gibt zurück, wie viele Fassungen sie angelegt hat. Kein Schreibweg
-- der App ruft sie — nur die Migrationen (ohne RLS) als Eigner.
CREATE OR REPLACE FUNCTION uems_einstellungen_ableiten() RETURNS INTEGER
    LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    k         RECORD;
    angelegt  INTEGER := 0;
BEGIN
    FOR k IN SELECT v.entity_id FROM geraet_komponente v WHERE v.gueltig_bis IS NULL
             ORDER BY v.tenant_id, v.gueltig_ab, v.entity_id LOOP
        angelegt := angelegt + uems_einstellungen_ableiten_fuer(k.entity_id);
    END LOOP;
    RETURN angelegt;
END
$$;

REVOKE EXECUTE ON FUNCTION uems_einstellungen_ableiten() FROM PUBLIC;

SELECT uems_einstellungen_ableiten();

COMMENT ON TABLE quelle_einstellung IS
    'Einstellungs-Fassung je Quelle (Einbau, optional Komponente und Kanal): Art, Wert, Anwendung, '
    'halboffen [gueltig_ab, gueltig_bis) auf die Minute, Urheber. Wirkung nur ab gueltig_ab; kein '
    'gespeicherter Wert ändert sich (UEMS AP-04 IP-11, E4/E5).';
