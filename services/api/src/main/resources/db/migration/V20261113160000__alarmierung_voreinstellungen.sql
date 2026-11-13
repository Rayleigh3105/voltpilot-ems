-- Kunden-Alarmierung P2 · Voreinstellungen (Konzept vp-kunden-alarmierung-konzept §7, Entscheide KA-1 bis KA-5
-- vom 13.11.2026). Diese Migration trägt den BESTAND nach; die Vorgaben für Neues stehen im Code
-- (ZustellwegRepository, RuhezeitVorgabe, UeberwachungAnlegenService, UeberwachungRepository#seedAbWerk*).
--
-- Wiederholbar: jeder Schritt prüft seinen Zielzustand selbst (IF NOT EXISTS, ON CONFLICT, NOT @>), ein zweiter
-- Lauf derselben Datei ändert nichts. In Versionsreihenfolge auf frischer DB läuft sie auf leeren Tabellen.
--
-- KA-1 A · Die Anmelde-Adresse gilt sofort als E-Mail-Weg.
--   * zustellweg.herkunft: 'eigen' (die Person hat die Adresse selbst eingetragen und bestätigt, wie bisher)
--     oder 'anmeldung' (die Adresse des Kontos, ohne Bestätigungs-Mail - sie ist der Anmeldename).
--   * Jede Person mit Spiegelzeile und Adresse, die noch KEINEN E-Mail-Weg hat, bekommt ihn eingeschaltet, Stufe
--     wie jeder Weg ab Werk ('warnung' = Warnung und Dringend). Wer schon einen Weg hat - bestätigt, unbestätigt
--     oder abgeschaltet -, bleibt unberührt (ON CONFLICT DO NOTHING auf uq_zustellweg_person_weg).
--   * "Nur für neue Meldungen": erstellt_am des Weges ist der Stichtag. Der Zusteller sendet über einen Weg
--     'anmeldung' nichts zu einer Meldung, die vor diesem Zeitpunkt ausgelöst wurde (auch keine Erinnerung und
--     keine Entwarnung dazu) - Grund 'vor_dem_weg'.
--   * abmelde_token: je Weg ein fester, zufälliger Schlüssel (2 x gen_random_uuid = 244 Bit Zufall) für den Link
--     "Abmelden" in jeder Mail. Er schaltet den Weg ab (aktiv = false), ohne Anmeldung, ohne die Zeile zu löschen
--     - so bleibt "abgeschaltet" erhalten und kein späterer Lauf schaltet ihn wieder ein.
--   * Neue Konten: ein Trigger an benutzer legt den Weg beim Anlegen der Spiegelzeile an (jeder der fünf
--     Anlagewege - Start-Lauf der Bestandsübernahme, Selbstregistrierung, Portal, Admin-Konsole - schreibt
--     diese Zeile). Ändert sich die Adresse des Kontos, folgt ein Weg 'anmeldung' ihr; ein eigener nie.
-- KA-3 A · Eigene Überwachung meldet sofort.
--   * ueberwachung.probelauf_gewaehlt: der Probelauf ist ab jetzt eine Wahl im Formular (Vorgabe aus). Bis heute
--     gab es diese Wahl nicht - jede eigene Regel bekam ihn zwangsweise (UeberwachungAnlegenService bis
--     V20261113160000). Darum beendet diese Migration jeden laufenden Probelauf, den niemand gewählt hat. Eine
--     schon entstandene Probelauf-Meldung bleibt, was sie war (alarm.probelauf), es wird nichts nachgesendet.
-- KA-5 A · Im Unternehmen auch die Zuständigen am Standort.
--   * Regeln ab Werk, die heute an Kundenadministrator und Energiemanager gehen, nennen zusätzlich Bearbeiter und
--     Bedienberechtigt (Leser nicht). Der Preis-Hinweis (nur Kundenadministrator, nur Zuhause) bleibt, wie er ist.
--     Welche Meldung jemand bekommt, entscheidet beim Senden weiter die Sicht je Standort.

-- ----------------------------------------------------------------------------------------------- KA-1 · Spalten

ALTER TABLE zustellweg ADD COLUMN IF NOT EXISTS herkunft TEXT NOT NULL DEFAULT 'eigen';
ALTER TABLE zustellweg DROP CONSTRAINT IF EXISTS zustellweg_herkunft_chk;
ALTER TABLE zustellweg ADD CONSTRAINT zustellweg_herkunft_chk CHECK (herkunft IN ('eigen', 'anmeldung'));

ALTER TABLE zustellweg ADD COLUMN IF NOT EXISTS abmelde_token TEXT NOT NULL
    DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
-- Der Abmelde-Endpunkt hat keine Anmeldung und keinen Mandanten; er findet die Zeile nur über den Token.
CREATE UNIQUE INDEX IF NOT EXISTS uq_zustellweg_abmelde_token ON zustellweg (abmelde_token);

COMMENT ON COLUMN zustellweg.herkunft IS
    'Kunden-Alarmierung P2 (KA-1 A): eigen = selbst eingetragen und bestaetigt; anmeldung = die Adresse des Kontos, gilt ohne Bestaetigung, folgt einer geaenderten Kontoadresse, sendet nichts zu Meldungen vor erstellt_am.';
COMMENT ON COLUMN zustellweg.abmelde_token IS
    'Kunden-Alarmierung P2 (KA-1 A): fester Schluessel fuer den Link "Abmelden" in jeder Mail - schaltet den Weg ohne Anmeldung ab (aktiv = false).';

-- ------------------------------------------------------------------------------ KA-1 · neue Konten und Adressen

CREATE OR REPLACE FUNCTION zustellweg_aus_anmeldung() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.konto <> 'benutzer' OR NEW.email IS NULL OR btrim(NEW.email) = '' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.zustand <> 'entfernt' THEN
            INSERT INTO zustellweg (tenant_id, benutzer_sub, weg, ziel, bestaetigt_am, aktiv, herkunft)
            VALUES (NEW.tenant_id, NEW.sub, 'email', btrim(NEW.email), now(), true, 'anmeldung')
            ON CONFLICT (tenant_id, benutzer_sub, weg) DO NOTHING;
        END IF;
    ELSIF NEW.email IS DISTINCT FROM OLD.email THEN
        UPDATE zustellweg SET ziel = btrim(NEW.email), geaendert_am = now()
         WHERE tenant_id = NEW.tenant_id AND benutzer_sub = NEW.sub AND weg = 'email' AND herkunft = 'anmeldung';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS benutzer_zustellweg_anlegen ON benutzer;
CREATE TRIGGER benutzer_zustellweg_anlegen
    AFTER INSERT ON benutzer
    FOR EACH ROW EXECUTE FUNCTION zustellweg_aus_anmeldung();

DROP TRIGGER IF EXISTS benutzer_zustellweg_adresse ON benutzer;
CREATE TRIGGER benutzer_zustellweg_adresse
    AFTER UPDATE OF email ON benutzer
    FOR EACH ROW EXECUTE FUNCTION zustellweg_aus_anmeldung();

-- ------------------------------------------------------------------------------------------- KA-1 · der Bestand

INSERT INTO zustellweg (tenant_id, benutzer_sub, weg, ziel, bestaetigt_am, aktiv, herkunft)
SELECT b.tenant_id, b.sub, 'email', btrim(b.email), now(), true, 'anmeldung'
  FROM benutzer b
 WHERE b.konto = 'benutzer'
   AND b.zustand <> 'entfernt'
   AND b.email IS NOT NULL AND btrim(b.email) <> ''
ON CONFLICT (tenant_id, benutzer_sub, weg) DO NOTHING;

-- ------------------------------------------------------------------------------------------------------- KA-3

ALTER TABLE ueberwachung ADD COLUMN IF NOT EXISTS probelauf_gewaehlt BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN ueberwachung.probelauf_gewaehlt IS
    'Kunden-Alarmierung P2 (KA-3 A): true = die Person hat "Erst 30 Tage mitzaehlen" selbst gewaehlt. Vorher gab es keine Wahl; ein Probelauf ohne diese Marke war Zwang und wurde mit V20261113160000 beendet.';

UPDATE ueberwachung SET probelauf_bis = NULL, geaendert_am = now()
 WHERE probelauf_bis IS NOT NULL AND NOT probelauf_gewaehlt;

-- ------------------------------------------------------------------------------------------------------- KA-5

UPDATE ueberwachung
   SET empfaenger = empfaenger
           || CASE WHEN empfaenger @> '[{"rolle":"bearbeiter"}]' THEN '[]'::jsonb
                   ELSE '[{"rolle":"bearbeiter"}]'::jsonb END
           || CASE WHEN empfaenger @> '[{"rolle":"bedienberechtigt"}]' THEN '[]'::jsonb
                   ELSE '[{"rolle":"bedienberechtigt"}]'::jsonb END,
       geaendert_am = now()
 WHERE herkunft = 'ab_werk'
   AND empfaenger @> '[{"rolle":"kundenadministrator"},{"rolle":"energiemanager"}]'
   AND NOT (empfaenger @> '[{"rolle":"bearbeiter"},{"rolle":"bedienberechtigt"}]');
