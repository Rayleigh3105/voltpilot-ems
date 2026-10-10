-- =============================================================================
-- AP-17 IP-15: Anstoß an der Bezugsbasis — Kaskade (Pfad 1, A2) und
-- Struktur-Läufer (Pfad 2, A3). Additiv zu V20260924071500 (IP-6):
--
--   1. Das Protokoll-Wort `anstoss_gesetzt` (bezugsbasis_aenderung je Anstoß, A4).
--      bezugsbasis_vokabular() wird mit CREATE OR REPLACE geweitet — jedes Wort
--      von IP-6 bleibt an seiner Stelle, kein CHECK wird angefasst (nie enger).
--   2. Die Verwaltungsrolle (Kaskade und Läufer schreiben ohne RLS, jede Abfrage
--      nennt den Mandanten) darf Anstoß und Protokoll ANHÄNGEN — nie ändern.
--   3. Das Wasserzeichen des Pfads 2: bezugsbasis_struktur_gelesen, je gelesener
--      Protokollzeile genau eine Zeile (Muster bericht_struktur_gelesen, AP-12
--      IP-9). Eine eigene Tabelle, weil die Berichte dieselben Zeilen mit eigenem
--      Urteil lesen; leer angelegt.
-- =============================================================================

CREATE OR REPLACE FUNCTION bezugsbasis_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('methode', 1, 'verhaeltnis'),
    ('methode', 2, 'regression_eine_variable'),
    ('methode', 3, 'regression_zwei_variablen'),
    ('methode', 4, 'gradtage'),
    ('freigabe_status', 1, 'entwurf'),
    ('freigabe_status', 2, 'beantragt'),
    ('freigabe_status', 3, 'freigegeben'),
    ('freigabe_status', 4, 'abgelehnt'),
    ('datenlage', 1, 'vollstaendig'),
    ('datenlage', 2, 'vorlaeufig'),
    ('anpassungsgrund', 1, 'referenzperiode_vervollstaendigt'),
    ('anpassungsgrund', 2, 'grundlage_korrigiert'),
    ('anpassungsgrund', 3, 'struktur_geaendert'),
    ('anpassungsgrund', 4, 'variable_geaendert'),
    ('anpassungsgrund', 5, 'methode_geaendert'),
    ('anpassungsgrund', 6, 'nicht_mehr_anwendbar'),
    ('anpassungsgrund', 7, 'sonstiger'),
    ('urteil', 1, 'besser'),
    ('urteil', 2, 'schlechter'),
    ('urteil', 3, 'im_rahmen'),
    ('urteil', 4, 'ohne_urteil'),
    ('urteil', 5, 'nicht_anwendbar'),
    ('grund', 1, 'basis_fehlt'),
    ('grund', 2, 'basis_beendet'),
    ('grund', 3, 'zu_wenig_perioden'),
    ('grund', 4, 'variable_fehlt'),
    ('grund', 5, 'variable_ausserhalb'),
    ('grund', 6, 'variablen_abhaengig'),
    ('grund', 7, 'keine_werte'),
    ('grund', 8, 'periode_nicht_zu_ende'),
    ('faktor_art', 1, 'flaeche'),
    ('faktor_art', 2, 'standort'),
    ('faktor_art', 3, 'anlage'),
    ('faktor_art', 4, 'prozess'),
    ('faktor_art', 5, 'kostenstelle'),
    ('faktor_art', 6, 'wortlaut'),
    ('anstoss_art', 1, 'grundlage_korrigiert'),
    ('anstoss_art', 2, 'struktur_geaendert'),
    ('anstoss_art', 3, 'variable_geaendert'),
    ('anstoss_art', 4, 'nicht_mehr_anwendbar'),
    ('anstoss_antwort', 1, 'neue_fassung'),
    ('anstoss_antwort', 2, 'beendet'),
    ('anstoss_antwort', 3, 'bleibt'),
    ('protokoll', 1, 'bezugsbasis_angelegt'),
    ('protokoll', 2, 'bezugsbasis_geaendert'),
    ('protokoll', 3, 'verantwortlicher_geaendert'),
    ('protokoll', 4, 'fassung_entworfen'),
    ('protokoll', 5, 'fassung_beantragt'),
    ('protokoll', 6, 'fassung_freigegeben'),
    ('protokoll', 7, 'fassung_abgelehnt'),
    ('protokoll', 8, 'fassung_beendet'),
    ('protokoll', 9, 'variable_abgelehnt'),
    ('protokoll', 10, 'anstoss_beantwortet'),
    ('protokoll', 11, 'gueltig_bleibt'),
    ('protokoll', 12, 'bezugsbasis_beendet'),
    ('protokoll', 13, 'anstoss_gesetzt')
$$;

-- Späte Ankunft (out-of-order): läuft diese Migration vor V20260924071500, gibt es die
-- Tabellen noch nicht — dann ohne GRANT. Auf `uems` ist IP-6 vor diesem Paket gemergt.
DO $$
BEGIN
    IF to_regclass('bezugsbasis_anstoss') IS NOT NULL AND to_regclass('bezugsbasis_aenderung') IS NOT NULL THEN
        EXECUTE 'GRANT INSERT ON bezugsbasis_anstoss, bezugsbasis_aenderung TO ${adminDbUser}';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS bezugsbasis_struktur_gelesen (
    protokoll    TEXT        NOT NULL,
    eintrag_id   BIGINT      NOT NULL,
    -- Die Anstoß-Art (bezugsbasis_vokabular() → anstoss_art) oder der Grund ohne
    -- Anstoß (`ohne_bezugsbasis`, `nicht_strukturell`, `abgeschaltet`).
    urteil       TEXT        NOT NULL,
    -- Wie viele Anstöße die Zeile neu setzte.
    anstoesse    INTEGER     NOT NULL DEFAULT 0,
    gelesen_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bezugsbasis_struktur_gelesen_pk PRIMARY KEY (protokoll, eintrag_id),
    CONSTRAINT bezugsbasis_struktur_gelesen_protokoll_chk CHECK (protokoll IN
        ('ort_aenderung', 'messstelle_aenderung', 'kennzahl_aenderung', 'bezugsgroesse_aenderung')),
    CONSTRAINT bezugsbasis_struktur_gelesen_urteil_chk CHECK (btrim(urteil) <> ''),
    CONSTRAINT bezugsbasis_struktur_gelesen_anstoesse_chk CHECK (anstoesse >= 0)
);

REVOKE ALL ON bezugsbasis_struktur_gelesen FROM ${appDbUser};
GRANT SELECT, INSERT ON bezugsbasis_struktur_gelesen TO ${adminDbUser};

COMMENT ON TABLE bezugsbasis_struktur_gelesen IS
    'AP-17 IP-15: das Wasserzeichen des Bezugsbasis-Pfads 2 im Strukturänderungs-Läufer — je gelesener '
    'Zeile von ort_aenderung/messstelle_aenderung/kennzahl_aenderung/bezugsgroesse_aenderung genau eine Zeile.';
