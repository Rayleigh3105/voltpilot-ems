package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
import com.voltpilot.api.repo.CommandLogRepository;
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
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.Authentication;
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
 *   <li><b>Außerhalb ist dieselbe 404 wie eine Kennung, die es nicht gibt</b> (Messstelle, Bezugsgröße — die Objekte
 *       ohne Standort-Zaun; ein Gerät ({@code geraet}) trägt den Zaun selbst, ist am fremden Standort unsichtbar und
 *       bekommt dieselbe 404 von der Route).</li>
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

    @Autowired
    ZugriffKontextLader lader;

    @Autowired
    RegisterWriteEventRepository journal;

    @Autowired
    CommandLogRepository befehle;

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

    /** Der Notfall-Zugriff (E8) und der Umschalter (W3) — für das Akteur-Vokabular der Journale (IP-7). */
    private static final Person NF = new Person("NF", "VoltPilot-Support (Notfall-Zugriff)",
            authentication(konto("sub-ahr-notfall", null, "platform-admin")), KUNDENBEREICH, AHR.toString());
    private static final Person VP = new Person("VP", "VoltPilot am Umschalter",
            authentication(konto("sub-ahr-plattform", null, "platform-admin")), "X-Tenant-Id", AHR.toString());

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
        // AP-16 IP-15: Standort-Zaun über den Einbauort; der Unterstützer mit „Einrichten“ darf.
        z.add(new Zeile("messmittel.angaben", HttpMethod.PUT, "/api/v1/geraete/{GR1}/messmittel", "ee4433e3"));
        z.add(new Zeile("messstelle.formel", HttpMethod.POST, "/api/v1/sites/{A1}/bilanz/rest", "ee4433e3"));
        z.add(new Zeile("messstelle.verteilung", HttpMethod.PUT, "/api/v1/messstellen/{M1}/verteilung", "ee4433e3"));
        z.add(new Zeile("ablesung.erfassen", HttpMethod.POST, "/api/v1/messstellen/MS-1/ablesungen", "eee33333"));
        z.add(new Zeile("ablesung.erfassen", HttpMethod.POST,
                "/api/v1/messstellen/MS-1/ablesungen/2026-09-16T12:00:00Z/berichtigung", "eee33333"));
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
        z.add(new Zeile("bezugsbasis.verwalten", HttpMethod.POST, "/api/v1/kennzahlen/{FREMD}/bezugsbasen", "eee33333"));
        z.add(new Zeile("bezugsbasis.verwalten", HttpMethod.POST,
                "/api/v1/kennzahlen/{FREMD}/bezugsbasen/{FREMD}/fassungen", "eee33333"));
        z.add(new Zeile("bericht.standort_freigeben|bericht.unternehmen|bewertung.abrufen", HttpMethod.POST, "/api/v1/berichte",
                "eee33333"));
        z.add(new Zeile("cockpit.anpassen", HttpMethod.PUT, "/api/v1/sites/{A1}/cockpit-layout", "ee44333e"));
        z.add(new Zeile("cockpit.anpassen", HttpMethod.PUT, "/api/v1/tenant/cockpit-layout", "ee33333e"));
        z.add(new Zeile("energieeinsatz.verwalten", HttpMethod.POST, "/api/v1/unternehmen/energieeinsaetze", "ee333333"));
        z.add(new Zeile("energieeinsatz.einstufen", HttpMethod.PUT,
                "/api/v1/unternehmen/energieeinsaetze/{A1}/einstufung", "ee333333"));
        z.add(new Zeile("energieeinsatz.einstufen", HttpMethod.POST,
                "/api/v1/unternehmen/energieeinsaetze/{A1}/einstufung/bestaetigen", "ee333333"));
        z.add(new Zeile("bewertung.kriterien", HttpMethod.PUT, "/api/v1/unternehmen/bewertung/kriterien", "ee333333"));
        z.add(new Zeile("bewertung.kriterien", HttpMethod.POST, "/api/v1/unternehmen/bewertung/kriterien/2/freigeben", "ee333333"));
        z.add(new Zeile("bewertung.kriterien", HttpMethod.POST, "/api/v1/unternehmen/bewertung/kriterien/2/ablehnen", "ee333333"));
        return z;
    }

    /**
     * Zeilen der Gruppen 1–3 ohne Zeile oben — und warum. Der Test hält die Liste mit der Matrix-Datei zusammen.
     */
    private static final Map<String, String> OHNE_SCHREIBROUTE = Map.ofEntries(
            Map.entry("aenderung.rueckwirkend", "genaue Prüfung im Körper — genaueRechtePruefungImAnfragekoerper"),
            Map.entry("aenderungsprotokoll.lesen", "lesend — Standort-Zaun (IP-5)"),
            Map.entry("korrektur.erfassen", "keine Schreibroute (Korrektur erfassen ist noch nicht gebaut)"),
            Map.entry("ersatzwert.erfassen", "keine Schreibroute (Ersatzwert erfassen ist noch nicht gebaut)"),
            Map.entry("messwerte.ansehen", "lesend — Standort-Zaun (IP-5), Teilansicht IP-10/IP-11"),
            Map.entry("bericht.standort_abrufen", "lesend — IP-11"),
            Map.entry("export.standort", "lesend — IP-11"),
            Map.entry("export.unternehmen", "lesend — IP-11"),
            Map.entry("auswertung.anlegen", "keine Schreibroute (Eigene Auswertung liest nur)"),
            Map.entry("energieeinsatz.ansehen", "lesend — EnergieeinsatzApiTest, Prozess-Messstellen-Zaun R14"),
            Map.entry("bezugsbasis.freigeben", "reserviert für AP-17 IP-8 (Routen)"),
            Map.entry("bezugsbasis.ansehen", "reserviert für AP-17 IP-8 (Routen), Zaun über die Kennzahl"));

    @Test
    void jeMatrixZeileDerGruppenEinsBisDreiUrteilenDieAchtPersonen() throws Exception {
        pruefeZeilen(zeilen(), "Gruppen 1–3");
    }

    /**
     * Gruppe 4 — alles, was STEUERT (IP-7): Handeingriffe, Betriebsweise, Ladepunkt-Betrieb, Schalt-Test, Freigabe,
     * Grenze, Register, Prognose. Dieselbe Mechanik wie die Gruppen 1–3, kein zweiter Weg.
     */
    @Test
    void jeMatrixZeileDerGruppeVierUrteilenDieAchtPersonen() throws Exception {
        pruefeZeilen(zeilenSteuerung(), "Gruppe 4 — Steuerung");
    }

    private void pruefeZeilen(List<Zeile> zeilen, String titel) throws Exception {
        List<String> abweichungen = new ArrayList<>();
        Map<String, String> tabelle = new LinkedHashMap<>();
        for (Zeile z : zeilen) {
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
        System.out.println("Rechte je Zeile " + titel + " (JW IK PH SR MD CB TB LV; e erlaubt · 3 recht_fehlt · "
                + "4 außerhalb):");
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
        List<String> urteile = new ArrayList<>();
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
            urteile.add(p[1] + " → " + aussen.getRequest().getAttribute(RechtInterceptor.URTEIL));
        }
        // ZUERST die Zusicherung, um die es hier geht: außerhalb und unbekannt sind nicht zu
        // unterscheiden. Sie stand bisher HINTER der Urteils-Prüfung in der Schleife und lief
        // deshalb gar nicht, sobald ein Urteil abwich (fail-fast) - das Leck-Argument war also
        // unbewiesen, während die Klasse rot stand.
        assertThat(abweichungen).isEmpty();
        // Und dann das Urteil je Route, genau statt pauschal.
        assertThat(urteile).containsExactly(
                "/api/v1/bezugsgroessen/%s/archivieren → ausserhalb",
                "/api/v1/bezugsgroessen/%s → ausserhalb",
                "/api/v1/messstellen/%s/archivieren → ausserhalb",
                "/api/v1/messstellen/%s/verteilung → ausserhalb",
                "/api/v1/messstellen/%s/prozesse → ausserhalb",
                // Entschieden am 21.09.2026, Lesart A: geraet behält den Standort-Zaun aus
                // V20260918102000 (wago_geraet_site_scope AS RESTRICTIVE), RechtPruefung löst
                // GERAET wie DEVICE auf. Ein Gerät an einem fremden Standort ist unsichtbar - die
                // Route antwortet selbst, mit derselben 404 wie für eine unbekannte Kennung
                // (Zusicherung oben). Tor G1, Punkt R1 liest diesen Test als Beleg.
                "/api/v1/geraete/%s/austausch → unsichtbar");
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
                .replace("{deviceId}", d1.toString())
                .replace("{newId}", d1.toString()).replace("{oldId}", d1.toString());
        return p.replaceAll("\\{[^}]+}", FREMD.toString());
    }

    // ------------------------------------------------------------------ 6. Gruppe 4 — die Steuerung (IP-7)

    /**
     * Die Zeilen der Gruppe 4 mit den Routen, die sie tragen — 50 Schreibwege, die an einer realen Anlage eingreifen.
     * Muster der Erwartung (JW IK PH SR MD CB TB LV): {@code betrieb} = „Betrieb im Rahmen" (E4), {@code rahmen} =
     * Sache des Kundenadministrators, {@code einrichten} = auch der Unterstützer ab „Einrichten".
     */
    private static List<Zeile> zeilenSteuerung() {
        List<Zeile> z = new ArrayList<>();
        String betrieb = "e344e3e3";            // U - - S - B -
        String ladepunktBetrieb = "e344e3ee";   // U - - S - B P
        String einrichten = "e34433e3";         // U - - - - Ei -
        String einrichtenP = "e34433ee";        // U - - - - Ei P
        String rahmen = "e344333e";             // U - - - - - P
        String s1 = "/api/v1/sites/{A1}";
        // Handeingriffe — Zone Jetzt (Dauer Pflicht, TTL ≤ 24 h)
        z.add(new Zeile("handeingriff.setzen", HttpMethod.POST, s1 + "/automation-pause", betrieb));
        z.add(new Zeile("handeingriff.setzen", HttpMethod.DELETE, s1 + "/automation-pause", betrieb));
        z.add(new Zeile("handeingriff.setzen", HttpMethod.POST, s1 + "/battery-override", betrieb));
        z.add(new Zeile("handeingriff.setzen", HttpMethod.DELETE, s1 + "/battery-override", betrieb));
        z.add(new Zeile("handeingriff.setzen", HttpMethod.POST, s1 + "/consumers/{FREMD}/override", betrieb));
        z.add(new Zeile("handeingriff.setzen", HttpMethod.DELETE, s1 + "/consumers/{FREMD}/override", betrieb));
        z.add(new Zeile("handeingriff.setzen", HttpMethod.POST, s1 + "/charging-boost", betrieb));
        // Betriebsweise — Betriebsmodell, Regeln, Steuerart, Rangliste
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/consumers/{FREMD}/pause", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/consumers/{FREMD}/resume", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/consumers/{FREMD}/policy/activate", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/consumers/{FREMD}/policy/deactivate", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/consumers/{FREMD}/policy", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/flows/auto-start", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/flows", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/flows/{FREMD}/versions/1", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/flows/{FREMD}/layout", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.DELETE, s1 + "/flows/{FREMD}", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/flows/{FREMD}/versions/1/validate", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/flows/{FREMD}/versions/1/simulate", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/flows/{FREMD}/versions/1/activate", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.POST, s1 + "/flows/{FREMD}/deactivate", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/charging-config/charge-points/cp-1/source",
                betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/rangliste", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/verbraucher/{FREMD}/steuerart", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/profiles", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/anwendungs-preset", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/profile", betrieb));
        z.add(new Zeile("betriebsweise.aendern", HttpMethod.PUT, s1 + "/suggestion-states/k-1", betrieb));
        // Ladekarten, Fahrzeuge, OCPP-Betriebsaktionen — die Plattform behält ihre Stufe (P)
        z.add(new Zeile("ladepunkt.betrieb", HttpMethod.PUT, s1 + "/fahrzeuge/t-1", ladepunktBetrieb));
        z.add(new Zeile("ladepunkt.betrieb", HttpMethod.DELETE, s1 + "/fahrzeuge/t-1", ladepunktBetrieb));
        z.add(new Zeile("ladepunkt.betrieb", HttpMethod.POST, s1 + "/ocpp/stations/cp-1/action-intents",
                ladepunktBetrieb));
        z.add(new Zeile("ladepunkt.betrieb", HttpMethod.POST, s1 + "/ocpp/stations/cp-1/actions", ladepunktBetrieb));
        z.add(new Zeile("ladepunkt.betrieb", HttpMethod.DELETE, s1 + "/ocpp/actions/{FREMD}", ladepunktBetrieb));
        // Anbinden, Schalt-Test, Messen einrichten — der Unterstützer bereitet vor
        z.add(new Zeile("ladepunkt.anbinden", HttpMethod.POST, s1 + "/charging-config/charge-points", einrichten));
        z.add(new Zeile("ladepunkt.anbinden", HttpMethod.DELETE, s1 + "/charging-config/charge-points/cp-1",
                einrichten));
        z.add(new Zeile("schalttest.durchfuehren", HttpMethod.POST, s1 + "/components/custom/{FREMD}/switch-test",
                einrichten));
        z.add(new Zeile("schalttest.durchfuehren", HttpMethod.POST,
                s1 + "/components/custom/{FREMD}/switch-test/cancel", einrichten));
        z.add(new Zeile("funktion.messen_einrichten", HttpMethod.PUT, "/api/v1/standorte/{S1}/funktionen/messen",
                "ee4433e3"));
        // Register schreiben — Vorschau und Schreiben, beide mit Journal
        z.add(new Zeile("register.schreiben", HttpMethod.POST, s1 + "/register-write", einrichtenP));
        z.add(new Zeile("register.schreiben", HttpMethod.POST, s1 + "/register-write/preview", einrichtenP));
        // Rahmen — Freigabe, OCPP-Regelung, Preisblatt
        z.add(new Zeile("freigabe.erteilen", HttpMethod.POST, s1 + "/components/custom/{FREMD}/switch-release",
                rahmen));
        z.add(new Zeile("freigabe.erteilen", HttpMethod.DELETE, s1 + "/components/custom/{FREMD}/switch-release",
                rahmen));
        z.add(new Zeile("freigabe.erteilen", HttpMethod.PUT, s1 + "/ocpp/control", rahmen));
        z.add(new Zeile("anlage.verwalten", HttpMethod.PUT, s1 + "/supply-price", rahmen));
        z.add(new Zeile("prognose.befoerdern", HttpMethod.POST, s1 + "/forecast-models", "ee44333e"));
        // Was nichts an der Anlage ändert, hängt am Lese-Recht (Vorschau und Ersparnis-Simulation)
        z.add(new Zeile("messwerte.ansehen", HttpMethod.POST, s1 + "/steuerung-vorschau", "ee44eeee"));
        z.add(new Zeile("messwerte.ansehen", HttpMethod.POST, s1 + "/simulation", "ee44eeee"));
        // Mehrere Rechte in einem Aufruf: die Vorprüfung „irgendwo", die genaue Prüfung im Handler
        String steuernAnlage = "funktion.steuern_einrichten|steuerung.starten_beenden|steuerung.anhalten_fortsetzen";
        String steuernStandort = "steuerung.starten_beenden|steuerung.anhalten_fortsetzen";
        z.add(new Zeile(steuernAnlage, HttpMethod.PUT, s1 + "/funktionen/steuern", "e333e3e3"));
        z.add(new Zeile(steuernStandort, HttpMethod.PUT, "/api/v1/standorte/{S1}/funktionen/steuern", "e333e3e3"));
        z.add(new Zeile("grenze.eintragen|betriebsweise.aendern", HttpMethod.PUT, s1 + "/charging-config",
                "e333e3ee"));
        // Gemeinsame Steuerung (AP-15 IP-5, I5): der Kunde richtet ein und hält an; scharf schaltet nur die
        // Plattform unter /api/v1/admin (keine Zeile hier)
        String nurKa = "e3443333";              // U - - - - - -
        String gs = s1 + "/gemeinsame-steuerung";
        z.add(new Zeile("funktion.steuern_einrichten", HttpMethod.PUT, gs, einrichten));
        // Frage 6 für einen Entwurf (schreibt nichts, gehört aber zum Einrichten) — Recht wie einrichten
        z.add(new Zeile("funktion.steuern_einrichten", HttpMethod.POST, gs + "/einrichten/vorschau", einrichten));
        // Rückfall am Gerät hinterlegen (IP-6, Folgepunkt PR 1026) — Recht wie einrichten
        z.add(new Zeile("funktion.steuern_einrichten", HttpMethod.PUT, gs + "/komponenten/{FREMD}/rueckfall",
                einrichten));
        z.add(new Zeile("steuerung.starten_beenden", HttpMethod.POST, gs + "/anhalten", nurKa));
        z.add(new Zeile("steuerung.starten_beenden", HttpMethod.POST, gs + "/fortsetzen", nurKa));
        z.add(new Zeile("steuerung.starten_beenden", HttpMethod.POST, gs + "/aufloesen", nurKa));
        // Ausscheiden eines Mitglieds (§5.5) — Recht wie auflösen
        z.add(new Zeile("steuerung.starten_beenden", HttpMethod.POST, gs + "/mitglieder/{FREMD}/ausscheiden", nurKa));
        return z;
    }

    /** Zeilen der Gruppe 4 ohne eigene Route — und warum. */
    private static final Map<String, String> OHNE_SCHREIBROUTE_STEUERUNG = Map.of(
            "grenze.eintragen", "im Rumpf von PUT /charging-config (genaue Prüfung je Feld)",
            "steuerung.anhalten_fortsetzen", "im Rumpf von PUT …/funktionen/steuern (genaue Prüfung je Aktion)");

    /** Jede Zeile der Gruppe 4 hat eine Route oben oder einen Grund. */
    @Test
    void jedeZeileDerGruppeVierIstAbgedeckt() throws Exception {
        JsonNode datei = MAPPER.readTree(getClass().getClassLoader().getResourceAsStream(RechteMatrixDatei.PFAD));
        Set<String> abgedeckt = new java.util.TreeSet<>();
        zeilenSteuerung().forEach(z -> abgedeckt.addAll(List.of(z.kennungen().split("\\|"))));
        List<String> offen = new ArrayList<>();
        for (JsonNode a : datei.path("aktionen")) {
            String k = a.path("kennung").asText();
            if ("steuerung".equals(a.path("gruppe").asText()) && !abgedeckt.contains(k)
                    && !OHNE_SCHREIBROUTE_STEUERUNG.containsKey(k)) {
                offen.add(k);
            }
        }
        assertThat(offen).as("Zeilen der Gruppe 4 ohne Route und ohne Grund").isEmpty();
    }

    /**
     * Die andere Richtung des Bestandsnachweises: ein Konto, dessen Zelle in JEDER Kennung der Route „-" ist, kommt
     * an KEINER Steuerungsroute durch — geprüft an allen Routen der Gruppe 4 aus dem Handler-Mapping, nicht an einer
     * Liste von Hand.
     */
    @Test
    void keinKontoOhneSteuerrechtKommtAnEinerSteuerungsrouteDurch() throws Exception {
        JsonNode datei = MAPPER.readTree(getClass().getClassLoader().getResourceAsStream(RechteMatrixDatei.PFAD));
        Map<String, JsonNode> aktionen = new HashMap<>();
        for (JsonNode a : datei.path("aktionen")) {
            aktionen.put(a.path("kennung").asText(), a);
        }
        record Ohne(Person person, String rolle) {}
        List<Ohne> ohne = List.of(new Ohne(CB, "leser"), new Ohne(IK, "energiemanager"));
        List<String> durch = new ArrayList<>();
        int geprueft = 0;
        for (Map.Entry<RequestMappingInfo, HandlerMethod> e : mapping.getHandlerMethods().entrySet()) {
            Recht recht = e.getValue().getMethodAnnotation(Recht.class);
            if (recht == null || !List.of(recht.value()).stream()
                    .allMatch(k -> "steuerung".equals(aktionen.get(k).path("gruppe").asText()))) {
                continue;
            }
            for (Ohne o : ohne) {
                if (List.of(recht.value()).stream()
                        .anyMatch(k -> !"-".equals(aktionen.get(k).path("zellen").path(o.rolle()).asText()))) {
                    continue;
                }
                for (String muster : e.getKey().getPatternValues()) {
                    for (RequestMethod m : e.getKey().getMethodsCondition().getMethods()) {
                        String typ = e.getKey().getConsumesCondition().getConsumableMediaTypes().stream().findFirst()
                                .map(Object::toString).orElse(MediaType.APPLICATION_JSON_VALUE);
                        MvcResult r = ruf(HttpMethod.valueOf(m.name()), bestandPfad(muster), o.person(), true, "{}",
                                typ);
                        geprueft++;
                        if (r.getResponse().getStatus() != 403
                                || !"recht_fehlt".equals(r.getRequest().getAttribute(RechtInterceptor.URTEIL))) {
                            durch.add(o.person().kurz() + " " + m + " " + muster + ": " + r.getResponse().getStatus()
                                    + " " + r.getRequest().getAttribute(RechtInterceptor.URTEIL));
                        }
                    }
                }
            }
        }
        System.out.println("Ohne Steuerrecht geprüft: " + geprueft + " Aufrufe");
        assertThat(durch).as("Steuerungsrouten, an denen ein Konto ohne Steuerrecht durchkommt").isEmpty();
        assertThat(geprueft).isGreaterThanOrEqualTo(80);
    }

    /**
     * E13: die OCPP-Stufe kommt aus der Zuweisung, nicht mehr aus der Realm-Rolle. Bedienberechtigt hat dieselbe
     * Stufe wie der Kundenadministrator (E4), der Unterstützer mit „Einrichten und Bedienen" die Kunden-Stufe,
     * Energiemanager und Leser keine (Achsentrennung); die Plattform bleibt PLATTFORM.
     */
    @Test
    void dieOcppStufeKommtAusDerZuweisungUndNichtMehrAusDerRealmRolle() throws Exception {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv') ON CONFLICT DO NOTHING", AHR, "sub-ahr-bestand-nie", "nie zugewiesen");
        Set<String> kunde = Set.of("RemoteStartTransaction", "RemoteStopTransaction", "UnlockConnector");
        Set<String> anlage = new java.util.TreeSet<>(kunde);
        anlage.addAll(Set.of("ReserveNow", "CancelReservation", "GetCompositeSchedule", "ChangeAvailability",
                "SoftReset", "GetConfiguration", "ChangeConfiguration", "ClearCache", "GetLocalListVersion",
                "SendLocalList", "TriggerMessage"));
        Set<String> plattform = new java.util.TreeSet<>(anlage);
        plattform.addAll(Set.of("HardReset", "GetDiagnostics", "UpdateFirmware", "DataTransfer"));
        record Stufe(Person person, Set<String> freigaben, int status) {}
        List<Stufe> stufen = List.of(
                new Stufe(JW, anlage, 200),
                new Stufe(IK, Set.of(), 200),
                new Stufe(PH, Set.of(), 404),
                new Stufe(SR, Set.of(), 404),
                new Stufe(MD, anlage, 200),
                new Stufe(CB, Set.of(), 200),
                new Stufe(TB, kunde, 200),
                new Stufe(LV, plattform, 200),
                new Stufe(VP, plattform, 200),
                // Captain 22.09.2026 E2 = A: das gedachte Bestands-Recht gilt auch auf der OCPP-Achse.
                new Stufe(new Person("BN", "Kundenkonto ohne je eine Zuweisung",
                        authentication(konto("sub-ahr-bestand-nie", AHR))), anlage, 200));
        Map<String, String> tabelle = new LinkedHashMap<>();
        for (Stufe s : stufen) {
            MvcResult r = ruf(HttpMethod.GET, "/api/v1/sites/" + A1 + "/ocpp/action-permissions", s.person(), false,
                    null);
            assertThat(r.getResponse().getStatus()).as(s.person().kurz()).isEqualTo(s.status());
            if (s.status() != 200) {
                tabelle.put(s.person().kurz(), "404");
                continue;
            }
            Set<String> erlaubt = new java.util.TreeSet<>();
            MAPPER.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).path("actions").fields()
                    .forEachRemaining(f -> {
                        if (f.getValue().asBoolean()) {
                            erlaubt.add(f.getKey());
                        }
                    });
            assertThat(erlaubt).as(s.person().kurz()).isEqualTo(new java.util.TreeSet<>(s.freigaben()));
            tabelle.put(s.person().kurz(), erlaubt.size() + " Aktionen");
        }
        System.out.println("OCPP-Stufen je Person: " + tabelle);
    }

    @Test
    void bestandskontoDarfSoftResetNurImEigenenKundenbereichBisZumStichtag() throws Exception {
        String sub = "sub-ahr-ocpp-bestand";
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                + "VALUES (?, ?, 'benutzer', 'Bestandskonto', 'aktiv')", AHR, sub);
        Person bestand = new Person("BN", "Bestandskonto", authentication(konto(sub, AHR)));
        UUID andereAnlage = root.queryForObject("SELECT id FROM site WHERE tenant_id <> ? ORDER BY id LIMIT 1",
                UUID.class, AHR);
        String eigeneStufe = "/api/v1/sites/" + A1 + "/ocpp/action-permissions";
        String fremdeStufe = "/api/v1/sites/" + andereAnlage + "/ocpp/action-permissions";
        try {
            assertThat(root.queryForObject("SELECT count(*) FROM zugriff_bestand WHERE tenant_id = ?",
                    Integer.class, AHR)).isZero();
            MvcResult vorher = ruf(HttpMethod.GET, eigeneStufe, bestand, false, null);
            assertThat(vorher.getResponse().getStatus()).isEqualTo(200);
            assertThat(MAPPER.readTree(vorher.getResponse().getContentAsString(StandardCharsets.UTF_8))
                    .path("actions").path("SoftReset").asBoolean()).isTrue();
            JsonNode me = MAPPER.readTree(ruf(HttpMethod.GET, "/api/v1/me", bestand, false, null)
                    .getResponse().getContentAsString(StandardCharsets.UTF_8));
            // /me zeigt ausschließlich echte Zuweisungen; die bestehende Selbstauskunft bleibt unverändert.
            assertThat(me.path("standorte")).isEmpty();
            assertThat(ruf(HttpMethod.GET, fremdeStufe, bestand, false, null).getResponse().getStatus()).isEqualTo(404);

            // Der Stichtag ist die vorhandene Übernahme-Markierung, kein Vergleich mit der Wanduhr.
            root.update("INSERT INTO zugriff_bestand (tenant_id, stichtag, herkunft, konten) "
                    + "VALUES (?, now(), 'bestandslauf', 0)", AHR);
            assertThat(ruf(HttpMethod.GET, eigeneStufe, bestand, false, null).getResponse().getStatus()).isEqualTo(404);
            assertThat(ruf(HttpMethod.GET, fremdeStufe, bestand, false, null).getResponse().getStatus()).isEqualTo(404);
            me = MAPPER.readTree(ruf(HttpMethod.GET, "/api/v1/me", bestand, false, null)
                    .getResponse().getContentAsString(StandardCharsets.UTF_8));
            assertThat(me.path("standorte")).isEmpty();
            assertThat(ruf(HttpMethod.GET, eigeneStufe, JW, false, null).getResponse().getStatus())
                    .as("echte Kundenadmin-Zuweisung gilt nach dem Stichtag weiter").isEqualTo(200);
        } finally {
            root.update("DELETE FROM zugriff_bestand WHERE tenant_id = ?", AHR);
            root.update("DELETE FROM benutzer WHERE tenant_id = ? AND sub = ?", AHR, sub);
        }
    }

    /**
     * A3 und A11: die Energiemanagerin pflegt Messdaten und steuert nicht; der Bedienberechtigte bedient und rahmt
     * nicht. Mit echtem Handler — was 200 sagt, steht hinterher auch im Journal.
     */
    @Test
    void a3UndA11BedienberechtigtBedientUndRahmtNicht() throws Exception {
        String anlage = "/api/v1/sites/" + A1;
        assertRechtFehlt(ruf(HttpMethod.POST, anlage + "/automation-pause", IK, false, "{\"durationMinutes\":30}"),
                "handeingriff.setzen");
        MvcResult pause = ruf(HttpMethod.POST, anlage + "/automation-pause", MD, false, "{\"durationMinutes\":30}");
        assertThat(pause.getResponse().getStatus())
                .as(pause.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(200);
        assertThat(root.queryForMap("SELECT actor_sub, actor_name, actor_rolle, actor_art FROM consumer_audit_event "
                + "WHERE site_id = ? AND event_type = 'automation_paused' ORDER BY id DESC LIMIT 1", A1))
                .containsEntry("actor_sub", "sub-ahr-murat").containsEntry("actor_rolle", "bedienberechtigt")
                .containsEntry("actor_art", "kunde");
        assertThat(ruf(HttpMethod.DELETE, anlage + "/automation-pause", MD, false, null).getResponse().getStatus())
                .isEqualTo(200);

        MvcResult freigabe = ruf(HttpMethod.POST, anlage + "/components/custom/" + FREMD + "/switch-release", MD,
                false, "{}");
        assertRechtFehlt(freigabe, "freigabe.erteilen");
        assertThat(MAPPER.readTree(freigabe.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .path("rolle_noetig").asText()).isEqualTo("kundenadministrator");
        assertRechtFehlt(ruf(HttpMethod.PUT, anlage + "/charging-config", MD, false, "{\"gridLimitKw\":200}"),
                "grenze.eintragen");
        assertRechtFehlt(ruf(HttpMethod.PUT, anlage + "/ocpp/control", MD, false, "{\"revision\":0}"),
                "freigabe.erteilen");
        assertRechtFehlt(ruf(HttpMethod.PUT, anlage + "/funktionen/steuern", MD, false, "{\"aktion\":\"starten\"}"),
                "steuerung.starten_beenden");
        assertThat(ruf(HttpMethod.PUT, anlage + "/funktionen/steuern", MD, false, "{\"aktion\":\"anhalten\"}")
                .getResponse().getStatus()).as("anhalten ist Betrieb im Rahmen (E4)").isNotEqualTo(403);
    }

    /**
     * Ein Eintrag je Art in allen vier Protokollen (IP-7): Änderungsprotokoll und Handeingriff über ihre Routen,
     * Register-Journal und Befehls-Verlauf über ihren Schreibweg — beide reichen seit jeher nur das Subject weiter,
     * der Urheber kommt aus dem Zugriff der Anfrage ({@code ProtokollAkteur.angemeldetAls}).
     */
    @Test
    void jedesProtokollTraegtDenUrheberJeArt() throws Exception {
        record Akteur(String art, Person person, Authentication auth, String kopf, UUID tenant, String rolle,
                String origin, String rolleAlt) {}
        List<Akteur> arten = List.of(
                new Akteur("kunde", JW, konto("sub-ahr-jonas", AHR), null, AHR, "kundenadministrator", "kunde",
                        "operator"),
                new Akteur("unterstuetzung", TB, konto("sub-ahr-brunner", null, "partner"), AHR.toString(), null,
                        "unterstuetzer", "kunde", "operator"),
                new Akteur("voltpilot", VP, konto("sub-ahr-plattform", null, "platform-admin"), null, AHR,
                        "voltpilot_betrieb", "voltpilot", "platform-admin"),
                new Akteur("notfall", NF, konto("sub-ahr-notfall", null, "platform-admin"), AHR.toString(), null,
                        "unterstuetzer", "voltpilot", "platform-admin"));
        for (Akteur a : arten) {
            MvcResult angelegt = ruf(HttpMethod.POST, "/api/v1/standorte/" + S1 + "/orte", a.person(), false,
                    "{\"art\":\"gebaeude\",\"name\":\"Akteur " + a.art() + "\"}");
            assertThat(angelegt.getResponse().getStatus())
                    .as(a.art() + ": " + angelegt.getResponse().getContentAsString(StandardCharsets.UTF_8))
                    .isEqualTo(201);
            String ort = MAPPER.readTree(angelegt.getResponse().getContentAsString(StandardCharsets.UTF_8))
                    .path("id").asText();
            JsonNode protokoll = MAPPER.readTree(ruf(HttpMethod.GET, "/api/v1/orte/" + ort + "/aenderungen", JW,
                    false, null).getResponse().getContentAsString(StandardCharsets.UTF_8));
            assertThat(protokoll.at("/eintraege/0/urheber/art").asText()).as(a.art() + " Änderungsprotokoll")
                    .isEqualTo(a.art());
            assertThat(protokoll.at("/eintraege/0/urheber/rolle").asText()).as(a.art() + " Rolle")
                    .isEqualTo(a.rolle());

            MvcResult pause = ruf(HttpMethod.POST, "/api/v1/sites/" + A1 + "/automation-pause", a.person(), false,
                    "{\"durationMinutes\":30}");
            assertThat(pause.getResponse().getStatus())
                    .as(a.art() + ": " + pause.getResponse().getContentAsString(StandardCharsets.UTF_8))
                    .isEqualTo(200);
            assertThat(root.queryForMap("SELECT actor_rolle, actor_art FROM consumer_audit_event WHERE site_id = ? "
                    + "AND event_type = 'automation_paused' ORDER BY id DESC LIMIT 1", A1))
                    .as(a.art() + " Handeingriff-Journal")
                    .containsEntry("actor_rolle", a.rolle()).containsEntry("actor_art", a.art());
            assertThat(root.queryForMap("SELECT actor_rolle, actor_art FROM device_override WHERE site_id = ? "
                    + "AND entity_id IS NULL", A1)).as(a.art() + " laufender Handeingriff")
                    .containsEntry("actor_rolle", a.rolle()).containsEntry("actor_art", a.art());

            alsAnfrage(a.auth(), a.kopf(), a.tenant(), () -> {
                ProtokollAkteur wer = ProtokollAkteur.angemeldetAls(((Jwt) a.auth().getPrincipal()).getSubject())
                        .orElseThrow();
                assertThat(wer.art()).as(a.art() + " ProtokollAkteur").isEqualTo(a.art());
                assertThat(wer.rolle()).as(a.art() + " Rolle").isEqualTo(a.rolle());
                journal.recordRequest(new RegisterWriteEventRepository.Request("rw-" + a.art(), "portal", A1, d1,
                        "ahr-box-1", "primaer", null, "Halle 1 · Register 40001", "holding", 40001, 6, "40001", "1",
                        null, 1, null, null, "unbekannt", null, a.origin(), wer.sub(), wer.name(), a.rolleAlt(),
                        false, Instant.now(), wer.rolle(), wer.art()));
                befehle.appendEvent(A1, d1, null, "ladepunkt", "voll_laden_erteilt", Instant.now(), Instant.now(),
                        wer);
            });
        }
        JsonNode verlauf = MAPPER.readTree(ruf(HttpMethod.GET, "/api/v1/sites/" + A1 + "/command-history", JW, false,
                null).getResponse().getContentAsString(StandardCharsets.UTF_8));
        Set<String> imRegister = new java.util.TreeSet<>();
        Set<String> imVerlauf = new java.util.TreeSet<>();
        for (JsonNode e : verlauf.path("entries")) {
            if (e.hasNonNull("register")) {
                imRegister.add(e.at("/register/actorArt").asText());
            } else if (e.hasNonNull("urheber")) {
                imVerlauf.add(e.at("/urheber/art").asText());
            }
        }
        assertThat(imRegister).as("Register-Journal")
                .containsExactlyInAnyOrder("kunde", "unterstuetzung", "voltpilot", "notfall");
        assertThat(imVerlauf).as("Befehls-Verlauf")
                .containsExactlyInAnyOrder("kunde", "unterstuetzung", "voltpilot", "notfall");
        ruf(HttpMethod.DELETE, "/api/v1/sites/" + A1 + "/automation-pause", JW, false, null);
    }

    /** Eine Anfrage wie im Filterlauf: Anmeldung, Kundenbereich, Zugriff — und hinterher alles wieder abgeräumt. */
    private void alsAnfrage(Authentication auth, String kopf, UUID tenant, Runnable arbeit) {
        SecurityContextHolder.getContext().setAuthentication(auth);
        if (tenant != null) {
            TenantContext.set(tenant);
        }
        try {
            ZugriffKontextLader.Ergebnis e = lader.laden(auth, kopf);
            assertThat(e.zugriff()).as("Zugriff der Anfrage").isNotNull();
            ZugriffContext.set(e.zugriff());
            arbeit.run();
        } finally {
            ZugriffContext.clear();
            TenantContext.clear();
            SecurityContextHolder.clearContext();
        }
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
        // Der Notfall-Zugriff (E8): 23 Stunden, ohne Enddatum-Tag, nur mit Zeitpunkt.
        spiegel("sub-ahr-notfall", "plattform", "VoltPilot-Support");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, art, umfang, gueltig_ab, "
                + "endet_am, zeitzone) VALUES (?, 'sub-ahr-notfall', 'unterstuetzer', ?, 'notfall', "
                + "'einrichten_und_bedienen', now() - interval '1 hour', now() + interval '23 hours', "
                + "'Europe/Berlin')", AHR, S1);
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
