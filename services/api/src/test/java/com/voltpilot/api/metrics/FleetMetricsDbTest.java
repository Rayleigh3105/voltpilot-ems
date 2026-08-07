package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.FleetMetricsRepository;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
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
 * Die Metriken gegen eine ECHTE TimescaleDB mit bekannten Werten - das SQL, das
 * {@code FleetMetricsScrapeTest} bewusst wegattrappt.
 *
 * <p>Gesät wird eine Flotte, in der jede Lage der Ableitung genau einmal
 * vorkommt und die Zahlen von Hand nachgerechnet sind: eine gesunde Anlage, eine
 * mit einem Fahrplan JENSEITS des 7-Tage-Fensters, eine ohne jeden Fahrplan und
 * ohne Messung, und eine zweite Gebotszone, für die es keinen einzigen Preis
 * gibt. Geprüft wird der ganze Weg bis in den Scrape-Rumpf.
 *
 * <p>Der Test misst ausserdem, was ein Sammel-Lauf kostet (siehe
 * {@link #aCollectRunCostsLittleEnoughToRunEveryMinute()}) - die Zahl steht im
 * PR, damit die Taktvorgabe belegt und nicht geraten ist.
 *
 * <p>Läuft ohne Spring-Kontext: Flyway migriert, danach werden Repository und
 * Sammler direkt gebaut. Auto-Skip ohne Docker.
 */
@Testcontainers(disabledWithoutDocker = true)
class FleetMetricsDbTest {

    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "pw_admin";

    /** Ein fester „Jetzt"-Zeitpunkt, auf den alles Gesäte bezogen ist. */
    private static final Instant NOW = Instant.parse("2026-08-07T09:07:30Z");

    private static final UUID TENANT = UUID.fromString("aaaa0000-0000-0000-0000-00000000000a");
    private static final UUID GESUND = UUID.fromString("11110000-0000-0000-0000-000000000001");
    private static final UUID VERALTET = UUID.fromString("22220000-0000-0000-0000-000000000002");
    private static final UUID FRISCH = UUID.fromString("33330000-0000-0000-0000-000000000003");

    /** Menge der Saat - gross genug, dass mehrere Chunks entstehen. */
    private static final int TAGE = 60;

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

    /** Die BYPASSRLS-Rolle, an der der Sammler haengt - genau wie in Produktion. */
    private static DataSource adminRole() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(ADMIN_USER);
        ds.setPassword(ADMIN_PW);
        return ds;
    }

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load()
                .migrate();

        try (Connection c = superuser().getConnection()) {
            exec(c, "INSERT INTO tenant (id, name) VALUES (?, 'Metrik-Mandant')", TENANT);
            site(c, GESUND, "Anlage gesund", "DE-LU");
            site(c, VERALTET, "Anlage veraltet", "DE-LU");
            // Eigene Zone OHNE einen einzigen Preis - der Vorfall.
            site(c, FRISCH, "Anlage frisch", "AT");

            UUID geraetGesund = UUID.randomUUID();
            UUID geraetVeraltet = UUID.randomUUID();
            device(c, geraetGesund, GESUND, "dev-gesund");
            device(c, geraetVeraltet, VERALTET, "dev-veraltet");
            // FRISCH hat gar kein Geraet - die Anlage, die nie gemeldet hat.

            // Telemetrie ueber 60 Tage im 15-Minuten-Raster (mehrere Chunks).
            // GESUND meldet bis vor 2 Minuten, VERALTET zuletzt vor 9 Stunden.
            telemetry(c, geraetGesund, GESUND, NOW.minus(Duration.ofMinutes(2)));
            telemetry(c, geraetVeraltet, VERALTET, NOW.minus(Duration.ofHours(9)));

            // Plaene: GESUND hat einen Lauf vor 30 Minuten. VERALTET hat welche,
            // aber der juengste liegt 9 Tage zurueck - also JENSEITS des Fensters.
            schedule(c, GESUND, geraetGesund, NOW.minus(Duration.ofMinutes(30)));
            schedule(c, VERALTET, geraetVeraltet, NOW.minus(Duration.ofDays(9)));
            // FRISCH: kein einziger Plan.

            // Altlast: je eine Zeile pro Woche ueber ein GANZES Jahr zurueck. Sie
            // kostet fast nichts einzufuegen, erzeugt aber die ~52 Timescale-
            // Chunks einer laufenden Anlage - und GENAU daran haengen die beiden
            // teuersten Abfragen: max(received_at) je Geraet und das EXISTS auf
            // schedule muessen je Chunk einen Index anfassen. Ohne sie maesse die
            // Kostenmessung unten eine Datenbank, die es in Produktion nicht gibt.
            altlast(c, geraetGesund, geraetVeraltet);

            // Preise: DE-LU luekenlos ueber den ganzen Horizont, AT gar keine.
            try (PreparedStatement ps = c.prepareStatement(
                    "INSERT INTO day_ahead_prices (bidding_zone, resolution, ts, price_eur_mwh,"
                            + " source) VALUES ('DE-LU', 'PT15M', ?, ?, 'test')")) {
                Instant slot = FleetMetrics.floorToSlot(NOW);
                for (int i = 0; i < 120; i++) {
                    ps.setTimestamp(1, Timestamp.from(slot.plus(
                            FleetMetrics.SLOT.multipliedBy(i))));
                    ps.setBigDecimal(2, new java.math.BigDecimal("42.0"));
                    ps.addBatch();
                }
                ps.executeBatch();
            }
            try (Statement s = c.createStatement()) {
                s.execute("ANALYZE");
            }
        }
    }

    private static void exec(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            ps.execute();
        }
    }

    private static void site(Connection c, UUID id, String name, String zone) throws Exception {
        exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, ?)",
                id, TENANT, name, zone);
    }

    private static void device(Connection c, UUID id, UUID site, String ref) throws Exception {
        exec(c, "INSERT INTO device (id, tenant_id, site_id, external_ref, status)"
                + " VALUES (?, ?, ?, ?, 'claimed')", id, TENANT, site, ref);
    }

    /** 60 Tage 15-Minuten-Telemetrie, endend bei {@code letzteAnkunft}. */
    private static void telemetry(Connection c, UUID device, UUID site, Instant letzteAnkunft)
            throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO telemetry (time, tenant_id, site_id, device_id, received_at,"
                        + " power_kw) VALUES (?, ?, ?, ?, ?, 1.0)")) {
            int n = TAGE * 96;
            for (int i = 0; i < n; i++) {
                Instant t = letzteAnkunft.minus(FleetMetrics.SLOT.multipliedBy(n - 1 - i));
                ps.setTimestamp(1, Timestamp.from(t));
                ps.setObject(2, TENANT);
                ps.setObject(3, site);
                ps.setObject(4, device);
                ps.setTimestamp(5, Timestamp.from(t));
                ps.addBatch();
                if (i % 5000 == 0) {
                    ps.executeBatch();
                }
            }
            ps.executeBatch();
        }
    }

    /**
     * 60 Tage Optimierer-Laeufe im Stundentakt mit je 24 Slots, endend bei
     * {@code letzterLauf} - so liegen die Laeufe ueber viele Chunks verteilt.
     */
    private static void schedule(Connection c, UUID site, UUID device, Instant letzterLauf)
            throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id,"
                        + " generated_at, battery_kw) VALUES (?, ?, ?, ?, ?, ?, 0.0)")) {
            int laeufe = TAGE * 24;
            for (int r = 0; r < laeufe; r++) {
                Instant generatedAt = letzterLauf.minus(Duration.ofHours(laeufe - 1L - r));
                UUID planId = UUID.randomUUID();
                for (int slot = 0; slot < 24; slot++) {
                    ps.setTimestamp(1, Timestamp.from(
                            generatedAt.plus(FleetMetrics.SLOT.multipliedBy(slot))));
                    ps.setObject(2, TENANT);
                    ps.setObject(3, site);
                    ps.setObject(4, device);
                    ps.setObject(5, planId);
                    ps.setTimestamp(6, Timestamp.from(generatedAt));
                    ps.addBatch();
                }
                if (r % 200 == 0) {
                    ps.executeBatch();
                }
            }
            ps.executeBatch();
        }
    }

    /**
     * Ein Jahr Chunk-Historie zum Kleinstpreis: je eine Telemetrie- und eine
     * Plan-Zeile pro Woche, von einem Jahr vor {@link #NOW} bis kurz vor den
     * dichten Teil. Die Werte sind bewusst so ALT, dass sie an keiner
     * Erwartung dieses Tests etwas ändern (der jüngste Lauf bleibt der dichte),
     * aber die Chunk-Anzahl auf Produktionsmass bringen.
     */
    private static void altlast(Connection c, UUID... geraete) throws Exception {
        UUID[] sites = {GESUND, VERALTET};
        try (PreparedStatement t = c.prepareStatement(
                "INSERT INTO telemetry (time, tenant_id, site_id, device_id, received_at,"
                        + " power_kw) VALUES (?, ?, ?, ?, ?, 1.0)");
                PreparedStatement s = c.prepareStatement(
                        "INSERT INTO schedule (time, tenant_id, site_id, device_id, plan_id,"
                                + " generated_at, battery_kw) VALUES (?, ?, ?, ?, ?, ?, 0.0)")) {
            for (int woche = 0; woche < 52; woche++) {
                Instant when = NOW.minus(Duration.ofDays(365L - woche * 7L));
                // Strikt AELTER als der dichte Teil: dessen Raster liegt auf
                // derselben Sekunde, eine Ueberschneidung liefe in das
                // (device, time)-Unique der Telemetrie.
                if (when.isAfter(NOW.minus(Duration.ofDays(TAGE + 5L)))) {
                    break;
                }
                for (int i = 0; i < geraete.length; i++) {
                    t.setTimestamp(1, Timestamp.from(when));
                    t.setObject(2, TENANT);
                    t.setObject(3, sites[i]);
                    t.setObject(4, geraete[i]);
                    t.setTimestamp(5, Timestamp.from(when));
                    t.addBatch();

                    s.setTimestamp(1, Timestamp.from(when));
                    s.setObject(2, TENANT);
                    s.setObject(3, sites[i]);
                    s.setObject(4, geraete[i]);
                    s.setObject(5, UUID.randomUUID());
                    s.setTimestamp(6, Timestamp.from(when));
                    s.addBatch();
                }
            }
            t.executeBatch();
            s.executeBatch();
        }
    }

    private static FleetMetricsRepository repo() {
        return new FleetMetricsRepository(new JdbcTemplate(adminRole()));
    }

    private static String scrape() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new FleetMetricsCollector(repo(), registry, Clock.fixed(NOW, ZoneOffset.UTC)).collect();
        return registry.scrape();
    }

    private static String line(String scrape, String prefix) {
        return scrape.lines().filter(l -> l.startsWith(prefix)).findFirst().orElse(null);
    }

    @Test
    void theRealQueriesProduceTheHandCheckedNumbers() {
        String scrape = scrape();

        // GESUND: Lauf vor 30 min, Messung vor 2 min - beide Alter exakt.
        assertThat(line(scrape, FleetMetricsCollector.PLAN_AGE + "{site=\"" + GESUND
                + "\",tenant=\"" + TENANT + "\"}")).endsWith(" 1800.0");
        assertThat(line(scrape, FleetMetricsCollector.TELEMETRY_AGE + "{site=\"" + GESUND
                + "\",tenant=\"" + TENANT + "\"}")).endsWith(" 120.0");
        assertThat(line(scrape, FleetMetricsCollector.PLAN_STATE + "{site=\"" + GESUND
                + "\",state=\"known\",tenant=\"" + TENANT + "\"}")).endsWith(" 1.0");

        assertThat(line(scrape, FleetMetricsCollector.SITES + " ")).endsWith(" 3.0");
    }

    @Test
    void aPlanNineDaysOldFallsOutOfTheWindowButIsNotMistakenForNever() {
        String scrape = scrape();

        // Kein Alter - das 7-Tage-Fenster kann keines mehr beziffern ...
        assertThat(scrape).doesNotContain(
                FleetMetricsCollector.PLAN_AGE + "{site=\"" + VERALTET + "\"");
        // ... aber die DB weiss, dass es Laeufe GAB: der EXISTS-Pfad ohne Fenster.
        assertThat(line(scrape, FleetMetricsCollector.PLAN_STATE + "{site=\"" + VERALTET
                + "\",state=\"older_than_window\",tenant=\"" + TENANT + "\"}")).endsWith(" 1.0");
        assertThat(line(scrape, FleetMetricsCollector.PLAN_STATE + "{site=\"" + VERALTET
                + "\",state=\"never\",tenant=\"" + TENANT + "\"}")).endsWith(" 0.0");

        // Die Telemetrie derselben Anlage ist bekannt und 9 h alt.
        assertThat(line(scrape, FleetMetricsCollector.TELEMETRY_AGE + "{site=\"" + VERALTET
                + "\",tenant=\"" + TENANT + "\"}")).endsWith(" 32400.0");
    }

    @Test
    void aSiteWithoutAnyPlanOrDeviceReportsNeverAndNoAgeAtAll() {
        String scrape = scrape();

        assertThat(scrape).doesNotContain(
                FleetMetricsCollector.PLAN_AGE + "{site=\"" + FRISCH + "\"");
        assertThat(scrape).doesNotContain(
                FleetMetricsCollector.TELEMETRY_AGE + "{site=\"" + FRISCH + "\"");
        assertThat(line(scrape, FleetMetricsCollector.PLAN_STATE + "{site=\"" + FRISCH
                + "\",state=\"never\",tenant=\"" + TENANT + "\"}")).endsWith(" 1.0");
        assertThat(line(scrape, FleetMetricsCollector.TELEMETRY_STATE + "{site=\"" + FRISCH
                + "\",state=\"never\",tenant=\"" + TENANT + "\"}")).endsWith(" 1.0");
    }

    @Test
    void theUnpricedZoneIsReportedAsZeroAndNotSimplyOmitted() {
        String scrape = scrape();

        // Die Zonen kommen aus der Flotte, nicht aus der Preistabelle - sonst
        // fehlte genau die Zeile, wegen der es diese Metrik gibt.
        assertThat(line(scrape, FleetMetricsCollector.PRICED_SLOTS + "{zone=\"AT\"}"))
                .endsWith(" 0.0");
        // DE-LU ist luekenlos gesaet und saettigt am Horizont.
        assertThat(line(scrape, FleetMetricsCollector.PRICED_SLOTS + "{zone=\"DE-LU\"}"))
                .endsWith(" 96.0");
    }

    @Test
    void aGapInThePricesTruncatesTheCoverageAgainstTheRealTable() {
        // Der Vorfall in seiner heimtueckischen Form: es LIEGEN Preise vor, nur
        // nicht zusammenhaengend ab jetzt. Der Optimierer bricht an der Luecke ab.
        Instant luecke = FleetMetrics.floorToSlot(NOW).plus(FleetMetrics.SLOT.multipliedBy(5));
        JdbcTemplate jdbc = new JdbcTemplate(superuser());
        jdbc.update("DELETE FROM day_ahead_prices WHERE bidding_zone = 'DE-LU' AND ts = ?",
                Timestamp.from(luecke));
        try {
            assertThat(line(scrape(), FleetMetricsCollector.PRICED_SLOTS + "{zone=\"DE-LU\"}"))
                    .endsWith(" 5.0");
        } finally {
            jdbc.update("INSERT INTO day_ahead_prices (bidding_zone, resolution, ts,"
                    + " price_eur_mwh, source) VALUES ('DE-LU', 'PT15M', ?, 42.0, 'test')",
                    Timestamp.from(luecke));
        }
    }

    @Test
    void theCollectorReadsThroughTheBypassrlsRoleBecauseItHasNoTenantContext() {
        // Ohne Mandanten-Kontext ist der mandantenbezogene Pfad per RLS-Grundregel
        // LEER. Genau deshalb haengt der Sammler an voltpilot_admin - dieser Test
        // belegt beide Haelften, damit niemand ihn "der Sauberkeit halber"
        // auf die @Primary-Datenquelle umhaengt und die Metriken still verstummen.
        PGSimpleDataSource appRole = new PGSimpleDataSource();
        appRole.setUrl(POSTGRES.getJdbcUrl());
        appRole.setUser("voltpilot_app");
        appRole.setPassword("pw_app");

        assertThat(new FleetMetricsRepository(new JdbcTemplate(appRole)).sites())
                .as("ohne app.tenant_id sieht die Kundenrolle nichts")
                .isEmpty();
        assertThat(repo().sites())
                .as("die Admin-Rolle sieht die ganze Flotte")
                .hasSize(3);
    }

    /**
     * Die Kostenmessung, die die 60-Sekunden-Taktvorgabe belegt.
     *
     * <p>Gesät sind {@value #TAGE} Tage 15-Minuten-Telemetrie je Gerät und
     * stündliche Optimierer-Läufe je Anlage - über mehrere Timescale-Chunks
     * hinweg, denn genau daran hängen die beiden potenziell teuren Abfragen
     * ({@code max(received_at)} je Gerät und das {@code EXISTS} auf
     * {@code schedule} müssen je Chunk einen Index anfassen).
     *
     * <p>Die Schranke ist bewusst grosszügig: sie soll eine
     * Grössenordnungs-Verschlechterung fangen (etwa ein verlorener Index oder
     * ein fensterloses Aggregat), nicht die Laufzeit eines CI-Läufers pinnen.
     */
    @Test
    void aCollectRunCostsLittleEnoughToRunEveryMinute() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        FleetMetricsCollector collector =
                new FleetMetricsCollector(repo(), registry, Clock.fixed(NOW, ZoneOffset.UTC));

        collector.collect(); // aufwaermen (Plan-Cache, Verbindungsaufbau)
        List<Long> millis = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            collector.collect();
            millis.add(collector.lastDuration().toMillis());
        }
        millis.sort(Long::compare);
        long median = millis.get(millis.size() / 2);
        System.out.println("[FleetMetrics] Sammel-Lauf ueber " + rows("telemetry")
                + " Telemetrie- und " + rows("schedule") + " Plan-Zeilen in "
                + chunks() + " Chunks: " + millis + " ms (Median " + median + " ms)");

        assertThat(median)
                .as("ein Sammel-Lauf muss weit unter dem 60-s-Takt bleiben")
                .isLessThan(2000L);
    }

    /** Die Zahl, an der die beiden teuren Abfragen wirklich haengen. */
    private static long chunks() {
        try (Connection c = superuser().getConnection();
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(
                        "SELECT count(*) FROM timescaledb_information.chunks"
                                + " WHERE hypertable_name IN ('telemetry', 'schedule')")) {
            rs.next();
            return rs.getLong(1);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static long rows(String table) {
        try (Connection c = superuser().getConnection();
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SELECT count(*) FROM " + table)) {
            rs.next();
            return rs.getLong(1);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
