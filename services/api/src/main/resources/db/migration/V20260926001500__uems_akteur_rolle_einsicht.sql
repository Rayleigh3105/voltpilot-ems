-- =============================================================================
-- UEMS — das Akteur-Vokabular kennt die Rolle „Einsicht“ (Folge zu AP-19 IP-12).
--
-- V20260925030000 hat `einsicht` als achte Rolle des Rechte-Vertrags angelegt
-- (zugriff_rolle(), bericht_abruf_actor_rolle_chk) und die übrigen festen
-- Rollen-Listen bewusst bei den sieben gelassen: „Einsicht schreibt nie“.
-- Das Akteur-Vokabular ist aber EIN Vokabular (V20260916010000): actor_rolle
-- nennt die Kennung des Rechte-Vertrags, und MessstelleMigrationTest hält es
-- Wort für Wort gegen RechteAbleitung.Rolle. Und ProtokollAkteur fällt ohne
-- handelnde Rolle auf die höchste zugewiesene zurück — bei einer Person, die
-- nur `einsicht` trägt, wäre das ein CHECK-Bruch (500) statt eines Eintrags.
-- Einsicht schreibt weiter nie (jede Schreibroute 403 recht_fehlt); der CHECK
-- kennt ihr Wort trotzdem.
--
-- Der Tausch ist GENERISCH, nicht Tabelle für Tabelle: jeder CHECK, der die
-- sieben Kennungen als feste Liste trägt (…, 'leser', 'unterstuetzer',
-- 'voltpilot_betrieb'), bekommt `einsicht` dahinter — actor_rolle der
-- Protokolle, die Urheber-/Freigeber-/Beantworter-Rollen, die Rolle im
-- Urheber der Ablesungen. Listen mit weniger Rollen (Freigabe nur durch
-- kundenadministrator/energiemanager/voltpilot_betrieb) bleiben, wie sie sind,
-- weil sie das Tripel 'leser', 'unterstuetzer', 'voltpilot_betrieb' nicht tragen.
-- Das sind heute 61 CHECKs an 59 Tabellen (frische DB), auch an
-- Bestandstabellen, deren CHECK auf `main` eine UEMS-Migration gesetzt hat —
-- der Tausch liest, was zur Laufzeit dasteht, und ist damit die VEREINIGUNG
-- mit jedem Stand, in jeder Ankunftsreihenfolge.
--
-- Bestand: keine Zeile wird geschrieben; der CHECK wird weiter, nie enger. Er
-- wird NOT VALID gesetzt und danach validiert (kürzere Sperre), außer er war
-- schon vorher nicht validiert — dann bleibt er es. Name bleibt.
-- =============================================================================

DO $$
DECLARE
    c RECORD;
    neu TEXT;
BEGIN
    FOR c IN
        SELECT con.conname, con.conrelid::regclass AS tabelle, con.convalidated,
               pg_get_constraintdef(con.oid) AS def
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace ns ON ns.oid = rel.relnamespace
         WHERE con.contype = 'c'
           AND ns.nspname = current_schema()
           AND con.coninhcount = 0
           AND pg_get_constraintdef(con.oid)
               ~ '''leser''::text, ''unterstuetzer''::text, ''voltpilot_betrieb''::text\]'
           AND pg_get_constraintdef(con.oid) NOT LIKE '%''einsicht''%'
         ORDER BY con.conrelid::regclass::text, con.conname
    LOOP
        neu := regexp_replace(c.def,
            '(''leser''::text, ''unterstuetzer''::text, ''voltpilot_betrieb''::text)\]',
            '\1, ''einsicht''::text]', 'g');
        neu := regexp_replace(neu, '\s+NOT VALID$', '');
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I %s NOT VALID',
                       c.tabelle, c.conname, c.conname, neu);
        IF c.convalidated THEN
            EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tabelle, c.conname);
        END IF;
        RAISE NOTICE 'einsicht an %.%', c.tabelle, c.conname;
    END LOOP;
END $$;
