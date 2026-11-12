-- =============================================================================
-- V20261112152000 - Der Löschlauf: das Löschen eines Kundenbereichs läuft
--                   serverseitig als Auftrag (Befund vp-kunde-loeschen-504).
-- -----------------------------------------------------------------------------
-- In Produktion brauchte der Löschzug ~60 s und der Ingress (60-s-Grenze)
-- antwortete 504 - der Zug lief serverseitig durch, das Portal zeigte
-- fälschlich „fehlgeschlagen". Das Löschen darf nicht davon abhängen, dass
-- EIN HTTP-Request unter 60 s fertig wird: POST …/delete startet nur noch den
-- Lauf (202) und schreibt hier EINE Zeile; das Portal fragt den Stand ab
-- (GET …/loeschlauf), bis der Lauf „fertig" oder „gescheitert" meldet.
--
--   * `stand = 'fertig'` schreibt der Lauf IN der Abbau-Transaktion
--     (Abbauwache, nach dem Löschnachweis): fertig heißt committed. Ein
--     Absturz davor rollt den Abbau zurück - die Zeile bleibt „laeuft" mit
--     altem Herzschlag, und Start wie Statusweg lösen sie ehrlich auf
--     (Mandant noch da -> „gescheitert, nichts gelöscht"; Mandant weg ->
--     „fertig", nur der Bericht fehlt).
--   * `herzschlag_am` schlägt alle 30 s, solange der Lauf arbeitet. Der
--     Teil-Index erlaubt je Kundenbereich EINEN laufenden Zug: ein Doppelklick
--     oder zweiter Versuch bekommt denselben Lauf zurück, nie einen zweiten.
--   * Wie `kundenbereich_geloescht_protokoll` (keine Kundenzeile, kein RLS,
--     kein Fremdschlüssel auf tenant - der Lauf überlebt den Kundenbereich);
--     der Name steht drin, damit das Portal den Lauf benennen kann.
--   * `bericht`: der Abschlussbericht des Löschwegs (Zählungen, Konten,
--     freigegebene Boxen, Löschnachweis-Kennzeichen) als JSON, nach dem
--     Commit nachgetragen (best effort - fertig bleibt fertig, auch wenn der
--     Bericht bei einem Absturz dazwischen verloren geht).
--
-- Nur der Betrieb: die Admin-Rolle liest, legt an und schreibt den Stand
-- fort; die App-Rolle sieht die Tabelle nicht. Neue, leere Tabelle.
-- =============================================================================

CREATE TABLE IF NOT EXISTS kundenbereich_loeschlauf (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kundenbereich      UUID        NOT NULL,
    name               TEXT        NOT NULL,
    gestartet_von_sub  TEXT        NOT NULL,
    gestartet_von_name TEXT        NOT NULL,
    gestartet_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
    herzschlag_am      TIMESTAMPTZ NOT NULL DEFAULT now(),
    beendet_am         TIMESTAMPTZ,
    stand              TEXT        NOT NULL DEFAULT 'laeuft',
    fehler             TEXT,
    bericht            JSONB,
    CONSTRAINT kundenbereich_loeschlauf_stand_chk
        CHECK (stand IN ('laeuft', 'fertig', 'gescheitert')),
    CONSTRAINT kundenbereich_loeschlauf_ende_chk
        CHECK ((stand = 'laeuft') = (beendet_am IS NULL)),
    CONSTRAINT kundenbereich_loeschlauf_fehler_chk
        CHECK (fehler IS NULL OR stand = 'gescheitert'),
    CONSTRAINT kundenbereich_loeschlauf_name_chk
        CHECK (btrim(name) <> '' AND btrim(gestartet_von_sub) <> '' AND btrim(gestartet_von_name) <> '')
);

-- Je Kundenbereich höchstens EIN laufender Zug (Doppelklick-Schutz).
CREATE UNIQUE INDEX IF NOT EXISTS uq_kundenbereich_loeschlauf_laeuft
    ON kundenbereich_loeschlauf (kundenbereich) WHERE stand = 'laeuft';
-- Der Statusweg liest den jüngsten Lauf des Bereichs.
CREATE INDEX IF NOT EXISTS idx_kundenbereich_loeschlauf_bereich
    ON kundenbereich_loeschlauf (kundenbereich, gestartet_am DESC);

REVOKE ALL ON kundenbereich_loeschlauf FROM ${appDbUser};
REVOKE ALL ON kundenbereich_loeschlauf FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON kundenbereich_loeschlauf TO ${adminDbUser};
