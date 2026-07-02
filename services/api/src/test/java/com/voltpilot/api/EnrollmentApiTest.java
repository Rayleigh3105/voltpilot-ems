package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.enrollment.TestPki;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.cert.X509Certificate;
import java.util.Map;
import java.util.UUID;
import javax.security.auth.x500.X500Principal;
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
 * End-to-end proof of first-boot device enrollment over HTTPS against a REAL
 * Keycloak + TimescaleDB - the "kinderleicht" mTLS onboarding journey:
 *
 * <ol>
 *   <li><b>The full journey.</b> A fresh device (knowing only its sticker ref
 *       and the portal URL) uploads its CSR; the poll stays pending; the
 *       customer claims the ref in the portal; the next poll returns a CA-signed
 *       client certificate whose identity is ENFORCED from the claim
 *       (CN=device_id, O=tenant, OU=site, SPIFFE SAN) - the hostile subject the
 *       CSR requested is ignored - plus the broker params; the ACL grant is
 *       written exactly like tools/pki/voltpilot-ca.sh does; the certificate
 *       stays retrievable for retries; unclaiming removes the grant and the
 *       poll goes back to pending.</li>
 *   <li><b>Gates and guards.</b> Unknown sticker refs are refused (422, like
 *       the claim endpoint); pending and unknown refs answer identically (no
 *       enumeration); garbage/weak-key CSRs are refused; re-POSTing replaces a
 *       not-yet-issued CSR; the rate limiter trips per client address.</li>
 * </ol>
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class EnrollmentApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Dev seed (V100): tenant A and its Berlin site, what the demo user sees. */
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

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

    static final Path PKI_DIR = createPkiDir();
    static final Path ACL_FILE = PKI_DIR.resolve("acl.conf");

    private static Path createPkiDir() {
        try {
            Path dir = Files.createTempDirectory("voltpilot-enrollment-test");
            TestPki.writeCa(dir.resolve("ca"));
            Files.writeString(ACL_FILE_IN(dir), """
                    {allow, {username, "vp-internal"}, all, ["#"]}.
                    %%<<BEGIN GENERATED DEVICE GRANTS>>
                    %%<<END GENERATED DEVICE GRANTS>>
                    {allow, all}.
                    """, StandardCharsets.UTF_8);
            return dir;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Path ACL_FILE_IN(Path dir) {
        return dir.resolve("acl.conf");
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");

        // Enrollment against the throwaway CA + ACL file.
        registry.add("voltpilot.enrollment.enabled", () -> "true");
        registry.add("voltpilot.enrollment.ca-dir", () -> PKI_DIR.resolve("ca").toString());
        registry.add("voltpilot.enrollment.acl-file", () -> ACL_FILE.toString());
        registry.add("voltpilot.enrollment.mqtt-host", () -> "mqtt.example.com");
        registry.add("voltpilot.enrollment.mqtt-port", () -> "8883");
        // Rate-limit budget: the rate-limit test hammers from a synthetic
        // X-Forwarded-For address (trusted-proxies=1 makes the limiter honor
        // it); every OTHER test here calls from plain 127.0.0.1 and must stay
        // within this cap in total - keep headroom in mind when adding tests.
        registry.add("voltpilot.enrollment.rate-limit.per-client-max", () -> "40");
        registry.add("voltpilot.enrollment.rate-limit.trusted-proxies", () -> "1");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    // ---- (1) the full first-boot journey --------------------------------------

    @Test
    void firstBootEnrollmentIssuesTheCertificateOnceTheRefIsClaimed() throws Exception {
        // The device's sticker ID was registered at manufacture.
        provisionSticker("VP-ENROLL-0001");

        // The device generated its own key and a CSR with a HOSTILE subject -
        // proof below that the claim, not the CSR, decides the identity. It
        // enrolls under the lowercased ref (canonicalized like the claim).
        KeyPair deviceKey = TestPki.rsaKeyPair(2048);
        String csr = TestPki.csrPem(deviceKey, "CN=attacker,O=evil-corp,OU=takeover");
        ResponseEntity<Map<String, Object>> posted = postCsr("vp-enroll-0001", csr, "SimBox v2");
        assertThat(posted.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(posted.getBody()).containsEntry("status", "pending")
                .containsEntry("ref", "VP-ENROLL-0001");

        // Unclaimed: the poll stays pending.
        ResponseEntity<Map<String, Object>> pending = getCertificate("VP-ENROLL-0001");
        assertThat(pending.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(pending.getBody()).containsEntry("status", "pending");

        // The customer claims the ref in the portal (tenant A, Berlin site).
        ResponseEntity<Map<String, Object>> claimed = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "VP-ENROLL-0001"),
                        bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(claimed.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String deviceId = (String) claimed.getBody().get("id");

        // The next poll returns the certificate + broker params.
        ResponseEntity<Map<String, Object>> issued = getCertificate("VP-ENROLL-0001");
        assertThat(issued.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(issued.getBody())
                .containsEntry("mqttHost", "mqtt.example.com")
                .containsEntry("mqttPort", 8883)
                .containsEntry("tenantId", TENANT_A)
                .containsEntry("siteId", BERLIN_SITE)
                .containsEntry("deviceId", deviceId);

        // The certificate carries the CLAIM-derived identity - the CSR's
        // hostile subject is gone - certifies the device's own key, and chains
        // to the CA the response ships for broker verification.
        X509Certificate cert = TestPki.parseCertificate(
                (String) issued.getBody().get("deviceCertPem"));
        String subject = cert.getSubjectX500Principal().getName(X500Principal.RFC2253);
        assertThat(subject).contains("CN=" + deviceId)
                .contains("O=" + TENANT_A).contains("OU=" + BERLIN_SITE)
                .doesNotContain("attacker").doesNotContain("evil-corp");
        assertThat(cert.getPublicKey()).isEqualTo(deviceKey.getPublic());
        X509Certificate caCert = TestPki.parseCertificate((String) issued.getBody().get("caPem"));
        cert.verify(caCert.getPublicKey());
        assertThat(cert.getExtendedKeyUsage()).containsExactly("1.3.6.1.5.5.7.3.2"); // clientAuth
        assertThat(cert.getSubjectAlternativeNames()).anySatisfy(san ->
                assertThat(san.get(1)).isEqualTo("spiffe://voltpilot/ems/" + TENANT_A + "/"
                        + BERLIN_SITE + "/" + deviceId));

        // The broker ACL grant was written the way voltpilot-ca.sh writes it...
        String acl = Files.readString(ACL_FILE);
        assertThat(acl).contains("%%<<device " + deviceId + " tenant " + TENANT_A
                        + " site " + BERLIN_SITE + ">>")
                .contains("ems/" + TENANT_A + "/" + BERLIN_SITE + "/" + deviceId + "/telemetry");
        // ...and the issuance landed in the openssl CA database (revocable).
        assertThat(Files.readString(PKI_DIR.resolve("ca/index.txt"))).contains("/CN=" + deviceId);

        // Retries re-fetch the SAME certificate (the private key never traveled).
        ResponseEntity<Map<String, Object>> again = getCertificate("VP-ENROLL-0001");
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(again.getBody().get("deviceCertPem"))
                .isEqualTo(issued.getBody().get("deviceCertPem"));

        // Unclaiming drops the ACL grant and the poll goes back to pending -
        // the stale certificate is never handed out again.
        assertThat(rest.exchange(url("/api/v1/devices/" + deviceId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(token("demo", "demo"))), Void.class)
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(Files.readString(ACL_FILE)).doesNotContain(deviceId);
        assertThat(getCertificate("VP-ENROLL-0001").getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---- (2) registry gate, no enumeration, CSR policy, replace, rate limit ---

    @Test
    void unknownStickerRefIsRefusedLikeTheClaimEndpoint() throws Exception {
        String csr = TestPki.csrPem(TestPki.rsaKeyPair(2048), "CN=dev");
        assertThat(postCsr("VP-TYPO-9999", csr, null).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
    }

    @Test
    void pendingAndUnknownRefsAnswerIdentically() throws Exception {
        // A free-form (ungated) ref with a stored CSR, still unclaimed...
        String csr = TestPki.csrPem(TestPki.rsaKeyPair(2048), "CN=dev");
        assertThat(postCsr("enroll-pending-ref", csr, null).getStatusCode())
                .isEqualTo(HttpStatus.ACCEPTED);
        ResponseEntity<Map<String, Object>> pendingKnown = getCertificate("enroll-pending-ref");
        // ...and a ref nobody ever enrolled: byte-identical answers, so polling
        // cannot probe which refs exist.
        ResponseEntity<Map<String, Object>> unknown = getCertificate("enroll-never-seen");
        assertThat(pendingKnown.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(unknown.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(unknown.getBody()).isEqualTo(pendingKnown.getBody());
    }

    @Test
    void garbageAndWeakKeyCsrsAreRefused() throws Exception {
        assertThat(postCsr("enroll-bad-csr", "not a csr", null).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        String weak = TestPki.csrPem(TestPki.rsaKeyPair(1024), "CN=dev");
        assertThat(postCsr("enroll-weak-key", weak, null).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        // Neither refusal stored anything.
        assertThat(getCertificate("enroll-bad-csr").getBody())
                .isEqualTo(getCertificate("enroll-never-seen-2").getBody());
    }

    @Test
    void rePostingReplacesThePendingCsrUntilIssued() throws Exception {
        provisionSticker("VP-ENROLL-0002");
        // First key is lost (device re-flashed before onboarding finished)...
        String first = TestPki.csrPem(TestPki.rsaKeyPair(2048), "CN=dev");
        assertThat(postCsr("VP-ENROLL-0002", first, null).getStatusCode())
                .isEqualTo(HttpStatus.ACCEPTED);
        // ...the device enrolls again with a fresh key - idempotent replace.
        KeyPair secondKey = TestPki.rsaKeyPair(2048);
        assertThat(postCsr("VP-ENROLL-0002", TestPki.csrPem(secondKey, "CN=dev"), null)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        // Claim -> the certificate certifies the SECOND key.
        ResponseEntity<Map<String, Object>> claimed = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "VP-ENROLL-0002"),
                        bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(claimed.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        ResponseEntity<Map<String, Object>> issued = getCertificate("VP-ENROLL-0002");
        assertThat(issued.getStatusCode()).isEqualTo(HttpStatus.OK);
        X509Certificate cert = TestPki.parseCertificate(
                (String) issued.getBody().get("deviceCertPem"));
        assertThat(cert.getPublicKey()).isEqualTo(secondKey.getPublic());

        // Once issued, a re-POST is refused - the enrolled key is fixed
        // (re-keying goes through revoke + unclaim/re-claim).
        assertThat(postCsr("VP-ENROLL-0002", TestPki.csrPem(TestPki.rsaKeyPair(2048), "CN=dev"),
                null).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    @Test
    void pollingIsRateLimitedPerClientAddress() {
        // A hammering client (synthetic address via the trusted-proxy header)
        // burns through its budget...
        HttpStatus last = null;
        for (int i = 0; i < 41; i++) {
            last = (HttpStatus) getCertificate("enroll-rate-probe", "198.51.100.66").getStatusCode();
        }
        assertThat(last).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        // ...while a neighbour polls unaffected.
        assertThat(getCertificate("enroll-rate-probe", "198.51.100.77").getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---- helpers ---------------------------------------------------------------

    private void provisionSticker(String ref) {
        ResponseEntity<Map<String, Object>> provisioned = rest.exchange(
                url("/api/v1/admin/provisioned-devices"), HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", ref), bearer(token("admin", "admin"))),
                new ParameterizedTypeReference<>() {});
        assertThat(provisioned.getStatusCode().is2xxSuccessful()).isTrue();
    }

    private ResponseEntity<Map<String, Object>> postCsr(String ref, String csrPem, String info) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        Map<String, Object> body = info == null
                ? Map.of("csrPem", csrPem) : Map.of("csrPem", csrPem, "deviceInfo", info);
        return rest.exchange(url("/api/v1/enrollment/" + ref + "/csr"), HttpMethod.POST,
                new HttpEntity<>(body, headers), new ParameterizedTypeReference<>() {});
    }

    private ResponseEntity<Map<String, Object>> getCertificate(String ref) {
        return rest.exchange(url("/api/v1/enrollment/" + ref + "/certificate"), HttpMethod.GET,
                HttpEntity.EMPTY, new ParameterizedTypeReference<>() {});
    }

    /** Poll arriving via the trusted proxy for the given client address. */
    private ResponseEntity<Map<String, Object>> getCertificate(String ref, String clientIp) {
        HttpHeaders headers = new HttpHeaders();
        headers.add("X-Forwarded-For", clientIp);
        return rest.exchange(url("/api/v1/enrollment/" + ref + "/certificate"), HttpMethod.GET,
                new HttpEntity<>(headers), new ParameterizedTypeReference<>() {});
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    /** Direct-access-grant token via the confidential api client. */
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
        assertThat(body).as("token response for " + username).containsKey("access_token");
        return (String) body.get("access_token");
    }
}
