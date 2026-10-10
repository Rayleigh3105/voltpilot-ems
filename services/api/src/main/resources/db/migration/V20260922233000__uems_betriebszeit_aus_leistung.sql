-- AP-16 IP-26 / E9: additive Art und unveränderliche Schwellenfassungen in der Kanalbindung.
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

ALTER TABLE bezugsgroesse_kanalbindung
    ADD COLUMN messstelle_id uuid,
    ADD COLUMN schwelle_kw numeric,
    ADD COLUMN begruendung text,
    ADD COLUMN fassung integer,
    ADD COLUMN ersetzt_bindung_id uuid,
    ADD CONSTRAINT bezugskanal_messstelle_fk FOREIGN KEY (messstelle_id,tenant_id) REFERENCES messstelle(id,tenant_id),
    ADD CONSTRAINT bezugskanal_vorgaenger_fk FOREIGN KEY (ersetzt_bindung_id,tenant_id) REFERENCES bezugsgroesse_kanalbindung(id,tenant_id),
    ADD CONSTRAINT bezugskanal_fassung_uq UNIQUE (tenant_id,bezugsgroesse_id,fassung);
ALTER TABLE bezugsgroesse_kanalbindung DROP CONSTRAINT bezugskanal_gradtag_chk;
ALTER TABLE bezugsgroesse_kanalbindung ADD CONSTRAINT bezugskanal_gradtag_chk CHECK (coalesce(
    (schwelle_kw IS NULL AND messstelle_id IS NULL AND begruendung IS NULL AND fassung IS NULL AND ersetzt_bindung_id IS NULL
      AND ((wertart='gauge' AND einheit='°C' AND raumtemperatur IS NOT NULL AND heizgrenze IS NOT NULL
        AND raumtemperatur > heizgrenze AND raumtemperatur NOT IN ('NaN'::numeric,'Infinity'::numeric)
        AND heizgrenze NOT IN ('NaN'::numeric,'-Infinity'::numeric))
        OR (wertart<>'gauge' AND raumtemperatur IS NULL AND heizgrenze IS NULL)))
    OR (schwelle_kw IS NOT NULL AND schwelle_kw >= 0 AND schwelle_kw NOT IN ('NaN'::numeric,'Infinity'::numeric)
      AND wertart='gauge' AND einheit IN ('W','kW') AND messstelle_id IS NOT NULL
      AND begruendung IS NOT NULL AND length(btrim(begruendung)) BETWEEN 10 AND 2000
      AND fassung IS NOT NULL AND fassung >= 1 AND ((fassung=1) = (ersetzt_bindung_id IS NULL))
      AND raumtemperatur IS NULL AND heizgrenze IS NULL),false));
GRANT INSERT (messstelle_id,schwelle_kw,begruendung,fassung,ersetzt_bindung_id)
    ON bezugsgroesse_kanalbindung TO ${appDbUser};

-- Nur der begründete Messkanal speist diese Art, auch vor der ersten Bindung.
CREATE FUNCTION betriebszeit_nur_messkanal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM bezugsgroesse WHERE id=NEW.bezugsgroesse_id AND tenant_id=NEW.tenant_id
        AND art='betriebszeit_aus_leistung') AND NEW.herkunft_art<>'messkanal' THEN
        RAISE EXCEPTION 'Betriebszeit aus Leistung benötigt eine Schwellenfassung' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER betriebszeit_nur_messkanal BEFORE INSERT ON bezugsgroesse_wert
    FOR EACH ROW EXECUTE FUNCTION betriebszeit_nur_messkanal();

CREATE FUNCTION betriebszeit_bindung_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bezugsart text; vorher bezugsgroesse_kanalbindung%ROWTYPE;
BEGIN
    SELECT art INTO bezugsart FROM bezugsgroesse WHERE id=NEW.bezugsgroesse_id
        AND tenant_id=NEW.tenant_id FOR UPDATE;
    IF (coalesce(bezugsart='betriebszeit_aus_leistung',false)) <> (NEW.schwelle_kw IS NOT NULL) THEN
        RAISE EXCEPTION 'Leistungsschwelle und Bezugsgrößen-Art passen nicht' USING ERRCODE='23514';
    END IF;
    IF NEW.schwelle_kw IS NOT NULL THEN
        SELECT * INTO vorher FROM bezugsgroesse_kanalbindung
            WHERE tenant_id=NEW.tenant_id AND bezugsgroesse_id=NEW.bezugsgroesse_id ORDER BY fassung DESC LIMIT 1;
        IF (vorher.id IS NULL AND NEW.fassung<>1)
            OR (vorher.id IS NOT NULL AND (NEW.fassung<>vorher.fassung+1
                OR NEW.ersetzt_bindung_id IS DISTINCT FROM vorher.id OR vorher.bis IS NULL OR vorher.bis>NEW.von)) THEN
            RAISE EXCEPTION 'Eine neue Schwellenfassung folgt ihrer beendeten Vorgängerin' USING ERRCODE='23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM messstelle_quelle q WHERE q.tenant_id=NEW.tenant_id
            AND q.messstelle_id=NEW.messstelle_id AND q.entity_id=NEW.entity_id AND q.kanal=NEW.kanal
            AND q.groesse='Wirkleistung' AND q.kanal_wertart='gauge' AND q.rolle='fuehrend'
            AND q.gueltig_ab<=NEW.von AND (q.gueltig_bis IS NULL OR q.gueltig_bis>NEW.von)) THEN
            RAISE EXCEPTION 'Der Leistungskanal ist keine führende Quelle der Messstelle' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER betriebszeit_bindung_pruefen BEFORE INSERT ON bezugsgroesse_kanalbindung
    FOR EACH ROW EXECUTE FUNCTION betriebszeit_bindung_pruefen();
