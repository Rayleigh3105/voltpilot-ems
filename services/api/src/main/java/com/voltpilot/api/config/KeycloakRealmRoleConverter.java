package com.voltpilot.api.config;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

/**
 * Maps a Keycloak access token's realm roles onto Spring Security authorities so
 * method security ({@code @PreAuthorize("hasRole('platform-admin')")}) works.
 *
 * <p>Keycloak places realm roles under the {@code realm_access.roles} claim.
 * Each role {@code r} becomes an authority {@code ROLE_r}, which is the prefix
 * {@code hasRole(...)} expects. This is intentionally the ONLY thing that turns
 * a token into an authority - tenant scoping stays in {@code TenantFilter}/RLS,
 * role-based platform authorization lives here. The two are orthogonal:
 * customers ({@code operator}, tenant-scoped) never gain {@code platform-admin};
 * the platform admin carries no {@code tenant_id} and sees no customer rows via
 * RLS, only the explicit cross-tenant admin API.
 */
public final class KeycloakRealmRoleConverter
        implements Converter<Jwt, AbstractAuthenticationToken> {

    @Override
    @SuppressWarnings("unchecked")
    public AbstractAuthenticationToken convert(Jwt jwt) {
        Collection<GrantedAuthority> authorities = new ArrayList<>();
        Object realmAccess = jwt.getClaim("realm_access");
        if (realmAccess instanceof Map<?, ?> map && map.get("roles") instanceof List<?> roles) {
            for (Object role : roles) {
                if (role != null) {
                    authorities.add(new SimpleGrantedAuthority("ROLE_" + role));
                }
            }
        }
        return new JwtAuthenticationToken(jwt, authorities);
    }
}
