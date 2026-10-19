-- =============================================================================================
-- tenant_id-Diagnose · DB-Wahrheit "Konto -> Kundenbereich"                    Stand 19.10.2026
-- =============================================================================================
-- REIN LESEND, Muster tools/betriebsabfragen (READ ONLY, row_security off, Zeitgrenzen).
-- Rolle mit BYPASSRLS (oder Superuser): benutzer, zugriff, zugriff_bestand und tenant tragen
-- FORCE ROW LEVEL SECURITY; ohne BYPASSRLS ist das Ergebnis scheinbar leer.
--
-- Die Wahrheit, welches Keycloak-Konto zu welchem Kundenbereich gehört, steht seit UEMS AP-03
-- (Rollout 10.10.2026) in `benutzer` (V20260915030000__uems_zugriff.sql): Schlüssel
-- (tenant_id, sub), `sub` = Keycloak-Kennung des Kontos, `konto` = benutzer | partner | plattform.
-- Geschrieben hat sie der Bestandslauf (ZugriffBestandLaeufer) bei jedem api-Start für jedes
-- Keycloak-Konto MIT tenant_id und die Kontoanlage (KundenbenutzerAngelegt, BenutzerService).
-- Ein Konto, das beim ersten Start nach dem Rollout schon kein tenant_id hatte, steht hier NICHT.
-- `zugriff_bestand` (V20260916060000) hält je Kundenbereich den Stichtag der Übernahme und wie
-- viele Konten Keycloak damals lieferte (`konten`).
--
-- Ausgabe: EINE CSV-Tabelle, Spalte `art` = konto | kundenbereich.
-- Fahren (Ergebnis enthält E-Mail-Adressen: bleibt beim Betreiber):
--   psql "$VP_DB_URL" -X -q --csv -v ON_ERROR_STOP=1 -f db-wahrheit.sql -o db.csv
-- =============================================================================================
BEGIN TRANSACTION READ ONLY;
SET LOCAL row_security = off;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';

SELECT 'konto'                                   AS art,
       b.tenant_id,
       t.name                                    AS kundenbereich,
       t.segment,
       t.created_at                              AS kundenbereich_seit,
       t.beendet_am                              AS kundenbereich_beendet,
       b.sub,
       b.konto,
       b.email,
       b.anzeigename,
       b.zustand,
       b.created_at                              AS spiegel_seit,
       (SELECT count(*) FROM zugriff z
         WHERE z.tenant_id = b.tenant_id AND z.benutzer_sub = b.sub
           AND public.zugriff_zeitraum(z.gueltig_ab, z.endet_am, z.beendet_am) @> now()) AS zuweisungen_wirksam,
       (SELECT count(*) FROM zugriff z
         WHERE z.tenant_id = b.tenant_id AND z.benutzer_sub = b.sub)                     AS zuweisungen_je,
       (SELECT string_agg(DISTINCT z.rolle, ' ' ORDER BY z.rolle) FROM zugriff z
         WHERE z.tenant_id = b.tenant_id AND z.benutzer_sub = b.sub
           AND public.zugriff_zeitraum(z.gueltig_ab, z.endet_am, z.beendet_am) @> now()) AS rollen_wirksam,
       zb.stichtag,
       zb.herkunft                               AS stichtag_herkunft,
       zb.konten                                 AS stichtag_konten
  FROM benutzer b
  JOIN tenant t ON t.id = b.tenant_id
  LEFT JOIN zugriff_bestand zb ON zb.tenant_id = b.tenant_id
UNION ALL
SELECT 'kundenbereich', t.id, t.name, t.segment, t.created_at, t.beendet_am,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       zb.stichtag, zb.herkunft, zb.konten
  FROM tenant t
  LEFT JOIN zugriff_bestand zb ON zb.tenant_id = t.id
 ORDER BY 1, 3, 9;

COMMIT;
