-- AP-16 IP-15 (G1–G3, E7 = A): Messmittel-Angaben am Einbau.
--
-- Eine `geraet`-Zeile ist EIN Einbau (V20260911200000): die Angaben hängen am
-- Einbau Z-5b, nicht am Gerät GR-4 — ein Zählerwechsel legt eine neue Zeile
-- ohne Angaben an, Z-5a behält seine. Alles nullable: NULL = nicht erhoben (G3),
-- nie ein Vorgabewert, kein Backfill. Keine Bestandszeile ändert sich.
--
-- Ein Beleg ist ein VERWEIS (G2): Bezeichnung, Ablage beim Kunden, SHA-256 der
-- Datei (im Portal gebildet, die Datei wird nie übertragen), Person, Zeitpunkt.
-- Die Wandler-Klasse steht an der Wandler-Fassung (`quelle_einstellung`), nie
-- an einer anderen Art. Eine Genauigkeit der Messkette wird nirgends gerechnet.
--
-- Ein Gerät hatte bisher kein eigenes Journal (AenderungsprotokollRepository
-- #fuerEinbau liest die Einträge seiner Messstellen). Eine Messmittel-Angabe
-- betrifft den Einbau selbst — auch einen, der noch keine Messstelle speist —
-- und steht darum in `geraet_aenderung` (Art `messmittel_angabe`, alt/neu,
-- Akteur). Ohne Fremdschlüssel auf `geraet`: das Löschen einer Anlage nimmt
-- ihre Geräte mit (CASCADE) und darf am Journal nicht scheitern.

-- -----------------------------------------------------------------------------
-- 1. Die Angaben am Einbau (G1, G2)
-- -----------------------------------------------------------------------------
ALTER TABLE geraet
    ADD COLUMN genauigkeitsklasse   TEXT,
    ADD COLUMN pruefungsart         TEXT,
    ADD COLUMN pruefung_am          DATE,
    ADD COLUMN pruefung_gueltig_bis DATE,
    ADD COLUMN beleg_bezeichnung    TEXT,
    ADD COLUMN beleg_ablage         TEXT,
    ADD COLUMN beleg_sha256         CHAR(64),
    ADD COLUMN beleg_actor_sub      TEXT,
    ADD COLUMN beleg_actor_name     TEXT,
    ADD COLUMN beleg_actor_rolle    TEXT,
    ADD COLUMN beleg_actor_art      TEXT,
    ADD COLUMN beleg_am             TIMESTAMPTZ;

ALTER TABLE geraet
    -- Leer ist nicht erhoben — dann NULL, nie ''.
    ADD CONSTRAINT geraet_messmittel_text_chk CHECK (
        (genauigkeitsklasse IS NULL
            OR (char_length(genauigkeitsklasse) <= 60 AND btrim(genauigkeitsklasse) <> ''))
        AND (beleg_bezeichnung IS NULL
            OR (char_length(beleg_bezeichnung) <= 200 AND btrim(beleg_bezeichnung) <> ''))
        AND (beleg_ablage IS NULL
            OR (char_length(beleg_ablage) <= 200 AND btrim(beleg_ablage) <> ''))),
    -- Das Vokabular von uems-referenzunternehmen.schema.json (messmittel_angaben)
    -- ohne `nicht_erhoben`: das ist NULL.
    ADD CONSTRAINT geraet_pruefungsart_chk CHECK (pruefungsart IS NULL OR pruefungsart IN
        ('eichung', 'mid_konformitaet', 'kalibrierung', 'werksbescheinigung', 'keine')),
    ADD CONSTRAINT geraet_pruefung_zeitraum_chk CHECK (
        pruefung_am IS NULL OR pruefung_gueltig_bis IS NULL OR pruefung_gueltig_bis >= pruefung_am),
    ADD CONSTRAINT geraet_beleg_sha256_chk CHECK (
        beleg_sha256 IS NULL OR beleg_sha256 ~ '^[0-9a-f]{64}$'),
    -- Ein Beleg ist ganz oder gar nicht: ohne Prüfsumme, Person und Zeitpunkt
    -- keiner. Das Akteur-Vokabular von AP-03 wie in jedem Journal.
    ADD CONSTRAINT geraet_beleg_vollstaendig_chk CHECK (
        (beleg_bezeichnung IS NULL AND beleg_ablage IS NULL AND beleg_sha256 IS NULL
            AND beleg_actor_sub IS NULL AND beleg_actor_name IS NULL AND beleg_actor_rolle IS NULL
            AND beleg_actor_art IS NULL AND beleg_am IS NULL)
        OR (beleg_bezeichnung IS NOT NULL AND beleg_sha256 IS NOT NULL AND beleg_am IS NOT NULL
            AND beleg_actor_name IS NOT NULL AND btrim(beleg_actor_name) <> ''
            AND beleg_actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')
            AND (beleg_actor_rolle IS NULL OR beleg_actor_rolle IN ('kundenadministrator',
                 'energiemanager', 'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer',
                 'voltpilot_betrieb'))
            AND (beleg_actor_sub IS NULL OR beleg_actor_sub <> '')
            AND (beleg_actor_sub IS NOT NULL OR beleg_actor_art = 'voltpilot')));

GRANT UPDATE (genauigkeitsklasse, pruefungsart, pruefung_am, pruefung_gueltig_bis,
              beleg_bezeichnung, beleg_ablage, beleg_sha256, beleg_actor_sub, beleg_actor_name,
              beleg_actor_rolle, beleg_actor_art, beleg_am) ON geraet TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- 2. Die Wandler-Klasse an der Wandler-Fassung (G1)
-- -----------------------------------------------------------------------------
-- Eine Angabe über das Messmittel, keine Wirkung: sie steht außerhalb des
-- Tupels, das quelle_einstellung_nur_verkuerzen festhält, und ändert keinen Wert.
ALTER TABLE quelle_einstellung ADD COLUMN klasse TEXT;
ALTER TABLE quelle_einstellung ADD CONSTRAINT quelle_einstellung_klasse_chk CHECK (klasse IS NULL
    OR (art IN ('wandler_strom', 'wandler_spannung')
        AND char_length(klasse) <= 60 AND btrim(klasse) <> ''));
GRANT UPDATE (klasse) ON quelle_einstellung TO ${appDbUser};

-- -----------------------------------------------------------------------------
-- 3. Das Journal am Einbau (G2: Person und Zeitpunkt, alt und neu)
-- -----------------------------------------------------------------------------
CREATE TABLE geraet_aenderung (
    id          BIGSERIAL   PRIMARY KEY,
    tenant_id   UUID        NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
    geraet_id   UUID        NOT NULL,
    art         TEXT        NOT NULL,
    alt         JSONB,
    neu         JSONB,
    actor_sub   TEXT,
    actor_name  TEXT        NOT NULL,
    actor_rolle TEXT,
    actor_art   TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT geraet_aenderung_art_chk CHECK (art IN ('messmittel_angabe')),
    CONSTRAINT geraet_aenderung_actor_art_chk
        CHECK (actor_art IN ('kunde', 'unterstuetzung', 'voltpilot', 'notfall')),
    CONSTRAINT geraet_aenderung_actor_rolle_chk
        CHECK (actor_rolle IS NULL OR actor_rolle IN ('kundenadministrator', 'energiemanager',
               'bearbeiter', 'bedienberechtigt', 'leser', 'unterstuetzer', 'voltpilot_betrieb')),
    CONSTRAINT geraet_aenderung_actor_chk
        CHECK (btrim(actor_name) <> ''
               AND (actor_sub IS NULL OR actor_sub <> '')
               AND (actor_sub IS NOT NULL OR actor_art = 'voltpilot'))
);
CREATE INDEX geraet_aenderung_geraet_idx ON geraet_aenderung (tenant_id, geraet_id, created_at, id);

ALTER TABLE geraet_aenderung ENABLE ROW LEVEL SECURITY;
ALTER TABLE geraet_aenderung FORCE ROW LEVEL SECURITY;
CREATE POLICY geraet_aenderung_tenant_isolation ON geraet_aenderung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Nur lesen und anhängen; nur das administrative Offboarding löscht.
REVOKE ALL ON geraet_aenderung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT, INSERT ON geraet_aenderung TO ${appDbUser};
GRANT SELECT, DELETE ON geraet_aenderung TO ${adminDbUser};
REVOKE ALL ON SEQUENCE geraet_aenderung_id_seq FROM ${appDbUser}, ${adminDbUser};
GRANT USAGE, SELECT ON SEQUENCE geraet_aenderung_id_seq TO ${appDbUser}, ${adminDbUser};
