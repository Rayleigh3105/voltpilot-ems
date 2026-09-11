-- UEMS AP-06 IP-3: das Protokoll je Datenquelle und die Kennzeichnung einer
-- bestätigten Vergleichsquelle.
--
-- Der Schreibweg ist DatenquelleService (Routen unter
-- /api/v1/sites/{siteId}/data-sources/**); die Regeln bleiben Vertrag
-- (docs/contracts/v2/data-source-assignment.md, DatenquelleRegeln).
--
-- data_source_aenderung — das Protokoll der Quelle (AP-06 §4.2 „angelegt ·
-- Erreichbarkeitsprüfung (Box, Ergebnis, Zeitpunkt) · Zuständigkeit gewechselt
-- (von, nach, ab) · …; jeder Eintrag mit Urheber"), gebaut wie
-- messstelle_aenderung (V20260911140000) und ort_aenderung (V20260911100000):
-- append-only per reject_audit_mutation(), GAR KEIN Fremdschlüssel (ein
-- Protokoll überlebt das Objekt, von dem es erzählt), der Urheber im
-- Akteur-Vokabular von AP-03. Das Offboarding lässt es stehen wie die beiden
-- anderen Protokolle.
--
-- ⚠ DAS PROTOKOLL IST DER BELEG DER PRÜFUNG. Eine Zuständigkeit gilt erst, wenn
-- die Erreichbarkeitsprüfung von GENAU der Ziel-Box bestanden ist (E11, Vertrag
-- §5 Gründe 11/12). Der Schreibweg nimmt das Ergebnis dafür NIE aus der Anfrage,
-- sondern aus dem jüngsten Eintrag `erreichbarkeit_geprueft` dieser Quelle von
-- dieser Box — geschrieben nur, wenn die Box selbst geantwortet hat. Deshalb
-- tragen Box (`device_id`) und Ergebnis (`ergebnis`) eigene Spalten mit CHECK
-- statt eines JSON-Felds, und die App-Rolle kann einen Eintrag weder ändern
-- noch löschen.
--
-- `art`: angelegt · bearbeitet (alt/neu tragen NUR die geänderten Felder) ·
-- erreichbarkeit_geprueft (Box, Ergebnis; neu: Protokoll + Adresse, die geprüft
-- wurden) · zustaendigkeit_begonnen (die erste Box einer Quelle) ·
-- zustaendigkeit_gewechselt (alt: die bisherige Box). Spätere Pakete (Box-Tausch
-- IP-19, Rücknahme IP-12, Archivieren) weiten den CHECK, indem sie DIESEN Stand
-- abschreiben.
--
-- `gilt_ab`: bei einer Zuständigkeit ihr Beginn (`effective_from`, auf die
-- volle Minute, nie rückwirkend); sonst der Zeitpunkt des Eintrags auf die
-- Minute. Einen rückwirkenden Eintrag gibt es hier nicht (Vertrag §4), darum
-- auch keine Spalte `rueckwirkend`.

CREATE TABLE IF NOT EXISTS data_source_aenderung (
    id              BIGSERIAL   PRIMARY KEY,
    tenant_id       UUID        NOT NULL,
    data_source_id  UUID        NOT NULL,
    art             TEXT        NOT NULL,
    -- Die Box der Prüfung bzw. die neue zuständige Box — ohne Fremdschlüssel
    -- wie data_source_assignment.device_id: der Eintrag überlebt seine Box.
    device_id       UUID,
    -- Nur bei `erreichbarkeit_geprueft`: „ok" oder eine Fehlerklasse, die die
    -- BOX feststellen kann (Vertrag §7, Herkunft Box). `box_meldet_sich_nicht`
    -- stellt die Cloud fest und ist kein Prüfergebnis; `invalid_request`,
    -- `not_supported` und `rate_limited` sind kein Leseergebnis — alle drei
    -- Fälle werden nicht protokolliert.
    ergebnis        TEXT,
    alt             JSONB,
    neu             JSONB,
    gilt_ab         TIMESTAMPTZ NOT NULL,
    actor_sub       TEXT,
    actor_name      TEXT        NOT NULL,
    actor_rolle     TEXT,
    actor_art       TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT data_source_aenderung_art_chk CHECK (art IN (
        'angelegt', 'bearbeitet', 'erreichbarkeit_geprueft', 'zustaendigkeit_begonnen',
        'zustaendigkeit_gewechselt')),
    CONSTRAINT data_source_aenderung_ergebnis_chk CHECK (
        (art = 'erreichbarkeit_geprueft') = (ergebnis IS NOT NULL)
        AND (ergebnis IS NULL OR ergebnis IN ('ok', 'unreachable', 'no_answer',
             'invalid_response', 'implausible', 'fronius_api', 'timeout', 'layout_changed',
             'budget'))),
    CONSTRAINT data_source_aenderung_box_chk CHECK (
        device_id IS NOT NULL
        OR art NOT IN ('erreichbarkeit_geprueft', 'zustaendigkeit_begonnen',
                       'zustaendigkeit_gewechselt')),
    -- Die Minute, wie data_source_assignment_volle_minute — in UTC gerechnet.
    CONSTRAINT data_source_aenderung_gilt_ab_chk
        CHECK (date_trunc('minute', gilt_ab AT TIME ZONE 'UTC') = gilt_ab AT TIME ZONE 'UTC'),
    CONSTRAINT data_source_aenderung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT data_source_aenderung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT data_source_aenderung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX IF NOT EXISTS idx_data_source_aenderung_quelle
    ON data_source_aenderung (data_source_id, id DESC);
-- „Die jüngste Prüfung dieser Quelle von dieser Box" — die Frage jeder Zuständigkeit.
CREATE INDEX IF NOT EXISTS idx_data_source_aenderung_pruefung
    ON data_source_aenderung (data_source_id, device_id, id DESC)
    WHERE art = 'erreichbarkeit_geprueft';

-- Append-only an der Datenbankgrenze — dieselbe Funktion wie component_change_event
-- (V20260843000000), ort_aenderung und messstelle_aenderung.
DROP TRIGGER IF EXISTS data_source_aenderung_append_only ON data_source_aenderung;
CREATE TRIGGER data_source_aenderung_append_only BEFORE UPDATE OR DELETE ON data_source_aenderung
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- -----------------------------------------------------------------------------
-- Die bestätigte Vergleichsquelle (Vertrag §6, E10 = B)
-- -----------------------------------------------------------------------------
-- Gleiche Adresse UND gleiche Netzlage an einer zweiten Box ist ein Doppel-Lesen
-- desselben Geräts — erlaubt nur nach ausdrücklicher Bestätigung und dann
-- „gekennzeichnet, ohne Bewertung". Die Kennzeichnung setzt der Schreibweg, wenn
-- DatenquelleRegeln einen solchen Antrag erlaubt (`vergleichsquelle`); sie ist
-- eine Aussage des Kunden über die Quelle und wird nie still zurückgenommen.
-- REIN ADDITIV: Vorgabe false, jede bestehende Zeile bleibt, was sie war.
ALTER TABLE data_source ADD COLUMN IF NOT EXISTS vergleichsquelle BOOLEAN NOT NULL DEFAULT false;

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE data_source_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_source_aenderung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_source_aenderung_tenant_isolation ON data_source_aenderung;
CREATE POLICY data_source_aenderung_tenant_isolation ON data_source_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte: lesen und anhängen — nie ändern, nie löschen (auch nicht über die
-- Admin-Rolle; das Protokoll schützt zusätzlich sein Trigger).
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON data_source_aenderung TO ${appDbUser};
REVOKE UPDATE, DELETE ON data_source_aenderung FROM ${appDbUser}, ${adminDbUser};
-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Grant (die rollout_event-Falle):
-- ALTER DEFAULT PRIVILEGES deckt Tabellen ab, Sequenzen nicht.
GRANT USAGE, SELECT ON SEQUENCE data_source_aenderung_id_seq TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE data_source_aenderung_id_seq TO ${adminDbUser};

COMMENT ON TABLE data_source_aenderung IS
    'Append-only Protokoll je Datenquelle (AP-06 IP-3): angelegt, bearbeitet, '
    'Erreichbarkeitspruefung (Box, Ergebnis) und Zustaendigkeit mit Urheber (actor_*, AP-03).';
COMMENT ON COLUMN data_source.vergleichsquelle IS
    'Bestaetigte Vergleichsquelle (Vertrag data-source-assignment.md §6, E10 = B): '
    'gekennzeichnet, ohne Bewertung.';
