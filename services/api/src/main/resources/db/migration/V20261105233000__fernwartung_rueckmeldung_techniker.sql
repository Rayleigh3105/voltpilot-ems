-- =============================================================================
-- V20261105233000 - Fernwartung: letzter WireGuard-Handshake je Techniker-Zugang
-- aus der Rückmeldung des Tunnel-Dienstes.
-- -----------------------------------------------------------------------------
-- Die Tabelle der Techniker-Zugänge im Portal zeigt je Zugang, wann sein Gerät
-- zuletzt einen Handshake mit dem Wartungsserver hatte. Der Tunnel-Dienst liest
-- ihn aus `wg show … latest-handshakes` und meldet ihn additiv im Feld
-- `techniker` der Rückmeldung (docs/contracts/fernwartung-rueckmeldung-v1.md).
--
--   fernwartung_rueckmeldung_techniker   je Techniker-Zugang: letzter
--                                        Handshake um (NULL: der Server kennt
--                                        keinen).
--
-- Wie V20261010203000 ist das ANZEIGE: der Soll-Stand liest diese Tabelle nie.
-- Eine fehlende oder alte Zeile heißt "unbekannt", nicht "noch nie". Nur der
-- letzte Stand, kein Verlauf; kein Schlüssel und keine Endpunkt-Adresse.
--
-- GLOBALE Betriebsdaten (kein tenant_id): die App-Rolle bekommt kein Recht,
-- RLS ohne Policy ist der zweite Riegel; geschrieben und gelesen wird über
-- voltpilot_admin.
--
-- Steht für sich: jede Anweisung ist wiederholbar und setzt nur
-- fernwartung_zugang aus V20261007163700 voraus, in Versionsreihenfolge wie
-- bei später Ankunft.
-- =============================================================================

-- Der zusammengesetzte Fremdschlüssel erzwingt, dass die Zeile zu einem
-- TECHNIKER-Zugang gehört und nicht zu einer Box.
CREATE TABLE IF NOT EXISTS fernwartung_rueckmeldung_techniker (
    techniker_id         UUID        PRIMARY KEY,
    techniker_art        TEXT        NOT NULL DEFAULT 'techniker',
    dienst               TEXT        NOT NULL,
    angenommen_am        TIMESTAMPTZ NOT NULL,
    letzter_handshake_um TIMESTAMPTZ,
    CONSTRAINT fernwartung_rueckmeldung_techniker_art_chk CHECK (techniker_art = 'techniker'),
    CONSTRAINT fernwartung_rueckmeldung_techniker_fk FOREIGN KEY (techniker_id, techniker_art)
        REFERENCES fernwartung_zugang (id, art)
);

REVOKE ALL ON fernwartung_rueckmeldung_techniker FROM ${appDbUser};
REVOKE ALL ON fernwartung_rueckmeldung_techniker FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON fernwartung_rueckmeldung_techniker TO ${adminDbUser};

ALTER TABLE fernwartung_rueckmeldung_techniker ENABLE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_rueckmeldung_techniker FORCE ROW LEVEL SECURITY;
