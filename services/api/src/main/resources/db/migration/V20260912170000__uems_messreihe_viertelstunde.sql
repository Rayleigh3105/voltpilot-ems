-- =============================================================================
-- UEMS AP-07 IP-12 — die SPEICHERKLASSE VIERTELSTUNDENWERTE: die Tabelle für
-- zehn Jahre, die durable ARBEITSLISTE der betroffenen Intervalle und der
-- Laufzustand des Fünf-Minuten-Laufs.
--
-- Konzept vp-uems-ap07-messdaten §4.3/§4.4/§4.6, Captain-Entscheide 10.09.2026
-- (alle Option A):
--
--   E5  Ein Viertelstundenwert ist VORLÄUFIG bis 7 Tage nach Intervallende —
--       eine Nachlieferung rechnet ihn in dieser Zeit automatisch neu —, danach
--       ENDGÜLTIG. Diese Migration legt `endgueltig_ab` an und der Lauf füllt es
--       nach genau dieser Regel (CHECK unten); das UMSCHALTEN auf `endgueltig`,
--       die Spätankunft (`late_arrival`) und die Tageswerte sind IP-13.
--   E6  JEDE Reihe bekommt Viertelstundenwerte, zehn Jahre lang — eine Regel,
--       kein Sonderfall, keine Auswahl „welche Kanäle lohnen sich".
--   E7  RLS-Hypertable in DERSELBEN Datenbank, OHNE Kompression, Aufbewahrung
--       3 653 Tage, Chunk 30 Tage; das Kompressions-LAYOUT (segmentby Reihe,
--       orderby Zeit) ist VORBEREITET, damit ein späterer Umbau ohne Wanderung
--       der Daten möglich bleibt.
--
-- ADDITIV. Es entsteht eine neue Klasse neben den bestehenden: keine Zeile der
-- Rohtabelle, der Bestands-Rollups, der Kern-Telemetrie oder der Ereignisse
-- wird angefasst, kein Index verändert, kein Recht verschoben. Die Rohwerte
-- bleiben die Quelle und behalten ihre 90 Tage (V20260848000000).
--
-- WAS HIER NICHT GERECHNET WIRD. Die fachlichen Rechenregeln (Menge aus
-- Zählerständen, Rücksprung, Ersatzwerte, Zeitumstellung) sind AP-08 und liegen
-- seit PR 693 als Vertrag samt Zwillingen vor. Der Lauf RUFT `VerbrauchRegeln`
-- AUF; deshalb steht in dieser Tabelle auch KEINE `menge`: gespeichert werden
-- genau die Felder aus §4.4 — Stand am Anfang und am Ende, Summe, Mittel/Min/Max,
-- erster und letzter Wert. Die Differenz über die Intervallgrenze bildet AP-08
-- (A5: „die Strecke rechnet keine Differenz").
--
-- ⚠ GROSS-MIGRATION (so eingeplant, AP-07 §8) — aber NICHT in dieser Datei: sie
-- legt nur an. Die einmalige RÜCKRECHNUNG der letzten 90 Tage fährt der
-- Fünf-Minuten-Lauf in Scheiben, angehalten und wiederaufnehmbar
-- (`ViertelstundeLaeufer`), damit ein Deploy nie auf einer Migration steht.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Das UTC-Viertelstunden-Raster als eine Regel
-- -----------------------------------------------------------------------------
-- IMMUTABLE, und das ist keine Behauptung: `AT TIME ZONE 'UTC'` (timezone(text,
-- timestamptz)), `date_trunc` auf einem timestamp und `timestamp + interval`
-- sind es alle. Der Umweg über den timestamp ist nötig, weil `timestamptz +
-- interval` STABLE ist (es hinge an der Zeitzone der Sitzung) und in einem CHECK
-- gar nicht erst zugelassen würde — dieselbe Vorsicht wie in V20260912160000.
CREATE OR REPLACE FUNCTION uems_viertelstunde_raster(t TIMESTAMPTZ)
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT (t AT TIME ZONE 'UTC') IN (
        date_trunc('hour', t AT TIME ZONE 'UTC'),
        date_trunc('hour', t AT TIME ZONE 'UTC') + INTERVAL '15 minutes',
        date_trunc('hour', t AT TIME ZONE 'UTC') + INTERVAL '30 minutes',
        date_trunc('hour', t AT TIME ZONE 'UTC') + INTERVAL '45 minutes');
$$;

COMMENT ON FUNCTION uems_viertelstunde_raster(TIMESTAMPTZ) IS
    'AP-07 IP-12: liegt der Zeitpunkt auf dem UTC-Viertelstunden-Raster? (§4.5: identisch mit '
    'der Ortszeit-Viertelstunde, weil der Versatz volle Stunden betraegt.)';

-- -----------------------------------------------------------------------------
-- 1. Die Ereignis-Zählung je Art — das geschlossene Vokabular der §4.4-Zeile
--    „Ereignis-Verweis" (Lücke · Rücksetzung · Gerätegrenze · Übergabe ·
--    Doppel-Zustellung). Ein fremdes Wort wird abgewiesen, nie aufgelöst.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messreihe_viertelstunde_ereignisse_erlaubt(zaehler JSONB)
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof(zaehler) = 'object'
       AND NOT EXISTS (
            SELECT 1 FROM jsonb_each(zaehler) AS e(art, anzahl)
             WHERE art NOT IN ('data_gap', 'counter_reset', 'device_boundary',
                               'handover', 'duplicate_conflict')
                OR jsonb_typeof(anzahl) <> 'number'
                OR (anzahl)::text !~ '^[0-9]+$'
                OR (anzahl)::text::bigint <= 0);
$$;

COMMENT ON FUNCTION messreihe_viertelstunde_ereignisse_erlaubt(JSONB) IS
    'AP-07 IP-12: nur die fuenf Arten der Zeile "Ereignis-Verweis" (§4.4), nur ganze Zahlen > 0. '
    'Eine Art ohne Ereignis steht gar nicht erst da - 0 waere eine Behauptung statt einer Zaehlung.';

-- -----------------------------------------------------------------------------
-- 2. Die Tabelle (§4.4 Feld für Feld)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messreihe_viertelstunde (
    -- ---- Reihe + Intervall (Schlüssel) ------------------------------------
    -- Beginn des Intervalls im UTC-Raster (§4.5 „Messzeit, Eingangszeit,
    -- Zeitzone" Nr. 1: identisch mit der Ortszeit-Viertelstunde, weil der
    -- Versatz volle Stunden beträgt). Das Intervall ist [beginn, beginn+15min).
    intervall_beginn    TIMESTAMPTZ NOT NULL,
    tenant_id           UUID        NOT NULL,
    -- Die REIHE ist Mandant + Komponente + Messkanal (E2, V20260912140000) —
    -- Gerät, Box und Fassung sind Herkunft, nie Schlüssel.
    entity_id           UUID        NOT NULL,
    messkanal           TEXT        NOT NULL,
    -- Die Anlage der Rohwerte, wenn ALLE dieselbe nennen; sonst NULL (nie geraten).
    site_id             UUID,

    -- ---- Wertart -----------------------------------------------------------
    -- Die Wertart, mit der das Intervall gebildet wurde — das Vokabular des
    -- Herkunftsvertrags (E12), dasselbe wie device_measurement_sample.value_kind.
    -- NULL = für diese Rohwerte war keine nachgeschlagen (Bestand vor IP-7);
    -- dann entsteht kein Zahlenwert, nur Abdeckung, Qualität und Anker.
    wertart             TEXT,

    -- ---- Werte (§4.4 „Werte") ---------------------------------------------
    -- Zählerstand: der Stand an den Periodengrenzen nach Z1 (letzter guter Wert
    -- in (t − Kadenz, t]) — samt seiner Messzeit, damit AP-08 sieht, WORAUS es
    -- rechnet. Kein Fortschreiben aus einem älteren Wert.
    stand_anfang        NUMERIC,
    stand_anfang_zeit   TIMESTAMPTZ,
    stand_ende          NUMERIC,
    stand_ende_zeit     TIMESTAMPTZ,
    -- Intervallmenge: die Summe der guten Intervallmengen (I1).
    summe               NUMERIC,
    -- Momentanwert: Mittel, Minimum, Maximum der guten Werte (M1).
    mittel              NUMERIC,
    min_wert            NUMERIC,
    max_wert            NUMERIC,
    -- Immer: erster und letzter guter Wert des Intervalls (Zahl ODER Text).
    erster_wert         NUMERIC,
    erster_text         TEXT,
    erster_zeit         TIMESTAMPTZ,
    letzter_wert        NUMERIC,
    letzter_text        TEXT,
    letzter_zeit        TIMESTAMPTZ,

    -- ---- Abdeckung (§4.4 „Abdeckung", §4.6 Nr. 2) --------------------------
    -- Gute Werte im Fenster der Wertart-Regel (VerbrauchRegeln.Ergebnis.erhalten).
    erhalten            INTEGER     NOT NULL,
    -- Periodenlänge ÷ Kadenz — die Erwartung ZUM INTERVALL, nie „jetzt" (IP-10).
    erwartet            INTEGER     NOT NULL,
    -- erhalten ÷ erwartet, ABGESCHNITTEN (VerbrauchRegeln) — nie auf 100 %
    -- gerundet (§4.9 Nr. 6); der CHECK unten hält das an der Datenbankgrenze.
    abdeckung_prozent   INTEGER,
    -- Die Kadenz, aus der `erwartet` folgt, und das Glied der Vorgabe-Kette,
    -- das sie geliefert hat (KadenzRegeln.Herkunft) — damit `erwartet` erklärbar
    -- ist und nicht nur behauptet.
    kadenz_s            INTEGER     NOT NULL,
    kadenz_herkunft     TEXT        NOT NULL,

    -- ---- Qualitätszähler (§4.4) -------------------------------------------
    -- Was nicht `good` ist, wird GEZÄHLT, nicht gerechnet (§4.9 Nr. 6).
    n_good              INTEGER     NOT NULL DEFAULT 0,
    n_uncertain         INTEGER     NOT NULL DEFAULT 0,
    n_invalid           INTEGER     NOT NULL DEFAULT 0,
    n_stale             INTEGER     NOT NULL DEFAULT 0,
    n_device_error      INTEGER     NOT NULL DEFAULT 0,

    -- ---- Herkunfts-Anker (§4.4) -------------------------------------------
    -- Der Einbau (geraet.id) der guten Werte; bei einem Gerätewechsel IM
    -- Intervall (A5) trägt `_2` den zweiten. `_weitere` zählt, was darüber
    -- hinaus vorkam: zwei Anker zu nennen und einen dritten zu verschweigen
    -- wäre eine Lüge durch Auslassen.
    geraet_einbau       UUID,
    geraet_einbau_2     UUID,
    geraet_einbau_weitere INTEGER   NOT NULL DEFAULT 0,
    -- Die lesende Box; bei einer Übergabe IM Intervall (A6) trägt `_2` die zweite.
    box                 UUID,
    box_2               UUID,
    box_weitere         INTEGER     NOT NULL DEFAULT 0,
    -- Die Einstellungs-Fassung, die die Box beim Erfassen ANGEWENDET hat
    -- (applied_revision des letzten guten Werts). ⚠ Der Faktor der Fassung wird
    -- hier NIE angewendet: gespeichert ist der Wert, wie die Box ihn geliefert
    -- hat, und die Fassung ist der Anker, mit dem AP-08/IP-14 ihn einordnen.
    fassung             BIGINT,
    -- Die Katalogfassung des letzten guten Werts.
    katalog             TEXT,
    -- Die Rolle zur Messzeit (E4). `spiegel` kommt hier nie vor: ein Spiegel
    -- liegt außerhalb der zuständigen Reihe und fließt nie in Verbrauch oder
    -- Bilanz (§4.7 Nr. 4), also bildet er auch kein Intervall.
    rolle               TEXT,

    -- ---- Zustand (§4.4, E5) ------------------------------------------------
    zustand             TEXT        NOT NULL DEFAULT 'vorlaeufig',
    -- Ende des Intervalls + 7 Tage. Der Lauf FÜLLT das Feld; das UMSCHALTEN auf
    -- `endgueltig` ist IP-13 (Stundenlauf) — hier steht die Frist, nicht ihr
    -- Vollzug.
    endgueltig_ab       TIMESTAMPTZ NOT NULL,
    berechnet_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Korrekturen (AP-08) erhöhen die Version; das Original bleibt. Der
    -- Verdichtungs-Lauf schreibt IMMER Version 1 — er korrigiert nie.
    version             INTEGER     NOT NULL DEFAULT 1,

    -- ---- Nachlieferung (§4.4, §4.5) ---------------------------------------
    n_nachgeliefert     INTEGER     NOT NULL DEFAULT 0,
    letzte_eingangszeit TIMESTAMPTZ,
    zustellart          TEXT,

    -- ---- Ereignis-Verweis (§4.4) ------------------------------------------
    ereignisse          JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- ---- Regeln ------------------------------------------------------------
    CONSTRAINT messreihe_viertelstunde_raster_chk
        CHECK (uems_viertelstunde_raster(intervall_beginn)),
    CONSTRAINT messreihe_viertelstunde_messkanal_chk
        CHECK (btrim(messkanal) <> '' AND length(messkanal) <= 240),
    CONSTRAINT messreihe_viertelstunde_wertart_chk
        CHECK (wertart IS NULL OR wertart IN ('counter', 'gauge', 'state', 'bitfield', 'text')),
    CONSTRAINT messreihe_viertelstunde_rolle_chk
        CHECK (rolle IS NULL OR rolle IN ('fuehrend', 'vergleich', 'beobachtung')),
    CONSTRAINT messreihe_viertelstunde_zustand_chk
        CHECK (zustand IN ('vorlaeufig', 'endgueltig')),
    -- E5, wörtlich: 7 Tage nach INTERVALLENDE — also 15 Minuten + 7 Tage nach
    -- dem Beginn, zusammen 10 095 Minuten. In der timestamp-Ebene gerechnet, weil
    -- `timestamptz + interval` STABLE ist und in einem CHECK nicht zugelassen wird.
    CONSTRAINT messreihe_viertelstunde_endgueltig_ab_chk
        CHECK ((endgueltig_ab AT TIME ZONE 'UTC')
               = (intervall_beginn AT TIME ZONE 'UTC') + INTERVAL '10095 minutes'),
    CONSTRAINT messreihe_viertelstunde_version_chk CHECK (version >= 1),
    CONSTRAINT messreihe_viertelstunde_kadenz_chk
        CHECK (kadenz_s BETWEEN 1 AND 86400
               AND kadenz_herkunft IN ('fassung', 'auswahl', 'katalog', 'vorgabe')),
    CONSTRAINT messreihe_viertelstunde_zaehler_chk
        CHECK (erhalten >= 0 AND erwartet >= 0 AND n_good >= 0 AND n_uncertain >= 0
               AND n_invalid >= 0 AND n_stale >= 0 AND n_device_error >= 0
               AND n_nachgeliefert >= 0 AND geraet_einbau_weitere >= 0 AND box_weitere >= 0),
    -- ⚠ Die Abdeckung wird NIE auf 100 % gerundet (§4.9 Nr. 6): 100 steht nur,
    -- wenn wirklich mindestens so viele Werte da sind, wie erwartet wurden.
    CONSTRAINT messreihe_viertelstunde_abdeckung_chk
        CHECK (abdeckung_prozent IS NULL
               OR (abdeckung_prozent BETWEEN 0 AND 100
                   AND (abdeckung_prozent < 100 OR erhalten >= erwartet))),
    -- Ein zweiter Anker steht nie ohne den ersten, und nie zweimal derselbe.
    CONSTRAINT messreihe_viertelstunde_anker_chk
        CHECK ((geraet_einbau_2 IS NULL OR (geraet_einbau IS NOT NULL AND geraet_einbau_2 <> geraet_einbau))
               AND (box_2 IS NULL OR (box IS NOT NULL AND box_2 <> box))
               AND (geraet_einbau_weitere = 0 OR geraet_einbau_2 IS NOT NULL)
               AND (box_weitere = 0 OR box_2 IS NOT NULL)),
    CONSTRAINT messreihe_viertelstunde_zustellart_chk
        CHECK ((zustellart IS NULL OR zustellart IN ('direkt', 'nachgeliefert', 'gemischt'))
               AND (n_nachgeliefert = 0 OR zustellart IN ('nachgeliefert', 'gemischt'))),
    CONSTRAINT messreihe_viertelstunde_ereignisse_chk
        CHECK (messreihe_viertelstunde_ereignisse_erlaubt(ereignisse))
);

-- Chunk 30 Tage (E7). Ohne die Vorgabe-Indizes: sie stünden ohne `tenant_id`
-- vorn — dasselbe Muster wie messreihe_ereignis (V20260911260000).
SELECT create_hypertable('messreihe_viertelstunde', 'intervall_beginn', if_not_exists => TRUE,
                         chunk_time_interval => INTERVAL '30 days',
                         create_default_indexes => FALSE);

-- Der EINE Index: er ist der Schlüssel der Reihe UND der Leseweg „diese Reihe
-- über die Zeit". `tenant_id` vorn (die Hausregel der UEMS-Migrationen), die
-- Zeit gehört in jeden eindeutigen Index einer Hypertable. Aufsteigend — ein
-- Btree wird rückwärts genauso gelesen, und ohne `DESC` ist er die Zielmenge,
-- auf die `ON CONFLICT (tenant_id, entity_id, messkanal, intervall_beginn)`
-- ohne Zweifel schließt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_messreihe_viertelstunde_reihe
    ON messreihe_viertelstunde (tenant_id, entity_id, messkanal, intervall_beginn);

-- Zehn Jahre (E7, Plan §1). KEINE Kompression: die Tabelle ist RLS + FORCE.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                    WHERE proc_name = 'policy_retention'
                      AND hypertable_name = 'messreihe_viertelstunde') THEN
        PERFORM add_retention_policy('messreihe_viertelstunde', INTERVAL '3653 days');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Das VORBEREITETE Kompressions-Layout (E7)
-- -----------------------------------------------------------------------------
-- TimescaleDB 2.17 lässt Kompression auf einer Tabelle mit FORCE ROW LEVEL
-- SECURITY nicht zu (dieselbe Schranke, an der schon die Continuous Aggregates
-- scheitern, V20260848000000). „Vorbereitet" heißt deshalb nicht „eingeschaltet",
-- sondern: das Layout steht FEST und ist ABRUFBAR, und die physische Ordnung der
-- Tabelle ist schon die, die es verlangt — der Unique-Index führt mit der Reihe
-- und ordnet absteigend nach der Zeit. Ein späterer Umbau (E7-B, IP-16 misst
-- vorher die Rate auf einer Nicht-RLS-Kopie) ist damit ein ALTER TABLE mit genau
-- diesen zwei Zeichenketten — ohne Wanderung der Daten.
CREATE OR REPLACE FUNCTION messreihe_viertelstunde_kompression_layout(
    OUT segmentby TEXT, OUT orderby TEXT) LANGUAGE sql IMMUTABLE AS $$
    SELECT 'tenant_id, entity_id, messkanal'::text, 'intervall_beginn DESC'::text;
$$;

COMMENT ON FUNCTION messreihe_viertelstunde_kompression_layout() IS
    'AP-07 E7: das VORBEREITETE Kompressions-Layout (segmentby Reihe, orderby Zeit). Nicht '
    'eingeschaltet - Kompression ist auf einer FORCE-RLS-Hypertable gesperrt. Wer sie spaeter '
    'einschaltet, nimmt GENAU diese zwei Zeichenketten; die Tabelle ist schon so geordnet.';

-- -----------------------------------------------------------------------------
-- 4. Die ARBEITSLISTE der betroffenen Intervalle — durable
-- -----------------------------------------------------------------------------
-- Sie überlebt einen Neustart (eine Tabelle, keine Warteschlange im Speicher),
-- sie wächst nicht unbegrenzt (der Schlüssel IST der Eintrag: dasselbe Intervall
-- steht höchstens einmal darin), und sie verliert keinen Eintrag: der Lauf
-- ENTNIMMT einen Stapel und schreibt die Intervalle in DERSELBEN Transaktion —
-- bricht er ab, ist die Entnahme mit zurückgerollt und der Eintrag steht wieder
-- da. Zwei gleichzeitige Läufe stören einander nicht: die Entnahme greift unter
-- `FOR UPDATE SKIP LOCKED`, jeder bekommt einen anderen Stapel.
CREATE TABLE IF NOT EXISTS messreihe_viertelstunde_arbeit (
    tenant_id        UUID        NOT NULL,
    entity_id        UUID        NOT NULL,
    messkanal        TEXT        NOT NULL,
    intervall_beginn TIMESTAMPTZ NOT NULL,
    -- Woher der Eintrag kommt: `eingang` = ein Rohwert dieses Intervalls ist
    -- eingetroffen (auch nachgeliefert); `rueckrechnung` = die einmalige
    -- Rückrechnung der letzten 90 Tage.
    grund            TEXT        NOT NULL,
    eingetragen_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_viertelstunde_arbeit_pk
        PRIMARY KEY (tenant_id, entity_id, messkanal, intervall_beginn),
    CONSTRAINT messreihe_viertelstunde_arbeit_grund_chk
        CHECK (grund IN ('eingang', 'rueckrechnung')),
    CONSTRAINT messreihe_viertelstunde_arbeit_raster_chk
        CHECK (uems_viertelstunde_raster(intervall_beginn))
);

-- Die Entnahme-Reihenfolge: das ÄLTESTE Intervall zuerst, damit eine
-- Nachlieferung nicht hinter der laufenden Verdichtung verhungert.
CREATE INDEX IF NOT EXISTS idx_messreihe_viertelstunde_arbeit_reihenfolge
    ON messreihe_viertelstunde_arbeit (intervall_beginn, eingetragen_am);

-- ⚠ GROSS-MIGRATION, der eine Schritt, der den BESTAND anfasst: der Lauf sucht
-- betroffene Intervalle über die EINGANGSZEIT der Rohwerte (§4.5 Nachlieferung
-- Nr. 3 — so findet er eine Nachlieferung von selbst, ohne festes Fenster).
-- `device_measurement_sample` hatte dafür keinen Index: die bestehenden stehen
-- auf (device_id, point_key, time). Ohne diesen hier läse der Lauf alle fünf
-- Minuten jeden Chunk der 90 Tage voll. Der Index ist TEILWEISE — genau die
-- Zeilen, die der Lauf ansieht (eine Zeile ohne Komponente hat keine Reihe, ein
-- Spiegel liegt außerhalb, §4.7 Nr. 4) — und damit so schmal wie möglich.
-- Additiv: kein bestehender Index wird angetastet, keine Zeile geändert. Preis
-- ist ein zusätzlicher Index-Eintrag je geschriebenem Rohwert.
CREATE INDEX IF NOT EXISTS idx_device_measurement_sample_eingang
    ON device_measurement_sample (received_at)
    WHERE entity_id IS NOT NULL AND role IS DISTINCT FROM 'spiegel';

COMMENT ON INDEX idx_device_measurement_sample_eingang IS
    'AP-07 IP-12: der Eingangs-Leseweg des Verdichtungs-Laufs (welche Intervalle sind seit dem '
    'letzten Lauf betroffen?). Teilweise auf die Zeilen mit Reihe ausserhalb des Spiegels.';

-- -----------------------------------------------------------------------------
-- 5. Der Laufzustand: der Eingangs-Zeiger und der Stand der Rückrechnung
-- -----------------------------------------------------------------------------
-- Nicht mandantengebunden (ein Betriebszustand, kein Kundendatum) — darum ohne
-- RLS, und die App-Rolle bekommt gar nichts.
CREATE TABLE IF NOT EXISTS messreihe_viertelstunde_lauf (
    schluessel   TEXT        PRIMARY KEY,
    zeitpunkt    TIMESTAMPTZ,
    zahl         BIGINT      NOT NULL DEFAULT 0,
    notiz        TEXT,
    geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_viertelstunde_lauf_schluessel_chk
        CHECK (schluessel IN ('zeiger', 'rueckrechnung'))
);

-- `zeiger`: bis zu welcher EINGANGSZEIT die Rohwerte schon in die Arbeitsliste
-- eingetragen sind. Der Lauf sucht betroffene Intervalle über den EINGANG, nicht
-- über ein festes Fenster (§4.5 Nachlieferung Nr. 3) — deshalb findet er eine
-- Nachlieferung von selbst. NULL = noch nie gelaufen; der erste Lauf setzt ihn
-- auf „jetzt" und überlässt die Vergangenheit der Rückrechnung.
-- `rueckrechnung`: bis zu welcher MESSZEIT rückwärts die einmalige Rückrechnung
-- der letzten 90 Tage schon eingetragen hat; `notiz = 'fertig'`, wenn sie durch
-- ist. Eine Unterbrechung kostet höchstens die angefangene Scheibe.
INSERT INTO messreihe_viertelstunde_lauf (schluessel, zeitpunkt, zahl, notiz)
VALUES ('zeiger', NULL, 0, NULL), ('rueckrechnung', NULL, 0, NULL)
ON CONFLICT (schluessel) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 6. Der Mandantenzaun (Hausregel: fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_viertelstunde ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_viertelstunde FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_viertelstunde_tenant_isolation ON messreihe_viertelstunde;
CREATE POLICY messreihe_viertelstunde_tenant_isolation ON messreihe_viertelstunde
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messreihe_viertelstunde_arbeit ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_viertelstunde_arbeit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_viertelstunde_arbeit_tenant_isolation ON messreihe_viertelstunde_arbeit;
CREATE POLICY messreihe_viertelstunde_arbeit_tenant_isolation ON messreihe_viertelstunde_arbeit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- 7. Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird weggenommen, was es nicht geben darf.
--
-- Der Verdichtungs-Lauf ist ein Hintergrund-Lauf ohne Mandanten-Kontext; er
-- schreibt über die BYPASSRLS-Rolle, genau wie der Bestands-Rollup-Job
-- (V20260848000000) und der Erneuerungs-Takt der Handeingriffe. Die App-Rolle
-- LIEST nur — hinter ihrem Zaun. Kein BIGSERIAL, darum kein Sequenz-Grant.
REVOKE ALL ON messreihe_viertelstunde FROM ${appDbUser};
GRANT SELECT ON messreihe_viertelstunde TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_viertelstunde TO ${adminDbUser};

-- Die Arbeitsliste und der Laufzustand gehören dem Lauf allein.
REVOKE ALL ON messreihe_viertelstunde_arbeit FROM ${appDbUser};
REVOKE ALL ON messreihe_viertelstunde_lauf FROM ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_viertelstunde_arbeit TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_viertelstunde_lauf TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- 8. Was die Tabellen bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON TABLE messreihe_viertelstunde IS
    'Speicherklasse Viertelstundenwerte (UEMS AP-07 IP-12, E6/E7): JEDE Reihe, zehn Jahre '
    '(Retention 3 653 Tage), Chunk 30 Tage, RLS + FORCE, OHNE Kompression - das Layout ist '
    'vorbereitet (messreihe_viertelstunde_kompression_layout). Gebildet aus der MENGE der '
    'Rohwerte eines Intervalls, nie inkrementell fortgeschrieben (§4.5 Reihenfolge Nr. 3). '
    'Keine menge-Spalte: die Differenz ueber Intervallgrenzen bildet AP-08.';
COMMENT ON COLUMN messreihe_viertelstunde.zustand IS
    'vorlaeufig bis 7 Tage nach Intervallende (endgueltig_ab), danach endgueltig (E5). Der '
    'Verdichtungs-Lauf schreibt NUR vorlaeufig und ruehrt eine endgueltige Zeile nie an; das '
    'Umschalten und die Spaetankunft (late_arrival) gehoeren AP-07 IP-13.';
COMMENT ON COLUMN messreihe_viertelstunde.fassung IS
    'applied_revision des letzten guten Werts - ein ANKER. Der Faktor der Einstellungs-Fassung '
    'wird hier nie angewendet: gespeichert ist der Wert, wie die Box ihn geliefert hat.';
COMMENT ON COLUMN messreihe_viertelstunde.abdeckung_prozent IS
    'erhalten / erwartet, abgeschnitten (VerbrauchRegeln) - nie auf 100 % gerundet. Abdeckung '
    'ist NICHT Vollstaendigkeit: ein vollstaendiger Zeitraum darf 85 % haben.';
COMMENT ON COLUMN messreihe_viertelstunde.ereignisse IS
    'Anzahl der Ereignisse im Intervall je Art (Luecke, Ruecksetzung, Geraetegrenze, Uebergabe, '
    'Doppel-Zustellung); eine Art ohne Ereignis fehlt, 0 steht nie da.';
COMMENT ON TABLE messreihe_viertelstunde_arbeit IS
    'Durable Arbeitsliste der betroffenen Intervalle (AP-07 IP-12): gefuellt aus dem '
    'ROHWERT-EINGANG und aus der Rueckrechnung, geleert vom Fuenf-Minuten-Lauf in derselben '
    'Transaktion, in der er die Intervalle schreibt. Der Schluessel IST der Eintrag - dasselbe '
    'Intervall steht hoechstens einmal darin.';
COMMENT ON TABLE messreihe_viertelstunde_lauf IS
    'Laufzustand des Verdichtungs-Laufs: zeiger = bis zu welcher Eingangszeit die Rohwerte '
    'eingetragen sind; rueckrechnung = bis zu welcher Messzeit rueckwaerts die einmalige '
    'Rueckrechnung der letzten 90 Tage gekommen ist (notiz = fertig, wenn durch).';
