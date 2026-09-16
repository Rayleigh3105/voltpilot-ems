package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** B8/F17 über die echten API-Routen, mit unveränderlichen Rohwerten und Periodenversionen. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class AblesungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/messstellen/MS-21/ablesungen";
    private static final String BEGRUENDUNG = "Tippfehler — eine Null fehlte (Montagebericht Oktober)";

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
    @Autowired AblesungService ablesungen;
    @Autowired MessstelleWerteService werte;
    @Autowired AblesungLueckenLauf luecken;
    @org.junit.jupiter.api.BeforeEach
    void uhren() {
        var clock=java.time.Clock.fixed(java.time.Instant.parse("2027-02-10T12:00:00Z"),java.time.ZoneOffset.UTC);
        ablesungen.uhrStellen(clock); werte.uhrStellen(clock);
    }
    private static final String ERSTE="2026-10-01T07:15:00+02:00";
    private static final String ZWEITE="2026-11-02T07:40:00+01:00";

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Wer(String sub, String name, UUID kundenbereich) {}

    private record Welt(UUID mandant, UUID standort, UUID messstelle, Wer ines, Wer jonas) {}

    private record Antwort(int status, JsonNode body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }


    @Test
    void b8UndF17OktoberHat1240NovemberUndTageKeineWerte() throws Exception {
        Welt w=welt();
        ok(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt",ERSTE,"stand","48.211")),200);
        Antwort neu=ok(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt",ZWEITE,"stand","49.451")),200);
        assertThat(neu.body().path("ablesezeitraum").path("menge").decimalValue()).isEqualByComparingTo("1240");
        assertThat(neu.body().path("ablesezeitraum").path("zuordnung").path("vorgabe").asText()).isEqualTo("2026-10");
        assertThat(neu.body().path("ablesezeitraum").path("zuordnung").path("anteile").get(0).path("prozent").decimalValue())
                .isEqualByComparingTo("95.9");
        JsonNode oktober=monat(w,"2026-10-01","2026-10-31",null);
        assertThat(oktober.path("menge").decimalValue()).isEqualByComparingTo("1240");
        assertThat(oktober.path("zustand").asText()).isEqualTo("vollständig");
        assertThat(oktober.path("kennzeichen").get(0).asText()).contains("01.10. 07:15", "02.11. 07:40", "Zuordnung durch den Kunden");
        assertThat(monat(w,"2026-11-01","2026-11-30",null).path("zustand").asText()).isEqualTo("keine Werte");
        Antwort tag=ok(ruf(w.jonas(),HttpMethod.GET,"/api/v1/messstellen/MS-21/werte?raster=tag&von=2026-10-20&bis=2026-10-20",null),200);
        assertThat(tag.body().path("werte").get(0).path("menge").isNull()).isTrue();
        assertThat(tag.body().path("werte").get(0).path("zustand").asText()).isEqualTo("keine Werte");
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_sample WHERE tenant_id=? AND device_id IS NULL "
                + "AND entity_id IS NULL AND woher='eingabe' AND urheber->>'name'='Jonas Wendlinger'",Integer.class,w.mandant())).isEqualTo(2);
    }

    @Test
    void wiederholungKonfliktUndFremderMandantSchreibenNichts() throws Exception {
        Welt w=welt(); anfang(w);
        assertThat(ok(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt",ZWEITE,"stand","49.451")),200)
                .body().path("urteil").asText()).isEqualTo("wiederholung");
        assertThat(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt",ZWEITE,"stand","49.452")).status()).isEqualTo(409);
        UUID fremd=root.queryForObject("INSERT INTO tenant(name) VALUES('Fremd') RETURNING id",UUID.class);
        assertThat(ruf(new Wer("fremd","Fremd",fremd),HttpMethod.POST,PFAD,Map.of("zeitpunkt",ZWEITE,"stand","49.451")).status()).isEqualTo(404);
        assertThat(root.queryForObject("SELECT count(*) FROM device_measurement_sample WHERE tenant_id=?",Integer.class,w.mandant())).isEqualTo(2);
    }

    @Test
    void berichtigungIstFassungUndVersionNieUeberschreiben() throws Exception {
        Welt w=welt(); anfang(w);
        Antwort a=ok(berichtigen(w,Map.of("stand","49.500","begruendung",BEGRUENDUNG)),200);
        assertThat(a.body().path("urteil").asText()).isEqualTo("berichtigung");
        assertThat(monat(w,"2026-10-01","2026-10-31",null).path("menge").decimalValue()).isEqualByComparingTo("1289");
        assertThat(monat(w,"2026-10-01","2026-10-31","1").path("menge").decimalValue()).isEqualByComparingTo("1240");
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_ablesung_fassung WHERE tenant_id=?",Integer.class,w.mandant())).isEqualTo(3);
        assertThatThrownBy(()->root.update("UPDATE device_measurement_sample SET ablesung_stand=0 WHERE tenant_id=?",w.mandant()))
                .hasMessageContaining("nie überschrieben");
        Antwort h=ok(ruf(w.jonas(),HttpMethod.GET,"/api/v1/messstellen/MS-21/werte/versionen?raster=monat&von=2026-10-01&bis=2026-10-31",null),200);
        assertThat(h.body().toString()).contains("1289","1240",BEGRUENDUNG);
    }

    @Test
    void zuordnungBerichtigenErzeugtAuchOhneNeuenStandNeueVersion() throws Exception {
        Welt w=welt(); anfang(w);
        ok(berichtigen(w,Map.of("stand","49.451","zuordnung_monat","2026-11","begruendung",BEGRUENDUNG)),200);
        assertThat(monat(w,"2026-10-01","2026-10-31",null).path("menge").isNull()).isTrue();
        assertThat(monat(w,"2026-10-01","2026-10-31","1").path("menge").decimalValue()).isEqualByComparingTo("1240");
        assertThat(monat(w,"2026-11-01","2026-11-30",null).path("menge").decimalValue()).isEqualByComparingTo("1240");
    }

    @Test
    void vierAugenVorschlagBisZweitePersonFreigibt() throws Exception {
        Welt w=welt(); anfang(w);
        root.update("UPDATE unternehmen SET vieraugen_freigabe=true WHERE tenant_id=?",w.mandant());
        String k=ok(berichtigen(w,Map.of("stand","49.500","begruendung",BEGRUENDUNG)),200).body().path("korrektur").asText();
        assertThat(monat(w,"2026-10-01","2026-10-31",null).path("menge").decimalValue()).isEqualByComparingTo("1240");
        assertThat(ruf(w.jonas(),HttpMethod.POST,"/api/v1/korrekturen/"+k+"/freigeben",Map.of("begruendung",BEGRUENDUNG)).status()).isEqualTo(403);
        ok(ruf(w.ines(),HttpMethod.POST,"/api/v1/korrekturen/"+k+"/freigeben",Map.of("begruendung",BEGRUENDUNG)),200);
        assertThat(monat(w,"2026-10-01","2026-10-31",null).path("menge").decimalValue()).isEqualByComparingTo("1289");
    }

    @Test
    void ohneMonatszuordnungBleibtMonatOhneWert() throws Exception {
        Welt w=welt();
        ok(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt",ERSTE,"stand","48.211")),200);
        Map<String,Object> body=new LinkedHashMap<>(Map.of("zeitpunkt",ZWEITE,"stand","49.451"));body.put("zuordnung_monat",null);
        ok(ruf(w.jonas(),HttpMethod.POST,PFAD,body),200);
        assertThat(monat(w,"2026-10-01","2026-10-31",null).path("menge").isNull()).isTrue();
    }

    @Test
    void ruecksprungFremdeFelderUndZukunftWerdenAbgelehnt() throws Exception {
        Welt w=welt(); anfang(w);
        assertThat(berichtigen(w,Map.of("stand","1","begruendung",BEGRUENDUNG)).status()).isEqualTo(422);
        assertThat(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt",ZWEITE,"stand","49.451","tenant_id",w.mandant())).status()).isEqualTo(400);
        assertThat(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt","2030-01-01T12:00:00Z","stand","50.000")).status()).isEqualTo(422);
        assertThat(berichtigen(w,Map.of("stand","49.500")).status()).isEqualTo(422);
    }

    @Test
    void ueberfaelligeAblesungIstCloudLueckeUndWirdBeiNeuerAblesungGeschlossen() throws Exception {
        Welt w=welt(); anfang(w);
        java.time.Instant grenze=java.time.Instant.parse("2027-01-02T06:40:00Z");
        luecken.lauf(grenze);
        assertThat(lueckenFuer(w)).isZero();
        luecken.lauf(grenze.plusSeconds(1));luecken.lauf(grenze.plusSeconds(2));
        assertThat(lueckenFuer(w)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT urheber FROM messreihe_ereignis WHERE tenant_id=? AND art='data_gap'",String.class,w.mandant())).isEqualTo("cloud");
        ok(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt","2027-01-03T07:40:00+01:00","stand","50.000")),200);
        luecken.lauf(grenze.plusSeconds(172800));
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id=? AND art='data_gap' AND bis IS NOT NULL",Integer.class,w.mandant())).isEqualTo(1);
    }

    @Test
    void zweiZuordnungenSummierenDenMonatOhneTagesverteilung() throws Exception {
        Welt w=welt(); anfang(w);
        ok(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt","2026-11-03T07:40:00+01:00",
                "stand","49.551","zuordnung_monat","2026-10")),200);
        assertThat(monat(w,"2026-10-01","2026-10-31",null).path("menge").decimalValue()).isEqualByComparingTo("1340");
        assertThat(monat(w,"2026-10-01","2026-10-31","1").path("menge").decimalValue()).isEqualByComparingTo("1240");
    }

    @Test
    void ruecknahmeHaengtDritteFassungMitRuecknehmendemAn() throws Exception {
        Welt w=welt(); anfang(w);
        String k=ok(berichtigen(w,Map.of("stand","49.500","begruendung",BEGRUENDUNG)),200)
                .body().path("korrektur").asText();
        ok(ruf(w.ines(),HttpMethod.POST,"/api/v1/korrekturen/"+k+"/zuruecknehmen",
                Map.of("grund","Ablesefoto bestaetigt den urspruenglichen Stand.")),200);
        assertThat(monat(w,"2026-10-01","2026-10-31",null).path("menge").decimalValue()).isEqualByComparingTo("1240");
        assertThat(root.queryForObject("SELECT urheber->>'name' FROM messstelle_ablesung_fassung "
                + "WHERE tenant_id=? AND fassung=3",String.class,w.mandant())).isEqualTo("Ines Kaltenbach");
    }

    @Test
    void rohwertAufbewahrungLoeschtWederHerkunftNochBerichtigbarkeit() throws Exception {
        Welt w=welt(); anfang(w);
        root.update("DELETE FROM device_measurement_sample WHERE tenant_id=?",w.mandant());
        assertThat(ok(ruf(w.jonas(),HttpMethod.GET,PFAD,null),200).body().size()).isEqualTo(2);
        ok(berichtigen(w,Map.of("stand","49.500","begruendung",BEGRUENDUNG)),200);
        assertThat(monat(w,"2026-10-01","2026-10-31",null).path("menge").decimalValue()).isEqualByComparingTo("1289");
    }

    @Test
    void offboardingEntferntRohwerteVorDerGeschuetztenQuelle() throws Exception {
        Welt w=welt(); anfang(w);
        new com.voltpilot.api.repo.TenantRepository(root).offboard(w.mandant());
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_ablesung_fassung WHERE tenant_id=?",
                Integer.class,w.mandant())).isZero();
    }

    private int lueckenFuer(Welt w) { return root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id=? AND art='data_gap'",Integer.class,w.mandant()); }
    private void anfang(Welt w) throws Exception {
        ok(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt",ERSTE,"stand","48.211")),200);
        ok(ruf(w.jonas(),HttpMethod.POST,PFAD,Map.of("zeitpunkt",ZWEITE,"stand","49.451")),200);
    }
    private Antwort berichtigen(Welt w,Map<String,Object> body) throws Exception {
        return ruf(w.jonas(),HttpMethod.POST,PFAD+"/"+ZWEITE+"/berichtigung",body);
    }
    private JsonNode monat(Welt w,String von,String bis,String version) throws Exception {
        return ok(ruf(w.jonas(),HttpMethod.GET,"/api/v1/messstellen/MS-21/werte?raster=monat&von="+von+"&bis="+bis
                +(version==null?"":"&version="+version),null),200).body().path("werte").get(0);
    }
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Bezugswerte #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-21', 'Gas Heizung Verwaltung', 'gemessen', 'Gas', "
                + "'Volumen', 'Bezug', 'm³', 'Zählerstand') RETURNING id", UUID.class, t);
        root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) VALUES(?,?,?,'2026-01-01')",t,ms,st);
        return new Welt(t, st, ms, new Wer("kc-ines-" + t, "Ines Kaltenbach", t),
                new Wer("kc-jonas-" + t, "Jonas Wendlinger", t));
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(String.valueOf(a.body())).isEqualTo(status);
        return a;
    }

    private Antwort ruf(Wer wer, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject(wer.sub());
                    j.claim("preferred_username", wer.name());
                    j.claim("tenant_id", wer.kundenbereich().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
