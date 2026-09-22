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
import java.time.*;
import java.sql.Timestamp;
import java.math.BigDecimal;
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

/** IP-17: echte Routen, Zustand/Zähler, Fassungen und Bestandsschutz. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KanalbindungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/bezugsgroessen";
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


    @Autowired KanalbindungService bindungen;
    @org.springframework.boot.test.mock.mockito.SpyBean
    com.voltpilot.api.zugriff.Geltungsbereich geltung;
    @Autowired com.voltpilot.api.repo.TenantRepository tenants;
    private static final String KANAL="deye.hybrid_1p.battery.battery-state";
    private static final Instant TAG=Instant.parse("2025-12-01T23:00:00Z");
    private static final Instant ENDE=TAG.plusSeconds(86400);
    private record Reihe(Welt welt,UUID bezug,UUID entity,UUID box,UUID site,String kanal,String art) {}

    @Test
    void b7DurchDenJobHatDauerAbdeckungUndHerkunftUndBleibtWiederholbar() throws Exception {
        Reihe r=reihe("state","h",KANAL);
        roh(r,TAG,"Available",null,TAG.plusSeconds(1));
        roh(r,TAG.plusSeconds(7*3600+12*60),"Charging",null,TAG.plusSeconds(7*3600+12*60+1));
        roh(r,TAG.plusSeconds(9*3600+40*60),"Finishing",null,TAG.plusSeconds(9*3600+40*60+1));
        roh(r,TAG.plusSeconds(13*3600+5*60),"Charging",null,TAG.plusSeconds(13*3600+5*60+1));
        roh(r,TAG.plusSeconds(15*3600+35*60),"Available",null,TAG.plusSeconds(15*3600+35*60+1));
        luecke(r,TAG.plusSeconds(10*3600),TAG.plusSeconds(11*3600));
        bindenDirekt(r,"state","Charging");
        KanalbindungLauf lauf=new KanalbindungLauf(laufJdbc(),MAPPER);
        assertThat(lauf.lauf(ENDE.plusSeconds(60),r.welt().mandant())).isEqualTo(1);
        assertThat(lauf.fehlerAnzahl()).isZero();
        var wert=root.queryForMap("SELECT betrag,kanal_herkunft FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",r.bezug());
        assertThat((BigDecimal)wert.get("betrag")).isEqualByComparingTo("4.966700");
        JsonNode herkunft=MAPPER.readTree(wert.get("kanal_herkunft").toString());
        assertThat(herkunft.path("zustand").asText()).isEqualTo("unvollständig");
        assertThat(herkunft.path("abdeckung_prozent").decimalValue()).isEqualByComparingTo("95.8");
        assertThat(lauf.lauf(ENDE.plusSeconds(120),r.welt().mandant())).isZero();
        Antwort lesen=ruf(r.welt().ines(),HttpMethod.GET,PFAD+"/"+r.bezug()+"/werte",null);
        assertThat(lesen.status()).as(lesen.body().toString()).isEqualTo(200);
        assertThat(lesen.body().at("/werte/0/fassungen/0/herkunft/art").asText()).isEqualTo("messkanal");
        assertThat(lesen.body().at("/werte/0/fassungen/0/kanal/abdeckung_prozent").decimalValue()).isEqualByComparingTo("95.8");
    }

    @Test
    void gebundenerZeitraumSperrtEingabeMit422UndBenanntemGrund() throws Exception {
        Reihe r=reihe("state","h",KANAL);
        roh(r,TAG,"Available",null,TAG.plusSeconds(1));
        bindungen.uhrStellen(Clock.fixed(TAG.plusSeconds(30),ZoneOffset.UTC));
        Antwort a=ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",
            Map.of("entity_id",r.entity(),"kanal",KANAL,"zustand","Charging","von",TAG.toString()));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(201);
        Antwort gesperrt=ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/werte",Map.of("periode","2025-12-02","wert","5"));
        assertThat(gesperrt.status()).as(gesperrt.body().toString()).isEqualTo(422);
        assertThat(gesperrt.body().path("code").asText()).isEqualTo("kanal_gebunden");
        assertThat(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/werte",Map.of("periode","2025-12-01","wert","5")).status()).isEqualTo(201);
        Antwort fremd=ruf(welt().ines(),HttpMethod.GET,PFAD+"/"+r.bezug()+"/kanalbindung",null);
        assertThat(fremd.status()).isEqualTo(404);
        Antwort ende=ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung/"+a.body().path("id").asText()+"/beenden",Map.of("bis",ENDE.toString()));
        assertThat(ende.status()).as(ende.body().toString()).isEqualTo(200);
        assertThat(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/werte",Map.of("periode","2025-12-03","wert","5")).status()).isEqualTo(201);
    }

    @Test
    void zaehlerDifferenzVorlaeufigeNachlieferungUndEndgueltigkeit() throws Exception {
        Reihe r=reihe("counter","h","hours_test");
        roh(r,TAG,null,new BigDecimal("100"),TAG.plusSeconds(1));
        roh(r,ENDE.minusSeconds(60),null,new BigDecimal("105"),ENDE.minusSeconds(59));
        bindenDirekt(r,"counter",null);
        KanalbindungLauf lauf=new KanalbindungLauf(laufJdbc(),MAPPER);
        assertThat(lauf.lauf(ENDE.plusSeconds(60),r.welt().mandant())).isEqualTo(1);
        assertThat(lauf.fehlerAnzahl()).isZero();
        assertThat(root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",BigDecimal.class,r.bezug())).isEqualByComparingTo("5");
        roh(r,ENDE,null,new BigDecimal("106"),ENDE.plusSeconds(3600));
        assertThat(lauf.lauf(ENDE.plusSeconds(7200),r.welt().mandant())).isEqualTo(1);
        assertThat(root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE bezugsgroesse_id=? ORDER BY fassung DESC LIMIT 1",BigDecimal.class,r.bezug())).isEqualByComparingTo("6");
        lauf.lauf(ENDE.plus(Duration.ofDays(7)),r.welt().mandant());
        String alt=fingerabdruck(r.bezug());
        roh(r,TAG.plusSeconds(60),null,new BigDecimal("101"),ENDE.plus(Duration.ofDays(8)));
        lauf.lauf(ENDE.plus(Duration.ofDays(8)).plusSeconds(1),r.welt().mandant());
        assertThat(lauf.fehlerAnzahl()).isZero();
        assertThat(fingerabdruck(r.bezug())).isEqualTo(alt);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id=? AND art='late_arrival'",Integer.class,r.welt().mandant())).isEqualTo(1);
    }

    @Test
    void keineWerteBleibenNullUndEinSchreibfehlerRolltNurDenZusatzZurueck() throws Exception {
        Reihe r=reihe("state","h",KANAL);
        bindenDirekt(r,"state","Charging");
        KanalbindungLauf lauf=new KanalbindungLauf(laufJdbc(),MAPPER);
        assertThat(lauf.lauf(ENDE.plusSeconds(60),r.welt().mandant())).isEqualTo(1);
        assertThat(root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",BigDecimal.class,r.bezug())).isNull();
        assertThat(root.queryForObject("SELECT kanal_herkunft->>'zustand' FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",String.class,r.bezug())).isEqualTo("keine Werte");
        root.execute("CREATE FUNCTION test_kanal_fehler() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Testfehler'; END $$");
        root.execute("CREATE TRIGGER test_kanal_fehler BEFORE INSERT ON bezugsgroesse_wert FOR EACH ROW EXECUTE FUNCTION test_kanal_fehler()");
        try {
            long vorher=lauf.fehlerAnzahl();
            lauf.lauf(ENDE.plus(Duration.ofDays(7)),r.welt().mandant());
            assertThat(lauf.fehlerAnzahl()).isGreaterThan(vorher);
            assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",Integer.class,r.bezug())).isEqualTo(1);
        } finally { root.execute("DROP TRIGGER test_kanal_fehler ON bezugsgroesse_wert"); root.execute("DROP FUNCTION test_kanal_fehler()"); }
    }

    @Test
    void ohneKanalbindungSchreibtDerZusatzKeinByte() throws Exception {
        Welt w=welt(); UUID id=bezugsgroesse(w,"BZ-ALT","Bestand","h","standort",w.standort());
        assertThat(ruf(w.ines(),HttpMethod.POST,PFAD+"/"+id+"/werte",Map.of("periode","2025-10","wert","42")).status()).isEqualTo(201);
        String vorher=fingerabdruck(id);
        new KanalbindungLauf(laufJdbc(),MAPPER).lauf(ENDE.plusSeconds(60));
        assertThat(fingerabdruck(id)).isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_kanallauf WHERE tenant_id=?",Integer.class,w.mandant())).isZero();
    }

    @Test
    void migrationErzwingtMandantEinzelquelleUndUnveraenderlicheBindung() throws Exception {
        Reihe r=reihe("state","h",KANAL);
        bindenDirekt(r,"state","Charging");
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='bezugsgroesse_kanalbindung'::regclass",Boolean.class)).isTrue();
        JdbcTemplate ohne=new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),APP_USER,APP_PW));
        assertThat(ohne.queryForObject("SELECT count(*) FROM bezugsgroesse_kanalbindung",Integer.class)).isZero();
        assertThat(root.queryForObject("SELECT has_table_privilege('voltpilot_app','bezugsgroesse_kanalbindung','DELETE')",Boolean.class)).isFalse();
        assertThat(root.queryForObject("SELECT has_column_privilege('voltpilot_app','bezugsgroesse_kanalbindung','von','UPDATE')",Boolean.class)).isFalse();
        assertThatThrownBy(() -> bindenDirekt(r,"state","Charging")).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThatThrownBy(() -> root.update("UPDATE bezugsgroesse_kanalbindung SET kanal='anders' WHERE bezugsgroesse_id=?",r.bezug())).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThatThrownBy(() -> root.update("INSERT INTO bezugsgroesse_wert (tenant_id,bezugsgroesse_id,wertart,einheit,periode_art,periode_von,periode_bis,zeitzone,fassung,vorgang,status,betrag,herkunft_art,actor_name,actor_art) VALUES (?,?,'periodenwert','h','tag','2025-12-02','2025-12-02','Europe/Berlin',1,'erstwert','wirksam',5,'eingabe','Test','voltpilot')",r.welt().mandant(),r.bezug()))
            .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class).hasMessageContaining("kanal_gebunden");
        assertThatThrownBy(() -> root.update("UPDATE bezugsgroesse SET einheit='min' WHERE id=?",r.bezug())).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        Antwort loeschen=ruf(r.welt().ines(),HttpMethod.DELETE,PFAD+"/"+r.bezug(),null);
        assertThat(loeschen.status()).isEqualTo(422);
        assertThat(loeschen.body().path("code").asText()).isEqualTo("kanalbindung_vorhanden");
        tenants.offboard(r.welt().mandant());
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_kanalbindung WHERE tenant_id=?",Integer.class,r.welt().mandant())).isZero();
    }

    @Test
    void wechselInnerhalbDesTagesAddiertBeideBindungsabschnitteGenauEinmal() throws Exception {
        Reihe r=reihe("state","h",KANAL);
        roh(r,TAG,"Charging",null,TAG.plusSeconds(1));
        for (int h:new int[]{0,12}) root.update("INSERT INTO bezugsgroesse_kanalbindung (tenant_id,bezugsgroesse_id,entity_id,kanal,wertart,einheit,zustand,kadenz_s,von,bis,actor_name,actor_art) VALUES (?,?,?,?,'state','h','Charging',60,?,?,'Test','voltpilot')",r.welt().mandant(),r.bezug(),r.entity(),r.kanal(),Timestamp.from(TAG.plusSeconds(h*3600)),Timestamp.from(TAG.plusSeconds((h+12)*3600)));
        KanalbindungLauf lauf=new KanalbindungLauf(laufJdbc(),MAPPER);
        assertThat(lauf.lauf(ENDE.plusSeconds(60),r.welt().mandant())).isEqualTo(1);
        assertThat(lauf.fehlerAnzahl()).isZero();
        assertThat(root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",BigDecimal.class,r.bezug())).isEqualByComparingTo("24");
        assertThat(root.queryForObject("SELECT kanal_herkunft->>'zustand' FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",String.class,r.bezug())).isEqualTo("vollständig");
        assertThat(lauf.lauf(ENDE.plusSeconds(120),r.welt().mandant())).isZero();
    }

    @Test
    void unsichtbarerQuellstandortBleibtAuchBeiEigenerBezugsgröße404() throws Exception {
        Reihe r=reihe("state","h",KANAL);
        roh(r,TAG,"Available",null,TAG.plusSeconds(1));
        bindungen.uhrStellen(Clock.fixed(TAG.plusSeconds(30),ZoneOffset.UTC));
        org.mockito.Mockito.doReturn(false).when(geltung).siteVisible(r.site());
        Antwort a=ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",
            Map.of("entity_id",r.entity(),"kanal",KANAL,"zustand","Charging","von",TAG.toString()));
        assertThat(a.status()).as(a.body().toString()).isEqualTo(404);
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsgroesse_kanalbindung WHERE bezugsgroesse_id=?",Integer.class,r.bezug())).isZero();
    }

    @Test
    void gradtageDurchEchtenJobMitUnvollstaendigemUndFehlendemTag() throws Exception {
        // Annahme: gemessene Außentemperatur 10 °C, vier Stunden fehlen; kein Ahrenberg-Messwert.
        Reihe r=reihe("gauge","Kd","deye.hybrid_1p.battery.battery-temperature");
        root.update("INSERT INTO anlage_standort (tenant_id,site_id,standort_id,gueltig_ab) VALUES (?,?,?,'2025-01-01')",r.welt().mandant(),r.site(),r.welt().standort());
        root.update("UPDATE device_measurement_selection SET cadence_s=3600 WHERE entity_id=?",r.entity());
        for (int h=0;h<24;h++) if(h<10 || h>13) roh(r,TAG.plusSeconds(h*3600),null,new BigDecimal("10"),TAG.plusSeconds(h*3600+1));
        bindungen.uhrStellen(Clock.fixed(ENDE.minusSeconds(60),ZoneOffset.UTC));
        var auswahl=ok(ruf(r.welt().ines(),HttpMethod.GET,PFAD+"/"+r.bezug()+"/kanalbindung/kanaele",null),200).body();
        assertThat(auswahl.get(0).path("wertart").asText()).isEqualTo("gauge");
        var bindung=ok(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",Map.of(
            "entity_id",r.entity(),"kanal",r.kanal(),"von",TAG.toString(),"raumtemperatur",22,"heizgrenze",17)),201).body();
        assertThat(bindung.path("raumtemperatur").asInt()).isEqualTo(22);
        KanalbindungLauf lauf=new KanalbindungLauf(laufJdbc(),MAPPER);
        assertThat(lauf.lauf(ENDE.plusSeconds(60),r.welt().mandant())).isEqualTo(1);
        var wert=ok(ruf(r.welt().ines(),HttpMethod.GET,PFAD+"/"+r.bezug()+"/werte?fassungen=alle",null),200).body().path("werte").get(0);
        assertThat(new BigDecimal(wert.path("wirksamer_betrag").asText())).isEqualByComparingTo("12");
        var quelle=wert.path("fassungen").get(0).path("kanal");
        assertThat(quelle.path("regel").asText()).isEqualTo("Gradtage G22/17");
        assertThat(quelle.path("zustand").asText()).isEqualTo("unvollständig");
        assertThat(quelle.path("abdeckung_prozent").asDouble()).isLessThan(100);
        assertThat(lauf.lauf(ENDE.plusSeconds(60),r.welt().mandant())).isZero();
        lauf.lauf(ENDE.plusSeconds(86460),r.welt().mandant());
        assertThat(root.queryForObject("SELECT kanal_herkunft->>'zustand' FROM bezugsgroesse_wert WHERE bezugsgroesse_id=? AND periode_von='2025-12-03'",String.class,r.bezug())).isEqualTo("keine Werte");
        assertThat(root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE bezugsgroesse_id=? AND periode_von='2025-12-03'",BigDecimal.class,r.bezug())).isNull();
        assertThat(lauf.fehlerAnzahl()).isZero();
        assertThat(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/werte",Map.of("periode","2025-12-02","wert","12")).status()).isEqualTo(422);
    }

    @Test
    void gradtageMonatSummiertTageswerteAberNichtDieFehlendenTage() throws Exception {
        Reihe r=reihe("gauge","Kd","deye.hybrid_1p.battery.battery-temperature");
        root.update("UPDATE bezugsgroesse SET periode_art='monat' WHERE id=?",r.bezug());
        // Annahmen: 14,96 °C -> 5,04 Kd, 15/18 °C -> 0 Kd. Vierter Tag: 14 + 0,01/24 °C.
        // Erst die Periodensumme wird auf die bestehende Speicherung mit sechs Stellen gerundet.
        for(int d=0;d<4;d++) for(int h=0;h<24;h++) {
            Instant t=TAG.plusSeconds(d*86400L+h*3600L);
            roh(r,t,null,new BigDecimal(d==0?"14.96":d==1?"15":d==2?"18":h==0?"14.01":"14"),t.plusSeconds(1));
        }
        root.update("INSERT INTO bezugsgroesse_kanalbindung (tenant_id,bezugsgroesse_id,entity_id,kanal,wertart,einheit,kadenz_s,von,actor_name,actor_art,raumtemperatur,heizgrenze) VALUES (?,?,?,?,'gauge','°C',3600,?,'Test','voltpilot',20,15)",r.welt().mandant(),r.bezug(),r.entity(),r.kanal(),Timestamp.from(TAG));
        KanalbindungLauf lauf=new KanalbindungLauf(laufJdbc(),MAPPER);
        assertThat(lauf.lauf(Instant.parse("2026-01-01T00:00:00Z"),r.welt().mandant())).isEqualTo(1);
        assertThat(root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",BigDecimal.class,r.bezug())).isEqualByComparingTo("11.039583");
        assertThat(lauf.lauf(Instant.parse("2026-01-01T00:00:00Z"),r.welt().mandant())).isZero();
        assertThat(root.queryForObject("SELECT kanal_herkunft->>'zustand' FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",String.class,r.bezug())).isEqualTo("unvollständig");
        assertThat(lauf.fehlerAnzahl()).isZero();
    }

    @Test
    void gradtagePruefenStandortWertartUndGrenzen() throws Exception {
        Reihe r=reihe("gauge","Kd","deye.hybrid_1p.battery.battery-temperature");
        roh(r,TAG,null,new BigDecimal("15"),TAG.plusSeconds(1));
        bindungen.uhrStellen(Clock.fixed(TAG.plusSeconds(30),ZoneOffset.UTC));
        var a=new LinkedHashMap<String,Object>(Map.of("entity_id",r.entity(),"kanal",r.kanal(),"von",TAG.toString()));
        assertThat(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",a).status()).isEqualTo(422);
        root.update("INSERT INTO anlage_standort (tenant_id,site_id,standort_id,gueltig_ab) VALUES (?,?,?,'2025-01-01')",r.welt().mandant(),r.site(),r.welt().standort());
        a.put("raumtemperatur",15);a.put("heizgrenze",20);
        assertThat(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",a).body().path("code").asText()).isEqualTo("grenzen_ungueltig");
        a.remove("raumtemperatur");a.remove("heizgrenze");
        var b=ok(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",a),201).body();
        assertThat(b.path("raumtemperatur").asInt()).isEqualTo(20);
        assertThat(b.path("heizgrenze").asInt()).isEqualTo(15);
    }

    @Autowired KennzahlEingangLeser kennzahlLeser;

    @Test
    void e9FuenfUndZweiKwLiefernVerschiedeneZahlenUndKennzahlenErbenDieAnnahme() throws Exception {
        for (int schwelle : new int[]{5,2}) {
            Reihe r=leistungsReihe();
            for (int i=0;i<96;i++) roh(r,TAG.plusSeconds(i*900),null,
                    BigDecimal.valueOf(new int[]{1000,3000,5000,7000}[i%4]),TAG.plusSeconds(i*900+1));
            bindungen.uhrStellen(Clock.fixed(ENDE.minusSeconds(60),ZoneOffset.UTC));
            JsonNode bindung=ok(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",
                    Map.of("messstelle_id",r.welt().messstelle(),"von",TAG.toString(),"schwelle_kw",schwelle,
                        "begruendung","Annahme aus beobachtetem Maschinenbetrieb")),201).body();
            assertThat(bindung.path("fassung").asInt()).isEqualTo(1);
            assertThat(bindung.path("regel").asText()).isEqualTo("aus Leistung über "+schwelle+" kW (Annahme)");
            assertThat(root.queryForObject("SELECT actor_name FROM bezugsgroesse_kanalbindung WHERE id=?",String.class,UUID.fromString(bindung.path("id").asText())))
                    .isEqualTo("Ines Kaltenbach");
            KanalbindungLauf lauf=new KanalbindungLauf(laufJdbc(),MAPPER);
            assertThat(lauf.lauf(ENDE.plusSeconds(60),r.welt().mandant())).isEqualTo(1);
            assertThat(lauf.fehlerAnzahl()).isZero();
            JsonNode wert=ok(ruf(r.welt().ines(),HttpMethod.GET,PFAD+"/"+r.bezug()+"/werte?fassungen=alle",null),200).body().path("werte").get(0);
            assertThat(new BigDecimal(wert.path("wirksamer_betrag").asText())).isEqualByComparingTo(schwelle==5?"6":"18");
            assertThat(wert.path("fassungen").get(0).path("kennzeichen").toString()).contains("aus Leistung über "+schwelle+" kW (Annahme)");
            TenantContext.set(r.welt().mandant());
            var nenner=kennzahlLeser.lies(new KennzahlService.Aufgeloest("nenner","bezugsgroesse",r.bezug(),"BZ-5","Betriebszeit","h",null,
                    "periodenwert","tag",null,null,null),"tag",LocalDate.parse("2025-12-02"),LocalDate.parse("2025-12-02")).get("2025-12-02").eingang();
            var zaehler=new KennzahlRegeln.Eingang("messstelle","MS-1","Strom",null,null,null,new BigDecimal("36"),"kWh","vollständig",new BigDecimal("100"),true,null,List.of());
            var kennzahl=KennzahlRegeln.wert(new KennzahlRegeln.Antrag("quotient",new KennzahlRegeln.Periode("tag","2025-12-02"),"kWh/h",zaehler,nenner,
                    false,true,List.of(),null,null,null,null,null,List.of(),null,null));
            assertThat(kennzahl.wert()).isEqualByComparingTo(schwelle==5?"6":"2");
            assertThat(kennzahl.kennzeichen()).contains("aus Leistung über "+schwelle+" kW (Annahme)");
            assertThat(KennzahlRegeln.erbe("kennzahl",null,kennzahl.kennzeichen())).contains("aus Leistung über "+schwelle+" kW (Annahme)");
            assertThat(lauf.lauf(ENDE.plusSeconds(60),r.welt().mandant())).isZero();
        }
    }

    @Test
    void e9WechselIstNeueFassungMitGrundUndLueckenWerdenNichtNullStunden() throws Exception {
        Reihe r=leistungsReihe();
        root.update("UPDATE bezugsgroesse SET periode_art='monat' WHERE id=?",r.bezug());
        // Annahme: an den beiden gemessenen Viertelstunden liegen jeweils 3 kW an.
        Instant wechsel=Instant.parse("2025-12-16T11:00:00Z");
        roh(r,TAG,null,new BigDecimal("3000"),TAG.plusSeconds(1));
        roh(r,wechsel,null,new BigDecimal("3000"),wechsel.plusSeconds(1));
        bindungen.uhrStellen(Clock.fixed(wechsel.plusSeconds(30),ZoneOffset.UTC));
        var a=new LinkedHashMap<String,Object>(Map.of("messstelle_id",r.welt().messstelle(),"von",TAG.toString(),"schwelle_kw",5));
        assertThat(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",a).status()).isEqualTo(422);
        a.put("begruendung","Annahme aus beobachtetem Maschinenbetrieb");
        JsonNode erste=ok(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",a),201).body();
        a.put("von",wechsel.toString());a.put("schwelle_kw",2);a.put("begruendung","Standby erneut geprüft und Schwelle angepasst");
        JsonNode zweite=ok(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",a),201).body();
        assertThat(zweite.path("fassung").asInt()).isEqualTo(2);
        assertThat(zweite.path("ersetzt_bindung_id").asText()).isEqualTo(erste.path("id").asText());
        assertThat(root.queryForObject("SELECT schwelle_kw FROM bezugsgroesse_kanalbindung WHERE id=?",BigDecimal.class,UUID.fromString(erste.path("id").asText()))).isEqualByComparingTo("5");
        assertThatThrownBy(()->root.update("UPDATE bezugsgroesse_kanalbindung SET schwelle_kw=1 WHERE id=?",UUID.fromString(erste.path("id").asText())))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        KanalbindungLauf lauf=new KanalbindungLauf(laufJdbc(),MAPPER);
        lauf.lauf(Instant.parse("2026-01-01T00:01:00Z"),r.welt().mandant());
        assertThat(lauf.fehlerAnzahl()).isZero();
        JsonNode wert=ok(ruf(r.welt().ines(),HttpMethod.GET,PFAD+"/"+r.bezug()+"/werte?fassungen=alle",null),200).body().path("werte").get(0);
        assertThat(new BigDecimal(wert.path("wirksamer_betrag").asText())).isEqualByComparingTo("0.25");
        assertThat(wert.path("fassungen").get(0).path("kennzeichen").toString()).contains("aus Leistung über 5 kW (Annahme)","aus Leistung über 2 kW (Annahme)");
        assertThat(wert.path("fassungen").get(0).path("kanal").path("zustand").asText()).isEqualTo("unvollständig");
        TenantContext.set(r.welt().mandant());
        var eingang=new KennzahlService.Aufgeloest("nenner","bezugsgroesse",r.bezug(),"BZ-5","Betriebszeit","h",null,
                "periodenwert","monat",null,null,null);
        var teilweise=kennzahlLeser.lies(eingang,"monat",LocalDate.parse("2025-12-01"),LocalDate.parse("2025-12-31")).get("2025-12").eingang();
        assertThat(teilweise.zustand()).isEqualTo(ErgebnisZustand.UNVOLLSTAENDIG);
        assertThat(teilweise.kennzeichen()).contains("aus Leistung über 5 kW (Annahme)","aus Leistung über 2 kW (Annahme)");
        lauf.lauf(Instant.parse("2026-02-01T00:01:00Z"),r.welt().mandant());
        assertThat(root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE bezugsgroesse_id=? AND periode_von='2026-01-01' ORDER BY fassung DESC LIMIT 1",BigDecimal.class,r.bezug())).isNull();
        TenantContext.set(r.welt().mandant());
        var fehlend=kennzahlLeser.lies(eingang,"monat",LocalDate.parse("2026-01-01"),LocalDate.parse("2026-01-31")).get("2026-01").eingang();
        assertThat(fehlend.wert()).isNull();
        assertThat(fehlend.kennzeichen()).contains("aus Leistung über 2 kW (Annahme)");
        assertThat(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/werte",Map.of("periode","2026-01","wert","0")).status()).isEqualTo(422);
    }

    @Test
    void e9FassungsabschnitteRundenErstNachDerSummeAuchInMinuten() throws Exception {
        for (String einheit : List.of("h","min")) {
            Reihe r=leistungsReihe();
            root.update("UPDATE bezugsgroesse SET einheit=? WHERE id=?",einheit,r.bezug());
            root.update("UPDATE device_measurement_selection SET cadence_s=60 WHERE entity_id=?",r.entity());
            for (int i=0;i<2;i++) roh(r,TAG.plusSeconds(i*60),null,new BigDecimal("3000"),TAG.plusSeconds(i*60+1));
            bindungen.uhrStellen(Clock.fixed(TAG.plusSeconds(90),ZoneOffset.UTC));
            for (int i=0;i<2;i++) ok(ruf(r.welt().ines(),HttpMethod.POST,PFAD+"/"+r.bezug()+"/kanalbindung",
                    Map.of("messstelle_id",r.welt().messstelle(),"von",TAG.plusSeconds(i*60).toString(),"schwelle_kw",2-i,
                        "begruendung","Annahme zum Vergleich der Schwellenfassungen")),201);
            var lauf=new KanalbindungLauf(laufJdbc(),MAPPER);
            lauf.lauf(ENDE.plusSeconds(60),r.welt().mandant());
            assertThat(lauf.fehlerAnzahl()).isZero();
            assertThat(root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE bezugsgroesse_id=?",BigDecimal.class,r.bezug()))
                    .isEqualByComparingTo("min".equals(einheit)?"2":"0.033333");
        }
    }

    private Reihe leistungsReihe() throws Exception {
        Reihe ursprung=reihe("gauge","h","deye.hybrid_1p.battery.battery-power");
        UUID messstelle=root.queryForObject("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) VALUES (?,'MS-15','Maschinenleistung','gemessen','Strom','Wirkleistung','Bezug','kW','Momentanwert') RETURNING id",UUID.class,ursprung.welt().mandant());
        var w=ursprung.welt();
        Reihe r=new Reihe(new Welt(w.mandant(),w.standort(),messstelle,w.ines(),w.jonas()),ursprung.bezug(),ursprung.entity(),ursprung.box(),ursprung.site(),ursprung.kanal(),ursprung.art());
        root.update("UPDATE device_measurement_selection SET cadence_s=900 WHERE entity_id=?",r.entity());
        root.update("INSERT INTO messstelle_stellung(tenant_id,messstelle_id,site_id,stellung,gueltig_ab) VALUES (?,?,?,'keine','2025-01-01')",r.welt().mandant(),r.welt().messstelle(),r.site());
        UUID geraet=root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id=?",UUID.class,r.entity());
        root.update("INSERT INTO messstelle_quelle(tenant_id,messstelle_id,groesse,richtung,entity_id,geraet_id,kanal,kanal_wertart,herleitung,rolle,gueltig_ab,rueckwirkend,eingetragen_am,actor_name,actor_art) VALUES (?,?,'Wirkleistung','Bezug',?,?,?,'gauge','momentanwert','fuehrend',?,false,?,'Test','voltpilot')",
                r.welt().mandant(),r.welt().messstelle(),r.entity(),geraet,r.kanal(),Timestamp.from(TAG),Timestamp.from(TAG));
        root.update("UPDATE bezugsgroesse SET art='betriebszeit_aus_leistung',geltung_art='messstelle',standort_id=NULL,messstelle_id=? WHERE id=?",r.welt().messstelle(),r.bezug());
        return r;
    }

    private String fingerabdruck(UUID id) {
        return root.queryForObject("SELECT string_agg(to_jsonb(w)::text,'|' ORDER BY fassung) FROM bezugsgroesse_wert w WHERE bezugsgroesse_id=?",String.class,id);
    }
    private Reihe reihe(String art,String einheit,String kanal) throws Exception {
        Welt w=welt();UUID b=bezugsgroesse(w,"BZ-5","Ladezeit",einheit,"standort",w.standort());
        root.update("UPDATE bezugsgroesse SET periode_art='tag' WHERE id=?",b);
        UUID site=root.queryForObject("INSERT INTO site (tenant_id,name) VALUES (?,'Halle 2') RETURNING id",UUID.class,w.mandant());
        UUID box=root.queryForObject("INSERT INTO device (tenant_id,site_id,external_ref,status) VALUES (?,?,?,'online') RETURNING id",UUID.class,w.mandant(),site,"test-"+b);
        UUID entity=root.queryForObject("INSERT INTO measurement_point (tenant_id,site_id,role,label,entity_type,device_id,communication,connection_json) VALUES (?,?,'ev-charger','K-9','ev-charger',?,'modbus_tcp','{}') RETURNING id",UUID.class,w.mandant(),site,box);
        root.update("INSERT INTO device_measurement_selection (tenant_id,site_id,device_id,entity_id,point_key,enabled,cadence_s,desired_revision,enabled_at,catalog_version,changed_by,apply_status,retention_class,long_term_strategy) VALUES (?,?,?,?,?,true,60,1,?,'2026.09.16.1','test','pending_edge','live_power','fifteen_minute')",w.mandant(),site,box,entity,kanal,Timestamp.from(TAG));
        return new Reihe(w,b,entity,box,site,kanal,art);
    }
    private void bindenDirekt(Reihe r,String art,String zustand) {
        root.update("INSERT INTO bezugsgroesse_kanalbindung (tenant_id,bezugsgroesse_id,entity_id,kanal,wertart,einheit,zustand,kadenz_s,von,bis,actor_name,actor_art) VALUES (?,?,?,?,?,'h',?,60,?,?,'Test','voltpilot')",r.welt().mandant(),r.bezug(),r.entity(),r.kanal(),art,zustand,Timestamp.from(TAG),Timestamp.from(ENDE));
    }
    private void roh(Reihe r,Instant zeit,String wort,BigDecimal zahl,Instant eingang) {
        root.update("INSERT INTO device_measurement_sample (time,received_at,tenant_id,site_id,device_id,point_key,raw_numeric,raw_text,quality,catalog_version,edge_sequence,aggregation_kind,entity_id,applied_revision,value_kind,role,delivery,delay_s) VALUES (?,?,?,?,?,?,?,?,'good','2026.09.16.1',?,?,?,3,?,'fuehrend','direkt',1)",Timestamp.from(zeit),Timestamp.from(eingang),r.welt().mandant(),r.site(),r.box(),r.kanal(),zahl,wort,zeit.getEpochSecond(),r.art(),r.entity(),r.art());
    }
    private JdbcTemplate laufJdbc() {
        return new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),"voltpilot_admin","voltpilot_admin_dev_pw"));
    }
    private void luecke(Reihe r,Instant von,Instant bis) {
        root.update("INSERT INTO messreihe_ereignis (zeit,tenant_id,ereignis_id,art,urheber,von,bis,device_id,entity_id,messkanal,kennungen,nutzlast,eingang) VALUES (?,?,?,'data_gap','cloud',?,?,?,?,?,?::jsonb,'{\"erkannt_aus\":\"herzschlag\"}',?)",Timestamp.from(von),r.welt().mandant(),UUID.randomUUID(),Timestamp.from(von),Timestamp.from(bis),r.box(),r.entity(),r.kanal(),"{\"box\":\""+r.box()+"\",\"komponente\":\""+r.entity()+"\"}",Timestamp.from(bis.plusSeconds(1)));
    }
    private static Antwort ok(Antwort a,int status) { assertThat(a.status()).as(a.body().toString()).isEqualTo(status); return a; }
    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Bezugswerte #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-14', 'Ladepunkt Halle 2', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t);
        return new Welt(t, st, ms, new Wer("kc-ines-" + t, "Ines Kaltenbach", t),
                new Wer("kc-jonas-" + t, "Jonas Wendlinger", t));
    }

    private UUID bezugsgroesse(Welt w, String kennzeichen, String name, String einheit, String geltungArt, UUID geltung)
            throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("wertart", "periodenwert");
        m.put("einheit", einheit);
        m.put("periode_art", "monat");
        m.put("geltung_art", geltungArt);
        m.put("geltung_id", geltung.toString());
        return UUID.fromString(ok(ruf(w.ines(), HttpMethod.POST, PFAD, m), 201).body().get("id").asText());
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
