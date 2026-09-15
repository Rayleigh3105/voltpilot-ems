# UEMS-Keycloak: Rolle „partner“, Kundenkonto ohne Realm-Rolle, Kontoart aus dem Token (AP-03 IP-3)

Neu angelegt am 15.09.2026. Spezifikation: AP-03 §6.1 und §8 IP-3. Code:
`config/KeycloakRealmRoleConverter` (Kontoart), `tenant/TenantFilter` (Partner ohne Kundenbereich),
`admin/KeycloakAdminClient` (`createCustomerUser` ohne Rolle, neu `createPartnerUser`), `ocpp/OcppActionPolicy`
und die drei OCPP-Controller `SiteOcpp*Controller` (Gleichstand). Realm: `infra/local/keycloak/voltpilot-realm.json`, dieselbe Rolle in
`infra/prod/keycloak/voltpilot-realm.json`, Betriebsschritt in `infra/prod/keycloak/README.md`. Beweis:
`KeycloakRealmRoleConverterTest`, `TenantFilterTest`, `OcppActionPolicyTest` (ohne Docker) und
`KeycloakPartnerRolleApiTest` (Testcontainers Keycloak + TimescaleDB, echter Realm-Import).

## Was gilt

- **Das Token bleibt unverändert** (§6.1). Die Realm-Rollen sind `platform-admin`, `edge-release-publisher` und neu
  `partner`. `operator`, `admin` und `site-admin` sind Altbestand (E13) und stehen weiter auf den heutigen Konten.
- **Kontoart:** Der Konverter legt zusätzlich zu den `ROLE_*` GENAU EINE `KONTO_<code>` ab. Die Codes kommen aus
  `rechte-vectors.json → vokabular.konto` bzw. `RechteAbleitung.Konto`. `plattform` = `platform-admin` und geht vor.
  `partner` = Rolle `partner`, ein `tenant_id` wird dabei ignoriert. `benutzer` = gültiges UUID-`tenant_id`, sonst
  keine Kontoart, etwa beim Servicekonto.
- **Kundenkonto anlegen** (Registrierung, Admin-Konsole): nur `tenant_id`, KEINE Realm-Rolle. **Partner-Konto**:
  Rolle `partner`, nie `tenant_id`, alles oder nichts (fehlt die Rolle im Realm, wird das Konto zurückgerollt).
- **`TenantFilter`:** Ein Partner bekommt nie einen Kundenbereich, weder aus dem Claim noch über `X-Tenant-Id`.
- `voltpilot.keycloak.admin.customer-role` gibt es nicht mehr; ein noch gesetzter Wert wird ignoriert.

## ⚠ Fallen für die Folgepakete

- ⚠ **Kein Recht an `ROLE_operator` hängen.** Neue Kundenkonten tragen die Rolle nicht. „Ist das ein Kunde?“
  beantwortet `KONTO_benutzer`, ab IP-4 die Zuweisung. Die OCPP-Gates sind die Brücke bis IP-7 (E13):
  `hasAnyRole('operator', …) or hasAuthority('KONTO_benutzer')` und `OcppActionPolicy`. `OcppActionPolicyTest`
  pinnt den Ausdruck und den Freigabe-Bestand Aktion für Aktion.
- ⚠ **`TestingAuthenticationToken` und MockMvc-`jwt()` laufen NICHT durch den Konverter** und haben kein `KONTO_*`.
  Wer die Kontoart prüft, baut die Authentifizierung mit `new KeycloakRealmRoleConverter().convert(jwt)`
  (Muster `TenantFilterTest.tenantFuer`).
- ⚠ **IP-4 (`X-Kundenbereich`):** Der Partner-Zweig im `TenantFilter` liefert heute „kein Kundenbereich“. IP-4 füllt
  ihn NUR gegen eine wirksame Unterstützung. `X-Tenant-Id` bleibt allein der Plattform vorbehalten.
- ⚠ **IP-8/IP-14:** `createPartnerUser` braucht die Rolle im Realm. Der Live-Realm braucht deshalb den Betriebsschritt
  aus `infra/prod/keycloak/README.md` VOR dem Ausrollen. Sonst kommt 404 „Realm role 'partner' not found“, und das
  Konto wird zurückgerollt. Die E-Mail ist im ganzen Realm eindeutig: Kundenkonto und Partner-Konto mit derselben
  E-Mail ergeben 409 (E7).
- ⚠ `ZugriffBestand` liest nur Konten MIT `tenant_id` (`uems-zugriff-tabellen.md`). Ein Partner-Konto wird deshalb
  nie zum Kundenadministrator gemacht.
