package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.entities.LeadDeviceService.FuehrendeBox;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
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
 * {@code GET /devices} fragt die führende Box seit vp-perf-kundenpfade-api mit drei Abfragen für alle
 * Anlagen statt mit drei je Anlage. Dieser Test beweist an einer echten TimescaleDB unter der
 * RLS-Rolle der App, dass die Massen-Abfragen ({@link EntityRegistryRepository#siteDeviceIds(java.util.Collection)},
 * {@link EntityRegistryRepository#batteryDeviceIds}, {@link EntityRegistryRepository#storedLeadDeviceIds})
 * je Anlage genau das liefern, was ihre Einzel-Gegenstücke liefern, und dass
 * {@link LeadDeviceService#fuehrendeBoxen} je Anlage dieselbe Box und denselben Grund ergibt wie
 * {@link LeadDeviceService#fuehrendeBox} - über alle Welten der Ableitung, eine ausgebaute Box, die
 * Reihenfolge nach {@code created_at} und den Mandantenzaun (eine fremde Anlage bleibt unsichtbar).
 *
 * <p>Läuft nur mit Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class FuehrendeBoxenGleichheitTest {

    private static final UUID TENANT_A = UUID.fromString("aaaaaaaa-0000-0000-0000-00000000000a");
    private static final UUID TENANT_B = UUID.fromString("bbbbbbbb-0000-0000-0000-00000000000b");

    /** Speicher an Box 1, zwei Boxen (A9). */
    private static final UUID S_SPEICHER = id("a1");
    /** Eine Box, kein Speicher. */
    private static final UUID S_EINZIG = id("a2");
    /** Zwei Boxen, kein Speicher, keine Wahl. */
    private static final UUID S_KEINE_WAHL = id("a3");
    /** Gespeicherte Wahl auf die zweite Box. */
    private static final UUID S_GEWAEHLT = id("a4");
    /** Gespeicherte Wahl auf eine Box ausserhalb der Anlage. */
    private static final UUID S_WAHL_FREMD = id("a5");
    /** Keine Box, Speicher ohne Gerät. */
    private static final UUID S_LEER = id("a6");
    /** Eine ausgebaute und eine aktive Box, der Speicher an der ausgebauten. */
    private static final UUID S_AUSGEBAUT = id("a7");
    /** Fremder Mandant. */
    private static final UUID S_FREMD = id("b1");

    private static final Instant T0 = Instant.parse("2026-10-01T08:00:00Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static UUID id(String suffix) {
        return UUID.fromString("00000000-0000-0000-0000-0000000000" + suffix);
    }

    private static UUID box(UUID site, int n) {
        return UUID.nameUUIDFromBytes((site + "-box-" + n).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

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
            for (UUID s : List.of(S_SPEICHER, S_EINZIG, S_KEINE_WAHL, S_GEWAEHLT, S_WAHL_FREMD, S_LEER, S_AUSGEBAUT)) {
                exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')",
                        s, TENANT_A, "Anlage " + s);
            }
            exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Fremd', 'DE-LU')",
                    S_FREMD, TENANT_B);
            // Zweite Box ZUERST eingefügt, aber später angelegt: die Reihenfolge kommt aus created_at, nicht
            // aus der Einfügefolge.
            device(c, box(S_SPEICHER, 2), TENANT_A, S_SPEICHER, T0.plusSeconds(60), null);
            device(c, box(S_SPEICHER, 1), TENANT_A, S_SPEICHER, T0, null);
            battery(c, S_SPEICHER, TENANT_A, box(S_SPEICHER, 1));
            device(c, box(S_EINZIG, 1), TENANT_A, S_EINZIG, T0, null);
            device(c, box(S_KEINE_WAHL, 1), TENANT_A, S_KEINE_WAHL, T0, null);
            device(c, box(S_KEINE_WAHL, 2), TENANT_A, S_KEINE_WAHL, T0, null); // gleiche Zeit: id entscheidet
            device(c, box(S_GEWAEHLT, 1), TENANT_A, S_GEWAEHLT, T0, null);
            device(c, box(S_GEWAEHLT, 2), TENANT_A, S_GEWAEHLT, T0.plusSeconds(1), null);
            exec(c, "UPDATE site SET lead_device_id = ? WHERE id = ?", box(S_GEWAEHLT, 2), S_GEWAEHLT);
            device(c, box(S_WAHL_FREMD, 1), TENANT_A, S_WAHL_FREMD, T0, null);
            exec(c, "UPDATE site SET lead_device_id = ? WHERE id = ?", box(S_EINZIG, 1), S_WAHL_FREMD);
            battery(c, S_LEER, TENANT_A, null);
            device(c, box(S_AUSGEBAUT, 1), TENANT_A, S_AUSGEBAUT, T0, T0.plusSeconds(3600));
            device(c, box(S_AUSGEBAUT, 2), TENANT_A, S_AUSGEBAUT, T0.plusSeconds(10), null);
            battery(c, S_AUSGEBAUT, TENANT_A, box(S_AUSGEBAUT, 1));
            device(c, box(S_FREMD, 1), TENANT_B, S_FREMD, T0, null);
            battery(c, S_FREMD, TENANT_B, box(S_FREMD, 1));
        }
    }

    @Test
    void massenAbfragenLiefernJeAnlageDasselbeWieDieEinzelabfragen() throws Exception {
        EntityRegistryRepository repo = new EntityRegistryRepository(new JdbcTemplate(appRole(TENANT_A)));
        List<UUID> anlagen = List.of(S_SPEICHER, S_EINZIG, S_KEINE_WAHL, S_GEWAEHLT, S_WAHL_FREMD, S_LEER,
                S_AUSGEBAUT, S_FREMD);

        Map<UUID, List<UUID>> boxen = repo.siteDeviceIds(anlagen);
        Map<UUID, UUID> speicher = repo.batteryDeviceIds(anlagen);
        Map<UUID, UUID> wahl = repo.storedLeadDeviceIds(anlagen);
        for (UUID s : anlagen) {
            assertThat(boxen.getOrDefault(s, List.of())).as("Boxen %s", s).isEqualTo(repo.siteDeviceIds(s));
            var einzeln = repo.batteryAsset(s);
            assertThat(speicher.get(s)).as("Speicher-Box %s", s)
                    .isEqualTo(einzeln == null ? null : einzeln.deviceId());
            assertThat(wahl.get(s)).as("Wahl %s", s).isEqualTo(repo.storedLeadDeviceId(s));
        }
        // Stichproben, damit die Gleichheit nicht an zwei leeren Seiten hängt.
        assertThat(boxen.get(S_SPEICHER)).containsExactly(box(S_SPEICHER, 1), box(S_SPEICHER, 2));
        assertThat(boxen.get(S_AUSGEBAUT)).containsExactly(box(S_AUSGEBAUT, 2));
        assertThat(speicher).containsEntry(S_AUSGEBAUT, box(S_AUSGEBAUT, 1)).doesNotContainKey(S_LEER);
        // Mandantenzaun: die fremde Anlage ist in keiner Massen-Abfrage zu sehen.
        assertThat(boxen).doesNotContainKey(S_FREMD);
        assertThat(speicher).doesNotContainKey(S_FREMD);
        assertThat(wahl).doesNotContainKey(S_FREMD);
    }

    @Test
    void fuehrendeBoxenErgibtJeAnlageDieBoxUndDenGrundDesEinzelaufrufs() throws Exception {
        LeadDeviceService dienst = new LeadDeviceService(
                new EntityRegistryRepository(new JdbcTemplate(appRole(TENANT_A))));
        List<UUID> anlagen = List.of(S_SPEICHER, S_EINZIG, S_KEINE_WAHL, S_GEWAEHLT, S_WAHL_FREMD, S_LEER,
                S_AUSGEBAUT, S_FREMD);

        Map<UUID, FuehrendeBox> masse = dienst.fuehrendeBoxen(anlagen);
        Map<UUID, FuehrendeBox> einzeln = new HashMap<>();
        for (UUID s : anlagen) {
            einzeln.put(s, dienst.fuehrendeBox(s));
        }
        assertThat(masse).isEqualTo(einzeln);
        // Jede Welt der Ableitung kommt vor - sonst bewiese die Gleichheit wenig.
        java.util.Set<String> gruende = new java.util.HashSet<>();
        masse.values().forEach(f -> gruende.add(f.grund().code()));
        assertThat(gruende).hasSizeGreaterThanOrEqualTo(5);
        assertThat(masse.get(S_GEWAEHLT).box()).isEqualTo(box(S_GEWAEHLT, 2));
        assertThat(masse.get(S_SPEICHER).box()).isEqualTo(box(S_SPEICHER, 1));
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

    private static void device(Connection c, UUID id, UUID tenant, UUID site, Instant created, Instant ausgebaut)
            throws Exception {
        // device_ausgebaut_chk: eine ausgebaute Box trägt den Status „ausgebaut“.
        exec(c, "INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status, created_at, ausgebaut_am) "
                        + "VALUES (?, ?, ?, ?, 'inverter', ?, ?, ?)",
                id, tenant, site, "ref-" + id, ausgebaut == null ? "claimed" : "ausgebaut",
                Timestamp.from(created), ausgebaut == null ? null : Timestamp.from(ausgebaut));
    }

    private static void battery(Connection c, UUID site, UUID tenant, UUID device) throws Exception {
        exec(c, "INSERT INTO asset (id, tenant_id, site_id, device_id, type, capacity_kwh, is_primary) "
                + "VALUES (gen_random_uuid(), ?, ?, ?, 'battery', 10, true)", tenant, site, device);
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
