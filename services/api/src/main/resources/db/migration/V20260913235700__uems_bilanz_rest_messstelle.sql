-- =============================================================================
-- UEMS AP-10 IP-9 — die Rest-Messstelle: Formel-Typ `rest` mit ihrem Hauptzähler
-- =============================================================================
-- Konzept vp-uems-ap10-bilanzen §8 IP-9; Captain-Entscheide E3 = A (die Terme
-- des Rests kommen JE TAG aus der elektrischen Stellung und werden NIE
-- gespeichert) und E18 = A (eine Rest-Messstelle entsteht nur als bestätigter
-- Vorschlag „Rest anlegen“ je Hauptzähler — Kennzeichen automatisch, Name
-- vorbelegt, Urheber protokolliert). Vertrag docs/contracts/v2/bilanz.md,
-- messstelle-formel.md §6.2.
--
-- Was entsteht:
--
--   1. Der CHECK `messstelle_formel_fassung_typ_chk` kennt `rest` — geweitet,
--      indem der AKTUELLE Stand (V20260912210000) abgeschrieben wird. `saldo`
--      bleibt draußen, bis sein Schreibweg kommt (AP-10 IP-16).
--   2. `messstelle_formel_fassung.rest_hauptzaehler_id` — der EINZIGE Parameter
--      eines Rests: WESSEN Bilanz er ist. Er ist kein Term: welche Messstellen an
--      einem Tag zufließen, abfließen oder zugeordnet sind, leitet
--      BilanzAbleitung.restAusStellung aus messstelle_stellung ab. Zieht ein
--      Unterzähler um, ändert sich der Rest, ohne dass hier etwas nachgepflegt
--      wird. NULL in jeder Bestandszeile (Bestandsschutz: keine Abweichung).
--   3. `(formel_typ = 'rest') = (rest_hauptzaehler_id IS NOT NULL)` — ein Rest
--      ohne Hauptzähler ist keiner, eine gewichtete Summe trägt keinen.
--   4. NIE ZWEIMAL: ein eindeutiger Teil-Index je Mandant und Hauptzähler über die
--      nicht aufgehobenen Rest-Fassungen. Zwei Menschen, die gleichzeitig
--      „Rest anlegen“ klicken, bekommen EINE Messstelle — der Schreibweg nimmt
--      zusätzlich eine Transaktions-Sperre je Hauptzähler, der Index ist die
--      Wand dahinter (auch gegen jeden späteren Schreiber).
--   5. Ein Rest speichert KEINE Terme — auch nicht über den Rückweg
--      „Term ohne fassung_id landet in der einzigen Fassung“ (V20260912210000).
--      Ein Constraint-Trigger prüft den Term am Ende der Anweisung gegen den Typ
--      seiner Fassung.
--
-- WAS DIE DATENBANK NICHT PRÜFT (Schreibweg BilanzService): dass der Hauptzähler
-- an dem Tag Hauptzähler Bezug der Anlage ist (das ist eine Aussage über die
-- Stellung eines TAGES, BilanzAbleitung.restAusStellung) und dass er gemessen
-- ist. Der Fremdschlüssel hält nur „es gibt ihn, im selben Mandanten“.
--
-- Rechte: die Spalte erbt SELECT/INSERT der Tabelle; UPDATE bleibt auf
-- (gueltig_bis, aufgehoben_am) beschränkt — der Hauptzähler eines Rests ändert
-- sich nie. RLS/FORCE der Tabelle gelten unverändert. Offboarding: die Fassungen
-- räumt TenantRepository.offboard schon VOR den Messstellen ab.
-- =============================================================================

ALTER TABLE messstelle_formel_fassung DROP CONSTRAINT IF EXISTS messstelle_formel_fassung_typ_chk;
ALTER TABLE messstelle_formel_fassung ADD CONSTRAINT messstelle_formel_fassung_typ_chk
    CHECK (formel_typ IN ('gewichtete_summe', 'rest'));

ALTER TABLE messstelle_formel_fassung ADD COLUMN IF NOT EXISTS rest_hauptzaehler_id UUID;

-- Der Mandant reist im Verweis mit (ein Fremdschlüssel prüft ohne RLS).
ALTER TABLE messstelle_formel_fassung DROP CONSTRAINT IF EXISTS messstelle_formel_fassung_rest_hauptzaehler_fk;
ALTER TABLE messstelle_formel_fassung ADD CONSTRAINT messstelle_formel_fassung_rest_hauptzaehler_fk
    FOREIGN KEY (rest_hauptzaehler_id, tenant_id) REFERENCES messstelle (id, tenant_id) ON DELETE RESTRICT;

-- ⚠ coalesce(…, false): ein CHECK nimmt NULL an.
ALTER TABLE messstelle_formel_fassung DROP CONSTRAINT IF EXISTS messstelle_formel_fassung_rest_hauptzaehler_chk;
ALTER TABLE messstelle_formel_fassung ADD CONSTRAINT messstelle_formel_fassung_rest_hauptzaehler_chk
    CHECK (coalesce((formel_typ = 'rest') = (rest_hauptzaehler_id IS NOT NULL), false));

ALTER TABLE messstelle_formel_fassung DROP CONSTRAINT IF EXISTS messstelle_formel_fassung_rest_nicht_selbst;
ALTER TABLE messstelle_formel_fassung ADD CONSTRAINT messstelle_formel_fassung_rest_nicht_selbst
    CHECK (rest_hauptzaehler_id IS NULL OR rest_hauptzaehler_id <> messstelle_id);

CREATE UNIQUE INDEX IF NOT EXISTS messstelle_formel_fassung_ein_rest_je_hauptzaehler
    ON messstelle_formel_fassung (tenant_id, rest_hauptzaehler_id)
    WHERE rest_hauptzaehler_id IS NOT NULL AND aufgehoben_am IS NULL;

-- -----------------------------------------------------------------------------
-- Ein Rest speichert keine Terme (E3).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION messstelle_formel_term_nicht_rest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM messstelle_formel_fassung f
                WHERE f.id = NEW.fassung_id AND f.formel_typ = 'rest') THEN
        RAISE EXCEPTION 'Ein Rest speichert keine Terme: sie kommen je Tag aus der elektrischen Stellung (AP-10 E3).'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'messstelle_formel_term_nicht_rest';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS messstelle_formel_term_nicht_rest ON messstelle_formel_term;
CREATE CONSTRAINT TRIGGER messstelle_formel_term_nicht_rest AFTER INSERT ON messstelle_formel_term
    FOR EACH ROW EXECUTE FUNCTION messstelle_formel_term_nicht_rest();
