-- =============================================================================
-- V20260818000000 - Einheitsmodell Stufe 3: der BESITZER-ZAUN fuer private
-- Geraete-Vorlagen ("Duplizieren" = eine Vorlage je Anlage).
-- ADDITIV: eine neue Tabelle. Kein bestehender Pfad aendert sein Verhalten.
-- -----------------------------------------------------------------------------
-- WOFÜR (Scout data/vp-modbus-baukasten-k6 Captain-Scope 4 „Vorlagen: NUR je
-- Anlage, privat" + data/vp-komponenten-einheit-h2 Stufenplan Stufe 3):
--
-- Stufe 0a hat `component_template.kind = 'custom'` ausdruecklich RESERVIERT
-- und den Zaun als offene Aufgabe DIESER Stufe vermerkt: eine private Vorlage
-- gehoert EINER Anlage, jene Tabelle ist aber global und ohne RLS, und ihre
-- Lese-Route ist mandanten-agnostisch. Diese Migration baut den Zaun.
--
-- =============================================================================
-- DIE ENTSCHEIDUNG: eigene mandantengebundene Tabelle (b), NICHT eine nullbare
-- site_id auf component_template (a).
-- =============================================================================
-- Beide Wege waren gangbar; (b) gewinnt aus vier Gruenden, und der vierte ist
-- der, der eine kuenftige Runde teuer machen wuerde:
--
--  1. ZWEI FRAGEN, ZWEI LEBENSZYKLEN. `component_template` ist eine Aussage
--     ueber ein PRODUKT (global, ohne Mandant, beim Start aus dem Go-Katalog
--     gespiegelt - die edge_release/provisioned_device-Familie). Eine private
--     Definition sind KUNDENDATEN ueber genau eine Anlage. In einer Tabelle
--     waere die Trennlinie auf Dauer eine nullbare Spalte, deren NULL-heit das
--     Einzige ist, was eine Kundendefinition von der oeffentlichen Route
--     trennt - also ein Praedikat, an das sich jede kuenftige Abfrage erinnern
--     muss. Ein Zaun, den man vergessen kann, ist keiner.
--
--  2. DIE RLS-FORM WAERE EINE ZWEITE, EINMALIGE SEMANTIK. Jede RLS-Tabelle
--     dieses Hauses ist OHNE Mandanten default-deny. Eine Policy auf
--     component_template muesste dagegen „site_id IS NULL ist oeffentlich"
--     sagen, damit der Seeder und die mandanten-agnostische Lese-Route
--     weiterhin Zeilen sehen - eine Ausnahme-Semantik, die genau einmal
--     vorkaeme und die man beim Lesen jeder anderen Policy neu erklaeren
--     muesste.
--
--  3. DIE RECHTE LIESSEN SICH NICHT AUSDRUECKEN. Die App-Rolle darf auf den
--     globalen Zeilen NUR lesen (V20260815000000 nimmt ihr INSERT/UPDATE/DELETE
--     ausdruecklich weg), auf ihren EIGENEN Zeilen aber schreiben. Als
--     Tabellen-GRANT ist das nicht sagbar - der Zaun waere wieder
--     Anwendungscode.
--
--  4. DIE SPALTEN PASSEN NICHT AUFEINANDER. Hier sind `channels` PFLICHT (die
--     Kanal-Liste IST die Vorlage), waehrend sie dort ehrlich NULL sind
--     („diese Vorlage erklaert es hier nicht"); `family` ist beim Selbstbau
--     bedeutungslos, `certification_status` immer 'not_certified',
--     `control_tier` immer 0. In einer Tabelle waeren das vier Spalten, die je
--     nach Herkunft etwas anderes bedeuten - genau die Doppeldeutigkeit, die
--     das Einheitsmodell beseitigt.
--
-- FOLGE, die bestehen bleibt: `component_template.kind = 'custom'` wird von
-- NIEMANDEM geschrieben und von der oeffentlichen Route nie ausgeliefert. Der
-- Wert bleibt im CHECK-Vokabular stehen (eine angewandte Migration ist
-- unaenderbar), und ComponentTemplateApiTest legt weiterhin von Hand eine
-- solche Zeile an, um zu beweisen, dass sie nie herauskommt.
--
-- Datums-Version oberhalb des hoechsten ausgelieferten Standes
-- (V20260817000000) - eine kleinere Version waere fuer Flyway „out of order"
-- und wuerde auf einer langlebigen DB nie angewandt.
-- =============================================================================

CREATE TABLE IF NOT EXISTS site_component_template (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Der Zaun. Beide Spalten sind NOT NULL: eine private Vorlage OHNE Anlage
    -- gibt es nicht, und eine ohne Mandanten koennte RLS nicht scoped halten.
    tenant_id     UUID NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
    site_id       UUID NOT NULL REFERENCES site (id) ON DELETE CASCADE,

    -- Der stabile, OPAQUE Schluessel - 'custom:<uuid>'. Wie beim globalen
    -- Register gilt: kein Abnehmer zerlegt ihn.
    template_ref  TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),

    label         TEXT NOT NULL,

    -- Die Anbindungs-Art. In dieser Stufe ausschliesslich 'modbus_baukasten';
    -- die Spalte steht trotzdem da, weil die Selbstbau-Tuer transport-plural
    -- angelegt ist (h2 §4.4: HTTP/MQTT folgen als Stufe 3b) und ein spaeterer
    -- Transport hier nur einen weiteren Wert einsetzt.
    communication TEXT NOT NULL,

    -- Die Verbindungs-VORGABE der Vorlage (Port/Unit-ID; der HOST bleibt
    -- bewusst leer - eine duplizierte Vorlage zeigt nie auf das Geraet, aus
    -- dem sie entstand).
    connection    JSONB NOT NULL,

    -- ⚠ Die Kanal-Liste ist hier PFLICHT und ohne Default. Sie IST die
    -- Vorlage; eine Vorlage ohne Kanaele beschriebe kein Geraet. (Das globale
    -- Register laesst sie bewusst NULL - dort heisst NULL „diese Vorlage
    -- erklaert ihre Kanaele nicht", weil sie im Decode-Profil im Code stehen.)
    -- Form: [{slug, label, unit, register{kind,address,data_type,word_order},
    --         scale, offset, min_read_interval_s}]
    channels      JSONB NOT NULL,

    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    TEXT NOT NULL,

    -- Dieselbe Zeichenmenge wie im globalen Register, damit ein Schluessel
    -- ueberall gleich aussieht und beide Seiten dieselbe pruefen.
    CONSTRAINT site_component_template_ref_charset
        CHECK (template_ref ~ '^[a-z0-9][a-z0-9._:-]{0,127}$')
);

-- Eine Fassung je Schluessel steht genau EINMAL drin.
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_component_template_ref_version
    ON site_component_template (template_ref, version);

-- Die Liste einer Anlage, neueste Fassung zuerst.
CREATE INDEX IF NOT EXISTS idx_site_component_template_site
    ON site_component_template (site_id, label);

-- -----------------------------------------------------------------------------
-- RLS: der eigentliche Zaun - das Haus-Muster (flow_definition, rule_event),
-- ohne Mandanten default-deny.
-- -----------------------------------------------------------------------------
ALTER TABLE site_component_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_component_template FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_component_template_isolation ON site_component_template;
CREATE POLICY site_component_template_isolation ON site_component_template
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- V2s ALTER DEFAULT PRIVILEGES deckt die App-Rolle ab; hier ist SCHREIBEN
-- ausdruecklich erwuenscht (es sind die Daten des Kunden), der Zaun ist die
-- Policy. Explizit, damit die Absicht an der Tabelle steht.
GRANT SELECT, INSERT, UPDATE, DELETE ON site_component_template TO ${appDbUser};
-- Sequenzen gibt es keine - die Id kommt aus gen_random_uuid() -, also
-- entfaellt die dokumentierte rollout_event_id_seq-Falle.
