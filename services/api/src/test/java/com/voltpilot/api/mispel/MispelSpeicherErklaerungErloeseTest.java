package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.EarningsRepository.DailySaved;
import com.voltpilot.api.repo.EarningsRepository.MispelTagesmengen;
import com.voltpilot.api.repo.EarningsRepository.SiteAggregate;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
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
 * MiSpeL MP-18c (Bedienkonzept BK-W5 = A), der Prüfnachweis der Erlöse-Seite des Servers: drei
 * Anlagen mit denselben Viertelstunden zu denselben Preisen - eine ab 01.10.2026 in der
 * Abgrenzungsoption, eine in der Pauschaloption, die dritte ohne Fassung (Bestand).
 *
 * <p><b>Tagessummen</b> (1)¼ = MIN[Z1NB¼; Z2V¼] und (2)¼ = MIN[Z1NE¼; Z2E¼] (Anlage 1 S. 33-34),
 * aus den Gerätewerten der Viertelstunde, nur an MiSpeL-Tagen. <b>Marktprämie</b> an Tagen der
 * Abgrenzungsoption nur auf (23)¼ = Z1NE¼ − (2)¼, die Einspeisung direkt aus der PV (A1 S. 38);
 * die Pauschaloption (Anlage 2: Förderung je Kalenderjahr pauschal begrenzt) und die Anlage ohne
 * MiSpeL bleiben, wie sie waren.
 *
 * <p>Handgerechnet, anzulegender Wert 10 ct, Monatsmarktwert 5 ct, Jahresmarktwert 2026 7 ct,
 * Spot 80 €/MWh in jeder Viertelstunde:
 *
 * <pre>
 *   Viertelstunde (Berlin)  Netzbezug  Laden  Einspeisung  Entladen  (1)¼  (2)¼  (23)¼
 *   30.09. 19:00            0          0      10           12        -     -     -    (kein MiSpeL-Tag)
 *   01.10. 02:00            20         15     0            0         15    0     0
 *   01.10. 12:00            0          0      10           0         0     0     10
 *   01.10. 19:00            0          0      10           12        0     10    0
 *   Σ 01.10.                                                          15    10    10
 *
 *   Marktprämie 01.10.      Abgrenzung: 10 × 3 ct = 0,30 €   (vorher 20 × 3 ct = 0,60 €)
 *                           Pauschal:   20 × 3 ct = 0,60 €   andere: 20 × 5 ct = 1,00 €
 *   Einspeiseerlös 01.10.   Spot 20 × 8 ct = 1,60 € + Prämie
 * </pre>
 */
@Testcontainers(disabledWithoutDocker = true)
class MispelSpeicherErklaerungErloeseTest {

    private static final UUID TENANT = UUID.fromString("12c00000-0000-0000-0000-000000000001");
    private static final UUID ABGRENZUNG = UUID.fromString("12c00000-0000-0000-0000-0000000000a1");
    private static final UUID PAUSCHAL = UUID.fromString("12c00000-0000-0000-0000-0000000000b1");
    private static final UUID ANDERE = UUID.fromString("12c00000-0000-0000-0000-0000000000c1");
    private static final Instant VORTAG = OffsetDateTime.parse("2026-09-30T00:00:00+02:00").toInstant();
    private static final Instant TAG = OffsetDateTime.parse("2026-10-01T00:00:00+02:00").toInstant();
    private static final Instant FOLGETAG = OffsetDateTime.parse("2026-10-02T00:00:00+02:00").toInstant();
    private static final Offset<Double> CENT = Offset.offset(1e-9);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static EarningsRepository earnings;

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
        su.update("INSERT INTO tenant (id, name) VALUES (?, 'Speicher-Erklärung')", TENANT);
        for (UUID site : new UUID[] {ABGRENZUNG, PAUSCHAL, ANDERE}) {
            su.update("INSERT INTO site (id, tenant_id, name, bidding_zone, plant_kind,"
                    + " anzulegender_wert_ct_kwh, netzladen_erlaubt)"
                    + " VALUES (?, ?, ?, 'DE-LU', 'direktvermarktung', 10.0, TRUE)",
                    site, TENANT, site.toString());
            viertelstunde(su, site, "2026-09-30T19:00:00+02:00", 0, 0, 10, 12, 0, 2);
            viertelstunde(su, site, "2026-10-01T02:00:00+02:00", 20, 15, 0, 0, 0, 5);
            viertelstunde(su, site, "2026-10-01T12:00:00+02:00", 0, 0, 10, 0, 10, 0);
            viertelstunde(su, site, "2026-10-01T19:00:00+02:00", 0, 0, 10, 12, 0, 2);
        }
        su.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, formelsatz, einverstaendnis,"
                + " gueltig_ab, created_by) VALUES (?, ?, 'marktpraemie_abgrenzung', 'A1', TRUE, DATE '2026-10-01',"
                + " 'test')", TENANT, ABGRENZUNG);
        su.update("INSERT INTO site_foerderweg (tenant_id, site_id, foerderweg, einverstaendnis,"
                + " gueltig_ab, created_by) VALUES (?, ?, 'marktpraemie_pauschal', TRUE, DATE '2026-10-01',"
                + " 'test')", TENANT, PAUSCHAL);
        for (String beginn : List.of("2026-09-30T19:00:00+02:00", "2026-10-01T02:00:00+02:00",
                "2026-10-01T12:00:00+02:00", "2026-10-01T19:00:00+02:00")) {
            su.update("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency,"
                    + " source) VALUES (?, 'DE-LU', 'PT15M', 80.0, 'EUR', 'test')",
                    Timestamp.from(OffsetDateTime.parse(beginn).toInstant()));
        }
        su.update("INSERT INTO monthly_market_value (month, technology, value_ct_kwh, provisional, source)"
                + " VALUES (DATE '2026-09-01', 'solar', 5.0, FALSE, 'test'),"
                + " (DATE '2026-10-01', 'solar', 5.0, FALSE, 'test')");
        su.update("INSERT INTO annual_market_value (year, technology, value_ct_kwh, provisional)"
                + " VALUES (2026, 'solar', 7.0, FALSE)");

        SingleConnectionDataSource app = new SingleConnectionDataSource(
                POSTGRES.getJdbcUrl(), "voltpilot_app", "pw_app", true);
        try (Connection c = app.getConnection();
                PreparedStatement ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, TENANT.toString());
            ps.execute();
        }
        earnings = new EarningsRepository(new JdbcTemplate(app),
                new OptimizerProperties(4.0, 0.3, null, null, false));
    }

    private static void viertelstunde(JdbcTemplate su, UUID site, String beginn, double netzbezug,
            double laden, double einspeisung, double entladen, double pv, double last) {
        su.update("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, load_kwh,"
                        + " grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh,"
                        + " n_samples) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 15)",
                Timestamp.from(OffsetDateTime.parse(beginn).toInstant()), TENANT, site, pv, last,
                netzbezug, einspeisung, laden, entladen);
    }

    @Test
    void dieTagessummenSindDieViertelstundenMinimaNurAnMispelTagen() {
        MispelTagesmengen abgrenzung = earnings.mispelTagesmengenForSite(ABGRENZUNG, TAG, FOLGETAG);
        assertThat(abgrenzung.netzstromverbrauchSpeicherKwh().doubleValue()).isCloseTo(15.0, CENT);
        assertThat(abgrenzung.netzeinspeisungSpeicherKwh().doubleValue()).isCloseTo(10.0, CENT);
        assertThat(abgrenzung.quelle()).isEqualTo(MispelTagesmengen.GERAET);
        // Die Pauschaloption hat keinen Speicherzähler - dieselben Gerätewerte, so gekennzeichnet.
        MispelTagesmengen pauschal = earnings.mispelTagesmengenForSite(PAUSCHAL, TAG, FOLGETAG);
        assertThat(pauschal.netzstromverbrauchSpeicherKwh().doubleValue()).isCloseTo(15.0, CENT);
        assertThat(pauschal.netzeinspeisungSpeicherKwh().doubleValue()).isCloseTo(10.0, CENT);
        assertThat(pauschal.quelle()).isEqualTo(MispelTagesmengen.GERAET);
        // Kein MiSpeL-Tag: weder die Anlage ohne Fassung noch der Tag vor dem Fassungstag.
        assertThat(earnings.mispelTagesmengenForSite(ANDERE, TAG, FOLGETAG)).isNull();
        assertThat(earnings.mispelTagesmengenForSite(ABGRENZUNG, VORTAG, TAG)).isNull();
        // Flottenweit dieselben Zahlen, nur für die beiden MiSpeL-Anlagen.
        assertThat(earnings.mispelTagesmengen(TAG, FOLGETAG)).containsOnlyKeys(ABGRENZUNG, PAUSCHAL);
    }

    @Test
    void anTagenDerAbgrenzungsoptionZaehltDiePraemieNurAufDieEinspeisungDirektAusDerPv() {
        SiteAggregate abgrenzung = earnings.aggregateForSite(ABGRENZUNG, TAG, FOLGETAG);
        SiteAggregate pauschal = earnings.aggregateForSite(PAUSCHAL, TAG, FOLGETAG);
        SiteAggregate andere = earnings.aggregateForSite(ANDERE, TAG, FOLGETAG);

        assertThat(abgrenzung.coveredSlots()).isEqualTo(3);
        // (23)¼ = Z1NE¼ − (2)¼: 10 kWh um 12:00, 0 kWh um 19:00 → 10 × 3 ct.
        assertThat(abgrenzung.marktpraemieEur().doubleValue()).isCloseTo(0.30, CENT);
        assertThat(abgrenzung.einspeiseErloesEur().doubleValue()).isCloseTo(1.60 + 0.30, CENT);
        // Pauschaloption und Bestand: Prämie auf jede Einspeisung wie bisher.
        assertThat(pauschal.marktpraemieEur().doubleValue()).isCloseTo(0.60, CENT);
        assertThat(pauschal.einspeiseErloesEur().doubleValue()).isCloseTo(1.60 + 0.60, CENT);
        assertThat(andere.marktpraemieEur().doubleValue()).isCloseTo(1.00, CENT);
        assertThat(andere.einspeiseErloesEur().doubleValue()).isCloseTo(1.60 + 1.00, CENT);

        // Die Identitäten bleiben: stromkosten − einspeise == actual, saved == baseline − actual.
        for (UUID site : new UUID[] {ABGRENZUNG, PAUSCHAL, ANDERE}) {
            SiteAggregate a = earnings.aggregateForSite(site, TAG, FOLGETAG);
            assertThat(a.stromkostenEur().subtract(a.einspeiseErloesEur()).doubleValue())
                    .as(site.toString()).isCloseTo(a.actualEur().doubleValue(), CENT);
            DailySaved tag = earnings.dailySavedPerSite(TAG, FOLGETAG).get(site).stream()
                    .filter(d -> d.day().equals(LocalDate.of(2026, 10, 1))).findFirst().orElseThrow();
            assertThat(tag.savedEur().doubleValue()).as(site.toString())
                    .isCloseTo(a.baselineEur().subtract(a.actualEur()).doubleValue(), CENT);
        }
        // Die Speichereinspeisung kostet die Abgrenzungs-Anlage genau ihre Prämie: 10 kWh × 3 ct.
        assertThat(pauschal.actualEur().subtract(abgrenzung.actualEur()).doubleValue())
                .isCloseTo(-0.30, CENT);
    }

    @Test
    void vorDemFassungstagIstDieAbgrenzungsAnlageBitgleichMitDerAnderen() {
        SiteAggregate abgrenzung = earnings.aggregateForSite(ABGRENZUNG, VORTAG, TAG);
        SiteAggregate andere = earnings.aggregateForSite(ANDERE, VORTAG, TAG);
        assertThat(abgrenzung.marktpraemieEur()).isEqualByComparingTo(andere.marktpraemieEur());
        assertThat(abgrenzung.einspeiseErloesEur()).isEqualByComparingTo(andere.einspeiseErloesEur());
        assertThat(abgrenzung.actualEur()).isEqualByComparingTo(andere.actualEur());
        assertThat(abgrenzung.marktpraemieEur().doubleValue()).isCloseTo(10 * 0.05, CENT);
    }
}
