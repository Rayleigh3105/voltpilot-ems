-- MiSpeL MP-38: signierte Ladepunkt-Messwerte (OCMF) als Quelle des Zählers Z2
-- mit Eichstatus. Vertrag: docs/contracts/v2/mispel-ladepunkt-ocmf.md.
--
-- Anlage 1 S. 23, Abschn. 3.2.1: alle Messeinrichtungen zur Bestimmung und zum
-- Nachweis der förderfähigen und saldierungsfähigen Mengen müssen mess- und
-- eichrechtskonform sein; Tenor S. 28, Abschn. 3.2.3.2.1: das gilt ohne
-- Ausnahme auch für Ladepunkt-Messwerte. Eine Ladesäule belegt ihren Messwert
-- mit einem vom Zähler signierten OCMF-Datensatz (S.A.F.E. e. V.). Die Box prüft
-- die Signatur und meldet Datensatz, Prüfergebnis und Zählerkennung als
-- internes Journal-Ereignis „SignedMeterValue“ (mqtt-ocpp-events, Schema 1.0).
--
-- EINE Zeile je Ablesung (RD-Eintrag) eines Datensatzes; der Datensatz selbst
-- steht in jeder Zeile UNVERÄNDERT als Text (`ocmf`), nie als jsonb — eine
-- umformatierte Nutzlast ist nicht mehr prüfbar (OCMF „JSON based OCMF Format“).
-- Der Eichstatus wird nicht gespeichert, sondern beim Lesen aus
-- `signaturstatus` gebildet (gueltig = geeicht, sonst Gerätewert ohne
-- Eichstatus). Herkunft wie ocpp_meter_sample: Gerät + OCPP-Kennung; die
-- Komponente des Ladepunkts liest der Dienst über device_charge_point.
--
-- Nur anhängen: die App-Rolle schreibt (Listener) und liest; Löschen über die
-- Wege der OCPP-Daten (Mandant: TenantRepository, Gerät: SeriesRepository).

CREATE TABLE ladepunkt_signierter_messwert (
    event_id           UUID        NOT NULL,
    ablesung           INTEGER     NOT NULL CHECK (ablesung >= 0),
    tenant_id          UUID        NOT NULL,
    site_id            UUID        NOT NULL,
    device_id          UUID        NOT NULL,
    charge_point_id    TEXT        NOT NULL,
    connector_id       INTEGER     NOT NULL CHECK (connector_id >= 0),
    transaction_id     INTEGER,
    ocpp               TEXT        NOT NULL CHECK (ocpp IN ('1.6', '2.0.1')),
    quelle             TEXT        NOT NULL CHECK (quelle IN ('MeterValues', 'TransactionData', 'TransactionEvent')),
    ocmf               TEXT        NOT NULL CHECK (ocmf LIKE 'OCMF|%'),
    signaturstatus     TEXT        NOT NULL CHECK (signaturstatus IN ('gueltig', 'ungueltig', 'nicht_pruefbar')),
    pruefgrund         TEXT        CHECK (pruefgrund IN ('signatur_falsch', 'schluessel_fremd', 'schluessel_fehlt',
                                                         'schluessel_defekt', 'verfahren_unbekannt', 'signatur_defekt')),
    signaturverfahren  TEXT        NOT NULL,
    schluessel         TEXT,
    schluessel_sha256  TEXT        CHECK (schluessel_sha256 ~ '^[0-9a-f]{64}$'),
    schluessel_quelle  TEXT        NOT NULL CHECK (schluessel_quelle IN ('saeule', 'keine')),
    zaehlerkennung     TEXT,
    zaehlerhersteller  TEXT,
    zaehlermodell      TEXT,
    paginierung        TEXT,
    zeit               TEXT        NOT NULL,
    gemessen_am        TIMESTAMPTZ,
    zeitstatus         TEXT,
    anlass             TEXT,
    wert_text          TEXT,
    wert               NUMERIC,
    einheit            TEXT,
    obis               TEXT,
    stromart           TEXT,
    fehler             TEXT,
    zaehlerstatus      TEXT,
    empfangen_am       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (event_id, ablesung),
    -- gültig nur mit Schlüssel und ohne Grund; jeder andere Status nennt seinen Grund
    CONSTRAINT ladepunkt_signierter_messwert_status_chk CHECK (
        (signaturstatus = 'gueltig' AND pruefgrund IS NULL AND schluessel_sha256 IS NOT NULL)
        OR (signaturstatus <> 'gueltig' AND pruefgrund IS NOT NULL))
);

CREATE INDEX idx_ladepunkt_signiert_station_zeit
    ON ladepunkt_signierter_messwert (device_id, charge_point_id, connector_id, gemessen_am DESC);
CREATE INDEX idx_ladepunkt_signiert_site ON ladepunkt_signierter_messwert (site_id, gemessen_am DESC);

ALTER TABLE ladepunkt_signierter_messwert ENABLE ROW LEVEL SECURITY;
ALTER TABLE ladepunkt_signierter_messwert FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ladepunkt_signierter_messwert_tenant_isolation ON ladepunkt_signierter_messwert;
CREATE POLICY ladepunkt_signierter_messwert_tenant_isolation ON ladepunkt_signierter_messwert
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON ladepunkt_signierter_messwert FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT, DELETE ON ladepunkt_signierter_messwert TO ${appDbUser};
GRANT SELECT, DELETE ON ladepunkt_signierter_messwert TO ${adminDbUser};
