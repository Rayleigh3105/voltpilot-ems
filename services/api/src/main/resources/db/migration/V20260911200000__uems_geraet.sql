-- UEMS AP-04 IP-10: das GERÄT als Objekt — das physische Kästchen hinter der
-- VoltPilot-Box (Wechselrichter, Zähler, Ladestation, Controller mit
-- Energiekarten) mit Hersteller, Typ, Seriennummer, Ein- und Ausbau
-- (Konzept vp-uems-ap04-messstellen §4.2, §4.6 Regel 6, §6.2; Glossar „Gerät").
--
-- ⚠ WORTFALLE: `device` ist die BOX, nicht das Gerät. An `device` ändert sich
-- nichts; das Gerät heißt `geraet`.
--
-- EINE ZEILE = EIN EINBAU. Ein Zählerwechsel ist ein NEUES Gerät an derselben
-- Komponente (AP-04 E2, AP-00 §4.2): Z-5a und Z-5b sind zwei Zeilen. Beide
-- tragen dasselbe `kennzeichen` GR-4 — das Gerät, das über den Wechsel an
-- seiner Stelle bleibt — und je ihr eigenes `einbau_kennzeichen`. Genau dieses
-- Paar tragen die Verträge: `geraete[].kennzeichen` / `einbauten[].kennzeichen`
-- der Referenzdatei (uems-referenzunternehmen.json), `geraet_einbau {geraet,
-- einbau}` des Herkunftsvertrags (messwert-herkunft.md Angabe 10 — die
-- Einbau-Kennung je Wert zeigt auf EINE Zeile dieser Tabelle) und
-- `quellenbindung.geraet/einbau` des Messstellen-Vertrags. Ohne Wechsel ist das
-- Einbau-Kennzeichen das des Geräts („ohne Wechsel dasselbe wie das Gerät",
-- Referenz-Schema). Die VORGÄNGER eines Einbaus sind die früheren Einbauten
-- desselben Geräts; je Gerät und Zeitpunkt steckt höchstens EINER.
--
-- Drei mandantengebundene Tabellen und ein Zähler, rein additiv:
--   * geraet             — der Einbau (Geräteart, Hersteller, Typ, Seriennummer,
--                          Bezeichnung, Datenquelle + Geräte-ID, eingebaut/ausgebaut)
--   * geraet_teil        — die Energiekarten eines Controllers mit Steckplatz
--                          (AP-00 E12: der Controller ist EIN Gerät; AP-05 E4:
--                          Identität der Karte = (Gerät, Steckplatz); AP-05 E6:
--                          ein Kartenwechsel ist eine Gerätegrenze OHNE Gerätewechsel)
--   * geraet_komponente  — welche Komponente wann von welchem Einbau (und über
--                          welche Karte) gespeist wird, HALBOFFEN auf die Minute
--   * geraet_kennzeichen_seq — der Kennzeichen-Zähler GR-n je Kundenbereich
--
-- WARUM KEINE SPALTE `measurement_point.geraet_id` (§6.2 schlug sie vor): eine
-- Spalte trüge nur den HEUTIGEN Einbau. Der Herkunfts-Nachschlag fragt „welcher
-- Einbau speiste K-5 um 10:39?" (AP-07, Angabe 10) — das ist Zeitgültigkeit.
-- Und `measurement_point` bleibt so, wie es ist: keine Spalte, kein Index,
-- keine Policy ändert sich dort.
--
-- ⚠ ZEITPUNKTE, NICHT TAGE (E2): eingebaut/ausgebaut und die Verknüpfung
-- sind halboffen `tstzrange(ab, bis, '[)')` auf die volle Minute — `bis`
-- gehört nicht mehr dazu, NULL = offen, wie data_source_assignment
-- (V20260911150000). Ende alt = Beginn neu berührt sich, ohne sich zu
-- überschneiden (Z-5a bis 10:40, Z-5b ab 10:40).
--
-- DIE ABLEITUNG FÜR DEN BESTAND (uems_geraete_ableiten, unten aufgerufen):
-- je bestehender Komponente GENAU EIN aktives Gerät. „Migration schreibt nur":
-- keine Portal-Fläche, kein Vertrag, keine Box liest eine dieser Tabellen.
--   * Gruppierung nach den Regeln, die der Code HEUTE hat — nie geraten. Ein
--     Hybrid-Wechselrichter mit seinem Speicher ist schon heute EINE Zeile
--     (`battery-hybrid`, ComponentService.java:60-63), also EIN Gerät. Die
--     komponierten Geschwister derselben Box (producer / grid-meter /
--     house-load ohne Pin, ohne Marke, ohne Modell, ohne eigene Verbindung)
--     speist derselbe Wechselrichter mit: das Portal hängt jede nicht
--     gepinnte Komponente an den Wechselrichter der Box (komponenten.ts,
--     Schritt 2 der Geräte-Leiste), und eine Zeile MIT eigener Verbindung oder
--     eigenem Pin „gehört einem anderen Gerät" (ComponentAdoptionService.
--     reusableComposedRow). Der Wechselrichter einer Box ist ihr ERSTER
--     battery-hybrid (created_at, id — EntityRegistryRepository.
--     firstEntityOfType). Alles andere bekommt je Komponente sein eigenes
--     Gerät — auch zwei Komponenten an derselben Adresse: die Box trennt
--     Quellen nach Rolle + Weg (edge TransportIdentity), zusammengelegt wird
--     erst über die Datenquelle (AP-06 IP-4).
--   * eingebaut_am = der Beginn des Verlaufs der Komponente: das Frühere aus
--     ihrer Anlagezeit (`measurement_point.created_at`) und dem Beginn ihres
--     ersten Tages mit Werten (`telemetry_v2_rollup_1d`, unbefristet
--     aufbewahrt — `telemetry_v2` selbst hält nur 90 Tage und wüsste den
--     Beginn nicht mehr), abgerundet auf die Minute. So umschließt der Einbau
--     jeden gespeicherten Wert der Komponente; die v1-Historie vor
--     `site.v2_history_cutover_at` ist box-, nicht komponentengeschlüsselt und
--     kein Komponenten-Verlauf. Das Gerät beginnt mit seiner frühesten
--     Komponente, jede Verknüpfung mit ihrer eigenen. `aus_bestand` sagt dem
--     Leser, dass eingebaut_am hier der Verlaufsbeginn ist, nicht der Einbautag.
--   * Hersteller = brand, Typ = model (getrimmt, leer = NULL). Seriennummer NUR,
--     wo die Vorlage `serial` als Nummer des GERÄTS führt — `kaco_http`
--     („Seriennummer des Wechselrichters"). Bei `solarman_v5` (Deye) ist
--     `serial` die des DATENLOGGERS („nicht des Wechselrichters!",
--     componenttemplates/builtin.json) — sie wird nie zur Geräte-Seriennummer.
--     Sonst NULL = nicht erhoben. Geräte-ID = die Modbus-Geräte-ID der
--     Verbindung (`unit_id`, bei solarman_v5 `mb_slave_id`), wenn sie eine Zahl
--     ist. Datenquelle = NULL: Quellen der Bestandskunden legt erst die
--     Vorschlagsliste an (AP-06 IP-4). Bezeichnung = NULL (keine erhoben — die
--     Anzeige bleibt die Namenskette des Portals).
--   * Kennzeichen GR-1, GR-2 … je Kundenbereich in fester Reihenfolge (Anlage
--     nach Anlagezeit, darin das Gerät nach seiner frühesten Komponente).
--   * Wiederholbar: sie legt nur für Komponenten OHNE JEDE Verknüpfung an (eine
--     gewechselte hat eine beendete); ein zweiter Lauf legt nichts an. Neue
--     Geschwister hängt sie an den laufenden Einbau ihres Wechselrichters.
--     Komponenten, die NACH dieser Migration entstehen, bekommen ihr Gerät
--     erst mit dem Anlege-Weg eines Folgepakets — die Tabelle sagt bis dahin
--     ehrlich „kein Gerät erfasst", nie ein geratenes.
--
-- LÖSCHEN (Plan-Regel „nichts mit Historie wird gelöscht"; die App-Rolle hat
-- auf keiner der Tabellen DELETE — ein Gerät wird AUSGEBAUT, ein Zeitraum
-- BEENDET):
--   * → tenant: ON DELETE RESTRICT; das Offboarding räumt die vier Tabellen
--     AUSDRÜCKLICH ab (TenantRepository.offboard), Kinder zuerst.
--   * geraet → site: ON DELETE CASCADE, bewusst anders als data_source. Die
--     Ableitung gibt JEDER Bestandsanlage mit Komponenten Geräte — ein
--     RESTRICT legte jede dieser Anlagen fest, und das heutige Löschen einer
--     Anlage (SiteRepository.delete) nimmt ihre Komponenten samt Verlauf mit
--     (measurement_point → site ON DELETE CASCADE). Die Geräte folgen ihnen,
--     bis AP-07 E8 das Löschen durch „ausgebaut" ersetzt.
--   * geraet → data_source: ON DELETE RESTRICT (eine Quelle wird archiviert).
--   * geraet_komponente → measurement_point: ON DELETE CASCADE wie jede Tabelle
--     an einer Komponente (component_definition, device_measurement_selection):
--     das heutige Löschen einer Komponente bleibt, wie es ist; das Gerät bleibt.
--   * Teile und Verknüpfungen → geraet: ON DELETE CASCADE — ein Gerät endet nur
--     mit seiner Anlage oder dem Offboarding.
--
-- Nicht dieses Paket: Zähler-/Controllerwechsel (IP-17/IP-19), Einstellungs-
-- Fassungen (IP-11), die Geräteseite (IP-12), Ablesestände (IP-13/IP-17), das
-- Änderungsprotokoll `geraet_aenderung` (IP-21).

-- Die Ausschluss-Bedingungen brauchen `=` auf uuid/text/int in einem GiST-Index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- geraet — ein Einbau
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geraet (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID        NOT NULL,
    -- Die Anlage, in der das Gerät verdrahtet ist.
    site_id            UUID        NOT NULL,
    -- Das Gerät (GR-n): bleibt über einen Wechsel an derselben Stelle.
    kennzeichen        TEXT        NOT NULL,
    -- Das konkret eingebaute Gerät (Z-5a); ohne Wechsel = kennzeichen.
    einbau_kennzeichen TEXT        NOT NULL,
    -- Geschlossen (§4.2). Die Energiekarte ist ein TEIL des Controllers
    -- (geraet_teil), keine Zeile hier. Ein späteres Paket weitet den CHECK,
    -- indem es DIESEN Stand abschreibt.
    geraeteart         TEXT        NOT NULL,
    hersteller         TEXT,
    typ                TEXT,
    -- NULL = nicht erhoben — nie erfunden.
    seriennummer       TEXT,
    -- Das Kundenwort für das Kästchen; NULL = keins erhoben.
    bezeichnung        TEXT,
    -- Der Weg, über den das Gerät antwortet (AP-06), und seine Geräte-ID
    -- dahinter (Modbus-Unit-ID). NULL = noch keine Quelle angelegt.
    data_source_id     UUID,
    geraete_id         INTEGER,
    eingebaut_am       TIMESTAMPTZ NOT NULL,
    -- NULL = eingebaut. Ausgebaut = archiviert: bleibt lesbar mit seinen Werten.
    ausgebaut_am       TIMESTAMPTZ,
    -- Aus einer Bestands-Komponente abgeleitet (diese Migration): eingebaut_am
    -- ist der Beginn ihres Verlaufs, nicht der Einbautag.
    aus_bestand        BOOLEAN     NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = VoltPilot selbst (die Ableitung).
    created_by         TEXT,
    CONSTRAINT geraet_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    -- Zusammengesetzt über uq_site_id_tenant_identity (V20260844000000): die
    -- Anlage gehört demselben Mandanten wie das Gerät. CASCADE: siehe Kopf.
    CONSTRAINT geraet_site_fk FOREIGN KEY (site_id, tenant_id)
        REFERENCES site (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT geraet_datenquelle_fk FOREIGN KEY (data_source_id, tenant_id)
        REFERENCES data_source (id, tenant_id) ON DELETE RESTRICT,
    -- Die Ziele der zusammengesetzten Fremdschlüssel von geraet_komponente und
    -- geraet_teil (der zweite hält „Karten nur am Controller").
    CONSTRAINT uq_geraet_id_tenant UNIQUE (id, tenant_id),
    CONSTRAINT uq_geraet_id_tenant_art UNIQUE (id, tenant_id, geraeteart),
    -- Die Form der Kennzeichen der Verträge (messwert-herkunft.schema.json
    -- $defs/kennzeichen): Z-5a, C-1′, AHR-LP-01.
    CONSTRAINT geraet_kennzeichen_chk
        CHECK (kennzeichen ~ '^[A-Za-z0-9][A-Za-z0-9._/′-]{0,31}$'),
    CONSTRAINT geraet_einbau_kennzeichen_chk
        CHECK (einbau_kennzeichen ~ '^[A-Za-z0-9][A-Za-z0-9._/′-]{0,31}$'),
    CONSTRAINT geraet_geraeteart_chk CHECK (geraeteart IN
        ('zaehler', 'wechselrichter', 'controller', 'ladestation', 'speicher', 'sonstiges')),
    -- Leer ist nicht erhoben — dann NULL, nie ''.
    CONSTRAINT geraet_text_chk CHECK (
        (hersteller IS NULL OR btrim(hersteller) <> '')
        AND (typ IS NULL OR btrim(typ) <> '')
        AND (seriennummer IS NULL OR btrim(seriennummer) <> '')
        AND (bezeichnung IS NULL
             OR (char_length(bezeichnung) BETWEEN 1 AND 120 AND btrim(bezeichnung) <> ''))),
    CONSTRAINT geraet_geraete_id_chk CHECK (geraete_id IS NULL OR geraete_id >= 0),
    -- Auf die Minute (E2), abgelehnt, nie gerundet. In UTC gerechnet —
    -- date_trunc auf timestamptz hinge an der Zeitzone der Sitzung.
    CONSTRAINT geraet_volle_minute
        CHECK (date_trunc('minute', eingebaut_am AT TIME ZONE 'UTC')
                   = eingebaut_am AT TIME ZONE 'UTC'
               AND (ausgebaut_am IS NULL
                    OR date_trunc('minute', ausgebaut_am AT TIME ZONE 'UTC')
                           = ausgebaut_am AT TIME ZONE 'UTC')),
    CONSTRAINT geraet_nicht_leer CHECK (ausgebaut_am IS NULL OR ausgebaut_am > eingebaut_am),
    -- Je Gerät und Zeitpunkt steckt höchstens EIN Einbau. tenant_id vorn: der
    -- Constraint prüft ohne RLS und darf einem fremden Mandanten nichts verraten.
    CONSTRAINT geraet_ein_einbau_je_zeitpunkt EXCLUDE USING gist (
        tenant_id WITH =,
        kennzeichen WITH =,
        tstzrange(eingebaut_am, ausgebaut_am, '[)') WITH &&
    )
);

-- Jeder Einbau hat sein eigenes Kennzeichen je Kundenbereich (Z-5a ≠ Z-5b).
CREATE UNIQUE INDEX IF NOT EXISTS uq_geraet_einbau_kennzeichen
    ON geraet (tenant_id, einbau_kennzeichen);
CREATE INDEX IF NOT EXISTS idx_geraet_site ON geraet (site_id);

-- -----------------------------------------------------------------------------
-- geraet_teil — die Energiekarten eines Controllers
-- -----------------------------------------------------------------------------
-- Die Identität einer Karte ist (Gerät, Steckplatz) (AP-05 E4); je Steckplatz
-- und Zeitpunkt steckt höchstens EINE. Ein Steckplatz darf fehlen („nicht
-- erhoben", C-2 in der Referenzdatei) — dann kann er mit nichts kollidieren.
-- Ein Kartenwechsel beendet die alte Karte und beginnt eine neue im selben
-- Steckplatz desselben Geräts (AP-05 E6); ein Steckplatzwechsel ist eine neue
-- Zeile, keine Umschreibung.
CREATE TABLE IF NOT EXISTS geraet_teil (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID        NOT NULL,
    geraet_id     UUID        NOT NULL,
    -- Karten trägt nur ein Controller: die Spalte ist fest und der
    -- zusammengesetzte Fremdschlüssel prüft sie gegen die Geräteart.
    traeger_art   TEXT        NOT NULL DEFAULT 'controller',
    teilart       TEXT        NOT NULL DEFAULT 'energiekarte',
    steckplatz    INTEGER,
    -- „EK-1" — das Wort des Kunden; NULL = keins erhoben.
    bezeichnung   TEXT,
    -- Kartentyp („750-494/000-001 (5 A)").
    typ           TEXT,
    -- Optionaler Freitext (AP-05 E4).
    seriennummer  TEXT,
    eingebaut_am  TIMESTAMPTZ NOT NULL,
    ausgebaut_am  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    TEXT,
    CONSTRAINT geraet_teil_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT geraet_teil_geraet_fk FOREIGN KEY (geraet_id, tenant_id, traeger_art)
        REFERENCES geraet (id, tenant_id, geraeteart) ON DELETE CASCADE,
    -- Das Ziel des Fremdschlüssels von geraet_komponente: die Karte gehört dem
    -- Gerät der Verknüpfung.
    CONSTRAINT uq_geraet_teil_id_geraet UNIQUE (id, geraet_id, tenant_id),
    CONSTRAINT geraet_teil_traeger_chk CHECK (traeger_art = 'controller'),
    CONSTRAINT geraet_teil_teilart_chk CHECK (teilart IN ('energiekarte')),
    CONSTRAINT geraet_teil_steckplatz_chk CHECK (steckplatz IS NULL OR steckplatz >= 0),
    CONSTRAINT geraet_teil_text_chk CHECK (
        (bezeichnung IS NULL
         OR (char_length(bezeichnung) BETWEEN 1 AND 120 AND btrim(bezeichnung) <> ''))
        AND (typ IS NULL OR btrim(typ) <> '')
        AND (seriennummer IS NULL OR btrim(seriennummer) <> '')),
    CONSTRAINT geraet_teil_volle_minute
        CHECK (date_trunc('minute', eingebaut_am AT TIME ZONE 'UTC')
                   = eingebaut_am AT TIME ZONE 'UTC'
               AND (ausgebaut_am IS NULL
                    OR date_trunc('minute', ausgebaut_am AT TIME ZONE 'UTC')
                           = ausgebaut_am AT TIME ZONE 'UTC')),
    CONSTRAINT geraet_teil_nicht_leer CHECK (ausgebaut_am IS NULL OR ausgebaut_am > eingebaut_am),
    CONSTRAINT geraet_teil_eine_karte_je_steckplatz EXCLUDE USING gist (
        tenant_id WITH =,
        geraet_id WITH =,
        steckplatz WITH =,
        tstzrange(eingebaut_am, ausgebaut_am, '[)') WITH &&
    )
);

-- -----------------------------------------------------------------------------
-- geraet_komponente — wer speist die Komponente wann
-- -----------------------------------------------------------------------------
-- Je Komponente und Zeitpunkt EIN Gerät (§4.6 Regel 6), je Karte und Zeitpunkt
-- EINE Komponente (eine Energiekarte speist genau eine). Ein Gerät darf viele
-- Komponenten speisen. Ein Wechsel beendet den laufenden Zeitraum
-- (`gueltig_bis = t`) und beginnt einen neuen ab `t` — die Datenbank beendet
-- nichts von selbst, sie lehnt nur ab, was sich überschneidet. Dass ein
-- Zeitraum im Einbau seines Geräts liegt, prüft der Schreibweg (IP-17); die
-- Ableitung legt ihn so an.
CREATE TABLE IF NOT EXISTS geraet_komponente (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL,
    geraet_id    UUID        NOT NULL,
    -- Die Komponente (measurement_point) — `entity_id` wie in jeder Tabelle an
    -- einer Komponente und wie der Schlüssel der Messreihe (telemetry_v2).
    entity_id    UUID        NOT NULL,
    -- Die Karte, über die ein Controller die Komponente speist; NULL = direkt.
    teil_id      UUID,
    gueltig_ab   TIMESTAMPTZ NOT NULL,
    gueltig_bis  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   TEXT,
    CONSTRAINT geraet_komponente_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT geraet_komponente_geraet_fk FOREIGN KEY (geraet_id, tenant_id)
        REFERENCES geraet (id, tenant_id) ON DELETE CASCADE,
    -- Über uq_measurement_point_id_tenant (V20260855000000): nie die Komponente
    -- eines anderen Mandanten.
    CONSTRAINT geraet_komponente_entity_fk FOREIGN KEY (entity_id, tenant_id)
        REFERENCES measurement_point (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT geraet_komponente_teil_fk FOREIGN KEY (teil_id, geraet_id, tenant_id)
        REFERENCES geraet_teil (id, geraet_id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT geraet_komponente_volle_minute
        CHECK (date_trunc('minute', gueltig_ab AT TIME ZONE 'UTC')
                   = gueltig_ab AT TIME ZONE 'UTC'
               AND (gueltig_bis IS NULL
                    OR date_trunc('minute', gueltig_bis AT TIME ZONE 'UTC')
                           = gueltig_bis AT TIME ZONE 'UTC')),
    CONSTRAINT geraet_komponente_nicht_leer CHECK (gueltig_bis IS NULL OR gueltig_bis > gueltig_ab),
    CONSTRAINT geraet_komponente_ein_geraet_je_zeitpunkt EXCLUDE USING gist (
        tenant_id WITH =,
        entity_id WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    ),
    CONSTRAINT geraet_komponente_eine_komponente_je_karte EXCLUDE USING gist (
        tenant_id WITH =,
        teil_id WITH =,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    )
);

-- „Welche Komponenten speist Gerät X?" — die Geräteseite und die Anlagen-Liste.
CREATE INDEX IF NOT EXISTS idx_geraet_komponente_geraet
    ON geraet_komponente (geraet_id, gueltig_ab);

-- -----------------------------------------------------------------------------
-- Der Kennzeichen-Zähler je Kundenbereich — eine Tabelle, nie ein BIGSERIAL
-- -----------------------------------------------------------------------------
-- Dieselbe Mechanik wie data_source_kennzeichen_seq (V20260911150000):
-- `naechste_nummer` ist die nächste Nummer (fehlt die Zeile: 1); der Zähler
-- rückt nur mit einem gespeicherten Kennzeichen vor (dieselbe Transaktion) und
-- nie zurück.
CREATE TABLE IF NOT EXISTS geraet_kennzeichen_seq (
    tenant_id       UUID    PRIMARY KEY,
    naechste_nummer INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT geraet_kennzeichen_seq_tenant_fk FOREIGN KEY (tenant_id)
        REFERENCES tenant (id) ON DELETE RESTRICT,
    CONSTRAINT geraet_kennzeichen_seq_nummer_chk CHECK (naechste_nummer >= 1)
);

-- Das nächste freie Kennzeichen GR-n des Kundenbereichs — und der Zähler rückt
-- dahinter. Die Zeile des Mandanten wird gesperrt (oder angelegt): parallele
-- Vergaben warten aufeinander. Eine Nummer, die schon ein Gerät oder ein Einbau
-- trägt (von Hand vergeben), wird übersprungen. Läuft als Aufrufer: unter RLS
-- vergibt die App-Rolle nur für ihren eigenen Mandanten.
CREATE OR REPLACE FUNCTION uems_geraet_kennzeichen(p_tenant UUID) RETURNS TEXT
    LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    n INTEGER;
BEGIN
    INSERT INTO geraet_kennzeichen_seq AS z (tenant_id, naechste_nummer)
    VALUES (p_tenant, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET naechste_nummer = z.naechste_nummer
    RETURNING z.naechste_nummer INTO n;
    WHILE EXISTS (SELECT 1 FROM geraet g
                  WHERE g.tenant_id = p_tenant
                    AND 'GR-' || n IN (g.kennzeichen, g.einbau_kennzeichen)) LOOP
        n := n + 1;
    END LOOP;
    UPDATE geraet_kennzeichen_seq SET naechste_nummer = n + 1 WHERE tenant_id = p_tenant;
    RETURN 'GR-' || n;
END
$$;

-- -----------------------------------------------------------------------------
-- Der Mandantenzaun (Hausregel: fremd ist 404, ohne app.tenant_id 0 Zeilen)
-- -----------------------------------------------------------------------------
ALTER TABLE geraet ENABLE ROW LEVEL SECURITY;
ALTER TABLE geraet FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geraet_tenant_isolation ON geraet;
CREATE POLICY geraet_tenant_isolation ON geraet
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE geraet_teil ENABLE ROW LEVEL SECURITY;
ALTER TABLE geraet_teil FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geraet_teil_tenant_isolation ON geraet_teil;
CREATE POLICY geraet_teil_tenant_isolation ON geraet_teil
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE geraet_komponente ENABLE ROW LEVEL SECURITY;
ALTER TABLE geraet_komponente FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geraet_komponente_tenant_isolation ON geraet_komponente;
CREATE POLICY geraet_komponente_tenant_isolation ON geraet_komponente
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE geraet_kennzeichen_seq ENABLE ROW LEVEL SECURITY;
ALTER TABLE geraet_kennzeichen_seq FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geraet_kennzeichen_seq_tenant_isolation ON geraet_kennzeichen_seq;
CREATE POLICY geraet_kennzeichen_seq_tenant_isolation ON geraet_kennzeichen_seq
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- -----------------------------------------------------------------------------
-- Rechte
-- -----------------------------------------------------------------------------
-- V2s ALTER DEFAULT PRIVILEGES gibt der App-Rolle SELECT/INSERT/UPDATE/DELETE
-- auf jede neue Tabelle — hier wird bewusst weggenommen, was es nicht geben darf.
-- Die BYPASSRLS-Rolle voltpilot_admin deckt V4s ALTER DEFAULT PRIVILEGES ab (das
-- Offboarding löscht über sie). Keine Tabelle hat ein BIGSERIAL, darum gibt es
-- kein Sequenz-Grant. (Das REVOKE auf Tabellenebene nimmt auch Spaltenrechte
-- mit; das GRANT danach setzt genau die wieder — ein erneuter Lauf landet im
-- selben Zustand.)
--
-- Ein Wechsel ist ein NEUES Gerät: Gerät, Anlage, Geräteart und Einbaubeginn
-- sind die Identität des Einbaus und nie änderbar. Änderbar ist, was der Kunde
-- nachträgt oder was der Ausbau setzt.
GRANT SELECT, INSERT ON geraet TO ${appDbUser};
REVOKE UPDATE, DELETE ON geraet FROM ${appDbUser};
GRANT UPDATE (einbau_kennzeichen, hersteller, typ, seriennummer, bezeichnung,
              data_source_id, geraete_id, ausgebaut_am) ON geraet TO ${appDbUser};
-- Eine Karte bleibt in ihrem Steckplatz; sie wird ausgebaut, nie gelöscht.
GRANT SELECT, INSERT ON geraet_teil TO ${appDbUser};
REVOKE UPDATE, DELETE ON geraet_teil FROM ${appDbUser};
GRANT UPDATE (bezeichnung, typ, seriennummer, ausgebaut_am) ON geraet_teil TO ${appDbUser};
-- Ein Zeitraum wird beendet — nie gelöscht, nie umgeschrieben.
GRANT SELECT, INSERT ON geraet_komponente TO ${appDbUser};
REVOKE UPDATE, DELETE ON geraet_komponente FROM ${appDbUser};
GRANT UPDATE (gueltig_bis) ON geraet_komponente TO ${appDbUser};
-- Der Zähler rückt vor, er verschwindet nicht.
GRANT SELECT, INSERT, UPDATE ON geraet_kennzeichen_seq TO ${appDbUser};
REVOKE DELETE ON geraet_kennzeichen_seq FROM ${appDbUser};

-- -----------------------------------------------------------------------------
-- Die Ableitung für den Bestand (siehe Kopf)
-- -----------------------------------------------------------------------------
-- Gibt zurück, wie viele Geräte sie neu angelegt hat. Läuft als Aufrufer; die
-- Migration ruft sie ohne RLS über alle Mandanten. Kein Schreibweg der App
-- ruft sie — deshalb darf PUBLIC sie nicht ausführen.
CREATE OR REPLACE FUNCTION uems_geraete_ableiten() RETURNS INTEGER
    LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    g         RECORD;
    ziel      UUID;
    angelegt  INTEGER := 0;
BEGIN
    FOR g IN
        WITH offen AS (
            -- Komponenten ohne JEDE Verknüpfung, mit dem Beginn ihres Verlaufs.
            SELECT mp.id, mp.tenant_id, mp.site_id, mp.device_id, mp.created_at,
                   coalesce(mp.entity_type, mp.role) AS art,
                   mp.edge_source_id, mp.brand, mp.model, mp.connection_json,
                   date_trunc('minute', least(mp.created_at,
                           (SELECT min(r.bucket) FROM telemetry_v2_rollup_1d r
                            WHERE r.entity_id = mp.id::text)) AT TIME ZONE 'UTC')
                       AT TIME ZONE 'UTC' AS beginn
            FROM measurement_point mp
            WHERE NOT EXISTS (SELECT 1 FROM geraet_komponente v
                              WHERE v.tenant_id = mp.tenant_id AND v.entity_id = mp.id)
        ),
        wechselrichter AS (
            -- Der Wechselrichter je Anlage und Box: ihr ERSTER battery-hybrid —
            -- nur, wenn er gerade mit abgeleitet wird oder ein laufendes Gerät hat.
            SELECT w.id, w.site_id, w.device_id
            FROM (SELECT DISTINCT ON (site_id, device_id) id, tenant_id, site_id, device_id
                  FROM measurement_point
                  WHERE coalesce(entity_type, role) = 'battery-hybrid' AND device_id IS NOT NULL
                  ORDER BY site_id, device_id, created_at, id) w
            WHERE EXISTS (SELECT 1 FROM offen o WHERE o.id = w.id)
               OR EXISTS (SELECT 1 FROM geraet_komponente v
                          WHERE v.tenant_id = w.tenant_id AND v.entity_id = w.id
                            AND v.gueltig_bis IS NULL)
        ),
        gruppiert AS (
            SELECT o.*,
                   coalesce(CASE WHEN o.art IN ('producer', 'pv-generation', 'grid-meter', 'house-load')
                                  AND o.edge_source_id IS NULL
                                  AND nullif(btrim(o.brand), '') IS NULL
                                  AND nullif(btrim(o.model), '') IS NULL
                                  AND (o.connection_json IS NULL
                                       OR o.connection_json IN ('null'::jsonb, '{}'::jsonb))
                             THEN w.id END,
                            o.id) AS anker
            FROM offen o
            LEFT JOIN wechselrichter w ON w.site_id = o.site_id AND w.device_id = o.device_id
        )
        SELECT gr.tenant_id, gr.site_id, gr.anker,
               array_agg(gr.id ORDER BY gr.created_at, gr.id) AS komponenten,
               array_agg(gr.beginn ORDER BY gr.created_at, gr.id) AS beginne,
               min(gr.beginn) AS eingebaut_am
        FROM gruppiert gr
        JOIN site s ON s.id = gr.site_id
        GROUP BY gr.tenant_id, gr.site_id, gr.anker, s.created_at, s.id
        ORDER BY gr.tenant_id, s.created_at, s.id, min(gr.created_at),
                 (array_agg(gr.id ORDER BY gr.created_at, gr.id))[1]
    LOOP
        -- Speist der Wechselrichter schon (erneuter Lauf), hängen die neuen
        -- Geschwister an seinen laufenden Einbau.
        ziel := NULL;
        SELECT v.geraet_id INTO ziel FROM geraet_komponente v
        WHERE v.tenant_id = g.tenant_id AND v.entity_id = g.anker AND v.gueltig_bis IS NULL;

        IF ziel IS NULL THEN
            INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, geraeteart,
                                hersteller, typ, seriennummer, geraete_id, eingebaut_am,
                                aus_bestand)
            SELECT g.tenant_id, g.site_id, k.kennzeichen, k.kennzeichen,
                   CASE
                       WHEN a.art IN ('battery-hybrid', 'producer', 'pv-generation', 'inverter')
                           THEN 'wechselrichter'
                       WHEN a.art IN ('grid-meter', 'modbus-generic') THEN 'zaehler'
                       WHEN a.art IN ('wallbox', 'ev-charger') THEN 'ladestation'
                       WHEN a.art = 'user-defined-battery' THEN 'speicher'
                       ELSE 'sonstiges'
                   END,
                   nullif(btrim(a.brand), ''),
                   nullif(btrim(a.model), ''),
                   CASE WHEN a.communication = 'kaco_http'
                        THEN nullif(btrim(a.connection_json ->> 'serial'), '') END,
                   CASE WHEN a.unit_id ~ '^[0-9]{1,3}$' THEN a.unit_id::integer END,
                   g.eingebaut_am,
                   true
            FROM (SELECT mp.*, coalesce(mp.entity_type, mp.role) AS art,
                         CASE WHEN mp.communication = 'solarman_v5'
                              THEN btrim(mp.connection_json ->> 'mb_slave_id')
                              ELSE btrim(mp.connection_json ->> 'unit_id') END AS unit_id
                  FROM measurement_point mp WHERE mp.id = g.anker) a
            CROSS JOIN LATERAL (SELECT uems_geraet_kennzeichen(g.tenant_id) AS kennzeichen) k
            RETURNING id INTO ziel;
            angelegt := angelegt + 1;
        END IF;

        INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, gueltig_ab)
        SELECT g.tenant_id, ziel, u.komponente, greatest(u.beginn, e.eingebaut_am)
        FROM unnest(g.komponenten, g.beginne) AS u(komponente, beginn)
        CROSS JOIN (SELECT eingebaut_am FROM geraet WHERE id = ziel) e;
    END LOOP;
    RETURN angelegt;
END
$$;

REVOKE EXECUTE ON FUNCTION uems_geraete_ableiten() FROM PUBLIC;

SELECT uems_geraete_ableiten();
