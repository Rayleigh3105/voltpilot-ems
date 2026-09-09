-- =============================================================================
-- V20260910000000 - WOHER der Anfangs-Ladestand eines Fahrplan-Laufs kam.
-- -----------------------------------------------------------------------------
-- Anlass: Scout-Report data/vp-deye-diybms-luecke-l5 §3.3 / Paket P7,
-- Captain-Entscheid E4=b. Bis hierher startete der Optimierer eine Anlage ohne
-- frische SoC-Messung aus einer ERFUNDENEN Annahme (inputs.DEFAULT_SOC_PCT =
-- 50 %), plante daraus einen vollen Speicher-Fahrplan und wies die geplante
-- Ersparnis dieses Fahrplans aus (plannedSavingsTodayEur, savingsEur). An einer
-- Anlage, die gar keinen echten Ladestand liefern KANN - ein Deye im
-- Spannungsmodus ohne BMS-SoC - war jede dieser Zahlen eine Behauptung ueber
-- einen Speicherstand, den niemand kennt. Das verletzt die Hausregel
-- „`null` statt einer erfundenen `0`; ‚nicht gemessen' ist nie ‚gemessen 0'".
--
-- Seit P7 ist die HERKUNFT des Ladestands ein Fakt des Laufs, aus einem
-- GESCHLOSSENEN Vokabular (ein Wort ausserhalb wird verworfen, nie geraten -
-- der CHECK unten ist genau diese Regel in der Datenbank):
--
--   'gemessen'  - eine echte soc_pct-Telemetrie im Frischefenster
--                 (OPTIMIZER_SOC_MAX_AGE_MINUTES, Vorgabe 120 min). Der
--                 Normalfall; alles wird geplant und ausgewiesen wie vor P7.
--   'berechnet' - ein ABGELEITETER Ladestand. Der generische SoC-Baustein folgt
--                 in einem eigenen Paket; die Spalte nimmt ihn schon auf, damit
--                 er spaeter als Planungseingang dienen KANN, ohne sich als
--                 Messung auszugeben. Heute schreibt ihn niemand.
--   'unbekannt' - KEIN Ladestand. Der Optimierer deaktiviert die Speicher-Terme
--                 (Lade-/Entladegrenzen 0, keine Nacht-Wertfunktion, keine
--                 In-Slot-Vollmachten fuer die Box), der Plan ist RUHE, und der
--                 Lauf weist keine Speicher-Ersparnis aus.
--
-- Ein RUN-Fakt, je Slot-Zeile wiederholt wie terminal_value_eur_per_kwh - EINE
-- Zeile beantwortet ihn fuer den ganzen Lauf. Er ist zugleich der GRUND, den
-- die Fahrplan-Seite aussprechen darf („Ohne Ladestand plant VoltPilot Ihren
-- Speicher nicht"): eine Flaeche, die eine URSACHE behauptet, braucht einen
-- exportierten Fakt, der genau diese Ursache traegt.
--
-- Nullable, und NULL heisst hier ausschliesslich „Lauf vor dieser Migration".
-- Kein Default: ein Vorgabewert wuerde jeder Alt-Zeile eine Herkunft ANDICHTEN,
-- die sie nie hatte - und 'gemessen' waere obendrein falsch fuer genau die
-- Laeufe, die diese Migration adressiert. Jeder Leser behandelt NULL wie
-- 'gemessen' (Vor-P7-Verhalten), nie wie 'unbekannt'.
--
-- ⚠ Die zweite Haelfte der Ehrlichkeit steckt NICHT in dieser Spalte, sondern
-- in schon vorhandenen NULLs: ein Ruhe-Lauf schreibt soc_pct = NULL (es gibt
-- keine geplante Ladestands-Bahn) und baseline_cost_eur = NULL (ohne geplanten
-- Speicher gibt es keine Referenz, gegen die sich eine Ersparnis messen liesse).
-- Jeder Ersparnis-Leser filtert seit je auf „baseline_cost_eur IS NOT NULL"
-- (HistoryRepository.plannedSavings, OverviewRepository, Portal
-- plannedDayCosts), also traegt dieses NULL die Aussage bis in jede Flaeche,
-- ohne dass eine einzige Summenformel angefasst werden muss.
--
-- Der V20260701020000-SELECT-Grant auf schedule ist spaltenunabhaengig.
-- Bootstrap-Spiegel: infra/local/timescale/04-schedule.sql (in sync gehalten).
-- Der eingefrorene MQTT-Fahrplan-Kontrakt ist UNBERUEHRT: die Box bekommt einen
-- Ruhe-Plan als das, was er ist - lauter battery_setpoint_kw = 0 -, und der
-- Herkunfts-Fakt haengt am Plan, nicht am Vertrag.
-- =============================================================================

ALTER TABLE schedule ADD COLUMN IF NOT EXISTS soc_source TEXT;

ALTER TABLE schedule DROP CONSTRAINT IF EXISTS schedule_soc_source_check;
ALTER TABLE schedule ADD CONSTRAINT schedule_soc_source_check
    CHECK (soc_source IS NULL
           OR soc_source IN ('gemessen', 'berechnet', 'unbekannt'));
