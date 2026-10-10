package com.voltpilot.api.config;

import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

/**
 * Wires the {@link SelfHealingFlywayMigrationStrategy} so it REPLACES Spring
 * Boot's default {@code flyway.migrate()} call at startup. When a
 * {@link FlywayMigrationStrategy} bean is present, Boot's Flyway auto-migration
 * delegates to it. Production/default startup is strict; the sole local profile
 * may explicitly select the developer warning mode. The strategy enforces both
 * gates itself, so the property alone cannot relax production startup.
 */
@Configuration
public class FlywayConfig {

    @Bean
    FlywayMigrationStrategy selfHealingFlywayMigrationStrategy(Environment environment) {
        return new SelfHealingFlywayMigrationStrategy(environment);
    }
}
