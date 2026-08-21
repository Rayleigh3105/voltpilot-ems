-- =============================================================================
-- V20260834000000 - Die ALLOWLIST wird im Portal gepflegt, und die Box sagt,
-- unter welcher Adresse eine Saeule sie anwaehlt.
-- -----------------------------------------------------------------------------
-- Bis hierher liess sich die Allowlist - die Kennungen, unter denen die Box eine
-- Ladesaeule ueberhaupt annimmt - ausschliesslich am Geraet selbst pflegen
-- (`:8484`). Wer eine Saeule anbinden wollte, musste also im LAN am Geraet
-- stehen, obwohl das Portal seit D5 sogar die Adresse der Box kennt. Der erste
-- Schritt des Anbinde-Assistenten blieb damit leer.
--
-- ⚠ DIE ALLOWLIST BLEIBT, NUR IHR PFLEGE-ORT WANDERT. Eine unbekannte Kennung
-- wird von der Box weiterhin abgewiesen und protokolliert; es entsteht KEIN
-- Anlern-Fenster, in dem eine fremde Saeule hereinkaeme. Und die Liste FUEGT NUR
-- HINZU: die Box uebernimmt jeden Eintrag, den sie noch nicht kennt,
-- ueberschreibt keinen bestehenden und ENTFERNT nie einen. Eine Kennung zu
-- loeschen wirft eine Saeule beim naechsten Verbindungsaufbau vom Broker - eine
-- Entscheidung mit Folgen fuer eine laufende Anlage, und die bleibt bewusst eine
-- ausdrueckliche Handlung am Geraet.
--
-- ⚠ Eine EIGENE Tabelle, nicht zwei Spalten an site_charge_point_priority: die
-- ANWESENHEIT einer Zeile dort IST die Vorrang-Aussage (das
-- device_control_activation-Muster), und ein Eintrag der Allowlist ist etwas
-- anderes als ein Vorrang. Zusammengelegt koennte man keine Saeule zulassen,
-- ohne ihr Vorrang zu geben.
--
-- Dazu die Beobachtungs-Seite: Port und Pfad, unter denen der OCPP-Server der
-- Box lauscht. Die Box meldet sie seit dieser Runde im Herzschlag; die Cloud
-- konnte den `ws://`-Endpunkt vorher nicht nennen und musste eine Vorgabe
-- hinschreiben, statt die echte Adresse zu zeigen.
--
-- ⚠ Beide sind NULLABLE OHNE Default und DREIWERTIG: NULL heisst "eine aeltere
-- Box meldet es nicht" ODER "der Server lauscht gerade nicht" - es heisst NIE
-- Port 0. Eine Flaeche, die einen Port nennt, auf dem niemand antwortet, ist
-- schlimmer als eine, die ehrlich nichts nennt.
--
-- Alles ADDITIV: eine Anlage ohne Ladesaeule und eine aeltere Box verhalten sich
-- zeichengleich wie vor dieser Migration.
--
-- Datums-Version nach der AGENTS.md-Regel zur Migrations-Koordination.
-- =============================================================================

-- --- Die ALLOWLIST des Kunden (Portal -> retained Dokument -> Box) ----------

CREATE TABLE IF NOT EXISTS site_charge_point_allowlist (
    site_id         UUID        NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    charge_point_id TEXT        NOT NULL,
    tenant_id       UUID        NOT NULL,
    -- Der Name, unter dem der Kunde die Saeule wiedererkennt. NULL = er hat
    -- keinen vergeben, und dann nimmt die Box die Kennung - nie ein erfundener.
    label           TEXT,
    -- Was der Betreiber zufaellig schon weiss. NULL = unbekannt, nie 0: die Box
    -- entscheidet dann aus dem, was die Saeule selbst meldet.
    rated_kw        DOUBLE PRECISION,
    connectors      INTEGER,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Wer sie eingetragen hat (JWT-Subject) - dieselbe Papier-Spur wie bei jeder
    -- anderen Kunden-Entscheidung ueber eine Anlage.
    added_by        TEXT,
    PRIMARY KEY (site_id, charge_point_id)
);

-- Das Zeichen-Vokabular des Kontrakts, hier ein zweites Mal festgenagelt: eine
-- Kennung, die kein MQTT-Topic-Segment sein kann, darf gar nicht erst
-- gespeichert werden koennen.
ALTER TABLE site_charge_point_allowlist
    DROP CONSTRAINT IF EXISTS site_charge_point_allowlist_id_chk;
ALTER TABLE site_charge_point_allowlist ADD CONSTRAINT site_charge_point_allowlist_id_chk
    CHECK (charge_point_id ~ '^[A-Za-z0-9._-]{1,64}$');

ALTER TABLE site_charge_point_allowlist
    DROP CONSTRAINT IF EXISTS site_charge_point_allowlist_rated_chk;
ALTER TABLE site_charge_point_allowlist ADD CONSTRAINT site_charge_point_allowlist_rated_chk
    CHECK (rated_kw IS NULL OR (rated_kw >= 0 AND rated_kw <= 1000));

ALTER TABLE site_charge_point_allowlist
    DROP CONSTRAINT IF EXISTS site_charge_point_allowlist_connectors_chk;
ALTER TABLE site_charge_point_allowlist ADD CONSTRAINT site_charge_point_allowlist_connectors_chk
    CHECK (connectors IS NULL OR (connectors >= 0 AND connectors <= 32));

-- ⚠ KEIN DELETE, und das ist die Regel als RECHT: die Liste fuegt nur hinzu,
-- die App-Rolle kann eine Kennung gar nicht entfernen. UPDATE braucht sie
-- (das erneute Eintragen frischt Name/Leistung auf).
--
-- Der ON DELETE CASCADE beim Offboarding einer Anlage bleibt davon unberuehrt -
-- eine referenzielle Aktion laeuft als Eigentuemer der Tabelle und umgeht
-- sowohl Rechte als auch FORCE-RLS (an echtem Postgres 16 nachgemessen, nicht
-- nur nachgelesen: die App-Rolle loescht die Anlage, die Allowlist-Zeile geht
-- mit).
GRANT SELECT, INSERT, UPDATE ON site_charge_point_allowlist TO ${appDbUser};

ALTER TABLE site_charge_point_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_charge_point_allowlist FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_charge_point_allowlist_isolation ON site_charge_point_allowlist;
CREATE POLICY site_charge_point_allowlist_isolation ON site_charge_point_allowlist
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- --- Was die BOX ueber ihren OCPP-Server meldet (Herzschlag -> Anzeige) -----

ALTER TABLE device_charging_budget
    ADD COLUMN IF NOT EXISTS ocpp_port     INTEGER,
    ADD COLUMN IF NOT EXISTS ocpp_url_path TEXT;
