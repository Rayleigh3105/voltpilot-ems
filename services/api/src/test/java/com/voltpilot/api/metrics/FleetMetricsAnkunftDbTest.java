package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.FleetMetricsRepository;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die jüngste Mess-ANKUNFT je Anlage ({@link FleetMetricsRepository#lastTelemetryPerSite()}) sucht zuerst nur in
 * den Chunks der letzten Tage und steigt nur für Geräte ohne frische Zeile in die ganze Historie ab (Lasttest
 * vp-lasttest, Befund B3/B6, Rang 6). Belegt an echten Chunks gegen die bisherige Abfrage (je Gerät ein Abstieg
 * in jeden Chunk): dieselben Werte für eine laufende Box, eine seit Tagen stille Box und eine Box, deren Uhr in der
 * Vergangenheit steht; für den einen dokumentierten Sonderfall (eine Box spielt NACH ihrer jüngsten laufenden
 * Messung nur noch Altes nach) die frische Ankunft. Und die Arbeit: Buffer je Lauf vorher und nachher.
 */
@Testcontainers(disabledWithoutDocker = true)
class FleetMetricsAnkunftDbTest {

    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "pw_admin";
    private static final Instant JETZT = Instant.now().truncatedTo(ChronoUnit.SECONDS);

    private static final UUID TENANT = UUID.fromString("aaaa0000-0000-0000-0000-0000000000b6");
    private static final UUID LAUFEND = UUID.fromString("11110000-0000-0000-0000-0000000000b6");
    private static final UUID STILL = UUID.fromString("22220000-0000-0000-0000-0000000000b6");
    private static final UUID UHR_FALSCH = UUID.fromString("33330000-0000-0000-0000-0000000000b6");
    private static final UUID NACHSPIEL = UUID.fromString("44440000-0000-0000-0000-0000000000b6");

    /** Die bisherige Abfrage - je Gerät ein Abstieg in jeden Chunk. */
    private static final String VORHER = "SELECT d.site_id, max(ls.last_seen) AS last_seen FROM device d "
            + "LEFT JOIN LATERAL (SELECT max(received_at) AS last_seen FROM telemetry t WHERE t.device_id = d.id) ls "
            + "ON true WHERE d.ausgebaut_am IS NULL GROUP BY d.site_id";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static DataSource ds(String user, String pw) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(pw);
        return ds;
    }

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration").baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        try (Connection c = ds(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection()) {
            exec(c, "INSERT INTO tenant (id, name) VALUES (?, 'Ankunft-Mandant')", TENANT);
            for (UUID anlage : new UUID[] {LAUFEND, STILL, UHR_FALSCH, NACHSPIEL}) {
                exec(c, "INSERT INTO site (id, tenant_id, name) VALUES (?, ?, ?)", anlage, TENANT, "A " + anlage);
                exec(c, "INSERT INTO device (id, tenant_id, site_id, external_ref, status) VALUES (?, ?, ?, ?, "
                        + "'claimed')", anlage, TENANT, anlage, "ref-" + anlage);
            }
            // Ein halbes Jahr Historie je Box, eine Zeile je Stunde: rund 26 Chunks wie in einem laufenden Betrieb.
            reihe(c, LAUFEND, JETZT.minus(Duration.ofDays(180)), JETZT.minus(Duration.ofMinutes(1)), Duration.ZERO);
            reihe(c, STILL, JETZT.minus(Duration.ofDays(180)), JETZT.minus(Duration.ofDays(5)), Duration.ZERO);
            reihe(c, NACHSPIEL, JETZT.minus(Duration.ofDays(180)), JETZT.minus(Duration.ofMinutes(10)),
                    Duration.ZERO);
            // Uhr falsch: Beobachtungen im Jahr 2025, angekommen bis vor 3 Minuten.
            exec(c, "INSERT INTO telemetry (time, tenant_id, site_id, device_id, received_at, power_kw) "
                    + "SELECT timestamptz '2025-01-01' + g * interval '1 hour', ?, ?, ?, "
                    + "?::timestamptz - (200 - g) * interval '1 minute', 1.0 FROM generate_series(0, 200) g",
                    TENANT, UHR_FALSCH, UHR_FALSCH, Timestamp.from(JETZT.minus(Duration.ofMinutes(3))));
            // Nachspiel: nach der jüngsten laufenden Messung (vor 10 min) kommen nur noch Beobachtungen von vor
            // sechs Tagen an, zuletzt vor 30 s.
            exec(c, "INSERT INTO telemetry (time, tenant_id, site_id, device_id, received_at, power_kw) "
                    + "SELECT ?::timestamptz - interval '6 days' + g * interval '1 minute' + interval '7 seconds', "
                    + "?, ?, ?, ?::timestamptz - (20 - g) * interval '1 second', 1.0 FROM generate_series(0, 20) g",
                    Timestamp.from(JETZT), TENANT, NACHSPIEL, NACHSPIEL,
                    Timestamp.from(JETZT.minus(Duration.ofSeconds(30))));
            try (Statement s = c.createStatement()) {
                s.execute("ANALYZE");
            }
        }
    }

    private static void reihe(Connection c, UUID box, Instant von, Instant bis, Duration verzug) throws Exception {
        exec(c, "INSERT INTO telemetry (time, tenant_id, site_id, device_id, received_at, power_kw) "
                + "SELECT g, ?, ?, ?, g + ?::interval, 1.0 FROM generate_series(?::timestamptz, ?::timestamptz, "
                + "interval '1 hour') g", TENANT, box, box, verzug.toSeconds() + " seconds",
                Timestamp.from(von), Timestamp.from(bis));
        // Die jüngste Zeile genau auf "bis", auch wenn das Stundenraster sie verfehlt.
        exec(c, "INSERT INTO telemetry (time, tenant_id, site_id, device_id, received_at, power_kw) "
                + "VALUES (?, ?, ?, ?, ?, 1.0) ON CONFLICT DO NOTHING", Timestamp.from(bis), TENANT, box, box,
                Timestamp.from(bis.plus(verzug)));
    }

    private static void exec(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            ps.execute();
        }
    }

    private static Map<UUID, Instant> vorher() {
        Map<UUID, Instant> m = new HashMap<>();
        new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW)).query(VORHER, rs -> {
            Timestamp t = rs.getTimestamp("last_seen");
            if (t != null) {
                m.put(rs.getObject("site_id", UUID.class), t.toInstant());
            }
        });
        return m;
    }

    @Test
    void dieselbeAnkunftWieVorherFuerLaufendeStilleUndFalschGestellteBoxen() {
        Map<UUID, Instant> nachher = new FleetMetricsRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW)))
                .lastTelemetryPerSite();
        Map<UUID, Instant> vorher = vorher();
        for (UUID anlage : new UUID[] {LAUFEND, STILL, UHR_FALSCH}) {
            assertThat(nachher.get(anlage)).as("Anlage %s", anlage).isEqualTo(vorher.get(anlage));
        }
        assertThat(nachher.get(LAUFEND)).isEqualTo(JETZT.minus(Duration.ofMinutes(1)));
        assertThat(nachher.get(STILL)).isEqualTo(JETZT.minus(Duration.ofDays(5)));
        assertThat(nachher.get(UHR_FALSCH)).isEqualTo(JETZT.minus(Duration.ofMinutes(3)));
    }

    /**
     * Der dokumentierte Sonderfall: hat eine Box eine frische Messung und kommt DANACH nur noch Altes an, nennt die
     * Abfrage die Ankunft der frischen Messung (hier 10 min statt 30 s alt). Sobald wieder eine laufende Messung
     * ankommt, ist es dieselbe Zahl wie vorher.
     */
    @Test
    void eineBoxDieNachIhrerJuengstenMessungNurAltesNachspieltNenntDieFrischeAnkunft() {
        Map<UUID, Instant> nachher = new FleetMetricsRepository(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW)))
                .lastTelemetryPerSite();
        assertThat(vorher().get(NACHSPIEL)).isEqualTo(JETZT.minus(Duration.ofSeconds(30)));
        assertThat(nachher.get(NACHSPIEL)).isEqualTo(JETZT.minus(Duration.ofMinutes(10)));
    }

    @Test
    void dieArbeitJeLaufSinktMitDerZahlDerChunks() throws Exception {
        long vorher = buffer(VORHER);
        String nachherSql = "SELECT d.site_id, max(coalesce((SELECT max(t.received_at) FROM telemetry t WHERE "
                + "t.device_id = d.id AND t.time >= now() - interval '2 days'), (SELECT max(t.received_at) FROM "
                + "telemetry t WHERE t.device_id = d.id))) AS last_seen FROM device d WHERE d.ausgebaut_am IS NULL "
                + "GROUP BY d.site_id";
        long nachher = buffer(nachherSql);
        long chunks;
        try (Connection c = ds(POSTGRES.getUsername(), POSTGRES.getPassword()).getConnection();
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SELECT count(*) FROM show_chunks('telemetry')")) {
            rs.next();
            chunks = rs.getLong(1);
        }
        System.out.printf("[FleetMetrics] juengste Ankunft, 4 Boxen, %d Chunks: Buffer vorher %d, nachher %d%n",
                chunks, vorher, nachher);
        assertThat(nachher).isLessThan(vorher);
    }

    /** Summe der Buffer (Treffer + gelesen) eines EXPLAIN (ANALYZE, BUFFERS) über die Admin-Rolle. */
    private static long buffer(String sql) throws Exception {
        long summe = 0;
        try (Connection c = ds(ADMIN_USER, ADMIN_PW).getConnection();
                Statement s = c.createStatement()) {
            s.executeQuery(sql).close(); // aufwärmen
            try (ResultSet rs = s.executeQuery("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql)) {
                rs.next();
                String plan = rs.getString(1);
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("\"Shared Hit Blocks\": (\\d+),\\s*\"Shared Read Blocks\": (\\d+)").matcher(plan);
                if (m.find()) {
                    summe = Long.parseLong(m.group(1)) + Long.parseLong(m.group(2));
                }
            }
        }
        return summe;
    }
}
