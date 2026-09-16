-- AP-04 A3: nur Grenzen eines noch nicht wirksamen, protokollierten Wechsels.
-- Jede neue Berechtigung betrifft ausschließlich den Beginn des Nachfolgers.
GRANT UPDATE (eingebaut_am) ON geraet TO ${appDbUser};
GRANT UPDATE (eingebaut_am) ON geraet_teil TO ${appDbUser};
GRANT UPDATE (gueltig_ab) ON geraet_komponente TO ${appDbUser};
GRANT UPDATE (gueltig_ab) ON messstelle_quelle TO ${appDbUser};
GRANT UPDATE (gueltig_ab) ON quelle_einstellung TO ${appDbUser};

-- Läuft unter RLS, kein SECURITY DEFINER und keine frei setzbare Sitzungsfreigabe.
CREATE FUNCTION uems_wechsel_partner(gid UUID, beginn BOOLEAN) RETURNS UUID
LANGUAGE sql STABLE AS $$
 SELECT partner.id FROM geraet g JOIN geraet partner
   ON partner.tenant_id=g.tenant_id AND partner.kennzeichen=g.kennzeichen AND partner.id<>g.id
 WHERE g.id=gid AND (EXISTS (
   SELECT 1 FROM messstelle_aenderung a WHERE a.tenant_id=g.tenant_id
     AND a.art='zaehler_gewechselt'
     AND a.neu->>'vorgaenger'=CASE WHEN beginn THEN partner.einbau_kennzeichen ELSE g.einbau_kennzeichen END
     AND a.neu->>'einbau'=CASE WHEN beginn THEN g.einbau_kennzeichen ELSE partner.einbau_kennzeichen END
 ) OR EXISTS (
   SELECT 1 FROM component_change_event e WHERE e.tenant_id=g.tenant_id
     AND e.site_id=g.site_id AND e.event_type='device_replaced'
     AND e.from_value=CASE WHEN beginn THEN partner.einbau_kennzeichen ELSE g.einbau_kennzeichen END
     AND e.to_value=CASE WHEN beginn THEN g.einbau_kennzeichen ELSE partner.einbau_kennzeichen END
 )) LIMIT 1
$$;

CREATE FUNCTION uems_wechsel_grenze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 alt JSONB := to_jsonb(OLD); neu JSONB := to_jsonb(NEW);
 startfeld TEXT := CASE WHEN TG_TABLE_NAME IN ('geraet','geraet_teil') THEN 'eingebaut_am' ELSE 'gueltig_ab' END;
 endfeld TEXT := CASE WHEN TG_TABLE_NAME IN ('geraet','geraet_teil') THEN 'ausgebaut_am' ELSE 'gueltig_bis' END;
 feld TEXT; vorher TIMESTAMPTZ; nachher TIMESTAMPTZ; gid UUID; geraetegrenze TIMESTAMPTZ;
BEGIN
 gid := CASE WHEN TG_TABLE_NAME='geraet' THEN (alt->>'id')::uuid ELSE (alt->>'geraet_id')::uuid END;
 FOREACH feld IN ARRAY ARRAY[startfeld,endfeld] LOOP
   IF alt->feld IS NOT DISTINCT FROM neu->feld OR (TG_TABLE_NAME='quelle_einstellung' AND feld=endfeld) THEN CONTINUE; END IF;
   -- Erstmaliges Beenden bleibt der bestehende Schreibweg.
   IF feld=endfeld AND alt->>feld IS NULL THEN CONTINUE; END IF;
   vorher := (alt->>feld)::timestamptz; nachher := (neu->>feld)::timestamptz;
   -- Nur die gemeinsame Wechselgrenze, keine separat angekündigte spätere Fassung.
   -- Deshalb ändert der Dienst die Kinder vor dem zugehörigen Gerät.
   IF TG_TABLE_NAME<>'geraet' THEN
     SELECT CASE WHEN feld=startfeld THEN eingebaut_am ELSE ausgebaut_am END
       INTO geraetegrenze FROM geraet WHERE id=gid;
     IF vorher IS DISTINCT FROM geraetegrenze THEN
       RAISE EXCEPTION 'Nur die gemeinsame Wechselgrenze darf berichtigt werden'
         USING ERRCODE='check_violation', CONSTRAINT='uems_wechsel_gemeinsame_grenze';
     END IF;
   END IF;
   IF vorher IS NULL OR nachher IS NULL OR vorher<=clock_timestamp() OR nachher<=clock_timestamp()
      OR uems_wechsel_partner(gid,feld=startfeld) IS NULL THEN
     RAISE EXCEPTION 'Nur ein noch nicht wirksamer Wechsel darf berichtigt werden'
       USING ERRCODE='check_violation', CONSTRAINT='uems_wechsel_nur_geplant';
   END IF;
 END LOOP;
 RETURN NEW;
END $$;

-- Auch direkte Spalten-Updates müssen beim Commit zur Gerätegrenze passen.
CREATE FUNCTION uems_wechsel_grenze_konsistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 alt JSONB := to_jsonb(OLD); neu JSONB := to_jsonb(NEW);
 startfeld TEXT := CASE WHEN TG_TABLE_NAME IN ('geraet','geraet_teil') THEN 'eingebaut_am' ELSE 'gueltig_ab' END;
 endfeld TEXT := CASE WHEN TG_TABLE_NAME IN ('geraet','geraet_teil') THEN 'ausgebaut_am' ELSE 'gueltig_bis' END;
 feld TEXT; gid UUID; partner UUID; grenze TIMESTAMPTZ;
BEGIN
 gid := CASE WHEN TG_TABLE_NAME='geraet' THEN (alt->>'id')::uuid ELSE (alt->>'geraet_id')::uuid END;
 FOREACH feld IN ARRAY ARRAY[startfeld,endfeld] LOOP
   IF alt->feld IS NOT DISTINCT FROM neu->feld OR (TG_TABLE_NAME='quelle_einstellung' AND feld=endfeld) OR (feld=endfeld AND alt->>feld IS NULL) THEN CONTINUE; END IF;
   IF TG_TABLE_NAME='geraet' THEN
     partner := uems_wechsel_partner(gid,feld=startfeld);
     SELECT CASE WHEN feld=startfeld THEN ausgebaut_am ELSE eingebaut_am END INTO grenze FROM geraet WHERE id=partner;
   ELSE
     SELECT CASE WHEN feld=startfeld THEN eingebaut_am ELSE ausgebaut_am END INTO grenze FROM geraet WHERE id=gid;
   END IF;
   IF (alt->>feld)::timestamptz<=clock_timestamp() OR (neu->>feld)::timestamptz<=clock_timestamp() THEN
     RAISE EXCEPTION 'Nur ein noch nicht wirksamer Wechsel darf berichtigt werden'
       USING ERRCODE='check_violation', CONSTRAINT='uems_wechsel_nur_geplant';
   END IF;
   IF grenze IS DISTINCT FROM (neu->>feld)::timestamptz THEN
     RAISE EXCEPTION 'Die Grenzen des Wechsels müssen zusammen berichtigt werden'
       USING ERRCODE='check_violation', CONSTRAINT='uems_wechsel_gemeinsame_grenze';
   END IF;
 END LOOP;
 RETURN NULL;
END $$;

DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['geraet','geraet_teil','geraet_komponente','messstelle_quelle','quelle_einstellung'] LOOP
   EXECUTE format('CREATE TRIGGER uems_wechsel_grenze BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION uems_wechsel_grenze()',t);
   EXECUTE format('CREATE CONSTRAINT TRIGGER uems_wechsel_grenze_konsistent AFTER UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION uems_wechsel_grenze_konsistent()',t);
 END LOOP;
END $$;

-- Vollständiger aktueller Wächter aus V20260913180000, einschließlich Herkunft und Anteil.
CREATE OR REPLACE FUNCTION messstelle_quelle_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Zusätzliche Trigger prüfen Zukunft, Wechselbeleg und gemeinsame Grenze.
  IF TG_OP='UPDATE' AND uems_wechsel_partner(OLD.geraet_id, NEW.gueltig_ab IS DISTINCT FROM OLD.gueltig_ab) IS NOT NULL
     AND (to_jsonb(NEW)-'gueltig_ab'-'gueltig_bis')=(to_jsonb(OLD)-'gueltig_ab'-'gueltig_bis')
     AND (NEW.gueltig_ab IS DISTINCT FROM OLD.gueltig_ab
          OR (OLD.gueltig_bis IS NOT NULL AND NEW.gueltig_bis IS DISTINCT FROM OLD.gueltig_bis)) THEN
    RETURN NEW;
  END IF;


  IF TG_OP = 'UPDATE' THEN
    -- Nie überschrieben, nur beendet (Regel 2): genau EINMAL von offen auf
    -- einen Zeitpunkt, der Endstand darf dabei mitkommen — sonst nichts.
    IF OLD.gueltig_bis IS NOT NULL OR NEW.gueltig_bis IS NULL
       OR (NEW.id, NEW.tenant_id, NEW.messstelle_id, NEW.groesse, NEW.richtung, NEW.entity_id,
           NEW.geraet_id, NEW.kanal, NEW.kanal_wertart, NEW.herleitung, NEW.rolle, NEW.zweck,
           NEW.gueltig_ab, NEW.anfangsstand, NEW.anfangsstand_einheit, NEW.rueckwirkend,
           NEW.herkunft, NEW.anteil, NEW.eingetragen_am, NEW.actor_sub, NEW.actor_name,
           NEW.actor_rolle, NEW.actor_art, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.messstelle_id, OLD.groesse, OLD.richtung, OLD.entity_id,
           OLD.geraet_id, OLD.kanal, OLD.kanal_wertart, OLD.herleitung, OLD.rolle, OLD.zweck,
           OLD.gueltig_ab, OLD.anfangsstand, OLD.anfangsstand_einheit, OLD.rueckwirkend,
           OLD.herkunft, OLD.anteil, OLD.eingetragen_am, OLD.actor_sub, OLD.actor_name,
           OLD.actor_rolle, OLD.actor_art, OLD.created_at) THEN
      RAISE EXCEPTION 'Eine Quellenbindung wird nie ueberschrieben, nur einmal beendet (%)', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_quelle_nie_ueberschrieben';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
        SELECT 1 FROM messstelle m
         WHERE m.id = NEW.messstelle_id AND m.tenant_id = NEW.tenant_id
           AND m.groesse = NEW.groesse AND m.richtung = NEW.richtung)
     AND NOT EXISTS (
        SELECT 1 FROM messstelle_groesse g
         WHERE g.messstelle_id = NEW.messstelle_id AND g.tenant_id = NEW.tenant_id
           AND g.groesse = NEW.groesse AND g.richtung = NEW.richtung) THEN
    RAISE EXCEPTION '% · % ist keine Groesse dieser Messstelle', NEW.groesse, NEW.richtung
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_quelle_groesse_der_messstelle';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION quelle_einstellung_nur_verkuerzen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Zusätzliche Trigger prüfen Zukunft, Wechselbeleg und gemeinsame Grenze.
  IF TG_OP='UPDATE' AND uems_wechsel_partner(OLD.geraet_id, NEW.gueltig_ab IS DISTINCT FROM OLD.gueltig_ab) IS NOT NULL
     AND (to_jsonb(NEW)-'gueltig_ab'-'gueltig_bis')=(to_jsonb(OLD)-'gueltig_ab'-'gueltig_bis')
     AND NEW.gueltig_ab IS DISTINCT FROM OLD.gueltig_ab AND NEW.gueltig_bis IS NOT DISTINCT FROM OLD.gueltig_bis THEN
    RETURN NEW;
  END IF;

    IF (NEW.id, NEW.tenant_id, NEW.geraet_id, NEW.entity_id, NEW.kanal, NEW.art, NEW.wert,
        NEW.anwendung, NEW.herkunft, NEW.gueltig_ab, NEW.tatsaechlich_ab, NEW.rueckwirkend,
        NEW.begruendung, NEW.actor_sub, NEW.actor_name, NEW.actor_rolle, NEW.actor_art,
        NEW.eingetragen_am)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.geraet_id, OLD.entity_id, OLD.kanal, OLD.art, OLD.wert,
        OLD.anwendung, OLD.herkunft, OLD.gueltig_ab, OLD.tatsaechlich_ab, OLD.rueckwirkend,
        OLD.begruendung, OLD.actor_sub, OLD.actor_name, OLD.actor_rolle, OLD.actor_art,
        OLD.eingetragen_am) THEN
        RAISE EXCEPTION 'Eine Einstellungs-Fassung wird nie umgeschrieben'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'quelle_einstellung_unveraenderlich';
    END IF;
    IF NEW.gueltig_bis IS DISTINCT FROM OLD.gueltig_bis
       AND (NEW.gueltig_bis IS NULL OR (OLD.gueltig_bis IS NOT NULL AND NEW.gueltig_bis > OLD.gueltig_bis)) THEN
        RAISE EXCEPTION 'Eine Einstellungs-Fassung wird nur verkürzt, nie verlängert'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'quelle_einstellung_nur_verkuerzen';
    END IF;
    RETURN NEW;
END
$$;

