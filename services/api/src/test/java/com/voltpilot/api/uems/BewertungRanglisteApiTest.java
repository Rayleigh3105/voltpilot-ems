package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
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

/** R1/R2/R4/R5/R12/R15: Mengen und Urteil über echte Leser, App-Rolle, HTTP und Standort-RLS. */
@Testcontainers(disabledWithoutDocker=true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BewertungRanglisteApiTest {
    private static final String BASE="/api/v1/unternehmen/bewertung/rangliste";
    private static final String ABDECKUNG="/api/v1/unternehmen/bewertung/messabdeckung";
    private static final String OKTOBER="?von=2026-10-01&bis=2026-10-31";
    private static final ObjectMapper JSON=new ObjectMapper();
    @Container static final PostgreSQLContainer<?> POSTGRES=new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url",POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username",()->"voltpilot_app");
        r.add("spring.datasource.password",()->"ip9_app_pw");
        r.add("spring.flyway.url",POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user",POSTGRES::getUsername);
        r.add("spring.flyway.password",POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser",()->"voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword",()->"ip9_app_pw");
        r.add("spring.flyway.placeholders.adminDbPassword",()->"ip9_admin_pw");
        r.add("voltpilot.admin-datasource.password",()->"ip9_admin_pw");
        r.add("voltpilot.security.oidc.enabled",()->"true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",()->"http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",()->"http://127.0.0.1:9/certs");
    }
    @Autowired MockMvc mvc;
    @Autowired AblesungService ablesungen;
    @Autowired MessstelleWerteService werte;
    @Autowired BilanzService bilanz;
    @Autowired BewertungMengenRepository mengen;
    static JdbcTemplate root;
    static JsonNode ref;
    UUID tenant,unternehmen;
    Map<String,UUID> ids;
    @BeforeAll static void start() throws Exception {
        root=new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),POSTGRES.getUsername(),POSTGRES.getPassword()));
        ref=JSON.readTree(Path.of("../../docs/contracts/v2/uems-referenzunternehmen.json").toFile());
    }
    @BeforeEach void welt() throws Exception {
        ids=new HashMap<>();
        var uhr=Clock.fixed(Instant.parse("2026-12-10T12:00:00Z"),ZoneOffset.UTC);
        ablesungen.uhrStellen(uhr); werte.uhrStellen(uhr); bilanz.uhrStellen(uhr);
        tenant=uuid("INSERT INTO tenant(name) VALUES ('Ahrenberg IP-9') RETURNING id");
        unternehmen=uuid("INSERT INTO unternehmen(tenant_id,name) VALUES (?,'Ahrenberg') RETURNING id",tenant);
        for (String s:List.of("ST-1","ST-2")) ids.put(s,uuid("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                +"VALUES (?,?,?,?,'Europe/Berlin','aktiv') RETURNING id",tenant,unternehmen,s,s));
        benutzer("IK","energiemanager",null); benutzer("LE","leser",ids.get("ST-2"));
        benutzer("OHNE","leser",uuid("INSERT INTO standort(tenant_id,unternehmen_id,name,kurzzeichen,zeitzone,zustand) "
                +"VALUES (?,?,'ohne','ST-9','Europe/Berlin','aktiv') RETURNING id",tenant,unternehmen));
        for (var a:ref.path("anlagen")) {
            String k=a.path("kennzeichen").asText();
            ids.put(k,uuid("INSERT INTO site(tenant_id,name) VALUES (?,?) RETURNING id",tenant,k));
            // Der Zugriffs-Zaun ist heute gültig; die fachliche Messstellung von AN-3 beginnt am 15.10.
            root.update("INSERT INTO anlage_standort(tenant_id,site_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                    tenant,ids.get(k),ids.get(a.path("standort").asText()));
        }
        for (int i=1;i<=7;i++) ids.put("P-"+i,uuid("INSERT INTO prozess(tenant_id,unternehmen_id,kennzeichen,name,gueltig_ab) "
                +"VALUES (?,?,?,?,'2024-01-01') RETURNING id",tenant,unternehmen,"P-"+i,"P-"+i));
        for (var m:ref.path("messstellen")) {
            String k=m.path("kennzeichen").asText();
            if (!m.path("art").asText().equals("gemessen")) continue;
            String medium=m.path("medium").asText(),richtung=m.at("/hauptgroesse/richtung").asText();
            ids.put(k,uuid("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) "
                    +"VALUES (?,?,?,'gemessen',?,?,?,?,?) RETURNING id",tenant,k,m.path("name").asText(),medium,
                    medium.equals("Gas")?"Volumen":"Wirkenergie",richtung,medium.equals("Gas")?"m³":"kWh",
                    k.equals("MS-04")?"Intervallmenge":"Zählerstand"));
            String anlage=m.path("elektrische_stellung").isEmpty()?"AN-1":m.at("/elektrische_stellung/0/anlage").asText();
            root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                    tenant,ids.get(k),ids.get(anlage.equals("AN-3")?"ST-2":"ST-1"));
            for (var s:m.path("elektrische_stellung")) {
                if (s.path("gueltig_ab").asText().compareTo("2026-10-31")>0) continue;
                root.update("INSERT INTO messstelle_stellung(tenant_id,messstelle_id,site_id,stellung,unterzaehler_von,gueltig_ab,gueltig_bis) "
                        +"VALUES (?,?,?,?,?,?::date,?::date)",tenant,ids.get(k),ids.get(s.path("anlage").asText()),s.path("stellung").asText(),
                        ids.get(s.path("unterzaehler_von").asText()),s.path("gueltig_ab").asText(),s.path("gueltig_bis").isNull()?null:s.path("gueltig_bis").asText());
            }
            if (k.equals("MS-04")) speicher(m);
            else {
                JsonNode wert=m.at(medium.equals("Gas")?"/beispielwerte/oktober_2026_m3":"/beispielwerte/oktober_2026_kwh");
                if (k.equals("MS-12")) wert=ref.path("abnahmefaelle_ap16").findValues("gegeben").stream()
                        .filter(g -> g.has("stand_2")).findFirst().orElseThrow().at("/korrektur/MS-12_neu");
                if (!wert.isNull() && !wert.isMissingNode()) monat(k,wert.asText());
            }
        }
        for (var e:ref.path("energieeinsaetze")) {
            String k=e.path("kennzeichen").asText();
            var neu=ruf("POST","/api/v1/unternehmen/energieeinsaetze","IK",Map.of("prozess_id",ids.get(e.path("prozess").asText()),
                    "traeger",e.path("traeger").asText(),"name",e.path("name").asText(),"gueltig_ab",e.path("gueltig_ab").asText()),201);
            ids.put(k,UUID.fromString(neu.path("id").asText()));
            for (var m:e.path("messstellen")) root.update("INSERT INTO messstelle_prozess(tenant_id,messstelle_id,prozess_id,gueltig_ab) "
                    +"VALUES (?,?,?,'2024-01-01')",tenant,ids.get(m.asText()),ids.get(e.path("prozess").asText()));
        }
        ruf("PUT","/api/v1/unternehmen/bewertung/umfang","IK",Map.of("gueltig_ab","2024-01-01",
                "standort_ids",List.of(ids.get("ST-1"),ids.get("ST-2")),"traeger",List.of("Strom","Gas"),"ausschluesse",List.of()),200);
    }

    @Test void r1UndR4R5R12AhrenbergOktober() throws Exception {
        var a=ruf("GET",BASE+OKTOBER,"IK",null,200);
        assertThat(a.at("/nenner/wert").asText()).isEqualTo("185380");
        assertThat(a.at("/nenner/anlagen").asText()).isEqualTo("3 von 3");
        assertThat(a.path("zugeordnet").asText()).isEqualTo("125740");
        assertThat(a.path("abdeckung_prozent").asText()).isEqualTo("67.8");
        assertThat(a.path("rest").asText()).isEqualTo("59640");
        assertThat(a.path("monate").asInt()).isEqualTo(1);
        assertThat(a.at("/kriterien/fassung").asInt()).isEqualTo(1);
        assertThat(a.at("/urteil/K7").asText()).isEqualTo("vorlaeufig");
        assertThat(a.at("/urteil/K8").asText()).isEqualTo("unter_schwelle");
        assertThat(a.path("anlagen").findValuesAsText("rest")).containsExactlyInAnyOrder("54580","3860","1200");
        assertThat(einsatz(a,"EE-1").path("menge").asText()).isEqualTo("77500");
        assertThat(einsatz(a,"EE-1").at("/urteil/K1").asText()).isEqualTo("ueber_schwelle");
        assertThat(einsatz(a,"EE-1").at("/urteil/K2").asText()).isEqualTo("nicht_belastbar");
        assertThat(einsatz(a,"EE-1").at("/urteil/K3").asText()).isEqualTo("nicht_anwendbar");
        assertThat(einsatz(a,"EE-1").at("/urteil/K5").asText()).isEqualTo("erfuellt");
        assertThat(einsatz(a,"EE-1").at("/urteil/K6").asText()).isEqualTo("erfuellt");
        assertThat(einsatz(a,"EE-1").path("datenlage_prozent").asText()).isEqualTo("100.0");
        assertThat(einsatz(a,"EE-1").path("vorschlag").asText()).isEqualTo("ueber_schwelle");
        assertThat(einsatz(a,"EE-1").at("/herkunft/kriterien_fassung").asInt()).isEqualTo(1);
        assertThat(einsatz(a,"EE-1").at("/herkunft/eingaenge").findValuesAsText("version")).containsOnly("1");
        assertThat(einsatz(a,"EE-1").at("/herkunft/nenner/bilanzwerte").size()).isEqualTo(3);
        assertThat(einsatz(a,"EE-1").at("/herkunft/nenner/bilanzwerte").findValuesAsText("version")).containsOnly("1");
        assertThat(einsatz(a,"EE-3").path("menge").asText()).isEqualTo("15900");
        assertThat(einsatz(a,"EE-8").path("menge").isNull()).isTrue();
        assertThat(einsatz(a,"EE-8").path("zustand").asText()).isEqualTo("keine Werte");
        var gas=a.path("weitere_traeger").get(0);
        assertThat(gas.path("menge").asText()).isEqualTo("1240");
        assertThat(gas.path("einheit").asText()).isEqualTo("m³");
        assertThat(gas.path("anteil_prozent").isNull()).isTrue();
        assertThat(gas.path("anteil_zustand").asText()).isEqualTo("ohne Anteil");
        assertThat(gas.at("/urteil/K1").asText()).isEqualTo("nicht_anwendbar");
        assertThat(gas.at("/herkunft/nenner").isNull()).isTrue();
        assertThat(a.toString()).doesNotContain("\"einstufung\"");
        assertThat(a.path("anlagen").findValuesAsText("ab")).contains("2026-10-15");
        // N1 ist dieselbe Zahl in der bestehenden Bilanz: Speicher getrennt aus der Verdichtung.
        var b=ruf("GET","/api/v1/sites/"+ids.get("AN-1")+"/bilanz?periode=monat&am=2026-10-01","IK",null,200);
        assertThat(b.at("/hauptzaehler/0/abschnitte/0/werte/0/rest/menge").decimalValue()).isEqualByComparingTo("54580");
    }
    @Test void r15KriterienFassungZweiAendertDasUrteilAberStuftenNichtEin() throws Exception {
        var werte=(com.fasterxml.jackson.databind.node.ObjectNode)JSON.readTree(
                Path.of("../../docs/contracts/v2/bewertung-vectors.json").toFile()).path("startwerte").deepCopy();
        werte.put("K1","5");
        ruf("PUT","/api/v1/unternehmen/bewertung/kriterien","IK",Map.of("werte",werte,"begruendung","Montage beobachten"),200);
        var a=ruf("GET",BASE+OKTOBER,"IK",null,200);
        assertThat(a.at("/kriterien/fassung").asInt()).isEqualTo(2);
        assertThat(a.at("/kriterien/werte/K1").asText()).isEqualTo("5");
        assertThat(einsatz(a,"EE-2").path("anteil_prozent").asText()).isEqualTo("5.2");
        assertThat(einsatz(a,"EE-2").at("/urteil/K1").asText()).isEqualTo("ueber_schwelle");
        assertThat(einsatz(a,"EE-2").path("vorschlag").asText()).isEqualTo("ueber_schwelle");
        assertThat(a.toString()).doesNotContain("\"einstufung\"");
    }
    @Test void p3MessabdeckungAhrenbergOktoberJeEinsatzUndOrt() throws Exception {
        var bedarf = ruf("POST", "/api/v1/unternehmen/energieeinsaetze/" + ids.get("EE-8") + "/messbedarf",
                "IK", Map.of("wortlaut", "Strommenge der Nebenaggregate", "ort", "Halle 1"), 201);
        assertThat(bedarf.path("kennzeichen").asText()).isEqualTo("MB-1");
        var a=ruf("GET",ABDECKUNG+OKTOBER,"IK",null,200);
        assertThat(a.at("/summe/nenner/wert").asText()).isEqualTo("185380");
        assertThat(a.at("/summe/nenner/anlagen").asText()).isEqualTo("3 von 3");
        assertThat(a.at("/summe/gemessen_zugeordnet").asText()).isEqualTo("125740");
        assertThat(a.at("/summe/abdeckung_prozent").asText()).isEqualTo("67.8");
        assertThat(a.at("/summe/k8").asText()).isEqualTo("unter_schwelle");
        assertThat(a.at("/summe/ersatz").asText()).isEqualTo("0");
        assertThat(a.at("/summe/ungemessen").asText()).isEqualTo("59640");
        assertThat(a.at("/summe/ungemessen_prozent").asText()).isEqualTo("32.2");

        assertThat(a.path("je_einsatz").findValuesAsText("kennzeichen"))
                .contains("EE-1","EE-2","EE-3","EE-4","EE-5","EE-6","EE-7","EE-8");
        assertThat(einsatzAbdeckung(a,"EE-1").path("gemessen").findValuesAsText("menge"))
                .containsExactly("55100","22400");
        assertThat(einsatzAbdeckung(a,"EE-2").path("gemessen").findValuesAsText("menge"))
                .containsExactly("6040","3600");
        assertThat(einsatzAbdeckung(a,"EE-3").path("gemessen").findValuesAsText("menge")).containsExactly("15900");
        assertThat(einsatzAbdeckung(a,"EE-4").path("gemessen").findValuesAsText("menge")).containsExactly("6200");
        assertThat(einsatzAbdeckung(a,"EE-5").path("gemessen").findValuesAsText("menge"))
                .containsExactly("3500","4300");
        assertThat(einsatzAbdeckung(a,"EE-6").path("gemessen").findValuesAsText("menge"))
                .containsExactly("7600","1100");
        assertThat(einsatzAbdeckung(a,"EE-7").path("gemessen").findValuesAsText("menge")).containsExactly("1240");
        assertThat(einsatzAbdeckung(a,"EE-8").path("menge").isNull()).isTrue();
        assertThat(einsatzAbdeckung(a,"EE-8").at("/geplant/0/kennzeichen").asText()).isEqualTo("MS-23");
        assertThat(einsatzAbdeckung(a,"EE-8").path("geplant").get(0).has("menge")).isFalse();
        assertThat(einsatzAbdeckung(a,"EE-8").at("/geplant/1/messbedarf").asText()).isEqualTo("MB-1");
        assertThat(einsatzAbdeckung(a,"EE-8").path("geplant").get(1).has("menge")).isFalse();
        assertThat(a.path("je_ort")).hasSize(5);
        assertThat(ortAbdeckung(a,"AN-1","Strom").path("gemessen").findValuesAsText("menge"))
                .containsExactly("7600","55100","15900","6200");
        assertThat(ortAbdeckung(a,"AN-1","Strom").at("/ungemessen/menge").asText()).isEqualTo("54580");
        assertThat(ortAbdeckung(a,"AN-2","Strom").path("gemessen").findValuesAsText("menge"))
                .containsExactly("22400","6040","3500","1100");
        assertThat(ortAbdeckung(a,"AN-2","Strom").at("/ungemessen/menge").asText()).isEqualTo("3860");
        assertThat(ortAbdeckung(a,"AN-3","Strom").path("gemessen").findValuesAsText("menge"))
                .containsExactly("4300","3600");
        assertThat(ortAbdeckung(a,"AN-3","Strom").at("/ungemessen/menge").asText()).isEqualTo("1200");
        assertThat(ortAbdeckung(a,"ST-1 ST-1","Gas").path("gemessen").findValuesAsText("menge"))
                .containsExactly("1240");
        assertThat(a.path("je_ort").findValuesAsText("kennzeichen")).contains("MS-23");
        assertThat(a.toString()).doesNotContain("MS-09","MS-15","MS-22","automatisch eingestuft","ISO-wesentlich");
    }

    @Test void p3K8KommtAusDerWirksamenKriterienFassung() throws Exception {
        var werte=new HashMap<String,Object>();
        werte.put("K1","10"); werte.put("K2","80"); werte.put("K3","100000");
        werte.put("K5","90"); werte.put("K6","5"); werte.put("K7",12);
        werte.put("K8","60"); werte.put("mindest_monate",3);
        ruf("PUT","/api/v1/unternehmen/bewertung/kriterien","IK",
                Map.of("werte",werte,"begruendung","Eigene Abdeckungsschwelle"),200);
        assertThat(ruf("GET",ABDECKUNG+OKTOBER,"IK",null,200).at("/summe/k8").asText())
                .isEqualTo("ueber_schwelle");
    }

    @Test void p3TeilansichtUndW8ArchiviertOderBerechnetNieGemessen() throws Exception {
        UUID berechnet=uuid("INSERT INTO messstelle(tenant_id,kennzeichen,name,art,medium,groesse,richtung,einheit,wertart) "
                +"VALUES (?,'MS-X','Summe','berechnet','Strom','Wirkenergie','Bezug','kWh','Intervallmenge') RETURNING id",tenant);
        root.update("INSERT INTO messstelle_prozess(tenant_id,messstelle_id,prozess_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant,berechnet,ids.get("P-1"));
        root.update("INSERT INTO messstelle_ort(tenant_id,messstelle_id,standort_id,gueltig_ab) VALUES (?,?,?,'2024-01-01')",
                tenant,berechnet,ids.get("ST-1"));
        root.update("UPDATE messstelle SET archiviert_am=now() WHERE id=?",ids.get("MS-06"));
        var ganz=ruf("GET",ABDECKUNG+OKTOBER,"IK",null,200);
        assertThat(einsatzAbdeckung(ganz,"EE-1").path("gemessen").findValuesAsText("kennzeichen"))
                .containsExactly("MS-11").doesNotContain("MS-06","MS-X");
        assertThat(ruf("GET",BASE+OKTOBER,"LE",null,200).path("einsaetze").findValuesAsText("kennzeichen"))
                .doesNotContain("EE-1");
        assertThat(ruf("GET","/api/v1/unternehmen/energieeinsaetze","LE",null,200)
                .path("energieeinsaetze").findValuesAsText("kennzeichen")).doesNotContain("EE-1");
        var teil=ruf("GET",ABDECKUNG+OKTOBER,"LE",null,200);
        assertThat(teil.path("teilansicht").asBoolean()).isTrue();
        assertThat(teil.at("/summe/nenner/wert").asText()).isEqualTo("9100");
        assertThat(teil.at("/summe/ungemessen").asText()).isEqualTo("1200");
        assertThat(teil.path("je_einsatz").findValuesAsText("kennzeichen"))
                .contains("EE-2","EE-5").doesNotContain("EE-1","EE-3","MS-12","MS-13");
        assertThat(teil.toString()).doesNotContain(ids.get("AN-1").toString(),ids.get("MS-06").toString());
        ruf("GET",ABDECKUNG+OKTOBER,"OHNE",null,404);
    }
    @Test void ohneHauptzaehlerBleibtDerNennerUnvollstaendig() throws Exception {
        root.update("UPDATE messstelle_stellung SET aufgehoben_am=now() WHERE messstelle_id=?",ids.get("MS-16"));
        var a=ruf("GET",BASE+OKTOBER,"IK",null,200);
        assertThat(a.at("/nenner/wert").isNull()).isTrue();
        assertThat(a.at("/nenner/anlagen").asText()).isEqualTo("2 von 3");
        assertThat(a.at("/nenner/zustand").asText()).isEqualTo("unvollständig");
        for (var e:a.path("einsaetze")) {
            assertThat(e.path("anteil_prozent").isNull()).isTrue();
            assertThat(e.path("anteil_zustand").asText()).isEqualTo("unvollständig");
        }
        assertThat(a.path("anlagen").findValuesAsText("zustand")).contains("ohne Bilanz");
    }
    @Test void standortZaunUndFremderMandant() throws Exception {
        var a=ruf("GET",BASE+OKTOBER,"LE",null,200);
        assertThat(a.path("teilansicht").asBoolean()).isTrue();
        assertThat(a.at("/nenner/wert").asText()).isEqualTo("9100");
        assertThat(a.at("/nenner/anlagen").asText()).isEqualTo("1 von 1");
        assertThat(a.path("rest").asText()).isEqualTo("1200");
        assertThat(a.path("einsaetze").findValuesAsText("kennzeichen")).contains("EE-2","EE-5").doesNotContain("EE-1","EE-3","MS-12","MS-13");
        assertThat(einsatz(a,"EE-2").path("menge").asText()).isEqualTo("3600");
        assertThat(a.toString()).doesNotContain(ids.get("AN-1").toString(),ids.get("MS-06").toString());
        ruf("GET",BASE+OKTOBER,"OHNE",null,404);
        tenant=uuid("INSERT INTO tenant(name) VALUES ('fremd') RETURNING id");
        benutzer("IK","energiemanager",null);
        ruf("GET",BASE+OKTOBER,"IK",null,404);
    }
    @Test void keineDatenUndKeineErfundeneErsatzquote() throws Exception {
        var a=ruf("GET",BASE+"?von=2026-11-01&bis=2026-11-30","IK",null,200);
        assertThat(einsatz(a,"EE-1").path("menge").isNull()).isTrue();
        assertThat(einsatz(a,"EE-1").path("ersatz_prozent").isNull()).isTrue();
        assertThat(einsatz(a,"EE-1").path("zustand").asText()).isEqualTo("keine Werte");
        ruf("GET",BASE+"?von=2026-10-02&bis=2026-10-31","IK",null,400);
        ruf("GET",BASE+"?von=2026-11-01&bis=2026-10-31","IK",null,400);
    }
    @Test void prozessAusschlussBleibtAuchInDerTeilansichtWirksam() throws Exception {
        ruf("PUT","/api/v1/unternehmen/bewertung/umfang","IK",Map.of("gueltig_ab","2024-01-01",
                "standort_ids",List.of(ids.get("ST-1"),ids.get("ST-2")),"traeger",List.of("Strom","Gas"),
                "ausschluesse",List.of(Map.of("art","prozess","verweis",ids.get("P-2"),"begruendung","Eigene Betrachtung"))),200);
        var a=ruf("GET",BASE+OKTOBER,"LE",null,200);
        assertThat(a.path("einsaetze").findValuesAsText("kennzeichen")).doesNotContain("EE-2");
        assertThat(a.path("rest").asText()).isEqualTo("4800");
    }
    @Test void direkteMessungOhneAnlagenstellungBleibtMengeAberKeinErfundenerAnlagenrest() throws Exception {
        monat("MS-23","100");
        var a=ruf("GET",BASE+OKTOBER,"IK",null,200);
        assertThat(einsatz(a,"EE-8").path("menge").asText()).isEqualTo("100");
        assertThat(a.path("zustand").asText()).isEqualTo("unvollständig");
        for (var anlage:a.path("anlagen")) assertThat(anlage.path("rest").isNull()).isTrue();
    }
    @Test void ersatzanteilGehoertZurGelesenenMonatsversionNichtZuEinerSpaeterenViertelstunde() {
        UUID entity=root.queryForObject("SELECT entity_id FROM messstelle_quelle WHERE messstelle_id=?",UUID.class,ids.get("MS-04"));
        String kennzeichen="[\""+VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT+"\",\""
                +ErgebnisZustand.ersatzwert("wert_eingeben","EW-2026-0001")+"\"]";
        for (int version:List.of(2,3)) root.update("INSERT INTO messreihe_viertelstunde_version(tenant_id,entity_id,messkanal,intervall_beginn,version,menge,menge_zustand,kennzeichen,anteil,ersatzwerte,anlass_kennung,anlass_fassung,created_at) "
                +"VALUES (?,?,'storage.power','2026-10-10T10:00:00Z',?,?,'mit Ersatzwert',?::jsonb,?,ARRAY['EW-2026-0001'],'EW-2026-0001',1,?::timestamptz)",
                tenant,entity,version,version==2?5:99,kennzeichen,version==2?5:99,version==2?"2026-11-04T00:00:00Z":"2026-11-06T00:00:00Z");
        root.update("INSERT INTO messreihe_periode_version(tenant_id,ebene,entity_id,messkanal,periode_beginn,periode_ende,tag,zeitzone,version,wertart,menge,energie,menge_zustand,kennzeichen,erhalten,erwartet,abdeckung_prozent,zustand,korrekturen,ersatzwerte,anlass_kennung,anlass_fassung,created_at) "
                +"VALUES (?,'monat',?,'storage.power','2026-09-30T22:00:00Z','2026-10-31T23:00:00Z','2026-10-01','Europe/Berlin',2,'gauge',100,100,'mit Ersatzwert',?::jsonb,44700,44700,100,'endgueltig',ARRAY[]::text[],ARRAY['EW-2026-0001'],'EW-2026-0001',1,'2026-11-05T00:00:00Z')",
                tenant,entity,kennzeichen);
        com.voltpilot.api.tenant.TenantContext.set(tenant);
        try {
            var w=werte.werte("MS-04","monat","2026-10-01","2026-10-31",null).werte().getFirst();
            assertThat(w.version()).isEqualTo(2);
            assertThat(mengen.ersatz(w)).isEqualByComparingTo("5");
        } finally { com.voltpilot.api.tenant.TenantContext.clear(); }
    }
    private static JsonNode einsatz(JsonNode a,String k) {
        for (var e:a.path("einsaetze")) if (e.path("kennzeichen").asText().equals(k)) return e;
        throw new AssertionError("Einsatz fehlt: "+k);
    }
    private static JsonNode einsatzAbdeckung(JsonNode a,String k) {
        for (var e:a.path("je_einsatz")) if (e.path("kennzeichen").asText().equals(k)) return e;
        throw new AssertionError("Einsatz fehlt: "+k);
    }
    private static JsonNode ortAbdeckung(JsonNode a,String name,String traeger) {
        for (var o:a.path("je_ort")) if (o.path("name").asText().equals(name)
                && o.path("traeger").asText().equals(traeger)) return o;
        throw new AssertionError("Ort fehlt: "+name+" / "+traeger);
    }
    private void monat(String k,String menge) throws Exception {
        ruf("POST","/api/v1/messstellen/"+k+"/ablesungen","IK",Map.of("zeitpunkt","2026-10-01T07:15:00+02:00","stand","0"),200);
        ruf("POST","/api/v1/messstellen/"+k+"/ablesungen","IK",Map.of("zeitpunkt","2026-11-02T07:40:00+01:00",
                "stand",java.text.NumberFormat.getNumberInstance(java.util.Locale.GERMANY).format(new BigDecimal(menge)),"zuordnung_monat","2026-10"),200);
    }
    private void speicher(JsonNode m) {
        UUID a=ids.get("AN-1");
        UUID box=uuid("INSERT INTO device(tenant_id,site_id,external_ref) VALUES (?,?,?) RETURNING id",tenant,a,"VP-IP9-"+tenant);
        UUID entity=uuid("INSERT INTO measurement_point(tenant_id,site_id,role,label,entity_type,device_id,communication,connection_json) "
                +"VALUES (?,?,'modbus-generic','Speicher','modbus-generic',?,'modbus_tcp','{\"unit_id\":1}') RETURNING id",tenant,a,box);
        UUID geraet=root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id=?",UUID.class,entity);
        root.update("INSERT INTO messstelle_quelle(tenant_id,messstelle_id,groesse,richtung,entity_id,geraet_id,kanal,kanal_wertart,herleitung,rolle,gueltig_ab,rueckwirkend,eingetragen_am,actor_name,actor_art) "
                +"VALUES (?,?,'Wirkenergie','Laden / Entladen',?,?,'storage.power','gauge','integration','fuehrend','2024-01-01',false,'2024-01-01','Test','voltpilot')",
                tenant,ids.get("MS-04"),entity,geraet);
        root.update("INSERT INTO messreihe_periode(tag,art,tenant_id,entity_id,messkanal,zeitzone,zeitzone_herkunft,beginn,ende,stunden,teile_erwartet,teile_vorhanden,teile_endgueltig,wertart,energie,menge_positiv,menge_negativ,menge_zustand,kennzeichen,erhalten,erwartet,abdeckung_prozent,zustand,endgueltig_ab,version,berechnet_am) "
                +"VALUES ('2026-10-01','monat',?,?,'storage.power','Europe/Berlin','standort','2026-09-30T22:00:00Z','2026-10-31T23:00:00Z',745,31,31,31,'gauge',800,?,?,'vollständig',?::jsonb,44700,44700,100,'endgueltig','2026-11-07T23:00:00Z',1,'2026-11-08T23:00:00Z')",
                tenant,entity,m.at("/beispielwerte/oktober_2026_laden_kwh").decimalValue(),m.at("/beispielwerte/oktober_2026_entladen_kwh").decimalValue(),"[\""+VerbrauchRegeln.AUS_LEISTUNG_INTEGRIERT+"\"]");
    }
    private void benutzer(String sub,String rolle,UUID standort) {
        root.update("INSERT INTO benutzer(tenant_id,sub,konto,anzeigename,zustand) VALUES (?,?,'benutzer',?,'aktiv')",tenant,sub,sub);
        root.update("INSERT INTO zugriff(tenant_id,benutzer_sub,rolle,standort_id,gueltig_ab,zeitzone) VALUES (?,?,?,?,'2024-01-01','Europe/Berlin')",tenant,sub,rolle,standort);
    }
    private UUID uuid(String sql,Object...args) { return root.queryForObject(sql,UUID.class,args); }
    private JsonNode ruf(String method,String path,String sub,Object body,int status) throws Exception {
        Jwt token=Jwt.withTokenValue("test").header("alg","none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id",tenant.toString()).claim("realm_access",Map.of("roles",List.of())).build();
        var b=request(HttpMethod.valueOf(method),path).with(authentication(new KeycloakRealmRoleConverter().convert(token)));
        if (body!=null) b.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        var r=mvc.perform(b).andReturn().getResponse();
        assertThat(r.getStatus()).as(method+" "+path+" "+r.getContentAsString()).isEqualTo(status);
        return JSON.readTree(r.getContentAsString(StandardCharsets.UTF_8));
    }
}
