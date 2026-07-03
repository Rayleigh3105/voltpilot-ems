package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
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
    TestRestTemplate rest;

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

    // ---- tenant isolation through the API -----------------------------------

    @Test
    void eachTenantSeesOnlyItsOwnSites() {
        List<Map<String, Object>> tenantA = sites(token("demo", "demo"));
        assertThat(tenantA).extracting(s -> s.get("name")).containsExactly("Demo Site Berlin");

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
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        // ...the site is gone from the listing and every series row with it.
        assertThat(sites(demo)).extracting(s -> s.get("name")).doesNotContain("Werk Wegwerf");
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE site_id = '" + siteId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM forecast WHERE site_id = '" + siteId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM weather_forecast WHERE site_id = '" + siteId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + siteId + "'")).isZero();
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

        // Edit: kind + label. The externalRef is identity and stays untouched.
        ResponseEntity<Map<String, Object>> updated = rest.exchange(
                url("/api/v1/devices/" + deviceId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("kind", "battery", "name", "Speicher Keller"), bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(updated.getBody()).containsEntry("kind", "battery");
        assertThat(updated.getBody()).containsEntry("name", "Speicher Keller");
        assertThat(updated.getBody()).containsEntry("externalRef", "edge-unclaim-01");

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
        exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                + "battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, baseline_cost_eur) "
                + "VALUES "
                + "(now(), '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "'00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', "
                + "now(), 5.0, 8.0, 62.5, 3.0, 0.0, 80.0, 0.02, 0.10), "
                + "(now() + interval '15 minutes', '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "'00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', "
                + "now(), -5.0, -2.0, 50.0, 3.0, 0.0, 200.0, 0.03, 0.05) "
                + "ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/schedule"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).containsEntry("planId", "aaaaaaaa-0000-0000-0000-000000000002");
        assertThat(res.getBody()).containsEntry("slotMinutes", 15);
        List<?> slots = (List<?>) res.getBody().get("slots");
        assertThat(slots).hasSize(2); // the latest run only, not the older one
        // Headline savings = sum(baseline - cost) = (0.10-0.02) + (0.05-0.03).
        assertThat(((Number) res.getBody().get("savingsEur")).doubleValue())
                .isCloseTo(0.10, org.assertj.core.data.Offset.offset(1e-9));
        @SuppressWarnings("unchecked")
        Map<String, Object> first = (Map<String, Object>) slots.get(0);
        assertThat(((Number) first.get("batteryKw")).doubleValue()).isEqualTo(5.0);
        assertThat(((Number) first.get("socPct")).doubleValue()).isEqualTo(62.5);

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
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, load_kw) "
                + "VALUES " + rows);
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) VALUES "
                + "('2026-06-15T10:00:00Z', 'DE-LU', 'PT15M', 100.0, 'EUR', 'energy-charts'), "
                + "('2026-06-15T11:00:00Z', 'DE-LU', 'PT15M', 200.0, 'EUR', 'energy-charts') "
                + "ON CONFLICT DO NOTHING");
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

    /** Run a statement as the Postgres superuser (bypasses RLS) to seed feed rows. */
    private static void exec(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
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
