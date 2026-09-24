package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.NullNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
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
 * Die Berichts-Routen (UEMS AP-12 IP-7, Meilenstein „Bericht freigebbar“) gegen die echte Kette: JWT → TenantFilter →
 * Controller → {@link BerichtRechte} → RLS → Datenbank. Personen aus dem Referenzunternehmen Ahrenberg (B13); ihre
 * Zuweisungen setzt der Test an der einen Naht {@link KennzahlAufrufer} ein.
 *
 * <p>Die Entwürfe sind die Abzüge {@code BR-2026-0001/1} und {@code /2} aus {@code bericht-vectors.json}, kanonisch
 * geschrieben — so ist „der Stand ist Byte für Byte der Entwurf“ an der Prüfsumme des Vektors nachprüfbar. Die Bildung
 * selbst prüft {@code BerichtAbzugBildungTest}; hier bildet nur das Anlegen.
 *
 * <p>Die Abnahme: B4 (422/422/409 mit Codes), B5 (Ordnung), B13 (jede Zeile mit Route, die Teilansicht), F5, die
 * byte-gleiche Kopie, die geprüfte Prüfsumme, Vergleich, Verwerfen, Revision Nr. 2, Archivieren, Anlegen. Jede Ablehnung
 * schreibt nichts.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class BerichtApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final ObjectMapper EXAKT = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .setNodeFactory(JsonNodeFactory.withExactBigDecimals(true));
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String PFAD = "/api/v1/berichte";
    private static final Map<String, Benutzer> PERSONEN = new ConcurrentHashMap<>();

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
    BerichtService dienst;

    @MockBean
    KennzahlAufrufer aufrufer;

    private static JdbcTemplate root;
    private static final AtomicInteger NR = new AtomicInteger();
    private static String nummerEins;
    private static String nummerZwei;

    private record Wer(String sub, String name, UUID kundenbereich, boolean plattform) {}

    private record Antwort(int status, JsonNode body, String text) {}

    /** Ein Kundenbereich mit Unternehmen, zwei Werken und den sechs Personen aus B13 (plus Lena Voss, Plattform). */
    private record Welt(UUID mandant, UUID unternehmen, UUID st1, UUID st2, Wer jonas, Wer ines, Wer peter, Wer murat,
            Wer claudia, Wer thomas, Wer voss) {}

    @BeforeAll
    static void verbinde() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        JsonNode vektoren = EXAKT.readTree(Files.readString(Path.of("..", "..", "docs", "contracts", "v2",
                "bericht-vectors.json")));
        nummerEins = BerichtRegeln.kanonisch(vektoren.path("abzuege").path("BR-2026-0001/1"));
        nummerZwei = BerichtRegeln.kanonisch(vektoren.path("abzuege").path("BR-2026-0001/2"));
        assertThat(BerichtRegeln.pruefsumme(nummerEins)).startsWith("sha256:b113527d");
    }

    @BeforeEach
    void naht() {
        doAnswer(inv -> {
            ProtokollAkteur a = inv.getArgument(0);
            Benutzer b = PERSONEN.get(a.sub());
            return b != null ? b : KorrekturRechte.benutzer(a);
        }).when(aufrufer).benutzer(any());
    }

    @AfterEach
    void uhrZurueck() {
        dienst.uhrStellen(Clock.systemUTC());
    }

    // =========================================================================== IP-9: die Folgen-Zeile

    /**
     * AP-12 IP-9, {@code GET /berichte/betroffen} — die Zeile „Freigegebene Berichte: …“. Eine rückwirkende Zuordnung am
     * Standort ab 01.10.2026 träfe Nr. 1 (MS-12 steht in seinem Quellenverzeichnis), ab 01.11.2026 nicht mehr; zitiert wird
     * Nr. 1 in beiden Fällen. Eine Fläche zitiert heute kein Bericht, ein Umzug trifft nie. Peter liest keinen
     * Ahrenberg-Bericht (keine vorhanden), Thomas nirgends einen (403); fremd und falsche Art 404, kaputte Anfrage 400.
     * Die Route schreibt nichts.
     */
    @Test
    void ip9DieFolgenZeileNenntBetroffeneUndZitierendeStaende() throws Exception {
        Welt w = welt();
        messstelle(w, "MS-12", "Montage Linie M1", w.st1(), "2026-10-01");
        UUID ms12 = root.queryForObject("SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-12'", UUID.class,
                w.mandant());
        UUID anlage = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle 2') RETURNING id", UUID.class,
                w.mandant());
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        entwurf(w, st, nummerEins, "2026-11-10T08:55:00+01:00");
        root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, version, fassung, name_zum_datenstand) VALUES (?, ?, NULL, 'messstelle', 'MS-12', ?, "
                + "'unmittelbar', '2026-10-01', '2026-10-31', 1, NULL, 'Montage Linie M1')", w.mandant(), st, ms12);
        uhr("2026-11-10T09:02:00+01:00");
        ok(ruf(w.ines(), HttpMethod.POST, PFAD + "/BR-2026-0001/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 201);
        uhr("2026-11-20T10:00:00+01:00");
        long staende = zaehle("bericht_stand", w);
        long anstoesse = zaehle("bericht_revision_anstoss", w);
        long protokoll = zaehle("bericht_aenderung", w);
        String zuordnung = PFAD + "/betroffen?objekt=" + w.st1() + "&anlass=zuordnung_rueckwirkend&gilt_ab=";

        assertThat(ok(ruf(w.ines(), HttpMethod.GET, zuordnung + "2026-10-01", null), 200).body()).isEqualTo(MAPPER.readTree(
                "{\"anlass\": \"zuordnung_rueckwirkend\", \"gilt_ab\": \"2026-10-01\", \"berichte_vorhanden\": true, "
                        + "\"betroffen\": [{\"kennung\": \"BR-2026-0001\", \"nr\": 1}], "
                        + "\"zitieren\": [{\"kennung\": \"BR-2026-0001\", \"nr\": 1}]}"));
        JsonNode november = ok(ruf(w.ines(), HttpMethod.GET, zuordnung + "2026-11-01", null), 200).body();
        assertThat(november.get("betroffen")).as("ab 01.11. schneidet kein Oktober").isEmpty();
        assertThat(november.get("zitieren")).hasSize(1);
        JsonNode flaeche = ok(ruf(w.ines(), HttpMethod.GET, PFAD + "/betroffen?objekt=" + w.st1()
                + "&anlass=flaeche_rueckwirkend&gilt_ab=2026-10-01", null), 200).body();
        assertThat(flaeche.get("betroffen")).as("heute zitiert kein Bericht eine Fläche").isEmpty();
        JsonNode umzug = ok(ruf(w.ines(), HttpMethod.GET, PFAD + "/betroffen?objekt=" + anlage
                + "&anlass=anlage_umzug_rueckwirkend&gilt_ab=2026-10-01", null), 200).body();
        assertThat(umzug.get("betroffen")).as("kein Abzug liest den Standort einer Anlage").isEmpty();

        JsonNode peter = ok(ruf(w.peter(), HttpMethod.GET, zuordnung + "2026-10-01", null), 200).body();
        assertThat(peter.get("berichte_vorhanden").asBoolean()).isFalse();
        assertThat(peter.get("betroffen")).isEmpty();
        assertThat(peter.get("zitieren")).isEmpty();
        verboten(ruf(w.thomas(), HttpMethod.GET, zuordnung + "2026-10-01", null));
        abgelehnt(ruf(w.ines(), HttpMethod.GET, PFAD + "/betroffen?objekt=" + UUID.randomUUID()
                + "&anlass=zuordnung_rueckwirkend&gilt_ab=2026-10-01", null), 404, "nicht_gefunden");
        abgelehnt(ruf(w.ines(), HttpMethod.GET, PFAD + "/betroffen?objekt=" + w.st1()
                + "&anlass=anlage_umzug_rueckwirkend&gilt_ab=2026-10-01", null), 404, "nicht_gefunden");
        assertThat(abgelehnt(ruf(w.ines(), HttpMethod.GET, zuordnung + "kaputt", null), 400, "anfrage_ungueltig").body()
                .get("feld").asText()).isEqualTo("gilt_ab");
        abgelehnt(ruf(w.ines(), HttpMethod.GET, PFAD + "/betroffen?objekt=" + w.st1()
                + "&anlass=umbenennung&gilt_ab=2026-10-01", null), 400, "anfrage_ungueltig");

        assertThat(zaehle("bericht_stand", w)).isEqualTo(staende);
        assertThat(zaehle("bericht_revision_anstoss", w)).isEqualTo(anstoesse);
        assertThat(zaehle("bericht_aenderung", w)).isEqualTo(protokoll);
    }

    /**
     * Standort-Zaun (AP-03 R-A1): eine Messstelle außerhalb des Zugriffs antwortet wie eine Kennung, die der Kundenbereich
     * nicht kennt — Peter (Bearbeiter nur Werk Lindach) erfährt nicht, dass es MS-12 in Werk Ahrenberg gibt. An MS-18
     * seines Standorts antwortet die Route wie bisher. Ines (Energiemanager mit Zuweisung), Jonas als Bestandskonto (E12,
     * nie zugewiesen) und Jonas ohne Zugriff-Kontext (wie jeder andere Fall dieser Klasse) bekommen dieselben Bytes.
     */
    @Test
    void betroffenVerraetKeineMessstelleAusserhalbDesZugriffs() throws Exception {
        Welt w = welt();
        // Der Ort gilt HEUTE (der Zaun fragt den Ort von heute; ohne Ort gälte „irgendwo“, firstmate 21.09.2026).
        messstelle(w, "MS-12", "Montage Linie M1", w.st1(), "2024-01-01");
        messstelle(w, "MS-18", "Montagehalle Lindach gesamt", w.st2(), "2024-01-01");
        UUID ms12 = root.queryForObject("SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-12'", UUID.class,
                w.mandant());
        UUID ms18 = root.queryForObject("SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-18'", UUID.class,
                w.mandant());
        konto(w.peter(), "bearbeiter", w.st2());
        konto(w.ines(), "energiemanager", null);
        String frage = PFAD + "/betroffen?anlass=zuordnung_rueckwirkend&gilt_ab=2026-10-01&objekt=";
        String nie = "00000000-0000-0000-0000-00000000dead";

        Antwort fremd = mitKonto(w.peter(), frage + ms12);
        assertThat(fremd.status()).as(fremd.text()).isEqualTo(404);
        assertThat(fremd).isEqualTo(mitKonto(w.peter(), frage + nie));
        Antwort eigen = mitKonto(w.peter(), frage + ms18);
        assertThat(eigen.status()).as(eigen.text()).isEqualTo(200);
        assertThat(eigen).isEqualTo(ruf(w.peter(), HttpMethod.GET, frage + ms18, null));

        for (UUID ms : List.of(ms12, ms18)) {
            Antwort voll = ruf(w.jonas(), HttpMethod.GET, frage + ms, null);
            assertThat(voll.status()).as(voll.text()).isEqualTo(200);
            assertThat(mitKonto(w.jonas(), frage + ms)).as("Bestandskonto").isEqualTo(voll);
            assertThat(mitKonto(w.ines(), frage + ms)).as("Energiemanager").isEqualTo(voll);
        }
    }

    /** Die wirksame Zuweisung einer Person der Welt im Zugriff-Kontext ({@code standort} {@code null} = unternehmensweit). */
    private static void konto(Wer wer, String rolle, UUID standort) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (?, ?, 'benutzer', ?, "
                + "'aktiv')", wer.kundenbereich(), wer.sub(), wer.name());
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) VALUES "
                + "(?, ?, ?, ?, '2024-01-01T00:00:00+01', 'Europe/Berlin')", wer.kundenbereich(), wer.sub(), rolle, standort);
    }

    /** Ein Kundenkonto wie aus Keycloak (der Konverter setzt die Kontoart): der Zugriff-Kontext wird geladen. */
    private Antwort mitKonto(Wer wer, String pfad) throws Exception {
        Map<String, Object> claims = Map.of("sub", wer.sub(), "preferred_username", wer.name(), "tenant_id",
                wer.kundenbereich().toString(), "realm_access", Map.of("roles", List.of()));
        Jwt token = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        MvcResult r = mvc.perform(request(HttpMethod.GET, pfad)
                .with(authentication(new KeycloakRealmRoleConverter().convert(token)))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text), text);
    }

    // =========================================================================== B4

    /** B4 a/b/c: Zeitraum läuft (422) · Werte vorläufig (422) · Entwurf veraltet (409) — dann Nr. 1 mit dem neuen Datenstand. */
    @Test
    void b4DreiAblehnungenMitIhrenCodesDannNummerEins() throws Exception {
        Welt w = welt();
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        String k = PFAD + "/BR-2026-0001";

        // a) 20.10.2026: der Oktober läuft
        entwurf(w, st, vorlaeufig(nummerEins), "2026-10-20T10:00:00+02:00");
        uhr("2026-10-20T10:30:00+02:00");
        Antwort a = abgelehnt(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-10-20T10:00:00+02:00")),
                422, "zeitraum_nicht_zu_ende");
        assertThat(a.body().get("message").asText()).isEqualTo(
                "Der Oktober 2026 ist noch nicht zu Ende — ein Berichtsstand ist ab dem 08.11.2026 möglich (7 Tage nach Monatsende).");
        assertThat(a.body().get("moeglich_ab").asText()).isEqualTo("2026-11-08T00:00:00+01:00");

        // b) 05.11.2026: jeder Wert vorläufig (endgültig ab 08.11.)
        entwurf(w, st, vorlaeufig(nummerEins), "2026-11-05T08:50:00+01:00");
        uhr("2026-11-05T09:00:00+01:00");
        Antwort b = abgelehnt(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-05T08:50:00+01:00")),
                422, "werte_vorlaeufig");
        int werte = EXAKT.readTree(nummerEins).path("werte").size();
        List<String> quellen = new ArrayList<>();
        EXAKT.readTree(nummerEins).path("werte").forEach(x -> {
            if (!quellen.contains(x.path("quelle").asText())) {
                quellen.add(x.path("quelle").asText());
            }
        });
        assertThat(b.body().get("vorlaeufig").asInt()).isEqualTo(werte);
        assertThat(b.body().get("vorlaeufige")).as("jede Quelle einmal").isEqualTo(MAPPER.valueToTree(quellen));
        assertThat(b.body().get("moeglich_ab").asText()).isEqualTo("2026-11-08T00:00:00+01:00");
        assertThat(b.body().get("message").asText()).startsWith(werte + " Werte sind noch vorläufig (endgültig ab 08.11.2026): MS-01 ")
                .endsWith(", … — ein Berichtsstand braucht endgültige Werte.");

        // c) Unternehmensbericht, 12.11.2026: die Kaskade hat den Entwurf um 10:05:33 neu gebildet, Jonas sah 10.11. 08:57
        UUID u = bericht(w, "BR-2026-0002", "monatsbericht_unternehmen", null, "2026-10");
        String ku = PFAD + "/BR-2026-0002";
        entwurf(w, u, nummerZwei, "2026-11-12T10:05:33+01:00");
        uhr("2026-11-12T10:12:00+01:00");
        Antwort c = abgelehnt(ruf(w.jonas(), HttpMethod.POST, ku + "/freigeben", datenstand("2026-11-10T08:57:00+01:00")),
                409, "entwurf_veraltet");
        assertThat(c.body().get("datenstand_uebermittelt").asText()).isEqualTo("2026-11-10T08:57:00+01:00");
        assertThat(c.body().get("datenstand_aktuell").asText()).isEqualTo("2026-11-12T10:05:33+01:00");
        assertThat(c.body().get("message").asText()).startsWith("Der Entwurf hat sich seit dem 10.11.2026 08:57 geändert");
        assertThat(zaehle("bericht_stand", w)).isZero();
        assertThat(zaehle("bericht_aenderung", w)).isZero();

        uhr("2026-11-12T10:20:00+01:00");
        Antwort zweiter = ok(ruf(w.jonas(), HttpMethod.POST, ku + "/freigeben", datenstand("2026-11-12T10:05:33+01:00")), 201);
        assertThat(zweiter.body().get("nr").asInt()).isEqualTo(1);
        assertThat(Instant.parse(zweiter.body().get("datenstand").asText())).isEqualTo(t("2026-11-12T10:05:33+01:00"));
        assertThat(Instant.parse(zweiter.body().get("freigegeben_am").asText())).isEqualTo(t("2026-11-12T10:20:00+01:00"));
        assertThat(zweiter.body().get("freigegeben_von")).isEqualTo(MAPPER.readTree(
                "{\"name\": \"Jonas Wendlinger\", \"rolle\": \"kundenadministrator\"}"));
    }

    /** Das Recht prüft die Route VOR F1: Peter (Lindach) bekommt am laufenden Ahrenberg-Bericht 404, nie die 422. */
    @Test
    void dasRechtPrueftDieRouteVorDenVoraussetzungen() throws Exception {
        Welt w = welt();
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        entwurf(w, st, vorlaeufig(nummerEins), "2026-10-20T10:00:00+02:00");
        uhr("2026-10-20T10:30:00+02:00");
        String f = PFAD + "/BR-2026-0001/freigeben";
        abgelehnt(ruf(w.peter(), HttpMethod.POST, f, datenstand("2026-10-20T10:00:00+02:00")), 404, "nicht_gefunden");
        verboten(ruf(w.claudia(), HttpMethod.POST, f, datenstand("2026-10-20T10:00:00+02:00")));
        verboten(ruf(w.voss(), HttpMethod.POST, f, datenstand("2026-10-20T10:00:00+02:00")));
        abgelehnt(ruf(w.ines(), HttpMethod.POST, PFAD + "/BR-2026-9999/freigeben", datenstand("2026-10-20T10:00:00+02:00")),
                404, "nicht_gefunden");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, PFAD + "/nicht-da/freigeben", datenstand("2026-10-20T10:00:00+02:00")),
                404, "nicht_gefunden");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, f, Map.of("entwurf_datenstand", "gestern")), 400, "anfrage_ungueltig");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, f, Map.of("datenstand", "2026-10-20T10:00:00+02:00")), 400,
                "anfrage_ungueltig");
        assertThat(zaehle("bericht_stand", w) + zaehle("bericht_aenderung", w)).isZero();
    }

    // =========================================================================== B5, Kopie, F5

    /**
     * B5 und der Kern von E1: Nr. 1 ist der Entwurf Byte für Byte — dieselbe Prüfsumme wie der Vektor, derselbe Text in
     * der Datenbank und in der Antwort; Monatslauf < endgültig ab < Datenstand < Freigabe. Dann F5: dieselbe Freigabe noch
     * einmal ist 200 mit derselben Nr. und schreibt nichts.
     */
    @Test
    void b5DieFreigabeKopiertDenEntwurfByteGleichUndIstIdempotent() throws Exception {
        Welt w = welt();
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        entwurf(w, st, nummerEins, "2026-11-10T08:55:00+01:00");
        String k = PFAD + "/BR-2026-0001";
        uhr("2026-11-10T09:02:00+01:00");

        Antwort nr1 = ok(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 201);
        JsonNode s = nr1.body();
        assertThat(s.get("nr").asInt()).isEqualTo(1);
        assertThat(s.get("pruefsumme").asText()).isEqualTo(BerichtRegeln.pruefsumme(nummerEins)).startsWith("sha256:b113527d");
        assertThat(s.get("pruefsumme_geprueft").asBoolean()).isTrue();
        assertThat(nr1.text()).contains("\"abzug\":" + nummerEins + "}");

        Map<String, Object> db = root.queryForMap("SELECT s.abzug = e.abzug AS gleich, "
                + "convert_to(s.abzug, 'UTF8') = convert_to(e.abzug, 'UTF8') AS bytegleich, octet_length(s.abzug) AS laenge, "
                + "s.pruefsumme = e.pruefsumme AS summe, s.datenstand = e.datenstand AS datenstand, s.freigeber_rolle, "
                + "s.freigeber_name, s.darstellung::text AS darstellung FROM bericht_stand s JOIN bericht_entwurf e "
                + "ON e.bericht_id = s.bericht_id WHERE s.bericht_id = ? AND s.nr = 1", st);
        assertThat(db.get("gleich")).isEqualTo(true);
        assertThat(db.get("bytegleich")).isEqualTo(true);
        assertThat(((Number) db.get("laenge")).intValue()).isEqualTo(nummerEins.getBytes(StandardCharsets.UTF_8).length);
        assertThat(db.get("summe")).isEqualTo(true);
        assertThat(db.get("datenstand")).isEqualTo(true);
        assertThat(db.get("freigeber_rolle")).isEqualTo("energiemanager");
        assertThat(db.get("freigeber_name")).isEqualTo("Ines Kaltenbach");
        assertThat(EXAKT.readTree((String) db.get("darstellung")))
                .isEqualTo(EXAKT.readTree(nummerEins).path("kopf").path("darstellung"));
        assertThat(root.queryForObject("SELECT count(*) FROM bericht_quelle WHERE bericht_id = ? AND stand_nr = 1", Long.class,
                st)).isEqualTo(root.queryForObject("SELECT count(*) FROM bericht_quelle WHERE bericht_id = ? AND stand_nr IS NULL",
                        Long.class, st)).isPositive();

        // B5 — die Ordnung, und der Kopf nennt beides
        JsonNode abzug = EXAKT.readTree(nummerEins);
        Instant monatslauf = BerichtService.zeiten(abzug, "berechnet_am").stream().max(Instant::compareTo).orElseThrow();
        Instant endgueltig = BerichtService.zeiten(abzug, "endgueltig_ab").stream().max(Instant::compareTo).orElseThrow();
        Instant ds = Instant.parse(s.get("datenstand").asText());
        Instant frei = Instant.parse(s.get("freigegeben_am").asText());
        assertThat(List.of(monatslauf, endgueltig, ds, frei)).containsExactly(t("2026-11-01T00:20:00+01:00"),
                t("2026-11-08T00:00:00+01:00"), t("2026-11-10T08:55:00+01:00"), t("2026-11-10T09:02:00+01:00"));
        assertThat(s.get("kopf").asText()).isEqualTo(
                "Datenstand 10.11.2026 08:55 (MEZ) · Berichtsstand Nr. 1 · freigegeben 10.11.2026 09:02 von Ines Kaltenbach");

        // Ereignis und Protokoll
        Map<String, Object> e = root.queryForMap("SELECT count(*) AS n, min(nutzlast->>'pruefsumme') AS summe, "
                + "min(nutzlast->>'datenstand') AS ds, min(kennungen->>'bericht') AS bericht, min(urheber) AS urheber "
                + "FROM messreihe_ereignis WHERE tenant_id = ? AND art = 'bericht_freigegeben'", w.mandant());
        assertThat(((Number) e.get("n")).intValue()).isEqualTo(1);
        assertThat(e.get("summe")).isEqualTo(s.get("pruefsumme").asText());
        assertThat(e.get("ds")).isEqualTo("2026-11-10T07:55:00Z");
        assertThat(e.get("bericht")).isEqualTo("BR-2026-0001");
        assertThat(e.get("urheber")).isEqualTo("kunde");
        assertThat(root.queryForList("SELECT art FROM bericht_aenderung WHERE bericht_id = ?", String.class, st))
                .containsExactly("freigeben");

        // F5 — dieselbe Freigabe noch einmal
        uhr("2026-11-10T09:05:00+01:00");
        Antwort wieder = ok(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-10T07:55:00Z")), 200);
        assertThat(wieder.body().get("nr").asInt()).isEqualTo(1);
        assertThat(wieder.body().get("freigegeben_am").asText()).isEqualTo(s.get("freigegeben_am").asText());
        assertThat(zaehle("bericht_stand", w)).isEqualTo(1);
        assertThat(zaehle("bericht_aenderung", w)).isEqualTo(1);
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND art = 'bericht_freigegeben'", Long.class, w.mandant())).isEqualTo(1);

        // Der Stand ist lesbar — und seine Prüfsumme geprüft
        Antwort gelesen = ok(ruf(w.claudia(), HttpMethod.GET, k + "/staende/1", null), 200);
        assertThat(gelesen.text()).contains("\"abzug\":" + nummerEins + "}");
        assertThat(gelesen.body().get("teilansicht")).isEqualTo(MAPPER.readTree("[\"Werk Ahrenberg\", \"Werk Lindach\"]"));
        Antwort keiner = abgelehnt(ruf(w.ines(), HttpMethod.GET, k + "/staende/3", null), 404, "stand_gibt_es_nicht");
        assertThat(keiner.body().get("message").asText())
                .isEqualTo("Berichtsstand Nr. 3 gibt es nicht — der neueste ist Nr. 1 vom 10.11.2026.");
    }

    /** A6 — ein Stand, dessen Text nicht mehr zur Prüfsumme passt, verlässt den Server nie: 500 {@code abzug_beschaedigt}. */
    @Test
    void einBeschaedigterAbzugWirdNieAusgeliefert() throws Exception {
        Welt w = welt();
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        entwurf(w, st, nummerEins, "2026-11-10T08:55:00+01:00");
        uhr("2026-11-10T09:02:00+01:00");
        ok(ruf(w.ines(), HttpMethod.POST, PFAD + "/BR-2026-0001/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 201);

        // Die Datenbank lässt das nie zu (Trigger + CHECK) — der Test nimmt beide für einen Augenblick weg.
        root.execute("ALTER TABLE bericht_stand DISABLE TRIGGER bericht_stand_append_only");
        root.execute("ALTER TABLE bericht_stand DROP CONSTRAINT bericht_stand_pruefsumme_chk");
        try {
            root.update("UPDATE bericht_stand SET abzug = replace(abzug, '\"Werk Ahrenberg\"', '\"Werk Ahrenbrg\"') "
                    + "WHERE bericht_id = ? AND nr = 1", st);
        } finally {
            root.execute("ALTER TABLE bericht_stand ADD CONSTRAINT bericht_stand_pruefsumme_chk "
                    + "CHECK (pruefsumme = bericht_pruefsumme(abzug)) NOT VALID");
            root.execute("ALTER TABLE bericht_stand ENABLE TRIGGER bericht_stand_append_only");
        }
        Antwort a = abgelehnt(ruf(w.ines(), HttpMethod.GET, PFAD + "/BR-2026-0001/staende/1", null), 500, "abzug_beschaedigt");
        assertThat(a.body().get("message").asText()).isEqualTo(
                "Der Berichtsstand Nr. 1 kann nicht gelesen werden: die Prüfsumme stimmt nicht. Bitte wenden Sie sich an VoltPilot.");
        assertThat(a.text()).doesNotContain("Werk Ahrenbrg");
        abgelehnt(ruf(w.ines(), HttpMethod.GET, PFAD + "/BR-2026-0001/entwurf/vergleich?gegen=1", null), 500,
                "abzug_beschaedigt");
    }

    // =========================================================================== B13

    /**
     * B13 an den Routen: jede Zeile, die in diesem Paket eine Route hat (die vier Export-Zeilen haben ihre Route mit IP-10 —
     * ihr Urteil prüft {@code BerichtRechteTest}), dazu die Teilansicht und die Liste. Keine Ablehnung schreibt etwas.
     */
    @Test
    void b13DieZeilenDerMatrixAnDenRoutenUndDieTeilansicht() throws Exception {
        Welt w = welt();
        UUID ahrenberg = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        UUID lindach = bericht(w, "BR-2026-0003", "monatsbericht_standort", w.st2(), "2026-10");
        UUID unternehmen = bericht(w, "BR-2026-0002", "monatsbericht_unternehmen", null, "2026-10");
        for (UUID b : List.of(ahrenberg, lindach, unternehmen)) {
            entwurf(w, b, nummerEins, "2026-11-10T08:55:00+01:00");
        }
        uhr("2026-11-25T10:00:00+01:00");
        String st1 = PFAD + "/BR-2026-0001";
        String st2 = PFAD + "/BR-2026-0003";
        String u = PFAD + "/BR-2026-0002";

        // 1. Thomas (Unterstützer) bericht.standort_abrufen ST-1 → 403 — kein Kopf, kein Entwurf, keine Liste
        verboten(ruf(w.thomas(), HttpMethod.GET, st1, null));
        verboten(ruf(w.thomas(), HttpMethod.GET, st1 + "/entwurf", null));
        verboten(ruf(w.thomas(), HttpMethod.GET, PFAD, null));
        verboten(ruf(w.voss(), HttpMethod.GET, st1 + "/entwurf", null));
        verboten(ruf(w.voss(), HttpMethod.GET, PFAD, null));
        // 3. Claudia (Leserin) bericht.standort_abrufen ST-1 → ja
        Antwort claudia = ok(ruf(w.claudia(), HttpMethod.GET, st1 + "/entwurf", null), 200);
        assertThat(claudia.body().get("neu_gebildet").asBoolean()).isFalse();
        assertThat(claudia.body().get("teilansicht")).isEqualTo(MAPPER.readTree("[\"Werk Ahrenberg\", \"Werk Lindach\"]"));
        // 5. Claudia bericht.standort_freigeben ST-1 → 403
        verboten(ruf(w.claudia(), HttpMethod.POST, st1 + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")));
        // 7. Peter (Bearbeiter Lindach) bericht.standort_freigeben ST-1 → 404 — auch lesen
        abgelehnt(ruf(w.peter(), HttpMethod.POST, st1 + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 404,
                "nicht_gefunden");
        abgelehnt(ruf(w.peter(), HttpMethod.GET, st1, null), 404, "nicht_gefunden");
        // 8. Peter bericht.unternehmen → 403
        verboten(ruf(w.peter(), HttpMethod.GET, u, null));
        verboten(ruf(w.peter(), HttpMethod.POST, u + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")));
        // 10. Murat (Bedienberechtigt Ahrenberg) bericht.standort_abrufen ST-1 → ja
        Antwort murat = ok(ruf(w.murat(), HttpMethod.GET, st1 + "/entwurf", null), 200);
        assertThat(murat.body().get("teilansicht")).isEqualTo(MAPPER.readTree("[\"Werk Ahrenberg\"]"));
        // 11. Murat bericht.standort_freigeben ST-1 → 403
        verboten(ruf(w.murat(), HttpMethod.POST, st1 + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")));
        verboten(ruf(w.murat(), HttpMethod.POST, st1 + "/archivieren", null));
        // 12. Ines (Energiemanagerin) bericht.unternehmen → ja, unternehmensweit ohne Teilansicht
        Antwort ines = ok(ruf(w.ines(), HttpMethod.GET, u + "/entwurf", null), 200);
        assertThat(ines.body().get("teilansicht").isNull()).isTrue();
        ok(ruf(w.ines(), HttpMethod.GET, u, null), 200);
        assertThat(zaehle("bericht_stand", w) + zaehle("bericht_aenderung", w)).isZero();

        // 6. Peter bericht.standort_freigeben ST-2 → ja (201), Teilansicht „Werk Lindach“
        Antwort peter = ok(ruf(w.peter(), HttpMethod.POST, st2 + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 201);
        assertThat(peter.body().get("teilansicht")).isEqualTo(MAPPER.readTree("[\"Werk Lindach\"]"));
        assertThat(peter.body().get("freigegeben_von").get("rolle").asText()).isEqualTo("bearbeiter");
        assertThat(root.queryForObject("SELECT actor_rolle FROM bericht_aenderung WHERE bericht_id = ?", String.class, lindach))
                .isEqualTo("bearbeiter");

        // Die Liste zeigt jeder Person nur, was sie lesen darf
        assertThat(kennungen(ok(ruf(w.peter(), HttpMethod.GET, PFAD, null), 200))).containsExactly("BR-2026-0003");
        assertThat(kennungen(ok(ruf(w.murat(), HttpMethod.GET, PFAD, null), 200))).containsExactly("BR-2026-0001");
        assertThat(kennungen(ok(ruf(w.claudia(), HttpMethod.GET, PFAD, null), 200)))
                .containsExactlyInAnyOrder("BR-2026-0001", "BR-2026-0003");
        assertThat(kennungen(ok(ruf(w.ines(), HttpMethod.GET, PFAD, null), 200)))
                .containsExactlyInAnyOrder("BR-2026-0001", "BR-2026-0002", "BR-2026-0003");
        assertThat(zaehle("bericht_stand", w)).isEqualTo(1);
    }

    /** Ein fremder Kundenbereich ist 404 an jeder Route — auch für eine Person mit jedem Recht. */
    @Test
    void einFremderKundenbereichIstUeberall404() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        entwurf(w, st, nummerEins, "2026-11-10T08:55:00+01:00");
        uhr("2026-11-25T10:00:00+01:00");
        String k = PFAD + "/BR-2026-0001";
        for (String pfad : List.of(k, k + "/entwurf", k + "/entwurf/vergleich?gegen=1", k + "/staende/1")) {
            abgelehnt(ruf(fremd.jonas(), HttpMethod.GET, pfad, null), 404, "nicht_gefunden");
        }
        abgelehnt(ruf(fremd.jonas(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 404,
                "nicht_gefunden");
        abgelehnt(ruf(fremd.jonas(), HttpMethod.POST, k + "/archivieren", null), 404, "nicht_gefunden");
        abgelehnt(ruf(fremd.jonas(), HttpMethod.POST, PFAD, Map.of("vorlage", "monatsbericht_standort",
                "geltung_id", w.st1().toString(), "zeitraum", "2026-11")), 404, "geltung_unbekannt");
        assertThat(ok(ruf(fremd.jonas(), HttpMethod.GET, PFAD, null), 200).body().get("berichte")).isEmpty();
    }

    // =========================================================================== Revision

    /**
     * R1–R5: ein Anstoß macht „Revision nötig“, der Vergleich nennt jede Abweichung (Regel {@code abweichungen}, aufgerufen),
     * Verwerfen braucht eine Begründung und geht einmal, eine Revision Nr. 2 trägt den offenen Anstoß als Anlass, erledigt ihn,
     * ersetzt Nr. 1 — und ist wieder Byte für Byte ihr Entwurf.
     */
    @Test
    void revisionVergleichVerwerfenUndNummerZwei() throws Exception {
        Welt w = welt();
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        entwurf(w, st, nummerEins, "2026-11-10T08:55:00+01:00");
        String k = PFAD + "/BR-2026-0001";
        uhr("2026-11-10T09:02:00+01:00");
        ok(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 201);
        assertThat(liste(w.ines()).get("stand_text").asText()).isEqualTo("Berichtsstand Nr. 1");

        // Die Kaskade (IP-8) stößt an und bildet den Entwurf neu — hier von Hand
        UUID stand1 = root.queryForObject("SELECT id FROM bericht_stand WHERE bericht_id = ? AND nr = 1", UUID.class, st);
        UUID verworfen = anstoss(w, stand1, "K-2026-0007", 2, "2026-11-12T10:05:33+01:00");
        entwurf(w, st, nummerZwei, "2026-11-12T10:05:33+01:00");
        uhr("2026-11-13T09:00:00+01:00");
        JsonNode eintrag = liste(w.ines());
        assertThat(eintrag.get("stand_zeichen").asText()).isEqualTo("revision_noetig");
        assertThat(eintrag.get("stand_text").asText()).isEqualTo("Revision nötig — Korrektur K-2026-0007");

        Antwort v = ok(ruf(w.claudia(), HttpMethod.GET, k + "/entwurf/vergleich?gegen=1", null), 200);
        List<Map<String, Object>> soll = BerichtRegeln.abweichungen(EXAKT.readTree(nummerEins), EXAKT.readTree(nummerZwei))
                .stream().map(BerichtService::abweichung).toList();
        assertThat(soll).isNotEmpty();
        assertThat(v.body().get("abweichungen")).isEqualTo(MAPPER.valueToTree(soll));
        assertThat(Instant.parse(v.body().get("entwurf_datenstand").asText())).isEqualTo(t("2026-11-12T10:05:33+01:00"));
        abgelehnt(ruf(w.ines(), HttpMethod.GET, k + "/entwurf/vergleich?gegen=2", null), 404, "stand_gibt_es_nicht");
        abgelehnt(ruf(w.ines(), HttpMethod.GET, k + "/entwurf/vergleich", null), 400, "anfrage_ungueltig");

        String a = k + "/anstoesse/" + verworfen + "/verwerfen";
        abgelehnt(ruf(w.ines(), HttpMethod.POST, a, Map.of("begruendung", "zu kurz")), 422, "begruendung_fehlt");
        verboten(ruf(w.claudia(), HttpMethod.POST, a, Map.of("begruendung", "Korrektur betrifft nur den 31.10.")));
        abgelehnt(ruf(w.ines(), HttpMethod.POST, k + "/anstoesse/" + UUID.randomUUID() + "/verwerfen",
                Map.of("begruendung", "Korrektur betrifft nur den 31.10.")), 404, "nicht_gefunden");
        String grund = "Korrektur betrifft nur den 31.10. nach Betriebsschluss, Bericht bleibt";
        Antwort weg = ok(ruf(w.ines(), HttpMethod.POST, a, Map.of("begruendung", grund)), 200);
        assertThat(weg.body().get("zustand").asText()).isEqualTo("verworfen");
        assertThat(weg.body().get("verworfen_von").get("name").asText()).isEqualTo("Ines Kaltenbach");
        assertThat(weg.body().get("anlass_text").asText()).isEqualTo("Korrektur K-2026-0007");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, a, Map.of("begruendung", grund)), 409, "anstoss_nicht_offen");
        assertThat(liste(w.ines()).get("stand_text").asText()).isEqualTo("Anstoß verworfen (" + grund + ")");

        // Ein zweiter Anstoß — die Revision erledigt ihn
        UUID offen = anstoss(w, stand1, "K-2026-0007", 3, "2026-11-14T08:00:00+01:00");
        uhr("2026-11-16T14:20:00+01:00");
        Antwort nr2 = ok(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-12T10:05:33+01:00")), 201);
        assertThat(nr2.body().get("nr").asInt()).isEqualTo(2);
        assertThat(nr2.body().get("pruefsumme").asText()).isEqualTo(BerichtRegeln.pruefsumme(nummerZwei));
        assertThat(nr2.body().get("anlass_anstoss_id").asText()).isEqualTo(offen.toString());
        assertThat(nr2.text()).contains("\"abzug\":" + nummerZwei + "}");

        JsonNode detail = ok(ruf(w.claudia(), HttpMethod.GET, k, null), 200).body();
        assertThat(detail.get("staende")).hasSize(2);
        assertThat(detail.get("staende").get(0).get("ersetzt_durch_nr").asInt()).isEqualTo(2);
        assertThat(detail.get("staende").get(1).get("ersetzt_durch_nr").isNull()).isTrue();
        assertThat(detail.get("anstoesse").get(0).get("zustand").asText()).isEqualTo("verworfen");
        assertThat(detail.get("anstoesse").get(1).get("zustand").asText()).isEqualTo("erledigt");
        assertThat(detail.get("anstoesse").get(1).get("erledigt_durch_nr").asInt()).isEqualTo(2);
        assertThat(detail.get("bericht").get("stand_text").asText()).isEqualTo("Berichtsstand Nr. 2");
        assertThat(ok(ruf(w.claudia(), HttpMethod.GET, k + "/staende/1", null), 200).text())
                .contains("\"abzug\":" + nummerEins + "}");
        assertThat(root.queryForList("SELECT art FROM bericht_aenderung WHERE bericht_id = ? ORDER BY id", String.class, st))
                .containsExactly("freigeben", "verwerfen", "freigeben");
    }

    // =========================================================================== B14 — die Ausgabe CSV (IP-10)

    /**
     * B14 über die Route: Jonas ruft Nr. 1 am 20.11.2026 17:45 als CSV ab — Kopf und MS-12 Byte für Byte der Vektor, zwei
     * Abrufe byte-gleich und beide protokolliert (Tabelle und {@code bericht_abgerufen}); Claudias Datei trägt ihre
     * Teilansicht; nach Nr. 2 trägt Nr. 1 das Wasserzeichen. Unterstützer und Plattform nie, Peter sieht ST-1 nicht.
     */
    @Test
    void b14DerCsvEinesStandsIstDerAbzugInKundenformUndJederAbrufIstProtokolliert() throws Exception {
        List<JsonNode> b14 = new ArrayList<>();
        EXAKT.readTree(Files.readString(Path.of("..", "..", "docs", "contracts", "v2", "bericht-vectors.json")))
                .path("cases").forEach(c -> {
                    if ("B14".equals(c.path("id").asText())) {
                        c.path("pruefungen").forEach(b14::add);
                    }
                });
        Welt w = welt();
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        entwurf(w, st, nummerEins, "2026-11-10T08:55:00+01:00");
        String k = PFAD + "/BR-2026-0001";
        uhr("2026-11-10T09:02:00+01:00");
        ok(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 201);

        // Nie eine Datei ohne Recht (G2), nie die eines Stands, den es nicht gibt — und dann auch kein Abruf
        uhr("2026-11-20T17:45:00+01:00");
        verboten(ruf(w.thomas(), HttpMethod.GET, k + "/staende/1/csv", null));
        verboten(ruf(w.voss(), HttpMethod.GET, k + "/staende/1/csv", null));
        abgelehnt(ruf(w.peter(), HttpMethod.GET, k + "/staende/1/csv", null), 404, "nicht_gefunden");
        abgelehnt(ruf(w.jonas(), HttpMethod.GET, k + "/staende/2/csv", null), 404, "stand_gibt_es_nicht");
        abgelehnt(ruf(w.jonas(), HttpMethod.GET, k + "/staende/entwurf/csv", null), 404, "nicht_gefunden");
        assertThat(zaehle("bericht_abruf", w)).isZero();

        // Jonas: Kopf (16 Zeilen) und MS-12 Byte für Byte der Vektor; zwei Abrufe byte-gleich
        MvcResult erster = datei(w.jonas(), k + "/staende/1/csv");
        assertThat(erster.getResponse().getStatus()).isEqualTo(200);
        assertThat(erster.getResponse().getContentType()).isEqualTo("text/csv;charset=UTF-8");
        assertThat(erster.getResponse().getHeader("Content-Disposition"))
                .isEqualTo("attachment; filename=bericht-BR-2026-0001-nr1.csv");
        byte[] bytes = erster.getResponse().getContentAsByteArray();
        assertThat(new byte[] {bytes[0], bytes[1], bytes[2]}).as("BOM").containsExactly(0xEF, 0xBB, 0xBF);
        List<String> zeilen = zeilen(bytes);
        assertThat(zeilen.subList(0, 16)).containsExactlyElementsOf(texte(b14.get(0).path("ergebnis").path("zeilen")));
        assertThat(zeilen.get(16)).isEqualTo(String.join(";", BerichtRegeln.CSV_SPALTEN));
        assertThat(zeilen).contains(b14.get(1).path("ergebnis").path("zeile").asText());
        assertThat(zeilen).as("KZ-0001 — ort und endgültig ab trägt der Abzug 1.1 nicht (firstmate 001)")
                .anySatisfy(z -> assertThat(z).startsWith("KZ-0001;").contains(";2026-10;0,1488;"));
        assertThat(datei(w.jonas(), k + "/staende/1/csv").getResponse().getContentAsByteArray())
                .as("zwei Abrufe, byte-gleich").isEqualTo(bytes);

        List<Map<String, Object>> abrufe = root.queryForList("SELECT a.id, a.format, a.teilansicht, a.actor_name, "
                + "a.actor_rolle, a.actor_art, a.abgerufen_am, s.nr FROM bericht_abruf a JOIN bericht_stand s "
                + "ON s.id = a.stand_id WHERE a.tenant_id = ? ORDER BY a.id", w.mandant());
        assertThat(abrufe).as("zwei Abrufe, zwei Zeilen").hasSize(2).allSatisfy(a -> {
            assertThat(a).containsEntry("format", "csv").containsEntry("teilansicht", false)
                    .containsEntry("actor_name", "Jonas Wendlinger").containsEntry("actor_rolle", "kundenadministrator")
                    .containsEntry("actor_art", "kunde").containsEntry("nr", 1);
            assertThat(((Timestamp) a.get("abgerufen_am")).toInstant()).isEqualTo(t("2026-11-20T17:45:00+01:00"));
        });
        List<Map<String, Object>> meldungen = root.queryForList("SELECT ereignis_id, urheber, kennungen->>'bericht' AS bericht, "
                + "nutzlast->>'nr' AS nr, nutzlast->>'format' AS format FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND art = 'bericht_abgerufen'", w.mandant());
        assertThat(meldungen).hasSize(2).allSatisfy(m -> assertThat(m).containsEntry("urheber", "kunde")
                .containsEntry("bericht", "BR-2026-0001").containsEntry("nr", "1").containsEntry("format", "csv"));
        assertThat(meldungen.stream().map(m -> m.get("ereignis_id")).toList())
                .containsExactlyInAnyOrderElementsOf(abrufe.stream().map(a -> a.get("id")).toList());

        // Claudia (Leserin an beiden Werken): ihre Teilansicht im Kopf (G3) — B14-Randfall Byte für Byte
        uhr("2026-11-12T08:10:00+01:00");
        MvcResult claudia = datei(w.claudia(), k + "/staende/1/csv");
        assertThat(claudia.getResponse().getStatus()).isEqualTo(200);
        assertThat(zeilen(claudia.getResponse().getContentAsByteArray()).subList(0, 16))
                .containsExactlyElementsOf(texte(b14.get(4).path("ergebnis").path("zeilen")));
        assertThat(root.queryForObject("SELECT teilansicht FROM bericht_abruf WHERE tenant_id = ? AND actor_name = ?",
                Boolean.class, w.mandant(), "Claudia Berger")).isTrue();

        // Nach der Revision: Nr. 1 trägt das Wasserzeichen, Nr. 2 nicht
        UUID stand1 = root.queryForObject("SELECT id FROM bericht_stand WHERE bericht_id = ? AND nr = 1", UUID.class, st);
        anstoss(w, stand1, "K-2026-0007", 2, "2026-11-12T10:05:33+01:00");
        entwurf(w, st, nummerZwei, "2026-11-12T10:05:33+01:00");
        uhr("2026-11-16T14:20:00+01:00");
        ok(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-12T10:05:33+01:00")), 201);
        uhr("2026-11-20T17:50:00+01:00");
        List<String> eins = zeilen(datei(w.jonas(), k + "/staende/1/csv").getResponse().getContentAsByteArray());
        assertThat(eins.get(4)).isEqualTo("# stand=1");
        assertThat(eins.get(12)).isEqualTo(zeilen.get(12));
        assertThat(eins.get(16)).isEqualTo("# wasserzeichen="
                + BerichtRegeln.ersetztDurch(2, t("2026-11-16T14:20:00+01:00"), ZoneId.of("Europe/Berlin")))
                .contains("(16.11.2026)");
        List<String> zwei = zeilen(datei(w.jonas(), k + "/staende/2/csv").getResponse().getContentAsByteArray());
        assertThat(zwei.get(4)).isEqualTo("# stand=2");
        assertThat(zwei.get(12)).isEqualTo("# pruefsumme=" + BerichtRegeln.pruefsumme(nummerZwei));
        assertThat(zwei.get(16)).isEqualTo(String.join(";", BerichtRegeln.CSV_SPALTEN));
        assertThat(zaehle("bericht_abruf", w)).isEqualTo(5);
    }

    /**
     * B14 für das PDF (AP-12 IP-11, DA2/DA5): dieselben Ablehnungen wie am CSV, das Recht ist das des Abrufens (G1). Die
     * Datei ist die reine Funktion des Abzugs ({@link BerichtPdf}) — Jonas, später noch einmal Jonas und Claudia mit ihrer
     * Teilansicht bekommen DIESELBEN Bytes; jeder Abruf steht mit Format {@code pdf} im Protokoll. Nach der Revision trägt
     * Nr. 1 das Wasserzeichen, Nr. 2 nicht.
     */
    @Test
    void dasPdfEinesStandsIstDerAbzugByteGleichFuerJedenUndJederAbrufIstProtokolliert() throws Exception {
        Welt w = welt();
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        entwurf(w, st, nummerEins, "2026-11-10T08:55:00+01:00");
        String k = PFAD + "/BR-2026-0001";
        uhr("2026-11-10T09:02:00+01:00");
        ok(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 201);

        // Nie eine Datei ohne Recht (G2), nie die eines Stands, den es nicht gibt — und dann auch kein Abruf
        uhr("2026-11-20T17:45:00+01:00");
        verboten(ruf(w.thomas(), HttpMethod.GET, k + "/staende/1/pdf", null));
        verboten(ruf(w.voss(), HttpMethod.GET, k + "/staende/1/pdf", null));
        abgelehnt(ruf(w.peter(), HttpMethod.GET, k + "/staende/1/pdf", null), 404, "nicht_gefunden");
        abgelehnt(ruf(w.jonas(), HttpMethod.GET, k + "/staende/2/pdf", null), 404, "stand_gibt_es_nicht");
        abgelehnt(ruf(w.jonas(), HttpMethod.GET, k + "/staende/entwurf/pdf", null), 404, "nicht_gefunden");
        assertThat(zaehle("bericht_abruf", w)).isZero();

        MvcResult erster = datei(w.jonas(), k + "/staende/1/pdf");
        assertThat(erster.getResponse().getStatus()).isEqualTo(200);
        assertThat(erster.getResponse().getContentType()).isEqualTo("application/pdf");
        assertThat(erster.getResponse().getHeader("Content-Disposition"))
                .isEqualTo("attachment; filename=bericht-BR-2026-0001-nr1.pdf");
        byte[] bytes = erster.getResponse().getContentAsByteArray();
        assertThat(bytes.length).as("unter 1 MB je Monatsbericht").isLessThan(1_000_000);
        assertThat(pdfText(bytes)).contains("BR-2026-0001", "Berichtsstand Nr. 1", "Datenstand 10.11.2026 08:55 (MEZ)",
                "freigegeben 10.11.2026 09:02 von Ines Kaltenbach", BerichtRegeln.pruefsumme(nummerEins), "6.100 kWh")
                .doesNotContain("ersetzt durch");
        assertThat(bytes).as("server-seitig NUR aus dem Abzug und der Freigabe").isEqualTo(BerichtPdf.datei(
                BerichtService.baum(nummerEins), new BerichtCsv.Stand(1, t("2026-11-10T09:02:00+01:00"), "Ines Kaltenbach",
                        BerichtRegeln.pruefsumme(nummerEins), null, null)));

        uhr("2026-11-21T08:00:00+01:00");
        assertThat(datei(w.jonas(), k + "/staende/1/pdf").getResponse().getContentAsByteArray())
                .as("ein späterer Abruf, byte-gleich").isEqualTo(bytes);
        uhr("2026-11-12T08:10:00+01:00");
        MvcResult claudia = datei(w.claudia(), k + "/staende/1/pdf");
        assertThat(claudia.getResponse().getStatus()).isEqualTo(200);
        assertThat(claudia.getResponse().getContentAsByteArray()).as("Claudia mit Teilansicht (G3): dieselbe Datei")
                .isEqualTo(bytes);

        List<Map<String, Object>> abrufe = root.queryForList("SELECT id, format, teilansicht, actor_name FROM bericht_abruf "
                + "WHERE tenant_id = ?", w.mandant());
        assertThat(abrufe).allSatisfy(a -> assertThat(a).containsEntry("format", "pdf"));
        assertThat(abrufe.stream().map(a -> a.get("actor_name") + "/" + a.get("teilansicht")).toList())
                .containsExactlyInAnyOrder("Jonas Wendlinger/false", "Jonas Wendlinger/false", "Claudia Berger/true");
        List<Map<String, Object>> meldungen = root.queryForList("SELECT ereignis_id, nutzlast->>'nr' AS nr, "
                + "nutzlast->>'format' AS format FROM messreihe_ereignis WHERE tenant_id = ? AND art = 'bericht_abgerufen'",
                w.mandant());
        assertThat(meldungen).hasSize(3).allSatisfy(m -> assertThat(m).containsEntry("nr", "1").containsEntry("format", "pdf"));
        assertThat(meldungen.stream().map(m -> m.get("ereignis_id")).toList())
                .containsExactlyInAnyOrderElementsOf(abrufe.stream().map(a -> a.get("id")).toList());

        // Nach der Revision: Nr. 1 trägt das Wasserzeichen (und ist so wieder byte-gleich), Nr. 2 nicht
        UUID stand1 = root.queryForObject("SELECT id FROM bericht_stand WHERE bericht_id = ? AND nr = 1", UUID.class, st);
        anstoss(w, stand1, "K-2026-0007", 2, "2026-11-12T10:05:33+01:00");
        entwurf(w, st, nummerZwei, "2026-11-12T10:05:33+01:00");
        uhr("2026-11-16T14:20:00+01:00");
        ok(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-12T10:05:33+01:00")), 201);
        uhr("2026-11-20T17:50:00+01:00");
        byte[] einsErsetzt = datei(w.jonas(), k + "/staende/1/pdf").getResponse().getContentAsByteArray();
        assertThat(einsErsetzt).isNotEqualTo(bytes)
                .isEqualTo(datei(w.jonas(), k + "/staende/1/pdf").getResponse().getContentAsByteArray());
        assertThat(pdfText(einsErsetzt)).contains("Berichtsstand Nr. 1", "ersetzt durch Nr. 2 (16.11.2026)");
        assertThat(pdfText(datei(w.jonas(), k + "/staende/2/pdf").getResponse().getContentAsByteArray()))
                .contains("Berichtsstand Nr. 2", BerichtRegeln.pruefsumme(nummerZwei), "K-2026-0007")
                .doesNotContain("ersetzt durch");
        assertThat(zaehle("bericht_abruf", w)).isEqualTo(6);
    }

    /**
     * E12 G1 am Bestand-Geräte-CSV (DA4) über die Route: Jonas bekommt die Datei mit neun Kopfzeilen mehr (Standort und
     * Unternehmen von heute), Thomas (Unterstützer) und Lena Voss (Plattform) 403 statt der Datei; Claudia darf am Werk, nicht
     * an einer Anlage ohne Standort (403); Peter sieht Werk Ahrenberg nicht (404).
     */
    @Test
    void derBestandGeraeteCsvGehoertZuExportStandort_dieUnterstuetzungBekommt403() throws Exception {
        Welt w = welt();
        String kurz = w.mandant().toString().substring(0, 8).toUpperCase();
        UUID an1 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-1') RETURNING id", UUID.class,
                w.mandant());
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab, created_by) "
                + "VALUES (?, ?, ?, '2024-01-01', 'test')", w.mandant(), an1, w.st1());
        UUID box1 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, ?, 'claimed') RETURNING id", UUID.class, w.mandant(), an1, "VP-BOX-IP10-" + kurz + "-1");
        UUID an9 = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'AN-9') RETURNING id", UUID.class,
                w.mandant());
        UUID box9 = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, ?, 'claimed') RETURNING id", UUID.class, w.mandant(), an9, "VP-BOX-IP10-" + kurz + "-9");
        String export = "/measurement-selection/deye.hybrid_1p.meter.today-energy/export?range=24h";

        MvcResult jonas = datei(w.jonas(), "/api/v1/devices/" + box1 + export);
        assertThat(jonas.getResponse().getStatus()).as(jonas.getResponse().getContentAsString()).isEqualTo(200);
        List<String> z = List.of(jonas.getResponse().getContentAsString(StandardCharsets.UTF_8).split("\n"));
        assertThat(z.get(14)).startsWith("# catalog_version_gespeichert=");
        assertThat(z.subList(15, 24)).extracting(s -> s.substring(2, s.indexOf('=')))
                .containsExactlyElementsOf(com.voltpilot.api.measurement.MeasurementHistoryService.KOPF_ERZEUGUNG);
        assertThat(z.subList(18, 24)).containsExactly("# erzeugt_von=\"Jonas Wendlinger\"", "# zeitzone=\"UTC\"",
                "# dezimal=\".\"", "# trenner=\",\"", "# standort=\"ST-1 Werk Ahrenberg\"",
                "# unternehmen=\"Kunststoffwerk Ahrenberg GmbH\"");
        assertThat(z.get(24)).startsWith("time,value,min,max,text,sample_count,gap,");

        assertThat(datei(w.thomas(), "/api/v1/devices/" + box1 + export).getResponse().getStatus()).isEqualTo(403);
        assertThat(datei(w.voss(), "/api/v1/devices/" + box1 + export).getResponse().getStatus()).isEqualTo(403);
        assertThat(datei(w.claudia(), "/api/v1/devices/" + box1 + export).getResponse().getStatus()).isEqualTo(200);
        assertThat(datei(w.claudia(), "/api/v1/devices/" + box9 + export).getResponse().getStatus()).isEqualTo(403);
        assertThat(datei(w.peter(), "/api/v1/devices/" + box1 + export).getResponse().getStatus()).isEqualTo(404);
        MvcResult ohneStandort = datei(w.jonas(), "/api/v1/devices/" + box9 + export);
        assertThat(ohneStandort.getResponse().getStatus()).isEqualTo(200);
        assertThat(ohneStandort.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .contains("\n# standort=\n# unternehmen=\"Kunststoffwerk Ahrenberg GmbH\"\ntime,");
    }

    // =========================================================================== Archivieren, Anlegen

    @Test
    void ip11ExportUmfangStehtImCsvUndUnternehmensExportBleibt403() throws Exception {
        Welt w = welt();
        root.update("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, 'Werk Ahrenberg Nord', 'ST-3', 'Europe/Berlin', 'aktiv')", w.mandant(), w.unternehmen());
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        UUID u = bericht(w, "BR-2026-0002", "monatsbericht_unternehmen", null, "2026-10");
        for (UUID b : List.of(st, u)) {
            entwurf(w, b, nummerEins, "2026-11-10T08:55:00+01:00");
        }
        uhr("2026-11-10T09:02:00+01:00");
        ok(ruf(w.ines(), HttpMethod.POST, PFAD + "/BR-2026-0001/freigeben",
                datenstand("2026-11-10T08:55:00+01:00")), 201);
        for (String suffix : List.of("", "/entwurf", "/entwurf/vergleich?gegen=1", "/staende/1",
                "/staende/1/csv", "/staende/1/pdf")) {
            verboten(ruf(w.peter(), HttpMethod.GET, PFAD + "/BR-2026-0002" + suffix, null));
            verboten(ruf(w.thomas(), HttpMethod.GET, PFAD + "/BR-2026-0002" + suffix, null));
            abgelehnt(ruf(w.peter(), HttpMethod.GET, PFAD + "/BR-2026-0001" + suffix, null), 404, "nicht_gefunden");
        }
        String abzug = root.queryForObject("SELECT abzug FROM bericht_stand WHERE bericht_id = ?", String.class, st);
        String csv = datei(w.claudia(), PFAD + "/BR-2026-0001/staende/1/csv").getResponse()
                .getContentAsString(StandardCharsets.UTF_8);
        assertThat(csv).startsWith("\uFEFF# Teilansicht: Werk Ahrenberg, Werk Lindach (2 von 3 Standorten)\r\n")
                .doesNotContain("Werk Ahrenberg Nord");
        assertThat(datei(w.jonas(), PFAD + "/BR-2026-0001/staende/1/csv").getResponse()
                .getContentAsString(StandardCharsets.UTF_8)).doesNotContain("# Teilansicht:");
        assertThat(datei(w.claudia(), PFAD + "/BR-2026-0001/staende/1/pdf").getResponse().getContentAsByteArray())
                .isEqualTo(datei(w.jonas(), PFAD + "/BR-2026-0001/staende/1/pdf").getResponse().getContentAsByteArray());
        assertThat(root.queryForObject("SELECT abzug FROM bericht_stand WHERE bericht_id = ?", String.class, st))
                .as("ein freigegebener Stand wird nie für die Teilansicht gefiltert oder neu gerechnet").isEqualTo(abzug);
    }

    /**
     * AP-19 IP-12, R6 (RE3): „Einsicht“ liest den Unternehmens-Bericht, seinen Entwurf und seine Stände und lädt das PDF
     * — protokolliert mit {@code actor_rolle} {@code einsicht}, das Wort, das der getauschte CHECK
     * {@code bericht_abruf_actor_rolle_chk} erst trägt —; die CSV eines Stands ist Datenabfluss ({@code export.*} −,
     * 403) und schreibt keinen Abruf; anlegen, freigeben und archivieren sind 403 (nie eine Freigabe).
     */
    @Test
    void r6EinsichtLiestUndLaedtDasPdfAberNichtDieCsvUndGibtNichtsFrei() throws Exception {
        Welt w = welt();
        Wer robert = person(w.mandant(), "RF", "Robert Falk", "benutzer", zuweisung("einsicht", null));
        UUID u = bericht(w, "BR-2026-0002", "monatsbericht_unternehmen", null, "2026-10");
        entwurf(w, u, nummerEins, "2026-11-10T08:55:00+01:00");
        String k = PFAD + "/BR-2026-0002";
        uhr("2026-11-10T09:02:00+01:00");
        ok(ruf(robert, HttpMethod.GET, k + "/entwurf", null), 200);
        verboten(ruf(robert, HttpMethod.POST, PFAD, anlegen("monatsbericht_unternehmen", w.unternehmen(), "2026-11")));
        verboten(ruf(robert, HttpMethod.POST, k + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")));
        ok(ruf(w.ines(), HttpMethod.POST, k + "/freigeben", datenstand("2026-11-10T08:55:00+01:00")), 201);

        uhr("2026-11-20T17:45:00+01:00");
        ok(ruf(robert, HttpMethod.GET, k, null), 200);
        ok(ruf(robert, HttpMethod.GET, k + "/staende/1", null), 200);
        verboten(ruf(robert, HttpMethod.GET, k + "/staende/1/csv", null));
        verboten(ruf(robert, HttpMethod.POST, k + "/archivieren", null));
        MvcResult pdf = datei(robert, k + "/staende/1/pdf");
        assertThat(pdf.getResponse().getStatus()).isEqualTo(200);
        assertThat(pdf.getResponse().getContentType()).isEqualTo("application/pdf");
        assertThat(pdf.getResponse().getContentAsByteArray()).as("dieselbe Datei wie für den Kundenadministrator")
                .isEqualTo(datei(w.jonas(), k + "/staende/1/pdf").getResponse().getContentAsByteArray());

        List<Map<String, Object>> abrufe = root.queryForList("SELECT actor_name, actor_rolle, actor_art, format, "
                + "teilansicht FROM bericht_abruf WHERE tenant_id = ? ORDER BY abgerufen_am, actor_name", w.mandant());
        assertThat(abrufe).as("zwei PDF-Abrufe, keine CSV").hasSize(2)
                .allSatisfy(a -> assertThat(a).containsEntry("format", "pdf").containsEntry("teilansicht", false));
        assertThat(abrufe.stream().map(a -> a.get("actor_name") + "/" + a.get("actor_rolle") + "/" + a.get("actor_art"))
                .toList()).containsExactlyInAnyOrder("Robert Falk/einsicht/kunde", "Jonas Wendlinger/kundenadministrator/kunde");
    }

    /** V4: Archivieren verbirgt den Bericht in der Liste, der Bericht bleibt lesbar; ein zweites Mal ändert nichts. */
    @Test
    void archivierenVerbirgtInDerListeUndIstEinmalig() throws Exception {
        Welt w = welt();
        UUID st = bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        entwurf(w, st, nummerEins, "2026-11-10T08:55:00+01:00");
        uhr("2026-11-20T11:00:00+01:00");
        String k = PFAD + "/BR-2026-0001";
        abgelehnt(ruf(w.ines(), HttpMethod.POST, k + "/archivieren", Map.of("grund", "alt")), 400, "anfrage_ungueltig");
        Antwort a = ok(ruf(w.ines(), HttpMethod.POST, k + "/archivieren", null), 200);
        assertThat(Instant.parse(a.body().get("archiviert_am").asText())).isEqualTo(t("2026-11-20T11:00:00+01:00"));
        assertThat(ok(ruf(w.ines(), HttpMethod.GET, PFAD, null), 200).body().get("berichte")).isEmpty();
        ok(ruf(w.ines(), HttpMethod.GET, k, null), 200);
        uhr("2026-11-21T11:00:00+01:00");
        assertThat(ok(ruf(w.ines(), HttpMethod.POST, k + "/archivieren", null), 200).body().get("archiviert_am").asText())
                .isEqualTo(a.body().get("archiviert_am").asText());
        assertThat(root.queryForList("SELECT art FROM bericht_aenderung WHERE bericht_id = ?", String.class, st))
                .containsExactly("archivieren");
    }

    /**
     * Anlegen: jede Ablehnung in ihrer Reihenfolge, dann ein Bericht mit Kennung und Entwurf (gebildet von
     * {@link BerichtAbzugBildung}); ein späterer Abruf nach dem „endgültig ab“ bildet den Entwurf neu (D4).
     */
    @Test
    void anlegenMitSeinenAblehnungenDannEntwurfUndNeubildungBeimAbruf() throws Exception {
        Welt w = welt();
        bericht(w, "BR-2026-0001", "monatsbericht_standort", w.st1(), "2026-10");
        uhr("2026-11-02T10:00:00+01:00");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, PFAD, Map.of("vorlage", "monatsbericht_standort", "zeitraum", "2026-10")),
                400, "anfrage_ungueltig");
        Antwort vorlage = abgelehnt(ruf(w.ines(), HttpMethod.POST, PFAD, anlegen("wochenbericht", w.st2(), "2026-10")), 422,
                "vorlage_unbekannt");
        assertThat(vorlage.body().get("message").asText()).isEqualTo("Diese Berichtsvorlage gibt es nicht.");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st2(), "2026-13")), 400,
                "anfrage_ungueltig");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", UUID.randomUUID(), "2026-10")), 404,
                "geltung_unbekannt");
        abgelehnt(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st1(), "2026-10")), 404,
                "nicht_gefunden");
        verboten(ruf(w.claudia(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st2(), "2026-10")));
        verboten(ruf(w.voss(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st2(), "2026-10")));
        Antwort schon = abgelehnt(ruf(w.ines(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st1(), "2026-10")),
                409, "bericht_gibt_es_schon");
        assertThat(schon.body().get("message").asText())
                .isEqualTo("Diesen Bericht gibt es schon: BR-2026-0001 (Monatsbericht Werk Ahrenberg, Oktober 2026).");
        // Seit AP-12 IP-6 bildet das Anlegen den Abzug des Unternehmens — ohne Messstellen in seiner Geltung sagt es, warum.
        Antwort unternehmenLeer = abgelehnt(ruf(w.jonas(), HttpMethod.POST, PFAD, anlegen("monatsbericht_unternehmen",
                w.unternehmen(), "2026-10")), 422, "keine_quellen");
        assertThat(unternehmenLeer.body().get("message").asText())
                .isEqualTo("Für Kunststoffwerk Ahrenberg GmbH gibt es im Oktober 2026 keine Messstellen.");
        verboten(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("monatsbericht_unternehmen", w.unternehmen(), "2026-10")));
        Antwort leer = abgelehnt(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st2(), "2026-10")),
                422, "keine_quellen");
        assertThat(leer.body().get("message").asText()).isEqualTo("Für Werk Lindach gibt es im Oktober 2026 keine Messstellen.");

        // Werk Lindach misst seit dem 15.10.2026
        messstelle(w, "MS-18", "Montage Lindach", w.st2(), "2026-10-15");
        Antwort september = abgelehnt(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st2(),
                "2026-09")), 422, "keine_quellen");
        assertThat(september.body().get("message").asText())
                .isEqualTo("Für Werk Lindach gibt es im September 2026 keine Messstellen — der Standort besteht seit dem 15.10.2026.");
        assertThat(zaehle("bericht_aenderung", w)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM bericht WHERE tenant_id = ?", Long.class, w.mandant())).isEqualTo(1);

        Antwort neu = ok(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st2(), "2026-10")), 201);
        assertThat(neu.body().get("kennung").asText()).isEqualTo("BR-2026-0002");
        assertThat(neu.body().get("stand_zeichen").asText()).isEqualTo("entwurf");
        assertThat(neu.body().get("geltung_name").asText()).isEqualTo("Werk Lindach");
        assertThat(neu.body().get("zeitraum_text").asText()).isEqualTo("Oktober 2026");
        assertThat(Instant.parse(neu.body().get("entwurf_datenstand").asText())).isEqualTo(t("2026-11-02T10:00:00+01:00"));
        Map<String, Object> e = root.queryForMap("SELECT e.gebildet_von, e.pruefsumme, e.datenstand, b.angelegt_von_name, "
                + "(SELECT count(*) FROM bericht_quelle q WHERE q.bericht_id = b.id AND q.stand_nr IS NULL) AS quellen "
                + "FROM bericht b JOIN bericht_entwurf e ON e.bericht_id = b.id WHERE b.tenant_id = ? AND b.kennung = 'BR-2026-0002'",
                w.mandant());
        assertThat(e.get("gebildet_von")).isEqualTo("anlegen");
        assertThat(e.get("angelegt_von_name")).isEqualTo("Peter Hollerbach");
        assertThat(((Number) e.get("quellen")).intValue()).isPositive();
        assertThat(root.queryForList("SELECT art || '/' || actor_rolle FROM bericht_aenderung WHERE tenant_id = ?", String.class,
                w.mandant())).containsExactly("anlegen/bearbeiter");

        // Derselbe Tag: aktuell, nichts neu gebildet
        Antwort gleich = ok(ruf(w.peter(), HttpMethod.GET, PFAD + "/BR-2026-0002/entwurf", null), 200);
        assertThat(gleich.body().get("neu_gebildet").asBoolean()).isFalse();
        assertThat(gleich.body().get("pruefsumme").asText()).isEqualTo(e.get("pruefsumme"));
        assertThat(gleich.body().get("kopf").asText()).isEqualTo("Entwurf · Datenstand 02.11.2026 10:00 (MEZ)");

        // Nach dem „endgültig ab“ (08.11.) ist der Entwurf veraltet, ohne dass eine Zeile sich änderte — D4 bildet neu
        uhr("2026-11-09T08:00:00+01:00");
        Antwort spaeter = ok(ruf(w.peter(), HttpMethod.GET, PFAD + "/BR-2026-0002/entwurf", null), 200);
        assertThat(spaeter.body().get("neu_gebildet").asBoolean()).isTrue();
        assertThat(spaeter.body().get("gebildet_von").asText()).isEqualTo("abruf");
        assertThat(Instant.parse(spaeter.body().get("datenstand").asText())).isEqualTo(t("2026-11-09T08:00:00+01:00"));
        assertThat(ok(ruf(w.peter(), HttpMethod.GET, PFAD + "/BR-2026-0002/entwurf", null), 200).body().get("neu_gebildet")
                .asBoolean()).isFalse();
        assertThat(root.queryForObject("SELECT count(*) FROM messreihe_ereignis WHERE tenant_id = ? AND art LIKE 'bericht_%'",
                Long.class, w.mandant())).as("die Neubildung beim Abruf meldet nichts (B6)").isZero();
    }

    /**
     * V3 über die Route (AP-12 IP-14): {@code kennzahlen_abgewaehlt} beim Anlegen. Falsch geformt ist 400 vor allem anderen,
     * eine unbekannte oder fremde Kennzahl 400 erst nach {@code keine_quellen} — beides legt nichts an. Sonst steht die Abwahl
     * vor der ersten Bildung: schon der erste Entwurf lässt die Kennzahl weg, das Protokoll nennt ihr Kennzeichen. Ohne Liste
     * oder mit leerer bleibt das Anlegen, wie es war.
     */
    @Test
    void anlegenMitAbgewaehlterKennzahl_schonDerErsteEntwurfLaesstSieWeg() throws Exception {
        Welt w = welt();
        Welt fremd = welt();
        uhr("2026-11-02T10:00:00+01:00");
        messstelle(w, "MS-18", "Montage Lindach", w.st2(), "2026-10-01");
        messstelle(fremd, "MS-18", "Montage Lindach", fremd.st2(), "2026-10-01");
        kennzahlMitOktober(w, "KZ-0001", w.st2());
        UUID kz2 = kennzahlMitOktober(w, "KZ-0002", w.st2());
        UUID fremdeKz = kennzahlMitOktober(fremd, "KZ-0002", fremd.st2());

        List<Object> falsch = List.of(kz2.toString(), List.of("keine-kennung"), List.of(""), List.of(18),
                List.of(List.of(kz2.toString())), Map.of("id", kz2.toString()), Collections.nCopies(201, kz2.toString()));
        for (Object liste : falsch) {
            Antwort a = abgelehnt(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st2(), "2026-10",
                    liste)), 400, "anfrage_ungueltig");
            assertThat(a.body().get("feld").asText()).as(String.valueOf(liste)).isEqualTo("kennzahlen_abgewaehlt");
        }
        // Die Form prüft vor der Vorlage; ob es die Kennzahl gibt, erst nach den Messstellen (Reihenfolge des Dienstes).
        assertThat(abgelehnt(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("wochenbericht", w.st2(), "2026-10",
                List.of("keine-kennung"))), 400, "anfrage_ungueltig").body().get("feld").asText())
                .isEqualTo("kennzahlen_abgewaehlt");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st1(), "2026-10",
                List.of(UUID.randomUUID().toString()))), 422, "keine_quellen");
        abgelehnt(ruf(w.ines(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st1(), "2026-10", null)), 422,
                "keine_quellen");
        for (UUID unbekannt : List.of(UUID.randomUUID(), fremdeKz)) {
            Antwort a = abgelehnt(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st2(), "2026-10",
                    List.of(kz2.toString(), unbekannt.toString()))), 400, "anfrage_ungueltig");
            assertThat(a.body().get("feld").asText()).isEqualTo("kennzahlen_abgewaehlt");
        }
        assertThat(zaehle("bericht", w)).isZero();
        assertThat(zaehle("bericht_kennzahl_abwahl", w)).isZero();
        assertThat(zaehle("bericht_aenderung", w)).isZero();

        // Doppelt (auch in Großbuchstaben) fällt zusammen
        Antwort neu = ok(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("monatsbericht_standort", w.st2(), "2026-10",
                List.of(kz2.toString(), kz2.toString().toUpperCase()))), 201);
        String kennung = neu.body().get("kennung").asText();
        assertThat(zaehle("bericht_kennzahl_abwahl", w)).isEqualTo(1);
        Map<String, Object> abwahl = root.queryForMap("SELECT a.kennzahl_id, a.abgewaehlt_am, a.abgewaehlt_von_name, "
                + "a.abgewaehlt_von_sub = b.angelegt_von_sub AS von_der_person FROM bericht_kennzahl_abwahl a "
                + "JOIN bericht b ON b.id = a.bericht_id WHERE b.tenant_id = ? AND b.kennung = ? AND a.aufgehoben_am IS NULL",
                w.mandant(), kennung);
        assertThat(abwahl.get("kennzahl_id")).isEqualTo(kz2);
        assertThat(((Timestamp) abwahl.get("abgewaehlt_am")).toInstant()).isEqualTo(t("2026-11-02T10:00:00+01:00"));
        assertThat(abwahl.get("abgewaehlt_von_name")).isEqualTo("Peter Hollerbach");
        assertThat(abwahl.get("von_der_person")).isEqualTo(true);

        Antwort entwurf = ok(ruf(w.peter(), HttpMethod.GET, PFAD + "/" + kennung + "/entwurf", null), 200);
        assertThat(entwurf.body().get("neu_gebildet").asBoolean()).as("der Entwurf des Anlegens").isFalse();
        List<String> kennzahlen = new ArrayList<>();
        entwurf.body().get("abzug").path("kennzahlen").forEach(k -> kennzahlen.add(k.path("quelle").asText()));
        assertThat(kennzahlen).as("KZ-0002 ist abgewählt, KZ-0001 nicht").containsExactly("KZ-0001");
        assertThat(root.queryForObject("SELECT neu->>'kennzahlen_abgewaehlt' FROM bericht_aenderung a JOIN bericht b "
                + "ON b.id = a.bericht_id WHERE b.tenant_id = ? AND b.kennung = ? AND a.art = 'anlegen'", String.class,
                w.mandant(), kennung)).isEqualTo("[\"KZ-0002\"]");

        // Leere Liste: kein Eintrag im Protokoll, keine Abwahl-Zeile
        Antwort jahr = ok(ruf(w.peter(), HttpMethod.POST, PFAD, anlegen("jahresbericht_standort", w.st2(), "2026", List.of())),
                201);
        assertThat(root.queryForObject("SELECT neu::text FROM bericht_aenderung a JOIN bericht b ON b.id = a.bericht_id "
                + "WHERE b.tenant_id = ? AND b.kennung = ? AND a.art = 'anlegen'", String.class, w.mandant(),
                jahr.body().get("kennung").asText())).doesNotContain("kennzahlen_abgewaehlt");
        assertThat(zaehle("bericht_kennzahl_abwahl", w)).isEqualTo(1);
    }

    // =========================================================================== AP-12 IP-6: Unternehmensbericht

    /**
     * B3 über die echte Route (firstmate 003): Jonas legt den Monatsbericht des Unternehmens für Oktober an — der Entwurf ist
     * ein echter Abzug des Unternehmens mit Kostenstelle 4200 = 14 470 kWh (MS-12 6 100 + MS-18 3 600 + 30 % MS-07 15 900).
     * Nach K-2026-0007 (MS-12 am 18.10. in Version 2: 196 → 136 kWh) bildet der Abruf ihn neu (D4): 4200 = 14 410 kWh.
     */
    @Test
    void unternehmensberichtUeberDieRoute_b3Kostenstelle4200Mit14470_nachDerKorrekturBeimAbruf14410() throws Exception {
        Welt w = welt();
        unternehmenOktober(w);
        uhr("2026-11-10T08:57:00+01:00");
        Antwort neu = ok(ruf(w.jonas(), HttpMethod.POST, PFAD, anlegen("monatsbericht_unternehmen", w.unternehmen(),
                "2026-10")), 201);
        String entwurfPfad = PFAD + "/" + neu.body().get("kennung").asText() + "/entwurf";

        Antwort vorher = ok(ruf(w.jonas(), HttpMethod.GET, entwurfPfad, null), 200);
        assertThat(vorher.body().get("neu_gebildet").asBoolean()).isFalse();
        JsonNode abzug = vorher.body().get("abzug");
        assertThat(abzug.path("kopf").path("geltung").path("art").asText()).isEqualTo("unternehmen");
        assertThat(abzug.path("kopf").path("quellenverzeichnis")).extracting(JsonNode::asText).contains("4200", "MS-01");
        assertThat(kostenstelleIm(abzug, "4200").path("summe").path("menge").decimalValue()).as("B3 vorher")
                .isEqualByComparingTo("14470");

        korrekturMs12(w, "2026-11-12T10:05:33+01:00");
        uhr("2026-11-12T11:00:00+01:00");
        Antwort nachher = ok(ruf(w.jonas(), HttpMethod.GET, entwurfPfad, null), 200);
        assertThat(nachher.body().get("neu_gebildet").asBoolean()).as("D4: MS-12 hat eine neue Version").isTrue();
        assertThat(kostenstelleIm(nachher.body().get("abzug"), "4200").path("summe").path("menge").decimalValue())
                .as("B3 nachher").isEqualByComparingTo("14410");
        assertThat(nachher.body().get("pruefsumme").asText()).isNotEqualTo(vorher.body().get("pruefsumme").asText());
    }

    /**
     * Die Oktober-Daten des Unternehmens aus dem Referenzunternehmen: Netzbezug MS-01 (Hauptzähler Halle 1), die Tageswerte
     * von MS-07, MS-12 und MS-18 (ab 15.10. im Werk Lindach) und ihre Verteilung auf 4100/4200.
     */
    private static void unternehmenOktober(Welt w) {
        UUID an1 = anlage(w, "AN-1", w.st1(), "2024-03-12");
        UUID an3 = anlage(w, "AN-3", w.st2(), "2026-10-15");
        UUID ms01 = gezaehlt(w, "MS-01", "Netzbezug Halle 1", w.st1(), "2026-10-01", an1);
        root.update("INSERT INTO messstelle_stellung (tenant_id, messstelle_id, site_id, stellung, gueltig_ab) "
                + "VALUES (?, ?, ?, 'Hauptzähler', DATE '2024-03-12')", w.mandant(), ms01, an1);
        UUID ms07 = gezaehlt(w, "MS-07", "Druckluft Kompressoren K1+K2", w.st1(), "2026-10-01", an1);
        UUID ms12 = gezaehlt(w, "MS-12", "Montage Linie M1", w.st1(), "2026-10-01", an1);
        UUID ms18 = gezaehlt(w, "MS-18", "Montagehalle Lindach gesamt", w.st2(), "2026-10-15", an3);
        UUID k4100 = kostenstelleAnlegen(w, "4100", "Spritzguss");
        UUID k4200 = kostenstelleAnlegen(w, "4200", "Montage");
        String satz = "INSERT INTO messstelle_verteilung (tenant_id, messstelle_id, kostenstelle_id, anteil_prozent, "
                + "gueltig_ab, created_by) VALUES ";
        root.update(satz + "(?, ?, ?, 70, DATE '2026-10-01', 'test'), (?, ?, ?, 30, DATE '2026-10-01', 'test')",
                w.mandant(), ms07, k4100, w.mandant(), ms07, k4200);
        root.update(satz + "(?, ?, ?, 100, DATE '2026-10-01', 'test')", w.mandant(), ms12, k4200);
        root.update(satz + "(?, ?, ?, 100, DATE '2026-10-15', 'test')", w.mandant(), ms18, k4200);
        for (java.time.LocalDate d = java.time.LocalDate.parse("2026-10-01"); d.getMonthValue() == 10; d = d.plusDays(1)) {
            boolean letzter = d.getDayOfMonth() == 31;
            tageswert(w, "MS-07", d, letzter ? 600 : 510);
            tageswert(w, "MS-12", d, letzter ? 220 : 196);
            if (d.getDayOfMonth() >= 15) {
                tageswert(w, "MS-18", d, letzter ? 224 : 211);
            }
        }
    }

    private static UUID anlage(Welt w, String name, UUID standort, String ab) {
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, ?) RETURNING id", UUID.class,
                w.mandant(), name);
        root.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?::date)",
                w.mandant(), site, standort, ab);
        root.update("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, 'claimed')", w.mandant(),
                site, "VP-BOX-BERICHT-" + name + "-" + w.mandant());
        return site;
    }

    /** Eine gezählte Messstelle am Standort mit ihrer führenden Quelle (Komponente, Kanal energy_kwh). */
    private static UUID gezaehlt(Welt w, String kennzeichen, String name, UUID standort, String ab, UUID site) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') "
                + "RETURNING id", UUID.class, w.mandant(), kennzeichen, name);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, standort_id, gueltig_ab) VALUES (?, ?, ?, ?::date)",
                w.mandant(), ms, standort, ab);
        UUID box = root.queryForObject("SELECT id FROM device WHERE tenant_id = ? AND site_id = ?", UUID.class, w.mandant(),
                site);
        UUID entity = root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, entity_type, "
                + "device_id, communication, connection_json, created_at) VALUES (?, ?, 'grid-meter', ?, 'grid-meter', ?, "
                + "'modbus_tcp', '{\"ip\":\"10.0.0.9\",\"unit_id\":1}'::jsonb, '2024-03-12T00:00:00Z') RETURNING id",
                UUID.class, w.mandant(), site, "K " + kennzeichen, box);
        root.update("INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, entity_id, point_key, "
                + "enabled, cadence_s, desired_revision, enabled_at, catalog_version, changed_by, apply_status, "
                + "retention_class, long_term_strategy) VALUES (?, ?, ?, ?, 'energy_kwh', true, 60, 1, "
                + "'2024-03-12T00:00:00Z', '2026.09.11.1', 'test', 'pending_edge', 'live_power', 'fifteen_minute')",
                w.mandant(), site, box, entity);
        UUID geraet = root.queryForObject("SELECT geraet_id FROM geraet_komponente WHERE entity_id = ? "
                + "AND gueltig_bis IS NULL", UUID.class, entity);
        root.update("INSERT INTO messstelle_quelle (tenant_id, messstelle_id, groesse, richtung, entity_id, geraet_id, "
                + "kanal, kanal_wertart, herleitung, rolle, gueltig_ab, rueckwirkend, eingetragen_am, actor_sub, "
                + "actor_name, actor_art) VALUES (?, ?, 'Wirkenergie', 'Bezug', ?, ?, 'energy_kwh', 'counter', "
                + "'zaehlerstand', 'fuehrend', '2024-03-12T00:00:00Z', true, now(), 'sub', 'Probe', 'kunde')",
                w.mandant(), ms, entity, geraet);
        return ms;
    }

    private static UUID kostenstelleAnlegen(Welt w, String kennzeichen, String name) {
        return root.queryForObject("INSERT INTO kostenstelle (tenant_id, unternehmen_id, kennzeichen, name, gueltig_ab, "
                + "created_by) VALUES (?, ?, ?, ?, DATE '2026-10-01', 'test') RETURNING id", UUID.class, w.mandant(),
                w.unternehmen(), kennzeichen, name);
    }

    /** Ein gemessener, vollständiger, endgültiger Tageswert der führenden Reihe. */
    private static void tageswert(Welt w, String kennzeichen, java.time.LocalDate tag, long menge) {
        java.time.ZoneId zone = java.time.ZoneId.of("Europe/Berlin");
        int stunden = TagRegeln.stunden(tag, zone);
        Instant beginn = tag.atStartOfDay(zone).toInstant();
        Instant ende = tag.plusDays(1).atStartOfDay(zone).toInstant();
        root.update("INSERT INTO messreihe_tag (tag, tenant_id, entity_id, messkanal, zeitzone, zeitzone_herkunft, beginn, "
                + "ende, stunden, slots_erwartet, slots_vorhanden, slots_endgueltig, wertart, erhalten, erwartet, "
                + "abdeckung_prozent, rolle, zustand, endgueltig_ab, version, menge, menge_zustand, kennzeichen) "
                + "VALUES (?, ?, (SELECT q.entity_id FROM messstelle_quelle q JOIN messstelle m ON m.id = q.messstelle_id "
                + "WHERE m.tenant_id = ? AND m.kennzeichen = ?), 'energy_kwh', 'Europe/Berlin', 'vorgabe', ?, ?, ?, ?, ?, ?, "
                + "'counter', ?, ?, 100, 'fuehrend', 'endgueltig', ?, 1, ?, 'vollständig', '[]'::jsonb)", tag, w.mandant(),
                w.mandant(), kennzeichen, Timestamp.from(beginn), Timestamp.from(ende), stunden, stunden * 4, stunden * 4,
                stunden * 4, stunden * 60, stunden * 60, Timestamp.from(ende.plus(java.time.Duration.ofDays(7))),
                java.math.BigDecimal.valueOf(menge));
    }

    /** K-2026-0007, wie die Kaskade sie schreibt: MS-12 am 18.10. in Version 2 — mit der Zeit der Kaskade. */
    private static void korrekturMs12(Welt w, String erstellt) {
        java.time.LocalDate tag = java.time.LocalDate.parse("2026-10-18");
        java.time.ZoneId zone = java.time.ZoneId.of("Europe/Berlin");
        root.update("INSERT INTO messreihe_periode_version (tenant_id, ebene, entity_id, messkanal, messstelle_id, "
                + "periode_beginn, periode_ende, tag, zeitzone, version, menge, menge_zustand, kennzeichen, "
                + "abdeckung_prozent, zustand, korrekturen, ersatzwerte, anlass_kennung, anlass_fassung, created_at) "
                + "VALUES (?, 'tag', (SELECT q.entity_id FROM messstelle_quelle q JOIN messstelle m ON m.id = q.messstelle_id "
                + "WHERE m.tenant_id = ? AND m.kennzeichen = 'MS-12'), 'energy_kwh', NULL, ?, ?, ?, 'Europe/Berlin', 2, 136, "
                + "'vollständig', '[\"korrigiert (Version 2)\"]'::jsonb, 100, 'endgueltig', ARRAY['K-2026-0007'], "
                + "ARRAY[]::text[], 'K-2026-0007', 2, ?)", w.mandant(), w.mandant(),
                Timestamp.from(tag.atStartOfDay(zone).toInstant()), Timestamp.from(tag.plusDays(1).atStartOfDay(zone).toInstant()),
                java.sql.Date.valueOf(tag), Timestamp.from(t(erstellt)));
    }

    private static JsonNode kostenstelleIm(JsonNode abzug, String kennzeichen) {
        for (JsonNode k : abzug.path("kostenstellen")) {
            if (kennzeichen.equals(k.path("quelle").asText())) {
                return k;
            }
        }
        throw new AssertionError("Kostenstelle " + kennzeichen + " fehlt im Abzug " + abzug);
    }

    // =========================================================================== Hilfen

    private Welt welt() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, "Berichte #" + nr);
        UUID u = root.queryForObject("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, "
                + "'Kunststoffwerk Ahrenberg GmbH', 'Europe/Berlin') RETURNING id", UUID.class, t);
        UUID st1 = standort(t, u, "Werk Ahrenberg", "ST-1");
        UUID st2 = standort(t, u, "Werk Lindach", "ST-2");
        Welt w = new Welt(t, u, st1, st2,
                person(t, "JW", "Jonas Wendlinger", "benutzer", zuweisung("kundenadministrator", null)),
                person(t, "IK", "Ines Kaltenbach", "benutzer", zuweisung("energiemanager", null)),
                person(t, "PH", "Peter Hollerbach", "benutzer", zuweisung("bearbeiter", st2)),
                person(t, "MD", "Murat Demirci", "benutzer", zuweisung("bedienberechtigt", st1)),
                person(t, "CB", "Claudia Berger", "benutzer", new Zuweisung(Rolle.LESER, List.of(st1.toString(), st2.toString()),
                        null, null, Instant.EPOCH, null, null)),
                person(t, "TB", "Thomas Brunner", "partner", new Zuweisung(Rolle.UNTERSTUETZER, List.of(st1.toString()),
                        RechteAbleitung.Umfang.vonCode("einrichten_und_bedienen"), RechteAbleitung.Art.vonCode("installateur"),
                        Instant.EPOCH, null, null)),
                new Wer("kc-lena-voss", "Lena Voss", t, true));
        return w;
    }

    private static Zuweisung zuweisung(String rolle, UUID standort) {
        return new Zuweisung(Rolle.vonCode(rolle), standort == null ? null : List.of(standort.toString()), null, null,
                Instant.EPOCH, null, null);
    }

    private static Wer person(UUID t, String kurz, String name, String konto, Zuweisung z) {
        Wer wer = new Wer("kc-" + kurz.toLowerCase() + "-" + t, name, t, false);
        PERSONEN.put(wer.sub(), new Benutzer(wer.sub(), name, Konto.vonCode(konto), KontoZustand.AKTIV, List.of(z)));
        return wer;
    }

    private static UUID standort(UUID t, UUID u, String name, String kurz) {
        return root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, ?, 'Europe/Berlin', 'aktiv') RETURNING id", UUID.class, t, u, name, kurz);
    }

    private static void messstelle(Welt w, String kennzeichen, String name, UUID standort, String ab) {
        UUID ms = root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, groesse, richtung, "
                + "einheit, wertart) VALUES (?, ?, ?, 'gemessen', 'Strom', 'Wirkenergie', 'Bezug', 'kWh', 'Zählerstand') "
                + "RETURNING id", UUID.class, w.mandant(), kennzeichen, name);
        root.update("INSERT INTO messstelle_ort (tenant_id, messstelle_id, ort_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, NULL, ?, ?::date)", w.mandant(), ms, standort, ab);
    }

    /** Ein Bericht, wie ihn das Anlegen schreibt — ohne Entwurf. */
    private static UUID bericht(Welt w, String kennung, String vorlage, UUID standort, String schluessel) {
        boolean unternehmen = vorlage.endsWith("_unternehmen");
        return root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "standort_id, unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) "
                + "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'Europe/Berlin', 'Ines Kaltenbach') RETURNING id", UUID.class, w.mandant(),
                kennung, vorlage, unternehmen ? "unternehmen" : "standort", unternehmen ? null : standort,
                unternehmen ? w.unternehmen() : null, vorlage.startsWith("monats") ? "monat" : "jahr", schluessel);
    }

    /** Der Entwurf mit seinem Quellenverzeichnis, wie Bildung oder Kaskade ihn schreiben; Quellen ohne lebende Zeilen. */
    private static void entwurf(Welt w, UUID bericht, String abzug, String datenstand) {
        Timestamp ds = Timestamp.from(t(datenstand));
        String summe = BerichtRegeln.pruefsumme(abzug);
        if (root.update("UPDATE bericht_entwurf SET abzug = ?, pruefsumme = ?, datenstand = ?, gebildet_von = 'kaskade' "
                + "WHERE bericht_id = ?", abzug, summe, ds, bericht) == 0) {
            root.update("INSERT INTO bericht_entwurf (tenant_id, bericht_id, abzug, pruefsumme, datenstand, gebildet_von) "
                    + "VALUES (?, ?, ?, ?, ?, 'anlegen')", w.mandant(), bericht, abzug, summe, ds);
        }
        root.update("DELETE FROM bericht_quelle WHERE bericht_id = ? AND stand_nr IS NULL", bericht);
        for (String[] q : List.of(new String[] {"MS-01", "Netzbezug Halle 1"}, new String[] {"MS-12", "Montage Linie M1"})) {
            root.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                    + "erster_tag, letzter_tag, version, fassung, name_zum_datenstand) VALUES (?, ?, NULL, 'messstelle', ?, ?, "
                    + "'unmittelbar', '2026-10-01', '2026-10-31', 1, NULL, ?)", w.mandant(), bericht, q[0], UUID.randomUUID(),
                    q[1]);
        }
    }

    /** Ein offener Revisions-Anstoß, wie die Kaskade (IP-8) ihn als Verwaltungsrolle anlegt. */
    private static UUID anstoss(Welt w, UUID stand, String kennung, int fassung, String erkannt) {
        return root.queryForObject("INSERT INTO bericht_revision_anstoss (tenant_id, stand_id, art, anlass_kennung, "
                + "anlass_fassung, anlass_status, erkannt_am) VALUES (?, ?, 'korrektur_freigegeben', ?, ?, 'freigegeben', ?) "
                + "RETURNING id", UUID.class, w.mandant(), stand, kennung, fassung, Timestamp.from(t(erkannt)));
    }

    /** Die Werte des Abzugs vorläufig — ein Entwurf vor dem „endgültig ab“. */
    private static String vorlaeufig(String abzug) throws Exception {
        ObjectNode n = (ObjectNode) EXAKT.readTree(abzug);
        ((ArrayNode) n.path("werte")).forEach(x -> ((ObjectNode) x).put("fassung", KennzahlRegeln.VORLAEUFIG));
        return BerichtRegeln.kanonisch(n);
    }

    private static long zaehle(String tabelle, Welt w) {
        return root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, w.mandant());
    }

    private static Map<String, String> datenstand(String zeit) {
        return Map.of("entwurf_datenstand", zeit);
    }

    private static Map<String, String> anlegen(String vorlage, UUID geltung, String zeitraum) {
        return Map.of("vorlage", vorlage, "geltung_id", geltung.toString(), "zeitraum", zeitraum);
    }

    /** Mit {@code kennzahlen_abgewaehlt} — auch {@code null} oder etwas, das keine Liste von Kennungen ist. */
    private static Map<String, Object> anlegen(String vorlage, UUID geltung, String zeitraum, Object abgewaehlt) {
        Map<String, Object> body = new LinkedHashMap<>(anlegen(vorlage, geltung, zeitraum));
        body.put("kennzahlen_abgewaehlt", abgewaehlt);
        return body;
    }

    /**
     * Eine Kennzahl am Standort mit ihrem Oktober-Wert (Version 1, endgültig, vor dem Datenstand gerechnet) und dem
     * Zähler-Eingang MS-18 — wie AP-11 sie speichert (Muster {@code BerichtAbzugUnternehmenTest}).
     */
    private static UUID kennzahlMitOktober(Welt w, String kennzeichen, UUID standort) {
        UUID kz = root.queryForObject("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, "
                + "standort_id, verantwortlich_sub, verantwortlich_name) VALUES (?, ?, ?, 'quotient', 'standort', ?, 'sub-ik', "
                + "'Ines Kaltenbach') RETURNING id", UUID.class, w.mandant(), kennzeichen, "Energie je Stück " + kennzeichen,
                standort);
        UUID fassung = root.queryForObject("INSERT INTO kennzahl_fassung (tenant_id, kennzahl_id, nummer, rechenform, "
                + "herkunft, actor_sub, actor_name, actor_rolle, actor_art, einheit) VALUES (?, ?, 1, 'quotient', 'anlage', "
                + "'sub-ik', 'Ines Kaltenbach', 'energiemanager', 'kunde', 'kWh/Stück') RETURNING id", UUID.class,
                w.mandant(), kz);
        Timestamp lauf = Timestamp.from(t("2026-11-01T00:20:00+01:00"));
        UUID wert = root.queryForObject("INSERT INTO kennzahl_wert (tenant_id, kennzahl_id, periode_art, periode_von, "
                + "periode_bis, zeitzone, version, wert, zaehler, nenner, menge_zustand, abdeckung_prozent, zustand, "
                + "endgueltig_ab, definition_fassung_id, berechnet_am) VALUES (?, ?, 'monat', DATE '2026-10-01', "
                + "DATE '2026-10-31', 'Europe/Berlin', 1, 0.5, 3600, 7200, 'vollständig', 100, 'endgueltig', ?, ?, ?) "
                + "RETURNING id", UUID.class, w.mandant(), kz, lauf, fassung, lauf);
        root.update("INSERT INTO kennzahl_wert_eingang (tenant_id, wert_id, kennzahl_id, position, rolle, art, objekt, "
                + "messstelle_id, wert, einheit, menge_zustand, abdeckung_prozent, version) VALUES (?, ?, ?, 0, 'zaehler', "
                + "'messstelle', 'MS-18', (SELECT id FROM messstelle WHERE tenant_id = ? AND kennzeichen = 'MS-18'), 3600, "
                + "'kWh', 'vollständig', 100, 1)", w.mandant(), wert, kz, w.mandant());
        return kz;
    }

    private JsonNode liste(Wer wer) throws Exception {
        JsonNode berichte = ok(ruf(wer, HttpMethod.GET, PFAD, null), 200).body().get("berichte");
        assertThat(berichte).hasSize(1);
        return berichte.get(0);
    }

    private static List<String> kennungen(Antwort a) {
        List<String> raus = new ArrayList<>();
        a.body().get("berichte").forEach(b -> raus.add(b.get("kennung").asText()));
        return raus;
    }

    private void uhr(String zeit) {
        dienst.uhrStellen(Clock.fixed(t(zeit), ZoneOffset.UTC));
    }

    private static Instant t(String zeit) {
        return OffsetDateTime.parse(zeit).toInstant();
    }

    private static Antwort ok(Antwort a, int status) {
        assertThat(a.status()).as(a.text()).isEqualTo(status);
        return a;
    }

    private static Antwort abgelehnt(Antwort a, int status, String code) {
        assertThat(a.status()).as(a.text()).isEqualTo(status);
        assertThat(a.body().get("code").asText()).as(a.text()).isEqualTo(code);
        assertThat(BerichtAbgelehnt.CODES).contains(code);
        return a;
    }

    /** 403 {@code recht_fehlt} mit dem Satz der Rechte-Ableitung. */
    private static void verboten(Antwort a) {
        abgelehnt(a, 403, "recht_fehlt");
        assertThat(a.body().get("message").asText()).isNotBlank();
        assertThat(a.body().has("rolle_noetig")).isTrue();
    }

    /** Eine Datei-Route (CSV): Status, Kopfzeilen und Bytes — die Antwort ist kein JSON. */
    private MvcResult datei(Wer wer, String pfad) throws Exception {
        return mvc.perform(als(wer, HttpMethod.GET, pfad)).andReturn();
    }

    /** Der Text eines PDF (Text-Extraktion), geschützte Leerzeichen als Leerzeichen. */
    private static String pdfText(byte[] pdf) throws Exception {
        try (PDDocument d = Loader.loadPDF(pdf)) {
            return new PDFTextStripper().getText(d).replace('\u00A0', ' ');
        }
    }

    /** Die Zeilen eines Berichts-CSV: mit BOM und CRLF geschrieben, ohne beide gelesen. */
    private static List<String> zeilen(byte[] csv) {
        String text = new String(csv, StandardCharsets.UTF_8);
        assertThat(text).startsWith("﻿").endsWith("\r\n");
        return List.of(text.substring(1).split("\r\n"));
    }

    private static List<String> texte(JsonNode liste) {
        List<String> raus = new ArrayList<>();
        liste.forEach(n -> raus.add(n.asText()));
        return raus;
    }

    private static MockHttpServletRequestBuilder als(Wer wer, HttpMethod methode, String pfad) {
        MockHttpServletRequestBuilder anfrage = request(methode, pfad)
                .with(jwt().jwt(j -> {
                    j.subject(wer.sub());
                    j.claim("preferred_username", wer.name());
                    if (!wer.plattform()) {
                        j.claim("tenant_id", wer.kundenbereich().toString());
                    }
                }).authorities(wer.plattform()
                        ? List.of(new SimpleGrantedAuthority("ROLE_platform-admin")) : List.of()))
                .contentType(MediaType.APPLICATION_JSON);
        if (wer.plattform()) {
            anfrage.header("X-Tenant-Id", wer.kundenbereich().toString());
        }
        return anfrage;
    }

    private Antwort ruf(Wer wer, HttpMethod methode, String pfad, Object body) throws Exception {
        MockHttpServletRequestBuilder anfrage = als(wer, methode, pfad);
        if (body != null) {
            anfrage.content(MAPPER.writeValueAsString(body));
        }
        MvcResult r = mvc.perform(anfrage).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text), text);
    }
}
