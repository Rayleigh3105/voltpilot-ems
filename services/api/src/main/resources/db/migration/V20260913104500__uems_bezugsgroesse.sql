-- =============================================================================
-- UEMS AP-09 IP-4: die BEZUGSGRÖSSEN als Tabellen — Werte als FASSUNGEN, die nie
-- überschrieben werden (Konzept vp-uems-ap09-bezugsgroessen §4.1–§4.5, §6.1,
-- §8 IP-4; Captain-Entscheide E1–E17 = A vom 12.09.2026). Maßgeblich ist der
-- Vertrag docs/contracts/v2/bezugsdaten.md + bezugsdaten-vectors.json mit den
-- Modulen uems/BezugsEinheit, uems/BezugsPeriode und uems/BezugsdatenRegeln —
-- jede Regel hier sagt DASSELBE wie dort; UemsBezugsgroesseMigrationTest liest
-- die Vektor-Datei und spielt sie gegen die Datenbank.
--
-- Vier mandantengebundene Tabellen, rein additiv (keine bestehende Tabelle,
-- kein Vertrag, keine Route und keine Box wird berührt):
--
--   bezugsgroesse                      Kennzeichen, Name, Wertart, Einheit,
--                                      Periode und GENAU EIN Geltungsbereich (E1)
--   bezugsgroesse_kennzeichen_verlauf  JEDES Kennzeichen, das eine Bezugsgröße je
--                                      trug — es wird nie weitergegeben (M2)
--   bezugsgroesse_wert                 die Werte als Fassungen, APPEND-ONLY (E6)
--   bezugsgroesse_aenderung            das Änderungsprotokoll der Bezugsgröße
--
-- ⚠ EIN WERT WIRD NIE ÜBERSCHRIEBEN (E6, F2, Invariante 1). Eine Berichtigung ist
-- Fassung n + 1 mit Begründung, Urheber und Zeitpunkt; eine Rücknahme ist
-- Fassung n + 1 `ruecknahme`, nie ein Löschen (E11); Fassung n bleibt lesbar.
-- Ein Trigger lehnt JEDES UPDATE auf bezugsgroesse_wert ab — auch für die
-- Verwaltungsrolle und den Eigentümer, nicht nur per fehlendem Recht. DELETE
-- hat nur die Verwaltungsrolle, und nur das Offboarding benutzt es (Muster
-- messreihe_ereignis, V20260911260000).
--
-- ⚠ WAS EIN BETRAG BEDEUTET, STEHT IN DER WERT-ZEILE (M1). Wertart, Einheit und
-- Periodenart der Bezugsgröße reisen als Kopie in jeden Wert und sind per
-- zusammengesetztem Fremdschlüssel an sie gebunden: sobald ein Wert besteht,
-- lehnt der Fremdschlüssel jede Änderung dieser drei ab — 312 400 „kg" werden
-- nie still zu 312 400 „t". Den Geltungsbereich hält ein Trigger nach dem
-- ersten Wert fest; vorher sind alle vier änderbar (M1 wörtlich).
--
-- DIE VOKABULARE KOMMEN AUS DEM VERTRAG. bezugsdaten_vokabular() ist die EINE
-- Stelle in der Datenbank, an der sie stehen — Zeile für Zeile die Listen
-- `vokabulare.wertart|geltung_art|periode_art|herkunft_art|vorgang|status` und
-- `einheiten` der Vektor-Datei, in ihrer Reihenfolge. JEDER CHECK auf ein Wort
-- dieser Vokabulare fragt sie über bezugsdaten_wort(); keiner trägt eine eigene
-- Wortliste. (Urheber-Art und -Rolle sind das Akteur-Vokabular von AP-03 und
-- stehen wie an messstelle_aenderung; `bezugsgroesse_aenderung.art` ist das
-- Protokoll-Vokabular aus §6.1 — beide sind kein Wort des Bezugsdaten-Vertrags.)
-- UemsBezugsgroesseMigrationTest vergleicht die Funktion mit der
-- Vektor-Datei; weitet der Vertrag ein Vokabular, wird der Test rot und nennt
-- den VALUES-Block, den eine NEUE Migration mit CREATE OR REPLACE FUNCTION
-- abschreibt — kein CHECK wird angefasst, keine Testliste gepflegt.
--
-- ZEITFORMEN (nicht neu erfunden):
--   * Periodenwert: `periode_von`/`periode_bis` als TAGE, geschlossen, `bis` =
--     LETZTER Tag einschließlich (Muster der Zuordnungen) — genau EINE
--     Kalenderperiode ihrer Art (Z2): Oktober 2026 = 2026-10-01 … 2026-10-31.
--     Der Vertrag spricht dieselbe Periode halboffen in Instanten
--     (2026-10-01T00:00+02:00 … 2026-11-01T00:00+01:00); die Zone, in der die
--     Tage gelten, steht als `zeitzone` in der Zeile (Standort des
--     Geltungsbereichs, Z1 — gespeichert wie an messreihe_tag, W10/A8).
--   * Stand: `zeitpunkt` auf die volle Minute (Z5).
--   * Protokoll `gilt_ab`: ein Zeitpunkt (wie messstelle_aenderung).
--
-- WAS DIE DATENBANK NICHT PRÜFT (Regeln der Schreibwege IP-5/IP-7/IP-13 — sie
-- brauchen den Standort, das Unternehmen oder den Verlauf der Fassungen):
-- welche Zeitzone gilt (Z1), Wiederholung/Konflikt (Invariante 2), Vier-Augen
-- und wer freigeben darf (F3, AP-03), ob ein Erstwert nach einer Rücknahme
-- steht (C7), Umrechnung und ganze Zahlen (U1/U5), die gebundenen Zeiträume
-- eines Messkanals (M5). Die Datenbank hält die zeitlose Hälfte.
--
-- ⚠ PROZESS UND KOSTENSTELLE: das Vokabular `geltung_art` nennt alle sieben
-- Objekte (E1), aber Prozess und Kostenstelle haben noch keine Tabelle. Bis
-- ihre Objekte gebaut sind, hat eine Bezugsgröße für sie keine Verweis-Spalte
-- und bezugsgroesse_geltung_objekt_chk lehnt sie ab („wählbar, sobald ihre
-- Objekte gebaut sind"). Das Paket, das sie baut, ergänzt die Spalte und
-- schreibt DIESEN CHECK ab.
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT. Ein Fremdschlüssel-Test umgeht RLS;
-- darum verweist alles über (…, tenant_id), und `tenant_id` steht VORN in jedem
-- Unique-Schlüssel (er prüft vor dem Fremdschlüssel und ohne RLS).
--
-- Nicht dieses Paket: Routen und Lesemodell (IP-5), Stammdaten mit Gültigkeit
-- (IP-6), Eingabe/Berichtigung/Vier-Augen (IP-7), Import (IP-11 ff.),
-- Kanalbindung (IP-17), Rechte-Durchsetzung (AP-03).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Die Vokabulare des Vertrags (siehe Kopf). `nr` ist die Stelle im Vertrag,
-- `groesse` nur bei `einheiten` die Größe, unter der die Einheit steht.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bezugsdaten_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT, groesse TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('wertart', 1, 'periodenwert', NULL),
    ('wertart', 2, 'stand', NULL),
    ('wertart', 3, 'stammdatum', NULL),
    ('geltung_art', 1, 'unternehmen', NULL),
    ('geltung_art', 2, 'standort', NULL),
    ('geltung_art', 3, 'gebaeude', NULL),
    ('geltung_art', 4, 'bereich', NULL),
    ('geltung_art', 5, 'prozess', NULL),
    ('geltung_art', 6, 'kostenstelle', NULL),
    ('geltung_art', 7, 'messstelle', NULL),
    ('periode_art', 1, 'tag', NULL),
    ('periode_art', 2, 'woche', NULL),
    ('periode_art', 3, 'monat', NULL),
    ('periode_art', 4, 'jahr', NULL),
    ('herkunft_art', 1, 'eingabe', NULL),
    ('herkunft_art', 2, 'import', NULL),
    ('herkunft_art', 3, 'messkanal', NULL),
    ('herkunft_art', 4, 'stammdatum_ap02', NULL),
    ('vorgang', 1, 'erstwert', NULL),
    ('vorgang', 2, 'berichtigung', NULL),
    ('vorgang', 3, 'ruecknahme', NULL),
    ('status', 1, 'wirksam', NULL),
    ('status', 2, 'vorschlag', NULL),
    ('status', 3, 'zurueckgenommen', NULL),
    ('status', 4, 'abgelehnt', NULL),
    ('einheiten', 1, 'kg', 'masse'),
    ('einheiten', 2, 't', 'masse'),
    ('einheiten', 3, 'Stück', 'stueckzahl'),
    ('einheiten', 4, 'h', 'zeit'),
    ('einheiten', 5, 'min', 'zeit'),
    ('einheiten', 6, 'm²', 'flaeche'),
    ('einheiten', 7, 'm³', 'volumen'),
    ('einheiten', 8, 'l', 'volumen'),
    ('einheiten', 9, 'Personen', 'personen'),
    ('einheiten', 10, 'Schichten', 'schichten'),
    ('einheiten', 11, 'Kd', 'gradtage'),
    ('einheiten', 12, '°C', 'temperatur')
$$;

-- Steht `p_wort` im Vokabular `p_vokabular`? NULL ist nie ein Wort. (Schema
-- ausgeschrieben: ein CHECK wird auch unter leerem search_path geprüft, etwa
-- beim Einspielen einer Sicherung.)
CREATE OR REPLACE FUNCTION bezugsdaten_wort(p_vokabular TEXT, p_wort TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM public.bezugsdaten_vokabular() v
                 WHERE v.vokabular = p_vokabular AND v.wort = p_wort)
$$;

-- F2/C7: die Begründung einer Berichtigung oder Rücknahme — Länge nach
-- `regeln.begruendung_min_zeichen` / `begruendung_max_zeichen` des Vertrags
-- (dieselbe Zählung wie BezugsdatenRegeln: Zeichen, nichts wird gekürzt).
CREATE OR REPLACE FUNCTION bezugsdaten_begruendung_gueltig(p_begruendung TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT char_length(p_begruendung) BETWEEN 10 AND 500
$$;

-- -----------------------------------------------------------------------------
-- bezugsgroesse: die Bezugsgröße selbst (§4.1, §4.2, §6.1).
--
-- Der Geltungsbereich ist GENAU EINE gesetzte Verweis-Spalte, passend zu
-- `geltung_art` (E1): unternehmen → unternehmen_id, standort → standort_id,
-- gebaeude/bereich → ort_id (die Art des Orts muss passen: Fremdschlüssel über
-- die berechnete Spalte `ort_art`, Muster ort_zuordnung), messstelle →
-- messstelle_id. Prozess/Kostenstelle: noch keine Spalte (siehe Kopf).
--
-- `periode_art` gibt es genau bei der Wertart `periodenwert`; ein Stand hat
-- Zeitpunkte, ein Stammdatum Gültigkeiten (§4.3 S1).
--
-- Die Art („Produktionsmenge", „Gutteile" …, §4.2) ist KEINE Spalte: der Vertrag
-- führt dafür kein Vokabular, und eine Wortliste aus eigener Feder wäre eine
-- zweite Wahrheit. Sie kommt additiv, sobald der Vertrag sie trägt.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bezugsgroesse (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    -- Das HEUTIGE Kennzeichen (BZ-0001 …, M2); jedes je getragene steht in
    -- bezugsgroesse_kennzeichen_verlauf.
    kennzeichen     TEXT        NOT NULL,
    name            TEXT        NOT NULL,
    wertart         TEXT        NOT NULL,
    einheit         TEXT        NOT NULL,
    periode_art     TEXT,
    geltung_art     TEXT        NOT NULL,
    unternehmen_id  UUID,
    standort_id     UUID,
    ort_id          UUID,
    messstelle_id   UUID,
    -- Die Art des Orts, auf den der Verweis zeigt — nur bei Gebäude/Bereich.
    ort_art         TEXT GENERATED ALWAYS AS
        (CASE WHEN geltung_art IN ('gebaeude', 'bereich') THEN geltung_art END) STORED,
    -- NULL = nicht archiviert (M6: archiviert, nie gelöscht; Werte bleiben).
    archiviert_am   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsgroesse_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_unternehmen_fk FOREIGN KEY (unternehmen_id, tenant_id)
        REFERENCES unternehmen (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_ort_fk FOREIGN KEY (ort_id, tenant_id, ort_art)
        REFERENCES ort (id, tenant_id, art) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_kennzeichen_eindeutig UNIQUE (tenant_id, kennzeichen),
    -- Ziele der zusammengesetzten Verweise (der Mandant reist mit).
    CONSTRAINT bezugsgroesse_id_tenant_uq UNIQUE (id, tenant_id),
    -- Die Bedeutung eines Betrags — Ziel des Verweises JEDER Wert-Zeile (M1).
    CONSTRAINT bezugsgroesse_bedeutung_uq UNIQUE (id, tenant_id, wertart, einheit),
    CONSTRAINT bezugsgroesse_periode_uq UNIQUE (id, tenant_id, periode_art),
    -- Kein Verweis zeigt hierauf: der Schlüssel macht die Geltungs-Spalten zu
    -- SCHLÜSSEL-Spalten. Wer sie ändert, braucht darum die Zeilensperre FOR
    -- UPDATE, und die kollidiert mit dem FOR KEY SHARE, das das Einfügen eines
    -- Werts auf seine Bezugsgröße nimmt — der Trigger
    -- bezugsgroesse_identitaet_bleibt sieht einen gleichzeitig entstehenden
    -- ersten Wert also immer schon bestätigt, nie „noch nicht".
    CONSTRAINT bezugsgroesse_geltung_uq
        UNIQUE (id, tenant_id, geltung_art, unternehmen_id, standort_id, ort_id, messstelle_id),
    -- Vertrag Messstellen §3, sinngemäß (M2 „analog AP-04"): 2–16 Zeichen aus
    -- A-Z, 0-9, „-", „.", „/". Nichts wird umgewandelt.
    CONSTRAINT bezugsgroesse_kennzeichen_format CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$'),
    CONSTRAINT bezugsgroesse_name_chk CHECK (btrim(name) <> ''),
    CONSTRAINT bezugsgroesse_wertart_chk CHECK (coalesce(bezugsdaten_wort('wertart', wertart), false)),
    CONSTRAINT bezugsgroesse_einheit_chk CHECK (coalesce(bezugsdaten_wort('einheiten', einheit), false)),
    CONSTRAINT bezugsgroesse_periode_art_chk
        CHECK (periode_art IS NULL OR coalesce(bezugsdaten_wort('periode_art', periode_art), false)),
    CONSTRAINT bezugsgroesse_periode_je_wertart_chk
        CHECK ((wertart = 'periodenwert') = (periode_art IS NOT NULL)),
    CONSTRAINT bezugsgroesse_geltung_art_chk
        CHECK (coalesce(bezugsdaten_wort('geltung_art', geltung_art), false)),
    -- E1: genau EIN Objekt, und es ist das der Art.
    CONSTRAINT bezugsgroesse_geltung_objekt_chk CHECK (coalesce(
        num_nonnulls(unternehmen_id, standort_id, ort_id, messstelle_id) = 1
        AND CASE geltung_art
              WHEN 'unternehmen' THEN unternehmen_id IS NOT NULL
              WHEN 'standort'    THEN standort_id IS NOT NULL
              WHEN 'gebaeude'    THEN ort_id IS NOT NULL
              WHEN 'bereich'     THEN ort_id IS NOT NULL
              WHEN 'messstelle'  THEN messstelle_id IS NOT NULL
              ELSE false
            END, false))
);
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_unternehmen ON bezugsgroesse (unternehmen_id)
    WHERE unternehmen_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_standort ON bezugsgroesse (standort_id)
    WHERE standort_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_ort ON bezugsgroesse (ort_id)
    WHERE ort_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_messstelle ON bezugsgroesse (messstelle_id)
    WHERE messstelle_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- bezugsgroesse_kennzeichen_verlauf: JEDES Kennzeichen, das eine Bezugsgröße je
-- trug (M2, Muster messstelle_kennzeichen aus V20260911140000). `UNIQUE
-- (tenant_id, kennzeichen)` an bezugsgroesse sieht nur das HEUTIGE; der
-- Primärschlüssel hier verbietet die Weitergabe eines FRÜHEREN — ein Bericht
-- aus der Zeit vor der Umbenennung nennt es. Geschrieben nur vom Trigger
-- bezugsgroesse_kennzeichen_belegen; nie geändert, gelöscht nur vom Offboarding.
--
-- Die automatische Vergabe „BZ-0001, BZ-0002 …" (IP-5) braucht darum keinen
-- eigenen Zähler: die nächste Nummer folgt auf die höchste, die HIER je belegt
-- wurde — eine umbenannte Nummer wird so nie wieder vergeben.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bezugsgroesse_kennzeichen_verlauf (
    tenant_id         UUID        NOT NULL,
    kennzeichen       TEXT        NOT NULL,
    bezugsgroesse_id  UUID        NOT NULL,
    belegt_am         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsgroesse_kennzeichen_belegt PRIMARY KEY (tenant_id, kennzeichen),
    CONSTRAINT bezugsgroesse_kennzeichen_verlauf_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_kennzeichen_verlauf_bezugsgroesse_fk
        FOREIGN KEY (bezugsgroesse_id, tenant_id)
        REFERENCES bezugsgroesse (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_kennzeichen_verlauf_format
        CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$')
);
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_kennzeichen_verlauf_bezugsgroesse
    ON bezugsgroesse_kennzeichen_verlauf (bezugsgroesse_id);

-- -----------------------------------------------------------------------------
-- bezugsgroesse_wert: die Werte als FASSUNGEN (§4.5, §6.1) — append-only.
--
-- Der Schlüssel eines Werts ist Bezugsgröße + Periode (Periodenwert) bzw.
-- Bezugsgröße + Zeitpunkt (Stand); je Schlüssel zählen die Fassungen lückenlos
-- 1, 2, 3 … (Trigger bezugsgroesse_wert_fassung_folgt). Fassung 1 ist der
-- Erstwert (F1); jede weitere ist eine Berichtigung, eine Rücknahme oder — nach
-- einer Rücknahme — ein neuer Erstwert (Vertrag B14: der spätere Import derselben
-- Datei wird Fassung 3). Der wirksame Stand ist eine ABLEITUNG über die
-- Fassungen („wirksam bis Fassung 2" im Vertrag) und wird nie gespeichert.
--
-- `status` ist das Wort der Fassung, als sie entstand: `wirksam`, `vorschlag`
-- (Vier-Augen an, F3), `zurueckgenommen` (Rücknahme ohne Betrag, E11),
-- `abgelehnt`. Eine Fassung wird nie „wirksam gemacht" — eine Entscheidung ist
-- wieder eine neue Zeile.
--
-- Wertart `stammdatum` hat hier keine Werte: ein Stammdatum kennt Gültigkeiten,
-- keine Fassungen je Periode (§4.3 S1, Tabelle bezugsgroesse_stammdatum in
-- IP-6). Herkunft `stammdatum_ap02` wird nie gespeichert: die Bezugsfläche wird
-- aus der Ortsstruktur GELESEN (E17, M4).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bezugsgroesse_wert (
    id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID          NOT NULL,
    bezugsgroesse_id  UUID          NOT NULL,
    -- Die Bedeutung des Betrags, kopiert und per Verweis gebunden (siehe Kopf).
    wertart           TEXT          NOT NULL,
    einheit           TEXT          NOT NULL,
    periode_art       TEXT,
    -- Periodenwert: die Periode als Tage, `periode_bis` = letzter Tag einschließlich.
    periode_von       DATE,
    periode_bis       DATE,
    -- Stand: der Zeitpunkt auf die volle Minute.
    zeitpunkt         TIMESTAMPTZ,
    -- Die Zone, in der die Tage bzw. der Kalendermonat gelten (Z1, E7).
    zeitzone          TEXT          NOT NULL,
    fassung           INTEGER       NOT NULL,
    ersetzt_fassung   INTEGER,
    vorgang           TEXT          NOT NULL,
    status            TEXT          NOT NULL,
    -- In der Einheit der Bezugsgröße (U1); NULL nur bei einer Rücknahme (E11).
    betrag            NUMERIC(18, 6),
    begruendung       TEXT,
    herkunft_art      TEXT          NOT NULL,
    -- Import: Kennung I-JJJJ-NNNN, Zeile, gelieferter Text und Einheit (C5, U1).
    import_kennung    TEXT,
    import_zeile      INTEGER,
    geliefert_text    TEXT,
    geliefert_einheit TEXT,
    -- Kennzeichen als Klartext-Sätze („umgerechnet aus 312,4 t", „gilt für
    -- Oktober 2026"), Wortlaut und Reihenfolge wie im Vertrag.
    kennzeichen       JSONB         NOT NULL DEFAULT '[]'::jsonb,
    -- Der Urheber im Akteur-Vokabular von AP-03 (wie messstelle_aenderung).
    actor_sub         TEXT,
    actor_name        TEXT          NOT NULL,
    actor_rolle       TEXT,
    actor_art         TEXT          NOT NULL,
    -- F3: die ZWEITE Person bei Vier-Augen — nie der Urheber.
    freigeber_sub     TEXT,
    freigeber_name    TEXT,
    freigeber_rolle   TEXT,
    freigeber_art     TEXT,
    -- Die Erfassungszeit der Cloud; die App-Rolle kann sie nicht setzen (Rechte).
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT bezugsgroesse_wert_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_wert_bedeutung_fk FOREIGN KEY (bezugsgroesse_id, tenant_id, wertart, einheit)
        REFERENCES bezugsgroesse (id, tenant_id, wertart, einheit) ON DELETE RESTRICT,
    -- MATCH SIMPLE: greift genau bei einem Periodenwert (periode_art gesetzt);
    -- beim Stand sagt bezugsgroesse_periode_je_wertart_chk, dass die
    -- Bezugsgröße keine Periode hat.
    CONSTRAINT bezugsgroesse_wert_periode_fk FOREIGN KEY (bezugsgroesse_id, tenant_id, periode_art)
        REFERENCES bezugsgroesse (id, tenant_id, periode_art) ON DELETE RESTRICT,
    -- Je Schlüssel jede Fassung genau einmal (NULL kollidiert nie: ein
    -- Periodenwert fällt nur unter den ersten, ein Stand nur unter den zweiten).
    CONSTRAINT bezugsgroesse_wert_periode_fassung_uq
        UNIQUE (tenant_id, bezugsgroesse_id, periode_von, fassung),
    CONSTRAINT bezugsgroesse_wert_zeitpunkt_fassung_uq
        UNIQUE (tenant_id, bezugsgroesse_id, zeitpunkt, fassung),
    -- Die Vokabulare des Vertrags.
    CONSTRAINT bezugsgroesse_wert_wertart_chk CHECK (coalesce(bezugsdaten_wort('wertart', wertart), false)),
    CONSTRAINT bezugsgroesse_wert_einheit_chk CHECK (coalesce(bezugsdaten_wort('einheiten', einheit), false)),
    CONSTRAINT bezugsgroesse_wert_periode_art_chk
        CHECK (periode_art IS NULL OR coalesce(bezugsdaten_wort('periode_art', periode_art), false)),
    CONSTRAINT bezugsgroesse_wert_vorgang_chk CHECK (coalesce(bezugsdaten_wort('vorgang', vorgang), false)),
    CONSTRAINT bezugsgroesse_wert_status_chk CHECK (coalesce(bezugsdaten_wort('status', status), false)),
    CONSTRAINT bezugsgroesse_wert_herkunft_art_chk
        CHECK (coalesce(bezugsdaten_wort('herkunft_art', herkunft_art), false)),
    -- E17/M4 (siehe Tabellenkopf): die Bezugsfläche wird gelesen, nie gespeichert.
    CONSTRAINT bezugsgroesse_wert_herkunft_gespeichert_chk CHECK (herkunft_art <> 'stammdatum_ap02'),
    -- Die Form je Wertart; ein Stammdatum hat hier keine (S1, siehe Tabellenkopf).
    CONSTRAINT bezugsgroesse_wert_form_chk CHECK (coalesce(
        CASE wertart
          WHEN 'periodenwert' THEN periode_art IS NOT NULL AND periode_von IS NOT NULL
                                   AND periode_bis IS NOT NULL AND zeitpunkt IS NULL
          WHEN 'stand'        THEN periode_art IS NULL AND periode_von IS NULL
                                   AND periode_bis IS NULL AND zeitpunkt IS NOT NULL
          ELSE false
        END, false)),
    -- Z2: genau EINE Kalenderperiode ihrer Art — nie ein Teil, nie zwei (Woche ab Montag).
    CONSTRAINT bezugsgroesse_wert_genau_eine_periode_chk CHECK (periode_art IS NULL OR coalesce(
        CASE periode_art
          WHEN 'tag'   THEN periode_bis = periode_von
          WHEN 'woche' THEN extract(isodow FROM periode_von) = 1 AND periode_bis = periode_von + 6
          WHEN 'monat' THEN extract(day FROM periode_von) = 1
                            AND periode_bis = (periode_von + INTERVAL '1 month')::date - 1
          WHEN 'jahr'  THEN extract(month FROM periode_von) = 1 AND extract(day FROM periode_von) = 1
                            AND periode_bis = (periode_von + INTERVAL '1 year')::date - 1
          ELSE false
        END, false)),
    CONSTRAINT bezugsgroesse_wert_volle_minute
        CHECK (zeitpunkt IS NULL
               OR date_trunc('minute', zeitpunkt AT TIME ZONE 'UTC') = zeitpunkt AT TIME ZONE 'UTC'),
    CONSTRAINT bezugsgroesse_wert_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')),
    -- E16 / Z4: nur abgeschlossene Perioden — das Ende der Periode (Mitternacht
    -- nach ihrem letzten Tag in IHRER Zone) liegt nicht nach der Erfassung; ein
    -- Stand liegt nicht in der Zukunft.
    CONSTRAINT bezugsgroesse_wert_abgeschlossen_chk CHECK (coalesce(
        CASE
          WHEN periode_bis IS NOT NULL THEN ((periode_bis + 1)::timestamp AT TIME ZONE zeitzone) <= created_at
          ELSE zeitpunkt <= created_at
        END, false)),
    -- F1/F2: Fassung 1 ist ein Erstwert ohne Vorfassung; jede weitere ersetzt eine frühere.
    CONSTRAINT bezugsgroesse_wert_fassung_chk CHECK (coalesce(
        (fassung = 1 AND ersetzt_fassung IS NULL AND vorgang = 'erstwert')
        OR (fassung > 1 AND ersetzt_fassung BETWEEN 1 AND fassung - 1), false)),
    -- F1: ein Erstwert braucht keine Freigabe — er ist sofort wirksam.
    CONSTRAINT bezugsgroesse_wert_erstwert_chk CHECK (vorgang <> 'erstwert' OR status = 'wirksam'),
    -- E11: ohne Betrag nur eine Rücknahme; `zurueckgenommen` ist immer eine
    -- Rücknahme ohne Betrag (die Rücknahme einer Berichtigung trägt den Betrag der
    -- Vorfassung und ist `wirksam`, Vertrag B14).
    CONSTRAINT bezugsgroesse_wert_betrag_chk CHECK (coalesce(
        (betrag IS NOT NULL OR vorgang = 'ruecknahme')
        AND (status <> 'zurueckgenommen' OR (vorgang = 'ruecknahme' AND betrag IS NULL)), false)),
    -- U6: eine wirksame Menge ist nie negativ (was nie wirkt, sieht keine Kennzahl).
    CONSTRAINT bezugsgroesse_wert_betrag_nicht_negativ
        CHECK (betrag IS NULL OR betrag >= 0 OR status IN ('vorschlag', 'abgelehnt')),
    -- F2/C7: Berichtigung und Rücknahme brauchen eine Begründung nach dem Vertrag.
    CONSTRAINT bezugsgroesse_wert_begruendung_chk CHECK (coalesce(
        (vorgang = 'erstwert' OR begruendung IS NOT NULL)
        AND (begruendung IS NULL OR bezugsdaten_begruendung_gueltig(begruendung)), false)),
    -- Invariante 7: ein Import-Wert nennt seinen Import; nur er.
    CONSTRAINT bezugsgroesse_wert_import_chk CHECK (coalesce(
        (herkunft_art = 'import') = (import_kennung IS NOT NULL)
        AND (import_kennung IS NULL OR import_kennung ~ '^I-[0-9]{4}-[0-9]{4,}$')
        AND (import_zeile IS NULL OR (herkunft_art = 'import' AND import_zeile >= 1)), false)),
    CONSTRAINT bezugsgroesse_wert_kennzeichen_chk CHECK (jsonb_typeof(kennzeichen) = 'array'),
    CONSTRAINT bezugsgroesse_wert_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bezugsgroesse_wert_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bezugsgroesse_wert_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    -- Ein Freigeber ist eine Person (Sub, Name, Art) aus demselben Vokabular —
    -- und nie der Urheber derselben Fassung (F3, Vertrag „ersteller_gleich_freigeber").
    CONSTRAINT bezugsgroesse_wert_freigeber_chk CHECK (coalesce(
        (freigeber_sub IS NULL AND freigeber_name IS NULL AND freigeber_rolle IS NULL
         AND freigeber_art IS NULL)
        OR (freigeber_sub <> '' AND btrim(freigeber_name) <> ''
            AND freigeber_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND (freigeber_rolle IS NULL OR freigeber_rolle IN ('kundenadministrator', 'energiemanager',
                 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb'))
            AND freigeber_sub IS DISTINCT FROM actor_sub), false))
);
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_wert_bezugsgroesse
    ON bezugsgroesse_wert (bezugsgroesse_id, periode_von, zeitpunkt, fassung);

-- -----------------------------------------------------------------------------
-- bezugsgroesse_aenderung: das Änderungsprotokoll der Bezugsgröße (§6.1 „wie
-- messstelle_aenderung"). Die Spalten folgen der NEUEREN Form der Journale
-- (messstelle_aenderung, data_source_aenderung, quelle_kadenz …: Urheber
-- `actor_sub/name/rolle/art`) — nicht `akteur_*` von ort_aenderung, damit die
-- Vereinheitlichung (AP-03 IP-7) eine Stelle weniger hat.
--
-- `art`: angelegt · bearbeitet (alt/neu tragen NUR die geänderten Felder) ·
-- archiviert. Kanalbindung (IP-17) und Vorlagen (IP-14) weiten den CHECK, indem
-- sie DIESEN Stand abschreiben. Die Werte haben kein Protokoll hier: jede
-- Fassung trägt Urheber, Zeit und Begründung selbst.
--
-- Kein Verweis auf die Bezugsgröße (ein Protokoll überlebt ihr Objekt), aber auf
-- den Mandanten: nur das Offboarding räumt es ab — darum lehnt der Trigger nur
-- UPDATE ab, und DELETE hat nur die Verwaltungsrolle (Muster messreihe_ereignis).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bezugsgroesse_aenderung (
    id                BIGSERIAL   PRIMARY KEY,
    tenant_id         UUID        NOT NULL,
    bezugsgroesse_id  UUID        NOT NULL,
    art               TEXT        NOT NULL,
    alt               JSONB,
    neu               JSONB,
    gilt_ab           TIMESTAMPTZ NOT NULL,
    rueckwirkend      BOOLEAN     NOT NULL,
    grund             TEXT,
    actor_sub         TEXT,
    actor_name        TEXT        NOT NULL,
    actor_rolle       TEXT,
    actor_art         TEXT        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsgroesse_aenderung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT bezugsgroesse_aenderung_art_chk CHECK (art IN ('angelegt', 'bearbeitet', 'archiviert')),
    CONSTRAINT bezugsgroesse_aenderung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT bezugsgroesse_aenderung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT bezugsgroesse_aenderung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT bezugsgroesse_aenderung_rueckwirkend_chk CHECK (NOT rueckwirkend OR gilt_ab < created_at)
);
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_aenderung_bezugsgroesse
    ON bezugsgroesse_aenderung (bezugsgroesse_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_bezugsgroesse_aenderung_gilt_ab
    ON bezugsgroesse_aenderung (tenant_id, gilt_ab);

-- -----------------------------------------------------------------------------
-- Die Trigger
-- -----------------------------------------------------------------------------

-- ⚠ Ein Wert wird nie überschrieben (siehe Kopf) — JEDES UPDATE, von jeder Rolle.
CREATE OR REPLACE FUNCTION bezugsgroesse_wert_nie_ueberschrieben() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ein Wert der Bezugsgröße wird nie überschrieben: Fassung % bleibt, eine Berichtigung ist eine neue Fassung', OLD.fassung
    USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_wert_append_only';
END $$;
DROP TRIGGER IF EXISTS bezugsgroesse_wert_append_only ON bezugsgroesse_wert;
CREATE TRIGGER bezugsgroesse_wert_append_only BEFORE UPDATE ON bezugsgroesse_wert
    FOR EACH ROW EXECUTE FUNCTION bezugsgroesse_wert_nie_ueberschrieben();

-- Die Fassungen eines Schlüssels zählen lückenlos: die neue ist die nächste.
-- Zwei gleichzeitige Fassungen mit derselben Nummer scheitern am Unique-Schlüssel.
CREATE OR REPLACE FUNCTION bezugsgroesse_wert_fassung_folgt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  hoechste INTEGER;
BEGIN
  SELECT max(w.fassung) INTO hoechste FROM bezugsgroesse_wert w
   WHERE w.tenant_id = NEW.tenant_id AND w.bezugsgroesse_id = NEW.bezugsgroesse_id
     AND w.periode_von IS NOT DISTINCT FROM NEW.periode_von
     AND w.zeitpunkt IS NOT DISTINCT FROM NEW.zeitpunkt;
  IF NEW.fassung <> coalesce(hoechste, 0) + 1 THEN
    RAISE EXCEPTION 'Fassung % folgt nicht auf Fassung %', NEW.fassung, coalesce(hoechste, 0)
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_wert_fassung_lueckenlos';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bezugsgroesse_wert_fassung_folgt ON bezugsgroesse_wert;
CREATE TRIGGER bezugsgroesse_wert_fassung_folgt BEFORE INSERT ON bezugsgroesse_wert
    FOR EACH ROW EXECUTE FUNCTION bezugsgroesse_wert_fassung_folgt();

-- M1: der Mandant und die Kennung nie; der Geltungsbereich nur, solange die
-- Bezugsgröße keinen Wert hat. (Wertart, Einheit und Periodenart hält der
-- Verweis jeder Wert-Zeile fest, siehe Kopf; zur Gleichzeitigkeit siehe
-- bezugsgroesse_geltung_uq.)
CREATE OR REPLACE FUNCTION bezugsgroesse_identitaet_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'Kennung und Mandant der Bezugsgröße % sind nie änderbar', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_identitaet_unveraenderlich';
  END IF;
  IF (NEW.geltung_art, NEW.unternehmen_id, NEW.standort_id, NEW.ort_id, NEW.messstelle_id)
       IS DISTINCT FROM (OLD.geltung_art, OLD.unternehmen_id, OLD.standort_id, OLD.ort_id, OLD.messstelle_id)
     AND EXISTS (SELECT 1 FROM bezugsgroesse_wert w
                  WHERE w.bezugsgroesse_id = OLD.id AND w.tenant_id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'Der Geltungsbereich der Bezugsgröße % hat Werte und ist nicht mehr änderbar', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_geltung_nach_erstem_wert';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bezugsgroesse_identitaet_bleibt ON bezugsgroesse;
CREATE TRIGGER bezugsgroesse_identitaet_bleibt BEFORE UPDATE ON bezugsgroesse
    FOR EACH ROW EXECUTE FUNCTION bezugsgroesse_identitaet_bleibt();

-- Jede Vergabe und jede Umbenennung belegt das Kennzeichen (Muster
-- messstelle_kennzeichen_belegen). SECURITY DEFINER, weil die App-Rolle den
-- Verlauf nur lesen darf; der Mandant ist NEW.tenant_id, den das WITH CHECK von
-- bezugsgroesse bereits geprüft hat. Trägt oder trug eine ANDERE Bezugsgröße das
-- Kennzeichen, scheitert das INSERT am Primärschlüssel
-- bezugsgroesse_kennzeichen_belegt (23505) — nie eine stille Weitergabe.
CREATE OR REPLACE FUNCTION bezugsgroesse_kennzeichen_belegen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kennzeichen = OLD.kennzeichen THEN
    RETURN NULL;
  END IF;
  -- Die Bezugsgröße darf zu ihrem EIGENEN früheren Kennzeichen zurück.
  PERFORM 1 FROM public.bezugsgroesse_kennzeichen_verlauf
    WHERE tenant_id = NEW.tenant_id AND kennzeichen = NEW.kennzeichen
      AND bezugsgroesse_id = NEW.id;
  IF NOT FOUND THEN
    INSERT INTO public.bezugsgroesse_kennzeichen_verlauf (tenant_id, kennzeichen, bezugsgroesse_id)
    VALUES (NEW.tenant_id, NEW.kennzeichen, NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION bezugsgroesse_kennzeichen_belegen() FROM PUBLIC;
DROP TRIGGER IF EXISTS bezugsgroesse_kennzeichen_belegen ON bezugsgroesse;
CREATE TRIGGER bezugsgroesse_kennzeichen_belegen AFTER INSERT OR UPDATE OF kennzeichen ON bezugsgroesse
    FOR EACH ROW EXECUTE FUNCTION bezugsgroesse_kennzeichen_belegen();

-- Belegung und Protokoll: nie geändert. DELETE bleibt dem Offboarding (Rechte).
DROP TRIGGER IF EXISTS bezugsgroesse_kennzeichen_verlauf_append_only ON bezugsgroesse_kennzeichen_verlauf;
CREATE TRIGGER bezugsgroesse_kennzeichen_verlauf_append_only BEFORE UPDATE ON bezugsgroesse_kennzeichen_verlauf
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
DROP TRIGGER IF EXISTS bezugsgroesse_aenderung_append_only ON bezugsgroesse_aenderung;
CREATE TRIGGER bezugsgroesse_aenderung_append_only BEFORE UPDATE ON bezugsgroesse_aenderung
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE bezugsgroesse ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsgroesse FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bezugsgroesse_tenant_isolation ON bezugsgroesse;
CREATE POLICY bezugsgroesse_tenant_isolation ON bezugsgroesse
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bezugsgroesse_kennzeichen_verlauf ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsgroesse_kennzeichen_verlauf FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bezugsgroesse_kennzeichen_verlauf_tenant_isolation ON bezugsgroesse_kennzeichen_verlauf;
CREATE POLICY bezugsgroesse_kennzeichen_verlauf_tenant_isolation ON bezugsgroesse_kennzeichen_verlauf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bezugsgroesse_wert ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsgroesse_wert FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bezugsgroesse_wert_tenant_isolation ON bezugsgroesse_wert;
CREATE POLICY bezugsgroesse_wert_tenant_isolation ON bezugsgroesse_wert
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE bezugsgroesse_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsgroesse_aenderung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bezugsgroesse_aenderung_tenant_isolation ON bezugsgroesse_aenderung;
CREATE POLICY bezugsgroesse_aenderung_tenant_isolation ON bezugsgroesse_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben. Die BYPASSRLS-Rolle
-- voltpilot_admin liest und löscht nur (das Offboarding); kein Hintergrund-Lauf
-- schreibt heute Bezugsdaten.
-- -----------------------------------------------------------------------------
REVOKE ALL ON bezugsgroesse, bezugsgroesse_kennzeichen_verlauf, bezugsgroesse_wert,
    bezugsgroesse_aenderung FROM ${appDbUser}, ${adminDbUser};

-- Eine Bezugsgröße wird archiviert, nie gelöscht (M6). Änderbar sind Name und
-- Kennzeichen immer, die Bedeutung nur bis zum ersten Wert (M1, siehe Kopf) —
-- Kennung, Mandant und Anlagezeit nie.
GRANT SELECT, INSERT ON bezugsgroesse TO ${appDbUser};
GRANT UPDATE (kennzeichen, name, wertart, einheit, periode_art, geltung_art, unternehmen_id,
              standort_id, ort_id, messstelle_id, archiviert_am, updated_at)
    ON bezugsgroesse TO ${appDbUser};
-- Die Belegung schreibt nur der Trigger.
GRANT SELECT ON bezugsgroesse_kennzeichen_verlauf TO ${appDbUser};
-- Werte: lesen und anhängen — nie ändern, nie löschen. Die Erfassungszeit setzt
-- die Datenbank (`created_at` fehlt in der Spaltenliste).
GRANT SELECT ON bezugsgroesse_wert TO ${appDbUser};
GRANT INSERT (id, tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, periode_von, periode_bis,
              zeitpunkt, zeitzone, fassung, ersetzt_fassung, vorgang, status, betrag, begruendung,
              herkunft_art, import_kennung, import_zeile, geliefert_text, geliefert_einheit, kennzeichen,
              actor_sub, actor_name, actor_rolle, actor_art,
              freigeber_sub, freigeber_name, freigeber_rolle, freigeber_art)
    ON bezugsgroesse_wert TO ${appDbUser};
-- Das Protokoll: lesen und anhängen.
GRANT SELECT, INSERT ON bezugsgroesse_aenderung TO ${appDbUser};

-- Das Offboarding (TenantRepository.offboard) räumt alle vier ab, Kinder zuerst.
GRANT SELECT, DELETE ON bezugsgroesse, bezugsgroesse_kennzeichen_verlauf, bezugsgroesse_wert,
    bezugsgroesse_aenderung TO ${adminDbUser};

-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Recht (die rollout_event-Falle):
-- ALTER DEFAULT PRIVILEGES deckt Tabellen ab, Sequenzen nicht.
GRANT USAGE, SELECT ON SEQUENCE bezugsgroesse_aenderung_id_seq TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE bezugsgroesse_aenderung_id_seq TO ${adminDbUser};

COMMENT ON FUNCTION bezugsdaten_vokabular() IS
    'Die Vokabulare von docs/contracts/v2/bezugsdaten-vectors.json (vokabulare.* und einheiten), '
    'Zeile fuer Zeile; die EINE Stelle, die jeder Vokabular-CHECK der Bezugsgroessen fragt.';
COMMENT ON TABLE bezugsgroesse IS
    'UEMS AP-09: Bezugsgroesse mit Wertart, Einheit, Periode und genau einem Geltungsbereich (E1).';
COMMENT ON TABLE bezugsgroesse_kennzeichen_verlauf IS
    'UEMS AP-09: jedes je getragene Kennzeichen einer Bezugsgroesse; nie weitergegeben (M2).';
COMMENT ON TABLE bezugsgroesse_wert IS
    'UEMS AP-09: Werte als Fassungen, append-only per Trigger; eine Berichtigung ist eine neue Fassung (E6).';
COMMENT ON TABLE bezugsgroesse_aenderung IS
    'UEMS AP-09: Aenderungsprotokoll der Bezugsgroesse (actor_*), append-only; nur das Offboarding loescht.';
