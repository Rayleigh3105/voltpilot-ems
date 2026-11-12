package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Instant;
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
 * S5 (vp-mastr-mehrere-einheiten-konzept §6/§8): die vier Hinweis-Kategorien
 * des Plattform-Admin "Register-Abgleich" gegen ein echtes TimescaleDB, als
 * BYPASSRLS {@code voltpilot_admin} - dasselbe leichte Muster wie
 * {@link FleetLastPlanRewriteEqualityTest}, ohne den vollen Spring-Kontext.
 *
 * <p>Zwei Mandanten, vier Anlagen, jede genau EINER Kategorie zugeordnet, plus
 * eine völlig unauffällige fünfte Anlage als Gegenprobe gegen falsch-positive
 * Treffer.
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class AdminRegisterAbgleichRepositoryTest {

    private static final UUID TENANT_A = UUID.fromString("aaaaaaaa-0000-0000-0000-000000000002");
    private static final UUID TENANT_B = UUID.fromString("bbbbbbbb-0000-0000-0000-000000000002");
    /** Ohne Register: PV gepflegt, nie mit MaStR verknüpft. */
    private static final UUID SITE_OHNE_REGISTER = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000b1");
    /** Messung über der Summe: 8 kW Spitze bei 5 kWp bestätigt. */
    private static final UUID SITE_MESSUNG = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000b2");
    /** Register geändert seit Übernahme: r_leistung_kwp weicht ab. */
    private static final UUID SITE_GEAENDERT = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000b3");
    /** Nummer an zwei Anlagen: dieselbe registry_unit_id wie SITE_NUMMER_B. */
    private static final UUID SITE_NUMMER_A = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000b4");
    private static final UUID SITE_NUMMER_B = UUID.fromString("bbbbbbbb-0000-0000-0000-0000000000b5");
    /** Unauffällig: eine saubere, einzelne, bestätigte Einheit ohne jeden Hinweis. */
    private static final UUID SITE_SAUBER = UUID.fromString("aaaaaaaa-0000-0000-0000-0000000000b6");

    private static final Instant NOW = Instant.parse("2026-06-01T12:00:00Z");

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
            tenant(c, TENANT_A, "Tenant A");
            tenant(c, TENANT_B, "Tenant B");
            site(c, SITE_OHNE_REGISTER, TENANT_A, "Ohne Register");
            site(c, SITE_MESSUNG, TENANT_A, "Messung ueber Summe");
            site(c, SITE_GEAENDERT, TENANT_A, "Register geaendert");
            site(c, SITE_NUMMER_A, TENANT_A, "Nummer A");
            site(c, SITE_NUMMER_B, TENANT_B, "Nummer B");
            site(c, SITE_SAUBER, TENANT_A, "Sauber");

            asset(c, SITE_OHNE_REGISTER, TENANT_A, 10.0);

            registerEinheit(c, SITE_MESSUNG, TENANT_A, "SEE100000000001", 5.0, 5.0);
            peakBuckets(c, SITE_MESSUNG, TENANT_A, 2.0, 96); // 2.0 kWh/15min = 8 kW Spitze

            registerEinheit(c, SITE_GEAENDERT, TENANT_A, "SEE100000000002", 6.0, 6.0);
            try (PreparedStatement ps = c.prepareStatement(
                    "UPDATE register_einheit SET r_leistung_kwp = 7.0 WHERE site_id = ?")) {
                ps.setObject(1, SITE_GEAENDERT);
                ps.execute();
            }

            registerEinheit(c, SITE_NUMMER_A, TENANT_A, "SEE100000000003", 4.0, 4.0);
            registerEinheit(c, SITE_NUMMER_B, TENANT_B, "SEE100000000003", 4.0, 4.0);

            registerEinheit(c, SITE_SAUBER, TENANT_A, "SEE100000000004", 5.0, 5.0);
            peakBuckets(c, SITE_SAUBER, TENANT_A, 1.2, 96); // 4,8 kW - unter 5 kWp
        }
    }

    @Test
    void messungUeberSummeFindetNurDieEineAuffaelligeAnlage() throws Exception {
        try (SingleConnectionDataSource ds = adminRole()) {
            List<AdminRegisterAbgleichRepository.Zeile> rows =
                    new AdminRegisterAbgleichRepository(new JdbcTemplate(ds))
                            .messungUeberSumme(NOW.minusSeconds(30L * 86400));
            assertThat(rows).extracting(AdminRegisterAbgleichRepository.Zeile::siteId)
                    .containsExactly(SITE_MESSUNG);
            assertThat(rows.get(0).tenantId()).isEqualTo(TENANT_A);
            assertThat(rows.get(0).hinweis()).contains("8,0 kW").contains("5,0 kWp");
        }
    }

    @Test
    void registerGeaendertSeitUebernahmeFindetNurDieAbweichendeEinheit() throws Exception {
        try (SingleConnectionDataSource ds = adminRole()) {
            List<AdminRegisterAbgleichRepository.Zeile> rows =
                    new AdminRegisterAbgleichRepository(new JdbcTemplate(ds))
                            .registerGeaendertSeitUebernahme();
            assertThat(rows).extracting(AdminRegisterAbgleichRepository.Zeile::siteId)
                    .containsExactly(SITE_GEAENDERT);
        }
    }

    @Test
    void nummerAnZweiAnlagenFindetBeideSeitenUeberTenantsHinweg() throws Exception {
        try (SingleConnectionDataSource ds = adminRole()) {
            List<AdminRegisterAbgleichRepository.Zeile> rows =
                    new AdminRegisterAbgleichRepository(new JdbcTemplate(ds)).nummerAnZweiAnlagen();
            assertThat(rows).extracting(AdminRegisterAbgleichRepository.Zeile::siteId, AdminRegisterAbgleichRepository.Zeile::tenantId)
                    .containsExactlyInAnyOrder(
                            tuple(SITE_NUMMER_A, TENANT_A), tuple(SITE_NUMMER_B, TENANT_B));
        }
    }

    @Test
    void ohneRegisterFindetNurDieAnlageOhneJedeEinheit() throws Exception {
        try (SingleConnectionDataSource ds = adminRole()) {
            List<AdminRegisterAbgleichRepository.Zeile> rows =
                    new AdminRegisterAbgleichRepository(new JdbcTemplate(ds)).ohneRegister();
            assertThat(rows).extracting(AdminRegisterAbgleichRepository.Zeile::siteId)
                    .containsExactly(SITE_OHNE_REGISTER);
        }
    }

    @Test
    void dieSaubereAnlageTrifftKeineEinzigeKategorie() throws Exception {
        try (SingleConnectionDataSource ds = adminRole()) {
            AdminRegisterAbgleichRepository repo = new AdminRegisterAbgleichRepository(new JdbcTemplate(ds));
            List<UUID> alleTreffer = java.util.stream.Stream.of(
                            repo.messungUeberSumme(NOW.minusSeconds(30L * 86400)),
                            repo.registerGeaendertSeitUebernahme(),
                            repo.nummerAnZweiAnlagen(),
                            repo.ohneRegister())
                    .flatMap(List::stream)
                    .map(AdminRegisterAbgleichRepository.Zeile::siteId)
                    .toList();
            assertThat(alleTreffer).doesNotContain(SITE_SAUBER);
        }
    }

    // ---- helpers ------------------------------------------------------------

    private static javax.sql.DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

    /** ONE connection as the BYPASSRLS {@code voltpilot_admin} role. */
    private static SingleConnectionDataSource adminRole() {
        return new SingleConnectionDataSource(POSTGRES.getJdbcUrl(), "voltpilot_admin", "pw_admin", true);
    }

    private static void tenant(Connection c, UUID id, String name) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO tenant (id, name) VALUES (?, ?) ON CONFLICT DO NOTHING")) {
            ps.setObject(1, id);
            ps.setString(2, name);
            ps.execute();
        }
    }

    private static void site(Connection c, UUID id, UUID tenant, String name) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')")) {
            ps.setObject(1, id);
            ps.setObject(2, tenant);
            ps.setString(3, name);
            ps.execute();
        }
    }

    private static void asset(Connection c, UUID site, UUID tenant, double pvCapacityKwp) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES (?, ?, 'pv', ?)")) {
            ps.setObject(1, tenant);
            ps.setObject(2, site);
            ps.setDouble(3, pvCapacityKwp);
            ps.execute();
        }
    }

    private static void registerEinheit(Connection c, UUID site, UUID tenant, String registryUnitId,
            double leistungKwp, double rLeistungKwp) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO register_einheit (tenant_id, site_id, art, registry_unit_id, "
                        + "inbetriebnahme, leistung_kwp, r_inbetriebnahme, r_leistung_kwp, bestaetigt_am) "
                        + "VALUES (?, ?, 'pv', ?, '2020-01-01', ?, '2020-01-01', ?, now())")) {
            ps.setObject(1, tenant);
            ps.setObject(2, site);
            ps.setString(3, registryUnitId);
            ps.setDouble(4, leistungKwp);
            ps.setDouble(5, rLeistungKwp);
            ps.execute();
        }
    }

    private static void peakBuckets(Connection c, UUID site, UUID tenant, double pvKwhPerBucket, int buckets)
            throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, n_samples) "
                        + "SELECT ?::timestamptz - (n || ' minutes')::interval, ?, ?, ?, 1 "
                        + "FROM generate_series(0, (? - 1) * 15, 15) AS n")) {
            ps.setTimestamp(1, java.sql.Timestamp.from(NOW));
            ps.setObject(2, tenant);
            ps.setObject(3, site);
            ps.setDouble(4, pvKwhPerBucket);
            ps.setInt(5, buckets);
            ps.execute();
        }
    }
}
