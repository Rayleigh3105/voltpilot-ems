package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Instant;
import java.util.List;
import java.nio.charset.StandardCharsets;
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
    TestRestTemplate rest;

    @Autowired
    com.voltpilot.api.repo.DeviceRepository deviceRepo;

    @Autowired
    com.voltpilot.api.repo.ControlStatusRepository controlStatusRepo;

    @Autowired
    com.voltpilot.api.repo.DeviceSourceStatusRepository sourceStatusRepo;

    @Autowired
    com.voltpilot.api.entities.EntityObservedRepository entityObservedRepo;

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

        // Authorization: another tenant cannot purge it (RLS => 404).
        assertThat(rest.exchange(url("/api/v1/devices/" + purged + "/purge-data"), HttpMethod.POST,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE device_id = '" + purged + "'"))
                .isEqualTo(2);

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
                + "curtail_kw, peak_target_kw) "
                + "VALUES "
                + "(now(), '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "'00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', "
                + "now(), 5.0, 8.0, 62.5, 3.0, 2.0, 80.0, 0.02, 0.10, 0.0, 180.0), "
                + "(now() + interval '15 minutes', '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "'00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', "
                + "now(), -5.0, -2.0, 50.0, 3.0, 0.0, 200.0, 0.03, 0.05, 1.5, 180.0) "
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
        exec("UPDATE schedule SET terminal_value_eur_per_kwh = 0.18, "
                + "slot_role = 'guenstig_laden', slot_flags = 'charge_cap,peak_defining', "
                + "stored_value_ct_kwh = 24.2, grid_value_ct_kwh = 10.1, "
                + "peak_pressure_eur_kw = 1.25, fallback_14a = FALSE "
                + "WHERE plan_id = 'aaaaaaaa-0000-0000-0000-000000000002'");
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
        String deviceId = claimDeviceInto(demo, siteId, "edge-stumm-01");

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
                "tcp://localhost:1883", "", "", deviceRepo, entityObservedRepo);
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
                "tcp://localhost:1883", "", "", deviceRepo, entityObservedRepo);
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

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/earnings?range=month"), HttpMethod.GET,
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

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/earnings?range=month"), HttpMethod.GET,
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
                "tcp://localhost:1883", "", "", deviceRepo, controlStatusRepo);
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
