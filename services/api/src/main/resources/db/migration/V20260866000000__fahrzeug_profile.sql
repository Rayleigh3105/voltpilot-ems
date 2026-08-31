-- Verbrauchsmanagement v1 / P7: die FAHRZEUG-PROFILE (Konzept
-- `vp-verbrauchsmgmt-konzept-v1` §4.5, Captain-Entscheid E4 „Pseudonym-Profile
-- ueber tag_ref").
--
-- Eine Zeile ist EINE Ladekarte, die diese Anlage schon einmal gesehen hat -
-- und, sobald der Kunde sie benannt hat, ihr Profil. Beides in EINER Tabelle,
-- weil es dieselbe Sache ist: ohne Sichtung gibt es nichts zu benennen, und
-- ein Profil ohne Sichtung waere ein Fahrzeug, das nie geladen hat.
--
-- ⚠ DER SCHLUESSEL IST DER PSEUDONYM DER BOX, UND DAS IST NICHT DER DES
-- OCPP-JOURNALS. Die Box rechnet `tagref_` + HMAC-SHA256 mit ihrem eigenen
-- 32-Byte-Schluessel (`ocpp-privacy.key`) und meldet den Wert im Herzschlag.
-- Die Cloud rechnet auf dem JOURNAL-Pfad jeden eingehenden Bezug ein ZWEITES
-- Mal mit ihrem Pfeffer (`OcppPrivacy`) - `ocpp_transaction.start_id_tag_ref`
-- traegt deshalb einen ANDEREN Wert fuer dieselbe Karte.
--
-- Die zwei Pseudonym-Raeume werden bewusst NICHT verbunden:
--   * Die BOX muss ihr Profil selbst zuordnen koennen (der Ladevorgang startet
--     dort, eine Cloud-Runde waere eine WAN-Abhaengigkeit auf einer physischen
--     Ladeentscheidung - genau das, was E1 verbietet). Sie kann den Pfeffer
--     nicht kennen, also MUSS der Schluessel ihr eigener Pseudonym sein.
--   * Den Pfeffer aufzugeben, um die zwei zu verschmelzen, hiesse eine
--     Sicherheitsgrenze aufzuweichen, die es aus einem anderen Grund gibt.
-- Bewusst in Kauf genommen und hier benannt: dieser Tabelle steht damit der
-- ungepfefferte Bezug der Box gegenueber. Er ist nicht umkehrbar (HMAC mit
-- einem 32-Byte-Zufallsschluessel, der die Box nie verlaesst) und traegt keinen
-- Klartext - der IdTag selbst kommt in KEINER Cloud-Tabelle vor.
--
-- MANDANTENGEBUNDEN mit RLS + FORCE: das sind Kundendaten (welche Karte wann an
-- welcher Saeule geladen hat), ausdruecklich NICHT global wie `edge_release`.
-- Deshalb wohnt der Lesepfad auch unter `/sites/**` und nicht unter `/admin/**`.
--
-- KEIN DELETE-Recht: „Profil entfernen" nullt Namen und Steuerart und LAESST
-- die Sichtung stehen - eine Ruecknahme ist keine Beweisvernichtung (die
-- Haus-Regel des Grabsteins), und die Karte taucht danach wieder als unbenannte
-- Sichtung auf, statt beim naechsten Herzschlag als „neu" zu erscheinen.

CREATE TABLE IF NOT EXISTS site_vehicle_tag (
    site_id     UUID NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    -- Der Pseudonym der Box. Die Form ist gepinnt, damit ein Klartext-IdTag
    -- oder ein Journal-Bezug gar nicht erst hier landen kann.
    tag_ref     TEXT NOT NULL,
    tenant_id   UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    -- Der Kundenname. NULL = gesehen, aber noch nicht benannt.
    name        TEXT,
    -- Die Steuerart dieser Karte: die QUELLEN-Bahn, die die Box auf die
    -- SITZUNG dieser Karte anwendet. NULL = kein Profil.
    source      TEXT,
    min_kw      NUMERIC,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at  TIMESTAMPTZ NOT NULL,
    -- Wo sie zuletzt geladen hat - die Kennung der Saeule, nie eine Adresse.
    last_charge_point_id TEXT,
    updated_at  TIMESTAMPTZ,
    updated_by  TEXT,
    PRIMARY KEY (site_id, tag_ref)
);

ALTER TABLE site_vehicle_tag
    DROP CONSTRAINT IF EXISTS site_vehicle_tag_ref_chk;
ALTER TABLE site_vehicle_tag ADD CONSTRAINT site_vehicle_tag_ref_chk
    CHECK (tag_ref ~ '^tagref_[0-9a-f]{8,64}$');

ALTER TABLE site_vehicle_tag
    DROP CONSTRAINT IF EXISTS site_vehicle_tag_source_chk;
ALTER TABLE site_vehicle_tag ADD CONSTRAINT site_vehicle_tag_source_chk
    CHECK (source IS NULL OR source IN ('nur_sonne', 'sonne_zuerst', 'schnell'));

ALTER TABLE site_vehicle_tag
    DROP CONSTRAINT IF EXISTS site_vehicle_tag_min_kw_chk;
ALTER TABLE site_vehicle_tag ADD CONSTRAINT site_vehicle_tag_min_kw_chk
    CHECK (min_kw IS NULL OR (min_kw >= 0 AND min_kw <= 1000));

ALTER TABLE site_vehicle_tag
    DROP CONSTRAINT IF EXISTS site_vehicle_tag_name_chk;
ALTER TABLE site_vehicle_tag ADD CONSTRAINT site_vehicle_tag_name_chk
    CHECK (name IS NULL OR (length(name) BETWEEN 1 AND 120));

CREATE INDEX IF NOT EXISTS idx_site_vehicle_tag_seen
    ON site_vehicle_tag (site_id, last_seen_at DESC);

ALTER TABLE site_vehicle_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_vehicle_tag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_vehicle_tag_tenant_isolation ON site_vehicle_tag;
CREATE POLICY site_vehicle_tag_tenant_isolation ON site_vehicle_tag
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON site_vehicle_tag TO voltpilot_app;
-- ⚠ Ausdruecklich KEIN DELETE: siehe den Kopf. Eine Ruecknahme nullt die
-- Profil-Spalten, sie loescht die Sichtung nicht.
REVOKE DELETE ON site_vehicle_tag FROM voltpilot_app;

-- Und die LIVE-Haelfte: WELCHE Karte an diesem Stecker gerade laedt. Sie steht
-- am Stecker, nicht an der Saeule - eine Saeule hat mehrere Stecker und an
-- jedem kann ein anderes Auto haengen.
--
-- ⚠ NULL heisst "kein Ladevorgang ODER eine Saeule, die ohne Karte autorisiert
-- hat ODER ein aelterer Box-Stand, der das Feld nicht meldet" - nie eine
-- erfundene Karte. Die Zeile wird je Herzschlag GANZ ersetzt (die
-- device_charge_connector-Disziplin), das Feld altert also mit ihr.
ALTER TABLE device_charge_connector
    ADD COLUMN IF NOT EXISTS tag_ref TEXT;

ALTER TABLE device_charge_connector
    DROP CONSTRAINT IF EXISTS device_charge_connector_tag_ref_chk;
ALTER TABLE device_charge_connector ADD CONSTRAINT device_charge_connector_tag_ref_chk
    CHECK (tag_ref IS NULL OR tag_ref ~ '^tagref_[0-9a-f]{8,64}$');
