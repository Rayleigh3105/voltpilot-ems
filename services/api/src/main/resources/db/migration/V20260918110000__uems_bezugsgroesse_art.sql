-- Art ist ein eigenes Datum (AP-09 §4.2 M1, §5, §6.1).
-- Katalog aus bezugsdaten-vectors.json / arten.je_art, ohne Belegtext `konzept`.
-- UemsBezugsArtMigrationTest vergleicht ihn vollständig mit dem Vertrag.
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
      "import"
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
  }
}$json$::jsonb
$catalog$;

CREATE OR REPLACE FUNCTION bezugsart_passt(a text, w text, e text, p text, g text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(d->>'wertart' = w
    AND (d->'geltung' = '"alle"'::jsonb OR d->'geltung' ? g)
    AND (d->'einheiten' IN ('"alle"'::jsonb, '"messstelle"'::jsonb) OR d->'einheiten' ? e)
    AND bezugsdaten_wort('einheiten', e)
    AND CASE WHEN jsonb_array_length(d->'perioden') = 0 THEN p IS NULL
             ELSE p IS NOT NULL AND d->'perioden' ? p END, false)
  FROM (SELECT bezugsarten()->a AS d) katalog
$$;

ALTER TABLE bezugsgroesse ADD COLUMN art text;

-- Idempotenter Nachtrag: kein Name/ Kennzeichen/ Herkunft wird als Art gedeutet.
-- Mehrere Kandidaten (insbesondere Sonstige Menge) oder kein Kandidat bleiben NULL.
CREATE OR REPLACE FUNCTION bezugsart_eindeutig(w text, e text, p text, g text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(a) END
  FROM jsonb_object_keys(bezugsarten()) a WHERE bezugsart_passt(a,w,e,p,g)
$$;
UPDATE bezugsgroesse b SET art = bezugsart_eindeutig(wertart, einheit, periode_art, geltung_art)
WHERE art IS NULL AND bezugsart_eindeutig(wertart, einheit, periode_art, geltung_art) IS NOT NULL
  AND (wertart <> 'stand' OR EXISTS (SELECT 1 FROM messstelle m
       WHERE m.id = b.messstelle_id AND m.tenant_id = b.tenant_id AND m.einheit = b.einheit));

ALTER TABLE bezugsgroesse ADD CONSTRAINT bezugsgroesse_art_chk
  CHECK (art IS NULL OR bezugsart_passt(art,wertart,einheit,periode_art,geltung_art));
GRANT UPDATE (art) ON bezugsgroesse TO ${appDbUser};

-- Zusätzliche Wand, ohne die vorhandenen Identitäts-/Kanalwände zu ersetzen.
CREATE OR REPLACE FUNCTION bezugsgroesse_art_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.art IS DISTINCT FROM OLD.art AND (
      EXISTS (SELECT 1 FROM bezugsgroesse_wert WHERE bezugsgroesse_id = OLD.id AND tenant_id = OLD.tenant_id)
      OR EXISTS (SELECT 1 FROM bezugsgroesse_stammdatum WHERE bezugsgroesse_id = OLD.id AND tenant_id = OLD.tenant_id)
      OR EXISTS (SELECT 1 FROM bezugsgroesse_kanalbindung WHERE bezugsgroesse_id = OLD.id AND tenant_id = OLD.tenant_id)) THEN
    RAISE EXCEPTION 'Die Art hat Werte und ist nicht mehr änderbar'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bezugsgroesse_art_nach_erstem_wert';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bezugsgroesse_art_bleibt BEFORE UPDATE OF art ON bezugsgroesse
FOR EACH ROW EXECUTE FUNCTION bezugsgroesse_art_bleibt();
