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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
 * H2/H3 (vp-perf3-server): Vergleichsspeicher-Walk ({@code speicherWalk}), Tagesreihe ({@code dailySaved}) und Eimer
 * ({@code bucketed}) lesen die Stammdaten je Anlage aus einer Zeile je Anlage ({@code anlage}: Speicher, Preisblatt,
 * primäres PV-Asset, feste Vergütung aus der Tranchen-Tabelle, Bereitschaft des Mehr-Einheiten-Mischsatzes) und den
 * Monatsmarktwert je Preis-Slot ({@code preis_mw}) - statt PV-Asset, Marktwert und Registereinheiten je
 * Viertelstunde zu proben. Die Eimer rechnen Import und Export einmal je Viertelstunde im {@code LATERAL z} (B4).
 *
 * <p>Dieser Test hält die ALTE Form wörtlich als Orakel (Stand {@code 44734c3c7}): die drei Abfragen von damals,
 * über dieselben öffentlichen Preis-Kompositionen von {@link SlotEconomics}. Jede Abfrage, die das Repository für
 * diese Wege stellt, wird mitgeschnitten und mit denselben Bindungen in der alten Form gefahren; verlangt wird Zeile
 * für Zeile und Spalte für Spalte dasselbe, für beide Werte von {@code defaultSupplyComponents}. Die Welt deckt die
 * Zweige ab: dynamischer und fester Tarif, gepflegtes Preisblatt, Direktvermarktung mit Marktwert in zwei Monaten
 * (Fenster über die Monatsgrenze), feste EEG-Vergütung aus Inbetriebnahme und kWp, eine Anlage nach dem
 * Solarspitzengesetz (§51a) mit negativen Preisen, angegebene Vergütung, Mehr-Einheiten-Mischung, eine Einheit ohne
 * Leistung (Mischung greift nicht), eine Anlage ohne PV-Asset, eine ohne Speicher (fehlt im Walk), eine Preislücke,
 * Viertelstunden ohne Kanäle, PT60M neben PT15M, zwei Gebotszonen und den fremden Mandanten.
 *
 * <p>Läuft nur mit Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class EarningsStammdatenJeAnlageGleichheitTest {

    // ================================================================ die alte Form, wörtlich (44734c3c7)

    private static final String CHANNELS_OK =
            "r.load_kwh IS NOT NULL AND r.pv_kwh IS NOT NULL"
                    + " AND r.grid_import_kwh IS NOT NULL AND r.grid_export_kwh IS NOT NULL";
    private static final String PRICE_SLOT_CTE = PriceSlots.forTenantZones();
    private static final String PRICE_JOIN =
            "LEFT JOIN price_slot p"
                    + " ON p.bidding_zone = s.bidding_zone AND p.slot = r.bucket ";
    private static final String PRICED = "p.price_eur_mwh IS NOT NULL";
    private static final String MARKET_VALUE_JOIN =
            "LEFT JOIN monthly_market_value mv ON mv.technology = 'solar'"
                    + " AND mv.month = date_trunc('month', r.bucket AT TIME ZONE 'Europe/Berlin')::date ";
    private static final String SELBSTVERBRAUCH_KWH =
            "GREATEST(r.load_kwh - r.grid_import_kwh, 0)";
    private static final String SUPPLY_PRICE_JOIN =
            "LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id ";
    private static final String PV_ASSET_JOIN =
            "LEFT JOIN asset pv ON pv.site_id = s.id AND pv.type = 'pv' AND pv.is_primary ";
    private static final String BATTERY_ASSET_JOIN =
            "JOIN asset b ON b.site_id = r.site_id AND b.type = 'battery' AND b.is_primary"
                    + " AND b.capacity_kwh IS NOT NULL AND b.max_charge_kw IS NOT NULL"
                    + " AND b.max_discharge_kw IS NOT NULL ";

    private static String importPriceEurKwh(OptimizerProperties o) {
        return "(" + SlotEconomics.importPriceCtSql("p.price_eur_mwh", o.defaultSupplyComponents()) + " / 100.0)";
    }

    private static String exportValueEurKwh(OptimizerProperties o) {
        return "(" + SlotEconomics.exportValueCtSql("p.price_eur_mwh", "r.bucket", EegRates.fromJson(o.eegRatesJson()))
                + " / 100.0)";
    }

    /** Die alte Abfrage von {@code speicherWalk}; Bindungen: from, to, from, to [, site]. */
    private static String alterWalk(OptimizerProperties o, boolean jeAnlage) {
        return "WITH " + PRICE_SLOT_CTE
                + "SELECT r.site_id, r.bucket, r.pv_kwh, r.load_kwh, r.soc_last_pct,"
                + " r.grid_import_kwh, r.grid_export_kwh,"
                + " r.battery_charge_kwh, r.battery_discharge_kwh,"
                + " time_bucket('1 day', r.bucket, 'Europe/Berlin') AS day, p.price_eur_mwh,"
                + " CASE WHEN " + PRICED + " THEN " + importPriceEurKwh(o) + " END AS import_price_eur_kwh,"
                + " CASE WHEN " + PRICED + " THEN " + exportValueEurKwh(o) + " END AS export_value_eur_kwh,"
                + " b.capacity_kwh, b.max_charge_kw, b.max_discharge_kw,"
                + " b.roundtrip_efficiency_pct, b.soc_min_pct, b.soc_max_pct,"
                + " s.backup_reserve_soc_pct, s.peak_reserve_soc_pct "
                + "FROM telemetry_rollup_15m r "
                + "JOIN site s ON s.id = r.site_id "
                + BATTERY_ASSET_JOIN
                + SUPPLY_PRICE_JOIN
                + PV_ASSET_JOIN
                + PRICE_JOIN
                + MARKET_VALUE_JOIN
                + "WHERE r.bucket >= ? AND r.bucket < ?" + (jeAnlage ? " AND r.site_id = ?" : "")
                + " AND " + CHANNELS_OK + " "
                + "ORDER BY r.site_id, r.bucket";
    }

    /** Die alte Abfrage von {@code dailySaved}; Bindungen: from, to, from, to [, site]. */
    private static String alteTagesreihe(OptimizerProperties o, boolean jeAnlage) {
        String savedEur = "((GREATEST(r.load_kwh - r.pv_kwh, 0) - r.grid_import_kwh) * "
                + importPriceEurKwh(o)
                + " - (GREATEST(r.pv_kwh - r.load_kwh, 0) - r.grid_export_kwh)"
                + "   * " + exportValueEurKwh(o) + ")";
        return "WITH " + PRICE_SLOT_CTE
                + "SELECT r.site_id,"
                + " time_bucket('1 day', r.bucket, 'Europe/Berlin') AS day,"
                + " sum(" + savedEur + ") FILTER (WHERE " + PRICED + ") AS saved_eur "
                + "FROM telemetry_rollup_15m r "
                + "JOIN site s ON s.id = r.site_id "
                + SUPPLY_PRICE_JOIN
                + PV_ASSET_JOIN
                + PRICE_JOIN
                + MARKET_VALUE_JOIN
                + "WHERE r.bucket >= ? AND r.bucket < ?" + (jeAnlage ? " AND r.site_id = ?" : "")
                + " AND " + CHANNELS_OK + " "
                + "GROUP BY 1, 2 HAVING count(*) FILTER (WHERE " + PRICED + ") > 0 ORDER BY 1, 2";
    }

    /** Die alte Abfrage von {@code bucketed}; Bindungen: from, to, from, to [, site]. */
    private static String alteEimer(OptimizerProperties o, String unit, boolean jeAnlage) {
        String start = "(date_trunc('" + unit + "', r.bucket AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin')";
        String einspeiseErloesEur = "(r.grid_export_kwh * " + exportValueEurKwh(o) + ")";
        String stromkostenEur = "(r.grid_import_kwh * " + importPriceEurKwh(o) + ")";
        String eigenverbrauchsWertEur = "(" + SELBSTVERBRAUCH_KWH + " * "
                + SlotEconomics.importPriceCtSql("p.price_eur_mwh", o.defaultSupplyComponents()) + " / 100.0)";
        return "WITH " + PRICE_SLOT_CTE
                + "SELECT r.site_id, " + start + " AS bucket_start,"
                + " sum(" + einspeiseErloesEur + ") FILTER (WHERE " + PRICED + ") AS einspeise_erloes_eur,"
                + " sum(" + eigenverbrauchsWertEur + ") FILTER (WHERE " + PRICED + ")"
                + " AS eigenverbrauchs_wert_eur,"
                + " sum(" + stromkostenEur + ") FILTER (WHERE " + PRICED + ") AS stromkosten_eur "
                + "FROM telemetry_rollup_15m r "
                + "JOIN site s ON s.id = r.site_id "
                + SUPPLY_PRICE_JOIN
                + PV_ASSET_JOIN
                + PRICE_JOIN
                + MARKET_VALUE_JOIN
                + "WHERE r.bucket >= ? AND r.bucket < ?" + (jeAnlage ? " AND r.site_id = ?" : "")
                + " AND " + CHANNELS_OK + " "
                + "GROUP BY r.site_id, bucket_start"
                + " HAVING count(*) FILTER (WHERE " + PRICED + ") > 0 ORDER BY r.site_id, bucket_start";
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
    /** DE-LU, 120 kWp nach dem Solarspitzengesetz (§51a), eine Registereinheit ohne Leistung: keine Mischung. */
    private static final UUID A5 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a5");
    /** DE-LU, ohne Speicher (fehlt im Walk), ohne PV-Asset, Preisblatt mit Lücken. */
    private static final UUID A6 = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000a6");
    private static final UUID B1 = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000b1");

    /** 1. November 2026 00:00 Europe/Berlin. */
    private static final Instant NOV = Instant.parse("2026-10-31T23:00:00Z");
    /** Daten ab dem 28. Oktober: Walk-Läufe ab Monatsbeginn Oktober, Fenster über die Monatsgrenze. */
    private static final Instant BEGINN = NOV.minusSeconds(4 * 86400L);
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
            anlage(c, A1, TENANT_A, "DE-LU", "eigenverbrauch", null, "dynamisch", new BigDecimal("12.0"), true, null,
                    true, true);
            anlage(c, A2, TENANT_A, "DE-LU", "direktvermarktung", new BigDecimal("8.5"), "fest", new BigDecimal("31.0"),
                    false, null, true, true);
            anlage(c, A3, TENANT_A, "AT", "eigenverbrauch", null, "ohne", null, false, null, true, true);
            anlage(c, A4, TENANT_A, "DE-LU", "eigenverbrauch", null, "ohne", null, false, new BigDecimal("7.94"),
                    true, true);
            anlage(c, A5, TENANT_A, "DE-LU", "eigenverbrauch", null, "dynamisch", null, false, null, true, true);
            anlage(c, A6, TENANT_A, "DE-LU", "eigenverbrauch", null, "ohne", null, false, null, false, false);
            anlage(c, B1, TENANT_B, "DE-LU", "eigenverbrauch", null, "dynamisch", new BigDecimal("12.0"), true, null,
                    true, true);
            exec(c, "UPDATE asset SET commissioned_on = DATE '2015-04-01', pv_capacity_kwp = 9.8 "
                    + "WHERE site_id = ? AND type = 'pv'", A1);
            exec(c, "UPDATE asset SET commissioned_on = DATE '2025-06-01', pv_capacity_kwp = 120 "
                    + "WHERE site_id = ? AND type = 'pv'", A5);
            exec(c, "INSERT INTO site_supply_price (site_id, tenant_id, netzentgelt_arbeitspreis_ct, stromsteuer_ct, "
                    + "konzessionsabgabe_ct, umlagen_ct, vertriebsaufschlag_ct, ust_pct, komponenten_stand, updated_at) "
                    + "VALUES (?, ?, 8.1, 2.05, 1.66, 2.6, 1.5, 19, DATE '2026-01-01', now())", A2, TENANT_A);
            exec(c, "INSERT INTO site_supply_price (site_id, tenant_id, netzentgelt_arbeitspreis_ct, umlagen_ct, ust_pct, "
                    + "komponenten_stand, updated_at) VALUES (?, ?, 7.3, 2.6, 7, DATE '2026-01-01', now())", A6, TENANT_A);
            for (Object[] e : new Object[][] {{A3, "2010-05-01", "6.0"}, {A3, "2025-03-01", "4.0"},
                    {A5, "2025-06-01", "110.0"}, {A5, "2025-07-01", null}}) {
                exec(c, "INSERT INTO register_einheit (tenant_id, site_id, art, inbetriebnahme, leistung_kwp, "
                        + "bestaetigt_am) VALUES (?, ?, 'pv', ?, ?, now())", TENANT_A, e[0], LocalDate.parse((String) e[1]),
                        e[2] == null ? null : new BigDecimal((String) e[2]));
            }
            exec(c, "INSERT INTO monthly_market_value (technology, month, value_ct_kwh, provisional) "
                    + "VALUES ('solar', DATE '2026-10-01', 7.1, false), ('solar', DATE '2026-11-01', 6.2, true) "
                    + "ON CONFLICT DO NOTHING");
            for (Instant t = BEGINN.minusSeconds(3600); t.isBefore(NOV.plusSeconds(TAGE * 86400L)); t = t.plusSeconds(900)) {
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
            for (UUID s : List.of(A1, A2, A3, A4, A5, A6, B1)) {
                UUID ten = s.equals(B1) ? TENANT_B : TENANT_A;
                for (Instant t = BEGINN.minusSeconds(2 * 900); t.isBefore(NOV.plusSeconds(TAGE * 86400L));
                        t = t.plusSeconds(900)) {
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
    void stammdatenJeAnlageLiefernDieselbenZeilenWieDieAlteForm() throws Exception {
        List<Instant[]> fenster = List.of(
                new Instant[] {NOV, NOV.plusSeconds(TAGE * 86400L)},                         // November
                new Instant[] {BEGINN.plusSeconds(86400), NOV.plusSeconds(3 * 86400L)},      // über die Monatsgrenze
                new Instant[] {NOV.plusSeconds(2 * 86400L), NOV.plusSeconds(3 * 86400L)},    // der Tag mit der Lücke
                new Instant[] {NOV, NOV});                                                   // leer
        Pattern einheit = Pattern.compile("date_trunc\\('(hour|day|month)', r\\.bucket AT TIME ZONE");
        int walk = 0;
        int reihe = 0;
        int eimer = 0;
        int zeilen = 0;
        for (boolean komponenten : List.of(false, true)) {
            OptimizerProperties o = new OptimizerProperties(4.0, 0.3, null, null, komponenten);
            Aufnahme jdbc = new Aufnahme(appRole(TENANT_A));
            EarningsRepository repo = new EarningsRepository(jdbc, o);
            for (Instant[] f : fenster) {
                repo.savedSpeicher(f[0], f[1]);
                repo.dailySavedPerSite(f[0], f[1]);
                repo.tagesbilderUndReihe(NOV.plusSeconds(2 * 86400L), NOV.plusSeconds(3 * 86400L), false, f[0]);
                repo.fensterwerte(f[0], f[1]);
                for (EarningsRepository.Bucket b : EarningsRepository.Bucket.values()) {
                    repo.bucketed(f[0], f[1], b);
                }
                for (UUID s : List.of(A1, A3, A5, A6, B1)) {
                    repo.savedSpeicherForSite(s, f[0], f[1]);
                    repo.tagesbildForSite(s, NOV.plusSeconds(2 * 86400L), NOV.plusSeconds(3 * 86400L), false);
                    repo.bucketedForSite(s, f[0], f[1], EarningsRepository.Bucket.DAY);
                }
            }
            JdbcTemplate roh = new JdbcTemplate(appRole(TENANT_A));
            for (Abfrage a : jdbc.abfragen) {
                if (!a.sql().contains("preis_mw AS MATERIALIZED")) {
                    assertThat(a.sql()).as("nur die drei Wege sind umgebaut").doesNotContain("anlage AS MATERIALIZED");
                    continue;
                }
                boolean jeAnlage = a.args().length == 5;
                String alt;
                if (a.sql().contains(" AS export_value_eur_kwh,")) {
                    alt = alterWalk(o, jeAnlage);
                    walk++;
                } else if (a.sql().contains(" AS saved_eur ")) {
                    alt = alteTagesreihe(o, jeAnlage);
                    reihe++;
                } else {
                    Matcher m = einheit.matcher(a.sql());
                    assertThat(m.find()).as("Eimer-Abfrage: %s", a.sql()).isTrue();
                    alt = alteEimer(o, m.group(1), jeAnlage);
                    eimer++;
                }
                assertThat(a.sql()).as("die Tranchen-Tabelle steht nicht mehr je Viertelstunde im Text")
                        .hasSizeLessThan(alt.length() * 3 / 4);
                List<String> neu = zeilen(roh, a.sql(), a.args());
                assertThat(neu).as("Komponenten %s: %s", komponenten, a.sql().substring(0, 40))
                        .isEqualTo(zeilen(roh, alt, a.args()));
                zeilen += neu.size();
            }
        }
        assertThat(walk).as("Walk-Abfragen geprüft").isGreaterThanOrEqualTo(20);
        assertThat(reihe).as("Tagesreihen geprüft").isGreaterThanOrEqualTo(8);
        assertThat(eimer).as("Eimer geprüft").isGreaterThanOrEqualTo(30);
        assertThat(zeilen).as("die Probe trägt Zeilen").isGreaterThan(5000);

        // Stichproben: die Zweige tragen Zahlen, der Zaun hält.
        EarningsRepository repo = new EarningsRepository(new JdbcTemplate(appRole(TENANT_A)),
                new OptimizerProperties(4.0, 0.3, null, null, false));
        Map<UUID, BigDecimal> speicher = repo.savedSpeicher(NOV, NOV.plusSeconds(TAGE * 86400L));
        assertThat(speicher).containsOnlyKeys(A1, A2, A3, A4, A5); // A6 ohne Speicher, B1 fremd
        assertThat(repo.dailySavedPerSite(NOV, NOV.plusSeconds(TAGE * 86400L))).containsOnlyKeys(A1, A2, A3, A4, A5, A6);
        assertThat(repo.savedSpeicherForSite(B1, NOV, NOV.plusSeconds(TAGE * 86400L))).isNull();
        assertThat(repo.bucketedForSite(B1, NOV, NOV.plusSeconds(TAGE * 86400L), EarningsRepository.Bucket.DAY)).isEmpty();
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

    /** Alle Spalten jeder Zeile als Text, in der Reihenfolge der Abfrage (alle drei haben ein ORDER BY). */
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
        return out;
    }

    private static void anlage(Connection c, UUID id, UUID tenant, String zone, String art, BigDecimal anzulegend,
            String tarif, BigDecimal tarifCt, boolean netzladen, BigDecimal verguetung, boolean speicher, boolean pv)
            throws Exception {
        exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone, plant_kind, anzulegender_wert_ct_kwh, tarif_art, "
                + "tarif_param_ct_kwh, netzladen_erlaubt, einspeiseverguetung_ct_kwh) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                id, tenant, "Anlage " + id, zone, art, anzulegend, tarif, tarifCt, netzladen, verguetung);
        if (speicher) {
            exec(c, "INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, max_discharge_kw, "
                    + "is_primary) VALUES (?, ?, 'battery', 10, 5, 5, true)", tenant, id);
        }
        if (pv) {
            exec(c, "INSERT INTO asset (tenant_id, site_id, type, is_primary) VALUES (?, ?, 'pv', true)", tenant, id);
        }
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
