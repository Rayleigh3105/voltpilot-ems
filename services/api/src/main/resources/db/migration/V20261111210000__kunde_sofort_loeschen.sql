-- Kunde sofort löschen (vp-kunde-sofort-loeschen; Captain 11.11.2026: einen doppelt angelegten
-- Kunden ohne Datenbestand sofort endgültig löschen können, aktiv oder beendet, ohne Frist).
--
-- Derselbe Löschweg wie nach Fristende (IP-18, KundenbereichLoeschung), kein zweiter daneben.
-- Was „keine Daten" heißt, steht EINMAL in kundenbereich/KundeDatenBestand.
--
-- 1) mandant_loeschnachweis trägt den ANLASS der Löschung. Beim sofortigen Löschen eines AKTIVEN
--    Kunden gibt es kein Vertragsende und keine Frist - die drei Spalten werden für diesen Fall
--    leer. Der alte Sammel-CHECK (mandant_loeschnachweis_frist_chk) verlor mit einem NULL darin
--    JEDE seiner Aussagen (NULL-Semantik); der neue prüft geloescht_von immer und die
--    Fristen-Fakten genau beim Anlass 'frist_abgelaufen'. Bestandszeilen sind alle Frist-Löschungen
--    (Default beim Auffüllen); der Unveränderlichkeits-Trigger bleibt unberührt.
ALTER TABLE mandant_loeschnachweis ALTER COLUMN beendet_am DROP NOT NULL;
ALTER TABLE mandant_loeschnachweis ALTER COLUMN frist_tage DROP NOT NULL;
ALTER TABLE mandant_loeschnachweis ALTER COLUMN loeschung_fruehestens DROP NOT NULL;
ALTER TABLE mandant_loeschnachweis ADD COLUMN anlass TEXT NOT NULL DEFAULT 'frist_abgelaufen';
ALTER TABLE mandant_loeschnachweis DROP CONSTRAINT mandant_loeschnachweis_frist_chk;
ALTER TABLE mandant_loeschnachweis ADD CONSTRAINT mandant_loeschnachweis_anlass_chk
    CHECK (anlass IN ('frist_abgelaufen', 'sofort_keine_daten'));
ALTER TABLE mandant_loeschnachweis ADD CONSTRAINT mandant_loeschnachweis_frist_chk
    CHECK (btrim(geloescht_von) <> ''
           AND ((anlass = 'frist_abgelaufen'
                 AND beendet_am IS NOT NULL AND frist_tage IS NOT NULL AND frist_tage > 0
                 AND loeschung_fruehestens IS NOT NULL AND geloescht_am >= beendet_am)
                OR (anlass = 'sofort_keine_daten'
                    AND frist_tage IS NULL AND loeschung_fruehestens IS NULL)));

-- 2) Das Plattform-Protokoll der Kundenlöschung: anders als der Löschnachweis (bewusst ohne
--    Personendaten) nennt es den NAMEN des Kunden, wer gelöscht hat, wann und aus welchem Anlass -
--    der Auftrag verlangt den nachvollziehbaren Eintrag „sofort, keine Daten". Es trägt bewusst
--    `kundenbereich` statt `tenant_id` und keinen Fremdschlüssel: der Kundenbereich ist danach weg,
--    der Eintrag bleibt (wie mandant_loeschnachweis, dessen Kennzeichen er nennt). Nur der Betrieb:
--    die Admin-Rolle liest und schreibt ein; niemand ändert oder löscht (Trigger), die App-Rolle
--    sieht die Tabelle nicht.
CREATE TABLE IF NOT EXISTS kundenbereich_geloescht_protokoll (
    id                          BIGSERIAL   PRIMARY KEY,
    kundenbereich               UUID        NOT NULL,
    name                        TEXT        NOT NULL,
    geloescht_am                TIMESTAMPTZ NOT NULL DEFAULT now(),
    geloescht_von_sub           TEXT,
    geloescht_von_name          TEXT        NOT NULL,
    anlass                      TEXT        NOT NULL,
    loeschnachweis_kennzeichen  TEXT        NOT NULL,
    CONSTRAINT kundenbereich_geloescht_kundenbereich_uq UNIQUE (kundenbereich),
    CONSTRAINT kundenbereich_geloescht_anlass_chk
        CHECK (anlass IN ('frist_abgelaufen', 'sofort_keine_daten')),
    CONSTRAINT kundenbereich_geloescht_name_chk
        CHECK (btrim(name) <> '' AND btrim(geloescht_von_name) <> '')
);

CREATE OR REPLACE FUNCTION kundenbereich_geloescht_bleibt() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Ein Löschprotokoll bleibt, wie es geschrieben wurde (%)', OLD.kundenbereich
        USING ERRCODE = 'check_violation', CONSTRAINT = 'kundenbereich_geloescht_bleibt';
END
$$;
DROP TRIGGER IF EXISTS kundenbereich_geloescht_bleibt ON kundenbereich_geloescht_protokoll;
CREATE TRIGGER kundenbereich_geloescht_bleibt BEFORE UPDATE OR DELETE ON kundenbereich_geloescht_protokoll
    FOR EACH ROW EXECUTE FUNCTION kundenbereich_geloescht_bleibt();

REVOKE ALL ON kundenbereich_geloescht_protokoll FROM ${appDbUser};
REVOKE ALL ON kundenbereich_geloescht_protokoll FROM ${adminDbUser};
GRANT SELECT, INSERT ON kundenbereich_geloescht_protokoll TO ${adminDbUser};
REVOKE ALL ON SEQUENCE kundenbereich_geloescht_protokoll_id_seq FROM ${appDbUser};
GRANT USAGE, SELECT ON SEQUENCE kundenbereich_geloescht_protokoll_id_seq TO ${adminDbUser};
