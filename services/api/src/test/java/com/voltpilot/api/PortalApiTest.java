package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
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
        exec("INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id, generated_at, "
                + "battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, baseline_cost_eur, curtail_kw) "
                + "VALUES "
                + "(now(), '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "'00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', "
                + "now(), 5.0, 8.0, 62.5, 3.0, 0.0, 80.0, 0.02, 0.10, 0.0), "
                + "(now() + interval '15 minutes', '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "'00000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', "
                + "now(), -5.0, -2.0, 50.0, 3.0, 0.0, 200.0, 0.03, 0.05, 1.5) "
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
        assertThat(((Number) first.get("curtailKw")).doubleValue()).isEqualTo(0.0);
        // The curtailing slot carries its held-back PV so the portal can quantify
        // the avoided negative-price loss.
        @SuppressWarnings("unchecked")
        Map<String, Object> second = (Map<String, Object>) slots.get(1);
        assertThat(((Number) second.get("curtailKw")).doubleValue()).isEqualTo(1.5);

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
    void measurementPointDbConstraintsEnforceReadOnlyControlSafety() {
        String tenant = "00000000-0000-0000-0000-000000000001";
        String site = "ccccccc1-0000-0000-0000-000000000001";
        exec("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES "
                + "('" + site + "', '" + tenant + "', 'Control Safety Site', 'DE-LU')");

        // control=true is forbidden for a non-battery-hybrid role (the CHECK).
        assertThatThrownBy(() -> exec("INSERT INTO measurement_point "
                + "(tenant_id, site_id, role, control) VALUES "
                + "('" + tenant + "', '" + site + "', 'pv-generation', TRUE)"))
                .isInstanceOf(IllegalStateException.class);

        // At most ONE control=true point per site (the partial unique index): the
        // first battery-hybrid control point is allowed, a second is rejected.
        exec("INSERT INTO measurement_point (tenant_id, site_id, role, control) VALUES "
                + "('" + tenant + "', '" + site + "', 'battery-hybrid', TRUE)");
        assertThatThrownBy(() -> exec("INSERT INTO measurement_point "
                + "(tenant_id, site_id, role, control) VALUES "
                + "('" + tenant + "', '" + site + "', 'battery-hybrid', TRUE)"))
                .isInstanceOf(IllegalStateException.class);
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

    /** The site's battery-asset device_id via GET /assets (null when unlinked). */
    private String batteryDeviceId(String token, String siteId) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/assets"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody().stream()
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
