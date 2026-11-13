package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * Der Monatsanker des Vergleichsspeichers ({@code EarningsRepository.monthAnchorSocPct}) wurde in
 * vp-perf-kundenpfade-api umgeformt: statt {@code SELECT DISTINCT site_id, Monat} über alle Eimer des
 * Fensters treibt {@code site} die Anlagen, der erste Eimer im Fenster begrenzt die Monatsreihe, und je
 * Monat prüft eine Index-Probe, ob die Anlage darin Eimer hat. Dieser Test hält die alte Form WÖRTLICH als
 * Orakel gegen eine echte TimescaleDB unter der RLS-Rolle der App und verlangt Zeile für Zeile dieselben
 * (Anlage, Monat, Anker) - über Berliner Monatsgrenzen (der Eimer 00:00 Ortszeit am Monatsersten), Lücken
 * mitten im Fenster (ein Monat ohne Eimer erscheint in keiner Form), einen Anker in der 7-Tage-Rückschau,
 * eine Anlage ohne Ladestand, ein Fenster ab EPOCH ({@code range=all}), ein leeres Fenster, ein Fenster aus
 * einem einzigen Eimer, den Weg mit einer Anlage und den Mandantenzaun (die Anlage des anderen Mandanten
 * erscheint in keiner Form).
 *
 * <p>Nicht Gegenstand: ein Standort-Zugriff ({@code app.zugriff = standorte}). Dort hält die neue Form
 * zusätzlich die {@code site}-Policy ein und lässt Anlagen außerhalb des Zugriffs weg; der Walk liest seine
 * Anlagen ohnehin über {@code JOIN site} und hat einen solchen Anker nie gelesen.
 *
 * <p>Läuft nur mit Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class MonthAnchorRewriteEqualityTest {

    /** Die alte Form, wörtlich (Stand b3ed4c5ff), Bindungen: walkFrom, to [, site]. */
    private static final String ALT =
            "SELECT m.site_id, m.month_start,"
                    + " (SELECT x.soc_last_pct FROM telemetry_rollup_15m x"
                    + "   WHERE x.site_id = m.site_id AND x.soc_last_pct IS NOT NULL"
                    + "     AND x.bucket >= m.month_start - interval '7 days'"
                    + "     AND x.bucket < m.month_start"
                    + "   ORDER BY x.bucket DESC LIMIT 1) AS soc_last_pct "
                    + "FROM (SELECT DISTINCT r.site_id,"
                    + "   date_trunc('month', r.bucket AT TIME ZONE 'Europe/Berlin')"
                    + "     AT TIME ZONE 'Europe/Berlin' AS month_start"
                    + "   FROM telemetry_rollup_15m r"
                    + "   WHERE r.bucket >= ? AND r.bucket < ?";

    private static final UUID TENANT_A = UUID.fromString("aaaaaaaa-0000-0000-0000-00000000000a");
    private static final UUID TENANT_B = UUID.fromString("bbbbbbbb-0000-0000-0000-00000000000b");
    /** Eimer über drei Monate mit Lücke im Oktober, Ladestand überall. */
    private static final UUID A1 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a1");
    /** Nur November, Ladestand nie gemessen. */
    private static final UUID A2 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a2");
    /** Nur Eimer in der Rückschau vor dem Fenster. */
    private static final UUID A3 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a3");
    /** Ohne jeden Eimer. */
    private static final UUID A4 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a4");
    private static final UUID B1 = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000b1");

    /** 1. November 2026 00:00 Europe/Berlin (Winterzeit, UTC+1). */
    private static final Instant NOV = Instant.parse("2026-10-31T23:00:00Z");
    /** 1. Oktober 2026 00:00 Europe/Berlin (Sommerzeit, UTC+2). */
    private static final Instant OKT = Instant.parse("2026-09-30T22:00:00Z");
    /** 1. September 2026 00:00 Europe/Berlin. */
    private static final Instant SEP = Instant.parse("2026-08-31T22:00:00Z");
    /** 1. Dezember 2026 00:00 Europe/Berlin. */
    private static final Instant DEZ = Instant.parse("2026-11-30T23:00:00Z");

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
        PGSimpleDataSource su = new PGSimpleDataSource();
        su.setUrl(POSTGRES.getJdbcUrl());
        su.setUser(POSTGRES.getUsername());
        su.setPassword(POSTGRES.getPassword());
        try (Connection c = su.getConnection()) {
            exec(c, "INSERT INTO tenant (id, name) VALUES (?, 'A'), (?, 'B')", TENANT_A, TENANT_B);
            for (UUID s : List.of(A1, A2, A3, A4)) {
                exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')",
                        s, TENANT_A, "Anlage " + s);
            }
            exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Fremd', 'DE-LU')",
                    B1, TENANT_B);
            // A1: August (Rückschau des Septemberankers), September, KEIN Oktober, November - je Monat
            // auch der Eimer genau am Monatsersten 00:00 Ortszeit und der letzte vor dem Monatswechsel.
            eimer(c, A1, TENANT_A, SEP.minusSeconds(3 * 86400), 41.0);
            eimer(c, A1, TENANT_A, SEP.minusSeconds(900), 42.0);
            eimer(c, A1, TENANT_A, SEP, 43.0);
            eimer(c, A1, TENANT_A, SEP.plusSeconds(10 * 86400), 44.0);
            eimer(c, A1, TENANT_A, OKT.minusSeconds(900), 45.0);
            eimer(c, A1, TENANT_A, NOV, 46.0);
            eimer(c, A1, TENANT_A, NOV.plusSeconds(12 * 86400), 47.0);
            eimer(c, A1, TENANT_A, DEZ.minusSeconds(900), 48.0);
            // A2: nur November, nie ein Ladestand.
            eimer(c, A2, TENANT_A, NOV.plusSeconds(86400), null);
            eimer(c, A2, TENANT_A, NOV.plusSeconds(5 * 86400), null);
            // A3: nur Eimer in der Rückschau vor dem Oktober (Ende September).
            eimer(c, A3, TENANT_A, OKT.minusSeconds(2 * 86400), 55.0);
            // B1: anderer Mandant, in jedem Monat - darf nie erscheinen.
            for (Instant t : List.of(SEP, OKT, NOV, NOV.plusSeconds(86400))) {
                eimer(c, B1, TENANT_B, t, 99.0);
            }
        }
    }

    @Test
    void neueFormLiefertDieselbenAnkerWieDieAlte() throws Exception {
        JdbcTemplate jdbc = new JdbcTemplate(appRole(TENANT_A));
        List<Instant[]> fenster = List.of(
                new Instant[] {SEP, DEZ},                                   // drei Monate, Lücke im Oktober
                new Instant[] {OKT, NOV.plusSeconds(13 * 86400)},          // der Walk des Cockpit-Tages
                new Instant[] {Instant.EPOCH, DEZ},                         // range=all
                new Instant[] {NOV, NOV.plusSeconds(900)},                  // genau ein Eimer am Monatsersten
                new Instant[] {OKT.minusSeconds(900), OKT},                 // nur der letzte Septembereimer
                new Instant[] {OKT, NOV},                                   // Monat ohne Eimer
                new Instant[] {NOV, NOV},                                   // leeres Fenster
                new Instant[] {SEP.plusSeconds(5 * 86400), DEZ.plusSeconds(86400)});
        int nichtLeer = 0;
        for (Instant[] f : fenster) {
            List<String> alt = zeilen(jdbc, ALT + ") m", new Object[] {ts(f[0]), ts(f[1])});
            List<String> neu = zeilen(jdbc, EarningsRepository.monthAnchorSql(null),
                    EarningsRepository.monthAnchorArgs(f[0], f[1], null));
            assertThat(neu).as("Fenster %s .. %s", f[0], f[1]).isEqualTo(alt);
            if (!alt.isEmpty()) {
                nichtLeer++;
            }
            for (UUID s : List.of(A1, A2, A3, A4, B1)) {
                List<String> altS = zeilen(jdbc, ALT + " AND r.site_id = ?) m",
                        new Object[] {ts(f[0]), ts(f[1]), s});
                List<String> neuS = zeilen(jdbc, EarningsRepository.monthAnchorSql(s),
                        EarningsRepository.monthAnchorArgs(f[0], f[1], s));
                assertThat(neuS).as("Anlage %s, Fenster %s .. %s", s, f[0], f[1]).isEqualTo(altS);
            }
        }
        assertThat(nichtLeer).isGreaterThanOrEqualTo(5);
        // Stichproben: die Lücke im Oktober bleibt eine Lücke, der Septemberanker kommt aus der Rückschau
        // (der jüngste von zwei Eimern davor), der Novemberanker fehlt (kein Eimer in der Woche davor).
        List<String> dreiMonate = zeilen(jdbc, EarningsRepository.monthAnchorSql(A1),
                EarningsRepository.monthAnchorArgs(SEP, DEZ, A1));
        assertThat(dreiMonate).containsExactly(
                A1 + "|" + SEP + "|42.0",
                A1 + "|" + NOV + "|null");
        // Der Zaun: B1 ist auch über seine eigene Kennung unsichtbar.
        assertThat(zeilen(jdbc, EarningsRepository.monthAnchorSql(B1),
                EarningsRepository.monthAnchorArgs(Instant.EPOCH, DEZ, B1))).isEmpty();
    }

    private static List<String> zeilen(JdbcTemplate jdbc, String sql, Object[] args) {
        List<String> out = new ArrayList<>();
        jdbc.query(sql, rs -> {
            java.math.BigDecimal soc = rs.getBigDecimal("soc_last_pct");
            out.add(rs.getObject("site_id", UUID.class) + "|" + rs.getTimestamp("month_start").toInstant()
                    + "|" + (soc == null ? "null" : soc.setScale(1, java.math.RoundingMode.HALF_UP)));
        }, args);
        out.sort(null);
        return out;
    }

    private static Timestamp ts(Instant i) {
        return Timestamp.from(i);
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

    private static void eimer(Connection c, UUID site, UUID tenant, Instant bucket, Double soc) throws Exception {
        exec(c, "INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, soc_last_pct, n_samples) "
                + "VALUES (?, ?, ?, ?, 1)", ts(bucket), tenant, site, soc);
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
