-- =============================================================================
-- UEMS AP-12 IP-9 — das Wasserzeichen des Strukturänderungs-Läufers (E6 = A,
-- Pfad 2; Vertrag docs/contracts/v2/bericht.md §7 B3).
--
-- `bericht_struktur_gelesen` hält je gelesener Zeile eines Änderungsprotokolls
-- (`ort_aenderung`, `messstelle_aenderung`) GENAU EINE Zeile: das Urteil der Regel
-- `struktur` (die Anstoß-Art oder der Grund, warum keiner) und wie viele Einträge
-- die Naht traf. Der Läufer (uems/StrukturAenderungLaeufer) schreibt sie in
-- DERSELBEN Transaktion wie seine Aufrufe der Naht:
--
--   * bricht die Transaktion ab, gibt es die Zeile nicht, und der nächste Takt
--     liest den Eintrag wieder — nichts wird übersprungen;
--   * gibt es die Zeile, liest er den Eintrag nie wieder — nichts läuft zweimal.
--
-- Warum eine Zeile je Eintrag und kein Zeiger „bis id n“: `id` ist ein BIGSERIAL
-- und wird beim INSERT vergeben, sichtbar wird die Zeile erst beim COMMIT. Eine
-- Transaktion mit id 10, die nach der mit id 11 committet, fiele hinter einem
-- Zeiger still durch. Kandidaten sind wenige (Strukturänderungen tippt ein
-- Mensch), die Anti-Verknüpfung über den Primärschlüssel ist billig.
--
-- Nicht mandantengebunden: ein Betriebszustand wie messreihe_viertelstunde_lauf,
-- kein Kundendatum — der Mandant steht an der Protokollzeile. Darum ohne RLS, und
-- die App-Rolle bekommt gar nichts; die Verwaltungsrolle liest und fügt an, nie
-- mehr. Eine NEUE, LEERE Tabelle: keine Bestandszeile ändert sich, kein
-- Fremdschlüssel zeigt auf sie oder von ihr weg, kein Trigger hängt an einer
-- bestehenden Tabelle — frische Datenbank und späte Ankunft verhalten sich gleich.
-- =============================================================================

CREATE TABLE IF NOT EXISTS bericht_struktur_gelesen (
    protokoll    TEXT        NOT NULL,
    eintrag_id   BIGINT      NOT NULL,
    -- Die Anstoß-Art (bericht-vectors.json → vokabulare.anstoss_art) oder der
    -- Grund ohne Anstoß (→ vokabulare.kein_anstoss).
    urteil       TEXT        NOT NULL,
    -- Einträge von BerichteNaht.betroffene (Stand oder Entwurf je Bericht).
    berichte     INTEGER     NOT NULL DEFAULT 0,
    gelesen_am   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bericht_struktur_gelesen_pk PRIMARY KEY (protokoll, eintrag_id),
    CONSTRAINT bericht_struktur_gelesen_protokoll_chk
        CHECK (protokoll IN ('ort_aenderung', 'messstelle_aenderung')),
    CONSTRAINT bericht_struktur_gelesen_urteil_chk CHECK (btrim(urteil) <> ''),
    CONSTRAINT bericht_struktur_gelesen_berichte_chk CHECK (berichte >= 0)
);

REVOKE ALL ON bericht_struktur_gelesen FROM ${appDbUser};
GRANT SELECT, INSERT ON bericht_struktur_gelesen TO ${adminDbUser};

COMMENT ON TABLE bericht_struktur_gelesen IS
    'AP-12 IP-9: das Wasserzeichen des Strukturänderungs-Läufers — je gelesener Zeile '
    'von ort_aenderung/messstelle_aenderung genau eine Zeile (Urteil, getroffene Einträge), '
    'geschrieben in der Transaktion der Naht-Aufrufe. Betriebszustand ohne Mandant, ohne RLS.';
