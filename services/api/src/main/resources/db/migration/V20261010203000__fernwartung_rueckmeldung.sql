-- =============================================================================
-- V20261010203000 - Fernwartung: die Rückmeldung des Tunnel-Dienstes
-- (Fenster-Schlüssel, Schritt 4).
-- -----------------------------------------------------------------------------
-- Entscheid des Kapitäns (K3 a, 08.10.2026): der Tunnel-Dienst darf dem Portal
-- Rückmeldung geben - nur Zustandsangaben, über eine eigene Route. Damit sieht
-- der Techniker, WARUM er nicht hineinkommt: Box nicht verbunden, Schlüssel
-- noch nicht abgeholt, kein SSH-Schlüssel am Zugang.
--
--   fernwartung_rueckmeldung_dienst   je Dienstkonto die letzte Meldung: wann
--                                     die API sie angenommen hat, seit wann
--                                     der Dienst läuft, ob er Schlüssel ausgibt.
--   fernwartung_rueckmeldung_box      je Box: verbunden seit, zuletzt nach
--                                     Schlüsseln gefragt.
--   fernwartung_rueckmeldung_fenster  je Fenster: Schlüssel abgeholt um.
--
-- Was hier steht, ist ANZEIGE. Der Soll-Stand (FernwartungService.soll), aus
-- dem der Dienst Peers, Fenster und Schlüsselausgabe ableitet, liest keine
-- dieser Tabellen - deshalb eigene Tabellen und keine Spalten an
-- fernwartung_zugang oder fernwartung_fenster.
--
-- "angenommen_am" ist die Uhr der API beim Annehmen der Meldung, je Zeile: das
-- Portal zeigt daran das Alter jeder Angabe und behandelt eine alte als
-- unbekannt. Unbekannt ist kein "nicht verbunden": verbunden_seit NULL heißt
-- "der Dienst hat gemeldet: nicht verbunden", eine fehlende oder alte Zeile
-- heißt "niemand weiß es".
--
-- Nur der letzte Stand, kein Verlauf: je Box, Fenster und Dienstkonto eine
-- Zeile, die jede Meldung überschreibt. Das Protokoll (fernwartung_protokoll)
-- bleibt davon unberührt. Gelöscht wird wie überall in der Fernwartung nichts.
--
-- GLOBALE Betriebsdaten wie die übrigen Fernwartungs-Tabellen (kein tenant_id,
-- O3: der Kunde sieht nichts davon): die App-Rolle bekommt kein Recht, RLS ohne
-- Policy ist der zweite Riegel; geschrieben und gelesen wird über
-- voltpilot_admin.
--
-- Steht für sich: jede Anweisung ist wiederholbar und setzt nur die Tabellen
-- aus V20261007163700 voraus, in Versionsreihenfolge wie bei später Ankunft.
-- =============================================================================

CREATE TABLE IF NOT EXISTS fernwartung_rueckmeldung_dienst (
    dienst            TEXT        PRIMARY KEY,
    angenommen_am     TIMESTAMPTZ NOT NULL,
    gemeldet_um       TIMESTAMPTZ NOT NULL,
    gestartet_um      TIMESTAMPTZ NOT NULL,
    schluesselausgabe BOOLEAN     NOT NULL,
    boxen             INTEGER     NOT NULL,
    fenster           INTEGER     NOT NULL,
    CONSTRAINT fernwartung_rueckmeldung_dienst_name_chk CHECK (btrim(dienst) <> ''),
    CONSTRAINT fernwartung_rueckmeldung_dienst_zeit_chk CHECK (gestartet_um <= gemeldet_um),
    CONSTRAINT fernwartung_rueckmeldung_dienst_zahl_chk CHECK (boxen >= 0 AND fenster >= 0)
);

-- Der zusammengesetzte Fremdschlüssel erzwingt wie in fernwartung_fenster,
-- dass die Zeile zu einer BOX gehört und nicht zu einem Techniker-Zugang.
CREATE TABLE IF NOT EXISTS fernwartung_rueckmeldung_box (
    box_id             UUID        PRIMARY KEY,
    box_art            TEXT        NOT NULL DEFAULT 'box',
    dienst             TEXT        NOT NULL,
    angenommen_am      TIMESTAMPTZ NOT NULL,
    verbunden_seit     TIMESTAMPTZ,
    zuletzt_gefragt_um TIMESTAMPTZ,
    CONSTRAINT fernwartung_rueckmeldung_box_art_chk CHECK (box_art = 'box'),
    CONSTRAINT fernwartung_rueckmeldung_box_fk FOREIGN KEY (box_id, box_art)
        REFERENCES fernwartung_zugang (id, art)
);

CREATE TABLE IF NOT EXISTS fernwartung_rueckmeldung_fenster (
    fenster_id             UUID        PRIMARY KEY REFERENCES fernwartung_fenster (id),
    dienst                 TEXT        NOT NULL,
    angenommen_am          TIMESTAMPTZ NOT NULL,
    schluessel_abgeholt_um TIMESTAMPTZ
);

-- -----------------------------------------------------------------------------
-- Rechte: wie V20261007163700. V2 und V4 vergeben per ALTER DEFAULT PRIVILEGES
-- alles an beide Rollen; für die App-Rolle zurück auf NICHTS, für die
-- Admin-Rolle auf Lesen, Anlegen und Überschreiben - kein DELETE.
-- -----------------------------------------------------------------------------
REVOKE ALL ON fernwartung_rueckmeldung_dienst, fernwartung_rueckmeldung_box,
    fernwartung_rueckmeldung_fenster FROM ${appDbUser};
REVOKE ALL ON fernwartung_rueckmeldung_dienst, fernwartung_rueckmeldung_box,
    fernwartung_rueckmeldung_fenster FROM ${adminDbUser};
GRANT SELECT, INSERT, UPDATE ON fernwartung_rueckmeldung_dienst, fernwartung_rueckmeldung_box,
    fernwartung_rueckmeldung_fenster TO ${adminDbUser};

ALTER TABLE fernwartung_rueckmeldung_dienst ENABLE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_rueckmeldung_dienst FORCE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_rueckmeldung_box ENABLE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_rueckmeldung_box FORCE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_rueckmeldung_fenster ENABLE ROW LEVEL SECURITY;
ALTER TABLE fernwartung_rueckmeldung_fenster FORCE ROW LEVEL SECURITY;
