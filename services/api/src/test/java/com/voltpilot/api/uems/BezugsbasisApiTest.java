package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
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
 * Bezugsbasis anlegen und Fassung entwerfen (UEMS AP-17 IP-7) — über die Routen, gegen eine echte Datenbank.
 *
 * <p>R1 der Ahrenberg-Welt: KZ-0004 Spritzguss je kg (MS-20 ÷ BZ-1), Oktober 2026 mit 88 630 kWh (Version 1) und
 * 312 400 kg (Fassung 1). Die Kennzahl-Zeile schreibt der Test so, wie der Rechenlauf sie schreibt (Verwaltungsrolle,
 * ungerundeter Wert); die Uhr steht auf dem 12.11.2026, dem Freigabetag von BB-0001 Fassung 1.
 *
 * <p>IP-10 (Modelle, M2–M5): R12/R9 — zwölf Monate Spritzguss (11/2026–10/2027) mit BZ-3 Betriebsstunden und BZ-8
 * Gradtagzahl als zweiter Einflussgröße; R3 — KZ-0006 Gas je Gradtag über BZ-8. Die Reihen sind die der Vektoren
 * (Referenzdatei 1.8, BB-0001 Fassung 2 und BB-0004); die Uhr steht dafür auf dem 12.11.2027.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BezugsbasisApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/kennzahlen";
    private static final Instant FREIGABETAG = Instant.parse("2026-11-12T09:00:00Z");

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
        // Der Stundentakt schreibt selbst Kennzahl-Zeilen — hier schreibt allein der Test.
        registry.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
    }

    @Autowired
    MockMvc mvc;

    @MockBean
    KennzahlAufrufer aufrufer;

    @Autowired
    KennzahlService kennzahlen;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID g2, UUID kz4, UUID kz9) {
        UUID bz1() {
            return root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = 'BZ-1'",
                    UUID.class, mandant);
        }
    }

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void aufruferWieHeute() {
        // Peter Hollerbach ist Bearbeiter an jedem Standort: er sieht die Kennzahl und darf verwalten, nie freigeben.
        doAnswer(inv -> {
            ProtokollAkteur wer = inv.getArgument(0);
            return wer.sub() != null && wer.sub().startsWith("sub-peter-")
                    ? new RechteAbleitung.Benutzer(wer.sub(), wer.name(), RechteAbleitung.Konto.BENUTZER,
                            RechteAbleitung.KontoZustand.AKTIV, List.of(new RechteAbleitung.Zuweisung(
                                    RechteAbleitung.Rolle.BEARBEITER,
                                    root.queryForList("SELECT id::text FROM standort", String.class), null, null, Instant.EPOCH, null, null)))
                    : KorrekturRechte.benutzer(wer);
        }).when(aufrufer).benutzer(any());
        kennzahlen.uhrStellen(Clock.fixed(FREIGABETAG, ZoneOffset.UTC));
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        kennzahlen.uhrStellen(Clock.systemUTC());
    }

    /**
     * R1: Oktober 2026 → Basiswert 0,2837 (Σ ÷ Σ), vorläufig 1 von 12, Grundlage nennt jeden Wert mit Version bzw.
     * Fassung, Prüfsumme stabil bei zweiter Bildung, Vorschau und gespeicherte Kopie byte-gleich, Kennzahl unverändert.
     */
    @Test
    void r1OktoberIstVorlaeufigMitBasiswertUndStabilerPruefsumme() throws Exception {
        Welt w = welt();
        monat(w, "2026-10-01", "88630", "312400", "endgueltig", List.of());
        int kennzahlFassungen = anzahl("kennzahl_fassung", w.kz4());
        int kennzahlWerte = anzahl("kennzahl_wert", w.kz4());

        Antwort angelegt = ruf(w, HttpMethod.POST, PFAD + "/" + w.kz4() + "/bezugsbasen", Map.of("zweck",
                "Spritzguss je kg gegen den Oktober 2026"));
        assertThat(angelegt.status()).as(angelegt.text()).isEqualTo(201);
        assertThat(angelegt.body().get("kennzeichen").asText()).isEqualTo("BB-0001");
        assertThat(angelegt.body().get("kennzahl").asText()).isEqualTo("KZ-0004");
        assertThat(angelegt.body().get("verantwortlich_name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(angelegt.body().get("fassungen")).isEmpty();
        String basis = PFAD + "/" + w.kz4() + "/bezugsbasen/" + angelegt.body().get("id").asText();

        Antwort erste = ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf("2026-10/2026-10", "verhaeltnis"));
        assertThat(erste.status()).as(erste.text()).isEqualTo(200);
        JsonNode f = erste.body();
        assertThat(f.get("fassung").asInt()).isEqualTo(1);
        assertThat(f.get("bezugsbasis").asText()).isEqualTo("BB-0001");
        assertThat(f.get("basiswert").asText()).isEqualTo("0.2837");
        assertThat(f.get("datenlage").asText()).isEqualTo("vorlaeufig");
        assertThat(f.get("monate").asInt()).isEqualTo(1);
        assertThat(f.get("mindest_monate").asInt()).isEqualTo(12);
        assertThat(f.get("vorbehalte").get(0).asText()).isEqualTo("Bezugsbasis vorläufig (1 von 12 Monaten)");
        assertThat(f.get("datenlage_gruende").get(0).get("grund").asText()).isEqualTo("monate");
        assertThat(f.get("freigabe_status").asText()).isEqualTo("entwurf");
        assertThat(f.get("gilt_ab").asText()).isEqualTo("2026-11-01");
        assertThat(f.get("toleranz_prozent").asText()).isEqualTo("2");
        assertThat(f.get("wiedervorlage_monate").asInt()).isEqualTo(12);
        assertThat(f.get("variablen").get(0).get("kennzeichen").asText()).isEqualTo("BZ-1");
        assertThat(f.get("variablen").get(0).get("fassung").asInt()).isEqualTo(1);
        assertThat(f.get("variablen").get(0).get("spannweite_von").asText()).isEqualTo("312400");

        // Die Grundlage nennt jeden Wert mit Version bzw. Fassung (F3) — und ihre Prüfsumme ist die ihres Texts.
        JsonNode g = f.get("grundlage");
        JsonNode oktober = g.get("perioden").get(0);
        assertThat(oktober.get("periode").asText()).isEqualTo("2026-10");
        assertThat(oktober.at("/kennzahl/version").asInt()).isEqualTo(1);
        assertThat(oktober.at("/kennzahl/definition_fassung").asInt()).isEqualTo(1);
        assertThat(oktober.at("/kennzahl/zustand").asText()).isEqualTo("endgueltig");
        assertThat(oktober.at("/eingaenge/0/objekt").asText()).isEqualTo("MS-20");
        assertThat(oktober.at("/eingaenge/0/wert").decimalValue()).isEqualByComparingTo("88630");
        assertThat(oktober.at("/eingaenge/0/version").asInt()).isEqualTo(1);
        assertThat(oktober.at("/eingaenge/1/objekt").asText()).isEqualTo("BZ-1");
        assertThat(oktober.at("/eingaenge/1/fassung").asInt()).isEqualTo(1);
        assertThat(g.get("basiswert").decimalValue()).isEqualByComparingTo("0.2837");
        String text = root.queryForObject("SELECT grundlage FROM bezugsbasis_fassung WHERE bezugsbasis_id = ?",
                String.class, UUID.fromString(angelegt.body().get("id").asText()));
        assertThat(erste.text()).contains("\"grundlage\":" + text + ",");
        assertThat(f.get("pruefsumme").asText()).isEqualTo(BezugsbasisGrundlage.pruefsumme(text))
                .isEqualTo(root.queryForObject("SELECT bericht_pruefsumme(?)", String.class, text));
        // Der gespeicherte Text ist schon kanonisch (Zahlen exakt gelesen, nie als double).
        assertThat(BezugsbasisGrundlage.kanonisch(MAPPER.copy()
                .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS).readTree(text))).isEqualTo(text);

        // Zweite Bildung: derselbe offene Entwurf, dieselbe Prüfsumme; der Leser liefert dieselben Bytes.
        Antwort zweite = ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf("2026-10/2026-10", "verhaeltnis"));
        assertThat(zweite.status()).as(zweite.text()).isEqualTo(200);
        assertThat(zweite.body().get("fassung").asInt()).isEqualTo(1);
        assertThat(zweite.body().get("pruefsumme").asText()).isEqualTo(f.get("pruefsumme").asText());
        Antwort gelesen = ruf(w, HttpMethod.GET, basis + "/fassungen/1", null);
        assertThat(gelesen.status()).isEqualTo(200);
        assertThat(gelesen.text()).isEqualTo(zweite.text());
        assertThat(ruf(w, HttpMethod.GET, basis + "/fassungen/2", null).status()).isEqualTo(404);
        JsonNode eine = ruf(w, HttpMethod.GET, basis, null).body();
        assertThat(eine.get("fassungen")).hasSize(1);
        assertThat(eine.at("/fassungen/0/pruefsumme").asText()).isEqualTo(f.get("pruefsumme").asText());

        // Protokoll: jeder Schritt; die Kennzahl merkt nichts (B1).
        assertThat(root.queryForList("SELECT art FROM bezugsbasis_aenderung WHERE tenant_id = ? ORDER BY id",
                String.class, w.mandant())).containsExactly("bezugsbasis_angelegt", "fassung_entworfen",
                        "fassung_entworfen");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_variable WHERE tenant_id = ? "
                + "AND aufgehoben_am IS NULL", Integer.class, w.mandant())).isEqualTo(1);
        assertThat(anzahl("kennzahl_fassung", w.kz4())).isEqualTo(kennzahlFassungen);
        assertThat(anzahl("kennzahl_wert", w.kz4())).isEqualTo(kennzahlWerte);

        // Löschweg der Variablen: lesbare 409 statt eines Fremdschlüssel-Fehlers.
        UUID bz1 = root.queryForObject("SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = 'BZ-1'",
                UUID.class, w.mandant());
        Antwort loeschen = ruf(w, HttpMethod.DELETE, "/api/v1/bezugsgroessen/" + bz1, null);
        assertThat(loeschen.status()).as(loeschen.text()).isEqualTo(409);
        assertThat(loeschen.body().get("code").asText()).isEqualTo("bezugsgroesse_in_verwendung");
        assertThat(loeschen.body().get("bezugsbasen").get(0).asText()).isEqualTo("BB-0001");
    }

    /** P2/P3: ein angeschnittener Monat und ein vorläufiger Wert machen die Fassung vorläufig — mit Grund. */
    @Test
    void angeschnittenUndVorlaeufigeWerteSindGruendeDerDatenlage() throws Exception {
        Welt w = welt();
        monat(w, "2026-09-01", "44000", "150000", "vorlaeufig", List.of("ab 15.09.2026"));
        monat(w, "2026-10-01", "88630", "312400", "endgueltig", List.of());
        String basis = basis(w, w.kz4());
        Antwort a = ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf("2026-08/2026-10", "verhaeltnis"));
        assertThat(a.status()).as(a.text()).isEqualTo(200);
        // Σ ÷ Σ: (44 000 + 88 630) ÷ (150 000 + 312 400) = 0,28683…, nie das Mittel der Monatsquotienten.
        assertThat(a.body().get("basiswert").asText()).isEqualTo("0.2868");
        assertThat(a.body().get("monate").asInt()).isEqualTo(2);
        JsonNode gruende = a.body().get("datenlage_gruende");
        assertThat(gruende.get(0).get("ohne_wert").get(0).asText()).isEqualTo("2026-08");
        assertThat(gruende.get(1).get("grund").asText()).isEqualTo("angeschnitten");
        assertThat(gruende.get(1).get("ab").asText()).isEqualTo("15.09.2026");
        assertThat(gruende.get(2).get("grund").asText()).isEqualTo("vorlaeufige_werte");
        assertThat(a.body().at("/grundlage/perioden/0/grund").asText()).isEqualTo("noch_nicht_gebildet");
        assertThat(a.body().at("/variablen/0/spannweite_bis").asText()).isEqualTo("312400");
    }

    @Test
    void zweiteLaufendeBasisIst409() throws Exception {
        Welt w = welt();
        basis(w, w.kz4());
        Antwort zweite = ruf(w, HttpMethod.POST, PFAD + "/" + w.kz4() + "/bezugsbasen", null);
        assertThat(zweite.status()).isEqualTo(409);
        assertThat(zweite.body().get("code").asText()).isEqualTo("bezugsbasis_laeuft");
        assertThat(zweite.body().get("bezugsbasis").asText()).isEqualTo("BB-0001");
    }

    @Test
    void referenzperiodeMethodeUndTraegerWerdenStrengGeprueft() throws Exception {
        Welt w = welt();
        monat(w, "2026-10-01", "88630", "312400", "endgueltig", List.of());
        String basis = basis(w, w.kz4());
        abgelehnt(w, basis, entwurf("2026-10/2026-11", "verhaeltnis"), 422, "periode_nicht_zu_ende");
        abgelehnt(w, basis, entwurf("2026-10", "verhaeltnis"), 422, "referenzperiode_format");
        abgelehnt(w, basis, entwurf("2026-10/2026-09", "verhaeltnis"), 422, "referenzperiode_reihenfolge");
        abgelehnt(w, basis, entwurf("2026-10/2026-10", "regression_eine_variable"), 422, "zu_wenig_perioden");
        abgelehnt(w, basis, entwurf("2026-10/2026-10", "mittelwert"), 422, "methode_unbekannt");
        abgelehnt(w, basis, entwurf("2026-08/2026-09", "verhaeltnis"), 422, "keine_werte");
        Map<String, Object> fremd = entwurf("2026-10/2026-10", "verhaeltnis");
        fremd.put("variablen", List.of(UUID.randomUUID().toString()));
        abgelehnt(w, basis, fremd, 422, "variable_nicht_nenner");
        Map<String, Object> unbekannt = entwurf("2026-10/2026-10", "verhaeltnis");
        unbekannt.put("basiswert", "0.3");
        abgelehnt(w, basis, unbekannt, 400, "anfrage_ungueltig");
        // B2: ein Anteil trägt nie eine Bezugsbasis.
        Antwort anteil = ruf(w, HttpMethod.POST, PFAD + "/" + w.kz9() + "/bezugsbasen", null);
        assertThat(anteil.status()).isEqualTo(422);
        assertThat(anteil.body().get("code").asText()).isEqualTo("kennzahl_ohne_bezugsbasis");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_fassung WHERE tenant_id = ?", Integer.class,
                w.mandant())).isZero();
    }

    /** Zaun: ein anderer Kundenbereich sieht weder Basis noch Fassung und kann nichts entwerfen. */
    @Test
    void mandantBSiehtNichts() throws Exception {
        Welt a = welt();
        monat(a, "2026-10-01", "88630", "312400", "endgueltig", List.of());
        String basis = basis(a, a.kz4());
        assertThat(ruf(a, HttpMethod.POST, basis + "/fassungen", entwurf("2026-10/2026-10", "verhaeltnis")).status())
                .isEqualTo(200);
        Welt b = welt();
        assertThat(ruf(b, HttpMethod.GET, basis, null).status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.GET, basis + "/fassungen/1", null).status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.POST, basis + "/fassungen", entwurf("2026-10/2026-10", "verhaeltnis")).status())
                .isEqualTo(404);
        assertThat(ruf(b, HttpMethod.POST, PFAD + "/" + a.kz4() + "/bezugsbasen", null).status()).isEqualTo(404);
        // Mit der eigenen Kennzahl, aber der fremden Basis: ebenfalls nicht da.
        String fremdeBasis = basis.replace(a.kz4().toString(), b.kz4().toString());
        assertThat(ruf(b, HttpMethod.GET, fremdeBasis, null).status()).isEqualTo(404);
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis WHERE tenant_id = ?", Integer.class,
                b.mandant())).isZero();
    }

    // ------------------------------------------------------------------------------------------------ IP-10 Modelle

    private static final Instant NACH_DER_REFERENZPERIODE = Instant.parse("2027-11-12T09:00:00Z");
    private static final String ZWOELF = "2026-11/2027-10";
    /** R12: kWh MS-20 und kg BZ-1, November 2026 bis Oktober 2027 (Referenzdatei 1.8 BB-0001 Fassung 2). */
    private static final String[][] SPRITZGUSS = {{"85581", "318000"}, {"71729", "262000"}, {"81291", "298000"},
        {"81298", "305000"}, {"88265", "331000"}, {"82016", "309000"}, {"86399", "322000"}, {"86846", "327000"},
        {"80732", "296000"}, {"69693", "254000"}, {"89512", "336000"}, {"89638", "341000"}};
    /** R9: BZ-3 Betriebsstunden, hängen an der Produktionsmenge (r = 0,997). */
    private static final String[] BETRIEBSSTUNDEN = {"5112", "4149", "4778", "4819", "5314", "4908", "5151", "5165",
        "4751", "4026", "5404", "5419"};
    /** R3: BZ-8 Gradtagzahl Werk Ahrenberg (Kd) und der Gasbezug (m³) der Verwaltung (BB-0004). */
    private static final String[] GRADTAGE = {"415", "555", "605", "515", "395", "245", "95", "15", "0", "0", "85", "300"};
    private static final String[] GAS = {"1742", "2169", "2489", "2037", "1676", "986", "511", "152", "155", "90", "483",
        "1205"};

    /**
     * R12 + R9/G4 + M2: das Modell mit einer Einflussgröße rechnet a = 10 523, b = 0,2343, R² 0,991, Streuung 0,8 %,
     * Spannweite 254 000–341 000 kg — eingefroren an der Fassung; BZ-3 als zweite Variable wird abgelehnt (r = 0,997)
     * und steht im Protokoll; eine unabhängige zweite Variable (Gradtagzahl) rechnet mit c.
     */
    @Test
    void r12ModellMitEinerEinflussgroesseUndAbgelehnteBetriebsstunden() throws Exception {
        kennzahlen.uhrStellen(Clock.fixed(NACH_DER_REFERENZPERIODE, ZoneOffset.UTC));
        Welt w = welt();
        for (int i = 0; i < 12; i++) {
            monat(w, monat(i), SPRITZGUSS[i][0], SPRITZGUSS[i][1], "endgueltig", List.of());
        }
        UUID bz3 = bezugsgroesse(w, "BZ-3", "Betriebsstunden Spritzguss", "h", null, BETRIEBSSTUNDEN);
        UUID bz8 = bezugsgroesse(w, "BZ-8", "Gradtagzahl Werk Ahrenberg", "Kd", "gradtagzahl", GRADTAGE);
        String basis = basis(w, w.kz4());

        Antwort eine = ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf(ZWOELF, "regression_eine_variable"));
        assertThat(eine.status()).as(eine.text()).isEqualTo(200);
        JsonNode f = eine.body();
        assertThat(f.get("methode").asText()).isEqualTo("regression_eine_variable");
        assertThat(f.get("monate").asInt()).isEqualTo(12);
        assertThat(f.get("datenlage").asText()).isEqualTo("vollstaendig");
        // M5: vier Stellen; die Referenzdatei 1.8 trägt a auf ganze kWh (10 523) — auf ihre Stellen gerundet gleich.
        assertThat(f.at("/koeffizienten/a").asText()).isEqualTo("10522.6206");
        assertThat(new BigDecimal(f.at("/koeffizienten/a").asText()).setScale(0, RoundingMode.HALF_UP))
                .isEqualByComparingTo("10523");
        assertThat(f.at("/koeffizienten/b").asText()).isEqualTo("0.2343");
        assertThat(f.at("/koeffizienten/c").isMissingNode()).isTrue();
        assertThat(f.get("r2").asText()).isEqualTo("0.991");
        assertThat(f.get("streuung_prozent").asText()).isEqualTo("0.8");
        assertThat(f.get("basiswert").asText()).isEqualTo("0.2685");
        assertThat(f.get("variablen")).hasSize(1);
        assertThat(f.at("/variablen/0/spannweite_von").asText()).isEqualTo("254000");
        assertThat(f.at("/variablen/0/spannweite_bis").asText()).isEqualTo("341000");
        assertThat(f.get("abgelehnte_variablen")).isEmpty();
        assertThat(f.get("kennzeichen")).isEmpty();
        // M4: eingefroren in der Grundlage (mit Toleranzband) und in den Spalten der Fassung.
        JsonNode g = f.get("grundlage");
        assertThat(g.at("/koeffizienten/a").decimalValue()).isEqualByComparingTo("10522.6206");
        assertThat(g.at("/variablen/0/spannweite/toleriert_von").decimalValue()).isEqualByComparingTo("228600");
        assertThat(g.at("/variablen/0/spannweite/toleriert_bis").decimalValue()).isEqualByComparingTo("375100");
        assertThat(root.queryForObject("SELECT r2::text || ' ' || streuung_prozent::text || ' ' || (koeffizienten->>'b') "
                + "FROM bezugsbasis_fassung WHERE tenant_id = ?", String.class, w.mandant())).isEqualTo("0.991 0.8 0.2343");
        Antwort gelesen = ruf(w, HttpMethod.GET, basis + "/fassungen/1", null);
        assertThat(gelesen.text()).isEqualTo(eine.text());

        // R9/G4: BZ-3 hängt an der Produktionsmenge — nicht aufgenommen, die Fassung rechnet mit einer Variablen.
        Map<String, Object> zwei = entwurf(ZWOELF, "regression_zwei_variablen");
        zwei.put("variablen", List.of(bz3.toString()));
        Antwort abhaengig = ruf(w, HttpMethod.POST, basis + "/fassungen", zwei);
        assertThat(abhaengig.status()).as(abhaengig.text()).isEqualTo(200);
        assertThat(abhaengig.body().get("methode").asText()).isEqualTo("regression_eine_variable");
        assertThat(abhaengig.body().at("/koeffizienten/b").asText()).isEqualTo("0.2343");
        assertThat(abhaengig.body().at("/abgelehnte_variablen/0/objekt").asText()).isEqualTo("BZ-3");
        assertThat(abhaengig.body().at("/abgelehnte_variablen/0/grund").asText()).isEqualTo("variablen_abhaengig");
        assertThat(abhaengig.body().at("/abgelehnte_variablen/0/r").decimalValue()).isEqualByComparingTo("0.997");
        assertThat(abhaengig.body().get("variablen")).hasSize(1);
        assertThat(root.queryForList("SELECT art FROM bezugsbasis_aenderung WHERE tenant_id = ? ORDER BY id",
                String.class, w.mandant())).containsExactly("bezugsbasis_angelegt", "fassung_entworfen",
                        "fassung_entworfen", "variable_abgelehnt");
        assertThat(root.queryForObject("SELECT neu->>'r' FROM bezugsbasis_aenderung WHERE tenant_id = ? "
                + "AND art = 'variable_abgelehnt'", String.class, w.mandant())).isEqualTo("0.997");

        // M2 (konstruiert): die Gradtagzahl ist von der Produktionsmenge unabhängig (r = −0,095) — zwei Einflussgrößen.
        zwei.put("variablen", List.of(w.bz1().toString(), bz8.toString()));
        Antwort unabhaengig = ruf(w, HttpMethod.POST, basis + "/fassungen", zwei);
        assertThat(unabhaengig.status()).as(unabhaengig.text()).isEqualTo(200);
        JsonNode u = unabhaengig.body();
        assertThat(u.get("methode").asText()).isEqualTo("regression_zwei_variablen");
        assertThat(u.at("/koeffizienten/a").asText()).isEqualTo("10511.8791");
        assertThat(u.at("/koeffizienten/c").asText()).isEqualTo("0.021");
        assertThat(u.get("variablen")).hasSize(2);
        assertThat(u.at("/variablen/1/kennzeichen").asText()).isEqualTo("BZ-8");
        assertThat(u.at("/variablen/1/fassung").asInt()).isEqualTo(1);
        assertThat(u.at("/variablen/1/spannweite_bis").asText()).isEqualTo("605");
        assertThat(u.at("/grundlage/perioden/0/variablen/0/wert").decimalValue()).isEqualByComparingTo("415");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_variable WHERE tenant_id = ? "
                + "AND aufgehoben_am IS NULL", Integer.class, w.mandant())).isEqualTo(2);
        assertThat(ruf(w, HttpMethod.GET, basis + "/fassungen/1", null).text()).isEqualTo(unabhaengig.text());

        // Zurück zum Verhältnis: der neu gebildete Entwurf trägt keine alten Koeffizienten weiter.
        Antwort verhaeltnis = ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf(ZWOELF, "verhaeltnis"));
        assertThat(verhaeltnis.body().get("koeffizienten").isNull()).isTrue();
        assertThat(verhaeltnis.body().get("r2").isNull()).isTrue();
    }

    /** G1, G2 und die Prüfung der Variablen beim Bilden — jeweils ein Grund statt einer Zahl, nichts gespeichert. */
    @Test
    void grenzenBeimBildenEinesModells() throws Exception {
        kennzahlen.uhrStellen(Clock.fixed(NACH_DER_REFERENZPERIODE, ZoneOffset.UTC));
        Welt w = welt();
        for (int i = 0; i < 12; i++) {
            monat(w, monat(i), SPRITZGUSS[i][0], SPRITZGUSS[i][1], "endgueltig", List.of());
        }
        String basis = basis(w, w.kz4());
        // G1 (Lindach-Muster): ein Monat trägt kein Modell — „1 von 12“; das Verhältnis rechnet daraus vorläufig.
        Antwort einer = ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf("2027-10/2027-10", "regression_eine_variable"));
        assertThat(einer.status()).as(einer.text()).isEqualTo(422);
        assertThat(einer.body().get("code").asText()).isEqualTo("zu_wenig_perioden");
        assertThat(einer.body().get("monate").asInt()).isEqualTo(1);
        assertThat(einer.body().get("mindest_monate").asInt()).isEqualTo(12);
        assertThat(einer.body().get("message").asText()).contains("1 von 12 Monaten");
        // G2: der Variablen fehlt der Oktober 2027 — kein Modell, der Monat wird genannt.
        UUID luecke = bezugsgroesse(w, "BZ-3", "Betriebsstunden Spritzguss", "h", null,
                java.util.Arrays.copyOf(GRADTAGE, 11));
        Map<String, Object> zwei = entwurf(ZWOELF, "regression_zwei_variablen");
        zwei.put("variablen", List.of(luecke.toString()));
        Antwort fehlt = ruf(w, HttpMethod.POST, basis + "/fassungen", zwei);
        assertThat(fehlt.status()).as(fehlt.text()).isEqualTo(422);
        assertThat(fehlt.body().get("code").asText()).isEqualTo("variable_fehlt");
        assertThat(fehlt.body().get("variable").asText()).isEqualTo("BZ-3");
        assertThat(fehlt.body().get("perioden").get(0).asText()).isEqualTo("2027-10");
        // V2/V5 und M3: die Variablen passen zur Methode.
        zwei.put("variablen", List.of());
        abgelehnt(w, basis, zwei, 422, "zweite_variable_fehlt");
        zwei.put("variablen", List.of(UUID.randomUUID().toString()));
        abgelehnt(w, basis, zwei, 422, "variable_unbekannt");
        Map<String, Object> eine = entwurf(ZWOELF, "regression_eine_variable");
        eine.put("variablen", List.of(luecke.toString()));
        abgelehnt(w, basis, eine, 422, "variable_nicht_nenner");
        abgelehnt(w, basis, entwurf(ZWOELF, "gradtage"), 422, "variable_keine_gradtagzahl");
        assertThat(root.queryForObject("SELECT count(*) FROM bezugsbasis_fassung WHERE tenant_id = ?", Integer.class,
                w.mandant())).isZero();
    }

    /**
     * R3/M3: Gas je Gradtag über zwölf Monate → a = 119 m³ (witterungsunabhängig), b = 3,80 m³ je Kd; die zwei Monate
     * ohne Gradtage (Kennzahl ohne Zahl, {@code nenner_null}) sind Paare des Modells. Das Verhältnis über dieselbe
     * Gradtagzahl trägt „ohne Grundlast“ und zählt diese Monate nicht.
     */
    @Test
    void r3GasUeberGradtageMitKonstante() throws Exception {
        kennzahlen.uhrStellen(Clock.fixed(NACH_DER_REFERENZPERIODE, ZoneOffset.UTC));
        Welt w = welt();
        bezugsgroesse(w, "BZ-8", "Gradtagzahl Werk Ahrenberg", "Kd", "gradtagzahl", GRADTAGE);
        UUID kz6 = kennzahl(w, "KZ-0006", "quotient", e("zaehler", "messstelle", "MS-19"),
                e("nenner", "bezugsgroesse", "BZ-8"));
        for (int i = 0; i < 12; i++) {
            monat(w, kz6, "MS-19", "BZ-8", "Kd", monat(i), GAS[i], GRADTAGE[i]);
        }
        String basis = basis(w, kz6);
        Antwort gradtage = ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf(ZWOELF, "gradtage"));
        assertThat(gradtage.status()).as(gradtage.text()).isEqualTo(200);
        JsonNode f = gradtage.body();
        assertThat(f.get("methode").asText()).isEqualTo("gradtage");
        assertThat(f.get("monate").asInt()).isEqualTo(12);
        assertThat(f.at("/koeffizienten/a").asText()).isEqualTo("118.9104");
        assertThat(f.at("/koeffizienten/b").asText()).isEqualTo("3.8041");
        // Referenzdatei 1.8 BB-0004: a = 119, b = 3,8 — auf ihre Stellen gerundet dieselben Zahlen.
        assertThat(new BigDecimal(f.at("/koeffizienten/a").asText()).setScale(0, RoundingMode.HALF_UP))
                .isEqualByComparingTo("119");
        assertThat(new BigDecimal(f.at("/koeffizienten/b").asText()).setScale(2, RoundingMode.HALF_UP))
                .isEqualByComparingTo("3.80");
        assertThat(f.get("r2").asText()).isEqualTo("0.997");
        assertThat(f.get("streuung_prozent").asText()).isEqualTo("4.6");
        assertThat(f.at("/variablen/0/spannweite_von").asText()).isEqualTo("0");
        assertThat(f.at("/variablen/0/spannweite_bis").asText()).isEqualTo("605");
        assertThat(f.at("/grundlage/perioden/8/kennzahl/grund").asText()).isEqualTo("nenner_null");

        Antwort verhaeltnis = ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf(ZWOELF, "verhaeltnis"));
        assertThat(verhaeltnis.status()).as(verhaeltnis.text()).isEqualTo(200);
        assertThat(verhaeltnis.body().get("kennzeichen").get(0).asText()).isEqualTo("ohne Grundlast");
        assertThat(verhaeltnis.body().get("monate").asInt()).isEqualTo(10);
        assertThat(verhaeltnis.body().get("koeffizienten").isNull()).isTrue();
    }

    private static String monat(int i) {
        return LocalDate.parse("2026-11-01").plusMonths(i).toString();
    }

    /** Eine Bezugsgröße der Geltung G-2 (bzw. ST-1 für eine Gradtagzahl) mit wirksamen Monatswerten ab 11/2026. */
    private static UUID bezugsgroesse(Welt w, String kennzeichen, String name, String einheit, String art,
            String[] werte) {
        boolean standort = "gradtagzahl".equals(art);
        UUID st1 = root.queryForObject("SELECT id FROM standort WHERE tenant_id = ? AND kurzzeichen = 'ST-1'", UUID.class,
                w.mandant());
        UUID id = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, ort_id, standort_id, art) VALUES (?, ?, ?, 'periodenwert', ?, 'monat', ?, ?, "
                + "?, ?) RETURNING id", UUID.class, w.mandant(), kennzeichen, name, einheit,
                standort ? "standort" : "gebaeude", standort ? null : w.g2(), standort ? st1 : null, art);
        for (int i = 0; i < werte.length; i++) {
            LocalDate von = LocalDate.parse(monat(i));
            // Erfasst nach dem Monatsende (abgeschlossen_chk) — die Monate liegen hinter der echten Uhr der Datenbank.
            Timestamp erfasst = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(86400));
            root.update("INSERT INTO bezugsgroesse_wert (tenant_id, bezugsgroesse_id, wertart, einheit, periode_art, "
                    + "periode_von, periode_bis, zeitzone, fassung, vorgang, status, betrag, herkunft_art, actor_sub, "
                    + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'periodenwert', ?, 'monat', ?, ?, "
                    + "'Europe/Berlin', 1, 'erstwert', 'wirksam', ?, 'eingabe', 'IK', 'Ines Kaltenbach', 'energiemanager', "
                    + "'kunde', ?)", w.mandant(), id, einheit, Date.valueOf(von), Date.valueOf(von.plusMonths(1).minusDays(1)),
                    new BigDecimal(werte[i]), erfasst);
        }
        return id;
    }

    /**
     * R1 (F1): Ines Kaltenbach gibt Fassung 1 von BB-0001 am 12.11.2026 frei — ohne Vier-Augen direkt, mit
     * Begründung; danach ist sie eingefroren, die Wiedervorlage beginnt, und die Kennzahl trägt die Basis-Zeile (B3).
     */
    @Test
    void r1FreigabeOhneVierAugenMitBegruendung() throws Exception {
        Welt w = welt();
        monat(w, "2026-10-01", "88630", "312400", "endgueltig", List.of());
        String basis = basis(w, w.kz4());
        assertThat(ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf("2026-10/2026-10", "verhaeltnis")).status())
                .isEqualTo(200);
        JsonNode register = registerEintrag(w, w.kz4());
        assertThat(register.at("/bezugsbasis/kennzeichen").asText()).isEqualTo("BB-0001");
        assertThat(register.at("/bezugsbasis/fassung").asInt()).isEqualTo(1);
        assertThat(register.at("/bezugsbasis/freigabe_status").asText()).isEqualTo("entwurf");
        assertThat(register.at("/bezugsbasis/vorlaeufig").asBoolean()).isTrue();
        assertThat(registerEintrag(w, w.kz9()).get("bezugsbasis").isNull()).isTrue();

        entscheid(w, "ines", basis, 1, "beantragen", "Oktober 2026 als erster Maßstab", 409, "vieraugen_aus");
        entscheid(w, "ines", basis, 1, "freigeben", null, 422, "begruendung_fehlt");
        entscheid(w, "ines", basis, 1, "freigeben", "zu kurz", 422, "begruendung_fehlt");
        entscheid(w, "ines", basis, 1, "freigeben", "x".repeat(501), 422, "begruendung_fehlt");
        entscheid(w, "peter", basis, 1, "freigeben", "Oktober 2026 als erster Maßstab", 403, "recht_fehlt");
        Antwort frei = entscheid(w, "ines", basis, 1, "freigeben", "  Oktober 2026 als erster Maßstab  ", 200, null);
        JsonNode f = frei.body();
        assertThat(f.get("freigabe_status").asText()).isEqualTo("freigegeben");
        assertThat(f.get("begruendung").asText()).isEqualTo("Oktober 2026 als erster Maßstab");
        assertThat(f.get("vieraugen").asBoolean()).isFalse();
        assertThat(f.at("/freigabe/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(f.at("/freigabe/rolle").asText()).isEqualTo("kundenadministrator");
        assertThat(f.get("entscheidung").isNull()).isTrue();
        assertThat(f.get("freigegeben_am").isNull()).isFalse();
        assertThat(f.get("gilt_bis").isNull()).isTrue();
        assertThat(f.get("anpassungsgruende")).isEmpty();
        assertThat(ruf(w, HttpMethod.GET, basis + "/fassungen/1", null).text()).isEqualTo(frei.text());

        // Entschieden ist entschieden: kein zweites Freigeben, kein Antrag, keine Ablehnung.
        entscheid(w, "ines", basis, 1, "freigeben", "Oktober 2026 als erster Maßstab", 409, "fassung_freigegeben");
        entscheid(w, "ines", basis, 1, "ablehnen", "Oktober 2026 passt doch nicht", 409, "fassung_freigegeben");
        entscheid(w, "ines", basis, 9, "freigeben", "Oktober 2026 als erster Maßstab", 404, "nicht_gefunden");

        // B3: die Register-Zeile und die Einzel-Kennzahl tragen die freigegebene Basis; die Liste hat die Form der Einzel-Basis.
        register = registerEintrag(w, w.kz4());
        assertThat(register.at("/bezugsbasis/freigabe_status").asText()).isEqualTo("freigegeben");
        assertThat(register.at("/bezugsbasis/fassung").asInt()).isEqualTo(1);
        assertThat(register.at("/bezugsbasis/vorlaeufig").asBoolean()).isTrue();
        assertThat(ruf(w, HttpMethod.GET, PFAD + "/" + w.kz4(), null).body().get("bezugsbasis"))
                .isEqualTo(register.get("bezugsbasis"));
        JsonNode liste = ruf(w, HttpMethod.GET, PFAD + "/" + w.kz4() + "/bezugsbasen", null).body();
        assertThat(liste.get("bezugsbasen")).hasSize(1);
        assertThat(liste.at("/bezugsbasen/0")).isEqualTo(ruf(w, HttpMethod.GET, basis, null).body());
        assertThat(liste.at("/bezugsbasen/0/fassungen/0/freigabe_status").asText()).isEqualTo("freigegeben");
        assertThat(root.queryForList("SELECT art FROM bezugsbasis_aenderung WHERE tenant_id = ? ORDER BY id",
                String.class, w.mandant())).containsExactly("bezugsbasis_angelegt", "fassung_entworfen",
                        "fassung_freigegeben");
        assertThat(root.queryForObject("SELECT begruendung FROM bezugsbasis_aenderung WHERE tenant_id = ? "
                + "AND art = 'fassung_freigegeben'", String.class, w.mandant())).isEqualTo("Oktober 2026 als erster Maßstab");
    }

    /**
     * F2: mit Vier-Augen beantragt Ines, der Urheber darf nicht bestätigen (422), ein Bearbeiter nicht (403); Jonas
     * lehnt mit Begründung ab — danach ist ein neuer Entwurf möglich, der als Fassung 2 einen Anpassungsgrund nennt,
     * und Jonas gibt ihn als zweite Person frei.
     */
    @Test
    void vierAugenZweitePersonUndAblehnung() throws Exception {
        Welt w = welt();
        monat(w, "2026-10-01", "88630", "312400", "endgueltig", List.of());
        root.update("UPDATE unternehmen SET vieraugen_freigabe = true WHERE tenant_id = ?", w.mandant());
        String basis = basis(w, w.kz4());
        assertThat(ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf("2026-10/2026-10", "verhaeltnis")).status())
                .isEqualTo(200);
        entscheid(w, "ines", basis, 1, "freigeben", "Oktober 2026 als erster Maßstab", 409, "vieraugen_beantragen");
        entscheid(w, "ines", basis, 1, "ablehnen", "Oktober 2026 als erster Maßstab", 409, "fassung_entwurf");
        entscheid(w, "ines", basis, 1, "beantragen", "kurz", 422, "begruendung_fehlt");
        // Wer beantragt, ist die Freigabe-Person (bezugsbasis_fassung_freigabe_chk): der Bearbeiter nicht.
        entscheid(w, "peter", basis, 1, "beantragen", "Oktober 2026 als erster Maßstab", 403, "recht_fehlt");
        JsonNode antrag = entscheid(w, "ines", basis, 1, "beantragen", "Oktober 2026 als erster Maßstab", 200, null)
                .body();
        assertThat(antrag.get("freigabe_status").asText()).isEqualTo("beantragt");
        assertThat(antrag.get("vieraugen").asBoolean()).isTrue();
        assertThat(antrag.at("/freigabe/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(antrag.get("freigegeben_am").isNull()).isTrue();
        abgelehnt(w, basis, entwurf("2026-10/2026-10", "verhaeltnis"), 409, "fassung_beantragt");

        entscheid(w, "ines", basis, 1, "freigeben", null, 422, "vieraugen_urheber");
        entscheid(w, "peter", basis, 1, "freigeben", null, 403, "recht_fehlt");
        entscheid(w, "jonas", basis, 1, "ablehnen", null, 422, "begruendung_fehlt");
        JsonNode ab = entscheid(w, "jonas", basis, 1, "ablehnen", "Ein einzelner Monat ist kein Maßstab", 200, null)
                .body();
        assertThat(ab.get("freigabe_status").asText()).isEqualTo("abgelehnt");
        assertThat(ab.at("/entscheidung/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(ab.get("entscheidungs_begruendung").asText()).isEqualTo("Ein einzelner Monat ist kein Maßstab");
        entscheid(w, "jonas", basis, 1, "freigeben", null, 409, "fassung_abgelehnt");

        // Nach der Ablehnung: neuer Entwurf = Fassung 2, mit Anpassungsgrund (A1) und Begründung.
        Map<String, Object> zwei = entwurf("2026-10/2026-10", "verhaeltnis");
        abgelehnt(w, basis, zwei, 422, "anpassungsgrund_fehlt");
        zwei.put("anpassungsgruende", List.of("sonstiger"));
        abgelehnt(w, basis, zwei, 422, "anpassung_wortlaut");
        zwei.put("anpassungsgruende", List.of("grundlage_korrigiert", "unbekannt"));
        abgelehnt(w, basis, zwei, 422, "anpassungsgrund_unbekannt");
        zwei.put("anpassungsgruende", List.of("sonstiger"));
        zwei.put("anpassung_wortlaut", "Rückfrage der Geschäftsführung");
        abgelehnt(w, basis, zwei, 422, "begruendung_fehlt");
        zwei.put("begruendung", "Nach Rückfrage bleibt der Oktober der Maßstab");
        Antwort entwurf2 = ruf(w, HttpMethod.POST, basis + "/fassungen", zwei);
        assertThat(entwurf2.status()).as(entwurf2.text()).isEqualTo(200);
        assertThat(entwurf2.body().get("fassung").asInt()).isEqualTo(2);
        assertThat(entwurf2.body().get("anpassungsgruende").get(0).asText()).isEqualTo("sonstiger");
        assertThat(entwurf2.body().get("anpassung_wortlaut").asText()).isEqualTo("Rückfrage der Geschäftsführung");

        // Die Begründung des Entwurfs trägt den Antrag; Jonas bestätigt als zweite Person.
        entscheid(w, "ines", basis, 2, "beantragen", null, 200, null);
        JsonNode frei = entscheid(w, "jonas", basis, 2, "freigeben", null, 200, null).body();
        assertThat(frei.get("freigabe_status").asText()).isEqualTo("freigegeben");
        assertThat(frei.get("begruendung").asText()).isEqualTo("Nach Rückfrage bleibt der Oktober der Maßstab");
        assertThat(frei.at("/freigabe/name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(frei.at("/entscheidung/name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(frei.at("/entscheidung/rolle").asText()).isEqualTo("kundenadministrator");
        assertThat(frei.get("freigegeben_am").isNull()).isFalse();
        assertThat(root.queryForList("SELECT art FROM bezugsbasis_aenderung WHERE tenant_id = ? ORDER BY id",
                String.class, w.mandant())).containsExactly("bezugsbasis_angelegt", "fassung_entworfen",
                        "fassung_beantragt", "fassung_abgelehnt", "fassung_entworfen", "fassung_beantragt",
                        "fassung_freigegeben");
    }

    /**
     * F4/R12: Fassung 2 mit {@code grundlage_korrigiert} und eigenem {@code gilt_ab} beendet Fassung 1 am Vortag;
     * Fassung 1 bleibt lesbar und byte-gleich (Grundlage und Prüfsumme).
     */
    @Test
    void fassungZweiBeendetFassungEinsAmVortag() throws Exception {
        Welt w = welt();
        monat(w, "2026-10-01", "88630", "312400", "endgueltig", List.of());
        String basis = basis(w, w.kz4());
        Map<String, Object> eins = entwurf("2026-10/2026-10", "verhaeltnis");
        eins.put("anpassungsgruende", List.of("grundlage_korrigiert"));
        abgelehnt(w, basis, eins, 422, "anpassung_ohne_vorgaengerin");
        assertThat(ruf(w, HttpMethod.POST, basis + "/fassungen", entwurf("2026-10/2026-10", "verhaeltnis")).status())
                .isEqualTo(200);
        entscheid(w, "ines", basis, 1, "freigeben", "Oktober 2026 als erster Maßstab", 200, null);
        Antwort vorher = ruf(w, HttpMethod.GET, basis + "/fassungen/1", null);
        String grundlage1 = root.queryForObject("SELECT grundlage FROM bezugsbasis_fassung WHERE tenant_id = ? "
                + "AND fassung = 1", String.class, w.mandant());

        Map<String, Object> zwei = entwurf("2026-10/2026-10", "verhaeltnis");
        zwei.put("anpassungsgruende", List.of("grundlage_korrigiert"));
        zwei.put("begruendung", "Korrektur K-2026-0007 an der Oktober-Menge");
        zwei.put("gilt_ab", "2026-10-15");
        abgelehnt(w, basis, zwei, 422, "gilt_ab_vor_periodenende");
        zwei.put("gilt_ab", "2026-12-01");
        Antwort entwurf2 = ruf(w, HttpMethod.POST, basis + "/fassungen", zwei);
        assertThat(entwurf2.status()).as(entwurf2.text()).isEqualTo(200);
        assertThat(entwurf2.body().get("gilt_ab").asText()).isEqualTo("2026-12-01");
        // Solange Fassung 2 Entwurf ist, läuft Fassung 1 unverändert.
        assertThat(ruf(w, HttpMethod.GET, basis + "/fassungen/1", null).text()).isEqualTo(vorher.text());
        entscheid(w, "ines", basis, 2, "freigeben", null, 200, null);

        JsonNode f1 = ruf(w, HttpMethod.GET, basis + "/fassungen/1", null).body();
        assertThat(f1.get("gilt_bis").asText()).isEqualTo("2026-11-30");
        assertThat(f1.get("freigabe_status").asText()).isEqualTo("freigegeben");
        assertThat(f1.get("pruefsumme").asText()).isEqualTo(vorher.body().get("pruefsumme").asText())
                .isEqualTo(BezugsbasisGrundlage.pruefsumme(grundlage1));
        assertThat(root.queryForObject("SELECT grundlage FROM bezugsbasis_fassung WHERE tenant_id = ? AND fassung = 1",
                String.class, w.mandant())).isEqualTo(grundlage1);
        JsonNode eine = ruf(w, HttpMethod.GET, basis, null).body();
        assertThat(eine.get("fassungen")).hasSize(2);
        assertThat(eine.at("/fassungen/0/gilt_bis").asText()).isEqualTo("2026-11-30");
        assertThat(eine.at("/fassungen/1/gilt_bis").isNull()).isTrue();
        // Die Register-Zeile nennt die laufende freigegebene Fassung — nicht einen offenen Entwurf.
        assertThat(registerEintrag(w, w.kz4()).at("/bezugsbasis/fassung").asInt()).isEqualTo(2);
        Map<String, Object> drei0 = new LinkedHashMap<>(zwei);
        drei0.put("gilt_ab", "2027-01-01");
        assertThat(ruf(w, HttpMethod.POST, basis + "/fassungen", drei0).status()).isEqualTo(200);
        JsonNode r = registerEintrag(w, w.kz4()).get("bezugsbasis");
        assertThat(r.get("fassung").asInt()).isEqualTo(2);
        assertThat(r.get("freigabe_status").asText()).isEqualTo("freigegeben");
        assertThat(root.queryForList("SELECT art || ':' || fassung FROM bezugsbasis_aenderung WHERE tenant_id = ? "
                + "AND fassung IS NOT NULL ORDER BY id", String.class, w.mandant())).containsExactly(
                        "fassung_entworfen:1", "fassung_freigegeben:1", "fassung_entworfen:2", "fassung_beendet:1",
                        "fassung_freigegeben:2", "fassung_entworfen:3");

        // Fassung 3 darf nicht vor ihrer Vorgängerin gelten.
        Map<String, Object> drei = new LinkedHashMap<>(zwei);
        drei.put("gilt_ab", "2026-11-01");
        abgelehnt(w, basis, drei, 422, "gilt_ab_vor_vorgaengerin");
    }

    /** B4: der Verantwortliche ist ein Benutzer des Kundenbereichs — Name als Schnappschuss, Protokoll mit alt/neu. */
    @Test
    void verantwortlicherWirdEinBenutzerMitSchnappschuss() throws Exception {
        Welt w = welt();
        String basis = basis(w, w.kz4());
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', "
                + "'Jonas Wendlinger', 'aktiv')", w.mandant(), "sub-jonas-kz-" + w.mandant());
        Antwort unbekannt = ruf(w, "ines", HttpMethod.PUT, basis + "/verantwortlicher", Map.of("benutzer", "niemand"));
        assertThat(unbekannt.status()).isEqualTo(422);
        assertThat(unbekannt.body().get("code").asText()).isEqualTo("benutzer_unbekannt");
        assertThat(ruf(w, "ines", HttpMethod.PUT, basis + "/verantwortlicher", Map.of()).status()).isEqualTo(400);
        Antwort gesetzt = ruf(w, "ines", HttpMethod.PUT, basis + "/verantwortlicher",
                Map.of("benutzer", "sub-jonas-kz-" + w.mandant()));
        assertThat(gesetzt.status()).as(gesetzt.text()).isEqualTo(200);
        assertThat(gesetzt.body().get("verantwortlich_name").asText()).isEqualTo("Jonas Wendlinger");
        assertThat(root.queryForObject("SELECT verantwortlich_sub FROM bezugsbasis WHERE tenant_id = ?", String.class,
                w.mandant())).isEqualTo("sub-jonas-kz-" + w.mandant());
        Map<String, Object> p = root.queryForMap("SELECT alt::text AS alt, neu::text AS neu FROM bezugsbasis_aenderung "
                + "WHERE tenant_id = ? AND art = 'verantwortlicher_geaendert'", w.mandant());
        assertThat(p.get("alt").toString()).contains("Ines Kaltenbach");
        assertThat(p.get("neu").toString()).contains("Jonas Wendlinger");
    }

    /** Zaun: ein anderer Kundenbereich kann nichts beantragen, freigeben, ablehnen oder umbesetzen — 404. */
    @Test
    void mandantBKannNichtsEntscheiden() throws Exception {
        Welt a = welt();
        monat(a, "2026-10-01", "88630", "312400", "endgueltig", List.of());
        String basis = basis(a, a.kz4());
        assertThat(ruf(a, HttpMethod.POST, basis + "/fassungen", entwurf("2026-10/2026-10", "verhaeltnis")).status())
                .isEqualTo(200);
        Welt b = welt();
        for (String schritt : List.of("beantragen", "freigeben", "ablehnen")) {
            entscheid(b, "ines", basis, 1, schritt, "Oktober 2026 als erster Maßstab", 404, null);
        }
        assertThat(ruf(b, "ines", HttpMethod.PUT, basis + "/verantwortlicher", Map.of("benutzer", "x")).status())
                .isEqualTo(404);
        assertThat(ruf(b, HttpMethod.GET, PFAD + "/" + a.kz4() + "/bezugsbasen", null).status()).isEqualTo(404);
        assertThat(ruf(b, HttpMethod.GET, PFAD + "/" + b.kz4() + "/bezugsbasen", null).body().get("bezugsbasen"))
                .isEmpty();
        assertThat(root.queryForObject("SELECT freigabe_status FROM bezugsbasis_fassung WHERE tenant_id = ?",
                String.class, a.mandant())).isEqualTo("entwurf");
    }

    // ------------------------------------------------------------------------------------------------ Welt

    private Welt welt() throws Exception {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Bezugsbasis #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, 'Europe/Berlin') "
                + "RETURNING id", UUID.class, t, "Kunststoffwerk Ahrenberg GmbH");
        UUID st1 = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u);
        UUID g2 = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, 'gebaeude', "
                + "'Halle 2', 'G-2', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2020-01-01')", t, g2, st1);
        for (String ms : List.of("MS-19", "MS-20")) {
            UUID id = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                    + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                    + "'Zählerstand') RETURNING id", UUID.class, t, ms, "Messstelle " + ms);
            root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                    + "VALUES (?, ?, ?, NULL, '2020-01-01')", t, id, g2);
        }
        root.update("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, geltung_art, "
                + "ort_id) VALUES (?, 'BZ-1', 'Produktionsmenge Spritzguss', 'periodenwert', 'kg', 'monat', 'gebaeude', ?)",
                t, g2);
        Welt ohne = new Welt(t, g2, null, null);
        UUID kz4 = kennzahl(ohne, "KZ-0004", "quotient", e("zaehler", "messstelle", "MS-20"),
                e("nenner", "bezugsgroesse", "BZ-1"));
        UUID kz9 = kennzahl(ohne, "KZ-0009", "anteil", e("zaehler", "messstelle", "MS-20"),
                e("nenner", "messstelle", "MS-19"));
        return new Welt(t, g2, kz4, kz9);
    }

    /** Eine Monatszeile von KZ-0004, wie der Rechenlauf sie schreibt: Version 1, ungerundet, mit beiden Eingängen. */
    private static void monat(Welt w, String erster, String kwh, String kg, String zustand, List<String> kennzeichen)
            throws Exception {
        monat(w, w.kz4(), "MS-20", "BZ-1", "kg", erster, kwh, kg, zustand, kennzeichen);
    }

    /** Dieselbe Zeile für eine andere Kennzahl; ein Nenner 0 schreibt, was der Lauf schreibt: {@code nenner_null}. */
    private static void monat(Welt w, UUID kennzahl, String messstelle, String bezug, String einheit, String erster,
            String zaehlerText, String nennerText) throws Exception {
        monat(w, kennzahl, messstelle, bezug, einheit, erster, zaehlerText, nennerText, "endgueltig", List.of());
    }

    private static void monat(Welt w, UUID kennzahl, String messstelle, String bezug, String einheit, String erster,
            String zaehlerText, String nennerText, String zustand, List<String> kennzeichen) throws Exception {
        LocalDate von = LocalDate.parse(erster);
        BigDecimal zaehler = new BigDecimal(zaehlerText);
        BigDecimal nenner = new BigDecimal(nennerText);
        boolean null0 = nenner.signum() == 0;
        Timestamp am = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(7200));
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, kennzahl);
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, zustand, endgueltig_ab, grund, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, ?, 'monat', ?, ?, 'Europe/Berlin', ?, ?, ?, ?, "
                + "?, ?::jsonb, ?, ?, ?, ?, ?)", wert, w.mandant(), kennzahl, Date.valueOf(von),
                Date.valueOf(von.plusMonths(1).minusDays(1)), null0 ? null : 1,
                null0 ? null : zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler, nenner,
                null0 ? "keine Werte" : "vollständig", MAPPER.writeValueAsString(kennzeichen), null0 ? null : zustand,
                !null0 && "endgueltig".equals(zustand) ? am : null, null0 ? "nenner_null" : null, fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "?, (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = ?), ?, 'kWh', "
                + "'vollständig', 1)", w.mandant(), wert, kennzahl, messstelle, w.mandant(), messstelle, zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "?, (SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = ?), ?, ?, "
                + "'vollständig', 1)", w.mandant(), wert, kennzahl, bezug, w.mandant(), bezug, nenner, einheit);
    }

    private String basis(Welt w, UUID kennzahl) throws Exception {
        Antwort a = ruf(w, HttpMethod.POST, PFAD + "/" + kennzahl + "/bezugsbasen", null);
        assertThat(a.status()).as(a.text()).isEqualTo(201);
        return PFAD + "/" + kennzahl + "/bezugsbasen/" + a.body().get("id").asText();
    }

    private void abgelehnt(Welt w, String basis, Map<String, Object> body, int status, String code) throws Exception {
        Antwort a = ruf(w, HttpMethod.POST, basis + "/fassungen", body);
        assertThat(a.status()).as(code + " " + a.text()).isEqualTo(status);
        assertThat(a.body().get("code").asText()).isEqualTo(code);
    }

    private static Map<String, Object> entwurf(String referenzperiode, String methode) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("referenzperiode", referenzperiode);
        m.put("methode", methode);
        return m;
    }

    @SafeVarargs
    private UUID kennzahl(Welt w, String kennzeichen, String rechenform, Map<String, Object>... eingaenge)
            throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", kennzeichen + " " + rechenform);
        m.put("rechenform", rechenform);
        m.put("geltung_art", "gebaeude");
        m.put("geltung_id", w.g2().toString());
        m.put("eingaenge", List.of(eingaenge));
        Antwort a = ruf(w, HttpMethod.POST, PFAD, m);
        assertThat(a.status()).as(kennzeichen + " " + a.text()).isEqualTo(201);
        return UUID.fromString(a.body().get("id").asText());
    }

    private static Map<String, Object> e(String rolle, String art, String kennzeichen) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rolle", rolle);
        m.put("art", art);
        m.put("kennzeichen", kennzeichen);
        return m;
    }

    private static int anzahl(String tabelle, UUID kennzahl) {
        return root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE kennzahl_id = ?", Integer.class, kennzahl);
    }

    private JsonNode registerEintrag(Welt w, UUID kennzahl) throws Exception {
        for (JsonNode k : ruf(w, HttpMethod.GET, PFAD, null).body().get("kennzahlen")) {
            if (k.get("id").asText().equals(kennzahl.toString())) {
                return k;
            }
        }
        throw new AssertionError("nicht im Register: " + kennzahl);
    }

    private Antwort entscheid(Welt w, String person, String basis, int fassung, String schritt, String begruendung,
            int status, String code) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        if (begruendung != null) {
            body.put("begruendung", begruendung);
        }
        Antwort a = ruf(w, person, HttpMethod.POST, basis + "/fassungen/" + fassung + "/" + schritt, body);
        assertThat(a.status()).as(schritt + " " + person + " " + a.text()).isEqualTo(status);
        if (code != null) {
            assertThat(a.body().get("code").asText()).isEqualTo(code);
        }
        return a;
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        return ruf(w, "ines", methode, pfad, body);
    }

    /** ines = Ines Kaltenbach, jonas = Jonas Wendlinger (beide nie zugewiesen → Kundenadministrator, E12), peter = Bearbeiter. */
    private Antwort ruf(Welt w, String person, HttpMethod methode, String pfad, Object body) throws Exception {
        String name = switch (person) {
            case "jonas" -> "Jonas Wendlinger";
            case "peter" -> "Peter Hollerbach";
            default -> "Ines Kaltenbach";
        };
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-" + person + "-" + w.mandant());
                    j.claim("preferred_username", name);
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text),
                text);
    }
}
