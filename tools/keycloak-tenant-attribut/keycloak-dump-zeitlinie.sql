-- =============================================================================================
-- tenant_id-Diagnose · Zeitlinie aus der Keycloak-Datenbank                    Stand 19.10.2026
-- =============================================================================================
-- REIN LESEND. Gedacht für eine WIEDERHERGESTELLTE KOPIE eines Tages-Dumps der keycloak-db
-- (tools/backup/vp-db-backup.sh: pg_dump -Fc, 7 tägliche + 4 wöchentliche). Je Dump gefahren
-- zeigt K1, an welchem Tag ein Konto sein tenant_id noch hatte; der erste Dump ohne Wert grenzt
-- den Verlust auf einen Tag ein. Läuft auch gegen die laufende keycloak-db (nur SELECT).
--
-- Tabellen und Spalten geprüft an Keycloak 26.0.5 (Postgres-Schema eines frisch importierten
-- Realms, 19.10.2026). Ergebnis enthält Namen und E-Mail-Adressen: bleibt beim Betreiber.
-- Fahren:  psql "<kopie>" -X -q --csv -v ON_ERROR_STOP=1 -f keycloak-dump-zeitlinie.sql -o <dump>.csv
-- =============================================================================================
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

-- K1 · Konten des Realms voltpilot (ohne Dienstkonten) mit tenant_id und direkten Realm-Rollen;
--      zeit = Anlage des Kontos in Keycloak.
SELECT 'K1-konto'                                             AS teil,
       u.username                                             AS name,
       u.email,
       u.id                                                   AS kennung,
       to_timestamp(u.created_timestamp / 1000.0)             AS zeit,
       u.enabled                                              AS aktiv,
       (SELECT string_agg(a.value, ',' ORDER BY a.value) FROM user_attribute a
         WHERE a.user_id = u.id AND a.name = 'tenant_id')     AS tenant_id,
       (SELECT string_agg(kr.name, ' ' ORDER BY kr.name) FROM user_role_mapping m
          JOIN keycloak_role kr ON kr.id = m.role_id AND NOT kr.client_role
         WHERE m.user_id = u.id)                              AS rollen_oder_realm,
       NULL::text                                             AS weiteres
  FROM user_entity u
  JOIN realm r ON r.id = u.realm_id
 WHERE r.name = 'voltpilot' AND u.service_account_client_link IS NULL
UNION ALL
-- K2 · Das User-Profil des Realms (tenant_id deklariert? unmanagedAttributePolicy?).
SELECT 'K2-profil', NULL, NULL, c.id, NULL, NULL, NULL, NULL, cc.value
  FROM component c
  JOIN component_config cc ON cc.component_id = c.id
  JOIN realm r ON r.id = c.realm_id
 WHERE r.name = 'voltpilot' AND c.provider_type = 'org.keycloak.userprofile.UserProfileProvider'
   AND cc.name = 'kc.user.profile.config'
UNION ALL
-- K3 · Admin-Ereignisse zu Profil, Konten und Realm (nur wenn adminEventsEnabled; 90 Tage).
--      name = wer handelte, kennung = betroffene Ressource (users/<kennung>), zeit = wann,
--      rollen_oder_realm = Realm des Handelnden (master = Administration oder kcadm).
--      client: security-admin-console = Administration im Browser, admin-cli = kcadm,
--      voltpilot-api = die API (Servicekonto service-account-voltpilot-api).
SELECT 'K3-ereignis', au.username, NULL, e.resource_path, to_timestamp(e.admin_event_time / 1000.0), NULL,
       NULL, ar.name, e.operation_type || ' ' || e.resource_type || ' client=' || coalesce(cl.client_id, e.auth_client_id, '?')
  FROM admin_event_entity e
  JOIN realm r ON r.id = e.realm_id
  LEFT JOIN realm ar ON ar.id = e.auth_realm_id
  LEFT JOIN client cl ON cl.id = e.auth_client_id
  LEFT JOIN user_entity au ON au.id = e.auth_user_id
 WHERE r.name = 'voltpilot' AND e.resource_type IN ('USER_PROFILE', 'USER', 'REALM', 'COMPONENT')
 ORDER BY 1, 2, 5;

COMMIT;
