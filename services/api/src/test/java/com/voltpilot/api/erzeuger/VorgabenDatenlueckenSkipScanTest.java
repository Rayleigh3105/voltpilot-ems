package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Produktionslage vom 12.11.2026: TimescaleDB 2.17 plant {@code IN (SELECT DISTINCT device_id …)} auf der
 * Hypertable {@code device_measurement_sample} als SkipScan und scheitert unter RLS mit „unsupported subplan type
 * for SkipScan: Result“ (XX000) — der {@link VorgabenLaeufer} ließ dadurch jede Minute dieselbe Steuerung liegen
 * („Stand unverändert“). Nachgestellt mit der Produktions-Version (2.17.2-pg16), den echten Migrationen, der
 * Laufzeitrolle unter RLS und genug Proben über mehrere Tages-Chunks, dass der Planer SkipScan wählt: die alte
 * Form bleibt rot (der Kanarienvogel — wird er nach einem TimescaleDB-Wechsel grün, ist der Planer-Fehler dort
 * behoben und er darf weichen), {@link VorgabenLaufRepository#datenluecken} liefert mit {@code EXISTS} die Lücken
 * der liefernden Box.
 */
@Testcontainers(disabledWithoutDocker = true)
class VorgabenDatenlueckenSkipScanTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;

    private static final Instant AB = Instant.parse("2026-11-05T00:00:00Z");
    private static final Instant BIS = Instant.parse("2026-11-08T00:00:00Z");

    private static UUID tenant;
    private static UUID fremder;
    private static UUID entity;
    private static UUID boxLiefert;
    private static UUID boxStill;

    @BeforeAll
    static void lage() {
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"))
                .load().migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));

        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('SkipScan-Lage') RETURNING id", UUID.class);
        fremder = root.queryForObject("INSERT INTO tenant (name) VALUES ('SkipScan-Fremd') RETURNING id", UUID.class);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk') RETURNING id",
                UUID.class, tenant);
        boxLiefert = box(site, "VP-SKIPSCAN-A");
        boxStill = box(site, "VP-SKIPSCAN-B");
        entity = UUID.randomUUID();

        // Proben der Steuerung im Minutentakt über drei Tages-Chunks auf vier Punkten — erst mit dieser Menge
        // (und ANALYZE) wählt der Planer für das DISTINCT den SkipScan über den Idempotenz-Index.
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id) "
                + "SELECT g.t, ?, ?, ?, p.k, random() * 100, 'good', '2026.09.11.1', 1, 'gauge', ? "
                + "FROM generate_series(?::timestamptz + interval '1 minute', ?::timestamptz, interval '1 minute') "
                + "AS g(t), (VALUES ('ez_vorgabe_prozent'), ('ez_seit'), ('ez_zaehler'), ('ez_leistung')) AS p(k)",
                tenant, site, boxLiefert, entity, Timestamp.from(AB), Timestamp.from(BIS));
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id) "
                + "SELECT g.t, ?, ?, ?, 'leistung_w', random() * 100, 'good', '2026.09.11.1', 1, 'gauge', ? "
                + "FROM generate_series(?::timestamptz + interval '1 minute', ?::timestamptz, interval '1 minute') "
                + "AS g(t)", tenant, site, boxStill, UUID.randomUUID(), Timestamp.from(AB), Timestamp.from(BIS));

        // Zwei Lücken der liefernden Box im Fenster, eine davor, eine der stillen Box (liest die Steuerung nicht).
        luecke(site, boxLiefert, Instant.parse("2026-11-06T10:00:00Z"));
        luecke(site, boxLiefert, Instant.parse("2026-11-07T11:00:00Z"));
        luecke(site, boxLiefert, Instant.parse("2026-11-04T09:00:00Z"));
        luecke(site, boxStill, Instant.parse("2026-11-06T12:00:00Z"));

        root.execute("ANALYZE device_measurement_sample");
        root.execute("ANALYZE device_measurement_event");
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    @Test
    void dieAlteFormBleibtInDieserLageRot() {
        assertThatThrownBy(() -> als(tenant, () -> app.queryForList("SELECT e.occurred_at "
                + "FROM device_measurement_event e "
                + "WHERE e.tenant_id = ? AND e.event_kind = 'data_gap' AND e.occurred_at > ? AND e.occurred_at <= ? "
                + "AND e.device_id IN (SELECT DISTINCT d.device_id FROM device_measurement_sample d "
                + "WHERE d.tenant_id = ? AND d.entity_id = ? AND d.time > ? AND d.time <= ?) ORDER BY e.occurred_at",
                Timestamp.class, tenant, Timestamp.from(AB), Timestamp.from(BIS), tenant, entity,
                Timestamp.from(AB), Timestamp.from(BIS))))
                .isInstanceOf(DataAccessException.class)
                .hasMessageContaining("SkipScan");
    }

    @Test
    void datenlueckenLiefertDieLueckenDerLieferndenBoxImFenster() {
        VorgabenLaufRepository repo = new VorgabenLaufRepository(app, new ObjectMapper());
        assertThat(als(tenant, () -> repo.datenluecken(tenant, entity, AB, BIS)))
                .containsExactly(Instant.parse("2026-11-06T10:00:00Z"), Instant.parse("2026-11-07T11:00:00Z"));
    }

    @Test
    void einFremderMandantSiehtKeineLuecken() {
        VorgabenLaufRepository repo = new VorgabenLaufRepository(app, new ObjectMapper());
        assertThat(als(fremder, () -> repo.datenluecken(fremder, entity, AB, BIS))).isEmpty();
    }

    // ============================================================ Gerüst

    private static UUID box(UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, ?, 'claimed') RETURNING id", UUID.class, tenant, site, ref);
    }

    private static void luecke(UUID site, UUID box, Instant wann) {
        root.update("INSERT INTO device_measurement_event (occurred_at, tenant_id, site_id, device_id, point_key, "
                + "event_kind, catalog_version, edge_sequence) VALUES (?, ?, ?, ?, 'ez_vorgabe_prozent', "
                + "'data_gap', '2026.09.11.1', 1)", Timestamp.from(wann), tenant, site, box);
    }

    private static <T> T als(UUID mandant, Supplier<T> arbeit) {
        TenantContext.set(mandant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
