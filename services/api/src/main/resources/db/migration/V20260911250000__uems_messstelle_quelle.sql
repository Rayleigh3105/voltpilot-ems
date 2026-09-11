-- =============================================================================
-- UEMS AP-04 IP-13: die QUELLENBINDUNG — welche Messstelle ab wann aus welchem
-- Messkanal liest (Konzept vp-uems-ap04-messstellen §4.2 „Quellenbindung",
-- §4.3, §4.6 Regeln 1/2/5/6/7, E2, E3; Vertrag docs/contracts/v2/messstelle.md
-- §5 mit dem Java-Zwilling uems/MessstelleRegeln). Jede Regel hier sagt DASSELBE
-- wie dort; UemsMessstelleQuelleMigrationTest spielt sie gegen die Datenbank.
--
-- EINE mandantengebundene Tabelle, rein additiv (keine bestehende Spalte, kein
-- Vertrag und keine Box wird berührt), plus die Weitung des Protokoll-CHECKs:
--
--   messstelle_quelle   eine Zeile = eine Bindung einer Größe (Haupt- oder
--                       Nebengröße) an EINEN Messkanal = Komponente
--                       (measurement_point) + Einbau (geraet) + Kanalname
--                       (point_key), Rolle führend | vergleich, halboffen
--                       [gueltig_ab, gueltig_bis) auf die Minute.
--
-- ⚠ NIE ÜBERSCHRIEBEN, NUR BEENDET (Regel 2). Eine Bindung wird genau EINMAL
-- beendet: `gueltig_bis` geht von offen auf einen Zeitpunkt, der Endstand
-- darf dabei mitkommen — sonst ändert sich nichts, auch nicht über die
-- Admin-Rolle (Trigger unten). Die App-Rolle hat kein DELETE und nur
-- UPDATE (gueltig_bis, endstand, endstand_einheit). Lücken sind erlaubt: die
-- Datenbank füllt nichts auf und beendet nichts von selbst.
--
-- ⚠ DIE DREI VERBOTE STEHEN AN DER DATENBANKGRENZE (Exklusion, `tenant_id`
-- vorn — die Prüfung läuft ohne RLS und darf einem fremden Mandanten nichts
-- verraten):
--   * je (Messstelle, Größe) und Zeitpunkt höchstens EINE führende Quelle
--     (Regel 1 · Vertrag `bindung_ueberlappt`);
--   * dieselbe Vergleichsquelle nie zweimal zugleich an derselben Größe
--     (Vertrag §5 Nr. 7 „beim Vergleich: desselben Messwerts");
--   * ein Messwert (Komponente + Kanal) speist je Zeitpunkt höchstens EINE
--     Messstelle führend (Vertrag `kanal_bereits_fuehrend`) — innerhalb EINER
--     Messstelle darf er zwei Größen speisen (MS-03).
-- Ein Rennen zweier gleichzeitiger Schreiber endet so in 23P01, nie in zwei
-- führenden Quellen; der Schreibweg urteilt danach neu und nennt den Grund.
--
-- DAS GERÄT WIRD GESPEICHERT, nicht nachgeschlagen: `geraet_id` ist der
-- Einbau, der die Komponente zu `gueltig_ab` speist (geraet_komponente,
-- V20260911200000). Ein Zählerwechsel ist ein NEUER Messkanal (W2) und damit
-- eine neue Bindung; der Schreibweg prüft, dass die Bindung ganz in dieser
-- Speisung liegt (Vertrag `kein_geraet_zum_zeitpunkt`). Eine Komponente ohne
-- laufende Speisung ist nicht bindbar — nie ein geratenes Gerät.
--
-- LÖSCHEN (Plan-Regel „nichts mit Historie wird gelöscht", Linie von
-- V20260911140000/V20260911200000):
--   * → tenant, → messstelle: ON DELETE RESTRICT; das Offboarding räumt die
--     Tabelle AUSDRÜCKLICH ab (TenantRepository.offboard), vor den Geräten und
--     den Messstellen.
--   * → measurement_point und → geraet: ON DELETE CASCADE wie jede Tabelle an
--     einer Komponente (geraet_komponente, device_measurement_selection): das
--     heutige Löschen einer Komponente oder Anlage bleibt, wie es ist, bis
--     AP-07 E8 es durch „ausgebaut" ersetzt. Die Messstelle bleibt; was die
--     Bindung erzählte, steht im Protokoll messstelle_aenderung, das keinen
--     Fremdschlüssel trägt und das Objekt überlebt.
--
-- DAS PROTOKOLL: jede Bindung und jedes Beenden schreibt in derselben
-- Transaktion GENAU EINEN Eintrag in messstelle_aenderung (Arten
-- `quelle_gebunden`, `quelle_beendet` — der CHECK wird unten geweitet, indem
-- der Stand von V20260911140000 abgeschrieben wird). Der Urheber steht dort
-- UND an der Bindung selbst im Akteur-Vokabular von AP-03 (actor_*).
--
-- Nicht dieses Paket: die Beobachtung „liefert Daten" (IP-15), der
-- Zählerwechsel als EIN Vorgang (IP-17), Einstellungs-Fassungen (IP-11), die
-- Kadenz an der Bindung (AP-07 IP-10), die Vorzeichen-Aufteilung einer
-- Leistung am Zweirichtungszähler (AP-08).
-- =============================================================================

CREATE TABLE IF NOT EXISTS messstelle_quelle (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    messstelle_id        UUID        NOT NULL,
    -- Die Größe innerhalb der Messstelle: (groesse, richtung) ist ihre
    -- Hauptgröße oder eine ihrer Nebengrößen (Trigger unten). So identifiziert
    -- auch MessstelleRegeln.Bindung die Größe.
    groesse              TEXT        NOT NULL,
    richtung             TEXT        NOT NULL,
    -- Der Messkanal: Komponente + Einbau + Kanalname (point_key des Katalogs
    -- oder des Selbstbaus). `entity_id` wie in jeder Tabelle an einer
    -- Komponente.
    entity_id            UUID        NOT NULL,
    geraet_id            UUID        NOT NULL,
    kanal                TEXT        NOT NULL,
    -- Die Wertart des Messwerts, wie die Passung (Regel 7) sie gesehen hat,
    -- und wie aus ihm die Größe wird — `integration` ist für AP-08
    -- gekennzeichnet (Menge aus einer Leistung).
    kanal_wertart        TEXT        NOT NULL,
    herleitung           TEXT        NOT NULL,
    rolle                TEXT        NOT NULL,
    -- Nur und immer bei `vergleich` (E3).
    zweck                TEXT,
    gueltig_ab           TIMESTAMPTZ NOT NULL,
    -- NULL = bis auf Weiteres.
    gueltig_bis          TIMESTAMPTZ,
    -- Ablesestände (E2): optional, die Einheit darf fehlen (dann gibt der
    -- Schreibweg den Hinweis `ablesestand_pruefen`), nie eine ohne Stand.
    anfangsstand         NUMERIC,
    anfangsstand_einheit TEXT,
    endstand             NUMERIC,
    endstand_einheit     TEXT,
    -- „rückwirkend" (E2, Regel 5): der Beginn lag beim Eintragen vor der
    -- Minute des Eintrags. `eingetragen_am` ist das „jetzt" des Schreibwegs.
    rueckwirkend         BOOLEAN     NOT NULL,
    eingetragen_am       TIMESTAMPTZ NOT NULL,
    -- Wer die Bindung eingetragen hat — dieselbe Form wie messstelle_aenderung.
    actor_sub            TEXT,
    actor_name           TEXT        NOT NULL,
    actor_rolle          TEXT,
    actor_art            TEXT        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messstelle_quelle_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Der Mandant reist in jedem Verweis mit (die Falle aus V20260911100000).
    CONSTRAINT messstelle_quelle_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT messstelle_quelle_entity_fk FOREIGN KEY (entity_id, tenant_id)
        REFERENCES measurement_point (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT messstelle_quelle_geraet_fk FOREIGN KEY (geraet_id, tenant_id)
        REFERENCES geraet (id, tenant_id) ON DELETE CASCADE,
    -- ⚠ coalesce(…, false): ein CHECK nimmt NULL an.
    CONSTRAINT messstelle_quelle_rolle_chk CHECK (rolle IN ('fuehrend', 'vergleich')),
    CONSTRAINT messstelle_quelle_zweck_chk CHECK (coalesce(
        (rolle = 'vergleich') = (zweck IS NOT NULL)
        AND (zweck IS NULL OR zweck IN ('Plausibilität', 'Ersatz bei Ausfall', 'Abrechnungszähler')),
        false)),
    CONSTRAINT messstelle_quelle_kanal_chk CHECK (coalesce(btrim(kanal) <> '', false)),
    -- Nur ein Zählerstand oder ein Momentanwert passt je (Regel 7); die
    -- Herleitung folgt aus der Wertart (Vertrag §5 „Herleitung").
    CONSTRAINT messstelle_quelle_herleitung_chk CHECK (coalesce(
        (kanal_wertart = 'counter' AND herleitung IN ('zaehlerstand', 'differenzen'))
        OR (kanal_wertart = 'gauge' AND herleitung IN ('integration', 'momentanwert')),
        false)),
    -- Auf die Minute (E2), abgelehnt, nie gerundet — in UTC gerechnet, sonst
    -- hinge date_trunc an der Zeitzone der Sitzung.
    CONSTRAINT messstelle_quelle_volle_minute
        CHECK (date_trunc('minute', gueltig_ab AT TIME ZONE 'UTC') = gueltig_ab AT TIME ZONE 'UTC'
               AND (gueltig_bis IS NULL
                    OR date_trunc('minute', gueltig_bis AT TIME ZONE 'UTC') = gueltig_bis AT TIME ZONE 'UTC')),
    CONSTRAINT messstelle_quelle_nicht_leer CHECK (gueltig_bis IS NULL OR gueltig_bis > gueltig_ab),
    CONSTRAINT messstelle_quelle_stand_chk CHECK (coalesce(
        (anfangsstand IS NOT NULL OR anfangsstand_einheit IS NULL)
        AND (endstand IS NOT NULL OR endstand_einheit IS NULL)
        AND (anfangsstand_einheit IS NULL OR btrim(anfangsstand_einheit) <> '')
        AND (endstand_einheit IS NULL OR btrim(endstand_einheit) <> '')
        -- Ein Endstand gehört zum Ende.
        AND (endstand IS NULL OR gueltig_bis IS NOT NULL),
        false)),
    -- „rückwirkend" ist ein Urteil über die Vergangenheit (wie messstelle_aenderung).
    CONSTRAINT messstelle_quelle_rueckwirkend_chk CHECK (NOT rueckwirkend OR gueltig_ab < eingetragen_am),
    CONSTRAINT messstelle_quelle_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT messstelle_quelle_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT messstelle_quelle_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    -- Regel 1: je Größe und Zeitpunkt höchstens EINE führende Quelle.
    -- Berühren (Ende alt = Beginn neu) ja, überschneiden nie.
    CONSTRAINT messstelle_quelle_eine_fuehrende_je_groesse EXCLUDE USING gist (
        tenant_id WITH =,
        messstelle_id WITH =,
        groesse WITH =,
        richtung WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    ) WHERE (rolle = 'fuehrend'),
    -- Vergleichsquellen 0..n nebeneinander — nur nicht zweimal dieselbe.
    CONSTRAINT messstelle_quelle_vergleich_nie_doppelt EXCLUDE USING gist (
        tenant_id WITH =,
        messstelle_id WITH =,
        groesse WITH =,
        richtung WITH =,
        entity_id WITH =,
        kanal WITH =,
        geraet_id WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    ) WHERE (rolle = 'vergleich'),
    -- Ein Messwert speist je Zeitpunkt höchstens EINE Messstelle führend.
    -- (Komponente + Kanal genügt: je Zeitpunkt speist genau ein Einbau die
    -- Komponente, und eine Bindung liegt ganz in seiner Speisung.)
    CONSTRAINT messstelle_quelle_kanal_fuehrt_eine_messstelle EXCLUDE USING gist (
        tenant_id WITH =,
        entity_id WITH =,
        kanal WITH =,
        messstelle_id WITH <>,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    ) WHERE (rolle = 'fuehrend')
);

-- Die Historie einer Messstelle, nach Beginn.
CREATE INDEX IF NOT EXISTS idx_messstelle_quelle_messstelle
    ON messstelle_quelle (messstelle_id, gueltig_ab);
-- „Was speist dieser Messkanal?" — das Messkanal-Read-Model.
CREATE INDEX IF NOT EXISTS idx_messstelle_quelle_kanal
    ON messstelle_quelle (entity_id, kanal, gueltig_ab);
-- Das Gerät hält seine Bindungen fest (CASCADE vom Einbau).
CREATE INDEX IF NOT EXISTS idx_messstelle_quelle_geraet
    ON messstelle_quelle (geraet_id);

-- -----------------------------------------------------------------------------
-- Die Trigger
-- -----------------------------------------------------------------------------

-- Die Größe gehört zur Messstelle: ihre Hauptgröße oder eine ihrer
-- Nebengrößen (Vertrag §1/§5). Läuft als Aufrufer: der Mandant ist
-- NEW.tenant_id, den das WITH CHECK der Policy bereits geprüft hat, und die
-- Messstelle hängt über den zusammengesetzten Fremdschlüssel an demselben.
CREATE OR REPLACE FUNCTION messstelle_quelle_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Nie überschrieben, nur beendet (Regel 2): genau EINMAL von offen auf
    -- einen Zeitpunkt, der Endstand darf dabei mitkommen — sonst nichts.
    IF OLD.gueltig_bis IS NOT NULL OR NEW.gueltig_bis IS NULL
       OR (NEW.id, NEW.tenant_id, NEW.messstelle_id, NEW.groesse, NEW.richtung, NEW.entity_id,
           NEW.geraet_id, NEW.kanal, NEW.kanal_wertart, NEW.herleitung, NEW.rolle, NEW.zweck,
           NEW.gueltig_ab, NEW.anfangsstand, NEW.anfangsstand_einheit, NEW.rueckwirkend,
           NEW.eingetragen_am, NEW.actor_sub, NEW.actor_name, NEW.actor_rolle, NEW.actor_art,
           NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.messstelle_id, OLD.groesse, OLD.richtung, OLD.entity_id,
           OLD.geraet_id, OLD.kanal, OLD.kanal_wertart, OLD.herleitung, OLD.rolle, OLD.zweck,
           OLD.gueltig_ab, OLD.anfangsstand, OLD.anfangsstand_einheit, OLD.rueckwirkend,
           OLD.eingetragen_am, OLD.actor_sub, OLD.actor_name, OLD.actor_rolle, OLD.actor_art,
           OLD.created_at) THEN
      RAISE EXCEPTION 'Eine Quellenbindung wird nie ueberschrieben, nur einmal beendet (%)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_quelle_nie_ueberschrieben';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
        SELECT 1 FROM messstelle m
         WHERE m.id = NEW.messstelle_id AND m.tenant_id = NEW.tenant_id
           AND m.groesse = NEW.groesse AND m.richtung = NEW.richtung)
     AND NOT EXISTS (
        SELECT 1 FROM messstelle_groesse g
         WHERE g.messstelle_id = NEW.messstelle_id AND g.tenant_id = NEW.tenant_id
           AND g.groesse = NEW.groesse AND g.richtung = NEW.richtung) THEN
    RAISE EXCEPTION '% · % ist keine Groesse dieser Messstelle', NEW.groesse, NEW.richtung
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_quelle_groesse_der_messstelle';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS messstelle_quelle_pruefen ON messstelle_quelle;
CREATE TRIGGER messstelle_quelle_pruefen BEFORE INSERT OR UPDATE ON messstelle_quelle
    FOR EACH ROW EXECUTE FUNCTION messstelle_quelle_pruefen();

-- -----------------------------------------------------------------------------
-- Das Protokoll kennt die zwei neuen Arten. Geweitet, indem der AKTUELLE Stand
-- abgeschrieben wird — der von V20260911230000 (IP-7: ort_* · stellung_*), nie
-- der der Ur-Migration V20260911140000.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_aenderung DROP CONSTRAINT IF EXISTS messstelle_aenderung_art_chk;
ALTER TABLE messstelle_aenderung ADD CONSTRAINT messstelle_aenderung_art_chk CHECK (art IN (
    'angelegt', 'bearbeitet', 'angehalten', 'fortgesetzt', 'archiviert',
    'nebengroesse_hinzugefuegt', 'nebengroesse_archiviert',
    'ort_zugeordnet', 'ort_korrigiert', 'stellung_zugeordnet', 'stellung_korrigiert',
    'quelle_gebunden', 'quelle_beendet'));

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle_quelle ENABLE ROW LEVEL SECURITY;
ALTER TABLE messstelle_quelle FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messstelle_quelle_tenant_isolation ON messstelle_quelle;
CREATE POLICY messstelle_quelle_tenant_isolation ON messstelle_quelle
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/
-- DELETE auf jede neue Tabelle — hier wird bewusst weggenommen, was es nicht
-- geben darf. Die BYPASSRLS-Rolle voltpilot_admin behält V4s Rechte (das
-- Offboarding löscht über sie); das Überschreiben verbietet ihr der Trigger.
-- Kein BIGSERIAL, also kein Sequenz-Grant. (Das REVOKE auf Tabellenebene nimmt
-- die Spaltenrechte mit; das GRANT danach setzt genau die wieder.)
-- -----------------------------------------------------------------------------
-- Beenden ist das einzige UPDATE: das Ende und der Endstand, sonst nichts.
GRANT SELECT, INSERT ON messstelle_quelle TO ${appDbUser};
REVOKE UPDATE, DELETE ON messstelle_quelle FROM ${appDbUser};
GRANT UPDATE (gueltig_bis, endstand, endstand_einheit) ON messstelle_quelle TO ${appDbUser};

COMMENT ON TABLE messstelle_quelle IS
    'Quellenbindung einer Messstellen-Groesse an einen Messkanal (Komponente + Einbau + Kanal), '
    'fuehrend oder Vergleich, halboffen auf die Minute (UEMS AP-04 IP-13); nie ueberschrieben, '
    'nur einmal beendet. Vertrag docs/contracts/v2/messstelle.md §5.';
