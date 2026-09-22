package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** AP-16 R5/P1/P2: Messbedarf von MB-1 über MS-23 bis Register und Messabdeckungs-Naht. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MessbedarfApiTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ENERGIE = "/api/v1/unternehmen/energieeinsaetze";
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");
    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip19_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip19_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    @Autowired BewertungMessbedarfNaht naht;
    static JdbcTemplate root;
    UUID tenant, unternehmen, standort, fremderStandort, prozess, ms23, entwurf, einsatz;

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @BeforeEach void welt() throws Exception {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-19') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Kunststoffwerk Ahrenberg') RETURNING id",
                UUID.class, tenant);
        standort = standort("ST-1");
        fremderStandort = standort("ST-2");
        benutzer("IK", "Ines Kaltenbach", "energiemanager", null);
        benutzer("PH", "Peter Hollerbach", "bearbeiter", fremderStandort);
        prozess = root.queryForObject("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) "
                + "VALUES (?,?,'P-8','Druckluft','2024-01-01') RETURNING id", UUID.class, tenant, unternehmen);
        ms23 = messstelle("MS-23", "Druckluftzähler", standort, true);
        entwurf = messstelle("MS-99", "Noch nicht eingerichtet", null, false);
        root.update("INSERT INTO messstelle_prozess(tenant_id,messstelle_id,prozess_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, ms23, prozess);
        root.update("INSERT INTO energieeinsatz_kennzeichen_seq(tenant_id,zaehler) VALUES (?,7)", tenant);
        JsonNode e = ruf("POST", ENERGIE, "IK", Map.of("prozess_id", prozess.toString(), "traeger", "Strom",
                "name", "Drucklufterzeugung", "gueltig_ab", "2026-01-01"), 201);
        assertThat(e.path("kennzeichen").asText()).isEqualTo("EE-8");
        einsatz = UUID.fromString(e.path("id").asText());
    }

    @Test void r5ErfassenEinloesenRegisterEreignisseUndZaun() throws Exception {
        String basis = ENERGIE + "/" + einsatz + "/messbedarf";
        JsonNode b = ruf("POST", basis, "IK", Map.of("wortlaut", "Druckluftverbrauch der Blasmaschinen",
                "ort", "Halle 2", "groesse", "Wirkenergie", "frist", "2026-10-31"), 201);
        assertThat(b.path("kennzeichen").asText()).isEqualTo("MB-1");
        UUID bedarf = UUID.fromString(b.path("id").asText());
        assertThat(offene()).singleElement().satisfies(p -> {
            assertThat(p.einsatzId()).isEqualTo(einsatz);
            assertThat(p.kennzeichen()).isEqualTo("MB-1");
        });

        ablehnung("POST", basis + "/" + bedarf + "/einloesen", Map.of("messstelle_id", entwurf),
                422, "messstelle_nicht_eingerichtet");
        UUID fremd = fremdeMessstelle();
        ablehnung("POST", basis + "/" + bedarf + "/einloesen", Map.of("messstelle_id", fremd),
                404, "nicht_gefunden");
        JsonNode erledigt = ruf("POST", basis + "/" + bedarf + "/einloesen", "IK",
                Map.of("messstelle_id", ms23), 200);
        assertThat(erledigt.path("zustand").asText()).isEqualTo("eingeloest");
        assertThat(erledigt.at("/messstelle/kennzeichen").asText()).isEqualTo("MS-23");
        assertThat(offene()).isEmpty();

        JsonNode register = ruf("GET", "/api/v1/messstellen?geplantFuerEinsatz=true", "IK", null, 200);
        assertThat(register.path("register")).hasSize(1);
        JsonNode zeile = register.path("register").get(0);
        assertThat(zeile.path("kennzeichen").asText()).isEqualTo("MS-23");
        assertThat(zeile.at("/geplant_fuer_einsaetze/0/kennzeichen").asText()).isEqualTo("EE-8");
        assertThat(zeile.at("/quelle/stand").asText()).isEqualTo("keine_datenquelle");
        assertThat(zeile.path("letzter_wert").isNull()).isTrue();

        assertThat(ruf("GET", basis, "PH", null, 404).path("code").asText()).isEqualTo("nicht_gefunden");
        ruf("POST", basis, "PH", Map.of("wortlaut", "außerhalb"), 403);
        assertThat(root.queryForList("SELECT art FROM messreihe_ereignis WHERE tenant_id=? ORDER BY zeit", String.class, tenant))
                .containsExactlyInAnyOrder("messbedarf_erfasst", "messbedarf_eingeloest");
        JsonNode protokoll = ruf("GET", basis + "/" + bedarf + "/protokoll", "IK", null, 200);
        assertThat(protokoll.path("aenderungen").get(0).path("art").asText()).isEqualTo("erfasst");
        assertThat(protokoll.path("aenderungen").get(1).path("art").asText()).isEqualTo("eingeloest");
        protokoll.path("aenderungen").forEach(a -> assertThat(a.at("/akteur/name").asText())
                .isEqualTo("Ines Kaltenbach"));
    }

    @Test void verwerfenBrauchtBegruendungUndBleibtLesbar() throws Exception {
        String basis = ENERGIE + "/" + einsatz + "/messbedarf";
        JsonNode b = ruf("POST", basis, "IK", Map.of("wortlaut", "Abwärme erfassen"), 201);
        String pfad = basis + "/" + b.path("id").asText();
        ablehnung("POST", pfad + "/verwerfen", Map.of("begruendung", " "), 422, "begruendung_fehlt");
        JsonNode verworfen = ruf("POST", pfad + "/verwerfen", "IK",
                Map.of("begruendung", "Wird im Anlagenumbau ersetzt"), 200);
        assertThat(verworfen.path("zustand").asText()).isEqualTo("verworfen");
        assertThat(ruf("GET", basis, "IK", null, 200).path("messbedarfe").get(0).path("zustand").asText())
                .isEqualTo("verworfen");
        ablehnung("POST", pfad + "/verwerfen", Map.of("begruendung", "noch einmal"),
                409, "messbedarf_abgeschlossen");
    }

    @Test void offboardingRaeumtBedarfProtokollUndZaehlerVorDemEinsatzAb() throws Exception {
        String basis = ENERGIE + "/" + einsatz + "/messbedarf";
        ruf("POST", basis, "IK", Map.of("wortlaut", "Messung für den Umbau"), 201);
        for (String tabelle : List.of("messbedarf", "messbedarf_aenderung", "messbedarf_kennzeichen_seq")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=?::regclass",
                    Boolean.class, tabelle)).as(tabelle).isTrue();
            assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_app',?,'DELETE')",
                    Boolean.class, tabelle)).as(tabelle).isFalse();
        }
        new TenantRepository(root).offboard(tenant);
        assertThat(root.queryForObject("SELECT count(*) FROM tenant WHERE id=?", Integer.class, tenant)).isZero();
        for (String tabelle : List.of("messbedarf", "messbedarf_aenderung", "messbedarf_kennzeichen_seq")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id=?",
                    Integer.class, tenant)).as(tabelle).isZero();
        }
    }

    private void ablehnung(String method, String path, Object body, int status, String code) throws Exception {
        assertThat(ruf(method, path, "IK", body, status).path("code").asText()).isEqualTo(code);
    }

    private List<BewertungMessbedarfNaht.Bedarf> offene() {
        TenantContext.set(tenant);
        try {
            return naht.offene(null, null);
        } finally {
            TenantContext.clear();
        }
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of()))
                .claim("name", sub.equals("IK") ? "Ines Kaltenbach" : "Peter Hollerbach").build();
        var anfrage = request(HttpMethod.valueOf(method), path)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)));
        if (body != null) anfrage.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var antwort = mvc.perform(anfrage).andReturn().getResponse();
        assertThat(antwort.getStatus()).as(method + " " + path + " " + antwort.getContentAsString()).isEqualTo(status);
        return JSON.readTree(antwort.getContentAsString(StandardCharsets.UTF_8));
    }

    private UUID standort(String kennzeichen) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class,
                tenant, unternehmen, kennzeichen, kennzeichen);
    }

    private void benutzer(String sub, String name, String rolle, UUID ort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, name);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?, '2024-01-01','Europe/Berlin')", tenant, sub, rolle, ort);
    }

    private UUID messstelle(String kennzeichen, String name, UUID ort, boolean eingerichtet) {
        UUID id = root.queryForObject("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) "
                + "VALUES (?,?,?,'gemessen','Strom','Wirkenergie','Bezug','kWh','Zählerstand') RETURNING id",
                UUID.class, tenant, kennzeichen, name);
        if (ort != null) root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) "
                + "VALUES (?,?,?,'2024-01-01')", tenant, id, ort);
        assertThat(eingerichtet).isEqualTo(ort != null);
        return id;
    }

    private UUID fremdeMessstelle() {
        UUID t = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd IP-19') RETURNING id", UUID.class);
        return root.queryForObject("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) "
                + "VALUES (?,'MS-23','Fremd','gemessen','Strom','Wirkenergie','Bezug','kWh','Zählerstand') RETURNING id",
                UUID.class, t);
    }
}
