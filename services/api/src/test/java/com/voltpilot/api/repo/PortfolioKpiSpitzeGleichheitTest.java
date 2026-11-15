package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.TestDatenbank;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * H5 (vp-perf3-server): {@link PortfolioKpiRepository#importSpitzen} greift je Anlage über den Index
 * {@code idx_telemetry_rollup_15m_netzbezug_spitze} die höchste Viertelstunde, statt alle Viertelstunden des
 * Fensters zu sortieren ({@code DISTINCT ON}).
 *
 * <p>Dieser Test hält die ALTE Abfrage wörtlich als Orakel gegen eine echte TimescaleDB unter der RLS-Rolle der App
 * und verlangt für jedes Fenster dieselbe Map (Anlage, kW, Zeitpunkt). Die Welt hat, was die beiden Formen
 * unterscheiden könnte: mehrere Chunks (30 Tage je Chunk, Fenster über die Chunk-Grenzen), einen Gleichstand der
 * Spitze an zwei Zeitpunkten (die frühere gewinnt), die höchste Viertelstunde einer Anlage knapp vor und knapp
 * hinter dem Fenster, NULL- und Null-Netzbezug, eine reine Einspeiser-Anlage (fehlt), eine Anlage ohne Zeilen
 * und den fremden Mandanten (Zaun).
 *
 * <p>Läuft nur mit Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class PortfolioKpiSpitzeGleichheitTest {

    private static final UUID TENANT_A = UUID.fromString("aaaaaaaa-0000-0000-0000-00000000000a");
    private static final UUID TENANT_B = UUID.fromString("bbbbbbbb-0000-0000-0000-00000000000b");
    /** Gewöhnliche Anlage mit Tagesgang. */
    private static final UUID A1 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a1");
    /** Gleichstand: dieselbe Spitze an zwei Zeitpunkten in verschiedenen Chunks. */
    private static final UUID A2 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a2");
    /** Reine Einspeiser-Anlage: Netzbezug nur 0 oder NULL. */
    private static final UUID A3 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a3");
    /** Ohne eine Zeile. */
    private static final UUID A4 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a4");
    /** Die höchste Viertelstunde liegt knapp vor bzw. hinter den Fenstern. */
    private static final UUID A5 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a5");
    private static final UUID B1 = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000b1");

    /** 1. Januar 2026 00:00 Europe/Berlin. */
    private static final Instant JAN = Instant.parse("2025-12-31T23:00:00Z");
    private static final int TAGE = 100;
    private static final Instant TIE_1 = Instant.parse("2026-01-20T11:15:00Z");
    private static final Instant TIE_2 = Instant.parse("2026-03-05T09:30:00Z");
    private static final Instant MAERZ = Instant.parse("2026-02-28T23:00:00Z");

    private static final String ALT = "SELECT DISTINCT ON (r.site_id) r.site_id, r.bucket, r.grid_import_kwh * 4.0 AS peak "
            + "FROM telemetry_rollup_15m r JOIN site s ON s.id = r.site_id "
            + "WHERE r.bucket >= ? AND r.bucket < ? AND r.grid_import_kwh > 0 "
            + "ORDER BY r.site_id, r.grid_import_kwh DESC, r.bucket";

    @Container
    static final TestDatenbank POSTGRES = new TestDatenbank();

    @BeforeAll
    static void migrateAndSeed() throws Exception {
        POSTGRES.migriere(Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "pw_app",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "pw_admin")));
        PGSimpleDataSource su = new PGSimpleDataSource();
        su.setUrl(POSTGRES.getJdbcUrl());
        su.setUser(POSTGRES.getUsername());
        su.setPassword(POSTGRES.getPassword());
        try (Connection c = su.getConnection()) {
            exec(c, "INSERT INTO tenant (id, name) VALUES (?, 'A'), (?, 'B')", TENANT_A, TENANT_B);
            for (UUID s : List.of(A1, A2, A3, A4, A5, B1)) {
                exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')",
                        s, s.equals(B1) ? TENANT_B : TENANT_A, "Anlage " + s);
            }
            // Netzbezug mit Tagesgang und langsamem Trend, sechs Stellen wie numeric(14,6); jede 11. Viertelstunde NULL.
            for (UUID s : List.of(A1, A2, A3, A5, B1)) {
                exec(c, "INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, n_samples, grid_import_kwh) "
                        + "SELECT t, ?, ?, 90, CASE WHEN n % 11 = 0 THEN NULL ELSE round((GREATEST(0, 0.9 - "
                        + "sin(extract(epoch FROM t) / 86400.0 * 2 * pi())) * (1 + (n % 97) / 400.0))::numeric, 6) END "
                        + "FROM generate_series(?::timestamptz, ?::timestamptz - interval '15 minutes', "
                        + "interval '15 minutes') WITH ORDINALITY g(t, n)",
                        s.equals(B1) ? TENANT_B : TENANT_A, s, Timestamp.from(JAN),
                        Timestamp.from(JAN.plusSeconds(TAGE * 86400L)));
            }
            // A2: dieselbe Spitze an zwei Zeitpunkten in verschiedenen Chunks, alles andere darunter.
            exec(c, "UPDATE telemetry_rollup_15m SET grid_import_kwh = LEAST(grid_import_kwh, 8.999999) WHERE site_id = ?", A2);
            exec(c, "UPDATE telemetry_rollup_15m SET grid_import_kwh = 9.000000 WHERE site_id = ? AND bucket IN (?, ?)",
                    A2, Timestamp.from(TIE_1), Timestamp.from(TIE_2));
            // A3: reine Einspeiser-Anlage.
            exec(c, "UPDATE telemetry_rollup_15m SET grid_import_kwh = CASE WHEN extract(epoch FROM bucket)::bigint "
                    + "% 4500 = 0 THEN NULL ELSE 0 END WHERE site_id = ?", A3);
            // A5: die höchste Viertelstunde je knapp vor dem März-Fenster und knapp hinter seinem kürzeren Ende.
            exec(c, "UPDATE telemetry_rollup_15m SET grid_import_kwh = 12.500000 WHERE site_id = ? AND bucket IN (?, ?)",
                    A5, Timestamp.from(MAERZ.minusSeconds(900)), Timestamp.from(MAERZ.plusSeconds(31L * 86400 - 3600)));
            exec(c, "UPDATE telemetry_rollup_15m SET grid_import_kwh = 12.400000 WHERE site_id = ? AND bucket = ?",
                    A5, Timestamp.from(MAERZ.plusSeconds(31L * 86400 - 3600 - 900)));
            exec(c, "ANALYZE telemetry_rollup_15m");
        }
    }

    @Test
    void jedeAnlageBekommtDieselbeSpitzeWieMitDistinctOn() throws Exception {
        JdbcTemplate app = new JdbcTemplate(appRole(TENANT_A));
        PortfolioKpiRepository repo = new PortfolioKpiRepository(app);
        List<Instant[]> fenster = List.of(
                new Instant[] {JAN, JAN.plusSeconds(TAGE * 86400L)},              // ganzes „Jahr“ bis heute
                new Instant[] {MAERZ, MAERZ.plusSeconds(31L * 86400)},             // ein Monat
                new Instant[] {MAERZ, MAERZ.plusSeconds(31L * 86400 - 3600)},      // endet vor A5s späterer Spitze
                new Instant[] {JAN.plusSeconds(25L * 86400), JAN.plusSeconds(65L * 86400)}, // über zwei Chunk-Grenzen
                new Instant[] {TIE_1.plusSeconds(900), JAN.plusSeconds(TAGE * 86400L)}, // A2: nur der zweite Gleichstand
                new Instant[] {JAN.plusSeconds(TAGE * 86400L), JAN.plusSeconds((TAGE + 5) * 86400L)}); // leer
        int verglichen = 0;
        for (Instant[] f : fenster) {
            Map<UUID, PortfolioKpiRepository.Spitze> neu = repo.importSpitzen(f[0], f[1]);
            assertThat(neu).as("Fenster %s bis %s", f[0], f[1]).isEqualTo(alt(app, f[0], f[1]));
            verglichen += neu.size();
        }
        assertThat(verglichen).as("die Probe trägt Spitzen").isGreaterThan(10);

        Map<UUID, PortfolioKpiRepository.Spitze> jahr = repo.importSpitzen(JAN, JAN.plusSeconds(TAGE * 86400L));
        assertThat(jahr).containsOnlyKeys(A1, A2, A5); // A3 Einspeiser, A4 ohne Zeilen, B1 fremd
        assertThat(jahr.get(A2)).isEqualTo(new PortfolioKpiRepository.Spitze(new BigDecimal("36.0000000"), TIE_1));
        assertThat(repo.importSpitzen(TIE_1.plusSeconds(900), JAN.plusSeconds(TAGE * 86400L)).get(A2).zeitpunkt())
                .isEqualTo(TIE_2);
        assertThat(repo.importSpitzen(MAERZ, MAERZ.plusSeconds(31L * 86400 - 3600)).get(A5).kw())
                .isEqualByComparingTo("49.6");

        // Der Index, auf den die Abfrage zielt, steht auf der Hypertable (je Chunk).
        Integer indizes = new JdbcTemplate(superuser()).queryForObject(
                "SELECT count(*) FROM pg_indexes WHERE indexname LIKE '%netzbezug_spitze%'", Integer.class);
        assertThat(indizes).as("Index auf der Hypertable und ihren Chunks").isGreaterThan(1);
    }

    private static Map<UUID, PortfolioKpiRepository.Spitze> alt(JdbcTemplate jdbc, Instant von, Instant bis) {
        Map<UUID, PortfolioKpiRepository.Spitze> out = new HashMap<>();
        jdbc.query(ALT, rs -> {
            BigDecimal peak = rs.getBigDecimal("peak");
            if (peak != null) {
                Timestamp ts = rs.getTimestamp("bucket");
                out.put(rs.getObject("site_id", UUID.class),
                        new PortfolioKpiRepository.Spitze(peak, ts != null ? ts.toInstant() : null));
            }
        }, Timestamp.from(von), Timestamp.from(bis));
        return out;
    }

    private static SingleConnectionDataSource appRole(UUID tenant) throws Exception {
        SingleConnectionDataSource ds = new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_app", "pw_app", true);
        try (PreparedStatement ps = ds.getConnection()
                .prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, tenant.toString());
            ps.execute();
        }
        return ds;
    }

    private static SingleConnectionDataSource superuser() {
        return new SingleConnectionDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword(),
                true);
    }

    private static void exec(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            ps.execute();
        }
    }
}
