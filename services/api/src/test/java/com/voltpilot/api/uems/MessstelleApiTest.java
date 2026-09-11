package com.voltpilot.api.uems;

import static java.time.temporal.ChronoUnit.HOURS;
import static java.time.temporal.ChronoUnit.MINUTES;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.MessstelleRegeln.Fehler;
import com.voltpilot.api.uems.MessstelleRegeln.Vergeben;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
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

/**
 * Die Messstellen-Schnittstelle (UEMS AP-04 IP-3) Ende zu Ende gegen echtes Keycloak +
 * TimescaleDB. Die Eingänge sind die Fälle von {@code docs/contracts/v2/messstelle-vectors.json}
 * und die Messstellen des Referenzunternehmens — mit deren Kennzeichen und Werten.
 *
 * <p>Bewiesen wird:
 * <ul>
 *   <li>das automatische Kennzeichen (MS-0001 …, der Vorschlag MS-0022 bleibt stehen, A12) und
 *       jeder Fall der Familien {@code kennzeichen_vorschlag}, {@code kennzeichen_pruefen} und
 *       {@code groesse} über die Schnittstelle: Form 400 vor Belegung 409, belegt auch archiviert
 *       und früher, der Träger im Urteil zeichengleich wie in der Vektor-Datei;</li>
 *   <li>die Lebenszyklus-Fälle, deren Eingänge sich heute (ohne Ort, Formel, Quelle) über die
 *       Schnittstelle herstellen lassen, mit dem Urteil der Datei;</li>
 *   <li>die Antwort IST eine Messstelle nach {@code messstelle.schema.json} (ohne die vier Felder
 *       der Schnittstelle);</li>
 *   <li>Anhalten · Fortsetzen · Archivieren mit ihren Zeitpunkt-Regeln (A15: nie vor dem
 *       Vorgänger, nie in der Zukunft, auf die Minute) und ihren Zustands-Regeln;</li>
 *   <li>eine fremde Messstelle ist 404, nie 403; jeder Schreibvorgang schreibt GENAU EINEN
 *       Protokolleintrag mit Urheber, ein abgelehnter keinen.</li>
 * </ul>
 * A11 (zweiter Hauptzähler) braucht die Stellung — sie kommt mit IP-7 und wird dort bewiesen.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class MessstelleApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String BASIS = "/api/v1/messstellen";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    /** Was die Schnittstelle zur Messstelle des Vertrags hinzufügt. */
    private static final List<String> NUR_SCHNITTSTELLE =
            List.of("id", "fehlt", "angehalten_ab", "archiviert_am");

    private static final ObjectMapper MAPPER = new ObjectMapper();

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

    private static JsonNode referenz;
    private static JsonNode vektoren;
    private static JsonNode schema;
    private static JdbcTemplate root;
    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

    /** Wer ruft: ein Benutzer des Test-Realms, der Plattform-Admin mit gewähltem Kundenbereich. */
    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Anrufer DEMO = new Anrufer("demo", null);
    private static final Anrufer DEMO2 = new Anrufer("demo2", null);
    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);

    private static Anrufer admin(UUID kundenbereich) {
        return new Anrufer("admin", kundenbereich);
    }

    @BeforeAll
    static void ladeVertrag() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        vektoren = MAPPER.readTree(V2.resolve("messstelle-vectors.json").toFile());
        schema = MAPPER.readTree(V2.resolve("messstelle.schema.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    // ---- Anlegen: automatisches Kennzeichen und die Form des Vertrags -------------

    @Test
    void anlegenOhneKennzeichenVergibtFortlaufendUndDieAntwortIstEineMessstelleNachVertrag() {
        UUID t = neuerKundenbereich("Anlegen-Probe");
        Anrufer wer = admin(t);
        JsonNode erste = fall("kennzeichen_vorschlag", "vorschlag-erste-messstelle").get("expected");
        assertThat(rufe(HttpMethod.GET, "/kennzeichen-vorschlag", wer, null).getBody()
                .get("kennzeichen").asText()).isEqualTo(erste.get("kennzeichen").asText());
        assertThat(zaehler(t)).as("der Vorschlag bewegt den Zähler nicht").isNull();

        JsonNode ms06 = referenzMessstelle("MS-06");
        ResponseEntity<JsonNode> angelegt = rufe(HttpMethod.POST, "", wer, wieReferenz(null, ms06));
        assertThat(angelegt.getStatusCode().value()).isEqualTo(201);
        JsonNode m = angelegt.getBody();
        assertThat(angelegt.getHeaders().getLocation()).hasToString(BASIS + "/" + m.get("id").asText());
        assertThat(m.get("kennzeichen").asText()).isEqualTo(erste.get("kennzeichen").asText());
        assertThat(zaehler(t)).isEqualTo(erste.get("zaehler").asInt());
        assertThat(m.get("name").asText()).isEqualTo(ms06.get("name").asText());
        assertThat(m.get("hauptgroesse")).isEqualTo(groesseAus(ms06.get("hauptgroesse")));
        assertThat(m.at("/nebengroessen/0/groesse").asText())
                .isEqualTo(ms06.at("/nebengroessen/0/groesse").asText());
        assertThat(m.at("/nebengroessen/0/lebenszyklus").asText()).isEqualTo("aktiv");
        // Ohne Ort (IP-7) ist eine gemessene Messstelle ehrlich ein Entwurf — nie „aktiv“.
        assertThat(m.get("lebenszyklus").asText()).isEqualTo("entwurf");
        assertThat(texte(m.get("fehlt"))).containsExactly("ort");
        for (String leer : List.of("fuehrende_quelle", "vergleichsquellen", "orte", "elektrische_stellung")) {
            assertThat(m.get(leer).isArray() && m.get(leer).isEmpty()).as(leer).isTrue();
        }
        assertThat(m.get("kadenz_s").isNull()).isTrue();

        // Die Antwort IST eine Messstelle nach messstelle.schema.json.
        ObjectNode vertrag = m.deepCopy();
        NUR_SCHNITTSTELLE.forEach(vertrag::remove);
        assertThat(UemsSchemaLaeufer.verstoesse(vertrag, schema)).isEmpty();

        assertThat(rufe(HttpMethod.GET, "/" + m.get("id").asText(), wer, null).getBody()).isEqualTo(m);

        JsonNode zweite = anlegen(wer, neueOhneName(null));
        assertThat(zweite.get("kennzeichen").asText()).isEqualTo(MessstelleRegeln.automatisch(2));
        assertThat(zaehler(t)).isEqualTo(2);
        assertThat(rufe(HttpMethod.GET, "", wer, null).getBody().get("messstellen"))
                .extracting(n -> n.get("kennzeichen").asText()).containsExactly("MS-0001", "MS-0002");

        // Je Anlegen genau ein Eintrag „angelegt“; der Plattform-Admin steht als VoltPilot darin.
        JsonNode admin = anspruch("admin");
        for (JsonNode ms : List.of(m, zweite)) {
            List<Map<String, Object>> eintraege = protokoll(ms.get("id").asText());
            assertThat(eintraege).hasSize(1);
            Map<String, Object> e = eintraege.get(0);
            assertThat(e.get("art")).isEqualTo("angelegt");
            assertThat(e.get("actor_sub")).isEqualTo(admin.get("sub").asText());
            assertThat(e.get("actor_name")).isEqualTo("admin");
            assertThat(e.get("actor_rolle")).isEqualTo(RechteAbleitung.Rolle.VOLTPILOT_BETRIEB.code());
            assertThat(e.get("actor_art")).isEqualTo("voltpilot");
            assertThat(e.get("rueckwirkend")).isEqualTo(false);
            assertThat(json(e.get("neu")).get("kennzeichen").asText()).isEqualTo(ms.get("kennzeichen").asText());
        }
    }

    /**
     * Jeder Fall der Familie {@code kennzeichen_vorschlag}: der Bestand des Falls über die
     * Schnittstelle angelegt, seine Vorgeschichte (so viele automatische Vergaben gab es) als
     * Zählerstand — dann nennt der Vorschlag das Kennzeichen des Falls, und eine Messstelle
     * ohne Kennzeichen bekommt genau dieses.
     */
    @TestFactory
    Stream<DynamicTest> kennzeichenVorschlagDieFaelleDerVektorDateiUeberDieSchnittstelle() {
        return faelle("kennzeichen_vorschlag").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    JsonNode in = fall.get("input");
                    JsonNode soll = fall.get("expected");
                    UUID t = neuerKundenbereich("Vorschlag-Fall " + fall.get("name").asText());
                    Anrufer wer = admin(t);
                    for (JsonNode k : in.get("belegt")) {
                        JsonNode ms = referenzMessstelle(k.asText());
                        anlegen(wer, ms == null ? neueOhneName(k.asText()) : wieReferenz(k.asText(), ms));
                    }
                    int vorgeschichte = in.get("zaehler").asInt();
                    if (vorgeschichte > 0) {
                        root.update("INSERT INTO messstelle_kennzeichen_seq (tenant_id, zaehler) VALUES (?, ?)",
                                t, vorgeschichte);
                    }
                    assertThat(rufe(HttpMethod.GET, "/kennzeichen-vorschlag", wer, null).getBody()
                            .get("kennzeichen").asText()).isEqualTo(soll.get("kennzeichen").asText());
                    assertThat(anlegen(wer, neueOhneName(null)).get("kennzeichen").asText())
                            .isEqualTo(soll.get("kennzeichen").asText());
                    assertThat(zaehler(t)).isEqualTo(soll.get("zaehler").asInt());
                }));
    }

    /**
     * Jeder Fall der Familie {@code kennzeichen_pruefen}: der Bestand des Falls entsteht über die
     * Schnittstelle (anlegen unter dem frühesten Kennzeichen, umbenennen, archivieren), die
     * Belegung ist genau die {@code vergeben}-Liste — dann antwortet {@code POST} (neue
     * Messstelle) bzw. {@code PUT} (die Messstelle {@code fuer_messstelle}) mit dem Urteil des
     * Falls: Status aus der Fehlertabelle des Vertrags, der Träger zeichengleich. Abgelehnt
     * heißt: nichts geschrieben, auch kein Protokolleintrag.
     */
    @TestFactory
    Stream<DynamicTest> kennzeichenPruefenDieFaelleDerVektorDateiUeberDieSchnittstelle() {
        return faelle("kennzeichen_pruefen").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    JsonNode in = fall.get("input");
                    JsonNode soll = fall.get("expected");
                    UUID t = neuerKundenbereich("Kennzeichen-Fall " + fall.get("name").asText());
                    Anrufer wer = admin(t);
                    Map<String, String> traeger = belegeWieDerFall(wer, in.get("vergeben"));
                    assertThat(belegung(t)).isEqualTo(vergebenAus(in.get("vergeben")));
                    long eintraegeVorher = eintraege(t);

                    String kandidat = in.get("kandidat").asText();
                    String fuer = text(in.get("fuer_messstelle"));
                    ResponseEntity<JsonNode> antwort = fuer == null
                            ? rufe(HttpMethod.POST, "", wer, neueOhneName(kandidat))
                            : rufe(HttpMethod.PUT, "/" + traeger.get(fuer), wer,
                                    Map.of("kennzeichen", kandidat, "name", nameVon(in.get("vergeben"), fuer)));

                    String fehler = text(soll.get("fehler"));
                    if (fehler == null) {
                        assertThat(antwort.getStatusCode().value()).as(String.valueOf(antwort.getBody()))
                                .isEqualTo(fuer == null ? 201 : 200);
                        assertThat(antwort.getBody().get("kennzeichen").asText()).isEqualTo(kandidat);
                        if (fuer != null && !fuer.equals(kandidat)) {
                            // Das bisherige Kennzeichen bleibt ihr belegt — nie an eine andere (Regel 9).
                            ResponseEntity<JsonNode> weitergabe = rufe(HttpMethod.POST, "", wer, neueOhneName(fuer));
                            assertThat(weitergabe.getStatusCode().value()).isEqualTo(409);
                            assertThat(weitergabe.getBody().at("/bestehend/frueher").asBoolean()).isTrue();
                        }
                    } else {
                        assertThat(antwort.getStatusCode().value()).isEqualTo(fehler(fehler).status());
                        assertThat(antwort.getBody().get("code").asText()).isEqualTo(fehler);
                        assertThat(antwort.getBody().path("bestehend")).isEqualTo(
                                soll.get("bestehend").isNull() ? MAPPER.missingNode() : soll.get("bestehend"));
                        assertThat(belegung(t)).isEqualTo(vergebenAus(in.get("vergeben")));
                        assertThat(eintraege(t)).isEqualTo(eintraegeVorher);
                    }
                }));
    }

    /**
     * Jeder Fall der Familie {@code groesse} als Hauptgröße einer neuen Messstelle: im Katalog →
     * angelegt; sonst 400 {@code groesse_ungueltig} mit dem Grund des Falls — und nichts
     * gespeichert. Gas/Volumen (MS-21) ist anlegbar; Wasser hat noch keine Größe.
     */
    @TestFactory
    Stream<DynamicTest> groesseDieFaelleDerVektorDateiUeberDieSchnittstelle() {
        return faelle("groesse").map(fall -> DynamicTest.dynamicTest(fall.get("name").asText(), () -> {
            JsonNode in = fall.get("input");
            JsonNode soll = fall.get("expected");
            UUID t = neuerKundenbereich("Größen-Fall " + fall.get("name").asText());
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("art", "gemessen");
            body.put("medium", in.get("medium").asText());
            body.put("hauptgroesse", in.get("groesse"));
            ResponseEntity<JsonNode> antwort = rufe(HttpMethod.POST, "", admin(t), body);
            if (soll.get("fehler").isNull()) {
                assertThat(antwort.getStatusCode().value()).as(String.valueOf(antwort.getBody())).isEqualTo(201);
                assertThat(antwort.getBody().get("hauptgroesse")).isEqualTo(in.get("groesse"));
                assertThat(antwort.getBody().get("medium").asText()).isEqualTo(in.get("medium").asText());
            } else {
                assertThat(antwort.getStatusCode().value()).isEqualTo(Fehler.GROESSE_UNGUELTIG.status());
                assertThat(antwort.getBody().get("code").asText()).isEqualTo(soll.get("fehler").asText());
                assertThat(antwort.getBody().get("grund").asText()).isEqualTo(soll.get("grund").asText());
                assertThat(antwort.getBody().get("feld").asText()).isEqualTo("hauptgroesse");
                assertThat(messstellen(t)).isZero();
                assertThat(zaehler(t)).as("ein abgelehntes Anlegen bewegt den Zähler nicht").isNull();
            }
        }));
    }

    /**
     * Die Lebenszyklus-Fälle, deren Eingänge sich HEUTE über die Schnittstelle herstellen lassen
     * (ohne Ort, ohne Formel, ohne Quelle): die angelegte Messstelle trägt das Urteil der Datei.
     * Die übrigen brauchen Ort (IP-7), Quelle (IP-13) oder Formel (AP-10).
     */
    @TestFactory
    Stream<DynamicTest> lebenszyklusDieHerstellbarenFaelleDerVektorDatei() {
        List<JsonNode> herstellbar = faelle("lebenszyklus").filter(f -> {
            JsonNode in = f.get("input");
            return !in.get("ort_vorhanden").asBoolean() && !in.get("formel_vorhanden").asBoolean()
                    && in.get("fuehrende_quelle").isEmpty() && !in.get("angehalten").asBoolean()
                    && !in.get("archiviert").asBoolean();
        }).toList();
        assertThat(herstellbar).extracting(f -> f.get("name").asText())
                .containsExactlyInAnyOrder("neue-messstelle-ohne-name-und-ort",
                        "ms-20-berechnet-ohne-formel-ist-entwurf");
        return herstellbar.stream().map(fall -> DynamicTest.dynamicTest(fall.get("name").asText(), () -> {
            JsonNode in = fall.get("input");
            JsonNode soll = fall.get("expected");
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("kennzeichen", in.get("kennzeichen").asText());
            body.put("name", text(in.get("name")));
            body.put("art", in.get("art").asText());
            body.put("medium", in.get("medium").asText());
            body.put("hauptgroesse", in.get("hauptgroesse"));
            JsonNode m = anlegen(admin(neuerKundenbereich("Lebenszyklus-Fall")), body);
            assertThat(m.get("lebenszyklus").asText()).isEqualTo(soll.get("lebenszyklus").asText());
            assertThat(m.get("fehlt")).isEqualTo(soll.get("fehlt"));
        }));
    }

    @Test
    void mediumArtUndFormDerAnfrageNachVertrag() {
        UUID t = neuerKundenbereich("Form-Probe");
        Anrufer wer = admin(t);
        // MS-21 Gas: der Vertrag kennt das Medium; „nur Strom“ ist eine Regel der Fläche (AP-00 E11).
        JsonNode ms21 = anlegen(wer, wieReferenz("MS-21", referenzMessstelle("MS-21")));
        assertThat(ms21.get("medium").asText()).isEqualTo("Gas");

        Map<String, Object> oel = neueOhneName(null);
        oel.put("medium", "Öl");
        abgelehnt(rufe(HttpMethod.POST, "", wer, oel), 400, "groesse_ungueltig", "grund", "medium");
        Map<String, Object> ohneMedium = neueOhneName(null);
        ohneMedium.remove("medium");
        abgelehnt(rufe(HttpMethod.POST, "", wer, ohneMedium), 400, "anfrage_ungueltig", "feld", "medium");
        Map<String, Object> ohneArt = neueOhneName(null);
        ohneArt.remove("art");
        abgelehnt(rufe(HttpMethod.POST, "", wer, ohneArt), 400, "anfrage_ungueltig", "feld", "art");
        Map<String, Object> geschaetzt = neueOhneName(null);
        geschaetzt.put("art", "geschaetzt");
        abgelehnt(rufe(HttpMethod.POST, "", wer, geschaetzt), 400, "anfrage_ungueltig", "feld", "art");
        Map<String, Object> ohneGroesse = neueOhneName(null);
        ohneGroesse.remove("hauptgroesse");
        abgelehnt(rufe(HttpMethod.POST, "", wer, ohneGroesse), 400, "anfrage_ungueltig", "feld", "hauptgroesse");

        // Was es an der Route (noch) nicht gibt, wird nie still verworfen: ein mitgeschickter Ort
        // (IP-7) wäre sonst scheinbar gespeichert.
        Map<String, Object> mitOrt = neueOhneName(null);
        mitOrt.put("orte", List.of());
        abgelehnt(rufe(HttpMethod.POST, "", wer, mitOrt), 400, "anfrage_ungueltig", "feld", "orte");
        Map<String, Object> mitBeschreibung = neueOhneName(null);
        mitBeschreibung.put("hauptgroesse", referenzMessstelle("MS-06").get("hauptgroesse"));
        abgelehnt(rufe(HttpMethod.POST, "", wer, mitBeschreibung), 400, "anfrage_ungueltig", "feld",
                "hauptgroesse.wertart_beschreibung");
        abgelehnt(rufe(HttpMethod.POST, "", wer, List.of()), 400, "anfrage_ungueltig", "feld", "");

        // Nebengrößen: Katalog wie die Hauptgröße, je (Größe, Richtung) einmal, nie die Hauptgröße.
        Map<String, Object> neben = neueOhneName(null);
        Map<String, Object> leistung = Map.of("groesse", "Wirkleistung", "richtung", "Bezug",
                "einheit", "kW", "wertart", "Momentanwert");
        neben.put("nebengroessen", List.of(leistung, Map.of("groesse", "Wirkleistung", "richtung", "Bezug",
                "einheit", "kW", "wertart", "Zählerstand")));
        abgelehnt(rufe(HttpMethod.POST, "", wer, neben), 400, "groesse_ungueltig", "feld", "nebengroessen[1]");
        neben.put("nebengroessen", List.of(leistung, leistung));
        abgelehnt(rufe(HttpMethod.POST, "", wer, neben), 400, "anfrage_ungueltig", "feld", "nebengroessen[1]");
        neben.put("nebengroessen", List.of(neben.get("hauptgroesse")));
        abgelehnt(rufe(HttpMethod.POST, "", wer, neben), 400, "anfrage_ungueltig", "feld", "nebengroessen[0]");

        // Form vor Belegung (Vertrag §3), und jede Form vor jeder Belegung.
        Map<String, Object> klein = neueOhneName("ms-21");
        abgelehnt(rufe(HttpMethod.POST, "", wer, klein), 400, "kennzeichen_format", null, null);
        Map<String, Object> belegtUndFalsch = neueOhneName("MS-21");
        belegtUndFalsch.put("medium", "Wasser");
        abgelehnt(rufe(HttpMethod.POST, "", wer, belegtUndFalsch), 400, "groesse_ungueltig", "grund", "medium");
        Map<String, Object> leer = neueOhneName("");
        abgelehnt(rufe(HttpMethod.POST, "", wer, leer), 400, "kennzeichen_format", null, null);

        assertThat(messstellen(t)).as("nur MS-21 ist gespeichert").isOne();
        assertThat(eintraege(t)).isOne();
    }

    // ---- A12 ------------------------------------------------------------------

    /**
     * A12: MS-13 wird archiviert; eine neue Messstelle „MS-13“ ist 409 {@code kennzeichen_belegt}
     * („… auch archivierte bleiben belegt“) — und das automatische MS-0022 bleibt vorgeschlagen.
     */
    @Test
    void a12ArchiviertesKennzeichenBleibtBelegtUndMs0022BleibtVorgeschlagen() {
        UUID t = neuerKundenbereich(referenz.at("/unternehmen/name").asText());
        Anrufer wer = admin(t);
        Map<String, String> ids = new HashMap<>();
        for (JsonNode ms : referenz.get("messstellen")) {
            String k = ms.get("kennzeichen").asText();
            ids.put(k, anlegen(wer, wieReferenz(k, ms)).get("id").asText());
        }
        JsonNode naechste = fall("kennzeichen_vorschlag", "vorschlag-naechste-nummer");
        int vorgeschichte = naechste.at("/input/zaehler").asInt();
        root.update("INSERT INTO messstelle_kennzeichen_seq (tenant_id, zaehler) VALUES (?, ?)", t, vorgeschichte);

        JsonNode archiviert = rufe(HttpMethod.POST, "/" + ids.get("MS-13") + "/archivieren", wer, null).getBody();
        assertThat(archiviert.get("lebenszyklus").asText()).isEqualTo("archiviert");

        ResponseEntity<JsonNode> neu = rufe(HttpMethod.POST, "", wer, neueOhneName("MS-13"));
        assertThat(neu.getStatusCode().value()).isEqualTo(409);
        assertThat(neu.getBody().get("code").asText()).isEqualTo("kennzeichen_belegt");
        assertThat(neu.getBody().get("bestehend")).isEqualTo(
                fall("kennzeichen_pruefen", "archiviertes-bleibt-belegt").at("/expected/bestehend"));
        assertThat(neu.getBody().get("message").asText()).contains("auch archivierte bleiben belegt");

        String vorschlag = naechste.at("/expected/kennzeichen").asText();
        assertThat(rufe(HttpMethod.GET, "/kennzeichen-vorschlag", wer, null).getBody()
                .get("kennzeichen").asText()).isEqualTo(vorschlag);
        assertThat(zaehler(t)).isEqualTo(vorgeschichte);
        assertThat(anlegen(wer, neueOhneName(null)).get("kennzeichen").asText()).isEqualTo(vorschlag);
    }

    // ---- Bearbeiten -------------------------------------------------------------

    @Test
    void bearbeitenSchreibtNurWasSichAendertUndNieArtMediumOderHauptgroesse() {
        UUID t = neuerKundenbereich("Bearbeiten-Probe");
        Anrufer wer = admin(t);
        JsonNode ms06 = referenzMessstelle("MS-06");
        JsonNode m = anlegen(wer, wieReferenz("MS-0006", ms06));
        String id = m.get("id").asText();

        // E7: Ahrenberg kürzt MS-0006 auf MS-06 und trägt den Zählerplatz ein.
        JsonNode gekuerzt = rufe(HttpMethod.PUT, "/" + id, wer, Map.of("kennzeichen", "MS-06",
                "name", ms06.get("name").asText(), "notiz", "Zählerplatz UV-3")).getBody();
        assertThat(gekuerzt.get("kennzeichen").asText()).isEqualTo("MS-06");
        assertThat(gekuerzt.get("notiz").asText()).isEqualTo("Zählerplatz UV-3");
        List<Map<String, Object>> eintraege = protokoll(id);
        assertThat(eintraege).extracting(e -> e.get("art")).containsExactly("angelegt", "bearbeitet");
        // alt/neu tragen NUR die geänderten Felder.
        assertThat(json(eintraege.get(1).get("alt"))).isEqualTo(MAPPER.createObjectNode()
                .put("kennzeichen", "MS-0006").putNull("notiz"));
        assertThat(json(eintraege.get(1).get("neu"))).isEqualTo(MAPPER.createObjectNode()
                .put("kennzeichen", "MS-06").put("notiz", "Zählerplatz UV-3"));

        // Nichts geändert: nichts geschrieben, nichts protokolliert.
        assertThat(rufe(HttpMethod.PUT, "/" + id, wer, Map.of("kennzeichen", "MS-06",
                "name", ms06.get("name").asText(), "notiz", "Zählerplatz UV-3")).getBody()).isEqualTo(gekuerzt);
        assertThat(protokoll(id)).hasSize(2);

        // Art, Medium und Hauptgröße sind nie änderbar — nie still verworfen.
        for (String feld : List.of("art", "medium", "hauptgroesse")) {
            Map<String, Object> body = new LinkedHashMap<>(Map.of("kennzeichen", "MS-06"));
            body.put(feld, feld.equals("hauptgroesse") ? groesseAus(ms06.get("hauptgroesse")) : "Gas");
            ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/" + id, wer, body);
            abgelehnt(r, 400, "anfrage_ungueltig", "feld", feld);
            assertThat(r.getBody().get("message").asText()).contains("nie änderbar");
        }
        abgelehnt(rufe(HttpMethod.PUT, "/" + id, wer, Map.of("kennzeichen", "ms-06")), 400,
                "kennzeichen_format", null, null);
        abgelehnt(rufe(HttpMethod.PUT, "/" + id, wer, Map.of("name", "ohne Kennzeichen")), 400,
                "kennzeichen_format", null, null);
        assertThat(protokoll(id)).hasSize(2);

        // Ein leerer Name ist „fehlt“ (NULL) — die Messstelle sagt es.
        JsonNode ohneName = rufe(HttpMethod.PUT, "/" + id, wer, Map.of("kennzeichen", "MS-06", "name", "   ")).getBody();
        assertThat(ohneName.get("name").isNull()).isTrue();
        assertThat(ohneName.get("notiz").isNull()).as("ein fehlendes Feld ist leer").isTrue();
        assertThat(texte(ohneName.get("fehlt"))).containsExactly("name", "ort");
        assertThat(protokoll(id)).hasSize(3);
    }

    // ---- Anhalten · Fortsetzen · Archivieren (A15) --------------------------------

    @Test
    void anhaltenFortsetzenArchivierenMitIhrenZeitpunktRegeln() {
        UUID t = neuerKundenbereich("Übergänge-Probe");
        Anrufer wer = admin(t);
        String id = anlegen(wer, wieReferenz("MS-06", referenzMessstelle("MS-06"))).get("id").asText();
        Instant jetzt = Instant.now().truncatedTo(MINUTES);
        Instant umbau = jetzt.minus(3, HOURS);

        // Auf die Minute, nie in der Zukunft.
        abgelehnt(rufe(HttpMethod.POST, "/" + id + "/anhalten", wer, uebergang(umbau.plusSeconds(30), null)),
                400, "anfrage_ungueltig", "feld", "zeitpunkt");
        abgelehnt(rufe(HttpMethod.POST, "/" + id + "/anhalten", wer, uebergang(jetzt.plus(2, HOURS), null)),
                422, "zeitpunkt_in_zukunft", null, null);

        JsonNode angehalten = rufe(HttpMethod.POST, "/" + id + "/anhalten", wer, uebergang(umbau, "Umbau")).getBody();
        assertThat(angehalten.get("angehalten_ab").asText()).isEqualTo(zeit(umbau));
        Map<String, Object> e = letzter(id);
        assertThat(e.get("art")).isEqualTo("angehalten");
        assertThat(((java.sql.Timestamp) e.get("gilt_ab")).toInstant()).isEqualTo(umbau);
        assertThat(e.get("rueckwirkend")).isEqualTo(true);
        assertThat(e.get("grund")).isEqualTo("Umbau");
        assertThat(json(e.get("neu")).get("angehalten_ab").asText()).isEqualTo(zeit(umbau));

        abgelehnt(rufe(HttpMethod.POST, "/" + id + "/anhalten", wer, null), 409, "zustand_passt_nicht",
                "angehalten_ab", zeit(umbau));

        // A15: nie vor (oder genau beim) Vorgänger — derselbe Code wie der Wechsel einer Quelle.
        for (Instant zuFrueh : List.of(umbau, umbau.minus(1, HOURS))) {
            ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/" + id + "/fortsetzen", wer, uebergang(zuFrueh, null));
            abgelehnt(r, Fehler.ZEITPUNKT_VOR_VORGAENGER.status(), "zeitpunkt_vor_vorgaenger", null, null);
            assertThat(r.getBody().at("/vorgaenger/art").asText()).isEqualTo("angehalten");
            assertThat(r.getBody().at("/vorgaenger/gilt_ab").asText()).isEqualTo(zeit(umbau));
        }
        abgelehnt(rufe(HttpMethod.POST, "/" + id + "/fortsetzen", wer, uebergang(jetzt.plus(1, HOURS), null)),
                422, "zeitpunkt_in_zukunft", null, null);
        assertThat(protokoll(id)).as("abgelehnt heißt: kein Eintrag").hasSize(2);

        Instant weiter = umbau.plus(1, HOURS);
        JsonNode fortgesetzt = rufe(HttpMethod.POST, "/" + id + "/fortsetzen", wer, uebergang(weiter, null)).getBody();
        assertThat(fortgesetzt.get("angehalten_ab").isNull()).isTrue();
        assertThat(letzter(id).get("art")).isEqualTo("fortgesetzt");
        assertThat(json(letzter(id).get("alt")).get("angehalten_ab").asText()).isEqualTo(zeit(umbau));
        abgelehnt(rufe(HttpMethod.POST, "/" + id + "/fortsetzen", wer, null), 409, "zustand_passt_nicht", null, null);

        // Auch Anhalten und Archivieren liegen NACH dem letzten Übergang.
        ResponseEntity<JsonNode> wieder = rufe(HttpMethod.POST, "/" + id + "/anhalten", wer, uebergang(weiter, null));
        abgelehnt(wieder, 422, "zeitpunkt_vor_vorgaenger", null, null);
        assertThat(wieder.getBody().at("/vorgaenger/art").asText()).isEqualTo("fortgesetzt");
        abgelehnt(rufe(HttpMethod.POST, "/" + id + "/archivieren", wer, uebergang(umbau.plus(30, MINUTES), null)),
                422, "zeitpunkt_vor_vorgaenger", null, null);
        abgelehnt(rufe(HttpMethod.POST, "/" + id + "/archivieren", wer, uebergang(jetzt.plus(2, HOURS), null)),
                422, "zeitpunkt_in_zukunft", null, null);
        assertThat(protokoll(id)).hasSize(3);

        // Archivieren ohne Zeitpunkt: jetzt.
        Instant vorher = Instant.now().truncatedTo(MINUTES);
        JsonNode archiviert = rufe(HttpMethod.POST, "/" + id + "/archivieren", wer, null).getBody();
        Instant nachher = Instant.now().truncatedTo(MINUTES);
        Instant am = OffsetDateTime.parse(archiviert.get("archiviert_am").asText()).toInstant();
        assertThat(am).isBetween(vorher, nachher);
        assertThat(archiviert.get("lebenszyklus").asText()).isEqualTo("archiviert");
        assertThat(archiviert.at("/nebengroessen/0/lebenszyklus").asText()).as("mit der Messstelle").isEqualTo("archiviert");
        assertThat(letzter(id).get("art")).isEqualTo("archiviert");
        assertThat(letzter(id).get("rueckwirkend")).isEqualTo(false);

        // Kein Wiederbeleben, keine Änderung — und das Kennzeichen bleibt belegt (A12).
        for (String route : List.of("/archivieren", "/anhalten", "/fortsetzen")) {
            abgelehnt(rufe(HttpMethod.POST, "/" + id + route, wer, null), 409, "zustand_passt_nicht", null, null);
        }
        abgelehnt(rufe(HttpMethod.PUT, "/" + id, wer, Map.of("kennzeichen", "MS-06", "name", "neu")),
                409, "zustand_passt_nicht", null, null);
        ResponseEntity<JsonNode> belegt = rufe(HttpMethod.POST, "", wer, neueOhneName("MS-06"));
        abgelehnt(belegt, 409, "kennzeichen_belegt", null, null);
        assertThat(belegt.getBody().at("/bestehend/archiviert").asBoolean()).isTrue();
        assertThat(protokoll(id)).extracting(x -> x.get("art"))
                .containsExactly("angelegt", "angehalten", "fortgesetzt", "archiviert");
    }

    @Test
    void eineAngehalteneMessstelleLaesstSichArchivierenAberNichtVorDemAnhalten() {
        UUID t = neuerKundenbereich("Archivieren-Probe");
        Anrufer wer = admin(t);
        String id = anlegen(wer, wieReferenz("MS-13", referenzMessstelle("MS-13"))).get("id").asText();
        Instant umbau = Instant.now().truncatedTo(MINUTES).minus(2, HOURS);
        rufe(HttpMethod.POST, "/" + id + "/anhalten", wer, uebergang(umbau, "Bereich B-5 wird aufgelöst"));
        abgelehnt(rufe(HttpMethod.POST, "/" + id + "/archivieren", wer, uebergang(umbau, null)),
                422, "zeitpunkt_vor_vorgaenger", null, null);
        JsonNode archiviert = rufe(HttpMethod.POST, "/" + id + "/archivieren", wer,
                uebergang(umbau.plus(10, MINUTES), "Bereich aufgelöst")).getBody();
        assertThat(archiviert.get("lebenszyklus").asText()).isEqualTo("archiviert");
        assertThat(archiviert.get("archiviert_am").asText()).isEqualTo(zeit(umbau.plus(10, MINUTES)));
        assertThat(letzter(id).get("rueckwirkend")).isEqualTo(true);
        assertThat(letzter(id).get("grund")).isEqualTo("Bereich aufgelöst");
    }

    // ---- Mandanten-Zaun und Urheber --------------------------------------------

    @Test
    void eineFremdeMessstelleIst404UndDasKennzeichenGiltJeKundenbereich() {
        JsonNode m = anlegen(DEMO, neueOhneName(null));
        String id = m.get("id").asText();

        assertThat(rufe(HttpMethod.GET, "/" + id, DEMO2, null).getStatusCode().value()).isEqualTo(404);
        assertThat(rufe(HttpMethod.PUT, "/" + id, DEMO2, Map.of("kennzeichen", "MS-99")).getStatusCode().value())
                .isEqualTo(404);
        for (String route : List.of("/anhalten", "/fortsetzen", "/archivieren")) {
            assertThat(rufe(HttpMethod.POST, "/" + id + route, DEMO2, null).getStatusCode().value())
                    .as(route).isEqualTo(404);
        }
        assertThat(rufe(HttpMethod.GET, "", DEMO2, null).getBody().get("messstellen"))
                .extracting(n -> n.get("id").asText()).doesNotContain(id);
        // Dasselbe Kennzeichen im anderen Kundenbereich: kein Zusammenstoß, kein Verrat.
        assertThat(anlegen(DEMO2, neueOhneName(m.get("kennzeichen").asText())).get("kennzeichen").asText())
                .isEqualTo(m.get("kennzeichen").asText());

        // Der Plattform-Admin ohne gewählten Kundenbereich sieht nichts und legt nichts an.
        assertThat(rufe(HttpMethod.GET, "", ADMIN_OHNE_KUNDENBEREICH, null).getBody().get("messstellen").isEmpty())
                .isTrue();
        assertThat(rufe(HttpMethod.GET, "/" + id, ADMIN_OHNE_KUNDENBEREICH, null).getStatusCode().value())
                .isEqualTo(404);
        assertThat(rufe(HttpMethod.POST, "", ADMIN_OHNE_KUNDENBEREICH, neueOhneName(null)).getStatusCode().value())
                .isEqualTo(403);

        assertThat(rufe(HttpMethod.GET, "", null, null).getStatusCode().value()).isEqualTo(401);
        assertThat(rufe(HttpMethod.GET, "/" + id, DEMO, null).getBody()).isEqualTo(m);
    }

    /** Anlegen, bearbeiten, anhalten, fortsetzen, archivieren: fünf Einträge, jeder mit Urheber. */
    @Test
    void jederSchreibvorgangSchreibtGenauEinenEintragMitUrheber() {
        JsonNode m = anlegen(DEMO, neueOhneName(null));
        String id = m.get("id").asText();
        Instant umbau = Instant.now().truncatedTo(MINUTES).minus(1, HOURS);
        assertThat(rufe(HttpMethod.PUT, "/" + id, DEMO, Map.of("kennzeichen", m.get("kennzeichen").asText(),
                "name", "Lagerhalle Lindach gesamt")).getStatusCode().value()).isEqualTo(200);
        assertThat(rufe(HttpMethod.POST, "/" + id + "/anhalten", DEMO, uebergang(umbau, "Umbau"))
                .getStatusCode().value()).isEqualTo(200);
        assertThat(rufe(HttpMethod.POST, "/" + id + "/fortsetzen", DEMO, uebergang(umbau.plus(20, MINUTES), null))
                .getStatusCode().value()).isEqualTo(200);
        assertThat(rufe(HttpMethod.POST, "/" + id + "/archivieren", DEMO, null).getStatusCode().value()).isEqualTo(200);
        // Abgelehnte Schreibvorgänge schreiben keinen.
        assertThat(rufe(HttpMethod.POST, "/" + id + "/anhalten", DEMO, null).getStatusCode().value()).isEqualTo(409);

        JsonNode demo = anspruch("demo");
        List<Map<String, Object>> eintraege = protokoll(id);
        assertThat(eintraege).extracting(e -> e.get("art"))
                .containsExactly("angelegt", "bearbeitet", "angehalten", "fortgesetzt", "archiviert");
        for (Map<String, Object> e : eintraege) {
            // AP-03 E12: jeder heutige Kundenbenutzer ist Kundenadministrator.
            assertThat(e.get("actor_sub")).isEqualTo(demo.get("sub").asText());
            assertThat(e.get("actor_name")).isEqualTo("demo");
            assertThat(e.get("actor_rolle")).isEqualTo(RechteAbleitung.Rolle.KUNDENADMINISTRATOR.code());
            assertThat(e.get("actor_art")).isEqualTo("kunde");
            assertThat(e.get("tenant_id")).isEqualTo(UUID.fromString("00000000-0000-0000-0000-000000000001"));
        }
    }

    // ---- Gerüst: Schnittstelle ------------------------------------------------

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
        return rest.exchange("http://localhost:" + port + BASIS + pfad, methode, entity, JsonNode.class);
    }

    private JsonNode anlegen(Anrufer wer, Map<String, Object> body) {
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "", wer, body);
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return r.getBody();
    }

    /** Die Ablehnung mit Status, Code und (wenn genannt) einem Fakt. */
    private static void abgelehnt(ResponseEntity<JsonNode> r, int status, String code, String fakt, String wert) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(status);
        assertThat(r.getBody().get("code").asText()).isEqualTo(code);
        assertThat(r.getBody().get("message").asText()).isNotBlank();
        assertThat(MessstelleAbgelehnt.CODES).contains(code);
        if (fakt != null) {
            assertThat(r.getBody().get(fakt).asText()).isEqualTo(wert);
        }
    }

    /**
     * Speichert den Bestand eines Kennzeichen-Falls über die Schnittstelle: je Träger die
     * Messstelle der Referenz (über ihr heutiges Kennzeichen oder ihren Namen), angelegt unter
     * ihrem frühesten Kennzeichen, umbenannt bis zum heutigen, archiviert, wenn der Fall es sagt.
     * Liefert die id je heutigem Kennzeichen.
     */
    private Map<String, String> belegeWieDerFall(Anrufer wer, JsonNode vergeben) {
        Map<String, List<JsonNode>> jeTraeger = new LinkedHashMap<>();
        for (JsonNode v : vergeben) {
            jeTraeger.computeIfAbsent(v.get("messstelle").asText(), k -> new ArrayList<>()).add(v);
        }
        Map<String, String> ids = new LinkedHashMap<>();
        jeTraeger.forEach((traeger, eintraege) -> {
            JsonNode heute = eintraege.stream().filter(e -> !e.get("frueher").asBoolean()).findFirst().orElseThrow();
            List<String> kennzeichen = new ArrayList<>(eintraege.stream().filter(e -> e.get("frueher").asBoolean())
                    .map(e -> e.get("kennzeichen").asText()).toList());
            kennzeichen.add(traeger);
            String name = heute.get("name").asText();
            JsonNode ms = Objects.requireNonNullElse(referenzMessstelle(traeger), referenzMessstelleNachName(name));
            assertThat(ms).as("Träger " + traeger + " im Referenzunternehmen").isNotNull();
            String id = anlegen(wer, wieReferenz(kennzeichen.get(0), ms)).get("id").asText();
            for (String k : kennzeichen.subList(1, kennzeichen.size())) {
                assertThat(rufe(HttpMethod.PUT, "/" + id, wer, Map.of("kennzeichen", k, "name", name))
                        .getStatusCode().value()).isEqualTo(200);
            }
            if (heute.get("archiviert").asBoolean()) {
                assertThat(rufe(HttpMethod.POST, "/" + id + "/archivieren", wer, null).getStatusCode().value())
                        .isEqualTo(200);
            }
            ids.put(traeger, id);
        });
        return ids;
    }

    /** Eine Messstelle mit den Werten der Referenz — unter dem gegebenen Kennzeichen ({@code null} = automatisch). */
    private static Map<String, Object> wieReferenz(String kennzeichen, JsonNode ms) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", kennzeichen);
        body.put("name", ms.get("name").asText());
        body.put("art", ms.get("art").asText());
        body.put("medium", ms.get("medium").asText());
        body.put("hauptgroesse", groesseAus(ms.get("hauptgroesse")));
        List<JsonNode> neben = new ArrayList<>();
        ms.get("nebengroessen").forEach(n -> neben.add(groesseAus(n)));
        body.put("nebengroessen", neben);
        return body;
    }

    /** Wie im Lebenszyklus-Fall neue-messstelle-ohne-name-und-ort: gemessen, Strom, der Name fehlt noch. */
    private static Map<String, Object> neueOhneName(String kennzeichen) {
        JsonNode in = fall("lebenszyklus", "neue-messstelle-ohne-name-und-ort").get("input");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", kennzeichen);
        body.put("art", in.get("art").asText());
        body.put("medium", in.get("medium").asText());
        body.put("hauptgroesse", in.get("hauptgroesse"));
        return body;
    }

    /** Die vier Merkmale einer Größe der Referenz (ohne deren Beschreibungen). */
    private static JsonNode groesseAus(JsonNode g) {
        ObjectNode n = MAPPER.createObjectNode();
        for (String f : List.of("groesse", "richtung", "einheit", "wertart")) {
            n.put(f, g.get(f).asText());
        }
        return n;
    }

    private static Map<String, Object> uebergang(Instant zeitpunkt, String grund) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("zeitpunkt", zeit(zeitpunkt));
        if (grund != null) {
            body.put("grund", grund);
        }
        return body;
    }

    /** Ein Zeitpunkt in der Form des Vertrags: auf die Minute (oder genauer), Versatz Europe/Berlin. */
    private static String zeit(Instant t) {
        return DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(OffsetDateTime.ofInstant(t, BERLIN));
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

    /** Die Ansprüche im Token des Benutzers — {@code sub} ist je Keycloak-Container neu. */
    private JsonNode anspruch(String benutzer) {
        String nutzlast = token(benutzer).split("\\.")[1];
        try {
            return MAPPER.readTree(new String(Base64.getUrlDecoder().decode(nutzlast), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- Gerüst: Datenbank und Vertrag -----------------------------------------

    private static UUID neuerKundenbereich(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
    }

    private static Integer zaehler(UUID tenant) {
        List<Integer> z = root.queryForList("SELECT zaehler FROM messstelle_kennzeichen_seq WHERE tenant_id = ?",
                Integer.class, tenant);
        return z.isEmpty() ? null : z.get(0);
    }

    private static long messstellen(UUID tenant) {
        return root.queryForObject("SELECT count(*) FROM messstelle WHERE tenant_id = ?", Long.class, tenant);
    }

    private static long eintraege(UUID tenant) {
        return root.queryForObject("SELECT count(*) FROM messstelle_aenderung WHERE tenant_id = ?", Long.class, tenant);
    }

    /** Das Protokoll der Messstelle in der Reihenfolge des Schreibens. */
    private static List<Map<String, Object>> protokoll(String messstelle) {
        return root.queryForList("SELECT tenant_id, art, alt::text AS alt, neu::text AS neu, gilt_ab, rueckwirkend, "
                + "grund, actor_sub, actor_name, actor_rolle, actor_art FROM messstelle_aenderung "
                + "WHERE messstelle_id = ? ORDER BY id", UUID.fromString(messstelle));
    }

    private static Map<String, Object> letzter(String messstelle) {
        List<Map<String, Object>> alle = protokoll(messstelle);
        return alle.get(alle.size() - 1);
    }

    /** Die Belegung des Kundenbereichs — dieselbe Abfrage wie {@code MessstelleRepository.vergeben()}. */
    private static Set<Vergeben> belegung(UUID tenant) {
        return new HashSet<>(root.query("SELECT k.kennzeichen, m.kennzeichen AS traeger, m.name, "
                + "m.archiviert_am IS NOT NULL AS archiviert, k.kennzeichen <> m.kennzeichen AS frueher "
                + "FROM messstelle_kennzeichen k JOIN messstelle m ON m.id = k.messstelle_id "
                + "WHERE k.tenant_id = ?",
                (rs, n) -> new Vergeben(rs.getString("kennzeichen"), rs.getString("traeger"),
                        rs.getString("name"), rs.getBoolean("archiviert"), rs.getBoolean("frueher")), tenant));
    }

    private static Set<Vergeben> vergebenAus(JsonNode liste) {
        Set<Vergeben> s = new HashSet<>();
        liste.forEach(v -> s.add(new Vergeben(v.get("kennzeichen").asText(), v.get("messstelle").asText(),
                v.get("name").asText(), v.get("archiviert").asBoolean(), v.get("frueher").asBoolean())));
        return s;
    }

    private static String nameVon(JsonNode vergeben, String traeger) {
        for (JsonNode v : vergeben) {
            if (v.get("messstelle").asText().equals(traeger)) {
                return v.get("name").asText();
            }
        }
        throw new AssertionError("kein Träger " + traeger);
    }

    private static Fehler fehler(String code) {
        return Arrays.stream(Fehler.values()).filter(f -> f.code().equals(code)).findFirst().orElseThrow();
    }

    private static JsonNode referenzMessstelle(String kennzeichen) {
        for (JsonNode ms : referenz.get("messstellen")) {
            if (ms.get("kennzeichen").asText().equals(kennzeichen)) {
                return ms;
            }
        }
        return null;
    }

    private static JsonNode referenzMessstelleNachName(String name) {
        for (JsonNode ms : referenz.get("messstellen")) {
            if (ms.get("name").asText().equals(name)) {
                return ms;
            }
        }
        return null;
    }

    private static Stream<JsonNode> faelle(String familie) {
        List<JsonNode> out = new ArrayList<>();
        vektoren.path("cases").path(familie).forEach(out::add);
        assertThat(out).as("Fälle der Familie " + familie).isNotEmpty();
        return out.stream();
    }

    private static JsonNode fall(String familie, String name) {
        return faelle(familie).filter(f -> f.get("name").asText().equals(name)).findFirst()
                .orElseThrow(() -> new AssertionError("kein Fall " + familie + "/" + name));
    }

    private static JsonNode json(Object text) {
        try {
            return MAPPER.readTree((String) text);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static List<String> texte(JsonNode liste) {
        return StreamSupport.stream(liste.spliterator(), false).map(JsonNode::asText).toList();
    }
}
