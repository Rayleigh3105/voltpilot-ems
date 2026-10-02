package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.optimizer.SlotEconomics;
import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.EarningsRepository.SiteAggregate;
import com.voltpilot.api.repo.OptimizerDiagnosticsRepository;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.assertj.core.data.Offset;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * MiSpeL MP-12, der Prüfnachweis: zwei Anlagen mit derselben Einspeisung zu denselben Preisen -
 * die eine ab 01.10.2026 in der Abgrenzungsoption (Fassung in {@code site_foerderweg}), die andere
 * ohne Fassung (Bestand). Die Erlöse ({@link EarningsRepository}) rechnen die Marktprämie der
 * MiSpeL-Anlage ab ihrem Fassungstag mit dem Jahresmarktwert Solar (Anlage 1 S. 21 Vor. 5; Tenor
 * S. 25-26), die andere Anlage und die MiSpeL-Anlage am Tag davor mit dem Monatsmarktwert. Ohne
 * AW-Differenzierung (noch kein Stammdatum) gilt für die MiSpeL-Viertelstunden der W4-Rückfall
 * "keine Prämie bei SP¼ &lt; 0" - die gespeicherte ÜNB-Liste trifft nicht, und die Summe ist
 * vorläufig. Derselbe Stand liefert dem Fahrplan-Twin ({@link SlotEconomics}) seine Basis über
 * {@link OptimizerDiagnosticsRepository#marktwertbasis}.
 *
 * <p>Handgerechnet, anzulegender Wert 10 ct, Monatsmarktwert Solar 5 ct, Jahresmarktwert Solar 2026
 * 7 ct, je Viertelstunde 10 kWh Einspeisung:
 *
 * <pre>
 *   Viertelstunde (Berlin)   Spot      MiSpeL-Anlage            andere Anlage
 *   30.09. 12:00             80 €/MWh  Monat: 10 × 5 ct = 0,50  10 × 5 ct = 0,50
 *   01.10. 12:00             80 €/MWh  Jahr:  10 × 3 ct = 0,30  10 × 5 ct = 0,50
 *   01.10. 12:15            -10 €/MWh  keine (Rückfall)         keine (§-51-Regel)
 *   Marktprämie                        0,80 €                   1,00 €
 *   Einspeiseerlös (Spot + Prämie)     1,30 + 1,10 − 0,10 = 2,30 €   1,30 + 1,30 − 0,10 = 2,50 €
 * </pre>
 */
@Testcontainers(disabledWithoutDocker = true)
class MarktwertbasisErloeseTest {

    private static final UUID TENANT = UUID.fromString("12000000-0000-0000-0000-000000000001");
    private static final UUID MISPEL = UUID.fromString("12000000-0000-0000-0000-0000000000a1");
    private static final UUID ANDERE = UUID.fromString("12000000-0000-0000-0000-0000000000b1");
    private static final Instant VON = OffsetDateTime.parse("2026-09-30T00:00:00+02:00").toInstant();
    private static final Instant BIS = OffsetDateTime.parse("2026-10-02T00:00:00+02:00").toInstant();
    private static final Offset<Double> CENT = Offset.offset(1e-9);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static EarningsRepository earnings;
    private static OptimizerDiagnosticsRepository diagnostics;

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

        JdbcTemplate su = new JdbcTemplate(new DriverManagerDataSource(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword()));
        su.update("INSERT INTO tenant (id, name) VALUES (?, 'Marktwertbasis')", TENANT);
        for (UUID site : new UUID[] {MISPEL, ANDERE}) {
            su.update("INSERT INTO site (id, tenant_id, name, bidding_zone, plant_kind,"
                    + " anzulegender_wert_ct_kwh, netzladen_erlaubt)"
                    + " VALUES (?, ?, ?, 'DE-LU', 'direktvermarktung', 10.0, FALSE)",
                    site, TENANT, site.equals(MISPEL) ? "MiSpeL-Anlage" : "andere Anlage");
            viertelstunde(su, site, "2026-09-30T12:00:00+02:00");
            viertelstunde(su, site, "2026-10-01T12:00:00+02:00");
            viertelstunde(su, site, "2026-10-01T12:15:00+02:00");
        }
        su.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis,"
                + " gueltig_ab, created_by) VALUES (?, ?, 'marktpraemie_abgrenzung', 'A1', TRUE, DATE '2026-10-01',"
                + " 'test')", TENANT, MISPEL);
        preis(su, "2026-09-30T12:00:00+02:00", 80.0);
        preis(su, "2026-10-01T12:00:00+02:00", 80.0);
        preis(su, "2026-10-01T12:15:00+02:00", -10.0);
        su.update("INSERT INTO monthly_market_value (month, technology, value_ct_kwh, provisional, source)"
                + " VALUES (DATE '2026-09-01', 'solar', 5.0, FALSE, 'test'),"
                + " (DATE '2026-10-01', 'solar', 5.0, FALSE, 'test')");
        su.update("INSERT INTO annual_market_value (year, technology, value_ct_kwh, provisional)"
                + " VALUES (2026, 'solar', 7.0, FALSE)");
        // Eine ÜNB-Liste liegt vor ("Nein" am 01.10. 12:00) - ohne AW-Differenzierung der Anlage
        // darf sie nicht greifen (Regel-Eingang NULL, W4-Rückfall).
        su.update("INSERT INTO eeg_aw_zeit (regel, ts, aufloesung, aw_groesser_null) VALUES"
                + " ('viertelstunde', ?, 'PT15M', FALSE)",
                Timestamp.from(OffsetDateTime.parse("2026-10-01T12:00:00+02:00").toInstant()));

        SingleConnectionDataSource app = new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_app", "pw_app", true);
        try (Connection c = app.getConnection();
                PreparedStatement ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, TENANT.toString());
            ps.execute();
        }
        OptimizerProperties props = new OptimizerProperties(4.0, 0.3, null, null, false);
        earnings = new EarningsRepository(new JdbcTemplate(app), props);
        diagnostics = new OptimizerDiagnosticsRepository(new JdbcTemplate(app));
    }

    private static void viertelstunde(JdbcTemplate su, UUID site, String beginn) {
        su.update("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh,"
                        + " grid_import_kwh, grid_export_kwh, n_samples) VALUES (?, ?, ?, 10, 0, 0, 10, 15)",
                Timestamp.from(OffsetDateTime.parse(beginn).toInstant()), TENANT, site);
    }

    private static void preis(JdbcTemplate su, String beginn, double eurMwh) {
        su.update("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source)"
                        + " VALUES (?, 'DE-LU', 'PT15M', ?, 'EUR', 'test')",
                Timestamp.from(OffsetDateTime.parse(beginn).toInstant()), eurMwh);
    }

    @Test
    void mispelAnlageMitJahresmarktwertAndereMitMonatsmarktwert() {
        SiteAggregate mispel = earnings.aggregateForSite(MISPEL, VON, BIS);
        SiteAggregate andere = earnings.aggregateForSite(ANDERE, VON, BIS);

        assertThat(mispel.coveredSlots()).isEqualTo(3);
        assertThat(andere.coveredSlots()).isEqualTo(3);
        assertThat(mispel.marktpraemieEur().doubleValue()).isCloseTo(0.50 + 0.30, CENT);
        assertThat(andere.marktpraemieEur().doubleValue()).isCloseTo(0.50 + 0.50, CENT);
        assertThat(mispel.einspeiseErloesEur().doubleValue()).isCloseTo(1.30 + 1.10 - 0.10, CENT);
        assertThat(andere.einspeiseErloesEur().doubleValue()).isCloseTo(1.30 + 1.30 - 0.10, CENT);
        // Ohne ÜNB-Liste für die Anlage: der Rückfall macht die Summe vorläufig; die andere Anlage
        // hat keinen MiSpeL-Tag, die Aussage entfällt.
        assertThat(mispel.marktpraemieVorlaeufig()).isTrue();
        assertThat(andere.marktpraemieVorlaeufig()).isNull();
        // Der Vergleichswert der Anzeige bleibt der Monatsdurchschnitt Solar (bis MP-18).
        assertThat(mispel.marketValueSolarCtKwh().doubleValue()).isCloseTo(5.0, CENT);
    }

    @Test
    void derFahrplanTwinBekommtDieselbeBasis() {
        Instant erste = OffsetDateTime.parse("2026-09-30T12:00:00+02:00").toInstant();
        Instant letzte = OffsetDateTime.parse("2026-10-01T12:15:00+02:00").toInstant();
        SlotEconomics.Marktwertbasis basis = diagnostics.marktwertbasis(MISPEL, erste, letzte);
        assertThat(basis.mispelTage()).isEqualTo(Set.of(LocalDate.of(2026, 10, 1)));
        assertThat(basis.jahresmarktwerte().get(2026).ctKwh()).isEqualTo(7.0);
        assertThat(basis.awGroesserNull()).isEmpty();
        assertThat(basis.awRegel()).isNull();
        assertThat(diagnostics.marktwertbasis(ANDERE, erste, letzte))
                .isSameAs(SlotEconomics.Marktwertbasis.KEINE);

        // Twin und SQL stimmen je Viertelstunde überein: 01.10. 12:00 -> 8 + 3 ct.
        var dv = new SlotEconomics.SiteEconomics("direktvermarktung", false, "ohne", null, 10.0,
                null, null, null, null, null);
        SlotEconomics twin = new SlotEconomics(dv, com.voltpilot.api.optimizer.EegRates.defaults(),
                Map.of(LocalDate.of(2026, 9, 1), new SlotEconomics.MarketValue(5.0, false),
                        LocalDate.of(2026, 10, 1), new SlotEconomics.MarketValue(5.0, false)))
                .mitMarktwertbasis(basis);
        assertThat(twin.exportValueCtKwh(80.0, erste)).isCloseTo(8.0 + 5.0, CENT);
        assertThat(twin.exportValueCtKwh(80.0, letzte.minusSeconds(900))).isCloseTo(8.0 + 3.0, CENT);
        assertThat(twin.exportValueCtKwh(-10.0, letzte)).isCloseTo(-1.0, CENT);
    }
}
