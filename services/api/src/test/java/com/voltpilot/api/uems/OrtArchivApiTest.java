package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Intervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ObjektZustand;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
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
 * Archivieren, Wiederherstellen und Löschen von Gebäuden und Bereichen über die Routen (UEMS AP-02
 * IP-15) — die Abnahmefälle des Reports, Namen, Kurzzeichen und Tage nur aus dem
 * Referenzunternehmen (Fassung 1.1) und den Vektor-Fällen der Familie {@code archiv}:
 *
 * <ol>
 *   <li>A7: Montagehalle Lindach (G-5) mit aktiver MS-18 — 409 {@code archivieren_gesperrt} mit dem
 *       Satz des Vertrags (Grund UND Weg), und derselbe Satz steht VORHER in {@code aktionen} des
 *       Ortsbaums; nichts ist geschrieben. Ist MS-18 angehalten, geht es, und B-7 geht leer mit.</li>
 *   <li>A8: Halle 2 Lager (B-5) nach dem Umzug von MS-13 — archiviert am 30.06.2027 (Intervall bis
 *       29.06.2027), Grabstein heute und in „Stand am 15.07.2027“, normal am 15.05.2027; ein neuer
 *       Bereich darf wieder „Halle 2 Lager“ heißen, bekommt aber nie B-5; Wiederherstellen am
 *       01.02.2028 stößt auf den Namen (409 mit Verweis), umbenannt geht es — neues Intervall, die
 *       Lücke bleibt.</li>
 *   <li>A9: „Halle 2 Test“ ohne Historie wird gelöscht (204, das Kurzzeichen bleibt belegt, Halle 2
 *       trägt „geloescht“); Halle 1 mit Messstelle, Fläche und Bereich ist 409 — auch die Datenbank
 *       löscht sie am Schreibweg vorbei nicht; ein fremder Kundenbereich bekommt 404.</li>
 * </ol>
 *
 * <p>Die Messstellen am Ort liegen im Haken {@link OrtsbaumMessstellen} (wie im
 * {@code StandortApiTest}); die Regeln selbst beweist {@code OrtsbaumAbleitungVectorsTest}.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class OrtArchivApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VEKTOREN = Path.of("..", "..", "docs", "contracts", "v2", "ortsbaum-vectors.json");

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

    /** Die Messstellen am Ort, wie die Fälle sie brauchen (Eltern = Kurzzeichen). */
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

    private static JsonNode vektoren;

    @BeforeAll
    static void ladeVertrag() throws Exception {
        vektoren = MAPPER.readTree(Files.readString(VEKTOREN));
    }

    @AfterEach
    void zurueck() {
        MESSSTELLEN.clear();
        orte.uhrStellen(Clock.systemUTC());
    }

    // ------------------------------------------------------------------- A7

    @Test
    void a7ArchivierenAbgelehntNenntGrundUndWegVorherImBaumUndSchreibtNichts() throws Exception {
        String token = token("admin", "admin");
        String t = neuerKundenbereich(token, "A7 Kunststoffwerk Ahrenberg");
        UUID lindach = standort(t, "Werk Lindach", "ST-2", LocalDate.parse("2026-10-15"));
        uhr("2026-10-15T10:05:00+02:00");
        UUID g5 = ort(token, t, lindach, "gebaeude", "Montagehalle Lindach", "G-5", null, "2026-10-15", null);
        UUID b7 = ort(token, t, lindach, "bereich", "Montage Lindach", "B-7", g5, "2026-10-15", null);
        MESSSTELLEN.add(messstelle("MS-18", "Montagehalle Lindach gesamt", ObjektZustand.AKTIV,
                new Intervall(LocalDate.parse("2026-10-15"), null, "G-5")));
        JsonNode fall = fall("a7-sperre-sagt-aktiv-nicht-liefert-daten");
        String satz = fall.at("/expected/text").asText();
        uhr(fall.at("/input/tag").asText() + "T10:00:00+02:00");

        // Das Menü weiß es, BEVOR jemand drückt: derselbe Satz steht im Ortsbaum.
        JsonNode vorher = gebaeude(ok(get(orte(lindach), token, t)), "G-5").path("aktionen");
        assertThat(vorher.at("/archivieren/erlaubt").asBoolean()).isFalse();
        assertThat(vorher.at("/archivieren/text").asText()).isEqualTo(satz);
        assertThat(vorher.at("/archivieren/gruende/0/weg").asText()).isEqualTo("messstelle_umziehen");

        long eintraege = alleEintraege(t);
        JsonNode r = abgelehnt(post("/api/v1/orte/" + g5 + "/archivieren", token, t, null),
                HttpStatus.CONFLICT, "archivieren_gesperrt");
        assertThat(r.path("message").asText()).isEqualTo(satz);
        assertThat(r.path("gruende")).hasSize(1);
        JsonNode grund = r.path("gruende").get(0);
        assertThat(grund.path("art").asText()).isEqualTo("messstelle_aktiv");
        assertThat(grund.path("objekt").asText()).isEqualTo("messstelle");
        assertThat(grund.path("kennzeichen").asText()).isEqualTo("MS-18");
        assertThat(grund.path("name").asText()).isEqualTo(fall.at("/expected/gruende/0/name").asText());
        assertThat(grund.path("weg").asText()).isEqualTo("messstelle_umziehen");
        // Nichts ist geschrieben: kein Eintrag, der Ort aktiv, sein Intervall offen.
        assertThat(alleEintraege(t)).isEqualTo(eintraege);
        assertThat(zustand(t, g5)).isEqualTo("aktiv");
        assertThat(offeneIntervalle(t, g5)).isEqualTo(1);

        // Liefert MS-18 nicht mehr (angehalten), ist Archivieren erlaubt — B-7 ist leer und geht mit.
        MESSSTELLEN.replaceAll(m -> new OrtsbaumAbleitung.Messstelle(m.kennzeichen(), m.name(), m.anlage(),
                ObjektZustand.ANGEHALTEN, m.zuordnungen()));
        JsonNode frei = gebaeude(ok(get(orte(lindach), token, t)), "G-5").path("aktionen").path("archivieren");
        assertThat(frei.path("erlaubt").asBoolean()).isTrue();
        assertThat(frei.path("letzterTag").asText()).isEqualTo("2026-10-19");
        assertThat(kurzzeichen(frei.path("mitarchiviert"))).containsExactly("B-7");
        JsonNode archiviert = ok(post("/api/v1/orte/" + g5 + "/archivieren", token, t, null));
        assertThat(archiviert.path("zustand").asText()).isEqualTo("archiviert");
        assertThat(zustand(t, b7)).isEqualTo("archiviert");
        assertThat(alleEintraege(t)).isEqualTo(eintraege + 1);
        JsonNode neu = MAPPER.readTree((String) letzterEintrag(t, g5).get("neu"));
        assertThat(kurzzeichen(neu.path("mitarchiviert"))).containsExactly("B-7");
    }

    // ------------------------------------------------------------------- A8

    @Test
    void a8Halle2LagerArchivierenGrabsteinNeuerNameUndWiederherstellenMitSichtbarerLuecke() throws Exception {
        String token = token("admin", "admin");
        String t = neuerKundenbereich(token, "A8 Kunststoffwerk Ahrenberg");
        UUID ahrenberg = standort(t, "Werk Ahrenberg", "ST-1", LocalDate.parse("2024-03-12"));
        uhr("2026-10-01T09:12:00+02:00");
        UUID g2 = ort(token, t, ahrenberg, "gebaeude", "Halle 2", "G-2", null, "2026-10-01", null);
        ort(token, t, ahrenberg, "bereich", "Halle 2 Montage", "B-3", g2, "2026-10-01", null);
        UUID b5 = ort(token, t, ahrenberg, "bereich", "Halle 2 Lager", "B-5", g2, "2026-10-01", null);
        // MS-13 zieht am 01.06.2027 nach Halle 2 Montage (AP-04): B-5 trägt Historie, aber keine aktive Messstelle.
        MESSSTELLEN.add(messstelle("MS-13", "Lager Halle 2 (Allgemein)", ObjektZustand.AKTIV,
                new Intervall(LocalDate.parse("2026-10-01"), LocalDate.parse("2027-05-31"), "B-5"),
                new Intervall(LocalDate.parse("2027-06-01"), null, "B-3")));

        uhr("2027-06-30T10:00:00+02:00");
        JsonNode aktionen = bereich(ok(get(orte(ahrenberg), token, t)), "G-2", "B-5").path("aktionen");
        JsonNode soll = fall("a8-bereich-ohne-aktive-messstelle").path("expected");
        assertThat(aktionen.at("/archivieren/erlaubt").asBoolean()).isEqualTo(soll.path("erlaubt").asBoolean());
        assertThat(aktionen.at("/archivieren/letzterTag").asText())
                .isEqualTo(soll.at("/archiviert/0/letzter_tag").asText());
        // „je heißt je“: MS-13 hing bis 31.05.2027 hier — kein Löschen, nur Archivieren.
        assertThat(aktionen.at("/loeschen/erlaubt").asBoolean()).isFalse();
        assertThat(texte(aktionen.at("/loeschen/gruende"))).containsExactlyElementsOf(
                texte(fall("je-heisst-je").at("/expected/gruende")));

        long eintraege = alleEintraege(t);
        JsonNode archiviert = ok(post("/api/v1/orte/" + b5 + "/archivieren", token, t, null));
        assertThat(archiviert.path("zustand").asText()).isEqualTo("archiviert");
        assertThat(archiviert.path("zuordnungen")).hasSize(1);
        assertThat(archiviert.at("/zuordnungen/0/gueltigBis").asText()).isEqualTo("2027-06-29");
        assertThat(alleEintraege(t)).isEqualTo(eintraege + 1);
        Map<String, Object> eintrag = letzterEintrag(t, b5);
        assertThat(eintrag.get("art")).isEqualTo("archiviert");
        assertThat(MAPPER.readTree((String) eintrag.get("neu")).path("letzter_tag").asText()).isEqualTo("2027-06-29");

        // Grabstein heute: B-5 fehlt unter Halle 2 und steht mit dem Archivtag da.
        JsonNode heute = ok(get(orte(ahrenberg), token, t));
        assertThat(kurzzeichen(gebaeude(heute, "G-2").path("bereiche"))).containsExactly("B-3");
        JsonNode stein = archiviertIn(heute, "B-5");
        assertThat(stein.path("archiviertAm").asText()).isEqualTo("2027-06-30");
        assertThat(stein.path("elternId").asText()).isEqualTo(g2.toString());
        assertThat(stein.path("elternArt").asText()).isEqualTo("gebaeude");
        assertThat(stein.at("/aktionen/wiederherstellen/erlaubt").asBoolean()).isTrue();
        assertThat(stein.at("/aktionen/loeschen/erlaubt").asBoolean()).isFalse();
        // „Stand am 15.07.2027“ zeigt B-5 nicht im Baum, aber als Grabstein — ohne Schreibweg.
        JsonNode juli = ok(get(orte(ahrenberg) + "?stichtag=2027-07-15", token, t));
        assertThat(kurzzeichen(gebaeude(juli, "G-2").path("bereiche"))).doesNotContain("B-5");
        assertThat(archiviertIn(juli, "B-5").path("archiviertAm").asText()).isEqualTo("2027-06-30");
        assertThat(archiviertIn(juli, "B-5").path("aktionen").isNull()).isTrue();
        assertThat(juli.path("aktionen").isNull()).isTrue();
        // „Stand am 15.05.2027“ zeigt ihn, wie er war.
        JsonNode mai = ok(get(orte(ahrenberg) + "?stichtag=2027-05-15", token, t));
        assertThat(kurzzeichen(gebaeude(mai, "G-2").path("bereiche"))).containsExactly("B-3", "B-5");
        assertThat(mai.path("archiviert")).isEmpty();

        // A10: ein neuer Bereich darf wieder „Halle 2 Lager“ heißen — das Kurzzeichen B-5 bekommt er nie.
        uhr("2027-07-10T10:00:00+02:00");
        JsonNode nachfolger = created(post("/api/v1/standorte/" + ahrenberg + "/orte", token, t,
                Map.of("art", "bereich", "name", "Halle 2 Lager", "elternId", g2.toString())));
        assertThat(nachfolger.path("kurzzeichen").asText()).startsWith("B-").isNotEqualTo("B-5");

        // 01.02.2028: der Name ist inzwischen vergeben — 409 mit Verweis, nichts geschrieben.
        uhr("2028-02-01T09:00:00+01:00");
        JsonNode stein2 = archiviertIn(ok(get(orte(ahrenberg), token, t)), "B-5");
        assertThat(stein2.at("/aktionen/wiederherstellen/erlaubt").asBoolean()).isFalse();
        assertThat(stein2.at("/aktionen/wiederherstellen/grund").asText()).isEqualTo("name_belegt");
        long vorWieder = alleEintraege(t);
        JsonNode belegt = abgelehnt(post("/api/v1/orte/" + b5 + "/wiederherstellen", token, t, null),
                HttpStatus.CONFLICT, "wiederherstellen_gesperrt");
        assertThat(belegt.path("grund").asText()).isEqualTo("name_belegt");
        assertThat(belegt.at("/verweis/kurzzeichen").asText()).isEqualTo(nachfolger.path("kurzzeichen").asText());
        assertThat(alleEintraege(t)).isEqualTo(vorWieder);

        // Umbenannt im selben Dialog: ein NEUES Intervall ab 01.02.2028, die Lücke bleibt.
        JsonNode zurueck = ok(post("/api/v1/orte/" + b5 + "/wiederherstellen", token, t,
                Map.of("name", "Halle 2 Altlager")));
        assertThat(zurueck.path("zustand").asText()).isEqualTo("aktiv");
        assertThat(zurueck.path("kurzzeichen").asText()).isEqualTo("B-5");
        assertThat(zurueck.path("name").asText()).isEqualTo("Halle 2 Altlager");
        JsonNode soll8 = fall("a8-wiederherstellen").path("expected");
        assertThat(zurueck.path("zuordnungen")).hasSize(2);
        assertThat(zurueck.at("/zuordnungen/0/gueltigBis").asText()).isEqualTo("2027-06-29");
        assertThat(zurueck.at("/zuordnungen/1/gueltigAb").asText()).isEqualTo(soll8.at("/intervall/ab").asText());
        assertThat(zurueck.at("/zuordnungen/1/gueltigBis").isNull()).isTrue();
        assertThat(zurueck.at("/zuordnungen/1/elternId").asText()).isEqualTo(g2.toString());
        assertThat(alleEintraege(t)).isEqualTo(vorWieder + 1);
        Map<String, Object> w = letzterEintrag(t, b5);
        assertThat(w.get("art")).isEqualTo("wiederhergestellt");
        JsonNode luecke = MAPPER.readTree((String) w.get("neu")).path("luecke");
        assertThat(luecke.path("von").asText()).isEqualTo(soll8.at("/luecke/von").asText());
        assertThat(luecke.path("bis").asText()).isEqualTo(soll8.at("/luecke/bis").asText());
        // Die Lücke ist sichtbar und wird nie aufgefüllt.
        assertThat(archiviertIn(ok(get(orte(ahrenberg) + "?stichtag=2027-12-01", token, t)), "B-5")
                .path("archiviertAm").asText()).isEqualTo("2027-06-30");
        JsonNode feb = ok(get(orte(ahrenberg), token, t));
        assertThat(kurzzeichen(gebaeude(feb, "G-2").path("bereiche"))).contains("B-5");
        assertThat(feb.path("archiviert")).isEmpty();
    }

    // ------------------------------------------------------------------- A9

    @Test
    void a9LoeschenNurOhneHistorieSonst409UndDasKurzzeichenBleibtBelegt() throws Exception {
        String token = token("admin", "admin");
        String t = neuerKundenbereich(token, "A9 Kunststoffwerk Ahrenberg");
        UUID ahrenberg = standort(t, "Werk Ahrenberg", "ST-1", LocalDate.parse("2024-03-12"));
        uhr("2026-10-01T09:12:00+02:00");
        UUID g1 = ort(token, t, ahrenberg, "gebaeude", "Halle 1", "G-1", null, "2026-10-01", 4200);
        ort(token, t, ahrenberg, "bereich", "Halle 1 Nord", "B-1", g1, "2026-10-01", null);
        UUID g2 = ort(token, t, ahrenberg, "gebaeude", "Halle 2", "G-2", null, "2026-10-01", null);
        MESSSTELLEN.add(messstelle("MS-03", "PV-Erzeugung Dach Halle 1", ObjektZustand.AKTIV,
                new Intervall(LocalDate.parse("2026-10-01"), null, "G-1")));

        // 02.10.2026 10:00: „Halle 2 Test“ irrtümlich angelegt.
        uhr("2026-10-02T10:00:00+02:00");
        JsonNode test = created(post("/api/v1/standorte/" + ahrenberg + "/orte", token, t,
                Map.of("art", "bereich", "name", "Halle 2 Test", "elternId", g2.toString())));
        UUID irrtum = UUID.fromString(test.path("id").asText());
        String kz = test.path("kurzzeichen").asText();

        uhr("2026-10-02T10:05:00+02:00");
        JsonNode baum = ok(get(orte(ahrenberg), token, t));
        JsonNode halle1 = gebaeude(baum, "G-1").path("aktionen");
        assertThat(halle1.at("/loeschen/erlaubt").asBoolean()).isFalse();
        assertThat(texte(halle1.at("/loeschen/gruende"))).containsExactlyElementsOf(
                texte(fall("a9-halle-1-hat-historie").at("/expected/gruende")));
        assertThat(halle1.at("/loeschen/text").asText()).isEqualTo("Löschen geht nicht: Halle 1 hat Historie "
                + "(Messstellen, Fläche und Bereiche). Gelöscht wird nur, was nie etwas getragen hat — alles "
                + "andere wird archiviert.");
        // Nur Archivieren — mit Sperrgrund, solange MS-03 aktiv ist.
        assertThat(halle1.at("/archivieren/erlaubt").asBoolean()).isFalse();
        assertThat(halle1.at("/archivieren/text").asText()).contains("MS-03");
        JsonNode irrtumAktionen = bereich(baum, "G-2", kz).path("aktionen");
        assertThat(irrtumAktionen.at("/loeschen/erlaubt").asBoolean())
                .isEqualTo(fall("a9-irrtum-ohne-historie").at("/expected/erlaubt").asBoolean())
                .isTrue();
        assertThat(irrtumAktionen.at("/loeschen/gruende")).isEmpty();

        long eintraege = alleEintraege(t);
        JsonNode nein = abgelehnt(exchange("/api/v1/orte/" + g1, HttpMethod.DELETE, token, t, null),
                HttpStatus.CONFLICT, "loeschen_gesperrt");
        assertThat(texte(nein.path("historie"))).containsExactly("hat_messstellen", "hat_flaeche", "hat_kinder");
        assertThat(nein.path("message").asText()).isEqualTo(halle1.at("/loeschen/text").asText());
        assertThat(anzahlOrte(t, g1)).isEqualTo(1);
        assertThat(alleEintraege(t)).isEqualTo(eintraege);
        // Die Rückwand: auch am Schreibweg vorbei löscht die Datenbank Halle 1 nicht.
        assertThatThrownBy(() -> alsMandant(t,
                () -> app.queryForObject("SELECT uems_ort_loeschen(?)", Boolean.class, g1)))
                .hasStackTraceContaining("traegt Historie");
        assertThat(anzahlOrte(t, g1)).isEqualTo(1);

        // „Halle 2 Test“: nach Rückfrage endgültig weg.
        ResponseEntity<JsonNode> weg = exchange("/api/v1/orte/" + irrtum, HttpMethod.DELETE, token, t, null);
        assertThat(weg.getStatusCode()).as("Antwort %s", weg.getBody()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(anzahlOrte(t, irrtum)).isZero();
        assertThat(admin.queryForObject("SELECT count(*) FROM ort_zuordnung WHERE tenant_id = ?::uuid "
                + "AND ort_id = ?", Long.class, t, irrtum)).isZero();
        // Das Kurzzeichen bleibt belegt — es wird nie wiederverwendet.
        assertThat(admin.queryForObject("SELECT count(*) FROM ort_kurzzeichen WHERE tenant_id = ?::uuid "
                + "AND kurzzeichen = ?", Long.class, t, kz)).isEqualTo(1);
        // GENAU EIN Eintrag, am Elternknoten: „Bereich Halle 2 Test gelöscht“; der eigene bleibt stehen.
        assertThat(alleEintraege(t)).isEqualTo(eintraege + 1);
        Map<String, Object> amEltern = letzterEintrag(t, g2);
        assertThat(amEltern.get("art")).isEqualTo("geloescht");
        JsonNode alt = MAPPER.readTree((String) amEltern.get("alt"));
        assertThat(alt.path("art").asText()).isEqualTo("bereich");
        assertThat(alt.path("name").asText()).isEqualTo("Halle 2 Test");
        assertThat(alt.path("kurzzeichen").asText()).isEqualTo(kz);
        assertThat(protokoll(t, irrtum)).extracting(m -> m.get("art")).containsExactly("angelegt");
        assertThat(kurzzeichen(gebaeude(ok(get(orte(ahrenberg), token, t)), "G-2").path("bereiche"))).isEmpty();

        // Weg ist weg (404); ein neuer „Halle 2 Test“ bekommt ein neues Kurzzeichen.
        abgelehnt(exchange("/api/v1/orte/" + irrtum, HttpMethod.DELETE, token, t, null),
                HttpStatus.NOT_FOUND, "nicht_gefunden");
        JsonNode nochmal = created(post("/api/v1/standorte/" + ahrenberg + "/orte", token, t,
                Map.of("art", "bereich", "name", "Halle 2 Test", "elternId", g2.toString())));
        assertThat(nochmal.path("kurzzeichen").asText()).isNotEqualTo(kz);

        // Ein fremder Kundenbereich sieht den Ort nicht: 404, nie 403 — und nichts ist gelöscht.
        String fremd = neuerKundenbereich(token, "A9 fremd");
        UUID zweiter = UUID.fromString(nochmal.path("id").asText());
        abgelehnt(exchange("/api/v1/orte/" + zweiter, HttpMethod.DELETE, token, fremd, null),
                HttpStatus.NOT_FOUND, "nicht_gefunden");
        abgelehnt(post("/api/v1/orte/" + zweiter + "/archivieren", token, fremd, null),
                HttpStatus.NOT_FOUND, "nicht_gefunden");
        assertThat(anzahlOrte(t, zweiter)).isEqualTo(1);
    }

    // ---------------------------------------------------------------- Gerüst

    private static JsonNode fall(String name) {
        for (JsonNode c : vektoren.path("cases")) {
            if (name.equals(c.path("name").asText())) {
                return c;
            }
        }
        throw new AssertionError("Vektor-Fall fehlt: " + name);
    }

    private static OrtsbaumAbleitung.Messstelle messstelle(String kz, String name, ObjektZustand zustand,
            Intervall... zuordnungen) {
        return new OrtsbaumAbleitung.Messstelle(kz, name, null, zustand, List.of(zuordnungen));
    }

    private UUID ort(String token, String tenant, UUID standort, String art, String name, String kz, UUID eltern,
            String ab, Integer m2) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("art", art);
        body.put("name", name);
        body.put("kurzzeichen", kz);
        body.put("gueltigAb", ab);
        if (eltern != null) {
            body.put("elternId", eltern.toString());
        }
        if (m2 != null) {
            body.put("flaecheM2", m2);
        }
        return UUID.fromString(created(post("/api/v1/standorte/" + standort + "/orte", token, tenant, body))
                .path("id").asText());
    }

    /** Ein Standort über das Repository (seine Schreibroute ist IP-4) — er besteht ab {@code seit}. */
    private UUID standort(String tenant, String name, String kurzzeichen, LocalDate seit) {
        return alsMandant(tenant, () -> {
            UUID un = unternehmen.desKundenbereichs().orElseThrow().id();
            UUID st = standorte.anlegen(new StandortRepository.NeuerStandort(UUID.fromString(tenant), un,
                    name, kurzzeichen, null, null, null, null, "Europe/Berlin", null, null, null, null, "aktiv",
                    "test"));
            app.update("UPDATE standort SET created_at = ? WHERE id = ?",
                    Timestamp.from(seit.atStartOfDay(BERLIN).toInstant()), st);
            return st;
        });
    }

    private void uhr(String zeitpunkt) {
        orte.uhrStellen(Clock.fixed(OffsetDateTime.parse(zeitpunkt).toInstant(), BERLIN));
    }

    private static String orte(UUID standort) {
        return "/api/v1/standorte/" + standort + "/orte";
    }

    private static JsonNode gebaeude(JsonNode baum, String kz) {
        for (JsonNode g : baum.path("gebaeude")) {
            if (kz.equals(g.path("kurzzeichen").asText())) {
                return g;
            }
        }
        throw new AssertionError(kz + " fehlt im Ortsbaum " + baum);
    }

    private static JsonNode bereich(JsonNode baum, String gebaeude, String kz) {
        for (JsonNode b : gebaeude(baum, gebaeude).path("bereiche")) {
            if (kz.equals(b.path("kurzzeichen").asText())) {
                return b;
            }
        }
        throw new AssertionError(kz + " fehlt unter " + gebaeude);
    }

    private static JsonNode archiviertIn(JsonNode baum, String kz) {
        for (JsonNode a : baum.path("archiviert")) {
            if (kz.equals(a.path("kurzzeichen").asText())) {
                return a;
            }
        }
        throw new AssertionError(kz + " fehlt unter den archivierten " + baum.path("archiviert"));
    }

    private static List<String> kurzzeichen(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.path("kurzzeichen").asText()));
        return out;
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.asText()));
        return out;
    }

    private String zustand(String tenant, UUID ort) {
        return admin.queryForObject("SELECT zustand FROM ort WHERE tenant_id = ?::uuid AND id = ?",
                String.class, tenant, ort);
    }

    private long anzahlOrte(String tenant, UUID ort) {
        return admin.queryForObject("SELECT count(*) FROM ort WHERE tenant_id = ?::uuid AND id = ?",
                Long.class, tenant, ort);
    }

    private long offeneIntervalle(String tenant, UUID ort) {
        return admin.queryForObject("SELECT count(*) FROM ort_zuordnung WHERE tenant_id = ?::uuid AND ort_id = ? "
                + "AND gueltig_bis IS NULL AND aufgehoben_am IS NULL", Long.class, tenant, ort);
    }

    private List<Map<String, Object>> protokoll(String tenant, UUID objekt) {
        return admin.queryForList("SELECT art, gilt_ab, alt::text AS alt, neu::text AS neu FROM ort_aenderung "
                + "WHERE tenant_id = ?::uuid AND objekt_id = ? ORDER BY id", tenant, objekt);
    }

    private Map<String, Object> letzterEintrag(String tenant, UUID objekt) {
        List<Map<String, Object>> alle = protokoll(tenant, objekt);
        assertThat(alle).as("Protokoll von %s", objekt).isNotEmpty();
        return alle.get(alle.size() - 1);
    }

    private long alleEintraege(String tenant) {
        return admin.queryForObject("SELECT count(*) FROM ort_aenderung WHERE tenant_id = ?::uuid",
                Long.class, tenant);
    }

    /** Unter RLS als dieser Mandant — derselbe Zaun wie jede Kunden-Route. */
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
