-- =============================================================================
-- V20260842000000 - flow_claim: die MATERIALISIERTE Beanspruchung einer
-- Komponente durch eine aktive Kundenregel (Steuerung Stufe 3 „Vorrang
-- technisch", Konzept vp-steuerung-konzept-b3 §3.7 A3/A4 + §4). ADDITIV.
-- -----------------------------------------------------------------------------
-- WARUM eine Tabelle, obwohl `FlowClaims` die Ansprüche längst ableitet: die
-- Ableitung lebt in Java und NUR zur Laufzeit. Zwei Abnehmer brauchen sie
-- ausserhalb dieses Prozesses:
--
--   1. der REGISTRY-PUSH (`EntityRegistryService.composePush` → `owner_claimed`),
--      damit die Box für eine beanspruchte Komponente KEINEN Fahrplan-Sollwert
--      mehr einspeist - die Regel gewinnt dann, weil kein Konkurrent existiert
--      (Arbiter, D-4/D-5/D-6 bleiben unangetastet);
--   2. der OPTIMIERER (`services/optimization` `inputs.py`), der `flow_definition`
--      bis hierher NIRGENDS kannte und deshalb jede Anlage mit Primär-Batterie
--      geplant hat - auch die, deren Speicher eine Kundenregel hält. Ohne diese
--      Zeile plant er still Geld ein, das nie verdient wird.
--
-- Eine Zeile ist EINE Beanspruchung: (Komponente, Kommando) durch GENAU EINEN
-- aktiven Flow - das ist exakt die V-5-Invariante, deshalb ist
-- (entity_id, command) der Primärschlüssel. Geschrieben wird ausschliesslich in
-- der Aktivierungs-Transaktion (`FlowActivationService.activate`), geräumt beim
-- Stilllegen und beim Löschen des Flows.
--
-- ⚠ `flow_name` ist ein SCHNAPPSCHUSS (das `rollout_device.device_ref`-Muster),
-- damit eine Oberfläche den Halter benennen kann, ohne dass das Umbenennen
-- eines Flows die Beanspruchung anfasst. Der Fremdschlüssel auf
-- `flow_definition` fehlt bewusst: dessen Primärschlüssel ist
-- (flow_id, flow_version), und die Beanspruchung überlebt eine neue Fassung.
--
-- Mandantengebunden mit ENABLE + FORCE RLS wie `flow_definition` - das sind
-- KUNDENDATEN, ausdrücklich nicht global wie `edge_release`.
-- =============================================================================

CREATE TABLE IF NOT EXISTS flow_claim (
    entity_id     UUID          NOT NULL,
    command       TEXT          NOT NULL,
    tenant_id     UUID          NOT NULL,
    site_id       UUID          NOT NULL,
    flow_id       UUID          NOT NULL,
    flow_version  INTEGER       NOT NULL,
    flow_name     TEXT          NOT NULL,
    delegated     BOOLEAN       NOT NULL DEFAULT FALSE,
    claimed_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_id, command)
);

CREATE INDEX IF NOT EXISTS idx_flow_claim_site ON flow_claim (site_id);
CREATE INDEX IF NOT EXISTS idx_flow_claim_flow ON flow_claim (flow_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON flow_claim TO ${appDbUser};

ALTER TABLE flow_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_claim FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_claim_isolation ON flow_claim;
CREATE POLICY flow_claim_isolation ON flow_claim
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
