package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import jakarta.servlet.ServletException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Import;
import org.springframework.core.Ordered;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Prüfpunkt an jeder Schreibroute (UEMS AP-03 IP-6) mit den acht Personen des Referenzunternehmens (AP-03 §4.1) im
 * eigenen Kundenbereich „Kunststoffwerk Ahrenberg": Werk Ahrenberg (ST-1), Werk Lindach (ST-2), Werk Ahrenberg Nord
 * (ST-3); Halle 1 hängt an ST-1, Lindach an ST-2.
 *
 * <ol>
 *   <li><b>Je Matrix-Zeile der Gruppen 1–3</b> eine Route und alle acht Personen: erlaubt · 403 {@code recht_fehlt} ·
 *       404 außerhalb des Geltungsbereichs.</li>
 *   <li><b>{@code SiteController}-Löschen als Leser → 403</b> mit Rolle und Weg; die Anlage bleibt.</li>
 *   <li><b>Außerhalb ist dieselbe 404 wie eine Kennung, die es nicht gibt</b> (Messstelle, Bezugsgröße, Gerät — die
 *       Objekte ohne Standort-Zaun).</li>
 *   <li><b>Die genaue Prüfung im Anfragekörper</b> (Box anmelden, Bezugsgröße anlegen, Ort verschieben, rückwirkend).</li>
 *   <li><b>Bestand: jedes heutige Konto kommt an jeder Route mit {@link Recht} bis zum Handler</b> — der
 *       Kundenadministrator der Bestandsübernahme, das nie zugewiesene Kundenkonto (E12), die Plattform am Umschalter
 *       und ein Token ohne Kontoart. „Vorher" erreichte jede Anfrage den Handler; „nachher" ist gemessen.</li>
 * </ol>
 *
 * <p>Der Handler läuft dabei nicht: ein Test-Interceptor HINTER dem Rechte-Interceptor beendet jede Anfrage mit
 * {@code X-Test-Bis-Handler} mit 299 — erlaubt heißt „bis zum Handler gekommen", und nichts wird geschrieben. Das Urteil
 * steht im Anfrage-Attribut {@link RechtInterceptor#URTEIL}.
 *
 * <p>Die Gültigkeiten der Personen beginnen vor dem Testtag (die Referenz-Daten liegen um den Herbst 2026); Sabine Rauch
 * bleibt künftig (ein Jahr nach dem Testtag).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Import(RechtMatrixApiTest.BisZumHandler.class)
class RechtMatrixApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    static final String BIS_HANDLER = "X-Test-Bis-Handler";
    private static final int BIS_HANDLER_STATUS = 299;
    private static final String KUNDENBEREICH = ZugriffKontextLader.KUNDENBEREICH_HEADER;

    static final UUID AHR = UUID.fromString("a3060000-0000-0000-0000-000000000001");
    static final UUID S1 = UUID.fromString("a3060000-0000-0000-0001-000000000001");
    static final UUID S2 = UUID.fromString("a3060000-0000-0000-0001-000000000002");
    static final UUID S3 = UUID.fromString("a3060000-0000-0000-0001-000000000003");
    static final UUID A1 = UUID.fromString("a3060000-0000-0000-0002-000000000001");
    static final UUID A2 = UUID.fromString("a3060000-0000-0000-0002-000000000002");
    static final UUID G1 = UUID.fromString("a3060000-0000-0000-0003-000000000001");
    static final UUID G2 = UUID.fromString("a3060000-0000-0000-0003-000000000002");
    /** Eine Kennung, die es nirgends gibt. */
    static final UUID FREMD = UUID.fromString("a3060000-0000-0000-00ff-000000000000");
    private static UUID d1;
    private static UUID gr1;
    private static UUID m1;
    private static UUID m0;
    private static UUID b1;

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

    /** Beendet eine Anfrage mit {@link #BIS_HANDLER} HINTER dem Rechte-Interceptor — der Handler läuft nie. */
    @TestConfiguration
    static class BisZumHandler implements WebMvcConfigurer {
        @Override
        public void addInterceptors(InterceptorRegistry registry) {
            registry.addInterceptor(new HandlerInterceptor() {
                @Override
                public boolean preHandle(jakarta.servlet.http.HttpServletRequest request,
                        jakarta.servlet.http.HttpServletResponse response, Object handler) {
                    if (request.getHeader(BIS_HANDLER) == null) {
                        return true;
                    }
                    response.setStatus(BIS_HANDLER_STATUS);
                    return false;
                }
            }).order(Ordered.LOWEST_PRECEDENCE);
        }
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    RequestMappingHandlerMapping mapping;

    private static JdbcTemplate root;
    private static boolean gesaet;

    /** Eine Person: Anmeldung und die Köpfe, mit denen sie den Kundenbereich erreicht. */
    private record Person(String kurz, String name, RequestPostProcessor anmeldung, String... koepfe) {}

    // Die acht Personen, in der Folge des Personen-Satzes (AP-03 §4.1).
    private static final Person JW = kunde("JW", "Jonas Wendlinger", "sub-ahr-jonas");
    private static final Person IK = kunde("IK", "Ines Kaltenbach", "sub-ahr-ines");
    private static final Person PH = kunde("PH", "Peter Hollerbach", "sub-ahr-peter");
    private static final Person SR = kunde("SR", "Sabine Rauch", "sub-ahr-sabine");
    private static final Person MD = kunde("MD", "Murat Demirci", "sub-ahr-murat");
    private static final Person CB = kunde("CB", "Claudia Berger", "sub-ahr-claudia");
    private static final Person TB = new Person("TB", "Thomas Brunner", authentication(konto("sub-ahr-brunner", null,
            "partner")), KUNDENBEREICH, AHR.toString());
    private static final Person LV = new Person("LV", "Lena Voss", authentication(konto("sub-ahr-voss", null,
            "platform-admin")), KUNDENBEREICH, AHR.toString());
    private static final List<Person> ACHT = List.of(JW, IK, PH, SR, MD, CB, TB, LV);

    /** Bearbeiter in Werk Lindach UND Leser in Werk Ahrenberg — für die genaue Prüfung im Körper. */
    private static final Person GEMISCHT = kunde("GM", "Bearbeiter ST-2 + Leser ST-1", "sub-ahr-gemischt");

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void saeOnce() {
        if (!gesaet) {
            seed();
            gesaet = true;
        }
    }

    // ------------------------------------------------------------------ 1. Je Matrix-Zeile

    /**
     * Eine Zeile: Kennung(en), Route, Erwartung je Person in der Folge JW IK PH SR MD CB TB LV — {@code e} erlaubt,
     * {@code 3} 403 {@code recht_fehlt}, {@code 4} außerhalb des Geltungsbereichs.
     */
    private record Zeile(String kennungen, HttpMethod methode, String pfad, String erwartet, String typ) {
        Zeile(String kennungen, HttpMethod methode, String pfad, String erwartet) {
            this(kennungen, methode, pfad, erwartet, MediaType.APPLICATION_JSON_VALUE);
        }
    }

    private static List<Zeile> zeilen() {
        List<Zeile> z = new ArrayList<>();
        // Gruppe 1 — Unternehmen, Standorte, Struktur
        z.add(new Zeile("unternehmen.bearbeiten", HttpMethod.PUT, "/api/v1/unternehmen", "ee333333"));
        z.add(new Zeile("standort.verwalten", HttpMethod.POST, "/api/v1/standorte", "ee333333"));
        z.add(new Zeile("standort.verwalten", HttpMethod.PUT, "/api/v1/standorte/{S1}", "ee443333"));
        z.add(new Zeile("gebaeude.pflegen", HttpMethod.PUT, "/api/v1/orte/{G1}", "ee4433e3"));
        z.add(new Zeile("gebaeude.pflegen", HttpMethod.PUT, "/api/v1/orte/{G2}", "eee44344"));
        z.add(new Zeile("gebaeude.pflegen", HttpMethod.POST, "/api/v1/standorte/{S2}/orte", "eee44344"));
        z.add(new Zeile("anlage.zuordnen", HttpMethod.PUT, "/api/v1/sites/{A1}/standort", "e3443333"));
        z.add(new Zeile("anlage.verwalten", HttpMethod.POST, "/api/v1/sites", "e333333e"));
        z.add(new Zeile("anlage.verwalten", HttpMethod.DELETE, "/api/v1/sites/{A1}", "e344333e"));
        z.add(new Zeile("geraet.einrichten", HttpMethod.POST, "/api/v1/sites/{A1}/components", "ee4433e3"));
        z.add(new Zeile("geraet.einrichten", HttpMethod.POST, "/api/v1/sites/{A2}/components", "eee44344"));
        z.add(new Zeile("geraet.einrichten", HttpMethod.POST, "/api/v1/sites/{A1}/modbus-probe", "ee4433e3"));
        z.add(new Zeile("geraet.einrichten", HttpMethod.POST, "/api/v1/devices/claim", "eee333e3"));
        z.add(new Zeile("komponente.loeschen", HttpMethod.DELETE, "/api/v1/devices/{D1}", "ee443333"));
        z.add(new Zeile("komponente.loeschen", HttpMethod.DELETE, "/api/v1/sites/{A1}/components/custom/{FREMD}",
                "ee443333"));
        z.add(new Zeile("aufzeichnungen.loeschen", HttpMethod.POST, "/api/v1/devices/{D1}/purge-data", "e3443333"));
        z.add(new Zeile("mess_selektion.bearbeiten", HttpMethod.PUT, "/api/v1/devices/{D1}/measurement-selection/p1",
                "ee4433e3"));
        z.add(new Zeile("kostenstelle.verwalten", HttpMethod.POST, "/api/v1/unternehmen/kostenstellen", "ee333333"));
        z.add(new Zeile("prozess.verwalten", HttpMethod.POST, "/api/v1/unternehmen/prozesse", "ee333333"));
        z.add(new Zeile("netzanschluss.verwalten", HttpMethod.POST, "/api/v1/standorte/{S1}/netzanschluesse",
                "ee443333"));
        z.add(new Zeile("datenquelle.bearbeiten", HttpMethod.POST, "/api/v1/sites/{A1}/data-sources", "ee4433e3"));
        z.add(new Zeile("datenquelle.zustaendigkeit", HttpMethod.POST,
                "/api/v1/sites/{A1}/data-sources/{FREMD}/assignments", "e34433e3"));
        // Gruppe 2 — Messstellen und Messdaten
        z.add(new Zeile("messstelle.bearbeiten", HttpMethod.PUT, "/api/v1/messstellen/{M1}", "ee4433e3"));
        z.add(new Zeile("messstelle.bearbeiten", HttpMethod.PUT, "/api/v1/messstellen/{M0}", "eee333e3"));
        z.add(new Zeile("messstelle.bearbeiten", HttpMethod.POST, "/api/v1/messstellen", "eee333e3"));
        z.add(new Zeile("messstelle.quelle", HttpMethod.POST, "/api/v1/messstellen/{M1}/quellen", "ee4433e3"));
        z.add(new Zeile("messstelle.quelle", HttpMethod.POST, "/api/v1/geraete/{GR1}/austausch", "ee4433e3"));
        z.add(new Zeile("messstelle.formel", HttpMethod.POST, "/api/v1/sites/{A1}/bilanz/rest", "ee4433e3"));
        z.add(new Zeile("messstelle.verteilung", HttpMethod.PUT, "/api/v1/messstellen/{M1}/verteilung", "ee4433e3"));
        z.add(new Zeile("korrektur.freigeben", HttpMethod.POST, "/api/v1/korrekturen/K-1/freigeben", "eee33333"));
        z.add(new Zeile("korrektur.zuruecknehmen", HttpMethod.POST, "/api/v1/korrekturen/K-1/zuruecknehmen",
                "eee33333"));
        z.add(new Zeile("vieraugen.einstellen", HttpMethod.PUT, "/api/v1/unternehmen/vieraugen", "e3333333"));
        z.add(new Zeile("bezugsgroesse.verwalten", HttpMethod.POST, "/api/v1/bezugsgroessen/{B1}/archivieren",
                "ee443333"));
        z.add(new Zeile("bezugsgroesse.eingeben", HttpMethod.POST, "/api/v1/bezugsgroessen/{B1}/werte", "ee443333"));
        z.add(new Zeile("bezugsgroesse.importieren", HttpMethod.POST, "/api/v1/bezugsdaten/importe/vorschau",
                "eee33333", MediaType.MULTIPART_FORM_DATA_VALUE));
        // Gruppe 3 — Kennzahlen, Berichte, Exporte
        z.add(new Zeile("kennzahl.standort_definieren|kennzahl.unternehmen_definieren", HttpMethod.POST,
                "/api/v1/kennzahlen", "eee33333"));
        z.add(new Zeile("bericht.standort_freigeben|bericht.unternehmen", HttpMethod.POST, "/api/v1/berichte",
                "eee33333"));
        z.add(new Zeile("cockpit.anpassen", HttpMethod.PUT, "/api/v1/sites/{A1}/cockpit-layout", "ee44333e"));
        z.add(new Zeile("cockpit.anpassen", HttpMethod.PUT, "/api/v1/tenant/cockpit-layout", "ee33333e"));
        return z;
    }

    /**
     * Zeilen der Gruppen 1–3 ohne Zeile oben — und warum. Der Test hält die Liste mit der Matrix-Datei zusammen.
     */
    private static final Map<String, String> OHNE_SCHREIBROUTE = Map.of(
            "aenderung.rueckwirkend", "genaue Prüfung im Körper — genaueRechtePruefungImAnfragekoerper",
            "aenderungsprotokoll.lesen", "lesend — Standort-Zaun (IP-5)",
            "korrektur.erfassen", "keine Schreibroute (Korrektur erfassen ist noch nicht gebaut)",
            "ersatzwert.erfassen", "keine Schreibroute (Ersatzwert erfassen ist noch nicht gebaut)",
            "messwerte.ansehen", "lesend — Standort-Zaun (IP-5), Teilansicht IP-10/IP-11",
            "bericht.standort_abrufen", "lesend — IP-11",
            "export.standort", "lesend — IP-11",
            "export.unternehmen", "lesend — IP-11",
            "auswertung.anlegen", "keine Schreibroute (Eigene Auswertung liest nur)");

    @Test
    void jeMatrixZeileDerGruppenEinsBisDreiUrteilenDieAchtPersonen() throws Exception {
        List<String> abweichungen = new ArrayList<>();
        Map<String, String> tabelle = new LinkedHashMap<>();
        for (Zeile z : zeilen()) {
            StringBuilder ist = new StringBuilder();
            for (int i = 0; i < ACHT.size(); i++) {
                Person p = ACHT.get(i);
                MvcResult r = ruf(z.methode(), pfad(z.pfad()), p, true, "{}", z.typ());
                char c = urteil(r, Set.of(z.kennungen().split("\\|")));
                ist.append(c);
                if (c != z.erwartet().charAt(i)) {
                    abweichungen.add(z.methode() + " " + z.pfad() + " " + p.kurz() + ": erwartet "
                            + z.erwartet().charAt(i) + ", ist " + c + " (" + r.getResponse().getStatus() + " "
                            + r.getRequest().getAttribute(RechtInterceptor.URTEIL) + " "
                            + r.getResponse().getContentAsString(StandardCharsets.UTF_8) + ")");
                }
            }
            tabelle.put(z.kennungen() + "  " + z.methode() + " " + z.pfad(), ist.toString());
        }
        System.out.println("Rechte je Zeile (JW IK PH SR MD CB TB LV; e erlaubt · 3 recht_fehlt · 4 außerhalb):");
        tabelle.forEach((k, v) -> System.out.println("  " + v + "  " + k));
        assertThat(abweichungen).as("Abweichungen von der Matrix").isEmpty();
    }

    /** Jede Zeile der Gruppen 1–3 hat eine Route oben oder einen Grund. */
    @Test
    void jedeZeileDerGruppenEinsBisDreiIstAbgedeckt() throws Exception {
        JsonNode datei = MAPPER.readTree(getClass().getClassLoader().getResourceAsStream(RechteMatrixDatei.PFAD));
        Set<String> gruppen = Set.of("struktur", "messdaten", "kennzahlen", "datenquellen");
        Set<String> abgedeckt = new java.util.TreeSet<>();
        zeilen().forEach(z -> abgedeckt.addAll(List.of(z.kennungen().split("\\|"))));
        List<String> offen = new ArrayList<>();
        for (JsonNode a : datei.path("aktionen")) {
            String k = a.path("kennung").asText();
            boolean lesend = k.endsWith(".ansehen");
            if (gruppen.contains(a.path("gruppe").asText()) && !lesend && !abgedeckt.contains(k)
                    && !OHNE_SCHREIBROUTE.containsKey(k)) {
                offen.add(k);
            }
        }
        assertThat(offen).as("Zeilen der Gruppen 1–3 ohne Route und ohne Grund").isEmpty();
    }

    // ------------------------------------------------------------------ 2. SiteController-Löschen als Leser

    @Test
    void anlageLoeschenAlsLeserinIst403MitRolleUndWegUndDieAnlageBleibt() throws Exception {
        MvcResult r = ruf(HttpMethod.DELETE, "/api/v1/sites/" + A1, CB, false, null);
        assertThat(r.getResponse().getStatus()).isEqualTo(403);
        JsonNode body = MAPPER.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertThat(body.path("code").asText()).isEqualTo("recht_fehlt");
        assertThat(body.path("recht").asText()).isEqualTo("anlage.verwalten");
        assertThat(body.path("rolle_noetig").asText()).isEqualTo("kundenadministrator");
        assertThat(body.path("message").asText()).startsWith("Dafür fehlt Ihnen das Recht.")
                .contains("Jonas Wendlinger");
        assertThat(root.queryForObject("SELECT count(*) FROM site WHERE id = ?", Integer.class, A1)).isEqualTo(1);
    }

    @Test
    void rolleNoetigUndUmfangNoetigNennenWasFehlt() throws Exception {
        JsonNode leserin = MAPPER.readTree(ruf(HttpMethod.PUT, "/api/v1/orte/" + G1, CB, true, "{}").getResponse()
                .getContentAsString(StandardCharsets.UTF_8));
        assertThat(leserin.path("rolle_noetig").asText()).isEqualTo("bearbeiter");
        JsonNode support = MAPPER.readTree(ruf(HttpMethod.PUT, "/api/v1/orte/" + G1, LV, true, "{}").getResponse()
                .getContentAsString(StandardCharsets.UTF_8));
        assertThat(support.path("code").asText()).isEqualTo("recht_fehlt");
        assertThat(support.path("umfang_noetig").asText()).isEqualTo("einrichten");
    }

    // ------------------------------------------------------------------ 3. 404 außerhalb = 404 unbekannt

    @Test
    void ausserhalbIstDieselbe404WieEineKennungDieEsNichtGibt() throws Exception {
        List<String[]> paare = List.of(
                new String[] {"POST", "/api/v1/bezugsgroessen/%s/archivieren", "b1", null},
                new String[] {"DELETE", "/api/v1/bezugsgroessen/%s", "b1", null},
                new String[] {"POST", "/api/v1/messstellen/%s/archivieren", "m1", null},
                new String[] {"PUT", "/api/v1/messstellen/%s/verteilung", "m1", "{}"},
                new String[] {"PUT", "/api/v1/messstellen/%s/prozesse", "m1", "{}"},
                new String[] {"POST", "/api/v1/geraete/%s/austausch", "gr1", "{}"});
        List<String> abweichungen = new ArrayList<>();
        for (String[] p : paare) {
            UUID id = switch (p[2]) {
                case "b1" -> b1;
                case "m1" -> m1;
                default -> gr1;
            };
            MvcResult aussen = ruf(HttpMethod.valueOf(p[0]), p[1].formatted(id), PH, false, p[3]);
            MvcResult unbekannt = ruf(HttpMethod.valueOf(p[0]), p[1].formatted(FREMD), PH, false, p[3]);
            String a = antwort(aussen);
            String u = antwort(unbekannt);
            System.out.println("außerhalb/unbekannt " + p[0] + " " + p[1] + ": " + a);
            if (aussen.getResponse().getStatus() != 404 || !a.equals(u)) {
                abweichungen.add(p[0] + " " + p[1] + ": außerhalb " + a + " · unbekannt " + u);
            }
            assertThat(aussen.getRequest().getAttribute(RechtInterceptor.URTEIL)).isEqualTo("ausserhalb");
        }
        assertThat(abweichungen).isEmpty();
    }

    // ------------------------------------------------------------------ 4. Genaue Prüfung im Körper

    @Test
    void genaueRechtePruefungImAnfragekoerper() throws Exception {
        // Box anmelden: die Zielanlage steht im Körper — Leserin in Werk Ahrenberg, Bearbeiter nur in Lindach.
        assertRechtFehlt(ruf(HttpMethod.POST, "/api/v1/devices/claim", GEMISCHT, false,
                "{\"siteId\":\"" + A1 + "\",\"externalRef\":\"edge-ahr-neu\"}"), "geraet.einrichten");
        // Der Kundenadministrator kommt an der Rechte-Prüfung vorbei bis zur Prüfung der Geräte-ID (400).
        assertThat(ruf(HttpMethod.POST, "/api/v1/devices/claim", JW, false,
                "{\"siteId\":\"" + A1 + "\",\"externalRef\":\"a/b\"}").getResponse().getStatus()).isEqualTo(400);

        // Bezugsgröße: die Geltung steht im Körper.
        assertRechtFehlt(ruf(HttpMethod.POST, "/api/v1/bezugsgroessen", GEMISCHT, false,
                "{\"kennzeichen\":\"BZ-70\",\"name\":\"Gutteile\",\"wertart\":\"periodenwert\",\"einheit\":\"Stück\","
                        + "\"periode_art\":\"monat\",\"geltung_art\":\"standort\",\"geltung_id\":\"" + S1 + "\"}"),
                "bezugsgroesse.verwalten");

        // Ort verschieben: der neue Elternknoten steht im Körper.
        assertRechtFehlt(ruf(HttpMethod.POST, "/api/v1/orte/" + G2 + "/verschieben", GEMISCHT, false,
                "{\"zielId\":\"" + S1 + "\"}"), "gebaeude.pflegen");

        // Rückwirkend: der Bearbeiter ändert nur ab heute (AP-02 E2, W14); die Energiemanagerin darf rückwirkend.
        String rueckwirkend = "{\"art\":\"gebaeude\",\"name\":\"Halle 7\",\"gueltigAb\":\"2020-01-01\"}";
        MvcResult peter = ruf(HttpMethod.POST, "/api/v1/standorte/" + S2 + "/orte", PH, false, rueckwirkend);
        assertRechtFehlt(peter, "aenderung.rueckwirkend");
        assertThat(MAPPER.readTree(peter.getResponse().getContentAsString(StandardCharsets.UTF_8)).path("rolle_noetig").asText())
                .isEqualTo("energiemanager");
        // Ab heute legt er an seinem Standort an — auch im engen Standort-Zaun (ohne RETURNING, OrtRepository.anlegen).
        MvcResult abHeute = ruf(HttpMethod.POST, "/api/v1/standorte/" + S2 + "/orte", PH, false,
                "{\"art\":\"gebaeude\",\"name\":\"Halle 8\"}");
        assertThat(abHeute.getResponse().getStatus()).as(abHeute.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo(201);
        assertThat(ruf(HttpMethod.POST, "/api/v1/standorte/" + S2 + "/orte", IK, false, rueckwirkend).getResponse()
                .getStatus()).isNotIn(403, 404);
    }

    // ------------------------------------------------------------------ 5. Bestand

    @Test
    void jedesHeutigeKontoKommtAnJederRouteMitRechtBisZumHandler() throws Exception {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv') ON CONFLICT DO NOTHING", AHR, "sub-ahr-bestand-nie", "nie zugewiesen");
        record Konto(String name, RequestPostProcessor anmeldung, String urteil, String... koepfe) {}
        List<Konto> konten = List.of(
                new Konto("Kundenadministrator (Bestandsübernahme)", JW.anmeldung(), "erlaubt"),
                new Konto("Kundenkonto ohne je eine Zuweisung (E12)", authentication(konto("sub-ahr-bestand-nie", AHR)),
                        "erlaubt"),
                new Konto("Plattform am Umschalter X-Tenant-Id (W3)", authentication(konto("sub-ahr-plattform", null,
                        "platform-admin")), "umschalter", "X-Tenant-Id", AHR.toString()),
                new Konto("Token ohne Kontoart", jwt().jwt(j -> j.subject("sub-ahr-token").claim("tenant_id",
                        AHR.toString())), "ohne_kontext"));
        List<String[]> routen = rechtRouten();
        List<String> abweichungen = new ArrayList<>();
        Map<String, Integer> zaehler = new TreeMap<>();
        for (Konto k : konten) {
            Person p = new Person(k.name(), k.name(), k.anmeldung(), k.koepfe());
            for (String[] route : routen) {
                MvcResult r = ruf(HttpMethod.valueOf(route[0]), bestandPfad(route[1]), p, true, "{}", route[2]);
                Object urteil = r.getRequest().getAttribute(RechtInterceptor.URTEIL);
                if (r.getResponse().getStatus() != BIS_HANDLER_STATUS || !k.urteil().equals(urteil)) {
                    abweichungen.add(k.name() + " " + route[0] + " " + route[1] + ": " + r.getResponse().getStatus()
                            + " " + urteil + " " + r.getResponse().getContentAsString(StandardCharsets.UTF_8));
                } else {
                    zaehler.merge(k.name(), 1, Integer::sum);
                }
            }
        }
        System.out.println("Bestand: Routen mit @Recht = " + routen.size() + ", bis zum Handler je Konto: " + zaehler);
        assertThat(routen).hasSizeGreaterThanOrEqualTo(163);
        assertThat(abweichungen).as("heutige Konten, die eine Route mit @Recht nicht mehr erreichen").isEmpty();
    }

    /** Alle Routen mit {@link Recht} aus dem Handler-Mapping — keine Liste von Hand. */
    private List<String[]> rechtRouten() {
        List<String[]> aus = new ArrayList<>();
        for (Map.Entry<RequestMappingInfo, HandlerMethod> e : mapping.getHandlerMethods().entrySet()) {
            if (e.getValue().getMethodAnnotation(Recht.class) == null) {
                continue;
            }
            for (String muster : e.getKey().getPatternValues()) {
                for (RequestMethod m : e.getKey().getMethodsCondition().getMethods()) {
                    String typ = e.getKey().getConsumesCondition().getConsumableMediaTypes().stream().findFirst()
                            .map(Object::toString).orElse(MediaType.APPLICATION_JSON_VALUE);
                    aus.add(new String[] {m.name(), muster, typ});
                }
            }
        }
        aus.sort((a, b) -> (a[1] + a[0]).compareTo(b[1] + b[0]));
        return aus;
    }

    /** Echte Kennungen des Kundenbereichs für die Objekte, an denen das Recht hängt; der Rest gibt es nicht. */
    private static String bestandPfad(String muster) {
        String p = muster
                .replace("/api/v1/messstellen/{id}", "/api/v1/messstellen/" + m1)
                .replace("/api/v1/bezugsgroessen/{id}", "/api/v1/bezugsgroessen/" + b1)
                .replace("/api/v1/geraete/{id}", "/api/v1/geraete/" + gr1)
                .replace("/api/v1/standorte/{id}", "/api/v1/standorte/" + S1)
                .replace("{siteId}", A1.toString())
                .replace("{standortId}", S1.toString())
                .replace("{ortId}", G1.toString())
                .replace("{deviceId}", d1.toString());
        return p.replaceAll("\\{[^}]+}", FREMD.toString());
    }

    // ------------------------------------------------------------------ Anfragen

    private MvcResult ruf(HttpMethod methode, String pfad, Person p, boolean bisHandler, String body) throws Exception {
        return ruf(methode, pfad, p, bisHandler, body, MediaType.APPLICATION_JSON_VALUE);
    }

    private MvcResult ruf(HttpMethod methode, String pfad, Person p, boolean bisHandler, String body, String typ)
            throws Exception {
        MockHttpServletRequestBuilder b = MockMvcRequestBuilders.request(methode, URI.create(pfad)).with(p.anmeldung());
        for (int i = 0; i + 1 < p.koepfe().length; i += 2) {
            b.header(p.koepfe()[i], p.koepfe()[i + 1]);
        }
        if (bisHandler) {
            b.header(BIS_HANDLER, "1");
        }
        if (body != null) {
            b.contentType(typ).content(body);
        }
        try {
            return mvc.perform(b).andReturn();
        } catch (ServletException e) {
            throw new AssertionError(methode + " " + pfad + " als " + p.kurz() + ": Ausnahme im Handler", e);
        }
    }

    private static String pfad(String vorlage) {
        return vorlage.replace("{S1}", S1.toString()).replace("{S2}", S2.toString())
                .replace("{A1}", A1.toString()).replace("{A2}", A2.toString())
                .replace("{G1}", G1.toString()).replace("{G2}", G2.toString())
                .replace("{D1}", d1.toString()).replace("{GR1}", gr1.toString())
                .replace("{M1}", m1.toString()).replace("{M0}", m0.toString()).replace("{B1}", b1.toString())
                .replace("{FREMD}", FREMD.toString());
    }

    /** {@code e} bis zum Handler und erlaubt · {@code 3} recht_fehlt · {@code 4} außerhalb · sonst {@code ?}. */
    private static char urteil(MvcResult r, Set<String> kennungen) throws Exception {
        int status = r.getResponse().getStatus();
        Object urteil = r.getRequest().getAttribute(RechtInterceptor.URTEIL);
        if (status == BIS_HANDLER_STATUS && "erlaubt".equals(urteil)) {
            return 'e';
        }
        if (status == 403 && "recht_fehlt".equals(urteil)) {
            JsonNode body = MAPPER.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8));
            boolean form = "recht_fehlt".equals(body.path("code").asText())
                    && kennungen.contains(body.path("recht").asText())
                    && body.path("message").asText().startsWith("Dafür fehlt Ihnen das Recht.")
                    && body.has("rolle_noetig");
            return form ? '3' : '?';
        }
        if ((status == 404 && "ausserhalb".equals(urteil)) || (status == BIS_HANDLER_STATUS
                && "unsichtbar".equals(urteil))) {
            return '4';
        }
        return '?';
    }

    private static void assertRechtFehlt(MvcResult r, String kennung) throws Exception {
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(403);
        JsonNode body = MAPPER.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertThat(body.path("code").asText()).isEqualTo("recht_fehlt");
        assertThat(body.path("recht").asText()).isEqualTo(kennung);
    }

    private static String antwort(MvcResult r) throws Exception {
        return r.getResponse().getStatus() + " " + r.getResponse().getErrorMessage() + " "
                + r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static Person kunde(String kurz, String name, String sub) {
        return new Person(kurz, name, authentication(konto(sub, AHR)));
    }

    private static org.springframework.security.core.Authentication konto(String sub, UUID tenant,
            String... realmRollen) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", sub);
        claims.put("preferred_username", sub);
        claims.put("realm_access", Map.of("roles", List.of(realmRollen)));
        if (tenant != null) {
            claims.put("tenant_id", tenant.toString());
        }
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    // ------------------------------------------------------------------ Kundenbereich Ahrenberg

    private static void seed() {
        root.update("INSERT INTO tenant (id, name) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH')", AHR);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, AHR);
        standort(S1, u, "Werk Ahrenberg", "ST-1");
        standort(S2, u, "Werk Lindach", "ST-2");
        standort(S3, u, "Werk Ahrenberg Nord", "ST-3");
        root.update("INSERT INTO site (id, tenant_id, name) VALUES (?, ?, 'Halle 1'), (?, ?, 'Lindach')", A1, AHR, A2,
                AHR);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES "
                + "(?, ?, ?, '2024-01-01'), (?, ?, ?, '2024-01-01')", AHR, A1, S1, AHR, A2, S2);
        root.update("INSERT INTO ort (id, tenant_id, art, name, kurzzeichen, zustand) VALUES "
                + "(?, ?, 'gebaeude', 'Halle 1', 'G-1', 'aktiv'), (?, ?, 'gebaeude', 'Halle 5', 'G-5', 'aktiv')", G1,
                AHR, G2, AHR);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES "
                + "(?, ?, ?, '2024-01-01'), (?, ?, ?, '2024-01-01')", AHR, G1, S1, AHR, G2, S2);
        d1 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, 'ahr-box-1') "
                + "RETURNING id", UUID.class, AHR, A1);
        root.update("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, 'ahr-box-2')", AHR, A2);
        gr1 = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, geraeteart, "
                + "seriennummer, geraete_id, eingebaut_am) VALUES (?, ?, 'GR-1', 'GR-1', 'zaehler', 'SN-1', 1, "
                + "'2024-01-01T00:00:00Z') RETURNING id", UUID.class, AHR, A1);
        m1 = messstelle("MS-1", "Netzbezug Halle 1", S1);
        messstelle("MS-2", "Netzbezug Lindach", S2);
        m0 = messstelle("MS-9", "Noch ohne Ort", null);
        b1 = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, periode_art, "
                + "geltung_art, standort_id) VALUES (?, 'BZ-1', 'Gutteile Halle 1', 'periodenwert', 'Stück', 'monat', "
                + "'standort', ?) RETURNING id", UUID.class, AHR, S1);

        OffsetDateTime frueher = ab("2024-03-12");
        OffsetDateTime kuenftig = LocalDate.now(ZoneId.of("Europe/Berlin")).plusYears(1).atStartOfDay()
                .atOffset(ZoneOffset.ofHours(1));
        spiegel("sub-ahr-jonas", "benutzer", "Jonas Wendlinger");
        zuweisung("sub-ahr-jonas", "kundenadministrator", null, frueher);
        spiegel("sub-ahr-ines", "benutzer", "Ines Kaltenbach");
        zuweisung("sub-ahr-ines", "energiemanager", null, frueher);
        spiegel("sub-ahr-peter", "benutzer", "Peter Hollerbach");
        zuweisung("sub-ahr-peter", "bearbeiter", S2, frueher);
        spiegel("sub-ahr-sabine", "benutzer", "Sabine Rauch");
        zuweisung("sub-ahr-sabine", "bearbeiter", S3, kuenftig);
        zuweisung("sub-ahr-sabine", "bedienberechtigt", S3, kuenftig);
        spiegel("sub-ahr-murat", "benutzer", "Murat Demirci");
        zuweisung("sub-ahr-murat", "bedienberechtigt", S1, frueher);
        spiegel("sub-ahr-claudia", "benutzer", "Claudia Berger");
        zuweisung("sub-ahr-claudia", "leser", S1, frueher);
        zuweisung("sub-ahr-claudia", "leser", S2, frueher);
        spiegel("sub-ahr-brunner", "partner", "Thomas Brunner");
        unterstuetzung("sub-ahr-brunner", "installateur", "einrichten_und_bedienen");
        spiegel("sub-ahr-voss", "plattform", "Lena Voss");
        unterstuetzung("sub-ahr-voss", "voltpilot", "ansehen");
        spiegel("sub-ahr-gemischt", "benutzer", "Gemischt");
        zuweisung("sub-ahr-gemischt", "bearbeiter", S2, frueher);
        zuweisung("sub-ahr-gemischt", "leser", S1, frueher);
    }

    private static void standort(UUID id, UUID unternehmen, String name, String kurzzeichen) {
        root.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, ?, 'Europe/Berlin', 'aktiv')", id, AHR, unternehmen, name, kurzzeichen);
    }

    private static UUID messstelle(String kennzeichen, String name, UUID standort) {
        UUID id = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', "
                + "'Zählerstand') RETURNING id", UUID.class, AHR, kennzeichen, name);
        if (standort != null) {
            root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) VALUES "
                    + "(?, ?, ?, '2024-01-01')", AHR, id, standort);
        }
        return id;
    }

    private static void spiegel(String sub, String konto, String name) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, ?, ?, 'aktiv')",
                AHR, sub, konto, name);
    }

    private static void zuweisung(String sub, String rolle, UUID standort, OffsetDateTime ab) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, ?, ?, ?, 'Europe/Berlin')", AHR, sub, rolle, standort, ab);
    }

    private static void unterstuetzung(String sub, String art, String umfang) {
        LocalDate bis = LocalDate.parse("2099-12-30");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, art, umfang, gueltig_ab, "
                + "gueltig_bis, endet_am, zeitzone) VALUES (?, ?, 'unterstuetzer', ?, ?, ?, ?, ?, ?, 'Europe/Berlin')",
                AHR, sub, S1, art, umfang, ab("2026-01-01"), bis,
                bis.plusDays(1).atStartOfDay(ZoneId.of("Europe/Berlin")).toOffsetDateTime());
    }

    private static OffsetDateTime ab(String tag) {
        return LocalDate.parse(tag).atStartOfDay().atOffset(ZoneOffset.ofHours(1));
    }
}
