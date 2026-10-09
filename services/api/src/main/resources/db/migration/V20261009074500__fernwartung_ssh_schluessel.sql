-- =============================================================================
-- V20261009074500 - Fernwartung: der öffentliche SSH-Schlüssel des Technikers
-- steht an seinem Zugang (Fenster-Schlüssel, Schritt 1 von 3).
-- -----------------------------------------------------------------------------
-- Entscheid des Kapitäns (09.10.2026): der Techniker hinterlegt seinen
-- öffentlichen SSH-Schlüssel einmal im Portal; solange ein Fenster offen ist,
-- holt sich die Box ihn über den Wartungstunnel und behält ihn nur bis zum Ende
-- des Fensters. Diese Migration trägt nur den ersten Schritt: das Feld und das
-- Protokoll. Ausgegeben wird der Schlüssel im Soll-Stand; dass eine Box ihn
-- abholt, kommt mit dem Tunnel-Dienst und dem Box-Skript (Schritte 2 und 3).
--
--   * Nur ein TECHNIKER-Zugang trägt einen SSH-Schlüssel, und er ist freiwillig:
--     ohne ihn öffnet ein Fenster weiter nur den Netzweg.
--   * Nur der ÖFFENTLICHE Teil, als eine Zeile "ssh-rsa <Base64>" ohne Optionen
--     und ohne Kommentar. Der Dropbear der Boxen nimmt nur RSA an; Länge und
--     Aufbau prüft die API (SshSchluessel), der CHECK hier ist der grobe Riegel
--     an der Datenbankgrenze.
--   * Anders als der WireGuard-Schlüssel ist er NICHT eindeutig: zwei Zugänge
--     desselben Technikers dürfen denselben SSH-Schlüssel tragen.
--   * Ein gelöschter Zugang behält seine Zeile unverändert (Trigger aus
--     V20261008213500), also auch seinen SSH-Schlüssel; im Soll-Stand steht er
--     nicht mehr.
--
-- Rechte: die Tabellenrechte der Admin-Rolle aus V20261007163700 gelten auch
-- für die neue Spalte; die App-Rolle hat weiter keines.
--
-- Steht für sich: jede Anweisung ist wiederholbar und setzt nur die Tabellen
-- aus V20261007163700 voraus, in Versionsreihenfolge wie bei später Ankunft.
-- =============================================================================

ALTER TABLE fernwartung_zugang ADD COLUMN IF NOT EXISTS ssh_public_key TEXT;

ALTER TABLE fernwartung_zugang DROP CONSTRAINT IF EXISTS fernwartung_zugang_ssh_art_chk;
ALTER TABLE fernwartung_zugang ADD CONSTRAINT fernwartung_zugang_ssh_art_chk
    CHECK (ssh_public_key IS NULL OR art = 'techniker');

-- "AAAAB3NzaC1yc2EA" ist der Anfang jedes RSA-Schlüssels: die Längenangabe und
-- das Wort "ssh-rsa" im Schlüssel selbst. 2048 Bit sind 372 Zeichen Base64,
-- 4096 Bit 716.
ALTER TABLE fernwartung_zugang DROP CONSTRAINT IF EXISTS fernwartung_zugang_ssh_form_chk;
ALTER TABLE fernwartung_zugang ADD CONSTRAINT fernwartung_zugang_ssh_form_chk
    CHECK (ssh_public_key IS NULL OR (
        ssh_public_key ~ '^ssh-rsa AAAAB3NzaC1yc2EA[A-Za-z0-9+/]+={0,2}$'
        AND length(ssh_public_key) BETWEEN 380 AND 724));

-- Das Protokoll kennt „SSH-Schlüssel gesetzt" und „entfernt". Die Wortliste
-- baut auf dem aktuellen Schema auf (V20261008213500) und nimmt nichts weg.
ALTER TABLE fernwartung_protokoll DROP CONSTRAINT IF EXISTS fernwartung_protokoll_aktion_chk;
ALTER TABLE fernwartung_protokoll ADD CONSTRAINT fernwartung_protokoll_aktion_chk CHECK (aktion IN (
    'box_schluessel_hinterlegt', 'box_schluessel_getauscht',
    'box_gesperrt', 'box_entsperrt',
    'techniker_angelegt', 'techniker_gesperrt', 'techniker_entsperrt', 'techniker_geloescht',
    'techniker_ssh_schluessel_gesetzt', 'techniker_ssh_schluessel_entfernt',
    'fenster_geoeffnet', 'fenster_geschlossen'));
