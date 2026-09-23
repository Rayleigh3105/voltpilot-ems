package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import javax.sql.DataSource;
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

/**
 * Das Messstellen-Register (UEMS AP-04 IP-4): {@code GET /api/v1/messstellen} mit Stichtag und
 * Filtern, gegen das Soll-Bild des Berichts (§5.16, die 21 Zeilen des Werks Ahrenberg) und die
 * Abnahme A17 („Stand am“ vor und nach dem Zählerwechsel).
 *
 * <p>Geprüft wird:
 * <ul>
 *   <li>jede Zeile trägt Ort (mit abgeleitetem Standort), elektrische Stellung, Quelle der
 *       Hauptgröße (Gerät · Messwert · seit, bei MS-06 „davor Z-5a“) und den Lebenszyklus —
 *       genau die Werte der Vektor-Datei {@code uems-referenzunternehmen.json};</li>
 *   <li><b>A17</b>: {@code stichtag=2026-11-15} nennt Z-5a seit 12.03.2024,
 *       {@code stichtag=2026-11-20} Z-5b seit 18.11.2026 10:40; Ort und Stellung sind in beiden
 *       gleich;</li>
 *   <li>jeder Filter: Standort, Ort (mit Teilbaum), Anlage, Zustand, „ohne Quelle“ (findet MS-21,
 *       nicht die berechneten) — und dass sie sich kombinieren;</li>
 *   <li>die Platzhalter: Beobachtung und letzter Wert sind IMMER {@code null} (IP-15), eine
 *       berechnete Messstelle sagt {@code berechnet} statt einer Quelle (AP-10),
 *       {@code teilansicht} ist {@code false} (AP-03);</li>
 *   <li><b>EINE Abfrage</b>: 100 Messstellen mit Ort, Stellung und Quelle kosten genau EINE
 *       Abfrage auf den Messstellen-Tabellen und insgesamt dieselbe Zahl an Abfragen wie EINE
 *       Messstelle (keine N+1) — unter 300 ms; die Kadenz-Fassungen (AP-07 IP-10) kommen als EIN
 *       weiterer Zug dazu, nie je Zeile;</li>
 *   <li>der Mandantenzaun: ein fremder Kundenbereich sieht nichts, ein fremder Filterwert findet
 *       nichts (leer, nie 403); die Form der Anfrage ist streng (400);</li>
 *   <li>Liste und Einzelabruf sagen dasselbe: {@code messstellen[i]} ist {@code GET …/{id}}.</li>
 * </ul>
 * Den Zählerwechsel am Gerät schreibt die Datenbank von Hand, so wie ihn IP-17 schreiben wird.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class MessstelleRegisterApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    /** Der Tag, an dem der Bericht das Register zeigt (§5.16: nach dem Zählerwechsel). */
    private static final String NACH_DEM_WECHSEL = "2026-11-20";
    private static final String VOR_DEM_WECHSEL = "2026-11-15";
    /** Der Tag, an dem die Zuordnungen eingetragen werden (wie MessstelleZuordnungApiTest). */
    private static final String EINFUEHRUNG = "2026-10-01T09:12:00+02:00";

    /** Die Messwerte, aus denen die Hauptgrößen gelesen werden — Punkte des Messpunkt-Katalogs. */
    private static final String ENERGIE_BEZUG = "sunspec.model_203.totwhimp";
    private static final String ENERGIE_ABGABE = "sunspec.model_203.totwhexp";
    private static final String ERZEUGUNG = "sunspec.model_103.wh";
    private static final String SPEICHERLEISTUNG = "deye.hybrid_3p.battery.battery-power";

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

    // ---- Der Abfragen-Zähler ------------------------------------------------------------------

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
        return (Connection) Proxy.newProxyInstance(MessstelleRegisterApiTest.class.getClassLoader(),
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
                    ? Proxy.newProxyInstance(MessstelleRegisterApiTest.class.getClassLoader(),
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
    StandortService standortService;

    @Autowired
    MessstelleZuordnungService zuordnungService;

    @Autowired
    MessstelleQuelleService quellenService;

    private static JsonNode referenz;
    private static JdbcTemplate root;
    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();
    /** Das über die Schnittstelle gebaute Referenzunternehmen — einmal, für alle lesenden Tests. */
    private static Ahrenberg ahrenberg;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Anrufer DEMO2 = new Anrufer("demo2", null);
    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);

    /** Das gebaute Referenzunternehmen: Kundenbereich, IDs je Kennzeichen und das Gerät je Komponente. */
    private record Ahrenberg(UUID tenant, Map<String, UUID> standorte, Map<String, UUID> anlagen,
            Map<String, String> messstellen, Map<String, UUID> komponenten, Map<String, String[]> geraete) {

        Anrufer wer() {
            return new Anrufer("admin", tenant);
        }
    }

    @BeforeAll
    static void ladeVertrag() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    // ---- §5.16: das Soll-Bild ------------------------------------------------------------------

    /**
     * Das Register am 20.11.2026 (§5.16, Stand nach dem Zählerwechsel): 21 Zeilen nach Kennzeichen,
     * jede mit Ort, abgeleitetem Standort, Stellung, Quelle und Zustand der Vektor-Datei. Beobachtung
     * und letzter Wert fehlen ehrlich (IP-15), die berechneten sagen „berechnet“ (AP-10), MS-21 sagt
     * „keine Datenquelle“ (E8).
     */
    @Test
    void dasRegisterZeigtDasWerkAhrenbergWieDerBericht() {
        Ahrenberg ah = ahrenberg();
        JsonNode antwort = register(ah.wer(), "?stichtag=" + NACH_DEM_WECHSEL);

        assertThat(antwort.get("stichtag").asText()).isEqualTo(NACH_DEM_WECHSEL);
        assertThat(antwort.get("zeitpunkt").asText()).isEqualTo("2026-11-20T00:00:00+01:00");
        assertThat(antwort.get("teilansicht").asBoolean()).isFalse();
        List<String> kennzeichen = new ArrayList<>();
        referenz.get("messstellen").forEach(m -> kennzeichen.add(m.get("kennzeichen").asText()));
        assertThat(kennzeichen(antwort)).containsExactlyElementsOf(kennzeichen.stream().sorted().toList());
        // Beide Listen nennen dieselben Messstellen in derselben Reihenfolge.
        List<String> voll = new ArrayList<>();
        antwort.get("messstellen").forEach(m -> voll.add(m.get("kennzeichen").asText()));
        assertThat(voll).containsExactlyElementsOf(kennzeichen(antwort));

        LocalDate tag = LocalDate.parse(NACH_DEM_WECHSEL);
        for (JsonNode soll : referenz.get("messstellen")) {
            String kz = soll.get("kennzeichen").asText();
            JsonNode zeile = zeile(antwort, kz);
            assertThat(zeile.get("name").asText()).as(kz).isEqualTo(soll.get("name").asText());
            assertThat(zeile.get("art").asText()).as(kz).isEqualTo(soll.get("art").asText());
            assertThat(zeile.get("medium").asText()).as(kz).isEqualTo(soll.get("medium").asText());
            assertThat(zeile.at("/hauptgroesse/groesse").asText()).as(kz)
                    .isEqualTo(soll.at("/hauptgroesse/groesse").asText());

            // Ort und abgeleiteter Standort (AP-02 IP-3).
            String ortKz = ortAm(kz, tag);
            JsonNode ort = zeile.get("ort");
            assertThat(text(ort.get("kennzeichen"))).as(kz + " Ort").isEqualTo(ortKz);
            assertThat(text(ort.get("standort"))).as(kz + " Standort").isEqualTo(standortVon(ortKz));
            assertThat(text(ort.get("grund"))).as(kz + " Grund").isEqualTo(ortKz == null ? "nicht_verortet"
                    : "U".equals(ortKz) ? "am_unternehmen" : "verortet");
            if (ortKz != null && !"U".equals(ortKz)) {
                assertThat(ort.get("name").asText()).as(kz + " Ortsname").isEqualTo(ortName(ortKz));
                assertThat(ort.get("standort_id").asText()).as(kz)
                        .isEqualTo(ah.standorte().get(standortVon(ortKz)).toString());
                List<String> pfad = new ArrayList<>();
                ort.get("pfad").forEach(n -> pfad.add(n.asText()));
                assertThat(pfad).as(kz + " Pfad").startsWith(ortKz).endsWith(standortVon(ortKz));
            }

            // Elektrische Stellung.
            JsonNode stellungSoll = stellungAm(soll, tag);
            JsonNode stellung = zeile.get("elektrische_stellung");
            if (stellungSoll == null) {
                assertThat(stellung.isNull()).as(kz + " ohne Stellung").isTrue();
            } else {
                assertThat(stellung.get("stellung").asText()).as(kz)
                        .isEqualTo(stellungSoll.get("stellung").asText());
                assertThat(stellung.get("anlage").asText()).as(kz)
                        .isEqualTo(ah.anlagen().get(stellungSoll.get("anlage").asText()).toString());
                assertThat(stellung.get("anlage_name").asText()).as(kz)
                        .isEqualTo(element(referenz.get("anlagen"), stellungSoll.get("anlage").asText())
                                .get("name").asText());
                assertThat(text(stellung.get("unterzaehler_von"))).as(kz)
                        .isEqualTo(text(stellungSoll.get("unterzaehler_von")));
            }

            // Quelle der Hauptgröße.
            JsonNode quelleSoll = quelleAm(soll, "2026-11-20T00:00:00+01:00");
            JsonNode quelle = zeile.get("quelle");
            if ("berechnet".equals(soll.get("art").asText())) {
                assertThat(quelle.get("stand").asText()).as(kz).isEqualTo("berechnet");
                assertThat(quelle.get("fuehrend").isNull()).as(kz).isTrue();
            } else if (quelleSoll == null) {
                assertThat(quelle.get("stand").asText()).as(kz).isEqualTo("keine_datenquelle");
                assertThat(quelle.get("fuehrend").isNull()).as(kz).isTrue();
            } else {
                assertThat(quelle.get("stand").asText()).as(kz).isEqualTo("gebunden");
                JsonNode fuehrend = quelle.get("fuehrend");
                String komponente = quelleSoll.get("komponente").asText();
                assertThat(fuehrend.get("komponente").asText()).as(kz)
                        .isEqualTo(ah.komponenten().get(komponente).toString());
                assertThat(fuehrend.get("komponente_name").asText()).as(kz)
                        .isEqualTo(element(referenz.get("komponenten"), komponente).get("name").asText());
                assertThat(fuehrend.get("gueltig_ab").asText()).as(kz + " seit")
                        .isEqualTo(quelleSoll.get("gueltig_ab").asText());
                assertThat(fuehrend.at("/geraet/geraet").asText()).as(kz + " Gerät")
                        .isEqualTo(ah.geraete().get(komponente)[0]);
                assertThat(fuehrend.at("/geraet/einbau").asText()).as(kz + " Einbau")
                        .isEqualTo(ah.geraete().get(komponente)[1]);
                assertThat(fuehrend.get("kanal").asText()).as(kz).isEqualTo(kanalFuer(soll));
                assertThat(fuehrend.get("kanal_name").isNull()).as(kz + " Anzeigename").isFalse();
            }
            assertThat(quelle.get("vergleichsquellen").asInt()).as(kz).isZero();

            // Zustand und die ehrlichen Lücken.
            assertThat(zeile.get("lebenszyklus").asText()).as(kz)
                    .isEqualTo("berechnet".equals(soll.get("art").asText()) ? "entwurf" : "aktiv");

            // Beobachtung (IP-15): ohne einen einzigen Wert wartet jede gebundene Größe, und eine
            // ohne Quelle sagt das — nie ein Fehler, nie eine 0.
            JsonNode beobachtung = zeile.get("beobachtung");
            if ("berechnet".equals(soll.get("art").asText())) {
                assertThat(beobachtung.isNull()).as(kz + " berechnet hat keine Beobachtung (AP-10)").isTrue();
                // Ohne Formel am Tag gibt es keine Berechnung (AP-10 IP-9) — nie ein erfundenes „Vollständig“.
                assertThat(zeile.get("berechnung").isNull()).as(kz + " ohne Formel keine Berechnung").isTrue();
            } else if (quelleSoll == null) {
                assertThat(beobachtung.get("zustand").asText()).as(kz).isEqualTo("keine_datenquelle");
                assertThat(beobachtung.get("text").asText()).as(kz).isEqualTo("Keine Datenquelle");
                assertThat(beobachtung.get("geraet").isNull()).as(kz).isTrue();
                assertThat(beobachtung.get("kadenz_s").isNull()).as(kz + " ohne Kanal keine Kadenz").isTrue();
                assertThat(beobachtung.get("toleranz_s").isNull()).as(kz + " ohne Kanal kein Fenster").isTrue();
            } else {
                String einbau = ah.geraete().get(quelleSoll.get("komponente").asText())[1];
                assertThat(beobachtung.get("zustand").asText()).as(kz).isEqualTo("wartet_auf_erste_daten");
                assertThat(beobachtung.get("text").asText()).as(kz)
                        .isEqualTo("Wartet auf erste Daten von " + einbau);
                assertThat(beobachtung.get("geraet").asText()).as(kz).isEqualTo(einbau);
                assertThat(beobachtung.get("seit").isNull()).as(kz + " wartet ohne Zeitpunkt").isTrue();
                assertThat(beobachtung.get("kadenz_s").asLong()).as(kz).isEqualTo(60);
                assertThat(beobachtung.get("toleranz_s").asLong()).as(kz + " min(max(3x60,300),86400)")
                        .isEqualTo(300);
            }
            assertThat(zeile.get("letzter_wert").isNull()).as(kz + " letzter Wert ohne Werte").isTrue();
            // Jede Nebengröße sagt dasselbe über ihre EIGENE führende Quelle (hier: keine).
            assertThat(zeile.get("nebengroessen")).as(kz + " Nebengrößen")
                    .hasSize(soll.get("nebengroessen").size());
            for (JsonNode n : zeile.get("nebengroessen")) {
                assertThat(n.get("letzter_wert").isNull()).as(kz + " Nebengröße").isTrue();
                assertThat("berechnet".equals(soll.get("art").asText())
                        ? n.get("beobachtung").isNull()
                        : "keine_datenquelle".equals(n.at("/beobachtung/zustand").asText())).as(kz).isTrue();
            }
        }

        // Das Aggregat „x von y“ — seit AP-10 IP-9 stehen auch die BERECHNETEN im Nenner (bis dahin stand
        // hier „berechnete kommen mit AP-10“): ohne Formel wie eine gemessene ohne Quelle, nie im Zähler.
        Map<String, Integer> jeStandort = new LinkedHashMap<>();
        int alle = 0;
        for (JsonNode soll : referenz.get("messstellen")) {
            alle++;
            String st = standortVon(ortAm(soll.get("kennzeichen").asText(), tag));
            if (st != null) {
                jeStandort.merge(st, 1, Integer::sum);
            }
        }
        assertThat(antwort.at("/aggregat/unternehmen/gesamt").asInt()).isEqualTo(alle);
        assertThat(antwort.at("/aggregat/unternehmen/erfuellt").asInt()).isZero();
        assertThat(antwort.at("/aggregat/unternehmen/text").asText())
                .isEqualTo("0 von " + alle + " Messstellen liefern Daten");
        Map<String, Integer> gezaehlt = new LinkedHashMap<>();
        antwort.get("aggregat").get("standorte").forEach(a -> gezaehlt.put(a.get("kurzzeichen").asText(),
                a.get("gesamt").asInt()));
        assertThat(gezaehlt).isEqualTo(jeStandort);

        // MS-06 nennt nach dem Wechsel seinen Vorgänger, MS-01 hat keinen.
        assertThat(zeile(antwort, "MS-06").at("/quelle/davor/geraet/einbau").asText()).isEqualTo("Z-5a");
        assertThat(zeile(antwort, "MS-06").at("/quelle/davor/gueltig_bis").asText())
                .isEqualTo("2026-11-18T10:40:00+01:00");
        assertThat(zeile(antwort, "MS-01").at("/quelle/davor").isNull()).isTrue();
        // Die berechneten und die ohne Quelle haben auch kein „davor“.
        assertThat(zeile(antwort, "MS-19").at("/quelle/davor").isNull()).isTrue();
        assertThat(zeile(antwort, "MS-21").at("/quelle/davor").isNull()).isTrue();
        // MS-20 hat an keinem Tag einen Ort (AP-00 §4.4) — das sagt die Zeile, statt einen zu raten.
        assertThat(zeile(antwort, "MS-20").at("/ort/kennzeichen").isNull()).isTrue();
        assertThat(zeile(antwort, "MS-20").at("/ort/grund").asText()).isEqualTo("nicht_verortet");
        assertThat(zeile(antwort, "MS-19").at("/ort/grund").asText()).isEqualTo("am_unternehmen");
        assertThat(zeile(antwort, "MS-19").at("/ort/standort").isNull()).isTrue();
    }

    /**
     * <b>A17</b> („Stand am“): Am 15.11.2026 speist Z-5a seit dem 12.03.2024, am 20.11.2026 Z-5b
     * seit dem 18.11.2026 10:40 — mit Z-5a als „davor“. Ort und Stellung sind an beiden Tagen gleich.
     */
    @Test
    void a17DerStandAmVorUndNachDemZaehlerwechsel() {
        Ahrenberg ah = ahrenberg();
        JsonNode vorher = zeile(register(ah.wer(), "?stichtag=" + VOR_DEM_WECHSEL), "MS-06");
        JsonNode nachher = zeile(register(ah.wer(), "?stichtag=" + NACH_DEM_WECHSEL), "MS-06");

        assertThat(vorher.at("/quelle/fuehrend/geraet/einbau").asText()).isEqualTo("Z-5a");
        assertThat(vorher.at("/quelle/fuehrend/gueltig_ab").asText()).isEqualTo("2024-03-12T00:00:00+01:00");
        assertThat(vorher.at("/quelle/fuehrend/gueltig_bis").asText()).isEqualTo("2026-11-18T10:40:00+01:00");
        assertThat(vorher.at("/quelle/davor").isNull()).isTrue();

        assertThat(nachher.at("/quelle/fuehrend/geraet/einbau").asText()).isEqualTo("Z-5b");
        assertThat(nachher.at("/quelle/fuehrend/gueltig_ab").asText()).isEqualTo("2026-11-18T10:40:00+01:00");
        assertThat(nachher.at("/quelle/fuehrend/gueltig_bis").isNull()).isTrue();
        assertThat(nachher.at("/quelle/davor/geraet/einbau").asText()).isEqualTo("Z-5a");

        // Dieselbe Messstelle, dasselbe Gerät (GR-4), derselbe Ort und dieselbe Stellung.
        assertThat(nachher.at("/quelle/fuehrend/geraet/geraet").asText())
                .isEqualTo(vorher.at("/quelle/fuehrend/geraet/geraet").asText()).isEqualTo("GR-4");
        assertThat(nachher.get("ort")).isEqualTo(vorher.get("ort"));
        assertThat(nachher.get("elektrische_stellung")).isEqualTo(vorher.get("elektrische_stellung"));
        assertThat(nachher.get("id")).isEqualTo(vorher.get("id"));
    }

    /** Ohne Stichtag gilt jetzt: der Tag von heute in der Zeitzone der Schnittstelle. */
    @Test
    void ohneStichtagGiltJetzt() {
        Ahrenberg ah = ahrenberg();
        JsonNode antwort = register(ah.wer(), "");
        assertThat(antwort.get("stichtag").asText())
                .isEqualTo(LocalDate.ofInstant(Instant.now(), BERLIN).toString());
        assertThat(OffsetDateTime.parse(antwort.get("zeitpunkt").asText()).toInstant())
                .isCloseTo(Instant.now(), org.assertj.core.api.Assertions.within(2, java.time.temporal.ChronoUnit.MINUTES));
    }

    // ---- Die Filter ---------------------------------------------------------------------------

    /**
     * Jeder Filter des Berichts (§5.16): Standort (Kurzzeichen ODER ID), Ort mit seinem Teilbaum,
     * Anlage, Zustand, „ohne Quelle“ — und ihre Kombination. „Ohne Quelle“ findet MS-21 (E8) und MS-23
     * (Referenz 1.6: eingerichtet, Quelle erst ab 01.03.2027), nie eine berechnete: die hat keine Quelle,
     * weil sie gerechnet wird.
     */
    @Test
    void dieFilterSchneidenStandortOrtAnlageZustandUndOhneQuelle() {
        Ahrenberg ah = ahrenberg();
        String am = "?stichtag=" + NACH_DEM_WECHSEL;

        // Standort: Kurzzeichen und ID sagen dasselbe; ST-2 ist Lindach.
        assertThat(kennzeichen(register(ah.wer(), am + "&standort=ST-2")))
                .containsExactly("MS-16", "MS-17", "MS-18");
        assertThat(kennzeichen(register(ah.wer(), am + "&standort=" + ah.standorte().get("ST-2"))))
                .containsExactly("MS-16", "MS-17", "MS-18");

        // Ort mit Teilbaum: Halle 1 trägt ihre Bereiche mit; ein Bereich nur sich selbst.
        assertThat(kennzeichen(register(ah.wer(), am + "&ort=G-1")))
                .containsExactly("MS-03", "MS-04", "MS-06", "MS-07", "MS-08", "MS-09");
        assertThat(kennzeichen(register(ah.wer(), am + "&ort=B-2"))).containsExactly("MS-04", "MS-07", "MS-08");
        // Das Unternehmen als Ort: die Messstelle, die direkt an ihm hängt.
        assertThat(kennzeichen(register(ah.wer(), am + "&ort=U"))).containsExactly("MS-19");
        // Der Standort als Ort: sein ganzer Teilbaum, auch die direkt an ihm hängenden Messstellen.
        assertThat(kennzeichen(register(ah.wer(), am + "&ort=ST-2")))
                .containsExactly("MS-16", "MS-17", "MS-18");

        // Anlage: die elektrische Stellung am Stichtag.
        assertThat(kennzeichen(register(ah.wer(), am + "&anlage=" + ah.anlagen().get("AN-3"))))
                .containsExactly("MS-16", "MS-17", "MS-18", "MS-22");
        assertThat(kennzeichen(register(ah.wer(), am + "&anlage=" + ah.anlagen().get("AN-2"))))
                .containsExactly("MS-10", "MS-11", "MS-12", "MS-13", "MS-14", "MS-15");

        // Zustand: die berechneten sind bis AP-10 Entwürfe (ihre Formel fehlt), die anderen aktiv.
        assertThat(kennzeichen(register(ah.wer(), am + "&zustand=entwurf")))
                .containsExactly("MS-09", "MS-15", "MS-19", "MS-20", "MS-22");
        assertThat(kennzeichen(register(ah.wer(), am + "&zustand=aktiv"))).hasSize(18).contains("MS-21", "MS-23");
        assertThat(kennzeichen(register(ah.wer(), am + "&zustand=archiviert"))).isEmpty();

        // Ohne Quelle: MS-21 (Gas, manuelle Ablesung) und MS-23 (GR-19 erst 2027) — keine berechnete.
        assertThat(kennzeichen(register(ah.wer(), am + "&ohneQuelle=true"))).containsExactly("MS-21", "MS-23");
        assertThat(kennzeichen(register(ah.wer(), am + "&ohneQuelle=false")))
                .hasSize(referenz.get("messstellen").size());
        // Vor dem 01.10.2026 hatte MS-10 seine Quelle noch nicht — dann sagt das Register das.
        assertThat(kennzeichen(register(ah.wer(), "?stichtag=2026-09-30&ohneQuelle=true")))
                .contains("MS-10", "MS-21");

        // Kombiniert: der Standort Ahrenberg, Anlage AN-1, Zustand aktiv.
        assertThat(kennzeichen(register(ah.wer(),
                am + "&standort=ST-1&anlage=" + ah.anlagen().get("AN-1") + "&zustand=aktiv")))
                .containsExactly("MS-01", "MS-02", "MS-03", "MS-04", "MS-05", "MS-06", "MS-07", "MS-08");

        // Die gefilterte Liste trägt beide Formen — dieselben Messstellen, dieselbe Reihenfolge.
        JsonNode lindach = register(ah.wer(), am + "&standort=ST-2");
        List<String> voll = new ArrayList<>();
        lindach.get("messstellen").forEach(m -> voll.add(m.get("kennzeichen").asText()));
        assertThat(voll).containsExactly("MS-16", "MS-17", "MS-18");
    }

    /**
     * Der Mandantenzaun und die fremden Filterwerte: ein anderer Kundenbereich sieht nichts, der
     * Plattform-Admin ohne gewählten Kundenbereich auch; ein Standort, Ort oder eine Anlage, die es
     * hier nicht gibt, findet nichts — leer, nie 403, nie ein Hinweis, dass es sie woanders gibt.
     */
    @Test
    void derMandantenzaunUndDieFremdenFilterwerte() {
        Ahrenberg ah = ahrenberg();
        List<String> fremd = new ArrayList<>(ah.messstellen().values());
        JsonNode nachbar = register(DEMO2, "");
        nachbar.get("register").forEach(z -> assertThat(fremd).doesNotContain(z.get("id").asText()));
        nachbar.get("messstellen").forEach(m -> assertThat(fremd).doesNotContain(m.get("id").asText()));
        assertThat(register(ADMIN_OHNE_KUNDENBEREICH, "").get("register")).isEmpty();

        assertThat(register(ah.wer(), "?standort=" + UUID.randomUUID()).get("register")).isEmpty();
        assertThat(register(ah.wer(), "?standort=ST-9").get("register")).isEmpty();
        assertThat(register(ah.wer(), "?ort=" + UUID.randomUUID()).get("register")).isEmpty();
        assertThat(register(ah.wer(), "?anlage=" + UUID.randomUUID()).get("register")).isEmpty();
    }

    /** Die Form der Anfrage: ein Filterwert, den es nicht gibt, ist 400 mit seinem Feld — nie still. */
    @Test
    void dieAnfrageWirdStrengGelesen() {
        Ahrenberg ah = ahrenberg();
        abgelehnt(rufe(HttpMethod.GET, "/messstellen?stichtag=gestern", ah.wer()), "stichtag");
        abgelehnt(rufe(HttpMethod.GET, "/messstellen?anlage=AN-1", ah.wer()), "anlage");
        abgelehnt(rufe(HttpMethod.GET, "/messstellen?zustand=laeuft", ah.wer()), "zustand");
        abgelehnt(rufe(HttpMethod.GET, "/messstellen?ohneQuelle=ja", ah.wer()), "ohneQuelle");
    }

    /** Liste und Einzelabruf kommen aus zwei Lesewegen — und sagen über jede Messstelle dasselbe. */
    @Test
    void dieListeUndDieEinzelneMessstelleSagenDasselbe() {
        Ahrenberg ah = ahrenberg();
        JsonNode antwort = register(ah.wer(), "");
        for (JsonNode m : antwort.get("messstellen")) {
            JsonNode einzeln = ok(rufe(HttpMethod.GET, "/messstellen/" + m.get("id").asText(), ah.wer()));
            assertThat(m).as(m.get("kennzeichen").asText()).isEqualTo(einzeln);
        }
    }

    // ---- Eine Abfrage, keine N+1 ---------------------------------------------------------------

    /**
     * Der Laufzeit-Nachweis (Abnahme IP-4): 100 Messstellen mit Ort, Stellung und Quelle kosten
     * GENAU EINE Abfrage auf den Messstellen-Tabellen und insgesamt so viele Abfragen wie EINE
     * Messstelle — der Ortsbaum kommt aus dem festen Lesezug des Standort-Lesemodells. Und sie sind
     * in weniger als 300 ms da.
     */
    // ---- IP-15: die Beobachtung ----------------------------------------------------------------

    /**
     * Die Vertragskante: die Toleranz ist {@code min(max(3 x Kadenz, 300 s), 86 400 s)} und sie
     * gehört zu „liefert“ ({@code <=}). Bei 3 600 s Kadenz sind das 10 800 s — Sekunde 10 800
     * liefert noch, Sekunde 10 801 nicht mehr, und dann NENNT der Satz den Zeitpunkt.
     *
     * <p>⚠ 2 x Kadenz wäre die LÜCKE (AP-07 IP-9) — eine andere Aussage, die hier nichts entscheidet.
     */
    @Test
    void dieKanteDerToleranzGehoertZuLiefert() {
        Buehne b = buehne("Kante", 3600);
        wert(b, "2026-05-01T08:00:00Z", 1000.0, "good");

        JsonNode innen = zeile(register(b.wer(), "?stichtag=2026-05-01T11:00:00Z"), "MS-0001");
        assertThat(innen.at("/beobachtung/toleranz_s").asLong()).isEqualTo(10_800);
        assertThat(innen.at("/beobachtung/zustand").asText()).isEqualTo("liefert");
        assertThat(innen.at("/beobachtung/text").asText()).isEqualTo("Liefert Daten");
        assertThat(innen.at("/beobachtung/seit").isNull()).as("„liefert“ nennt keinen Zeitpunkt").isTrue();
        assertThat(innen.at("/letzter_wert/wert").asDouble()).isEqualTo(1000.0);
        assertThat(innen.at("/letzter_wert/einheit").asText()).as("die Einheit des Katalogs, nie umgerechnet")
                .isEqualTo("Wh");
        assertThat(innen.at("/letzter_wert/zeitpunkt").asText()).isEqualTo("2026-05-01T10:00:00+02:00");

        JsonNode draussen = zeile(register(b.wer(), "?stichtag=2026-05-01T11:00:01Z"), "MS-0001");
        assertThat(draussen.at("/beobachtung/zustand").asText()).isEqualTo("liefert_nicht_seit");
        assertThat(draussen.at("/beobachtung/seit").asText()).isEqualTo("2026-05-01T10:00:00+02:00");
        assertThat(draussen.at("/beobachtung/text").asText())
                .isEqualTo("Liefert keine Daten seit 10:00 Uhr");
        // Der letzte Wert bleibt, was er ist — er wird nicht verschwiegen, weil er alt ist.
        assertThat(draussen.at("/letzter_wert/wert").asDouble()).isEqualTo(1000.0);

        // Und am nächsten Tag trägt der Satz das Datum (Zeitzone des Standorts).
        assertThat(zeile(register(b.wer(), "?stichtag=2026-05-02T08:00:00Z"), "MS-0001")
                .at("/beobachtung/text").asText()).isEqualTo("Liefert keine Daten seit 01.05.2026 10:00 Uhr");
    }

    /**
     * Werte kommen an der Box an, gehören aber zu keiner Reihe (Untersuchung Messkunde-Portalweg, verdeckende
     * Bedingung 1): die Zeile sagt NICHT „Liefert Daten“, sondern was das System sieht — der Zustand spricht
     * über die Reihe, {@code zuordnung} benennt den Fall, der letzte Wert bleibt. Die Werte-Karte trägt dasselbe
     * Wort; ihre Schritte, Zahlen und Gründe bleiben. Kommen die Werte zugeordnet an, ist die Zeile wieder
     * Zeichen für Zeichen die eines liefernden Zählers — ohne das Feld.
     */
    @Test
    void werteOhneReiheSindNichtLiefertDaten() {
        Buehne b = buehne("Nicht zugeordnet", 60);
        boxWert(b, "2026-05-01T08:00:00Z", 500.0);
        boxWert(b, "2026-05-01T08:01:00Z", 501.0);

        JsonNode vorher = zeile(register(b.wer(), "?stichtag=2026-05-01T08:02:00Z"), "MS-0001");
        assertThat(vorher.at("/beobachtung/zustand").asText()).as("die Reihe hat nichts")
                .isEqualTo("wartet_auf_erste_daten");
        assertThat(vorher.at("/beobachtung/zuordnung").asText()).isEqualTo("nicht_zugeordnet");
        assertThat(vorher.at("/beobachtung/text").asText())
                .isEqualTo("Daten kommen an – noch keiner Messreihe zugeordnet");
        assertThat(vorher.at("/letzter_wert/wert").asDouble()).as("keine Zahl ändert sich").isEqualTo(501.0);
        assertThat(register(b.wer(), "?stichtag=2026-05-01T08:02:00Z").at("/aggregat/unternehmen/erfuellt").asInt())
                .as("zählt nicht als liefernd").isZero();

        JsonNode werte = ok(rufe(HttpMethod.GET, "/messstellen/MS-0001/werte?raster=tag&von=2026-05-01&bis=2026-05-01",
                b.wer()));
        assertThat(werte.get("zuordnung").asText()).isEqualTo("nicht_zugeordnet");
        assertThat(werte.at("/werte/0/menge").isNull()).as("keine Zahl " + werte.at("/werte/0")).isTrue();
        assertThat(werte.at("/werte/0/grund").isNull()).as("kein Schritt bekommt einen Grund").isTrue();

        // Ohne Werte an der Box: kein Fall, das Wort fehlt (null an der Werte-Route, kein Feld im Register).
        JsonNode frueher = ok(rufe(HttpMethod.GET,
                "/messstellen/MS-0001/werte?raster=tag&von=2026-04-30&bis=2026-04-30", b.wer()));
        assertThat(frueher.get("zuordnung").isNull()).isTrue();

        // Nach der Übernahme kommen die Werte zugeordnet an: „Liefert Daten“, und die Zeile ist die eines
        // liefernden Zählers ohne Box-Werte — Zeichen für Zeichen.
        wert(b, "2026-05-01T08:02:00Z", 502.0, "good");
        JsonNode nachher = zeile(register(b.wer(), "?stichtag=2026-05-01T08:03:00Z"), "MS-0001");
        assertThat(nachher.at("/beobachtung/zustand").asText()).isEqualTo("liefert");
        assertThat(nachher.at("/beobachtung/text").asText()).isEqualTo("Liefert Daten");
        assertThat(nachher.get("beobachtung").has("zuordnung")).as("das Feld fehlt ohne den Fall").isFalse();
        assertThat(nachher.at("/letzter_wert/wert").asDouble()).isEqualTo(502.0);

        Buehne bestand = buehne("Bestand zugeordnet", 60);
        wert(bestand, "2026-05-01T08:02:00Z", 502.0, "good");
        JsonNode soll = zeile(register(bestand.wer(), "?stichtag=2026-05-01T08:03:00Z"), "MS-0001");
        assertThat(nachher.get("beobachtung")).isEqualTo(soll.get("beobachtung"));
        assertThat(nachher.get("letzter_wert")).isEqualTo(soll.get("letzter_wert"));
    }

    /**
     * Der Fall, den man falsch erwartet (Vektor {@code mindestfenster-schlaegt-drei-kadenzen}):
     * 60 s Kadenz, 190 s Alter — 3 x Kadenz ist überschritten, das Mindestfenster von 300 s nicht.
     * Es gilt „Liefert Daten“. Der Deckel greift umgekehrt bei sehr trägen Reihen.
     */
    @Test
    void dasMindestfensterSchlaegtDreiKadenzenUndDerDeckelEinenTag() {
        Buehne schnell = buehne("Mindestfenster", 60);
        wert(schnell, "2026-05-01T08:00:00Z", 5.0, "good");
        JsonNode z = zeile(register(schnell.wer(), "?stichtag=2026-05-01T08:03:10Z"), "MS-0001");
        assertThat(z.at("/beobachtung/kadenz_s").asLong()).isEqualTo(60);
        assertThat(z.at("/beobachtung/toleranz_s").asLong()).isEqualTo(300);
        assertThat(z.at("/beobachtung/zustand").asText()).as("190 s > 3 x 60 s, aber < 300 s")
                .isEqualTo("liefert");

        Buehne traege = buehne("Deckel", 40_000);
        wert(traege, "2026-05-01T00:00:00Z", 7.0, "good");
        assertThat(zeile(register(traege.wer(), "?stichtag=2026-05-02T00:00:00Z"), "MS-0001")
                .at("/beobachtung/toleranz_s").asLong()).as("3 x 40 000 s, gedeckelt auf einen Tag")
                .isEqualTo(86_400);
        assertThat(zeile(register(traege.wer(), "?stichtag=2026-05-02T00:00:00Z"), "MS-0001")
                .at("/beobachtung/zustand").asText()).isEqualTo("liefert");
        assertThat(zeile(register(traege.wer(), "?stichtag=2026-05-02T00:00:01Z"), "MS-0001")
                .at("/beobachtung/zustand").asText()).isEqualTo("liefert_nicht_seit");
    }

    /**
     * Gezählt werden nur Werte mit Qualität „gut“ (AP-07 E9): kamen nur unsichere an, wartet die
     * Messstelle weiter auf ihre ERSTEN Daten — ein eigenes Wort dafür wäre ein geratener Zustand,
     * und ein Fehler wäre es erst recht nicht.
     */
    @Test
    void nurGuteWerteZaehlenSonstWartetSieWeiter() {
        Buehne b = buehne("Nur schlechte", 60);
        wert(b, "2026-05-01T08:00:00Z", 1.0, "uncertain");
        wert(b, "2026-05-01T08:01:00Z", 2.0, "device_error");

        JsonNode z = zeile(register(b.wer(), "?stichtag=2026-05-01T08:01:30Z"), "MS-0001");
        assertThat(z.at("/beobachtung/zustand").asText()).isEqualTo("wartet_auf_erste_daten");
        assertThat(z.at("/letzter_wert").isNull()).as("ein unsicherer Wert ist kein letzter Wert").isTrue();

        wert(b, "2026-05-01T08:02:00Z", 3.0, "good");
        assertThat(zeile(register(b.wer(), "?stichtag=2026-05-01T08:02:30Z"), "MS-0001")
                .at("/beobachtung/zustand").asText()).isEqualTo("liefert");
    }

    /**
     * <b>MS-06 des Referenzunternehmens</b> (§5.13): am 18.11.2026 10:40 löst Z-5b den Zähler Z-5a
     * ab. Bis 10:47 sagt die Zeile „Wartet auf erste Daten von Z-5b“ — obwohl Z-5a bis 10:39
     * geliefert hat: dessen Werte gehören zu SEINER Bindung, nicht zur neuen. Ab dem ersten Wert
     * von Z-5b heißt es wieder „Liefert Daten“.
     */
    @Test
    void ms06WartetNachDemZaehlerwechselAufErsteDatenVonZ5b() {
        JsonNode gr4 = element(referenz.get("geraete"), "GR-4");
        String wechsel = element(gr4.get("einbauten"), "Z-5b").get("gueltig_ab").asText();
        String vorher = element(gr4.get("einbauten"), "Z-5a").get("gueltig_ab").asText();
        Buehne b = buehne("Zählerwechsel", 60, "MS-06", vorher);
        wert(b, "2026-11-18T09:39:00Z", 1_083_415.2, "good"); // 10:39 Ortszeit, noch Z-5a

        // Der Wechsel: Z-5a ausgebaut, Z-5b eingebaut, die Bindung endet und beginnt zum selben
        // Zeitpunkt — genau wie der Zeitstrahl der Vektor-Datei.
        einbauWechsel(b, "Z-5a", "Z-5b", wechsel);

        JsonNode wartet = zeile(register(b.wer(), "?stichtag=2026-11-18T09:45:00Z"), "MS-06");
        assertThat(wartet.at("/quelle/fuehrend/geraet/einbau").asText()).isEqualTo("Z-5b");
        assertThat(wartet.at("/beobachtung/zustand").asText()).isEqualTo("wartet_auf_erste_daten");
        assertThat(wartet.at("/beobachtung/text").asText()).isEqualTo("Wartet auf erste Daten von Z-5b");
        assertThat(wartet.at("/beobachtung/geraet").asText()).isEqualTo("Z-5b");
        assertThat(wartet.at("/letzter_wert").isNull()).as("der Endstand von Z-5a ist nicht ihr Wert").isTrue();
        assertThat(wartet.at("/aggregat/unternehmen").isMissingNode()).isTrue();

        // 10:47: die ersten Werte von Z-5b treffen ein (§5.13, Protokoll 18.11.2026 10:47).
        wert(b, "2026-11-18T09:47:00Z", 0.0, "good");
        JsonNode liefert = zeile(register(b.wer(), "?stichtag=2026-11-18T09:47:30Z"), "MS-06");
        assertThat(liefert.at("/beobachtung/zustand").asText()).isEqualTo("liefert");
        assertThat(liefert.at("/beobachtung/text").asText()).isEqualTo("Liefert Daten");
        assertThat(liefert.at("/letzter_wert/zeitpunkt").asText()).isEqualTo("2026-11-18T10:47:00+01:00");
        assertThat(liefert.at("/letzter_wert/wert").asDouble()).isZero();
    }

    /**
     * <b>MS-21</b> (E8): eine Messstelle OHNE Datenquelle sagt genau das — auch wenn unter ihrer
     * früheren Bindung längst Werte liegen. Ein bekannter Grund ist nie eine Störung, und
     * „keine Datenquelle“ schlägt jeden alten Wert.
     */
    @Test
    void ohneDatenquelleSchlaegtDerGrundJedenAltenWert() {
        Buehne b = buehne("Ohne Quelle", 60);
        wert(b, "2026-05-01T08:00:00Z", 1240.0, "good");
        root.update("UPDATE messstelle_quelle SET gueltig_bis = ? WHERE messstelle_id = ?",
                Timestamp.from(Instant.parse("2026-05-01T09:00:00Z")), b.messstelle());

        JsonNode z = zeile(register(b.wer(), "?stichtag=2026-05-01T10:00:00Z"), "MS-0001");
        assertThat(z.at("/quelle/stand").asText()).isEqualTo("keine_datenquelle");
        assertThat(z.at("/beobachtung/zustand").asText()).isEqualTo("keine_datenquelle");
        assertThat(z.at("/beobachtung/text").asText()).isEqualTo("Keine Datenquelle");
        assertThat(z.at("/beobachtung/geraet").isNull()).isTrue();
        assertThat(z.at("/beobachtung/kadenz_s").isNull()).as("ohne Kanal keine Kadenz, nie eine erfundene")
                .isTrue();
        assertThat(z.at("/letzter_wert").isNull()).as("kein Wert ohne Quelle — nie ein alter").isTrue();
        // Und sie zählt im Nenner, nie im Zähler.
        assertThat(register(b.wer(), "?stichtag=2026-05-01T10:00:00Z").at("/aggregat/unternehmen/text").asText())
                .isEqualTo("0 von 1 Messstelle liefern Daten");
    }

    /**
     * Das Aggregat „x von y Messstellen liefern Daten“ — je Standort und für das Unternehmen,
     * serverseitig aus der Ableitung {@code aggregat} des Vertrags. Nur „liefert“ zählt im Zähler;
     * ein Filter schneidet auch das Aggregat, weil es GENAU die gezeigten Zeilen zählt.
     */
    @Test
    void dasAggregatZaehltJeStandortUndFuerDasUnternehmen() {
        Buehne b = buehne("Aggregat", 60);
        UUID zweiter = standort(b, "ST-2", "Werk Zwei");
        messstelle(b, "MS-0002", b.standort(), 60, "2026-01-01T00:00:00Z");
        messstelle(b, "MS-0003", zweiter, 60, "2026-01-01T00:00:00Z");
        wert(b, "MS-0001", "2026-05-01T08:00:00Z", 1.0, "good");
        wert(b, "MS-0003", "2026-05-01T08:00:00Z", 3.0, "good");

        JsonNode antwort = register(b.wer(), "?stichtag=2026-05-01T08:01:00Z");
        assertThat(antwort.at("/aggregat/unternehmen/text").asText())
                .isEqualTo("2 von 3 Messstellen liefern Daten");
        assertThat(antwort.at("/aggregat/unternehmen/erfuellt").asInt()).isEqualTo(2);
        Map<String, String> jeStandort = new LinkedHashMap<>();
        antwort.at("/aggregat/standorte").forEach(a -> jeStandort.put(a.get("kurzzeichen").asText(),
                a.get("text").asText()));
        assertThat(jeStandort).containsExactly(
                org.assertj.core.api.Assertions.entry("ST-1", "1 von 2 Messstellen liefert Daten"),
                org.assertj.core.api.Assertions.entry("ST-2", "1 von 1 Messstelle liefert Daten"));
        assertThat(antwort.at("/aggregat/standorte/1/name").asText()).isEqualTo("Werk Zwei");

        // Der Filter schneidet die Zeilen UND das Aggregat.
        assertThat(register(b.wer(), "?stichtag=2026-05-01T08:01:00Z&standort=ST-2")
                .at("/aggregat/unternehmen/text").asText()).isEqualTo("1 von 1 Messstelle liefert Daten");
    }

    /** Der Zaun gilt auch für die Werte: ein fremder Kundenbereich sieht weder Zeile noch Wert. */
    @Test
    void dieWerteBleibenImEigenenKundenbereich() {
        Buehne b = buehne("Zaun Werte", 60);
        wert(b, "2026-05-01T08:00:00Z", 42.0, "good");

        assertThat(register(b.wer(), "?stichtag=2026-05-01T08:01:00Z").at("/register/0/letzter_wert/wert")
                .asDouble()).isEqualTo(42.0);
        JsonNode fremd = register(DEMO2, "?stichtag=2026-05-01T08:01:00Z");
        assertThat(fremd.get("register")).isEmpty();
        assertThat(fremd.at("/aggregat/unternehmen/text").asText()).isEqualTo("Noch keine Messstellen");
    }

    // ---- Gerüst: die Bühne der Beobachtung -------------------------------------------------------

    /**
     * Ein eigener Kundenbereich mit einem Standort, einer Anlage und Messstellen. JEDE bekommt ihre
     * EIGENE Box: die Messreihe ist heute (Box, Kanal) — ohne {@code entity_id} am Wert (AP-07
     * IP-6/IP-7) läsen zwei Komponentenderselben Box unter demselben Kanal dieselben Werte.
     */
    private record Buehne(Anrufer wer, UUID standort, UUID anlage, Map<String, UUID> messstellen,
            Map<String, UUID> komponenten, Map<String, UUID> boxen) {

        UUID messstelle() {
            return messstellen.values().iterator().next();
        }

        String erste() {
            return messstellen.keySet().iterator().next();
        }
    }

    private Buehne buehne(String name, int kadenzS) {
        return buehne(name, kadenzS, "MS-0001", "2026-01-01T00:00:00Z");
    }

    /** Bühne mit EINER Messstelle unter {@code kennzeichen}, deren führende Quelle ab {@code ab} gilt. */
    private Buehne buehne(String name, int kadenzS, String kennzeichen, String ab) {
        UUID t = neuerKundenbereich(name);
        Anrufer wer = new Anrufer("admin", t);
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, name, Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        Buehne b = new Buehne(wer, null, anlage, new LinkedHashMap<>(), new LinkedHashMap<>(),
                new LinkedHashMap<>());
        UUID standort = standort(b, "ST-1", name);
        Buehne fertig = new Buehne(wer, standort, anlage, b.messstellen(), b.komponenten(), b.boxen());
        messstelle(fertig, kennzeichen, standort, kadenzS, ab);
        return fertig;
    }

    /** Ein weiterer Standort desselben Kundenbereichs (über die Route, damit das Kurzzeichen zählt). */
    private UUID standort(Buehne b, String kurzzeichen, String name) {
        standortService.uhrStellen(uhr("2019-01-01T09:00:00+01:00"));
        try {
            return UUID.fromString(ok201(rufe(HttpMethod.POST, "/standorte", b.wer(),
                    Map.of("name", name, "kurzzeichen", kurzzeichen, "zeitzone", "Europe/Berlin", "adresse",
                            Map.of("strasse", "Gewerbering 7", "plz", "12345", "ort", "Ahrenberg", "land", "DE"))))
                    .get("id").asText());
        } finally {
            standortService.uhrStellen(Clock.systemUTC());
        }
    }

    /** Komponente (mit ihrem Gerät), Mess-Selektion, Messstelle, Ort und führende Quelle ab {@code ab}. */
    private UUID messstelle(Buehne b, String kennzeichen, UUID standort, int kadenzS, String ab) {
        UUID t = b.wer().kundenbereich();
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, b.anlage(), "VP-BOX-" + kennzeichen + "-" + b.anlage());
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, "
                + "'modbus-generic', ?, 'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) "
                + "RETURNING id", UUID.class, t, b.anlage(), "Zähler " + kennzeichen, box,
                Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")));
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                + "apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, ?, 1, now(), "
                + "'2026.08.26.3', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute')",
                t, b.anlage(), box, komponente, ENERGIE_BEZUG, kadenzS);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?",
                UUID.class, komponente);
        UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                + "groesse, richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', "
                + "'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t, kennzeichen, "Zähler " + kennzeichen);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) "
                + "VALUES (?,?,?,?)", t, messstelle, standort, LocalDate.parse("2020-01-01"));
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, "
                + "geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, "
                + "actor_name, actor_art) VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand',"
                + "'fuehrend',?,false,?,'test','voltpilot')", t, messstelle, komponente, geraet, ENERGIE_BEZUG,
                Timestamp.from(Instant.parse(ab)), Timestamp.from(Instant.parse(ab).plusSeconds(60)));
        b.messstellen().put(kennzeichen, messstelle);
        b.komponenten().put(kennzeichen, komponente);
        b.boxen().put(kennzeichen, box);
        return messstelle;
    }

    /**
     * Der Zählerwechsel auf der Bühne: derselbe Einbau-Wechsel wie im Referenzunternehmen — Gerät
     * und Kanal bleiben, nur der Einbau und die Bindung wechseln zum selben Zeitpunkt.
     */
    private void einbauWechsel(Buehne b, String alt, String neu, String zeitpunkt) {
        UUID t = b.wer().kundenbereich();
        Timestamp wann = Timestamp.from(OffsetDateTime.parse(zeitpunkt).toInstant());
        UUID komponente = b.komponenten().values().iterator().next();
        UUID vorher = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        root.update("UPDATE geraet SET einbau_kennzeichen = ?, ausgebaut_am = ? WHERE id = ?", alt, wann, vorher);
        root.update("UPDATE geraet_komponente SET gueltig_bis = ? WHERE geraet_id = ?", wann, vorher);
        String kennzeichen = root.queryForObject("SELECT kennzeichen FROM geraet WHERE id = ?", String.class,
                vorher);
        UUID nachher = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, "
                + "einbau_kennzeichen, geraeteart, eingebaut_am) VALUES (?, ?, ?, ?, 'zaehler', ?) RETURNING id",
                UUID.class, t, b.anlage(), kennzeichen, neu, wann);
        root.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, gueltig_ab) VALUES (?,?,?,?)",
                t, nachher, komponente, wann);
        UUID messstelle = b.messstelle();
        root.update("UPDATE messstelle_quelle SET gueltig_bis = ? WHERE messstelle_id = ? AND gueltig_bis IS NULL",
                wann, messstelle);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, "
                + "geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, "
                + "actor_name, actor_art) VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter','zaehlerstand',"
                + "'fuehrend',?,false,?,'test','voltpilot')", t, messstelle, komponente, nachher, ENERGIE_BEZUG,
                wann, Timestamp.from(wann.toInstant().plusSeconds(1500)));
    }

    private void wert(Buehne b, String zeit, double zahl, String qualitaet) {
        wert(b, b.erste(), zeit, zahl, qualitaet);
    }

    /**
     * EIN Messwert, wie ihn der Writer ablegt, wenn die Komponente eine Datenquelle hat: an seiner Box UND in der
     * Reihe der Komponente ({@code entity_id}, Rolle {@code fuehrend}) — ein zugeordneter Wert.
     */
    private void wert(Buehne b, String kennzeichen, String zeit, double zahl, String qualitaet) {
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind, "
                + "entity_id, role) VALUES (?,?,?,?,?,?,?,?,'2026.08.26.3',?,'counter',?,'fuehrend')",
                Timestamp.from(Instant.parse(zeit)), b.wer().kundenbereich(), b.anlage(),
                b.boxen().get(kennzeichen), ENERGIE_BEZUG, zahl, zahl, qualitaet,
                Math.abs(zeit.hashCode()) % 100000, b.komponenten().get(kennzeichen));
    }

    /**
     * EIN Messwert, der an der Box ankommt, aber zu keiner Reihe gehört — der Writer legt ihn als Bestandswert ohne
     * {@code entity_id} ab, weil der Komponente die Datenquelle fehlt (Messkunde vor Schritt 2 des Assistenten).
     */
    private void boxWert(Buehne b, String zeit, double zahl) {
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                + "raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, aggregation_kind) "
                + "VALUES (?,?,?,?,?,?,?,'good','2026.08.26.3',?,'counter')",
                Timestamp.from(Instant.parse(zeit)), b.wer().kundenbereich(), b.anlage(),
                b.boxen().get(b.erste()), ENERGIE_BEZUG, zahl, zahl, Math.abs(zeit.hashCode()) % 100000);
    }

    /**
     * ⚠ Seit AP-07 IP-10 kommt EINE weitere Abfrage dazu: die Kadenz-Fassungen aller führenden
     * Bindungen zum Zeitpunkt ({@code quelle_kadenz}, ein Zug für alle — kein N+1). Die Zusage
     * bleibt, was sie war: die MESSSTELLEN-Daten kosten genau EINE Abfrage, und 100 Messstellen
     * kosten so viele Abfragen wie eine.
     */
    @Test
    void hundertMessstellenKostenEineAbfrageUndBleibenUnter300ms() {
        Anrufer eine = werk("Laufzeit 1", 1);
        Anrufer hundert = werk("Laufzeit 100", 100);

        register(eine, "");
        register(hundert, "");
        List<String> abfragenEine = abfragen(() -> register(eine, ""));
        List<String> abfragenHundert = abfragen(() -> register(hundert, ""));

        assertThat(abfragenHundert.stream().filter(s -> s.contains("FROM messstelle ")).toList())
                .as(String.join("\n", abfragenHundert)).hasSize(1);
        assertThat(abfragenHundert.stream().filter(s -> s.contains("FROM quelle_kadenz")).toList())
                .as("die Kadenz-Fassungen: EIN Zug für alle Bindungen (AP-07 IP-10)")
                .hasSize(1);
        assertThat(abfragenHundert).as("keine N+1: dieselbe Zahl wie bei einer Messstelle")
                .hasSameSizeAs(abfragenEine);

        assertThat(register(hundert, "").get("register")).hasSize(100);
        for (int i = 0; i < 5; i++) {
            register(hundert, ""); // warmlaufen: die Messung soll den Weg messen, nicht den JIT
        }
        long bestes = Long.MAX_VALUE;
        for (int i = 0; i < 5; i++) {
            long start = System.nanoTime();
            JsonNode antwort = register(hundert, "");
            bestes = Math.min(bestes, Duration.ofNanos(System.nanoTime() - start).toMillis());
            assertThat(antwort.get("register")).hasSize(100);
        }
        assertThat(bestes).as("Laufzeit von 100 Messstellen in ms").isLessThan(300);
    }

    // ---- Gerüst: das Referenzunternehmen --------------------------------------------------------

    /**
     * Das Werk Ahrenberg über die Schnittstelle: zwei Standorte mit ihren Gebäuden und Bereichen,
     * drei Anlagen, die 21 Messstellen mit ihren Orten und Stellungen, die Komponenten mit ihren
     * Geräten (der Anlege-Weg legt sie an) und die führenden Quellen — samt Zählerwechsel Z-5a → Z-5b.
     */
    private synchronized Ahrenberg ahrenberg() {
        if (ahrenberg != null) {
            return ahrenberg;
        }
        UUID t = neuerKundenbereich(referenz.at("/unternehmen/name").asText());
        Anrufer wer = new Anrufer("admin", t);
        // Die Anlagen VOR den Standorten: sie bleiben „noch nicht zugeordnet" wie bisher —
        // nach zwei Standorten verlangte POST /sites seit AP-02 IP-9 die Wahl (409
        // standort_waehlen). Das Register liest den Standort einer Messstelle ohnehin aus
        // ihrem ORT (Ortsbaum), nie aus der Anlage.
        Map<String, UUID> anlagen = new LinkedHashMap<>();
        for (JsonNode an : referenz.get("anlagen")) {
            anlagen.put(an.get("kennzeichen").asText(), UUID.fromString(ok201(rufeApi(HttpMethod.POST,
                    "/api/v1/sites", wer, Map.of("name", an.get("name").asText()))).get("id").asText()));
        }
        Map<String, UUID> standorte = new LinkedHashMap<>();
        standortService.uhrStellen(uhr("2024-03-12T09:00:00+01:00"));
        standorte.put("ST-1", UUID.fromString(ok201(rufe(HttpMethod.POST, "/standorte", wer,
                standortAnfrage("ST-1"))).get("id").asText()));
        standortService.uhrStellen(uhr("2026-10-15T08:00:00+02:00"));
        standorte.put("ST-2", UUID.fromString(ok201(rufe(HttpMethod.POST, "/standorte", wer,
                standortAnfrage("ST-2"))).get("id").asText()));
        standortService.uhrStellen(Clock.systemUTC());
        Map<String, UUID> orte = new LinkedHashMap<>();
        for (JsonNode z : referenz.get("zuordnungen")) {
            if ("ort_eltern".equals(z.get("art").asText()) && !z.get("nach").isNull()) {
                String kz = z.get("von").asText();
                orte.put(kz, neuerOrt(t, kz, standorte.get(z.get("nach").asText()), orte.get(z.get("nach").asText()),
                        z.get("gueltig_ab").asText()));
            }
        }
        Map<String, UUID> komponenten = new LinkedHashMap<>();
        Set<String> gemeinsam = komponentenDerMitsteuerndenBoxen();
        for (JsonNode k : referenz.get("komponenten")) {
            String kz = k.get("kennzeichen").asText();
            if ("K-2".equals(kz) || "K-8.7".equals(kz) || "K-15".equals(kz) || gemeinsam.contains(kz)) {
                // K-2 meldet der Wechselrichter mit; K-8.7 kommt erst 2027 (A18), K-15 (GR-19 an DQ-3,
                // Referenz 1.6) ebenso erst am 01.03.2027 - bis dahin trägt MS-23 keine Datenquelle.
                continue;
            }
            komponenten.put(kz, komponente(t, anlagen.get(k.get("anlage").asText()), k));
        }
        Map<String, String> messstellen = new LinkedHashMap<>();
        for (JsonNode m : referenz.get("messstellen")) {
            messstellen.put(m.get("kennzeichen").asText(), anlegen(wer, m));
        }
        Ahrenberg ah = new Ahrenberg(t, standorte, anlagen, messstellen, komponenten, geraeteJeKomponente(t));

        // Die führenden Quellen, jede ab Beginn ihres Verlaufs (rückwirkend eingetragen).
        for (JsonNode m : referenz.get("messstellen")) {
            JsonNode erste = m.at("/fuehrende_quelle/0");
            if (erste.isMissingNode() || erste.isNull()
                    || !komponenten.containsKey(erste.get("komponente").asText())) {
                continue;
            }
            uhr(quellenService, "2026-11-18T11:05:00+01:00");
            quelleBinden(wer, messstellen.get(m.get("kennzeichen").asText()), m,
                    komponenten.get(erste.get("komponente").asText()), erste.get("gueltig_ab").asText(), null);
        }
        // Der Zählerwechsel an K-5 und die neue Bindung von MS-06 ab 18.11.2026 10:40 (§5.13).
        zaehlerwechsel(ah);
        JsonNode ms06 = referenzMessstelle("MS-06");
        JsonNode z5b = ms06.at("/fuehrende_quelle/1");
        JsonNode alt = element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5a");
        uhr(quellenService, "2026-11-18T11:05:00+01:00");
        quelleBinden(wer, messstellen.get("MS-06"), ms06, komponenten.get("K-5"),
                z5b.get("gueltig_ab").asText(), alt.get("endstand_kwh").asDouble());
        quellenService.uhrStellen(Clock.systemUTC());

        // Ort und elektrische Stellung, tagesgenau (IP-7) — Hauptzähler vor ihren Unterzählern.
        zuordnungService.uhrStellen(uhr(EINFUEHRUNG));
        for (JsonNode z : referenz.get("zuordnungen")) {
            if ("messstelle_ort".equals(z.get("art").asText())) {
                ok(rufe(HttpMethod.PUT, "/messstellen/" + messstellen.get(z.get("von").asText()) + "/ort", wer,
                        anfrage("kennzeichen", z.get("nach").asText(), "gueltig_ab", z.get("gueltig_ab").asText())));
            }
        }
        for (JsonNode m : reihenfolge()) {
            for (JsonNode s : m.get("elektrische_stellung")) {
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("anlage", anlagen.get(s.get("anlage").asText()).toString());
                body.put("stellung", s.get("stellung").asText());
                body.put("unterzaehler_von", text(s.get("unterzaehler_von")));
                body.put("gueltig_ab", s.get("gueltig_ab").asText());
                ok(rufe(HttpMethod.PUT, "/messstellen/" + messstellen.get(m.get("kennzeichen").asText())
                        + "/stellung", wer, body));
            }
        }
        zuordnungService.uhrStellen(Clock.systemUTC());

        // Der Anlege-Weg hat AN-1 genau die Geräte der Vektor-Datei gegeben (GR-1 … GR-6).
        assertThat(root.queryForList("SELECT DISTINCT kennzeichen FROM geraet WHERE tenant_id = ? AND site_id = ? "
                + "ORDER BY kennzeichen", String.class, t, anlagen.get("AN-1")))
                .containsExactly("GR-1", "GR-2", "GR-3", "GR-4", "GR-5", "GR-6");
        ahrenberg = new Ahrenberg(t, standorte, anlagen, messstellen, komponenten, geraeteJeKomponente(t));
        return ahrenberg;
    }

    /**
     * Die EINE Ausnahme vom Anlegen: die Komponenten der mitsteuernden Boxen einer gemeinsamen Steuerung
     * (Referenzunternehmen 1.5, AP-15 E8) — hinter den Datenquellen, für die eine Box mit der Rolle
     * {@code steuert_mit} zuständig ist. Das Register zeigt den Bestand ohne gemeinsame Steuerung.
     */
    private static Set<String> komponentenDerMitsteuerndenBoxen() {
        Set<String> boxen = new HashSet<>();
        referenz.path("gemeinsame_steuerungen").forEach(v -> v.path("mitglieder").forEach(m -> {
            if ("steuert_mit".equals(m.path("rolle").asText())) {
                boxen.add(m.path("box").asText());
            }
        }));
        Set<String> quellen = new HashSet<>();
        referenz.path("zuordnungen").forEach(z -> {
            if ("datenquelle_box".equals(z.path("art").asText()) && boxen.contains(z.path("nach").asText())) {
                quellen.add(z.path("von").asText());
            }
        });
        Set<String> geraete = new HashSet<>();
        referenz.path("geraete").forEach(g -> {
            if (quellen.contains(g.path("datenquelle").asText())) {
                geraete.add(g.path("kennzeichen").asText());
            }
        });
        Set<String> out = new HashSet<>();
        referenz.path("komponenten").forEach(k -> {
            if (geraete.contains(k.path("geraet").asText())) {
                out.add(k.path("kennzeichen").asText());
            }
        });
        return out;
    }

    /** Erst die Hauptzähler, dann die, die auf sie zeigen — in der Reihenfolge der Referenz. */
    private static List<JsonNode> reihenfolge() {
        List<JsonNode> erst = new ArrayList<>();
        List<JsonNode> dann = new ArrayList<>();
        referenz.get("messstellen").forEach(m -> (m.get("elektrische_stellung").size() > 0
                && "Hauptzähler".equals(m.at("/elektrische_stellung/0/stellung").asText()) ? erst : dann).add(m));
        erst.addAll(dann);
        return erst;
    }

    /** Der laufende Einbau je Komponente: {Gerät-Kennzeichen, Einbau-Kennzeichen}. */
    private static Map<String, String[]> geraeteJeKomponente(UUID tenant) {
        Map<String, String[]> out = new LinkedHashMap<>();
        for (Map<String, Object> zeile : root.queryForList("SELECT p.label, g.kennzeichen, g.einbau_kennzeichen "
                + "FROM geraet_komponente gk JOIN geraet g ON g.id = gk.geraet_id "
                + "JOIN measurement_point p ON p.id = gk.entity_id WHERE gk.tenant_id = ? "
                + "AND gk.gueltig_bis IS NULL", tenant)) {
            for (JsonNode k : referenz.get("komponenten")) {
                if (k.get("name").asText().equals(zeile.get("label"))) {
                    out.put(k.get("kennzeichen").asText(), new String[] {
                            String.valueOf(zeile.get("kennzeichen")), String.valueOf(zeile.get("einbau_kennzeichen"))});
                }
            }
        }
        return out;
    }

    /** Der Zählerwechsel an K-5 (GR-4): Z-5a endet, Z-5b beginnt — genau zum selben Zeitpunkt. */
    private void zaehlerwechsel(Ahrenberg ah) {
        JsonNode gr4 = element(referenz.get("geraete"), "GR-4");
        JsonNode z5a = element(gr4.get("einbauten"), "Z-5a");
        JsonNode z5b = element(gr4.get("einbauten"), "Z-5b");
        Timestamp wechsel = ts(z5a.get("gueltig_bis"));
        UUID alt = root.queryForObject("SELECT g.id FROM geraet g JOIN geraet_komponente gk ON gk.geraet_id = g.id "
                + "WHERE g.tenant_id = ? AND gk.entity_id = ?", UUID.class, ah.tenant(), ah.komponenten().get("K-5"));
        root.update("UPDATE geraet SET einbau_kennzeichen = ?, seriennummer = ?, ausgebaut_am = ? WHERE id = ?",
                z5a.get("kennzeichen").asText(), z5a.get("seriennummer").asText(), wechsel, alt);
        root.update("UPDATE geraet_komponente SET gueltig_bis = ? WHERE geraet_id = ?", wechsel, alt);
        UUID neu = root.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, seriennummer, geraete_id, eingebaut_am) VALUES (?, ?, 'GR-4', ?, 'zaehler', ?, ?, ?) "
                + "RETURNING id", UUID.class, ah.tenant(), ah.anlagen().get("AN-1"),
                z5b.get("kennzeichen").asText(), z5b.get("seriennummer").asText(),
                gr4.get("modbus_geraete_id").asInt(), ts(z5b.get("gueltig_ab")));
        root.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, gueltig_ab) VALUES (?, ?, ?, ?)",
                ah.tenant(), neu, ah.komponenten().get("K-5"), ts(z5b.get("gueltig_ab")));
    }

    /** Eine Komponente der Referenz ab Beginn ihres Verlaufs; ihr Gerät legt der Anlege-Weg an. */
    private static UUID komponente(UUID tenant, UUID anlage, JsonNode k) {
        UUID box = box(tenant, anlage);
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, communication, connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, "
                + "'modbus-generic', ?, 'modbus_tcp', ?::jsonb, ?) RETURNING id", UUID.class, tenant, anlage,
                k.get("name").asText(), box,
                "{\"unit_id\":" + Math.abs(k.get("kennzeichen").asText().hashCode() % 240) + "}",
                ts(k.get("in_betrieb_ab")));
    }

    private static final Map<UUID, UUID> BOXEN = new ConcurrentHashMap<>();

    /** Die Box der Anlage, die die Kanäle liest — eine je Anlage. */
    private static UUID box(UUID tenant, UUID anlage) {
        return BOXEN.computeIfAbsent(anlage, a -> root.queryForObject("INSERT INTO device (tenant_id, site_id, "
                + "external_ref) VALUES (?, ?, ?) RETURNING id", UUID.class, tenant, a, "VP-BOX-" + a));
    }

    /** Die Mess-Selektion des Kanals und die führende Quelle der Hauptgröße über {@code POST …/quellen}. */
    private void quelleBinden(Anrufer wer, String messstelleId, JsonNode messstelle, UUID komponente, String ab,
            Double endstand) {
        String kanal = kanalFuer(messstelle);
        UUID anlage = root.queryForObject("SELECT site_id FROM measurement_point WHERE id = ?", UUID.class,
                komponente);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), '2026.08.26.3', "
                + "'test', 'pending_edge', 'energy_counter', 'fifteen_minute') ON CONFLICT DO NOTHING",
                wer.kundenbereich(), anlage, box(wer.kundenbereich(), anlage), komponente, kanal);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("komponente", komponente.toString());
        body.put("kanal", kanal);
        body.put("rolle", "fuehrend");
        body.put("gueltig_ab", ab);
        if (endstand != null) {
            body.put("endstand_vorgaenger", Map.of("wert", endstand, "einheit", "kWh"));
        }
        ok201(rufe(HttpMethod.POST, "/messstellen/" + messstelleId + "/quellen", wer, body));
    }

    /** Legt die Messstelle der Referenz unter ihrem Kennzeichen an; liefert die ID. */
    private String anlegen(Anrufer wer, JsonNode m) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", m.get("kennzeichen").asText());
        body.put("name", m.get("name").asText());
        body.put("art", m.get("art").asText());
        body.put("medium", m.get("medium").asText());
        body.put("hauptgroesse", groesseAus(m.get("hauptgroesse")));
        List<JsonNode> neben = new ArrayList<>();
        m.get("nebengroessen").forEach(n -> neben.add(groesseAus(n)));
        body.put("nebengroessen", neben);
        return ok201(rufe(HttpMethod.POST, "/messstellen", wer, body)).get("id").asText();
    }

    private static JsonNode groesseAus(JsonNode g) {
        ObjectNode n = MAPPER.createObjectNode();
        for (String f : List.of("groesse", "richtung", "einheit", "wertart")) {
            n.put(f, g.get(f).asText());
        }
        return n;
    }

    /** Der Messwert, aus dem die Hauptgröße gelesen wird (Katalog-Punkt, Passung des Vertrags). */
    private static String kanalFuer(JsonNode messstelle) {
        return switch (messstelle.at("/hauptgroesse/richtung").asText()) {
            case "Abgabe" -> ENERGIE_ABGABE;
            case "Erzeugung" -> ERZEUGUNG;
            case "Laden / Entladen" -> SPEICHERLEISTUNG;
            default -> ENERGIE_BEZUG;
        };
    }

    /** Ein Gebäude oder Bereich der Referenz an einem Standort ODER Gebäude ab {@code ab}. */
    private static UUID neuerOrt(UUID tenant, String kurzzeichen, UUID standort, UUID gebaeude, String ab) {
        boolean istGebaeude = kurzzeichen.startsWith("G-");
        JsonNode o = element(referenz.get(istGebaeude ? "gebaeude" : "bereiche"), kurzzeichen);
        UUID id = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, ?, ?, ?, 'aktiv') RETURNING id", UUID.class, tenant,
                istGebaeude ? "gebaeude" : "bereich", o.get("name").asText(), kurzzeichen);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, eltern_ort_id, gueltig_ab) "
                + "VALUES (?,?,?,?,?)", tenant, id, standort, gebaeude, LocalDate.parse(ab));
        return id;
    }

    /** Die Anfrage eines Standorts mit den Werten des Referenzunternehmens. */
    private static Map<String, Object> standortAnfrage(String kurzzeichen) {
        JsonNode st = element(referenz.get("standorte"), kurzzeichen);
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", st.get("name").asText());
        b.put("kurzzeichen", kurzzeichen);
        Map<String, Object> adresse = new LinkedHashMap<>();
        for (String feld : List.of("strasse", "plz", "ort", "land")) {
            adresse.put(feld, st.at("/adresse/" + feld).isNull() ? null : st.at("/adresse/" + feld).asText());
        }
        b.put("adresse", adresse);
        b.put("zeitzone", st.get("zeitzone").asText());
        return b;
    }

    // ---- Gerüst: das Werk für die Laufzeit ------------------------------------------------------

    /**
     * Ein Kundenbereich mit {@code zahl} vollständig verdrahteten Messstellen: ein Standort, ein
     * Gebäude, eine Anlage, je Messstelle eine Komponente mit ihrem Gerät, ein Ort, eine Stellung
     * und ZWEI führende Quellen (eine beendete und die laufende — damit auch „davor“ zu tun hat).
     */
    private Anrufer werk(String name, int zahl) {
        UUID t = neuerKundenbereich(name);
        Anrufer wer = new Anrufer("admin", t);
        standortService.uhrStellen(uhr("2024-03-12T09:00:00+01:00"));
        UUID standort = UUID.fromString(ok201(rufe(HttpMethod.POST, "/standorte", wer,
                Map.of("name", name, "kurzzeichen", "ST-1", "zeitzone", "Europe/Berlin", "adresse",
                        Map.of("strasse", "Gewerbering 7", "plz", "12345", "ort", "Ahrenberg", "land", "DE"))))
                .get("id").asText());
        standortService.uhrStellen(Clock.systemUTC());
        UUID gebaeude = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'gebaeude', 'Halle', 'G-1', 'aktiv') RETURNING id", UUID.class, t);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?,?,?,?)",
                t, gebaeude, standort, LocalDate.parse("2024-03-12"));
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name, created_at) VALUES (?, ?, ?) "
                + "RETURNING id", UUID.class, t, name, Timestamp.from(Instant.parse("2024-03-12T00:00:00Z")));
        UUID box = box(t, anlage);
        String erste = null;
        for (int i = 1; i <= zahl; i++) {
            String kennzeichen = String.format("MS-%04d", i);
            UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                    + "entity_type, device_id, communication, connection_json, created_at) VALUES (?, ?, "
                    + "'modbus-generic', ?, 'modbus-generic', ?, 'modbus_tcp', '{\"unit_id\":1}'::jsonb, ?) "
                    + "RETURNING id", UUID.class, t, anlage, "Zähler " + i, box,
                    Timestamp.from(Instant.parse("2024-03-12T00:00:00Z")));
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                    + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                    + "apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), "
                    + "'2026.08.26.3', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute')",
                    t, anlage, box, komponente, ENERGIE_BEZUG);
            UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ?",
                    UUID.class, komponente);
            UUID messstelle = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, "
                    + "medium, groesse, richtung, einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', "
                    + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t, kennzeichen,
                    "Zähler " + i);
            root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, gueltig_ab) VALUES (?,?,?,?)",
                    t, messstelle, gebaeude, LocalDate.parse("2024-03-12"));
            root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, "
                    + "unterzaehler_von, gueltig_ab) VALUES (?,?,?,?,?,?)", t, messstelle, anlage,
                    erste == null ? "Hauptzähler" : "Unterzähler", erste == null ? null : UUID.fromString(erste),
                    LocalDate.parse("2024-03-12"));
            erste = erste == null ? messstelle.toString() : erste;
            for (String[] zeitraum : new String[][] {{"2024-03-12T00:00:00Z", "2026-01-01T00:00:00Z"},
                    {"2026-01-01T00:00:00Z", null}}) {
                root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, "
                        + "geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, gueltig_bis, rueckwirkend, "
                        + "eingetragen_am, actor_name, actor_art) VALUES (?,?,'Wirkenergie','Bezug',?,?,?,'counter',"
                        + "'zaehlerstand','fuehrend',?,?,false,now(),'test','voltpilot')",
                        t, messstelle, komponente, geraet, ENERGIE_BEZUG, Timestamp.from(Instant.parse(zeitraum[0])),
                        zeitraum[1] == null ? null : Timestamp.from(Instant.parse(zeitraum[1])));
            }
        }
        return wer;
    }

    // ---- Gerüst: Soll-Werte aus der Vektor-Datei -------------------------------------------------

    /** Das Kurzzeichen des Orts, an dem die Messstelle an dem Tag sitzt; {@code null} = keiner. */
    private static String ortAm(String messstelle, LocalDate tag) {
        String ort = null;
        for (JsonNode z : referenz.get("zuordnungen")) {
            if (!"messstelle_ort".equals(z.get("art").asText()) || !messstelle.equals(z.get("von").asText())) {
                continue;
            }
            LocalDate ab = LocalDate.parse(z.get("gueltig_ab").asText());
            LocalDate bis = z.get("gueltig_bis").isNull() ? null : LocalDate.parse(z.get("gueltig_bis").asText());
            if (!ab.isAfter(tag) && (bis == null || !tag.isAfter(bis))) {
                ort = z.get("nach").asText();
            }
        }
        return ort;
    }

    /** Der Standort, unter dem der Ort im Baum der Referenz hängt. */
    private static String standortVon(String ortKz) {
        if (ortKz == null || "U".equals(ortKz)) {
            return null;
        }
        String k = ortKz;
        while (!k.startsWith("ST-")) {
            String eltern = null;
            for (JsonNode z : referenz.get("zuordnungen")) {
                if ("ort_eltern".equals(z.get("art").asText()) && k.equals(z.get("von").asText())
                        && !z.get("nach").isNull()) {
                    eltern = z.get("nach").asText();
                }
            }
            assertThat(eltern).as("Eltern von " + k).isNotNull();
            k = eltern;
        }
        return k;
    }

    private static String ortName(String kz) {
        JsonNode o = kz.startsWith("ST-") ? element(referenz.get("standorte"), kz)
                : kz.startsWith("G-") ? element(referenz.get("gebaeude"), kz)
                : element(referenz.get("bereiche"), kz);
        return o.get("name").asText();
    }

    private static JsonNode stellungAm(JsonNode messstelle, LocalDate tag) {
        for (JsonNode s : messstelle.get("elektrische_stellung")) {
            LocalDate ab = LocalDate.parse(s.get("gueltig_ab").asText());
            LocalDate bis = s.get("gueltig_bis").isNull() ? null : LocalDate.parse(s.get("gueltig_bis").asText());
            if (!ab.isAfter(tag) && (bis == null || !tag.isAfter(bis))) {
                return s;
            }
        }
        return null;
    }

    /** Die führende Quelle der Referenz, die zu dem Zeitpunkt läuft — oder keine. */
    private static JsonNode quelleAm(JsonNode messstelle, String zeitpunkt) {
        Instant t = OffsetDateTime.parse(zeitpunkt).toInstant();
        for (JsonNode q : messstelle.get("fuehrende_quelle")) {
            Instant ab = OffsetDateTime.parse(q.get("gueltig_ab").asText()).toInstant();
            Instant bis = q.get("gueltig_bis").isNull() ? null
                    : OffsetDateTime.parse(q.get("gueltig_bis").asText()).toInstant();
            if (!ab.isAfter(t) && (bis == null || bis.isAfter(t))) {
                return q;
            }
        }
        return null;
    }

    // ---- Gerüst: Anfragen -----------------------------------------------------------------------

    private JsonNode register(Anrufer wer, String abfrage) {
        return ok(rufe(HttpMethod.GET, "/messstellen" + abfrage, wer));
    }

    private static List<String> kennzeichen(JsonNode antwort) {
        List<String> out = new ArrayList<>();
        antwort.get("register").forEach(z -> out.add(z.get("kennzeichen").asText()));
        return out;
    }

    private static JsonNode zeile(JsonNode antwort, String kennzeichen) {
        for (JsonNode z : antwort.get("register")) {
            if (kennzeichen.equals(z.get("kennzeichen").asText())) {
                return z;
            }
        }
        throw new AssertionError("keine Zeile " + kennzeichen);
    }

    private UUID neuerKundenbereich(String name) {
        ResponseEntity<JsonNode> r = rufeApi(HttpMethod.POST, "/api/v1/admin/tenants", ADMIN_OHNE_KUNDENBEREICH,
                Map.of("name", name));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return UUID.fromString(r.getBody().get("id").asText());
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer) {
        return rufeApi(methode, "/api/v1" + pfad, wer, null);
    }

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer, Object body) {
        return rufeApi(methode, "/api/v1" + pfad, wer, body);
    }

    private ResponseEntity<JsonNode> rufeApi(HttpMethod methode, String pfad, Anrufer wer, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token(wer.benutzer()));
        if (wer.kundenbereich() != null) {
            headers.set("X-Tenant-Id", wer.kundenbereich().toString());
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return rest.exchange("http://localhost:" + port + pfad, methode, entity, JsonNode.class);
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(200);
        return r.getBody();
    }

    private static JsonNode ok201(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return r.getBody();
    }

    private static void abgelehnt(ResponseEntity<JsonNode> r, String feld) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(400);
        assertThat(r.getBody().get("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(r.getBody().get("feld").asText()).isEqualTo(feld);
        assertThat(r.getBody().get("message").asText()).isNotBlank();
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

    // ---- Gerüst: Kleinkram ----------------------------------------------------------------------

    private static Map<String, Object> anfrage(String... paare) {
        Map<String, Object> body = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            body.put(paare[i], paare[i + 1]);
        }
        return body;
    }

    private static Clock uhr(String zeitpunkt) {
        return Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), ZoneOffset.UTC);
    }

    private static void uhr(MessstelleQuelleService dienst, String zeitpunkt) {
        dienst.uhrStellen(uhr(zeitpunkt));
    }

    private static JsonNode referenzMessstelle(String kennzeichen) {
        return element(referenz.get("messstellen"), kennzeichen);
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode n : liste) {
            if (kennzeichen.equals(n.get("kennzeichen").asText())) {
                return n;
            }
        }
        throw new AssertionError("unbekanntes Kennzeichen: " + kennzeichen);
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static Timestamp ts(JsonNode n) {
        return Timestamp.from(OffsetDateTime.parse(n.asText()).toInstant());
    }
}
