-- =============================================================================
-- V20260831010000 - Sicherheits-Härtung `forecast`: kein App-DELETE mehr.
-- -----------------------------------------------------------------------------
-- Befund (Scout vp-scale-readiness-p4 §4.2, Captain-Freigabe 31.08.2026):
-- `forecast` ist die EINZIGE Kundendaten-Tabelle mit `tenant_id`, aber ohne
-- RLS - und sie kann RLS nicht mehr bekommen: seit V20260809000000 ist sie
-- komprimiert, und RLS und Kompression schließen sich in jeder verfügbaren
-- TimescaleDB-Version aus ("ROW LEVEL SECURITY is not supported on compressed
-- chunks", geprüft bis 2.29.2). Der Mandanten-Zaun ist dort also
-- Code-Disziplin (site-Join bzw. RLS-aufgelöste site_id) statt DB-Zwang.
-- Die App-Rolle trug trotzdem DELETE (V20260702030000:39 für die
-- Bootstrap-Volumes; auf frischen DBs zusätzlich über V2s ALTER DEFAULT
-- PRIVILEGES) - EIN künftiger Query-Pfad ohne site-Zaun hätte fremde
-- Prognosen löschen können.
--
-- 1. Der einzige App-Rollen-Löschpfad ist die Site-Löschkaskade
--    (SeriesRepository.deleteForSite; TenantRepository.offboard löscht über
--    die Admin-Rolle und ist unberührt). Sie wandert auf eine
--    tenant-gebundene SECURITY-DEFINER-Funktion - wörtlich das
--    purge_ocpp_action_scope-Muster aus V20260846010000, das DIESELBE
--    Kaskade für die OCPP-Lifecycle-Tabellen benutzt: gelöscht wird
--    ausschließlich im Mandanten aus current_setting('app.tenant_id'), ohne
--    Mandanten-Kontext wird geworfen. Damit ist der Zaun für den Löschpfad
--    erstmals IN der Datenbank erzwungen (der Punkt dieser Härtung), und die
--    Kaskade bleibt in EINER Transaktion auf dem @Primary-Datenpfad - bewusst
--    NICHT der Admin-Datenpfad: der committete unabhängig von der laufenden
--    Lösch-Transaktion, und die zwei Datenpfade dürfen sich nie gegenseitig
--    belauern (die dokumentierte Selbst-Blockade-Falle der
--    Steuerungs-Freigabe).
-- 2. Danach das eigentliche REVOKE. Es entfernt den ACL-Eintrag unabhängig
--    davon, ob er aus dem direkten GRANT oder den Default-Privileges stammt,
--    und ist auf einem Stand ohne das Recht ein No-op (idempotent wie die
--    Grant-Migrationen, deren Muster hier gilt).
--
-- Bewusst NICHT angefasst: SELECT bleibt (EarningsRepository liest die
-- Forward-Prognosen über einen site-Join, SeriesRepository zählt die
-- Lösch-Vorschau über eine RLS-aufgelöste site_id). INSERT/UPDATE, die die
-- App-Rolle auf FRISCHEN DBs über V2s Default-Privileges trägt, sind ein
-- dokumentierter Folge-Kandidat: kein App-Pfad schreibt forecast (die
-- Python-Dienste schreiben mit Backend-Credentials), aber ihr Entzug ist
-- nicht Teil der freigegebenen Härtung.
--
-- Version bewusst unter dem High-Water-Mark einer langlebigen DB
-- (Slot-Vergabe der parallelen Tasks; spring.flyway.out-of-order: true):
-- die Migration steht gegen den Schema-Stand IHRER Version - `forecast`
-- existiert seit V20260701040000, der Grant seit V20260702030000 - und hat
-- keine Abhängigkeit nach oben.
-- =============================================================================

-- Der DB-erzwungene Zaun für den einzigen legitimen App-Löschfall: die
-- Site-Löschkaskade. RLS kann diese Tabelle nicht tragen (Kompression),
-- also erzwingt die Funktion die Mandanten-Grenze selbst.
CREATE OR REPLACE FUNCTION purge_forecast_for_site(p_site UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tenant_scope UUID := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  removed BIGINT;
BEGIN
  IF tenant_scope IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;
  IF p_site IS NULL THEN
    RAISE EXCEPTION 'a site scope is required' USING ERRCODE = '22023';
  END IF;

  -- Beide Prädikate zusammen SIND der Zaun: eine fremde site_id trifft im
  -- eigenen Mandanten schlicht keine Zeile - gelöscht wird dann NICHTS.
  DELETE FROM public.forecast
    WHERE site_id = p_site AND tenant_id = tenant_scope;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION purge_forecast_for_site(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_forecast_for_site(UUID) TO ${appDbUser};

-- Die eigentliche Härtung: die App-Rolle kann forecast nicht mehr direkt
-- löschen - weder über den V20260702030000-Grant noch über die
-- Default-Privileges eines frischen Volumes.
REVOKE DELETE ON forecast FROM ${appDbUser};
