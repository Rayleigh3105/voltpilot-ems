-- =============================================================================
-- V20260827000000 - Das AUDIT-JOURNAL der Einmal-Schreibvorgaenge auf
-- Geraete-Register ("Register schreiben ueber das Portal", Konzept
-- vp-reg-schreib-konzept-p8 §2.5, Stufe 1 "Der Portal-Trigger").
-- ADDITIV: eine neue Tabelle, keine bestehende wird angefasst. Ohne eine Zeile
-- verhaelt sich jede Anlage byte-identisch wie vorher.
-- -----------------------------------------------------------------------------
-- WOFUER (Captain-Vorentscheidung 3 vom 19.08.2026, GESCHAERFT):
-- Ein Register einer Kundenanlage aus der Ferne zu beschreiben ist eine
-- dauerhafte Konfig-Aenderung an fremdem Eigentum. Sie braucht deshalb eine
-- Papier-Spur, die die HERKUNFT BEWEISBAR festhaelt - vom Kunden vs. von
-- VoltPilot vs. vor Ort am Geraet -, inklusive der vom Menschen EINGEGEBENEN
-- BEGRIFFE (verbatim). Muster: site_forecast_model_choice / rule_event.
--
-- ⚠ APPEND-ONLY, UND ZWAR ZWEI ZEILEN JE VORGANG statt einer mutierten:
--   'angefordert'                -> WER, WOHIN, WAS (samt Verbatim-Eingaben),
--   'quittung' | 'keine_quittung'-> WAS DABEI HERAUSKAM.
-- Eine UPDATE-Spalte fuer das Ergebnis waere ein nachtraeglich aenderbares
-- Journal, also keins. Die App-Rolle bekommt deshalb SELECT + INSERT und
-- ausdruecklich KEIN UPDATE/DELETE; verbunden werden die beiden Zeilen ueber
-- request_id - denselben Schluessel, unter dem auch das persistente Audit AUF
-- DER BOX den Vorgang fuehrt (zwei unabhaengige Buecher, kreuz-pruefbar).
--
-- ⚠ EIN api-ABSTURZ ZWISCHEN SENDEN UND QUITTUNG HINTERLAESST DIE
-- 'angefordert'-ZEILE. Das ist Absicht: ein Schreibvorgang darf nie spurlos
-- sein. Die Reihenfolge ist deshalb dieselbe wie beim OTA-Apply - erst
-- VEROEFFENTLICHEN, dann protokollieren; scheitert schon das Veroeffentlichen,
-- entsteht KEINE Zeile, die eine Anforderung behauptet, die es nie gab.
--
-- ⚠ EINE VORSCHAU (mode 'lesen') SCHREIBT NICHTS HIER HINEIN. Sie aendert
-- nichts, und ein Protokoll der Lesungen wuerde genau die Schreibvorgaenge
-- begraben, fuer die es diese Tabelle gibt (dieselbe Entscheidung wie im
-- Box-Audit von internal/installerwrite).
--
-- ⚠ MANDANTENGEBUNDEN MIT RLS + FORCE - das sind KUNDENDATEN, ausdruecklich
-- nicht global wie rollout_event. Deshalb wohnt die Leseroute unter /sites/**
-- und nicht unter /admin/**; ein Portal-Admin erreicht jede Anlage ueber den
-- X-Tenant-Id-Umschalter auf demselben RLS-Pfad, einen BYPASSRLS-Schreibpfad
-- gibt es hier bewusst nicht.
--
-- Datums-Version oberhalb des hoechsten ausgelieferten Standes
-- (V20260826000000) - eine kleinere Version waere fuer Flyway "out of order"
-- und wuerde auf einer langlebigen DB nie angewandt.
-- =============================================================================

CREATE TABLE IF NOT EXISTS register_write_event (
    id                  BIGSERIAL   PRIMARY KEY,
    -- Die Korrelation: sie verbindet 'angefordert' mit seiner Quittung UND das
    -- Cloud-Journal mit dem Audit auf der Box.
    request_id          TEXT        NOT NULL,
    event               TEXT        NOT NULL,
    -- WELCHER TRIGGER: 'portal' (dieser Kanal) oder 'geraet' (ein Schreibvorgang
    -- am Wartungszugang der Box, per Herzschlag nachgemeldet - Captain-Entscheid
    -- D6). Steht auf JEDER Zeile, auch auf der Quittung, wo `origin` fehlt.
    source              TEXT        NOT NULL DEFAULT 'portal',
    tenant_id           UUID        NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
    site_id             UUID        NOT NULL REFERENCES site(id)   ON DELETE CASCADE,
    -- KEIN Fremdschluessel auf device: ein Unclaim darf die Historie weder
    -- loeschen noch blockieren (das rollout_device-Muster). Der Klarname reist
    -- als SCHNAPPSCHUSS daneben.
    device_id           UUID,
    device_ref          TEXT,

    -- ---- WOHIN (Schnappschuss zum Zeitpunkt der Anforderung) ----------------
    lane                TEXT,       -- primaer | komponente | frei
    entity_id           UUID,       -- Lane 'komponente' (kein FK, Label daneben)
    target_label        TEXT,       -- "Deye SUN-30K-SG01HP3 · 192.168.0.28 · Unit 1"
    register_kind       TEXT,       -- holding | coil
    address             INTEGER,    -- normalisiert (dezimal)
    write_fc            INTEGER,

    -- ---- DIE VOM MENSCHEN EINGEGEBENEN BEGRIFFE, VERBATIM ------------------
    -- Steht spaeter die Frage "ich habe 231 getippt, nicht 0x00E7", zeigt das
    -- Journal die exakte Zeichenkette - nicht unsere Normalisierung.
    address_input       TEXT,
    value_input         TEXT,
    -- Die Notiz ("Grund, z. B. Freigabe des Netzbetreibers"). PFLICHT bei
    -- Registerklasse netz_compliance (Captain-Entscheid D5), sonst freiwillig -
    -- erzwungen im Anwendungscode, weil die Klasse dort entschieden wird.
    note                TEXT,

    -- ---- WAS (normalisiert) -------------------------------------------------
    value_raw           INTEGER,
    expected_before     INTEGER,
    -- Das Register-WISSEN als SCHNAPPSCHUSS (das rollout_device.device_ref-
    -- Muster): wer das Verzeichnis morgen erweitert, schreibt die Vergangenheit
    -- nicht um.
    register_label      TEXT,
    register_class      TEXT,       -- netz_compliance | bekannt | unbekannt
    scale_note          TEXT,       -- "×10 → 70,0 kW"

    -- ---- WER (ausschliesslich SERVER-seitig gestempelt) ---------------------
    -- 'kunde' | 'voltpilot' = eine ueber ein validiertes JWT beweisbare
    -- Identitaet; 'geraet' = der Wartungszugang an der Box, fuer den es
    -- cloud-seitig KEINE Identitaet gibt - und genau das sagt das Wort.
    origin              TEXT,
    actor_sub           TEXT,       -- JWT-Subject (nie aus dem Request-Koerper)
    actor_name          TEXT,       -- preferred_username, nur zur Anzeige
    actor_role          TEXT,       -- operator | platform-admin | wartungszugang
    via_tenant_switcher BOOLEAN     NOT NULL DEFAULT FALSE,

    -- ---- ERGEBNIS (nur die Quittungs-Zeile) --------------------------------
    before_raw          INTEGER,
    after_raw           INTEGER,
    -- DREIWERTIG: NULL = keine Aussage (Probelauf, ausgebliebene Quittung),
    -- false = angenommen aber NICHT uebernommen, true = zurueckgelesen.
    adopted             BOOLEAN,
    outcome             TEXT,       -- uebernommen|nicht_uebernommen|abgelehnt|fehler|unbekannt
    reason              TEXT,       -- der deutsche Satz der Box, verbatim

    requested_at        TIMESTAMPTZ NOT NULL,
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_register_write_event_event
        CHECK (event IN ('angefordert', 'quittung', 'keine_quittung')),
    CONSTRAINT ck_register_write_event_source
        CHECK (source IN ('portal', 'geraet')),
    CONSTRAINT ck_register_write_event_origin
        CHECK (origin IS NULL OR origin IN ('kunde', 'voltpilot', 'geraet')),
    CONSTRAINT ck_register_write_event_class
        CHECK (register_class IS NULL
               OR register_class IN ('netz_compliance', 'bekannt', 'unbekannt')),
    -- Die Anforderungs-Zeile ist die BEWEIS-Zeile: ohne Ziel, Register,
    -- Verbatim-Eingabe und Urheber waere sie kein Beleg, sondern eine Notiz.
    CONSTRAINT ck_register_write_event_request_complete
        CHECK (event <> 'angefordert' OR (
            lane IS NOT NULL AND target_label IS NOT NULL AND register_kind IS NOT NULL
            AND address IS NOT NULL AND address_input IS NOT NULL
            AND origin IS NOT NULL AND actor_sub IS NOT NULL AND actor_role IS NOT NULL))
);

-- ⚠ EINMALIGKEIT JE (Vorgang, Ereignis) - der Grund, warum ein wiederholter
-- Herzschlag (D6) und eine QoS1-Doppelzustellung der Quittung KEINE zweite
-- Zeile erzeugen: beide Schreibpfade fahren INSERT ... ON CONFLICT DO NOTHING.
-- Das bleibt append-only: ein DO NOTHING ist ein nicht ausgefuehrter INSERT,
-- keine Mutation.
CREATE UNIQUE INDEX IF NOT EXISTS ux_register_write_event_request
    ON register_write_event (request_id, event);

-- Der Lesepfad ist immer "die Vorgaenge dieser Anlage, neueste zuerst".
CREATE INDEX IF NOT EXISTS idx_register_write_event_site
    ON register_write_event (site_id, id DESC);

-- -----------------------------------------------------------------------------
-- Rechte + RLS (das rule_event-/site_forecast_model_choice-Muster)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT ON register_write_event TO ${appDbUser};
-- V2s ALTER DEFAULT PRIVILEGES gaebe der App-Rolle sonst auch UPDATE/DELETE -
-- ein nachtraeglich aenderbares Journal waere keins.
REVOKE UPDATE, DELETE ON register_write_event FROM ${appDbUser};

-- ⚠ Ein BIGSERIAL braucht sein EIGENES Sequenz-Recht: V4s
-- `ALTER DEFAULT PRIVILEGES` deckt TABELLEN ab, Sequenzen sind eine andere
-- Objektklasse (sonst "permission denied for sequence" auf genau dem
-- Schreibpfad, der die Papier-Spur traegt - die dokumentierte
-- rollout_event-Falle).
GRANT USAGE, SELECT ON SEQUENCE register_write_event_id_seq TO ${appDbUser};

ALTER TABLE register_write_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE register_write_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS register_write_event_isolation ON register_write_event;
CREATE POLICY register_write_event_isolation ON register_write_event
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
