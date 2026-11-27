-- Schaltspur (vp-schalten-3s): die Zeitspur EINES Handeingriffs an einem Verbraucher, vom Klick im Portal bis zum
-- bestätigten Zustand, mit EINER Kennung über jeden Abschnitt. Die Kennung reist als request_id des Handeingriffs
-- zur Box ("override:<entity>:<spur>"); eine Box ab dem Release mit Schaltspur meldet ihre eigenen Zeitpunkte im
-- Herzschlag zurück (consumers.{id}.trace), jede ältere Box wird an ihren Herzschlägen gemessen.
--
-- Reine Anzeige- und Diagnosewahrheit: die Spur steuert nichts und entscheidet nichts. Plan, angenommener Auftrag,
-- Rücklesung und Messung bleiben getrennt - "bestaetigt" heißt nur: ein Herzschlag der Box meldet den gewünschten
-- Zustand als zurückgelesen. Zeitpunkte der Box stehen in der Uhr der Box (box_*), alle übrigen in der Uhr der API.
--
-- Rein additiv: eine neue, leere Tabelle. Mandantenzaun (RLS + FORCE) und Standortzaun wie koppelbild_stand; geht mit
-- Anlage, Box und Kundenbereich (Fremdschlüssel ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS schaltspur (
    id                     UUID        PRIMARY KEY,
    tenant_id              UUID        NOT NULL,
    site_id                UUID        NOT NULL,
    -- Der Verbraucher (consumer_profile.entity_id).
    entity_id              UUID        NOT NULL,
    -- Die Box, an die der Eingriff ging; NULL, solange die Steuerung nicht aktiviert ist (nichts wurde gesendet).
    device_id              UUID        REFERENCES device (id) ON DELETE CASCADE,
    -- Die request_id des Umschlags an die Box - der Schlüssel, unter dem eine neue Box ihre Zeitpunkte zurückmeldet.
    request_id             TEXT        NOT NULL,
    -- start | stop | zurueck ("Automatik fortsetzen").
    art                    TEXT        NOT NULL,
    -- Der Wunsch: on_off | setpoint_kw, sein Wert und - beim Heizstab je Phase - die gewählten Kanäle.
    kommando               TEXT,
    wert                   NUMERIC(10, 3),
    ausgaenge              INTEGER[],
    -- API: Anfrage angekommen, Umschlag beim Broker abgegeben (PUBACK) bzw. warum nicht.
    api_eingang_at         TIMESTAMPTZ NOT NULL,
    gesendet_at            TIMESTAMPTZ,
    zustellung             TEXT,
    -- API: der erste Herzschlag der Box nach dem Senden.
    erste_meldung_at       TIMESTAMPTZ,
    -- Box (eigene Uhr, erst ab dem Release mit Schaltspur): empfangen, entschieden (Schiedsrichter und
    -- Schutzregeln), ans Gerät geschrieben, zurückgelesen, Herzschlag gebaut - und ihr Urteil.
    box_empfangen_at       TIMESTAMPTZ,
    box_entschieden_at     TIMESTAMPTZ,
    box_geschrieben_at     TIMESTAMPTZ,
    box_zurueckgelesen_at  TIMESTAMPTZ,
    box_gemeldet_at        TIMESTAMPTZ,
    box_urteil             TEXT,
    -- API: der erste Herzschlag, in dem eine Schutzregel der Box den Wunsch hält, und ihr Grund.
    gehalten_at            TIMESTAMPTZ,
    grund                  TEXT,
    -- API: der erste Herzschlag, der den gewünschten Zustand als zurückgelesen meldet.
    bestaetigt_at          TIMESTAMPTZ,
    ergebnis               TEXT        NOT NULL DEFAULT 'offen',
    -- Portal (eigene, monotone Uhr des Browsers): Klick bis Antwort der API, Klick bis bestätigt sichtbar.
    portal_antwort_ms      INTEGER,
    portal_sichtbar_ms     INTEGER,
    portal_gemeldet_at     TIMESTAMPTZ,
    CONSTRAINT schaltspur_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE CASCADE,
    CONSTRAINT schaltspur_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT schaltspur_request_uq UNIQUE (tenant_id, request_id),
    CONSTRAINT schaltspur_wort_chk CHECK (
        art IN ('start', 'stop', 'zurueck')
        AND (kommando IS NULL OR kommando IN ('on_off', 'setpoint_kw'))
        AND ergebnis IN ('offen', 'bestaetigt', 'gehalten', 'abweichung', 'ersetzt')
        AND length(request_id) BETWEEN 1 AND 128
        AND (portal_antwort_ms IS NULL OR portal_antwort_ms >= 0)
        AND (portal_sichtbar_ms IS NULL OR portal_sichtbar_ms >= 0))
);

-- Die jüngsten Spuren eines Verbrauchers (Route, Abgleich je Herzschlag, Aufräumen); führt mit tenant_id
-- (Löschzug-Zählung, LoeschzugIndexdeckungTest).
CREATE INDEX IF NOT EXISTS idx_schaltspur_entity ON schaltspur (tenant_id, entity_id, api_eingang_at DESC);
-- Fremdschlüssel-Deckung der RI-Prüfung beim Löschen von Anlage und Box.
CREATE INDEX IF NOT EXISTS idx_schaltspur_site ON schaltspur (site_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_schaltspur_device ON schaltspur (device_id);

ALTER TABLE schaltspur ENABLE ROW LEVEL SECURITY;
ALTER TABLE schaltspur FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schaltspur_tenant_isolation ON schaltspur;
CREATE POLICY schaltspur_tenant_isolation ON schaltspur
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS schaltspur_site_scope ON schaltspur;
CREATE POLICY schaltspur_site_scope ON schaltspur AS RESTRICTIVE
    USING (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id))
    WITH CHECK (uems_zugriff_unternehmensweit() OR uems_zugriff_anlage_sichtbar(site_id, tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON schaltspur TO ${appDbUser};
