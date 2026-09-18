-- AP-12 Folgepaket vp-uems-b12-tagesverlauf-speicher: das Richtungspaar einer
-- Reihe, deren Katalogkanal ZWEI Flussrichtungen in EINER Groesse fuehrt
-- ("Laden / Entladen" am Speicher, "Bezug / Abgabe" am Netzanschluss).
--
-- Warum an der Verdichtung und nicht am Abzug: ein Bericht rechnet nichts neu
-- (bericht.md EW3), er schreibt ab. Die beiden Teile entstehen dort, wo aus den
-- Viertelstunden die Tagesmenge wird (AP-08 IP-3), mit derselben Regel wie der
-- Anteil eines Vorzeichen-Werts: VerbrauchRegeln.ANTEIL_POSITIV /
-- ANTEIL_NEGATIV, je Teil max(0, P) bzw. max(0, -P).
--
-- Die Spalten heissen positiv/negativ, nicht laden/entladen: welches WORT ein
-- Anteil traegt, sagt das Katalogwort der Richtung (charge_discharge ->
-- Laden/Entladen, import_export -> Bezug/Abgabe), nicht die Spalte. Dieselben
-- zwei Spalten tragen darum beide Faelle.
--
-- menge bleibt, was es war: die NETTO-Menge der Periode. menge = positiv -
-- negativ gilt fuer die Intervallmenge, nicht fuer einen Zaehlerstand, und wird
-- darum NICHT als CHECK erzwungen.
--
-- Bestand: keine Nachfuellung, kein Default, kein neuer Fremdschluessel. Beide
-- Spalten sind in jeder bestehenden Zeile NULL -- unbekannt ist keine Null, und
-- der Bestandsschutz-Vergleich der sechs Nachbar-Migrationstests sieht eine
-- ueberall leere Spalte nicht (Bestandsschutz.ZEILE).
ALTER TABLE messreihe_tag     ADD COLUMN IF NOT EXISTS menge_positiv NUMERIC;
ALTER TABLE messreihe_tag     ADD COLUMN IF NOT EXISTS menge_negativ NUMERIC;
ALTER TABLE messreihe_periode ADD COLUMN IF NOT EXISTS menge_positiv NUMERIC;
ALTER TABLE messreihe_periode ADD COLUMN IF NOT EXISTS menge_negativ NUMERIC;

-- Ein Anteil ist ein Betrag; er ist nie negativ (VerbrauchRegeln.anteilDesWerts).
ALTER TABLE messreihe_tag     ADD CONSTRAINT messreihe_tag_richtungspaar_chk
    CHECK (menge_positiv >= 0 AND menge_negativ >= 0);
ALTER TABLE messreihe_periode ADD CONSTRAINT messreihe_periode_richtungspaar_chk
    CHECK (menge_positiv >= 0 AND menge_negativ >= 0);

COMMENT ON COLUMN messreihe_tag.menge_positiv IS
    'Der positive Anteil einer Reihe mit zwei Flussrichtungen in einer Groesse: '
    'Summe max(0, P) ueber die Viertelstunden des Tages. NULL = der Kanal fuehrt '
    'keine zwei Richtungen, oder die Verdichtung lief vor V20260918101000.';
COMMENT ON COLUMN messreihe_tag.menge_negativ IS
    'Der Betrag des negativen Anteils derselben Reihe: Summe max(0, -P). '
    'menge bleibt die Netto-Menge; unbekannt ist keine Null.';
COMMENT ON COLUMN messreihe_periode.menge_positiv IS
    'Wie messreihe_tag.menge_positiv, aus den Tagen der Periode summiert -- nur, '
    'wenn JEDER vorhandene Tag der Periode seinen Anteil traegt (sonst NULL).';
COMMENT ON COLUMN messreihe_periode.menge_negativ IS
    'Wie messreihe_tag.menge_negativ, aus den Tagen der Periode summiert.';
-- Die Tabellenrechte beider Tabellen decken nullbare Zusatzspalten (SELECT fuer
-- ${appDbUser}, SELECT/INSERT/UPDATE/DELETE fuer ${adminDbUser}); RLS und FORCE
-- stehen an der Tabelle, nicht an der Spalte.
