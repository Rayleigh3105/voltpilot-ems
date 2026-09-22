package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;

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
 *       Standort bekommt dort die Antwort einer unbekannten Kennung.</li>
 *   <li><b>Die Inventur vom 21.09.2026:</b> jede übrige lesende Kundenroute mit Kennung, deren Objekt die Bühne trägt,
 *       und die Listen derselben Objekte machen dieselbe Aussage. Was daran scheitert, stand benannt in
 *       {@link #ZAUN_OFFEN} (Messstelle, Kostenstelle, Prozess, Vorlagen, Protokoll des Unternehmens) — seit dem
 *       Entscheid vom 21.09.2026 ist die Map leer; die Listen der Kostenstellen und Prozesse sind die benannte
 *       Ausnahme {@link #AUSWAHL_KATALOG} (nur Stammdaten). Seit dem 21.09.2026 trägt die Bühne auch Netzanschlüsse
 *       ({@link #netzanschluesse}); ihre Kreuzfälle misst
 *       {@link #derNetzanschlussNenntKeineAnlageUndKeinenZaehlerAusserhalbDesZugriffs}.</li>
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
    /**
     * Der zweite Standort desselben Kundenbereichs: an ihm hängt kein Objekt der 18 Routen und der Inventur — nur die
     * fremde Seite des Netzanschlusses ({@link #netz}).
     */
    private static UUID andererStandort;
    /** Je Muster ein aufrufbarer Pfad auf ein Objekt, das es im Bestand dieser Bühne WIRKLICH gibt. */
    private static final Map<String, String> PROBEN = new TreeMap<>();
    /** Je Muster ohne Standortbezug ein Pfad auf dasselbe Objekt in einem ANDEREN Kundenbereich (Nordwind). */
    private static final Map<String, String> FREMDER_KUNDENBEREICH = new TreeMap<>();
    private static UUID bezugsgroesse;
    private static String importKennung;
    /** Die übrigen Objekte der Bühne, die die Inventur ({@link #behaelter}, {@link #unterobjekte}) einsetzt. */
    private static Buehne buehne;

    private record Buehne(UUID messstelle, UUID quelle, UUID box, UUID wago, UUID komponente, UUID ort,
            UUID kostenstelle, UUID prozess) {}

    /** Die Netzanschlüsse der Bühne ({@link #netzanschluesse}): hier, anderswo und die Anlage anderswo. */
    private static Netz netz;

    private record Netz(UUID hier, UUID fremd, UUID fremdeAnlage) {}

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
     * <p>Captain 22.09.2026 E2 = A: genau die beiden Kundenkonten steigen — echte und gedachte
     * Kundenadmin-Zuweisung (E12) erhalten dieselbe Stufe. Alle anderen Leseantworten bleiben gleich.
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
        // Captain 22.09.2026 E2 = A: echte und gedachte Kundenadmin-Zuweisung, jeweils MIT Stufe.
        assertThat(stufenwechsel).containsExactly(
                "Kundenkonto (Bestandsübernahme: Kundenadministrator): CUSTOMER → SITE_ADMIN",
                "Kundenkonto ohne Realm-Rolle, nie zugewiesen (Bestandsregel E12): CUSTOMER → SITE_ADMIN");
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
     * Die Muster, die am Zaun scheitern dürfen — jedes ist ein ECHTES, gemessenes Loch mit Satz und Ursache, NICHT
     * geheilt. Die Zusicherung bleibt stehen: ein weiteres Muster ist ein neues Loch, ein geheiltes gehört hier heraus
     * (beides rot). Bis zum 21.09.2026 standen hier die drei Lesewege der Bezugsgröße (geschlossen mit PR 1000). Seit
     * der Inventur vom 21.09.2026 ({@code vp-uems-zaun-alle-leserouten-messen},
     * {@link #jedeLesendeRouteMitKennungZeigtIhrObjektNurAmStandortDesObjekts}) stehen hier die Lesewege von
     * Messstelle, Kostenstelle, Prozess und die Vorlagen-Liste: {@code messstelle*}, {@code kostenstelle},
     * {@code prozess} und {@code bezugsdaten_vorlage} tragen nur die Mandanten-Policy, und die Dienste fragen weder
     * {@code Geltungsbereich} noch {@code RechtPruefung#pruefenLesen}. Ursachen relativ zu
     * {@code services/api/src/main/java/com/voltpilot/api/uems/}. Die 14 Muster der Messstelle und die Vorlagen-Liste
     * sind geschlossen mit {@code vp-uems-zaun-messstelle-vorlagen-lesen} (Routen über {@code RechtPruefung#pruefenLesen}
     * bzw. {@code #lesbar}, Beweis {@code LesewegImZugriffApiTest}). Die zwei Listen der Kostenstellen und Prozesse
     * standen hier bis zum Entscheid vom 21.09.2026 (Lesart B) und sind seitdem die benannte Ausnahme
     * {@link #AUSWAHL_KATALOG}. Die Map ist LEER — und bleibt als Wache gegen jedes neue Loch stehen.
     */
    private static final Map<String, String> ZAUN_OFFEN = Map.of();

    /**
     * Die benannte Ausnahme vom Satz „anderswo nennt die Liste das Objekt nicht": der Auswahl-Katalog (Entscheid
     * 21.09.2026, Lesart B; {@code RechtPruefung#auswahlKatalog}). Wer Messstellen zuordnen darf
     * ({@code messstelle.bearbeiten} oder {@code messstelle.verteilung} irgendwo), braucht die Namen der Kostenstellen
     * und Prozesse zum Zuordnen — AP-03-Matrix und AP-10 E15 geben ihm das an seinem Standort. Er sieht darum JEDE Zeile,
     * aber GENAU mit diesen Feldern (Kennung, Kennzeichen, Name, Gültigkeit, beim Prozess die Eltern) und keinem
     * weiteren; ein Konto ohne diese Rechte sieht keine Zeile. Detail und Bilanz bleiben den unternehmensweiten Rollen.
     */
    private static final Map<String, List<String>> AUSWAHL_KATALOG = Map.of(
            "/api/v1/unternehmen/kostenstellen", List.of("id", "kennzeichen", "name", "gueltig_ab", "gueltig_bis"),
            "/api/v1/unternehmen/prozesse", List.of("id", "kennzeichen", "name", "eltern", "gueltig_ab", "gueltig_bis"));

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
                .containsExactlyInAnyOrderElementsOf(ZAUN_OFFEN.keySet().stream().filter(gemessen::contains).toList());
    }

    /** Pflichtparameter einer Inventur-Route, ohne die auch der Bearbeiter am Standort abgelehnt wird. */
    private static final Map<String, String> ANFRAGE = Map.of(
            "/api/v1/messstellen/{kennzeichen}/werte", "?raster=tag&von=2026-09-01&bis=2026-09-02",
            "/api/v1/messstellen/{kennzeichen}/werte/versionen", "?raster=tag&von=2026-09-01&bis=2026-09-02");

    /** Eine Kennung, die es in keinem Kundenbereich gibt. */
    private static final String NIE = "00000000-0000-0000-0000-00000000dead";

    /**
     * Die LISTEN der Objekte, die die Inventur trifft: Muster → {aufrufbarer Pfad, was die Liste für das Objekt der
     * Bühne nennt}. Eine Liste, die einem Bearbeiter an einem anderen Standort das Objekt nennt, ist dasselbe Loch wie
     * die Einzelroute.
     */
    private static Map<String, String[]> listen() {
        Map<String, String[]> l = new TreeMap<>();
        l.put("/api/v1/sites", new String[] {"/api/v1/sites", BERLIN_SITE});
        l.put("/api/v1/standorte", new String[] {"/api/v1/standorte", demoStandort.toString()});
        l.put("/api/v1/messstellen", new String[] {"/api/v1/messstellen", "MS-Z1"});
        l.put("/api/v1/devices", new String[] {"/api/v1/devices", buehne.box().toString()});
        l.put("/api/v1/bezugsgroessen", new String[] {"/api/v1/bezugsgroessen", BEZUGSGROESSE});
        l.put("/api/v1/bezugsdaten/importe", new String[] {"/api/v1/bezugsdaten/importe", importKennung});
        l.put("/api/v1/overview", new String[] {"/api/v1/overview", BERLIN_SITE});
        l.put("/api/v1/earnings", new String[] {"/api/v1/earnings", BERLIN_SITE});
        l.put("/api/v1/bezugsdaten/vorlagen", new String[] {"/api/v1/bezugsdaten/vorlagen", "Zaun-Vorlage"});
        l.put("/api/v1/unternehmen/kostenstellen", new String[] {"/api/v1/unternehmen/kostenstellen", "K-91"});
        l.put("/api/v1/unternehmen/prozesse", new String[] {"/api/v1/unternehmen/prozesse", "P-91"});
        l.put("/api/v1/unternehmen/aenderungen", new String[] {"/api/v1/unternehmen/aenderungen?von=2026-09-01"
                + "&bis=2026-09-30", "Zaun-Protokoll"});
        return l;
    }

    /**
     * Die erste Kennung im Pfad: das Objekt der Bühne und eine Kennung derselben Art, die es nicht gibt — oder
     * {@code null}, wenn die Bühne dieses Objekt nicht trägt (Protokoll „ohne Objekt").
     */
    private static String[] behaelter(String kopf, String name) {
        return switch (kopf) {
            case "/api/v1/sites/" -> new String[] {BERLIN_SITE, NIE};
            case "/api/v1/standorte/" -> new String[] {demoStandort.toString(), NIE};
            case "/api/v1/messstellen/" -> "kennzeichen".equals(name) ? new String[] {"MS-Z1", "MS-Z9"}
                    : new String[] {buehne.messstelle().toString(), NIE};
            case "/api/v1/geraete/" -> new String[] {buehne.wago().toString(), NIE};
            case "/api/v1/devices/" -> new String[] {buehne.box().toString(), NIE};
            case "/api/v1/bezugsgroessen/" -> new String[] {bezugsgroesse.toString(), NIE};
            case "/api/v1/korrekturen/" -> new String[] {KORREKTUR, "K-2026-9999"};
            case "/api/v1/bezugsdaten/importe/" -> new String[] {importKennung, "I-2026-9999"};
            case "/api/v1/orte/" -> new String[] {buehne.ort().toString(), NIE};
            case "/api/v1/unternehmen/kostenstellen/" -> new String[] {buehne.kostenstelle().toString(), NIE};
            case "/api/v1/unternehmen/prozesse/" -> new String[] {buehne.prozess().toString(), NIE};
            default -> null;
        };
    }

    /** Weitere Kennungen hinter der ersten: das Objekt der Bühne, wo es eines gibt, sonst eine unbekannte. */
    private static String unterobjekte(String rest) {
        rest = rest.replace("/netzanschluesse/{id}", "/netzanschluesse/" + netz.hier());
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\{([^}:]+)(:[^}]*)?}").matcher(rest);
        StringBuilder s = new StringBuilder();
        while (m.find()) {
            String wert = switch (m.group(1)) {
                case "entityId" -> buehne.komponente().toString();
                case "quelleId" -> buehne.quelle().toString();
                case "pointKey" -> KANAL;
                case "role" -> "grid-meter";
                case "nr" -> "1";
                default -> NIE;
            };
            m.appendReplacement(s, wert);
        }
        m.appendTail(s);
        return s.toString();
    }

    /**
     * Die Inventur vom 21.09.2026 ({@code vp-uems-zaun-alle-leserouten-messen}): JEDE übrige lesende Kundenroute mit
     * einer Kennung im Pfad, deren erste Kennung ein Objekt dieser Bühne trifft ({@link #behaelter}), macht dieselbe
     * Aussage wie die 18 — gesehen wird das Objekt vom Bearbeiter am Standort ({@code < 400}; lehnt ihn ein Recht ab,
     * vom Kundenadministrator, Protokoll „sieht: KA"), und der Bearbeiter an einem ANDEREN Standort bekommt Status und
     * Körper derselben Route mit einer unbekannten Kennung. Sieht auch der Kundenadministrator nichts (Pflichtparameter,
     * Unterobjekt fehlt der Bühne), steht die Route „ohne Aussage" im Protokoll: zwei gleiche Ablehnungen beweisen
     * keinen Zaun. Dazu die Listen derselben Objekte ({@link #listen}): anderswo nennen sie das Objekt nicht.
     */
    @Test
    void jedeLesendeRouteMitKennungZeigtIhrObjektNurAmStandortDesObjekts() throws Exception {
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Konto hier = new Konto("Bearbeiter am Standort des Objekts", konto(KUNDE_BEARBEITER, DEMO), new String[0]);
        Konto anderswo = new Konto("Bearbeiter nur an einem anderen Standort", konto(KUNDE_BEARBEITER_FREMD, DEMO),
                new String[0]);
        Konto leser = new Konto("Leser am Demo-Standort", konto(KUNDE_LESER, DEMO), new String[0]);
        Set<String> auswahl = new TreeSet<>();
        Set<String> schonGemessen = new TreeSet<>(NACH_IP4_NUR_ZUFAELLIG_GRUEN);
        schonGemessen.add(BEZUGSGROESSE_SELBST);
        Set<String> inventur = new TreeSet<>();
        Map<String, String> zaunVerfehlt = new TreeMap<>();
        Set<String> gezaeunt = new TreeSet<>();
        Set<String> ohneAussage = new TreeSet<>();
        Set<String> ohneObjekt = new TreeSet<>();
        Map<String, String[]> paare = new TreeMap<>();
        for (Route r : kundenrouten(true)) {
            String muster = r.muster();
            if (!muster.contains("{") || schonGemessen.contains(muster) || AUSGENOMMEN.contains(muster)) {
                continue;
            }
            int a = muster.indexOf('{');
            int e = muster.indexOf('}', a);
            String[] b = behaelter(muster.substring(0, a), muster.substring(a + 1, e).split(":")[0]);
            if (b == null) {
                ohneObjekt.add(muster);
                continue;
            }
            String rest = unterobjekte(muster.substring(e + 1)) + ANFRAGE.getOrDefault(muster, "");
            paare.put(muster, new String[] {muster.substring(0, a) + b[0] + rest, muster.substring(0, a) + b[1] + rest});
        }
        // Die Kennung steht in der Anfrage statt im Pfad: dieselbe Aussage (anderswo = unbekannte Kennung).
        String betroffen = "/api/v1/berichte/betroffen?gilt_ab=2026-09-01&anlass=zuordnung_rueckwirkend&objekt=";
        paare.put("/api/v1/berichte/betroffen", new String[] {betroffen + buehne.messstelle(), betroffen + NIE});
        for (Map.Entry<String, String[]> paar : paare.entrySet()) {
            String muster = paar.getKey();
            String probe = paar.getValue()[0];
            String unbekannt = paar.getValue()[1];
            inventur.add(muster);
            Antwort sieht = ruf(get(probe), hier);
            String wer = "";
            if (sieht.status() >= 400) {
                sieht = ruf(get(probe), ka);
                wer = " (sieht: KA)";
            }
            Antwort blind = ruf(get(probe), anderswo);
            Antwort nichts = ruf(get(unbekannt), anderswo);
            if (sieht.status() >= 400 && blind.status() == nichts.status() && blind.body().equals(nichts.body())) {
                // Zwei gleiche Ablehnungen beweisen keinen Zaun; zwei VERSCHIEDENE verraten die Existenz (unten).
                ohneAussage.add(muster + " " + sieht.status() + " " + kurz(sieht.body()));
                continue;
            }
            if (blind.status() < 400 || blind.status() != nichts.status() || !blind.body().equals(nichts.body())) {
                zaunVerfehlt.put(muster, anderswo.name() + " bekommt " + blind.status() + " " + kurz(blind.body())
                        + " — eine unbekannte Kennung " + nichts.status() + " " + kurz(nichts.body()));
            } else {
                gezaeunt.add(muster + wer);
            }
        }
        for (Map.Entry<String, String[]> l : listen().entrySet()) {
            String muster = l.getKey();
            String pfad = l.getValue()[0];
            String beleg = l.getValue()[1];
            inventur.add(muster);
            Antwort sieht = ruf(get(pfad), hier);
            String wer = "";
            if (sieht.status() >= 400 || !sieht.body().contains(beleg)) {
                sieht = ruf(get(pfad), ka);
                wer = " (sieht: KA)";
            }
            if (sieht.status() >= 400 || !sieht.body().contains(beleg)) {
                ohneAussage.add(muster + " (Liste) " + sieht.status() + " " + kurz(sieht.body()));
                continue;
            }
            Antwort blind = ruf(get(pfad), anderswo);
            List<String> stammdaten = AUSWAHL_KATALOG.get(muster);
            if (blind.status() < 400 && blind.body().contains(beleg) && stammdaten != null) {
                // Die benannte Ausnahme: die Zeile nennt anderswo GENAU die Stammdaten, und ein Konto ohne das Recht
                // zum Zuordnen (der Leser) sieht sie gar nicht.
                List<String> felder = felderDerZeile(blind.body(), beleg);
                Antwort ohneRecht = ruf(get(pfad), leser);
                if (felder.equals(stammdaten) && ohneRecht.status() == 200 && !ohneRecht.body().contains(beleg)) {
                    auswahl.add(muster + " (Liste, nur Stammdaten " + felder + ")");
                } else {
                    zaunVerfehlt.put(muster, "der Auswahl-Katalog nennt " + anderswo.name() + " " + felder + ", "
                            + leser.name() + " bekommt " + ohneRecht.status() + " " + kurz(ohneRecht.body()));
                }
            } else if (blind.status() < 400 && blind.body().contains(beleg)) {
                zaunVerfehlt.put(muster, "die Liste nennt " + anderswo.name() + " das Objekt (" + beleg + ")");
            } else {
                gezaeunt.add(muster + " (Liste)" + wer);
            }
        }
        System.out.printf("Inventur: %d gemessen, davon am Zaun %d: %s%n", gezaeunt.size() + zaunVerfehlt.size(),
                gezaeunt.size(), gezaeunt);
        System.out.printf("Inventur OFFEN (%d): %s%n", zaunVerfehlt.size(), zaunVerfehlt);
        System.out.printf("Inventur Auswahl-Katalog (%d): %s%n", auswahl.size(), auswahl);
        System.out.printf("Inventur ohne Aussage (%d): %s%n", ohneAussage.size(), ohneAussage);
        System.out.printf("Inventur ohne Objekt der Bühne (%d): %s%n", ohneObjekt.size(), ohneObjekt);
        assertThat(zaunVerfehlt.keySet()).as("genau die benannten offenen Fälle verfehlen den Zaun — ein weiterer ist "
                + "ein neues Loch, ein geheilter gehört aus ZAUN_OFFEN heraus: " + zaunVerfehlt)
                .containsExactlyInAnyOrderElementsOf(ZAUN_OFFEN.keySet().stream().filter(inventur::contains).toList());
        assertThat(ZAUN_OFFEN.keySet()).as("jeder offene Fall ist gemessen").allMatch(
                m -> inventur.contains(m) || schonGemessen.contains(m));
        assertThat(auswahl).as("jede benannte Ausnahme ist gemessen und hält: " + zaunVerfehlt)
                .hasSize(AUSWAHL_KATALOG.size());
    }

    /**
     * Die Kreuzfälle des Netzanschlusses ({@code vp-uems-zaun-netzanschluss-buehne}). Die Inventur misst die drei
     * Einzel-Routen an NA-Z1 (hier sieht, anderswo = unbekannte Kennung); hier steht, was sie nicht sieht:
     * <ol>
     *   <li>der Anschluss eines fremden Standorts ist für den Bearbeiter hier eine unbekannte Kennung — über seinen
     *       eigenen Standort und über den des Bearbeiters, auf allen drei Wegen und in der Liste;</li>
     *   <li>ein sichtbarer Anschluss nennt keine Anlage außerhalb (AP-03 R-A7, die Liste der Bindungen filtert still);</li>
     *   <li>der Grenz-Nachweis eines Monats, in dem eine Anlage außerhalb am Anschluss hing, nennt weder ihren
     *       Hauptzähler noch eine Zahl, die aus ihr stammt — an ihrer Stelle {@link RechtPruefung#AUSSERHALB_ZUGRIFF}
     *       (R-A3).</li>
     * </ol>
     */
    @Test
    void derNetzanschlussNenntKeineAnlageUndKeinenZaehlerAusserhalbDesZugriffs() throws Exception {
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Konto hier = new Konto("Bearbeiter am Standort des Objekts", konto(KUNDE_BEARBEITER, DEMO), new String[0]);
        Konto anderswo = new Konto("Bearbeiter nur an einem anderen Standort", konto(KUNDE_BEARBEITER_FREMD, DEMO),
                new String[0]);
        String demo = "/api/v1/standorte/" + demoStandort + "/netzanschluesse";
        String fremd = "/api/v1/standorte/" + andererStandort + "/netzanschluesse";
        String nie = "/api/v1/standorte/" + NIE + "/netzanschluesse";
        List<String> fehler = new ArrayList<>();
        for (String weg : List.of("", "/grenzen", "/grenznachweis")) {
            Antwort ueberHier = ruf(get(demo + "/" + netz.fremd() + weg), hier);
            Antwort ueberFremd = ruf(get(fremd + "/" + netz.fremd() + weg), hier);
            if (ruf(get(fremd + "/" + netz.fremd() + weg), anderswo).status() != 200) {
                fehler.add("NA-Z9" + weg + ": " + anderswo.name() + " sieht ihn nicht (Gegenprobe)");
            }
            if (!ueberHier.equals(ruf(get(demo + "/" + NIE + weg), hier))) {
                fehler.add("NA-Z9" + weg + " über den eigenen Standort: " + ueberHier);
            }
            if (!ueberFremd.equals(ruf(get(nie + "/" + NIE + weg), hier))) {
                fehler.add("NA-Z9" + weg + " über seinen Standort: " + ueberFremd);
            }
        }
        if (!ruf(get(fremd), hier).equals(ruf(get(nie), hier))) {
            fehler.add("Liste am fremden Standort: " + ruf(get(fremd), hier));
        }
        for (String weg : List.of(demo, demo + "/" + netz.hier())) {
            String anlage = netz.fremdeAnlage().toString();
            if (!ruf(get(weg), ka).body().contains(anlage)) {
                fehler.add(weg + ": " + ka.name() + " sieht die Bindung der Anlage anderswo nicht (Gegenprobe)");
            }
            Antwort h = ruf(get(weg), hier);
            if (h.status() != 200 || !h.body().contains(BERLIN_SITE) || h.body().contains(anlage)) {
                fehler.add(weg + ": " + hier.name() + " bekommt " + h.status() + " " + kurz(h.body()));
            }
        }
        String monat = demo + "/" + netz.hier() + "/grenznachweis?monat=2023-06";
        Antwort voll = ruf(get(monat), ka);
        Antwort h = ruf(get(monat), hier);
        System.out.printf("Grenz-Nachweis 2023-06%n  KA:   %s%n  hier: %s%n", voll.body(), h.body());
        if (!voll.body().contains("MS-Z8") || !voll.body().contains("437")) {
            fehler.add("Grenz-Nachweis 2023-06: " + ka.name() + " rechnet nicht mit MS-Z8 und 437 kW (Gegenprobe)");
        }
        if (h.status() != 200 || h.body().contains("MS-Z8") || h.body().contains("437")
                || !h.body().contains(RechtPruefung.AUSSERHALB_ZUGRIFF)) {
            fehler.add("Grenz-Nachweis 2023-06: " + hier.name() + " bekommt " + h.status() + " " + h.body());
        }
        assertThat(fehler).isEmpty();
    }

    /** Die Feldnamen der Listen-Zeile mit dem Kennzeichen {@code beleg}, in der Folge der Antwort. */
    private static List<String> felderDerZeile(String body, String beleg) throws Exception {
        List<String> felder = new ArrayList<>();
        for (JsonNode liste : MAPPER.readTree(body)) {
            for (JsonNode zeile : liste.isArray() ? liste : MAPPER.createArrayNode()) {
                if (beleg.equals(zeile.path("kennzeichen").asText())) {
                    zeile.fieldNames().forEachRemaining(felder::add);
                }
            }
        }
        return felder;
    }

    /**
     * Das Protokoll des Unternehmens (AP-03 R-A1): ein Eintrag erscheint nur, wenn sein Objekt im Zugriff liegt. Im
     * Fenster 01.–02.03.2025 stehen abwechselnd drei Einträge an MS-Z1 (Demo-Standort) und zwei am anderen Standort: der
     * Bearbeiter am Demo-Standort sieht die drei, der am anderen Standort die zwei — auf jeder Seite; die Seiten bleiben
     * voll, „weiter“ führt durch genau seine Einträge in derselben Folge wie beim Kundenadministrator. Kundenadministrator,
     * Bestandskonto (E12) und ein Aufruf ohne Zugriff-Kontext bekommen dieselben Bytes (hier und im ganzen Jahr 2026).
     */
    @Test
    void dasProtokollDesUnternehmensZeigtNurEintraegeImZugriff() throws Exception {
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Konto bestand = new Konto("Bestandskonto (E12, nie zugewiesen)", konto("sub-zaun-bestandskonto", DEMO),
                new String[0]);
        Konto hier = new Konto("Bearbeiter am Standort des Objekts", konto(KUNDE_BEARBEITER, DEMO), new String[0]);
        Konto anderswo = new Konto("Bearbeiter nur an einem anderen Standort", konto(KUNDE_BEARBEITER_FREMD, DEMO),
                new String[0]);
        List<String> demo = new ArrayList<>();
        List<String> fremd = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            demo.add("messstelle:" + root.queryForObject("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, "
                    + "art, alt, neu, gilt_ab, rueckwirkend, grund, actor_sub, actor_name, actor_rolle, actor_art) VALUES "
                    + "(?, ?, 'bearbeitet', '{}'::jsonb, '{\"name\":\"Zaun-Zähler\"}'::jsonb, ?, false, 'Zaun-Seite', ?, "
                    + "'Zaun', 'kundenadministrator', 'kunde') RETURNING id", Long.class, DEMO, buehne.messstelle(),
                    java.sql.Timestamp.from(Instant.parse("2025-03-01T0" + (1 + 2 * i) + ":00:00Z")), KUNDE_KA));
        }
        for (String tag : List.of("2025-03-01", "2025-03-01")) {
            fremd.add("ort:" + root.queryForObject("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, alt, "
                    + "neu, gilt_ab, rueckwirkend, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, 'standort', ?, "
                    + "'bearbeitet', '{}'::jsonb, '{\"name\":\"Zaun-Werk\"}'::jsonb, ?::date, false, ?, 'Zaun', "
                    + "'kundenadministrator', 'kunde') RETURNING id", Long.class, DEMO, andererStandort, tag, KUNDE_KA));
        }
        for (String fenster : List.of("?von=2025-03-01&bis=2025-03-02", "?von=2026-01-01&bis=2027-01-01")) {
            String pfad = "/api/v1/unternehmen/aenderungen" + fenster + "&limit=500";
            Antwort voll = ruf(get(pfad), ka);
            assertThat(voll.status()).as(voll.body()).isEqualTo(200);
            assertThat(ruf(get(pfad), bestand)).as("Bestandskonto " + fenster).isEqualTo(voll);
            MvcResult ohne = mvc.perform(get(pfad).with(jwt().jwt(j -> {
                j.subject(KUNDE_KA);
                j.claim("preferred_username", KUNDE_KA);
                j.claim("tenant_id", DEMO.toString());
            }))).andReturn();
            assertThat(new Antwort(ohne.getResponse().getStatus(),
                    ohne.getResponse().getContentAsString(StandardCharsets.UTF_8))).as("ohne Zugriff-Kontext " + fenster)
                    .isEqualTo(voll);
        }

        String pfad = "/api/v1/unternehmen/aenderungen?von=2025-03-01&bis=2025-03-02";
        List<String> alle = eintraege(ruf(get(pfad + "&limit=500"), ka).body());
        assertThat(alle).containsAll(demo).containsAll(fremd);
        assertThat(seitenweise(pfad, ka)).as("seitenweise wie am Stück").isEqualTo(alle);
        List<String> sichtHier = seitenweise(pfad, hier);
        List<String> sichtAnderswo = seitenweise(pfad, anderswo);
        assertThat(sichtHier).containsAll(demo).doesNotContainAnyElementsOf(fremd)
                .isEqualTo(eintraege(ruf(get(pfad + "&limit=500"), hier).body()))
                .isEqualTo(alle.stream().filter(sichtHier::contains).toList());
        assertThat(sichtAnderswo).containsAll(fremd).doesNotContainAnyElementsOf(demo)
                .isEqualTo(eintraege(ruf(get(pfad + "&limit=500"), anderswo).body()))
                .isEqualTo(alle.stream().filter(sichtAnderswo::contains).toList());
    }

    /**
     * „Daten kommen an – noch keiner Messreihe zugeordnet“ (PR 1008) spricht nur über Anlagen im Zugriff. Die
     * Komponente der Messstelle ist gezäunt, ihre Mess-Selektion und die Box-Werte sind es nicht: ein Wert trägt die
     * Anlage, an der er ankam (nach einem Umzug die alte), und die Selektion bindet die Komponente ohne Anlage. Zwei
     * Wege zu einer fremden Anlage B — Werte derselben Box, an B gestempelt, und eine Box an B, die denselben Kanal
     * der Komponente liest. Der Kundenadministrator sieht B und bekommt das Wort (die Probe schlägt an); der
     * Bearbeiter am Standort der Messstelle sieht B nicht und bekommt {@code null} wie ohne Werte.
     */
    @Test
    void dieZuordnungDerWerteKarteVerraetKeineWerteEinerFremdenAnlage() throws Exception {
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Konto hier = new Konto("Bearbeiter am Standort der Messstelle", konto(KUNDE_BEARBEITER, DEMO), new String[0]);
        String pfad = "/api/v1/messstellen/MS-Z1/werte?raster=tag&von=2026-09-01&bis=2026-09-01";
        assertThat(zuordnung(pfad, ka)).as("ohne Box-Werte kein Fall").isNull();
        assertThat(zuordnung(pfad, hier)).isNull();

        UUID anlageB = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, "
                + "'Zaun-Anlage B', 'DE-LU') RETURNING id", UUID.class, DEMO);
        UUID boxB = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, "
                + "'VP-BOX-ZAUN-B', 'claimed') RETURNING id", UUID.class, DEMO, anlageB);
        try {
            // (1) Dieselbe Box, ihre Werte an B gestempelt (vor einem Umzug nach A).
            boxWertAn(anlageB, buehne.box(), 1);
            assertThat(zuordnung(pfad, ka)).as("die Probe schlägt an").isEqualTo("nicht_zugeordnet");
            assertThat(zuordnung(pfad, hier)).as("dieselbe Box, Werte an B").isNull();
            root.update("DELETE FROM device_measurement_sample WHERE site_id = ?", anlageB);

            // (2) Eine Box an B liest denselben Kanal der Komponente.
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                    + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                    + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, '2024-03-12', "
                    + "'2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')", DEMO, anlageB, boxB,
                    buehne.komponente(), KANAL);
            boxWertAn(anlageB, boxB, 2);
            assertThat(zuordnung(pfad, ka)).as("die Probe schlägt an").isEqualTo("nicht_zugeordnet");
            assertThat(zuordnung(pfad, hier)).as("eine Box an B").isNull();
        } finally {
            root.update("DELETE FROM device_measurement_sample WHERE site_id = ?", anlageB);
            root.update("DELETE FROM device_measurement_selection WHERE device_id = ?", boxB);
            root.update("DELETE FROM device WHERE id = ?", boxB);
            root.update("DELETE FROM site WHERE id = ?", anlageB);
        }
        assertThat(zuordnung(pfad, ka)).as("aufgeräumt").isNull();
    }

    /**
     * Dasselbe im Messstellen-Register ({@code MessstelleRegisterRepository#WERTE}): dort trägt die Box-Abfrage nicht
     * nur das Wort, sondern auch den LETZTEN WERT der Zeile. Dieselben zwei Wege zu einer fremden Anlage B. Der
     * Kundenadministrator sieht B und bekommt Wort und Zahl (die Probe schlägt an); der Bearbeiter am Standort der
     * Messstelle bekommt weder das Wort noch eine an B gemessene Zahl — außerhalb des Zugriffs fehlt sie ganz.
     */
    @Test
    void dasRegisterZeigtKeinenBoxWertEinerFremdenAnlage() throws Exception {
        Konto ka = new Konto("Kundenadministrator", konto(KUNDE_KA, DEMO, "operator"), new String[0]);
        Konto hier = new Konto("Bearbeiter am Standort der Messstelle", konto(KUNDE_BEARBEITER, DEMO), new String[0]);
        assertThat(registerZeile(ka).has("letzter_wert") && !registerZeile(ka).get("letzter_wert").isNull())
                .as("ohne Box-Werte kein letzter Wert " + registerZeile(ka)).isFalse();
        assertThat(registerZeile(ka).at("/beobachtung/zuordnung").isMissingNode()).as("ohne Box-Werte kein Fall")
                .isTrue();

        UUID anlageB = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, "
                + "'Zaun-Anlage B', 'DE-LU') RETURNING id", UUID.class, DEMO);
        UUID boxB = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, "
                + "'VP-BOX-ZAUN-B', 'claimed') RETURNING id", UUID.class, DEMO, anlageB);
        try {
            // (1) Dieselbe Box, ihre Werte an B gestempelt (vor einem Umzug nach A).
            boxWertAn(anlageB, buehne.box(), 1);
            registerSiehtB(ka, hier, "dieselbe Box, Werte an B");
            root.update("DELETE FROM device_measurement_sample WHERE site_id = ?", anlageB);

            // (2) Eine Box an B liest denselben Kanal der Komponente.
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                    + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                    + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, '2024-03-12', "
                    + "'2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')", DEMO, anlageB, boxB,
                    buehne.komponente(), KANAL);
            boxWertAn(anlageB, boxB, 2);
            registerSiehtB(ka, hier, "eine Box an B");
        } finally {
            root.update("DELETE FROM device_measurement_sample WHERE site_id = ?", anlageB);
            root.update("DELETE FROM device_measurement_selection WHERE device_id = ?", boxB);
            root.update("DELETE FROM device WHERE id = ?", boxB);
            root.update("DELETE FROM site WHERE id = ?", anlageB);
        }
        assertThat(registerZeile(ka).at("/beobachtung/zuordnung").isMissingNode()).as("aufgeräumt").isTrue();
    }

    private void registerSiehtB(Konto ka, Konto hier, String weg) throws Exception {
        JsonNode mitB = registerZeile(ka);
        assertThat(mitB.at("/beobachtung/zuordnung").asText()).as("die Probe schlägt an: " + weg)
                .isEqualTo("nicht_zugeordnet");
        assertThat(mitB.at("/letzter_wert/wert").asDouble()).as("die Probe schlägt an: " + weg).isEqualTo(500.0);
        JsonNode ohneB = registerZeile(hier);
        assertThat(ohneB.at("/beobachtung/zuordnung").isMissingNode()).as(weg + " " + ohneB).isTrue();
        assertThat(ohneB.get("letzter_wert").isNull()).as(weg + ": keine an B gemessene Zahl " + ohneB).isTrue();
    }

    /** Die Register-Zeile von MS-Z1, kurz nach dem Box-Wert der Probe. */
    private JsonNode registerZeile(Konto k) throws Exception {
        Antwort a = ruf(get("/api/v1/messstellen?stichtag=2026-09-01T08:05:00Z"), k);
        assertThat(a.status()).as(k.name() + " " + a.body()).isEqualTo(200);
        for (JsonNode z : MAPPER.readTree(a.body()).get("register")) {
            if ("MS-Z1".equals(z.get("kennzeichen").asText())) {
                return z;
            }
        }
        throw new AssertionError(k.name() + ": keine Zeile MS-Z1");
    }

    private String zuordnung(String pfad, Konto k) throws Exception {
        Antwort a = ruf(get(pfad), k);
        assertThat(a.status()).as(k.name() + " " + a.body()).isEqualTo(200);
        JsonNode z = MAPPER.readTree(a.body()).get("zuordnung");
        assertThat(z).as("das Feld steht an der Route").isNotNull();
        return z.isNull() ? null : z.asText();
    }

    /** Ein guter Wert am Zaun-Kanal, ohne Reihe (kein {@code entity_id}), an Anlage und Box. */
    private static void boxWertAn(UUID anlage, UUID box, int folge) {
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, raw_numeric, "
                + "decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind) VALUES "
                + "('2026-09-01T08:00:00Z', ?, ?, ?, ?, 500, 500, 'good', '2026.09.11.1', ?, 'counter')", DEMO, anlage,
                box, KANAL, folge);
    }

    /** Alle Seiten zu je zwei Einträgen: jede Seite ist voll, solange „weiter“ steht. */
    private List<String> seitenweise(String pfad, Konto k) throws Exception {
        List<String> ids = new ArrayList<>();
        String weiter = null;
        for (int seite = 0; seite < 500; seite++) {
            Antwort a = ruf(get(pfad + "&limit=2" + (weiter == null ? "" : "&nach=" + weiter)), k);
            assertThat(a.status()).as(k.name() + " " + a.body()).isEqualTo(200);
            JsonNode n = MAPPER.readTree(a.body());
            List<String> hier = eintraege(a.body());
            ids.addAll(hier);
            if (n.path("weiter").isNull() || n.path("weiter").isMissingNode()) {
                return ids;
            }
            assertThat(hier).as(k.name() + ": eine Seite mit „weiter“ ist voll").hasSize(2);
            weiter = n.path("weiter").asText();
        }
        throw new AssertionError("mehr als 500 Seiten");
    }

    private static List<String> eintraege(String body) throws Exception {
        List<String> ids = new ArrayList<>();
        MAPPER.readTree(body).path("eintraege").forEach(e -> ids.add(e.path("id").asText()));
        return ids;
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
        netzanschluesse();
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

        // Für die Inventur: ein Gebäude am Demo-Standort, dazu Kostenstelle und Prozess (Geltung Unternehmen, AP-03
        // §4.9) mit der Messstelle als Mitglied.
        UUID ort = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) VALUES (?, "
                + "'gebaeude', 'Zaun-Halle', 'G-91', 'aktiv') RETURNING id", UUID.class, DEMO);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2024-01-01')", DEMO, ort, demoStandort);
        UUID kostenstelle = root.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, "
                + "gueltig_ab) VALUES (?, ?, 'K-91', 'Zaun-Kostenstelle', '2024-01-01') RETURNING id", UUID.class, DEMO,
                unternehmenDesDemoKundenbereichs());
        UUID prozess = root.queryForObject("INSERT INTO prozess (tenant_id, unternehmen_id, kennzeichen, name, "
                + "gueltig_ab) VALUES (?, ?, 'P-91', 'Zaun-Prozess', '2024-01-01') RETURNING id", UUID.class, DEMO,
                unternehmenDesDemoKundenbereichs());
        root.update("INSERT INTO messstelle_prozess (tenant_id, messstelle_id, prozess_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2024-01-01')", DEMO, messstelle, prozess);
        // Ein Eintrag im Protokoll der Messstelle (für das Protokoll des Unternehmens).
        root.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, alt, neu, gilt_ab, rueckwirkend, "
                + "grund, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, 'bearbeitet', '{}'::jsonb, "
                + "'{\"name\":\"Zaun-Zähler\"}'::jsonb, '2026-09-01T00:00:00Z', false, 'Zaun-Protokoll', ?, 'Zaun', "
                + "'kundenadministrator', 'kunde')", DEMO, messstelle, KUNDE_KA);
        buehne = new Buehne(messstelle, quelle, box, wago, komponente, ort, kostenstelle, prozess);
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
     * Der Netzanschluss auf der Bühne ({@code vp-uems-zaun-netzanschluss-buehne}): NA-Z1 am Demo-Standort mit der
     * Berliner Anlage, einer Fassung des Grenzblatts und MS-Z1 als Hauptzähler; NA-Z9 am anderen Standort mit eigener
     * Anlage, Fassung und Hauptzähler MS-Z8. Die Anlage anderswo hing 2023 an NA-Z1 — vor ihrem Umzug; die Zuordnung
     * ändert den Anschluss nicht ({@code AnlageUmzugDto.Netzanschluss}). So nennt ein sichtbarer Anschluss eine Anlage
     * und einen Hauptzähler außerhalb, und ihre eigene Grenze (437 kW) wirkt in NA-Z1 mit.
     */
    private static void netzanschluesse() {
        UUID hier = netzanschluss(demoStandort, "NA-Z1", "Zaun-Übergabe hier");
        UUID fremd = netzanschluss(andererStandort, "NA-Z9", "Zaun-Übergabe anderswo");
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Zaun-Anlage anderswo') "
                + "RETURNING id", UUID.class, DEMO);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2024-01-01')", DEMO, anlage, andererStandort);
        root.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw) VALUES (?, ?, 437)", anlage,
                DEMO);
        binden(UUID.fromString(BERLIN_SITE), hier, "2024-01-01", null);
        binden(anlage, hier, "2023-01-01", "2023-12-31");
        binden(anlage, fremd, "2024-01-01", null);
        for (UUID na : List.of(hier, fremd)) {
            root.update("INSERT INTO netzanschluss_grenze (tenant_id, netzanschluss_id, gueltig_ab, einspeisegrenze_kw, "
                    + "bezugsgrenze_kw, created_by) VALUES (?, ?, '2024-01-01', 100, 300, 'test')", DEMO, na);
        }
        UUID zaehler = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, 'MS-Z8', 'Zaun-Zähler anderswo', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, DEMO);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2023-01-01')", DEMO, zaehler, andererStandort);
        hauptzaehler(buehne.messstelle(), UUID.fromString(BERLIN_SITE), "2024-01-01");
        hauptzaehler(zaehler, anlage, "2023-01-01");
        netz = new Netz(hier, fremd, anlage);
    }

    private static UUID netzanschluss(UUID standort, String kennzeichen, String name) {
        return root.queryForObject("INSERT INTO netzanschluss (tenant_id, standort_id, kennzeichen, name, anschluss_kva, "
                + "vereinbart_kw, messung) VALUES (?, ?, ?, ?, 630, 550, 'RLM') RETURNING id", UUID.class, DEMO, standort,
                kennzeichen, name);
    }

    private static void binden(UUID anlage, UUID netzanschluss, String ab, String bis) {
        root.update("INSERT INTO anlage_netzanschluss (tenant_id, site_id, netzanschluss_id, gueltig_ab, gueltig_bis) "
                + "VALUES (?, ?, ?, ?::date, ?::date)", DEMO, anlage, netzanschluss, ab, bis);
    }

    private static void hauptzaehler(UUID messstelle, UUID anlage, String ab) {
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                + "VALUES (?, ?, ?, 'Hauptzähler', ?::date)", DEMO, messstelle, anlage, ab);
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
        // Eine Vorlage mit derselben Zuordnung (Ziel BZ-Z1, Geltung Demo-Standort), über ihren Schreibweg.
        Antwort vorlage = ruf(MockMvcRequestBuilders.post(URI.create("/api/v1/bezugsdaten/vorlagen"))
                .contentType("application/json").content("{\"vorlage_id\":null,\"name\":\"Zaun-Vorlage\","
                        + "\"zuordnung\":" + new String(zuordnung, StandardCharsets.UTF_8) + "}"), ka);
        assertThat(vorlage.status()).as(vorlage.body()).isEqualTo(201);
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
