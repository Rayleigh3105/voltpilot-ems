package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** AP-03 IP-13: Kundenrouten unter echter RLS, eigene Rolle und letzter Administrator. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BenutzerVerwaltungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final UUID DEMO = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

    private static final String JONAS = "sub-entzug-jonas";
    private static final String INES = "sub-entzug-ines";
    private static final String SABINE = "sub-entzug-sabine";
    private static final String MURAT = "sub-entzug-murat";
    private static final String CLAUDIA = "sub-entzug-claudia";
    private static final String BESTAND = "sub-entzug-bestandskonto";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot/protocol/openid-connect/certs");
    }

    @Autowired
    MockMvc mvc;

    private static JdbcTemplate root;
    private static UUID standortA;
    private static UUID standortB;
    private static UUID siteB;

    private record Antwort(int status, String body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void seedEinmal() {
        if (standortA == null) {
            seed();
        }
    }

    @Test void listeLesendUndMandantenzaun() throws Exception {
        assertThat(ruf(get("/api/v1/benutzer"), konto(JONAS, DEMO)).status()).isEqualTo(200);
        Antwort liste = ruf(get("/api/v1/benutzer"), konto(INES, DEMO));
        assertThat(liste.status()).isEqualTo(200);
        assertThat(liste.body()).contains(JONAS, "energiemanager").doesNotContain("startpasswort");
        assertThat(ruf(get("/api/v1/benutzer"), konto(CLAUDIA, DEMO)).status()).isEqualTo(403);
        assertThat(ruf(post("/api/v1/benutzer/" + CLAUDIA + "/sperren", "{}"), konto(INES, DEMO)).status()).isEqualTo(403);
        assertThat(ruf(post("/api/v1/benutzer/fremdes-konto/sperren", "{}"), konto(JONAS, DEMO)).status()).isEqualTo(404);
        assertThat(ruf(MockMvcRequestBuilders.delete(uri("/api/v1/benutzer/fremdes-konto")), konto(JONAS, DEMO)).status()).isEqualTo(404);
        Antwort fremd = ruf(get("/api/v1/benutzer"), konto("anderer-admin", UUID.fromString("00000000-0000-0000-0000-000000000003")));
        assertThat(fremd.body()).doesNotContain(JONAS, CLAUDIA);
    }

    @Test void sperrenEntfernenUndAltesTokenSofortGesperrt() throws Exception {
        String sub = "konto-zu-sperren"; spiegel(sub); amStandort(sub, "leser", standortA);
        var alt = konto(sub, DEMO);
        assertThat(ruf(get("/api/v1/sites"), alt).status()).isEqualTo(200);
        assertThat(ruf(post("/api/v1/benutzer/" + sub + "/sperren", "{}"), konto(JONAS, DEMO)).status()).isEqualTo(204);
        Antwort danach = ruf(get("/api/v1/sites"), alt);
        assertThat(danach.status()).isEqualTo(404); assertThat(danach.body()).contains("zugriff_beendet");
        assertThat(zuweisungen(sub)).hasSize(1); // Sperren hält an; Entfernen beendet die Zuweisung.
        assertThat(root.queryForObject("SELECT zustand FROM benutzer WHERE tenant_id = ? AND sub = ?", String.class, DEMO, sub)).isEqualTo("gesperrt");
        assertThat(ruf(MockMvcRequestBuilders.delete(uri("/api/v1/benutzer/" + sub)), konto(JONAS, DEMO)).status()).isEqualTo(204);
        assertThat(zuweisungen(sub)).isEmpty();
        assertThat(ruf(get("/api/v1/benutzer"), konto(JONAS, DEMO)).body()).doesNotContain(sub);
        String p = "/api/v1/benutzer/protokoll?von=" + Instant.now().minusSeconds(3600) + "&bis=" + Instant.now().plusSeconds(3600);
        Antwort protokoll = ruf(get(p), konto(JONAS, DEMO));
        assertThat(protokoll.status()).isEqualTo(200); assertThat(protokoll.body()).contains("sperren", "entfernen", sub);
        assertThat(ruf(get(p), konto(INES, DEMO)).status()).isEqualTo(403);
    }

    @Test void a8AuchKontoSperrenUndEntfernenSchuetzenEigeneRechteUndLetztenAdmin() throws Exception {
        for (var anfrage : List.of(post("/api/v1/benutzer/" + JONAS + "/sperren", "{}"), MockMvcRequestBuilders.delete(uri("/api/v1/benutzer/" + JONAS)))) {
            Antwort a = ruf(anfrage, konto(JONAS, DEMO));
            assertThat(a.status()).isEqualTo(409); assertThat(a.body()).contains("eigene_zuweisung");
        }
        // Noch nicht übernommener Bestandsadministrator: der bekannte letzte Administrator bleibt geschützt.
        Antwort a = ruf(post("/api/v1/benutzer/" + JONAS + "/sperren", "{}"), konto(BESTAND, DEMO));
        assertThat(a.status()).isEqualTo(409); assertThat(a.body()).contains("letzter_kundenadministrator");
    }

    @Test void rollenwechselAtomarPflichtstandortUndFremdeZuweisung404() throws Exception {
        String sub = "konto-wechsel"; spiegel(sub); amStandort(sub, "leser", standortA);
        UUID bisher = zuweisungen(sub).get(0);
        var auth = konto(JONAS, DEMO);
        String pfad = "/api/v1/benutzer/" + sub + "/zugriff";
        Antwort fehlt = ruf(MockMvcRequestBuilders.put(uri(pfad)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(Map.of("bisher", List.of(bisher), "rolle", "bearbeiter", "standorte", List.of()))), auth);
        assertThat(fehlt.status()).isEqualTo(422);
        assertThat(zuweisungen(sub)).containsExactly(bisher);
        Antwort fremd = ruf(MockMvcRequestBuilders.put(uri("/api/v1/benutzer/fremd/zugriff")).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(Map.of("bisher", List.of(bisher), "rolle", "bearbeiter", "standorte", List.of(standortA)))), auth);
        assertThat(fremd.status()).isEqualTo(404);
        Antwort ok = ruf(MockMvcRequestBuilders.put(uri(pfad)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(Map.of("bisher", List.of(bisher), "rolle", "bearbeiter", "standorte", List.of(standortA, standortB)))), auth);
        assertThat(ok.status()).isEqualTo(204);
        assertThat(zuweisungen(sub)).hasSize(2).doesNotContain(bisher);
        Antwort doppelt = ruf(MockMvcRequestBuilders.put(uri(pfad)).contentType(MediaType.APPLICATION_JSON)
                .content(MAPPER.writeValueAsString(Map.of("bisher", List.of(), "rolle", "bearbeiter", "standorte", List.of(standortA)))), auth);
        assertThat(doppelt.status()).isEqualTo(409); assertThat(doppelt.body()).contains("zuweisung_vorhanden");
        assertThat(zuweisungen(sub)).hasSize(2);
    }

    @Test void parallelesSperrenLaesstImmerEinenAdministratorUebrig() throws Exception {
        UUID tenant = UUID.randomUUID();
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Ahrenberg Paralleltest')", tenant);
        for (String sub : List.of("admin-a", "admin-b")) {
            root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, 'aktiv')", tenant, sub, sub);
            root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) VALUES (?, ?, 'kundenadministrator', '2024-01-01T00:00:00Z', 'Europe/Berlin')", tenant, sub);
        }
        try (var pool = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var start = new java.util.concurrent.CountDownLatch(1);
            var a = pool.submit(() -> { start.await(); return ruf(post("/api/v1/benutzer/admin-a/sperren", "{}"), konto("bestand", tenant)).status(); });
            var b = pool.submit(() -> { start.await(); return ruf(post("/api/v1/benutzer/admin-b/sperren", "{}"), konto("bestand", tenant)).status(); });
            start.countDown();
            assertThat(List.of(a.get(), b.get())).containsExactlyInAnyOrder(204, 409);
        }
        assertThat(root.queryForObject("SELECT count(*) FROM zugriff z JOIN benutzer b ON b.tenant_id = z.tenant_id AND b.sub = z.benutzer_sub "
                + "WHERE z.tenant_id = ? AND z.beendet_am IS NULL AND b.zustand = 'aktiv'", Integer.class, tenant)).isEqualTo(1);
    }

    private static List<UUID> zuweisungen(String sub) {
        return root.queryForList("SELECT id FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ? "
                + "AND beendet_am IS NULL ORDER BY rolle", UUID.class, DEMO, sub);
    }

    private static UUID zuweisung(String sub, String rolle) {
        return root.queryForObject("SELECT id FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ? AND rolle = ? "
                + "AND beendet_am IS NULL", UUID.class, DEMO, sub, rolle);
    }

    private Antwort ruf(MockHttpServletRequestBuilder anfrage, Authentication auth) throws Exception {
        MvcResult r = mvc.perform(anfrage.with(authentication(auth))).andReturn();
        return new Antwort(r.getResponse().getStatus(), r.getResponse().getContentAsString());
    }

    private static MockHttpServletRequestBuilder get(String pfad) {
        return MockMvcRequestBuilders.get(uri(pfad));
    }

    private static MockHttpServletRequestBuilder post(String pfad, String body) {
        return MockMvcRequestBuilders.post(uri(pfad)).contentType(MediaType.APPLICATION_JSON).content(body);
    }

    private static java.net.URI uri(String pfad) {
        return java.net.URI.create(pfad);
    }

    private static Authentication konto(String sub, UUID tenant) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", sub);
        claims.put("preferred_username", sub);
        claims.put("realm_access", Map.of("roles", List.of()));
        if (tenant != null) {
            claims.put("tenant_id", tenant.toString());
        }
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    /**
     * Zwei Standorte im Demo-Kundenbereich: die Berliner Anlage an „Werk Ahrenberg" (Jonas, Murat, Claudia),
     * eine zweite Anlage an „Werk Ahrenberg Nord" (Sabine). Der Bestandskonto-Login bekommt KEINE Zuweisung
     * (Bestandsregel E12) — und der Kundenbereich keinen Stichtag, damit sie gilt.
     */
    private static void seed() {
        UUID unternehmen = root.queryForList("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, DEMO)
                .stream().findFirst().orElseGet(() -> root.queryForObject("INSERT INTO unternehmen (tenant_id, name) "
                        + "VALUES (?, 'Kunststoffwerk Ahrenberg GmbH') RETURNING id", UUID.class, DEMO));
        standortA = standort(unternehmen, "Werk Ahrenberg", "ST-A1");
        standortB = standort(unternehmen, "Werk Ahrenberg Nord", "ST-A3");
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?::uuid, ?, '2024-01-01')", DEMO, BERLIN_SITE, standortA);
        siteB = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) "
                + "VALUES (?, 'Halle Nord', 'DE-LU') RETURNING id", UUID.class, DEMO);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2024-01-01')", DEMO, siteB, standortB);

        spiegel(JONAS);
        unternehmensweit(JONAS, "kundenadministrator");
        spiegel(INES);
        unternehmensweit(INES, "energiemanager");
        spiegel(SABINE);
        amStandort(SABINE, "bearbeiter", standortB);
        amStandort(SABINE, "bedienberechtigt", standortB);
        spiegel(MURAT);
        amStandort(MURAT, "bedienberechtigt", standortA);
        amStandort(MURAT, "leser", standortA);
        spiegel(CLAUDIA);
        amStandort(CLAUDIA, "leser", standortA);
        spiegel(BESTAND);
    }

    private static UUID standort(UUID unternehmen, String name, String kurzzeichen) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                DEMO, unternehmen, name, kurzzeichen);
    }

    private static void spiegel(String sub) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                + "VALUES (?, ?, 'benutzer', ?, 'aktiv')", DEMO, sub, sub);
    }

    private static void unternehmensweit(String sub, String rolle) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", DEMO, sub, rolle);
    }

    private static void amStandort(String sub, String rolle, UUID standort) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, '2024-01-01T00:00:00Z', 'Europe/Berlin')", DEMO, sub, rolle, standort);
    }
}
