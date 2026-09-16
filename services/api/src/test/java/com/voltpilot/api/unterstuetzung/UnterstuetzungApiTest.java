package com.voltpilot.api.unterstuetzung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mockingDetails;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import com.voltpilot.api.zugriff.ZugriffRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.ApplicationContext;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Unterstützung an der echten Datenbank (UEMS AP-03 IP-8) — die Abnahmefälle A4, A5 und A14 und die drei
 * Zusagen, mit denen ein Zugang zu FREMDEN Kundendaten steht oder fällt:
 *
 * <ol>
 *   <li><b>Sie endet von selbst.</b> {@link #eineAbgelaufeneUnterstuetzungLaesstNiemandenMehrHinein} führt sie
 *       mit ABGESCHALTETEM Läufer vor (im Testlauf gibt es ihn gar nicht als Bohne): die Zeile ist zu ihrem
 *       {@code endet_am} unwirksam, weil {@code zugriff_zeitraum} sie schließt — nicht, weil jemand aufräumt.
 *       Was der Läufer tut, zeigt {@link #derLaeuferTraegtDenAblaufNachUndErinnertSiebenTageVorher}: Protokoll
 *       und Hinweis, nie das Ende selbst.</li>
 *   <li><b>Der Notfall-Zugriff ist eng und laut</b> ({@link #a14NotfallZugriffIstEngUndLaut}): ohne Grund wird
 *       NICHTS angelegt, mit Grund genau 24 h, und jeder Kundenadministrator hat den Hinweis im Postfach.</li>
 *   <li><b>Ein Entzug wirkt sofort</b> ({@link #a4InstallateurBefristetSichtbarProtokolliert}): dieselbe
 *       Sitzung, dieselbe Anfrage — 200 vor dem Beenden, 404 danach, ohne Token-Ablauf.</li>
 * </ol>
 *
 * <p><b>Die Fristen sind RELATIV zu heute</b> (gestern, in drei Tagen, in 30 Tagen), nie feste Kalendertage:
 * ein Test, der am 16.12.2026 rot wird, misst den Kalender, nicht den Code.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(properties = "voltpilot.uems.unterstuetzung.umschalter-enabled=false")
@AutoConfigureMockMvc
@ActiveProfiles("local")
class UnterstuetzungApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final UUID DEMO = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final String KUNDENBEREICH = ZugriffKontextLader.KUNDENBEREICH_HEADER;
    private static final String TENANT = "X-Tenant-Id";

    private static final String JONAS = "sub-u8-jonas";
    private static final String INES = "sub-u8-ines";
    private static final String PETER_LESER = "sub-u8-peter";
    private static final String VOLTPILOT = "sub-u8-voltpilot";

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
    ApplicationContext kontext;

    @Autowired
    ZugriffRepository zugriffe;

    @Autowired
    UnterstuetzungService dienst;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate adminJdbc;

    @MockBean
    KeycloakAdminClient keycloak;

    private static JdbcTemplate root;
    private static UUID standort;

    @BeforeAll
    static void verbinde() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    @BeforeEach
    void seed() {
        if (standort != null) {
            return;
        }
        UUID unternehmen = root.queryForList("SELECT id FROM unternehmen WHERE tenant_id = ?", UUID.class, DEMO)
                .stream().findFirst()
                .orElseGet(() -> root.queryForObject("INSERT INTO unternehmen (tenant_id, name) "
                        + "VALUES (?, 'Kunststoffwerk Ahrenberg GmbH') RETURNING id", UUID.class, DEMO));
        standort = root.queryForList("SELECT id FROM standort WHERE tenant_id = ? ORDER BY created_at, id",
                UUID.class, DEMO).stream().findFirst()
                .orElseGet(() -> root.queryForObject("INSERT INTO standort (tenant_id, unternehmen_id, name, "
                        + "kurzzeichen, zeitzone, zustand) VALUES (?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', "
                        + "'aktiv') RETURNING id", UUID.class, DEMO, unternehmen));
        // Zwei Kundenadministratoren (jeder Hinweis geht an BEIDE) und ein Leser, der nichts verwalten darf.
        kundenadministrator(JONAS, "Jonas Wendlinger");
        kundenadministrator(INES, "Ines Kaltenbach");
        spiegel(PETER_LESER, "benutzer", "Peter Roth");
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'leser', ?, now() - interval '30 days', 'Europe/Berlin')", DEMO, PETER_LESER,
                standort);
    }

    // ================================================================= A4

    /**
     * <b>A4 — Unterstützung Installateur: befristet, sichtbar, protokolliert; ein Entzug wirkt sofort.</b>
     *
     * <p>Jonas gewährt Elektro Brunner „Einrichten und Bedienen" für Werk Ahrenberg. Die Adresse kennt der
     * Realm nicht: es entsteht ein Partner-Konto, und das Startpasswort steht GENAU EINMAL in der Antwort —
     * in keiner Liste und in keinem Hinweis. Thomas erreicht damit den Kundenbereich über
     * {@code X-Kundenbereich}; was seine Zelle in der Matrix nicht hergibt, bleibt 403. Jonas beendet die
     * Unterstützung, und die NÄCHSTE Anfrage desselben Tokens ist 404.
     */
    @Test
    void a4InstallateurBefristetSichtbarProtokolliert() throws Exception {
        String email = "thomas.brunner@elektro-brunner.example";
        String thomas = "sub-u8-thomas";
        when(keycloak.findByEmail(email)).thenReturn(Optional.empty());
        when(keycloak.createPartnerUser(eq(email), eq(email), any(), any(), any(), anyBoolean()))
                .thenReturn(new KeycloakUser(thomas, email, email, "Thomas", "Brunner", true, null));

        LocalDate bis = heute().plusDays(21);
        JsonNode gewaehrt = json(ruf(post("/api/v1/unterstuetzung", Map.of(
                "art", "installateur", "email", email, "standorte", List.of(standort.toString()),
                "umfang", "einrichten_und_bedienen", "gueltig_bis", bis.toString(),
                "grund", "Ladepunkt Halle 2 einrichten")), konto(JONAS, DEMO), 201));

        // Das Startpasswort: genau einmal, hier - und nirgends sonst.
        String startpasswort = gewaehrt.get("startpasswort").asText();
        assertThat(startpasswort.length()).isEqualTo(24);
        // Auch ein fehlgeschlagener Nachweis darf keine Mockito-Argumentliste mit Passwort ausgeben.
        assertThat(mockingDetails(keycloak).getInvocations().stream().anyMatch(i ->
                i.getMethod().getName().equals("createPartnerUser") && email.equals(i.getArgument(0))
                        && startpasswort.equals(i.getArgument(4)) && Boolean.TRUE.equals(i.getArgument(5)))).isTrue();
        UUID griff = UUID.fromString(gewaehrt.get("id").asText());
        assertThat(gewaehrt.get("art").asText()).isEqualTo("installateur");
        assertThat(gewaehrt.get("zustand").asText()).isEqualTo("aktiv");
        assertThat(gewaehrt.get("banner").asText())
                .isEqualTo("Thomas Brunner (Installateur) hat Zugriff auf Werk Ahrenberg bis "
                        + deutsch(bis) + " — Einrichten und Bedienen");

        JsonNode liste = json(ruf(get("/api/v1/unterstuetzung"), konto(JONAS, DEMO), 200));
        JsonNode inDerListe = eintrag(liste, griff);
        assertThat(inDerListe.get("startpasswort").isNull()).as("nie ein zweites Mal").isTrue();
        assertThat(liste.toString().contains(startpasswort)).isFalse();
        assertThat(json(ruf(get("/api/v1/unterstuetzung/hinweise"), konto(JONAS, DEMO), 200)).toString()
                .contains(startpasswort)).isFalse();
        assertThat(protokoll(griff)).containsExactly("zuweisen");

        // Thomas kommt herein - und zwar NUR mit dem Kopf; ohne ihn ist der Kundenbereich für ihn nicht da.
        Authentication tb = partner(thomas);
        JsonNode eigene = json(ruf(get("/api/v1/me"), tb, 200)).get("kundenbereiche");
        assertThat(eigene.size()).isEqualTo(1);
        assertThat(MAPPER.convertValue(eigene.get(0), Map.class).keySet()).containsExactlyInAnyOrder("id", "name", "umfang", "endet");
        assertThat(eigene.get(0).get("id").asText()).isEqualTo(DEMO.toString());
        assertThat(eigene.get(0).get("umfang").asText()).isEqualTo("einrichten_und_bedienen");
        assertThat(json(ruf(get("/api/v1/me"), partner("fremder-partner"), 200)).get("kundenbereiche").isEmpty()).isTrue();
        assertThat(json(ruf(get("/api/v1/me"), konto(JONAS, DEMO), 200)).get("kundenbereiche").isEmpty()).isTrue();
        ruf(get("/api/v1/sites"), tb, 404, KUNDENBEREICH, UUID.randomUUID().toString());
        JsonNode flottenDaten = json(ruf(get("/api/v1/admin/fleet"), plattform("flotten-leser"), 200));
        assertThat(flottenDaten.get("unterstuetzungBis").has(DEMO.toString())).isTrue();
        assertThat(flottenDaten.get("unterstuetzungStandorte").toString()).contains(standort.toString());
        ruf(get("/api/v1/admin/fleet"), tb, 403);
        assertThat(json(ruf(get("/api/v1/standorte"), konto(JONAS, DEMO), 200)).get("standorte").toString())
                .contains(standort.toString());
        assertThat(ruf(get("/api/v1/sites"), tb, 200, KUNDENBEREICH, DEMO.toString())).isNotNull();
        ruf(get("/api/v1/sites"), tb, 404);
        // Was seine Zelle nicht hergibt, bleibt 403 - auch mit „Einrichten und Bedienen" (A4: keine Exporte,
        // keine Freigabe, keine Verwaltung).
        JsonNode verboten = json(ruf(post("/api/v1/unternehmen/kostenstellen", Map.of("name", "Halle 2")), tb, 403,
                KUNDENBEREICH, DEMO.toString()));
        assertThat(verboten.get("code").asText()).isEqualTo("recht_fehlt");
        // Und eine Unterstützung gewährt ein Unterstützer nie (E2, Matrix-Zelle „-").
        assertThat(json(ruf(post("/api/v1/unterstuetzung", Map.of("art", "installateur", "email", "x@y.example",
                "standorte", List.of(standort.toString()))), tb, 403, KUNDENBEREICH, DEMO.toString()))
                .get("code").asText())
                .isEqualTo("recht_fehlt");

        // ENTZUG WIRKT SOFORT: dieselbe Sitzung, dieselbe Anfrage, kein Token-Ablauf.
        ruf(delete("/api/v1/unterstuetzung/" + griff, Map.of("grund", "Arbeit erledigt")), konto(JONAS, DEMO), 204);
        ruf(get("/api/v1/sites"), tb, 404, KUNDENBEREICH, DEMO.toString());
        assertThat(json(ruf(get("/api/v1/me"), tb, 200)).get("kundenbereiche").isEmpty()).isTrue();
        assertThat(protokoll(griff)).containsExactly("zuweisen", "entziehen");
        // Ein zweites Ende gibt es nicht.
        assertThat(json(ruf(delete("/api/v1/unterstuetzung/" + griff, Map.of()), konto(JONAS, DEMO), 409))
                .get("code").asText()).isEqualTo("bereits_beendet");
        // Und danach steht sie als archivierter Eintrag da (§4.6).
        assertThat(eintrag(json(ruf(get("/api/v1/unterstuetzung"), konto(JONAS, DEMO), 200)), griff)
                .get("zustand").asText()).isEqualTo("archiviert");
    }

    /** Eine bekannte Adresse bekommt KEIN zweites Konto — und kein Startpasswort. */
    @Test
    void eineBekannteAdresseBekommtKeinZweitesKonto() throws Exception {
        String email = "bekannt@elektro-brunner.example";
        String sub = "sub-u8-bekannt";
        when(keycloak.findByEmail(email))
                .thenReturn(Optional.of(new KeycloakUser(sub, email, email, "Bea", "Kannt", true, null)));

        JsonNode g = json(ruf(post("/api/v1/unterstuetzung", Map.of("art", "installateur", "email", email,
                "standorte", List.of(standort.toString()), "gueltig_bis", heute().plusDays(10).toString())),
                konto(JONAS, DEMO), 201));
        assertThat(g.get("startpasswort").isNull()).isTrue();
        assertThat(g.get("unterstuetzer").get("kennung").asText()).isEqualTo(sub);
        assertThat(g.get("umfang").asText()).as("Vorgabe je Art (E9)").isEqualTo("einrichten_und_bedienen");
        assertThat(mockingDetails(keycloak).getInvocations().stream().anyMatch(i ->
                i.getMethod().getName().equals("createPartnerUser") && email.equals(i.getArgument(0)))).isFalse();
        ruf(delete("/api/v1/unterstuetzung/" + g.get("id").asText(), Map.of()), konto(JONAS, DEMO), 204);
    }

    /** Antwortet die Benutzerverwaltung nicht, wird NICHTS gewährt — kein halber Zugang. */
    @Test
    void ohneKeycloakWirdNichtsGewaehrt() throws Exception {
        String email = "unerreichbar@elektro-brunner.example";
        when(keycloak.findByEmail(email)).thenThrow(new KeycloakAdminException(502, "down"));
        long vorher = zugriffZeilen();
        assertThat(json(ruf(post("/api/v1/unterstuetzung", Map.of("art", "installateur", "email", email,
                "standorte", List.of(standort.toString()))), konto(JONAS, DEMO), 502)).get("code").asText())
                .isEqualTo("konto_nicht_erreichbar");
        assertThat(zugriffZeilen()).isEqualTo(vorher);
    }

    // ================================================================= A5

    /**
     * <b>A5 — VoltPilot fragt an, der Kundenadministrator gewährt.</b>
     *
     * <p>Ohne Gewährung erreicht das Plattform-Konto den Kundenbereich über {@code X-Kundenbereich} NICHT (404
     * auf jeder Kundenroute). Die Anfrage gewährt nichts: sie legt einen Wunsch an und einen Hinweis für JEDEN
     * Kundenadministrator. Erst Jonas' Bestätigung — hier mit geändertem Umfang, wie §4.6 es erlaubt — macht
     * daraus einen Zugang.
     */
    @Test
    void a5VoltPilotFragtAnUndDerKundenadministratorGewaehrt() throws Exception {
        Authentication lena = plattform(VOLTPILOT);
        ruf(get("/api/v1/sites"), lena, 404, KUNDENBEREICH, DEMO.toString());

        JsonNode anfrage = json(ruf(post("/api/v1/admin/tenants/" + DEMO + "/unterstuetzung/anfrage", Map.of(
                "standorte", List.of(standort.toString()), "umfang", "einrichten",
                "gueltig_bis", heute().plusDays(7).toString(), "grund", "Speicher-Diagnose")), lena, 201));
        UUID anfrageId = UUID.fromString(anfrage.get("id").asText());
        assertThat(anfrage.get("zustand").asText()).isEqualTo("offen");
        assertThat(anfrage.get("unterstuetzung").isNull()).isTrue();
        // Eine Anfrage ist KEIN Zugang.
        ruf(get("/api/v1/sites"), lena, 404, KUNDENBEREICH, DEMO.toString());

        // Beide Kundenadministratoren haben den Hinweis im Postfach - der eine wie der andere.
        for (String ka : List.of(JONAS, INES)) {
            JsonNode hinweise = json(ruf(get("/api/v1/unterstuetzung/hinweise"), konto(ka, DEMO), 200));
            JsonNode h = hinweisZu(hinweise, "anfrage", anfrageId);
            assertThat(h.get("text").asText())
                    .isEqualTo("VoltPilot-Support bittet um Zugriff auf Werk Ahrenberg bis "
                            + deutsch(heute().plusDays(7)) + " — Einrichten. Grund: Speicher-Diagnose");
            assertThat(h.get("email_versandt_am").isNull()).as("kein SMTP: das Portal ist der Weg").isTrue();
        }

        // Jonas bestätigt - mit KLEINEREM Umfang als gewünscht (§4.6: „oder ändert Umfang/Dauer").
        JsonNode gewaehrt = json(ruf(post("/api/v1/unterstuetzung",
                Map.of("anfrage_id", anfrageId.toString(), "umfang", "ansehen")), konto(JONAS, DEMO), 201));
        UUID griff = UUID.fromString(gewaehrt.get("id").asText());
        assertThat(gewaehrt.get("art").asText()).isEqualTo("voltpilot");
        assertThat(gewaehrt.get("umfang").asText()).isEqualTo("ansehen");
        assertThat(gewaehrt.get("banner").asText()).startsWith("VoltPilot-Support hat Zugriff auf Werk Ahrenberg bis ");

        // Jetzt erreicht Lena den Kundenbereich - LESEND.
        assertThat(ruf(get("/api/v1/sites"), lena, 200, KUNDENBEREICH, DEMO.toString())).isNotNull();
        JsonNode me = json(ruf(get("/api/v1/me"), lena, 200, KUNDENBEREICH, DEMO.toString()));
        assertThat(me.get("zugang").asText()).isEqualTo("unterstuetzung");
        List<String> rechte = rechteAmStandort(me);
        assertThat(rechte).as("Ansehen richtet nichts ein").doesNotContain("messstelle.bearbeiten");
        assertThat(rechte).as("und bedient erst recht nichts").doesNotContain("handeingriff.setzen");
        assertThat(json(ruf(post("/api/v1/unternehmen/kostenstellen", Map.of("name", "X")), lena, 403,
                KUNDENBEREICH, DEMO.toString())).get("code").asText()).isEqualTo("recht_fehlt");

        // Die Anfrage trägt jetzt ihre Unterstützung und ist nicht mehr offen.
        JsonNode nachher = eintrag(json(ruf(get("/api/v1/unterstuetzung/anfragen?offen=false"),
                konto(JONAS, DEMO), 200)), anfrageId);
        assertThat(nachher.get("zustand").asText()).isEqualTo("bestaetigt");
        assertThat(UUID.fromString(nachher.get("unterstuetzung").asText())).isEqualTo(griff);
        // Und zweimal bestätigt wird sie nie.
        assertThat(json(ruf(post("/api/v1/unterstuetzung", Map.of("anfrage_id", anfrageId.toString())),
                konto(JONAS, DEMO), 409)).get("code").asText()).isEqualTo("anfrage_entschieden");

        ruf(delete("/api/v1/unterstuetzung/" + griff, Map.of()), konto(JONAS, DEMO), 204);
        ruf(get("/api/v1/sites"), lena, 404, KUNDENBEREICH, DEMO.toString());
    }

    /** Ohne Anfrage gewährt niemand VoltPilot etwas — auch der Kundenadministrator nicht (E8). */
    @Test
    void ohneAnfrageGibtEsKeineVoltPilotUnterstuetzung() throws Exception {
        assertThat(json(ruf(post("/api/v1/unterstuetzung", Map.of("art", "voltpilot",
                "standorte", List.of(standort.toString()))), konto(JONAS, DEMO), 400)).get("feld").asText())
                .isEqualTo("anfrage_id");
    }

    // ================================================================= A14

    /**
     * <b>A14 — der Notfall-Zugriff ist laut, befristet, protokolliert.</b>
     *
     * <p>Ohne Grund wird NICHTS angelegt (422 {@code grund_fehlt}, keine Zeile, kein Hinweis). Mit Grund gilt
     * er genau 24 Stunden — nicht bis zu einem Datum —, jeder Kundenadministrator findet ihn im Postfach, und
     * Jonas kann ihn jederzeit beenden.
     */
    @Test
    void a14NotfallZugriffIstEngUndLaut() throws Exception {
        Authentication support = plattform("sub-u8-notfall");
        String pfad = "/api/v1/admin/tenants/" + DEMO + "/unterstuetzung/notfall";

        long zeilenVorher = zugriffZeilen();
        long hinweiseVorher = hinweisZeilen();
        JsonNode ohneGrund = json(ruf(post(pfad, Map.of("standorte", List.of(standort.toString()),
                "umfang", "einrichten_und_bedienen")), support, 422));
        assertThat(ohneGrund.get("code").asText()).isEqualTo("grund_fehlt");
        assertThat(zugriffZeilen()).as("nichts angelegt").isEqualTo(zeilenVorher);
        assertThat(hinweisZeilen()).as("und niemand benachrichtigt").isEqualTo(hinweiseVorher);

        Instant vor = Instant.now();
        JsonNode notfall = json(ruf(post(pfad, Map.of("standorte", List.of(standort.toString()),
                "umfang", "einrichten_und_bedienen", "grund", "Wechselrichter meldet Fehler F42")), support, 201));
        Instant nach = Instant.now();
        UUID griff = UUID.fromString(notfall.get("id").asText());

        assertThat(notfall.get("art").asText()).isEqualTo("notfall");
        assertThat(notfall.get("gueltig_bis").isNull()).as("kein Enddatum, ein Zeitpunkt").isTrue();
        Instant endet = Instant.parse(notfall.get("endet").asText());
        assertThat(endet).isBetween(vor.plusSeconds(86400 - 5), nach.plusSeconds(86400 + 5));
        assertThat(notfall.get("banner").asText())
                .startsWith("VoltPilot-Support hat Notfall-Zugriff auf Werk Ahrenberg bis ")
                .endsWith(" — Grund: Wechselrichter meldet Fehler F42");

        // Er wirkt - über X-Kundenbereich, wie jede Unterstützung.
        assertThat(ruf(get("/api/v1/sites"), support, 200, KUNDENBEREICH, DEMO.toString())).isNotNull();

        // DIE BENACHRICHTIGUNG GEHT WIRKLICH RAUS: jeder Kundenadministrator, mit dem Grund im Satz.
        for (String ka : List.of(JONAS, INES)) {
            JsonNode h = hinweisZu(json(ruf(get("/api/v1/unterstuetzung/hinweise"), konto(ka, DEMO), 200)),
                    "notfall", griff);
            assertThat(h.get("text").asText()).contains("Notfall-Zugriff", "Wechselrichter meldet Fehler F42");
            assertThat(h.get("email_versandt_am").isNull()).as("solange kein SMTP steht").isTrue();
            // Und er lässt sich schließen - nur vom Empfänger selbst.
            ruf(post("/api/v1/unterstuetzung/hinweise/" + h.get("id").asText() + "/gelesen", null),
                    konto(ka, DEMO), 204);
        }
        // Ein fremdes Postfach schließt niemand: für den Leser gibt es diesen Hinweis nicht.
        JsonNode fremd = json(ruf(get("/api/v1/unterstuetzung/hinweise?offen=false"), konto(PETER_LESER, DEMO), 200));
        assertThat(fremd.isEmpty()).isTrue();

        // Verlängert wird ein Notfall-Zugriff nie; beendet jederzeit.
        assertThat(json(ruf(put("/api/v1/unterstuetzung/" + griff,
                Map.of("gueltig_bis", heute().plusDays(3).toString())), konto(JONAS, DEMO), 409))
                .get("code").asText()).isEqualTo("notfall_nicht_verlaengerbar");
        ruf(delete("/api/v1/unterstuetzung/" + griff, Map.of("grund", "Störung behoben")), konto(JONAS, DEMO), 204);
        ruf(get("/api/v1/sites"), support, 404, KUNDENBEREICH, DEMO.toString());
    }

    // ================================================================= Ablauf, Erinnerung, Verlängern

    /**
     * <b>Sie endet von selbst.</b> Der Läufer ist im Testlauf nicht einmal als Bohne da — und die abgelaufene
     * Unterstützung lässt trotzdem niemanden mehr hinein. Das Ende steht in der Zeile, nicht in einem Job.
     */
    @Test
    void eineAbgelaufeneUnterstuetzungLaesstNiemandenMehrHinein() throws Exception {
        assertThat(kontext.getBeanNamesForType(AblaufLaeufer.class))
                .as("der Takt ist im Testlauf AUS (surefire)").isEmpty();

        String sub = "sub-u8-abgelaufen";
        String email = "abgelaufen@elektro-brunner.example";
        when(keycloak.findByEmail(email))
                .thenReturn(Optional.of(new KeycloakUser(sub, email, email, "Alt", "Brunner", true, null)));
        JsonNode g = json(ruf(post("/api/v1/unterstuetzung", Map.of("art", "installateur", "email", email,
                "standorte", List.of(standort.toString()), "gueltig_ab", vorTagen(60),
                "gueltig_bis", heute().minusDays(1).toString())), konto(JONAS, DEMO), 201));
        UUID griff = UUID.fromString(g.get("id").asText());
        assertThat(g.get("zustand").asText()).isEqualTo("archiviert");
        // Der Vertrag nennt das ENDDATUM (letzter Tag einschließlich), nicht den Zeitpunkt danach.
        assertThat(g.get("text").asText())
                .isEqualTo("Endete am " + deutsch(heute().minusDays(1)) + " durch Zeitablauf");

        ruf(get("/api/v1/sites"), partner(sub), 404, KUNDENBEREICH, DEMO.toString());
        assertThat(json(ruf(get("/api/v1/me"), partner(sub), 200)).get("kundenbereiche").isEmpty()).isTrue();
        assertThat(protokoll(griff)).as("noch trug niemand den Ablauf nach").containsExactly("zuweisen");
        // Und verlängert wird sie nicht mehr - sie ist vorbei, eine neue Gewährung wäre ein neuer Eintrag.
        assertThat(json(ruf(put("/api/v1/unterstuetzung/" + griff,
                Map.of("gueltig_bis", heute().plusDays(10).toString())), konto(JONAS, DEMO), 409))
                .get("code").asText()).isEqualTo("bereits_beendet");
    }

    /**
     * Was der Läufer TUT: er trägt den Ablauf ins Protokoll ein („endete durch Zeitablauf", A4) und erinnert
     * sieben Tage vorher (E6) — beides wiederholbar, ein zweiter Takt meldet nichts doppelt.
     */
    @Test
    void derLaeuferTraegtDenAblaufNachUndErinnertSiebenTageVorher() throws Exception {
        String abgelaufen = "sub-u8-laeufer-alt";
        String bald = "sub-u8-laeufer-bald";
        String spaeter = "sub-u8-laeufer-spaet";
        UUID griffAlt = gewaehreDirekt(abgelaufen, "Alte Unterstützung", vorTagen(40), heute().minusDays(2));
        UUID griffBald = gewaehreDirekt(bald, "Bald zu Ende", vorTagen(20), heute().plusDays(3));
        UUID griffSpaet = gewaehreDirekt(spaeter, "Noch lange", vorTagen(1), heute().plusDays(30));

        AblaufLaeufer laeufer = new AblaufLaeufer(adminJdbc, dienst);
        UnterstuetzungService.Lauf lauf = laeufer.lauf(Instant.now());
        assertThat(lauf.abgelaufen()).isGreaterThanOrEqualTo(1);
        assertThat(lauf.erinnert()).isGreaterThanOrEqualTo(1);

        assertThat(protokoll(griffAlt)).containsExactly("zuweisen", "ablaufen");
        assertThat(protokoll(griffBald)).as("was läuft, wird nicht beendet").containsExactly("zuweisen");
        assertThat(protokoll(griffSpaet)).containsExactly("zuweisen");

        JsonNode postfach = json(ruf(get("/api/v1/unterstuetzung/hinweise"), konto(JONAS, DEMO), 200));
        assertThat(hinweisZu(postfach, "abgelaufen", griffAlt).get("text").asText())
                .isEqualTo("Endete am " + deutsch(heute().minusDays(2)) + " durch Zeitablauf · Alte Unterstützung");
        assertThat(hinweisZu(postfach, "erinnerung", griffBald).get("text").asText())
                .contains("Bald zu Ende (Installateur) hat Zugriff auf Werk Ahrenberg", "sie endet in 3 Tagen.");
        assertThat(hinweisText(postfach, "erinnerung", griffSpaet)).as("30 Tage sind keine Erinnerung").isNull();

        // Ein zweiter Takt meldet NICHTS doppelt - und trägt den Ablauf nicht zweimal ein.
        UnterstuetzungService.Lauf zweiter = laeufer.lauf(Instant.now());
        assertThat(zweiter.erinnert()).isZero();
        assertThat(protokoll(griffAlt)).containsExactly("zuweisen", "ablaufen");
        assertThat(anzahlHinweise("erinnerung", griffBald)).isEqualTo(2);
    }

    /**
     * Verlängern ist ein NEUES Enddatum (§4.6) unter AP-00 Invariante 4: die alte Zeile wird beendet, eine neue
     * beginnt lückenlos — und das Protokoll sagt {@code verlaengern}, damit später niemand einen Entzug liest,
     * wo verlängert wurde. Ein früheres Ende ist keine Verlängerung.
     */
    @Test
    void verlaengernIstEinNeuesEndeUndHeisstSoImProtokoll() throws Exception {
        String sub = "sub-u8-verlaengern";
        UUID alt = gewaehreDirekt(sub, "Verlängert Brunner", vorTagen(2), heute().plusDays(5));
        Authentication tb = partner(sub);
        assertThat(ruf(get("/api/v1/sites"), tb, 200, KUNDENBEREICH, DEMO.toString())).isNotNull();

        assertThat(json(ruf(put("/api/v1/unterstuetzung/" + alt,
                Map.of("gueltig_bis", heute().plusDays(2).toString())), konto(JONAS, DEMO), 422))
                .get("code").asText()).isEqualTo("ende_nicht_spaeter");

        LocalDate neu = heute().plusDays(40);
        JsonNode verlaengert = json(ruf(put("/api/v1/unterstuetzung/" + alt,
                Map.of("gueltig_bis", neu.toString())), konto(JONAS, DEMO), 200));
        UUID griffNeu = UUID.fromString(verlaengert.get("id").asText());
        assertThat(griffNeu).as("eine Zeile wird nie umgeschrieben").isNotEqualTo(alt);
        assertThat(verlaengert.get("gueltig_bis").asText()).isEqualTo(neu.toString());
        assertThat(protokoll(alt)).containsExactly("zuweisen", "verlaengern");
        assertThat(protokoll(griffNeu)).containsExactly("zuweisen");
        // Ohne Lücke: derselbe Partner kommt weiter herein.
        assertThat(ruf(get("/api/v1/sites"), tb, 200, KUNDENBEREICH, DEMO.toString())).isNotNull();
        // Und über 12 Monate hinaus geht es nicht (E6).
        assertThat(json(ruf(put("/api/v1/unterstuetzung/" + griffNeu,
                Map.of("gueltig_bis", heute().plusYears(2).toString())), konto(JONAS, DEMO), 422))
                .get("code").asText()).isEqualTo("hoechstens_12_monate");
        ruf(delete("/api/v1/unterstuetzung/" + griffNeu, Map.of()), konto(JONAS, DEMO), 204);
    }

    // ================================================================= Zaun und Bestand

    /** Wer nicht verwalten darf, sieht die Unterstützungen nicht — und legt keine an (E2). */
    @Test
    void einLeserVerwaltetKeineUnterstuetzungen() throws Exception {
        Authentication peter = konto(PETER_LESER, DEMO);
        assertThat(json(ruf(get("/api/v1/unterstuetzung"), peter, 403)).get("code").asText()).isEqualTo("recht_fehlt");
        assertThat(json(ruf(get("/api/v1/unterstuetzung/anfragen"), peter, 403)).get("code").asText())
                .isEqualTo("recht_fehlt");
        assertThat(json(ruf(post("/api/v1/unterstuetzung", Map.of("art", "installateur", "email", "a@b.example",
                "standorte", List.of(standort.toString()))), peter, 403)).get("code").asText())
                .isEqualTo("recht_fehlt");
        // Sein eigenes Postfach liest er sehr wohl (konto.eigenes) - es ist nur leer.
        assertThat(json(ruf(get("/api/v1/unterstuetzung/hinweise"), peter, 200)).isEmpty()).isTrue();
    }

    /** Ein Standort, den es im Kundenbereich nicht gibt, ist 422 — und es wird nichts geschrieben. */
    @Test
    void einFremderStandortGewaehrtNichts() throws Exception {
        long vorher = zugriffZeilen();
        assertThat(json(ruf(post("/api/v1/unterstuetzung", Map.of("art", "installateur", "email", "a@b.example",
                "standorte", List.of(UUID.randomUUID().toString())), null), konto(JONAS, DEMO), 422))
                .get("code").asText()).isEqualTo("standort_unbekannt");
        assertThat(json(ruf(post("/api/v1/unterstuetzung", Map.of("art", "installateur", "email", "a@b.example",
                "standorte", List.of()), null), konto(JONAS, DEMO), 422)).get("code").asText())
                .isEqualTo("standort_fehlt");
        assertThat(zugriffZeilen()).isEqualTo(vorher);
    }

    /**
     * <b>IP-15:</b> der Mandanten-Umschalter der Plattform ({@code X-Tenant-Id}) ist in Produktion geschlossen.
     * Mit {@code umschalter-enabled=false} wird eine Anfrage ohne Gewährung abgewiesen (der
     * {@code ZugriffFilter} macht daraus die 404 jeder Kundenroute, wie für einen Partner ohne Gewährung),
     * während eine gewährte Unterstützung sie weiterhin hereinlässt.
     */
    @Test
    void derMandantenUmschalterIstSeitIp15Geschlossen() throws Exception {
        Authentication support = plattform("sub-u8-umschalter");
        assertThat(ruf(get("/api/v1/sites"), support, 404, TENANT, DEMO.toString())).as("IP-15: ohne Unterstützung kein Kundenweg").isNotNull();

        String sub = "sub-u8-umschalter-gewaehrt";
        gewaehreDirekt(sub, "Umschalter-Probe", vorTagen(1), heute().plusDays(10));
        ZugriffKontextLader ohneUmschalter = new ZugriffKontextLader(zugriffe, new SimpleMeterRegistry(), false);
        try {
            TenantContext.set(DEMO);
            assertThat(ohneUmschalter.laden(support, null).abgewiesen()).as("ohne Gewährung abgewiesen").isTrue();
            TenantContext.set(DEMO);
            assertThat(ohneUmschalter.laden(partner(sub), DEMO.toString()).abgewiesen())
                    .as("mit Gewährung weiterhin herein").isFalse();
        } finally {
            TenantContext.clear();
        }
    }

    // ================================================================= Helfer

    private static LocalDate heute() {
        return LocalDate.now(ZoneId.of("Europe/Berlin"));
    }

    private static String vorTagen(int tage) {
        return heute().minusDays(tage).atStartOfDay(ZoneId.of("Europe/Berlin")).toOffsetDateTime().toString();
    }

    private static String deutsch(LocalDate tag) {
        return String.format("%02d.%02d.%d", tag.getDayOfMonth(), tag.getMonthValue(), tag.getYear());
    }

    /** Eine Gewährung über die Route, mit einem bekannten Partner-Konto — der Griff der Gewährung. */
    private UUID gewaehreDirekt(String sub, String name, String ab, LocalDate bis) throws Exception {
        String email = sub + "@elektro-brunner.example";
        when(keycloak.findByEmail(email))
                .thenReturn(Optional.of(new KeycloakUser(sub, email, email, name, "", true, null)));
        JsonNode g = json(ruf(post("/api/v1/unterstuetzung", Map.of("art", "installateur", "email", email,
                "standorte", List.of(standort.toString()), "gueltig_ab", ab, "gueltig_bis", bis.toString(),
                "grund", name)), konto(JONAS, DEMO), 201));
        return UUID.fromString(g.get("id").asText());
    }

    private static void kundenadministrator(String sub, String name) {
        spiegel(sub, "benutzer", name);
        root.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, gueltig_ab, zeitzone) "
                + "VALUES (?, ?, 'kundenadministrator', now() - interval '30 days', 'Europe/Berlin')", DEMO, sub);
    }

    private static void spiegel(String sub, String konto, String name) {
        root.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                + "VALUES (?, ?, ?, ?, 'aktiv') ON CONFLICT DO NOTHING", DEMO, sub, konto, name);
    }

    private List<String> protokoll(UUID zugriffId) {
        // Der Griff ist die kleinste id der Gewährung; das Protokoll trägt eine Zeile je Zuweisungszeile.
        return root.queryForList("SELECT aktion FROM zugriff_protokoll WHERE tenant_id = ? AND zugriff_id = ? "
                + "ORDER BY id", String.class, DEMO, zugriffId);
    }

    private long zugriffZeilen() {
        return root.queryForObject("SELECT count(*) FROM zugriff WHERE tenant_id = ?", Long.class, DEMO);
    }

    private long hinweisZeilen() {
        return root.queryForObject("SELECT count(*) FROM unterstuetzung_hinweis WHERE tenant_id = ?", Long.class,
                DEMO);
    }

    private int anzahlHinweise(String anlass, UUID zugriffId) {
        return root.queryForObject("SELECT count(*) FROM unterstuetzung_hinweis WHERE tenant_id = ? AND anlass = ? "
                + "AND zugriff_id = ?", Integer.class, DEMO, anlass, zugriffId);
    }

    private static JsonNode eintrag(JsonNode liste, UUID id) {
        for (JsonNode n : liste) {
            if (id.toString().equals(n.get("id").asText())) {
                return n;
            }
        }
        throw new AssertionError("Kein Eintrag " + id + " in " + liste);
    }

    private static JsonNode hinweisZu(JsonNode liste, String anlass, UUID bezug) {
        for (JsonNode n : liste) {
            if (anlass.equals(n.get("anlass").asText()) && bezug.toString().equals(bezugVon(n))) {
                return n;
            }
        }
        throw new AssertionError("Kein Hinweis " + anlass + " zu " + bezug + " in " + liste);
    }

    private static String hinweisText(JsonNode liste, String anlass, UUID bezug) {
        for (JsonNode n : liste) {
            if (anlass.equals(n.get("anlass").asText()) && bezug.toString().equals(bezugVon(n))) {
                return n.get("text").asText();
            }
        }
        return null;
    }

    private static String bezugVon(JsonNode hinweis) {
        JsonNode u = hinweis.get("unterstuetzung");
        return u != null && !u.isNull() ? u.asText() : hinweis.get("anfrage").asText();
    }

    private static List<String> rechteAmStandort(JsonNode me) {
        JsonNode standorte = me.get("standorte");
        assertThat(standorte.isEmpty()).as("der Unterstützer sieht seinen Standort").isFalse();
        return MAPPER.convertValue(standorte.get(0).get("rechte"), List.class);
    }

    private static MockHttpServletRequestBuilder get(String pfad) {
        return MockMvcRequestBuilders.get(pfad);
    }

    private static MockHttpServletRequestBuilder post(String pfad, Map<String, Object> koerper) {
        MockHttpServletRequestBuilder b = MockMvcRequestBuilders.post(pfad);
        return koerper == null ? b : b.contentType(MediaType.APPLICATION_JSON).content(schreibe(koerper));
    }

    private static MockHttpServletRequestBuilder post(String pfad, Map<String, Object> koerper, Object unbenutzt) {
        return post(pfad, koerper);
    }

    private static MockHttpServletRequestBuilder put(String pfad, Map<String, Object> koerper) {
        return MockMvcRequestBuilders.put(pfad).contentType(MediaType.APPLICATION_JSON).content(schreibe(koerper));
    }

    private static MockHttpServletRequestBuilder delete(String pfad, Map<String, Object> koerper) {
        return MockMvcRequestBuilders.delete(pfad).contentType(MediaType.APPLICATION_JSON).content(schreibe(koerper));
    }

    private static String schreibe(Map<String, Object> koerper) {
        try {
            return MAPPER.writeValueAsString(koerper);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String ruf(MockHttpServletRequestBuilder b, Authentication auth, int erwartet, String... koepfe)
            throws Exception {
        MockHttpServletRequestBuilder r = b.with(authentication(auth));
        for (int i = 0; i + 1 < koepfe.length; i += 2) {
            r = r.header(koepfe[i], koepfe[i + 1]);
        }
        MvcResult res = mvc.perform(r).andReturn();
        String body = res.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(res.getResponse().getStatus()).as(b + " → " + body).isEqualTo(erwartet);
        return body;
    }

    private static JsonNode json(String body) throws Exception {
        return MAPPER.readTree(body);
    }

    private static Authentication konto(String sub, UUID tenant) {
        return auth(sub, tenant, "operator");
    }

    private static Authentication partner(String sub) {
        return auth(sub, null, "partner");
    }

    private static Authentication plattform(String sub) {
        return auth(sub, null, "platform-admin");
    }

    private static Authentication auth(String sub, UUID tenant, String... realmRollen) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", sub);
        claims.put("preferred_username", sub);
        claims.put("realm_access", Map.of("roles", List.of(realmRollen)));
        if (tenant != null) {
            claims.put("tenant_id", tenant.toString());
        }
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), claims);
        return new KeycloakRealmRoleConverter().convert(jwt);
    }
}
