-- =============================================================================
-- UEMS AP-07 IP-10: die ERWARTETE KADENZ als zeitgültiges Feld der
-- QUELLENBINDUNG (Konzept vp-uems-ap07-messdaten §4.6, Captain-Entscheid E9 vom
-- 10.09.2026, Option A).
--
-- Der Entscheid im Wortlaut: „Kadenz = Feld der Quellenbindung (AP-04) mit
-- Vorgabe aus Vorlage/Katalog, zeitgültig (Fassung); reist als Soll zur Box
-- (`cadence_s`, unverändert) und wird je Viertelstundenwert als `erwartet`
-- gespeichert; Lücke ab 2 × Kadenz ohne guten Wert."
--
-- WAS SICH ÄNDERT: die Kadenz war bisher eine ABGELEITETE Zahl — Mess-Selektion,
-- sonst Katalog (`default_cadence_s`), sonst 300 s — die jede Fläche frisch
-- las. Ab hier ist sie eine TATSACHE MIT GESCHICHTE: was am 3. März erwartet
-- wurde, darf etwas anderes sein als heute, und die Auswertung eines alten
-- Zeitraums sieht die alte Zahl.
--
-- ⚠ DER DRAHT BLEIBT, WIE ER IST. Die Box bekommt dieselbe Nachricht in
-- derselben Form (`…/v2/measurement-config`, `schema_version` 2.0, Feld
-- `cadence_s`); nur die QUELLE der Zahl wechselt. Deshalb trägt `erwartet_s`
-- GENAU die Schranken des Drahtvertrags (1 … 86 400 s, siehe
-- docs/contracts/v2/mqtt-measurement-config.schema.json): eine Fassung, die der
-- Box nicht zustellbar wäre, entsteht hier gar nicht erst. Eine manuell
-- abgelesene Messstelle (Referenz MS-21 Gas, „monatlich") hat KEINE
-- Quellenbindung und darum auch keine Fassung — ihre Erwartung ist AP-09.
--
-- EINE mandantengebundene Tabelle, rein additiv:
--
--   quelle_kadenz   eine Zeile = EINE Fassung der erwarteten Häufigkeit EINER
--                   Quellenbindung (messstelle_quelle, V20260911250000),
--                   halboffen [gueltig_ab, gueltig_bis) auf die Minute.
--
-- KEINE DRITTE ZEITFORM: das ist dieselbe Form wie die Einstellungs-Fassungen
-- (quelle_einstellung, V20260911280000) und wie die Bindung selbst —
-- minutengenau, halboffen, nur verkürzt, nie umgeschrieben.
--
-- ZWEI HERKÜNFTE (`herkunft`):
--   * bestand — aus der heutigen Mess-Selektion übernommen, „gilt seit dem
--               Beginn der Bindung" (die Fassung 1, unten); immer von VoltPilot
--               selbst, nie rückwirkend.
--   * eintrag — über POST /api/v1/messstellen/{id}/quellen/{qid}/kadenz
--               eingetragen.
--
-- DIE FASSUNG 1 (uems_kadenz_bestand): die heute geltende Vorgabe wird aus der
-- bestehenden Messauswahl übernommen — ABER NUR, WO SIE EINDEUTIG FOLGT. Für
-- den Messkanal einer Bindung (Komponente + Kanal) muss es mindestens eine
-- Zeile der Mess-Selektion geben, JEDE davon muss eine Kadenz tragen, und alle
-- müssen dieselbe nennen. Nichts wird geraten: lesen zwei Boxen denselben Kanal
-- mit verschiedenen Kadenzen, oder fehlt die Zahl, entsteht KEINE Fassung — dann
-- bleibt die Ableitung genau wie heute (Mess-Selektion → Katalog → 300 s).
-- Wiederholbar: sie legt nur an, wo es für die Bindung noch KEINE Fassung gibt.
--
-- DAS PROTOKOLL: eine eingetragene Fassung schreibt in derselben Transaktion
-- GENAU EINEN Eintrag `kadenz_geaendert` in messstelle_aenderung — der CHECK
-- wird unten geweitet, indem der AKTUELLE Stand abgeschrieben wird (der von
-- V20260912120000), nie der der Ur-Migration. Die Fassung 1 des Bestands
-- schreibt kein Protokoll: sie ändert nichts, sie schreibt auf, was schon gilt.
--
-- LÖSCHEN (die App-Rolle hat kein DELETE; eine Fassung wird BEENDET, nie
-- gelöscht, nie verlängert — ein Trigger hält das an der Datenbankgrenze):
--   * → tenant: ON DELETE RESTRICT; das Offboarding räumt die Tabelle
--     AUSDRÜCKLICH ab (TenantRepository.offboard), VOR den Quellenbindungen.
--   * → messstelle_quelle: ON DELETE CASCADE — genau wie die Bindung selbst
--     heute an Komponente und Einbau hängt (V20260911250000).
--
-- Nicht dieses Paket: die Viertelstunden-Tabelle und der Verdichtungs-Job
-- (IP-12), Endgültigkeit und Tageswerte (IP-13), der Lesepfad-Umbau (IP-14),
-- die Lücken-Erkennung als Job (IP-9), die Rechte-Durchsetzung (AP-03 IP-6/7).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Der Mandant reist in jedem Verweis mit (die Falle aus V20260911100000): die
-- Bindung braucht dafür ihren zusammengesetzten Schlüssel. Additiv — die
-- Migration V20260911250000 bleibt unberührt. Angelegt, wenn er fehlt: ein
-- DROP wäre nicht wiederholbar, sobald der Fremdschlüssel unten an ihm hängt.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'messstelle_quelle'::regclass
                      AND conname = 'uq_messstelle_quelle_id_tenant') THEN
        ALTER TABLE messstelle_quelle ADD CONSTRAINT uq_messstelle_quelle_id_tenant UNIQUE (id, tenant_id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS quelle_kadenz (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    -- Die Quellenbindung, deren Erwartung diese Fassung beschreibt.
    messstelle_quelle_id UUID        NOT NULL,
    -- Die erwartete Häufigkeit in Sekunden. GENAU die Schranken des
    -- Drahtvertrags (mqtt-measurement-config.schema.json: minimum 1,
    -- maximum 86400) und der Mess-Selektion — was hier steht, ist der Box
    -- zustellbar.
    erwartet_s           INTEGER     NOT NULL,
    herkunft             TEXT        NOT NULL,
    gueltig_ab           TIMESTAMPTZ NOT NULL,
    -- NULL = bis auf Weiteres. Nur die nächste Fassung setzt (bzw. verkürzt) es.
    gueltig_bis          TIMESTAMPTZ,
    -- gueltig_ab vor der Minute des Eintrags (KadenzRegeln).
    rueckwirkend         BOOLEAN     NOT NULL,
    begruendung          TEXT,
    -- Der Urheber im Akteur-Vokabular von AP-03 (wie messstelle_aenderung, über
    -- uems/ProtokollAkteur); actor_sub NULL = VoltPilot selbst.
    actor_sub            TEXT,
    actor_name           TEXT        NOT NULL,
    actor_rolle          TEXT,
    actor_art            TEXT        NOT NULL,
    eingetragen_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT quelle_kadenz_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT quelle_kadenz_bindung_fk FOREIGN KEY (messstelle_quelle_id, tenant_id)
        REFERENCES messstelle_quelle (id, tenant_id) ON DELETE CASCADE,
    -- ⚠ coalesce(…, false): ein CHECK nimmt NULL an.
    CONSTRAINT quelle_kadenz_erwartet_chk CHECK (erwartet_s BETWEEN 1 AND 86400),
    CONSTRAINT quelle_kadenz_herkunft_chk CHECK (herkunft IN ('bestand', 'eintrag')),
    -- Die Fassung 1 schreibt VoltPilot selbst, ab dem Beginn der Bindung.
    CONSTRAINT quelle_kadenz_bestand_chk CHECK (coalesce(
        herkunft <> 'bestand'
        OR (actor_sub IS NULL AND actor_art = 'voltpilot' AND NOT rueckwirkend AND begruendung IS NULL),
        false)),
    CONSTRAINT quelle_kadenz_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT quelle_kadenz_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT quelle_kadenz_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT quelle_kadenz_begruendung_chk CHECK (begruendung IS NULL
        OR (char_length(begruendung) BETWEEN 1 AND 500 AND btrim(begruendung) <> '')),
    -- Auf die Minute, abgelehnt, nie gerundet. In UTC gerechnet — date_trunc auf
    -- timestamptz hinge an der Zeitzone der Sitzung.
    CONSTRAINT quelle_kadenz_volle_minute
        CHECK (date_trunc('minute', gueltig_ab AT TIME ZONE 'UTC') = gueltig_ab AT TIME ZONE 'UTC'
               AND (gueltig_bis IS NULL
                    OR date_trunc('minute', gueltig_bis AT TIME ZONE 'UTC') = gueltig_bis AT TIME ZONE 'UTC')),
    CONSTRAINT quelle_kadenz_nicht_leer CHECK (gueltig_bis IS NULL OR gueltig_bis > gueltig_ab),
    -- „rückwirkend" ist ein Urteil über die Vergangenheit: es steht nie an einer
    -- Fassung, die erst ab einem späteren Zeitpunkt gilt.
    CONSTRAINT quelle_kadenz_rueckwirkend_chk CHECK (NOT rueckwirkend OR gueltig_ab < eingetragen_am),
    -- Je Bindung gilt zu jedem Zeitpunkt höchstens EINE Fassung. tenant_id
    -- vorn: der Constraint prüft ohne RLS und darf einem fremden Mandanten
    -- nichts verraten.
    CONSTRAINT quelle_kadenz_eine_je_zeitpunkt EXCLUDE USING gist (
        tenant_id WITH =,
        messstelle_quelle_id WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    )
);

-- Die Fassungen einer Bindung, die früheste zuerst — der Leseweg „welche Kadenz
-- galt zum Zeitpunkt?".
CREATE INDEX IF NOT EXISTS idx_quelle_kadenz_bindung ON quelle_kadenz (messstelle_quelle_id, gueltig_ab);

-- -----------------------------------------------------------------------------
-- Die Trigger
-- -----------------------------------------------------------------------------

-- Eine Fassung wird nur VERKÜRZT (die nächste beendet sie), nie verlängert, nie
-- umgeschrieben — auch nicht von einer Rolle mit vollem UPDATE-Recht. Wortgleich
-- zur Regel der Einstellungs-Fassungen (V20260911280000).
CREATE OR REPLACE FUNCTION quelle_kadenz_nur_verkuerzen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.tenant_id, NEW.messstelle_quelle_id, NEW.erwartet_s, NEW.herkunft, NEW.gueltig_ab,
        NEW.rueckwirkend, NEW.begruendung, NEW.actor_sub, NEW.actor_name, NEW.actor_rolle, NEW.actor_art,
        NEW.eingetragen_am)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.messstelle_quelle_id, OLD.erwartet_s, OLD.herkunft, OLD.gueltig_ab,
        OLD.rueckwirkend, OLD.begruendung, OLD.actor_sub, OLD.actor_name, OLD.actor_rolle, OLD.actor_art,
        OLD.eingetragen_am) THEN
        RAISE EXCEPTION 'Eine Kadenz-Fassung wird nie umgeschrieben'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'quelle_kadenz_unveraenderlich';
    END IF;
    IF NEW.gueltig_bis IS DISTINCT FROM OLD.gueltig_bis
       AND (NEW.gueltig_bis IS NULL OR (OLD.gueltig_bis IS NOT NULL AND NEW.gueltig_bis > OLD.gueltig_bis)) THEN
        RAISE EXCEPTION 'Eine Kadenz-Fassung wird nur verkürzt, nie verlängert'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'quelle_kadenz_nur_verkuerzen';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS quelle_kadenz_nur_verkuerzen ON quelle_kadenz;
CREATE TRIGGER quelle_kadenz_nur_verkuerzen BEFORE UPDATE ON quelle_kadenz
    FOR EACH ROW EXECUTE FUNCTION quelle_kadenz_nur_verkuerzen();

-- Eine Fassung liegt IN ihrer Bindung: nie vor deren Beginn und nie zu oder
-- nach deren Ende. (Die Bindung wird nach dem Eintragen noch beendet — dann
-- endet die Erwartung mit ihr; das prüft der Leseweg, nicht die Datenbank.)
CREATE OR REPLACE FUNCTION quelle_kadenz_in_der_bindung() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    b RECORD;
BEGIN
    SELECT q.gueltig_ab, q.gueltig_bis INTO b FROM messstelle_quelle q
     WHERE q.id = NEW.messstelle_quelle_id AND q.tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Quellenbindung % gibt es nicht', NEW.messstelle_quelle_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'quelle_kadenz_bindung_da';
    END IF;
    IF NEW.gueltig_ab < b.gueltig_ab THEN
        RAISE EXCEPTION 'Eine Kadenz-Fassung beginnt nie vor ihrer Quellenbindung'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'quelle_kadenz_vor_beginn';
    END IF;
    IF b.gueltig_bis IS NOT NULL AND NEW.gueltig_ab >= b.gueltig_bis THEN
        RAISE EXCEPTION 'Eine Kadenz-Fassung beginnt nie nach dem Ende ihrer Quellenbindung'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'quelle_kadenz_nach_ende';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS quelle_kadenz_in_der_bindung ON quelle_kadenz;
CREATE TRIGGER quelle_kadenz_in_der_bindung BEFORE INSERT ON quelle_kadenz
    FOR EACH ROW EXECUTE FUNCTION quelle_kadenz_in_der_bindung();

-- -----------------------------------------------------------------------------
-- Das Protokoll an der Messstelle kennt die neue Art. Geweitet, indem der
-- AKTUELLE Stand abgeschrieben wird — der von V20260912120000 (Zählerwechsel:
-- zaehler_gewechselt), nie der der Ur-Migration V20260911140000.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_aenderung DROP CONSTRAINT IF EXISTS messstelle_aenderung_art_chk;
ALTER TABLE messstelle_aenderung ADD CONSTRAINT messstelle_aenderung_art_chk CHECK (art IN (
    'angelegt', 'bearbeitet', 'angehalten', 'fortgesetzt', 'archiviert',
    'nebengroesse_hinzugefuegt', 'nebengroesse_archiviert',
    'ort_zugeordnet', 'ort_korrigiert', 'stellung_zugeordnet', 'stellung_korrigiert',
    'quelle_gebunden', 'quelle_beendet',
    'einstellung_geaendert',
    'zaehler_gewechselt',
    'kadenz_geaendert'));

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (Hausregel: fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE quelle_kadenz ENABLE ROW LEVEL SECURITY;
ALTER TABLE quelle_kadenz FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quelle_kadenz_tenant_isolation ON quelle_kadenz;
CREATE POLICY quelle_kadenz_tenant_isolation ON quelle_kadenz
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
GRANT SELECT, INSERT ON quelle_kadenz TO ${appDbUser};
REVOKE UPDATE, DELETE ON quelle_kadenz FROM ${appDbUser};
GRANT UPDATE (gueltig_bis) ON quelle_kadenz TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- Der Bestand: die heute geltende Vorgabe aus der bestehenden Messauswahl
-- -----------------------------------------------------------------------------
-- EINDEUTIG heißt: für den Messkanal der Bindung (Komponente + Kanal desselben
-- Mandanten) gibt es mindestens eine Zeile der Mess-Selektion, JEDE trägt eine
-- Kadenz, und alle nennen DIESELBE. Sonst entsteht keine Fassung — und die
-- Ableitung bleibt genau wie heute. Rolle egal: eine Vergleichsbindung
-- beschreibt dieselbe physische Lesung wie die führende.
-- Kein Schreibweg der App ruft sie — nur die Migration (ohne RLS) als Eigner.
CREATE OR REPLACE FUNCTION uems_kadenz_bestand() RETURNS INTEGER
    LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    angelegt INTEGER := 0;
BEGIN
    INSERT INTO quelle_kadenz (tenant_id, messstelle_quelle_id, erwartet_s, herkunft, gueltig_ab,
                               rueckwirkend, actor_name, actor_art)
    SELECT q.tenant_id, q.id, a.kadenz, 'bestand', q.gueltig_ab, false, 'VoltPilot', 'voltpilot'
      FROM messstelle_quelle q
      JOIN LATERAL (
            SELECT count(*) AS zeilen, count(s.cadence_s) AS mit_zahl,
                   count(DISTINCT s.cadence_s) AS verschiedene, min(s.cadence_s) AS kadenz
              FROM device_measurement_selection s
             WHERE s.tenant_id = q.tenant_id AND s.entity_id = q.entity_id AND s.point_key = q.kanal
           ) a ON a.zeilen > 0 AND a.mit_zahl = a.zeilen AND a.verschiedene = 1
     WHERE a.kadenz BETWEEN 1 AND 86400
       AND NOT EXISTS (SELECT 1 FROM quelle_kadenz k WHERE k.messstelle_quelle_id = q.id)
     ORDER BY q.tenant_id, q.gueltig_ab, q.id;
    GET DIAGNOSTICS angelegt = ROW_COUNT;
    RETURN angelegt;
END
$$;

REVOKE EXECUTE ON FUNCTION uems_kadenz_bestand() FROM PUBLIC;

SELECT uems_kadenz_bestand();

COMMENT ON TABLE quelle_kadenz IS
    'Fassung der erwarteten Kadenz EINER Quellenbindung (messstelle_quelle), halboffen '
    '[gueltig_ab, gueltig_bis) auf die Minute, 1…86 400 s wie der Drahtvertrag (UEMS AP-07 IP-10, '
    'E9). Vorgabe ohne Fassung: Mess-Selektion, sonst Katalog, sonst 300 s.';
