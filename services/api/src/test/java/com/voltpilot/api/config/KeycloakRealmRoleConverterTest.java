package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Unit test (no Docker/Spring) for the realm-role -> authority mapping that lets
 * {@code @PreAuthorize("hasRole('platform-admin')")} gate the admin API.
 */
class KeycloakRealmRoleConverterTest {

    private final KeycloakRealmRoleConverter converter = new KeycloakRealmRoleConverter();

    private static Jwt jwtWith(Map<String, Object> claims) {
        return new Jwt("token", Instant.now(), Instant.now().plusSeconds(300),
                Map.of("alg", "none"), claims);
    }

    @Test
    void mapsRealmRolesToPrefixedAuthorities() {
        AbstractAuthenticationToken token = converter.convert(
                jwtWith(Map.of("realm_access", Map.of("roles", List.of("platform-admin", "offline_access")))));

        assertThat(AuthorityUtils.authorityListToSet(token.getAuthorities()))
                .contains("ROLE_platform-admin", "ROLE_offline_access");
    }

    @Test
    void tokenWithoutRealmAccessHasNoRoleAuthorities() {
        AbstractAuthenticationToken token = converter.convert(
                jwtWith(Map.of("tenant_id", "00000000-0000-0000-0000-000000000001")));

        assertThat(token.getAuthorities()).isEmpty();
    }

    @Test
    void operatorDoesNotGainAdminAuthority() {
        AbstractAuthenticationToken token = converter.convert(
                jwtWith(Map.of("realm_access", Map.of("roles", List.of("operator")))));

        assertThat(AuthorityUtils.authorityListToSet(token.getAuthorities()))
                .containsExactly("ROLE_operator")
                .doesNotContain("ROLE_platform-admin");
    }
}
