package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
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
 * Dasselbe SkipScan-Muster wie beim {@code VorgabenLaeufer} (Produktionslage vom 12.11.2026,
 * {@code VorgabenDatenlueckenSkipScanTest}), an der zweiten Stelle im Server: die Lücken-Abfrage der Kanalbindung
 * traf mit {@code device_id IN (SELECT DISTINCT device_id …)} auf {@code device_measurement_sample} denselben
 * Planer-Fehler von TimescaleDB 2.17 unter RLS („unsupported subplan type for SkipScan: Result“, XX000), sobald
 * das Fenster mehrere Tages-Chunks umfasst. Die alte Form bleibt rot (der Kanarienvogel — wird er nach einem
 * TimescaleDB-Wechsel grün, ist der Planer-Fehler dort behoben und er darf weichen),
 * {@link KanalbindungLauf#datenLuecken} liefert mit {@code EXISTS} die Lücken der Komponente und der liefernden
 * Box.
 */
@Testcontainers(disabledWithoutDocker = true)
class KanalbindungDatenlueckenSkipScanTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String KANAL = "energie_kwh";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;

    private static final Instant AB = Instant.parse("2026-11-03T00:00:00Z");
    private static final Instant BIS = Instant.parse("2026-11-08T00:00:00Z");

    private static UUID tenant;
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

        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('SkipScan-Kanal') RETURNING id", UUID.class);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Werk') RETURNING id",
                UUID.class, tenant);
        boxLiefert = box(site, "VP-SKIPSCAN-K-A");
        boxStill = box(site, "VP-SKIPSCAN-K-B");
        entity = UUID.randomUUID();

        // Der Kanal und drei weitere Punkte im Minutentakt über fünf Tages-Chunks — erst mit dieser Menge
        // (und ANALYZE) wählt der Planer für das DISTINCT den SkipScan über den Idempotenz-Index.
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id) "
                + "SELECT g.t, ?, ?, ?, p.k, random() * 100, 'good', '2026.09.11.1', 1, 'counter', ? "
                + "FROM generate_series(?::timestamptz + interval '1 minute', ?::timestamptz, interval '1 minute') "
                + "AS g(t), (VALUES (?::text), ('leistung_w'), ('spannung_v'), ('strom_a')) AS p(k)",
                tenant, site, boxLiefert, entity, Timestamp.from(AB), Timestamp.from(BIS), KANAL);
        root.update("INSERT INTO device_measurement_sample (time, tenant_id, site_id, device_id, point_key, "
                + "raw_numeric, quality, catalog_version, edge_sequence, aggregation_kind, entity_id) "
                + "SELECT g.t, ?, ?, ?, 'leistung_w', random() * 100, 'good', '2026.09.11.1', 1, 'gauge', ? "
                + "FROM generate_series(?::timestamptz + interval '1 minute', ?::timestamptz, interval '1 minute') "
                + "AS g(t)", tenant, site, boxStill, UUID.randomUUID(), Timestamp.from(AB), Timestamp.from(BIS));

        // Eine Lücke der liefernden Box (nur über die Box gemeldet), eine der stillen Box, eine an der Komponente.
        boxLuecke(site, boxLiefert, Instant.parse("2026-11-05T10:00:00Z"), Instant.parse("2026-11-05T10:20:00Z"));
        boxLuecke(site, boxStill, Instant.parse("2026-11-05T12:00:00Z"), Instant.parse("2026-11-05T12:20:00Z"));
        komponentenLuecke(site, Instant.parse("2026-11-06T08:00:00Z"), Instant.parse("2026-11-06T08:30:00Z"));

        root.execute("ANALYZE device_measurement_sample");
        root.execute("ANALYZE messreihe_ereignis");
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    @Test
    void dieAlteFormBleibtInDieserLageRot() {
        assertThatThrownBy(() -> als(tenant, () -> app.query(
                "SELECT greatest(von,?),least(bis,?),coalesce(nutzlast->>'quelle','Kanal ohne Werte') "
                + "FROM (SELECT DISTINCT ON (ereignis_id) * FROM messreihe_ereignis WHERE tenant_id=? "
                + "AND art='data_gap' AND eingang<=? ORDER BY ereignis_id,eingang DESC) e "
                + "WHERE von<? AND (bis IS NULL OR bis>?) "
                + "AND ((entity_id=? AND (messkanal IS NULL OR messkanal=?)) OR (entity_id IS NULL AND device_id IN "
                + "(SELECT DISTINCT device_id FROM device_measurement_sample WHERE tenant_id=? AND entity_id=? "
                + "AND point_key=? AND time>=? AND time<=?)))",
                (r, n) -> r.getTimestamp(1).toInstant(),
                Timestamp.from(AB), Timestamp.from(BIS), tenant, Timestamp.from(BIS), Timestamp.from(BIS),
                Timestamp.from(AB), entity, KANAL, tenant, entity, KANAL, Timestamp.from(AB), Timestamp.from(BIS))))
                .isInstanceOf(DataAccessException.class)
                .hasMessageContaining("SkipScan");
    }

    @Test
    void datenLueckenLiefertKomponentenUndBoxLuecken() {
        KanalbindungLauf.Bindung b = new KanalbindungLauf.Bindung(UUID.randomUUID(), tenant, UUID.randomUUID(),
                entity, KANAL, "counter", null, "kWh", "kWh", "tag", 900, AB, null,
                ZoneId.of("Europe/Berlin"), null, null, null, (BigDecimal) null);
        List<BezugsdatenRegeln.Luecke> luecken =
                als(tenant, () -> KanalbindungLauf.datenLuecken(app, b, AB, BIS, BIS));
        assertThat(luecken).extracting(BezugsdatenRegeln.Luecke::von).containsExactlyInAnyOrder(
                Instant.parse("2026-11-05T10:00:00Z"), Instant.parse("2026-11-06T08:00:00Z"));
    }

    // ============================================================ Gerüst

    private static UUID box(UUID site, String ref) {
        return root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) "
                + "VALUES (?, ?, ?, 'claimed') RETURNING id", UUID.class, tenant, site, ref);
    }

    /** Eine data_gap-Meldung nur mit Box-Bezug — der Weg über die EXISTS-Hälfte der Abfrage. */
    private static void boxLuecke(UUID site, UUID box, Instant von, Instant bis) {
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, "
                + "site_id, kennungen, device_id, nutzlast, eingang) VALUES (?, ?, ?, 'data_gap', 'cloud', ?, ?, "
                + "?, jsonb_build_object('box', ?::text), ?, jsonb_build_object('erkannt_aus', 'herzschlag'), ?)",
                Timestamp.from(von), tenant, UUID.randomUUID(), Timestamp.from(von), Timestamp.from(bis),
                site, box.toString(), box, Timestamp.from(bis));
    }

    /** Eine data_gap-Meldung mit Komponenten-Bezug — der Weg über die erste Hälfte der Abfrage. */
    private static void komponentenLuecke(UUID site, Instant von, Instant bis) {
        root.update("INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, "
                + "site_id, kennungen, device_id, entity_id, messkanal, nutzlast, eingang) VALUES "
                + "(?, ?, ?, 'data_gap', 'writer', ?, ?, ?, "
                + "jsonb_build_object('box', ?::text, 'komponente', ?::text), ?, ?, ?, "
                + "jsonb_build_object('erkannt_aus', 'kadenz'), ?)",
                Timestamp.from(von), tenant, UUID.randomUUID(), Timestamp.from(von), Timestamp.from(bis),
                site, boxLiefert.toString(), entity.toString(), boxLiefert, entity, KANAL, Timestamp.from(bis));
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
