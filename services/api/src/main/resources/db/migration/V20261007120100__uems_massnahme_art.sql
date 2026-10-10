-- =============================================================================
-- Verbessern-Konzept v1, PR 2 (Captain-Freigabe 06.10.2026, Entscheide 6 und 13):
-- die Art einer Maßnahme und die erwartete Einsparung in kWh im Jahr.
--
-- `art` sagt, wie sich die Wirkung zeigt (Entscheid 6): `gemessen` (an einer Kennzahl
-- mit Bezugsbasis, genau dann, wenn die Maßnahme eine Messgrundlage hat) ·
-- `nicht_gemessen` (spart Energie, wird aber nicht gemessen, z. B. Druckluft ohne
-- Kennzahl) · `organisatorisch` (regelt Zuständigkeiten, Abläufe, Schulungen). Ohne
-- Messung schließt eine Person die umgesetzte Maßnahme mit einem Satz ab (Ergebnis
-- `nicht_messbar`, wie bisher ohne Messgrundlage) statt „Wirkung prüfen“.
-- Der Bestand bekommt seine Art aus dem, was die Zeile schon sagt: mit Kennzahl
-- `gemessen`, aus einer Feststellung oder einem internen Audit `organisatorisch`,
-- sonst `nicht_gemessen`. Sonst ändert sich keine Spalte einer Bestandszeile. Dieselbe
-- Ableitung setzt ein Anlege-Trigger, wenn ein Schreibweg keine Art nennt.
--
-- `erwartete_einsparung_kwh_jahr` ist die Schätzung einer Person in kWh im Jahr
-- (Entscheid 13, ändert AP-18 M4): ohne Kennzahl von der Person eingetragen (nur bei
-- `nicht_gemessen`, nur weniger Energie, also > 0); mit Kennzahl rechnet VoltPilot
-- die erwartete Wirkung in Prozent über die gemessene Menge der letzten zwölf
-- abgeschlossenen Monate um und hält diese Grundlage fest
-- (`erwartete_einsparung_grundlage_kwh`, `…_grundlage_monate`). Sie ist eine
-- Schätzung beim Anlegen und wird nie mit beobachteten Werten summiert.
-- Organisatorische Maßnahmen tragen keine Zahl.
--
-- Art bleibt für immer, die Einsparung ändert sich nur, solange die Maßnahme geplant
-- ist (Trigger massnahme_art_eingefroren, neben massnahme_eingefroren). Die App-Rolle
-- darf die drei Einsparungs-Spalten ändern (Schreibweg „Ändern“), `art` nie.
--
-- Vokabulare: verbesserung_vokabular() wird mit CREATE OR REPLACE geweitet - alle
-- Wörter von IP-5, IP-9, IP-14, AP-19 IP-17 und Verbessern PR 1 (`kurs_lage`, V20261006213000)
-- unverändert in derselben Reihenfolge, dazu am Ende nur `massnahme_art` (Vertrag verbesserung.md 1.1). Wer die Funktion
-- später weitet, schreibt die VEREINIGUNG.
-- =============================================================================

-- Die Wörter von IP-5, IP-9, IP-14 und AP-19 IP-17 in derselben Reihenfolge, dazu die
-- Art der Maßnahme (Entscheid 6).
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
    ('massnahme_herkunft', 7, 'managementbewertung'),
    ('kurs_lage', 1, 'auf_kurs'),
    ('kurs_lage', 2, 'knapp_dahinter'),
    ('kurs_lage', 3, 'nicht_auf_kurs'),
    ('kurs_lage', 4, 'noch_keine_aussage'),
    ('massnahme_art', 1, 'gemessen'),
    ('massnahme_art', 2, 'nicht_gemessen'),
    ('massnahme_art', 3, 'organisatorisch')
$$;

ALTER TABLE massnahme
    ADD COLUMN art TEXT,
    ADD COLUMN erwartete_einsparung_kwh_jahr NUMERIC,
    ADD COLUMN erwartete_einsparung_grundlage_kwh NUMERIC,
    ADD COLUMN erwartete_einsparung_grundlage_monate TEXT;

-- Der Bestand: die Art aus Messgrundlage und Herkunft. Die Migration läuft als Eigentümer
-- (Superuser, RLS greift nicht); der Änderungs-Trigger hielte eine verworfene Maßnahme
-- fest - diese Nachtragung ist die EINE Ausnahme.
ALTER TABLE massnahme DISABLE TRIGGER massnahme_eingefroren;
UPDATE massnahme
   SET art = CASE
       WHEN kennzahl_id IS NOT NULL THEN 'gemessen'
       WHEN herkunft_art IN ('nichtkonformitaet', 'audit') THEN 'organisatorisch'
       ELSE 'nicht_gemessen' END
 WHERE art IS NULL;
ALTER TABLE massnahme ENABLE TRIGGER massnahme_eingefroren;

-- Schreibwege ohne Art (Seeds, Prüfstände von vor dieser Migration): dieselbe Ableitung wie
-- für den Bestand. Der Schreibweg der Route setzt die Art immer selbst.
CREATE FUNCTION massnahme_art_vorgabe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.art IS NULL THEN
        NEW.art := CASE
            WHEN NEW.kennzahl_id IS NOT NULL THEN 'gemessen'
            WHEN NEW.herkunft_art IN ('nichtkonformitaet', 'audit') THEN 'organisatorisch'
            ELSE 'nicht_gemessen' END;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER massnahme_art_vorgabe BEFORE INSERT ON massnahme
    FOR EACH ROW EXECUTE FUNCTION massnahme_art_vorgabe();

ALTER TABLE massnahme
    ALTER COLUMN art SET NOT NULL,
    -- Entscheid 6: gemessen genau mit Messgrundlage.
    ADD CONSTRAINT massnahme_art_chk CHECK (coalesce(verbesserung_wort('massnahme_art', art)
        AND (art = 'gemessen') = (kennzahl_id IS NOT NULL), false)),
    -- Entscheid 13: eine ganze Zahl kWh im Jahr, nie 0; mit Kennzahl umgerechnet aus der
    -- erwarteten Wirkung mit Grundlage, ohne Kennzahl die Schätzung einer Person (nur
    -- weniger Energie), organisatorisch keine Zahl.
    ADD CONSTRAINT massnahme_einsparung_chk CHECK (
        (erwartete_einsparung_kwh_jahr IS NULL
            OR (erwartete_einsparung_kwh_jahr = round(erwartete_einsparung_kwh_jahr)
                AND erwartete_einsparung_kwh_jahr <> 0 AND abs(erwartete_einsparung_kwh_jahr) < 1000000000000))
        AND (erwartete_einsparung_grundlage_kwh IS NULL) = (erwartete_einsparung_grundlage_monate IS NULL)
        AND (erwartete_einsparung_grundlage_kwh IS NULL OR erwartete_einsparung_grundlage_kwh > 0)
        AND (erwartete_einsparung_grundlage_monate IS NULL
            OR erwartete_einsparung_grundlage_monate ~ '^[0-9]{4}-(0[1-9]|1[0-2])/[0-9]{4}-(0[1-9]|1[0-2])$')
        AND coalesce(CASE art
            WHEN 'gemessen' THEN (erwartete_einsparung_kwh_jahr IS NULL) = (erwartete_einsparung_grundlage_kwh IS NULL)
                AND (erwartete_einsparung_kwh_jahr IS NULL OR erwartete_wirkung_prozent IS NOT NULL)
            WHEN 'nicht_gemessen' THEN erwartete_einsparung_grundlage_kwh IS NULL
                AND (erwartete_einsparung_kwh_jahr IS NULL OR erwartete_einsparung_kwh_jahr > 0)
            ELSE erwartete_einsparung_kwh_jahr IS NULL AND erwartete_einsparung_grundlage_kwh IS NULL END, false));

CREATE FUNCTION massnahme_art_eingefroren() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.art <> OLD.art THEN
        RAISE EXCEPTION 'Die Art der Maßnahme % ist nie änderbar', OLD.kennzeichen
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_art_bleibt';
    END IF;
    IF OLD.zustand <> 'geplant' AND (NEW.erwartete_einsparung_kwh_jahr, NEW.erwartete_einsparung_grundlage_kwh,
            NEW.erwartete_einsparung_grundlage_monate)
        IS DISTINCT FROM (OLD.erwartete_einsparung_kwh_jahr, OLD.erwartete_einsparung_grundlage_kwh,
            OLD.erwartete_einsparung_grundlage_monate) THEN
        RAISE EXCEPTION 'Die Maßnahme % ist %: nur solange geplant änderbar', OLD.kennzeichen, OLD.zustand
            USING ERRCODE = 'check_violation', CONSTRAINT = 'massnahme_nur_geplant_aenderbar';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER massnahme_art_eingefroren BEFORE UPDATE ON massnahme
    FOR EACH ROW EXECUTE FUNCTION massnahme_art_eingefroren();

GRANT UPDATE (erwartete_einsparung_kwh_jahr, erwartete_einsparung_grundlage_kwh,
    erwartete_einsparung_grundlage_monate) ON massnahme TO ${appDbUser};
