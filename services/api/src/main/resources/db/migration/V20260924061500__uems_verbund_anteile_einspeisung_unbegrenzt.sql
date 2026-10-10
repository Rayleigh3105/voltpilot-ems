-- AP-15 Folge „Anlage ohne Einspeisegrenze in der Gemeinsamen Steuerung“ (Captain 23.09.2026:
-- „Einspeisung unbegrenzt - nur der Bezug wird aufgeteilt“). Trägt das Grenzblatt ausdrücklich
-- „keine Einspeisegrenze“ (V20260922200000), hat das Anteils-Dokument keine Einspeiseseite:
-- kein Anteil, kein Wächter. Die Zeile speichert das als NULL in `verteilbar_einspeisung_kw`
-- UND ohne Schlüssel `einspeisung` in `anteile` - nie als 0 (0 hieße „nichts verteilbar“).
--
-- Nur gelockert: keine Bestandszeile ändert sich, jede hat beide Seiten und erfüllt den neuen
-- CHECK. Der bestehende CHECK `verteilbar_chk` (>= 0) lässt NULL schon durch.
ALTER TABLE steuerungsverbund_anteile ALTER COLUMN verteilbar_einspeisung_kw DROP NOT NULL;

-- Beide Merkmale gehören zusammen: ohne verteilbare Einspeisung auch keine Einspeise-Tabelle,
-- und umgekehrt (sonst läse der Planer eine unbegrenzte Seite als unbekannt oder umgekehrt).
ALTER TABLE steuerungsverbund_anteile DROP CONSTRAINT IF EXISTS steuerungsverbund_anteile_einspeisung_unbegrenzt_chk;
ALTER TABLE steuerungsverbund_anteile ADD CONSTRAINT steuerungsverbund_anteile_einspeisung_unbegrenzt_chk
    CHECK ((verteilbar_einspeisung_kw IS NULL) = ((anteile -> 'einspeisung') IS NULL));
