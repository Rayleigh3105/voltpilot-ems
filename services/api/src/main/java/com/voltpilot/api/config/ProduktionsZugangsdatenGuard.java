package com.voltpilot.api.config;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;

/**
 * Security-Wartung (vp-wartung-security-s1 C2): the four outgoing credentials
 * {@code APP_DB_PASSWORD}, {@code POSTGRES_PASSWORD}, {@code ADMIN_DB_PASSWORD}
 * and {@code KEYCLOAK_API_CLIENT_SECRET} no longer have a dev-password fallback
 * in {@code application.yml}. That alone is not enough: Spring Boot's
 * {@code @ConfigurationProperties} binding (which {@code spring.datasource.password}
 * and {@code spring.flyway.password} go through) leaves an unresolved
 * {@code ${VAR}} as a literal string instead of failing - and the primary
 * datasource pool connects lazily, so a missing {@code APP_DB_PASSWORD} alone
 * would let the api start "successfully" and only fail the first real customer
 * request. This guard makes the four variables an explicit precondition of a
 * PRODUCTION start (the {@code local} profile not active, docs/deploy.md): one
 * missing value aborts the boot here, before any datasource/Flyway/Keycloak bean
 * is created, with a message naming exactly what to set.
 *
 * <p>Runs as an {@link EnvironmentPostProcessor} - the earliest hook Boot offers,
 * firing right after the {@link ConfigurableEnvironment} (profiles, YAML, real
 * env vars) is assembled and before a single bean is created. Registered via
 * {@code META-INF/spring/org.springframework.boot.env.EnvironmentPostProcessor.imports}.
 *
 * <p>Only checks PRESENCE, not the value itself: the local/test profile and a
 * handful of Testcontainers-backed tests that do not activate it (they bind
 * their own real credentials via {@code @DynamicPropertySource} after this
 * guard has already run) legitimately pass the well-known dev value through
 * the same env vars (pom.xml surefire config) - this guard only has to close
 * the "nothing set at all" gap, which {@code docker-compose.prod.yml}'s
 * {@code :?} guard does not reach for a non-compose production start.
 */
public class ProduktionsZugangsdatenGuard implements EnvironmentPostProcessor {

    private static final List<String> PFLICHT_VARIABLEN =
            List.of("APP_DB_PASSWORD", "POSTGRES_PASSWORD", "ADMIN_DB_PASSWORD", "KEYCLOAK_API_CLIENT_SECRET");

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        if (Arrays.asList(environment.getActiveProfiles()).contains("local")) {
            return;
        }
        List<String> fehlend = new ArrayList<>();
        for (String variable : PFLICHT_VARIABLEN) {
            String wert = environment.getProperty(variable);
            if (wert == null || wert.isBlank()) {
                fehlend.add(variable);
            }
        }
        if (!fehlend.isEmpty()) {
            throw new IllegalStateException("Produktions-Start abgebrochen (vp-wartung-security-s1 C2): "
                    + "fehlende Umgebungsvariable(n) " + fehlend + " - ohne das local-Profil gibt es keinen "
                    + "Dev-Rückfallwert mehr fuer Zugangsdaten, jede der vier Variablen braucht einen "
                    + "gesetzten Wert.");
        }
    }
}
