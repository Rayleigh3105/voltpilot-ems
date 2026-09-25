package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.benutzer.Startpasswort;
import com.voltpilot.api.benutzer.StartpasswortKonten;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.ZugriffBuehnenUhr;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Prüfumgebung Ahrenberg (UEMS AP-20 IP-13, E5, PD1, PD2) — genau so zusammengesetzt wie im lokalen Stapel: der Seed
 * 1.4 aus {@code infra/local/seed/ahrenberg.sql}, darauf die Welt der Referenzdatei 1.10 über
 * {@link PruefumgebungAhrenberg} (der Welt-Aufbau der Abnahme als Seed-Weg), die Bühnen-Uhr {@link PruefumgebungUhr} auf
 * dem 30.04.2029 und ein Einsicht-Konto für die Fachperson, befristet vergeben von Jonas Wendlinger
 * (Kundenadministrator) über {@code POST /api/v1/benutzer} — der Weg, den auch ein Kunde für PA-2 geht.
 * <ol>
 *   <li>Die Bühne zeigt D-0001, AU-2029-0001, F-2029-0001 und BR-2029-0001 mit „entschieden von“.</li>
 *   <li>Das Einsicht-Konto sieht alles: dieselben Verzeichnis-Zeilen wie der Kundenadministrator, jeder Leser der
 *       Abnahme antwortet.</li>
 *   <li>Es ändert nichts: jeder schreibende Weg der API wird abgelehnt, der Kundenbereich ist danach byte-gleich.</li>
 *   <li>Der Zugang endet am vereinbarten Tag — gezählt auf der Bühne, die in echter Zeit weiterläuft.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class PruefumgebungAhrenbergTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BASIS = "/api/v1/energiemanagement";
    private static final Path SEED = Path.of("..", "..", "infra", "local", "seed", "ahrenberg.sql");
    private static final UUID AHRENBERG = AhrenbergWelt.AHRENBERG;
    private static final String JW = AhrenbergWelt.SEED_SUBJECTS.get("JW");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        POSTGRES.start();
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", () -> "voltpilot_app");
        r.add("spring.datasource.password", () -> "ip13_test_pw");
        r.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        r.add("spring.flyway.user", POSTGRES::getUsername);
        r.add("spring.flyway.password", POSTGRES::getPassword);
        r.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        r.add("spring.flyway.placeholders.appDbPassword", () -> "ip13_test_pw");
        r.add("voltpilot.security.oidc.enabled", () -> "true");
        r.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> "http://127.0.0.1:9/realms/voltpilot");
        r.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri", () -> "http://127.0.0.1:9/certs");
        r.add("voltpilot.uems.kennzahlen.enabled", () -> "false");
        r.add("voltpilot.pruefumgebung.buehnen-uhr", () -> PruefumgebungAhrenberg.BUEHNE);
    }

    @Autowired MockMvc mvc;
    @Autowired PruefumgebungUhr buehnenUhr;
    @Autowired ZugriffBuehnenUhr zugriffUhr;
    @Autowired @Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping routen;
    @MockBean StartpasswortKonten konten;

    JdbcTemplate root;
    /** Das Einsicht-Konto der Fachperson und sein letzter Tag (einschließlich, Europe/Berlin). */
    String fachperson;
    LocalDate bis;

    @BeforeAll
    void pruefumgebung() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()); Statement s = c.createStatement()) {
            s.execute(Files.readString(SEED));
        }
        assertThat(PruefumgebungAhrenberg.aufbauen(mvc, root, buehnenUhr)).isTrue();
        assertThat(PruefumgebungAhrenberg.aufbauen(mvc, root, buehnenUhr))
                .as("ein zweiter Aufbau ändert nichts").isFalse();

        when(konten.kunde(any(), anyString(), anyString(), any(), any())).thenAnswer(a -> new StartpasswortKonten.Angelegt(
                new KeycloakUser("kc-" + a.getArgument(1), a.getArgument(1), a.getArgument(2), a.getArgument(3),
                        a.getArgument(4), true, AHRENBERG.toString()), new Startpasswort("Start-Passwort-24!")));
        // Die Frist zählt auf der Bühne: 30 Tage ab dem Bühnen-Heute (30.04.2029) — die Bühne läuft in echter Zeit weiter.
        bis = LocalDate.ofInstant(Instant.parse(PruefumgebungAhrenberg.BUEHNE), ZoneId.of("Europe/Berlin")).plusDays(30);
        Map<String, Object> anlage = new LinkedHashMap<>();
        anlage.put("username", "pruefung-ahrenberg");
        anlage.put("email", "pruefung-ahrenberg@voltpilot.local");
        anlage.put("vorname", "Fachperson");
        anlage.put("nachname", "Prüfung");
        anlage.put("rolle", "einsicht");
        anlage.put("standorte", List.of());
        anlage.put("gueltig_bis", bis.toString());
        fachperson = ruf("POST", "/api/v1/benutzer", JW, anlage, 201).at("/benutzer/sub").asText();
        assertThat(fachperson).isEqualTo("kc-pruefung-ahrenberg");
    }

    @AfterAll
    void uhrZurueck() {
        buehnenUhr.stellen(Clock.systemUTC());
    }

    @Test
    @Order(1)
    void dieBuehneZeigtD0001AuditFeststellungUndManagementbewertungMitEntschiedenVon() throws Exception {
        JsonNode v = ruf("GET", BASIS + "/verzeichnis", fachperson, null, 200);
        assertThat(v.path("stichtag").asText()).startsWith("2029-04-30");
        // Dieselben Personen wie in der Abnahme (R1, R14 B3, R9, R11, R13) — die Bühne ist deren Welt.
        assertThat(entschiedenVon(v, "energiepolitik", "D-0001")).containsOnly("Robert Falk").hasSize(2);
        assertThat(entschiedenVon(v, "internes_audit", "AU-2029-0001")).containsExactly("Ines Kaltenbach");
        assertThat(entschiedenVon(v, "wirksamkeit", "F-2029-0001")).containsExactly("Ines Kaltenbach");
        assertThat(entschiedenVon(v, "berichtsstand", "BR-2029-0001")).containsExactly("Robert Falk");
        // Und dieselben Prüfsummen der Träger wie dort: sie hängen an Wortlaut, Namen und Tagen, nicht an Kennungen.
        assertThat(zeile(v, "energiepolitik", "D-0001", 1).path("pruefsumme").asText())
                .isEqualTo("sha256:163ae8360abb4f614f4fb4b37a7e983dff1f42e548b7f10c64890fdde68b09bb");
        assertThat(zeile(v, "internes_audit", "AU-2029-0001", 0).path("pruefsumme").asText())
                .isEqualTo("sha256:27a580b9761668e43f8cdc5afb66a4124f1394cb030a8629c8dc4f82a4d56701");

        // Die Seiten der vier Nachweise öffnen sich für die Fachperson.
        ruf("GET", BASIS + "/dokumente/" + id("energiemanagement_dokument", "D-0001"), fachperson, null, 200);
        ruf("GET", BASIS + "/audits/" + id("internes_audit", "AU-2029-0001"), fachperson, null, 200);
        ruf("GET", BASIS + "/feststellungen/" + id("feststellung", "F-2029-0001"), fachperson, null, 200);
        JsonNode mb = ruf("GET", BASIS + "/managementbewertungen/BR-2029-0001", fachperson, null, 200);
        assertThat(mb.toString()).contains("Robert Falk");
        ruf("GET", "/api/v1/berichte/BR-2029-0001/staende/1", fachperson, null, 200);
    }

    @Test
    @Order(2)
    void einsichtSiehtAllesWasDieKundenadministrationSieht() throws Exception {
        JsonNode eigen = ruf("GET", BASIS + "/verzeichnis", fachperson, null, 200);
        JsonNode admin = ruf("GET", BASIS + "/verzeichnis", JW, null, 200);
        assertThat(eigen.path("gruppen")).isEqualTo(admin.path("gruppen"));
        for (String leser : List.of("/wiedervorlage", "/personen", "/aufgaben?tag=2029-04-30",
                "/verantwortung?tag=2029-04-30", "/dokumente", "/audits", "/feststellungen", "/bekanntmachungen")) {
            ruf("GET", BASIS + leser, fachperson, null, 200);
        }
    }

    /**
     * Jede Route mit einem schreibenden Verb, mit dem Token der Fachperson: keine antwortet mit Erfolg, außer denen, die
     * nur das eigene Konto betreffen ({@code konto.eigenes}, E in der Matrix) — und der Kundenbereich ist danach
     * byte-gleich. Die Pfad-Variablen tragen erfundene Kennungen; das Recht prüft {@code RechtInterceptor} vor dem
     * Handler, also vor jeder Suche nach dem Objekt. Dazu die echten Objekte der Bühne an ihren Freigabe-Wegen.
     */
    @Test
    @Order(3)
    void einsichtAendertNichts() throws Exception {
        String vorher = fingerabdruck();
        List<String> erfolgreich = new ArrayList<>();
        int geprueft = 0;
        for (var e : routen.getHandlerMethods().entrySet()) {
            Set<RequestMethod> verben = e.getKey().getMethodsCondition().getMethods();
            HandlerMethod h = e.getValue();
            Recht recht = h.getMethodAnnotation(Recht.class);
            boolean eigenesKonto = recht != null && List.of(recht.value()).contains("konto.eigenes");
            for (RequestMethod verb : verben) {
                if (verb == RequestMethod.GET || verb == RequestMethod.HEAD || verb == RequestMethod.OPTIONS) continue;
                for (String muster : e.getKey().getPatternValues()) {
                    String pfad = muster.replaceAll("\\{[^}]+}", UUID.randomUUID().toString());
                    MockHttpServletResponse r = roh(verb.name(), pfad, fachperson, "{}");
                    geprueft++;
                    if (r.getStatus() < 300 && !eigenesKonto) erfolgreich.add(verb + " " + muster + " → " + r.getStatus());
                }
            }
        }
        String d1 = id("energiemanagement_dokument", "D-0001");
        for (String[] w : List.of(
                new String[] {"POST", BASIS + "/dokumente/" + d1 + "/fassungen/2/freigeben"},
                new String[] {"POST", BASIS + "/dokumente/" + d1 + "/fassungen"},
                new String[] {"POST", BASIS + "/audits/" + id("internes_audit", "AU-2029-0001") + "/abschliessen"},
                new String[] {"POST", BASIS + "/feststellungen/" + id("feststellung", "F-2029-0001") + "/wirksamkeit"},
                new String[] {"PUT", BASIS + "/managementbewertungen/BR-2029-0001/sitzung"},
                new String[] {"POST", "/api/v1/berichte/BR-2029-0001/freigeben"})) {
            MockHttpServletResponse r = roh(w[0], w[1], fachperson, "{}");
            geprueft++;
            if (r.getStatus() < 300) erfolgreich.add(w[0] + " " + w[1] + " → " + r.getStatus());
        }
        assertThat(geprueft).as("schreibende Wege geprüft").isGreaterThan(100);
        assertThat(erfolgreich).as("die Fachperson hat etwas geändert").isEmpty();
        assertThat(fingerabdruck()).as("Kundenbereich Ahrenberg byte-gleich").isEqualTo(vorher);
    }

    @Test
    @Order(4)
    void derZugangEndetAmVereinbartenTag() throws Exception {
        ZoneId berlin = ZoneId.of("Europe/Berlin");
        assertThat(bis).isEqualTo(LocalDate.of(2029, 5, 30));
        assertThat(root.queryForObject("SELECT gueltig_bis FROM zugriff WHERE tenant_id = ? AND benutzer_sub = ?",
                LocalDate.class, AHRENBERG, fachperson)).isEqualTo(bis);
        try {
            buehnenUhr.stellen(Clock.fixed(bis.atTime(23, 0).atZone(berlin).toInstant(), ZoneOffset.UTC));
            ruf("GET", BASIS + "/verzeichnis", fachperson, null, 200);
            buehnenUhr.stellen(Clock.fixed(bis.plusDays(1).atStartOfDay(berlin).toInstant(), ZoneOffset.UTC));
            assertThat(roh("GET", BASIS + "/verzeichnis", fachperson, null).getStatus()).isIn(403, 404);
            // Der Kundenadministrator liest weiter — die Frist gilt nur dem Einsicht-Konto.
            ruf("GET", BASIS + "/verzeichnis", JW, null, 200);
        } finally {
            buehnenUhr.stellen();
        }
    }

    // ================================================================================ Helfer

    /** „entschieden von“ jeder Verzeichnis-Zeile einer Art und eines Kennzeichens (leer = nicht im Verzeichnis). */
    private static List<String> entschiedenVon(JsonNode v, String art, String kennzeichen) {
        List<String> aus = new ArrayList<>();
        zeilen(v, art, kennzeichen).forEach(z -> aus.add(z.path("entschieden_von").asText()));
        assertThat(aus).as(art + " " + kennzeichen + " im Verzeichnis").isNotEmpty();
        return aus;
    }

    private static List<JsonNode> zeilen(JsonNode v, String art, String kennzeichen) {
        List<JsonNode> aus = new ArrayList<>();
        v.path("gruppen").forEach(g -> g.path("zeilen").forEach(z -> {
            if (z.path("art").asText().equals(art) && z.path("kennzeichen").asText().equals(kennzeichen)) aus.add(z);
        }));
        return aus;
    }

    private static JsonNode zeile(JsonNode v, String art, String kennzeichen, int nr) {
        return zeilen(v, art, kennzeichen).stream().filter(z -> nr == 0 || z.path("nr").asInt() == nr).findFirst()
                .orElseThrow(() -> new AssertionError(art + " " + kennzeichen + " " + nr + " fehlt"));
    }

    private String id(String tabelle, String kennzeichen) {
        return root.queryForObject("SELECT id FROM " + tabelle + " WHERE tenant_id = ? AND kennzeichen = ?", UUID.class,
                AHRENBERG, kennzeichen).toString();
    }

    /** Jede Zeile jeder Tabelle mit {@code tenant_id} im Kundenbereich Ahrenberg, als eine Prüfsumme je Tabelle. */
    private String fingerabdruck() {
        List<String> tabellen = root.queryForList("SELECT c.table_name FROM information_schema.columns c JOIN "
                + "information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name "
                + "WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' "
                + "ORDER BY 1", String.class);
        StringBuilder aus = new StringBuilder();
        for (String t : tabellen) {
            aus.append(t).append('=').append(root.queryForObject("SELECT count(*) || ':' || coalesce(md5(string_agg(x::text, "
                    + "'|' ORDER BY x::text)), '-') FROM " + t + " x WHERE x.tenant_id = ?", String.class, AHRENBERG))
                    .append('\n');
        }
        return aus.toString();
    }

    private Authentication token(String sub) {
        Jwt jwt = Jwt.withTokenValue("test").header("alg", "none").subject(sub).issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600)).claim("tenant_id", AHRENBERG.toString())
                .claim("realm_access", Map.of("roles", List.of())).build();
        return new KeycloakRealmRoleConverter().convert(jwt);
    }

    private MockHttpServletResponse roh(String method, String path, String sub, String body) throws Exception {
        var b = request(HttpMethod.valueOf(method), path).with(authentication(token(sub)));
        if (body != null) b.contentType(MediaType.APPLICATION_JSON).content(body);
        return mvc.perform(b).andReturn().getResponse();
    }

    private JsonNode ruf(String method, String path, String sub, Object body, int status) throws Exception {
        MockHttpServletResponse r = roh(method, path, sub, body == null ? null : JSON.writeValueAsString(body));
        String text = r.getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getStatus()).as(method + " " + path + " " + text).isEqualTo(status);
        return text.isBlank() ? JSON.nullNode() : JSON.readTree(text);
    }
}
