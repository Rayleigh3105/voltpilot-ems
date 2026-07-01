package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Instant;
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

    private void authenticateWithClaim(String name, String value) {
        Jwt jwt = new Jwt("token", Instant.now(), Instant.now().plusSeconds(300),
                Map.of("alg", "none"), Map.of(name, value));
        SecurityContextHolder.getContext().setAuthentication(
                new TestingAuthenticationToken(jwt, null));
    }
}
