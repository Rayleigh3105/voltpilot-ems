package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.authentication;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import com.voltpilot.api.repo.TenantRepository;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-20, Folge zu IP-18 (E10 = A), Befund 3 aus PR 1281: ein Verdichtungslauf, der vor dem Commit des Löschzugs
 * gelesen hat, schreibt danach keine Buckets des gelöschten Bereichs zurück (V20260926004700).
 *
 * <p>Die drei Timescale-Jobs laufen hier von Hand in einer eigenen Transaktion wie im Betrieb; ihr Zeitplan ist
 * angehalten, damit kein Hintergrundlauf dazwischenschreibt. Beide Reihenfolgen: der Lauf sperrt zuerst (der Löschzug
 * wartet und nimmt die frischen Buckets mit), der Löschzug sperrt zuerst (der Lauf lässt den Bereich aus, ohne zu
 * warten). Der Nachbar wird in beiden Fällen weiter verdichtet.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class LoeschzugRollupNachlaeuferApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BETREIBER = "betrieb-voss";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    /** Die drei Nachläufer: Timescale-Jobs, die ein Zeitfenster verdichten und mit ON CONFLICT schreiben. */
    private static final List<String> JOBS = List.of("telemetry_rollups_job", "telemetry_v2_rollups_job",
            "device_measurement_rollup_job");

    /** Was sie schreiben. */
    private static final List<String> VERDICHTUNGEN = List.of("telemetry_rollup_15m", "telemetry_rollup_1h",
            "telemetry_rollup_1d", "telemetry_v2_rollup_15m", "telemetry_v2_rollup_1h", "telemetry_v2_rollup_1d",
            "device_measurement_rollup_5m", "device_measurement_rollup_15m");

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");
        registry.add("spring.flyway.placeholders.adminDbUser", () -> "voltpilot_admin");
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> "voltpilot_admin_test_pw");
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

    @Autowired MockMvc mvc;
    @MockBean KeycloakAdminClient keycloak;

    private JdbcTemplate root;

    /** Ein Bereich mit einer Anlage und einer Box. */
    private record Bereich(UUID id, String name, UUID site, UUID box) {}

    @BeforeEach
    void verbinden() {
        root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword()));
        for (String job : JOBS) {
            root.queryForList("SELECT alter_job(job_id, scheduled => false) FROM timescaledb_information.jobs"
                    + " WHERE proc_name = ?", job);
        }
    }

    /**
     * Der Befund: der Lauf liest und schreibt die frischen Buckets beider Bereiche (noch nicht committet), der Löschzug
     * kommt dazwischen. Vorher committete der Löschzug sofort, sah die neuen Buckets nicht, und der Lauf schrieb sie
     * danach in den gelöschten Bereich. Jetzt wartet der Löschzug an seiner ersten Sperre, bis der Lauf committet hat,
     * und nimmt die Buckets mit.
     */
    @Test
    void derLaufSperrtZuerstUndDerLoeschzugNimmtSeineBucketsMit() throws Exception {
        Bereich weg = bereich();
        Bereich nachbar = bereich();
        vertragsendeVor(weg.id(), 91);

        MvcResult geloescht;
        boolean loeschzugWartete;
        try (Connection lauf = POSTGRES.createConnection("")) {
            lauf.setAutoCommit(false);
            laufen(lauf);
            assertThat(verdichtet(lauf, weg.id())).as("der Lauf hat die Buckets des Bereichs geschrieben")
                    .containsOnlyKeys(VERDICHTUNGEN);

            CompletableFuture<MvcResult> loeschzug = CompletableFuture.supplyAsync(() -> loeschen(weg));
            loeschzugWartete = wartetAufSperre(loeschzug);
            lauf.commit();
            geloescht = loeschzug.get(60, TimeUnit.SECONDS);
        }

        assertThat(geloescht.getResponse().getStatus()).as(text(geloescht)).isEqualTo(200);
        JsonNode nachweis = json(geloescht).get("loeschnachweis");
        assertThat(nachweis.get("verblieben").size()).as("verblieben im Löschnachweis").isZero();
        assertThat(katalog(weg.id())).as("E10 = A: keine Zeile des gelöschten Bereichs, auch kein Bucket").isEmpty();
        assertThat(verdichtet(root, nachbar.id())).as("der Nachbar ist verdichtet").containsOnlyKeys(VERDICHTUNGEN);
        assertThat(loeschzugWartete).as("der Löschzug wartete auf den Lauf, statt an ihm vorbei zu committen")
                .isTrue();
        System.out.printf("Nachläufer: Lauf zuerst - Löschzug wartete, %s, verblieben %s, Nachbar verdichtet in %s%n",
                nachweis.get("kennzeichen").asText(), nachweis.get("verblieben"), verdichtet(root, nachbar.id()));
    }

    /**
     * Die andere Reihenfolge: der Löschzug hält seine erste Sperre (FOR UPDATE auf die Mandantenzeile, wie
     * {@code KundenbereichLoeschung.Wache#vorDemAbbau}). Der Lauf wartet nicht, schreibt für den Bereich nichts und
     * verdichtet den Nachbarn.
     */
    @Test
    void derLoeschzugSperrtZuerstUndDerLaufLaesstDenBereichAus() throws Exception {
        Bereich weg = bereich();
        Bereich nachbar = bereich();
        vertragsendeVor(weg.id(), 91);

        try (Connection loeschzug = POSTGRES.createConnection("");
                Connection lauf = POSTGRES.createConnection("")) {
            loeschzug.setAutoCommit(false);
            try (Statement st = loeschzug.createStatement()) {
                st.executeQuery("SELECT id FROM tenant WHERE id = '" + weg.id() + "' FOR UPDATE").close();
            }
            try (Statement st = lauf.createStatement()) {
                st.execute("SET lock_timeout = '5s'");
            }
            long start = System.nanoTime();
            laufen(lauf);
            long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
            assertThat(verdichtet(lauf, weg.id())).as("kein Bucket für den Bereich, dessen Löschzug läuft").isEmpty();
            assertThat(verdichtet(lauf, nachbar.id())).as("der Nachbar ist verdichtet").containsOnlyKeys(VERDICHTUNGEN);
            loeschzug.rollback();
            System.out.printf("Nachläufer: Löschzug zuerst - Lauf in %d ms ohne Warten, Bereich ausgelassen,"
                    + " Nachbar verdichtet in %s%n", ms, verdichtet(lauf, nachbar.id()));
        }

        MvcResult geloescht = loeschen(weg);
        assertThat(geloescht.getResponse().getStatus()).as(text(geloescht)).isEqualTo(200);
        assertThat(katalog(weg.id())).isEmpty();
    }

    /** Die drei Jobs, wie der Scheduler sie ruft, in der Transaktion der Verbindung. */
    private static void laufen(Connection con) throws Exception {
        try (Statement st = con.createStatement()) {
            for (String job : JOBS) {
                st.execute("CALL " + job + "(0, '{}'::jsonb)");
            }
        }
    }

    /** Wartet, bis der Löschzug an einer Sperre steht (true) oder schon fertig ist (false). */
    private boolean wartetAufSperre(CompletableFuture<MvcResult> loeschzug) throws InterruptedException {
        for (int i = 0; i < 100 && !loeschzug.isDone(); i++) {
            Long wartend = root.queryForObject("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
                    + " AND wait_event_type = 'Lock' AND query ILIKE '%FROM tenant WHERE id = % FOR UPDATE%'", Long.class);
            if (wartend != null && wartend > 0) {
                return true;
            }
            Thread.sleep(100);
        }
        return false;
    }

    /** Zeilen des Mandanten je Verdichtungstabelle, nur die mit Zeilen — gelesen über die übergebene Verbindung. */
    private static Map<String, Long> verdichtet(Connection con, UUID tenant) throws Exception {
        Map<String, Long> je = new TreeMap<>();
        try (Statement st = con.createStatement()) {
            for (String tabelle : VERDICHTUNGEN) {
                try (ResultSet rs = st.executeQuery("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = '"
                        + tenant + "'")) {
                    rs.next();
                    if (rs.getLong(1) > 0) {
                        je.put(tabelle, rs.getLong(1));
                    }
                }
            }
        }
        return je;
    }

    private Map<String, Long> verdichtet(JdbcTemplate jdbc, UUID tenant) {
        Map<String, Long> je = new TreeMap<>();
        for (String tabelle : VERDICHTUNGEN) {
            long n = jdbc.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, tenant);
            if (n > 0) {
                je.put(tabelle, n);
            }
        }
        return je;
    }

    /** Ein Bereich mit frischen Rohwerten in allen drei Quellen der Verdichtung, noch ohne Bucket. */
    private Bereich bereich() throws Exception {
        String nr = UUID.randomUUID().toString().substring(0, 8);
        String name = "Kunststoffwerk Ahrenberg " + nr;
        MvcResult angelegt = mvc.perform(post("/api/v1/admin/tenants").contentType(MediaType.APPLICATION_JSON)
                .content(JSON.writeValueAsString(Map.of("name", name))).with(authentication(plattform()))).andReturn();
        assertThat(angelegt.getResponse().getStatus()).isEqualTo(201);
        UUID id = UUID.fromString(json(angelegt).get("id").asText());
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name, bidding_zone) VALUES (?, 'Werk', 'DE-LU')"
                + " RETURNING id", UUID.class, id);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) VALUES (?, ?, ?)"
                + " RETURNING id", UUID.class, id, site, "nachlaeufer-" + nr);
        root.update("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES (now(), ?, ?, ?, 1.0)",
                id, site, box);
        root.update("INSERT INTO telemetry_v2 (time, tenant_id, site_id, device_id, entity_id, channel, value)"
                + " VALUES (now(), ?, ?, ?, ?, 'power', 1.0)", id, site, box, "werk-" + nr);
        root.update("INSERT INTO device_measurement_sample (time, received_at, tenant_id, site_id, device_id,"
                + " point_key, raw_text, decoded_text, quality, catalog_version, edge_sequence, aggregation_kind,"
                + " long_term_cadence_s, gap, dropped_samples) VALUES (now() - interval '1 minute', now(), ?, ?, ?,"
                + " 'deye.hybrid_1p.control.device-state', 'on', 'on', 'good', '2026.08.26.2', 1, 'state', NULL,"
                + " false, 0)", id, site, box);
        assertThat(verdichtet(root, id)).as("frischer Bereich: noch kein Bucket").isEmpty();
        return new Bereich(id, name, site, box);
    }

    /** Zeitraffer: der Bereich endete vor {@code tage} Kalendertagen (Berlin, mittags), Frist 90 Tage. */
    private void vertragsendeVor(UUID tenant, int tage) {
        root.update("UPDATE tenant SET beendet_am = ?, beendet_frist_tage = 90, beendet_von = ? WHERE id = ?",
                LocalDate.now(BERLIN).minusDays(tage).atTime(LocalTime.NOON).atZone(BERLIN).toOffsetDateTime(),
                BETREIBER, tenant);
    }

    /** Zeilen mit der Kennung je Katalog-Tabelle (jede Tabelle mit {@code tenant_id}), nur die mit Zeilen. */
    private Map<String, Long> katalog(UUID tenant) {
        Map<String, Long> je = new TreeMap<>();
        for (String tabelle : root.queryForList(TenantRepository.KATALOG_MIT_MANDANT, String.class)) {
            long n = root.queryForObject("SELECT count(*) FROM \"" + tabelle + "\" WHERE tenant_id = ?", Long.class,
                    tenant);
            if (n > 0) {
                je.put(tabelle, n);
            }
        }
        return je;
    }

    private MvcResult loeschen(Bereich b) {
        try {
            return mvc.perform(post("/api/v1/admin/tenants/" + b.id() + "/delete")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(JSON.writeValueAsString(Map.of("confirmName", b.name())))
                    .with(authentication(plattform()))).andReturn();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static JsonNode json(MvcResult r) throws Exception {
        return JSON.readTree(text(r));
    }

    private static String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static Authentication plattform() {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", BETREIBER);
        claims.put("preferred_username", BETREIBER);
        claims.put("realm_access", Map.of("roles", List.of("platform-admin")));
        return new KeycloakRealmRoleConverter().convert(new Jwt("token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "none"), claims));
    }
}
