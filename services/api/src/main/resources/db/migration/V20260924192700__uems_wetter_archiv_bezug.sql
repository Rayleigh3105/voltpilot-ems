-- AP-17 IP-12b (E9 = C): VoltPilot bezieht die Temperatur-Tagesmittel eines Standorts aus einem
-- Wetter-Archiv (Open-Meteo-Archiv, später wahlweise DWD) und bildet daraus Gradtage mit der
-- Herkunft `bezogen`. Additiv: keine Bestandszeile ändert sich, jede neue Spalte ist leer.
--
-- 1. Die Vokabulare des Vertrags: `herkunft_art` bekommt das fünfte Wort `bezogen` (Vertrag
--    bezugsdaten-vectors.json, AP-17 IP-12a). Die Funktion ist weiter die EINE Stelle; jeder
--    CHECK fragt sie über bezugsdaten_wort(). Abgeschrieben aus V20260914173000, ergänzt um die
--    eine Zeile.
-- 2. Der Art-Katalog: die Gradtagzahl nennt `bezogen` als dritte Herkunft (abgeschrieben aus
--    V20260922233000, ergänzt um das eine Wort).
-- 3. `bezugsgroesse_wetterbezug`: welche Gradtagzahl bezogen wird, entscheidet diese Zeile — nicht
--    der Standort. Raumtemperatur und Heizgrenze stehen wie an der Kanalbindung (G20/15).
-- 4. `bezugsgroesse_wert.bezug_quelle` / `abgerufen_am` (Vertrag §„Wetter-Archiv“, wie beim Import
--    die Kennung) und `bezug_herkunft` (Koordinaten, Regel, „x von y Tagen“) reisen mit jeder
--    bezogenen Fassung — wie `kanal_herkunft` beim Messkanal.


-- -----------------------------------------------------------------------------
-- Die Vokabulare des Vertrags — neue Fassung der Funktion (siehe Kopf).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bezugsdaten_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT, groesse TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('wertart', 1, 'periodenwert', NULL),
    ('wertart', 2, 'stand', NULL),
    ('wertart', 3, 'stammdatum', NULL),
    ('geltung_art', 1, 'unternehmen', NULL),
    ('geltung_art', 2, 'standort', NULL),
    ('geltung_art', 3, 'gebaeude', NULL),
    ('geltung_art', 4, 'bereich', NULL),
    ('geltung_art', 5, 'prozess', NULL),
    ('geltung_art', 6, 'kostenstelle', NULL),
    ('geltung_art', 7, 'messstelle', NULL),
    ('periode_art', 1, 'tag', NULL),
    ('periode_art', 2, 'woche', NULL),
    ('periode_art', 3, 'monat', NULL),
    ('periode_art', 4, 'jahr', NULL),
    ('herkunft_art', 1, 'eingabe', NULL),
    ('herkunft_art', 2, 'import', NULL),
    ('herkunft_art', 3, 'messkanal', NULL),
    ('herkunft_art', 4, 'stammdatum_ap02', NULL),
    ('herkunft_art', 5, 'bezogen', NULL),
    ('vorgang', 1, 'erstwert', NULL),
    ('vorgang', 2, 'berichtigung', NULL),
    ('vorgang', 3, 'ruecknahme', NULL),
    ('status', 1, 'wirksam', NULL),
    ('status', 2, 'vorschlag', NULL),
    ('status', 3, 'zurueckgenommen', NULL),
    ('status', 4, 'abgelehnt', NULL),
    ('import_status', 1, 'vorschau', NULL),
    ('import_status', 2, 'uebernommen', NULL),
    ('import_status', 3, 'teilweise_uebernommen', NULL),
    ('import_status', 4, 'wiederholt', NULL),
    ('import_status', 5, 'zurueckgenommen', NULL),
    ('import_status', 6, 'verworfen', NULL),
    ('zeilen_urteil', 1, 'neu', NULL),
    ('zeilen_urteil', 2, 'wiederholung', NULL),
    ('zeilen_urteil', 3, 'konflikt', NULL),
    ('zeilen_urteil', 4, 'berichtigung', NULL),
    ('zeilen_urteil', 5, 'uebersprungen', NULL),
    ('zeilen_urteil', 6, 'abgelehnt', NULL),
    ('befunde', 1, 'datei_bekannt', NULL),
    ('befunde', 2, 'zeile_bekannt', NULL),
    ('befunde', 3, 'konflikt_anderer_wert', NULL),
    ('befunde', 4, 'einheit_unbekannt', NULL),
    ('befunde', 5, 'einheit_umgerechnet', NULL),
    ('befunde', 6, 'periode_passt_nicht', NULL),
    ('befunde', 7, 'periode_nicht_zu_ende', NULL),
    ('befunde', 8, 'zeit_mehrdeutig', NULL),
    ('befunde', 9, 'zeit_nicht_vorhanden', NULL),
    ('befunde', 10, 'zahl_unlesbar', NULL),
    ('befunde', 11, 'datum_unlesbar', NULL),
    ('befunde', 12, 'bezug_unbekannt', NULL),
    ('befunde', 13, 'wert_negativ', NULL),
    ('befunde', 14, 'wert_unplausibel', NULL),
    ('befunde', 15, 'keine_datenzeilen', NULL),
    ('befunde', 16, 'datei_zu_gross', NULL),
    ('befunde', 17, 'kodierung_unlesbar', NULL),
    ('kodierung', 1, 'utf-8', NULL),
    ('kodierung', 2, 'windows-1252', NULL),
    ('trennzeichen', 1, ';', NULL),
    ('trennzeichen', 2, ',', NULL),
    ('trennzeichen', 3, E'\t', NULL),
    ('einheiten', 1, 'kg', 'masse'),
    ('einheiten', 2, 't', 'masse'),
    ('einheiten', 3, 'Stück', 'stueckzahl'),
    ('einheiten', 4, 'h', 'zeit'),
    ('einheiten', 5, 'min', 'zeit'),
    ('einheiten', 6, 'm²', 'flaeche'),
    ('einheiten', 7, 'm³', 'volumen'),
    ('einheiten', 8, 'l', 'volumen'),
    ('einheiten', 9, 'Personen', 'personen'),
    ('einheiten', 10, 'Schichten', 'schichten'),
    ('einheiten', 11, 'Kd', 'gradtage'),
    ('einheiten', 12, '°C', 'temperatur')
$$;

-- Der Art-Katalog (siehe Kopf, Punkt 2).
CREATE OR REPLACE FUNCTION bezugsarten() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $catalog$
SELECT $json$
{
  "produktionsmenge": {
    "name": "Produktionsmenge",
    "einheiten": [
      "kg",
      "t",
      "Stück",
      "m³",
      "l"
    ],
    "wertart": "periodenwert",
    "perioden": [
      "tag",
      "woche",
      "monat"
    ],
    "geltung": [
      "prozess",
      "bereich",
      "gebaeude",
      "standort",
      "unternehmen",
      "kostenstelle"
    ],
    "herkunft": [
      "eingabe",
      "import",
      "messkanal"
    ]
  },
  "gutteile": {
    "name": "Gutteile",
    "einheiten": [
      "Stück"
    ],
    "wertart": "periodenwert",
    "perioden": [
      "tag",
      "woche",
      "monat"
    ],
    "geltung": [
      "prozess",
      "bereich",
      "gebaeude",
      "standort",
      "unternehmen",
      "kostenstelle"
    ],
    "herkunft": [
      "eingabe",
      "import",
      "messkanal"
    ]
  },
  "betriebszeit": {
    "name": "Betriebszeit",
    "einheiten": [
      "h",
      "min"
    ],
    "wertart": "periodenwert",
    "perioden": [
      "tag",
      "woche",
      "monat"
    ],
    "geltung": [
      "prozess",
      "bereich",
      "messstelle"
    ],
    "herkunft": [
      "eingabe",
      "import",
      "messkanal"
    ]
  },
  "schichten": {
    "name": "Schichten",
    "einheiten": [
      "Schichten"
    ],
    "wertart": "periodenwert",
    "perioden": [
      "tag",
      "woche",
      "monat"
    ],
    "geltung": [
      "standort",
      "prozess",
      "bereich"
    ],
    "herkunft": [
      "eingabe",
      "import"
    ]
  },
  "bezugsflaeche": {
    "name": "Bezugsfläche",
    "einheiten": [
      "m²"
    ],
    "wertart": "stammdatum",
    "perioden": [],
    "geltung": [
      "standort",
      "gebaeude",
      "bereich"
    ],
    "herkunft": [
      "stammdatum_ap02"
    ]
  },
  "mitarbeitende": {
    "name": "Mitarbeitende",
    "einheiten": [
      "Personen"
    ],
    "wertart": "stammdatum",
    "perioden": [],
    "geltung": [
      "unternehmen",
      "standort"
    ],
    "herkunft": [
      "eingabe",
      "import"
    ]
  },
  "gradtagzahl": {
    "name": "Gradtagzahl",
    "einheiten": [
      "Kd"
    ],
    "wertart": "periodenwert",
    "perioden": [
      "tag",
      "monat"
    ],
    "geltung": [
      "standort"
    ],
    "herkunft": [
      "messkanal",
      "import",
      "bezogen"
    ]
  },
  "zaehlerstand": {
    "name": "Zählerstand (Ablesung)",
    "einheiten": "messstelle",
    "wertart": "stand",
    "perioden": [],
    "geltung": [
      "messstelle"
    ],
    "herkunft": [
      "eingabe",
      "import"
    ]
  },
  "sonstige_menge": {
    "name": "Sonstige Menge",
    "einheiten": "alle",
    "wertart": "periodenwert",
    "perioden": [
      "tag",
      "woche",
      "monat",
      "jahr"
    ],
    "geltung": "alle",
    "herkunft": [
      "eingabe",
      "import"
    ]
  },
  "betriebszeit_aus_leistung": {
    "name": "Betriebszeit aus Leistung",
    "einheiten": [
      "h",
      "min"
    ],
    "wertart": "periodenwert",
    "perioden": [
      "tag",
      "woche",
      "monat"
    ],
    "geltung": [
      "prozess",
      "bereich",
      "messstelle"
    ],
    "herkunft": [
      "messkanal"
    ]
  }
}
$json$::jsonb
$catalog$;

-- -----------------------------------------------------------------------------
-- 3. Welche Gradtagzahl VoltPilot bezieht. Eine Zeile je Bezugsgröße; `von` ist der erste Tag,
--    für den bezogen wird (nie ein Tag nach gestern — das prüft der Abruf, nicht die Tabelle).
-- -----------------------------------------------------------------------------
CREATE TABLE bezugsgroesse_wetterbezug (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    bezugsgroesse_id uuid NOT NULL,
    raumtemperatur numeric NOT NULL DEFAULT 20,
    heizgrenze numeric NOT NULL DEFAULT 15,
    von date NOT NULL,
    actor_sub text,
    actor_name text NOT NULL CHECK (btrim(actor_name) <> ''),
    actor_art text NOT NULL CHECK (actor_art IN ('kunde','unterstuetzung','voltpilot','notfall')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, tenant_id),
    CONSTRAINT bezugswetter_eine_je_bezug UNIQUE (tenant_id, bezugsgroesse_id),
    CONSTRAINT bezugswetter_bezug_fk FOREIGN KEY (bezugsgroesse_id, tenant_id)
        REFERENCES bezugsgroesse(id, tenant_id),
    CONSTRAINT bezugswetter_grenzen_chk CHECK (coalesce(raumtemperatur > heizgrenze
        AND raumtemperatur NOT IN ('NaN'::numeric,'Infinity'::numeric)
        AND heizgrenze NOT IN ('NaN'::numeric,'-Infinity'::numeric), false))
);
ALTER TABLE bezugsgroesse_wetterbezug ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsgroesse_wetterbezug FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bezugsgroesse_wetterbezug
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
REVOKE ALL ON bezugsgroesse_wetterbezug FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON bezugsgroesse_wetterbezug TO ${appDbUser}, ${adminDbUser};
GRANT INSERT (tenant_id,bezugsgroesse_id,raumtemperatur,heizgrenze,von,actor_sub,actor_name,actor_art)
    ON bezugsgroesse_wetterbezug TO ${appDbUser};
GRANT DELETE ON bezugsgroesse_wetterbezug TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- 4. Die Herkunft einer bezogenen Fassung. Nur ein Wert mit Herkunft `bezogen` trägt sie;
--    jeder Bestandswert bleibt NULL.
-- -----------------------------------------------------------------------------
ALTER TABLE bezugsgroesse_wert ADD COLUMN bezug_quelle text;
ALTER TABLE bezugsgroesse_wert ADD COLUMN abgerufen_am timestamptz;
ALTER TABLE bezugsgroesse_wert ADD COLUMN bezug_herkunft jsonb;
ALTER TABLE bezugsgroesse_wert ADD CONSTRAINT bezugswert_bezug_herkunft_chk CHECK (coalesce(
    (bezug_quelle IS NULL AND abgerufen_am IS NULL AND bezug_herkunft IS NULL)
    OR (herkunft_art = 'bezogen' AND btrim(bezug_quelle) <> '' AND abgerufen_am IS NOT NULL
      AND betrag IS NOT NULL AND bezug_herkunft->>'zustand' IN ('vollständig','unvollständig')), false));
GRANT INSERT (bezug_quelle, abgerufen_am, bezug_herkunft) ON bezugsgroesse_wert TO ${adminDbUser};

-- -----------------------------------------------------------------------------
-- 5. Die Elternsperre (V20260917100000): der Abruf schreibt wie der Kanal-Lauf als Systemlauf und
--    serialisiert seine Fassungen über eine eigene Reihen-Sperre (pg_advisory_xact_lock), ohne
--    UPDATE-Recht auf die Bezugsgröße. Anders als beim Messkanal bleibt die Prüfung „ein Zeitraum,
--    eine Quelle“: ein bezogener Wert in einem an einen Kanal gebundenen Zeitraum wird abgelehnt.
--    Abgeschrieben aus V20260917100000; neu ist nur die Bedingung vor PERFORM.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bezugskanal_eine_quelle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'bezugsgroesse_wert' THEN
        -- Der Systemlauf serialisiert seine Fassungen über die Reihen-Sperre.
        IF NEW.herkunft_art = 'messkanal' THEN RETURN NEW; END IF;
        -- Der Abruf des Wetter-Archivs ebenso; die Kanal-Prüfung unten gilt für ihn weiter.
        -- (Verschachtelt: plpgsql wertet AND nicht kurz aus, und die Kanalbindung hat kein herkunft_art.)
        IF NEW.herkunft_art <> 'bezogen' THEN
            PERFORM 1 FROM bezugsgroesse WHERE id=NEW.bezugsgroesse_id AND tenant_id=NEW.tenant_id FOR UPDATE;
        END IF;
    ELSE
        PERFORM 1 FROM bezugsgroesse WHERE id=NEW.bezugsgroesse_id AND tenant_id=NEW.tenant_id FOR UPDATE;
    END IF;
    IF TG_TABLE_NAME = 'bezugsgroesse_wert' THEN
        IF NEW.herkunft_art <> 'messkanal' AND EXISTS (
            SELECT 1 FROM bezugsgroesse_kanalbindung k WHERE k.tenant_id=NEW.tenant_id
            AND k.bezugsgroesse_id=NEW.bezugsgroesse_id AND tstzrange(k.von,k.bis,'[)') &&
            tstzrange(NEW.periode_von::timestamp AT TIME ZONE NEW.zeitzone,
                (NEW.periode_bis+1)::timestamp AT TIME ZONE NEW.zeitzone,'[)')) THEN
            RAISE EXCEPTION 'kanal_gebunden' USING ERRCODE='23514', CONSTRAINT='bezugskanal_eine_quelle';
        END IF;
    ELSE
        IF EXISTS (SELECT 1 FROM bezugsgroesse_wert w WHERE w.tenant_id=NEW.tenant_id
            AND w.bezugsgroesse_id=NEW.bezugsgroesse_id AND tstzrange(NEW.von,NEW.bis,'[)') &&
            tstzrange(w.periode_von::timestamp AT TIME ZONE w.zeitzone,
                (w.periode_bis+1)::timestamp AT TIME ZONE w.zeitzone,'[)')) THEN
            RAISE EXCEPTION 'zeitraum_hat_werte' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
