package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.optimizer.OptimizerProperties;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSetMetaData;
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
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * B3 (vp-perf2-server): in den Zeilen-Abfragen der Erlöse ({@code speicherWalk}, {@code dailySaved},
 * {@code arbitrageSplit}, {@code bucketed}) steht die Preis-Bedingung von {@code COVERED} nicht mehr im WHERE,
 * sondern im FILTER/HAVING der Summen bzw. im Leser. Im WHERE machte sie den {@code LEFT JOIN price_slot} zum
 * inneren Join, und der Planer begann bei der falsch geschätzten Preis-CTE (9 statt 5 392 Zeilen) und probte
 * je Preis-Slot in alle Rollup-Chunks.
 *
 * <p>Dieser Test hält die ALTE Form als Orakel gegen eine echte TimescaleDB unter der RLS-Rolle der App: jede
 * Abfrage, die das Repository für die Erlös-Wege stellt, wird mitgeschnitten und zusätzlich in der alten Form
 * gefahren - die neue Form mit der Preis-Bedingung zurück im WHERE und ohne FILTER/HAVING (die Umformung muss
 * jeweils genau einmal greifen, sonst ist die Abfrage abgedriftet). Verlangt wird Zeile für Zeile dasselbe, bei
 * den Zeilen-Lesern nach dem Überspringen der Zeilen ohne Preis. Die Welt hat, was die Umformung unterscheiden
 * könnte: eine Preislücke mitten im Tag (Kanäle da, kein Preis), Viertelstunden ohne Kanäle, PT60M neben PT15M,
 * zwei Gebotszonen, eine Direktvermarktungs-Anlage mit Marktwert, eine Anlage mit Netzladen, eine ohne Speicher
 * und den fremden Mandanten (Zaun).
 *
 * <p>Läuft nur mit Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class EarningsPreisBedingungGleichheitTest {

    private static final UUID TENANT_A = UUID.fromString("aaaaaaaa-0000-0000-0000-00000000000a");
    private static final UUID TENANT_B = UUID.fromString("bbbbbbbb-0000-0000-0000-00000000000b");
    /** DE-LU, Speicher, dynamischer Tarif, Netzladen erlaubt. */
    private static final UUID A1 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a1");
    /** DE-LU, Speicher, Direktvermarktung mit anzulegendem Wert. */
    private static final UUID A2 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a2");
    /** AT (zweite Gebotszone, nur PT60M-Preise), Speicher. */
    private static final UUID A3 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a3");
    /** DE-LU, ohne Speicher. */
    private static final UUID A4 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a4");
    private static final UUID B1 = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000b1");

    /** 1. November 2026 00:00 Europe/Berlin. */
    private static final Instant NOV = Instant.parse("2026-10-31T23:00:00Z");
    private static final int TAGE = 9;
    /** Die Preislücke: 3. November 10:00 bis 13:00 Berlin - Kanäle da, kein Preis in keiner Zone. */
    private static final Instant LUECKE_VON = Instant.parse("2026-11-03T09:00:00Z");
    private static final Instant LUECKE_BIS = Instant.parse("2026-11-03T12:00:00Z");

    private static final String PREIS = "p.price_eur_mwh IS NOT NULL";

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
            anlage(c, A1, TENANT_A, "DE-LU", "eigenverbrauch", null, "dynamisch", true, true);
            anlage(c, A2, TENANT_A, "DE-LU", "direktvermarktung", new BigDecimal("8.5"), "fest", false, true);
            anlage(c, A3, TENANT_A, "AT", "eigenverbrauch", null, "ohne", false, true);
            anlage(c, A4, TENANT_A, "DE-LU", "eigenverbrauch", null, "ohne", false, false);
            anlage(c, B1, TENANT_B, "DE-LU", "eigenverbrauch", null, "dynamisch", true, true);
            exec(c, "INSERT INTO monthly_market_value (technology, month, value_ct_kwh, provisional) "
                    + "VALUES ('solar', DATE '2026-11-01', 6.2, true) ON CONFLICT DO NOTHING");
            // Preise: DE-LU PT15M, dazu PT60M für dieselben Stunden (PT15M gewinnt); AT nur PT60M. Die Lücke hat keine.
            for (Instant t = NOV.minusSeconds(3600); t.isBefore(NOV.plusSeconds(TAGE * 86400L)); t = t.plusSeconds(900)) {
                if (!t.isBefore(LUECKE_VON) && t.isBefore(LUECKE_BIS)) {
                    continue;
                }
                double preis = 40 + 60 * Math.sin(t.getEpochSecond() / 86400.0 * 2 * Math.PI) - (t.getEpochSecond() % 7);
                exec(c, "INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                        + "VALUES (?, 'DE-LU', 'PT15M', ?, 'EUR', 'test')", ts(t), preis);
                if (t.getEpochSecond() % 3600 == 0) {
                    exec(c, "INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                            + "VALUES (?, 'DE-LU', 'PT60M', ?, 'EUR', 'test'), (?, 'AT', 'PT60M', ?, 'EUR', 'test')",
                            ts(t), preis + 1, ts(t), preis + 3);
                }
            }
            // Viertelstunden: je Anlage TAGE Tage; jede 13. ohne Lastkanal (nicht berechenbar).
            int n = 0;
            for (UUID s : List.of(A1, A2, A3, A4, B1)) {
                UUID ten = s.equals(B1) ? TENANT_B : TENANT_A;
                for (Instant t = NOV.minusSeconds(2 * 900); t.isBefore(NOV.plusSeconds(TAGE * 86400L)); t = t.plusSeconds(900)) {
                    double phase = Math.sin(t.getEpochSecond() / 86400.0 * 2 * Math.PI);
                    double pv = Math.max(0, phase) * 2.5;
                    double last = 0.8 + 0.3 * Math.cos(t.getEpochSecond() / 3600.0);
                    double laden = phase > 0.3 ? 0.6 : 0;
                    double entladen = phase < -0.2 ? 0.5 : 0;
                    double netz = last + laden - pv - entladen;
                    exec(c, "INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, n_samples, load_kwh, pv_kwh, "
                            + "grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, soc_last_pct) "
                            + "VALUES (?, ?, ?, 90, ?, ?, ?, ?, ?, ?, ?)",
                            ts(t), ten, s, ++n % 13 == 0 ? null : last, pv, Math.max(netz, 0), Math.max(-netz, 0),
                            laden, entladen, 50 + 40 * phase);
                }
            }
        }
    }

    @Test
    void ohnePreisBedingungImWhereLiefertJedeErloesAbfrageDieselbenZeilen() throws Exception {
        Aufnahme jdbc = new Aufnahme(appRole(TENANT_A));
        EarningsRepository repo = new EarningsRepository(jdbc,
                new OptimizerProperties(4.0, 0.3, null, null, true));
        Instant von = NOV.plusSeconds(86400);
        Instant bis = NOV.plusSeconds(TAGE * 86400L);
        repo.savedSpeicher(von, bis);
        repo.dailySavedPerSite(von, bis);
        repo.tagesbilderUndReihe(NOV.plusSeconds(2 * 86400L), NOV.plusSeconds(3 * 86400L), false, von);
        repo.arbitrageSplit(von, bis);
        for (EarningsRepository.Bucket b : EarningsRepository.Bucket.values()) {
            repo.bucketed(von, bis, b);
        }
        for (UUID s : List.of(A1, A2, A3, A4, B1)) {
            repo.savedSpeicherForSite(s, von, bis);
            repo.arbitrageSplitForSite(s, von, bis);
            repo.bucketedForSite(s, von, bis, EarningsRepository.Bucket.DAY);
        }

        JdbcTemplate roh = new JdbcTemplate(appRole(TENANT_A));
        int zeilenLeser = 0;
        int summen = 0;
        int ohnePreis = 0;
        for (Abfrage a : jdbc.abfragen) {
            boolean summe = a.sql().contains(" HAVING count(*) FILTER (WHERE " + PREIS + ") > 0");
            boolean zeilenLesung = a.sql().contains("LEFT JOIN price_slot p") && !a.sql().contains("GROUP BY")
                    && a.sql().endsWith("ORDER BY r.site_id, r.bucket");
            if (!summe && !zeilenLesung) {
                continue; // andere Abfragen des Repositorys: nicht umgeformt
            }
            assertThat(a.sql()).as("keine Preis-Bedingung mehr im WHERE").doesNotContain("AND " + PREIS + " ");
            if (summe) {
                // Summen: alte Form = Preis-Bedingung im WHERE, kein FILTER/HAVING auf sie.
                String alt = a.sql()
                        .replace(" FILTER (WHERE " + PREIS + ")", "")
                        .replace(" HAVING count(*) FILTER (WHERE " + PREIS + ") > 0", "");
                assertThat(alt).as("FILTER/HAVING wurde entfernt").isNotEqualTo(a.sql());
                alt = einmal(alt, " GROUP BY", " AND " + PREIS + " GROUP BY");
                assertThat(zeilen(roh, a.sql(), a.args(), false)).as(a.sql()).isEqualTo(zeilen(roh, alt, a.args(), false));
                summen++;
            } else {
                // Zeilen-Leser: alte Form = Preis-Bedingung im WHERE; die neue liefert die Zeilen ohne Preis mit,
                // der Leser überspringt sie (price_eur_mwh ist eine der Spalten).
                String alt = einmal(a.sql(), " ORDER BY r.site_id, r.bucket", " AND " + PREIS + " ORDER BY r.site_id, r.bucket");
                List<String> neu = zeilen(roh, a.sql(), a.args(), true);
                List<String> mitLuecke = zeilen(roh, a.sql(), a.args(), false);
                ohnePreis += mitLuecke.size() - neu.size();
                assertThat(neu).as(a.sql()).isEqualTo(zeilen(roh, alt, a.args(), false));
                zeilenLeser++;
            }
        }
        assertThat(zeilenLeser).as("Walk- und Arbitrage-Abfragen geprüft").isGreaterThanOrEqualTo(4);
        assertThat(summen).as("Tagesreihe und Buckets geprüft").isGreaterThanOrEqualTo(5);
        assertThat(ohnePreis).as("die Preislücke kommt in der neuen Form an und wird übersprungen").isPositive();
        // Der Zaun: eine Anlage des anderen Mandanten liefert in keiner Form etwas.
        assertThat(repo.savedSpeicherForSite(B1, von, bis)).isNull();
        assertThat(repo.bucketedForSite(B1, von, bis, EarningsRepository.Bucket.DAY)).isEmpty();
        // Die Probe trägt Zahlen.
        assertThat(repo.savedSpeicher(von, bis)).containsKeys(A1, A2, A3);
        assertThat(repo.dailySavedPerSite(von, bis)).containsKeys(A1, A2, A3, A4);
    }

    // ================================================================ Werkzeug

    private record Abfrage(String sql, Object[] args) {}

    /** Ein JdbcTemplate, das jede Abfrage mit Rückruf mitschneidet (die Form, die das Repository stellt). */
    private static final class Aufnahme extends JdbcTemplate {
        final List<Abfrage> abfragen = new ArrayList<>();

        Aufnahme(SingleConnectionDataSource ds) {
            super(ds);
        }

        @Override
        public void query(String sql, RowCallbackHandler rch, Object... args) throws DataAccessException {
            abfragen.add(new Abfrage(sql, args.clone()));
            super.query(sql, rch, args);
        }
    }

    private static String einmal(String sql, String alt, String neu) {
        int i = sql.indexOf(alt);
        assertThat(i).as("Anker '%s' in %s", alt, sql).isNotNegative();
        assertThat(sql.indexOf(alt, i + 1)).as("Anker '%s' genau einmal", alt).isNegative();
        return sql.substring(0, i) + neu + sql.substring(i + alt.length());
    }

    /** Alle Spalten jeder Zeile als Text, in Abfragereihenfolge; {@code nurMitPreis} überspringt Zeilen ohne Preis. */
    private static List<String> zeilen(JdbcTemplate jdbc, String sql, Object[] args, boolean nurMitPreis) {
        List<String> out = new ArrayList<>();
        jdbc.query(sql, rs -> {
            ResultSetMetaData md = rs.getMetaData();
            StringBuilder z = new StringBuilder();
            boolean preis = true;
            for (int i = 1; i <= md.getColumnCount(); i++) {
                Object v = rs.getObject(i);
                if ("price_eur_mwh".equals(md.getColumnLabel(i)) && v == null) {
                    preis = false;
                }
                z.append(md.getColumnLabel(i)).append('=').append(v).append('|');
            }
            if (preis || !nurMitPreis) {
                out.add(z.toString());
            }
        }, args);
        return out;
    }

    private static void anlage(Connection c, UUID id, UUID tenant, String zone, String art, BigDecimal anzulegend,
            String tarif, boolean netzladen, boolean speicher) throws Exception {
        exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone, plant_kind, anzulegender_wert_ct_kwh, tarif_art, "
                + "tarif_param_ct_kwh, netzladen_erlaubt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, tenant, "Anlage " + id,
                zone, art, anzulegend, tarif, "fest".equals(tarif) ? new BigDecimal("31.0")
                        : "dynamisch".equals(tarif) ? new BigDecimal("12.0") : null, netzladen);
        if (speicher) {
            exec(c, "INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw, "
                    + "is_primary) VALUES (?, ?, 'battery', 10, 5, 5, true)", tenant, id);
        }
        exec(c, "INSERT INTO asset (tenant_id, site_id, type, is_primary) VALUES (?, ?, 'pv', true)", tenant, id);
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

    private static void exec(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            ps.execute();
        }
    }
}
