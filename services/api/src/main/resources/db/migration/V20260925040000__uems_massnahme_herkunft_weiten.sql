-- =============================================================================
-- AP-19 IP-17: Die Herkunft der Maßnahme geweitet (W1, W4, W14; FS3, R10).
--
-- Eine Maßnahme kann jetzt auch aus einer Feststellung (`nichtkonformitaet`, Kennung
-- F-JJJJ-nnnn), aus einem internen Audit (`audit`, AU-JJJJ-nnnn — ein Hinweis ohne
-- Nichterfüllung) und aus einem Beschluss der Managementbewertung (`managementbewertung`,
-- BR-JJJJ-nnnn/Bn) kommen. Die zwei Wörter aus AP-18 E7 stehen wörtlich, das dritte kommt
-- additiv dazu (W4, Lesart LA2); die Kundenwörter sind „Feststellung“, „internes Audit“,
-- „Managementbewertung“ — `nichtkonformitaet` steht nur in Vertrag und Code (SP5, W3).
--
-- Warum eine eigene Migration (W1): `massnahme_herkunft_chk` (V20260924233000) endet mit
-- `CASE … ELSE false` — `CREATE OR REPLACE` des Vokabulars allein weitet die Herkunft NICHT,
-- anders als der Kommentar in V20260924223000 (Zeilen 38–40) es sagt. Die angewandten
-- Migrationen bleiben, wie sie sind (Flyway-Regel); dieser Tausch ersetzt den CHECK mit
-- DROP/ADD CONSTRAINT in EINER Anweisung, und das ADD validiert gegen den Bestand: jede
-- bestehende Zeile erfüllt den alten CHECK und damit den neuen (die Wortmenge wächst, kein
-- Bestandswert ändert sich — „additiv“ in AP-18 E7). Keine Zeile ändert sich (NW-5).
--
-- Die Datenbank prüft das Muster der Kennung; Existenz und Zustand des Objekts prüft der
-- Schreibweg (`MassnahmeService`, W14): die Feststellung offen, das Audit durchgeführt oder
-- abgeschlossen, die Managementbewertung freigegeben mit Beschluss n. Die Feststellung
-- trägt keine Spalte für ihre Maßnahmen (IP-16) — sie findet sie über die Kennung.
--
-- Vokabulare: verbesserung_vokabular() wird mit CREATE OR REPLACE geweitet — alle Wörter
-- von IP-5, IP-9 und IP-14 unverändert in derselben Reihenfolge, dazu am Ende nur die drei
-- Herkunft-Wörter (`massnahme_herkunft` Nr. 5–7; der Vertrag nennt sie in dieser Folge).
-- Wer die Funktion später weitet, schreibt die VEREINIGUNG.
--
-- Keine neue Tabelle, keine neue Rechte-Kennung, keine Route: `POST /api/v1/massnahmen`
-- nimmt die neuen Arten mit `herkunft_kennung` an (verbesserung.verwalten, §4.9 RE1).
-- =============================================================================

-- Die Wörter von IP-5, IP-9 und IP-14 in derselben Reihenfolge, dazu die drei neuen
-- Herkünfte der Maßnahme (AP-19 W4).
CREATE OR REPLACE FUNCTION verbesserung_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('energieziel_zustand', 1, 'offen'),
    ('energieziel_zustand', 2, 'bewertet'),
    ('energieziel_zustand', 3, 'beendet'),
    ('energieziel_ergebnis', 1, 'erreicht'),
    ('energieziel_ergebnis', 2, 'verfehlt'),
    ('energieziel_ergebnis', 3, 'nicht_bewertbar'),
    ('zielstand_vorschlag', 1, 'erreicht'),
    ('zielstand_vorschlag', 2, 'nicht_erreicht'),
    ('massnahme_zustand', 1, 'geplant'),
    ('massnahme_zustand', 2, 'umgesetzt'),
    ('massnahme_zustand', 3, 'bewertet'),
    ('massnahme_zustand', 4, 'verworfen'),
    ('massnahme_herkunft', 1, 'abweichung'),
    ('massnahme_herkunft', 2, 'energieziel'),
    ('massnahme_herkunft', 3, 'einsatz'),
    ('massnahme_herkunft', 4, 'von_hand'),
    ('abweichung_zustand', 1, 'offen'),
    ('abweichung_zustand', 2, 'abgeschlossen'),
    ('abweichung_ergebnis', 1, 'massnahme'),
    ('abweichung_ergebnis', 2, 'erklaert'),
    ('abweichung_ergebnis', 3, 'keine_abweichung'),
    ('abweichung_ergebnis', 4, 'nicht_bewertbar'),
    ('abweichung_eintrag_art', 1, 'kommentar'),
    ('abweichung_eintrag_art', 2, 'ursache_aussage'),
    ('auffaelligkeit_zustand', 1, 'offen'),
    ('auffaelligkeit_zustand', 2, 'beantwortet'),
    ('auffaelligkeit_antwort', 1, 'abweichung'),
    ('auffaelligkeit_antwort', 2, 'zur_kenntnis'),
    ('ursache_beleg', 1, 'keine_messung'),
    ('ursache_beleg', 2, 'mit_beleg'),
    ('wirkung_ergebnis', 1, 'belegt'),
    ('wirkung_ergebnis', 2, 'nicht_belegt'),
    ('wirkung_ergebnis', 3, 'nicht_messbar'),
    ('wirkung_grund', 1, 'umsetzungsmonat'),
    ('wirkung_grund', 2, 'basis_nach_umsetzung'),
    ('wirkung_grund', 3, 'unvollstaendig'),
    ('wirkung_grund', 4, 'basis_fehlt'),
    ('wirkung_grund', 5, 'basis_beendet'),
    ('wirkung_grund', 6, 'zu_wenig_perioden'),
    ('wirkung_grund', 7, 'variable_fehlt'),
    ('wirkung_grund', 8, 'variable_ausserhalb'),
    ('wirkung_grund', 9, 'periode_nicht_zu_ende'),
    ('wirkung_grund', 10, 'keine_werte'),
    ('anstoss_art', 1, 'ausgangslage_korrigiert'),
    ('anstoss_art', 2, 'bewertung_korrigiert'),
    ('anstoss_art', 3, 'messgrundlage_beendet'),
    ('anstoss_art', 4, 'messgrundlage_neu_gefasst'),
    ('anstoss_zustand', 1, 'offen'),
    ('anstoss_zustand', 2, 'beantwortet'),
    ('anstoss_antwort', 1, 'bleibt'),
    ('anstoss_antwort', 2, 'neu_kopiert'),
    ('anstoss_antwort', 3, 'neu_bewertet'),
    ('frist_art', 1, 'massnahme'),
    ('frist_art', 2, 'abweichung'),
    ('frist_art', 3, 'energieziel'),
    ('frist_faellig', 1, 'ueberfaellig'),
    ('frist_faellig', 2, 'bewertung_faellig'),
    ('kennung_art', 1, 'EZ'),
    ('kennung_art', 2, 'M'),
    ('kennung_art', 3, 'AW'),
    ('energieziel_bewertung_status', 1, 'beantragt'),
    ('energieziel_bewertung_status', 2, 'bewertet'),
    ('energieziel_bewertung_status', 3, 'abgelehnt'),
    ('energieziel_protokoll', 1, 'energieziel_angelegt'),
    ('energieziel_protokoll', 2, 'energieziel_geaendert'),
    ('energieziel_protokoll', 3, 'verantwortlicher_geaendert'),
    ('energieziel_protokoll', 4, 'bewertung_beantragt'),
    ('energieziel_protokoll', 5, 'bewertung_abgelehnt'),
    ('energieziel_protokoll', 6, 'energieziel_bewertet'),
    ('energieziel_protokoll', 7, 'energieziel_beendet'),
    ('energieziel_protokoll', 8, 'anstoss_gesetzt'),
    ('energieziel_protokoll', 9, 'anstoss_beantwortet'),
    ('massnahme_bewertung_status', 1, 'beantragt'),
    ('massnahme_bewertung_status', 2, 'bewertet'),
    ('massnahme_bewertung_status', 3, 'abgelehnt'),
    ('massnahme_protokoll', 1, 'massnahme_angelegt'),
    ('massnahme_protokoll', 2, 'massnahme_geaendert'),
    ('massnahme_protokoll', 3, 'verantwortlicher_geaendert'),
    ('massnahme_protokoll', 4, 'kommentar'),
    ('massnahme_protokoll', 5, 'massnahme_umgesetzt'),
    ('massnahme_protokoll', 6, 'massnahme_verworfen'),
    ('massnahme_protokoll', 7, 'bewertung_beantragt'),
    ('massnahme_protokoll', 8, 'bewertung_abgelehnt'),
    ('massnahme_protokoll', 9, 'massnahme_bewertet'),
    ('massnahme_protokoll', 10, 'anstoss_gesetzt'),
    ('massnahme_protokoll', 11, 'anstoss_beantwortet'),
    ('abweichung_herkunft', 1, 'auffaelligkeit'),
    ('abweichung_herkunft', 2, 'von_hand'),
    ('abweichung_protokoll', 1, 'abweichung_eroeffnet'),
    ('abweichung_protokoll', 2, 'kommentar'),
    ('abweichung_protokoll', 3, 'ursache_aussage'),
    ('abweichung_protokoll', 4, 'abweichung_geaendert'),
    ('abweichung_protokoll', 5, 'verantwortlicher_geaendert'),
    ('abweichung_protokoll', 6, 'abweichung_abgeschlossen'),
    ('massnahme_herkunft', 5, 'nichtkonformitaet'),
    ('massnahme_herkunft', 6, 'audit'),
    ('massnahme_herkunft', 7, 'managementbewertung')
$$;

-- M1 + FS3: die Herkunft mit ihrer Kennung — die vier Arten von AP-18 unverändert, dazu die
-- drei Muster der Verträge (`energiemanagement-vectors.json` › `kennzeichen_muster`).
ALTER TABLE massnahme
    DROP CONSTRAINT massnahme_herkunft_chk,
    ADD CONSTRAINT massnahme_herkunft_chk CHECK (coalesce(verbesserung_wort('massnahme_herkunft', herkunft_art)
        AND CASE herkunft_art
            WHEN 'von_hand' THEN herkunft_kennung IS NULL
            WHEN 'abweichung' THEN herkunft_kennung ~ '^AW-[0-9]{4}-[0-9]{4,9}$'
            WHEN 'energieziel' THEN herkunft_kennung ~ '^EZ-[0-9]{4}-[0-9]{4,9}$' AND energieziel_id IS NOT NULL
            WHEN 'einsatz' THEN herkunft_kennung ~ '^EE-[1-9][0-9]{0,12}$' AND einsatz_id IS NOT NULL
            WHEN 'nichtkonformitaet' THEN herkunft_kennung ~ '^F-[0-9]{4}-[0-9]{4,9}$'
            WHEN 'audit' THEN herkunft_kennung ~ '^AU-[0-9]{4}-[0-9]{4,9}$'
            WHEN 'managementbewertung' THEN herkunft_kennung ~ '^BR-[0-9]{4}-[0-9]{4,}/B[0-9]{1,3}$'
            ELSE false END, false));
