-- =============================================================================
-- V20261112032000 - MiSpeL: Löschzug-Indexdeckung für die MiSpeL-Tabellen
-- -----------------------------------------------------------------------------
-- main verlangt seit V20261112150000 (Befund vp-kunde-loeschen-504, Prod
-- 12.11.2026) für jede Katalog-Tabelle mit tenant_id einen vollständigen Index,
-- der mit tenant_id beginnt, und für jeden Fremdschlüssel auf eine Elterntabelle,
-- die im Löschzug Zeilen verliert, einen Index auf der Kindseite. Wächter:
-- LoeschzugIndexdeckungTest. Die MiSpeL-Migrationen V20261112030100-031900 sind
-- älter als diese Regel; ihr SQL bleibt unverändert (Neu-Nummerierung als reine
-- Umbenennung), die fehlenden Indizes stehen hier.
--
-- Alle sieben Tabellen sind gewöhnliche Tabellen (keine Hypertable) und beginnen
-- in Produktion leer: ein CREATE INDEX je Tabelle, transaktional.
-- =============================================================================

-- Fahrer-Einstellungen und Planungsangaben am Ladepunkt (MP-31, MP-41a,
-- V20261112030700 und V20261112031500).
CREATE INDEX IF NOT EXISTS idx_ladepunkt_abfahrt_tenant ON ladepunkt_abfahrt (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ladepunkt_anwesenheit_tenant ON ladepunkt_anwesenheit (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ladepunkt_fahrer_einstellung_tenant ON ladepunkt_fahrer_einstellung (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ladepunkt_fahrzeugfenster_tenant ON ladepunkt_fahrzeugfenster (tenant_id);

-- Messlatte „nur laden" (MP-33e, V20261112031800) und signierte Messwerte
-- (MP-38, V20261112031400): ihre Indizes beginnen mit site_id.
CREATE INDEX IF NOT EXISTS idx_ladepunkt_messlatte_tenant ON ladepunkt_messlatte (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ladepunkt_signierter_messwert_tenant ON ladepunkt_signierter_messwert (tenant_id);

-- Die Vormerkung der Pauschaloption verweist auf die Förderweg-Fassung, in der
-- sie umgesetzt wurde (MP-27b, V20261112031700); site_foerderweg verliert im
-- Löschzug Zeilen, die RI-Prüfung braucht den Index auf der Kindseite.
CREATE INDEX IF NOT EXISTS idx_site_pauschal_vormerkung_umgesetzt_in ON site_pauschal_vormerkung (umgesetzt_in);
