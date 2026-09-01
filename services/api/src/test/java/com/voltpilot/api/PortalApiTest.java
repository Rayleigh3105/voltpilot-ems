package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * End-to-end test of the auth + tenancy spine against a REAL Keycloak and a REAL
 * TimescaleDB: mints tenant-scoped tokens from the imported dev realm and drives
 * the portal endpoints, proving (1) token validation - unauthenticated/invalid
 * are rejected, valid accepted - and (2) RLS isolation through the full stack -
 * each tenant sees only its own sites/devices/telemetry, and cross-tenant device
 * claiming is refused.
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class PortalApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String HAMBURG_SITE = "10000000-0000-0000-0000-000000000002";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        // App connects as the non-privileged role; Flyway migrates as superuser.
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);

        // Pin the LEGACY (bare-spot) pricing regime for no-data sites: the
        // OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS flag now defaults ON in
        // application.yml (captain decision 2026-07-29), but the earnings/
        // history vectors here (e.g. savedEurValuesAvoidedImportAtTheStructured
        // SupplyPrice's bare `ohne` site) are calibrated flag-OFF. The default-
        // ON behavior is proven at the composition level by
        // importPriceSqlMatchesTheSlotEconomicsCompositionVectors (both flags).
        registry.add("voltpilot.optimizer.default-supply-components", () -> "false");

        // OIDC on; issuer == the container's realm, JWKS discovered from it.
        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    @LocalServerPort
    int port;

    @Autowired
    com.voltpilot.api.command.CommandLogWriter commandLogWriter;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    com.voltpilot.api.repo.DeviceRepository deviceRepo;

    @Autowired
    com.voltpilot.api.repo.ControlStatusRepository controlStatusRepo;

    @Autowired
    com.voltpilot.api.repo.CurtailmentStatusRepository curtailmentStatusRepo;

    @Autowired
    com.voltpilot.api.repo.DeviceSourceStatusRepository sourceStatusRepo;

    @Autowired
    com.voltpilot.api.entities.EntityObservedRepository entityObservedRepo;

    @Autowired
    com.voltpilot.api.components.ComponentApplyRepository componentApplyRepo;

    @Autowired
    com.voltpilot.api.repo.FlowStatusRepository flowStatusRepo;

    @Autowired
    com.voltpilot.api.repo.EdgeVersionRepository edgeVersionRepo;

    @Autowired
    com.voltpilot.api.repo.UpdateStatusRepository updateStatusRepo;

    @Autowired
    com.voltpilot.api.rules.RuleEventWriter ruleEventWriter;

    @Autowired
    com.voltpilot.api.ocpp.OcppRepository ocppRepository;

    @Autowired
    com.fasterxml.jackson.databind.ObjectMapper objectMapper;

    // ---- token validation ---------------------------------------------------

    @Test
    void rejectsUnauthenticatedRequest() {
        ResponseEntity<String> res = rest.getForEntity(url("/api/v1/sites"), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void rejectsGarbageToken() {
        ResponseEntity<String> res = rest.exchange(url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(bearer("not-a-real-jwt")), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void healthStaysOpen() {
        assertThat(rest.getForEntity(url("/health"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    @Test
    void ocppFoundationPersistsCompleteDimensionedAndPrivacySafeStationData() throws Exception {
        String cp = "VP-RIG-OCPP-16";
        ingestOcpp(cp, 0, "internal", "Event", null, "Connected", "{}");
        ingestOcpp(cp, 1, "station_to_csms", "Call", "boot", "BootNotification", """
                {"chargePointVendor":"RigVendor","chargePointModel":"Complete-16",
                 "chargePointSerialNumber":"SN-42","chargeBoxSerialNumber":"BOX-9",
                 "firmwareVersion":"1.6.10","iccid":"iccid-test","imsi":"imsi-test",
                 "meterSerialNumber":"MTR-7","meterType":"MID"}
                """);
        ingestOcpp(cp, 2, "station_to_csms", "Call", "status", "StatusNotification", """
                {"connectorId":1,"status":"Faulted","errorCode":"OtherError",
                 "info":"contactor diagnostic","vendorId":"RigVendor",
                 "vendorErrorCode":"RV-17","timestamp":"2026-08-25T06:30:02Z"}
                """);
        ingestOcpp(cp, 3, "station_to_csms", "Call", "auth", "Authorize",
                "{\"idTag\":\"clear-rfid-4711\"}");
        ingestOcpp(cp, 4, "csms_to_station", "CallResult", "auth", "Authorize", """
                {"idTagInfo":{"status":"Accepted","parentIdTag":"clear-parent-tag",
                 "expiryDate":"2026-09-25T00:00:00Z"}}
                """);
        ingestOcpp(cp, 5, "station_to_csms", "Call", "start", "StartTransaction", """
                {"connectorId":1,"idTag":"clear-rfid-4711","meterStart":1000,
                 "reservationId":77,"timestamp":"2026-08-25T06:30:05Z"}
                """);
        ingestOcpp(cp, 6, "csms_to_station", "CallResult", "start", "StartTransaction", """
                {"transactionId":42,"idTagInfo":{"status":"Accepted",
                 "parentIdTag":"clear-parent-tag"}}
                """);
        ingestOcpp(cp, 7, "station_to_csms", "Call", "meter", "MeterValues", """
                {"connectorId":1,"transactionId":42,"meterValue":[{
                  "timestamp":"2026-08-25T06:31:00Z","sampledValue":[
                   {"value":"230.1","measurand":"Voltage","context":"Sample.Periodic",
                    "format":"Raw","phase":"L1-N","location":"Outlet","unit":"V"},
                   {"value":"229.9","measurand":"Voltage","context":"Sample.Periodic",
                    "format":"Raw","phase":"L2-N","location":"Outlet","unit":"V"},
                   {"value":"signed-payload","measurand":"Energy.Active.Import.Register",
                    "context":"Transaction.Begin","format":"SignedData","phase":"None",
                    "location":"EV","unit":"Wh"}]}]}
                """);
        ingestOcpp(cp, 8, "station_to_csms", "Call", "stop", "StopTransaction", """
                {"transactionId":42,"idTag":"clear-rfid-4711","meterStop":1450,
                 "reason":"DeAuthorized","timestamp":"2026-08-25T06:32:00Z",
                 "transactionData":[{"timestamp":"2026-08-25T06:32:00Z","sampledValue":[
                   {"value":"1450","measurand":"Energy.Active.Import.Register",
                    "context":"Transaction.End","format":"Raw","phase":"None",
                    "location":"Outlet","unit":"Wh"}]}]}
                """);
        ingestOcpp(cp, 9, "csms_to_station", "CallResult", "stop", "StopTransaction",
                "{\"idTagInfo\":{\"status\":\"Accepted\"}}");
        ingestOcpp(cp, 10, "station_to_csms", "Call", "diag", "DiagnosticsStatusNotification",
                "{\"status\":\"Uploaded\"}");
        ingestOcpp(cp, 11, "station_to_csms", "Call", "fw", "FirmwareStatusNotification",
                "{\"status\":\"Installed\"}");
        ingestOcpp(cp, 12, "csms_to_station", "Call", "config", "GetConfiguration", "{}");
        ingestOcpp(cp, 13, "station_to_csms", "CallResult", "config", "GetConfiguration", """
                {"configurationKey":[
                  {"key":"AuthorizationKey","readonly":false,"value":"never-store-this-secret"},
                  {"key":"SupportedFeatureProfiles","readonly":true,
                   "value":"Core,SmartCharging,FirmwareManagement"},
                  {"key":"RigVendor.Mode","readonly":true,"value":"complete"}],
                 "unknownKey":["NotImplemented.StandardKey"]}
                """);
        ingestOcpp(cp, 14, "station_to_csms", "CallError", "bad", "DataTransfer", "{}",
                "NotSupported", "AuthorizationKey=cloud-desc-secret "
                        + "https://station.invalid/x?token=cloud-url-token "
                        + "idTag=cloud-description-tag client_secret=cloud-generic-secret",
                "{\"idTag\":\"clear-error-tag\",\"data\":\"secret-vendor-data\"}");
        ingestOcpp(cp, 15, "csms_to_station", "Call", "profile", "SetChargingProfile", """
                {"connectorId":1,"csChargingProfiles":{"chargingProfileId":1042,
                 "transactionId":42,"stackLevel":0,"chargingProfilePurpose":"TxProfile",
                 "chargingProfileKind":"Absolute","chargingSchedule":{"duration":120,
                 "startSchedule":"2026-08-25T06:30:15Z","chargingRateUnit":"W",
                 "minChargingRate":6000,"chargingSchedulePeriod":[
                   {"startPeriod":0,"limit":11000,"numberPhases":3}]}}}
                """);
        ingestOcpp(cp, 16, "internal", "Event", null, "JournalGap", """
                {"dropped_count":3,"total_dropped":7,
                 "first_occurred_at":"2026-08-25T06:29:00Z",
                 "last_occurred_at":"2026-08-25T06:29:30Z",
                 "first_event_id":"gap-first","last_event_id":"gap-last",
                 "reasons":{"capacity_overflow":2,"write_failure":1}}
                """);

        String demo = token("demo", "demo");
        ResponseEntity<String> stations = rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/ocpp/stations"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class);
        assertThat(stations.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(stations.getBody()).contains(cp, "Complete-16", "RV-17", "Uploaded", "Installed",
                "SmartCharging");

        List<Map<String, Object>> meter = rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/ocpp/meter-values?transactionId=42"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {}).getBody();
        assertThat(meter).hasSize(4);
        assertThat(meter).extracting(v -> v.get("pointKey")).doesNotHaveDuplicates();
        assertThat(meter).extracting(v -> v.get("pointKey").toString())
                .anyMatch(v -> v.contains("phase=L1-N") && v.contains("location=Outlet")
                        && v.contains("context=Sample.Periodic") && v.contains("unit=V"))
                .anyMatch(v -> v.contains("format=SignedData") && v.contains("location=EV"));

        String transactions = rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/ocpp/transactions"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class).getBody();
        assertThat(transactions).contains("DeAuthorized", "1450", "reservationId", "tagref_",
                        "\"chargingProfileId\":1042", "\"chargingProfilePurpose\":\"TxProfile\"")
                .doesNotContain("clear-rfid-4711", "clear-parent-tag");

        String configuration = rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/ocpp/configuration?chargePointId=" + cp), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class).getBody();
        assertThat(configuration).contains("AuthorizationKey", "\"value\":null",
                        "\"secret\":true", "RigVendor.Mode", "NotImplemented.StandardKey",
                        "FirmwareManagement")
                .doesNotContain("never-store-this-secret");

        String events = rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/ocpp/events?limit=100"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class).getBody();
        assertThat(events).contains("CallError", "NotSupported", "BootNotification",
                        "[redacted-call-error-description]", "JournalGap")
                .doesNotContain("clear-rfid-4711", "clear-parent-tag", "clear-error-tag",
                        "never-store-this-secret", "secret-vendor-data", "cloud-desc-secret",
                        "cloud-url-token", "cloud-description-tag", "cloud-generic-secret");

        String gaps = rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/ocpp/gaps"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class).getBody();
        assertThat(gaps).contains("\"droppedCount\":3", "\"totalDropped\":7",
                "gap-first", "gap-last", "capacity_overflow", "write_failure");

        String permissions = rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/ocpp/action-permissions"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class).getBody();
        assertThat(permissions).contains("\"RemoteStartTransaction\":true",
                        "\"ChangeConfiguration\":false", "\"UpdateFirmware\":false");

        ResponseEntity<String> crossTenant = rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/ocpp/stations"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(crossTenant.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/ocpp/gaps"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        HttpHeaders adminHeaders = bearer(token("admin", "admin"));
        adminHeaders.set("X-Tenant-Id", "00000000-0000-0000-0000-000000000001");
        ResponseEntity<String> admin = rest.exchange(url("/api/v1/sites/" + BERLIN_SITE
                        + "/ocpp/stations"), HttpMethod.GET,
                new HttpEntity<>(adminHeaders), String.class);
        assertThat(admin.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(admin.getBody()).contains(cp);
    }

    // ---- tenant isolation through the API -----------------------------------

    @Test
    void eachTenantSeesOnlyItsOwnSites() {
        // Tenant A is the dev-seeded multi-site fleet; other tests may add more
        // sites at runtime, so assert the seed is present and nothing foreign is.
        List<Map<String, Object>> tenantA = sites(token("demo", "demo"));
        assertThat(tenantA).extracting(s -> s.get("name"))
                .contains("Demo Site Berlin", "Solarpark Dachau", "Hof Lindenberg")
                .doesNotContain("Nordwind Hamburg");

        List<Map<String, Object>> tenantB = sites(token("demo2", "demo2"));
        assertThat(tenantB).extracting(s -> s.get("name")).containsExactly("Nordwind Hamburg");
    }

    @Test
    void telemetryIsTenantScoped() {
        // Tenant A can read its own site's telemetry...
        ResponseEntity<String> own = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/telemetry"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class);
        assertThat(own.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(own.getBody()).contains("pvPowerKw");

        // ...but tenant B cannot even see tenant A's site (RLS => 404).
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/telemetry"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * NEGATIVE security test for the admin tenant switcher: a CUSTOMER token
     * sending {@code X-Tenant-Id} with ANOTHER tenant's id must be served its
     * OWN tenant's data only - the header is honored exclusively for
     * platform-admin tokens ({@code TenantFilter}), so it can never widen a
     * customer's RLS scope.
     */
    @Test
    void customerXTenantIdHeaderIsIgnoredAndCannotWidenScope() {
        HttpHeaders spoofed = bearer(token("demo", "demo")); // tenant A
        spoofed.set("X-Tenant-Id", "10000000-0000-0000-0000-000000000001"); // tenant B

        // The site list is still exactly tenant A's own data.
        ResponseEntity<List<Map<String, Object>>> sites = rest.exchange(
                url("/api/v1/sites"), HttpMethod.GET, new HttpEntity<>(spoofed),
                new ParameterizedTypeReference<>() {});
        assertThat(sites.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(sites.getBody()).extracting(s -> s.get("name")).contains("Demo Site Berlin");
        assertThat(sites.getBody()).extracting(s -> s.get("name")).doesNotContain("Nordwind Hamburg");
        assertThat(sites.getBody()).extracting(s -> s.get("id")).doesNotContain(HAMBURG_SITE);

        // And tenant B's site stays invisible (404, not 403) despite the header.
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + HAMBURG_SITE + "/telemetry"), HttpMethod.GET,
                new HttpEntity<>(spoofed), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // Same for the device list: only tenant A's devices, none of tenant B's.
        ResponseEntity<List<Map<String, Object>>> devices = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET, new HttpEntity<>(spoofed),
                new ParameterizedTypeReference<>() {});
        assertThat(devices.getBody()).extracting(d -> d.get("externalRef"))
                .contains("demo-inverter-01")
                .doesNotContain("nordwind-inverter-01");
    }

    // ---- device claiming ----------------------------------------------------

    @Test
    void claimsFreshDeviceButRefusesCrossTenantClaim() {
        // Tenant A claims a brand-new device into its own site -> 201.
        ResponseEntity<Map<String, Object>> ok = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "edge-fresh-01"),
                        bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(ok.getBody()).containsEntry("status", "claimed");
        // A fresh claim has no telemetry yet -> "wartet auf erste Daten" state.
        assertThat(ok.getBody().get("lastSeenAt")).isNull();
        // createdAt is set at claim time - the portal uses it to escalate the
        // permanently-waiting copy after a threshold (M3).
        assertThat(ok.getBody().get("createdAt")).isNotNull();

        // The device list carries lastSeenAt: null for the fresh device, the
        // newest telemetry timestamp for the seeded one (which has demo data).
        ResponseEntity<List<Map<String, Object>>> devices = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(devices.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> fresh = devices.getBody().stream()
                .filter(d -> "edge-fresh-01".equals(d.get("externalRef"))).findFirst().orElseThrow();
        assertThat(fresh.get("lastSeenAt")).isNull();
        Map<String, Object> seeded = devices.getBody().stream()
                .filter(d -> "demo-inverter-01".equals(d.get("externalRef"))).findFirst().orElseThrow();
        assertThat(seeded.get("lastSeenAt")).isNotNull();

        // Tenant B tries to claim tenant A's already-claimed device -> 409.
        ResponseEntity<String> conflict = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", HAMBURG_SITE, "externalRef", "demo-inverter-01"),
                        bearer(token("demo2", "demo2"))),
                String.class);
        assertThat(conflict.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    @Test
    void claimIsIdempotentPerTenantAndCanonicalizesStickerIds() {
        String demo = token("demo", "demo");

        // Sticker IDs are registry-gated: this one exists (as manufacturing
        // provisioning would have registered it).
        exec("INSERT INTO provisioned_device (external_ref) VALUES ('VP-IDEM-42AB') "
                + "ON CONFLICT DO NOTHING");

        // Sticker Geräte-IDs are printed uppercase - a padded, lowercase entry
        // must land as the canonical uppercase ref, not as a second device.
        ResponseEntity<Map<String, Object>> first = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "  vp-idem-42ab "),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(first.getBody()).containsEntry("externalRef", "VP-IDEM-42AB");

        // Re-entering your own device (wizard restart, double submit) is
        // idempotent: 200 with the SAME device, never a scary 409.
        ResponseEntity<Map<String, Object>> again = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "VP-idem-42AB"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(again.getBody()).containsEntry("id", first.getBody().get("id"));

        // Another tenant claiming the same sticker ID (any case) stays a conflict.
        ResponseEntity<String> conflict = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", HAMBURG_SITE, "externalRef", "vp-idem-42ab"),
                        bearer(token("demo2", "demo2"))),
                String.class);
        assertThat(conflict.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    @Test
    void unknownStickerIdIsRejectedInsteadOfCreatingAGhostDevice() {
        String demo = token("demo", "demo");

        // A typo'd sticker ID is NOT in the manufacturing registry -> the claim
        // fails fast (422) instead of creating a device that would "wait for
        // first data" forever.
        ResponseEntity<String> rejected = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "VP-TYPO-9999"),
                        bearer(demo)),
                String.class);
        assertThat(rejected.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // No ghost device row was created.
        ResponseEntity<List<Map<String, Object>>> devices = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(devices.getBody())
                .extracting(d -> d.get("externalRef")).doesNotContain("VP-TYPO-9999");

        // Once provisioned (with its manufactured kind), the same ID claims fine
        // and the device inherits the registry kind - the customer never picks it.
        exec("INSERT INTO provisioned_device (external_ref, kind) "
                + "VALUES ('VP-TYPO-9999', 'battery') ON CONFLICT DO NOTHING");
        ResponseEntity<Map<String, Object>> claimed = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "vp-typo-9999"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(claimed.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(claimed.getBody()).containsEntry("externalRef", "VP-TYPO-9999");
        assertThat(claimed.getBody()).containsEntry("kind", "battery");
    }

    @Test
    void mistypedGeneratedEdgeRefIsRejectedWhileTheValidRefClaims() {
        String demo = token("demo", "demo");

        // A self-generated edge reference ("edge-" + 6 body chars + a check char);
        // "edge-abcdefj" carries the correct check character (see EdgeRefTest).
        String valid = "edge-abcdefj";

        // A one-character typo of the shown reference (last char off by one) fails
        // its checksum -> 422, so no ghost device that would wait for data forever.
        ResponseEntity<String> rejected = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "edge-abcdefk"),
                        bearer(demo)),
                String.class);
        assertThat(rejected.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        ResponseEntity<List<Map<String, Object>>> afterTypo = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(afterTypo.getBody())
                .extracting(d -> d.get("externalRef")).doesNotContain("edge-abcdefk");

        // The correctly-typed reference round-trips (ungated insert, 201). A mobile
        // keyboard's uppercase is canonicalized back to the stored lowercase form.
        ResponseEntity<Map<String, Object>> ok = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "EDGE-ABCDEFJ"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(ok.getBody()).containsEntry("externalRef", valid);
    }

    @Test
    void topicUnsafeOrOverlongRefsAreRejectedBeforeReachingMqttOrTheDatabase() {
        String demo = token("demo", "demo");

        // The ref is interpolated into the retained MQTT provisioning topic, so
        // MQTT metacharacters ('/', '+', '#') and over-long refs must be
        // refused up front (audit S5) - same rule as the enrollment path.
        for (String evil : List.of("ems/spoof", "a/+/b", "ref#", "x".repeat(70))) {
            ResponseEntity<String> rejected = rest.exchange(
                    url("/api/v1/devices/claim"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", evil),
                            bearer(demo)),
                    String.class);
            assertThat(rejected.getStatusCode()).as("ref %s", evil)
                    .isEqualTo(HttpStatus.BAD_REQUEST);
        }
        // Nothing was stored for any of them.
        ResponseEntity<List<Map<String, Object>>> devices = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(devices.getBody())
                .extracting(d -> d.get("externalRef"))
                .doesNotContain("ems/spoof", "a/+/b", "ref#");
    }

    @Test
    void deviceListingCarriesLastSeenFromTelemetry() {
        String demo = token("demo", "demo");

        // A fresh claim has never reported -> lastSeenAt is null.
        ResponseEntity<Map<String, Object>> claimed = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "edge-lastseen-01"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(claimed.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(claimed.getBody().get("lastSeenAt")).isNull();
        String newDeviceId = (String) claimed.getBody().get("id");

        // Once telemetry lands for it (seeded as the ingest pipe would write it),
        // the listing reports the newest sample time as lastSeenAt.
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, payload) "
                + "VALUES (now() - interval '3 minutes', '00000000-0000-0000-0000-000000000001', '"
                + BERLIN_SITE + "', '" + newDeviceId + "', 1.5, "
                + "jsonb_build_object('schema_version', 1, 'source', 'test'))");

        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> mine = res.getBody().stream()
                .filter(d -> "edge-lastseen-01".equals(d.get("externalRef")))
                .findFirst().orElseThrow();
        String lastSeenAt = (String) mine.get("lastSeenAt");
        assertThat(lastSeenAt).isNotNull();
        assertThat(java.time.Instant.parse(lastSeenAt))
                .isBetween(java.time.Instant.now().minusSeconds(600), java.time.Instant.now());

        // The seeded demo inverter has ~24h of dev telemetry -> lastSeenAt set too.
        Map<String, Object> seeded = res.getBody().stream()
                .filter(d -> "demo-inverter-01".equals(d.get("externalRef")))
                .findFirst().orElseThrow();
        assertThat((String) seeded.get("lastSeenAt")).isNotNull();
    }

    @Test
    void deviceReplayingBackloggedTelemetryReadsLiveNotStale() {
        String demo = token("demo", "demo");

        // A reconnecting store-and-forward edge replays its buffer oldest-first
        // with ORIGINAL observation timestamps: it is actively delivering samples
        // RIGHT NOW, but each sample's `time` is hours old. Liveness must follow
        // the arrival time (received_at), not the observation time - otherwise an
        // online device wrongly reads offline (regression for the device-list
        // online indicator).
        ResponseEntity<Map<String, Object>> claimed = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "edge-backlog-01"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(claimed.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String newDeviceId = (String) claimed.getBody().get("id");

        // Observation time = 3h ago (buffered), but it ARRIVED ~20s ago.
        exec("INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, power_kw, payload) "
                + "VALUES (now() - interval '3 hours', now() - interval '20 seconds', "
                + "'00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', '" + newDeviceId + "', 1.5, "
                + "jsonb_build_object('schema_version', 1, 'source', 'test'))");

        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        Map<String, Object> mine = res.getBody().stream()
                .filter(d -> "edge-backlog-01".equals(d.get("externalRef")))
                .findFirst().orElseThrow();
        String lastSeenAt = (String) mine.get("lastSeenAt");
        assertThat(lastSeenAt).isNotNull();
        // Arrival-based liveness keeps the device inside the 5-min online window
        // even though its newest observation timestamp is 3h old.
        assertThat(java.time.Instant.parse(lastSeenAt))
                .isAfter(java.time.Instant.now().minusSeconds(120));
    }

    // ---- site creation (customer self-service, tenant-bound) ----------------

    /**
     * Regression for the "Live-Daten frozen in the past" bug (F6): the 24h
     * telemetry query used {@code ORDER BY time ASC LIMIT 5000}, so once a site
     * exceeded 5000 samples per day the NEWEST rows were truncated away and the
     * live view drifted hours into the past. The returned window must be
     * complete (reaches the oldest sample) AND current (reaches the newest
     * sample), downsampled server-side when the raw count would exceed the cap.
     */
    @Test
    void telemetryWindowStaysCompleteAndCurrentWhenRawCountExceedsTheLimit() {
        String demo = token("demo", "demo");

        // Own site + device so the chatty seed never interferes with the
        // dev-seeded Berlin telemetry other tests read.
        ResponseEntity<Map<String, Object>> siteRes = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Chatty Site"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(siteRes.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String siteId = (String) siteRes.getBody().get("id");
        ResponseEntity<Map<String, Object>> claimed = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", "edge-chatty-01"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(claimed.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String deviceId = (String) claimed.getBody().get("id");

        // ~6400 samples over the last 23h (13 s cadence) - well over MAX_POINTS 5000.
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, pv_power_kw, load_kw, payload) "
                + "SELECT g, '00000000-0000-0000-0000-000000000001', '" + siteId + "', '" + deviceId + "', "
                + "1.0, 0.5, 1.5, jsonb_build_object('source', 'test') "
                + "FROM generate_series(now() - interval '23 hours', now() - interval '30 seconds', "
                + "interval '13 seconds') g");

        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/telemetry"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> points = res.getBody();
        assertThat(points).isNotEmpty();
        assertThat(points.size()).isLessThanOrEqualTo(5000);

        java.time.Instant first = java.time.Instant.parse((String) points.get(0).get("ts"));
        java.time.Instant last = java.time.Instant.parse((String) points.get(points.size() - 1).get("ts"));
        // CURRENT: the newest sample (~30 s old) is represented (1-min-bucket tolerance).
        // The old ASC LIMIT cut here: the last returned point was hours old.
        assertThat(last).isAfter(java.time.Instant.now().minusSeconds(150));
        // COMPLETE: the window still reaches back to the oldest sample.
        assertThat(first).isBefore(java.time.Instant.now().minus(22, java.time.temporal.ChronoUnit.HOURS));
        // Ascending presentation order, values carried through the aggregation.
        assertThat(first).isBefore(last);
        assertThat(((Number) points.get(points.size() - 1).get("pvPowerKw")).doubleValue())
                .isEqualTo(0.5);

        // Clean up (unclaim deletes the telemetry too) so the extra site never
        // leaks into the other tests' exact site-list assertions.
        assertThat(rest.exchange(url("/api/v1/devices/" + deviceId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo)), Void.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo)), Void.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
    }

    @Test
    void customerCreatesSiteForOwnTenantAndSeesItInClaimDropdown() {
        String demo = token("demo", "demo");

        // Create a site as the customer - tenant taken from the token, not the body.
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Werk Spandau", "biddingZone", "DE-LU",
                        "latitude", 52.53, "longitude", 13.20), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String newSiteId = (String) created.getBody().get("id");
        assertThat(newSiteId).isNotBlank();
        assertThat(created.getBody()).containsEntry("name", "Werk Spandau");
        assertThat(created.getBody()).containsEntry("biddingZone", "DE-LU");

        // It now shows up in the tenant's own site list (which populates the
        // "claim device" dropdown), alongside the seeded Berlin site.
        List<Map<String, Object>> mine = sites(demo);
        assertThat(mine).extracting(s -> s.get("name"))
                .contains("Demo Site Berlin", "Werk Spandau");

        // And the freshly-created site can immediately host a device claim.
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", newSiteId, "externalRef", "edge-spandau-01"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(claim.getBody()).containsEntry("siteId", newSiteId);
    }

    @Test
    void customerCannotCreateSiteForAnotherTenant() {
        // demo2 (tenant B) crafts a request carrying tenant A's id in the body.
        // The body tenant is ignored (the endpoint uses the token's tenant), so
        // the row is created for tenant B - and tenant A never sees it.
        String demo2 = token("demo2", "demo2");
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Fremdstandort",
                        "tenantId", "00000000-0000-0000-0000-000000000001",
                        "tenant_id", "00000000-0000-0000-0000-000000000001"), bearer(demo2)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // Tenant B sees the new site (it is theirs)...
        assertThat(sites(demo2)).extracting(s -> s.get("name"))
                .contains("Nordwind Hamburg", "Fremdstandort");

        // ...but tenant A does NOT - the crafted tenant_id was never honoured.
        assertThat(sites(token("demo", "demo"))).extracting(s -> s.get("name"))
                .doesNotContain("Fremdstandort");
    }

    @Test
    void rejectsSiteWithBlankNameOrOutOfRangeCoordinates() {
        String demo = token("demo", "demo");

        assertThat(rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "  "), bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Bad Geo", "latitude", 999.0), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ---- entity lifecycle: edit + delete -------------------------------------

    @Test
    void siteEditIsTenantScopedAndMirrorsCreateValidation() {
        String demo = token("demo", "demo");

        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Werk Tippfehlre"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String siteId = (String) created.getBody().get("id");

        // Fix the typo'd name and add zone + coordinates in one edit.
        ResponseEntity<Map<String, Object>> updated = rest.exchange(
                url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Werk Tippfehler behoben", "biddingZone", "AT",
                        "latitude", 47.27, "longitude", 11.39), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(updated.getBody()).containsEntry("name", "Werk Tippfehler behoben");
        assertThat(updated.getBody()).containsEntry("biddingZone", "AT");
        assertThat(sites(demo)).extracting(s -> s.get("name")).contains("Werk Tippfehler behoben");

        // Validation mirrors create: blank name / out-of-range coordinates -> 400.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "  "), bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Ok", "latitude", 999.0), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Cross-tenant: another tenant can neither see nor edit it (404, RLS).
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Übernahme"), bearer(token("demo2", "demo2"))),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(sites(demo)).extracting(s -> s.get("name")).doesNotContain("Übernahme");
    }

    @Test
    void siteDeleteIsGuardedByDevicesAndCascadesSeriesData() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        // A disposable site with a device and recorded series data.
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Werk Wegwerf"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        String siteId = (String) created.getBody().get("id");
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", "edge-wegwerf-01"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        String deviceId = (String) claim.getBody().get("id");
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES "
                + "(now() - interval '2 hours', '" + tenantA + "', '" + siteId + "', '" + deviceId + "', 1.0), "
                + "(now() - interval '1 hour', '" + tenantA + "', '" + siteId + "', '" + deviceId + "', 2.0)");
        exec("INSERT INTO forecast (time, tenant_id, site_id, kind, model, value_kw, run_at, horizon_min, method) "
                + "VALUES (now(), '" + tenantA + "', '" + siteId + "', 'load', 'load-persistence', 1.2, now(), 60, 'test')");
        exec("INSERT INTO weather_forecast (time, tenant_id, site_id, run_at, temperature_c, source) "
                + "VALUES (now(), '" + tenantA + "', '" + siteId + "', now(), 20.0, 'open-meteo')");
        OcppTestData.seed(PortalApiTest::exec, tenantA, siteId, deviceId);
        assertThat(queryLong(OcppTestData.countBySiteSql(siteId))).isEqualTo(11);

        // The deletion preview lists the concrete consequences for the dialog.
        ResponseEntity<Map<String, Object>> preview = rest.exchange(
                url("/api/v1/sites/" + siteId + "/deletion-preview"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(preview.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(preview.getBody()).containsEntry("deviceCount", 1);
        assertThat(((Number) preview.getBody().get("telemetryCount")).longValue()).isEqualTo(2L);
        assertThat(preview.getBody().get("telemetryFrom")).isNotNull();
        assertThat(((Number) preview.getBody().get("weatherCount")).longValue()).isEqualTo(1L);

        // GUARD: while a device exists, the delete is refused (409).
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);

        // Cross-tenant: the other tenant gets 404, not the guard's 409.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // Unclaim the device, then the delete goes through...
        assertThat(rest.exchange(url("/api/v1/devices/" + deviceId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(queryLong(OcppTestData.countByDeviceSql(deviceId))).isZero();
        // Legacy-defense proof for the SITE path itself: the published
        // foundation briefly allowed orphan OCPP rows. Bypass FK triggers only
        // while seeding that pre-hardening state; the real endpoint must sweep
        // all eleven tables even though no device remains.
        seedLegacyOrphanOcpp(tenantA, siteId, deviceId);
        assertThat(queryLong(OcppTestData.countBySiteSql(siteId))).isEqualTo(11);
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        // ...the site is gone from the listing and every series row with it.
        assertThat(sites(demo)).extracting(s -> s.get("name")).doesNotContain("Werk Wegwerf");
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE site_id = '" + siteId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM forecast WHERE site_id = '" + siteId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM weather_forecast WHERE site_id = '" + siteId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + siteId + "'")).isZero();
        assertThat(queryLong(OcppTestData.countBySiteSql(siteId))).isZero();
    }

    @Test
    void deviceEditAndUnclaimDeleteTelemetryAndAllowReclaim() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "edge-unclaim-01"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        String deviceId = (String) claim.getBody().get("id");
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES "
                + "(now(), '" + tenantA + "', '" + BERLIN_SITE + "', '" + deviceId + "', 3.3)");
        OcppTestData.seed(PortalApiTest::exec, tenantA, BERLIN_SITE, deviceId);
        assertThat(queryLong(OcppTestData.countByDeviceSql(deviceId))).isEqualTo(11);

        // Edit: kind + label. The externalRef is identity and stays untouched.
        ResponseEntity<Map<String, Object>> updated = rest.exchange(
                url("/api/v1/devices/" + deviceId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("kind", "battery", "name", "Speicher Keller"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(updated.getBody()).containsEntry("kind", "battery");
        assertThat(updated.getBody()).containsEntry("name", "Speicher Keller");
        assertThat(updated.getBody()).containsEntry("externalRef", "edge-unclaim-01");

        // Ein Standortwechsel ist kein Geräte-Feature mehr: weder Vorprüfung,
        // Mutation noch ein Hintergrundstatus bleiben als Route erreichbar.
        for (String removedPath : List.of("move-preview", "move-status")) {
            assertThat(rest.exchange(url("/api/v1/devices/" + deviceId + "/" + removedPath),
                    HttpMethod.GET, new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                    .isEqualTo(HttpStatus.NOT_FOUND);
        }
        assertThat(rest.exchange(url("/api/v1/devices/" + deviceId + "/move"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("targetSiteId", BERLIN_SITE,
                        "expectedRevision", 1, "effectiveAt", Instant.now().toString()),
                        bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A bad kind mirrors the enum validation (400).
        assertThat(rest.exchange(url("/api/v1/devices/" + deviceId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("kind", "toaster"), bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Cross-tenant: another tenant can neither edit nor delete it (404).
        String demo2 = token("demo2", "demo2");
        assertThat(rest.exchange(url("/api/v1/devices/" + deviceId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "fremd"), bearer(demo2)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/devices/" + deviceId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo2)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // Unclaim: the device row AND its telemetry are gone.
        assertThat(rest.exchange(url("/api/v1/devices/" + deviceId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE device_id = '" + deviceId + "'")).isZero();
        assertThat(queryLong(OcppTestData.countByDeviceSql(deviceId))).isZero();
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId + "'")).isZero();

        // The freed ref is claimable again (fresh row, fresh id).
        ResponseEntity<Map<String, Object>> reclaimed = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "edge-unclaim-01"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(reclaimed.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(reclaimed.getBody().get("id")).isNotEqualTo(deviceId);
    }

    /**
     * "Datenaufzeichnungen löschen": the purge deletes ALL recorded data of ONE
     * device - raw telemetry gone, the site's rollups rebuilt so only the
     * OTHER device's contribution remains - while the device itself stays
     * claimed and operational, a purge watermark is stamped, authorization
     * follows RLS (foreign tenant = 404), and new data recorded afterwards
     * flows normally.
     */
    @Test
    void purgeDeviceDataDeletesRecordingsRebuildsRollupsAndKeepsDeviceClaimed() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";
        String purged = claimDevice(demo, "edge-purge-01");
        String kept = claimDevice(demo, "edge-purge-02");

        // Far-past observations (before the rollup job's trailing 7-day window,
        // so nothing re-aggregates behind the test's back). 10:00 bucket carries
        // BOTH devices; 10:15 carries ONLY the to-be-purged one.
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, load_kw, pv_power_kw) VALUES "
                + "('2026-01-05T10:00:00Z', '" + tenantA + "', '" + BERLIN_SITE + "', '" + purged + "', 2.0, 2.0, 0), "
                + "('2026-01-05T10:16:00Z', '" + tenantA + "', '" + BERLIN_SITE + "', '" + purged + "', 4.0, 4.0, 0), "
                + "('2026-01-05T10:01:00Z', '" + tenantA + "', '" + BERLIN_SITE + "', '" + kept + "', 1.0, 1.0, 0)");
        exec("CALL refresh_telemetry_rollups('2026-01-05T00:00:00Z')");
        assertThat(queryLong("SELECT n_samples FROM telemetry_rollup_15m WHERE site_id = '"
                + BERLIN_SITE + "' AND bucket = '2026-01-05T10:00:00Z'")).isEqualTo(2);
        assertThat(queryLong("SELECT count(*) FROM telemetry_rollup_15m WHERE site_id = '"
                + BERLIN_SITE + "' AND bucket = '2026-01-05T10:15:00Z'")).isEqualTo(1);
        OcppTestData.seed(PortalApiTest::exec, tenantA, BERLIN_SITE, purged);
        OcppTestData.seed(PortalApiTest::exec, tenantA, BERLIN_SITE, kept);
        assertThat(queryLong(OcppTestData.countByDeviceSql(purged))).isEqualTo(11);
        assertThat(queryLong(OcppTestData.countByDeviceSql(kept))).isEqualTo(11);

        // Authorization: another tenant cannot purge it (RLS => 404).
        assertThat(rest.exchange(url("/api/v1/devices/" + purged + "/purge-data"), HttpMethod.POST,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE device_id = '" + purged + "'"))
                .isEqualTo(2);
        assertThat(queryLong(OcppTestData.countByDeviceSql(purged))).isEqualTo(11);

        // The owner purges: raw telemetry of THIS device is gone, the other
        // device's rows stay, and the watermark is stamped.
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/devices/" + purged + "/purge-data"), HttpMethod.POST,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) res.getBody().get("purgedRows")).longValue()).isEqualTo(2);
        // No broker configured in this test slice -> the command could not go out.
        assertThat(res.getBody()).containsEntry("deviceNotified", false);
        assertThat(res.getBody().get("purgedBefore")).isNotNull();
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE device_id = '" + purged + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE device_id = '" + kept + "'")).isEqualTo(1);
        assertThat(queryLong(OcppTestData.countByDeviceSql(purged))).isZero();
        assertThat(queryLong(OcppTestData.countByDeviceSql(kept))).isEqualTo(11);
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + purged
                + "' AND data_purged_before IS NOT NULL")).isEqualTo(1);

        // Rollups rebuilt: the shared bucket now reflects ONLY the kept device,
        // and the purged-device-only bucket disappeared entirely (all tiers).
        assertThat(queryLong("SELECT n_samples FROM telemetry_rollup_15m WHERE site_id = '"
                + BERLIN_SITE + "' AND bucket = '2026-01-05T10:00:00Z'")).isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM telemetry_rollup_15m WHERE site_id = '"
                + BERLIN_SITE + "' AND bucket = '2026-01-05T10:15:00Z'")).isZero();
        assertThat(queryLong("SELECT coalesce(sum(n_samples), 0) FROM telemetry_rollup_1h "
                + "WHERE site_id = '" + BERLIN_SITE + "' AND bucket = '2026-01-05T10:00:00Z'"))
                .isEqualTo(1);

        // The device is NOT unclaimed: still listed, still updatable, and new
        // data recorded after the purge is visible again.
        ResponseEntity<List<Map<String, Object>>> devices = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(devices.getBody()).extracting(d -> d.get("id")).contains(purged);
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES "
                + "(now(), '" + tenantA + "', '" + BERLIN_SITE + "', '" + purged + "', 1.5)");
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE device_id = '" + purged + "'"))
                .isEqualTo(1);

        // Idempotent: purging again removes the one new row and just advances
        // the watermark - never an error.
        ResponseEntity<Map<String, Object>> again = rest.exchange(
                url("/api/v1/devices/" + purged + "/purge-data"), HttpMethod.POST,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) again.getBody().get("purgedRows")).longValue()).isEqualTo(1);
    }

    /**
     * A database-controlled race: the purge is stopped inside its watermark
     * UPDATE after it already owns the production per-device lock. OCPP ingest
     * is then started and observed waiting on that same lock. Once released,
     * purge finishes first and the post-watermark event must commit together
     * with every derived StatusNotification row - never as a partial survivor.
     */
    @Test
    void postWatermarkOcppIngestWaitsForPurgeAndSurvivesCompletely() throws Exception {
        String demo = token("demo", "demo");
        UUID tenant = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UUID site = UUID.fromString(BERLIN_SITE);
        UUID device = UUID.fromString(claimDevice(demo, "edge-purge-race-01"));
        UUID eventId = UUID.randomUUID();
        String cp = "VP-PURGE-RACE-" + device.toString().substring(0, 8);
        Instant occurredAt = Instant.now().plusSeconds(3600);
        var envelope = statusEnvelope(eventId, occurredAt, cp);
        long gateKey = 8_252_026_082_501L;
        String trigger = "vp_test_purge_gate";
        String function = trigger + "_fn";
        ExecutorService pool = Executors.newFixedThreadPool(2);

        try (Connection gate = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement gateStatement = gate.createStatement()) {
            gateStatement.execute("SELECT pg_advisory_lock(" + gateKey + ")");
            exec("CREATE OR REPLACE FUNCTION " + function + "() RETURNS trigger LANGUAGE plpgsql AS $$ "
                    + "BEGIN IF NEW.id = '" + device + "'::uuid "
                    + "AND NEW.data_purged_before IS DISTINCT FROM OLD.data_purged_before THEN "
                    + "PERFORM pg_advisory_xact_lock(" + gateKey + "); END IF; RETURN NEW; END $$");
            exec("CREATE TRIGGER " + trigger + " BEFORE UPDATE OF data_purged_before ON device "
                    + "FOR EACH ROW EXECUTE FUNCTION " + function + "()");

            Future<ResponseEntity<Map<String, Object>>> purge = pool.submit(() -> rest.exchange(
                    url("/api/v1/devices/" + device + "/purge-data"), HttpMethod.POST,
                    new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {}));
            awaitBlockedStatement("UPDATE device SET data_purged_before");

            Future<Boolean> ingest = pool.submit(() -> {
                com.voltpilot.api.tenant.TenantContext.set(tenant);
                try {
                    return ocppRepository.ingest(tenant, site, device, envelope);
                } finally {
                    com.voltpilot.api.tenant.TenantContext.clear();
                }
            });
            awaitBlockedStatement("SELECT pg_advisory_xact_lock");
            assertThat(purge.isDone()).isFalse();
            assertThat(ingest.isDone()).isFalse();

            // This is the only release point: purge completes its atomic sweep,
            // releases the device lock, then ingest re-checks T and commits.
            try (java.sql.ResultSet unlocked = gateStatement.executeQuery(
                    "SELECT pg_advisory_unlock(" + gateKey + ")")) {
                assertThat(unlocked.next()).isTrue();
                assertThat(unlocked.getBoolean(1)).isTrue();
            }
            ResponseEntity<Map<String, Object>> purged = purge.get(15, TimeUnit.SECONDS);
            assertThat(purged.getStatusCode()).isEqualTo(HttpStatus.OK);
            Instant watermark = Instant.parse((String) purged.getBody().get("purgedBefore"));
            assertThat(occurredAt).isAfter(watermark);
            assertThat(ingest.get(15, TimeUnit.SECONDS)).isTrue();

            assertThat(queryLong("SELECT count(*) FROM ocpp_protocol_event WHERE device_id = '"
                    + device + "' AND event_id = '" + eventId + "'")).isEqualTo(1);
            assertThat(queryLong("SELECT count(*) FROM ocpp_station WHERE device_id = '"
                    + device + "' AND charge_point_id = '" + cp + "'")).isEqualTo(1);
            assertThat(queryLong("SELECT count(*) FROM ocpp_connector_status_event WHERE device_id = '"
                    + device + "' AND event_id = '" + eventId + "'")).isEqualTo(1);
            assertThat(queryLong("SELECT count(*) FROM ocpp_connector_state WHERE device_id = '"
                    + device + "' AND charge_point_id = '" + cp + "' AND connector_id = 1"))
                    .isEqualTo(1);

            // An old replay sees the committed watermark only after acquiring
            // the same lock and is rejected without recreating any row.
            var old = statusEnvelope(UUID.randomUUID(), watermark, cp);
            com.voltpilot.api.tenant.TenantContext.set(tenant);
            try {
                assertThat(ocppRepository.ingest(tenant, site, device, old)).isFalse();
            } finally {
                com.voltpilot.api.tenant.TenantContext.clear();
            }
        } finally {
            pool.shutdownNow();
            exec("DROP TRIGGER IF EXISTS " + trigger + " ON device");
            exec("DROP FUNCTION IF EXISTS " + function + "()");
        }
    }

    private com.fasterxml.jackson.databind.node.ObjectNode statusEnvelope(
            UUID eventId, Instant occurredAt, String chargePointId) throws Exception {
        var envelope = objectMapper.createObjectNode();
        envelope.put("schema_version", "1.0");
        envelope.put("event_id", eventId.toString());
        envelope.put("occurred_at", occurredAt.toString());
        envelope.put("charge_point_id", chargePointId);
        envelope.put("direction", "station_to_csms");
        envelope.put("message_type", "Call");
        envelope.put("correlation_id", eventId.toString());
        envelope.put("action", "StatusNotification");
        envelope.set("payload", objectMapper.readTree("""
                {"connectorId":1,"status":"Charging","errorCode":"NoError"}
                """));
        return envelope;
    }

    private static void awaitBlockedStatement(String prefix) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            String escaped = prefix.replace("'", "''");
            if (queryLong("SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() "
                    + "AND datname = current_database() AND wait_event_type = 'Lock' "
                    + "AND query LIKE '" + escaped + "%'") > 0) {
                return;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("statement did not reach deterministic lock gate: " + prefix);
    }

    private String claimDevice(String token, String externalRef) {
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", externalRef),
                        bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isIn(HttpStatus.CREATED, HttpStatus.OK);
        return (String) claim.getBody().get("id");
    }

    // ---- data feeds: day-ahead prices + weather -----------------------------

    @Test
    void pricesEndpointReturnsZoneSeries() {
        // Prices are public market data (no RLS); seed a couple of DE-LU slots.
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "VALUES (now(), 'DE-LU', 'PT15M', 42.5, 'EUR', 'energy-charts'), "
                + "(now() + interval '15 minutes', 'DE-LU', 'PT15M', 55.0, 'EUR', 'energy-charts') "
                + "ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/prices"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).containsEntry("biddingZone", "DE-LU");
        assertThat(res.getBody()).containsEntry("resolution", "PT15M");
        List<?> points = (List<?>) res.getBody().get("points");
        assertThat(points).isNotEmpty();

        // A foreign site is invisible via RLS -> 404 (never another tenant's zone).
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/prices"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void priceHistoryAggregatesByRangeWithSummaryAndBandStats() {
        // Deterministic far-past seed (2023) so other tests' now()-based DE-LU rows
        // never leak into these windows. Two slots on 2023-06-05 (spread 20..80)
        // and one on 2023-06-20 (60).
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "('2023-06-05T03:00:00Z', 'DE-LU', 'PT15M', 20.0, 'EUR', 'energy-charts'), "
                + "('2023-06-05T18:00:00Z', 'DE-LU', 'PT15M', 80.0, 'EUR', 'energy-charts'), "
                + "('2023-06-20T12:00:00Z', 'DE-LU', 'PT15M', 60.0, 'EUR', 'energy-charts') "
                + "ON CONFLICT DO NOTHING");

        // Month view: daily buckets (Europe/Berlin), avg/min/max band + summary.
        ResponseEntity<Map<String, Object>> month = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/price-history?range=month&at=2023-06-15"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(month.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(month.getBody()).containsEntry("biddingZone", "DE-LU");
        assertThat(month.getBody()).containsEntry("bucket", "P1D");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> buckets = (List<Map<String, Object>>) month.getBody().get("buckets");
        // Two Berlin days with data (bucket ts is the Berlin-day start in UTC, e.g.
        // June 5 Berlin = 2023-06-04T22:00Z, so match the aggregated day by value).
        assertThat(buckets).hasSize(2);
        Map<String, Object> june5 = buckets.stream()
                .filter(b -> b.get("avgEurMwh") != null && num(b, "avgEurMwh") == 50.0)
                .findFirst().orElseThrow(); // (20+80)/2
        assertThat(num(june5, "minEurMwh")).isEqualTo(20.0);
        assertThat(num(june5, "maxEurMwh")).isEqualTo(80.0);

        Map<String, Object> summary = map(month.getBody(), "summary");
        assertThat(num(summary, "count")).isEqualTo(3.0);
        assertThat(num(summary, "minEurMwh")).isEqualTo(20.0);
        assertThat(num(summary, "maxEurMwh")).isEqualTo(80.0);
        assertThat((String) summary.get("cheapestTs")).startsWith("2023-06-05T03:00");
        assertThat((String) summary.get("mostExpensiveTs")).startsWith("2023-06-05T18:00");

        // Day view of a past day: raw 15-min buckets, no forward extension.
        ResponseEntity<Map<String, Object>> day = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/price-history?range=day&at=2023-06-05"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(day.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(day.getBody()).containsEntry("bucket", "PT15M");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> dayBuckets = (List<Map<String, Object>>) day.getBody().get("buckets");
        assertThat(dayBuckets).hasSize(2);

        // Bad range -> 400.
        ResponseEntity<String> bad = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/price-history?range=decade"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))), String.class);
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Foreign site invisible via RLS -> 404.
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/price-history?range=month&at=2023-06-15"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void priceHistoryDayExtendsIntoTomorrowForForwardLookingView() {
        // A distinctive slot for tomorrow; the day view on "today" must include it
        // (the forward-looking day-ahead value the page keeps).
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "VALUES (date_trunc('day', now()) + interval '1 day 12 hours', 'DE-LU', 'PT15M', "
                + "1234.5, 'EUR', 'energy-charts') ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> today = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/price-history?range=day"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(today.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> buckets = (List<Map<String, Object>>) today.getBody().get("buckets");
        // The tomorrow slot (1234.5) is present -> the window extended past today.
        assertThat(buckets).anyMatch(b -> b.get("avgEurMwh") != null
                && ((Number) b.get("avgEurMwh")).doubleValue() == 1234.5);
    }

    @Test
    void weatherIsTenantScoped() {
        // Seed one weather row for tenant A's Berlin site (writer bypasses RLS).
        exec("INSERT INTO weather_forecast "
                + "(time, tenant_id, site_id, run_at, temperature_c, cloud_cover_pct, ghi_w_m2, source) "
                + "VALUES (now(), '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "now(), 21.5, 30.0, 500.0, 'open-meteo') ON CONFLICT DO NOTHING");

        // Tenant A reads its own site's weather.
        ResponseEntity<String> own = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/weather"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class);
        assertThat(own.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(own.getBody()).contains("temperatureC");

        // Tenant B cannot even see tenant A's site (RLS => 404), so no weather leaks.
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/weather"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void scheduleEndpointReturnsLatestPlanTenantScoped() {
        // Seed two optimizer runs for tenant A's Berlin site (the optimizer writes
        // as the trusted backend role, bypassing RLS): an older single-slot run and
        // a newer two-slot run. The endpoint must return the NEWER run only.
        exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                + "battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, baseline_cost_eur) "
                + "VALUES (now(), '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "'00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', "
                + "now() - interval '1 hour', 0, 0, 50.0, 0, 0, 100.0, 0, 0) "
                + "ON CONFLICT DO NOTHING");
        // The newer run also carries a peak-shaving target (PS-1); it must surface
        // on the plan so the portal's Peak-Band knows the "Ziel" grid-import limit.
        exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                + "battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, baseline_cost_eur, "
                + "curtail_kw, peak_target_kw, cover_load_from_battery, charge_from_surplus_only) "
                + "VALUES "
                + "(now(), '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "'00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', "
                + "now(), 5.0, 8.0, 62.5, 3.0, 2.0, 80.0, 0.02, 0.10, 0.0, 180.0, TRUE, FALSE), "
                + "(now() + interval '15 minutes', '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "'00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', "
                + "now(), -5.0, -2.0, 50.0, 3.0, 0.0, 200.0, 0.03, 0.05, 1.5, 180.0, NULL, TRUE) "
                + "ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/schedule"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).containsEntry("planId", "aaaaaaaa-0000-0000-0000-000000000002");
        assertThat(res.getBody()).containsEntry("slotMinutes", 15);
        // PS-1: the run's peak-shaving target rides on the plan (the Peak-Band "Ziel").
        assertThat(((Number) res.getBody().get("peakTargetKw")).doubleValue()).isEqualTo(180.0);
        List<?> slots = (List<?>) res.getBody().get("slots");
        assertThat(slots).hasSize(2); // the latest run only, not the older one
        // Headline savings = sum(baseline - cost) = (0.10-0.02) + (0.05-0.03).
        assertThat(((Number) res.getBody().get("savingsEur")).doubleValue())
                .isCloseTo(0.10, org.assertj.core.data.Offset.offset(1e-9));
        @SuppressWarnings("unchecked")
        Map<String, Object> first = (Map<String, Object>) slots.get(0);
        assertThat(((Number) first.get("batteryKw")).doubleValue()).isEqualTo(5.0);
        assertThat(((Number) first.get("socPct")).doubleValue()).isEqualTo(62.5);
        assertThat(((Number) first.get("curtailKw")).doubleValue()).isEqualTo(0.0);
        // The PV forecast input rides along so the portal's pv-aware
        // "Laden aus dem Netz" derivation (FK3) has its per-slot PV.
        assertThat(((Number) first.get("pvKw")).doubleValue()).isEqualTo(2.0);
        // ...and so does the LOAD forecast input, so the Fahrplan can draw the
        // two forecast lines (PV + Verbrauch) that explain the plan.
        assertThat(((Number) first.get("loadKw")).doubleValue()).isEqualTo(3.0);
        // Fahrplan-Warum null discipline: rows written before the why columns
        // (or with the explain layer off) serve nulls - the portal degrades
        // byte-identically to today, never a fabricated explanation.
        assertThat(first.get("slotRole")).isNull();
        assertThat(first.get("slotFlags")).isNull();
        assertThat(first.get("storedValueCtKwh")).isNull();
        assertThat(first.get("gridValueCtKwh")).isNull();
        assertThat(first.get("peakPressureEurKw")).isNull();
        assertThat(res.getBody().get("fallback14a")).isNull();
        // ... and the same for the Erklaerbarkeit-Stufe-1 facts: no anchor, no
        // free-refill share, no next-best margin. A run that recorded no driver
        // must not grow one on the way to the portal.
        assertThat(res.getBody().get("whyTerminalAnchor")).isNull();
        assertThat(res.getBody().get("whyRefillFreePct")).isNull();
        assertThat(first.get("whyNextBest")).isNull();
        assertThat(first.get("whyNextBestMarginCt")).isNull();
        // P0 "Textwahrheit": the slot carries the price the optimizer DECIDED
        // with, recomposed from spot + this site's master data (SlotEconomics),
        // plus which rule priced it. Berlin has no tariff/Preisblatt maintained,
        // so import IS bare spot here - and the source says exactly that, which
        // is what lets the portal's sentence stay truthful instead of passing
        // spot off as "Netzstrom" (report vp-netzbezug-nacht-s3 §6).
        assertThat(((Number) first.get("importPriceCtKwh")).doubleValue())
                .isCloseTo(8.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(((Number) first.get("exportValueCtKwh")).doubleValue())
                .isCloseTo(8.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(first.get("importPriceSource")).isEqualTo("spot");
        // The curtailing slot carries its held-back PV so the portal can quantify
        // the avoided negative-price loss.
        @SuppressWarnings("unchecked")
        Map<String, Object> second = (Map<String, Object>) slots.get(1);
        assertThat(((Number) second.get("curtailKw")).doubleValue()).isEqualTo(1.5);
        // Duty-Vorschau (V20260802010000): the two in-slot duties reach the
        // portal TRI-STATE, so the Fahrplan can preview "folgt dem gemessenen
        // Verbrauch" BEFORE the slot runs. An explicit FALSE must stay false
        // (evaluated, no duty) and a NULL must stay null (not evaluated) - the
        // portal marks a phase only on an explicit true.
        assertThat(first.get("coverLoadFromBattery")).isEqualTo(Boolean.TRUE);
        assertThat(first.get("chargeFromSurplusOnly")).isEqualTo(Boolean.FALSE);
        assertThat(second.get("coverLoadFromBattery")).isNull();
        assertThat(second.get("chargeFromSurplusOnly")).isEqualTo(Boolean.TRUE);

        // FK2 banked value, graceful degradation first: the run above predates
        // the terminal-value column (NULL), so the euro line is null while the
        // SoC bounds are still served. Plan-start SoC reverses the first slot's
        // dynamics with the Berlin battery (100 kWh, roundtrip 92% => eta):
        // socStart = 62.5 - eta*5kW*0.25h/100kWh*100 = 62.5 - 1.25*eta.
        double eta = Math.sqrt(0.92);
        double socStart = 62.5 - 1.25 * eta;
        assertThat(res.getBody().get("bankedValueEur")).isNull();
        assertThat(((Number) res.getBody().get("socStartPct")).doubleValue())
                .isCloseTo(socStart, org.assertj.core.data.Offset.offset(0.01));
        assertThat(((Number) res.getBody().get("socEndPct")).doubleValue()).isEqualTo(50.0);

        // With the run's terminal value persisted (what the optimizer now
        // writes), the banked value = V_end x (SoC_end - SoC_start) x capacity:
        // the plan draws DOWN stored energy (end 50% < start ~61.3%), so the
        // value is negative - "aus dem Vortag entnommen".
        // ...and with the Fahrplan-Warum columns persisted (what the explain
        // layer now writes), the decision facts surface on the customer
        // endpoint: role, split binding flags, the exact stored/grid values,
        // the peak pressure and the run-level fallback marker.
        // The Erklaerbarkeit-Stufe-1 facts ride the SAME update (V20260824000000):
        // the run-level anchor + free-refill share are written on EVERY row (the
        // terminal_value pattern), the next-best margin only on the RESTING slot -
        // here the second one, and the first (active) slot stays honestly empty.
        exec("UPDATE schedule SET terminal_value_eur_per_kwh = 0.18, "
                + "slot_role = 'guenstig_laden', slot_flags = 'charge_cap,peak_defining', "
                + "stored_value_ct_kwh = 24.2, grid_value_ct_kwh = 10.1, "
                + "peak_pressure_eur_kw = 1.25, fallback_14a = FALSE, "
                + "why_terminal_anchor = 'bezugspreis', why_refill_free_pct = 13.0 "
                + "WHERE plan_id = 'aaaaaaaa-0000-0000-0000-000000000002'");
        exec("UPDATE schedule SET why_next_best = 'decken', why_next_best_margin_ct = 0.0 "
                + "WHERE plan_id = 'aaaaaaaa-0000-0000-0000-000000000002' "
                + "AND battery_kw < 0");
        ResponseEntity<Map<String, Object>> banked = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/schedule"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(((Number) banked.getBody().get("bankedValueEur")).doubleValue())
                .isCloseTo(0.18 * (50.0 - socStart) / 100.0 * 100.0,
                        org.assertj.core.data.Offset.offset(1e-3));
        assertThat(banked.getBody().get("fallback14a")).isEqualTo(Boolean.FALSE);
        @SuppressWarnings("unchecked")
        Map<String, Object> whyFirst =
                (Map<String, Object>) ((List<?>) banked.getBody().get("slots")).get(0);
        assertThat(whyFirst).containsEntry("slotRole", "guenstig_laden");
        assertThat(whyFirst.get("slotFlags"))
                .isEqualTo(List.of("charge_cap", "peak_defining"));
        assertThat(((Number) whyFirst.get("storedValueCtKwh")).doubleValue()).isEqualTo(24.2);
        assertThat(((Number) whyFirst.get("gridValueCtKwh")).doubleValue()).isEqualTo(10.1);
        assertThat(((Number) whyFirst.get("peakPressureEurKw")).doubleValue()).isEqualTo(1.25);
        // Erklaerbarkeit Stufe 1: WHERE the value of stored energy came from -
        // the fact the 17.08.2026 customer needed and nobody could state. It is
        // a RUN fact, so it answers on the plan, not per slot.
        assertThat(banked.getBody()).containsEntry("whyTerminalAnchor", "bezugspreis");
        assertThat(((Number) banked.getBody().get("whyRefillFreePct")).doubleValue())
                .isEqualTo(13.0);
        // ... and the KNAPPHEIT reaches the slot that actually rested, while the
        // active one stays empty (its marginal benefit is 0 by construction).
        @SuppressWarnings("unchecked")
        Map<String, Object> whySecond =
                (Map<String, Object>) ((List<?>) banked.getBody().get("slots")).get(1);
        assertThat(whyFirst.get("whyNextBest")).isNull();
        assertThat(whyFirst.get("whyNextBestMarginCt")).isNull();
        assertThat(whySecond).containsEntry("whyNextBest", "decken");
        assertThat(((Number) whySecond.get("whyNextBestMarginCt")).doubleValue()).isEqualTo(0.0);

        // A site with no plan yet: empty but well-formed (tenant B's own site).
        ResponseEntity<Map<String, Object>> empty = rest.exchange(
                url("/api/v1/sites/" + HAMBURG_SITE + "/schedule"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(empty.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<?>) empty.getBody().get("slots")).isEmpty();

        // Tenant B cannot even see tenant A's site (RLS => 404), so no plan leaks.
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/schedule"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * "Wie der Tag geplant war" - the TAGES-SPLICE ({@code mode=day}, Konzept
     * vp-fahrplan-kunde-konzept §8 "PR 5", Captain-Entscheid D2): per slot the
     * value from the NEWEST run that planned it BEFORE it began, so the Film des
     * Tages can tick off the elapsed morning phases as PLANNED.
     *
     * <p>The fixture is anchored on the Europe/Berlin day (never on {@code now}),
     * so it proves the same thing at any time of day: yesterday's late run owns
     * the early morning, a re-plan that landed INSIDE a quarter hour does not
     * retroactively change how that quarter hour was planned, the slot after the
     * re-plan follows the newer run, and the newest run's slots on the following
     * day still ride along (the film keeps its "Morgen" collapsed).
     *
     * <p>Runs on its OWN site and cleans up after itself: a stray site with a
     * plan would move the hand-computed fleet/earnings numbers of the other
     * tests on tenant A.
     */
    @Test
    void scheduleDayModeSplicesTheDayFromTheRunsInForce() {
        final String site = "0000000a-0000-0000-0000-0000000000f5";
        final String device = "0000000a-0000-0000-0000-0000000000e5";
        final String tenant = "00000000-0000-0000-0000-000000000001";
        final String planZ = "aaaaaaaa-0000-0000-0000-0000000000f5";
        final String planA = "aaaaaaaa-0000-0000-0000-0000000000f6";
        final String planB = "aaaaaaaa-0000-0000-0000-0000000000f7";
        ZoneId berlin = ZoneId.of("Europe/Berlin");
        ZonedDateTime day0 = LocalDate.now(berlin).atStartOfDay(berlin);
        // The three runs: yesterday's late one, an early-morning one, and the
        // re-plan that lands INSIDE the 03:15 quarter hour.
        String genZ = iso(day0.minusMinutes(30));
        String genA = iso(day0.plusHours(2).plusMinutes(45));
        String genB = iso(day0.plusHours(3).plusMinutes(20));
        exec("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES ('" + site + "', '"
                + tenant + "', 'PR5 Tages-Splice', 'DE-LU') ON CONFLICT DO NOTHING");
        try {
            exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                    + "battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, "
                    + "baseline_cost_eur, peak_target_kw, terminal_value_eur_per_kwh, fallback_14a) VALUES "
                    // Yesterday 23:30 - owns the early morning of today.
                    + spliceRow(iso(day0), genZ, planZ, site, tenant, device, 9.0, 0.01, 0.03) + ", "
                    + spliceRow(iso(day0.plusHours(3)), genZ, planZ, site, tenant, device, 7.0, 0.01, 0.03) + ", "
                    // 02:45 run.
                    + spliceRow(iso(day0.plusHours(3)), genA, planA, site, tenant, device, 1.0, 0.02, 0.10) + ", "
                    + spliceRow(iso(day0.plusHours(3).plusMinutes(15)), genA, planA, site, tenant, device, 2.0, 0.02, 0.10) + ", "
                    + spliceRow(iso(day0.plusHours(3).plusMinutes(30)), genA, planA, site, tenant, device, 3.0, 0.02, 0.10) + ", "
                    // 03:20 re-plan.
                    + spliceRow(iso(day0.plusHours(3).plusMinutes(15)), genB, planB, site, tenant, device, 20.0, 0.05, 0.20) + ", "
                    + spliceRow(iso(day0.plusHours(3).plusMinutes(30)), genB, planB, site, tenant, device, 30.0, 0.05, 0.20) + ", "
                    + spliceRow(iso(day0.plusHours(3).plusMinutes(45)), genB, planB, site, tenant, device, 40.0, 0.05, 0.20) + ", "
                    + spliceRow(iso(day0.plusDays(1).plusHours(3)), genB, planB, site, tenant, device, 50.0, 0.05, 0.20)
                    + " ON CONFLICT DO NOTHING");

            ResponseEntity<Map<String, Object>> day = rest.exchange(
                    url("/api/v1/sites/" + site + "/schedule?mode=day"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo", "demo"))),
                    new ParameterizedTypeReference<>() {});
            assertThat(day.getStatusCode()).isEqualTo(HttpStatus.OK);
            List<?> slots = (List<?>) day.getBody().get("slots");
            // 00:00 (Z) · 03:00 (A beats Z) · 03:15 (A, NOT the 03:20 re-plan)
            // · 03:30 (B) · 03:45 (B) · tomorrow 03:00 (B).
            assertThat(slots).hasSize(6);
            assertThat(slots.stream()
                    .map(s -> ((Number) ((Map<?, ?>) s).get("batteryKw")).doubleValue()).toList())
                    .containsExactly(9.0, 1.0, 2.0, 30.0, 40.0, 50.0);
            assertThat(Instant.parse((String) ((Map<?, ?>) slots.get(0)).get("start")))
                    .isEqualTo(day0.toInstant());
            assertThat(Instant.parse((String) ((Map<?, ?>) slots.get(5)).get("start")))
                    .isEqualTo(day0.plusDays(1).plusHours(3).toInstant());
            // savingsEur sums the SPLICED slots: 0.02 + 4x0.08 ... per run above.
            assertThat(((Number) day.getBody().get("savingsEur")).doubleValue())
                    .isCloseTo(0.02 + 0.08 + 0.08 + 0.15 + 0.15 + 0.15, within(1e-9));
            // Run-level facts describe ONE run, so a spliced day carries none of
            // them - never a value borrowed from an arbitrary contributing run.
            assertThat(day.getBody().get("planId")).isNull();
            assertThat(day.getBody().get("bankedValueEur")).isNull();
            assertThat(day.getBody().get("socStartPct")).isNull();
            assertThat(day.getBody().get("socEndPct")).isNull();
            assertThat(day.getBody().get("peakTargetKw")).isNull();
            assertThat(day.getBody().get("fallback14a")).isNull();
            // ...but generatedAt/deviceId name the NEWEST contributing run.
            assertThat(Instant.parse((String) day.getBody().get("generatedAt")))
                    .isEqualTo(Instant.parse(genB));
            assertThat(day.getBody()).containsEntry("deviceId", device);
            // The recomposed decision price runs on the spliced slots too, so a
            // PAST phase explains itself with the price the optimizer used.
            assertThat(((Map<?, ?>) slots.get(0)).get("importPriceSource")).isEqualTo("spot");

            // The default reading is UNCHANGED: the newest run only.
            ResponseEntity<Map<String, Object>> latest = rest.exchange(
                    url("/api/v1/sites/" + site + "/schedule"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo", "demo"))),
                    new ParameterizedTypeReference<>() {});
            assertThat(latest.getBody()).containsEntry("planId", planB);
            assertThat(((List<?>) latest.getBody().get("slots")).stream()
                    .map(s -> ((Number) ((Map<?, ?>) s).get("batteryKw")).doubleValue()).toList())
                    .containsExactly(20.0, 30.0, 40.0, 50.0);

            // A day whose runs only start at 02:45 begins HONESTLY at 03:00 -
            // the uncovered early morning is absent, never invented.
            exec("DELETE FROM schedule WHERE plan_id = '" + planZ + "'");
            ResponseEntity<Map<String, Object>> late = rest.exchange(
                    url("/api/v1/sites/" + site + "/schedule?mode=day"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo", "demo"))),
                    new ParameterizedTypeReference<>() {});
            List<?> lateSlots = (List<?>) late.getBody().get("slots");
            assertThat(lateSlots).hasSize(5);
            assertThat(Instant.parse((String) ((Map<?, ?>) lateSlots.get(0)).get("start")))
                    .isEqualTo(day0.plusHours(3).toInstant());

            // An unknown mode is a 400 - never a silent fallback to the other
            // reading (the two answer different questions).
            assertThat(rest.exchange(url("/api/v1/sites/" + site + "/schedule?mode=tag"),
                    HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

            // RLS fences the new mode exactly like the old one.
            assertThat(rest.exchange(url("/api/v1/sites/" + site + "/schedule?mode=day"),
                    HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            exec("DELETE FROM schedule WHERE site_id = '" + site + "'");
            exec("DELETE FROM site WHERE id = '" + site + "'");
        }
    }

    /**
     * Herzogau 29.08.2026: a run is stamped MICROSECONDS after the boundary it
     * plans for, and a strict {@code generated_at <= time} therefore excluded
     * EVERY run from its OWN first slot - so the Film des Tages showed the
     * PREVIOUS run for the slot in progress. On that day it read "JETZT · Sonne
     * speichern · läuft" over a slot the same plant had been commanded to
     * DISCHARGE in. It hit every slot of every plant and only became visible
     * when two consecutive runs disagreed sharply.
     *
     * <p>The two halves are asserted together, because the tolerance is only
     * correct if it stays narrow: the microsecond-late run must WIN its own
     * slot, and a run a MINUTE late must still LOSE it - a re-plan landing
     * inside a quarter hour does not rewrite how that quarter hour was planned.
     *
     * <p>Own site + cleanup, like its sibling above: a stray site with a plan
     * would move the hand-computed fleet/earnings numbers of the other tests.
     */
    @Test
    void scheduleDayModeGivesARunItsOwnSlotDespiteTheMicrosecondItIsStampedLate() {
        final String site = "0000000a-0000-0000-0000-0000000000f8";
        final String device = "0000000a-0000-0000-0000-0000000000e8";
        final String tenant = "00000000-0000-0000-0000-000000000001";
        final String planOld = "aaaaaaaa-0000-0000-0000-0000000000f8";
        final String planNow = "aaaaaaaa-0000-0000-0000-0000000000f9";
        final String planLate = "aaaaaaaa-0000-0000-0000-0000000000fa";
        ZoneId berlin = ZoneId.of("Europe/Berlin");
        ZonedDateTime day0 = LocalDate.now(berlin).atStartOfDay(berlin);
        ZonedDateTime slot = day0.plusHours(4);
        // The incident's own stamp: 867 microseconds after the slot boundary.
        String genNow = slot.toInstant().plusNanos(867_000).toString();
        exec("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES ('" + site + "', '"
                + tenant + "', 'Fix C Stempel-Toleranz', 'DE-LU') ON CONFLICT DO NOTHING");
        try {
            exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                    + "battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, "
                    + "baseline_cost_eur, peak_target_kw, terminal_value_eur_per_kwh, fallback_14a) VALUES "
                    // The PREVIOUS run, comfortably before the boundary.
                    + spliceRow(iso(slot), iso(slot.minusMinutes(15)), planOld, site, tenant,
                            device, -7.17, 0.01, 0.03) + ", "
                    // The run OF this slot - stamped 867 us late.
                    + spliceRow(iso(slot), genNow, planNow, site, tenant, device,
                            17.07, 0.01, 0.03)
                    + " ON CONFLICT DO NOTHING");

            List<?> slots = (List<?>) rest.exchange(
                    url("/api/v1/sites/" + site + "/schedule?mode=day"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo", "demo"))),
                    new ParameterizedTypeReference<Map<String, Object>>() {})
                    .getBody().get("slots");
            assertThat(slots).hasSize(1);
            // Its OWN run, not the one before it.
            assertThat(((Number) ((Map<?, ?>) slots.get(0)).get("batteryKw")).doubleValue())
                    .isEqualTo(17.07);

            // ...and the tolerance stays narrow: a run a MINUTE into the slot is
            // a mid-slot re-plan and must not become "how it was planned".
            exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                    + "battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, "
                    + "baseline_cost_eur, peak_target_kw, terminal_value_eur_per_kwh, fallback_14a) VALUES "
                    + spliceRow(iso(slot), iso(slot.plusMinutes(1)), planLate, site, tenant,
                            device, 99.0, 0.01, 0.03)
                    + " ON CONFLICT DO NOTHING");
            List<?> after = (List<?>) rest.exchange(
                    url("/api/v1/sites/" + site + "/schedule?mode=day"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo", "demo"))),
                    new ParameterizedTypeReference<Map<String, Object>>() {})
                    .getBody().get("slots");
            assertThat(((Number) ((Map<?, ?>) after.get(0)).get("batteryKw")).doubleValue())
                    .isEqualTo(17.07);
        } finally {
            exec("DELETE FROM schedule WHERE site_id = '" + site + "'");
            exec("DELETE FROM site WHERE id = '" + site + "'");
        }
    }

    /** One schedule row of the Tages-Splice fixture. */
    private static String spliceRow(String time, String generatedAt, String planId, String site,
            String tenant, String device, double batteryKw, double costEur, double baselineEur) {
        return "('" + time + "'::timestamptz, '" + tenant + "', '" + site + "', '" + device + "', '"
                + planId + "', '" + generatedAt + "'::timestamptz, " + batteryKw
                + ", 0, 50.0, 3.0, 2.0, 100.0, " + costEur + ", " + baselineEur
                + ", 180.0, 0.18, FALSE)";
    }

    private static String iso(ZonedDateTime at) {
        return at.toInstant().toString();
    }

    /**
     * P3 "Ist-Last sichtbar" (report vp-netzbezug-nacht-s3 §6) AND its Ist-PV
     * mirror: the plan carries the MEASURED house consumption and the MEASURED
     * PV production of every slot that already happened - the quarter-hour MEANs
     * of {@code telemetry.load_kw} / {@code telemetry.pv_power_kw}, the same
     * quantities {@code loadKw} / {@code pvKw} forecast - so the portal can draw
     * the forecast error that made this plant draw from the grid at night, and
     * the solar-charging rule ("Laden &lt;= gemessene PV") becomes checkable.
     *
     * <p>Runs on its OWN site and cleans up after itself: a stray site with a
     * plan + telemetry would move the hand-computed fleet/earnings numbers of
     * the other tests on tenant A.
     */
    @Test
    void scheduleCarriesTheMeasuredLoadAndPvOfSlotsThatAlreadyHappened() {
        final String site = "0000000a-0000-0000-0000-0000000000f3";
        final String device = "0000000a-0000-0000-0000-0000000000e3";
        final String tenant = "00000000-0000-0000-0000-000000000001";
        exec("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES ('" + site + "', '"
                + tenant + "', 'P3 Ist-Last', 'DE-LU') ON CONFLICT DO NOTHING");
        try {
            // Four 15-min slots anchored on the RUNNING quarter hour: two are
            // over, one is running, one is still ahead.
            //   q-2 : two samples, LOAD only -> mean 3.0 kW, PV stays null
            //         (a device that reports no PV channel at all)
            //   q-1 : no telemetry                 (both must stay null)
            //   q   : running, one sample 7.117 kW load + 15.3 kW PV
            //         (the Pilsting constellation)
            //   q+1 : future                       (both must stay null)
            String q = "time_bucket('15 minutes', now())";
            exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                    + "battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, "
                    + "baseline_cost_eur) VALUES "
                    + slotRow(q + " - interval '30 minutes'", site, tenant, device)
                    + ", " + slotRow(q + " - interval '15 minutes'", site, tenant, device)
                    + ", " + slotRow(q, site, tenant, device)
                    + ", " + slotRow(q + " + interval '15 minutes'", site, tenant, device)
                    + " ON CONFLICT DO NOTHING");
            exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, load_kw, pv_power_kw) "
                    + "VALUES "
                    + "(" + q + " - interval '30 minutes', '" + tenant + "', '" + site + "', '"
                    + device + "', 2.0, NULL), "
                    + "(" + q + " - interval '25 minutes', '" + tenant + "', '" + site + "', '"
                    + device + "', 4.0, NULL), "
                    + "(" + q + ", '" + tenant + "', '" + site + "', '" + device
                    + "', 7.117, 15.3)");

            ResponseEntity<Map<String, Object>> res = rest.exchange(
                    url("/api/v1/sites/" + site + "/schedule"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo", "demo"))),
                    new ParameterizedTypeReference<>() {});
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
            List<?> slots = (List<?>) res.getBody().get("slots");
            assertThat(slots).hasSize(4);
            List<Double> measured = slots.stream()
                    .map(s -> ((Map<?, ?>) s).get("measuredLoadKw"))
                    .map(v -> v == null ? null : ((Number) v).doubleValue())
                    .toList();
            // The completed slot is the MEAN of its samples (not the last one -
            // the P2 quarter-hour semantics), the sample-less slot stays null
            // (never a fabricated 0), the RUNNING slot carries what has been
            // measured so far, and the future slot can never carry a value.
            assertThat(measured.get(0)).isEqualTo(3.0);
            assertThat(measured.get(1)).isNull();
            assertThat(measured.get(2)).isEqualTo(7.117);
            assertThat(measured.get(3)).isNull();
            // The PV mirror rides the SAME window/aggregation but is independent
            // per channel: the load-only slot carries NO measured PV (never a
            // fabricated 0 claiming the sun did not shine), the running slot
            // carries both, future/sample-less slots neither.
            List<Double> measuredPv = slots.stream()
                    .map(s -> ((Map<?, ?>) s).get("measuredPvKw"))
                    .map(v -> v == null ? null : ((Number) v).doubleValue())
                    .toList();
            assertThat(measuredPv.get(0)).isNull();
            assertThat(measuredPv.get(1)).isNull();
            assertThat(measuredPv.get(2)).isEqualTo(15.3);
            assertThat(measuredPv.get(3)).isNull();
            // The forecast inputs are untouched next to them - the gap between
            // plan and measurement IS what these lines make visible.
            assertThat(((Number) ((Map<?, ?>) slots.get(2)).get("loadKw")).doubleValue())
                    .isEqualTo(4.33);
            assertThat(((Number) ((Map<?, ?>) slots.get(2)).get("pvKw")).doubleValue())
                    .isEqualTo(12.0);

            // RLS: the measured load is read through the tenant-scoped app role,
            // so another tenant cannot reach it at all.
            assertThat(rest.exchange(url("/api/v1/sites/" + site + "/schedule"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            exec("DELETE FROM telemetry WHERE site_id = '" + site + "'");
            exec("DELETE FROM schedule WHERE site_id = '" + site + "'");
            exec("DELETE FROM site WHERE id = '" + site + "'");
        }
    }

    /**
     * One schedule row of the P3 fixture (load forecast 4.33 kW like Pilsting,
     * PV forecast 12 kW against a measured 15,3 kW - the PV forecast error the
     * Ist-PV line makes visible).
     */
    private static String slotRow(String timeExpr, String site, String tenant, String device) {
        return "(" + timeExpr + ", '" + tenant + "', '" + site + "', '" + device + "', "
                + "'aaaaaaaa-0000-0000-0000-0000000000f3'"
                + ", now(), -4.332, 2.8, 77.0, 4.33, 12.0, 212.0, 0.0, 0.0)";
    }

    // ---- Prognosequalität: model states + accuracy series, RLS-scoped ---------

    /**
     * Shadow-mode forecasting read path: the collector/evaluator write model
     * states and daily accuracy rows as the trusted backend role; the endpoint
     * serves them tenant-scoped with the ACTIVE model resolved from config
     * (defaults = the baselines), and a foreign site stays a 404.
     */
    @Test
    void forecastQualityIsTenantScopedAndMarksTheActiveModel() {
        String t = "'00000000-0000-0000-0000-000000000001'";
        // The baseline is live; the challenger is still collecting (day 5 of 21).
        exec("INSERT INTO forecast_model_state (tenant_id, site_id, model, kind, status, "
                + "days_collected, days_required, trained_at, train_rows, feature_importance, updated_at) VALUES "
                + "(" + t + ", '" + BERLIN_SITE + "', 'load-persistence', 'load', 'ready', "
                + "NULL, NULL, NULL, NULL, '[]'::jsonb, now()), "
                + "(" + t + ", '" + BERLIN_SITE + "', 'load-xgb', 'load', 'collecting', "
                + "5, 21, NULL, NULL, '[]'::jsonb, now()), "
                + "(" + t + ", '" + BERLIN_SITE + "', 'pv-residual-xgb', 'pv', 'ready', "
                + "30, 21, now(), 2880, "
                + "'[{\"feature\": \"physical_kw\", \"label\": \"Physikalische PV-Prognose\", \"weight\": 0.62}]'::jsonb, now()) "
                + "ON CONFLICT (site_id, model) DO NOTHING");
        exec("INSERT INTO forecast_accuracy (day, tenant_id, site_id, model, kind, "
                + "mae_kw, nmae_pct, bias_kw, skill_vs_baseline, n_slots) VALUES "
                + "(current_date - 1, " + t + ", '" + BERLIN_SITE + "', 'load-persistence', 'load', "
                + "0.8, 40.0, 0.1, NULL, 96), "
                + "(current_date - 1, " + t + ", '" + BERLIN_SITE + "', 'load-xgb', 'load', "
                + "0.4, 20.0, -0.05, 0.5, 96) "
                + "ON CONFLICT (site_id, model, day) DO NOTHING");
        exec("INSERT INTO plan_accuracy (day, tenant_id, site_id, planned_cost_eur, "
                + "baseline_cost_eur, realized_cost_eur, n_slots) VALUES "
                + "(current_date - 1, " + t + ", '" + BERLIN_SITE + "', 1.20, 1.50, 1.25, 96) "
                + "ON CONFLICT (site_id, day) DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/forecast-quality"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        // Active models come from config (defaults = the baselines).
        assertThat(body).containsEntry("activeLoadModel", "load-persistence");
        assertThat(body).containsEntry("activePvModel", "pv-physical");

        List<Map<String, Object>> models = list(body, "models");
        assertThat(models).extracting(m -> m.get("model"))
                .contains("load-persistence", "load-xgb", "pv-residual-xgb");
        Map<String, Object> baseline = models.stream()
                .filter(m -> "load-persistence".equals(m.get("model"))).findFirst().orElseThrow();
        assertThat(baseline).containsEntry("active", true).containsEntry("status", "ready");
        Map<String, Object> collecting = models.stream()
                .filter(m -> "load-xgb".equals(m.get("model"))).findFirst().orElseThrow();
        assertThat(collecting).containsEntry("active", false)
                .containsEntry("status", "collecting")
                .containsEntry("daysCollected", 5)
                .containsEntry("daysRequired", 21);
        Map<String, Object> trained = models.stream()
                .filter(m -> "pv-residual-xgb".equals(m.get("model"))).findFirst().orElseThrow();
        assertThat(trained).containsEntry("trainRows", 2880);
        List<Map<String, Object>> importance = list(trained, "featureImportance");
        assertThat(importance).hasSize(1);
        assertThat(importance.get(0)).containsEntry("label", "Physikalische PV-Prognose");

        List<Map<String, Object>> accuracy = list(body, "accuracy");
        Map<String, Object> challengerDay = accuracy.stream()
                .filter(a -> "load-xgb".equals(a.get("model"))).findFirst().orElseThrow();
        assertThat(num(challengerDay, "maeKw")).isEqualTo(0.4);
        assertThat(num(challengerDay, "skillVsBaseline")).isEqualTo(0.5);
        Map<String, Object> baselineDay = accuracy.stream()
                .filter(a -> "load-persistence".equals(a.get("model"))).findFirst().orElseThrow();
        assertThat(baselineDay.get("skillVsBaseline")).isNull();

        List<Map<String, Object>> plan = list(body, "planAccuracy");
        assertThat(plan).hasSize(1);
        assertThat(num(plan.get(0), "plannedCostEur")).isEqualTo(1.2);
        assertThat(num(plan.get(0), "realizedCostEur")).isEqualTo(1.25);

        // Tenant B's own (empty) site: well-formed empty lists, active models set.
        ResponseEntity<Map<String, Object>> empty = rest.exchange(
                url("/api/v1/sites/" + HAMBURG_SITE + "/forecast-quality"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(empty.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<?>) empty.getBody().get("models")).isEmpty();
        assertThat((List<?>) empty.getBody().get("accuracy")).isEmpty();

        // RLS: tenant B cannot even see tenant A's site -> 404, nothing leaks.
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/forecast-quality"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * Der Prognose-Schalter JE ANLAGE (Captain-Auftrag 19.08.2026, er revidiert
     * die plattformweite Semantik des Vortages): der KUNDE stellt seine eigene
     * Anlage um, ab dem nächsten Planungslauf plant NUR sie mit dem Kandidaten,
     * und der Rückweg ist derselbe Aufruf in die Gegenrichtung.
     *
     * <p>Der Zaun ist Teil desselben Tests, weil er die eigentliche
     * Sicherheits-Aussage ist: eine FREMDE Anlage ist 404 (RLS, nie 403), und
     * jede Sperre der Oberfläche wird hier SERVER-seitig ein zweites Mal
     * geprüft - dem Client zu glauben wäre keine Prüfung.
     *
     * <p>Zwei EIGENE Anlagen, damit die Fixtures der Nachbar-Tests unberührt
     * bleiben; beide werden am Ende wieder abgeräumt.
     */
    @Test
    void theForecastModelSwitchIsPerPlantCustomerOwnedAndGuardedByEvidence() {
        String demo = token("demo", "demo");
        String tenantA = "'00000000-0000-0000-0000-000000000001'";
        String eigene = createSite(demo, "Prognose Werk Eigen", "DE-LU", "eigenverbrauch");
        String nachbar = createSite(demo, "Prognose Werk Nachbar", "DE-LU", "eigenverbrauch");
        try {
            // Beide Anlagen tragen denselben Modell-Bestand: eine rechnende
            // Kandidatin (load-xgb) und eine, die noch SAMMELT (pv-residual-xgb).
            for (String site : List.of(eigene, nachbar)) {
                exec("INSERT INTO forecast_model_state (tenant_id, site_id, model, kind, status,"
                        + " days_collected, days_required, feature_importance, updated_at) VALUES "
                        + "(" + tenantA + ", '" + site + "', 'load-persistence', 'load', 'ready',"
                        + " NULL, NULL, '[]'::jsonb, now()), "
                        + "(" + tenantA + ", '" + site + "', 'load-xgb', 'load', 'ready',"
                        + " NULL, NULL, '[]'::jsonb, now()), "
                        + "(" + tenantA + ", '" + site + "', 'pv-residual-xgb', 'pv', 'collecting',"
                        + " 14, 21, '[]'::jsonb, now())");
                exec("INSERT INTO forecast_accuracy (day, tenant_id, site_id, model, kind,"
                        + " mae_kw, nmae_pct, bias_kw, skill_vs_baseline, n_slots) VALUES "
                        + "(current_date - 1, " + tenantA + ", '" + site + "',"
                        + " 'load-persistence', 'load', 0.8, 40.0, 0.1, NULL, 96), "
                        + "(current_date - 1, " + tenantA + ", '" + site + "',"
                        + " 'load-xgb', 'load', 0.4, 20.0, -0.05, 0.5, 96)");
            }

            // (1) Vor jeder Umstellung folgt die Anlage der VORGABE, und die
            //     Fläche SAGT das - „env", nie „anlage".
            Map<String, Object> before = siteForecastModels(demo, eigene);
            assertThat(before).containsEntry("siteId", eigene);
            Map<String, Object> load = kindOfSite(before, "load");
            assertThat(load).containsEntry("activeModel", "load-persistence")
                    .containsEntry("source", "env")
                    .containsEntry("platformDefault", "load-persistence")
                    .containsEntry("envDefault", "load-persistence")
                    .containsEntry("setByName", null)
                    .containsEntry("setAt", null);
            assertThat(load.get("selectable")).isEqualTo(List.of("load-persistence", "load-xgb"));
            assertThat((List<?>) before.get("history")).isEmpty();

            // (2) Der Klick des KUNDEN - kein Admin nötig, kein 403.
            Map<String, Object> after = promoteSiteModel(demo, eigene, "load", "load-xgb");
            Map<String, Object> promoted = kindOfSite(after, "load");
            assertThat(promoted).containsEntry("activeModel", "load-xgb")
                    .containsEntry("source", "anlage")
                    .containsEntry("platformDefault", "load-persistence")
                    .containsEntry("setByName", "demo");
            assertThat(promoted.get("setAt")).isNotNull();
            // Die ANDERE Prognoseart bleibt unberührt - ein Schalter je Art.
            assertThat(kindOfSite(after, "pv")).containsEntry("activeModel", "pv-physical")
                    .containsEntry("source", "env");

            // (3) Die Papier-Spur JE ANLAGE: von->zu, wer, wann.
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> history = (List<Map<String, Object>>) after.get("history");
            assertThat(history).hasSize(1);
            assertThat(history.get(0)).containsEntry("kind", "load")
                    .containsEntry("model", "load-xgb")
                    .containsEntry("previousModel", "load-persistence")
                    .containsEntry("setByName", "demo");
            assertThat(queryLong("SELECT count(*) FROM site_forecast_model_choice"
                    + " WHERE site_id = '" + eigene + "' AND set_by <> 'demo'")).isEqualTo(1);

            // (4) DAS Abnahmekriterium: nur DIESE Anlage plant mit dem Kandidaten.
            assertThat(forecastQualityOf(demo, eigene))
                    .containsEntry("activeLoadModel", "load-xgb")
                    .containsEntry("activePvModel", "pv-physical");
            assertThat(forecastQualityOf(demo, nachbar))
                    .containsEntry("activeLoadModel", "load-persistence");
            assertThat(kindOfSite(siteForecastModels(demo, nachbar), "load"))
                    .containsEntry("source", "env");

            // (5) Der Rückweg ist jederzeit offen - derselbe Aufruf, andere
            //     Richtung. Er bleibt „anlage": es IST eine Entscheidung, auch
            //     wenn sie zufällig auf die Vorgabe fällt.
            Map<String, Object> reverted =
                    promoteSiteModel(demo, eigene, "load", "load-persistence");
            assertThat(kindOfSite(reverted, "load"))
                    .containsEntry("activeModel", "load-persistence")
                    .containsEntry("source", "anlage");
            assertThat((List<?>) reverted.get("history")).hasSize(2);
            assertThat(forecastQualityOf(demo, eigene))
                    .containsEntry("activeLoadModel", "load-persistence");

            // (6) Jede Ablehnung ist ein deutscher Satz UND schreibt nichts -
            //     inklusive der zwei Sperren, die die Oberfläche vor dem Klick
            //     nennt (sammelnder Kandidat, keine Tagesbewertung).
            long rows = queryLong("SELECT count(*) FROM site_forecast_model_choice");
            refuseSitePromotion(demo, eigene, "load", "pv-physical",
                    HttpStatus.BAD_REQUEST, "andere Prognoseart");
            refuseSitePromotion(demo, eigene, "load", "load_xgb",
                    HttpStatus.BAD_REQUEST, "Unbekanntes Prognosemodell");
            refuseSitePromotion(demo, eigene, "waerme", "load-xgb",
                    HttpStatus.BAD_REQUEST, "Prognoseart");
            refuseSitePromotion(demo, eigene, "load", "load-persistence",
                    HttpStatus.CONFLICT, "plant diese Anlage bereits");
            refuseSitePromotion(demo, eigene, "pv", "pv-residual-xgb",
                    HttpStatus.CONFLICT, "sammelt für diese Anlage noch Daten");
            // Ein Modell, das auf dieser Anlage noch nie bewertet wurde.
            exec("DELETE FROM forecast_accuracy WHERE site_id = '" + eigene + "'"
                    + " AND model = 'load-xgb'");
            refuseSitePromotion(demo, eigene, "load", "load-xgb",
                    HttpStatus.CONFLICT, "noch keine Tagesbewertung");
            assertThat(queryLong("SELECT count(*) FROM site_forecast_model_choice"))
                    .isEqualTo(rows);

            // (7) Der Zaun: eine FREMDE Anlage ist 404 (RLS), nie 403 - lesend
            //     wie schreibend -, und anonym ist es 401.
            String demo2 = token("demo2", "demo2");
            assertThat(rest.exchange(url("/api/v1/sites/" + eigene + "/forecast-models"),
                    HttpMethod.GET, new HttpEntity<>(bearer(demo2)), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(rest.exchange(url("/api/v1/sites/" + eigene + "/forecast-models"),
                    HttpMethod.POST,
                    new HttpEntity<>(Map.of("kind", "load", "model", "load-xgb"), bearer(demo2)),
                    String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(rest.exchange(url("/api/v1/sites/" + eigene + "/forecast-models"),
                    HttpMethod.GET, HttpEntity.EMPTY, String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
            assertThat(queryLong("SELECT count(*) FROM site_forecast_model_choice"))
                    .isEqualTo(rows);

            // (8) Eine gelöschte Anlage nimmt ihr Journal MIT - obwohl die
            //     App-Rolle auf dieser Tabelle gar kein DELETE hat. Das trägt
            //     der FK-Kaskaden-Pfad: eine referenzielle Aktion läuft als
            //     Eigentümer der Tabelle und umgeht Rechte UND FORCE-RLS.
            //     Ohne diesen Beweis wäre das Löschen einer Anlage ein
            //     „permission denied for table" auf einem Kunden-Pfad.
            assertThat(queryLong("SELECT count(*) FROM site_forecast_model_choice"
                    + " WHERE site_id = '" + eigene + "'")).isEqualTo(2);
            assertThat(rest.exchange(url("/api/v1/sites/" + eigene), HttpMethod.DELETE,
                    new HttpEntity<>(bearer(demo)), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
            assertThat(queryLong("SELECT count(*) FROM site_forecast_model_choice"
                    + " WHERE site_id = '" + eigene + "'")).isZero();
        } finally {
            for (String site : List.of(eigene, nachbar)) {
                exec("DELETE FROM site_forecast_model_choice WHERE site_id = '" + site + "'");
                exec("DELETE FROM forecast_accuracy WHERE site_id = '" + site + "'");
                exec("DELETE FROM forecast_model_state WHERE site_id = '" + site + "'");
                exec("DELETE FROM site WHERE id = '" + site + "'");
            }
        }
    }

    private Map<String, Object> siteForecastModels(String token, String siteId) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/forecast-models"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private Map<String, Object> promoteSiteModel(
            String token, String siteId, String kind, String model) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/forecast-models"), HttpMethod.POST,
                new HttpEntity<>(Map.of("kind", kind, "model", model), bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private void refuseSitePromotion(String token, String siteId, String kind, String model,
            HttpStatus status, String needle) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/forecast-models"), HttpMethod.POST,
                new HttpEntity<>(Map.of("kind", kind, "model", model), bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(status);
        assertThat(String.valueOf(res.getBody().get("message"))).contains(needle);
    }

    private Map<String, Object> forecastQualityOf(String token, String siteId) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/forecast-quality"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> kindOfSite(Map<String, Object> body, String kind) {
        return ((List<Map<String, Object>>) body.get("kinds")).stream()
                .filter(k -> kind.equals(k.get("kind"))).findFirst().orElseThrow();
    }

    // ---- Historie: rollups, totals, formulas, Tagesprotokoll, plan-vs-actual --

    /**
     * Deterministic seed on a fixed PAST day (2026-06-15, CEST) so the dev
     * seed's now()-relative demo telemetry never interferes:
     *
     * <p>Bucket 10:00Z (12:00 Berlin), 3 samples: load 4 kW, pv 1 kW, grid +2 kW
     * (import; battery = 2-4+1 = -1 kW discharging) -> load 1.0 kWh, pv 0.25,
     * import 0.5, discharge 0.25, priced 100 EUR/MWh -> cost 0.05 EUR.
     *
     * <p>Bucket 11:00Z, 3 samples: load 1 kW, pv 4 kW, grid -2 kW (export;
     * battery = -2-1+4 = +1 kW charging) -> load 0.25 kWh, pv 1.0, export 0.5,
     * charge 0.25, priced 200 EUR/MWh.
     *
     * <p>Totals: consumption 1.25, pv 1.25, import 0.5, export 0.5, cost 0.05;
     * Autarkiegrad = (1 - 0.5/1.25)*100 = 60 %; Eigenverbrauchsquote =
     * (1.25-0.5)/1.25*100 = 60 %. Two overlapping optimizer runs cover the
     * 10:00Z slot; only the latest counts: savings 0.10-0.06 = 0.04 EUR.
     */
    private void seedHistoryDay() {
        String t = "'00000000-0000-0000-0000-000000000001'";
        String d = "'00000000-0000-0000-0000-000000000003'";
        StringBuilder rows = new StringBuilder();
        for (int m : new int[] {0, 5, 10}) {
            rows.append(String.format(
                    "('2026-06-15T10:%02d:00Z', %s, '%s', %s, 2.0, 50.0, 1.0, 4.0),",
                    m, t, BERLIN_SITE, d));
            rows.append(String.format(
                    "('2026-06-15T11:%02d:00Z', %s, '%s', %s, -2.0, 60.0, 4.0, 1.0),",
                    m, t, BERLIN_SITE, d));
        }
        rows.setLength(rows.length() - 1);
        // DO NOTHING: two tests share this seed and the unique index on
        // (device_id, time) - migration V20260712000000 - refuses the literal
        // re-insert; the values are identical, so skipping is correct.
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, load_kw) "
                + "VALUES " + rows + " ON CONFLICT DO NOTHING");
        // DO UPDATE, not DO NOTHING: the dev earnings seed (V20260706030000)
        // rolls a 32-day DE-LU price window that can cover this fixed date -
        // the test's hand-computed expectations must own these two slots.
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "('2026-06-15T10:00:00Z', 'DE-LU', 'PT15M', 100.0, 'EUR', 'energy-charts'), "
                + "('2026-06-15T11:00:00Z', 'DE-LU', 'PT15M', 200.0, 'EUR', 'energy-charts') "
                + "ON CONFLICT (bidding_zone, resolution, ts) DO UPDATE SET price_eur_mwh = EXCLUDED.price_eur_mwh");
        // Two MPC runs plan the 10:00Z slot; the later one supersedes the earlier.
        exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                + "battery_kw, grid_kw, soc_pct, price_eur_mwh, cost_eur, baseline_cost_eur) VALUES "
                + "('2026-06-15T10:00:00Z', " + t + ", '" + BERLIN_SITE + "', " + d + ", "
                + "'bbbbbbbb-0000-0000-0000-000000000001', '2026-06-15T09:00:00Z', "
                + "-1.0, 2.5, 52.0, 100.0, 0.08, 0.10), "
                + "('2026-06-15T10:00:00Z', " + t + ", '" + BERLIN_SITE + "', " + d + ", "
                + "'bbbbbbbb-0000-0000-0000-000000000002', '2026-06-15T09:30:00Z', "
                + "-1.5, 2.0, 51.0, 100.0, 0.06, 0.10) "
                + "ON CONFLICT DO NOTHING");
    }

    @Test
    void historyDayComputesTotalsProtocolAndPlanOverlay() {
        seedHistoryDay();

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=day&at=2026-06-15"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        assertThat(body).containsEntry("range", "day").containsEntry("bucketMinutes", 15);
        // Berlin-local day window (CEST in June).
        assertThat(body).containsEntry("from", "2026-06-14T22:00:00Z");
        assertThat(body).containsEntry("to", "2026-06-15T22:00:00Z");

        // Exactly the two seeded 15-min buckets, with price + per-bucket cost.
        List<Map<String, Object>> buckets = list(body, "buckets");
        assertThat(buckets).hasSize(2);
        Map<String, Object> b0 = buckets.get(0);
        assertThat(b0).containsEntry("start", "2026-06-15T10:00:00Z");
        assertThat(num(b0, "loadKwh")).isEqualTo(1.0);
        assertThat(num(b0, "pvKwh")).isEqualTo(0.25);
        assertThat(num(b0, "gridImportKwh")).isEqualTo(0.5);
        assertThat(num(b0, "batteryDischargeKwh")).isEqualTo(0.25);
        assertThat(num(b0, "priceEurMwh")).isEqualTo(100.0);
        assertThat(num(b0, "costEur")).isEqualTo(0.05);
        assertThat(num(buckets.get(1), "gridExportKwh")).isEqualTo(0.5);
        assertThat(num(buckets.get(1), "batteryChargeKwh")).isEqualTo(0.25);

        // Period totals + the documented formulas.
        Map<String, Object> totals = map(body, "totals");
        assertThat(num(totals, "consumptionKwh")).isEqualTo(1.25);
        assertThat(num(totals, "pvGenerationKwh")).isEqualTo(1.25);
        assertThat(num(totals, "gridImportKwh")).isEqualTo(0.5);
        assertThat(num(totals, "gridExportKwh")).isEqualTo(0.5);
        assertThat(num(totals, "gridCostEur")).isEqualTo(0.05);
        assertThat(num(totals, "autarkiePct")).isEqualTo(60.0);
        assertThat(num(totals, "eigenverbrauchPct")).isEqualTo(60.0);
        // Battery savings from the LATEST run of the overlapping plans only.
        assertThat(num(totals, "batterySavingsEur")).isEqualTo(0.04);

        // Tagesprotokoll: discharge (with avoided cost), charge, PV peak, extremes.
        List<Map<String, Object>> protocol = list(body, "protocol");
        assertThat(protocol).extracting(e -> e.get("type"))
                .contains("batterie-entladen", "batterie-laden", "pv-spitze",
                        "preis-tief", "preis-hoch");
        Map<String, Object> discharge = protocol.stream()
                .filter(e -> "batterie-entladen".equals(e.get("type"))).findFirst().orElseThrow();
        assertThat(num(discharge, "avoidedCostEur")).isEqualTo(0.025);
        assertThat((String) discharge.get("text")).contains("vermieden");
        Map<String, Object> peak = protocol.stream()
                .filter(e -> "pv-spitze".equals(e.get("type"))).findFirst().orElseThrow();
        assertThat(num(peak, "peakKw")).isEqualTo(4.0);

        // Plan-vs-actual overlay: the latest run's trajectory for the day.
        List<Map<String, Object>> plan = list(body, "plan");
        assertThat(plan).hasSize(1);
        assertThat(num(plan.get(0), "batteryKw")).isEqualTo(-1.5);

        // RLS: tenant B cannot even see the site -> 404, no history leaks.
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=day&at=2026-06-15"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // Garbage range -> 400.
        ResponseEntity<String> bad = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=decade"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))), String.class);
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    void historyWeekAggregatesFromTheRollupTables() {
        seedHistoryDay();
        // The rollup job runs every 15 min in production; the test triggers the
        // same refresh procedure directly (as the superuser, like the job owner).
        exec("CALL refresh_telemetry_rollups('2026-06-01T00:00:00Z')");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=week&at=2026-06-17"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        assertThat(body).containsEntry("range", "week").containsEntry("bucketMinutes", 60);
        // ISO week of Wed 2026-06-17 starts Monday 2026-06-15 (Berlin midnight).
        assertThat(body).containsEntry("from", "2026-06-14T22:00:00Z");

        // Two hourly buckets from telemetry_rollup_1h, costs merged from the
        // 15-min rollup x price join.
        List<Map<String, Object>> buckets = list(body, "buckets");
        assertThat(buckets).hasSize(2);
        assertThat(buckets.get(0)).containsEntry("start", "2026-06-15T10:00:00Z");
        assertThat(num(buckets.get(0), "loadKwh")).isEqualTo(1.0);
        assertThat(num(buckets.get(0), "costEur")).isEqualTo(0.05);

        // Same totals as the day view - the week contains only that day.
        Map<String, Object> totals = map(body, "totals");
        assertThat(num(totals, "consumptionKwh")).isEqualTo(1.25);
        assertThat(num(totals, "gridCostEur")).isEqualTo(0.05);
        assertThat(num(totals, "autarkiePct")).isEqualTo(60.0);
        assertThat(num(totals, "batterySavingsEur")).isEqualTo(0.04);

        // No Tagesprotokoll / plan outside the day range.
        assertThat(list(body, "protocol")).isEmpty();
        assertThat(list(body, "plan")).isEmpty();

        // Month range serves from the daily rollup (Berlin days).
        ResponseEntity<Map<String, Object>> month = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=month&at=2026-06-17"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(month.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> monthBuckets = list(month.getBody(), "buckets");
        assertThat(monthBuckets).hasSize(1); // one Berlin day with data
        assertThat(monthBuckets.get(0)).containsEntry("start", "2026-06-14T22:00:00Z");
        assertThat(num(monthBuckets.get(0), "loadKwh")).isEqualTo(1.25);
        assertThat(num(monthBuckets.get(0), "costEur")).isEqualTo(0.05);
    }

    /**
     * F4/P7: die Historie sagt jetzt ihre Datenlage. Der behobene Befund war,
     * dass eine Lücke von einer gemessenen Null nicht unterscheidbar war - eine
     * Woche mit zwei gemessenen Viertelstunden sah aus wie eine ruhige Woche.
     */
    @Test
    void historyCarriesTheDataCoverageOfThePeriod() {
        seedHistoryDay();
        exec("CALL refresh_telemetry_rollups('2026-06-01T00:00:00Z')");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=week&at=2026-06-17"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> cov = map(res.getBody(), "coverage");
        assertThat(cov).as("coverage").isNotNull();
        assertThat(num(cov, "resolutionMinutes")).isEqualTo(15.0);

        // Der erwartete Zeitraum beginnt nie vor der ersten je gemessenen
        // Viertelstunde: eine Zeit, in der es die Anlage noch nicht gab, ist
        // nicht lückenhaft (genau dafür reist firstDataAt mit).
        Instant firstData = Instant.parse((String) cov.get("firstDataAt"));
        Instant expectedFrom = Instant.parse((String) cov.get("expectedFrom"));
        assertThat(expectedFrom).isAfterOrEqualTo(firstData);

        // Diese Woche trägt genau zwei gemessene Viertelstunden - die Antwort
        // sagt das jetzt, statt es zu verschweigen.
        assertThat(num(cov, "measuredBuckets")).isLessThan(num(cov, "expectedBuckets"));
        assertThat(num(cov, "gaps")).isGreaterThanOrEqualTo(1.0);

        // Ein FREMDER Mandant kommt hier gar nicht hin (RLS wie überall sonst).
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=week&at=2026-06-17"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))),
                String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    @SuppressWarnings("unchecked")
    void entityHistoryServesPerChannelBucketsFromV2TelemetryAndRollups() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";
        String deviceId = claimDevice(demo, "edge-ent-hist-01");

        // A v2-native wallbox entity on the demo site (seeded as the superuser
        // like every telemetry seed - the admin CRUD path is proven separately
        // in AdminApiTest).
        String entityId = "cccccccc-0000-0000-0000-000000000001";
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, control, "
                + "entity_type, capabilities, guard_config) VALUES "
                + "('" + entityId + "', '" + tenantA + "', '" + BERLIN_SITE + "', 'wallbox', 'WB', "
                + "TRUE, 'wallbox', "
                + "'{\"actuate\":[{\"command\":\"on_off\"}]}'::jsonb, "
                + "'{\"failsafe\":{\"behavior\":\"release\"}}'::jsonb)");

        // Raw v2 telemetry: two 15-min buckets of power_kw for the entity.
        exec("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                + "entity_id, channel, value) VALUES "
                + "('2026-06-15T10:00:00Z','2026-06-15T10:00:01Z','" + tenantA + "','" + BERLIN_SITE
                + "','" + deviceId + "','" + entityId + "','power_kw', 4.0), "
                + "('2026-06-15T10:07:00Z','2026-06-15T10:07:01Z','" + tenantA + "','" + BERLIN_SITE
                + "','" + deviceId + "','" + entityId + "','power_kw', 6.0), "
                + "('2026-06-15T10:20:00Z','2026-06-15T10:20:01Z','" + tenantA + "','" + BERLIN_SITE
                + "','" + deviceId + "','" + entityId + "','power_kw', 8.0)");

        // Day range = LIVE 15-min buckets straight from raw (never behind the job).
        ResponseEntity<Map<String, Object>> day = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/entities/" + entityId
                        + "/history?range=day&at=2026-06-15"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(day.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(day.getBody()).containsEntry("range", "day").containsEntry("bucketMinutes", 15);
        Map<String, Object> channels = (Map<String, Object>) day.getBody().get("channels");
        List<Map<String, Object>> power = (List<Map<String, Object>>) channels.get("power_kw");
        assertThat(power).hasSize(2); // the 10:00 and 10:15 buckets
        assertThat(power.get(0)).containsEntry("start", "2026-06-15T10:00:00Z");
        assertThat(num(power.get(0), "avg")).isEqualTo(5.0); // (4+6)/2
        assertThat(num(power.get(0), "max")).isEqualTo(6.0);
        assertThat(power.get(1)).containsEntry("start", "2026-06-15T10:15:00Z");
        assertThat(num(power.get(1), "avg")).isEqualTo(8.0);

        // Week range serves from the hourly rollup after the refresh cascade.
        exec("CALL refresh_telemetry_v2_rollups('2026-06-01T00:00:00Z')");
        ResponseEntity<Map<String, Object>> week = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/entities/" + entityId
                        + "/history?range=week&at=2026-06-17"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(week.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(week.getBody()).containsEntry("range", "week").containsEntry("bucketMinutes", 60);
        Map<String, Object> weekChannels = (Map<String, Object>) week.getBody().get("channels");
        List<Map<String, Object>> weekPower =
                (List<Map<String, Object>>) weekChannels.get("power_kw");
        assertThat(weekPower).hasSize(1); // one hour with data
        assertThat(weekPower.get(0)).containsEntry("start", "2026-06-15T10:00:00Z");
        // sample-weighted hourly avg over the three raw samples (4,6,8)/3 = 6.0.
        assertThat(num(weekPower.get(0), "avg")).isEqualTo(6.0);
        assertThat(num(weekPower.get(0), "max")).isEqualTo(8.0);
        assertThat((long) ((Number) weekPower.get(0).get("n")).longValue()).isEqualTo(3L);

        // Month range serves from the Berlin-daily rollup.
        ResponseEntity<Map<String, Object>> month = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/entities/" + entityId
                        + "/history?range=month&at=2026-06-17"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        List<Map<String, Object>> monthPower = (List<Map<String, Object>>)
                ((Map<String, Object>) month.getBody().get("channels")).get("power_kw");
        assertThat(monthPower).hasSize(1);
        assertThat(monthPower.get(0)).containsEntry("start", "2026-06-14T22:00:00Z"); // Berlin day

        // Foreign site's tenant cannot read it (RLS 404 on the entity lookup).
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/entities/" + entityId + "/history"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // Bad range = 400.
        ResponseEntity<String> bad = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/entities/" + entityId
                        + "/history?range=decade"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)), String.class);
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * <b>Audit H1 (BLOCKER) — the Messwerte explorer must not be empty after the
     * automatic v2 migration.</b> {@code telemetry_v2} is fed FORWARD only (the
     * writer's {@code ComposedEntityFanout} mirrors new live samples), so a
     * plant with years of v1 telemetry rendered "Keine Werte in diesem Zeitraum"
     * at every range on deploy day. The fix is a READ-side splice: a COMPOSED
     * entity reconstructs its pre-v2 window from the v1 telemetry through the
     * SAME channel map, spliced at the entity's first v2 sample.
     *
     * <p>Proven here: (a) the deploy-day state — a composed entity with ZERO v2
     * rows serves its full v1 history; (b) continuity — a battery-hybrid whose
     * v2 era starts mid-day yields ONE unbroken series across the seam; (c) no
     * overlap — the straddling bucket belongs to v2 alone, the v1 sample inside
     * it never double-counts; (d) the derived {@code battery_power_kw} matches
     * the fan-out's {@code power − load + pv}; (e) the rollup-backed ranges
     * bridge too.
     */
    @Test
    @SuppressWarnings("unchecked")
    void entityHistorySplicesV1TelemetryBeforeTheV2EraForComposedEntities() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String siteId = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Splice-Anlage"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        String deviceId = claimDeviceInto(demo, siteId, "edge-splice-01");

        // --- the v1 era: four raw samples on 2026-06-15 (Europe/Berlin day) ---
        // battery = power - load + pv (the documented v1 balance the fan-out uses)
        //   10:00 -> 1-2+3 = 2.0 | 10:07 -> 3-2+1 = 2.0  (bucket 10:00, avg 2.0)
        //   10:20 -> 0-1+5 = 4.0                          (bucket 10:15)
        //   11:05 -> 0-0+0 = 0.0   <- the OVERLAP DECOY: v2 owns the 11:00 bucket
        exec("INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, "
                + "power_kw, load_kw, pv_power_kw, soc_pct) VALUES "
                + "('2026-06-15T10:00:00Z','2026-06-15T10:00:01Z','" + tenantA + "','" + siteId
                + "','" + deviceId + "', 1.0, 2.0, 3.0, 50), "
                + "('2026-06-15T10:07:00Z','2026-06-15T10:07:01Z','" + tenantA + "','" + siteId
                + "','" + deviceId + "', 3.0, 2.0, 1.0, 52), "
                + "('2026-06-15T10:20:00Z','2026-06-15T10:20:01Z','" + tenantA + "','" + siteId
                + "','" + deviceId + "', 0.0, 1.0, 5.0, 60), "
                + "('2026-06-15T11:05:00Z','2026-06-15T11:05:01Z','" + tenantA + "','" + siteId
                + "','" + deviceId + "', 0.0, 0.0, 0.0, 99)");

        // --- the composed entities the migration would compose from that data ---
        String hybrid = "eeeece01-0000-0000-0000-000000000001";
        String house = "eeeece01-0000-0000-0000-000000000002";
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, control, "
                + "device_id, entity_type, capabilities, guard_config) VALUES "
                + "('" + hybrid + "','" + tenantA + "','" + siteId + "','battery-hybrid',"
                + "'Batteriespeicher', FALSE, '" + deviceId + "', 'battery-hybrid', "
                + "'{\"measure\":[{\"channel\":\"soc_pct\"}]}'::jsonb, '{}'::jsonb), "
                + "('" + house + "','" + tenantA + "','" + siteId + "','house-load',"
                + "'Hausverbrauch', FALSE, '" + deviceId + "', 'house-load', "
                + "'{\"measure\":[{\"channel\":\"power_kw\"}]}'::jsonb, '{}'::jsonb)");

        // (a) THE DEPLOY-DAY STATE: house-load has NOT ONE v2 row. Before the fix
        //     this answered {} at every range; now it serves the whole v1 window.
        Map<String, Object> houseChannels = entityDayChannels(demo, siteId, house, "2026-06-15");
        List<Map<String, Object>> housePower =
                (List<Map<String, Object>>) houseChannels.get("power_kw");
        assertThat(housePower).hasSize(3); // 10:00, 10:15, 11:00 - all from v1 load_kw
        assertThat(num(housePower.get(0), "avg")).isEqualTo(2.0);
        assertThat(num(housePower.get(1), "avg")).isEqualTo(1.0);
        assertThat(num(housePower.get(2), "avg")).isEqualTo(0.0);

        // --- the v2 era starts at 11:00 (the first fan-out sample) ---
        exec("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                + "entity_id, channel, value) VALUES "
                + "('2026-06-15T11:00:00Z','2026-06-15T11:00:01Z','" + tenantA + "','" + siteId
                + "','" + deviceId + "','" + hybrid + "','battery_power_kw', 9.0), "
                + "('2026-06-15T11:00:00Z','2026-06-15T11:00:01Z','" + tenantA + "','" + siteId
                + "','" + deviceId + "','" + hybrid + "','pv_power_kw', 8.0), "
                + "('2026-06-15T11:00:00Z','2026-06-15T11:00:01Z','" + tenantA + "','" + siteId
                + "','" + deviceId + "','" + hybrid + "','soc_pct', 70.0)");

        // (b)+(c)+(d) ONE continuous series across the seam: v1 owns the buckets
        // that START before 11:00, v2 owns the rest - no gap, no overlap.
        Map<String, Object> ch = entityDayChannels(demo, siteId, hybrid, "2026-06-15");
        List<Map<String, Object>> batt =
                (List<Map<String, Object>>) ch.get("battery_power_kw");
        assertThat(batt).hasSize(3);
        assertThat(batt.get(0)).containsEntry("start", "2026-06-15T10:00:00Z");
        assertThat(num(batt.get(0), "avg")).isEqualTo(2.0); // v1: (1-2+3, 3-2+1)/2
        assertThat(batt.get(1)).containsEntry("start", "2026-06-15T10:15:00Z");
        assertThat(num(batt.get(1), "avg")).isEqualTo(4.0); // v1: 0-1+5
        assertThat(batt.get(2)).containsEntry("start", "2026-06-15T11:00:00Z");
        assertThat(num(batt.get(2), "avg")).isEqualTo(9.0); // v2 ALONE - the 11:05
                                                            // v1 sample (0.0) is not blended in

        List<Map<String, Object>> pv = (List<Map<String, Object>>) ch.get("pv_power_kw");
        assertThat(pv).hasSize(3);
        assertThat(num(pv.get(0), "avg")).isEqualTo(2.0); // (3+1)/2
        assertThat(num(pv.get(2), "avg")).isEqualTo(8.0);

        List<Map<String, Object>> soc = (List<Map<String, Object>>) ch.get("soc_pct");
        assertThat(soc).hasSize(3);
        assertThat(num(soc.get(0), "avg")).isEqualTo(51.0);
        assertThat(num(soc.get(0), "min")).isEqualTo(50.0);
        assertThat(num(soc.get(0), "max")).isEqualTo(52.0);
        assertThat(num(soc.get(2), "avg")).isEqualTo(70.0);

        // (e) the rollup-backed ranges bridge as well: the 10:00 hour comes from
        // the v1 rollup (quarter powers 2.0 and 4.0 -> 3.0), the 11:00 hour from v2.
        exec("CALL refresh_telemetry_rollups('2026-06-01T00:00:00Z')");
        exec("CALL refresh_telemetry_v2_rollups('2026-06-01T00:00:00Z')");
        ResponseEntity<Map<String, Object>> week = rest.exchange(
                url("/api/v1/sites/" + siteId + "/entities/" + hybrid
                        + "/history?range=week&at=2026-06-17"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(week.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> weekBatt = (List<Map<String, Object>>)
                ((Map<String, Object>) week.getBody().get("channels")).get("battery_power_kw");
        assertThat(weekBatt).hasSize(2);
        assertThat(weekBatt.get(0)).containsEntry("start", "2026-06-15T10:00:00Z");
        assertThat(num(weekBatt.get(0), "avg")).isEqualTo(3.0); // (2.0 + 4.0)/2, from v1
        assertThat(weekBatt.get(1)).containsEntry("start", "2026-06-15T11:00:00Z");
        assertThat(num(weekBatt.get(1), "avg")).isEqualTo(9.0); // from v2

        // A day the plant did not exist stays honestly empty - the splice never
        // fabricates buckets.
        assertThat(entityDayChannels(demo, siteId, hybrid, "2026-06-01")).isEmpty();

        // RLS: the other tenant cannot read the spliced series either.
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + siteId + "/entities/" + hybrid + "/history"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * Audit V2/X1 + H8 + H3 on the wire: a day with NO buckets must answer "—"
     * for every aggregate (the energy sums used to answer a confident 0.0 while
     * the cost fields correctly answered null), the spot-priced gridCost carries
     * its tariff context, and the ex-ante plan sum is served under a name that
     * says "planned".
     */
    @Test
    void historyTotalsAreNullOnAZeroBucketDayAndCarryTariffAndPlannedContext() {
        String demo = token("demo", "demo");
        String siteId = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Leer-Anlage"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        ResponseEntity<Map<String, Object>> day = rest.exchange(
                url("/api/v1/sites/" + siteId + "/history?range=day&at=2026-06-15"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(day.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list(day.getBody(), "buckets")).isEmpty();

        @SuppressWarnings("unchecked")
        Map<String, Object> totals = (Map<String, Object>) day.getBody().get("totals");
        assertThat(totals).containsEntry("consumptionKwh", null)
                .containsEntry("pvGenerationKwh", null)
                .containsEntry("gridImportKwh", null)
                .containsEntry("gridExportKwh", null)
                .containsEntry("gridCostEur", null)
                .containsEntry("autarkiePct", null)
                .containsEntry("eigenverbrauchPct", null)
                // H3: the ex-ante PLANNED sum has "planned" in its name; the old
                // bare field survives one release as a same-valued alias.
                .containsEntry("batterySavingsPlannedEur", null)
                .containsEntry("batterySavingsEur", null)
                // H8: gridCostEur is bare spot - the context says no tariff is set.
                .containsEntry("tarifArt", "ohne");

        // With a tariff configured the context follows the site.
        rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Leer-Anlage", "tarifArt", "fest",
                        "tarifParamCtKwh", 30), bearer(demo)), String.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> after = (Map<String, Object>) rest.exchange(
                url("/api/v1/sites/" + siteId + "/history?range=day&at=2026-06-15"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("totals");
        assertThat(after).containsEntry("tarifArt", "fest");
    }

    /**
     * Audit H2 (server half): the honest {@code unreported} verdict must be on
     * the wire for an entity no device has ever echoed - the portal maps unknown
     * to a grey state instead of a fail-open green dot. {@code observed} stays
     * null (nothing was reported), never a synthesized "ok".
     */
    @Test
    @SuppressWarnings("unchecked")
    void entitySurfaceReportsUnreportedWhenNoDeviceEverEchoedTheRegistry() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";
        String siteId = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Stumm-Anlage"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        // Das Gerät wird per Superuser eingesetzt, damit der CLAIM-Auslöser
        // NICHT komponiert: dieser Test besitzt die Entitäts-Menge der Anlage
        // selbst (er prüft das Urteil über EINE nie bestätigte Entität), und
        // eine automatisch komponierte Netz-/Haus-Zeile wäre eine zweite,
        // fremde Wahrheit in derselben Antwort.
        String deviceId = java.util.UUID.randomUUID().toString();
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES ('"
                + deviceId + "','" + tenantA + "','" + siteId + "','edge-stumm-01','inverter')");

        String entityId = "eeeece02-0000-0000-0000-000000000001";
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, control, "
                + "device_id, entity_type, capabilities, guard_config) VALUES ('" + entityId
                + "','" + tenantA + "','" + siteId + "','battery-hybrid','Batteriespeicher', "
                + "FALSE, '" + deviceId + "', 'battery-hybrid', "
                + "'{\"measure\":[{\"channel\":\"soc_pct\"}]}'::jsonb, '{}'::jsonb)");
        // A registry WAS pushed (so this is not the never_pushed case) but the
        // device has never reported back - exactly the deploy-day state.
        exec("INSERT INTO entity_registry_state (site_id, tenant_id, device_id, revision) "
                + "VALUES ('" + siteId + "','" + tenantA + "','" + deviceId + "','rev-1')");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> entities = list(res.getBody(), "entities");
        assertThat(entities).hasSize(1);
        assertThat(entities.get(0)).containsEntry("syncStatus", "unreported")
                .containsEntry("observed", null);
    }

    /**
     * Anlagen-Zentrale Stufe 2 (PR 2b): die sechs VERBINDUNGSFELDER reisen
     * additiv auf {@code /entities.localSetup}.
     *
     * <p>Sie liegen seit {@code V20260819000000} in
     * {@code entity_observed_state.edge_*} und wurden bis hierher nur von der
     * Bestands-Übernahme gelesen - die Flächen mussten ihre Adressen aus einem
     * ANDEREN Pfad zusammensuchen. Jetzt beschriften das Struktur-Schaltbild
     * UND die Geräteseite ihre Kanten aus DIESEM einen, also können sie
     * dieselbe Adresse nie verschieden nennen.
     *
     * <p>Geprüft wird beides: der volle Bericht reist Feld für Feld durch (samt
     * der EINEN Modbus-Adresse, die der Solarman-Weg {@code mb_slave_id} und
     * jeder andere {@code unit_id} nennt), und ein ÄLTERER Box-Stand ohne die
     * Felder liefert überall {@code null} - „diese Box meldet keine
     * Verbindungen", nie eine erfundene Adresse.
     */
    @Test
    @SuppressWarnings("unchecked")
    void localSetupCarriesTheReportedConnectionAndAnOlderBoxStandStaysNull() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String siteId = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Schaltbild-Anlage"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        String deviceId = claimDeviceInto(demo, siteId, "edge-schaltbild-01");

        var listener = new com.voltpilot.api.entities.EntityStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, entityObservedRepo, componentApplyRepo);
        String topic = "ems/" + tenantA + "/" + siteId + "/" + deviceId + "/status";
        java.util.function.Consumer<String> report = localSetupJson -> listener.handle(topic,
                ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + tenantA + "\",\"site_id\":\""
                        + siteId + "\",\"device_id\":\"" + deviceId + "\",\"online\":true,"
                        + "\"entities\":{\"revision\":\"r1\",\"local_setup\":" + localSetupJson
                        + "}}").getBytes(java.nio.charset.StandardCharsets.UTF_8));

        java.util.function.Function<String, Map<String, Object>> setupById = id -> {
            ResponseEntity<Map<String, Object>> res = rest.exchange(
                    url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                    new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
            return ((List<Map<String, Object>>) res.getBody().get("localSetup")).stream()
                    .filter(e -> id.equals(e.get("id"))).findFirst().orElseThrow();
        };

        // Der volle Bericht: der Deye über seinen Solarman-Logger (Modbus-Adresse
        // heißt dort `mb_slave_id`), der Fronius über Modbus-TCP (`unit_id`).
        report.accept("[{\"id\":\"inverter\",\"kind\":\"inverter\",\"brand\":\"deye\","
                + "\"model\":\"SUN-30K-SG01HP3-EU\",\"family\":\"hybrid_3p\","
                + "\"communication\":\"solarman_v5\",\"interval_s\":5,"
                + "\"connection\":{\"ip\":\"192.168.254.210\",\"port\":8899,"
                + "\"serial\":\"2985159064\",\"mb_slave_id\":1}},"
                + "{\"id\":\"src-fronius\",\"kind\":\"source\",\"role\":\"pv-generation\","
                + "\"brand\":\"fronius_sunspec\",\"model\":\"fronius-eco-27-3-s\","
                + "\"family\":\"sunspec_live\",\"communication\":\"fronius_sunspec\","
                + "\"interval_s\":5,"
                + "\"connection\":{\"ip\":\"192.168.210.40\",\"port\":502,\"unit_id\":2}}]");

        Map<String, Object> deye = setupById.apply("inverter");
        assertThat(deye).containsEntry("communication", "solarman_v5")
                .containsEntry("family", "hybrid_3p")
                .containsEntry("host", "192.168.254.210")
                .containsEntry("port", 8899)
                .containsEntry("serial", "2985159064")
                .containsEntry("intervalS", 5);
        assertThat(deye.get("unitId")).as("mb_slave_id ist dieselbe Sache wie unit_id")
                .isEqualTo(1);

        Map<String, Object> fronius = setupById.apply("src-fronius");
        assertThat(fronius).containsEntry("communication", "fronius_sunspec")
                .containsEntry("host", "192.168.210.40")
                .containsEntry("port", 502)
                .containsEntry("unitId", 2)
                .containsEntry("serial", null);

        // Ein ÄLTERER Box-Stand meldet die Felder gar nicht: dann ist ALLES
        // null - „meldet keine Verbindungen", nie eine halbe Adresse.
        report.accept("[{\"id\":\"inverter\",\"kind\":\"inverter\",\"brand\":\"deye\","
                + "\"model\":\"SUN-30K-SG01HP3-EU\"}]");
        Map<String, Object> alt = setupById.apply("inverter");
        assertThat(alt).containsEntry("communication", null).containsEntry("family", null)
                .containsEntry("host", null).containsEntry("port", null)
                .containsEntry("unitId", null).containsEntry("serial", null)
                .containsEntry("intervalS", null);
        // ... und die übrigen Felder sind davon unberührt.
        assertThat(alt).containsEntry("brand", "deye").containsEntry("kind", "inverter");
    }

    /**
     * Anlagen-Zentrale Stufe 2 (PR 2c, Captain-Entscheid D5): die Box meldet
     * ihre EIGENE Erreichbarkeit, und der Kunde liest sie auf demselben
     * Lesepfad, den jede Fläche ohnehin lädt.
     *
     * <p>Die Lücke war belegt und hat zwei Support-Runden gekostet: das Portal
     * zeigt jede GERÄTE-Adresse, aber nicht die der Box - und genau die ist der
     * Weg zur lokalen Oberfläche.
     *
     * <p>Gefahren wird der ECHTE Zuhörer, also die Form, die auf dem Draht
     * liegt. Geprüft werden die drei Zustände, die nie zusammenfallen dürfen:
     * die BEWIESENE Adresse, die schwächere Schnittstellen-Adresse (mit ihrem
     * eigenen Wort), und „gar nichts gemeldet" - das bleibt null, NIE „nicht
     * erreichbar".
     */
    @Test
    @SuppressWarnings("unchecked")
    void theBoxOwnReachabilityIsIngestedAndTenantScoped() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String siteId = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "LAN-Anlage"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        String deviceId = claimDeviceInto(demo, siteId, "edge-lan-01");

        java.util.function.Function<String, Map<String, Object>> device = id -> {
            ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                    url("/api/v1/devices"), HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                    new ParameterizedTypeReference<>() {});
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
            return res.getBody().stream().filter(d -> id.equals(d.get("id"))).findFirst()
                    .orElseThrow();
        };

        // Vor jeder Meldung wird NICHTS behauptet.
        assertThat(device.apply(deviceId)).containsEntry("lanHost", null)
                .containsEntry("lanSource", null).containsEntry("lanSeenAt", null);

        var listener = new com.voltpilot.api.ota.UpdateStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, updateStatusRepo);
        String topic = "ems/" + tenantA + "/" + siteId + "/" + deviceId + "/status";
        java.util.function.Consumer<String> heartbeat = network -> listener.handle(topic,
                ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + tenantA + "\",\"site_id\":\""
                        + siteId + "\",\"device_id\":\"" + deviceId + "\",\"online\":true,"
                        + "\"version\":\"edge-2026.08.10\",\"network\":" + network + "}")
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8));

        // Die BEWIESENE Adresse - so, wie ein Browser sie wirklich erreicht hat.
        heartbeat.accept("{\"reported_at\":\"2026-08-21T09:12:00Z\","
                + "\"host\":\"192.168.254.51:8484\",\"seen_at\":\"2026-08-21T09:11:44Z\"}");
        Map<String, Object> nachher = device.apply(deviceId);
        assertThat(nachher).containsEntry("lanHost", "192.168.254.51:8484")
                .containsEntry("lanSource", "erreicht");
        assertThat((String) nachher.get("lanSeenAt")).startsWith("2026-08-21T09:11:44");

        // Ein Herzschlag OHNE den Block lässt sie stehen (Schweigen ist keine
        // Aussage über die Erreichbarkeit).
        listener.handle(topic, ("{\"tenant_id\":\"" + tenantA + "\",\"site_id\":\"" + siteId
                + "\",\"device_id\":\"" + deviceId + "\",\"version\":\"edge-2026.08.11\"}")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(device.apply(deviceId)).containsEntry("lanHost", "192.168.254.51:8484");

        // Der explizite Kundennetz-Endpunkt schlägt einen beobachteten
        // Service-VPN-Aufruf. Genau dieser Fall hatte 10.10.1.23 im Portal
        // sichtbar und den Link für den Kunden unbrauchbar gemacht.
        heartbeat.accept("{\"reported_at\":\"2026-08-21T10:00:00Z\","
                + "\"lan_host\":\"192.168.0.31:8484\","
                + "\"host\":\"10.10.1.23:8484\",\"iface\":\"eth0\"}");
        assertThat(device.apply(deviceId)).containsEntry("lanHost", "192.168.0.31:8484")
                .containsEntry("lanSource", "schnittstelle");

        // Ein fremder Mandant sieht das Gerät gar nicht (RLS).
        ResponseEntity<List<Map<String, Object>>> fremd = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(fremd.getBody()).noneMatch(d -> deviceId.equals(d.get("id")));
    }

    /** The day-range channel map of one entity (helper for the splice test). */
    @SuppressWarnings("unchecked")
    private Map<String, Object> entityDayChannels(String token, String siteId, String entityId,
            String at) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/entities/" + entityId
                        + "/history?range=day&at=" + at),
                HttpMethod.GET, new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (Map<String, Object>) res.getBody().get("channels");
    }

    /**
     * Portal v3 M6 (OPEN O3): the CUSTOMER adopt twin
     * {@code POST /api/v1/sites/{id}/v2-entities/adopt} — a Portal-User assigns
     * an edge-reported source of THEIR OWN site in one move. Mirrors
     * {@code AdminApiTest.adminAdoptsEdgeReportedSourcesIntoV2EntitiesIdempotently}:
     * a guided consumer type adopts idempotently per edgeSourceId, a non-guided
     * type is refused (never a free type picker), and a foreign site is 404
     * (RLS, not 403 — no @PreAuthorize).
     */
    @Test
    @SuppressWarnings("unchecked")
    void customerAdoptsAReportedSourceInOneMoveGuardedToTheGuidedTypes() {
        String demo = token("demo", "demo");

        // The customer creates an Anlage of their own tenant.
        String siteId = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Zuordnen-Anlage"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        // Adopt a reported go-e wallbox (a guided consumer type) -> a v2 entity
        // pinned to its source id.
        ResponseEntity<Map<String, Object>> adopted = rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "goe-1", "entityType", "wallbox",
                        "label", "Wallbox Carport", "maxPowerKw", 11), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(adopted.getStatusCode()).isEqualTo(HttpStatus.OK);
        String wallboxId = (String) adopted.getBody().get("id");
        assertThat(adopted.getBody().get("entityType")).isEqualTo("wallbox");

        // Idempotent per sourceId: a re-adopt returns the same entity.
        ResponseEntity<Map<String, Object>> reAdopt = rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "goe-1", "entityType", "wallbox"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(reAdopt.getBody().get("id")).isEqualTo(wallboxId);
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE site_id = '" + siteId
                + "' AND edge_source_id = 'goe-1'")).isEqualTo(1L);

        // A platform-managed composed type (battery-hybrid) is NOT adoptable here
        // (never a free type picker) -> 422.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/adopt"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "x-1", "entityType", "battery-hybrid"),
                        bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // A free installer type (modbus-generic) is likewise not a guided type -> 422.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/adopt"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "x-2", "entityType", "modbus-generic"),
                        bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // An unknown type -> 400.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/adopt"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "x-3", "entityType", "phantasie"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // A foreign tenant can neither see nor adopt onto this site (404, RLS).
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/adopt"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "goe-9", "entityType", "wallbox"),
                        bearer(token("demo2", "demo2"))),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * PR 3 (vp-vier-erzeuger-p9): the identity-churn repair. A source deleted +
     * re-added on the device gets a new id, so the adopted entity's pin goes
     * stale - the surface marks it {@code orphanedPin} (tri-state, only ever
     * true when the device REPORTS a local view that lacks the pinned id) and
     * {@code POST .../v2-entities/{entityId}/edge-source} RECONNECTS the
     * existing entity to the re-appeared source instead of minting a duplicate.
     * Guards: target must be currently reported (422), role-compatible (422)
     * and not pinned to another entity (409); foreign tenant 404 (RLS);
     * idempotent for the same source id.
     */
    @Test
    @SuppressWarnings("unchecked")
    void repinReconnectsAnOrphanedEntityAfterSourceChurn() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String siteId = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Repin-Anlage"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        String deviceId = claimDeviceInto(demo, siteId, "edge-repin-01");

        var listener = new com.voltpilot.api.entities.EntityStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, entityObservedRepo, componentApplyRepo);
        String topic = "ems/" + tenantA + "/" + siteId + "/" + deviceId + "/status";
        java.util.function.Consumer<String> report = localSetupJson -> listener.handle(topic,
                ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + tenantA + "\",\"site_id\":\""
                        + siteId + "\",\"device_id\":\"" + deviceId + "\",\"online\":true,"
                        + "\"entities\":{\"revision\":\"r1\",\"local_setup\":" + localSetupJson
                        + "}}").getBytes(java.nio.charset.StandardCharsets.UTF_8));

        // The device reports one PV source; the customer adopts it.
        report.accept("[{\"id\":\"src-old\",\"kind\":\"source\",\"role\":\"pv-generation\","
                + "\"brand\":\"fronius_sunspec\",\"model\":\"fronius-eco-27-3-s\","
                + "\"label\":\"Fronius WR2\"}]");
        String entityId = (String) rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-old", "entityType", "producer",
                        "label", "Fronius WR2", "capacityKwp", 27), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        java.util.function.Function<String, Map<String, Object>> entityById = id -> {
            ResponseEntity<Map<String, Object>> res = rest.exchange(
                    url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                    new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
            return ((List<Map<String, Object>>) res.getBody().get("entities")).stream()
                    .filter(e -> id.equals(e.get("id"))).findFirst().orElseThrow();
        };
        assertThat(entityById.apply(entityId).get("orphanedPin"))
                .as("pinned + reported = not orphaned").isEqualTo(false);

        // Identity churn: the device deletes + re-adds the source (new id).
        report.accept("[{\"id\":\"src-new\",\"kind\":\"source\",\"role\":\"pv-generation\","
                + "\"brand\":\"fronius_sunspec\",\"model\":\"fronius-eco-27-3-s\","
                + "\"label\":\"Fronius Anlage WR2\"}]");
        assertThat(entityById.apply(entityId).get("orphanedPin"))
                .as("the pinned id vanished from the report").isEqualTo(true);

        // Re-pin to an UNREPORTED source is refused - never a blind pin.
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + entityId + "/edge-source"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-ghost"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // Reconnect to the re-appeared source: same entity, no duplicate row.
        ResponseEntity<Map<String, Object>> repin = rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + entityId + "/edge-source"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-new"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(repin.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(repin.getBody().get("id")).isEqualTo(entityId);
        assertThat(entityById.apply(entityId).get("orphanedPin")).isEqualTo(false);
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE site_id = '" + siteId
                + "' AND role = 'pv-generation'")).as("no duplicate producer").isEqualTo(1L);
        ResponseEntity<Map<String, Object>> surface = rest.exchange(
                url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        Map<String, Object> srcNew = ((List<Map<String, Object>>) surface.getBody()
                .get("localSetup")).stream().filter(l -> "src-new".equals(l.get("id")))
                .findFirst().orElseThrow();
        assertThat(srcNew.get("adoptedEntityId")).isEqualTo(entityId);

        // Idempotent for the same source id.
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + entityId + "/edge-source"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-new"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.OK);

        // A source already pinned to ANOTHER entity is refused (409): adopt a
        // second producer, then try to steal src-new for it.
        report.accept("[{\"id\":\"src-new\",\"kind\":\"source\",\"role\":\"pv-generation\","
                + "\"brand\":\"fronius_sunspec\",\"model\":\"fronius-eco-27-3-s\","
                + "\"label\":\"Fronius Anlage WR2\"},"
                + "{\"id\":\"src-two\",\"kind\":\"source\",\"role\":\"pv-generation\","
                + "\"brand\":\"fronius_sunspec\",\"model\":\"fronius-eco-27-3-s\","
                + "\"label\":\"Fronius Anlage\"},"
                + "{\"id\":\"src-wb\",\"kind\":\"source\",\"role\":\"consumer\","
                + "\"brand\":\"go-e\",\"model\":\"Charger 3\"}]");
        String entity2 = (String) rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-two", "entityType", "producer",
                        "label", "Fronius Anlage"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + entity2 + "/edge-source"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-new"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Role mismatch: a producer must not follow a consumer source (422).
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + entityId + "/edge-source"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-wb"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // Foreign tenant: 404 via RLS, and the pin provably unchanged.
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + entityId + "/edge-source"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-new"), bearer(token("demo2", "demo2"))),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(entityById.apply(entityId).get("edgeSourceId")).isEqualTo("src-new");
    }

    /**
     * vp-bereinigung-ui-k3: the CLEANUP the captain could not reach. On his
     * Pilsting plant EVERY reported device was already pinned - to the WRONG
     * components - so there was no "Neues Gerät gefunden" card, plain re-pin
     * could only answer 409, and the purge-delete lever existed on the
     * platform-admin route alone. This proves the two customer levers:
     *
     * <ul>
     *   <li>{@code swap: true} EXCHANGES two crossed assignments in ONE call
     *       (one transaction - never a half-swapped state), and hands the other
     *       component this entity's previous source only when that source is
     *       still reported, else releases it (never move an orphan defect);</li>
     *   <li>{@code DELETE .../v2-entities/{id}} removes an adopted component,
     *       releases its kWp from the plant total and frees its device, which
     *       then reappears unassigned.</li>
     * </ul>
     * Both are guarded: platform-composed components (battery-hybrid /
     * house-load) and components without a device assignment are refused, and
     * a foreign tenant sees nothing (RLS 404).
     */
    @Test
    @SuppressWarnings("unchecked")
    void customerSwapsCrossedAssignmentsAndDeletesTheGhostComponent() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String siteId = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Pilsting-Bereinigung"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        String deviceId = claimDeviceInto(demo, siteId, "edge-clean-01");

        var listener = new com.voltpilot.api.entities.EntityStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, entityObservedRepo, componentApplyRepo);
        String topic = "ems/" + tenantA + "/" + siteId + "/" + deviceId + "/status";
        java.util.function.Consumer<String> report = localSetupJson -> listener.handle(topic,
                ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + tenantA + "\",\"site_id\":\""
                        + siteId + "\",\"device_id\":\"" + deviceId + "\",\"online\":true,"
                        + "\"entities\":{\"revision\":\"r1\",\"local_setup\":" + localSetupJson
                        + "}}").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        java.util.function.Function<String, String> pvSource = (id) ->
                "{\"id\":\"" + id + "\",\"kind\":\"source\",\"role\":\"pv-generation\","
                        + "\"brand\":\"fronius_sunspec\",\"label\":\"" + id + "\"}";
        java.util.function.Function<String, Map<String, Object>> entityById = id -> {
            ResponseEntity<Map<String, Object>> res = rest.exchange(
                    url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                    new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
            return ((List<Map<String, Object>>) res.getBody().get("entities")).stream()
                    .filter(e -> id.equals(e.get("id"))).findFirst().orElseThrow();
        };
        java.util.function.BiFunction<String, Object, String> adopt = (sourceId, kwp) -> {
            Map<String, Object> body = new java.util.HashMap<>(Map.of("sourceId", sourceId,
                    "entityType", "producer", "label", sourceId));
            if (kwp != null) {
                body.put("capacityKwp", kwp);
            }
            return (String) rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/adopt"),
                    HttpMethod.POST, new HttpEntity<>(body, bearer(demo)),
                    new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        };

        // The captain's shape: WR1's device vanished (orphan), while WR2 and the
        // ghost hold the two devices that ARE reported - crossed.
        report.accept("[" + pvSource.apply("src-weg") + "]");
        String wr1 = adopt.apply("src-weg", 9.8);
        report.accept("[" + pvSource.apply("src-a") + "," + pvSource.apply("src-b") + "]");
        String wr2 = adopt.apply("src-a", null);
        String ghost = adopt.apply("src-b", null);
        assertThat(entityById.apply(wr1).get("orphanedPin")).isEqualTo(true);
        assertThat(entityById.apply(wr1).get("capacityKwp")).isNotNull();

        // Nothing is unassigned, so the ONLY way out is taking a held device.
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + wr1 + "/edge-source"),
                HttpMethod.POST, new HttpEntity<>(Map.of("sourceId", "src-a"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // The swap: WR1 takes src-a. WR2 gets NOTHING back, because WR1's own
        // source is gone - handing over a dead id would just move the orphan.
        String revisionBefore = queryText("SELECT revision FROM entity_registry_state "
                + "WHERE site_id = '" + siteId + "'");
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + wr1 + "/edge-source"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-a", "swap", true), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        // The pin rides IN the pushed registry (edge_source_id, PR #272), so a
        // re-pin MUST re-compose the Soll - otherwise the device keeps serving
        // its per-source values against the old assignment and the two disagree
        // (the captain's device still showed the pre-swap picture).
        assertThat(queryText("SELECT revision FROM entity_registry_state WHERE site_id = '"
                + siteId + "'")).isNotEqualTo(revisionBefore);
        assertThat(entityById.apply(wr1).get("edgeSourceId")).isEqualTo("src-a");
        assertThat(entityById.apply(wr1).get("orphanedPin")).isEqualTo(false);
        assertThat(entityById.apply(wr2).get("edgeSourceId")).isNull();
        assertThat(entityById.apply(wr2).get("orphanedPin")).as("no pin = no orphan claim").isNull();

        // A true exchange: both sides hold a REPORTED device, so both move.
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + ghost + "/edge-source"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "src-a", "swap", true), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(entityById.apply(ghost).get("edgeSourceId")).isEqualTo("src-a");
        assertThat(entityById.apply(wr1).get("edgeSourceId")).isEqualTo("src-b");
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE site_id = '" + siteId
                + "' AND role = 'pv-generation'")).as("a swap never mints a row").isEqualTo(3L);

        // A component WITHOUT a device assignment is the plant's base, not a
        // mis-adoption - refused, and provably still there afterwards.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/" + wr2),
                HttpMethod.DELETE, new HttpEntity<>(bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(entityById.apply(wr2)).isNotNull();

        // Neither is a platform-composed component (seeded like every v2 test).
        String hybrid = java.util.UUID.randomUUID().toString();
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, control, "
                + "device_id, entity_type, capabilities, guard_config) VALUES ('" + hybrid
                + "','" + tenantA + "','" + siteId + "','battery-hybrid','Batteriespeicher', "
                + "FALSE, '" + deviceId + "', 'battery-hybrid', "
                + "'{\"measure\":[{\"channel\":\"soc_pct\"}]}'::jsonb, '{}'::jsonb)");
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/" + hybrid),
                HttpMethod.DELETE, new HttpEntity<>(bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + hybrid + "/edge-source"),
                HttpMethod.POST, new HttpEntity<>(Map.of("sourceId", "src-a"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // A foreign tenant can neither see nor delete it (RLS 404).
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/" + wr1),
                HttpMethod.DELETE, new HttpEntity<>(bearer(token("demo2", "demo2"))),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // The delete: the component goes, its kWp leaves the plant total, and
        // its device is free again - so it can be assigned to the right one.
        assertThat(queryDouble("SELECT pv_capacity_kwp FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'pv'")).isEqualTo(9.8);
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/" + wr1),
                HttpMethod.DELETE, new HttpEntity<>(bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE id = '" + wr1 + "'"))
                .isZero();
        assertThat(queryDouble("SELECT pv_capacity_kwp FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'pv'")).isEqualTo(0.0);
        ResponseEntity<Map<String, Object>> surface = rest.exchange(
                url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        Map<String, Object> freed = ((List<Map<String, Object>>) surface.getBody()
                .get("localSetup")).stream().filter(l -> "src-b".equals(l.get("id")))
                .findFirst().orElseThrow();
        assertThat(freed.get("adoptedEntityId")).as("freed = 'Neues Gerät gefunden'").isNull();
    }

    /**
     * The customer's OWN name for a component (concept vp-entity-alias-k1, the
     * customer twin of the admin label PUT). Three things must hold at once:
     * every component may be named - INCLUDING the platform-composed ones,
     * because a name changes neither what a component is nor whether it exists
     * (Captain, 09.08.2026); clearing falls BACK to the derivation instead of
     * leaving an empty name (R5); and the route can write NOTHING but the label
     * (R1), which is why it exists separately from the config PUT.
     */
    @Test
    void customerNamesEveryComponentAndClearingRestoresTheDerivation() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";
        String siteId = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Alias-Anlage"), bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        String deviceId = claimDeviceInto(demo, siteId, "edge-alias-01");

        java.util.function.Function<String, Map<String, Object>> entityById = id -> {
            ResponseEntity<Map<String, Object>> res = rest.exchange(
                    url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                    new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
            return ((List<Map<String, Object>>) res.getBody().get("entities")).stream()
                    .filter(e -> id.equals(e.get("id"))).findFirst().orElseThrow();
        };
        java.util.function.BiFunction<String, Object, ResponseEntity<String>> rename =
                (entityId, label) -> rest.exchange(
                        url("/api/v1/sites/" + siteId + "/v2-entities/" + entityId + "/label"),
                        HttpMethod.PUT,
                        new HttpEntity<>(label == null ? new java.util.HashMap<String, Object>()
                                : Map.of("label", label), bearer(demo)),
                        String.class);

        // A PLATFORM-COMPOSED component: re-pin and delete refuse it, renaming
        // must not - it is the customer's battery and they may call it what
        // they like. Seeded with NO label, as the composition now leaves it.
        String hybrid = java.util.UUID.randomUUID().toString();
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, control, "
                + "device_id, entity_type, capabilities, guard_config) VALUES ('" + hybrid
                + "','" + tenantA + "','" + siteId + "','battery-hybrid', NULL, "
                + "FALSE, '" + deviceId + "', 'battery-hybrid', "
                + "'{\"measure\":[{\"channel\":\"soc_pct\"}]}'::jsonb, "
                + "'{\"failsafe\":{\"behavior\":\"hold\"}}'::jsonb)");
        assertThat(entityById.apply(hybrid).get("label")).as("composed = unnamed").isNull();

        // The rename re-composes the Soll, so the device learns the name too -
        // the alias reaches the box's own :8484 topology over the SAME push.
        String revisionBefore = queryText("SELECT revision FROM entity_registry_state "
                + "WHERE site_id = '" + siteId + "'");
        assertThat(rename.apply(hybrid, "Keller").getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(entityById.apply(hybrid).get("label")).isEqualTo("Keller");
        assertThat(queryText("SELECT revision FROM entity_registry_state WHERE site_id = '"
                + siteId + "'")).isNotEqualTo(revisionBefore);

        // R1: the route carries ONLY a name. Type, control and guards are the
        // same afterwards - there is no field to smuggle them through.
        assertThat(queryText("SELECT entity_type FROM measurement_point WHERE id = '" + hybrid
                + "'")).isEqualTo("battery-hybrid");
        assertThat(queryText("SELECT guard_config::text FROM measurement_point WHERE id = '"
                + hybrid + "'")).contains("hold");
        assertThat(queryText("SELECT control::text FROM measurement_point WHERE id = '" + hybrid
                + "'")).isEqualTo("false");

        // Trim + collapse: a name is one line of text.
        assertThat(rename.apply(hybrid, "  Keller\n Süd  ").getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(entityById.apply(hybrid).get("label")).isEqualTo("Keller Süd");

        // R5: clearing means falling BACK to the derivation - NULL in the
        // column, never an empty string the surfaces would render as a blank.
        assertThat(rename.apply(hybrid, "   ").getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(entityById.apply(hybrid).get("label")).isNull();
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE id = '" + hybrid
                + "' AND label IS NULL")).isEqualTo(1L);

        // An ABSENT field keeps the current name (the admin PUT's semantics, so
        // there is ONE label-writing rule) - it is a no-op, not a clear.
        assertThat(rename.apply(hybrid, "Keller").getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(rename.apply(hybrid, null).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(entityById.apply(hybrid).get("label")).isEqualTo("Keller");

        // Duplicates are allowed on purpose: two arrays may both be "Dach".
        String producer = java.util.UUID.randomUUID().toString();
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, control, "
                + "device_id, entity_type, capabilities, guard_config) VALUES ('" + producer
                + "','" + tenantA + "','" + siteId + "','pv-generation', NULL, FALSE, '"
                + deviceId + "', 'producer', "
                + "'{\"measure\":[{\"channel\":\"pv_power_kw\"}]}'::jsonb, '{}'::jsonb)");
        assertThat(rename.apply(producer, "Keller").getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(entityById.apply(producer).get("label")).isEqualTo("Keller");

        // The 200-char parity cap with the admin route.
        assertThat(rename.apply(producer, "x".repeat(201)).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rename.apply(producer, "x".repeat(200)).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        // RLS is the fence: a foreign tenant cannot rename, and provably did
        // not change anything.
        assertThat(rest.exchange(
                url("/api/v1/sites/" + siteId + "/v2-entities/" + hybrid + "/label"),
                HttpMethod.PUT, new HttpEntity<>(Map.of("label", "geklaut"),
                        bearer(token("demo2", "demo2"))), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(entityById.apply(hybrid).get("label")).isEqualTo("Keller");

        // An unknown entity of a site the caller DOES own is 404, not a create.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/v2-entities/"
                + java.util.UUID.randomUUID() + "/label"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("label", "nichts"), bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * MIG v1->v2 history bridge: a migrated site's Historie must NOT reset at
     * the cutover. With v1 5-channel telemetry BEFORE the cutover instant and
     * v2 per-entity telemetry (producer + grid-meter + battery-hybrid) AT/AFTER
     * it, the day series is GAP-FREE across the seam - every 15-min bucket is
     * present exactly once, the v1-era buckets carry the v1-derived channels and
     * the v2-era buckets carry the SAME shape reconstructed from telemetry_v2.
     * The week rollup path bridges the same way; clearing the cutover reverts
     * the site to pure v1 (the migration rollback).
     */
    @Test
    @SuppressWarnings("unchecked")
    void migratedSiteHistoryBridgesV1AndV2ErasGapFree() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";
        String deviceId = claimDevice(demo, "edge-mig-hist-01");

        // Cutover on an HOUR boundary (09:00Z) so both the 15-min day view and
        // the hourly week view splice cleanly. v1 era: two 15-min buckets BEFORE
        // it (08:30, 08:45 UTC). power_kw=2 (import), pv=1, load=4 -> battery
        // derived = 2-4+1 = -1 kW (discharge 1).
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct, "
                + "pv_power_kw, load_kw) VALUES "
                + "('2026-05-20T08:31:00Z','" + tenantA + "','" + BERLIN_SITE + "','" + deviceId
                + "', 2.0, 50.0, 1.0, 4.0), "
                + "('2026-05-20T08:46:00Z','" + tenantA + "','" + BERLIN_SITE + "','" + deviceId
                + "', 2.0, 51.0, 1.0, 4.0) ON CONFLICT DO NOTHING");

        // The three pilot v2 entities (seeded as superuser like every telemetry
        // seed; the admin bootstrap that creates them is proven in AdminApiTest).
        String producer = "dddddddd-0000-0000-0000-000000000001";
        String meter = "dddddddd-0000-0000-0000-000000000002";
        String battery = "dddddddd-0000-0000-0000-000000000003";
        for (String[] e : new String[][] {
                {producer, "pv-generation", "producer", "AC-PV"},
                {meter, "grid-meter", "grid-meter", "Netz"},
                {battery, "battery-hybrid", "battery-hybrid", "Speicher"}}) {
            exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, control, "
                    + "entity_type, capabilities, guard_config) VALUES ('" + e[0] + "','" + tenantA
                    + "','" + BERLIN_SITE + "','" + e[1] + "','" + e[3] + "', FALSE, '" + e[2]
                    + "', '{}'::jsonb, '{}'::jsonb)");
        }

        // v2 era: two 15-min buckets AT/AFTER the cutover (09:00, 09:15 UTC).
        // producer pv=3, grid-meter power=2 (import), battery discharge -1, soc 55/56.
        StringBuilder v2 = new StringBuilder(
                "INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                        + "entity_id, channel, value) VALUES ");
        int i = 0;
        for (String[] row : new String[][] {
                {"2026-05-20T09:01:00Z", producer, "pv_power_kw", "3.0"},
                {"2026-05-20T09:01:00Z", meter, "power_kw", "2.0"},
                {"2026-05-20T09:01:00Z", battery, "battery_power_kw", "-1.0"},
                {"2026-05-20T09:01:00Z", battery, "pv_power_kw", "0.0"},
                {"2026-05-20T09:01:00Z", battery, "soc_pct", "55.0"},
                {"2026-05-20T09:16:00Z", producer, "pv_power_kw", "3.0"},
                {"2026-05-20T09:16:00Z", meter, "power_kw", "2.0"},
                {"2026-05-20T09:16:00Z", battery, "battery_power_kw", "-1.0"},
                {"2026-05-20T09:16:00Z", battery, "pv_power_kw", "0.0"},
                {"2026-05-20T09:16:00Z", battery, "soc_pct", "56.0"}}) {
            v2.append(i++ > 0 ? "," : "").append("('").append(row[0]).append("','").append(row[0])
                    .append("','").append(tenantA).append("','").append(BERLIN_SITE).append("','")
                    .append(deviceId).append("','").append(row[1]).append("','").append(row[2])
                    .append("',").append(row[3]).append(")");
        }
        exec(v2.toString());

        // The cutover: v1 owns buckets that START before 09:00, v2 owns 09:00+.
        exec("UPDATE site SET v2_history_cutover_at = '2026-05-20T09:00:00Z' WHERE id = '"
                + BERLIN_SITE + "'");

        Map<String, Object> day = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=day&at=2026-05-20"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        List<Map<String, Object>> buckets = (List<Map<String, Object>>) day.get("buckets");

        // Gap-free + overlap-free: the four consecutive quarter hours across the
        // seam, each present exactly once (v1 :30/:45, v2 :00/:15 of the next hr).
        assertThat(buckets).extracting(b -> b.get("start")).containsExactly(
                "2026-05-20T08:30:00Z", "2026-05-20T08:45:00Z",
                "2026-05-20T09:00:00Z", "2026-05-20T09:15:00Z");

        // v1-era bucket (08:30): the v1-derived shape.
        Map<String, Object> b0 = buckets.get(0);
        assertThat(num(b0, "pvKwh")).isEqualTo(0.25);        // 1 kW * 0.25 h
        assertThat(num(b0, "gridImportKwh")).isEqualTo(0.5); // 2 kW import
        assertThat(num(b0, "batteryDischargeKwh")).isEqualTo(0.25); // 1 kW discharge
        assertThat(num(b0, "socLastPct")).isEqualTo(50.0);

        // v2-era bucket (09:00): the SAME shape reconstructed from telemetry_v2.
        Map<String, Object> b2 = buckets.get(2);
        assertThat(num(b2, "pvKwh")).isEqualTo(0.75);        // producer 3 kW + hybrid 0
        assertThat(num(b2, "gridImportKwh")).isEqualTo(0.5); // grid-meter 2 kW
        assertThat(num(b2, "batteryDischargeKwh")).isEqualTo(0.25); // -1 kW -> discharge
        assertThat(num(b2, "batteryChargeKwh")).isEqualTo(0.0);
        assertThat(num(b2, "loadKwh")).isEqualTo(1.5);       // grid 2 + pv 3 - batt(-1) = 6 kW
        assertThat(num(b2, "socLastPct")).isEqualTo(55.0);

        // The week rollup path bridges too (both refresh cascades). The cutover
        // sits on the hour boundary, so hour 08:00 is v1, hour 09:00 is v2.
        exec("CALL refresh_telemetry_rollups('2026-05-01T00:00:00Z')");
        exec("CALL refresh_telemetry_v2_rollups('2026-05-01T00:00:00Z')");
        Map<String, Object> week = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=week&at=2026-05-20"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        List<Map<String, Object>> weekBuckets = (List<Map<String, Object>>) week.get("buckets");
        Map<String, Object> v1Hour = weekBuckets.stream()
                .filter(b -> "2026-05-20T08:00:00Z".equals(b.get("start"))).findFirst().orElseThrow();
        assertThat(num(v1Hour, "pvKwh")).isEqualTo(0.5); // v1 rollup: 0.25 + 0.25
        Map<String, Object> v2Hour = weekBuckets.stream()
                .filter(b -> "2026-05-20T09:00:00Z".equals(b.get("start"))).findFirst().orElseThrow();
        // Reconstructed by SUMMING quarter energies: 3 kW * 0.25 h * 2 = 1.5 kWh
        // (NOT avg 3 kW * 1 h = 3.0, which would overstate the partly-filled hour).
        assertThat(num(v2Hour, "pvKwh")).isEqualTo(1.5);

        // Rollback: clearing the cutover reverts to pure v1 (only the two v1
        // buckets remain in the day view; the v2 era vanishes).
        exec("UPDATE site SET v2_history_cutover_at = NULL WHERE id = '" + BERLIN_SITE + "'");
        Map<String, Object> reverted = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=day&at=2026-05-20"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        assertThat((List<Map<String, Object>>) reverted.get("buckets"))
                .extracting(b -> b.get("start"))
                .containsExactly("2026-05-20T08:30:00Z", "2026-05-20T08:45:00Z");
    }

    /**
     * Audit B2 regression: Postgres GREATEST ignores NULLs, so the old
     * {@code avg(greatest(power_kw, 0))} counted a power-less sample as 0 -
     * understating energy in mixed buckets and fabricating grid_import/export
     * = 0 for generation-only sites (which then wrongly passed the earnings
     * CHANNELS_OK gate instead of degrading to {@code missing_channels}). The
     * NULL-safe aggregates must hold in ALL THREE in-sync copies: the live day
     * view (HistoryRepository), the refresh procedure (V20260712000000), and
     * the purge rebuild (SeriesRepository).
     */
    @Test
    void rollupsNeverCoerceAbsentChannelsToZeroInAnyOfTheThreeCopies() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";
        String devX = claimDevice(demo, "edge-nullsafe-01");
        String devY = claimDevice(demo, "edge-nullsafe-02");

        // Far-past day (2026-01-12, before the rollup job's 7-day window).
        // 10:00 bucket MIXES a full sample with a power-less (pv-only) one;
        // 11:00 bucket is generation-only (a Deye string/micro shape);
        // 12:00 bucket belongs to the second device (purged later to exercise
        // the SeriesRepository rebuild copy).
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, load_kw, pv_power_kw) VALUES "
                + "('2026-01-12T10:00:00Z', '" + tenantA + "', '" + BERLIN_SITE + "', '" + devX
                + "', 4.0, 4.0, 2.0), "
                + "('2026-01-12T10:05:00Z', '" + tenantA + "', '" + BERLIN_SITE + "', '" + devX
                + "', NULL, NULL, 6.0), "
                + "('2026-01-12T11:00:00Z', '" + tenantA + "', '" + BERLIN_SITE + "', '" + devX
                + "', NULL, NULL, 3.0), "
                + "('2026-01-12T11:05:00Z', '" + tenantA + "', '" + BERLIN_SITE + "', '" + devX
                + "', NULL, NULL, 5.0), "
                + "('2026-01-12T12:00:00Z', '" + tenantA + "', '" + BERLIN_SITE + "', '" + devY
                + "', 1.0, 1.0, 0)");

        // Copy 1 - live day view (raw telemetry): the mixed bucket averages
        // ONLY the samples that carry the channel (import avg(4)=4 -> 1.0 kWh,
        // not the old avg(4, fabricated 0)=2 -> 0.5; battery charge avg(2)=2
        // -> 0.5 kWh), and the generation-only bucket reports NULL grid and
        // battery channels, never 0.
        ResponseEntity<Map<String, Object>> day = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/history?range=day&at=2026-01-12"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(day.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> buckets = list(day.getBody(), "buckets");
        assertThat(buckets).hasSize(3);
        Map<String, Object> mixed = buckets.get(0);
        assertThat(mixed).containsEntry("start", "2026-01-12T10:00:00Z");
        assertThat(num(mixed, "gridImportKwh")).isEqualTo(1.0);
        assertThat(num(mixed, "batteryChargeKwh")).isEqualTo(0.5);
        assertThat(num(mixed, "pvKwh")).isEqualTo(1.0); // avg(2, 6) = 4 kW
        Map<String, Object> genOnly = buckets.get(1);
        assertThat(genOnly).containsEntry("start", "2026-01-12T11:00:00Z");
        assertThat(num(genOnly, "pvKwh")).isEqualTo(1.0); // avg(3, 5) = 4 kW
        assertThat(genOnly.get("gridImportKwh")).isNull();
        assertThat(genOnly.get("gridExportKwh")).isNull();
        assertThat(genOnly.get("batteryChargeKwh")).isNull();
        assertThat(genOnly.get("batteryDischargeKwh")).isNull();

        // Copy 2 - the refresh procedure (feeds the week/month/year rollups
        // AND the earnings engine's CHANNELS_OK gate).
        exec("CALL refresh_telemetry_rollups('2026-01-12T00:00:00Z')");
        String mixed15m = "FROM telemetry_rollup_15m WHERE site_id = '" + BERLIN_SITE
                + "' AND bucket = '2026-01-12T10:00:00Z'";
        String gen15m = "FROM telemetry_rollup_15m WHERE site_id = '" + BERLIN_SITE
                + "' AND bucket = '2026-01-12T11:00:00Z'";
        assertThat(queryLong("SELECT count(*) " + mixed15m
                + " AND grid_import_kwh = 1.0 AND battery_charge_kwh = 0.5 AND pv_kwh = 1.0"))
                .isEqualTo(1);
        assertThat(queryLong("SELECT count(*) " + gen15m
                + " AND grid_import_kwh IS NULL AND grid_export_kwh IS NULL"
                + " AND battery_charge_kwh IS NULL AND battery_discharge_kwh IS NULL"
                + " AND pv_kwh = 1.0")).isEqualTo(1);
        // The 1h cascade keeps NULL as NULL (sum of NULLs), never 0.
        assertThat(queryLong("SELECT count(*) FROM telemetry_rollup_1h WHERE site_id = '"
                + BERLIN_SITE + "' AND bucket = '2026-01-12T11:00:00Z'"
                + " AND grid_import_kwh IS NULL AND pv_kwh = 1.0")).isEqualTo(1);

        // Copy 3 - the purge rebuild: purging the OTHER device recomputes the
        // whole site's rollups through SeriesRepository, which must produce
        // the same NULL-safe numbers.
        assertThat(rest.exchange(url("/api/v1/devices/" + devY + "/purge-data"), HttpMethod.POST,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(queryLong("SELECT count(*) " + mixed15m
                + " AND grid_import_kwh = 1.0 AND battery_charge_kwh = 0.5 AND pv_kwh = 1.0"))
                .isEqualTo(1);
        assertThat(queryLong("SELECT count(*) " + gen15m
                + " AND grid_import_kwh IS NULL AND grid_export_kwh IS NULL"
                + " AND battery_charge_kwh IS NULL AND pv_kwh = 1.0")).isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM telemetry_rollup_15m WHERE site_id = '"
                + BERLIN_SITE + "' AND bucket = '2026-01-12T12:00:00Z'")).isZero();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Map<String, Object> body, String key) {
        return (List<Map<String, Object>>) body.get(key);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> body, String key) {
        return (Map<String, Object>) body.get(key);
    }

    private static double num(Map<String, Object> obj, String key) {
        Object v = obj.get(key);
        assertThat(v).as(key).isNotNull();
        return ((Number) v).doubleValue();
    }

    // ---- fleet overview ------------------------------------------------------

    /**
     * The tenant-wide fleet overview: per-site device liveness (from telemetry
     * ARRIVAL, the store-and-forward rule), the newest live snapshot, and
     * today's planned savings computed server-side over the Europe/Berlin day
     * with the latest-run-per-slot de-duplication - proven with a hand-computed
     * seed. RLS-scoped: tenant B's overview never contains tenant A's sites.
     */
    @Test
    void overviewAggregatesFleetTenantScopedWithBerlinDaySavings() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        // A fresh Direktvermarktungs-site with three devices in the three
        // liveness states: online (fresh arrival), stale (old arrival), waiting
        // (never sent). Fresh site => no interference from other tests' seeds.
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Overview Werk Nord",
                        "plantKind", "direktvermarktung"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(created.getBody()).containsEntry("plantKind", "direktvermarktung");
        String siteId = (String) created.getBody().get("id");

        String onlineDev = claimDeviceInto(demo, siteId, "overview-inv-online");
        String staleDev = claimDeviceInto(demo, siteId, "overview-inv-stale");
        claimDeviceInto(demo, siteId, "overview-inv-waiting");

        // Online device: an old observation first, then the newest one - the
        // live snapshot must be the NEWEST row (3.2/1.1/-0.9/76). Arrivals
        // (received_at) default to now() => the device is online.
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct, "
                + "pv_power_kw, load_kw) VALUES "
                + "(now() - interval '1 hour', '" + tenantA + "', '" + siteId + "', '" + onlineDev
                + "', 9.9, 10.0, 9.9, 9.9), "
                + "(now(), '" + tenantA + "', '" + siteId + "', '" + onlineDev
                + "', -0.9, 76.0, 3.2, 1.1)");
        // Stale device: last arrival an hour ago (received_at set explicitly).
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, received_at) "
                + "VALUES (now() - interval '2 hours', '" + tenantA + "', '" + siteId + "', '"
                + staleDev + "', 1.0, now() - interval '1 hour')");

        // Hand-computed savings seed for today's Europe/Berlin window: one slot
        // planned by TWO runs (only the newer counts: 0.10 - 0.02 = 0.08), a
        // second slot (0.05 - 0.03 = 0.02), and a slot BEFORE Berlin midnight
        // that must be excluded => plannedSavingsTodayEur = 0.10 exactly.
        com.voltpilot.api.history.HistoryRange.Window today =
                com.voltpilot.api.history.HistoryRange.DAY.window(
                        java.time.LocalDate.now(com.voltpilot.api.history.HistoryRange.ZONE));
        String slot1 = "'" + today.from().plus(10, java.time.temporal.ChronoUnit.HOURS) + "'";
        String slot2 = "'" + today.from().plus(615, java.time.temporal.ChronoUnit.MINUTES) + "'";
        String yesterdaySlot = "'" + today.from().minus(15, java.time.temporal.ChronoUnit.MINUTES) + "'";
        exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                + "battery_kw, cost_eur, baseline_cost_eur) VALUES "
                + "(" + slot1 + ", '" + tenantA + "', '" + siteId + "', '" + onlineDev + "', "
                + "'bbbbbbbb-0000-0000-0000-000000000001', now() - interval '2 hours', 1, 0.50, 1.00), "
                + "(" + slot1 + ", '" + tenantA + "', '" + siteId + "', '" + onlineDev + "', "
                + "'bbbbbbbb-0000-0000-0000-000000000002', now() - interval '1 hour', 1, 0.02, 0.10), "
                + "(" + slot2 + ", '" + tenantA + "', '" + siteId + "', '" + onlineDev + "', "
                + "'bbbbbbbb-0000-0000-0000-000000000002', now() - interval '1 hour', 1, 0.03, 0.05), "
                + "(" + yesterdaySlot + ", '" + tenantA + "', '" + siteId + "', '" + onlineDev + "', "
                + "'bbbbbbbb-0000-0000-0000-000000000003', now() - interval '26 hours', 1, 0.00, 100.00)");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/overview"), HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();

        Map<String, Object> site = list(body, "sites").stream()
                .filter(x -> siteId.equals(x.get("id"))).findFirst().orElseThrow();
        assertThat(site).containsEntry("name", "Overview Werk Nord")
                .containsEntry("plantKind", "direktvermarktung")
                .containsEntry("deviceCount", 3)
                .containsEntry("onlineCount", 1)
                .containsEntry("waitingCount", 1)
                // stale beats waiting beats online.
                .containsEntry("worstStatus", "stale");
        assertThat(site.get("lastSeenAt")).isNotNull();
        @SuppressWarnings("unchecked")
        Map<String, Object> live = (Map<String, Object>) site.get("live");
        assertThat(live).as("live snapshot").isNotNull();
        assertThat(num(live, "pvKw")).isEqualTo(3.2);
        assertThat(num(live, "loadKw")).isEqualTo(1.1);
        assertThat(num(live, "gridKw")).isEqualTo(-0.9);
        assertThat(num(live, "socPct")).isEqualTo(76.0);
        // B4 byte-identity: this exact 0.10 pins OverviewRepository.savingsPerSite
        // after its per-site-LATERAL rewrite - the newer of two runs on slot1
        // wins (0.08, not 0.98) AND the slot before Berlin midnight is excluded.
        assertThat(num(site, "plannedSavingsTodayEur"))
                .isCloseTo(0.10, org.assertj.core.data.Offset.offset(1e-9));

        // Totals: consistent with the site list (other tests may add sites, so
        // assert the relations, not absolute fleet numbers).
        Map<String, Object> totals = map(body, "totals");
        assertThat(((Number) totals.get("sites")).intValue())
                .isEqualTo(list(body, "sites").size());
        assertThat(((Number) totals.get("devices")).intValue()).isGreaterThanOrEqualTo(3);
        assertThat(((Number) totals.get("online")).intValue()).isGreaterThanOrEqualTo(1);
        assertThat(((Number) totals.get("liveSitesCovered")).intValue()).isGreaterThanOrEqualTo(1);
        assertThat(num(totals, "plannedSavingsTodayEur")).isGreaterThanOrEqualTo(0.10);

        // The 14-day series carries today's Berlin day (my seed contributes).
        java.time.LocalDate todayBerlin =
                java.time.LocalDate.now(com.voltpilot.api.history.HistoryRange.ZONE);
        List<Map<String, Object>> daily = list(body, "dailySavings");
        Map<String, Object> todayEntry = daily.stream()
                .filter(x -> todayBerlin.toString().equals(x.get("day"))).findFirst().orElseThrow();
        assertThat(num(todayEntry, "savingsEur")).isGreaterThanOrEqualTo(0.10);
        // Yesterday's 100.00 landed in yesterday's bucket, never in today's.
        assertThat(num(todayEntry, "savingsEur")).isLessThan(50.0);

        // RLS: tenant B's overview never contains tenant A's sites or savings.
        ResponseEntity<Map<String, Object>> other = rest.exchange(
                url("/api/v1/overview"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(other.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> otherSites = list(other.getBody(), "sites");
        assertThat(otherSites).extracting(x -> x.get("id")).doesNotContain(siteId);
        assertThat(otherSites).extracting(x -> x.get("name"))
                .contains("Nordwind Hamburg").doesNotContain("Overview Werk Nord");
        assertThat(((Number) map(other.getBody(), "totals").get("sites")).intValue())
                .isEqualTo(otherSites.size());
    }

    /**
     * U5 portfolio rollup: GET /overview additionally carries per-site entity
     * role counts + the effective AE7 usage profile (so the portfolio table
     * renders without N-per-site calls) plus fleet Σ storage kWh/kW, all
     * RLS-scoped.
     */
    @Test
    void overviewCarriesPerSiteRoleCountsUsageProfileAndStorageTotals() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        // A direktvermarktung site (=> arbitrage profile) with a battery asset
        // and a mixed entity set: 2 storage + 3 producers + 1 wallbox + 1 meter.
        String siteId = createSite(demo, "Portfolio Werk Nord", "DE-LU", "direktvermarktung");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantA + "', '"
                + siteId + "', 'battery', 50, 25, 25, 92)");
        exec("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type) VALUES "
                + "('" + tenantA + "', '" + siteId + "', 'battery-hybrid', 'battery-hybrid'), "
                + "('" + tenantA + "', '" + siteId + "', 'battery-hybrid', 'battery-hybrid'), "
                + "('" + tenantA + "', '" + siteId + "', 'producer', 'producer'), "
                + "('" + tenantA + "', '" + siteId + "', 'producer', 'producer'), "
                + "('" + tenantA + "', '" + siteId + "', 'producer', 'producer'), "
                + "('" + tenantA + "', '" + siteId + "', 'wallbox', 'wallbox'), "
                + "('" + tenantA + "', '" + siteId + "', 'grid-meter', 'grid-meter')");
        // A NULL-entity_type point (a v1 source) must NOT be counted as an entity.
        exec("INSERT INTO measurement_point (tenant_id, site_id, role) VALUES "
                + "('" + tenantA + "', '" + siteId + "', 'pv-generation')");

        // A second fresh site with NO entities and eigenverbrauch => private,
        // all role counts zero (registry-less honesty).
        String plainId = createSite(demo, "Portfolio Haus Süd", "DE-LU", "eigenverbrauch");

        Map<String, Object> site = overviewSite(demo, siteId);
        assertThat(site).containsEntry("usageProfile", "arbitrage");
        @SuppressWarnings("unchecked")
        Map<String, Object> roles = (Map<String, Object>) site.get("roleCounts");
        assertThat(roles).as("Σ entities per role").isNotNull();
        assertThat(((Number) roles.get("storage")).intValue()).isEqualTo(2);
        assertThat(((Number) roles.get("pv")).intValue()).isEqualTo(3);
        assertThat(((Number) roles.get("consumer")).intValue()).isEqualTo(1);
        assertThat(((Number) roles.get("grid")).intValue()).isEqualTo(1);

        Map<String, Object> plain = overviewSite(demo, plainId);
        assertThat(plain).containsEntry("usageProfile", "private");
        @SuppressWarnings("unchecked")
        Map<String, Object> plainRoles = (Map<String, Object>) plain.get("roleCounts");
        assertThat(((Number) plainRoles.get("storage")).intValue()).isZero();
        assertThat(((Number) plainRoles.get("pv")).intValue()).isZero();

        // Fleet Σ storage kWh/kW includes this battery (other tests may add more).
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/overview"), HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        Map<String, Object> totals = map(res.getBody(), "totals");
        assertThat(num(totals, "storageCapacityKwh")).isGreaterThanOrEqualTo(50.0);
        assertThat(num(totals, "storagePowerKw")).isGreaterThanOrEqualTo(25.0);

        // RLS: tenant B never sees these sites' rows or role counts.
        List<Map<String, Object>> otherSites = list(rest.exchange(
                url("/api/v1/overview"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody(), "sites");
        assertThat(otherSites).extracting(x -> x.get("id")).doesNotContain(siteId, plainId);
    }

    /**
     * Die {@code laden}-Divergenz des Overviews (Zielbild-Stufe 1 §2.7): das
     * Overview stempelte {@code hasChargePoint} ueber den 7-Arg-Konstruktor auf
     * {@code false}, konnte also NIE {@code laden} melden - waehrend
     * {@code GET /sites/&#123;id&#125;/profile} es sehr wohl tut. Dieselbe Frage
     * mit zwei Antworten; die Regel ist die von
     * {@code UsageProfileService.signals}: der Ladepunkt keyt auf den TYP.
     */
    @Test
    void overviewReportsLadenForAChargePointOnlySiteLikeTheProfileEndpointDoes() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        // Eine reine Ladepark-Anlage: Ladepunkte, KEIN Speicher, KEINE PV.
        String siteId = createSite(demo, "Overview Ladepark", "DE-LU", "eigenverbrauch");
        exec("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type) VALUES "
                + "('" + tenantA + "', '" + siteId + "', 'consumer', 'ev-charger')");

        assertThat(overviewSite(demo, siteId))
                .as("das Overview meldet jetzt dieselbe Wahrheit wie /sites/{id}/profile")
                .containsEntry("usageProfile", "laden");

        ResponseEntity<Map<String, Object>> profile = rest.exchange(
                url("/api/v1/sites/" + siteId + "/profile"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(profile.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(profile.getBody()).containsEntry("usageProfile", "laden");

        // Eine Anlage OHNE Ladepunkt bleibt unveraendert - der Fix weitet nichts.
        String haus = createSite(demo, "Overview Haus ohne Saeule", "DE-LU", "eigenverbrauch");
        assertThat(overviewSite(demo, haus)).containsEntry("usageProfile", "private");
    }

    /**
     * Anwendungs-Programm Stufe 4: die Flotten-Zeile trägt die Zahlen, aus
     * denen das Portfolio-Cockpit seine Bausteine komponiert — und ihre
     * EHRLICHKEIT ist die Aussage.
     *
     * <p>Der Leitfall ist §4.3 C („Gewerbe, reines Monitoring, 3 Filialen"):
     * bis Stufe 3 stand dort „—, —, —", weil die Fläche Geld und Speicher
     * zuerst zeigte und diese Zahlen gar nicht kannte. Geprüft wird beides —
     * dass die Summen ankommen UND dass ein fehlender Kanal {@code null}
     * bleibt statt eine 0 zu erfinden.
     */
    @Test
    void overviewCarriesTheEnergyStorageWeightAndActiveApplicationsOfEachSite() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        // Zwei Filialen: PV + Netz-Zähler, KEIN Speicher, fester Tarif.
        String f1 = createSite(demo, "Stufe4 Filiale Nord", "DE-LU", "eigenverbrauch");
        String f2 = createSite(demo, "Stufe4 Filiale Süd", "DE-LU", "eigenverbrauch");
        for (String id : List.of(f1, f2)) {
            exec("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type) VALUES "
                    + "('" + tenantA + "', '" + id + "', 'producer', 'producer'), "
                    + "('" + tenantA + "', '" + id + "', 'grid-meter', 'grid-meter')");
        }
        // Der laufende Berliner Tag: zwei Viertelstunden je Filiale.
        String tagStart = "date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') "
                + "AT TIME ZONE 'Europe/Berlin'";
        for (String id : List.of(f1, f2)) {
            exec("INSERT INTO telemetry_rollup_15m (tenant_id, site_id, bucket, pv_kwh, "
                    + "load_kwh, grid_import_kwh, grid_export_kwh, n_samples) VALUES "
                    + "('" + tenantA + "', '" + id + "', " + tagStart + ", 40, 70, 34, 4, 90), "
                    + "('" + tenantA + "', '" + id + "', " + tagStart
                    + " + interval '15 minutes', 12, 20, 11, 0, 90)");
        }

        Map<String, Object> nord = overviewSite(demo, f1);
        @SuppressWarnings("unchecked")
        Map<String, Object> energie = (Map<String, Object>) nord.get("energyToday");
        assertThat(energie).as("die Tages-Energie der Anlage").isNotNull();
        assertThat(num(energie, "pvKwh")).isEqualTo(52.0);
        assertThat(num(energie, "loadKwh")).isEqualTo(90.0);
        // Bezug und Einspeisung GETRENNT - nie saldiert.
        assertThat(num(energie, "gridImportKwh")).isEqualTo(45.0);
        assertThat(num(energie, "gridExportKwh")).isEqualTo(4.0);
        // Ohne Batterie KEIN Gewicht - und ausdrücklich keine 0.
        assertThat(nord.get("storageCapacityKwh")).isNull();
        assertThat(((Number) nord.get("chargePointCount")).intValue()).isZero();

        // Die AKTIVEN Anwendungen: der gespeicherte Kundenwille liegt allein
        // auf dem Server, also muss die Zeile ihn tragen.
        @SuppressWarnings("unchecked")
        List<String> anwendungen = (List<String>) nord.get("anwendungen");
        assertThat(anwendungen).as("Monitoring ist Basis und läuft immer").contains("monitoring");
        assertThat(anwendungen).as("ohne Speicher kein Fahrplan")
                .doesNotContain("speicher-fahrplan");

        // Eine Anlage MIT Speicher trägt ihr Gewicht - das ist es, womit der
        // Flotten-Ladestand gewichtet wird (ohne es wäre er das ungewichtete
        // Mittel über Anlagen).
        String werk = createSite(demo, "Stufe4 Werk", "DE-LU", "eigenverbrauch");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantA + "', '"
                + werk + "', 'battery', 120, 60, 60, 92)");
        exec("INSERT INTO measurement_point (tenant_id, site_id, role, entity_type) VALUES "
                + "('" + tenantA + "', '" + werk + "', 'battery-hybrid', 'battery-hybrid'), "
                + "('" + tenantA + "', '" + werk + "', 'consumer', 'ev-charger'), "
                + "('" + tenantA + "', '" + werk + "', 'consumer', 'ev-charger')");
        Map<String, Object> werkRow = overviewSite(demo, werk);
        assertThat(num(werkRow, "storageCapacityKwh")).isEqualTo(120.0);
        // Die Rollen-Zählung fasst Ladepunkte unter `consumer` zusammen und
        // kann die Frage deshalb nicht beantworten - dieses Feld schon.
        assertThat(((Number) werkRow.get("chargePointCount")).intValue()).isEqualTo(2);
        @SuppressWarnings("unchecked")
        List<String> werkAnwendungen = (List<String>) werkRow.get("anwendungen");
        assertThat(werkAnwendungen).contains("monitoring", "speicher-fahrplan");

        // Eine Anlage ganz OHNE verdichtete Viertelstunde behauptet nichts.
        String frisch = createSite(demo, "Stufe4 Frisch", "DE-LU", "eigenverbrauch");
        Map<String, Object> frischRow = overviewSite(demo, frisch);
        assertThat(frischRow.get("energyToday"))
                .as("keine Messung ist keine 0").isNull();

        // RLS: ein fremder Mandant sieht keine dieser Zeilen.
        List<Map<String, Object>> fremd = list(rest.exchange(
                url("/api/v1/overview"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody(), "sites");
        assertThat(fremd).extracting(x -> x.get("id")).doesNotContain(f1, f2, werk, frisch);
    }

    /** plant_kind: defaults to eigenverbrauch, editable through the site paths. */
    @Test
    void sitePlantKindDefaultsAndIsEditableViaSitePaths() {
        String demo = token("demo", "demo");

        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Anlagentyp Test"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(created.getBody()).containsEntry("plantKind", "eigenverbrauch");
        String siteId = (String) created.getBody().get("id");

        ResponseEntity<Map<String, Object>> updated = rest.exchange(
                url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Anlagentyp Test",
                        "plantKind", "direktvermarktung"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(updated.getBody()).containsEntry("plantKind", "direktvermarktung");

        // The list reflects it; an unknown kind is refused by validation.
        assertThat(sites(demo).stream().filter(x -> siteId.equals(x.get("id"))).findFirst()
                .orElseThrow()).containsEntry("plantKind", "direktvermarktung");
        ResponseEntity<String> invalid = rest.exchange(
                url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Anlagentyp Test", "plantKind", "foo"),
                        bearer(demo)),
                String.class);
        assertThat(invalid.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * max_feed_in_kw (FK1, the static connection-point feed-in cap): defaults
     * to null, settable on create and update, null on update KEEPS the stored
     * value (the netzladenErlaubt COALESCE pattern - a form that omits the
     * field never clears the cap), and zero/negative values are refused.
     */
    @Test
    void siteMaxFeedInKwIsOptionalKeptOnOmittedUpdateAndValidatedPositive() {
        String demo = token("demo", "demo");

        // Default: no connection-point limit.
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Einspeisegrenze Test"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(created.getBody().get("maxFeedInKw")).isNull();
        String siteId = (String) created.getBody().get("id");

        // Set the cap via update.
        ResponseEntity<Map<String, Object>> updated = rest.exchange(
                url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Einspeisegrenze Test",
                        "maxFeedInKw", 75.5), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) updated.getBody().get("maxFeedInKw")).doubleValue())
                .isEqualTo(75.5);

        // An update WITHOUT the field keeps the stored cap (COALESCE pattern).
        ResponseEntity<Map<String, Object>> omitted = rest.exchange(
                url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Einspeisegrenze Test"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(omitted.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) omitted.getBody().get("maxFeedInKw")).doubleValue())
                .isEqualTo(75.5);

        // Settable on create too.
        ResponseEntity<Map<String, Object>> capped = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Einspeisegrenze Direkt",
                        "maxFeedInKw", 30), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(capped.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(((Number) capped.getBody().get("maxFeedInKw")).doubleValue())
                .isEqualTo(30.0);

        // Strictly positive: 0 and negative are refused.
        for (Object bad : new Object[] {0, -5}) {
            ResponseEntity<String> invalid = rest.exchange(
                    url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                    new HttpEntity<>(Map.of("name", "Einspeisegrenze Test",
                            "maxFeedInKw", bad), bearer(demo)),
                    String.class);
            assertThat(invalid.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        }
    }

    // ---- realized earnings ---------------------------------------------------

    /**
     * The realized-earnings engine ({@code GET /api/v1/earnings}) on a
     * hand-computed seed: two computable sites in two bidding zones (PT15M
     * price preferred over a coexisting PT60M row, PT60M fallback for an hour
     * without 15-min rows, an unpriced gap slot), a generation-only site
     * (missing_channels), a priceless site (no_prices), a fresh site (no_data),
     * the algebraic identity saved == (discharge - charge) * price/1000, the
     * per-site 14-day dailySaved series, range=all starting at the first
     * covered date, RLS isolation, and the 400 on a bad range.
     *
     * <p>Seed lives on 2026-04-14 (Berlin day = [2026-04-13T22:00Z,
     * 2026-04-14T22:00Z)) in the AT/CH zones - far from every other test's
     * price/rollup seeds and from the dev seed's DE-LU rows.
     */
    @Test
    void earningsComputesRealizedSavingsPerSiteWithHonestDegradation() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String dv = createSite(demo, "Earnings Werk Süd", "AT", "direktvermarktung");
        String ev = createSite(demo, "Earnings Haus West", "CH", "eigenverbrauch");
        String genOnly = createSite(demo, "Earnings Nur-Erzeugung", "CH", "eigenverbrauch");
        String noPrices = createSite(demo, "Earnings Ohne Preise", "CH", "eigenverbrauch");
        String fresh = createSite(demo, "Earnings Frisch", "CH", "eigenverbrauch");

        // Prices: AT 10:00Z has BOTH a PT15M (100) and a decoy PT60M (999) row -
        // the finer resolution must win; AT 11:00Z has only a PT60M row (200) -
        // the fallback; 12:00Z has no AT price at all - the gap. CH 10:00Z = 80.
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "('2026-04-14T10:00:00Z', 'AT', 'PT15M', 100.0, 'EUR', 'test'), "
                + "('2026-04-14T10:00:00Z', 'AT', 'PT60M', 999.0, 'EUR', 'test'), "
                + "('2026-04-14T11:00:00Z', 'AT', 'PT60M', 200.0, 'EUR', 'test'), "
                + "('2026-04-14T10:00:00Z', 'CH', 'PT15M', 80.0, 'EUR', 'test') "
                + "ON CONFLICT DO NOTHING");

        // Rollup buckets, all consistent with the power balance
        // (import - export == load - pv + charge - discharge):
        // DV b1 10:00Z (price 100): load 1.0, pv 0.25, imp 0.5 -> discharge 0.25
        //   baseline (1.0-0.25)*0.1 = 0.075 | actual 0.5*0.1 = 0.05 | saved 0.025
        // DV b2 11:30Z (PT60M 200): load 0.5, pv 1.5, charge 0.25 -> exp 0.75
        //   baseline -1.0*0.2 = -0.20 | actual -0.75*0.2 = -0.15 | saved -0.05
        //   (charging at a high price debits VoltPilot - self-honest)
        // DV b3 12:00Z: measured but unpriced -> counted, not covered.
        // EV b4 10:00Z (CH 80): load 2.0, pv 0.5, discharge 0.5 -> imp 1.0
        //   baseline 1.5*0.08 = 0.12 | actual 1.0*0.08 = 0.08 | saved 0.04
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                + "('2026-04-14T10:00:00Z', '" + tenantA + "', '" + dv + "', 0.25, 1.0, 0.5, 0.0, 0.0, 0.25, 90), "
                + "('2026-04-14T11:30:00Z', '" + tenantA + "', '" + dv + "', 1.5, 0.5, 0.0, 0.75, 0.25, 0.0, 90), "
                + "('2026-04-14T12:00:00Z', '" + tenantA + "', '" + dv + "', 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 90), "
                + "('2026-04-14T10:00:00Z', '" + tenantA + "', '" + ev + "', 0.5, 2.0, 1.0, 0.0, 0.0, 0.5, 90), "
                // generation-only: PV present, load/grid channels absent
                + "('2026-04-14T10:00:00Z', '" + tenantA + "', '" + genOnly + "', 1.0, NULL, NULL, NULL, NULL, NULL, 90), "
                // full channels but no CH price at 12:00Z
                + "('2026-04-14T12:00:00Z', '" + tenantA + "', '" + noPrices + "', 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 90) "
                + "ON CONFLICT DO NOTHING");

        // A recent covered slot for the EV site feeds the 14-day dailySaved
        // series: 15-min bucket two hours ago, CH price 150, discharge 0.4
        // => saved 0.4 * 150/1000 = 0.06 on that bucket's Berlin day.
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "SELECT time_bucket('15 minutes', now() - interval '2 hours'), 'CH', 'PT15M', 150.0, 'EUR', 'test' "
                + "ON CONFLICT DO NOTHING");
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) "
                + "SELECT time_bucket('15 minutes', now() - interval '2 hours'), '" + tenantA + "', '"
                + ev + "', 0.0, 1.0, 0.6, 0.0, 0.0, 0.4, 90 ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/earnings?range=day&at=2026-04-14"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        assertThat(body).containsEntry("range", "day")
                // Berlin-local day window (CEST in April).
                .containsEntry("from", "2026-04-13T22:00:00Z")
                .containsEntry("to", "2026-04-14T22:00:00Z");

        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);
        Map<String, Object> dvSite = siteRow(body, dv);
        assertThat(dvSite).containsEntry("plantKind", "direktvermarktung")
                .containsEntry("coveredSlots", 2)
                .containsEntry("firstCoveredDate", "2026-04-14")
                .containsEntry("reason", null);
        assertThat(num(dvSite, "baselineEur")).isCloseTo(-0.125, eps);
        assertThat(num(dvSite, "actualEur")).isCloseTo(-0.10, eps);
        // The algebraic identity: saved == (discharge - charge) * price/1000
        // over the seed = 0.25*100/1000 + (0.0-0.25)*200/1000 = -0.025, and it
        // equals baseline - actual (round-trip losses debit VoltPilot).
        assertThat(num(dvSite, "savedEur")).isCloseTo(-0.025, eps);
        assertThat(num(dvSite, "savedEur"))
                .isCloseTo(num(dvSite, "baselineEur") - num(dvSite, "actualEur"), eps);
        // Nothing recent for the DV site -> empty dailySaved, never fake zeros.
        assertThat(list(dvSite, "dailySaved")).isEmpty();

        Map<String, Object> evSite = siteRow(body, ev);
        assertThat(num(evSite, "baselineEur")).isCloseTo(0.12, eps);
        assertThat(num(evSite, "actualEur")).isCloseTo(0.08, eps);
        assertThat(num(evSite, "savedEur")).isCloseTo(0.04, eps);
        // The recent slot shows up in the 14-day series on its Berlin day.
        java.time.Instant recentBucket = java.time.Instant.ofEpochSecond(
                java.time.Instant.now().minus(2, java.time.temporal.ChronoUnit.HOURS)
                        .getEpochSecond() / 900 * 900);
        String recentDay = recentBucket.atZone(com.voltpilot.api.history.HistoryRange.ZONE)
                .toLocalDate().toString();
        List<Map<String, Object>> evDaily = list(evSite, "dailySaved");
        Map<String, Object> todayEntry = evDaily.stream()
                .filter(x -> recentDay.equals(x.get("day"))).findFirst().orElseThrow();
        assertThat(num(todayEntry, "savedEur")).isCloseTo(0.06, eps);

        // Honest degradation, machine-readable.
        assertThat(siteRow(body, genOnly)).containsEntry("savedEur", null)
                .containsEntry("reason", "missing_channels");
        assertThat(siteRow(body, noPrices)).containsEntry("savedEur", null)
                .containsEntry("reason", "no_prices");
        assertThat(siteRow(body, fresh)).containsEntry("savedEur", null)
                .containsEntry("reason", "no_data");

        // Totals over the computable sites of THIS Berlin day.
        Map<String, Object> totals = map(body, "totals");
        assertThat(num(totals, "baselineEur")).isCloseTo(-0.005, eps);
        assertThat(num(totals, "actualEur")).isCloseTo(-0.02, eps);
        assertThat(num(totals, "savedEur")).isCloseTo(0.015, eps);
        assertThat(totals).containsEntry("coveredSlots", 3)
                .containsEntry("firstCoveredDate", "2026-04-14");

        // range=all honestly starts at the fleet's first covered slot.
        ResponseEntity<Map<String, Object>> all = rest.exchange(
                url("/api/v1/earnings?range=all"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(all.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(map(all.getBody(), "totals"))
                .containsEntry("firstCoveredDate", "2026-04-14");
        assertThat(all.getBody()).containsEntry("from", "2026-04-13T22:00:00Z");
        // The all-range DV aggregate still carries the April slots.
        assertThat(num(siteRow(all.getBody(), dv), "savedEur")).isCloseTo(-0.025, eps);

        // Default range is month (captain decision).
        ResponseEntity<Map<String, Object>> dflt = rest.exchange(
                url("/api/v1/earnings"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(dflt.getBody()).containsEntry("range", "month");

        // RLS: tenant B's earnings never contain tenant A's sites.
        ResponseEntity<Map<String, Object>> other = rest.exchange(
                url("/api/v1/earnings?range=all"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(other.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list(other.getBody(), "sites")).extracting(x -> x.get("id"))
                .doesNotContain(dv, ev, genOnly, noPrices, fresh);

        // week is deliberately not offered here; garbage is refused too.
        for (String bad : new String[] {"week", "decade"}) {
            ResponseEntity<String> refused = rest.exchange(
                    url("/api/v1/earnings?range=" + bad), HttpMethod.GET,
                    new HttpEntity<>(bearer(demo)), String.class);
            assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        }
    }

    /**
     * The money-centric "Meine Anlage" v2 aggregates (captain 2026-07-07): per
     * site the Einspeise-Erlös (metered export x spot + Marktprämie), the
     * Eigenverbrauchs-kWh, the Eigenverbrauchs-Wert in euros ONLY when a tariff
     * is set (never fabricated), the Gesamtertrag = Einspeise-Erlös +
     * Eigenverbrauchs-Wert, the energy sums, the Ertrag chart series and the
     * 12-month strip. Hand-computed over two current-month CH slots (midday
     * export+charge, evening import+discharge); one site carries a fest 30 ct/kWh
     * tariff, its twin carries none/ohne (the honest kWh-only regression). The
     * dynamic path has its own test below.
     *
     * <p>Seeded now()-relative INSIDE the current Berlin month (month-start + 10
     * days) so the month range, the day-bucketed series and the today-anchored
     * strip all see the same slots regardless of wall-clock, in a fresh CH site
     * whose rollups never collide with the dev DE-LU seed.
     */
    @Test
    void earningsExposeGesamtertragEnergyAndSeriesForTheMoneyView() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String withTariff = createSiteWithTarif(demo, "MV Haus", "CH", "eigenverbrauch", "fest", "30");
        String noTariff = createSite(demo, "MV Ohne", "CH", "eigenverbrauch");

        // Two 15-min slots on the same Berlin day, month-start + 10 days:
        //   11:00 (CH price 100): pv 2.0, load 0.5, export 1.0, charge 0.5
        //     -> einspeise 1.0*100/1000 = 0.10 | selbstverbrauch max(0.5-0,0)=0.5
        //   18:00 (CH price 200): pv 0, load 1.5, import 1.0, discharge 0.5
        //     -> einspeise 0 | selbstverbrauch max(1.5-1.0,0)=0.5
        // Totals: einspeise 0.10, selbstverbrauch 1.0 kWh, eingespeist 1.0 kWh,
        //   batterie bewegt (charge+discharge) 1.0 kWh.
        //   with tariff 30 ct: eigenverbrauchsWert 1.0*30/100 = 0.30,
        //   gesamtertrag 0.10 + 0.30 = 0.40. without tariff: gesamtertrag 0.10.
        String t1 = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '10 days 11 hours') AT TIME ZONE 'Europe/Berlin'";
        String t2 = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '10 days 18 hours') AT TIME ZONE 'Europe/Berlin'";
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "VALUES (" + t1 + ", 'CH', 'PT15M', 100.0, 'EUR', 'test'), "
                + "(" + t2 + ", 'CH', 'PT15M', 200.0, 'EUR', 'test') ON CONFLICT DO NOTHING");
        for (String site : new String[] {withTariff, noTariff}) {
            exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                    + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                    + "(" + t1 + ", '" + tenantA + "', '" + site + "', 2.0, 0.5, 0.0, 1.0, 0.5, 0.0, 90), "
                    + "(" + t2 + ", '" + tenantA + "', '" + site + "', 0.0, 1.5, 1.0, 0.0, 0.0, 0.5, 90) "
                    + "ON CONFLICT DO NOTHING");
        }

        // strip=true opts into the 12-month strip (finding B5: it is now
        // computed only on demand, empty otherwise); this test asserts it.
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/earnings?range=month&strip=true"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);

        Map<String, Object> withRow = siteRow(body, withTariff);
        assertThat(withRow.get("tarifArt")).isEqualTo("fest");
        assertThat(num(withRow, "tarifParamCtKwh")).isCloseTo(30.0, eps);
        assertThat(num(withRow, "einspeiseErloesEur")).isCloseTo(0.10, eps);
        assertThat(num(withRow, "selbstverbrauchKwh")).isCloseTo(1.0, eps);
        assertThat(num(withRow, "eigenverbrauchsWertEur")).isCloseTo(0.30, eps);
        assertThat(num(withRow, "gesamtertragEur")).isCloseTo(0.40, eps);
        // Gesamtertrag reconciles with its parts, exactly.
        assertThat(num(withRow, "gesamtertragEur"))
                .isCloseTo(num(withRow, "einspeiseErloesEur")
                        + num(withRow, "eigenverbrauchsWertEur"), eps);
        assertThat(num(withRow, "eingespeistKwh")).isCloseTo(1.0, eps);
        assertThat(num(withRow, "batterieBewegtKwh")).isCloseTo(1.0, eps);

        // The Ertrag series is DAY-bucketed for the month range: one bucket
        // (both slots on the same day) carrying the day's Gesamtertrag.
        List<Map<String, Object>> series = list(withRow, "series");
        assertThat(series).hasSize(1);
        assertThat(num(series.get(0), "gesamtertragEur")).isCloseTo(0.40, eps);
        // The 12-month strip carries the current month's Gesamtertrag.
        List<Map<String, Object>> strip = list(withRow, "monthlyStrip");
        assertThat(strip).hasSize(1);
        assertThat(num(strip.get(0), "gesamtertragEur")).isCloseTo(0.40, eps);

        // B5 opt-in: WITHOUT strip=true the strip is not computed (empty), so
        // the fixed ~173 ms 12-month scan never runs on the default poll.
        ResponseEntity<Map<String, Object>> noStrip = rest.exchange(
                url("/api/v1/earnings?range=month"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(list(siteRow(noStrip.getBody(), withTariff), "monthlyStrip")).isEmpty();

        // No tariff => self-consumption stays kWh-only, NEVER a fabricated euro,
        // and the Gesamtertrag is the feed-in revenue alone.
        Map<String, Object> withoutRow = siteRow(body, noTariff);
        assertThat(withoutRow).containsEntry("tarifArt", "ohne")
                .containsEntry("tarifParamCtKwh", null)
                .containsEntry("eigenverbrauchsWertEur", null);
        assertThat(num(withoutRow, "selbstverbrauchKwh")).isCloseTo(1.0, eps);
        assertThat(num(withoutRow, "einspeiseErloesEur")).isCloseTo(0.10, eps);
        assertThat(num(withoutRow, "gesamtertragEur")).isCloseTo(0.10, eps);
        assertThat(num(list(withoutRow, "series").get(0), "gesamtertragEur")).isCloseTo(0.10, eps);

        // RLS: tenant B never sees these sites.
        ResponseEntity<Map<String, Object>> other = rest.exchange(
                url("/api/v1/earnings?range=month"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(list(other.getBody(), "sites")).extracting(x -> x.get("id"))
                .doesNotContain(withTariff, noTariff);
    }

    /**
     * The DYNAMIC tariff (captain decision 2026-07-08, "Meine Anlage
     * nachvollziehbar"): a dynamisch site's self-consumed energy is valued
     * SLOT BY SLOT at that quarter hour's Börsenpreis + the fixed Aufschlag -
     * NOT at a single fixed price. Hand-computed over three current-month CH
     * slots at prices 100 / 200 / -40 EUR/MWh (the negative slot proves the spot
     * part follows the price down while the Aufschlag keeps the value positive),
     * cross-checked against a fest twin with the SAME measurements (whose
     * price-independent value differs), plus a previous-month slot the month
     * window must exclude.
     */
    @Test
    void earningsValueDynamicSelfConsumptionSlotBySlotAtSpotPlusAufschlag() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        // Aufschlag 18 ct/kWh on the spot price; a fest twin at 30 ct/kWh.
        String dyn = createSiteWithTarif(demo, "MV Dyn", "CH", "eigenverbrauch", "dynamisch", "18");
        String fest = createSiteWithTarif(demo, "MV Fest", "CH", "eigenverbrauch", "fest", "30");

        // Three slots on the same Berlin day (month-start + 12 days):
        //   11:00 price 100: pv 2.0 load 0.5 export 1.0 -> sv 0.5, einspeise 0.10,
        //          dyn 0.5*(0.10+0.18)=0.14
        //   18:00 price 200: load 1.5 import 1.0        -> sv 0.5, dyn 0.5*(0.20+0.18)=0.19
        //   03:00 price -40: load 1.0 import 0.4        -> sv 0.6, dyn 0.6*(-0.04+0.18)=0.084
        //   dyn eigenverbrauchsWert 0.414, sv 1.6 kWh, eingespeist 1.0, einspeise 0.10,
        //   gesamt 0.514. fest twin (30 ct, price-independent): 1.6*0.30=0.48, gesamt 0.58.
        String ta = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '12 days 11 hours') AT TIME ZONE 'Europe/Berlin'";
        String tb = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '12 days 18 hours') AT TIME ZONE 'Europe/Berlin'";
        String tc = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '12 days 3 hours') AT TIME ZONE 'Europe/Berlin'";
        // A previous-month slot the range=month window must NOT count.
        String tprev = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " - interval '5 days' + interval '12 hours') AT TIME ZONE 'Europe/Berlin'";
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "VALUES (" + ta + ", 'CH', 'PT15M', 100.0, 'EUR', 'test'), "
                + "(" + tb + ", 'CH', 'PT15M', 200.0, 'EUR', 'test'), "
                + "(" + tc + ", 'CH', 'PT15M', -40.0, 'EUR', 'test'), "
                + "(" + tprev + ", 'CH', 'PT15M', 500.0, 'EUR', 'test') ON CONFLICT DO NOTHING");
        for (String site : new String[] {dyn, fest}) {
            exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                    + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                    + "(" + ta + ", '" + tenantA + "', '" + site + "', 2.0, 0.5, 0.0, 1.0, 0.0, 0.0, 90), "
                    + "(" + tb + ", '" + tenantA + "', '" + site + "', 0.0, 1.5, 1.0, 0.0, 0.0, 0.0, 90), "
                    + "(" + tc + ", '" + tenantA + "', '" + site + "', 0.0, 1.0, 0.4, 0.0, 0.0, 0.0, 90), "
                    + "(" + tprev + ", '" + tenantA + "', '" + site + "', 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 90) "
                    + "ON CONFLICT DO NOTHING");
        }

        // strip=true opts into the 12-month strip (finding B5); this test
        // asserts its window logic.
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/earnings?range=month&strip=true"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);

        Map<String, Object> dynRow = siteRow(body, dyn);
        assertThat(dynRow.get("tarifArt")).isEqualTo("dynamisch");
        assertThat(num(dynRow, "tarifParamCtKwh")).isCloseTo(18.0, eps);
        // Slot-by-slot spot + Aufschlag - NOT selbstverbrauch x a single price.
        assertThat(num(dynRow, "eigenverbrauchsWertEur")).isCloseTo(0.414, eps);
        assertThat(num(dynRow, "selbstverbrauchKwh")).isCloseTo(1.6, eps);
        assertThat(num(dynRow, "einspeiseErloesEur")).isCloseTo(0.10, eps);
        assertThat(num(dynRow, "gesamtertragEur")).isCloseTo(0.514, eps);
        // Reconciles with its parts, exactly.
        assertThat(num(dynRow, "gesamtertragEur")).isCloseTo(
                num(dynRow, "einspeiseErloesEur") + num(dynRow, "eigenverbrauchsWertEur"), eps);
        // The month series (one day) carries only the current month's slots -
        // the previous-month slot is excluded (else it would inflate the day).
        assertThat(num(list(dynRow, "series").get(0), "gesamtertragEur")).isCloseTo(0.514, eps);
        // The 12-month strip DOES span months (oldest first): the previous month
        // shows the excluded slot's value on its own, the current month (newest,
        // last) shows 0.514 - proving the window logic, not a leak.
        List<Map<String, Object>> dynStrip = list(dynRow, "monthlyStrip");
        assertThat(num(dynStrip.get(dynStrip.size() - 1), "gesamtertragEur")).isCloseTo(0.514, eps);
        assertThat(num(dynStrip.get(0), "gesamtertragEur")).isCloseTo(1.36, eps);

        // The fest twin: identical measurements, a price-INDEPENDENT value that
        // differs from the dynamic one - proving the dynamic path really uses
        // per-slot spot prices, not the flat tariff.
        Map<String, Object> festRow = siteRow(body, fest);
        assertThat(festRow.get("tarifArt")).isEqualTo("fest");
        assertThat(num(festRow, "eigenverbrauchsWertEur")).isCloseTo(0.48, eps);
        assertThat(num(festRow, "gesamtertragEur")).isCloseTo(0.58, eps);
        assertThat(num(festRow, "eigenverbrauchsWertEur"))
                .isNotCloseTo(num(dynRow, "eigenverbrauchsWertEur"), org.assertj.core.data.Offset.offset(0.05));
    }

    /**
     * The PS-4 peak-shaving proof on the earnings response ("Vermiedene
     * Spitze: X kW × Y €/kW = Z €"): for a module-active site (non-NULL
     * Leistungspreis, migration V20260716020000) the RUNNING Europe/Berlin
     * billing period's MEASURED grid-import peak (max 15-min mean from the
     * rollups, kWh × 4) vs. the COUNTERFACTUAL no-battery peak (per bucket
     * {@code max(0, import - export + discharge - charge)} × 4 - the same
     * plant with the battery idle), avoided kW/EUR and the per-period history.
     *
     * <p>Hand-computed properties proven: the per-period max semantics
     * (measured 8 kW and baseline 12 kW both peak in bucket A while bucket B's
     * battery-raised import moves neither), PRICE-independence (no day-ahead
     * price is seeded for these buckets - the peak block computes regardless
     * of the money fields' price coverage), buckets without a measured
     * grid_import are skipped (never zeroed), the avoided floor at 0 (a jahr
     * site whose battery grid-charged INTO the period peak reads 0 avoided,
     * never a negative "saving"), monat vs jahr period windows + history
     * (current price applied to the closed previous period), the honest
     * no-measurement state (config echoed, peaks null, history empty), null
     * for non-module sites, and RLS.
     *
     * <p>Seeded now()-relative at the current Berlin MONTH start (+10/11 h -
     * always inside the running month AND year) in fresh CH sites, so nothing
     * collides with the dev seed or other tests' pinned rollup contents.
     */
    @Test
    void earningsExposeThePeakShavingProofPerBillingPeriod() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String monat = createSite(demo, "PS Werk Monat", "CH", "eigenverbrauch");
        String jahr = createSite(demo, "PS Werk Jahr", "CH", "eigenverbrauch");
        String unmeasured = createSite(demo, "PS Werk Frisch", "CH", "eigenverbrauch");
        String plain = createSite(demo, "PS Ohne Vertrag", "CH", "eigenverbrauch");

        // The module contract is ADMIN-configured (optimizer-config endpoint,
        // covered by AdminApiTest) - seed the columns directly here.
        exec("UPDATE site SET leistungspreis_eur_kw = 120, abrechnung_leistung = 'monat' "
                + "WHERE id = '" + monat + "'");
        exec("UPDATE site SET leistungspreis_eur_kw = 100, abrechnung_leistung = 'jahr' "
                + "WHERE id IN ('" + jahr + "', '" + unmeasured + "')");

        // monat site, current month (all consistent with the power balance):
        //   A: import 2.0, discharge 1.0 -> measured 8 kW,
        //      baseline (2.0 - 0 + 1.0 - 0)*4 = 12 kW  (the period max of BOTH)
        //   B: import 1.0, charge 0.5    -> measured 4 kW, baseline 2 kW
        //   C: grid_import NULL           -> skipped, never zeroed
        // Previous month: import 3.0, discharge 0.5 -> measured 12, baseline 14
        //   -> avoided 2 kW × 120 = 240 € (closed period, current price).
        String bA = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '10 hours') AT TIME ZONE 'Europe/Berlin'";
        String bB = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '11 hours') AT TIME ZONE 'Europe/Berlin'";
        String bC = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '12 hours') AT TIME ZONE 'Europe/Berlin'";
        String bPrev = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " - interval '10 days' + interval '12 hours') AT TIME ZONE 'Europe/Berlin'";
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                + "(" + bA + ", '" + tenantA + "', '" + monat + "', 0.0, 3.0, 2.0, 0.0, 0.0, 1.0, 90), "
                + "(" + bB + ", '" + tenantA + "', '" + monat + "', 0.0, 0.5, 1.0, 0.0, 0.5, 0.0, 90), "
                + "(" + bC + ", '" + tenantA + "', '" + monat + "', 1.0, NULL, NULL, NULL, NULL, NULL, 90), "
                + "(" + bPrev + ", '" + tenantA + "', '" + monat + "', 0.0, 3.5, 3.0, 0.0, 0.0, 0.5, 90), "
                // jahr site: the battery grid-charged INTO the year's peak -
                // measured 20 kW vs baseline (5.0 - 2.0)*4 = 12 kW.
                + "(" + bA + ", '" + tenantA + "', '" + jahr + "', 0.0, 3.0, 5.0, 0.0, 2.0, 0.0, 90) "
                + "ON CONFLICT DO NOTHING");

        java.time.LocalDate today =
                java.time.LocalDate.now(com.voltpilot.api.history.HistoryRange.ZONE);
        String monthStart = today.withDayOfMonth(1).toString();
        String prevMonthStart = today.withDayOfMonth(1).minusMonths(1).toString();
        String yearStart = today.withDayOfYear(1).toString();
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/earnings?range=month"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();

        Map<String, Object> monatPeak = map(siteRow(body, monat), "peakShaving");
        assertThat(monatPeak).containsEntry("abrechnung", "monat")
                .containsEntry("periodStart", monthStart);
        assertThat(num(monatPeak, "leistungspreisEurKw")).isCloseTo(120.0, eps);
        assertThat(num(monatPeak, "peakKw")).isCloseTo(8.0, eps);
        assertThat(num(monatPeak, "baselinePeakKw")).isCloseTo(12.0, eps);
        assertThat(num(monatPeak, "avoidedKw")).isCloseTo(4.0, eps);
        assertThat(num(monatPeak, "avoidedEur")).isCloseTo(480.0, eps);
        // History: previous + running month, ascending, priced at the current
        // contract; the NULL-import bucket never fabricated a period.
        List<Map<String, Object>> history = list(monatPeak, "history");
        assertThat(history).hasSize(2);
        assertThat(history.get(0)).containsEntry("periodStart", prevMonthStart);
        assertThat(num(history.get(0), "peakKw")).isCloseTo(12.0, eps);
        assertThat(num(history.get(0), "baselinePeakKw")).isCloseTo(14.0, eps);
        assertThat(num(history.get(0), "avoidedKw")).isCloseTo(2.0, eps);
        assertThat(num(history.get(0), "avoidedEur")).isCloseTo(240.0, eps);
        assertThat(history.get(1)).containsEntry("periodStart", monthStart);
        assertThat(num(history.get(1), "avoidedEur")).isCloseTo(480.0, eps);

        // The jahr site: year window, and the avoided peak FLOORS at 0 when
        // the battery raised the period peak - never a negative "saving".
        Map<String, Object> jahrPeak = map(siteRow(body, jahr), "peakShaving");
        assertThat(jahrPeak).containsEntry("abrechnung", "jahr")
                .containsEntry("periodStart", yearStart);
        assertThat(num(jahrPeak, "peakKw")).isCloseTo(20.0, eps);
        assertThat(num(jahrPeak, "baselinePeakKw")).isCloseTo(12.0, eps);
        assertThat(num(jahrPeak, "avoidedKw")).isCloseTo(0.0, eps);
        assertThat(num(jahrPeak, "avoidedEur")).isCloseTo(0.0, eps);

        // Module active but nothing measured yet: config echoed, peaks null,
        // history empty - never fabricated zeros.
        Map<String, Object> freshPeak = map(siteRow(body, unmeasured), "peakShaving");
        assertThat(num(freshPeak, "leistungspreisEurKw")).isCloseTo(100.0, eps);
        assertThat(freshPeak).containsEntry("periodStart", yearStart)
                .containsEntry("peakKw", null)
                .containsEntry("baselinePeakKw", null)
                .containsEntry("avoidedKw", null)
                .containsEntry("avoidedEur", null);
        assertThat(list(freshPeak, "history")).isEmpty();

        // No Leistungspreis = module off = no block, on every range.
        assertThat(siteRow(body, plain)).containsEntry("peakShaving", null);
        ResponseEntity<Map<String, Object>> all = rest.exchange(
                url("/api/v1/earnings?range=all"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        // Range-independent: the same running-period numbers under range=all.
        assertThat(num(map(siteRow(all.getBody(), monat), "peakShaving"), "avoidedEur"))
                .isCloseTo(480.0, eps);

        // RLS: tenant B never sees these sites (or their peaks).
        ResponseEntity<Map<String, Object>> other = rest.exchange(
                url("/api/v1/earnings?range=month"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(list(other.getBody(), "sites")).extracting(x -> x.get("id"))
                .doesNotContain(monat, jahr, unmeasured, plain);
    }

    /**
     * The DYNAMIC Marktprämie (captain domain fix 2026-07-07): fixed is the
     * plant's ANZULEGENDER WERT; the premium per exported kWh in month M is
     * {@code max(0, anzulegender Wert - Monatsmarktwert Solar(M))}, credited on
     * BOTH comparison sides (metered export on the actual side, the
     * immediate-feed-in surplus {@code max(pv - load, 0)} on the baseline
     * side), SUSPENDED in negative-price slots (simplified §51-EEG rule).
     * Hand-computed across a MONTH BOUNDARY with two different monthly premia
     * (Mar: 8-5 = 3 ct, Apr provisional: 8-7 = 1 ct), a floored month (Feb:
     * market value 9.5 ABOVE the 8.0 reference -> premium 0, never negative), a
     * month WITHOUT a market-value row (Jan -> no premium, nothing invented),
     * a NULL anzulegender Wert (byte-identical pure-spot regression) and an
     * Eigenverbrauch site with one (inert). Plus the benchmark KPI (realized
     * export-weighted ct/kWh vs export-weighted Monatsmarktwert incl. the
     * provisional flag and its separate denominators), field round-trip,
     * validation, edit path and RLS.
     *
     * <p>Seed lives on 2026-01-31/02-28/03-31/04-01 in the AT zone - far from
     * every other seed; the market-value months are OWNED via ON CONFLICT DO
     * UPDATE (the seedHistoryDay price rule; the dev seed's rows are
     * now()-relative and never reach early 2026).
     */
    @Test
    void earningsUseTheDynamicMonthlyPremiumFromAnzulegenderWertAndMonatsmarktwert() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String aw = createSite(demo, "AW Werk", "AT", "direktvermarktung", "8.0");
        String plain = createSite(demo, "AW Ohne", "AT", "direktvermarktung", null);
        String evAw = createSite(demo, "AW Haus", "AT", "eigenverbrauch", "8.0");

        // The configured anzulegender Wert round-trips through create + list.
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);
        assertThat(num(sites(demo).stream().filter(x -> aw.equals(x.get("id")))
                .findFirst().orElseThrow(), "anzulegenderWertCtKwh")).isCloseTo(8.0, eps);
        assertThat(sites(demo).stream().filter(x -> plain.equals(x.get("id")))
                .findFirst().orElseThrow().get("anzulegenderWertCtKwh")).isNull();

        // Monatsmarktwerte Solar: Feb ABOVE the reference (premium floored at
        // 0), Mar 5.0 published (premium 3 ct), Apr 7.0 PROVISIONAL (premium
        // 1 ct); January deliberately has NO row.
        exec("INSERT INTO monthly_market_value (month, technology, value_ct_kwh, provisional, source) VALUES "
                + "('2026-02-01', 'solar', 9.5, FALSE, 'test'), "
                + "('2026-03-01', 'solar', 5.0, FALSE, 'test'), "
                + "('2026-04-01', 'solar', 7.0, TRUE, 'test') "
                + "ON CONFLICT (technology, month) DO UPDATE SET value_ct_kwh = EXCLUDED.value_ct_kwh,"
                + " provisional = EXCLUDED.provisional, source = EXCLUDED.source");

        // 15-min prices (all noon UTC = Berlin afternoon, months unambiguous).
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "('2026-01-31T12:00:00Z', 'AT', 'PT15M', 100.0, 'EUR', 'test'), "
                + "('2026-02-28T12:00:00Z', 'AT', 'PT15M', 100.0, 'EUR', 'test'), "
                + "('2026-03-31T12:00:00Z', 'AT', 'PT15M', 100.0, 'EUR', 'test'), "
                + "('2026-03-31T12:15:00Z', 'AT', 'PT15M', -50.0, 'EUR', 'test'), "
                + "('2026-04-01T12:00:00Z', 'AT', 'PT15M', 200.0, 'EUR', 'test') "
                + "ON CONFLICT DO NOTHING");

        // Export slot shape A (positive price, battery idle, sub-slot
        // interleaving: imp 0.25 AND exp 1.25, baseline surplus = 1.0):
        //   spot: baseline (1.0-2.0)*price/1000 | actual (0.25-1.25)*price/1000
        //   premium rate r ct/kWh: baseline -= 1.0*r/100 | actual -= 1.25*r/100
        // Slot shape B (negative price -50, charge 0.5 -> exp 1.0): premium
        //   SUSPENDED. spot: baseline (0.5-2.0)*-0.05 = 0.075 | actual
        //   (0-1.0)*-0.05 = 0.05.
        String shapeA = "', 2.0, 1.0, 0.25, 1.25, 0.0, 0.0, 90)";
        for (String siteId : new String[] {aw, plain, evAw}) {
            exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                    + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                    + "('2026-02-28T12:00:00Z', '" + tenantA + "', '" + siteId + shapeA + ", "
                    + "('2026-03-31T12:00:00Z', '" + tenantA + "', '" + siteId + shapeA + ", "
                    + "('2026-03-31T12:15:00Z', '" + tenantA + "', '" + siteId + "', 2.0, 0.5, 0.0, 1.0, 0.5, 0.0, 90), "
                    + "('2026-04-01T12:00:00Z', '" + tenantA + "', '" + siteId + shapeA + " "
                    + "ON CONFLICT DO NOTHING");
        }
        // Only the AW site also has a January slot - its month has NO market
        // value, so no premium may be invented for it.
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                + "('2026-01-31T12:00:00Z', '" + tenantA + "', '" + aw + shapeA + " "
                + "ON CONFLICT DO NOTHING");

        // range=all spans the whole seed (these sites exist only in it).
        Map<String, Object> body = rest.exchange(
                url("/api/v1/earnings?range=all"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();

        // AW site, hand-computed:
        //   Jan (no MW):  base -0.10          | act -0.10
        //   Feb (r=0):    base -0.10          | act -0.10
        //   Mar (r=3ct):  base -0.10-0.03     | act -0.10-0.0375
        //   Mar (neg):    base  0.075         | act  0.05
        //   Apr (r=1ct):  base -0.20-0.01     | act -0.20-0.0125
        //   => totals: base -0.465 | act -0.50 | saved 0.035
        Map<String, Object> awSite = siteRow(body, aw);
        assertThat(num(awSite, "anzulegenderWertCtKwh")).isCloseTo(8.0, eps);
        assertThat(num(awSite, "baselineEur")).isCloseTo(-0.465, eps);
        assertThat(num(awSite, "actualEur")).isCloseTo(-0.50, eps);
        assertThat(num(awSite, "savedEur")).isCloseTo(0.035, eps);
        // The premium delta vs the pure-spot twin is exactly the two months'
        // (actual - baseline) premium: (0.0375-0.03) + (0.0125-0.01) = 0.01.

        // Benchmark KPI: realized = sum(exp*price)/10/sum(exp) over ALL priced
        // slots = (125+125+125-50+250)/10 / 6.0; market value = sum(exp*mv)/
        // sum(exp) over slots WHOSE MONTH HAS one (Jan drops out - separate
        // denominators) = (1.25*9.5 + 1.25*5.0 + 1.0*5.0 + 1.25*7.0) / 4.75;
        // April is provisional -> flag true.
        assertThat(num(awSite, "realizedExportCtKwh")).isCloseTo(575.0 / 10 / 6.0, eps);
        assertThat(num(awSite, "marketValueSolarCtKwh")).isCloseTo(31.875 / 4.75, eps);
        assertThat(awSite).containsEntry("marketValueProvisional", true);

        // NULL anzulegender Wert: byte-identical pure-spot numbers.
        //   base: -0.10 -0.10 +0.075 -0.20 = -0.325 | act: -0.35 | saved 0.025
        Map<String, Object> plainSite = siteRow(body, plain);
        assertThat(plainSite.get("anzulegenderWertCtKwh")).isNull();
        assertThat(num(plainSite, "baselineEur")).isCloseTo(-0.325, eps);
        assertThat(num(plainSite, "actualEur")).isCloseTo(-0.35, eps);
        assertThat(num(plainSite, "savedEur")).isCloseTo(0.025, eps);
        // The benchmark is plant-kind-agnostic data; the portal shows it for
        // Direktvermarktung only.
        assertThat(num(plainSite, "realizedExportCtKwh")).isCloseTo(450.0 / 10 / 4.75, eps);

        // Eigenverbrauch never earns the premium, configured or not.
        Map<String, Object> evSite = siteRow(body, evAw);
        assertThat(num(evSite, "baselineEur")).isCloseTo(-0.325, eps);
        assertThat(num(evSite, "savedEur")).isCloseTo(0.025, eps);

        // A published-months-only window carries provisional=false and the
        // day's own weighted numbers: realized = (125-50)/10/2.25, market
        // value = 5.0 (both slots in March).
        Map<String, Object> march = rest.exchange(
                url("/api/v1/earnings?range=day&at=2026-03-31"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        Map<String, Object> awMarch = siteRow(march, aw);
        assertThat(num(awMarch, "baselineEur")).isCloseTo(-0.13 + 0.075, eps);
        assertThat(num(awMarch, "actualEur")).isCloseTo(-0.1375 + 0.05, eps);
        assertThat(num(awMarch, "savedEur")).isCloseTo(0.0325, eps);
        assertThat(num(awMarch, "realizedExportCtKwh")).isCloseTo(75.0 / 10 / 2.25, eps);
        assertThat(num(awMarch, "marketValueSolarCtKwh")).isCloseTo(5.0, eps);
        assertThat(awMarch).containsEntry("marketValueProvisional", false);

        // A negative anzulegender Wert is refused by validation.
        ResponseEntity<String> invalid = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "AW Negativ", "biddingZone", "AT",
                        "plantKind", "direktvermarktung", "anzulegenderWertCtKwh", -1.0),
                        bearer(demo)),
                String.class);
        assertThat(invalid.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Editable via the normal site update path.
        ResponseEntity<Map<String, Object>> updated = rest.exchange(
                url("/api/v1/sites/" + plain), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "AW Ohne", "biddingZone", "AT",
                        "plantKind", "direktvermarktung", "anzulegenderWertCtKwh", 9.11),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(num(updated.getBody(), "anzulegenderWertCtKwh")).isCloseTo(9.11, eps);

        // RLS: tenant B sees neither the sites nor their premium earnings.
        ResponseEntity<Map<String, Object>> other = rest.exchange(
                url("/api/v1/earnings?range=all"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(list(other.getBody(), "sites")).extracting(x -> x.get("id"))
                .doesNotContain(aw, plain, evAw);
    }

    /**
     * The "davon Arbitrage-Gewinn" split (captain pick 2026-07-07): a
     * netzladen-erlaubt site's saved splits into {@code arbitrageEur} (what
     * the grid-charging permission earned - storage-mix attribution, see
     * EarningsRepository.arbitrageSplit) and {@code pvShiftEur} (the
     * remainder), hand-computed over a multi-slot day: pre-window discharge
     * (attributed to solar - conservative), cheap-night grid charge, noon PV
     * charge, expensive-evening discharge drawing 50/50 from the mix. The
     * parts reconcile with the total EXACTLY; an EEG twin with IDENTICAL
     * measurements gets NO split (the flag gates it); a merchant site that
     * only solar-charged in the window gets NO split either (no fake zero);
     * fleet totals reconcile with sites-without-split counting as PV-shift;
     * RLS hides it all from another tenant.
     *
     * <p>Seed lives on 2026-05-12 (Berlin day = [2026-05-11T22:00Z,
     * 2026-05-12T22:00Z)) in the AT zone - far from every other seed.
     */
    @Test
    void earningsSplitArbitrageFromPvShiftForGridChargingSites() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String merchant = createSite(demo, "Arbitrage Werk", "AT", "direktvermarktung");
        String eegTwin = createSite(demo, "Arbitrage EEG-Zwilling", "AT", "eigenverbrauch");
        String solarOnly = createSite(demo, "Arbitrage Nur-Solar", "AT", "eigenverbrauch");
        // The switch is admin-only via the API (proven in AdminApiTest); the
        // earnings math only cares about the stored flag, so set it directly.
        exec("UPDATE site SET netzladen_erlaubt = TRUE WHERE id IN ('"
                + merchant + "', '" + solarOnly + "')");

        // Four PT15M price slots: cheap night, noon, expensive evening.
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "('2026-05-12T01:00:00Z', 'AT', 'PT15M', 100.0, 'EUR', 'test'), "
                + "('2026-05-12T02:00:00Z', 'AT', 'PT15M', 20.0, 'EUR', 'test'), "
                + "('2026-05-12T11:00:00Z', 'AT', 'PT15M', 50.0, 'EUR', 'test'), "
                + "('2026-05-12T18:00:00Z', 'AT', 'PT15M', 200.0, 'EUR', 'test') "
                + "ON CONFLICT DO NOTHING");

        // Merchant walk, hand-computed (power balance holds per slot):
        // b0 01:00Z (100): dis 0.2 before ANY tracked charge -> pools empty,
        //   the revenue 0.02 goes to the PV side (pre-window content = solar).
        // b1 02:00Z (20): pv 0, chg 1.0 -> gridCharge 1.0 @ 20 => arb -0.02.
        // b2 11:00Z (50): pv 2.0, load 0.5, chg 1.0 <= surplus 1.5 -> pvCharge.
        // b3 18:00Z (200): dis 1.0 from mix {grid 1.0, pv 1.0} -> 0.5 grid
        //   => arb += 0.5*0.2 = 0.10.
        // arbitrage = 0.08; saved = 0.02 - 0.02 - 0.05 + 0.20 = 0.15;
        // pvShift = 0.07 (= 0.02 pre-window - 0.05 pv charge + 0.10 pv draw).
        for (String siteId : new String[] {merchant, eegTwin}) {
            exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                    + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                    + "('2026-05-12T01:00:00Z', '" + tenantA + "', '" + siteId + "', 0.0, 0.5, 0.3, 0.0, 0.0, 0.2, 90), "
                    + "('2026-05-12T02:00:00Z', '" + tenantA + "', '" + siteId + "', 0.0, 0.5, 1.5, 0.0, 1.0, 0.0, 90), "
                    + "('2026-05-12T11:00:00Z', '" + tenantA + "', '" + siteId + "', 2.0, 0.5, 0.0, 0.5, 1.0, 0.0, 90), "
                    + "('2026-05-12T18:00:00Z', '" + tenantA + "', '" + siteId + "', 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 90) "
                    + "ON CONFLICT DO NOTHING");
        }
        // The solar-only merchant charges strictly from its PV surplus.
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                + "('2026-05-12T11:00:00Z', '" + tenantA + "', '" + solarOnly + "', 2.0, 0.5, 0.0, 0.5, 1.0, 0.0, 90) "
                + "ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/earnings?range=day&at=2026-05-12"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);

        Map<String, Object> merchantSite = siteRow(body, merchant);
        assertThat(merchantSite).containsEntry("coveredSlots", 4);
        assertThat(num(merchantSite, "savedEur")).isCloseTo(0.15, eps);
        assertThat(num(merchantSite, "arbitrageEur")).isCloseTo(0.08, eps);
        assertThat(num(merchantSite, "pvShiftEur")).isCloseTo(0.07, eps);
        // The reconciliation the split promises: parts sum to the total.
        assertThat(num(merchantSite, "arbitrageEur") + num(merchantSite, "pvShiftEur"))
                .isCloseTo(num(merchantSite, "savedEur"), eps);

        // Identical measurements, but the flag is off -> no split, same saved.
        Map<String, Object> eegSite = siteRow(body, eegTwin);
        assertThat(num(eegSite, "savedEur")).isCloseTo(0.15, eps);
        assertThat(eegSite).containsEntry("arbitrageEur", null)
                .containsEntry("pvShiftEur", null);

        // Permitted but never grid-charged in the window -> no split either.
        Map<String, Object> solarSite = siteRow(body, solarOnly);
        assertThat(num(solarSite, "savedEur")).isCloseTo(-0.05, eps);
        assertThat(solarSite).containsEntry("arbitrageEur", null)
                .containsEntry("pvShiftEur", null);

        // Fleet totals: arbitrage sums the split sites; pvShift is the whole
        // fleet's remainder (no-split sites count as PV-shift), so the
        // fleet-level reconciliation holds too.
        Map<String, Object> totals = map(body, "totals");
        assertThat(num(totals, "savedEur")).isCloseTo(0.25, eps);
        assertThat(num(totals, "arbitrageEur")).isCloseTo(0.08, eps);
        assertThat(num(totals, "pvShiftEur")).isCloseTo(0.17, eps);
        assertThat(num(totals, "arbitrageEur") + num(totals, "pvShiftEur"))
                .isCloseTo(num(totals, "savedEur"), eps);

        // RLS: tenant B sees neither the sites nor their arbitrage.
        ResponseEntity<Map<String, Object>> other = rest.exchange(
                url("/api/v1/earnings?range=day&at=2026-05-12"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(list(other.getBody(), "sites")).extracting(x -> x.get("id"))
                .doesNotContain(merchant, eegTwin, solarOnly);
        assertThat(map(other.getBody(), "totals")).containsEntry("arbitrageEur", null);
    }

    /**
     * The FORWARD expected Marktwert Solar (captain 2026-07-09): the site's own
     * PV forecast weights the day-ahead price into a production-weighted
     * average. Seeded relative to now() so it exercises the real {@code
     * time >= now()} horizon filter of the endpoint. Three CH slots (aligned to
     * the quarter-hour grid so each finds its price):
     *
     * <pre>
     *   +1h  pv 2 kW  price 100  -> weight 2
     *   +2h  pv 6 kW  price 200  -> weight 6
     *   +3h  pv 1 kW  price -40  -> weight 1   (negative price pulls it DOWN)
     *   weighted = (100*2 + 200*6 - 40*1) / (2+6+1) = 1360/9 EUR/MWh
     *   ct/kWh   = 1360/9 / 10   = 15.111...
     * </pre>
     *
     * A night-zero slot (+4h, pv 0) is seeded too: it must not shift the value
     * (contributes 0 to both sums) but still widens the covered horizon. A
     * second site has a forecast but NO price -> null (hidden). Only the ACTIVE
     * PV model ('pv-physical') is consumed - a shadow challenger's rows are
     * ignored. RLS keeps tenant B out.
     */
    @Test
    void earningsExposeTheForwardExpectedMarketValueWeightedByPvForecast() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String site = createSite(demo, "Expected MW Werk", "CH", "direktvermarktung");
        String noPrice = createSite(demo, "Expected MW Ohne Preis", "AT", "eigenverbrauch");

        // Forward day-ahead prices for CH, aligned to the 15-min slot grid at
        // +1h/+2h/+3h from now (the +4h night slot deliberately has NO price
        // either - a zero-PV slot never needs one).
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "(time_bucket('15 minutes', now() + interval '1 hour'), 'CH', 'PT15M', 100.0, 'EUR', 'test'), "
                + "(time_bucket('15 minutes', now() + interval '2 hours'), 'CH', 'PT15M', 200.0, 'EUR', 'test'), "
                + "(time_bucket('15 minutes', now() + interval '3 hours'), 'CH', 'PT15M', -40.0, 'EUR', 'test'), "
                // priced night slot: covered, but pv 0 => it must not move the value
                + "(time_bucket('15 minutes', now() + interval '4 hours'), 'CH', 'PT15M', 300.0, 'EUR', 'test') "
                + "ON CONFLICT DO NOTHING");

        // Active-model PV forecast (latest run) for the priced site + a night
        // zero; plus a SHADOW challenger row at a huge price-weighted value that
        // must be ignored (wrong model).
        exec("INSERT INTO forecast (time, tenant_id, site_id, kind, model, value_kw, run_at, horizon_min, method) VALUES "
                + "(time_bucket('15 minutes', now() + interval '1 hour'), '" + tenantA + "', '" + site
                + "', 'pv', 'pv-physical', 2.0, now(), 60, 'test'), "
                + "(time_bucket('15 minutes', now() + interval '2 hours'), '" + tenantA + "', '" + site
                + "', 'pv', 'pv-physical', 6.0, now(), 120, 'test'), "
                + "(time_bucket('15 minutes', now() + interval '3 hours'), '" + tenantA + "', '" + site
                + "', 'pv', 'pv-physical', 1.0, now(), 180, 'test'), "
                + "(time_bucket('15 minutes', now() + interval '4 hours'), '" + tenantA + "', '" + site
                + "', 'pv', 'pv-physical', 0.0, now(), 240, 'test'), "
                // shadow challenger at the SAME slot - never consumed:
                + "(time_bucket('15 minutes', now() + interval '1 hour'), '" + tenantA + "', '" + site
                + "', 'pv', 'pv-residual-xgb', 9.0, now(), 60, 'test')");

        // The second site has a forecast but its AT zone has no forward price.
        exec("INSERT INTO forecast (time, tenant_id, site_id, kind, model, value_kw, run_at, horizon_min, method) VALUES "
                + "(time_bucket('15 minutes', now() + interval '1 hour'), '" + tenantA + "', '" + noPrice
                + "', 'pv', 'pv-physical', 3.0, now(), 60, 'test')");

        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-6);
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/earnings?range=month"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);

        Map<String, Object> mwSite = siteRow(res.getBody(), site);
        assertThat(num(mwSite, "expectedMarketValueSolarCtKwh")).isCloseTo(1360.0 / 9 / 10, eps);
        // The horizon spans all four both-covered forward slots (incl. the
        // night zero), so the portal can honestly say "nächste ~4 h".
        assertThat(mwSite).containsEntry("expectedMarketValueSlots", 4);
        assertThat(mwSite.get("expectedMarketValueFrom")).isNotNull();
        assertThat(mwSite.get("expectedMarketValueTo")).isNotNull();
        assertThat((String) mwSite.get("expectedMarketValueFrom"))
                .isLessThan((String) mwSite.get("expectedMarketValueTo"));

        // Forecast but no forward price -> null, the portal hides the figure.
        assertThat(siteRow(res.getBody(), noPrice))
                .containsEntry("expectedMarketValueSolarCtKwh", null)
                .containsEntry("expectedMarketValueSlots", null);

        // It is range-INDEPENDENT (always the future): the same on range=day.
        ResponseEntity<Map<String, Object>> day = rest.exchange(
                url("/api/v1/earnings?range=day"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(num(siteRow(day.getBody(), site), "expectedMarketValueSolarCtKwh"))
                .isCloseTo(1360.0 / 9 / 10, eps);

        // RLS: tenant B never sees the site nor a value.
        ResponseEntity<Map<String, Object>> other = rest.exchange(
                url("/api/v1/earnings?range=month"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))),
                new ParameterizedTypeReference<>() {});
        assertThat(list(other.getBody(), "sites")).extracting(x -> x.get("id"))
                .doesNotContain(site, noPrice);
    }

    // ---- battery-asset <-> device auto-link ---------------------------------

    @Test
    void batteryAssetAutoLinksToTheSitesSingleDeviceAndNeverGuessesOnMultiDeviceSites() {
        String demo = token("demo", "demo");

        // (1) ON WRITE, single device: claim the one device, then save the
        // battery by hand (no deviceId) -> it auto-links to that device.
        String s1 = createSite(demo, "Autolink Eins", "DE-LU", "eigenverbrauch");
        String d1 = claimDeviceInto(demo, s1, "autolink-inv-1");
        saveBattery(demo, s1, Map.of("capacityKwh", 10, "maxChargeKw", 5, "maxDischargeKw", 5));
        assertThat(batteryDeviceId(demo, s1)).isEqualTo(d1);

        // (2) ON CLAIM, battery first: save the battery before any device (stays
        // unlinked), then claiming the single device links it.
        String s2 = createSite(demo, "Autolink Zwei", "DE-LU", "eigenverbrauch");
        saveBattery(demo, s2, Map.of("capacityKwh", 12, "maxChargeKw", 6, "maxDischargeKw", 6));
        assertThat(batteryDeviceId(demo, s2)).isNull();
        String d2 = claimDeviceInto(demo, s2, "autolink-inv-2");
        assertThat(batteryDeviceId(demo, s2)).isEqualTo(d2);

        // (3) MULTI-DEVICE: never guess. Two devices, then a battery save with no
        // explicit choice leaves it unlinked; the overview flags it.
        String s3 = createSite(demo, "Autolink Drei", "DE-LU", "eigenverbrauch");
        claimDeviceInto(demo, s3, "autolink-inv-3a");
        String d3b = claimDeviceInto(demo, s3, "autolink-inv-3b");
        saveBattery(demo, s3, Map.of("capacityKwh", 20, "maxChargeKw", 10, "maxDischargeKw", 10));
        assertThat(batteryDeviceId(demo, s3)).isNull();
        assertThat(overviewSite(demo, s3)).containsEntry("batteryWithoutDevice", true);
        assertThat(overviewSite(demo, s1)).containsEntry("batteryWithoutDevice", false);

        // The owner then picks the controlling device explicitly -> linked, and
        // the warning clears. Round-trip efficiency persists too.
        List<Map<String, Object>> after = saveBattery(demo, s3, Map.of(
                "capacityKwh", 20, "maxChargeKw", 10, "maxDischargeKw", 10,
                "roundtripEfficiencyPct", 90, "deviceId", d3b));
        assertThat(batteryDeviceId(demo, s3)).isEqualTo(d3b);
        assertThat(overviewSite(demo, s3)).containsEntry("batteryWithoutDevice", false);
        Map<String, Object> battery = after.stream()
                .filter(a -> "battery".equals(a.get("type"))).findFirst().orElseThrow();
        assertThat(num(battery, "roundtripEfficiencyPct")).isEqualTo(90.0);
    }

    @Test
    void batteryEditorIsTenantScopedAndValidatesTheChosenDevice() {
        String demo = token("demo", "demo");
        Map<String, Object> params = Map.of("capacityKwh", 8, "maxChargeKw", 4, "maxDischargeKw", 4);

        // Foreign site (tenant B's Hamburg) is invisible under RLS -> 404.
        assertThat(rest.exchange(url("/api/v1/sites/" + HAMBURG_SITE + "/battery"),
                HttpMethod.PUT, new HttpEntity<>(params, bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A device that belongs to ANOTHER of the caller's sites cannot be linked
        // here -> 404 (device not at this site), and the battery stays unlinked.
        String siteA = createSite(demo, "Editor Site A", "DE-LU", "eigenverbrauch");
        String siteB = createSite(demo, "Editor Site B", "DE-LU", "eigenverbrauch");
        String deviceAtB = claimDeviceInto(demo, siteB, "editor-inv-b");
        Map<String, Object> wrongDevice = new java.util.HashMap<>(params);
        wrongDevice.put("deviceId", deviceAtB);
        assertThat(rest.exchange(url("/api/v1/sites/" + siteA + "/battery"),
                HttpMethod.PUT, new HttpEntity<>(wrongDevice, bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(batteryDeviceId(demo, siteA)).isNull();

        // Missing required values -> 400.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteA + "/battery"),
                HttpMethod.PUT, new HttpEntity<>(Map.of("capacityKwh", 8), bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    void speicherschonungPresetsWriteExactlyTheWearColumnAndDeriveHonestly() {
        String demo = token("demo", "demo");
        String site = createSite(demo, "Schonung Site", "DE-LU", "eigenverbrauch");
        Map<String, Object> params = Map.of(
                "capacityKwh", 10, "maxChargeKw", 5, "maxDischargeKw", 5);

        // A fresh battery without a preset stores NULL wear (platform default),
        // which derives as the "ausgewogen" preset (NULL = default = 4 ct).
        assertThat(batteryOf(saveBattery(demo, site, params)).get("speicherschonung"))
                .isEqualTo("ausgewogen");
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + site
                + "' AND type = 'battery' AND wear_cost_ct_per_kwh IS NULL")).isEqualTo(1);

        // Seed the OTHER admin optimizer overrides (SoC band on the same asset
        // row + the site's backup reserve) so the preset writes below can prove
        // they touch ONLY the wear column.
        exec("UPDATE asset SET soc_min_pct = 10, soc_max_pct = 90 WHERE site_id = '"
                + site + "' AND type = 'battery'");
        exec("UPDATE site SET backup_reserve_soc_pct = 30 WHERE id = '" + site + "'");

        // "schonend" lands exactly 8 ct on the column the optimizer's inputs.py
        // reads (asset.wear_cost_ct_per_kwh) - no new column, no other write.
        Map<String, Object> schonend = new java.util.HashMap<>(params);
        schonend.put("speicherschonung", "schonend");
        assertThat(batteryOf(saveBattery(demo, site, schonend)).get("speicherschonung"))
                .isEqualTo("schonend");
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + site
                + "' AND type = 'battery' AND wear_cost_ct_per_kwh = 8")).isEqualTo(1);

        // A save WITHOUT the field keeps the stored value (never flips it).
        assertThat(batteryOf(saveBattery(demo, site, params)).get("speicherschonung"))
                .isEqualTo("schonend");

        // "aggressiv" -> 1 ct.
        Map<String, Object> aggressiv = new java.util.HashMap<>(params);
        aggressiv.put("speicherschonung", "aggressiv");
        assertThat(batteryOf(saveBattery(demo, site, aggressiv)).get("speicherschonung"))
                .isEqualTo("aggressiv");
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + site
                + "' AND type = 'battery' AND wear_cost_ct_per_kwh = 1")).isEqualTo(1);

        // None of the preset writes clobbered the SoC band or backup reserve.
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + site
                + "' AND type = 'battery' AND soc_min_pct = 10 AND soc_max_pct = 90"))
                .isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM site WHERE id = '" + site
                + "' AND backup_reserve_soc_pct = 30")).isEqualTo(1);

        // An admin-configured custom value (outside the ladder) derives as
        // "individuell" - the portal shows it honestly...
        exec("UPDATE asset SET wear_cost_ct_per_kwh = 2.5 WHERE site_id = '"
                + site + "' AND type = 'battery'");
        assertThat(batteryAsset(demo, site).get("speicherschonung")).isEqualTo("individuell");

        // ...and a customer preset pick simply overwrites it.
        Map<String, Object> ausgewogen = new java.util.HashMap<>(params);
        ausgewogen.put("speicherschonung", "ausgewogen");
        assertThat(batteryOf(saveBattery(demo, site, ausgewogen)).get("speicherschonung"))
                .isEqualTo("ausgewogen");
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + site
                + "' AND type = 'battery' AND wear_cost_ct_per_kwh = 4")).isEqualTo(1);

        // An unknown preset name -> 400; a foreign site (RLS) -> 404.
        Map<String, Object> bogus = new java.util.HashMap<>(params);
        bogus.put("speicherschonung", "extrem");
        assertThat(rest.exchange(url("/api/v1/sites/" + site + "/battery"),
                HttpMethod.PUT, new HttpEntity<>(bogus, bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rest.exchange(url("/api/v1/sites/" + HAMBURG_SITE + "/battery"),
                HttpMethod.PUT, new HttpEntity<>(schonend, bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A pv asset row never carries a preset (battery-only derivation).
        createMeasurementPoint(demo, site, Map.of(
                "role", "pv-generation", "label", "AC-PV", "capacityKwp", 5));
        assertThat(siteAssets(demo, site).stream()
                .filter(a -> "pv".equals(a.get("type"))).findFirst()
                .orElseThrow().get("speicherschonung")).isNull();
    }

    @Test
    void backfillLinksSingleDeviceSitesButLeavesMultiDeviceSitesUnlinked() {
        // Seed pre-hook rows directly (superuser, bypassing RLS + the auto-link
        // hooks) to prove the migration's backfill rule in isolation.
        String tenant = "00000000-0000-0000-0000-000000000001";
        String oneSite = "aaaaaaa1-0000-0000-0000-000000000001";
        String oneDevice = "aaaaaaa1-0000-0000-0000-0000000000d1";
        String oneBattery = "aaaaaaa1-0000-0000-0000-0000000000b1";
        String twoSite = "aaaaaaa2-0000-0000-0000-000000000002";
        String twoBattery = "aaaaaaa2-0000-0000-0000-0000000000b2";
        exec("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES "
                + "('" + oneSite + "', '" + tenant + "', 'Backfill One', 'DE-LU'), "
                + "('" + twoSite + "', '" + tenant + "', 'Backfill Two', 'DE-LU')");
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) VALUES "
                + "('" + oneDevice + "', '" + tenant + "', '" + oneSite + "', 'backfill-one', 'inverter', 'claimed'), "
                + "('aaaaaaa2-0000-0000-0000-0000000000d1', '" + tenant + "', '" + twoSite + "', 'backfill-two-a', 'inverter', 'claimed'), "
                + "('aaaaaaa2-0000-0000-0000-0000000000d2', '" + tenant + "', '" + twoSite + "', 'backfill-two-b', 'inverter', 'claimed')");
        exec("INSERT INTO asset (id, tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw) VALUES "
                + "('" + oneBattery + "', '" + tenant + "', '" + oneSite + "', 'battery', 10, 5, 5), "
                + "('" + twoBattery + "', '" + tenant + "', '" + twoSite + "', 'battery', 10, 5, 5)");

        // Run the migration's exact backfill statement.
        exec("UPDATE asset a SET device_id = single.device_id "
                + "FROM (SELECT site_id, (array_agg(id))[1] AS device_id FROM device GROUP BY site_id "
                + "  HAVING count(*) = 1) single "
                + "WHERE a.site_id = single.site_id AND a.type = 'battery' AND a.device_id IS NULL");

        // The one-device site's battery is now linked; the two-device site's is not.
        assertThat(queryLong("SELECT count(*) FROM asset WHERE id = '" + oneBattery
                + "' AND device_id = '" + oneDevice + "'")).isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM asset WHERE id = '" + twoBattery
                + "' AND device_id IS NULL")).isEqualTo(1);
    }

    @Test
    void measurementPointsRecordErzeugerSourcesAndSumIntoAggregatePv() {
        String demo = token("demo", "demo");
        String site = createSite(demo, "Multi-Source Anlage", "DE-LU", "eigenverbrauch");

        // Empty to start.
        assertThat(measurementPoints(demo, site)).isEmpty();
        assertThat(aggregatePvKwp(demo, site)).isNull();

        // Record a 70 kWp AC-coupled PV as an Erzeuger source (with its own SEE #).
        List<Map<String, Object>> after = createMeasurementPoint(demo, site, Map.of(
                "role", "pv-generation", "label", "PV Dach Süd",
                "capacityKwp", 70, "registryUnitId", "SEE900000000001"));
        assertThat(after).hasSize(1);
        assertThat(after.get(0).get("role")).isEqualTo("pv-generation");
        assertThat(after.get(0).get("control")).isEqualTo(false);
        assertThat(after.get(0).get("registryUnitId")).isEqualTo("SEE900000000001");
        // The aggregate site PV nameplate now carries the additional generation.
        assertThat(aggregatePvKwp(demo, site)).isEqualByComparingTo("70");

        // A second Erzeuger sums in (asset.pv = Σ Erzeuger).
        createMeasurementPoint(demo, site, Map.of("role", "pv-generation", "capacityKwp", 30));
        assertThat(measurementPoints(demo, site)).hasSize(2);
        assertThat(aggregatePvKwp(demo, site)).isEqualByComparingTo("100");

        // Remove the first -> aggregate drops by its kWp.
        String firstId = (String) after.get(0).get("id");
        ResponseEntity<String> del = rest.exchange(
                url("/api/v1/sites/" + site + "/measurement-points/" + firstId),
                HttpMethod.DELETE, new HttpEntity<>(bearer(demo)), String.class);
        assertThat(del.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(measurementPoints(demo, site)).hasSize(1);
        assertThat(aggregatePvKwp(demo, site)).isEqualByComparingTo("30");

        // Deleting an unknown id -> 404.
        assertThat(rest.exchange(url("/api/v1/sites/" + site + "/measurement-points/"
                + java.util.UUID.randomUUID()), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A Netz (grid-meter) source is accepted, carries no nameplate (does NOT
        // bump the aggregate PV), and is capped at one per site.
        List<Map<String, Object>> withNetz = createMeasurementPoint(demo, site, Map.of(
                "role", "grid-meter", "label", "Netz-Zähler Hausanschluss"));
        assertThat(withNetz).anyMatch(p -> "grid-meter".equals(p.get("role")));
        assertThat(withNetz).filteredOn(p -> "grid-meter".equals(p.get("role")))
                .allSatisfy(p -> assertThat(p.get("capacityKwp")).isNull());
        assertThat(aggregatePvKwp(demo, site)).isEqualByComparingTo("30"); // meter never touches asset.pv

        // A SECOND Netz meter is refused -> 409 (one meter at the point of common coupling).
        assertThat(rest.exchange(url("/api/v1/sites/" + site + "/measurement-points"),
                HttpMethod.POST, new HttpEntity<>(Map.of("role", "grid-meter"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // A Consumer (e.g. a go-e wallbox) is accepted, carries no nameplate (does
        // NOT bump the aggregate PV even if a capacityKwp is sent), and - unlike
        // the Netz meter - is NOT count-limited (a site may have several).
        List<Map<String, Object>> withConsumer = createMeasurementPoint(demo, site, Map.of(
                "role", "consumer", "label", "Wallbox Garage", "capacityKwp", 22));
        assertThat(withConsumer).anyMatch(p -> "consumer".equals(p.get("role")));
        assertThat(withConsumer).filteredOn(p -> "consumer".equals(p.get("role")))
                .allSatisfy(p -> assertThat(p.get("capacityKwp")).isNull());
        assertThat(aggregatePvKwp(demo, site)).isEqualByComparingTo("30"); // consumer never touches asset.pv
        // A SECOND consumer is allowed (no count limit).
        List<Map<String, Object>> withTwoConsumers = createMeasurementPoint(demo, site,
                Map.of("role", "consumer", "label", "Wärmepumpe"));
        assertThat(withTwoConsumers).filteredOn(p -> "consumer".equals(p.get("role"))).hasSize(2);
        assertThat(aggregatePvKwp(demo, site)).isEqualByComparingTo("30");

        // An unknown role is still refused -> 400.
        assertThat(rest.exchange(url("/api/v1/sites/" + site + "/measurement-points"),
                HttpMethod.POST, new HttpEntity<>(Map.of("role", "wallbox"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Foreign site (tenant B) is invisible under RLS -> 404 on list and create.
        assertThat(rest.exchange(url("/api/v1/sites/" + HAMBURG_SITE + "/measurement-points"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/sites/" + HAMBURG_SITE + "/measurement-points"),
                HttpMethod.POST, new HttpEntity<>(Map.of("role", "pv-generation"), bearer(demo)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void e1bDropsTheSingleControlPointLocksSoMultiEntitySitesAreRepresentable() {
        // E1b (V20260719010000) removed the v1 single-battery locks: the
        // control-only-battery CHECK and the one-control-per-site partial
        // unique index. v2 controllable-consumer entities (wallbox,
        // heating-rod, ...) ARE control points, and a site may have several.
        // Control safety moved to the catalog-driven service (not a DB CHECK).
        String tenant = "00000000-0000-0000-0000-000000000001";
        String site = "ccccccc1-0000-0000-0000-000000000001";
        exec("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES "
                + "('" + site + "', '" + tenant + "', 'Multi-Entity Site', 'DE-LU')");

        // A non-battery-hybrid control point is now allowed at the DB level.
        exec("INSERT INTO measurement_point (tenant_id, site_id, role, control) VALUES "
                + "('" + tenant + "', '" + site + "', 'wallbox', TRUE)");
        // A SECOND control point on the same site is now allowed too.
        exec("INSERT INTO measurement_point (tenant_id, site_id, role, control) VALUES "
                + "('" + tenant + "', '" + site + "', 'battery-hybrid', TRUE)");
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE site_id = '" + site
                + "' AND control = TRUE")).isEqualTo(2);
    }

    /** GET the site's measurement points as the given user. */
    private List<Map<String, Object>> measurementPoints(String token, String siteId) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/measurement-points"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /** POST a measurement point, asserting 200 and returning the resulting list. */
    private List<Map<String, Object>> createMeasurementPoint(String token, String siteId,
            Map<String, Object> body) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/measurement-points"), HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /** The site's aggregate pv asset kWp via GET /assets (null when no pv asset). */
    private java.math.BigDecimal aggregatePvKwp(String token, String siteId) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/assets"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody().stream()
                .filter(a -> "pv".equals(a.get("type"))).findFirst()
                .map(a -> a.get("pvCapacityKwp"))
                .filter(java.util.Objects::nonNull)
                .map(v -> new java.math.BigDecimal(v.toString()))
                .orElse(null);
    }

    /** PUT /battery for a site as the given user, returning the asset list. */
    private List<Map<String, Object>> saveBattery(String token, String siteId, Map<String, Object> body) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/battery"), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /** GET /assets for a site as the given user. */
    private List<Map<String, Object>> siteAssets(String token, String siteId) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/assets"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /** The battery row of an asset list. */
    private static Map<String, Object> batteryOf(List<Map<String, Object>> assets) {
        return assets.stream()
                .filter(a -> "battery".equals(a.get("type"))).findFirst().orElseThrow();
    }

    /** The site's battery asset row via GET /assets. */
    private Map<String, Object> batteryAsset(String token, String siteId) {
        return batteryOf(siteAssets(token, siteId));
    }

    /** The site's battery-asset device_id via GET /assets (null when unlinked). */
    private String batteryDeviceId(String token, String siteId) {
        return siteAssets(token, siteId).stream()
                .filter(a -> "battery".equals(a.get("type"))).findFirst()
                .map(a -> (String) a.get("deviceId")).orElse(null);
    }

    /** The site's row from GET /overview. */
    private Map<String, Object> overviewSite(String token, String siteId) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/overview"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return list(res.getBody(), "sites").stream()
                .filter(x -> siteId.equals(x.get("id"))).findFirst().orElseThrow();
    }

    private String createSite(String token, String name, String zone, String plantKind) {
        return createSite(token, name, zone, plantKind, null);
    }

    private String createSite(String token, String name, String zone, String plantKind,
            String anzulegenderWertCtKwh) {
        Map<String, Object> payload = new java.util.HashMap<>(Map.of(
                "name", name, "biddingZone", zone, "plantKind", plantKind));
        if (anzulegenderWertCtKwh != null) {
            payload.put("anzulegenderWertCtKwh", new java.math.BigDecimal(anzulegenderWertCtKwh));
        }
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(payload, bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) created.getBody().get("id");
    }

    private String createSiteWithTarif(String token, String name, String zone,
            String plantKind, String tarifArt, String tarifParamCtKwh) {
        Map<String, Object> payload = new java.util.HashMap<>(Map.of(
                "name", name, "biddingZone", zone, "plantKind", plantKind,
                "tarifArt", tarifArt));
        if (tarifParamCtKwh != null) {
            payload.put("tarifParamCtKwh", new java.math.BigDecimal(tarifParamCtKwh));
        }
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(payload, bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) created.getBody().get("id");
    }

    private static Map<String, Object> siteRow(Map<String, Object> body, String siteId) {
        return list(body, "sites").stream()
                .filter(x -> siteId.equals(x.get("id"))).findFirst().orElseThrow();
    }

    private String claimDeviceInto(String token, String siteId, String externalRef) {
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", externalRef),
                        bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isIn(HttpStatus.CREATED, HttpStatus.OK);
        return (String) claim.getBody().get("id");
    }

    // ---- Stufe 2: structured supply-price sheet CRUD ------------------------

    /**
     * The portal-maintenance CRUD for {@code site_supply_price} (report
     * vp-nacht-bezug-e7 §3.1, Stufe 2): GET reports the empty sheet before any
     * row, PUT upserts with PATCH semantics (absent field = keep, explicit
     * value = write, explicit null = clear a component to "unknown"),
     * {@code hasComponents} tracks the activation gate, invalid values are
     * German 400s, and RLS fences the whole thing (a foreign tenant is 404).
     */
    @Test
    void supplyPriceSheetCrudHonoursPatchSemanticsAndTenantScoping() {
        String demo = token("demo", "demo");
        String siteId = createSite(demo, "Bezugspreis Werk", "DE-LU", "eigenverbrauch");
        String base = "/api/v1/sites/" + siteId + "/supply-price";

        // Empty before any row: no components, the activation gate is closed.
        Map<String, Object> before = getSheet(demo, base);
        assertThat(before).containsEntry("present", false).containsEntry("hasComponents", false);
        assertThat(before.get("netzentgeltArbeitspreisCt")).isNull();

        // PUT one component: the sheet is now maintained (gate open).
        Map<String, Object> one = putSheet(demo, base, mapOf("netzentgeltArbeitspreisCt", 7.6));
        assertThat(one).containsEntry("present", true).containsEntry("hasComponents", true);
        assertThat(dbl(one, "netzentgeltArbeitspreisCt")).isEqualTo(7.6);
        assertThat(one.get("stromsteuerCt")).isNull();
        assertThat(dbl(one, "ustPct")).isEqualTo(19.0); // the NOT NULL default

        // PATCH: a field ABSENT from the body keeps its stored value.
        Map<String, Object> two = putSheet(demo, base, mapOf("stromsteuerCt", 2.05));
        assertThat(dbl(two, "netzentgeltArbeitspreisCt")).isEqualTo(7.6); // kept
        assertThat(dbl(two, "stromsteuerCt")).isEqualTo(2.05);

        // PATCH: an explicit null CLEARS that component to "unknown".
        Map<String, Object> cleared = putSheet(demo, base, nullValue("netzentgeltArbeitspreisCt"));
        assertThat(cleared.get("netzentgeltArbeitspreisCt")).isNull(); // cleared
        assertThat(dbl(cleared, "stromsteuerCt")).isEqualTo(2.05); // kept
        assertThat(cleared).containsEntry("hasComponents", true); // stromsteuer still set

        // Full sheet incl. the USt rate and the Preisblatt-Stand.
        Map<String, Object> full = new java.util.HashMap<>();
        full.put("netzentgeltArbeitspreisCt", 7.6);
        full.put("stromsteuerCt", 2.05);
        full.put("konzessionsabgabeCt", 1.59);
        full.put("umlagenCt", 2.946);
        full.put("vertriebsaufschlagCt", 1.5);
        full.put("ustPct", 19.0);
        full.put("komponentenStand", "2026-01-01");
        Map<String, Object> saved = putSheet(demo, base, full);
        assertThat(dbl(saved, "umlagenCt")).isEqualTo(2.946);
        assertThat(saved).containsEntry("komponentenStand", "2026-01-01");

        // Clearing every component leaves the row present but the gate closed.
        Map<String, Object> allNull = new java.util.HashMap<>();
        for (String f : List.of("netzentgeltArbeitspreisCt", "stromsteuerCt",
                "konzessionsabgabeCt", "umlagenCt", "vertriebsaufschlagCt")) {
            allNull.put(f, null);
        }
        Map<String, Object> gateClosed = putSheet(demo, base, allNull);
        assertThat(gateClosed).containsEntry("present", true).containsEntry("hasComponents", false);
        assertThat(dbl(gateClosed, "ustPct")).isEqualTo(19.0); // ust survives (NOT NULL)

        // Validation: a negative component and a garbage date are German 400s.
        assertThat(rest.exchange(url(base), HttpMethod.PUT,
                new HttpEntity<>(mapOf("stromsteuerCt", -1.0), bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rest.exchange(url(base), HttpMethod.PUT,
                new HttpEntity<>(mapOf("komponentenStand", "keinDatum"), bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // RLS: another tenant can neither read nor write this sheet (404, not 403).
        String demo2 = token("demo2", "demo2");
        assertThat(rest.exchange(url(base), HttpMethod.GET,
                new HttpEntity<>(bearer(demo2)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url(base), HttpMethod.PUT,
                new HttpEntity<>(mapOf("stromsteuerCt", 3.0), bearer(demo2)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        // ...and demo's sheet is provably untouched by the foreign write attempt.
        assertThat(dbl(getSheet(demo, base), "ustPct")).isEqualTo(19.0);
    }

    private Map<String, Object> getSheet(String token, String path) {
        ResponseEntity<Map<String, Object>> r = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    private Map<String, Object> putSheet(String token, String path, Map<String, Object> body) {
        ResponseEntity<Map<String, Object>> r = rest.exchange(url(path), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    private static Map<String, Object> mapOf(String key, Object value) {
        Map<String, Object> m = new java.util.HashMap<>();
        m.put(key, value);
        return m;
    }

    /** A body with ONE field explicitly set to null (Map.of forbids null values). */
    private static Map<String, Object> nullValue(String key) {
        Map<String, Object> m = new java.util.HashMap<>();
        m.put(key, null);
        return m;
    }

    private static Double dbl(Map<String, Object> body, String key) {
        Object v = body.get(key);
        return v == null ? null : ((Number) v).doubleValue();
    }

    // ---- Stufe 3: structured supply price on the read side ------------------

    /**
     * THE one-price-truth drift guard (Stufe 3, report vp-nacht-bezug-e7
     * §3.4): the SQL fragment the Earnings/History aggregates value import
     * with ({@code SlotEconomics.importPriceCtSql}) is evaluated by REAL
     * Postgres against the Java composition
     * ({@code SlotEconomics.importPriceCtKwh}) - the same rule the admin
     * diagnostics mirror from pricing.py - vector for vector, with the
     * {@code OPTIMIZER_DEFAULT_SUPPLY_COMPONENTS} flag OFF and ON. Any edit
     * that lets the two renderings drift fails here by name.
     */
    @Test
    void importPriceSqlMatchesTheSlotEconomicsCompositionVectors() {
        var fullSheet = new com.voltpilot.api.optimizer.SlotEconomics.SupplyPrice(
                7.6, 2.05, 1.59, 2.946, 1.5, 19.0);
        var partialSheet = new com.voltpilot.api.optimizer.SlotEconomics.SupplyPrice(
                7.6, null, null, null, null, 19.0);
        var vorsteuerSheet = new com.voltpilot.api.optimizer.SlotEconomics.SupplyPrice(
                7.6, 2.05, 1.59, 2.946, 1.5, 0.0);
        var allNullSheet = new com.voltpilot.api.optimizer.SlotEconomics.SupplyPrice(
                null, null, null, null, null, 19.0);
        record Vec(String tarifArt, Double param,
                com.voltpilot.api.optimizer.SlotEconomics.SupplyPrice sheet, Double spot) {
        }
        java.util.List<Vec> vectors = java.util.List.of(
                new Vec("fest", 30.0, null, 100.0),
                new Vec("fest", 30.0, fullSheet, 100.0), // fest wins, sheet ignored
                new Vec("fest", 30.0, null, null), // flat needs no spot
                new Vec("fest", null, null, 100.0), // unparametrized fest -> spot
                new Vec("dynamisch", 18.0, null, 100.0), // legacy Sammelaufschlag
                new Vec("dynamisch", 18.0, fullSheet, 100.0), // sheet beats Aufschlag
                new Vec("dynamisch", null, null, 100.0), // S1 case: bare spot / default set
                new Vec("dynamisch", null, partialSheet, 100.0),
                new Vec("dynamisch", 18.0, null, null), // no spot -> unknowable
                new Vec("ohne", null, fullSheet, 100.0),
                new Vec("ohne", null, fullSheet, -40.0), // negative spot composes too
                new Vec("ohne", null, vorsteuerSheet, 100.0), // C&I USt 0
                new Vec("ohne", null, allNullSheet, 100.0), // degenerate row = no row
                new Vec("ohne", null, null, 100.0), // no price data at all
                new Vec("ohne", null, null, null));
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);
        for (boolean flag : new boolean[] {false, true}) {
            for (Vec v : vectors) {
                var site = new com.voltpilot.api.optimizer.SlotEconomics.SiteEconomics(
                        "eigenverbrauch", false, v.tarifArt(), v.param(),
                        null, null, null, null, null, v.sheet());
                Double expected = new com.voltpilot.api.optimizer.SlotEconomics(site,
                        com.voltpilot.api.optimizer.EegRates.defaults(), Map.of(), flag)
                        .importPriceCtKwh(v.spot());
                Double actual = evalImportPriceSql(flag, v.tarifArt(), v.param(), v.sheet(), v.spot());
                String label = "flag=" + flag + " " + v;
                if (expected == null) {
                    assertThat(actual).as(label).isNull();
                } else {
                    assertThat(actual).as(label).isNotNull().isCloseTo(expected, eps);
                }
            }
        }
    }

    /** Evaluates the generated import-price SQL over one bound vector row. */
    private static Double evalImportPriceSql(boolean flag, String tarifArt, Double param,
            com.voltpilot.api.optimizer.SlotEconomics.SupplyPrice sheet, Double spot) {
        String sql = "SELECT "
                + com.voltpilot.api.optimizer.SlotEconomics.importPriceCtSql("p.price_eur_mwh", flag)
                + " AS ct FROM (VALUES (?::text, ?::numeric)) AS s(tarif_art, tarif_param_ct_kwh)"
                + " CROSS JOIN (VALUES (?::numeric, ?::numeric, ?::numeric, ?::numeric, ?::numeric,"
                + " ?::numeric)) AS ssp(netzentgelt_arbeitspreis_ct, stromsteuer_ct,"
                + " konzessionsabgabe_ct, umlagen_ct, vertriebsaufschlag_ct, ust_pct)"
                + " CROSS JOIN (VALUES (?::numeric)) AS p(price_eur_mwh)";
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, tarifArt);
            ps.setObject(2, param);
            // A null sheet = no site_supply_price row: the LEFT JOIN's all-NULL
            // side, incl. ust_pct (the column itself is NOT NULL, but the miss
            // yields NULL) - bind it exactly like that.
            ps.setObject(3, sheet == null ? null : sheet.netzentgeltArbeitspreisCt());
            ps.setObject(4, sheet == null ? null : sheet.stromsteuerCt());
            ps.setObject(5, sheet == null ? null : sheet.konzessionsabgabeCt());
            ps.setObject(6, sheet == null ? null : sheet.umlagenCt());
            ps.setObject(7, sheet == null ? null : sheet.vertriebsaufschlagCt());
            ps.setObject(8, sheet == null ? null : sheet.ustPct());
            ps.setObject(9, spot);
            try (java.sql.ResultSet rs = ps.executeQuery()) {
                rs.next();
                java.math.BigDecimal ct = rs.getBigDecimal("ct");
                return ct == null ? null : ct.doubleValue();
            }
        } catch (Exception e) {
            throw new IllegalStateException("vector eval failed", e);
        }
    }

    // ---- B2 fix: the export-value composition on the read side --------------

    /**
     * THE export-side drift guard (audit vp-geldzahlen-audit-x7, B2): the SQL
     * fragment the Earnings aggregates value EXPORT with
     * ({@code SlotEconomics.exportValueCtSql} over the
     * {@code EegRates.festeVerguetungCtSql} band schedule) is evaluated by
     * REAL Postgres against the Java composition
     * ({@code SlotEconomics.exportValueCtKwh}) - the rule the optimizer plans
     * with (pricing.py {@code export_values}) - vector for vector: feste
     * Vergütung incl. tranche blending and the pre-schedule band, the 20-year
     * expiry, §51a zeroing at negative spot (and its NULL-spot "unknowable"),
     * the netzladen guard on the EEG branch, the honest bare-spot fallback
     * without a commissioning date, and the DV premium branch.
     *
     * <p>The ONE deliberate deviation is pinned BY NAME at the end: a
     * {@code netzladen_erlaubt} DV site keeps the earnings' historical
     * spot + Marktprämie valuation (the Java twin's netzladen-first guard
     * would strip it - re-gating would silently change live DV numbers, out
     * of B2's byte-identical-for-DV contract).
     */
    @Test
    void exportValueSqlMatchesTheSlotEconomicsCompositionVectors() {
        Instant slot = Instant.parse("2026-06-15T12:00:00Z");
        record Vec(String plantKind, boolean netzladen, Double aw, Double mvCt,
                LocalDate commissioned, Double kwp, Double spot) {
        }
        java.util.List<Vec> vectors = java.util.List.of(
                // feste Vergütung: band lookup + spot-independence
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2024, 6, 1), null, 100.0),
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2024, 6, 1), null, -40.0),
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2024, 6, 1), null, null),
                // §51a plant (commissioned on/after 2025-02-25)
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2025, 6, 1), null, 100.0),
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2025, 6, 1), null, -40.0),
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2025, 6, 1), null, null),
                // tranche blending: 20 kWp -> (10*7.94 + 10*6.88)/20 = 7.41;
                // 55 kWp on the EEG-2023 band -> 382/55
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2025, 6, 1), 20.0, 100.0),
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2022, 8, 15), 55.0, 100.0),
                // pre-schedule commissioning uses the first band (24.4)
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2010, 1, 1), null, 100.0),
                // 20-year expiry -> bare spot (and NULL spot stays NULL)
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2004, 5, 1), null, 100.0),
                new Vec("eigenverbrauch", false, null, null, LocalDate.of(2004, 5, 1), null, null),
                // the netzladen guard and the no-commissioning honesty fallback
                new Vec("eigenverbrauch", true, null, null, LocalDate.of(2024, 6, 1), null, 100.0),
                new Vec("eigenverbrauch", false, null, null, null, null, 100.0),
                // Direktvermarktung: premium, floor, §51 suspension, NULL rules
                new Vec("direktvermarktung", false, 8.11, 5.0, null, null, 100.0),
                new Vec("direktvermarktung", false, 8.11, 5.0, null, null, -40.0),
                new Vec("direktvermarktung", false, 8.11, null, null, null, 100.0),
                new Vec("direktvermarktung", false, 8.11, 9.5, null, null, 100.0),
                new Vec("direktvermarktung", false, null, 5.0, null, null, 100.0),
                new Vec("direktvermarktung", false, 8.11, 5.0, null, null, null));
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);
        for (Vec v : vectors) {
            var site = new com.voltpilot.api.optimizer.SlotEconomics.SiteEconomics(
                    v.plantKind(), v.netzladen(), "ohne", null, v.aw(),
                    v.commissioned(), v.kwp(), null, null, null);
            Map<LocalDate, com.voltpilot.api.optimizer.SlotEconomics.MarketValue> mvs =
                    v.mvCt() == null ? Map.of()
                            : Map.of(com.voltpilot.api.optimizer.SlotEconomics.berlinMonth(slot),
                                    new com.voltpilot.api.optimizer.SlotEconomics.MarketValue(
                                            v.mvCt(), false));
            Double expected = new com.voltpilot.api.optimizer.SlotEconomics(site,
                    com.voltpilot.api.optimizer.EegRates.defaults(), mvs)
                    .exportValueCtKwh(v.spot(), slot);
            Double actual = evalExportValueSql(v.plantKind(), v.netzladen(), v.aw(), v.mvCt(),
                    v.commissioned(), v.kwp(), v.spot(), slot);
            if (expected == null) {
                assertThat(actual).as(v.toString()).isNull();
            } else {
                assertThat(actual).as(v.toString()).isNotNull().isCloseTo(expected, eps);
            }
        }

        // The pinned DEVIATION: Java (the optimizer's rule) strips the premium
        // from a netzladen DV site; the earnings SQL deliberately keeps it -
        // today's crediting, so DV sites stay byte-identical under the B2 fix.
        var netzladenDv = new com.voltpilot.api.optimizer.SlotEconomics.SiteEconomics(
                "direktvermarktung", true, "ohne", null, 8.11, null, null, null, null, null);
        assertThat(new com.voltpilot.api.optimizer.SlotEconomics(netzladenDv,
                com.voltpilot.api.optimizer.EegRates.defaults(),
                Map.of(com.voltpilot.api.optimizer.SlotEconomics.berlinMonth(slot),
                        new com.voltpilot.api.optimizer.SlotEconomics.MarketValue(5.0, false)))
                .exportValueCtKwh(100.0, slot)).isCloseTo(10.0, eps);
        assertThat(evalExportValueSql("direktvermarktung", true, 8.11, 5.0, null, null, 100.0, slot))
                .isCloseTo(13.11, eps);
    }

    /** Evaluates the generated export-value SQL over one bound vector row. */
    private static Double evalExportValueSql(String plantKind, boolean netzladen, Double aw,
            Double mvCt, LocalDate commissioned, Double kwp, Double spot, Instant slot) {
        String sql = "SELECT "
                + com.voltpilot.api.optimizer.SlotEconomics.exportValueCtSql(
                        "p.price_eur_mwh", "r.bucket",
                        com.voltpilot.api.optimizer.EegRates.defaults())
                + " AS ct FROM (VALUES (?::text, ?::boolean, ?::numeric))"
                + " AS s(plant_kind, netzladen_erlaubt, anzulegender_wert_ct_kwh)"
                + " CROSS JOIN (VALUES (?::numeric)) AS mv(value_ct_kwh)"
                + " CROSS JOIN (VALUES (?::date, ?::numeric)) AS pv(commissioned_on, pv_capacity_kwp)"
                + " CROSS JOIN (VALUES (?::numeric)) AS p(price_eur_mwh)"
                + " CROSS JOIN (VALUES (?::timestamptz)) AS r(bucket)";
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, plantKind);
            ps.setBoolean(2, netzladen);
            ps.setObject(3, aw);
            // A missing monthly_market_value / pv-asset row = the LEFT JOIN's
            // all-NULL side - bind it exactly like that.
            ps.setObject(4, mvCt);
            ps.setObject(5, commissioned == null ? null : java.sql.Date.valueOf(commissioned));
            ps.setObject(6, kwp);
            ps.setObject(7, spot);
            ps.setObject(8, java.sql.Timestamp.from(slot));
            try (java.sql.ResultSet rs = ps.executeQuery()) {
                rs.next();
                java.math.BigDecimal ct = rs.getBigDecimal("ct");
                return ct == null ? null : ct.doubleValue();
            }
        } catch (Exception e) {
            throw new IllegalStateException("vector eval failed", e);
        }
    }

    /**
     * Stufe 3 endpoint proof (report §3.4 + §1.5 S3): {@code savedEur} values
     * AVOIDED IMPORT at the site's structured supply price - the same
     * composition the solver plans with - while the export side stays at spot,
     * per hand-computed vectors over identical measurements: {@code fest}
     * 30 ct, {@code dynamisch} + 18 ct Sammelaufschlag, {@code ohne} with a
     * maintained Preisblatt (Σ 16 ct netto × 1,19 USt - the USt covers the
     * spot share too), and a bare {@code ohne} site whose numbers stay
     * BYTE-IDENTICAL to the legacy symmetric-spot math (the rollout rule,
     * flag off). Also pins: the {@code tarifPriced} honesty flag, the
     * export-side slot leaving saved tariff-independent, the
     * Eigenverbrauchs-Wert/Einspeise-Erlös fields UNCHANGED by the sheet, and
     * the tariff-valued daily variant (spark bars).
     */
    @Test
    void savedEurValuesAvoidedImportAtTheStructuredSupplyPrice() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String fest = createSiteWithTarif(demo, "Bezug Fest", "AT", "eigenverbrauch", "fest", "30");
        String dynAuf = createSiteWithTarif(demo, "Bezug Aufschlag", "AT", "eigenverbrauch",
                "dynamisch", "18");
        String sheet = createSite(demo, "Bezug Preisblatt", "AT", "eigenverbrauch"); // ohne
        String bare = createSite(demo, "Bezug Spot", "AT", "eigenverbrauch"); // ohne
        exec("INSERT INTO site_supply_price (site_id, tenant_id, netzentgelt_arbeitspreis_ct,"
                + " stromsteuer_ct, konzessionsabgabe_ct, umlagen_ct, vertriebsaufschlag_ct, ust_pct)"
                + " VALUES ('" + sheet + "', '" + tenantA + "', 8.0, 2.0, 1.5, 3.0, 1.5, 19.0)");

        // Two AT slots on 2026-02-10 (a day no other test owns):
        //   10:00Z price 100: load 2.0, pv 0.5, imp 1.0, dis 0.5
        //     baseline_import 1.5, actual import 1.0 -> saved = 0.5 x import_price
        //   11:00Z price 200: pv 2.0, load 0.5, exp 1.0, chg 0.5
        //     no import on either side -> saved = -0.10 at SPOT for EVERY tariff
        //     (baseline export 1.5 vs actual export 1.0 - the export side is
        //     deliberately unchanged by Stufe 3).
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "('2026-02-10T10:00:00Z', 'AT', 'PT15M', 100.0, 'EUR', 'test'), "
                + "('2026-02-10T11:00:00Z', 'AT', 'PT15M', 200.0, 'EUR', 'test') "
                + "ON CONFLICT (bidding_zone, resolution, ts) DO UPDATE SET price_eur_mwh = EXCLUDED.price_eur_mwh");
        for (String site : new String[] {fest, dynAuf, sheet, bare}) {
            exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                    + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                    + "('2026-02-10T10:00:00Z', '" + tenantA + "', '" + site + "', 0.5, 2.0, 1.0, 0.0, 0.0, 0.5, 90), "
                    + "('2026-02-10T11:00:00Z', '" + tenantA + "', '" + site + "', 2.0, 0.5, 0.0, 1.0, 0.5, 0.0, 90) "
                    + "ON CONFLICT DO NOTHING");
        }
        // The daily variant (spark bars) shares the tariff valuation: one
        // recent covered slot for the fest site - baseline import 1.0 kWh vs
        // metered 0.6 -> saved (1.0 - 0.6) x 0.30 = 0.12 on that Berlin day
        // (the legacy spot math would have said 0.4 x 150/1000 = 0.06).
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "SELECT time_bucket('15 minutes', now() - interval '3 hours'), 'AT', 'PT15M', 150.0, 'EUR', 'test' "
                + "ON CONFLICT DO NOTHING");
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) "
                + "SELECT time_bucket('15 minutes', now() - interval '3 hours'), '" + tenantA + "', '"
                + fest + "', 0.0, 1.0, 0.6, 0.0, 0.0, 0.4, 90 ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/earnings?range=day&at=2026-02-10"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);

        // fest 30 ct: import price is the flat retail price, spot-independent.
        Map<String, Object> festRow = siteRow(body, fest);
        assertThat(festRow).containsEntry("tarifPriced", true);
        assertThat(num(festRow, "baselineEur")).isCloseTo(1.5 * 0.30 - 0.30, eps);
        assertThat(num(festRow, "actualEur")).isCloseTo(1.0 * 0.30 - 0.20, eps);
        assertThat(num(festRow, "savedEur")).isCloseTo(0.05, eps);

        // dynamisch + 18 ct Aufschlag: spot/10 + 18 = 28 ct on the 100er slot.
        Map<String, Object> dynRow = siteRow(body, dynAuf);
        assertThat(dynRow).containsEntry("tarifPriced", true);
        assertThat(num(dynRow, "savedEur")).isCloseTo(0.5 * 0.28 - 0.10, eps);

        // Maintained Preisblatt on an 'ohne' site: (10 + 16) x 1.19 = 30.94 ct
        // - the structured composition, USt on the spot share included.
        Map<String, Object> sheetRow = siteRow(body, sheet);
        assertThat(sheetRow).containsEntry("tarifArt", "ohne")
                .containsEntry("tarifPriced", true);
        assertThat(num(sheetRow, "savedEur")).isCloseTo(0.5 * 0.3094 - 0.10, eps);
        // The sheet changes ONLY the import valuation: Einspeise-Erlös stays
        // the spot-valued export, the Eigenverbrauchs-Wert stays null for an
        // 'ohne' tariff (Stufe-3 scope: those fields are deliberately
        // untouched - report §3.4 table).
        assertThat(num(sheetRow, "einspeiseErloesEur")).isCloseTo(0.20, eps);
        assertThat(sheetRow).containsEntry("eigenverbrauchsWertEur", null);

        // Bare 'ohne' site, flag off: BYTE-IDENTICAL to the legacy symmetric
        // spot math - hand-computed with the OLD formula
        // sum((load-pv)*spot/1000) / sum((imp-exp)*spot/1000).
        Map<String, Object> bareRow = siteRow(body, bare);
        assertThat(bareRow).containsEntry("tarifPriced", false);
        assertThat(num(bareRow, "baselineEur")).isCloseTo(
                (2.0 - 0.5) * 0.1 + (0.5 - 2.0) * 0.2, eps);
        assertThat(num(bareRow, "actualEur")).isCloseTo(1.0 * 0.1 - 1.0 * 0.2, eps);
        assertThat(num(bareRow, "savedEur")).isCloseTo(-0.05, eps);

        // The daily variant carries the SAME tariff valuation (0.12, not the
        // legacy 0.06).
        List<Map<String, Object>> festDaily = list(festRow, "dailySaved");
        assertThat(festDaily).hasSize(1);
        assertThat(num(festDaily.get(0), "savedEur")).isCloseTo(0.12, eps);
    }

    /**
     * Stufe 3 on the Historie side: {@code gridCostEur} is the real supply
     * cost - import energy x the SAME structured import price the steering
     * plans with - instead of "bare spot" (audit H8 amended). A {@code fest}
     * site's cost follows its flat 30 ct on priced AND unpriced buckets (the
     * flat tariff needs no Börsenpreis), through the day path (raw telemetry)
     * and the rollup path (week), and the totals carry the honest
     * {@code tarifPriced} label context. Bare-spot sites stay byte-identical -
     * pinned by the untouched historyDay/historyWeek tests on the 'ohne'
     * BERLIN site.
     */
    @Test
    void historyGridCostIsValuedAtTheSiteTariffLikeTheSteering() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";
        String site = createSiteWithTarif(demo, "Historie Tarif", "AT", "eigenverbrauch",
                "fest", "30");
        String device = java.util.UUID.randomUUID().toString();

        // Two 15-min buckets on 2026-06-22 (inside the week the rollup refresh
        // below covers, outside every other test's pinned windows):
        //   10:00Z (AT price 100): import 2.0 kW -> 0.5 kWh -> cost 0.15
        //   10:15Z (NO price):     import 1.0 kW -> 0.25 kWh -> cost 0.075
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, load_kw) VALUES "
                + "('2026-06-22T10:00:00Z', '" + tenantA + "', '" + site + "', '" + device + "', 2.0, 50.0, 1.0, 3.0), "
                + "('2026-06-22T10:15:00Z', '" + tenantA + "', '" + site + "', '" + device + "', 1.0, 50.0, 0.0, 1.0) "
                + "ON CONFLICT DO NOTHING");
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "('2026-06-22T10:00:00Z', 'AT', 'PT15M', 100.0, 'EUR', 'test') "
                + "ON CONFLICT (bidding_zone, resolution, ts) DO UPDATE SET price_eur_mwh = EXCLUDED.price_eur_mwh");

        ResponseEntity<Map<String, Object>> day = rest.exchange(
                url("/api/v1/sites/" + site + "/history?range=day&at=2026-06-22"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(day.getStatusCode()).isEqualTo(HttpStatus.OK);
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);
        List<Map<String, Object>> buckets = list(day.getBody(), "buckets");
        assertThat(buckets).hasSize(2);
        // Priced bucket: the chart still shows the spot price, the cost is the
        // tariff value (0.5 kWh x 0.30), NOT 0.5 x spot = 0.05.
        assertThat(num(buckets.get(0), "priceEurMwh")).isEqualTo(100.0);
        assertThat(num(buckets.get(0), "costEur")).isCloseTo(0.15, eps);
        // Unpriced bucket: a flat tariff needs no Börsenpreis - the cost is
        // present (0.25 x 0.30) instead of a data gap.
        assertThat(buckets.get(1).get("priceEurMwh")).isNull();
        assertThat(num(buckets.get(1), "costEur")).isCloseTo(0.075, eps);

        Map<String, Object> totals = map(day.getBody(), "totals");
        assertThat(num(totals, "gridCostEur")).isCloseTo(0.225, eps);
        assertThat(totals).containsEntry("tarifArt", "fest")
                .containsEntry("tarifPriced", true);

        // The rollup path (week) values with the same composition: refresh the
        // rollups (same CALL the historyWeek test uses) and expect the hour
        // bucket to carry 0.225.
        exec("CALL refresh_telemetry_rollups('2026-06-01T00:00:00Z')");
        ResponseEntity<Map<String, Object>> week = rest.exchange(
                url("/api/v1/sites/" + site + "/history?range=week&at=2026-06-22"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(week.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> hourBucket = list(week.getBody(), "buckets").stream()
                .filter(b -> "2026-06-22T10:00:00Z".equals(b.get("start")))
                .findFirst().orElseThrow();
        assertThat(num(hourBucket, "costEur")).isCloseTo(0.225, eps);
        assertThat(num(map(week.getBody(), "totals"), "gridCostEur")).isCloseTo(0.225, eps);
    }

    // ---- helpers ------------------------------------------------------------

    /** Scalar count query as the Postgres superuser (sees all tenants' rows). */
    private static long queryLong(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement st = c.createStatement();
                java.sql.ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        } catch (Exception e) {
            throw new IllegalStateException("query failed: " + sql, e);
        }
    }

    /** Scalar text query as the Postgres superuser (sees all tenants' rows). */
    private static String queryText(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement st = c.createStatement();
                java.sql.ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getString(1) : null;
        } catch (Exception e) {
            throw new IllegalStateException("query failed: " + sql, e);
        }
    }

    /** Scalar numeric query as the Postgres superuser (sees all tenants' rows). */
    private static double queryDouble(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement st = c.createStatement();
                java.sql.ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getDouble(1);
        } catch (Exception e) {
            throw new IllegalStateException("query failed: " + sql, e);
        }
    }

    // ---- inverter control confirmation --------------------------------------

    @Test
    void controlStatusIsIngestedFromHeartbeatAndTenantScoped() {
        var listener = new com.voltpilot.api.control.ControlStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, controlStatusRepo, commandLogWriter);
        String topic = "ems/00000000-0000-0000-0000-000000000001/"
                + "00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003/status";

        // A heartbeat carrying a CONFIRMED control block for the demo device.
        listener.handle(topic, ("{"
                + "\"schema_version\":\"1.0\","
                + "\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"00000000-0000-0000-0000-000000000003\","
                + "\"online\":true,\"control_source\":\"schedule\","
                + "\"control\":{\"commanded_kw\":-4.0,\"confirmed_kw\":-4.0,\"all_match\":true,"
                + "\"control_enabled\":true,\"certified\":true,\"slot_start\":\"2026-07-08T12:00:00Z\","
                + "\"checked_at\":\"2026-07-08T12:00:03Z\",\"mismatch_roles\":[]}}").getBytes(StandardCharsets.UTF_8));

        ResponseEntity<Map> ok = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/control-status"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), Map.class);
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ok.getBody().get("commandedKw")).isEqualTo(-4.0);
        assertThat(ok.getBody().get("confirmedKw")).isEqualTo(-4.0);
        assertThat(ok.getBody().get("allMatch")).isEqualTo(true);
        assertThat(ok.getBody().get("controlEnabled")).isEqualTo(true);
        assertThat(ok.getBody().get("certified")).isEqualTo(true);

        // Tenant B cannot even see the site -> RLS 404.
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/control-status"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A newer MISMATCH heartbeat upserts the row (newest wins).
        listener.handle(topic, ("{"
                + "\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"00000000-0000-0000-0000-000000000003\","
                + "\"control\":{\"commanded_kw\":-4.0,\"confirmed_kw\":-1.2,\"all_match\":false,"
                + "\"control_enabled\":true,\"certified\":true,"
                + "\"checked_at\":\"2026-07-08T12:05:00Z\",\"mismatch_roles\":[\"battery_power\"]}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> mism = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/control-status"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), Map.class);
        assertThat(mism.getBody().get("allMatch")).isEqualTo(false);
        assertThat(mism.getBody().get("confirmedKw")).isEqualTo(-1.2);
        assertThat(mism.getBody().get("mismatchRoles")).isEqualTo("battery_power");

        // A SPOOFED payload identity (device != topic) is ignored: row unchanged.
        listener.handle(topic, ("{"
                + "\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"99999999-9999-9999-9999-999999999999\","
                + "\"control\":{\"commanded_kw\":0,\"confirmed_kw\":0,\"all_match\":true,"
                + "\"control_enabled\":true,\"certified\":true,\"checked_at\":\"2026-07-08T12:09:00Z\"}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> still = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/control-status"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), Map.class);
        assertThat(still.getBody().get("allMatch")).isEqualTo(false); // spoof ignored, mismatch stays
    }

    /**
     * The FEED-IN CURTAILMENT truth reaches the portal (scout
     * {@code vp-pilsting-abregeln} Frage 2/3, PR 3 of 4). The edge has been
     * folding this block into its heartbeat since it was built - precisely so
     * the cloud could tell "geplant und ausgeführt" from "geplant, Anlage kann
     * es (noch) nicht" - and nothing read it, so the portal claimed "die PV
     * wird gedrosselt" next to a measured 16,6 kW feed-in.
     *
     * <p>The journey walks the captain's real constellation and its two
     * resolutions, and pins the honest fallback: a heartbeat WITHOUT the block
     * (an older edge, or a plant with no curtailment actor) leaves the read at
     * 204, so every surface keeps its plan wording.
     */
    @Test
    void curtailmentStatusIsIngestedFromHeartbeatAndTenantScoped() {
        var listener = new com.voltpilot.api.curtailment.CurtailmentStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, curtailmentStatusRepo, commandLogWriter);
        String topic = "ems/00000000-0000-0000-0000-000000000001/"
                + "00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003/status";
        String head = "{\"schema_version\":\"1.0\","
                + "\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"00000000-0000-0000-0000-000000000003\",\"online\":true,";
        String curtailUrl = url("/api/v1/sites/" + BERLIN_SITE + "/curtailment-status");
        HttpEntity<Void> demo = new HttpEntity<>(bearer(token("demo", "demo")));
        // The row belongs to the SITE, and this class shares the Berlin one: the
        // "no evidence yet" assertion below must be about THIS subject, not about
        // JUnit's method order.
        exec("DELETE FROM device_curtailment_status WHERE site_id = '" + BERLIN_SITE + "'");

        // A heartbeat WITHOUT the block changes nothing: no evidence, no claim.
        listener.handle(topic, (head + "\"control\":{\"commanded_kw\":0,\"confirmed_kw\":0,"
                + "\"all_match\":true,\"control_enabled\":true,\"certified\":true,"
                + "\"checked_at\":\"2026-08-02T10:40:00Z\"}}").getBytes(StandardCharsets.UTF_8));
        assertThat(rest.exchange(curtailUrl, HttpMethod.GET, demo, String.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        // Pilsting, 02.08. ~10:41: two Fronius units, kill-switch ON, NEITHER
        // released -> nothing applied. The cause the portal names.
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":0,"
                + "\"control_enabled\":true,\"active\":false,"
                + "\"checked_at\":\"2026-08-02T10:41:07Z\"}}").getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> unreleased = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        assertThat(unreleased.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(unreleased.getBody().get("units")).isEqualTo(2);
        assertThat(unreleased.getBody().get("certifiedUnits")).isEqualTo(0);
        assertThat(unreleased.getBody().get("active")).isEqualTo(false);
        // Nothing applied is NOT a disagreeing readback - it must stay null.
        assertThat(unreleased.getBody().get("allMatch")).isNull();
        assertThat(unreleased.getBody().get("appliedCapKw")).isNull();
        assertThat(unreleased.getBody().get("possibleOverride")).isEqualTo(false);

        // Tenant B cannot even see the site -> RLS 404.
        assertThat(rest.exchange(curtailUrl, HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // After the operator releases both units the cap is applied + confirmed:
        // the ONLY shape that is evidence of execution.
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":2,"
                + "\"control_enabled\":true,\"active\":true,\"applied_cap_kw\":12.5,"
                + "\"all_match\":true,\"checked_at\":\"2026-08-02T11:00:00Z\"}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> confirmed = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        assertThat(confirmed.getBody().get("certifiedUnits")).isEqualTo(2);
        assertThat(confirmed.getBody().get("active")).isEqualTo(true);
        assertThat(confirmed.getBody().get("allMatch")).isEqualTo(true);
        assertThat(((Number) confirmed.getBody().get("appliedCapKw")).doubleValue()).isEqualTo(12.5);

        // A foreign controller holding the inverter (Modbus has the lowest
        // priority on Fronius) is reported and must survive the round trip.
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":2,"
                + "\"control_enabled\":true,\"active\":true,\"applied_cap_kw\":0.0,"
                + "\"all_match\":true,\"possible_override\":true,"
                + "\"checked_at\":\"2026-08-02T11:05:00Z\"}}").getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> override = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        assertThat(override.getBody().get("possibleOverride")).isEqualTo(true);
        assertThat(((Number) override.getBody().get("appliedCapKw")).doubleValue()).isEqualTo(0.0);

        // A SPOOFED payload identity is ignored: the row is unchanged.
        listener.handle(topic, ("{\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"99999999-9999-9999-9999-999999999999\","
                + "\"curtailment\":{\"units\":9,\"certified_units\":9,\"control_enabled\":false,"
                + "\"active\":false,\"checked_at\":\"2026-08-02T11:09:00Z\"}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> still = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        assertThat(still.getBody().get("units")).isEqualTo(2);
        assertThat(still.getBody().get("possibleOverride")).isEqualTo(true);
    }

    /**
     * Die Abregelung JE EINHEIT (Geräteseiten Stufe 1, R4a / Captain-Entscheid
     * E2): bis hierher konnte die Cloud nur ZÄHLEN, also musste jede Fläche „an
     * alle freigegebenen Wechselrichter" sagen. Jetzt meldet die Box, WELCHE
     * Einheit freigegeben ist, welche Kappe sie hält und ob ihr Rücklesen
     * bestätigt hat - und die Cloud reicht es durch, statt es abzuleiten
     * (E2 hat die Portal-Heuristik ausdrücklich verworfen).
     */
    @Test
    void theCurtailmentUnitsAreIngestedPerHeartbeatAndReplacedWholesale() {
        var listener = new com.voltpilot.api.curtailment.CurtailmentStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, curtailmentStatusRepo, commandLogWriter);
        String topic = "ems/00000000-0000-0000-0000-000000000001/"
                + "00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003/status";
        String head = "{\"schema_version\":\"1.0\","
                + "\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"00000000-0000-0000-0000-000000000003\",\"online\":true,";
        String curtailUrl = url("/api/v1/sites/" + BERLIN_SITE + "/curtailment-status");
        HttpEntity<Void> demo = new HttpEntity<>(bearer(token("demo", "demo")));
        // Die Zeile gehört der ANLAGE, und diese Klasse teilt sich die Berliner.
        exec("DELETE FROM device_curtailment_status WHERE site_id = '" + BERLIN_SITE + "'");

        // 1. Ein ÄLTERER Edge-Stand: der Block ohne Liste. Die Zahl steht, die
        //    Liste ist LEER - „nicht gemeldet", nie „keine Einheiten".
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":1,"
                + "\"control_enabled\":true,\"active\":true,\"applied_cap_kw\":8.2,"
                + "\"all_match\":true,\"checked_at\":\"2026-08-21T10:00:00Z\"}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> alt = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        assertThat(alt.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(alt.getBody().get("units")).isEqualTo(2);
        assertThat((List<?>) alt.getBody().get("perUnit")).isEmpty();

        // 2. Mit Liste: Feld für Feld, und die zweite Einheit hat NICHTS
        //    angewandt - keine Kappe, kein Urteil.
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":1,"
                + "\"control_enabled\":true,\"active\":true,\"applied_cap_kw\":8.2,"
                + "\"all_match\":true,\"checked_at\":\"2026-08-21T10:05:00Z\","
                + "\"per_unit\":[{\"source_id\":\"src-fronius-1\",\"certified\":true,"
                + "\"applied_cap_kw\":8.2,\"match\":true},"
                + "{\"source_id\":\"src-fronius-2\",\"certified\":false}]}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> mit = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        List<Map<String, Object>> units = (List<Map<String, Object>>) mit.getBody().get("perUnit");
        assertThat(units).hasSize(2);
        assertThat(units.get(0).get("sourceId")).isEqualTo("src-fronius-1");
        assertThat(units.get(0).get("certified")).isEqualTo(true);
        assertThat(((Number) units.get(0).get("appliedCapKw")).doubleValue()).isEqualTo(8.2);
        assertThat(units.get(0).get("match")).isEqualTo(true);
        assertThat(units.get(1).get("sourceId")).isEqualTo("src-fronius-2");
        assertThat(units.get(1).get("certified")).isEqualTo(false);
        // ⚠ Beides NULL, nie 0/false: „nichts angewandt" ist kein widersprechendes
        // Rücklesen, und eine Kappe von 0 wäre eine behauptete Zahl.
        assertThat(units.get(1).get("appliedCapKw")).isNull();
        assertThat(units.get(1).get("match")).isNull();

        // 3. Der Satz wird GANZ ersetzt: eine verschwundene Einheit bleibt nicht
        //    als Geist stehen, und eine ohne Join-Schlüssel wird verworfen (die
        //    Liste ist dann kürzer als `units` - die Zahl bleibt die Zahl).
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":2,"
                + "\"control_enabled\":true,\"active\":true,\"applied_cap_kw\":16.4,"
                + "\"all_match\":true,\"checked_at\":\"2026-08-21T10:10:00Z\","
                + "\"per_unit\":[{\"source_id\":\"src-fronius-2\",\"certified\":true,"
                + "\"applied_cap_kw\":16.4,\"match\":true},{\"certified\":true}]}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> ersetzt = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        List<Map<String, Object>> nach = (List<Map<String, Object>>) ersetzt.getBody().get("perUnit");
        assertThat(nach).hasSize(1);
        assertThat(nach.get(0).get("sourceId")).isEqualTo("src-fronius-2");
        assertThat(ersetzt.getBody().get("units")).isEqualTo(2);

        // 4. Der Mandanten-Zaun gilt unverändert.
        assertThat(rest.exchange(curtailUrl, HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * „Grenzen &amp; Wächter" Stufe 0: der EINSPEISEWÄCHTER und die Grenze IM
     * GERÄT reisen im SELBEN Block und werden cloud-seitig endlich gelesen.
     *
     * <p>Die Box sendet den {@code export_guard}-Block seit ihrem Bau in JEDEM
     * Herzschlag - geltende Grenze, kommandierte Kappe, und ob sie überhaupt an
     * ein Gerät geschrieben werden kann. Niemand las ihn, also war „welche
     * Einspeisegrenze hält die Box, und wirkt sie?" nur per Wartungstunnel
     * beantwortbar: zwei Untersuchungsrunden an Anlage Herzogau.
     *
     * <p>Der Block hier ist die LIVE-Momentaufnahme dieser Anlage vom
     * 17.08.2026, 18:19 - Grenze 70 kW bekannt, Kappe 76,9 kW berechnet, und an
     * KEIN Gerät geschrieben, weil keiner der zwei Wechselrichter freigegeben
     * ist. Dazu der Deye-Deckel von 33,0 kW aus 0x00E7, der zwei Runden lang
     * unsichtbar war.
     */
    @Test
    void theExportGuardAndTheDevicesOwnLimitAreIngestedAndTenantScoped() {
        // ⚠ Die Abregel-Zeile gehört der ANLAGE, und diese Klasse teilt sich die
        // Berliner (die Haus-Disziplin der geteilten Anlage): der Nachbar-Test
        // beginnt mit einem 204 „noch kein Beleg". Also am ANFANG UND am ENDE
        // abräumen, damit keine JUnit-Reihenfolge das Ergebnis entscheidet.
        exec("DELETE FROM device_curtailment_status WHERE site_id = '" + BERLIN_SITE + "'");
        try {
            theExportGuardJourney();
        } finally {
            exec("DELETE FROM device_curtailment_status WHERE site_id = '" + BERLIN_SITE + "'");
        }
    }

    private void theExportGuardJourney() {
        var listener = new com.voltpilot.api.curtailment.CurtailmentStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, curtailmentStatusRepo, commandLogWriter);
        String topic = "ems/00000000-0000-0000-0000-000000000001/"
                + "00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003/status";
        String head = "{\"schema_version\":\"1.0\","
                + "\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"00000000-0000-0000-0000-000000000003\",\"online\":true,";
        String curtailUrl = url("/api/v1/sites/" + BERLIN_SITE + "/curtailment-status");
        HttpEntity<Void> demo = new HttpEntity<>(bearer(token("demo", "demo")));

        // (1) Ein Herzschlag OHNE die zwei Blöcke: die Zeile entsteht, aber
        //     nichts wird über eine Grenze behauptet. Das ist der Zustand JEDER
        //     Anlage vor dieser Stufe - und der einer älteren Edge nach ihr.
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":0,"
                + "\"control_enabled\":true,\"active\":false,"
                + "\"checked_at\":\"2026-08-17T16:10:00Z\"}}").getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> bare = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        assertThat(bare.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(bare.getBody().get("exportGuard")).isNull();
        assertThat(bare.getBody().get("deviceExportLimit")).isNull();

        // (2) Die Herzogau-Momentaufnahme, wörtlich.
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":0,"
                + "\"control_enabled\":true,\"active\":false,"
                + "\"checked_at\":\"2026-08-17T16:19:00Z\","
                + "\"device_export_limit_kw\":33.0,"
                + "\"device_export_limit_register\":\"0x00e7\","
                + "\"device_export_limit_read_at\":\"2026-08-17T04:12:00Z\","
                + "\"export_guard\":{\"limit_kw\":70,\"state\":\"ueberwacht\","
                + "\"reason\":\"Die Einspeisung liegt bei 0,0 kW von 70,0 kW.\","
                + "\"cap_kw\":76.927,\"limiting\":false,\"blind\":false,"
                + "\"effective\":false,"
                + "\"reach\":\"Kein Wechselrichter ist für die Abregelung freigegeben (0 von 2).\"}}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> live = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> guard = (Map<String, Object>) live.getBody().get("exportGuard");
        assertThat(guard).isNotNull();
        assertThat(((Number) guard.get("limitKw")).doubleValue()).isEqualTo(70.0);
        assertThat(guard.get("state")).isEqualTo("ueberwacht");
        assertThat(((Number) guard.get("capKw")).doubleValue()).isEqualTo(76.927);
        assertThat(guard.get("limiting")).isEqualTo(false);
        // DAS Feld, für das es den Block gibt: die Kappe erreicht kein Gerät.
        assertThat(guard.get("effective")).isEqualTo(false);
        assertThat((String) guard.get("reach")).contains("freigegeben (0 von 2)");
        @SuppressWarnings("unchecked")
        Map<String, Object> dev = (Map<String, Object>) live.getBody().get("deviceExportLimit");
        assertThat(dev).isNotNull();
        assertThat(((Number) dev.get("limitKw")).doubleValue()).isEqualTo(33.0);
        assertThat(dev.get("register")).isEqualTo("0x00e7");
        // Der EIGENE Frische-Anker: das Register wird höchstens täglich gelesen,
        // es darf sich checkedAt nie ausleihen.
        assertThat((String) dev.get("readAt")).startsWith("2026-08-17T04:12");

        // (3) Fremder Mandant sieht die Anlage gar nicht -> RLS 404.
        assertThat(rest.exchange(curtailUrl, HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // (4) Die Zeile wird je Herzschlag ERSETZT: ein Wächter, der verschwindet,
        //     darf kein altes Urteil auf Vorrat behalten - und ein UNBEKANNTES
        //     Zustands-Wort verwirft den ganzen Block statt einen Satz zu
        //     speichern, den keine Fläche einordnen kann.
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":2,"
                + "\"control_enabled\":true,\"active\":true,\"all_match\":true,"
                + "\"checked_at\":\"2026-08-17T16:25:00Z\","
                + "\"export_guard\":{\"limit_kw\":70,\"state\":\"tanzt\",\"effective\":true}}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> replaced = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        assertThat(replaced.getBody().get("exportGuard")).isNull();
        assertThat(replaced.getBody().get("deviceExportLimit")).isNull();
        assertThat(replaced.getBody().get("certifiedUnits")).isEqualTo(2);

        // (5) Und wirkt der Wächter, sagt er das ebenso ehrlich - ohne Lücken-Satz.
        listener.handle(topic, (head + "\"curtailment\":{\"units\":2,\"certified_units\":2,"
                + "\"control_enabled\":true,\"active\":true,\"all_match\":true,"
                + "\"checked_at\":\"2026-08-17T16:30:00Z\","
                + "\"export_guard\":{\"limit_kw\":70,\"state\":\"regelt\","
                + "\"reason\":\"Die Einspeisung wird auf 67,3 kW begrenzt.\","
                + "\"cap_kw\":67.3,\"limiting\":true,\"effective\":true}}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> working = rest.exchange(curtailUrl, HttpMethod.GET, demo, Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> ok = (Map<String, Object>) working.getBody().get("exportGuard");
        assertThat(ok.get("effective")).isEqualTo(true);
        assertThat(ok.get("limiting")).isEqualTo(true);
        assertThat(ok.get("reach")).isNull();
    }

    /**
     * Der Kunden-Lesepfad verbindet den alten {@code flows}-Beleg mit dem
     * immer gesendeten Top-Level-Build ({@code GET /api/v1/edge-versions}).
     *
     * <p>Was halten muss: eine gemeldete Version reist verlustfrei durch, ein
     * einzeln fehlendes Feld bleibt LEER (nie eine geratene Version), ein
     * {@code flows}-Block ohne beide Felder erzeugt GAR KEINE Zeile (ein Gerät
     * ohne Meldung bleibt „unbekannt", nie „veraltet"), ein Update ersetzt die
     * eine Zeile, und ein anderer Mandant sieht nichts davon.
     */
    @Test
    void edgeVersionIsIngestedFromTheFlowsHeartbeatAndTenantScoped() {
        String deviceId = "00000000-0000-0000-0000-000000000003";
        exec("DELETE FROM device_update_status WHERE device_id = '" + deviceId + "'");
        exec("DELETE FROM device_edge_version WHERE device_id = '" + deviceId + "'");
        var listener = new com.voltpilot.api.flows.FlowNodeStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, flowStatusRepo, edgeVersionRepo,
                ruleEventWriter);
        String topic = "ems/00000000-0000-0000-0000-000000000001/"
                + "00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003/status";
        String head = "{\"schema_version\":\"1.0\","
                + "\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"00000000-0000-0000-0000-000000000003\",\"online\":true,";
        String versionsUrl = url("/api/v1/edge-versions");
        HttpEntity<Void> demo = new HttpEntity<>(bearer(token("demo", "demo")));

        // Ein flows-Block OHNE Versionsfelder (ältere Edge): die Acks laufen,
        // aber es entsteht keine Versionszeile - „unbekannt" bleibt unbekannt.
        listener.handle(topic, (head + "\"ts\":\"2026-08-03T09:00:00Z\","
                + "\"flows\":{\"applied\":[]}}").getBytes(StandardCharsets.UTF_8));
        ResponseEntity<List> none = rest.exchange(versionsUrl, HttpMethod.GET, demo, List.class);
        assertThat(none.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(edgeVersionFor(none.getBody(), deviceId)).isNull();

        listener.handle(topic, (head + "\"ts\":\"2026-08-03T09:15:00Z\","
                + "\"flows\":{\"core_version\":\"1.4.2\",\"palette_version\":\"0.3.0\","
                + "\"applied\":[]}}").getBytes(StandardCharsets.UTF_8));
        ResponseEntity<List> reported = rest.exchange(versionsUrl, HttpMethod.GET, demo, List.class);
        Map<String, Object> row = edgeVersionFor(reported.getBody(), deviceId);
        assertThat(row).isNotNull();
        assertThat(row.get("deviceId")).isEqualTo("00000000-0000-0000-0000-000000000003");
        assertThat(row.get("siteId")).isEqualTo("00000000-0000-0000-0000-000000000002");
        assertThat(row.get("coreVersion")).isEqualTo("1.4.2");
        assertThat(row.get("paletteVersion")).isEqualTo("0.3.0");

        // Der andere Mandant sieht davon nichts (RLS).
        assertThat(rest.exchange(versionsUrl, HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), List.class).getBody())
                .isEmpty();

        // Ein Update ersetzt die EINE Zeile; die fehlende Palette-Version bleibt
        // leer statt die alte weiterzubehaupten.
        listener.handle(topic, (head + "\"ts\":\"2026-08-03T09:30:00Z\","
                + "\"flows\":{\"core_version\":\"1.5.0\",\"applied\":[]}}")
                .getBytes(StandardCharsets.UTF_8));
        ResponseEntity<List> updated = rest.exchange(versionsUrl, HttpMethod.GET, demo, List.class);
        Map<String, Object> after = edgeVersionFor(updated.getBody(), deviceId);
        assertThat(after).isNotNull();
        assertThat(after.get("coreVersion")).isEqualTo("1.5.0");
        assertThat(after.get("paletteVersion")).isNull();

        // Geräteseiten Stufe 1 (R2a): der Kunde bekommt zusätzlich das URTEIL
        // gegen das Release-Register - hier ist es LEER, also wird ehrlich
        // nichts behauptet (kein Maßstab ⇒ beide Felder null).
        assertThat(after.get("newestRelease")).isNull();
        assertThat(after.get("upToDate")).isNull();

        // Mit Register: der gemeldete Stand ist nicht eingetragen - das ist eine
        // Lücke im REGISTER, keine Alters-Aussage. Der Soll steht trotzdem.
        exec("INSERT INTO edge_release (release_seq, version, target_commit, created_by) "
                + "VALUES (4200, 'edge-2099.01.1', 'deadbeef', 'test')");
        try {
            Map<String, Object> judged = edgeVersionFor(rest
                    .exchange(versionsUrl, HttpMethod.GET, demo, List.class).getBody(), deviceId);
            assertThat(judged).isNotNull();
            assertThat(judged.get("newestRelease")).isEqualTo("edge-2099.01.1");
            assertThat(judged.get("upToDate")).as("nicht registriert ist NIE veraltet").isNull();

            // Und der Normalfall: die Box fährt den Soll-Stand, mit dem
            // Tag-Lauf-Stempel `<tag>-<kurzsha>` (die PRÄFIX-Regel).
            listener.handle(topic, (head + "\"ts\":\"2026-08-03T09:45:00Z\","
                    + "\"flows\":{\"core_version\":\"edge-2099.01.1-9b37439a02c1\","
                    + "\"applied\":[]}}").getBytes(StandardCharsets.UTF_8));
            Map<String, Object> current = edgeVersionFor(rest
                    .exchange(versionsUrl, HttpMethod.GET, demo, List.class).getBody(), deviceId);
            assertThat(current).isNotNull();
            assertThat(current.get("upToDate")).isEqualTo(Boolean.TRUE);

            // Regression der Box-Seite: der installierte Build reist top-level
            // auch dann, wenn GAR KEIN flows-Block vorhanden ist. Er ist die
            // primäre Quelle und bleibt sichtbar, statt „meldet keinen Stand".
            var updateListener = new com.voltpilot.api.ota.UpdateStatusListener(
                    "tcp://localhost:1883", "", "", deviceRepo, updateStatusRepo);
            updateListener.handle(topic, (head
                    + "\"ts\":\"2026-08-28T07:10:00Z\","
                    + "\"version\":\"edge-2099.01.1-cafebabefeed\","
                    + "\"update\":{\"backend\":\"compose\",\"state\":\"idle\"}}")
                    .getBytes(StandardCharsets.UTF_8));
            Map<String, Object> installed = edgeVersionFor(rest
                    .exchange(versionsUrl, HttpMethod.GET, demo, List.class).getBody(), deviceId);
            assertThat(installed).isNotNull();
            assertThat(installed.get("coreVersion"))
                    .isEqualTo("edge-2099.01.1-cafebabefeed");
            assertThat(installed.get("upToDate")).isEqualTo(Boolean.TRUE);
        } finally {
            exec("DELETE FROM edge_release WHERE release_seq = 4200");
            exec("DELETE FROM device_update_status WHERE device_id = '" + deviceId + "'");
            exec("DELETE FROM device_edge_version WHERE device_id = '" + deviceId + "'");
        }
    }

    /**
     * The in-slot EXECUTION truth reaches the portal (Fahrplan concept
     * vp-fahrplan-kunde-konzept §5, PR 3). Since the in-slot duties the box
     * knowingly deviates from the plan's watt value, so {@code commandedKw}
     * alone left the portal stating a bare number next to a Fahrplan bar
     * showing a different one - it could name no direction and no cause. The
     * heartbeat's additive {@code control.execution} block plus the top-level
     * {@code control_source} now travel end to end, and an older edge (no
     * block) provably still lands with NULLs, so nothing claims a direction it
     * was not told.
     */
    @Test
    void controlStatusCarriesTheInSlotExecutionTruthAndDegradesForAnOlderEdge() {
        var listener = new com.voltpilot.api.control.ControlStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, controlStatusRepo, commandLogWriter);
        String topic = "ems/00000000-0000-0000-0000-000000000001/"
                + "00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003/status";
        String head = "{\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"00000000-0000-0000-0000-000000000003\",";

        // The captain's live constellation (30.07., 21:22): the plan discharged
        // -4,332 kW into a 7,117 kW house, so the box RAISED the discharge.
        listener.handle(topic, (head
                + "\"control_source\":\"schedule\","
                + "\"control\":{\"commanded_kw\":-7.087,\"confirmed_kw\":-7.087,\"all_match\":true,"
                + "\"control_enabled\":true,\"certified\":true,"
                + "\"checked_at\":\"2026-07-30T21:22:03Z\","
                + "\"execution\":{\"mode\":\"follow\",\"direction\":\"deepen\","
                + "\"planned_kw\":-4.332,\"deficit_kw\":7.087}}}").getBytes(StandardCharsets.UTF_8));

        ResponseEntity<Map> followed = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/control-status"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), Map.class);
        assertThat(followed.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(followed.getBody().get("controlSource")).isEqualTo("schedule");
        assertThat(followed.getBody().get("executionMode")).isEqualTo("follow");
        assertThat(followed.getBody().get("executionDirection")).isEqualTo("deepen");
        assertThat(followed.getBody().get("executionPlannedKw")).isEqualTo(-4.332);
        assertThat(followed.getBody().get("executionTargetKw")).isEqualTo(7.087);

        // The correction ENDS: the whole row is replaced, so no stale direction
        // may survive as a claim about what the device is doing now.
        listener.handle(topic, (head
                + "\"control_source\":\"schedule\","
                + "\"control\":{\"commanded_kw\":-4.0,\"confirmed_kw\":-4.0,\"all_match\":true,"
                + "\"control_enabled\":true,\"certified\":true,"
                + "\"checked_at\":\"2026-07-30T21:40:00Z\","
                + "\"execution\":{\"mode\":\"plan\"}}}").getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> planned = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/control-status"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), Map.class);
        assertThat(planned.getBody().get("executionMode")).isEqualTo("plan");
        assertThat(planned.getBody().get("executionDirection")).isNull();
        assertThat(planned.getBody().get("executionPlannedKw")).isNull();
        assertThat(planned.getBody().get("executionTargetKw")).isNull();

        // An OLDER edge sends no execution block: the coarse source lands, the
        // precise fields stay NULL - the portal keeps its generic wording.
        listener.handle(topic, (head
                + "\"control_source\":\"default\","
                + "\"control\":{\"commanded_kw\":-2.0,\"confirmed_kw\":-2.0,\"all_match\":true,"
                + "\"control_enabled\":true,\"certified\":true,"
                + "\"checked_at\":\"2026-07-30T21:55:00Z\"}}").getBytes(StandardCharsets.UTF_8));
        ResponseEntity<Map> legacy = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/control-status"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), Map.class);
        assertThat(legacy.getBody().get("controlSource")).isEqualTo("default");
        assertThat(legacy.getBody().get("executionMode")).isNull();
        assertThat(legacy.getBody().get("executionDirection")).isNull();
    }

    /**
     * The per-source PV breakdown (#524): a multi-inverter site's composite PV
     * was ONE opaque number in the portal, so the parts (Deye 8,3 + Fronius 21,3
     * + Fronius WR 2 9,3) were visible only on the edge's own :8484 page. The
     * heartbeat's additive {@code sources} block now lands in
     * device_source_status and is served per site - RLS-scoped like every site
     * route, primary first, honest health, and a wholesale replace so a removed
     * source cannot ghost in the breakdown.
     */
    @Test
    @SuppressWarnings("unchecked")
    void siteSourcesExposeThePartsOfTheCompositePvTenantScoped() {
        var listener = new com.voltpilot.api.sources.SourceStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, sourceStatusRepo);
        String topic = "ems/00000000-0000-0000-0000-000000000001/"
                + "00000000-0000-0000-0000-000000000002/00000000-0000-0000-0000-000000000003/status";
        String identity = "\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"00000000-0000-0000-0000-000000000003\",";

        listener.handle(topic, ("{\"schema_version\":\"1.0\"," + identity
                + "\"online\":true,\"sources\":{\"reported_at\":\"2026-07-21T10:00:00Z\",\"entries\":["
                + "{\"id\":\"inverter\",\"kind\":\"primary\",\"brand\":\"deye\",\"model\":\"SUN-12K\","
                + "\"label\":\"Deye\",\"pv_kw\":8.3,\"health\":\"ok\",\"read_at\":\"2026-07-21T09:59:55Z\"},"
                + "{\"id\":\"src-1\",\"kind\":\"source\",\"role\":\"pv-generation\",\"brand\":\"fronius\","
                + "\"label\":\"Fronius Anlage\",\"pv_kw\":21.3,\"health\":\"ok\"},"
                + "{\"id\":\"src-2\",\"kind\":\"source\",\"role\":\"pv-generation\",\"brand\":\"fronius\","
                + "\"label\":\"Fronius WR 2\",\"pv_kw\":9.3,\"health\":\"stale\"}]}}")
                .getBytes(StandardCharsets.UTF_8));

        ResponseEntity<List> ok = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/sources"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), List.class);
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> body = ok.getBody();
        assertThat(body).hasSize(3);
        assertThat(body.get(0).get("kind")).isEqualTo("primary"); // primary first
        assertThat(body.get(0).get("pvKw")).isEqualTo(8.3);
        assertThat(body.get(0).get("health")).isEqualTo("ok");
        // The parts sum to the composite the site publishes (8.3+21.3+9.3).
        double sum = body.stream().mapToDouble(r -> ((Number) r.get("pvKw")).doubleValue()).sum();
        assertThat(sum).isCloseTo(38.9, within(1e-9));
        Map<String, Object> stale = body.stream()
                .filter(r -> "src-2".equals(r.get("sourceId"))).findFirst().orElseThrow();
        assertThat(stale.get("health")).isEqualTo("stale"); // reported, never dropped to 0
        assertThat(stale.get("label")).isEqualTo("Fronius WR 2");
        assertThat(stale.get("powerKw")).isNull(); // absent stays absent

        // Tenant B cannot even see the site -> RLS 404 (never a leak).
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/sources"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A spoofed payload identity is ignored: the set stays as reported.
        listener.handle(topic, ("{\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"99999999-9999-9999-9999-999999999999\","
                + "\"sources\":{\"entries\":[{\"id\":\"evil\",\"kind\":\"source\",\"pv_kw\":999}]}}")
                .getBytes(StandardCharsets.UTF_8));
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/sources"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), List.class).getBody()).hasSize(3);

        // The heartbeat carries the COMPLETE Ist: a removed source disappears.
        listener.handle(topic, ("{" + identity
                + "\"sources\":{\"entries\":[{\"id\":\"inverter\",\"kind\":\"primary\","
                + "\"pv_kw\":9.0,\"health\":\"ok\"}]}}").getBytes(StandardCharsets.UTF_8));
        List<Map<String, Object>> after = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/sources"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), List.class).getBody();
        assertThat(after).hasSize(1);
        assertThat(after.get(0).get("pvKw")).isEqualTo(9.0);

        // Clean up so sibling tests on the shared Berlin site are unaffected.
        listener.handle(topic, ("{" + identity + "\"sources\":{\"entries\":[]}}")
                .getBytes(StandardCharsets.UTF_8));
    }

    /** Run a statement as the Postgres superuser (bypasses RLS) to seed feed rows. */
    @Test
    @SuppressWarnings("unchecked")
    void customerAssignsTopologyRolesForItsOwnSiteAndStrategiesAreScoped() {
        String demo = token("demo", "demo"); // tenant A, sees BERLIN_SITE
        String gridEntity = "aaaa1111-0000-0000-0000-000000000001";
        // Seed a v2 grid-meter entity on the demo tenant's Berlin site (superuser,
        // RLS-bypassing) so the customer can re-assign its role.
        exec("INSERT INTO measurement_point (id, tenant_id, site_id, role, entity_type, "
                + "capabilities) VALUES ('" + gridEntity + "', "
                + "'00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', 'grid-meter', "
                + "'grid-meter', '{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}'::jsonb)");

        // By default power_kw resolves to the grid role (DefaultRole mapping).
        Map<String, Object> before = getMap(url("/api/v1/sites/" + BERLIN_SITE + "/topology"), demo);
        assertThat(roleOfCapability(before, gridEntity, "power_kw")).isEqualTo("grid");

        // The CUSTOMER re-assigns power_kw to the consumer role on ITS OWN site.
        ResponseEntity<Map<String, Object>> put = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/topology-roles"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("assignments", List.of(Map.of("entityId", gridEntity,
                        "channel", "power_kw", "role", "consumer", "primary", false))),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(put.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(roleOfCapability(put.getBody(), gridEntity, "power_kw")).isEqualTo("consumer");

        // A blank role reverts to the DefaultRole mapping.
        ResponseEntity<Map<String, Object>> cleared = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/topology-roles"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("assignments", List.of(Map.of("entityId", gridEntity,
                        "channel", "power_kw", "role", ""))), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(roleOfCapability(cleared.getBody(), gridEntity, "power_kw")).isEqualTo("grid");

        // Validation: an unknown role is 400.
        ResponseEntity<String> badRole = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/topology-roles"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("assignments", List.of(Map.of("entityId", gridEntity,
                        "channel", "power_kw", "role", "wolke"))), bearer(demo)), String.class);
        assertThat(badRole.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // RLS: the customer cannot touch a foreign site's roles (404, never 403).
        ResponseEntity<String> foreignSite = rest.exchange(
                url("/api/v1/sites/" + HAMBURG_SITE + "/topology-roles"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("assignments", List.of()), bearer(demo)), String.class);
        assertThat(foreignSite.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // The customer cannot re-assign a foreign entity even via its own site path.
        ResponseEntity<String> foreignEntity = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/topology-roles"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("assignments", List.of(Map.of("entityId",
                        java.util.UUID.randomUUID().toString(), "channel", "power_kw",
                        "role", "grid"))), bearer(demo)), String.class);
        assertThat(foreignEntity.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // Strategy chips: no active flow yet => an empty map; foreign site 404.
        Map<String, Object> strategies = getMap(
                url("/api/v1/sites/" + BERLIN_SITE + "/entity-strategies"), demo);
        assertThat(strategies).isEmpty();
        ResponseEntity<String> foreignStrategies = rest.exchange(
                url("/api/v1/sites/" + HAMBURG_SITE + "/entity-strategies"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class);
        assertThat(foreignStrategies.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        exec("DELETE FROM entity_role_assignment WHERE entity_id = '" + gridEntity + "'");
        exec("DELETE FROM measurement_point WHERE id = '" + gridEntity + "'");
    }

    private Map<String, Object> getMap(String url, String token) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url, HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    @SuppressWarnings("unchecked")
    private static String roleOfCapability(Map<String, Object> topology, String entityId,
            String channel) {
        for (Map<String, Object> e : (List<Map<String, Object>>) topology.get("entities")) {
            if (!entityId.equals(e.get("id"))) {
                continue;
            }
            for (Map<String, Object> c : (List<Map<String, Object>>) e.get("capabilities")) {
                if (channel.equals(c.get("channel"))) {
                    return (String) c.get("role");
                }
            }
        }
        throw new AssertionError("capability " + channel + " of " + entityId + " not found");
    }

    private static void exec(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
        }
    }

    /** Seed the pre-hardening orphan state solely to exercise site cleanup. */
    private static void seedLegacyOrphanOcpp(String tenant, String site, String device) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement st = c.createStatement()) {
            st.execute("SET session_replication_role = replica");
            try {
                OcppTestData.seed(sql -> {
                    try {
                        st.execute(sql);
                    } catch (java.sql.SQLException e) {
                        throw new IllegalStateException(e);
                    }
                }, tenant, site, device);
            } finally {
                st.execute("SET session_replication_role = origin");
            }
        } catch (Exception e) {
            throw new IllegalStateException("legacy OCPP orphan seed failed", e);
        }
    }

    /**
     * The Anlagen-scharfe Erlöse ({@code GET /sites/{id}/earnings}, Historie
     * concept F1 / P3): one Anlage, one period, and a COMPOSITION the surface
     * can show without inventing a second money model.
     *
     * <p>Hand-computed over two current-month CH slots of a {@code fest} 30
     * ct/kWh site (so the import price is a flat, checkable number):
     * <pre>
     *   11:00 spot 100: pv 2.0 load 0.5 import 0.0 export 1.0
     *   18:00 spot 200: pv 0.0 load 1.5 import 1.0 export 0.0
     *   einspeise  = 1.0 * 100/1000                       = 0.10
     *   selbstverbrauch = 0.5 + 0.5 = 1.0 kWh -> * 0.30   = 0.30
     *   stromkosten = 1.0 kWh * 0.30 EUR/kWh              = 0.30
     *   netto      = 0.10 + 0.30 - 0.30                   = 0.10
     *   actual     = 0.30 - 0.10                          = 0.20  (= stromkosten - einspeise)
     *   baseline   = -1.5*0.10  +  1.5*0.30               = 0.30
     *   saved      = 0.30 - 0.20                          = 0.10
     * </pre>
     *
     * <p>Both documented identities are asserted EXACTLY, plus the honest
     * degradation of a site without data, the week range the fleet endpoint
     * refuses, and the RLS fence.
     */
    @Test
    void siteEarningsAnswerOneAnlageWithItsReconcilingComposition() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String site = createSiteWithTarif(demo, "Erloese Welt", "CH", "eigenverbrauch", "fest", "30");
        String leer = createSite(demo, "Erloese Leer", "CH", "eigenverbrauch");

        String t1 = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '14 days 11 hours') AT TIME ZONE 'Europe/Berlin'";
        String t2 = "(date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')"
                + " + interval '14 days 18 hours') AT TIME ZONE 'Europe/Berlin'";
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "VALUES (" + t1 + ", 'CH', 'PT15M', 100.0, 'EUR', 'test'), "
                + "(" + t2 + ", 'CH', 'PT15M', 200.0, 'EUR', 'test') ON CONFLICT DO NOTHING");
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                + "(" + t1 + ", '" + tenantA + "', '" + site + "', 2.0, 0.5, 0.0, 1.0, 0.5, 0.0, 90), "
                + "(" + t2 + ", '" + tenantA + "', '" + site + "', 0.0, 1.5, 1.0, 0.0, 0.0, 0.5, 90) "
                + "ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + site + "/earnings?range=month"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);

        assertThat(body).containsEntry("siteId", site).containsEntry("range", "month")
                .containsEntry("tarifArt", "fest").containsEntry("tarifPriced", true)
                .containsEntry("reason", null)
                // No commissioned pv asset -> the export honestly stays at
                // spot, and the honesty flag says so (B2 fix).
                .containsEntry("exportVerguetungPriced", false);
        assertThat(num(body, "einspeiseErloesEur")).isCloseTo(0.10, eps);
        assertThat(num(body, "eigenverbrauchsWertEur")).isCloseTo(0.30, eps);
        assertThat(num(body, "stromkostenEur")).isCloseTo(0.30, eps);
        assertThat(num(body, "nettoErgebnisEur")).isCloseTo(0.10, eps);
        assertThat(num(body, "savedEur")).isCloseTo(0.10, eps);
        assertThat(num(body, "bezogenKwh")).isCloseTo(1.0, eps);
        assertThat(num(body, "bezugspreisCtKwh")).isCloseTo(30.0, org.assertj.core.data.Offset.offset(1e-6));
        // No anzulegender Wert -> NOT eligible -> null, so the surface says
        // "kein anzulegender Wert hinterlegt" instead of a fabricated 0,00 EUR.
        assertThat(body).containsEntry("marktpraemieEur", null);

        // Identity 1: the composition IS the result the card shows.
        assertThat(num(body, "nettoErgebnisEur")).isCloseTo(
                num(body, "einspeiseErloesEur") + num(body, "eigenverbrauchsWertEur")
                        - num(body, "stromkostenEur"), eps);
        // Identity 2: the exposed import term is the one inside actualEur.
        assertThat(num(body, "stromkostenEur") - num(body, "einspeiseErloesEur"))
                .isCloseTo(num(body, "actualEur"), eps);

        // B2 parity with the fleet twin: the cockpit money hero reads
        // gesamtertragEur = einspeise + eigenverbrauch from THIS endpoint.
        assertThat(num(body, "gesamtertragEur")).isCloseTo(0.40, eps);
        assertThat(num(body, "gesamtertragEur")).isCloseTo(
                num(body, "einspeiseErloesEur") + num(body, "eigenverbrauchsWertEur"), eps);
        // The forward expected Marktwert Solar is wired (its math is proven on
        // the fleet endpoint, which shares the query); with no forward PV
        // forecast seeded here it is honestly null, never a fabricated figure.
        assertThat(body).containsEntry("expectedMarketValueSolarCtKwh", null)
                .containsEntry("expectedMarketValueSlots", null)
                .containsEntry("expectedMarketValueFrom", null)
                .containsEntry("expectedMarketValueTo", null);

        // The money chart carries the three parts per bucket (month -> day),
        // and its cumulative line lands on the period result.
        List<Map<String, Object>> series = list(body, "series");
        assertThat(series).hasSize(1);
        assertThat(num(series.get(0), "einspeiseErloesEur")).isCloseTo(0.10, eps);
        assertThat(num(series.get(0), "stromkostenEur")).isCloseTo(0.30, eps);
        assertThat(num(series.get(0), "nettoEur")).isCloseTo(num(body, "nettoErgebnisEur"), eps);

        // The Historie vocabulary includes the WEEK the fleet endpoint refuses.
        assertThat(rest.exchange(url("/api/v1/sites/" + site + "/earnings?range=week"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(rest.exchange(url("/api/v1/sites/" + site + "/earnings?range=quartal"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);

        // A site without a measured slot degrades HONESTLY - nulls + a reason,
        // never a fabricated zero.
        ResponseEntity<Map<String, Object>> empty = rest.exchange(
                url("/api/v1/sites/" + leer + "/earnings?range=month"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(empty.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(empty.getBody()).containsEntry("reason", "no_data")
                .containsEntry("nettoErgebnisEur", null)
                .containsEntry("einspeiseErloesEur", null)
                .containsEntry("stromkostenEur", null)
                .containsEntry("bezugspreisCtKwh", null)
                .containsEntry("savedEur", null)
                .containsEntry("gesamtertragEur", null)
                .containsEntry("expectedMarketValueSolarCtKwh", null);
        assertThat(list(empty.getBody(), "series")).isEmpty();

        // RLS: another tenant does not even see the Anlage.
        assertThat(rest.exchange(url("/api/v1/sites/" + site + "/earnings?range=month"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * B2 fix (audit vp-geldzahlen-audit-x7): an {@code eigenverbrauch} plant
     * with a commissioned pv asset earns its FESTE EEG-Einspeisevergütung on
     * the export side of every money term - Einspeise-Erlös, actual (metered
     * export) AND baseline (residual export) - instead of bare spot, while a
     * plant without a determinable remuneration honestly stays at spot.
     *
     * <p>Hand-computed over two CH slots on 2026-03-03 (a day no other test
     * owns; identical measurements for all three sites, {@code fest} 30 ct
     * import so every number is checkable):
     * <pre>
     *   10:00Z spot 100: pv 2.0 load 0.5 imp 0.0 exp 1.0 chg 0.5
     *   18:00Z spot -50: pv 0.5 load 1.0 imp 0.2 exp 0.5 dis 0.3
     *
     *   s51a (commissioned 2025-06-01, 20 kWp -> blended (10*7.94+10*6.88)/20
     *         = 7.41 ct; §51a zeroes the negative-price slot):
     *     einspeise = 1.0*0.0741 + 0.5*0      = 0.0741
     *     baseline  = -1.5*0.0741 + 0.5*0.30  = 0.03885
     *     actual    = -1.0*0.0741 + 0.06      = -0.0141
     *     saved     = 0.03885 - (-0.0141)     = 0.05295
     *   alt (commissioned 2024-06-01, kWp unknown -> 8.11 ct, rate HOLDS in
     *        the negative slot - pre-§51a plants keep their Vergütung):
     *     einspeise = 1.5*0.0811              = 0.12165
     *     baseline  = -1.5*0.0811 + 0.15      = 0.02835
     *     actual    = -1.5*0.0811 + 0.06      = -0.06165
     *     saved     =                           0.09
     *   bare (no pv asset -> spot, incl. the negative-price "cost"):
     *     einspeise = 1.0*0.10 + 0.5*(-0.05)  = 0.075
     *     baseline  = -1.5*0.10 + 0.15        = 0.0
     *     actual    = -1.0*0.10 + 0.06 + 0.025 = -0.015
     *     saved     =                           0.015
     * </pre>
     *
     * <p>Both documented identities are asserted EXACTLY for the EEG plants
     * (the B2 contract: the fix may not break {@code saved == baseline -
     * actual} or {@code stromkosten - einspeise == actual}), the
     * {@code exportVerguetungPriced} honesty flag flips per site, and the
     * fleet endpoint reports the same valuation.
     */
    @Test
    void eegFixedRemunerationValuesTheExportSideAndKeepsTheIdentitiesExact() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";

        String s51a = createSiteWithTarif(demo, "EEG Verguetung 51a", "CH", "eigenverbrauch",
                "fest", "30");
        String alt = createSiteWithTarif(demo, "EEG Verguetung Alt", "CH", "eigenverbrauch",
                "fest", "30");
        String bare = createSiteWithTarif(demo, "EEG Verguetung Ohne", "CH", "eigenverbrauch",
                "fest", "30");
        exec("INSERT INTO asset (id, tenant_id, site_id, type, commissioned_on, pv_capacity_kwp)"
                + " VALUES (gen_random_uuid(), '" + tenantA + "', '" + s51a
                + "', 'pv', '2025-06-01', 20.0)");
        exec("INSERT INTO asset (id, tenant_id, site_id, type, commissioned_on)"
                + " VALUES (gen_random_uuid(), '" + tenantA + "', '" + alt
                + "', 'pv', '2024-06-01')");

        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "('2026-03-03T10:00:00Z', 'CH', 'PT15M', 100.0, 'EUR', 'test'), "
                + "('2026-03-03T18:00:00Z', 'CH', 'PT15M', -50.0, 'EUR', 'test') "
                + "ON CONFLICT DO NOTHING");
        for (String siteId : new String[] {s51a, alt, bare}) {
            exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, "
                    + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples) VALUES "
                    + "('2026-03-03T10:00:00Z', '" + tenantA + "', '" + siteId
                    + "', 2.0, 0.5, 0.0, 1.0, 0.5, 0.0, 90), "
                    + "('2026-03-03T18:00:00Z', '" + tenantA + "', '" + siteId
                    + "', 0.5, 1.0, 0.2, 0.5, 0.0, 0.3, 90) "
                    + "ON CONFLICT DO NOTHING");
        }

        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-9);
        Map<String, Object> s51aBody = siteEarningsDay(demo, s51a, "2026-03-03");
        assertThat(s51aBody).containsEntry("exportVerguetungPriced", true)
                .containsEntry("tarifPriced", true)
                // Not Direktvermarktung -> no premium claim, and no negative
                // spot "revenue" a fixed remuneration does not have.
                .containsEntry("marktpraemieEur", null);
        assertThat(num(s51aBody, "einspeiseErloesEur")).isCloseTo(0.0741, eps);
        assertThat(num(s51aBody, "eigenverbrauchsWertEur")).isCloseTo(0.39, eps);
        assertThat(num(s51aBody, "stromkostenEur")).isCloseTo(0.06, eps);
        assertThat(num(s51aBody, "nettoErgebnisEur")).isCloseTo(0.4041, eps);
        assertThat(num(s51aBody, "baselineEur")).isCloseTo(0.03885, eps);
        assertThat(num(s51aBody, "actualEur")).isCloseTo(-0.0141, eps);
        assertThat(num(s51aBody, "savedEur")).isCloseTo(0.05295, eps);

        Map<String, Object> altBody = siteEarningsDay(demo, alt, "2026-03-03");
        assertThat(altBody).containsEntry("exportVerguetungPriced", true);
        assertThat(num(altBody, "einspeiseErloesEur")).isCloseTo(0.12165, eps);
        assertThat(num(altBody, "baselineEur")).isCloseTo(0.02835, eps);
        assertThat(num(altBody, "actualEur")).isCloseTo(-0.06165, eps);
        assertThat(num(altBody, "savedEur")).isCloseTo(0.09, eps);
        assertThat(num(altBody, "nettoErgebnisEur")).isCloseTo(0.45165, eps);

        Map<String, Object> bareBody = siteEarningsDay(demo, bare, "2026-03-03");
        assertThat(bareBody).containsEntry("exportVerguetungPriced", false);
        assertThat(num(bareBody, "einspeiseErloesEur")).isCloseTo(0.075, eps);
        assertThat(num(bareBody, "baselineEur")).isCloseTo(0.0, eps);
        assertThat(num(bareBody, "actualEur")).isCloseTo(-0.015, eps);
        assertThat(num(bareBody, "savedEur")).isCloseTo(0.015, eps);

        // The two documented identities hold EXACTLY on the fixed-rate plants
        // (extend-not-weaken: the B2 fix must keep the reconciliation).
        for (Map<String, Object> body : java.util.List.of(s51aBody, altBody, bareBody)) {
            assertThat(num(body, "nettoErgebnisEur")).isCloseTo(
                    num(body, "einspeiseErloesEur") + num(body, "eigenverbrauchsWertEur")
                            - num(body, "stromkostenEur"), eps);
            assertThat(num(body, "stromkostenEur") - num(body, "einspeiseErloesEur"))
                    .isCloseTo(num(body, "actualEur"), eps);
            assertThat(num(body, "baselineEur") - num(body, "actualEur"))
                    .isCloseTo(num(body, "savedEur"), eps);
        }

        // The fleet endpoint values with the SAME composition and carries the
        // same honesty flag (one price truth, two surfaces).
        Map<String, Object> fleet = rest.exchange(
                url("/api/v1/earnings?range=day&at=2026-03-03"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        Map<String, Object> s51aRow = siteRow(fleet, s51a);
        assertThat(s51aRow).containsEntry("exportVerguetungPriced", true);
        assertThat(num(s51aRow, "einspeiseErloesEur")).isCloseTo(0.0741, eps);
        assertThat(num(s51aRow, "savedEur")).isCloseTo(0.05295, eps);
        Map<String, Object> bareRow = siteRow(fleet, bare);
        assertThat(bareRow).containsEntry("exportVerguetungPriced", false);
        assertThat(num(bareRow, "einspeiseErloesEur")).isCloseTo(0.075, eps);
    }

    private Map<String, Object> siteEarningsDay(String token, String siteId, String at) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/earnings?range=day&at=" + at), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /**
     * Das BESTANDSKONTO des gemessenen Tages (Diagnose vp-tagesbild-minus-f3 §6).
     *
     * <p>Der Live-Fall vom 21.08.2026 in Zahlen: Ladestand 24 % → 92 % an einem
     * 65-kWh-Speicher, λ 18,9 ct/kWh ⇒ 44,2 kWh ⇒ ≈ +8,35 €. Ohne diese
     * Gutschrift stand über einem ökonomisch einwandfreien Plan „−4,69 €",
     * weil {@code savedEur} eine reine Zahlungsbilanz ohne Bestandskonto ist.
     *
     * <p>Mitgeprüft: die drei Auswahlregeln für λ (jüngster Slot, jüngster Lauf,
     * kein Lauf von NACH dem bewerteten Moment), der FK2-Rückfall auf den
     * Terminalwert samt NEGATIVEM Vorzeichen (die Bank des Vortags wird
     * verbraucht), der Vorrang des ROHEN Samples am laufenden Tag und die
     * ehrliche Null ohne Speicher.
     */
    @Test
    void siteEarningsCarryTheStorageBankOfTheMeasuredDay() {
        String demo = token("demo", "demo");
        String tenantA = "00000000-0000-0000-0000-000000000001";
        java.time.ZoneId berlin = java.time.ZoneId.of("Europe/Berlin");

        String site = createSiteWithTarif(demo, "Bestandskonto", "CH", "eigenverbrauch",
                "fest", "21");
        String ohneSpeicher = createSite(demo, "Bestandskonto ohne Speicher", "CH",
                "eigenverbrauch");
        saveBattery(demo, site, Map.of("capacityKwh", 65, "maxChargeKw", 30,
                "maxDischargeKw", 30));

        java.time.LocalDate tag = java.time.LocalDate.now(berlin).minusDays(1);
        java.time.LocalDate vortag = tag.minusDays(1);
        String tagStart = ts(tag.atStartOfDay(berlin).toInstant());
        String vorFenster = ts(vortag.atTime(23, 45).atZone(berlin).toInstant());
        String vorVortag = ts(vortag.minusDays(1).atTime(23, 45).atZone(berlin).toInstant());
        String mittag = ts(tag.atTime(12, 0).atZone(berlin).toInstant());
        String spaet = ts(tag.atTime(23, 30).atZone(berlin).toInstant());
        String letzter = ts(tag.atTime(23, 45).atZone(berlin).toInstant());
        String naechsterTag = ts(tag.plusDays(1).atStartOfDay(berlin).toInstant());

        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh,"
                + " currency, source) VALUES "
                + "(" + mittag + ", 'CH', 'PT15M', 100.0, 'EUR', 'test'), "
                + "(" + letzter + ", 'CH', 'PT15M', 200.0, 'EUR', 'test') "
                + "ON CONFLICT DO NOTHING");
        // Die Ladestands-Kette: 50 % vor dem Vortag → 24 % zu Tagesbeginn →
        // 92 % zu Tagesende. Der Eimer VOR dem Fenster ist der Anfangsbestand.
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh,"
                + " grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh,"
                + " soc_last_pct, n_samples) VALUES "
                + "(" + vorVortag + ", '" + tenantA + "', '" + site + "',"
                + " NULL, NULL, NULL, NULL, NULL, NULL, 50.00, 90), "
                + "(" + vorFenster + ", '" + tenantA + "', '" + site + "',"
                + " NULL, NULL, NULL, NULL, NULL, NULL, 24.00, 90), "
                + "(" + mittag + ", '" + tenantA + "', '" + site + "',"
                + " 5.0, 0.5, 0.0, 0.5, 4.0, 0.0, 60.00, 90), "
                + "(" + letzter + ", '" + tenantA + "', '" + site + "',"
                + " 0.0, 1.5, 1.0, 0.0, 0.0, 0.5, 92.00, 90) "
                + "ON CONFLICT DO NOTHING");
        // λ-Auswahl: der jüngste Slot (23:45), darin der jüngste Lauf. Drei
        // Lockvögel: ein älterer SLOT, ein älterer LAUF und ein Slot NACH dem
        // bewerteten Moment.
        String plan = "'11111111-1111-1111-1111-111111111111'";
        exec("INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at,"
                + " battery_kw, stored_value_ct_kwh, terminal_value_eur_per_kwh) VALUES "
                + "(" + spaet + ", '" + tenantA + "', '" + site + "', " + plan + ", "
                + spaet + ", -3.0, 15.0000, 0.150000), "
                + "(" + letzter + ", '" + tenantA + "', '" + site + "', " + plan + ", "
                + spaet + ", -3.0, 5.0000, 0.150000), "
                + "(" + letzter + ", '" + tenantA + "', '" + site + "', " + plan + ", "
                + letzter + ", -3.0, 18.9000, 0.150000), "
                + "(" + naechsterTag + ", '" + tenantA + "', '" + site + "', " + plan + ", "
                + letzter + ", -3.0, 99.0000, 0.990000) "
                + "ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + site + "/earnings?range=day&at=" + tag),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        org.assertj.core.data.Offset<Double> eps = org.assertj.core.data.Offset.offset(1e-6);

        assertThat(num(body, "speicherDeltaKwh")).isCloseTo(44.2, eps);
        assertThat(num(body, "speicherWertCtKwh")).isCloseTo(18.9, eps);
        assertThat(num(body, "speicherWertEur")).isCloseTo(8.3538, org.assertj.core.data.Offset.offset(5e-4));
        assertThat(body).containsEntry("speicherWertBasis", "plan");
        // Der Posten steht NEBEN der Kasse, nie darin - und genau deshalb braucht
        // die Fläche die zweite Zeile: die gemessene Zahlungsbilanz dieses Tages
        // ist NEGATIV (−0,295 €, die Mittagsladung als entgangener Einspeise-
        // Erlös), während 44,2 kWh im Speicher liegen. Erst beide zusammen
        // ergeben die ehrliche Tageszahl.
        assertThat(num(body, "savedEur")).isCloseTo(-0.295, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(num(body, "savedEur") + num(body, "speicherWertEur"))
                .isCloseTo(8.06, org.assertj.core.data.Offset.offset(0.01));

        // FK2-Rückfall + negatives Vorzeichen: der Vortag verbraucht die Bank
        // (50 % → 24 %) und wird mit dem Terminalwert des Laufs bewertet.
        exec("INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at,"
                + " battery_kw, stored_value_ct_kwh, terminal_value_eur_per_kwh) VALUES "
                + "(" + vorFenster + ", '" + tenantA + "', '" + site + "', " + plan + ", "
                + vorFenster + ", -3.0, NULL, 0.155000) ON CONFLICT DO NOTHING");
        Map<String, Object> gestern = rest.exchange(
                url("/api/v1/sites/" + site + "/earnings?range=day&at=" + vortag),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        assertThat(num(gestern, "speicherDeltaKwh")).isCloseTo(-16.9, eps);
        assertThat(num(gestern, "speicherWertCtKwh")).isCloseTo(15.5, eps);
        assertThat(num(gestern, "speicherWertEur")).isCloseTo(-2.6195, org.assertj.core.data.Offset.offset(5e-4));
        assertThat(gestern).containsEntry("speicherWertBasis", "terminal");

        // Am LAUFENDEN Tag gewinnt das rohe Sample über den Rollup-Stand - sonst
        // hinkte die Bestandszeile dem kWh-Satz daneben 15 Minuten hinterher.
        java.time.Instant jetzt = java.time.Instant.now();
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, soc_last_pct,"
                + " n_samples) VALUES (" + ts(jetzt.minusSeconds(1800)) + ", '" + tenantA
                + "', '" + site + "', 20.00, 90) ON CONFLICT DO NOTHING");
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, soc_pct) VALUES ("
                + ts(jetzt.minusSeconds(60)) + ", '" + tenantA + "', '" + site + "',"
                + " '22222222-2222-2222-2222-222222222222', 40.00)");
        exec("INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at,"
                + " battery_kw, stored_value_ct_kwh) VALUES (" + ts(jetzt.minusSeconds(600))
                + ", '" + tenantA + "', '" + site + "', " + plan + ", "
                + ts(jetzt.minusSeconds(600)) + ", -3.0, 20.0000) ON CONFLICT DO NOTHING");
        Map<String, Object> heute = rest.exchange(
                url("/api/v1/sites/" + site + "/earnings?range=day"),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        // 40 % (roh) gegen 92 % zu Mitternacht - NICHT die 20 % des Rollups.
        assertThat(num(heute, "speicherDeltaKwh")).isCloseTo(-33.8, eps);
        assertThat(num(heute, "speicherWertCtKwh")).isCloseTo(20.0, eps);

        // Ohne primären Speicher wird NICHTS behauptet - vier ehrliche Nullen.
        Map<String, Object> ohne = rest.exchange(
                url("/api/v1/sites/" + ohneSpeicher + "/earnings?range=day&at=" + tag),
                HttpMethod.GET, new HttpEntity<>(bearer(demo)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        assertThat(ohne).containsEntry("speicherDeltaKwh", null)
                .containsEntry("speicherWertCtKwh", null)
                .containsEntry("speicherWertEur", null)
                .containsEntry("speicherWertBasis", null);

        // Aufräumen: die Anlage teilt sich den Mandanten mit den handgerechneten
        // Flotten-/Erlös-Tests - ein liegengebliebener Tag verschöbe ihre Zahlen.
        exec("DELETE FROM telemetry_rollup_15m WHERE site_id = '" + site + "'");
        exec("DELETE FROM telemetry WHERE site_id = '" + site + "'");
        exec("DELETE FROM schedule WHERE site_id = '" + site + "'");
    }

    /** Eine Edge-Version aus der mandantenweiten Liste, ohne andere Testgeräte vorauszusetzen. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> edgeVersionFor(List<?> rows, String deviceId) {
        if (rows == null) {
            return null;
        }
        return rows.stream()
                .map(row -> (Map<String, Object>) row)
                .filter(row -> deviceId.equals(row.get("deviceId")))
                .findFirst()
                .orElse(null);
    }

    /** Ein Instant als SQL-Literal (UTC) - die Seed-Schreibweise dieser Suite. */
    private static String ts(java.time.Instant instant) {
        return "timestamptz '" + instant.atZone(java.time.ZoneOffset.UTC)
                .toLocalDateTime().toString().replace('T', ' ') + "+00'";
    }

    private void ingestOcpp(String chargePointId, int sequence, String direction,
            String messageType, String correlationId, String action, String payload) throws Exception {
        ingestOcpp(chargePointId, sequence, direction, messageType, correlationId, action,
                payload, null, null, null);
    }

    private void ingestOcpp(String chargePointId, int sequence, String direction,
            String messageType, String correlationId, String action, String payload,
            String errorCode, String errorDescription, String errorDetails) throws Exception {
        var envelope = objectMapper.createObjectNode();
        envelope.put("schema_version", "1.0");
        envelope.put("event_id", UUID.nameUUIDFromBytes(
                (chargePointId + ":" + sequence).getBytes(StandardCharsets.UTF_8)).toString());
        envelope.put("occurred_at", Instant.parse("2026-08-25T06:30:00Z")
                .plusSeconds(sequence).toString());
        envelope.put("charge_point_id", chargePointId);
        envelope.put("direction", direction);
        envelope.put("message_type", messageType);
        if (correlationId != null) envelope.put("correlation_id", correlationId);
        envelope.put("action", action);
        if (errorCode != null) envelope.put("error_code", errorCode);
        if (errorDescription != null) envelope.put("error_description", errorDescription);
        if (errorDetails != null) envelope.set("error_details", objectMapper.readTree(errorDetails));
        envelope.set("payload", objectMapper.readTree(payload));

        UUID tenant = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UUID site = UUID.fromString(BERLIN_SITE);
        UUID device = UUID.fromString("00000000-0000-0000-0000-000000000003");
        com.voltpilot.api.tenant.TenantContext.set(tenant);
        try {
            assertThat(ocppRepository.ingest(tenant, site, device, envelope)).isTrue();
        } finally {
            com.voltpilot.api.tenant.TenantContext.clear();
        }
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private List<Map<String, Object>> sites(String token) {
        return rest.exchange(url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {}).getBody();
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    /** Direct-access-grant token for a seeded user via the confidential api client. */
    private String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
