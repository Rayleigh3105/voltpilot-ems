-- =============================================================================
-- V20260803010000 - device_update_status: der von der Edge gemeldete
-- SOFTWARE-STAND und Update-Zustand (OTA Stufe 0 „Sehen", Scout
-- vp-ota-rollout-h4 §5/§9). ADDITIV (nur eine neue Tabelle).
-- -----------------------------------------------------------------------------
-- WARUM eine EIGENE Tabelle neben device_edge_version (V20260803000000):
--
--   device_edge_version speichert die zwei Felder, die IM `flows`-Ack-Block
--   mitreisen. Dieser Block entsteht auf der Edge erst NACH ihrem ersten
--   Flow-Deployment - ein Gerät ohne ausgerollte Automation meldete also GAR
--   KEINE Version (Loch 1 der drei belegten Löcher, §2.3). Die Edge sendet
--   deshalb seit dieser Stufe ein TOP-LEVEL `version`-Feld plus einen
--   `update`-Block, beide UNABHÄNGIG vom flows-Block.
--
--   Zwei unabhängige Blöcke, zwei Schreiber, zwei Tabellen - dieselbe
--   Entscheidung wie bei device_curtailment_status neben
--   device_control_status: ein gemeinsamer Zeilen-Upsert von zwei Listenern
--   überschriebe sich gegenseitig, und jeder Block braucht seinen EIGENEN
--   Frische-Anker. Ein Gerät, das den flows-Block einstellt, während der
--   Herzschlag weiterläuft (oder umgekehrt), darf keine alte Aussage am Leben
--   halten.
--
--   version         der Stempel des laufenden Builds, VERBATIM wie gemeldet
--                   (ein Bestands-Build trägt eine nackte 12-stellige
--                   Commit-SHA; erst ein Release-Tag `edge-JJJJ.MM.N` ist im
--                   Register auffindbar - siehe edge_release).
--   backend         welches Apply-Backend läuft ('compose' heute; der Kontrakt
--                   ist bewusst runtime-agnostisch geschnitten).
--   state           idle | verifying | deferred | downloading | applying |
--                   self_test | succeeded | failed | rolled_back. NULL = das
--                   Gerät hat einen `version`-Stempel, aber keinen
--                   `update`-Block gemeldet. Ein Zustand, den wir NICHT kennen,
--                   wird VERWORFEN statt gespeichert (der Listener filtert) -
--                   ein Wort, das wir nicht verstehen, darf kein Satz werden.
--   reason          deutscher Grund; bei deferred/failed/rolled_back Pflicht
--                   auf der Edge-Seite - eine rote Zeile ohne Grund ist nur
--                   ein Alarm.
--   current_version / current_seq / target_version / target_seq / channel /
--   last_known_good bleiben in Stufe 0 überwiegend NULL: das Gerät kennt weder
--                   ein Release-Register noch eine Soll-Zuweisung, und ein
--                   erfundener `release_seq` würde genau die Ordnung
--                   zerstören, für die es das Register gibt. Die Spalten
--                   existieren jetzt, weil Stufe 2 sie füllt, ohne dass
--                   Ingest, DTO und Oberfläche noch einmal wandern.
--   reported_at     der EIGENE Frische-Anker dieses Blocks (Herzschlag-ts).
--
-- Keine Zeile = eine ältere Edge (oder eine, die noch nie gemeldet hat) => die
-- Oberfläche sagt „unbekannt", NIE „veraltet". Eine Zeile je Gerät, bei jedem
-- Herzschlag ERSETZT (der Block trägt den vollständigen Ist).
--
-- Anzeige-only: nichts hiervon speist Telemetrie, Rollups, Erlöse oder den
-- Optimierer, und es gibt in dieser Stufe KEINEN Schreibpfad zum Gerät.
--
-- Mandanten-gefenced + RLS + FORCE exakt wie device_edge_version /
-- device_control_status. Datums-Version nach der AGENTS.md-Koordination.
-- =============================================================================

CREATE TABLE IF NOT EXISTS device_update_status (
    device_id       UUID        PRIMARY KEY,
    tenant_id       UUID        NOT NULL,
    site_id         UUID        NOT NULL,
    version         TEXT,
    backend         TEXT,
    current_version TEXT,
    current_seq     BIGINT,
    target_version  TEXT,
    target_seq      BIGINT,
    channel         TEXT,
    state           TEXT,
    reason          TEXT,
    last_known_good TEXT,
    reported_at     TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_update_status_site
    ON device_update_status (site_id, reported_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON device_update_status TO ${appDbUser};

ALTER TABLE device_update_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_update_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_update_status_isolation ON device_update_status;
CREATE POLICY device_update_status_isolation ON device_update_status
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
