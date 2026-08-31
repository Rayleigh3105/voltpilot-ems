-- Verbrauchsmanagement v1 / Paket P8 - die Nennleistung wird OPTIONAL.
--
-- Bis hierher war `consumer_profile.rated_power_kw` NOT NULL CHECK (> 0). Fuer
-- den neuen Typ `heat-pump-sgready` (SG-Ready-Waermepumpe, Konzept
-- vp-verbrauchsmgmt-konzept-v1 §3.1/§3.4, Captain-Entscheid E9) ist das eine
-- Zahl, die niemand ehrlich angeben kann UND die niemand benutzen darf:
-- geschaltet wird ein potentialfreier Freigabe-Kontakt, die Pumpe entscheidet
-- selbst, ob und mit welcher Leistung sie anlaeuft. `Nennleistung x Zeit` waere
-- dort eine erfundene Energie - genau deshalb bekommt der Typ die eigene
-- D3-Stufe `freigabe` und darf ohne Nennleistung angelegt werden.
--
-- ⚠ Die Regel WER sie weglassen darf lebt im Anwendungscode
-- (`ConsumerService` / `SgReady.ratedPowerOptional`), nicht hier: jeder andere
-- Verbrauchertyp verlangt sie unveraendert. Die Spalte bleibt fuer sie
-- inhaltlich Pflicht, das Schema laesst nur noch zu, dass genau der eine Typ
-- sie ehrlich leer laesst.
--
-- Jeder Leser der Spalte ist bereits null-tolerant (`ConsumerPolicyCompiler`,
-- `ConsumerRequirementLedger.actualEnergy`, `ConsumerOverrideService.clampToRated`,
-- `EntityRegistryService.defaultGuards`) - eine fehlende Nennleistung erzeugt
-- damit keine Guard-Grenze und keine angenommene Energie, nie eine 0.
--
-- Bestandsdaten: kein Backfill, keine Aenderung an einer bestehenden Zeile.
-- Ohne eine einzige SG-Ready-Komponente ist die Tabelle byte-identisch.

ALTER TABLE consumer_profile ALTER COLUMN rated_power_kw DROP NOT NULL;

ALTER TABLE consumer_profile DROP CONSTRAINT IF EXISTS consumer_profile_rated_power_kw_check;

ALTER TABLE consumer_profile
    ADD CONSTRAINT consumer_profile_rated_power_kw_check
    CHECK (rated_power_kw IS NULL OR rated_power_kw > 0);
