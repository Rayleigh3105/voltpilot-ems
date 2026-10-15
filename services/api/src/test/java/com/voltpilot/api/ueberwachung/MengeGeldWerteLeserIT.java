package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.PeakShavingRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die periodischen Leser {@code menge} und {@code geld} gegen echte Zeilen (Alerting Scheibe 4,
 * Konzept vp-alerting-konzept-m1 §6.3/§6.4/§6.7, §7 "Testcontainers-IT je neuer Leserart"): DIESELBE
 * Zahl wie die Erlöse-Fläche ({@link EarningsRepository#aggregateForSite}), die laufende
 * Periodenspitze wie {@code LastspitzenSection} ({@link PeakShavingRepository}), "vorläufig oder
 * erst endgültig" (§6.3) und die Vorperiode für {@code aenderung} (§6.4).
 */
@Testcontainers(disabledWithoutDocker = true)
class MengeGeldWerteLeserIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "menge_geld_it_pw";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final WerteKatalog KATALOG = new WerteKatalog();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate app;
    private static JdbcTemplate adminJdbc;

    @BeforeAll
    static void migrate() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN,
                        "adminDbPassword", PW))
                .load()
                .migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP, PW)));
        adminJdbc = new JdbcTemplate(ds(ADMIN, PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    private static DataSource ds(String user, String pw) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(pw);
        return ds;
    }

    private record Welt(UUID tenant, UUID site) {}

    private static Welt welt(String name) {
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')", site,
                tenant, name + "-Anlage");
        return new Welt(tenant, site);
    }

    /** Ein "abgedecktes" Viertelstunden-Bucket: Rollup-Zeile + passender Day-Ahead-Preis (§6.4, {@link PriceSlots}). */
    private static void bucket(UUID tenant, UUID site, Instant bucketStart, double gridImportKwh,
            double gridExportKwh, double loadKwh) {
        adminJdbc.update("""
                INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh, grid_import_kwh,
                       grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, n_samples)
                VALUES (?, ?, ?, 0, ?, ?, ?, 0, 0, 1)
                """, Timestamp.from(bucketStart), tenant, site, loadKwh, gridImportKwh, gridExportKwh);
        adminJdbc.update("""
                INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh)
                VALUES (?, 'DE-LU', 'PT15M', 100) ON CONFLICT DO NOTHING
                """, Timestamp.from(bucketStart));
    }

    private static Instant viertelstundeVon(Instant jetzt) {
        return jetzt.truncatedTo(ChronoUnit.HOURS)
                .plusSeconds((jetzt.getEpochSecond() % 3600 / 900) * 900);
    }

    @Test
    void geldLeserLiestDieselbenErloeseWieDieErloeseFlaeche() {
        Welt w = welt("Geld-Leser GmbH");
        Instant jetzt = Instant.now();
        bucket(w.tenant(), w.site(), viertelstundeVon(jetzt), 10.0, 2.0, 8.0);
        EarningsRepository earnings = new EarningsRepository(app, new OptimizerProperties(4.0, 0.3, null, null, false));
        GeldWerteLeser leser = new GeldWerteLeser(earnings, app);

        TenantContext.set(w.tenant());
        try {
            LocalDate heute = jetzt.atZone(BERLIN).toLocalDate();
            EarningsRepository.SiteAggregate agg = earnings.aggregateForSite(w.site(),
                    heute.withDayOfMonth(1).atStartOfDay(BERLIN).toInstant(),
                    heute.withDayOfMonth(1).plusMonths(1).atStartOfDay(BERLIN).toInstant());
            assertThat(agg).isNotNull();
            assertThat(agg.stromkostenEur()).isNotNull();

            WerteLeser.Lesung kosten = leser.lesePeriode(KATALOG.eintrag("anlage.geld.kosten"),
                    WerteLeser.Bezug.anlage(w.site()), "monat", false, jetzt);
            assertThat(kosten.bekannt()).isTrue();
            assertThat(kosten.zahlenwert()).isEqualTo(agg.stromkostenEur().doubleValue());
            assertThat(kosten.einheit()).isEqualTo("EUR");

            WerteLeser.Lesung erloes = leser.lesePeriode(KATALOG.eintrag("anlage.geld.erloes"),
                    WerteLeser.Bezug.anlage(w.site()), "monat", false, jetzt);
            BigDecimal erwarteterErloes = nullSafeAdd(agg.einspeiseErloesEur(), agg.eigenverbrauchsWertEur());
            assertThat(erloes.zahlenwert()).isEqualTo(erwarteterErloes.doubleValue());
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void mengeLeserLiestDenselbenVerbrauchWieDieErloeseFlaeche() {
        Welt w = welt("Menge-Leser GmbH");
        Instant jetzt = Instant.now();
        bucket(w.tenant(), w.site(), viertelstundeVon(jetzt), 10.0, 2.0, 8.0);
        EarningsRepository earnings = new EarningsRepository(app, new OptimizerProperties(4.0, 0.3, null, null, false));
        PeakShavingRepository peaks = new PeakShavingRepository(app);
        MengeWerteLeser leser = new MengeWerteLeser(earnings, peaks, app);

        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung lesung = leser.lesePeriode(KATALOG.eintrag("anlage.verbrauch.menge"),
                    WerteLeser.Bezug.anlage(w.site()), "monat", false, jetzt);
            assertThat(lesung.bekannt()).isTrue();
            assertThat(lesung.einheit()).isEqualTo("kWh");
            assertThat(lesung.zahlenwert()).isGreaterThan(0);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void ohneJedeTelemetrieIstDerWertUnbekanntNieEineErfundeneNull() {
        Welt w = welt("Keine Daten GmbH");
        EarningsRepository earnings = new EarningsRepository(app, new OptimizerProperties(4.0, 0.3, null, null, false));
        GeldWerteLeser leser = new GeldWerteLeser(earnings, app);

        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung lesung = leser.lesePeriode(KATALOG.eintrag("anlage.geld.kosten"),
                    WerteLeser.Bezug.anlage(w.site()), "monat", false, Instant.now());
            assertThat(lesung.bekannt()).isFalse();
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void nurEndgueltigLiefertUnbekanntSolangeDieLaufendePeriodeNochNichtAbgeschlossenIst() {
        Welt w = welt("Endgueltig GmbH");
        Instant jetzt = Instant.now();
        bucket(w.tenant(), w.site(), viertelstundeVon(jetzt), 10.0, 2.0, 8.0);
        EarningsRepository earnings = new EarningsRepository(app, new OptimizerProperties(4.0, 0.3, null, null, false));
        GeldWerteLeser leser = new GeldWerteLeser(earnings, app);

        TenantContext.set(w.tenant());
        try {
            // "tag" ist noch nicht vorbei - endgueltig=true darf den Wert noch nicht zeigen.
            WerteLeser.Lesung vorlaeufigVerlangtEndgueltig = leser.lesePeriode(KATALOG.eintrag("anlage.geld.kosten"),
                    WerteLeser.Bezug.anlage(w.site()), "tag", true, jetzt);
            assertThat(vorlaeufigVerlangtEndgueltig.bekannt()).isFalse();

            // Ohne die Vorgabe "endgueltig" bleibt der vorläufige Wert sichtbar.
            WerteLeser.Lesung vorlaeufig = leser.lesePeriode(KATALOG.eintrag("anlage.geld.kosten"),
                    WerteLeser.Bezug.anlage(w.site()), "tag", false, jetzt);
            assertThat(vorlaeufig.bekannt()).isTrue();
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void leseVorperiodeLiestDenVormonatNichtDenLaufendenMonat() {
        Welt w = welt("Vorperiode GmbH");
        Instant jetzt = Instant.now();
        Instant vorMonat = jetzt.atZone(BERLIN).toLocalDate().withDayOfMonth(1).minusDays(15)
                .atStartOfDay(BERLIN).toInstant();
        bucket(w.tenant(), w.site(), viertelstundeVon(jetzt), 10.0, 0.0, 10.0); // laufender Monat
        bucket(w.tenant(), w.site(), viertelstundeVon(vorMonat), 5.0, 0.0, 5.0); // Vormonat
        EarningsRepository earnings = new EarningsRepository(app, new OptimizerProperties(4.0, 0.3, null, null, false));
        GeldWerteLeser leser = new GeldWerteLeser(earnings, app);

        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung laufend = leser.lesePeriode(KATALOG.eintrag("anlage.geld.kosten"),
                    WerteLeser.Bezug.anlage(w.site()), "monat", false, jetzt);
            WerteLeser.Lesung vorperiode = leser.leseVorperiode(KATALOG.eintrag("anlage.geld.kosten"),
                    WerteLeser.Bezug.anlage(w.site()), "monat", jetzt);

            assertThat(laufend.bekannt()).isTrue();
            assertThat(vorperiode.bekannt()).isTrue();
            // 10 kWh Bezug (laufend) vs. 5 kWh Bezug (Vormonat) bei demselben Preis - die Vorperiode ist
            // halb so teuer, nie derselbe Wert wie der laufende Monat.
            assertThat(vorperiode.zahlenwert()).isLessThan(laufend.zahlenwert());
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void lastspitzePeriodeLiestDieselbeSpitzeWieDieLastspitzenFlaeche() {
        Welt w = welt("Lastspitze GmbH");
        Instant jetzt = Instant.now();
        Instant b1 = viertelstundeVon(jetzt);
        Instant b2 = b1.minusSeconds(900);
        bucket(w.tenant(), w.site(), b1, 20.0, 0.0, 20.0);
        bucket(w.tenant(), w.site(), b2, 50.0, 0.0, 50.0); // höher - das ist die Spitze
        EarningsRepository earnings = new EarningsRepository(app, new OptimizerProperties(4.0, 0.3, null, null, false));
        PeakShavingRepository peaks = new PeakShavingRepository(app);
        MengeWerteLeser leser = new MengeWerteLeser(earnings, peaks, app);

        TenantContext.set(w.tenant());
        try {
            BigDecimal direkt = peaks.laufendePeriodenSpitzeKw(w.site(), jetzt.atZone(BERLIN).toLocalDate());
            WerteLeser.Lesung lesung = leser.lesePeriode(KATALOG.eintrag("anlage.lastspitze.periode"),
                    WerteLeser.Bezug.anlage(w.site()), "abrechnungszeitraum", false, jetzt);

            assertThat(direkt.doubleValue()).isEqualTo(200.0); // 50 kWh / 0,25 h = 200 kW
            assertThat(lesung.bekannt()).isTrue();
            assertThat(lesung.zahlenwert()).isEqualTo(direkt.doubleValue());
            assertThat(lesung.einheit()).isEqualTo("kW");
        } finally {
            TenantContext.clear();
        }
    }

    private static BigDecimal nullSafeAdd(BigDecimal a, BigDecimal b) {
        if (a == null && b == null) {
            return BigDecimal.ZERO;
        }
        return (a == null ? BigDecimal.ZERO : a).add(b == null ? BigDecimal.ZERO : b);
    }
}
