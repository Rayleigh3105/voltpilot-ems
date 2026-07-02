package com.voltpilot.api.config;

import com.voltpilot.api.tenant.TenantFilter;
import jakarta.servlet.DispatcherType;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * Security wiring for the portal API.
 *
 * <p>OIDC (Keycloak) resource-server validation is toggled by
 * {@code voltpilot.security.oidc.enabled}. It is {@code false} by default so the
 * service builds and unit-tests standalone; docker-compose and the integration
 * tests flip it on and supply the issuer/JWKS. Either way the actuator
 * health/info endpoints stay open.
 *
 * <p>The {@link TenantFilter} runs right after bearer-token authentication so the
 * validated {@code tenant_id} claim is published to {@code TenantContext} for the
 * duration of the request, driving Postgres Row-Level-Security.
 */
@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    @Value("${voltpilot.security.cors.allowed-origins:http://localhost:5173}")
    private List<String> allowedOrigins;

    /** OIDC on: validate Bearer JWTs from Keycloak, open only health/info. */
    @Bean
    @ConditionalOnProperty(name = "voltpilot.security.oidc.enabled", havingValue = "true")
    SecurityFilterChain secured(HttpSecurity http, TenantFilter tenantFilter) throws Exception {
        http
            .cors(Customizer.withDefaults())
            .csrf(csrf -> csrf.disable())
            .authorizeHttpRequests(auth -> auth
                // Spring Security 6 filters ERROR dispatches too; without this an
                // anonymous caller's 400/409 would be masked as 401 by the /error
                // forward (relevant for the public registration endpoint).
                .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
                .requestMatchers("/health", "/info", "/actuator/**").permitAll()
                // Self-service registration is the front door - it must work
                // before the caller has any token (the controller can be turned
                // off via voltpilot.registration.enabled).
                .requestMatchers(HttpMethod.POST, "/api/v1/registration").permitAll()
                // First-boot device enrollment: a fresh edge device has no token,
                // only its reference - it uploads a CSR and polls for its mTLS
                // certificate. Rate-limited + validated in EnrollmentController
                // (absent unless voltpilot.enrollment.enabled).
                .requestMatchers(HttpMethod.POST, "/api/v1/enrollment/*/csr").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/v1/enrollment/*/certificate").permitAll()
                .anyRequest().authenticated())
            // Map Keycloak realm roles -> ROLE_* authorities so @PreAuthorize on the
            // admin API can gate Portal-Admins (platform-admin) from Portal-Users.
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt ->
                jwt.jwtAuthenticationConverter(new KeycloakRealmRoleConverter())))
            .addFilterAfter(tenantFilter, BearerTokenAuthenticationFilter.class);
        return http.build();
    }

    /** OIDC off (default/dev/unit-test): permit everything, no tenant context. */
    @Bean
    @ConditionalOnProperty(name = "voltpilot.security.oidc.enabled", havingValue = "false", matchIfMissing = true)
    SecurityFilterChain open(HttpSecurity http) throws Exception {
        http
            .cors(Customizer.withDefaults())
            .csrf(csrf -> csrf.disable())
            .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }

    @Bean
    TenantFilter tenantFilter() {
        return new TenantFilter();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOrigins(allowedOrigins);
        cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        // X-Tenant-Id is the Portal-Admin tenant switcher (see TenantFilter).
        cfg.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Tenant-Id"));
        cfg.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cfg);
        return source;
    }
}
