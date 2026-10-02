package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.flows.FlowDeploymentPublisher;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * MiSpeL MP-48 gegen die Datenbank: {@code GET /api/v1/sites/{siteId}/mispel-check} über {@code site_mispel_check}
 * (V20261002234100, Vertrag {@code docs/contracts/v2/mispel-check.md}), auf einer frisch migrierten Datenbank.
 *
 * <p><b>Prüfnachweis:</b> ohne Zeile „wird gerechnet“ und nie ein Betrag; ein positives (Kundentyp a4) und ein
 * negatives Ergebnis (a2) mit den Posten der Beispielrechnung (Konzept § 3) kommen mit Vorzeichen zurück; die
 * Datenbank verbietet Beträge außerhalb von „fertig“; der Mandantenzaun hält beim Lesen und beim Schreiben (MP-13b).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class MispelCheckApiTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final AtomicInteger NR = new AtomicInteger();

    /** Kundentyp a4 aus der Beispielrechnung (Konzept § 3): große Anlage, ältere PV, kein Jahresmarktwert-Effekt. */
    static final String POSTEN_A4 = "[{\"art\":\"handel_saldierung\",\"niedrig_eur\":1658,\"mittel_eur\":2749,\"hoch_eur\":8343,"
            + "\"herkunft\":\"Beispielrechnung a4\"},"
            + "{\"art\":\"jahresmarktwert\",\"niedrig_eur\":0,\"mittel_eur\":0,\"hoch_eur\":0,\"herkunft\":\"Beispielrechnung a4\"},"
            + "{\"art\":\"zaehler_z2\",\"niedrig_eur\":-1000,\"mittel_eur\":-600,\"hoch_eur\":-300,\"herkunft\":\"Schätzung\"},"
            + "{\"art\":\"bilanzkreis\",\"niedrig_eur\":-500,\"mittel_eur\":-250,\"hoch_eur\":0,\"herkunft\":\"Schätzung\"}]";
    /** Kundentyp a2: 100 kWp, 65 kWh — der Handel trägt Zähler, Bilanzkreis und Jahresmarktwert nicht. */
    static final String POSTEN_A2 = "[{\"art\":\"handel_saldierung\",\"niedrig_eur\":199,\"mittel_eur\":330,\"hoch_eur\":1001,"
            + "\"herkunft\":\"Beispielrechnung a2\"},"
            + "{\"art\":\"jahresmarktwert\",\"niedrig_eur\":-420,\"mittel_eur\":-285,\"hoch_eur\":-110,\"herkunft\":\"Beispielrechnung a2\"},"
            + "{\"art\":\"zaehler_z2\",\"niedrig_eur\":-800,\"mittel_eur\":-450,\"hoch_eur\":-200,\"herkunft\":\"Schätzung\"},"
            + "{\"art\":\"bilanzkreis\",\"niedrig_eur\":-300,\"mittel_eur\":-150,\"hoch_eur\":0,\"herkunft\":\"Schätzung\"}]";
    static final String DATENBASIS = "[{\"angabe\":\"Jahresverbrauch\",\"wert\":60000,\"einheit\":\"kWh\","
            + "\"herkunft\":\"angenommen\",\"quelle\":\"Konzept § 3 a2\"}]";

    /** MP-13b: die Zeilen des Schreibers aus seinem Testlauf (Vertrag § 6). */
    static final Path SCHREIBER_BEISPIEL = Path.of("../../docs/contracts/v2/mispel-check-beispiel.json");

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

    @MockBean
    EntityRegistryPublisher registryPublisher;
    @MockBean
    FlowDeploymentPublisher flowPublisher;

    @Autowired
    MockMvc mvc;

    private static JdbcTemplate root;

    @BeforeAll
    static void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
    }

    private record Anlage(UUID mandant, UUID id) {}

    private record Antwort(int status, JsonNode body) {}

    @Test
    void ohneZeileWirdGerechnetUndNieNullEuro() throws Exception {
        Anlage a = anlage();
        Antwort r = ruf(a);
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.body().path("site_id").asText()).isEqualTo(a.id().toString());
        assertThat(r.body().path("stand").asText()).isEqualTo("wird_gerechnet");
        assertThat(r.body().path("stand_seit").isNull()).isTrue();
        assertThat(r.body().path("differenz").isNull()).isTrue();
        assertThat(r.body().path("posten").size()).isZero();
    }

    @Test
    void positivesErgebnisKundentypA4() throws Exception {
        Anlage a = anlage();
        fertig(a, 158, 1899, 8043, POSTEN_A4);
        Antwort r = ruf(a);
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.body().path("stand").asText()).isEqualTo("fertig");
        assertThat(r.body().path("formelsatz").asText()).isEqualTo("A1");
        assertThat(r.body().path("fenster_von").asText()).isEqualTo("2025-10-01");
        assertThat(r.body().path("fenster_bis").asText()).isEqualTo("2026-09-30");
        assertThat(r.body().path("differenz").path("mittel_eur").decimalValue()).isEqualByComparingTo("1899");
        assertThat(r.body().path("differenz").path("niedrig_eur").decimalValue()).isEqualByComparingTo("158");
        assertThat(r.body().path("differenz").path("hoch_eur").decimalValue()).isEqualByComparingTo("8043");
        JsonNode posten = r.body().path("posten");
        assertThat(posten.size()).isEqualTo(4);
        assertThat(posten.get(0).path("art").asText()).isEqualTo("handel_saldierung");
        assertThat(posten.get(2).path("mittel_eur").decimalValue()).isEqualByComparingTo("-600");
        assertThat(r.body().path("datenbasis").get(0).path("herkunft").asText()).isEqualTo("angenommen");
        assertThat(r.body().path("datenbasis").get(0).path("wert").asInt()).isEqualTo(60000);
    }

    @Test
    void negativesErgebnisKundentypA2MitVorzeichen() throws Exception {
        Anlage a = anlage();
        fertig(a, -1321, -555, 691, POSTEN_A2);
        Antwort r = ruf(a);
        assertThat(r.body().path("differenz").path("mittel_eur").decimalValue()).isEqualByComparingTo("-555");
        assertThat(r.body().path("differenz").path("niedrig_eur").decimalValue()).isEqualByComparingTo("-1321");
        JsonNode posten = r.body().path("posten");
        assertThat(posten.get(1).path("art").asText()).isEqualTo("jahresmarktwert");
        assertThat(posten.get(1).path("mittel_eur").decimalValue()).isEqualByComparingTo("-285");
    }

    @Test
    void ausserhalbVonFertigKeinBetrag() throws Exception {
        Anlage a = anlage();
        assertThatThrownBy(() -> root.update("INSERT INTO site_mispel_check (site_id, tenant_id, stand, "
                + "differenz_mittel_eur) VALUES (?, ?, 'wird_gerechnet', 0)", a.id(), a.mandant()))
                .hasMessageContaining("site_mispel_check_fertig_chk");
        assertThatThrownBy(() -> root.update("INSERT INTO site_mispel_check (site_id, tenant_id, stand, formelsatz) "
                + "VALUES (?, ?, 'fertig', 'A1')", a.id(), a.mandant()))
                .hasMessageContaining("site_mispel_check_fertig_chk");
        root.update("INSERT INTO site_mispel_check (site_id, tenant_id, stand, hinweis) VALUES (?, ?, "
                + "'nicht_unterstuetzt', 'Formelsatz A5: noch nicht unterstützt.')", a.id(), a.mandant());
        Antwort r = ruf(a);
        assertThat(r.body().path("stand").asText()).isEqualTo("nicht_unterstuetzt");
        assertThat(r.body().path("differenz").isNull()).isTrue();
        assertThat(r.body().path("hinweis").asText()).isEqualTo("Formelsatz A5: noch nicht unterstützt.");
    }

    @Test
    void fremdeUndUnbekannteAnlageIst404() throws Exception {
        Anlage a = anlage();
        Anlage b = anlage();
        fertig(a, 158, 1899, 8043, POSTEN_A4);
        assertThat(ruf(new Anlage(b.mandant(), a.id())).status()).isEqualTo(404);
        assertThat(ruf(new Anlage(b.mandant(), UUID.randomUUID())).status()).isEqualTo(404);
    }

    @Test
    void derSchreiberDarfImMandantenSchreibenUndNichtDaneben() {
        Anlage a = anlage();
        Anlage b = anlage();
        SingleConnectionDataSource ds = new SingleConnectionDataSource(POSTGRES.getJdbcUrl(), APP_USER, APP_PW, true);
        try {
            JdbcTemplate app = new JdbcTemplate(ds);
            app.queryForObject("SELECT set_config('app.tenant_id', ?, false)", String.class, a.mandant().toString());
            app.update("INSERT INTO site_mispel_check (site_id, tenant_id, stand) VALUES (?, ?, 'wird_gerechnet')",
                    a.id(), a.mandant());
            app.update("UPDATE site_mispel_check SET stand = 'fertig', stand_seit = now(), formelsatz = 'A1', "
                    + "fenster_von = DATE '2025-10-01', fenster_bis = DATE '2026-09-30', differenz_niedrig_eur = -1321, "
                    + "differenz_mittel_eur = -555, differenz_hoch_eur = 691, posten = ?::jsonb WHERE site_id = ?",
                    POSTEN_A2, a.id());
            assertThat(root.queryForObject("SELECT stand FROM site_mispel_check WHERE site_id = ?", String.class,
                    a.id())).isEqualTo("fertig");
            assertThatThrownBy(() -> app.update("INSERT INTO site_mispel_check (site_id, tenant_id, stand) "
                    + "VALUES (?, ?, 'wird_gerechnet')", b.id(), b.mandant()))
                    .rootCause().hasMessageContaining("row-level security");
            assertThatThrownBy(() -> app.update("DELETE FROM site_mispel_check WHERE site_id = ?", a.id()))
                    .rootCause().hasMessageContaining("permission denied");
        } finally {
            ds.destroy();
        }
    }

    /**
     * MP-13b: die Zeilen, wie der Schreiber ({@code services/optimization/.../simulation/mispel_check_lauf.py}) sie
     * ablegt — dieselbe Spaltenliste, Posten und Datenbasis aus seinem Testlauf
     * ({@code docs/contracts/v2/mispel-check-beispiel.json}, Form geprüft von {@code test_mispel_check_lauf_db.py}).
     */
    @Test
    void derSchreiberMp13bWirdGelesen() throws Exception {
        JsonNode beispiel = MAPPER.readTree(SCHREIBER_BEISPIEL.toFile());
        for (JsonNode z : beispiel.path("zeilen")) {
            Anlage a = anlage();
            root.update("INSERT INTO site_mispel_check (site_id, tenant_id, stand, stand_seit, formelsatz, fenster_von, "
                    + "fenster_bis, differenz_niedrig_eur, differenz_mittel_eur, differenz_hoch_eur, posten, datenbasis, "
                    + "hinweis) VALUES (?, ?, ?, now(), ?, ?::date, ?::date, ?, ?, ?, ?::jsonb, ?::jsonb, ?)",
                    a.id(), a.mandant(), z.path("stand").asText(), text(z, "formelsatz"), text(z, "fenster_von"),
                    text(z, "fenster_bis"), zahl(z, "differenz_niedrig_eur"), zahl(z, "differenz_mittel_eur"),
                    zahl(z, "differenz_hoch_eur"), z.path("posten").toString(), z.path("datenbasis").toString(),
                    text(z, "hinweis"));
            Antwort r = ruf(a);
            assertThat(r.status()).isEqualTo(200);
            assertThat(r.body().path("stand").asText()).isEqualTo(z.path("stand").asText());
            assertThat(r.body().path("formelsatz").asText()).isEqualTo(z.path("formelsatz").asText());
            if ("fertig".equals(z.path("stand").asText())) {
                assertThat(r.body().path("differenz").path("mittel_eur").decimalValue())
                        .isEqualByComparingTo(z.path("differenz_mittel_eur").decimalValue());
                assertThat(r.body().path("fenster_bis").asText()).isEqualTo(z.path("fenster_bis").asText());
            } else {
                assertThat(r.body().path("differenz").isNull()).isTrue();
                assertThat(r.body().path("hinweis").asText()).isEqualTo(z.path("hinweis").asText());
            }
            assertThat(r.body().path("posten")).isEqualTo(z.path("posten"));
            assertThat(r.body().path("datenbasis")).isEqualTo(z.path("datenbasis"));
        }
    }

    // ------------------------------------------------------------------ Hilfen

    private static String text(JsonNode z, String feld) {
        return z.path(feld).isNull() || z.path(feld).isMissingNode() ? null : z.path(feld).asText();
    }

    private static java.math.BigDecimal zahl(JsonNode z, String feld) {
        return z.path(feld).isNumber() ? z.path(feld).decimalValue() : null;
    }

    private Anlage anlage() {
        int nr = NR.incrementAndGet();
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class,
                "MiSpeL Check #" + nr);
        UUID s = root.queryForObject("INSERT INTO site (tenant_id, name, plant_kind, netzladen_erlaubt) "
                + "VALUES (?, ?, 'direktvermarktung', false) RETURNING id", UUID.class, t, "Werk " + nr);
        return new Anlage(t, s);
    }

    private static void fertig(Anlage a, int niedrig, int mittel, int hoch, String posten) {
        root.update("INSERT INTO site_mispel_check (site_id, tenant_id, stand, stand_seit, formelsatz, fenster_von, "
                + "fenster_bis, differenz_niedrig_eur, differenz_mittel_eur, differenz_hoch_eur, posten, datenbasis) "
                + "VALUES (?, ?, 'fertig', TIMESTAMPTZ '2026-10-02 12:00:00+00', 'A1', DATE '2025-10-01', "
                + "DATE '2026-09-30', ?, ?, ?, ?::jsonb, ?::jsonb)", a.id(), a.mandant(), niedrig, mittel, hoch, posten,
                DATENBASIS);
    }

    private Antwort ruf(Anlage a) throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/sites/" + a.id() + "/mispel-check")
                .with(jwt().jwt(j -> {
                    j.subject("sub-mispel-check-" + a.mandant());
                    j.claim("name", "Mara Test");
                    j.claim("tenant_id", a.mandant().toString());
                }))).andReturn();
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Antwort(r.getResponse().getStatus(), text.isEmpty() ? NullNode.getInstance() : MAPPER.readTree(text));
    }
}
