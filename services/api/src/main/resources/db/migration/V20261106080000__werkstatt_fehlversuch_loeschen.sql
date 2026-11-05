-- =============================================================================
-- Werkstatt: einen Fehlversuch löschen (DELETE /api/v1/admin/werkstatt/boxen/{ref}).
-- -----------------------------------------------------------------------------
-- Wunsch des Kapitäns (05.11.2026): eine Box wie edge-pmzasg2 war ein
-- Fehlversuch - eingelöst, Tunnel-Schlüssel hinterlegt, aber nie abgenommen
-- und nie gekoppelt. „Aus dem Register entfernen“ (V20261105170000) ließ nur
-- einen unbenutzten Eintrag zu. Jetzt heißt es „Löschen“ und gilt für jede Box,
-- die nicht abgenommen und nicht gekoppelt ist (kein Zertifikat, kein Gerät,
-- keine Vorab-Registrierung); das prüft der WerkstattService unter der
-- Werkstatt-Sperre, alles in EINER Transaktion.
--
-- Was mit der Box geht:
--   * ihr Tunnel-Zugang (fernwartung_zugang, art = 'box') bekommt den Zustand
--     'geloescht' wie ein gelöschter Techniker-Zugang (V20261008213500): die
--     Zeile bleibt, Adresse und Schlüssel bleiben vergeben (keine
--     Wiedervergabe), Fenster und Protokoll nennen sie weiter; der Soll-Stand
--     trägt nur aktive Zugänge, der Tunnel-Dienst nimmt den Peer mit dem
--     nächsten Abruf heraus. Offene Fenster schließt der Dienst vorher.
--   * nicht eingelöste Codes (werkstatt_code), der festgehaltene
--     Geräteschlüssel (werkstatt_geraeteschluessel) und eine offene
--     Zertifikatsanfrage ohne Zertifikat (device_enrollment) werden gelöscht.
--   * Läufe (werkstatt_lauf), Einlösungen (werkstatt_einloesung, append-only)
--     und die von ihnen verwendeten Codes bleiben als Verlauf.
-- Die ganze gelöschte Lage steht vorher in werkstatt_box_entfernt.mitgeloescht.
--
-- Steht für sich: jede Anweisung ist wiederholbar und setzt nur die Tabellen
-- aus V20261007163700, V20261008213500, V20261009074500, V20261102150000 und
-- V20261105170000 voraus, in Versionsreihenfolge wie bei später Ankunft.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Auch ein Box-Zugang lässt sich löschen (bisher nur ein Techniker-Zugang).
--    Die Löschregel (nur aus 'gesperrt', danach endgültig) bleibt unverändert.
-- -----------------------------------------------------------------------------
ALTER TABLE fernwartung_zugang DROP CONSTRAINT IF EXISTS fernwartung_zugang_geloescht_chk;

-- Eine Referenz hat höchstens EINEN nicht gelöschten Box-Zugang. Ein gelöschter
-- hält seine Referenz nicht mehr fest: kommt dieselbe Referenz wieder, bekommt
-- sie einen neuen Zugang mit neuer Adresse.
ALTER TABLE fernwartung_zugang DROP CONSTRAINT IF EXISTS fernwartung_zugang_edge_ref_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fernwartung_zugang_box_ref
    ON fernwartung_zugang (edge_ref) WHERE status <> 'geloescht';

-- -----------------------------------------------------------------------------
-- 2. Das Protokoll kennt „Box gelöscht“. Die Wortliste baut auf dem aktuellen
--    Schema auf (V20261009074500) und nimmt nichts weg.
-- -----------------------------------------------------------------------------
ALTER TABLE fernwartung_protokoll DROP CONSTRAINT IF EXISTS fernwartung_protokoll_aktion_chk;
ALTER TABLE fernwartung_protokoll ADD CONSTRAINT fernwartung_protokoll_aktion_chk CHECK (aktion IN (
    'box_schluessel_hinterlegt', 'box_schluessel_getauscht',
    'box_gesperrt', 'box_entsperrt', 'box_geloescht',
    'techniker_angelegt', 'techniker_gesperrt', 'techniker_entsperrt', 'techniker_geloescht',
    'techniker_ssh_schluessel_gesetzt', 'techniker_ssh_schluessel_entfernt',
    'fenster_geoeffnet', 'fenster_geschlossen'));

-- -----------------------------------------------------------------------------
-- 3. Die Spur: was außer der Register-Zeile mitging (Tunnel-Zugang, Fenster,
--    Codes, Geräteschlüssel, Zertifikatsanfrage), als ein JSON-Objekt. Ältere
--    Zeilen (nur die Register-Zeile) tragen ein leeres Objekt.
-- -----------------------------------------------------------------------------
ALTER TABLE werkstatt_box_entfernt ADD COLUMN IF NOT EXISTS mitgeloescht JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE werkstatt_box_entfernt DROP CONSTRAINT IF EXISTS werkstatt_box_entfernt_mitgeloescht_chk;
ALTER TABLE werkstatt_box_entfernt ADD CONSTRAINT werkstatt_box_entfernt_mitgeloescht_chk
    CHECK (jsonb_typeof(mitgeloescht) = 'object');

-- -----------------------------------------------------------------------------
-- 4. Rechte der Admin-Rolle zum Löschen. Eine Einlösung bleibt append-only und
--    hält ihren Code per Fremdschlüssel fest; ein eingelöster Code lässt sich
--    also auch an der Datenbankgrenze nicht löschen.
-- -----------------------------------------------------------------------------
GRANT DELETE ON werkstatt_code TO ${adminDbUser};
GRANT DELETE ON werkstatt_geraeteschluessel TO ${adminDbUser};
GRANT DELETE ON device_enrollment TO ${adminDbUser};
