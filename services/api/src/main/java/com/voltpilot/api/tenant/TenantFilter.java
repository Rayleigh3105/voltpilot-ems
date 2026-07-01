package com.voltpilot.api.tenant;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Extracts the {@code tenant_id} claim from the authenticated JWT and publishes
 * it to {@link TenantContext} for the request. Runs after Spring Security's
 * authentication filters so the {@link Jwt} principal is already resolved.
 *
 * <p>A malformed or missing {@code tenant_id} leaves the context empty, which
 * makes RLS default-deny (no tenant => no rows). The context is always cleared
 * in {@code finally} so pooled threads never leak a tenant.
 */
public class TenantFilter extends OncePerRequestFilter {

    static final String CLAIM = "tenant_id";
    private static final Logger log = LoggerFactory.getLogger(TenantFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain filterChain) throws ServletException, IOException {
        try {
            resolveTenant().ifPresent(TenantContext::set);
            filterChain.doFilter(request, response);
        } finally {
            TenantContext.clear();
        }
    }

    private java.util.Optional<UUID> resolveTenant() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return java.util.Optional.empty();
        }
        String raw = jwt.getClaimAsString(CLAIM);
        if (raw == null || raw.isBlank()) {
            log.warn("Authenticated token is missing a '{}' claim; request will see no tenant data", CLAIM);
            return java.util.Optional.empty();
        }
        try {
            return java.util.Optional.of(UUID.fromString(raw.trim()));
        } catch (IllegalArgumentException ex) {
            log.warn("Token '{}' claim is not a valid UUID: {}", CLAIM, raw);
            return java.util.Optional.empty();
        }
    }
}
