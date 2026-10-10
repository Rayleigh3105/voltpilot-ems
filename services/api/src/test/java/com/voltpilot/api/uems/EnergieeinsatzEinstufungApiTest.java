package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
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

/** AP-16 R3/R13/R17: Einstufung bleibt eine begründete Entscheidung einer Person. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergieeinsatzEinstufungApiTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BASE = "/api/v1/unternehmen/energieeinsaetze";
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");
    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip11_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip11_test_pw");
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "ip11_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "ip11_admin_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }

    @Autowired MockMvc mvc;
    static JdbcTemplate root;
    UUID tenant, unternehmen, einsatz;

    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-11') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Ahrenberg') RETURNING id",
                UUID.class, tenant);
        UUID standort = root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,'Werk','ST-1','Europe/Berlin','aktiv') RETURNING id", UUID.class, tenant, unternehmen);
        benutzer("IK", "Ines Kaltenbach", "energiemanager", null);
        benutzer("KA", "Jonas Wendlinger", "kundenadministrator", null);
        benutzer("PH", "Peter Hollerbach", "bearbeiter", standort);
        UUID prozess = root.queryForObject("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) "
                + "VALUES (?,?,'P-1','Druckluft','2024-01-01') RETURNING id", UUID.class, tenant, unternehmen);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) "
                + "VALUES (?,'MS-7','Druckluft','gemessen','Strom','Wirkenergie','Bezug','kWh','Zählerstand') RETURNING id",
                UUID.class, tenant);
        root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, messstelle, standort);
        root.update("INSERT INTO messstelle_prozess(tenant_id,messstelle_id,prozess_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant, messstelle, prozess);
        einsatz = root.queryForObject("INSERT INTO energieeinsatz(tenant_id,prozess_id,traeger,name,gueltig_ab,actor_sub,actor_name,actor_rolle,actor_art) "
                + "VALUES (?,?,'Strom','Druckluft','2024-01-01','IK','Ines Kaltenbach','energiemanager','kunde') RETURNING id",
                UUID.class, tenant, prozess);
    }

    @Test void r3PflichtbegruendungHerkunftUndAbweichungVomVorschlag() throws Exception {
        var ohne = neu("2026-01-02", "wesentlich", "K4");
        ohne.remove("begruendung");
        assertThat(ruf("PUT", pfad("/einstufung"), "IK", ohne, 422).path("code").asText())
                .isEqualTo("begruendung_fehlt");
        assertThat(anzahl()).isZero();

        var f = ruf("PUT", pfad("/einstufung"), "IK",
                neu("2026-01-02", "wesentlich", "K4"), 200);
        assertThat(f.path("fassung").asInt()).isEqualTo(1);
        assertThat(f.path("einstufung").asText()).isEqualTo("wesentlich");
        assertThat(f.at("/herkunft/vorschlag").asText()).isEqualTo("unter_schwelle");
        assertThat(f.path("grund").get(0).asText()).isEqualTo("K4");
        assertThat(f.at("/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(root.queryForObject("SELECT count(*) FROM energieeinsatz_aenderung WHERE einsatz_id=? "
                + "AND art='einstufung_gesetzt' AND neu->>'einstufung'='wesentlich' "
                + "AND neu#>>'{herkunft,vorschlag}'='unter_schwelle'", Integer.class, einsatz)).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id=? "
                + "AND art='einstufung_gesetzt' AND kennungen->>'energieeinsatz'='EE-1' "
                + "AND nutzlast->>'einstufung'='wesentlich'", Integer.class, tenant)).isOne();
    }

    @Test void unvollstaendigeHerkunftIst422OhneNebenwirkung() throws Exception {
        var anfrage = neu("2026-01-02", "wesentlich", "K1");
        ((com.fasterxml.jackson.databind.node.ObjectNode) anfrage.at("/herkunft/eingaenge/0")).remove("version");
        assertThat(ruf("PUT", pfad("/einstufung"), "IK", anfrage, 422).path("code").asText())
                .isEqualTo("herkunft_unvollstaendig");
        assertThat(anzahl()).isZero();
    }

    @Test void r13RueckstufungIstNeueFassungUndAlteBleibenLesbar() throws Exception {
        ruf("PUT", pfad("/einstufung"), "IK", neu("2026-01-02", "wesentlich", "K4"), 200);
        ruf("PUT", pfad("/einstufung"), "IK", neu("2026-02-02", "wesentlich", "K2"), 200);
        ruf("PUT", pfad("/einstufung"), "IK", neu("2026-03-02", "nicht_wesentlich", "K1"), 200);
        var f = ruf("GET", pfad("/einstufungen"), "IK", null, 200).path("fassungen");
        assertThat(f.findValuesAsText("fassung")).containsExactly("3", "2", "1");
        assertThat(f.get(0).path("einstufung").asText()).isEqualTo("nicht_wesentlich");
        assertThat(f.get(1).path("gueltig_bis").asText()).isEqualTo("2026-03-01");
        assertThat(f.get(2).path("begruendung").asText()).contains("Einschätzung");
    }

    @Test void r17VierAugenErfordertZweitePersonUndLaesstAltenStandWirksam() throws Exception {
        ruf("PUT", pfad("/einstufung"), "IK", neu("2026-01-02", "nicht_wesentlich", "K1"), 200);
        root.update("UPDATE unternehmen SET vieraugen_freigabe=true WHERE id=?", unternehmen);
        var offen = ruf("PUT", pfad("/einstufung"), "IK", neu("2026-02-02", "wesentlich", "K4"), 200);
        assertThat(offen.path("freigabe_status").asText()).isEqualTo("beantragt");
        assertThat(offen.path("gueltig_ab").isNull()).isTrue();
        assertThat(ruf("GET", pfad("/einstufungen"), "IK", null, 200).at("/fassungen/1/gueltig_bis").isNull()).isTrue();
        assertThat(ereignisse()).isOne();
        assertThat(ruf("POST", pfad("/einstufung/bestaetigen"), "IK", null, 403).path("code").asText())
                .isEqualTo("zweite_person_noetig");
        var fertig = ruf("POST", pfad("/einstufung/bestaetigen"), "KA", null, 200);
        assertThat(fertig.path("freigabe_status").asText()).isEqualTo("freigegeben");
        assertThat(fertig.at("/entschieden_von/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(ereignisse()).isEqualTo(2);
    }

    @Test void rechteRlsUndMandantengrenze() throws Exception {
        ruf("GET", pfad("/einstufungen"), "PH", null, 200);
        ruf("PUT", pfad("/einstufung"), "PH", neu("2026-01-02", "wesentlich", "K4"), 403);
        ruf("PUT", pfad("/einstufung"), "IK", neu("2026-01-02", "wesentlich", "K4"), 200);
        UUID altTenant = tenant;
        UUID altEinsatz = einsatz;
        welt();
        assertThat(ruf("GET", BASE + "/" + altEinsatz + "/einstufungen", "IK", null, 404).path("code").asText())
                .isEqualTo("nicht_gefunden");
        tenant = altTenant;
        try (var c = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), "voltpilot_app", "ip11_test_pw").getConnection();
                var st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id','" + UUID.randomUUID() + "',false)");
            try (var rs = st.executeQuery("SELECT count(*) FROM energieeinsatz_einstufung")) {
                rs.next(); assertThat(rs.getInt(1)).isZero();
            }
            assertThatThrownBy(() -> st.execute("DELETE FROM energieeinsatz_einstufung"))
                    .isInstanceOf(java.sql.SQLException.class);
        }
        new com.voltpilot.api.repo.TenantRepository(new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_admin", "ip11_admin_pw"))).offboard(altTenant);
        assertThat(anzahl()).isZero();
    }

    private int anzahl() {
        return root.queryForObject("SELECT count(*) FROM energieeinsatz_einstufung WHERE tenant_id=?", Integer.class, tenant);
    }
    private int ereignisse() {
        return root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id=? "
                + "AND art='einstufung_gesetzt'", Integer.class, tenant);
    }
    private String pfad(String suffix) { return BASE + "/" + einsatz + suffix; }

    private com.fasterxml.jackson.databind.node.ObjectNode neu(String tag, String einstufung, String grund) {
        var h = JSON.createObjectNode();
        h.put("zeitraum", "2026-10"); h.put("kriterien_fassung", 1);
        var e = h.putArray("eingaenge").addObject();
        e.put("objekt", "MS-07"); e.put("von", "2026-10-01"); e.put("bis", "2026-10-31");
        e.put("wert", "15900"); e.put("version", 1); e.put("zustand", "vollständig");
        var n = h.putObject("nenner"); n.put("wert", "185380"); n.put("anlagen", "3 von 3");
        var b = n.putArray("bilanzwerte").addObject();
        b.put("anlage", "AN-1"); b.put("von", "2026-10-01"); b.put("bis", "2026-10-31");
        b.put("wert", "139380"); b.put("version", 1); b.put("zustand", "vollständig");
        var be = b.putArray("eingaenge").addObject(); be.put("objekt", "MS-01"); be.put("wert", "150400");
        be.put("version", 1); be.put("zustand", "vollständig");
        var u = h.putObject("urteil"); u.put("K1", "unter_schwelle"); u.put("K2", "unter_schwelle");
        u.put("K3", "nicht_anwendbar"); u.put("K5", "erfüllt"); u.put("K6", "erfüllt");
        h.put("vorschlag", "unter_schwelle");
        var a = JSON.createObjectNode(); a.put("einstufung", einstufung);
        a.put("begruendung", einstufung.equals("wesentlich") ? "Begründete Einschätzung durch die Person." : "Nach Maßnahme zurückgestuft.");
        a.putArray("grund").add(grund); a.put("gueltig_ab", tag); a.set("herkunft", h);
        return a;
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        String name = sub.equals("IK") ? "Ines Kaltenbach" : sub.equals("KA") ? "Jonas Wendlinger" : "Peter Hollerbach";
        Jwt token = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", tenant.toString())
                .claim("realm_access", Map.of("roles", List.of())).claim("name", name).build();
        var b = request(HttpMethod.valueOf(method), path)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)));
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString()).isEqualTo(status);
        return r.getContentAsString().isBlank() ? JSON.createObjectNode()
                : JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }

    private void benutzer(String sub, String name, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",
                tenant, sub, name);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) "
                + "VALUES (?,?,?,?, '2024-01-01','Europe/Berlin')", tenant, sub, rolle, standort);
    }
}
