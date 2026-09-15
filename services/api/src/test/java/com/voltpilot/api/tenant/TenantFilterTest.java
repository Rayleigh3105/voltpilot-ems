package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Unit test for the JWT -> TenantContext wiring. Runs without Docker or Spring
 * context, so it is always part of the gate.
 */
class TenantFilterTest {

    private static final UUID DEMO = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID NORDWIND = UUID.fromString("10000000-0000-0000-0000-000000000001");

    private final TenantFilter filter = new TenantFilter();

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
        TenantContext.clear();
    }

    @Test
    void publishesTenantIdFromJwtClaim() throws Exception {
        UUID tenant = UUID.fromString("00000000-0000-0000-0000-000000000001");
        authenticateWithClaim("tenant_id", tenant.toString());

        AtomicReference<UUID> seen = new AtomicReference<>();
        FilterChain chain = (req, res) -> seen.set(TenantContext.get());
        filter.doFilter(mock(HttpServletRequest.class), mock(HttpServletResponse.class), chain);

        assertThat(seen.get()).isEqualTo(tenant);
        // Always cleared after the request so pooled threads never leak a tenant.
        assertThat(TenantContext.get()).isNull();
    }

    @Test
    void leavesTenantUnsetWhenClaimMissing() throws Exception {
        authenticateWithClaim("sub", "someone");

        AtomicReference<UUID> seen = new AtomicReference<>();
        FilterChain chain = (req, res) -> seen.set(TenantContext.get());
        filter.doFilter(mock(HttpServletRequest.class), mock(HttpServletResponse.class), chain);

        assertThat(seen.get()).isNull();
    }

    @Test
    void clearsTenantEvenWhenChainThrows() {
        UUID tenant = UUID.randomUUID();
        authenticateWithClaim("tenant_id", tenant.toString());
        FilterChain boom = (req, res) -> {
            throw new RuntimeException("downstream failure");
        };
        try {
            filter.doFilter(mock(HttpServletRequest.class), mock(HttpServletResponse.class), boom);
        } catch (Exception ignored) {
            // expected
        }
        assertThat(TenantContext.get()).isNull();
    }

    // ---- AP-03 IP-3: Partner-Konto, und der Bestand über den echten Konverter -------------

    @Test
    void partnerOhneTenantIdBekommtKeinenKundenbereichAuchNichtPerHeader() throws Exception {
        assertThat(tenantFuer(null, DEMO.toString(), "partner")).isNull();
    }

    @Test
    void partnerMitTenantIdClaimBekommtKeinenKundenbereich() throws Exception {
        assertThat(tenantFuer(DEMO.toString(), null, "partner")).isNull();
        assertThat(tenantFuer(DEMO.toString(), NORDWIND.toString(), "partner", "operator")).isNull();
    }

    @Test
    void operatorBehaeltSeinenKundenbereichUndDerHeaderZaehltNicht() throws Exception {
        assertThat(tenantFuer(DEMO.toString(), null, "operator")).isEqualTo(DEMO);
        assertThat(tenantFuer(DEMO.toString(), NORDWIND.toString(), "operator")).isEqualTo(DEMO);
    }

    @Test
    void kundenkontoOhneRealmRolleHatDenselbenKundenbereichWieOperator() throws Exception {
        assertThat(tenantFuer(DEMO.toString(), null)).isEqualTo(DEMO);
        assertThat(tenantFuer(DEMO.toString(), NORDWIND.toString())).isEqualTo(DEMO);
    }

    @Test
    void plattformAdminWaehltDenKundenbereichWeiterPerHeader() throws Exception {
        assertThat(tenantFuer(null, NORDWIND.toString(), "platform-admin")).isEqualTo(NORDWIND);
        assertThat(tenantFuer(null, null, "platform-admin")).isNull();
    }

    /**
     * Läuft einmal durch den Filter — mit einem Token, das der ECHTE Konverter in Authorities
     * übersetzt, wie die {@code secured}-Kette es tut.
     */
    private UUID tenantFuer(String tenantClaim, String header, String... realmRoles) throws Exception {
        Map<String, Object> claims = new HashMap<>();
        claims.put("sub", "konto");
        claims.put("realm_access", Map.of("roles", List.of(realmRoles)));
        if (tenantClaim != null) {
            claims.put("tenant_id", tenantClaim);
        }
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(300),
                Map.of("alg", "none"), claims);
        SecurityContextHolder.getContext().setAuthentication(new KeycloakRealmRoleConverter().convert(jwt));

        HttpServletRequest request = mock(HttpServletRequest.class);
        when(request.getHeader(TenantFilter.TENANT_OVERRIDE_HEADER)).thenReturn(header);
        AtomicReference<UUID> seen = new AtomicReference<>();
        filter.doFilter(request, mock(HttpServletResponse.class), (req, res) -> seen.set(TenantContext.get()));
        SecurityContextHolder.clearContext();
        return seen.get();
    }

    private void authenticateWithClaim(String name, String value) {
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(300),
                Map.of("alg", "none"), Map.of(name, value));
        SecurityContextHolder.getContext().setAuthentication(
                new TestingAuthenticationToken(jwt, null));
    }
}
