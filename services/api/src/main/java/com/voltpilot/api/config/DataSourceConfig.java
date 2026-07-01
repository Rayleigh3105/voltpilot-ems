package com.voltpilot.api.config;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.zaxxer.hikari.HikariDataSource;
import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;

/**
 * Exposes a tenant-aware {@link DataSource} as the application's primary one.
 *
 * <p>The real pooled Hikari datasource connects as the non-privileged
 * {@code voltpilot_app} role (so Row-Level-Security applies to it); the
 * {@link TenantAwareDataSource} wrapper stamps {@code app.tenant_id} onto each
 * borrowed connection. Flyway is configured separately (spring.flyway.*) to run
 * migrations as the Postgres superuser, which owns the schema and the policies.
 */
@Configuration
public class DataSourceConfig {

    @Bean
    @ConfigurationProperties("spring.datasource.hikari")
    HikariDataSource realDataSource(DataSourceProperties properties) {
        return properties.initializeDataSourceBuilder().type(HikariDataSource.class).build();
    }

    @Bean
    @Primary
    DataSource dataSource(HikariDataSource realDataSource) {
        return new TenantAwareDataSource(realDataSource);
    }
}
