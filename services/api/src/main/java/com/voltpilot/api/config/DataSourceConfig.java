package com.voltpilot.api.config;

import com.voltpilot.api.tenant.AnfragePfadDataSource;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.zaxxer.hikari.HikariDataSource;
import javax.sql.DataSource;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Datasources for the portal API.
 *
 * <p><b>Primary (customer) datasource</b> - connects as the non-privileged
 * {@code voltpilot_app} role (so Row-Level-Security applies to it); the
 * {@link TenantAwareDataSource} wrapper stamps {@code app.tenant_id} onto each
 * borrowed connection. Every tenant-scoped endpoint (sites/devices/telemetry)
 * reads through this. Flyway is configured separately (spring.flyway.*) to run
 * migrations as the Postgres superuser.
 *
 * <p>Underneath it, {@link AnfragePfadDataSource} splits the SAME role into two
 * physical Hikari pools: {@code realDataSource} (the request pool - statement
 * and socket timeout from {@code spring.datasource.hikari}, see its Javadoc for
 * why those can only be pool-level settings) while an HTTP request runs
 * ({@code AnfrageZeitgrenze}, set by {@code TenantFilter}), and
 * {@code backgroundDataSource} (no timeout) otherwise - nightly/scheduled jobs,
 * MQTT listeners and anything else off the servlet thread. Both connect with the
 * same credentials; only the pool-level connection settings differ.
 *
 * <p><b>Admin datasource</b> - a SEPARATE pool that connects as the dedicated
 * {@code voltpilot_admin} role (BYPASSRLS, created by migration V4). It is used
 * ONLY by the platform-admin repositories to manage tenants across the whole
 * platform. Keeping it separate means the customer datasource's RLS is never
 * weakened: cross-tenant access is a distinct, explicitly-authorized code path
 * (guarded by {@code @PreAuthorize("hasRole('platform-admin')")}), not a hole in
 * the tenant isolation that protects customer data.
 */
@Configuration
public class DataSourceConfig {

    /**
     * Request pool: every HTTP-triggered query runs through this one while
     * {@code AnfrageZeitgrenze} is active. {@code connection-init-sql} sets
     * {@code statement_timeout} once per physical connection (a session GUC, so
     * it holds for that connection's whole life - no per-borrow SET/RESET
     * needed); {@code data-source-properties.socketTimeout} is pgjdbc's
     * client-side defense if Postgres itself never answers at all. Both are
     * baked in at connection creation and can't be toggled afterwards, which is
     * exactly why background work needs its OWN pool instead of a flag on this
     * one (see {@link AnfragePfadDataSource}).
     */
    @Bean
    @ConfigurationProperties("spring.datasource.hikari")
    HikariDataSource realDataSource(DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().type(HikariDataSource.class).build();
    }

    /**
     * Background pool: same role and database as {@link #realDataSource}, no
     * statement or socket timeout. Nightly/scheduled jobs and MQTT listeners
     * never set {@code AnfrageZeitgrenze}, so {@link AnfragePfadDataSource}
     * always routes them here.
     */
    @Bean
    @ConfigurationProperties("spring.background-datasource.hikari")
    HikariDataSource backgroundDataSource(DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().type(HikariDataSource.class).build();
    }

    @Bean
    @Primary
    DataSource dataSource(HikariDataSource realDataSource, HikariDataSource backgroundDataSource) {
        return new TenantAwareDataSource(new AnfragePfadDataSource(realDataSource, backgroundDataSource));
    }

    /**
     * Primary JdbcTemplate: the tenant-aware (RLS-scoped) one every customer
     * repository uses. Declared explicitly because the presence of the admin
     * JdbcTemplate below backs off Spring Boot's auto-configured one - so we must
     * define, and mark {@code @Primary}, the one repositories should get by default.
     */
    @Bean
    @Primary
    JdbcTemplate jdbcTemplate(@Qualifier("dataSource") DataSource dataSource) {
        return new JdbcTemplate(dataSource);
    }

    /**
     * Dedicated pool for the platform-admin (cross-tenant) datasource. Connects
     * as {@code voltpilot_admin} (BYPASSRLS). Same database as the app pool - only
     * the role differs - so the URL defaults to {@code spring.datasource.url}.
     */
    @Bean(name = "adminDataSource")
    HikariDataSource adminDataSource(
            @Value("${voltpilot.admin-datasource.url:${spring.datasource.url}}") String url,
            @Value("${voltpilot.admin-datasource.username:voltpilot_admin}") String username,
            @Value("${voltpilot.admin-datasource.password:voltpilot_admin_dev_pw}") String password) {
        HikariDataSource ds = new HikariDataSource();
        ds.setJdbcUrl(url);
        ds.setUsername(username);
        ds.setPassword(password);
        ds.setPoolName("voltpilot-admin-pool");
        ds.setMaximumPoolSize(4);
        return ds;
    }

    /** JdbcTemplate bound to the admin (BYPASSRLS) datasource for admin repositories. */
    @Bean(name = "adminJdbcTemplate")
    JdbcTemplate adminJdbcTemplate(@Qualifier("adminDataSource") DataSource adminDataSource) {
        return new JdbcTemplate(adminDataSource);
    }
}
