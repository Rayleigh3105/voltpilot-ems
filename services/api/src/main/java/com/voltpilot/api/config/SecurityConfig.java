package com.voltpilot.api.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Dev-friendly security wiring.
 *
 * <p>OIDC (Keycloak) resource-server validation is toggled by
 * {@code voltpilot.security.oidc.enabled}. It is {@code false} by default so the
 * service builds, tests and runs standalone without Keycloak. Once the api
 * service is added to docker compose it will flip this on and supply
 * {@code OIDC_ISSUER_URI}. Either way the actuator health/info endpoints stay
 * open.
 */
@Configuration
public class SecurityConfig {

    /** OIDC on: validate Bearer JWTs from Keycloak, open only health/info. */
    @Bean
    @ConditionalOnProperty(name = "voltpilot.security.oidc.enabled", havingValue = "true")
    SecurityFilterChain secured(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/health", "/info", "/actuator/**").permitAll()
                .anyRequest().authenticated())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> {}));
        return http.build();
    }

    /** OIDC off (default/dev/test): permit everything. */
    @Bean
    @ConditionalOnProperty(name = "voltpilot.security.oidc.enabled", havingValue = "false", matchIfMissing = true)
    SecurityFilterChain open(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable())
            .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }
}
