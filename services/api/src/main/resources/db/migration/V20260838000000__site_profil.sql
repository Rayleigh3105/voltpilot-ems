-- =============================================================================
-- V20260838000000 - site.profil (Anwendungs-Programm Stufe 2), ADDITIVE.
-- -----------------------------------------------------------------------------
-- Das PROFIL einer Anlage (privat | gewerbe) ist das PRESET des Zielbilds
-- "Portal fuer viele Kunden, viele Anwendungen" (Scout
-- vp-portal-zielbild-anwendungen §3.2 D, Captain-Entscheid E3 vom 24.08.2026):
--
--   "Ja: site.profil (privat|gewerbe, nullable) als Preset + Tonalitaet +
--    Reset-Basis, NIE ein Signal der Ableitung; Bestand NULL = unveraendert."
--
-- Es hat damit GENAU DREI Wirkungen, und keine davon ist eine Verzweigung in
-- der Datenwahrheit:
--   (1) Vorauswahl im Anwendungs-Regal (welche Anwendungen der Assistent
--       vorschlaegt; die Liste steht im Katalog als 'preset' JE ANWENDUNG,
--       nicht hier),
--   (2) Tonalitaet der Geld-Sprache ('privat' spart, 'gewerbe' verdient) -
--       vorher hing sie an plant_kind, also an der VERAEUSSERUNGSFORM statt an
--       der Zielgruppe, weshalb ein Gewerbebetrieb im Eigenverbrauch "gespart"
--       las wie ein Privathaushalt,
--   (3) die Basis fuer "auf Standard zuruecksetzen" (Layout, Stufe 3).
--
-- WAS ES AUSDRUECKLICH NICHT IST: ein Signal fuer die Aktivierungs-Ableitung
-- (AnwendungDerivation / anwendungen.ts derivedAnwendungen). Was auf einer
-- Anlage laeuft, bleibt Anwendungen x Faehigkeiten. Ein Profil, das eine
-- Anwendung aktivierte, waere genau die harte Verzweigung, die M0 abgeschafft
-- hat.
--
-- ZWEITE ACHSE, nicht dieselbe: tenant.betriebsart (endkunde|betreiber,
-- V20260720000000) ist die SCHALE je Kunde/Organisation, dieses Profil haengt
-- an der ANLAGE - eine Organisation kann eine Privat- und eine Gewerbe-Anlage
-- besitzen.
--
-- NULL = kein Profil gewaehlt ("Spaeter entscheiden") und der Zustand JEDER
-- Bestandsanlage: die Tonalitaet faellt dann byte-identisch auf die bisherige
-- plant_kind-Regel zurueck, das Regal zeigt keine Vorauswahl. Deshalb NULLABLE
-- OHNE DEFAULT - ein Default waere eine Behauptung ueber jede bestehende
-- Anlage.
--
-- Reines additives ALTER; die bestehende site-RLS-Policy + Grants (V2) decken
-- die neue Spalte ab. Die Version liegt ueber dem hoechsten ausgelieferten
-- Stand (V20260837000000) - eine Migration unterhalb des Stands einer
-- langlebigen DB ist fuer Flyway "out of order" und wird nie angewandt.
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS profil TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_profil_check') THEN
        ALTER TABLE site ADD CONSTRAINT site_profil_check
            CHECK (profil IS NULL OR profil IN ('privat', 'gewerbe'));
    END IF;
END
$$;

COMMENT ON COLUMN site.profil IS
    'Anwendungs-Preset der Anlage (privat|gewerbe, NULL = keines gewaehlt): '
    'Vorauswahl im Regal + Tonalitaet der Geld-Sprache + Reset-Basis. NIE ein '
    'Signal der Aktivierungs-Ableitung.';
