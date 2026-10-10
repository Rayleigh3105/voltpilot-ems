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

/** AP-16 KR1/R15/R17: echte HTTP-, Rechte- und RLS-Kette mit der App-Rolle. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BewertungKriterienApiTest {
    private static final String BASE = "/api/v1/unternehmen/bewertung/kriterien";
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
    private static final List<String> TABELLEN = List.of("bewertung_kriterien_fassung", "bewertung_aenderung");
    @BeforeAll static void start() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
    }
    @BeforeEach void welt() {
        tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-8') RETURNING id", UUID.class);
        unternehmen = root.queryForObject("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Ahrenberg') RETURNING id", UUID.class, tenant);
        s1 = standort("ST-1"); s2 = standort("ST-2"); leer = standort("ST-3");
        benutzer("IK", "Ines Kaltenbach", "energiemanager", null);
        benutzer("PH", "Peter Hollerbach", "bearbeiter", s2);
        benutzer("LE", "Leser", "leser", s2);
        benutzer("KA", "Jonas Wendlinger", "kundenadministrator", null);
        benutzer("BD", "Bedienberechtigt", "bedienberechtigt", s2);
        a1 = anlage("AN-1",s1,"2026-01-01"); a2 = anlage("AN-2",s1,"2026-01-01");
        a3 = anlage("AN-3",s2,"2026-10-15");
    }

    @Test void vorgabeByteGleichZumVertragUndGetOhneSchreibwirkung() throws Exception {
        var f = ruf("GET",BASE,"IK",null,200);
        assertThat(f.path("fassung").asInt()).isEqualTo(1);
        assertThat(f.path("herkunft").asText()).isEqualTo("Vorgabe");
        assertThat(JSON.writeValueAsBytes(f.path("werte"))).isEqualTo(JSON.writeValueAsBytes(vorgabe()));
        assertThat(f.path("kriterien")).hasSize(8);
        assertThat(f.at("/kriterien/3/kennung").asText()).isEqualTo("K4");
        assertThat(f.at("/kriterien/3/schwelle").isNull()).isTrue();
        assertThat(f.at("/kriterien/2/einheit").asText()).isEqualTo("kWh");
        assertThat(ruf("GET",BASE+"/fassungen","IK",null,200).path("fassungen")).hasSize(1);
        for (String t : TABELLEN) assertThat(anzahl(t)).isZero();
    }
    @Test void r15VonZehnAufFuenfMitBegruendungUndBeidenFassungen() throws Exception {
        var f = speichern(neu());
        assertThat(f.path("fassung").asInt()).isEqualTo(2);
        assertThat(f.at("/werte/K1").asText()).isEqualTo("5");
        assertThat(f.at("/akteur/sub").asText()).isEqualTo("IK");
        assertThat(f.path("freigabe_status").asText()).isEqualTo("freigegeben");
        assertThat(JSON.readTree(root.queryForObject("SELECT kriterien::text FROM bewertung_kriterien_fassung WHERE tenant_id=? AND fassung=2",String.class,tenant)))
                .isEqualTo(f.path("kriterien"));
        assertThat(f.path("gueltig_ab").asText()).isEqualTo(java.time.LocalDate.now(java.time.ZoneId.of("Europe/Berlin")).toString());
        assertThat(ruf("GET",BASE,"IK",null,200)).isEqualTo(f);
        var h = ruf("GET",BASE+"/fassungen","IK",null,200).path("fassungen");
        assertThat(h).hasSize(2);
        assertThat(JSON.writeValueAsBytes(h.get(1).path("werte"))).isEqualTo(JSON.writeValueAsBytes(vorgabe()));
        assertThat(h.get(1).path("aufgehoben_am").isNull()).isFalse();
        assertThat(root.queryForList("SELECT art FROM bewertung_aenderung WHERE tenant_id=? ORDER BY id",String.class,tenant))
                .containsExactly("kriterien_angelegt","kriterien_geaendert");
        assertThat(root.queryForObject("SELECT alt->'werte'->>'K1' FROM bewertung_aenderung WHERE tenant_id=? AND art='kriterien_geaendert'",String.class,tenant)).isEqualTo("10");
    }
    @Test void ohneBegruendung422UndKeineNebenwirkung() throws Exception {
        var e = neu(); e.remove("begruendung");
        assertThat(ruf("PUT",BASE,"IK",e,422).path("code").asText()).isEqualTo("begruendung_fehlt");
        e.put("begruendung","  "); ruf("PUT",BASE,"IK",e,422);
        for (String t : TABELLEN) assertThat(anzahl(t)).isZero();
    }
    @Test void r17AntragBleibtUnwirksamBisZweitePersonBestaetigt() throws Exception {
        root.update("UPDATE unternehmen SET vieraugen_freigabe=true WHERE id=?",unternehmen);
        var f = speichern(neu());
        assertThat(f.path("freigabe_status").asText()).isEqualTo("beantragt");
        assertThat(f.path("gueltig_ab").isNull()).isTrue();
        assertThat(ruf("GET",BASE,"IK",null,200).path("fassung").asInt()).isEqualTo(1);
        assertThat(ruf("POST",BASE+"/2/freigeben","IK",null,403).path("code").asText()).isEqualTo("zweite_person_noetig");
        ruf("PUT",BASE,"KA",neu(),409);
        // Späteres Ausschalten umgeht den gespeicherten Vier-Augen-Antrag nicht.
        root.update("UPDATE unternehmen SET vieraugen_freigabe=false WHERE id=?",unternehmen);
        ruf("POST",BASE+"/2/freigeben","IK",null,403);
        var fertig = ruf("POST",BASE+"/2/freigeben","KA",null,200);
        assertThat(fertig.path("freigabe_status").asText()).isEqualTo("freigegeben");
        assertThat(fertig.at("/entschieden_von/sub").asText()).isEqualTo("KA");
        assertThat(fertig.path("entschieden_am").isNull()).isFalse();
        assertThat(ruf("GET",BASE,"LE",null,200).path("fassung").asInt()).isEqualTo(2);
        ruf("POST",BASE+"/2/freigeben","KA",null,409);
        assertThat(anzahl("bewertung_aenderung")).isEqualTo(3);
    }
    @Test void ablehnenErhaeltWirksameFassungUndNummerWirdNichtWiederverwendet() throws Exception {
        root.update("UPDATE unternehmen SET vieraugen_freigabe=true WHERE id=?",unternehmen);
        speichern(neu());
        ruf("POST",BASE+"/2/ablehnen","IK",Map.of("begruendung","Nein"),403);
        ruf("POST",BASE+"/2/ablehnen","KA",Map.of(),422);
        var ab = ruf("POST",BASE+"/2/ablehnen","KA",Map.of("begruendung","Zuerst die Messabdeckung verbessern."),200);
        assertThat(ab.path("freigabe_status").asText()).isEqualTo("abgelehnt");
        assertThat(ab.path("gueltig_ab").isNull()).isTrue();
        assertThat(ab.at("/akteur/sub").asText()).isEqualTo("IK");
        assertThat(ab.at("/entschieden_von/sub").asText()).isEqualTo("KA");
        assertThat(ruf("GET",BASE,"IK",null,200).path("fassung").asInt()).isEqualTo(1);
        assertThat(speichern(neu()).path("fassung").asInt()).isEqualTo(3);
        assertThat(ruf("GET",BASE+"/fassungen","IK",null,200).path("fassungen")).hasSize(3);
        assertThat(root.queryForObject("SELECT count(*) FROM bewertung_aenderung WHERE tenant_id=? AND art='kriterien_abgelehnt'",Integer.class,tenant)).isEqualTo(1);
    }
    @Test void rollenLesenUndSchreiben() throws Exception {
        for (String sub : List.of("KA","IK","PH","LE","BD")) {
            ruf("GET",BASE,sub,null,200);
            ruf("GET",BASE+"/fassungen",sub,null,200);
        }
        for (String sub : List.of("PH","LE","BD")) {
            ruf("PUT",BASE,sub,neu(),403);
            ruf("POST",BASE+"/2/freigeben",sub,null,403);
            ruf("POST",BASE+"/2/ablehnen",sub,Map.of("begruendung","Nein"),403);
        }
        ruf("PUT",BASE,"KA",neu(),200);
        ruf("PUT",BASE,"IK",neu(),200);
        assertThat(anzahl("bewertung_kriterien_fassung")).isEqualTo(3);
    }
    @Test void fremdeFassungUndEntzogenerStandortBleibenUnsichtbar() throws Exception {
        speichern(neu());
        UUID alt = tenant;
        welt();
        assertThat(ruf("GET",BASE,"IK",null,200).path("fassung").asInt()).isEqualTo(1);
        ruf("POST",BASE+"/2/freigeben","KA",null,404);
        assertThat(anzahl("bewertung_kriterien_fassung")).isZero();
        tenant = alt;
        root.update("UPDATE zugriff SET beendet_am=now(),beendet_von='KA' WHERE tenant_id=? AND benutzer_sub='LE'",tenant);
        ruf("GET",BASE,"LE",null,404);
        ruf("GET",BASE+"/fassungen","LE",null,404);
    }
    @Test void strukturUndTypenGeschlossen() throws Exception {
        for (String wert : List.of("-1","101","NaN","1e1")) {
            var e=neu(); ((com.fasterxml.jackson.databind.node.ObjectNode)e.get("werte")).put("K1",wert);
            ruf("PUT",BASE,"IK",e,422);
        }
        var e=neu(); ((com.fasterxml.jackson.databind.node.ObjectNode)e.get("werte")).put("K1",5);
        ruf("PUT",BASE,"IK",e,422);
        e=neu(); ((com.fasterxml.jackson.databind.node.ObjectNode)e.get("werte")).put("K4","5");
        ruf("PUT",BASE,"IK",e,422);
        e=neu(); ((com.fasterxml.jackson.databind.node.ObjectNode)e.get("werte")).put("mindest_monate",13);
        ruf("PUT",BASE,"IK",e,422);
        e=neu(); e.put("tenant_id",UUID.randomUUID()); ruf("PUT",BASE,"IK",e,400);
        assertThat(anzahl("bewertung_kriterien_fassung")).isZero();
    }
    @Test void rlsGrantsZweitePersonInDatenbankUndOffboarding() throws Exception {
        root.update("UPDATE unternehmen SET vieraugen_freigabe=true WHERE id=?",unternehmen);
        speichern(neu());
        assertThatThrownBy(() -> root.update("UPDATE bewertung_kriterien_fassung SET freigabe_status='freigegeben',gueltig_ab=current_date,entscheidung_sub='IK',entscheidung_name='Ines',entscheidung_rolle='energiemanager',entscheidung_art='kunde',entschieden_am=now() WHERE tenant_id=? AND fassung=2",tenant))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        try (var c = new DriverManagerDataSource(POSTGRES.getJdbcUrl(),"voltpilot_app","ip4_test_pw").getConnection();
                var st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id','"+UUID.randomUUID()+"',false)");
            for (String t : TABELLEN) {
                try (var rs=st.executeQuery("SELECT count(*) FROM "+t)) { rs.next(); assertThat(rs.getInt(1)).isZero(); }
                assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=?::regclass",Boolean.class,t)).isTrue();
                assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_app',?,'DELETE')",Boolean.class,t)).isFalse();
                assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_app',?,'UPDATE')",Boolean.class,t)).isFalse();
            }
            assertThatThrownBy(() -> st.execute("INSERT INTO bewertung_kriterien_fassung(tenant_id,unternehmen_id,fassung,werte,kriterien,actor_sub,actor_name,actor_art,vieraugen,freigabe_status) VALUES ('"+tenant+"','"+unternehmen+"',8,'{}','[null,null,null,null,null,null,null,null]','IK','Ines','kunde',true,'beantragt')"))
                    .isInstanceOf(java.sql.SQLException.class).hasMessageContaining("row-level security");
        }
        new com.voltpilot.api.repo.TenantRepository(new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(),"voltpilot_admin","ip5_admin_pw"))).offboard(tenant);
        for (String t : TABELLEN) assertThat(anzahl(t)).isZero();
    }
    @Test void paralleleAntraegeErzeugenNurEinenOffenenAntrag() throws Exception {
        root.update("UPDATE unternehmen SET vieraugen_freigabe=true WHERE id=?",unternehmen);
        try (var pool=java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var start=new java.util.concurrent.CountDownLatch(1);
            var eins=pool.submit(() -> { start.await(); return speichern(neu()); });
            var zwei=pool.submit(() -> { start.await(); return speichern(neu()); });
            start.countDown();
            int erfolg=0, konflikt=0;
            for (var f : List.of(eins,zwei)) {
                try { assertThat(f.get(30,java.util.concurrent.TimeUnit.SECONDS).path("fassung").asInt()).isEqualTo(2); erfolg++; }
                catch (java.util.concurrent.ExecutionException ex) {
                    assertThat(ex.getCause()).isInstanceOf(AssertionError.class).hasMessageContaining("freigabe_offen"); konflikt++;
                }
            }
            assertThat(erfolg).isEqualTo(1); assertThat(konflikt).isEqualTo(1);
        }
        assertThat(anzahl("bewertung_kriterien_fassung")).isEqualTo(2);
        assertThat(anzahl("bewertung_aenderung")).isEqualTo(2);
    }

    private int anzahl(String t) { return root.queryForObject("SELECT count(*) FROM "+t+" WHERE tenant_id=?",Integer.class,tenant); }
    private JsonNode speichern(Object e) throws Exception { return ruf("PUT",BASE,"IK",e,200); }
    private Map<String,Object> neu() throws Exception {
        var werte = (com.fasterxml.jackson.databind.node.ObjectNode) vorgabe();
        werte.put("K1","5");
        return new LinkedHashMap<>(Map.of("werte",werte,"begruendung","Der 80-%-Block ist nicht belastbar; ab 5 % prüfen."));
    }
    private JsonNode vorgabe() throws Exception {
        return JSON.readTree(java.nio.file.Path.of("../../docs/contracts/v2/bewertung-vectors.json").toFile()).get("startwerte");
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
