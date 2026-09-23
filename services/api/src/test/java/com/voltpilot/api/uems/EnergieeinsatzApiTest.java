package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
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

/** AP-16 R14/R5/B1: echte HTTP-, Rechte- und RLS-Kette mit der App-Rolle. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class EnergieeinsatzApiTest {
    private static final String BASE = "/api/v1/unternehmen/energieeinsaetze";
    private static final ObjectMapper JSON = new ObjectMapper();
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");
    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip4_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip4_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }
    @Autowired MockMvc mvc;
    static JdbcTemplate root;
    UUID tenant, unternehmen, s1, s2, p1, p2, p5, ohne;
    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
    }
    @BeforeEach void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-4') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Ahrenberg') RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1"); s2 = standort("ST-2");
        benutzer("IK", "Ines Kaltenbach", "energiemanager", null);
        benutzer("PH", "Peter Hollerbach", "bearbeiter", s2);
        p1 = prozess("P-1", s1); p2 = prozess("P-2", s2); p5 = prozess("P-5", s2); ohne = prozess("P-7", null);
    }

    @Test void r14SichtbarkeitIstStandortUndNichtVerantwortlichkeit() throws Exception {
        var e1 = anlegen(p1); var e2 = anlegen(p2);
        anlegen(prozess("P-3", s1)); anlegen(prozess("P-4", s1)); var e5 = anlegen(p5);
        for (var e : List.of(e2, e5)) {
            ruf("PUT", BASE + "/" + e.path("id").asText() + "/verantwortlicher", "IK", Map.of("verantwortlich_sub", "PH"), 200);
            var sichtbar = ruf("GET", BASE + "/" + e.path("id").asText(), "PH", null, 200);
            assertThat(sichtbar.at("/verantwortlich/name").asText()).isEqualTo("Peter Hollerbach");
        }
        var liste = ruf("GET", BASE, "PH", null, 200).path("energieeinsaetze");
        assertThat(liste.findValuesAsText("kennzeichen")).contains("EE-2", "EE-5").doesNotContain("EE-1");
        var unbekannt = ruf("GET", BASE + "/" + UUID.randomUUID(), "PH", null, 404);
        assertThat(ruf("GET", BASE + "/" + e1.path("id").asText(), "PH", null, 404)).isEqualTo(unbekannt);
        assertThat(ruf("GET", BASE + "/" + e1.path("id").asText() + "/protokoll", "PH", null, 404)).isEqualTo(unbekannt);
        ruf("POST", BASE, "PH", neu(ohne), 403);
        for (String suffix : List.of("", "/verantwortlicher", "/einflussgroessen"))
            ruf("PUT", BASE + "/" + e2.path("id").asText() + suffix, "PH", Map.of(), 403);
        ruf("POST", BASE + "/" + e2.path("id").asText() + "/beenden", "PH", Map.of("grund", "Ende"), 403);
        root.update("UPDATE benutzer SET anzeigename='Umbenannt', zustand='entfernt' WHERE tenant_id=? AND sub='PH'", tenant);
        root.update("INSERT INTO zugriff_protokoll(tenant_id,aktion,betroffener_sub,betroffener_name,actor_sub,actor_name,actor_art) "
                + "VALUES (?,'entfernen','PH','Peter Hollerbach','IK','Ines Kaltenbach','kunde')", tenant);
        var ende = ruf("GET", BASE + "/" + e2.path("id").asText(), "IK", null, 200).path("verantwortlich");
        assertThat(ende.path("name").asText()).isEqualTo("Peter Hollerbach");
        assertThat(ende.path("zustand").asText()).isEqualTo("entfernt");
        assertThat(ende.path("ohne_konto_seit").isTextual()).isTrue();
    }

    @Test void b1R5FilterVorschlaegeUndJedeAenderungMitAkteur() throws Exception {
        assertThat(ruf("GET", BASE + "/vorschlaege", "IK", null, 200).path("vorschlaege")).hasSize(4);
        var e = anlegen(ohne); String pfad = BASE + "/" + e.path("id").asText();
        assertThat(e.path("keine_werte").asBoolean()).isTrue();
        assertThat(e.path("messstellen")).isEmpty();
        ablehnung("POST", BASE, neu(ohne), 409, "einsatz_laeuft_bereits");
        assertThat(ruf("GET", BASE + "/vorschlaege", "IK", null, 200).path("vorschlaege")).hasSize(3);
        ruf("PUT", pfad, "IK", Map.of("name", "Gebäudetechnik", "wortlaut", "Lüftung", "verbraucher_wortlaut", "Halle 1"), 200);
        ruf("PUT", pfad + "/verantwortlicher", "IK", Map.of("verantwortlich_sub", "PH"), 200);
        ruf("PUT", pfad + "/einflussgroessen", "IK", Map.of("einflussgroessen", List.of(Map.of("wortlaut", "Temperatur", "art", "wetter"))), 200);
        ruf("PUT", pfad + "/einflussgroessen", "IK", Map.of("einflussgroessen", List.of()), 200);
        ablehnung("POST", pfad + "/beenden", Map.of("grund", " "), 422, "grund_fehlt");
        ablehnung("POST", pfad + "/beenden", Map.of("grund", "Ende", "gueltig_bis", "2020-01-01"), 422, "zeitraum_ungueltig");
        ruf("POST", pfad + "/beenden", "IK", Map.of("grund", "Neuer Zuschnitt"), 200);
        ablehnung("PUT", pfad, Map.of("name", "Versuch"), 409, "einsatz_beendet");
        var nachfolger = anlegen(ohne);
        var liste = ruf("GET", BASE + "?prozess=" + ohne, "IK", null, 200).path("energieeinsaetze");
        assertThat(liste).hasSize(2);
        assertThat(liste.get(0).path("id")).isEqualTo(nachfolger.path("id"));
        var protokoll = ruf("GET", pfad + "/protokoll", "IK", null, 200).path("aenderungen");
        assertThat(protokoll).hasSize(6);
        assertThat(protokoll.findValuesAsText("art")).contains("angelegt", "bearbeitet", "verantwortlicher", "einflussgroessen", "beendet");
        protokoll.forEach(a -> {
            assertThat(a.at("/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
            assertThat(a.path("zeit").isTextual()).isTrue();
        });
    }

    @Test void jedeAblehnungUndAtomareAnlage() throws Exception {
        for (var fall : List.of(Map.entry("prozess_id", UUID.randomUUID().toString()), Map.entry("traeger", "Öl"),
                Map.entry("verantwortlich_sub", "unbekannt"), Map.entry("name", " "))) {
            var a = neu(ohne); a.put(fall.getKey(), fall.getValue());
            String code = switch (fall.getKey()) { case "prozess_id" -> "prozess_unbekannt"; case "traeger" -> "traeger_unbekannt";
                case "verantwortlich_sub" -> "verantwortlicher_unbekannt"; default -> "name_fehlt"; };
            ablehnung("POST", BASE, a, 422, code);
        }
        for (var einfluss : List.of(Map.of("art", "wetter"), Map.of("art", "unbekannt", "wortlaut", "Text"),
                Map.of("art", "produktion", "bezugsgroesse_id", UUID.randomUUID().toString()))) {
            var a = neu(ohne); a.put("einflussgroessen", List.of(einfluss));
            ablehnung("POST", BASE, a, 422, "einflussgroesse_ungueltig");
        }
        var a = neu(ohne); a.put("tenant_id", UUID.randomUUID());
        ablehnung("POST", BASE, a, 400, "anfrage_ungueltig");
        assertThat(ruf("GET", BASE, "IK", null, 200).path("energieeinsaetze")).isEmpty();
        assertThat(anlegen(ohne).path("kennzeichen").asText()).isEqualTo("EE-1");
    }

    @Test void bezugsgroesseBleibtMitLesbarer409AuchInDerGeschichte() throws Exception {
        UUID bz = root.queryForObject("INSERT INTO bezugsgroesse(tenant_id,kennzeichen,name,wertart,einheit,periode_art,geltung_art,unternehmen_id) "
                + "VALUES (?,'BZ-1','Produktion','periodenwert','Stück','monat','unternehmen',?) RETURNING id", UUID.class, tenant, unternehmen);
        var a = neu(p2); a.put("einflussgroessen", List.of(Map.of("bezugsgroesse_id", bz.toString(), "art", "produktion")));
        var e = ruf("POST", BASE, "IK", a, 201);
        assertThat(e.at("/einflussgroessen/0/bezugsgroesse/id").asText()).isEqualTo(bz.toString());
        assertThat(e.at("/einflussgroessen/0/bezugsgroesse/kennzeichen").asText()).isEqualTo("BZ-1");
        assertThat(e.at("/einflussgroessen/0/bezugsgroesse/name").asText()).isEqualTo("Produktion");
        var gezaeunt = ruf("GET", BASE + "/" + e.path("id").asText(), "PH", null, 200)
                .path("einflussgroessen").get(0);
        assertThat(gezaeunt.path("bezugsgroesse_id").asText()).isEqualTo(bz.toString());
        assertThat(gezaeunt.has("bezugsgroesse")).isFalse();
        var fehler = ruf("DELETE", "/api/v1/bezugsgroessen/" + bz, "IK", null, 409);
        assertThat(fehler.path("code").asText()).isEqualTo("bezugsgroesse_in_verwendung");
        assertThat(fehler.path("energieeinsaetze").get(0).asText()).isEqualTo(e.path("kennzeichen").asText());
        ruf("PUT", BASE + "/" + e.path("id").asText() + "/einflussgroessen", "IK", Map.of("einflussgroessen", List.of()), 200);
        ruf("DELETE", "/api/v1/bezugsgroessen/" + bz, "IK", null, 409);
    }

    @Test void messstellenZusammenfassungUndFremderMandant() throws Exception {
        var e = anlegen(p2);
        var ms = e.path("messstellen").get(0);
        assertThat(ms.path("orte").get(0).path("kennzeichen").asText()).isEqualTo("ST-2");
        assertThat(ms.path("zustand").asText()).isNotBlank();
        assertThat(ms.path("letzter_monat").path("raster").asText()).isEqualTo("monat");
        assertThat(e.path("keine_werte").asBoolean()).isTrue();
        UUID fremd = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd') RETURNING id", UUID.class);
        UUID u = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Fremd') RETURNING id", UUID.class, fremd);
        UUID p = root.queryForObject("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) VALUES (?,?,'P-1','Fremd','2024-01-01') RETURNING id", UUID.class, fremd, u);
        ablehnung("POST", BASE, neu(p), 422, "prozess_unbekannt");
    }

    @Test void unterstuetzungNurMitAuftragUndNurAmBeauftragtenStandort() throws Exception {
        var e1 = anlegen(p1); var e2 = anlegen(p2);
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,'TB','partner','Thomas Brunner','aktiv')", tenant);
        ruf("GET", BASE, "TB", null, 404);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,art,umfang,gueltig_ab,gueltig_bis,endet_am,zeitzone) "
                + "VALUES (?,'TB','unterstuetzer',?,'installateur','ansehen','2024-01-01','2099-12-30','2099-12-31','Europe/Berlin')",tenant,s1);
        ruf("GET", BASE + "/" + e1.path("id").asText(), "TB", null, 200);
        ruf("GET", BASE + "/" + e2.path("id").asText(), "TB", null, 404);
        ruf("GET", BASE + "/" + e2.path("id").asText() + "/protokoll", "TB", null, 404);
        assertThat(ruf("GET", BASE, "TB", null, 200).path("energieeinsaetze")).hasSize(1);
        ruf("POST", BASE, "TB", neu(ohne), 403);
    }

    private JsonNode anlegen(UUID prozess) throws Exception { return ruf("POST", BASE, "IK", neu(prozess), 201); }
    private Map<String,Object> neu(UUID prozess) {
        return new LinkedHashMap<>(Map.of("prozess_id", prozess.toString(), "traeger", "Strom", "name", "Einsatz", "gueltig_ab", "2026-01-01"));
    }
    private void ablehnung(String method, String path, Object body, int status, String code) throws Exception {
        assertThat(ruf(method,path,"IK",body,status).path("code").asText()).isEqualTo(code);
    }
    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        Jwt token = Jwt.withTokenValue("test").header("alg","none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id",tenant.toString())
                .claim("realm_access",Map.of("roles",sub.equals("TB") ? List.of("partner") : List.of())).claim("name", sub.equals("IK") ? "Ines Kaltenbach" : "Peter Hollerbach").build();
        var b = request(HttpMethod.valueOf(method), path).with(authentication(new KeycloakRealmRoleConverter().convert(token)));
        if (sub.equals("TB")) b.header("X-Kundenbereich", tenant.toString());
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r = mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method + " " + path + " " + r.getContentAsString()).isEqualTo(status);
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }
    private UUID standort(String k) {
        return root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id", UUID.class,tenant,unternehmen,k,k);
    }
    private void benutzer(String sub,String name,String rolle,UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",tenant,sub,name);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) VALUES (?,?,?,?, '2024-01-01','Europe/Berlin')",tenant,sub,rolle,standort);
    }
    private UUID prozess(String k,UUID standort) {
        UUID p = root.queryForObject("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) VALUES (?,?,?,?,'2024-01-01') RETURNING id",UUID.class,tenant,unternehmen,k,k);
        if (standort != null) {
            UUID m = root.queryForObject("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) VALUES (?,?,?,'gemessen','Strom','Wirkenergie','Bezug','kWh','Zählerstand') RETURNING id",UUID.class,tenant,"MS-"+k.substring(2),k);
            root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",tenant,m,standort);
            root.update("INSERT INTO messstelle_prozess(tenant_id,messstelle_id,prozess_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",tenant,m,p);
        }
        return p;
    }
}
