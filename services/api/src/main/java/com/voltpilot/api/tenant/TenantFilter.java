package com.voltpilot.api.tenant;

import com.voltpilot.api.config.KeycloakRealmRoleConverter;
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
 *
 * <p><b>Admin tenant switcher.</b> A Portal-Admin token (realm role
 * {@code platform-admin}, no {@code tenant_id} claim) may select a tenant via
 * the {@code X-Tenant-Id} header: the portal's tenant switcher sends it and the
 * admin then reads the customer endpoints exactly like that customer would -
 * through the RLS-scoped app datasource, never BYPASSRLS. For every other
 * principal the header is ignored outright; a customer's tenant always comes
 * from the validated JWT claim, so the override cannot widen customer access.
 *
 * <p><b>Partner-Konto (UEMS AP-03 IP-3).</b> A token with realm role {@code partner} never gets a
 * tenant here: neither from a {@code tenant_id} claim (a partner account has none; one present is
 * a misconfiguration and ignored) nor from {@code X-Tenant-Id}. Its customer context comes only
 * from a valid Unterstützung, which AP-03 IP-4 resolves.
 */
public class TenantFilter extends OncePerRequestFilter {

    static final String CLAIM = "tenant_id";
    /** Header carrying the admin-selected tenant (platform-admin tokens only). */
    public static final String TENANT_OVERRIDE_HEADER = "X-Tenant-Id";
    private static final String PLATFORM_ADMIN_AUTHORITY =
            "ROLE_" + KeycloakRealmRoleConverter.PLATFORM_ADMIN_ROLE;
    private static final String PARTNER_AUTHORITY = "ROLE_" + KeycloakRealmRoleConverter.PARTNER_ROLE;
    private static final Logger log = LoggerFactory.getLogger(TenantFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain filterChain) throws ServletException, IOException {
        try {
            resolveTenant(request).ifPresent(TenantContext::set);
            filterChain.doFilter(request, response);
        } finally {
            TenantContext.clear();
        }
    }

    private java.util.Optional<UUID> resolveTenant(HttpServletRequest request) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return java.util.Optional.empty();
        }
        if (isPlatformAdmin(auth)) {
            return adminOverride(request);
        }
        if (hasAuthority(auth, PARTNER_AUTHORITY)) {
            if (jwt.getClaimAsString(CLAIM) != null) {
                log.warn("Partner token carries a '{}' claim; ignored - a partner account has no tenant", CLAIM);
            }
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

    private static boolean isPlatformAdmin(Authentication auth) {
        return hasAuthority(auth, PLATFORM_ADMIN_AUTHORITY);
    }

    private static boolean hasAuthority(Authentication auth, String authority) {
        return auth.getAuthorities().stream()
                .anyMatch(a -> authority.equals(a.getAuthority()));
    }

    /**
     * The admin-selected tenant, or empty (admin browsing "Alle Mandanten"). An
     * empty context keeps RLS default-deny, so customer endpoints simply return
     * nothing until a tenant is picked.
     */
    private java.util.Optional<UUID> adminOverride(HttpServletRequest request) {
        String raw = request.getHeader(TENANT_OVERRIDE_HEADER);
        if (raw == null || raw.isBlank()) {
            return java.util.Optional.empty();
        }
        try {
            return java.util.Optional.of(UUID.fromString(raw.trim()));
        } catch (IllegalArgumentException ex) {
            log.warn("Ignoring malformed {} header: {}", TENANT_OVERRIDE_HEADER, raw);
            return java.util.Optional.empty();
        }
    }
}
