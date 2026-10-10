package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.*;
import com.voltpilot.api.components.ComponentDefinitionRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

@Testcontainers(disabledWithoutDocker=true)
class WagoKartenfassungMigrationTest {
    @Container static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("test");

    @Test
    void nullbareErgaenzungenErhaltenBestandUndFassungenMitRlsUndGrants() {
        flyway().target("20260917114000").load().migrate();
        JdbcTemplate root = jdbc(DB.getUsername(),DB.getPassword());
        UUID tenant = root.queryForObject("INSERT INTO tenant(name) VALUES ('WAGO') RETURNING id",UUID.class);
        UUID site = root.queryForObject("INSERT INTO site(tenant_id,name) VALUES (?,'WAGO') RETURNING id",UUID.class,tenant);
        UUID entity = root.queryForObject("INSERT INTO measurement_point(tenant_id,site_id,role,entity_type) "
                + "VALUES (?,?,'modbus-generic','modbus-generic') RETURNING id",UUID.class,tenant,site);
        var before = Bestandsschutz.fingerabdruck(root,List.of());
        flyway().load().migrate();
        assertThat(Bestandsschutz.abweichungen(before,Bestandsschutz.fingerabdruck(root,List.of()))).isEmpty();
        assertThat(root.queryForObject("SELECT slot FROM measurement_point WHERE id=?",Integer.class,entity)).isNull();
        assertThat(root.queryForList("SELECT relforcerowsecurity FROM pg_class WHERE relname IN "
                + "('measurement_point','component_definition','geraet')",Boolean.class)).containsOnly(true);
        JdbcTemplate app = new JdbcTemplate(new TenantAwareDataSource(new DriverManagerDataSource(
                DB.getJdbcUrl(),"voltpilot_app","app_pw")));
        TenantContext.set(tenant);
        try {
            app.update("UPDATE measurement_point SET slot=2,wago_anwenderskalierung=true,wago_register_35=4 WHERE id=?",entity);
            var repo = new ComponentDefinitionRepository(app);
            int version = repo.definitionVersion(site,entity);
            repo.recordStoredVersion(tenant,site,entity,version,"test","WAGO");
            var old = repo.fullVersion(site,entity,version);
            assertThat(old.definition().slot()).isEqualTo(2);
            assertThat(old.definition().wagoAnwenderskalierung()).isTrue();
            assertThat(old.definition().wagoRegister35()).isEqualTo(4);
            app.update("UPDATE measurement_point SET wago_register_35=5 WHERE id=?",entity);
            assertThat(repo.applyDefinitionFull(site,entity,version,old)).isNotNull();
            assertThat(app.queryForObject("SELECT wago_register_35 FROM measurement_point WHERE id=?",Integer.class,entity)).isEqualTo(4);
            assertThatThrownBy(() -> app.update("UPDATE measurement_point SET slot=0 WHERE id=?",entity))
                    .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
            assertThat(app.update("UPDATE geraet SET firmware='FW',anwendung='Registerbild v1' WHERE site_id=?",site)).isPositive();
            TenantContext.set(UUID.randomUUID());
            assertThat(app.queryForObject("SELECT count(*) FROM measurement_point WHERE id=?",Integer.class,entity)).isZero();
            assertThat(app.queryForObject("SELECT count(*) FROM component_definition WHERE entity_id=?",Integer.class,entity)).isZero();
            assertThat(app.update("UPDATE geraet SET firmware='fremd' WHERE site_id=?",site)).isZero();
        } finally { TenantContext.clear(); }
        jdbc("voltpilot_app","app_pw").execute((org.springframework.jdbc.core.ConnectionCallback<Void>) c -> {
            try (var statement = c.createStatement()) {
                statement.execute("SELECT set_config('app.tenant_id','"+tenant+"',false), "
                        + "set_config('app.zugriff','standorte',false), set_config('app.standort_ids','{}',false)");
                for (String table : List.of("measurement_point","component_definition","geraet")) {
                    try (var result = statement.executeQuery("SELECT count(*) FROM "+table)) {
                        result.next();
                        assertThat(result.getInt(1)).as("Standort-RLS: "+table).isZero();
                    }
                }
                assertThat(statement.executeUpdate("UPDATE geraet SET firmware='fremder Standort' WHERE site_id='"+site+"'")).isZero();
            }
            return null;
        });
    }
    private static JdbcTemplate jdbc(String user,String password) {
        return new JdbcTemplate(new DriverManagerDataSource(DB.getJdbcUrl(),user,password));
    }
    private static FluentConfiguration flyway() {
        return Flyway.configure().dataSource(DB.getJdbcUrl(),DB.getUsername(),DB.getPassword())
                .locations("classpath:db/migration").outOfOrder(true)
                .placeholders(Map.of("appDbUser","voltpilot_app","appDbPassword","app_pw",
                        "adminDbUser","voltpilot_admin","adminDbPassword","admin_pw"));
    }
}
