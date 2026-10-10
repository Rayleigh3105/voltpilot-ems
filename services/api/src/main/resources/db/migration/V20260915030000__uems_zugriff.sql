-- =============================================================================
-- UEMS AP-03 IP-2: das FUNDAMENT DER RECHTE — Benutzer-Spiegel, Zuweisung,
-- Zugriffsprotokoll (Konzept vp-uems-ap03-rechte §4.1, §4.4, §4.7, §4.8, §6.3,
-- §6.6, §8 IP-2; Captain-Entscheide E1, E5, E6, E11, E12 = A vom 10.09.2026).
-- Maßgeblich ist der Rechte-Vertrag aus IP-1 (PR 659):
-- docs/contracts/v2/rechte-vectors.json + rechte-matrix.json mit dem Modul
-- uems/RechteAbleitung — jede Regel hier sagt DASSELBE wie dort;
-- UemsZugriffMigrationTest liest beide Dateien und spielt sie gegen die
-- Datenbank.
--
-- Drei mandantengebundene Tabellen, rein additiv (keine bestehende Tabelle, kein
-- Vertrag, keine Route und kein Lauf wird berührt — NOCH SETZT NIEMAND DURCH):
--
--   benutzer           der Spiegel eines Kontos im Kundenbereich (Keycloak bleibt
--                      die Identität, E11): Anzeige, Zustand, letzte Anmeldung
--   zugriff            die Zuweisung Benutzer × Rolle × Geltungsbereich ×
--                      Gültigkeit — auch die Unterstützung (Rolle Unterstützer
--                      mit Art und Umfang, E6–E9)
--   zugriff_protokoll  wer wem was wann gab oder nahm (Invariante 10)
--
-- Den BESTAND (E12: „jeder heutige Kundenbenutzer wird Kundenadministrator",
-- auch die Träger von `admin`/`site-admin`) schreibt NICHT diese Migration: die
-- Kundenbenutzer stehen in Keycloak, nicht in der Datenbank. Das tut der
-- Start-Lauf zugriff/ZugriffBestandLaeufer (Muster BestandsuebernahmeLaeufer)
-- und — für jedes danach angelegte Konto — das Ereignis KundenbenutzerAngelegt.
-- Nach dieser Migration sind alle drei Tabellen LEER.
--
-- DIE VOKABULARE KOMMEN AUS DEM VERTRAG. zugriff_vokabular() ist die EINE Stelle
-- in der Datenbank für die Wortlisten `vokabular.konto|konto_zustand|art|umfang|
-- aenderung` der Vektor-Datei, Zeile für Zeile in ihrer Reihenfolge;
-- zugriff_rolle() ist Zeile für Zeile `rollen` der Matrix-Datei (Kennung,
-- Geltungsbereich, zuweisbar). Jeder CHECK auf ein Wort fragt sie über
-- zugriff_wort() bzw. zugriff_rolle_geltung(); keiner trägt eine eigene Liste.
-- `ocpp_stufe`, `unterstuetzung_zustand` und `rolle_noetig_reihenfolge` sind
-- Wörter von ABLEITUNGEN, keine Spalte — der Test verlangt für jeden Block des
-- Vertrags diese Entscheidung. Weitet der Vertrag ein Vokabular, druckt der Test
-- den VALUES-Block; eine NEUE Migration ersetzt dann nur die Funktion.
--
-- ⚠ DAS PROTOKOLL SPRICHT DEN VERTRAG: `aktion` ∈ vokabular.aenderung
-- (zuweisen · entziehen · sperren · entfernen). Die Bestandsübernahme ist ein
-- `zuweisen` mit dem Urheber „Bestandsübernahme" (VoltPilot ohne Person, wie
-- ProtokollAkteur.bestandsuebernahme()). Braucht ein späterer Schreibweg ein
-- weiteres Wort (gewähren, verlängern, erste Anmeldung — IP-8/IP-14), weitet er
-- ZUERST den Vertrag.
--
-- DIE ROLLE BESTIMMT DEN GELTUNGSBEREICH (§4.2, E1, E5):
--   * Geltungsbereich `unternehmen` (Kundenadministrator, Energiemanager) —
--     `standort_id` IST NULL: das ist die mandantenweite Zuweisung, „alle
--     Standorte, auch künftige";
--   * `standort` (Bearbeiter, Bedienberechtigt, Leser) — GENAU EIN Standort je
--     Zeile; eine Zuweisung an drei Standorte sind drei Zeilen;
--   * `standort_befristet` (Unterstützer) — ein Standort, Art UND Umfang UND ein
--     Ende (E6: Enddatum Pflicht);
--   * `plattform` (VoltPilot-Betrieb) ist KEINE Zuweisung — die Plattform-Rolle
--     trägt das Konto in Keycloak; VoltPilot erreicht einen Kundenbereich nur als
--     Unterstützer (E8).
--
-- ZEIT (Vertrag, Fakt 6 in uems-rechte-matrix-als-daten-und-rechte-v.md;
-- RechteAbleitung.Zuweisung.wirksam und bisZeitpunkt):
--   * `gueltig_ab` ist ein ZEITPUNKT;
--   * `gueltig_bis` ist das ENDDATUM — ein Kalendertag, EINSCHLIESSLICH (`bis` =
--     letzter Tag, wie jede tagesgenaue Zuordnung des Programms): „bis
--     15.12.2026" endet am 16.12.2026 00:00 in `zeitzone`;
--   * `endet_am` ist dieses Ende als Zeitpunkt (ausschließend) — der CHECK
--     zugriff_ende_chk hält beide zeichengleich zu bisZeitpunkt(); NUR der
--     Notfall-Zugriff (E8) trägt allein einen Zeitpunkt (24 h);
--   * `beendet_am` beendet vorzeitig (Entzug, Beenden einer Unterstützung) — mit
--     `beendet_von` und optionalem `beendet_grund` (§4.7 „Grund (optional)");
--   * wirksam zu t  ⇔  t ∈ zugriff_zeitraum(gueltig_ab, endet_am, beendet_am),
--     halboffen [ab, früheres Ende). Ein vor seinem Beginn beendeter Zugriff ist
--     leer und wirkte nie.
--
-- ⚠ EIN ZUGRIFF WIRD NIE UMGESCHRIEBEN — nur EINMAL beendet und neu angelegt
-- (§4.8 „archiviert → neu: immer ein NEUER Eintrag", AP-00 Invariante 4; Muster
-- messstelle_quelle): der Trigger zugriff_nur_beenden lehnt jede andere Änderung
-- ab, von jeder Rolle; die Spaltenrechte nehmen sie zusätzlich weg. Gelöscht
-- wird nie (kein DELETE der App-Rolle) — nur das Offboarding räumt ab.
--
-- ÜBERLAPPUNGSVERBOT je (Benutzer, Rolle, Standort) — die mandantenweite Zeile
-- (Standort NULL) zählt als EIN Geltungsbereich: Exklusion
-- zugriff_keine_ueberlappung über den wirksamen Zeitraum. Dieselbe Rolle an einem
-- anderen Standort oder eine andere Rolle am selben Standort überlappt nicht.
--
-- WAS DIE DATENBANK NICHT PRÜFT (Regeln der Schreibwege — sie brauchen den
-- Aufrufer, die Uhr oder den Kalender der Zone): höchstens 12 Monate und die
-- Vorgabe 30 Tage einer Unterstützung (E6, `hoechstens_12_monate`), genau 24 h
-- Notfall (`regeln.notfall_stunden`), letzter Kundenadministrator (409), eigene
-- Zuweisung (409), „Entzug wirkt sofort" (beendet_am = jetzt), Grund Pflicht beim
-- Notfall (`grund_fehlt`) — IP-8/IP-9/IP-13.
--
-- ⚠ DER MANDANT REIST IN JEDEM VERWEIS MIT (ein Fremdschlüssel prüft ohne RLS);
-- `tenant_id` steht VORN in jedem Schlüssel und in der Exklusion. Jeder Verweis
-- ist ON DELETE RESTRICT; TenantRepository.offboard räumt alle drei ab, Kinder
-- zuerst (Protokoll → Zugriff → Benutzer).
--
-- Nicht dieses Paket: Keycloak `partner` (IP-3), ZugriffContext und /me (IP-4),
-- RLS-Policy site_scope (IP-5), jede Durchsetzung (IP-6 ff.), jede Route und
-- jede Fläche.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Die Vokabulare des Vertrags (siehe Kopf). `nr` ist die Stelle im Vertrag.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION zugriff_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('konto', 1, 'benutzer'),
    ('konto', 2, 'partner'),
    ('konto', 3, 'plattform'),
    ('konto_zustand', 1, 'angelegt'),
    ('konto_zustand', 2, 'aktiv'),
    ('konto_zustand', 3, 'gesperrt'),
    ('konto_zustand', 4, 'entfernt'),
    ('art', 1, 'installateur'),
    ('art', 2, 'voltpilot'),
    ('art', 3, 'notfall'),
    ('umfang', 1, 'ansehen'),
    ('umfang', 2, 'einrichten'),
    ('umfang', 3, 'einrichten_und_bedienen'),
    ('aenderung', 1, 'zuweisen'),
    ('aenderung', 2, 'entziehen'),
    ('aenderung', 3, 'sperren'),
    ('aenderung', 4, 'entfernen')
$$;

-- Steht `p_wort` im Vokabular `p_vokabular`? NULL ist nie ein Wort. (Schema
-- ausgeschrieben: ein CHECK wird auch unter leerem search_path geprüft.)
CREATE OR REPLACE FUNCTION zugriff_wort(p_vokabular TEXT, p_wort TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS (SELECT 1 FROM public.zugriff_vokabular() v
                 WHERE v.vokabular = p_vokabular AND v.wort = p_wort)
$$;

-- Die Rollen der Matrix, Zeile für Zeile `rollen` von rechte-matrix.json.
CREATE OR REPLACE FUNCTION zugriff_rolle()
RETURNS TABLE (nr INTEGER, rolle TEXT, geltungsbereich TEXT, zuweisbar BOOLEAN)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    (1, 'kundenadministrator', 'unternehmen', true),
    (2, 'energiemanager', 'unternehmen', true),
    (3, 'bearbeiter', 'standort', true),
    (4, 'bedienberechtigt', 'standort', true),
    (5, 'leser', 'standort', true),
    (6, 'unterstuetzer', 'standort_befristet', false),
    (7, 'voltpilot_betrieb', 'plattform', false)
$$;

-- Der Geltungsbereich einer Rolle; NULL für ein Wort, das keine Rolle ist.
CREATE OR REPLACE FUNCTION zugriff_rolle_geltung(p_rolle TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT r.geltungsbereich FROM public.zugriff_rolle() r WHERE r.rolle = p_rolle
$$;

-- Der wirksame Zeitraum einer Zuweisung: [ab, früheres von Ende und Beenden).
-- Offen ohne beides; leer, wenn vor dem Beginn beendet (LEAST überspringt NULL).
CREATE OR REPLACE FUNCTION zugriff_zeitraum(p_ab TIMESTAMPTZ, p_endet TIMESTAMPTZ, p_beendet TIMESTAMPTZ)
RETURNS tstzrange LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
           WHEN p_endet IS NULL AND p_beendet IS NULL THEN tstzrange(p_ab, NULL, '[)')
           ELSE tstzrange(p_ab, GREATEST(p_ab, LEAST(p_endet, p_beendet)), '[)')
         END
$$;

-- -----------------------------------------------------------------------------
-- benutzer — der Spiegel eines Kontos in EINEM Kundenbereich (§6.3). Ein Partner-
-- oder VoltPilot-Konto (ohne tenant_id) bekommt seinen Spiegel in dem
-- Kundenbereich, der ihm eine Unterstützung gewährt (`konto`).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS benutzer (
    tenant_id          UUID        NOT NULL,
    -- das Keycloak-Subject, maschinenstabil; nie geändert
    sub                TEXT        NOT NULL,
    konto              TEXT        NOT NULL,
    anzeigename        TEXT        NOT NULL,
    email              TEXT,
    zustand            TEXT        NOT NULL,
    eingeladen_am      TIMESTAMPTZ,
    eingeladen_von     TEXT,
    angenommen_am      TIMESTAMPTZ,
    zuletzt_angemeldet TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT benutzer_pkey PRIMARY KEY (tenant_id, sub),
    CONSTRAINT benutzer_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT benutzer_konto_chk CHECK (coalesce(zugriff_wort('konto', konto), false)),
    CONSTRAINT benutzer_zustand_chk CHECK (coalesce(zugriff_wort('konto_zustand', zustand), false)),
    CONSTRAINT benutzer_sub_chk CHECK (sub <> '' AND sub = btrim(sub)),
    CONSTRAINT benutzer_anzeigename_chk CHECK (btrim(anzeigename) <> ''),
    CONSTRAINT benutzer_email_chk CHECK (email IS NULL OR btrim(email) <> ''),
    CONSTRAINT benutzer_eingeladen_chk
        CHECK (eingeladen_von IS NULL OR (eingeladen_am IS NOT NULL AND eingeladen_von <> '')),
    -- „angelegt" heißt: die erste Anmeldung steht aus (§4.8, E14 = B).
    CONSTRAINT benutzer_angelegt_chk CHECK (zustand <> 'angelegt' OR angenommen_am IS NULL)
);

-- -----------------------------------------------------------------------------
-- zugriff — die Zuweisung (§4.1, E11). Siehe Kopf: Geltungsbereich, Zeit, nie
-- umgeschrieben, Überlappungsverbot.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zugriff (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID        NOT NULL,
    benutzer_sub   TEXT        NOT NULL,
    rolle          TEXT        NOT NULL,
    -- NULL = mandantenweit (Rolle mit Geltungsbereich `unternehmen`)
    standort_id    UUID,
    art            TEXT,
    umfang         TEXT,
    gueltig_ab     TIMESTAMPTZ NOT NULL,
    -- das Enddatum, letzter Tag EINSCHLIESSLICH
    gueltig_bis    DATE,
    -- das Ende als Zeitpunkt, ausschließend (siehe Kopf)
    endet_am       TIMESTAMPTZ,
    zeitzone       TEXT        NOT NULL,
    -- das Subject der gewährenden Person; NULL = keine Person (Bestandsübernahme,
    -- E12) — der Protokolleintrag nennt den Urheber
    gewaehrt_von   TEXT,
    beendet_am     TIMESTAMPTZ,
    beendet_von    TEXT,
    beendet_grund  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_zugriff_id_tenant UNIQUE (id, tenant_id),
    CONSTRAINT zugriff_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT zugriff_benutzer_fk FOREIGN KEY (tenant_id, benutzer_sub)
        REFERENCES benutzer (tenant_id, sub) ON DELETE RESTRICT,
    CONSTRAINT zugriff_standort_fk FOREIGN KEY (standort_id, tenant_id)
        REFERENCES standort (id, tenant_id) ON DELETE RESTRICT,
    -- Jede Rolle der Matrix außer der Plattform-Rolle.
    CONSTRAINT zugriff_rolle_chk CHECK (coalesce(zugriff_rolle_geltung(rolle) <> 'plattform', false)),
    CONSTRAINT zugriff_art_chk CHECK (art IS NULL OR coalesce(zugriff_wort('art', art), false)),
    CONSTRAINT zugriff_umfang_chk CHECK (umfang IS NULL OR coalesce(zugriff_wort('umfang', umfang), false)),
    -- Unternehmensweit ohne Standort, sonst genau einer.
    CONSTRAINT zugriff_geltungsbereich_chk
        CHECK (coalesce((zugriff_rolle_geltung(rolle) = 'unternehmen') = (standort_id IS NULL), false)),
    -- Die Unterstützung (und nur sie) trägt Art, Umfang und ein Ende.
    CONSTRAINT zugriff_unterstuetzung_chk
        CHECK (coalesce((zugriff_rolle_geltung(rolle) = 'standort_befristet') = (art IS NOT NULL), false)
               AND (art IS NULL) = (umfang IS NULL)
               AND (art IS NULL OR endet_am IS NOT NULL)),
    CONSTRAINT zugriff_zeitzone_chk
        CHECK (zeitzone IN ('Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich')),
    -- Enddatum und Zeitpunkt sind EINE Tatsache (bisZeitpunkt); nur der Notfall
    -- trägt allein den Zeitpunkt. Ein Ende liegt nach dem Beginn.
    CONSTRAINT zugriff_ende_chk
        CHECK (CASE
                   WHEN art = 'notfall' THEN gueltig_bis IS NULL AND endet_am IS NOT NULL
                   ELSE (gueltig_bis IS NULL) = (endet_am IS NULL)
                        AND (gueltig_bis IS NULL
                             OR endet_am = ((gueltig_bis + 1)::timestamp AT TIME ZONE zeitzone))
               END
               AND (endet_am IS NULL OR endet_am > gueltig_ab)),
    CONSTRAINT zugriff_beendet_chk
        CHECK ((beendet_am IS NULL) = (beendet_von IS NULL)
               AND (beendet_von IS NULL OR beendet_von <> '')
               AND (beendet_grund IS NULL OR (beendet_am IS NOT NULL AND btrim(beendet_grund) <> ''))),
    CONSTRAINT zugriff_gewaehrt_von_chk CHECK (gewaehrt_von IS NULL OR gewaehrt_von <> ''),
    CONSTRAINT zugriff_keine_ueberlappung EXCLUDE USING gist (
        tenant_id WITH =,
        benutzer_sub WITH =,
        rolle WITH =,
        (coalesce(standort_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
        (public.zugriff_zeitraum(gueltig_ab, endet_am, beendet_am)) WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_zugriff_standort
    ON zugriff (tenant_id, standort_id) WHERE standort_id IS NOT NULL;

-- Nie umgeschrieben, nur EINMAL beendet — von jeder Rolle.
CREATE OR REPLACE FUNCTION zugriff_nur_beenden()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.beendet_am IS NOT NULL THEN
        RAISE EXCEPTION 'Der Zugriff % ist beendet und bleibt es', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'zugriff_einmal_beendet';
    END IF;
    IF NEW.beendet_am IS NULL
       OR (NEW.id, NEW.tenant_id, NEW.benutzer_sub, NEW.rolle, NEW.standort_id, NEW.art, NEW.umfang,
           NEW.gueltig_ab, NEW.gueltig_bis, NEW.endet_am, NEW.zeitzone, NEW.gewaehrt_von, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.benutzer_sub, OLD.rolle, OLD.standort_id, OLD.art, OLD.umfang,
           OLD.gueltig_ab, OLD.gueltig_bis, OLD.endet_am, OLD.zeitzone, OLD.gewaehrt_von, OLD.created_at) THEN
        RAISE EXCEPTION 'Ein Zugriff wird nie umgeschrieben, nur beendet und neu angelegt (%)', OLD.id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'zugriff_nur_beenden';
    END IF;
    RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS zugriff_nur_beenden ON zugriff;
CREATE TRIGGER zugriff_nur_beenden BEFORE UPDATE ON zugriff
    FOR EACH ROW EXECUTE FUNCTION zugriff_nur_beenden();

-- -----------------------------------------------------------------------------
-- zugriff_protokoll — Zeit · wer · wen · was · Geltungsbereich · gültig ab/bis ·
-- Grund (§4.4 Regel 10, §6.3). Append-only über die Rechte; Name UND Subject des
-- Betroffenen bleiben, auch wenn das Konto entfernt ist (§4.7).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zugriff_protokoll (
    id                BIGSERIAL   PRIMARY KEY,
    tenant_id         UUID        NOT NULL,
    aktion            TEXT        NOT NULL,
    betroffener_sub   TEXT        NOT NULL,
    betroffener_name  TEXT        NOT NULL,
    zugriff_id        UUID,
    rolle             TEXT,
    standort_id       UUID,
    art               TEXT,
    umfang            TEXT,
    gueltig_ab        TIMESTAMPTZ,
    gueltig_bis       DATE,
    endet_am          TIMESTAMPTZ,
    grund             TEXT,
    actor_sub         TEXT,
    actor_name        TEXT        NOT NULL,
    actor_rolle       TEXT,
    actor_art         TEXT        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT zugriff_protokoll_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT zugriff_protokoll_zugriff_fk FOREIGN KEY (zugriff_id, tenant_id)
        REFERENCES zugriff (id, tenant_id) ON DELETE RESTRICT,
    CONSTRAINT zugriff_protokoll_aktion_chk CHECK (coalesce(zugriff_wort('aenderung', aktion), false)),
    CONSTRAINT zugriff_protokoll_rolle_chk
        CHECK (rolle IS NULL OR coalesce(zugriff_rolle_geltung(rolle) <> 'plattform', false)),
    CONSTRAINT zugriff_protokoll_art_chk CHECK (art IS NULL OR coalesce(zugriff_wort('art', art), false)),
    CONSTRAINT zugriff_protokoll_umfang_chk
        CHECK (umfang IS NULL OR coalesce(zugriff_wort('umfang', umfang), false)),
    -- zuweisen und entziehen nennen ihre Zuweisung; sperren und entfernen den Benutzer.
    CONSTRAINT zugriff_protokoll_zugriff_chk
        CHECK (aktion NOT IN ('zuweisen', 'entziehen') OR (zugriff_id IS NOT NULL AND rolle IS NOT NULL)),
    CONSTRAINT zugriff_protokoll_betroffener_chk
        CHECK (betroffener_sub <> '' AND btrim(betroffener_name) <> ''),
    CONSTRAINT zugriff_protokoll_grund_chk CHECK (grund IS NULL OR btrim(grund) <> ''),
    -- Das Akteur-Vokabular von AP-03 (wie kennzahl_aenderung); die Rolle aus der Matrix.
    CONSTRAINT zugriff_protokoll_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT zugriff_protokoll_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR coalesce(zugriff_rolle_geltung(actor_rolle) IS NOT NULL, false)),
    CONSTRAINT zugriff_protokoll_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
-- Die Zeitraum-Abfrage (AP-12) und die Spur einer Person.
CREATE INDEX IF NOT EXISTS idx_zugriff_protokoll_zeit
    ON zugriff_protokoll (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_zugriff_protokoll_betroffener
    ON zugriff_protokoll (tenant_id, betroffener_sub, created_at DESC);

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun: ENABLE + FORCE + Policy mit USING UND WITH CHECK.
-- -----------------------------------------------------------------------------
ALTER TABLE benutzer ENABLE ROW LEVEL SECURITY;
ALTER TABLE benutzer FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS benutzer_tenant_isolation ON benutzer;
CREATE POLICY benutzer_tenant_isolation ON benutzer
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE zugriff ENABLE ROW LEVEL SECURITY;
ALTER TABLE zugriff FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zugriff_tenant_isolation ON zugriff;
CREATE POLICY zugriff_tenant_isolation ON zugriff
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE zugriff_protokoll ENABLE ROW LEVEL SECURITY;
ALTER TABLE zugriff_protokoll FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zugriff_protokoll_tenant_isolation ON zugriff_protokoll;
CREATE POLICY zugriff_protokoll_tenant_isolation ON zugriff_protokoll
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte. V2/V4s ALTER DEFAULT PRIVILEGES geben beiden Rollen alles auf jede neue
-- Tabelle — hier wird ALLES genommen und eng neu gegeben.
-- -----------------------------------------------------------------------------
REVOKE ALL ON benutzer, zugriff, zugriff_protokoll FROM ${appDbUser}, ${adminDbUser};

-- Der Spiegel: anlegen und nachführen; Mandant, Subject, Konto-Art, Einladung und
-- Anlagezeit nie. Entfernt wird über den Zustand, gelöscht nie.
GRANT SELECT, INSERT ON benutzer TO ${appDbUser};
GRANT UPDATE (anzeigename, email, zustand, angenommen_am, zuletzt_angemeldet) ON benutzer TO ${appDbUser};
-- Die Zuweisung: anlegen und EINMAL beenden.
GRANT SELECT, INSERT ON zugriff TO ${appDbUser};
GRANT UPDATE (beendet_am, beendet_von, beendet_grund) ON zugriff TO ${appDbUser};
-- Das Protokoll: lesen und anhängen.
GRANT SELECT, INSERT ON zugriff_protokoll TO ${appDbUser};

-- Die BYPASSRLS-Rolle voltpilot_admin: nur das Offboarding räumt ab.
GRANT SELECT, DELETE ON benutzer, zugriff, zugriff_protokoll TO ${adminDbUser};

-- ⚠ Das BIGSERIAL braucht sein EIGENES Sequenz-Recht (die rollout_event-Falle).
GRANT USAGE, SELECT ON SEQUENCE zugriff_protokoll_id_seq TO ${appDbUser};

COMMENT ON FUNCTION zugriff_vokabular() IS
    'Die Vokabulare konto|konto_zustand|art|umfang|aenderung von docs/contracts/v2/rechte-vectors.json, '
    'Zeile fuer Zeile; UemsZugriffMigrationTest vergleicht.';
COMMENT ON FUNCTION zugriff_rolle() IS
    'Die Rollen von docs/contracts/v2/rechte-matrix.json (kennung, geltungsbereich, zuweisbar), Zeile fuer Zeile.';
COMMENT ON TABLE zugriff IS
    'AP-03 IP-2: Zuweisung Benutzer x Rolle x Geltungsbereich x Gueltigkeit; nie umgeschrieben, nur einmal beendet.';
