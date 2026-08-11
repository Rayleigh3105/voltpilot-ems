-- =============================================================================
-- V20260815000000 - Einheitsmodell Stufe 0a: „Vorlagen werden Daten".
-- ADDITIV: eine neue Tabelle + zwei nullbare Spalten. Kein bestehender Pfad
-- aendert sein Verhalten; nach dieser Migration konsumiert NICHTS die Vorlagen.
-- -----------------------------------------------------------------------------
-- WOFÜR (Scout data/vp-komponenten-einheit-h2, Teil 3.1 + Stufenplan Stufe 0a):
--
-- Der Geraete-Katalog, aus dem der Kunde heute Marke/Modell/Anbindung waehlt,
-- ist eine GO-FUNKTION auf der Box (edge-app/core/internal/inverter
-- DefaultCatalog()). Er kennt 7 Marken und 44 Modelle - aber nur die Box kennt
-- ihn. Der spaetere EINE Anlege-Assistent im Portal braucht dieselbe Liste
-- cloud-seitig, und eine „gepruefte Vorlage" (Stufe 6) soll ein DATENSATZ sein,
-- kein Software-Release. Diese Migration schafft dafuer den Speicher.
--
-- ⚠ SIE ERSETZT DEN GO-KATALOG NICHT. Der bleibt die Wahrheit darueber, was die
-- Box wirklich lesen kann (Decode-Profile, Node-RED-Adapter, Go-Executoren).
-- Diese Tabelle ist die cloud-seitige DARSTELLUNG davon. Gefuellt wird sie beim
-- Start der api aus der eingecheckten Datei
-- `componenttemplates/builtin.json`, die `cmd/vp-template-export` aus dem
-- Go-Katalog erzeugt; ein Go-Test vergleicht Katalog und Datei byteweise.
-- Deshalb steht hier auch KEIN Seed: eine angewandte Migration ist unaenderbar
-- (AGENTS.md), ein 44-Zeilen-Seed waere ab dem naechsten Katalog-Edit falsch,
-- und die Korrektur brauchte jedes Mal eine weitere Migration.
--
-- ⚠ GLOBAL, ohne tenant_id und ohne RLS - wie edge_release, provisioned_device
-- und inverter_control_certification, und aus demselben Grund: eine Vorlage ist
-- eine Aussage ueber ein PRODUKT, keine Kundendaten. Eine tenant_id wuerde
-- einen Kunden-Schreibpfad suggerieren, den es hier nicht geben soll. Gefenced
-- ist der ENDPUNKT: die Lese-Route ist authentifiziert und liefert nur die
-- oeffentlichen Herkunftsarten (builtin/certified); Schreiben gibt es in dieser
-- Stufe ueberhaupt nicht (nur den Start-Abgleich der eingebauten Vorlagen ueber
-- die BYPASSRLS-Rolle voltpilot_admin).
--
-- Datums-Version oberhalb des hoechsten ausgelieferten Standes
-- (V20260814000000) - eine kleinere Version waere fuer Flyway „out of order"
-- und wuerde auf einer langlebigen DB nie angewandt.
-- =============================================================================

CREATE TABLE IF NOT EXISTS component_template (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- HERKUNFT der Vorlage. Das Vokabular ist vollstaendig, auch wenn diese
    -- Stufe nur 'builtin' erzeugt:
    --   builtin   - kommt aus dem Go-Katalog, wird mit der Edge-Software
    --               ausgeliefert (der Erstbestand).
    --   certified - von VoltPilot geprueft eingetragen, als DATEN (Stufe 6).
    --   custom    - selbst definiert, privat je Anlage (Stufe 3).
    -- ⚠ 'custom' ist RESERVIERT, nicht benutzbar: eine private Vorlage braucht
    -- einen Besitzer-Zaun, und diese Tabelle hat bewusst keine tenant_id. Stufe
    -- 3 muss den Zaun ausdruecklich bauen (nullbare site_id + Policy, oder eine
    -- eigene Tabelle). Bis dahin schreibt niemand 'custom', und die Lese-Route
    -- liefert es nie aus (festgenagelt in ComponentTemplateApiTest).
    kind                 TEXT NOT NULL,

    -- Der stabile, OPAQUE Schluessel der Vorlage. Fuer eingebaute Vorlagen
    -- deterministisch 'builtin:<marke>:<modell>'.
    -- ⚠ Kein Abnehmer darf ihn zerlegen - Marke/Modell stehen als eigene
    -- Spalten daneben, genau damit niemand am String parsen muss.
    template_ref         TEXT NOT NULL,

    -- Die DEFINITIONS-Fassung. Eingebaute Vorlagen bleiben auf 1: ihre Fassung
    -- IST der Edge-Softwarestand (das Release-Register), nicht eine eigene
    -- Zaehlung - sonst haette ein Tippfehler im Katalog eine Versionshistorie
    -- erzeugt. Geprueft/selbst gebaut versioniert ausdruecklich (Stufe 6/3);
    -- die Lese-Route liefert je Schluessel die HOECHSTE Fassung.
    version              INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),

    brand                TEXT NOT NULL,
    brand_label          TEXT NOT NULL,
    model                TEXT NOT NULL,
    model_label          TEXT NOT NULL,

    -- Die Decode-Profil-Referenz: der interne Registerkarten-Name, mit dem
    -- Layer 1 sich self-wired. Sie ist die Bruecke zwischen der DATEN-Vorlage
    -- und dem CODE, der sie ausfuehrt. NULL beim Selbstbau (dort IST die
    -- Kanal-Liste der Leseplan).
    family               TEXT,
    family_label         TEXT,

    communication        TEXT NOT NULL,
    communication_label  TEXT,

    -- Das Formular je Anbindung: das generische Feld-Vokabular
    -- {key,label,type,required,default,help,options}, das die `:8484`-Seite
    -- heute schon rendert. Fuer eingebaute Vorlagen ECHTE Daten.
    transport_schema     JSONB NOT NULL,

    -- ⚠ DIE ZWEI EHRLICHKEITS-SPALTEN. NULL heisst „diese Vorlage erklaert es
    -- hier NICHT" - nicht „es gibt keine". Deshalb nullbar und OHNE Default:
    -- ein DEFAULT '[]' machte aus jeder Lücke eine Behauptung.
    --
    -- channels: Kanal-Definitionen (Register -> Klartext-Messwert). Eine
    -- eingebaute Vorlage traegt IMMER NULL: ihre Kanaele entstehen im
    -- Decode-Profil (nodered/deye/deye-decode.js, sunspec-live.js, ...), also im
    -- Code. '[]' waere die glatte Luege „liefert keine Messwerte", obwohl ein
    -- Deye PV/SoC/Batterie/Netz/Last publiziert. Der Selbstbau (Stufe 3) fuellt
    -- sie; Form:
    --   [{slug, label, unit, register{kind,address,data_type,word_order},
    --     scale, offset}]
    channels             JSONB,

    -- writes: Schreib-Definitionen - in dieser Stufe reines SCHEMA, ohne einen
    -- einzigen Verbraucher im Code. Auch hier traegt eine eingebaute Vorlage
    -- NULL: ihr Schreibweg ist der Steuer-Adapter im Code und wird vom
    -- Plattform-Register inverter_control_certification (brand+model)
    -- freigegeben, nicht von dieser Tabelle. Form nach den k6-Leitplanken §2.4
    -- (zwei Schalt-Arten, nie ein freier Schreib-Baustein):
    --   [{key, label, kind:'on_off'|'setpoint',
    --     register{fc,address,data_type,word_order},
    --     on_value, off_value,              -- kind = on_off
    --     min, max, unit,                   -- kind = setpoint (die Klemme)
    --     safe_value,                       -- Sicherheitswert fuer Stille/Widerruf
    --     readback{address}, watchdog{register,value,interval_s}}]
    writes               JSONB,

    -- Nennleistung in kW. NULL = im Katalog unbekannt (der generische
    -- SunSpec-/Fronius-/go-e-/Shelly-Eintrag). Nie 0 - das waere eine Aussage
    -- ueber ein Geraet, die niemand belegt hat.
    rated_kw             NUMERIC(10, 3) CHECK (rated_kw IS NULL OR rated_kw > 0),

    -- Das deklarierte Steuer-PRIMITIV der Marke (0-3, siehe inverter.go
    -- ControlTier*). Es AUTORISIERT NICHTS: ob je ein Schreibbefehl herausgeht,
    -- entscheiden Not-Aus, Zertifizierungs-Register und Scharfschaltung.
    control_tier         INTEGER NOT NULL DEFAULT 0 CHECK (control_tier BETWEEN 0 AND 3),

    -- Der PRUEF-Zustand. Er beantwortet eine ANDERE Frage als `kind`:
    -- kind = woher die Vorlage kommt, status = wofuer die Plattform einsteht.
    --   builtin          - wird mit der Edge-Software ausgeliefert und laeuft
    --                      auf der Flotte. Bewusst NICHT 'certified' - das Wort
    --                      gehoert dem Pruefstand, und eine Baureihe, die nie
    --                      auf einem Tisch stand, waere damit ueberbehauptet.
    --   certified        - von VoltPilot geprueft (Stufe 6).
    --   in_certification - Pruefung laeuft.
    --   not_certified    - ungeprueft (Selbstbau).
    -- Das Vokabular spiegelt bewusst das des Typ-Katalogs
    -- (entitytypes/catalog.json) - eine zweite Sprache fuer dieselbe Frage
    -- waere genau die Doppeldeutigkeit, die dieses Konzept beseitigt.
    certification_status TEXT NOT NULL,
    certified_at         TIMESTAMPTZ,
    certification_note   TEXT,

    -- Anzeigetext/Notiz fuer den Assistenten.
    note                 TEXT,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Wer die Zeile angelegt hat ('startup:builtin-templates' fuer den
    -- Erstbestand, spaeter das JWT-Subject des Admins).
    created_by           TEXT NOT NULL,

    CONSTRAINT component_template_kind_word
        CHECK (kind IN ('builtin', 'certified', 'custom')),
    CONSTRAINT component_template_cert_word
        CHECK (certification_status IN
               ('builtin', 'certified', 'in_certification', 'not_certified')),
    -- Der Schluessel reist als Pfad-/Spaltenwert durch die Cloud; die
    -- Zeichenmenge ist gepinnt (die Go- und die Java-Seite pruefen dieselbe).
    CONSTRAINT component_template_ref_charset
        CHECK (template_ref ~ '^[a-z0-9][a-z0-9._:-]{0,127}$')
);

-- Eine Fassung je Schluessel steht genau EINMAL drin. Ein zweiter Eintrag waeren
-- zwei Wahrheiten ueber dasselbe Produkt in derselben Fassung.
CREATE UNIQUE INDEX IF NOT EXISTS uq_component_template_ref_version
    ON component_template (template_ref, version);

-- Die Liste des Assistenten gruppiert nach Marke.
CREATE INDEX IF NOT EXISTS idx_component_template_kind_brand
    ON component_template (kind, brand, model);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle sonst SELECT/INSERT/UPDATE/
-- DELETE auf jede neue Tabelle. Auf einer GLOBALEN Tabelle waere das eine offene
-- Tuer: es gibt keinen Kunden-Schreibpfad auf eine Vorlage. Also LESEN ja
-- (die Kunden-Route liest sie), SCHREIBEN weg - wortgleich das
-- provisioned_device-Muster.
GRANT SELECT ON component_template TO ${appDbUser};
REVOKE INSERT, UPDATE, DELETE ON component_template FROM ${appDbUser};
-- Die BYPASSRLS-Rolle voltpilot_admin deckt V4s ALTER DEFAULT PRIVILEGES ab
-- (die Tabelle entsteht NACH V4 durch denselben Flyway-Superuser); sie ist der
-- einzige Schreiber (der Start-Abgleich der eingebauten Vorlagen). Sequenzen
-- gibt es keine - die Id kommt aus gen_random_uuid() -, also entfaellt die
-- rollout_event_id_seq-Falle.

-- -----------------------------------------------------------------------------
-- Die zwei additiven Spalten an der KOMPONENTE (measurement_point)
-- -----------------------------------------------------------------------------
-- Sie beantworten „woher kommt die Anbindung dieser Komponente?" - die Frage,
-- die der spaetere Assistent stellen muss, um „Verbindung bearbeiten" bzw.
-- einen Vorlagen-Wechsel ueberhaupt anbieten zu koennen.
--
-- ⚠ BEIDE NULLBAR, ohne Default. Bestandszeilen bleiben unberuehrt, und NULL
-- heisst ehrlich „unbekannt" (die Zeile entstand, bevor es Vorlagen gab) - nie
-- eine erfundene Herkunft. RLS-Policies und Grants von measurement_point sind
-- unberuehrt (V20260709000000), es ist ein reines ADD COLUMN.
--
--   source_kind: builtin | certified | custom | composed
--     'composed' ist der Sonderfall der Plattform-Komposition (#385): diese
--     Zeilen kommen aus den v1-Stammdaten der Anlage, nicht aus einer Vorlage,
--     und tragen deshalb KEIN template_ref.
--   template_ref/template_version: WELCHE Vorlage in WELCHER Fassung benutzt
--     wurde. Absichtlich KEIN Fremdschluessel: die Fassung ist ein
--     Schnappschuss (wie rollout_device.device_ref/site_name) - eine spaeter
--     zurueckgezogene Vorlage darf die Historie der Komponente nicht loeschen
--     und ihr Loeschen nicht blockieren.
ALTER TABLE measurement_point
    ADD COLUMN IF NOT EXISTS source_kind      TEXT,
    ADD COLUMN IF NOT EXISTS template_ref     TEXT,
    ADD COLUMN IF NOT EXISTS template_version INTEGER;

-- Das Vokabular ist gepinnt, aber NULL bleibt erlaubt (Bestand + kuenftige
-- Zeilen, die keine Anbindungs-Herkunft haben).
ALTER TABLE measurement_point
    DROP CONSTRAINT IF EXISTS measurement_point_source_kind_word;
ALTER TABLE measurement_point
    ADD CONSTRAINT measurement_point_source_kind_word
    CHECK (source_kind IS NULL
           OR source_kind IN ('builtin', 'certified', 'custom', 'composed'));

-- Eine Vorlagen-Referenz ist nur mit ihrer Fassung eine Aussage - und eine
-- Fassung ohne Referenz waere eine Zahl ohne Bezug. Also beides oder keines.
ALTER TABLE measurement_point
    DROP CONSTRAINT IF EXISTS measurement_point_template_ref_pair;
ALTER TABLE measurement_point
    ADD CONSTRAINT measurement_point_template_ref_pair
    CHECK ((template_ref IS NULL) = (template_version IS NULL));
