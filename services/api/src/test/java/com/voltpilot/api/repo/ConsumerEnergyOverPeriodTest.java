package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
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
 * Der gemessene Verbrauch eines Verbrauchers aus einem Zählerstand-Kanal
 * ({@link ConsumerRequirementStateRepository#energyOverPeriod}, {@code integrated=false}) -
 * AP-08 IP-21, Befund W9.
 *
 * <p>Bis zu diesem Paket rechnete der Ledger {@code max(value) - min(value)}. Das stimmt nur,
 * solange der Zähler monoton steigt: ein Zähler, der auf 950 läuft und bei 5 neu anfängt,
 * ergab 945 statt 57 - plausibel aussehend und um den Faktor 16 falsch. Die alte Abfrage
 * steht hier wörtlich als Orakel: sie belegt, was vorher herauskam, und dass der Normalfall
 * ohne Rücksprung unverändert bleibt.
 *
 * <p>Gegen echte TimescaleDB, als RLS-Rolle {@code voltpilot_app}. Überspringt sich ohne
 * Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class ConsumerEnergyOverPeriodTest {

    /**
     * Die Rechnung, wie sie bis AP-08 IP-21 ausgeliefert war - das Orakel. Ausgeliefert war sie
     * zusätzlich mit der UUID als Parameter und scheiterte damit an {@code text = uuid}
     * ({@link #dieUuidAlsParameterScheitertAnDerTextspalte}); das Orakel bindet Text, damit es
     * die alte ARITHMETIK zeigt.
     */
    private static final String MAX_MINUS_MIN =
            "SELECT max(value) - min(value) AS kwh FROM telemetry_v2 "
                    + "WHERE entity_id = ? AND channel = ? AND time >= ? AND time < ?";

    private static final UUID TENANT = UUID.fromString("dddddddd-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("dddddddd-0000-0000-0000-0000000000a1");
    private static final UUID DEVICE = UUID.fromString("dddddddd-0000-0000-0000-0000000000d1");

    private static final UUID E_RUECKSPRUNG = UUID.fromString("dddddddd-0000-0000-0000-0000000000e1");
    private static final UUID E_MONOTON = UUID.fromString("dddddddd-0000-0000-0000-0000000000e2");
    private static final UUID E_ZWEI_RUECKSPRUENGE =
            UUID.fromString("dddddddd-0000-0000-0000-0000000000e3");
    private static final UUID E_EIN_STAND = UUID.fromString("dddddddd-0000-0000-0000-0000000000e4");
    private static final UUID E_LEER = UUID.fromString("dddddddd-0000-0000-0000-0000000000e5");
    private static final UUID E_RAUSCHEN = UUID.fromString("dddddddd-0000-0000-0000-0000000000e6");
    private static final UUID E_LEISTUNG = UUID.fromString("dddddddd-0000-0000-0000-0000000000e7");

    private static final String KANAL = "energy_kwh";
    private static final Instant VON = Instant.parse("2026-09-10T00:00:00Z");
    private static final Instant BIS = Instant.parse("2026-09-11T00:00:00Z");

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

        try (Connection c = superuser().getConnection()) {
            stammdaten(c);
            // Der Prüfwert des Reports: 898 -> 950 (+52), mittags Rücksetzung, weiter bis 5 (+5).
            reihe(c, E_RUECKSPRUNG, 898.0, 925.0, 950.0, 5.0);
            // Normalfall: monoton, mit Fließkomma-Ständen - die Reparatur darf ihn nicht verschieben.
            reihe(c, E_MONOTON, 1234.567, 1234.9, 1240.125, 1240.125, 1251.3, 1263.071);
            // Zwei Rücksprünge: 100 -> 150 (+50), neu 3 -> 20 (+20), neu 2 -> 10 (+10).
            reihe(c, E_ZWEI_RUECKSPRUENGE, 100.0, 150.0, 3.0, 20.0, 2.0, 10.0);
            reihe(c, E_EIN_STAND, 777.0);
            // Ein kleiner Rückschritt (Rundung/erneute Meldung) ist KEINE Rücksetzung.
            reihe(c, E_RAUSCHEN, 500.0, 510.0, 509.99, 520.0);
            // Außerhalb der Periode - darf nicht mitzählen.
            wert(c, E_RUECKSPRUNG, BIS, 1.0);
            wert(c, E_LEER, VON.minusSeconds(60), 42.0);
            // Leistungskanal: 2 kW, 2 kW, 4 kW im Stundentakt -> 2 + 2 = 4 kWh (links-Riemann).
            for (int i = 0; i < 3; i++) {
                wert(c, E_LEISTUNG, "power_kw", VON.plusSeconds(3600L * i), i < 2 ? 2.0 : 4.0);
            }
        }
    }

    /** Der benannte Prüfwert aus AP-08 §8 IP-21: 950 -> 5 ergibt 57, nicht 945. */
    @Test
    void einZaehlerDerBei950ZurueckspringtErgibt57Statt945() throws Exception {
        try (SingleConnectionDataSource ds = appRole()) {
            assertThat(orakel(ds, E_RUECKSPRUNG)).as("alte Rechnung max - min")
                    .isEqualByComparingTo("945");
            assertThat(neu(ds, E_RUECKSPRUNG)).as("Summe der Zuwächse mit Rücksetzung")
                    .isEqualByComparingTo("57");
        }
    }

    /** Ohne Rücksprung liefert die neue Rechnung exakt dieselbe Zahl wie die alte. */
    @Test
    void ohneRuecksprungBleibtDerWertUnveraendert() throws Exception {
        try (SingleConnectionDataSource ds = appRole()) {
            BigDecimal alt = orakel(ds, E_MONOTON);
            assertThat(alt).isNotNull();
            assertThat(neu(ds, E_MONOTON)).isEqualTo(alt);
            // Ein Rückschritt im Rauschen bleibt beim alten Wert (520 - 500).
            assertThat(neu(ds, E_RAUSCHEN)).isEqualTo(orakel(ds, E_RAUSCHEN))
                    .isEqualByComparingTo("20");
        }
    }

    @Test
    void zweiRuecksprungeZaehlenJedenNeuanfangAbNull() throws Exception {
        try (SingleConnectionDataSource ds = appRole()) {
            assertThat(orakel(ds, E_ZWEI_RUECKSPRUENGE)).isEqualByComparingTo("148");
            assertThat(neu(ds, E_ZWEI_RUECKSPRUENGE)).isEqualByComparingTo("80");
        }
    }

    /** Ein einzelner Stand hat keinen Zuwachs: 0, wie bisher. */
    @Test
    void einEinzelnerStandErgibtNull() throws Exception {
        try (SingleConnectionDataSource ds = appRole()) {
            assertThat(neu(ds, E_EIN_STAND)).isEqualByComparingTo("0")
                    .isEqualByComparingTo(orakel(ds, E_EIN_STAND));
        }
    }

    /** Keine Telemetrie in der Periode: null (der Writer stuft auf „angenommen“ ab), nie 0. */
    @Test
    void einLeererZeitraumErgibtKeineZahl() throws Exception {
        try (SingleConnectionDataSource ds = appRole()) {
            assertThat(orakel(ds, E_LEER)).isNull();
            assertThat(neu(ds, E_LEER)).isNull();
        }
    }

    /**
     * Die ausgelieferte Form band die UUID als UUID - gegen die TEXT-Spalte scheitert das, der
     * Writer loggte nur eine Warnung und schrieb den Ledger der Anlage nicht. Diese Probe hält
     * fest, dass die Text-Bindung der Reparatur nötig ist.
     */
    @Test
    void dieUuidAlsParameterScheitertAnDerTextspalte() throws Exception {
        try (SingleConnectionDataSource ds = appRole()) {
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> new JdbcTemplate(ds).query(
                            MAX_MINUS_MIN, (rs, i) -> rs.getBigDecimal("kwh"),
                            E_RUECKSPRUNG, KANAL, Timestamp.from(VON), Timestamp.from(BIS)))
                    .rootCause().hasMessageContaining("text = uuid");
        }
    }

    /** Der Leistungskanal (integriert) teilt die Bindung und liefert jetzt seine Zahl. */
    @Test
    void einLeistungskanalWirdIntegriert() throws Exception {
        try (SingleConnectionDataSource ds = appRole()) {
            assertThat(new ConsumerRequirementStateRepository(new JdbcTemplate(ds))
                    .energyOverPeriod(E_LEISTUNG, "power_kw", VON, BIS, true))
                    .isEqualByComparingTo("4");
        }
    }

    // ---- Helfer -------------------------------------------------------------

    private static BigDecimal neu(DataSource ds, UUID entity) {
        return new ConsumerRequirementStateRepository(new JdbcTemplate(ds))
                .energyOverPeriod(entity, KANAL, VON, BIS, false);
    }

    private static BigDecimal orakel(DataSource ds, UUID entity) {
        List<BigDecimal> rows = new JdbcTemplate(ds).query(MAX_MINUS_MIN,
                (rs, i) -> rs.getBigDecimal("kwh"),
                entity.toString(), KANAL, Timestamp.from(VON), Timestamp.from(BIS));
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

    /** EINE Verbindung als RLS-Rolle mit gesetztem Mandanten. */
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

    private static void stammdaten(Connection c) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO tenant (id, name) VALUES (?, 'Ledger') ON CONFLICT DO NOTHING")) {
            ps.setObject(1, TENANT);
            ps.execute();
        }
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Ledger', 'DE-LU')")) {
            ps.setObject(1, SITE);
            ps.setObject(2, TENANT);
            ps.execute();
        }
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO device (id, tenant_id, site_id, external_ref, kind) "
                        + "VALUES (?, ?, ?, 'ref-ledger', 'inverter')")) {
            ps.setObject(1, DEVICE);
            ps.setObject(2, TENANT);
            ps.setObject(3, SITE);
            ps.execute();
        }
    }

    /** Stände im Stundentakt ab Periodenbeginn. */
    private static void reihe(Connection c, UUID entity, double... staende) throws Exception {
        for (int i = 0; i < staende.length; i++) {
            wert(c, entity, VON.plusSeconds(3600L * i), staende[i]);
        }
    }

    private static void wert(Connection c, UUID entity, Instant time, double value) throws Exception {
        wert(c, entity, KANAL, time, value);
    }

    private static void wert(Connection c, UUID entity, String kanal, Instant time, double value)
            throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                        + "entity_id, channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")) {
            ps.setTimestamp(1, Timestamp.from(time));
            ps.setTimestamp(2, Timestamp.from(time));
            ps.setObject(3, TENANT);
            ps.setObject(4, SITE);
            ps.setObject(5, DEVICE);
            ps.setString(6, entity.toString());
            ps.setString(7, kanal);
            ps.setDouble(8, value);
            ps.execute();
        }
    }
}
