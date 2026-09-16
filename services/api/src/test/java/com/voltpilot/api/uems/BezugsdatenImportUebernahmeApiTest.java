package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BezugsdatenImportUebernahmeApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");
    private static final String PFAD = "/api/v1/bezugsdaten/importe";
    private static final Instant JETZT = OffsetDateTime.parse("2026-11-03T09:12:00+01:00").toInstant();

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
    @Autowired ImportUebernahmeService uebernahme;
    @Autowired ImportUebernahmeRepository repo;
    @Autowired KorrekturKaskade kaskade;

    @Autowired
    ImportVorschauService service;

    @Autowired
    org.springframework.transaction.PlatformTransactionManager transaktionen;

    @Autowired
    JdbcTemplate app;

    private static JdbcTemplate root;
    private static JsonNode vertrag;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID unternehmen, UUID standort, UUID messstelle) {}

    private record Antwort(int status, String text, JsonNode body) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        vertrag = MAPPER.readTree(VEKTOREN.toFile());
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        service.uhrStellen(Clock.systemUTC());
    }

    // The production DB clock is authoritative: vector amounts with a completed, relative month.
    private final String monat=java.time.YearMonth.now().minusMonths(2).toString();
    private static final String ZUORDNUNG="""
            {"spalten":{"periode":1,"wert":2,"einheit":3},"deutung":"periode",
             "zahlformat":"de","bezugsgroesse":"BZ-1"}
            """;

    @Test void b1b2b3b14UndWiederaufnahme() throws Exception {
        Welt w=welt();
        String datei=csv("312.400,0","kg");
        JsonNode erst=importieren(w,datei,Map.of(),null,null,200);
        String i=erst.path("kennung").asText();
        assertThat(erst.path("aenderungen").asInt()).isOne();
        assertThat(root.queryForObject("SELECT herkunft_art FROM bezugsgroesse_wert WHERE tenant_id=?",String.class,w.mandant())).isEqualTo("import");
        assertThat(root.queryForObject("SELECT text FROM bezugsdaten_import_zeile WHERE tenant_id=?",String.class,w.mandant()))
                .isEqualTo(monat+";312.400,0;kg");
        assertThat(importieren(w,datei,Map.of(),null,null,200).path("aenderungen").asInt()).isZero();
        assertThat(anzahl(w,"bezugsgroesse_wert")).isOne();
        assertThat(anzahl(w,"messreihe_ereignis")).isZero();
        assertThat(importieren(w,csv("312.900,0","kg"),Map.of(),null,null,200).path("aenderungen").asInt()).isZero();
        JsonNode korrektur=importieren(w,csv("312.900,0","kg"),Map.of(2,"ersetzen"),"ERP-Nachbuchung vom fünften November",null,200);
        assertThat(wert(w)).isEqualByComparingTo("312900");
        assertThat(anzahl(w,"messreihe_ereignis")).isOne();
        assertThat(root.queryForObject("SELECT nutzlast->>'import' FROM messreihe_ereignis WHERE tenant_id=?",String.class,w.mandant()))
                .isEqualTo(korrektur.path("kennung").asText());
        ruecknahme(w,korrektur.path("kennung").asText(),200);
        assertThat(wert(w)).isEqualByComparingTo("312400");
        // Do not erase a later correction by withdrawing an earlier import.
        ruecknahme(w,i,409);
        Welt frisch=welt();
        String original=importieren(frisch,datei,Map.of(),null,null,200).path("kennung").asText();
        ruecknahme(frisch,original,200);
        assertThat(wert(frisch)).isNull();
        assertThat(anzahl(frisch,"bezugsgroesse_wert")).isEqualTo(2);
        assertThat(importieren(frisch,datei,Map.of(),null,null,200).path("aenderungen").asInt()).isOne();
        assertThat(wert(frisch)).isEqualByComparingTo("312400");
    }

    @Test void b13BestaetigungUndBefundeBleiben() throws Exception {
        Welt w=welt();
        String datei=csv("312.400,0","kg")+monat+";688.720;lbs\n"+monat+";96;Paletten\n";
        importieren(w,datei,Map.of(),null,null,400);
        assertThat(anzahl(w,"bezugsdaten_import")).isZero();
        JsonNode r=importieren(w,datei,Map.of(),null,"1 von 3 Zeilen übernehmen",200);
        assertThat(r.path("status").asText()).isEqualTo("teilweise_uebernommen");
        assertThat(anzahl(w,"bezugsgroesse_wert")).isOne();
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsdaten_import_zeile WHERE tenant_id=? AND urteil='abgelehnt'",Integer.class,w.mandant())).isEqualTo(2);
        JsonNode liste=antwort(mvc.perform(get(PFAD).with(person(w,"ines"))).andReturn(),200);
        assertThat(liste.at("/importe/0/kennung").asText()).isEqualTo(r.path("kennung").asText());
        JsonNode detail=antwort(mvc.perform(get(PFAD+"/"+r.path("kennung").asText()).with(person(w,"ines"))).andReturn(),200);
        assertThat(detail.path("zeilen").size()).isEqualTo(3);
        assertThat(detail.at("/zeilen/1/befunde/0/satz").asText())
                .isEqualTo(vertrag.at("/befund_saetze/einheit_unbekannt").asText());
    }

    @Test void vierAugenFuerBerichtigungUndRuecknahme() throws Exception {
        Welt w=welt();
        importieren(w,csv("312.400,0","kg"),Map.of(),null,null,200);
        root.update("UPDATE unternehmen SET vieraugen_freigabe=true WHERE tenant_id=?",w.mandant());
        JsonNode r=importieren(w,csv("312.900,0","kg"),Map.of(2,"ersetzen"),"ERP-Nachbuchung begründet",null,200);
        String i=r.path("kennung").asText();
        assertThat(r.path("vorschlaege").asInt()).isOne();
        assertThat(wert(w)).isEqualByComparingTo("312400");
        assertThat(anzahl(w,"messreihe_ereignis")).isZero();
        freigeben(w,i,"ines",403);
        freigeben(w,i,"jonas",200);
        assertThat(wert(w)).isEqualByComparingTo("312900");
        JsonNode rueck=ruecknahme(w,i,200);
        assertThat(rueck.path("status").asText()).isEqualTo("uebernommen");
        assertThat(rueck.path("vorschlaege").asInt()).isOne();
        assertThat(wert(w)).isEqualByComparingTo("312900");
        freigeben(w,i,"ines",403);
        freigeben(w,i,"jonas",200);
        assertThat(wert(w)).isEqualByComparingTo("312400");
    }

    @Test void transaktionsabbruchNachErsterZeileSchreibtNichts() throws Exception {
        Welt w=welt();
        root.execute("CREATE OR REPLACE FUNCTION ip13_test_abbruch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.betrag=999 THEN RAISE EXCEPTION 'IP13 Abbruch nach erster Zeile'; END IF; RETURN NEW; END $$");
        root.execute("CREATE TRIGGER ip13_test_abbruch BEFORE INSERT ON bezugsgroesse_wert FOR EACH ROW EXECUTE FUNCTION ip13_test_abbruch()");
        try {
            String datei=csv("312.400,0","kg")+java.time.YearMonth.now().minusMonths(1)+";999;kg\n";
            assertThatThrownBy(() -> importieren(w,datei,Map.of(),null,null,200)).hasStackTraceContaining("IP13 Abbruch nach erster Zeile");
            assertThat(anzahl(w,"bezugsgroesse_wert")).isZero();
            assertThat(anzahl(w,"bezugsdaten_import")).isZero();
            assertThat(anzahl(w,"bezugsdaten_import_zeile")).isZero();
            assertThat(anzahl(w,"messreihe_ereignis")).isZero();
        } finally { root.execute("DROP TRIGGER ip13_test_abbruch ON bezugsgroesse_wert"); }
    }

    @Test void fremderImportIst404UndEineVeralteteVorschauSchreibtNichts() throws Exception {
        Welt a=welt(),b=welt();
        String datei=csv("312.400,0","kg");
        String v=vorschau(a,datei).at("/vorschau/kennung").asText();
        String i=importieren(a,datei,Map.of(),null,null,200).path("kennung").asText();
        ruecknahme(b,i,404);
        antwort(mvc.perform(get(PFAD+"/"+i).with(person(b,"ines"))).andReturn(),404);
        antwort(mvc.perform(get(PFAD+"/"+i+"/ruecknahme/vorschau").with(person(b,"ines"))).andReturn(),404);
        uebernehmen(a,datei,v,Map.of(),null,null,400);
        assertThat(anzahl(a,"bezugsgroesse_wert")).isOne();
    }

    @Test void b14RuecknahmeVorschauIstDerTatsaechlicheAuftragUndSchreibtNichts() throws Exception {
        Welt w=welt();
        String i=importieren(w,csv("312.400,0","kg"),Map.of(),null,null,200).path("kennung").asText();
        int vorher=anzahl(w,"bezugsgroesse_wert");
        JsonNode v=antwort(mvc.perform(get(PFAD+"/"+i+"/ruecknahme/vorschau").with(person(w,"ines"))).andReturn(),200);
        assertThat(v.path("aenderungen").asInt()).isOne();
        assertThat(v.at("/werte/0/bisheriger_betrag").asText()).isEqualTo("312400.000000");
        assertThat(v.at("/werte/0/neuer_betrag").isNull()).isTrue();
        assertThat(anzahl(w,"bezugsgroesse_wert")).isEqualTo(vorher);
        JsonNode rueck=ruecknahme(w,i,200);
        assertThat(rueck.path("aenderungen").asInt()).isEqualTo(v.path("aenderungen").asInt());
        assertThat(wert(w)).isNull();
    }

    @Test void standWirdNachZeitpunktImportiertUndZurueckgenommen() throws Exception {
        Welt w=welt();
        root.update("UPDATE bezugsgroesse SET wertart='stand',periode_art=NULL WHERE tenant_id=?",w.mandant());
        String datei="Periode;Menge;Einheit\n2025-08-01T12:07:00+02:00;100;kg\n";
        String i=importieren(w,datei,Map.of(),null,null,200).path("kennung").asText();
        assertThat(importieren(w,datei,Map.of(),null,null,200).path("aenderungen").asInt()).isZero();
        ruecknahme(w,i,200);
        assertThat(wert(w)).isNull();
        assertThat(root.<Instant>queryForObject("SELECT von FROM messreihe_ereignis WHERE tenant_id=?",(r,n) -> r.getTimestamp(1).toInstant(),w.mandant()))
                .isEqualTo(Instant.parse("2025-08-01T10:00:00Z"));
        assertThat(root.<Instant>queryForObject("SELECT bis FROM messreihe_ereignis WHERE tenant_id=?",(r,n) -> r.getTimestamp(1).toInstant(),w.mandant()))
                .isEqualTo(Instant.parse("2025-08-01T10:15:00Z"));
    }

    @Test void zweiBerichtigteZeilenHabenUnterschiedlicheKaskadenAnlaesse() throws Exception {
        Welt w=welt();
        String zweiter=java.time.YearMonth.now().minusMonths(1).toString();
        importieren(w,csv("100","kg")+zweiter+";200;kg\n",Map.of(),null,null,200);
        importieren(w,csv("110","kg")+zweiter+";210;kg\n",Map.of(2,"ersetzen",3,"ersetzen"),"ERP-Nachbuchung für beide Monate",null,200);
        assertThat(root.queryForObject("SELECT count(DISTINCT nutzlast->>'korrektur') FROM messreihe_ereignis WHERE tenant_id=?",Integer.class,w.mandant())).isEqualTo(2);
        // The persisted cascade checkpoint must accept both identities independently.
        var anlaesse=root.queryForList("SELECT nutzlast->>'korrektur' FROM messreihe_ereignis WHERE tenant_id=?",String.class,w.mandant());
        assertThat(anlaesse).allMatch(a -> a.matches("I-[0-9]{4}-[0-9]{4,}/Zeile-[23]/Fassung-2"));
        assertThat(kaskade.lauf(Instant.now()).abgelehnt()).isEmpty();
        assertThat(anzahl(w,"messreihe_kaskade_wirkung")).isEqualTo(2);
        kaskade.lauf(Instant.now().plusSeconds(300));
        assertThat(anzahl(w,"messreihe_kaskade_wirkung")).isEqualTo(2);
    }

    @Test void importFreigabeJournalIstAppendOnlyUndMandantengebunden() throws Exception {
        Welt w=welt(),fremd=welt();
        String i=importieren(w,csv("10","kg"),Map.of(),null,null,200).path("kennung").asText();
        root.update("UPDATE unternehmen SET vieraugen_freigabe=true WHERE tenant_id=?",w.mandant());
        ruecknahme(w,i,200);
        TenantContext.set(fremd.mandant());
        assertThat(repo.freigabe(i)).isNull();
        TenantContext.set(w.mandant());
        assertThatThrownBy(() -> app.update("DELETE FROM bezugsdaten_import_freigabe WHERE kennung=?",i)).isInstanceOf(org.springframework.dao.DataAccessException.class);
        assertThatThrownBy(() -> root.update("UPDATE bezugsdaten_import_freigabe SET grund='anderer Grund lang' WHERE tenant_id=?",w.mandant())).isInstanceOf(org.springframework.dao.DataAccessException.class);
        assertThatThrownBy(() -> root.update("INSERT INTO bezugsdaten_import_freigabe (tenant_id,kennung,fassung,status,grund,ruecknahme,auftrag,actor_sub,actor_name,actor_rolle,actor_art) "
                + "SELECT tenant_id,kennung,2,'freigegeben',grund,ruecknahme,auftrag,actor_sub,actor_name,actor_rolle,actor_art "
                + "FROM bezugsdaten_import_freigabe WHERE tenant_id=? AND fassung=1",w.mandant()))
                .isInstanceOf(org.springframework.dao.DataAccessException.class);
        assertThat(repo.freigabe(i).status()).isEqualTo("vorschlag");
    }

    @Test void importBehaeltDieVerwendeteVorlagenFassung() throws Exception {
        Welt w=welt();
        var anfrage=MAPPER.createObjectNode().put("name","ERP-Export Spritzguss");
        anfrage.set("zuordnung",MAPPER.readTree(ZUORDNUNG));
        var vorlage=antwort(mvc.perform(post("/api/v1/bezugsdaten/vorlagen").contentType("application/json")
                .content(anfrage.toString()).with(person(w,"ines"))).andReturn(),201);
        String id=vorlage.path("vorlage_id").asText();
        byte[] datei=csv("312.400,0","kg").getBytes(StandardCharsets.UTF_8);
        var v=antwort(mvc.perform(multipart(PFAD+"/vorschau")
                .file(new MockMultipartFile("datei","ERP.csv","text/csv",datei))
                .file(new MockMultipartFile("vorlage_id","","text/plain",id.getBytes(StandardCharsets.UTF_8)))
                .with(person(w,"ines"))).andReturn(),200);
        var bestaetigung=MAPPER.createObjectNode().put("vorschau",v.at("/vorschau/kennung").asText());
        var i=antwort(mvc.perform(multipart(PFAD)
                .file(new MockMultipartFile("datei","ERP.csv","text/csv",datei))
                .file(new MockMultipartFile("vorlage_id","","text/plain",id.getBytes(StandardCharsets.UTF_8)))
                .file(new MockMultipartFile("bestaetigung","","application/json",bestaetigung.toString().getBytes(StandardCharsets.UTF_8)))
                .with(person(w,"ines"))).andReturn(),200);
        assertThat(i.at("/vorlage/vorlage_id").asText()).isEqualTo(id);
        assertThat(i.at("/vorlage/fassung").asInt()).isOne();
        assertThat(wert(w)).isEqualByComparingTo("312400");
        assertThat(root.queryForObject("SELECT vorlage_fassung FROM bezugsdaten_import WHERE tenant_id=?",Integer.class,w.mandant())).isOne();
        anfrage.put("vorlage_id",id).put("name","ERP-Export geändert");
        antwort(mvc.perform(post("/api/v1/bezugsdaten/vorlagen").contentType("application/json")
                .content(anfrage.toString()).with(person(w,"ines"))).andReturn(),201);
        var status=antwort(mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get(PFAD+"/"+i.path("kennung").asText())
                .with(person(w,"ines"))).andReturn(),200);
        assertThat(status.at("/vorlage/fassung").asInt()).isOne();
        assertThat(status.at("/vorlage/name").asText()).isEqualTo("ERP-Export Spritzguss");
    }

    @Test void kanalbindungSperrtAuchDieCsvUebernahmeMitBenanntemGrund() throws Exception {
        Welt w=welt();
        UUID b=root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id=?",UUID.class,w.mandant());
        UUID site=root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,'Werk') RETURNING id",UUID.class,w.mandant());
        UUID entity=root.queryForObject("INSERT INTO measurement_point(tenant_id,site_id,role,label) VALUES (?,?,'grid-meter','Produktionszähler') RETURNING id",UUID.class,w.mandant(),site);
        Instant von=java.time.YearMonth.parse(monat).atDay(1).atStartOfDay(java.time.ZoneId.of("Europe/Berlin")).toInstant();
        root.update("INSERT INTO bezugsgroesse_kanalbindung (tenant_id,bezugsgroesse_id,entity_id,kanal,wertart,einheit,kadenz_s,von,actor_name,actor_art) VALUES (?,?,?,'produktion_kg','counter','kg',60,?,'Test','voltpilot')",w.mandant(),b,entity,java.sql.Timestamp.from(von));
        JsonNode antwort=importieren(w,csv("312.400,0","kg"),Map.of(),null,null,422);
        assertThat(antwort.path("code").asText()).isEqualTo("kanal_gebunden");
        assertThat(anzahl(w,"bezugsgroesse_wert")).isZero();
        assertThat(anzahl(w,"bezugsdaten_import")).isZero();
    }

    private String csv(String betrag,String einheit) { return "Periode;Menge;Einheit\n"+monat+";"+betrag+";"+einheit+"\n"; }
    private Welt welt() {
        UUID t=root.queryForObject("INSERT INTO tenant(name) VALUES ('IP13') RETURNING id",UUID.class);
        UUID u=root.queryForObject("INSERT INTO unternehmen(tenant_id,name,zeitzone) VALUES (?,'Ahrenberg','Europe/Berlin') RETURNING id",UUID.class,t);
        UUID st=root.queryForObject("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) VALUES (?,?,'Werk','ST-1','Europe/Berlin','aktiv') RETURNING id",UUID.class,t,u);
        root.update("INSERT INTO bezugsgroesse(tenant_id,kennzeichen,name,wertart,einheit,periode_art,geltung_art,standort_id) VALUES (?,'BZ-1','Produktion','periodenwert','kg','monat','standort',?)",t,st);
        return new Welt(t,u,st,null);
    }
    private int anzahl(Welt w,String t) { return root.queryForObject("SELECT count(*) FROM "+t+" WHERE tenant_id=?",Integer.class,w.mandant()); }
    private BigDecimal wert(Welt w) { return root.queryForObject("SELECT betrag FROM bezugsgroesse_wert WHERE tenant_id=? ORDER BY fassung DESC LIMIT 1",BigDecimal.class,w.mandant()); }
    private org.springframework.test.web.servlet.request.RequestPostProcessor person(Welt w,String name) {
        return jwt().jwt(j -> j.subject(name).claim("preferred_username",name).claim("tenant_id",w.mandant().toString()));
    }
    private JsonNode vorschau(Welt w,String datei) throws Exception {
        return antwort(mvc.perform(multipart(PFAD+"/vorschau")
                .file(new MockMultipartFile("datei","ERP.csv","text/csv",datei.getBytes(StandardCharsets.UTF_8)))
                .file(new MockMultipartFile("zuordnung","","application/json",ZUORDNUNG.getBytes(StandardCharsets.UTF_8)))
                .with(person(w,"ines"))).andReturn(),200);
    }
    private JsonNode importieren(Welt w,String datei,Map<Integer,String> entscheidungen,String grund,String teil,int status) throws Exception {
        return uebernehmen(w,datei,vorschau(w,datei).at("/vorschau/kennung").asText(),entscheidungen,grund,teil,status);
    }
    private JsonNode uebernehmen(Welt w,String datei,String v,Map<Integer,String> entscheidungen,String grund,String teil,int status) throws Exception {
        var b=MAPPER.createObjectNode().put("vorschau",v);
        b.set("entscheidungen",MAPPER.valueToTree(entscheidungen)); b.put("begruendung",grund); b.put("teiluebernahme",teil);
        return antwort(mvc.perform(multipart(PFAD)
                .file(new MockMultipartFile("datei","ERP.csv","text/csv",datei.getBytes(StandardCharsets.UTF_8)))
                .file(new MockMultipartFile("zuordnung","","application/json",ZUORDNUNG.getBytes(StandardCharsets.UTF_8)))
                .file(new MockMultipartFile("bestaetigung","","application/json",b.toString().getBytes(StandardCharsets.UTF_8)))
                .with(person(w,"ines"))).andReturn(),status);
    }
    private JsonNode ruecknahme(Welt w,String i,int status) throws Exception {
        return antwort(mvc.perform(post(PFAD+"/"+i+"/ruecknahme").contentType("application/json")
                .content("{\"begruendung\":\"Falsche Artikelgruppe exportiert\"}").with(person(w,"ines"))).andReturn(),status);
    }
    private void freigeben(Welt w,String i,String wer,int status) throws Exception {
        antwort(mvc.perform(post(PFAD+"/"+i+"/freigeben").contentType("application/json")
                .content("{\"begruendung\":\"Beleg nochmals geprüft\"}").with(person(w,wer))).andReturn(),status);
    }
    private JsonNode antwort(MvcResult r,int status) throws Exception {
        String text=r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getStatus()).as(text).isEqualTo(status);
        return text.isBlank() ? NullNode.getInstance() : MAPPER.readTree(text);
    }
}
