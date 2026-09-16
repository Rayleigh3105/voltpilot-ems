-- AP-09 IP-17: minutengenaue Kanalbindung; keine Bestandszeile wird geändert.
CREATE TABLE bezugsgroesse_kanalbindung (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    bezugsgroesse_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    kanal text NOT NULL CHECK (btrim(kanal) <> ''),
    wertart text NOT NULL CHECK (wertart IN ('counter', 'state')),
    einheit text NOT NULL,
    zustand text,
    kadenz_s integer NOT NULL CHECK (kadenz_s BETWEEN 1 AND 86400),
    von timestamptz NOT NULL,
    bis timestamptz,
    actor_sub text,
    actor_name text NOT NULL CHECK (btrim(actor_name) <> ''),
    actor_rolle text,
    actor_art text NOT NULL CHECK (actor_art IN ('kunde','unterstuetzung','voltpilot','notfall')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, tenant_id),
    CONSTRAINT bezugskanal_bezug_fk FOREIGN KEY (bezugsgroesse_id, tenant_id)
        REFERENCES bezugsgroesse(id, tenant_id),
    CONSTRAINT bezugskanal_komponente_fk FOREIGN KEY (entity_id, tenant_id)
        REFERENCES measurement_point(id, tenant_id),
    CONSTRAINT bezugskanal_zustand_chk CHECK (coalesce(
        (wertart = 'state' AND btrim(zustand) <> '') OR (wertart = 'counter' AND zustand IS NULL), false)),
    CONSTRAINT bezugskanal_zeit_chk CHECK (coalesce(von = date_trunc('minute',von)
        AND (bis IS NULL OR (bis > von AND bis = date_trunc('minute',bis))), false)),
    CONSTRAINT bezugskanal_ueberlappt EXCLUDE USING gist
        (tenant_id WITH =, bezugsgroesse_id WITH =, tstzrange(von,bis,'[)') WITH &&)
);
ALTER TABLE bezugsgroesse_kanalbindung ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsgroesse_kanalbindung FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bezugsgroesse_kanalbindung
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
REVOKE ALL ON bezugsgroesse_kanalbindung FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON bezugsgroesse_kanalbindung TO ${appDbUser}, ${adminDbUser};
GRANT INSERT (tenant_id,bezugsgroesse_id,entity_id,kanal,wertart,einheit,zustand,kadenz_s,von,
    actor_sub,actor_name,actor_rolle,actor_art) ON bezugsgroesse_kanalbindung TO ${appDbUser};
GRANT UPDATE (bis) ON bezugsgroesse_kanalbindung TO ${appDbUser};
GRANT DELETE ON bezugsgroesse_kanalbindung TO ${adminDbUser};

-- Die Qualitätsangaben reisen mit jeder unveränderlichen Wert-Fassung. Die alten Zeilen bleiben NULL.
ALTER TABLE bezugsgroesse_wert ADD COLUMN kanal_herkunft jsonb;
ALTER TABLE bezugsgroesse_wert ADD CONSTRAINT bezugswert_kanal_herkunft_chk CHECK (
    kanal_herkunft IS NULL OR (herkunft_art = 'messkanal' AND coalesce(
      kanal_herkunft->>'zustand' IN ('vollständig','unvollständig','keine Werte')
      AND (kanal_herkunft->>'abdeckung_prozent')::numeric BETWEEN 0 AND 100
      AND ((kanal_herkunft->>'zustand' = 'keine Werte') = (betrag IS NULL)), false)));
ALTER TABLE bezugsgroesse_wert DROP CONSTRAINT bezugsgroesse_wert_betrag_chk;
ALTER TABLE bezugsgroesse_wert ADD CONSTRAINT bezugsgroesse_wert_betrag_chk CHECK (coalesce(
    (betrag IS NOT NULL OR vorgang = 'ruecknahme' OR (herkunft_art = 'messkanal' AND kanal_herkunft IS NOT NULL))
    AND (status <> 'zurueckgenommen' OR (vorgang = 'ruecknahme' AND betrag IS NULL)), false));
GRANT INSERT (kanal_herkunft) ON bezugsgroesse_wert TO ${adminDbUser};
-- Der Lauf nutzt dieselben anlegenden Spalten wie die Anwendung, keine UPDATE-Rechte.
GRANT INSERT (tenant_id,bezugsgroesse_id,wertart,einheit,periode_art,periode_von,periode_bis,
    zeitzone,fassung,ersetzt_fassung,vorgang,status,betrag,begruendung,herkunft_art,kennzeichen,
    actor_name,actor_art) ON bezugsgroesse_wert TO ${adminDbUser};

ALTER TABLE bezugsgroesse_aenderung DROP CONSTRAINT bezugsgroesse_aenderung_art_chk;
ALTER TABLE bezugsgroesse_aenderung ADD CONSTRAINT bezugsgroesse_aenderung_art_chk CHECK
    (art IN ('angelegt','bearbeitet','archiviert','geloescht','stammdatum_eingetragen','kanal_gebunden','kanal_beendet'));

CREATE FUNCTION bezugskanal_nur_beenden() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.bis IS NOT NULL OR NEW.bis IS NULL
       OR (to_jsonb(NEW) - 'bis') IS DISTINCT FROM (to_jsonb(OLD) - 'bis') THEN
        RAISE EXCEPTION 'Eine Kanalbindung wird nur einmal beendet' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER bezugskanal_nur_beenden BEFORE UPDATE ON bezugsgroesse_kanalbindung
    FOR EACH ROW EXECUTE FUNCTION bezugskanal_nur_beenden();

-- M5/K6 auch für spätere Schreibwege; dieselbe Elternsperre serialisiert Binden und Eintragen.
CREATE FUNCTION bezugskanal_eine_quelle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'bezugsgroesse_wert' THEN
        -- Der Systemlauf serialisiert seine Fassungen über die Reihen-Sperre.
        IF NEW.herkunft_art = 'messkanal' THEN RETURN NEW; END IF;
    END IF;
    PERFORM 1 FROM bezugsgroesse WHERE id=NEW.bezugsgroesse_id AND tenant_id=NEW.tenant_id FOR UPDATE;
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
CREATE TRIGGER bezugskanal_eine_quelle BEFORE INSERT ON bezugsgroesse_kanalbindung
    FOR EACH ROW EXECUTE FUNCTION bezugskanal_eine_quelle();
CREATE TRIGGER bezugswert_eine_quelle BEFORE INSERT ON bezugsgroesse_wert
    FOR EACH ROW EXECUTE FUNCTION bezugskanal_eine_quelle();

CREATE TABLE bezugsgroesse_kanallauf (
    tenant_id uuid NOT NULL,
    bindung_id uuid NOT NULL,
    naechster_tag date NOT NULL,
    eingang timestamptz NOT NULL,
    PRIMARY KEY (tenant_id,bindung_id),
    FOREIGN KEY (bindung_id, tenant_id) REFERENCES bezugsgroesse_kanalbindung(id, tenant_id)
);
ALTER TABLE bezugsgroesse_kanallauf ENABLE ROW LEVEL SECURITY;
ALTER TABLE bezugsgroesse_kanallauf FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bezugsgroesse_kanallauf
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true),'')::uuid);
REVOKE ALL ON bezugsgroesse_kanallauf FROM ${appDbUser}, ${adminDbUser};
GRANT SELECT ON bezugsgroesse_kanallauf TO ${appDbUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON bezugsgroesse_kanallauf TO ${adminDbUser};

-- Auch eine noch wertlose Bindung hält Bedeutung und Geltungsbereich fest.
CREATE FUNCTION bezugskanal_bedeutung_bleibt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW)-ARRAY['name','kennzeichen','archiviert_am','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['name','kennzeichen','archiviert_am','updated_at'])
       AND EXISTS (SELECT 1 FROM bezugsgroesse_kanalbindung WHERE tenant_id=OLD.tenant_id AND bezugsgroesse_id=OLD.id) THEN
        RAISE EXCEPTION 'Die Bedeutung einer gebundenen Bezugsgröße bleibt erhalten' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER bezugskanal_bedeutung_bleibt BEFORE UPDATE ON bezugsgroesse
    FOR EACH ROW EXECUTE FUNCTION bezugskanal_bedeutung_bleibt();
