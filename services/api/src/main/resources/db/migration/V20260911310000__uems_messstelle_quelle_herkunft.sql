-- =============================================================================
-- UEMS AP-04 IP-16: die HERKUNFT einer Quellenbindung (Konzept
-- vp-uems-ap04-messstellen E6 „die Bindung beginnt am Beginn des Verlaufs
-- (rückwirkend, markiert „Bestandsübernahme")", §5.2, §5.15, Abnahme A9).
--
-- EINE additive Spalte an `messstelle_quelle`; keine bestehende Zeile, kein
-- Vertrag und keine Box wird berührt:
--
--   herkunft   NULL = von Hand gebunden (der Weg von IP-13, §5.2);
--              'bestandsuebernahme' = aus der Vorschlagsliste des Standorts
--              übernommen (IP-16). Geschlossenes Vokabular — ein Wort außerhalb
--              wird VERWORFEN, nie geraten.
--
-- ⚠ Sie ist Teil dessen, was NIE ÜBERSCHRIEBEN wird (Regel 2): der Trigger
-- `messstelle_quelle_pruefen` vergleicht sie ab hier mit; die App-Rolle hat
-- ohnehin nur UPDATE (gueltig_bis, endstand, endstand_einheit). Das INSERT-Recht
-- steht auf Tabellenebene (V20260911250000) und deckt die neue Spalte mit.
-- =============================================================================

ALTER TABLE messstelle_quelle ADD COLUMN IF NOT EXISTS herkunft TEXT;

ALTER TABLE messstelle_quelle DROP CONSTRAINT IF EXISTS messstelle_quelle_herkunft_chk;
ALTER TABLE messstelle_quelle ADD CONSTRAINT messstelle_quelle_herkunft_chk
    CHECK (herkunft IS NULL OR herkunft = 'bestandsuebernahme');

COMMENT ON COLUMN messstelle_quelle.herkunft IS
    'Woher die Bindung stammt: NULL = von Hand, ''bestandsuebernahme'' = aus der Vorschlagsliste (AP-04 E6, IP-16).';

-- -----------------------------------------------------------------------------
-- Der Trigger, geweitet: der AKTUELLE Stand (V20260911250000) plus `herkunft`.
-- Abgeschrieben, nie „ergänzt" — die Tupel-Prüfung ist eine Aufzählung, und eine
-- vergessene Spalte wäre still änderbar.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messstelle_quelle_pruefen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Nie überschrieben, nur beendet (Regel 2): genau EINMAL von offen auf
    -- einen Zeitpunkt, der Endstand darf dabei mitkommen — sonst nichts.
    IF OLD.gueltig_bis IS NOT NULL OR NEW.gueltig_bis IS NULL
       OR (NEW.id, NEW.tenant_id, NEW.messstelle_id, NEW.groesse, NEW.richtung, NEW.entity_id,
           NEW.geraet_id, NEW.kanal, NEW.kanal_wertart, NEW.herleitung, NEW.rolle, NEW.zweck,
           NEW.gueltig_ab, NEW.anfangsstand, NEW.anfangsstand_einheit, NEW.rueckwirkend,
           NEW.herkunft, NEW.eingetragen_am, NEW.actor_sub, NEW.actor_name, NEW.actor_rolle,
           NEW.actor_art, NEW.created_at)
          IS DISTINCT FROM
          (OLD.id, OLD.tenant_id, OLD.messstelle_id, OLD.groesse, OLD.richtung, OLD.entity_id,
           OLD.geraet_id, OLD.kanal, OLD.kanal_wertart, OLD.herleitung, OLD.rolle, OLD.zweck,
           OLD.gueltig_ab, OLD.anfangsstand, OLD.anfangsstand_einheit, OLD.rueckwirkend,
           OLD.herkunft, OLD.eingetragen_am, OLD.actor_sub, OLD.actor_name, OLD.actor_rolle,
           OLD.actor_art, OLD.created_at) THEN
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
