-- UEMS AP-18 IP-7: der Anstoß am Vorgang, Pfad 2 (Z5, §5.6).
--
-- Der Struktur-Läufer schreibt den Anstoß am Energieziel (`vorgang_anstoss`,
-- Arten `messgrundlage_beendet · messgrundlage_neu_gefasst`) und seine
-- Protokollzeile `anstoss_gesetzt` in DERSELBEN Transaktion wie den Anstoß an der
-- Bezugsbasis — mit der administrativen Rolle (Muster V20260924200500). IP-5/IP-9
-- geben ihr auf diesen Tabellen nur SELECT, DELETE (Offboarding); hier kommt nur
-- INSERT dazu. `massnahme_aenderung` gleich mit: Pfad 2 an Maßnahmen (IP-17)
-- schreibt dieselbe Protokollzeile. Kein UPDATE, kein DELETE, nichts für die
-- App-Rolle.
--
-- Späte Ankunft (out-of-order): fehlt eine Tabelle noch, ohne GRANT für sie.
DO $$
BEGIN
    IF to_regclass('vorgang_anstoss') IS NOT NULL THEN
        EXECUTE 'GRANT INSERT ON vorgang_anstoss TO ${adminDbUser}';
    END IF;
    IF to_regclass('energieziel_aenderung') IS NOT NULL THEN
        EXECUTE 'GRANT INSERT ON energieziel_aenderung TO ${adminDbUser}';
    END IF;
    IF to_regclass('massnahme_aenderung') IS NOT NULL THEN
        EXECUTE 'GRANT INSERT ON massnahme_aenderung TO ${adminDbUser}';
    END IF;
END $$;
