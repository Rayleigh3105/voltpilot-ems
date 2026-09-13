-- =============================================================================
-- UEMS AP-08 IP-14 — das System schlägt vor, freigegeben wird von Hand
-- =============================================================================
--
-- Entscheid E14 = A (11.09.2026): „Nie automatisch: der Vorschlag wird angelegt
-- (Begründung vorbelegt, Vorschau alt/neu), erscheint in der Korrektur-Liste des
-- Standorts und im Verlauf als Marker; erst die Freigabe (E8) erzeugt Version 2 —
-- auch wenn nur Lücken gefüllt werden.“
--
-- Der Stundenlauf (`KorrekturVorschlagLauf`) fährt mit der BYPASSRLS-Rolle. Sie
-- durfte `messreihe_korrektur` bisher nur lesen und löschen (Offboarding,
-- V20260913190000 §7 kündigte dieses Recht an). Diese Migration gibt ihr genau
-- das, was ein VORSCHLAG braucht — und die Datenbank sorgt dafür, dass es nie
-- mehr wird:
--
--   1. INSERT nur auf die Spalten der ANLEGENDEN Fassung, ohne `grund`, `beleg`
--      und `ersatzwert_kennung` (ein System-Vorschlag belegt nichts und macht
--      keinen Ersatzwert wirksam).
--   2. Der Trigger `messreihe_korrektur_system_nur_vorschlag`: schreibt die
--      BYPASSRLS-Rolle, dann NUR Fassung 1 — und Fassung 1 ist per
--      `messreihe_korrektur_anfang_chk` immer `vorschlag`. Eine Freigabe, eine
--      Ablehnung oder eine Rücknahme über diesen Weg scheitert, auch wenn eine
--      spätere Migration die Spaltenrechte weitet. „Nie automatisch“ steht damit
--      nicht nur im Code.
--
-- Die Doppelvorschlag-Sperre ist KEIN Index: der Status einer Korrektur steht in
-- ihren späteren Fassungen, ein Unique-Index kann „noch nicht entschieden“ nicht
-- sehen. Sie liegt im Schreibweg unter einer Sperre je Kundenbereich + Art +
-- Reihe (`KorrekturVorschlagRegeln.sperre`).
--
-- NICHT HIER: keine Tabelle, keine Spalte, keine Bestandszeile; keine Freigabe-
-- Route und keine Vier-Augen-Prüfung (IP-15), keine Route (IP-16), keine
-- Kaskade (IP-17). `messreihe_korrektur_vorschlag` (AP-07) bleibt unberührt —
-- der Lauf setzt dort nur `zustand`, wofür die Rolle das Recht seit
-- V20260912190000 hat.

GRANT INSERT (tenant_id, kennung, fassung, status, art, reihen, von, bis, begruendung, vorschau,
              actor_sub, actor_name, actor_rolle, actor_art)
    ON messreihe_korrektur TO ${adminDbUser};

CREATE OR REPLACE FUNCTION messreihe_korrektur_system_nur_vorschlag() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = '${adminDbUser}'
     AND NOT (NEW.fassung = 1
              AND coalesce(public.messreihe_korrektur_merkmal('korrektur_status', NEW.status, 'anfang') = 'true',
                           false)) THEN
    RAISE EXCEPTION 'Korrektur %: das System schlägt nur vor (Fassung %, %) — freigegeben wird von Hand',
          NEW.kennung, NEW.fassung, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'messreihe_korrektur_system_nur_vorschlag';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messreihe_korrektur_system_nur_vorschlag ON messreihe_korrektur;
CREATE TRIGGER messreihe_korrektur_system_nur_vorschlag BEFORE INSERT ON messreihe_korrektur
    FOR EACH ROW EXECUTE FUNCTION messreihe_korrektur_system_nur_vorschlag();

COMMENT ON FUNCTION messreihe_korrektur_system_nur_vorschlag() IS
    'UEMS AP-08 IP-14, E14: die BYPASSRLS-Rolle schreibt in messreihe_korrektur nur Fassung 1 '
    '(= vorschlag). Freigabe, Ablehnung und Ruecknahme sind Menschen vorbehalten - nie automatisch, '
    'auch nicht, wenn nur Luecken gefuellt werden.';
