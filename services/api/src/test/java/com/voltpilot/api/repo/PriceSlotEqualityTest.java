package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * The acceptance criterion of the price-matching materialization: for every
 * price constellation that can occur, the {@link PriceSlots} series picks
 * EXACTLY the price the retired per-bucket
 * {@code LEFT JOIN LATERAL ... ORDER BY (resolution = 'PT15M') DESC, ts DESC
 * LIMIT 1} picked - slot for slot, including where both pick nothing.
 *
 * <p>The old lateral is spelled out VERBATIM in {@link #OLD_LATERAL} and runs
 * as the oracle against a real TimescaleDB, so this test pins the semantics of
 * the form that was replaced, not a paraphrase of it. Both matchings run in ONE
 * query over a dense 15-min probe grid, so a divergence surfaces as a concrete
 * slot with both prices, not as a summary count.
 *
 * <p>Covered constellations (one bidding zone each, so they cannot mask each
 * other): pure PT15M, pure PT60M, mixed resolutions in the same window, gaps
 * without any price, a zone with no prices at all, prices whose {@code ts} is
 * NOT quarter-aligned, an unknown resolution (the lateral's {@code ELSE
 * INTERVAL '15 minutes'} branch), two overlapping equal-rank rows (the
 * {@code ts DESC} tie-break), and a covering price row that starts BEFORE the
 * queried window (the lower-margin regression guard - narrowing that margin
 * would silently drop the first buckets' price).
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class PriceSlotEqualityTest {

    /**
     * The retired matching, verbatim (HistoryRepository.PRICE_LATERAL before the
     * materialization; EarningsRepository carried the same body with the zone
     * taken from the joined site row). Binds the bidding zone.
     */
    private static final String OLD_LATERAL =
            "LEFT JOIN LATERAL ("
                    + "  SELECT p.price_eur_mwh FROM day_ahead_prices p"
                    + "  WHERE p.bidding_zone = ? AND p.ts <= b.bucket"
                    + "    AND p.ts + (CASE p.resolution WHEN 'PT60M' THEN INTERVAL '60 minutes'"
                    + "                ELSE INTERVAL '15 minutes' END) > b.bucket"
                    + "  ORDER BY (p.resolution = 'PT15M') DESC, p.ts DESC LIMIT 1"
                    + ") p ON true ";

    /** The probe window: a full day of quarter hours, well clear of any seed. */
    private static final Instant WINDOW_FROM = Instant.parse("2026-03-01T00:00:00Z");
    private static final Instant WINDOW_TO = Instant.parse("2026-03-02T00:00:00Z");

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

        try (Connection c = dataSource().getConnection()) {
            // Pure PT15M with a one-hour gap (02:00-03:00).
            for (int q = 0; q < 8; q++) {
                price(c, "Z-15", "PT15M", WINDOW_FROM.plusSeconds(q * 900L), 10 + q);
            }
            for (int q = 12; q < 16; q++) {
                price(c, "Z-15", "PT15M", WINDOW_FROM.plusSeconds(q * 900L), 10 + q);
            }

            // Pure PT60M with a gap at 02:00.
            price(c, "Z-60", "PT60M", WINDOW_FROM, 100);
            price(c, "Z-60", "PT60M", WINDOW_FROM.plusSeconds(3600), 101);
            price(c, "Z-60", "PT60M", WINDOW_FROM.plusSeconds(3 * 3600), 103);

            // Mixed: hourly PT60M all morning, PT15M only for the 01:00 hour and
            // one lone quarter at 03:30 -> the finer resolution must win exactly
            // where it exists and nowhere else.
            for (int h = 0; h < 4; h++) {
                price(c, "Z-MIX", "PT60M", WINDOW_FROM.plusSeconds(h * 3600L), 200 + h);
            }
            for (int q = 4; q < 8; q++) {
                price(c, "Z-MIX", "PT15M", WINDOW_FROM.plusSeconds(q * 900L), 300 + q);
            }
            price(c, "Z-MIX", "PT15M", WINDOW_FROM.plusSeconds(14 * 900L), 350);

            // Odd shapes: an unaligned PT15M, an unaligned PT60M, a second PT60M
            // overlapping it (ts DESC tie-break) and an unknown resolution that
            // the lateral's ELSE branch treats as a 15-min slot and that must
            // lose to a PT15M row on the same slot.
            price(c, "Z-ODD", "PT15M", WINDOW_FROM.plusSeconds(300), 400);
            price(c, "Z-ODD", "PT60M", WINDOW_FROM.plusSeconds(50 * 60), 401);
            price(c, "Z-ODD", "PT60M", WINDOW_FROM.plusSeconds(90 * 60), 402);
            price(c, "Z-ODD", "PT30M", WINDOW_FROM.plusSeconds(150 * 60), 403);
            price(c, "Z-ODD", "PT15M", WINDOW_FROM.plusSeconds(150 * 60), 404);

            // A covering PT60M row that STARTS BEFORE the queried window.
            price(c, "Z-EDGE", "PT60M", WINDOW_FROM.minusSeconds(45 * 60), 500);
        }
    }

    @Test
    void materializedSeriesPicksTheSamePriceAsTheOldLateralInEveryConstellation() throws Exception {
        for (String zone : List.of("Z-15", "Z-60", "Z-MIX", "Z-ODD", "Z-EDGE", "Z-EMPTY")) {
            List<Match> matches = compare(zone);
            assertThat(matches).as("probe grid of %s", zone).hasSize(96);
            assertThat(matches)
                    .as("materialized series differs from the old lateral in zone %s", zone)
                    .allSatisfy(m -> assertThat(price(m.materialized()))
                            .as("slot %s", m.slot())
                            .isEqualTo(price(m.lateral())));
        }
    }

    /** Null-safe, scale-insensitive rendering so a divergence reads plainly. */
    private static String price(BigDecimal value) {
        return value == null ? "kein Preis" : value.stripTrailingZeros().toPlainString();
    }

    @Test
    void theProbeGridActuallyExercisesEveryConstellation() throws Exception {
        // Guards the test itself: an all-NULL grid would make the equality
        // assertion vacuous, so pin what each zone is expected to contain.
        assertThat(priced("Z-15")).isEqualTo(12);   // 8 + 4 quarters, one hour gap
        assertThat(priced("Z-60")).isEqualTo(12);   // 3 hours x 4 quarters, one hour gap
        assertThat(priced("Z-MIX")).isEqualTo(16);  // 4 hours; the PT15M rows only override
        assertThat(priced("Z-ODD")).isEqualTo(8);
        assertThat(priced("Z-EDGE")).isEqualTo(1);  // only the window's first slot
        assertThat(priced("Z-EMPTY")).isZero();

        // ... and pin the DECISIONS, not just the coverage:
        Map<Instant, BigDecimal> mix = byslot("Z-MIX");
        // PT60M owns 00:00-00:45 ...
        assertThat(mix.get(WINDOW_FROM)).isEqualByComparingTo("200");
        assertThat(mix.get(WINDOW_FROM.plusSeconds(45 * 60))).isEqualByComparingTo("200");
        // ... PT15M takes over for the whole 01:00 hour ...
        assertThat(mix.get(WINDOW_FROM.plusSeconds(60 * 60))).isEqualByComparingTo("304");
        assertThat(mix.get(WINDOW_FROM.plusSeconds(105 * 60))).isEqualByComparingTo("307");
        // ... and the lone 03:30 quarter beats the PT60M row covering that hour.
        assertThat(mix.get(WINDOW_FROM.plusSeconds(180 * 60))).isEqualByComparingTo("203");
        assertThat(mix.get(WINDOW_FROM.plusSeconds(210 * 60))).isEqualByComparingTo("350");

        Map<Instant, BigDecimal> odd = byslot("Z-ODD");
        // The unaligned PT15M at 00:05 covers only the 00:15 slot.
        assertThat(odd.get(WINDOW_FROM)).isNull();
        assertThat(odd.get(WINDOW_FROM.plusSeconds(15 * 60))).isEqualByComparingTo("400");
        assertThat(odd.get(WINDOW_FROM.plusSeconds(30 * 60))).isNull();
        // The unaligned PT60M at 00:50 owns 01:00-01:15, then the later PT60M at
        // 01:30 wins the overlap by ts DESC.
        assertThat(odd.get(WINDOW_FROM.plusSeconds(60 * 60))).isEqualByComparingTo("401");
        assertThat(odd.get(WINDOW_FROM.plusSeconds(75 * 60))).isEqualByComparingTo("401");
        assertThat(odd.get(WINDOW_FROM.plusSeconds(90 * 60))).isEqualByComparingTo("402");
        assertThat(odd.get(WINDOW_FROM.plusSeconds(135 * 60))).isEqualByComparingTo("402");
        // The unknown resolution is a 15-min slot that loses to PT15M.
        assertThat(odd.get(WINDOW_FROM.plusSeconds(150 * 60))).isEqualByComparingTo("404");
        assertThat(odd.get(WINDOW_FROM.plusSeconds(165 * 60))).isNull();

        // The row starting 45 min before the window still prices the first slot.
        assertThat(byslot("Z-EDGE").get(WINDOW_FROM)).isEqualByComparingTo("500");
    }

    // ---- probing -----------------------------------------------------------

    /** One probe slot with both matchings' verdicts. */
    private record Match(Instant slot, BigDecimal lateral, BigDecimal materialized) {
    }

    /**
     * Runs BOTH matchings over the same dense 15-min probe grid in one query, so
     * a divergence is reported with its slot and both prices.
     */
    private List<Match> compare(String zone) throws Exception {
        String sql = "WITH " + PriceSlots.forZone()
                + ", b AS (SELECT g AS bucket FROM generate_series("
                + "    ?::timestamptz, ?::timestamptz - INTERVAL '15 minutes',"
                + "    INTERVAL '15 minutes') g) "
                + "SELECT b.bucket, p.price_eur_mwh AS old_price, n.price_eur_mwh AS new_price "
                + "FROM b " + OLD_LATERAL
                + "LEFT JOIN price_slot n ON n.slot = b.bucket "
                + "ORDER BY b.bucket";
        List<Match> matches = new ArrayList<>();
        try (Connection c = dataSource().getConnection();
                PreparedStatement ps = c.prepareStatement(sql)) {
            ps.setString(1, zone);
            ps.setTimestamp(2, Timestamp.from(WINDOW_FROM));
            ps.setTimestamp(3, Timestamp.from(WINDOW_TO));
            ps.setTimestamp(4, Timestamp.from(WINDOW_FROM));
            ps.setTimestamp(5, Timestamp.from(WINDOW_TO));
            ps.setString(6, zone);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    matches.add(new Match(
                            rs.getTimestamp("bucket").toInstant(),
                            rs.getBigDecimal("old_price"),
                            rs.getBigDecimal("new_price")));
                }
            }
        }
        return matches;
    }

    private long priced(String zone) throws Exception {
        return compare(zone).stream().filter(m -> m.materialized() != null).count();
    }

    private Map<Instant, BigDecimal> byslot(String zone) throws Exception {
        Map<Instant, BigDecimal> prices = new java.util.HashMap<>();
        compare(zone).forEach(m -> prices.put(m.slot(), m.materialized()));
        return prices;
    }

    // ---- fixture -----------------------------------------------------------

    private static void price(Connection c, String zone, String resolution, Instant ts, int eurMwh)
            throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, source)"
                        + " VALUES (?, ?, ?, ?, 'test')")) {
            ps.setTimestamp(1, Timestamp.from(ts));
            ps.setString(2, zone);
            ps.setString(3, resolution);
            ps.setBigDecimal(4, BigDecimal.valueOf(eurMwh));
            ps.executeUpdate();
        }
    }

    private static DataSource dataSource() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }
}
