package com.voltpilot.api.config;

import com.voltpilot.api.kundenbereich.KundenbereichEndeFilter;
import com.voltpilot.api.kundenbereich.KundenbereichEndeRepository;
import com.voltpilot.api.tenant.TenantFilter;
import com.voltpilot.api.zugriff.ZugriffFilter;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import jakarta.servlet.DispatcherType;
import java.util.List;
import org.springframework.beans.factory.ObjectProvider;
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
 * {@code voltpilot.security.oidc.enabled}. It is {@code true} by default
 * (fail-secure: a deployment that forgot the env var authenticates rather than
 * permits-all); offline unit tests and broker-less dev setups OPT OUT
 * explicitly via {@code VOLTPILOT_SECURITY_OIDC_ENABLED=false}. Either way the
 * actuator health/info endpoints stay open.
 *
 * <p>The {@link TenantFilter} runs right after bearer-token authentication so the
 * validated {@code tenant_id} claim is published to {@code TenantContext} for the
 * duration of the request, driving Postgres Row-Level-Security.
 *
 * <p>The {@link ZugriffFilter} (UEMS AP-03 IP-4) runs right after it: it loads the
 * caller's Zuweisungen into {@code ZugriffContext}, accepts {@code X-Kundenbereich}
 * for partner and platform accounts only against a valid Unterstützung, and answers
 * 404 on every customer route when it does not.
 */
@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    @Value("${voltpilot.security.cors.allowed-origins:http://localhost:5173}")
    private List<String> allowedOrigins;

    /**
     * OIDC on (the DEFAULT - fail-secure): validate Bearer JWTs from Keycloak,
     * open only health/info + the public onboarding endpoints.
     */
    @Bean
    @ConditionalOnProperty(name = "voltpilot.security.oidc.enabled", havingValue = "true",
            matchIfMissing = true)
    SecurityFilterChain secured(HttpSecurity http, TenantFilter tenantFilter, ZugriffFilter zugriffFilter,
            KundenbereichEndeFilter kundenbereichEndeFilter)
            throws Exception {
        http
            .cors(Customizer.withDefaults())
            .csrf(csrf -> csrf.disable())
            .authorizeHttpRequests(auth -> auth
                // Spring Security 6 filters ERROR dispatches too; without this an
                // anonymous caller's 400/409 would be masked as 401 by the /error
                // forward (relevant for the public registration endpoint).
                .dispatcherTypeMatchers(DispatcherType.ERROR).permitAll()
                // /health alone does NOT cover the probe groups: the management
                // base-path is the root (application.yml), so Spring serves the
                // Kubernetes probes at /health/liveness and /health/readiness -
                // both fell through to .anyRequest().authenticated() and answered
                // 401, which restart-looped every api pod in the cluster (the
                // compose healthcheck asks for the bare /health, so the VM never
                // showed it). Listed EXPLICITLY rather than as /health/**: these
                // two expose only UP/DOWN, while a wildcard would also hand out
                // whatever per-component paths a future show-details setting adds.
                .requestMatchers("/health", "/health/liveness", "/health/readiness",
                        "/info", "/actuator/**").permitAll()
                // Prometheus scrapes without a token, so the scrape endpoint has
                // to answer anonymously - the SAME shape of hole the probe paths
                // above needed, and listed with the same discipline: the EXACT
                // path, never a wildcard. (It is /metrics, not /prometheus:
                // application.yml remaps the endpoint; and not /actuator/metrics,
                // because the management base-path is the root.)
                //
                // What it hands out is deliberately bounded to platform-operations
                // facts - see com.voltpilot.api.metrics.FleetMetrics: site and
                // tenant appear as internal UUIDs only, never a name, address or
                // meter reading. It is also not publicly reachable (the frontend
                // nginx proxies only /api/ and /auth/), so this opens the endpoint
                // to the pod/compose network, not to the internet.
                .requestMatchers(HttpMethod.GET, "/metrics").permitAll()
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
                // Das root-signierte Trust-Set beim EINRICHTEN: eine Box, die
                // gerade installiert wird, hat noch kein Token - dieselbe Lage
                // wie beim Enrollment. Herausgegeben wird ausschliesslich
                // OEFFENTLICHES Schluesselmaterial (die .pub-Teile der
                // Release-Schluessel plus die Signatur der kalten Wurzel
                // darueber), und die Box prueft die Root-Signatur weiterhin
                // selbst gegen ihre EINGEBACKENE Wurzel - der Kanal
                // transportiert nur, er begruendet kein Vertrauen.
                // EXAKTE Pfade, kein /api/v1/edge/** - dieselbe Ueberlegung wie
                // bei den Probe-Pfaden oben: ein Platzhalter oeffnete auch
                // jede kuenftige Route unter diesem Praefix. Die Routen heissen
                // wie die ZIELDATEIEN auf dem Geraet, damit der Installer
                // schlicht schreibt, was er laedt.
                .requestMatchers(HttpMethod.GET, "/api/v1/edge/trust-set/trust-set.json",
                        "/api/v1/edge/trust-set/trust-set.json.sig").permitAll()
                // Gürtel UND Hosenträger für den Admin-Baum: die eigentliche
                // Autorisierung ist weiterhin @PreAuthorize je Controller, aber
                // seit es eine ZWEITE, eng geschnittene Admin-Rolle gibt
                // (edge-release-publisher, siehe AdminEdgeReleaseController)
                // hängt zu viel daran, dass niemand eine Annotation vergisst.
                // Diese Zeile stellt sicher, dass eine künftige, versehentlich
                // un-annotierte Admin-Route KEINEM Kunden-Token offensteht -
                // sie erweitert nichts (Methodensicherheit schneidet danach
                // weiter zu), sie schließt nur die Rückfallebene.
                .requestMatchers("/api/v1/admin/**")
                        .hasAnyRole("platform-admin", "edge-release-publisher")
                .anyRequest().authenticated())
            // Map Keycloak realm roles -> ROLE_* authorities so @PreAuthorize on the
            // admin API can gate Portal-Admins (platform-admin) from Portal-Users.
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt ->
                jwt.jwtAuthenticationConverter(new KeycloakRealmRoleConverter())))
            .addFilterAfter(tenantFilter, BearerTokenAuthenticationFilter.class)
            .addFilterAfter(zugriffFilter, TenantFilter.class)
            // UEMS AP-20 IP-16: nach dem angenommenen Kundenbereich die Sperre des beendeten (409 an jedem Schreibweg).
            .addFilterAfter(kundenbereichEndeFilter, ZugriffFilter.class);
        return http.build();
    }

    /**
     * OIDC off (EXPLICIT opt-out for offline unit tests / broker-less dev):
     * permit everything, no tenant context. Never the default - a deployment
     * has to say {@code VOLTPILOT_SECURITY_OIDC_ENABLED=false} to get this.
     */
    @Bean
    @ConditionalOnProperty(name = "voltpilot.security.oidc.enabled", havingValue = "false")
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
    ZugriffFilter zugriffFilter(ZugriffKontextLader lader) {
        return new ZugriffFilter(lader);
    }

    @Bean
    KundenbereichEndeFilter kundenbereichEndeFilter(ObjectProvider<KundenbereichEndeRepository> zustand) {
        return new KundenbereichEndeFilter(zustand);
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOrigins(allowedOrigins);
        cfg.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        // X-Tenant-Id is the Portal-Admin tenant switcher (see TenantFilter);
        // X-Kundenbereich the partner/platform choice against an Unterstützung (ZugriffFilter).
        cfg.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Tenant-Id",
                ZugriffKontextLader.KUNDENBEREICH_HEADER));
        cfg.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cfg);
        return source;
    }
}
