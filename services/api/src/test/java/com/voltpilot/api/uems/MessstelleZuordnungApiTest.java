package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.MessstelleRegeln.Stellung;
import com.voltpilot.api.uems.MessstelleRegeln.StellungEintrag;
import com.voltpilot.api.uems.MessstelleRegeln.StellungKandidat;
import com.voltpilot.api.uems.MessstelleRegeln.StellungUrteil;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.AfterEach;
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
 * Die Zuordnungen der Messstelle (UEMS AP-04 IP-7, Teil Ort und elektrische Stellung) Ende zu
 * Ende gegen echtes Keycloak + TimescaleDB: {@code PUT /api/v1/messstellen/{id}/ort},
 * {@code …/stellung}, {@code GET …/standort?am=}, die Felder {@code orte} und
 * {@code elektrische_stellung} der Messstellen-Antwort, die Messstellen im Archiv-Sperrgrund
 * eines Standorts ({@link MessstelleOrtsbaumMessstellen}) und die Messstellen-Zahl des
 * Ortsbaum-Lesemodells.
 *
 * <p>Die einzige Beispielquelle ist das Referenzunternehmen ({@code uems-referenzunternehmen.json},
 * Fassung 1.1): Standorte, Gebäude, Bereiche, Anlagen und Messstellen mit ihren Kennzeichen, und
 * jede Ort- und Stellungs-Zuordnung wird über die Schnittstelle eingetragen — auch der zweite
 * Hauptzähler MS-02 (Abgabe) neben MS-01 (Bezug): beide lesen mit ihrer führenden Quelle (IP-13)
 * denselben Netzzähler K-3. Die Fälle der Familie {@code stellung} (messstelle-vectors.json)
 * laufen alle über die Schnittstelle, mit den führenden Quellen ihres Stands.
 *
 * <p>Bewiesen wird der Prüfnachweis von IP-7: Überlappung 409, zweiter Hauptzähler 409, Zyklus
 * 422, Unterzähler auf eine Fremdanlage 422, das Ziel bestand am Tag nicht (Vertragsgrund),
 * „Stand am“ vor und nach einem Ortswechsel (A17), der Archiv-Sperrgrund mit der Messstelle,
 * eine fremde Messstelle ist 404, und je Schreibvorgang genau ein Protokolleintrag.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class MessstelleZuordnungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final List<String> NUR_SCHNITTSTELLE = List.of("id", "fehlt", "angehalten_ab", "archiviert_am");
    /** Der Tag, an dem Ahrenberg das Unternehmens-Energiemanagement einführt (Referenz: eingetragen_am). */
    private static final String EINFUEHRUNG = "2026-10-01T09:12:00+02:00";

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

    @Autowired
    StandortService standortService;

    @Autowired
    MessstelleService messstelleService;

    @Autowired
    MessstelleZuordnungService zuordnungService;

    private static JsonNode referenz;
    private static JsonNode vektoren;
    private static JsonNode ortsbaum;
    private static JsonNode schema;
    private static JdbcTemplate root;
    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();
    /** Das über die Schnittstelle gebaute Referenzunternehmen — einmal, für alle lesenden Tests. */
    private static Ahrenberg ahrenberg;

    private record Anrufer(String benutzer, UUID kundenbereich) {}

    private record Token(String wert, long geholt) {}

    private static final Anrufer DEMO2 = new Anrufer("demo2", null);
    private static final Anrufer ADMIN_OHNE_KUNDENBEREICH = new Anrufer("admin", null);

    private static Anrufer admin(UUID kundenbereich) {
        return new Anrufer("admin", kundenbereich);
    }

    @BeforeAll
    static void ladeVertrag() throws IOException {
        referenz = MAPPER.readTree(V2.resolve("uems-referenzunternehmen.json").toFile());
        vektoren = MAPPER.readTree(V2.resolve("messstelle-vectors.json").toFile());
        ortsbaum = MAPPER.readTree(V2.resolve("ortsbaum-vectors.json").toFile());
        schema = MAPPER.readTree(V2.resolve("messstelle.schema.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void uhrenZurueck() {
        standortService.uhrStellen(Clock.systemUTC());
        messstelleService.uhrStellen(Clock.systemUTC());
        zuordnungService.uhrStellen(Clock.systemUTC());
    }

    // ---- Das Referenzunternehmen über die Schnittstelle -----------------------

    /**
     * Jede Ort- und Stellungs-Zuordnung des Referenzunternehmens über {@code PUT …/ort} und
     * {@code PUT …/stellung}, eingetragen am Tag der Einführung (01.10.2026): die Antwort trägt
     * sie zeichengleich in der Form des Vertrags ({@code messstelle.schema.json}), der
     * Lebenszyklus sieht den Ort, und jeder Schreibvorgang schreibt genau einen Eintrag — die vom
     * 12.03.2024 rückwirkend, die vom 01.10.2026 ab heute, der Umzug von MS-08 geplant. MS-02
     * (Abgabe) ist neben MS-01 (Bezug) Hauptzähler von AN-1: ihre führenden Quellen (IP-13) lesen
     * beide den Netzzähler K-3.
     */
    @Test
    void ahrenbergsOrteUndStellungenUeberDieSchnittstelle() {
        Ahrenberg ah = ahrenberg();
        for (String kz : List.of("MS-01", "MS-02")) {
            JsonNode m = ok(rufe(HttpMethod.GET, "/messstellen/" + ah.messstelle(kz), ah.wer(), null));
            assertThat(m.at("/elektrische_stellung/0/stellung").asText()).as(kz).isEqualTo("Hauptzähler");
            assertThat(m.at("/fuehrende_quelle/0/komponente").asText()).as(kz).isEqualTo(ah.k3().toString());
        }

        Map<String, JsonNode> liste = new LinkedHashMap<>();
        rufe(HttpMethod.GET, "/messstellen", ah.wer(), null).getBody().get("messstellen")
                .forEach(m -> liste.put(m.get("kennzeichen").asText(), m));
        for (JsonNode ms : referenz.get("messstellen")) {
            String kz = ms.get("kennzeichen").asText();
            JsonNode m = ok(rufe(HttpMethod.GET, "/messstellen/" + ah.messstelle(kz), ah.wer(), null));
            assertThat(liste.get(kz)).as("Liste und Einzelabruf sagen dasselbe: " + kz).isEqualTo(m);
            assertThat(m.get("orte")).as("Orte " + kz).isEqualTo(orteDerReferenz(kz));
            JsonNode stellung = stellungenDerReferenz(ms, ah);
            assertThat(m.get("elektrische_stellung")).as("Stellung " + kz).isEqualTo(stellung);
            ObjectNode vertrag = m.deepCopy();
            NUR_SCHNITTSTELLE.forEach(vertrag::remove);
            assertThat(UemsSchemaLaeufer.verstoesse(vertrag, schema)).as("Schema " + kz).isEmpty();
            // Mit dem Ort ist eine gemessene Messstelle eingerichtet und aktiv (E8: eine Quelle ist keine
            // Voraussetzung); eine berechnete bleibt ohne Formel ein Entwurf (E9), mit oder ohne Ort.
            if ("berechnet".equals(ms.get("art").asText())) {
                assertThat(m.get("lebenszyklus").asText()).as(kz).isEqualTo("entwurf");
                assertThat(texte(m.get("fehlt"))).as(kz).containsExactly("formel");
            } else {
                assertThat(m.get("lebenszyklus").asText()).as(kz).isEqualTo("aktiv");
                assertThat(m.get("fehlt")).as(kz).isEmpty();
            }
        }

        // Je Schreibvorgang genau ein Eintrag — auch je Quelle von MS-01 und MS-02.
        JsonNode admin = anspruch("admin");
        for (JsonNode ms : referenz.get("messstellen")) {
            String kz = ms.get("kennzeichen").asText();
            long orte = zuordnungenDerReferenz("messstelle_ort", kz).size();
            long stellungen = ms.get("elektrische_stellung").size();
            long quellen = HAUPTZAEHLER_AN1.contains(kz) ? 1 : 0;
            List<Map<String, Object>> eintraege = protokoll(ah.messstelle(kz));
            assertThat(eintraege).as("Protokoll " + kz).hasSize((int) (1 + orte + stellungen + quellen));
            for (Map<String, Object> e : eintraege.subList(1, eintraege.size())) {
                assertThat(e.get("art")).isIn("ort_zugeordnet", "stellung_zugeordnet", "quelle_gebunden");
                assertThat(e.get("actor_sub")).isEqualTo(admin.get("sub").asText());
                assertThat(e.get("actor_art")).isEqualTo("voltpilot");
            }
        }
        // Rückwirkend ab 12.03.2024 — derselbe Tageszähler wie das Abzeichen der Referenz.
        JsonNode ms01Ort = zuordnungenDerReferenz("messstelle_ort", "MS-01").get(0);
        // (Vor dem Ort steht bei MS-01 ihre Quelle im Protokoll — IP-13.)
        Map<String, Object> ms01 = protokoll(ah.messstelle("MS-01")).stream()
                .filter(e -> !"quelle_gebunden".equals(e.get("art"))).skip(1).findFirst().orElseThrow();
        assertThat(ms01.get("art")).isEqualTo("ort_zugeordnet");
        assertThat(ms01.get("rueckwirkend")).isEqualTo(true);
        assertThat(ms01.get("gilt_ab").toString()).startsWith("2024-03-12 00:00:00");
        assertThat(json(ms01.get("neu"))).isEqualTo(MAPPER.valueToTree(ortZ("standort", "ST-1", "2024-03-12", null)));
        assertThat(ms01.get("alt")).as("die erste Zuordnung hat kein Vorher").isNull();
        assertThat(OrtsbaumAbleitung.rueckwirkung(new RueckwirkungEingang(OffsetDateTime.parse(EINFUEHRUNG),
                LocalDate.parse(ms01Ort.get("gueltig_ab").asText()), null, BERLIN, null)).abzeichen())
                .isEqualTo(ms01Ort.get("abzeichen").asText());
        // Ab heute (01.10.2026) nicht rückwirkend; der Umzug von MS-08 am 01.03.2027 ist geplant.
        assertThat(protokoll(ah.messstelle("MS-09")).get(1).get("rueckwirkend")).isEqualTo(false);
        Map<String, Object> umzug = protokoll(ah.messstelle("MS-08")).get(2);
        assertThat(umzug.get("art")).isEqualTo("ort_zugeordnet");
        assertThat(umzug.get("rueckwirkend")).isEqualTo(false);
        assertThat(json(umzug.get("alt")).get("kennzeichen").asText()).isEqualTo("B-2");
        assertThat(json(umzug.get("alt")).get("gueltig_bis").isNull()).as("das Intervall, wie es vorher war").isTrue();
        assertThat(json(umzug.get("neu")).get("kennzeichen").asText()).isEqualTo("B-3");
    }

    /**
     * A17 „Stand am“: vor und nach dem Umzug von MS-08 (B-2 → B-3, AN-1 → AN-2 am 01.03.2027),
     * MS-06 am 15.11. und 20.11.2026 (Ort und Stellung gleich), dazu die Fälle der Familie
     * {@code messstelle_standort} der Ortsbaum-Vektoren, deren Stand das Referenzunternehmen
     * trägt (der Umzug von Halle 2 nach ST-3 und der frühere Beginn von MS-06 stehen nur im
     * Ortsbaum-Szenario).
     */
    @Test
    void a17StandAmVorUndNachDemOrtswechsel() {
        Ahrenberg ah = ahrenberg();
        JsonNode feb = standAm(ah, "MS-08", "2027-02-28");
        assertThat(feb.get("ort").asText()).isEqualTo("B-2");
        assertThat(feb.get("ort_art").asText()).isEqualTo("bereich");
        assertThat(texte(feb.get("pfad"))).containsExactly("B-2", "G-1", "ST-1");
        assertThat(feb.get("standort").asText()).isEqualTo("ST-1");
        assertThat(feb.get("standort_id").asText()).isEqualTo(ah.standorte().get("ST-1").toString());
        assertThat(feb.get("grund").asText()).isEqualTo("verortet");
        assertThat(feb.at("/elektrische_stellung/anlage").asText()).isEqualTo(ah.anlagen().get("AN-1").toString());
        assertThat(feb.at("/elektrische_stellung/unterzaehler_von").asText()).isEqualTo("MS-01");
        assertThat(feb.at("/elektrische_stellung/gueltig_bis").asText()).isEqualTo("2027-02-28");
        JsonNode mrz = standAm(ah, "MS-08", "2027-03-01");
        assertThat(mrz.get("ort").asText()).isEqualTo("B-3");
        assertThat(texte(mrz.get("pfad"))).containsExactly("B-3", "G-2", "ST-1");
        assertThat(mrz.at("/elektrische_stellung/anlage").asText()).isEqualTo(ah.anlagen().get("AN-2").toString());
        assertThat(mrz.at("/elektrische_stellung/unterzaehler_von").asText()).isEqualTo("MS-10");
        assertThat(mrz.at("/elektrische_stellung/gueltig_bis").isNull()).isTrue();

        JsonNode vor = standAm(ah, "MS-06", "2026-11-15");
        JsonNode nach = standAm(ah, "MS-06", "2026-11-20");
        for (String feld : List.of("ort", "ort_art", "pfad", "standort", "grund", "elektrische_stellung")) {
            assertThat(nach.get(feld)).as(feld).isEqualTo(vor.get(feld));
        }
        assertThat(vor.get("ort").asText()).isEqualTo("B-1");

        // Vor ihrem ersten Ort ist eine Messstelle nicht verortet (MS-16 ab 15.10.2026 an ST-2).
        assertThat(standAm(ah, "MS-16", "2026-10-14").get("grund").asText()).isEqualTo("nicht_verortet");
        assertThat(standAm(ah, "MS-16", "2026-10-15").get("standort").asText()).isEqualTo("ST-2");

        for (String fall : List.of("ms-10-am-28-02-2027", "ms-08-am-28-02-2027", "a13-ms-14-bleibt-am-standort",
                "ms-19-am-unternehmen", "ms-20-ohne-ort")) {
            JsonNode c = ortsbaumFall(fall);
            JsonNode soll = c.get("expected");
            JsonNode ist = standAm(ah, c.at("/input/messstelle").asText(), c.at("/input/tag").asText());
            assertThat(ist.get("ort")).as(fall).isEqualTo(soll.get("ort"));
            assertThat(ist.get("pfad")).as(fall).isEqualTo(soll.get("pfad"));
            assertThat(ist.get("standort")).as(fall).isEqualTo(soll.get("standort"));
            assertThat(ist.get("grund")).as(fall).isEqualTo(soll.get("grund"));
        }
        assertThat(standAm(ah, "MS-19", "2027-03-01").get("ort_art").asText()).isEqualTo("unternehmen");
        assertThat(standAm(ah, "MS-20", "2027-03-01").get("elektrische_stellung").isNull()).isTrue();

        // Ohne Tag: heute. Ein Tag, der keiner ist: 400.
        zuordnungService.uhrStellen(uhr("2026-10-20T10:15:00+02:00"));
        assertThat(ok(rufe(HttpMethod.GET, "/messstellen/" + ah.messstelle("MS-06") + "/standort", ah.wer(), null))
                .get("am").asText()).isEqualTo("2026-10-20");
        abgelehnt(rufe(HttpMethod.GET, "/messstellen/" + ah.messstelle("MS-06") + "/standort?am=20.10.2026",
                ah.wer(), null), 400, "anfrage_ungueltig", "feld", "am");
    }

    /**
     * Die Messstellen-Zahl des Ortsbaums (AP-02 IP-5, gefüllt mit IP-7): je Knoten die
     * Messstellen, deren Ort am Stichtag genau dieser Knoten ist — gezählt aus den Zuordnungen des
     * Referenzunternehmens, am 20.10.2026 und nach dem Umzug von MS-08 am 01.03.2027.
     */
    @Test
    void dieMessstellenZahlJeKnotenIstDieDerReferenz() {
        Ahrenberg ah = ahrenberg();
        for (String stichtag : List.of("2026-10-20", "2027-03-01")) {
            Map<String, Integer> soll = zahlJeOrt(LocalDate.parse(stichtag));
            JsonNode werk = ok(rufeApi(HttpMethod.GET, "/api/v1/standorte/" + ah.standorte().get("ST-1")
                    + "/orte?stichtag=" + stichtag, ah.wer(), null));
            assertThat(werk.at("/direktAmStandort/messstellenZahl").asInt(-1)).as("ST-1 " + stichtag)
                    .isEqualTo(soll.getOrDefault("ST-1", 0));
            for (JsonNode g : werk.get("gebaeude")) {
                String kz = g.get("kurzzeichen").asText();
                assertThat(g.get("messstellenZahl").asInt(-1)).as(kz + " " + stichtag).isEqualTo(soll.getOrDefault(kz, 0));
                for (JsonNode b : g.get("bereiche")) {
                    String bkz = b.get("kurzzeichen").asText();
                    assertThat(b.get("messstellenZahl").asInt(-1)).as(bkz + " " + stichtag)
                            .isEqualTo(soll.getOrDefault(bkz, 0));
                }
            }
        }
        // Stichprobe der Rechnung: B-2 verliert MS-08 am 01.03.2027, B-3 gewinnt sie.
        assertThat(zahlJeOrt(LocalDate.parse("2026-10-20")).get("B-2")).isEqualTo(3);
        assertThat(zahlJeOrt(LocalDate.parse("2027-03-01")).get("B-2")).isEqualTo(2);
    }

    // ---- Regel 8: die Stellung ------------------------------------------------

    /**
     * Jeder Fall der Familie {@code stellung} über die Schnittstelle: der Stand des Falls am
     * Stichtag als Bestand — Stellungen UND die führenden Quellen seiner Messstellen (IP-13) —, dann
     * {@code PUT …/stellung} der Messstelle des Falls — Status und Code aus der Fehlertabelle, Grund,
     * Bestehende (mit ihrer Anlage) und Kette zeichengleich wie in der Datei.
     */
    @TestFactory
    Stream<DynamicTest> regel8DieFaelleDerFamilieStellungUeberDieSchnittstelle() {
        return faelle("stellung").map(fall -> DynamicTest.dynamicTest(
                fall.get("name").asText(), () -> {
                    Einzelfall e = einzelfall(fall, true);
                    JsonNode soll = fall.get("expected");
                    ResponseEntity<JsonNode> r = e.antwort();
                    if (soll.get("fehler").isNull()) {
                        JsonNode m = ok(r);
                        JsonNode letzte = m.get("elektrische_stellung").get(m.get("elektrische_stellung").size() - 1);
                        assertThat(letzte.get("stellung").asText()).isEqualTo(fall.at("/input/stellung/stellung").asText());
                        assertThat(protokoll(e.kandidat())).hasSize(2 + e.quellen(e.kandidat()));
                        return;
                    }
                    MessstelleRegeln.Fehler f = fehler(soll.get("fehler").asText());
                    abgelehnt(r, f.status(), f.code(), null, null);
                    assertThat(r.getBody().path("grund").isMissingNode() ? null : r.getBody().get("grund").asText())
                            .isEqualTo(soll.get("grund").isNull() ? null : soll.get("grund").asText());
                    if (soll.get("bestehend").isNull()) {
                        assertThat(r.getBody().has("bestehend")).isFalse();
                    } else {
                        JsonNode b = r.getBody().get("bestehend");
                        assertThat(b.get("kennzeichen").asText()).isEqualTo(soll.at("/bestehend/kennzeichen").asText());
                        assertThat(b.get("name").asText()).isEqualTo(soll.at("/bestehend/name").asText());
                        assertThat(b.get("anlage").asText())
                                .isEqualTo(e.anlagen().get(soll.at("/bestehend/anlage").asText()).toString());
                    }
                    List<String> kette = texte(soll.get("kette"));
                    assertThat(r.getBody().has("kette") ? texte(r.getBody().get("kette")) : List.of())
                            .isEqualTo(kette);
                    assertThat(protokoll(e.kandidat())).as("abgelehnt schreibt nichts")
                            .hasSize(1 + e.quellen(e.kandidat()));
                }));
    }

    /**
     * Genau ein Fall der Familie hängt an der Komponente: MS-02 (Abgabe) neben MS-01 (Bezug)
     * desselben Zählers K-3. MIT den führenden Quellen des Falls (IP-13) urteilt die Schnittstelle
     * wie die Datei — erlaubt; OHNE sie ist der Zähler unbekannt, und sie urteilt, wie der Zwilling
     * es ohne Komponente tut: 409, mit dem Hinweis, dass erst die Quelle es belegt.
     */
    @Test
    void derZweiteHauptzaehlerDesselbenZaehlersIstMitSeinerQuelleErlaubt() {
        List<String> brauchen = faelle("stellung").filter(MessstelleZuordnungApiTest::brauchtDieQuelle)
                .map(f -> f.get("name").asText()).toList();
        assertThat(brauchen).containsExactly("ms-02-abgabe-neben-bezug-desselben-zaehlers");
        JsonNode fall = fall("stellung", brauchen.get(0));
        assertThat(fall.at("/expected/fehler").isNull()).isTrue();

        Einzelfall mit = einzelfall(fall, true);
        JsonNode m = ok(mit.antwort());
        assertThat(m.at("/elektrische_stellung/0/stellung").asText()).isEqualTo("Hauptzähler");
        assertThat(m.at("/fuehrende_quelle/0/kanal").asText()).isEqualTo("sunspec.model_203.totwhexp");

        Einzelfall ohne = einzelfall(fall, false);
        abgelehnt(ohne.antwort(), 409, "hauptzaehler_vorhanden", null, null);
        assertThat(ohne.antwort().getBody().get("message").asText())
                .contains("nur erlaubt, wenn beide denselben Zähler lesen");
        assertThat(protokoll(ohne.kandidat())).as("abgelehnt schreibt nichts").hasSize(1);
    }

    /**
     * A11 mit dem Wortlaut aus §5.12, dazu die Regeln über den Tag und über die Unterzähler der
     * geänderten Messstelle am gebauten Referenzunternehmen — jede Ablehnung schreibt nichts.
     */
    @Test
    void a11FremdanlageZyklusUndDieUnterzaehlerDerGeaendertenMessstelle() {
        Ahrenberg ah = ahrenberg();
        Map<String, Long> vorher = protokollstand(ah);

        // A11: MS-03 soll Hauptzähler von AN-1 werden, MS-01 ist es.
        ResponseEntity<JsonNode> r = stellung(ah, "MS-03", "AN-1", "Hauptzähler", null, "2026-10-20", false);
        abgelehnt(r, 409, "hauptzaehler_vorhanden", "tag", "2026-10-20");
        assertThat(r.getBody().get("message").asText()).startsWith("Werk Ahrenberg – Halle 1 hat bereits einen "
                + "Hauptzähler: MS-01 Netzbezug Halle 1. Wählen Sie „Unterzähler von MS-01“ oder ändern Sie MS-01.");
        assertThat(r.getBody().at("/bestehend/anlage").asText()).isEqualTo(ah.anlagen().get("AN-1").toString());

        // MS-08 zieht am 01.03.2027 nach AN-2 — als Unterzähler von MS-01 zeigte es in eine fremde Anlage
        // (die Korrektur ersetzt die eingetragene Stellung ab ihrem Beginn).
        r = stellung(ah, "MS-08", "AN-2", "Unterzähler", "MS-01", "2027-03-01", true);
        abgelehnt(r, 422, "stellung_ungueltig", "grund", "fremde_anlage");
        assertThat(r.getBody().get("message").asText()).isEqualTo("MS-01 gehört zu Werk Ahrenberg – Halle 1. "
                + "Ein Unterzähler kann nur auf eine Messstelle derselben Anlage zeigen.");
        // Ohne Korrektur trifft dasselbe „gültig ab“ auf die eingetragene Stellung: 409, eine zweite gibt es nicht.
        r = stellung(ah, "MS-08", "AN-2", "Unterzähler", "MS-10", "2027-03-01", false);
        abgelehnt(r, 409, "zuordnung_ueberlappt", "grund", "gleicher_tag");
        assertThat(r.getBody().get("message").asText()).isEqualTo("Für den 01.03.2027 gibt es schon eine Stellung "
                + "(Unterzähler von MS-10 in Werk Ahrenberg – Halle 2). Ändern Sie diese, statt eine zweite anzulegen.");

        // Zyklus: MS-01 als Unterzähler von MS-06, das Unterzähler von MS-01 ist.
        r = stellung(ah, "MS-01", "AN-1", "Unterzähler", "MS-06", "2026-11-01", false);
        abgelehnt(r, 422, "stellung_ungueltig", "grund", "zyklus");
        assertThat(texte(r.getBody().get("kette"))).containsExactly("MS-01", "MS-06", "MS-01");

        // Die Unterzähler der geänderten Messstelle: zöge MS-01 nach AN-3, zeigten MS-05 … in eine fremde Anlage.
        r = stellung(ah, "MS-01", "AN-3", "Erzeuger", null, "2026-11-01", false);
        abgelehnt(r, 422, "stellung_ungueltig", "grund", "fremde_anlage");
        assertThat(r.getBody().at("/betroffen/kennzeichen").asText()).isEqualTo("MS-05");
        assertThat(r.getBody().get("message").asText()).startsWith("MS-05 Verwaltung gesamt ist Unterzähler von MS-01 "
                + "in Werk Ahrenberg – Halle 1.");

        // Geprüft wird jeder Tag, nicht nur der erste: MS-13 (AN-2) als Unterzähler von MS-08 ab 01.02.2027 —
        // MS-08 steht bis zum 28.02.2027 in AN-1, also ist schon der erste Tag eine fremde Anlage.
        r = stellung(ah, "MS-13", "AN-2", "Unterzähler", "MS-08", "2027-02-01", false);
        abgelehnt(r, 422, "stellung_ungueltig", "tag", "2027-02-01");
        assertThat(r.getBody().get("grund").asText()).isEqualTo("fremde_anlage");

        // Form und Vokabular: 400 mit dem Feld; unbekannte Bezug-Messstelle: fremde_anlage mit Satz.
        abgelehnt(stellung(ah, "MS-06", "AN-1", "Zwischenzähler", null, "2026-11-01", false),
                400, "anfrage_ungueltig", "feld", "stellung");
        r = stellung(ah, "MS-06", "AN-1", "Unterzähler", "MS-99", "2026-11-01", false);
        abgelehnt(r, 422, "stellung_ungueltig", "grund", "fremde_anlage");
        assertThat(r.getBody().get("message").asText()).startsWith("Eine Messstelle „MS-99“ gibt es in diesem Kundenbereich nicht.");
        Map<String, Object> fremdeAnlage = new LinkedHashMap<>();
        fremdeAnlage.put("anlage", UUID.randomUUID().toString());
        fremdeAnlage.put("stellung", "keine");
        fremdeAnlage.put("gueltig_ab", "2026-11-01");
        abgelehnt(rufe(HttpMethod.PUT, "/messstellen/" + ah.messstelle("MS-06") + "/stellung", ah.wer(), fremdeAnlage),
                400, "anfrage_ungueltig", "feld", "anlage");
        // Berechnet und Gas stehen nur als „keine“ im Baum.
        abgelehnt(stellung(ah, "MS-19", "AN-1", "Hauptzähler", null, "2026-11-01", false),
                422, "stellung_ungueltig", "grund", "nicht_elektrisch");

        assertThat(protokollstand(ah)).as("abgelehnt heißt: nichts geschrieben").isEqualTo(vorher);
    }

    // ---- Die Tages-Mechanik und das Ziel des Orts -------------------------------

    /**
     * Die Gründe des Ortsbaum-Vertrags über {@code PUT …/ort} — mit den Sätzen der Datei: das Ziel
     * gab es an dem Tag noch nicht (Werk Lindach erst ab 15.10.2026), an dem Tag beginnt schon ein
     * Ort (409), schon genau dieser Ort, vor dem ersten Ort; dazu die Regel des Vertrags, dass nur
     * eine berechnete Messstelle am Unternehmen hängt, und ein unbekanntes Kurzzeichen.
     */
    @Test
    void dieOrtRegelnMitDenSaetzenDesVertrags() {
        Ahrenberg ah = ahrenberg();
        Map<String, Long> vorher = protokollstand(ah);

        ResponseEntity<JsonNode> r = ort(ah, "MS-09", "ST-2", "2026-10-02", false);
        abgelehnt(r, 422, "ort_ungueltig", "grund", "ziel_gab_es_noch_nicht");
        assertThat(r.getBody().get("message").asText()).isEqualTo(
                "Werk Lindach gibt es im Portal erst seit 15.10.2026. Wählen Sie ein Datum ab dem 15.10.2026.");
        r = ort(ah, "MS-06", "B-2", "2024-03-12", false);
        abgelehnt(r, 409, "zuordnung_ueberlappt", "grund", "gleicher_tag");
        assertThat(r.getBody().get("message").asText()).isEqualTo("Für den 12.03.2024 gibt es schon eine Zuordnung "
                + "(Halle 1 Nord). Ändern Sie diese, statt eine zweite anzulegen.");
        r = ort(ah, "MS-06", "B-1", "2026-11-01", false);
        abgelehnt(r, 400, "zuordnung_unveraendert", "grund", "ziel_ist_bisheriger_eltern");
        assertThat(r.getBody().get("message").asText()).isEqualTo("MS-06 Spritzguss SG01–SG06 hängt bereits an Halle 1 Nord.");
        r = ort(ah, "MS-09", "G-2", "2025-01-01", false);
        abgelehnt(r, 422, "zuordnung_ungueltig", "grund", "vor_dem_ersten_intervall");
        assertThat(r.getBody().get("message").asText()).startsWith("MS-09 Halle 1 + Verwaltung nicht zugeordnet gibt es "
                + "im Portal erst seit 01.10.2026.");
        abgelehnt(ort(ah, "MS-06", "U", "2026-11-01", false), 422, "ort_ungueltig", "grund", "unternehmen_nur_berechnet");
        abgelehnt(ort(ah, "MS-06", "B-99", "2026-11-01", false), 422, "ort_ungueltig", "grund", "unbekannt");
        abgelehnt(ort(ah, "MS-06", "B-2", "2026-11-15", true), 422, "zuordnung_ungueltig", "grund",
                "kein_beginn_an_dem_tag");

        // Die Anfrage wird streng gelesen: ein Feld, das es hier nicht gibt, ein Tag, der keiner ist.
        Map<String, Object> mitBis = new LinkedHashMap<>();
        mitBis.put("kennzeichen", "B-2");
        mitBis.put("gueltig_ab", "2026-11-01");
        mitBis.put("gueltig_bis", "2026-12-31");
        abgelehnt(rufe(HttpMethod.PUT, "/messstellen/" + ah.messstelle("MS-06") + "/ort", ah.wer(), mitBis),
                400, "anfrage_ungueltig", "feld", "gueltig_bis");
        abgelehnt(rufe(HttpMethod.PUT, "/messstellen/" + ah.messstelle("MS-06") + "/ort", ah.wer(),
                Map.of("kennzeichen", "B-2", "gueltig_ab", "01.11.2026")), 400, "anfrage_ungueltig", "feld", "gueltig_ab");
        abgelehnt(rufe(HttpMethod.PUT, "/messstellen/" + ah.messstelle("MS-06") + "/ort", ah.wer(),
                Map.of("kennzeichen", "B-2")), 400, "anfrage_ungueltig", "feld", "gueltig_ab");

        assertThat(protokollstand(ah)).as("abgelehnt heißt: nichts geschrieben").isEqualTo(vorher);
    }

    /**
     * Verschieben, Korrektur und Rückwirkung an einer eigenen Messstelle: ein neues „gültig ab“
     * beendet das laufende Intervall am Vortag, eine Korrektur hebt das ersetzte auf (lesbar in
     * der Tabelle, nicht mehr in der Antwort), das Protokoll trägt je Schreibvorgang genau einen
     * Eintrag mit „gilt ab“ (Mitternacht), rückwirkend und alt → neu. Dasselbe für die Stellung.
     */
    @Test
    void verschiebenKorrekturUndRueckwirkungMitGenauEinemEintragJeSchreibvorgang() {
        Klein k = klein("Korrektur-Probe");
        zuordnungService.uhrStellen(uhr(EINFUEHRUNG));
        String ms07 = k.ms07();

        ok(ort(k, ms07, "B-2", "2024-03-12", false));
        JsonNode m = ok(rufe(HttpMethod.PUT, "/messstellen/" + ms07 + "/ort", k.wer(),
                Map.of("kennzeichen", "B-1", "gueltig_ab", "2026-12-01", "grund", "Umzug")));
        assertThat(m.get("orte")).isEqualTo(orte(
                ortZ("bereich", "B-2", "2024-03-12", "2026-11-30"), ortZ("bereich", "B-1", "2026-12-01", null)));
        // Ein zweiter Ort am selben Tag: 409 — der Weg ist die Korrektur.
        abgelehnt(ort(k, ms07, "G-1", "2026-12-01", false), 409, "zuordnung_ueberlappt", "gueltig_ab", "2026-12-01");
        m = ok(ort(k, ms07, "G-1", "2026-12-01", true));
        assertThat(m.get("orte")).isEqualTo(orte(
                ortZ("bereich", "B-2", "2024-03-12", "2026-11-30"), ortZ("gebaeude", "G-1", "2026-12-01", null)));
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_ort WHERE messstelle_id = ?::uuid "
                + "AND aufgehoben_am IS NOT NULL", Long.class, ms07)).as("das ersetzte bleibt lesbar").isOne();

        List<Map<String, Object>> e = protokoll(ms07);
        assertThat(e).extracting(x -> x.get("art")).containsExactly("angelegt", "ort_zugeordnet", "ort_zugeordnet",
                "ort_korrigiert");
        assertThat(e).extracting(x -> x.get("rueckwirkend")).containsExactly(false, true, false, false);
        assertThat(e.get(1).get("gilt_ab").toString()).startsWith("2024-03-12 00:00:00");
        assertThat(e.get(2).get("gilt_ab").toString()).startsWith("2026-12-01 00:00:00");
        assertThat(json(e.get(3).get("alt")).get("kennzeichen").asText()).isEqualTo("B-1");
        assertThat(json(e.get(3).get("neu"))).isEqualTo(MAPPER.valueToTree(ortZ("gebaeude", "G-1", "2026-12-01", null)));
        assertThat(e.get(2).get("grund")).isEqualTo("Umzug");

        // Die Stellung: dieselbe Mechanik.
        ok(stellung(k, k.ms01(), "Hauptzähler", null, "2024-03-12", false));
        ok(stellung(k, ms07, "Unterzähler", "MS-01", "2024-03-12", false));
        ResponseEntity<JsonNode> r = stellung(k, ms07, "Unterzähler", "MS-01", "2026-01-01", false);
        abgelehnt(r, 400, "zuordnung_unveraendert", "grund", "ziel_ist_bisheriger_eltern");
        assertThat(r.getBody().get("message").asText()).isEqualTo(
                "MS-07 Druckluft Kompressoren K1+K2 ist bereits Unterzähler von MS-01 in Werk Ahrenberg – Halle 1.");
        abgelehnt(stellung(k, ms07, "keine", null, "2024-03-12", false), 409, "zuordnung_ueberlappt", "grund",
                "gleicher_tag");
        abgelehnt(stellung(k, ms07, "keine", null, "2020-01-01", false), 422, "zuordnung_ungueltig", "grund",
                "vor_dem_ersten_intervall");
        m = ok(stellung(k, ms07, "Abzweig", null, "2024-03-12", true));
        assertThat(m.get("elektrische_stellung")).hasSize(1);
        assertThat(m.at("/elektrische_stellung/0/stellung").asText()).isEqualTo("Abzweig");
        assertThat(m.at("/elektrische_stellung/0/unterzaehler_von").isNull()).isTrue();
        assertThat(protokoll(ms07)).extracting(x -> x.get("art")).endsWith("stellung_zugeordnet", "stellung_korrigiert");
    }

    /**
     * A13-Muster: Archivieren beendet die Zuordnungen am Vortag des Archivtags (rückwirkend am
     * 30.06.2026 16:30 archiviert → Ort und Stellung enden am 29.06.2026), eine geplante wird
     * aufgehoben; danach bleibt die Messstelle, wie sie ist. Und kein Übergang liegt vor ihrem
     * Beginn (Mitternacht des ersten Tages ihres ersten Orts).
     */
    @Test
    void archivierenBeendetDieZuordnungenAmVortagUndNichtsLiegtVorDemBeginn() {
        Klein k = klein("Archiv-Probe");
        String ms07 = k.ms07();
        ok(ort(k, ms07, "B-2", "2024-03-12", false));
        ok(ort(k, ms07, "B-1", "2026-12-01", false));
        ok(stellung(k, k.ms01(), "Hauptzähler", null, "2024-03-12", false));
        ok(stellung(k, ms07, "Unterzähler", "MS-01", "2024-03-12", false));

        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/messstellen/" + ms07 + "/anhalten", k.wer(),
                Map.of("zeitpunkt", "2024-03-11T12:00:00+01:00"));
        abgelehnt(r, 422, "zeitpunkt_vor_vorgaenger", null, null);
        assertThat(OffsetDateTime.parse(r.getBody().get("beginn").asText()).toInstant())
                .isEqualTo(OffsetDateTime.parse("2024-03-12T00:00:00+01:00").toInstant());

        JsonNode m = ok(rufe(HttpMethod.POST, "/messstellen/" + ms07 + "/archivieren", k.wer(),
                Map.of("zeitpunkt", "2026-06-30T16:30:00+02:00")));
        assertThat(m.get("lebenszyklus").asText()).isEqualTo("archiviert");
        assertThat(m.get("orte")).isEqualTo(orte(ortZ("bereich", "B-2", "2024-03-12", "2026-06-29")));
        assertThat(m.get("elektrische_stellung")).hasSize(1);
        assertThat(m.at("/elektrische_stellung/0/gueltig_bis").asText()).isEqualTo("2026-06-29");
        Map<String, Object> archiv = protokoll(ms07).get(protokoll(ms07).size() - 1);
        assertThat(archiv.get("art")).isEqualTo("archiviert");
        assertThat(json(archiv.get("neu")).get("zuordnungen_bis").asText()).isEqualTo("2026-06-29");

        assertThat(standAmId(k.wer(), ms07, "2026-06-29").get("ort").asText()).isEqualTo("B-2");
        JsonNode danach = standAmId(k.wer(), ms07, "2026-06-30");
        assertThat(danach.get("grund").asText()).isEqualTo("nicht_verortet");
        assertThat(danach.get("elektrische_stellung").isNull()).isTrue();
        abgelehnt(ort(k, ms07, "G-1", "2026-12-01", false), 409, "zustand_passt_nicht", null, null);
        abgelehnt(stellung(k, ms07, "keine", null, "2026-12-01", false), 409, "zustand_passt_nicht", null, null);
    }

    // ---- Der Haken OrtsbaumMessstellen: die Archiv-Sperre kennt Messstellen ------

    /**
     * Werk Lindach mit MS-16 (am Standort) und MS-17 (an der Lagerhalle G-4) — beide aktiv, über
     * {@code PUT …/ort} verortet. Archivieren am 20.10.2026: 409 mit BEIDEN Messstellen im
     * Sperrgrund (der Teilbaum zählt). Hält MS-17 an, sperrt nur noch MS-16; zieht MS-16 ab dem
     * Tag nach Werk Ahrenberg, geht es — die Lagerhalle wird mitarchiviert, MS-17 bleibt, wie sie ist.
     */
    @Test
    void dieArchivSperreEinesStandortsNenntSeineAktivenMessstellen() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        standortService.uhrStellen(uhr("2024-03-12T09:00:00+01:00"));
        UUID werk = UUID.fromString(ok201(rufe(HttpMethod.POST, "/standorte", wer, ausReferenz("ST-1"))).get("id").asText());
        standortService.uhrStellen(uhr("2026-10-15T08:00:00+02:00"));
        UUID lindach = UUID.fromString(ok201(rufe(HttpMethod.POST, "/standorte", wer, ausReferenz("ST-2"))).get("id").asText());
        neuerOrt(t, "G-4", lindach, null, "2026-10-15");
        String ms16 = anlegen(wer, "MS-16");
        String ms17 = anlegen(wer, "MS-17");
        ok(ortId(wer, ms16, "ST-2", "2026-10-15", false));
        ok(ortId(wer, ms17, "G-4", "2026-10-15", false));

        standortService.uhrStellen(uhr("2026-10-20T10:00:00+02:00"));
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/standorte/" + lindach + "/archivieren", wer, null);
        abgelehnt(r, 409, "archivieren_gesperrt", null, null);
        JsonNode gruende = r.getBody().get("gruende");
        assertThat(gruende).extracting(g -> g.get("kennzeichen").asText()).containsExactly("MS-16", "MS-17");
        for (JsonNode g : gruende) {
            assertThat(g.get("art").asText()).isEqualTo("messstelle_aktiv");
            assertThat(g.get("objekt").asText()).isEqualTo("messstelle");
            assertThat(g.get("weg").asText()).isEqualTo("messstelle_umziehen");
        }
        assertThat(r.getBody().get("message").asText()).contains("2 Messstellen sind hier aktiv (MS-16 "
                + referenzMessstelle("MS-16").get("name").asText() + " und MS-17 "
                + referenzMessstelle("MS-17").get("name").asText() + ")");

        // Eine angehaltene Messstelle sperrt nicht (E12: nur aktive).
        messstelleService.uhrStellen(uhr("2026-10-16T10:00:00+02:00"));
        ok(rufe(HttpMethod.POST, "/messstellen/" + ms17 + "/anhalten", wer, null));
        r = rufe(HttpMethod.POST, "/standorte/" + lindach + "/archivieren", wer, null);
        abgelehnt(r, 409, "archivieren_gesperrt", null, null);
        assertThat(r.getBody().get("gruende")).extracting(g -> g.get("kennzeichen").asText()).containsExactly("MS-16");

        // MS-16 zieht ab dem Archivtag nach Werk Ahrenberg: jetzt geht es.
        ok(ortId(wer, ms16, "ST-1", "2026-10-20", false));
        JsonNode archiviert = ok(rufe(HttpMethod.POST, "/standorte/" + lindach + "/archivieren", wer, null));
        assertThat(archiviert.get("zustand").asText()).isEqualTo("archiviert");
        assertThat(root.queryForObject("SELECT zustand FROM ort WHERE tenant_id = ? AND kurzzeichen = 'G-4'",
                String.class, t)).isEqualTo("archiviert");
        assertThat(standAmId(wer, ms17, "2026-10-20").get("ort").asText()).as("keine Kaskade auf Messstellen")
                .isEqualTo("G-4");
        assertThat(standAmId(wer, ms16, "2026-10-20").get("standort_id").asText()).isEqualTo(werk.toString());
    }

    // ---- Der Zaun ----------------------------------------------------------------

    /** Eine fremde Messstelle ist 404, nie 403; ein fremder Ort, eine fremde Anlage gibt es nicht. */
    @Test
    void eineFremdeMessstelleIst404UndFremdeZieleGibtEsNicht() {
        Ahrenberg ah = ahrenberg();
        Klein k = klein("Zaun-Probe");
        String ms06 = ah.messstelle("MS-06");
        Map<String, Long> vorher = protokollstand(ah);
        for (Anrufer fremd : List.of(DEMO2, admin(k.tenant()))) {
            assertThat(rufe(HttpMethod.GET, "/messstellen/" + ms06 + "/standort", fremd, null).getStatusCode().value())
                    .isEqualTo(404);
            assertThat(rufe(HttpMethod.PUT, "/messstellen/" + ms06 + "/ort", fremd,
                    Map.of("kennzeichen", "B-2", "gueltig_ab", "2026-11-01")).getStatusCode().value()).isEqualTo(404);
            Map<String, Object> st = new LinkedHashMap<>();
            st.put("anlage", ah.anlagen().get("AN-1").toString());
            st.put("stellung", "keine");
            st.put("gueltig_ab", "2026-11-01");
            assertThat(rufe(HttpMethod.PUT, "/messstellen/" + ms06 + "/stellung", fremd, st).getStatusCode().value())
                    .isEqualTo(404);
        }
        // Die eigene Messstelle mit dem Kurzzeichen (B-3) oder der Anlage eines anderen Kundenbereichs: gibt es nicht.
        abgelehnt(ort(k, k.ms07(), "B-3", "2026-11-01", false), 422, "ort_ungueltig", "grund", "unbekannt");
        Map<String, Object> st = new LinkedHashMap<>();
        st.put("anlage", ah.anlagen().get("AN-1").toString());
        st.put("stellung", "keine");
        st.put("gueltig_ab", "2026-11-01");
        abgelehnt(rufe(HttpMethod.PUT, "/messstellen/" + k.ms07() + "/stellung", k.wer(), st),
                400, "anfrage_ungueltig", "feld", "anlage");
        assertThat(protokollstand(ah)).isEqualTo(vorher);
    }

    // ---- Gerüst: das Referenzunternehmen ----------------------------------------

    /** Die Hauptzähler von AN-1 an EINEM Zähler (K-3): Bezug und Abgabe. */
    private static final List<String> HAUPTZAEHLER_AN1 = List.of("MS-01", "MS-02");

    /** Das gebaute Referenzunternehmen: Kundenbereich, IDs je Kennzeichen, der Netzzähler K-3. */
    private record Ahrenberg(UUID tenant, Map<String, UUID> standorte, Map<String, UUID> anlagen,
            Map<String, String> messstellen, UUID k3) {

        Anrufer wer() {
            return new Anrufer("admin", tenant);
        }

        String messstelle(String kennzeichen) {
            return Objects.requireNonNull(messstellen.get(kennzeichen), kennzeichen);
        }
    }

    private synchronized Ahrenberg ahrenberg() {
        if (ahrenberg != null) {
            return ahrenberg;
        }
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        Map<String, UUID> standorte = new LinkedHashMap<>();
        standortService.uhrStellen(uhr("2024-03-12T09:00:00+01:00"));
        standorte.put("ST-1", UUID.fromString(ok201(rufe(HttpMethod.POST, "/standorte", wer, ausReferenz("ST-1")))
                .get("id").asText()));
        standortService.uhrStellen(uhr("2026-10-15T08:00:00+02:00"));
        standorte.put("ST-2", UUID.fromString(ok201(rufe(HttpMethod.POST, "/standorte", wer, ausReferenz("ST-2")))
                .get("id").asText()));
        standortService.uhrStellen(Clock.systemUTC());
        // Gebäude und Bereiche mit ihren Eltern-Intervallen aus der Referenz (die Ort-Routen prüft OrtApiTest).
        Map<String, UUID> orte = new LinkedHashMap<>();
        for (JsonNode z : referenz.get("zuordnungen")) {
            if (!"ort_eltern".equals(z.get("art").asText()) || z.get("nach").isNull()) {
                continue;
            }
            String kz = z.get("von").asText();
            String nach = z.get("nach").asText();
            orte.put(kz, neuerOrt(t, kz, standorte.get(nach), orte.get(nach), z.get("gueltig_ab").asText()));
        }
        Map<String, UUID> anlagen = new LinkedHashMap<>();
        for (JsonNode an : referenz.get("anlagen")) {
            anlagen.put(an.get("kennzeichen").asText(), UUID.fromString(ok201(rufeApi(HttpMethod.POST, "/api/v1/sites",
                    wer, Map.of("name", an.get("name").asText()))).get("id").asText()));
        }
        Map<String, String> ms = new LinkedHashMap<>();
        for (JsonNode m : referenz.get("messstellen")) {
            ms.put(m.get("kennzeichen").asText(), anlegen(wer, m.get("kennzeichen").asText()));
        }
        // Die führenden Quellen der beiden Hauptzähler von AN-1 (IP-13): Bezug und Abgabe des
        // Netzzählers K-3, ab Beginn seines Verlaufs — erst sie belegen „derselbe Zähler“.
        UUID k3 = komponente(t, anlagen.get("AN-1"), "K-3");
        for (String kz : HAUPTZAEHLER_AN1) {
            JsonNode q = referenzMessstelle(kz).at("/fuehrende_quelle/0");
            quelleBinden(wer, anlagen.get("AN-1"), ms.get(kz), k3, kanalFuer(referenzMessstelle(kz)),
                    q.get("gueltig_ab").asText());
        }
        zuordnungService.uhrStellen(uhr(EINFUEHRUNG));
        Ahrenberg ah = new Ahrenberg(t, standorte, anlagen, ms, k3);
        for (JsonNode z : referenz.get("zuordnungen")) {
            if ("messstelle_ort".equals(z.get("art").asText())) {
                ok(ort(ah, z.get("von").asText(), z.get("nach").asText(), z.get("gueltig_ab").asText(), false));
            }
        }
        // Erst die Hauptzähler, dann die, die auf sie zeigen — in der Reihenfolge der Referenz.
        List<JsonNode> reihenfolge = new ArrayList<>();
        referenz.get("messstellen").forEach(m -> {
            if (hauptzaehler(m)) {
                reihenfolge.add(m);
            }
        });
        referenz.get("messstellen").forEach(m -> {
            if (!hauptzaehler(m)) {
                reihenfolge.add(m);
            }
        });
        for (JsonNode m : reihenfolge) {
            String kz = m.get("kennzeichen").asText();
            for (JsonNode s : m.get("elektrische_stellung")) {
                ok(stellung(ah, kz, s.get("anlage").asText(), s.get("stellung").asText(),
                        text(s.get("unterzaehler_von")), s.get("gueltig_ab").asText(), false));
            }
        }
        zuordnungService.uhrStellen(Clock.systemUTC());
        ahrenberg = ah;
        return ahrenberg;
    }

    private static boolean hauptzaehler(JsonNode m) {
        return m.get("elektrische_stellung").size() > 0
                && "Hauptzähler".equals(m.at("/elektrische_stellung/0/stellung").asText());
    }

    /** Die Orte einer Messstelle in der Form des Vertrags — aus den Zuordnungen der Referenz. */
    private static JsonNode orteDerReferenz(String kennzeichen) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (JsonNode z : zuordnungenDerReferenz("messstelle_ort", kennzeichen)) {
            out.add(ortZ(ortArt(z.get("nach").asText()), z.get("nach").asText(), z.get("gueltig_ab").asText(),
                    text(z.get("gueltig_bis"))));
        }
        return MAPPER.valueToTree(out);
    }

    private static JsonNode stellungenDerReferenz(JsonNode ms, Ahrenberg ah) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (JsonNode s : ms.get("elektrische_stellung")) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("anlage", ah.anlagen().get(s.get("anlage").asText()).toString());
            m.put("stellung", s.get("stellung").asText());
            m.put("unterzaehler_von", text(s.get("unterzaehler_von")));
            m.put("gueltig_ab", s.get("gueltig_ab").asText());
            m.put("gueltig_bis", text(s.get("gueltig_bis")));
            out.add(m);
        }
        return MAPPER.valueToTree(out);
    }

    private static List<JsonNode> zuordnungenDerReferenz(String art, String von) {
        List<JsonNode> out = new ArrayList<>();
        referenz.get("zuordnungen").forEach(z -> {
            if (art.equals(z.get("art").asText()) && von.equals(z.get("von").asText())) {
                out.add(z);
            }
        });
        return out;
    }

    /** Je Kurzzeichen die Messstellen, deren Ort am Tag dieser Knoten ist — aus der Referenz gerechnet. */
    private static Map<String, Integer> zahlJeOrt(LocalDate tag) {
        Map<String, Integer> out = new LinkedHashMap<>();
        referenz.get("zuordnungen").forEach(z -> {
            if (!"messstelle_ort".equals(z.get("art").asText())) {
                return;
            }
            LocalDate ab = LocalDate.parse(z.get("gueltig_ab").asText());
            LocalDate bis = z.get("gueltig_bis").isNull() ? null : LocalDate.parse(z.get("gueltig_bis").asText());
            if (!ab.isAfter(tag) && (bis == null || !tag.isAfter(bis))) {
                out.merge(z.get("nach").asText(), 1, Integer::sum);
            }
        });
        return out;
    }

    private static String ortArt(String kennzeichen) {
        if (OrtsbaumAbleitung.UNTERNEHMEN.equals(kennzeichen)) {
            return "unternehmen";
        }
        return kennzeichen.startsWith("ST-") ? "standort" : kennzeichen.startsWith("G-") ? "gebaeude" : "bereich";
    }

    // ---- Gerüst: ein Fall der Familie stellung als Bestand -----------------------

    /**
     * Ein Fall als Kundenbereich: seine Anlagen, der Kandidat, die Antwort auf seine Stellung und
     * je Messstelle, wie viele Quellen der Bestand ihr gebunden hat.
     */
    private record Einzelfall(Map<String, UUID> anlagen, String kandidat, ResponseEntity<JsonNode> antwort,
            Map<String, Integer> quellenJe) {
        int quellen(String messstelle) {
            return quellenJe.getOrDefault(messstelle, 0);
        }
    }

    /**
     * Der Stand des Falls am Stichtag als Bestand (die Liste in {@code messstelle_stellung}, ohne den
     * Kandidaten — die Regel sieht von ihm nur die neue Stellung; mit {@code mitQuellen} dazu je
     * Messstelle mit Komponente die führende Quelle ihrer Hauptgröße ab dem Stichtag, IP-13 — je
     * Komponente EIN Zähler), dann {@code PUT …/stellung}.
     */
    private Einzelfall einzelfall(JsonNode fall, boolean mitQuellen) {
        JsonNode in = fall.get("input");
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        String stichtag = fall.get("stichtag").asText();
        Set<String> kennzeichen = new LinkedHashSet<>();
        Set<String> anlagenKz = new LinkedHashSet<>();
        in.get("messstellen").forEach(e -> {
            kennzeichen.add(e.get("kennzeichen").asText());
            anlagenKz.add(e.get("anlage").asText());
        });
        kennzeichen.add(in.at("/messstelle/kennzeichen").asText());
        anlagenKz.add(in.at("/stellung/anlage").asText());
        Map<String, UUID> anlagen = new LinkedHashMap<>();
        for (String an : anlagenKz) {
            anlagen.put(an, UUID.fromString(ok201(rufeApi(HttpMethod.POST, "/api/v1/sites", wer,
                    Map.of("name", element(referenz.get("anlagen"), an).get("name").asText()))).get("id").asText()));
        }
        Map<String, String> ids = new LinkedHashMap<>();
        for (String kz : kennzeichen) {
            ids.put(kz, anlegen(wer, kz));
        }
        String kandidat = in.at("/messstelle/kennzeichen").asText();
        Map<String, Integer> quellenJe = new LinkedHashMap<>();
        if (mitQuellen) {
            Map<String, UUID> komponenten = new LinkedHashMap<>();
            Map<String, String> anlageJe = new LinkedHashMap<>();
            in.get("messstellen").forEach(e -> anlageJe.put(e.get("kennzeichen").asText(), e.get("anlage").asText()));
            anlageJe.putIfAbsent(kandidat, in.at("/stellung/anlage").asText());
            Map<String, String> komponenteJe = new LinkedHashMap<>();
            in.get("messstellen").forEach(e -> komponenteJe.put(e.get("kennzeichen").asText(), text(e.get("komponente"))));
            komponenteJe.put(kandidat, text(in.at("/messstelle/komponente")));
            String ab = LocalDate.parse(stichtag).atStartOfDay(BERLIN).toOffsetDateTime().toString();
            komponenteJe.forEach((kz, k) -> {
                if (k == null) {
                    return;
                }
                UUID anlage = anlagen.get(anlageJe.get(kz));
                UUID id = komponenten.computeIfAbsent(k, x -> komponente(t, anlage, x, ab));
                quelleBinden(wer, anlage, ids.get(kz), id, kanalFuer(referenzMessstelle(kz)), ab);
                quellenJe.put(ids.get(kz), 1);
            });
        }
        for (JsonNode e : in.get("messstellen")) {
            if (e.get("kennzeichen").asText().equals(kandidat)) {
                continue;
            }
            root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, "
                    + "unterzaehler_von, gueltig_ab) VALUES (?, ?::uuid, ?, ?, ?::uuid, ?)", t,
                    ids.get(e.get("kennzeichen").asText()), anlagen.get(e.get("anlage").asText()),
                    e.get("stellung").asText(), e.get("unterzaehler_von").isNull() ? null
                            : ids.get(e.get("unterzaehler_von").asText()), LocalDate.parse(stichtag));
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("anlage", anlagen.get(in.at("/stellung/anlage").asText()).toString());
        body.put("stellung", in.at("/stellung/stellung").asText());
        body.put("unterzaehler_von", text(in.at("/stellung/unterzaehler_von")));
        body.put("gueltig_ab", stichtag);
        return new Einzelfall(anlagen, ids.get(kandidat),
                rufe(HttpMethod.PUT, "/messstellen/" + ids.get(kandidat) + "/stellung", wer, body), quellenJe);
    }

    // ---- Gerüst: Komponenten und Quellen (IP-13) --------------------------------

    /** Eine Komponente der Referenz ab Beginn ihres Verlaufs; ihr Gerät legt der Anlege-Weg an. */
    private static UUID komponente(UUID tenant, UUID anlage, String kennzeichen) {
        return komponente(tenant, anlage, kennzeichen,
                element(referenz.get("komponenten"), kennzeichen).get("in_betrieb_ab").asText());
    }

    private static UUID komponente(UUID tenant, UUID anlage, String kennzeichen, String ab) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "connection_json, created_at) VALUES (?, ?, 'modbus-generic', ?, 'modbus-generic', ?::jsonb, ?) "
                + "RETURNING id", UUID.class, tenant, anlage,
                element(referenz.get("komponenten"), kennzeichen).get("name").asText(),
                "{\"unit_id\":" + Math.abs(kennzeichen.hashCode() % 240) + "}",
                java.sql.Timestamp.from(OffsetDateTime.parse(ab).toInstant()));
    }

    /** Der Messwert, aus dem die Hauptgröße der Messstelle gelesen wird (Katalog-Punkt, Regel 7). */
    private static String kanalFuer(JsonNode messstelle) {
        return switch (messstelle.at("/hauptgroesse/richtung").asText()) {
            case "Abgabe" -> "sunspec.model_203.totwhexp";
            case "Erzeugung" -> "sunspec.model_103.wh";
            default -> "sunspec.model_203.totwhimp";
        };
    }

    /** Die Box der Anlage, die die Kanäle liest — eine je Anlage. */
    private static final Map<UUID, UUID> BOXEN = new ConcurrentHashMap<>();

    private static UUID box(UUID tenant, UUID anlage) {
        return BOXEN.computeIfAbsent(anlage, a -> root.queryForObject("INSERT INTO device (tenant_id, site_id, "
                + "external_ref) VALUES (?, ?, ?) RETURNING id", UUID.class, tenant, a, "VP-BOX-" + a));
    }

    /** Die Mess-Selektion des Kanals und die führende Quelle der Hauptgröße über {@code POST …/quellen}. */
    private void quelleBinden(Anrufer wer, UUID anlage, String messstelle, UUID komponente, String kanal, String ab) {
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
        ok201(rufe(HttpMethod.POST, "/messstellen/" + messstelle + "/quellen", wer, body));
    }

    /**
     * Hängt das Urteil des Falls an der Komponente der Quelle? Dann urteilt der Zwilling ohne sie
     * (bis IP-13 kennt die Schnittstelle keine) anders als die Datei.
     */
    private static boolean brauchtDieQuelle(JsonNode fall) {
        JsonNode in = fall.get("input");
        JsonNode m = in.get("messstelle");
        List<StellungEintrag> liste = new ArrayList<>();
        in.get("messstellen").forEach(e -> liste.add(new StellungEintrag(e.get("kennzeichen").asText(),
                e.get("name").asText(), e.get("anlage").asText(), e.get("stellung").asText(),
                text(e.get("unterzaehler_von")), e.get("richtung").asText(), null)));
        JsonNode s = in.get("stellung");
        StellungUrteil ohne = MessstelleRegeln.stellungPruefen(new StellungKandidat(m.get("kennzeichen").asText(),
                m.get("art").asText(), m.get("medium").asText(), m.get("richtung").asText(), null),
                new Stellung(s.get("anlage").asText(), s.get("stellung").asText(), text(s.get("unterzaehler_von"))),
                liste);
        String soll = text(fall.at("/expected/fehler"));
        return !Objects.equals(ohne.fehler() == null ? null : ohne.fehler().code(), soll);
    }

    // ---- Gerüst: ein kleiner eigener Kundenbereich ---------------------------------

    /** ST-1 seit 12.03.2024 mit G-1, B-1, B-2; Anlage AN-1; MS-01 und MS-07 der Referenz. */
    private record Klein(UUID tenant, String ms01, String ms07, UUID anlage) {

        Anrufer wer() {
            return new Anrufer("admin", tenant);
        }
    }

    private Klein klein(String name) {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        standortService.uhrStellen(uhr("2024-03-12T09:00:00+01:00"));
        UUID st = UUID.fromString(ok201(rufe(HttpMethod.POST, "/standorte", wer, ausReferenz("ST-1"))).get("id").asText());
        standortService.uhrStellen(Clock.systemUTC());
        UUID g1 = neuerOrt(t, "G-1", st, null, "2024-03-12");
        neuerOrt(t, "B-1", null, g1, "2024-03-12");
        neuerOrt(t, "B-2", null, g1, "2024-03-12");
        UUID an1 = UUID.fromString(ok201(rufeApi(HttpMethod.POST, "/api/v1/sites", wer,
                Map.of("name", element(referenz.get("anlagen"), "AN-1").get("name").asText()))).get("id").asText());
        return new Klein(t, anlegen(wer, "MS-01"), anlegen(wer, "MS-07"), an1);
    }

    /** Ein Gebäude oder Bereich der Referenz an einem Standort ODER Gebäude ab {@code ab} — über die Datenbank. */
    private static UUID neuerOrt(UUID tenant, String kurzzeichen, UUID standort, UUID gebaeude, String ab) {
        boolean istGebaeude = kurzzeichen.startsWith("G-");
        JsonNode o = element(referenz.get(istGebaeude ? "gebaeude" : "bereiche"), kurzzeichen);
        UUID id = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, ?, ?, ?, 'aktiv') RETURNING id", UUID.class, tenant, istGebaeude ? "gebaeude" : "bereich",
                o.get("name").asText(), kurzzeichen);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, eltern_ort_id, gueltig_ab) "
                + "VALUES (?,?,?,?,?)", tenant, id, standort, gebaeude, LocalDate.parse(ab));
        return id;
    }

    // ---- Gerüst: Anfragen ----------------------------------------------------------

    private ResponseEntity<JsonNode> ort(Ahrenberg ah, String kennzeichen, String ziel, String ab, boolean korrektur) {
        return ortId(ah.wer(), ah.messstelle(kennzeichen), ziel, ab, korrektur);
    }

    private ResponseEntity<JsonNode> ort(Klein k, String id, String ziel, String ab, boolean korrektur) {
        return ortId(k.wer(), id, ziel, ab, korrektur);
    }

    private ResponseEntity<JsonNode> ortId(Anrufer wer, String id, String ziel, String ab, boolean korrektur) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", ziel);
        body.put("gueltig_ab", ab);
        if (korrektur) {
            body.put("korrektur", true);
        }
        return rufe(HttpMethod.PUT, "/messstellen/" + id + "/ort", wer, body);
    }

    private ResponseEntity<JsonNode> stellung(Ahrenberg ah, String kennzeichen, String anlage, String stellung,
            String bezug, String ab, boolean korrektur) {
        return stellungId(ah.wer(), ah.messstelle(kennzeichen), ah.anlagen().get(anlage), stellung, bezug, ab,
                korrektur);
    }

    private ResponseEntity<JsonNode> stellung(Klein k, String id, String stellung, String bezug, String ab,
            boolean korrektur) {
        return stellungId(k.wer(), id, k.anlage(), stellung, bezug, ab, korrektur);
    }

    private ResponseEntity<JsonNode> stellungId(Anrufer wer, String id, UUID anlage, String stellung, String bezug,
            String ab, boolean korrektur) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("anlage", anlage.toString());
        body.put("stellung", stellung);
        body.put("unterzaehler_von", bezug);
        body.put("gueltig_ab", ab);
        if (korrektur) {
            body.put("korrektur", true);
        }
        return rufe(HttpMethod.PUT, "/messstellen/" + id + "/stellung", wer, body);
    }

    private JsonNode standAm(Ahrenberg ah, String kennzeichen, String am) {
        return standAmId(ah.wer(), ah.messstelle(kennzeichen), am);
    }

    private JsonNode standAmId(Anrufer wer, String id, String am) {
        return ok(rufe(HttpMethod.GET, "/messstellen/" + id + "/standort?am=" + am, wer, null));
    }

    /** Legt die Messstelle der Referenz unter ihrem Kennzeichen an; liefert die ID. */
    private String anlegen(Anrufer wer, String kennzeichen) {
        JsonNode ms = referenzMessstelle(kennzeichen);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("kennzeichen", kennzeichen);
        body.put("name", ms.get("name").asText());
        body.put("art", ms.get("art").asText());
        body.put("medium", ms.get("medium").asText());
        body.put("hauptgroesse", groesseAus(ms.get("hauptgroesse")));
        List<JsonNode> neben = new ArrayList<>();
        ms.get("nebengroessen").forEach(n -> neben.add(groesseAus(n)));
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

    /** Die Anfrage eines Standorts mit den Werten des Referenzunternehmens (wie StandortApiTest). */
    private static Map<String, Object> ausReferenz(String kurzzeichen) {
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

    private UUID neuerKundenbereich() {
        ResponseEntity<JsonNode> r = rufeApi(HttpMethod.POST, "/api/v1/admin/tenants", ADMIN_OHNE_KUNDENBEREICH,
                Map.of("name", referenz.at("/unternehmen/name").asText()));
        assertThat(r.getStatusCode().value()).isEqualTo(201);
        return UUID.fromString(r.getBody().get("id").asText());
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

    /** Die Ablehnung mit Status, Code und (wenn genannt) einem Fakt; der Code steht in der Tabelle der Schnittstelle. */
    private static void abgelehnt(ResponseEntity<JsonNode> r, int status, String code, String fakt, String wert) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(status);
        assertThat(r.getBody().get("code").asText()).as(String.valueOf(r.getBody())).isEqualTo(code);
        assertThat(r.getBody().get("message").asText()).isNotBlank();
        if (fakt != null) {
            assertThat(r.getBody().get(fakt).asText()).as(String.valueOf(r.getBody())).isEqualTo(wert);
        }
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

    private JsonNode anspruch(String benutzer) {
        String nutzlast = token(benutzer).split("\\.")[1];
        try {
            return MAPPER.readTree(new String(Base64.getUrlDecoder().decode(nutzlast), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- Gerüst: Datenbank und Vertrag ----------------------------------------------

    private static Clock uhr(String zeitpunkt) {
        return Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), ZoneOffset.UTC);
    }

    /** Das Protokoll der Messstelle in der Reihenfolge des Schreibens; {@code gilt_ab} in UTC. */
    private static List<Map<String, Object>> protokoll(String messstelle) {
        return root.queryForList("SELECT art, alt::text AS alt, neu::text AS neu, "
                + "to_char(gilt_ab AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') AS gilt_ab, "
                + "rueckwirkend, grund, actor_sub, actor_name, actor_rolle, actor_art FROM messstelle_aenderung "
                + "WHERE messstelle_id = ?::uuid ORDER BY id", messstelle);
    }

    private static Map<String, Long> protokollstand(Ahrenberg ah) {
        Map<String, Long> out = new LinkedHashMap<>();
        ah.messstellen().forEach((kz, id) -> out.put(kz, root.queryForObject(
                "SELECT count(*) FROM messstelle_aenderung WHERE messstelle_id = ?::uuid", Long.class, id)));
        out.put("ort", root.queryForObject("SELECT count(*) FROM messstelle_ort WHERE tenant_id = ?", Long.class,
                ah.tenant()));
        out.put("stellung", root.queryForObject("SELECT count(*) FROM messstelle_stellung WHERE tenant_id = ?",
                Long.class, ah.tenant()));
        return out;
    }

    private static Map<String, Object> ortZ(String art, String kennzeichen, String ab, String bis) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ort_art", art);
        m.put("kennzeichen", kennzeichen);
        m.put("gueltig_ab", ab);
        m.put("gueltig_bis", bis);
        return m;
    }

    @SafeVarargs
    private static JsonNode orte(Map<String, Object>... orte) {
        return MAPPER.valueToTree(List.of(orte));
    }

    private static JsonNode referenzMessstelle(String kennzeichen) {
        return element(referenz.get("messstellen"), kennzeichen);
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (e.get("kennzeichen").asText().equals(kennzeichen)) {
                return e;
            }
        }
        throw new AssertionError("kein " + kennzeichen);
    }

    private static JsonNode ortsbaumFall(String name) {
        for (JsonNode c : ortsbaum.get("cases")) {
            if (c.get("name").asText().equals(name)) {
                return c;
            }
        }
        throw new AssertionError("kein Ortsbaum-Fall " + name);
    }

    private static Stream<JsonNode> faelle(String familie) {
        List<JsonNode> out = new ArrayList<>();
        vektoren.path("cases").path(familie).forEach(out::add);
        assertThat(out).as("Fälle der Familie " + familie).isNotEmpty();
        return out.stream();
    }

    private static JsonNode fall(String familie, String name) {
        return faelle(familie).filter(f -> f.get("name").asText().equals(name)).findFirst().orElseThrow();
    }

    private static MessstelleRegeln.Fehler fehler(String code) {
        for (MessstelleRegeln.Fehler f : MessstelleRegeln.Fehler.values()) {
            if (f.code().equals(code)) {
                return f;
            }
        }
        throw new AssertionError("kein Fehler " + code);
    }

    private static JsonNode json(Object text) {
        try {
            return text == null ? MAPPER.nullNode() : MAPPER.readTree((String) text);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static List<String> texte(JsonNode liste) {
        return StreamSupport.stream(liste.spliterator(), false).map(JsonNode::asText).toList();
    }

}
