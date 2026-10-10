-- =============================================================================
-- UEMS AP-11 IP-4: die KENNZAHL als Tabellen — Berechnung in tagesgültigen
-- FASSUNGEN, Werte in VERSIONEN, die nie überschrieben und nie gelöscht werden
-- (Konzept vp-uems-ap11-kennzahlen §4.2, §4.9, §6.1, §8 IP-4; Captain-Entscheide
-- E1 = A und E7 = A vom 14.09.2026). Maßgeblich ist der Vertrag
-- docs/contracts/v2/kennzahl.md + kennzahl-vectors.json mit dem Modul
-- uems/KennzahlRegeln — jede Regel hier sagt DASSELBE wie dort;
-- UemsKennzahlMigrationTest liest die Vektor-Datei und spielt sie gegen die
-- Datenbank.
--
-- Sieben mandantengebundene Tabellen, rein additiv (keine bestehende Tabelle,
-- kein Vertrag, keine Route, kein Lauf und keine Box wird berührt):
--
--   kennzahl                      Kennzeichen (KZ-…), Name, Rechenform, GENAU EIN
--                                 Geltungsbereich, Verantwortlicher, Zweck (E1)
--   kennzahl_kennzeichen_verlauf  JEDES Kennzeichen, das eine Kennzahl je trug
--   kennzahl_fassung              die Berechnung als tagesgültige Fassung —
--                                 zeilengleich zu messstelle_formel_fassung,
--                                 plus komplement, faktor, einheit (E7)
--   kennzahl_eingang              die Eingänge einer Fassung: genau EIN Verweis,
--                                 nie die eigene Kennzahl
--   kennzahl_wert                 der Wert je Periode, APPEND-ONLY
--   kennzahl_wert_eingang         was der Wert von jedem Eingang las, APPEND-ONLY
--   kennzahl_aenderung            das Protokoll der Kennzahl
--
-- ⚠ FASSUNG UND VERSION SIND ZWEI ACHSEN (E7, Invariante 6). Die Fassung sagt, WAS
-- an einem Tag gerechnet wird (Muster V20260912210000: Tage `[]`, Fassung 1 ohne
-- ersten Tag „gilt seit Beginn", n + 1 beendet n am Vortag, nur verkürzt oder
-- aufgehoben, nie umgeschrieben). Die Version zählt die Neubildung eines
-- ENDGÜLTIGEN Werts (Q7); ein vorläufiger Wert zieht OHNE neue Version nach (V3).
--
-- ⚠ EIN KENNZAHL-WERT WIRD NIE ÜBERSCHRIEBEN UND NIE GELÖSCHT — auch nicht von der
-- Verwaltungsrolle (§6.1, IP-4). Anders als messreihe_periode_version kennt die
-- Tabelle kein UPDATE für das Nachziehen: eine vorläufige Version zieht als
-- WEITERE ZEILE derselben Nummer nach; die neueste Zeile (höchste Version, dann
-- jüngstes `berechnet_am`) ist der aktuelle Wert. Der Trigger
-- kennzahl_wert_append_only lehnt JEDES UPDATE und JEDES DELETE ab, von jeder
-- Rolle; die Rechte nehmen sie zusätzlich weg. Der EINE Ausgang ist das Offboarding
-- über uems_kennzahlwerte_des_kundenbereichs_entfernen() (Muster
-- uems_messwerte_des_kundenbereichs_entfernen, V20260913150000): die Funktion
-- öffnet für GENAU ihren Kundenbereich und nur in ihrem Aufruf eine Kennzeichnung
-- (`uems.kennzahlwerte_entfernen`), die der Trigger erkennt, und schließt sie
-- wieder. Die Kennzeichnung ist keine Sicherheitsgrenze — die sind die Rechte —,
-- sondern der ausdrücklich benannte Weg.
--
-- DIE VERSIONSFOLGE IN DER DATENBANK (Q7/V3, zeitlose Hälfte; Trigger
-- kennzahl_wert_version_folgt, gespielt gegen jede Regel `wert` der Vektoren):
--   * ohne frühere Zeile oder nur Zeilen ohne Version: keine Version (ohne Zahl,
--     „ohne Zahl noch keine Version", K8) oder Version 1 MIT Zahl;
--   * neueste Zeile vorläufig (Version n): nur Version n, derselbe Anlass —
--     nachziehen, auch zu „keine Werte" oder zu endgültig;
--   * neueste Zeile endgültig (Version n): nur Version n + 1 (K6, K7, K17, K19).
-- Eine endgültige Version ist genau EINE Zeile (uq_kennzahl_wert_endgueltig). Wer
-- neu bildet, sperrt die Kennzahl (IP-6); der Index ist die Wand dahinter.
--
-- DIE VOKABULARE KOMMEN AUS DEM VERTRAG. kennzahl_vokabular() ist die EINE Stelle
-- in der Datenbank, an der sie stehen — Zeile für Zeile die Listen
-- `vokabulare.rechenform|eingang_art|eingang_rolle|periode_art|geltung_art|
-- zustand|richtung_unsicherheit|grund_ohne_zahl|protokoll` der Vektor-Datei, in
-- ihrer Reihenfolge. JEDER CHECK auf ein Wort dieser Vokabulare fragt sie über
-- kennzahl_wort(); keiner trägt eine eigene Wortliste. `rechenform_vorgesehen`
-- (produkt), `fehler`, `sichtbarkeit`, `ereignisse_reserviert` und `rechte` sind
-- Wörter von Antworten und Rechten, keine Spalte — der Test verlangt für jeden
-- Block des Vertrags diese Entscheidung.
--
-- ⚠ DAS PROTOKOLL SPRICHT DEN VERTRAG, NICHT DIE KONZEPT-TABELLE. §6.1 nannte
-- `angelegt · fassung_eingetragen · geaendert · archiviert · wiederhergestellt`;
-- der Vertrag (PR 774) führt `kennzahl_fassung_eingetragen · kennzahl_geaendert ·
-- kennzahl_archiviert`. Die Tabelle nimmt die drei Wörter des Vertrags: das
-- Anlegen trägt Fassung 1 ein (`kennzahl_fassung_eingetragen`), ein
-- Wiederherstellen ändert die Kennzahl (`kennzahl_geaendert`). Braucht ein
-- Schreibweg ein weiteres Wort, weitet er ZUERST den Vertrag; eine neue Migration
-- ersetzt dann nur die Funktion (der Test druckt den VALUES-Block).
--
-- WÖRTER OHNE VOKABULAR-BLOCK — Literale, jedes mit seiner Quelle:
--   * kennzahl_fassung.herkunft `anlage · eintrag · kopie` (§4.9 V1; die
--     Formel-Fassung spricht `bestand · anlage · eintrag` ebenso als Literal —
--     eine Kennzahl hat keinen Bestand);
--   * kennzahl_wert.zustand `vorlaeufig · endgueltig` (AP-07 E5, wie jede
--     Periodentabelle);
--   * kennzahl_wert.anlass_art `eingang · definition` — die Wörter von
--     `anlass.art` der Regel `wert` (KennzahlRegeln.Anlass); der Test sammelt sie
--     aus den Vektoren und vergleicht sie mit dem CHECK;
--   * Urheber-Art/-Rolle (AP-03, wie messstelle_formel_fassung), Zeitzonen (wie
--     bezugsgroesse_wert).
--
-- ZEITFORMEN (nicht neu erfunden):
--   * Fassung: `gueltig_ab`/`gueltig_bis` als TAGE, `bis` = letzter Tag
--     einschließlich (daterange '[]', Muster Formel-Fassung).
--   * Wert: `periode_von`/`periode_bis` als TAGE, genau EINE Kalenderperiode ihrer
--     Art (Tag · Woche ab Montag · Monat · Jahr), die Zone je Zeile in `zeitzone`
--     (Muster bezugsgroesse_wert; P5 Zeitzone des Standorts). Eine laufende
--     Periode hat einen vorläufigen Wert (K21) — darum KEIN „abgeschlossen"-CHECK.
--
-- WAS DIE DATENBANK NICHT PRÜFT (Regeln der Schreibwege IP-5/IP-6 — sie brauchen
-- den Verlauf, den Eintragstag, den Standort oder die Eingänge): Kreis über
-- Kennzahlen (K16 `formel_zyklus`, MessstelleFormelRegeln.zyklus — die Datenbank
-- verbietet nur den Selbstverweis), „nach der jüngsten beginnen" und
-- „rückwirkend" (fassungEintrag), Perioden-Passung (P1–P3), Einheiten (U1–U3,
-- auch ob ein Anteil zwei Werte derselben Größe hat), Anzahl der Eingänge je Form,
-- Geltung der Eingänge (G3), Rechte (AP-03 IP-11).
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (ein Fremdschlüssel prüft ohne RLS);
-- `tenant_id` steht VORN in jedem Unique-, Exklusions- und Primärschlüssel. Jeder
-- Verweis ist ON DELETE RESTRICT — auf `tenant` und auf jedes gelesene Objekt: eine
-- Bezugsgröße, Messstelle oder Kennzahl, die ein Eingang liest, wird nicht
-- gelöscht (B2: archiviert bleibt sie Eingang), ein Ort, Prozess, Standort oder
-- Unternehmen mit einer Kennzahl ebenso nicht. TenantRepository.offboard räumt
-- alle sieben ausdrücklich ab, Kinder zuerst.
--
-- Kein FK auf einen Benutzer: der Verantwortliche ist ein Akteur-Schnappschuss
-- (`verantwortlich_sub/_name`), bis AP-03 IP-2 den Spiegel baut (dann additiv).
--
-- Nicht dieses Paket: Routen und Lesemodell (IP-5), Rechenlauf und Ereignis
-- `kennzahl_neu_gebildet` (IP-6), Werte lesen (IP-7), Kaskade (IP-8/IP-9),
-- Vorlagen (IP-10), Portal (IP-13 ff.).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Die Vokabulare des Vertrags (siehe Kopf). `nr` ist die Stelle im Vertrag.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kennzahl_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('rechenform', 1, 'quotient'),
    ('rechenform', 2, 'anteil'),
    ('rechenform', 3, 'zusammenfassung'),
    ('eingang_art', 1, 'messstelle'),
    ('eingang_art', 2, 'bezugsgroesse'),
    ('eingang_art', 3, 'kennzahl'),
    ('eingang_rolle', 1, 'zaehler'),
    ('eingang_rolle', 2, 'nenner'),
    ('eingang_rolle', 3, 'paar'),
    ('periode_art', 1, 'tag'),
    ('periode_art', 2, 'woche'),
    ('periode_art', 3, 'monat'),
    ('periode_art', 4, 'jahr'),
    ('geltung_art', 1, 'unternehmen'),
    ('geltung_art', 2, 'standort'),
    ('geltung_art', 3, 'gebaeude'),
    ('geltung_art', 4, 'bereich'),
    ('geltung_art', 5, 'prozess'),
    ('geltung_art', 6, 'kostenstelle'),
    ('geltung_art', 7, 'messstelle'),
    ('zustand', 1, 'vollständig'),
    ('zustand', 2, 'unvollständig'),
    ('zustand', 3, 'keine Werte'),
    ('zustand', 4, 'mit Ersatzwert'),
    ('richtung_unsicherheit', 1, 'untergrenze'),
    ('richtung_unsicherheit', 2, 'obergrenze'),
    ('richtung_unsicherheit', 3, 'unbestimmt'),
    ('grund_ohne_zahl', 1, 'nenner_fehlt'),
    ('grund_ohne_zahl', 2, 'nenner_null'),
    ('grund_ohne_zahl', 3, 'zaehler_fehlt'),
    ('grund_ohne_zahl', 4, 'periode_nicht_zu_ende'),
    ('grund_ohne_zahl', 5, 'vor_bestehen'),
    ('grund_ohne_zahl', 6, 'haengt_an_kreis'),
    ('grund_ohne_zahl', 7, 'eingang_archiviert'),
    ('protokoll', 1, 'kennzahl_fassung_eingetragen'),
    ('protokoll', 2, 'kennzahl_geaendert'),
    ('protokoll', 3, 'kennzahl_archiviert')
$$;

-- Steht `p_wort` im Vokabular `p_vokabular`? NULL ist nie ein Wort. (Schema
-- ausgeschrieben: ein CHECK wird auch unter leerem search_path geprüft.)
CREATE OR REPLACE FUNCTION kennzahl_wort(p_vokabular TEXT, p_wort TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM public.kennzahl_vokabular() v
                 WHERE v.vokabular = p_vokabular AND v.wort = p_wort)
$$;

-- -----------------------------------------------------------------------------
-- kennzahl: die Kennzahl selbst (§4.2, §6.1, E1).
--
-- Der Geltungsbereich ist GENAU EINE gesetzte Verweis-Spalte, passend zu
-- `geltung_art` (G1, Muster bezugsgroesse seit V20260913160000): unternehmen →
-- unternehmen_id, standort → standort_id, gebaeude/bereich → ort_id (Art per FK
-- über die berechnete Spalte `ort_art`), prozess → prozess_id, kostenstelle →
-- kostenstelle_id, messstelle → messstelle_id.
--
-- V4: Rechenform und Geltungsbereich sind nach der ersten Fassung FEST (sonst
-- eine neue Kennzahl). Die Rechenform hält der Verweis jeder Fassung fest
-- (kennzahl_fassung_kennzahl_fk über `rechenform`), den Geltungsbereich der
-- Trigger kennzahl_identitaet_bleibt. Name, Kennzeichen, Verantwortlicher und
-- Zweck ändern sich ohne Fassung — mit Protokolleintrag `kennzahl_geaendert`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kennzahl (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    -- Das HEUTIGE Kennzeichen (KZ-0001 …); jedes je getragene steht im Verlauf.
    kennzeichen          TEXT        NOT NULL,
    name                 TEXT        NOT NULL,
    rechenform           TEXT        NOT NULL,
    geltung_art          TEXT        NOT NULL,
    unternehmen_id       UUID,
    standort_id          UUID,
    ort_id               UUID,
    prozess_id           UUID,
    kostenstelle_id      UUID,
    messstelle_id        UUID,
    -- Die Art des Orts, auf den der Verweis zeigt — nur bei Gebäude/Bereich.
    ort_art              TEXT GENERATED ALWAYS AS
        (CASE WHEN geltung_art IN ('gebaeude', 'bereich') THEN geltung_art END) STORED,
    -- Der Verantwortliche als Akteur-Schnappschuss (bis AP-03 IP-2).
    verantwortlich_sub   TEXT,
    verantwortlich_name  TEXT        NOT NULL,
    zweck                TEXT,
    -- NULL = nicht archiviert (V5: Werte bleiben lesbar, kein Rechenlauf mehr).
    archiviert_am        TIMESTAMPTZ,
    angelegt_am          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT kennzahl_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_unternehmen_fk FOREIGN KEY (unternehmen_id, tenant_id)
        REFERENCES unternehmen (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_ort_fk FOREIGN KEY (ort_id, tenant_id, ort_art)
        REFERENCES ort (id, tenant_id, art) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_prozess_fk FOREIGN KEY (prozess_id, tenant_id)
        REFERENCES prozess (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_kostenstelle_fk FOREIGN KEY (kostenstelle_id, tenant_id)
        REFERENCES kostenstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_kennzeichen_eindeutig UNIQUE (tenant_id, kennzeichen),
    -- Ziele der zusammengesetzten Verweise (der Mandant reist mit).
    CONSTRAINT kennzahl_id_tenant_uq UNIQUE (id, tenant_id),
    -- Die Rechenform — Ziel des Verweises JEDER Fassung (V4).
    CONSTRAINT kennzahl_rechenform_uq UNIQUE (id, tenant_id, rechenform),
    -- Kein Verweis zeigt hierauf: der Schlüssel macht die Geltungs-Spalten zu
    -- SCHLÜSSEL-Spalten, ihre Änderung wartet auf das FOR KEY SHARE einer gerade
    -- entstehenden ersten Fassung (Muster bezugsgroesse_geltung_uq) — der Trigger
    -- kennzahl_identitaet_bleibt sieht sie darum immer schon bestätigt.
    CONSTRAINT kennzahl_geltung_uq UNIQUE (id, tenant_id, geltung_art, unternehmen_id, standort_id, ort_id,
        prozess_id, kostenstelle_id, messstelle_id),
    CONSTRAINT kennzahl_kennzeichen_format CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$'),
    CONSTRAINT kennzahl_name_chk CHECK (btrim(name) <> ''),
    CONSTRAINT kennzahl_rechenform_chk CHECK (coalesce(kennzahl_wort('rechenform', rechenform), false)),
    CONSTRAINT kennzahl_geltung_art_chk CHECK (coalesce(kennzahl_wort('geltung_art', geltung_art), false)),
    -- G1: genau EIN Objekt, und es ist das der Art.
    CONSTRAINT kennzahl_geltung_objekt_chk CHECK (coalesce(
        num_nonnulls(unternehmen_id, standort_id, ort_id, prozess_id, kostenstelle_id, messstelle_id) = 1
        AND CASE geltung_art
              WHEN 'unternehmen'  THEN unternehmen_id IS NOT NULL
              WHEN 'standort'     THEN standort_id IS NOT NULL
              WHEN 'gebaeude'     THEN ort_id IS NOT NULL
              WHEN 'bereich'      THEN ort_id IS NOT NULL
              WHEN 'prozess'      THEN prozess_id IS NOT NULL
              WHEN 'kostenstelle' THEN kostenstelle_id IS NOT NULL
              WHEN 'messstelle'   THEN messstelle_id IS NOT NULL
              ELSE false
            END, false)),
    CONSTRAINT kennzahl_verantwortlich_chk CHECK (btrim(verantwortlich_name) <> ''
        AND (verantwortlich_sub IS NULL OR verantwortlich_sub <> '')),
    CONSTRAINT kennzahl_zweck_chk CHECK (zweck IS NULL OR btrim(zweck) <> '')
);
CREATE INDEX IF NOT EXISTS idx_kennzahl_unternehmen ON kennzahl (unternehmen_id)
    WHERE unternehmen_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kennzahl_standort ON kennzahl (standort_id)
    WHERE standort_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kennzahl_ort ON kennzahl (ort_id)
    WHERE ort_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kennzahl_prozess ON kennzahl (prozess_id)
    WHERE prozess_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kennzahl_kostenstelle ON kennzahl (kostenstelle_id)
    WHERE kostenstelle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kennzahl_messstelle ON kennzahl (messstelle_id)
    WHERE messstelle_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- kennzahl_kennzeichen_verlauf: JEDES Kennzeichen, das eine Kennzahl je trug
-- (Muster bezugsgroesse_kennzeichen_verlauf). Geschrieben nur vom Trigger
-- kennzahl_kennzeichen_belegen; nie geändert, gelöscht nur vom Offboarding. Die
-- automatische Vergabe „KZ-0001, KZ-0002 …" (IP-5) folgt auf die höchste HIER je
-- belegte Nummer — eine umbenannte Nummer wird so nie wieder vergeben.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kennzahl_kennzeichen_verlauf (
    tenant_id     UUID        NOT NULL,
    kennzeichen   TEXT        NOT NULL,
    kennzahl_id   UUID        NOT NULL,
    belegt_am     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT kennzahl_kennzeichen_belegt PRIMARY KEY (tenant_id, kennzeichen),
    CONSTRAINT kennzahl_kennzeichen_verlauf_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_kennzeichen_verlauf_kennzahl_fk FOREIGN KEY (kennzahl_id, tenant_id)
        REFERENCES kennzahl (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_kennzeichen_verlauf_format CHECK (kennzeichen ~ '^[A-Z0-9./-]{2,16}$')
);
CREATE INDEX IF NOT EXISTS idx_kennzahl_kennzeichen_verlauf_kennzahl
    ON kennzahl_kennzeichen_verlauf (kennzahl_id);

-- -----------------------------------------------------------------------------
-- kennzahl_fassung: die Berechnung als tagesgültige Fassung (§4.9 V1, E7).
--
-- Spalten ZEILENGLEICH zu messstelle_formel_fassung (V20260912210000) — `id` bis
-- `eingetragen_am` in derselben Reihenfolge und mit denselben Typen, `kennzahl_id`
-- statt `messstelle_id`, `rechenform` statt `formel_typ` (`rest_hauptzaehler_id`
-- ist formel-eigen) — plus `komplement`, `faktor`, `einheit`. Die Regel
-- MessstelleFormelRegeln.fassungEintrag urteilt „nach der jüngsten beginnen" und
-- „rückwirkend"; die Datenbank hält die zeitlose Hälfte: nie zwei Fassungen an
-- einem Tag (Exklusion), bis ≥ ab, Nummer je Kennzahl eindeutig, nur verkürzt.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kennzahl_fassung (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL,
    -- Die Kennzahl, deren Berechnung diese Fassung ist.
    kennzahl_id     UUID        NOT NULL,
    -- Fassung 1, 2, … — je Kennzahl eindeutig, in der Reihenfolge der Tage.
    nummer          INTEGER     NOT NULL,
    -- Kopie der Rechenform der Kennzahl, per Verweis gebunden (V4).
    rechenform      TEXT        NOT NULL,
    -- NULL = gilt seit Beginn (nur Fassung 1).
    gueltig_ab      DATE,
    -- Der LETZTE gültige Tag, einschließlich; NULL = bis auf Weiteres.
    gueltig_bis     DATE,
    aufgehoben_am   TIMESTAMPTZ,
    herkunft        TEXT        NOT NULL,
    -- gueltig_ab vor dem Eintragstag in der Zeitzone des Standorts (fassungEintrag).
    rueckwirkend    BOOLEAN     NOT NULL DEFAULT false,
    begruendung     TEXT,
    -- Der Urheber im Akteur-Vokabular von AP-03 (uems/ProtokollAkteur); actor_sub
    -- NULL = VoltPilot selbst.
    actor_sub       TEXT,
    actor_name      TEXT        NOT NULL,
    actor_rolle     TEXT,
    actor_art       TEXT        NOT NULL,
    eingetragen_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- anteil: 100 − Teil ÷ Ganzes × 100 (Vorlage „Autarkiegrad").
    komplement      BOOLEAN     NOT NULL DEFAULT false,
    -- quotient: dimensionsloser Faktor > 0; NULL = keiner (R2).
    faktor          NUMERIC,
    -- Die Ergebnis-Einheit, wie sie aus den Eingängen entsteht (U1): „kWh/Stück",
    -- „%" — ungekürzt, nie umgerechnet.
    einheit         TEXT        NOT NULL,
    CONSTRAINT kennzahl_fassung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Fassung UND Rechenform zeigen auf die Kennzahl: solange eine Fassung besteht,
    -- lehnt dieser Verweis jede Änderung der Rechenform ab (V4).
    CONSTRAINT kennzahl_fassung_kennzahl_fk FOREIGN KEY (kennzahl_id, tenant_id, rechenform)
        REFERENCES kennzahl (id, tenant_id, rechenform) ON DELETE RESTRICT,
    -- Ziele der Verweise von Wert und Eingang: Fassung UND Kennzahl UND Mandant
    -- zusammen, damit nichts in der Fassung einer anderen Kennzahl landet.
    CONSTRAINT kennzahl_fassung_id_kennzahl_uq UNIQUE (id, kennzahl_id, tenant_id),
    CONSTRAINT kennzahl_fassung_id_rechenform_uq UNIQUE (id, kennzahl_id, tenant_id, rechenform),
    CONSTRAINT kennzahl_fassung_nummer_uq UNIQUE (tenant_id, kennzahl_id, nummer),
    CONSTRAINT kennzahl_fassung_nummer_chk CHECK (nummer >= 1),
    CONSTRAINT kennzahl_fassung_rechenform_chk CHECK (coalesce(kennzahl_wort('rechenform', rechenform), false)),
    CONSTRAINT kennzahl_fassung_herkunft_chk CHECK (herkunft IN ('anlage', 'eintrag', 'kopie')),
    -- Nur Fassung 1 darf ohne ersten Tag sein. ⚠ coalesce(…, false): ein CHECK nimmt NULL an.
    CONSTRAINT kennzahl_fassung_ab_chk CHECK (coalesce(gueltig_ab IS NOT NULL OR nummer = 1, false)),
    -- Anlage und Kopie sind immer Fassung 1 (K20: die Kopie beginnt „gilt seit Beginn").
    CONSTRAINT kennzahl_fassung_herkunft_nummer_chk CHECK (coalesce(herkunft = 'eintrag' OR nummer = 1, false)),
    -- ab = bis ist erlaubt: ein Tag ist ein Intervall.
    CONSTRAINT kennzahl_fassung_bis_nicht_vor_ab
        CHECK (gueltig_bis IS NULL OR gueltig_ab IS NULL OR gueltig_bis >= gueltig_ab),
    CONSTRAINT kennzahl_fassung_rueckwirkend_chk CHECK (NOT rueckwirkend OR gueltig_ab IS NOT NULL),
    CONSTRAINT kennzahl_fassung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT kennzahl_fassung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT kennzahl_fassung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT kennzahl_fassung_begruendung_chk CHECK (begruendung IS NULL
        OR (char_length(begruendung) BETWEEN 1 AND 500 AND btrim(begruendung) <> '')),
    -- R2/§4.3: das Komplement gibt es nur am Anteil, den Faktor nur am Quotienten.
    CONSTRAINT kennzahl_fassung_komplement_chk CHECK (NOT komplement OR rechenform = 'anteil'),
    CONSTRAINT kennzahl_fassung_faktor_chk CHECK (faktor IS NULL OR coalesce(faktor > 0 AND rechenform = 'quotient', false)),
    -- U1: ein Anteil ist in Prozent, ein Quotient nie.
    CONSTRAINT kennzahl_fassung_einheit_chk CHECK (coalesce(btrim(einheit) <> ''
        AND CASE rechenform
              WHEN 'anteil'   THEN einheit = '%'
              WHEN 'quotient' THEN einheit <> '%'
              ELSE true
            END, false)),
    -- Je Kennzahl genau EINE Fassung je Tag. '[]', weil `bis` der letzte Tag IST;
    -- ein NULL-Beginn ist unbeschränkt nach vorn; eine aufgehobene Fassung belegt
    -- keinen Tag; tenant_id vorn (prüft vor dem Fremdschlüssel und ohne RLS).
    CONSTRAINT kennzahl_fassung_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        kennzahl_id WITH =,
        daterange(gueltig_ab, gueltig_bis, '[]') WITH &&
    ) WHERE (aufgehoben_am IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_kennzahl_fassung_kennzahl
    ON kennzahl_fassung (kennzahl_id, nummer);

-- -----------------------------------------------------------------------------
-- kennzahl_eingang: die Eingänge EINER Fassung (§4.4, §6.1) — Historie ihrer
-- Fassung: anlegen ja, ändern und löschen nie (Rechte, Muster
-- messstelle_formel_term).
--
-- Genau EIN Verweis, passend zur Art (B1: ausdrücklich gebunden):
-- messstelle → messstelle_id, bezugsgroesse → bezugsgroesse_id, kennzahl →
-- eingang_kennzahl_id — und nie die eigene Kennzahl (K16 Selbstverweis; der Kreis
-- über mehrere Kennzahlen ist die Regel des Schreibwegs).
--
-- Die Rolle passt zur Rechenform der Fassung (§4.3): `paar` genau in der
-- Zusammenfassung und nur an einer Kennzahl; `zaehler` und `nenner` je Fassung
-- höchstens einmal. Ob es genau zwei sind und ob ihre Einheiten passen, urteilt
-- KennzahlRegeln beim Schreiben (die Anzahl ist keine Zeilen-Eigenschaft).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kennzahl_eingang (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL,
    kennzahl_id          UUID        NOT NULL,
    fassung_id           UUID        NOT NULL,
    -- Kopie der Rechenform der Fassung, per Verweis gebunden.
    rechenform           TEXT        NOT NULL,
    position             SMALLINT    NOT NULL,
    rolle                TEXT        NOT NULL,
    art                  TEXT        NOT NULL,
    messstelle_id        UUID,
    bezugsgroesse_id     UUID,
    eingang_kennzahl_id  UUID,
    CONSTRAINT kennzahl_eingang_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_eingang_fassung_fk FOREIGN KEY (fassung_id, kennzahl_id, tenant_id, rechenform)
        REFERENCES kennzahl_fassung (id, kennzahl_id, tenant_id, rechenform) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_eingang_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_eingang_bezugsgroesse_fk FOREIGN KEY (bezugsgroesse_id, tenant_id)
        REFERENCES bezugsgroesse (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_eingang_kennzahl_fk FOREIGN KEY (eingang_kennzahl_id, tenant_id)
        REFERENCES kennzahl (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_eingang_position_uq UNIQUE (tenant_id, fassung_id, position),
    CONSTRAINT kennzahl_eingang_position_chk CHECK (position >= 0),
    CONSTRAINT kennzahl_eingang_rechenform_chk CHECK (coalesce(kennzahl_wort('rechenform', rechenform), false)),
    CONSTRAINT kennzahl_eingang_rolle_chk CHECK (coalesce(kennzahl_wort('eingang_rolle', rolle), false)),
    CONSTRAINT kennzahl_eingang_art_chk CHECK (coalesce(kennzahl_wort('eingang_art', art), false)),
    CONSTRAINT kennzahl_eingang_genau_ein_verweis_chk CHECK (coalesce(
        num_nonnulls(messstelle_id, bezugsgroesse_id, eingang_kennzahl_id) = 1
        AND CASE art
              WHEN 'messstelle'    THEN messstelle_id IS NOT NULL
              WHEN 'bezugsgroesse' THEN bezugsgroesse_id IS NOT NULL
              WHEN 'kennzahl'      THEN eingang_kennzahl_id IS NOT NULL
              ELSE false
            END, false)),
    CONSTRAINT kennzahl_eingang_kein_selbstverweis_chk
        CHECK (eingang_kennzahl_id IS NULL OR eingang_kennzahl_id <> kennzahl_id),
    CONSTRAINT kennzahl_eingang_rolle_je_rechenform_chk CHECK (coalesce(
        (rolle = 'paar') = (rechenform = 'zusammenfassung')
        AND (rolle <> 'paar' OR art = 'kennzahl'), false))
);
-- Zähler und Nenner je Fassung höchstens einmal; ein Paar liest dieselbe Kennzahl nie zweimal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kennzahl_eingang_rolle
    ON kennzahl_eingang (tenant_id, fassung_id, rolle) WHERE rolle <> 'paar';
CREATE UNIQUE INDEX IF NOT EXISTS uq_kennzahl_eingang_paar
    ON kennzahl_eingang (tenant_id, fassung_id, eingang_kennzahl_id) WHERE rolle = 'paar';
CREATE INDEX IF NOT EXISTS idx_kennzahl_eingang_messstelle ON kennzahl_eingang (messstelle_id)
    WHERE messstelle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kennzahl_eingang_bezugsgroesse ON kennzahl_eingang (bezugsgroesse_id)
    WHERE bezugsgroesse_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_kennzahl_eingang_kennzahl ON kennzahl_eingang (eingang_kennzahl_id)
    WHERE eingang_kennzahl_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- kennzahl_wert: der Wert je Kennzahl × Periode × Version (§4.9, §6.1) —
-- APPEND-ONLY (siehe Kopf). Keine Hypertable: Monat/Jahr je Kennzahl, klein.
--
-- Die Trägerform ist die AP-08-Form (`MessstelleWerteDto.Wert` + `richtung`,
-- `grund`) und sagt die Regeln Q2/Q3/Q7 als CHECK, gespielt gegen jede Regel
-- `wert` der Vektoren:
--   * eine Zahl genau dann, wenn nicht „keine Werte" — und „keine Werte" nennt
--     immer seinen Grund (Invariante 2);
--   * eine Richtung genau bei „unvollständig" (Q3);
--   * eine Zahl nur mit Zähler UND Nenner ≠ 0 (Q2); `zaehler`/`nenner` sind die
--     Mengen, die eine Zusammenfassung je Paar liest (R4);
--   * ohne Version keine Zahl und kein vorläufig/endgültig (Q7);
--   * ab Version 2 ein Anlass (die Herkunft verlangt ihn, kennzahlwert-herkunft §7).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kennzahl_wert (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID        NOT NULL,
    kennzahl_id            UUID        NOT NULL,
    periode_art            TEXT        NOT NULL,
    -- Erster und LETZTER Tag der Periode, einschließlich, in `zeitzone`.
    periode_von            DATE        NOT NULL,
    periode_bis            DATE        NOT NULL,
    zeitzone               TEXT        NOT NULL,
    -- 1, 2, … je Periode; NULL = noch keine Version (ohne Zahl, ohne früheren Wert).
    version                INTEGER,
    -- Ungerundet (U4); NULL = „keine Werte", nie 0.
    wert                   NUMERIC,
    zaehler                NUMERIC,
    nenner                 NUMERIC,
    menge_zustand          TEXT        NOT NULL,
    -- jsonb-ARRAY von Klartext-Sätzen; Wortlaut UND Reihenfolge sind Vertrag.
    kennzeichen            JSONB       NOT NULL DEFAULT '[]'::jsonb,
    abdeckung_prozent      NUMERIC,
    richtung               TEXT,
    grund                  TEXT,
    -- vorläufig/endgültig (Q6) — NICHT menge_zustand.
    zustand                TEXT,
    endgueltig_ab          TIMESTAMPTZ,
    -- Die Fassung, die am LETZTEN Tag der Periode galt (V2).
    definition_fassung_id  UUID        NOT NULL,
    berechnet_am           TIMESTAMPTZ NOT NULL,
    -- Warum Version n ≥ 2 entstand: `eingang` (Korrektur, Berichtigung, Rücknahme)
    -- oder `definition` (Fassung), mit dem Beleg („K-2026-0007 …").
    anlass_art             TEXT,
    anlass_kennung         TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT kennzahl_wert_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_wert_kennzahl_fk FOREIGN KEY (kennzahl_id, tenant_id)
        REFERENCES kennzahl (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_wert_fassung_fk FOREIGN KEY (definition_fassung_id, kennzahl_id, tenant_id)
        REFERENCES kennzahl_fassung (id, kennzahl_id, tenant_id) ON DELETE RESTRICT,
    -- Ziel des Verweises der Eingangs-Werte.
    CONSTRAINT kennzahl_wert_id_kennzahl_uq UNIQUE (id, kennzahl_id, tenant_id),
    CONSTRAINT kennzahl_wert_periode_art_chk CHECK (coalesce(kennzahl_wort('periode_art', periode_art), false)),
    -- P5: genau EINE Kalenderperiode ihrer Art — nie ein Teil, nie zwei (Woche ab Montag).
    CONSTRAINT kennzahl_wert_periode_form_chk CHECK (coalesce(
        CASE periode_art
          WHEN 'tag'   THEN periode_bis = periode_von
          WHEN 'woche' THEN extract(isodow FROM periode_von) = 1 AND periode_bis = periode_von + 6
          WHEN 'monat' THEN extract(day FROM periode_von) = 1
                            AND periode_bis = (periode_von + INTERVAL '1 month')::date - 1
          WHEN 'jahr'  THEN extract(month FROM periode_von) = 1 AND extract(day FROM periode_von) = 1
                            AND periode_bis = (periode_von + INTERVAL '1 year')::date - 1
          ELSE false
        END, false)),
    CONSTRAINT kennzahl_wert_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')),
    CONSTRAINT kennzahl_wert_version_chk CHECK (version IS NULL OR version >= 1),
    CONSTRAINT kennzahl_wert_menge_zustand_chk CHECK (coalesce(kennzahl_wort('zustand', menge_zustand), false)),
    CONSTRAINT kennzahl_wert_richtung_chk
        CHECK (richtung IS NULL OR coalesce(kennzahl_wort('richtung_unsicherheit', richtung), false)),
    CONSTRAINT kennzahl_wert_grund_chk
        CHECK (grund IS NULL OR coalesce(kennzahl_wort('grund_ohne_zahl', grund), false)),
    CONSTRAINT kennzahl_wert_zustand_chk CHECK (zustand IS NULL OR zustand IN ('vorlaeufig', 'endgueltig')),
    -- Q2/Invariante 2: eine Zahl genau ohne „keine Werte"; ohne Zahl immer ein Grund.
    CONSTRAINT kennzahl_wert_zahl_chk CHECK (coalesce((wert IS NULL) = (menge_zustand = 'keine Werte'), false)),
    CONSTRAINT kennzahl_wert_zahl_grund_chk CHECK ((grund IS NULL) = (wert IS NOT NULL)),
    CONSTRAINT kennzahl_wert_zahl_nenner_chk
        CHECK (wert IS NULL OR coalesce(zaehler IS NOT NULL AND nenner <> 0, false)),
    -- Q3: unvollständig trägt seine Richtung, alles andere keine.
    CONSTRAINT kennzahl_wert_zahl_richtung_chk
        CHECK (coalesce((richtung IS NOT NULL) = (menge_zustand = 'unvollständig'), false)),
    -- Q7: ohne Version keine Zahl und kein vorläufig/endgültig.
    CONSTRAINT kennzahl_wert_ohne_version_chk CHECK (version IS NOT NULL OR wert IS NULL),
    CONSTRAINT kennzahl_wert_version_zustand_chk CHECK ((version IS NULL) = (zustand IS NULL)),
    CONSTRAINT kennzahl_wert_endgueltig_ab_chk
        CHECK (coalesce(zustand = 'endgueltig', false) = (endgueltig_ab IS NOT NULL)),
    -- Ab Version 2 ein Anlass mit Beleg; Version 1 und „noch keine" ohne.
    CONSTRAINT kennzahl_wert_anlass_art_chk CHECK (anlass_art IS NULL OR anlass_art IN ('eingang', 'definition')),
    CONSTRAINT kennzahl_wert_anlass_chk CHECK (
        coalesce(version >= 2, false) = (anlass_art IS NOT NULL)
        AND (anlass_art IS NULL) = (anlass_kennung IS NULL)
        AND (anlass_kennung IS NULL OR btrim(anlass_kennung) <> '')),
    CONSTRAINT kennzahl_wert_abdeckung_chk
        CHECK (abdeckung_prozent IS NULL OR abdeckung_prozent BETWEEN 0 AND 100),
    CONSTRAINT kennzahl_wert_kennzeichen_chk CHECK (jsonb_typeof(kennzeichen) = 'array')
);
-- Eine Zeile je Periode, Version und Rechenzeitpunkt; eine endgültige Version ist GENAU eine Zeile.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kennzahl_wert_zeile
    ON kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, coalesce(version, 0), berechnet_am);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kennzahl_wert_endgueltig
    ON kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, version)
    WHERE zustand = 'endgueltig';
CREATE INDEX IF NOT EXISTS idx_kennzahl_wert_fassung ON kennzahl_wert (definition_fassung_id);

-- -----------------------------------------------------------------------------
-- kennzahl_wert_eingang: was ein Wert von jedem Eingang las (§4.10, §6.1,
-- kennzahlwert-herkunft.md: Rolle, Art, Objekt, Wert, Zähler/Nenner je Paar,
-- Einheit, Zustand, Abdeckung, Version bzw. Fassung, Kennzeichen) — APPEND-ONLY
-- wie der Wert. `objekt` ist das Kennzeichen beim Rechnen (ein späteres
-- Umbenennen ändert die Herkunft nicht), der Verweis die Identität.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kennzahl_wert_eingang (
    tenant_id            UUID        NOT NULL,
    wert_id              UUID        NOT NULL,
    kennzahl_id          UUID        NOT NULL,
    position             SMALLINT    NOT NULL,
    rolle                TEXT        NOT NULL,
    art                  TEXT        NOT NULL,
    objekt               TEXT        NOT NULL,
    messstelle_id        UUID,
    bezugsgroesse_id     UUID,
    eingang_kennzahl_id  UUID,
    -- Was der Eingang sagte; NULL = ohne Zahl, nie 0.
    wert                 NUMERIC,
    -- Nur ein Paar: Zähler und Nenner der gelesenen Kennzahl (R4).
    zaehler              NUMERIC,
    nenner               NUMERIC,
    einheit              TEXT        NOT NULL,
    menge_zustand        TEXT,
    abdeckung_prozent    NUMERIC,
    -- Messstelle und Kennzahl: ihre Version; Bezugsgröße: ihre Fassung.
    version              INTEGER,
    fassung              INTEGER,
    kennzeichen          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    CONSTRAINT kennzahl_wert_eingang_pk PRIMARY KEY (tenant_id, wert_id, position),
    CONSTRAINT kennzahl_wert_eingang_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_wert_eingang_wert_fk FOREIGN KEY (wert_id, kennzahl_id, tenant_id)
        REFERENCES kennzahl_wert (id, kennzahl_id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_wert_eingang_messstelle_fk FOREIGN KEY (messstelle_id, tenant_id)
        REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_wert_eingang_bezugsgroesse_fk FOREIGN KEY (bezugsgroesse_id, tenant_id)
        REFERENCES bezugsgroesse (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_wert_eingang_kennzahl_fk FOREIGN KEY (eingang_kennzahl_id, tenant_id)
        REFERENCES kennzahl (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_wert_eingang_position_chk CHECK (position >= 0),
    CONSTRAINT kennzahl_wert_eingang_rolle_chk CHECK (coalesce(kennzahl_wort('eingang_rolle', rolle), false)),
    CONSTRAINT kennzahl_wert_eingang_art_chk CHECK (coalesce(kennzahl_wort('eingang_art', art), false)),
    CONSTRAINT kennzahl_wert_eingang_menge_zustand_chk
        CHECK (menge_zustand IS NULL OR coalesce(kennzahl_wort('zustand', menge_zustand), false)),
    CONSTRAINT kennzahl_wert_eingang_genau_ein_verweis_chk CHECK (coalesce(
        num_nonnulls(messstelle_id, bezugsgroesse_id, eingang_kennzahl_id) = 1
        AND CASE art
              WHEN 'messstelle'    THEN messstelle_id IS NOT NULL
              WHEN 'bezugsgroesse' THEN bezugsgroesse_id IS NOT NULL
              WHEN 'kennzahl'      THEN eingang_kennzahl_id IS NOT NULL
              ELSE false
            END, false)),
    CONSTRAINT kennzahl_wert_eingang_kein_selbstverweis_chk
        CHECK (eingang_kennzahl_id IS NULL OR eingang_kennzahl_id <> kennzahl_id),
    CONSTRAINT kennzahl_wert_eingang_objekt_chk CHECK (btrim(objekt) <> '' AND btrim(einheit) <> ''),
    CONSTRAINT kennzahl_wert_eingang_paar_chk
        CHECK (rolle = 'paar' OR (zaehler IS NULL AND nenner IS NULL)),
    CONSTRAINT kennzahl_wert_eingang_stand_chk CHECK (coalesce(
        CASE art WHEN 'bezugsgroesse' THEN version IS NULL ELSE fassung IS NULL END, false)),
    CONSTRAINT kennzahl_wert_eingang_abdeckung_chk
        CHECK (abdeckung_prozent IS NULL OR abdeckung_prozent BETWEEN 0 AND 100),
    CONSTRAINT kennzahl_wert_eingang_kennzeichen_chk CHECK (jsonb_typeof(kennzeichen) = 'array')
);

-- -----------------------------------------------------------------------------
-- kennzahl_aenderung: das Protokoll der Kennzahl (§6.1; Wörter aus dem Vertrag,
-- siehe Kopf). Kein Verweis auf die Kennzahl (ein Protokoll überlebt sein
-- Objekt), aber auf den Mandanten: nur das Offboarding räumt es ab.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kennzahl_aenderung (
    id            BIGSERIAL   PRIMARY KEY,
    tenant_id     UUID        NOT NULL,
    kennzahl_id   UUID        NOT NULL,
    art           TEXT        NOT NULL,
    alt           JSONB,
    neu           JSONB,
    gilt_ab       TIMESTAMPTZ NOT NULL,
    rueckwirkend  BOOLEAN     NOT NULL,
    grund         TEXT,
    actor_sub     TEXT,
    actor_name    TEXT        NOT NULL,
    actor_rolle   TEXT,
    actor_art     TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT kennzahl_aenderung_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT kennzahl_aenderung_art_chk CHECK (coalesce(kennzahl_wort('protokoll', art), false)),
    CONSTRAINT kennzahl_aenderung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT kennzahl_aenderung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT kennzahl_aenderung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot')),
    CONSTRAINT kennzahl_aenderung_rueckwirkend_chk CHECK (NOT rueckwirkend OR gilt_ab < created_at)
);
CREATE INDEX IF NOT EXISTS idx_kennzahl_aenderung_kennzahl
    ON kennzahl_aenderung (kennzahl_id, created_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- Die Trigger
-- -----------------------------------------------------------------------------

-- V4: Kennung und Mandant nie; der Geltungsbereich nur, solange die Kennzahl keine
-- Fassung hat. (Die Rechenform hält der Verweis jeder Fassung fest; zur
-- Gleichzeitigkeit siehe kennzahl_geltung_uq.)
CREATE OR REPLACE FUNCTION kennzahl_identitaet_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'Kennung und Mandant der Kennzahl % sind nie änderbar', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kennzahl_identitaet_unveraenderlich';
  END IF;
  IF (NEW.geltung_art, NEW.unternehmen_id, NEW.standort_id, NEW.ort_id, NEW.prozess_id, NEW.kostenstelle_id,
      NEW.messstelle_id)
       IS DISTINCT FROM (OLD.geltung_art, OLD.unternehmen_id, OLD.standort_id, OLD.ort_id, OLD.prozess_id,
      OLD.kostenstelle_id, OLD.messstelle_id)
     AND EXISTS (SELECT 1 FROM public.kennzahl_fassung f
                  WHERE f.kennzahl_id = OLD.id AND f.tenant_id = OLD.tenant_id) THEN
    RAISE EXCEPTION 'Der Geltungsbereich der Kennzahl % hat eine Fassung und ist nicht mehr änderbar', OLD.kennzeichen
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kennzahl_geltung_nach_erster_fassung';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS kennzahl_identitaet_bleibt ON kennzahl;
CREATE TRIGGER kennzahl_identitaet_bleibt BEFORE UPDATE ON kennzahl
    FOR EACH ROW EXECUTE FUNCTION kennzahl_identitaet_bleibt();

-- Jede Vergabe und jede Umbenennung belegt das Kennzeichen (Muster
-- bezugsgroesse_kennzeichen_belegen). SECURITY DEFINER, weil die App-Rolle den
-- Verlauf nur lesen darf. Trägt oder trug eine ANDERE Kennzahl das Kennzeichen,
-- scheitert das INSERT am Primärschlüssel kennzahl_kennzeichen_belegt (23505).
CREATE OR REPLACE FUNCTION kennzahl_kennzeichen_belegen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.kennzeichen = OLD.kennzeichen THEN
    RETURN NULL;
  END IF;
  -- Die Kennzahl darf zu ihrem EIGENEN früheren Kennzeichen zurück.
  PERFORM 1 FROM public.kennzahl_kennzeichen_verlauf
    WHERE tenant_id = NEW.tenant_id AND kennzeichen = NEW.kennzeichen AND kennzahl_id = NEW.id;
  IF NOT FOUND THEN
    INSERT INTO public.kennzahl_kennzeichen_verlauf (tenant_id, kennzeichen, kennzahl_id)
    VALUES (NEW.tenant_id, NEW.kennzeichen, NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kennzahl_kennzeichen_belegen() FROM PUBLIC;
DROP TRIGGER IF EXISTS kennzahl_kennzeichen_belegen ON kennzahl;
CREATE TRIGGER kennzahl_kennzeichen_belegen AFTER INSERT OR UPDATE OF kennzeichen ON kennzahl
    FOR EACH ROW EXECUTE FUNCTION kennzahl_kennzeichen_belegen();

-- Eine Fassung wird nur VERKÜRZT (die nächste beendet sie) oder EINMAL aufgehoben —
-- nie verlängert, nie umgeschrieben, auch nicht von einer Rolle mit vollem
-- UPDATE-Recht (Muster messstelle_formel_fassung_nur_verkuerzen).
CREATE OR REPLACE FUNCTION kennzahl_fassung_nur_verkuerzen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.tenant_id, NEW.kennzahl_id, NEW.nummer, NEW.rechenform, NEW.gueltig_ab, NEW.herkunft,
        NEW.rueckwirkend, NEW.begruendung, NEW.actor_sub, NEW.actor_name, NEW.actor_rolle, NEW.actor_art,
        NEW.eingetragen_am, NEW.komplement, NEW.faktor, NEW.einheit)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.kennzahl_id, OLD.nummer, OLD.rechenform, OLD.gueltig_ab, OLD.herkunft,
        OLD.rueckwirkend, OLD.begruendung, OLD.actor_sub, OLD.actor_name, OLD.actor_rolle, OLD.actor_art,
        OLD.eingetragen_am, OLD.komplement, OLD.faktor, OLD.einheit) THEN
        RAISE EXCEPTION 'Eine Kennzahl-Fassung wird nie umgeschrieben'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'kennzahl_fassung_unveraenderlich';
    END IF;
    IF NEW.gueltig_bis IS DISTINCT FROM OLD.gueltig_bis
       AND (NEW.gueltig_bis IS NULL OR (OLD.gueltig_bis IS NOT NULL AND NEW.gueltig_bis > OLD.gueltig_bis)) THEN
        RAISE EXCEPTION 'Eine Kennzahl-Fassung wird nur verkuerzt, nie verlaengert'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'kennzahl_fassung_nur_verkuerzen';
    END IF;
    IF OLD.aufgehoben_am IS NOT NULL AND NEW.aufgehoben_am IS DISTINCT FROM OLD.aufgehoben_am THEN
        RAISE EXCEPTION 'Eine aufgehobene Kennzahl-Fassung bleibt aufgehoben'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'kennzahl_fassung_aufgehoben';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS kennzahl_fassung_nur_verkuerzen ON kennzahl_fassung;
CREATE TRIGGER kennzahl_fassung_nur_verkuerzen BEFORE UPDATE ON kennzahl_fassung
    FOR EACH ROW EXECUTE FUNCTION kennzahl_fassung_nur_verkuerzen();

-- ⚠ Ein Kennzahl-Wert und seine Eingangs-Werte werden nie geändert und nie gelöscht
-- (siehe Kopf) — JEDES UPDATE und JEDES DELETE, von jeder Rolle. Einzige Ausnahme:
-- das DELETE im Aufruf von uems_kennzahlwerte_des_kundenbereichs_entfernen() für
-- genau dessen Kundenbereich.
CREATE OR REPLACE FUNCTION kennzahl_wert_nie_ueberschrieben() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('uems.kennzahlwerte_entfernen', true) = OLD.tenant_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% ist append-only: ein Kennzahl-Wert wird nie geändert und nie gelöscht — eine Neubildung ist eine neue Zeile', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END $$;
DROP TRIGGER IF EXISTS kennzahl_wert_append_only ON kennzahl_wert;
CREATE TRIGGER kennzahl_wert_append_only BEFORE UPDATE OR DELETE ON kennzahl_wert
    FOR EACH ROW EXECUTE FUNCTION kennzahl_wert_nie_ueberschrieben();
DROP TRIGGER IF EXISTS kennzahl_wert_eingang_append_only ON kennzahl_wert_eingang;
CREATE TRIGGER kennzahl_wert_eingang_append_only BEFORE UPDATE OR DELETE ON kennzahl_wert_eingang
    FOR EACH ROW EXECUTE FUNCTION kennzahl_wert_nie_ueberschrieben();

-- Q7/V3: die Versionsfolge je Periode (siehe Kopf). Die neueste Zeile ist die mit
-- der höchsten Version, dann dem jüngsten Rechenzeitpunkt; eine neue Zeile rechnet
-- nie vor ihr.
CREATE OR REPLACE FUNCTION kennzahl_wert_version_folgt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  l_version  INTEGER;
  l_zustand  TEXT;
  l_art      TEXT;
  l_kennung  TEXT;
  l_am       TIMESTAMPTZ;
  gefunden   BOOLEAN;
  erwartet   TEXT;
BEGIN
  SELECT w.version, w.zustand, w.anlass_art, w.anlass_kennung, w.berechnet_am
    INTO l_version, l_zustand, l_art, l_kennung, l_am
    FROM public.kennzahl_wert w
   WHERE w.tenant_id = NEW.tenant_id AND w.kennzahl_id = NEW.kennzahl_id
     AND w.periode_art = NEW.periode_art AND w.periode_von = NEW.periode_von
   ORDER BY w.version DESC NULLS LAST, w.berechnet_am DESC
   LIMIT 1;
  gefunden := FOUND;
  IF gefunden AND NEW.berechnet_am < l_am THEN
    RAISE EXCEPTION 'Kennzahl-Wert %/%: berechnet am % liegt vor der neuesten Zeile (%)',
          NEW.periode_art, NEW.periode_von, NEW.berechnet_am, l_am
      USING ERRCODE = 'check_violation', CONSTRAINT = 'kennzahl_wert_version_folgt';
  END IF;
  IF NOT gefunden OR l_version IS NULL THEN
    -- Ohne früheren Wert Version 1 — ohne Zahl noch keine Version.
    IF NEW.version IS NULL OR (NEW.version = 1 AND NEW.wert IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    erwartet := 'keine (ohne Zahl) oder 1 (mit Zahl)';
  ELSIF l_zustand = 'vorlaeufig' THEN
    -- Ein vorläufiger Wert zieht ohne neue Version nach: dieselbe Nummer, derselbe Anlass.
    IF NEW.version = l_version AND NEW.anlass_art IS NOT DISTINCT FROM l_art
       AND NEW.anlass_kennung IS NOT DISTINCT FROM l_kennung THEN
      RETURN NEW;
    END IF;
    erwartet := l_version || ' mit demselben Anlass (nachziehen)';
  ELSE
    -- Ein endgültiger Wert ändert sich nur als Version n + 1.
    IF NEW.version = l_version + 1 THEN
      RETURN NEW;
    END IF;
    erwartet := (l_version + 1)::text;
  END IF;
  RAISE EXCEPTION 'Kennzahl-Wert %/%: Version % folgt nicht auf die neueste Zeile (Version %, %) — erwartet %',
        NEW.periode_art, NEW.periode_von, coalesce(NEW.version::text, 'keine'), coalesce(l_version::text, 'keine'),
        coalesce(l_zustand, 'ohne Zahl'), erwartet
    USING ERRCODE = 'check_violation', CONSTRAINT = 'kennzahl_wert_version_folgt';
END $$;
DROP TRIGGER IF EXISTS kennzahl_wert_version_folgt ON kennzahl_wert;
CREATE TRIGGER kennzahl_wert_version_folgt BEFORE INSERT ON kennzahl_wert
    FOR EACH ROW EXECUTE FUNCTION kennzahl_wert_version_folgt();

-- Belegung und Protokoll: nie geändert. DELETE bleibt dem Offboarding (Rechte).
DROP TRIGGER IF EXISTS kennzahl_kennzeichen_verlauf_append_only ON kennzahl_kennzeichen_verlauf;
CREATE TRIGGER kennzahl_kennzeichen_verlauf_append_only BEFORE UPDATE ON kennzahl_kennzeichen_verlauf
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
DROP TRIGGER IF EXISTS kennzahl_aenderung_append_only ON kennzahl_aenderung;
CREATE TRIGGER kennzahl_aenderung_append_only BEFORE UPDATE ON kennzahl_aenderung
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE kennzahl ENABLE ROW LEVEL SECURITY;
ALTER TABLE kennzahl FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kennzahl_tenant_isolation ON kennzahl;
CREATE POLICY kennzahl_tenant_isolation ON kennzahl
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE kennzahl_kennzeichen_verlauf ENABLE ROW LEVEL SECURITY;
ALTER TABLE kennzahl_kennzeichen_verlauf FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kennzahl_kennzeichen_verlauf_tenant_isolation ON kennzahl_kennzeichen_verlauf;
CREATE POLICY kennzahl_kennzeichen_verlauf_tenant_isolation ON kennzahl_kennzeichen_verlauf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE kennzahl_fassung ENABLE ROW LEVEL SECURITY;
ALTER TABLE kennzahl_fassung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kennzahl_fassung_tenant_isolation ON kennzahl_fassung;
CREATE POLICY kennzahl_fassung_tenant_isolation ON kennzahl_fassung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE kennzahl_eingang ENABLE ROW LEVEL SECURITY;
ALTER TABLE kennzahl_eingang FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kennzahl_eingang_tenant_isolation ON kennzahl_eingang;
CREATE POLICY kennzahl_eingang_tenant_isolation ON kennzahl_eingang
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE kennzahl_wert ENABLE ROW LEVEL SECURITY;
ALTER TABLE kennzahl_wert FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kennzahl_wert_tenant_isolation ON kennzahl_wert;
CREATE POLICY kennzahl_wert_tenant_isolation ON kennzahl_wert
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE kennzahl_wert_eingang ENABLE ROW LEVEL SECURITY;
ALTER TABLE kennzahl_wert_eingang FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kennzahl_wert_eingang_tenant_isolation ON kennzahl_wert_eingang;
CREATE POLICY kennzahl_wert_eingang_tenant_isolation ON kennzahl_wert_eingang
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE kennzahl_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE kennzahl_aenderung FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kennzahl_aenderung_tenant_isolation ON kennzahl_aenderung;
CREATE POLICY kennzahl_aenderung_tenant_isolation ON kennzahl_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Der eine Ausgang der Werte: das Offboarding (siehe Kopf). Nur die
-- Verwaltungsrolle darf die Funktion ausführen; sie setzt den Zaun und die
-- Kennzeichnung für GENAU ihren Kundenbereich und nimmt beide wieder zurück.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uems_kennzahlwerte_des_kundenbereichs_entfernen(p_tenant UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
    entfernt BIGINT := 0;
    n BIGINT;
    zaun TEXT := current_setting('app.tenant_id', true);
BEGIN
    IF p_tenant IS NULL THEN
        RAISE EXCEPTION 'a tenant scope is required' USING ERRCODE = '22023';
    END IF;
    PERFORM set_config('app.tenant_id', p_tenant::text, true);
    PERFORM set_config('uems.kennzahlwerte_entfernen', p_tenant::text, true);
    DELETE FROM kennzahl_wert_eingang WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    DELETE FROM kennzahl_wert WHERE tenant_id = p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT; entfernt := entfernt + n;
    PERFORM set_config('uems.kennzahlwerte_entfernen', '', true);
    PERFORM set_config('app.tenant_id', coalesce(zaun, ''), true);
    RETURN entfernt;
END $$;

REVOKE ALL ON FUNCTION uems_kennzahlwerte_des_kundenbereichs_entfernen(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uems_kennzahlwerte_des_kundenbereichs_entfernen(UUID) TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben.
-- -----------------------------------------------------------------------------
REVOKE ALL ON kennzahl, kennzahl_kennzeichen_verlauf, kennzahl_fassung, kennzahl_eingang, kennzahl_wert,
    kennzahl_wert_eingang, kennzahl_aenderung FROM ${appDbUser}, ${adminDbUser};

-- Die Definition: der Schreibweg (IP-5) legt an und ändert Stammdaten; eine
-- Kennzahl wird archiviert, gelöscht wird hier nichts (das Löschen ohne Wert, V5,
-- bringt IP-5 mit seinem Weg). Kennung, Mandant und Anlagezeit nie.
GRANT SELECT, INSERT ON kennzahl TO ${appDbUser};
GRANT UPDATE (kennzeichen, name, rechenform, geltung_art, unternehmen_id, standort_id, ort_id, prozess_id,
              kostenstelle_id, messstelle_id, verantwortlich_sub, verantwortlich_name, zweck, archiviert_am,
              updated_at)
    ON kennzahl TO ${appDbUser};
-- Die Belegung schreibt nur der Trigger.
GRANT SELECT ON kennzahl_kennzeichen_verlauf TO ${appDbUser};
-- Fassungen: anlegen, verkürzen, aufheben.
GRANT SELECT, INSERT ON kennzahl_fassung TO ${appDbUser};
GRANT UPDATE (gueltig_bis, aufgehoben_am) ON kennzahl_fassung TO ${appDbUser};
-- Eingänge: Historie ihrer Fassung — anlegen ja, ändern/löschen nie.
GRANT SELECT, INSERT ON kennzahl_eingang TO ${appDbUser};
-- Werte liest die Anwendung nur; gebildet werden sie im Lauf (IP-6).
GRANT SELECT ON kennzahl_wert, kennzahl_wert_eingang TO ${appDbUser};
-- Das Protokoll: lesen und anhängen.
GRANT SELECT, INSERT ON kennzahl_aenderung TO ${appDbUser};

-- Die BYPASSRLS-Rolle voltpilot_admin: der Rechenlauf liest die Definition und
-- hängt Werte an (die Rechenzeit `created_at` setzt die Datenbank); das Offboarding
-- löscht die Definition — die Werte nur über die Funktion oben.
GRANT SELECT ON kennzahl, kennzahl_kennzeichen_verlauf, kennzahl_fassung, kennzahl_eingang, kennzahl_wert,
    kennzahl_wert_eingang, kennzahl_aenderung TO ${adminDbUser};
GRANT INSERT (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, version, wert, zaehler,
              nenner, menge_zustand, kennzeichen, abdeckung_prozent, richtung, grund, zustand, endgueltig_ab,
              definition_fassung_id, berechnet_am, anlass_art, anlass_kennung)
    ON kennzahl_wert TO ${adminDbUser};
GRANT INSERT ON kennzahl_wert_eingang TO ${adminDbUser};
GRANT DELETE ON kennzahl, kennzahl_kennzeichen_verlauf, kennzahl_fassung, kennzahl_eingang, kennzahl_aenderung
    TO ${adminDbUser};

-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Recht (die rollout_event-Falle).
GRANT USAGE, SELECT ON SEQUENCE kennzahl_aenderung_id_seq TO ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE kennzahl_aenderung_id_seq TO ${adminDbUser};

COMMENT ON FUNCTION kennzahl_vokabular() IS
    'Die Vokabulare von docs/contracts/v2/kennzahl-vectors.json (vokabulare.*), Zeile fuer Zeile; '
    'die EINE Stelle, die jeder Vokabular-CHECK der Kennzahl-Tabellen fragt.';
COMMENT ON TABLE kennzahl IS
    'UEMS AP-11: Kennzahl mit Rechenform und genau einem Geltungsbereich (E1); Berechnung in kennzahl_fassung.';
COMMENT ON TABLE kennzahl_kennzeichen_verlauf IS
    'UEMS AP-11: jedes je getragene Kennzeichen einer Kennzahl; nie weitergegeben.';
COMMENT ON TABLE kennzahl_fassung IS
    'UEMS AP-11: Berechnung als tagesgueltige Fassung, zeilengleich zu messstelle_formel_fassung (E7).';
COMMENT ON TABLE kennzahl_eingang IS
    'UEMS AP-11: Eingaenge einer Fassung, genau ein Verweis, nie die eigene Kennzahl.';
COMMENT ON TABLE kennzahl_wert IS
    'UEMS AP-11: Kennzahl-Wert je Periode und Version, append-only per Trigger fuer jede Rolle (Q7, V3).';
COMMENT ON TABLE kennzahl_wert_eingang IS
    'UEMS AP-11: was ein Kennzahl-Wert von jedem Eingang las, append-only wie der Wert.';
COMMENT ON TABLE kennzahl_aenderung IS
    'UEMS AP-11: Protokoll der Kennzahl (Woerter des Vertrags), append-only; nur das Offboarding loescht.';
