package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
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
 * Der Zählerwechsel als EIN Vorgang (UEMS AP-04 IP-17) Ende zu Ende gegen echtes Keycloak +
 * TimescaleDB: {@code POST /api/v1/messstellen/{id}/quellen/wechsel} und
 * {@code POST /api/v1/geraete/{id}/austausch}. Anlage, Komponenten, Geräte, Kennzeichen, Werte und
 * Zeitpunkte sind die des Referenzunternehmens ({@code uems-referenzunternehmen.json}, Fassung
 * 1.1) — die EINZIGE Beispielquelle; die Urteile die des Vertrags
 * ({@code messstelle-vectors.json}).
 *
 * <p>Bewiesen wird:
 * <ul>
 *   <li><b>der MS-06-Zeitstrahl (A1/A2)</b>: Wechsel Z-5a → Z-5b am 18.11.2026 10:40, eingetragen
 *       um 11:05, also rückwirkend (25 min) — in EINEM Aufruf: Ausbau, Einbau, Bindungswechsel,
 *       Ablesestände, Protokoll, Marke;</li>
 *   <li><b>die Werte-Lücke (A16)</b>: die letzten Werte von Z-5a liegen um 10:40, die ersten von
 *       Z-5b um 10:47; die sieben Minuten dazwischen bleiben leer und werden nie aufgefüllt. Jeder
 *       Wert vor 10:40 fällt in die Bindung von Z-5a, jeder ab 10:47 in die von Z-5b;</li>
 *   <li><b>der Oktober-Rollup bleibt byte-gleich</b> — der Bestandsschutz-Nachweis: der Wechsel
 *       ändert KEINEN gespeicherten Messwert;</li>
 *   <li>die <b>Beobachtung aus IP-15 sagt von selbst</b> „wartet auf erste Daten von Z-5b" — ohne
 *       dass dieser Vorgang etwas daran tut;</li>
 *   <li>der <b>zweite Einstieg</b> am Gerät macht denselben Vorgang — samt Vergleichsquelle,
 *       übernommenen Einstellungen und einer wirklich neuen Verbindung (dann, und nur dann, eine
 *       neue Komponenten-Fassung);</li>
 *   <li>jede <b>Ablehnung des Vertrags</b>: Zeitpunkt vor dem Einbau (A15) und genau auf ihm, ein
 *       schon ausgebautes Gerät, eine schon beendete Bindung, eine archivierte Messstelle, ein
 *       belegtes Kennzeichen, ein Controller mit Karten (IP-19);</li>
 *   <li><b>alles oder nichts</b>: scheitert der letzte Schritt in der Transaktion, ist KEINE
 *       Wirkung übrig;</li>
 *   <li>der <b>Mandantenzaun</b>: fremd ist 404, nie 403 — und die Antwort trägt genau die Felder
 *       der OpenAPI.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ZaehlerwechselApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path CONTRACTS = Path.of("..", "..", "docs", "contracts");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final UUID DEMO_KUNDENBEREICH = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String ENERGIE_BEZUG = "sunspec.model_203.totwhimp";
    private static final String ENERGIE_ABGABE = "sunspec.model_203.totwhexp";
    private static final String LEISTUNG_VORZEICHEN = "sunspec.model_203.w";
    private static final String SPANNUNG = "sunspec.model_203.phv";

    /** Der Wechsel des Referenzunternehmens und die Minute, in der er eingetragen wird (§5.13/§5.14). */
    private static final String WECHSEL = "2026-11-18T10:40:00+01:00";
    private static final String EINGETRAGEN = "2026-11-18T11:05:00+01:00";
    /** Die ersten Werte von Z-5b (die Lücke 10:40–10:47 bleibt sichtbar). */
    private static final String ERSTE_WERTE_Z5B = "2026-11-18T10:47:00+01:00";

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

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    MessstelleQuelleService quellen;

    @Autowired
    ZaehlerwechselService wechsel;

    @Autowired
    MessstelleRegisterService register;

    @Autowired
    WechselzeitpunktService berichtigung;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Anrufer DEMO = new Anrufer("demo", null);
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
        quellen.uhrStellen(Clock.systemUTC());
        wechsel.uhrStellen(Clock.systemUTC());
        berichtigung.uhrStellen(Clock.systemUTC());
        berichtigung.letzterSchritt(() -> { });
        wechsel.letzterSchritt(() -> { });
        register.uhrStellen(Clock.systemUTC());
    }

    // ---- A1/A2/A16: der MS-06-Zeitstrahl in EINEM Aufruf ---------------------------------------

    /**
     * DER Plan-Fall (A1/A2/A16, §5.13/§5.14): Ines Kaltenbach trägt am 18.11.2026 um 11:05 den
     * Zählerwechsel Z-5a → Z-5b für 10:40 ein — aus der Messstelle heraus, in EINEM Aufruf. Danach
     * ist Z-5a ausgebaut, Z-5b eingebaut, die Bindung endet und beginnt genau um 10:40, die
     * Ablesestände stehen, das Protokoll trägt den Vorgang rückwirkend, die Marke steht im
     * Komponenten-Verlauf — und KEIN gespeicherter Messwert hat sich bewegt.
     */
    @Test
    void derZaehlerwechselVonMs06IstEinVorgang() {
        Werk w = ahrenberg("MS-06 ein Vorgang");
        String ms06 = messstelleMs06(w);
        bindeMs06(w, ms06);
        messwerte(w);
        String vorher = messwerteHash(w.tenant());
        String oktoberVorher = oktoberHash(w.tenant());
        assertThat(oktoberVorher).isNotBlank();

        JsonNode z5aRef = element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5a");
        JsonNode z5bRef = element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5b");

        uhr(EINGETRAGEN);
        Map<String, Object> anfrage = wechselAnfrage(WECHSEL, z5bRef);
        anfrage.put("endstand_vorgaenger", stand(z5aRef.get("endstand_kwh").asDouble(), "kWh"));
        anfrage.put("anfangsstand", stand(z5bRef.get("anfangsstand_kwh").asDouble(), "kWh"));
        anfrage.put("grund", "Zähler defekt");
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST,
                "/api/v1/messstellen/" + ms06 + "/quellen/wechsel", w.admin(), anfrage);
        JsonNode v = erfolgreich(r);

        // Das Gerät: EIN Kennzeichen (GR-4), zwei Einbauten — der alte ausgebaut, der neue eingebaut.
        assertThat(v.at("/geraet/alt/geraet").asText()).isEqualTo("GR-4");
        assertThat(v.at("/geraet/alt/einbau").asText()).isEqualTo("Z-5a");
        assertThat(v.at("/geraet/alt/seriennummer").asText()).isEqualTo(z5aRef.get("seriennummer").asText());
        assertThat(zeitpunkt(v.at("/geraet/alt/ausgebaut_am"))).isEqualTo(zeitpunkt(WECHSEL));
        assertThat(v.at("/geraet/neu/geraet").asText()).isEqualTo("GR-4");
        assertThat(v.at("/geraet/neu/einbau").asText()).isEqualTo("Z-5b");
        assertThat(v.at("/geraet/neu/seriennummer").asText()).isEqualTo(z5bRef.get("seriennummer").asText());
        assertThat(zeitpunkt(v.at("/geraet/neu/eingebaut_am"))).isEqualTo(zeitpunkt(WECHSEL));
        assertThat(v.at("/geraet/neu/ausgebaut_am").isNull()).isTrue();
        assertThat(v.at("/geraet/verbindung_neu").asBoolean()).as("gleiche Quelle und Geräte-ID").isFalse();
        assertThat(v.get("komponenten")).hasSize(1);
        assertThat(v.at("/komponenten/0").asText()).isEqualTo(w.k("K-5").toString());

        // Die Bindung: endet und beginnt GENAU zum Wechselzeitpunkt, mit den Ablesenständen.
        assertThat(v.get("bindungen")).hasSize(1);
        JsonNode b = v.at("/bindungen/0");
        assertThat(b.get("kennzeichen").asText()).isEqualTo("MS-06");
        assertThat(b.get("rolle").asText()).isEqualTo("fuehrend");
        assertThat(b.at("/beendet/geraet/einbau").asText()).isEqualTo("Z-5a");
        assertThat(zeitpunkt(b.at("/beendet/gueltig_bis"))).isEqualTo(zeitpunkt(WECHSEL));
        assertThat(b.at("/beendet/endstand/wert").asDouble()).isEqualTo(z5aRef.get("endstand_kwh").asDouble());
        assertThat(b.at("/beendet/endstand/einheit").asText()).isEqualTo("kWh");
        assertThat(b.at("/beendet/status").asText()).isEqualTo("beendet");
        assertThat(b.at("/neu/geraet/einbau").asText()).isEqualTo("Z-5b");
        assertThat(zeitpunkt(b.at("/neu/gueltig_ab"))).isEqualTo(zeitpunkt(WECHSEL));
        assertThat(b.at("/neu/gueltig_bis").isNull()).isTrue();
        assertThat(b.at("/neu/anfangsstand/wert").asDouble()).isEqualTo(z5bRef.get("anfangsstand_kwh").asDouble());
        assertThat(b.at("/neu/rueckwirkend").asBoolean()).isTrue();
        assertThat(b.at("/neu/herleitung").asText()).isEqualTo("zaehlerstand");

        // Rückwirkend (25 min) — derselbe Vektor, den die Quellenbindung schon fährt.
        assertThat(v.get("rueckwirkung")).isEqualTo(fall("rueckwirkung", "ms-06-wechsel-25-minuten").get("expected"));
        assertThat(v.get("hinweise")).isEmpty();
        assertThat(v.get("marken").asInt()).isEqualTo(1);
        assertThat(v.get("einstellungen")).isEmpty();

        // Der Zeitstrahl der Messstelle ist GENAU der der Referenzdatei — ohne Fuge um 10:40.
        JsonNode referenzQuellen = referenzMessstelle("MS-06").get("fuehrende_quelle");
        JsonNode liste = ok(rufe(HttpMethod.GET, "/api/v1/messstellen/" + ms06 + "/quellen", w.admin(), null));
        JsonNode strahl = liste.at("/groessen/0/zeitstrahl");
        assertThat(strahl).hasSize(referenzQuellen.size());
        for (int i = 0; i < referenzQuellen.size(); i++) {
            JsonNode q = referenzQuellen.get(i);
            JsonNode abschnitt = strahl.get(i);
            assertThat(abschnitt.get("quelle").isNull()).as("keine Bindungslücke").isFalse();
            assertThat(zeitpunkt(abschnitt.get("von"))).isEqualTo(zeitpunkt(q.get("gueltig_ab")));
            assertThat(q.get("gueltig_bis").isNull() ? abschnitt.get("bis").isNull()
                    : zeitpunkt(abschnitt.get("bis")).equals(zeitpunkt(q.get("gueltig_bis")))).isTrue();
            JsonNode quelle = quelleMitId(liste, abschnitt.get("quelle").asText());
            assertThat(quelle.at("/geraet/einbau").asText()).isEqualTo(q.get("einbau").asText());
            assertThat(quelle.at("/geraet/geraet").asText()).isEqualTo(q.get("geraet").asText());
            assertThat(quelle.get("kanal_wertart").asText()).isEqualTo(q.get("kanal_wertart").asText());
        }

        // Das Gerät nennt seinen Vorgänger (IP-10, unverändert).
        JsonNode neuesGeraet = ok(rufe(HttpMethod.GET, "/api/v1/geraete/" + v.at("/geraet/neu/id").asText(),
                w.admin(), null));
        assertThat(neuesGeraet.at("/vorgaenger/0/einbau_kennzeichen").asText()).isEqualTo("Z-5a");
        assertThat(zeitpunkt(neuesGeraet.at("/vorgaenger/0/ausgebaut_am"))).isEqualTo(zeitpunkt(WECHSEL));

        // GENAU EIN Protokolleintrag, mit Urheber, „rückwirkend“ und der Uhr des Schreibwegs.
        List<Map<String, Object>> protokoll = protokoll(ms06).stream()
                .filter(e -> "zaehler_gewechselt".equals(e.get("art"))).toList();
        assertThat(protokoll).hasSize(1);
        Map<String, Object> eintrag = protokoll.get(0);
        assertThat(eintrag.get("rueckwirkend")).isEqualTo(true);
        assertThat(eintrag.get("actor_name")).isEqualTo("admin");
        assertThat(eintrag.get("actor_art")).isEqualTo("voltpilot");
        assertThat(eintrag.get("grund")).isEqualTo("Zähler defekt");
        assertThat(((Timestamp) eintrag.get("created_at")).toInstant()).isEqualTo(zeitpunkt(EINGETRAGEN));
        assertThat(((Timestamp) eintrag.get("gilt_ab")).toInstant()).isEqualTo(zeitpunkt(WECHSEL));
        JsonNode neu = json(eintrag.get("neu"));
        assertThat(neu.get("vorgaenger").asText()).isEqualTo("Z-5a");
        assertThat(neu.get("einbau").asText()).isEqualTo("Z-5b");
        assertThat(neu.get("seriennummer").asText()).isEqualTo(z5bRef.get("seriennummer").asText());
        assertThat(neu.at("/quellen/0/endstand/wert").asDouble()).isEqualTo(z5aRef.get("endstand_kwh").asDouble());
        assertThat(json(eintrag.get("alt")).get("einbau").asText()).isEqualTo("Z-5a");

        // Die MARKE im Komponenten-Verlauf: additiv, mit dem Zeitpunkt des Wechsels.
        Map<String, Object> marke = root.queryForList("SELECT event_type, effective_at, from_value, to_value, note "
                + "FROM component_change_event WHERE tenant_id = ? AND event_type = 'device_replaced'",
                w.tenant()).stream().findFirst().orElseThrow();
        assertThat(marke.get("from_value")).isEqualTo("Z-5a");
        assertThat(marke.get("to_value")).isEqualTo("Z-5b");
        assertThat(((Timestamp) marke.get("effective_at")).toInstant()).isEqualTo(zeitpunkt(WECHSEL));
        assertThat(String.valueOf(marke.get("note"))).contains("Zähler gewechselt");

        // ⚠ DER Bestandsschutz-Nachweis: kein gespeicherter Messwert hat sich bewegt.
        assertThat(oktoberHash(w.tenant())).as("Oktober-Rollup byte-gleich").isEqualTo(oktoberVorher);
        assertThat(messwerteHash(w.tenant())).as("keine Messreihe berührt").isEqualTo(vorher);

        // A16: die Lücke 10:40–10:47 bleibt leer — nie interpoliert, nie eine 0.
        assertThat(anzahl("SELECT count(*) FROM device_measurement_sample WHERE tenant_id = ? AND time >= ? "
                + "AND time < ?", w.tenant(), Timestamp.from(zeitpunkt(WECHSEL)),
                Timestamp.from(zeitpunkt(ERSTE_WERTE_Z5B))))
                .as("keine Quelle liefert zwischen 10:40 und 10:47").isZero();

        // Jeder Wert vor 10:40 gehört zur Bindung von Z-5a, jeder ab 10:47 zu der von Z-5b.
        WERTE_Z5A.forEach(t -> assertThat(bindungZu(ms06, t)).as(t).isEqualTo("Z-5a"));
        WERTE_Z5B.forEach(t -> assertThat(bindungZu(ms06, t)).as(t).isEqualTo("Z-5b"));

        // Die Beobachtung (IP-15) sagt von selbst „wartet auf erste Daten von Z-5b“ — unverändert.
        register.uhrStellen(Clock.fixed(zeitpunkt("2026-11-18T10:45:00+01:00"), BERLIN));
        JsonNode zeile = registerZeile(w, "MS-06");
        assertThat(zeile.at("/beobachtung/zustand").asText()).isEqualTo("wartet_auf_erste_daten");
        assertThat(zeile.at("/beobachtung/geraet").asText()).isEqualTo("Z-5b");
        assertThat(zeile.at("/beobachtung/text").asText()).contains("Z-5b");
        register.uhrStellen(Clock.fixed(zeitpunkt("2026-11-18T10:50:00+01:00"), BERLIN));
        assertThat(registerZeile(w, "MS-06").at("/beobachtung/zustand").asText()).isEqualTo("liefert");
    }

    // ---- Der zweite Einstieg: am Gerät -----------------------------------------------------------

    /**
     * Derselbe Vorgang von der Geräteseite (§5.5 „Gerät austauschen"), diesmal mit allem, was daran
     * hängt: einer Vergleichsquelle an derselben Komponente, einer übernommenen Einstellungs-Fassung
     * und einer WIRKLICH neuen Verbindung — nur dann entsteht eine neue Komponenten-Fassung.
     */
    @Test
    void derWechselAmGeraetIstDerselbeVorgangUndNimmtEinstellungenMit() {
        Werk w = ahrenberg("Gerät austauschen");
        String ms06 = messstelleMs06(w);
        String vergleich = anlegen(w.admin(), messstelle("MS-0099", "Vergleich Spritzguss")).get("id").asText();
        UUID z5a = einbau(w, "Z-5a");
        bindeMs06(w, ms06);
        bindeVergleich(w, vergleich);
        wandlerFassung(w, z5a);
        int fassungVorher = root.queryForObject("SELECT definition_version FROM measurement_point WHERE id = ?",
                Integer.class, w.k("K-5"));

        uhr(EINGETRAGEN);
        Map<String, Object> anfrage = wechselAnfrage(WECHSEL,
                element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5b"));
        anfrage.put("verbindung", Map.of("geraete_id", 7));
        JsonNode v = erfolgreich(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(), anfrage));

        assertThat(v.at("/geraet/alt/einbau").asText()).isEqualTo("Z-5a");
        assertThat(v.at("/geraet/neu/einbau").asText()).isEqualTo("Z-5b");
        assertThat(v.at("/geraet/verbindung_neu").asBoolean()).as("andere Geräte-ID").isTrue();

        // BEIDE Bindungen ziehen mit — die führende von MS-06 und die Vergleichsquelle von MS-0099.
        assertThat(v.get("bindungen")).hasSize(2);
        List<String> kennzeichen = new ArrayList<>();
        v.get("bindungen").forEach(b -> kennzeichen.add(b.get("kennzeichen").asText() + "/" + b.get("rolle").asText()));
        assertThat(kennzeichen).containsExactlyInAnyOrder("MS-06/fuehrend", "MS-0099/vergleich");
        v.get("bindungen").forEach(b -> {
            assertThat(zeitpunkt(b.at("/beendet/gueltig_bis"))).isEqualTo(zeitpunkt(WECHSEL));
            assertThat(zeitpunkt(b.at("/neu/gueltig_ab"))).isEqualTo(zeitpunkt(WECHSEL));
            assertThat(b.at("/neu/geraet/einbau").asText()).isEqualTo("Z-5b");
        });
        // Der Zweck der Vergleichsquelle reist mit — er gehört zur Bindung, nicht zum Gerät.
        v.get("bindungen").forEach(b -> {
            if ("vergleich".equals(b.get("rolle").asText())) {
                assertThat(b.at("/neu/zweck").asText()).isEqualTo("Plausibilität");
            }
        });

        // Die Einstellung ist übernommen: dieselbe Art, derselbe Wert — am NEUEN Einbau, ab 10:40.
        assertThat(v.get("einstellungen")).hasSize(1);
        assertThat(v.at("/einstellungen/0/art").asText()).isEqualTo("wandler_strom");
        UUID neuId = UUID.fromString(v.at("/geraet/neu/id").asText());
        Map<String, Object> fassung = root.queryForList("SELECT art, wert::text AS wert, anwendung, herkunft, "
                + "gueltig_ab, gueltig_bis, rueckwirkend, begruendung FROM quelle_einstellung WHERE geraet_id = ?",
                neuId).stream().findFirst().orElseThrow();
        assertThat(fassung.get("art")).isEqualTo("wandler_strom");
        assertThat(json(fassung.get("wert")).get("primaer_a").asInt()).isEqualTo(150);
        assertThat(fassung.get("anwendung")).isEqualTo("dokumentiert");
        assertThat(((Timestamp) fassung.get("gueltig_ab")).toInstant()).isEqualTo(zeitpunkt(WECHSEL));
        assertThat(fassung.get("gueltig_bis")).isNull();
        assertThat(String.valueOf(fassung.get("begruendung"))).contains("Z-5a");
        // Die Fassung am ALTEN Einbau bleibt unangetastet — nichts wird überschrieben.
        assertThat(anzahl("SELECT count(*) FROM quelle_einstellung WHERE geraet_id = ? AND gueltig_bis IS NULL",
                z5a)).isOne();

        // Die neue Verbindung steht als KOMPONENTEN-FASSUNG: eine Fassung mehr, die neue Geräte-ID drin.
        Map<String, Object> komponente = root.queryForList("SELECT connection_json::text AS verbindung, "
                + "definition_version FROM measurement_point WHERE id = ?", w.k("K-5")).get(0);
        assertThat(json(komponente.get("verbindung")).get("unit_id").asInt()).isEqualTo(7);
        assertThat((Integer) komponente.get("definition_version")).isEqualTo(fassungVorher + 1);
        assertThat(anzahl("SELECT count(*) FROM component_definition WHERE entity_id = ? AND version = ?",
                w.k("K-5"), fassungVorher + 1)).isOne();
        assertThat(anzahl("SELECT count(*) FROM component_activation_outbox WHERE entity_id = ? AND revision = ?",
                w.k("K-5"), fassungVorher + 1)).as("die Box erfährt die neue Geräte-ID").isOne();
        // … und das neue Gerät trägt sie ebenfalls.
        assertThat(root.queryForObject("SELECT geraete_id FROM geraet WHERE id = ?", Integer.class, neuId))
                .isEqualTo(7);

        // Je betroffener Messstelle EIN Eintrag — zwei Messstellen, zwei Einträge.
        assertThat(anzahl("SELECT count(*) FROM messstelle_aenderung WHERE tenant_id = ? AND art = ?",
                w.tenant(), "zaehler_gewechselt")).isEqualTo(2);
    }

    /**
     * Ohne Verbindung in der Anfrage bleibt alles, wie es war: „gleiche Datenquelle und Geräte-ID“
     * heißt KEINE neue Komponenten-Fassung (§5.5, Punkt 4 des Lieferumfangs).
     */
    @Test
    void gleicheVerbindungSchreibtKeineNeueKomponentenFassung() {
        Werk w = ahrenberg("gleiche Verbindung");
        String ms06 = messstelleMs06(w);
        UUID z5a = einbau(w, "Z-5a");
        bindeMs06(w, ms06);
        int vorher = root.queryForObject("SELECT definition_version FROM measurement_point WHERE id = ?",
                Integer.class, w.k("K-5"));

        uhr(EINGETRAGEN);
        JsonNode v = erfolgreich(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(),
                wechselAnfrage(WECHSEL, null)));
        assertThat(v.at("/geraet/verbindung_neu").asBoolean()).isFalse();
        assertThat(root.queryForObject("SELECT definition_version FROM measurement_point WHERE id = ?",
                Integer.class, w.k("K-5"))).isEqualTo(vorher);
        // Ohne gewähltes Kennzeichen vergibt der Server eines am Gerät.
        assertThat(v.at("/geraet/neu/einbau").asText()).isEqualTo("GR-4.2");
    }

    /**
     * A3 (§5.12, Vektor {@code ms-06-wechsel-angekuendigt-fuer-den-18-11}): Am 10.11.2026 wird der
     * Wechsel für den 18.11.2026 10:00 ANGEKÜNDIGT. Er ist erlaubt; bis dahin liefert Z-5a, die
     * neue Bindung steht als „geplant", die alte endet dort — nichts gilt schon jetzt.
     */
    @Test
    void einAngekuendigterWechselIstErlaubtUndHeisstGeplant() {
        Werk w = ahrenberg("angekündigt");
        String ms06 = messstelleMs06(w);
        UUID z5a = einbau(w, "Z-5a");
        bindeMs06(w, ms06);

        JsonNode vektor = fall("wechsel", "ms-06-wechsel-angekuendigt-fuer-den-18-11");
        String jetzt = vektor.at("/input/jetzt").asText();
        String angekuendigtFuer = vektor.at("/input/zeitpunkt").asText();
        uhr(jetzt);
        JsonNode v = erfolgreich(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(),
                wechselAnfrage(angekuendigtFuer,
                        element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5b"))));

        assertThat(v.at("/rueckwirkung/art").asText()).isEqualTo("angekuendigt");
        assertThat(v.at("/rueckwirkung/abzeichen").isNull()).as("nur Rückwirkung trägt ein Abzeichen").isTrue();
        assertThat(v.at("/bindungen/0/neu/status").asText()).isEqualTo("geplant");
        assertThat(v.at("/bindungen/0/neu/rueckwirkend").asBoolean()).isFalse();
        assertThat(zeitpunkt(v.at("/geraet/neu/eingebaut_am"))).isEqualTo(zeitpunkt(angekuendigtFuer));
        assertThat(zeitpunkt(v.at("/geraet/alt/ausgebaut_am"))).isEqualTo(zeitpunkt(angekuendigtFuer));

        // Bis dahin liefert Z-5a: zum Stichtag „jetzt" führt noch der alte Einbau.
        assertThat(bindungZu(ms06, jetzt)).isEqualTo("Z-5a");
        assertThat(bindungZu(ms06, angekuendigtFuer)).isEqualTo("Z-5b");
        // Das Protokoll trägt ihn NICHT als rückwirkend.
        assertThat(protokoll(ms06).stream().filter(e -> "zaehler_gewechselt".equals(e.get("art"))).toList())
                .singleElement().satisfies(e -> assertThat(e.get("rueckwirkend")).isEqualTo(false));
    }

    @Test
    void a3AngekuendigtenWechselzeitpunktKorrigieren() {
        Werk w = ahrenberg("A3"); String ms = messstelleMs06(w); UUID alt = einbau(w, "Z-5a");
        bindeMs06(w, ms); wandlerFassung(w, alt);
        // Die DB-Sperre nutzt die echte Uhr: dieser Fall bleibt auch nach dem Referenzjahr zukünftig.
        int jahr = java.time.Year.now().getValue() + 1;
        String vorher = jahr + "-11-18T10:00:00+01:00", nachher = jahr + "-11-18T10:40:00+01:00";
        uhr(jahr + "-11-10T09:00:00+01:00");
        JsonNode v = erfolgreich(rufe(HttpMethod.POST, "/api/v1/geraete/" + alt + "/austausch", w.admin(),
                wechselAnfrage(vorher, element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5b"))));
        UUID neu = UUID.fromString(v.at("/geraet/neu/id").asText());
        String pfad = "/api/v1/geraete/" + alt + "/austausch/zeitpunkt";
        long journal = anzahl("SELECT count(*) FROM component_change_event WHERE tenant_id=?", w.tenant());
        var body = Map.of("bisher", vorher, "zeitpunkt", nachher, "grund", "Montage beginnt später");
        JsonNode antwort = ok(rufe(HttpMethod.POST, pfad, w.admin(), body));
        assertThat(zeitpunkt(antwort.get("zeitpunkt"))).isEqualTo(zeitpunkt(nachher));
        assertThat(bindungZu(ms, vorher)).isEqualTo("Z-5a");
        assertThat(bindungZu(ms, nachher)).isEqualTo("Z-5b");
        assertThat(root.queryForObject("SELECT ausgebaut_am FROM geraet WHERE id=?", Timestamp.class, alt))
                .isEqualTo(Timestamp.from(zeitpunkt(nachher)));
        for (String t : List.of("geraet_komponente", "messstelle_quelle", "quelle_einstellung"))
            assertThat(anzahl("SELECT count(*) FROM " + t + " WHERE geraet_id=? AND gueltig_ab=?", neu, Timestamp.from(zeitpunkt(nachher))))
                    .as(t).isPositive();
        assertThat(protokoll(ms).stream().filter(e -> "zaehler_gewechselt".equals(e.get("art")))).hasSize(2);
        assertThat(anzahl("SELECT count(*) FROM component_change_event WHERE tenant_id=?", w.tenant())).isEqualTo(journal + 1);
        assertThat(anzahl("SELECT count(*) FROM component_change_event WHERE tenant_id=? AND event_type='device_replaced' AND effective_at=?",
                w.tenant(), Timestamp.from(zeitpunkt(vorher)))).isEqualTo(1);
        // Die Gegenrichtung muss ebenfalls ohne Exklusions-Konflikt funktionieren.
        ok(rufe(HttpMethod.POST, pfad, w.admin(), Map.of("bisher", nachher, "zeitpunkt", vorher)));
        assertThat(bindungZu(ms, vorher)).isEqualTo("Z-5b");
        // Letzter Schritt scheitert: Grenzen UND beide Journale rollen zurück.
        berichtigung.letzterSchritt(() -> { throw new IllegalStateException("A3 Rollback"); });
        assertThat(status(rufe(HttpMethod.POST, pfad, w.admin(), body))).isEqualTo(500);
        berichtigung.letzterSchritt(() -> { });
        assertThat(bindungZu(ms, vorher)).isEqualTo("Z-5b");
        assertThat(protokoll(ms).stream().filter(e -> "zaehler_gewechselt".equals(e.get("art")))).hasSize(3);
        assertThat(status(rufe(HttpMethod.POST, pfad, DEMO, body))).isEqualTo(404);
        // Bereits wirksam: expliziter Korrekturweg, keine neue Protokollzeile.
        berichtigung.uhrStellen(Clock.fixed(zeitpunkt(vorher), BERLIN));
        var wirksam = rufe(HttpMethod.POST, pfad, w.admin(), body);
        assertThat(status(wirksam)).isEqualTo(409);
        assertThat(wirksam.getBody().path("grund").asText()).isEqualTo("wechsel_bereits_wirksam");
        assertThat(wirksam.getBody().path("satz").asText()).contains("Korrekturweg");
        berichtigung.uhrStellen(Clock.systemUTC());
        // Unplausible vorgezogene Messwerte sperren trotz Zukunft.
        root.update("INSERT INTO telemetry_v2 (time,received_at,tenant_id,site_id,device_id,entity_id,channel,value) VALUES (?,?,?,?,?,?,?,?)",
                Timestamp.from(zeitpunkt(jahr + "-11-18T10:20:00+01:00")), Timestamp.from(Instant.now()),
                w.tenant(), w.an1(), w.box(), w.k("K-5").toString(), ENERGIE_BEZUG, 123);
        var werte = rufe(HttpMethod.POST, pfad, w.admin(), body);
        assertThat(status(werte)).isEqualTo(409);
        assertThat(werte.getBody().path("grund").asText()).isEqualTo("messwerte_im_zeitraum");
        // DB schützt auch einen direkten Schreibweg außerhalb des Dienstes.
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> root.update(
                "UPDATE geraet SET eingebaut_am=? WHERE id=?", Timestamp.from(Instant.parse("2020-01-01T00:00:00Z")), neu))
                .hasMessageContaining("Nur ein noch nicht wirksamer Wechsel");
    }

    // ---- Die Ablehnungen sind Teil des Vertrags ---------------------------------------------------

    /**
     * §5.12 und die Vektoren der Familie {@code wechsel}: jede Ablehnung nennt Grund und Zeitpunkt
     * in Kundensprache — und schreibt NICHTS.
     */
    @Test
    void jedeAblehnungNenntGrundUndZeitpunktUndSchreibtNichts() {
        Werk w = ahrenberg("Ablehnungen");
        String ms06 = messstelleMs06(w);
        UUID z5a = einbau(w, "Z-5a");
        bindeMs06(w, ms06);
        uhr(EINGETRAGEN);
        long geraeteVorher = anzahl("SELECT count(*) FROM geraet WHERE tenant_id = ?", w.tenant());
        long eintraegeVorher = eintraege(w.tenant());

        // A15: vor dem Einbau von Z-5a (12.03.2024) — und genau auf ihm (Einbau von null Minuten).
        for (String zeitpunkt : List.of("2024-03-01T00:00:00+01:00", "2024-03-12T00:00:00+01:00")) {
            ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch",
                    w.admin(), wechselAnfrage(zeitpunkt, null));
            abgelehnt(r, 422, "zeitpunkt_vor_vorgaenger");
            assertThat(r.getBody().get("message").asText()).contains("Z-5a").contains("12.03.2024");
            assertThat(r.getBody().get("einbau").asText()).isEqualTo("Z-5a");
        }

        // Eine archivierte Messstelle bekommt keinen Wechsel.
        root.update("UPDATE messstelle SET archiviert_am = ? WHERE id = ?",
                Timestamp.from(zeitpunkt("2026-11-01T00:00:00+01:00")), UUID.fromString(ms06));
        ResponseEntity<JsonNode> archiviert = rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch",
                w.admin(), wechselAnfrage(WECHSEL, null));
        abgelehnt(archiviert, 409, "zustand_passt_nicht");
        assertThat(archiviert.getBody().get("message").asText()).contains("MS-06").contains("archiviert");
        root.update("UPDATE messstelle SET archiviert_am = NULL WHERE id = ?", UUID.fromString(ms06));

        // Ein belegtes Einbau-Kennzeichen wird nie überschrieben.
        ResponseEntity<JsonNode> belegt = rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch",
                w.admin(), wechselAnfrage(WECHSEL, null, "GR-5"));
        abgelehnt(belegt, 409, "kennzeichen_belegt");

        assertThat(anzahl("SELECT count(*) FROM geraet WHERE tenant_id = ?", w.tenant())).isEqualTo(geraeteVorher);
        assertThat(eintraege(w.tenant())).as("abgelehnt schreibt nichts").isEqualTo(eintraegeVorher);

        // Jetzt der echte Wechsel — und danach der ZWEITE an demselben, ausgebauten Einbau.
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(),
                wechselAnfrage(WECHSEL, element(element(referenz.get("geraete"), "GR-4").get("einbauten"), "Z-5b"))));
        uhr("2026-11-18T11:30:00+01:00");
        ResponseEntity<JsonNode> zweimal = rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch",
                w.admin(), wechselAnfrage("2026-11-18T11:00:00+01:00", null));
        abgelehnt(zweimal, 422, "kein_geraet_zum_zeitpunkt");
        assertThat(zweimal.getBody().get("message").asText()).contains("Z-5a").contains("ausgebaut");
        assertThat(zeitpunkt(zweimal.getBody().get("zeitpunkt"))).isEqualTo(zeitpunkt(WECHSEL));
    }

    /**
     * Eine Bindung, die zum Wechselzeitpunkt schon beendet ist, würde der Wechsel ein zweites Mal
     * beenden — das lehnt er ab (Regel 2: eine Quelle wird genau EINMAL beendet).
     */
    @Test
    void eineBereitsBeendeteBindungWirdNichtZweimalBeendet() {
        Werk w = ahrenberg("bereits beendet");
        String ms06 = messstelleMs06(w);
        UUID z5a = einbau(w, "Z-5a");
        String quelle = bindeMs06(w, ms06);

        // Die Quelle wird von Hand zum 18.11. 11:00 beendet …
        uhr("2026-11-18T12:00:00+01:00");
        ok(rufe(HttpMethod.PUT, "/api/v1/messstellen/" + ms06 + "/quellen/" + quelle + "/beenden", w.admin(),
                Map.of("gueltig_bis", "2026-11-18T11:00:00+01:00")));

        // … und ein Wechsel um 10:40 müsste sie noch einmal beenden.
        uhr(EINGETRAGEN);
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(),
                wechselAnfrage(WECHSEL, null));
        abgelehnt(r, 409, "bindung_bereits_beendet");
        assertThat(r.getBody().get("messstelle").asText()).isEqualTo("MS-06");
        assertThat(root.queryForObject("SELECT ausgebaut_am FROM geraet WHERE id = ?", Timestamp.class, z5a))
                .as("nichts geschrieben").isNull();
    }

    // ---- Alles oder nichts ------------------------------------------------------------------------

    /**
     * Die Eigenschaft, um die es in diesem Paket geht: scheitert der LETZTE Schritt in der
     * Transaktion, ist keine halbe Wirkung übrig — kein Ausbau, kein neues Gerät, keine gewanderte
     * Speisung, keine neue Bindung, kein Protokoll.
     */
    @Test
    void einFehlerImLetztenSchrittLaesstKeineHalbeWirkungZurueck() {
        Werk w = ahrenberg("alles oder nichts");
        String ms06 = messstelleMs06(w);
        UUID z5a = einbau(w, "Z-5a");
        String quelle = bindeMs06(w, ms06);
        long geraeteVorher = anzahl("SELECT count(*) FROM geraet WHERE tenant_id = ?", w.tenant());
        long speisungenVorher = anzahl("SELECT count(*) FROM geraet_komponente WHERE tenant_id = ?", w.tenant());
        long quellenVorher = anzahl("SELECT count(*) FROM messstelle_quelle WHERE tenant_id = ?", w.tenant());
        long eintraegeVorher = eintraege(w.tenant());

        uhr(EINGETRAGEN);
        wechsel.letzterSchritt(() -> {
            throw new IllegalStateException("erzwungener Fehler im letzten Schritt");
        });
        assertThat(status(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(),
                wechselAnfrage(WECHSEL, null)))).isEqualTo(500);

        assertThat(root.queryForObject("SELECT ausgebaut_am FROM geraet WHERE id = ?", Timestamp.class, z5a))
                .as("kein Ausbau").isNull();
        assertThat(anzahl("SELECT count(*) FROM geraet WHERE tenant_id = ?", w.tenant())).isEqualTo(geraeteVorher);
        assertThat(anzahl("SELECT count(*) FROM geraet_komponente WHERE tenant_id = ?", w.tenant()))
                .isEqualTo(speisungenVorher);
        assertThat(anzahl("SELECT count(*) FROM messstelle_quelle WHERE tenant_id = ?", w.tenant()))
                .isEqualTo(quellenVorher);
        assertThat(eintraege(w.tenant())).isEqualTo(eintraegeVorher);
        assertThat(root.queryForObject("SELECT gueltig_bis FROM messstelle_quelle WHERE id = ?", Timestamp.class,
                UUID.fromString(quelle))).as("die Bindung läuft weiter").isNull();
        assertThat(anzahl("SELECT count(*) FROM component_change_event WHERE tenant_id = ?", w.tenant())).isZero();

        // Ohne den erzwungenen Fehler läuft derselbe Aufruf durch — der Zustand war unversehrt.
        wechsel.letzterSchritt(() -> { });
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(),
                wechselAnfrage(WECHSEL, null)));
    }

    // ---- Zaun und Form ----------------------------------------------------------------------------

    /** Ein fremdes Gerät und eine fremde Messstelle sind 404, nie 403 (Hausregel). */
    @Test
    void fremdIst404NieB403() {
        Werk w = ahrenberg("Zaun");
        String ms06 = messstelleMs06(w);
        UUID z5a = einbau(w, "Z-5a");
        bindeMs06(w, ms06);
        uhr(EINGETRAGEN);

        for (Anrufer fremd : List.of(DEMO, new Anrufer("admin", DEMO_KUNDENBEREICH))) {
            assertThat(status(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", fremd,
                    wechselAnfrage(WECHSEL, null)))).as(fremd.benutzer()).isEqualTo(404);
            assertThat(status(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms06 + "/quellen/wechsel", fremd,
                    wechselAnfrage(WECHSEL, null)))).as(fremd.benutzer()).isEqualTo(404);
        }
        assertThat(status(rufe(HttpMethod.POST, "/api/v1/geraete/" + UUID.randomUUID() + "/austausch",
                w.admin(), wechselAnfrage(WECHSEL, null)))).isEqualTo(404);
        assertThat(root.queryForObject("SELECT ausgebaut_am FROM geraet WHERE id = ?", Timestamp.class, z5a))
                .isNull();
    }

    /**
     * Die Antwort trägt genau die Felder der OpenAPI — und ein Feld, das es an der Route nicht gibt,
     * ist 400 mit seinem Namen, nie still verworfen.
     */
    @Test
    void dieAntwortTraegtGenauDieFelderDerOpenApiUndDieAnfrageWirdStrengGelesen() {
        Werk w = ahrenberg("Form");
        String ms06 = messstelleMs06(w);
        UUID z5a = einbau(w, "Z-5a");
        bindeMs06(w, ms06);
        uhr(EINGETRAGEN);

        Map<String, Object> fremdesFeld = wechselAnfrage(WECHSEL, null);
        fremdesFeld.put("unbekanntes_feld", List.of());
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(),
                fremdesFeld);
        abgelehnt(r, 400, "anfrage_ungueltig");
        assertThat(r.getBody().get("feld").asText()).isEqualTo("unbekanntes_feld");

        Map<String, Object> sekunden = wechselAnfrage("2026-11-18T10:40:30+01:00", null);
        anfrage(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(), sekunden), "zeitpunkt");

        JsonNode v = erfolgreich(rufe(HttpMethod.POST, "/api/v1/geraete/" + z5a + "/austausch", w.admin(),
                wechselAnfrage(WECHSEL, null)));
        assertThat(felder(v)).containsExactlyInAnyOrderElementsOf(eigenschaften("ZaehlerwechselVorgang"));
        assertThat(felder(v.get("geraet"))).containsExactlyInAnyOrderElementsOf(eigenschaften("ZaehlerwechselGeraet"));
        assertThat(felder(v.at("/geraet/alt")))
                .containsExactlyInAnyOrderElementsOf(eigenschaften("ZaehlerwechselEinbau"));
        assertThat(felder(v.at("/bindungen/0")))
                .containsExactlyInAnyOrderElementsOf(eigenschaften("ZaehlerwechselBindung"));
        assertThat(felder(v.get("rueckwirkung")))
                .containsExactlyInAnyOrderElementsOf(eigenschaften("MessstelleQuelleRueckwirkung"));
    }

    @Test
    void a6ControllerWechseltVierKartenUndBindungenAtomarMitEigenenEndstaenden() {
        int jahr = java.time.Year.now().getValue() + 1;
        Werk w = ahrenberg("A6 Controller");
        UUID controller = root.queryForObject("INSERT INTO geraet (tenant_id,site_id,kennzeichen,einbau_kennzeichen,"
                + "geraeteart,hersteller,typ,seriennummer,eingebaut_am) "
                + "VALUES (?,?,'GR-7','C-1','controller','WAGO','PFC200','C-alt',?) RETURNING id",
                UUID.class, w.tenant(), w.an1(), Timestamp.from(zeitpunkt("2026-10-01T00:00:00+02:00")));
        List<UUID> karten = new ArrayList<>();
        List<String> bindungen = new ArrayList<>();
        List<Map<String, Object>> staende = new ArrayList<>();
        int n = 0;
        for (String komponente : List.of("K-4", "K-5", "K-6", "K-7")) {
            n++;
            UUID karte = root.queryForObject("INSERT INTO geraet_teil (tenant_id,geraet_id,teilart,steckplatz,"
                    + "bezeichnung,typ,seriennummer,eingebaut_am) VALUES (?,?,'energiekarte',?,?,'750-495',?,?) RETURNING id",
                    UUID.class, w.tenant(), controller, n, "EK-" + n, "EK-SN-" + n, Timestamp.from(zeitpunkt("2026-10-01T00:00:00+02:00")));
            karten.add(karte);
            // Fixture neu anlegen: auch der DB-Owner darf bestehende Zeitachsen nicht mehr umschreiben.
            root.update("DELETE FROM geraet_komponente WHERE entity_id=?", w.k(komponente));
            root.update("INSERT INTO geraet_komponente (tenant_id,geraet_id,teil_id,gueltig_ab,entity_id) VALUES (?,?,?,?,?)",
                    w.tenant(), controller, karte, Timestamp.from(zeitpunkt("2026-10-01T00:00:00+02:00")), w.k(komponente));
            messkanalAuswahl(w, komponente, ENERGIE_BEZUG);
            String ms = anlegen(w.admin(), wieReferenz("MS-" + (9 + n), referenzMessstelle("MS-" + (9 + n)))).get("id").asText();
            uhr("2026-10-01T09:00:00+02:00");
            String q = erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + ms + "/quellen", w.admin(),
                    binden(w.k(komponente), ENERGIE_BEZUG, "fuehrend", null, "2026-10-01T00:00:00+02:00")))
                    .at("/quelle/id").asText();
            bindungen.add(q);
            staende.add(Map.of("bindung", q, "endstand", Map.of("wert", n * 1000, "einheit", "kWh")));
        }
        uhr(jahr + "-02-05T14:00:00+01:00");
        String pfad = "/api/v1/geraete/" + controller + "/austausch";
        JsonNode vorschau = ok(rufe(HttpMethod.GET, pfad + "/vorschau?zeitpunkt=" + jahr + "-02-05T13:00:00Z", w.admin(), null));
        assertThat(vorschau.get("folgen")).hasSize(4);
        assertThat(vorschau.get("karten")).hasSize(4);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("zeitpunkt", jahr + "-02-05T14:00:00+01:00");
        body.put("neues_geraet", Map.of("einbau_kennzeichen", "C-1′", "seriennummer", "C-neu"));
        body.put("karten_uebernommen", karten.subList(0, 3)); // EK-4 ebenfalls neu, Seriennummer unbekannt
        body.put("ablesestaende", staende);
        body.put("bestaetigte_bindungen", bindungen);
        int vorher = root.queryForObject("SELECT count(*) FROM geraet WHERE tenant_id=?", Integer.class, w.tenant());
        letzterFehlerFuerController();
        assertThat(status(rufe(HttpMethod.POST, pfad, w.admin(), body))).isEqualTo(500);
        assertThat(root.queryForObject("SELECT count(*) FROM geraet WHERE tenant_id=?", Integer.class, w.tenant())).isEqualTo(vorher);
        assertThat(root.queryForObject("SELECT count(*) FROM geraet_teil WHERE geraet_id=? AND ausgebaut_am IS NULL", Integer.class, controller)).isEqualTo(4);
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_quelle WHERE geraet_id=? AND gueltig_bis IS NULL", Integer.class, controller)).isEqualTo(4);
        wechsel.letzterSchritt(() -> { });
        Map<String,Object> veraltet = new LinkedHashMap<>(body);
        veraltet.put("bestaetigte_bindungen", bindungen.subList(0, 3));
        abgelehnt(rufe(HttpMethod.POST, pfad, w.admin(), veraltet), 409, "zustand_passt_nicht");
        Map<String,Object> fremderStand = new LinkedHashMap<>(body);
        fremderStand.put("ablesestaende", List.of(Map.of("bindung", UUID.randomUUID(), "endstand", Map.of("wert", 1))));
        anfrage(rufe(HttpMethod.POST, pfad, w.admin(), fremderStand), "ablesestaende");
        JsonNode antwort = erfolgreich(rufe(HttpMethod.POST, pfad, w.admin(), body));
        assertThat(antwort.get("bindungen")).hasSize(4);
        UUID neu = UUID.fromString(antwort.at("/geraet/neu/id").asText());
        for (JsonNode bindung : antwort.get("bindungen")) {
            assertThat(zeitpunkt(bindung.at("/beendet/gueltig_bis").asText())).isEqualTo(zeitpunkt(jahr + "-02-05T14:00:00+01:00"));
            assertThat(zeitpunkt(bindung.at("/neu/gueltig_ab").asText())).isEqualTo(zeitpunkt(jahr + "-02-05T14:00:00+01:00"));
            int nummer = Integer.parseInt(bindung.get("kennzeichen").asText().substring(3)) - 9;
            assertThat(bindung.at("/beendet/endstand/wert").asInt()).isEqualTo(nummer * 1000);
        }
        assertThat(root.queryForObject("SELECT count(*) FROM geraet_komponente WHERE geraet_id=? AND teil_id IS NOT NULL", Integer.class, neu)).isEqualTo(4);
        assertThat(root.queryForList("SELECT seriennummer FROM geraet_teil WHERE geraet_id=? ORDER BY steckplatz", String.class, neu))
                .containsExactly("EK-SN-1", "EK-SN-2", "EK-SN-3", null);
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_aenderung WHERE tenant_id=? AND art='zaehler_gewechselt'", Integer.class, w.tenant())).isEqualTo(4);
        String berichtigt = jahr + "-02-05T14:40:00+01:00";
        ok(rufe(HttpMethod.POST, pfad + "/zeitpunkt", w.admin(),
                Map.of("bisher", body.get("zeitpunkt"), "zeitpunkt", berichtigt)));
        assertThat(anzahl("SELECT count(*) FROM geraet_teil WHERE geraet_id=? AND eingebaut_am=?",
                neu, Timestamp.from(zeitpunkt(berichtigt)))).isEqualTo(4);
        assertThat(anzahl("SELECT count(*) FROM geraet_teil WHERE geraet_id=? AND ausgebaut_am=?",
                controller, Timestamp.from(zeitpunkt(berichtigt)))).isEqualTo(4);
        Werk fremd = ahrenberg("A6 fremd");
        assertThat(status(rufe(HttpMethod.POST, pfad, fremd.admin(), body))).isEqualTo(404);
        assertThat(status(rufe(HttpMethod.GET, pfad + "/vorschau", fremd.admin(), null))).isEqualTo(404);
    }

    private void letzterFehlerFuerController() {
        wechsel.letzterSchritt(() -> { throw new IllegalStateException("A6 erzwungener letzter Fehler"); });
    }

    // ---- Gerüst: das Referenzunternehmen ----------------------------------------------------------

    /**
     * AN-1 mit Box E-1 und den Bestands-Komponenten K-1, K-3 … K-7 (Verbindung aus DQ-1 … DQ-3);
     * ihre Geräte GR-1 … GR-6 legt der Anlege-Weg an (V20260911240000). GR-4 trägt als Einbau Z-5a,
     * wie die Referenzdatei. Dazu die Mess-Selektion der Kanäle, die die Tests binden.
     */
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
        messkanalAuswahl(w, "K-5", ENERGIE_BEZUG, ENERGIE_ABGABE, LEISTUNG_VORZEICHEN, SPANNUNG);
        return w;
    }

    private static void messkanalAuswahl(Werk w, String komponente, String... kanaele) {
        for (String kanal : kanaele) {
            root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, "
                    + "point_key, enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, "
                    + "apply_status, retention_class, long_term_strategy) VALUES (?, ?, ?, ?, ?, true, 60, 1, now(), "
                    + "'2026.08.26.3', 'test', 'pending_edge', 'energy_counter', 'fifteen_minute') "
                    + "ON CONFLICT DO NOTHING", w.tenant(), w.an1(), w.box(), w.k(komponente), kanal);
        }
    }

    private static UUID einbau(Werk w, String kennzeichen) {
        return root.queryForObject("SELECT id FROM geraet WHERE tenant_id = ? AND einbau_kennzeichen = ?",
                UUID.class, w.tenant(), kennzeichen);
    }

    /** MS-06 wie die Referenzdatei (Hauptgröße Wirkenergie · Bezug · kWh · Zählerstand). */
    private String messstelleMs06(Werk w) {
        return anlegen(w.admin(), wieReferenz("MS-06", referenzMessstelle("MS-06"))).get("id").asText();
    }

    /** Die führende Quelle von MS-06 ab Beginn des Verlaufs (Bestandsübernahme, rückwirkend). */
    private String bindeMs06(Werk w, String messstelle) {
        uhr("2026-10-01T09:14:00+02:00");
        Map<String, Object> body = binden(w.k("K-5"), ENERGIE_BEZUG, "fuehrend", null,
                referenzMessstelle("MS-06").at("/fuehrende_quelle/0/gueltig_ab").asText());
        return erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + messstelle + "/quellen", w.admin(), body))
                .at("/quelle/id").asText();
    }

    /** Eine Vergleichsquelle derselben Komponente an einer zweiten Messstelle (E3). */
    private void bindeVergleich(Werk w, String messstelle) {
        uhr("2026-10-01T09:20:00+02:00");
        Map<String, Object> body = binden(w.k("K-5"), ENERGIE_BEZUG, "vergleich", "Plausibilität",
                referenzMessstelle("MS-06").at("/fuehrende_quelle/0/gueltig_ab").asText());
        erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen/" + messstelle + "/quellen", w.admin(), body));
    }

    /** Eine Einstellungs-Fassung am alten Einbau: Wandler 150/5 A, im Gerät eingestellt (§5.13). */
    private static void wandlerFassung(Werk w, UUID einbau) {
        root.update("INSERT INTO quelle_einstellung (tenant_id, geraet_id, art, wert, anwendung, herkunft, "
                + "gueltig_ab, rueckwirkend, actor_name, actor_art, eingetragen_am) "
                + "VALUES (?, ?, 'wandler_strom', ?::jsonb, 'dokumentiert', 'eintrag', ?, false, 'test', "
                + "'voltpilot', ?)", w.tenant(), einbau, "{\"primaer_a\": 150, \"sekundaer_a\": 5}",
                Timestamp.from(zeitpunkt("2024-03-12T00:00:00+01:00")),
                Timestamp.from(zeitpunkt("2026-10-01T09:00:00+02:00")));
    }

    /** Die letzten Werte von Z-5a (§5.13: „bis 10:40"). */
    private static final List<String> WERTE_Z5A = List.of("2026-10-15T10:00:00+02:00",
            "2026-10-31T22:45:00+01:00", "2026-11-18T10:15:00+01:00", "2026-11-18T10:30:00+01:00",
            "2026-11-18T10:39:00+01:00");

    /** Die ersten Werte von Z-5b — erst ab 10:47 (§5.13). */
    private static final List<String> WERTE_Z5B = List.of(ERSTE_WERTE_Z5B, "2026-11-18T11:00:00+01:00");

    /**
     * Die Messwerte des Zeitstrahls (§5.13): Oktober 2026 und der 18.11. bis 10:39 an Z-5a, ab
     * 10:47 an Z-5b — die Minuten dazwischen bleiben LEER. Die Messreihe hängt an der Box und am
     * Messwert, nie am Gerät: genau deshalb rührt der Wechsel sie nicht an.
     */
    private static void messwerte(Werk w) {
        List<String> alle = new ArrayList<>(WERTE_Z5A);
        alle.addAll(WERTE_Z5B);
        long folge = 1;
        for (String t : alle) {
            root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id, "
                    + "point_key, raw_numeric, decoded_numeric, quality, catalog_version, edge_sequence, "
                    + "aggregation_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'good', '2026.08.26.3', ?, 'counter')",
                    Timestamp.from(zeitpunkt(t)), Timestamp.from(zeitpunkt(t)), w.tenant(), w.an1(), w.box(),
                    ENERGIE_BEZUG, 1083000.0 + folge, 1083000.0 + folge, folge);
            root.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, "
                    + "channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", Timestamp.from(zeitpunkt(t)),
                    Timestamp.from(zeitpunkt(t)), w.tenant(), w.an1(), w.box(), w.k("K-5").toString(),
                    ENERGIE_BEZUG, 1083000.0 + folge);
            folge++;
        }
        for (String bucket : List.of("2026-10-15T10:00:00+02:00", "2026-10-31T22:45:00+01:00",
                "2026-11-18T10:30:00+01:00", "2026-11-18T10:45:00+01:00")) {
            root.update("INSERT INTO telemetry_v2_rollup_15m (bucket, tenant_id, site_id, entity_id, channel, "
                    + "avg_value, min_value, max_value, last_value, n_samples) VALUES (?, ?, ?, ?, ?, 12, 3, 40, "
                    + "15, 15)", Timestamp.from(zeitpunkt(bucket)), w.tenant(), w.an1(), w.k("K-5").toString(),
                    ENERGIE_BEZUG);
        }
        for (String tag : List.of("2026-10-14T22:00:00Z", "2026-10-31T23:00:00Z", "2026-11-17T23:00:00Z")) {
            root.update("INSERT INTO telemetry_v2_rollup_1d (bucket, tenant_id, site_id, entity_id, channel, "
                    + "avg_value, min_value, max_value, last_value, n_samples) VALUES (?, ?, ?, ?, ?, 12, 3, 40, "
                    + "15, 96)", Timestamp.from(Instant.parse(tag)), w.tenant(), w.an1(), w.k("K-5").toString(),
                    ENERGIE_BEZUG);
        }
    }

    // ---- Gerüst: Anfragen --------------------------------------------------------------------------

    private static Map<String, Object> wechselAnfrage(String zeitpunkt, JsonNode neuerEinbau) {
        return wechselAnfrage(zeitpunkt, neuerEinbau, null);
    }

    private static Map<String, Object> wechselAnfrage(String zeitpunkt, JsonNode neuerEinbau, String kennzeichen) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("zeitpunkt", zeitpunkt);
        Map<String, Object> geraet = new LinkedHashMap<>();
        if (neuerEinbau != null) {
            geraet.put("einbau_kennzeichen", neuerEinbau.get("kennzeichen").asText());
            geraet.put("seriennummer", neuerEinbau.get("seriennummer").asText());
        }
        if (kennzeichen != null) {
            geraet.put("einbau_kennzeichen", kennzeichen);
        }
        if (!geraet.isEmpty()) {
            body.put("neues_geraet", geraet);
        }
        return body;
    }

    private static Map<String, Object> binden(UUID komponente, String kanal, String rolle, String zweck, String ab) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("komponente", komponente.toString());
        body.put("kanal", kanal);
        body.put("rolle", rolle);
        if (zweck != null) {
            body.put("zweck", zweck);
        }
        body.put("gueltig_ab", ab);
        return body;
    }

    private static Map<String, Object> stand(double wert, String einheit) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("wert", wert);
        s.put("einheit", einheit);
        return s;
    }

    /** Eine Messstelle mit den Werten der Referenz. */
    private static Map<String, Object> wieReferenz(String kennzeichen, JsonNode ms) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", kennzeichen);
        body.put("name", ms.get("name").asText());
        body.put("art", ms.get("art").asText());
        body.put("medium", ms.get("medium").asText());
        body.put("hauptgroesse", groesseAus(ms.get("hauptgroesse")));
        body.put("nebengroessen", List.of());
        return body;
    }

    /** Eine zweite Messstelle derselben Größe — für die Vergleichsquelle (E3). */
    private static Map<String, Object> messstelle(String kennzeichen, String name) {
        Map<String, Object> body = wieReferenz(kennzeichen, referenzMessstelle("MS-06"));
        body.put("kennzeichen", kennzeichen);
        body.put("name", name);
        return body;
    }

    private static JsonNode groesseAus(JsonNode g) {
        ObjectNode n = MAPPER.createObjectNode();
        for (String f : List.of("groesse", "richtung", "einheit", "wertart")) {
            n.put(f, g.get(f).asText());
        }
        return n;
    }

    private JsonNode anlegen(Anrufer wer, Map<String, Object> body) {
        return erfolgreich(rufe(HttpMethod.POST, "/api/v1/messstellen", wer, body));
    }

    private void uhr(String zeitpunkt) {
        Clock c = Clock.fixed(zeitpunkt(zeitpunkt), BERLIN);
        quellen.uhrStellen(c);
        wechsel.uhrStellen(c);
    }

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
        return rest.exchange(java.net.URI.create("http://localhost:" + port + pfad), methode, entity, JsonNode.class);
    }

    private static JsonNode quelleMitId(JsonNode liste, String id) {
        for (JsonNode q : liste.get("quellen")) {
            if (q.get("id").asText().equals(id)) {
                return q;
            }
        }
        throw new AssertionError("keine Quelle " + id);
    }

    private JsonNode registerZeile(Werk w, String kennzeichen) {
        JsonNode liste = ok(rufe(HttpMethod.GET, "/api/v1/messstellen", w.admin(), null));
        for (JsonNode z : liste.get("register")) {
            if (kennzeichen.equals(z.get("kennzeichen").asText())) {
                return z;
            }
        }
        throw new AssertionError("keine Register-Zeile " + kennzeichen);
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

    private static void abgelehnt(ResponseEntity<JsonNode> r, int status, String code) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(status);
        assertThat(r.getBody().get("code").asText()).isEqualTo(code);
        assertThat(r.getBody().get("message").asText()).isNotBlank();
        assertThat(MessstelleAbgelehnt.CODES).contains(code);
    }

    private static void anfrage(ResponseEntity<JsonNode> r, String feld) {
        abgelehnt(r, 400, "anfrage_ungueltig");
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

    // ---- Gerüst: Datenbank und Vertrag --------------------------------------------------------------

    /** Der Fingerabdruck ALLER Messwert-Tabellen des Kundenbereichs (geraet/Speisung ändern sich zu Recht). */
    private static String messwerteHash(UUID tenant) {
        StringBuilder s = new StringBuilder();
        for (String t : List.of("telemetry_v2", "telemetry_v2_rollup_15m", "telemetry_v2_rollup_1h",
                "telemetry_v2_rollup_1d", "device_measurement_sample", "device_measurement_rollup_5m",
                "device_measurement_rollup_15m", "device_measurement_selection")) {
            if (Boolean.TRUE.equals(root.queryForObject("SELECT to_regclass(?) IS NOT NULL", Boolean.class, t))) {
                s.append(t).append('=').append(root.queryForObject("SELECT md5(coalesce(string_agg(z, E'\\n' "
                        + "ORDER BY z), '')) FROM (SELECT to_jsonb(x)::text AS z FROM " + t + " x "
                        + "WHERE x.tenant_id = ?) AS zeilen", String.class, tenant)).append('\n');
            }
        }
        return s.toString();
    }

    /** Derselbe Fingerabdruck, aber NUR für den Oktober 2026 — der Bestandsschutz-Nachweis (A1). */
    private static String oktoberHash(UUID tenant) {
        Timestamp von = Timestamp.from(zeitpunkt("2026-10-01T00:00:00+02:00"));
        Timestamp bis = Timestamp.from(zeitpunkt("2026-11-01T00:00:00+01:00"));
        StringBuilder s = new StringBuilder();
        for (String[] t : new String[][] {{"telemetry_v2", "time"}, {"telemetry_v2_rollup_15m", "bucket"},
                {"telemetry_v2_rollup_1d", "bucket"}, {"device_measurement_sample", "time"}}) {
            s.append(t[0]).append('=').append(root.queryForObject("SELECT md5(coalesce(string_agg(z, E'\\n' "
                    + "ORDER BY z), '')) FROM (SELECT to_jsonb(x)::text AS z FROM " + t[0] + " x "
                    + "WHERE x.tenant_id = ? AND x." + t[1] + " >= ? AND x." + t[1] + " < ?) AS zeilen",
                    String.class, tenant, von, bis)).append('\n');
        }
        return s.toString();
    }

    /** Welcher Einbau speist die Messstelle zu diesem Zeitpunkt — laut der gespeicherten Bindung? */
    private static String bindungZu(String messstelle, String zeitpunkt) {
        return root.queryForObject("SELECT g.einbau_kennzeichen FROM messstelle_quelle q "
                + "JOIN geraet g ON g.id = q.geraet_id WHERE q.messstelle_id = ? AND q.rolle = 'fuehrend' "
                + "AND q.gueltig_ab <= ? AND (q.gueltig_bis IS NULL OR q.gueltig_bis > ?)", String.class,
                UUID.fromString(messstelle), Timestamp.from(zeitpunkt(zeitpunkt)),
                Timestamp.from(zeitpunkt(zeitpunkt)));
    }

    private static long eintraege(UUID tenant) {
        return anzahl("SELECT count(*) FROM messstelle_aenderung WHERE tenant_id = ?", tenant);
    }

    private static long anzahl(String sql, Object... args) {
        return root.queryForObject(sql, Long.class, args);
    }

    private static List<Map<String, Object>> protokoll(String messstelle) {
        return root.queryForList("SELECT art, alt::text AS alt, neu::text AS neu, gilt_ab, rueckwirkend, grund, "
                + "actor_sub, actor_name, actor_rolle, actor_art, created_at FROM messstelle_aenderung "
                + "WHERE messstelle_id = ? ORDER BY id", UUID.fromString(messstelle));
    }

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

    private static JsonNode fall(String familie, String name) {
        try {
            for (JsonNode c : MAPPER.readTree(V2.resolve("messstelle-vectors.json").toFile())
                    .at("/cases/" + familie)) {
                if (c.get("name").asText().equals(name)) {
                    return c;
                }
            }
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        throw new AssertionError("kein Fall " + familie + "/" + name);
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

    private static JsonNode json(Object text) {
        try {
            return text == null ? MAPPER.nullNode() : MAPPER.readTree(text.toString());
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
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
