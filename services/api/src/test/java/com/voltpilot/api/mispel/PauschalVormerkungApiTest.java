package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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

/**
 * MiSpeL MP-27 gegen die Datenbank: {@code PUT …/foerderweg/pauschal-vormerkung} (Vertrag Förderweg 1.3 § 5a,
 * „vorgemerkt, Termin offen“), die Rücknahme über {@code DELETE …/foerderweg/vormerkung}, die neuen Felder der
 * Förderweg-Ansicht und {@code GET …/mispel/pauschal/jahre/{jahr}} (Vertrag Pauschal „Jahresstand für das Portal“).
 *
 * <p><b>Prüfnachweis:</b> vor der EU-Genehmigung lässt sich die Pauschaloption nur mit offenem Termin vormerken — mit
 * den Bestätigungen der Voraussetzungen 2 und 4 (A2 S. 18–19) samt Datum, gegen die 30-kWp-Grenze der Solarleistung
 * im Aufbau (Voraussetzung 3, Steckersolar nicht mitgezählt); unbekannte Solarleistung ist keine Null; die
 * Vormerkung ist keine Fassung (site_foerderweg bleibt leer); der Mandantenzaun hält; der Jahresstand liest die
 * jüngste Fassung je (Rumpf-)Jahr und rechnet die Brüche des Nachweises nur zur Anzeige.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class PauschalVormerkungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();

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
    FoerderwegService wege;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @AfterEach
    void uhrZurueck() {
        wege.uhrStellen(Clock.systemUTC());
    }

    private record Anlage(UUID mandant, UUID id) {}

    private record Antwort(int status, JsonNode body) {}

    // ------------------------------------------------------------------ Vormerken mit offenem Termin

    @Test
    void vormerkenMitOffenemTerminHaeltDieBestaetigungenMitDatumUndIstKeineFassung() throws Exception {
        heute("2026-10-20");
        Anlage a = anlage(new BigDecimal("9.2"), new BigDecimal("10"));

        Antwort r = ruf(a, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", angaben(true, "0.8", true));
        assertThat(r.status()).as(r.body().toString()).isEqualTo(200);
        JsonNode v = r.body().get("pauschal_vormerkung");
        assertThat(v.get("foerderweg").asText()).isEqualTo("marktpraemie_pauschal");
        assertThat(v.get("begriff").asText()).isEqualTo("Marktprämie mit Pauschaloption");
        assertThat(v.get("termin").isNull()).isTrue();
        assertThat(v.get("steckersolar_kwp").decimalValue()).isEqualByComparingTo("0.8");
        assertThat(v.get("ein_betreiber_bestaetigt_am").isNull()).isFalse();
        assertThat(v.get("steckersolar_direktvermarktung_bestaetigt_am").isNull()).isFalse();
        assertThat(v.get("direktvermarkter").asText()).isEqualTo("Nordstrom Direkt");
        assertThat(r.body().get("pauschaloption_ab").isNull()).isTrue();
        // Keine Fassung: der Förderweg bleibt der Bestand, Optimierer und Box sehen nichts.
        assertThat(r.body().get("quelle").asText()).isEqualTo("bestand");
        assertThat(root.queryForObject("SELECT count(*) FROM site_foerderweg WHERE site_id = ?", Integer.class, a.id()))
                .isZero();

        // Ändern = noch einmal senden; die alte Vormerkung bleibt als aufgehobene lesbar.
        Antwort zwei = ruf(a, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", angaben(true, "0", null));
        assertThat(zwei.status()).isEqualTo(200);
        assertThat(zwei.body().get("pauschal_vormerkung").get("steckersolar_kwp").decimalValue()).isEqualByComparingTo("0");
        assertThat(zwei.body().get("pauschal_vormerkung").get("steckersolar_direktvermarktung_bestaetigt_am").isNull())
                .isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM site_pauschal_vormerkung WHERE site_id = ?", Integer.class,
                a.id())).isEqualTo(2);

        // GET liefert dieselbe Vormerkung.
        assertThat(ruf(a, HttpMethod.GET, "/foerderweg", null).body().get("pauschal_vormerkung").get("id").asText())
                .isEqualTo(zwei.body().get("pauschal_vormerkung").get("id").asText());

        // Zurücknehmen über die vorhandene Route; danach gibt es nichts mehr zurückzunehmen.
        Antwort weg = ruf(a, HttpMethod.DELETE, "/foerderweg/vormerkung", null);
        assertThat(weg.status()).isEqualTo(200);
        assertThat(weg.body().get("pauschal_vormerkung").isNull()).isTrue();
        assertThat(ruf(a, HttpMethod.DELETE, "/foerderweg/vormerkung", null).body().get("code").asText())
                .isEqualTo("keine_vormerkung");
    }

    @Test
    void dieVoraussetzungenDerAnlage2LehnenMitFundstelleAb() throws Exception {
        heute("2026-10-20");
        Anlage a = anlage(new BigDecimal("9.2"), new BigDecimal("10"));
        Antwort ohneBetreiber = ruf(a, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", angaben(false, "0", null));
        assertThat(ohneBetreiber.status()).isEqualTo(422);
        assertThat(ohneBetreiber.body().get("code").asText()).isEqualTo("voraussetzung_unbestaetigt");
        assertThat(ohneBetreiber.body().get("feld").asText()).isEqualTo("ein_betreiber");
        assertThat(ohneBetreiber.body().get("fundstelle").asText()).contains("A2 S. 18");

        Antwort steckerOhneDv = ruf(a, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", angaben(true, "0.8", false));
        assertThat(steckerOhneDv.status()).isEqualTo(422);
        assertThat(steckerOhneDv.body().get("feld").asText()).isEqualTo("steckersolar_direktvermarktung");
        assertThat(steckerOhneDv.body().get("fundstelle").asText()).contains("Fn. 15");

        Map<String, Object> fremd = angaben(true, "0", null);
        fremd.put("gueltig_ab", "2026-11-01");
        Antwort unbekannt = ruf(a, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", fremd);
        assertThat(unbekannt.status()).isEqualTo(400);
        assertThat(unbekannt.body().get("feld").asText()).isEqualTo("gueltig_ab");

        Map<String, Object> ohneStecker = angaben(true, null, null);
        assertThat(ruf(a, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", ohneStecker).body().get("feld").asText())
                .isEqualTo("steckersolar_kwp");

        // 30 kWp: die Solarleistung im Aufbau, Steckersolar zählt nicht mit (Voraussetzung 3, A2 S. 19 Fn. 14).
        Anlage gross = anlage(new BigDecimal("32.4"), new BigDecimal("15"));
        Antwort ueber = ruf(gross, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", angaben(true, "0", null));
        assertThat(ueber.status()).isEqualTo(422);
        assertThat(ueber.body().get("code").asText()).isEqualTo("ueber_30_kwp");
        assertThat(ueber.body().get("solarleistung_kwp").decimalValue()).isEqualByComparingTo("32.4");
        Anlage grenze = anlage(new BigDecimal("30"), new BigDecimal("10"));
        assertThat(ruf(grenze, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", angaben(true, "0.8", true)).status())
                .isEqualTo(200);

        // Unbekannt ist keine Null: ohne PV-Leistung im Aufbau wird nicht geprüft, sondern abgelehnt.
        Anlage ohnePv = anlage(null, new BigDecimal("10"));
        Antwort offen = ruf(ohnePv, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", angaben(true, "0", null));
        assertThat(offen.status()).isEqualTo(422);
        assertThat(offen.body().get("code").asText()).isEqualTo("solarleistung_unbekannt");
        assertThat(root.queryForObject("SELECT count(*) FROM site_pauschal_vormerkung WHERE site_id IN (?, ?, ?)",
                Integer.class, a.id(), gross.id(), ohnePv.id())).isZero();
    }

    @Test
    void eineVormerkungZumMonatserstenGehtVorUndDerZaunHaelt() throws Exception {
        heute("2026-10-20");
        Anlage a = anlage(new BigDecimal("9.2"), new BigDecimal("10"));
        Map<String, Object> ungefoerdert = new LinkedHashMap<>();
        ungefoerdert.put("foerderweg", "ungefoerdert");
        ungefoerdert.put("einverstaendnis", true);
        ungefoerdert.put("gueltig_ab", "2026-11-01");
        assertThat(ruf(a, HttpMethod.PUT, "/foerderweg", ungefoerdert).status()).isEqualTo(200);
        Antwort besteht = ruf(a, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", angaben(true, "0", null));
        assertThat(besteht.status()).isEqualTo(409);
        assertThat(besteht.body().get("code").asText()).isEqualTo("vormerkung_besteht");
        assertThat(besteht.body().get("gueltig_ab").asText()).isEqualTo("2026-11-01");

        Anlage fremd = anlage(new BigDecimal("5"), new BigDecimal("5"));
        Anlage blick = new Anlage(fremd.mandant(), a.id());
        assertThat(ruf(blick, HttpMethod.PUT, "/foerderweg/pauschal-vormerkung", angaben(true, "0", null)).status())
                .isEqualTo(404);
        assertThat(ruf(blick, HttpMethod.GET, "/mispel/pauschal/jahre/2027", null).status()).isEqualTo(404);
    }

    // ------------------------------------------------------------------ Jahresstand

    @Test
    void derJahresstandLiestDieJuengsteFassungJeRumpfjahrUndRechnetBruecheNurZurAnzeige() throws Exception {
        Anlage a = anlage(new BigDecimal("8"), new BigDecimal("10"));
        Antwort leer = ruf(a, HttpMethod.GET, "/mispel/pauschal/jahre/2027", null);
        assertThat(leer.status()).isEqualTo(200);
        assertThat(leer.body().get("staende").size()).isZero();
        assertThat(leer.body().get("schaetzung").isNull()).isTrue();

        // Der Beispielsfall der BNetzA (A2 S. 55–56): zwei Rumpfjahre, das erste in zwei Fassungen.
        lauf(a, "2027-01-01", "2027-05-16", 1, "{\"(P1)R\":\"1\",\"(P14)\":\"1\"}");
        lauf(a, "2027-01-01", "2027-05-16", 2, "{\"(P1)\":\"4000\",\"(P1)R\":\"184000/183\",\"(P4)R\":\"15024832/13359\","
                + "\"(P14)\":\"1500\",\"(P15)\":\"184000/183\"}");
        lauf(a, "2027-05-17", "2027-12-31", 1, "{\"(P1)R\":\"548000/183\",\"(P14)\":\"3500\"}");

        Antwort r = ruf(a, HttpMethod.GET, "/mispel/pauschal/jahre/2027", null);
        assertThat(r.status()).isEqualTo(200);
        JsonNode s = r.body().get("staende");
        assertThat(s.size()).isEqualTo(2);
        JsonNode erstes = s.get(0);
        assertThat(erstes.get("fassung").asInt()).isEqualTo(2);
        assertThat(erstes.get("rumpfjahr").asBoolean()).isTrue();
        assertThat(erstes.get("formelsatz").asText()).isEqualTo("P1");
        assertThat(erstes.get("basisfall").asText()).isEqualTo("P1");
        assertThat(erstes.get("stand_gruende").get(0).asText()).isEqualTo("eu_genehmigung_ausstehend");
        assertThat(erstes.get("stammdaten").get("Pinst").decimalValue()).isEqualByComparingTo("8");
        assertThat(erstes.get("jahreswerte").get("(P1)R").decimalValue()).isEqualByComparingTo("1005.464");
        assertThat(erstes.get("jahreswerte").get("(P4)R").decimalValue()).isEqualByComparingTo("1124.697");
        assertThat(erstes.get("jahreswerte").get("(P14)").decimalValue()).isEqualByComparingTo("1500");
        assertThat(s.get(1).get("tag_von").asText()).isEqualTo("2027-05-17");

        assertThat(ruf(a, HttpMethod.GET, "/mispel/pauschal/jahre/20x7", null).status()).isEqualTo(400);
    }

    // ------------------------------------------------------------------ Hilfen

    private void heute(String tag) {
        wege.uhrStellen(Clock.fixed(Instant.parse(tag + "T10:00:00Z"), ZoneOffset.UTC));
    }

    /** Eine Anlage mit PV-Asset ({@code null} = ohne Leistung) und Speicher. */
    private Anlage anlage(BigDecimal pvKwp, BigDecimal speicherKwh) {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Pauschal #" + nr);
        UUID s = root.queryForObject("INSERT INTO site (tenant_id, name, plant_kind, netzladen_erlaubt) "
                + "VALUES (?, ?, 'eigenverbrauch', false) RETURNING id", UUID.class, t, "Haus Kröger " + nr);
        root.update("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES (?, ?, 'pv', ?)", t, s, pvKwp);
        root.update("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh) VALUES (?, ?, 'battery', ?)", t, s,
                speicherKwh);
        return new Anlage(t, s);
    }

    private static Map<String, Object> angaben(boolean einBetreiber, String steckersolarKwp, Boolean dv) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("ein_betreiber", einBetreiber);
        b.put("steckersolar_kwp", steckersolarKwp == null ? null : new BigDecimal(steckersolarKwp));
        b.put("steckersolar_direktvermarktung", dv);
        b.put("direktvermarkter", "Nordstrom Direkt");
        b.put("bilanzkreis_gesondert", true);
        return b;
    }

    /** Ein gespeicherter Lauf wie MP-25 ihn ablegt — nur die Teile des Nachweises, die der Jahresstand liest. */
    private static void lauf(Anlage a, String von, String bis, int fassung, String jahreswerte) {
        String schluessel = von + "/" + bis;
        String nachweis = "{\"schluessel\":\"" + schluessel + "\",\"formelsatz\":\"P1\",\"basisfall\":\"P1\","
                + "\"stammdaten\":{\"Pinst\":\"8\",\"SKinst\":\"10\"},\"stand_gruende\":[\"eu_genehmigung_ausstehend\"],"
                + "\"jahreswerte\":{\"" + schluessel + "\":" + jahreswerte + "}}";
        root.update("INSERT INTO mispel_pauschal_jahr (tenant_id, site_id, jahr, tag_von, tag_bis, zeitraum_von, "
                + "zeitraum_bis, fassung, formelsatz, stand, wertequelle, viertelstunden_erwartet, "
                + "viertelstunden_gerechnet, rechenwerk_version, vertrag_version, nachweis, pruefsumme) "
                + "VALUES (?, ?, 2027, ?::date, ?::date, (?::date)::timestamptz, (?::date + 1)::timestamptz, ?, 'P1', "
                + "'vorlaeufig', 'geraet', 100, 90, 'MP-25/1', '1.0', ?, ?)", a.mandant(), a.id(), von, bis, von, bis,
                fassung, nachweis, String.format("%064x", fassung + schluessel.hashCode() & 0xffff));
    }

    private Antwort ruf(Anlage a, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, "/api/v1/sites/" + a.id() + pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-mispel-" + a.mandant());
                    j.claim("name", "Sabine Test");
                    j.claim("tenant_id", a.mandant().toString());
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
