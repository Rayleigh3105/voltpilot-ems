-- =============================================================================
-- UEMS AP-08 IP-7 — der ANTEIL an der Quellenbindung und die Anschlussleistung
-- der Messstelle (Konzept vp-uems-ap08-verbrauch E12/E15 = A, W8; Verträge
-- docs/contracts/v2/messstelle.md §5 Regel 7 „Ausnahme Anteil“ und
-- verbrauch-vectors.json regeln.anteil, Vektor F19).
--
-- Zwei additive Spalten und EIN gelockertes Verbot; keine bestehende Zeile
-- ändert sich, keine Box und kein Draht-Vertrag wird berührt:
--
--   messstelle_quelle.anteil   NULL = der ganze Wert (jede Bindung von vorher);
--                              'positiv' | 'negativ' = die Bindung liest nur
--                              diesen Teil eines Vorzeichen-Werts (Katalog
--                              import_export) — positiv speist Bezug, negativ
--                              Abgabe (MessstelleRegeln.ANTEIL_RICHTUNGEN).
--                              Die Bindung sagt SELBST, welchen Anteil sie
--                              speist; geteilt wird beim Lesen JE ROHWERT
--                              (VerbrauchRegeln.anteilJeRohwert), nie je
--                              Mittelwert. Das Box-Vorzeichen ist schon im
--                              Rohwert (AP-04 E5) — hier steht keins.
--   messstelle.anschlussleistung_kw
--                              optional, > 0: die Anschlussleistung am Messort;
--                              daraus der Höchstzuwachs je Kadenz
--                              (MessstelleRegeln.hoechstzuwachsJeKadenz, Z6).
--                              NULL = nicht deklariert, nie geraten.
--
-- ⚠ DAS GELOCKERTE VERBOT: „ein Messwert führt je Zeitpunkt höchstens EINE
-- Messstelle“ gilt ab hier JE ANTEIL. Der positive und der negative Anteil sind
-- zwei Messwerte (MS-01 Bezug UND MS-02 Abgabe aus K-3 · Wirkleistung); der
-- ganze Wert schließt jeden Anteil aus. Ausgedrückt als Bereich über dem Anteil:
-- positiv = [1,2), negativ = [2,3), ganz = [1,3) — zwei Bindungen stoßen
-- zusammen, wenn sich ihre Bereiche überschneiden. Für den Bestand (alle NULL)
-- ist das Verbot Zeichen für Zeichen das alte; Name und Rennen-Verhalten (23P01,
-- der Schreibweg urteilt neu) bleiben.
--
-- ⚠ NIE ÜBERSCHRIEBEN (Regel 2): `anteil` gehört zu dem, was eine Bindung nie
-- ändert — der Trigger wird darum abgeschrieben (Stand V20260911310000) und um
-- die Spalte geweitet; ein anderer Anteil ist eine neue Bindung. Die App-Rolle
-- hat ohnehin nur UPDATE (gueltig_bis, endstand, endstand_einheit) an der
-- Bindung; INSERT und das UPDATE an `messstelle` stehen auf Tabellenebene und
-- decken beide Spalten mit.
--
-- Nicht dieses Paket: der Rumpf von messreihe_zaehler_deklaration() bleibt leer
-- — ein Überlauf braucht auch den Wertebereich des Messwerts, und der hat noch
-- keinen Weg in die Datenbank (Katalog-Feld `wertebereich_modul` steht nur im
-- gepackten Katalog). Keine Saldo-Messstelle (AP-10), kein Lese-Modell je
-- Messstelle (IP-9), keine Speicherklasse je Anteil.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE messstelle_quelle ADD COLUMN IF NOT EXISTS anteil TEXT;

ALTER TABLE messstelle_quelle DROP CONSTRAINT IF EXISTS messstelle_quelle_anteil_chk;
ALTER TABLE messstelle_quelle ADD CONSTRAINT messstelle_quelle_anteil_chk
    CHECK (anteil IS NULL OR anteil IN ('positiv', 'negativ'));

COMMENT ON COLUMN messstelle_quelle.anteil IS
    'NULL = der ganze Wert; positiv/negativ = nur dieser Teil eines Vorzeichen-Werts, je Rohwert '
    'max(0, P) bzw. max(0, -P) beim Lesen (AP-08 E15, IP-7).';

-- Das Verbot „ein Messwert führt eine Messstelle“, je Anteil.
ALTER TABLE messstelle_quelle DROP CONSTRAINT IF EXISTS messstelle_quelle_kanal_fuehrt_eine_messstelle;
ALTER TABLE messstelle_quelle ADD CONSTRAINT messstelle_quelle_kanal_fuehrt_eine_messstelle
    EXCLUDE USING gist (
        tenant_id WITH =,
        entity_id WITH =,
        kanal WITH =,
        messstelle_id WITH <>,
        (CASE anteil WHEN 'positiv' THEN int4range(1, 2)
                     WHEN 'negativ' THEN int4range(2, 3)
                     ELSE int4range(1, 3) END) WITH &&,
        tstzrange(gueltig_ab, gueltig_bis, '[)') WITH &&
    ) WHERE (rolle = 'fuehrend');

-- -----------------------------------------------------------------------------
-- Der Trigger, geweitet: der AKTUELLE Stand (V20260911310000) plus `anteil`.
-- Abgeschrieben, nie „ergänzt“ — die Tupel-Prüfung ist eine Aufzählung.
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

-- -----------------------------------------------------------------------------
-- Die Anschlussleistung der Messstelle (optional).
-- -----------------------------------------------------------------------------
ALTER TABLE messstelle ADD COLUMN IF NOT EXISTS anschlussleistung_kw NUMERIC;

ALTER TABLE messstelle DROP CONSTRAINT IF EXISTS messstelle_anschlussleistung_chk;
ALTER TABLE messstelle ADD CONSTRAINT messstelle_anschlussleistung_chk
    CHECK (anschlussleistung_kw IS NULL OR anschlussleistung_kw > 0);

COMMENT ON COLUMN messstelle.anschlussleistung_kw IS
    'Optional: Anschlussleistung am Messort in kW; daraus der Hoechstzuwachs je Kadenz eines '
    'Energie-Zaehlerstands (AP-08 IP-7, Z6). NULL = nicht deklariert.';
