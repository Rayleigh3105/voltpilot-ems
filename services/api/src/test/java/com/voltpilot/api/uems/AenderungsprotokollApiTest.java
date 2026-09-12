package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.yaml.snakeyaml.Yaml;

/**
 * Das ÄNDERUNGSPROTOKOLL lesbar (UEMS AP-04 IP-21) gegen echtes Keycloak + TimescaleDB:
 * {@code GET …/messstellen/{id}/aenderungen}, {@code GET …/geraete/{id}/aenderungen} und
 * {@code GET /api/v1/unternehmen/aenderungen}. Anlage, Komponenten, Geräte, Kennzeichen und
 * Zeitpunkte sind die des Referenzunternehmens ({@code uems-referenzunternehmen.json}) — die
 * EINZIGE Beispielquelle.
 *
 * <p>Bewiesen wird:
 * <ul>
 *   <li><b>Die Abnahme:</b> der RÜCKWIRKENDE Zählerwechsel (gilt 18.11. 10:40, eingetragen
 *       11:05) steht im Zeitraum des BETROFFENEN Zeitpunkts — und mit {@code achse=eintrag} im
 *       Zeitraum des Eintrags. Beide Male genau EINMAL, nie in beiden auf derselben Achse;</li>
 *   <li>eine ANGEKÜNDIGTE Änderung steht im Zeitraum, in dem sie GILT — nicht im Zeitraum
 *       ihres Eintrags, und nicht doppelt;</li>
 *   <li>je Eintragsart eine Zeile mit geprüftem Wortlaut (die vollständige Liste prüft der
 *       reine {@code AenderungSatzTest});</li>
 *   <li>der Weg JE GERÄT: ein Wechsel steht in BEIDEN Geräte-Protokollen, und die Einstellung
 *       nur bei ihrem Gerät;</li>
 *   <li>der UNTERNEHMENS-Weg führt die drei Journale zusammen, seitet stabil — auch bei
 *       gleichen Zeitstempeln — und liefert keinen Eintrag doppelt und keinen gar nicht;</li>
 *   <li>der MANDANTENZAUN: fremd ist 404, nie 403; und eine Nachbar-Messstelle taucht im
 *       Protokoll der eigenen nicht auf;</li>
 *   <li>der LAUFZEIT-Nachweis: der Unternehmens-Weg kostet dieselbe Zahl an Abfragen wie ein
 *       einzelner Eintrag (keine N+1) und bleibt unter 300 ms.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AenderungsprotokollApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String ENERGIE_BEZUG = "sunspec.model_203.totwhimp";
    private static final String ENERGIE_ABGABE = "sunspec.model_203.totwhexp";
    private static final String LEISTUNG_VORZEICHEN = "sunspec.model_203.w";
    private static final String SPANNUNG = "sunspec.model_203.phv";

    /** Der MS-06-Zeitstrahl: der Wechsel gilt um 10:40, eingetragen wurde er um 11:05 (§5.13). */
    private static final String WECHSEL = "2026-11-18T10:40:00+01:00";
    private static final String EINGETRAGEN = "2026-11-18T11:05:00+01:00";
    /** Der Zeitraum um den betroffenen Zeitpunkt — hier MUSS der Wechsel stehen (Abnahme). */
    private static final String WIRKUNG_VON = "2026-11-18T10:00:00+01:00";
    private static final String WIRKUNG_BIS = "2026-11-18T11:00:00+01:00";
    /** Der Zeitraum um den EINTRAG — dort steht er nur auf der anderen Achse. */
    private static final String EINTRAG_VON = "2026-11-18T11:00:00+01:00";
    private static final String EINTRAG_BIS = "2026-11-18T12:00:00+01:00";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer(
            "quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

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

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    // ---- Der Abfragen-Zähler (Muster MessstelleRegisterApiTest) -------------------------------

    /**
     * Zählt, WELCHE Anweisungen die App-Verbindung schickt — der Beleg für „eine Abfrage, keine
     * N+1“. Er hängt AUSSERHALB von {@code TenantAwareDataSource}: dessen
     * {@code set_config('app.tenant_id', …)} läuft auf der rohen Verbindung und wird nicht gezählt.
     */
    @TestConfiguration
    static class Zaehlwerk {

        @Bean
        static BeanPostProcessor abfragenZaehler() {
            return new BeanPostProcessor() {
                @Override
                public Object postProcessAfterInitialization(Object bean, String name) {
                    return "dataSource".equals(name) && bean instanceof DataSource ds
                            ? new ZaehlendeDataSource(ds) : bean;
                }
            };
        }
    }

    private static final List<String> ABFRAGEN = Collections.synchronizedList(new ArrayList<>());
    private static volatile boolean zaehlen;

    static class ZaehlendeDataSource extends DelegatingDataSource {

        ZaehlendeDataSource(DataSource ziel) {
            super(ziel);
        }

        @Override
        public Connection getConnection() throws SQLException {
            return verbindung(super.getConnection());
        }

        @Override
        public Connection getConnection(String benutzer, String kennwort) throws SQLException {
            return verbindung(super.getConnection(benutzer, kennwort));
        }
    }

    private static Connection verbindung(Connection c) {
        return (Connection) Proxy.newProxyInstance(AenderungsprotokollApiTest.class.getClassLoader(),
                new Class<?>[] {Connection.class}, new Handler(c, true));
    }

    /** Zählt beim Vorbereiten (PreparedStatement) bzw. beim Ausführen (Statement) genau einmal. */
    private record Handler(Object ziel, boolean verbindung) implements InvocationHandler {

        @Override
        public Object invoke(Object proxy, Method methode, Object[] args) throws Throwable {
            String name = methode.getName();
            String sql = args != null && args.length > 0 && args[0] instanceof String s ? s : null;
            if (zaehlen && sql != null
                    && (verbindung ? name.startsWith("prepare") : name.startsWith("execute"))) {
                ABFRAGEN.add(sql);
            }
            Object ergebnis;
            try {
                ergebnis = methode.invoke(ziel, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            }
            return verbindung && ergebnis instanceof Statement st && "createStatement".equals(name)
                    ? Proxy.newProxyInstance(AenderungsprotokollApiTest.class.getClassLoader(),
                            new Class<?>[] {Statement.class}, new Handler(st, false))
                    : ergebnis;
        }
    }

    private List<String> abfragen(Runnable was) {
        ABFRAGEN.clear();
        zaehlen = true;
        try {
            was.run();
        } finally {
            zaehlen = false;
        }
        return List.copyOf(ABFRAGEN);
    }

    // ---- Gerüst -------------------------------------------------------------------------------

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    MessstelleService messstellen;

    @Autowired
    MessstelleQuelleService quellen;

    @Autowired
    ZaehlerwechselService wechsel;

    @Autowired
    QuelleEinstellungService einstellungen;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Anrufer DEMO2 = new Anrufer("demo2", null);
    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);
    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

    private static JsonNode referenz;
    private static Map<String, Object> schemas;
    private static JdbcTemplate root;

    /** Ein Kundenbereich mit AN-1 des Referenzunternehmens: Box E-1, K-1 … K-7 und ihre Geräte. */
    private record Werk(UUID tenant, Anrufer admin, UUID an1, UUID box, Map<String, UUID> komponenten) {
        UUID k(String kennzeichen) {
            return komponenten.get(kennzeichen);
        }
    }

    @BeforeAll
    @SuppressWarnings("unchecked")
    static void ladeVertrag() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        try (InputStream in = Files.newInputStream(CONTRACTS.resolve("openapi.yaml"))) {
            Map<String, Object> openapi = new Yaml().load(in);
            schemas = (Map<String, Object>) ((Map<String, Object>) openapi.get("components")).get("schemas");
        }
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void uhrZurueck() {
        uhr(null);
    }

    // ---- Die ABNAHME: zwei Zeitachsen -------------------------------------------------------

    /**
     * DIE Abnahme von IP-21: der rückwirkende Wechsel erscheint im Zeitraum des BETROFFENEN
     * Zeitpunkts. Er gilt am 18.11. um 10:40 und wurde um 11:05 eingetragen — auf der Achse
     * „Wirkung“ (der Vorgabe) steht er also in 10:00–11:00 und NICHT in 11:00–12:00; auf der
     * Achse „Eintrag“ ist es genau umgekehrt. Beide Male genau EINMAL.
     */
    @Test
    void derRueckwirkendeWechselStehtImZeitraumDesBetroffenenZeitpunkts() {
        Werk w = ahrenberg("Abnahme Zeitachse");
        String ms06 = messstelleMs06(w);
        bindeMs06(w, ms06);
        zaehlerwechsel(w, ms06);

        JsonNode wirkung = protokollDerMessstelle(w, ms06, "?von=" + url(WIRKUNG_VON) + "&bis=" + url(WIRKUNG_BIS));
        assertThat(wirkung.get("achse").asText()).as("die Vorgabe steht in der ANTWORT").isEqualTo("wirkung");
        JsonNode eintrag = nurEins(wirkung, "zaehler_gewechselt");
        assertThat(eintrag.get("text").asText()).isEqualTo("Zähler gewechselt: Z-5a → Z-5b");
        assertThat(zeitpunkt(eintrag.get("gilt_ab"))).isEqualTo(zeitpunkt(WECHSEL));
        assertThat(zeitpunkt(eintrag.get("eingetragen_am"))).isEqualTo(zeitpunkt(EINGETRAGEN));
        assertThat(eintrag.get("zeitform").asText()).isEqualTo("rueckwirkend");
        assertThat(eintrag.at("/urheber/name").asText()).isEqualTo("admin");
        assertThat(eintrag.at("/urheber/art").asText()).isEqualTo("voltpilot");
        assertThat(eintrag.at("/bezug/art").asText()).isEqualTo("messstelle");
        assertThat(eintrag.at("/bezug/kennzeichen").asText()).isEqualTo("MS-06");
        assertThat(eintrag.get("grund").asText()).isEqualTo("Zähler defekt");

        // Auf DERSELBEN Achse im Zeitraum des Eintrags: nicht da (sonst stünde er doppelt).
        assertThat(arten(protokollDerMessstelle(w, ms06,
                "?von=" + url(EINTRAG_VON) + "&bis=" + url(EINTRAG_BIS))))
                .doesNotContain("zaehler_gewechselt");

        // Achse „Eintrag“: genau umgekehrt.
        JsonNode nachEintrag = protokollDerMessstelle(w, ms06,
                "?achse=eintrag&von=" + url(EINTRAG_VON) + "&bis=" + url(EINTRAG_BIS));
        assertThat(nachEintrag.get("achse").asText()).isEqualTo("eintrag");
        assertThat(nurEins(nachEintrag, "zaehler_gewechselt").get("zeitform").asText()).isEqualTo("rueckwirkend");
        assertThat(arten(protokollDerMessstelle(w, ms06,
                "?achse=eintrag&von=" + url(WIRKUNG_VON) + "&bis=" + url(WIRKUNG_BIS))))
                .doesNotContain("zaehler_gewechselt");

        // Ohne Zeitraum steht er selbstverständlich da — und die Antwort sagt „ohne Grenze“.
        JsonNode ganz = protokollDerMessstelle(w, ms06, "");
        assertThat(ganz.get("von").isNull()).isTrue();
        assertThat(ganz.get("bis").isNull()).isTrue();
        assertThat(ganz.get("weiter").isNull()).isTrue();
        nurEins(ganz, "zaehler_gewechselt");
    }

    /**
     * Die andere Hälfte derselben Regel: eine ANGEKÜNDIGTE Änderung gilt in der Zukunft. Sie
     * steht im Zeitraum, in dem sie GILT — nicht in dem, in dem sie eingetragen wurde; und
     * keiner der beiden Zeiträume zeigt sie zweimal.
     */
    @Test
    void eineAngekuendigteAenderungStehtDortWoSieGiltUndNichtDoppelt() {
        Werk w = ahrenberg("angekündigt");
        String ms06 = messstelleMs06(w);
        bindeMs06(w, ms06);
        UUID z5a = einbau(w, "Z-5a");

        // Am 17.11. um 09:00 wird der Wechsel für den 18.11. um 10:40 angekündigt.
        String angekuendigtAm = "2026-11-17T09:00:00+01:00";
        uhr(angekuendigtAm);
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(),
                wechselAnfrage(WECHSEL, z5b())));

        JsonNode giltDann = protokollDerMessstelle(w, ms06, "?von=" + url(WIRKUNG_VON) + "&bis=" + url(WIRKUNG_BIS));
        JsonNode e = nurEins(giltDann, "zaehler_gewechselt");
        assertThat(e.get("zeitform").asText()).isEqualTo("angekuendigt");
        assertThat(zeitpunkt(e.get("gilt_ab"))).isEqualTo(zeitpunkt(WECHSEL));
        assertThat(zeitpunkt(e.get("eingetragen_am"))).isEqualTo(zeitpunkt(angekuendigtAm));

        // Im Zeitraum des EINTRAGS steht er auf der Wirkungs-Achse nicht.
        assertThat(arten(protokollDerMessstelle(w, ms06,
                "?von=2026-11-17T08:00:00%2B01:00&bis=2026-11-17T10:00:00%2B01:00")))
                .doesNotContain("zaehler_gewechselt");
        // Auf der Eintrags-Achse genau dort — und genau einmal.
        nurEins(protokollDerMessstelle(w, ms06,
                "?achse=eintrag&von=2026-11-17T08:00:00%2B01:00&bis=2026-11-17T10:00:00%2B01:00"),
                "zaehler_gewechselt");
    }

    // ---- Je Eintragsart eine Zeile ------------------------------------------------------------

    /**
     * Der Lebenszyklus einer Messstelle, ihre Quellenbindung, ihre Einstellung und ihr
     * Zählerwechsel — jede Art mit ihrem Wortlaut, jüngster Eintrag zuerst. (Die VOLLSTÄNDIGE
     * Liste aller Arten der drei Journale prüft der reine {@code AenderungSatzTest}; hier steht
     * der Beweis, dass die echten Schreibwege genau diese Formen schreiben.)
     */
    @Test
    void jedeEintragsartHatIhreZeileMitGepruefterSprache() {
        Werk w = ahrenberg("Eintragsarten");
        String ms06 = messstelleMs06(w);
        bindeMs06(w, ms06);

        uhr("2026-11-10T08:00:00+01:00");
        JsonNode ms = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms06, w.admin(), null));
        Map<String, Object> bearbeiten = new LinkedHashMap<>();
        bearbeiten.put("kennzeichen", ms.get("kennzeichen").asText());
        bearbeiten.put("name", "Hauptzähler Werk Nord");
        ok(rufe(HttpMethod.PUT, "/api/v1/messstellen/" + ms06, w.admin(), bearbeiten));

        uhr("2026-11-11T08:00:00+01:00");
        ok(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/anhalten", w.admin(), null));
        uhr("2026-11-12T08:00:00+01:00");
        ok(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/fortsetzen", w.admin(), null));

        uhr("2026-11-13T08:00:00+01:00");
        ObjectNode wandler = MAPPER.createObjectNode();
        wandler.put("art", "wandler_strom");
        wandler.set("wert", MAPPER.createObjectNode().put("primaer_a", 150).put("sekundaer_a", 5));
        wandler.put("anwendung", "dokumentiert");
        wandler.put("gueltig_ab", "2026-11-13T08:00:00+01:00");
        assertThat(status(rufe(HttpMethod.POST, "/api/v1/geraete/" + einbau(w, "Z-5a") + "/einstellungen",
                w.admin(), wandler))).isEqualTo(201);

        zaehlerwechsel(w, ms06);

        Map<String, String> texte = new LinkedHashMap<>();
        for (JsonNode e : protokollDerMessstelle(w, ms06, "").get("eintraege")) {
            texte.putIfAbsent(e.get("art").asText(), e.get("text").asText());
        }
        assertThat(texte).containsEntry("angelegt", "Messstelle angelegt: "
                + referenzMessstelle("MS-06").get("name").asText());
        assertThat(texte).containsEntry("bearbeitet", "Messstelle bearbeitet: Name „"
                + referenzMessstelle("MS-06").get("name").asText() + "“ → „Hauptzähler Werk Nord“");
        assertThat(texte).containsEntry("angehalten", "Messstelle angehalten");
        assertThat(texte).containsEntry("fortgesetzt", "Messstelle fortgesetzt");
        assertThat(texte).containsEntry("quelle_gebunden", "Quelle gebunden: Z-5a · Wirkenergie · Bezug (führend)");
        assertThat(texte).containsEntry("einstellung_geaendert", "Einstellung geändert: 150/5 A (Z-5a)");
        assertThat(texte).containsEntry("zaehler_gewechselt", "Zähler gewechselt: Z-5a → Z-5b");

        // Jüngster Eintrag zuerst — und JEDE Zeile trägt beide Zeitpunkte und ihren Urheber.
        List<Instant> zeiten = new ArrayList<>();
        for (JsonNode e : protokollDerMessstelle(w, ms06, "").get("eintraege")) {
            zeiten.add(zeitpunkt(e.get("gilt_ab")));
            assertThat(e.get("eingetragen_am").isNull()).isFalse();
            assertThat(e.at("/urheber/name").asText()).isNotBlank();
            assertThat(e.get("zeitform").asText()).isIn("rueckwirkend", "angekuendigt", "sofort");
            assertThat(e.get("id").asText()).startsWith("messstelle:");
        }
        assertThat(zeiten).isSortedAccordingTo(java.util.Comparator.reverseOrder());
    }

    // ---- Der Weg JE GERÄT ---------------------------------------------------------------------

    /**
     * Ein Gerät hat kein eigenes Journal: seine Einträge hängen an den Messstellen, die es
     * speist. Der Wechsel nennt beide Geräte und steht deshalb in BEIDEN Protokollen — beim
     * ausgebauten Z-5a und beim eingebauten Z-5b; die Einstellung nur bei Z-5a.
     */
    @Test
    void derWegJeGeraetZeigtBindungenEinstellungenUndBeideSeitenDesWechsels() {
        Werk w = ahrenberg("je Gerät");
        String ms06 = messstelleMs06(w);
        bindeMs06(w, ms06);
        UUID z5a = einbau(w, "Z-5a");

        uhr("2026-11-13T08:00:00+01:00");
        ObjectNode wandler = MAPPER.createObjectNode();
        wandler.put("art", "wandler_strom");
        wandler.set("wert", MAPPER.createObjectNode().put("primaer_a", 150).put("sekundaer_a", 5));
        wandler.put("anwendung", "dokumentiert");
        wandler.put("gueltig_ab", "2026-11-13T08:00:00+01:00");
        assertThat(status(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/einstellungen", w.admin(), wandler)))
                .isEqualTo(201);

        zaehlerwechsel(w, ms06);
        UUID z5b = einbau(w, "Z-5b");

        List<String> alt = arten(protokollDesGeraets(w, z5a, ""));
        assertThat(alt).contains("quelle_gebunden", "einstellung_geaendert", "zaehler_gewechselt");
        List<String> neu = arten(protokollDesGeraets(w, z5b, ""));
        assertThat(neu).as("der Wechsel steht auch beim eingebauten Gerät").contains("zaehler_gewechselt");
        assertThat(neu).as("die Einstellung gehört dem alten Gerät").doesNotContain("einstellung_geaendert");

        // Auch hier trägt die Achse: der rückwirkende Wechsel steht im Zeitraum seiner WIRKUNG.
        assertThat(arten(protokollDesGeraets(w, z5b, "?von=" + url(WIRKUNG_VON) + "&bis=" + url(WIRKUNG_BIS))))
                .containsExactly("zaehler_gewechselt");
    }

    // ---- Der UNTERNEHMENS-Weg -----------------------------------------------------------------

    /**
     * Der Unternehmens-Weg führt die drei Journale zusammen (Messstellen, Ortsstruktur,
     * Datenquellen) und seitet stabil: mit {@code limit=1} durchgeblättert kommt JEDER Eintrag
     * genau einmal — auch die drei, die auf die Sekunde dasselbe „gilt ab“ tragen.
     */
    @Test
    void derUnternehmensWegFuehrtDieDreiJournaleZusammenUndSeitetStabil() {
        Werk w = ahrenberg("Unternehmen");
        String ms06 = messstelleMs06(w);
        bindeMs06(w, ms06);
        zaehlerwechsel(w, ms06);
        dieNachbarJournale(w);

        JsonNode alles = protokollDesUnternehmens(w, "?limit=500");
        List<String> quellen = new ArrayList<>();
        for (JsonNode e : alles.get("eintraege")) {
            quellen.add(e.get("quelle").asText());
        }
        assertThat(quellen).as(alles.toString()).contains("messstelle", "ort", "datenquelle");

        // Die Namen der Bezugsobjekte kommen MIT — auch über die Journal-Grenzen.
        Map<String, JsonNode> jeQuelle = new LinkedHashMap<>();
        for (JsonNode e : alles.get("eintraege")) {
            jeQuelle.putIfAbsent(e.get("quelle").asText(), e);
        }
        assertThat(jeQuelle.get("ort").at("/bezug/art").asText()).isEqualTo("anlage");
        assertThat(jeQuelle.get("ort").at("/bezug/name").asText()).isEqualTo(anlagenName());
        assertThat(jeQuelle.get("ort").at("/urheber/rolle").isNull())
                .as("das Orts-Journal hält keine Rolle fest — sie wird nicht geraten").isTrue();
        assertThat(jeQuelle.get("datenquelle").at("/bezug/kennzeichen").asText()).isEqualTo("DQ-9");
        assertThat(jeQuelle.get("datenquelle").at("/bezug/name").asText()).isEqualTo("WAGO Halle 2");

        // Seitenweise mit limit=1: jeder Eintrag genau einmal, in genau derselben Reihenfolge.
        List<String> ganz = idsVon(alles);
        List<String> geblaettert = new ArrayList<>();
        String nach = null;
        for (int i = 0; i < ganz.size() + 5; i++) {
            JsonNode seite = protokollDesUnternehmens(w, "?limit=1" + (nach == null ? "" : "&nach=" + nach));
            geblaettert.addAll(idsVon(seite));
            nach = seite.get("weiter").isNull() ? null : seite.get("weiter").asText();
            if (nach == null) {
                break;
            }
        }
        assertThat(geblaettert).as("kein Sprung, keine Wiederholung").containsExactlyElementsOf(ganz);
        assertThat(geblaettert).doesNotHaveDuplicates();

        // Der Zeitraum wirkt auch hier auf der gewählten Achse.
        assertThat(arten(protokollDesUnternehmens(w, "?von=" + url(WIRKUNG_VON) + "&bis=" + url(WIRKUNG_BIS))))
                .contains("zaehler_gewechselt");
        assertThat(arten(protokollDesUnternehmens(w,
                "?achse=eintrag&von=" + url(WIRKUNG_VON) + "&bis=" + url(WIRKUNG_BIS))))
                .doesNotContain("zaehler_gewechselt");
    }

    /** Gleiche Zeitstempel: drei Einträge derselben Sekunde bleiben in derselben Reihenfolge. */
    @Test
    void gleicheZeitstempelSpringenNicht() {
        Werk w = ahrenberg("gleiche Zeit");
        String ms06 = messstelleMs06(w);
        Instant gleich = zeitpunkt("2026-11-05T12:00:00+01:00");
        for (int i = 0; i < 5; i++) {
            root.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, neu, gilt_ab, "
                    + "rueckwirkend, actor_name, actor_art, created_at) VALUES (?, ?, 'bearbeitet', "
                    + "?::jsonb, ?, false, 'test', 'voltpilot', ?)", w.tenant(), UUID.fromString(ms06),
                    "{\"name\": \"Runde " + i + "\"}", Timestamp.from(gleich), Timestamp.from(gleich));
        }
        List<String> ganz = idsVon(protokollDesUnternehmens(w, "?limit=500"));
        List<String> geblaettert = new ArrayList<>();
        String nach = null;
        for (int i = 0; i < ganz.size() + 5; i++) {
            JsonNode seite = protokollDesUnternehmens(w, "?limit=2" + (nach == null ? "" : "&nach=" + nach));
            geblaettert.addAll(idsVon(seite));
            nach = seite.get("weiter").isNull() ? null : seite.get("weiter").asText();
            if (nach == null) {
                break;
            }
        }
        assertThat(geblaettert).containsExactlyElementsOf(ganz);
    }

    // ---- Mandantenzaun ------------------------------------------------------------------------

    /** Fremd ist 404, nie 403 — und die Nachbar-Messstelle steht in keinem eigenen Protokoll. */
    @Test
    void fremdIst404NieB403() {
        Werk w = ahrenberg("Zaun A");
        String ms06 = messstelleMs06(w);
        bindeMs06(w, ms06);
        UUID z5a = einbau(w, "Z-5a");

        assertThat(status(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms06 + "/aenderungen", DEMO2, null)))
                .isEqualTo(404);
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/geraete/" + z5a + "/aenderungen", DEMO2, null)))
                .isEqualTo(404);
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms06 + "/aenderungen",
                ADMIN_OHNE_KUNDENBEREICH, null))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/messstellen/" + UUID.randomUUID() + "/aenderungen",
                w.admin(), null))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms06 + "/aenderungen", null, null)))
                .isEqualTo(401);

        // Der Nachbar sieht sein eigenes Protokoll — und darin nichts von uns.
        JsonNode nachbar = ok(rufe(HttpMethod.GET, "/api/v1/unternehmen/aenderungen", DEMO2, null));
        for (JsonNode e : nachbar.get("eintraege")) {
            assertThat(e.at("/bezug/id").asText()).isNotEqualTo(ms06);
        }
    }

    /** Die Anfrage wird streng gelesen: jede Ablehnung nennt ihr Feld, nie eine stille Vorgabe. */
    @Test
    void dieAnfrageWirdStrengGelesenUndDieAntwortTraegtDieFelderDerOpenApi() {
        Werk w = ahrenberg("Anfrage");
        String ms06 = messstelleMs06(w);
        String pfad = "/api/v1/messstellen/" + ms06 + "/aenderungen";
        anfrage(rufe(HttpMethod.GET, pfad + "?achse=irgendwas", w.admin(), null), "achse");
        anfrage(rufe(HttpMethod.GET, pfad + "?von=gestern", w.admin(), null), "von");
        anfrage(rufe(HttpMethod.GET, pfad + "?bis=uebermorgen", w.admin(), null), "bis");
        anfrage(rufe(HttpMethod.GET, pfad + "?limit=0", w.admin(), null), "limit");
        anfrage(rufe(HttpMethod.GET, pfad + "?limit=501", w.admin(), null), "limit");
        anfrage(rufe(HttpMethod.GET, pfad + "?nach=kaputt", w.admin(), null), "nach");
        anfrage(rufe(HttpMethod.GET, pfad + "?von=" + url(WIRKUNG_BIS) + "&bis=" + url(WIRKUNG_VON),
                w.admin(), null), "bis");

        JsonNode antwort = ok(rufe(HttpMethod.GET, pfad, w.admin(), null));
        assertThat(felder(antwort)).containsExactlyInAnyOrderElementsOf(eigenschaften("Protokoll"));
        assertThat(felder(antwort.at("/eintraege/0"))).containsExactlyInAnyOrderElementsOf(
                eigenschaften("ProtokollEintrag"));
        assertThat(felder(antwort.at("/eintraege/0/bezug"))).containsExactlyInAnyOrderElementsOf(
                eigenschaften("ProtokollBezug"));
        assertThat(felder(antwort.at("/eintraege/0/urheber"))).containsExactlyInAnyOrderElementsOf(
                eigenschaften("ProtokollUrheber"));
    }

    // ---- Laufzeit -----------------------------------------------------------------------------

    /**
     * Der Laufzeit-Nachweis (wie IP-4/IP-15): der Unternehmens-Weg über 200 Einträge kostet
     * GENAU EINE Abfrage auf den Journalen und insgesamt so viele Abfragen wie EIN Eintrag —
     * keine N+1 —, und die Antwort ist in weniger als 300 ms da.
     */
    @Test
    void zweihundertEintraegeKostenEineAbfrageUndBleibenUnter300ms() {
        Werk klein = ahrenberg("Laufzeit 1");
        messstelleMs06(klein);
        Werk gross = ahrenberg("Laufzeit 200");
        String ms = messstelleMs06(gross);
        Instant t = zeitpunkt("2026-11-01T00:00:00+01:00");
        for (int i = 0; i < 200; i++) {
            root.update("INSERT INTO messstelle_aenderung (tenant_id, messstelle_id, art, neu, gilt_ab, "
                    + "rueckwirkend, actor_name, actor_art, created_at) VALUES (?, ?, 'bearbeitet', "
                    + "?::jsonb, ?, false, 'test', 'voltpilot', ?)", gross.tenant(), UUID.fromString(ms),
                    "{\"name\": \"Runde " + i + "\"}", Timestamp.from(t.plusSeconds(i)),
                    Timestamp.from(t.plusSeconds(i)));
        }

        protokollDesUnternehmens(gross, "?limit=500");
        List<String> wenige = abfragen(() -> protokollDesUnternehmens(klein, "?limit=500"));
        List<String> viele = abfragen(() -> protokollDesUnternehmens(gross, "?limit=500"));
        assertThat(viele.stream().filter(s -> s.contains("messstelle_aenderung")).toList())
                .as(String.join("\n", viele)).hasSize(1);
        assertThat(viele).as("keine N+1: dieselbe Zahl wie bei einem Eintrag").hasSameSizeAs(wenige);
        assertThat(viele).as("die EINE Abfrage — mehr braucht der ganze Weg nicht").hasSize(1);

        long start = System.nanoTime();
        JsonNode antwort = protokollDesUnternehmens(gross, "?limit=500");
        long ms200 = (System.nanoTime() - start) / 1_000_000;
        assertThat(antwort.get("eintraege")).hasSizeGreaterThanOrEqualTo(200);
        assertThat(ms200).as("Laufzeit " + ms200 + " ms").isLessThan(300);
    }

    // ---- Gerüst: das Referenzunternehmen ------------------------------------------------------

    /** Ein Kundenbereich mit AN-1, Box E-1 und den Komponenten K-1 … K-7 (wie ZaehlerwechselApiTest). */
    private Werk ahrenberg(String zusatz) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                referenz.at("/unternehmen/name").asText() + " · " + zusatz);
        JsonNode anlage = element(referenz.get("anlagen"), "AN-1");
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) RETURNING id",
                UUID.class, t, anlage.get("name").asText(), ts(anlage.get("seit")));
        JsonNode e1 = element(referenz.get("boxen"), "E-1");
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, created_at) "
                + "VALUES (?, ?, ?, ?) RETURNING id", UUID.class, t, an1, e1.get("seriennummer").asText() + "-" + t,
                ts(e1.get("in_betrieb_ab")));
        Map<String, UUID> komponenten = new LinkedHashMap<>();
        for (String k : List.of("K-1", "K-3", "K-4", "K-5", "K-6", "K-7")) {
            JsonNode komponente = element(referenz.get("komponenten"), k);
            JsonNode geraet = element(referenz.get("geraete"), komponente.get("geraet").asText());
            JsonNode quelle = element(referenz.get("datenquellen"), geraet.get("datenquelle").asText());
            ObjectNode verbindung = MAPPER.createObjectNode().put("ip", quelle.get("adresse").asText())
                    .put("port", quelle.get("port").asInt()).put("unit_id", geraet.get("modbus_geraete_id").asInt());
            String art = "K-1".equals(k) ? "battery-hybrid" : "K-3".equals(k) ? "grid-meter" : "modbus-generic";
            komponenten.put(k, root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                    + "entity_type, device_id, control, communication, connection_json, created_at) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?) RETURNING id", UUID.class, t, an1, art,
                    komponente.get("name").asText(), art, box, "battery-hybrid".equals(art),
                    "K-1".equals(k) ? "sunspec_tcp" : "modbus_tcp", verbindung.toString(),
                    ts(komponente.get("in_betrieb_ab"))));
        }
        JsonNode z5a = element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5a");
        root.update("UPDATE geraet SET einbau_kennzeichen = ?, seriennummer = ? WHERE tenant_id = ? "
                + "AND kennzeichen = 'GR-4'", z5a.get("kennzeichen").asText(),
                z5a.get("seriennummer").asText(), t);
        Werk w = new Werk(t, new Anrufer("admin", t), an1, box, komponenten);
        for (String kanal : List.of(ENERGIE_BEZUG, ENERGIE_ABGABE, LEISTUNG_VORZEICHEN, SPANNUNG)) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                    + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                    + "apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), "
                    + "'2026.08.26.3', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute') "
                    + "ON CONFLICT DO NOTHING", t, an1, box, w.k("K-5"), kanal);
        }
        return w;
    }

    /**
     * Die beiden NACHBAR-Journale — je ein Eintrag, den der Unternehmens-Weg mitführen muss.
     *
     * <p>Sie werden hier unmittelbar eingetragen (nicht über ihre Schreibwege): IP-21 ist ein
     * LESEPAKET, und die Schreibwege haben ihre eigenen Tests. Geprüft wird hier, dass das
     * Lesemodell ihre Spalten richtig überbrückt — der Tag „gilt ab“ der Ortsstruktur, ihr
     * Urheber ohne Rolle, das abgeleitete „rückwirkend“ der Datenquelle.
     */
    private void dieNachbarJournale(Werk w) {
        root.update("INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, neu, gilt_ab, "
                + "rueckwirkend, akteur_sub, akteur_name) VALUES (?, 'anlage', ?, 'angelegt', ?::jsonb, "
                + "DATE '2026-11-16', false, NULL, 'VoltPilot (Bestandsübernahme)')",
                w.tenant(), w.an1(), "{\"name\": \"" + anlagenName() + "\"}");
        UUID quelle = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, name, "
                + "protokoll, adresse, kadenz_s) VALUES (?, ?, 'DQ-9', 'WAGO Halle 2', 'modbus_tcp', "
                + "'10.20.3.7:502', 60) RETURNING id", UUID.class, w.tenant(), w.an1());
        root.update("INSERT INTO data_source_aenderung (tenant_id, data_source_id, art, neu, gilt_ab, "
                + "actor_sub, actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, 'angelegt', "
                + "?::jsonb, ?, 'sub-1', 'Ines Kaltenbach', 'kundenadministrator', 'kunde', ?)",
                w.tenant(), quelle, "{\"name\": \"WAGO Halle 2\"}",
                Timestamp.from(zeitpunkt("2026-11-17T14:00:00+01:00")),
                Timestamp.from(zeitpunkt("2026-11-17T14:00:00+01:00")));
    }

    private static String anlagenName() {
        return element(referenz.get("anlagen"), "AN-1").get("name").asText();
    }

    /** MS-06 wie die Referenzdatei; die Messstelle wird am 01.10.2026 um 09:12 angelegt. */
    private String messstelleMs06(Werk w) {
        uhr("2026-10-01T09:12:00+02:00");
        JsonNode ms = referenzMessstelle("MS-06");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", "MS-06");
        body.put("name", ms.get("name").asText());
        body.put("art", ms.get("art").asText());
        body.put("medium", ms.get("medium").asText());
        ObjectNode g = MAPPER.createObjectNode();
        for (String f : List.of("groesse", "richtung", "einheit", "wertart")) {
            g.put(f, ms.at("/hauptgroesse/" + f).asText());
        }
        body.put("hauptgroesse", g);
        body.put("nebengroessen", List.of());
        return erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen", w.admin(), body)).get("id").asText();
    }

    /** Die führende Quelle von MS-06 ab Beginn ihres Verlaufs (rückwirkend eingetragen). */
    private void bindeMs06(Werk w, String messstelle) {
        uhr("2026-10-01T09:14:00+02:00");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("komponente", w.k("K-5").toString());
        body.put("kanal", ENERGIE_BEZUG);
        body.put("rolle", "fuehrend");
        body.put("gueltig_ab", referenzMessstelle("MS-06").at("/fuehrende_quelle/0/gueltig_ab").asText());
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + messstelle + "/quellen", w.admin(), body));
    }

    /** Der Wechsel des Zeitstrahls: gilt 10:40, eingetragen 11:05 — also rückwirkend. */
    private void zaehlerwechsel(Werk w, String messstelle) {
        uhr(EINGETRAGEN);
        Map<String, Object> anfrage = wechselAnfrage(WECHSEL, z5b());
        anfrage.put("grund", "Zähler defekt");
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + messstelle + "/quellen/wechsel",
                w.admin(), anfrage));
    }

    private static JsonNode z5b() {
        return element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5b");
    }

    private static Map<String, Object> wechselAnfrage(String zeitpunkt, JsonNode neuerEinbau) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("zeitpunkt", zeitpunkt);
        Map<String, Object> geraet = new LinkedHashMap<>();
        geraet.put("einbau_kennzeichen", neuerEinbau.get("kennzeichen").asText());
        geraet.put("seriennummer", neuerEinbau.get("seriennummer").asText());
        body.put("neues_geraet", geraet);
        return body;
    }

    private static UUID einbau(Werk w, String kennzeichen) {
        return root.queryForObject("SELECT id FROM geraet WHERE tenant_id = ? AND einbau_kennzeichen = ?",
                UUID.class, w.tenant(), kennzeichen);
    }

    private void uhr(String zeitpunkt) {
        Clock c = zeitpunkt == null ? Clock.systemUTC() : Clock.fixed(zeitpunkt(zeitpunkt), BERLIN);
        messstellen.uhrStellen(c);
        quellen.uhrStellen(c);
        wechsel.uhrStellen(c);
        einstellungen.uhrStellen(c);
    }

    // ---- Gerüst: die drei Lesewege ------------------------------------------------------------

    private JsonNode protokollDerMessstelle(Werk w, String id, String frage) {
        return ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + id + "/aenderungen" + frage, w.admin(), null));
    }

    private JsonNode protokollDesGeraets(Werk w, UUID id, String frage) {
        return ok(rufe(HttpMethod.GET, "/api/v1/geraete/" + id + "/aenderungen" + frage, w.admin(), null));
    }

    private JsonNode protokollDesUnternehmens(Werk w, String frage) {
        return ok(rufe(HttpMethod.GET, "/api/v1/unternehmen/aenderungen" + frage, w.admin(), null));
    }

    /** GENAU EIN Eintrag dieser Art — die Probe darauf, dass nichts doppelt steht. */
    private static JsonNode nurEins(JsonNode protokoll, String art) {
        List<JsonNode> treffer = new ArrayList<>();
        for (JsonNode e : protokoll.get("eintraege")) {
            if (art.equals(e.get("art").asText())) {
                treffer.add(e);
            }
        }
        assertThat(treffer).as(art + " in " + protokoll).hasSize(1);
        return treffer.get(0);
    }

    private static List<String> arten(JsonNode protokoll) {
        List<String> out = new ArrayList<>();
        for (JsonNode e : protokoll.get("eintraege")) {
            out.add(e.get("art").asText());
        }
        return out;
    }

    private static List<String> idsVon(JsonNode protokoll) {
        List<String> out = new ArrayList<>();
        for (JsonNode e : protokoll.get("eintraege")) {
            out.add(e.get("id").asText());
        }
        return out;
    }

    /** Das „+“ eines Zeitpunkts gehört in einer Abfrage URL-kodiert. */
    private static String url(String zeitpunkt) {
        return zeitpunkt.replace("+", "%2B");
    }

    // ---- Gerüst: HTTP -------------------------------------------------------------------------

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer, Object body) {
        HttpHeaders headers = new HttpHeaders();
        if (wer != null) {
            headers.setBearerAuth(token(wer.benutzer()));
            if (wer.kundenbereich() != null) {
                headers.set("X-Tenant-Id", wer.kundenbereich().toString());
            }
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return rest.exchange(java.net.URI.create("http://localhost:" + port + pfad), methode, entity,
                JsonNode.class);
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        return r.getBody();
    }

    private static JsonNode erfolgreich(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return r.getBody();
    }

    private static int status(ResponseEntity<JsonNode> r) {
        return r.getStatusCode().value();
    }

    private static void anfrage(ResponseEntity<JsonNode> r, String feld) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(400);
        assertThat(r.getBody().get("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(r.getBody().get("message").asText()).isNotBlank();
        assertThat(r.getBody().get("feld").asText()).isEqualTo(feld);
    }

    private String token(String benutzer) {
        Token t = TOKENS.get(benutzer);
        if (t != null && System.currentTimeMillis() - t.geholt() < 5 * 60_000) {
            return t.wert();
        }
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", benutzer);
        form.add("password", benutzer);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        String wert = (String) body.get("access_token");
        TOKENS.put(benutzer, new Token(wert, System.currentTimeMillis()));
        return wert;
    }

    // ---- Gerüst: Vertrag ----------------------------------------------------------------------

    private static JsonNode referenzMessstelle(String kennzeichen) {
        return element(referenz.get("messstellen"), kennzeichen);
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.get("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }

    private static Timestamp ts(JsonNode n) {
        return Timestamp.from(OffsetDateTime.parse(n.asText()).toInstant());
    }

    private static Instant zeitpunkt(JsonNode n) {
        return zeitpunkt(n.asText());
    }

    private static Instant zeitpunkt(String s) {
        return OffsetDateTime.parse(s).toInstant();
    }

    @SuppressWarnings("unchecked")
    private static List<String> eigenschaften(String name) {
        Map<String, Object> s = (Map<String, Object>) schemas.get(name);
        assertThat(s).as(name).isNotNull();
        return new ArrayList<>(((Map<String, Object>) s.get("properties")).keySet());
    }

    private static List<String> felder(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.fieldNames().forEachRemaining(out::add);
        return out;
    }
}
