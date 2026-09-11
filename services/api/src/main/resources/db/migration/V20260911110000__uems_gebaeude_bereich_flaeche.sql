-- UEMS AP-02 IP-2b: Gebäude und Bereiche (`ort`), ihre zeitgültige Zuordnung
-- zum Elternknoten (`ort_zuordnung`) und die zeitgültige Bezugsfläche je
-- Standort, Gebäude und Bereich (`flaeche_gueltigkeit`).
--
-- Die Prosa-Wahrheit ist das Konzept vp-uems-ap02-ortsstruktur (§4.1 Felder
-- G und B, §4.3 Gültigkeit, §4.5 Invarianten, §6.2 Datenhaltung; Captain-
-- Entscheide vom 10.09.2026). Die Gültigkeitsmechanik ist VERTRAG:
-- docs/contracts/v2/ortsbaum-vectors.json (AP-02 IP-1) mit den Zwillingen
-- OrtsbaumAbleitung.java / uemsOrtsbaum.ts. Diese Migration sagt dasselbe als
-- Constraint; UemsOrteMigrationTest spielt die Tabelle `erlaubte_eltern` und
-- die Überlappungs-Fälle der Vektor-Datei gegen die Datenbank.
--
-- ⚠ REIN ADDITIV. `tenant`, `site` und die vier Tabellen von IP-2a
-- (V20260911100000) bleiben zeichengleich. `ort_aenderung` braucht KEIN Weiten:
-- ihre Objektarten kennen `gebaeude` und `bereich` schon, ihre Arten
-- `flaeche_geaendert`. Kein Backfill — Gebäude und Bereiche legt erst der
-- Kunde an (IP-5); die Bestandsübernahme (IP-9) legt nur Standorte an.
--
-- Die Mechanik ist dieselbe wie bei `anlage_standort`: „gültig ab" ist ein TAG
-- (00:00 in der Zeitzone des Standorts, E9); `gueltig_bis` ist der LETZTE
-- gültige Tag, einschließlich — NULL = offen; je Objekt genau ein Intervall je
-- Tag (Exklusions-Constraint auf daterange(ab, bis, '[]')); ein neues „gültig
-- ab" beendet das laufende am VORTAG; eine Korrektur hebt ein Intervall auf
-- (`aufgehoben_am`) und lässt es lesbar. Eine Intervall-Zeile wird nie gelöscht
-- und nie umgeschrieben (Rechte unten).
--
-- WAS DIE DATENBANK NICHT PRÜFT (Regeln des Schreibwegs, IP-5/IP-12, mit
-- OrtsbaumAbleitung — sie brauchen den Tag, den Baum oder einen Kundensatz):
--   * „Das Ziel besteht an JEDEM Tag des neuen Intervalls" (`ziel_gab_es_noch_nicht`,
--     `ziel_archiviert`). Das Bestehen eines STANDORTS steht in keiner Tabelle als
--     Intervall (IP-2a: `created_at` + `archiviert_am`; die Lücke zwischen Archiv
--     und Wiederherstellen lebt nur im Protokoll; ob ein Standort ein „besteht
--     seit" in der Vergangenheit tragen darf, ist offen — Vektor-Fall A2). Für
--     Gebäude als Ziel ginge es nur mit einem zurückgestellten Trigger auf beiden
--     Seiten, weil Verschieben (E11) und Archivieren (E12) innerhalb einer
--     Transaktion Zwischenstände durchlaufen. Eine halbe Prüfung an zwei Orten
--     ist schlechter als eine ganze an einem — und der Vertrag verlangt zur
--     Ablehnung den Tag und den Satz („gibt es im Portal erst seit …").
--   * `vor_dem_ersten_intervall`, `gleicher_tag`, `ziel_ist_bisheriger_eltern`,
--     `objekt_archiviert`, `kein_beginn_an_dem_tag` — Vorgänge, keine Zeilen.
--   * Der Name eindeutig je Elternknoten unter nicht archivierten Geschwistern
--     (§4.1, Regel 13): der Elternknoten ist zeitgültig, die Eindeutigkeit also
--     eine Aussage über einen TAG, kein Index. Ebenso ein Kurzzeichen, das
--     zwischen `standort` und `ort` kollidiert (zwei Tabellen).
--   * Das Baujahr bis zum LAUFENDEN Jahr: zeitabhängig — ein CHECK muss für
--     dieselbe Zeile immer dasselbe sagen (die Annahme, unter der Postgres ihn
--     nur beim Schreiben prüft). Der CHECK hält die zeitlose Hälfte.
--
-- LÖSCHEN (E1, Plan-Regel „nichts mit Historie wird gelöscht"): jeder Fremd-
-- schlüssel ist ON DELETE RESTRICT, die App-Rolle hat auf keiner der drei
-- Tabellen DELETE. Das Offboarding (TenantRepository.offboard) räumt sie
-- ausdrücklich ab, Kinder zuerst. Das Löschen OHNE Historie (IP-15) entscheidet
-- sein Paket.

-- -----------------------------------------------------------------------------
-- ort — Gebäude und Bereich (AP-02 §4.1 G und B)
-- -----------------------------------------------------------------------------
-- Der Standort ist KEIN `ort`: er hat seine eigene Tabelle (IP-2a) und hängt an
-- nichts Zeitgültigem. Woran ein Ort hängt, steht nicht hier, sondern je Tag in
-- `ort_zuordnung` — nur so trägt ein Umzug Historie.
CREATE TABLE IF NOT EXISTS ort (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL,
    -- gebaeude | bereich. Die Art ist Identität (Kurzzeichen G-x/B-x, Protokoll-
    -- Objektart): die App-Rolle darf sie nicht ändern (Spaltenrechte unten), und
    -- sobald ein Bereich an einem Gebäude hängt, halten die Fremdschlüssel von
    -- `ort_zuordnung` die Art beider fest — auch gegen den Eigentümer.
    art            TEXT        NOT NULL,
    -- Pflicht wie im Ortsbaum-Vertrag (`ort.name`, 1–120). Den namenlosen Entwurf
    -- (§4.2: nur per Übernahme, AP-14) gibt es in dieser Fassung nicht; braucht
    -- AP-14 ihn, weitet es additiv.
    name           TEXT        NOT NULL,
    -- G-1, G-2 … / B-1, B-2 … automatisch vergeben (IP-5), änderbar, für immer
    -- eindeutig je Kundenbereich — auch ein archivierter Ort behält seines (E8).
    kurzzeichen    TEXT        NOT NULL,
    -- Dasselbe Vokabular wie am Standort (E4): uems_nutzung_gueltig (IP-2a).
    nutzung        TEXT[],
    -- Nur am Gebäude (§4.1 G; der Bereich hat keines).
    baujahr        INTEGER,
    notiz          TEXT,
    zustand        TEXT        NOT NULL,
    archiviert_am  TIMESTAMPTZ,
    archiviert_von TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     TEXT,
    CONSTRAINT ort_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Die Ziele der zusammengesetzten Fremdschlüssel: ein Intervall oder eine
    -- Fläche kann nur an einem Ort SEINES Mandanten hängen (ein FK prüft ohne
    -- RLS), und die Art-Regel unten braucht die Art im Schlüssel.
    CONSTRAINT uq_ort_id_tenant UNIQUE (id, tenant_id),
    CONSTRAINT uq_ort_id_tenant_art UNIQUE (id, tenant_id, art),
    CONSTRAINT ort_art_chk CHECK (art IN ('gebaeude', 'bereich')),
    CONSTRAINT ort_name_chk
        CHECK (char_length(name) BETWEEN 1 AND 120 AND btrim(name) <> ''),
    CONSTRAINT ort_kurzzeichen_chk
        CHECK (char_length(kurzzeichen) BETWEEN 1 AND 24
               AND kurzzeichen = btrim(kurzzeichen)),
    CONSTRAINT ort_nutzung_chk CHECK (uems_nutzung_gueltig(nutzung)),
    -- „vierstellig, 1800 … laufendes Jahr" (§4.1) — die zeitlose Hälfte (Kopf).
    CONSTRAINT ort_baujahr_chk
        CHECK (baujahr IS NULL OR baujahr BETWEEN 1800 AND 9999),
    CONSTRAINT ort_baujahr_nur_am_gebaeude
        CHECK (baujahr IS NULL OR art = 'gebaeude'),
    CONSTRAINT ort_notiz_chk
        CHECK (notiz IS NULL OR char_length(notiz) BETWEEN 1 AND 500),
    -- AP-00 E8 / AP-02 §4.2: wie am Standort, kein „angehalten" am Ort.
    CONSTRAINT ort_zustand_chk
        CHECK (zustand IN ('entwurf', 'eingerichtet', 'aktiv', 'archiviert')),
    -- „archiviert" und der Archiv-Zeitpunkt sind EINE Tatsache, nie zwei.
    CONSTRAINT ort_archiv_chk
        CHECK ((zustand = 'archiviert') = (archiviert_am IS NOT NULL)
               AND (archiviert_von IS NULL OR archiviert_am IS NOT NULL))
);

-- Kurzzeichen: für immer eindeutig je Kundenbereich (E8), über Gebäude UND
-- Bereiche, ohne Groß-/Kleinschreibung. tenant_id vorn: ein Index prüft ohne
-- RLS und darf keinem fremden Mandanten ein Kurzzeichen verraten.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ort_kurzzeichen
    ON ort (tenant_id, lower(kurzzeichen));

-- -----------------------------------------------------------------------------
-- ort_zuordnung — woran ein Gebäude oder Bereich an welchem Tag hängt (§4.3)
-- -----------------------------------------------------------------------------
-- Genau EIN Elternknoten je Zeile: ein Standort ODER ein Gebäude. Die App-Rolle
-- darf nur `gueltig_bis` und `aufgehoben_am` ändern (Rechte unten).
CREATE TABLE IF NOT EXISTS ort_zuordnung (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID        NOT NULL,
    ort_id             UUID        NOT NULL,
    eltern_standort_id UUID,
    eltern_ort_id      UUID,
    -- Die Art-Regel (Regel 1, AP-00 E4; Vektor-Datei `erlaubte_eltern`:
    -- gebaeude → standort, bereich → gebaeude | standort) in einem Satz: hängt
    -- ein Ort an einem ORT, dann ist der Elternknoten ein Gebäude UND das Kind
    -- ein Bereich. Die zwei berechneten Spalten sagen genau das; die zwei
    -- Fremdschlüssel unten halten sie gegen `ort.art`. Hängt ein Ort am
    -- Standort, sind beide NULL und nichts ist zu prüfen (MATCH SIMPLE). Der
    -- Schreiber gibt sie nie an.
    eltern_art         TEXT GENERATED ALWAYS AS
        (CASE WHEN eltern_ort_id IS NOT NULL THEN 'gebaeude' END) STORED,
    kind_art           TEXT GENERATED ALWAYS AS
        (CASE WHEN eltern_ort_id IS NOT NULL THEN 'bereich' END) STORED,
    gueltig_ab         DATE        NOT NULL,
    gueltig_bis        DATE,
    aufgehoben_am      TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by         TEXT,
    CONSTRAINT ort_zuordnung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT ort_zuordnung_ort_fk FOREIGN KEY (ort_id, tenant_id)
        REFERENCES ort (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT ort_zuordnung_eltern_standort_fk FOREIGN KEY (eltern_standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    -- „Bereich unter Bereich" und „Gebäude unter Bereich" (Vektor-Fall
    -- `bereich-nicht-in-einen-bereich`): der Elternknoten ist kein Gebäude.
    CONSTRAINT ort_zuordnung_eltern_ist_gebaeude_fk
        FOREIGN KEY (eltern_ort_id, tenant_id, eltern_art)
        REFERENCES ort (id, tenant_id, art) ON DELETE RESTRICT,
    -- „Gebäude unter Gebäude" (Vektor-Fall `gebaeude-nur-an-einen-standort`):
    -- unter einem Ort hängt nur ein Bereich.
    CONSTRAINT ort_zuordnung_unter_gebaeude_nur_bereich_fk
        FOREIGN KEY (ort_id, tenant_id, kind_art)
        REFERENCES ort (id, tenant_id, art) ON DELETE RESTRICT,
    -- Regel 1: je Zeile genau ein Elternknoten (num_nonnulls ist nie NULL).
    CONSTRAINT ort_zuordnung_genau_ein_eltern
        CHECK (num_nonnulls(eltern_standort_id, eltern_ort_id) = 1),
    -- Vektor-Fall `bis-vor-ab`; ab = bis ist erlaubt (`ein-tag-ist-ein-intervall`).
    CONSTRAINT ort_zuordnung_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    -- Regel 1/2: je Ort genau EIN Elternknoten je Tag. '[]', weil `bis` der
    -- letzte Tag IST (`bis-ist-der-letzte-tag-darum-ueberlappt-das`); ein
    -- aufgehobenes Intervall belegt keinen Tag mehr (`aufgehobene-zaehlen-nicht`);
    -- tenant_id im Schlüssel aus demselben Grund wie bei anlage_standort: der
    -- Constraint prüft VOR dem Fremdschlüssel und ohne RLS.
    CONSTRAINT ort_zuordnung_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        ort_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);

-- „Was hängt an diesem Standort / Gebäude?" (Ortsbaum zum Stichtag, IP-5) —
-- und die RESTRICT-Prüfung beim Löschen eines Elternknotens.
CREATE INDEX IF NOT EXISTS idx_ort_zuordnung_eltern_standort
    ON ort_zuordnung (eltern_standort_id, gueltig_ab) WHERE eltern_standort_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ort_zuordnung_eltern_ort
    ON ort_zuordnung (eltern_ort_id, gueltig_ab) WHERE eltern_ort_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- flaeche_gueltigkeit — die Bezugsfläche mit „gültig ab" (E3, Regel 12)
-- -----------------------------------------------------------------------------
-- Je Standort, Gebäude oder Bereich; AP-09 liest sie als Bezugsgröße BZ-4.
-- „Nicht erhoben" ist KEINE Zeile — nie eine Zeile mit 0 oder NULL (Hausregel,
-- Vertrag `flaechenIntervall.m2`: ganze Zahl ≥ 1). Dieselbe Mechanik wie die
-- Zuordnungen, samt `aufgehoben_am`: auch eine Fläche wird korrigiert, indem
-- das Intervall aufgehoben und ersetzt wird — nie, indem `m2` umgeschrieben wird.
-- Die Summe der Gebäude am Standort ist eine Ableitung des Lesewegs, keine Zeile.
CREATE TABLE IF NOT EXISTS flaeche_gueltigkeit (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL,
    standort_id   UUID,
    ort_id        UUID,
    m2            INTEGER     NOT NULL,
    gueltig_ab    DATE        NOT NULL,
    gueltig_bis   DATE,
    aufgehoben_am TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    TEXT,
    CONSTRAINT flaeche_gueltigkeit_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT flaeche_gueltigkeit_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT flaeche_gueltigkeit_ort_fk FOREIGN KEY (ort_id, tenant_id)
        REFERENCES ort (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT flaeche_gueltigkeit_genau_ein_objekt
        CHECK (num_nonnulls(standort_id, ort_id) = 1),
    CONSTRAINT flaeche_gueltigkeit_m2_chk CHECK (m2 > 0),
    CONSTRAINT flaeche_gueltigkeit_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_bis >= gueltig_ab),
    -- Je Objekt eine Fläche je Tag — ein Constraint je Objektart, damit eine
    -- NULL-Spalte nie mit einer anderen verglichen wird (NULL = NULL ist nie wahr).
    CONSTRAINT flaeche_standort_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        standort_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL AND standort_id IS NOT NULL),
    CONSTRAINT flaeche_ort_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        ort_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL AND ort_id IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (Hausregel; A14: fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE ort ENABLE ROW LEVEL SECURITY;
ALTER TABLE ort FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ort_tenant_isolation ON ort;
CREATE POLICY ort_tenant_isolation ON ort
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ort_zuordnung ENABLE ROW LEVEL SECURITY;
ALTER TABLE ort_zuordnung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ort_zuordnung_tenant_isolation ON ort_zuordnung;
CREATE POLICY ort_zuordnung_tenant_isolation ON ort_zuordnung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE flaeche_gueltigkeit ENABLE ROW LEVEL SECURITY;
ALTER TABLE flaeche_gueltigkeit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flaeche_gueltigkeit_tenant_isolation ON flaeche_gueltigkeit;
CREATE POLICY flaeche_gueltigkeit_tenant_isolation ON flaeche_gueltigkeit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird bewusst weggenommen, was es nicht geben
-- darf. Die BYPASSRLS-Rolle voltpilot_admin deckt V4s ALTER DEFAULT PRIVILEGES
-- ab (das Offboarding löscht über sie). Das REVOKE auf Tabellenebene nimmt auch
-- Spaltenrechte mit; das GRANT danach setzt genau die genannten wieder — ein
-- erneuter Lauf landet im selben Zustand.
--
-- Ein Ort wird archiviert, nie gelöscht; Art, Mandant und Herkunft bleiben.
GRANT SELECT, INSERT ON ort TO ${appDbUser};
REVOKE UPDATE, DELETE ON ort FROM ${appDbUser};
GRANT UPDATE (name, kurzzeichen, nutzung, baujahr, notiz, zustand, archiviert_am,
              archiviert_von) ON ort TO ${appDbUser};
-- Ein Intervall wird beendet oder aufgehoben — nie gelöscht, nie umgeschrieben.
GRANT SELECT, INSERT ON ort_zuordnung TO ${appDbUser};
REVOKE UPDATE, DELETE ON ort_zuordnung FROM ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON ort_zuordnung TO ${appDbUser};
-- Eine Fläche ebenso: eine andere Zahl ist ein neues Intervall (E3).
GRANT SELECT, INSERT ON flaeche_gueltigkeit TO ${appDbUser};
REVOKE UPDATE, DELETE ON flaeche_gueltigkeit FROM ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON flaeche_gueltigkeit TO ${appDbUser};
