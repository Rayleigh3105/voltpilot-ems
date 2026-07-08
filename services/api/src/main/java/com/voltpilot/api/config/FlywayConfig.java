package com.voltpilot.api.config;

import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the {@link SelfHealingFlywayMigrationStrategy} so it REPLACES Spring
 * Boot's default {@code flyway.migrate()} call at startup. When a
 * {@link FlywayMigrationStrategy} bean is present, Boot's Flyway auto-migration
 * delegates to it - so the strict-then-self-heal behaviour runs for every boot
 * (dev, CI and production alike; on a healthy fresh DB it is a plain migrate).
 */
@Configuration
public class FlywayConfig {

    @Bean
    FlywayMigrationStrategy selfHealingFlywayMigrationStrategy() {
        return new SelfHealingFlywayMigrationStrategy();
    }
}
