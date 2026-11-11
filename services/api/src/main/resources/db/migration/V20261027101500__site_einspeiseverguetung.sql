-- =============================================================================
-- V20261027101500 - site.einspeiseverguetung_ct_kwh: der vom Kunden ANGEGEBENE
--                   feste Einspeiseverguetungssatz (Karte "Einspeiseverguetung"
--                   unter Einstellungen > Strom & Geld) und
--                   site.inbetriebnahme_ab_solarspitzengesetz, ADDITIV.
-- -----------------------------------------------------------------------------
-- Eine Eigenverbrauchs-Anlage (plant_kind = 'eigenverbrauch') wurde bisher
-- AUSSCHLIESSLICH mit dem aus dem EEG hergeleiteten Satz bewertet: der Satzplan
-- EegRates.java <-> config.py DEFAULT_EEG_RATE_SCHEDULE nach Inbetriebnahme und
-- kWp des primaeren PV-Assets (MaStR). Sonderfaelle - Altanlage vor dem ersten
-- Band, Volleinspeisung, Sondervertrag, ausgefoerderte Anlage mit
-- Anschlussvertrag - konnte der Kunde nicht angeben.
--
-- Die Spalte ist eine EBENE UEBER dem Satzplan, kein Eingriff in ihn:
--   NULL   = keine Angabe: die Herleitung gilt unveraendert (jede
--            Bestandsanlage, byte-identische Zahlen in Optimierer und Erloesen);
--   ct/kWh = der Satz, den der Kunde je eingespeister kWh bekommt. Er ersetzt
--            den hergeleiteten Satz UND das Ende nach 20 Jahren (die Angabe
--            ist die heutige Aussage des Kunden); Paragraph 51a EEG (keine
--            Verguetung bei negativem Boersenpreis fuer Anlagen ab 25.02.2025)
--            haengt weiter am Inbetriebnahmedatum.
-- Er wirkt genau dort, wo heute die Herleitung wirkt: Eigenverbrauch OHNE
-- Netzladen (Ausschliesslichkeitsprinzip). Direktvermarktung bleibt Boerse +
-- Marktpraemie, Netzladen bleibt Boersenpreis. Regel und gemeinsame Vektoren:
-- docs/contracts/einspeiseverguetung-vectors.json (pricing.py <->
-- SlotEconomics.exportValueCtKwh <-> SlotEconomics.exportValueCtSql).
--
-- Geschrieben NUR ueber PUT /api/v1/sites/{id}/einspeiseverguetung, nie ueber
-- den Voll-PUT der Anlage. 0 ist eine Angabe ("ich bekomme nichts"), keine
-- fehlende - fehlend ist NULL. Die Plausibilitaetsgrenze (100 ct/kWh) prueft
-- die Route; hier steht nur die Invariante: eine Verguetung ist nie negativ.
--
-- site.inbetriebnahme_ab_solarspitzengesetz traegt die Lage "Paragraph 51a ja
-- oder nein" fuer eine Angabe OHNE Inbetriebnahmedatum am PV-Asset (keine
-- MaStR-Verknuepfung): die Antwort des Kunden auf "Ging Ihre Anlage vor oder
-- ab dem 25.02.2025 in Betrieb?". TRUE = ab dem Stichtag (bei negativem
-- Boersenpreis 0), FALSE = davor, NULL = nicht angegeben. Die Route verlangt
-- sie zu jeder Angabe ohne Datum - sonst rechnete der Plan den eigenen Satz
-- still auch in Negativpreis-Viertelstunden. Ein Inbetriebnahmedatum am
-- PV-Asset geht IMMER vor (auch wenn es spaeter dazukommt); Zuruecksetzen
-- loescht beide Spalten.
--
-- Reines additives ALTER; die bestehende site-RLS-Policy + Grants (V2) decken
-- die neuen Spalten ab. Die Version liegt ueber dem hoechsten ausgelieferten
-- Stand (V20261026200000).
-- =============================================================================

ALTER TABLE site ADD COLUMN IF NOT EXISTS einspeiseverguetung_ct_kwh NUMERIC(8, 3);
ALTER TABLE site ADD COLUMN IF NOT EXISTS inbetriebnahme_ab_solarspitzengesetz BOOLEAN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'site_einspeiseverguetung_ct_kwh_check'
    ) THEN
        ALTER TABLE site ADD CONSTRAINT site_einspeiseverguetung_ct_kwh_check
            CHECK (einspeiseverguetung_ct_kwh IS NULL OR einspeiseverguetung_ct_kwh >= 0);
    END IF;
END
$$;
