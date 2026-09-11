package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
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
 * Die Schreibrouten der Gebäude und Bereiche und das Ortsbaum-Lesemodell (UEMS AP-02 IP-5)
 * durch den ganzen Stapel — echter Keycloak, echte TimescaleDB, RLS als einziger Zaun. Der
 * Bestand ist das Referenzunternehmen Kunststoffwerk Ahrenberg GmbH
 * ({@code uems-referenzunternehmen.json}, Fassung 1.1): jeder Name, jedes Kurzzeichen, jede
 * Fläche und jedes „gültig ab“ kommt von dort.
 *
 * <ol>
 *   <li>A4: der Neukunde legt die Orte in der Reihenfolge der Referenz an — G-1 … G-5 und
 *       B-1 … B-7 werden automatisch vergeben, jeder Knoten ist sofort aktiv, je Vorgang GENAU
 *       EIN Protokolleintrag; der Ortsbaum zeigt sie, „direkt am Standort“ ohne erfundene 0.</li>
 *   <li>A3: der Anbau von Halle 2 — 3 100 → 3 400 m² ab 01.01.2027, eingetragen am 15.01.2027:
 *       die alte Fläche endet am Vortag, das Abzeichen sagt „rückwirkend (14 Tage)“.</li>
 *   <li>Bereich unter Bereich und Gebäude unter Bereich: 400 mit dem Vertragsgrund.</li>
 *   <li>A10: Name doppelt unter demselben Elternknoten am Tag 409; an einem anderen Standort
 *       erlaubt (G-6); das Kurzzeichen kollidiert auch mit einem Standort (409).</li>
 *   <li>Das Ziel bestand am Tag noch nicht: 422 mit dem Satz des Vertrags.</li>
 *   <li>A14: ein fremder Standort oder Ort ist 404, nie 403 — und nichts ist geschrieben.</li>
 *   <li>A16: „gültig ab“ fehlend ist heute in der Zeitzone DES STANDORTS, nicht in UTC.</li>
 *   <li>Bearbeiten: nur geänderte Felder im Protokoll; ohne Änderung kein Eintrag.</li>
 * </ol>
 *
 * <p>Die Regeln selbst beweist {@code OrtsbaumAbleitungVectorsTest} gegen die Vektor-Datei;
 * hier geht es um Draht, Zeilen, Protokoll und Zaun.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class OrtApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    /** Die Kundenwörter der Referenz → die Codes des Vokabulars (E4). */
    private static final Map<String, String> NUTZUNG = Map.of("Produktion", "produktion",
            "Montage", "montage", "Lager", "lager", "Logistik", "logistik", "Büro", "buero",
            "Technik", "technik", "Außenfläche", "aussenflaeche");

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);
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
    JdbcTemplate app;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    @Autowired
    UnternehmenRepository unternehmen;
    @Autowired
    StandortRepository standorte;
    @Autowired
    OrtService orte;

    @AfterEach
    void uhrZurueck() {
        orte.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------- (1) A4

    @Test
    void a4NeukundeLegtDieOrteDerReferenzAnUndBekommtDieKurzzeichenDerReferenz() throws Exception {
        String token = token("admin", "admin");
        Ahrenberg ah = ahrenberg(token);
        JsonNode ref = referenz();

        // Jedes Kurzzeichen ist das der Referenz — automatisch, in ihrer Reihenfolge.
        for (JsonNode g : ref.path("gebaeude")) {
            String kz = g.path("kennzeichen").asText();
            JsonNode o = ah.antworten.get(kz);
            assertThat(o.path("kurzzeichen").asText()).as("Gebäude %s", g.path("name")).isEqualTo(kz);
            assertThat(o.path("art").asText()).isEqualTo("gebaeude");
            assertThat(o.path("zustand").asText()).isEqualTo("aktiv");
            assertThat(o.path("baujahr").asInt()).isEqualTo(g.path("baujahr").asInt());
            assertThat(o.path("standortId").asText()).isEqualTo(ah.ids.get(g.path("standort").asText()).toString());
            // A16: Gebäude und Bereiche tragen keine Zeitzone — sie erben.
            assertThat(o.has("zeitzone")).isFalse();
        }
        for (JsonNode b : ref.path("bereiche")) {
            String kz = b.path("kennzeichen").asText();
            JsonNode o = ah.antworten.get(kz);
            assertThat(o.path("kurzzeichen").asText()).as("Bereich %s", b.path("name")).isEqualTo(kz);
            assertThat(o.path("notiz").asText()).isEqualTo(b.path("beschreibung").asText());
            assertThat(o.path("zuordnungen").get(0).path("elternId").asText())
                    .isEqualTo(ah.ids.get(b.path("eltern").asText()).toString());
            assertThat(o.path("zuordnungen").get(0).path("elternArt").asText()).isEqualTo("gebaeude");
        }
        // Halle 1 hängt rückwirkend seit dem 12.03.2024 (Fassung 1.1): das Abzeichen der Referenz.
        assertThat(ah.antworten.get("G-1").path("rueckwirkung").path("abzeichen").asText())
                .isEqualTo(abzeichenDerZuordnung(ref, "G-1"));
        assertThat(ah.antworten.get("G-2").path("rueckwirkung").path("art").asText()).isEqualTo("ab_heute");
        assertThat(ah.antworten.get("G-2").path("rueckwirkung").path("abzeichen").isNull()).isTrue();

        // GENAU EIN Protokolleintrag je Schreibvorgang: „angelegt“ je Ort, dazu je nachgetragener
        // Fläche (G-1, G-3: sie beginnt nach dem ersten Tag) ein „flaeche_geaendert“.
        for (Map.Entry<String, UUID> e : ah.ids.entrySet()) {
            if (e.getKey().startsWith("ST-")) {
                continue;
            }
            List<Map<String, Object>> eintraege = protokoll(ah.tenant, e.getValue());
            int erwartet = List.of("G-1", "G-3").contains(e.getKey()) ? 2 : 1;
            assertThat(eintraege).as("Protokoll %s", e.getKey()).hasSize(erwartet);
            Map<String, Object> angelegt = eintraege.get(0);
            assertThat(angelegt.get("art")).isEqualTo("angelegt");
            assertThat(angelegt.get("akteur_sub")).isEqualTo(anspruch(token).path("sub").asText());
            assertThat(angelegt.get("akteur_name"))
                    .isEqualTo(OrtProtokoll.akteurName(ProtokollAkteur.fuer("x", "admin", true)));
            assertThat((String) angelegt.get("neu")).contains(e.getKey());
        }
        Map<String, Object> g1 = protokoll(ah.tenant, ah.ids.get("G-1")).get(0);
        assertThat(g1.get("gilt_ab").toString()).isEqualTo("2024-03-12");
        assertThat(g1.get("rueckwirkend")).isEqualTo(true);

        // Der Ortsbaum am 20.10.2026 (Momentaufnahme der Referenz).
        JsonNode werk = ok(get("/api/v1/standorte/" + ah.ids.get("ST-1") + "/orte?stichtag=2026-10-20",
                token, ah.tenant));
        assertThat(werk.path("stichtag").asText()).isEqualTo("2026-10-20");
        assertThat(werk.path("standort").path("kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(kurzzeichen(werk.path("gebaeude"))).containsExactly("G-1", "G-2", "G-3");
        assertThat(kurzzeichen(werk.path("gebaeude").get(0).path("bereiche"))).containsExactly("B-1", "B-2");
        assertThat(kurzzeichen(werk.path("gebaeude").get(1).path("bereiche")))
                .containsExactly("B-3", "B-4", "B-5");
        assertThat(werk.path("gebaeude").get(2).path("bereiche")).isEmpty();
        JsonNode halle2 = werk.path("gebaeude").get(1);
        assertThat(halle2.path("flaecheM2").asInt()).isEqualTo(3100);
        assertThat(halle2.path("flaecheQuelle").asText()).isEqualTo("eigen");
        assertThat(halle2.path("gueltigAb").asText()).isEqualTo("2026-10-01");
        assertThat(halle2.path("gueltigBis").isNull()).isTrue();
        assertThat(halle2.has("zeitzone")).isFalse();
        // Messstellen-Zahl: Platzhalter bis AP-04 IP-7 — null, nie eine erfundene 0.
        assertThat(halle2.path("messstellenZahl").isNull()).isTrue();
        assertThat(werk.path("direktAmStandort").path("bereiche")).isEmpty();
        assertThat(werk.path("direktAmStandort").path("messstellenZahl").isNull()).isTrue();
        // Die eigene Fläche des Standorts gilt; die Summe der Gebäude steht daneben.
        assertThat(werk.path("standort").path("flaecheM2").asInt()).isEqualTo(8450);
        assertThat(werk.path("summeGebaeudeM2").asInt()).isEqualTo(4200 + 3100 + 1150);

        // Werk Lindach ohne eigene Fläche: 2 600 m² aus Gebäuden summiert (Referenz ST-2).
        JsonNode lindach = ok(get("/api/v1/standorte/" + ah.ids.get("ST-2") + "/orte?stichtag=2026-10-20",
                token, ah.tenant));
        assertThat(kurzzeichen(lindach.path("gebaeude"))).containsExactly("G-4", "G-5");
        assertThat(lindach.path("standort").path("flaecheM2").asInt()).isEqualTo(2600);
        assertThat(lindach.path("standort").path("flaecheQuelle").asText()).isEqualTo("aus_gebaeuden_summiert");
        assertThat(lindach.path("gebaeudeOhneFlaeche")).isEmpty();

        // Vor dem 01.10.2026 gab es Halle 2 nicht — Halle 1 (rückwirkend seit 2024) schon.
        JsonNode frueh = ok(get("/api/v1/standorte/" + ah.ids.get("ST-1") + "/orte?stichtag=2025-06-01",
                token, ah.tenant));
        assertThat(kurzzeichen(frueh.path("gebaeude"))).containsExactly("G-1", "G-3");
        assertThat(frueh.path("gebaeude").get(0).path("flaecheM2").isNull()).isTrue();
        // Lindach gab es am 01.10.2026 noch nicht: kein Baum, keine erfundene Zeile.
        JsonNode vorLindach = ok(get("/api/v1/standorte/" + ah.ids.get("ST-2")
                + "/orte?stichtag=2026-10-01", token, ah.tenant));
        assertThat(vorLindach.path("standort").path("bestand").asText()).isEqualTo("gab_es_noch_nicht");
        assertThat(vorLindach.path("gebaeude")).isEmpty();
        assertThat(vorLindach.path("direktAmStandort").isNull()).isTrue();
        assertThat(get("/api/v1/standorte/" + ah.ids.get("ST-1") + "/orte?stichtag=20.10.2026", token,
                ah.tenant).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ------------------------------------------------------------------- (2) A3

    @Test
    void a3AnbauHalle2DieAlteFlaecheEndetAmVortagUndDasAbzeichenSagtRueckwirkend() throws Exception {
        String token = token("admin", "admin");
        Ahrenberg ah = ahrenberg(token);
        UUID halle2 = ah.ids.get("G-2");
        int vorher = protokoll(ah.tenant, halle2).size();

        uhr("2027-01-15T14:40:00+01:00");
        JsonNode r = ok(put("/api/v1/orte/" + halle2 + "/flaeche", token, ah.tenant,
                Map.of("m2", 3400, "gueltigAb", "2027-01-01")));
        JsonNode referenzFlaechen = referenzGebaeude("G-2").path("bezugsflaechen");
        assertThat(r.path("flaechen")).hasSize(referenzFlaechen.size());
        for (int i = 0; i < referenzFlaechen.size(); i++) {
            JsonNode soll = referenzFlaechen.get(i);
            JsonNode ist = r.path("flaechen").get(i);
            assertThat(ist.path("m2").asInt()).isEqualTo(soll.path("flaeche_m2").asInt());
            assertThat(ist.path("gueltigAb").asText()).isEqualTo(soll.path("gueltig_ab").asText());
            assertThat(ist.path("gueltigBis").isNull() ? null : ist.path("gueltigBis").asText())
                    .isEqualTo(soll.path("gueltig_bis").isNull() ? null : soll.path("gueltig_bis").asText());
        }
        assertThat(r.path("flaechen").get(0).path("zustand").asText()).isEqualTo("beendet");
        assertThat(r.path("flaechen").get(1).path("zustand").asText()).isEqualTo("gueltig");
        // E2: rückwirkend erlaubt, aber sichtbar — 14 Tage vor dem Eintragstag (Vertrag, Referenz).
        assertThat(r.path("rueckwirkung").path("art").asText()).isEqualTo("rueckwirkend");
        assertThat(r.path("rueckwirkung").path("tage").asInt()).isEqualTo(14);
        assertThat(r.path("rueckwirkung").path("abzeichen").asText())
                .isEqualTo(referenzFlaechen.get(1).path("abzeichen").asText());

        // Die Zeilen: die 3 100 m² beendet am 31.12.2026, nicht umgeschrieben, nicht aufgehoben.
        List<Map<String, Object>> zeilen = admin.queryForList("SELECT m2, gueltig_ab, gueltig_bis, "
                + "aufgehoben_am FROM flaeche_gueltigkeit WHERE ort_id = ? ORDER BY gueltig_ab", halle2);
        assertThat(zeilen).hasSize(2);
        assertThat(zeilen.get(0).get("gueltig_bis").toString()).isEqualTo("2026-12-31");
        assertThat(zeilen.get(0).get("aufgehoben_am")).isNull();

        // GENAU EIN neuer Eintrag: Fläche geändert 3 100 → 3 400, gilt ab 01.01.2027, rückwirkend.
        List<Map<String, Object>> eintraege = protokoll(ah.tenant, halle2);
        assertThat(eintraege).hasSize(vorher + 1);
        Map<String, Object> e = eintraege.get(eintraege.size() - 1);
        assertThat(e.get("art")).isEqualTo("flaeche_geaendert");
        assertThat(e.get("gilt_ab").toString()).isEqualTo("2027-01-01");
        assertThat(e.get("rueckwirkend")).isEqualTo(true);
        assertThat(MAPPER.readTree((String) e.get("alt")).path("flaeche_m2").asInt()).isEqualTo(3100);
        assertThat(MAPPER.readTree((String) e.get("neu")).path("flaeche_m2").asInt()).isEqualTo(3400);

        // „Stand am 31.12.2026“ zeigt 3 100 m², der 01.01.2027 schon 3 400 m² (A3).
        assertThat(flaecheAm(token, ah, "ST-1", "G-2", "2026-12-31")).isEqualTo(3100);
        assertThat(flaecheAm(token, ah, "ST-1", "G-2", "2027-01-01")).isEqualTo(3400);

        // Abgelehnt wird mit Grund und Weg — und ohne Eintrag.
        JsonNode gleich = abgelehnt(put("/api/v1/orte/" + halle2 + "/flaeche", token, ah.tenant,
                Map.of("m2", 3400, "gueltigAb", "2027-02-01")), HttpStatus.BAD_REQUEST, "gleiche_flaeche");
        assertThat(gleich.path("message").asText()).isEqualTo("Halle 2 hat am 01.02.2027 bereits 3\u00a0400\u00a0m².");
        abgelehnt(put("/api/v1/orte/" + halle2 + "/flaeche", token, ah.tenant,
                Map.of("m2", 0, "gueltigAb", "2027-02-01")), HttpStatus.BAD_REQUEST, "flaeche_ungueltig");
        JsonNode krumm = abgelehnt(put("/api/v1/orte/" + halle2 + "/flaeche", token, ah.tenant,
                Map.of("m2", 3400.5, "gueltigAb", "2027-02-01")), HttpStatus.BAD_REQUEST, "flaeche_ungueltig");
        assertThat(krumm.path("message").asText()).isEqualTo(OrtsbaumAbleitung.FLAECHE_SATZ);
        JsonNode frueh = abgelehnt(put("/api/v1/orte/" + halle2 + "/flaeche", token, ah.tenant,
                Map.of("m2", 3000, "gueltigAb", "2026-09-30")), HttpStatus.UNPROCESSABLE_ENTITY,
                "gab_es_noch_nicht");
        assertThat(frueh.path("message").asText())
                .isEqualTo("Halle 2 gibt es im Portal erst seit 01.10.2026. Wählen Sie ein Datum ab dem 01.10.2026.");
        assertThat(protokoll(ah.tenant, halle2)).hasSize(vorher + 1);

        // Korrektur (§4.2): „gültig ab“ = Beginn der laufenden Fläche ersetzt sie — die alte
        // bleibt als aufgehoben lesbar.
        JsonNode korrektur = ok(put("/api/v1/orte/" + halle2 + "/flaeche", token, ah.tenant,
                Map.of("m2", 3450, "gueltigAb", "2027-01-01")));
        assertThat(korrektur.path("flaechen").get(1).path("m2").asInt()).isEqualTo(3450);
        assertThat(admin.queryForObject("SELECT count(*) FROM flaeche_gueltigkeit WHERE ort_id = ? "
                + "AND aufgehoben_am IS NOT NULL AND m2 = 3400", Integer.class, halle2)).isEqualTo(1);
        Map<String, Object> k = protokoll(ah.tenant, halle2).get(vorher + 1);
        assertThat(MAPPER.readTree((String) k.get("neu")).path("korrektur").asBoolean()).isTrue();
    }

    // ---------------------------------------------- (3) Bereich unter Bereich 400

    @Test
    void bereichUnterBereichUndGebaeudeUnterBereichSind400MitDemVertragsgrund() throws Exception {
        String token = token("admin", "admin");
        Ahrenberg ah = ahrenberg(token);
        uhr("2026-10-20T10:15:00+02:00");
        String route = "/api/v1/standorte/" + ah.ids.get("ST-1") + "/orte";
        long vorher = alleEintraege(ah.tenant);

        JsonNode bb = abgelehnt(post(route, token, ah.tenant, Map.of("art", "bereich",
                "name", "Montage Nord", "elternId", ah.ids.get("B-3").toString())),
                HttpStatus.BAD_REQUEST, "ziel_art_unzulaessig");
        assertThat(bb.path("message").asText())
                .isEqualTo("Ein Bereich kann nur an einem Gebäude oder direkt an einem Standort hängen.");
        JsonNode gb = abgelehnt(post(route, token, ah.tenant, Map.of("art", "gebaeude",
                "name", "Anbau", "elternId", ah.ids.get("B-3").toString())),
                HttpStatus.BAD_REQUEST, "ziel_art_unzulaessig");
        assertThat(gb.path("message").asText()).isEqualTo("Ein Gebäude kann nur an einem Standort hängen.");
        abgelehnt(post(route, token, ah.tenant, Map.of("art", "gebaeude", "name", "Anbau",
                "elternId", ah.ids.get("G-2").toString())), HttpStatus.BAD_REQUEST, "ziel_art_unzulaessig");
        // Nichts geschrieben: keine Zeile, kein Eintrag, kein Kurzzeichen verbraucht.
        assertThat(alleEintraege(ah.tenant)).isEqualTo(vorher);
        assertThat(admin.queryForObject("SELECT count(*) FROM ort WHERE tenant_id = ?::uuid AND name IN "
                + "('Montage Nord', 'Anbau')", Integer.class, ah.tenant)).isZero();

        // E7: ein Bereich direkt am Standort (Außenfläche) ist erlaubt — und bekommt B-8.
        JsonNode parkplatz = created(post(route, token, ah.tenant, Map.of("art", "bereich",
                "name", "Parkplatz Halle 2", "nutzung", List.of("aussenflaeche"))));
        assertThat(parkplatz.path("kurzzeichen").asText()).isEqualTo("B-8");
        assertThat(parkplatz.path("zuordnungen").get(0).path("elternArt").asText()).isEqualTo("standort");
        JsonNode baum = ok(get(route, token, ah.tenant));
        assertThat(kurzzeichen(baum.path("direktAmStandort").path("bereiche"))).containsExactly("B-8");
        // Ein Bereich hat kein Baujahr; ein Feld, das es nicht gibt, ist 400 — nie still verworfen.
        abgelehnt(post(route, token, ah.tenant, Map.of("art", "bereich", "name", "Technik Süd",
                "baujahr", 2010)), HttpStatus.BAD_REQUEST, "anfrage_ungueltig");
        JsonNode fremdesFeld = abgelehnt(post(route, token, ah.tenant, Map.of("art", "gebaeude",
                "name", "Halle 4", "farbe", "rot")), HttpStatus.BAD_REQUEST, "anfrage_ungueltig");
        assertThat(fremdesFeld.path("feld").asText()).isEqualTo("farbe");
        abgelehnt(post(route, token, ah.tenant, Map.of("art", "gebaeude", "name", "Halle 4",
                "nutzung", List.of("Büro"))), HttpStatus.BAD_REQUEST, "anfrage_ungueltig");
    }

    // ------------------------------------------------ (4) A10 Name und Kurzzeichen

    @Test
    void a10NameDoppeltUnterDemselbenElternknotenAmTag409AnderswoErlaubt() throws Exception {
        String token = token("admin", "admin");
        Ahrenberg ah = ahrenberg(token);
        uhr("2026-10-20T10:15:00+02:00");
        String ahrenbergRoute = "/api/v1/standorte/" + ah.ids.get("ST-1") + "/orte";
        long vorher = alleEintraege(ah.tenant);

        JsonNode doppelt = abgelehnt(post(ahrenbergRoute, token, ah.tenant,
                Map.of("art", "gebaeude", "name", " halle 1 ")), HttpStatus.CONFLICT, "name_belegt");
        assertThat(doppelt.path("message").asText()).isEqualTo(
                "Diesen Namen gibt es hier schon: Halle 1 (G-1). Wählen Sie einen anderen Namen — oder öffnen Sie Halle 1.");
        assertThat(doppelt.path("verweis").path("kurzzeichen").asText()).isEqualTo("G-1");
        assertThat(doppelt.path("verweis").path("id").asText()).isEqualTo(ah.ids.get("G-1").toString());
        // Unter demselben Gebäude ebenso — unter einem anderen nicht.
        abgelehnt(post(ahrenbergRoute, token, ah.tenant, Map.of("art", "bereich", "name", "Halle 2 Lager",
                "elternId", ah.ids.get("G-2").toString())), HttpStatus.CONFLICT, "name_belegt");
        assertThat(alleEintraege(ah.tenant)).isEqualTo(vorher);

        // A10: an Werk Lindach darf ein Gebäude „Halle 1“ heißen — Kurzzeichen G-6.
        JsonNode lindach = created(post("/api/v1/standorte/" + ah.ids.get("ST-2") + "/orte", token,
                ah.tenant, Map.of("art", "gebaeude", "name", "Halle 1")));
        assertThat(lindach.path("kurzzeichen").asText()).isEqualTo("G-6");
        assertThat(alleEintraege(ah.tenant)).isEqualTo(vorher + 1);

        // Ein eigenes Kurzzeichen, das ein Ort ODER ein Standort trägt: 409 mit Verweis.
        abgelehnt(post(ahrenbergRoute, token, ah.tenant, Map.of("art", "gebaeude", "name", "Halle 4",
                "kurzzeichen", "g-2")), HttpStatus.CONFLICT, "kurzzeichen_belegt");
        JsonNode standortKz = abgelehnt(put("/api/v1/orte/" + ah.ids.get("G-3"), token, ah.tenant,
                Map.of("name", "Verwaltung", "kurzzeichen", "ST-1")), HttpStatus.CONFLICT, "kurzzeichen_belegt");
        assertThat(standortKz.path("verweis").path("objekt_art").asText()).isEqualTo("standort");
        // Umbenennen auf den Namen eines Geschwisters: 409.
        abgelehnt(put("/api/v1/orte/" + ah.ids.get("G-3"), token, ah.tenant,
                Map.of("name", "Halle 2", "kurzzeichen", "G-3")), HttpStatus.CONFLICT, "name_belegt");
        assertThat(alleEintraege(ah.tenant)).isEqualTo(vorher + 1);
    }

    // ----------------------------------------------- (5) Ziel bestand noch nicht

    @Test
    void zielBestandAmTagNochNichtIst422MitDemSatzDesVertrags() throws Exception {
        String token = token("admin", "admin");
        Ahrenberg ah = ahrenberg(token);
        uhr("2026-10-20T10:15:00+02:00");
        String lindach = "/api/v1/standorte/" + ah.ids.get("ST-2") + "/orte";

        JsonNode standort = abgelehnt(post(lindach, token, ah.tenant, Map.of("art", "gebaeude",
                "name", "Werkstatt", "gueltigAb", "2026-10-01")), HttpStatus.UNPROCESSABLE_ENTITY,
                "ziel_gab_es_noch_nicht");
        assertThat(standort.path("message").asText()).isEqualTo(
                "Werk Lindach gibt es im Portal erst seit 15.10.2026. Wählen Sie ein Datum ab dem 15.10.2026.");
        JsonNode gebaeude = abgelehnt(post(lindach, token, ah.tenant, Map.of("art", "bereich",
                "name", "Tor 3", "elternId", ah.ids.get("G-4").toString(), "gueltigAb", "2026-10-01")),
                HttpStatus.UNPROCESSABLE_ENTITY, "ziel_gab_es_noch_nicht");
        assertThat(gebaeude.path("message").asText()).startsWith("Lagerhalle Lindach gibt es im Portal erst seit 15.10.2026.");
        // Ein Gebäude eines anderen Standorts ist hier kein Elternknoten.
        abgelehnt(post(lindach, token, ah.tenant, Map.of("art", "bereich", "name", "Tor 3",
                "elternId", ah.ids.get("G-2").toString())), HttpStatus.BAD_REQUEST, "anfrage_ungueltig");
        assertThat(admin.queryForObject("SELECT count(*) FROM ort WHERE tenant_id = ?::uuid AND name IN "
                + "('Werkstatt', 'Tor 3')", Integer.class, ah.tenant)).isZero();
    }

    // -------------------------------------------------------------- (6) A14 Zaun

    @Test
    void a14EinFremderStandortOderOrtIst404NieEin403UndNichtsIstGeschrieben() throws Exception {
        String adminToken = token("admin", "admin");
        Ahrenberg ah = ahrenberg(adminToken);
        UUID werk = ah.ids.get("ST-1");
        UUID halle2 = ah.ids.get("G-2");
        long vorher = alleEintraege(ah.tenant);

        String demo2 = token("demo2", "demo2");
        assertThat(get("/api/v1/standorte/" + werk + "/orte", demo2, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(post("/api/v1/standorte/" + werk + "/orte", demo2, null,
                Map.of("art", "gebaeude", "name", "Fremd")).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(put("/api/v1/orte/" + halle2, demo2, null,
                Map.of("name", "Fremd", "kurzzeichen", "G-2")).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(put("/api/v1/orte/" + halle2 + "/flaeche", demo2, null,
                Map.of("m2", 1, "gueltigAb", "2026-10-01")).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        // Ein Admin, der auf einen anderen Kundenbereich geschaltet hat, ebenso.
        String anderer = neuerKundenbereich(adminToken, "Anderer Kundenbereich GmbH");
        assertThat(get("/api/v1/standorte/" + werk + "/orte", adminToken, anderer).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(put("/api/v1/orte/" + halle2 + "/flaeche", adminToken, anderer,
                Map.of("m2", 1, "gueltigAb", "2026-10-01")).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get("/api/v1/standorte/" + UUID.randomUUID() + "/orte", adminToken, ah.tenant)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(alleEintraege(ah.tenant)).isEqualTo(vorher);
        assertThat(admin.queryForObject("SELECT name FROM ort WHERE id = ?", String.class, halle2))
                .isEqualTo("Halle 2");
    }

    // ------------------------------------------------------------- (7) A16 Zeitzone

    @Test
    void a16GueltigAbFehlendIstHeuteInDerZeitzoneDesStandorts() throws Exception {
        String token = token("admin", "admin");
        String tenant = neuerKundenbereich(token, "Kunststoffwerk Ahrenberg GmbH");
        // A16: „Werk Wels“ in Österreich bekommt Europe/Vienna.
        UUID wels = standort(tenant, "Werk Wels", "ST-9", "Europe/Vienna", LocalDate.of(2026, 10, 1));

        // 22:30 Uhr UTC am 14.10. ist 00:30 Uhr am 15.10. in Wels: der Tag ist der 15.10.
        uhr("2026-10-14T22:30:00Z");
        JsonNode halle = created(post("/api/v1/standorte/" + wels + "/orte", token, tenant,
                Map.of("art", "gebaeude", "name", "Halle Wels")));
        assertThat(halle.path("zuordnungen").get(0).path("gueltigAb").asText()).isEqualTo("2026-10-15");
        assertThat(halle.path("rueckwirkung").path("art").asText()).isEqualTo("ab_heute");
        assertThat(halle.has("zeitzone")).isFalse();
        // Derselbe Augenblick, „gültig ab“ 14.10.: in Wels schon gestern — rückwirkend (1 Tag).
        JsonNode lager = created(post("/api/v1/standorte/" + wels + "/orte", token, tenant,
                Map.of("art", "gebaeude", "name", "Lager Wels", "gueltigAb", "2026-10-14")));
        assertThat(lager.path("rueckwirkung").path("abzeichen").asText()).isEqualTo("rückwirkend (1 Tag)");
        assertThat(protokoll(tenant, UUID.fromString(lager.path("id").asText())).get(0).get("rueckwirkend"))
                .isEqualTo(true);
        // Der Baum ohne Stichtag: heute in Wels.
        JsonNode baum = ok(get("/api/v1/standorte/" + wels + "/orte", token, tenant));
        assertThat(baum.path("stichtag").asText()).isEqualTo("2026-10-15");
        assertThat(baum.path("standort").path("zeitzone").asText()).isEqualTo("Europe/Vienna");
        assertThat(baum.path("gebaeude").get(0).has("zeitzone")).isFalse();
    }

    // -------------------------------------------------------------- (8) Bearbeiten

    @Test
    void bearbeitenSchreibtNurGeaenderteFelderUndOhneAenderungKeinenEintrag() throws Exception {
        String token = token("admin", "admin");
        Ahrenberg ah = ahrenberg(token);
        uhr("2026-10-20T10:15:00+02:00");
        UUID verwaltung = ah.ids.get("G-3");
        int vorher = protokoll(ah.tenant, verwaltung).size();

        JsonNode r = ok(put("/api/v1/orte/" + verwaltung, token, ah.tenant, Map.of("name", "Verwaltung",
                "kurzzeichen", "G-3", "nutzung", List.of("buero", "sozialraeume"), "baujahr", 2004,
                "notiz", "Kantine im EG")));
        assertThat(r.path("nutzung").get(1).asText()).isEqualTo("sozialraeume");
        assertThat(r.path("rueckwirkung").isNull()).isTrue();
        List<Map<String, Object>> eintraege = protokoll(ah.tenant, verwaltung);
        assertThat(eintraege).hasSize(vorher + 1);
        Map<String, Object> e = eintraege.get(eintraege.size() - 1);
        assertThat(e.get("art")).isEqualTo("bearbeitet");
        assertThat(e.get("gilt_ab").toString()).isEqualTo("2026-10-20");
        assertThat(e.get("rueckwirkend")).isEqualTo(false);
        // jsonb ordnet die Schlüssel selbst — gezählt wird, WELCHE Felder drinstehen.
        JsonNode neu = MAPPER.readTree((String) e.get("neu"));
        assertThat(feldnamen(neu)).containsExactlyInAnyOrder("nutzung", "notiz");
        assertThat(feldnamen(MAPPER.readTree((String) e.get("alt")))).containsExactlyInAnyOrder("nutzung", "notiz");
        assertThat(neu.path("notiz").asText()).isEqualTo("Kantine im EG");

        // Dieselben Werte noch einmal: kein Eintrag.
        ok(put("/api/v1/orte/" + verwaltung, token, ah.tenant, Map.of("name", "Verwaltung",
                "kurzzeichen", "G-3", "nutzung", List.of("buero", "sozialraeume"), "baujahr", 2004,
                "notiz", "Kantine im EG")));
        assertThat(protokoll(ah.tenant, verwaltung)).hasSize(vorher + 1);

        // Ein eigenes Kurzzeichen ist erlaubt, wenn es frei ist; das alte bleibt für immer belegt (E8).
        JsonNode umbenannt = ok(put("/api/v1/orte/" + verwaltung, token, ah.tenant, Map.of(
                "name", "Verwaltung", "kurzzeichen", "VW", "nutzung", List.of("buero", "sozialraeume"),
                "baujahr", 2004, "notiz", "Kantine im EG")));
        assertThat(umbenannt.path("kurzzeichen").asText()).isEqualTo("VW");
        abgelehnt(post("/api/v1/standorte/" + ah.ids.get("ST-1") + "/orte", token, ah.tenant,
                Map.of("art", "gebaeude", "name", "Halle 4", "kurzzeichen", "G-3")),
                HttpStatus.CONFLICT, "kurzzeichen_belegt");

        // Woran ein Ort hängt, ändert das Verschieben (IP-12) — nicht PUT.
        JsonNode eltern = abgelehnt(put("/api/v1/orte/" + verwaltung, token, ah.tenant, Map.of(
                "name", "Verwaltung", "kurzzeichen", "VW", "elternId", ah.ids.get("ST-2").toString())),
                HttpStatus.BAD_REQUEST, "anfrage_ungueltig");
        assertThat(eltern.path("feld").asText()).isEqualTo("elternId");
        // Baujahr bis zum laufenden Jahr (in der Zeitzone des Standorts).
        abgelehnt(put("/api/v1/orte/" + verwaltung, token, ah.tenant, Map.of("name", "Verwaltung",
                "kurzzeichen", "VW", "baujahr", 2027)), HttpStatus.BAD_REQUEST, "anfrage_ungueltig");
        assertThat(protokoll(ah.tenant, verwaltung)).hasSize(vorher + 2);
    }

    // ------------------------------------------------------------------ Hilfen

    /** Der gesäte Kundenbereich: Kennzeichen der Referenz → ID, und die Antwort je angelegtem Ort. */
    private record Ahrenberg(String tenant, Map<String, UUID> ids, Map<String, JsonNode> antworten) {}

    /**
     * Das Referenzunternehmen: die Standorte ST-1/ST-2 über das Repository gesät (ihre
     * Schreibroute ist IP-4; ST-1 besteht seit der Bestandsanlage, 12.03.2024), dann jeder
     * Ort über die ROUTE — am 01.10.2026 die von Werk Ahrenberg, am 15.10.2026 die von Werk
     * Lindach, jeder mit seinem „gültig ab“ aus den Zuordnungen der Referenz. Beginnt die
     * Fläche nach dem ersten Tag (G-1, G-3), wird sie danach über {@code …/flaeche} eingetragen.
     */
    private Ahrenberg ahrenberg(String token) throws Exception {
        JsonNode ref = referenz();
        String tenant = neuerKundenbereich(token, ref.path("unternehmen").path("name").asText());
        Map<String, UUID> ids = new LinkedHashMap<>();
        Map<String, JsonNode> antworten = new LinkedHashMap<>();
        Map<String, LocalDate> ab = new LinkedHashMap<>();
        for (JsonNode z : ref.path("zuordnungen")) {
            if ("ort_eltern".equals(z.path("art").asText())) {
                ab.put(z.path("von").asText(), LocalDate.parse(z.path("gueltig_ab").asText()));
            }
        }
        for (JsonNode s : ref.path("standorte")) {
            String kz = s.path("kennzeichen").asText();
            ids.put(kz, standort(tenant, s.path("name").asText(), kz, s.path("zeitzone").asText(), ab.get(kz)));
            for (JsonNode f : s.path("bezugsflaechen")) {
                alsMandant(tenant, () -> admin.update("INSERT INTO flaeche_gueltigkeit (tenant_id, standort_id, "
                        + "m2, gueltig_ab) VALUES (?::uuid, ?, ?, ?)", tenant, ids.get(kz),
                        f.path("flaeche_m2").asInt(), LocalDate.parse(f.path("gueltig_ab").asText())));
            }
        }
        for (String werk : List.of("ST-1", "ST-2")) {
            uhr("ST-1".equals(werk) ? "2026-10-01T09:12:00+02:00" : "2026-10-15T10:05:00+02:00");
            for (JsonNode g : ref.path("gebaeude")) {
                if (!werk.equals(g.path("standort").asText())) {
                    continue;
                }
                String kz = g.path("kennzeichen").asText();
                JsonNode erste = g.path("bezugsflaechen").get(0);
                boolean flaecheAmErstenTag = ab.get(kz).toString().equals(erste.path("gueltig_ab").asText());
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("art", "gebaeude");
                body.put("name", g.path("name").asText());
                body.put("gueltigAb", ab.get(kz).toString());
                body.put("nutzung", nutzung(g.path("nutzung")));
                body.put("baujahr", g.path("baujahr").asInt());
                if (flaecheAmErstenTag) {
                    body.put("flaecheM2", erste.path("flaeche_m2").asInt());
                }
                JsonNode o = created(post("/api/v1/standorte/" + ids.get(werk) + "/orte", token, tenant, body));
                ids.put(kz, UUID.fromString(o.path("id").asText()));
                antworten.put(kz, o);
                if (!flaecheAmErstenTag) {
                    ok(put("/api/v1/orte/" + o.path("id").asText() + "/flaeche", token, tenant,
                            Map.of("m2", erste.path("flaeche_m2").asInt(),
                                    "gueltigAb", erste.path("gueltig_ab").asText())));
                }
            }
            for (JsonNode b : ref.path("bereiche")) {
                String eltern = b.path("eltern").asText();
                if (!ids.containsKey(eltern) || antworten.containsKey(b.path("kennzeichen").asText())) {
                    continue;
                }
                String kz = b.path("kennzeichen").asText();
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("art", "bereich");
                body.put("name", b.path("name").asText());
                body.put("elternId", ids.get(eltern).toString());
                body.put("gueltigAb", ab.get(kz).toString());
                body.put("nutzung", nutzung(b.path("nutzung")));
                body.put("notiz", b.path("beschreibung").asText());
                JsonNode o = created(post("/api/v1/standorte/" + ids.get(werk) + "/orte", token, tenant, body));
                ids.put(kz, UUID.fromString(o.path("id").asText()));
                antworten.put(kz, o);
            }
        }
        return new Ahrenberg(tenant, ids, antworten);
    }

    /** Ein Standort über das Repository (die Schreibroute ist IP-4) — er besteht ab {@code seit}. */
    private UUID standort(String tenant, String name, String kurzzeichen, String zeitzone, LocalDate seit) {
        return alsMandant(tenant, () -> {
            UUID un = unternehmen.desKundenbereichs().orElseThrow().id();
            UUID st = standorte.anlegen(new StandortRepository.NeuerStandort(UUID.fromString(tenant), un,
                    name, kurzzeichen, null, null, null, null, zeitzone, null, null, null, null, "aktiv",
                    "test"));
            app.update("UPDATE standort SET created_at = ? WHERE id = ?",
                    Timestamp.from(seit.atStartOfDay(ZoneId.of(zeitzone)).toInstant()), st);
            return st;
        });
    }

    private void uhr(String zeitpunkt) {
        orte.uhrStellen(Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), BERLIN));
    }

    private Integer flaecheAm(String token, Ahrenberg ah, String werk, String gebaeude, String tag) {
        JsonNode baum = ok(get("/api/v1/standorte/" + ah.ids.get(werk) + "/orte?stichtag=" + tag, token,
                ah.tenant));
        for (JsonNode g : baum.path("gebaeude")) {
            if (gebaeude.equals(g.path("kurzzeichen").asText())) {
                return g.path("flaecheM2").isNull() ? null : g.path("flaecheM2").asInt();
            }
        }
        throw new AssertionError(gebaeude + " fehlt am " + tag);
    }

    private List<Map<String, Object>> protokoll(String tenant, UUID objekt) {
        return admin.queryForList("SELECT art, gilt_ab, rueckwirkend, akteur_sub, akteur_name, "
                + "alt::text AS alt, neu::text AS neu FROM ort_aenderung WHERE tenant_id = ?::uuid "
                + "AND objekt_id = ? ORDER BY id", tenant, objekt);
    }

    private long alleEintraege(String tenant) {
        return admin.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?::uuid",
                Long.class, tenant);
    }

    private static JsonNode referenz() throws Exception {
        return MAPPER.readTree(Files.readString(REFERENZ));
    }

    private static JsonNode referenzGebaeude(String kz) throws Exception {
        for (JsonNode g : referenz().path("gebaeude")) {
            if (kz.equals(g.path("kennzeichen").asText())) {
                return g;
            }
        }
        throw new AssertionError(kz + " fehlt in der Referenz");
    }

    private static String abzeichenDerZuordnung(JsonNode ref, String kz) {
        for (JsonNode z : ref.path("zuordnungen")) {
            if ("ort_eltern".equals(z.path("art").asText()) && kz.equals(z.path("von").asText())) {
                return z.path("abzeichen").asText();
            }
        }
        throw new AssertionError(kz + " ohne Zuordnung in der Referenz");
    }

    private static List<String> nutzung(JsonNode worte) {
        List<String> out = new ArrayList<>();
        worte.forEach(w -> out.add(NUTZUNG.get(w.asText())));
        return out;
    }

    private static List<String> kurzzeichen(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.path("kurzzeichen").asText()));
        return out;
    }

    private static List<String> feldnamen(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.fieldNames().forEachRemaining(out::add);
        return out;
    }

    /** Schreibt unter RLS als dieser Mandant — derselbe Zaun wie jede Kunden-Route. */
    private static <T> T alsMandant(String tenant, Callable<T> arbeit) {
        TenantContext.set(UUID.fromString(tenant));
        try {
            return arbeit.call();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        } finally {
            TenantContext.clear();
        }
    }

    private String neuerKundenbereich(String token, String name) {
        ResponseEntity<JsonNode> r = exchange("/api/v1/admin/tenants", HttpMethod.POST, token, null,
                Map.of("name", name));
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return r.getBody().path("id").asText();
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode()).as("Antwort %s", r.getBody()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    private static JsonNode created(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode()).as("Antwort %s", r.getBody()).isEqualTo(HttpStatus.CREATED);
        assertThat(r.getHeaders().getLocation().toString())
                .isEqualTo("/api/v1/orte/" + r.getBody().path("id").asText());
        return r.getBody();
    }

    private static JsonNode abgelehnt(ResponseEntity<JsonNode> r, HttpStatus status, String code) {
        assertThat(r.getStatusCode()).as("Antwort %s", r.getBody()).isEqualTo(status);
        assertThat(r.getBody().path("code").asText()).as("Antwort %s", r.getBody()).isEqualTo(code);
        assertThat(r.getBody().path("message").asText()).isNotBlank();
        return r.getBody();
    }

    private ResponseEntity<JsonNode> get(String path, String token, String tenant) {
        return exchange(path, HttpMethod.GET, token, tenant, null);
    }

    private ResponseEntity<JsonNode> post(String path, String token, String tenant, Object body) {
        return exchange(path, HttpMethod.POST, token, tenant, body);
    }

    private ResponseEntity<JsonNode> put(String path, String token, String tenant, Object body) {
        return exchange(path, HttpMethod.PUT, token, tenant, body);
    }

    private ResponseEntity<JsonNode> exchange(String path, HttpMethod method, String token, String tenant,
            Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (tenant != null) {
            headers.set("X-Tenant-Id", tenant);
        }
        HttpEntity<?> entity = body != null ? new HttpEntity<>(body, headers) : new HttpEntity<>(headers);
        return rest.exchange("http://localhost:" + port + path, method, entity,
                new ParameterizedTypeReference<JsonNode>() {
                });
    }

    /** Die Ansprüche im Token — {@code sub} ist je Keycloak-Container neu. */
    private static JsonNode anspruch(String token) throws Exception {
        String nutzlast = token.split("\\.")[1];
        return MAPPER.readTree(new String(Base64.getUrlDecoder().decode(nutzlast), StandardCharsets.UTF_8));
    }

    private String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
