package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.KostenstelleProzessAbgelehnt.Ablehnung;
import com.voltpilot.api.zugriff.ZugriffContext;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Kostenstellen- und Prozess-Schnittstelle (UEMS AP-10 IP-7) gegen die echte Kette:
 * {@code /api/v1/unternehmen/kostenstellen}, {@code /api/v1/unternehmen/prozesse} und
 * {@code /api/v1/messstellen/{id}/prozesse}. Die Kennzeichen und Tage stammen aus dem
 * Referenzunternehmen Ahrenberg.
 *
 * <p>Geprüft: eine Ebene; beenden statt löschen — und die Ablehnung bei einer bestehenden Zuordnung
 * nennt ihren Grund und schreibt nichts; eine Zuordnung endet mit ihrem Prozess; der Satz ab Tag;
 * der Mandantenzaun (fremd = 404, nie 403); jede Ablehnung spricht den Satz ihres Codes.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class KostenstelleProzessApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Path REFERENZ = Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final String KST = "/api/v1/unternehmen/kostenstellen";
    private static final String PRZ = "/api/v1/unternehmen/prozesse";

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

    @Autowired
    MockMvc mvc;

    @Autowired
    KostenstelleProzessService dienst;

    private static JdbcTemplate root;
    private static JsonNode referenz;
    private static final AtomicInteger NR = new AtomicInteger();

    private record Welt(UUID mandant, UUID messstelle, String kennzeichen) {}

    private record Antwort(int status, JsonNode body) {}

    private record Roh(int status, String body) {}

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        ZugriffContext.clear();
    }

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        referenz = MAPPER.readTree(REFERENZ.toFile());
    }

    // =========================================================================== Kostenstelle

    @Test
    void dieKostenstellenDesReferenzunternehmensAnlegenLesenUmbenennenBeenden() throws Exception {
        Welt w = welt();
        Map<String, UUID> ids = new LinkedHashMap<>();
        for (JsonNode k : referenz.path("kostenstellen")) {
            Map<String, Object> body = objekt(k.path("kennzeichen").asText(), k.path("name").asText(),
                    k.path("gueltig_ab").asText());
            body.put("gueltig_bis", k.path("gueltig_bis").isNull() ? null : k.path("gueltig_bis").asText());
            Antwort a = ok(ruf(w, HttpMethod.POST, KST, body), 201);
            assertThat(a.body().get("gueltig_bis").isNull()).isEqualTo(k.path("gueltig_bis").isNull());
            ids.put(k.path("kennzeichen").asText(), UUID.fromString(a.body().get("id").asText()));
        }
        assertThat(kennzeichen(ok(ruf(w, HttpMethod.GET, KST, null), 200).body().get("kostenstellen")))
                .containsExactly("4100", "4200", "4300", "9000", "9010", "9020", "9100");
        // Zum Stichtag: 2026 gilt 9000, 2027 die Nachfolger — nie beides.
        assertThat(kennzeichen(ok(ruf(w, HttpMethod.GET, KST + "?stichtag=2026-12-31", null), 200).body().get("kostenstellen")))
                .containsExactly("4100", "4200", "4300", "9000", "9100");
        assertThat(kennzeichen(ok(ruf(w, HttpMethod.GET, KST + "?stichtag=2027-01-01", null), 200).body().get("kostenstellen")))
                .containsExactly("4100", "4200", "4300", "9010", "9020", "9100");

        UUID k4300 = ids.get("4300");
        Antwort umbenannt = ok(ruf(w, HttpMethod.PUT, KST + "/" + k4300, Map.of("name", "Logistik und Versand")), 200);
        assertThat(umbenannt.body().get("name").asText()).isEqualTo("Logistik und Versand");
        assertThat(umbenannt.body().get("kennzeichen").asText()).isEqualTo("4300");

        // Beenden statt löschen: es gibt keine DELETE-Route, und die Tabelle hat keine Zeile verloren.
        assertThat(ruf(w, HttpMethod.DELETE, KST + "/" + k4300, null).status()).isEqualTo(405);
        Antwort beendet = ok(ruf(w, HttpMethod.PUT, KST + "/" + k4300 + "/beenden", Map.of("gueltig_bis", "2027-06-30")), 200);
        assertThat(beendet.body().get("gueltig_bis").asText()).isEqualTo("2027-06-30");
        // Ein Ende wird nur vorgezogen, nie hinausgeschoben.
        abgelehnt(w, HttpMethod.PUT, KST + "/" + k4300 + "/beenden", Map.of("gueltig_bis", "2027-09-30"), "bereits_beendet");
        abgelehnt(w, HttpMethod.PUT, KST + "/" + k4300 + "/beenden", Map.of("gueltig_bis", "2027-06-30"), "bereits_beendet");
        assertThat(ok(ruf(w, HttpMethod.PUT, KST + "/" + k4300 + "/beenden", Map.of("gueltig_bis", "2027-03-31")), 200)
                .body().get("gueltig_bis").asText()).isEqualTo("2027-03-31");
        abgelehnt(w, HttpMethod.PUT, KST + "/" + ids.get("4100") + "/beenden", Map.of("gueltig_bis", "2026-09-30"),
                "zeitraum_ungueltig");
        assertThat(root.queryForObject("SELECT count(*) FROM kostenstelle WHERE tenant_id = ?", Long.class, w.mandant()))
                .isEqualTo(7);

        abgelehnt(w, HttpMethod.POST, KST, objekt("9000", "Wieder", "2027-01-01"), "kennzeichen_belegt");
        abgelehnt(w, HttpMethod.POST, KST, objekt("90 00", "Leer", "2027-01-01"), "kennzeichen_format");
        Map<String, Object> flach = objekt("9030", "Unter 9000", "2027-01-01");
        flach.put("eltern_id", ids.get("9000").toString());
        abgelehntMitFeld(w, HttpMethod.POST, KST, flach, "anfrage_ungueltig", "eltern_id");
        Map<String, Object> rueckwaerts = objekt("9040", "Rückwärts", "2027-01-01");
        rueckwaerts.put("gueltig_bis", "2026-12-31");
        abgelehnt(w, HttpMethod.POST, KST, rueckwaerts, "zeitraum_ungueltig");
        abgelehntMitFeld(w, HttpMethod.POST, KST, Map.of("kennzeichen", "9050", "name", "X", "gueltigAb", "2027-01-01"),
                "anfrage_ungueltig", "gueltigAb");
        abgelehntMitFeld(w, HttpMethod.POST, KST, Map.of("kennzeichen", "9050", "name", "X", "gueltig_ab", "01.01.2027"),
                "anfrage_ungueltig", "gueltig_ab");
    }

    // ============================================================================ Prozess

    @Test
    void einProzessHatHoechstensEineEbene() throws Exception {
        Welt w = welt();
        UUID p1 = id(ok(ruf(w, HttpMethod.POST, PRZ, objekt("P-1", "Spritzguss", "2026-10-01")), 201));
        Map<String, Object> unter = objekt("P-1.1", "Spritzguss Halle 1", "2026-10-01");
        unter.put("eltern_id", p1.toString());
        Antwort kind = ok(ruf(w, HttpMethod.POST, PRZ, unter), 201);
        assertThat(kind.body().at("/eltern/kennzeichen").asText()).isEqualTo("P-1");
        assertThat(ok(ruf(w, HttpMethod.GET, PRZ + "/" + p1, null), 200).body().get("eltern").isNull()).isTrue();

        Map<String, Object> enkel = objekt("P-1.1.1", "Maschine 3", "2026-10-01");
        enkel.put("eltern_id", id(kind).toString());
        Antwort zweiteEbene = abgelehnt(w, HttpMethod.POST, PRZ, enkel, "eine_ebene");
        assertThat(zweiteEbene.body().get("eltern").asText()).isEqualTo("P-1.1");
        assertThat(zweiteEbene.body().get("eltern_von").asText()).isEqualTo("P-1");

        Map<String, Object> unbekannt = objekt("P-7", "Lackiererei", "2026-10-01");
        unbekannt.put("eltern_id", UUID.randomUUID().toString());
        abgelehnt(w, HttpMethod.POST, PRZ, unbekannt, "eltern_unbekannt");
        Welt fremd = welt();
        UUID fremderProzess = id(ok(ruf(fremd, HttpMethod.POST, PRZ, objekt("P-1", "Spritzguss", "2026-10-01")), 201));
        unbekannt.put("eltern_id", fremderProzess.toString());
        abgelehnt(w, HttpMethod.POST, PRZ, unbekannt, "eltern_unbekannt");

        // Ein Unterprozess besteht nie länger als sein Elternteil.
        Map<String, Object> endet = objekt("P-8", "Altanlage", "2026-10-01");
        endet.put("gueltig_bis", "2026-12-31");
        UUID p8 = id(ok(ruf(w, HttpMethod.POST, PRZ, endet), 201));
        Map<String, Object> laenger = objekt("P-8.1", "Altanlage Nord", "2026-10-01");
        laenger.put("eltern_id", p8.toString());
        Antwort z = abgelehnt(w, HttpMethod.POST, PRZ, laenger, "ziel_besteht_nicht");
        assertThat(z.body().get("besteht_bis").asText()).isEqualTo("2026-12-31");
        assertThat(z.body().get("gueltig_bis").isNull()).isTrue();
        laenger.put("gueltig_bis", "2026-11-30");
        UUID p81 = id(ok(ruf(w, HttpMethod.POST, PRZ, laenger), 201));
        // … und das Elternteil endet nie vor ihm: 409 mit dem Unterprozess, nichts gekürzt.
        Antwort vorKind = abgelehnt(w, HttpMethod.PUT, PRZ + "/" + p8 + "/beenden", Map.of("gueltig_bis", "2026-10-31"),
                "zuordnung_besteht");
        assertThat(vorKind.body().at("/zuordnungen/0/art").asText()).isEqualTo("unterprozess");
        assertThat(vorKind.body().at("/zuordnungen/0/kennzeichen").asText()).isEqualTo("P-8.1");
        assertThat(root.queryForObject("SELECT gueltig_bis FROM prozess WHERE id = ?", LocalDate.class, p81))
                .isEqualTo(LocalDate.of(2026, 11, 30));
    }

    // ================================================== beenden statt löschen: 409 bei Zuordnung

    @Test
    void einEndeVorDerZuordnungIst409MitGrundUndSchreibtNichts() throws Exception {
        Welt w = welt();
        UUID p5 = id(ok(ruf(w, HttpMethod.POST, PRZ, objekt("P-5", "Logistik", "2026-10-01")), 201));
        Antwort gesetzt = ok(ruf(w, HttpMethod.PUT, pfad(w), setzen("2026-10-15", p5)), 200);
        assertThat(gesetzt.body().at("/prozesse/0/prozess/kennzeichen").asText()).isEqualTo("P-5");
        assertThat(gesetzt.body().at("/prozesse/0/gueltig_bis").isNull()).isTrue();

        Map<String, String> vorher = Bestandsschutz.fingerabdruck(root, List.of());
        Antwort a = abgelehnt(w, HttpMethod.PUT, PRZ + "/" + p5 + "/beenden", Map.of("gueltig_bis", "2026-12-31"),
                "zuordnung_besteht");
        assertThat(a.body().get("kennzeichen").asText()).isEqualTo("P-5");
        assertThat(a.body().get("gueltig_bis").asText()).isEqualTo("2026-12-31");
        assertThat(a.body().get("zuordnungen")).hasSize(1);
        assertThat(a.body().at("/zuordnungen/0/art").asText()).isEqualTo("messstelle");
        assertThat(a.body().at("/zuordnungen/0/kennzeichen").asText()).isEqualTo(w.kennzeichen());
        assertThat(a.body().at("/zuordnungen/0/gueltig_ab").asText()).isEqualTo("2026-10-15");
        assertThat(a.body().at("/zuordnungen/0/gueltig_bis").isNull()).isTrue();
        assertThat(Bestandsschutz.abweichungen(vorher, Bestandsschutz.fingerabdruck(root, List.of())))
                .as("die Ablehnung schreibt nichts — kein stilles Kürzen, kein Löschen").isEmpty();

        // Der Weg: erst die Zuordnung beenden (ab 2027 keine Prozesse), dann den Prozess.
        Antwort leer = ok(ruf(w, HttpMethod.PUT, pfad(w), setzen("2027-01-01")), 200);
        assertThat(leer.body().at("/prozesse/0/gueltig_bis").asText()).isEqualTo("2026-12-31");
        ok(ruf(w, HttpMethod.PUT, PRZ + "/" + p5 + "/beenden", Map.of("gueltig_bis", "2026-12-31")), 200);
        assertThat(root.queryForList("SELECT art FROM messstelle_aenderung WHERE messstelle_id = ? ORDER BY id",
                String.class, w.messstelle())).containsExactly("prozesse_zugeordnet", "prozesse_zugeordnet");
        assertThat(root.queryForObject("SELECT neu::text FROM messstelle_aenderung WHERE messstelle_id = ? ORDER BY id "
                + "DESC LIMIT 1", String.class, w.messstelle())).contains("\"prozesse\": []");
    }

    // ========================================================== Messstelle → Prozess: Satz ab Tag

    @Test
    void abEinemTagGehoertDieMessstelleZuGenauDiesenProzessen() throws Exception {
        Welt w = welt();
        UUID p1 = id(ok(ruf(w, HttpMethod.POST, PRZ, objekt("P-1", "Spritzguss", "2026-10-01")), 201));
        UUID p3 = id(ok(ruf(w, HttpMethod.POST, PRZ, objekt("P-3", "Druckluft", "2026-10-01")), 201));
        Map<String, Object> endet = objekt("P-4", "Kühlung", "2026-10-01");
        endet.put("gueltig_bis", "2026-12-31");
        UUID p4 = id(ok(ruf(w, HttpMethod.POST, PRZ, endet), 201));

        ok(ruf(w, HttpMethod.PUT, pfad(w), setzen("2026-10-01", p1, p3)), 200);
        UUID zeileP1 = zeile(w, "P-1", "2026-10-01");
        // Ab 01.11. nur noch P-1: P-3 endet am Vortag, P-1 läuft in DERSELBEN Zeile weiter.
        Antwort nov = ok(ruf(w, HttpMethod.PUT, pfad(w), setzen("2026-11-01", p1)), 200);
        assertThat(intervalle(nov)).containsExactly("P-1 2026-10-01..offen", "P-3 2026-10-01..2026-10-31");
        assertThat(zeile(w, "P-1", "2026-10-01")).isEqualTo(zeileP1);
        // Derselbe Satz noch einmal: nichts ändert sich, kein zweiter Protokolleintrag.
        ok(ruf(w, HttpMethod.PUT, pfad(w), setzen("2026-11-01", p1)), 200);
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_aenderung WHERE messstelle_id = ?", Long.class,
                w.messstelle())).isEqualTo(2);
        // Ein Prozess mit Ende: das Intervall endet mit ihm — sichtbar, nie länger.
        Antwort mitEnde = ok(ruf(w, HttpMethod.PUT, pfad(w), setzen("2026-11-01", p1, p3, p4)), 200);
        assertThat(intervalle(mitEnde)).containsExactly("P-1 2026-10-01..offen", "P-3 2026-10-01..2026-10-31",
                "P-3 2026-11-01..offen", "P-4 2026-11-01..2026-12-31");
        assertThat(mitEnde.body().at("/prozesse/3/endet_mit_prozess").asBoolean()).isTrue();
        assertThat(mitEnde.body().at("/prozesse/0/endet_mit_prozess").asBoolean()).isFalse();
        // Früher ab 15.10. nur P-1: P-3 vom Oktober endet am 14.10., was ab November begann, wird aufgehoben.
        Antwort okt = ok(ruf(w, HttpMethod.PUT, pfad(w), setzen("2026-10-15", p1)), 200);
        assertThat(intervalle(okt)).containsExactly("P-1 2026-10-01..offen", "P-3 2026-10-01..2026-10-14");
        assertThat(root.queryForObject("SELECT count(*) FROM messstelle_prozess WHERE messstelle_id = ? AND aufgehoben_am "
                + "IS NOT NULL", Long.class, w.messstelle())).as("aufgehoben, lesbar — nie gelöscht").isEqualTo(2);
        assertThat(intervalle(ok(ruf(w, HttpMethod.GET, pfad(w) + "?am=2026-10-20", null), 200)))
                .containsExactly("P-1 2026-10-01..offen");
        assertThat(intervalle(ok(ruf(w, HttpMethod.GET, pfad(w) + "?am=2026-10-10", null), 200)))
                .containsExactly("P-1 2026-10-01..offen", "P-3 2026-10-01..2026-10-14");
        assertThat(root.queryForObject("SELECT neu::text FROM messstelle_aenderung WHERE messstelle_id = ? ORDER BY id "
                + "DESC LIMIT 1", String.class, w.messstelle())).contains("\"P-1\"").doesNotContain("P-3");

        // Ablehnungen: der Prozess besteht am Tag nicht, einen Prozess gibt es nicht, doppelt, archiviert.
        Antwort vorBeginn = abgelehnt(w, HttpMethod.PUT, pfad(w), setzen("2026-09-30", p1), "ziel_besteht_nicht");
        assertThat(vorBeginn.body().get("besteht_ab").asText()).isEqualTo("2026-10-01");
        abgelehnt(w, HttpMethod.PUT, pfad(w), setzen("2027-01-01", p4), "ziel_besteht_nicht");
        abgelehnt(w, HttpMethod.PUT, pfad(w), setzen("2026-11-01", UUID.randomUUID()), "prozess_unbekannt");
        abgelehntMitFeld(w, HttpMethod.PUT, pfad(w), setzen("2026-11-01", p1, p1), "anfrage_ungueltig", "prozesse");
        abgelehntMitFeld(w, HttpMethod.PUT, pfad(w), Map.of("gueltig_ab", "2026-11-01", "prozesse", List.of(1, 2)),
                "anfrage_ungueltig", "prozesse");
        abgelehntMitFeld(w, HttpMethod.PUT, pfad(w), Map.of("gueltig_ab", "2026-11-01"), "anfrage_ungueltig", "prozesse");
        root.update("UPDATE messstelle SET archiviert_am = now() WHERE id = ?", w.messstelle());
        abgelehnt(w, HttpMethod.PUT, pfad(w), setzen("2026-11-01", p1), "messstelle_archiviert");
    }

    // ============================================================================== Zaun

    @Test
    void fremdIst404NieDreiHundertDrei() throws Exception {
        Welt a = welt();
        Welt b = welt();
        UUID kst = id(ok(ruf(a, HttpMethod.POST, KST, objekt("4100", "Spritzguss", "2026-10-01")), 201));
        UUID prz = id(ok(ruf(a, HttpMethod.POST, PRZ, objekt("P-1", "Spritzguss", "2026-10-01")), 201));
        abgelehnt(b, HttpMethod.GET, KST + "/" + kst, null, "nicht_gefunden");
        abgelehnt(b, HttpMethod.PUT, KST + "/" + kst, Map.of("name", "Übernommen"), "nicht_gefunden");
        abgelehnt(b, HttpMethod.PUT, KST + "/" + kst + "/beenden", Map.of("gueltig_bis", "2026-12-31"), "nicht_gefunden");
        abgelehnt(b, HttpMethod.GET, PRZ + "/" + prz, null, "nicht_gefunden");
        abgelehnt(b, HttpMethod.GET, pfad(a), null, "nicht_gefunden");
        abgelehnt(b, HttpMethod.PUT, pfad(a), setzen("2026-10-01"), "nicht_gefunden");
        abgelehnt(b, HttpMethod.PUT, pfad(b), setzen("2026-10-01", prz), "prozess_unbekannt");
        abgelehnt(a, HttpMethod.GET, KST + "/kein-uuid", null, "nicht_gefunden");
        assertThat(ok(ruf(b, HttpMethod.GET, KST, null), 200).body().get("kostenstellen")).isEmpty();
        assertThat(ok(ruf(b, HttpMethod.GET, PRZ, null), 200).body().get("prozesse")).isEmpty();
        // Dasselbe Kennzeichen darf ein anderer Kundenbereich tragen.
        ok(ruf(b, HttpMethod.POST, KST, objekt("4100", "Spritzguss", "2026-10-01")), 201);
        assertThat(root.queryForObject("SELECT name FROM kostenstelle WHERE id = ?", String.class, kst)).isEqualTo("Spritzguss");
    }

    /** Ohne Unternehmen gibt es nichts zu verwalten — 409, nie 500. */
    @Test
    void ohneUnternehmenIstEs409() throws Exception {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Ohne Unternehmen') RETURNING id", UUID.class);
        Welt w = new Welt(t, null, null);
        abgelehnt(w, HttpMethod.POST, KST, objekt("4100", "Spritzguss", "2026-10-01"), "unternehmen_nicht_angelegt");
        assertThat(ok(ruf(w, HttpMethod.GET, KST, null), 200).body().get("kostenstellen")).isEmpty();
    }

    // ======================================================================== Standort-Zaun

    /**
     * Geltung Unternehmen (AP-03 R-A1, §4.9): Kostenstelle und Prozess sieht nur eine unternehmensweite Rolle.
     * Kundenadministrator, Bestandskonto (E12) und ein Aufruf ohne Zugriff-Kontext (wie jeder andere Fall dieser Klasse)
     * sehen das Objekt byte-gleich; ein Bearbeiter — auch am Standort der zugeordneten Messstelle — bekommt Status und
     * Körper einer Kennung, die es nicht gibt. Der interne Leser (Verteilung, Bericht) liest weiter.
     */
    @Test
    void kostenstelleUndProzessSiehtNurEineUnternehmensweiteRolle() throws Exception {
        Welt w = welt();
        UUID unternehmen = root.queryForObject("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, w.mandant());
        UUID standort = root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, "
                + "zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class,
                w.mandant(), unternehmen);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) VALUES (?, ?, ?, "
                + "'2024-01-01')", w.mandant(), w.messstelle(), standort);
        UUID kostenstelle = id(ok(ruf(w, HttpMethod.POST, KST, objekt("4200", "Montage", "2024-01-01")), 201));
        UUID prozess = id(ok(ruf(w, HttpMethod.POST, PRZ, objekt("P-1", "Spritzguss", "2024-01-01")), 201));
        ok(ruf(w, HttpMethod.PUT, pfad(w), setzen("2024-01-01", prozess)), 200);
        String bestand = "sub-ines-" + w.mandant();
        String ka = zuweisung(w, "sub-ka-", "kundenadministrator", null);
        String hier = zuweisung(w, "sub-hier-", "bearbeiter", standort);
        String nie = "00000000-0000-0000-0000-00000000dead";

        for (String basis : List.of(KST + "/", PRZ + "/")) {
            String pfad = basis + (basis.startsWith(KST) ? kostenstelle : prozess);
            Roh voll = als(w, ka, pfad);
            assertThat(voll.status()).as(pfad + " " + voll.body()).isEqualTo(200);
            assertThat(als(w, bestand, pfad)).as(pfad + ": Bestandskonto").isEqualTo(voll);
            assertThat(ohneKontext(w, pfad)).as(pfad + ": ohne Kontext").isEqualTo(voll);
            Roh h = als(w, hier, pfad);
            assertThat(h.status()).as(pfad + ": Bearbeiter " + h.body()).isEqualTo(404);
            assertThat(h).as(pfad + ": wie eine unbekannte Kennung").isEqualTo(als(w, hier, basis + nie));
        }

        // Der interne Leser bedient keine Kundenanfrage nach der Kennung: er liest auch unter einem Zugriff, der die
        // Kostenstelle nicht sieht.
        TenantContext.set(w.mandant());
        ZugriffContext.set(new ZugriffContext.Zugriff("sub-ohne", RechteAbleitung.Konto.BENUTZER, w.mandant(),
                ZugriffContext.Zugang.KONTO, List.of(), Instant.now(), false));
        assertThat(dienst.kostenstelle(kostenstelle).kennzeichen()).isEqualTo("4200");
        assertThat(dienst.prozess(prozess).kennzeichen()).isEqualTo("P-1");
    }

    /** Ein Konto mit einer wirksamen Zuweisung ({@code standort} {@code null} = unternehmensweit). */
    private static String zuweisung(Welt w, String praefix, String rolle, UUID standort) {
        String sub = praefix + w.mandant();
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv')", w.mandant(), sub, sub);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) VALUES "
                + "(?, ?, ?, ?, '2024-01-01T00:00:00+01', 'Europe/Berlin')", w.mandant(), sub, rolle, standort);
        return sub;
    }

    /** Ein Kundenkonto wie aus Keycloak (der Konverter setzt die Kontoart): der Zugriff-Kontext wird geladen. */
    private Roh als(Welt w, String sub, String pfad) throws Exception {
        Map<String, Object> claims = Map.of("sub", sub, "preferred_username", sub, "tenant_id", w.mandant().toString(),
                "realm_access", Map.of("roles", List.of()));
        Jwt token = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return roh(request(HttpMethod.GET, pfad).with(authentication(new KeycloakRealmRoleConverter().convert(token))));
    }

    /** Derselbe Aufruf ohne Kontoart — ohne Zugriff-Kontext, wie {@link #ruf}. */
    private Roh ohneKontext(Welt w, String pfad) throws Exception {
        return roh(request(HttpMethod.GET, pfad).with(jwt().jwt(j -> {
            j.subject("sub-ines-" + w.mandant());
            j.claim("preferred_username", "Ines Kaltenbach");
            j.claim("tenant_id", w.mandant().toString());
        })));
    }

    private Roh roh(MockHttpServletRequestBuilder anfrage) throws Exception {
        MvcResult r = mvc.perform(anfrage).andReturn();
        return new Roh(r.getResponse().getStatus(), r.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    // ============================================================================== Gerüst

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Kostenstellen #" + nr);
        root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, 'Kunststoffwerk Ahrenberg GmbH', "
                + "'Europe/Berlin')", t);
        String kz = "MS-" + (10 + nr % 80);
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, "
                + "richtung, einheit, wertart) VALUES (?, ?, 'Spritzguss Halle 1', 'gemessen', 'Strom', "
                + "'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') RETURNING id", UUID.class, t, kz);
        return new Welt(t, ms, kz);
    }

    private static String pfad(Welt w) {
        return "/api/v1/messstellen/" + w.messstelle() + "/prozesse";
    }

    private static Map<String, Object> objekt(String kennzeichen, String name, String ab) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", kennzeichen);
        m.put("name", name);
        m.put("gueltig_ab", ab);
        return m;
    }

    private static Map<String, Object> setzen(String ab, UUID... prozesse) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", ab);
        m.put("prozesse", Arrays.stream(prozesse).map(UUID::toString).toList());
        return m;
    }

    private UUID zeile(Welt w, String prozess, String ab) {
        return root.queryForObject("SELECT z.id FROM messstelle_prozess z JOIN prozess p ON p.id = z.prozess_id "
                + "WHERE z.messstelle_id = ? AND p.kennzeichen = ? AND z.gueltig_ab = ?::date AND z.aufgehoben_am IS NULL",
                UUID.class, w.messstelle(), prozess, ab);
    }

    private static List<String> intervalle(Antwort a) {
        List<String> aus = new ArrayList<>();
        a.body().get("prozesse").forEach(z -> aus.add(z.at("/prozess/kennzeichen").asText() + " "
                + z.get("gueltig_ab").asText() + ".." + (z.get("gueltig_bis").isNull() ? "offen" : z.get("gueltig_bis").asText())));
        return aus;
    }

    private static List<String> kennzeichen(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(x -> aus.add(x.get("kennzeichen").asText()));
        return aus;
    }

    private static UUID id(Antwort a) {
        return UUID.fromString(a.body().get("id").asText());
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.body().toString()).isEqualTo(status);
        return a;
    }

    /** Die Ablehnung: Status und Kundensatz des Codes aus dem geschlossenen Satz. */
    private Antwort abgelehnt(Welt w, HttpMethod methode, String pfad, Object body, String code) throws Exception {
        Antwort a = ruf(w, methode, pfad, body);
        Ablehnung soll = Arrays.stream(Ablehnung.values()).filter(x -> x.code().equals(code)).findFirst().orElseThrow();
        assertThat(a.body().path("code").asText()).as(a.body().toString()).isEqualTo(code);
        assertThat(a.status()).as(code).isEqualTo(soll.status());
        assertThat(a.body().path("message").asText()).isEqualTo(soll.satz());
        return a;
    }

    private void abgelehntMitFeld(Welt w, HttpMethod methode, String pfad, Object body, String code, String feld)
            throws Exception {
        assertThat(abgelehnt(w, methode, pfad, body, code).body().path("feld").asText()).isEqualTo(feld);
    }

    private Antwort ruf(Welt w, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject("sub-ines-" + w.mandant());
                    j.claim("preferred_username", "Ines Kaltenbach");
                    j.claim("tenant_id", w.mandant().toString());
                }))
                .contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
