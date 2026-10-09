-- =============================================================================
-- V20261008213500 - Fernwartung: ein gesperrter Techniker-Zugang lässt sich
-- löschen.
-- -----------------------------------------------------------------------------
-- Wunsch des Kapitäns (08.10.2026): ein Zugang mit falschem Schlüssel wurde
-- gesperrt und neu angelegt; der alte steht mit demselben Namen weiter in der
-- Liste und wird nie wieder gebraucht.
--
-- „Löschen" ist ein dritter ZUSTAND, kein DELETE. Die Zeile bleibt, und damit
-- bleibt alles, was an ihr hängt:
--
--   * Adresse und Schlüssel bleiben über die UNIQUE-Constraints von
--     fernwartung_zugang vergeben. Eine wiedervergebene Adresse ließe einen
--     Techniker bei einem fremden Gerät landen - derselbe Schutz wie bisher
--     (V20261007163700), jetzt auch für gelöschte Zugänge.
--   * fernwartung_fenster (zusammengesetzter Fremdschlüssel auf (id, art)) und
--     fernwartung_protokoll verweisen weiter auf den Zugang und nennen ihn beim
--     Namen. Ein physisches DELETE scheiterte ohnehin an diesen Fremdschlüsseln
--     und am append-only-Trigger des Protokolls.
--   * Die Admin-Rolle bekommt weiterhin KEIN DELETE-Recht.
--
-- Für den Tunnel-Dienst ändert sich nichts: der Soll-Stand trägt nur aktive
-- Zugänge, ein gelöschter fehlt dort wie ein gesperrter.
--
-- Steht für sich: jede Anweisung ist wiederholbar und setzt nur die Tabellen
-- aus V20261007163700 voraus, in Versionsreihenfolge wie bei später Ankunft.
-- =============================================================================

-- Der dritte Zustand. Die Wortliste baut auf dem aktuellen Schema auf
-- (V20261007163700: 'aktiv', 'gesperrt').
ALTER TABLE fernwartung_zugang DROP CONSTRAINT IF EXISTS fernwartung_zugang_status_chk;
ALTER TABLE fernwartung_zugang ADD CONSTRAINT fernwartung_zugang_status_chk
    CHECK (status IN ('aktiv', 'gesperrt', 'geloescht'));

-- Löschbar ist nur ein Techniker-Zugang. Eine Box ist über ihre Referenz
-- bestimmt und bekäme mit einem neuen Schlüssel dieselbe Adresse wieder.
ALTER TABLE fernwartung_zugang DROP CONSTRAINT IF EXISTS fernwartung_zugang_geloescht_chk;
ALTER TABLE fernwartung_zugang ADD CONSTRAINT fernwartung_zugang_geloescht_chk
    CHECK (status <> 'geloescht' OR art = 'techniker');

-- Endgültig an der Datenbankgrenze, nicht nur per Konvention: gelöscht wird
-- nur aus 'gesperrt', und eine gelöschte Zeile ändert sich nie wieder - kein
-- Entsperren, kein anderer Schlüssel, keine andere Adresse.
CREATE OR REPLACE FUNCTION fernwartung_zugang_loeschregel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'geloescht' THEN
      RAISE EXCEPTION 'ein Fernwartungs-Zugang wird nicht als geloescht angelegt';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'geloescht' THEN
    RAISE EXCEPTION 'ein geloeschter Fernwartungs-Zugang ist endgueltig';
  END IF;
  IF NEW.status = 'geloescht' AND OLD.status <> 'gesperrt' THEN
    RAISE EXCEPTION 'nur ein gesperrter Fernwartungs-Zugang laesst sich loeschen';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fernwartung_zugang_loeschregel ON fernwartung_zugang;
CREATE TRIGGER fernwartung_zugang_loeschregel BEFORE INSERT OR UPDATE ON fernwartung_zugang
    FOR EACH ROW EXECUTE FUNCTION fernwartung_zugang_loeschregel();

-- Das Protokoll kennt den Eintrag „gelöscht". Die Wortliste baut auf dem
-- aktuellen Schema auf (V20261007163700) und nimmt nichts weg.
ALTER TABLE fernwartung_protokoll DROP CONSTRAINT IF EXISTS fernwartung_protokoll_aktion_chk;
ALTER TABLE fernwartung_protokoll ADD CONSTRAINT fernwartung_protokoll_aktion_chk CHECK (aktion IN (
    'box_schluessel_hinterlegt', 'box_schluessel_getauscht',
    'box_gesperrt', 'box_entsperrt',
    'techniker_angelegt', 'techniker_gesperrt', 'techniker_entsperrt', 'techniker_geloescht',
    'fenster_geoeffnet', 'fenster_geschlossen'));
