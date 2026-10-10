-- UEMS AP-08 IP-15: Vier Augen bei Korrekturen — die Einstellung je Unternehmen
-- und das Protokoll der Freigabe (Entscheid E8 = A vom 11.09.2026).
--
-- E8 im Wortlaut: „Konfigurierbar je Unternehmen durch den Kundenadministrator:
-- ‚Freigabe durch eine zweite Person‘ aus (Vorgabe) oder an; bei an: Ersteller ≠
-- Freigeber (Energiemanager oder Kundenadministrator); jede Freigabe protokolliert
-- Ersteller, Freigeber, Zeitpunkt, Begründung.“
--
-- ZWEI SPALTEN, KEINE ZEILE:
--   * `unternehmen.vieraugen_freigabe` — die Einstellung am Unternehmen (dasselbe
--     Muster wie `zeitzone`: eine Zeile je Kundenbereich, geändert über den
--     Schreibweg mit Eintrag in `ort_aenderung`). NULL heißt „nie eingestellt“ und
--     ist die VORGABE AUS — ein Kunde, der nichts einstellt, bekommt kein
--     Vier-Augen-Prinzip. Darum kein NOT NULL DEFAULT: der Bestand bleibt Zeichen
--     für Zeichen, und „aus (Vorgabe)“ bleibt von „ausgeschaltet“ unterscheidbar.
--   * `messreihe_korrektur.freigabe_vieraugen` — an der Fassung der Freigabe: unter
--     welcher Einstellung sie geschah. Die Einstellung wirkt ZUM ZEITPUNKT DER
--     FREIGABE (nicht des Vorschlags); der Schreibweg liest sie in derselben
--     Transaktion unter Zeilensperre und schreibt sie hierher. Ein späteres
--     Umschalten ändert keine gespeicherte Freigabe, und niemand muss aus zwei
--     Zeitachsen ableiten, was damals galt.
--
-- Die vier Angaben der Freigabe stehen damit an EINER Stelle, ohne Kopie:
-- Ersteller = `actor_*` der Fassung 1, Freigeber = `actor_*` der Freigabe-Fassung,
-- Zeitpunkt = ihr `created_at`, Begründung = ihr `grund` (Pflicht, sobald die
-- Fassung die Einstellung trägt — CHECK unten).
--
-- DIE DATENBANK HÄLT ES FEST (neben dem Schreibweg):
--   * `messreihe_korrektur_vieraugen_chk`: die Spalte nur an einer Fortschreibung
--     (Fassung > 1) und nur mit Begründung. Kein Wort im CHECK (Test
--     `jederCheckFragtDieEineStelleUndTraegtKeineEigeneListe`).
--   * Trigger `messreihe_korrektur_zweite_person`: trägt die Fassung
--     `freigabe_vieraugen = true`, darf ihr Urheber nicht der Ersteller sein —
--     auch nicht mit Recht. Verglichen wird das Subject (`actor_sub`); ein
--     Vorschlag des Systems hat keins und hält niemanden auf.
--   * Die System-Rolle (BYPASSRLS) bekommt KEIN Spaltenrecht auf die neue Spalte:
--     sie schlägt nur vor (IP-14), eine Freigabe schreibt nur die App-Rolle.
--
-- Bestehende Abfragen lesen die neuen Spalten nicht (Migrationstests fahren den
-- Lesecode von heute gegen ältere Fassungen); nur der neue Schreibweg der
-- Korrektur-Routen tut es. Kein neues Wort im Vokabular, keine Vektor-Datei.
-- Wiederholbar (`out-of-order`): jeder Schritt ist idempotent.

ALTER TABLE unternehmen ADD COLUMN IF NOT EXISTS vieraugen_freigabe BOOLEAN;

COMMENT ON COLUMN unternehmen.vieraugen_freigabe IS
    'UEMS AP-08 E8: Freigabe von Korrekturen durch eine zweite Person. NULL = nie eingestellt = '
    'Vorgabe aus; true = an; false = ausdruecklich aus. Aendern darf nur der Kundenadministrator '
    '(vieraugen.einstellen), jede Aenderung steht in ort_aenderung.';

ALTER TABLE messreihe_korrektur ADD COLUMN IF NOT EXISTS freigabe_vieraugen BOOLEAN;

COMMENT ON COLUMN messreihe_korrektur.freigabe_vieraugen IS
    'UEMS AP-08 IP-15: an der Fassung der Freigabe die Vier-Augen-Einstellung, die in diesem '
    'Augenblick galt (true = an: Freigeber ist nicht der Ersteller). NULL an jeder anderen Fassung '
    'und an Freigaben vor IP-15.';

ALTER TABLE messreihe_korrektur DROP CONSTRAINT IF EXISTS messreihe_korrektur_vieraugen_chk;
ALTER TABLE messreihe_korrektur ADD CONSTRAINT messreihe_korrektur_vieraugen_chk
    CHECK (freigabe_vieraugen IS NULL OR coalesce(fassung > 1 AND grund IS NOT NULL, false));

CREATE OR REPLACE FUNCTION messreihe_korrektur_zweite_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.freigabe_vieraugen IS TRUE AND EXISTS (
       SELECT 1 FROM public.messreihe_korrektur e
        WHERE e.tenant_id = NEW.tenant_id AND e.kennung = NEW.kennung AND e.fassung = 1
          AND e.actor_sub IS NOT NULL AND e.actor_sub = NEW.actor_sub) THEN
    RAISE EXCEPTION 'Korrektur %: bei Vier-Augen an gibt eine zweite Person frei, nicht der Ersteller', NEW.kennung
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messreihe_korrektur_zweite_person';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messreihe_korrektur_zweite_person ON messreihe_korrektur;
CREATE TRIGGER messreihe_korrektur_zweite_person BEFORE INSERT ON messreihe_korrektur
    FOR EACH ROW EXECUTE FUNCTION messreihe_korrektur_zweite_person();

COMMENT ON FUNCTION messreihe_korrektur_zweite_person() IS
    'UEMS AP-08 E8: eine Freigabe unter Vier-Augen an stammt nie vom Ersteller der Korrektur '
    '(Vergleich ueber actor_sub; ein System-Vorschlag hat keinen).';

-- Die App-Rolle schreibt die Einstellung an der Freigabe mit (spaltenweises INSERT
-- wie V20260913190000); UPDATE bleibt für jede Rolle gesperrt (append-only).
GRANT INSERT (freigabe_vieraugen) ON messreihe_korrektur TO ${appDbUser};
