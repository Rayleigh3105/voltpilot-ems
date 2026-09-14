package com.voltpilot.api.topology;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.postgresql.util.PSQLException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Verallgemeinerung der Rollen-Zuordnung ({@code entity_role_assignment},
 * {@code V20260914100100}) gegen eine echte TimescaleDB: der zugeordnete Wert ist ENTWEDER ein
 * nativer Kanal ({@code capability}) ODER ein Gesamtwert ({@code quell_messstelle_id}) — nie beide,
 * nie keiner (XOR-CHECK). Der Mandant reist im zusammengesetzten FK mit (keine fremde Messstelle),
 * das Loeschen der Komponente ODER der Messstelle raeumt die Zuordnung ab (CASCADE), und der
 * Mandantenzaun (RLS + FORCE) steht unveraendert.
 */
@Testcontainers(disabledWithoutDocker = true)
class EntityRoleAssignmentQuellMigrationTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;

    @BeforeAll
    static void migriere() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true).baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    @Test
    void derWertIstEntwederKanalOderMessstelleNieBeidesNieKeines() {
        UUID t = mandant("XOR");
        UUID site = site(t);
        UUID entity = komponente(t, site);
        UUID ms = messstelle(t);

        // nativer Kanal: ok.
        zuordnung(t, site, entity, "pv_power_kw", null, "pv", true);
        // Gesamtwert: ok.
        zuordnung(t, site, entity, null, ms, "pv", false);
        // beide gesetzt: CHECK.
        abgelehnt("entity_role_assignment_wert_chk", () ->
                zuordnung(t, site, entity, "pv_power_kw", ms, "pv", false));
        // keines gesetzt: CHECK.
        abgelehnt("entity_role_assignment_wert_chk", () ->
                zuordnung(t, site, entity, null, null, "pv", false));
    }

    @Test
    void eineZuordnungJeKomponenteUndSummenwert() {
        UUID t = mandant("Unique");
        UUID site = site(t);
        UUID entity = komponente(t, site);
        UUID ms = messstelle(t);
        zuordnung(t, site, entity, null, ms, "pv", true);
        abgelehnt("uq_entity_role_assignment_quell", () ->
                zuordnung(t, site, entity, null, ms, "consumer", false));
    }

    @Test
    void hoechstensEinMassgeblicherJeGeraetUndRolle() {
        UUID t = mandant("Primary");
        UUID site = site(t);
        UUID entity = komponente(t, site);
        zuordnung(t, site, entity, "pv_power_kw", null, "pv", true);
        // Ein zweiter Massgeblicher fuer dasselbe (Geraet, Rolle) laeuft in den partiellen Unique-Index.
        abgelehnt("uq_entity_role_primary", () ->
                zuordnung(t, site, entity, "battery_power_kw", null, "pv", true));
        // Ein NICHT-Massgeblicher desselben (Geraet, Rolle) ist erlaubt (Index ist partiell).
        zuordnung(t, site, entity, "power_kw", null, "pv", false);
        // Und ein Massgeblicher fuer eine ANDERE Rolle desselben Geraets ist erlaubt.
        zuordnung(t, site, entity, "soc_pct", null, "storage", true);
        assertThat(zahl(t)).isEqualTo(3);
    }

    @Test
    void derMandantReistImFremdschluesselMit() {
        UUID a = mandant("FK A");
        UUID b = mandant("FK B");
        UUID siteB = site(b);
        UUID entityB = komponente(b, siteB);
        UUID msA = messstelle(a); // gehoert Mandant A
        // Mandant B kann seine Zuordnung NICHT auf die Messstelle von A zeigen lassen.
        abgelehnt("entity_role_assignment_quell_fk", () ->
                zuordnung(b, siteB, entityB, null, msA, "pv", true));
    }

    @Test
    void loeschenDerKomponenteRaeumtDieZuordnungAbUndDerMessstelleFkIstCascade() {
        UUID t = mandant("Cascade");
        UUID site = site(t);
        UUID entity = komponente(t, site);
        UUID ms = messstelle(t);

        // Der neue quell-FK ist ON DELETE CASCADE ('c'): eine hart geloeschte Messstelle raeumt
        // ihre Zuordnung ab (das Archivieren, der Normalfall, loest sie im Lese-Weg auf, nicht hier).
        zuordnung(t, site, entity, null, ms, "pv", true);
        assertThat(zahl(t)).isEqualTo(1);
        assertThat(loeschregel("entity_role_assignment_quell_fk")).isEqualTo("c");

        // Und die Komponente-CASCADE (der bestehende entity-FK) gilt unveraendert: sie loescht wirklich.
        root.update("DELETE FROM entity_role_assignment WHERE entity_id = ?", entity);
        zuordnung(t, site, entity, "pv_power_kw", null, "pv", true);
        assertThat(zahl(t)).isEqualTo(1);
        root.update("DELETE FROM measurement_point WHERE id = ?", entity);
        assertThat(zahl(t)).isZero();
    }

    /** Die ON-DELETE-Regel eines Fremdschluessels aus dem Katalog ('c' = CASCADE). */
    private static String loeschregel(String constraint) {
        return root.queryForObject("SELECT confdeltype::text FROM pg_constraint WHERE conname = ?",
                String.class, constraint);
    }

    @Test
    void derMandantenzaunStehtWeiter() {
        UUID t = mandant("RLS");
        UUID site = site(t);
        UUID entity = komponente(t, site);
        zuordnung(t, site, entity, "pv_power_kw", null, "pv", true);

        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                + "WHERE relname = 'entity_role_assignment'", Boolean.class)).isTrue();
        // Ohne app.tenant_id: default-deny; der andere Mandant sieht nichts.
        assertThat(app.queryForObject("SELECT count(*) FROM entity_role_assignment", Long.class)).isZero();
        TenantContext.set(mandant("Fremd"));
        try {
            assertThat(app.queryForObject("SELECT count(*) FROM entity_role_assignment "
                    + "WHERE tenant_id <> ?", Long.class, t)).isZero();
        } finally {
            TenantContext.clear();
        }
    }

    // ---- Gerüst --------------------------------------------------------------

    private static long zahl(UUID tenant) {
        Long n = root.queryForObject("SELECT count(*) FROM entity_role_assignment WHERE tenant_id = ?",
                Long.class, tenant);
        return n == null ? 0 : n;
    }

    private static void zuordnung(UUID tenant, UUID site, UUID entity, String capability, UUID quell,
            String role, boolean primary) {
        root.update("INSERT INTO entity_role_assignment (tenant_id, site_id, entity_id, capability, "
                + "quell_messstelle_id, role, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?)",
                tenant, site, entity, capability, quell, role, primary);
    }

    private static UUID mandant(String name) {
        return root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
    }

    private static UUID site(UUID tenant) {
        return root.queryForObject("INSERT INTO site (tenant_id, name, created_at) "
                + "VALUES (?, 'Anlage', now()) RETURNING id", UUID.class, tenant);
    }

    private static UUID komponente(UUID tenant, UUID site) {
        return root.queryForObject("INSERT INTO measurement_point (tenant_id, site_id, role, label, "
                + "entity_type, control, communication, created_at) VALUES (?, ?, 'battery-hybrid', "
                + "'Wechselrichter', 'battery-hybrid', false, 'modbus_tcp', now()) RETURNING id",
                UUID.class, tenant, site);
    }

    private static final java.util.concurrent.atomic.AtomicInteger NR =
            new java.util.concurrent.atomic.AtomicInteger();

    private static UUID messstelle(UUID tenant) {
        return root.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, art, medium, "
                + "groesse, richtung, einheit, wertart) VALUES (?, ?, 'Gesamt-PV', 'berechnet', 'Strom', "
                + "'Wirkleistung', 'Erzeugung', 'kW', 'Momentanwert') RETURNING id",
                UUID.class, tenant, String.format("MS-%05d", NR.incrementAndGet()));
    }

    private static void abgelehnt(String constraint, Runnable arbeit) {
        Throwable t = null;
        try {
            arbeit.run();
        } catch (Throwable e) {
            t = e;
        }
        assertThat(t).as("die Datenbank muss ablehnen (" + constraint + ")").isNotNull();
        PSQLException p = null;
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PSQLException pe) {
                p = pe;
            }
        }
        assertThat((Object) p).as("eine PSQLException: " + t.getMessage()).isNotNull();
        assertThat(p.getServerErrorMessage().getConstraint()).as(p.getMessage()).isEqualTo(constraint);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
