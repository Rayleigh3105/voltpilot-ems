-- =============================================================================
-- V20260835000000 - Katalog-Neustruktur: Geraetetyp + Abloesung an der Vorlage.
-- ADDITIV: zwei nullbare Spalten, kein Default, kein Backfill. Ohne sie
-- verhaelt sich jeder bestehende Pfad byte-gleich.
-- -----------------------------------------------------------------------------
-- WOFUER (Konzept data/vp-anlegen-rework/konzept.md, Stufe 1):
--
-- Der Geraete-Katalog auf der Box hat seit der Neustrukturierung eine
-- GERAETETYP-Dimension (Wechselrichter · Wallbox · schaltbarer Verbraucher ·
-- Zaehler · Ladesaeule · Eigenbau). Sie ersetzt die frueheren Klammer-Zusaetze
-- im MARKENNAMEN („go-e (Wallbox)", „Shelly (Relais/Schaltaktor)") - eine
-- Kategorie war dort als Fabrikat getarnt. Der cloud-seitige Spiegel bekommt
-- sie hier, damit der Anlege-Assistent (Stufe 2) mit „Was moechten Sie
-- anbinden?" beginnen kann.
--
-- ⚠ DIE ZWEITE SPALTE IST DIE ALIAS-EBENE DER HARTEN KOMPATIBILITAETS-REGEL.
-- Die Neuordnung ist eine PRAESENTATIONS-Aenderung: eine abgeloeste Marken-/
-- Modell-Kennung muss AUFLOESBAR bleiben (eine Bestandsanlage referenziert sie
-- als `template_ref`, und die Bestands-Uebernahme sucht ueber Marke+Modell),
-- darf aber nicht mehr ANGEBOTEN werden. `superseded_by` nennt deshalb die
-- Vorlage, die diese abgeloest hat:
--
--   NULL              die Vorlage gilt und wird angeboten (der Normalfall)
--   <template_ref>    abgeloest - weiterhin nachschlagbar, nicht mehr waehlbar
--
-- Der konkrete Anlass ist der zweite Fronius-Eintrag: die Marke
-- `fronius_sunspec` war eine eigene „Marke", weil der VERBINDUNGSWEG in den
-- Markennamen geleckt war. Sie ist jetzt eine versteckte Alias-Marke; die zwei
-- Fronius Eco der Anlage Herzogau behalten dadurch Kennung, Vorlage und
-- Verhalten unveraendert.
--
-- ⚠ NULL heisst bei BEIDEN Spalten „diese Vorlage sagt dazu nichts", nie ein
-- Wert. Deshalb nullbar und OHNE Default - eine geprueft/selbst gebaute Vorlage
-- (Stufe 6/3), die entstand, bevor es die Typ-Dimension gab, behauptet keinen
-- Typ, statt in einen geraten zu werden.
--
-- Gefuellt werden sie beim Start aus der eingecheckten
-- `componenttemplates/builtin.json` (der Seeder-Abgleich) - hier steht bewusst
-- KEIN Seed: eine angewandte Migration ist unaenderbar, ein eingefrorener
-- 50-Zeilen-Seed waere ab dem naechsten Katalog-Edit falsch.
--
-- Datums-Version oberhalb des hoechsten ausgelieferten Standes
-- (V20260834000000) - eine kleinere Version waere fuer Flyway „out of order"
-- und wuerde auf einer langlebigen DB nie angewandt.
-- =============================================================================

ALTER TABLE component_template
    ADD COLUMN IF NOT EXISTS device_type   TEXT,
    ADD COLUMN IF NOT EXISTS superseded_by TEXT;

COMMENT ON COLUMN component_template.device_type IS
    'Geraetetyp-Dimension des Katalogs (inverter|wallbox|switch|meter|charge_point|custom). '
    'NULL = die Vorlage sagt es nicht - nie ein geratener Typ.';

COMMENT ON COLUMN component_template.superseded_by IS
    'template_ref der Vorlage, die DIESE abgeloest hat. NULL = die Vorlage gilt. '
    'Eine abgeloeste Vorlage bleibt AUFLOESBAR (Bestandsanlagen, Bestands-Uebernahme), '
    'wird aber nicht mehr angeboten.';
