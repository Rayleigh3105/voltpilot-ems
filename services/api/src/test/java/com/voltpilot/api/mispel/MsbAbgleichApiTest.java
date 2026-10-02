package com.voltpilot.api.mispel;

import static com.voltpilot.api.mispel.MsbBeispiel.csv;
import static com.voltpilot.api.mispel.MsbBeispiel.mscons;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Lauf;
import com.voltpilot.api.mispel.MispelAbgrenzungService.Vorgaben;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * MiSpeL MP-15 Ende zu Ende: ein realistischer Monat des Messstellenbetreibers (Dezember 2026, 2 976 Viertelstunden
 * je Richtung, mit Lücke und Zählerwechsel) wird an den Messstellen eingelesen, die Ampel vergleicht ihn mit den
 * Gerätewerten, und der Monatslauf (MP-8) rechnet mit den Werten des Messstellenbetreibers — maßgeblich nach Tenor
 * S. 28. Der November trägt bekannte Abweichungen: Gerät +1,5 % (grün), ±0 % (grün), +10 % (rot), +3,4 % (gelb).
 *
 * <p>Ein echter MSB-Monat liegt nicht vor; der Import eines echten Monats bleibt offen bis zum Pilot (MP-47).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MsbAbgleichApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();
    private static final String ZP1 = "DE0001234567890000000000000000001";
    private static final String ZP2 = "DE0001234567890000000000000000002";
    private static final String ZP2_NEU = "DE0001234567890000000000000000003";

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

    @MockBean
    EntityRegistryPublisher registryPublisher;
    @MockBean
    FlowDeploymentPublisher flowPublisher;

    @Autowired
    MockMvc mvc;
    @Autowired
    MispelAbgrenzungService dienst;
    @Autowired
    MsbAbgleichService abgleich;
    @Autowired
    MsbWerteRepository msb;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void geraete() {
        abgleich.leserSetzen(new Geraete(msb));
        abgleich.uhrStellen(Clock.fixed(Instant.parse("2027-01-10T12:00:00Z"), ZoneOffset.UTC));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
    }

    private record Welt(UUID mandant, UUID anlage, Map<String, UUID> ms) {}

    @Test
    void einRealistischerMsbMonatMitLueckeUndZaehlerwechselWirdEingelesenUndAbgeglichen() throws Exception {
        Welt w = welt();
        // Zählerwechsel am Speicherzähler Z2 zum 15.12.2026: neuer Zählpunkt, beide Richtungen.
        rolle(w.mandant(), w.ms().get("MS-03"), "Z2", ZP2_NEU, "2026-12-15");
        rolle(w.mandant(), w.ms().get("MS-04"), "Z2", ZP2_NEU, "2026-12-15");

        // Z1 im Dezember: 2 976 Viertelstunden je Richtung, Abgabe am 03.12. 10–12 Uhr ohne Werte (8 Lücken).
        String z1 = csv(YearMonth.of(2026, 12), List.of(ZP1), "1-1:1.29.0", 1.000, "1-1:2.29.0", 0.500,
                LocalDate.of(2026, 12, 15), LocalDate.of(2026, 12, 3));
        assertThat(z1.lines().filter(l -> l.contains(";1-1:1.29.0;")).count()).isEqualTo(2976);
        JsonNode e = einlesen(w, "MS-01", "msb-dez-z1.csv", z1, 200);
        assertThat(e.get("neu").asBoolean()).isTrue();
        assertThat(e.get("importDatei").get("viertelstunden").asInt()).isEqualTo(2 * 2976 - 8);
        assertThat(e.get("importDatei").get("ersetzt").asInt()).isZero();
        assertThat(e.get("richtungen").toString()).isEqualTo("[\"bezug\",\"abgabe\"]");
        // Dieselbe Datei noch einmal: derselbe Import, nichts Neues.
        assertThat(einlesen(w, "MS-01", "msb-dez-z1.csv", z1, 200).get("neu").asBoolean()).isFalse();

        // Z2 im Dezember: alter Zählpunkt bis 14.12., neuer ab 15.12. — eine Datei an der Messstelle.
        String z2 = csv(YearMonth.of(2026, 12), List.of(ZP2, ZP2_NEU), "bezug", 0.300, "abgabe", 0.200,
                LocalDate.of(2026, 12, 15), null);
        assertThat(einlesen(w, "MS-03", "msb-dez-z2.csv", z2, 200).get("importDatei").get("viertelstunden").asInt())
                .isEqualTo(2 * 2976);
        // Der Zählpunkt von Z2 gehört nicht zu MS-01.
        JsonNode fremd = einlesen(w, "MS-01", "falsch.csv", z2, 422);
        assertThat(fremd.get("code").asText()).isEqualTo("zaehlpunkt_fremd");
        // Eine kaputte Zeile nennt Grund und Zeile.
        JsonNode kaputt = einlesen(w, "MS-01", "kaputt.csv",
                "zeitstempel;zaehlpunkt;richtung;kwh\n2026-12-01T00:07+01:00;" + ZP1 + ";bezug;1\n", 400);
        assertThat(kaputt.get("code").asText()).isEqualTo("datei_ungueltig");
        assertThat(kaputt.get("grund").asText()).isEqualTo("zeitstempel");
        assertThat(kaputt.get("zeile").asInt()).isEqualTo(2);

        // Dezember an der Anlage: Z1 Bezug vergleichbar (+1,5 % grün), Abgabe mit Lücke, Z2 mit Zählerwechsel grau.
        JsonNode dez = ruf(w, "/api/v1/sites/" + w.anlage() + "/mispel/abgrenzung/monate/2026-12/abgleich");
        Map<String, JsonNode> je = jeGroesse(dez);
        assertThat(je.get("Z1NB").get("abgleich").get("ampel").asText()).isEqualTo("gruen");
        assertThat(je.get("Z1NB").get("abgleich").get("abweichungProzent").decimalValue())
                .isEqualByComparingTo("1.5");
        assertThat(je.get("Z1NE").get("abgleich").get("ampel").asText()).isEqualTo("grau");
        assertThat(je.get("Z1NE").get("abgleich").get("grund").asText()).isEqualTo("luecke");
        assertThat(je.get("Z2V").get("abgleich").get("grund").asText()).isEqualTo("zaehlerwechsel");
        assertThat(je.get("Z2E").get("abgleich").get("grund").asText()).isEqualTo("zaehlerwechsel");
        assertThat(dez.get("groessteAbweichung").asText()).isEqualTo("Z1NB");

        // An der Messstelle MS-04: Dezember grau (Zählerwechsel), November ohne Werte grau, Oktober ebenso.
        JsonNode ms4 = ruf(w, "/api/v1/messstellen/" + w.ms().get("MS-04") + "/msb-abgleich");
        assertThat(ms4.get("monate").get(1).get("zaehlpunkt").asText()).isEqualTo(ZP2_NEU);
        assertThat(ms4.get("monate").get(0).get("monat").asText()).isEqualTo("2027-01");
        assertThat(ms4.get("monate").get(1).get("abgleich").get("grund").asText()).isEqualTo("zaehlerwechsel");
        assertThat(ms4.get("monate").get(1).get("abgleich").get("msbKwh").decimalValue())
                .isEqualByComparingTo(new BigDecimal("595.200"));
        assertThat(ms4.get("monate").get(2).get("abgleich").get("grund").asText()).isEqualTo("keine_msb_werte");
        assertThat(ms4.get("schwellen").get("gruenBisProzent").decimalValue()).isEqualByComparingTo("2");
        assertThat(ruf(w, "/api/v1/messstellen/" + w.ms().get("MS-01") + "/msb-abgleich").get("importe").size())
                .isEqualTo(1);
    }

    @Test
    void bekannteAbweichungenFaerbenDieAmpelUndDerMonatslaufRechnetMitDenWertenDesMessstellenbetreibers()
            throws Exception {
        Welt w = welt();
        YearMonth nov = YearMonth.of(2026, 11);
        einlesen(w, "MS-01", "msb-nov-z1.csv", csv(nov, List.of(ZP1), "bezug", 1.000, "abgabe", 0.500, null, null),
                200);
        einlesen(w, "MS-04", "msb-nov-z2.csv", csv(nov, List.of(ZP2), "bezug", 0.300, "abgabe", 0.200, null, null),
                200);

        JsonNode a = ruf(w, "/api/v1/sites/" + w.anlage() + "/mispel/abgrenzung/monate/2026-11/abgleich");
        Map<String, JsonNode> je = jeGroesse(a);
        assertThat(je.keySet()).containsExactly("Z1NB", "Z1NE", "Z2V", "Z2E");
        assertThat(ampel(je, "Z1NB")).isEqualTo("gruen 1.5");
        assertThat(ampel(je, "Z1NE")).isEqualTo("gruen 0.0");
        assertThat(ampel(je, "Z2V")).isEqualTo("rot 10.0");
        assertThat(ampel(je, "Z2E")).isEqualTo("gelb 3.4");
        assertThat(je.get("Z2E").get("abgleich").get("geraetKwh").decimalValue())
                .isEqualByComparingTo(new BigDecimal("595.584"));
        assertThat(je.get("Z2E").get("abgleich").get("msbKwh").decimalValue()).isEqualByComparingTo("576.000");
        assertThat(a.get("groessteAbweichung").asText()).isEqualTo("Z2V");
        assertThat(a.get("wirkung").isNull()).isTrue();

        // Vorschau aus Gerätewerten, dann endgültig mit den eingelesenen Werten des Messstellenbetreibers.
        wertequelle(w, "geraet");
        Lauf vorschau = lauf(w, nov);
        assertThat(vorschau.zeile().stand()).isEqualTo("vorlaeufig");
        assertThat(vorschau.zeile().wertequelle()).isEqualTo("geraet");
        wertequelle(w, "messstellenbetreiber");
        Lauf fertig = lauf(w, nov);
        assertThat(fertig.zeile().stand()).isEqualTo("endgueltig");
        assertThat(fertig.zeile().wertequelle()).isEqualTo("messstellenbetreiber");
        assertThat(fertig.zeile().nachweis()).doesNotContain("0.2068");

        // Die Wirkung: Farben und Saldierung vorher → nachher, aus den beiden Läufen.
        JsonNode wirkung = ruf(w, "/api/v1/sites/" + w.anlage() + "/mispel/abgrenzung/monate/2026-11/abgleich")
                .get("wirkung");
        assertThat(wirkung.get("vorherWertequelle").asText()).isEqualTo("geraet");
        assertThat(wirkung.get("farben").size()).isGreaterThan(0);
        assertThat(wirkung.get("differenzEur").decimalValue()).isNotNull();
        JsonNode ms4 = ruf(w, "/api/v1/messstellen/" + w.ms().get("MS-04") + "/msb-abgleich");
        JsonNode novZeile = ms4.get("monate").get(2);
        assertThat(novZeile.get("monat").asText()).isEqualTo("2026-11");
        assertThat(novZeile.get("abgleich").get("ampel").asText()).isEqualTo("gelb");
        assertThat(novZeile.get("wirkung").get("differenzEur").decimalValue())
                .isEqualByComparingTo(wirkung.get("differenzEur").decimalValue());

        // Oktober: Wertequelle „Messstellenbetreiber“, aber keine eingelesenen Werte → Gerätewerte, vorläufig.
        Lauf okt = lauf(w, YearMonth.of(2026, 10));
        assertThat(okt.zeile().wertequelle()).isEqualTo("geraet");
        assertThat(okt.zeile().stand()).isEqualTo("vorlaeufig");
        assertThat(okt.zeile().nachweis()).contains("msb_werte_fehlen:MS-01", "wertequelle_geraet");
    }

    @Test
    void msconsDesMessstellenbetreibersGibtDieselbeAmpelWieDieCsv() throws Exception {
        YearMonth nov = YearMonth.of(2026, 11);
        Welt ausCsv = welt();
        einlesen(ausCsv, "MS-01", "msb-nov-z1.csv", csv(nov, List.of(ZP1), "bezug", 1.000, "abgabe", 0.500, null,
                null), 200);
        einlesen(ausCsv, "MS-04", "msb-nov-z2.csv", csv(nov, List.of(ZP2), "bezug", 0.300, "abgabe", 0.200, null,
                null), 200);
        Welt ausMscons = welt();
        JsonNode e = einlesen(ausMscons, "MS-01", "MSCONS_TL_9900000000003_9900000000010_20261202_MSB4711.edi",
                mscons(nov, List.of(ZP1), "bezug", 1.000, "abgabe", 0.500, null, null), 200);
        assertThat(e.get("importDatei").get("format").asText()).isEqualTo("mscons");
        assertThat(e.get("importDatei").get("viertelstunden").asInt()).isEqualTo(2 * 2880);
        assertThat(e.get("uebergangen").asInt()).isZero();
        einlesen(ausMscons, "MS-04", "msb-nov-z2.txt", mscons(nov, List.of(ZP2), "bezug", 0.300, "abgabe", 0.200,
                null, null), 200);

        // Dieselben Werte → dieselbe Ampel je Zählrichtung, Zahl für Zahl.
        String monat = "/mispel/abgrenzung/monate/2026-11/abgleich";
        Map<String, JsonNode> c = jeGroesse(ruf(ausCsv, "/api/v1/sites/" + ausCsv.anlage() + monat));
        Map<String, JsonNode> m = jeGroesse(ruf(ausMscons, "/api/v1/sites/" + ausMscons.anlage() + monat));
        assertThat(m.keySet()).containsExactly("Z1NB", "Z1NE", "Z2V", "Z2E");
        for (String g : c.keySet()) {
            assertThat(m.get(g).get("abgleich")).as(g).isEqualTo(c.get(g).get("abgleich"));
        }
        assertThat(ampel(m, "Z1NB")).isEqualTo("gruen 1.5");
        assertThat(ampel(m, "Z1NE")).isEqualTo("gruen 0.0");
        assertThat(ampel(m, "Z2V")).isEqualTo("rot 10.0");
        assertThat(ampel(m, "Z2E")).isEqualTo("gelb 3.4");
        JsonNode ms4 = ruf(ausMscons, "/api/v1/messstellen/" + ausMscons.ms().get("MS-04") + "/msb-abgleich");
        assertThat(ms4.get("importe").get(0).get("format").asText()).isEqualTo("mscons");
        assertThat(ms4.get("monate").get(2).get("abgleich").get("ampel").asText()).isEqualTo("gelb");

        // Der Monatslauf rechnet mit den Werten aus der MSCONS: endgültig.
        wertequelle(ausMscons, "messstellenbetreiber");
        Lauf fertig = lauf(ausMscons, nov);
        assertThat(fertig.zeile().stand()).isEqualTo("endgueltig");
        assertThat(fertig.zeile().wertequelle()).isEqualTo("messstellenbetreiber");
    }

    @Test
    void einRealistischerMsconsMonatMitLueckeErsatzwertenUndZaehlerwechsel() throws Exception {
        Welt w = welt();
        rolle(w.mandant(), w.ms().get("MS-03"), "Z2", ZP2_NEU, "2026-12-15");
        rolle(w.mandant(), w.ms().get("MS-04"), "Z2", ZP2_NEU, "2026-12-15");
        YearMonth dez = YearMonth.of(2026, 12);

        // Z1: 2 976 Viertelstunden je Richtung; Abgabe am 03.12. 10–11 Uhr ohne Menge, 11–12 Uhr Ersatzwerte.
        String z1 = mscons(dez, List.of(ZP1), "1-1:1.29.0", 1.000, "1-1:2.29.0", 0.500, LocalDate.of(2026, 12, 15),
                LocalDate.of(2026, 12, 3));
        JsonNode e = einlesen(w, "MS-01", "msb-dez-z1.edi", z1, 200);
        assertThat(e.get("neu").asBoolean()).isTrue();
        assertThat(e.get("importDatei").get("format").asText()).isEqualTo("mscons");
        assertThat(e.get("importDatei").get("viertelstunden").asInt()).isEqualTo(2 * 2976 - 8);
        assertThat(e.get("uebergangen").asInt()).isEqualTo(4);
        assertThat(e.get("richtungen").toString()).isEqualTo("[\"bezug\",\"abgabe\"]");
        assertThat(einlesen(w, "MS-01", "msb-dez-z1.edi", z1, 200).get("neu").asBoolean()).isFalse();

        // Z2: alter Zählpunkt bis 14.12., neuer ab 15.12. — zwei Messlokationen (LOC+172) in einer Nachricht.
        String z2 = mscons(dez, List.of(ZP2, ZP2_NEU), "bezug", 0.300, "abgabe", 0.200, LocalDate.of(2026, 12, 15),
                null);
        assertThat(einlesen(w, "MS-03", "msb-dez-z2.edi", z2, 200).get("importDatei").get("viertelstunden").asInt())
                .isEqualTo(2 * 2976);
        assertThat(einlesen(w, "MS-01", "falsch.edi", z2, 422).get("code").asText()).isEqualTo("zaehlpunkt_fremd");
        // Eine abgeschnittene Nachricht nennt Grund und Segment.
        JsonNode kaputt = einlesen(w, "MS-01", "kaputt.edi", z1.replaceFirst("UNT\\+\\d+", "UNT+12"), 400);
        assertThat(kaputt.get("code").asText()).isEqualTo("datei_ungueltig");
        assertThat(kaputt.get("grund").asText()).isEqualTo("unvollstaendig");
        assertThat(kaputt.get("format").asText()).isEqualTo("mscons");
        assertThat(kaputt.get("segment").asInt()).isGreaterThan(12_000);
        assertThat(kaputt.get("message").asText()).contains("UNT nennt 12 Segmente");

        JsonNode monat = ruf(w, "/api/v1/sites/" + w.anlage() + "/mispel/abgrenzung/monate/2026-12/abgleich");
        Map<String, JsonNode> je = jeGroesse(monat);
        assertThat(ampel(je, "Z1NB")).isEqualTo("gruen 1.5");
        assertThat(je.get("Z1NE").get("abgleich").get("grund").asText()).isEqualTo("luecke");
        assertThat(je.get("Z2V").get("abgleich").get("grund").asText()).isEqualTo("zaehlerwechsel");
        assertThat(je.get("Z2E").get("abgleich").get("grund").asText()).isEqualTo("zaehlerwechsel");
        assertThat(ruf(w, "/api/v1/messstellen/" + w.ms().get("MS-04") + "/msb-abgleich").get("monate").get(1)
                .get("abgleich").get("msbKwh").decimalValue()).isEqualByComparingTo(new BigDecimal("595.200"));
    }

    @Test
    void fremdeMessstellenUndAnlagenBleibenUnsichtbar() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        assertThat(antwort(fremd, get("/api/v1/messstellen/" + w.ms().get("MS-01") + "/msb-abgleich")).getStatus())
                .isEqualTo(404);
        assertThat(antwort(fremd, get("/api/v1/sites/" + w.anlage() + "/mispel/abgrenzung/monate/2026-11/abgleich"))
                .getStatus()).isEqualTo(404);
        assertThat(antwort(w, get("/api/v1/sites/" + w.anlage() + "/mispel/abgrenzung/monate/2026-09/abgleich"))
                .getStatus()).isEqualTo(400);
        // Einlesen an der Messstelle eines anderen Mandanten: 404, und nichts wird geschrieben.
        String datei = csv(YearMonth.of(2026, 11), List.of(ZP1), "bezug", 1, "abgabe", 1, null, null);
        assertThat(antwort(fremd, multipart("/api/v1/messstellen/" + w.ms().get("MS-01") + "/msb-werte")
                .file(new MockMultipartFile("datei", "x.csv", "text/csv", datei.getBytes(StandardCharsets.UTF_8))))
                .getStatus()).isEqualTo(404);
        assertThat(root.queryForObject("SELECT count(*) FROM mispel_msb_import WHERE tenant_id IN (?, ?)",
                Integer.class, w.mandant(), fremd.mandant())).isZero();
    }

    // ------------------------------------------------------------------ Hilfen

    private static String ampel(Map<String, JsonNode> je, String g) {
        JsonNode a = je.get(g).get("abgleich");
        return a.get("ampel").asText() + " " + a.get("abweichungProzent").decimalValue().toPlainString();
    }

    private static Map<String, JsonNode> jeGroesse(JsonNode monat) {
        Map<String, JsonNode> out = new LinkedHashMap<>();
        monat.get("zaehler").forEach(z -> out.put(z.get("groesse").asText(), z));
        return out;
    }

    private Lauf lauf(Welt w, YearMonth monat) {
        dienst.leserSetzen(new Geraete(msb));
        dienst.uhrStellen(Clock.fixed(Instant.parse("2027-01-10T12:00:00Z"), ZoneOffset.UTC));
        TenantContext.set(w.mandant());
        try {
            return dienst.monatslauf(w.anlage(), monat, Vorgaben.von("A1", "viertelstunde"));
        } finally {
            TenantContext.clear();
        }
    }

    private JsonNode einlesen(Welt w, String ms, String name, String inhalt, int status) throws Exception {
        String art = name.endsWith(".csv") ? "text/csv" : "application/edifact";
        MockHttpServletResponse r = antwort(w, multipart("/api/v1/messstellen/" + w.ms().get(ms) + "/msb-werte")
                .file(new MockMultipartFile("datei", name, art, inhalt.getBytes(StandardCharsets.UTF_8))));
        assertThat(r.getStatus()).as(r.getContentAsString()).isEqualTo(status);
        return r.getContentAsByteArray().length == 0 ? null : MAPPER.readTree(r.getContentAsByteArray());
    }

    private JsonNode ruf(Welt w, String pfad) throws Exception {
        MockHttpServletResponse r = antwort(w, get(pfad));
        assertThat(r.getStatus()).as(pfad + " " + r.getContentAsString()).isEqualTo(200);
        return MAPPER.readTree(r.getContentAsByteArray());
    }

    private MockHttpServletResponse antwort(Welt w,
            org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder b) throws Exception {
        RequestPostProcessor wer = jwt().jwt(j -> {
            j.subject("sub-mispel-" + w.mandant());
            j.claim("name", "Mara Test");
            j.claim("tenant_id", w.mandant().toString());
        });
        return mvc.perform(b.with(wer)).andReturn().getResponse();
    }

    /**
     * Die Gerätewerte der Box je Viertelstunde (kWh): MS-01 Bezug 1,015 (+1,5 %), MS-02 Abgabe 0,500 (±0), MS-03
     * Laden 0,330 (+10 %), MS-04 Entladen 0,2068 (+3,4 %) — gegen die Werte des Messstellenbetreibers 1,0 / 0,5 /
     * 0,3 / 0,2. Die Werte des Messstellenbetreibers liest der echte Weg ({@link MsbWerteRepository}).
     */
    private static final class Geraete extends MispelZaehlerLeser {

        Geraete(MsbWerteRepository msb) {
            super(null, msb);
        }

        @Override
        public Map<Instant, Menge> lesen(String kennzeichen, Instant von, Instant bis) {
            BigDecimal kwh = new BigDecimal(switch (kennzeichen) {
                case "MS-01" -> "1.015";
                case "MS-02" -> "0.500";
                case "MS-03" -> "0.330";
                default -> "0.2068";
            });
            Map<Instant, Menge> out = new LinkedHashMap<>();
            for (Instant t = von; t.isBefore(bis); t = t.plus(Duration.ofMinutes(15))) {
                out.put(t, new Menge(kwh, true));
            }
            return out;
        }
    }

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Abgleich #" + nr);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at, plant_kind, "
                + "anzulegender_wert_ct_kwh) VALUES (?, 'Simulator-Anlage', '2026-09-01', 'direktvermarktung', 6.85) "
                + "RETURNING id", UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, "
                + "'claimed') RETURNING id", UUID.class, t, anlage, "VP-BOX-MP15-" + nr);
        UUID netz = komponente(t, anlage, box, "grid-meter", "power_kw");
        UUID speicher = komponente(t, anlage, box, "battery-hybrid", "battery_power_kw");
        Map<String, UUID> ms = new LinkedHashMap<>();
        ms.put("MS-01", messstelle(t, "MS-01", "Bezug"));
        ms.put("MS-02", messstelle(t, "MS-02", "Abgabe"));
        ms.put("MS-03", messstelle(t, "MS-03", "Laden"));
        ms.put("MS-04", messstelle(t, "MS-04", "Entladen"));
        stellung(t, anlage, ms.get("MS-01"), "Hauptzähler", "2026-10-01");
        stellung(t, anlage, ms.get("MS-02"), "Hauptzähler", "2026-10-01");
        stellung(t, anlage, ms.get("MS-03"), "Speicher", "2026-10-01");
        stellung(t, anlage, ms.get("MS-04"), "Speicher", "2026-10-01");
        quelle(t, box, ms.get("MS-01"), "Bezug", netz, "sunspec.model_203.totwhimp");
        quelle(t, box, ms.get("MS-02"), "Abgabe", netz, "sunspec.model_203.totwhexp");
        quelle(t, box, ms.get("MS-03"), "Laden", speicher, "battery.charge-energy");
        quelle(t, box, ms.get("MS-04"), "Entladen", speicher, "battery.discharge-energy");
        rolle(t, ms.get("MS-01"), "Z1", ZP1, "2026-10-01");
        rolle(t, ms.get("MS-02"), "Z1", ZP1, "2026-10-01");
        rolle(t, ms.get("MS-03"), "Z2", ZP2, "2026-10-01");
        rolle(t, ms.get("MS-04"), "Z2", ZP2, "2026-10-01");
        root.update("INSERT INTO site_supply_price (site_id, tenant_id, umlagen_ct, netzentgelt_arbeitspreis_ct, "
                + "ust_pct) VALUES (?, ?, 2.946, 8.120, 19.0)", anlage, t);
        root.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) SELECT 'viertelstunde', g, "
                + "'PT15M', true FROM generate_series('2026-09-30T22:00Z'::timestamptz, '2026-12-31T22:45Z', "
                + "INTERVAL '15 minutes') g ON CONFLICT DO NOTHING");
        return new Welt(t, anlage, ms);
    }

    private static void wertequelle(Welt w, String quelle) {
        root.update("UPDATE messstelle_zaehlerrolle SET wertequelle = ? WHERE tenant_id = ?", quelle, w.mandant());
    }

    private static UUID komponente(UUID t, UUID anlage, UUID box, String typ, String kanal) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, control, communication, connection_json, capabilities, created_at) VALUES (?, ?, ?, ?, ?, "
                + "?, false, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, ?::jsonb, '2026-09-01') "
                + "RETURNING id", UUID.class, t, anlage, typ, typ, typ, box,
                "{\"measure\":[{\"channel\":\"" + kanal + "\",\"unit\":\"kW\"}]}");
    }

    private static UUID messstelle(UUID t, String kz, String richtung) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', ?, 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, t, kz, kz, richtung);
    }

    private static void stellung(UUID t, UUID anlage, UUID ms, String stellung, String ab) {
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                + "VALUES (?, ?, ?, ?, ?::date)", t, ms, anlage, stellung, ab);
    }

    private static void quelle(UUID t, UUID box, UUID ms, String richtung, UUID komponente, String kanal) {
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) SELECT ?, site_id, ?, ?, ?, true, 60, 1, '2026-10-01'::timestamptz, "
                + "'2026.09.11.1', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute' FROM measurement_point "
                + "WHERE id = ? ON CONFLICT DO NOTHING", t, box, komponente, kanal, komponente);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', ?, ?, ?, ?, 'counter', 'zaehlerstand', 'fuehrend', "
                + "'2026-10-01'::timestamptz, false, now(), 'sub-test', 'Test', 'kunde')", t, ms, richtung, komponente,
                geraet, kanal);
    }

    private static void rolle(UUID t, UUID ms, String rolle, String zp, String ab) {
        root.update("INSERT INTO messstelle_zaehlerrolle (tenant_id, messstelle_id, rolle, zaehlpunkt, "
                + "messstellenbetreiber, eichstatus, eichfrist_bis, wertequelle, gueltig_ab) VALUES (?, ?, ?, ?, "
                + "'Netze Musterstadt GmbH', 'eichrechtskonform', '2034-12-31', 'messstellenbetreiber', ?::date)", t, ms,
                rolle, zp, ab);
    }
}
