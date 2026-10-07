package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ObjektZustand;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
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
 * Die Schreibrouten von Standort und Unternehmen (UEMS AP-02 IP-4) Ende zu Ende gegen echtes
 * Keycloak + TimescaleDB. Namen, Adressen, Kennzeichen und Tage kommen aus dem
 * Referenzunternehmen ({@code uems-referenzunternehmen.json}) und aus den Fällen des
 * Ortsbaum-Vertrags ({@code ortsbaum-vectors.json}); die Sätze der Sperren vergleicht der
 * Test zeichengleich mit der Vektor-Datei — der Beweis, dass die Route keine zweite
 * Prüflogik neben {@link OrtsbaumAbleitung} hat.
 *
 * <p>Bewiesen wird:
 * <ul>
 *   <li>Kurzzeichen (E8): automatisch ST-1 …, eigenes, belegt auch archiviert, früher getragen
 *       und über Standorte UND Gebäude hinweg (V20260911210000) — 409 mit Verweis; der
 *       Vorschlag bewegt den Zähler nicht, eine übersprungene Nummer kommt nie wieder;</li>
 *   <li>A10: der Name leer/zu lang (400) oder unter den heutigen Standorten vergeben (409 mit
 *       Verweis und dem Satz aus §5.10) — beim Anlegen, Umbenennen und Wiederherstellen;</li>
 *   <li>A7-Muster: Archivieren mit aktiver Anlage (und, über den Haken
 *       {@link OrtsbaumMessstellen}, aktiven Messstellen) ist 409 mit der ganzen Liste in
 *       fester Reihenfolge, dem Satz und dem Weg; leere Gebäude werden mitarchiviert;</li>
 *   <li>A8: Archivieren und Wiederherstellen — ein neues Bestehen, die Lücke im Lesemodell
 *       sichtbar und nie aufgefüllt, die Kinder bleiben archiviert;</li>
 *   <li>A14: ein fremder Standort ist 404, nie 403;</li>
 *   <li>jede Schreiboperation GENAU EIN Protokolleintrag mit Urheber, eine abgelehnte keinen,
 *       eine ohne Änderung keinen.</li>
 * </ul>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class StandortApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
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

    /**
     * Die Messstellen am Ort, wie die Vektor-Fälle sie brauchen: der Test legt sie in den Haken
     * {@link OrtsbaumMessstellen} — vor die echte Bean ({@code MessstelleOrtsbaumMessstellen},
     * AP-04 IP-7), deren Weg aus {@code messstelle_ort} {@code MessstelleZuordnungApiTest} beweist.
     */
    static final List<OrtsbaumAbleitung.Messstelle> MESSSTELLEN = new CopyOnWriteArrayList<>();

    @TestConfiguration
    static class MessstellenAmOrt {
        @Bean
        @Primary
        OrtsbaumMessstellen ortsbaumMessstellen() {
            return () -> List.copyOf(MESSSTELLEN);
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    StandortService standortService;

    @Autowired
    UnternehmenService unternehmenService;

    private static JsonNode referenz;
    private static JsonNode vektoren;
    private static JdbcTemplate root;
    private static final Map<String, Token> TOKENS = new ConcurrentHashMap<>();

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
        vektoren = MAPPER.readTree(V2.resolve("ortsbaum-vectors.json").toFile());
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
    }

    @AfterEach
    void aufraeumen() {
        MESSSTELLEN.clear();
        standortService.uhrStellen(Clock.systemUTC());
        unternehmenService.uhrStellen(Clock.systemUTC());
    }

    // ---- Anlegen: automatisches Kurzzeichen, die Antwort, ein Eintrag ------------

    @Test
    void anlegenVergibtST1UndST2UndSchreibtJeGenauEinenEintragMitUrheber() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        assertThat(vorschlag(wer)).isEqualTo("ST-1");
        assertThat(zaehler(t)).as("der Vorschlag bewegt den Zähler nicht").isNull();

        uhr("2026-10-01T09:12:00+02:00");
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/standorte", wer, ausReferenz("ST-1"));
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        JsonNode werk = r.getBody();
        assertThat(r.getHeaders().getLocation()).hasToString("/api/v1/standorte/" + werk.get("id").asText());
        JsonNode ref = referenzStandort("ST-1");
        assertThat(werk.get("kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(werk.get("name").asText()).isEqualTo(ref.get("name").asText());
        assertThat(werk.at("/adresse/strasse").asText()).isEqualTo(ref.at("/adresse/strasse").asText());
        assertThat(werk.at("/adresse/plz").isNull()).as("nicht erhoben bleibt null").isTrue();
        assertThat(werk.at("/adresse/land").asText()).isEqualTo("DE");
        assertThat(werk.get("zeitzone").asText()).isEqualTo(ref.get("zeitzone").asText());
        assertThat(werk.get("zustand").asText()).isEqualTo("aktiv");
        assertThat(werk.get("esFehlt")).isEmpty();
        assertThat(werk.get("bestand").asText()).isEqualTo("vorhanden");
        assertThat(texte(werk.get("nutzung"))).containsExactly("produktion", "buero");
        assertThat(werk.get("notiz").asText()).isEqualTo(ref.get("notiz").asText());
        assertThat(werk.at("/lage/breitengrad").asDouble()).isEqualTo(ref.at("/lage/breitengrad").asDouble());
        assertThat(werk.at("/lage/laengengrad").asDouble()).isEqualTo(ref.at("/lage/laengengrad").asDouble());
        assertThat(werk.get("archiviertAm").isNull()).isTrue();
        assertThat(werk.get("anlagen")).isEmpty();
        assertThat(rufe(HttpMethod.GET, "/standorte/" + werk.get("id").asText() + "?stichtag=2026-10-01", wer, null)
                .getBody()).isEqualTo(werk);

        assertThat(vorschlag(wer)).isEqualTo("ST-2");
        assertThat(zaehler(t)).isEqualTo(2);
        uhr("2026-10-15T08:00:00+02:00");
        JsonNode lindach = anlegen(wer, ausReferenz("ST-2"));
        assertThat(lindach.get("kurzzeichen").asText()).isEqualTo("ST-2");
        assertThat(lindach.get("lage").isNull()).isTrue();

        // Je Anlegen genau ein Eintrag „angelegt"; der Plattform-Betrieb steht als VoltPilot darin.
        String adminSub = anspruch("admin").get("sub").asText();
        List<Map<String, Object>> eintraege = protokoll(t, "standort");
        assertThat(eintraege).hasSize(2);
        for (int i = 0; i < 2; i++) {
            Map<String, Object> e = eintraege.get(i);
            JsonNode st = i == 0 ? werk : lindach;
            assertThat(e.get("objekt_id").toString()).isEqualTo(st.get("id").asText());
            assertThat(e.get("art")).isEqualTo("angelegt");
            assertThat(e.get("alt")).isNull();
            assertThat(json(e.get("neu")).get("kurzzeichen").asText()).isEqualTo(st.get("kurzzeichen").asText());
            assertThat(json(e.get("neu")).get("zustand").asText()).isEqualTo("aktiv");
            assertThat(e.get("actor_sub")).isEqualTo(adminSub);
            assertThat(e.get("actor_name")).isEqualTo("VoltPilot (admin)");
            assertThat(e.get("rueckwirkend")).isEqualTo(false);
        }
        assertThat(eintraege.get(0).get("gilt_ab").toString()).isEqualTo("2026-10-01");
        assertThat(eintraege.get(1).get("gilt_ab").toString()).isEqualTo("2026-10-15");
    }

    @Test
    void dieStandortFlaecheBekommtZeitgueltigeFassungenStattUeberschriebenZuWerden() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        uhr("2026-10-01T09:12:00+02:00");
        String id = anlegen(wer, ausReferenz("ST-1")).get("id").asText();

        JsonNode erste = rufe(HttpMethod.PUT, "/standorte/" + id + "/flaeche", wer,
                Map.of("m2", 8450, "gueltigAb", "2026-10-01")).getBody();
        assertThat(erste.get("flaecheM2").asInt()).isEqualTo(8450);
        assertThat(erste.get("flaecheQuelle").asText()).isEqualTo("eigen");

        uhr("2027-01-15T14:40:00+01:00");
        JsonNode zweite = rufe(HttpMethod.PUT, "/standorte/" + id + "/flaeche", wer,
                Map.of("m2", 9000, "gueltigAb", "2027-01-01")).getBody();
        assertThat(zweite.get("flaecheM2").asInt()).isEqualTo(9000);
        assertThat(bestandFlaeche(wer, id, "2026-12-31")).isEqualTo(8450);
        assertThat(bestandFlaeche(wer, id, "2027-01-01")).isEqualTo(9000);

        List<Map<String, Object>> fassungen = root.queryForList("SELECT m2, gueltig_ab, gueltig_bis, "
                + "aufgehoben_am FROM flaeche_gueltigkeit WHERE standort_id = ?::uuid ORDER BY gueltig_ab", id);
        assertThat(fassungen).hasSize(2);
        assertThat(fassungen.get(0).get("gueltig_bis").toString()).isEqualTo("2026-12-31");
        assertThat(fassungen.get(0).get("aufgehoben_am")).isNull();
    }

    // ---- Kurzzeichen: eigenes, belegt (auch archiviert, früher, Gebäude) ----------

    @Test
    void kurzzeichenEigenesUndBelegtAuchArchiviertFrueherUndUeberGebaeudeHinweg() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        uhr("2026-10-01T09:00:00+02:00");
        JsonNode werk = anlegen(wer, ausReferenz("ST-1"));
        assertThat(werk.get("kurzzeichen").asText()).isEqualTo("ST-1");

        // Belegt, ohne Groß-/Kleinschreibung und Randleerzeichen: 409 mit Verweis, nichts geschrieben.
        long vorher = eintraege(t);
        Map<String, Object> lindach = ausReferenz("ST-2");
        lindach.put("kurzzeichen", " st-1 ");
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/standorte", wer, lindach);
        abgelehnt(r, 409, "kurzzeichen_belegt");
        assertThat(r.getBody().at("/verweis/kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(r.getBody().at("/verweis/name").asText()).isEqualTo("Werk Ahrenberg");
        assertThat(r.getBody().at("/verweis/id").asText()).isEqualTo(werk.get("id").asText());
        assertThat(r.getBody().at("/verweis/archiviert").asBoolean()).isFalse();
        assertThat(eintraege(t)).isEqualTo(vorher);
        assertThat(zaehler(t)).isEqualTo(2);

        // Ein eigenes Kurzzeichen ist erlaubt — und die automatische Vergabe springt darüber.
        lindach.put("kurzzeichen", "ST-2");
        assertThat(anlegen(wer, lindach).get("kurzzeichen").asText()).isEqualTo("ST-2");
        uhr("2027-02-20T10:05:00+01:00");
        JsonNode nord = anlegen(wer, nord());
        assertThat(nord.get("kurzzeichen").asText()).as("ST-2 ist belegt, der Zähler springt").isEqualTo("ST-3");
        assertThat(zaehler(t)).isEqualTo(4);

        // Früher getragen: Werk Lindach heißt jetzt LIN — ST-2 bleibt belegt, für jeden anderen.
        String lindachId = standortId(t, "ST-2");
        Map<String, Object> umbenannt = ausReferenz("ST-2");
        umbenannt.put("kurzzeichen", "LIN");
        JsonNode lin = rufe(HttpMethod.PUT, "/standorte/" + lindachId, wer, umbenannt).getBody();
        assertThat(lin.get("kurzzeichen").asText()).isEqualTo("LIN");
        Map<String, Object> nordNeu = nord();
        nordNeu.put("kurzzeichen", "ST-2");
        r = rufe(HttpMethod.PUT, "/standorte/" + nord.get("id").asText(), wer, nordNeu);
        abgelehnt(r, 409, "kurzzeichen_belegt");
        assertThat(r.getBody().at("/verweis/frueher").asBoolean()).isTrue();
        assertThat(r.getBody().at("/verweis/heute").asText()).isEqualTo("LIN");
        assertThat(r.getBody().get("message").asText()).isEqualTo("ST-2 ist bereits vergeben (Werk Lindach, heute "
                + "LIN). Kurzzeichen sind je Unternehmen eindeutig — auch archivierte und frühere bleiben belegt.");
        // Der Standort selbst darf zu seinem früheren zurück.
        umbenannt.put("kurzzeichen", "ST-2");
        assertThat(rufe(HttpMethod.PUT, "/standorte/" + lindachId, wer, umbenannt).getBody()
                .get("kurzzeichen").asText()).isEqualTo("ST-2");

        // Archiviert: das Kurzzeichen bleibt belegt.
        uhr("2027-04-01T10:00:00+02:00");
        assertThat(rufe(HttpMethod.POST, "/standorte/" + lindachId + "/archivieren", wer, null)
                .getStatusCode().value()).isEqualTo(200);
        r = rufe(HttpMethod.PUT, "/standorte/" + nord.get("id").asText(), wer, nordNeu);
        abgelehnt(r, 409, "kurzzeichen_belegt");
        assertThat(r.getBody().at("/verweis/archiviert").asBoolean()).isTrue();

        // Über Standorte UND Gebäude hinweg eindeutig (die gemeinsame Belegung).
        UUID g1 = neuesGebaeude(t, "G-1", "Halle 1", UUID.fromString(werk.get("id").asText()),
                LocalDate.parse("2026-10-01"));
        nordNeu.put("kurzzeichen", "g-1");
        r = rufe(HttpMethod.PUT, "/standorte/" + nord.get("id").asText(), wer, nordNeu);
        abgelehnt(r, 409, "kurzzeichen_belegt");
        assertThat(r.getBody().at("/verweis/objekt_art").asText()).isEqualTo("gebaeude");
        assertThat(r.getBody().at("/verweis/id").asText()).isEqualTo(g1.toString());
        assertThat(r.getBody().at("/verweis/name").asText()).isEqualTo("Halle 1");
        // … auch dann, wenn der Schreibweg die Prüfung überginge: die Datenbank lehnt selbst ab.
        assertThatThrownBy(() -> root.update("UPDATE standort SET kurzzeichen = 'G-1' WHERE id = ?",
                UUID.fromString(nord.get("id").asText()))).hasMessageContaining("uq_ort_kurzzeichen_belegt");

        // Form: höchstens 24 Zeichen; beim Bearbeiten ist das Kurzzeichen Pflicht.
        nordNeu.put("kurzzeichen", "X".repeat(25));
        abgelehnt(rufe(HttpMethod.PUT, "/standorte/" + nord.get("id").asText(), wer, nordNeu), 400,
                "anfrage_ungueltig", "feld", "kurzzeichen");
        nordNeu.remove("kurzzeichen");
        abgelehnt(rufe(HttpMethod.PUT, "/standorte/" + nord.get("id").asText(), wer, nordNeu), 400,
                "anfrage_ungueltig", "feld", "kurzzeichen");
    }

    // ---- A10: die Namensregel -------------------------------------------------------

    @Test
    void a10NameLeerZuLangOderUnterDenHeutigenStandortenVergeben() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        uhr("2026-10-01T09:00:00+02:00");
        JsonNode werk = anlegen(wer, ausReferenz("ST-1"));
        long vorher = eintraege(t);

        Map<String, Object> b = ausReferenz("ST-2");
        b.put("name", "  ");
        abgelehnt(rufe(HttpMethod.POST, "/standorte", wer, b), 400, "anfrage_ungueltig", "feld", "name");
        b.put("name", "W".repeat(OrtFelder.NAME_HOECHSTENS + 1));
        abgelehnt(rufe(HttpMethod.POST, "/standorte", wer, b), 400, "anfrage_ungueltig", "feld", "name");
        b.put("name", " werk AHRENBERG ");
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/standorte", wer, b);
        abgelehnt(r, 409, "name_belegt");
        assertThat(r.getBody().get("message").asText()).isEqualTo("Diesen Namen gibt es hier schon: Werk Ahrenberg "
                + "(ST-1). Wählen Sie einen anderen Namen — oder öffnen Sie Werk Ahrenberg.");
        assertThat(r.getBody().at("/verweis/id").asText()).isEqualTo(werk.get("id").asText());
        assertThat(r.getBody().at("/verweis/kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(r.getBody().at("/verweis/objekt_art").asText()).isEqualTo("standort");
        assertThat(eintraege(t)).as("abgelehnt heißt: kein Eintrag").isEqualTo(vorher);
        assertThat(zaehler(t)).as("und kein Kurzzeichen verbraucht").isEqualTo(2);

        // Umbenennen: dieselbe Regel, der Standort kollidiert nie mit sich selbst.
        uhr("2026-10-15T08:00:00+02:00");
        JsonNode lindach = anlegen(wer, ausReferenz("ST-2"));
        Map<String, Object> umbenennen = ausReferenz("ST-2");
        umbenennen.put("kurzzeichen", "ST-2");
        umbenennen.put("name", "Werk Ahrenberg");
        abgelehnt(rufe(HttpMethod.PUT, "/standorte/" + lindach.get("id").asText(), wer, umbenennen), 409,
                "name_belegt");
        umbenennen.put("name", "WERK LINDACH");
        assertThat(rufe(HttpMethod.PUT, "/standorte/" + lindach.get("id").asText(), wer, umbenennen).getBody()
                .get("name").asText()).isEqualTo("WERK LINDACH");
    }

    // ---- A7-Muster: die Sperrgründe beim Archivieren --------------------------------

    /**
     * Die Vektor-Fälle {@code standort-mit-anlage-und-messstellen} und
     * {@code standort-mit-aktiver-anlage} über die Schnittstelle: Werk Lindach mit der Anlage
     * Werk Lindach (AN-3) und den Messstellen MS-16/17/18 (über den Haken), am 20.10.2026. Der
     * Satz und die Liste sind zeichengleich die der Datei. Danach, ohne Sperre: die leeren
     * Gebäude G-4/G-5 werden mitarchiviert, ihr Intervall endet am Vortag; ein Eintrag.
     */
    @Test
    void a7ArchivierenGesperrtMitDerGanzenListeDemSatzUndDemWeg() throws Exception {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        JsonNode szenario = vektoren.at("/szenarien/ahrenberg-vor-dem-umzug");
        JsonNode an3 = element(szenario.get("anlagen"), "AN-3");
        // Die Anlage VOR den Standorten: ihre Zuordnung trägt der Fall selbst ein (ab
        // 15.10.2026) — seit AP-02 IP-9 belegt POST /sites sonst den einen Standort vor
        // bzw. verlangt bei zweien die Wahl (422).
        UUID site = UUID.fromString(neueAnlage(t, an3.get("name").asText()));
        uhr("2026-10-01T09:00:00+02:00");
        anlegen(wer, ausReferenz("ST-1"));
        uhr("2026-10-15T08:00:00+02:00");
        UUID lindach = UUID.fromString(anlegen(wer, ausReferenz("ST-2")).get("id").asText());
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?,?,?,?)",
                t, site, lindach, LocalDate.parse(an3.at("/zuordnungen/0/ab").asText()));
        Map<String, UUID> gebaeude = new LinkedHashMap<>();
        for (String kz : List.of("G-4", "G-5")) {
            JsonNode g = element(szenario.get("orte"), kz);
            gebaeude.put(kz, neuesGebaeude(t, kz, g.get("name").asText(), lindach,
                    LocalDate.parse(g.at("/intervalle/0/ab").asText())));
        }
        for (JsonNode m : szenario.get("messstellen")) {
            if (Set.of("ST-2", "G-4", "G-5").contains(m.at("/zuordnungen/0/eltern").asText())) {
                MESSSTELLEN.add(messstelle(m));
            }
        }
        JsonNode fall = fall("standort-mit-anlage-und-messstellen");
        uhr(fall.at("/input/tag").asText() + "T10:00:00+02:00");
        long vorher = eintraege(t);

        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/standorte/" + lindach + "/archivieren", wer, null);
        abgelehnt(r, 409, "archivieren_gesperrt");
        assertThat(r.getBody().get("message").asText()).isEqualTo(fall.at("/expected/text").asText());
        JsonNode gruende = r.getBody().get("gruende");
        JsonNode soll = fall.at("/expected/gruende");
        assertThat(gruende).hasSize(soll.size());
        for (int i = 0; i < soll.size(); i++) {
            JsonNode g = gruende.get(i);
            assertThat(g.get("art").asText()).isEqualTo(soll.get(i).get("art").asText());
            assertThat(g.get("name").asText()).isEqualTo(soll.get(i).get("name").asText());
            if ("anlage_aktiv".equals(g.get("art").asText())) {
                assertThat(g.get("objekt").asText()).isEqualTo("anlage");
                assertThat(g.get("id").asText()).isEqualTo(site.toString());
                assertThat(g.get("weg").asText()).isEqualTo("anlage_zuordnen");
            } else {
                assertThat(g.get("objekt").asText()).isEqualTo("messstelle");
                assertThat(g.get("kennzeichen").asText()).isEqualTo(soll.get(i).get("kennzeichen").asText());
                assertThat(g.get("weg").asText()).isEqualTo("messstelle_umziehen");
            }
        }

        // Nur die Anlage (die Messstellen sind angehalten): der Satz aus §5.10.
        MESSSTELLEN.replaceAll(m -> new OrtsbaumAbleitung.Messstelle(m.kennzeichen(), m.name(), m.anlage(),
                ObjektZustand.ANGEHALTEN, m.zuordnungen()));
        r = rufe(HttpMethod.POST, "/standorte/" + lindach + "/archivieren", wer, null);
        abgelehnt(r, 409, "archivieren_gesperrt");
        assertThat(r.getBody().get("message").asText())
                .isEqualTo(fall("standort-mit-aktiver-anlage").at("/expected/text").asText());
        assertThat(r.getBody().get("gruende")).hasSize(1);
        assertThat(eintraege(t)).as("abgelehnt heißt: nichts geschrieben").isEqualTo(vorher);
        assertThat(zustand(lindach)).isEqualTo("aktiv");

        // Die Anlage zieht am Vortag weg (IP-11 bringt den Weg dafür): jetzt geht es.
        root.update("UPDATE anlage_standort SET gueltig_bis = ? WHERE site_id = ?",
                LocalDate.parse("2026-10-19"), site);
        JsonNode archiviert = rufe(HttpMethod.POST, "/standorte/" + lindach + "/archivieren", wer, null).getBody();
        assertThat(archiviert.get("zustand").asText()).isEqualTo("archiviert");
        assertThat(archiviert.get("bestand").asText()).isEqualTo("archiviert");
        assertThat(archiviert.get("bestandText").asText()).isEqualTo("Am 20.10.2026 war Werk Lindach archiviert.");
        assertThat(archiviert.get("archiviertAm").isNull()).isFalse();
        for (Map.Entry<String, UUID> g : gebaeude.entrySet()) {
            assertThat(root.queryForObject("SELECT zustand FROM ort WHERE id = ?", String.class, g.getValue()))
                    .as(g.getKey()).isEqualTo("archiviert");
            assertThat(root.queryForObject("SELECT gueltig_bis FROM ort_zuordnung WHERE ort_id = ?",
                    LocalDate.class, g.getValue())).as(g.getKey()).isEqualTo(LocalDate.parse("2026-10-19"));
        }
        assertThat(eintraege(t)).as("EIN Eintrag, am Standort").isEqualTo(vorher + 1);
        Map<String, Object> e = letzter(t, "standort");
        assertThat(e.get("art")).isEqualTo("archiviert");
        assertThat(e.get("gilt_ab").toString()).isEqualTo("2026-10-20");
        JsonNode neu = json(e.get("neu"));
        assertThat(neu.get("letzter_tag").asText()).isEqualTo("2026-10-19");
        assertThat(texte(neu.get("mitarchiviert"), "kurzzeichen")).containsExactlyInAnyOrder("G-4", "G-5");
        assertThat(json(e.get("alt")).get("zustand").asText()).isEqualTo("aktiv");
    }

    // ---- A8: Archivieren und Wiederherstellen ---------------------------------------

    /**
     * Die Tage des Vektor-Falls {@code standort-kinder-bleiben-archiviert}: Werk Lindach
     * (seit 15.10.2026) wird am 01.04.2027 archiviert und am 01.05.2027 wiederhergestellt. Die
     * Lücke ist die der Datei, das Lesemodell zeigt sie; das Gebäude bleibt archiviert.
     */
    @Test
    void a8WiederherstellenBeginntEinNeuesBestehenUndDieLueckeBleibtImLesemodellSichtbar() throws Exception {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        JsonNode fall = fall("standort-kinder-bleiben-archiviert");
        uhr("2026-10-01T09:00:00+02:00");
        anlegen(wer, ausReferenz("ST-1"));
        uhr("2026-10-15T08:00:00+02:00");
        String lindach = anlegen(wer, ausReferenz("ST-2")).get("id").asText();
        UUID g4 = neuesGebaeude(t, "G-4", "Lagerhalle Lindach", UUID.fromString(lindach),
                LocalDate.parse("2026-10-15"));

        uhr("2027-04-01T10:00:00+02:00");
        assertThat(rufe(HttpMethod.POST, "/standorte/" + lindach + "/archivieren", wer, Map.of())
                .getStatusCode().value()).isEqualTo(200);
        // Nichts an einem archivierten Standort — außer Wiederherstellen.
        Map<String, Object> bearbeiten = ausReferenz("ST-2");
        bearbeiten.put("kurzzeichen", "ST-2");
        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/standorte/" + lindach, wer, bearbeiten);
        abgelehnt(r, 409, "archiviert");
        r = rufe(HttpMethod.POST, "/standorte/" + lindach + "/archivieren", wer, null);
        abgelehnt(r, 409, "archivieren_gesperrt");
        assertThat(r.getBody().get("message").asText()).isEqualTo("Am 01.04.2027 war Werk Lindach archiviert.");
        assertThat(r.getBody().at("/gruende/0/art").asText()).isEqualTo("archiviert");

        uhr(fall.at("/input/tag").asText() + "T10:00:00+02:00");
        long vorher = eintraege(t);
        JsonNode wieder = rufe(HttpMethod.POST, "/standorte/" + lindach + "/wiederherstellen", wer, null).getBody();
        assertThat(wieder.get("bestand").asText()).isEqualTo("vorhanden");
        assertThat(wieder.get("zustand").asText()).isEqualTo("aktiv");
        assertThat(wieder.get("archiviertAm").isNull()).isTrue();
        assertThat(wieder.get("name").asText()).isEqualTo(fall.at("/expected/name").asText());
        assertThat(wieder.get("gebaeudeZahl").asInt()).as("die Kinder kommen nicht still mit zurück").isZero();
        assertThat(root.queryForObject("SELECT zustand FROM ort WHERE id = ?", String.class, g4))
                .isEqualTo("archiviert");

        assertThat(eintraege(t)).isEqualTo(vorher + 1);
        Map<String, Object> e = letzter(t, "standort");
        assertThat(e.get("art")).isEqualTo("wiederhergestellt");
        assertThat(e.get("gilt_ab").toString()).isEqualTo(fall.at("/expected/intervall/ab").asText());
        assertThat(json(e.get("neu")).get("luecke")).isEqualTo(fall.at("/expected/luecke"));
        assertThat(json(e.get("alt")).get("zustand").asText()).isEqualTo("archiviert");

        // Das Lesemodell zeigt die Lücke — und nur sie.
        assertThat(bestand(wer, lindach, "2027-03-31")).isEqualTo("vorhanden");
        assertThat(bestand(wer, lindach, fall.at("/expected/luecke/von").asText())).isEqualTo("archiviert");
        assertThat(bestand(wer, lindach, fall.at("/expected/luecke/bis").asText())).isEqualTo("archiviert");
        assertThat(bestand(wer, lindach, fall.at("/expected/intervall/ab").asText())).isEqualTo("vorhanden");
        JsonNode april = rufe(HttpMethod.GET, "/standorte?stichtag=2027-04-15", wer, null).getBody();
        assertThat(texte(april.get("standorte"), "name")).containsExactly("Werk Ahrenberg");
        assertThat(april.at("/nichtGezeigt/0/bestandText").asText())
                .isEqualTo("Am 15.04.2027 war Werk Lindach archiviert.");

        // Nicht archiviert: nichts wiederherzustellen.
        r = rufe(HttpMethod.POST, "/standorte/" + lindach + "/wiederherstellen", wer, null);
        abgelehnt(r, 409, "wiederherstellen_gesperrt");
        assertThat(r.getBody().get("grund").asText()).isEqualTo("nicht_archiviert");
        assertThat(r.getBody().get("message").asText()).isEqualTo("Werk Lindach ist nicht archiviert.");

        // angelegt · archiviert · wiederhergestellt — die abgelehnten schrieben nichts.
        assertThat(protokoll(t, "standort").stream().filter(x -> x.get("objekt_id").toString().equals(lindach))
                .map(x -> x.get("art"))).containsExactly("angelegt", "archiviert", "wiederhergestellt");
    }

    /**
     * A10 beim Wiederherstellen: nach dem Archivieren darf ein neuer Standort „Werk Lindach"
     * heißen — er bekommt ST-3, ST-2 wird nie wiederverwendet. Beim Wiederherstellen ist der
     * Name dann belegt (409 mit Verweis), und das Umbenennen im selben Dialog löst es.
     */
    @Test
    void a10BeimWiederherstellenIstDerNameBelegtUndDasUmbenennenImSelbenDialogLoestEs() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        uhr("2026-10-01T09:00:00+02:00");
        anlegen(wer, ausReferenz("ST-1"));
        uhr("2026-10-15T08:00:00+02:00");
        String alt = anlegen(wer, ausReferenz("ST-2")).get("id").asText();
        uhr("2027-04-01T10:00:00+02:00");
        rufe(HttpMethod.POST, "/standorte/" + alt + "/archivieren", wer, null);
        uhr("2027-04-10T10:00:00+02:00");
        JsonNode neu = anlegen(wer, ausReferenz("ST-2"));
        assertThat(neu.get("kurzzeichen").asText()).as("nie wiederverwendet").isEqualTo("ST-3");

        uhr("2027-05-01T10:00:00+02:00");
        long vorher = eintraege(t);
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/standorte/" + alt + "/wiederherstellen", wer, null);
        abgelehnt(r, 409, "wiederherstellen_gesperrt");
        assertThat(r.getBody().get("grund").asText()).isEqualTo("name_belegt");
        assertThat(r.getBody().get("message").asText()).isEqualTo("Diesen Namen gibt es hier schon: Werk Lindach "
                + "(ST-3). Wählen Sie einen anderen Namen — oder öffnen Sie Werk Lindach.");
        assertThat(r.getBody().at("/verweis/id").asText()).isEqualTo(neu.get("id").asText());
        abgelehnt(rufe(HttpMethod.POST, "/standorte/" + alt + "/wiederherstellen", wer, Map.of("name", " ")), 400,
                "anfrage_ungueltig", "feld", "name");
        assertThat(eintraege(t)).isEqualTo(vorher);

        JsonNode wieder = rufe(HttpMethod.POST, "/standorte/" + alt + "/wiederherstellen", wer,
                Map.of("name", "Werk Lindach Alt")).getBody();
        assertThat(wieder.get("name").asText()).isEqualTo("Werk Lindach Alt");
        assertThat(wieder.get("kurzzeichen").asText()).isEqualTo("ST-2");
        Map<String, Object> e = letzter(t, "standort");
        assertThat(json(e.get("alt")).get("name").asText()).isEqualTo("Werk Lindach");
        assertThat(json(e.get("neu")).get("name").asText()).isEqualTo("Werk Lindach Alt");
        assertThat(eintraege(t)).isEqualTo(vorher + 1);
    }

    // ---- A14: der Mandantenzaun ------------------------------------------------------

    @Test
    void a14EinFremderStandortIst404NieEin403UndNichtsWirdGeschrieben() {
        JsonNode werk = anlegen(DEMO, ausReferenz("ST-1"));
        String id = werk.get("id").asText();
        UUID mandantA = UUID.fromString(root.queryForObject("SELECT tenant_id::text FROM standort WHERE id = ?",
                String.class, UUID.fromString(id)));
        // Ein Kundenbenutzer steht mit seinem Namen im Protokoll.
        Map<String, Object> e = letzter(mandantA, "standort");
        assertThat(e.get("actor_name")).isEqualTo("demo");
        assertThat(e.get("actor_sub")).isEqualTo(anspruch("demo").get("sub").asText());
        long vorher = eintraege(mandantA);

        Map<String, Object> b = ausReferenz("ST-1");
        b.put("kurzzeichen", werk.get("kurzzeichen").asText());
        assertThat(rufe(HttpMethod.GET, "/standorte/" + id, DEMO2, null).getStatusCode().value()).isEqualTo(404);
        abgelehnt(rufe(HttpMethod.PUT, "/standorte/" + id, DEMO2, b), 404, "nicht_gefunden");
        abgelehnt(rufe(HttpMethod.POST, "/standorte/" + id + "/archivieren", DEMO2, null), 404, "nicht_gefunden");
        abgelehnt(rufe(HttpMethod.POST, "/standorte/" + id + "/wiederherstellen", DEMO2, null), 404,
                "nicht_gefunden");
        assertThat(eintraege(mandantA)).isEqualTo(vorher);
        assertThat(zustand(UUID.fromString(id))).isEqualTo("aktiv");

        // Der Plattform-Admin ohne gewählten Kundenbereich: nichts da, nichts zu schreiben.
        abgelehnt(rufe(HttpMethod.POST, "/standorte", ADMIN_OHNE_KUNDENBEREICH, ausReferenz("ST-2")), 404,
                "nicht_gefunden");
        abgelehnt(rufe(HttpMethod.GET, "/standorte/kurzzeichen-vorschlag", ADMIN_OHNE_KUNDENBEREICH, null), 404,
                "nicht_gefunden");
        abgelehnt(rufe(HttpMethod.PUT, "/unternehmen", ADMIN_OHNE_KUNDENBEREICH, ausReferenzUnternehmen()), 404,
                "nicht_gefunden");
        abgelehnt(rufe(HttpMethod.PUT, "/standorte/" + id, ADMIN_OHNE_KUNDENBEREICH, b), 404, "nicht_gefunden");
    }

    // ---- Unternehmen bearbeiten ------------------------------------------------------

    @Test
    @SuppressWarnings("unchecked")
    void unternehmenBearbeitenSchreibtNurDieGeaendertenFelderUndVererbtDieZeitzone() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        uhr("2026-10-01T09:00:00+02:00");
        long vorher = eintraege(t);
        JsonNode ref = referenz.get("unternehmen");

        JsonNode u = rufe(HttpMethod.PUT, "/unternehmen", wer, ausReferenzUnternehmen()).getBody();
        assertThat(u.get("name").asText()).isEqualTo(ref.get("name").asText());
        assertThat(u.get("kurzname").asText()).isEqualTo(ref.get("kurzname").asText());
        assertThat(u.get("rechtsform").asText()).isEqualTo(ref.get("rechtsform").asText());
        assertThat(u.at("/sitz/strasse").asText()).isEqualTo(ref.at("/sitz/strasse").asText());
        assertThat(u.at("/sitz/plz").isNull()).isTrue();
        assertThat(u.get("zeitzone").asText()).isEqualTo("Europe/Berlin");
        assertThat(rufe(HttpMethod.GET, "/unternehmen", wer, null).getBody()).isEqualTo(u);

        // Genau ein Eintrag, alt/neu NUR die geänderten Felder (der Name stand schon so da).
        assertThat(eintraege(t)).isEqualTo(vorher + 1);
        Map<String, Object> e = letzter(t, "unternehmen");
        assertThat(e.get("art")).isEqualTo("bearbeitet");
        assertThat(e.get("gilt_ab").toString()).isEqualTo("2026-10-01");
        assertThat(feldnamen(json(e.get("neu")))).containsExactlyInAnyOrder("kurzname", "sitz", "rechtsform");
        assertThat(json(e.get("alt")).get("kurzname").isNull()).isTrue();

        // Dieselben Werte noch einmal: nichts geändert, nichts geschrieben.
        assertThat(rufe(HttpMethod.PUT, "/unternehmen", wer, ausReferenzUnternehmen()).getStatusCode().value())
                .isEqualTo(200);
        assertThat(eintraege(t)).isEqualTo(vorher + 1);

        // Die Form; abgelehnt schreibt nichts.
        Map<String, Object> b = ausReferenzUnternehmen();
        ((Map<String, Object>) b.get("sitz")).put("plz", "84xxx");
        ResponseEntity<JsonNode> r = rufe(HttpMethod.PUT, "/unternehmen", wer, b);
        abgelehnt(r, 400, "anfrage_ungueltig", "feld", "sitz.plz");
        assertThat(r.getBody().get("message").asText())
                .isEqualTo("Die PLZ 84xxx passt nicht zu Deutschland (fünfstellig).");
        b = ausReferenzUnternehmen();
        b.put("zeitzone", "Europe/London");
        abgelehnt(rufe(HttpMethod.PUT, "/unternehmen", wer, b), 400, "anfrage_ungueltig", "feld", "zeitzone");
        b = ausReferenzUnternehmen();
        b.put("name", "");
        abgelehnt(rufe(HttpMethod.PUT, "/unternehmen", wer, b), 400, "anfrage_ungueltig", "feld", "name");
        b = ausReferenzUnternehmen();
        b.put("branche", ref.get("branche").asText());
        abgelehnt(rufe(HttpMethod.PUT, "/unternehmen", wer, b), 400, "anfrage_ungueltig", "feld", "branche");
        assertThat(eintraege(t)).isEqualTo(vorher + 1);

        // Die Zeitzonen-Vorgabe belegt jeden NEUEN Standort vor (Regel 11).
        b = ausReferenzUnternehmen();
        b.put("zeitzone", "Europe/Vienna");
        rufe(HttpMethod.PUT, "/unternehmen", wer, b);
        Map<String, Object> st = ausReferenz("ST-1");
        st.remove("zeitzone");
        assertThat(anlegen(wer, st).get("zeitzone").asText()).isEqualTo("Europe/Vienna");
    }

    // ---- Entwurf → eingerichtet (E10) und die Form der Adresse -------------------------

    @Test
    void einEntwurfWirdMitDerAdresseEingerichtetUndDieAdresseIstPflicht() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        // Wie die Bestandsübernahme (IP-9): Name der Anlage, ohne Adresse — ein Entwurf.
        String an1 = element(vektoren.at("/szenarien/ahrenberg/anlagen"), "AN-1").get("name").asText();
        UUID unternehmenId = root.queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, t);
        UUID entwurf = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, "
                + "zeitzone, zustand) VALUES (?, ?, ?, 'ST-1', 'Europe/Berlin', 'entwurf') RETURNING id",
                UUID.class, t, unternehmenId, an1);
        JsonNode vorher = rufe(HttpMethod.GET, "/standorte/" + entwurf, wer, null).getBody();
        assertThat(texte(vorher.get("esFehlt"))).containsExactly("adresse");
        long eintraege = eintraege(t);

        // Umbenennen ohne Adresse: bleibt Entwurf (E10 — ein Entwurf blockiert nichts).
        Map<String, Object> b = ausReferenz("ST-1");
        b.put("kurzzeichen", "ST-1");
        b.put("adresse", null);
        JsonNode umbenannt = rufe(HttpMethod.PUT, "/standorte/" + entwurf, wer, b).getBody();
        assertThat(umbenannt.get("name").asText()).isEqualTo("Werk Ahrenberg");
        assertThat(umbenannt.get("zustand").asText()).isEqualTo("entwurf");
        assertThat(texte(umbenannt.get("esFehlt"))).containsExactly("adresse");

        // Die Adresse nachgetragen: eingerichtet und aktiv, im Protokoll alt → neu.
        b = ausReferenz("ST-1");
        b.put("kurzzeichen", "ST-1");
        JsonNode eingerichtet = rufe(HttpMethod.PUT, "/standorte/" + entwurf, wer, b).getBody();
        assertThat(eingerichtet.get("zustand").asText()).isEqualTo("aktiv");
        assertThat(eingerichtet.get("esFehlt")).isEmpty();
        assertThat(eintraege(t)).isEqualTo(eintraege + 2);
        Map<String, Object> e = letzter(t, "standort");
        assertThat(json(e.get("alt")).get("zustand").asText()).isEqualTo("entwurf");
        assertThat(json(e.get("neu")).get("zustand").asText()).isEqualTo("aktiv");
        assertThat(json(e.get("neu")).at("/adresse/strasse").asText()).isEqualTo("Gewerbering 7");
        assertThat(json(e.get("neu")).has("name")).as("nur die geänderten Felder").isFalse();

        // Unverändert: nichts geschrieben. Einem eingerichteten Standort fehlt die Adresse nie wieder.
        rufe(HttpMethod.PUT, "/standorte/" + entwurf, wer, b);
        assertThat(eintraege(t)).isEqualTo(eintraege + 2);
        b.put("adresse", null);
        abgelehnt(rufe(HttpMethod.PUT, "/standorte/" + entwurf, wer, b), 400, "anfrage_ungueltig", "feld",
                "adresse");

        // Beim Anlegen ist die Adresse Pflicht (Straße, Ort, Land); die PLZ im Format je Land (§5.10).
        Map<String, Object> ohne = ausReferenz("ST-2");
        ohne.put("adresse", Map.of("strasse", "Am Bahndamm 12", "ort", "Lindach"));
        abgelehnt(rufe(HttpMethod.POST, "/standorte", wer, ohne), 400, "anfrage_ungueltig", "feld", "adresse");
        Map<String, Object> wels = new LinkedHashMap<>();
        wels.put("name", "Werk Wels");
        wels.put("adresse", Map.of("strasse", "Stadtplatz 1", "plz", "84xxx", "ort", "Wels", "land", "AT"));
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/standorte", wer, wels);
        abgelehnt(r, 400, "anfrage_ungueltig", "feld", "adresse.plz");
        assertThat(r.getBody().get("message").asText())
                .isEqualTo("Die PLZ 84xxx passt nicht zu Österreich (vierstellig).");
        assertThat(eintraege(t)).isEqualTo(eintraege + 2);
    }

    // ---- Die Anfrage wird streng gelesen --------------------------------------------

    @Test
    void dieAnfrageWirdStrengGelesenUndEineAblehnungSchreibtNichts() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        String werk = anlegen(wer, ausReferenz("ST-1")).get("id").asText();
        long vorher = eintraege(t);

        Map<String, Object> b = ausReferenz("ST-2");
        b.put("flaeche", 2600);
        abgelehnt(rufe(HttpMethod.POST, "/standorte", wer, b), 400, "anfrage_ungueltig", "feld", "flaeche");
        b = ausReferenz("ST-2");
        b.put("nutzung", List.of("lager", "kantine"));
        abgelehnt(rufe(HttpMethod.POST, "/standorte", wer, b), 400, "anfrage_ungueltig", "feld", "nutzung[1]");
        b.put("nutzung", List.of("lager", "lager"));
        abgelehnt(rufe(HttpMethod.POST, "/standorte", wer, b), 400, "anfrage_ungueltig", "feld", "nutzung[1]");
        b = ausReferenz("ST-2");
        b.put("lage", Map.of("breitengrad", 48.25));
        abgelehnt(rufe(HttpMethod.POST, "/standorte", wer, b), 400, "anfrage_ungueltig", "feld", "lage");
        b = ausReferenz("ST-2");
        b.put("zeitzone", "Europe/London");
        abgelehnt(rufe(HttpMethod.POST, "/standorte", wer, b), 400, "anfrage_ungueltig", "feld", "zeitzone");
        abgelehnt(rufe(HttpMethod.POST, "/standorte", wer, List.of()), 400, "anfrage_ungueltig");
        abgelehnt(rufe(HttpMethod.POST, "/standorte/" + werk + "/archivieren", wer, Map.of("tag", "2027-01-01")),
                400, "anfrage_ungueltig", "feld", "tag");
        abgelehnt(rufe(HttpMethod.POST, "/standorte/" + werk + "/wiederherstellen", wer, Map.of("tag", "x")),
                400, "anfrage_ungueltig", "feld", "tag");
        assertThat(eintraege(t)).isEqualTo(vorher);
        assertThat(zaehler(t)).isEqualTo(2);
    }

    // ---- Die Vokabulare und die neuen Tabellen ----------------------------------------

    @Test
    void a2A15AusfallAm03112026LiestNurFestgehalteneFaktenUndFremdBleibt404() {
        UUID t = neuerKundenbereich();
        Anrufer wer = admin(t);
        UUID site = UUID.fromString(neueAnlage(t, "Halle 2"));
        UUID standort = UUID.fromString(anlegen(wer, ausReferenz("ST-1")).get("id").asText());
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?,?,?,DATE '2024-03-12')", t, site, standort);
        UUID e1 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, kind, name, status) "
                + "VALUES (?,?,'VP-BOX-2026-0481','edge','Box Halle 1','claimed') RETURNING id", UUID.class,
                t, site);
        UUID e2 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, kind, name, status) "
                + "VALUES (?,?,'VP-BOX-2026-0482','edge','Box Halle 2','claimed') RETURNING id", UUID.class,
                t, site);
        UUID dq = root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, name, protokoll, "
                + "adresse, kadenz_s) VALUES (?,?,'DQ-A2','WAGO Halle 2','modbus_tcp','10.0.0.9:502/1',60) "
                + "RETURNING id", UUID.class, t, site);
        UUID komponente = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, device_id, communication, connection_json, data_source_id, created_at) VALUES "
                + "(?,?,'grid-meter','Netzbezug Halle 2','grid-meter',?,'modbus_tcp',"
                + "'{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb,?,'2024-03-12T00:00:00Z') RETURNING id",
                UUID.class, t, site, e2, dq);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, komponente);
        UUID ms10 = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?,'MS-A2','Netzbezug Halle 2','gemessen','Strom',"
                + "'Wirkenergie','Bezug','kWh','Zählerstand') RETURNING id", UUID.class, t);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) "
                + "VALUES (?,?,?,'2024-03-12')", t, ms10, standort);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, "
                + "geraet_id, kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, "
                + "actor_name, actor_art) VALUES (?,?,'Wirkenergie','Bezug',?,?,'energy_kwh','counter',"
                + "'zaehlerstand','fuehrend','2024-03-12T00:00:00Z',true,now(),'Fixture','voltpilot')",
                t, ms10, komponente, geraet);
        Instant von = OffsetDateTime.parse("2026-11-03T14:00:00+01:00").toInstant();
        UUID ereignis = UUID.randomUUID();
        UUID quellenEreignis = UUID.randomUUID();
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, "
                + "site_id, kennungen, device_id, nutzlast, eingang) VALUES (?,?,?,'data_gap','cloud',?,NULL,"
                + "?,jsonb_build_object('box', ?::text),?,jsonb_build_object('erkannt_aus','herzschlag',"
                + "'fehlerklasse','box_meldet_sich_nicht'),?)", Timestamp.from(von), t, ereignis,
                Timestamp.from(von), site, e2, e2, Timestamp.from(von.plusSeconds(301)));
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, "
                + "site_id, kennungen, device_id, data_source_id, nutzlast, eingang) VALUES "
                + "(?,?,?,'data_gap','cloud',?,NULL,?,jsonb_build_object('box', ?::text, 'datenquelle', ?::text),"
                + "?,?,jsonb_build_object('erkannt_aus','herzschlag','fehlerklasse','box_meldet_sich_nicht'),?)",
                Timestamp.from(von), t, quellenEreignis, Timestamp.from(von), site, e2, dq, e2, dq,
                Timestamp.from(von.plusSeconds(301)));

        JsonNode offen = rufe(HttpMethod.GET, "/standorte/" + standort + "/ausfall", wer, null).getBody();
        assertThat(offen.get("boxen_gesamt").asInt()).isEqualTo(2);
        assertThat(offen.get("boxen_ausgefallen").asInt()).isEqualTo(1);
        assertThat(offen.at("/boxen/0/name").asText()).isEqualTo("Box Halle 2");
        assertThat(offen.at("/boxen/0/seit").asText()).startsWith("2026-11-03T14:00:00+01:00");
        assertThat(offen.get("messstellen_unvollstaendig").asInt()).isEqualTo(1);
        assertThat(offen.at("/messstellen/0/kennzeichen").asText()).isEqualTo("MS-A2");
        assertThat(offen.at("/messstellen/0/box").asText()).isEqualTo("Box Halle 2");
        assertThat(rufe(HttpMethod.GET, "/standorte/" + standort + "/ausfall", DEMO2, null)
                .getStatusCode().value()).isEqualTo(404);

        Instant rueckkehr = OffsetDateTime.parse("2026-11-03T17:30:00+01:00").toInstant();
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, "
                + "site_id, kennungen, device_id, nutzlast, eingang) VALUES (?,?,?,'data_gap','cloud',?,?,"
                + "?,jsonb_build_object('box', ?::text),?,jsonb_build_object('erkannt_aus','herzschlag',"
                + "'fehlerklasse','box_meldet_sich_nicht'),?)", Timestamp.from(von), t, ereignis,
                Timestamp.from(von), Timestamp.from(rueckkehr), site, e2, e2, Timestamp.from(rueckkehr));
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, "
                + "site_id, kennungen, device_id, data_source_id, nutzlast, eingang) VALUES "
                + "(?,?,?,'data_gap','cloud',?,?,?,jsonb_build_object('box', ?::text, 'datenquelle', ?::text),"
                + "?,?,jsonb_build_object('erkannt_aus','herzschlag','fehlerklasse','box_meldet_sich_nicht'),?)",
                Timestamp.from(von), t, quellenEreignis, Timestamp.from(von), Timestamp.from(rueckkehr), site,
                e2, dq, e2, dq, Timestamp.from(rueckkehr));
        JsonNode geschlossen = rufe(HttpMethod.GET, "/standorte/" + standort + "/ausfall", wer, null).getBody();
        assertThat(geschlossen.get("boxen_ausgefallen").asInt()).isZero();
        assertThat(geschlossen.get("boxen")).isEmpty();
        assertThat(geschlossen.get("messstellen")).isEmpty();
        assertThat(e1).isNotNull();
    }

    @Test
    void dieVokabulareSindDieDerDatenbankUndDieBelegungStehtUnterDemZaun() throws SQLException {
        for (String n : OrtFelder.NUTZUNGEN) {
            assertThat(root.queryForObject("SELECT uems_nutzung_gueltig(ARRAY[?]::text[])", Boolean.class, n))
                    .as(n).isTrue();
        }
        assertThat(root.queryForObject("SELECT uems_nutzung_gueltig(ARRAY['kantine']::text[])", Boolean.class))
                .isFalse();
        String zeitzonen = root.queryForObject("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                + "WHERE conname = 'standort_zeitzone_chk'", String.class);
        OrtFelder.ZEITZONEN.forEach(z -> assertThat(zeitzonen).contains("'" + z + "'"));
        assertThat(zeitzonen.split("Europe/", -1)).hasSize(OrtFelder.ZEITZONEN.size() + 1);

        for (String tabelle : List.of("ort_kurzzeichen", "ort_kurzzeichen_seq")) {
            assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                    + "WHERE relname = ?", Boolean.class, tabelle)).as(tabelle).isTrue();
            assertThat(root.queryForObject("SELECT count(*) FROM pg_policies WHERE tablename = ?", Long.class,
                    tabelle)).as(tabelle).isEqualTo(1L);
        }
        UUID t = neuerKundenbereich();
        anlegen(admin(t), ausReferenz("ST-1"));
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW));
        assertThat(app.queryForObject("SELECT count(*) FROM ort_kurzzeichen", Long.class))
                .as("ohne Mandant: default-deny").isZero();
        assertThat(app.queryForObject("SELECT count(*) FROM ort_kurzzeichen_seq", Long.class)).isZero();
        try (Connection c = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW).getConnection();
                Statement s = c.createStatement()) {
            s.execute("SELECT set_config('app.tenant_id', '" + t + "', false)");
            assertThatThrownBy(() -> s.executeUpdate("INSERT INTO ort_kurzzeichen (tenant_id, kurzzeichen, "
                    + "objekt_art, objekt_id) VALUES ('" + t + "', 'ST-9', 'standort', gen_random_uuid())"))
                    .as("die Belegung entsteht nur aus einem getragenen Kurzzeichen")
                    .hasMessageContaining("permission denied");
        }
        assertThatThrownBy(() -> root.update("UPDATE ort_kurzzeichen_seq SET naechste_nummer = 1 "
                + "WHERE tenant_id = ?", t)).hasMessageContaining("rueckt nur vor");

        // Das Offboarding räumt Belegung und Zähler mit ab.
        new TenantRepository(root).offboard(t);
        for (String tabelle : List.of("ort_kurzzeichen", "ort_kurzzeichen_seq", "standort")) {
            assertThat(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, t))
                    .as(tabelle).isZero();
        }
    }

    // ---- Gerüst: Aufrufe -------------------------------------------------------------

    private ResponseEntity<JsonNode> rufe(HttpMethod methode, String pfad, Anrufer wer, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token(wer.benutzer()));
        if (wer.kundenbereich() != null) {
            headers.set("X-Tenant-Id", wer.kundenbereich().toString());
        }
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<?> entity = body == null ? new HttpEntity<>(headers) : new HttpEntity<>(body, headers);
        return rest.exchange("http://localhost:" + port + "/api/v1" + pfad, methode, entity, JsonNode.class);
    }

    private JsonNode anlegen(Anrufer wer, Map<String, Object> body) {
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/standorte", wer, body);
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(201);
        return r.getBody();
    }

    private String vorschlag(Anrufer wer) {
        return rufe(HttpMethod.GET, "/standorte/kurzzeichen-vorschlag", wer, null).getBody().get("kurzzeichen").asText();
    }

    private String bestand(Anrufer wer, String standort, String stichtag) {
        return rufe(HttpMethod.GET, "/standorte/" + standort + "?stichtag=" + stichtag, wer, null).getBody()
                .get("bestand").asText();
    }

    private int bestandFlaeche(Anrufer wer, String standort, String stichtag) {
        return rufe(HttpMethod.GET, "/standorte/" + standort + "?stichtag=" + stichtag, wer, null).getBody()
                .get("flaecheM2").asInt();
    }

    private UUID neuerKundenbereich() {
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/admin/tenants", ADMIN_OHNE_KUNDENBEREICH,
                Map.of("name", referenz.at("/unternehmen/name").asText()));
        assertThat(r.getStatusCode().value()).isEqualTo(201);
        return UUID.fromString(r.getBody().get("id").asText());
    }

    private String neueAnlage(UUID tenant, String name) {
        ResponseEntity<JsonNode> r = rufe(HttpMethod.POST, "/sites", admin(tenant), Map.of("name", name));
        assertThat(r.getStatusCode().value()).isEqualTo(201);
        return r.getBody().get("id").asText();
    }

    /** Ein Gebäude am Standort ab {@code ab} — bis IP-5 die Route bringt, über die Datenbank. */
    private static UUID neuesGebaeude(UUID tenant, String kurzzeichen, String name, UUID standort, LocalDate ab) {
        UUID g = root.queryForObject("INSERT INTO ort (tenant_id, art, name, kurzzeichen, zustand) "
                + "VALUES (?, 'gebaeude', ?, ?, 'aktiv') RETURNING id", UUID.class, tenant, name, kurzzeichen);
        root.update("INSERT INTO ort_zuordnung (tenant_id, ort_id, eltern_standort_id, gueltig_ab) VALUES (?,?,?,?)",
                tenant, g, standort, ab);
        return g;
    }

    /** Stellt „jetzt" für beide Schreibwege — Archivieren an einem Tag, Wiederherstellen an einem späteren. */
    private void uhr(String zeitpunkt) {
        Clock c = Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), ZoneOffset.UTC);
        standortService.uhrStellen(c);
        unternehmenService.uhrStellen(c);
    }

    /** Die Ablehnung mit Status, Code und (wenn genannt) einem Fakt. */
    private static void abgelehnt(ResponseEntity<JsonNode> r, int status, String code, String fakt, String wert) {
        abgelehnt(r, status, code);
        assertThat(r.getBody().get(fakt).asText()).isEqualTo(wert);
    }

    private static void abgelehnt(ResponseEntity<JsonNode> r, int status, String code) {
        assertThat(r.getStatusCode().value()).as(String.valueOf(r.getBody())).isEqualTo(status);
        assertThat(r.getBody().get("code").asText()).isEqualTo(code);
        assertThat(r.getBody().get("message").asText()).isNotBlank();
        assertThat(OrtAbgelehnt.CODES).contains(code);
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

    // ---- Gerüst: Datenbank und Vertrag -----------------------------------------------

    private static Integer zaehler(UUID tenant) {
        List<Integer> z = root.queryForList("SELECT naechste_nummer FROM ort_kurzzeichen_seq "
                + "WHERE tenant_id = ? AND objekt_art = 'standort'", Integer.class, tenant);
        return z.isEmpty() ? null : z.get(0);
    }

    private static long eintraege(UUID tenant) {
        return root.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?", Long.class, tenant);
    }

    private static List<Map<String, Object>> protokoll(UUID tenant, String objektArt) {
        return root.queryForList("SELECT objekt_id, art, alt::text AS alt, neu::text AS neu, gilt_ab, rueckwirkend, "
                + "actor_sub, actor_name FROM ort_aenderung WHERE tenant_id = ? AND objekt_art = ? ORDER BY id",
                tenant, objektArt);
    }

    private static Map<String, Object> letzter(UUID tenant, String objektArt) {
        List<Map<String, Object>> alle = protokoll(tenant, objektArt);
        return alle.get(alle.size() - 1);
    }

    private static String zustand(UUID standort) {
        return root.queryForObject("SELECT zustand FROM standort WHERE id = ?", String.class, standort);
    }

    private static String standortId(UUID tenant, String kurzzeichen) {
        return root.queryForObject("SELECT id::text FROM standort WHERE tenant_id = ? AND kurzzeichen = ?",
                String.class, tenant, kurzzeichen);
    }

    private static JsonNode referenzStandort(String kurzzeichen) {
        return element(referenz.get("standorte"), kurzzeichen);
    }

    /** Die Anfrage eines Standorts mit den Werten des Referenzunternehmens — Nutzung als Codes. */
    private static Map<String, Object> ausReferenz(String kurzzeichen) {
        JsonNode st = referenzStandort(kurzzeichen);
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", st.get("name").asText());
        b.put("adresse", adresse(st.get("adresse")));
        b.put("zeitzone", st.get("zeitzone").asText());
        List<String> nutzung = new ArrayList<>();
        st.get("nutzung").forEach(n -> nutzung.add(code(n.asText())));
        b.put("nutzung", nutzung);
        b.put("notiz", st.get("notiz").isNull() ? null : st.get("notiz").asText());
        if (!st.get("lage").isNull()) {
            Map<String, Object> lage = new LinkedHashMap<>();
            lage.put("breitengrad", st.at("/lage/breitengrad").decimalValue());
            lage.put("laengengrad", st.at("/lage/laengengrad").decimalValue());
            b.put("lage", lage);
        }
        return b;
    }

    /** Werk Ahrenberg Nord (ST-3) — angelegt am 20.02.2027 „Gewerbering 9, Ahrenberg · Europe/Berlin" (§4.4). */
    private static Map<String, Object> nord() {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", element(vektoren.at("/szenarien/ahrenberg-vor-dem-umzug/orte"), "ST-3").get("name").asText());
        b.put("adresse", Map.of("strasse", "Gewerbering 9", "ort", "Ahrenberg", "land", "DE"));
        b.put("zeitzone", "Europe/Berlin");
        return b;
    }

    private static Map<String, Object> ausReferenzUnternehmen() {
        JsonNode u = referenz.get("unternehmen");
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", u.get("name").asText());
        b.put("kurzname", u.get("kurzname").asText());
        b.put("zeitzone", u.get("zeitzone").asText());
        b.put("sitz", adresse(u.get("sitz")));
        b.put("rechtsform", u.get("rechtsform").asText());
        return b;
    }

    private static Map<String, Object> adresse(JsonNode a) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (String feld : List.of("strasse", "plz", "ort", "land")) {
            m.put(feld, a.get(feld).isNull() ? null : a.get(feld).asText());
        }
        return m;
    }

    /** Das Kundenwort der Nutzung als Code (E4): Kleinbuchstaben, ä→ae, ö→oe, ü→ue, ß→ss. */
    private static String code(String kundenwort) {
        return kundenwort.toLowerCase().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss");
    }

    private static OrtsbaumAbleitung.Messstelle messstelle(JsonNode m) {
        List<Intervall> intervalle = new ArrayList<>();
        for (JsonNode iv : m.get("zuordnungen")) {
            intervalle.add(new Intervall(LocalDate.parse(iv.get("ab").asText()),
                    iv.get("bis").isNull() ? null : LocalDate.parse(iv.get("bis").asText()),
                    iv.get("eltern").asText()));
        }
        return new OrtsbaumAbleitung.Messstelle(m.get("kennzeichen").asText(), m.get("name").asText(),
                m.path("anlage").isMissingNode() || m.path("anlage").isNull() ? null : m.get("anlage").asText(),
                ObjektZustand.valueOf(m.get("zustand").asText().toUpperCase()), intervalle);
    }

    private static JsonNode fall(String name) {
        for (JsonNode c : vektoren.get("cases")) {
            if (c.get("name").asText().equals(name)) {
                return c;
            }
        }
        throw new AssertionError("kein Fall " + name);
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode x : liste) {
            if (x.get("kennzeichen").asText().equals(kennzeichen)) {
                return x;
            }
        }
        throw new AssertionError("kein " + kennzeichen);
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static List<String> texte(JsonNode liste, String feld) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.get(feld).asText()));
        return out;
    }

    private static List<String> feldnamen(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.fieldNames().forEachRemaining(out::add);
        return out;
    }

    private static JsonNode json(Object text) {
        try {
            return MAPPER.readTree((String) text);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
