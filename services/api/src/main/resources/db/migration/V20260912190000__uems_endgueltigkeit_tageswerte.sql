-- =============================================================================
-- UEMS AP-07 IP-13 — ENDGÜLTIGKEIT und TAGESWERTE: wann eine Viertelstunde
-- feststeht, was mit einem zu späten Rohwert geschieht, und die Tagesklasse in
-- der Zeitzone des Standorts.
--
-- Konzept vp-uems-ap07-messdaten §4.3/§4.4/§4.5/§4.6/§8 IP-13, Captain-Entscheide
-- 10.09.2026 (alle Option A):
--
--   E5  Rohwerte werden bis 90 Tage zurück angenommen; der Viertelstundenwert
--       ist VORLÄUFIG bis 7 Tage nach Intervallende — eine Nachlieferung rechnet
--       ihn in dieser Zeit automatisch neu — und danach ENDGÜLTIG. Ein späterer
--       Rohwert wird gespeichert, erzeugt `late_arrival` und einen
--       Korrektur-Vorschlag (AP-08), ändert den endgültigen Wert aber NIE STILL.
--   E7  RLS-Hypertable in DERSELBEN Datenbank, Aufbewahrung 3 653 Tage; das
--       Kompressions-LAYOUT ist VORBEREITET, aber nicht eingeschaltet.
--   W10 Messzeiten in UTC in allen Klassen, das Viertelstunden-Raster in UTC —
--       ABER die TAGESWERTE in der Zeitzone des Standorts, und diese Zeitzone
--       wird IM TAGESWERT GESPEICHERT, damit ein Bericht in zehn Jahren
--       dieselbe Tagesgrenze reproduziert (§4.5 Nr. 1, A8).
--
-- IP-12 (V20260912170000) hat die FRIST angelegt (`endgueltig_ab` = Intervallende
-- + 7 Tage, per CHECK gehalten) und ausdrücklich offen gelassen, WER sie
-- vollzieht. Diese Migration liefert den Unterbau dafür — den Vollzug selbst
-- fahren `uems/EndgueltigkeitLauf` (Stundenlauf) und `uems/TagVerdichter`.
--
-- ADDITIV. Es wird keine Zeile einer bestehenden Tabelle geändert, kein Index
-- entfernt, kein Recht verschoben. Was hinzukommt:
--   1. zwei Lesewege (Indizes) auf `messreihe_viertelstunde`,
--   2. die KORREKTUR-LISTE `messreihe_korrektur_vorschlag` (Schnittstelle zu
--      AP-08 — die Liste, nie die Korrektur),
--   3. die TAGESKLASSE `messreihe_tag` (Hypertable, 3 653 Tage) + Laufzustand,
--   4. EIN Wort mehr im Vokabular: `late_arrival` darf auch von `cloud` kommen.
--
-- ⚠ WAS HIER NICHT ENTSTEHT. Keine versionierte Korrektur und keine Kaskade
-- (AP-08 IP-12 ff.) — nur die Liste. KEINE Tages- und Monatsmengen aus
-- Periodenständen (AP-08 IP-5): die Tagesklasse trägt FAKTEN (Stände, Abdeckung,
-- Qualitätszähler, Anker, Zustand) und darum ausdrücklich KEINE `menge`- und
-- KEINE `summe`-Spalte. Kein Lesepfad, kein Export (IP-14), keine Lücken-Meldung
-- als Job (IP-9), keine Löschwege (IP-11), keine Route und keine Portal-Fläche.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Die zwei Lesewege der neuen Läufe auf `messreihe_viertelstunde`
-- -----------------------------------------------------------------------------
-- Der STUNDENLAUF fragt „welche Zeile ist fällig?". Das Prädikat steht auf
-- `intervall_beginn` (der Partitionierungs-Spalte — damit greift der
-- Chunk-Ausschluss) und nicht auf `endgueltig_ab`: die beiden sind durch den
-- CHECK aus V20260912170000 zeichengleich aneinander gebunden (Ende + 7 Tage),
-- also ist dasselbe gefragt und die Hypertable kann es billiger beantworten.
-- TEILWEISE auf `zustand = 'vorlaeufig'`: der Index schrumpft mit jeder Zeile,
-- die endgültig wird — er ist genau so groß wie die offene Arbeit.
CREATE INDEX IF NOT EXISTS idx_messreihe_viertelstunde_vorlaeufig
    ON messreihe_viertelstunde (intervall_beginn)
    WHERE zustand = 'vorlaeufig';

COMMENT ON INDEX idx_messreihe_viertelstunde_vorlaeufig IS
    'AP-07 IP-13: der Leseweg des Stundenlaufs (welche vorlaeufige Zeile ist faellig?). Teilweise '
    '- er schrumpft mit jeder Zeile, die endgueltig wird.';

-- Der TAGESLAUF fragt „welche Viertelstunde ist seit meinem Zeiger neu gebildet
-- worden?". `berechnet_am` ist die Antwort; sie wird nur geschrieben, wenn sich
-- die Zeile wirklich geändert hat (IP-12 spart sie im Vergleich des `ON CONFLICT`
-- aus), also churnt der Index nicht für unveränderte Zeilen.
CREATE INDEX IF NOT EXISTS idx_messreihe_viertelstunde_berechnet
    ON messreihe_viertelstunde (berechnet_am);

COMMENT ON INDEX idx_messreihe_viertelstunde_berechnet IS
    'AP-07 IP-13: der Leseweg des Tageslaufs (welche Viertelstunde ist seit dem Zeiger neu '
    'gebildet?). Der Lauf grenzt zusaetzlich auf intervall_beginn ein, damit der Chunk-Ausschluss '
    'greift - der Verdichtungs-Lauf baut nur aus Rohwerten, und die sind 90 Tage alt.';

-- -----------------------------------------------------------------------------
-- 2. Die KORREKTUR-LISTE — die Schnittstelle zu AP-08, additiv
-- -----------------------------------------------------------------------------
-- E5 in einem Satz: SPEICHERN, MELDEN, VORSCHLAGEN — aber NICHT ANWENDEN. Der
-- Rohwert ist längst gespeichert (`device_measurement_sample`, er wird nie
-- geändert); gemeldet wird `late_arrival`; und HIER steht der Vorschlag, aus dem
-- AP-08 später eine VERSIONIERTE Korrektur macht. Diese Datei baut die Liste,
-- nicht die Korrektur: es gibt keinen Weg, der von hier aus eine Zeile der
-- Viertelstunden- oder Tagesklasse verändert.
--
-- EINE Zeile je Reihe und Intervall: ein zweiter Nachzügler erhöht die Zählung
-- derselben Zeile, er legt keine zweite an. Alle Zahlen sind aus den Rohwerten
-- ABGELEITET (Anzahl, früheste/späteste Messzeit, erste/letzte Eingangszeit) —
-- ein wiederholter Lauf schreibt deshalb denselben Inhalt.
CREATE TABLE IF NOT EXISTS messreihe_korrektur_vorschlag (
    -- Die Reihe (E2) und das Intervall — derselbe Schlüssel wie die Viertelstunde.
    tenant_id           UUID        NOT NULL,
    entity_id           UUID        NOT NULL,
    messkanal           TEXT        NOT NULL,
    intervall_beginn    TIMESTAMPTZ NOT NULL,
    -- Die Anlage der späten Rohwerte, wenn ALLE dieselbe nennen; sonst NULL.
    site_id             UUID,
    -- Warum ein Vorschlag entstand. Heute gibt es genau EINEN Grund; ein fremdes
    -- Wort wird VERWORFEN, nie aufgelöst.
    grund               TEXT        NOT NULL,
    -- Die Frist, die überschritten wurde (Intervallende + 7 Tage, E5) — sie steht
    -- mit im Vorschlag, damit er ohne Rückfrage erklärbar ist.
    endgueltig_ab       TIMESTAMPTZ NOT NULL,
    -- Was zu spät kam: wie viele Rohwerte, ihre Messzeiten und ihre Eingangszeiten.
    anzahl              INTEGER     NOT NULL,
    frueheste_messzeit  TIMESTAMPTZ NOT NULL,
    spaeteste_messzeit  TIMESTAMPTZ NOT NULL,
    erste_eingangszeit  TIMESTAMPTZ NOT NULL,
    letzte_eingangszeit TIMESTAMPTZ NOT NULL,
    -- Die Meldung, die dazugehört (`late_arrival`) — der Weg vom Vorschlag zum
    -- Ereignis und zurück.
    ereignis_id         UUID        NOT NULL,
    -- Die Fassung des Viertelstundenwerts, auf die sich der Vorschlag bezieht.
    -- NULL = für dieses Intervall steht (noch) gar keine Zeile: eine Lücke
    -- bekommt keine Zeile (IP-12), und ein Nachzügler nach der Frist legt auch
    -- keine an.
    version_bezug       INTEGER,
    vorgeschlagen_am    TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Die HÄLFTE VON AP-08: es schließt einen Vorschlag, indem es ihn erledigt
    -- oder verwirft. AP-07 schreibt hier nur `offen` — und rührt eine Zeile, die
    -- nicht mehr offen ist, nie wieder an.
    zustand             TEXT        NOT NULL DEFAULT 'offen',
    erledigt_am         TIMESTAMPTZ,
    erledigt_notiz      TEXT,
    CONSTRAINT messreihe_korrektur_vorschlag_pk
        PRIMARY KEY (tenant_id, entity_id, messkanal, intervall_beginn),
    CONSTRAINT messreihe_korrektur_vorschlag_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT messreihe_korrektur_vorschlag_raster_chk
        CHECK (uems_viertelstunde_raster(intervall_beginn)),
    CONSTRAINT messreihe_korrektur_vorschlag_messkanal_chk
        CHECK (btrim(messkanal) <> '' AND length(messkanal) <= 240),
    CONSTRAINT messreihe_korrektur_vorschlag_grund_chk
        CHECK (grund IN ('nachlieferung_nach_endgueltigkeit')),
    -- Dieselbe Rechnung wie in V20260912170000 (15 Minuten + 7 Tage = 10 095
    -- Minuten), in der timestamp-Ebene, weil `timestamptz + interval` STABLE ist.
    CONSTRAINT messreihe_korrektur_vorschlag_frist_chk
        CHECK ((endgueltig_ab AT TIME ZONE 'UTC')
               = (intervall_beginn AT TIME ZONE 'UTC') + INTERVAL '10095 minutes'),
    CONSTRAINT messreihe_korrektur_vorschlag_zahl_chk
        CHECK (anzahl > 0 AND frueheste_messzeit <= spaeteste_messzeit
               AND erste_eingangszeit <= letzte_eingangszeit
               -- Das IST die Spätankunft: der letzte Eingang lag nach der Frist.
               AND letzte_eingangszeit > endgueltig_ab),
    CONSTRAINT messreihe_korrektur_vorschlag_version_chk
        CHECK (version_bezug IS NULL OR version_bezug >= 1),
    CONSTRAINT messreihe_korrektur_vorschlag_zustand_chk
        CHECK (zustand IN ('offen', 'erledigt', 'verworfen')
               AND (zustand = 'offen') = (erledigt_am IS NULL)),
    CONSTRAINT messreihe_korrektur_vorschlag_notiz_chk
        CHECK (erledigt_notiz IS NULL OR char_length(erledigt_notiz) BETWEEN 1 AND 500)
);

-- Der Leseweg der späteren Fläche (AP-08 / Messdatenpflege): „was ist offen?",
-- älteste Frist zuerst.
CREATE INDEX IF NOT EXISTS idx_messreihe_korrektur_vorschlag_offen
    ON messreihe_korrektur_vorschlag (tenant_id, endgueltig_ab)
    WHERE zustand = 'offen';

-- -----------------------------------------------------------------------------
-- 3. Die TAGESKLASSE `messreihe_tag`
-- -----------------------------------------------------------------------------
-- §4.3: 1 Tag in der ZEITZONE DES STANDORTS (Vorgabe Europe/Berlin), zehn Jahre,
-- Chunk 1 Jahr, „wie VM verdichtet + 96-Slot-Abdeckung; Zeitzone gespeichert".
--
-- ⚠ 96 IST NICHT IMMER 96. An den Umstellungstagen hat ein Ortstag 23 bzw. 25
-- Stunden — am 25.10.2026 sind es 100 Viertelstunden, am 28.03.2027 nur 92. Die
-- Stundenzahl wird NICHT hier gezählt: sie kommt aus `VerbrauchRegeln.stunden`
-- (AP-08 IP-1), das Modul `BezugsPeriode` (AP-09 IP-3) reicht sie durch. Zwei
-- Zählungen derselben Stunden wären zwei Zahlen für dieselbe Aussage.
--
-- ⚠ KEINE `menge`, KEINE `summe`. Die Tages- und Monatsmengen bildet AP-08 IP-5
-- aus den PERIODENSTÄNDEN — nicht als Summe der Viertelstunden. Diese Tabelle
-- liefert IP-5 dafür genau die Fakten: `stand_anfang`/`stand_ende` mit ihren
-- Messzeiten, die Abdeckung und den Zustand. Eine Mengen-Spalte hier wäre eine
-- zweite Zahl für dieselbe Aussage — und die falsche.
CREATE TABLE IF NOT EXISTS messreihe_tag (
    -- ---- Tag + Reihe (Schlüssel) -------------------------------------------
    -- Der KALENDERTAG in der gespeicherten Zeitzone. Die Partitionierungs-Spalte
    -- der Hypertable.
    tag                 DATE        NOT NULL,
    tenant_id           UUID        NOT NULL,
    entity_id           UUID        NOT NULL,
    messkanal           TEXT        NOT NULL,
    site_id             UUID,

    -- ---- Die Tagesgrenze, nachlesbar (W10) ---------------------------------
    -- Die Zeitzone, in der dieser Tag gebildet wurde — GESPEICHERT, damit ein
    -- Bericht in zehn Jahren dieselbe Grenze reproduziert (A8), auch wenn der
    -- Standort inzwischen eine andere trägt.
    zeitzone            TEXT        NOT NULL,
    -- Woher sie kam: `standort` = aus dem Standort der Anlage (AP-02),
    -- `unternehmen` = aus dem Unternehmen des Kundenbereichs, `vorgabe` =
    -- Europe/Berlin, weil keins von beidem zu finden war. Ohne diese Spalte wäre
    -- die Zeitzone eine Behauptung.
    zeitzone_herkunft   TEXT        NOT NULL,
    -- Und die Grenze selbst, in UTC: [beginn, ende). Zusammen mit `stunden`
    -- (23 · 24 · 25) ist der Umstellungstag damit AUS DER ZEILE ABLESBAR.
    beginn              TIMESTAMPTZ NOT NULL,
    ende                TIMESTAMPTZ NOT NULL,
    stunden             SMALLINT    NOT NULL,

    -- ---- Die Slot-Abdeckung (§4.3 „96-Slot-Abdeckung") ---------------------
    -- `slots_erwartet` = stunden × 4 (92 · 96 · 100), `slots_vorhanden` = wie
    -- viele Viertelstundenwerte es wirklich gibt (eine Lücke bekommt keine Zeile,
    -- IP-12 — sie fehlt hier also und wird nie zur Null), `slots_endgueltig` =
    -- wie viele davon endgültig sind.
    slots_erwartet      SMALLINT    NOT NULL,
    slots_vorhanden     SMALLINT    NOT NULL,
    slots_endgueltig    SMALLINT    NOT NULL,

    -- ---- Wertart + Werte (die Fakten, verdichtet) --------------------------
    wertart             TEXT,
    -- Die Periodenstände: der Stand an der Tagesgrenze, mit seiner Messzeit.
    -- GENAU das, woraus AP-08 IP-5 die Tagesmenge bildet.
    stand_anfang        NUMERIC,
    stand_anfang_zeit   TIMESTAMPTZ,
    stand_ende          NUMERIC,
    stand_ende_zeit     TIMESTAMPTZ,
    -- Momentanwert: das mit `erhalten` GEWICHTETE Mittel der Viertelstunden —
    -- also exakt das Mittel der guten Werte des Tages, nie ein Mittel von
    -- Mitteln. Minimum und Maximum sind Minimum und Maximum.
    mittel              NUMERIC,
    min_wert            NUMERIC,
    max_wert            NUMERIC,
    -- Immer: erster und letzter guter Wert des Tages (Zahl ODER Text).
    erster_wert         NUMERIC,
    erster_text         TEXT,
    erster_zeit         TIMESTAMPTZ,
    letzter_wert        NUMERIC,
    letzter_text        TEXT,
    letzter_zeit        TIMESTAMPTZ,

    -- ---- Abdeckung über die vorhandenen Slots ------------------------------
    -- ⚠ `erhalten`/`erwartet` summieren die VORHANDENEN Viertelstunden. Die
    -- Vollständigkeit des Tages sagt `slots_vorhanden` von `slots_erwartet` —
    -- Abdeckung ist nicht Vollständigkeit, und sie wird nie auf 100 % gerundet.
    erhalten            INTEGER     NOT NULL,
    erwartet            INTEGER     NOT NULL,
    abdeckung_prozent   INTEGER,

    -- ---- Qualitätszähler ---------------------------------------------------
    n_good              INTEGER     NOT NULL DEFAULT 0,
    n_uncertain         INTEGER     NOT NULL DEFAULT 0,
    n_invalid           INTEGER     NOT NULL DEFAULT 0,
    n_stale             INTEGER     NOT NULL DEFAULT 0,
    n_device_error      INTEGER     NOT NULL DEFAULT 0,

    -- ---- Herkunfts-Anker ---------------------------------------------------
    geraet_einbau       UUID,
    geraet_einbau_2     UUID,
    geraet_einbau_weitere INTEGER   NOT NULL DEFAULT 0,
    box                 UUID,
    box_2               UUID,
    box_weitere         INTEGER     NOT NULL DEFAULT 0,
    fassung             BIGINT,
    katalog             TEXT,
    rolle               TEXT,

    -- ---- Zustand -----------------------------------------------------------
    -- §4.3: endgültig, wenn alle Viertelstundenwerte endgültig sind. Weil eine
    -- Lücke gar keine Zeile hat, kommt die FRIST DES TAGES dazu: erst wenn auch
    -- die letzte Viertelstunde des Tages ihre sieben Tage hinter sich hat, kann
    -- keine mehr entstehen.
    zustand             TEXT        NOT NULL DEFAULT 'vorlaeufig',
    -- Ende des Tages + 7 Tage.
    endgueltig_ab       TIMESTAMPTZ NOT NULL,
    berechnet_am        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Korrekturen (AP-08) erhöhen die Version; der Tageslauf schreibt IMMER 1.
    version             INTEGER     NOT NULL DEFAULT 1,

    -- ---- Nachlieferung + Ereignisse ----------------------------------------
    n_nachgeliefert     INTEGER     NOT NULL DEFAULT 0,
    letzte_eingangszeit TIMESTAMPTZ,
    zustellart          TEXT,
    ereignisse          JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- ---- Regeln ------------------------------------------------------------
    CONSTRAINT messreihe_tag_messkanal_chk
        CHECK (btrim(messkanal) <> '' AND length(messkanal) <= 240),
    -- Dieselben drei Zonen, die `standort`/`unternehmen` zulassen (V20260911100000).
    CONSTRAINT messreihe_tag_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')
               AND zeitzone_herkunft IN ('standort', 'unternehmen', 'vorgabe')),
    -- Der Tag ist 23, 24 oder 25 Stunden lang — und genau so viele Stunden
    -- liegen zwischen `beginn` und `ende`. Vier Slots je Stunde.
    CONSTRAINT messreihe_tag_grenze_chk
        CHECK (stunden IN (23, 24, 25)
               AND ende > beginn
               AND slots_erwartet = stunden * 4
               AND (ende AT TIME ZONE 'UTC')
                   = (beginn AT TIME ZONE 'UTC') + (stunden * INTERVAL '1 hour')),
    CONSTRAINT messreihe_tag_slots_chk
        CHECK (slots_vorhanden BETWEEN 0 AND slots_erwartet
               AND slots_endgueltig BETWEEN 0 AND slots_vorhanden),
    CONSTRAINT messreihe_tag_wertart_chk
        CHECK (wertart IS NULL OR wertart IN ('counter', 'gauge', 'state', 'bitfield', 'text')),
    CONSTRAINT messreihe_tag_rolle_chk
        CHECK (rolle IS NULL OR rolle IN ('fuehrend', 'vergleich', 'beobachtung')),
    CONSTRAINT messreihe_tag_zustand_chk
        CHECK (zustand IN ('vorlaeufig', 'endgueltig')
               -- Ein endgültiger Tag hat keine offene Viertelstunde mehr.
               AND (zustand = 'vorlaeufig' OR slots_endgueltig = slots_vorhanden)),
    -- Tagesende + 7 Tage.
    CONSTRAINT messreihe_tag_frist_chk
        CHECK ((endgueltig_ab AT TIME ZONE 'UTC')
               = (ende AT TIME ZONE 'UTC') + INTERVAL '7 days'),
    CONSTRAINT messreihe_tag_version_chk CHECK (version >= 1),
    CONSTRAINT messreihe_tag_zaehler_chk
        CHECK (erhalten >= 0 AND erwartet >= 0 AND n_good >= 0 AND n_uncertain >= 0
               AND n_invalid >= 0 AND n_stale >= 0 AND n_device_error >= 0
               AND n_nachgeliefert >= 0 AND geraet_einbau_weitere >= 0 AND box_weitere >= 0),
    CONSTRAINT messreihe_tag_abdeckung_chk
        CHECK (abdeckung_prozent IS NULL
               OR (abdeckung_prozent BETWEEN 0 AND 100
                   AND (abdeckung_prozent < 100 OR erhalten >= erwartet))),
    CONSTRAINT messreihe_tag_anker_chk
        CHECK ((geraet_einbau_2 IS NULL OR (geraet_einbau IS NOT NULL AND geraet_einbau_2 <> geraet_einbau))
               AND (box_2 IS NULL OR (box IS NOT NULL AND box_2 <> box))
               AND (geraet_einbau_weitere = 0 OR geraet_einbau_2 IS NOT NULL)
               AND (box_weitere = 0 OR box_2 IS NOT NULL)),
    CONSTRAINT messreihe_tag_zustellart_chk
        CHECK ((zustellart IS NULL OR zustellart IN ('direkt', 'nachgeliefert', 'gemischt'))
               AND (n_nachgeliefert = 0 OR zustellart IN ('nachgeliefert', 'gemischt'))),
    -- Dieselbe Zählung wie in der Viertelstunde (V20260912170000).
    CONSTRAINT messreihe_tag_ereignisse_chk
        CHECK (messreihe_viertelstunde_ereignisse_erlaubt(ereignisse))
);

-- Chunk 1 Jahr (§4.3). Ohne die Vorgabe-Indizes: sie stünden ohne `tenant_id` vorn.
SELECT create_hypertable('messreihe_tag', 'tag', if_not_exists => TRUE,
                         chunk_time_interval => INTERVAL '365 days',
                         create_default_indexes => FALSE);

-- Der EINE Index: der Schlüssel der Reihe UND der Leseweg „diese Reihe über die
-- Tage". `tenant_id` vorn (die Hausregel der UEMS-Migrationen), die Zeit gehört
-- in jeden eindeutigen Index einer Hypertable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_messreihe_tag_reihe
    ON messreihe_tag (tenant_id, entity_id, messkanal, tag);

-- Zehn Jahre (E7, Plan §1) — dieselbe Zahl wie die Viertelstunde.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.jobs
                    WHERE proc_name = 'policy_retention'
                      AND hypertable_name = 'messreihe_tag') THEN
        PERFORM add_retention_policy('messreihe_tag', INTERVAL '3653 days');
    END IF;
END $$;

-- Das VORBEREITETE Kompressions-Layout (E7) — wie bei der Viertelstunde: FEST
-- und ABRUFBAR, aber nicht eingeschaltet (Kompression ist auf einer FORCE-RLS-
-- Hypertable gesperrt). Die Tabelle ist schon so geordnet.
CREATE OR REPLACE FUNCTION messreihe_tag_kompression_layout(
    OUT segmentby TEXT, OUT orderby TEXT) LANGUAGE sql IMMUTABLE AS $$
    SELECT 'tenant_id, entity_id, messkanal'::text, 'tag DESC'::text;
$$;

COMMENT ON FUNCTION messreihe_tag_kompression_layout() IS
    'AP-07 E7: das VORBEREITETE Kompressions-Layout der Tagesklasse (segmentby Reihe, orderby '
    'Tag). Nicht eingeschaltet - Kompression ist auf einer FORCE-RLS-Hypertable gesperrt.';

-- -----------------------------------------------------------------------------
-- 3b. Die ARBEITSLISTE der Tageswerte — durable, wie die der Viertelstunden
-- -----------------------------------------------------------------------------
-- Dasselbe Muster wie `messreihe_viertelstunde_arbeit` (V20260912170000): der
-- Schlüssel IST der Eintrag (derselbe Tag steht höchstens einmal darin), die
-- Entnahme greift unter `FOR UPDATE SKIP LOCKED`, und entnehmen und schreiben
-- liegen in EINER Transaktion — ein Abbruch verliert nichts.
--
-- ⚠ Sie merkt sich den UTC-TAG, nicht den Ortstag. Der Grund ist eine
-- Reihenfolge: welcher ORTSTAG betroffen ist, weiß man erst, wenn die Zeitzone
-- des Standorts nachgeschlagen ist — und die schlägt der Lauf nach, nicht die
-- Datenbank. Ein UTC-Tag berührt in jeder Zone höchstens ZWEI Ortstage
-- (`TagRegeln.ortstageEinesUtcTages`); der Lauf bildet beide.
CREATE TABLE IF NOT EXISTS messreihe_tag_arbeit (
    tenant_id      UUID        NOT NULL,
    entity_id      UUID        NOT NULL,
    messkanal      TEXT        NOT NULL,
    utc_tag        DATE        NOT NULL,
    -- `viertelstunde` = eine Viertelstunde dieses UTC-Tages wurde neu gebildet;
    -- `frist` = der Tag ist noch vorläufig, seine Frist ist aber abgelaufen;
    -- `rueckrechnung` = die einmalige Bildung der Vergangenheit.
    grund          TEXT        NOT NULL,
    eingetragen_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_tag_arbeit_pk
        PRIMARY KEY (tenant_id, entity_id, messkanal, utc_tag),
    CONSTRAINT messreihe_tag_arbeit_grund_chk
        CHECK (grund IN ('viertelstunde', 'frist', 'rueckrechnung'))
);

-- Der älteste Tag zuerst, damit eine Nachlieferung nicht hinter der laufenden
-- Bildung verhungert.
CREATE INDEX IF NOT EXISTS idx_messreihe_tag_arbeit_reihenfolge
    ON messreihe_tag_arbeit (utc_tag, eingetragen_am);

-- Der Leseweg des Frist-Durchgangs: „welcher Tag ist noch vorläufig?". Teilweise
-- auf `zustand` und auf `tag` (der Partitionierungs-Spalte) — er schrumpft mit
-- jedem Tag, der endgültig wird.
CREATE INDEX IF NOT EXISTS idx_messreihe_tag_vorlaeufig
    ON messreihe_tag (tag)
    WHERE zustand = 'vorlaeufig';

-- -----------------------------------------------------------------------------
-- 4. Der Laufzustand der beiden neuen Läufe
-- -----------------------------------------------------------------------------
-- Nicht mandantengebunden (ein Betriebszustand, kein Kundendatum) — darum ohne
-- RLS, und die App-Rolle bekommt gar nichts. Dasselbe Muster wie
-- `messreihe_viertelstunde_lauf`.
CREATE TABLE IF NOT EXISTS messreihe_tag_lauf (
    schluessel   TEXT        PRIMARY KEY,
    zeitpunkt    TIMESTAMPTZ,
    zahl         BIGINT      NOT NULL DEFAULT 0,
    notiz        TEXT,
    geaendert_am TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT messreihe_tag_lauf_schluessel_chk
        CHECK (schluessel IN ('zeiger', 'rueckrechnung', 'endgueltigkeit'))
);

-- `zeiger`: bis zu welchem `berechnet_am` der Viertelstunden die Tage schon
-- nachgezogen sind. `rueckrechnung`: bis zu welchem TAG rückwärts die einmalige
-- Bildung der Vergangenheit gekommen ist (`notiz = 'fertig'`, wenn sie durch
-- ist). `endgueltigkeit`: wann der Stundenlauf zuletzt fällige Zeilen
-- umgeschaltet hat, und wie viele es insgesamt waren.
INSERT INTO messreihe_tag_lauf (schluessel, zeitpunkt, zahl, notiz)
VALUES ('zeiger', NULL, 0, NULL), ('rueckrechnung', NULL, 0, NULL),
       ('endgueltigkeit', NULL, 0, NULL)
ON CONFLICT (schluessel) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 5. Der Mandantenzaun (Hausregel: fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE messreihe_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_tag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_tag_tenant_isolation ON messreihe_tag;
CREATE POLICY messreihe_tag_tenant_isolation ON messreihe_tag
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messreihe_tag_arbeit ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_tag_arbeit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_tag_arbeit_tenant_isolation ON messreihe_tag_arbeit;
CREATE POLICY messreihe_tag_arbeit_tenant_isolation ON messreihe_tag_arbeit
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE messreihe_korrektur_vorschlag ENABLE ROW LEVEL SECURITY;
ALTER TABLE messreihe_korrektur_vorschlag FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messreihe_korrektur_vorschlag_tenant_isolation ON messreihe_korrektur_vorschlag;
CREATE POLICY messreihe_korrektur_vorschlag_tenant_isolation ON messreihe_korrektur_vorschlag
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- 6. Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird weggenommen, was es nicht geben darf.
--
-- Beide Läufe sind Hintergrund-Läufe OHNE Mandanten-Kontext; sie schreiben über
-- die BYPASSRLS-Rolle, genau wie der Verdichtungs-Lauf (V20260912170000). Die
-- App-Rolle LIEST nur — hinter ihrem Zaun. Kein BIGSERIAL, darum kein
-- Sequenz-Grant.
REVOKE ALL ON messreihe_tag FROM ${appDbUser};
GRANT SELECT ON messreihe_tag TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_tag TO ${adminDbUser};

REVOKE ALL ON messreihe_korrektur_vorschlag FROM ${appDbUser};
GRANT SELECT ON messreihe_korrektur_vorschlag TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_korrektur_vorschlag TO ${adminDbUser};

REVOKE ALL ON messreihe_tag_arbeit FROM ${appDbUser};
REVOKE ALL ON messreihe_tag_lauf FROM ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_tag_arbeit TO ${adminDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON messreihe_tag_lauf TO ${adminDbUser};

-- ⚠ Die EINE Erweiterung an einem BESTEHENDEN Recht: der Stundenlauf meldet
-- `late_arrival`, und er tut es in DERSELBEN Transaktion, in der er den
-- Nachzügler ablehnt und den Vorschlag schreibt — sonst gäbe es einen
-- Augenblick, in dem der Wert abgelehnt, aber die Meldung noch nicht da ist.
-- Dafür braucht die BYPASSRLS-Rolle INSERT auf der Ereignis-Tabelle. Sie bleibt
-- APPEND-ONLY: UPDATE bekommt weiterhin niemand, DELETE nur das Offboarding
-- (V20260911260000 §7), und der UPDATE-Trigger steht unverändert.
GRANT INSERT ON messreihe_ereignis TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- 7. Was die Tabellen bedeuten
-- -----------------------------------------------------------------------------
COMMENT ON TABLE messreihe_tag IS
    'Speicherklasse Tageswerte (UEMS AP-07 IP-13, E6/E7/W10): ein Kalendertag in der ZEITZONE DES '
    'STANDORTS, die Zeitzone steht in der Zeile (A8). Hypertable, Chunk 1 Jahr, Aufbewahrung '
    '3 653 Tage, RLS + FORCE, OHNE Kompression (Layout messreihe_tag_kompression_layout). Gebildet '
    'aus den Viertelstundenwerten des Tages. KEINE menge- und KEINE summe-Spalte: Tages- und '
    'Monatsmengen bildet AP-08 IP-5 aus den Periodenstaenden (stand_anfang/stand_ende).';
COMMENT ON COLUMN messreihe_tag.stunden IS
    '23, 24 oder 25 - am Umstellungstag ist ein Tag kuerzer bzw. laenger (25.10.2026: 25 h, '
    '28.03.2027: 23 h). Gezaehlt wird nicht hier, sondern in VerbrauchRegeln.stunden (AP-08 IP-1).';
COMMENT ON COLUMN messreihe_tag.slots_erwartet IS
    'stunden × 4 - also 92, 96 oder 100. "96-Slot-Abdeckung" (§4.3) heisst NICHT immer 96.';
COMMENT ON COLUMN messreihe_tag.zustand IS
    'endgueltig, wenn jede vorhandene Viertelstunde endgueltig ist UND die Frist des Tages '
    '(Tagesende + 7 Tage) abgelaufen ist - erst dann kann keine fehlende Viertelstunde mehr '
    'entstehen. Eine Luecke hat gar keine Zeile (IP-12) und wird nie zur Null.';
COMMENT ON COLUMN messreihe_tag.mittel IS
    'Das mit `erhalten` GEWICHTETE Mittel der Viertelstunden - exakt das Mittel der guten Werte '
    'des Tages, nie ein Mittel von Mitteln.';
COMMENT ON COLUMN messreihe_tag.abdeckung_prozent IS
    'erhalten / erwartet ueber die VORHANDENEN Viertelstunden, abgeschnitten - nie auf 100 % '
    'gerundet. Die Vollstaendigkeit des Tages sagt slots_vorhanden von slots_erwartet.';
COMMENT ON TABLE messreihe_korrektur_vorschlag IS
    'Die KORREKTUR-LISTE (UEMS AP-07 IP-13, E5): ein Rohwert, dessen Intervall seine Frist hinter '
    'sich hat, wird gespeichert, als late_arrival gemeldet und HIER vorgeschlagen - der '
    'endgueltige Viertelstundenwert bleibt Zeichen fuer Zeichen stehen. Speichern, melden, '
    'vorschlagen - nicht anwenden. Die versionierte Korrektur daraus macht AP-08 (IP-12 ff.); von '
    'dieser Liste aus fuehrt kein Weg zu einer Zeile der Viertelstunden- oder Tagesklasse.';
COMMENT ON COLUMN messreihe_korrektur_vorschlag.version_bezug IS
    'Die Fassung des Viertelstundenwerts, auf die sich der Vorschlag bezieht; NULL = fuer dieses '
    'Intervall steht gar keine Zeile (eine Luecke bekommt keine, IP-12).';
COMMENT ON TABLE messreihe_tag_arbeit IS
    'Durable Arbeitsliste der Tageswerte (AP-07 IP-13): gefuellt aus neu gebildeten '
    'Viertelstunden, aus dem Frist-Durchgang und aus der einmaligen Rueckrechnung, geleert vom '
    'Tageslauf in derselben Transaktion, in der er die Tage schreibt. Sie merkt sich den UTC-Tag; '
    'welche ORTSTAGE das sind, entscheidet die Zeitzone des Standorts (hoechstens zwei).';
COMMENT ON TABLE messreihe_tag_lauf IS
    'Laufzustand der Taeglichkeit (AP-07 IP-13): zeiger = bis zu welchem berechnet_am der '
    'Viertelstunden die Tage nachgezogen sind; rueckrechnung = bis zu welchem Tag rueckwaerts die '
    'einmalige Bildung gekommen ist (notiz = fertig, wenn durch); endgueltigkeit = wann der '
    'Stundenlauf zuletzt lief und wie viele Zeilen er insgesamt umgeschaltet hat.';

-- -----------------------------------------------------------------------------
-- 8. EIN Wort mehr im Vokabular: `late_arrival` darf auch von `cloud` kommen
-- -----------------------------------------------------------------------------
-- Der Vertrag (`docs/contracts/v2/events-vocabulary.md` §1) kennt zwei Wege:
-- Weg 1 meldet die Box, Weg 2 stellt die Cloud fest — `datenannahme`, `writer`,
-- `cloud`, `kunde`. `late_arrival` stand bisher allein bei `writer`, weil §4.8
-- des Konzepts den Writer als Urheber nannte. IP-13 baut den Lauf aber in der
-- `api` (so das Lieferpaket), und dort heißt derselbe Weg `cloud` — genau wie
-- schon bei `data_gap` aus dem Herzschlag. Ein Ereignis mit dem falschen
-- Urheber-Wort zu schreiben wäre eine Lüge über seine Herkunft; darum bekommt
-- die Art einen zweiten zulässigen Urheber.
--
-- ADDITIV im strengsten Sinn: eine Erlaubnis wird GEWEITET. Keine bestehende
-- Zeile wird ungültig, kein `writer`-Ereignis ändert sich, und ein fremdes Wort
-- wird weiter VERWORFEN. Die Zwillinge (`uems/EreignisVokabular` in der api und
-- im Writer) und die Vektor-Datei tragen dieselbe Weitung.
--
-- Die Funktion wird KOMPLETT neu geschrieben — der Stand von V20260911260000,
-- Zeichen für Zeichen, mit genau dieser einen Änderung. Das ist die Hausregel
-- für ein geweitetes Vokabular: den AKTUELLEN Stand abschreiben, nie den der
-- Ur-Migration erraten.
CREATE OR REPLACE FUNCTION messreihe_ereignis_vokabular()
RETURNS TABLE (art TEXT, urheber TEXT[], zeitform TEXT, grenzen TEXT, offen_erlaubt BOOLEAN,
               bezug_pflicht TEXT[], bezug_erlaubt TEXT[], pflicht TEXT[], felder TEXT[],
               fortschreibbar TEXT[], bestand BOOLEAN)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('data_gap', ARRAY['writer', 'box', 'cloud']::text[], 'zeitraum', 'halboffen', true,
     ARRAY['box']::text[], ARRAY['datenquelle', 'komponente', 'messkanal', 'messstelle']::text[],
     ARRAY['erkannt_aus']::text[],
     ARRAY['erwartet_fehlend', 'nachgeliefert_am', 'fehlerklasse', 'ursache_ereignis']::text[],
     ARRAY['bis', 'erwartet_fehlend', 'nachgeliefert_am', 'ursache_ereignis']::text[], true),
    ('backfill', ARRAY['writer']::text[], 'zeitraum', 'geschlossen', false,
     ARRAY['box', 'datenquelle']::text[], '{}'::text[],
     ARRAY['eingang_von', 'eingang_bis', 'anzahl']::text[],
     ARRAY['erwartet']::text[],
     '{}'::text[], false),
    ('duplicate_conflict', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'komponente', 'messkanal']::text[], ARRAY['messstelle']::text[],
     ARRAY['messzeit', 'gespeicherter_wert', 'abgewiesener_wert', 'sequenzen']::text[],
     ARRAY['einheit']::text[],
     '{}'::text[], false),
    ('sequence_gap', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'sequenz_erwartet', 'sequenz_erhalten', 'anzahl']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('sequence_reset', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'sequenz_erwartet', 'sequenz_erhalten']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('late_arrival', ARRAY['writer', 'cloud']::text[], 'zeitraum', 'halboffen', false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['eingangszeit', 'anzahl']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('counter_reset', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['stand_alt', 'stand_neu']::text[],
     ARRAY['messzeit_alt', 'einheit']::text[],
     '{}'::text[], true),
    ('device_boundary', ARRAY['kunde']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente']::text[], ARRAY['messkanal', 'messstelle']::text[],
     ARRAY['anlass', 'einbau_alt', 'einbau_neu', 'eingetragen_am']::text[],
     ARRAY['endstand', 'anfangsstand', 'einheit', 'bestaetigt_ereignis']::text[],
     '{}'::text[], false),
    ('handover', ARRAY['cloud']::text[], 'zeitraum', 'halboffen', true,
     ARRAY['datenquelle']::text[], '{}'::text[],
     ARRAY['anlass', 'box_alt', 'box_neu']::text[],
     '{}'::text[],
     ARRAY['bis']::text[], false),
    ('unassigned_reader', ARRAY['writer']::text[], 'zeitraum', 'geschlossen', false,
     ARRAY['box', 'datenquelle', 'komponente']::text[], ARRAY['messkanal']::text[],
     ARRAY['anzahl']::text[],
     ARRAY['zustaendige_box']::text[],
     '{}'::text[], false),
    ('rejected', ARRAY['datenannahme', 'writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'grund']::text[],
     ARRAY['anzahl', 'sequenz']::text[],
     '{}'::text[], false),
    ('clock_ahead', ARRAY['datenannahme']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'vor_s']::text[],
     ARRAY['anzahl', 'sequenz']::text[],
     '{}'::text[], false),
    ('too_old', ARRAY['datenannahme']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'alter_s']::text[],
     ARRAY['anzahl', 'sequenz']::text[],
     '{}'::text[], false),
    ('clock_jump', ARRAY['datenannahme']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     ARRAY['strom', 'sequenz', 'sprung_s']::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('box_restart', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box']::text[], '{}'::text[],
     '{}'::text[],
     '{}'::text[],
     '{}'::text[], false),
    ('device_restart', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], '{}'::text[],
     '{}'::text[],
     ARRAY['herzschlag_vorher', 'herzschlag_nachher']::text[],
     '{}'::text[], false),
    ('frozen_source', ARRAY['box', 'writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], ARRAY['komponente', 'messkanal']::text[],
     '{}'::text[],
     ARRAY['lesungen', 'herzschlag']::text[],
     '{}'::text[], false),
    ('range_limit', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], ARRAY['komponente']::text[],
     '{}'::text[],
     ARRAY['statuswort']::text[],
     '{}'::text[], false),
    ('layout_changed', ARRAY['box']::text[], 'zeitpunkt', NULL, false,
     ARRAY['box', 'datenquelle']::text[], '{}'::text[],
     '{}'::text[],
     ARRAY['fassung_erwartet', 'fassung_gelesen', 'karten_erwartet', 'karten_gelesen']::text[],
     '{}'::text[], false),
    ('error_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('state_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('bitfield_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true),
    ('text_change', ARRAY['writer']::text[], 'zeitpunkt', NULL, false,
     ARRAY['komponente', 'messkanal']::text[], ARRAY['box', 'messstelle']::text[],
     ARRAY['alt', 'neu']::text[],
     '{}'::text[],
     '{}'::text[], true)
$$;


COMMENT ON FUNCTION messreihe_ereignis_vokabular() IS
    'Das EINE Vokabular der Ereignisse (AP-07 IP-8, Vertrag events-vocabulary.md). Seit AP-07 '
    'IP-13 darf late_arrival auch von `cloud` kommen: den Lauf, der die Spaetankunft feststellt, '
    'faehrt die api, nicht der Writer.';
