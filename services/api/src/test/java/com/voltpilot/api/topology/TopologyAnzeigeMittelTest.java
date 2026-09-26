package com.voltpilot.api.topology;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.topology.TopologyRepository.ChannelKey;
import com.voltpilot.api.topology.TopologyRepository.LiveValue;
import java.io.InputStream;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Paket K8 „Anzeige ehrlich" (B1): die Cockpit-Kreise stehen auf EINER
 * Zeitbasis - dem 30-s-Mittel je Leistungskanal - und ihre Bilanz stimmt.
 *
 * <p>Belegt an den ROHDATEN des Falls Herzogau 24.09.2026 17:08:00 (Box-Ring,
 * {@code topology/herzogau-2026-09-24-1708.json}): die Probe, die das
 * Bildschirmfoto zeigte, trug PV 34,3 (Fronius, frisch) neben Netz 8,5 Bezug
 * und Laden 16,6 (Deye, ~15 s alt) - daraus „Haus 26,2 kW". Die Proben werden
 * so in {@code telemetry_v2} geschrieben, wie der timescale-writer sie
 * auffächert ({@code ComposedEntityFanout}: battery-hybrid pv_power_kw +
 * battery_power_kw = power_kw - load_kw + pv_power_kw, grid-meter power_kw,
 * house-load power_kw = load_kw; alle mit dem Proben-{@code time}).
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class TopologyAnzeigeMittelTest {

    private static final UUID TENANT = UUID.fromString("dddddddd-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("dddddddd-0000-0000-0000-0000000000a1");
    private static final UUID DEVICE = UUID.fromString("dddddddd-0000-0000-0000-0000000000d1");

    private static final String BATTERY = "dddddddd-0000-0000-0000-0000000000e1";
    private static final String GRID = "dddddddd-0000-0000-0000-0000000000e2";
    private static final String HOUSE = "dddddddd-0000-0000-0000-0000000000e3";

    private static final List<ChannelKey> KEYS = List.of(
            new ChannelKey(BATTERY, "pv_power_kw"),
            new ChannelKey(BATTERY, "battery_power_kw"),
            new ChannelKey(BATTERY, "soc_pct"),
            new ChannelKey(GRID, "power_kw"),
            new ChannelKey(HOUSE, "power_kw"));

    /** Der Zeitpunkt des Bildschirmfotos: die letzte Probe des Ausschnitts. */
    private static Instant foto;

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "pw_admin"))
                .load()
                .migrate();
        JsonNode samples;
        try (InputStream in = TopologyAnzeigeMittelTest.class
                .getResourceAsStream("/topology/herzogau-2026-09-24-1708.json")) {
            samples = new ObjectMapper().readTree(in).path("samples");
        }
        try (Connection c = superuser().getConnection()) {
            exec(c, "INSERT INTO tenant (id, name) VALUES (?, 'Herzogau-Rohdaten')", TENANT);
            exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone) "
                    + "VALUES (?, ?, 'Herzogau-like', 'DE-LU')", SITE, TENANT);
            exec(c, "INSERT INTO device (id, tenant_id, site_id, external_ref, kind) "
                    + "VALUES (?, ?, ?, 'ref-herzogau', 'inverter')", DEVICE, TENANT, SITE);
            for (JsonNode s : samples) {
                Instant t = Instant.ofEpochMilli(s.path("t").asLong());
                double pv = s.path("pv").asDouble();
                double grid = s.path("grid").asDouble();
                double load = s.path("load").asDouble();
                v2(c, BATTERY, "pv_power_kw", t, pv);
                v2(c, BATTERY, "battery_power_kw", t, grid - load + pv);
                v2(c, BATTERY, "soc_pct", t, s.path("soc").asDouble());
                v2(c, GRID, "power_kw", t, grid);
                v2(c, HOUSE, "power_kw", t, load);
                foto = t;
            }
        }
    }

    @Test
    void derLetzteWertIstDasBildschirmfoto() throws Exception {
        Map<String, LiveValue> v = read();
        // Die alte Anzeige, Ziffer für Ziffer: PV 34,3 · lädt 16,6 · Netz 8,5 Bezug · Haus 26,2.
        assertThat(v.get(BATTERY + "|pv_power_kw").latest()).isCloseTo(34.271, within(1e-9));
        assertThat(v.get(BATTERY + "|battery_power_kw").latest()).isCloseTo(16.58, within(1e-9));
        assertThat(v.get(GRID + "|power_kw").latest()).isCloseTo(8.505, within(1e-9));
        assertThat(v.get(HOUSE + "|power_kw").latest()).isCloseTo(26.196, within(1e-9));
    }

    @Test
    void dasDreissigSekundenMittelZeigtDieZahlenNieUndDieBilanzStimmt() throws Exception {
        Map<String, LiveValue> v = read();
        double pv = shown(v, BATTERY, "pv_power_kw");
        double batt = shown(v, BATTERY, "battery_power_kw");
        double grid = shown(v, GRID, "power_kw");
        double house = shown(v, HOUSE, "power_kw");

        // Die vier Kreise stimmen in sich: Haus = PV + Netz - Speicher, exakt.
        assertThat(pv + grid - batt).isCloseTo(house, within(1e-9));
        // 26,2 kW Haus und „8,5 Bezug bei 16,6 Laden" erscheinen nicht mehr.
        assertThat(house).isCloseTo(19.61, within(0.01));
        assertThat(grid).isCloseTo(4.51, within(0.01));
        assertThat(batt).isCloseTo(22.46, within(0.01));
        assertThat(pv).isCloseTo(37.56, within(0.01));
        // Der Ladestand ist keine Leistung: er bleibt der letzte Wert.
        assertThat(shown(v, BATTERY, "soc_pct", "%")).isEqualTo(35.0);
    }

    @Test
    void dasFensterHaengtAmNeuestenWertDesKanalsNichtAnDerWanduhr() throws Exception {
        // Gelesen wird fast zwei Jahre nach den Proben: ein an der Wanduhr verankertes Fenster
        // wäre leer. Jeder Kanal trägt seinen Wert und die Ankunft SEINER neuesten Probe - die
        // Gesundheit (5-min-Fenster) sagt dann „stale", nicht die Zahl.
        Map<String, LiveValue> v = read();
        assertThat(v).hasSize(KEYS.size());
        assertThat(v.get(HOUSE + "|power_kw").receivedAt()).isEqualTo(foto);
    }

    @Test
    void dieBoedenSitzenAufDerPartitionsspalteUndDieAnweisungBleibtFest() {
        assertThat(TopologyRepository.LIVE_VALUES).contains("t.time >= ?").contains("w.time >= ?");
        assertThat(TopologyRepository.LIVE_VALUES.chars().filter(ch -> ch == '?').count())
                .as("bind parameters, independent of the pair count")
                .isEqualTo(7);
        assertThat(TopologyRepository.DISPLAY_MEAN_WINDOW).isEqualTo(Duration.ofSeconds(30));
    }

    // ---- helpers ------------------------------------------------------------

    private static double shown(Map<String, LiveValue> v, String entity, String channel) {
        return shown(v, entity, channel, "kW");
    }

    private static double shown(Map<String, LiveValue> v, String entity, String channel,
            String unit) {
        return TopologyService.displayValue(v.get(entity + "|" + channel), channel, unit);
    }

    private static Map<String, LiveValue> read() throws Exception {
        Map<String, LiveValue> m = new HashMap<>();
        try (SingleConnectionDataSource ds = appRole()) {
            for (LiveValue lv : new TopologyRepository(new JdbcTemplate(ds))
                    .liveValues(SITE, KEYS, foto.minus(TopologyRepository.LATEST_VALUE_LOOKBACK))) {
                m.put(lv.entityId() + "|" + lv.channel(), lv);
            }
        }
        return m;
    }

    private static DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

    /** ONE connection as the RLS-scoped app role with the session tenant set. */
    private static SingleConnectionDataSource appRole() throws Exception {
        SingleConnectionDataSource ds = new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_app", "pw_app", true);
        try (PreparedStatement ps = ds.getConnection()
                .prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, TENANT.toString());
            ps.execute();
        }
        return ds;
    }

    private static void exec(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            ps.execute();
        }
    }

    private static void v2(Connection c, String entity, String channel, Instant time, double value)
            throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                        + "entity_id, channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")) {
            ps.setTimestamp(1, Timestamp.from(time));
            ps.setTimestamp(2, Timestamp.from(time));
            ps.setObject(3, TENANT);
            ps.setObject(4, SITE);
            ps.setObject(5, DEVICE);
            ps.setString(6, entity);
            ps.setString(7, channel);
            ps.setDouble(8, value);
            ps.execute();
        }
    }
}
