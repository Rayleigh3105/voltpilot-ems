package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import jakarta.servlet.ServletException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Der Zaun von UEMS AP-03 IP-4 über ALLE Routen des API (aus dem {@link RequestMappingHandlerMapping}, keine Liste von
 * Hand) — mit dem Demo-Kundenbereich des Dev-Seeds.
 *
 * <ol>
 *   <li><b>Partner ohne wirksame Unterstützung: 404 auf jeder Kundenroute</b>, jede Methode, in acht Varianten (ohne
 *       Kopf, fremder/kaputter Kopf, {@code X-Tenant-Id}, beendete Unterstützung, Unterstützung in einem ANDEREN
 *       Kundenbereich, Plattform mit {@code X-Kundenbereich} ohne Unterstützung).</li>
 *   <li><b>Die Einstellungen je Anfrage</b> über eine Test-Route, die {@code current_setting} liest: jeder Aufrufer
 *       sieht seine eigenen, auch abwechselnd hintereinander (der Pool gibt Verbindungen weiter).</li>
 *   <li><b>Bestand: jedes heutige Konto sieht auf jeder lesenden Kundenroute dasselbe wie vor IP-4.</b> „Vorher" ist
 *       derselbe Aufbau, in dem der {@link ZugriffKontextLader} nichts lädt — dann bleibt der Kontext leer, der Filter
 *       reicht durch, und die Verbindung setzt nur {@code app.tenant_id}, genau wie vor diesem Paket. Verglichen werden
 *       Status und Körper; eine Route, deren Antwort schon zwischen zwei „vorher"-Aufrufen wechselt (Zeitstempel),
 *       zählt als flüchtig und wird nur am Status gemessen.</li>
 *   <li><b>Die 18 nach IP-4 eingeführten Lese-Routen, die der Bestandsvergleich nur zufällig grün zeigte</b> (Befund
 *       18.09.2026, PR 961): jede trifft über {@link #PROBEN} ein echtes Objekt, und ein Bearbeiter an einem ANDEREN
 *       Standort bekommt dort die Antwort einer unbekannten Kennung. Was daran scheitert, stünde benannt in
 *       {@link #ZAUN_OFFEN} — die Liste ist leer.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Import(ZugriffZaunApiTest.SitzungsRoute.class)
class ZugriffZaunApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final UUID DEMO = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID NORDWIND = UUID.fromString("10000000-0000-0000-0000-000000000001");
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String KUNDENBEREICH = ZugriffKontextLader.KUNDENBEREICH_HEADER;
    private static final String TENANT = "X-Tenant-Id";
    static final String SITZUNG = "/api/v1/test-sitzung";
    private static final String AUSNAHME = "Ausnahme im Handler: ";

    private static final String PARTNER_GEWAEHRT = "sub-zaun-partner-gewaehrt";
    private static final String PARTNER_BEENDET = "sub-zaun-partner-beendet";
    private static final String KUNDE_KA = "sub-zaun-kundenadministrator";
    private static final String KUNDE_LESER = "sub-zaun-leser";
    private static final String KUNDE_OHNE = "sub-zaun-ohne-zuweisung";
    private static final String KUNDE_NIE = "sub-zaun-nie-zugewiesen";
    /** Zwei Bearbeiter, die sich NUR im Standort unterscheiden — das Paar jeder Zaun-Aussage. */
    private static final String KUNDE_BEARBEITER = "sub-zaun-bearbeiter-hier";
    private static final String KUNDE_BEARBEITER_FREMD = "sub-zaun-bearbeiter-anderswo";
    private static final String PARTNER_NORDWIND = "sub-zaun-partner-nordwind";
    private static final String KANAL = "deye.hybrid_1p.meter.generator-energy";
    /** Ein Zustands-Kanal: nur ihn bietet die Kanalbindung einer Bezugsgröße in Stunden an. */
    private static final String KANAL_ZUSTAND = "deye.hybrid_1p.battery.battery-state";
    private static final String VON = "2026-09-01T00:00:00Z";
    private static final String BIS = "2026-09-01T01:00:00Z";
    private static final String KORREKTUR = "K-2026-9001";
    private static final String BEZUGSGROESSE = "BZ-Z1";

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

    /** Liest die drei Sitzungs-Einstellungen der Verbindung, die die Anfrage bekommt. */
    @RestController
    static class SitzungsRoute {
        private final JdbcTemplate jdbc;

        SitzungsRoute(JdbcTemplate jdbc) {
            this.jdbc = jdbc;
        }

        @GetMapping(SITZUNG)
        Map<String, Object> sitzung() {
            return jdbc.queryForMap("SELECT coalesce(current_setting('app.tenant_id', true), '') AS tenant, "
                    + "coalesce(current_setting('app.zugriff', true), '') AS zugriff, "
                    + "coalesce(current_setting('app.standort_ids', true), '') AS standort_ids");
        }
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    RequestMappingHandlerMapping mapping;

    @SpyBean
    ZugriffKontextLader lader;

    /** {@code true} = „vorher": der Lader lädt nichts, der Filter reicht durch. */
    private static final AtomicBoolean VORHER = new AtomicBoolean();

    private static JdbcTemplate root;
    private static UUID demoStandort;
    /** Der zweite Standort desselben Kundenbereichs: an ihm hängt KEIN Objekt dieser Klasse. */
    private static UUID andererStandort;
    /** Je Muster ein aufrufbarer Pfad auf ein Objekt, das es im Bestand dieser Bühne WIRKLICH gibt. */
    private static final Map<String, String> PROBEN = new TreeMap<>();
    /** Je Muster ohne Standortbezug ein Pfad auf dasselbe Objekt in einem ANDEREN Kundenbereich (Nordwind). */
    private static final Map<String, String> FREMDER_KUNDENBEREICH = new TreeMap<>();
    private static UUID bezugsgroesse;
    private static String importKennung;

    private record Route(HttpMethod methode, String muster, String pfad) {
        @Override
        public String toString() {
            return methode + " " + muster;
        }
    }

    private record Konto(String name, Authentication auth, String[] koepfe) {}

    private record Antwort(int status, String body) {}

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void ladeWieVorherOderNachher() throws Exception {
        VORHER.set(false);
        doAnswer(inv -> VORHER.get() ? ZugriffKontextLader.Ergebnis.keiner() : inv.callRealMethod())
                .when(lader).laden(any(), any());
        if (demoStandort == null) {
            seed();
        }
        if (importKennung == null) {
            importAnlegen();
        }
    }

    @Test
    void einPartnerOhneWirksameUnterstuetzungBekommtAufJederKundenroute404() throws Exception {
        List<Route> routen = kundenrouten(false);
        Authentication ohne = konto("sub-zaun-partner-ohne", null, "partner");
        Authentication beendet = konto(PARTNER_BEENDET, null, "partner");
        Authentication gewaehrt = konto(PARTNER_GEWAEHRT, null, "partner");
        Authentication plattform = konto("sub-zaun-plattform", null, "platform-admin");
        List<Konto> varianten = List.of(
                new Konto("Partner ohne Kopf", ohne, new String[0]),
                new Konto("Partner, X-Kundenbereich ohne Unterstützung", ohne,
                        new String[] {KUNDENBEREICH, DEMO.toString()}),
                new Konto("Partner, X-Kundenbereich unbekannt", ohne,
                        new String[] {KUNDENBEREICH, UUID.randomUUID().toString()}),
                new Konto("Partner, X-Kundenbereich keine Kennung", ohne, new String[] {KUNDENBEREICH, "demo"}),
                new Konto("Partner, X-Tenant-Id", ohne, new String[] {TENANT, DEMO.toString()}),
                new Konto("Partner, Unterstützung beendet", beendet, new String[] {KUNDENBEREICH, DEMO.toString()}),
                new Konto("Partner, Unterstützung nur in einem anderen Kundenbereich", gewaehrt,
                        new String[] {KUNDENBEREICH, NORDWIND.toString()}),
                new Konto("Plattform, X-Kundenbereich ohne Unterstützung neben X-Tenant-Id", plattform,
                        new String[] {KUNDENBEREICH, DEMO.toString(), TENANT, DEMO.toString()}));

        Map<String, List<String>> nicht404 = new TreeMap<>();
        for (Route r : routen) {
            for (Konto v : varianten) {
                int status = ruf(r, v).status();
                if (status != 404) {
                    nicht404.computeIfAbsent(v.name(), x -> new ArrayList<>()).add(r + " → " + status);
                }
            }
        }
        System.out.printf("Zaun: %d Kundenrouten × %d Varianten, außerhalb /api/v1: %s%n", routen.size(),
                varianten.size(), ausserhalb());
        assertThat(routen).hasSizeGreaterThan(300);
        assertThat(nicht404).isEmpty();
    }

    @Test
    void mitWirksamerUnterstuetzungGiltDerKundenbereichUndJedeAnfrageSiehtIhreEinstellungen() throws Exception {
        Konto partner = new Konto("Partner mit Unterstützung", konto(PARTNER_GEWAEHRT, null, "partner"),
                new String[] {KUNDENBEREICH, DEMO.toString()});
        Konto umschalter = new Konto("Plattform am Umschalter", konto("sub-zaun-plattform", null, "platform-admin"),
                new String[] {TENANT, DEMO.toString()});
        Konto plattformOhne = new Konto("Plattform ohne Kopf", konto("sub-zaun-plattform", null, "platform-admin"),
                new String[0]);
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Konto leser = new Konto("Leser", konto(KUNDE_LESER, DEMO), new String[0]);
        Konto ohne = new Konto("Kundenkonto ohne wirksame Zuweisung", konto(KUNDE_OHNE, DEMO), new String[0]);
        Konto nie = new Konto("Kundenkonto, nie zugewiesen (Bestandsregel E12)", konto(KUNDE_NIE, DEMO), new String[0]);
        String ids = "{" + demoStandort + "}";

        assertThat(ruf(get("/api/v1/sites"), partner).status()).isEqualTo(200);
        for (int runde = 0; runde < 2; runde++) {
            assertThat(sitzung(partner)).isEqualTo(List.of(DEMO.toString(), "standorte", ids));
            assertThat(sitzung(ka)).isEqualTo(List.of(DEMO.toString(), "unternehmen", "{}"));
            assertThat(sitzung(partner)).isEqualTo(List.of(DEMO.toString(), "standorte", ids));
            assertThat(sitzung(leser)).isEqualTo(List.of(DEMO.toString(), "standorte", ids));
            assertThat(sitzung(umschalter)).isEqualTo(List.of(DEMO.toString(), "unternehmen", "{}"));
            // AP-03 IP-9: ein Konto, dessen einzige Zuweisung vorbei ist, kommt gar nicht mehr bis zur Route —
            // der Entzug wirkt mit der nächsten Anfrage, und sie sagt auch, warum (A6).
            assertThat(beendet(ohne)).isEqualTo("zugriff_beendet");
            assertThat(sitzung(nie)).isEqualTo(List.of(DEMO.toString(), "unternehmen", "{}"));
            assertThat(sitzung(plattformOhne)).isEqualTo(List.of("", "", ""));
        }
        Konto partnerFremd = new Konto("Partner, Kopf auf Nordwind", partner.auth(),
                new String[] {KUNDENBEREICH, NORDWIND.toString()});
        assertThat(ruf(get(SITZUNG), partnerFremd).status()).isEqualTo(404);
        assertThat(sitzung(partner)).as("danach wieder die eigene").isEqualTo(List.of(DEMO.toString(), "standorte", ids));
    }

    /**
     * Lesende Kundenrouten, die es <b>vor IP-4 noch gar nicht gab</b> und die den Zugriffs-Kontext voraussetzen.
     *
     * <p>Fuer sie sagt der Bestandsvergleich nichts: „vorher" ist keine aeltere Fassung, sondern derselbe heutige
     * Handler mit abgeschaltetem {@link ZugriffKontextLader} — ohne Kontext lehnt er ab. Eine historische Antwort
     * existiert nicht, weil es vor IP-4 die Route nicht gab. Ihr Vertrag steht darum in einer EIGENEN Klasse, die
     * hier als Klassenobjekt genannt ist: verschwindet sie, bricht schon die Kompilierung.
     *
     * <p>Die Routen bleiben im gemeinsamen Sammler {@link #kundenrouten(boolean)} — Partner-Zaun (404) und
     * Standort-Zaun pruefen sie weiter; nur DIESER eine Vergleich nimmt sie aus.
     *
     * @param muster       das Routenmuster, wie das {@link RequestMappingHandlerMapping} es nennt
     * @param probe        ein aufrufbarer Pfad dieser Route (mit Pflichtparametern) fuer den Waechter
     * @param vertragstest die Klasse, die den eigenen Vertrag dieser Route prueft
     */
    private record NachIp4(String muster, String probe, Class<?> vertragstest) {}

    /** AP-03 IP-13 (Einfuehrung 83e3820e): Benutzerliste und Protokoll der Benutzerverwaltung. */
    private static final List<NachIp4> NACH_IP4 = List.of(
            new NachIp4("/api/v1/benutzer", "/api/v1/benutzer", BenutzerVerwaltungApiTest.class),
            new NachIp4("/api/v1/benutzer/protokoll",
                    "/api/v1/benutzer/protokoll?von=2024-01-01T00:00:00Z&bis=2024-12-31T00:00:00Z",
                    BenutzerVerwaltungApiTest.class));

    private static final Set<String> AUSGENOMMEN =
            NACH_IP4.stream().map(NachIp4::muster).collect(Collectors.toCollection(TreeSet::new));

    /**
     * Bestand (AP-03 IP-4 und IP-5): „vorher" lädt der Lader nichts, also bleiben alle Sitzungs-Einstellungen leer —
     * das ist der Stand vor IP-4 und zugleich der Stand, in dem {@code site_scope} nichts filtert. Jedes HEUTIGE Konto
     * sieht nachher auf jeder lesenden Kundenroute Zeichen für Zeichen dasselbe: der Kundenadministrator (nach der
     * Bestandsübernahme E12 jedes Kundenkonto), ein Kundenkonto, das noch nie eine Zuweisung hatte (dieselbe Regel in
     * der Anfrage, auch wenn der Start-Lauf aus ist), und die Plattform mit und ohne Umschalter. Die Anlage des Demo-Standorts
     * hängt an einem Standort, die übrigen nicht — der Zaun hätte also etwas zu filtern.
     * Standortbeschränkte Konten ändern sich mit IP-5 absichtlich: {@link #standortbeschraenkteKontenSehenNurDieAnlagenIhrerStandorte}.
     */
    /**
     * Bestandsschutz je lesender Kundenroute: mit Zugriff-Kontext antwortet jede genauso wie ohne ihn (IP-4/IP-5).
     *
     * <p><b>Die EINE gewollte Ausnahme seit AP-03 IP-7 (E13):</b> {@code GET …/ocpp/action-permissions} nennt die
     * OCPP-Stufe, und die kommt jetzt aus der ZUWEISUNG statt aus der Realm-Rolle ({@code RechtPruefung#ocppStufe}).
     * Sie wird darum nicht als Abweichung gewertet, sondern in {@code stufenwechsel} auf den Namen der Stufe
     * festgenagelt — so faellt sowohl eine ZWEITE Route auf, die den Bestand verlaesst, als auch ein Zurueckdrehen
     * der Regel. Die beiden Plattform-Konten stehen bewusst nicht darin: am Umschalter gilt weiter die Realm-Rolle.
     *
     * <p><b>Und genau EIN Konto steigt:</b> das mit einer echten Zuweisung. Das Bestandskonto (E12) steht NICHT
     * darin — die Steuerungs-Achse folgt erst einer echten Zuweisung ({@code RechtPruefung#ocppStufe}), sonst
     * haette das Ausrollen von IP-7 jedem bestehenden Kundenkonto still den Hardware-Befehlssatz gegeben.
     */
    @Test
    void jedesHeutigeKontoSiehtAufJederLesendenKundenrouteDasselbeWieVorIp4UndIp5() throws Exception {
        List<Route> routen = kundenrouten(true).stream()
                .filter(r -> !AUSGENOMMEN.contains(r.muster()))
                .toList();
        List<Konto> konten = List.of(
                new Konto("Kundenkonto (Bestandsübernahme: Kundenadministrator)", konto(KUNDE_KA, DEMO, "operator"),
                        new String[0]),
                new Konto("Kundenkonto ohne Realm-Rolle, nie zugewiesen (Bestandsregel E12)", konto(KUNDE_NIE, DEMO),
                        new String[0]),
                new Konto("Plattform mit X-Tenant-Id", konto("sub-zaun-plattform", null, "platform-admin"),
                        new String[] {TENANT, DEMO.toString()}),
                new Konto("Plattform ohne Kopf", konto("sub-zaun-plattform", null, "platform-admin"),
                        new String[0]));
        List<String> abweichungen = new ArrayList<>();
        List<String> stufenwechsel = new ArrayList<>();
        Set<String> fluechtig = new TreeSet<>();
        Set<String> mitAusnahme = new TreeSet<>();
        Set<String> ohneAussage = new TreeSet<>();
        int mitDaten = 0;
        for (Route r : routen) {
            boolean jedeAntwortAbgelehnt = true;
            for (Konto k : konten) {
                Antwort vorher1 = vorher(r, k);
                Antwort nachher = ruf(r, k);
                Antwort vorher2 = vorher(r, k);
                if (nachher.body().startsWith(AUSNAHME) || vorher2.body().startsWith(AUSNAHME)) {
                    mitAusnahme.add(r + " (" + nachher.body().substring(nachher.body().indexOf(':') + 2) + ")");
                }
                boolean gleich = false;
                if (vorher1.status() != vorher2.status()) {
                    fluechtig.add(r.toString());
                } else if (nachher.status() != vorher2.status()) {
                    abweichungen.add(k.name() + ": " + r + " vorher " + vorher2.status() + ", nachher " + nachher.status());
                } else if (!vorher1.body().equals(vorher2.body())) {
                    fluechtig.add(r.toString());
                } else if (!nachher.body().equals(vorher2.body())) {
                    if (OCPP_STUFE.equals(r.muster())) {
                        stufenwechsel.add(k.name() + ": " + stufe(vorher2.body()) + " → " + stufe(nachher.body()));
                    } else {
                        abweichungen.add(k.name() + ": " + r + " Körper weicht ab");
                    }
                } else {
                    gleich = true;
                }
                if (gleich && nachher.status() == 200 && nachher.body().length() > 2) {
                    mitDaten++;
                }
                if (nachher.status() < 400) {
                    jedeAntwortAbgelehnt = false;
                }
            }
            if (jedeAntwortAbgelehnt) {
                ohneAussage.add(r.toString());
            }
        }
        System.out.printf("Bestand: %d lesende Kundenrouten × %d Konten, %d Antworten mit Daten gleich, flüchtig: %s, "
                + "Ausnahme im Handler (beide Seiten): %s, OCPP-Stufenwechsel (E13): %s%n", routen.size(),
                konten.size(), mitDaten, fluechtig, mitAusnahme, stufenwechsel);
        // Routen, die JEDES Konto auf beiden Seiten ablehnt (Pflichtparameter fehlt, Platzhalter passt nicht,
        // Recht fehlt): ihr Vergleich ist gleich, sagt aber nichts über den Bestand. Nur ein Protokoll.
        System.out.printf("Bestandsvergleich ohne Aussage (beide Seiten ≥ 400 für jedes Konto): %s%n"
                + "Vom Vor-IP4-Vergleich ausgenommen (eigener Vertrag): %s%n", ohneAussage, AUSGENOMMEN);
        // Die 18 aus dem Befund vom 18.09.2026 treffen seitdem ein echtes Objekt (PROBEN) und stehen hier nie wieder;
        // ihre Zaun-Aussage macht jedeNachIp4NurZufaelligGrueneRouteTrifftEinEchtesObjektUndMachtEineZaunAussage.
        assertThat(ohneAussage).as("Befund 18.09.2026: diese Routen brauchen ihre Probe")
                .doesNotContainAnyElementsOf(NACH_IP4_NUR_ZUFAELLIG_GRUEN.stream().map(m -> "GET " + m).toList());
        assertThat(ruf(get("/api/v1/sites"), konten.get(0)).body()).contains(BERLIN_SITE);
        assertThat(routen).hasSizeGreaterThan(150);
        assertThat(mitDaten).isGreaterThan(100);
        assertThat(abweichungen).isEmpty();
        // Genau EINER — und MIT Stufe, nicht nur „weicht ab": das Konto mit einer echten Zuweisung
        // (Kundenadministrator, E13). Das Bestandskonto fehlt hier bewusst: ohne echte Zuweisung keine Stufe, sonst
        // bekaeme jedes bestehende Kundenkonto den Hardware-Befehlssatz, ohne dass jemand es ihm gegeben hat.
        assertThat(stufenwechsel).containsExactly(
                "Kundenkonto (Bestandsübernahme: Kundenadministrator): CUSTOMER → SITE_ADMIN");
    }

    /**
     * Der Waechter ueber der Grenze des Bestandsvergleichs: <b>keine lesende Kundenroute kommt still an ihm vorbei.</b>
     *
     * <p>Jedes GET-Muster unter {@code /api/v1/} steht entweder im Bestandsvergleich, oder — mit Beleg — in
     * {@link #NACH_IP4}, oder es ist eine der beiden hier namentlich genannten Nicht-Kundenrouten. Gemessen wird
     * gegen das rohe {@link RequestMappingHandlerMapping}, nicht gegen {@link #kundenrouten(boolean)}: so faellt
     * auch ein spaeter dort eingebauter stiller Uebersprung auf.
     *
     * <p>Und jede Ausnahme muss ihre Ausnahme verdienen. Sie muss es heute geben, ihr Vertragstest muss die Route
     * wirklich aufrufen, und sie muss ohne Kontext eine ANDERE Antwort geben als mit — sonst ist „vorher 403" keine
     * Emulation, sondern eine echte Aussage, und die Route gehoert zurueck in den Vergleich.
     */
    @Test
    void keineLesendeKundenrouteKommtAmVorIp4VergleichVorbeiUndJedeAusnahmeIstBelegt() throws Exception {
        Set<String> alleGet = new TreeSet<>();
        mapping.getHandlerMethods().forEach((info, handler) -> {
            Set<RequestMethod> methoden = info.getMethodsCondition().getMethods();
            if (!methoden.isEmpty() && !methoden.contains(RequestMethod.GET)) {
                return;
            }
            info.getPatternValues().stream()
                    .filter(m -> m.startsWith("/api/v1/") && !m.startsWith("/api/v1/admin/"))
                    .forEach(alleGet::add);
        });
        Set<String> verglichen = kundenrouten(true).stream().map(Route::muster)
                .filter(m -> !AUSGENOMMEN.contains(m)).collect(Collectors.toCollection(TreeSet::new));
        Set<String> abgedeckt = new TreeSet<>(verglichen);
        abgedeckt.addAll(AUSGENOMMEN);
        abgedeckt.add(ZugriffFilter.SELBSTAUSKUNFT); // eigener Zaun: SelbstauskunftApiTest
        abgedeckt.add(SITZUNG); // die Test-Route dieser Klasse selbst
        assertThat(abgedeckt).as("jede GET-Route entweder verglichen oder benannt ausgenommen")
                .containsExactlyInAnyOrderElementsOf(alleGet);
        assertThat(verglichen).doesNotContainAnyElementsOf(AUSGENOMMEN);
        assertThat(alleGet).as("keine verrottete Ausnahme").containsAll(AUSGENOMMEN);

        Konto ka = new Konto("Kundenkonto (Bestandsübernahme: Kundenadministrator)", konto(KUNDE_KA, DEMO, "operator"),
                new String[0]);
        for (NachIp4 a : NACH_IP4) {
            Route probe = new Route(HttpMethod.GET, a.muster(), a.probe());
            Antwort ohneKontext = vorher(probe, ka);
            Antwort mitKontext = ruf(probe, ka);
            assertThat(mitKontext.status()).as(a.muster() + " mit Kontext").isEqualTo(200);
            assertThat(ohneKontext.status()).as(a.muster() + " ohne Kontext (Emulation, kein Bestand)").isEqualTo(403);
            assertThat(quelle(a.vertragstest())).as(a.vertragstest().getSimpleName() + " ruft " + a.muster())
                    .contains(a.probe());
        }
    }

    /** Der Quelltext einer Testklasse, ueber das Modulverzeichnis aus ihrem {@code target/test-classes}. */
    private static String quelle(Class<?> klasse) throws Exception {
        Path modul = Path.of(ZugriffZaunApiTest.class.getProtectionDomain().getCodeSource().getLocation().toURI())
                .getParent().getParent();
        Path datei = modul.resolve("src/test/java").resolve(klasse.getName().replace('.', '/') + ".java");
        assertThat(datei).as("Quelle des Vertragstests").exists();
        return Files.readString(datei, StandardCharsets.UTF_8);
    }

    /** Das Muster der einen Route, die seit IP-7 die Stufe aus der Zuweisung nennt (E13). */
    private static final String OCPP_STUFE = "/api/v1/sites/{siteId}/ocpp/action-permissions";

    /** Die Stufe, wie die Antwort sie zeigt — an je EINER Aktion der drei Stufen (Profil-Aktionen sind immer aus). */
    private static String stufe(String koerper) throws Exception {
        JsonNode a = MAPPER.readTree(koerper).path("actions");
        if (a.path("HardReset").asBoolean()) {
            return "PLATFORM";
        }
        if (a.path("SoftReset").asBoolean()) {
            return "SITE_ADMIN";
        }
        return a.path("RemoteStartTransaction").asBoolean() ? "CUSTOMER" : "KEINE";
    }

    /**
     * Der Standort-Zaun über die Routen (AP-03 IP-5): ein Leser am Demo-Standort und ein Partner mit Unterstützung dort
     * sehen nur die Anlage dieses Standorts; jede andere ist 404 — in der Liste, als Anlage und hinter
     * {@code Geltungsbereich.requireSite}. Ein Kundenkonto, dessen Zuweisung beendet ist, sieht keine Anlage (Entzug).
     * Der Kundenadministrator sieht alle — und ebenso ein Konto, das nie eine Zuweisung hatte (Bestandsregel E12).
     */
    @Test
    void standortbeschraenkteKontenSehenNurDieAnlagenIhrerStandorte() throws Exception {
        String andere = root.queryForObject("SELECT id::text FROM site WHERE tenant_id = ? AND id <> ?::uuid "
                + "ORDER BY name LIMIT 1", String.class, DEMO, BERLIN_SITE);
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Konto leser = new Konto("Leser am Demo-Standort", konto(KUNDE_LESER, DEMO), new String[0]);
        Konto partner = new Konto("Partner mit Unterstützung am Demo-Standort", konto(PARTNER_GEWAEHRT, null, "partner"),
                new String[] {KUNDENBEREICH, DEMO.toString()});
        Konto ohne = new Konto("Kundenkonto mit beendeter Zuweisung", konto(KUNDE_OHNE, DEMO), new String[0]);
        Konto nie = new Konto("Kundenkonto, nie zugewiesen", konto(KUNDE_NIE, DEMO), new String[0]);

        assertThat(anlagen(ka)).contains(BERLIN_SITE, andere).hasSizeGreaterThan(2);
        assertThat(anlagen(nie)).as("Bestandsregel E12 in der Anfrage").isEqualTo(anlagen(ka));
        for (Konto k : List.of(leser, partner)) {
            assertThat(anlagen(k)).as(k.name()).containsExactly(BERLIN_SITE);
            assertThat(ruf(get("/api/v1/sites/" + BERLIN_SITE), k).status()).as(k.name()).isEqualTo(200);
            assertThat(ruf(get("/api/v1/sites/" + andere), k).status()).as(k.name()).isEqualTo(404);
            assertThat(ruf(get("/api/v1/sites/" + BERLIN_SITE + "/sources"), k).status()).as(k.name()).isEqualTo(200);
            assertThat(ruf(get("/api/v1/sites/" + andere + "/sources"), k).status()).as(k.name()).isEqualTo(404);
        }
        assertThat(ruf(get("/api/v1/sites/" + andere + "/sources"), ka).status()).isEqualTo(200);
        int geraeteBerlin = root.queryForObject("SELECT count(*) FROM device WHERE site_id = ?::uuid", Integer.class,
                BERLIN_SITE);
        int geraeteDemo = root.queryForObject("SELECT count(*) FROM device WHERE tenant_id = ?", Integer.class, DEMO);
        assertThat(geraeteDemo).isGreaterThan(geraeteBerlin);
        assertThat(anzahl(get("/api/v1/devices"), ka)).isEqualTo(geraeteDemo);
        assertThat(anzahl(get("/api/v1/devices"), leser)).isEqualTo(geraeteBerlin);
        String fremdesGeraet = root.queryForObject("SELECT id::text FROM device WHERE tenant_id = ? AND site_id <> ?::uuid "
                + "ORDER BY id LIMIT 1", String.class, DEMO, BERLIN_SITE);
        assertThat(ruf(MockMvcRequestBuilders.delete(URI.create("/api/v1/devices/" + fremdesGeraet)), leser).status())
                .as("ein Gerät einer fremden Anlage ist 404, auch zum Löschen").isEqualTo(404);
        // AP-03 IP-9: der Entzug beantwortet jede Kundenroute selbst — 404 mit `zugriff_beendet` und dem Satz
        // aus §4.7, nicht eine leere Liste, die für den Kunden wie „Sie haben keine Anlagen" aussähe (A6).
        for (String route : List.of("/api/v1/sites", "/api/v1/sites/" + BERLIN_SITE)) {
            Antwort a = ruf(get(route), ohne);
            assertThat(a.status()).as(route).isEqualTo(404);
            JsonNode n = MAPPER.readTree(a.body());
            assertThat(n.path("code").asText()).as(route).isEqualTo("zugriff_beendet");
            assertThat(n.path("message").asText()).as(route).startsWith("Ihr Zugriff auf ").endsWith("wurde beendet.");
        }
    }

    /**
     * Die 18 lesenden Routen aus dem Befund vom 18.09.2026 (PR 961, „Weitere nach IP-4 eingeführte GET-Routen“): ihr
     * Bestandsvergleich war gleich, weil der Zaun sie für JEDES Konto auf beiden Seiten ablehnte (Platzhalter passte
     * nicht, Pflichtparameter fehlte, Recht fehlte allen). Hier trifft jede ein Objekt, das es wirklich gibt.
     */
    private static final Set<String> NACH_IP4_NUR_ZUFAELLIG_GRUEN = new TreeSet<>(List.of(
            "/api/v1/bezugsdaten/importe/{kennung}",
            "/api/v1/bezugsdaten/importe/{kennung}/ruecknahme/vorschau",
            "/api/v1/bezugsgroessen/{id}/kanalbindung",
            "/api/v1/bezugsgroessen/{id}/kanalbindung/kanaele",
            "/api/v1/geraete/{id}/austausch/vorschau",
            "/api/v1/geraete/{id}/wago",
            "/api/v1/korrekturen/{kennung}",
            "/api/v1/messstellen/{kennzeichen}/ablesungen",
            "/api/v1/messstellen/{kennzeichen}/ersatzwerte/luecken",
            "/api/v1/sites/{siteId}/components/{entityId}/wago",
            "/api/v1/sites/{siteId}/komponenten/{entityId}/summenwerte",
            "/api/v1/standorte/{standortId}/ausfall",
            "/api/v1/standorte/{standortId}/korrekturen",
            "/api/v1/standorte/{standortId}/netzanschluesse/vorschlaege",
            "/api/v1/standorte/{standortId}/orte/kurzzeichen-vorschlag",
            "/api/v1/standorte/{standortId}/versorgung",
            "/api/v1/unterstuetzung/{id}",
            "/api/v1/zugriff"));

    /** Zugabe über die 18 hinaus (vor IP-4 eingeführt): die Bezugsgröße selbst, mit demselben Konto-Paar gemessen. */
    private static final String BEZUGSGROESSE_SELBST = "/api/v1/bezugsgroessen/{id}";

    /**
     * Die Muster, die am Zaun scheitern dürfen — LEER, und so bleibt die Zusicherung stehen: ein Muster, das den Zaun
     * verfehlt, ist ein neues Loch und macht den Test rot. Bis zum 21.09.2026 standen hier die drei Lesewege der
     * Bezugsgröße ({@code /{id}}, {@code …/kanalbindung}, {@code …/kanalbindung/kanaele}): {@code bezugsgroesse} trägt
     * nur die Mandanten-Policy, und ein Bearbeiter NUR an einem anderen Standort las eine Bezugsgröße mit Geltung am
     * fremden Standort bzw. erfuhr, dass es sie gibt. Seit {@code vp-uems-zaun-bezugsgroesse-lesen} lesen alle Routen
     * sie über ihre Geltung ({@code RechtPruefung#pruefenLesen}, AP-03 R-A1); je Geltungsart belegt das
     * {@code BezugsgroesseApiTest#jedeLeserouteZeigtDieBezugsgroesseNurImGeltungsbereich}.
     */
    private static final Map<String, String> ZAUN_OFFEN = Map.of();

    /**
     * Ein Zaun-Fall. {@code sieht} bekommt das Objekt ({@code < 400}, der Körper nennt {@code beleg}). {@code blind}
     * bekommt am Objekt genau die Antwort, die es für ein Objekt bekommt, das es NICHT gibt ({@code unbekannt}):
     * Status und Körper gleich, und abgelehnt — so verrät weder ein 403 noch ein anderer 404-Satz die Existenz.
     * {@code recht} ist {@code null} für den Standort-Zaun; sonst lehnt das Recht ab, bevor ein Zaun fragt, und
     * {@code fremd} ist derselbe Weg in einem anderen Kundenbereich (Mandanten-Zaun: gleich {@code unbekannt}).
     */
    private record Fall(String muster, Konto sieht, String beleg, Konto blind, String unbekannt, String recht,
            String fremd, String aussage) {}

    /**
     * Jede der 18 Routen macht eine ZAUN-Aussage, nicht nur eine Erreichbarkeits-Aussage: ein Bearbeiter am Standort
     * des Objekts sieht es, derselbe Bearbeiter an einem ANDEREN Standort des Kundenbereichs bekommt genau die Antwort
     * einer Kennung, die es nicht gibt. Die zwei Routen ohne Standortbezug (Zuweisungen, Unterstützung) verlangen ein
     * Unternehmensrecht: der Bearbeiter bekommt 403 {@code recht_fehlt}, und für den Kundenadministrator ist dasselbe
     * Objekt eines anderen Kundenbereichs gleich einer unbekannten Kennung.
     */
    @Test
    void jedeNachIp4NurZufaelligGrueneRouteTrifftEinEchtesObjektUndMachtEineZaunAussage() throws Exception {
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Konto hier = new Konto("Bearbeiter am Standort des Objekts", konto(KUNDE_BEARBEITER, DEMO), new String[0]);
        Konto anderswo = new Konto("Bearbeiter nur an einem anderen Standort", konto(KUNDE_BEARBEITER_FREMD, DEMO),
                new String[0]);
        String nie = "00000000-0000-0000-0000-00000000dead";
        String standortNie = "/api/v1/standorte/" + nie;
        List<Fall> faelle = List.of(
                new Fall("/api/v1/bezugsdaten/importe/{kennung}", hier, importKennung, anderswo,
                        "/api/v1/bezugsdaten/importe/I-2026-9999", null, null,
                        "Standort-Zaun über die Geltung der Ziel-Bezugsgröße (RechtPruefung BEZUGSGROESSE)"),
                new Fall("/api/v1/bezugsdaten/importe/{kennung}/ruecknahme/vorschau", hier, importKennung, anderswo,
                        "/api/v1/bezugsdaten/importe/I-2026-9999/ruecknahme/vorschau", null, null,
                        "Standort-Zaun über die Geltung der Bezugsgrößen, die der Import beschrieben hat"),
                new Fall("/api/v1/bezugsgroessen/{id}/kanalbindung", hier, KANAL_ZUSTAND, anderswo,
                        "/api/v1/bezugsgroessen/" + nie + "/kanalbindung", null, null,
                        "Standort-Zaun an der Bezugsgröße (Geltung Standort)"),
                new Fall(BEZUGSGROESSE_SELBST, hier, BEZUGSGROESSE, anderswo, "/api/v1/bezugsgroessen/" + nie, null,
                        null, "Zugabe: Standort-Zaun an der Bezugsgröße selbst (Geltung Standort)"),
                new Fall("/api/v1/bezugsgroessen/{id}/kanalbindung/kanaele", hier, KANAL_ZUSTAND, anderswo,
                        "/api/v1/bezugsgroessen/" + nie + "/kanalbindung/kanaele", null, null,
                        "Standort-Zaun an der Bezugsgröße und an der Anlage jedes Messkanals"),
                new Fall("/api/v1/geraete/{id}/austausch/vorschau", hier, "karten", anderswo,
                        "/api/v1/geraete/" + nie + "/austausch/vorschau", null, null,
                        "Standort-Zaun am Gerät (site_scope auf geraet)"),
                new Fall("/api/v1/geraete/{id}/wago", hier, null, anderswo, "/api/v1/geraete/" + nie + "/wago", null,
                        null, "Standort-Zaun am Gerät (site_scope auf geraet und site)"),
                new Fall("/api/v1/korrekturen/{kennung}", hier, KORREKTUR, anderswo, "/api/v1/korrekturen/K-2026-9999",
                        null, null, "Standort-Zaun über den Standort jeder korrigierten Reihe"),
                new Fall("/api/v1/messstellen/{kennzeichen}/ablesungen", hier, null, anderswo,
                        "/api/v1/messstellen/MS-Z9/ablesungen", null, null,
                        "Standort-Zaun über den Ort der Messstelle (RechtPruefung MESSSTELLE, messwerte.ansehen)"),
                new Fall("/api/v1/messstellen/{kennzeichen}/ersatzwerte/luecken", hier, null, anderswo,
                        "/api/v1/messstellen/MS-Z9/ersatzwerte/luecken?quelle_id=" + nie + "&von=" + VON + "&bis=" + BIS,
                        null, null, "Standort-Zaun über Gerät, Komponente und Anlage der Quelle"),
                new Fall("/api/v1/sites/{siteId}/components/{entityId}/wago", hier, null, anderswo,
                        "/api/v1/sites/" + BERLIN_SITE + "/components/" + nie + "/wago", null, null,
                        "Standort-Zaun an Komponente und Anlage (site_scope)"),
                new Fall("/api/v1/sites/{siteId}/komponenten/{entityId}/summenwerte", hier, null, anderswo,
                        "/api/v1/sites/" + nie + "/komponenten/" + nie + "/summenwerte", null, null,
                        "Standort-Zaun an der Anlage (Geltungsbereich.requireSite)"),
                new Fall("/api/v1/standorte/{standortId}/ausfall", hier, "boxen", anderswo, standortNie + "/ausfall",
                        null, null, "Standort-Zaun am Standort (site_scope auf standort)"),
                new Fall("/api/v1/standorte/{standortId}/korrekturen", hier, KORREKTUR, anderswo,
                        standortNie + "/korrekturen", null, null,
                        "Standort-Zaun am Standort (Geltungsbereich.requireStandort)"),
                new Fall("/api/v1/standorte/{standortId}/netzanschluesse/vorschlaege", ka, null, anderswo,
                        standortNie + "/netzanschluesse/vorschlaege", null, null,
                        "Standort-Zaun am Standort VOR dem Recht netzanschluss.verwalten (nur U-Rollen)"),
                new Fall("/api/v1/standorte/{standortId}/orte/kurzzeichen-vorschlag", hier, "G-", anderswo,
                        standortNie + "/orte/kurzzeichen-vorschlag?art=gebaeude", null, null,
                        "Standort-Zaun am Standort (site_scope auf standort)"),
                new Fall("/api/v1/standorte/{standortId}/versorgung", hier, demoStandort.toString(), anderswo,
                        standortNie + "/versorgung", null, null, "Standort-Zaun am Standort (site_scope auf standort)"),
                new Fall("/api/v1/unterstuetzung/{id}", ka, PARTNER_GEWAEHRT, hier, "/api/v1/unterstuetzung/" + nie,
                        "unterstuetzung.verwalten", FREMDER_KUNDENBEREICH.get("/api/v1/unterstuetzung/{id}"),
                        "Recht unterstuetzung.verwalten (nur Kundenadministrator) und Mandanten-Zaun"),
                new Fall("/api/v1/zugriff", ka, demoStandort.toString(), hier,
                        "/api/v1/zugriff?benutzer=sub-zaun-gibt-es-nicht", "zuweisung.verwalten",
                        FREMDER_KUNDENBEREICH.get("/api/v1/zugriff"),
                        "Recht zuweisung.verwalten (nur Kundenadministrator) und Mandanten-Zaun"));
        Set<String> gemessen = new TreeSet<>(NACH_IP4_NUR_ZUFAELLIG_GRUEN);
        gemessen.add(BEZUGSGROESSE_SELBST);
        assertThat(faelle.stream().map(Fall::muster)).as("die 18 Routen des Befunds und die Zugabe")
                .containsExactlyInAnyOrderElementsOf(gemessen);
        assertThat(PROBEN.keySet()).containsExactlyInAnyOrderElementsOf(gemessen);
        // Das fremde Konto ist nicht einfach ausgesperrt: seinen eigenen Standort sieht es.
        assertThat(ruf(get("/api/v1/standorte/" + andererStandort + "/versorgung"), anderswo).status()).isEqualTo(200);

        List<String> fehler = new ArrayList<>();
        Map<String, String> zaunVerfehlt = new TreeMap<>();
        for (Fall f : faelle) {
            String pfad = PROBEN.get(f.muster());
            Antwort sieht = ruf(get(pfad), f.sieht());
            if (sieht.status() >= 400 || (f.beleg() != null && !sieht.body().contains(f.beleg()))) {
                fehler.add(f.muster() + ": " + f.sieht().name() + " sieht es nicht — " + sieht.status() + " "
                        + kurz(sieht.body()));
            }
            Antwort blind = ruf(get(pfad), f.blind());
            if (f.recht() != null) {
                String recht = blind.status() == 403 ? MAPPER.readTree(blind.body()).path("recht").asText() : "";
                if (!f.recht().equals(recht)) {
                    fehler.add(f.muster() + ": " + f.blind().name() + " bekommt " + blind.status() + " statt 403 "
                            + f.recht() + " — " + kurz(blind.body()));
                }
                Antwort fremd = ruf(get(f.fremd()), f.sieht());
                Antwort unbekannt = ruf(get(f.unbekannt()), f.sieht());
                if (fremd.status() != unbekannt.status() || !fremd.body().equals(unbekannt.body())) {
                    fehler.add(f.muster() + ": anderer Kundenbereich " + fremd.status() + " " + kurz(fremd.body())
                            + " ≠ unbekannt " + unbekannt.status() + " " + kurz(unbekannt.body()));
                }
            } else {
                Antwort unbekannt = ruf(get(f.unbekannt()), f.blind());
                if (blind.status() < 400 || blind.status() != unbekannt.status()
                        || !blind.body().equals(unbekannt.body())) {
                    zaunVerfehlt.put(f.muster(), f.blind().name() + " bekommt " + blind.status() + " "
                            + kurz(blind.body()) + " — eine unbekannte Kennung " + unbekannt.status() + " "
                            + kurz(unbekannt.body()));
                }
            }
            System.out.printf("Zaun-Aussage %s: %s%s%n", f.muster(), f.aussage(),
                    ZAUN_OFFEN.containsKey(f.muster()) ? " — OFFEN: " + ZAUN_OFFEN.get(f.muster()) : "");
        }
        System.out.printf("Zaun OFFEN: %s%n", zaunVerfehlt);
        assertThat(fehler).isEmpty();
        assertThat(zaunVerfehlt.keySet()).as("genau die benannten offenen Fälle verfehlen den Zaun — ein weiterer ist "
                + "ein neues Loch, ein geheilter gehört aus ZAUN_OFFEN heraus: " + zaunVerfehlt)
                .containsExactlyInAnyOrderElementsOf(ZAUN_OFFEN.keySet());
    }

    private static String kurz(String body) {
        return body.length() > 160 ? body.substring(0, 160) + "…" : body;
    }

    private int anzahl(MockHttpServletRequestBuilder anfrage, Konto k) throws Exception {
        Antwort a = ruf(anfrage, k);
        assertThat(a.status()).as(k.name()).isEqualTo(200);
        return MAPPER.readTree(a.body()).get("eintraege").size();
    }

    private List<String> anlagen(Konto k) throws Exception {
        Antwort a = ruf(get("/api/v1/sites"), k);
        assertThat(a.status()).as(k.name()).isEqualTo(200);
        List<String> ids = new ArrayList<>();
        MAPPER.readTree(a.body()).get("eintraege").forEach(n -> ids.add(n.path("id").asText()));
        return ids;
    }

    // ------------------------------------------------------------------ Routen

    private List<Route> kundenrouten(boolean nurLesend) {
        List<Route> aus = new ArrayList<>();
        mapping.getHandlerMethods().forEach((info, handler) -> {
            Set<RequestMethod> methoden = info.getMethodsCondition().getMethods();
            for (String muster : info.getPatternValues()) {
                if (!muster.startsWith("/api/v1/") || muster.startsWith("/api/v1/admin/")
                        || muster.equals(ZugriffFilter.SELBSTAUSKUNFT) || muster.equals(SITZUNG)) {
                    continue;
                }
                for (RequestMethod m : methoden.isEmpty() ? Set.of(RequestMethod.GET) : methoden) {
                    if (!nurLesend || m == RequestMethod.GET) {
                        // Lesend zuerst die Probe auf ein echtes Objekt (siehe PROBEN), sonst der Platzhalter.
                        String pfad = m == RequestMethod.GET ? PROBEN.getOrDefault(muster, fuelle(muster))
                                : fuelle(muster);
                        aus.add(new Route(HttpMethod.valueOf(m.name()), muster, pfad));
                    }
                }
            }
        });
        aus.sort(Comparator.comparing(Route::muster).thenComparing(r -> r.methode().name()));
        return aus;
    }

    /** Die Muster außerhalb von {@code /api/v1/} — keine Kundenrouten; im Protokoll sichtbar, damit eine auffällt. */
    private Set<String> ausserhalb() {
        Set<String> aus = new TreeSet<>();
        for (RequestMappingInfo info : mapping.getHandlerMethods().keySet()) {
            info.getPatternValues().stream().filter(m -> !m.startsWith("/api/v1/")).forEach(aus::add);
        }
        return aus;
    }

    /** Setzt für jede Variable die Anlage des Demo-Seeds ein (auch in {@code {name:regex}}), {@code *} wird {@code x}. */
    private static String fuelle(String muster) {
        StringBuilder s = new StringBuilder();
        int tiefe = 0;
        for (char c : muster.toCharArray()) {
            if (c == '{') {
                if (tiefe++ == 0) {
                    s.append(BERLIN_SITE);
                }
            } else if (c == '}') {
                tiefe--;
            } else if (tiefe == 0) {
                s.append(c == '*' ? 'x' : c);
            }
        }
        return s.toString().replace("xx", "x");
    }

    // ------------------------------------------------------------------ Anfragen

    private Antwort vorher(Route r, Konto k) throws Exception {
        VORHER.set(true);
        try {
            return ruf(r, k);
        } finally {
            VORHER.set(false);
        }
    }

    private Antwort ruf(Route r, Konto k) throws Exception {
        return ruf(MockMvcRequestBuilders.request(r.methode(), URI.create(r.pfad())), k);
    }

    private Antwort ruf(MockHttpServletRequestBuilder anfrage, Konto k) throws Exception {
        anfrage.with(authentication(k.auth()));
        for (int i = 0; i < k.koepfe().length; i += 2) {
            anfrage.header(k.koepfe()[i], k.koepfe()[i + 1]);
        }
        try {
            MvcResult res = mvc.perform(anfrage).andReturn();
            return new Antwort(res.getResponse().getStatus(),
                    res.getResponse().getContentAsString(StandardCharsets.UTF_8));
        } catch (ServletException e) {
            // Scheitert ein Handler an den Platzhaltern, wäre das im Server ein 500 — so wird es auf beiden Seiten
            // verglichen (MockMvc wirft die Ausnahme sonst durch).
            Throwable ursache = e.getRootCause() != null ? e.getRootCause() : e;
            return new Antwort(500, AUSNAHME + ursache.getClass().getName());
        }
    }

    private static MockHttpServletRequestBuilder get(String pfad) {
        return MockMvcRequestBuilders.get(URI.create(pfad));
    }

    /** Der Fehlercode einer Kundenroute für ein Konto, das keinen wirksamen Zugriff mehr hat (IP-9). */
    private String beendet(Konto k) throws Exception {
        Antwort a = ruf(get(SITZUNG), k);
        assertThat(a.status()).as(k.name()).isEqualTo(404);
        return MAPPER.readTree(a.body()).path("code").asText();
    }

    private List<String> sitzung(Konto k) throws Exception {
        Antwort a = ruf(get(SITZUNG), k);
        assertThat(a.status()).as(k.name()).isEqualTo(200);
        JsonNode n = MAPPER.readTree(a.body());
        return List.of(n.path("tenant").asText(), n.path("zugriff").asText(), n.path("standort_ids").asText());
    }

    private static Authentication konto(String sub, UUID tenant, String... realmRollen) {
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

    // ------------------------------------------------------------------ Seed

    /**
     * Im Demo-Kundenbereich: ein Kundenadministrator (wie nach der Bestandsübernahme), ein Leser am ersten Standort, ein
     * Partner mit wirksamer und einer mit beendeter Unterstützung (Installateur) am selben Standort.
     */
    private static void seed() {
        demoStandort = root.queryForList("SELECT id FROM standort WHERE tenant_id = ? ORDER BY created_at, id",
                UUID.class, DEMO).stream().findFirst().orElseGet(ZugriffZaunApiTest::neuerDemoStandort);
        // Standort-Zaun (IP-5): die Berliner Anlage hängt am Demo-Standort, die übrigen Demo-Anlagen an keinem.
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?::uuid, ?, "
                + "'2024-01-01')", DEMO, BERLIN_SITE, demoStandort);
        spiegel(KUNDE_KA, "benutzer");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'kundenadministrator', ?, 'Europe/Berlin')", DEMO, KUNDE_KA, ab("2024-01-01"));
        spiegel(KUNDE_LESER, "benutzer");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'leser', ?, ?, 'Europe/Berlin')", DEMO, KUNDE_LESER, demoStandort, ab("2024-01-01"));
        spiegel(KUNDE_OHNE, "benutzer");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, gueltig_bis, endet_am, "
                + "zeitzone) VALUES (?, ?, 'leser', ?, ?, ?, ?, 'Europe/Berlin')", DEMO, KUNDE_OHNE, demoStandort,
                ab("2024-01-01"), LocalDate.parse("2024-12-31"), ab("2025-01-01"));
        spiegel(PARTNER_GEWAEHRT, "partner");
        unterstuetzung(PARTNER_GEWAEHRT, "2026-01-01", "2099-12-30");
        spiegel(PARTNER_BEENDET, "partner");
        unterstuetzung(PARTNER_BEENDET, "2026-01-01", "2026-02-01");

        // Das Paar jeder Zaun-Aussage: zwei Bearbeiter derselben Rolle, die sich NUR im Standort unterscheiden.
        // Am zweiten Standort hängt keines der Objekte, die diese Klasse anlegt — er ist der Gegenbeweis.
        andererStandort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, 'Zaun-Standort ohne Objekte', 'ST-91', 'Europe/Berlin', 'aktiv') "
                + "RETURNING id", UUID.class, DEMO, unternehmenDesDemoKundenbereichs());
        spiegel(KUNDE_BEARBEITER, "benutzer");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'bearbeiter', ?, ?, 'Europe/Berlin')", DEMO, KUNDE_BEARBEITER, demoStandort,
                ab("2024-01-01"));
        spiegel(KUNDE_BEARBEITER_FREMD, "benutzer");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'bearbeiter', ?, ?, 'Europe/Berlin')", DEMO, KUNDE_BEARBEITER_FREMD, andererStandort,
                ab("2024-01-01"));
        objekteDerNachIp4Routen();
    }

    /**
     * Die Objekte hinter den 18 Routen aus dem Befund vom 18.09.2026 (PR 961) — alle an der Berliner Anlage, also am
     * Demo-Standort, keines am anderen. Nicht aus dem Ahrenberg-Seed: er trägt Messstellen, Komponenten, Geräte und
     * Bezugsgrößen noch nicht („folgen“), und seine standortgebundenen Zuweisungen beginnen erst am 01.10.2026 — am
     * echten Heute sähe dort keine standortbeschränkte Person etwas. Den Import legt {@link #importAnlegen} über
     * seinen Schreibweg an.
     */
    private static void objekteDerNachIp4Routen() {
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?::uuid, "
                + "'VP-BOX-ZAUN-1', 'claimed') RETURNING id", UUID.class, DEMO, BERLIN_SITE);
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, communication, connection_json, created_at) VALUES (?, ?::uuid, 'grid-meter', 'Zaun-Zähler', "
                + "'grid-meter', ?, 'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}', '2024-03-12') RETURNING id",
                UUID.class, DEMO, BERLIN_SITE, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, enabled, "
                + "cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, retention_class, "
                + "long_term_strategy) VALUES (?, ?::uuid, ?, ?, ?, true, 60, 1, '2024-03-12', '2026.09.11.1', 'test', "
                + "'pending_edge', 'live_power', 'fifteen_minute'), (?, ?::uuid, ?, ?, ?, true, 60, 1, '2024-03-12', "
                + "'2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')", DEMO, BERLIN_SITE, box,
                komponente, KANAL, DEMO, BERLIN_SITE, box, komponente, KANAL_ZUSTAND);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-Z1', 'Zaun-Zähler', 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, DEMO);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2024-01-01')", DEMO, messstelle, demoStandort);
        UUID quelle = root.queryForObject("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, "
                + "entity_id, geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, "
                + "actor_sub, actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, ?, 'counter', "
                + "'zaehlerstand', 'fuehrend', '2024-03-12', true, now(), ?, 'Zaun', 'kunde') RETURNING id", UUID.class,
                DEMO, messstelle, komponente, geraet, KANAL, KUNDE_KA);
        UUID wago = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, hersteller, typ, eingebaut_am) VALUES (?, ?::uuid, uems_geraet_kennzeichen(?), 'WAGO-Zaun', "
                + "'controller', 'WAGO', 'Test', date_trunc('minute', now()) - interval '1 day') RETURNING id", UUID.class,
                DEMO, BERLIN_SITE, DEMO);
        UUID teil = root.queryForObject("INSERT INTO geraet_teil (tenant_id, geraet_id, steckplatz, typ, eingebaut_am) "
                + "VALUES (?, ?, 2, '750-494', date_trunc('minute', now()) - interval '1 day') RETURNING id", UUID.class,
                DEMO, wago);
        UUID wagoKomponente = root.queryForObject("WITH m AS (INSERT INTO measurement_point (tenant_id, site_id, role, "
                + "entity_type, brand, model) VALUES (?, ?::uuid, 'modbus-generic', 'modbus-generic', 'wago', '750-494') "
                + "RETURNING id) INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, teil_id, gueltig_ab) "
                + "SELECT ?, ?, m.id, ?, date_trunc('minute', now()) - interval '1 day' FROM m RETURNING entity_id",
                UUID.class, DEMO, BERLIN_SITE, DEMO, wago, teil);
        root.update("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, status, art, reihen, von, bis, "
                + "begruendung, vorschau, actor_sub, actor_name, actor_art) VALUES (?, ?, 1, 'vorschlag', "
                + "'umklassifizierung', ?::jsonb, ?::timestamptz, ?::timestamptz, 'Zaun-Probe: eine Viertelstunde "
                + "umklassifiziert', '[{\"version_alt\":1,\"version_neu\":2}]'::jsonb, ?, 'Zaun', 'kunde')", DEMO,
                KORREKTUR, "[{\"entity_id\":\"" + komponente + "\",\"messkanal\":\"" + KANAL + "\"}]", VON,
                "2026-09-01T00:15:00Z", KUNDE_KA);
        bezugsgroesse = root.queryForObject("INSERT INTO bezugsgroesse (tenant_id, kennzeichen, name, wertart, einheit, "
                + "periode_art, geltung_art, standort_id) VALUES (?, ?, 'Zaun-Ladezeit', 'periodenwert', 'h', 'monat', "
                + "'standort', ?) RETURNING id", UUID.class, DEMO, BEZUGSGROESSE, demoStandort);
        // Die Bindung beginnt nach dem Import-Monat, sonst sperrte sie die CSV-Übernahme (kanal_gebunden).
        root.update("INSERT INTO bezugsgroesse_kanalbindung (tenant_id, bezugsgroesse_id, entity_id, kanal, wertart, "
                + "einheit, zustand, kadenz_s, von, actor_name, actor_art) VALUES (?, ?, ?, ?, 'state', 'h', 'Charging', "
                + "60, '2026-08-31T22:00:00Z', 'Zaun', 'voltpilot')", DEMO, bezugsgroesse, komponente, KANAL_ZUSTAND);
        UUID unterstuetzung = root.queryForObject("SELECT min(id::text)::uuid FROM zugriff WHERE tenant_id = ? "
                + "AND benutzer_sub = ?", UUID.class, DEMO, PARTNER_GEWAEHRT);

        // Dasselbe in einem ANDEREN Kundenbereich: eine Unterstützung in Nordwind, für den Mandanten-Zaun.
        UUID nordwindUnternehmen = root.queryForList("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class,
                NORDWIND).stream().findFirst().orElseGet(() -> root.queryForObject("INSERT INTO unternehmen "
                        + "(tenant_id, name) VALUES (?, 'Nordwind') RETURNING id", UUID.class, NORDWIND));
        UUID nordwindStandort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, 'Nordwind-Standort', 'ST-92', 'Europe/Berlin', 'aktiv') RETURNING id",
                UUID.class, NORDWIND, nordwindUnternehmen);
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'partner', ?, "
                + "'aktiv')", NORDWIND, PARTNER_NORDWIND, PARTNER_NORDWIND);
        UUID unterstuetzungNordwind = root.queryForObject("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, "
                + "standort_id, art, umfang, gueltig_ab, gueltig_bis, endet_am, zeitzone) VALUES (?, ?, 'unterstuetzer', "
                + "?, 'installateur', 'ansehen', ?, '2099-12-30', '2099-12-31T00:00:00+01', 'Europe/Berlin') RETURNING id",
                UUID.class, NORDWIND, PARTNER_NORDWIND, nordwindStandort, ab("2026-01-01"));

        String standort = "/api/v1/standorte/" + demoStandort;
        PROBEN.put(BEZUGSGROESSE_SELBST, "/api/v1/bezugsgroessen/" + bezugsgroesse);
        PROBEN.put("/api/v1/bezugsgroessen/{id}/kanalbindung", "/api/v1/bezugsgroessen/" + bezugsgroesse
                + "/kanalbindung");
        PROBEN.put("/api/v1/bezugsgroessen/{id}/kanalbindung/kanaele", "/api/v1/bezugsgroessen/" + bezugsgroesse
                + "/kanalbindung/kanaele");
        PROBEN.put("/api/v1/geraete/{id}/austausch/vorschau", "/api/v1/geraete/" + wago + "/austausch/vorschau");
        PROBEN.put("/api/v1/geraete/{id}/wago", "/api/v1/geraete/" + wago + "/wago");
        PROBEN.put("/api/v1/korrekturen/{kennung}", "/api/v1/korrekturen/" + KORREKTUR);
        PROBEN.put("/api/v1/messstellen/{kennzeichen}/ablesungen", "/api/v1/messstellen/MS-Z1/ablesungen");
        PROBEN.put("/api/v1/messstellen/{kennzeichen}/ersatzwerte/luecken", "/api/v1/messstellen/MS-Z1/ersatzwerte/"
                + "luecken?quelle_id=" + quelle + "&von=" + VON + "&bis=" + BIS);
        PROBEN.put("/api/v1/sites/{siteId}/components/{entityId}/wago", "/api/v1/sites/" + BERLIN_SITE + "/components/"
                + wagoKomponente + "/wago");
        PROBEN.put("/api/v1/sites/{siteId}/komponenten/{entityId}/summenwerte", "/api/v1/sites/" + BERLIN_SITE
                + "/komponenten/" + komponente + "/summenwerte");
        PROBEN.put("/api/v1/standorte/{standortId}/ausfall", standort + "/ausfall");
        PROBEN.put("/api/v1/standorte/{standortId}/korrekturen", standort + "/korrekturen");
        PROBEN.put("/api/v1/standorte/{standortId}/netzanschluesse/vorschlaege", standort + "/netzanschluesse/vorschlaege");
        PROBEN.put("/api/v1/standorte/{standortId}/orte/kurzzeichen-vorschlag", standort
                + "/orte/kurzzeichen-vorschlag?art=gebaeude");
        PROBEN.put("/api/v1/standorte/{standortId}/versorgung", standort + "/versorgung");
        PROBEN.put("/api/v1/unterstuetzung/{id}", "/api/v1/unterstuetzung/" + unterstuetzung);
        PROBEN.put("/api/v1/zugriff", "/api/v1/zugriff?benutzer=" + KUNDE_BEARBEITER);
        FREMDER_KUNDENBEREICH.put("/api/v1/unterstuetzung/{id}", "/api/v1/unterstuetzung/" + unterstuetzungNordwind);
        FREMDER_KUNDENBEREICH.put("/api/v1/zugriff", "/api/v1/zugriff?benutzer=" + PARTNER_NORDWIND);
    }

    /**
     * Ein Import mit genau einer Zeile auf die Bezugsgröße des Demo-Standorts — über den Schreibweg (Vorschau, dann
     * Übernahme als Kundenadministrator), damit Import, Zeile und Wert so zusammenhängen wie im Betrieb.
     */
    private void importAnlegen() throws Exception {
        String monat = java.time.YearMonth.now().minusMonths(2).toString();
        byte[] datei = ("Periode;Menge;Einheit\n" + monat + ";312,4;h\n").getBytes(StandardCharsets.UTF_8);
        byte[] zuordnung = ("{\"spalten\":{\"periode\":1,\"wert\":2,\"einheit\":3},\"deutung\":\"periode\","
                + "\"zahlformat\":\"de\",\"bezugsgroesse\":\"" + BEZUGSGROESSE + "\"}").getBytes(StandardCharsets.UTF_8);
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Antwort v = ruf(MockMvcRequestBuilders.multipart(URI.create("/api/v1/bezugsdaten/importe/vorschau"))
                .file(new MockMultipartFile("datei", "Zaun.csv", "text/csv", datei))
                .file(new MockMultipartFile("zuordnung", "", "application/json", zuordnung)), ka);
        assertThat(v.status()).as(v.body()).isEqualTo(200);
        String bestaetigung = "{\"vorschau\":\"" + MAPPER.readTree(v.body()).at("/vorschau/kennung").asText()
                + "\",\"entscheidungen\":{}}";
        Antwort i = ruf(MockMvcRequestBuilders.multipart(URI.create("/api/v1/bezugsdaten/importe"))
                .file(new MockMultipartFile("datei", "Zaun.csv", "text/csv", datei))
                .file(new MockMultipartFile("zuordnung", "", "application/json", zuordnung))
                .file(new MockMultipartFile("bestaetigung", "", "application/json",
                        bestaetigung.getBytes(StandardCharsets.UTF_8))), ka);
        assertThat(i.status()).as(i.body()).isEqualTo(200);
        importKennung = MAPPER.readTree(i.body()).path("kennung").asText();
        assertThat(importKennung).startsWith("I-");
        PROBEN.put("/api/v1/bezugsdaten/importe/{kennung}", "/api/v1/bezugsdaten/importe/" + importKennung);
        PROBEN.put("/api/v1/bezugsdaten/importe/{kennung}/ruecknahme/vorschau", "/api/v1/bezugsdaten/importe/"
                + importKennung + "/ruecknahme/vorschau");
    }

    private static UUID unternehmenDesDemoKundenbereichs() {
        return root.queryForList("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, DEMO).stream()
                .findFirst().orElseGet(() -> root.queryForObject("INSERT INTO unternehmen (tenant_id, name) "
                        + "VALUES (?, 'Demo') RETURNING id", UUID.class, DEMO));
    }

    private static UUID neuerDemoStandort() {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Demo-Standort', 'ST-90', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                DEMO, unternehmenDesDemoKundenbereichs());
    }

    private static void spiegel(String sub, String konto) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, ?, ?, 'aktiv')",
                DEMO, sub, konto, sub);
    }

    private static void unterstuetzung(String sub, String von, String bis) {
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, art, umfang, gueltig_ab, "
                + "gueltig_bis, endet_am, zeitzone) VALUES (?, ?, 'unterstuetzer', ?, 'installateur', 'ansehen', ?, ?, ?, "
                + "'Europe/Berlin')", DEMO, sub, demoStandort, ab(von), LocalDate.parse(bis),
                LocalDate.parse(bis).plusDays(1).atStartOfDay(java.time.ZoneId.of("Europe/Berlin")).toOffsetDateTime());
    }

    private static OffsetDateTime ab(String tag) {
        return LocalDate.parse(tag).atStartOfDay().atOffset(ZoneOffset.ofHours(1));
    }
}
