-- =============================================================================
-- V20260816000000 - das REGEL-PROTOKOLL (Einheitsmodell Stufe 5b, Konzept
-- `vp-komponenten-einheit-h2` Teil 5b.6). ADDITIV (zwei neue Tabellen).
-- -----------------------------------------------------------------------------
-- Die Fläche „Regeln" hat seit M4 das Feld `AutomationActivity {switchedToday,
-- lastSwitchedAt}` - und es wurde von NIEMANDEM befüllt, weil es NIRGENDS einen
-- Verlauf gab: `flow_device_ack`/`flow_node_status`/`consumer_runtime_status`
-- sind allesamt MOMENTAUFNAHMEN (je Herzschlag gelöscht und neu geschrieben).
-- Diese Tabelle ist der fehlende Speicher.
--
-- STUFE A (hier): geschrieben wird AUSSCHLIESSLICH aus dem BESTEHENDEN
-- Herzschlag-Strom - die Momentaufnahmen-Zuhörer vergleichen ALT gegen NEU und
-- halten nur die WECHSEL fest (das `ConsumerRequirementLedgerWriter`-Muster:
-- telemetrie-getrieben, nie werfend, nie `@Scheduled`). KEINE Edge-Änderung.
-- Der Präzisions-Uplink der Arbitrierungs-Ereignisse (5b-2) ist additiv und
-- eine eigene Stufe; er verfeinert diese Tabelle später, ohne sie umzubauen.
--
--   entity_id       die KOMPONENTE, an der der Wechsel gemessen wurde
--                   (NULL bei einem Ereignis, das die Regel selbst betrifft -
--                   das Ausrollen auf das Gerät).
--   rule_kind /     die Regel, so wie sie IM MOMENT des Ereignisses zuständig
--   rule_ref        war - ein SCHNAPPSCHUSS wie `rollout_device.device_ref`,
--                   nie ein Fremdschlüssel: eine gelöschte Regel darf ihren
--                   Verlauf nicht mitnehmen und sein Löschen nicht blockieren.
--                   Zugeordnet über den EXKLUSIVEN Steuer-Anspruch (V-5:
--                   höchstens EINE aktive Regel je Komponente) plus den
--                   Origin-Stempel - eindeutig, nie geraten. NULL heißt
--                   ehrlich „keiner Regel zuzuordnen", nie eine geratene.
--   kind            'gestartet' | 'gestoppt' | 'zustand' | 'ausgerollt' |
--                   'geraet_problem' | 'protokoll_gedeckelt'.
--   state /         das GEMELDETE Zustandswort und sein Vorgänger. Ein Wort
--   previous_state  außerhalb des Vokabulars hat der Ingest schon verworfen,
--                   hier steht also nie ein geratenes.
--   actual_kw       der gemessene Wert IM Moment des Wechsels; NULL = nicht
--                   gemessen (nie eine erfundene 0).
--
-- AUFBEWAHRUNG: 90 Tage. Der Verlauf beantwortet „was hat meine Regel in den
-- letzten Wochen getan"; älter fragt niemand, und die abrechnungsnahen
-- Wahrheiten leben ohnehin woanders (Erfüllungs-Ledger, Erlöse).
-- VERDICHTUNG: bewusst KEINE - geschrieben wird nur ein WECHSEL, und eine
-- Komponente wechselt wenige Male am Tag; eine Verdichtung erzeugte eine
-- zweite Wahrheit über dieselben Ereignisse. Gegen ein FLATTERNDES Gerät steht
-- stattdessen ein Deckel je Anlage und Tag, der sich SELBST ins Protokoll
-- schreibt ('protokoll_gedeckelt') statt still zu kappen.
-- Gelöscht wird opportunistisch im Schreibpfad (höchstens einmal je Stunde je
-- api-Instanz, gedeckelte DELETE) - kein neuer `@Scheduled`-Job (die
-- dokumentierte Testcontainers-Falle) und kein neues Flag im gitops-Repo.
--
-- Mandantengebunden + RLS/FORCE wie `consumer_runtime_status` (der Zuhörer
-- läuft als App-Rolle mit dem Mandanten des Topics in `app.tenant_id`; das
-- WITH CHECK stempelt die Zeile). AUSDRÜCKLICH NICHT global wie `rollout_event`
-- - das hier sind KUNDENDATEN.
--
-- Datums-Version ÜBER dem höchsten ausgelieferten Stand (V20260815000000) per
-- der AGENTS.md-Regel „out of order wird nie angewandt".
-- =============================================================================

CREATE TABLE IF NOT EXISTS rule_event (
    id             BIGSERIAL     PRIMARY KEY,
    tenant_id      UUID          NOT NULL,
    site_id        UUID          NOT NULL,
    entity_id      UUID,
    rule_kind      TEXT,
    rule_ref       TEXT,
    kind           TEXT          NOT NULL,
    state          TEXT,
    previous_state TEXT,
    reason_code    TEXT,
    actual_kw      DOUBLE PRECISION,
    detail         TEXT,
    occurred_at    TIMESTAMPTZ   NOT NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Das Gesamt-Protokoll einer Anlage (neueste zuerst) und das Aufräumen.
CREATE INDEX IF NOT EXISTS idx_rule_event_site
    ON rule_event (site_id, occurred_at DESC);
-- Der Ausschnitt je Regel + die Tageszähler.
CREATE INDEX IF NOT EXISTS idx_rule_event_rule
    ON rule_event (site_id, rule_kind, rule_ref, occurred_at DESC);

-- Ab wann für diese Anlage überhaupt aufgezeichnet wird. OHNE diese Zeile
-- wäre „heute 0× geschaltet" eine Behauptung über eine Zeit, in der niemand
-- hingesehen hat; mit ihr sagt die Fläche stattdessen „seit HH:MM
-- aufgezeichnet". Genau EINE Zeile je Anlage, der erste Eintrag gewinnt.
CREATE TABLE IF NOT EXISTS rule_event_recording (
    site_id    UUID        PRIMARY KEY,
    tenant_id  UUID        NOT NULL,
    started_at TIMESTAMPTZ NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON rule_event TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON rule_event_recording TO ${appDbUser};

-- Ein BIGSERIAL braucht sein EIGENES Sequenz-Recht: V4s
-- `ALTER DEFAULT PRIVILEGES` deckt TABELLEN ab, Sequenzen sind eine andere
-- Objektklasse (sonst „permission denied for sequence" auf genau dem
-- Schreibpfad, der die Papier-Spur trägt - die dokumentierte rollout_event-Falle).
GRANT USAGE, SELECT ON SEQUENCE rule_event_id_seq TO ${appDbUser};

ALTER TABLE rule_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rule_event_isolation ON rule_event;
CREATE POLICY rule_event_isolation ON rule_event
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE rule_event_recording ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_event_recording FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rule_event_recording_isolation ON rule_event_recording;
CREATE POLICY rule_event_recording_isolation ON rule_event_recording
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
