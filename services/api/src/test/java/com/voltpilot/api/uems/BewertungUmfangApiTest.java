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

/** AP-16 R1/R12/U1/U2/N4: echte HTTP-, Rechte- und RLS-Kette mit der App-Rolle. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BewertungUmfangApiTest {
    private static final String BASE = "/api/v1/unternehmen/bewertung/umfang";
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
        r.add("spring.flyway.placeholders.adminDbPassword", () -> "ip5_admin_pw");
        r.add("voltpilot.admin-datasource.password", () -> "ip5_admin_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
    }
    @Autowired MockMvc mvc;
    static JdbcTemplate root;
    UUID tenant, unternehmen, s1, s2, leer, a1, a2, a3;
    private static final List<String> TABELLEN = List.of("bewertung_umfang", "bewertung_umfang_standort",
            "bewertung_umfang_ausschluss", "bewertung_aenderung");
    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
    }
    @BeforeEach void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-5') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Ahrenberg') RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1"); s2 = standort("ST-2"); leer = standort("ST-3");
        benutzer("IK", "Ines Kaltenbach", "energiemanager", null);
        benutzer("PH", "Peter Hollerbach", "bearbeiter", s2);
        benutzer("LE", "Leser", "leser", s2);
        a1 = anlage("AN-1",s1,"2026-01-01"); a2 = anlage("AN-2",s1,"2026-01-01");
        a3 = anlage("AN-3",s2,"2026-10-15");
    }

    @Test void r1InesSpeichertDreiAnlagenUndGasOhneAnteil() throws Exception {
        var antwort = speichern(neu());
        assertThat(antwort.path("fassung").asInt()).isEqualTo(1);
        assertThat(antwort.path("anzahl_anlagen_im_umfang").asInt()).isEqualTo(3);
        assertThat(antwort.path("anlagen_im_umfang").findValuesAsText("id"))
                .containsExactlyInAnyOrder(a1.toString(),a2.toString(),a3.toString());
        assertThat(antwort.at("/akteur/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(antwort.path("nenner_traeger").asText()).isEqualTo("Strom");
        for (var t : antwort.path("traeger")) assertThat(t.path("mit_anteil").asBoolean())
                .isEqualTo(t.path("name").asText().equals("Strom"));
        assertThat(ruf("GET",BASE+"?am=2026-11-04","IK",null,200)).isEqualTo(antwort);
        var referenz = JSON.readTree(java.nio.file.Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json").toFile())
                .at("/bewertung_umfang/fassungen/0");
        assertThat(antwort.path("gueltig_ab")).isEqualTo(referenz.path("gueltig_ab"));
        assertThat(antwort.path("traeger")).containsExactlyInAnyOrderElementsOf(
                java.util.stream.StreamSupport.stream(referenz.path("traeger").spliterator(),false).toList());
    }

    @Test void ohneFassungNurVorgabeUndLeererStandortIstNullVonNull() throws Exception {
        var v = ruf("GET",BASE+"?am=2026-11-04","IK",null,200);
        assertThat(v.path("fassung").isNull()).isTrue();
        assertThat(v.path("standorte")).hasSize(3);
        assertThat(v.path("traeger")).hasSize(1);
        assertThat(anzahl("bewertung_umfang")).isZero();
        var e = neu(); e.put("standort_ids",List.of(leer));
        var a = speichern(e);
        assertThat(a.path("standorte")).hasSize(1);
        assertThat(a.path("anzahl_anlagen_im_umfang").asInt()).isZero();
        assertThat(a.at("/standorte/0/anzahl_anlagen_im_umfang").asInt()).isZero();
        assertThat(a.at("/standorte/0/anlagen_im_umfang")).isEmpty();
    }

    @Test void stichtagLiestBindungMitInklusivemLetztenTagUndOhneAufgehobene() throws Exception {
        var e = neu(); e.put("gueltig_ab","2026-01-01"); speichern(e);
        assertThat(ruf("GET",BASE+"?am=2026-10-14","IK",null,200).path("anzahl_anlagen_im_umfang").asInt()).isEqualTo(2);
        assertThat(ruf("GET",BASE+"?am=2026-10-15","IK",null,200).path("anzahl_anlagen_im_umfang").asInt()).isEqualTo(3);
        root.update("UPDATE anlage_standort SET gueltig_bis='2026-11-04' WHERE site_id=?",a3);
        assertThat(ruf("GET",BASE+"?am=2026-11-04","IK",null,200).path("anzahl_anlagen_im_umfang").asInt()).isEqualTo(3);
        assertThat(ruf("GET",BASE+"?am=2026-11-05","IK",null,200).path("anzahl_anlagen_im_umfang").asInt()).isEqualTo(2);
        root.update("UPDATE anlage_standort SET aufgehoben_am=now() WHERE site_id=?",a3);
        assertThat(ruf("GET",BASE+"?am=2026-10-15","IK",null,200).path("anzahl_anlagen_im_umfang").asInt()).isEqualTo(2);
    }

    @Test void fassungenIdempotenzUndAtomarerSchnappschuss() throws Exception {
        var erste = speichern(neu());
        var gleich = neu(); gleich.put("standort_ids",List.of(s2,s1)); gleich.put("traeger",List.of("Gas","Strom"));
        assertThat(speichern(gleich).path("id")).isEqualTo(erste.path("id"));
        assertThat(anzahl("bewertung_aenderung")).isEqualTo(1);
        var neu = neu(); neu.put("gueltig_ab","2026-12-01"); neu.put("standort_ids",List.of(s2));
        assertThat(speichern(neu).path("fassung").asInt()).isEqualTo(2);
        var historie = ruf("GET",BASE+"/fassungen","IK",null,200).path("fassungen");
        assertThat(historie).hasSize(2);
        assertThat(historie.get(1).path("aufgehoben_am").isTextual()).isTrue();
        assertThat(historie.get(0).path("aufgehoben_am").isNull()).isTrue();
        assertThat(ruf("GET",BASE+"?am=2026-11-30","IK",null,200).path("fassung").asInt()).isEqualTo(1);
        assertThat(ruf("GET",BASE+"?am=2026-12-01","IK",null,200).path("fassung").asInt()).isEqualTo(2);
        var protokoll = root.queryForMap("SELECT art,alt::text,neu::text,actor_name FROM bewertung_aenderung WHERE tenant_id=? ORDER BY id DESC LIMIT 1",tenant);
        assertThat(protokoll.get("art")).isEqualTo("umfang_geaendert");
        assertThat(protokoll.get("actor_name")).isEqualTo("Ines Kaltenbach");
        assertThat(JSON.readTree((String)protokoll.get("alt")).path("standort_ids")).hasSize(2);
        assertThat(JSON.readTree((String)protokoll.get("neu")).path("standort_ids")).hasSize(1);
        assertThat(ruf("PUT",BASE,"IK",neu(),422).path("code").asText()).isEqualTo("gueltig_ab_ungueltig");
        assertThat(anzahl("bewertung_umfang")).isEqualTo(2);
    }

    @Test void ausschluesseBrauchenGrundUndEntfernenNurIhreBilanzgrenze() throws Exception {
        UUID p = root.queryForObject("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) "
                + "VALUES (?,?,'P-1','Prozess','2026-01-01') RETURNING id",UUID.class,tenant,unternehmen);
        var e = neu(); e.put("ausschluesse",List.of(Map.of("art","anlage","verweis",a1,"begruendung"," ")));
        assertThat(ruf("PUT",BASE,"IK",e,422).path("code").asText()).isEqualTo("begruendung_fehlt");
        assertThat(anzahl("bewertung_aenderung")).isZero();
        e.put("ausschluesse",List.of(Map.of("art","anlage","verweis",a1,"begruendung","Separate Bewertung"),
                Map.of("art","prozess","verweis",p,"begruendung","Separater Prozess")));
        assertThat(speichern(e).path("anzahl_anlagen_im_umfang").asInt()).isEqualTo(2);
        e.put("ausschluesse",List.of(Map.of("art","standort","verweis",s1,"begruendung","Separates Werk")));
        assertThat(speichern(e).path("anzahl_anlagen_im_umfang").asInt()).isEqualTo(1);
    }

    @Test void gasAlleinHatKeinenNennerUndKeineErfundeneBilanz() throws Exception {
        var e = neu(); e.put("traeger",List.of("Gas"));
        var a = speichern(e);
        assertThat(a.path("nenner_traeger").isNull()).isTrue();
        assertThat(a.at("/traeger/0/mit_anteil").asBoolean()).isFalse();
        assertThat(a.has("nenner_kwh")).isFalse();
        assertThat(a.has("anlagen_mit_bilanz")).isFalse();
    }

    @Test void bearbeiterUndLeserNurLesendMitStandortZaun() throws Exception {
        // Der Zugriffszaun prüft die heutige Bindung, der Umfang zusätzlich den angefragten Tag.
        root.update("UPDATE anlage_standort SET gueltig_ab='2026-01-01' WHERE site_id=?",a3);
        speichern(neu());
        for (String sub : List.of("PH","LE")) {
            var a = ruf("GET",BASE+"?am=2026-11-04",sub,null,200);
            assertThat(a.path("standorte")).hasSize(1);
            assertThat(a.at("/standorte/0/id").asText()).isEqualTo(s2.toString());
            assertThat(a.path("anzahl_anlagen_im_umfang").asInt()).isEqualTo(1);
            assertThat(a.path("teilansicht").asBoolean()).isTrue();
            assertThat(a.toString()).doesNotContain(s1.toString(),a1.toString(),a2.toString());
            assertThat(ruf("GET",BASE+"/fassungen",sub,null,200).at("/fassungen/0/standorte")).hasSize(1);
            ruf("PUT",BASE,sub,neu(),403);
        }
        assertThat(anzahl("bewertung_umfang")).isEqualTo(1);
    }

    @Test void fremdeVerweiseUndUnbekannteFelderSindAtomarAbgelehnt() throws Exception {
        UUID fremd = root.queryForObject("INSERT INTO tenant(name) VALUES ('Fremd') RETURNING id", UUID.class);
        UUID u = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Fremd') RETURNING id", UUID.class,fremd);
        UUID st = root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                + "VALUES (?,?,'Fremd','ST-F','Europe/Berlin','aktiv') RETURNING id",UUID.class,fremd,u);
        var e = neu(); e.put("standort_ids",List.of(st));
        assertThat(ruf("PUT",BASE,"IK",e,422).path("code").asText()).isEqualTo("standort_unbekannt");
        e=neu(); e.put("ausschluesse",List.of(Map.of("art","standort","verweis",st,"begruendung","Versuch")));
        assertThat(ruf("PUT",BASE,"IK",e,422).path("code").asText()).isEqualTo("ausschluss_ungueltig");
        e=neu(); e.put("tenant_id",fremd); ruf("PUT",BASE,"IK",e,400);
        e=neu(); e.put("traeger",List.of("Öl"));
        assertThat(ruf("PUT",BASE,"IK",e,422).path("code").asText()).isEqualTo("traeger_unbekannt");
        ruf("GET",BASE+"?am=kein-tag","IK",null,400);
        assertThat(anzahl("bewertung_umfang")).isZero();
    }

    @Test void rlsGrantsUndOffboarding() throws Exception {
        var e=neu(); e.put("ausschluesse",List.of(Map.of("art","anlage","verweis",a1,"begruendung","Separate Bewertung")));
        speichern(e);
        try (var c = new DriverManagerDataSource(POSTGRES.getJdbcUrl(),"voltpilot_app","ip4_test_pw").getConnection();
                var st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id','"+UUID.randomUUID()+"',false)");
            assertThatThrownBy(() -> st.execute("INSERT INTO bewertung_aenderung(tenant_id,art,actor_sub,actor_name,actor_art) "
                    + "VALUES ('"+tenant+"','umfang_angelegt','IK','Ines','kunde')"))
                    .isInstanceOf(java.sql.SQLException.class).hasMessageContaining("row-level security");
            for (String t : TABELLEN) {
                try (var rs=st.executeQuery("SELECT count(*) FROM "+t)) { rs.next(); assertThat(rs.getInt(1)).isZero(); }
                assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=?::regclass",Boolean.class,t)).isTrue();
                assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_app',?,'DELETE')",Boolean.class,t)).isFalse();
                assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_app',?,'UPDATE')",Boolean.class,t)).isFalse();
            }
        }
        new com.voltpilot.api.repo.TenantRepository(new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(),"voltpilot_admin","ip5_admin_pw"))).offboard(tenant);
        for (String t : TABELLEN) assertThat(anzahl(t)).isZero();
    }

    @Test void unveraenderterUmfangBleibtNachAnlagenLoeschungIdempotent() throws Exception {
        var e=neu(); e.put("ausschluesse",List.of(Map.of("art","anlage","verweis",a1,"begruendung","Separate Bewertung")));
        var f=speichern(e);
        benutzer("KA","Kundenadministrator","kundenadministrator",null);
        var token=Jwt.withTokenValue("test").header("alg","none").subject("KA").issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id",tenant.toString())
                .claim("realm_access",Map.of("roles",List.of())).build();
        var loeschen=mvc.perform(request(HttpMethod.DELETE,"/api/v1/sites/"+a1)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)))).andReturn().getResponse();
        assertThat(loeschen.getStatus()).as(loeschen.getContentAsString()).isBetween(200,299);
        assertThat(root.queryForObject("SELECT count(*) FROM site WHERE id=?",Integer.class,a1)).isZero();
        assertThat(speichern(e).path("id")).isEqualTo(f.path("id"));
        assertThat(anzahl("bewertung_aenderung")).isEqualTo(1);
        assertThat(ruf("GET",BASE+"/fassungen","IK",null,200).at("/fassungen/0/ausschluesse/0/verweis").asText()).isEqualTo(a1.toString());
    }

    @Test void paralleleErstanlageErzeugtEineFassungUndEinProtokoll() throws Exception {
        try (var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var start=new java.util.concurrent.CountDownLatch(1);
            var eins=pool.submit(() -> { start.await(); return speichern(neu()); });
            var zwei=pool.submit(() -> { start.await(); return speichern(neu()); });
            start.countDown();
            assertThat(eins.get(30,java.util.concurrent.TimeUnit.SECONDS).path("id"))
                    .isEqualTo(zwei.get(30,java.util.concurrent.TimeUnit.SECONDS).path("id"));
        }
        assertThat(anzahl("bewertung_umfang")).isEqualTo(1);
        assertThat(anzahl("bewertung_aenderung")).isEqualTo(1);
    }

    private int anzahl(String t) { return root.queryForObject("SELECT count(*) FROM "+t+" WHERE tenant_id=?",Integer.class,tenant); }
    private JsonNode speichern(Object e) throws Exception { return ruf("PUT",BASE,"IK",e,200); }
    private Map<String,Object> neu() {
        return new LinkedHashMap<>(Map.of("gueltig_ab","2026-11-04","standort_ids",List.of(s1,s2),
                "traeger",List.of("Strom","Gas"),"ausschluesse",List.of()));
    }
    private UUID anlage(String name,UUID standort,String ab) {
        UUID id=root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,?) RETURNING id",UUID.class,tenant,name);
        root.update("INSERT INTO anlage_standort(tenant_id,site_id,standort_id,gueltig_ab) VALUES (?,?,?,?::date)",tenant,id,standort,ab);
        return id;
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
}
