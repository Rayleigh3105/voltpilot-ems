-- =============================================================================
-- V20260806010000 - edge_trust_set: das AKTUELLE root-signierte Trust-Set,
-- damit eine NEUE Box beim Einrichten in die Vertrauenskette kommt, ohne dass
-- jemand zwei Dateien von Hand kopiert (Captain-Order 04.08.2026, nachdem der
-- erste Live-Rollout genau daran scheiterte: „Das Vertrauens-Set oder seine
-- Signatur fehlt."). ADDITIV, global wie edge_release.
-- -----------------------------------------------------------------------------
-- DIE VERTRAUENSGRENZE, und sie ist der ganze Grund, warum diese Tabelle
-- ueberhaupt existieren DARF:
--
--   * Die INSTALLATION ist ein sanktionierter TOFU-Moment. Eine Box, die
--     gerade eingerichtet wird, vertraut ihrem Installationskanal per
--     Definition - sie hat sich soeben ihre IMAGES darueber geholt. Das
--     AKTUELLE root-signierte Trust-Set ueber denselben Kanal auszuliefern
--     fuegt KEIN neues Vertrauen hinzu: die Box prueft die ROOT-Signatur
--     weiterhin selbst gegen ihre EINGEBACKENE Wurzel
--     (edge-app/core/internal/otaverify/rootkeys.json), der Kanal
--     transportiert nur oeffentliches Material.
--   * Der SPAETERE Austausch bleibt out-of-band. Eine LAUFENDE Box holt sich
--     NIE ein Trust-Set ueber das Netz - das waere der Widerrufs-Anker ueber
--     genau den Kanal, den er widerruft (die offene Rotations-Entscheidung aus
--     Stufe 4 bleibt offen). Es gibt deshalb keinen Downlink und keinen
--     Geraete-Abruf; der Core kennt diese Route nicht.
--
-- WARUM EINE EINZIGE ZEILE (Singleton, kein Verlauf): die Frage, die diese
-- Tabelle beantwortet, ist „welches Set gilt JETZT" - genau das, was eine neue
-- Box braucht. Der VERLAUF liegt bereits im Git (edge-app/ota/trust-set.json
-- ist eingecheckt, eine Rotation ist ein reviewbarer Commit - siehe
-- edge-app/ota/README.md); ihn hier zu duplizieren erzeugte eine zweite,
-- driftende Historie ohne einen einzigen Leser. Ein Rueckweg (Rotation
-- zuruecknehmen, docs/ota-signing.md §7.1b) ist ein erneutes Hochladen des
-- vorherigen, weiterhin gueltigen Sets aus dem Git.
--
-- ⚠ trust_set/signature sind `text`, NIEMALS `json`/`jsonb` - exakt dieselbe
-- Begruendung wie bei edge_release.manifest (V20260804000000): jsonb
-- normalisiert Schluesselreihenfolge, Leerraum und Zahlenformat, die Bytes
-- kaemen ANDERS wieder heraus als sie hineingingen, und die Root-Signatur
-- waere lautlos unpruefbar. Signiert werden die ROHEN Bytes.
--
-- ⚠ Die api PRUEFT die Signatur NICHT. Dieselbe Doktrin wie beim Register: der
-- einzige Verifizierer, auf den es ankommt, ist das GERAET mit seiner
-- eingebackenen Wurzel. Geprueft wird nur die FORM (parst? Domain? Algorithmus?
-- steckt der signierende Wurzel-Schluessel faelschlich im Set?) - siehe
-- EdgeTrustSetController.
--
-- LESERECHTE, und hier weicht diese Tabelle bewusst von edge_release ab: der
-- oeffentliche Ausliefer-Endpunkt ist UNAUTHENTIFIZIERT (eine Box hat beim
-- Einrichten noch kein Token, genauso wie beim Enrollment), laeuft also ueber
-- die App-Rolle. Sie bekommt SELECT; geschrieben wird ausschliesslich ueber
-- die BYPASSRLS-Rolle voltpilot_admin aus dem rollen-gegateten Endpunkt.
-- Kein tenant_id, keine RLS: das Set ist oeffentliches Schluesselmaterial und
-- fuer JEDE Box dasselbe.
--
-- Datums-Version nach der AGENTS.md-Koordination - und bewusst NACH der
-- hoechsten schon ausgelieferten (V20260806000000, OTA Stufe 4), obwohl das
-- fachlich zu Stufe 1 gehoert: eine Version, die UNTER dem Stand einer
-- langlebigen DB liegt, ist fuer Flyway „out of order" und wird bei der
-- Vorgabe-Konfiguration nie angewandt (die Selbstheilung repariert
-- Pruefsummen, sie holt keine uebersprungene Migration nach). Dieselbe Falle
-- wie beim Registry-Seed, siehe AGENTS.md.
-- =============================================================================

CREATE TABLE IF NOT EXISTS edge_trust_set (
    -- Singleton: genau eine Zeile, erzwungen im Schema statt in der
    -- Anwendung. Ohne diesen Riegel waere „das aktuelle Set" eine Frage der
    -- Sortierung, und eine zweite Zeile machte die Antwort mehrdeutig.
    id             BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),
    trust_set      TEXT        NOT NULL,
    signature      TEXT        NOT NULL,
    -- Abgeleitet und NUR fuer die Anzeige: die key_ids des Sets (sortiert,
    -- komma-getrennt wie device_update_status.trust_set_key_ids) und der
    -- WURZEL-Schluessel, der es unterschrieben hat. Die Wahrheit sind die
    -- rohen Bytes daneben; diese Spalten sparen der Oberflaeche das Parsen.
    key_ids        TEXT        NOT NULL,
    signing_key_id TEXT        NOT NULL,
    -- `generated_at` aus dem Set selbst (optional im Kontrakt) - der einzige
    -- Zeitpunkt, den das DOKUMENT ueber sich behauptet.
    generated_at   TEXT,
    uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_by    TEXT
);

-- Die App-Rolle darf LESEN (der oeffentliche Ausliefer-Endpunkt laeuft
-- unauthentifiziert ueber sie) und sonst nichts. Die V2-Default-Privilegien
-- wuerden ihr sonst auch Schreibrechte geben - dieselbe Behandlung wie
-- edge_release / provisioned_device.
GRANT SELECT ON edge_trust_set TO ${appDbUser};
REVOKE INSERT, UPDATE, DELETE ON edge_trust_set FROM ${appDbUser};
