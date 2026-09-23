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

    private record Welt(UUID mandant, UUID g2, UUID kz4, UUID kz9) {}

    private record Antwort(int status, JsonNode body, String text) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void aufruferWieHeute() {
        doAnswer(inv -> KorrekturRechte.benutzer(inv.getArgument(0))).when(aufrufer).benutzer(any());
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
        abgelehnt(w, basis, entwurf("2026-10/2026-10", "regression_eine_variable"), 422, "methode_noch_nicht_gebaut");
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
        LocalDate von = LocalDate.parse(erster);
        BigDecimal zaehler = new BigDecimal(kwh);
        BigDecimal nenner = new BigDecimal(kg);
        Timestamp am = Timestamp.from(von.plusMonths(1).atStartOfDay().toInstant(ZoneOffset.UTC).plusSeconds(7200));
        UUID fassung = root.queryForObject("SELECT id FROM kennzahl_fassung WHERE kennzahl_id = ? AND nummer = 1",
                UUID.class, w.kz4());
        UUID wert = UUID.randomUUID();
        root.update("INSERT INTO kennzahl_wert (id, tenant_id, kennzahl_id, periode_art, periode_von, periode_bis, zeitzone, "
                + "version, wert, zaehler, nenner, menge_zustand, kennzeichen, zustand, endgueltig_ab, "
                + "definition_fassung_id, berechnet_am) VALUES (?, ?, ?, 'monat', ?, ?, 'Europe/Berlin', 1, ?, ?, ?, "
                + "'vollständig', ?::jsonb, ?, ?, ?, ?)", wert, w.mandant(), w.kz4(), Date.valueOf(von),
                Date.valueOf(von.plusMonths(1).minusDays(1)), zaehler.divide(nenner, 20, RoundingMode.HALF_UP), zaehler,
                nenner, MAPPER.writeValueAsString(kennzeichen), zustand, "endgueltig".equals(zustand) ? am : null,
                fassung, am);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, version) VALUES (?, ?, ?, 0, 'zaehler', 'messstelle', "
                + "'MS-20', (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-20'), ?, 'kWh', "
                + "'vollständig', 1)", w.mandant(), wert, w.kz4(), w.mandant(), zaehler);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "bezugsgroesse_id, wert, einheit, menge_zustand, fassung) VALUES (?, ?, ?, 1, 'nenner', 'bezugsgroesse', "
                + "'BZ-1', (SELECT id FROM bezugsgroesse WHERE tenant_id = ? AND kennzeichen = 'BZ-1'), ?, 'kg', "
                + "'vollständig', 1)", w.mandant(), wert, w.kz4(), w.mandant(), nenner);
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

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-ines-" + w.mandant());
                    j.claim("preferred_username", "Ines Kaltenbach");
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
