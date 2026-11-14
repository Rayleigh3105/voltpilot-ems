package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.optimizer.EegRates;
import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.optimizer.SlotEconomics;
import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSetMetaData;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
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
 * B4 (vp-perf2-server): im Erlös-Aggregat ({@code EarningsRepository.aggregate}) stehen Import-Preis und
 * Export-Wert je Viertelstunde einmal in einer {@code LATERAL}-Unterabfrage, die sieben Geldterme lesen ihre
 * Spalten - statt beide Kompositionen (samt ihrer {@code register_einheit}-Unterabfragen) in jedem Term zu
 * wiederholen. Gemessen plante das 64-KB-SQL 8-12 ms gegen ~1 ms Ausführung, dreimal je
 * {@code /earnings?range=day}.
 *
 * <p>Dieser Test hält die ALTE Form wörtlich als Orakel (Stand {@code a0449bcb7}): die Bausteine und die
 * Abfrage von damals, über dieselben öffentlichen Preis-Kompositionen von {@link SlotEconomics}. Gegen eine
 * echte TimescaleDB unter der RLS-Rolle der App muss die neue Abfrage für jedes Fenster und jede Anlage Spalte
 * für Spalte dasselbe liefern - für beide Werte von {@code defaultSupplyComponents}. Die Welt deckt die Zweige
 * der Kompositionen ab: dynamischer und fester Tarif, gepflegtes Preisblatt, Direktvermarktung mit Marktwert
 * (Marktprämie), feste EEG-Vergütung aus Inbetriebnahme und kWp, angegebene Vergütung, Mehr-Einheiten-Mischung
 * über {@code register_einheit} mit einer Einheit nach dem Solarspitzengesetz (§51a), negative Preise, eine
 * Preislücke, Viertelstunden ohne Kanäle, PT60M neben PT15M, zwei Gebotszonen und den fremden Mandanten.
 *
 * <p>Läuft nur mit Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class EarningsAggregatPreiseJeZeileGleichheitTest {

    // ================================================================ die alte Form, wörtlich (a0449bcb7)

    private static final String CHANNELS_OK =
            "r.load_kwh IS NOT NULL AND r.pv_kwh IS NOT NULL"
                    + " AND r.grid_import_kwh IS NOT NULL AND r.grid_export_kwh IS NOT NULL";
    private static final String PRICE_SLOT_CTE = PriceSlots.forTenantZones();
    private static final String PRICE_JOIN =
            "LEFT JOIN price_slot p"
                    + " ON p.bidding_zone = s.bidding_zone AND p.slot = r.bucket ";
    private static final String COVERED = CHANNELS_OK + " AND p.price_eur_mwh IS NOT NULL";
    private static final String MARKET_VALUE_JOIN =
            "LEFT JOIN monthly_market_value mv ON mv.technology = 'solar'"
                    + " AND mv.month = date_trunc('month', r.bucket AT TIME ZONE 'Europe/Berlin')::date ";
    private static final String PREMIUM_ELIGIBLE =
            "s.plant_kind = 'direktvermarktung' AND s.anzulegender_wert_ct_kwh IS NOT NULL"
                    + " AND mv.value_ct_kwh IS NOT NULL AND p.price_eur_mwh >= 0";
    private static final String PREMIUM_RATE_CT =
            "GREATEST(s.anzulegender_wert_ct_kwh - mv.value_ct_kwh, 0)";
    private static final String ACTUAL_PREMIUM_EUR =
            "(CASE WHEN " + PREMIUM_ELIGIBLE
                    + " THEN r.grid_export_kwh * " + PREMIUM_RATE_CT + " / 100 ELSE 0 END)";
    private static final String SELBSTVERBRAUCH_KWH =
            "GREATEST(r.load_kwh - r.grid_import_kwh, 0)";
    private static final String BATTERIE_BEWEGT_KWH =
            "(COALESCE(r.battery_charge_kwh, 0) + COALESCE(r.battery_discharge_kwh, 0))";
    private static final String SUPPLY_PRICE_JOIN =
            "LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id ";
    private static final String PV_ASSET_JOIN =
            "LEFT JOIN asset pv ON pv.site_id = s.id AND pv.type = 'pv' AND pv.is_primary ";

    /** Die alte Abfrage von {@code aggregate(from, to, site)}; Bindungen: from, to, from, to [, site]. */
    private static String altesAggregat(OptimizerProperties optimizer, boolean jeAnlage) {
        String importPriceEurKwh = "(" + SlotEconomics.importPriceCtSql(
                "p.price_eur_mwh", optimizer.defaultSupplyComponents()) + " / 100.0)";
        String exportValueEurKwh = "(" + SlotEconomics.exportValueCtSql(
                "p.price_eur_mwh", "r.bucket", EegRates.fromJson(optimizer.eegRatesJson()))
                + " / 100.0)";
        String einspeiseErloesEur = "(r.grid_export_kwh * " + exportValueEurKwh + ")";
        String stromkostenEur = "(r.grid_import_kwh * " + importPriceEurKwh + ")";
        String eigenverbrauchsWertEur = "(" + SELBSTVERBRAUCH_KWH + " * "
                + SlotEconomics.importPriceCtSql("p.price_eur_mwh", optimizer.defaultSupplyComponents())
                + " / 100.0)";
        String baselineEur = "(GREATEST(r.load_kwh - r.pv_kwh, 0) * " + importPriceEurKwh
                + " - GREATEST(r.pv_kwh - r.load_kwh, 0) * " + exportValueEurKwh + ")";
        String actualEur = "(r.grid_import_kwh * " + importPriceEurKwh
                + " - r.grid_export_kwh * " + exportValueEurKwh + ")";
        String exportKwh = "sum(r.grid_export_kwh) FILTER (WHERE " + COVERED + ")";
        String mvFilter = COVERED + " AND mv.value_ct_kwh IS NOT NULL";
        return "WITH " + PRICE_SLOT_CTE
                + "SELECT r.site_id,"
                + " count(*) AS bucket_count,"
                + " count(*) FILTER (WHERE " + CHANNELS_OK + ") AS channel_buckets,"
                + " count(*) FILTER (WHERE " + COVERED + ") AS covered_slots,"
                + " sum(" + baselineEur + ")"
                + "   FILTER (WHERE " + COVERED + ") AS baseline_eur,"
                + " sum(" + actualEur + ")"
                + "   FILTER (WHERE " + COVERED + ") AS actual_eur,"
                + " min(r.bucket) FILTER (WHERE " + COVERED + ") AS first_covered,"
                + " sum(r.grid_export_kwh * p.price_eur_mwh / 10)"
                + "   FILTER (WHERE " + COVERED + ")"
                + "   / NULLIF(" + exportKwh + ", 0) AS realized_export_ct,"
                + " sum(r.grid_export_kwh * mv.value_ct_kwh)"
                + "   FILTER (WHERE " + mvFilter + ")"
                + "   / NULLIF(sum(r.grid_export_kwh) FILTER (WHERE " + mvFilter + "), 0)"
                + "   AS market_value_ct,"
                + " bool_or(mv.provisional)"
                + "   FILTER (WHERE " + mvFilter + " AND r.grid_export_kwh > 0)"
                + "   AS market_value_provisional,"
                + " sum(" + einspeiseErloesEur + ")"
                + "   FILTER (WHERE " + COVERED + ") AS einspeise_erloes_eur,"
                + " sum(" + eigenverbrauchsWertEur + ")"
                + "   FILTER (WHERE " + COVERED + ") AS eigenverbrauchs_wert_eur,"
                + " sum(" + SELBSTVERBRAUCH_KWH + ")"
                + "   FILTER (WHERE " + COVERED + ") AS selbstverbrauch_kwh,"
                + " sum(r.grid_export_kwh)"
                + "   FILTER (WHERE " + COVERED + ") AS eingespeist_kwh,"
                + " sum(" + BATTERIE_BEWEGT_KWH + ")"
                + "   FILTER (WHERE " + COVERED + ") AS batterie_bewegt_kwh,"
                + " sum(" + stromkostenEur + ")"
                + "   FILTER (WHERE " + COVERED + ") AS stromkosten_eur,"
                + " sum(r.grid_import_kwh)"
                + "   FILTER (WHERE " + COVERED + ") AS bezogen_kwh,"
                + " sum(" + ACTUAL_PREMIUM_EUR + ")"
                + "   FILTER (WHERE " + COVERED + " AND " + PREMIUM_ELIGIBLE + ")"
                + "   AS marktpraemie_eur "
                + "FROM telemetry_rollup_15m r "
                + "JOIN site s ON s.id = r.site_id "
                + SUPPLY_PRICE_JOIN
                + PV_ASSET_JOIN
                + PRICE_JOIN
                + MARKET_VALUE_JOIN
                + "WHERE r.bucket >= ? AND r.bucket < ?" + (jeAnlage ? " AND r.site_id = ?" : "") + " "
                + "GROUP BY r.site_id";
    }

    // ================================================================ die Welt

    private static final UUID TENANT_A = UUID.fromString("aaaaaaaa-0000-0000-0000-00000000000a");
    private static final UUID TENANT_B = UUID.fromString("bbbbbbbb-0000-0000-0000-00000000000b");
    /** DE-LU, dynamischer Tarif, Netzladen, feste EEG-Vergütung aus Inbetriebnahme 2015 und 9,8 kWp. */
    private static final UUID A1 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a1");
    /** DE-LU, Direktvermarktung mit anzulegendem Wert, fester Tarif, gepflegtes Preisblatt. */
    private static final UUID A2 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a2");
    /** AT, ohne Tarif, zwei bestätigte Registereinheiten (eine nach dem Solarspitzengesetz): die Mischung. */
    private static final UUID A3 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a3");
    /** DE-LU, angegebene Einspeisevergütung. */
    private static final UUID A4 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a4");
    private static final UUID B1 = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000b1");

    /** 1. November 2026 00:00 Europe/Berlin. */
    private static final Instant NOV = Instant.parse("2026-10-31T23:00:00Z");
    private static final int TAGE = 6;
    private static final Instant LUECKE_VON = Instant.parse("2026-11-03T09:00:00Z");
    private static final Instant LUECKE_BIS = Instant.parse("2026-11-03T12:00:00Z");

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
            anlage(c, A1, TENANT_A, "DE-LU", "eigenverbrauch", null, "dynamisch", new BigDecimal("12.0"), true, null);
            anlage(c, A2, TENANT_A, "DE-LU", "direktvermarktung", new BigDecimal("8.5"), "fest", new BigDecimal("31.0"),
                    false, null);
            anlage(c, A3, TENANT_A, "AT", "eigenverbrauch", null, "ohne", null, false, null);
            anlage(c, A4, TENANT_A, "DE-LU", "eigenverbrauch", null, "ohne", null, false, new BigDecimal("7.94"));
            anlage(c, B1, TENANT_B, "DE-LU", "eigenverbrauch", null, "dynamisch", new BigDecimal("12.0"), true, null);
            exec(c, "UPDATE asset SET commissioned_on = DATE '2015-04-01', pv_capacity_kwp = 9.8 "
                    + "WHERE site_id = ? AND type = 'pv'", A1);
            exec(c, "INSERT INTO site_supply_price (site_id, tenant_id, netzentgelt_arbeitspreis_ct, stromsteuer_ct, "
                    + "konzessionsabgabe_ct, umlagen_ct, vertriebsaufschlag_ct, ust_pct, komponenten_stand, updated_at) "
                    + "VALUES (?, ?, 8.1, 2.05, 1.66, 2.6, 1.5, 19, DATE '2026-01-01', now())", A2, TENANT_A);
            for (Object[] e : new Object[][] {{"2010-05-01", "6.0"}, {"2025-03-01", "4.0"}}) {
                exec(c, "INSERT INTO register_einheit (tenant_id, site_id, art, inbetriebnahme, leistung_kwp, "
                        + "bestaetigt_am) VALUES (?, ?, 'pv', ?, ?, now())", TENANT_A, A3, LocalDate.parse((String) e[0]),
                        new BigDecimal((String) e[1]));
            }
            exec(c, "INSERT INTO monthly_market_value (technology, month, value_ct_kwh, provisional) "
                    + "VALUES ('solar', DATE '2026-11-01', 6.2, true) ON CONFLICT DO NOTHING");
            for (Instant t = NOV.minusSeconds(3600); t.isBefore(NOV.plusSeconds(TAGE * 86400L)); t = t.plusSeconds(900)) {
                if (!t.isBefore(LUECKE_VON) && t.isBefore(LUECKE_BIS)) {
                    continue;
                }
                // −20 … 100 EUR/MWh: negative Stunden für §51a und die Marktprämien-Regel.
                double preis = 40 + 60 * Math.sin(t.getEpochSecond() / 86400.0 * 2 * Math.PI) - (t.getEpochSecond() % 7);
                exec(c, "INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                        + "VALUES (?, 'DE-LU', 'PT15M', ?, 'EUR', 'test')", ts(t), preis);
                if (t.getEpochSecond() % 3600 == 0) {
                    exec(c, "INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                            + "VALUES (?, 'DE-LU', 'PT60M', ?, 'EUR', 'test'), (?, 'AT', 'PT60M', ?, 'EUR', 'test')",
                            ts(t), preis + 1, ts(t), preis - 25);
                }
            }
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
    void preiseJeZeileLiefernDasselbeAggregatWieDieAlteForm() throws Exception {
        List<Instant[]> fenster = List.of(
                new Instant[] {NOV, NOV.plusSeconds(TAGE * 86400L)},                  // alles
                new Instant[] {NOV.plusSeconds(2 * 86400L), NOV.plusSeconds(3 * 86400L)}, // der Tag mit der Lücke
                new Instant[] {LUECKE_VON, LUECKE_BIS},                                // nur die Lücke
                new Instant[] {NOV.plusSeconds(86400), NOV.plusSeconds(86400 + 900)},  // ein Eimer
                new Instant[] {NOV, NOV},                                              // leer
                new Instant[] {Instant.EPOCH, NOV.plusSeconds(10 * 86400L)});          // range=all
        int verglichen = 0;
        for (boolean komponenten : List.of(false, true)) {
            OptimizerProperties optimizer = new OptimizerProperties(4.0, 0.3, null, null, komponenten);
            Aufnahme jdbc = new Aufnahme(appRole(TENANT_A));
            EarningsRepository repo = new EarningsRepository(jdbc, optimizer);
            JdbcTemplate roh = new JdbcTemplate(appRole(TENANT_A));
            for (Instant[] f : fenster) {
                Object[] args = {ts(f[0]), ts(f[1]), ts(f[0]), ts(f[1])};
                jdbc.abfragen.clear();
                repo.aggregate(f[0], f[1]);
                String neu = jdbc.einzige("count(*) AS bucket_count");
                assertThat(neu).as("die Preise stehen einmal je Zeile").contains("CROSS JOIN LATERAL")
                        .hasSizeLessThan(altesAggregat(optimizer, false).length() / 2);
                assertThat(zeilen(roh, neu, args)).as("Flotte %s .. %s, Komponenten %s", f[0], f[1], komponenten)
                        .isEqualTo(zeilen(roh, altesAggregat(optimizer, false), args));
                for (UUID s : List.of(A1, A2, A3, A4, B1)) {
                    Object[] argsS = {ts(f[0]), ts(f[1]), ts(f[0]), ts(f[1]), s};
                    jdbc.abfragen.clear();
                    repo.aggregateForSite(s, f[0], f[1]);
                    List<String> neuS = zeilen(roh, jdbc.einzige("count(*) AS bucket_count"), argsS);
                    assertThat(neuS).as("Anlage %s, %s .. %s, Komponenten %s", s, f[0], f[1], komponenten)
                            .isEqualTo(zeilen(roh, altesAggregat(optimizer, true), argsS));
                    verglichen += neuS.size();
                }
            }
        }
        assertThat(verglichen).as("die Probe trägt Zeilen").isGreaterThan(30);
        // Stichproben: die Zweige tragen Zahlen - Marktprämie bei A2, Mischung bei A3, Preisblatt bei A2.
        EarningsRepository repo = new EarningsRepository(new JdbcTemplate(appRole(TENANT_A)),
                new OptimizerProperties(4.0, 0.3, null, null, false));
        Map<UUID, EarningsRepository.SiteAggregate> alles = repo.aggregate(NOV, NOV.plusSeconds(TAGE * 86400L));
        assertThat(alles).containsOnlyKeys(A1, A2, A3, A4);
        assertThat(alles.get(A2).marktpraemieEur()).isNotNull().isPositive();
        assertThat(alles.get(A3).einspeiseErloesEur()).isNotNull();
        assertThat(alles.get(A1).coveredSlots()).isLessThan(alles.get(A1).channelBuckets());
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

        String einzige(String merkmal) {
            List<String> treffer = abfragen.stream().map(Abfrage::sql).filter(q -> q.contains(merkmal)).toList();
            assertThat(treffer).hasSize(1);
            return treffer.get(0);
        }
    }

    /** Alle Spalten jeder Zeile als Text, sortiert (GROUP BY ohne ORDER BY). */
    private static List<String> zeilen(JdbcTemplate jdbc, String sql, Object[] args) {
        List<String> out = new ArrayList<>();
        jdbc.query(sql, rs -> {
            ResultSetMetaData md = rs.getMetaData();
            StringBuilder z = new StringBuilder();
            for (int i = 1; i <= md.getColumnCount(); i++) {
                z.append(md.getColumnLabel(i)).append('=').append(rs.getObject(i)).append('|');
            }
            out.add(z.toString());
        }, args);
        out.sort(null);
        return out;
    }

    private static void anlage(Connection c, UUID id, UUID tenant, String zone, String art, BigDecimal anzulegend,
            String tarif, BigDecimal tarifCt, boolean netzladen, BigDecimal verguetung) throws Exception {
        exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone, plant_kind, anzulegender_wert_ct_kwh, tarif_art, "
                + "tarif_param_ct_kwh, netzladen_erlaubt, einspeiseverguetung_ct_kwh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                id, tenant, "Anlage " + id, zone, art, anzulegend, tarif, tarifCt, netzladen, verguetung);
        exec(c, "INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw, "
                + "is_primary) VALUES (?, ?, 'battery', 10, 5, 5, true)", tenant, id);
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
